import { connectTimeoutToast, remoteLink, type RemoteState } from '../../shared/remote-control'
import type { TabView } from '../../shared/chat'
import { remoteUnavailable, type RemoteAccountKind } from './account-rules'
import type { BridgeHost, BridgeTarget } from './bridge-host'

/** how long a typed /remote-control may take to bring the id up, and how long an off line may take to leave it */
export const CONNECT_WAIT_MS = 30_000

/** a local Claude tab as the hub needs it */
export interface RemoteTab {
  view: TabView
  account: string | null
  exited: boolean
}

export interface RemoteControlDeps {
  /** a local Claude tab as main knows it; null for a shell tab, another device's tab, or an unknown id */
  tab(tabId: string): RemoteTab | null
  accountKind(account: string | null): RemoteAccountKind
  /** the environments the tab's Claude Code starts with, as Remote Control reads them: its launch environment, and its account folder's settings.json env */
  envs(tabId: string): Record<string, string>[]
  choice(tabId: string): boolean
  setChoice(tabId: string, on: boolean): void
  /** the last id the tab's Claude Code reported (StatusHub.remoteId) */
  reportedId(tabId: string): string | null
  forgetReported(tabId: string): void
  onChange(tabId: string): void
  /** types the line into the tab's prompt once it is empty (typeIntoPrompt); `cancelled` stops the wait and any write */
  type(tabId: string, line: string, onWait: (waiting: boolean) => void, cancelled: () => boolean): Promise<boolean>
  /** the name a Remote Control session shows for the tab */
  name(tabId: string): string
  /** the tab's title, for the notes the person reads */
  title(tabId: string): string
  toast(text: string): void
  /** runs `run` after `ms`; the returned function cancels the run */
  later(ms: number, run: () => void): () => void
  /** the bridge host: a chat tab's Remote Control is attached and detached through it, and its state is the tab's while it has one */
  host: Pick<BridgeHost, 'attach' | 'detach' | 'state'>
  /** the bridge target of a chat tab's session; null when the tab has none */
  target(tabId: string, sessionId: string): BridgeTarget | null
}

/** the one switch a tab is doing: a typed line the hub waits on, or the id it waits for */
interface Ask {
  dir: 'on' | 'off'
  /** the typed line waits for Claude Code's empty prompt */
  waits: boolean
  cancel: (() => void) | null
  /** an off that met an on line already typed: the id it waits for is gone once it comes, the leave line goes then */
  pendingId?: boolean
}

/** a chat tab's Remote Control: whether its chat runs, whether its Claude Code answered (ready), its session, and whether the host is attached to it */
interface ChatLink {
  live: boolean
  ready: boolean
  sessionId: string | null
  attached: boolean
}

/** Computes what each Claude tab shows of Remote Control, from the id its Claude Code reports and the tab's account */
export class RemoteControlHub {
  /** the tab's open switch: at most one per tab */
  private readonly asks = new Map<string, Ask>()
  /** the chat tabs' Remote Control links, by tab */
  private readonly chats = new Map<string, ChatLink>()

  constructor(private readonly deps: RemoteControlDeps) {}

  /** the tab's Remote Control state; null for a tab without the segment */
  state(tabId: string): RemoteState | null {
    const tab = this.deps.tab(tabId)
    if (!tab) return null
    const reason = this.unavailableReason(tabId)
    if (reason !== null) return { kind: 'unavailable', reason }
    if (tab.exited) return { kind: 'off' }
    if (tab.view === 'chat') return this.chatState(tabId)
    const id = this.deps.reportedId(tabId)
    const ask = this.asks.get(tabId)
    if (id !== null) {
      if (ask?.dir === 'off') return { kind: 'on', url: remoteLink(id), leaving: true, ...(ask.waits ? { waits: true as const } : {}) }
      return { kind: 'on', url: remoteLink(id) }
    }
    if (ask?.dir === 'on') return { kind: 'connecting', ...(ask.waits ? { waits: true as const } : {}) }
    return { kind: 'off' }
  }

  /** the person's switch: on types /remote-control with the tab's name, off types /remote-control to leave */
  set(tabId: string, on: boolean): void {
    const tab = this.deps.tab(tabId)
    if (!tab) return
    // a switch that cannot move still tells the window, which shows the state again rather than the click
    if (tab.exited || this.unavailable(tabId)) {
      this.deps.onChange(tabId)
      return
    }
    if (tab.view === 'chat') {
      this.deps.setChoice(tabId, on)
      if (on) this.attachChat(tabId)
      else this.detachChat(tabId)
      this.deps.onChange(tabId)
      return
    }
    const id = this.deps.reportedId(tabId)
    const ask = this.asks.get(tabId)
    if (on) {
      if (id !== null) {
        this.finish(tabId)
        this.deps.setChoice(tabId, true)
      } else if (ask?.dir !== 'on') {
        this.finish(tabId)
        this.deps.setChoice(tabId, true)
        this.typeOn(tabId)
      }
    } else if (id === null) {
      // a line already typed still brings its id up: the off waits for it, and then leaves
      const typed = ask?.dir === 'on' && ask.cancel !== null
      this.finish(tabId)
      this.deps.setChoice(tabId, false)
      if (typed) this.asks.set(tabId, { dir: 'off', waits: false, cancel: null, pendingId: true })
    } else if (ask?.dir !== 'off') {
      this.finish(tabId)
      this.deps.setChoice(tabId, false)
      this.typeOff(tabId)
    }
    this.deps.onChange(tabId)
  }

  /** the tab's Claude Code reported a new Remote Control id (or none): a typed /remote-control sets the choice, its end clears it */
  reported(tabId: string, id: string | null, previous: string | null): void {
    if (this.deps.tab(tabId)?.view === 'terminal') {
      const ask = this.asks.get(tabId)
      if (id !== null) {
        if (ask?.dir === 'on') this.finish(tabId)
        else if (ask?.pendingId) {
          this.finish(tabId)
          this.typeOff(tabId)
        } else if (previous === null) this.deps.setChoice(tabId, true)
      } else if (previous !== null) {
        if (ask?.dir === 'off') this.finish(tabId)
        else if (!ask) this.deps.setChoice(tabId, false)
      }
    }
    this.deps.onChange(tabId)
  }

  /** a new Claude Code process starts in the tab: what the old one reported is no longer true; a tab whose choice is on connects */
  processStarted(tabId: string): void {
    // in every view: a switch the old process left pending, and the id it reported, are no longer true
    this.finish(tabId)
    this.deps.forgetReported(tabId)
    const tab = this.deps.tab(tabId)
    // a chat's process: its Remote Control connects from here, once the chat is ready
    if (tab?.view === 'chat') {
      const link = this.chatOf(tabId)
      link.live = true
      link.ready = false
      // the session of the old process is no longer this chat's: a ready without one attaches nothing
      link.sessionId = null
      this.deps.onChange(tabId)
      return
    }
    // a terminal's process: a chat that was on it leaves the claude.ai session to the terminal's Claude Code
    this.dropChat(tabId)
    if (tab && tab.view === 'terminal' && !tab.exited && this.deps.choice(tabId) && !this.unavailable(tabId)) {
      const ask: Ask = { dir: 'on', waits: false, cancel: null }
      this.asks.set(tabId, ask)
      ask.cancel = this.deps.later(CONNECT_WAIT_MS, () => this.timedOut(tabId, ask))
    }
    this.deps.onChange(tabId)
  }

  /** the tab is closed: nothing is kept for it */
  removeTab(tabId: string): void {
    this.finish(tabId)
    this.dropChat(tabId)
  }

  /** a chat tab's Claude Code answered: its session is known now (a new conversation has its id only from its init, or none yet); the choice on attaches it */
  chatReady(tabId: string, sessionId: string | null): void {
    const link = this.chatOf(tabId)
    link.ready = true
    if (sessionId !== null) link.sessionId = sessionId
    this.attachChat(tabId)
    this.deps.onChange(tabId)
  }

  /** the chat's session changed (a clear, a startup, a resume): an attached session is detached first, then the new one is attached when the choice is on */
  chatSessionChanged(tabId: string, sessionId: string): void {
    const link = this.chatOf(tabId)
    link.sessionId = sessionId
    if (link.attached) {
      link.attached = false
      void this.moveChat(tabId)
    } else {
      this.attachChat(tabId)
    }
    this.deps.onChange(tabId)
  }

  /** the chat ended: its Remote Control detaches and the choice stays */
  chatEnded(tabId: string): void {
    // a tab already removed keeps no link: none is made for it, and nothing is reported for it
    const link = this.chats.get(tabId)
    if (!link) return
    link.live = false
    link.ready = false
    this.detachChat(tabId)
    this.deps.onChange(tabId)
  }

  /** types /remote-control with the tab's name; the id must come within CONNECT_WAIT_MS of the line */
  private typeOn(tabId: string): void {
    const ask: Ask = { dir: 'on', waits: false, cancel: null }
    this.asks.set(tabId, ask)
    void this.deps.type(tabId, `/remote-control ${this.deps.name(tabId)}`, (w) => this.waitChanged(tabId, ask, w), () => this.asks.get(tabId) !== ask).then((typed) => {
      if (this.asks.get(tabId) !== ask) return
      if (typed) {
        ask.cancel = this.deps.later(CONNECT_WAIT_MS, () => this.timedOut(tabId, ask))
      } else {
        this.asks.delete(tabId)
        this.deps.setChoice(tabId, false)
      }
      this.deps.onChange(tabId)
    })
  }

  /** types /remote-control to leave; an id still there after CONNECT_WAIT_MS means the person kept Remote Control */
  private typeOff(tabId: string): void {
    const ask: Ask = { dir: 'off', waits: false, cancel: null }
    this.asks.set(tabId, ask)
    void this.deps.type(tabId, '/remote-control', (w) => this.waitChanged(tabId, ask, w), () => this.asks.get(tabId) !== ask).then((typed) => {
      if (this.asks.get(tabId) !== ask) return
      if (typed) {
        ask.cancel = this.deps.later(CONNECT_WAIT_MS, () => this.kept(tabId, ask))
      } else {
        this.asks.delete(tabId)
        this.deps.setChoice(tabId, true)
      }
      this.deps.onChange(tabId)
    })
  }

  /** the connect wait ran out: without an id, the switch is off and the person hears of it */
  private timedOut(tabId: string, ask: Ask): void {
    if (this.asks.get(tabId) !== ask) return
    this.asks.delete(tabId)
    // an account that became unavailable while the wait ran drops it: no toast, and the choice stays as it is
    if (!this.unavailable(tabId) && this.deps.reportedId(tabId) === null) {
      this.deps.setChoice(tabId, false)
      this.deps.toast(connectTimeoutToast(this.deps.title(tabId)))
    }
    this.deps.onChange(tabId)
  }

  /** the leave wait ran out: an id still reported means the person kept Remote Control */
  private kept(tabId: string, ask: Ask): void {
    if (this.asks.get(tabId) !== ask) return
    this.asks.delete(tabId)
    if (this.deps.reportedId(tabId) !== null) this.deps.setChoice(tabId, true)
    this.deps.onChange(tabId)
  }

  private waitChanged(tabId: string, ask: Ask, waiting: boolean): void {
    if (this.asks.get(tabId) !== ask) return
    ask.waits = waiting
    this.deps.onChange(tabId)
  }

  /** drops the tab's switch and its timer */
  private finish(tabId: string): void {
    const ask = this.asks.get(tabId)
    if (!ask) return
    ask.cancel?.()
    this.asks.delete(tabId)
  }

  /** a chat tab's state while the host has none: connecting from the chat's start while the choice is on, else off */
  private chatState(tabId: string): RemoteState {
    const held = this.deps.host.state(tabId)
    if (held !== null) return held
    return this.deps.choice(tabId) && this.chats.get(tabId)?.live === true ? { kind: 'connecting' } : { kind: 'off' }
  }

  private chatOf(tabId: string): ChatLink {
    let link = this.chats.get(tabId)
    if (!link) {
      link = { live: false, ready: false, sessionId: null, attached: false }
      this.chats.set(tabId, link)
    }
    return link
  }

  /** attaches the chat's session when the choice is on, the account has Remote Control, the chat is ready and its session is known; the host itself ignores a tab that is connecting or on, and takes a failed one again */
  private attachChat(tabId: string): void {
    const link = this.chats.get(tabId)
    if (!link || !link.ready || link.sessionId === null) return
    if (!this.deps.choice(tabId) || this.unavailable(tabId)) return
    const target = this.deps.target(tabId, link.sessionId)
    if (target === null) return
    link.attached = true
    this.deps.host.attach(target)
  }

  /** detaches the chat's session when the host is attached to it */
  private detachChat(tabId: string): void {
    const link = this.chats.get(tabId)
    if (!link?.attached) return
    link.attached = false
    void this.deps.host.detach(tabId)
  }

  /** the chat's session is replaced: the host returns early for a tab that is connecting, whatever its session, so the old one is detached first and the new one attaches after */
  private async moveChat(tabId: string): Promise<void> {
    await this.deps.host.detach(tabId)
    this.attachChat(tabId)
    this.deps.onChange(tabId)
  }

  /** the tab's chat link ends with its terminal or its close: the host lets go of the session, the choice stays */
  private dropChat(tabId: string): void {
    this.detachChat(tabId)
    this.chats.delete(tabId)
  }

  private unavailable(tabId: string): boolean {
    return this.unavailableReason(tabId) !== null
  }

  /** why Remote Control is unavailable on the tab: the first reason its account kind and any of its environments give; null when it is available */
  private unavailableReason(tabId: string): string | null {
    const tab = this.deps.tab(tabId)
    if (!tab) return null
    const kind = this.deps.accountKind(tab.account)
    for (const env of this.deps.envs(tabId)) {
      const reason = remoteUnavailable(kind, env)
      if (reason !== null) return reason
    }
    return null
  }
}
