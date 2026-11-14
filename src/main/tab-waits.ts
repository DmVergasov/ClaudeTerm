export interface TabPrompt {
  kind: 'permission' | 'question'
  text: string | null
  since: number
}

export interface TabLimit {
  resetsAt: number | null
  since: number
}

export interface TabWaitsState {
  prompt: TabPrompt | null
  limit: TabLimit | null
}

export interface TabWaitsDeps {
  now(): number
  /** called once per call that changed the tab's state */
  onChange(tabId: string): void
}

/** what a tab waits for the person for: an open permission or question dialog, a usage limit that stopped its turn */
export class TabWaits {
  private readonly tabs = new Map<string, TabWaitsState>()

  constructor(private readonly d: TabWaitsDeps) {}

  dialogOpened(tabId: string, kind: 'permission' | 'question', text: string | null): void {
    const s = this.tabs.get(tabId)
    if (s?.prompt && s.prompt.kind === kind && s.prompt.text === text) return
    this.entry(tabId).prompt = { kind, text, since: this.d.now() }
    this.d.onChange(tabId)
  }

  dialogsClosed(tabId: string): void {
    const s = this.tabs.get(tabId)
    if (!s?.prompt) return
    s.prompt = null
    this.d.onChange(tabId)
  }

  limited(tabId: string, resetsAt: number | null): void {
    const s = this.tabs.get(tabId)
    if (s?.limit && s.limit.resetsAt === resetsAt) return
    this.entry(tabId).limit = { resetsAt, since: this.d.now() }
    this.d.onChange(tabId)
  }

  /** the turn started: a limit stop is over */
  turnStarted(tabId: string): void {
    const s = this.tabs.get(tabId)
    if (!s?.limit) return
    s.limit = null
    this.d.onChange(tabId)
  }

  removeTab(tabId: string): void {
    const s = this.tabs.get(tabId)
    if (!s) return
    this.tabs.delete(tabId)
    if (s.prompt || s.limit) this.d.onChange(tabId)
  }

  get(tabId: string): TabWaitsState {
    const s = this.tabs.get(tabId)
    return { prompt: s?.prompt ?? null, limit: s?.limit ?? null }
  }

  private entry(tabId: string): TabWaitsState {
    let s = this.tabs.get(tabId)
    if (!s) {
      s = { prompt: null, limit: null }
      this.tabs.set(tabId, s)
    }
    return s
  }
}
