import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, win32, type PlatformPath } from 'node:path'
import { hasImageExtension } from '../shared/image-file'
import { nativePath } from './path-key'
import { TreeWatcher } from './tree-watcher'

export interface WatchConfig {
  extensions: string[]
  ignore: string[]
  maxDepth: number
}

export interface WatchHandlers {
  added(path: string): void
  changed(path: string): void
  removed(path: string): void
  error(err: Error): void
}

export interface ImageWatcherHandle {
  ready: Promise<void>
  close(): Promise<void>
}

/** a file is reported once its size and modification time hold still this long */
const STABLE_MS = 500
const POLL_MS = 100
/** how often a deleted watched folder is checked for coming back */
const RETRY_MS = 1000
/** stat errors other than "not found" (a file still locked by its writer) are retried this many times */
const MAX_STAT_RETRIES = 50
/** after lost events, the tree is searched for images written since shortly before the loss, at most this often */
const RESCAN_QUIET_MS = 300
const RESCAN_MIN_INTERVAL_MS = 3000
const RESCAN_SLACK_MS = 2000
/** Linux stamps files from a clock that lags Date.now() by up to a tick: a file made just after watching started can look older */
const CLOCK_SLACK_MS = 20

function imagePathFilter(root: string, cfg: WatchConfig): (filename: string | null) => string | null {
  const ignore = new Set(cfg.ignore.map((s) => s.toLowerCase()))
  return (filename) => {
    if (!filename) return null
    const segs = filename.split(/[\\/]+/).filter(Boolean)
    if (segs.length === 0 || segs.length - 1 > cfg.maxDepth) return null
    if (segs.some((s) => ignore.has(s.toLowerCase()))) return null
    if (!hasImageExtension(filename, cfg.extensions)) return null
    return join(root, ...segs)
  }
}

/** The full path of an image a recursive watcher reports by its name relative to `root`, or null when it is not watched. */
export function watchedImagePath(root: string, filename: string | null, cfg: WatchConfig): string | null {
  return imagePathFilter(root, cfg)(filename)
}

/**
 * A recursive watcher names files relative to its folder; an absolute name (`\\?\D:\proj` on Windows), or an empty
 * one (Node's recursive watcher on Linux, the folder relative to itself), is the folder itself going away. On Windows
 * its handle then reports that again and again, thousands of times a second, until closed.
 */
export function isRootGoneEvent(filename: string | null): boolean {
  return filename !== null && (filename === '' || filename.startsWith('\\\\?\\') || isAbsolute(filename))
}

/**
 * Claude Code's own temp folder: <CLAUDE_CODE_TMPDIR or %TEMP%>\claude on Windows,
 * <CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid> elsewhere (Claude Code ignores TMPDIR there).
 */
export function claudeTempRoot(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; tmpdir: string; uid: number }): string {
  if (o.platform === 'win32') return win32.join(o.env.CLAUDE_CODE_TMPDIR || o.tmpdir, 'claude')
  return posix.join(o.env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${o.uid}`)
}

/** A session's own folder in it, where its scratchpad lives: <root>/<project key>/<session id> */
export function sessionTempDir(transcriptPath: string, sessionId: string, claudeRoot: string, path: PlatformPath = nativePath): string {
  return path.join(claudeRoot, path.basename(path.dirname(transcriptPath)), sessionId)
}

/** Images under `dir` (within the ignore list and depth) whose file was created or modified at or after `since`. */
async function recentImages(dir: string, cfg: WatchConfig, since: number, stopped: () => boolean): Promise<string[]> {
  const ignore = new Set(cfg.ignore.map((s) => s.toLowerCase()))
  const found: string[] = []
  const walk = async (d: string, depth: number): Promise<void> => {
    if (stopped()) return
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const e of entries) {
      if (ignore.has(e.name.toLowerCase())) continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (depth < cfg.maxDepth) subdirs.push(p)
      } else if (e.isFile() && hasImageExtension(e.name, cfg.extensions)) {
        try {
          const st = await stat(p)
          if (Math.max(st.mtimeMs, st.birthtimeMs) >= since) found.push(p)
        } catch {
          // gone again
        }
      }
    }
    for (let i = 0; i < subdirs.length; i += 8) await Promise.all(subdirs.slice(i, i + 8).map((s) => walk(s, depth + 1)))
  }
  await walk(dir, 0)
  return found
}

interface Pending {
  lastEvent: number
  last: { size: number; mtimeMs: number } | null
  stableSince: number
  retries: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * Watches a folder tree for new, changed and deleted images with one recursive fs.watch: no scan of the tree and one
 * handle however big it is, and subfolders deleted and created again keep working. Linux has no recursive watch of its
 * own: there a TreeWatcher watches each folder.
 * The OS drops events when many arrive at once (a nameless event); the tree is then searched for recent images.
 */
export function watchImages(dir: string, cfg: WatchConfig, h: WatchHandlers): ImageWatcherHandle {
  const toPath = imagePathFilter(dir, cfg)
  const startedAt = Date.now()
  // images reported so far, with the file state reported: a later write is a change, the same state again is nothing
  const reported = new Map<string, { size: number; mtimeMs: number }>()
  const pending = new Map<string, Pending>()
  let watcher: FSWatcher | TreeWatcher | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let lostSince: number | null = null
  let rescanTimer: ReturnType<typeof setTimeout> | null = null
  let rescanning = false
  let lastRescan = 0

  const settle = async (p: string): Promise<void> => {
    const e = pending.get(p)
    if (!e || closed) return
    let st
    try {
      st = await stat(p)
    } catch (err) {
      if (closed) return
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && e.retries++ < MAX_STAT_RETRIES) {
        e.timer = setTimeout(() => void settle(p), POLL_MS)
        return
      }
      pending.delete(p)
      reported.delete(p)
      h.removed(p)
      return
    }
    if (closed) return
    if (!st.isFile()) {
      pending.delete(p)
      return
    }
    const now = Date.now()
    if (!e.last || e.last.size !== st.size || e.last.mtimeMs !== st.mtimeMs) {
      e.last = { size: st.size, mtimeMs: st.mtimeMs }
      e.stableSince = now
    }
    if (now - e.stableSince < STABLE_MS || now - e.lastEvent < STABLE_MS) {
      e.timer = setTimeout(() => void settle(p), POLL_MS)
      return
    }
    pending.delete(p)
    const before = reported.get(p)
    if (before && before.size === e.last.size && before.mtimeMs === e.last.mtimeMs) return
    reported.set(p, e.last)
    // a file that was there before watching started is changed, not new (birthtime is 0 where unsupported)
    if (before || (st.birthtimeMs > 0 && st.birthtimeMs < startedAt - CLOCK_SLACK_MS)) h.changed(p)
    else h.added(p)
  }

  const track = (p: string): void => {
    const now = Date.now()
    const e = pending.get(p)
    if (e) {
      e.lastEvent = now
      return
    }
    pending.set(p, { lastEvent: now, last: null, stableSince: now, retries: 0, timer: setTimeout(() => void settle(p), POLL_MS) })
  }

  const rescan = async (): Promise<void> => {
    rescanTimer = null
    if (closed || lostSince === null) return
    if (rescanning || Date.now() - lastRescan < RESCAN_MIN_INTERVAL_MS) {
      rescanTimer = setTimeout(() => void rescan(), RESCAN_MIN_INTERVAL_MS)
      return
    }
    const since = lostSince - RESCAN_SLACK_MS
    lostSince = null
    rescanning = true
    try {
      for (const p of await recentImages(dir, cfg, since, () => closed)) if (!closed) track(p)
    } finally {
      rescanning = false
      lastRescan = Date.now()
    }
  }

  const onEvent = (_event: string, filename: string | Buffer | null): void => {
    const name = filename === null ? null : String(filename)
    if (name === null) {
      // events were dropped
      lostSince ??= Date.now()
      if (rescanTimer) clearTimeout(rescanTimer)
      rescanTimer = setTimeout(() => void rescan(), RESCAN_QUIET_MS)
      return
    }
    if (isRootGoneEvent(name)) {
      letGo()
      return
    }
    const p = toPath(name)
    if (p) track(p)
  }

  const scheduleRetry = (): void => {
    if (closed || retry) return
    retry = setTimeout(() => {
      retry = null
      if (closed) return
      if (existsSync(dir)) open()
      else scheduleRetry()
    }, RETRY_MS)
  }

  /** the watched folder is gone: close the handle at once (it spins, and it keeps the folder from being created again) */
  const letGo = (): void => {
    if (!watcher) return
    watcher.close()
    watcher = null
    scheduleRetry()
  }

  function open(): void {
    try {
      watcher = process.platform === 'win32' ? watch(dir, { recursive: true }, onEvent) : new TreeWatcher(dir, onEvent, cfg)
    } catch (err) {
      if (!existsSync(dir)) scheduleRetry()
      else h.error(err instanceof Error ? err : new Error(String(err)))
      return
    }
    watcher.on('error', (err) => {
      if (!existsSync(dir)) letGo()
      else h.error(err instanceof Error ? err : new Error(String(err)))
    })
  }

  open()
  return {
    ready: Promise.resolve(),
    close: async () => {
      closed = true
      watcher?.close()
      watcher = null
      if (retry) clearTimeout(retry)
      if (rescanTimer) clearTimeout(rescanTimer)
      for (const e of pending.values()) clearTimeout(e.timer)
      pending.clear()
    }
  }
}
