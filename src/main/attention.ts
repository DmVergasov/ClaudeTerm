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
  now?(): number
}

/** Tells the user that a tab needs them, unless they are already looking at it, with the signals set for the case. */
export class Attention {
  private readonly lastSound = new Map<string, number>()

  constructor(private readonly d: AttentionDeps) {}

  /** Returns true when any signal was given. */
  notify(tabId: string, reason: NotificationCase): boolean {
    const focused = this.d.windowFocused()
    const active = this.d.activeTabId() === tabId
    if (focused && active) return false
    const s = this.d.settings()
    const c = s[reason]
    let signalled = false
    if (c.tab && !active) {
      this.d.markTab(tabId, reason)
      signalled = true
    }
    if (c.flash && !focused) {
      this.d.flash()
      signalled = true
    }
    if (c.sound) {
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
