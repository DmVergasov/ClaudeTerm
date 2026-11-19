// The Chrome DevTools Protocol over a WebSocket. Node's global WebSocket does the framing.

export interface CdpSocket {
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>
  close(): void
}

// The browser shows an "Allow?" prompt for remote debugging: after this long without a connection, the caller is told.
const PENDING_AFTER_MS = 1000
const CONNECT_LIMIT_MS = 120_000
const SEND_LIMIT_MS = 30_000

interface Waiting {
  method: string
  resolve: (value: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Opens the socket. Rejects `refused` when the connection fails before it opens, `cancelled` on abort and `timeout`
 * after two minutes. Error messages never carry the URL or anything the browser sent.
 */
export function connectCdp(url: string, onPending: () => void, signal: AbortSignal): Promise<CdpSocket> {
  return new Promise<CdpSocket>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'))
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      reject(new Error('refused'))
      return
    }
    let opened = false
    let closed = false
    let nextId = 1
    const waiting = new Map<number, Waiting>()

    const pendingTimer = setTimeout(() => {
      if (!opened && !closed) onPending()
    }, PENDING_AFTER_MS)
    const limitTimer = setTimeout(() => {
      if (!opened) fail(new Error('timeout'))
    }, CONNECT_LIMIT_MS)

    const failAll = (e: Error): void => {
      for (const w of waiting.values()) {
        clearTimeout(w.timer)
        w.reject(e)
      }
      waiting.clear()
    }

    const shutdown = (): void => {
      closed = true
      clearTimeout(pendingTimer)
      clearTimeout(limitTimer)
      signal.removeEventListener('abort', onAbort)
      failAll(new Error('Connection closed'))
    }

    // before the socket opens, a failure means the browser is not there; after, it is a dropped connection
    // The promise settles before the socket is closed: closing a connecting socket fires its close event at once.
    const fail = (e: Error): void => {
      const wasClosed = closed
      shutdown()
      if (!opened) reject(e)
      if (!wasClosed) {
        try {
          ws.close()
        } catch {
          // already closing
        }
      }
    }

    const onAbort = (): void => {
      if (opened) {
        shutdown()
        ws.close()
      } else {
        fail(new Error('cancelled'))
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })

    ws.onopen = () => {
      if (closed) return
      opened = true
      clearTimeout(pendingTimer)
      clearTimeout(limitTimer)
      resolve({
        send: <T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = SEND_LIMIT_MS): Promise<T> =>
          new Promise<T>((res, rej) => {
            if (closed) {
              rej(new Error('Connection closed'))
              return
            }
            const id = nextId++
            const timer = setTimeout(() => {
              waiting.delete(id)
              rej(new Error(`${method} did not answer`))
            }, timeoutMs)
            waiting.set(id, { method, resolve: res as (value: unknown) => void, reject: rej, timer })
            const message: Record<string, unknown> = { id, method, params }
            if (sessionId !== undefined) message.sessionId = sessionId
            ws.send(JSON.stringify(message))
          }),
        close: () => {
          if (closed) return
          shutdown()
          try {
            ws.close()
          } catch {
            // already closing
          }
        },
      })
    }

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      let msg: unknown
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return
      const { id, result, error } = msg as { id?: unknown; result?: unknown; error?: unknown }
      if (typeof id !== 'number') return
      const w = waiting.get(id)
      if (!w) return
      waiting.delete(id)
      clearTimeout(w.timer)
      if (typeof error === 'object' && error !== null) {
        // the browser's own message is left out: it can name a target
        w.reject(new Error(`${w.method} failed`))
      } else {
        w.resolve(typeof result === 'object' && result !== null ? result : {})
      }
    }

    ws.onerror = () => {
      fail(new Error('refused'))
    }

    ws.onclose = () => {
      if (!opened) {
        fail(new Error('refused'))
        return
      }
      shutdown()
    }
  })
}
