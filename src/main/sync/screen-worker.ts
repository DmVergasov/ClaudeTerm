import { parentPort, workerData } from 'node:worker_threads'
import type { PortEvent, PortLike, PortRequest } from './mirror-port'
import { ScreenMirrors } from './screen-mirror'

/** the constant lives here, so the worker's bundle needs nothing from main */
const DEFAULT_SNAPSHOT_BYTES = 8 * 1024 * 1024

/** the snapshot limit the worker was started with: a positive safe integer, or the default */
export function snapshotLimitOf(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : DEFAULT_SNAPSHOT_BYTES
}

/** runs the copies for requests from main; answers snapshots and reports titles */
export function serveMirrors(port: PortLike, mirrors: ScreenMirrors): void {
  const post = (e: PortEvent): void => port.postMessage(e)
  mirrors.onTitle((tabId, title) => post({ op: 'title', tabId, title }))
  port.on('message', (m) => {
    // a message that is not a request (null, another op, a throw) is ignored: the worker lives on
    try {
      const r = m as PortRequest
      switch (r.op) {
        case 'open': return mirrors.open(r.tabId, r.cols, r.rows, r.scrollback, r.opts)
        case 'write': return mirrors.write(r.tabId, r.seq, r.data)
        case 'resize': return mirrors.resize(r.tabId, r.cols, r.rows)
        case 'reset': return mirrors.reset(r.tabId, r.seq)
        case 'close': return mirrors.close(r.tabId)
        case 'seed': return mirrors.seed(r.tabId, r.data)
        case 'snapshot':
          mirrors.snapshot(r.tabId)
            .then((snap) => post({ op: 'snapshot', req: r.req, snap }), () => post({ op: 'snapshot', req: r.req, snap: null }))
          return
      }
    } catch {
      // see above
    }
  })
}

if (parentPort && workerData?.screenWorker === true) serveMirrors(parentPort, new ScreenMirrors({ maxSnapshotBytes: snapshotLimitOf(workerData.maxSnapshotBytes) }))
