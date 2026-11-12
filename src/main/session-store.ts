import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTabView } from '../shared/chat'
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
      claudeSessionId: isUuid(x.claudeSessionId) ? x.claudeSessionId : null,
      // written before accounts existed, or by hand: the main account
      account: x.kind === 'claude' && typeof x.account === 'string' && x.account.length > 0 && x.account.length <= 64 ? x.account : null,
      // written before tabs could be muted: with sound
      muted: x.muted === true,
      // written before ClaudeTerm kept track of it: idle
      working: x.kind === 'claude' && x.working === true,
      // written before ClaudeTerm kept track of it: nothing in the background
      background: x.kind === 'claude' && x.background === true,
      // written before forks existed: an ordinary tab
      fork: x.kind === 'claude' ? parseFork(x.fork) : null,
      // written before views existed, or by hand: null, and a shell tab has none
      view: x.kind === 'claude' && isTabView(x.view) ? x.view : null
    })
  }
  // a fork's head is another Claude tab of the list, before or after it (tabs on top are dragged freely), and is not
  // itself a fork with a head; a bad head leaves the fork without one
  const heads = tabs.map((t) => t.fork?.of ?? null)
  tabs.forEach((t, i) => {
    const of = heads[i]
    if (t.fork && of !== null && !(of < tabs.length && of !== i && tabs[of].kind === 'claude' && heads[of] === null)) t.fork = { of: null, from: t.fork.from }
  })
  return { version: 1, savedAt: r.savedAt, tabs }
}

function parseFork(value: unknown): SessionSnapshotTab['fork'] {
  if (typeof value !== 'object' || value === null) return null
  const f = value as Record<string, unknown>
  // null: the fork has a conversation of its own and is not forked again
  if (f.from !== null && !isUuid(f.from)) return null
  return { of: typeof f.of === 'number' && Number.isInteger(f.of) && f.of >= 0 ? f.of : null, from: f.from }
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
    // a Claude tab with a session, or a fork still waiting for its session, is one Restore can bring back
    if (current && (opts.afterUpdate || current.tabs.some((t) => t.kind === 'claude' && (t.claudeSessionId !== null || t.fork !== null)))) {
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
