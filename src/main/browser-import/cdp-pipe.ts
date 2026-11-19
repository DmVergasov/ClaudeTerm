// The Chromium DevTools Protocol over --remote-debugging-pipe: each message is JSON, ended by a NUL byte. The parent
// writes the browser's fd 3 and reads its fd 4.

const DEFAULT_TIMEOUT_MS = 10_000
// A message still waiting for its NUL byte may not grow past this: the pipe is closed instead.
const MAX_PENDING_BYTES = 64 * 1024 * 1024

/** A call that the browser did not answer in time. */
export class CdpTimeoutError extends Error {}

interface Pending {
  method: string
  resolve(result: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class CdpPipe {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private pieces: Buffer[] = []
  private pendingBytes = 0
  private closed = false

  constructor(private readonly write: NodeJS.WritableStream, read: NodeJS.ReadableStream) {
    read.on('data', (chunk: Buffer | string) => this.receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    read.on('end', () => this.close())
    read.on('close', () => this.close())
    read.on('error', () => this.close())
    write.on('error', () => this.close())
  }

  /** Sends one command and resolves with its result. Rejects on a protocol error, a timeout, or when the pipe is closed. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error('closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpTimeoutError(`${method} did not answer`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject, timer })
      this.write.write(`${JSON.stringify({ id, method, params })}\0`)
    })
  }

  /** Rejects every pending call and refuses the new ones. Does not touch the browser. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('closed'))
    }
    this.pending.clear()
    this.pieces = []
    this.pendingBytes = 0
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    let start = 0
    for (;;) {
      const end = chunk.indexOf(0, start)
      if (end === -1) {
        if (start < chunk.length) {
          this.pieces.push(chunk.subarray(start))
          this.pendingBytes += chunk.length - start
        }
        if (this.pendingBytes > MAX_PENDING_BYTES) this.close()
        return
      }
      this.pieces.push(chunk.subarray(start, end))
      const text = Buffer.concat(this.pieces).toString('utf8')
      this.pieces = []
      this.pendingBytes = 0
      start = end + 1
      this.handle(text)
    }
  }

  private handle(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    // Events have no id; a reply for a call that is no longer pending is ignored too.
    if (!isRecord(message) || typeof message.id !== 'number') return
    const p = this.pending.get(message.id)
    if (!p) return
    this.pending.delete(message.id)
    clearTimeout(p.timer)
    // The protocol's error text is not echoed: it names the method only.
    if (isRecord(message.error)) p.reject(new Error(`${p.method} failed`))
    else p.resolve(message.result ?? {})
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
