import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIMIT_ERROR } from '../../src/main/auto-continue'
import { HUB_TEXT, START_WAIT_MS, worktreeInstruction, type HubTab } from '../../src/main/coordinator/coordinator-hub'
import { CoordinatorStore, MAX_ATTACHMENTS, MAX_COORDINATORS, MAX_HOSTED, MAX_TASKS_PER_SESSION, type StoredAttachment } from '../../src/main/coordinator/coordinator-store'
import { refOf } from '../../src/main/mail/agent-directory'
import type { CoordOp } from '../../src/shared/coordinator'
import type { MailRecord } from '../../src/shared/mail'
import { ACME, BETA, NOW, S, TITLES, cleanWorlds, fire, records, tab, uid, world, type World } from '../fixtures/coordinator-world'

const SELF = 'd0000000-0000-4000-8000-0000000000dd'
const PROBLEM =
  'Coordinating sessions needs agent messages, which are turned off in ClaudeTerm on this device. Turn them on in Settings, Agent messages.'

afterEach(cleanWorlds)

/** changes a tab of the world (its session, its state) the way the window would show it */
const update = (w: World, tabId: string, over: Partial<HubTab>): void => {
  w.tabs = w.tabs.map((t) => (t.tabId === tabId ? { ...t, ...over } : t))
}

const attachment = (session: string, name = 'parser · Desktop'): StoredAttachment => ({
  device: null,
  session,
  name,
  attachedAt: NOW,
  resolved: false,
  failed: false,
  pending: null,
  lastReport: null
})

describe('roles', () => {
  it('make: a Claude tab with a session in a git project becomes the coordinator of its project, under its session id', () => {
    const w = world()
    expect(w.hub.make('tab-c', false)).toEqual({ ok: true, info: 'This tab is now the coordinator of acme.' })
    expect(w.store.coordinator(S.coord)).toEqual({ session: S.coord, project: ACME, since: NOW, attachments: [], former: [] })
    expect(w.hub.make('tab-c', false)).toEqual({ ok: true, info: 'This tab is already the coordinator of acme.' })
    expect(w.store.coordinators()).toHaveLength(1)
  })

  it('make: a tab without a session or without a project is refused with its reason', () => {
    const w = world()
    w.tabs.push(tab('tab-n', null, ACME), tab('tab-o', uid(0x7001), null))
    expect(w.hub.make('tab-n', false)).toEqual({ ok: false, error: 'Only a Claude tab with a session can coordinate.' })
    expect(w.hub.make('tab-o', false)).toEqual({ ok: false, error: 'Only a tab in a git project can coordinate.' })
    expect(w.store.coordinators()).toEqual([])
  })

  it("make: a second tab of the project is refused with the first one's name until it replaces it; its sessions and their tasks move", () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    expect(w.hub.make('tab-2', false)).toEqual({ ok: false, error: 'The acme project already has a coordinator: coord · Desktop.', replaces: 'coord · Desktop' })
    expect(w.hub.make('tab-2', true)).toEqual({ ok: true, info: 'This tab is now the coordinator of acme; 1 session moved from coord · Desktop.' })
    expect(w.store.coordinator(S.coord)).toBeNull()
    expect(w.store.coordinator(S.two)!.attachments.map((a) => a.session)).toEqual([S.one])
    expect(w.store.hosted(S.one)).toMatchObject({
      coordinator: { device: null, session: S.two, name: 'docs · Desktop' },
      tasks: [{ state: 'queued', from: { session: S.coord } }]
    })
    expect(records(w, 'attach').map((r) => [r.from.session, r.to.session])).toEqual([
      [S.coord, S.one],
      [S.two, S.one]
    ])
  })

  it('make: an attached session that becomes a coordinator is detached first, and its open task is dropped', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'be0000')
    w.hub.message('tab-c', 'be0000', 'Sync the docs.')
    expect(w.hub.make('tab-b', false)).toEqual({ ok: true, info: 'This tab is now the coordinator of beta.' })
    expect(w.store.hosted(S.beta)).toBeNull()
    expect(w.store.coordinator(S.coord)!.attachments).toEqual([])
    expect(w.store.coordinator(S.beta)).toEqual({ session: S.beta, project: BETA, since: NOW, attachments: [], former: [] })
    expect(records(w, 'detach').map((r) => [r.from.session, r.to.session])).toEqual([[S.coord, S.beta]])
    expect(records(w, 'task')[0]).toMatchObject({ delivered: true, read: true })
  })

  it('stop detaches every session, drops their tasks and writes a detach record each; the tab is no longer a coordinator', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.attach('tab-c', 'b20000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    expect(w.hub.stop('tab-c')).toEqual({ ok: true, info: 'Stopped coordinating acme; 2 sessions detached.' })
    expect(w.store.coordinator(S.coord)).toBeNull()
    expect(w.store.hosted(S.one)).toBeNull()
    expect(w.store.hosted(S.two)).toBeNull()
    expect(records(w, 'detach').map((r) => r.to.session)).toEqual([S.one, S.two])
    expect(records(w, 'task')[0]).toMatchObject({ delivered: true, read: true })
    expect(w.hub.list('tab-c')).toEqual({ ok: false, error: HUB_TEXT.notCoordinator })
    expect(w.hub.stop('tab-c')).toEqual({ ok: false, error: HUB_TEXT.notCoordinator })
  })

  it("tabClosed of the coordinator's tab stops it", () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.tabClosed('tab-c')
    expect(w.store.coordinator(S.coord)).toBeNull()
    expect(w.store.hosted(S.one)).toBeNull()
    expect(w.hub.isCoordinator('tab-c')).toBe(false)
  })

  it('a new session id from clear, compact or resume moves the role, the attachments and the hosted entry; startup does not', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const NEW = uid(0x2001)
    update(w, 'tab-c', { session: NEW })
    w.hub.sessionStarted('tab-c', S.coord, NEW, 'clear')
    expect(w.store.coordinator(S.coord)).toBeNull()
    expect(w.store.coordinator(NEW)).toMatchObject({ session: NEW, attachments: [{ session: S.one }] })
    expect(w.store.hosted(S.one)).toMatchObject({ coordinator: { session: NEW }, tasks: [{ from: { session: NEW } }] })
    expect(w.aliases).toEqual([[S.coord, NEW]])

    const NEXT = uid(0x2002)
    update(w, 'tab-c', { session: NEXT })
    w.hub.sessionStarted('tab-c', NEW, NEXT, 'compact')
    expect(w.store.coordinator(NEXT)).toMatchObject({ session: NEXT, attachments: [{ session: S.one }] })
    expect(w.aliases).toEqual([
      [S.coord, NEW],
      [NEW, NEXT]
    ])

    const RESUMED = uid(0x2003)
    update(w, 'tab-c', { session: RESUMED })
    w.hub.sessionStarted('tab-c', NEXT, RESUMED, 'resume')
    expect(w.store.coordinator(RESUMED)).toMatchObject({ session: RESUMED, attachments: [{ session: S.one }] })
    expect(w.aliases).toEqual([
      [S.coord, NEW],
      [NEW, NEXT],
      [NEXT, RESUMED]
    ])

    w.hub.sessionStarted('tab-1', S.one, S.one, 'startup')
    w.hub.sessionStarted('tab-c', RESUMED, RESUMED, 'startup')
    expect(w.store.coordinator(RESUMED)).not.toBeNull()
    expect(w.aliases).toHaveLength(3)
  })

  it("the chat view's new id that came before the hook still moves them: the hook's before is the new id", () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    const NEW = uid(0x2001)
    update(w, 'tab-c', { session: NEW })
    w.hub.tabSession('tab-c', NEW)
    w.hub.sessionStarted('tab-c', NEW, NEW, 'clear')
    expect(w.store.coordinator(NEW)).not.toBeNull()
    expect(w.store.coordinator(S.coord)).toBeNull()
    expect(w.store.coordinator(NEW)!.attachments.map((a) => a.session)).toEqual([S.one])
    expect(w.store.hosted(S.one)!.coordinator.session).toBe(NEW)
    expect(w.aliases).toEqual([[S.coord, NEW]])

    const before = JSON.stringify([w.store.coordinators(), w.store.allHosted()])
    w.hub.sessionStarted('tab-c', NEW, NEW, 'clear')
    expect(JSON.stringify([w.store.coordinators(), w.store.allHosted()])).toBe(before)
    expect(w.aliases).toEqual([[S.coord, NEW]])
  })

  it('stores addresses of this device as null: hosted entries and tasks keep null devices, and follow the renames', () => {
    const w = world({ self: SELF })
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const [task] = records(w, 'task')
    expect(task).toMatchObject({ from: { device: SELF, session: S.coord }, to: { device: SELF, session: S.one } })
    expect(w.store.hosted(S.one)).toMatchObject({ coordinator: { device: null, session: S.coord }, tasks: [{ from: { device: null, session: S.coord } }] })

    const NEW1 = uid(0x2001)
    const NEW2 = uid(0x2002)
    update(w, 'tab-c', { session: NEW1 })
    w.hub.sessionStarted('tab-c', S.coord, NEW1, 'clear')
    update(w, 'tab-1', { session: NEW2 })
    w.hub.sessionStarted('tab-1', S.one, NEW2, 'clear')
    expect(w.store.hosted(NEW2)).toEqual({
      session: NEW2,
      coordinator: { device: null, session: NEW1, name: 'coord · Desktop' },
      project: 'acme',
      former: [S.one],
      tasks: [{ id: task.id, from: { device: null, session: NEW1, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW, deliveredAt: null }]
    })
    expect(w.store.coordinator(NEW1)!.attachments.map((a) => a.session)).toEqual([NEW2])
  })
})

describe('attach and detach', () => {
  it('attach by ref or name attaches a session of this or another project; only an attach record is written', () => {
    const w = world()
    w.hub.make('tab-c', false)
    expect(w.hub.attach('tab-c', '[a10000]')).toEqual({
      ok: true,
      info: 'Attached parser · Desktop [a10000]. It is not told and goes on as it is; give it a task with message_session.'
    })
    expect(w.hub.attach('tab-c', 'beta · Desktop')).toEqual({
      ok: true,
      info: 'Attached beta · Desktop [be0000]. It is not told and goes on as it is; give it a task with message_session.'
    })
    expect(w.store.coordinator(S.coord)!.attachments.map((a) => a.session)).toEqual([S.one, S.beta])
    expect(w.store.hosted(S.beta)).toEqual({ session: S.beta, coordinator: { device: null, session: S.coord, name: 'coord · Desktop' }, project: 'acme', tasks: [], former: [] })
    expect(w.mail.all().map((r) => [r.kind, r.delivered, r.read])).toEqual([
      ['attach', true, true],
      ['attach', true, true]
    ])
    expect(records(w, 'attach')[0]).toMatchObject({ text: 'Attached to the acme coordinator.', project: 'acme', from: { session: S.coord }, to: { session: S.one } })
    expect(w.hub.marks()['tab-1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId: 'tab-c' })
    expect(w.hub.marks()['tab-c']).toEqual({ role: 'coordinator', project: 'acme', sessions: 2, waiting: 0 })
  })

  it('attach refuses the coordinator itself, a coordinator, and a session attached elsewhere naming its coordinator', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.make('tab-b', false)
    w.hub.attach('tab-c', 'a10000')
    expect(w.hub.attach('tab-c', '[c00000]')).toEqual({ ok: false, error: 'A coordinator cannot attach itself.' })
    expect(w.hub.attach('tab-c', 'beta · Desktop')).toEqual({ ok: false, error: 'beta · Desktop is a coordinator itself.' })
    expect(w.hub.attach('tab-b', 'parser · Desktop')).toEqual({
      ok: false,
      error: 'parser · Desktop is attached to the acme coordinator (coord · Desktop); it must be detached there first.'
    })
    expect(w.hub.attach('tab-c', 'a10000')).toEqual({ ok: true, info: 'parser · Desktop is already attached.' })
    expect(w.store.coordinator(S.coord)!.attachments).toHaveLength(1)
  })

  it('attach refuses a session when this coordinator has 200 sessions attached, and when the device has 500 attached sessions', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.store.putCoordinator({ session: S.coord, project: ACME, since: NOW, attachments: Array.from({ length: MAX_ATTACHMENTS }, (_, i) => attachment(uid(0x10000 + i))), former: [] })
    expect(w.hub.attach('tab-c', 'a10000')).toEqual({
      ok: false,
      error: 'This coordinator has 200 sessions attached already, the most it keeps; detach one first.'
    })

    const full = world()
    full.hub.make('tab-c', false)
    for (let i = 0; i < MAX_HOSTED; i++) {
      full.store.putHosted({ session: uid(0x10000 + i), coordinator: { device: null, session: uid(0x20000), name: 'other' }, project: 'other', tasks: [], former: [] })
    }
    expect(full.hub.attach('tab-c', 'a10000')).toEqual({
      ok: false,
      error: 'This device has 500 attached sessions already, the most it keeps; detach one first.'
    })
    expect(full.store.coordinator(S.coord)!.attachments).toEqual([])
  })

  it('attach and message are refused with the problem; list still answers and shows it', () => {
    const w = world({ problem: PROBLEM })
    w.hub.make('tab-c', false)
    expect(w.hub.attach('tab-c', 'a10000')).toEqual({ ok: false, error: PROBLEM })
    expect(w.hub.message('tab-c', 'a10000', 'Fix the parser.')).toEqual({ ok: false, error: PROBLEM })
    const list = w.hub.list('tab-c')
    expect(list.ok && list.info!.split('\n')[1]).toBe(PROBLEM)
  })

  it('attachTab attaches the session a tab of this device runs; a tab without a session is refused', () => {
    const w = world()
    w.hub.make('tab-c', false)
    expect(w.hub.attachTab('tab-c', 'tab-1')).toEqual({
      ok: true,
      info: 'Attached parser · Desktop [a10000]. It is not told and goes on as it is; give it a task with message_session.'
    })
    expect(w.store.hosted(S.one)).toMatchObject({ coordinator: { session: S.coord }, project: 'acme' })
    expect(w.hub.attachTab('tab-c', 'tab-missing')).toEqual({ ok: false, error: HUB_TEXT.notClaude })
  })

  it("detach drops the session's tasks without a report and writes a detach record", () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const [task] = records(w, 'task')
    expect(w.hub.detach('tab-c', 'a10000')).toEqual({ ok: true, info: 'Detached parser · Desktop; its open task was dropped.' })
    expect(w.store.hosted(S.one)).toBeNull()
    expect(w.store.coordinator(S.coord)!.attachments).toEqual([])
    expect(w.mail.get(task.id)).toMatchObject({ delivered: true, read: true })
    expect(records(w, 'detach').map((r) => [r.from.session, r.to.session, r.delivered, r.read])).toEqual([[S.coord, S.one, true, true]])
    expect(w.hub.detach('tab-c', 'a10000')).toEqual({ ok: false, error: 'No session "a10000" here; call list_sessions.' })
  })

  it('a record that cannot be written changes nothing: attach and message answer notSaved and log why', () => {
    const w = world({ newId: () => 'not-a-uuid' })
    w.hub.make('tab-c', false)
    expect(w.hub.attach('tab-c', 'a10000')).toEqual({ ok: false, error: HUB_TEXT.notSaved })
    expect(w.store.coordinator(S.coord)!.attachments).toEqual([])
    expect(w.store.hosted(S.one)).toBeNull()
    expect(w.warns).toHaveLength(1)

    const seeded = world({ newId: () => 'not-a-uuid' })
    seeded.store.putCoordinator({ session: S.coord, project: ACME, since: NOW, attachments: [attachment(S.one)], former: [] })
    seeded.store.putHosted({ session: S.one, coordinator: { device: null, session: S.coord, name: 'coord · Desktop' }, project: 'acme', tasks: [], former: [] })
    expect(seeded.hub.message('tab-c', 'a10000', 'Fix the parser.')).toEqual({ ok: false, error: HUB_TEXT.notSaved })
    expect(seeded.store.hosted(S.one)!.tasks).toEqual([])
    expect(seeded.mail.all()).toEqual([])
    expect(seeded.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ resolved: false, failed: false })
  })

  it('a project name in a record is one line and at most 200 units', () => {
    const w = world()
    const LONG = { key: 'd:\\work\\long', name: `a\nb${'c'.repeat(300)}` }
    const SHORT = `a b${'c'.repeat(197)}`
    w.tabs.push(tab('tab-l', uid(0x5001), LONG))
    w.hub.tabSession('tab-l', uid(0x5001))
    expect(w.hub.make('tab-l', false)).toEqual({ ok: true, info: `This tab is now the coordinator of ${SHORT}.` })
    expect(w.hub.attach('tab-l', 'a10000')).toMatchObject({ ok: true })
    expect(SHORT).toHaveLength(200)
    expect(records(w, 'attach')[0]).toMatchObject({ project: SHORT })
    expect(w.store.coordinator(uid(0x5001))!.project).toEqual({ key: LONG.key, name: SHORT })
  })

  it('make answers fullCoordinators when the device keeps its 50 coordinators already', () => {
    const coords = world()
    for (let i = 0; i < MAX_COORDINATORS; i++) {
      coords.store.putCoordinator({ session: uid(0x10000 + i), project: { key: `/p/${i}`, name: `p${i}` }, since: NOW, attachments: [], former: [] })
    }
    expect(coords.hub.make('tab-c', false)).toEqual({
      ok: false,
      error: 'This device has 50 coordinators already, the most it keeps; stop one first.'
    })
    expect(coords.store.coordinator(S.coord)).toBeNull()
  })
})

describe('tasks given', () => {
  it('message writes a task record from the coordinator to the session, which holds it as queued; resolved and failed are cleared', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.resolve('tab-c', 'a10000')
    expect(w.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ resolved: true, failed: false })
    expect(w.hub.message('tab-c', 'a10000', 'Fix the parser.')).toEqual({
      ok: true,
      info: "Task given to parser · Desktop [a10000]. It reaches the session when the session is idle, as the user's instruction through you; its report comes to you by itself when its turn on it ends."
    })
    const [t] = records(w, 'task')
    expect(t).toMatchObject({ from: { session: S.coord, name: 'coord · Desktop' }, to: { session: S.one }, text: 'Fix the parser.', project: 'acme', delivered: false })
    expect(w.store.hosted(S.one)!.tasks).toEqual([{ id: t.id, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW, deliveredAt: null }])
    expect(w.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ resolved: false, failed: false })
    expect(w.rechecks).toBeGreaterThan(0)
    expect(w.pokes).toEqual(['tab-1'])
  })

  it('message refuses an empty text, 7001 characters, a session not attached, and a 21st task', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    expect(w.hub.message('tab-c', 'a10000', '  ')).toEqual({ ok: false, error: 'A task needs a text.' })
    expect(w.hub.message('tab-c', 'a10000', 'x'.repeat(7001))).toEqual({ ok: false, error: 'A task is at most 7000 characters.' })
    expect(w.hub.message('tab-c', 'docs · Desktop', 'Fix it.')).toEqual({ ok: false, error: 'No session "docs · Desktop" here; call list_sessions.' })
    for (let i = 0; i < MAX_TASKS_PER_SESSION; i++) expect(w.hub.message('tab-c', 'a10000', `Task ${i}.`)).toMatchObject({ ok: true })
    expect(w.hub.message('tab-c', 'a10000', 'One more.')).toEqual({ ok: false, error: 'parser · Desktop holds 20 tasks already; wait for its reports.' })
    expect(records(w, 'task')).toHaveLength(MAX_TASKS_PER_SESSION)
    expect(w.store.hosted(S.one)!.tasks).toHaveLength(MAX_TASKS_PER_SESSION)
  })

  it("a task record from anyone but the session's coordinator is not taken", () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    const from = { device: null, session: S.two, name: 'docs · Desktop' }
    const to = { device: null, session: S.one, name: 'parser · Desktop' }
    w.mail.add({ v: 1, id: uid(0x3001), from, to, replyTo: null, text: 'Do it.', sentAt: NOW, delivered: false, read: false, kind: 'task', project: 'acme' })
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
    w.mail.add({ v: 1, id: uid(0x3002), from: { device: null, session: S.coord, name: 'coord · Desktop' }, to, replyTo: null, text: 'Do it.', sentAt: NOW, delivered: true, read: false, kind: 'task', project: 'acme' })
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
    w.mail.add({ v: 1, id: uid(0x3003), from: { device: null, session: S.coord, name: 'coord · Desktop' }, to: { device: null, session: S.two, name: 'docs · Desktop' }, replyTo: null, text: 'Do it.', sentAt: NOW, delivered: false, read: false, kind: 'task', project: 'acme' })
    expect(w.store.hosted(S.two)).toBeNull()
  })

  it('accepts a task only into an idle hand-over or a prompt, only the oldest queued one, and none while one is delivered or open', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    w.hub.message('tab-c', 'a10000', 'Then the docs.')
    const [first, second] = records(w, 'task')
    expect(w.hub.accepts(first, 'tab-1', 'idle')).toBe(true)
    expect(w.hub.accepts(first, 'tab-1', 'prompt')).toBe(true)
    expect(w.hub.accepts(first, 'tab-1', 'running')).toBe(false)
    expect(w.hub.accepts(first, 'tab-1', 'next')).toBe(false)
    expect(w.hub.accepts(second, 'tab-1', 'idle')).toBe(false)

    const h = w.store.hosted(S.one)!
    w.store.putHosted({ ...h, tasks: h.tasks.map((t) => (t.id === first.id ? { ...t, state: 'delivered' as const, deliveredAt: NOW } : t)) })
    expect(w.hub.accepts(second, 'tab-1', 'idle')).toBe(false)
    expect(w.hub.accepts(first, 'tab-1', 'idle')).toBe(false)
  })

  it('accepts a stopped report only into a running turn, and other reports and messages into any; a message into a prompt is refused', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    const report = (outcome: 'finished' | 'stopped'): MailRecord => ({
      v: 1,
      id: uid(0x4001),
      from: { device: null, session: S.one, name: 'parser · Desktop' },
      to: { device: null, session: S.coord, name: 'coord · Desktop' },
      replyTo: uid(0x3001),
      text: 'The task was stopped by the user.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'report',
      outcome,
      ...(outcome === 'stopped' ? { reason: 'Esc' } : {})
    })
    const stopped = report('stopped')
    expect(w.hub.accepts(stopped, 'tab-c', 'running')).toBe(true)
    expect(w.hub.accepts(stopped, 'tab-c', 'idle')).toBe(false)
    expect(w.hub.accepts(stopped, 'tab-c', 'prompt')).toBe(false)
    const finished = report('finished')
    expect(w.hub.accepts(finished, 'tab-c', 'idle')).toBe(true)
    expect(w.hub.accepts(finished, 'tab-c', 'prompt')).toBe(true)
    expect(w.hub.accepts(finished, 'tab-c', 'running')).toBe(true)

    const message: MailRecord = {
      v: 1,
      id: uid(0x4002),
      from: { device: null, session: S.coord, name: 'coord · Desktop' },
      to: { device: null, session: S.one, name: 'parser · Desktop' },
      replyTo: null,
      text: 'A note.',
      sentAt: NOW,
      delivered: false,
      read: false
    }
    expect(w.hub.accepts(message, 'tab-1', 'idle')).toBe(true)
    expect(w.hub.accepts(message, 'tab-1', 'prompt')).toBe(false)
    expect(w.hub.accepts({ ...message, kind: 'attach', project: 'acme' }, 'tab-1', 'idle')).toBe(false)
  })

  it('a report goes into a prompt only while its tab still coordinates; as mail it goes to any tab', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    const finished: MailRecord = {
      v: 1,
      id: uid(0x4003),
      from: { device: null, session: S.one, name: 'parser · Desktop' },
      to: { device: null, session: S.coord, name: 'coord · Desktop' },
      replyTo: uid(0x3001),
      text: 'Parser fixed.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'report',
      outcome: 'finished'
    }
    expect(w.hub.accepts(finished, 'tab-c', 'prompt')).toBe(true)
    expect(w.hub.stop('tab-c')).toMatchObject({ ok: true })
    expect(w.hub.accepts(finished, 'tab-c', 'prompt')).toBe(false)
    expect(w.hub.accepts(finished, 'tab-c', 'idle')).toBe(true)
  })

  it('message refuses a session whose hosted entry names another coordinator, and writes no task', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.make('tab-b', false)
    // the session is attached to the beta coordinator's entry, as well as to this coordinator's attachments
    w.store.putHosted({ ...w.store.hosted(S.one)!, coordinator: { device: null, session: S.beta, name: 'beta · Desktop' } })
    expect(w.hub.message('tab-c', 'a10000', 'Fix the parser.')).toEqual({ ok: false, error: HUB_TEXT.elsewhere('parser · Desktop', 'acme', 'beta · Desktop') })
    expect(records(w, 'task')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
  })

  it('a queued task whose mail record is gone is dropped with a warning, and the next queued task is accepted', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    w.hub.message('tab-c', 'a10000', 'Then the docs.')
    const [first, second] = records(w, 'task')
    // a queued task older than both, whose record the mail store does not hold: it would block the queue for ever
    const gone = uid(0x5001)
    const h = w.store.hosted(S.one)!
    w.store.putHosted({ ...h, tasks: [{ id: gone, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW - 1, deliveredAt: null }, ...h.tasks] })
    expect(w.mail.get(gone)).toBeUndefined()

    expect(w.hub.accepts(first, 'tab-1', 'idle')).toBe(true)
    expect(w.store.hosted(S.one)!.tasks.map((t) => t.id)).toEqual([first.id, second.id])
    expect(w.warns.some((m) => m.includes(gone))).toBe(true)
  })

  it('a queued task whose mail record is gone is not the view\'s task, and a new message is accepted', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    const gone = uid(0x5002)
    const h = w.store.hosted(S.one)!
    w.store.putHosted({ ...h, tasks: [{ id: gone, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW, deliveredAt: null }] })
    expect(w.hub.view('tab-c')!.sessions[0].task).toBeNull()
    expect(w.hub.message('tab-c', 'a10000', 'Fix the parser.')).toMatchObject({ ok: true })
    const [t] = records(w, 'task')
    expect(w.store.hosted(S.one)!.tasks.map((x) => x.id)).toEqual([t.id])
  })

  it('a queued task whose mail record is gone does not count toward the 20 tasks of a session', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    for (let i = 0; i < MAX_TASKS_PER_SESSION - 1; i++) expect(w.hub.message('tab-c', 'a10000', `Task ${i}.`)).toMatchObject({ ok: true })
    const gone = uid(0x5003)
    const h = w.store.hosted(S.one)!
    w.store.putHosted({ ...h, tasks: [{ id: gone, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW - 1, deliveredAt: null }, ...h.tasks] })
    expect(w.hub.message('tab-c', 'a10000', 'One more.')).toMatchObject({ ok: true })
    expect(w.store.hosted(S.one)!.tasks.some((t) => t.id === gone)).toBe(false)
    expect(records(w, 'task')).toHaveLength(MAX_TASKS_PER_SESSION)
  })

  it('a task is not handed over idle while the tab is in a turn; after the turn ends and settles it is', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const [t] = records(w, 'task')
    w.hub.turnStarted('tab-1')
    expect(w.hub.accepts(t, 'tab-1', 'idle')).toBe(false)
    w.hub.turnEnded('tab-1', { background: false, lastMessage: null })
    fire(w)
    expect(w.hub.accepts(t, 'tab-1', 'idle')).toBe(true)
  })

  it('a task is accepted by the tab that runs its session, and by no other tab', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const [t] = records(w, 'task')
    expect(w.hub.accepts(t, 'tab-1', 'prompt')).toBe(true)
    expect(w.hub.accepts(t, 'tab-2', 'idle')).toBe(false)
  })

  it('resolve marks an attached session resolved', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    expect(w.hub.resolve('tab-c', 'a10000')).toEqual({ ok: true, info: 'Marked parser · Desktop resolved.' })
    expect(w.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ resolved: true, failed: false })
    expect(w.hub.view('tab-c')!.sessions[0].group).toBe('resolved')
    expect(w.hub.resolve('tab-1', 'a10000')).toEqual({ ok: false, error: HUB_TEXT.notCoordinator })
  })
})

describe('views', () => {
  it('view lists the attached sessions with their group and line, and the project\'s other sessions as not attached', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    expect(w.hub.view('tab-1')).toBeNull()
    const v = w.hub.view('tab-c')!
    expect(v).toMatchObject({ tabId: 'tab-c', session: S.coord, project: ACME, problem: null, waiting: 0 })
    expect(v.sessions).toEqual([
      expect.objectContaining({
        key: `local:${S.one}`,
        tabId: 'tab-1',
        device: null,
        deviceName: null,
        session: S.one,
        ref: 'a10000',
        name: 'parser · Desktop',
        folder: 'D:\\Work\\acme',
        branch: 'main',
        group: 'idle',
        why: null,
        marker: null,
        line: 'Idle',
        task: null,
        lastReport: null,
        attachedTo: null
      })
    ])
    expect(v.notAttached.map((r) => [r.name, r.key, r.group, r.line, r.attachedTo])).toEqual([['docs · Desktop', `local:${S.two}`, 'idle', 'Idle', null]])
  })

  it('a project session attached to another coordinator is listed as not attached, with the coordinator it is attached to', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.make('tab-b', false)
    w.hub.attach('tab-b', 'a10000')
    expect(w.hub.view('tab-c')!.notAttached.map((r) => [r.name, r.attachedTo])).toEqual([
      ['parser · Desktop', 'beta · Desktop'],
      ['docs · Desktop', null]
    ])
  })

  it('changedAt moves only when a row\'s group or line changes; a permission prompt makes its row waiting', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    const changedAt = (): number => w.hub.view('tab-c')!.sessions[0].changedAt
    expect(changedAt()).toBe(NOW)
    w.now = NOW + 1000
    expect(changedAt()).toBe(NOW)
    w.now = NOW + 2000
    update(w, 'tab-1', { working: true })
    expect(changedAt()).toBe(NOW + 2000)
    w.now = NOW + 3000
    expect(changedAt()).toBe(NOW + 2000)

    w.now = NOW + 4000
    w.waits['tab-1'] = { prompt: { kind: 'permission', text: 'Run the tests?', since: NOW + 4000 }, limit: null }
    const v = w.hub.view('tab-c')!
    expect(v.sessions[0]).toMatchObject({ group: 'waiting', why: 'prompt', line: 'Run the tests?', changedAt: NOW + 4000 })
    expect(v.waiting).toBe(1)
    expect(w.hub.marks()['tab-c']).toEqual({ role: 'coordinator', project: 'acme', sessions: 1, waiting: 1 })
  })

  it('attachedTo names the coordinator a session is attached to as one plain line', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.store.putHosted({ session: S.two, coordinator: { device: null, session: uid(0x20000), name: 'other coord' }, project: 'acme', tasks: [], former: [] })
    expect(w.hub.view('tab-c')!.notAttached.map((r) => [r.name, r.attachedTo])).toEqual([
      ['parser · Desktop', null],
      ['docs · Desktop', 'other coord']
    ])
  })

  it('list and read answer with listText and readText; a tab that is not a coordinator gets notCoordinator', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    expect(w.hub.list('tab-1')).toEqual({ ok: false, error: HUB_TEXT.notCoordinator })
    expect(w.hub.read('tab-1', 'a10000')).toEqual({ ok: false, error: HUB_TEXT.notCoordinator })
    expect(w.hub.list('tab-c')).toEqual({
      ok: true,
      info: [
        'acme coordinator · 1 attached',
        'Idle (1):',
        '- parser · Desktop [a10000] · Idle · D:\\Work\\acme · main',
        'Not attached (this project):',
        '- docs · Desktop [b20000] · Idle · D:\\Work\\acme · main',
        'Notes:',
        '- Reports come to you by themselves when a task ends; there is no need to poll or wait.',
        '- As the coordinator, give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to.'
      ].join('\n')
    })
    expect(w.hub.read('tab-c', 'a10000')).toEqual({
      ok: true,
      info: ['parser · Desktop [a10000]', 'State: Idle · Idle', 'Folder: D:\\Work\\acme · Branch: main', 'No open task.', 'No report yet.'].join('\n')
    })
    expect(w.hub.read('tab-c', 'nobody')).toEqual({ ok: false, error: 'No session "nobody" here; call list_sessions.' })
    expect(await w.hub.tool('tab-c', { op: 'list' })).toMatchObject({ ok: true })
    expect(await w.hub.tool('tab-1', { op: 'list' })).toEqual({ ok: false, error: HUB_TEXT.notCoordinator })
    expect(await w.hub.tool('tab-c', { op: 'bogus' } as unknown as CoordOp)).toEqual({ ok: false, error: 'unknown operation' })
  })

  it('read shows the last report the session sent, and its text', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    const reportId = uid(0x4010)
    w.mail.add({
      v: 1,
      id: reportId,
      from: { device: null, session: S.one, name: 'parser · Desktop' },
      to: { device: null, session: S.coord, name: 'coord · Desktop' },
      replyTo: uid(0x3010),
      text: 'Parser fixed; the tests pass.',
      sentAt: NOW,
      delivered: true,
      read: false,
      kind: 'report',
      outcome: 'finished'
    })
    w.store.putCoordinator({ ...w.store.coordinator(S.coord)!, attachments: [{ ...attachment(S.one), lastReport: { id: reportId, outcome: 'finished', reason: null, at: NOW } }] })
    expect(w.hub.read('tab-c', 'a10000')).toEqual({
      ok: true,
      info: ['parser · Desktop [a10000]', 'State: Idle · Finished · report ready', 'Folder: D:\\Work\\acme · Branch: main', 'No open task.', 'Last report: finished 22:13', 'Parser fixed; the tests pass.'].join('\n')
    })
  })
})

describe('CoordinatorHub task lifecycle', () => {
  let w: World
  let task: MailRecord

  beforeEach(() => {
    w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    task = records(w, 'task')[0]
  })

  it('a task handed to a watcher is open; one written as a prompt is delivered until its turn starts', () => {
    w.hub.handedOver('tab-1', [task], 'prompt')
    expect(w.store.hosted(S.one)!.tasks[0]).toMatchObject({ state: 'delivered', deliveredAt: NOW })
    w.hub.turnStarted('tab-1')
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')
  })

  it('a turn that starts on a coordinator rechecks the mail, so a held watcher can take a stopped report', () => {
    w.order.length = 0
    w.hub.turnStarted('tab-c')
    expect(w.order).toContain('recheck')
    w.order.length = 0
    w.hub.turnStarted('tab-1')
    expect(w.order).not.toContain('recheck')
  })

  it('an event that does not apply to a task leaves it as it is and writes nothing', () => {
    const before = JSON.stringify(w.mail.all())
    w.hub.handedOver('tab-1', [task], 'running')
    w.hub.turnStarted('tab-1')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Nothing done.' })
    fire(w)
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ state: 'queued' }])
    expect(JSON.stringify(w.mail.all())).toBe(before)
  })

  it('a Stop with nothing after it finishes the task 2 s later: the report is the last answer, to the coordinator, on the task', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Parser fixed; 12 tests pass.' })
    expect(w.timers.map((t) => t.ms)).toEqual([2000])
    expect(records(w, 'report')).toEqual([])
    fire(w)
    expect(records(w, 'report')).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ session: S.one, name: 'parser · Desktop' }),
        to: expect.objectContaining({ session: S.coord }),
        replyTo: task.id,
        outcome: 'finished',
        text: 'Parser fixed; 12 tests pass.'
      })
    ])
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
    expect(w.store.coordinator(S.coord)!.attachments[0].lastReport).toMatchObject({ outcome: 'finished', reason: null })
  })

  it('a turn that starts within the settle keeps the task open; the report is the answer of the Stop after it', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Half done.' })
    w.hub.turnStarted('tab-1')
    expect(w.timers).toEqual([])
    fire(w)
    expect(records(w, 'report')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Parser fixed.' })
    fire(w)
    expect(records(w, 'report')).toMatchObject([{ outcome: 'finished', text: 'Parser fixed.' }])
  })

  it('a Stop with background work keeps the task open; the next Stop without it ends it', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: 'Waiting for the tests.' })
    expect(w.timers).toEqual([])
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Tests pass.' })
    expect(w.timers.map((t) => t.ms)).toEqual([2000])
    fire(w)
    expect(records(w, 'report')).toMatchObject([{ outcome: 'finished', text: 'Tests pass.' }])
  })

  it('a Stop while the tab is not resting does not end the task', () => {
    w.resting['tab-1'] = false
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Done.' })
    fire(w)
    expect(records(w, 'report')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')
  })

  it('a failed turn ClaudeTerm does not continue fails the task; a usage limit and a continued cut do not end it', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnFailed('tab-1', LIMIT_ERROR, false)
    w.hub.turnFailed('tab-1', 'server_error', true)
    expect(records(w, 'report')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')
    w.hub.turnFailed('tab-1', 'invalid_request', false)
    expect(records(w, 'report')).toMatchObject([
      {
        outcome: 'failed',
        reason: 'Claude Code stopped the turn on an error (invalid_request)',
        replyTo: task.id,
        text: 'The task failed: Claude Code stopped the turn on an error (invalid_request).'
      }
    ])
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
  })

  it("Esc in the task's turn stops it, also in a turn a watcher started; Esc outside a turn does nothing", () => {
    w.hub.interrupted('tab-1')
    expect(records(w, 'report')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('queued')

    w.hub.handedOver('tab-1', [task], 'prompt')
    w.hub.interrupted('tab-1')
    expect(records(w, 'report')).toEqual([])
    w.hub.handedOver('tab-1', [], 'idle')
    w.hub.interrupted('tab-1')
    expect(records(w, 'report')).toMatchObject([
      { outcome: 'stopped', reason: 'its turn was interrupted', replyTo: task.id, text: 'The task was stopped by the user: its turn was interrupted.' }
    ])
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
  })

  it("an interrupt read from the transcript stops the task only when it is not older than the task's delivery", () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.interrupted('tab-1', NOW - 1)
    expect(records(w, 'report')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')
    w.hub.interrupted('tab-1', NOW + 5)
    expect(records(w, 'report')).toMatchObject([{ outcome: 'stopped', reason: 'its turn was interrupted' }])
  })

  it('an interrupt whose time is unknown (0) counts as an Esc in the turn', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.interrupted('tab-1', 0)
    expect(records(w, 'report')).toMatchObject([{ outcome: 'stopped', replyTo: task.id }])
  })

  it('the process exiting fails the open task and keeps the queued ones; closing the tab fails every task', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.message('tab-c', 'a10000', 'Then the docs.')
    const second = records(w, 'task')[1]
    w.hub.exited('tab-1')
    expect(records(w, 'report')).toMatchObject([{ outcome: 'failed', reason: 'Claude Code exited', replyTo: task.id }])
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ id: second.id, state: 'queued' }])

    w.hub.tabClosed('tab-1')
    expect(records(w, 'report').map((r) => [r.replyTo, r.outcome, r.reason])).toEqual([
      [task.id, 'failed', 'Claude Code exited'],
      [second.id, 'failed', 'its tab was closed']
    ])
    expect(w.mail.get(second.id)).toMatchObject({ delivered: true, read: false })
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
    expect(w.store.coordinator(S.coord)!.attachments).toHaveLength(1)
  })

  it('a clear stops the open task, and the report comes from the new session id', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    const NEW = uid(0x2002)
    update(w, 'tab-1', { session: NEW })
    w.hub.sessionStarted('tab-1', S.one, NEW, 'clear')
    expect(w.store.hosted(NEW)!.tasks).toEqual([])
    expect(records(w, 'report')).toMatchObject([
      {
        from: { session: NEW, name: 'parser · Desktop' },
        to: { session: S.coord },
        replyTo: task.id,
        outcome: 'stopped',
        reason: 'the session was cleared',
        text: 'The task was stopped by the user: the session was cleared.'
      }
    ])
  })

  it('a task the previous coordinator gave reports to the new one with a note', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Parser fixed.' })
    w.hub.make('tab-2', true)
    fire(w)
    expect(records(w, 'report')).toMatchObject([
      {
        from: { session: S.one },
        to: { session: S.two },
        replyTo: task.id,
        outcome: 'finished',
        text: '(This task was given by the previous coordinator, coord · Desktop.)\n\nParser fixed.'
      }
    ])
  })

  it('a failed report marks the attachment failed until the next task', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnFailed('tab-1', 'invalid_request', false)
    expect(w.store.coordinator(S.coord)!.attachments[0]).toMatchObject({
      failed: true,
      lastReport: { outcome: 'failed', reason: 'Claude Code stopped the turn on an error (invalid_request)' }
    })
    w.hub.message('tab-c', 'a10000', 'Try again.')
    expect(w.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ failed: false })
  })

  it('a report that cannot be written still ends the task, and the coordinator shows its outcome', () => {
    let broken = false
    let ids = 0x6000
    const flaky = world({ newId: () => (broken ? 'not-a-uuid' : uid(++ids)) })
    flaky.hub.make('tab-c', false)
    flaky.hub.attach('tab-c', 'a10000')
    flaky.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const [t] = records(flaky, 'task')
    broken = true
    flaky.hub.handedOver('tab-1', [t], 'idle')
    flaky.hub.turnFailed('tab-1', 'invalid_request', false)
    expect(flaky.store.hosted(S.one)!.tasks).toEqual([])
    expect(records(flaky, 'report')).toEqual([])
    expect(flaky.warns.some((m) => m.includes('report'))).toBe(true)
    expect(flaky.store.coordinator(S.coord)!.attachments[0]).toMatchObject({
      failed: true,
      lastReport: { id: t.id, outcome: 'failed', reason: 'Claude Code stopped the turn on an error (invalid_request)' }
    })

    // the store loads its file back: the attachment must survive a restart, with its last report
    flaky.store.flush()
    const reloaded = new CoordinatorStore(flaky.dir, { debounceMs: 100_000 })
    expect(reloaded.coordinator(S.coord)!.attachments).toEqual([
      expect.objectContaining({ session: S.one, failed: true, lastReport: { id: t.id, outcome: 'failed', reason: 'Claude Code stopped the turn on an error (invalid_request)', at: NOW } })
    ])
  })

  it('a detach whose record cannot be written still detaches the session, and logs why', () => {
    let broken = false
    let ids = 0x7000
    const flaky = world({ newId: () => (broken ? 'not-a-uuid' : uid(++ids)) })
    flaky.hub.make('tab-c', false)
    flaky.hub.attach('tab-c', 'a10000')
    broken = true
    expect(flaky.hub.detach('tab-c', 'a10000')).toEqual({ ok: true, info: 'Detached parser · Desktop.' })
    expect(flaky.store.hosted(S.one)).toBeNull()
    expect(flaky.store.coordinator(S.coord)!.attachments).toEqual([])
    expect(flaky.warns).toHaveLength(1)
  })

  it('a device id that is empty reads as no device: this device\'s records keep it as null', () => {
    const bare = world({ self: '' })
    bare.hub.make('tab-c', false)
    expect(bare.hub.attach('tab-c', 'a10000')).toMatchObject({ ok: true })
    expect(records(bare, 'attach')[0].from.device).toBeNull()
  })

  it('a task taken from the mail is rechecked, then its tab is poked, then the window is told', () => {
    w.order.length = 0
    w.mail.add({
      v: 1,
      id: uid(0x3010),
      from: { device: null, session: S.coord, name: 'coord · Desktop' },
      to: { device: null, session: S.one, name: 'parser · Desktop' },
      replyTo: null,
      text: 'Another one.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'task',
      project: 'acme'
    })
    expect(w.order).toEqual(['recheck', 'poke:tab-1', 'changed'])
  })

  it("after an outcome the hub rechecks the mail, pokes the session's tab and tells the window", () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Done.' })
    w.order.length = 0
    fire(w)
    expect(w.order.slice(-3)).toEqual(['recheck', 'poke:tab-1', 'changed'])
    expect(w.pokes).toContain('tab-1')
  })

  it('a session detached before its outcome reports nothing', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Done.' })
    w.hub.detach('tab-c', 'a10000')
    fire(w)
    expect(records(w, 'report')).toEqual([])
  })

  it('a turn that ended without background work and a dispose before its settle: no report is written after it', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Done.' })
    w.hub.dispose()
    fire(w)
    expect(records(w, 'report')).toEqual([])
  })

  it('a clear ends the turn the tab was in: a task delivered after it is not stopped by an Esc outside a turn', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    const NEW = uid(0x2002)
    update(w, 'tab-1', { session: NEW })
    w.hub.sessionStarted('tab-1', S.one, NEW, 'clear')
    w.hub.message('tab-c', 'parser · Desktop', 'Then the docs.')
    const next = records(w, 'task')[1]
    w.hub.handedOver('tab-1', [next], 'prompt')
    w.hub.interrupted('tab-1')
    expect(records(w, 'report').map((r) => r.outcome)).toEqual(['stopped'])
  })

  it('a detach drops the kept last answers of the tasks it drops', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Parser fixed.' })
    w.hub.detach('tab-c', 'a10000')
    // white-box: the answer of a dropped task has no reader left, so the map must not keep it
    expect((w.hub as unknown as { answers: Map<string, string> }).answers.size).toBe(0)
  })
})

const S_NEW = 'd4000000-0000-4000-8000-000000000005'
const START = { task: 'Write the release notes.', name: 'Release notes', folder: null, device: null, worktree: null }
/** lets the hub's async folder check run */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** the window shows the tab a start opened, with the session it started */
const showSession = (w: World, tabId: string, session: string): void => {
  w.tabs = [...w.tabs, tab(tabId, session, ACME)]
  w.hub.tabSession(tabId, session)
}

describe('CoordinatorHub start', () => {
  it("start opens a Claude tab in the coordinator's folder, on its account, behind, named as asked", async () => {
    const w = world()
    w.tabs[0] = { ...w.tabs[0], account: 'acc-1' }
    w.hub.make('tab-c', false)
    TITLES['new-tab-1'] = 'Release notes'
    const answer = w.hub.start('tab-c', { task: 'Write the release notes.', name: 'Release notes', folder: null, device: null, worktree: null })
    await tick()
    expect(w.opened).toEqual([{ kind: 'claude', cwd: 'D:\\Work\\acme', account: 'acc-1', title: 'Release notes' }])
    expect(w.hub.view('tab-c')!.sessions).toEqual([expect.objectContaining({ key: 'start:new-tab-1', marker: 'starting', line: 'Starting…', group: 'working' })])
    w.tabs.push(tab('new-tab-1', null, ACME))
    w.hub.tabSession('new-tab-1', null)
    w.tabs[4] = { ...w.tabs[4], session: S_NEW }
    w.hub.tabSession('new-tab-1', S_NEW)
    expect(await answer).toEqual({
      ok: true,
      info: `Started Release notes · Desktop [${refOf(S_NEW)}] in D:\\Work\\acme on Account acc-1, attached to you. Its task is its first message; its report comes to you by itself when the task ends.`
    })
    expect(records(w, 'task')).toEqual([expect.objectContaining({ to: expect.objectContaining({ session: S_NEW }), text: 'Write the release notes.' })])
  })

  it('a worktree name puts the EnterWorktree instruction before the task', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    const answer = w.hub.start('tab-c', { ...START, worktree: 'notes' })
    await tick()
    showSession(w, 'new-tab-1', S_NEW)
    await answer
    expect(records(w, 'task')).toEqual([expect.objectContaining({ text: worktreeInstruction('notes') + 'Write the release notes.' })])
  })

  it('without a session within 20 s it answers that the session is starting, and a later session is still attached and tasked', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    const answer = w.hub.start('tab-c', START)
    await tick()
    expect(w.timers.map((t) => t.ms)).toEqual([START_WAIT_MS])
    fire(w)
    expect(await answer).toEqual({
      ok: true,
      info: 'Opening Release notes in D:\\Work\\acme on Main account. It shows as Starting… until its session starts; its task is sent then.'
    })
    expect(w.hub.view('tab-c')!.sessions).toEqual([expect.objectContaining({ key: 'start:new-tab-1', marker: 'starting' })])
    showSession(w, 'new-tab-1', S_NEW)
    expect(w.store.coordinator(S.coord)!.attachments.map((a) => a.session)).toEqual([S_NEW])
    expect(records(w, 'task')).toEqual([expect.objectContaining({ to: expect.objectContaining({ session: S_NEW }), text: 'Write the release notes.' })])
  })

  it('a folder that is not a directory and another device are refused, and nothing opens; this device\'s name is accepted in any case', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    expect(await w.hub.start('tab-c', { ...START, device: 'Laptop' })).toEqual({ ok: false, error: 'No paired device named "Laptop".' })
    expect(await w.hub.start('tab-c', { ...START, folder: 'D:\\Nowhere' })).toEqual({ ok: false, error: 'No folder D:\\Nowhere on this device.' })
    // a folder named for this device is a path here: a relative one is no folder, even when this device's isDirectory says it is one
    w.dirs.push('relative/acme')
    expect(await w.hub.start('tab-c', { ...START, device: 'desktop', folder: 'relative/acme' })).toEqual({ ok: false, error: 'No folder relative/acme on this device.' })
    expect(w.opened).toEqual([])
    void w.hub.start('tab-c', { ...START, device: 'desktop' })
    await tick()
    expect(w.opened).toHaveLength(1)
  })

  it('a pending start whose tab closes is dropped, and the answer says so', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    const answer = w.hub.start('tab-c', START)
    await tick()
    w.hub.tabClosed('new-tab-1')
    expect(await answer).toEqual({ ok: false, error: HUB_TEXT.closedEarly })
    expect(w.hub.view('tab-c')!.sessions).toEqual([])
    expect(w.timers).toEqual([])
  })

  it('detach of a Starting row cancels its start: the start answers so, and its session, when it comes, is neither attached nor tasked', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    const answer = w.hub.start('tab-c', START)
    await tick()
    expect(w.hub.detach('tab-c', 'Release notes')).toEqual({ ok: true, info: 'Detached Release notes; its open task was dropped.' })
    expect(await answer).toEqual({ ok: false, error: HUB_TEXT.startCancelled })
    expect(w.timers).toEqual([])
    showSession(w, 'new-tab-1', S_NEW)
    expect(w.store.coordinator(S.coord)!.attachments).toEqual([])
    expect(w.store.hosted(S_NEW)).toBeNull()
    expect(records(w, 'attach')).toEqual([])
    expect(records(w, 'task')).toEqual([])
  })

  it('resolve of a Starting row answers that it is still starting', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    void w.hub.start('tab-c', START)
    await tick()
    expect(w.hub.resolve('tab-c', 'Release notes')).toEqual({ ok: false, error: 'Release notes is still starting.' })
  })

  it('message to a Starting row answers that it is still starting, and writes no task', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    void w.hub.start('tab-c', START)
    await tick()
    expect(w.hub.message('tab-c', 'Release notes', 'Fix it.')).toEqual({
      ok: false,
      error: 'Release notes is still starting; its first task is already waiting.'
    })
    expect(records(w, 'task')).toEqual([])
  })

  it('start answers fullAttached before a tab opens when the pending starts fill the coordinator\'s attachments', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.store.putCoordinator({
      session: S.coord,
      project: ACME,
      since: NOW,
      attachments: Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => attachment(uid(0x10000 + i))),
      former: []
    })
    void w.hub.start('tab-c', START)
    await tick()
    expect(w.opened).toHaveLength(1)
    expect(await w.hub.start('tab-c', START)).toEqual({ ok: false, error: HUB_TEXT.fullAttached })
    expect(w.opened).toHaveLength(1)
  })

  it('a session whose attach or task record cannot be written is not attached: its start answers notSaved, and the hub logs why', async () => {
    let broken = false
    let ids = 0x8000
    const flaky = world({ newId: () => (broken ? 'not-a-uuid' : uid(++ids)) })
    flaky.hub.make('tab-c', false)
    const answer = flaky.hub.start('tab-c', START)
    await tick()
    broken = true
    showSession(flaky, 'new-tab-1', S_NEW)
    expect(await answer).toEqual({ ok: false, error: HUB_TEXT.notSaved })
    expect(flaky.warns.length).toBeGreaterThan(0)
    expect(flaky.store.coordinator(S.coord)!.attachments).toEqual([])
    expect(flaky.store.hosted(S_NEW)).toBeNull()
    expect(flaky.mail.all()).toEqual([])
  })

  it('tool gives a start to the hub', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    void w.hub.tool('tab-c', { op: 'start', task: 'Write it.', name: null, folder: null, device: null, worktree: null })
    await tick()
    expect(w.opened).toHaveLength(1)
  })
})

describe('facts for other devices', () => {
  it('facts give a tab\'s open dialog, its limit, its task list, the task it holds and its coordinator', () => {
    const w = world(); w.hub.make('tab-c', false); w.hub.attach('tab-c', 'a10000'); w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const [t] = records(w, 'task')
    w.waits['tab-1'] = { prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: NOW }, limit: { resetsAt: null, since: NOW } }
    w.progress['tab-1'] = { title: 'Triage', done: 3, total: 7, finished: false, tasks: [{ n: 3, title: 'Read the logs', state: 'done' }, { n: 4, title: 'Grouping crashes by call stack', state: 'current' }] }
    expect(w.hub.facts('tab-1')).toEqual({
      prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: NOW }, limit: { resetsAt: null, since: NOW },
      progress: { done: 3, total: 7, finished: false, current: 'Grouping crashes by call stack' },
      task: { id: t.id, state: 'queued', since: NOW }, attachedTo: 'coord · Desktop', coordinator: false
    })
    expect(w.hub.facts('tab-c')).toMatchObject({ coordinator: true, task: null, attachedTo: null })
    expect(w.hub.facts('no-such-tab')).toBeNull()
  })

  it('a time of a fact is floored, and a current task with a blank title gives no current title', () => {
    const w = world()
    w.waits['tab-1'] = { prompt: null, limit: { resetsAt: NOW + 0.5, since: NOW + 0.75 } }
    w.progress['tab-1'] = { title: 'Triage', done: 0, total: 1, finished: false, tasks: [{ n: 1, title: '   ', state: 'current' }] }
    expect(w.hub.facts('tab-1')).toMatchObject({ limit: { resetsAt: NOW, since: NOW }, progress: { done: 0, total: 1, finished: false, current: null } })
  })
})

describe('the role note of a coordinator', () => {
  const EMPTY = 'You coordinate acme in ClaudeTerm: give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to. No sessions are attached yet: attach one with attach_session, or start one with start_session.'
  /** the note's block as the mail carries it: its head, from and id lines, and the text quoted */
  const BLOCK = (text: string): string => ['Note from ClaudeTerm, not from the user:', 'from: ClaudeTerm', 'id: role-note', '', `> ${text}`].join('\n')

  it('make makes the note due: roleNote gives its block until roleNoteTaken clears it', () => {
    const w = world()
    expect(w.hub.roleNote('tab-c')).toBeNull()
    w.hub.make('tab-c', false)
    expect(w.hub.roleNote('tab-c')).toBe(BLOCK(EMPTY))
    expect(w.hub.roleNote('tab-c')).toBe(BLOCK(EMPTY))
    w.hub.roleNoteTaken('tab-c')
    expect(w.hub.roleNote('tab-c')).toBeNull()
  })

  it('a make that finds the tab a coordinator already sets nothing', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.roleNoteTaken('tab-c')
    expect(w.hub.make('tab-c', false)).toEqual({ ok: true, info: 'This tab is already the coordinator of acme.' })
    expect(w.hub.roleNote('tab-c')).toBeNull()
  })

  it('a replacing make makes only the new tab due; the replaced tab gets no note', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.roleNoteTaken('tab-c')
    expect(w.hub.make('tab-2', true)).toEqual({ ok: true, info: 'This tab is now the coordinator of acme; 0 sessions moved from coord · Desktop.' })
    expect(w.hub.roleNote('tab-2')).toBe(BLOCK(EMPTY))
    expect(w.hub.roleNote('tab-c')).toBeNull()
  })

  it('a clear or a compact makes the note due under the new session; a startup does not', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.roleNoteTaken('tab-c')
    const NEW = uid(0x2001)
    update(w, 'tab-c', { session: NEW })
    w.hub.sessionStarted('tab-c', S.coord, NEW, 'clear')
    expect(w.hub.roleNote('tab-c')).toBe(BLOCK(EMPTY))
    w.hub.roleNoteTaken('tab-c')
    const NEXT = uid(0x2002)
    update(w, 'tab-c', { session: NEXT })
    w.hub.sessionStarted('tab-c', NEW, NEXT, 'compact')
    expect(w.hub.roleNote('tab-c')).toBe(BLOCK(EMPTY))
    w.hub.roleNoteTaken('tab-c')
    w.hub.sessionStarted('tab-c', NEXT, NEXT, 'startup')
    expect(w.hub.roleNote('tab-c')).toBeNull()
  })

  it('two clears before the next turn leave one note, and taking it once clears it', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.roleNoteTaken('tab-c')
    const NEW = uid(0x2003)
    const NEXT = uid(0x2004)
    update(w, 'tab-c', { session: NEW })
    w.hub.sessionStarted('tab-c', S.coord, NEW, 'clear')
    update(w, 'tab-c', { session: NEXT })
    w.hub.sessionStarted('tab-c', NEW, NEXT, 'clear')
    expect(w.hub.roleNote('tab-c')).toBe(BLOCK(EMPTY))
    w.hub.roleNoteTaken('tab-c')
    expect(w.hub.roleNote('tab-c')).toBeNull()
  })

  it('a resume does not make the note due: a restored coordinator is not told its role again', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.roleNoteTaken('tab-c')
    const RESUMED = uid(0x2006)
    update(w, 'tab-c', { session: RESUMED })
    w.hub.sessionStarted('tab-c', S.coord, RESUMED, 'resume')
    expect(w.store.coordinator(RESUMED)).toMatchObject({ session: RESUMED })
    expect(w.hub.roleNote('tab-c')).toBeNull()
  })

  it('a stop, a closed tab and an exited tab each drop the note', () => {
    const stopped = world()
    stopped.hub.make('tab-c', false)
    stopped.hub.stop('tab-c')
    expect(stopped.hub.roleNote('tab-c')).toBeNull()

    const closed = world()
    closed.hub.make('tab-c', false)
    closed.hub.tabClosed('tab-c')
    expect(closed.hub.roleNote('tab-c')).toBeNull()

    const exited = world()
    exited.hub.make('tab-c', false)
    exited.hub.exited('tab-c')
    expect(exited.hub.roleNote('tab-c')).toBeNull()
  })

  it('the note reads the rows at the time it is built: a session attached after the make is in it', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    const row = w.hub.view('tab-c')!.sessions[0]!
    expect(w.hub.roleNote('tab-c')).toBe(
      BLOCK(`You coordinate acme in ClaudeTerm: give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to. 1 session (${row.name} — ${row.line}). Reports come by themselves when a task ends; use list_sessions for more.`)
    )
  })
})
