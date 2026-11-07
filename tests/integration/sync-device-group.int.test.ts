import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Vault } from '../../src/main/accounts'
import { DeviceGroup, type DeviceGroupDeps } from '../../src/main/sync/device-group'
import { PeerLink, type PeerLinkOptions } from '../../src/main/sync/peer-link'
import { type RecordUpdate, type Replica, type ReplicaData, SEQ_RESERVE } from '../../src/main/sync/replica'
import { memberOf, noteOf, starOf } from '../../src/main/sync/views'
import type { HelloMessage, Message } from '../../src/main/sync/wire'
import { DEVICE_COPY, type DevicePlatform, REMOVAL_NOTICE_MS } from '../../src/shared/devices'
import { fakeVault, tempDir, until } from '../fixtures/sync'

const S1 = '6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b'
const S2 = '7a2d3b4f-5c6e-4f80-9b0c-1d2e3f4a5b6c'
const TIMING = { minRetryMs: 50, maxRetryMs: 200, dialTimeoutMs: 2000, handshakeMs: 2000 }

interface Sink {
  data: RecordUpdate[][]
  warns: string[]
  errors: string[]
  resets: number
  /** how many times the group's view has been reported */
  views: number
}

interface OpenOptions {
  dir?: string
  sink?: Sink
  vault?: Vault
  addresses?: () => string[]
  /** the port the group listens on; 0 (the default) picks one, as the tests do first time */
  port?: number
  now?: () => number
  onReset?: () => void
  /** the replica file's save pause; the default is short, a test that saves by hand makes it long */
  saveDebounceMs?: number
  timing?: typeof TIMING
  /** the options of every link the group makes: a test that sends a lot sets a small buffer limit */
  link?: Partial<PeerLinkOptions>
  onPeer?: DeviceGroupDeps['onPeer']
}

const groups: DeviceGroup[] = []
const sinks = new WeakMap<DeviceGroup, Sink>()
const dirOfGroup = new WeakMap<DeviceGroup, string>()
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(groups.splice(0).map((g) => g.close()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const newSink = (): Sink => ({ data: [], warns: [], errors: [], resets: 0, views: 0 })
const sinkOf = (g: DeviceGroup): Sink => sinks.get(g)!
const dirOf = (g: DeviceGroup): string => dirOfGroup.get(g)!
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** a group in a new temp folder, or in `opts.dir` when it is opened again; host 127.0.0.1, port 0 */
async function openGroup(name: string, platform: DevicePlatform, opts: OpenOptions = {}): Promise<DeviceGroup> {
  const dir = opts.dir ?? tempDir('group')
  if (!opts.dir) dirs.push(dir)
  const sink = opts.sink ?? newSink()
  const deps: DeviceGroupDeps = {
    dir,
    vault: opts.vault ?? fakeVault(),
    host: '127.0.0.1',
    port: opts.port ?? 0,
    platform,
    hostName: () => name,
    addresses: opts.addresses ?? (() => ['127.0.0.1']),
    onData: (updates) => sink.data.push(updates),
    onView: () => {
      sink.views += 1
    },
    onReset: () => {
      sink.resets += 1
      opts.onReset?.()
    },
    warn: (m) => sink.warns.push(m),
    onError: (m) => sink.errors.push(m),
    timing: { ...(opts.timing ?? TIMING), link: opts.link },
    saveDebounceMs: opts.saveDebounceMs ?? 10,
    now: opts.now,
    onPeer: opts.onPeer
  }
  const group = await DeviceGroup.open(deps)
  groups.push(group)
  sinks.set(group, sink)
  dirOfGroup.set(group, dir)
  return group
}

/** the device pairs `joiner` with a code it shows; the joiner types the host's listening address */
async function pair(host: DeviceGroup, joiner: DeviceGroup): Promise<void> {
  const v = await host.startPairing()
  const result = await joiner.join(`127.0.0.1:${v.self.port}`, v.pairing!.code)
  expect(result).toEqual({ ok: true })
}

/**
 * waits until the group has run a dial round that failed after this call: a round ends with a view report, and the
 * report is repeated on every retry, so two more reports cover at least one failed round
 */
async function dialFailed(g: DeviceGroup): Promise<void> {
  const base = sinkOf(g).views
  await until(() => sinkOf(g).views >= base + 2)
}

/** n devices are connected and have described themselves: a device listed without its description cannot be dialed yet */
const connected = (g: DeviceGroup, n: number): boolean =>
  g.view().devices.length >= n && g.view().devices.every((d) => d.state.kind === 'connected' && d.platform !== null)

/** the replica file of a group, as it is saved; the group's pending save is written first */
function savedReplica(g: DeviceGroup): ReplicaData {
  g.flush()
  return JSON.parse(readFileSync(join(dirOf(g), 'sync-replica.json'), 'utf8')) as ReplicaData
}

/** the link a group keeps to one of its members, for a test that delivers a message on it */
function linkTo(g: DeviceGroup, id: string): PeerLink {
  const found = [...(g as unknown as { links: Map<PeerLink, string> }).links].find(([, member]) => member === id)
  if (!found) throw new Error(`no link to ${id}`)
  return found[0]
}

const IDENTITY_WARNING = "This device's key could not be read; it was given a new one and has to be paired again"

const note = (text: string) => ({ text, shown: true, form: 'label' as const })

describe('DeviceGroup: pairing and records', () => {
  it('pairing: each lists the other as connected, added by the one that paired it', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    expect(a.view().devices[0]).toMatchObject({ name: 'Laptop', platform: 'windows', addedBy: 'Studio' })
    expect(b.view().devices[0]).toMatchObject({ name: 'Studio', addedBy: 'Laptop', address: `127.0.0.1:${a.view().self.port}` })
  })

  it("onPeer gets each kept member link with the member's hello", async () => {
    const peers: [PeerLink, HelloMessage][] = []
    const a = await openGroup('Studio', 'linux', { onPeer: (link, hello) => peers.push([link, hello]) })
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    await until(() => peers.length > 0)
    expect(peers).toHaveLength(1)
    const [link, hello] = peers[0]
    expect(hello.name).toBe('Laptop')
    expect(linkTo(a, b.view().self.id)).toBe(link)
  })

  it('an onPeer that throws is logged, not toasted, and the group goes on with the next member', async () => {
    const a = await openGroup('Studio', 'linux', {
      onPeer: () => {
        throw new Error('boom')
      }
    })
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    await until(() => sinkOf(a).errors.length >= 1)
    expect(sinkOf(a).errors[0]).toContain('boom')
    expect(sinkOf(a).warns).toEqual([])
    const c = await openGroup('Mini', 'macos')
    await pair(a, c)
    await until(() => a.view().devices.some((d) => d.name === 'Mini' && d.state.kind === 'connected'))
    expect(sinkOf(a).warns).toEqual([])
  })

  it('onPeer is not called for a link that closes before it runs', async () => {
    const peers: PeerLink[] = []
    const closedLinks: PeerLink[] = []
    let armed = false
    const realSend = PeerLink.prototype.send
    const a = await openGroup('Studio', 'linux', { onPeer: (link) => peers.push(link) })
    const b = await openGroup('Laptop', 'windows')
    const aLinks = (a as unknown as { links: Map<PeerLink, string> }).links
    // once armed, the first sync that a's group sends on a new link closes the link: the link is gone before onPeer runs
    const spy = vi.spyOn(PeerLink.prototype, 'send').mockImplementation(function (this: PeerLink, m: Message) {
      if (armed && m.t === 'sync' && closedLinks.length === 0 && aLinks.has(this)) {
        closedLinks.push(this)
        this.close('closed before onPeer')
        return false
      }
      return realSend.call(this, m)
    })
    try {
      await pair(a, b)
      await until(() => connected(a, 1) && connected(b, 1))
      await until(() => peers.length === 1)
      const first = peers[0]
      armed = true
      linkTo(a, b.view().self.id).close('test: relink')
      await until(() => closedLinks.length === 1)
      await until(() => peers.length >= 2)
      expect(peers).not.toContain(closedLinks[0])
      expect(peers[1]).not.toBe(first)
    } finally {
      spy.mockRestore()
    }
  })

  it('a star written on one device arrives on the other', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    a.write('stars', S1, true)
    await until(() => starOf(b.state('stars', S1)))
    expect(sinkOf(b).data.at(-1)!.map((u) => u.key)).toEqual([S1])
  })

  it("a catch-up larger than the link's buffer limit arrives whole, and the link stays up", async () => {
    const link = { maxBufferedBytes: 256 * 1024 }
    const a = await openGroup('Studio', 'linux', { link })
    const b = await openGroup('Laptop', 'windows', { link })
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const dirB = dirOf(b)
    await b.close()
    for (let i = 0; i < 1000; i++) a.write('notes', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, note('n'.repeat(4000) + i))
    // no link of either device closes as a slow peer on the way: a link that does, and redials, would still catch up
    const closes = vi.spyOn(PeerLink.prototype, 'close')
    try {
      const again = await openGroup('Laptop', 'windows', { dir: dirB, link })
      await until(() => again.keys('notes').length === 1000, 15_000)
      expect(a.view().devices[0].state.kind).toBe('connected')
      expect(closes.mock.calls.map(([reason]) => reason)).not.toContain('slow peer')
    } finally {
      closes.mockRestore()
    }
  })

  it('a device that was closed catches up when it opens again', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const dirB = dirOf(b)
    await b.close()
    a.write('stars', S1, true)
    a.write('notes', S2, note('while apart'))
    const again = await openGroup('Laptop', 'windows', { dir: dirB })
    await until(() => starOf(again.state('stars', S1)) && noteOf(again.state('notes', S2))?.text === 'while apart')
  })

  it('a third device paired with one member becomes known to all and they connect', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    const c = await openGroup('Mini', 'macos')
    await pair(a, b)
    await pair(b, c)
    await until(() => a.view().devices.some((d) => d.name === 'Mini' && d.state.kind === 'connected'))
    await until(() => c.view().devices.some((d) => d.name === 'Studio' && d.state.kind === 'connected'))
  })

  it('a change reaches a device through another when it cannot reach the writer directly', async () => {
    // A and C have no address to dial each other with; B links to both
    const a = await openGroup('Studio', 'linux', { addresses: () => [] })
    const b = await openGroup('Laptop', 'windows')
    const c = await openGroup('Mini', 'macos', { addresses: () => [] })
    await pair(a, b)
    await pair(b, c)
    const idA = a.view().self.id
    await until(() => c.view().devices.some((d) => d.name === 'Studio'))
    c.setAddress(idA, '127.0.0.1:1')
    await until(() => c.view().devices.some((d) => d.name === 'Studio' && d.state.kind === 'unreachable'))
    a.write('stars', S1, true)
    await until(() => starOf(c.state('stars', S1)))
  })

  it('remove: the removed device is told, forgets the group and gets a new identity; the others refuse it', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const oldId = b.view().self.id
    expect(a.remove(oldId)).toEqual({ ok: true })
    await until(() => b.view().removedBy === 'Studio')
    expect(b.view().devices).toEqual([])
    expect(b.view().self.id).not.toBe(oldId)
    expect(a.view().devices).toEqual([])
    expect(sinkOf(b).resets).toBe(1)
  })

  it('a device removed while it was off learns it when it connects', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    // a third member keeps a listening after b is removed
    const c = await openGroup('Mini', 'macos')
    await pair(a, b)
    await pair(a, c)
    await until(() => connected(a, 2) && connected(b, 1))
    const dirB = dirOf(b)
    const oldId = b.view().self.id
    await b.close()
    expect(a.remove(oldId)).toEqual({ ok: true })
    const again = await openGroup('Laptop', 'windows', { dir: dirB })
    await until(() => again.view().removedBy === 'Studio')
    expect(again.view().devices).toEqual([])
  })

  it('leave needs a connected member; with one it removes this device everywhere', async () => {
    const lonely = await openGroup('Lonely', 'linux')
    expect(await lonely.leave()).toEqual({ ok: false, error: DEVICE_COPY.leaveNeedsConnection })
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    const c = await openGroup('Mini', 'macos')
    await pair(a, b)
    await pair(b, c)
    await until(() => a.view().devices.some((d) => d.name === 'Mini') && c.view().devices.length === 2)
    expect(await c.leave()).toEqual({ ok: true })
    await until(() => !a.view().devices.some((d) => d.name === 'Mini'))
    expect(c.view().devices).toEqual([])
    expect(c.view().removedBy).toBeNull()
  })

  it('the same note changed on two devices while apart is joined on both', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const dirA = dirOf(a)
    const dirB = dirOf(b)
    // each device reopens on the port it had: the others hold that port for it
    const portA = a.view().self.port!
    const portB = b.view().self.port!
    await b.close()
    a.write('notes', S1, note('from Studio'))
    await a.close()
    const b2 = await openGroup('Laptop', 'windows', { dir: dirB, port: portB })
    await sleep(20)
    b2.write('notes', S1, note('from Laptop'))
    const a2 = await openGroup('Studio', 'linux', { dir: dirA, port: portA })
    await until(() => noteOf(a2.state('notes', S1))?.text === 'from Laptop\n\nfrom Studio')
    await until(() => noteOf(b2.state('notes', S1))?.text === 'from Laptop\n\nfrom Studio')
  })

  it('a member dials a restarted device at the port in its synced record', async () => {
    const a = await openGroup('Studio', 'linux', { addresses: () => [] })
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const dirA = dirOf(a)
    const dirB = dirOf(b)
    const portA = a.view().self.port!
    const idA = a.view().self.id
    const idB = b.view().self.id
    await b.close()
    const b2 = await openGroup('Laptop', 'windows', { dir: dirB })
    await until(() => connected(b2, 1))
    await until(() => {
      a.flush()
      return memberOf(savedReplica(a).records.members[idB])?.port === b2.view().self.port
    })
    // b2 cannot dial a: its address for a is unusable, and a publishes no address of its own
    expect(b2.setAddress(idA, '127.0.0.1:1')).toEqual({ ok: true })
    await a.close()
    // a dropped link shows as offline: the group has noticed a is gone
    await until(() => b2.view().devices.some((d) => d.state.kind === 'offline'))
    // a comes back on its old port and must dial b2 at the new one, from the record it synced
    const a2 = await openGroup('Studio', 'linux', { dir: dirA, port: portA, addresses: () => [] })
    await until(() => connected(a2, 1) && connected(b2, 1))
  })

  it('refreshSelf rewrites this device\'s addresses only when they changed', async () => {
    let addresses = ['127.0.0.1']
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows', { addresses: () => addresses })
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const idB = b.view().self.id
    addresses = ['127.0.0.1', 'localhost']
    b.refreshSelf()
    await until(() => memberOf(savedReplica(a).records.members[idB])?.addresses.includes('localhost') === true)
    const before = JSON.stringify(savedReplica(b))
    b.refreshSelf()
    expect(JSON.stringify(savedReplica(b))).toBe(before)
  })

  it('the port it listens on is the one it tells the others', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    const idB = b.view().self.id
    await until(() => memberOf(savedReplica(a).records.members[idB])?.port === b.view().self.port)
    expect(b.view().self.port).toBeGreaterThan(0)
  })

  it('rename changes the name the others show', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    expect(a.rename('Desk')).toEqual({ ok: true })
    await until(() => b.view().devices[0]?.name === 'Desk')
  })

  it('joining while in another group merges both groups', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    const c = await openGroup('Mini', 'macos')
    const d = await openGroup('Tower', 'linux')
    await pair(a, b)
    await pair(c, d)
    await pair(a, c)
    const all = [a, b, c, d]
    await until(() => all.every((g) => g.view().devices.length === 3))
    await until(() => all.every((g) => connected(g, 3)))
  })

  it('unreachableByOthers follows the members\' reports, outbound and inbound', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const dirA = dirOf(a)
    const dirB = dirOf(b)
    const idB = b.view().self.id
    await a.close()
    // b cannot reach a now: its dials fail, so it reports that it does not reach a
    await until(() => b.view().devices.some((d) => d.state.kind === 'offline'))
    await dialFailed(b)
    // outbound: a dials b, and b's report says it does not reach a
    const a2 = await openGroup('Studio', 'linux', { dir: dirA })
    await until(() => connected(a2, 1))
    await until(() => a2.view().unreachableByOthers)
    // inbound: a2 cannot dial b, so b must dial it; the inbound link says b reaches a2
    expect(a2.setAddress(idB, '127.0.0.1:1')).toEqual({ ok: true })
    await b.close()
    await until(() => a2.view().devices.some((d) => d.state.kind === 'offline'))
    const b2 = await openGroup('Laptop', 'windows', { dir: dirB })
    await until(() => connected(b2, 1) && connected(a2, 1))
    await until(() => !a2.view().unreachableByOthers)
  })
})

describe('DeviceGroup: opening, resets and failures', () => {
  it('open() fails cleanly when the identity key cannot be decrypted', async () => {
    const dir = tempDir('group')
    dirs.push(dir)
    const first = await openGroup('Studio', 'linux', { dir })
    await first.close()
    const before = readFileSync(join(dir, 'device-identity.json'))
    const locked: Vault = { ...fakeVault(), decrypt: () => { throw new Error('locked') } }
    const sink = newSink()
    await expect(openGroup('Studio', 'linux', { dir, vault: locked, sink })).rejects.toThrow()
    expect(sink.warns).toContainEqual(expect.stringContaining('keyring'))
    expect(readFileSync(join(dir, 'device-identity.json'))).toEqual(before)
  })

  it('a lost replica with an old identity resets the identity', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    a.write('stars', S1, true)
    await until(() => starOf(b.state('stars', S1)))
    const dirA = dirOf(a)
    const oldId = a.view().self.id
    await a.close()
    rmSync(join(dirA, 'sync-replica.json'))
    const sink = newSink()
    const again = await openGroup('Studio', 'linux', { dir: dirA, sink })
    expect(again.view().self.id).not.toBe(oldId)
    expect(again.view().devices).toEqual([])
    expect(sink.warns).toContain("This device's sync data could not be read; it was given a new key and has to be paired again")
  })

  it('a reset that fails at run time reports the error and the group stays stopped', async () => {
    const base = fakeVault()
    let broken = false
    const vault: Vault = {
      available: () => true,
      decrypt: base.decrypt,
      encrypt: (text) => {
        if (broken) throw new Error('keyring busy')
        return base.encrypt(text)
      }
    }
    const a = await openGroup('Studio', 'linux')
    const sinkB = newSink()
    const b = await openGroup('Laptop', 'windows', { sink: sinkB, vault })
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const oldId = b.view().self.id
    broken = true
    expect(a.remove(oldId)).toEqual({ ok: true })
    await until(() => sinkB.errors.length > 0)
    expect(sinkB.errors[0]).toContain('keyring busy')
    expect(b.view().self.id).toBe(oldId)
    expect(b.view().problem).toBe(DEVICE_COPY.syncStopped)
    b.write('stars', S1, true)
    expect(b.state('stars', S1)).toBeUndefined()
  })

  it('writes made while closed are ignored and do not throw', async () => {
    const a = await openGroup('Studio', 'linux')
    await a.close()
    expect(() => a.write('stars', S1, true)).not.toThrow()
    expect(a.state('stars', S1)).toBeUndefined()
  })

  it('remove refuses an unknown device, and setAddress refuses a bad address', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1))
    expect(a.remove(randomUUID())).toEqual({ ok: false, error: DEVICE_COPY.unknownDevice })
    expect(a.setAddress(b.view().self.id, 'not an address!')).toEqual({ ok: false, error: DEVICE_COPY.badAddress })
  })
})

describe('DeviceGroup: fix round 1', () => {
  it('a remover keeps listening, so a device removed while it was off hears of it', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const dirB = dirOf(b)
    const idB = b.view().self.id
    await b.close()
    expect(a.remove(idB)).toEqual({ ok: true })
    expect(a.view().self.port).not.toBeNull()
    const again = await openGroup('Laptop', 'windows', { dir: dirB })
    await until(() => again.view().removedBy === 'Studio')
  })

  it('a remover stops listening once the removal notice window has passed', async () => {
    let clock = Date.now()
    const a = await openGroup('Studio', 'linux', { now: () => clock })
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const idB = b.view().self.id
    await b.close()
    expect(a.remove(idB)).toEqual({ ok: true })
    expect(a.view().self.port).not.toBeNull()
    clock += REMOVAL_NOTICE_MS + 1
    a.refreshSelf()
    expect(a.view().self.port).toBeNull()
  })

  it("a removed member's records are ignored once its removal is known", async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    const c = await openGroup('Mini', 'macos')
    await pair(a, b)
    await pair(a, c)
    const idB = b.view().self.id
    await until(() => connected(a, 2) && connected(c, 2))
    const linkCB = linkTo(c, idB)
    expect(a.remove(idB)).toEqual({ ok: true })
    await until(() => !c.view().devices.some((d) => d.id === idB))
    // a star written by b, delivered on the link c kept to b
    const star = { col: 'stars', key: S1, state: { siblings: [{ value: true, at: { t: 1, c: 0 }, dot: [idB, 1] }], ctx: { [idB]: 1 } } }
    linkCB.emit('message', { t: 'records', updates: [star] })
    expect(c.state('stars', S1)).toBeUndefined()
    expect(a.state('stars', S1)).toBeUndefined()
  })

  it('every admitted device is listed, by its id and without a platform when it has no description', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const ghost = randomUUID()
    const writer = b as unknown as { replica: Replica; commit(u: RecordUpdate): void }
    writer.commit(writer.replica.write('admitted', ghost, { fingerprint: 'ab'.repeat(32), addedBy: b.view().self.id, addedAt: Date.now() }))
    await until(() => a.view().devices.some((d) => d.id === ghost))
    expect(a.view().devices.find((d) => d.id === ghost)).toMatchObject({ name: ghost, platform: null })
    expect(a.remove(ghost)).toEqual({ ok: true })
    expect(a.view().devices.some((d) => d.id === ghost)).toBe(false)
  })

  it('a device keeps its name when it leaves and starts over', async () => {
    const a = await openGroup('Studio', 'linux')
    const c = await openGroup('Mini', 'macos')
    await pair(a, c)
    await until(() => connected(a, 1) && connected(c, 1))
    expect(c.rename('Desk')).toEqual({ ok: true })
    expect(await c.leave()).toEqual({ ok: true })
    expect(c.view().self.name).toBe('Desk')
    expect(sinkOf(c).resets).toBe(1)
  })

  it('a failure while starting over is reported, and the group stays stopped', async () => {
    const a = await openGroup('Studio', 'linux')
    const c = await openGroup('Mini', 'macos', {
      onReset: () => {
        throw new Error('boom')
      }
    })
    await pair(a, c)
    await until(() => connected(a, 1) && connected(c, 1))
    expect(await c.leave()).toEqual({ ok: false, error: 'boom' })
    expect(sinkOf(c).errors).toContain('boom')
    c.write('stars', S1, true)
    expect(c.state('stars', S1)).toBeUndefined()
    expect(() => c.view()).not.toThrow()
  })

  it('a second leave while one runs answers ok at once and does nothing', async () => {
    const a = await openGroup('Studio', 'linux')
    const c = await openGroup('Mini', 'macos')
    await pair(a, c)
    await until(() => connected(a, 1) && connected(c, 1))
    const first = c.leave()
    expect(await c.leave()).toEqual({ ok: true })
    expect(await first).toEqual({ ok: true })
    expect(sinkOf(c).resets).toBe(1)
  })

  it('close waits for a running start-over, so the identity and the replica stay in step', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const dirB = dirOf(b)
    expect(a.remove(b.view().self.id)).toEqual({ ok: true })
    await until(() => b.view().removedBy === 'Studio')
    const newId = b.view().self.id
    await b.close()
    const again = await openGroup('Laptop', 'windows', { dir: dirB })
    expect(again.view().self.id).toBe(newId)
    expect(again.view().removedBy).toBe('Studio')
  })

  it('rename refuses an empty name, a 65-character name and names with control characters', async () => {
    const g = await openGroup('Studio', 'linux')
    const badName = { ok: false, error: DEVICE_COPY.badName }
    expect(g.rename('   ')).toEqual(badName)
    expect(g.rename('x'.repeat(65))).toEqual(badName)
    expect(g.rename('bad\u0007name')).toEqual(badName)
    expect(g.rename('bad\u0085name')).toEqual(badName)
    expect(g.rename('x'.repeat(64))).toEqual({ ok: true })
  })

  it('setAddress with null removes the address typed for a device', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const idA = a.view().self.id
    expect(b.view().devices[0]?.address).toBe(`127.0.0.1:${a.view().self.port}`)
    expect(b.setAddress(idA, null)).toEqual({ ok: true })
    expect(b.view().devices[0]?.address).toBeNull()
  })

  it('remove refuses this device\'s own id', async () => {
    const a = await openGroup('Studio', 'linux')
    expect(a.remove(a.view().self.id)).toEqual({ ok: false, error: DEVICE_COPY.unknownDevice })
  })

  it('canLeave is false with no connected member, and true with one', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    expect(a.view().canLeave).toBe(true)
    await b.close()
    await until(() => !a.view().canLeave)
    const lonely = await openGroup('Lonely', 'linux')
    expect(lonely.view().canLeave).toBe(false)
  })

  it('a garbage identity file is replaced once, and the replica does not carry over', async () => {
    const dir = tempDir('group')
    dirs.push(dir)
    const first = await openGroup('Studio', 'linux', { dir })
    const oldId = first.view().self.id
    await first.close()
    writeFileSync(join(dir, 'device-identity.json'), 'garbage')
    const sink = newSink()
    const again = await openGroup('Studio', 'linux', { dir, sink })
    expect(again.view().self.id).not.toBe(oldId)
    expect(again.view().devices).toEqual([])
    expect(sink.warns).toEqual([IDENTITY_WARNING])
    expect(sink.resets).toBe(0)
  })
})

/** a group's private links, to re-insert or inspect a link the way a late message would find it */
const linksOf = (g: DeviceGroup): Map<PeerLink, string> => (g as unknown as { links: Map<PeerLink, string> }).links

/** a raw TCP server on a port that counts the connections made to it; each is closed at once */
async function countingServer(port: number): Promise<{ count: () => number; close: () => Promise<void> }> {
  let connections = 0
  const server = net.createServer((s) => {
    connections += 1
    s.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { count: () => connections, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

describe('DeviceGroup: sequence numbers, retries and errors', () => {
  it('after a crash, a new write is numbered above every sequence number that was sent before it', async () => {
    const a = await openGroup('Studio', 'linux', { saveDebounceMs: 60_000 })
    const dirA = dirOf(a)
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const idA = a.view().self.id
    // the snapshot point: the state saved before the writes below
    a.flush()
    // more writes than one reservation covers, so the sends cross a reservation the file must carry
    const keys = Array.from({ length: SEQ_RESERVE + 6 }, () => randomUUID())
    for (const key of keys) a.write('stars', key, true)
    await until(() => keys.every((key) => starOf(b.state('stars', key))))
    const sent = keys.map((key) => b.state('stars', key)!.siblings.find((s) => s.dot[0] === idA)!.dot[1])
    // the process is gone: copied with no flush, so the file is what the sends' reservation saves left on disk
    const copied = readFileSync(join(dirA, 'sync-replica.json'), 'utf8')
    await a.close()
    writeFileSync(join(dirA, 'sync-replica.json'), copied)
    const again = await openGroup('Studio', 'linux', { dir: dirA })
    const dot = again.write('stars', randomUUID(), true)
    expect(dot).not.toBeNull()
    expect(dot![1]).toBeGreaterThan(Math.max(...sent))
  })

  it('a reservation whose save fails is saved again by the next send', async () => {
    const a = await openGroup('Studio', 'linux', { saveDebounceMs: 60_000 })
    const dirA = dirOf(a)
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const idA = a.view().self.id
    // the save writes its temp file first: a folder standing there makes the save fail on every OS
    const obstacle = join(dirA, 'sync-replica.json.tmp')
    mkdirSync(obstacle)
    // more writes than one reservation covers: the one that crosses it asks for a save, which fails
    const keys = Array.from({ length: SEQ_RESERVE + 2 }, () => randomUUID())
    for (const key of keys) a.write('stars', key, true)
    await until(() => keys.every((key) => starOf(b.state('stars', key))))
    expect(sinkOf(a).errors.length).toBeGreaterThan(0)
    rmSync(obstacle, { recursive: true, force: true })
    a.write('stars', S2, true)
    await until(() => starOf(b.state('stars', S2)))
    const sent = [...keys, S2].map((key) => b.state('stars', key)!.siblings.find((s) => s.dot[0] === idA)!.dot[1])
    const onDisk = JSON.parse(readFileSync(join(dirA, 'sync-replica.json'), 'utf8')) as ReplicaData
    expect(onDisk.reserved).toBeGreaterThanOrEqual(Math.max(...sent))
  })

  it('refreshSelf with unchanged addresses dials no member again', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows', { timing: { ...TIMING, minRetryMs: 60_000, maxRetryMs: 60_000 } })
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const portA = a.view().self.port!
    await a.close()
    await until(() => b.view().devices.some((d) => d.state.kind === 'offline'))
    const counter = await countingServer(portA)
    try {
      for (let i = 0; i < 10; i++) b.refreshSelf()
      // a dial is a connection to the counting server; one would arrive within a few milliseconds
      await sleep(500)
      expect(counter.count()).toBe(0)
    } finally {
      await counter.close()
    }
  })

})

describe('DeviceGroup: fix round 2', () => {
  it('a records message from a removed member is ignored, even on a link that is still held', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    const c = await openGroup('Mini', 'macos')
    await pair(a, b)
    await pair(a, c)
    const idB = b.view().self.id
    await until(() => connected(a, 2) && connected(c, 2))
    const linkCB = linkTo(c, idB)
    expect(a.remove(idB)).toEqual({ ok: true })
    await until(() => !c.view().devices.some((d) => d.id === idB))
    // the link to b is held again, as if the group had not dropped it
    linksOf(c).set(linkCB, idB)
    const star = { col: 'stars', key: S1, state: { siblings: [{ value: true, at: { t: 1, c: 0 }, dot: [idB, 1] }], ctx: { [idB]: 1 } } }
    linkCB.emit('message', { t: 'records', updates: [star] })
    expect(c.state('stars', S1)).toBeUndefined()
    // a star written on c after the message goes to a on the same connection, so once a has it, a has seen the message
    c.write('stars', S2, true)
    await until(() => starOf(a.state('stars', S2)))
    expect(a.state('stars', S1)).toBeUndefined()
  })

  it('the links to a removed member are dropped before anything is forwarded', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    const c = await openGroup('Mini', 'macos')
    await pair(a, b)
    await pair(a, c)
    const idA = a.view().self.id
    const idB = b.view().self.id
    await until(() => connected(a, 2) && connected(c, 2))
    expect(a.remove(idB)).toEqual({ ok: true })
    // the removal as a takes it from its replica, delivered to c on its link to a
    const removal = (a as unknown as { replica: Replica }).replica.since({}).filter((u) => u.col === 'removed' && u.key === idB)
    expect(removal).toHaveLength(1)
    linkTo(c, idA).emit('message', { t: 'records', updates: removal })
    expect(() => linkTo(c, idB)).toThrow()
  })

  it('close during a restart keeps the identity file and the replica file in step', async () => {
    const a = await openGroup('Studio', 'linux')
    const dirB = tempDir('group')
    dirs.push(dirB)
    const sink = newSink()
    const b = await openGroup('Laptop', 'windows', { dir: dirB, sink })
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const restarting = (b as unknown as { restart(by: string): Promise<unknown> }).restart('X')
    await b.close()
    await restarting
    const restartedId = (b as unknown as { identity: { id: string } }).identity.id
    const reopened = newSink()
    const again = await openGroup('Laptop', 'windows', { dir: dirB, sink: reopened })
    expect(again.view().self.id).toBe(restartedId)
    expect(again.view().removedBy).toBe('X')
    expect(reopened.warns).toEqual([])
  })

  it('a second restart while one runs waits for it: one identity reset, one onReset', async () => {
    const a = await openGroup('Studio', 'linux')
    const sink = newSink()
    const b = await openGroup('Laptop', 'windows', { sink })
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const identities = (b as unknown as { identities: { reset(): Promise<unknown> } }).identities
    const reset = identities.reset.bind(identities)
    let resets = 0
    identities.reset = () => {
      resets += 1
      return reset()
    }
    const restart = (b as unknown as { restart(by: string): Promise<unknown> }).restart.bind(b)
    await Promise.all([restart('X'), restart('X')])
    expect(resets).toBe(1)
    expect(sink.resets).toBe(1)
  })
})

describe('DeviceGroup: fix round 3', () => {
  // C3: a batch the link refuses (sendBulk false) ends the records: no later batch and no done follows it, so the peer
  // never marks as seen records it did not get
  it('records stop at the first batch the link refuses, and no done is sent', async () => {
    const a = await openGroup('Studio', 'linux')
    const b = await openGroup('Laptop', 'windows')
    await pair(a, b)
    await until(() => connected(a, 1) && connected(b, 1))
    const idB = b.view().self.id
    for (let i = 0; i < 200; i++) a.write('notes', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, note('n'.repeat(4000) + i))
    const link = linkTo(a, idB)
    const spy = vi.spyOn(link, 'sendBulk').mockReturnValueOnce(false)
    try {
      link.emit('message', { t: 'sync', seen: {} })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls.some(([m]) => (m as { done?: unknown }).done !== undefined)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})
