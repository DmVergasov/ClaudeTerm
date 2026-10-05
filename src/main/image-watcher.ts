import { watch } from 'chokidar'
import type { Stats } from 'node:fs'
import { basename, dirname, join, parse, relative, resolve } from 'node:path'
import { hasImageExtension } from '../shared/image-file'

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

// path.resolve('D:') returns the current directory of drive D, so a bare drive is completed to its root first
const full = (p: string): string => resolve(/^[A-Za-z]:$/.test(p) ? `${p}\\` : p)
const canon = (p: string): string => full(p).replace(/[\\/]+$/, '').toLowerCase()

export function shouldWatchDir(dir: string, home: string): boolean {
  const d = canon(dir)
  const root = parse(full(dir)).root.replace(/[\\/]+$/, '').toLowerCase()
  return d !== root && d !== canon(home)
}

export function makeIgnored(root: string, cfg: WatchConfig): (path: string, stats?: Stats) => boolean {
  const ignore = new Set(cfg.ignore.map((s) => s.toLowerCase()))
  return (p, stats) => {
    const rel = relative(root, p)
    if (rel === '') return false
    if (rel.split(/[\\/]/).some((seg) => ignore.has(seg.toLowerCase()))) return true
    if (stats?.isFile()) return !hasImageExtension(p, cfg.extensions)
    return false
  }
}

export function sessionTempDir(transcriptPath: string, sessionId: string, tmpRoot: string): string {
  return join(tmpRoot, 'claude', basename(dirname(transcriptPath)), sessionId)
}

export function watchImages(dir: string, cfg: WatchConfig, h: WatchHandlers): ImageWatcherHandle {
  const isImage = (p: string): boolean => hasImageExtension(p, cfg.extensions)
  const w = watch(dir, {
    ignoreInitial: true,
    depth: cfg.maxDepth,
    ignored: makeIgnored(dir, cfg),
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  })
  const ready = new Promise<void>((r) => w.once('ready', () => r()))
  w.on('add', (p) => { if (isImage(p)) h.added(p) })
  w.on('change', (p) => { if (isImage(p)) h.changed(p) })
  w.on('unlink', (p) => { if (isImage(p)) h.removed(p) })
  w.on('error', (e) => h.error(e instanceof Error ? e : new Error(String(e))))
  return { ready, close: () => w.close() }
}
