import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { RemoteSnapshot } from '../../shared/remote'
import { boundedSerialize, scrollbackLines } from '../../shared/screen-serialize'

/** the constants live here, so the worker's bundle needs nothing from main */
const SEED_WAIT_MS = 5000
const MAX_HELD_CHARS = 4 * 1024 * 1024

export interface MirrorOpen {
  /** the number of the last chunk already on the screen; 0 by default */
  seq?: number
  /** output is held until seed() or seedWaitMs */
  awaitSeed?: boolean
}

export interface ScreenMirrorsApi {
  open(tabId: string, cols: number, rows: number, scrollback: number, opts?: MirrorOpen): void
  /** seq: the chunk's number in the tab's stream; an empty chunk only moves the number on (an exit) */
  write(tabId: string, seq: number, data: string): void
  resize(tabId: string, cols: number, rows: number): void
  /** the process restarted: the copy starts clean (RIS) at this number */
  reset(tabId: string, seq: number): void
  close(tabId: string): void
  /** this window's screen of the tab, written before the held output; ignored for a copy that waits for no seed */
  seed(tabId: string, data: string): void
  /** taken after everything written so far is parsed (and the seed, or seedWaitMs); null for a tab it does not have */
  snapshot(tabId: string): Promise<RemoteSnapshot | null>
  onTitle(cb: (tabId: string, title: string) => void): void
  dispose(): void
}

interface Copy {
  term: Terminal
  serialize: SerializeAddon
  scrollback: number
  /** the number of the last chunk written into the copy */
  seq: number
  waiting: boolean
  held: { seq?: number; run: () => void }[]
  heldChars: number
  /** snapshots asked while the copy waits, each taken once it stops waiting */
  waiters: (() => void)[]
  timer?: ReturnType<typeof setTimeout>
  /** snapshots not yet answered: closing the copy answers them null */
  asks: Set<(snap: RemoteSnapshot | null) => void>
  closed: boolean
}

/** one headless terminal per tab, fed the tab's stream, so a device can hand over its screen */
export class ScreenMirrors implements ScreenMirrorsApi {
  private copies = new Map<string, Copy>()
  private titleCbs: ((tabId: string, title: string) => void)[] = []
  private readonly maxSnapshotBytes: number
  private readonly seedWaitMs: number
  private readonly maxHeldChars: number

  constructor(opts: { maxSnapshotBytes: number; seedWaitMs?: number; maxHeldChars?: number }) {
    this.maxSnapshotBytes = opts.maxSnapshotBytes
    this.seedWaitMs = opts.seedWaitMs ?? SEED_WAIT_MS
    this.maxHeldChars = opts.maxHeldChars ?? MAX_HELD_CHARS
  }

  open(tabId: string, cols: number, rows: number, scrollback: number, opts: MirrorOpen = {}): void {
    this.close(tabId)
    const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
    const serialize = new SerializeAddon()
    term.loadAddon(serialize)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    const c: Copy = { term, serialize, scrollback, seq: opts.seq ?? 0, waiting: !!opts.awaitSeed, held: [], heldChars: 0, waiters: [], asks: new Set(), closed: false }
    term.onTitleChange((title) => {
      for (const cb of this.titleCbs) cb(tabId, title)
    })
    this.copies.set(tabId, c)
    if (c.waiting) c.timer = setTimeout(() => this.stopWaiting(c, undefined), this.seedWaitMs)
  }

  write(tabId: string, seq: number, data: string): void {
    const c = this.copies.get(tabId)
    if (c) this.feed(c, seq, data.length, () => c.term.write(data))
  }

  resize(tabId: string, cols: number, rows: number): void {
    const c = this.copies.get(tabId)
    // queued behind the output already written, so the parser sees the size change at the same point as the window
    if (c) this.feed(c, undefined, 0, () => c.term.write('', () => { if (!c.closed) c.term.resize(cols, rows) }))
  }

  reset(tabId: string, seq: number): void {
    const c = this.copies.get(tabId)
    if (c) this.feed(c, seq, 0, () => c.term.write('\x1bc'))
  }

  close(tabId: string): void {
    const c = this.copies.get(tabId)
    if (!c) return
    this.copies.delete(tabId)
    c.closed = true
    clearTimeout(c.timer)
    c.held = []
    c.heldChars = 0
    c.waiters = []
    for (const ask of [...c.asks]) ask(null)
    c.term.dispose()
  }

  seed(tabId: string, data: string): void {
    const c = this.copies.get(tabId)
    if (c) this.stopWaiting(c, data)
  }

  snapshot(tabId: string): Promise<RemoteSnapshot | null> {
    const c = this.copies.get(tabId)
    if (!c) return Promise.resolve(null)
    return new Promise((resolve) => {
      let done = false
      const finish = (snap: RemoteSnapshot | null): void => {
        if (done) return
        done = true
        c.asks.delete(finish)
        resolve(snap)
      }
      c.asks.add(finish)
      const ask = (): void => {
        if (c.closed) return finish(null)
        // the number is read now: it counts what is queued before this marker, which is what the callback parses up to
        const seq = c.seq
        c.term.write('', () => {
          try {
            finish(c.closed ? null : this.snapshotOf(c, seq))
          } catch {
            finish(null)
          }
        })
      }
      if (c.waiting) c.waiters.push(ask)
      else ask()
    })
  }

  onTitle(cb: (tabId: string, title: string) => void): void {
    this.titleCbs.push(cb)
  }

  dispose(): void {
    for (const tabId of [...this.copies.keys()]) this.close(tabId)
  }

  /** writes now, or holds the write (with its number) while the copy waits for its seed */
  private feed(c: Copy, seq: number | undefined, chars: number, run: () => void): void {
    if (!c.waiting) {
      run()
      if (seq !== undefined) c.seq = seq
      return
    }
    c.held.push({ seq, run })
    c.heldChars += chars
    if (c.heldChars > this.maxHeldChars) this.stopWaiting(c, undefined)
  }

  /** writes the seed (if any) and the held output in order; a later seed finds the copy not waiting */
  private stopWaiting(c: Copy, seed: string | undefined): void {
    if (!c.waiting) return
    c.waiting = false
    clearTimeout(c.timer)
    if (seed !== undefined) c.term.write(seed)
    for (const h of c.held) {
      h.run()
      if (h.seq !== undefined) c.seq = h.seq
    }
    c.held = []
    c.heldChars = 0
    const waiters = c.waiters
    c.waiters = []
    for (const ask of waiters) ask()
  }

  private snapshotOf(c: Copy, seq: number): RemoteSnapshot {
    // the scrollback the buffer really holds: a copy of a short session does not ask the serializer for the whole setting
    const data = boundedSerialize((n) => c.serialize.serialize({ scrollback: n }), c.scrollback, this.maxSnapshotBytes, scrollbackLines(c.term))
    return { data, seq, cols: c.term.cols, rows: c.term.rows }
  }
}
