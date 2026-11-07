import { once } from 'node:events'
import * as tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { BULK_CHUNK_BYTES, encodeFrame, MAX_FRAME_BYTES, type Message } from '../../src/main/sync/wire'
import { PeerLink } from '../../src/main/sync/peer-link'
import { closeLinkPairs, linkPair, openLinks, openServers, openSockets, testIdentity, until } from '../fixtures/sync'

const A = '11111111-1111-4111-8111-111111111111'
const S1 = 'a0000000-0000-4000-8000-000000000001'

afterEach(closeLinkPairs)

/** A message whose JSON is about `bytes` long: a pong with a padding field the receiver ignores. */
function padded(bytes: number): Message {
  return { t: 'pong', pad: 'x'.repeat(bytes) } as unknown as Message
}

/** A sync message whose JSON is about `bytes` long: the receiver keeps only its known fields. */
function bigSync(bytes: number): Message {
  return { t: 'sync', seen: {}, pad: 'x'.repeat(bytes) } as unknown as Message
}

describe('peer link', () => {
  it("messages go both ways and each side knows the other's fingerprint", async () => {
    const { client, server } = await linkPair()
    const id = await testIdentity()
    const atServer = once(server, 'message') as Promise<[Message]>
    const atClient = once(client, 'message') as Promise<[Message]>

    client.send({ t: 'sync', seen: { '11111111-1111-4111-8111-111111111111': 3 } })
    server.send({ t: 'removed', by: '22222222-2222-4222-8222-222222222222' })

    expect((await atServer)[0]).toEqual({ t: 'sync', seen: { '11111111-1111-4111-8111-111111111111': 3 } })
    expect((await atClient)[0]).toEqual({ t: 'removed', by: '22222222-2222-4222-8222-222222222222' })
    expect(client.peerFingerprint).toBe(id.fingerprint)
    expect(server.peerFingerprint).toBe(id.fingerprint)
    expect(client.outbound).toBe(true)
    expect(server.outbound).toBe(false)
    expect(client.remoteAddress).toBe('127.0.0.1')
  })

  it('pings keep a quiet link open', async () => {
    const { client, server } = await linkPair({ pingMs: 50, idleMs: 400 })
    const closed: string[] = []
    client.on('close', (r: string) => closed.push(r))
    server.on('close', (r: string) => closed.push(r))
    // three idle periods: a link that closed on idle would have closed by now
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(closed).toEqual([])
  })

  it('a link that hears nothing closes', async () => {
    // the other side is paused: it never reads, so it never answers, and it sends no pings of its own
    const idleMs = 400
    const { client, serverSocket } = await linkPair({ pingMs: 50, idleMs }, { pingMs: 60_000, idleMs: 60_000 })
    serverSocket.pause()
    const started = Date.now()
    const [reason] = (await once(client, 'close')) as [string]
    const elapsed = Date.now() - started
    expect(reason).toBe('timeout')
    // not an instant close (the timer must run), and not far past idleMs (timer jitter allowance on shared runners)
    expect(elapsed).toBeGreaterThanOrEqual(idleMs - 50)
    expect(elapsed).toBeLessThanOrEqual(idleMs + 1000)
  })

  it('a close listener that throws does not escape as an uncaught exception', async () => {
    const { client, serverSocket } = await linkPair()
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      const calls: string[] = []
      client.on('close', (r: string) => {
        calls.push(r)
        throw new Error('listener failed')
      })
      // the peer goes away: the client's socket closes and the link closes with 'socket closed'
      const closed = once(serverSocket, 'close')
      serverSocket.destroy()
      await closed
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(calls).toEqual(['socket closed'])
      client.close('again')
      expect(calls).toEqual(['socket closed'])
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it('a malformed frame closes the link; an unknown message type is ignored', async () => {
    const { client, server, clientSocket } = await linkPair()
    const atServer: Message[] = []
    server.on('message', (m: Message) => atServer.push(m))

    clientSocket.write(encodeFrame({ t: 'future-thing' } as unknown as Message))
    client.send({ t: 'ping' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(atServer).toEqual([])

    const closed = once(server, 'close') as Promise<[string]>
    clientSocket.write(encodeFrame({ t: 'pair', proof: 'not-a-proof' } as unknown as Message))
    expect((await closed)[0]).toBe('bad message')
  })

  it('a frame that is not JSON closes the link', async () => {
    const { server, clientSocket } = await linkPair()
    const closed = once(server, 'close') as Promise<[string]>
    const body = Buffer.from('{not json', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    clientSocket.write(Buffer.concat([header, body]))
    expect((await closed)[0]).toBe('bad message')
  })

  it('send after close does nothing and does not throw', async () => {
    const { client, server } = await linkPair()
    const closed = once(client, 'close') as Promise<[string]>
    client.close('bye')
    expect(await closed).toEqual(['bye'])
    expect(() => client.send({ t: 'ping' })).not.toThrow()
    const atServer: Message[] = []
    server.on('message', (m: Message) => atServer.push(m))
    client.send({ t: 'ping' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(atServer).toEqual([])
  })

  it('close emits close once with the first reason', async () => {
    const { client } = await linkPair()
    const reasons: string[] = []
    client.on('close', (r: string) => reasons.push(r))
    client.close('first')
    client.close('second')
    expect(reasons).toEqual(['first'])
  })

  it('a message over the frame limit is refused without closing the link: the next message goes through', async () => {
    const { client, server } = await linkPair()
    const closed: string[] = []
    client.on('close', (r: string) => closed.push(r))
    const atServer = once(server, 'message') as Promise<[Message]>
    expect(client.send(padded(17 * 1024 * 1024))).toBe(false)
    expect(client.send({ t: 'sync', seen: {} })).toBe(true)
    expect((await atServer)[0]).toEqual({ t: 'sync', seen: {} })
    expect(closed).toEqual([])
  })

  it('a message that cannot be encoded (a BigInt) is refused without closing the link, on both lanes', async () => {
    const { client, server } = await linkPair()
    const closed: string[] = []
    client.on('close', (r: string) => closed.push(r))
    const got: Message[] = []
    server.on('message', (m: Message) => got.push(m))
    const bad = { t: 'sync', seen: {}, big: BigInt(1) } as unknown as Message
    expect(client.send(bad)).toBe(false)
    expect(client.sendBulk(bad)).toBe(false)
    expect(client.send({ t: 'sync', seen: {} })).toBe(true)
    await until(() => got.length === 1)
    expect(got).toEqual([{ t: 'sync', seen: {} }])
    expect(closed).toEqual([])
  })

  it('a frame over the limit the link was made with closes it, even under the default limit', async () => {
    const { client, server } = await linkPair({}, { maxFrameBytes: 64 * 1024 })
    const closed = once(server, 'close') as Promise<[string]>
    client.send(bigSync(100 * 1024))
    expect(await closed).toEqual(['message too large'])
  })

  it('setMaxFrameBytes raises the limit: a 1 MiB frame passes once it is raised', async () => {
    const { client, server } = await linkPair({}, { maxFrameBytes: 64 * 1024 })
    server.setMaxFrameBytes(MAX_FRAME_BYTES)
    const atServer = once(server, 'message') as Promise<[Message]>
    client.send(bigSync(1024 * 1024))
    expect((await atServer)[0]).toEqual({ t: 'sync', seen: {} })
  })

  it('a peer that stops reading is dropped as a slow peer', async () => {
    const { client, serverSocket } = await linkPair({ maxBufferedBytes: 64 * 1024 })
    serverSocket.pause()
    const reasons: string[] = []
    client.on('close', (r: string) => reasons.push(r))
    for (let i = 0; i < 400 && reasons.length === 0; i++) client.send(padded(256 * 1024))
    expect(reasons).toEqual(['slow peer'])
  })

  it('a peer without a certificate gets a closed link with reason no certificate', async () => {
    const id = await testIdentity()
    const tlsServer = tls.createServer({ key: id.keyPem, cert: id.certPem, minVersion: 'TLSv1.3' })
    openServers.push(tlsServer)
    tlsServer.listen(0, '127.0.0.1')
    await once(tlsServer, 'listening')
    const port = (tlsServer.address() as { port: number }).port
    const serverSide = once(tlsServer, 'secureConnection') as Promise<[tls.TLSSocket]>
    const clientSocket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
    openSockets.push(clientSocket)
    await once(clientSocket, 'secureConnect')
    const [serverSocket] = await serverSide
    openSockets.push(serverSocket)

    const link = new PeerLink(serverSocket, { outbound: false })
    openLinks.push(link)
    const reasons: string[] = []
    link.on('close', (r: string) => reasons.push(r))
    expect(await once(link, 'close')).toEqual(['no certificate'])
    expect(reasons).toEqual(['no certificate'])
    link.send({ t: 'ping' })
  })
})

/** a records message with one note of this text: a valid update, so the receiver keeps it */
function recordsWith(text: string): Message {
  return { t: 'records', updates: [{ col: 'notes', key: S1, state: { siblings: [{ value: { text, shown: true, form: 'card' }, at: { t: 1, c: 0 }, dot: [A, 1] }], ctx: { [A]: 1 } } }] }
}

/** a records message whose note is about `bytes` long */
function bigRecords(bytes: number): Message {
  return recordsWith('x'.repeat(bytes))
}

/** the texts of the notes in the records messages, in order */
function noteTexts(msgs: Message[]): string[] {
  return msgs.flatMap((m) => (m.t === 'records' ? m.updates : []).map((u) => (u.state.siblings[0].value as { text: string }).text))
}

describe('peer link: two lanes', () => {
  it('an interactive message sent after a large bulk one arrives first', async () => {
    const { client, server } = await linkPair()
    const got: Message[] = []
    server.on('message', (m: Message) => got.push(m))
    client.sendBulk(bigRecords(4 * 1024 * 1024))
    client.send({ t: 'sync', seen: {} })
    await until(() => got.length === 2)
    expect(got.map((m) => m.t)).toEqual(['sync', 'records'])
  })

  it('a bulk backlog larger than maxBufferedBytes does not close the link', async () => {
    const { client, server } = await linkPair({ maxBufferedBytes: 1024 * 1024 })
    const got: Message[] = []
    server.on('message', (m: Message) => got.push(m))
    const closed: string[] = []
    client.on('close', (r: string) => closed.push(r))
    for (let i = 0; i < 8; i++) client.sendBulk(bigRecords(1024 * 1024))
    await until(() => got.length === 8, 15_000)
    expect(closed).toEqual([])
  })

  it('a bulk queue that grows across turns while the peer does not read closes the link as a slow peer', async () => {
    const { client, serverSocket } = await linkPair({ maxQueuedBulkBytes: 2 * 1024 * 1024 })
    serverSocket.pause()
    const closed: string[] = []
    client.on('close', (r: string) => closed.push(r))
    // one 256 KiB message per turn: the socket takes what it can, the rest queues until the limit
    for (let i = 0; i < 200 && closed.length === 0; i++) {
      client.sendBulk(bigRecords(256 * 1024))
      await new Promise((r) => setImmediate(r))
    }
    expect(closed).toEqual(['slow peer'])
  })

  it('the bulk lane writes only while the socket holds less than a chunk: an interactive message overtakes a bulk message already under way', async () => {
    const { client, server, serverSocket } = await linkPair()
    const got: Message[] = []
    server.on('message', (m: Message) => got.push(m))
    serverSocket.pause()
    client.sendBulk(bigRecords(4 * 1024 * 1024))
    // several turns of the event loop: the pump must hold back, so the socket never takes much more than a chunk
    // (one frame is BULK_CHUNK_BYTES + 5 bytes, so a write that starts under a chunk ends under two frames)
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r))
      expect(client.backlog()).toBeLessThanOrEqual(2 * (BULK_CHUNK_BYTES + 5))
    }
    client.send({ t: 'sync', seen: {} })
    serverSocket.resume()
    await until(() => got.length === 2)
    expect(got.map((m) => m.t)).toEqual(['sync', 'records'])
  })

  it('a frame that parseMessage refuses closes the link, and the valid frame after it in the same write is not read', async () => {
    const { server, clientSocket } = await linkPair()
    const got: Message[] = []
    server.on('message', (m: Message) => got.push(m))
    const closed = once(server, 'close') as Promise<[string]>
    // valid JSON that parseMessage refuses (a sync's seen must be an object): the stop in the message handler is what keeps the next frame unread
    const body = Buffer.from(JSON.stringify({ t: 'sync', seen: 5 }), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    clientSocket.write(Buffer.concat([header, body, encodeFrame({ t: 'sync', seen: {} })]))
    expect(await closed).toEqual(['bad message'])
    expect(got).toEqual([])
  })

  it('a keyed bulk message replaces a queued one with the same key; one already started arrives whole', async () => {
    const { client, server, serverSocket } = await linkPair()
    const got: Message[] = []
    server.on('message', (m: Message) => got.push(m))
    // both in the same turn: the first has not started when the second replaces it
    client.sendBulk(recordsWith('first'), 'k')
    client.sendBulk(recordsWith('second'), 'k')
    await until(() => got.length === 1)
    expect(noteTexts(got)).toEqual(['second'])

    serverSocket.pause()
    client.sendBulk(bigRecords(4 * 1024 * 1024), 'k')
    await new Promise((r) => setImmediate(r))
    client.sendBulk(recordsWith('third'), 'k')
    serverSocket.resume()
    await until(() => got.length === 3)
    expect(got[1]).toEqual(bigRecords(4 * 1024 * 1024))
    expect(noteTexts([got[2]])).toEqual(['third'])
  })

  it('backlog() counts what waits in the socket', async () => {
    const { client, serverSocket } = await linkPair()
    serverSocket.pause()
    client.send(bigRecords(2 * 1024 * 1024))
    expect(client.backlog()).toBeGreaterThan(0)
  })

  it('a frame that arrives in the same chunk as a message that raises the limit is checked after the raise', async () => {
    const { server, clientSocket } = await linkPair({}, { maxFrameBytes: 64 * 1024 })
    server.once('message', () => server.setMaxFrameBytes(MAX_FRAME_BYTES))
    const got: Message[] = []
    server.on('message', (m: Message) => got.push(m))
    const closed: string[] = []
    server.on('close', (r: string) => closed.push(r))
    // one write: a small frame, then a frame over the first limit
    clientSocket.write(Buffer.concat([encodeFrame({ t: 'sync', seen: {} }), encodeFrame(bigSync(100 * 1024))]))
    await until(() => got.length === 2)
    expect(got).toEqual([{ t: 'sync', seen: {} }, { t: 'sync', seen: {} }])
    expect(closed).toEqual([])
  })

  it('the same write with no raise closes the link with message too large', async () => {
    const { server, clientSocket } = await linkPair({}, { maxFrameBytes: 64 * 1024 })
    const closed = once(server, 'close') as Promise<[string]>
    clientSocket.write(Buffer.concat([encodeFrame({ t: 'sync', seen: {} }), encodeFrame(bigSync(100 * 1024))]))
    expect(await closed).toEqual(['message too large'])
  })

  // C2: once the socket is ending (closeWithNotice), a send writes nothing after its end: the notice written before it arrives
  it('a send once the socket is ending is refused, and the notice sent before it still reaches the peer', async () => {
    const { client, server, clientSocket } = await linkPair()
    const got: Message[] = []
    server.on('message', (m: Message) => got.push(m))
    const reasons: string[] = []
    client.on('close', (r: string) => reasons.push(r))
    // mirrors closeWithNotice (device-net.ts): a notice, then end(), then close in end's callback
    // a large write still in the socket keeps the end waiting
    client.send(bigSync(8 * 1024 * 1024))
    client.send({ t: 'removed', by: 'Studio' })
    clientSocket.end(() => client.close('removed'))
    expect(client.send({ t: 'pong' })).toBe(false)
    await until(() => got.some((m) => m.t === 'removed'))
    expect(got.find((m) => m.t === 'removed')).toEqual({ t: 'removed', by: 'Studio' })
    await until(() => reasons.length === 1)
    expect(reasons).toEqual(['removed'])
  })
})
