import { randomUUID } from 'node:crypto'
import type { OpenTabRequest, SessionSnapshotTab, TabInfo } from '../shared/types'
import { applyEnvPatch, type EnvPatch } from './child-env'
import type { LaunchSpec } from './profiles'
import type { PtyHandle, SpawnPty } from './pty-host'

export interface ResolvedLaunch {
  profileName: string
  spec: LaunchSpec
  /** the account the tab runs on, once one that cannot be used fell back to the main account (null) */
  account?: string | null
  /** changes to the tab's environment, for an extra account */
  env?: EnvPatch
}

/** what a launch is resolved from: the request with its account settled */
export interface LaunchRequest extends OpenTabRequest {
  account: string | null
  /** an account that cannot be used throws instead of falling back to the main account */
  strict?: boolean
  /** the Get a token tab: a shell tab running `claude setup-token` */
  setupToken?: boolean
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
  resolveLaunch(req: LaunchRequest): ResolvedLaunch
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

  open(req: OpenTabRequest, opts: { activate?: boolean; setupToken?: boolean } = {}): TabInfo {
    const launch = this.deps.resolveLaunch({ ...req, account: this.accountFor(req), ...(opts.setupToken ? { setupToken: true } : {}) })
    const info: TabInfo = {
      id: randomUUID(),
      kind: req.kind,
      profile: launch.profileName,
      cwd: req.cwd,
      customTitle: req.title ?? null,
      claudeSessionId: req.kind === 'claude' ? req.resumeSessionId ?? null : null,
      account: req.kind === 'claude' ? launch.account ?? null : null,
      muted: req.muted === true,
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

  /** a muted tab makes no notification sound */
  setMuted(tabId: string, muted: boolean): void {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.muted === muted) return
    rec.info.muted = muted
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
   * its current conversation, on its account.
   */
  async restart(tabId: string, opts: { live?: boolean } = {}): Promise<void> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.restarting || (!rec.info.exited && !opts.live)) return
    if (rec.info.kind === 'claude') {
      try {
        this.setLaunch(rec, this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId: this.resumeId(rec), account: rec.info.account }))
      } catch {
        // keep the previous launch
      }
    }
    await this.relaunch(rec)
  }

  /**
   * Restarts a Claude tab on another account, resuming its conversation. When the launch cannot use that account the
   * tab is left as it is and the answer is false: silently going on under another account would be worse.
   */
  async switchAccount(tabId: string, account: string | null): Promise<boolean> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude' || rec.restarting) return false
    let launch: ResolvedLaunch
    try {
      launch = this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId: this.resumeId(rec), account, strict: true })
    } catch {
      return false
    }
    this.setLaunch(rec, launch)
    await this.relaunch(rec)
    return true
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
      return { kind: i.kind, profile: i.profile, cwd: i.cwd, title: i.customTitle, claudeSessionId: i.claudeSessionId, account: i.account, muted: i.muted }
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

  /** a new Claude tab's account: the one asked for, else the active Claude tab's */
  private accountFor(req: OpenTabRequest): string | null {
    if (req.kind !== 'claude') return null
    if (req.account !== undefined) return req.account
    const active = this.activeId ? this.tabs.get(this.activeId)?.info : undefined
    return active?.kind === 'claude' ? active.account : null
  }

  /** the conversation a restart continues: the CURRENT one (it may have changed since open, /clear), once it was saved */
  private resumeId(rec: TabRecord): string | null {
    const id = rec.info.claudeSessionId
    return id !== null && (this.deps.resumable?.(rec.info.id, id) ?? true) ? id : null
  }

  private setLaunch(rec: TabRecord, launch: ResolvedLaunch): void {
    rec.launch = launch
    const account = launch.account ?? null
    if (rec.info.account === account) return
    rec.info.account = account
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  /** an exited tab starts again; a running one is stopped first, and the new process waits for the old one */
  private async relaunch(rec: TabRecord): Promise<void> {
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

  private start(rec: TabRecord): void {
    const env = applyEnvPatch({ ...this.deps.baseEnv(), CLAUDETERM_TAB_ID: rec.info.id, CLAUDETERM_PIPE: this.deps.pipeName }, rec.launch.env)
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
