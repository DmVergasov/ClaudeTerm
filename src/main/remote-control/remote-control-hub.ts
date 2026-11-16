import { connectTimeoutToast, remoteLink, type RemoteState } from '../../shared/remote-control'
import type { TabView } from '../../shared/chat'
import { remoteUnavailable, type RemoteAccountKind } from './account-rules'

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
  /** the environment the tab's Claude Code starts with */
  env(tabId: string): Record<string, string>
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
}

/** the one switch a tab is doing: a typed line the hub waits on, or the id it waits for */
interface Ask {
  dir: 'on' | 'off'
  /** the typed line waits for Claude Code's empty prompt */
  waits: boolean
  cancel: (() => void) | null
}

/** Computes what each Claude tab shows of Remote Control, from the id its Claude Code reports and the tab's account */
export class RemoteControlHub {
  /** the tab's open switch: at most one per tab */
  private readonly asks = new Map<string, Ask>()

  constructor(private readonly deps: RemoteControlDeps) {}

  /** the tab's Remote Control state; null for a tab without the segment */
  state(tabId: string): RemoteState | null {
    const tab = this.deps.tab(tabId)
    if (!tab) return null
    const reason = remoteUnavailable(this.deps.accountKind(tab.account), this.deps.env(tabId))
    if (reason !== null) return { kind: 'unavailable', reason }
    if (tab.exited || tab.view !== 'terminal') return { kind: 'off' }
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
    if (!tab || tab.exited || this.unavailable(tabId)) return
    if (tab.view !== 'terminal') {
      this.deps.setChoice(tabId, on)
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
      this.finish(tabId)
      this.deps.setChoice(tabId, false)
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
        else if (previous === null) this.deps.setChoice(tabId, true)
      } else if (previous !== null) {
        if (ask?.dir === 'off') this.finish(tabId)
        else if (!ask) this.deps.setChoice(tabId, false)
      }
    }
    this.deps.onChange(tabId)
  }

  /** a new Claude Code process starts in the tab: what the old one reported is no longer true; a tab whose choice is on connects */
  processStarted(tabId: string): void {
    this.finish(tabId)
    this.deps.forgetReported(tabId)
    const tab = this.deps.tab(tabId)
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
    if (this.deps.reportedId(tabId) === null) {
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

  private unavailable(tabId: string): boolean {
    const tab = this.deps.tab(tabId)
    return tab !== null && remoteUnavailable(this.deps.accountKind(tab.account), this.deps.env(tabId)) !== null
  }
}
