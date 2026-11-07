/**
 * Which tab the window brings to the front when the one in front closes and main activates none (a remote tab closed, or
 * this device's last local tab). The window asks main for the first tab left; main ignores a request for a tab that is
 * closing too, so the ask is made again when the asked tab closes before it comes to the front.
 */
export class FrontFallback {
  /** the tab asked for, until a tab comes to the front */
  private asked: string | null = null

  /**
   * A tab closed. `order` is the window's order without it; `front` is the tab that was in front before the close (null:
   * none). Answers the tab to ask main to activate, or null when nothing is to be asked.
   */
  closed(id: string, order: readonly string[], front: string | null): string | null {
    if (id !== this.asked && id !== front) return null
    this.asked = order[0] ?? null
    return this.asked
  }

  /** a tab came to the front: nothing is asked for any more */
  activated(_id: string): void {
    this.asked = null
  }
}
