import { randomUUID } from 'node:crypto'
import type { TabView } from '../shared/chat'
import type { OpenTabRequest, SessionSnapshotTab, TabActivity, TabFork, TabInfo } from '../shared/types'
import { applyEnvPatch, type EnvPatch } from './child-env'
import type { ClaudeLaunch, LaunchSpec } from './profiles'
import type { PtyHandle, SpawnPty } from './pty-host'

export interface ResolvedLaunch {
  profileName: string
  spec: LaunchSpec
  /** the account the tab runs on, once one that cannot be used fell back to the main account (null) */
  account?: string | null
  /** changes to the tab's environment, for an extra account */
  env?: EnvPatch
  /** a Claude tab's launch inputs, for its chat process */
  claude?: ClaudeLaunch
}

/** a running chat process of a Claude tab */
export interface ChatHandle {
  /** asks the process to end; it reports its exit through the request's `exit` */
  stop(): void
  kill(): void
}

/** what a chat process starts from: the tab, its Claude launch, and the environment its PTY would get */
export interface ChatStartRequest {
  tab: TabInfo
  claude: ClaudeLaunch
  env: Record<string, string>
  /** the process ended. With no fallback the tab exits as a PTY does; a fallback says why the chat cannot run, and the tab runs its terminal */
  exit(code: number | null, fallback: string | null): void
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
  /** the tab gets a new process (Restart session, another account): what waited on the old one must not reach the new one */
  onTabRestarting?(tabId: string): void
  onTabClosed?(tabId: string): void
  /** the folder the tab works in changed: Claude Code moved, or a restart went back to the tab's cwd */
  onFolderChanged?(tabId: string, folder: string): void
  /** the tab was moved to another folder by the user (changeFolder): its new info, before it starts there; a new conversation */
  onTabFolderChanged?(tab: TabInfo): void
  onStateChanged?(): void
  /** the view a Claude tab opens in when its request names none: the setting */
  defaultView?(): TabView
  /** starts the chat process of a chat-view Claude tab; without it such a tab runs its PTY, as a terminal does */
  startChat?(req: ChatStartRequest): ChatHandle
  /** a chat process could not run: the tab turns to its terminal, and the reason goes here */
  onChatFallback?(tabId: string, reason: string): void
  /** whether a Claude conversation can be resumed, checked on disk; one without a message has no transcript yet */
  resumable?(tabId: string, sessionId: string): Promise<boolean>
  flushMs?: number
  /** how long a restart waits for a PTY to exit before it starts the new one anyway: a killed ConPTY can lose its exit event */
  restartWaitMs?: number
}

/** resolves true when the promise settles within `ms`, false when the time runs out first */
function settlesWithin(done: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void done.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** the title of a fork: the parent's name with ` (fork)` after it, unless the name has that already */
const forkTitle = (title: string | null): string | null => title === null || title.endsWith(' (fork)') ? title : `${title} (fork)`

interface TabRecord {
  info: TabInfo
  launch: ResolvedLaunch
  pty: PtyHandle | null
  /** the chat process of a chat-view tab, until it has exited: also while it is stopped and still alive */
  chat: ChatHandle | null
  buffer: string
  timer: ReturnType<typeof setTimeout> | null
  cols: number
  rows: number
  /** bumped on every start, so output and exit of a replaced process are ignored */
  gen: number
  /** resolves when the current process has exited */
  stopped: Promise<void>
  /** the current process; exited once it has, as its stopped promise settles */
  proc: { exited: boolean }
  restarting: boolean
  /** a restart or a switch of account is waiting for the conversation's check on disk: no other one starts meanwhile */
  preparing: boolean
  /** Claude is in the middle of a turn, as the session snapshot keeps it */
  working: boolean
  /** agents of the tab's Claude run */
  agents: boolean
  /** work Claude left in the background when its last turn ended still runs, as the session snapshot keeps it */
  background: boolean
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
      folder: req.cwd,
      customTitle: req.title ?? null,
      claudeSessionId: req.kind === 'claude' ? req.resumeSessionId ?? null : null,
      account: req.kind === 'claude' ? launch.account ?? null : null,
      muted: req.muted === true,
      fork: req.kind === 'claude' ? this.forkFrom(req.fork) : null,
      exited: false,
      activity: null,
      // a setup-token tab is a shell tab; a Claude tab without a view named opens in the one the setting names
      view: req.kind === 'claude' && !opts.setupToken ? req.view ?? this.deps.defaultView?.() ?? 'terminal' : null
    }
    const rec: TabRecord = { info, launch, pty: null, chat: null, buffer: '', timer: null, cols: 120, rows: 30, gen: 0, stopped: Promise.resolve(), proc: { exited: true }, restarting: false, preparing: false, working: false, agents: false, background: false }
    this.tabs.set(info.id, rec)
    const head = info.fork?.of ?? null
    // a fork stands right after its family
    if (head === null) this.order.push(info.id)
    else this.order.splice(this.familyEnd(head) + 1, 0, info.id)
    this.deps.events.opened({ ...info })
    if (head !== null) this.deps.events.order([...this.order])
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
    rec.chat?.stop()
    rec.pty?.kill()
    for (const other of this.tabs.values()) {
      if (other.info.fork?.of !== tabId) continue
      // the forks of a closed head are ordinary tabs now
      other.info.fork = { of: null, from: other.info.fork.from }
      this.deps.events.updated({ ...other.info })
    }
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

  /** no tab of this device is in front any more (another device's tab is); nothing is announced */
  deactivate(): void {
    this.activeId = null
  }

  size(tabId: string): { cols: number; rows: number } | null {
    const rec = this.tabs.get(tabId)
    return rec ? { cols: rec.cols, rows: rec.rows } : null
  }

  rename(tabId: string, title: string | null): void {
    const rec = this.tabs.get(tabId)
    if (!rec) return
    const t = title?.trim()
    rec.info.customTitle = t ? t : null
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  /** Claude Code works in another folder now: the tab shows it; the conversation still resumes in cwd */
  setFolder(tabId: string, folder: string): void {
    const rec = this.tabs.get(tabId)
    if (rec) this.moveTo(rec, folder)
  }

  private moveTo(rec: TabRecord, folder: string): void {
    if (rec.info.folder === folder) return
    rec.info.folder = folder
    this.deps.events.updated({ ...rec.info })
    this.deps.onFolderChanged?.(rec.info.id, folder)
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

  /** a Claude tab with a saved conversation can be forked; the check of the conversation is awaited, so a menu does not block */
  async canFork(tabId: string): Promise<boolean> {
    const rec = this.tabs.get(tabId)
    return rec !== undefined && rec.info.kind === 'claude' && (await this.resumeId(rec)) !== null
  }

  /** a new Claude tab that continues a copy of the tab's conversation, in its folder and account */
  async fork(tabId: string, opts: { activate?: boolean } = {}): Promise<TabInfo | null> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude') return null
    const from = await this.resumeId(rec)
    // the check waited on the disk: a parent closed meanwhile has nothing to fork
    if (from === null || !this.isLive(rec)) return null
    const info = rec.info
    return this.open({
      kind: 'claude',
      cwd: info.cwd,
      account: info.account,
      title: forkTitle(info.customTitle),
      fork: { of: info.fork?.of ?? info.id, from }
    }, { activate: opts.activate ?? true })
  }

  /**
   * Restore: a restored fork joins its restored head's family. The tabs open in their saved order, the forks without a
   * head (so each stays where it was, which on top may be before its head), and join their heads once all are open.
   */
  joinFamily(tabId: string, headId: string): void {
    const rec = this.tabs.get(tabId)
    const head = this.tabs.get(headId)
    const fork = rec?.info.fork
    if (!rec || !fork || fork.of !== null || !head || head === rec || head.info.kind !== 'claude' || (head.info.fork?.of ?? null) !== null) return
    rec.info.fork = { of: headId, from: fork.from }
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  /**
   * Starts the tab's process again in the same tab. With `live`, a running process is stopped first (e.g. so
   * Claude Code picks up a newly added MCP server); otherwise only an exited tab restarts. A Claude tab resumes
   * its current conversation, on its account.
   */
  async restart(tabId: string, opts: { live?: boolean } = {}): Promise<void> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.restarting || rec.preparing || (!rec.info.exited && !opts.live)) return
    if (rec.info.kind === 'claude') {
      rec.preparing = true
      let launch: ResolvedLaunch | null = null
      try {
        const resumeSessionId = await this.resumeId(rec)
        launch = this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId, account: rec.info.account, fork: rec.info.fork })
      } catch {
        // keep the previous launch
      } finally {
        rec.preparing = false
      }
      // the check waited on the disk, a failed one too: the tab may have closed or been restarted meanwhile
      if (this.tabs.get(tabId) !== rec || rec.restarting || (!rec.info.exited && !opts.live)) return
      if (launch) this.setLaunch(rec, launch)
    }
    await this.relaunch(rec)
  }

  /**
   * Moves the tab to another folder and starts it there. A Claude tab starts a new conversation, since the one it had is
   * not in the new folder. False for an unknown tab, or one that is restarting or whose conversation is being checked;
   * a launch that cannot be resolved for the folder leaves the tab as it was.
   */
  async changeFolder(tabId: string, cwd: string): Promise<boolean> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.restarting || rec.preparing) return false
    const info = rec.info
    let launch: ResolvedLaunch
    try {
      launch = info.kind === 'claude'
        ? this.deps.resolveLaunch({ kind: 'claude', cwd, resumeSessionId: null, account: info.account })
        : this.deps.resolveLaunch({ kind: 'shell', cwd, profile: info.profile, account: null })
    } catch {
      return false
    }
    info.cwd = cwd
    if (info.kind === 'claude') {
      info.claudeSessionId = null
      // a fork that moves on starts a conversation of its own there, not a copy of its head's
      if (info.fork) info.fork = { of: info.fork.of, from: null }
    }
    this.setLaunch(rec, launch)
    // the move reports the tab (and the folder to its place); a tab that stays in its folder is reported here
    if (info.folder !== cwd) this.moveTo(rec, cwd)
    else this.deps.events.updated({ ...info })
    this.deps.onTabFolderChanged?.({ ...info })
    this.changed()
    await this.restart(tabId, { live: true })
    return true
  }

  /**
   * Restarts a Claude tab on another account, resuming its conversation. When the launch cannot use that account the
   * tab is left as it is and the answer is false: silently going on under another account would be worse.
   */
  async switchAccount(tabId: string, account: string | null): Promise<boolean> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude' || rec.restarting || rec.preparing) return false
    let launch: ResolvedLaunch
    rec.preparing = true
    try {
      const resumeSessionId = await this.resumeId(rec)
      // the check waited on the disk: the tab may have closed or been restarted meanwhile
      if (this.tabs.get(tabId) !== rec || rec.restarting) return false
      launch = this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId, account, strict: true, fork: rec.info.fork })
    } catch {
      return false
    } finally {
      rec.preparing = false
    }
    this.setLaunch(rec, launch)
    await this.relaunch(rec)
    return true
  }

  /**
   * Switches a Claude tab between its chat and its terminal. The old process is ended first, and the new one starts only
   * once it has exited, so two processes never run on one conversation. False for a shell or an unknown tab (a remote tab
   * is none of this manager's), a tab restarting or preparing, the view it has already, and one that works (a turn or agents
   * run); also when the old process is still alive after the wait: the tab then shows as exited, in the new view, and a
   * restart waits for the old process. True when the other view started.
   */
  async setView(tabId: string, view: TabView): Promise<boolean> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude' || rec.restarting || rec.preparing || rec.info.view === view || this.activityOf(rec) === 'working') return false
    rec.info.view = view
    this.deps.events.updated({ ...rec.info })
    this.changed()
    rec.restarting = true
    this.deps.onTabRestarting?.(tabId)
    const gone = await this.endProcess(rec, 5000, false)
    rec.restarting = false
    if (!gone) {
      // the old process is still alive: the tab shows as exited, and nothing starts beside it
      this.markStuck(rec)
      return false
    }
    // the conversation resumes as a restart resumes it; a launch that cannot be resolved keeps the previous one
    rec.preparing = true
    let launch: ResolvedLaunch | null = null
    try {
      const resumeSessionId = await this.resumeId(rec)
      launch = this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId, account: rec.info.account, fork: rec.info.fork })
    } catch {
      // keep the previous launch
    } finally {
      rec.preparing = false
    }
    // the check waited on the disk: the tab may have closed meanwhile
    if (!this.isLive(rec) || this.disposed) return false
    if (launch) this.setLaunch(rec, launch)
    if (rec.info.exited) {
      rec.info.exited = false
      this.deps.events.updated({ ...rec.info })
    }
    this.start(rec)
    return rec.info.view === view
  }

  /**
   * A Claude tab that is not working takes another conversation, and restarts live on it, as a restart resumes one. Its
   * fork is no copy any more, as after /clear. False for a shell or an unknown tab, a tab restarting or preparing, one that
   * works (a turn or agents run), and when the new process does not start.
   */
  async resumeSession(tabId: string, sessionId: string): Promise<boolean> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude' || rec.restarting || rec.preparing || this.activityOf(rec) === 'working') return false
    const info = rec.info
    const fork = info.fork ? { of: info.fork.of, from: null } : null
    let launch: ResolvedLaunch
    try {
      launch = this.deps.resolveLaunch({ kind: 'claude', cwd: info.cwd, resumeSessionId: sessionId, account: info.account, fork })
    } catch {
      return false
    }
    info.claudeSessionId = sessionId
    info.fork = fork
    this.setLaunch(rec, launch)
    this.deps.events.updated({ ...info })
    this.changed()
    await this.relaunch(rec)
    return this.isLive(rec) && !info.exited
  }

  write(tabId: string, data: string): void {
    const rec = this.tabs.get(tabId)
    // a tab whose process is stopped or stuck gets no input
    if (rec && !rec.info.exited) rec.pty?.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    const rec = this.tabs.get(tabId)
    if (!rec || cols < 1 || rows < 1) return
    // the PTY already has this size: a ConPTY resize can make Claude Code redraw its screen
    if (cols === rec.cols && rows === rec.rows) return
    rec.cols = cols
    rec.rows = rows
    rec.pty?.resize(cols, rows)
  }

  /** a turn started (a prompt) or ended (its end, or the user stopping it) in a Claude tab */
  setWorking(tabId: string, working: boolean): void {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude' || rec.working === working) return
    rec.working = working
    this.refreshActivity(rec)
    this.changed()
  }

  /** whether agents of the tab's Claude run: past the end of the turn too, Claude Code waits for them, and the work goes on */
  setAgentsRunning(tabId: string, running: boolean): void {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude' || rec.agents === running) return
    rec.agents = running
    this.refreshActivity(rec)
  }

  /** whether work Claude left in the background still runs, as the last end of a turn in a Claude tab said */
  setBackgroundWork(tabId: string, running: boolean): void {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude' || rec.background === running) return
    rec.background = running
    this.changed()
  }

  /**
   * `source`: Claude Code's SessionStart source. Only "fork" is the copy a fork starts with; any other session (resumed,
   * cleared, another one picked) is a conversation of the tab's own, so the fork is never forked again from its head's.
   */
  setClaudeSession(tabId: string, sessionId: string, source?: string): boolean {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude') return false
    const fork = rec.info.fork
    const settled = fork !== null && fork.from !== null && source !== 'fork'
    if (settled) rec.info.fork = { of: fork.of, from: null }
    if (rec.info.claudeSessionId !== sessionId || settled) {
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

  /** whether a Claude tab is working now: a turn began and its end, an Esc or a Ctrl+C has not yet cleared it */
  isWorking(tabId: string): boolean {
    return this.tabs.get(tabId)?.working ?? false
  }

  snapshot(): SessionSnapshotTab[] {
    return this.order.map((id) => {
      const { info: i, working, background } = this.tabs.get(id)!
      const head = i.fork?.of ?? null
      const headAt = head === null ? -1 : this.order.indexOf(head)
      const fork = i.fork ? { of: headAt < 0 ? null : headAt, from: i.fork.from } : null
      return { kind: i.kind, profile: i.profile, cwd: i.cwd, title: i.customTitle, claudeSessionId: i.claudeSessionId, account: i.account, muted: i.muted, working, background, fork, view: i.view }
    })
  }

  disposeAll(): void {
    this.disposed = true
    for (const rec of this.tabs.values()) {
      if (rec.timer) clearTimeout(rec.timer)
      rec.pty?.kill()
      rec.chat?.kill()
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

  /** a fork's head, while that tab is open: a fork of a tab that is gone is an ordinary tab */
  private forkFrom(fork: TabFork | null | undefined): TabFork | null {
    if (!fork) return null
    return { of: fork.of !== null && this.tabs.has(fork.of) ? fork.of : null, from: fork.from }
  }

  /** the position of a family's last tab: the head, or one of its forks */
  private familyEnd(head: string): number {
    let end = this.order.indexOf(head)
    this.order.forEach((id, i) => {
      if (this.tabs.get(id)?.info.fork?.of === head) end = i
    })
    return end
  }

  /** the conversation a restart continues: the CURRENT one (it may have changed since open, /clear), once it was saved */
  private async resumeId(rec: TabRecord): Promise<string | null> {
    const id = rec.info.claudeSessionId
    if (id === null) return null
    return (this.deps.resumable ? await this.deps.resumable(rec.info.id, id) : true) ? id : null
  }

  private setLaunch(rec: TabRecord, launch: ResolvedLaunch): void {
    rec.launch = launch
    const account = launch.account ?? null
    if (rec.info.account === account) return
    rec.info.account = account
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  /** an exited tab starts again; a running one is ended first, and the new process starts only once the old one has exited */
  private async relaunch(rec: TabRecord): Promise<void> {
    this.deps.onTabRestarting?.(rec.info.id)
    if (!rec.proc.exited) {
      rec.restarting = true
      const gone = await this.endProcess(rec, this.deps.restartWaitMs ?? 3000, true)
      rec.restarting = false
      if (!this.isLive(rec) || this.disposed) return
      // a chat process still alive: nothing starts beside it
      if (!gone) {
        this.markStuck(rec)
        return
      }
    }
    if (rec.info.exited) {
      rec.info.exited = false
      this.deps.events.updated({ ...rec.info })
    }
    this.start(rec)
  }

  /**
   * Ends the tab's current process before another one starts in its place. A chat process is stopped and given 5 s to
   * exit, then killed and given 2 s more; a PTY is killed and given `ptyWaitMs`; with `ptyGiveUp` it then counts as ended, otherwise it gets 2 s more. True when it has exited (or is given up). False: it is still
   * alive, and the record keeps its handle, so a later restart waits for it and disposeAll kills it.
   */
  private async endProcess(rec: TabRecord, ptyWaitMs: number, ptyGiveUp: boolean): Promise<boolean> {
    if (rec.proc.exited) {
      rec.chat = null
      rec.pty = null
      return true
    }
    const stopped = rec.stopped
    const chat = rec.chat
    // the output and the exit of the process being ended are ignored from here on
    rec.gen++
    if (rec.timer) clearTimeout(rec.timer)
    rec.timer = null
    rec.buffer = ''
    this.deps.events.reset(rec.info.id)
    if (chat) chat.stop()
    else rec.pty?.kill()
    let gone: boolean
    if (chat) {
      gone = await settlesWithin(stopped, 5000)
      if (!gone) {
        chat.kill()
        gone = await settlesWithin(stopped, 2000)
      }
    } else if (ptyGiveUp) {
      // a restart does not wait longer for a PTY: a killed ConPTY can lose its exit event, and the kill is forceful
      await settlesWithin(stopped, ptyWaitMs)
      gone = true
    } else {
      gone = await settlesWithin(stopped, ptyWaitMs)
      if (!gone) gone = await settlesWithin(stopped, 2000)
    }
    if (gone) {
      rec.chat = null
      rec.pty = null
    }
    return gone
  }

  /**
   * The old process is still alive after endProcess: the tab shows as exited (idle, with its view), nothing starts beside
   * the old process, and a restart waits for it.
   */
  private markStuck(rec: TabRecord): void {
    if (!this.isLive(rec) || rec.info.exited) return
    rec.info.exited = true
    rec.info.activity = this.activityOf(rec)
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  private start(rec: TabRecord): void {
    // a new process is in no turn yet, and runs none of the last one's agents
    if (rec.working) {
      rec.working = false
      this.changed()
    }
    rec.agents = false
    this.refreshActivity(rec)
    // a new process works in the folder the tab was opened in, wherever the last one had moved to
    this.moveTo(rec, rec.info.cwd)
    const env = applyEnvPatch({ ...this.deps.baseEnv(), CLAUDETERM_TAB_ID: rec.info.id, CLAUDETERM_PIPE: this.deps.pipeName }, rec.launch.env)
    const gen = ++rec.gen
    // a process is reported as ended once: a second report from its handle does nothing
    const proc = { exited: false }
    rec.proc = proc
    let markStopped = (): void => {}
    rec.stopped = new Promise<void>((r) => { markStopped = r })
    const stop = (): void => {
      proc.exited = true
      markStopped()
    }
    if (rec.info.view === 'chat' && rec.launch.claude && this.deps.startChat) {
      let self: ChatHandle | null = null
      let ended = false
      const exit = (code: number | null, fallback: string | null): void => {
        if (ended) return
        ended = true
        stop()
        if (self !== null && rec.chat === self) rec.chat = null
        // a process replaced or closed meanwhile says nothing to the tab
        if (rec.gen !== gen || !this.isLive(rec)) return
        if (fallback === null) this.exited(rec, code ?? -1)
        else this.fallBack(rec, fallback)
      }
      try {
        const chat = this.deps.startChat({ tab: { ...rec.info }, claude: rec.launch.claude, env, exit })
        // it ended while it started: the tab has its exit (or its PTY) already
        if (ended) return
        self = chat
        rec.chat = chat
      } catch (e) {
        stop()
        this.queue(rec, `\r\n[failed to start the chat: ${(e as Error).message}]\r\n`)
        this.exited(rec, -1)
      }
      return
    }
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
          stop()
          if (rec.gen === gen) this.exited(rec, code)
        }
      })
    } catch (e) {
      stop()
      rec.pty = null
      this.queue(rec, `\r\n[failed to start ${rec.launch.spec.file}: ${(e as Error).message}]\r\n`)
      this.exited(rec, -1)
    }
  }

  /** the chat process of a chat-view tab could not run: the tab turns to its terminal, and the PTY starts there */
  private fallBack(rec: TabRecord, reason: string): void {
    rec.info.view = 'terminal'
    this.deps.events.updated({ ...rec.info })
    this.deps.onChatFallback?.(rec.info.id, reason)
    this.changed()
    this.start(rec)
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
    rec.chat = null
    rec.info.exited = true
    // the snapshot keeps the turn the exit cut off; the window shows an exited tab idle
    rec.info.activity = this.activityOf(rec)
    this.deps.events.exit(rec.info.id, code)
    this.deps.events.updated({ ...rec.info })
  }

  private activityOf(rec: TabRecord): TabActivity {
    if (rec.info.kind !== 'claude' || rec.info.exited) return null
    return rec.working || rec.agents ? 'working' : null
  }

  /** the window hears of the tab's activity when it changes */
  private refreshActivity(rec: TabRecord): void {
    const activity = this.activityOf(rec)
    if (activity === rec.info.activity) return
    rec.info.activity = activity
    this.deps.events.updated({ ...rec.info })
  }
}
