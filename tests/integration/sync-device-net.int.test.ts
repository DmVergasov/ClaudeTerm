import { once } from 'node:events'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_COPY } from '../../src/shared/devices'
import { closeWithNotice, type DeviceNetDeps, DeviceNet, type NetMember } from '../../src/main/sync/device-net'
import { type DeviceIdentity } from '../../src/main/sync/identity'
import { newPairCode, pairProof } from '../../src/main/sync/pair-code'
import type { PeerLink } from '../../src/main/sync/peer-link'
import { encodeFrame, FrameDecoder, type HelloMessage, type Message, PROTOCOL_VERSION } from '../../src/main/sync/wire'
import { identities, until } from '../fixtures/sync'

/** The dial and handshake limits are generous for a slow runner; only the tests about the limits shorten them. */
const FAST = { minRetryMs: 50, maxRetryMs: 200, dialTimeoutMs: 10_000, handshakeMs: 10_000 }
const SHORT_LIMITS = { dialTimeoutMs: 500, handshakeMs: 500 }

const nets: DeviceNet[] = []
const servers: tls.Server[] = []
const sockets: tls.TLSSocket[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(nets.splice(0).map((n) => n.stop()))
  for (const s of sockets.splice(0)) s.destroy()
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
  net: DeviceNet
  members: NetMember[]
  paired: Array<[string, string | null]>
  linked: Array<{ link: PeerLink; hello: HelloMessage }>
  removed: string[]
  reach: Array<[string, boolean | null]>
}

/** a DeviceNet for `id` with a member list the test changes; its hello reports its listening port */
function makeNet(id: DeviceIdentity, members: NetMember[], extra: Partial<DeviceNetDeps> = {}): Harness {
  const paired: Harness['paired'] = []
  const linked: Harness['linked'] = []
  const removed: string[] = []
  const reach: Harness['reach'] = []
  const dn: DeviceNet = new DeviceNet({
    identity: id,
    hello: () => ({ id: id.id, name: 'Studio', platform: 'linux', port: dn.listeningPort() ?? 0, addresses: ['127.0.0.1'] }),
    members: () => members,
    removedBy: () => null,
    addresses: () => ['127.0.0.1'],
    onPaired: (_link, hello, typed) => paired.push([hello.id, typed]),
    onLink: (link, hello) => linked.push({ link, hello }),
    onRemovedNotice: (by) => removed.push(by),
    onReach: (memberId, reached) => reach.push([memberId, reached]),
    onChange: () => {},
    host: '127.0.0.1',
    port: 0,
    now: () => Date.now(),
    timing: FAST,
    ...extra
  })
  nets.push(dn)
  return { net: dn, members, paired, linked, removed, reach }
}

function memberOf(id: DeviceIdentity, port: number, addresses = ['127.0.0.1']): NetMember {
  return { id: id.id, fingerprint: id.fingerprint, addresses, port }
}

/** A raw TLS client with its own identity, for sending messages by hand; every frame it receives is kept. */
async function rawClient(id: DeviceIdentity, port: number): Promise<{ socket: tls.TLSSocket; messages: Message[] }> {
  const socket = tls.connect({ host: '127.0.0.1', port, key: id.keyPem, cert: id.certPem, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
  sockets.push(socket)
  const messages: Message[] = []
  const decoder = new FrameDecoder()
  socket.on('data', (chunk: Buffer) => {
    for (const m of decoder.push(chunk)) messages.push(m as Message)
  })
  socket.on('error', () => {})
  await once(socket, 'secureConnect')
  return { socket, messages }
}

/** A TLS host with `id`'s certificate that runs `onSocket` for each connection; returns its port. */
async function fakeHost(id: DeviceIdentity, onSocket: (s: tls.TLSSocket) => void): Promise<number> {
  const server = tls.createServer({ key: id.keyPem, cert: id.certPem, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
  server.on('secureConnection', (s: tls.TLSSocket) => {
    sockets.push(s)
    s.on('error', () => {})
    onSocket(s)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as net.AddressInfo).port
}

function helloOf(id: DeviceIdentity): HelloMessage {
  return { t: 'hello', v: PROTOCOL_VERSION, id: id.id, name: 'Raw', platform: 'linux', port: 0, addresses: [], reachedYou: null }
}

/** two devices that know each other with their real ports, both listening and updated */
async function pairOfMembers(a: DeviceIdentity, b: DeviceIdentity): Promise<{ hA: Harness; hB: Harness }> {
  const hA = makeNet(a, [])
  const hB = makeNet(b, [])
  await hA.net.startPairing()
  await hB.net.startPairing()
  hA.members.push(memberOf(b, hB.net.listeningPort()!))
  hB.members.push(memberOf(a, hA.net.listeningPort()!))
  hA.net.update()
  hB.net.update()
  return { hA, hB }
}

/**
 * Waits until both sides keep the same link. In pairOfMembers both dial at once, and each side keeps the first link it
 * authenticates until the other one comes; in the end both keep the link the device with the lower id dialed
 * (DeviceNet.keep). A message sent before that can go on a link the other side drops, and is not heard.
 */
async function sameLink(hA: Harness, a: DeviceIdentity, hB: Harness, b: DeviceIdentity): Promise<void> {
  const aDialed = a.id < b.id
  await until(() => {
    const [la, lb] = [hA.net.links(), hB.net.links()]
    return la.length === 1 && lb.length === 1 && la[0].outbound === aDialed && lb[0].outbound === !aDialed
  })
}

describe('DeviceNet: listening', () => {
  it('listens only while it has members or shows a code', async () => {
    const [a] = await identities(1)
    const h = makeNet(a, [])
    expect(h.net.listeningPort()).toBeNull()
    await h.net.startPairing()
    expect(h.net.listeningPort()).toBeGreaterThan(0)
    h.net.cancelPairing()
    expect(h.net.listeningPort()).toBeNull()
  })

  it('a port in use is reported as a problem, not thrown', async () => {
    const [a] = await identities(1)
    const holder = net.createServer()
    servers.push(holder as unknown as tls.Server)
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()))
    const port = (holder.address() as net.AddressInfo).port
    const h = makeNet(a, [], { port })
    const view = await h.net.startPairing()
    expect(view.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
    expect(h.net.problem()).toBe(DEVICE_COPY.portInUse(port))
    expect(h.net.listeningPort()).toBeNull()
  })

  it('a listener refused by the system (EACCES) is reported like a port in use', async () => {
    const [a] = await identities(1)
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server) {
      process.nextTick(() => this.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })))
      return this
    } as never)
    const h = makeNet(a, [], { port: 47999 })
    await h.net.startPairing()
    expect(h.net.problem()).toBe(DEVICE_COPY.portInUse(47999))
    expect(h.net.listeningPort()).toBeNull()
  })
})

describe('DeviceNet: pairing', () => {
  it('the code lists the addresses the group gives this device, not every address of the machine', async () => {
    const [a] = await identities(1)
    const h = makeNet(a, [], { addresses: () => ['127.0.0.1'] })
    const view = await h.net.startPairing()
    expect(view.addresses).toEqual(['127.0.0.1'])
  })

  it('pairs with the right code; both sides learn the other; the code is used up', async () => {
    const [a, b, c, d] = await identities(4)
    // A keeps listening after the code is used because it has a member (D) that is not reachable
    const hA = makeNet(a, [memberOf(d, 1)])
    const hB = makeNet(b, [])
    const hC = makeNet(c, [])
    const view = await hA.net.startPairing()
    expect(await hB.net.join(`127.0.0.1:${hA.net.listeningPort()}`, view.code.toLowerCase())).toEqual({ ok: true })
    expect(hA.paired).toEqual([[b.id, null]])
    expect(hB.paired).toEqual([[a.id, `127.0.0.1:${hA.net.listeningPort()}`]])
    expect(hA.net.pairing()).toBeNull()
    expect(await hC.net.join(`127.0.0.1:${hA.net.listeningPort()}`, view.code)).toEqual({ ok: false, error: DEVICE_COPY.joinNoCode })
  })

  it('a wrong code is refused; after five the code is cancelled', async () => {
    const [a, b, d] = await identities(3)
    const hA = makeNet(a, [memberOf(d, 1)])
    const view = await hA.net.startPairing()
    const wrong = await newWrongCode(view.code)
    const hB = makeNet(b, [])
    for (let i = 0; i < 5; i++) {
      expect(await hB.net.join(`127.0.0.1:${hA.net.listeningPort()}`, wrong)).toEqual({ ok: false, error: DEVICE_COPY.joinBadCode })
    }
    expect(hA.net.pairing()).toBeNull()
    expect(await hB.net.join(`127.0.0.1:${hA.net.listeningPort()}`, view.code)).toEqual({ ok: false, error: DEVICE_COPY.joinNoCode })
    expect(hA.paired).toEqual([])
  })

  it('an expired code is refused', async () => {
    const [a, b, d] = await identities(3)
    let now = 1_000_000
    const hA = makeNet(a, [memberOf(d, 1)], { now: () => now })
    const view = await hA.net.startPairing()
    now = view.expiresAt + 1
    const hB = makeNet(b, [])
    expect(await hB.net.join(`127.0.0.1:${hA.net.listeningPort()}`, view.code)).toEqual({ ok: false, error: DEVICE_COPY.joinBadCode })
    expect(hA.paired).toEqual([])
  })

  it('a proof made for other fingerprints is refused with the code reason', async () => {
    const [a, b, d, other] = await identities(4)
    const hA = makeNet(a, [memberOf(d, 1)])
    const view = await hA.net.startPairing()
    const client = await rawClient(b, hA.net.listeningPort()!)
    client.socket.write(encodeFrame(helloOf(b)))
    client.socket.write(encodeFrame({ t: 'pair', proof: pairProof(view.code, 'join', other.fingerprint, b.fingerprint) }))
    await until(() => client.messages.some((m) => m.t === 'pair-fail'))
    expect(client.messages).toContainEqual({ t: 'pair-fail', reason: 'code' })
    expect(hA.paired).toEqual([])
  })

  it('a device refuses to pair with itself: the code stays up and nothing is paired', async () => {
    const [a] = await identities(1)
    const h = makeNet(a, [])
    const view = await h.net.startPairing()
    const result = await h.net.join(`127.0.0.1:${h.net.listeningPort()}`, view.code)
    expect(result.ok).toBe(false)
    expect(h.paired).toEqual([])
    expect(h.net.pairing()).not.toBeNull()
  })

  it('a host that claims this device\'s own id is not paired with', async () => {
    const [b, x] = await identities(2)
    const code = newPairCode()
    const port = await fakeHost(x, (s) => {
      s.write(encodeFrame(helloOf(b)))
      s.write(encodeFrame({ t: 'pair-ok', proof: pairProof(code, 'accept', x.fingerprint, b.fingerprint) }))
    })
    const hB = makeNet(b, [])
    expect((await hB.net.join(`127.0.0.1:${port}`, code)).ok).toBe(false)
    expect(hB.paired).toEqual([])
  })

  it('a host whose pair-ok proof is wrong is not paired with: the join says it could not prove the code', async () => {
    const [b, x] = await identities(2)
    const port = await fakeHost(x, (s) => {
      s.write(encodeFrame(helloOf(x)))
      s.write(encodeFrame({ t: 'pair-ok', proof: '0'.repeat(64) }))
    })
    const hB = makeNet(b, [])
    expect(await hB.net.join(`127.0.0.1:${port}`, newPairCode())).toEqual({ ok: false, error: DEVICE_COPY.joinNotProved })
    expect(hB.paired).toEqual([])
    expect(hB.linked).toEqual([])
  })

  it('nothing answers: the join says so', async () => {
    const [b] = await identities(1)
    const hB = makeNet(b, [])
    expect(await hB.net.join('127.0.0.1:1', newPairCode())).toEqual({ ok: false, error: DEVICE_COPY.joinNoAnswer })
  })

  it('a typed code that does not normalize is refused without dialing', async () => {
    const [b] = await identities(1)
    const hB = makeNet(b, [])
    expect(await hB.net.join('127.0.0.1:1', 'not-a-code')).toEqual({ ok: false, error: DEVICE_COPY.joinBadCode })
  })

  it('an address that is not an address is not dialed: nothing answers', async () => {
    const [b] = await identities(1)
    const hB = makeNet(b, [])
    expect(await hB.net.join('host:0', newPairCode())).toEqual({ ok: false, error: DEVICE_COPY.joinNoAnswer })
  })
})

describe('DeviceNet: member links', () => {
  it('members connect to each other; a certificate that is not a member is closed', async () => {
    const [a, b, c] = await identities(3)
    const { hA, hB } = await pairOfMembers(a, b)
    await until(() => hA.linked.length >= 1 && hB.linked.length >= 1)
    expect(hA.linked[0].hello.id).toBe(b.id)
    expect(hB.linked[0].hello.id).toBe(a.id)
    expect(hA.net.state(b.id)).toEqual({ kind: 'connected' })

    hA.net.cancelPairing()
    const before = hA.linked.length
    const stranger = await rawClient(c, hA.net.listeningPort()!)
    const closed = once(stranger.socket, 'close')
    stranger.socket.write(encodeFrame(helloOf(c)))
    await closed
    expect(hA.linked).toHaveLength(before)
  })

  it('a device presenting another member\'s id with its own certificate is not linked', async () => {
    const [a, b, c] = await identities(3)
    const hA = makeNet(a, [memberOf(b, 1)])
    await hA.net.startPairing()
    const client = await rawClient(c, hA.net.listeningPort()!)
    const closed = once(client.socket, 'close')
    client.socket.write(encodeFrame({ ...helloOf(c), id: b.id }))
    await Promise.race([closed, sleep(2600)])
    expect(hA.linked).toEqual([])
    expect(hA.net.links()).toEqual([])
  })

  it('a member address answered with another certificate is not linked', async () => {
    const [a, b, x] = await identities(3)
    const port = await fakeHost(x, (s) => s.write(encodeFrame(helloOf(b))))
    const h = makeNet(a, [{ id: b.id, fingerprint: b.fingerprint, addresses: ['127.0.0.1'], port }])
    h.net.update()
    await until(() => h.net.state(b.id).kind === 'unreachable')
    expect(h.linked).toEqual([])
    expect(h.net.state(b.id).kind).not.toBe('connected')
  })

  it('when both dial at once one link is kept, and it is the same connection on both sides', async () => {
    const [a, b] = await identities(2)
    const { hA, hB } = await pairOfMembers(a, b)
    await until(() => hA.linked.length >= 1 && hB.linked.length >= 1)
    await sameLink(hA, a, hB, b)
    const onB = once(hB.net.links()[0], 'message') as Promise<[Message]>
    hA.net.links()[0].send({ t: 'sync', seen: {} })
    expect((await onB)[0]).toEqual({ t: 'sync', seen: {} })
  })

  it('a second link from the same dialer replaces the first: the first closes as a duplicate and the newer one is kept', async () => {
    const [a, b] = await identities(2)
    const hA = makeNet(a, [memberOf(b, 1)])
    hA.net.update()
    await until(() => hA.net.listeningPort() !== null)
    const port = hA.net.listeningPort()!
    const first = await rawClient(b, port)
    first.socket.write(encodeFrame(helloOf(b)))
    await until(() => hA.linked.length === 1)
    const firstClosed = once(first.socket, 'close')
    const second = await rawClient(b, port)
    second.socket.write(encodeFrame(helloOf(b)))
    await until(() => hA.linked.length === 2)
    await firstClosed
    expect(hA.net.links()).toHaveLength(1)
    expect(hA.net.links()[0]).toBe(hA.linked[1].link)
  })

  it('a removed device is told by whom and closed', async () => {
    const [a, b] = await identities(2)
    const hA = makeNet(a, [], { removedBy: (fp) => (fp === b.fingerprint ? 'Studio' : null) })
    const hB = makeNet(b, [])
    await hA.net.startPairing()
    hB.members.push(memberOf(a, hA.net.listeningPort()!))
    hB.net.update()
    await until(() => hB.removed.length === 1)
    expect(hB.removed).toEqual(['Studio'])
    expect(hA.linked).toEqual([])
  })

  it('a member removed while linked is told by name before its link closes', async () => {
    const [a, b] = await identities(2)
    let removedName: string | null = null
    const membersA: NetMember[] = []
    const hA = makeNet(a, membersA, { removedBy: (fp) => (fp === b.fingerprint ? removedName : null) })
    const hB = makeNet(b, [])
    await hA.net.startPairing()
    await hB.net.startPairing()
    membersA.push(memberOf(b, hB.net.listeningPort()!))
    hB.members.push(memberOf(a, hA.net.listeningPort()!))
    hA.net.update()
    hB.net.update()
    await until(() => hA.linked.length >= 1 && hB.linked.length >= 1)
    removedName = 'Studio'
    membersA.length = 0
    hA.net.update()
    await until(() => hB.removed.length >= 1)
    expect(hB.removed[0]).toBe('Studio')
  })

  it('a removed notice that arrives on a member link reaches onRemovedNotice', async () => {
    const [a, b] = await identities(2)
    const { hA, hB } = await pairOfMembers(a, b)
    await sameLink(hA, a, hB, b)
    hA.net.links()[0].send({ t: 'removed', by: 'Studio' })
    await until(() => hB.removed.length === 1)
    expect(hB.removed).toEqual(['Studio'])
  })

  it('a bulk message queued just before the link is closed with a notice is not written after the end: the peer gets the notice and the link closes with its reason', async () => {
    const [a, b] = await identities(2)
    const { hA, hB } = await pairOfMembers(a, b)
    await until(() => hA.net.links().length === 1 && hB.net.links().length === 1)
    const link = hA.net.links()[0]
    const reasons: string[] = []
    link.on('close', (r: string) => reasons.push(r))
    // a large write still in the socket keeps the end waiting, so a bulk write queued now is due while the link is ending
    link.send({ t: 'sync', seen: {}, pad: 'x'.repeat(8 * 1024 * 1024) } as unknown as Message)
    link.sendBulk({ t: 'sync', seen: {}, pad: 'x'.repeat(1024 * 1024) } as unknown as Message)
    closeWithNotice(link, { t: 'removed', by: 'Studio' }, 'removed')
    await until(() => hB.removed.length === 1)
    expect(hB.removed).toEqual(['Studio'])
    await until(() => reasons.length === 1)
    expect(reasons).toEqual(['removed'])
  })

  it('a dial in progress does not link a member the group removed meanwhile', async () => {
    const [a, f] = await identities(2)
    const fake: { socket: tls.TLSSocket | null } = { socket: null }
    const port = await fakeHost(f, (s) => {
      fake.socket = s
    })
    const members: NetMember[] = [memberOf(f, port)]
    const h = makeNet(a, members)
    h.net.update()
    await until(() => fake.socket !== null)
    members.length = 0
    h.net.update()
    fake.socket!.write(encodeFrame(helloOf(f)))
    await sleep(300)
    expect(h.linked).toEqual([])
    expect(h.net.links()).toEqual([])
  })

  it('reconnects after the other side comes back; meanwhile it is offline', async () => {
    const [a, b] = await identities(2)
    const { hA, hB } = await pairOfMembers(a, b)
    const portB = hB.net.listeningPort()!
    await until(() => hA.net.state(b.id).kind === 'connected')
    await hB.net.stop()
    await until(() => hA.net.state(b.id).kind === 'offline')
    // B cannot dial A (A is at port 1 in its list): only A's retry can bring the link back
    const hB2 = makeNet(b, [memberOf(a, 1)], { port: portB })
    hB2.net.update()
    await until(() => hA.net.state(b.id).kind === 'connected')
  })

  it('a member it cannot reach is shown with the address it tried', async () => {
    const [a, b] = await identities(2)
    const h = makeNet(a, [memberOf(b, 1)])
    h.net.update()
    await until(() => h.net.state(b.id).kind === 'unreachable')
    expect(h.net.state(b.id)).toEqual({ kind: 'unreachable', address: '127.0.0.1:1' })
  })

  it('the hello tells whether this side could reach the other', async () => {
    const [a, b] = await identities(2)
    const hA = makeNet(a, [])
    const hB = makeNet(b, [])
    await hA.net.startPairing()
    await hB.net.startPairing()
    // B dials A at a port nobody listens on: B cannot reach A
    hB.members.push(memberOf(a, 1))
    hB.net.update()
    await until(() => hB.net.state(a.id).kind === 'unreachable')
    // A dials B: B's hello tells A that B could not reach it
    hA.members.push(memberOf(b, hB.net.listeningPort()!))
    hA.net.update()
    await until(() => hA.reach.some(([id]) => id === b.id))
    expect(hA.reach).toContainEqual([b.id, false])
  })

  it('a hello with another protocol version closes the link', async () => {
    const [a, b] = await identities(2)
    const hA = makeNet(a, [memberOf(b, 1)])
    await hA.net.startPairing()
    const client = await rawClient(b, hA.net.listeningPort()!)
    const closed = once(client.socket, 'close')
    client.socket.write(encodeFrame({ ...helloOf(b), v: PROTOCOL_VERSION + 1 }))
    await closed
    expect(hA.linked).toEqual([])
  })

  it('an accepting side reports a member that dials in', async () => {
    const [a, b] = await identities(2)
    let changes = 0
    const hA = makeNet(a, [memberOf(b, 1)], { onChange: () => changes++ })
    await hA.net.startPairing()
    const hB = makeNet(b, [memberOf(a, hA.net.listeningPort()!)])
    const before = changes
    hB.net.update()
    await until(() => hA.linked.length >= 1)
    expect(changes).toBeGreaterThan(before)
  })
})

describe('DeviceNet: retries and wake', () => {
  it('an update that changes nothing keeps the retry schedule', async () => {
    const [a, b] = await identities(2)
    let changes = 0
    const h = makeNet(a, [memberOf(b, 1)], { onChange: () => changes++, timing: { ...FAST, minRetryMs: 60_000, maxRetryMs: 60_000 } })
    h.net.update()
    await until(() => h.net.state(b.id).kind === 'unreachable')
    const before = changes
    h.net.update()
    await sleep(200)
    // the update's own notice only: no dial round ran
    expect(changes).toBe(before + 1)
  })

  it('wake dials a member that was down, without waiting out the retry', async () => {
    const [a, b] = await identities(2)
    const probe = makeNet(b, [])
    const portB = await probe.net.startPairing().then(() => probe.net.listeningPort()!)
    await probe.net.stop()
    const hA = makeNet(a, [memberOf(b, portB)], { timing: { ...FAST, minRetryMs: 60_000, maxRetryMs: 60_000 } })
    hA.net.update()
    await sleep(100)
    // B comes up now; its own list has A at port 1, so only A's wake can connect them
    const hB = makeNet(b, [memberOf(a, 1)], { port: portB })
    hB.net.update()
    await sleep(300)
    expect(hA.net.state(b.id).kind).not.toBe('connected')
    hA.net.wake()
    await until(() => hA.net.state(b.id).kind === 'connected', 2000)
  })

  it('failed dials back off: the wait between attempts grows', async () => {
    const [a, b] = await identities(2)
    let rounds = 0
    const h = makeNet(a, [memberOf(b, 1)], { onChange: () => rounds++, timing: { ...FAST, minRetryMs: 50, maxRetryMs: 400 } })
    h.net.update()
    await sleep(2000)
    // a fixed 50 ms rhythm would make about 40 attempts in this window; backing off makes about 8
    expect(rounds).toBeGreaterThanOrEqual(3)
    expect(rounds).toBeLessThan(20)
  })

  it('a dial round that throws counts as a failed attempt and schedules a retry', async () => {
    const [a] = await identities(1)
    let changes = 0
    const broken = { id: '55555555-5555-4555-8555-555555555555', fingerprint: 'f'.repeat(64), addresses: undefined, port: 1 } as unknown as NetMember
    const h = makeNet(a, [broken], { onChange: () => changes++ })
    h.net.update()
    await until(() => changes >= 3, 2000)
    expect(h.net.state(broken.id).kind).toBe('unknown')
  })
})

describe('DeviceNet: handshake limits', () => {
  it('a peer that goes silent is given up on: the join answers that nothing answers, within the limit', async () => {
    const [b] = await identities(1)
    const silent = tls.createServer({ key: b.keyPem, cert: b.certPem, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' })
    silent.on('secureConnection', (s: tls.TLSSocket) => sockets.push(s))
    servers.push(silent)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    const port = (silent.address() as net.AddressInfo).port
    const hB = makeNet(b, [], { timing: { ...FAST, ...SHORT_LIMITS } })
    const started = Date.now()
    expect(await hB.net.join(`127.0.0.1:${port}`, newPairCode())).toEqual({ ok: false, error: DEVICE_COPY.joinNoAnswer })
    expect(Date.now() - started).toBeLessThan(SHORT_LIMITS.handshakeMs + 3000)
  })

  it('a message out of order closes the link', async () => {
    const [a, b, d] = await identities(3)
    const hA = makeNet(a, [memberOf(d, 1)])
    await hA.net.startPairing()
    const client = await rawClient(b, hA.net.listeningPort()!)
    const closed = once(client.socket, 'close')
    client.socket.write(encodeFrame({ t: 'pair', proof: '0'.repeat(64) }))
    await closed
    expect(hA.paired).toEqual([])
  })
})

describe('DeviceNet: before authentication', () => {
  it('a part 2 call sent before authentication closes the link: no link or pairing is made', async () => {
    const [a, c] = await identities(2)
    const hA = makeNet(a, [])
    await hA.net.startPairing()
    const client = await rawClient(c, hA.net.listeningPort()!)
    let closed = false
    client.socket.on('close', () => {
      closed = true
    })
    client.socket.write(encodeFrame({ t: 'call', id: 1, m: 'attach', a: {} } as unknown as Message))
    await until(() => closed, 3000)
    expect(hA.linked).toEqual([])
    expect(hA.paired).toEqual([])
  })

  it('a device that is not a member cannot send a frame over 64 KiB: its link closes at once', async () => {
    const [a, c] = await identities(2)
    // the handshake limit is long, so a link that stays open is not the handshake timeout
    const hA = makeNet(a, [], { timing: { ...FAST, handshakeMs: 10_000 } })
    await hA.net.startPairing()
    const client = await rawClient(c, hA.net.listeningPort()!)
    let closed = false
    client.socket.on('close', () => {
      closed = true
    })
    client.socket.write(encodeFrame({ ...helloOf(c), pad: 'x'.repeat(100 * 1024) } as unknown as Message))
    await until(() => closed, 3000)
    expect(hA.paired).toEqual([])
    expect(hA.linked).toEqual([])
  })

  it('a dialed link refuses a frame over 64 KiB before the member has authenticated', async () => {
    const [b, x] = await identities(2)
    const port = await fakeHost(x, (s) => {
      s.write(encodeFrame({ ...helloOf(x), pad: 'x'.repeat(100 * 1024) } as unknown as Message))
    })
    const hB = makeNet(b, [], { timing: { ...FAST, handshakeMs: 10_000 } })
    let settled = false
    const result = hB.net.join(`127.0.0.1:${port}`, newPairCode()).then((r) => {
      settled = true
      return r
    })
    await until(() => settled, 3000)
    expect(await result).toEqual({ ok: false, error: DEVICE_COPY.joinNoAnswer })
    expect(hB.paired).toEqual([])
  })

  it('after authentication a member link accepts a 1 MiB frame', async () => {
    const [a, b] = await identities(2)
    const { hA, hB } = await pairOfMembers(a, b)
    await sameLink(hA, a, hB, b)
    const atB = once(hB.net.links()[0], 'message') as Promise<[Message]>
    hA.net.links()[0].send({ t: 'sync', seen: {}, pad: 'x'.repeat(1024 * 1024) } as unknown as Message)
    expect((await atB)[0]).toEqual({ t: 'sync', seen: {} })
  })

  it('a TCP connection that never starts TLS is closed within the handshake limit', async () => {
    const [a] = await identities(1)
    const h = makeNet(a, [], { timing: { ...FAST, ...SHORT_LIMITS } })
    await h.net.startPairing()
    const raw = net.connect(h.net.listeningPort()!, '127.0.0.1')
    raw.on('error', () => {})
    let closed = false
    raw.on('close', () => {
      closed = true
    })
    try {
      await once(raw, 'connect')
      await until(() => closed, SHORT_LIMITS.handshakeMs + 3000)
    } finally {
      raw.destroy()
    }
  })

  it('at most 16 unauthenticated connections are held: the 17th is closed at once, the others wait out the handshake, and a freed slot holds the next', async () => {
    const [a, c] = await identities(2)
    // this test waits out the handshake limit itself; the marker step is a TLS handshake that must finish within it too
    const h = makeNet(a, [], { timing: { ...FAST, handshakeMs: 5000 } })
    await h.net.startPairing()
    const port = h.net.listeningPort()!
    const raws: net.Socket[] = []
    const closed: boolean[] = []
    try {
      for (let i = 0; i < 17; i++) {
        const s = net.connect(port, '127.0.0.1')
        raws.push(s)
        s.on('error', () => {})
        closed.push(false)
        const index = i
        s.on('close', () => {
          closed[index] = true
        })
        await Promise.race([once(s, 'connect'), once(s, 'close')])
      }
      await until(() => closed[16], 4000)
      // the first 16 are still inside their handshake time
      expect(closed.slice(0, 16)).toEqual(Array(16).fill(false))
      await until(() => closed.slice(0, 16).every(Boolean), 15_000)
      // the 16 slots are free again: one more raw connection is held, not closed at once
      const late = net.connect(port, '127.0.0.1')
      raws.push(late)
      late.on('error', () => {})
      let lateClosed = false
      late.on('close', () => {
        lateClosed = true
      })
      await once(late, 'connect')
      // the marker step: a TLS handshake on the same listener, completed only by a server that accepts connections
      const marker = await rawClient(c, port)
      expect(marker.socket.destroyed).toBe(false)
      expect(lateClosed).toBe(false)
    } finally {
      for (const s of raws) s.destroy()
    }
  })
})

describe('DeviceNet: stopping', () => {
  it('stop closes everything, cancels pairing, and resolves once the server has closed', async () => {
    const [a, b] = await identities(2)
    const hA = makeNet(a, [])
    const hB = makeNet(b, [])
    const view = await hA.net.startPairing()
    expect(view.port).toBeGreaterThan(0)
    await hA.net.stop()
    expect(hA.net.listeningPort()).toBeNull()
    expect(hA.net.pairing()).toBeNull()
    expect(await hB.net.join(`127.0.0.1:${view.port}`, view.code)).toEqual({ ok: false, error: DEVICE_COPY.joinNoAnswer })
  })
})

/** a valid code that is not `code` */
async function newWrongCode(code: string): Promise<string> {
  for (;;) {
    const candidate = newPairCode()
    if (candidate !== code) return candidate
  }
}
