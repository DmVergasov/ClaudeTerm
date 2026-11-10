import { DEVICE_PLATFORMS, MAX_ADDRESS_LENGTH, MAX_DEVICE_NAME, type DevicePlatform } from '../../shared/devices'
import { isUuid } from '../../shared/protocol'
import { COLLECTIONS, type Collection, type KeyState, type RecordUpdate, type Sibling, type VersionVector } from './replica'
import { type RemoteMessage, parseRemoteMessage } from './remote-wire'
import { isPlainObject } from './views'

/** The version of the peer protocol this app speaks; a hello with another version is refused. */
export const PROTOCOL_VERSION = 1

/** The largest frame a peer may send, in bytes; a longer declared length closes the link. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** The largest frame accepted before a peer is authenticated: the hello and the pairing messages are far smaller. */
export const PRE_AUTH_FRAME_BYTES = 64 * 1024

/** The most JSON bytes of a bulk message that one frame carries: a longer message goes in parts of this size. */
export const BULK_CHUNK_BYTES = 64 * 1024

/** The first byte of a bulk part's body: more parts follow. */
const PART_MORE = 0x01
/** The first byte of a bulk part's body: the last part. An ordinary body is a JSON object, so it never starts with either. */
const PART_LAST = 0x02

const HEADER_BYTES = 4
const MAX_ADDRESSES = 16
const MAX_VERSION_ENTRIES = 1024
const MAX_UPDATES = 10_000
const MAX_SIBLINGS = 64
const PROOF_RE = /^[0-9a-f]{64}$/
const PAIR_FAIL_REASONS = ['code', 'expired', 'no-code'] as const

export interface HelloMessage {
  t: 'hello'
  v: number
  id: string
  name: string
  platform: DevicePlatform
  port: number
  addresses: string[]
  reachedYou: boolean | null
  /** 1 when the device speaks the mail protocol; absent from a device that does not */
  mail?: 1
}

export type Message = HelloMessage
  | { t: 'pair'; proof: string }
  | { t: 'pair-ok'; proof: string }
  | { t: 'pair-fail'; reason: (typeof PAIR_FAIL_REASONS)[number] }
  /** `by` is the remover's name, as the group shows it */
  | { t: 'removed'; by: string }
  | { t: 'sync'; seen: VersionVector }
  | { t: 'records'; updates: RecordUpdate[]; done?: { seen: VersionVector } }
  | { t: 'ping' }
  | { t: 'pong' }
  | RemoteMessage

/** A frame that cannot be read: too long, or not JSON. The link closes after one. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/** Frames a message: a 4-byte big-endian body length, then the UTF-8 JSON of the message. */
export function encodeFrame(m: Message): Buffer {
  return frameOf(Buffer.from(JSON.stringify(m), 'utf8'))
}

/**
 * Frames a message for the bulk lane: one ordinary frame when its JSON fits a chunk, otherwise parts. Each part is a frame
 * whose body is a marker byte (more parts follow, or the last one) and up to BULK_CHUNK_BYTES bytes of the JSON.
 */
export function encodeBulkFrames(m: Message): Buffer[] {
  const json = Buffer.from(JSON.stringify(m), 'utf8')
  if (json.length <= BULK_CHUNK_BYTES) return [frameOf(json)]
  if (json.length > MAX_FRAME_BYTES) throw new FrameError('message too large')
  const parts: Buffer[] = []
  for (let at = 0; at < json.length; at += BULK_CHUNK_BYTES) {
    const end = Math.min(at + BULK_CHUNK_BYTES, json.length)
    const marker = Buffer.from([end === json.length ? PART_LAST : PART_MORE])
    parts.push(frameOf(Buffer.concat([marker, json.subarray(at, end)])))
  }
  return parts
}

function frameOf(body: Buffer): Buffer {
  if (body.length > MAX_FRAME_BYTES) throw new FrameError('message too large')
  const frame = Buffer.alloc(HEADER_BYTES + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, HEADER_BYTES)
  return frame
}

/**
 * Reads frames off a stream: a partial frame waits for the next chunk. The body of a frame is read into one buffer,
 * sized from its header once the header is in, so a frame costs one allocation however many chunks it comes in.
 */
export class FrameDecoder {
  private readonly header = Buffer.alloc(HEADER_BYTES)
  private headerFilled = 0
  /** the body of the frame being read; null until its header is in */
  private body: Buffer | null = null
  private bodyFilled = 0
  /** the bodies of the bulk parts read so far, without their marker bytes; null when no bulk message is open */
  private parts: Buffer[] | null = null
  private partsBytes = 0

  constructor(private maxBytes: number = MAX_FRAME_BYTES) {}

  /** Sets the largest body accepted from now on: a header declaring more throws before any of the body is read. */
  setMaxBytes(n: number): void {
    this.maxBytes = n
  }

  /** The parsed JSON of every complete frame in the chunk; throws FrameError on a frame that cannot be read. */
  push(chunk: Buffer): unknown[] {
    const out: unknown[] = []
    this.decodeEach(chunk, (m) => {
      out.push(m)
      return true
    })
    return out
  }

  /**
   * Hands each message of the chunk to `each` as soon as it is complete, before the next frame's header is checked, so a
   * limit that `each` raises applies to the frames after it. Returning false stops the chunk: the rest is not read.
   * Throws FrameError on a frame that cannot be read.
   */
  decodeEach(chunk: Buffer, each: (message: unknown) => boolean): void {
    let at = 0
    while (at < chunk.length) {
      if (this.body === null) {
        const n = Math.min(HEADER_BYTES - this.headerFilled, chunk.length - at)
        chunk.copy(this.header, this.headerFilled, at, at + n)
        this.headerFilled += n
        at += n
        if (this.headerFilled < HEADER_BYTES) break
        const len = this.header.readUInt32BE(0)
        if (len > this.maxBytes) throw new FrameError('message too large')
        this.headerFilled = 0
        this.body = Buffer.alloc(len)
        this.bodyFilled = 0
      }
      // a zero-length body is complete as soon as its header is
      const body = this.body
      const n = Math.min(body.length - this.bodyFilled, chunk.length - at)
      chunk.copy(body, this.bodyFilled, at, at + n)
      this.bodyFilled += n
      at += n
      if (this.bodyFilled === body.length) {
        this.body = null
        // undefined: a bulk part that is not the last; JSON never parses to undefined
        const m = body.length > 0 && (body[0] === PART_MORE || body[0] === PART_LAST) ? this.addPart(body) : parseBody(body)
        if (m !== undefined && !each(m)) return
      }
    }
  }

  /**
   * Adds a bulk part; the joined message is returned with its last part. A part has the shape the encoder makes: a part
   * that is not the last is a full chunk, the last one holds 1 to a chunk. So the parts of a message are bounded in count
   * and size, and the limit is checked on every part.
   */
  private addPart(body: Buffer): unknown {
    const bytes = body.subarray(1)
    const more = body[0] === PART_MORE
    if (more ? bytes.length !== BULK_CHUNK_BYTES : bytes.length < 1 || bytes.length > BULK_CHUNK_BYTES) throw new FrameError('bad message')
    this.partsBytes += bytes.length
    if (this.partsBytes > this.maxBytes) throw new FrameError('message too large')
    if (!this.parts) this.parts = []
    this.parts.push(bytes)
    if (more) return undefined
    const joined = Buffer.concat(this.parts)
    this.parts = null
    this.partsBytes = 0
    return parseBody(joined)
  }
}

function parseBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new FrameError('bad message')
  }
}

/**
 * Checks the shape of a message from a peer and returns a copy holding only its known fields.
 * 'unknown': an object with a type this version does not know, or a part 2 message that fails its check (dropped like
 * an unknown type, so a newer device's value does not close the link). null: a part 1 message that is malformed; the
 * link closes on it. Values inside records are checked later (validSibling in views.ts).
 */
export function parseMessage(v: unknown): Message | 'unknown' | null {
  if (!isPlainObject(v) || typeof v.t !== 'string') return null
  switch (v.t) {
    case 'hello':
      return parseHello(v)
    case 'pair':
    case 'pair-ok': {
      const proof = v.proof
      if (typeof proof !== 'string' || !PROOF_RE.test(proof)) return null
      return { t: v.t, proof }
    }
    case 'pair-fail': {
      const reason = PAIR_FAIL_REASONS.find((r) => r === v.reason)
      return reason ? { t: 'pair-fail', reason } : null
    }
    case 'removed': {
      const by = v.by
      if (typeof by !== 'string' || by.length < 1 || by.length > MAX_DEVICE_NAME) return null
      return { t: 'removed', by }
    }
    case 'sync': {
      const seen = parseVersionVector(v.seen)
      return seen ? { t: 'sync', seen } : null
    }
    case 'records':
      return parseRecords(v)
    case 'ping':
    case 'pong':
      return { t: v.t }
    default:
      return parseRemoteMessage(v) ?? 'unknown'
  }
}

function parseHello(v: Record<string, unknown>): HelloMessage | null {
  const { id, name, platform, port, addresses, reachedYou } = v
  if (!isPositiveSafeInteger(v.v) || !isUuid(id)) return null
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_DEVICE_NAME) return null
  const known = DEVICE_PLATFORMS.find((p) => p === platform)
  if (!known || !isInteger(port, 0, 65535)) return null
  const list = parseStrings(addresses, MAX_ADDRESSES, MAX_ADDRESS_LENGTH)
  if (!list) return null
  if (reachedYou !== null && typeof reachedYou !== 'boolean') return null
  // only mail: 1 counts: a device that sends another value is taken as one that does not speak the mail protocol
  const mail = v.mail === 1 ? { mail: 1 as const } : {}
  return { t: 'hello', v: v.v, id, name, platform: known, port: port as number, addresses: list, reachedYou, ...mail }
}

function parseRecords(v: Record<string, unknown>): Message | null {
  const { updates, done } = v
  if (!Array.isArray(updates) || updates.length > MAX_UPDATES) return null
  const list: RecordUpdate[] = []
  for (const u of updates) {
    const update = parseUpdate(u)
    if (!update) return null
    list.push(update)
  }
  if (done === undefined) return { t: 'records', updates: list }
  if (!isPlainObject(done)) return null
  const seen = parseVersionVector(done.seen)
  return seen ? { t: 'records', updates: list, done: { seen } } : null
}

function parseUpdate(v: unknown): RecordUpdate | null {
  if (!isPlainObject(v)) return null
  const col: Collection | undefined = COLLECTIONS.find((c) => c === v.col)
  const key = v.key
  if (!col || !isUuid(key)) return null
  const state = parseKeyState(v.state)
  return state ? { col, key, state } : null
}

/** One key's state as the network or the replica file saved it: every sibling and the context checked; null when it does not fit. */
export function parseKeyState(v: unknown): KeyState | null {
  if (!isPlainObject(v) || !Array.isArray(v.siblings) || v.siblings.length > MAX_SIBLINGS) return null
  const siblings: Sibling[] = []
  for (const s of v.siblings) {
    const sibling = parseSibling(s)
    if (!sibling) return null
    siblings.push(sibling)
  }
  const ctx = parseVersionVector(v.ctx)
  return ctx ? { siblings, ctx } : null
}

function parseSibling(v: unknown): Sibling | null {
  if (!isPlainObject(v) || !('value' in v)) return null
  const dot = v.dot
  const at = v.at
  if (!Array.isArray(dot) || dot.length !== 2 || !isUuid(dot[0]) || !isPositiveSafeInteger(dot[1])) return null
  if (!isPlainObject(at) || !isNonNegativeSafeInteger(at.t) || !isNonNegativeSafeInteger(at.c)) return null
  return { value: v.value, at: { t: at.t, c: at.c }, dot: [dot[0], dot[1]] }
}

function parseVersionVector(v: unknown): VersionVector | null {
  if (!isPlainObject(v)) return null
  const keys = Object.keys(v)
  if (keys.length > MAX_VERSION_ENTRIES) return null
  const seen: VersionVector = {}
  for (const k of keys) {
    const n = v[k]
    if (!isUuid(k) || !isNonNegativeSafeInteger(n)) return null
    seen[k] = n
  }
  return seen
}

/** A list of strings, each 1 to maxLength characters, at most maxCount of them. */
function parseStrings(v: unknown, maxCount: number, maxLength: number): string[] | null {
  if (!Array.isArray(v) || v.length > maxCount) return null
  const out: string[] = []
  for (const s of v) {
    if (typeof s !== 'string' || s.length < 1 || s.length > maxLength) return null
    out.push(s)
  }
  return out
}

function isInteger(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max
}

function isPositiveSafeInteger(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0
}

function isNonNegativeSafeInteger(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0
}
