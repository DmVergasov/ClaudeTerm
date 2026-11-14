import type { TabView } from '../shared/chat'
import type { TabInfo } from '../shared/types'

// The Claude tabs of this device follow the view the settings give them (claude.view): a change of the setting switches each
// open Claude tab that can switch without cutting anything off. A tab that works switches once its answer ends; a tab with
// background tasks keeps its view, since the switch would stop them, and its header offers the way back, which asks first.

export type FollowedTab = Pick<TabInfo, 'id' | 'kind' | 'view' | 'activity' | 'exited'>

export interface ViewFollowDeps {
  /** the view the settings give Claude tabs */
  home(): TabView
  /** this device's tabs */
  tabs(): FollowedTab[]
  /** the background tasks a tab's status names */
  background(tabId: string): number
  /** TabManager.setView: false when the tab cannot switch now */
  setView(tabId: string, view: TabView): Promise<boolean>
}

export class ViewFollow {
  /** the tabs that switch to the setting's view once their answer ends */
  private readonly waiting = new Set<string>()

  constructor(private readonly d: ViewFollowDeps) {}

  /** the setting changed: the tabs in another view switch to it, now or after their answer */
  settingChanged(): void {
    this.waiting.clear()
    for (const t of this.d.tabs()) this.follow(t)
  }

  /** a tab's info changed: one that waited for its answer to end switches once it has */
  updated(t: FollowedTab): void {
    if (!this.waiting.has(t.id) || t.activity === 'working') return
    this.waiting.delete(t.id)
    this.follow(t)
  }

  removeTab(tabId: string): void {
    this.waiting.delete(tabId)
  }

  private follow(t: FollowedTab): void {
    const home = this.d.home()
    if (t.kind !== 'claude' || t.exited || t.view === null || t.view === home) return
    if (this.d.background(t.id) > 0) return
    if (t.activity === 'working') {
      this.waiting.add(t.id)
      return
    }
    void this.d.setView(t.id, home)
  }
}
