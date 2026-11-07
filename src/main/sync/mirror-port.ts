import type { RemoteSnapshot } from '../../shared/remote'
import type { MirrorOpen, ScreenMirrorsApi } from './screen-mirror'

/** a snapshot the worker does not answer in this time resolves null: a hung worker must not hold a request forever */
const SNAPSHOT_TIMEOUT_MS = 10_000

/** a worker_threads MessagePort or Worker; only a Worker emits 'error' and 'exit' and has terminate */
export interface PortLike {
  postMessage(m: unknown): void
  on(event: 'message' | 'error' | 'exit', cb: (m: unknown) => void): unknown
  terminate?(): unknown
}

export type PortRequest =
  | { op: 'open'; tabId: string; cols: number; rows: number; scrollback: number; opts: MirrorOpen }
  | { op: 'write'; tabId: string; seq: number; data: string }
  | { op: 'resize'; tabId: string; cols: number; rows: number }
  | { op: 'reset'; tabId: string; seq: number }
  | { op: 'close'; tabId: string }
  | { op: 'seed'; tabId: string; data: string }
  | { op: 'snapshot'; req: number; tabId: string }

export type PortEvent = { op: 'snapshot'; req: number; snap: RemoteSnapshot | null } | { op: 'title'; tabId: string; title: string }

const isInt = (v: unknown): v is number => Number.isSafeInteger(v)

/**
 * The path a screen worker is started from. A packaged app keeps its files in app.asar, which a worker thread cannot run
 * from, so the worker file is unpacked beside it: that folder is named app.asar.unpacked. Any other path is returned as it is.
 */
export function screenWorkerPath(file: string): string {
  return file.replace(/(^|[\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked')
}

/** the shape of a snapshot answer: a number of chunks from 0, and a size of at least one cell each way */
function isSnapshot(v: unknown): v is RemoteSnapshot {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return typeof s.data === 'string' && isInt(s.seq) && s.seq >= 0 && isInt(s.cols) && s.cols >= 1 && isInt(s.rows) && s.rows >= 1
}

/** the main side of the screen copies: the same calls as ScreenMirrors, sent to the worker */
export class PortMirrors implements ScreenMirrorsApi {
  private nextReq = 1
  private pending = new Map<number, { resolve: (snap: RemoteSnapshot | null) => void; timer: ReturnType<typeof setTimeout> }>()
  private titleCbs: ((tabId: string, title: string) => void)[] = []
  private exitCbs: (() => void)[] = []
  private gone = false
  private readonly snapshotTimeoutMs: number

  constructor(private readonly port: PortLike, opts: { snapshotTimeoutMs?: number } = {}) {
    this.snapshotTimeoutMs = opts.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS
    port.on('message', (m) => this.onMessage(m))
    port.on('error', () => this.exited())
    port.on('exit', () => this.exited())
  }

  /** the worker exited or failed: waiting snapshots answer null, and so do later ones */
  onExit(cb: () => void): void {
    this.exitCbs.push(cb)
  }

  open(tabId: string, cols: number, rows: number, scrollback: number, opts: MirrorOpen = {}): void {
    this.post({ op: 'open', tabId, cols, rows, scrollback, opts })
  }

  write(tabId: string, seq: number, data: string): void {
    this.post({ op: 'write', tabId, seq, data })
  }

  resize(tabId: string, cols: number, rows: number): void {
    this.post({ op: 'resize', tabId, cols, rows })
  }

  reset(tabId: string, seq: number): void {
    this.post({ op: 'reset', tabId, seq })
  }

  close(tabId: string): void {
    this.post({ op: 'close', tabId })
  }

  seed(tabId: string, data: string): void {
    this.post({ op: 'seed', tabId, data })
  }

  snapshot(tabId: string): Promise<RemoteSnapshot | null> {
    if (this.gone) return Promise.resolve(null)
    const req = this.nextReq++
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(req, null), this.snapshotTimeoutMs)
      this.pending.set(req, { resolve, timer })
      this.post({ op: 'snapshot', req, tabId })
    })
  }

  onTitle(cb: (tabId: string, title: string) => void): void {
    this.titleCbs.push(cb)
  }

  /** answers the waiting snapshots null and stops the worker; the exit callbacks are for the worker's own exit or failure */
  dispose(): void {
    this.gone = true
    this.answerAll()
    this.port.terminate?.()
  }

  private post(req: PortRequest): void {
    if (!this.gone) this.port.postMessage(req)
  }

  private exited(): void {
    if (this.gone) return
    this.gone = true
    this.answerAll()
    const cbs = this.exitCbs
    this.exitCbs = []
    // one callback that throws must not keep the others from running
    for (const cb of cbs) {
      try {
        cb()
      } catch {
        // the holder's own handler failed: nothing else to do here
      }
    }
  }

  private answerAll(): void {
    for (const req of [...this.pending.keys()]) this.answer(req, null)
  }

  /** a late answer for a request already answered (or timed out) finds nothing and is ignored */
  private answer(req: number, snap: RemoteSnapshot | null): void {
    const p = this.pending.get(req)
    if (!p) return
    this.pending.delete(req)
    clearTimeout(p.timer)
    p.resolve(snap)
  }

  /** nothing from the worker throws out of this listener: a malformed event is dropped */
  private onMessage(m: unknown): void {
    try {
      if (typeof m !== 'object' || m === null) return
      const e = m as Record<string, unknown>
      if (e.op === 'snapshot') {
        if (!isInt(e.req)) return
        // a bad answer to a known request is null at once: it does not wait for the time limit
        this.answer(e.req, isSnapshot(e.snap) ? e.snap : null)
      } else if (e.op === 'title') {
        if (typeof e.tabId !== 'string' || typeof e.title !== 'string') return
        for (const cb of this.titleCbs) cb(e.tabId, e.title)
      }
    } catch {
      // a throwing title callback must not reach the port's listener
    }
  }
}
