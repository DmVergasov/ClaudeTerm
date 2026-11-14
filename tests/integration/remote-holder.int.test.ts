import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteHolder, type RemoteHolderDeps } from '../../src/main/remote-holder'
import type { TabManager } from '../../src/main/tab-manager'
import { Calls, type CallEntry } from '../../src/main/sync/calls'
import type { MirrorOpen, ScreenMirrorsApi } from '../../src/main/sync/screen-mirror'
import type { ViewerEvents } from '../../src/main/sync/tab-viewer'
import type { HelloMessage, Message } from '../../src/main/sync/wire'
import type { ChatItem } from '../../src/shared/chat'
import type { DevicePlatform } from '../../src/shared/devices'
import { type RemoteSnapshot, type RemoteTab } from '../../src/shared/remote'
import type { TabInfo } from '../../src/shared/types'
import { closeLinkPairs, linkPair, until } from '../fixtures/sync'

const A_ID = 'a1000000-0000-4000-8000-000000000001'
const B_ID = 'b1000000-0000-4000-8000-000000000001'
const T1 = tabId(1)
const T2 = tabId(2)
const T_B = tabId(0x1000)
const T_NEW = tabId(0x1001)
const T_MARK = tabId(0x1002)
const T_UNKNOWN = tabId(0x1003)

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

/** a screen copy that records what it is asked; exit() is the worker's exit and title() a title it reports */
interface FakeMirrors extends ScreenMirrorsApi {
  opens: [string, MirrorOpen][]
  seeds: [string, string][]
  disposes: number
  onExit(cb: () => void): void
  exit(): void
  title(tabId: string, title: string): void
}

function fakeMirrors(): FakeMirrors {
  const exitCbs: (() => void)[] = []
  const titleCbs: ((tabId: string, title: string) => void)[] = []
  const m: FakeMirrors = {
    opens: [],
    seeds: [],
    disposes: 0,
    open: (tabId, _cols, _rows, _scrollback, opts) => {
      m.opens.push([tabId, opts ?? {}])
    },
    write: () => {},
    resize: () => {},
    reset: () => {},
    close: () => {},
    seed: (tabId, data) => {
      m.seeds.push([tabId, data])
    },
    snapshot: async (): Promise<RemoteSnapshot | null> => ({ data: 'SNAP', seq: 0, cols: 80, rows: 24 }),
    onTitle: (cb) => {
      titleCbs.push(cb)
    },
    dispose: () => {
      m.disposes++
    },
    onExit: (cb) => {
      exitCbs.push(cb)
    },
    exit: () => {
      for (const cb of exitCbs.splice(0)) cb()
    },
    title: (tabId, title) => {
      for (const cb of titleCbs) cb(tabId, title)
    }
  }
  return m
}

interface Ev {
  name: string
  id: string
  value?: unknown
}

interface HarnessOpts {
  /** the second worker cannot be started */
  failRestart?: boolean
  /** what this device's rename does when a member calls it */
  rename?: (a: unknown) => unknown
  /** the tabs cannot be listed: the holder's constructor throws */
  listThrows?: boolean
  /** collects the workers this holder starts, when the caller needs them although the constructor throws */
  started?: FakeMirrors[]
}

interface Harness {
  holder: RemoteHolder
  started: FakeMirrors[]
  /** the tab ids the window was asked for a seed, in order */
  requested: string[]
  /** the same asks with their tokens, in order */
  asks: [string, number][]
  titles: [string, string][]
  /** the title each tab shows in the directory: the test sets it with each title change the window reports */
  titleOf: Map<string, string>
  /** the fronts members sent this device's tabs: from, tab, and whether the member is present */
  fronts: [string, string | null, boolean][]
  toasts: string[]
  logs: string[]
  events: Ev[]
  hostHandlersAsked: string[]
  /** how often the holder told the window that a member link came or went, and that a tab's watchers changed */
  signals: { links: number; watchers: number; peersAtLinks: number[] }
}

const holders: RemoteHolder[] = []

afterEach(async () => {
  for (const h of holders.splice(0)) h.dispose()
  await closeLinkPairs()
})

/** a holder of this device, which has the tabs T1 and T2 (T1 is local to the window) */
function harness(opts: HarnessOpts = {}): Harness {
  const started: FakeMirrors[] = opts.started ?? []
  const requested: string[] = []
  const asks: [string, number][] = []
  const titles: [string, string][] = []
  // the fronts the members send this device's tabs, as its host passes them on
  const fronts: [string, string | null, boolean][] = []
  const toasts: string[] = []
  const logs: string[] = []
  const events: Ev[] = []
  const hostHandlersAsked: string[] = []
  const signals: { links: number; watchers: number; peersAtLinks: number[] } = { links: 0, watchers: 0, peersAtLinks: [] }
  const ids = [T1, T2]
  // the title each tab shows in the directory, as the window's titles give it
  const titleOf = new Map<string, string>()
  const tabs = {
    list: (): TabInfo[] => {
      if (opts.listThrows) throw new Error('tabs gone')
      return ids.map((id) => ({ id }) as TabInfo)
    },
    size: () => ({ cols: 80, rows: 24 })
  } as Pick<TabManager, 'list' | 'size'>
  const viewerEvents: ViewerEvents = {
    opened: (device, t) => events.push({ name: 'opened', id: t.id, value: device }),
    updated: () => {},
    closed: (id) => events.push({ name: 'closed', id }),
    devices: (list) => events.push({ name: 'devices', id: '', value: list }),
    data: () => {},
    reset: () => {},
    exit: () => {},
    size: () => {},
    attention: () => {},
    attentionCleared: () => {},
    ring: () => {},
    push: () => {}
  }
  const deps: RemoteHolderDeps = {
    tabs,
    scrollback: () => 1000,
    hostTabs: {
      list: () => ids.map((id) => tab(id, { title: titleOf.get(id) ?? null })),
      has: (id) => ids.includes(id),
      input: () => {},
      claim: () => {},
      front: (from, id, present) => {
        fronts.push([from, id, present])
      },
      pushes: async () => []
    },
    hostHandlers: (device: string): Record<string, CallEntry> => {
      hostHandlersAsked.push(device)
      return { rename: { run: (a) => (opts.rename ?? (() => null))(a) } }
    },
    viewerEvents,
    isLocal: (id) => id === T1,
    selfId: () => A_ID,
    toast: (m) => toasts.push(m),
    present: () => false,
    onFresh: () => {},
    startMirrors: () => {
      if (opts.failRestart && started.length > 0) throw new Error('no worker here')
      const m = fakeMirrors()
      started.push(m)
      return m
    },
    requestSeed: (id, token) => {
      requested.push(id)
      asks.push([id, token])
    },
    onTitle: (tabId, title) => titles.push([tabId, title]),
    onPeerGone: (device) => events.push({ name: 'gone', id: device }),
    log: (m) => logs.push(m),
    onLinks: () => {
      signals.links++
      // the members the host has at the moment the window is told: a link that went is no longer among them
      signals.peersAtLinks.push(holder.host.peers().length)
    },
    onWatchers: () => {
      signals.watchers++
    }
  }
  const holder = new RemoteHolder(deps)
  holders.push(holder)
  return { holder, started, requested, asks, titles, titleOf, fronts, toasts, logs, events, hostHandlersAsked, signals }
}

/** the token of the latest seed request for a tab, as the window was asked */
function tokenOf(h: Harness, tabId: string): number {
  const mine = h.asks.filter(([id]) => id === tabId)
  return mine[mine.length - 1][1]
}

/** a member B linked to the holder over a loopback pair; returns B's end of the link */
async function connectB(h: Harness): Promise<{ pair: Awaited<ReturnType<typeof linkPair>> }> {
  const pair = await linkPair()
  h.holder.connect(pair.client, helloOf(B_ID, 'Laptop'))
  return { pair }
}

/** B attaches to T1: the holder's attach answer (or its refusal) */
function attachT1(h: Harness): Promise<unknown> {
  return h.holder.host.handlers(B_ID).attach.run({ id: T1 }) as Promise<unknown>
}

describe('RemoteHolder', () => {
  it('every tab of this device gets a screen copy that waits for its seed, and the window is asked for each, with a token', () => {
    const h = harness()
    expect(h.started[0].opens).toEqual([
      [T1, { seq: 0, awaitSeed: true }],
      [T2, { seq: 0, awaitSeed: true }]
    ])
    expect(h.requested).toEqual([T1, T2])
    expect(h.asks.every(([, token]) => Number.isInteger(token) && token > 0)).toBe(true)
  })

  it("a seed from the window reaches the tab's copy", () => {
    const h = harness()
    h.holder.seed(T1, tokenOf(h, T1), 'SEED')
    expect(h.started[0].seeds).toEqual([[T1, 'SEED']])
  })

  it('a worker that exits is started again once, and every tab is seeded again; a second exit starts none', () => {
    const h = harness()
    h.started[0].exit()
    expect(h.started).toHaveLength(2)
    expect(h.started[1].opens).toEqual([
      [T1, { seq: 0, awaitSeed: true }],
      [T2, { seq: 0, awaitSeed: true }]
    ])
    expect(h.requested).toEqual([T1, T2, T1, T2])
    h.started[1].exit()
    expect(h.started).toHaveLength(2)
  })

  it('after a worker restart, the answer to the old request is dropped and the answer to the new one reaches the new copy', () => {
    const h = harness()
    const oldToken = tokenOf(h, T1)
    h.started[0].exit()
    const newToken = tokenOf(h, T1)
    expect(newToken).not.toBe(oldToken)
    h.holder.seed(T1, oldToken, 'OLD')
    expect(h.started[1].seeds).toEqual([])
    h.holder.seed(T1, newToken, 'NEW')
    expect(h.started[1].seeds).toEqual([[T1, 'NEW']])
  })

  it('a second answer with the same token is dropped', () => {
    const h = harness()
    const token = tokenOf(h, T1)
    h.holder.seed(T1, token, 'FIRST')
    h.holder.seed(T1, token, 'AGAIN')
    expect(h.started[0].seeds).toEqual([[T1, 'FIRST']])
  })

  it('a seed for a tab that was never asked for is dropped', () => {
    const h = harness()
    h.holder.seed(T_UNKNOWN, 1, 'X')
    expect(h.started[0].seeds).toEqual([])
  })

  it('a seed for a tab that closed here is dropped', () => {
    const h = harness()
    const token = tokenOf(h, T1)
    h.holder.closed(T1)
    h.holder.seed(T1, token, 'X')
    expect(h.started[0].seeds).toEqual([])
  })

  it('an answer to a request of an earlier holder is dropped, the answer to this holder\'s request passes', () => {
    const first = harness()
    const tokenA = tokenOf(first, T1)
    first.holder.dispose()
    const second = harness()
    const tokenB = tokenOf(second, T1)
    expect(tokenB).not.toBe(tokenA)
    second.holder.seed(T1, tokenA, 'X')
    expect(second.started[0].seeds).toEqual([])
    second.holder.seed(T1, tokenB, 'Y')
    expect(second.started[0].seeds).toEqual([[T1, 'Y']])
  })

  it('dispose stops the current worker, and a worker that exits after dispose starts no new one', () => {
    const h = harness()
    h.holder.dispose()
    expect(h.started[0].disposes).toBe(1)
    h.started[0].exit()
    expect(h.started).toHaveLength(1)
  })

  it('a link hands its device to the host handlers, which are asked for that device', async () => {
    const h = harness()
    await connectB(h)
    expect(h.hostHandlersAsked).toEqual([B_ID])
  })

  it('a worker restart keeps every tab attachable: the second worker answers the snapshots, and after its exit none does', async () => {
    const h = harness()
    await connectB(h)
    expect(await attachT1(h)).toMatchObject({ data: 'SNAP' })
    h.started[0].exit()
    expect(await attachT1(h)).toMatchObject({ data: 'SNAP' })
    h.started[1].exit()
    await expect(attachT1(h)).rejects.toThrow('no screen')
    expect(h.started).toHaveLength(2)
  })

  it('a title from the restarted worker reaches the window, and a title after dispose does not', () => {
    const h = harness()
    h.started[0].exit()
    h.started[1].title(T1, 'after restart')
    expect(h.titles).toEqual([[T1, 'after restart']])
    h.holder.dispose()
    h.started[1].title(T1, 'after dispose')
    expect(h.titles).toEqual([[T1, 'after restart']])
  })

  it('a restart that cannot start a worker is logged once, and snapshots answer nothing', async () => {
    const h = harness({ failRestart: true })
    await connectB(h)
    h.started[0].exit()
    expect(h.logs.filter((m) => m.includes('no worker here'))).toHaveLength(1)
    expect(h.requested).toEqual([T1, T2])
    await expect(attachT1(h)).rejects.toThrow('no screen')
  })

  it('a member calls a rename here over the open link, and after dispose the call is not served', async () => {
    const runs: unknown[] = []
    const h = harness({ rename: (a) => (runs.push(a), null) })
    const { pair } = await connectB(h)
    const bCalls = new Calls(pair.server, {}, { timeoutMs: 300 })
    await bCalls.call('rename', { id: T1, title: 'before' })
    expect(runs).toHaveLength(1)
    h.holder.dispose()
    const err = await bCalls.call('rename', { id: T1, title: 'after' }).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect(runs).toHaveLength(1)
  })

  it('a call of this device that fails after dispose gives no toast', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    pair.server.send({ t: 'tabs', tabs: [tab(T_B)] })
    await until(() => h.events.some((e) => e.name === 'opened' && e.id === T_B))
    const pending = h.holder.actions.switchAccount(T_B, null)
    h.holder.dispose()
    await pending
    expect(h.toasts).toEqual([])
  })

  it('a link connected twice is served once: one Calls answers each call, and dispose closes that one', async () => {
    const runs: unknown[] = []
    const h = harness({ rename: (a) => (runs.push(a), null) })
    const pair = await linkPair()
    h.holder.connect(pair.client, helloOf(B_ID, 'Laptop'))
    h.holder.connect(pair.client, helloOf(B_ID, 'Laptop'))
    expect(h.hostHandlersAsked).toEqual([B_ID])
    const bCalls = new Calls(pair.server, {}, { timeoutMs: 300 })
    await bCalls.call('rename', { id: T1, title: 'before' })
    expect(runs).toHaveLength(1)
    h.holder.dispose()
    const err = await bCalls.call('rename', { id: T1, title: 'after' }).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect(runs).toHaveLength(1)
  })

  it('after dispose, this device sends no tab output to a member that watches the tab', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    const seen: Message[] = []
    pair.server.on('message', (m: Message) => seen.push(m))
    await attachT1(h)
    h.holder.host.output(T1, 'before')
    await until(() => seen.some((m) => m.t === 'out' && m.d === 'before'))
    h.holder.dispose()
    h.holder.host.output(T1, 'after')
    // a marker on the same link: the link keeps order, so any 'out' sent before it has arrived by then
    pair.client.send({ t: 'tab-closed', id: T_MARK })
    await until(() => seen.some((m) => m.t === 'tab-closed' && m.id === T_MARK))
    expect(seen.some((m) => m.t === 'out' && m.d === 'after')).toBe(false)
  })

  it("a member's tab in front is sent again when the member becomes present, and this device's host hears each send with the flag", async () => {
    const h = harness()
    const { pair } = await connectB(h)
    // B brings T1 to the front while not present, then becomes present with T1 still in front
    pair.server.send({ t: 'front', id: T1, present: false, focused: false })
    pair.server.send({ t: 'front', id: T1, present: true, focused: true })
    await until(() => h.fronts.length === 2)
    expect(h.fronts).toEqual([
      [B_ID, T1, false],
      [B_ID, T1, true]
    ])
  })

  it('ten title changes within 50 ms send a member at most two directory updates of the tab', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    const seen: Message[] = []
    pair.server.on('message', (m: Message) => seen.push(m))
    const mirror = h.started[0]
    for (let i = 0; i < 10; i++) {
      h.titleOf.set(T1, `title ${i}`)
      mirror.title(T1, `title ${i}`)
    }
    await until(() => seen.some((m) => m.t === 'tab' && m.tab.id === T1 && m.tab.title === 'title 9'))
    expect(seen.filter((m) => m.t === 'tab' && m.tab.id === T1).length).toBeLessThanOrEqual(2)
  })

  it('a link that closes is no longer kept by the holder', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    expect(h.holder.linkCount()).toBe(1)
    pair.server.close('test: closed')
    await until(() => h.holder.linkCount() === 0)
  })

  it('a constructor that throws after its worker started disposes that worker, then throws on', () => {
    const started: FakeMirrors[] = []
    expect(() => harness({ started, listThrows: true })).toThrow('tabs gone')
    expect(started).toHaveLength(1)
    expect(started[0].disposes).toBe(1)
  })

  it('a review push the link refuses is logged once per tab and kind', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    await attachT1(h)
    vi.spyOn(pair.client, 'sendBulk').mockReturnValue(false)
    vi.spyOn(pair.client, 'send').mockReturnValue(false)
    h.holder.host.push(T1, 'review', { files: [] })
    h.holder.host.push(T1, 'review', { files: [] })
    h.holder.host.push(T1, 'plan', null)
    h.holder.host.push(T1, 'plan', null)
    expect(h.logs.filter((m) => m.includes('refused'))).toHaveLength(2)
  })

  it("closing the holder: each linked device is given back, then each remote tab closes, then the list is emptied, in that order", async () => {
    const h = harness()
    const { pair } = await connectB(h)
    pair.server.send({ t: 'tabs', tabs: [tab(T_B)] })
    await until(() => h.events.some((e) => e.name === 'opened' && e.id === T_B))
    const before = h.events.length
    h.holder.dispose()
    const order = h.events.slice(before).map((e) => `${e.name}:${e.id}`)
    expect(order).toEqual([`gone:${B_ID}`, `closed:${T_B}`, 'devices:'])
  })

  it('a tab that a member announces after dispose opens nothing here', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    const seen: Message[] = []
    pair.client.on('message', (m: Message) => seen.push(m))
    h.holder.dispose()
    const before = h.events.length
    pair.server.send({ t: 'tab', tab: tab(T_NEW) })
    pair.server.send({ t: 'tab-closed', id: T_MARK })
    await until(() => seen.some((m) => m.t === 'tab-closed' && m.id === T_MARK))
    expect(h.events.slice(before).some((e) => e.name === 'opened')).toBe(false)
  })

  it('connecting a member asks its profiles and its accounts once each', async () => {
    const h = harness()
    const pair = await linkPair()
    // B's side serves the two lists, counting each call
    const runs = { profiles: 0, accounts: 0 }
    new Calls(pair.server, {
      profiles: { run: () => (runs.profiles++, ['Bash']) },
      accounts: { run: () => (runs.accounts++, []) }
    })
    h.holder.connect(pair.client, helloOf(B_ID, 'Laptop'))
    await until(() => runs.profiles === 1 && runs.accounts === 1)
    // a call the member refuses comes back after any list call that was sent before it: no list call was sent twice
    await expect(h.holder.actions.ask(B_ID, 'sessions', {})).rejects.toThrow()
    expect(runs).toEqual({ profiles: 1, accounts: 1 })
  })

  it('connecting a member asks its Recent sessions, and a member that links again is asked again', async () => {
    const h = harness()
    let runs = 0
    const first = await linkPair()
    new Calls(first.server, { sessions: { run: () => (runs++, []) } })
    h.holder.connect(first.client, helloOf(B_ID, 'Laptop'))
    await until(() => runs === 1)
    first.client.close('test')
    await until(() => h.holder.linkCount() === 0)
    const second = await linkPair()
    new Calls(second.server, { sessions: { run: () => (runs++, []) } })
    h.holder.connect(second.client, helloOf(B_ID, 'Laptop'))
    await until(() => runs === 2)
  })

  it('the window hears of a member link that comes up and of one that goes down', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    expect(h.signals.links).toBe(1)
    pair.server.close('test: closed')
    await until(() => h.holder.linkCount() === 0)
    expect(h.signals.links).toBe(2)
    expect(h.holder.host.peers()).toEqual([])
    // at each signal the host already has the member as it is: one while the link is up, none once it went
    expect(h.signals.peersAtLinks).toEqual([1, 0])
  })

  it('the window hears of a member attaching to a tab, of the tab closing under it, and of the member leaving', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    const before = h.signals.watchers
    await attachT1(h)
    expect(h.signals.watchers).toBe(before + 1)
    h.holder.closed(T1)
    expect(h.signals.watchers).toBe(before + 2)
    await attachT1(h)
    expect(h.signals.watchers).toBe(before + 3)
    pair.server.close('test: closed')
    await until(() => h.holder.linkCount() === 0)
    expect(h.signals.watchers).toBe(before + 4)
  })

  it('a member whose hello has no app gets a forward as a notice', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    const seen: Message[] = []
    pair.server.on('message', (m: Message) => seen.push(m))
    await attachT1(h)
    const forward: ChatItem = { kind: 'forward', id: 'f1', agentId: 'agent-1', label: 'Reviewer', text: 'Check the parser', state: 'delivered', reason: null }
    h.holder.host.push(T1, 'chat-patch', { fromRev: 0, toRev: 1, patches: [{ op: 'add', item: forward }] })
    await until(() => seen.some((m) => m.t === 'push' && m.k === 'chat-patch'))
    const notice: ChatItem = { kind: 'notice', id: 'f1', tone: 'info', text: '↗ To Reviewer: Check the parser', action: null }
    expect(seen.filter((m) => m.t === 'push')).toEqual([
      { t: 'push', id: T1, k: 'chat-patch', v: { fromRev: 0, toRev: 1, patches: [{ op: 'add', item: notice }] } }
    ])
  })

  it('after dispose the window is told of nothing more', async () => {
    const h = harness()
    const { pair } = await connectB(h)
    h.holder.dispose()
    const links = h.signals.links
    pair.server.close('test: closed')
    await new Promise((r) => setTimeout(r, 20))
    expect(h.signals.links).toBe(links)
  })
})
