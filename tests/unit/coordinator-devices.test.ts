import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_TEXT } from '../../src/main/coordinator/coordinator-hub'
import { MAX_ATTACHMENTS, MAX_HOSTED, MAX_TASKS_PER_SESSION, type StoredAttachment } from '../../src/main/coordinator/coordinator-store'
import { checkMailRecord } from '../../src/main/mail/mail-record'
import { coordinatorProblem, type CoordSessionRow, type CoordinatorView } from '../../src/shared/coordinator'
import type { MailRecord } from '../../src/shared/mail'
import { attachDirect, cleanWorlds, deviceWorlds, DEV_C, DEV_S, fire, L, NO_FACTS, NOW, peerOf, records, remoteTab, S, sync, uid, world, type World } from '../fixtures/coordinator-world'

const TASK = '7a000000-0000-4000-8000-000000000001'
const ATTACH_ID = '7b000000-0000-4000-8000-000000000002'

afterEach(cleanWorlds)

/** the Not attached rows of other devices: Studio's own sessions of the project are listed too */
const remoteRows = (v: CoordinatorView): CoordSessionRow[] => v.notAttached.filter((r) => r.device !== null)

describe('rows of other devices', () => {
  let c: World

  beforeEach(() => {
    c = world({ self: DEV_C, selfName: 'Studio' })
    c.peers = [peerOf(DEV_S, 'Laptop')]
    c.hub.make('tab-c', false)
  })

  it('Not attached lists the project\'s sessions of an online paired device, by project name without case, with the device', () => {
    c.remoteTabs = [remoteTab({ project: 'ACME' }), remoteTab({ tabId: 'tab-l2', session: L.two, name: 'docs · Laptop', project: 'beta' })]
    const v = c.hub.view('tab-c')!
    expect(v.notAttached).toContainEqual(expect.objectContaining({
      key: `${DEV_S}:${L.one}`, tabId: 'tab-l1', device: DEV_S, deviceName: 'Laptop', session: L.one, ref: 'e10000', name: 'parser · Laptop',
      folder: '/home/sam/acme', branch: 'main', group: 'idle', line: 'Idle', marker: null, attachedTo: null
    }))
    expect(v.notAttached.map((r) => r.key)).not.toContain(`${DEV_S}:${L.two}`)
  })

  it('Not attached leaves out an offline device\'s session, an exited one, a coordinator and a tab without a session', () => {
    c.remoteTabs = [remoteTab()]
    expect(remoteRows(c.hub.view('tab-c')!).map((r) => r.key)).toEqual([`${DEV_S}:${L.one}`])

    c.peers = [peerOf(DEV_S, 'Laptop', { online: false })]
    expect(remoteRows(c.hub.view('tab-c')!)).toEqual([])

    c.peers = [peerOf(DEV_S, 'Laptop')]
    c.remoteTabs = [remoteTab({ exited: true })]
    expect(remoteRows(c.hub.view('tab-c')!)).toEqual([])

    c.remoteTabs = [remoteTab({ coord: { ...NO_FACTS, coordinator: true } })]
    expect(remoteRows(c.hub.view('tab-c')!)).toEqual([])

    c.remoteTabs = [remoteTab({ session: null, name: null })]
    expect(remoteRows(c.hub.view('tab-c')!)).toEqual([])
  })

  it('a remote session attached to a coordinator elsewhere names it', () => {
    c.remoteTabs = [remoteTab({ coord: { ...NO_FACTS, attachedTo: 'lead · Laptop' } })]
    expect(remoteRows(c.hub.view('tab-c')!)).toMatchObject([{ key: `${DEV_S}:${L.one}`, attachedTo: 'lead · Laptop' }])
  })

  it('a remote session attached to a coordinator of this device names that coordinator', () => {
    c.hub.make('tab-b', false)
    const beta = c.store.coordinator(S.beta)!
    c.store.putCoordinator({ ...beta, attachments: [{ device: DEV_S, session: L.one, name: 'parser · Laptop', attachedAt: NOW, resolved: false, failed: false, lastReport: null, pending: null }] })
    c.remoteTabs = [remoteTab()]
    expect(remoteRows(c.hub.view('tab-c')!)).toMatchObject([{ key: `${DEV_S}:${L.one}`, attachedTo: 'beta · Studio' }])
  })

  it('an attached remote row takes its task list, task and prompt from the tab\'s facts', () => {
    attachDirect(c)
    c.remoteTabs = [remoteTab({ working: true, coord: { ...NO_FACTS, progress: { done: 3, total: 7, finished: false, current: 'Grouping crashes by call stack' }, task: { id: TASK, state: 'open', since: NOW } } })]
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({
      key: `${DEV_S}:${L.one}`, device: DEV_S, deviceName: 'Laptop', tabId: 'tab-l1', marker: null, group: 'working',
      line: '3/7 · Grouping crashes by call stack', progress: { done: 3, total: 7 }, task: { id: TASK, state: 'open', since: NOW }
    })

    c.remoteTabs = [remoteTab({ coord: { ...NO_FACTS, prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: NOW } } })]
    expect(c.hub.view('tab-c')!).toMatchObject({ sessions: [expect.objectContaining({ group: 'waiting', why: 'prompt', line: 'Allow Bash: npm test' })], waiting: 1 })
    expect(c.hub.read('tab-c', 'e10000')).toMatchObject({ ok: true, info: expect.stringContaining('Waiting for the user: Allow Bash: npm test.') })
  })

  it('a remote attachment not confirmed is Attaching…, one on an offline device Offline, and one its listed device no longer has Tab closed', () => {
    attachDirect(c, ATTACH_ID)
    c.remoteTabs = [remoteTab()]
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ marker: 'attaching', line: 'Attaching…' })

    attachDirect(c)
    c.peers = [peerOf(DEV_S, 'Laptop', { online: false })]
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ marker: 'offline', line: 'Offline' })

    c.peers = [peerOf(DEV_S, 'Laptop')]
    c.remoteTabs = []
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ marker: null, line: 'Tab closed' })
  })

  it('a task written to a remote session is queued in its row until its device lists it: the oldest undelivered task of this coordinator, until a report answers it', () => {
    const OLDER = '7c000000-0000-4000-8000-000000000003'
    const DELIVERED = '7d000000-0000-4000-8000-000000000004'
    const OTHER = '7e000000-0000-4000-8000-000000000005'
    const REPORT_OLDER = '7f000000-0000-4000-8000-000000000006'
    const REPORT_TASK = '80000000-0000-4000-8000-000000000007'
    const coordinatorTask = (id: string, sentAt: number, delivered = false) => checkMailRecord({
      v: 1, id, from: { device: DEV_C, session: S.coord, name: 'coord · Studio' }, to: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      replyTo: null, text: 'Fix the parser.', sentAt, delivered, read: delivered, kind: 'task', project: 'acme'
    })!
    const reportTo = (id: string, replyTo: string) => checkMailRecord({
      v: 1, id, from: { device: DEV_S, session: L.one, name: 'parser · Laptop' }, to: { device: DEV_C, session: S.coord, name: 'coord · Studio' },
      replyTo, text: 'Done.', sentAt: NOW, delivered: false, read: false, kind: 'report', outcome: 'finished', project: 'acme'
    })!
    const queued = (): unknown => c.hub.view('tab-c')!.sessions[0].task

    attachDirect(c)
    c.remoteTabs = [remoteTab()]
    c.mail.add(coordinatorTask(TASK, NOW))
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ task: { id: TASK, state: 'queued', since: NOW }, line: 'Task waiting until the session is idle' })

    // an older undelivered task is the one queued
    c.mail.add(coordinatorTask(OLDER, NOW - 5))
    expect(queued()).toEqual({ id: OLDER, state: 'queued', since: NOW - 5 })

    // a task its device has delivered is not queued, though it is older
    c.mail.add(coordinatorTask(DELIVERED, NOW - 10, true))
    expect(queued()).toEqual({ id: OLDER, state: 'queued', since: NOW - 5 })

    // a task of another session of this device is not this coordinator's to this session, though it is older
    c.mail.add(checkMailRecord({
      v: 1, id: OTHER, from: { device: DEV_C, session: S.one, name: 'parser · Studio' }, to: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      replyTo: null, text: 'Not yours.', sentAt: NOW - 20, delivered: false, read: false, kind: 'task', project: 'acme'
    })!)
    expect(queued()).toEqual({ id: OLDER, state: 'queued', since: NOW - 5 })

    // a report to the older task answers it: the next undelivered task is queued, and none after the last report
    c.mail.add(reportTo(REPORT_OLDER, OLDER))
    expect(queued()).toEqual({ id: TASK, state: 'queued', since: NOW })
    c.mail.add(reportTo(REPORT_TASK, TASK))
    expect(queued()).toBeNull()
  })

  it('a confirmed remote attachment marks the other device\'s tab in this window; a pending one does not', () => {
    attachDirect(c)
    c.remoteTabs = [remoteTab()]
    expect(c.hub.marks()['tab-l1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId: 'tab-c' })
    attachDirect(c, ATTACH_ID)
    expect(c.hub.marks()['tab-l1']).toBeUndefined()
  })

  it('a device that is online but not listed yet is not a tab closed: the row is Idle until its list comes', () => {
    attachDirect(c)
    c.peers = [peerOf(DEV_S, 'Laptop', { listed: false })]
    c.remoteTabs = []
    const row = c.hub.view('tab-c')!.sessions[0]
    expect(row).toMatchObject({ marker: null, line: 'Idle' })
    expect(row.line).not.toBe('Tab closed')
  })

  it('a session with an exited tab and a live tab takes the live one, for the row and the mark', () => {
    attachDirect(c)
    c.remoteTabs = [remoteTab({ tabId: 'tab-old', exited: true }), remoteTab({ tabId: 'tab-l1' })]
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ tabId: 'tab-l1', marker: null, line: 'Idle' })
    expect(c.hub.marks()['tab-l1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId: 'tab-c' })
    expect(c.hub.marks()['tab-old']).toBeUndefined()
  })

  it('Not attached leaves out a shell tab of the project and a tab of a device with no peer; a project name with spaces around it matches', () => {
    c.remoteTabs = [remoteTab({ tabId: 'tab-sh', claude: false, session: L.two, name: null })]
    expect(remoteRows(c.hub.view('tab-c')!)).toEqual([])

    c.remoteTabs = [remoteTab({ device: 'a9000000-0000-4000-8000-0000000000b1', tabId: 'tab-x', session: L.two })]
    expect(remoteRows(c.hub.view('tab-c')!)).toEqual([])

    c.remoteTabs = [remoteTab({ project: '  acme ' })]
    expect(remoteRows(c.hub.view('tab-c')!).map((r) => r.key)).toEqual([`${DEV_S}:${L.one}`])
  })

  it('an attached row of a device with no peer is named another device, and Offline', () => {
    attachDirect(c)
    c.peers = []
    c.remoteTabs = [remoteTab()]
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ deviceName: 'another device', marker: 'offline', line: 'Offline' })
  })

  it('a view and the marks each read the paired devices and their tabs once, however many remote rows and attachments there are', () => {
    const coordinator = c.store.coordinator(S.coord)!
    const attachment = (session: string, name: string) => ({ device: DEV_S, session, name, attachedAt: NOW, resolved: false, failed: false, lastReport: null, pending: null })
    c.store.putCoordinator({ ...coordinator, attachments: [attachment(L.one, 'parser · Laptop'), attachment(L.two, 'docs · Laptop')] })
    c.remoteTabs = [
      remoteTab(),
      remoteTab({ tabId: 'tab-l2', session: L.two, name: 'docs · Laptop' }),
      remoteTab({ tabId: 'tab-lc', session: L.lead, name: 'lead · Laptop' })
    ]

    c.calls.peers = 0
    c.calls.remoteTabs = 0
    expect(c.hub.view('tab-c')!.sessions).toHaveLength(2)
    expect(c.calls).toEqual({ peers: 1, remoteTabs: 1 })

    c.calls.peers = 0
    c.calls.remoteTabs = 0
    c.hub.marks()
    expect(c.calls).toEqual({ peers: 1, remoteTabs: 1 })
  })
})

describe('attach, detach and tasks across devices', () => {
  let c: World
  let s: World
  const att = (): MailRecord => records(c, 'attach')[0]
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  const REFUSAL = '7b100000-0000-4000-8000-000000000003'
  const TASK_TO_PENDING = '7a100000-0000-4000-8000-000000000004'
  const TASK_LATE = '7a100000-0000-4000-8000-000000000005'
  const NO_PROJECT = '7b100000-0000-4000-8000-000000000006'
  const TO_COORDINATOR = '7b100000-0000-4000-8000-000000000007'
  const OTHER_DETACH = '7b100000-0000-4000-8000-000000000008'

  beforeEach(() => {
    const worlds = deviceWorlds()
    c = worlds.c
    s = worlds.s
    c.hub.make('tab-c', false)
  })

  it('attaching a Laptop session writes an attach record and waits: Attaching… until Laptop confirms; then both mark it', () => {
    // Laptop's session is also in this device's agent list, as agentsNow lists it: the name must still resolve once
    c.remote = [{ device: DEV_S, deviceName: 'Laptop', tabId: 'tab-l1', session: L.one, customTitle: 'parser', folder: '/home/sam/acme', branch: 'main', title: null, busy: false, wakes: true, claude: '2.1.300' }]
    expect(c.hub.attach('tab-c', 'parser · Laptop')).toEqual({ ok: true, info: HUB_TEXT.attaching('parser · Laptop', 'e10000', 'Laptop') })
    expect(att()).toMatchObject({ from: { device: DEV_C, session: S.coord }, to: { device: DEV_S, session: L.one }, project: 'acme', delivered: false })
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ marker: 'attaching', line: 'Attaching…' })
    sync(c, s)
    expect(s.store.hosted(L.one)).toMatchObject({ coordinator: { device: DEV_C, session: S.coord, name: 'coord · Studio' }, project: 'acme', tasks: [] })
    expect(c.store.coordinator(S.coord)!.attachments[0].pending).toBeNull()
    expect(c.hub.view('tab-c')!.sessions[0].marker).toBeNull()
    expect(s.hub.marks()['tab-l1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId: null })
    expect(c.hub.marks()['tab-l1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId: 'tab-c' })
  })

  it("the tool's attach answers once Laptop confirms, or with Attaching… after 8 s", async () => {
    const answer = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
    await tick()
    sync(c, s)
    expect(await answer).toEqual({ ok: true, info: HUB_TEXT.attached('parser · Laptop', 'e10000') })

    const late = c.hub.tool('tab-c', { op: 'attach', session: 'e20000' })
    await tick()
    expect(c.timers.map((t) => t.ms)).toContain(8000)
    fire(c)
    expect(await late).toEqual({ ok: true, info: HUB_TEXT.attaching('docs · Laptop', 'e20000', 'Laptop') })
  })

  it('Laptop refuses a session attached to its own coordinator, naming it; the attachment goes and the answer says why', async () => {
    s.hub.make('tab-lc', false)
    s.hub.attach('tab-lc', 'e10000')
    const answer = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
    await tick()
    sync(c, s)
    expect(await answer).toEqual({ ok: false, error: 'parser · Laptop is attached to the acme coordinator (lead · Laptop); it must be detached there first.' })
    expect(c.hub.view('tab-c')!.sessions).toEqual([])
    expect(records(s, 'detach')).toEqual([expect.objectContaining({ replyTo: expect.any(String), to: expect.objectContaining({ device: DEV_C, session: S.coord }) })])
  })

  it('Laptop refuses with its problem when it cannot coordinate, and a session whose tab is closed as closed', async () => {
    s.problem = coordinatorProblem(false, true, '2.1.400')
    const refused = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
    await tick()
    sync(c, s)
    expect(await refused).toEqual({ ok: false, error: HUB_TEXT.problemThere('Laptop', s.problem!) })

    s.problem = null
    s.tabs = s.tabs.filter((t) => t.tabId !== 'tab-l1')
    const closed = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
    await tick()
    sync(c, s)
    expect(await closed).toEqual({ ok: false, error: HUB_TEXT.closedThere('parser · Laptop') })
  })

  it('a session on a device without coordinator records, or without mail, is refused and nothing is written', () => {
    c.peers = [peerOf(DEV_S, 'Laptop', { coord: false })]
    expect(c.hub.attach('tab-c', 'e10000')).toEqual({ ok: false, error: HUB_TEXT.oldDevice('Laptop') })
    c.peers = [peerOf(DEV_S, 'Laptop', { mail: false })]
    expect(c.hub.attach('tab-c', 'e10000')).toEqual({ ok: false, error: HUB_TEXT.noMail('Laptop') })
    expect(records(c, 'attach')).toEqual([])
  })

  it('the window attaches a remote tab by its id; one of an offline device is refused', () => {
    expect(c.hub.attachTab('tab-c', 'tab-l1')).toEqual({ ok: true, info: HUB_TEXT.attaching('parser · Laptop', 'e10000', 'Laptop') })
    const { c: c2 } = deviceWorlds()
    c2.hub.make('tab-c', false)
    c2.peers = [peerOf(DEV_S, 'Laptop', { online: false })]
    expect(c2.hub.attachTab('tab-c', 'tab-l1')).toEqual({ ok: false, error: HUB_TEXT.deviceOffline('Laptop') })
  })

  it('an attach whose device goes offline before it hears stays Attaching… with no time limit, and is confirmed once the device is back', () => {
    c.hub.attach('tab-c', 'e10000')
    c.peers = [{ ...c.peers[0], online: false }]
    c.hub.remoteChanged()
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ marker: 'attaching', line: 'Attaching…' })
    expect(c.timers).toEqual([])
    c.peers = [{ ...c.peers[0], online: true }]
    sync(c, s)
    expect(c.hub.view('tab-c')!.sessions[0].marker).toBeNull()
  })

  it('a task to a Laptop session is held there as queued, and its report comes back to the coordinator', () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    expect(c.hub.message('tab-c', 'e10000', 'Fix the parser.')).toEqual({ ok: true, info: expect.stringMatching(/^Task given to parser · Laptop \[e10000\]\./) })
    sync(c, s)
    expect(s.store.hosted(L.one)!.tasks).toEqual([expect.objectContaining({ state: 'queued', from: expect.objectContaining({ device: DEV_C, session: S.coord }) })])
    const [task] = records(s, 'task')
    s.hub.handedOver('tab-l1', [task], 'idle')
    s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' })
    fire(s)
    sync(c, s)
    expect(records(c, 'report')).toEqual([
      expect.objectContaining({ from: expect.objectContaining({ device: DEV_S, session: L.one }), to: expect.objectContaining({ device: DEV_C, session: S.coord }), outcome: 'finished', text: 'Parser fixed.' })
    ])
    expect(c.store.coordinator(S.coord)!.attachments[0].lastReport).toMatchObject({ outcome: 'finished' })
    expect(c.hub.accepts(records(c, 'report')[0], 'tab-c', 'idle')).toBe(true)
    expect(c.hub.resolve('tab-c', 'e10000')).toEqual({ ok: true, info: HUB_TEXT.resolved('parser · Laptop') })
    expect(c.hub.view('tab-c')!.sessions[0].group).toBe('resolved')
  })

  it("a task to an Attaching… session is refused; one to an offline device's session waits and says so", () => {
    c.hub.attach('tab-c', 'e10000')
    expect(c.hub.message('tab-c', 'e10000', 'Fix the parser.')).toEqual({ ok: false, error: HUB_TEXT.notConfirmed('parser · Laptop') })
    sync(c, s)
    c.peers = [peerOf(DEV_S, 'Laptop', { online: false })]
    expect(c.hub.message('tab-c', 'e10000', 'Fix the parser.')).toEqual({ ok: true, info: HUB_TEXT.queuedOffline('parser · Laptop', 'e10000', 'Laptop') })
  })

  it('the 21st task to a Laptop session that sent no report is refused', () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    for (let i = 0; i < MAX_TASKS_PER_SESSION; i++) expect(c.hub.message('tab-c', 'e10000', `Task ${i}.`)).toMatchObject({ ok: true })
    expect(c.hub.message('tab-c', 'e10000', 'One more.')).toEqual({ ok: false, error: HUB_TEXT.tooMany('parser · Laptop') })
    expect(records(c, 'task')).toHaveLength(MAX_TASKS_PER_SESSION)
  })

  it('detaching a Laptop session tells Laptop, which drops its tasks without a report; stop does the same', () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    expect(c.hub.detach('tab-c', 'e10000')).toEqual({ ok: true, info: HUB_TEXT.detached('parser · Laptop', true) })
    sync(c, s)
    expect(s.store.hosted(L.one)).toBeNull()
    expect(records(s, 'report')).toEqual([])

    const pair = deviceWorlds()
    pair.c.hub.make('tab-c', false)
    pair.c.hub.attach('tab-c', 'e10000')
    sync(pair.c, pair.s)
    expect(pair.s.store.hosted(L.one)).not.toBeNull()
    expect(pair.c.hub.stop('tab-c')).toMatchObject({ ok: true })
    sync(pair.c, pair.s)
    expect(pair.s.store.hosted(L.one)).toBeNull()
  })

  it("leave on Laptop detaches its session from Studio's coordinator; a tab attached nowhere is told so", () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    expect(s.hub.leave('tab-l1')).toEqual({ ok: true, info: 'Detached from the acme coordinator.' })
    sync(c, s)
    expect(c.hub.view('tab-c')!.sessions).toEqual([])
    expect(s.hub.marks()['tab-l1']).toBeUndefined()
    expect(s.hub.leave('tab-l2')).toEqual({ ok: false, error: HUB_TEXT.notAttached })
  })

  it("leave answers for a session whose coordinator on this device is gone, and its mark goes", () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.hub.attach('tab-c', 'a10000')
    w.store.removeCoordinator(S.coord)
    expect(w.hub.leave('tab-1')).toEqual({ ok: true, info: 'Detached from the acme coordinator.' })
    expect(w.store.hosted(S.one)).toBeNull()
    expect(w.hub.marks()['tab-1']).toBeUndefined()
  })

  it('a report from a session no longer attached wakes nobody', () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    c.hub.detach('tab-c', 'e10000') // Laptop hears of it at the next sync only
    s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' })
    fire(s)
    sync(c, s)
    const [report] = records(c, 'report')
    expect(report).toMatchObject({ delivered: true, read: true })
    expect(c.hub.accepts(report, 'tab-c', 'idle')).toBe(false)
  })

  it('a refusal that comes late does not remove the newer attachment of the same session', () => {
    c.hub.attach('tab-c', 'e10000')
    const first = att().id
    c.hub.detach('tab-c', 'e10000')
    c.hub.attach('tab-c', 'e10000')
    const second = records(c, 'attach')[1].id
    expect(c.store.coordinator(S.coord)!.attachments).toEqual([expect.objectContaining({ device: DEV_S, session: L.one, pending: second })])

    const refusal: MailRecord = {
      v: 1,
      id: REFUSAL,
      from: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      to: { device: DEV_C, session: S.coord, name: 'coord · Studio' },
      replyTo: first,
      text: 'parser · Laptop is attached to the acme coordinator (lead · Laptop); it must be detached there first.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'detach'
    }
    c.mail.add(refusal)
    expect(c.store.coordinator(S.coord)!.attachments).toEqual([expect.objectContaining({ device: DEV_S, session: L.one, pending: second })])
    expect(c.mail.get(REFUSAL)).toMatchObject({ delivered: true, read: true })
  })

  it('a pending attachment that is refused drops the tasks given to its session that the session never took', () => {
    c.hub.attach('tab-c', 'e10000')
    const attachId = att().id
    c.mail.add(checkMailRecord({
      v: 1, id: TASK_TO_PENDING, from: { device: DEV_C, session: S.coord, name: 'coord · Studio' }, to: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      replyTo: null, text: 'Fix the parser.', sentAt: NOW, delivered: false, read: false, kind: 'task', project: 'acme'
    })!)
    c.mail.add({
      v: 1,
      id: REFUSAL,
      from: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      to: { device: DEV_C, session: S.coord, name: 'coord · Studio' },
      replyTo: attachId,
      text: 'Refused.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'detach'
    })
    expect(c.store.coordinator(S.coord)!.attachments).toEqual([])
    expect(c.mail.get(TASK_TO_PENDING)).toMatchObject({ delivered: true, read: true })
  })

  it('a remote attach refuses with fullAttached when this coordinator holds 200 attachments, pending ones included', () => {
    const coordinator = c.store.coordinator(S.coord)!
    const attachments: StoredAttachment[] = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
      device: i === 0 ? DEV_S : null,
      session: i === 0 ? L.two : uid(0x10000 + i),
      name: `session ${i}`,
      attachedAt: NOW,
      resolved: false,
      failed: false,
      lastReport: null,
      pending: i === 0 ? ATTACH_ID : null
    }))
    c.store.putCoordinator({ ...coordinator, attachments })
    expect(c.hub.attach('tab-c', 'e10000')).toEqual({ ok: false, error: HUB_TEXT.fullAttached })
    expect(records(c, 'attach')).toEqual([])
  })

  it('a session refuses an attach with fullHosted when its device has 500 attached sessions', async () => {
    for (let i = 0; i < MAX_HOSTED; i++) {
      s.store.putHosted({ session: uid(0x20000 + i), coordinator: { device: null, session: uid(0x30000), name: 'other' }, project: 'other', tasks: [], former: [] })
    }
    const answer = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
    await tick()
    sync(c, s)
    expect(await answer).toEqual({ ok: false, error: HUB_TEXT.fullHosted })
    expect(s.store.hosted(L.one)).toBeNull()
  })

  it('a tool waiting on a pending attach is answered detachedPending when its session is detached, and when the coordinator stops; detach settles the pending tasks', async () => {
    const first = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
    await tick()
    c.mail.add(checkMailRecord({
      v: 1, id: TASK_LATE, from: { device: DEV_C, session: S.coord, name: 'coord · Studio' }, to: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      replyTo: null, text: 'Fix the parser.', sentAt: NOW, delivered: false, read: false, kind: 'task', project: 'acme'
    })!)
    c.hub.detach('tab-c', 'e10000')
    expect(await first).toEqual({ ok: false, error: HUB_TEXT.detachedPending('parser · Laptop') })
    expect(c.mail.get(TASK_LATE)).toMatchObject({ delivered: true, read: true })

    const second = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
    await tick()
    c.hub.stop('tab-c')
    expect(await second).toEqual({ ok: false, error: HUB_TEXT.detachedPending('parser · Laptop') })
  })

  it("making a Laptop session a coordinator detaches it from Studio's coordinator, which drops the attachment", () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    expect(s.hub.make('tab-l1', false)).toMatchObject({ ok: true })
    sync(c, s)
    expect(c.hub.view('tab-c')!.sessions).toEqual([])
  })

  it('attaching a Laptop session that is a coordinator there is refused by name, and nothing is written', () => {
    s.hub.make('tab-lc', false)
    sync(c, s)
    expect(c.hub.attach('tab-c', 'lead · Laptop')).toEqual({ ok: false, error: HUB_TEXT.isCoordinator('lead · Laptop') })
    expect(records(c, 'attach')).toEqual([])
  })

  it('attaching a session already attached and pending writes no second record and answers attaching; once confirmed it answers alreadyAttached', () => {
    c.hub.attach('tab-c', 'e10000')
    expect(c.hub.attach('tab-c', 'e10000')).toEqual({ ok: true, info: HUB_TEXT.attaching('parser · Laptop', 'e10000', 'Laptop') })
    expect(records(c, 'attach')).toHaveLength(1)
    sync(c, s)
    expect(c.hub.attach('tab-c', 'e10000')).toEqual({ ok: true, info: HUB_TEXT.alreadyAttached('parser · Laptop') })
    expect(records(c, 'attach')).toHaveLength(1)
  })

  it('attaching a Laptop session attached to another coordinator of this device is refused with that coordinator', () => {
    c.hub.make('tab-b', false)
    const beta = c.store.coordinator(S.beta)!
    c.store.putCoordinator({ ...beta, attachments: [{ device: DEV_S, session: L.one, name: 'parser · Laptop', attachedAt: NOW, resolved: false, failed: false, lastReport: null, pending: null }] })
    expect(c.hub.attach('tab-c', 'e10000')).toEqual({ ok: false, error: HUB_TEXT.elsewhere('parser · Laptop', 'beta', 'beta · Studio') })
    expect(records(c, 'attach')).toEqual([])
  })

  it('Laptop refuses an attach that names no project, and one to its coordinator, each with a detach that says why', () => {
    s.hub.make('tab-lc', false)
    const attach = (id: string, to: string, project?: string): MailRecord => ({
      v: 1,
      id,
      from: { device: DEV_C, session: S.coord, name: 'coord · Studio' },
      to: { device: DEV_S, session: to, name: 'parser · Laptop' },
      replyTo: null,
      text: 'Attached.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'attach',
      ...(project === undefined ? {} : { project })
    })
    s.mail.add(attach(NO_PROJECT, L.one))
    s.mail.add(attach(TO_COORDINATOR, L.lead, 'acme'))
    expect(records(s, 'detach').map((r) => [r.replyTo, r.text])).toEqual([
      [NO_PROJECT, HUB_TEXT.noProjectGiven],
      [TO_COORDINATOR, HUB_TEXT.isCoordinator('lead · Laptop')]
    ])
    expect(s.store.hosted(L.one)).toBeNull()
  })

  it('a detach from a device that is not the hosted coordinator leaves the hosted entry as it is', () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    s.mail.add({
      v: 1,
      id: OTHER_DETACH,
      from: { device: DEV_C, session: S.one, name: 'parser · Studio' },
      to: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      replyTo: null,
      text: 'Left.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'detach'
    })
    expect(s.store.hosted(L.one)).toMatchObject({ coordinator: { device: DEV_C, session: S.coord } })
    expect(s.mail.get(OTHER_DETACH)).toMatchObject({ delivered: true, read: true })
  })
})
