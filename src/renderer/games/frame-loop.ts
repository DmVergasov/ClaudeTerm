/**
 * The animation loop of a game that runs in time: it asks for frames only while it is on, and its first
 * frame only sets the clock, so time while it was off is never stepped.
 */
export class FrameLoop {
  /** the animation frame the loop waits for, and the time of the last frame it ran */
  private frameId: number | null = null
  private last: number | null = null

  /** frame(dt) runs with the seconds since the last frame; the loop goes on only while it returns true */
  constructor(private readonly frame: (dt: number) => boolean) {}

  /** asks for a frame unless one is pending */
  start(): void {
    if (this.frameId === null) this.frameId = requestAnimationFrame((now) => this.tick(now))
  }

  /** cancels the frame it waits for and forgets the clock */
  stop(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId)
    this.frameId = null
    this.last = null
  }

  private tick(now: number): void {
    // cleared first, so a frame that starts the loop again asks for exactly one new frame
    this.frameId = null
    const last = this.last
    this.last = now
    if (last !== null && !this.frame((now - last) / 1000)) {
      // a loop that does not go on forgets its clock, so the next start does not step the time since
      this.last = null
      return
    }
    this.start()
  }
}
