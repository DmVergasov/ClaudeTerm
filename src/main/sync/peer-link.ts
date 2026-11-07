import { EventEmitter } from 'node:events'
import type { TLSSocket } from 'node:tls'
import { fingerprintOf } from './identity'
import { BULK_CHUNK_BYTES, encodeBulkFrames, encodeFrame, FrameDecoder, FrameError, MAX_FRAME_BYTES, type Message, parseMessage } from './wire'

export interface PeerLinkOptions {
  /** true when this device dialed the peer */
  outbound: boolean
  /** how often a ping is sent; 15 seconds by default */
  pingMs?: number
  /** how long the link may hear nothing before it closes; 45 seconds by default */
  idleMs?: number
  /** how much may wait unsent in the socket before the peer counts as slow; 32 MiB by default */
  maxBufferedBytes?: number
  /** the largest frame the peer may send, in bytes; 16 MiB by default. A frame over it closes the link. */
  maxFrameBytes?: number
  /** how much bulk may wait queued, not yet written, before the peer counts as slow; 128 MiB by default */
  maxQueuedBulkBytes?: number
}

/** A bulk message waiting to be written: its frames in order, its key, and whether a frame of it has been written. */
interface BulkEntry {
  frames: Buffer[]
  key: string | undefined
  started: boolean
}

const DEFAULT_PING_MS = 15_000
const DEFAULT_IDLE_MS = 45_000
const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_QUEUED_BULK_BYTES = 128 * 1024 * 1024

/**
 * One authenticated TLS connection to a peer, carrying framed messages. Pings keep a quiet link open; a link that hears
 * nothing for idleMs closes. Whatever the peer sends is checked here: a frame that cannot be read closes the link.
 */
export class PeerLink extends EventEmitter {
  /** lowercase hex SHA-256 of the peer's public key; empty when the peer presented no certificate */
  readonly peerFingerprint: string
  readonly outbound: boolean
  readonly remoteAddress: string | null
  private closed = false
  private readonly decoder: FrameDecoder
  private readonly maxBufferedBytes: number
  private readonly maxQueuedBulkBytes: number
  private readonly idleMs: number
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** the bulk messages waiting to be written, in order */
  private readonly bulk: BulkEntry[] = []
  /** the bytes of every frame in `bulk` not yet written */
  private queuedBytes = 0
  private pumpQueued = false

  constructor(private readonly socket: TLSSocket, opts: PeerLinkOptions) {
    super()
    this.outbound = opts.outbound
    this.remoteAddress = socket.remoteAddress ?? null
    this.maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
    this.maxQueuedBulkBytes = opts.maxQueuedBulkBytes ?? DEFAULT_MAX_QUEUED_BULK_BYTES
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.decoder = new FrameDecoder(opts.maxFrameBytes ?? MAX_FRAME_BYTES)

    const cert = socket.getPeerX509Certificate()
    if (!cert) {
      this.peerFingerprint = ''
      this.closed = true
      socket.destroy()
      process.nextTick(() => {
        try {
          this.emit('close', 'no certificate')
        } catch {
          // as in close(): a listener that throws is not an uncaught exception
        }
      })
      return
    }
    this.peerFingerprint = fingerprintOf(cert)

    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('drain', () => this.pumpBulk())
    socket.on('error', (e: Error) => this.close(e.message))
    socket.on('close', () => this.close('socket closed'))
    this.armIdle()
    this.pingTimer = setInterval(() => this.send({ t: 'ping' }), opts.pingMs ?? DEFAULT_PING_MS)
  }

  /**
   * Sends a message and returns true once it is written. Returns false, without closing the link, when the link is closed
   * or ending (its socket has been ended), or the message cannot be encoded (too large, or a value JSON cannot hold). A peer
   * that holds too much closes the link.
   */
  send(m: Message): boolean {
    // a link that is ending (closeWithNotice) takes nothing after its end: a write then would destroy the socket before the notice is out
    if (this.closed || this.socket.writableEnded) return false
    if (this.socket.writableLength > this.maxBufferedBytes) {
      this.close('slow peer')
      return false
    }
    let frame: Buffer
    try {
      frame = encodeFrame(m)
    } catch {
      return false
    }
    this.socket.write(frame)
    return true
  }

  /**
   * Queues a message for the bulk lane. Its frames are written in turn, on the next turn of the event loop and after each
   * 'drain', while the socket holds less than a chunk, so an interactive message sent meanwhile is written first. A key
   * replaces a queued message with the same key that has not started; one that has started is finished whole.
   * Returns true once the message is queued; false, without closing the link, when the link is closed or the message
   * cannot be encoded. A peer whose queue is full closes the link.
   */
  sendBulk(m: Message, key?: string): boolean {
    // a link that is ending (closeWithNotice) takes no more bulk: nothing may be written after its end
    if (this.closed || this.socket.writableEnded) return false
    let frames: Buffer[]
    try {
      frames = encodeBulkFrames(m)
    } catch {
      return false
    }
    if (key !== undefined) this.dropQueued(key)
    const bytes = frames.reduce((n, f) => n + f.length, 0)
    if (this.queuedBytes + bytes > this.maxQueuedBulkBytes) {
      this.close('slow peer')
      return false
    }
    this.bulk.push({ frames, key, started: false })
    this.queuedBytes += bytes
    if (!this.pumpQueued) {
      this.pumpQueued = true
      setImmediate(() => {
        this.pumpQueued = false
        this.pumpBulk()
      })
    }
    return true
  }

  /** What waits in the socket, unsent, in bytes. */
  backlog(): number {
    return this.socket.writableLength
  }

  /** Sets the largest frame accepted from now on. A link is held to a small frame until the handshake has authenticated it. */
  setMaxFrameBytes(n: number): void {
    this.decoder.setMaxBytes(n)
  }

  /** Closes the link and the socket; 'close' is emitted once, with the first reason. */
  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.clearTimers()
    this.clearBulk()
    this.socket.destroy()
    // reached from socket handlers and timers: a listener that throws must not escape as an uncaught exception
    try {
      this.emit('close', reason)
    } catch {
      // the link is already closed; there is nothing more to do with the error
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    this.armIdle()
    try {
      // each frame is handled before the next one's header is checked: a limit raised by a message applies to what follows
      this.decoder.decodeEach(chunk, (raw) => this.handle(raw))
    } catch (e) {
      this.close(e instanceof FrameError ? e.message : (e as Error).message)
    }
  }

  /** Handles one message from the peer; false once the link has closed, so the rest of the chunk is not read. */
  private handle(raw: unknown): boolean {
    const m = parseMessage(raw)
    if (m === null) {
      this.close('bad message')
      return false
    }
    if (m !== 'unknown') {
      if (m.t === 'ping') {
        this.send({ t: 'pong' })
      } else if (m.t !== 'pong') {
        try {
          this.emit('message', m)
        } catch (e) {
          this.close((e as Error).message)
        }
      }
    }
    return !this.closed
  }

  /** Writes queued bulk frames in turn while the socket holds less than a chunk; the rest waits for 'drain'. */
  private pumpBulk(): void {
    if (this.socket.writableEnded) this.clearBulk()
    while (!this.closed && this.bulk.length > 0 && this.socket.writableLength < BULK_CHUNK_BYTES) {
      const entry = this.bulk[0]
      const frame = entry.frames.shift()!
      entry.started = true
      this.queuedBytes -= frame.length
      if (entry.frames.length === 0) this.bulk.shift()
      this.socket.write(frame)
    }
  }

  private clearBulk(): void {
    this.bulk.length = 0
    this.queuedBytes = 0
  }

  /** Drops the queued message with this key, if it has not started. */
  private dropQueued(key: string): void {
    for (let i = this.bulk.length - 1; i >= 0; i--) {
      const entry = this.bulk[i]
      if (entry.key !== key || entry.started) continue
      this.bulk.splice(i, 1)
      this.queuedBytes -= entry.frames.reduce((n, f) => n + f.length, 0)
    }
  }

  /** Restarts the idle timer: any frame from the peer counts as a sign of life. */
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close('timeout'), this.idleMs)
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.idleTimer = null
    this.pingTimer = null
  }
}
