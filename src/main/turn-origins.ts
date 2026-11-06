interface TabTurns {
  sessionId: string | null
  /** the highest turn index reported, -1 for none */
  turn: number
  /** whether that turn was started by a message from another session */
  peer: boolean
}

/**
 * What started the turns of each tab's conversation, as the tab's transcript reports them: a message from another Claude
 * Code session, or anything else. A turn's first report decides its origin, and only the highest turn seen counts.
 */
export class TurnOrigins {
  private readonly tabs = new Map<string, TabTurns>()

  /** the tab's conversation is now this session; another session forgets its turns */
  session(tabId: string, sessionId: string): void {
    if (this.tabs.get(tabId)?.sessionId === sessionId) return
    this.tabs.set(tabId, { sessionId, turn: -1, peer: false })
  }

  report(tabId: string, turnIndex: number, peer: boolean): void {
    let t = this.tabs.get(tabId)
    if (!t) {
      t = { sessionId: null, turn: -1, peer: false }
      this.tabs.set(tabId, t)
    }
    if (turnIndex <= t.turn) return
    t.turn = turnIndex
    t.peer = peer
  }

  /** whether the last turn of the tab was started by a message from another session */
  lastTurnIsPeer(tabId: string): boolean {
    return this.tabs.get(tabId)?.peer ?? false
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }
}
