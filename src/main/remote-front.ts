/** how long a tab a new-tab request opened waits to come to the front, after its answer */
export const PENDING_ACTIVATE_MS = 15_000

/**
 * Which tab a new-tab request on another device brings to the front. The device lists the new tab before it answers,
 * so the answer can come while the person has picked another tab: every activation the person makes counts, and a
 * request that was overtaken by one does not bring its tab forward. A tab a request brings forward itself (its answer,
 * or its pending tab arriving) is not the person's choice: it does not overtake the requests still out, so the last
 * request to be answered wins.
 */
export class RemoteFront {
  /** the person's activations so far: a request compares its mark with this */
  private acts = 0
  /** the one tab still waiting to come to the front, with the device it runs on and when it stops waiting */
  private pending: { tabId: string; device: string; until: number } | null = null

  /** a tab is brought to the front by the person or a local tab: the pending tab is forgotten */
  activated(): void {
    this.acts++
    this.pending = null
  }

  /** a tab is brought to the front by a new-tab request or its pending tab arriving: the pending tab is forgotten */
  activatedByRequest(): void {
    this.pending = null
  }

  /** taken before a new-tab request is sent */
  mark(): number {
    return this.acts
  }

  /**
   * The request's answer: 'skip' when the person activated a tab since the mark, 'activate' when the tab is already
   * listed, else 'wait' (the tab becomes the pending one, in place of an earlier one)
   */
  answered(mark: number, tabId: string, listed: boolean, now: number, device: string): 'activate' | 'wait' | 'skip' {
    if (mark !== this.acts) return 'skip'
    if (listed) {
      this.pending = null
      return 'activate'
    }
    this.pending = { tabId, device, until: now + PENDING_ACTIVATE_MS }
    return 'wait'
  }

  /** true once for the pending tab when it arrives in time; false for any other tab, and after it expired */
  arrived(tabId: string, now: number): boolean {
    const p = this.pending
    if (!p || p.tabId !== tabId) return false
    this.pending = null
    return now < p.until
  }

  /** the device went offline: its pending tab is forgotten */
  deviceGone(device: string): void {
    if (this.pending?.device === device) this.pending = null
  }

  /** the tab closed: if it is the pending one, it is forgotten */
  closed(tabId: string): void {
    if (this.pending?.tabId === tabId) this.pending = null
  }

  /** the group closed: nothing is pending */
  reset(): void {
    this.pending = null
  }
}

/**
 * Whether a member's front clears its tab's attention. `was` is the member's front before this one (undefined: none yet,
 * as after a reconnect). A new tab in front clears; the same tab clears only when its window gains the focus, so a window
 * that loses the focus by itself leaves a waiting tab's mark where it is.
 */
export function frontClears(was: { tabId: string; focused: boolean } | undefined, tabId: string, focused: boolean): boolean {
  return was?.tabId !== tabId || (focused && !was.focused)
}
