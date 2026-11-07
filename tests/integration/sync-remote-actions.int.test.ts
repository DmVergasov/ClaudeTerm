import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { hostHandlers, hostTabs, withoutTabId } from '../../src/main/remote-host'
import { RemoteActions, remoteTabInfo } from '../../src/main/sync/remote-actions'
import { CallError, type CallEntry } from '../../src/main/sync/calls'
import { connectPeer } from '../../src/main/sync/remote-link'
import type { PeerLinkOptions } from '../../src/main/sync/peer-link'
import { ScreenMirrors } from '../../src/main/sync/screen-mirror'
import { TabHost } from '../../src/main/sync/tab-host'
import { RemoteTabs, type ViewerEvents } from '../../src/main/sync/tab-viewer'
import type { HelloMessage } from '../../src/main/sync/wire'
import type { CallArgs, ReviewAction } from '../../src/main/sync/remote-shapes'
import type { DevicePlatform } from '../../src/shared/devices'
import { IMAGE_PART_BYTES, IMAGE_PART_TIMEOUT_MS, LIST_TIMEOUT_MS, REMOTE_COPY, type RemoteTab } from '../../src/shared/remote'
import { NOT_RUNNING } from '../../src/shared/review'
import type { RecentSession, TabPlace } from '../../src/shared/types'
import { ACC_WORK, B_ID, T1, T2, T3, T9, fakeHost, imageCard, reviewUpdate, tabId, tabInfo } from '../fixtures/host-context'
import { closeLinkPairs, linkPair, until } from '../fixtures/sync'

// Two devices on a loopback link: A (Studio) serves its tabs through hostHandlers, B (Laptop) asks through RemoteActions.

const A_ID = 'a1000000-0000-4000-8000-000000000001'
const C_ID = 'c1000000-0000-4000-8000-000000000001'
/** a file of T1's review, absolute on every system; a file hash */
const ABS_A = join(tmpdir(), 'ct-demo', 'a.ts')
const H = 'a'.repeat(40)

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

interface Pair {
  a: ReturnType<typeof fakeHost>
  hostA: TabHost
  viewerB: RemoteTabs
  actions: RemoteActions
  toasts: string[]
  /** the kinds of the answers that changed what the window keeps, as onFresh reported them */
  fresh: string[]
  hostB: TabHost
  /** B's end of the link: closing it ends the link */
  linkB: { close(reason: string): void }
  mirrors: ScreenMirrors[]
  viewers: RemoteTabs[]
  hosts: TabHost[]
}

/** the options of a pair: A's side of the link, and a wrapper of A's image handler (to count its calls) */
interface PairOptions {
  aLink?: Partial<PeerLinkOptions>
  wrapImage?: (entry: CallEntry) => CallEntry
  wrapSessions?: (entry: CallEntry) => CallEntry
  /** the events of B's viewer, to record what the window would show */
  viewerEvents?: ViewerEvents
}

/** A serves its fake tabs to B over one loopback link; B's RemoteActions asks A */
async function pair(o: PairOptions = {}): Promise<Pair> {
  const a = fakeHost()
  const mirrorsA = new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 })
  const mirrorsB = new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 })
  const hostA = new TabHost({ tabs: hostTabs(a.ctx), mirrors: mirrorsA })
  const hostB = new TabHost({ tabs: hostTabs(fakeHost().ctx), mirrors: mirrorsB })
  const viewerA = new RemoteTabs({ selfId: () => A_ID, isLocal: () => false, events: quietEvents })
  const viewerB = new RemoteTabs({ selfId: () => B_ID, isLocal: () => false, events: o.viewerEvents ?? quietEvents })
  const link = await linkPair({}, o.aLink ?? {})
  hostA.changed()
  connectPeer(link.client, helloOf(A_ID, 'Studio'), hostB, viewerB, {})
  const handlers = hostHandlers(a.ctx, B_ID)
  if (o.wrapImage && handlers.image) handlers.image = o.wrapImage(handlers.image)
  if (o.wrapSessions && handlers.sessions) handlers.sessions = o.wrapSessions(handlers.sessions)
  connectPeer(link.server, helloOf(B_ID, 'Laptop'), hostA, viewerA, handlers)
  await until(() => viewerB.has(T1))
  const toasts: string[] = []
  const fresh: string[] = []
  const actions = new RemoteActions(viewerB, (m) => toasts.push(m), (what) => fresh.push(what))
  return {
    a,
    hostA,
    viewerB,
    actions,
    toasts,
    fresh,
    hostB,
    linkB: link.client,
    mirrors: [mirrorsA, mirrorsB],
    viewers: [viewerA, viewerB],
    hosts: [hostA, hostB]
  }
}

/** a device's answers to the two list calls: each call is counted, and waits while the answers are held */
function listAnswers(profiles: unknown, accounts: unknown) {
  const runs = { profiles: 0, accounts: 0 }
  const answers = { profiles, accounts }
  let gate: Promise<void> | null = null
  const wait = async (): Promise<void> => {
    if (gate) await gate
  }
  const handlers: Record<string, CallEntry> = {
    profiles: {
      run: async () => {
        runs.profiles++
        await wait()
        return answers.profiles
      }
    },
    accounts: {
      run: async () => {
        runs.accounts++
        await wait()
        return answers.accounts
      }
    }
  }
  return {
    runs,
    answers,
    handlers,
    /** holds the answers from now on; the function it returns releases them */
    hold(): () => void {
      let release = (): void => {}
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        gate = null
        release()
      }
    }
  }
}

/** a third device, Cellar, linked to B: it answers the two lists as `lists` says */
async function cellarJoins(p: Pair, lists: ReturnType<typeof listAnswers>): Promise<ReturnType<typeof fakeHost> & { link: { close(reason: string): void } }> {
  const c = fakeHost()
  const mirrorsC = new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 })
  const hostC = new TabHost({ tabs: hostTabs(c.ctx), mirrors: mirrorsC })
  const viewerC = new RemoteTabs({ selfId: () => C_ID, isLocal: () => false, events: quietEvents })
  const link = await linkPair()
  connectPeer(link.client, helloOf(C_ID, 'Cellar'), p.hostB, p.viewerB, {})
  connectPeer(link.server, helloOf(B_ID, 'Laptop'), hostC, viewerC, { ...hostHandlers(c.ctx, B_ID), ...lists.handlers })
  await until(() => p.viewerB.online(C_ID))
  p.mirrors.push(mirrorsC)
  p.hosts.push(hostC)
  p.viewers.push(viewerC)
  // B's end of the link to Cellar: closing it takes Cellar offline for B
  return Object.assign(c, { link: link.client })
}

describe('the answers the new-tab menu shows', () => {
  let pairs: Pair[] = []

  afterEach(async () => {
    for (const p of pairs) {
      for (const h of p.hosts) h.dispose()
      for (const m of p.mirrors) m.dispose()
      for (const v of p.viewers) v.dispose()
    }
    pairs = []
    await closeLinkPairs()
  })

  async function withCellar(lists = listAnswers(['Fish'], [{ id: ACC_WORK, name: 'Work' }])): Promise<{ p: Pair; lists: ReturnType<typeof listAnswers> }> {
    const p = await pair()
    pairs.push(p)
    await cellarJoins(p, lists)
    return { p, lists }
  }

  /** a call Cellar refuses at once (it has listed no session): its answer comes after the answers of the earlier calls, since the link keeps order */
  async function marker(p: Pair): Promise<void> {
    await expect(p.actions.ask(C_ID, 'open-session', { session: A_ID })).rejects.toThrow()
  }

  const cellarValue = (p: Pair) => p.actions.choicesNow().find((d) => d.name === 'Cellar')!.value

  it('choicesNow answers at once: a device that has not answered has null, and its answer comes later with onFresh', async () => {
    const { p, lists } = await withCellar()
    const release = lists.hold()
    expect(p.actions.choicesNow().map((d) => [d.name, d.value])).toEqual([['Cellar', null], ['Studio', null]])
    p.actions.refreshChoices()
    await until(() => p.fresh.length === 1)
    expect(p.actions.choicesNow().find((d) => d.name === 'Studio')!.value).toEqual({ profiles: ['Bash', 'Zsh'], accounts: [{ id: ACC_WORK, name: 'Work' }] })
    expect(cellarValue(p)).toBeNull()
    release()
    await until(() => p.actions.choicesNow().every((d) => d.value !== null))
    expect(cellarValue(p)).toEqual({ profiles: ['Fish'], accounts: [{ id: ACC_WORK, name: 'Work' }] })
    expect(p.fresh).toEqual(['choices', 'choices'])
    expect(p.toasts).toEqual([])
  })

  it('two refreshes in a row ask a device that holds its answers once per list', async () => {
    const { p, lists } = await withCellar()
    const release = lists.hold()
    p.actions.refreshChoices()
    p.actions.refreshChoices()
    await until(() => lists.runs.profiles === 1 && lists.runs.accounts === 1)
    await marker(p)
    expect(lists.runs).toEqual({ profiles: 1, accounts: 1 })
    release()
  })

  it('a device that stops answering keeps its last answer', async () => {
    const { p, lists } = await withCellar()
    p.actions.refreshChoices()
    await until(() => cellarValue(p) !== null)
    const kept = cellarValue(p)
    const freshBefore = p.fresh.length
    const release = lists.hold()
    p.actions.refreshChoices()
    await new Promise((resolve) => setTimeout(resolve, LIST_TIMEOUT_MS + 300))
    expect(lists.runs).toEqual({ profiles: 2, accounts: 2 })
    expect(cellarValue(p)).toEqual(kept)
    expect(p.fresh.length).toBe(freshBefore)
    release()
    await marker(p)
  })

  it('an answer with one list refused is not kept: the last whole answer stays', async () => {
    const { p, lists } = await withCellar()
    p.actions.refreshChoices()
    await until(() => cellarValue(p) !== null)
    const kept = cellarValue(p)
    const freshBefore = p.fresh.length
    lists.answers.profiles = ['Fish', 'Eel']
    lists.answers.accounts = 42
    p.actions.refreshChoices()
    await until(() => lists.runs.profiles === 2 && lists.runs.accounts === 2)
    await marker(p)
    expect(cellarValue(p)).toEqual(kept)
    expect(p.fresh.length).toBe(freshBefore)
  })

  it('openTab from B opens the tab on A and answers its id', async () => {
    const p = await pair()
    pairs.push(p)
    expect(await p.actions.openTab(A_ID, { kind: 'shell', profile: 'Bash', account: null, resume: null })).toBe(T3)
    expect(p.a.opened).toEqual([{ kind: 'shell', profile: 'Bash', account: null, resume: null }])
    expect(p.toasts).toEqual([])
  })

  it('openTab that A refuses answers null and toasts the refusal', async () => {
    const p = await pair()
    pairs.push(p)
    p.a.ctx.openTab = () => null
    expect(await p.actions.openTab(A_ID, { kind: 'claude', profile: null, account: null, resume: null })).toBeNull()
    expect(p.toasts).toEqual([REMOTE_COPY.openTabFailed])
  })

  it('openTab to a device that is not online answers null and toasts that it is not connected', async () => {
    const p = await pair()
    pairs.push(p)
    p.linkB.close('test')
    await until(() => !p.viewerB.online(A_ID))
    expect(await p.actions.openTab(A_ID, { kind: 'shell', profile: 'Bash', account: null, resume: null })).toBeNull()
    expect(p.toasts).toEqual([REMOTE_COPY.deviceOffline('Studio')])
    expect(p.a.opened).toEqual([])
  })
})

describe('tab calls between two devices', () => {
  let pairs: Pair[] = []

  function open(): Promise<Pair> {
    return pair().then((p) => {
      pairs.push(p)
      return p
    })
  }

  afterEach(async () => {
    for (const p of pairs) {
      for (const h of p.hosts) h.dispose()
      for (const m of p.mirrors) m.dispose()
      for (const v of p.viewers) v.dispose()
    }
    pairs = []
    await closeLinkPairs()
  })

  it('rename from B renames the tab on A', async () => {
    const p = await open()
    p.actions.rename(T1, 'build')
    await until(() => p.a.renamed.length === 1)
    expect(p.a.renamed).toEqual([[T1, 'build']])
    expect(p.toasts).toEqual([])
  })

  it('a list call answers what the other device has', async () => {
    const p = await open()
    expect(await p.actions.ask(A_ID, 'profiles', {})).toEqual(['Bash', 'Zsh'])
    expect(await p.actions.ask(A_ID, 'accounts', {})).toEqual([{ id: ACC_WORK, name: 'Work' }])
  })

  it('open-tab from B opens a tab on A and answers its id', async () => {
    const p = await open()
    const reply = await p.actions.ask(A_ID, 'open-tab', { kind: 'shell', profile: 'Bash', account: null, resume: null })
    expect(reply).toEqual({ id: T3 })
    expect(p.a.opened).toEqual([{ kind: 'shell', profile: 'Bash', account: null, resume: null }])
  })

  it('close, mute and restart from B reach A; switch-account answers ok', async () => {
    const p = await open()
    p.actions.close(T1)
    p.actions.mute(T1, true)
    p.actions.restart(T1, true)
    expect(await p.actions.switchAccount(T1, ACC_WORK)).toBe(true)
    await until(() => p.a.closed.length === 1 && p.a.muted.length === 1 && p.a.restarted.length === 1)
    expect(p.a.closed).toEqual([T1])
    expect(p.a.muted).toEqual([[T1, true]])
    expect(p.a.restarted).toEqual([[T1, true]])
    expect(p.a.switched).toEqual([[T1, ACC_WORK]])
  })

  it("the folders of another device's tab come from that device, and a change to a missing folder is refused with its message", async () => {
    const p = await open()
    const dir = mkdtempSync(join(tmpdir(), 'ct-remote-folder-'))
    try {
      mkdirSync(join(dir, 'docs'))
      p.a.infos.set(T1, tabInfo(T1, { folder: dir }))
      p.a.home = dir
      expect(await p.actions.listFolders(T1, null)).toMatchObject({ ok: true, listing: { device: 'Studio', path: dir, folders: ['docs'] } })
      expect(await p.actions.listFolders(T1, '~')).toMatchObject({ ok: true, listing: { path: dir } })
      expect(await p.actions.changeFolder(T1, '/nope')).toEqual({ ok: false, error: REMOTE_COPY.folderMissing })
      expect(await p.actions.changeFolder(T1, join(dir, 'docs'))).toEqual({ ok: true })
      expect(p.a.folderChanges).toEqual([[T1, join(dir, 'docs')]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("an empty or blank folder is the device's own refusal: changing to it and listing it both say the folder is not absolute", async () => {
    const p = await open()
    const dir = mkdtempSync(join(tmpdir(), 'ct-remote-empty-'))
    try {
      p.a.infos.set(T1, tabInfo(T1, { folder: dir }))
      p.a.home = dir
      expect(await p.actions.changeFolder(T1, '')).toEqual({ ok: false, error: REMOTE_COPY.folderNotAbsolute })
      expect(await p.actions.changeFolder(T1, '   ')).toEqual({ ok: false, error: REMOTE_COPY.folderNotAbsolute })
      expect(await p.actions.listFolders(T1, '')).toEqual({ ok: false, error: REMOTE_COPY.folderNotAbsolute })
      expect(p.a.folderChanges).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the folder calls refuse a tab A does not have, and bad arguments, as the other calls do', async () => {
    const p = await open()
    await expect(p.actions.ask(A_ID, 'folders', { id: T9, path: null })).rejects.toThrow(REMOTE_COPY.unknownTab)
    await expect(p.actions.ask(A_ID, 'change-folder', { id: T9, path: '/x' })).rejects.toThrow(REMOTE_COPY.unknownTab)
    await expect(p.actions.ask(A_ID, 'folders', { id: T1, path: 5 } as unknown as CallArgs['folders'])).rejects.toThrow('bad arguments')
    expect(p.a.folderChanges).toEqual([])
  })

  it('a call to a device that is offline is refused with its name', async () => {
    const p = await open()
    p.linkB.close('test')
    await until(() => !p.viewerB.online(A_ID))
    await expect(p.actions.ask(A_ID, 'profiles', {})).rejects.toThrow(REMOTE_COPY.deviceOffline('Studio'))
  })

  it('a reply of the wrong shape is refused', async () => {
    const p = await open()
    p.a.profilesAnswer = 42
    await expect(p.actions.ask(A_ID, 'profiles', {})).rejects.toThrow('bad reply')
  })

  it('a call about a tab A does not have is refused by A with the unknown-tab message', async () => {
    const p = await open()
    await expect(p.actions.ask(A_ID, 'close', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    expect(p.a.closed).toEqual([])
  })

  it('a call about a tab no device has is refused by B, and a fire-and-forget call toasts the failure', async () => {
    const p = await open()
    await expect(p.actions.askTab(T9, 'close', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    p.actions.rename(T9, 'x')
    await until(() => p.toasts.length === 1)
    expect(p.toasts).toEqual([REMOTE_COPY.unknownTab])
  })

  it('switch-account of a tab no device has is false, and the failure is toasted', async () => {
    const p = await open()
    expect(await p.actions.switchAccount(T9, null)).toBe(false)
    expect(p.toasts).toEqual([REMOTE_COPY.unknownTab])
  })

  it("clear-task-list from B clears the list on A; A refuses a shell tab and an unknown tab, and B toasts each refusal", async () => {
    const p = await open()
    expect(await p.actions.clearTaskList(T1)).toBe(true)
    expect(p.a.clearedLists).toEqual([T1])
    expect(p.toasts).toEqual([])
    expect(await p.actions.clearTaskList(T2)).toBe(false)
    expect(p.toasts).toEqual([REMOTE_COPY.clearTaskListFailed])
    expect(await p.actions.clearTaskList(T9)).toBe(false)
    expect(p.toasts).toEqual([REMOTE_COPY.clearTaskListFailed, REMOTE_COPY.unknownTab])
    expect(p.a.clearedLists).toEqual([T1])
  })

  it('clear-task-list from a device that is not attached to the tab clears it: pairing is the trust boundary', async () => {
    const p = await open()
    p.a.watchers.set(T1, new Set())
    expect(await p.actions.clearTaskList(T1)).toBe(true)
    expect(p.a.clearedLists).toEqual([T1])
    expect(p.toasts).toEqual([])
  })
})

describe('the Changes actions of a remote tab', () => {
  let pairs: Pair[] = []

  afterEach(async () => {
    for (const p of pairs) {
      for (const h of p.hosts) h.dispose()
      for (const m of p.mirrors) m.dispose()
      for (const v of p.viewers) v.dispose()
    }
    pairs = []
    await closeLinkPairs()
  })

  async function open(o: PairOptions = {}): Promise<Pair> {
    const p = await pair(o)
    pairs.push(p)
    return p
  }

  it("review actions and can-send reach the tab's device", async () => {
    const p = await open()
    p.actions.review(T1, { k: 'viewed', path: ABS_A, hash: H, viewed: true })
    await until(() => p.a.viewed.length === 1)
    expect(p.a.viewed).toEqual([[T1, ABS_A, H, true]])
    p.actions.review(T1, { k: 'show', path: ABS_A })
    p.actions.review(T1, { k: 'scope', scope: 'session' })
    p.actions.review(T1, { k: 'clear' })
    p.actions.review(T1, { k: 'refresh' })
    await until(() => p.a.refreshed.length === 1)
    expect(p.a.shown).toEqual([[T1, ABS_A]])
    expect(p.a.scoped).toEqual([[T1, 'session']])
    expect(p.a.cleared).toEqual([T1])
    expect(await p.actions.canSend(T1)).toEqual({ ok: true })
    expect(p.toasts).toEqual([])
  })

  it("a path that is not absolute by the tab device's rules is refused there", async () => {
    const p = await open()
    p.actions.review(T1, { k: 'show', path: 'relative/a.ts' })
    p.actions.review(T1, { k: 'refresh' })
    await until(() => p.a.refreshed.length === 1)
    expect(p.a.shown).toEqual([])
    await until(() => p.toasts.length === 1)
    expect(p.toasts).toEqual(['bad arguments'])
  })

  it('a Viewed of a binary file, whose hash is 71 characters in a SHA-256 repository, reaches the device', async () => {
    const p = await open()
    const hash = 'binary:' + 'f'.repeat(64)
    p.actions.review(T1, { k: 'viewed', path: ABS_A, hash, viewed: true })
    await until(() => p.a.viewed.length === 1)
    expect(p.a.viewed).toEqual([[T1, ABS_A, hash, true]])
    expect(p.toasts).toEqual([])
  })

  it('the device refuses a Viewed with a relative path or a 129-character hash, and a malformed review for an unknown tab says bad arguments', async () => {
    const p = await open()
    p.actions.review(T1, { k: 'viewed', path: 'relative/a.ts', hash: H, viewed: true })
    p.actions.review(T1, { k: 'viewed', path: ABS_A, hash: 'x'.repeat(129), viewed: true })
    p.actions.review(T1, { k: 'refresh' })
    await until(() => p.a.refreshed.length === 1)
    await until(() => p.toasts.length === 2)
    expect(p.a.viewed).toEqual([])
    expect(p.toasts).toEqual(['bad arguments', 'bad arguments'])
    // T1 is gone from the device, so only the shape check can refuse this action: it is bad arguments, not unknownTab
    p.a.infos.delete(T1)
    p.actions.review(T1, { k: 'nope' } as unknown as ReviewAction)
    await until(() => p.toasts.length === 3)
    expect(p.toasts).toEqual(['bad arguments', 'bad arguments', 'bad arguments'])
  })

  it('can-send answers what the tab says, and not running for a tab with no device, a bad reply or an offline device', async () => {
    const p = await open()
    p.a.sendState = { ok: false, reason: 'busy' }
    expect(await p.actions.canSend(T1)).toEqual({ ok: false, reason: 'busy' })
    expect(await p.actions.canSend(T9)).toEqual({ ok: false, reason: NOT_RUNNING })
    p.a.sendState = { ok: 1 } as unknown as { ok: true }
    expect(await p.actions.canSend(T1)).toEqual({ ok: false, reason: NOT_RUNNING })
    p.linkB.close('test')
    await until(() => !p.viewerB.online(A_ID))
    expect(await p.actions.canSend(T1)).toEqual({ ok: false, reason: NOT_RUNNING })
    expect(p.toasts).toEqual([])
  })

  it("a review published while the member was away reaches its open Changes panel when the link comes back, with no refresh", async () => {
    const pushes: { id: string; value: unknown }[] = []
    const p = await open({ viewerEvents: { ...quietEvents, push: (id, value) => pushes.push({ id, value }) } })
    // the review seen by the window: the additions of each review push of T1, in order
    const seen = (): number[] =>
      pushes
        .filter((x) => x.id === T1)
        .map((x) => x.value as { k: string; v: { additions: number } })
        .filter((x) => x.k === 'review')
        .map((x) => x.v.additions)
    p.a.reviews.set(T1, reviewUpdate(T1, { additions: 1 }))
    p.viewerB.activated(T1)
    await until(() => seen().includes(1))
    p.linkB.close('test')
    await until(() => !p.viewerB.online(A_ID))
    // A publishes its newer review while the member is away: its host pushes it to nobody
    const latest = reviewUpdate(T1, { additions: 7 })
    p.a.reviews.set(T1, latest)
    p.hostA.push(T1, 'review', withoutTabId(latest))
    // the link comes back with the same tab ids; B does not ask for the review
    const link = await linkPair()
    connectPeer(link.client, helloOf(A_ID, 'Studio'), p.hostB, p.viewerB, {})
    connectPeer(link.server, helloOf(B_ID, 'Laptop'), p.hostA, p.viewers[0], hostHandlers(p.a.ctx, B_ID))
    await until(() => p.viewerB.online(A_ID))
    await until(() => seen().includes(7))
    expect(seen()).toEqual([1, 7])
    expect(p.a.refreshed).toEqual([])
    expect(p.a.scoped).toEqual([])
    expect(p.a.cleared).toEqual([])
    expect(p.a.viewed).toEqual([])
    expect(p.a.shown).toEqual([])
    expect(p.toasts).toEqual([])
  })
})

describe('remoteTabInfo', () => {
  it('keeps the TabInfo fields of the tab and what its device adds', () => {
    const tab: RemoteTab = {
      id: T1,
      kind: 'claude',
      profile: 'Claude',
      cwd: '/work/demo',
      customTitle: 'build',
      title: 'vim',
      claudeSessionId: null,
      account: ACC_WORK,
      accountName: 'Work',
      muted: true,
      exited: false,
      working: false,
      attention: null,
      attentionSeq: 0,
      images: 3,
      note: false,
      counter: null,
      status: null,
      size: { cols: 80, rows: 24, by: null },
      place: null,
      placeKnown: true,
      folder: '/work/demo',
      forkOf: null,
      fork: false
    }
    expect(remoteTabInfo(A_ID, tab)).toEqual({
      id: T1,
      kind: 'claude',
      profile: 'Claude',
      cwd: '/work/demo',
      folder: '/work/demo',
      customTitle: 'build',
      claudeSessionId: null,
      account: ACC_WORK,
      muted: true,
      fork: null,
      exited: false,
      activity: null,
      remote: { device: A_ID, accountName: 'Work', images: 3, title: 'vim' }
    })
  })

  it('the folder the tab works in is the folder its device sent; the cwd stays the one it opened in', () => {
    const info = remoteTabInfo(A_ID, { ...remoteEntry(), folder: '/work/demo-wt' })
    expect(info).toMatchObject({ cwd: '/work/demo', folder: '/work/demo-wt' })
  })

  it('a fork entry is a fork of its head while the head is open, and of none once it closed', () => {
    const entry: RemoteTab = { ...remoteEntry(), fork: true, forkOf: T1 }
    expect(remoteTabInfo(A_ID, entry).fork).toEqual({ of: T1, from: null })
    expect(remoteTabInfo(A_ID, { ...entry, forkOf: null }).fork).toEqual({ of: null, from: null })
    expect(remoteTabInfo(A_ID, remoteEntry()).fork).toBeNull()
  })
})

/** a tab of another device as its directory entry has it, with no place and no fork */
function remoteEntry(): RemoteTab {
  return {
    id: T1,
    kind: 'claude',
    profile: 'Claude',
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
    fork: false
  }
}

/** a RemoteTabs that knows one device whose calls fail as the test says */
function failingViewer(failWith: CallError | Error | null, online = true) {
  const devices = [{ id: A_ID, name: 'Studio', platform: 'linux' as DevicePlatform, online }]
  return {
    devices: () => devices,
    online: () => online,
    callsOf: () =>
      online
        ? {
            call: async () => {
              if (failWith) throw failWith
              return null
            }
          }
        : null,
    deviceOf: (id: string) => (id === T1 ? A_ID : null)
  } as unknown as RemoteTabs
}

describe('how a failed call reads to the caller', () => {
  it('a call that is not answered in time is refused as no answer from the device', async () => {
    const actions = new RemoteActions(failingViewer(new CallError('timeout')), () => {})
    await expect(actions.ask(A_ID, 'profiles', {})).rejects.toThrow(REMOTE_COPY.noAnswer('Studio'))
  })

  it('a link that closes during a call is refused as the device not connected', async () => {
    const actions = new RemoteActions(failingViewer(new CallError('link closed')), () => {})
    await expect(actions.ask(A_ID, 'profiles', {})).rejects.toThrow(REMOTE_COPY.deviceOffline('Studio'))
  })

  it('any other refusal of the other device passes through as its message', async () => {
    const actions = new RemoteActions(failingViewer(new CallError('busy')), () => {})
    await expect(actions.ask(A_ID, 'profiles', {})).rejects.toThrow('busy')
  })

  it('a device with no link is refused as not connected, by name', async () => {
    const actions = new RemoteActions(failingViewer(null, false), () => {})
    await expect(actions.ask(A_ID, 'profiles', {})).rejects.toThrow(REMOTE_COPY.deviceOffline('Studio'))
  })
})

describe('the media of another device', () => {
  let pairs: Pair[] = []
  const dirs: string[] = []
  const C1 = imageCard(1).id
  const C2 = imageCard(2).id
  const C_UNKNOWN = imageCard(9).id
  /** the 9 MiB file of A's card C1, of T1: three parts */
  const NINE_MIB = 9 * 1024 * 1024

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  afterEach(async () => {
    for (const p of pairs) {
      for (const h of p.hosts) h.dispose()
      for (const m of p.mirrors) m.dispose()
      for (const v of p.viewers) v.dispose()
    }
    pairs = []
    await closeLinkPairs()
  })

  /** a pair whose A holds C1 (of T1, a file of `size` random bytes) and C2 (of T2); returns the bytes of C1 */
  async function withMedia(size: number): Promise<{ p: Pair; bytes: Buffer }> {
    const p = await pair()
    pairs.push(p)
    const dir = mkdtempSync(join(tmpdir(), 'ct-media-int-'))
    dirs.push(dir)
    const bytes = randomBytes(size)
    const file = join(dir, 'shot.png')
    writeFileSync(file, bytes)
    const other = join(dir, 'other.png')
    writeFileSync(other, 'other')
    p.a.cards.push(imageCard(1, { path: file, tabId: T1 }), imageCard(2, { path: other, tabId: T2 }))
    return { p, bytes }
  }

  it('image bytes come in parts and equal the file; a card of another tab is refused', async () => {
    const { p, bytes } = await withMedia(NINE_MIB)
    const got = await p.actions.imageBytes(T1, C1, 1)
    expect(got!.version).toBe(1)
    expect(got!.data.equals(bytes)).toBe(true)
    await expect(p.actions.askTab(T1, 'image', { id: T1, card: C2, offset: 0 }, { bulk: true })).rejects.toThrow(REMOTE_COPY.unknownTab)
  })

  it('two fetches of one card at once make one set of part calls (R3)', async () => {
    const { p, bytes } = await withMedia(NINE_MIB)
    let parts = 0
    const get = p.a.ctx.images.get
    p.a.ctx.images.get = (id) => {
      if (id === C1) parts++
      return get(id)
    }
    const [x, y] = await Promise.all([p.actions.imageBytes(T1, C1, 1), p.actions.imageBytes(T1, C1, 1)])
    expect(parts).toBe(Math.ceil(bytes.length / IMAGE_PART_BYTES))
    expect(x!.data.equals(bytes)).toBe(true)
    expect(y!.data.equals(bytes)).toBe(true)
  })

  it('a card that changes its version between parts gives no bytes', async () => {
    const { p } = await withMedia(NINE_MIB)
    let parts = 0
    const get = p.a.ctx.images.get
    p.a.ctx.images.get = (id) => {
      if (id === C1 && ++parts === 2) p.a.cards.find((c) => c.id === C1)!.version = 2
      return get(id)
    }
    expect(await p.actions.imageBytes(T1, C1, 1)).toBeNull()
  })

  it('a card the other device does not have gives no bytes', async () => {
    const { p } = await withMedia(10)
    expect(await p.actions.imageBytes(T1, C_UNKNOWN, 1)).toBeNull()
  })

  it('marking seen on a device that is not connected says nothing (a background action)', async () => {
    const p = await pair()
    pairs.push(p)
    p.linkB.close('test')
    await until(() => !p.viewerB.online(A_ID))
    p.actions.markImagesSeen(T1)
    // a removal after it is refused at once too, and its toast comes after any toast the mark would have made (calls are FIFO)
    p.actions.removeImage(T1, 'x')
    await until(() => p.toasts.length > 0)
    expect(p.toasts).toEqual([REMOTE_COPY.deviceOffline('Studio')])
    expect(p.a.marked).toEqual([])
  })

  it('marking the media seen and removing a card reach the other device', async () => {
    const { p } = await withMedia(10)
    p.actions.markImagesSeen(T1)
    p.actions.removeImage(T1, C1)
    await until(() => p.a.removedCards.length === 1)
    expect(p.a.marked).toEqual([T1])
    expect(p.a.removedCards).toEqual([C1])
    expect(p.toasts).toEqual([])
  })
})

describe('the read queue of the media', () => {
  let pairs: Pair[] = []
  const dirs: string[] = []
  const MIB = 1024 * 1024
  const C1 = imageCard(1).id

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  afterEach(async () => {
    for (const p of pairs) {
      for (const h of p.hosts) h.dispose()
      for (const m of p.mirrors) m.dispose()
      for (const v of p.viewers) v.dispose()
    }
    pairs = []
    await closeLinkPairs()
  })

  /** a pair whose A holds `count` cards of `size` random bytes each, of T1: card i+1 is imageCard(i+1).id */
  async function withCards(count: number, size: number, o: PairOptions = {}): Promise<{ p: Pair; files: Buffer[] }> {
    const p = await pair(o)
    pairs.push(p)
    const dir = mkdtempSync(join(tmpdir(), 'ct-queue-int-'))
    dirs.push(dir)
    const files: Buffer[] = []
    for (let i = 0; i < count; i++) {
      const bytes = randomBytes(size)
      const path = join(dir, `card-${i + 1}.png`)
      writeFileSync(path, bytes)
      files.push(bytes)
      p.a.cards.push(imageCard(i + 1, { path, tabId: T1 }))
    }
    return { p, files }
  }

  /** wraps A's image handler to count the calls running at once: peak() is the most that ran together */
  function countRunning() {
    let running = 0
    let peak = 0
    return {
      peak: () => peak,
      wrap: (entry: CallEntry): CallEntry => ({
        ...entry,
        run: async (a: unknown) => {
          running++
          peak = Math.max(peak, running)
          try {
            return await entry.run(a)
          } finally {
            running--
          }
        }
      })
    }
  }

  it('twenty 1.5 MiB cards asked for at once all come back, no link closes, and at most two part calls run at once', async () => {
    const count = countRunning()
    const { p, files } = await withCards(20, 1.5 * MIB, { aLink: { maxQueuedBulkBytes: 3 * IMAGE_PART_BYTES }, wrapImage: count.wrap })
    const got = await Promise.all(files.map((_, i) => p.actions.imageBytes(T1, imageCard(i + 1).id, 1, () => true)))
    got.forEach((g, i) => {
      expect(g).not.toBeNull()
      expect(g!.data.equals(files[i]!)).toBe(true)
    })
    expect(p.viewerB.online(A_ID)).toBe(true)
    expect(count.peak()).toBeGreaterThan(0)
    expect(count.peak()).toBeLessThanOrEqual(2)
  }, 60_000)

  it('seventy small cards asked for at once all come back, with no busy refusal', async () => {
    const count = countRunning()
    const { p, files } = await withCards(70, 10, { wrapImage: count.wrap })
    const got = await Promise.all(files.map((_, i) => p.actions.imageBytes(T1, imageCard(i + 1).id, 1, () => true)))
    got.forEach((g, i) => {
      expect(g).not.toBeNull()
      expect(g!.data.equals(files[i]!)).toBe(true)
    })
    expect(count.peak()).toBeLessThanOrEqual(2)
  }, 60_000)

  it('a queued read whose card is gone is answered null, and its part is never asked of A', async () => {
    const gone = imageCard(3).id
    let asked = 0
    const { p, files } = await withCards(3, 1.5 * MIB, {
      wrapImage: (entry) => ({
        ...entry,
        run: (a: unknown) => {
          if ((a as { card: string }).card === gone) asked++
          return entry.run(a)
        }
      })
    })
    const [one, two, three] = await Promise.all([
      p.actions.imageBytes(T1, imageCard(1).id, 1, () => true),
      p.actions.imageBytes(T1, imageCard(2).id, 1, () => true),
      p.actions.imageBytes(T1, gone, 1, () => false)
    ])
    expect(one!.data.equals(files[0]!)).toBe(true)
    expect(two!.data.equals(files[1]!)).toBe(true)
    expect(three).toBeNull()
    expect(asked).toBe(0)
  }, 60_000)

  it('a read of one version is not shared with a read of a newer version of the card', async () => {
    const { p, files } = await withCards(1, 9 * MIB)
    // the second part call A serves finds the card at version 2: the card moved while a version 1 read was out
    let calls = 0
    const get = p.a.ctx.images.get
    p.a.ctx.images.get = (id) => {
      if (id === C1 && ++calls === 2) p.a.cards.find((c) => c.id === C1)!.version = 2
      return get(id)
    }
    const old = p.actions.imageBytes(T1, C1, 1, () => true)
    const now = p.actions.imageBytes(T1, C1, 2, () => true)
    const version2 = await now
    expect(version2!.version).toBe(2)
    expect(version2!.data.equals(files[0]!)).toBe(true)
    await old
  }, 60_000)

  it('a started read keeps its turn: its next part goes before the first part of a read that waits', async () => {
    const C2 = imageCard(2).id
    const C3 = imageCard(3).id
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { p, files } = await withCards(3, 9 * MIB, {
      wrapImage: (entry) => ({
        ...entry,
        run: async (a: unknown) => {
          const { card, offset } = a as { card: string; offset: number }
          order.push(`${card} ${offset}`)
          if (card === C3 && offset === 0) await held
          return entry.run(a)
        }
      })
    })
    // card 3 takes one of the two read slots until released; cards 1 and 2 are asked at once and share the other slot
    const blocker = p.actions.imageBytes(T1, C3, 1, () => true)
    await until(() => order.includes(`${C3} 0`))
    const one = p.actions.imageBytes(T1, C1, 1, () => true)
    const two = p.actions.imageBytes(T1, C2, 1, () => true)
    await until(() => order.filter((x) => x.startsWith(C1)).length === 3 || order.some((x) => x.startsWith(C2)), 30_000)
    release()
    const [g1, g2, g3] = await Promise.all([one, two, blocker])
    expect(g1).not.toBeNull()
    expect(g2).not.toBeNull()
    expect(g3).not.toBeNull()
    expect(g1!.data.equals(files[0]!)).toBe(true)
    expect(g2!.data.equals(files[1]!)).toBe(true)
    const ones = order.flatMap((x, i) => (x.startsWith(C1) ? [i] : []))
    expect(ones.length).toBe(Math.ceil((9 * MIB) / IMAGE_PART_BYTES))
    expect(Math.max(...ones)).toBeLessThan(order.findIndex((x) => x.startsWith(C2)))
  }, 60_000)
})

describe('the requests of the media reads', () => {
  const C1 = imageCard(1).id

  it('a part request goes on the normal lane, with the image time limit', async () => {
    const sent: { m: string; opts: unknown }[] = []
    const viewer = {
      devices: () => [{ id: A_ID, name: 'Studio', platform: 'linux' as DevicePlatform, online: true }],
      online: () => true,
      callsOf: () => ({
        call: async (m: string, _a: unknown, opts: unknown) => {
          sent.push({ m, opts })
          return { version: 1, size: 3, data: Buffer.from('abc').toString('base64') }
        }
      }),
      deviceOf: (id: string) => (id === T1 ? A_ID : null)
    } as unknown as RemoteTabs
    const actions = new RemoteActions(viewer, () => {})
    expect(await actions.imageBytes(T1, C1, 1, () => true)).toEqual({ version: 1, data: Buffer.from('abc') })
    expect(sent).toEqual([{ m: 'image', opts: { timeoutMs: IMAGE_PART_TIMEOUT_MS } }])
  })
})

describe("a remote Claude tab's place, its fork and Fork session", () => {
  let pairs: Pair[] = []
  const FORK = tabId(4)
  const PLACE: TabPlace = { project: { key: 'd:/work/demo', name: 'demo', parent: 'work' }, worktree: null, branch: 'main' }

  afterEach(async () => {
    for (const p of pairs) {
      for (const h of p.hosts) h.dispose()
      for (const m of p.mirrors) m.dispose()
      for (const v of p.viewers) v.dispose()
    }
    pairs = []
    await closeLinkPairs()
  })

  async function newPair(): Promise<Pair> {
    const p = await pair()
    pairs.push(p)
    return p
  }

  it("A's place of a tab reaches B, and each change of the place reaches B", async () => {
    const p = await newPair()
    p.a.places.set(T1, PLACE)
    p.hostA.changed()
    await until(() => p.viewerB.tab(T1)?.place !== null)
    expect(p.viewerB.tab(T1)?.place).toEqual(PLACE)
    p.a.places.set(T1, { ...PLACE, branch: 'feat/x' })
    p.hostA.changed()
    await until(() => p.viewerB.tab(T1)?.place?.branch === 'feat/x')
  })

  it("a fork of A's tab is B's fork of its head; once the head closes, it is a fork with no head", async () => {
    const p = await newPair()
    p.a.infos.set(FORK, tabInfo(FORK, { fork: { of: T1, from: null } }))
    p.hostA.changed()
    await until(() => p.viewerB.has(FORK))
    expect(p.viewerB.tab(FORK)).toMatchObject({ forkOf: T1, fork: true })
    p.a.infos.delete(T1)
    p.a.infos.set(FORK, tabInfo(FORK, { fork: { of: null, from: null } }))
    p.hostA.changed()
    await until(() => !p.viewerB.has(T1))
    expect(p.viewerB.tab(FORK)).toMatchObject({ forkOf: null, fork: true })
  })

  it("B asks A whether a tab can be forked, and forks it there: the new tab's id comes back", async () => {
    const p = await newPair()
    expect(await p.actions.canFork(T1)).toBe(true)
    p.a.canForkAnswer = false
    expect(await p.actions.canFork(T1)).toBe(false)
    p.a.canForkAnswer = true
    expect(await p.actions.forkTab(T1)).toBe(T3)
    expect(p.a.forked).toEqual([T1])
    expect(p.toasts).toEqual([])
  })

  it("a fork A refuses is toasted once, with the window's sentence, and gives no id", async () => {
    const p = await newPair()
    p.a.forkAnswer = false
    expect(await p.actions.forkTab(T1)).toBeNull()
    expect(p.toasts).toEqual([REMOTE_COPY.forkFailed])
  })

  it('a device that is gone: canFork is false at once, not after the time limit, and a fork is toasted as offline', async () => {
    const p = await newPair()
    p.linkB.close('gone')
    await until(() => !p.viewerB.online(A_ID))
    const started = Date.now()
    expect(await p.actions.canFork(T1)).toBe(false)
    expect(Date.now() - started).toBeLessThan(LIST_TIMEOUT_MS)
    expect(await p.actions.forkTab(T1)).toBeNull()
    expect(p.toasts).toEqual([REMOTE_COPY.deviceOffline('Studio')])
  })
})

const SESSION_1 = 'd5f1c3a2-7b8e-4c6d-9a0b-1c2d3e4f5a6b'
const SESSION_2 = 'e6a2d4b3-8c9f-4d7e-8b1c-2d3e4f5a6b7c'
const SESSION_3 = 'f7b3e5c4-9d0a-4e8f-9c2d-3e4f5a6b7c8d'

/** a session of this device as its history lists it */
function sessionOf(id: string, over: Partial<RecentSession> = {}): RecentSession {
  return { id, cwd: '/work/demo', title: 'Fix the login bug', firstPrompt: null, lastPrompt: null, modifiedAt: 1_000, open: false, starred: false, ...over }
}

describe('the Recent sessions of the other devices', () => {
  let pairs: Pair[] = []

  afterEach(async () => {
    for (const p of pairs) {
      for (const h of p.hosts) h.dispose()
      for (const m of p.mirrors) m.dispose()
      for (const v of p.viewers) v.dispose()
    }
    pairs = []
    await closeLinkPairs()
  })

  /** a pair whose Studio holds its sessions answer until the returned function releases it, and counts the asks */
  async function holdingSessions(): Promise<{ p: Pair; runs: () => number; hold(): () => void }> {
    let n = 0
    let gate: Promise<void> | null = null
    const p = await pair({
      wrapSessions: (entry) => ({
        ...entry,
        run: async (a: unknown) => {
          n++
          if (gate) await gate
          return entry.run(a)
        }
      })
    })
    pairs.push(p)
    return {
      p,
      runs: () => n,
      hold(): () => void {
        let release = (): void => {}
        gate = new Promise<void>((resolve) => {
          release = resolve
        })
        return () => {
          gate = null
          release()
        }
      }
    }
  }

  /** Cellar, a third device that refuses the sessions call: it has no sessions to give */
  const refusingSessions = listAnswers(['Fish'], [{ id: ACC_WORK, name: 'Work' }])
  refusingSessions.handlers.sessions = {
    run: () => {
      throw new CallError('not here')
    }
  }

  /** a call A refuses at once (SESSION_3 is not listed): its answer comes after the earlier calls on A's link, which keeps their order */
  async function marker(p: Pair): Promise<void> {
    await expect(p.actions.ask(A_ID, 'open-session', { session: SESSION_3 })).rejects.toThrow()
  }

  const studioValue = (p: Pair) => p.actions.sessionsNow().find((d) => d.name === 'Studio')!.value
  const cellarValue = (p: Pair) => p.actions.sessionsNow().find((d) => d.name === 'Cellar')!.value

  it('sessionsNow answers at once; a device that has not answered has null; sessions come with the name of their device; one that does not answer keeps null', async () => {
    const p = await pair()
    pairs.push(p)
    await cellarJoins(p, refusingSessions)
    p.a.sessionList = [sessionOf(SESSION_1)]
    expect(p.actions.sessionsNow().map((d) => d.value)).toEqual([null, null])
    p.actions.refreshSessions()
    await until(() => p.fresh.includes('sessions'))
    expect(studioValue(p)![0]).toMatchObject({ id: SESSION_1, device: { id: A_ID, name: 'Studio' } })
    expect(cellarValue(p)).toBeNull()
    expect(p.toasts).toEqual([])
  })

  it('two refreshes in a row ask a device that holds its answer once', async () => {
    const { p, runs, hold } = await holdingSessions()
    await cellarJoins(p, refusingSessions)
    const release = hold()
    p.actions.refreshSessions()
    p.actions.refreshSessions()
    await until(() => runs() === 1)
    await marker(p)
    expect(runs()).toBe(1)
    release()
    await until(() => p.fresh.includes('sessions'))
  })

  it('a device that stops answering keeps its last answer, and a changed answer is announced', async () => {
    const { p, runs, hold } = await holdingSessions()
    await cellarJoins(p, refusingSessions)
    p.a.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => studioValue(p) !== null)
    const kept = studioValue(p)
    const freshBefore = p.fresh.length
    const release = hold()
    p.actions.refreshSessions()
    await new Promise((resolve) => setTimeout(resolve, LIST_TIMEOUT_MS + 300))
    expect(runs()).toBe(2)
    expect(studioValue(p)).toEqual(kept)
    expect(p.fresh.length).toBe(freshBefore)
    release()
    await marker(p)
  })

  it('openSession from B answers the tab A opened for the session, and A refusing a session it did not list toasts its sentence', async () => {
    const p = await pair()
    pairs.push(p)
    p.a.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => p.fresh.includes('sessions'))
    expect(await p.actions.openSession(A_ID, SESSION_1)).toBe(T3)
    expect(p.a.openedSessions).toEqual([SESSION_1])
    expect(await p.actions.openSession(A_ID, SESSION_3)).toBeNull()
    expect(p.a.openedSessions).toEqual([SESSION_1])
    expect(p.toasts).toEqual([REMOTE_COPY.unknownSession])
  })

  /** a bulk call to A: its reply comes after the sessions replies sent before it on A's link */
  async function sessionsMarker(p: Pair): Promise<void> {
    await p.actions.ask(A_ID, 'sessions', {})
  }

  it('onFresh says sessions only when the list changes: the same list again is no announcement', async () => {
    const p = await pair()
    pairs.push(p)
    p.a.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => p.fresh.includes('sessions'))
    p.actions.refreshSessions()
    await sessionsMarker(p)
    expect(p.fresh.filter((w) => w === 'sessions')).toHaveLength(1)
    p.a.sessionList = [sessionOf(SESSION_1), sessionOf(SESSION_2)]
    p.actions.refreshSessions()
    await until(() => p.fresh.filter((w) => w === 'sessions').length === 2)
    expect(studioValue(p)!.map((s) => s.id)).toEqual([SESSION_1, SESSION_2])
  })

  it('after a device drops and comes back, a session it listed before the drop is still openable (I3)', async () => {
    const p = await pair()
    pairs.push(p)
    p.a.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => p.fresh.includes('sessions'))
    p.linkB.close('test')
    await until(() => !p.viewerB.online(A_ID))
    const link = await linkPair()
    connectPeer(link.client, helloOf(A_ID, 'Studio'), p.hostB, p.viewerB, {})
    connectPeer(link.server, helloOf(B_ID, 'Laptop'), p.hostA, p.viewers[0]!, hostHandlers(p.a.ctx, B_ID))
    await until(() => p.viewerB.online(A_ID))
    expect(await p.actions.openSession(A_ID, SESSION_1)).toBe(T3)
    expect(p.a.openedSessions).toEqual([SESSION_1])
    expect(p.toasts).toEqual([])
  })

  it('a session two devices list is opened on the one that is online, when the other has gone', async () => {
    const p = await pair()
    pairs.push(p)
    // Studio's answer is kept first, so it is the first device that lists the session
    p.a.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => studioValue(p) !== null)
    const cellar = listAnswers(['Fish'], [{ id: ACC_WORK, name: 'Work' }])
    cellar.handlers.sessions = { run: () => [sessionOf(SESSION_1)] }
    await cellarJoins(p, cellar)
    p.actions.refreshSessions()
    await until(() => cellarValue(p) !== null)
    // Studio goes; the session is still listed by Cellar, which is online
    p.linkB.close('test')
    await until(() => !p.viewerB.online(A_ID))
    expect(p.actions.deviceOfSession(SESSION_1)).toBe(C_ID)
  })

  it('a pick of a session both online devices list opens it on the device of the section it was picked in', async () => {
    const p = await pair()
    pairs.push(p)
    // Studio's answer is kept first, so a pick without a device goes to Studio
    p.a.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => studioValue(p) !== null)
    // Cellar's own host lists the session too, so its open-session accepts it
    const c = await cellarJoins(p, listAnswers(['Fish'], [{ id: ACC_WORK, name: 'Work' }]))
    c.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => cellarValue(p) !== null)
    expect(p.actions.deviceOfSession(SESSION_1)).toBe(A_ID)
    // the pick made in Cellar's section carries Cellar's id, and the open goes there
    const device = p.actions.deviceOfSession(SESSION_1, C_ID)
    expect(device).toBe(C_ID)
    expect(await p.actions.openSession(device!, SESSION_1)).toBe(T3)
    expect(c.openedSessions).toEqual([SESSION_1])
    expect(p.a.openedSessions).toEqual([])
  })

  it("a pick in an offline device's section opens nowhere else: the open asks that device and says it is not connected", async () => {
    const p = await pair()
    pairs.push(p)
    // Studio's answer is kept first, and Cellar lists the session too
    p.a.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => studioValue(p) !== null)
    const c = await cellarJoins(p, listAnswers(['Fish'], [{ id: ACC_WORK, name: 'Work' }]))
    c.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => cellarValue(p) !== null)
    c.link.close('test')
    await until(() => !p.viewerB.online(C_ID))
    // the pick made in Cellar's section stays with Cellar, although Studio lists the session online
    const device = p.actions.deviceOfSession(SESSION_1, C_ID)
    expect(device).toBe(C_ID)
    expect(await p.actions.openSession(device!, SESSION_1)).toBeNull()
    expect(p.toasts).toEqual([REMOTE_COPY.deviceOffline('Cellar')])
    expect(p.a.openedSessions).toEqual([])
    expect(c.openedSessions).toEqual([])
  })

  it('a session of a device that is offline is not opened: the window says the device is not connected', async () => {
    const p = await pair()
    pairs.push(p)
    p.a.sessionList = [sessionOf(SESSION_1)]
    p.actions.refreshSessions()
    await until(() => p.fresh.includes('sessions'))
    expect(p.actions.deviceOfSession(SESSION_1)).toBe(A_ID)
    p.linkB.close('test')
    await until(() => !p.viewerB.online(A_ID))
    expect(p.actions.deviceOfSession(SESSION_1)).toBe(A_ID)
    expect(await p.actions.openSession(A_ID, SESSION_1)).toBeNull()
    expect(p.toasts).toEqual([REMOTE_COPY.deviceOffline('Studio')])
    expect(p.a.openedSessions).toEqual([])
  })
})
