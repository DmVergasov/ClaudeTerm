import type { ReloadAction } from '../../shared/mcp'
import type { McpLiveServer } from '../chat/chat-engine'
import { diffConfig, type ConfigChange, type ConfigChangeKind, type TabConfig } from './mcp-config'

/** an automatic restart waits this long after the last change, so several changes close together make one restart */
export const SETTLE_MS = 1500
/** an automatic restart that waits for the tab to be idle tries again this often */
export const RECHECK_MS = 1000
/** the report of what came up asks the session this often */
export const REPORT_POLL_MS = 500
/** the report of what came up is made at the latest this long after the restart */
export const REPORT_LIMIT_MS = 20_000

export type ReloadMode = 'auto-now' | 'auto-later' | 'manual' | 'restarting'
export interface ReloadCardView { title: string; text: string; action: ReloadAction | null }
export interface ReportDivider { text: string; good: string | null }
export interface ReportNotice { text: string; tone: 'info' | 'error' }

const TITLES: Record<ConfigChangeKind, string> = {
  'server-added': 'New MCP server',
  'server-removed': 'MCP server removed',
  'server-changed': 'MCP server changed',
  'server-approved': 'MCP server approved',
  'plugin-installed': 'New plugin',
  'plugin-removed': 'Plugin removed',
  'plugin-updated': 'Plugin updated',
  'plugin-enabled': 'Plugin turned on',
  'plugin-disabled': 'Plugin turned off'
}

/** a removal or a turn-off: the session drops what it loaded, so the card says drop */
function drops(change: ConfigChange): boolean {
  return change.kind === 'server-removed' || change.kind === 'plugin-removed' || change.kind === 'plugin-disabled'
}

/** the card of a comparison: its title names the changes, its text says when the session restarts, its action is what the button does */
export function reloadView(changes: ConfigChange[], mode: ReloadMode): ReloadCardView {
  const verb = changes.every(drops) ? 'drop' : 'load'
  const pronoun = changes.length === 1 ? 'it' : 'them'
  const title =
    changes.length === 1
      ? `${TITLES[changes[0].kind]}: ${changes[0].name}`
      : `${changes.length} changes: ${changes
          .slice(0, 3)
          .map((c) => c.name)
          .join(', ')}${changes.length > 3 ? ` +${changes.length - 3}` : ''}`
  const text =
    mode === 'auto-later'
      ? `The session restarts to ${verb} ${pronoun} when Claude finishes — the conversation goes on`
      : mode === 'manual'
        ? `Restart the session to ${verb} ${pronoun} — the conversation goes on`
        : `The session restarts now to ${verb} ${pronoun} — the conversation goes on`
  const action: ReloadAction | null = mode === 'manual' ? 'restart' : mode === 'restarting' ? null : 'not-now'
  return { title, text, action }
}

/**
 * the report of what came up after a restart: null while a reported server is still connecting and the report is not final
 * (`final`: the limit has passed, so the servers still connecting are said so)
 */
export function reportOf(changes: ConfigChange[], servers: McpLiveServer[], final: boolean): { divider: ReportDivider; notices: ReportNotice[] } | null {
  const parts: string[] = []
  const notices: ReportNotice[] = []
  let good: string | null = null
  for (const change of changes) {
    const name = change.name
    if (change.kind === 'plugin-installed' || change.kind === 'plugin-enabled' || change.kind === 'plugin-updated') {
      parts.push(`${name} plugin on`)
      continue
    }
    if (change.kind !== 'server-added' && change.kind !== 'server-changed' && change.kind !== 'server-approved') continue
    const server = servers.find((s) => s.name === name)
    if (server === undefined) {
      notices.push({ text: `${name} did not load`, tone: 'error' })
      continue
    }
    if (server.status === 'connected') {
      const connected = `${name} connected`
      parts.push(connected, `${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`)
      if (good === null) good = connected
    } else if (server.status === 'failed') {
      notices.push({ text: server.error ? `${name} failed to start: ${server.error}` : `${name} failed to start`, tone: 'error' })
    } else if (server.status === 'needs-auth') {
      notices.push({ text: `${name} needs sign-in`, tone: 'info' })
    } else if (server.status === 'pending') {
      if (!final) return null
      notices.push({ text: `${name} is still connecting`, tone: 'info' })
    }
  }
  return { divider: { text: ['Session restarted', ...parts].join(' · '), good }, notices }
}

export interface CoordinatorDeps {
  read(tabId: string): Promise<TabConfig | null>
  idle(tabId: string): boolean
  touchedAt(tabId: string): number | null
  restart(tabId: string): void
  card(tabId: string, card: ReloadCardView | null): void
  status(tabId: string): Promise<McpLiveServer[] | null>
  report(tabId: string, divider: ReportDivider, notices: ReportNotice[]): void
  changed(tabId: string): void
  now(): number
}

interface TabState {
  /** the latest read started; an answer to an older one is dropped */
  seq: number
  /** what the session loaded; null until the start read answers */
  loaded: TabConfig | null
  /** the loaded config is not complete (a file was unreadable or the read failed): the first complete read replaces it, with no change */
  provisional: boolean
  loadedAt: number
  /** the changes the card is for */
  pending: ConfigChange[]
  /** the changes the next report covers */
  owed: ConfigChange[]
  card: ReloadCardView | null
  mode: ReloadMode | null
  /** a change made by Claude or in this tab restarts it without asking, until Not now or the next start */
  auto: boolean
  /** this tab made a change: the next complete comparison of it counts as the maker's, whichever comparison that is */
  makerDue: boolean
  notNow: boolean
  restarting: boolean
  /** the comparisons in flight: nothing restarts while one is */
  comparing: number
  /** the settle or recheck timer of an automatic restart */
  timer: ReturnType<typeof setTimeout> | null
  reportGen: number
  reportTimer: ReturnType<typeof setTimeout> | null
}

function freshState(owed: ConfigChange[], loadedAt: number): TabState {
  return {
    seq: 0,
    loaded: null,
    provisional: true,
    loadedAt,
    pending: [],
    owed,
    card: null,
    mode: null,
    auto: false,
    makerDue: false,
    notNow: false,
    restarting: false,
    comparing: 0,
    timer: null,
    reportGen: 0,
    reportTimer: null
  }
}

function sameChange(a: ConfigChange, b: ConfigChange): boolean {
  return a.kind === b.kind && a.name === b.name
}

function union(a: ConfigChange[], b: ConfigChange[]): ConfigChange[] {
  const out = [...a]
  for (const change of b) if (!out.some((o) => sameChange(o, change))) out.push(change)
  return out
}

function sameChanges(a: ConfigChange[], b: ConfigChange[]): boolean {
  return a.length === b.length && a.every((change, i) => sameChange(change, b[i]))
}

function sameView(a: ReloadCardView | null, b: ReloadCardView | null): boolean {
  if (a === null || b === null) return a === b
  return a.title === b.title && a.text === b.text && a.action === b.action
}

/**
 * what each chat tab's Claude Code loaded against what its files give now: the reload card, the restart after the answer (never cutting
 * anything off), and the report of what came up after it. Every outside call is a dep; a comparison that cannot read keeps what it had.
 */
export class RestartCoordinator {
  private readonly d: CoordinatorDeps
  private readonly states = new Map<string, TabState>()
  /** the holds of a tab (a queued message, a compaction): an automatic restart waits until none is left */
  private readonly holds = new Map<string, number>()

  constructor(d: CoordinatorDeps) {
    this.d = d
  }

  /** a chat starts: what it loads is read now; the changes pending before it are what its report covers */
  started(tab: string): void {
    const old = this.states.get(tab)
    const s = freshState(union(old?.owed ?? [], old?.pending ?? []), this.d.now())
    s.card = old?.card ?? null
    if (old !== undefined) this.dispose(old)
    this.states.set(tab, s)
    this.setCard(tab, s, null)
    void this.load(tab, s)
  }

  /** the report of what came up starts */
  ready(tab: string): void {
    const s = this.states.get(tab)
    if (s === undefined || s.owed.length === 0) return
    const gen = ++s.reportGen
    void this.reportWhenUp(tab, s, gen, s.owed, this.d.now())
  }

  /** a watched file changed: every tracked tab is compared */
  async compareAll(): Promise<void> {
    await Promise.all(this.tracked().map((tab) => this.compare(tab)))
  }

  /** the turn of the tab ended: compare it, then a restart that waited for the turn may run */
  turnEnded(tab: string): void {
    void this.compare(tab).then(() => this.attempt(tab))
  }

  /** a panel action of this tab changed the configuration: every tab is compared, this one as the maker */
  madeHere(tab: string): void {
    const mine = this.states.get(tab)
    if (mine !== undefined) mine.makerDue = true
    for (const other of this.tracked()) void this.compare(other)
  }

  /** Not now: the card stays, with Restart, until the next start */
  notNow(tab: string): boolean {
    const s = this.states.get(tab)
    if (s === undefined || s.mode === null || s.mode === 'restarting') return false
    s.notNow = true
    this.clearTimer(s)
    this.setMode(tab, s, 'manual')
    return true
  }

  /** Restart: restarts at once when the tab is idle and not held, else as soon as it is */
  restartNow(tab: string): boolean {
    const s = this.states.get(tab)
    if (s === undefined || s.mode === null) return false
    if (s.mode === 'restarting') return true
    s.notNow = false
    s.auto = true
    this.attempt(tab)
    return true
  }

  /**
   * the restart of this tab's state did not start the chat (the tab was busy, the restart was refused or failed): the card says
   * Restart again, with the changes it was for. A state that `started` has replaced is left alone.
   */
  restartSettled(tab: string): void {
    const s = this.states.get(tab)
    if (s === undefined || !s.restarting) return
    s.restarting = false
    s.auto = false
    if (s.pending.length === 0) {
      s.mode = null
      this.setCard(tab, s, null)
      return
    }
    this.setMode(tab, s, 'manual')
  }

  hold(tab: string): void {
    this.holds.set(tab, (this.holds.get(tab) ?? 0) + 1)
  }

  release(tab: string): void {
    const held = this.holds.get(tab) ?? 0
    if (held === 0) return
    if (held > 1) {
      this.holds.set(tab, held - 1)
      return
    }
    this.holds.delete(tab)
    this.attempt(tab)
  }

  tracked(): string[] {
    return [...this.states.keys()]
  }

  removeTab(tab: string): void {
    const s = this.states.get(tab)
    if (s !== undefined) this.dispose(s)
    this.states.delete(tab)
    this.holds.delete(tab)
  }

  private async load(tab: string, s: TabState): Promise<void> {
    const seq = ++s.seq
    const config = await this.safeRead(tab)
    if (this.states.get(tab) !== s || seq !== s.seq) return
    s.loaded = config
    s.provisional = config === null || config.unreadable.length > 0
  }

  private async compare(tab: string): Promise<void> {
    const first = this.states.get(tab)
    if (first === undefined) return
    const seq = ++first.seq
    first.comparing++
    const config = await this.safeRead(tab)
    first.comparing--
    const s = this.states.get(tab)
    if (s === undefined || s !== first || seq !== s.seq || s.restarting) return
    // an incomplete read changes nothing: the card, the pending changes, the mode and the timers stay as they are
    if (config === null || config.unreadable.length > 0) return
    // the first complete comparison after the change takes the maker's flag, even when a newer comparison superseded its read
    const maker = s.makerDue
    s.makerDue = false

    let changes: ConfigChange[] = []
    if (s.loaded === null || s.provisional) {
      s.loaded = config
      s.provisional = false
    } else {
      changes = diffConfig(s.loaded, config)
    }
    if (changes.length === 0) {
      s.pending = []
      this.clearTimer(s)
      s.mode = null
      this.setCard(tab, s, null)
      return
    }

    const previous = s.pending
    s.pending = changes
    const touched = this.d.touchedAt(tab)
    const auto = !s.notNow && (maker || s.auto || (touched !== null && touched >= s.loadedAt))
    if (!auto) {
      this.clearTimer(s)
      this.setMode(tab, s, 'manual')
      return
    }
    s.auto = true
    this.setMode(tab, s, this.d.idle(tab) ? 'auto-now' : 'auto-later')
    if (s.timer === null || !sameChanges(previous, changes)) this.schedule(tab, s, SETTLE_MS)
  }

  /** an automatic restart that is due runs now when the tab is idle and not held; otherwise the card says auto-later */
  private attempt(tab: string): void {
    const s = this.states.get(tab)
    if (s === undefined || s.restarting || !s.auto || s.notNow || s.pending.length === 0) return
    // a comparison in flight may answer incomplete or reject and re-arm nothing: the due restart checks again soon
    if (s.comparing > 0) {
      this.schedule(tab, s, RECHECK_MS)
      return
    }
    if ((this.holds.get(tab) ?? 0) > 0) {
      this.clearTimer(s)
      this.setMode(tab, s, 'auto-later')
      return
    }
    if (!this.d.idle(tab)) {
      this.setMode(tab, s, 'auto-later')
      this.schedule(tab, s, RECHECK_MS)
      return
    }
    this.restartTab(tab, s)
  }

  private restartTab(tab: string, s: TabState): void {
    this.clearTimer(s)
    s.restarting = true
    this.setMode(tab, s, 'restarting')
    // the pending changes stay until the chat starts or the restart is settled: the card of a restart that did not start says them
    s.owed = union(s.owed, s.pending)
    this.d.restart(tab)
  }

  /** the report polls the session until every server it reports has an answer, or the limit has passed */
  private async reportWhenUp(tab: string, s: TabState, gen: number, changes: ConfigChange[], startedAt: number): Promise<void> {
    let servers: McpLiveServer[] = []
    for (;;) {
      const seen = await this.statusWithin(tab, REPORT_LIMIT_MS - (this.d.now() - startedAt))
      if (!this.reportLive(tab, s, gen)) return
      const final = this.d.now() - startedAt >= REPORT_LIMIT_MS
      // a null answer before the limit says nothing about the servers: only an answered list makes the report
      if (seen !== null) servers = seen
      if (seen !== null || final) {
        const made = reportOf(changes, servers, final)
        if (made !== null) {
          s.owed = s.owed.filter((c) => !changes.some((r) => sameChange(r, c)))
          this.d.report(tab, made.divider, made.notices)
          this.d.changed(tab)
          return
        }
      }
      await this.pause(s, REPORT_POLL_MS)
      if (!this.reportLive(tab, s, gen)) return
    }
  }

  private reportLive(tab: string, s: TabState, gen: number): boolean {
    return this.states.get(tab) === s && s.reportGen === gen
  }

  private pause(s: TabState, ms: number): Promise<void> {
    return new Promise((resolve) => {
      s.reportTimer = setTimeout(() => {
        s.reportTimer = null
        resolve()
      }, ms)
    })
  }

  /** the session's status, or null when it does not answer within `ms` */
  private statusWithin(tab: string, ms: number): Promise<McpLiveServer[] | null> {
    return new Promise((resolve) => {
      const limit = setTimeout(() => resolve(null), Math.max(0, ms))
      void this.safeStatus(tab).then((servers) => {
        clearTimeout(limit)
        resolve(servers)
      })
    })
  }

  private schedule(tab: string, s: TabState, ms: number): void {
    this.clearTimer(s)
    s.timer = setTimeout(() => {
      s.timer = null
      this.attempt(tab)
    }, ms)
  }

  private clearTimer(s: TabState): void {
    if (s.timer !== null) {
      clearTimeout(s.timer)
      s.timer = null
    }
  }

  private dispose(s: TabState): void {
    this.clearTimer(s)
    if (s.reportTimer !== null) {
      clearTimeout(s.reportTimer)
      s.reportTimer = null
    }
    s.reportGen++
  }

  private setMode(tab: string, s: TabState, mode: ReloadMode): void {
    s.mode = mode
    this.setCard(tab, s, reloadView(s.pending, mode))
  }

  private setCard(tab: string, s: TabState, view: ReloadCardView | null): void {
    if (sameView(s.card, view)) return
    s.card = view
    this.d.card(tab, view)
    this.d.changed(tab)
  }

  private async safeRead(tab: string): Promise<TabConfig | null> {
    try {
      return await this.d.read(tab)
    } catch {
      return null
    }
  }

  private async safeStatus(tab: string): Promise<McpLiveServer[] | null> {
    try {
      return await this.d.status(tab)
    } catch {
      return null
    }
  }
}
