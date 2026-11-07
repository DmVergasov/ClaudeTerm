import type { RemoteSnapshot } from '../../shared/remote'

// The screen of an attached tab: the snapshot the device sends at attach, then the numbered stream after it. Items that
// arrive before the snapshot wait for it; a gap in the numbers asks for a fresh attach.

/** One item of a tab's numbered stream, as the device sends it */
export type StreamItem =
  | { t: 'out'; seq: number; d: string }
  | { t: 'reset'; seq: number }
  | { t: 'exit'; seq: number; code: number }

/** What the viewer does with an item: write data, reset the screen, show the exit, or attach again */
export type ViewStep =
  | { kind: 'write'; data: string }
  | { kind: 'reset' }
  | { kind: 'exit'; code: number }
  | { kind: 'reattach' }

/** The most characters held while the snapshot is awaited; more asks for a fresh attach */
export const MAX_WAITING_CHARS = 4 * 1024 * 1024
/** what a waiting reset or exit counts toward MAX_WAITING_CHARS: a fixed cost, so none of them waits without bound */
const ITEM_CHARS = 64

export class AttachedView {
  /** the stream items that came before the snapshot, in arrival order */
  private waiting: StreamItem[] = []
  private waitingChars = 0
  /** the number of the last item taken; null until the snapshot */
  private last: number | null = null
  /** a gap was seen: the view says nothing more, and its viewer drops it */
  private lost = false

  /** true once the snapshot is taken: the stream is written from then on */
  get ready(): boolean {
    return this.last !== null
  }

  stream(m: StreamItem): ViewStep[] {
    if (this.lost) return []
    if (this.last === null) {
      this.waiting.push(m)
      this.waitingChars += m.t === 'out' ? m.d.length : ITEM_CHARS
      if (this.waitingChars > MAX_WAITING_CHARS) return this.reattach()
      return []
    }
    if (m.seq !== this.last + 1) return this.reattach()
    this.last = m.seq
    return [stepOf(m)]
  }

  snapshot(s: RemoteSnapshot): ViewStep[] {
    if (this.lost) return []
    if (this.last !== null) return this.reattach()
    // the items the snapshot covers are dropped (but a covered exit): the rest must go on from its number, with no gap
    const covered = this.waiting.filter((m) => m.seq <= s.seq)
    const rest = this.waiting.filter((m) => m.seq > s.seq)
    this.waiting = []
    this.waitingChars = 0
    let next = s.seq
    for (const m of rest) {
      if (m.seq !== next + 1) return this.reattach()
      next = m.seq
    }
    this.last = next
    // an exit is a stream's last item: a covered one still reaches the window, with its code, after the screen, when
    // nothing follows it (output or a reset after it means the tab restarted, and its exit is not the tab's)
    const lastCovered = covered[covered.length - 1]
    const exited = lastCovered?.t === 'exit' && rest.length === 0 ? lastCovered : undefined
    return [
      { kind: 'reset' },
      { kind: 'write', data: s.data },
      ...(exited ? [stepOf(exited)] : []),
      ...rest.map(stepOf)
    ]
  }

  private reattach(): ViewStep[] {
    this.lost = true
    this.waiting = []
    this.waitingChars = 0
    return [{ kind: 'reattach' }]
  }
}

function stepOf(m: StreamItem): ViewStep {
  if (m.t === 'out') return { kind: 'write', data: m.d }
  if (m.t === 'reset') return { kind: 'reset' }
  return { kind: 'exit', code: m.code }
}
