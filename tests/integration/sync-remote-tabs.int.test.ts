import { EventEmitter } from 'node:events'
import type * as tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeviceView, DevicePlatform } from '../../src/shared/devices'
import { Calls } from '../../src/main/sync/calls'
import type { PeerLink } from '../../src/main/sync/peer-link'
import { connectPeer } from '../../src/main/sync/remote-link'
import type { ScreenMirrorsApi } from '../../src/main/sync/screen-mirror'
import { ScreenMirrors } from '../../src/main/sync/screen-mirror'
import { TabHost } from '../../src/main/sync/tab-host'
import { RemoteTabs, type ViewerEvents } from '../../src/main/sync/tab-viewer'
import type { HelloMessage, Message } from '../../src/main/sync/wire'
import {
  MAX_INPUT_CHARS,
  MAX_OUT_CHARS,
  MAX_REMOTE_TABS,
  type PushKind,
  type RemoteSnapshot,
  type RemoteTab
} from '../../src/shared/remote'
import { headless, replay, textOf } from '../fixtures/screen'
import { closeLinkPairs, linkPair, until } from '../fixtures/sync'

const A_ID = 'a1000000-0000-4000-8000-000000000001'
const B_ID = 'b1000000-0000-4000-8000-000000000001'
const C_ID = 'c1000000-0000-4000-8000-000000000001'
const T1 = tabId(1)
const T2 = tabId(2)
const T_LOCAL = tabId(0x1000)
const T_C = tabId(0x1001)
const T_MARK = tabId(0x1002)

/** an invented tab id: the n-th of a series */
function tabId(n: number): string {
  return `d0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** an invented tab of a device, with the fields a RemoteTab carries */
function tab(id: string, over: Partial<RemoteTab> = {}): RemoteTab {
  return {
    id,
    kind: 'shell',
    profile: 'bash',
    cwd: '/work/demo',
    folder: '/work/demo',
    customTitle: null,
    title: null,
    claudeSessionId: null,
    account: null,
    accountName: null,
    muted: false,
    exited: false,
    working: false,
    attention: null,
    attentionSeq: 0,
    images: 0,
    note: false,
    counter: null,
    status: null,
    size: { cols: 80, rows: 24, by: null },
    place: null,
    placeKnown: true,
    forkOf: null,
    fork: false,
    ...over
  }
}

function helloOf(id: string, name: string, platform: DevicePlatform = 'linux'): HelloMessage {
  return { t: 'hello', v: 1, id, name, platform, port: 0, addresses: [], reachedYou: null }
}

/** the tabs of a device as the test sets them; every call records what the host passed on */
function fakeTabs() {
  const fake = {
    entries: [] as RemoteTab[],
    pushList: [] as { k: PushKind; v: unknown }[],
    inputs: [] as [string, string, string][],
    claims: [] as [string, string, number, number][],
    fronts: [] as [string, string | null, boolean][],
    list: (): RemoteTab[] => fake.entries,
    has: (id: string): boolean => fake.entries.some((t) => t.id === id),
    input: (id: string, data: string, from: string): void => {
      fake.inputs.push([id, data, from])
    },
    claim: (id: string, from: string, cols: number, rows: number): void => {
      fake.claims.push([id, from, cols, rows])
    },
    front: (from: string, id: string | null, focused: boolean): void => {
      fake.fronts.push([from, id, focused])
    },
    pushes: (): { k: PushKind; v: unknown }[] => fake.pushList
  }
  return fake
}

/** a screen copy that answers every method without effect and every snapshot with an empty one */
function noopMirrors(): ScreenMirrorsApi {
  return {
    open: () => {},
    write: () => {},
    resize: () => {},
    reset: () => {},
    close: () => {},
    seed: () => {},
    onTitle: () => {},
    dispose: () => {},
    snapshot: async () => ({ data: '', seq: 0, cols: 40, rows: 10 })
  }
}

interface Ev {
  name: string
  id: string
  value?: unknown
}

/** the viewer's events, recorded in order into `log` */
function recordingEvents(log: Ev[]): ViewerEvents {
  return {
    opened: (device, t) => log.push({ name: 'opened', id: t.id, value: device }),
    updated: (_device, t) => log.push({ name: 'updated', id: t.id, value: t }),
    closed: (id) => log.push({ name: 'closed', id }),
    devices: (list) => log.push({ name: 'devices', id: '', value: list }),
    data: (id, data) => log.push({ name: 'data', id, value: data }),
    reset: (id) => log.push({ name: 'reset', id }),
    exit: (id, code) => log.push({ name: 'exit', id, value: code }),
    size: (id, size) => log.push({ name: 'size', id, value: size }),
    attention: (id, reason, fresh) => log.push({ name: 'attention', id, value: { reason, fresh } }),
    attentionCleared: (id) => log.push({ name: 'attentionCleared', id }),
    push: (id, value) => log.push({ name: 'push', id, value })
  }
}

/** the event names of a tab's stream and directory, in order (sizes are read with sizes()) */
const STEP_NAMES = ['opened', 'updated', 'closed', 'reset', 'data', 'exit']

interface World {
  log: Ev[]
  viewer: RemoteTabs
  /** whether this device's window is focused, as the viewer is told it */
  focus: { on: boolean }
  hostB: TabHost
  teardown: (() => void)[]
  steps(id: string): string[]
  written(id: string): string
  /** the data events of a tab, one entry per event */
  dataOf(id: string): string[]
  sizes(id: string): unknown[]
}

/** the viewing device B: its RemoteTabs and its own (empty) TabHost */
function world(reattachMs = 50): World {
  const log: Ev[] = []
  const teardown: (() => void)[] = []
  const focus = { on: false }
  const hostB = new TabHost({ tabs: fakeTabs(), mirrors: new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 }) })
  teardown.push(() => hostB.dispose())
  const viewer = new RemoteTabs({
    selfId: () => B_ID,
    isLocal: (id) => id === T_LOCAL,
    windowFocused: () => focus.on,
    events: recordingEvents(log),
    reattachMs
  })
  teardown.push(() => viewer.dispose())
  return {
    log,
    viewer,
    focus,
    hostB,
    teardown,
    steps: (id) => log.filter((e) => e.id === id && STEP_NAMES.includes(e.name)).map((e) => e.name),
    written: (id) =>
      log
        .filter((e) => e.name === 'data' && e.id === id)
        .map((e) => e.value as string)
        .join(''),
    dataOf: (id) => log.filter((e) => e.name === 'data' && e.id === id).map((e) => e.value as string),
    sizes: (id) => log.filter((e) => e.name === 'size' && e.id === id).map((e) => e.value)
  }
}

/** a remote device: its tabs, its screen copies and its TabHost */
function remote(id: string, mirrors: ScreenMirrorsApi = new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 })) {
  const fake = fakeTabs()
  const host = new TabHost({ tabs: fake, mirrors })
  return { id, fake, mirrors, host }
}
type Remote = ReturnType<typeof remote>

/** sets the remote's tabs and announces the change to the members it has */
function setTabs(r: Remote, list: RemoteTab[]): void {
  r.fake.entries = list
  r.host.changed()
}

/** a tab of the remote, opened on its screen copy */
function openTab(r: Remote, id: string, cols = 80, rows = 24): void {
  r.host.opened(id, cols, rows, 1000)
}

/**
 * Links the viewer to a remote device on a loopback pair: connectPeer runs on both ends, as the group does.
 * Returns the remote's end of the link and the viewer's end.
 */
async function connect(w: World, r: Remote, name = `device ${r.id.slice(0, 2)}`): Promise<{ remote: PeerLink; local: PeerLink; tlsLocal: tls.TLSSocket }> {
  const pair = await linkPair()
  const remoteViewer = new RemoteTabs({ selfId: () => r.id, isLocal: () => false, events: recordingEvents([]) })
  w.teardown.push(() => remoteViewer.dispose())
  connectPeer(pair.client, helloOf(r.id, name), w.hostB, w.viewer, {})
  connectPeer(pair.server, helloOf(B_ID, 'viewer'), r.host, remoteViewer, {})
  return { remote: pair.server, local: pair.client, tlsLocal: pair.clientSocket }
}

/**
 * A screen copy whose snapshots wait until `gate.release()`; `gate.pending` counts the asks waiting. Every ask is
 * answered with an empty snapshot.
 */
function heldMirrors() {
  const waiting: (() => void)[] = []
  const gate = {
    asks: 0,
    get pending(): number {
      return waiting.length
    },
    release(): void {
      for (const w of waiting.splice(0)) w()
    },
    /** releases the oldest snapshot still waiting only */
    releaseOldest(): void {
      waiting.shift()?.()
    }
  }
  const mirrors: ScreenMirrorsApi = {
    ...noopMirrors(),
    snapshot: () => {
      gate.asks++
      return new Promise<RemoteSnapshot | null>((resolve) => waiting.push(() => resolve({ data: '', seq: 0, cols: 40, rows: 10 })))
    }
  }
  return { mirrors, gate }
}

/** resolves once the next reply reaches the link, after its Calls has settled the call (one turn of microtasks later) */
async function nextReply(link: PeerLink): Promise<void> {
  await new Promise<void>((resolve) => {
    const seen = (m: { t: string }): void => {
      if (m.t !== 'reply') return
      link.off('message', seen)
      resolve()
    }
    link.on('message', seen)
  })
  await new Promise((resolve) => setImmediate(resolve))
}

/** resolves once the wall clock has passed `ms` from now: a checked deadline, polled, not a fixed sleep */
async function deadline(ms: number): Promise<void> {
  const end = Date.now() + ms
  await until(() => Date.now() >= end, ms + 5000)
}

/** a screen copy whose snapshot is null the first time and empty after that; `snapshots` counts the asks */
function flakyMirrors(counter: { snapshots: number }): ScreenMirrorsApi {
  return {
    ...noopMirrors(),
    snapshot: async (): Promise<RemoteSnapshot | null> => {
      counter.snapshots++
      return counter.snapshots === 1 ? null : { data: '', seq: 0, cols: 40, rows: 10 }
    }
  }
}

/** one end of a test link: what it sends waits in `queue` until `deliver` hands it to the other end, in order */
class HeldLink extends EventEmitter {
  readonly queue: Message[] = []

  send(m: Message): boolean {
    this.queue.push(m)
    return true
  }

  sendBulk(m: Message): boolean {
    this.queue.push(m)
    return true
  }

  backlog(): number {
    return 0
  }
}

/** hands what waits on `from` to `to`, in order, as the 'message' events of `to` */
function deliver(from: HeldLink, to: HeldLink): void {
  for (const m of from.queue.splice(0)) to.emit('message', m)
}

/** the held end of a link, as connectPeer and Calls take it */
const asLink = (l: HeldLink): PeerLink => l as unknown as PeerLink

/** lets the calls of the links settle: their replies are queued after one turn of microtasks */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('remote tabs', () => {
  let worlds: World[] = []
  let remotes: Remote[] = []

  function newWorld(reattachMs?: number): World {
    const w = world(reattachMs)
    worlds.push(w)
    return w
  }

  function newRemote(id: string, mirrors?: ScreenMirrorsApi): Remote {
    const r = remote(id, mirrors)
    remotes.push(r)
    return r
  }

  afterEach(async () => {
    for (const w of worlds) for (const f of w.teardown.reverse()) f()
    for (const r of remotes) {
      r.host.dispose()
      r.mirrors.dispose()
    }
    worlds = []
    remotes = []
    await closeLinkPairs()
  })

  it("the other device's directory shows as its tabs, and the changes follow", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    setTabs(a, [tab(T1, { customTitle: 'build' })])
    await until(() => w.viewer.tab(T1)?.customTitle === 'build')
    setTabs(a, [])
    await until(() => !w.viewer.has(T1))
    expect(w.steps(T1)).toEqual(['opened', 'updated', 'closed'])
  })

  it("a device whose directory arrives before this viewer listens on the link (a restart) still shows its tabs", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1), tab(T2)])
    const pair = await linkPair()
    const remoteViewer = new RemoteTabs({ selfId: () => B_ID, isLocal: () => false, events: recordingEvents([]) })
    w.teardown.push(() => remoteViewer.dispose())
    // the device's side comes up first: its directory goes out on a link this window does not listen to yet, so no listener takes it
    connectPeer(pair.server, helloOf(B_ID, 'viewer'), a.host, remoteViewer, {})
    const arrived = new Promise<void>((resolve) => pair.client.once('message', () => resolve()))
    await arrived
    connectPeer(pair.client, helloOf(A_ID, 'device a'), w.hostB, w.viewer, {})
    await until(() => w.viewer.has(T1) && w.viewer.has(T2))
    expect(w.viewer.tabsOf(A_ID).map((t) => t.id).sort()).toEqual([T1, T2].sort())
  })

  it('a change made in the same turn as the viewer asks for the directory is not undone by its answer', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1, { attention: 'done', attentionSeq: 1 })])
    const dummy = new RemoteTabs({ selfId: () => A_ID, isLocal: () => false, events: recordingEvents([]) })
    w.teardown.push(() => dummy.dispose())
    const aLink = new HeldLink()
    const bLink = new HeldLink()
    connectPeer(asLink(aLink), helloOf(B_ID, 'viewer'), a.host, dummy, {})
    connectPeer(asLink(bLink), helloOf(A_ID, 'device a'), w.hostB, w.viewer, {})
    // A serves B's call, and in the same turn its tab in front stops waiting: the change goes out after the list it served
    deliver(bLink, aLink)
    a.fake.entries = [tab(T1)]
    a.host.changed()
    await settle()
    deliver(aLink, bLink)
    expect(w.viewer.has(T1)).toBe(true)
    expect(w.viewer.tab(T1)?.attention ?? null).toBeNull()
  })

  it("a plan push says whether the plan is the agent's task list; a flag that is not a boolean drops the push", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => a.host.watchers(T1).length === 1)
    const list = { title: 'Release prep', tasks: [{ n: 1, title: 'Tag the release', state: 'done' }], done: 1, total: 1, finished: false }
    a.host.push(T1, 'plan', { ...list, agentList: true })
    await until(() => w.log.some((e) => e.name === 'push' && e.id === T1))
    // a flag that is not true, false or absent: the push is dropped, and the next one arrives
    a.host.push(T1, 'plan', { ...list, title: 'Dropped', agentList: 'yes' })
    a.host.push(T1, 'plan', { ...list, title: 'Next' })
    await until(() => w.log.some((e) => e.name === 'push' && e.id === T1 && (e.value as { v: { title: string } }).v.title === 'Next'))
    const pushes = w.log.filter((e) => e.name === 'push' && e.id === T1).map((e) => e.value)
    expect(pushes).toEqual([
      { k: 'plan', v: list, agentList: true },
      { k: 'plan', v: { ...list, title: 'Next' }, agentList: false }
    ])
  })

  it('a list that comes as an answer to the viewer\'s call counts as its first list: a later attention of its tab is fresh', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    const dummy = new RemoteTabs({ selfId: () => A_ID, isLocal: () => false, events: recordingEvents([]) })
    w.teardown.push(() => dummy.dispose())
    const aLink = new HeldLink()
    const bLink = new HeldLink()
    connectPeer(asLink(aLink), helloOf(B_ID, 'viewer'), a.host, dummy, {})
    // the list A sends when the link comes up goes to no listener, as after a restart
    aLink.queue.length = 0
    connectPeer(asLink(bLink), helloOf(A_ID, 'device a'), w.hostB, w.viewer, {})
    deliver(bLink, aLink)
    await settle()
    deliver(aLink, bLink)
    expect(w.viewer.has(T1)).toBe(true)
    a.fake.entries = [tab(T1, { attention: 'done', attentionSeq: 1 })]
    a.host.changed()
    deliver(aLink, bLink)
    expect(w.log.filter((e) => e.name === 'attention' && e.id === T1)).toEqual([{ name: 'attention', id: T1, value: { reason: 'done', fresh: true } }])
  })

  it('a device that does not know the tabs call still lists its tabs through its first list, and the refusal shows nothing', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    const aLink = new HeldLink()
    const bLink = new HeldLink()
    connectPeer(asLink(bLink), helloOf(A_ID, 'device a'), w.hostB, w.viewer, {})
    // an older device: its Calls know no tabs method, so it refuses the call
    new Calls(asLink(aLink), {})
    a.host.addPeer(asLink(aLink), B_ID)
    deliver(aLink, bLink)
    expect(w.viewer.has(T1)).toBe(true)
    deliver(bLink, aLink)
    await settle()
    deliver(aLink, bLink)
    expect(w.viewer.has(T1)).toBe(true)
  })

  it('a tabs call with bad arguments is refused, and no list is sent', async () => {
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    const dummy = new RemoteTabs({ selfId: () => A_ID, isLocal: () => false, events: recordingEvents([]) })
    const aLink = new HeldLink()
    connectPeer(asLink(aLink), helloOf(B_ID, 'viewer'), a.host, dummy, {})
    aLink.queue.length = 0
    aLink.emit('message', { t: 'call', id: 99, m: 'tabs', a: null })
    await settle()
    expect(aLink.queue).toEqual([{ t: 'reply', id: 99, ok: false, e: 'bad arguments' }])
    dummy.dispose()
  })

  it("a device's list with one entry that fails the check still shows its other tabs when its link comes up first", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1), tab('not-a-uuid'), tab(T2)])
    const pair = await linkPair()
    const remoteViewer = new RemoteTabs({ selfId: () => B_ID, isLocal: () => false, events: recordingEvents([]) })
    w.teardown.push(() => remoteViewer.dispose())
    connectPeer(pair.server, helloOf(B_ID, 'viewer'), a.host, remoteViewer, {})
    const arrived = new Promise<void>((resolve) => pair.client.once('message', () => resolve()))
    await arrived
    connectPeer(pair.client, helloOf(A_ID, 'device a'), w.hostB, w.viewer, {})
    await until(() => w.viewer.has(T1) && w.viewer.has(T2))
    expect(w.viewer.tabsOf(A_ID).map((t) => t.id).sort()).toEqual([T1, T2].sort())
  })

  it('switching to a tab attaches: the screen and the scrollback come first, then the stream', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1, { size: { cols: 40, rows: 10, by: null } })])
    openTab(a, T1, 40, 10)
    a.host.output(T1, 'earlier\r\n')
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => w.written(T1).includes('earlier'))
    a.host.output(T1, 'later')
    await until(() => w.written(T1).endsWith('later'))
    expect(w.steps(T1)[1]).toBe('reset')
    expect(w.sizes(T1)[0]).toEqual({ cols: 40, rows: 10 })
  })

  it('the screen here equals the screen there after a burst with emoji and an escape sequence across piece boundaries', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1, { size: { cols: 40, rows: 10, by: null } })])
    openTab(a, T1, 40, 10)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => w.steps(T1).includes('reset'))
    // the first cut falls inside the escape sequence, the second on a high surrogate
    const burst = 'x'.repeat(MAX_OUT_CHARS - 3) + '\x1b[1;31mred\x1b[0m' + '😀'.repeat(MAX_OUT_CHARS) + '\r\nend'
    a.host.output(T1, burst)
    await until(() => w.written(T1).endsWith('end'))
    const there = (await a.mirrors.snapshot(T1))!
    // the device's copy keeps 1000 lines of scrollback: the viewer's terminal keeps the same; one write per data event
    const viewerScreen = headless(40, 10, 1000)
    for (const d of w.dataOf(T1)) await new Promise<void>((resolve) => viewerScreen.write(d, resolve))
    expect(textOf(viewerScreen)).toEqual(textOf(await replay(there)))
  })

  it("input reaches the tab on its device, after a claim at this window's size", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    w.viewer.fit(T1, 90, 20)
    w.viewer.input(T1, 'ls\r')
    await until(() => a.fake.inputs.length === 1)
    expect(a.fake.claims).toEqual([[T1, B_ID, 90, 20]])
    expect(a.fake.inputs).toEqual([[T1, 'ls\r', B_ID]])
  })

  it('a device that goes leaves its tabs offline and drops input to them; when it comes back they come back from a fresh snapshot', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    a.host.output(T1, 'first\r\n')
    const first = await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => w.written(T1).includes('first'))
    first.remote.close('test')
    await until(() => !w.viewer.online(A_ID))
    expect(w.viewer.has(T1)).toBe(true)
    w.viewer.input(T1, 'lost')
    await connect(w, a)
    await until(() => w.viewer.online(A_ID))
    await until(() => w.steps(T1).filter((s) => s === 'reset').length === 2)
    await until(() => w.steps(T1).slice(-1)[0] === 'data')
    expect(w.steps(T1).slice(-2)).toEqual(['reset', 'data'])
    expect(a.fake.inputs.some(([, d]) => d === 'lost')).toBe(false)
  })

  it("a device's first list on a link raises the devices event even when it adds and removes no tab; a later list the same does not", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [])
    // the devices event records whether the device was online with its list in when it fired (a removal fires it too, with the list still set)
    const listedAtEvent: boolean[] = []
    const viewer: RemoteTabs = new RemoteTabs({
      selfId: () => B_ID,
      isLocal: () => false,
      events: { ...recordingEvents([]), devices: () => listedAtEvent.push(viewer.online(A_ID) && viewer.listedOf(A_ID)) }
    })
    w.teardown.push(() => viewer.dispose())
    const pair = await linkPair()
    const remoteViewer = new RemoteTabs({ selfId: () => A_ID, isLocal: () => false, events: recordingEvents([]) })
    w.teardown.push(() => remoteViewer.dispose())
    connectPeer(pair.client, helloOf(A_ID, 'Studio'), w.hostB, viewer, {})
    connectPeer(pair.server, helloOf(B_ID, 'viewer'), a.host, remoteViewer, {})
    await until(() => viewer.listedOf(A_ID))
    // the first list is empty: no tab opens or closes, and the event still comes once with the device listed
    expect(listedAtEvent.filter((x) => x)).toHaveLength(1)
    // the second list this link gets is the one the tabs call of addPeer asks for: the same as the first, so no first list and no event
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(listedAtEvent.filter((x) => x)).toHaveLength(1)
    // a relink with the same list (no tab) is a first list again: the event comes once more
    pair.server.close('test')
    await until(() => !viewer.online(A_ID))
    const again = await linkPair()
    const remoteAgain = new RemoteTabs({ selfId: () => A_ID, isLocal: () => false, events: recordingEvents([]) })
    w.teardown.push(() => remoteAgain.dispose())
    connectPeer(again.client, helloOf(A_ID, 'Studio'), w.hostB, viewer, {})
    connectPeer(again.server, helloOf(B_ID, 'viewer'), a.host, remoteAgain, {})
    await until(() => listedAtEvent.filter((x) => x).length === 2)
    expect(viewer.listedOf(A_ID)).toBe(true)
  })

  it("a tab announced with the id of a local tab or of another device's tab is ignored", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    const c = newRemote(C_ID)
    setTabs(c, [tab(T_C)])
    await connect(w, c)
    await until(() => w.viewer.has(T_C))
    const link = await connect(w, a)
    await nextReply(link.local)
    link.remote.send({ t: 'tabs', tabs: [tab(T_LOCAL), tab(T_C), tab(T1)] })
    await until(() => w.viewer.has(T1))
    expect(w.viewer.deviceOf(T_LOCAL)).toBeNull()
    expect(w.viewer.deviceOf(T_C)).toBe(C_ID)
    expect(w.viewer.tabsOf(A_ID).map((t) => t.id)).toEqual([T1])
    link.remote.send({ t: 'tab', tab: tab(T_C, { customTitle: 'stolen' }) })
    link.remote.send({ t: 'tab', tab: tab(T2) })
    await until(() => w.viewer.has(T2))
    expect(w.viewer.tab(T_C)?.customTitle).not.toBe('stolen')
  })

  it('a device cannot announce more than MAX_REMOTE_TABS tabs', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    const link = await connect(w, a)
    const many = Array.from({ length: MAX_REMOTE_TABS }, (_, i) => tab(tabId(i + 1)))
    await nextReply(link.local)
    link.remote.send({ t: 'tabs', tabs: many })
    link.remote.send({ t: 'tab', tab: tab(tabId(MAX_REMOTE_TABS + 1)) })
    link.remote.send({ t: 'tab', tab: tab(tabId(MAX_REMOTE_TABS + 2)) })
    link.remote.send({ t: 'tab-closed', id: tabId(1) })
    await until(() => w.viewer.tabsOf(A_ID).length === MAX_REMOTE_TABS - 1)
    expect(w.viewer.has(tabId(MAX_REMOTE_TABS + 1))).toBe(false)
    expect(w.viewer.has(tabId(MAX_REMOTE_TABS + 2))).toBe(false)
  })

  it('the tab in front is told to its device, and none once the window goes to a local tab', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => a.fake.fronts.length === 1)
    w.viewer.activated(T_LOCAL)
    await until(() => a.fake.fronts.length === 2)
    expect(a.fake.fronts).toEqual([
      [B_ID, T1, false],
      [B_ID, null, false]
    ])
  })

  it("the tab in front is told whether this window is focused, and again when the window's focus changes", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => a.fake.fronts.length === 1)
    expect(a.fake.fronts[0]).toEqual([B_ID, T1, false])
    w.focus.on = true
    w.viewer.focusChanged(true)
    await until(() => a.fake.fronts.length === 2)
    expect(a.fake.fronts[1]).toEqual([B_ID, T1, true])
    w.focus.on = false
    w.viewer.focusChanged(false)
    await until(() => a.fake.fronts.length === 3)
    expect(a.fake.fronts[2]).toEqual([B_ID, T1, false])
  })

  it('a window focus change with no remote tab in front sends nothing', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.focus.on = true
    w.viewer.focusChanged(true)
    w.viewer.activated(T_LOCAL)
    w.focus.on = false
    w.viewer.focusChanged(false)
    await new Promise((r) => setTimeout(r, 50))
    expect(a.fake.fronts).toEqual([])
  })

  it('a tab sized for this device fits; one sized for another keeps that size here', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1, { size: { cols: 80, rows: 24, by: B_ID } })])
    await connect(w, a)
    await until(() => w.sizes(T1).length === 1)
    expect(w.sizes(T1).at(-1)).toBeNull()
    setTabs(a, [tab(T1, { size: { cols: 100, rows: 30, by: C_ID } })])
    await until(() => w.sizes(T1).length === 2)
    expect(w.sizes(T1).at(-1)).toEqual({ cols: 100, rows: 30 })
  })

  it('an attention that starts is fresh; one the tab had when its device came is not; a clear is reported', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1, { attention: 'permission', attentionSeq: 1 })])
    await connect(w, a)
    await until(() => w.log.some((e) => e.name === 'attention' && e.id === T1))
    setTabs(a, [tab(T1, { attention: 'done', attentionSeq: 2 })])
    await until(() => w.log.some((e) => e.name === 'attention' && e.id === T1 && (e.value as { fresh: boolean }).fresh))
    setTabs(a, [tab(T1, { attention: null, attentionSeq: 2 })])
    await until(() => w.log.some((e) => e.name === 'attentionCleared' && e.id === T1))
    const seen = w.log.filter((e) => e.name === 'attention' && e.id === T1).map((e) => e.value)
    expect(seen).toEqual([
      { reason: 'permission', fresh: false },
      { reason: 'done', fresh: true }
    ])
  })

  it('a detached tab in front is attached again', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    const link = await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => w.steps(T1).includes('reset'))
    link.remote.send({ t: 'detached', id: T1 })
    await until(() => w.steps(T1).filter((s) => s === 'reset').length === 2)
  })

  it('a failed attach of the tab in front is tried again after reattachMs, without another switch', async () => {
    const w = newWorld(50)
    const counter = { snapshots: 0 }
    const a = newRemote(A_ID, flakyMirrors(counter))
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => w.steps(T1).includes('reset'))
    expect(counter.snapshots).toBe(2)
  })

  it('fits of a tab never activated here are not claims', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1), tab(T2)])
    openTab(a, T1)
    openTab(a, T2)
    await connect(w, a)
    await until(() => w.viewer.has(T2))
    // the window measures a hidden terminal at 80x24 before it is ever shown: that fit is not a claim
    w.viewer.fit(T1, 80, 24)
    w.viewer.activated(T1)
    w.viewer.input(T1, 'x')
    await until(() => a.fake.inputs.length === 1)
    expect(a.fake.claims).toEqual([])
  })

  // R1: only the device that announced a tab may speak for it
  it('R1: a device sending output, push, close, exit or detach for another device\'s tab reaches nothing', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    const c = newRemote(C_ID)
    setTabs(c, [tab(T_C)])
    openTab(c, T_C)
    await connect(w, c)
    await until(() => w.viewer.has(T_C))
    const link = await connect(w, a)
    await nextReply(link.local)
    await until(() => w.viewer.online(A_ID))
    w.viewer.activated(T_C)
    await until(() => w.steps(T_C).includes('reset'))
    const before = w.log.length
    link.remote.send({ t: 'out', id: T_C, seq: 1, d: 'forged' })
    link.remote.send({ t: 'push', id: T_C, k: 'status', v: { main: null, agents: [] } })
    link.remote.send({ t: 'reset', id: T_C, seq: 2 })
    link.remote.send({ t: 'exit', id: T_C, seq: 3, code: 0 })
    link.remote.send({ t: 'detached', id: T_C })
    link.remote.send({ t: 'tab-closed', id: T_C })
    // the marker: a tab of A, on the same link
    link.remote.send({ t: 'tab', tab: tab(T_MARK) })
    await until(() => w.viewer.has(T_MARK))
    expect(w.viewer.deviceOf(T_C)).toBe(C_ID)
    expect(w.log.slice(before).filter((e) => e.id === T_C)).toEqual([])
  })

  // R2: input pieces never split a surrogate pair
  it('R2: an input of a surrogate-heavy text arrives whole, and no piece ends in a high surrogate', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    const text = 'a' + '😀'.repeat(MAX_INPUT_CHARS)
    w.viewer.input(T1, text)
    await until(() => a.fake.inputs.map(([, d]) => d).join('') === text)
    for (const [, d] of a.fake.inputs) expect(d).not.toMatch(/[\ud800-\udbff]$/)
  })

  // R3: dispose() ends everything
  it('R3: after dispose(), a message from the device fires no event; a marker on a second viewer shows it was received', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    const link = await connect(w, a)
    await nextReply(link.local)
    await until(() => w.viewer.has(T1))
    w.viewer.dispose()
    expect(w.viewer.has(T1)).toBe(false)
    expect(w.viewer.online(A_ID)).toBe(false)
    const after = w.log.length
    // a second viewer on the same link: its marker follows the message that must not reach the first one
    const log2: Ev[] = []
    const second = new RemoteTabs({ selfId: () => B_ID, isLocal: () => false, events: recordingEvents(log2) })
    w.teardown.push(() => second.dispose())
    const calls = new Calls(link.local, {})
    second.addPeer(link.local, helloOf(A_ID, 'device'), calls)
    await nextReply(link.local)
    link.remote.send({ t: 'tab', tab: tab(T2) })
    link.remote.send({ t: 'tab', tab: tab(T_MARK) })
    await until(() => second.has(T_MARK))
    expect(w.log.length).toBe(after)
    expect(w.viewer.has(T2)).toBe(false)
    expect(second.has(T2)).toBe(true)
  })

  it('removePeer on a link it does not know is a no-op', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    const stranger = await linkPair()
    w.viewer.removePeer(stranger.client)
    expect(w.viewer.online(A_ID)).toBe(true)
    expect(w.viewer.has(T1)).toBe(true)
    // the link is still the viewer's: its tab attaches as before
    w.viewer.activated(T1)
    await until(() => w.steps(T1).includes('reset'))
  })

  // Important 1: an answer that arrives after dispose() fires nothing
  it('an attach answer held back until after dispose() fires no event', async () => {
    const w = newWorld()
    const { mirrors, gate } = heldMirrors()
    const held = newRemote(A_ID, mirrors)
    setTabs(held, [tab(T1)])
    openTab(held, T1)
    const link = await connect(w, held)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => gate.pending === 1)
    w.viewer.dispose()
    const after = w.log.length
    gate.release()
    await nextReply(link.local)
    expect(w.log.length).toBe(after)
  })

  // Minor 2: a tab closed while its attach is out, and announced again, takes no answer of the old attach
  it('a tab closed while its attach is out, then announced again, takes no answer of the old attach', async () => {
    const w = newWorld(50)
    const { mirrors, gate } = heldMirrors()
    const held = newRemote(A_ID, mirrors)
    setTabs(held, [tab(T1)])
    openTab(held, T1)
    const link = await connect(w, held)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => gate.asks === 1)
    link.remote.send({ t: 'tab-closed', id: T1 })
    await until(() => !w.viewer.has(T1))
    link.remote.send({ t: 'tab', tab: tab(T1) })
    await until(() => w.viewer.has(T1))
    const before = w.log.length
    w.viewer.activated(T1)
    await until(() => gate.asks === 2)
    // the old attach's answer comes first, while the new tab's attach is out: it reaches nothing and asks nothing
    gate.releaseOldest()
    await nextReply(link.local)
    await deadline(3 * 50)
    expect(gate.asks).toBe(2)
    gate.release()
    await until(() => w.steps(T1).includes('reset'))
    expect(w.log.slice(before).filter((e) => e.id === T1 && e.name === 'reset')).toHaveLength(1)
  })

  // Minor 4: a second link for a device replaces the first while its attach is out: the attach goes out on the new link
  it('a second link for a device, replacing one with an attach out, attaches the tab in front at once', async () => {
    const w = newWorld(50)
    const { mirrors, gate } = heldMirrors()
    const held = newRemote(A_ID, mirrors)
    setTabs(held, [tab(T1)])
    openTab(held, T1)
    await connect(w, held)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => gate.asks === 1)
    await connect(w, held)
    await until(() => gate.asks === 2)
    gate.release()
    await until(() => w.steps(T1).includes('reset'))
    expect(gate.asks).toBe(2)
  })

  // Important 2: one attach per tab at a time
  it('a loss while the attach is out starts no second attach until the first settles', async () => {
    const w = newWorld(50)
    const { mirrors, gate } = heldMirrors()
    const held = newRemote(A_ID, mirrors)
    setTabs(held, [tab(T1)])
    openTab(held, T1)
    const link = await connect(w, held)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await until(() => gate.pending === 1)
    link.remote.send({ t: 'detached', id: T1 })
    await deadline(3 * 50)
    expect(gate.asks).toBe(1)
    gate.release()
    // the first answer is out of date: the tab needs a view, so one more attach goes out once it settled
    await until(() => gate.asks === 2)
    gate.release()
    await until(() => w.steps(T1).includes('reset'))
    expect(gate.asks).toBe(2)
  })

  // Minor 3: switching away gives no attach; switching back attaches
  it('switching away within reattachMs gives no attach; switching back attaches', async () => {
    const w = newWorld(50)
    const counter = { snapshots: 0 }
    const a = newRemote(A_ID, flakyMirrors(counter))
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    const link = await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    // the first ask is refused: the tab in front waits for its timer
    await nextReply(link.local)
    expect(counter.snapshots).toBe(1)
    // a local tab in front: the window goes away from the remote tab
    w.viewer.activated(T_LOCAL)
    await deadline(3 * 50)
    expect(counter.snapshots).toBe(1)
    w.viewer.activated(T1)
    await until(() => w.steps(T1).includes('reset'))
    expect(counter.snapshots).toBe(2)
  })

  // Minor 3: a tab that is attached but not in front is attached again when its device comes back
  it('a non-front attached tab is attached again when its device comes back', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1), tab(T2)])
    openTab(a, T1)
    openTab(a, T2)
    const first = await connect(w, a)
    await until(() => w.viewer.has(T2))
    w.viewer.activated(T2)
    await until(() => w.steps(T2).includes('reset'))
    w.viewer.activated(T1)
    await until(() => w.steps(T1).includes('reset'))
    first.remote.close('test')
    await until(() => !w.viewer.online(A_ID))
    await connect(w, a)
    await until(() => w.steps(T2).filter((s) => s === 'reset').length === 2)
    expect(w.steps(T2).filter((s) => s === 'reset').length).toBe(2)
  })

  // Minor 3: dispose() with a pending reattach timer: nothing fires afterwards
  it('dispose() with a pending reattach timer fires nothing afterwards', async () => {
    const w = newWorld(50)
    const counter = { snapshots: 0 }
    const a = newRemote(A_ID, flakyMirrors(counter))
    setTabs(a, [tab(T1)])
    openTab(a, T1)
    const link = await connect(w, a)
    await until(() => w.viewer.has(T1))
    w.viewer.activated(T1)
    await nextReply(link.local)
    expect(counter.snapshots).toBe(1)
    w.viewer.dispose()
    const after = w.log.length
    await deadline(3 * 50)
    expect(counter.snapshots).toBe(1)
    expect(w.log.length).toBe(after)
  })

  // devices(): by name, only the devices seen this run
  it('devices() lists the devices linked this run, sorted by name', async () => {
    const w = newWorld()
    const zed = newRemote('e1000000-0000-4000-8000-000000000001')
    const alpha = newRemote('f1000000-0000-4000-8000-000000000001')
    await connect(w, zed, 'Zed')
    await connect(w, alpha, 'Alpha')
    await until(() => w.viewer.devices().length === 2)
    expect(w.viewer.devices().map((d) => d.name)).toEqual(['Alpha', 'Zed'])
  })

  it('members() does not add a device that never linked this run', async () => {
    const w = newWorld()
    const zed = newRemote('e1000000-0000-4000-8000-000000000001')
    await connect(w, zed, 'Zed')
    await until(() => w.viewer.devices().length === 1)
    const view = (id: string, name: string): DeviceView => ({
      id,
      name,
      platform: 'linux',
      state: { kind: 'unknown' },
      addedBy: 'Zed',
      addedAt: 0,
      address: null
    })
    w.viewer.members([view(zed.id, 'Zed'), view(C_ID, 'Ghost')])
    expect(w.viewer.devices().map((d) => d.name)).toEqual(['Zed'])
  })

  it("a fork keeps its head only when the head is a tab of the same device: another device's tab, or no tab, is no head", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    const c = newRemote(C_ID)
    setTabs(c, [tab(T_C)])
    await connect(w, c)
    await until(() => w.viewer.has(T_C))
    setTabs(a, [tab(T1), tab(T2, { fork: true, forkOf: T_C }), tab(T_MARK, { fork: true, forkOf: tabId(0x1003) }), tab(tabId(0x1004), { fork: true, forkOf: T1 })])
    await connect(w, a)
    await until(() => w.viewer.has(tabId(0x1004)))
    expect(w.viewer.tab(T2)).toMatchObject({ forkOf: null, fork: true })
    expect(w.viewer.tab(T_MARK)).toMatchObject({ forkOf: null, fork: true })
    expect(w.viewer.tab(tabId(0x1004))).toMatchObject({ forkOf: T1, fork: true })
  })

  it('a fork whose head closed on its device, without an update of the fork, is kept as a fork with no head', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1), tab(T2, { fork: true, forkOf: T1 })])
    const link = await connect(w, a)
    await nextReply(link.local)
    await until(() => w.viewer.tab(T2)?.forkOf === T1)
    link.remote.send({ t: 'tab-closed', id: T1 })
    await until(() => !w.viewer.has(T1))
    expect(w.viewer.tab(T2)).toMatchObject({ forkOf: null, fork: true })
    expect(w.steps(T2)).toEqual(['opened', 'updated'])
  })

  it("a single tab message whose fork names another device's tab is a fork with no head", async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    const c = newRemote(C_ID)
    setTabs(c, [tab(T_C)])
    await connect(w, c)
    await until(() => w.viewer.has(T_C))
    const link = await connect(w, a)
    await nextReply(link.local)
    link.remote.send({ t: 'tabs', tabs: [tab(T1)] })
    await until(() => w.viewer.has(T1))
    link.remote.send({ t: 'tab', tab: tab(T2, { fork: true, forkOf: T_C }) })
    await until(() => w.viewer.has(T2))
    expect(w.viewer.tab(T2)).toMatchObject({ forkOf: null, fork: true })
  })

  it('a list where a fork comes before its head keeps the head', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T2, { fork: true, forkOf: T1 }), tab(T1)])
    await connect(w, a)
    await until(() => w.viewer.has(T2))
    expect(w.viewer.tab(T2)).toMatchObject({ forkOf: T1, fork: true })
  })

  it('a device that has not published its place yet sends placeKnown false; the viewer keeps it until the place comes', async () => {
    const w = newWorld()
    const a = newRemote(A_ID)
    setTabs(a, [tab(T1, { placeKnown: false })])
    await connect(w, a)
    await until(() => w.viewer.has(T1))
    expect(w.viewer.tab(T1)).toMatchObject({ placeKnown: false, place: null })
    setTabs(a, [tab(T1, { placeKnown: true, place: { project: { key: 'd:/work/app', name: 'app', parent: 'work' }, worktree: null, branch: 'main' } })])
    await until(() => w.viewer.tab(T1)?.placeKnown === true)
    expect(w.viewer.tab(T1)?.place?.branch).toBe('main')
  })
})
