import { describe, expect, it } from 'vitest'
import { BULK_CHUNK_BYTES, encodeBulkFrames, encodeFrame, FrameDecoder, FrameError, MAX_FRAME_BYTES, PRE_AUTH_FRAME_BYTES, parseMessage, type Message } from '../../src/main/sync/wire'
import { MAX_DEVICE_NAME } from '../../src/shared/devices'
import { MAX_NOTE_LENGTH } from '../../src/shared/note'

const A = '11111111-1111-4111-8111-111111111111'
const S1 = 'a0000000-0000-4000-8000-000000000001'

const hello = { t: 'hello', v: 1, id: A, name: 'Studio', platform: 'windows', port: 47821, addresses: ['10.0.0.2'], reachedYou: null }

describe('wire framing', () => {
  it('frames split across chunks and several frames in one chunk decode in order', () => {
    const a = encodeFrame({ t: 'ping' })
    const b = encodeFrame({ t: 'pong' })
    const c = encodeFrame({ t: 'removed', by: 'Studio' })
    const all = Buffer.concat([a, b, c])
    const decoder = new FrameDecoder()
    const got: unknown[] = []
    for (let i = 0; i < all.length; i += 3) got.push(...decoder.push(all.subarray(i, i + 3)))
    expect(got).toEqual([{ t: 'ping' }, { t: 'pong' }, { t: 'removed', by: 'Studio' }])
    expect(new FrameDecoder().push(Buffer.concat([a, b]))).toEqual([{ t: 'ping' }, { t: 'pong' }])
  })

  it('a declared length over the limit and bad JSON throw FrameError', () => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => new FrameDecoder().push(head)).toThrow(FrameError)

    const body = Buffer.from('{not json', 'utf8')
    const bad = Buffer.concat([Buffer.from([0, 0, 0, body.length]), body])
    expect(() => new FrameDecoder().push(bad)).toThrow(FrameError)
  })

  it('a header that declares a body over the decoder limit throws before the body arrives', () => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(1025, 0)
    const decoder = new FrameDecoder(1024)
    expect(() => decoder.push(head)).toThrow(FrameError)
  })

  it('a frame delivered one byte at a time decodes correctly', () => {
    const all = Buffer.concat([encodeFrame({ t: 'ping' }), encodeFrame({ t: 'removed', by: 'Studio' })])
    const decoder = new FrameDecoder()
    const got: unknown[] = []
    for (let i = 0; i < all.length; i++) got.push(...decoder.push(all.subarray(i, i + 1)))
    expect(got).toEqual([{ t: 'ping' }, { t: 'removed', by: 'Studio' }])
  })

  it('encodeFrame refuses a message larger than the frame limit', () => {
    const text = 'x'.repeat(MAX_FRAME_BYTES)
    const m: Message = { t: 'records', updates: [{ col: 'notes', key: S1, state: { siblings: [{ value: { text, shown: true, form: 'card' }, at: { t: 1, c: 0 }, dot: [A, 1] }], ctx: { [A]: 1 } } }] }
    expect(() => encodeFrame(m)).toThrow(FrameError)
  })
})

describe('parseMessage', () => {
  it('accepts each message type and refuses wrong shapes', () => {
    expect(parseMessage(hello)).toMatchObject({ t: 'hello' })
    expect(parseMessage({ t: 'hello', v: 1, id: 'x', name: 'Studio', platform: 'windows', port: 47821, addresses: [], reachedYou: null })).toBeNull()
    expect(parseMessage({ t: 'records', updates: [{ col: 'stars', key: S1, state: { siblings: [], ctx: { [A]: -1 } } }] })).toBeNull()
    expect(parseMessage({ t: 'records', updates: [{ col: 'nope', key: S1, state: { siblings: [], ctx: {} } }] })).toBeNull()
    expect(parseMessage({ t: 'pair-fail', reason: 'other' })).toBeNull()
    expect(parseMessage({ t: 'future-thing', x: 1 })).toBe('unknown')
    expect(parseMessage([1, 2])).toBeNull()
  })

  it('accepts the remaining message types in their valid shapes', () => {
    const proof = 'a'.repeat(64)
    const ok: unknown[] = [
      { t: 'pair', proof },
      { t: 'pair-ok', proof },
      { t: 'pair-fail', reason: 'expired' },
      { t: 'removed', by: 'Studio' },
      { t: 'sync', seen: { [A]: 3 } },
      { t: 'records', updates: [], done: { seen: { [A]: 3 } } },
      { t: 'ping' },
      { t: 'pong' },
    ]
    for (const v of ok) expect(parseMessage(v), JSON.stringify(v)).not.toBeNull()
    expect(parseMessage({ t: 'records', updates: [] })).toEqual({ t: 'records', updates: [] })
  })

  it('refuses malformed fields of known messages', () => {
    const bad: unknown[] = [
      { ...hello, v: 0 },
      { ...hello, platform: 'amiga' },
      { ...hello, port: 65536 },
      { ...hello, port: 1.5 },
      { ...hello, name: '' },
      { ...hello, name: 'x'.repeat(65) },
      { ...hello, addresses: Array(17).fill('10.0.0.2') },
      { ...hello, addresses: [''] },
      { ...hello, reachedYou: 'yes' },
      { t: 'pair', proof: 'A'.repeat(64) },
      { t: 'pair', proof: 'a'.repeat(63) },
      { t: 'pair-ok', proof: 'z'.repeat(64) },
      { t: 'removed', by: '' },
      { t: 'removed', by: 'x'.repeat(MAX_DEVICE_NAME + 1) },
      { t: 'sync', seen: [] },
      { t: 'sync', seen: { nope: 1 } },
      { t: 'sync', seen: { [A]: 1.5 } },
      { t: 'records', updates: 'x' },
      { t: 'records', updates: [], done: { seen: { [A]: -1 } } },
      { t: 'records', updates: [{ col: 'stars', key: 'nope', state: { siblings: [], ctx: {} } }] },
      { t: 'records', updates: [{ col: 'stars', key: S1 }] },
    ]
    for (const v of bad) expect(parseMessage(v), JSON.stringify(v)).toBeNull()
  })

  it('refuses a version vector with too many entries or an array shape', () => {
    const many: Record<string, number> = {}
    for (let i = 0; i < 1025; i++) many[`11111111-1111-4111-8111-${String(i).padStart(12, '0')}`] = 1
    expect(parseMessage({ t: 'sync', seen: many })).toBeNull()
    expect(parseMessage({ t: 'sync', seen: [] })).toBeNull()
  })

  it('refuses too many updates, siblings, or a sibling with a bad dot or stamp', () => {
    const update = (siblings: unknown[]) => ({ col: 'stars', key: S1, state: { siblings, ctx: {} } })
    const sib = { value: true, at: { t: 1, c: 0 }, dot: [A, 1] }
    expect(parseMessage({ t: 'records', updates: Array(10_001).fill(update([])) })).toBeNull()
    expect(parseMessage({ t: 'records', updates: [update(Array(65).fill(sib))] })).toBeNull()
    expect(parseMessage({ t: 'records', updates: [update([{ ...sib, dot: [A] }])] })).toBeNull()
    expect(parseMessage({ t: 'records', updates: [update([{ ...sib, dot: [A, 0] }])] })).toBeNull()
    expect(parseMessage({ t: 'records', updates: [update([{ ...sib, at: { t: -1, c: 0 } }])] })).toBeNull()
    expect(parseMessage({ t: 'records', updates: [update([{ value: true, at: { t: 1, c: 0 }, dot: [A, 1] }])] })).not.toBeNull()
    expect(parseMessage({ t: 'records', updates: [update([{ at: { t: 1, c: 0 }, dot: [A, 1] }])] })).toBeNull()
  })

  it('keeps only the known fields, so extra and __proto__ keys do not pass through', () => {
    const m = parseMessage(JSON.parse(`{"t":"removed","by":"Studio","__proto__":{"x":1},"extra":true}`)) as Message
    expect(m).toEqual({ t: 'removed', by: 'Studio' })
    expect(Object.keys(m)).toEqual(['t', 'by'])
    const h = parseMessage({ ...hello, extra: 1 }) as Message
    expect(Object.keys(h).sort()).toEqual(['addresses', 'id', 'name', 'platform', 'port', 'reachedYou', 't', 'v'])
  })
})

describe('frame round trip', () => {
  it('a 100 000-character note survives a frame round trip', () => {
    const text = 'ж'.repeat(MAX_NOTE_LENGTH)
    const m: Message = { t: 'records', updates: [{ col: 'notes', key: S1, state: { siblings: [{ value: { text, shown: true, form: 'card' }, at: { t: 1, c: 0 }, dot: [A, 1] }], ctx: { [A]: 1 } } }] }
    expect(parseMessage(new FrameDecoder().push(encodeFrame(m))[0])).toEqual(m)
  })
})

/** a notes update with one sibling: the text is the value */
function noteUpdate(text: string) {
  return { col: 'notes' as const, key: S1, state: { siblings: [{ value: { text, shown: true, form: 'card' }, at: { t: 1, c: 0 }, dot: [A, 1] as [string, number] }], ctx: { [A]: 1 } } }
}

describe('bulk frames', () => {
  it('a message longer than a chunk goes in parts; an ordinary frame between parts comes out first', () => {
    const big: Message = { t: 'records', updates: [noteUpdate('x'.repeat(200 * 1024))] }
    const parts = encodeBulkFrames(big)
    expect(parts).toHaveLength(4)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4 + 1 + BULK_CHUNK_BYTES)
    const d = new FrameDecoder()
    expect(d.push(parts[0])).toEqual([])
    expect(d.push(Buffer.concat([encodeFrame({ t: 'ping' }), parts[1]]))).toEqual([{ t: 'ping' }])
    expect(d.push(Buffer.concat(parts.slice(2)))).toEqual([big])
  })

  it('a message that fits one chunk is one ordinary frame', () => {
    expect(encodeBulkFrames({ t: 'ping' })).toEqual([encodeFrame({ t: 'ping' })])
  })

  it('parts that join to more than MAX_FRAME_BYTES throw FrameError', () => {
    const part = Buffer.alloc(4 + 1 + BULK_CHUNK_BYTES)
    part.writeUInt32BE(1 + BULK_CHUNK_BYTES, 0)
    part[4] = 0x01
    const d = new FrameDecoder()
    expect(() => {
      for (let i = 0; i <= MAX_FRAME_BYTES / BULK_CHUNK_BYTES; i++) d.push(part)
    }).toThrow(FrameError)
  })

  it('parts are held to the decoder limit in force: a decoder held to 100 KiB refuses the second part', () => {
    const part = (marker: number) => {
      const b = Buffer.alloc(4 + 1 + BULK_CHUNK_BYTES)
      b.writeUInt32BE(1 + BULK_CHUNK_BYTES, 0)
      b[4] = marker
      return b
    }
    const d = new FrameDecoder(100 * 1024)
    expect(d.push(part(0x01))).toEqual([])
    expect(() => d.push(part(0x02))).toThrow(new FrameError('message too large'))
  })

  it('a part is accepted only in the shape the encoder makes', () => {
    const part = (marker: number, bytes: number) => {
      const b = Buffer.alloc(4 + 1 + bytes)
      b.writeUInt32BE(1 + bytes, 0)
      b[4] = marker
      return b
    }
    const bad = new FrameError('bad message')
    expect(() => new FrameDecoder().push(part(0x01, 0))).toThrow(bad)
    expect(() => new FrameDecoder().push(part(0x02, 0))).toThrow(bad)
    expect(() => new FrameDecoder().push(part(0x01, BULK_CHUNK_BYTES - 1))).toThrow(bad)
    expect(() => new FrameDecoder().push(part(0x02, BULK_CHUNK_BYTES + 1))).toThrow(bad)
  })

  it('a decoder fed many empty parts throws at the first one, so nothing piles up', () => {
    const empty = Buffer.from([0, 0, 0, 1, 0x01])
    const many = Buffer.concat(Array(100_000).fill(empty))
    expect(() => new FrameDecoder(PRE_AUTH_FRAME_BYTES).push(many)).toThrow(new FrameError('bad message'))
  })

  it('before authentication a decoder held to PRE_AUTH_FRAME_BYTES refuses the first part of a bulk message', () => {
    const parts = encodeBulkFrames({ t: 'records', updates: [noteUpdate('x'.repeat(200 * 1024))] })
    expect(() => new FrameDecoder(PRE_AUTH_FRAME_BYTES).push(parts[0])).toThrow(new FrameError('message too large'))
  })

  it('the parts of a 1 MiB message still decode to the message', () => {
    const big: Message = { t: 'records', updates: [noteUpdate('x'.repeat(1024 * 1024))] }
    expect(new FrameDecoder().push(Buffer.concat(encodeBulkFrames(big)))).toEqual([big])
  })

  it('a message whose JSON is over the frame limit cannot be encoded in parts either', () => {
    const m: Message = { t: 'records', updates: [noteUpdate('x'.repeat(MAX_FRAME_BYTES))] }
    expect(() => encodeBulkFrames(m)).toThrow(FrameError)
  })
})

describe('the hello carries the app version', () => {
  it('a hello carries the app version, and a hello without one parses', () => {
    expect(parseMessage({ ...hello, app: '0.18.0' })).toEqual({ ...hello, app: '0.18.0' })
    expect(parseMessage({ ...hello, app: 'x'.repeat(32) })).toEqual({ ...hello, app: 'x'.repeat(32) })
    expect(parseMessage({ ...hello, app: 5 })).not.toHaveProperty('app')
    expect(parseMessage({ ...hello, app: 'x'.repeat(33) })).not.toHaveProperty('app')
    expect(parseMessage({ ...hello, app: '0.18 beta' })).not.toHaveProperty('app')
    expect(parseMessage(hello)).toEqual(hello)
  })
})
