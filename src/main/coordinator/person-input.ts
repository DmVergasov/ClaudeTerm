/** keys this close in time are one run of typing */
export const INPUT_GAP_MS = 2000
/** the runs of typing kept per tab: the latest this many */
export const INPUT_RUNS_KEPT = 256

interface Run {
  start: number
  end: number
}

/**
 * the times the window sent prompt-like input into each tab, from this device or a paired one, as runs of keys close in time: what
 * tells a prompt the person typed from one written into a transcript
 */
export class PersonInput {
  private readonly runs = new Map<string, Run[]>()

  note(tabId: string, at: number): void {
    let list = this.runs.get(tabId)
    if (list === undefined) {
      list = []
      this.runs.set(tabId, list)
    }
    const last = list[list.length - 1]
    if (last !== undefined && at - last.end <= INPUT_GAP_MS) {
      last.end = Math.max(last.end, at)
      return
    }
    list.push({ start: at, end: at })
    if (list.length > INPUT_RUNS_KEPT) list.shift()
  }

  /** whether a run of input in the tab reaches into the span from `after` (not counting it) up to `until` */
  between(tabId: string, after: number, until: number): boolean {
    return (this.runs.get(tabId) ?? []).some((r) => r.end > after && r.start <= until)
  }

  drop(tabId: string): void {
    this.runs.delete(tabId)
  }
}
