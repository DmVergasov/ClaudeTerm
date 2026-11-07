import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostHandlers, hostTabs } from '../../src/main/remote-host'
import { pathKey } from '../../src/main/path-key'
import { Calls } from '../../src/main/sync/calls'
import { quoteForShell } from '../../src/main/profiles'
import { FileReceiver, receivedPeerGone } from '../../src/main/sync/file-receiver'
import { sendFiles, type OutgoingFile } from '../../src/main/sync/file-sender'
import { RemoteActions } from '../../src/main/sync/remote-actions'
import { connectPeer } from '../../src/main/sync/remote-link'
import type { PeerLink } from '../../src/main/sync/peer-link'
import { ScreenMirrors } from '../../src/main/sync/screen-mirror'
import { TabHost } from '../../src/main/sync/tab-host'
import { RemoteTabs, type ViewerEvents } from '../../src/main/sync/tab-viewer'
import type { HelloMessage } from '../../src/main/sync/wire'
import type { DevicePlatform } from '../../src/shared/devices'
import { REMOTE_COPY } from '../../src/shared/remote'
import { B_ID, T1, T2, T9, fakeHost } from '../fixtures/host-context'
import { closeLinkPairs, linkPair, until } from '../fixtures/sync'

// Files pasted or dropped on device B go to a remote tab on device A: they arrive in a new folder under A's received root.
// Device C is a third device linked to A; it can call A's receiver too, and must not reach B's transfers.

const A_ID = 'a1000000-0000-4000-8000-000000000001'
const C_ID = 'c1000000-0000-4000-8000-000000000001'
const MB = 1024 * 1024

function helloOf(id: string, name: string, platform: DevicePlatform = 'linux'): HelloMessage {
  return { t: 'hello', v: 1, id, name, platform, port: 0, addresses: [], reachedYou: null }
}

const quietEvents: ViewerEvents = {
  opened: () => {},
  updated: () => {},
  closed: () => {},
  devices: () => {},
  data: () => {},
  reset: () => {},
  exit: () => {},
  size: () => {},
  attention: () => {},
  attentionCleared: () => {},
  ring: () => {},
  push: () => {}
}

/** the bytes of a file of this name and size: the same ones every time */
function bytes(name: string, size: number): Buffer {
  return Buffer.alloc(size, name)
}

/** a file to send: its bytes are read from the same pattern as bytes() */
function file(name: string, size: number): OutgoingFile {
  return { name, size, read: async (offset, length) => bytes(name, size).subarray(offset, offset + length) }
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64')
}

let base: string
let root: string
let receiver: FileReceiver
let actions: RemoteActions
let cCalls: Calls
let linkAB: { client: PeerLink }
let bulkSpy: ReturnType<typeof vi.spyOn>
let sendSpy: ReturnType<typeof vi.spyOn>
/** the recv-part calls A's handler is serving now, and the most at once */
let inFlight = 0
let maxInFlight = 0

/** A serves its tab T1 with its receiver to B (through RemoteActions) and to C (through a raw Calls) */
async function setUp(): Promise<void> {
  receiver = new FileReceiver({ root })
  const a = fakeHost()
  a.ctx.receiver = receiver
  const hostA = new TabHost({ tabs: hostTabs(a.ctx), mirrors: new ScreenMirrors({ maxSnapshotBytes: MB }), onPeerGone: receivedPeerGone(receiver) })
  const hostB = new TabHost({ tabs: hostTabs(fakeHost().ctx), mirrors: new ScreenMirrors({ maxSnapshotBytes: MB }) })
  const viewerA = new RemoteTabs({ selfId: () => A_ID, isLocal: () => false, events: quietEvents })
  const viewerB = new RemoteTabs({ selfId: () => B_ID, isLocal: () => false, events: quietEvents })

  const ab = await linkPair()
  linkAB = ab
  hostA.changed()
  connectPeer(ab.client, helloOf(A_ID, 'Studio'), hostB, viewerB, {})
  // B's handlers on A, with the recv-part entry counting the parts it serves at once
  const handlers = hostHandlers(a.ctx, B_ID)
  const part = handlers['recv-part']!
  handlers['recv-part'] = {
    ...part,
    run: async (x: unknown) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        return await part.run(x)
      } finally {
        inFlight--
      }
    }
  }
  connectPeer(ab.server, helloOf(B_ID, 'Laptop'), hostA, viewerA, handlers)
  await until(() => viewerB.has(T1))
  actions = new RemoteActions(viewerB, () => {}, () => {})
  bulkSpy = vi.spyOn(ab.client, 'sendBulk')
  sendSpy = vi.spyOn(ab.client, 'send')

  const ac = await linkPair()
  connectPeer(ac.server, helloOf(C_ID, 'Cellar'), hostA, viewerA, hostHandlers(a.ctx, C_ID))
  cCalls = new Calls(ac.client, {})
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ct-transfer-'))
  root = join(base, 'ClaudeTerm', 'received')
  inFlight = 0
  maxInFlight = 0
})

afterEach(async () => {
  vi.restoreAllMocks()
  await closeLinkPairs()
  receiver.dispose()
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('sending files to a tab on another device', () => {
  it("a pasted image and dropped files land in a new folder under the receiving device's root, and the paths exist", async () => {
    await setUp()
    const { paths } = await sendFiles(actions, T1, [file('shot.png', 1.5 * MB), file('notes.txt', 10)])
    expect(paths.map((p) => basename(p))).toEqual(['shot.png', 'notes.txt'])
    expect(pathKey(dirname(dirname(paths[0])))).toBe(pathKey(root))
    expect(readFileSync(paths[0]).equals(bytes('shot.png', 1.5 * MB))).toBe(true)
    expect(existsSync(paths[1])).toBe(true)
  })

  it('the text typed is quoted for the tab: single quotes for a shell tab, double quotes for a Claude tab, with $ and ! in the folder', async () => {
    root = join(base, 'Bo$b!', 'ClaudeTerm', 'received')
    await setUp()
    const shell = await sendFiles(actions, T2, [file('shot.png', 10), file('notes.txt', 3)])
    expect(shell.text).toBe(shell.paths.map((p) => quoteForShell('bash', p)).join(' '))
    expect(shell.text).toContain('Bo$b!')
    const claude = await sendFiles(actions, T1, [file('shot.png', 10)])
    expect(claude.text).toBe(`"${claude.paths[0]}"`)
  })

  it("an older sender's recv-end, with no id, is answered its paths alone", async () => {
    await setUp()
    const { transfer } = await actions.askTab(T1, 'recv-begin', { id: T1, files: [{ name: 'a.txt', size: 1 }] })
    await actions.askTab(T1, 'recv-part', { transfer, file: 0, offset: 0, data: b64('a') }, { bulk: true })
    const reply = await actions.askTab(T1, 'recv-end', { transfer })
    expect(reply.text).toBeUndefined()
    expect(reply.paths).toHaveLength(1)
  })

  it('names with .., separators or reserved names arrive made plain; two of one name both arrive', async () => {
    await setUp()
    const { paths } = await sendFiles(actions, T1, [file('../../up.txt', 3), file('dir/a.txt', 3), file('a.txt', 3), file('NUL', 3)])
    expect(paths.map((p) => basename(p))).toEqual(['up.txt', 'a.txt', 'a (2).txt', '_NUL'])
    for (const p of paths) expect(pathKey(dirname(dirname(p)))).toBe(pathKey(root))
  })

  it('more than 50 MB in all is refused and nothing is written', async () => {
    await setUp()
    await expect(sendFiles(actions, T1, [file('a.bin', 30 * MB), file('b.bin', 30 * MB)])).rejects.toThrow(REMOTE_COPY.receiveTooLarge)
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })

  it('more than 100 files are refused locally with a copy message, and nothing is sent', async () => {
    await setUp()
    const many = Array.from({ length: 101 }, (_, i) => file(`f${i}.txt`, 1))
    await expect(sendFiles(actions, T1, many)).rejects.toThrow(REMOTE_COPY.copyTooManyFiles)
    expect(existsSync(root)).toBe(false)
  })

  it('a file that cannot be read fails the copy with the copy message, and no local path reaches the person', async () => {
    await setUp()
    const broken: OutgoingFile = { name: 'bad.bin', size: 4, read: async () => Promise.reject(new Error(`EIO: read failed, ${base}`)) }
    const err = await sendFiles(actions, T1, [broken]).then(
      () => null,
      (e: Error) => e
    )
    expect(err?.message).toBe(REMOTE_COPY.copyReadFailed)
    expect(err?.message.includes(base)).toBe(false)
  })

  it('a refusal of the receiver reaches the sender with its message', async () => {
    await setUp()
    for (const o of ['x1', 'x1', 'x2', 'x2']) await receiver.begin([{ name: 'a.bin', size: 1 }], o)
    await expect(sendFiles(actions, T1, [file('shot.png', 10)])).rejects.toThrow(REMOTE_COPY.receiveBusy)
  })

  it('the parts go one at a time, each on the bulk lane', async () => {
    await setUp()
    await sendFiles(actions, T1, [file('big.bin', 2.5 * MB)])
    expect(maxInFlight).toBe(1)
    const bulkParts = (bulkSpy.mock.calls as unknown as [unknown][]).filter(([m]) => (m as { m?: string }).m === 'recv-part')
    expect(bulkParts).toHaveLength(3)
    const plainParts = (sendSpy.mock.calls as unknown as [unknown][]).filter(([m]) => (m as { m?: string }).m === 'recv-part')
    expect(plainParts).toHaveLength(0)
  })

  it('a transfer belongs to the device that began it: another device cannot add to it, and the transfer still completes', async () => {
    await setUp()
    const { transfer } = await actions.askTab(T1, 'recv-begin', { id: T1, files: [{ name: 'a.bin', size: 4 }] })
    await expect(cCalls.call('recv-part', { transfer, file: 0, offset: 0, data: b64('ab') }, { bulk: true })).rejects.toThrow(
      REMOTE_COPY.receiveUnknown
    )
    await actions.askTab(T1, 'recv-part', { transfer, file: 0, offset: 0, data: b64('ab') }, { bulk: true })
    await actions.askTab(T1, 'recv-part', { transfer, file: 0, offset: 2, data: b64('cd') }, { bulk: true })
    const { paths } = await actions.askTab(T1, 'recv-end', { transfer })
    expect(readFileSync(paths[0], 'utf8')).toBe('abcd')
  })

  it('a begin for a tab the device does not have is refused, and nothing is written', async () => {
    await setUp()
    await expect(cCalls.call('recv-begin', { id: T9, files: [{ name: 'a.bin', size: 1 }] })).rejects.toThrow(REMOTE_COPY.unknownTab)
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })

  it('closing the link releases the transfers of its device: the root is left empty', async () => {
    await setUp()
    const { transfer } = await actions.askTab(T1, 'recv-begin', { id: T1, files: [{ name: 'a.bin', size: 4 }] })
    await actions.askTab(T1, 'recv-part', { transfer, file: 0, offset: 0, data: b64('ab') }, { bulk: true })
    expect(readdirSync(root)).toHaveLength(1)
    linkAB.client.close('test: the link closes')
    await until(() => readdirSync(root).length === 0)
  })
})
