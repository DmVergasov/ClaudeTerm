import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallError, Calls, type CallEntry, type CallLink } from '../../src/main/sync/calls'
import { encodeBulkFrames, encodeFrame, FrameDecoder, type Message, parseMessage } from '../../src/main/sync/wire'
import { until } from '../fixtures/sync'

type Sent = [lane: 'send' | 'bulk', key: string | undefined, message: Message]
type Opts = { timeoutMs?: number; maxRunning?: number; serveTimeoutMs?: number }

/**
 * One end of a fake link. What it sends goes through the real encoder, and what arrives at the peer is decoded and checked
 * as the real link checks it: a message the encoder refuses is not sent (false), and a message the parser refuses or does
 * not know never reaches the peer's 'message' listeners. The bytes arrive on the next microtask.
 */
class FakeLink extends EventEmitter {
  peer!: FakeLink
  private readonly decoder = new FrameDecoder()

  constructor(private readonly sent: Sent[]) {
    super()
  }

  send(m: Message): boolean {
    let frame: Buffer
    try {
      frame = encodeFrame(m)
    } catch {
      return false
    }
    this.sent.push(['send', undefined, m])
    this.deliver(frame)
    return true
  }

  sendBulk(m: Message, key?: string): boolean {
    let frames: Buffer[]
    try {
      frames = encodeBulkFrames(m)
    } catch {
      return false
    }
    this.sent.push(['bulk', key, m])
    this.deliver(Buffer.concat(frames))
    return true
  }

  private deliver(bytes: Buffer): void {
    queueMicrotask(() => this.peer.receive(bytes))
  }

  private receive(bytes: Buffer): void {
    for (const raw of this.decoder.push(bytes)) {
      const m = parseMessage(raw)
      if (m !== null && m !== 'unknown') this.emit('message', m)
    }
  }
}

/** two Calls on two fake links: `a` serves handlersA, `b` serves handlersB; `sent` records every message in order */
function fakePair(handlersA: Record<string, CallEntry>, handlersB: Record<string, CallEntry>, optsA: Opts = {}, optsB: Opts = {}) {
  const sent: Sent[] = []
  const linkA = new FakeLink(sent)
  const linkB = new FakeLink(sent)
  linkA.peer = linkB
  linkB.peer = linkA
  const a = new Calls(linkA as unknown as CallLink, handlersA, optsA)
  const b = new Calls(linkB as unknown as CallLink, handlersB, optsB)
  return { a, b, linkA, linkB, sent }
}

const echo: CallEntry = { run: (args) => args }

let unhandled: unknown[] = []
const onUnhandled = (e: unknown) => {
  unhandled.push(e)
}

beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
})

describe('calls', () => {
  it('a call is answered once with what the handler returns', async () => {
    const { b } = fakePair({ echo }, {})
    await expect(b.call('echo', { x: 1 })).resolves.toEqual({ x: 1 })
  })

  it('a refusal comes back with its message; an unknown method is refused', async () => {
    const { b } = fakePair({ echo, refuse: { run: () => { throw new CallError('no such tab') } } }, {})
    await expect(b.call('refuse', {})).rejects.toThrow('no such tab')
    await expect(b.call('nope', {})).rejects.toThrow('unknown call')
  })

  it('a call not answered in time rejects with timeout, and the late answer is ignored', async () => {
    let slowDone = false
    const slow: CallEntry = {
      run: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            slowDone = true
            resolve('late')
          }, 150)
        )
    }
    const { b } = fakePair({ echo, slow }, {})
    const timedOut = expect(b.call('slow', {}, { timeoutMs: 50 })).rejects.toThrow('timeout')
    await timedOut
    await until(() => slowDone)
    await expect(b.call('echo', 7)).resolves.toBe(7)
    expect(unhandled).toEqual([])
  })

  it('closing the link rejects every waiting call with link closed', async () => {
    const { b, linkB } = fakePair({ echo, never: { run: () => new Promise(() => {}) } }, {})
    const waiting = expect(b.call('never', {})).rejects.toThrow('link closed')
    linkB.emit('close', 'x')
    await waiting
    await expect(b.call('echo', {})).rejects.toThrow('link closed')
  })

  it('close() rejects the waiting calls the same way, and later calls reject at once', async () => {
    const { b } = fakePair({ never: { run: () => new Promise(() => {}) } }, {})
    const waiting = expect(b.call('never', {})).rejects.toThrow('link closed')
    b.close()
    await waiting
    await expect(b.call('never', {})).rejects.toThrow('link closed')
  })

  it('a bulk handler answers through the bulk lane with its key; a bulk call goes through it too', async () => {
    const snap: CallEntry = { bulk: true, key: (args) => (args as { id: string }).id, run: () => 'picture' }
    const { b, sent } = fakePair({ snap, echo }, {})
    await expect(b.call('snap', { id: 'k1' })).resolves.toBe('picture')
    expect(sent.find(([, , m]) => m.t === 'reply')!.slice(0, 2)).toEqual(['bulk', 'snap:k1'])
    await b.call('echo', {}, { bulk: true })
    expect(sent.find(([, , m]) => m.t === 'call' && m.m === 'echo')![0]).toBe('bulk')
  })

  it('more calls at once than maxRunning are refused as busy', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const hold: CallEntry = { run: () => gate.then(() => 'done') }
    const { b } = fakePair({ hold, echo }, {}, { maxRunning: 2 })
    const first = b.call('hold', {})
    const second = b.call('hold', {})
    // attached at once: a refusal that arrives before the test awaits it must not count as unhandled
    const third = expect(b.call('hold', {})).rejects.toThrow('busy')
    const fourth = expect(b.call('echo', 1)).rejects.toThrow('busy')
    await third
    await fourth
    release()
    await expect(first).resolves.toBe('done')
    await expect(second).resolves.toBe('done')
    await expect(b.call('echo', 2)).resolves.toBe(2)
  })

  it('a handler that throws something else answers failed, and nothing escapes the listener', async () => {
    const { b } = fakePair({ throws: { run: () => { throw new Error('boom') } } }, {})
    await expect(b.call('throws', {})).rejects.toThrow('failed')
    expect(unhandled).toEqual([])
  })

  // I1: a reply that cannot be encoded is refused; the link is not closed
  it('a reply whose value cannot be encoded is refused as failed, and the next call is served', async () => {
    const bigReply: CallEntry = { run: () => ({ n: BigInt(1) }) }
    const { b } = fakePair({ echo, 'big-reply': bigReply }, {})
    await expect(b.call('big-reply', {})).rejects.toThrow('failed')
    await expect(b.call('echo', 3)).resolves.toBe(3)
  })

  it('a call whose arguments cannot be encoded rejects at once as failed, and nothing is left waiting', async () => {
    const { b, sent } = fakePair({ echo }, {}, {}, { timeoutMs: 2000 })
    await expect(b.call('echo', { n: BigInt(1) })).rejects.toThrow('failed')
    expect(sent).toEqual([])
  })

  // I2: a call always carries its arguments (null when there are none), and a method the wire would refuse is not sent
  it('a call with no arguments reaches the handler as null, and is answered', async () => {
    const probe: CallEntry = { run: (args) => (args === null ? 'null' : typeof args) }
    const { b, sent } = fakePair({ probe }, {})
    await expect(b.call('probe', undefined)).resolves.toBe('null')
    expect(sent.find(([, , m]) => m.t === 'call')![2]).toMatchObject({ a: null })
  })

  it('a method the wire would refuse is refused at once, and nothing is sent', async () => {
    const { b, sent } = fakePair({ echo }, {})
    await expect(b.call('Bad Name', {})).rejects.toThrow('unknown call')
    await expect(b.call('x'.repeat(33), {})).rejects.toThrow('unknown call')
    expect(sent).toEqual([])
  })

  // M2: the calls.ts behaviors that had no test
  it('a refusal longer than 1000 characters arrives cut to 1000', async () => {
    const long: CallEntry = { run: () => { throw new CallError('x'.repeat(1500)) } }
    const { b } = fakePair({ long }, {}, {}, { timeoutMs: 2000 })
    const err = await b.call('long', {}).catch((e: Error) => e)
    expect((err as Error).message).toBe('x'.repeat(1000))
  })

  it('a refusal with an empty message arrives as failed', async () => {
    const empty: CallEntry = { run: () => { throw new CallError('') } }
    const { b } = fakePair({ empty }, {})
    await expect(b.call('empty', {})).rejects.toThrow('failed')
  })

  it('a returned promise that rejects arrives as its message, or failed, and counts down the running calls', async () => {
    const refusing: CallEntry = { run: () => Promise.reject(new CallError('nope')) }
    const crashing: CallEntry = { run: () => Promise.reject(new Error('boom')) }
    const { b } = fakePair({ echo, refusing, crashing }, {}, { maxRunning: 2 })
    await expect(b.call('refusing', {})).rejects.toThrow('nope')
    await expect(b.call('refusing', {})).rejects.toThrow('nope')
    await expect(b.call('crashing', {})).rejects.toThrow('failed')
    await expect(b.call('echo', 5)).resolves.toBe(5)
  })

  it('a handler returning undefined gives null at the caller', async () => {
    const nothing: CallEntry = { run: () => undefined }
    const { b } = fakePair({ nothing }, {})
    await expect(b.call('nothing', {})).resolves.toBeNull()
  })

  it('a bulk entry whose key is null or throws still replies through the bulk lane, with no key', async () => {
    const nullKey: CallEntry = { bulk: true, key: () => null, run: () => 'a' }
    const throwingKey: CallEntry = {
      bulk: true,
      key: () => {
        throw new Error('bad key')
      },
      run: () => 'b'
    }
    const { b, sent } = fakePair({ 'null-key': nullKey, 'throwing-key': throwingKey }, {})
    await expect(b.call('null-key', {})).resolves.toBe('a')
    await expect(b.call('throwing-key', {})).resolves.toBe('b')
    expect(sent.filter(([, , m]) => m.t === 'reply').map(([lane, key]) => [lane, key])).toEqual([
      ['bulk', undefined],
      ['bulk', undefined]
    ])
  })

  it("a bulk entry's refusal goes on the interactive lane", async () => {
    const snap: CallEntry = { bulk: true, run: () => { throw new CallError('no') } }
    const { b, sent } = fakePair({ snap }, {})
    await expect(b.call('snap', {})).rejects.toThrow('no')
    expect(sent.find(([, , m]) => m.t === 'reply')![0]).toBe('send')
  })

  it('a call that arrives after close() is not served', async () => {
    let served = 0
    const count: CallEntry = { run: () => { served++; return 1 } }
    const { a, linkB, sent } = fakePair({ count }, {})
    a.close()
    linkB.send({ t: 'call', id: 1, m: 'count', a: {} })
    await new Promise((r) => setImmediate(r))
    expect(served).toBe(0)
    expect(sent.filter(([, , m]) => m.t === 'reply')).toEqual([])
  })

  it("m 'constructor' is refused with unknown call", async () => {
    const { b } = fakePair({ echo }, {})
    await expect(b.call('constructor', {})).rejects.toThrow('unknown call')
  })

  // M4: a handler that never settles frees its slot after the serving limit
  it('a handler that never settles frees its slot after serveTimeoutMs, and a later call is served', async () => {
    const hang: CallEntry = { run: () => new Promise(() => {}) }
    const { b } = fakePair({ hang, echo }, {}, { maxRunning: 1, serveTimeoutMs: 50 })
    await expect(b.call('hang', {}, { timeoutMs: 20 })).rejects.toThrow('timeout')
    let v: unknown = 'busy'
    const end = Date.now() + 2000
    while (v !== 2 && Date.now() < end) {
      v = await b.call('echo', 2).catch((e: Error) => e.message)
      if (v !== 2) await new Promise((r) => setTimeout(r, 10))
    }
    expect(v).toBe(2)
  })

  // C1: a refusal is a text field, which holds no NUL: the NUL is taken out before the refusal is sent, so the peer keeps it
  it('a refusal holding a NUL reaches the caller without it', async () => {
    const nul: CallEntry = { run: () => { throw new CallError('a\u0000b') } }
    const { b } = fakePair({ nul }, {}, {}, { timeoutMs: 2000 })
    const err = await b.call('nul', {}).catch((e: Error) => e)
    expect((err as Error).message).toBe('ab')
  })

  // C4: a stuck handler holds its slot until the serving limit; a call before it is busy, one after it is served, and the
  // stuck handler's late result is dropped: its caller saw only its own timeout, and no reply is sent for it
  it('a stuck handler holds its slot until the serving limit, and its late result is never sent', async () => {
    let lateDone = false
    const stuck: CallEntry = {
      run: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            lateDone = true
            resolve('late')
          }, 300)
        )
    }
    const { b, sent } = fakePair({ stuck, echo }, {}, { maxRunning: 1, serveTimeoutMs: 150 })
    const stuckCall = b.call('stuck', {}, { timeoutMs: 30 })
    const stuckId = (sent.find(([, , m]) => m.t === 'call' && m.m === 'stuck')![2] as { id: number }).id
    await expect(stuckCall).rejects.toThrow('timeout')
    // the serving limit has not passed: the slot is still held
    await expect(b.call('echo', 1)).rejects.toThrow('busy')
    let v: unknown = 'busy'
    const end = Date.now() + 2000
    while (v !== 2 && Date.now() < end) {
      v = await b.call('echo', 2).catch((e: Error) => e.message)
      if (v !== 2) await new Promise((r) => setTimeout(r, 10))
    }
    expect(v).toBe(2)
    // pin: the second call was served before the stuck handler finished, so the slot was freed at the serving limit
    expect(lateDone).toBe(false)
    await until(() => lateDone)
    await new Promise((r) => setImmediate(r))
    expect(sent.filter(([, , m]) => m.t === 'reply' && m.id === stuckId)).toEqual([])
    expect(unhandled).toEqual([])
  })
})
