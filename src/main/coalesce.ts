/** Runs a job once per wait: a request starts a wait of `ms`, and the requests that come during it are answered by the one run at its end. */
export class Coalescer {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly ms: number, private readonly job: () => void) {}

  request(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.job()
    }, this.ms)
  }

  /** drops the run that waits, if one does: the window it was for is closed, or the app quits */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
