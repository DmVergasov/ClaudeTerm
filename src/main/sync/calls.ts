import { ATTACH_TIMEOUT_MS, CALL_TIMEOUT_MS } from '../../shared/remote'
import type { PeerLink } from './peer-link'
import { METHOD_RE } from './remote-wire'
import type { Message } from './wire'

/** A call refused on purpose: its message goes back to the caller as the reason. Any other throw is answered 'failed'. */
export class CallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CallError'
  }
}

/** The most calls one link serves at once; a call past it is answered 'busy'. */
const MAX_RUNNING = 64
/** The longest refusal sent back, in characters. */
const MAX_REFUSAL_LENGTH = 1000

/**
 * A method a link serves. `run` may return a promise; it throws a CallError to refuse. `bulk`: the reply goes through the
 * bulk lane, and `key` gives its bulk key, so a newer reply with the same key replaces a queued older one.
 */
export interface CallEntry {
  run(args: unknown): unknown
  bulk?: boolean
  key?(args: unknown): string | null
}

export type CallLink = Pick<PeerLink, 'send' | 'sendBulk' | 'on' | 'off'>

interface Waiting {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Request/response calls over a link: each call carries an id, is answered at most once, and has a time limit. */
export class Calls {
  private nextId = 1
  private readonly waiting = new Map<number, Waiting>()
  private readonly handlers: Map<string, CallEntry>
  private readonly timeoutMs: number
  private readonly maxRunning: number
  private readonly serveTimeoutMs: number
  private running = 0
  private closed = false

  /**
   * `serveTimeoutMs`: how long a handler may run before its slot is freed; its late result is dropped. The caller's own
   * limit still applies to the caller.
   */
  constructor(
    private readonly link: CallLink,
    handlers: Record<string, CallEntry>,
    opts: { timeoutMs?: number; maxRunning?: number; serveTimeoutMs?: number } = {}
  ) {
    this.handlers = new Map(Object.entries(handlers))
    this.timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS
    this.maxRunning = opts.maxRunning ?? MAX_RUNNING
    this.serveTimeoutMs = opts.serveTimeoutMs ?? ATTACH_TIMEOUT_MS
    link.on('message', this.onMessage)
    link.on('close', this.onClose)
  }

  /**
   * Calls a method of the peer. Rejects with a CallError: its message is the peer's refusal, or 'timeout', 'link closed',
   * 'unknown call' (a method the wire would refuse: nothing is sent) or 'failed' (the call cannot be encoded: nothing waits).
   */
  call(method: string, args: unknown, opts: { timeoutMs?: number; bulk?: boolean } = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new CallError('link closed'))
    if (!METHOD_RE.test(method)) return Promise.reject(new CallError('unknown call'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new CallError('timeout'))
      }, opts.timeoutMs ?? this.timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      const m: Message = { t: 'call', id, m: method, a: args ?? null }
      const sent = opts.bulk ? this.link.sendBulk(m) : this.link.send(m)
      // a link that closed on this send has already rejected the call; otherwise it could not be encoded
      if (!sent) this.drop(id, new CallError('failed'))
    })
  }

  /** Forgets a waiting call and rejects it, if it still waits. */
  private drop(id: number, e: Error): void {
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    clearTimeout(w.timer)
    w.reject(e)
  }

  /** Stops the calls: every waiting call rejects with 'link closed', and later calls reject at once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.link.off('message', this.onMessage)
    this.link.off('close', this.onClose)
    const waiting = [...this.waiting.values()]
    this.waiting.clear()
    for (const w of waiting) {
      clearTimeout(w.timer)
      w.reject(new CallError('link closed'))
    }
  }

  private readonly onClose = (): void => {
    this.close()
  }

  // reached from the link's listener: nothing may be thrown out of it
  private readonly onMessage = (m: Message): void => {
    try {
      if (m.t === 'call') this.serve(m.id, m.m, m.a)
      else if (m.t === 'reply') this.settle(m)
    } catch {
      // a message that cannot be answered is dropped
    }
  }

  private settle(m: { id: number; ok: boolean; v?: unknown; e?: string }): void {
    const w = this.waiting.get(m.id)
    // not waiting: answered already, or timed out and forgotten; a late answer is ignored
    if (!w) return
    this.waiting.delete(m.id)
    clearTimeout(w.timer)
    if (m.ok) w.resolve(m.v)
    else w.reject(new CallError(m.e ?? 'failed'))
  }

  private serve(id: number, method: string, args: unknown): void {
    const entry = this.handlers.get(method)
    if (!entry) {
      this.refuse(id, 'unknown call')
      return
    }
    if (this.running >= this.maxRunning) {
      this.refuse(id, 'busy')
      return
    }
    this.running++
    // the slot is freed once: when the handler settles, or when the serving limit passes first; a result that comes later is dropped
    let held = true
    const release = (): boolean => {
      if (!held) return false
      held = false
      clearTimeout(limit)
      this.running--
      return true
    }
    const limit = setTimeout(() => {
      release()
    }, this.serveTimeoutMs)
    let result: unknown
    try {
      result = entry.run(args)
    } catch (e) {
      release()
      this.refuse(id, refusalOf(e))
      return
    }
    Promise.resolve(result).then(
      (v) => {
        if (release()) this.answer(id, method, args, entry, v)
      },
      (e: unknown) => {
        if (release()) this.refuse(id, refusalOf(e))
      }
    )
  }

  /** Sends a result. One that cannot be sent is refused in its place as 'failed'; the link stays up. */
  private answer(id: number, method: string, args: unknown, entry: CallEntry, v: unknown): void {
    if (this.closed) return
    const reply: Message = { t: 'reply', id, ok: true, v: v ?? null }
    const sent = entry.bulk ? this.link.sendBulk(reply, bulkKey(entry, method, args)) : this.link.send(reply)
    if (!sent) this.refuse(id, 'failed')
  }

  private refuse(id: number, e: string): void {
    if (this.closed) return
    this.link.send({ t: 'reply', id, ok: false, e })
  }
}

/** The bulk key of a reply: the method and the entry's key of the arguments; undefined when the entry gives none. */
function bulkKey(entry: CallEntry, method: string, args: unknown): string | undefined {
  let key: string | null = null
  try {
    key = entry.key ? entry.key(args) : null
  } catch {
    key = null
  }
  return key ? `${method}:${key}` : undefined
}

/** The refusal sent back: its text with no NUL (a text field holds none, so the peer would drop the reply), cut to the longest allowed. */
function refusalOf(e: unknown): string {
  const text = (e instanceof CallError ? e.message : 'failed').replace(/\u0000/g, '')
  return (text || 'failed').slice(0, MAX_REFUSAL_LENGTH)
}
