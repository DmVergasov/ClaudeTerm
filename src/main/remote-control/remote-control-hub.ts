import { remoteLink, type RemoteState } from '../../shared/remote-control'
import type { TabView } from '../../shared/chat'
import { remoteUnavailable, type RemoteAccountKind } from './account-rules'

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
}

/** Computes what each Claude tab shows of Remote Control, from the id its Claude Code reports and the tab's account */
export class RemoteControlHub {
  constructor(private readonly deps: RemoteControlDeps) {}

  /** the tab's Remote Control state; null for a tab without the segment */
  state(tabId: string): RemoteState | null {
    const tab = this.deps.tab(tabId)
    if (!tab) return null
    const reason = remoteUnavailable(this.deps.accountKind(tab.account), this.deps.env(tabId))
    if (reason !== null) return { kind: 'unavailable', reason }
    if (tab.exited || tab.view !== 'terminal') return { kind: 'off' }
    const id = this.deps.reportedId(tabId)
    return id === null ? { kind: 'off' } : { kind: 'on', url: remoteLink(id) }
  }

  /** the tab's Claude Code reported a new Remote Control id (or none): a typed /remote-control sets the choice, its end clears it */
  reported(tabId: string, id: string | null, previous: string | null): void {
    if (this.deps.tab(tabId)?.view === 'terminal') {
      if (id !== null && previous === null) this.deps.setChoice(tabId, true)
      if (id === null && previous !== null) this.deps.setChoice(tabId, false)
    }
    this.deps.onChange(tabId)
  }

  /** a new Claude Code process starts in the tab: what the old one reported is no longer true */
  processStarted(tabId: string): void {
    this.deps.forgetReported(tabId)
    this.deps.onChange(tabId)
  }

  /** the tab is closed: nothing is kept for it */
  removeTab(_tabId: string): void {}
}
