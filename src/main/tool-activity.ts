/** a file written this close to a tool's start or end still counts as written by it (transcript times are when lines are written) */
const SLACK_MS = 1500
/** a tool without a result after this long was cut off (the session was interrupted or crashed) */
const MAX_OPEN_MS = 2 * 60 * 60 * 1000
/** finished tools are kept this long after the latest one: new files are always recent */
const KEEP_MS = 10 * 60 * 1000

/** When the tools of one transcript ran: from a tool_use to its tool_result. */
export class ToolActivity {
  private readonly open = new Map<string, number>()
  private closed: { start: number; end: number }[] = []

  start(id: string, at: number): void {
    this.open.set(id, at)
    this.prune(at)
  }

  end(id: string, at: number): void {
    const start = this.open.get(id)
    if (start === undefined) return
    this.open.delete(id)
    this.closed.push({ start, end: at })
    this.prune(at)
  }

  /** whether a tool was running at `t` */
  runningAt(t: number): boolean {
    for (const start of this.open.values()) if (t >= start - SLACK_MS && t - start <= MAX_OPEN_MS) return true
    return this.closed.some((w) => t >= w.start - SLACK_MS && t <= w.end + SLACK_MS)
  }

  /** tools remembered, for tests */
  get tracked(): number {
    return this.open.size + this.closed.length
  }

  private prune(latest: number): void {
    this.closed = this.closed.filter((w) => latest - w.end <= KEEP_MS)
    for (const [id, start] of this.open) if (latest - start > MAX_OPEN_MS) this.open.delete(id)
  }
}
