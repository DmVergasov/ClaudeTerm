import { randomUUID } from 'node:crypto'
import type { OpenTabRequest, SessionSnapshotTab, TabInfo } from '../shared/types'
import type { LaunchSpec } from './profiles'
import type { PtyHandle, SpawnPty } from './pty-host'

export interface ResolvedLaunch {
  profileName: string
  spec: LaunchSpec
}

export interface TabEvents {
  opened(tab: TabInfo): void
  updated(tab: TabInfo): void
  closed(tabId: string): void
  activated(tabId: string): void
  order(ids: string[]): void
  data(tabId: string, data: string): void
  exit(tabId: string, code: number): void
  /** a running tab is being restarted: its terminal should start clean */
  reset(tabId: string): void
}

export interface TabManagerDeps {
  spawn: SpawnPty
  resolveLaunch(req: OpenTabRequest): ResolvedLaunch
  baseEnv(): Record<string, string>
  pipeName: string
  events: TabEvents
  onTabStarted?(tab: TabInfo): void
  onTabClosed?(tabId: string): void
  onStateChanged?(): void
  /** whether a Claude conversation can be resumed; one without a message has no transcript yet */
  resumable?(tabId: string, sessionId: string): boolean
  flushMs?: number
  /** how long a restart waits for the old process to exit before starting the new one */
  restartWaitMs?: number
}

interface TabRecord {
  info: TabInfo
  launch: ResolvedLaunch
  pty: PtyHandle | null
  buffer: string
  timer: ReturnType<typeof setTimeout> | null
  cols: number
  rows: number
  /** bumped on every start, so output and exit of a replaced process are ignored */
  gen: number
  /** resolves when the current process has exited */
  stopped: Promise<void>
  restarting: boolean
}

export class TabManager {
  private readonly tabs = new Map<string, TabRecord>()
  private order: string[] = []
  private activeId: string | null = null
  private disposed = false

  constructor(private readonly deps: TabManagerDeps) {}

  open(req: OpenTabRequest, opts: { activate?: boolean } = {}): TabInfo {
    const launch = this.deps.resolveLaunch(req)
    const info: TabInfo = {
      id: randomUUID(),
      kind: req.kind,
      profile: launch.profileName,
      cwd: req.cwd,
      customTitle: req.title ?? null,
      claudeSessionId: req.kind === 'claude' ? req.resumeSessionId ?? null : null,
      exited: false
    }
    const rec: TabRecord = { info, launch, pty: null, buffer: '', timer: null, cols: 120, rows: 30, gen: 0, stopped: Promise.resolve(), restarting: false }
    this.tabs.set(info.id, rec)
    this.order.push(info.id)
    this.deps.events.opened({ ...info })
    this.deps.onTabStarted?.({ ...info })
    this.start(rec)
    if (opts.activate ?? true) this.activate(info.id)
    this.changed()
    return { ...info }
  }

  close(tabId: string): void {
    const rec = this.tabs.get(tabId)
    if (!rec) return
    const idx = this.order.indexOf(tabId)
    this.tabs.delete(tabId)
    this.order.splice(idx, 1)
    if (rec.timer) clearTimeout(rec.timer)
    rec.pty?.kill()
    this.deps.events.closed(tabId)
    this.deps.onTabClosed?.(tabId)
    if (this.activeId === tabId) {
      this.activeId = null
      const next = this.order[Math.min(idx, this.order.length - 1)]
      if (next) this.activate(next)
    }
    this.changed()
  }

  activate(tabId: string): void {
    if (!this.tabs.has(tabId)) return
    this.activeId = tabId
    this.deps.events.activated(tabId)
  }

  activeTabId(): string | null {
    return this.activeId
  }

  rename(tabId: string, title: string | null): void {
    const rec = this.tabs.get(tabId)
    if (!rec) return
    const t = title?.trim()
    rec.info.customTitle = t ? t : null
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  reorder(ids: string[]): void {
    const valid = ids.length === this.order.length && new Set(ids).size === ids.length && ids.every((id) => this.tabs.has(id))
    if (!valid) return
    this.order = [...ids]
    this.deps.events.order([...ids])
    this.changed()
  }

  /**
   * Starts the tab's process again in the same tab. With `live`, a running process is stopped first (e.g. so
   * Claude Code picks up a newly added MCP server); otherwise only an exited tab restarts. A Claude tab resumes
   * its current conversation.
   */
  async restart(tabId: string, opts: { live?: boolean } = {}): Promise<void> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.restarting || (!rec.info.exited && !opts.live)) return
    if (rec.info.kind === 'claude') {
      // the conversation may have changed since open (/clear), so resume the CURRENT one
      const id = rec.info.claudeSessionId
      const resumeSessionId = id !== null && (this.deps.resumable?.(rec.info.id, id) ?? true) ? id : null
      try {
        rec.launch = this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId })
      } catch {
        // keep the previous launch
      }
    }
    if (rec.info.exited) {
      rec.info.exited = false
      this.deps.events.updated({ ...rec.info })
      this.start(rec)
      return
    }
    rec.restarting = true
    rec.gen++
    if (rec.timer) clearTimeout(rec.timer)
    rec.timer = null
    rec.buffer = ''
    const stopped = rec.stopped
    rec.pty?.kill()
    rec.pty = null
    this.deps.events.reset(rec.info.id)
    // let the old process go first, so two Claude Code processes never share one conversation
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([stopped, new Promise<void>((r) => { timer = setTimeout(r, this.deps.restartWaitMs ?? 3000) })])
    clearTimeout(timer)
    rec.restarting = false
    if (this.isLive(rec) && !this.disposed) this.start(rec)
  }

  write(tabId: string, data: string): void {
    this.tabs.get(tabId)?.pty?.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    const rec = this.tabs.get(tabId)
    if (!rec || cols < 1 || rows < 1) return
    rec.cols = cols
    rec.rows = rows
    rec.pty?.resize(cols, rows)
  }

  setClaudeSession(tabId: string, sessionId: string): boolean {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude') return false
    if (rec.info.claudeSessionId !== sessionId) {
      rec.info.claudeSessionId = sessionId
      this.deps.events.updated({ ...rec.info })
      this.changed()
    }
    return true
  }

  list(): TabInfo[] {
    return this.order.map((id) => ({ ...this.tabs.get(id)!.info }))
  }

  get(tabId: string): TabInfo | null {
    const rec = this.tabs.get(tabId)
    return rec ? { ...rec.info } : null
  }

  snapshot(): SessionSnapshotTab[] {
    return this.order.map((id) => {
      const i = this.tabs.get(id)!.info
      return { kind: i.kind, profile: i.profile, cwd: i.cwd, title: i.customTitle, claudeSessionId: i.claudeSessionId }
    })
  }

  disposeAll(): void {
    this.disposed = true
    for (const rec of this.tabs.values()) {
      if (rec.timer) clearTimeout(rec.timer)
      rec.pty?.kill()
    }
    this.tabs.clear()
    this.order = []
    this.activeId = null
  }

  private changed(): void {
    if (!this.disposed) this.deps.onStateChanged?.()
  }

  private start(rec: TabRecord): void {
    const env = { ...this.deps.baseEnv(), CLAUDETERM_TAB_ID: rec.info.id, CLAUDETERM_PIPE: this.deps.pipeName }
    const gen = ++rec.gen
    let markStopped = (): void => {}
    rec.stopped = new Promise<void>((r) => { markStopped = r })
    try {
      rec.pty = this.deps.spawn({
        file: rec.launch.spec.file,
        args: rec.launch.spec.args,
        cwd: rec.info.cwd,
        env,
        cols: rec.cols,
        rows: rec.rows,
        onData: (d) => { if (rec.gen === gen) this.queue(rec, d) },
        onExit: (code) => {
          markStopped()
          if (rec.gen === gen) this.exited(rec, code)
        }
      })
    } catch (e) {
      markStopped()
      rec.pty = null
      this.queue(rec, `\r\n[failed to start ${rec.launch.spec.file}: ${(e as Error).message}]\r\n`)
      this.exited(rec, -1)
    }
  }

  private isLive(rec: TabRecord): boolean {
    return this.tabs.get(rec.info.id) === rec
  }

  private queue(rec: TabRecord, data: string): void {
    if (!this.isLive(rec)) return
    rec.buffer += data
    if (!rec.timer) rec.timer = setTimeout(() => this.flush(rec), this.deps.flushMs ?? 5)
  }

  private flush(rec: TabRecord): void {
    if (rec.timer) {
      clearTimeout(rec.timer)
      rec.timer = null
    }
    if (!rec.buffer || !this.isLive(rec)) return
    const d = rec.buffer
    rec.buffer = ''
    this.deps.events.data(rec.info.id, d)
  }

  private exited(rec: TabRecord, code: number): void {
    if (!this.isLive(rec)) return
    this.flush(rec)
    rec.pty = null
    rec.info.exited = true
    this.deps.events.exit(rec.info.id, code)
    this.deps.events.updated({ ...rec.info })
  }
}
