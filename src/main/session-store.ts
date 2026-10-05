import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUuid } from '../shared/protocol'
import type { SessionSnapshot, SessionSnapshotTab } from '../shared/types'

export function parseSnapshot(text: string): SessionSnapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || typeof r.savedAt !== 'string' || !Array.isArray(r.tabs)) return null
  const tabs: SessionSnapshotTab[] = []
  for (const t of r.tabs as unknown[]) {
    if (typeof t !== 'object' || t === null) return null
    const x = t as Record<string, unknown>
    if ((x.kind !== 'claude' && x.kind !== 'shell') || typeof x.profile !== 'string' || typeof x.cwd !== 'string') return null
    tabs.push({
      kind: x.kind,
      profile: x.profile,
      cwd: x.cwd,
      title: typeof x.title === 'string' ? x.title : null,
      claudeSessionId: isUuid(x.claudeSessionId) ? x.claudeSessionId : null
    })
  }
  return { version: 1, savedAt: r.savedAt, tabs }
}

export interface SessionStoreOptions {
  debounceMs?: number
  now?(): Date
  onError?(message: string): void
}

export class SessionStore {
  readonly statePath: string
  readonly previousPath: string
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: SessionSnapshotTab[] | null = null

  constructor(dir: string, private readonly opts: SessionStoreOptions = {}) {
    this.statePath = join(dir, 'session-state.json')
    this.previousPath = join(dir, 'previous-session.json')
  }

  /**
   * Makes the last run's tabs the previous session. A normal start keeps an older previous session over
   * one without resumable Claude tabs; after an update the last run is the session to reopen, whatever it holds.
   */
  rotateOnStartup(opts: { afterUpdate?: boolean } = {}): SessionSnapshot | null {
    const current = this.read(this.statePath)
    if (opts.afterUpdate && !(current && current.tabs.length > 0)) return null
    if (current && (opts.afterUpdate || current.tabs.some((t) => t.kind === 'claude' && t.claudeSessionId !== null))) {
      try {
        renameSync(this.statePath, this.previousPath)
      } catch (e) {
        this.opts.onError?.(`cannot rotate session state: ${(e as Error).message}`)
      }
    }
    return this.readPrevious()
  }

  readPrevious(): SessionSnapshot | null {
    const s = this.read(this.previousPath)
    return s && s.tabs.length > 0 ? s : null
  }

  clearPrevious(): void {
    rmSync(this.previousPath, { force: true })
  }

  scheduleSave(tabs: SessionSnapshotTab[]): void {
    this.pending = tabs
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 500)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending) return
    const tabs = this.pending
    this.pending = null
    this.saveNow(tabs)
  }

  saveNow(tabs: SessionSnapshotTab[]): void {
    const snap: SessionSnapshot = { version: 1, savedAt: (this.opts.now?.() ?? new Date()).toISOString(), tabs }
    const tmp = `${this.statePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8')
      renameSync(tmp, this.statePath)
    } catch (e) {
      this.opts.onError?.(`cannot save session state: ${(e as Error).message}`)
    }
  }

  private read(path: string): SessionSnapshot | null {
    if (!existsSync(path)) return null
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    const s = parseSnapshot(text)
    if (!s) this.opts.onError?.(`ignoring corrupt ${path}`)
    return s
  }
}
