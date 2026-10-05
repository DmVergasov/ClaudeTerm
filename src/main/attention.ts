import type { Settings } from '../shared/types'

/** Signals from one tab closer together than this make a single sound (e.g. a question right before a permission prompt). */
export const ATTENTION_REPEAT_MS = 2000

export interface AttentionDeps {
  windowFocused(): boolean
  activeTabId(): string | null
  settings(): Settings['attention']
  flash(): void
  /** 'system' or an absolute path to a .wav file */
  play(sound: string): void
  markTab(tabId: string): void
  now?(): number
}

/** Tells the user that Claude in a tab is waiting for them, unless they are already looking at that tab. */
export class Attention {
  private readonly last = new Map<string, number>()

  constructor(private readonly d: AttentionDeps) {}

  /** Returns true when the user was signalled. */
  notify(tabId: string): boolean {
    const focused = this.d.windowFocused()
    const active = this.d.activeTabId() === tabId
    if (focused && active) return false
    const now = this.d.now?.() ?? Date.now()
    const prev = this.last.get(tabId)
    if (prev !== undefined && now - prev < ATTENTION_REPEAT_MS) return false
    this.last.set(tabId, now)
    const s = this.d.settings()
    if (!active) this.d.markTab(tabId)
    if (!focused && s.flash) this.d.flash()
    if (s.sound !== 'none') this.d.play(s.sound)
    return true
  }

  removeTab(tabId: string): void {
    this.last.delete(tabId)
  }
}
