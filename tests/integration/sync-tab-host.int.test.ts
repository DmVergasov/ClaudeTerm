import type * as tls from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Calls } from '../../src/main/sync/calls'
import type { PeerLink } from '../../src/main/sync/peer-link'
import { CALL_REPLIES } from '../../src/main/sync/remote-shapes'
import type { ScreenMirrorsApi } from '../../src/main/sync/screen-mirror'
import { ScreenMirrors } from '../../src/main/sync/screen-mirror'
import { olderChatPush } from '../../src/main/chat/chat-mirror'
import { TabHost } from '../../src/main/sync/tab-host'
import type { Message } from '../../src/main/sync/wire'
import type { ChatItem } from '../../src/shared/chat'
import { MAX_OUT_CHARS, MAX_REMOTE_TABS, REMOTE_COPY, type PushKind, type RemoteSnapshot, type RemoteTab } from '../../src/shared/remote'
import { replay, textOf } from '../fixtures/screen'
import { closeLinkPairs, linkPair, until } from '../fixtures/sync'

const T1 = 'a0000000-0000-4000-8000-000000000001'
const T2 = 'a0000000-0000-4000-8000-000000000002'
const T9 = 'a0000000-0000-4000-8000-000000000009'
const VIEWER = 'b0000000-0000-4000-8000-000000000001'

/** an invented tab id: the n-th of a series */
function tabId(n: number): string {
  return `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** an invented tab of this device, with the fields a RemoteTab carries */
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

/** the tabs of this device, as the test sets them; every call records what the host passed on */
function fakeTabs() {
  const fake = {
    entries: [] as RemoteTab[],
    pushList: [] as { k: PushKind; v: unknown }[],
    inputs: [] as [string, string, string][],
    claims: [] as [string, string, number, number][],
    fronts: [] as [string, string | null, boolean, boolean][],
    list: (): RemoteTab[] => fake.entries,
    has: (tabId: string): boolean => fake.entries.some((t) => t.id === tabId),
    input: (tabId: string, data: string, from: string): void => {
      fake.inputs.push([tabId, data, from])
    },
    claim: (tabId: string, from: string, cols: number, rows: number): void => {
      fake.claims.push([tabId, from, cols, rows])
    },
    front: (from: string, tabId: string | null, present: boolean, focused: boolean): void => {
      fake.fronts.push([from, tabId, present, focused])
    },
    pushes: async (): Promise<{ k: PushKind; v: unknown }[]> => fake.pushList
  }
  return fake
}

/** a screen copy that answers every snapshot with an empty one, and records nothing */
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

/** a screen copy whose snapshots wait until gate.release(); gate.pending counts the snapshots waiting */
function gatedMirrors(value: RemoteSnapshot | null = { data: '', seq: 0, cols: 40, rows: 10 }) {
  const waiting: (() => void)[] = []
  const gate = {
    get pending(): number {
      return waiting.length
    },
    release(): void {
      for (const w of waiting.splice(0)) w()
    }
  }
  const mirrors: ScreenMirrorsApi = {
    ...noopMirrors(),
    snapshot: () => new Promise<RemoteSnapshot | null>((resolve) => waiting.push(() => resolve(value)))
  }
  return { mirrors, gate }
}

/** a screen copy that answers no snapshot: the worker is gone */
function nullMirrors(): ScreenMirrorsApi {
  return { ...noopMirrors(), snapshot: async () => null }
}

/** a screen copy that records the copies opened (with their options) and closed */
function recordingMirrors() {
  const opens: { tabId: string; opts: unknown }[] = []
  const closes: string[] = []
  const mirrors: ScreenMirrorsApi = {
    ...noopMirrors(),
    open: (tabId, _cols, _rows, _scrollback, opts) => {
      opens.push({ tabId, opts })
    },
    close: (tabId) => {
      closes.push(tabId)
    }
  }
  return { mirrors, opens, closes }
}

describe('tab host', () => {
  let fake: ReturnType<typeof fakeTabs>
  let mirrors: ScreenMirrorsApi
  let host: TabHost
  let hostLink: PeerLink
  let memberLink: PeerLink
  let clientSocket: tls.TLSSocket
  let viewer: Calls
  let got: Message[]
  let gone: string[]
  /** how many times the host reported that its watchers changed */
  let watchChanges: number
  /** the pushes the link refused, as the host reported them */
  let refused: [string, PushKind][]

  /**
   * The link pair: the host serves on `server`, the member (VIEWER) sits on `client` with no handlers. As connectPeer
   * does, the host's handlers are served on the link's one Calls (unless `serve` is false).
   */
  async function start(
    opts: { screen?: ScreenMirrorsApi; detachBacklogBytes?: number; serve?: boolean } = {}
  ): Promise<void> {
    fake = fakeTabs()
    mirrors = opts.screen ?? new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 })
    gone = []
    watchChanges = 0
    refused = []
    const pair = await linkPair()
    hostLink = pair.server
    memberLink = pair.client
    clientSocket = pair.clientSocket
    got = []
    memberLink.on('message', (m: Message) => got.push(m))
    viewer = new Calls(memberLink, {})
    host = new TabHost({
      tabs: fake,
      mirrors,
      detachBacklogBytes: opts.detachBacklogBytes,
      onPeerGone: (device) => gone.push(device),
      onWatchers: () => {
        watchChanges++
      },
      onPushRefused: (tabId, k) => {
        refused.push([tabId, k])
      }
    })
    if (opts.serve !== false) new Calls(hostLink, host.handlers(VIEWER))
  }

  /** the member's link comes up: the host sends the directory */
  async function join(): Promise<void> {
    host.addPeer(hostLink, VIEWER)
    await until(() => got.some((m) => m.t === 'tabs'))
  }

  const outs = () => got.filter((m): m is Extract<Message, { t: 'out' }> => m.t === 'out')

  afterEach(async () => {
    mirrors?.dispose()
    host?.dispose()
    await closeLinkPairs()
  })

  it('the directory goes to a member when the link comes up, and the changes follow', async () => {
    await start()
    await join()
    fake.entries = [tab(T1, { muted: true }), tab(T2)]
    host.changed()
    await until(() => got.filter((m) => m.t === 'tab').length === 2)
    fake.entries = [tab(T2)]
    host.changed()
    await until(() => got.some((m) => m.t === 'tab-closed' && m.id === T1))
  })

  it('attach answers a snapshot with its number, and later output follows numbered from it', async () => {
    await start()
    fake.entries = [tab(T1), tab(T2)]
    await join()
    host.opened(T1, 40, 10, 1000)
    host.output(T1, 'before\r\n')
    const snap = CALL_REPLIES.attach(await viewer.call('attach', { id: T1 }))!
    expect(snap.seq).toBe(1)
    host.output(T1, 'after')
    await until(() => outs().length === 1)
    expect(outs()[0]).toEqual({ t: 'out', id: T1, seq: 2, d: 'after' })
  })

  it('a burst longer than MAX_OUT_CHARS goes in numbered pieces that join to the same text, none ending inside a surrogate pair', async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    host.output(T1, 'earlier\r\n')
    await viewer.call('attach', { id: T1 })
    // the leading 'a' puts every MAX_OUT_CHARS boundary inside a pair
    const text = 'a' + '😀'.repeat(MAX_OUT_CHARS) + '\x1b[31mend'
    host.output(T1, text)
    await until(() => outs().map((o) => o.d).join('') === text)
    expect(outs().map((o) => o.seq)).toEqual([2, 3, 4])
    for (const o of outs()) expect(o.d).not.toMatch(/[\ud800-\udbff]$/)
  })

  it("the tab's hub updates come with the attach and after it", async () => {
    await start()
    fake.entries = [tab(T1)]
    fake.pushList = [{ k: 'status', v: { main: null, agents: [] } }]
    await join()
    host.opened(T1, 40, 10, 1000)
    await viewer.call('attach', { id: T1 })
    host.push(T1, 'plan', null)
    await until(() => got.filter((m) => m.t === 'push').length === 2)
    expect(got.filter((m) => m.t === 'push').map((m) => (m as { k: string }).k)).toEqual(['status', 'plan'])
  })

  it("input, claims and the tab in front reach the tab's device; for a tab it does not have, nothing", async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    memberLink.send({ t: 'in', id: T9, d: 'x' })
    memberLink.send({ t: 'claim', id: T9, cols: 80, rows: 24 })
    // the last is the marker
    memberLink.send({ t: 'in', id: T1, d: 'ls\r' })
    await until(() => fake.inputs.length === 1)
    expect(fake.inputs).toEqual([[T1, 'ls\r', VIEWER]])
    expect(fake.claims).toEqual([])
    memberLink.send({ t: 'front', id: null, present: false, focused: false })
    await until(() => fake.fronts.length === 1)
    expect(fake.fronts).toEqual([[VIEWER, null, false, false]])
  })

  it("a member's tab in front says whether its member is present; an older member's front (no flag) is not present", async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    memberLink.send({ t: 'front', id: T1, present: true, focused: true })
    await until(() => fake.fronts.length === 1)
    memberLink.send({ t: 'front', id: T1 } as unknown as Message)
    await until(() => fake.fronts.length === 2)
    expect(fake.fronts).toEqual([[VIEWER, T1, true, true], [VIEWER, T1, false, false]])
  })

  it("a 0.15.0 member's front says focused and no present: the host gets present false and its focus", async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    memberLink.send({ t: 'front', id: T1, focused: true } as unknown as Message)
    await until(() => fake.fronts.length === 1)
    expect(fake.fronts).toEqual([[VIEWER, T1, false, true]])
  })

  it('attach for a tab it does not have is refused', async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    await expect(viewer.call('attach', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab)
  })

  it('a copy with no screen (the worker is gone) refuses the attach', async () => {
    await start({ screen: nullMirrors() })
    fake.entries = [tab(T1)]
    await join()
    await expect(viewer.call('attach', { id: T1 })).rejects.toThrow('no screen')
  })

  it('five attaches for one tab answered at once send one snapshot: a newer reply replaces a queued one', async () => {
    const { mirrors: gated, gate } = gatedMirrors()
    await start({ screen: gated })
    fake.entries = [tab(T1)]
    await join()
    const calls = [1, 2, 3, 4, 5].map(() =>
      viewer.call('attach', { id: T1 }, { timeoutMs: 1000 }).then(
        () => 'ok',
        (e: Error) => e.message
      )
    )
    await until(() => gate.pending === 5)
    gate.release()
    expect(await Promise.all(calls)).toEqual(['timeout', 'timeout', 'timeout', 'timeout', 'ok'])
    expect(got.filter((m) => m.t === 'reply')).toHaveLength(1)
  })

  it('a member that cannot keep up is detached from the tab, not buffered', async () => {
    await start({ screen: noopMirrors(), detachBacklogBytes: 64 * 1024 })
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    await viewer.call('attach', { id: T1 })
    // the member stops reading: its socket holds what the host writes
    clientSocket.pause()
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 400; i++) host.output(T1, chunk)
    clientSocket.resume()
    await until(() => got.some((m) => m.t === 'detached'))
    expect(outs().length).toBeLessThan(400)
    expect(host.watchers(T1)).toEqual([])
  })

  it('seed reaches the copy of a tab opened to wait for it', async () => {
    await start()
    fake.entries = [tab(T2)]
    await join()
    host.opened(T2, 40, 10, 100, { awaitSeed: true })
    host.seed(T2, 'seeded')
    const snap = CALL_REPLIES.attach(await viewer.call('attach', { id: T2 }))!
    expect(textOf(await replay(snap))[0]).toBe('seeded')
  })

  it('the directory and the stream stop when the link ends', async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    await viewer.call('attach', { id: T1 })
    hostLink.close('test')
    await until(() => gone.length === 1)
    expect(gone).toEqual([VIEWER])
    expect(() => {
      host.output(T1, 'x')
      host.changed()
    }).not.toThrow()
    expect(host.peers()).toEqual([])
  })

  // R1: a newer review push replaces a queued older one for the same member and tab
  it('two review pushes while the member does not read: only the second arrives', async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    await viewer.call('attach', { id: T1 })
    clientSocket.pause()
    const first = { files: [{ path: 'a.ts' }] }
    const second = { files: [{ path: 'b.ts' }] }
    host.push(T1, 'review', first)
    host.push(T1, 'review', second)
    clientSocket.resume()
    await until(() => got.some((m) => m.t === 'push' && m.k === 'review'))
    // a marker on the interactive lane. The first review, if it had been sent, would arrive before the second on the
    // bulk lane, so the first review to arrive must be the second
    host.push(T1, 'plan', null)
    await until(() => got.some((m) => m.t === 'push' && m.k === 'plan'))
    const reviews = got.filter((m) => m.t === 'push' && m.k === 'review')
    expect(reviews).toEqual([{ t: 'push', id: T1, k: 'review', v: second }])
  })

  // R9: a push the link refuses is reported with its tab and kind, so the holder can log it
  it('a review push the link refuses is reported to onPushRefused with its tab and kind', async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    await viewer.call('attach', { id: T1 })
    vi.spyOn(hostLink, 'sendBulk').mockReturnValue(false)
    host.push(T1, 'review', { files: [{ path: 'a.ts' }] })
    expect(refused).toEqual([[T1, 'review']])
  })

  // C1: the host makes no Calls of its own; the link's one Calls serves handlers()
  it('addPeer alone answers no call: the link needs the Calls of handlers()', async () => {
    await start({ serve: false })
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    await expect(viewer.call('attach', { id: T1 }, { timeoutMs: 200 })).rejects.toThrow('timeout')
    fake.pushList = [
      { k: 'status', v: { main: null, agents: [] } },
      { k: 'plan', v: null }
    ]
    new Calls(hostLink, { ping: { run: () => 'pong' }, ...host.handlers(VIEWER) })
    await expect(viewer.call('ping', null)).resolves.toBe('pong')
    const snap = CALL_REPLIES.attach(await viewer.call('attach', { id: T1 }))
    expect(snap).not.toBeNull()
    await until(() => got.filter((m) => m.t === 'push').length === 2)
    expect(got.filter((m) => m.t === 'push')).toHaveLength(2)
  })

  // I1: a member detached while its snapshot waited gets no snapshot
  it('a member detached while its snapshot waited is refused as detached, with no snapshot', async () => {
    const { mirrors: gated, gate } = gatedMirrors()
    await start({ screen: gated, detachBacklogBytes: 64 * 1024 })
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    const settled = viewer.call('attach', { id: T1 }, { timeoutMs: 10_000 }).then(
      () => 'ok',
      (e: Error) => e.message
    )
    await until(() => gate.pending === 1)
    // the member stops reading while its snapshot waits: the output detaches it
    clientSocket.pause()
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 400 && host.watchers(T1).length > 0; i++) host.output(T1, chunk)
    expect(host.watchers(T1)).toEqual([])
    gate.release()
    clientSocket.resume()
    expect(await settled).toBe('detached')
    await until(() => got.some((m) => m.t === 'detached'))
    expect(got.some((m) => m.t === 'reply' && m.ok)).toBe(false)
  })

  // I2: the numbering paths and the callbacks, each with a test
  it('reset: the member gets it with its number, and the next output goes on from there', async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    host.output(T1, 'one')
    await viewer.call('attach', { id: T1 })
    host.output(T1, 'two')
    host.reset(T1)
    host.output(T1, 'three')
    await until(() => outs().length === 2)
    expect(got.filter((m) => m.t === 'reset')).toEqual([{ t: 'reset', id: T1, seq: 3 }])
    expect(outs().map((o) => [o.seq, o.d])).toEqual([
      [2, 'two'],
      [4, 'three']
    ])
  })

  it('exit: the member gets it with its number, and a later attach snapshot has that number', async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    host.output(T1, 'one')
    await viewer.call('attach', { id: T1 })
    host.output(T1, 'two')
    host.exit(T1, 3)
    await until(() => got.some((m) => m.t === 'exit'))
    expect(got.filter((m) => m.t === 'exit')).toEqual([{ t: 'exit', id: T1, seq: 3, code: 3 }])
    const snap = CALL_REPLIES.attach(await viewer.call('attach', { id: T1 }))!
    expect(snap.seq).toBe(3)
  })

  it('opened again for a tab it has reopens the copy at the tab current number', async () => {
    const { mirrors: rec, opens } = recordingMirrors()
    await start({ screen: rec })
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    host.output(T1, 'a')
    host.output(T1, 'b')
    host.opened(T1, 40, 10, 1000)
    expect(opens).toEqual([
      { tabId: T1, opts: { seq: 0, awaitSeed: false } },
      { tabId: T1, opts: { seq: 2, awaitSeed: false } }
    ])
  })

  it('closed(tabId) closes the copy, unwatches every member, and a later output for it sends nothing', async () => {
    const { mirrors: rec, opens, closes } = recordingMirrors()
    await start({ screen: rec })
    fake.entries = [tab(T1), tab(T2)]
    await join()
    host.opened(T1, 40, 10, 1000)
    host.opened(T2, 40, 10, 1000)
    await viewer.call('attach', { id: T1 })
    await viewer.call('attach', { id: T2 })
    const before = watchChanges
    host.closed(T1)
    expect(closes).toEqual([T1])
    expect(host.watchers(T1)).toEqual([])
    expect(watchChanges).toBe(before + 1)
    host.output(T1, 'lost')
    host.output(T2, 'marker')
    await until(() => outs().some((o) => o.d === 'marker'))
    expect(outs().filter((o) => o.id === T1)).toEqual([])
    host.opened(T1, 40, 10, 1000)
    expect(opens[opens.length - 1]).toEqual({ tabId: T1, opts: { seq: 0, awaitSeed: false } })
  })

  it('onWatchers fires on attach, on detach and when a member leaves', async () => {
    await start({ screen: noopMirrors(), detachBacklogBytes: 64 * 1024 })
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    expect(watchChanges).toBe(0)
    await viewer.call('attach', { id: T1 })
    expect(watchChanges).toBe(1)
    clientSocket.pause()
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 400 && host.watchers(T1).length > 0; i++) host.output(T1, chunk)
    expect(watchChanges).toBe(2)
    clientSocket.resume()
    await until(() => got.some((m) => m.t === 'detached'))
    await viewer.call('attach', { id: T1 })
    expect(watchChanges).toBe(3)
    hostLink.close('test')
    await until(() => gone.length === 1)
    expect(watchChanges).toBe(4)
  })

  it('removePeer acts like the link closing: onPeerGone fires once and peers() is empty', async () => {
    await start()
    fake.entries = [tab(T1)]
    await join()
    host.removePeer(hostLink)
    expect(gone).toEqual([VIEWER])
    expect(host.peers()).toEqual([])
    hostLink.close('later')
    expect(gone).toEqual([VIEWER])
  })

  // Minor 1: after dispose() nothing fires, even when a pending snapshot resolves afterwards
  it('after dispose(), a pending snapshot that resolves null fires no callback, and every method is a no-op', async () => {
    const { mirrors: gated, gate } = gatedMirrors(null)
    await start({ screen: gated })
    fake.entries = [tab(T1)]
    await join()
    host.opened(T1, 40, 10, 1000)
    const settled = viewer.call('attach', { id: T1 }, { timeoutMs: 10_000 }).then(
      () => 'ok',
      (e: Error) => e.message
    )
    await until(() => gate.pending === 1)
    const before = watchChanges
    host.dispose()
    gate.release()
    expect(await settled).toBe('detached')
    host.output(T1, 'x')
    host.push(T1, 'plan', null)
    host.changed()
    host.closed(T1)
    host.removePeer(hostLink)
    hostLink.close('later')
    expect(watchChanges).toBe(before)
    expect(gone).toEqual([])
    expect(host.peers()).toEqual([])
    expect(host.watchers(T1)).toEqual([])
  })

  // M2: the directory holds at most MAX_REMOTE_TABS entries
  it('the directory sends at most MAX_REMOTE_TABS tabs, in order; the tab after them comes in when one closes', async () => {
    await start()
    const all = Array.from({ length: MAX_REMOTE_TABS + 44 }, (_, i) => tab(tabId(i + 1)))
    fake.entries = all
    await join()
    const first = got.find((m): m is Extract<Message, { t: 'tabs' }> => m.t === 'tabs')!
    expect(first.tabs.map((t) => t.id)).toEqual(all.slice(0, MAX_REMOTE_TABS).map((t) => t.id))
    fake.entries = all.slice(1)
    host.changed()
    await until(() => got.some((m) => m.t === 'tab' && m.tab.id === all[MAX_REMOTE_TABS].id))
    expect(got.some((m) => m.t === 'tab-closed' && m.id === all[0].id)).toBe(true)
  })
})

describe('tab host: members of two app versions', () => {
  afterEach(async () => {
    await closeLinkPairs()
  })

  it('an older member gets forwards as notices, a newer one as forwards', async () => {
    const OLDER = 'b0000000-0000-4000-8000-000000000002'
    const NEWER = 'b0000000-0000-4000-8000-000000000003'
    const fake = fakeTabs()
    fake.entries = [tab(T1)]
    const forward: ChatItem = { kind: 'forward', id: 'f1', agentId: 'agent-1', label: 'Reviewer', text: 'Check the parser', state: 'delivered', reason: null }
    const notice1: ChatItem = { kind: 'notice', id: 'f1', tone: 'info', text: '↗ To Reviewer: Check the parser', action: null }
    const state = { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false }
    fake.pushList = [{ k: 'chat', v: { tabId: T1, rev: 0, items: [forward], hasOlder: false, state } }]
    const host = new TabHost({ tabs: fake, mirrors: noopMirrors(), forOlder: olderChatPush })
    const older = await linkPair()
    const newer = await linkPair()
    const gotOlder: Message[] = []
    const gotNewer: Message[] = []
    older.client.on('message', (m: Message) => gotOlder.push(m))
    newer.client.on('message', (m: Message) => gotNewer.push(m))
    new Calls(older.server, host.handlers(OLDER))
    new Calls(newer.server, host.handlers(NEWER))
    host.addPeer(older.server, OLDER)
    host.addPeer(newer.server, NEWER, '0.18.0')
    expect(host.appOf(OLDER)).toBeNull()
    expect(host.appOf(NEWER)).toBe('0.18.0')
    host.opened(T1, 40, 10, 1000)
    await new Calls(older.client, {}).call('attach', { id: T1 })
    await new Calls(newer.client, {}).call('attach', { id: T1 })
    host.push(T1, 'chat-patch', { fromRev: 0, toRev: 1, patches: [{ op: 'add', item: forward }] })
    const pushes = (got: Message[]) => got.filter((m) => m.t === 'push')
    await until(() => pushes(gotOlder).length === 2 && pushes(gotNewer).length === 2)
    expect(pushes(gotOlder)).toEqual([
      { t: 'push', id: T1, k: 'chat', v: { tabId: T1, rev: 0, items: [notice1], hasOlder: false, state } },
      { t: 'push', id: T1, k: 'chat-patch', v: { fromRev: 0, toRev: 1, patches: [{ op: 'add', item: notice1 }] } }
    ])
    expect(pushes(gotNewer)).toEqual([
      { t: 'push', id: T1, k: 'chat', v: { tabId: T1, rev: 0, items: [forward], hasOlder: false, state } },
      { t: 'push', id: T1, k: 'chat-patch', v: { fromRev: 0, toRev: 1, patches: [{ op: 'add', item: forward }] } }
    ])
    host.dispose()
  })
})
