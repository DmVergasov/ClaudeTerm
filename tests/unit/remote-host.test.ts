import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatBatchPush, clampPush, hostHandlers, hostTabs, packFiles, pruneListedMembers, readImagePart, reviewPushes } from '../../src/main/remote-host'
import { MAX_CHAT_PATCHES, parseChatPush } from '../../src/main/chat/chat-mirror'
import { Calls, CallError, type CallLink } from '../../src/main/sync/calls'
import { CALL_REPLIES, parsePush } from '../../src/main/sync/remote-shapes'
import { parseRemoteTab } from '../../src/main/sync/remote-wire'
import { MAX_FRAME_BYTES } from '../../src/main/sync/wire'
import type { AccountView } from '../../src/shared/accounts'
import { MAX_IMAGE_BYTES } from '../../src/shared/image-file'
import { IMAGE_PART_BYTES, MAX_CHAT_PUSH_BYTES, MAX_REVIEW_PARTS, REVIEW_PART_BYTES, type PushKind } from '../../src/shared/remote'
import type { ChatPatch, ChatSnapshot } from '../../src/shared/chat'
import { REMOTE_COPY } from '../../src/shared/remote'
import type { PlanStatus, PlanTask, RecentSession, TabPlace } from '../../src/shared/types'
import { ACC_WORK, B_ID, T1, T2, T3, T9, T_LONG_CWD, fakeHost, imageCard, mainStatus, reviewUpdate, tabId, tabInfo } from '../fixtures/host-context'
import { until } from '../fixtures/sync'

/** a review update without its tab id: what a review push carries */
function withoutTab(v: ReturnType<typeof reviewUpdate>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...v }
  delete copy.tabId
  return copy
}

/** a call on this device, as a member's call reaches it */
async function run(f: ReturnType<typeof fakeHost>, m: string, a: unknown): Promise<unknown> {
  return hostHandlers(f.ctx, B_ID)[m]!.run(a)
}

/** every directory entry of the host is one the receiver keeps, unchanged: what it sends is what the other device gets */
function expectReceived(f: ReturnType<typeof fakeHost>): void {
  const entries = hostTabs(f.ctx).list()
  expect(entries.length).toBeGreaterThan(0)
  for (const e of entries) expect(parseRemoteTab(JSON.parse(JSON.stringify(e)))).toEqual(e)
}

describe('chatBatchPush (chat mode): a batch goes as it is, or as the chat when it is over the push cap', () => {
  const batch = (n: number, text = 'a'): { fromRev: number; toRev: number; patches: ChatPatch[] } => ({
    fromRev: 0,
    toRev: n,
    patches: Array.from({ length: n }, () => ({ op: 'append', id: 'item-1', text } as ChatPatch)),
  })
  const snap = { tabId: T1, rev: 9, items: [], hasOlder: false, state: { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false } } as unknown as ChatSnapshot

  it('a small batch is a chat-patch push, as it is', () => {
    expect(chatBatchPush(batch(3), () => snap)).toEqual({ k: 'chat-patch', v: batch(3) })
  })

  it('a batch of more patches than a push takes is replaced by the chat as a snapshot push', () => {
    expect(chatBatchPush(batch(MAX_CHAT_PATCHES + 1), () => snap)).toEqual({ k: 'chat', v: snap })
  })

  it('a batch over the push cap in bytes is replaced by the snapshot too', () => {
    const big = batch(2, 'x'.repeat(MAX_CHAT_PUSH_BYTES))
    expect(chatBatchPush(big, () => snap)).toEqual({ k: 'chat', v: snap })
  })

  it('a batch with no chat left to send says nothing', () => {
    expect(chatBatchPush(batch(MAX_CHAT_PATCHES + 1), () => null)).toBeNull()
  })
})

describe('the directory of this device', () => {
  it('the directory entry of a tab says what the other devices show', () => {
    const f = fakeHost()
    f.reviews.set(T1, reviewUpdate(T1, { counter: { files: 2, additions: 3, deletions: 1, title: 'Changes' } }))
    expect(hostTabs(f.ctx).list()[0]).toMatchObject({
      accountName: 'Work',
      size: { cols: 80, rows: 24, by: B_ID },
      attention: 'permission',
      status: 'Opus 4.1 · 42% context',
      note: true,
      title: 'vim',
      working: true,
      images: 3,
      counter: { files: 2, additions: 3, deletions: 1, title: 'Changes' }
    })
  })

  it('a tab is working in the directory while its activity is working, agents it left running included, and idle otherwise', () => {
    const f = fakeHost()
    f.infos.set(T1, tabInfo(T1, { account: ACC_WORK, activity: null }))
    expect(hostTabs(f.ctx).list()[0]).toMatchObject({ id: T1, working: false })
    f.infos.set(T1, tabInfo(T1, { account: ACC_WORK, activity: 'working' }))
    expect(hostTabs(f.ctx).list()[0]).toMatchObject({ id: T1, working: true })
  })

  it('a tab with no claimed size is sized by this device, and a tab without attention has none', () => {
    const f = fakeHost()
    const entry = hostTabs(f.ctx).list()[1]
    expect(entry).toMatchObject({ id: T2, size: { cols: 100, rows: 30, by: null }, attention: null, note: false, status: null })
  })

  it('pushes give status, plan, images and the last review, in that order', async () => {
    const f = fakeHost()
    f.plans.set(T1, { title: 'Plan', tasks: [], done: 0, total: 0, finished: false })
    f.reviews.set(T1, reviewUpdate(T1))
    const pushes = await hostTabs(f.ctx).pushes(T1)
    expect(pushes.map((p) => p.k)).toEqual(['status', 'plan', 'images', 'review'])
    for (const p of pushes) expect(parsePush(p.k, p.v, T1)).not.toBeNull()
  })

  it('a plan push is the plan the status bar shows, with the flag that says whether it is the agent\'s task list; null when there is none', async () => {
    const f = fakeHost()
    const plan: PlanStatus = { title: 'Release prep', tasks: [], done: 0, total: 0, finished: false }
    f.plans.set(T1, plan)
    const planPushOf = async () => (await hostTabs(f.ctx).pushes(T1)).find((p) => p.k === 'plan')
    expect(await planPushOf()).toEqual({ k: 'plan', v: { ...plan, agentList: false } })
    f.agentLists.add(T1)
    expect(await planPushOf()).toEqual({ k: 'plan', v: { ...plan, agentList: true } })
    f.plans.delete(T1)
    expect(await planPushOf()).toEqual({ k: 'plan', v: null })
  })

  it('a tab with no review update pushes no review', async () => {
    const f = fakeHost()
    expect((await hostTabs(f.ctx).pushes(T2)).map((p) => p.k)).toEqual(['status', 'plan', 'images'])
  })

  it('the directory holds only the tabs this device has, and a tab that is not here is refused', async () => {
    const f = fakeHost()
    expect(hostTabs(f.ctx).has(T9)).toBe(false)
    await expect(run(f, 'close', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    expect(f.closed).toEqual([])
  })

  it('a call whose arguments do not fit is refused with bad arguments', async () => {
    const f = fakeHost()
    await expect(run(f, 'rename', { id: 'not-an-id', title: 'x' })).rejects.toThrow('bad arguments')
    expect(f.renamed).toEqual([])
  })
})

/** a tab's place as this device's place hub publishes it */
const PLACE: TabPlace = { project: { key: 'd:/work/demo', name: 'demo', parent: 'work' }, worktree: null, branch: 'main' }

describe('the place and the fork of a tab in the directory', () => {
  it('a tab carries the place its device published, and its fork: the head while it is open, and the fork after the head closed', () => {
    const f = fakeHost()
    f.places.set(T1, PLACE)
    f.infos.set(T9, tabInfo(T9, { fork: { of: T1, from: null } }))
    let entries = hostTabs(f.ctx).list()
    expect(entries.find((t) => t.id === T1)).toMatchObject({ place: PLACE, forkOf: null, fork: false })
    expect(entries.find((t) => t.id === T9)).toMatchObject({ place: null, forkOf: T1, fork: true })
    expectReceived(f)
    f.infos.set(T9, tabInfo(T9, { fork: { of: null, from: null } }))
    entries = hostTabs(f.ctx).list()
    expect(entries.find((t) => t.id === T9)).toMatchObject({ forkOf: null, fork: true })
    expectReceived(f)
  })

  it('a repository directly under a root keeps its place: an empty parent is a place, as TabPlaces gives it', () => {
    const f = fakeHost()
    const place: TabPlace = { project: { key: 'c:\\acme', name: 'acme', parent: '' }, worktree: null, branch: 'main' }
    f.places.set(T1, place)
    expect(hostTabs(f.ctx).list().find((t) => t.id === T1)?.place).toEqual(place)
    expectReceived(f)
  })

  it('the entry carries the folder the tab works in, and says whether its device has published the place yet', () => {
    const f = fakeHost()
    f.infos.set(T2, tabInfo(T2, { kind: 'shell', profile: 'Bash', folder: '/work/other' }))
    let entries = hostTabs(f.ctx).list()
    expect(entries.find((t) => t.id === T2)).toMatchObject({ cwd: '/work/demo', folder: '/work/other', placeKnown: false, place: null })
    f.places.set(T2, null)
    entries = hostTabs(f.ctx).list()
    expect(entries.find((t) => t.id === T2)).toMatchObject({ placeKnown: true, place: null })
    expectReceived(f)
  })

  it('a folder too long to keep is the cwd of the tab, and the entry stays', () => {
    const f = fakeHost()
    f.infos.set(T2, tabInfo(T2, { kind: 'shell', profile: 'Bash', folder: 'f'.repeat(5000) }))
    const entry = hostTabs(f.ctx).list().find((t) => t.id === T2)
    expect(entry).toMatchObject({ id: T2, cwd: '/work/demo', folder: '/work/demo' })
    expectReceived(f)
  })

  it('an empty folder is the cwd of the tab, and the entry stays', () => {
    const f = fakeHost()
    f.infos.set(T2, tabInfo(T2, { kind: 'shell', profile: 'Bash', folder: '' }))
    const entry = hostTabs(f.ctx).list().find((t) => t.id === T2)
    expect(entry).toMatchObject({ id: T2, cwd: '/work/demo', folder: '/work/demo' })
    expectReceived(f)
  })

  it('a place whose project key is longer than MAX_PATH_TEXT is no place, and the tab stays', () => {
    const f = fakeHost()
    f.places.set(T1, { ...PLACE, project: { ...PLACE.project, key: 'k'.repeat(4097) } })
    const entry = hostTabs(f.ctx).list().find((t) => t.id === T1)
    expect(entry).toMatchObject({ id: T1, place: null })
    expectReceived(f)
  })
})

describe('the calls of this device', () => {
  it('can-fork answers what the tab manager says, and refuses a tab this device does not have', async () => {
    const f = fakeHost()
    expect(await run(f, 'can-fork', { id: T1 })).toEqual({ ok: true })
    f.canForkAnswer = false
    expect(await run(f, 'can-fork', { id: T1 })).toEqual({ ok: false })
    await expect(run(f, 'can-fork', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab)
  })

  it('fork-tab forks the tab on this device and answers the new id; a fork that gives nothing is refused with the window\'s sentence', async () => {
    const f = fakeHost()
    expect(await run(f, 'fork-tab', { id: T1 })).toEqual({ id: T3 })
    expect(f.forked).toEqual([T1])
    f.forkAnswer = false
    await expect(run(f, 'fork-tab', { id: T1 })).rejects.toThrow(REMOTE_COPY.forkFailed)
    await expect(run(f, 'fork-tab', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    expect(f.forked).toEqual([T1, T1])
  })

  it('fork-tab asks for the fork in the background on this device, and a fork that throws is refused with the window\'s sentence', async () => {
    const f = fakeHost()
    await run(f, 'fork-tab', { id: T1 })
    expect(f.forkOptions).toEqual([{ activate: false }])
    f.ctx.tabs.fork = async () => {
      throw new Error('the conversation file is gone')
    }
    await expect(run(f, 'fork-tab', { id: T1 })).rejects.toThrow(REMOTE_COPY.forkFailed)
  })

  it('open-tab opens in the default folder without bringing the tab to the front, and answers its id', async () => {
    const f = fakeHost()
    expect(await run(f, 'open-tab', { kind: 'shell', profile: 'Bash', account: null, resume: null })).toEqual({ id: T3 })
    expect(f.opened).toEqual([{ kind: 'shell', profile: 'Bash', account: null, resume: null }])
  })

  it('rename, mute, restart and switch-account reach the tab; profiles and accounts answer names and ids, never tokens', async () => {
    const f = fakeHost()
    const withToken = { ...f.accounts[0]!, token: 'tok-secret' }
    f.accounts = [withToken as AccountView]
    await run(f, 'rename', { id: T1, title: 'x' })
    expect(f.renamed).toEqual([[T1, 'x']])
    await run(f, 'mute', { id: T1, muted: true })
    expect(f.muted).toEqual([[T1, true]])
    await run(f, 'restart', { id: T1, live: true })
    expect(f.restarted).toEqual([[T1, true]])
    expect(await run(f, 'switch-account', { id: T1, account: ACC_WORK })).toEqual({ ok: true })
    expect(f.switched).toEqual([[T1, ACC_WORK]])
    expect(await run(f, 'profiles', {})).toEqual(['Bash', 'Zsh'])
    const accounts = await run(f, 'accounts', {})
    expect(accounts).toEqual([{ id: ACC_WORK, name: 'Work' }])
    expect(JSON.stringify(accounts)).not.toContain('tok-secret')
  })

  it('an open-tab that fails is refused with the window\'s sentence', async () => {
    const f = fakeHost()
    f.ctx.openTab = () => null
    await expect(run(f, 'open-tab', { kind: 'shell', profile: 'Bash', account: null, resume: null })).rejects.toThrow('The tab could not be opened')
  })

  it('accounts leave out the ones this device cannot read, and keep the rest', async () => {
    const f = fakeHost()
    f.accounts = [
      { id: 'acc-locked', name: 'Locked', addedAt: '2026-01-01T00:00:00.000Z', readable: false },
      { id: ACC_WORK, name: 'Work', addedAt: '2026-01-01T00:00:00.000Z', readable: true }
    ]
    expect(await run(f, 'accounts', {})).toEqual([{ id: ACC_WORK, name: 'Work' }])
  })

  it('clear-task-list clears the task list of a Claude tab, attached or not; a shell tab is refused and keeps its list', async () => {
    const f = fakeHost()
    expect(await run(f, 'clear-task-list', { id: T1 })).toEqual({ ok: true })
    expect(f.clearedLists).toEqual([T1])
    expect(await run(f, 'clear-task-list', { id: T2 })).toEqual({ ok: false })
    f.watchers.get(T1)!.delete(B_ID)
    expect(await run(f, 'clear-task-list', { id: T1 })).toEqual({ ok: true })
    expect(f.clearedLists).toEqual([T1, T1])
  })

  it.each([
    ['clear-task-list', (id: string) => ({ id })],
    ['close', (id: string) => ({ id })],
    ['restart', (id: string) => ({ id, live: true })],
    ['rename', (id: string) => ({ id, title: 'x' })],
    ['mute', (id: string) => ({ id, muted: true })],
    ['switch-account', (id: string) => ({ id, account: ACC_WORK })]
  ])('%s refuses a tab this device does not have, and arguments that do not fit', async (m, argsOf) => {
    const f = fakeHost()
    await expect(run(f, m, argsOf(T9))).rejects.toThrow(REMOTE_COPY.unknownTab)
    await expect(run(f, m, argsOf('not-an-id'))).rejects.toThrow('bad arguments')
    await expect(run(f, m, null)).rejects.toThrow('bad arguments')
    expect(f.closed).toEqual([])
    expect(f.renamed).toEqual([])
    expect(f.muted).toEqual([])
    expect(f.restarted).toEqual([])
    expect(f.switched).toEqual([])
  })

  it('close reaches the tab', async () => {
    const f = fakeHost()
    await run(f, 'close', { id: T2 })
    expect(f.closed).toEqual([T2])
  })
})

describe('the directory and the list replies fit the receiver (R1)', () => {
  it('a program title of 5000 characters arrives cut to 1000', () => {
    const f = fakeHost()
    f.titles.set(T1, 'x'.repeat(5000))
    expect(hostTabs(f.ctx).list()[0]!.title).toBe('x'.repeat(1000))
    expectReceived(f)
  })

  it('a title holding a NUL arrives without it, and so does any other control character', () => {
    const f = fakeHost()
    f.titles.set(T1, 'v\u0000i\u001bm')
    expect(hostTabs(f.ctx).list()[0]!.title).toBe('vim')
    expectReceived(f)
  })

  it('a cut never splits a surrogate pair', () => {
    const f = fakeHost()
    f.titles.set(T1, 'a'.repeat(999) + '😀')
    const title = hostTabs(f.ctx).list()[0]!.title!
    expect(title).toBe('a'.repeat(999))
    expectReceived(f)
  })

  it('a tab whose cwd is 5000 characters long is left out, and the others are kept', () => {
    const f = fakeHost()
    f.infos.set(T_LONG_CWD, tabInfo(T_LONG_CWD, { cwd: 'c'.repeat(5000) }))
    const ids = hostTabs(f.ctx).list().map((t) => t.id)
    expect(ids).toEqual([T1, T2])
    expectReceived(f)
  })

  it('a custom title and an account name are cut to 1000 and 256 characters, and a counter title to 1000', () => {
    const f = fakeHost()
    const longAccount = tabId(0x20)
    f.accounts.push({ id: 'acc-long', name: 'n'.repeat(300), addedAt: '2026-01-01T00:00:00.000Z', readable: true })
    f.infos.set(longAccount, tabInfo(longAccount, { customTitle: 'c'.repeat(3000), account: 'acc-long' }))
    f.reviews.set(T1, reviewUpdate(T1, { counter: { files: 1, additions: 0, deletions: 0, title: 't'.repeat(5000) } }))
    const entries = hostTabs(f.ctx).list()
    const long = entries.find((t) => t.id === longAccount)!
    expect(long.customTitle).toHaveLength(1000)
    expect(long.accountName).toHaveLength(256)
    expect(entries.find((t) => t.id === T1)!.counter!.title).toHaveLength(1000)
    expectReceived(f)
  })

  it('profiles answer at most 64 names, and an empty or over-long name is left out', async () => {
    const f = fakeHost()
    f.profilesAnswer = ['', 'p'.repeat(300), ...Array.from({ length: 70 }, (_, i) => `profile ${i}`)]
    const answer = (await run(f, 'profiles', {})) as string[]
    expect(answer).toHaveLength(64)
    expect(answer[0]).toBe('profile 0')
  })

  it('accounts answer at most 64 entries, leave out an id over 64 characters and cut a name to 256', async () => {
    const f = fakeHost()
    f.accounts = [
      { id: 'x'.repeat(65), name: 'bad', addedAt: '2026-01-01T00:00:00.000Z', readable: true },
      { id: 'acc-long', name: 'n'.repeat(300), addedAt: '2026-01-01T00:00:00.000Z', readable: true },
      ...Array.from({ length: 70 }, (_, i) => ({ id: `acc-${i}`, name: `Account ${i}`, addedAt: '2026-01-01T00:00:00.000Z', readable: true }))
    ]
    const answer = (await run(f, 'accounts', {})) as { id: string; name: string }[]
    expect(answer).toHaveLength(64)
    expect(answer.some((a) => a.id === 'x'.repeat(65))).toBe(false)
    expect(answer[0]).toEqual({ id: 'acc-long', name: 'n'.repeat(256) })
  })
})

describe('clampPush (R5): every push fits the receiver', () => {
  /** the value parsePush accepts, cut or kept as clampPush makes it, and the cut data is the input's start */
  function fits(k: PushKind, v: unknown) {
    const out = parsePush(k, clampPush(k, v), T1)
    expect(out).not.toBeNull()
    return (out as { v: unknown }).v as any
  }

  it('status: strings cut to 200 characters, at most 64 agents', () => {
    const agent = (i: number) => ({ agentId: `a${i}`, type: 'Explore', description: 'd'.repeat(300), model: null, effort: null, startedAt: i })
    const background = (i: number) => ({ id: `b${i}`, type: 'shell', description: 'd'.repeat(300), command: 'c'.repeat(300) })
    const v = {
      main: { model: { id: 'm'.repeat(5000), displayName: 'd'.repeat(5000) }, effort: 'e'.repeat(300), context: null, fiveHour: null, sevenDay: null },
      agents: Array.from({ length: 70 }, (_, i) => agent(i)),
      background: Array.from({ length: 70 }, (_, i) => background(i))
    }
    const out = fits('status', v)
    expect(out.main.model.displayName).toBe('d'.repeat(200))
    expect(out.main.effort).toHaveLength(200)
    expect(out.agents).toHaveLength(64)
    expect(out.agents[0].description).toHaveLength(200)
    expect(out.agents[0].agentId).toBe('a0')
    expect(out.background).toHaveLength(64)
    expect(out.background[0].command).toHaveLength(200)
  })

  it('plan: the title and the task titles cut to 500, at most 500 tasks, a task with no safe number dropped, the counts recounted', () => {
    const tasks: PlanTask[] = Array.from({ length: 600 }, (_, i) => ({ n: i + 1, title: 't'.repeat(600), state: i < 300 ? 'done' : 'left' }))
    tasks[5] = { n: Number.NaN, title: 'bad', state: 'done' }
    const v: PlanStatus = { title: 'p'.repeat(600), tasks, done: 300, total: 600, finished: false }
    const out = fits('plan', v)
    expect(out.title).toHaveLength(500)
    expect(out.tasks).toHaveLength(500)
    expect(out.tasks[0].title).toHaveLength(500)
    expect(out.tasks.every((t: PlanTask) => Number.isSafeInteger(t.n))).toBe(true)
    expect(out.total).toBe(500)
    expect(out.done).toBe(out.tasks.filter((t: PlanTask) => t.state === 'done').length)
    // the kept tasks are the first ones: the bad task 5 (0-based) is left out, so the 7th task takes its place
    expect(out.tasks[0].n).toBe(1)
    expect(out.tasks[5].n).toBe(7)
  })

  it('a NUL is stripped from a card path, a plan task title and a status string', async () => {
    const f = fakeHost()
    f.cards = [imageCard(1, { path: '/work/\u0000demo/img.png' })]
    f.plans.set(T1, { title: 'Plan', tasks: [{ n: 1, title: 'a\u0000b', state: 'left' }], done: 0, total: 1, finished: false })
    f.ctx.status = { get: (id: string) => ({ tabId: id, main: mainStatus('Opus\u0000 4.1', 41.6), agents: [], background: [] }) } as never
    const pushes = await hostTabs(f.ctx).pushes(T1)
    const at = (k: PushKind) => pushes.find((p) => p.k === k)!.v as any
    expect(at('images').cards[0].path).toBe('/work/demo/img.png')
    expect(at('plan').tasks[0].title).toBe('ab')
    expect(at('status').main.model.displayName).toBe('Opus 4.1')
  })

  it('status: the agents are clamped even when the status has no background tasks', () => {
    const agent = (i: number) => ({ agentId: `a${i}`, type: 'Explore', description: 'd', model: null, effort: null, startedAt: i })
    const out = clampPush('status', { main: null, agents: Array.from({ length: 70 }, (_, i) => agent(i)) }) as { agents: unknown[] }
    expect(out.agents).toHaveLength(64)
  })

  it('plan: null stays null (the plan is over), and the list flag is kept as it is, a value that is not a boolean included', () => {
    expect(clampPush('plan', null)).toBeNull()
    const plan = { title: 'Ship', tasks: [{ n: 1, title: 'Notes', state: 'done' }], done: 1, total: 1, finished: true }
    expect(parsePush('plan', clampPush('plan', { ...plan, agentList: true }), T1)).toEqual({ k: 'plan', v: { ...plan, tasks: [{ n: 1, title: 'Notes', state: 'done' }] }, agentList: true })
    expect(parsePush('plan', clampPush('plan', { ...plan, agentList: 'yes' }), T1)).toBeNull()
  })

  it('images: at most 10000 cards, a card whose path is over 4096 characters dropped, captions cut to 1000, the notice to 500', () => {
    const cards = Array.from({ length: 10_002 }, (_, i) => imageCard(i))
    cards[0] = imageCard(0, { path: '/' + 'p'.repeat(5000) })
    cards[2] = imageCard(2, { caption: 'c'.repeat(1500) })
    const out = fits('images', { cards, unseen: 3, notice: 'n'.repeat(800) })
    expect(out.cards).toHaveLength(10_000)
    expect(out.cards[0].id).toBe(imageCard(1).id)
    expect(out.cards[1].caption).toHaveLength(1000)
    expect(out.notice).toHaveLength(500)
    expect(out.unseen).toBe(3)
  })

  it('images: a card whose relPath is over 4096 characters is dropped', () => {
    const cards = [imageCard(1, { relPath: 'r'.repeat(5000) }), imageCard(2)]
    const out = fits('images', { cards, unseen: 0, notice: null })
    expect(out.cards.map((c: { id: string }) => c.id)).toEqual([imageCard(2).id])
  })

  it('review: files, hunks, lines, labels, paths, hashes, samples, notes and reasons cut or capped to the receiver limits', () => {
    const longLine = { kind: 'add', text: 'a'.repeat(99_999) + '😀', oldNo: null, newNo: 2 }
    const file = (over: Record<string, unknown> = {}) => ({
      path: 'src/a.ts', relPath: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, hunks: [], note: null,
      canForce: false, hash: 'abc', viewed: false, markdown: false, lineCount: 0, ...over
    })
    // a file of 100,001 lines is over REVIEW_FILE_BYTES: it keeps its header only, with the note too-many
    const plainLine = { kind: 'context', text: 'x', oldNo: 1, newNo: 1 }
    const huge = file({ hunks: [{ header: 'h', lines: Array.from({ length: 100_001 }, () => plainLine) }], hash: 'h'.repeat(200), path: 'p'.repeat(5000) })
    // a small file keeps its hunks, their headers and lines, cut to the limits
    const hunks = Array.from({ length: 10_001 }, () => ({ header: '@@', lines: [] as unknown[] }))
    hunks[0] = { header: 'h'.repeat(5000), lines: [longLine] }
    const files = Array.from({ length: 5001 }, () => file())
    files[0] = huge
    files[1] = file({ hunks })
    const v = reviewUpdate(T1, {
      label: 'L'.repeat(5000),
      folder: 'F'.repeat(5000),
      files: files as never,
      testsSample: Array.from({ length: 15 }, (_, i) => `test ${i}`),
      outsideSample: Array.from({ length: 12 }, (_, i) => `out ${i}`),
      notice: 'n'.repeat(5000),
      uncommitted: { available: false, reason: 'u'.repeat(5000) },
      send: { ok: false, reason: 'r'.repeat(900) },
      counter: { files: 1, additions: 1, deletions: 0, title: 't'.repeat(3000) }
    })
    const out = fits('review', withoutTab(v))
    expect(out.label).toHaveLength(4096)
    expect(out.folder).toHaveLength(4096)
    expect(out.notice).toHaveLength(4096)
    expect(out.uncommitted.reason).toHaveLength(4096)
    expect(out.send.reason).toHaveLength(500)
    expect(out.counter.title).toHaveLength(1000)
    expect(out.testsSample).toHaveLength(10)
    expect(out.outsideSample).toHaveLength(10)
    expect(out.files).toHaveLength(5000)
    expect(out.files[0]).toMatchObject({ hunks: [], note: 'too-many' })
    expect(out.files[0].path).toHaveLength(4096)
    expect(out.files[0].hash).toHaveLength(128)
    expect(out.files[1].hunks).toHaveLength(10_000)
    expect(out.files[1].hunks[0].header).toHaveLength(4096)
    expect(out.files[1].hunks[0].lines).toHaveLength(1)
    // the long line is cut before its surrogate pair, so no half of it is left
    const text: string = out.files[1].hunks[0].lines[0].text
    expect(text).toBe('a'.repeat(99_999))
  })

  // Task 9 minor 11: the whole push stays under a frame, not only each field
  it('review: 40 files of 512 KiB each arrive whole in the first files, and the rest keep only their header, within a frame', () => {
    const line = { kind: 'add', text: 'x'.repeat(1024), oldNo: null, newNo: 1 }
    const file = (i: number) => ({
      path: `src/big-${i}.ts`,
      relPath: `src/big-${i}.ts`,
      status: 'modified',
      additions: 512,
      deletions: 0,
      hunks: [{ header: '@@ -1 +1 @@', lines: Array.from({ length: 512 }, () => line) }],
      note: null,
      canForce: false,
      hash: `h${i}`,
      viewed: false,
      markdown: false,
      lineCount: 512
    })
    const files = Array.from({ length: 40 }, (_, i) => file(i))
    const out = clampPush('review', withoutTab(reviewUpdate(T1, { files: files as never }))) as { files: any[] }
    expect(parsePush('review', out, T1)).not.toBeNull()
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(MAX_FRAME_BYTES)
    expect(out.files).toHaveLength(40)
    expect(out.files[0].hunks).toHaveLength(1)
    expect(out.files[0].hunks[0].lines).toHaveLength(512)
    const last = out.files[39]
    expect(last.path).toBe('src/big-39.ts')
    expect(last.hunks).toEqual([])
    expect(last.note).toBe('too-many')
  })

  it('review: a NUL in a label is stripped', () => {
    const v = reviewUpdate(T1, { label: 'a\u0000b' })
    expect(fits('review', withoutTab(v)).label).toBe('ab')
  })

  it('a value that is not a push is passed on as it is, and parsePush refuses it', () => {
    expect(clampPush('status', 42)).toBe(42)
    expect(parsePush('status', clampPush('status', 42), T1)).toBeNull()
  })
})

describe('reviewPushes (Task 9): a large review travels in parts', () => {
  /** a stand-in for the turns of the event loop: counts the yields, and reports stale after `stopAfter` of them */
  function turns(stopAfter = Infinity) {
    let n = 0
    return { yieldNow: async () => void n++, stale: () => n > stopAfter, count: () => n }
  }
  const line = { kind: 'add', text: 'x'.repeat(1024), oldNo: null, newNo: 1 }
  const bigFile = (i: number, lines = 512) => ({
    path: `src/big-${i}.ts`,
    relPath: `src/big-${i}.ts`,
    status: 'modified',
    additions: lines,
    deletions: 0,
    hunks: [{ header: '@@ -1 +1 @@', lines: Array.from({ length: lines }, () => line) }],
    note: null,
    canForce: false,
    hash: `h${i}`,
    viewed: false,
    markdown: false,
    lineCount: lines
  })

  it('40 files of 512 KiB come as parts, each under REVIEW_PART_BYTES, in order, with the files the clamp keeps, and yield once per file', async () => {
    const v = withoutTab(reviewUpdate(T1, { files: Array.from({ length: 40 }, (_, i) => bigFile(i)) as never }))
    const t = turns()
    const pushes = await reviewPushes(v, 7, t)
    expect(pushes).not.toBeNull()
    expect(pushes!.length).toBeGreaterThan(1)
    expect(pushes!.every((p) => p.k === 'review-part')).toBe(true)
    const bodies = pushes!.map((p) => p.v as { rev: number; i: number; of: number; head?: unknown; files: unknown[] })
    bodies.forEach((b, i) => {
      expect(b).toMatchObject({ rev: 7, i, of: bodies.length })
      expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(REVIEW_PART_BYTES)
      expect(i === 0 ? b.head !== undefined : b.head === undefined).toBe(true)
    })
    const clamped = clampPush('review', v) as { files: unknown[] } & Record<string, unknown>
    expect(bodies.flatMap((b) => b.files)).toEqual(clamped.files)
    const head: Record<string, unknown> = { ...clamped }
    delete head.files
    expect(bodies[0].head).toEqual(head)
    expect(t.count()).toBeGreaterThanOrEqual(40)
  })

  it('a small review is one review push, and it carries the rev', async () => {
    const v = withoutTab(reviewUpdate(T1, { files: [bigFile(0, 2)] as never }))
    const pushes = await reviewPushes(v, 7, turns())
    expect(pushes).toEqual([{ k: 'review', v: { ...(clampPush('review', v) as Record<string, unknown>), rev: 7 } }])
    expect(parsePush('review', pushes![0].v, T1)).not.toBeNull()
  })

  it('stale() turning true mid-way gives null: nothing is sent for a review a newer one replaced', async () => {
    const v = withoutTab(reviewUpdate(T1, { files: Array.from({ length: 40 }, (_, i) => bigFile(i)) as never }))
    expect(await reviewPushes(v, 7, turns(5))).toBeNull()
  })

  it('a file over REVIEW_FILE_BYTES keeps its header with note too-many; a file under it is kept whole', async () => {
    const v = withoutTab(reviewUpdate(T1, { files: [bigFile(0, 2200), bigFile(1, 300)] as never }))
    const clamped = clampPush('review', v) as { files: any[] }
    expect(clamped.files[0]).toMatchObject({ path: 'src/big-0.ts', hunks: [], note: 'too-many' })
    expect(clamped.files[1].hunks[0].lines).toHaveLength(300)
    const pushes = await reviewPushes(v, 1, turns())
    const sent = pushes!.flatMap((p) => (p.v as { files: unknown[] }).files)
    expect(sent).toEqual(clamped.files)
  })
})

// Fix 2: a valid part of many short lines is accepted by the viewer, though the parts are packed near the part size
describe('the parts of a review of many short lines (Task 9 fix 2)', () => {
  it('every part of 1500 files of 60 short lines is accepted by parsePush', async () => {
    const line = { kind: 'add', text: 'x', oldNo: null, newNo: 1 }
    const file = (i: number) => ({
      path: `src/short-${i}.ts`,
      relPath: `src/short-${i}.ts`,
      status: 'modified',
      additions: 60,
      deletions: 0,
      hunks: [{ header: '@@ -1 +1 @@', lines: Array.from({ length: 60 }, () => line) }],
      note: null,
      canForce: false,
      hash: `h${i}`,
      viewed: false,
      markdown: false,
      lineCount: 60
    })
    const v = withoutTab(reviewUpdate(T1, { files: Array.from({ length: 1500 }, (_, i) => file(i)) as never }))
    const pushes = await reviewPushes(v, 4, { yieldNow: async () => {}, stale: () => false })
    expect(pushes!.length).toBeGreaterThan(1)
    for (const p of pushes!) {
      expect(Buffer.byteLength(JSON.stringify(p.v))).toBeLessThanOrEqual(REVIEW_PART_BYTES)
      expect(parsePush(p.k, p.v, T1)).not.toBeNull()
    }
  })
})

describe('packFiles (Task 9 fix 8): a review has at most MAX_REVIEW_PARTS parts', () => {
  it('files just over half a part each never make more parts than MAX_REVIEW_PARTS; the files past the cap keep their headers', () => {
    const half = REVIEW_PART_BYTES / 2 + 1
    const kept = Array.from({ length: 20 }, (_, i) => {
      // the size is in the lines, so that a header of the file is small
      const file = { path: `p${i}`, relPath: `p${i}`, hunks: [{ header: 'h', lines: [{ text: 'x'.repeat(half) }] }], note: null }
      return { file, bytes: Buffer.byteLength(JSON.stringify(file)) }
    })
    const groups = packFiles({ label: 'head' }, kept)
    expect(groups.length).toBeLessThanOrEqual(MAX_REVIEW_PARTS)
    expect(groups.flat().map((f) => f.path)).toEqual(kept.map((k) => k.file.path))
    const last = groups[groups.length - 1]
    expect(last.slice(1).every((f) => f.note === 'too-many' && Array.isArray(f.hunks) && f.hunks.length === 0)).toBe(true)
    expect(groups[0][0].note).toBeNull()
  })
})

describe('the media of this device', () => {
  const CARD = imageCard(1).id
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  let dir: string
  let file: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-media-'))
    file = join(dir, 'shot.png')
    writeFileSync(file, bytes)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /** a host whose only card is CARD, of T1 unless `over` says, at the test file */
  function withCard(over: Parameters<typeof imageCard>[1] = {}) {
    const f = fakeHost()
    f.cards = [imageCard(1, { path: file, ...over })]
    return f
  }

  it('image answers the bytes of a card of that tab, with its version and size', async () => {
    const f = withCard()
    const reply = await run(f, 'image', { id: T1, card: CARD, offset: 0 })
    expect(reply).toEqual({ version: 1, size: bytes.length, data: bytes.toString('base64') })
    expect(CALL_REPLIES.image(reply)).toEqual(reply)
  })

  it('image answers from the offset, at most IMAGE_PART_BYTES of it', async () => {
    const f = withCard()
    expect(await run(f, 'image', { id: T1, card: CARD, offset: 4 })).toEqual({ version: 1, size: bytes.length, data: bytes.subarray(4).toString('base64') })
    expect(await run(f, 'image', { id: T1, card: CARD, offset: bytes.length })).toEqual({ version: 1, size: bytes.length, data: '' })
  })

  it('image refuses an offset past the end of the file with bad arguments', async () => {
    const f = withCard()
    await expect(run(f, 'image', { id: T1, card: CARD, offset: bytes.length + 1 })).rejects.toThrow('bad arguments')
  })

  it('image refuses a card of another tab, a media card, a card whose file is gone and a card it does not have', async () => {
    await expect(run(withCard({ tabId: T2 }), 'image', { id: T1, card: CARD, offset: 0 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    await expect(run(withCard({ kind: 'video' }), 'image', { id: T1, card: CARD, offset: 0 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    await expect(run(withCard({ path: join(dir, 'gone.png') }), 'image', { id: T1, card: CARD, offset: 0 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    await expect(run(withCard(), 'image', { id: T1, card: imageCard(9).id, offset: 0 })).rejects.toThrow(REMOTE_COPY.unknownTab)
  })

  it('image refuses a tab this device does not have, and arguments that do not fit', async () => {
    const f = withCard()
    await expect(run(f, 'image', { id: T9, card: CARD, offset: 0 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    await expect(run(f, 'image', { id: T1, card: 'not-a-card', offset: 0 })).rejects.toThrow('bad arguments')
    await expect(run(f, 'image', { id: T1, card: CARD, offset: -1 })).rejects.toThrow('bad arguments')
  })

  it('the image reply goes on the bulk lane', async () => {
    const f = withCard()
    const sent: { lane: 'send' | 'bulk'; m: { t: string; id?: number; ok?: boolean } }[] = []
    const link = Object.assign(new EventEmitter(), {
      send: (m: { t: string; id?: number; ok?: boolean }) => {
        sent.push({ lane: 'send', m })
        return true
      },
      sendBulk: (m: { t: string; id?: number; ok?: boolean }) => {
        sent.push({ lane: 'bulk', m })
        return true
      }
    })
    const calls = new Calls(link as unknown as CallLink, hostHandlers(f.ctx, B_ID))
    link.emit('message', { t: 'call', id: 7, m: 'image', a: { id: T1, card: CARD, offset: 0 } })
    await until(() => sent.length === 1)
    expect(sent[0]!.lane).toBe('bulk')
    expect(sent[0]!.m).toMatchObject({ t: 'reply', id: 7, ok: true })
    calls.close()
  })

  it('readImagePart reads at most max bytes from the offset and gives the size of the file', async () => {
    const part = await readImagePart(file, 4, 3)
    expect(part.size).toBe(bytes.length)
    expect(part.data.equals(bytes.subarray(4, 7))).toBe(true)
    expect((await readImagePart(file, bytes.length, 3)).data.length).toBe(0)
    await expect(readImagePart(file, bytes.length + 1, 3)).rejects.toThrow(CallError)
  })

  it('image answers one part of at most IMAGE_PART_BYTES of a bigger file, and the size of the whole', async () => {
    const big = join(dir, 'big.png')
    writeFileSync(big, Buffer.alloc(IMAGE_PART_BYTES + 5, 7))
    const reply = (await run(withCard({ path: big }), 'image', { id: T1, card: CARD, offset: 0 })) as { size: number; data: string }
    expect(reply.size).toBe(IMAGE_PART_BYTES + 5)
    expect(Buffer.from(reply.data, 'base64').length).toBe(IMAGE_PART_BYTES)
    expect(CALL_REPLIES.image(reply)).not.toBeNull()
  })

  it('a file over MAX_IMAGE_BYTES is refused: the image handler with unknownTab (the card fails checkImageFile), readImagePart with bad arguments', async () => {
    const huge = join(dir, 'huge.png')
    writeFileSync(huge, '')
    truncateSync(huge, MAX_IMAGE_BYTES + 1)
    await expect(run(withCard({ path: huge }), 'image', { id: T1, card: CARD, offset: 0 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    await expect(readImagePart(huge, 0, 10)).rejects.toThrow('bad arguments')
  })

  it('images-seen marks the tab seen; a tab this device does not have is refused', async () => {
    const f = withCard()
    await run(f, 'images-seen', { id: T1 })
    expect(f.marked).toEqual([T1])
    await expect(run(f, 'images-seen', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab)
    expect(f.marked).toEqual([T1])
  })

  it('image-remove removes the card of that tab, and a card of another tab is left alone', async () => {
    const f = withCard({ tabId: T2 })
    await run(f, 'image-remove', { id: T1, card: CARD })
    expect(f.removedCards).toEqual([])
    expect(f.cards).toHaveLength(1)
    await run(f, 'image-remove', { id: T2, card: CARD })
    expect(f.removedCards).toEqual([CARD])
    expect(f.cards).toEqual([])
  })
})

/** a session of this device as its history lists it */
function sessionOf(id: string, over: Partial<RecentSession> = {}): RecentSession {
  return { id, cwd: '/work/demo', title: 'Fix the login bug', firstPrompt: 'why does login fail', lastPrompt: 'why does login fail', modifiedAt: 1_000, open: false, starred: false, ...over }
}
const S1 = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const S2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const S3 = '6e3d2c8b-9f50-4b4c-a2d3-e4f5a6b7c8d9'

describe('the Recent sessions of this device (R1, R2, R9)', () => {
  it('sessions answer this device\'s sessions; a session the receiver would refuse is left out, and the others are kept (R1)', async () => {
    const f = fakeHost()
    f.sessionList = [sessionOf(S1, { firstPrompt: 'p'.repeat(5000) }), sessionOf(S2, { cwd: 'c'.repeat(5000) }), sessionOf(S3)]
    const list = (await hostHandlers(f.ctx, B_ID).sessions!.run({})) as RecentSession[]
    expect(list.map((s) => s.id)).toEqual([S1, S3])
    expect(list[0]!.firstPrompt).toBe('p'.repeat(2000))
    expect(CALL_REPLIES.sessions(list)).toEqual(list)
  })

  it('a title or prompt of 5000 characters is cut to 2000 without splitting a surrogate pair, and a NUL is stripped', async () => {
    const f = fakeHost()
    f.sessionList = [sessionOf(S1, { title: 'a'.repeat(1999) + '😀', lastPrompt: 'b\u0000'.repeat(3) })]
    const [s] = (await hostHandlers(f.ctx, B_ID).sessions!.run({})) as RecentSession[]
    expect(s!.title).toBe('a'.repeat(1999))
    expect(s!.lastPrompt).toBe('bbb')
    expect(CALL_REPLIES.sessions([s])).toEqual([s])
  })

  it('a session whose cwd or id holds a NUL is left out, the others are kept (R9)', async () => {
    const f = fakeHost()
    f.sessionList = [sessionOf(S1, { cwd: '/work/\u0000demo' }), sessionOf(S2), sessionOf('\u0000' + S3)]
    const list = (await hostHandlers(f.ctx, B_ID).sessions!.run({})) as RecentSession[]
    expect(list.map((s) => s.id)).toEqual([S2])
  })

  it('open-session opens a session of the last answer, and refuses one that answer did not list (R2)', async () => {
    const f = fakeHost()
    const h = hostHandlers(f.ctx, B_ID)
    f.sessionList = [sessionOf(S1), sessionOf(S2)]
    await h.sessions!.run({})
    expect(await h['open-session']!.run({ session: S1 })).toEqual({ id: T3 })
    expect(f.openedSessions).toEqual([S1])
    expect(() => h['open-session']!.run({ session: S3 })).toThrow(REMOTE_COPY.unknownSession)
    // a later answer that no longer lists S2 refuses it
    f.sessionList = [sessionOf(S1)]
    await h.sessions!.run({})
    expect(() => h['open-session']!.run({ session: S2 })).toThrow(REMOTE_COPY.unknownSession)
    expect(f.openedSessions).toEqual([S1])
  })

  it('open-session without a session that fits its arguments is refused with bad arguments', async () => {
    const f = fakeHost()
    await expect(run(f, 'open-session', { session: 'not-a-uuid' })).rejects.toThrow('bad arguments')
  })

  it('a sessions reply with one bad entry among good ones keeps the good ones; a list over 1000 or not a list is refused (R9)', () => {
    const good = sessionOf(S1)
    const bad = { ...sessionOf(S2), cwd: '' }
    expect(CALL_REPLIES.sessions([good, bad, sessionOf(S3)])).toEqual([good, sessionOf(S3)])
    expect(CALL_REPLIES.sessions(Array.from({ length: 1001 }, () => good))).toBeNull()
    expect(CALL_REPLIES.sessions({ 0: good })).toBeNull()
  })

  it('the ids a member was answered with stay openable for that member on a new link, and not for another member (I3)', async () => {
    const f = fakeHost()
    f.sessionList = [sessionOf(S1)]
    await hostHandlers(f.ctx, B_ID).sessions!.run({})
    expect(hostHandlers(f.ctx, B_ID)['open-session']!.run({ session: S1 })).toEqual({ id: T3 })
    expect(() => hostHandlers(f.ctx, 'b2000000-0000-4000-8000-000000000002')['open-session']!.run({ session: S1 })).toThrow(REMOTE_COPY.unknownSession)
  })

  it('a device that leaves the group loses the sessions it was answered with; a member that stays keeps them', async () => {
    const C_ID = 'c2000000-0000-4000-8000-000000000003'
    const f = fakeHost()
    f.sessionList = [sessionOf(S1)]
    await hostHandlers(f.ctx, B_ID).sessions!.run({})
    await hostHandlers(f.ctx, C_ID).sessions!.run({})
    pruneListedMembers(f.ctx, [B_ID])
    expect(hostHandlers(f.ctx, B_ID)['open-session']!.run({ session: S1 })).toEqual({ id: T3 })
    expect(() => hostHandlers(f.ctx, C_ID)['open-session']!.run({ session: S1 })).toThrow(REMOTE_COPY.unknownSession)
  })
})

describe('clampPush of a chat snapshot (chat mode): the push fits the member', () => {
  const STATE = { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false }

  it('a 5 000-item conversation is cut to the newest items under 2 MiB, and the member accepts the cut snapshot', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ kind: 'notice', id: `n${i}`, tone: 'info', text: 'x'.repeat(400), action: null }))
    const v = clampPush('chat', { tabId: T1, rev: 4, items, hasOlder: false, state: STATE }) as { items: unknown[]; hasOlder: boolean }
    expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(v.hasOlder).toBe(true)
    expect(v.items.at(-1)).toEqual(items[4999])
    expect(parseChatPush(v)).not.toBeNull()
  })

  it('a snapshot that fits is kept whole', () => {
    const v = { tabId: T1, rev: 1, items: [], hasOlder: false, state: STATE }
    expect(clampPush('chat', v)).toEqual(v)
  })
})
