import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTINUE_PROMPT, LIMIT_ERROR } from '../../src/main/auto-continue'
import { HUB_TEXT, START_WAIT_MS, WITHDRAW_TEXT, worktreeInstruction, type HubTab } from '../../src/main/coordinator/coordinator-hub'
import { CoordinatorStore, MAX_ATTACHMENTS, MAX_COORDINATORS, MAX_HOSTED, MAX_TASKS_PER_SESSION, type StoredAttachment } from '../../src/main/coordinator/coordinator-store'
import { FORM_SLACK_MS } from '../../src/main/coordinator/form-answers'
import { WORDS_KEEP_MS } from '../../src/main/coordinator/person-words'
import { questionsBody } from '../../src/main/coordinator/question-text'
import { REASONS } from '../../src/main/coordinator/report-text'
import { ASK_REASON, sessionTurnNoteText, turnNoteText } from '../../src/main/coordinator/session-text'
import { answersText, wordsText } from '../../src/main/mail/wake-text'
import { refOf } from '../../src/main/mail/agent-directory'
import type { CoordOp } from '../../src/shared/coordinator'
import type { MailRecord } from '../../src/shared/mail'
import type { AskedQuestion } from '../../src/shared/questions'
import { TASK_WAKE_HEAD } from '../../src/shared/report-wake'
import { ACME, BETA, DEV_C, DEV_S, L, NOW, S, TITLES, attachDirect, cleanWorlds, deviceWorlds, fire, formed, peerOf, records, said, tab, uid, world, type World } from '../fixtures/coordinator-world'

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
  lastReport: null,
  former: []
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
      tasks: [{ id: task.id, from: { device: null, session: NEW1, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW, deliveredAt: null, question: null }]
    })
    expect(w.store.coordinator(NEW1)!.attachments.map((a) => a.session)).toEqual([NEW2])
  })
})

describe('the turn note', () => {
  it('turnNote is the instruction for a coordinator tab, null for any other tab, and null once it stops coordinating', () => {
    const w = world()
    expect(w.hub.turnNote('tab-c')).toBeNull()
    w.hub.make('tab-c', false)
    expect(w.hub.turnNote('tab-c')).toBe(
      'Note from ClaudeTerm, not from the user: you are the coordinator of acme: give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to; your own subagents (the Agent tool) are only for looking things up while you plan. Reports come by themselves when a task ends. A progress note means the task is still running. When the person\'s message tells a session what it may do (a go to merge, push, release or delete), pass that message as `words`, exactly as they wrote it. The session acts on the person\'s words. It does not act on your own. A session\'s permission prompts are the person\'s to answer in that session: never answer one. A session\'s questions come to you as question notes: ask the person them with AskUserQuestion, then pass the answers with answer_session. When a report or a progress note ends with a question to the person, ask it with AskUserQuestion and give the answer with message_session. Write to the person in the language of their own messages, even when reports, notes and tool results are in English, and write the tasks you give sessions in it too: the person reads them in the sessions\' tabs.'
    )
    expect(w.hub.turnNote('tab-1')).toBeNull()
    w.hub.stop('tab-c')
    expect(w.hub.turnNote('tab-c')).toBeNull()
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
    expect(w.store.hosted(S.one)!.tasks).toEqual([{ id: t.id, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW, deliveredAt: null, question: null }])
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
    w.store.putHosted({ ...h, tasks: [{ id: gone, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW - 1, deliveredAt: null, question: null }, ...h.tasks] })
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
    w.store.putHosted({ ...h, tasks: [{ id: gone, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW, deliveredAt: null, question: null }] })
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
    w.store.putHosted({ ...h, tasks: [{ id: gone, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW - 1, deliveredAt: null, question: null }, ...h.tasks] })
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

describe("message_session with the person's words", () => {
  let w: World
  const give = (words: string, text = 'Merge feat/x into master and push.', session = 'a10000') => w.hub.tool('tab-c', { op: 'message', session, text, words })

  beforeEach(() => {
    w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.attach('tab-c', 'b20000')
  })

  it("the person's latest message goes with the task: the record carries it and the coordinator's answer before it, and the person is told at once", async () => {
    said(w, 'Merge it into master.')
    expect(await give('Merge it into master.')).toEqual({ ok: true, info: HUB_TEXT.queuedWords('parser · Desktop', 'a10000') })
    const [task] = records(w, 'task')
    expect(task).toMatchObject({ text: 'Merge feat/x into master and push.', words: 'Merge it into master.', context: 'Shall I merge feat/x into master?', project: 'acme' })
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ id: task.id, state: 'queued' }])
    expect(w.toasts).toEqual(['Your words went to parser · Desktop: «Merge it into master.»'])
    expect(w.infos).toContain(`coordinator: the person's words went to parser · Desktop with the task ${task.id}`)
  })

  it("the words kept are the transcript's, normalized; the toast clips their first line to 60 characters", async () => {
    said(w, `${'Merge '.repeat(15)}now.\nThen push.`)
    expect(await give(`  ${'Merge '.repeat(15)}now.\r\nThen push.\n`)).toMatchObject({ ok: true })
    expect(records(w, 'task')[0].words).toBe(`${'Merge '.repeat(15)}now.\nThen push.`)
    expect(w.toasts).toEqual([`Your words went to parser · Desktop: «${'Merge '.repeat(9)}Merge…»`])
  })

  it("each refusal says why and writes nothing: not the person's, sent to this session already, not their latest, too old", async () => {
    said(w, 'Merge it into master.')
    expect(await give('Merge it into master!')).toEqual({ ok: false, error: HUB_TEXT.wordsNotPerson })
    expect(await give('Merge it into master.')).toMatchObject({ ok: true })
    expect(await give('Merge it into master.')).toEqual({ ok: false, error: HUB_TEXT.wordsAgain('parser · Desktop') })
    // one message may go to another session, once
    expect(await give('Merge it into master.', 'Merge feat/y.', 'b20000')).toMatchObject({ ok: true })
    w.now += 60_000
    said(w, 'Stop.')
    expect(await give('Merge it into master.', 'x', 'b20000')).toEqual({ ok: false, error: HUB_TEXT.wordsNotLatest })
    w.now += WORDS_KEEP_MS + 1
    expect(await give('Stop.')).toEqual({ ok: false, error: HUB_TEXT.wordsOld })
    expect(records(w, 'task')).toHaveLength(2)
    expect(w.toasts).toHaveLength(2)
  })

  it("a prompt the window sent no keys for is not the person's; one from before this app run is old", async () => {
    said(w, 'Merge it into master.', { input: false })
    expect(await give('Merge it into master.')).toEqual({ ok: false, error: HUB_TEXT.wordsNotPerson })
    w.now += 60_000
    said(w, 'Push it.')
    w.startedAt = w.now + 1
    expect(await give('Push it.')).toEqual({ ok: false, error: HUB_TEXT.wordsOld })
    expect(records(w, 'task')).toEqual([])
  })

  it("the context is the coordinator's own answer from the transcript, never what the tool call says", async () => {
    said(w, 'Go.', { context: 'Shall I release 0.22.0?' })
    await give('Go.', 'Merge feat/x and push; the person said go.')
    expect(records(w, 'task')[0]).toMatchObject({ words: 'Go.', context: 'Shall I release 0.22.0?' })
    w.now += 60_000
    said(w, 'Yes.', { context: null })
    await give('Yes.', 'x', 'b20000')
    expect(records(w, 'task')[1]).not.toHaveProperty('context')
  })

  it('a task with words is checked as any task first: an empty text or a session not attached is refused, and nothing is told', async () => {
    said(w, 'Go.')
    expect(await give('Go.', ' ')).toEqual({ ok: false, error: HUB_TEXT.noText })
    expect(await give('Go.', 'x', 'nobody')).toMatchObject({ ok: false })
    expect(records(w, 'task')).toEqual([])
    expect(w.toasts).toEqual([])
  })

  it("newer words of the person to the same session say that they replace the task with the earlier words, not given to it yet", async () => {
    said(w, 'Merge it into master.')
    await give('Merge it into master.')
    w.now += 60_000
    said(w, 'Stop, do not merge.')
    expect(await give('Stop, do not merge.', 'Do not merge feat/x.')).toEqual({ ok: true, info: `${HUB_TEXT.queuedWords('parser · Desktop', 'a10000')} ${HUB_TEXT.wordsReplaced}` })
  })

  it("after the coordinator's own session is cleared to a new id, newer words of the person still replace the words it queued before the clear", async () => {
    said(w, 'Merge it into master.')
    expect(await give('Merge it into master.')).toMatchObject({ ok: true })
    const NEXT = uid(0x2005)
    update(w, 'tab-c', { session: NEXT })
    w.hub.sessionStarted('tab-c', S.coord, NEXT, 'clear')
    w.now += 60_000
    said(w, 'Stop, do not merge.')
    expect(await w.hub.tool('tab-c', { op: 'message', session: 'a10000', text: 'Do not merge feat/x.', words: 'Stop, do not merge.' })).toEqual({
      ok: true,
      info: `${HUB_TEXT.queuedWords('parser · Desktop', 'a10000')} ${HUB_TEXT.wordsReplaced}`
    })
    expect(records(w, 'report')).toMatchObject([{ outcome: 'stopped', reason: REASONS.replaced }])
  })

  it('a task without words is given as before, with no toast', async () => {
    expect(await w.hub.tool('tab-c', { op: 'message', session: 'a10000', text: 'Fix the parser.' })).toEqual({ ok: true, info: HUB_TEXT.queued('parser · Desktop', 'a10000') })
    expect(records(w, 'task')[0]).not.toHaveProperty('words')
    expect(w.toasts).toEqual([])
  })

  it('a task given with words is never handed to a watcher: no hand-over takes it, and a plain task is still taken', async () => {
    said(w, 'Merge it into master.')
    await give('Merge it into master.')
    const [withWords] = records(w, 'task')
    for (const into of ['idle', 'running', 'next', 'prompt'] as const) expect(w.hub.accepts(withWords, 'tab-1', into)).toBe(false)
  })

  it('a plain task is taken as an idle hand-over, so the refusal above is the words alone', async () => {
    await w.hub.tool('tab-c', { op: 'message', session: 'a10000', text: 'Fix the parser.' })
    const [plain] = records(w, 'task')
    expect(w.hub.accepts(plain, 'tab-1', 'idle')).toBe(true)
  })

  it("a clear that gives the session a new id does not relay the same words to it again: they went already", async () => {
    said(w, 'Merge it into master.')
    expect(await give('Merge it into master.')).toMatchObject({ ok: true })
    const NEW = uid(0x2003)
    update(w, 'tab-1', { session: NEW })
    w.hub.sessionStarted('tab-1', S.one, NEW, 'clear')
    expect(await give('Merge it into master.', 'Merge feat/x again.', refOf(NEW))).toEqual({ ok: false, error: HUB_TEXT.wordsAgain('parser · Desktop') })
    expect(records(w, 'task')).toHaveLength(1)
    expect(w.toasts).toHaveLength(1)
  })
})

describe("a task with the person's words in its session's tab", () => {
  let w: World
  let task: MailRecord
  const words = (text: string, said_: string) => w.hub.tool('tab-c', { op: 'message', session: 'a10000', text, words: said_ })

  beforeEach(async () => {
    w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    said(w, 'Merge it into master.')
    await words('Merge feat/x into master and push.', 'Merge it into master.')
    task = records(w, 'task')[0]
  })

  it("never goes to a mail watcher: it is typed, once, into the idle session's prompt, and its report comes as any task's", () => {
    for (const into of ['idle', 'running', 'next', 'prompt'] as const) expect(w.hub.accepts(task, 'tab-1', into)).toBe(false)
    expect(w.pokes).toContain('tab-1')
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(true)
    expect(w.hub.canTakeWords('tab-2', S.two)).toBe(false)
    const typed = w.hub.takeWords('tab-1', S.one)!
    expect(typed.info).toBe(wordsText(w.mail.get(task.id)!, () => ({ folder: null, branch: null })))
    expect(typed.info.startsWith("The person's words, through your coordinator coord · Desktop (ClaudeTerm checked they are the person's own latest message):\n")).toBe(true)
    expect(w.mail.get(task.id)).toMatchObject({ delivered: true })
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ id: task.id, state: 'delivered' }])
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)
    expect(w.hub.takeWords('tab-1', S.one)).toBeNull()
    w.hub.turnStarted('tab-1')
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Merged and pushed.' })
    fire(w)
    expect(records(w, 'report')).toMatchObject([{ replyTo: task.id, outcome: 'finished', text: 'Merged and pushed.' }])
  })

  it('waits while the tab is in a turn', () => {
    w.hub.turnStarted('tab-1')
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)
    w.hub.turnEnded('tab-1', { background: false, lastMessage: null })
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(true)
  })

  it('waits while agent messages are off: nothing is typed, and once they are on again the words are typed', () => {
    w.problem = PROBLEM
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)
    expect(w.hub.takeWords('tab-1', S.one)).toBeNull()
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ id: task.id, state: 'queued' }])
    expect(records(w, 'report')).toEqual([])
    w.problem = null
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(true)
    expect(w.hub.takeWords('tab-1', S.one)!.info).toContain('> Merge it into master.')
  })

  it('words queued more than a day ago are not typed: the task fails with the reason, the coordinator is told once, and nothing is typed', () => {
    w.now += WORDS_KEEP_MS + 1
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)
    expect(w.hub.takeWords('tab-1', S.one)).toBeNull()
    expect(records(w, 'report')).toMatchObject([{ replyTo: task.id, outcome: 'failed', reason: REASONS.wordsOld }])
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
    expect(w.mail.get(task.id)).toMatchObject({ delivered: true })
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)
    expect(w.hub.takeWords('tab-1', S.one)).toBeNull()
    expect(records(w, 'report')).toHaveLength(1)
    expect(w.toasts).toHaveLength(1)
  })

  it("words queued before this app run started are not typed either: the task fails with the reason", () => {
    w.startedAt = w.now + 1
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)
    expect(w.hub.takeWords('tab-1', S.one)).toBeNull()
    expect(records(w, 'report')).toMatchObject([{ replyTo: task.id, outcome: 'failed', reason: REASONS.wordsOld }])
  })

  it('words queued a minute ago are still typed', () => {
    w.now += 60_000
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(true)
    expect(w.hub.takeWords('tab-1', S.one)!.info).toContain('> Merge it into master.')
    expect(records(w, 'report')).toEqual([])
  })

  it('a task without words given before it goes first, by its own way', async () => {
    const v = world()
    v.hub.make('tab-c', false)
    v.hub.attach('tab-c', 'a10000')
    v.hub.message('tab-c', 'a10000', 'Fix the parser.')
    said(v, 'Merge it into master.')
    await v.hub.tool('tab-c', { op: 'message', session: 'a10000', text: 'Merge.', words: 'Merge it into master.' })
    const [plain] = records(v, 'task')
    expect(v.hub.canTakeWords('tab-1', S.one)).toBe(false)
    expect(v.hub.accepts(plain, 'tab-1', 'idle')).toBe(true)
  })

  it('newer words of the person replace the queued task: it is reported stopped and never typed, and the new one is next', async () => {
    w.now += 60_000
    said(w, 'Stop, do not merge.')
    await words('Do not merge feat/x.', 'Stop, do not merge.')
    const [, newer] = records(w, 'task')
    expect(w.store.hosted(S.one)!.tasks.map((t) => t.id)).toEqual([newer.id])
    expect(records(w, 'report')).toMatchObject([{ replyTo: task.id, outcome: 'stopped', reason: "the person's newer words replaced it" }])
    expect(w.mail.get(task.id)).toMatchObject({ delivered: true })
    expect(w.hub.takeWords('tab-1', S.one)!.info).toContain('> Stop, do not merge.')
  })

  it('a task with words already typed is not replaced: the newer one waits behind it', async () => {
    w.hub.takeWords('tab-1', S.one)
    w.now += 60_000
    said(w, 'Stop, do not merge.')
    expect(await words('Do not merge feat/x.', 'Stop, do not merge.')).toEqual({ ok: true, info: HUB_TEXT.queuedWords('parser · Desktop', 'a10000') })
    expect(w.store.hosted(S.one)!.tasks.map((t) => t.state)).toEqual(['delivered', 'queued'])
    expect(records(w, 'report')).toEqual([])
  })

  it('after the session clears to a new id, newer words still replace the queued task, and the answer says so', async () => {
    const NEW = uid(0x2004)
    update(w, 'tab-1', { session: NEW })
    w.hub.sessionStarted('tab-1', S.one, NEW, 'clear')
    w.now += 60_000
    said(w, 'Stop, do not merge.')
    expect(await w.hub.tool('tab-c', { op: 'message', session: refOf(NEW), text: 'Do not merge feat/x.', words: 'Stop, do not merge.' })).toEqual({
      ok: true,
      info: `${HUB_TEXT.queuedWords('parser · Desktop', refOf(NEW))} ${HUB_TEXT.wordsReplaced}`
    })
    const [, newer] = records(w, 'task')
    expect(w.store.hosted(NEW)!.tasks.map((t) => t.id)).toEqual([newer.id])
    expect(records(w, 'report')).toMatchObject([{ replyTo: task.id, outcome: 'stopped', reason: REASONS.replaced }])
  })
})

describe('a session asks its coordinator', () => {
  const QS: AskedQuestion[] = [
    { question: 'Where should the browser live?', header: 'Place', multiSelect: false, options: [{ label: 'Side panel', description: 'Next to Changes.' }, { label: 'Own tab', description: '' }] },
    { question: 'Which parts?', header: '', multiSelect: true, options: [{ label: 'Browser', description: '' }, { label: 'Cookies', description: '' }] }
  ]
  // more text than one question record holds: four questions with long options
  const TOO_LONG: AskedQuestion[] = [1, 2, 3, 4].map((i) => ({
    question: `${i}${'q'.repeat(1999)}`,
    header: '',
    multiSelect: false,
    options: [
      { label: 'a', description: 'd'.repeat(500) },
      { label: 'b', description: 'd'.repeat(500) }
    ]
  }))

  /** tab-c coordinates acme and gives tab-1 a task that tab-1 has open: its turn has started; returns the task's id */
  const onTask = (w: World): string => {
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const task = records(w, 'task')[0]
    w.hub.handedOver('tab-1', [task], 'prompt')
    w.hub.turnStarted('tab-1')
    return task.id
  }

  it('a session on an open task asks: a question goes to its coordinator, the task waits on it, and the hook gets ASK_REASON', () => {
    const w = world()
    const taskId = onTask(w)
    expect(w.hub.ask('tab-1', QS)).toBe(ASK_REASON)
    const [q] = records(w, 'question')
    expect(q).toMatchObject({ from: { session: S.one }, to: { session: S.coord }, replyTo: taskId, questions: QS, text: questionsBody(QS), delivered: false })
    expect(w.store.hosted(S.one)!.tasks[0]).toMatchObject({ id: taskId, state: 'open', question: q!.id })
  })

  it('no question goes out, and null comes back, for the coordinator, a session without a task or with a queued one, questions that did not parse or do not fit a record, a coordinator whose tab is gone, or agent messages off', () => {
    const none = (w: World, tabId: string, questions: AskedQuestion[] | null): void => {
      expect(w.hub.ask(tabId, questions)).toBeNull()
      expect(records(w, 'question')).toEqual([])
    }
    let w = world()
    onTask(w)
    none(w, 'tab-c', QS)
    none(w, 'tab-2', QS)
    none(w, 'tab-1', null)
    none(w, 'tab-1', TOO_LONG)

    w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    none(w, 'tab-1', QS)

    w = world()
    onTask(w)
    w.tabs = w.tabs.filter((t) => t.tabId !== 'tab-c')
    none(w, 'tab-1', QS)

    w = world()
    onTask(w)
    update(w, 'tab-c', { exited: true })
    none(w, 'tab-1', QS)

    w = world()
    onTask(w)
    w.problem = PROBLEM
    none(w, 'tab-1', QS)
  })

  it("while its question waits, the task's turn end arms no settle and sends no progress note", () => {
    const w = world()
    onTask(w)
    w.hub.ask('tab-1', QS)
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'I wait for the answer.' })
    expect(w.timers).toEqual([])
    w.hub.turnEnded('tab-1', { background: true, lastMessage: 'I wait for the answer.' })
    expect(records(w, 'progress')).toEqual([])
    expect(records(w, 'report')).toEqual([])
  })

  it('a second question on the same task withdraws the first and waits on the second', () => {
    const w = world()
    onTask(w)
    expect(w.hub.ask('tab-1', QS)).toBe(ASK_REASON)
    expect(w.hub.ask('tab-1', QS)).toBe(ASK_REASON)
    const [first, second] = records(w, 'question')
    expect(records(w, 'withdraw')).toMatchObject([{ replyTo: first.id, text: WITHDRAW_TEXT, to: { session: S.coord } }])
    expect(w.store.hosted(S.one)!.tasks[0].question).toBe(second.id)
  })

  it("a second question that falls back to the tab's form withdraws the waiting one, and the task's turn end settles again", () => {
    const w = world()
    onTask(w)
    expect(w.hub.ask('tab-1', QS)).toBe(ASK_REASON)
    const [first] = records(w, 'question')
    w.problem = PROBLEM
    expect(w.hub.ask('tab-1', QS)).toBeNull()
    expect(records(w, 'question')).toHaveLength(1)
    expect(records(w, 'withdraw')).toMatchObject([{ replyTo: first.id, text: WITHDRAW_TEXT, to: { session: S.coord } }])
    expect(w.store.hosted(S.one)!.tasks[0].question).toBeNull()
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Asked in my tab.' })
    expect(w.timers.map((t) => t.ms)).toEqual([2000])
  })

  it('a turn end settles nothing while the stored task waits on its question, as after a restart', () => {
    const w = world()
    onTask(w)
    const h = w.store.hosted(S.one)!
    w.store.putHosted({ ...h, tasks: h.tasks.map((t) => ({ ...t, question: uid(0x9001) })) })
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'I wait for the answer.' })
    expect(w.timers).toEqual([])
    expect(records(w, 'report')).toEqual([])
  })

  it("a session's turn on its task gets the session's turn note; a session without a task gets none; the coordinator its own", () => {
    const w = world()
    onTask(w)
    expect(w.hub.turnNote('tab-1')).toBe(sessionTurnNoteText('coord · Desktop'))
    expect(w.hub.turnNote('tab-2')).toBeNull()
    expect(w.hub.turnNote('tab-c')).toBe(turnNoteText('acme'))
  })

  it('on a paired device the question goes to the coordinator only while its device is online, knows questions, coordinator records and mail', () => {
    const { s } = deviceWorlds()
    // Laptop's parser holds an open task of Studio's coordinator
    s.store.putHosted({
      session: L.one,
      coordinator: { device: DEV_C, session: S.coord, name: 'coord · Studio' },
      project: 'acme',
      former: [],
      tasks: [{ id: uid(0x5001), from: { device: DEV_C, session: S.coord, name: 'coord · Studio' }, state: 'open', queuedAt: NOW, deliveredAt: NOW, question: null }]
    })
    for (const over of [{ online: false }, { coord: false }, { questions: false }, { mail: false }]) {
      s.peers = [peerOf(DEV_C, 'Studio', over)]
      expect(s.hub.ask('tab-l1', QS)).toBeNull()
    }
    expect(records(s, 'question')).toEqual([])
    s.peers = [peerOf(DEV_C, 'Studio')]
    expect(s.hub.ask('tab-l1', QS)).toBe(ASK_REASON)
    expect(records(s, 'question')).toMatchObject([{ from: { device: DEV_S, session: L.one }, to: { device: DEV_C, session: S.coord }, questions: QS }])
  })
})

describe("the coordinator's side of a question", () => {
  const ASKED: AskedQuestion[] = [
    { question: 'Where should the browser live?', header: 'Place', multiSelect: false, options: [{ label: 'Side panel', description: 'Next to Changes.' }, { label: 'Own tab', description: '' }] },
    { question: 'Which parts?', header: '', multiSelect: true, options: [{ label: 'Browser', description: '' }, { label: 'Cookies', description: '' }] }
  ]

  /** tab-c coordinates acme with parser attached, and parser's tab holds an open task of it: its turn has started */
  const working = (w: World): void => {
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const task = records(w, 'task')[0]
    w.hub.handedOver('tab-1', [task], 'prompt')
    w.hub.turnStarted('tab-1')
  }

  /** a question from Laptop's parser to Studio's coordinator, as the other device's sync brings it */
  const remoteQuestion = (id: number, to: string): MailRecord => ({
    v: 1,
    id: uid(id),
    kind: 'question',
    from: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
    to: { device: null, session: to, name: 'coord · Desktop' },
    replyTo: uid(id + 1),
    text: questionsBody(ASKED),
    questions: ASKED,
    sentAt: NOW,
    delivered: false,
    read: false
  })

  it('a question pokes the coordinator\'s tab, and the session\'s row and the marks show it waiting', () => {
    const w = world()
    working(w)
    expect(w.hub.ask('tab-1', ASKED)).toBe(ASK_REASON)
    expect(w.pokes).toContain('tab-c')
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ group: 'waiting', why: 'question', line: 'Asks you: Where should the browser live?' })
    expect(w.hub.marks()['tab-c']).toEqual({ role: 'coordinator', project: 'acme', sessions: 1, waiting: 1 })
  })

  it("the coordinator's tab takes a question as a prompt or from its watcher; a session's tab does not, and no tab takes an answer", () => {
    const w = world()
    working(w)
    w.hub.ask('tab-1', ASKED)
    const [q] = records(w, 'question')
    expect(w.hub.accepts(q!, 'tab-c', 'prompt')).toBe(true)
    expect(w.hub.accepts(q!, 'tab-c', 'idle')).toBe(true)
    expect(w.hub.accepts(q!, 'tab-1', 'prompt')).toBe(false)
    expect(w.hub.accepts(q!, 'tab-1', 'idle')).toBe(false)
    const answer: MailRecord = { ...q!, id: uid(0x8001), kind: 'answer', replyTo: q!.id, answers: [{ question: 'Where should the browser live?', asked: 'Where should the browser live?', answer: 'Own tab' }] }
    for (const tabId of ['tab-c', 'tab-1']) {
      for (const into of ['idle', 'running', 'prompt'] as const) expect(w.hub.accepts(answer, tabId, into)).toBe(false)
    }
  })

  it('a question from another device is taken by the coordinator only while its session is attached to it', () => {
    const w = world()
    w.hub.make('tab-c', false)
    // the question is on record first: with no attachment it wakes nobody, and is marked delivered and read
    const q = remoteQuestion(0x7101, S.coord)
    w.mail.add(q)
    expect(w.mail.get(q.id)).toMatchObject({ delivered: true, read: true })
    expect(w.hub.accepts(q, 'tab-c', 'prompt')).toBe(false)
    attachDirect(w)
    const asked: MailRecord = { ...remoteQuestion(0x7103, S.coord), sentAt: NOW + 1 }
    w.mail.add(asked)
    expect(w.pokes).toContain('tab-c')
    expect(w.hub.accepts(asked, 'tab-c', 'prompt')).toBe(true)
  })

  it('read_session shows the question in full, and list_sessions says to ask it and pass it with answer_session', () => {
    const w = world()
    working(w)
    w.hub.ask('tab-1', ASKED)
    expect(w.hub.read('tab-c', 'a10000')).toEqual({ ok: true, info: expect.stringContaining(`Waiting for the person's answer to its question:\n${questionsBody(ASKED)}`) })
    expect(w.hub.list('tab-c')).toEqual({
      ok: true,
      info: expect.stringContaining('- A question from parser · Desktop waits for the person: ask it with AskUserQuestion (read_session shows it), then pass the answers with answer_session.')
    })
  })

  it('a withdraw marks a question the coordinator has not taken delivered and read, and the row leaves Waiting on you', () => {
    const w = world()
    working(w)
    w.hub.ask('tab-1', ASKED)
    const [q] = records(w, 'question')
    // the person answers in the session's own tab: its form takes the place of the question
    expect(w.hub.ask('tab-1', null)).toBeNull()
    expect(records(w, 'withdraw')).toMatchObject([{ replyTo: q!.id, to: { session: S.coord } }])
    expect(w.mail.get(q!.id)).toMatchObject({ delivered: true, read: true })
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ group: 'working', why: null })
    expect(w.hub.marks()['tab-c']).toEqual({ role: 'coordinator', project: 'acme', sessions: 1, waiting: 0 })
  })

  it("a report on the task, a new task of the coordinator, or a newer question closes the question on the coordinator's side", () => {
    let w = world()
    working(w)
    w.hub.ask('tab-1', ASKED)
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ why: 'question' })
    w.hub.interrupted('tab-1')
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ group: 'idle', why: null, line: 'Stopped by you' })

    w = world()
    working(w)
    w.hub.ask('tab-1', ASKED)
    w.now += 1000
    w.hub.message('tab-c', 'a10000', 'Also check the tests.')
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ group: 'working', why: null })

    w = world()
    working(w)
    w.hub.ask('tab-1', ASKED)
    w.now += 1000
    w.hub.ask('tab-1', [ASKED[1]!])
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ group: 'waiting', why: 'question', line: 'Asks you: Which parts?' })
  })

  it('a withdraw that came before its question wakes no tab, and accepts refuses the question', () => {
    const w = world()
    w.hub.make('tab-c', false)
    attachDirect(w)
    const q = remoteQuestion(0x7301, S.coord)
    const withdraw: MailRecord = { v: 1, id: uid(0x7303), kind: 'withdraw', from: q.from, to: q.to, replyTo: q.id, text: WITHDRAW_TEXT, sentAt: NOW, delivered: false, read: false }
    w.mail.add(withdraw)
    w.pokes.length = 0
    w.mail.add(q)
    expect(w.pokes).toEqual([])
    expect(w.mail.get(q.id)).toMatchObject({ delivered: true, read: true })
    expect(w.hub.accepts(q, 'tab-c', 'prompt')).toBe(false)
    expect(w.hub.view('tab-c')!.waiting).toBe(0)
  })

  it('a withdrawal from another session or another device does not close or mark the question', () => {
    const w = world()
    working(w)
    w.hub.ask('tab-1', ASKED)
    const [q] = records(w, 'question')
    const forged = (id: number, from: MailRecord['from']): MailRecord => ({ v: 1, id: uid(id), kind: 'withdraw', from, to: { device: null, session: S.coord, name: 'coord · Desktop' }, replyTo: q!.id, text: WITHDRAW_TEXT, sentAt: NOW + 1, delivered: false, read: false })
    w.mail.add(forged(0x7401, { device: null, session: S.two, name: 'docs · Desktop' }))
    w.mail.add(forged(0x7402, { device: DEV_S, session: S.one, name: 'parser · Desktop' }))
    expect(w.mail.get(q!.id)).toMatchObject({ delivered: false, read: false })
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ group: 'waiting', why: 'question', line: 'Asks you: Where should the browser live?' })
  })

  it('a question forwarded to a former id keeps the original id: a withdraw of the original closes the row', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.make('tab-2', true)
    // Laptop's parser is attached to the current coordinator, tab-2's session
    const c = w.store.coordinator(S.two)!
    w.store.putCoordinator({ ...c, attachments: [{ device: DEV_S, session: L.one, name: 'parser · Laptop', attachedAt: NOW, resolved: false, failed: false, lastReport: null, pending: null, former: [] }] })
    const q = remoteQuestion(0x7501, S.coord)
    w.mail.add(q)
    expect(records(w, 'question').filter((r) => r.id !== q.id)).toHaveLength(1)
    expect(w.hub.view('tab-2')!.sessions[0]).toMatchObject({ group: 'waiting', why: 'question' })
    const withdraw: MailRecord = { v: 1, id: uid(0x7503), kind: 'withdraw', from: q.from, to: { device: null, session: S.two, name: 'coord · Desktop' }, replyTo: q.id, text: WITHDRAW_TEXT, sentAt: NOW + 1, delivered: false, read: false }
    w.mail.add(withdraw)
    expect(w.hub.view('tab-2')!.sessions[0]).toMatchObject({ group: 'idle', why: null })
  })

  it('a question whose task got its report before the coordinator took it wakes nobody', () => {
    const w = world()
    w.hub.make('tab-c', false)
    attachDirect(w)
    const q = remoteQuestion(0x7601, S.coord)
    const report: MailRecord = { v: 1, id: uid(0x7603), kind: 'report', from: q.from, to: q.to, replyTo: q.replyTo, outcome: 'finished', text: 'Parser fixed.', sentAt: NOW, delivered: false, read: false }
    w.mail.add(report)
    w.pokes.length = 0
    w.mail.add(q)
    expect(w.pokes).toEqual([])
    expect(w.mail.get(q.id)).toMatchObject({ delivered: true, read: true })
    expect(w.hub.accepts(q, 'tab-c', 'prompt')).toBe(false)
  })

  it('a forwarded copy of a withdrawn question wakes nobody and is not taken', () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.make('tab-2', true)
    // Laptop's parser is attached to the current coordinator, tab-2's session
    const c = w.store.coordinator(S.two)!
    w.store.putCoordinator({ ...c, attachments: [{ device: DEV_S, session: L.one, name: 'parser · Laptop', attachedAt: NOW, resolved: false, failed: false, lastReport: null, pending: null, former: [] }] })
    const q = remoteQuestion(0x7701, S.coord)
    w.mail.add(q)
    const [copy] = records(w, 'question').filter((r) => r.id !== q.id)
    const withdraw: MailRecord = { v: 1, id: uid(0x7703), kind: 'withdraw', from: q.from, to: { device: null, session: S.coord, name: 'coord · Desktop' }, replyTo: q.id, text: WITHDRAW_TEXT, sentAt: NOW + 1, delivered: false, read: false }
    w.mail.add(withdraw)
    // the copy of the same question arrives from another device after its withdrawal
    const late: MailRecord = { ...copy!, id: uid(0x7705) }
    w.pokes.length = 0
    w.mail.add(late)
    expect(w.pokes).toEqual([])
    expect(w.mail.get(late.id)).toMatchObject({ delivered: true, read: true })
    expect(w.hub.accepts(copy!, 'tab-2', 'prompt')).toBe(false)
  })

  it('a question to a former id of the coordinator is forwarded to its current one', () => {
    const w = world()
    w.hub.make('tab-c', false)
    // tab-2 replaces tab-c as the project's coordinator: S.coord is its former id
    w.hub.make('tab-2', true)
    const q = remoteQuestion(0x7201, S.coord)
    w.mail.add(q)
    expect(w.mail.get(q.id)).toMatchObject({ delivered: true, read: true })
    expect(records(w, 'question').filter((r) => r.id !== q.id)).toMatchObject([{ from: { device: DEV_S, session: L.one }, to: { session: S.two }, replyTo: q.replyTo, questions: ASKED }])
  })
})

describe("answer_session: the person's answers from the coordinator's question form", () => {
  const QS: AskedQuestion[] = [
    { question: 'Where should the browser live?', header: 'Place', multiSelect: false, options: [{ label: 'Side panel', description: 'Next to Changes.' }, { label: 'Own tab', description: '' }] },
    { question: 'Which parts?', header: '', multiSelect: true, options: [{ label: 'Browser', description: '' }, { label: 'Cookies', description: '' }] }
  ]
  // two questions with texts and answers so long that the answer record does not fit a mail record
  const LONG: AskedQuestion[] = [1, 2].map((i) => ({ question: `${i}${'q'.repeat(1999)}`, header: '', multiSelect: false, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] }))
  const PARSER = 'parser · Desktop'
  const WHERE = 'Where should the browser live?'
  const PARTS = 'Which parts?'
  const NONE_IN_FORM = `These questions are not in your question form since the session asked: «${WHERE}», «${PARTS}». Pass each one exactly as you wrote it in AskUserQuestion. Ask the person with AskUserQuestion first.`

  /** tab-c coordinates acme with parser attached, and parser's tab holds an open task of it: its turn has started */
  const onTask = (w: World): void => {
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const task = records(w, 'task')[0]
    w.hub.handedOver('tab-1', [task], 'prompt')
    w.hub.turnStarted('tab-1')
  }

  /** parser's tab asks qs on its open task: the question record */
  const asking = (w: World, qs: AskedQuestion[] = QS): MailRecord => {
    onTask(w)
    expect(w.hub.ask('tab-1', qs)).toBe(ASK_REASON)
    return records(w, 'question')[0]
  }

  const answer = (w: World, questions: string[]) => w.hub.tool('tab-c', { op: 'answer', session: 'a10000', questions })

  it("passes the person's answers from the coordinator's form: an answer record to the session, a toast, a poke, and the info", async () => {
    const w = world()
    const q = asking(w)
    formed(w, [[`parser: ${WHERE}`, 'Side panel'], [`parser: ${PARTS}`, 'Browser, Cookies']])
    expect(await answer(w, [`parser: ${WHERE}`, `parser: ${PARTS}`])).toEqual({ ok: true, info: HUB_TEXT.answered(PARSER) })
    expect(records(w, 'answer')).toMatchObject([
      {
        from: { session: S.coord },
        to: { session: S.one },
        replyTo: q.id,
        text: `1. ${WHERE}\n   The person answered: Side panel\n2. ${PARTS}\n   The person answered: Browser, Cookies`,
        answers: [
          { question: WHERE, asked: `parser: ${WHERE}`, answer: 'Side panel' },
          { question: PARTS, asked: `parser: ${PARTS}`, answer: 'Browser, Cookies' }
        ]
      }
    ])
    expect(w.toasts).toEqual([`Your answer went to ${PARSER}: «Side panel»`])
    expect(w.pokes).toContain('tab-1')
    expect(w.order).toContain('changed')
  })

  it('answers the questions of two sessions from one form: each answer goes to its own session', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.attach('tab-c', 'b20000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    w.hub.message('tab-c', 'b20000', 'Fix the docs.')
    const tasks = records(w, 'task')
    w.hub.handedOver('tab-1', [tasks.find((t) => t.to.session === S.one)!], 'prompt')
    w.hub.turnStarted('tab-1')
    w.hub.handedOver('tab-2', [tasks.find((t) => t.to.session === S.two)!], 'prompt')
    w.hub.turnStarted('tab-2')
    expect(w.hub.ask('tab-1', [QS[0]!])).toBe(ASK_REASON)
    expect(w.hub.ask('tab-2', [QS[1]!])).toBe(ASK_REASON)
    const questions = records(w, 'question')
    formed(w, [[`parser: ${WHERE}`, 'Side panel'], [`docs: ${PARTS}`, 'Cookies']])
    expect(await w.hub.tool('tab-c', { op: 'answer', session: 'a10000', questions: [`parser: ${WHERE}`] })).toEqual({ ok: true, info: HUB_TEXT.answered(PARSER) })
    expect(await w.hub.tool('tab-c', { op: 'answer', session: 'b20000', questions: [`docs: ${PARTS}`] })).toEqual({ ok: true, info: HUB_TEXT.answered('docs · Desktop') })
    expect(records(w, 'answer')).toMatchObject([
      { to: { session: S.one }, replyTo: questions.find((q) => q.from.session === S.one)!.id, answers: [{ question: WHERE, asked: `parser: ${WHERE}`, answer: 'Side panel' }] },
      { to: { session: S.two }, replyTo: questions.find((q) => q.from.session === S.two)!.id, answers: [{ question: PARTS, asked: `docs: ${PARTS}`, answer: 'Cookies' }] }
    ])
  })

  it('refuses, and writes no answer, when no question waits for one, nor a tab that is not a coordinator', async () => {
    const w = world()
    onTask(w)
    formed(w, [[WHERE, 'Side panel']])
    expect(await answer(w, [WHERE])).toEqual({ ok: false, error: HUB_TEXT.noQuestion(PARSER) })
    expect(await w.hub.tool('tab-1', { op: 'answer', session: 'a10000', questions: [WHERE] })).toEqual({ ok: false, error: HUB_TEXT.notCoordinator })
    expect(records(w, 'answer')).toEqual([])
  })

  it('refuses a second answer to a question that is answered already', async () => {
    const w = world()
    asking(w)
    formed(w, [[WHERE, 'Side panel'], [PARTS, 'Cookies']])
    expect(await answer(w, [WHERE, PARTS])).toMatchObject({ ok: true })
    expect(await answer(w, [WHERE, PARTS])).toEqual({ ok: false, error: HUB_TEXT.noQuestion(PARSER) })
    expect(records(w, 'answer')).toHaveLength(1)
  })

  it("refuses with answeredInTab when the person answered the question in the session's tab", async () => {
    const w = world()
    asking(w)
    formed(w, [[WHERE, 'Side panel'], [PARTS, 'Cookies']])
    // the person answers in the session's own tab: its form takes the place of the question
    expect(w.hub.ask('tab-1', null)).toBeNull()
    expect(await answer(w, [WHERE, PARTS])).toEqual({ ok: false, error: HUB_TEXT.answeredInTab(PARSER) })
    expect(records(w, 'answer')).toEqual([])
  })

  it('refuses, and writes no answer, when the session is detached while the coordinator\'s form is read', async () => {
    const w = world()
    asking(w)
    formed(w, [[WHERE, 'Side panel'], [PARTS, 'Cookies']])
    const pending = answer(w, [WHERE, PARTS])
    w.hub.detach('tab-c', 'a10000')
    const refused = await answer(w, [WHERE, PARTS])
    expect(refused).toMatchObject({ ok: false })
    expect(await pending).toEqual(refused)
    expect(records(w, 'answer')).toEqual([])
  })

  it('refuses when the question is closed while the coordinator\'s form is read', async () => {
    const w = world()
    asking(w)
    formed(w, [[WHERE, 'Side panel'], [PARTS, 'Cookies']])
    const pending = answer(w, [WHERE, PARTS])
    w.hub.ask('tab-1', null)
    expect(await pending).toEqual({ ok: false, error: HUB_TEXT.answeredInTab(PARSER) })
    expect(records(w, 'answer')).toEqual([])
  })

  it("refuses a count of questions that is not the session's, and names the count", async () => {
    const w = world()
    asking(w)
    formed(w, [[WHERE, 'Side panel'], [PARTS, 'Cookies']])
    expect(await answer(w, [WHERE])).toEqual({ ok: false, error: HUB_TEXT.questionCount(PARSER, 2) })
    expect(await answer(w, [WHERE, PARTS, PARTS])).toEqual({ ok: false, error: HUB_TEXT.questionCount(PARSER, 2) })
    expect(HUB_TEXT.questionCount(PARSER, 2)).toBe(`${PARSER} asked 2 questions: pass 2 in questions, one for each, in their order.`)
    expect(records(w, 'answer')).toEqual([])
  })

  it('refuses a question that is not in the form, and says what the form holds', async () => {
    const w = world()
    asking(w)
    formed(w, [[WHERE, 'Side panel']])
    expect(await answer(w, [WHERE, PARTS])).toEqual({
      ok: false,
      error: `These questions are not in your question form since the session asked: «${PARTS}». Pass each one exactly as you wrote it in AskUserQuestion. Your form holds: «${WHERE}».`
    })
    expect(records(w, 'answer')).toEqual([])
  })

  it('refuses when the form holds none of the questions, and when its only form is older than the question', async () => {
    const w = world()
    asking(w)
    expect(await answer(w, [WHERE, PARTS])).toEqual({ ok: false, error: NONE_IN_FORM })
    formed(w, [[WHERE, 'Side panel'], [PARTS, 'Cookies']], { at: NOW - FORM_SLACK_MS - 1 })
    expect(await answer(w, [WHERE, PARTS])).toEqual({ ok: false, error: NONE_IN_FORM })
    expect(records(w, 'answer')).toEqual([])
  })

  it('refuses answers too long for one mail record', async () => {
    const w = world()
    asking(w, LONG)
    formed(w, [[LONG[0]!.question, 'a'.repeat(2000)], [LONG[1]!.question, 'a'.repeat(2000)]])
    expect(await answer(w, LONG.map((q) => q.question))).toEqual({ ok: false, error: HUB_TEXT.answersTooLong })
    expect(records(w, 'answer')).toEqual([])
  })

  it('the HUB_TEXT copy of the answer refusals and the toast', () => {
    expect(HUB_TEXT.noQuestion('parser · Desktop')).toBe('parser · Desktop has no question waiting for an answer.')
    expect(HUB_TEXT.answeredInTab('parser · Desktop')).toBe("The person answered parser · Desktop's question in its tab already; nothing was sent.")
    expect(HUB_TEXT.questionCount('parser · Desktop', 1)).toBe('parser · Desktop asked 1 question: pass 1 in questions, one for each, in their order.')
    expect(HUB_TEXT.answersTooLong).toBe('The answers are too long to pass on; give them with message_session.')
    expect(HUB_TEXT.answerToast('parser · Desktop', 'Side panel')).toBe('Your answer went to parser · Desktop: «Side panel»')
  })
})

describe('the answer reaches the session, and the wait ends', () => {
  const QS: AskedQuestion[] = [
    { question: 'Where should the browser live?', header: 'Place', multiSelect: false, options: [{ label: 'Side panel', description: 'Next to Changes.' }, { label: 'Own tab', description: '' }] },
    { question: 'Which parts?', header: '', multiSelect: true, options: [{ label: 'Browser', description: '' }, { label: 'Cookies', description: '' }] }
  ]
  const PARSER = 'parser · Desktop'
  const WHERE = 'Where should the browser live?'
  const PARTS = 'Which parts?'
  const sender = () => ({ folder: null, branch: null })

  /** tab-c coordinates acme with parser attached, and parser's tab holds an open task of it: its turn has started */
  const onTask = (w: World): void => {
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    const task = records(w, 'task')[0]
    w.hub.handedOver('tab-1', [task], 'prompt')
    w.hub.turnStarted('tab-1')
  }

  /** parser's tab asks QS on its open task, and its turn ends: the session waits for the answer */
  const asking = (w: World): MailRecord => {
    onTask(w)
    expect(w.hub.ask('tab-1', QS)).toBe(ASK_REASON)
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Which one?' })
    return records(w, 'question')[0]!
  }

  /** the person answers the form, and the coordinator passes the answers to parser: the answer record */
  const answered = async (w: World): Promise<MailRecord> => {
    formed(w, [[`parser: ${WHERE}`, 'Side panel'], [`parser: ${PARTS}`, 'Browser, Cookies']])
    expect(await w.hub.tool('tab-c', { op: 'answer', session: 'a10000', questions: [`parser: ${WHERE}`, `parser: ${PARTS}`] })).toMatchObject({ ok: true })
    return records(w, 'answer')[0]!
  }

  it('the answer is typed into the idle session: canTakeWords, then takeWords gives answersText, the question closes, and the next turn\'s end reports', async () => {
    const w = world()
    asking(w)
    const task = records(w, 'task')[0]!
    const answer = await answered(w)
    expect(w.timers).toEqual([])
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(true)
    const taken = w.hub.takeWords('tab-1', S.one)
    expect(taken).toEqual({ info: answersText(answer, sender) })
    expect(records(w, 'answer')[0]).toMatchObject({ delivered: true })
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ id: task.id, question: null }])
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)

    w.hub.turnStarted('tab-1', taken!.info)
    expect(records(w, 'withdraw')).toEqual([])
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Parser fixed.' })
    expect(w.timers.map((t) => t.ms)).toEqual([2000])
    fire(w)
    expect(records(w, 'report')).toMatchObject([{ outcome: 'finished', replyTo: task.id, to: { session: S.coord } }])
  })

  it('a turn of the person closes the question: a withdraw goes, and answer_session is refused as answered in its tab', async () => {
    const w = world()
    const question = asking(w)
    formed(w, [[`parser: ${WHERE}`, 'Side panel'], [`parser: ${PARTS}`, 'Cookies']])
    w.hub.turnStarted('tab-1', 'Use the side panel.')
    expect(records(w, 'withdraw')).toMatchObject([{ replyTo: question.id, from: { session: S.one }, to: { session: S.coord } }])
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ question: null }])
    expect(await w.hub.tool('tab-c', { op: 'answer', session: 'a10000', questions: [`parser: ${WHERE}`, `parser: ${PARTS}`] })).toEqual({ ok: false, error: HUB_TEXT.answeredInTab(PARSER) })
    expect(records(w, 'answer')).toEqual([])
  })

  it('a turn of the person while the answer waits to be typed: the answer is dropped, never typed', async () => {
    const w = world()
    const question = asking(w)
    const answer = await answered(w)
    w.hub.turnStarted('tab-1', 'my own words')
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)
    expect(w.hub.takeWords('tab-1', S.one)).toBeNull()
    expect(records(w, 'answer')).toMatchObject([{ id: answer.id, delivered: true, read: true }])
    expect(w.infos).toContain(`coordinator: the answer to ${question.id} came after the person took over in ${S.one}'s tab; it is dropped`)
  })

  it('turns that are not the person\'s leave the question waiting: a wake block, an auto-continue prompt, a task notification, no prompt at all', () => {
    const others = [
      `${TASK_WAKE_HEAD} the user's instruction, given through their coordinator.\n\n> Fix the parser.`,
      CONTINUE_PROMPT,
      '<task-notification>\n<task-id>b1</task-id>\n</task-notification>',
      null
    ]
    for (const prompt of others) {
      const w = world()
      const question = asking(w)
      w.hub.turnStarted('tab-1', prompt)
      expect(records(w, 'withdraw')).toEqual([])
      expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ question: question.id }])
    }
  })

  it('a task given while a question waits ends the wait: the open task goes without a report, and the new task is next', () => {
    const w = world()
    asking(w)
    const first = records(w, 'task')[0]!
    w.hub.message('tab-c', 'a10000', 'Also the docs.')
    const second = records(w, 'task')[1]!
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ id: second.id, state: 'queued' }])
    expect(records(w, 'report')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks.some((t) => t.id === first.id)).toBe(false)
    expect(w.hub.accepts(second, 'tab-1', 'idle')).toBe(true)
  })

  it('an answer for no waiting question is dropped and logged', () => {
    const w = world()
    const question = asking(w)
    const stale: MailRecord = {
      v: 1,
      id: uid(0x8002),
      kind: 'answer',
      from: { device: null, session: S.coord, name: 'coord · Desktop' },
      to: { device: null, session: S.one, name: PARSER },
      replyTo: uid(0x8003),
      text: 'stale',
      answers: [{ question: WHERE, asked: `parser: ${WHERE}`, answer: 'Own tab' }],
      sentAt: NOW,
      delivered: false,
      read: false
    }
    w.mail.add(stale)
    expect(w.hub.canTakeWords('tab-1', S.one)).toBe(false)
    expect(records(w, 'answer')).toMatchObject([{ id: stale.id, delivered: true, read: true }])
    expect(w.infos).toContain(`coordinator: an answer to ${uid(0x8003)} came for no waiting question of ${S.one}; it is dropped`)
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ question: question.id }])
  })

  it('a hub on the same store types the answer after a restart', async () => {
    const w = world()
    asking(w)
    const answer = await answered(w)
    w.store.flush()
    w.mail.flush()
    const again = world({ dir: w.dir })
    expect(again.hub.canTakeWords('tab-1', S.one)).toBe(true)
    expect(again.hub.takeWords('tab-1', S.one)).toEqual({ info: answersText(answer, sender) })
  })
})

describe('a session takes a new id while its question waits', () => {
  const QS: AskedQuestion[] = [
    { question: 'Where should the browser live?', header: 'Place', multiSelect: false, options: [{ label: 'Side panel', description: 'Next to Changes.' }, { label: 'Own tab', description: '' }] }
  ]
  const WHERE = 'Where should the browser live?'
  const PARSER = 'parser · Desktop'
  const RESUMED = 'a3000000-0000-4000-8000-000000000031'
  const sender = () => ({ folder: null, branch: null })

  /** tab-c coordinates acme with parser attached; parser's tab asks QS on its open task, and its turn ends */
  const asking = (w: World): void => {
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.hub.message('tab-c', 'a10000', 'Fix the parser.')
    w.hub.handedOver('tab-1', [records(w, 'task')[0]!], 'prompt')
    w.hub.turnStarted('tab-1')
    expect(w.hub.ask('tab-1', QS)).toBe(ASK_REASON)
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Which one?' })
  }

  /** parser's tab resumes under a new session id, as a restored tab does */
  const resumed = (w: World): void => {
    update(w, 'tab-1', { session: RESUMED })
    w.hub.sessionStarted('tab-1', S.one, RESUMED, 'resume')
  }

  it("the coordinator's row still asks, answer_session is ok, and the tab types the answer under its new id", async () => {
    const w = world()
    asking(w)
    resumed(w)
    expect(w.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ session: RESUMED, former: [S.one] })
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ group: 'waiting', why: 'question', line: `Asks you: ${WHERE}` })
    formed(w, [[`parser: ${WHERE}`, 'Side panel']])
    expect(await w.hub.tool('tab-c', { op: 'answer', session: refOf(RESUMED), questions: [`parser: ${WHERE}`] })).toEqual({ ok: true, info: HUB_TEXT.answered(PARSER) })
    expect(w.hub.canTakeWords('tab-1', RESUMED)).toBe(true)
    expect(w.hub.takeWords('tab-1', RESUMED)).toEqual({ info: answersText(records(w, 'answer')[0]!, sender) })
    expect(w.store.hosted(RESUMED)!.tasks).toMatchObject([{ question: null }])
  })

  it('an answer given before the new id is typed under it: the rename does not strand it', async () => {
    const w = world()
    asking(w)
    formed(w, [[`parser: ${WHERE}`, 'Side panel']])
    expect(await w.hub.tool('tab-c', { op: 'answer', session: 'a10000', questions: [`parser: ${WHERE}`] })).toMatchObject({ ok: true })
    resumed(w)
    expect(w.hub.canTakeWords('tab-1', RESUMED)).toBe(true)
    expect(w.hub.takeWords('tab-1', RESUMED)).toEqual({ info: answersText(records(w, 'answer')[0]!, sender) })
  })

  it("the person's turn in the renamed tab withdraws the question the coordinator waits on", () => {
    const w = world()
    asking(w)
    const [q] = records(w, 'question')
    resumed(w)
    w.hub.turnStarted('tab-1', 'Use the side panel.')
    expect(records(w, 'withdraw')).toMatchObject([{ replyTo: q!.id, from: { session: RESUMED }, to: { session: S.coord } }])
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ group: 'working', why: null })
    expect(w.mail.get(q!.id)).toMatchObject({ delivered: true, read: true })
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
        '- As the coordinator, give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to; your own subagents (the Agent tool) are only for looking things up while you plan.'
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

  it('a Stop with background work sends a progress note at once with the answer; the task stays open and its report comes at the end', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.pokes.length = 0
    w.hub.turnEnded('tab-1', { background: true, lastMessage: "Tests run in the background; I wait for the person's go to push." })
    expect(records(w, 'progress')).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ session: S.one }),
        to: expect.objectContaining({ session: S.coord }),
        replyTo: task.id,
        text: "Tests run in the background; I wait for the person's go to push.",
        delivered: false,
        read: false
      })
    ])
    expect(w.store.hosted(S.one)!.tasks).toMatchObject([{ id: task.id, state: 'open' }])
    expect(w.timers).toEqual([])
    expect(records(w, 'report')).toEqual([])
    expect(w.pokes).toContain('tab-c')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Pushed.' })
    fire(w)
    expect(records(w, 'report')).toMatchObject([{ outcome: 'finished', text: 'Pushed.' }])
    expect(records(w, 'progress')).toHaveLength(1)
  })

  it('the same answer at the next background Stop sends no second note; a new answer sends one', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: 'Waiting for the tests.' })
    w.hub.turnStarted('tab-1')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: '  Waiting for the tests.\n' })
    expect(records(w, 'progress').map((r) => r.text)).toEqual(['Waiting for the tests.'])
    w.hub.turnStarted('tab-1')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: '3 of 5 suites pass.' })
    expect(records(w, 'progress').map((r) => r.text)).toEqual(['Waiting for the tests.', '3 of 5 suites pass.'])
  })

  it('an answer that returns to an earlier one after a different note is sent again', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: 'Waiting for the tests.' })
    w.hub.turnStarted('tab-1')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: '3 of 5 suites pass.' })
    w.hub.turnStarted('tab-1')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: 'Waiting for the tests.' })
    expect(records(w, 'progress').map((r) => r.text)).toEqual(['Waiting for the tests.', '3 of 5 suites pass.', 'Waiting for the tests.'])
  })

  it('no note for a Stop without an answer, for a task not open yet, or without background work', () => {
    w.hub.handedOver('tab-1', [task], 'prompt')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: 'An answer of the turn before the task.' })
    w.hub.turnStarted('tab-1')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: null })
    w.hub.turnEnded('tab-1', { background: true, lastMessage: '   ' })
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Done.' })
    expect(records(w, 'progress')).toEqual([])
  })

  it("the session's row shows its latest progress note while the task is open; the report's line follows it", () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.order.length = 0
    w.hub.turnEnded('tab-1', { background: true, lastMessage: "Tests run in the background.\nI wait for the person's go." })
    expect(w.order).toContain('changed')
    expect(w.hub.view('tab-c')!.sessions[0]).toMatchObject({ line: 'Background work · Tests run in the background.', group: 'working' })
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Pushed.' })
    fire(w)
    expect(w.hub.view('tab-c')!.sessions[0].line).toBe('Finished · report ready')
  })

  it('a progress note is mail for the coordinator: a watcher takes it, a prompt carries it, and no other tab takes it as a prompt', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: 'Waiting for the tests.' })
    const note = records(w, 'progress')[0]
    expect(w.hub.accepts(note, 'tab-c', 'idle')).toBe(true)
    expect(w.hub.accepts(note, 'tab-c', 'running')).toBe(true)
    expect(w.hub.accepts(note, 'tab-c', 'prompt')).toBe(true)
    expect(w.hub.accepts(note, 'tab-2', 'prompt')).toBe(false)
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

  it("a restart in the task's turn keeps the task open: the restarted session's rest reports the answer it goes on to give", () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.restarting('tab-1')
    expect(records(w, 'report')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')
    w.hub.turnStarted('tab-1')
    w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Parser fixed after the restart.' })
    fire(w)
    expect(records(w, 'report')).toMatchObject([{ outcome: 'finished', replyTo: task.id, text: 'Parser fixed after the restart.' }])
    expect(w.store.hosted(S.one)!.tasks).toEqual([])
  })

  it('a restart ends the turn the tab was in: a queued task is taken at rest again', () => {
    w.hub.turnStarted('tab-1')
    expect(w.hub.accepts(task, 'tab-1', 'idle')).toBe(false)
    w.hub.restarting('tab-1')
    expect(w.hub.accepts(task, 'tab-1', 'idle')).toBe(true)
  })

  it('a restart that starts another conversation stops the task whose turn it cut; with no turn cut it stops nothing', () => {
    w.hub.handedOver('tab-1', [task], 'idle')
    w.hub.turnEnded('tab-1', { background: true, lastMessage: null })
    w.hub.restarting('tab-1')
    w.hub.newConversation('tab-1')
    expect(records(w, 'report')).toEqual([])
    expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')

    w.hub.turnStarted('tab-1')
    w.hub.restarting('tab-1')
    w.hub.newConversation('tab-1')
    expect(records(w, 'report')).toMatchObject([{ outcome: 'stopped', reason: 'its turn was interrupted', replyTo: task.id }])
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

  it("words of a start that ends before its session comes: no toast, and the same words still go to a session", async () => {
    const w = world()
    w.hub.make('tab-c', false)
    TITLES['new-tab-1'] = 'Release notes'
    said(w, 'Write them now.')
    const cancelled = w.hub.start('tab-c', { ...START, words: 'Write them now.' })
    await tick()
    w.hub.tabClosed('new-tab-1')
    expect(await cancelled).toEqual({ ok: false, error: HUB_TEXT.closedEarly })
    expect(w.toasts).toEqual([])
    // the words went nowhere: a session of the coordinator takes the same message through message_session
    const again = w.hub.start('tab-c', START)
    await tick()
    showSession(w, 'new-tab-2', S_NEW)
    expect(await again).toMatchObject({ ok: true })
    expect(await w.hub.tool('tab-c', { op: 'message', session: refOf(S_NEW), text: 'And publish them.', words: 'Write them now.' })).toMatchObject({ ok: true })
    expect(w.toasts).toHaveLength(1)
    expect(records(w, 'task').map((r) => r.words)).toEqual([undefined, 'Write them now.'])
  })

  it("a start with words whose wait runs out answers that it is opening, without saying the words went with its task", async () => {
    const w = world()
    w.hub.make('tab-c', false)
    TITLES['new-tab-1'] = 'Release notes'
    said(w, 'Write them now.')
    const waiting = w.hub.start('tab-c', { ...START, words: 'Write them now.' })
    await tick()
    fire(w)
    const opening = await waiting
    expect(opening).toMatchObject({ ok: true, info: expect.stringContaining('Opening Release notes') })
    expect(opening.ok && opening.info).not.toContain(HUB_TEXT.withWords)
  })

  it('a start with words whose session comes in time says the words go with its task', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    TITLES['new-tab-1'] = 'Release notes'
    said(w, 'Write them now.')
    const answer = w.hub.start('tab-c', { ...START, words: 'Write them now.' })
    await tick()
    showSession(w, 'new-tab-1', S_NEW)
    expect(await answer).toEqual({ ok: true, info: expect.stringContaining(HUB_TEXT.withWords) })
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

  it('a session started with a worktree is told to stop and report when EnterWorktree fails, not to make the worktree some other way', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    const answer = w.hub.start('tab-c', { ...START, worktree: 'notes' })
    await tick()
    showSession(w, 'new-tab-1', S_NEW)
    await answer
    const text = records(w, 'task')[0].text
    expect(text).toContain('If EnterWorktree fails, do not create a worktree any other way (`git worktree add`, `cd`, …)')
    expect(text).toContain("stop and report the error as this task's result")
    expect(text.indexOf('EnterWorktree fails')).toBeLessThan(text.indexOf('Write the release notes.'))
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
  it("with the person's words: they are checked before any tab opens; the toast names the new session, and its first task carries them", async () => {
    const w = world()
    w.hub.make('tab-c', false)
    TITLES['new-tab-1'] = 'Release notes'
    said(w, 'Write them now.')
    const answer = w.hub.start('tab-c', { ...START, words: 'Write them now.' })
    await tick()
    await tick()
    expect(w.opened).toHaveLength(1)
    // the toast comes when the task's record is written, not before the session is there
    expect(w.toasts).toEqual([])
    showSession(w, 'new-tab-1', S_NEW)
    expect(await answer).toEqual({ ok: true, info: expect.stringMatching(/ The person's words go with its task\.$/) })
    expect(w.toasts).toEqual(['Your words went to Release notes: «Write them now.»'])
    expect(records(w, 'task')).toEqual([expect.objectContaining({ to: expect.objectContaining({ session: S_NEW }), text: 'Write the release notes.', words: 'Write them now.', context: 'Shall I merge feat/x into master?' })])
    // the same message cannot go to that session a second time
    expect(await w.hub.tool('tab-c', { op: 'message', session: refOf(S_NEW), text: 'And publish them.', words: 'Write them now.' }))
      .toEqual({ ok: false, error: HUB_TEXT.wordsAgain('Release notes · Desktop') })
  })

  it("words that are not the person's latest message refuse the start before any tab opens", async () => {
    const w = world()
    w.hub.make('tab-c', false)
    said(w, 'Write them now.')
    expect(await w.hub.start('tab-c', { ...START, words: 'Write them later.' })).toEqual({ ok: false, error: HUB_TEXT.wordsNotPerson })
    expect(w.opened).toEqual([])
    expect(w.toasts).toEqual([])
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
  const EMPTY = 'You coordinate acme in ClaudeTerm: give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to; your own subagents (the Agent tool) are only for looking things up while you plan. Write to the person in the language of their own messages, even when reports, notes and tool results are in English, and write the tasks you give sessions in it too: the person reads them in the sessions\' tabs. No sessions are attached yet: attach one with attach_session, or start one with start_session.'
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
      BLOCK(`You coordinate acme in ClaudeTerm: give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to; your own subagents (the Agent tool) are only for looking things up while you plan. Write to the person in the language of their own messages, even when reports, notes and tool results are in English, and write the tasks you give sessions in it too: the person reads them in the sessions' tabs. 1 session (${row.name} — ${row.line}). Reports come by themselves when a task ends; use list_sessions for more.`)
    )
  })
})

describe("the chip's coordinator start", () => {
  const S_CHIP = 'd5000000-0000-4000-8000-000000000006'
  /** the folder of the group's tab the chip names: a linked worktree of acme */
  const WT = 'D:\\Work\\acme-wt'
  /** a second folder of the project: another linked worktree of acme */
  const WT2 = 'D:\\Work\\acme-wt2'
  /** whether a promise has settled by the next turn of the event loop */
  const settledNow = async (p: Promise<unknown>): Promise<boolean> => {
    let done = false
    void p.then(() => { done = true })
    await tick()
    return done
  }

  it("opens a Claude tab in the project's main folder and makes it the coordinator once it has a session and then its project; nothing is sent to it", async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    expect(w.openedCoordinators).toEqual([{ cwd: 'D:\\Work\\acme', projectKey: ACME.key }])
    update(w, 'chip-tab-1', { session: S_CHIP })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    expect(await settledNow(answer)).toBe(false)
    expect(w.store.coordinators()).toEqual([])
    update(w, 'chip-tab-1', { project: ACME })
    w.hub.placeChanged('chip-tab-1')
    expect(await answer).toEqual({ ok: true, info: 'This tab is now the coordinator of acme.' })
    expect(w.hub.isCoordinator('chip-tab-1')).toBe(true)
    expect(w.store.coordinator(S_CHIP)).toMatchObject({ project: ACME, attachments: [] })
    expect(w.mail.all()).toEqual([])
    expect(w.pokes).toEqual([])
  })

  it('with its project known first, the session that SessionStart reports makes it', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    update(w, 'chip-tab-1', { project: ACME })
    w.hub.placeChanged('chip-tab-1')
    expect(await settledNow(answer)).toBe(false)
    update(w, 'chip-tab-1', { session: S_CHIP })
    w.hub.sessionStarted('chip-tab-1', null, S_CHIP, 'startup')
    expect(await answer).toEqual({ ok: true, info: 'This tab is now the coordinator of acme.' })
  })

  it("a bare repository, or a lookup that fails, opens the tab in the folder of the group's tab, which still exists", async () => {
    const bare = world()
    bare.mainFolder = null
    bare.dirs = [WT]
    void bare.hub.startCoordinator(ACME.key, [WT])
    const failed = world()
    failed.mainFolderThrows = true
    failed.dirs = [WT]
    void failed.hub.startCoordinator(ACME.key, [WT])
    await tick()
    expect(bare.openedCoordinators).toEqual([{ cwd: WT, projectKey: ACME.key }])
    expect(failed.openedCoordinators).toEqual([{ cwd: WT, projectKey: ACME.key }])
  })

  it("the first folder's main folder is gone but the second folder's is named: the tab opens in that main folder", async () => {
    const w = world()
    w.mainFolder = null
    w.mainFolderOf = { [WT]: null, [WT2]: 'D:\\Work\\acme' }
    void w.hub.startCoordinator(ACME.key, [WT, WT2])
    await tick()
    expect(w.openedCoordinators).toEqual([{ cwd: 'D:\\Work\\acme', projectKey: ACME.key }])
  })

  it("every folder of the project is gone: the start is refused in words, and no tab opens", async () => {
    const w = world()
    w.mainFolder = null
    const answer = w.hub.startCoordinator(ACME.key, [WT, WT2])
    await tick()
    expect(w.openedCoordinators).toEqual([])
    expect(await answer).toEqual({ ok: false, error: HUB_TEXT.folderGone('acme') })
    // the refusal frees the project: a start once a folder is back opens its tab
    w.dirs = [WT2]
    void w.hub.startCoordinator(ACME.key, [WT, WT2])
    await tick()
    expect(w.openedCoordinators).toEqual([{ cwd: WT2, projectKey: ACME.key }])
  })

  it("a project none of whose open tabs is a Claude tab still names itself in the refusal, from its place", async () => {
    const w = world()
    w.tabs = w.tabs.filter((t) => t.project?.key !== ACME.key)
    w.mainFolder = null
    expect(await w.hub.startCoordinator(ACME.key, [WT])).toEqual({ ok: false, error: HUB_TEXT.folderGone('acme') })
    expect(w.openedCoordinators).toEqual([])
  })

  it("git names no main folder for any of them, and the second folder exists: the tab opens in the second folder", async () => {
    const w = world()
    w.mainFolder = null
    w.dirs = [WT2]
    void w.hub.startCoordinator(ACME.key, [WT, WT2])
    await tick()
    expect(w.openedCoordinators).toEqual([{ cwd: WT2, projectKey: ACME.key }])
  })

  it('a second start while the folder is looked up opens nothing; one while the tab waits for its session brings that tab to the front and opens nothing', async () => {
    const w = world()
    void w.hub.startCoordinator(ACME.key, [WT])
    expect(await w.hub.startCoordinator(ACME.key, [WT])).toBeNull()
    expect(w.activated).toEqual([])
    await tick()
    expect(await w.hub.startCoordinator(ACME.key, [WT])).toBeNull()
    expect(w.activated).toEqual(['chip-tab-1'])
    expect(w.openedCoordinators).toHaveLength(1)
  })

  it('a project with a coordinator brings its tab to the front and opens nothing', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    expect(await w.hub.startCoordinator(ACME.key, [WT])).toBeNull()
    expect(w.activated).toEqual(['tab-c'])
    expect(w.openedCoordinators).toEqual([])
  })

  it('a coordinator kept for the project whose tab is not open is named in a refusal, and nothing opens', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.tabs = w.tabs.filter((t) => t.tabId !== 'tab-c')
    expect(await w.hub.startCoordinator(ACME.key, [WT])).toEqual({ ok: false, error: HUB_TEXT.taken('acme', `session ${refOf(S.coord)}`) })
    expect(w.openedCoordinators).toEqual([])
    expect(w.activated).toEqual([])
  })

  it('the tab closed before its session started: nothing is made, the answer is null, and the next start opens a tab again', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    w.tabs = w.tabs.filter((t) => t.tabId !== 'chip-tab-1')
    w.hub.tabClosed('chip-tab-1')
    expect(await answer).toBeNull()
    expect(w.store.coordinators()).toEqual([])
    void w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    expect(w.openedCoordinators).toHaveLength(2)
  })

  it('the tab exited before its session started: nothing is made, also when a session comes later', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    update(w, 'chip-tab-1', { exited: true })
    w.hub.exited('chip-tab-1')
    expect(await answer).toBeNull()
    update(w, 'chip-tab-1', { session: S_CHIP, project: ACME })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    w.hub.placeChanged('chip-tab-1')
    expect(w.store.coordinators()).toEqual([])
  })

  it('a coordinator of the project made meanwhile: the tab stays an ordinary tab, and the answer is the refusal', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    w.hub.make('tab-c', false)
    update(w, 'chip-tab-1', { session: S_CHIP, project: ACME })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    expect(await answer).toEqual({ ok: false, error: 'The acme project already has a coordinator: coord · Desktop.', replaces: 'coord · Desktop' })
    expect(w.hub.isCoordinator('chip-tab-1')).toBe(false)
  })

  it('the coordinator limit refuses it the same way', async () => {
    const w = world()
    for (let i = 0; i < MAX_COORDINATORS; i++) {
      w.store.putCoordinator({ session: uid(0x20000 + i), project: { key: `/p/${i}`, name: `p${i}` }, since: NOW, attachments: [], former: [] })
    }
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    update(w, 'chip-tab-1', { session: S_CHIP, project: ACME })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    expect(await answer).toEqual({ ok: false, error: HUB_TEXT.fullCoordinators })
  })

  it('a tab that does not open answers null, and the next start tries again', async () => {
    const w = world()
    w.openFails = true
    expect(await w.hub.startCoordinator(ACME.key, [WT])).toBeNull()
    w.openFails = false
    void w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    expect(w.openedCoordinators).toHaveLength(2)
    expect(w.tabs.map((t) => t.tabId)).toContain('chip-tab-2')
  })

  it('a start whose folder lookup is still running when the hub is disposed opens no tab and answers null', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    w.hub.dispose()
    expect(await answer).toBeNull()
    await tick()
    expect(w.openedCoordinators).toEqual([])
  })

  it('a start waiting for its session answers null when the hub is disposed', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    expect(w.openedCoordinators).toHaveLength(1)
    w.hub.dispose()
    expect(await answer).toBeNull()
  })

  it("a tab whose project is not the started project is not made the coordinator: its start answers null and the tab stays ordinary", async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, [WT])
    await tick()
    update(w, 'chip-tab-1', { session: S_CHIP, project: BETA })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    expect(await answer).toBeNull()
    expect(w.store.coordinators()).toEqual([])
    expect(w.hub.isCoordinator('chip-tab-1')).toBe(false)
  })

  it('at the coordinator limit a start is refused before it opens a tab', async () => {
    const w = world()
    for (let i = 0; i < MAX_COORDINATORS; i++) {
      w.store.putCoordinator({ session: uid(0x30000 + i), project: { key: `/q/${i}`, name: `q${i}` }, since: NOW, attachments: [], former: [] })
    }
    expect(await w.hub.startCoordinator(ACME.key, [WT])).toEqual({ ok: false, error: HUB_TEXT.fullCoordinators })
    expect(w.openedCoordinators).toEqual([])
  })
})
