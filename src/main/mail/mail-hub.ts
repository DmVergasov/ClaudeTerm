import { randomUUID } from 'node:crypto'
import {
  MAIL_TEXT_MAX,
  type MailAddress,
  type MailConversationView,
  type MailEndView,
  type MailMessageView,
  type MailRecord,
  type MailUnread
} from '../../shared/mail'
import type { PipeResponse } from '../../shared/protocol'
import { formatAgentList, resolveAgent, type Agent } from './agent-directory'
import { checkMailRecord } from './mail-record'
import type { MailStore } from './mail-store'
import { wakeTextWithin } from './wake-text'

/** the longest wake text a watcher gets: Claude Code cuts a hook's output at 10,000 characters */
const WAKE_MAX = 9500
const STORE_ERROR = 'ClaudeTerm could not store this message.'

/** the Claude tab that sends or lists: a Claude tab on this device with a known session */
export interface CallerTab {
  tabId: string
  device: string | null
  session: string
  name: string
}

export interface MailHubDeps {
  store: MailStore
  enabled(): boolean
  caller(tabId: string): CallerTab | null
  agents(): Agent[] // every listable agent, this device's included
  notAccepting(): string[] // names of connected devices without mail or with it off
  deviceOnline(device: string | null): boolean // null: this device, always true
  deviceAccepts(device: string | null): boolean
  localTab(session: string): string | null // the tab on this device running that session
  tabOpen(tabId: string): boolean // true for a local tab that exists and has not exited
  working?(tabId: string): boolean | undefined // false when the tab is not working now: an Esc-interrupted turn has no Stop
  sender(a: MailAddress): { folder: string | null; branch: string | null }
  self(): string | null // the id of this device
  deviceName(device: string | null): string | null // null when unknown
  onUnread?(): void // marks or panel may need a redraw
  now?(): number
  newId?(): string
}

/** a watcher the tab holds open: a `mail_wait` that is answered when mail for its session comes */
interface Watcher {
  tabId: string
  session: string
  /** the turn count of the tab when the watcher arrived: the turn it arrived in is seq */
  seq: number
  resolve(response: PipeResponse): void
  dispose(): void
}

/** the turns of one Claude tab, as the mail and the prompts of the user start and end them */
interface TabTurns {
  /** a turn is in progress */
  busy: boolean
  /** increases each time a turn starts */
  seq: number
  /** turns that were started by mail and have not ended yet */
  mailTurns: number
  /** a watcher that arrived during a turn took mail: its turn starts when this one ends */
  deferred: number
}

const OFF = 'Agent messages are turned off in ClaudeTerm on this device.'

const fail = (error: string): PipeResponse => ({ ok: false, error })

/** the device name from an address' name when no device name is known: the part after the last " · ", without " #n" */
function deviceFromName(name: string): string {
  const at = name.lastIndexOf(' · ')
  const tail = at >= 0 ? name.slice(at + 3) : name
  return tail.replace(/ #\d+$/, '')
}

/**
 * The agent messages on this device: sending (message_agent), listing (list_agents), handing mail to the
 * watchers that hold a request open, and the marks and conversations of the panel. Event-driven: no timers.
 */
export class MailHub {
  private readonly now: () => number
  private readonly newId: () => string
  /** a resumed conversation's old session id, mapped to the one it has now */
  private readonly aliases = new Map<string, string>()
  /** the newest watcher of each tab: an older one for the same tab was answered superseded */
  private readonly watchers = new Map<string, Watcher>()
  /** the turns of each tab, see TabTurns */
  private readonly turns = new Map<string, TabTurns>()

  /** the store listener, stopped by close() */
  private readonly unsubscribe: () => void

  constructor(private readonly deps: MailHubDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    this.unsubscribe = deps.store.onChange(() => {
      this.recheck()
      deps.onUnread?.()
    })
  }

  list(tabId: string): PipeResponse {
    const caller = this.deps.caller(tabId)
    if (!caller) return fail('Only a Claude tab with a session can list agents.')
    if (!this.deps.enabled()) return fail(OFF)
    return { ok: true, info: formatAgentList(this.othersThan(caller), this.deps.notAccepting()) }
  }

  send(tabId: string, to: string, text: string, replyTo: string | null): PipeResponse {
    const caller = this.deps.caller(tabId)
    if (!caller) return fail('Only a Claude tab with a session can send agent messages.')
    if (!this.deps.enabled()) return fail(OFF)
    if (text.trim() === '') return fail('A message needs a text.')
    if (text.length > MAIL_TEXT_MAX) return fail(`A message is at most ${MAIL_TEXT_MAX} characters.`)
    if (replyTo !== null && !this.deps.store.get(replyTo)) return fail(`No message with id "${replyTo}".`)

    const resolved = resolveAgent(to, this.othersThan(caller), this.recentWith(caller))
    if (!resolved.ok) return fail(resolved.error)
    const target = resolved.to
    const name = target.name

    if (this.isThisDevice(target.device)) {
      if (this.deps.localTab(this.current(target.session)) === null) return fail(`${name} is closed.`)
      if (!this.write(caller, target, text, replyTo)) return fail(STORE_ERROR)
      return { ok: true, info: `Delivered to ${name}.` }
    }

    const device = this.deviceLabel(target)
    if (!this.deps.deviceOnline(target.device)) {
      if (!this.write(caller, target, text, replyTo)) return fail(STORE_ERROR)
      return { ok: true, info: `Waiting: ${device} is not connected; the message goes out when it connects.` }
    }
    if (!this.deps.deviceAccepts(target.device)) return fail(`${device} does not accept agent messages.`)
    if (!resolved.agent) return fail(`${name} is closed.`)
    if (!this.write(caller, target, text, replyTo)) return fail(STORE_ERROR)
    return { ok: true, info: `Delivered to ${name}.` }
  }

  /**
   * A watcher of a tab asks for the mail for its session. Answers at once with the mail when some is waiting, else
   * holds the request until the store changes or tabsChanged() is called. `closed` aborts it: the watcher is gone.
   */
  wait(tabId: string, sessionId: string, closed: AbortSignal): Promise<PipeResponse> {
    if (closed.aborted) return Promise.resolve({ ok: true })
    const older = this.watchers.get(tabId)
    if (older) this.finish(older, { ok: true })
    if (!this.deps.enabled()) return Promise.resolve({ ok: true })
    return new Promise<PipeResponse>(resolve => {
      const onAbort = (): void => this.finish(watcher, { ok: true })
      const watcher: Watcher = {
        tabId,
        session: sessionId,
        seq: this.turnsOf(tabId).seq,
        resolve: response => resolve(response),
        dispose: () => closed.removeEventListener('abort', onAbort)
      }
      closed.addEventListener('abort', onAbort, { once: true })
      this.watchers.set(tabId, watcher)
      this.offer(watcher)
    })
  }

  /** hands waiting mail to the watchers that can take it now */
  tabsChanged(): void {
    // a tab that is gone takes its turn state with it: an id that comes back starts fresh
    for (const tabId of [...this.turns.keys()]) {
      if (!this.deps.tabOpen(tabId)) this.turns.delete(tabId)
    }
    this.recheck()
  }

  /** a resumed conversation got a new session id: the old address leads to the new one */
  alias(oldSession: string, newSession: string): void {
    if (oldSession !== newSession) this.aliases.set(oldSession, newSession)
  }

  /** called on every done of a tab: true when the turn that ends was started by mail; a deferred mail turn starts then */
  takeMailTurn(tabId: string): boolean {
    const t = this.turnsOf(tabId)
    const had = t.mailTurns > 0
    if (had) t.mailTurns--
    t.busy = false
    if (t.deferred > 0) {
      t.mailTurns += t.deferred
      t.deferred = 0
      t.busy = true
      t.seq++
    }
    return had
  }

  /** a prompt the user typed starts a turn that is the user's, not a mail turn */
  userTurn(tabId: string): void {
    const t = this.turnsOf(tabId)
    t.mailTurns = 0
    t.deferred = 0
    t.busy = true
    t.seq++
  }

  unreadByTab(tabs: { tabId: string; device: string | null; session: string | null }[]): MailUnread {
    // one pass over the unread messages: each counts once for each of its two ends, then each tab looks its end up
    const perEnd = new Map<string, number>()
    for (const r of this.deps.store.all()) {
      if (r.read) continue
      const from = this.endKey(r.from)
      const to = this.endKey(r.to)
      perEnd.set(from, (perEnd.get(from) ?? 0) + 1)
      if (to !== from) perEnd.set(to, (perEnd.get(to) ?? 0) + 1)
    }
    const counts: MailUnread = {}
    for (const tab of tabs) {
      if (tab.session === null) continue
      const n = perEnd.get(this.endKey({ device: tab.device, session: tab.session })) ?? 0
      if (n > 0) counts[tab.tabId] = n
    }
    return counts
  }

  conversations(of: { device: string | null; session: string } | null): MailConversationView[] {
    const ofKey = of ? this.endKey(of) : null
    const groups = new Map<
      string,
      { keys: [string, string]; a: MailEndView; b: MailEndView; lastAt: number; messages: MailMessageView[] }
    >()
    // all() is oldest first, so the messages of each group come oldest first and its names are the newest ones
    for (const r of this.deps.store.all()) {
      const ends = [r.from, r.to]
        .map(end => ({ key: this.endKey(end), view: this.endView(end) }))
        .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
      const key = `${ends[0].key}|${ends[1].key}`
      let group = groups.get(key)
      if (!group) {
        group = { keys: [ends[0].key, ends[1].key], a: ends[0].view, b: ends[1].view, lastAt: r.sentAt, messages: [] }
        groups.set(key, group)
      }
      group.a = ends[0].view
      group.b = ends[1].view
      group.lastAt = Math.max(group.lastAt, r.sentAt)
      group.messages.push({
        id: r.id,
        from: this.endView(r.from),
        sentAt: r.sentAt,
        text: r.text,
        delivered: r.delivered,
        read: r.read
      })
    }
    const out: MailConversationView[] = []
    for (const [key, g] of groups) {
      if (ofKey !== null && !g.keys.includes(ofKey)) continue
      // keys are sorted, as the ends are: the first one is a
      const mine = ofKey === null ? null : g.keys[0] === ofKey ? 'a' : 'b'
      out.push({ key, mine, a: g.a, b: g.b, lastAt: g.lastAt, messages: g.messages })
    }
    return out.sort((x, y) => y.lastAt - x.lastAt)
  }

  /** the store notifies the listeners of a change, so the panel is redrawn through onUnread */
  markRead(ids: string[]): void {
    this.deps.store.mark(ids, 'read')
  }

  /** stops the store listener and answers every held wait { ok: true } */
  close(): void {
    this.unsubscribe()
    for (const w of [...this.watchers.values()]) this.finish(w, { ok: true })
  }

  /** hands the undelivered mail for this watcher's session to it, when its tab runs that session and the watcher still holds */
  private offer(w: Watcher): void {
    if (this.watchers.get(w.tabId) !== w) return
    // messages turned off: the held watcher is released, and no mail goes to it
    if (!this.deps.enabled()) {
      this.finish(w, { ok: true })
      return
    }
    const session = this.current(w.session)
    if (this.deps.localTab(session) !== w.tabId) return
    const mail = this.deps.store
      .all()
      .filter(r => !r.delivered && this.isThisDevice(r.to.device) && this.current(r.to.session) === session)
    if (mail.length === 0) return
    // the oldest messages that fit one wake text; the rest wait for the next watcher
    const { taken, info } = wakeTextWithin(mail, a => this.deps.sender(a), WAKE_MAX)
    this.handOver(w)
    // finish() first: marking the mail notifies the watchers, and this one must already be off the hold
    this.finish(w, { ok: true, info })
    this.deps.store.mark(taken.map(r => r.id), 'delivered')
  }

  /**
   * Counts the mail turn a hand-over starts. Idle: the mail wakes a new turn. Busy, and the watcher arrived in this
   * turn: the watcher is the Stop race, so its wake starts the next turn, at the end of this one. Otherwise the mail
   * goes into the running turn, which is not a mail turn.
   */
  private handOver(w: Watcher): void {
    const t = this.turnsOf(w.tabId)
    // a turn Esc interrupted never gets its Stop: the tab's working flag says it is idle again
    const idle = !t.busy || this.deps.working?.(w.tabId) === false
    if (idle) {
      t.mailTurns++
      t.busy = true
      t.seq++
    } else if (w.seq === t.seq) {
      t.deferred++
    }
  }

  private turnsOf(tabId: string): TabTurns {
    let t = this.turns.get(tabId)
    if (!t) {
      t = { busy: false, seq: 0, mailTurns: 0, deferred: 0 }
      this.turns.set(tabId, t)
    }
    return t
  }

  private recheck(): void {
    for (const w of [...this.watchers.values()]) {
      // a tab that closed or exited releases its watcher; a session not running yet keeps it, as the watcher can come first
      if (!this.deps.tabOpen(w.tabId)) this.finish(w, { ok: true })
      else this.offer(w)
    }
  }

  private finish(w: Watcher, response: PipeResponse): void {
    if (this.watchers.get(w.tabId) === w) this.watchers.delete(w.tabId)
    w.dispose()
    w.resolve(response)
  }

  /** stores a new message; false when the record fails the check a peer or the file would apply, and nothing is written */
  private write(caller: CallerTab, to: MailAddress, text: string, replyTo: string | null): boolean {
    const r: MailRecord = {
      v: 1,
      id: this.newId(),
      from: { device: caller.device, session: caller.session, name: caller.name },
      to,
      replyTo,
      text,
      sentAt: this.now(),
      delivered: false,
      read: false
    }
    const checked = checkMailRecord(r)
    if (checked === null) return false
    this.deps.store.add(checked)
    return true
  }

  /** the listable agents without the caller's own tab */
  private othersThan(caller: CallerTab): Agent[] {
    return this.deps.agents().filter(a => !this.sameEnd(a, caller))
  }

  /** the other ends of the caller's messages, newest first, each address once */
  private recentWith(caller: CallerTab): MailAddress[] {
    const out: MailAddress[] = []
    const seen = new Set<string>()
    const newest = [...this.deps.store.all()].reverse()
    for (const r of newest) {
      if (!this.sameEnd(r.from, caller) && !this.sameEnd(r.to, caller)) continue
      for (const end of [r.from, r.to]) {
        if (this.sameEnd(end, caller)) continue
        const key = this.endKey(end)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(end)
      }
    }
    return out
  }

  private isThisDevice(device: string | null): boolean {
    return device === null || device === this.deps.self()
  }

  /** the device of an address as the conversations keep it: this device is null */
  private norm(device: string | null): string | null {
    return this.isThisDevice(device) ? null : device
  }

  /** the address of an end: its device (this device is '') and its session through the aliases */
  private endKey(end: { device: string | null; session: string }): string {
    return `${this.norm(end.device) ?? ''}/${this.current(end.session)}`
  }

  private sameEnd(a: { device: string | null; session: string }, b: { device: string | null; session: string }): boolean {
    return this.endKey(a) === this.endKey(b)
  }

  private endView(addr: MailAddress): MailEndView {
    return { name: addr.name, device: this.norm(addr.device), deviceName: this.deviceLabel(addr) }
  }

  private deviceLabel(addr: MailAddress): string {
    return this.deps.deviceName(this.norm(addr.device)) ?? deviceFromName(addr.name)
  }

  /** the session at the end of the alias chain from this one */
  private current(session: string): string {
    let s = session
    const seen = new Set<string>()
    while (this.aliases.has(s) && !seen.has(s)) {
      seen.add(s)
      s = this.aliases.get(s) ?? s
    }
    return s
  }
}
