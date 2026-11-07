/** the machine had keyboard or mouse input within this many seconds: the device is present */
export const PRESENT_IDLE_SECONDS = 30

/** how often the idle time is read again while the window is focused */
export const PRESENCE_TICK_MS = 5000

export interface PresenceDeps {
  /** whether this window has the focus */
  focused(): boolean
  /** seconds since the last keyboard or mouse input on the whole machine */
  idleSeconds(): number
  /** the presence flipped: called with the new value */
  changed(present: boolean): void
  tickMs?: number
  /** tick even when the window is not focused: a test hook, production ticks only while focused */
  alwaysTick?: boolean
}

/**
 * Whether this device is present: its window is focused and the machine had input recently. The idle time is read again
 * every few seconds while the window is focused, so a device that goes idle, or that becomes present, is told at once.
 */
export class Presence {
  private readonly tickMs: number
  /** the value last reported to changed(); the first value counts as not present */
  private last = false
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly deps: PresenceDeps) {
    this.tickMs = deps.tickMs ?? PRESENCE_TICK_MS
    // a window that never takes the focus (a test run) is ticked from the start: the focus events do not come
    if (deps.alwaysTick) this.schedule()
  }

  /** read now: the window is focused and the machine had input within PRESENT_IDLE_SECONDS */
  present(): boolean {
    return this.deps.focused() && this.deps.idleSeconds() < PRESENT_IDLE_SECONDS
  }

  /** recomputes; calls changed() on a flip, and ticks while the window is focused (or alwaysTick) */
  check(): void {
    if (this.disposed) return
    const now = this.present()
    if (now !== this.last) {
      this.last = now
      this.deps.changed(now)
    }
    this.schedule()
  }

  /** the timer stops and nothing is reported afterwards */
  dispose(): void {
    this.disposed = true
    this.stop()
  }

  private schedule(): void {
    const wanted = this.deps.focused() || this.deps.alwaysTick === true
    if (wanted && this.timer === null) this.timer = setInterval(() => this.check(), this.tickMs)
    else if (!wanted) this.stop()
  }

  private stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }
}
