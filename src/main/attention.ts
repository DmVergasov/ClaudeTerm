import type { NotificationCase, NotificationSettings } from '../shared/types'

/** A tab makes at most one sound this often (a question right before a permission prompt makes one). */
export const ATTENTION_REPEAT_MS = 2000

export interface AttentionDeps {
  windowFocused(): boolean
  activeTabId(): string | null
  settings(): NotificationSettings
  flash(): void
  /** 'system' or an absolute path to a .wav file */
  play(sound: string): void
  markTab(tabId: string, reason: NotificationCase): void
  /** the user muted that tab: it gives every signal but the sound */
  muted(tabId: string): boolean
  now?(): number
}

/** Tells the user that a tab needs them, with the signals set for the case; while they look at it, only the sound of a case set to Even in front. */
export class Attention {
  private readonly lastSound = new Map<string, number>()

  constructor(private readonly d: AttentionDeps) {}

  /** Returns true when any signal was given. */
  notify(tabId: string, reason: NotificationCase): boolean {
    const focused = this.d.windowFocused()
    const active = this.d.activeTabId() === tabId
    const s = this.d.settings()
    const c = s[reason]
    // in front of the user only the sound can say anything, and only for a case set to Even in front
    if (focused && active && !c.front) return false
    let signalled = false
    if (c.tab && !active) {
      this.d.markTab(tabId, reason)
      signalled = true
    }
    if (c.flash && !focused) {
      this.d.flash()
      signalled = true
    }
    if (c.sound && !this.d.muted(tabId)) {
      const now = this.d.now?.() ?? Date.now()
      const prev = this.lastSound.get(tabId)
      if (prev === undefined || now - prev >= ATTENTION_REPEAT_MS) {
        this.lastSound.set(tabId, now)
        this.d.play(s.sound)
        signalled = true
      }
    }
    return signalled
  }

  removeTab(tabId: string): void {
    this.lastSound.delete(tabId)
  }
}
