/** a member typed into one of this device's tabs this recently: the computer stays awake for them */
export const AWAKE_INPUT_MS = 30 * 60_000

/** how often the hold is checked again while it is held */
const TICK_MS = 60_000

/** the power blocker of the app: it keeps the computer from sleeping while it is started */
export interface PowerBlocker {
  start(): number
  stop(id: number): void
}

export interface KeepAwakeDeps {
  blocker: PowerBlocker
  /** the setting: off, nothing is held */
  enabled(): boolean
  now(): number
  /** how long after a member's last input the computer stays awake */
  inputMs?: number
  tickMs?: number
}

/**
 * Keeps this computer awake while another device uses it: a member typed into one of this device's tabs recently, or a
 * Claude tab another device has attached is working. Nothing is held unless a member link is up, and the hold ends at once
 * when the setting goes off, when the last link ends, or when nothing keeps it. Each hold starts the blocker once and
 * stops it once.
 */
export class KeepAwake {
  private readonly inputMs: number
  private readonly tickMs: number
  /** the time of the last member input, null for none yet */
  private lastInput: number | null = null
  private linked = false
  private watchedWorking = false
  /** the blocker's id while a hold is on, null while none is */
  private blockerId: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly deps: KeepAwakeDeps) {
    this.inputMs = deps.inputMs ?? AWAKE_INPUT_MS
    this.tickMs = deps.tickMs ?? TICK_MS
  }

  /** a member typed into one of this device's tabs */
  input(): void {
    if (this.disposed) return
    this.lastInput = this.deps.now()
    this.recheck()
  }

  /** linked: a member link is up; watchedWorking: a Claude tab another device has attached is working */
  update(state: { linked: boolean; watchedWorking: boolean }): void {
    if (this.disposed) return
    this.linked = state.linked
    this.watchedWorking = state.watchedWorking
    this.recheck()
  }

  holding(): boolean {
    return this.blockerId !== null
  }

  /** the hold ends: the blocker is stopped and the timer cleared; nothing is held afterwards */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.release()
  }

  private wanted(): boolean {
    const typedRecently = this.lastInput !== null && this.deps.now() - this.lastInput < this.inputMs
    return this.deps.enabled() && this.linked && (typedRecently || this.watchedWorking)
  }

  private recheck(): void {
    if (!this.wanted()) {
      this.release()
      return
    }
    if (this.blockerId === null) this.blockerId = this.deps.blocker.start()
    if (this.timer === null) {
      this.timer = setInterval(() => this.recheck(), this.tickMs)
      this.timer.unref?.()
    }
  }

  private release(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.blockerId === null) return
    const id = this.blockerId
    this.blockerId = null
    this.deps.blocker.stop(id)
  }
}
