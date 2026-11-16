import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_TEXT, START_WAIT_MS } from '../../src/main/coordinator/coordinator-hub'
import { MAX_ATTACHMENTS, MAX_HOSTED, MAX_TASKS_PER_SESSION, type StoredAttachment } from '../../src/main/coordinator/coordinator-store'
import { refOf } from '../../src/main/mail/agent-directory'
import { checkMailRecord } from '../../src/main/mail/mail-record'
import { isShareable } from '../../src/main/mail/mail-store'
import { coordinatorProblem, type CoordSessionRow, type CoordinatorView } from '../../src/shared/coordinator'
import { MAIL_MIN_CLAUDE, type MailRecord } from '../../src/shared/mail'
import { attachDirect, ACME, cleanWorlds, deviceWorlds, DEV_C, DEV_S, fire, L, NEW, NO_FACTS, NOW, peerOf, records, remoteTab, said, S, sync, tab, uid, world, type World } from '../fixtures/coordinator-world'

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

  it("the person's words to a Laptop session go with its record; an Attaching… session, an older Laptop and an offline one are refused first, and nothing is written", async () => {
    said(c, 'Merge it into master.')
    const give = () => c.hub.tool('tab-c', { op: 'message', session: 'e10000', text: 'Merge.', words: 'Merge it into master.' })
    c.hub.attach('tab-c', 'e10000')
    expect(await give()).toEqual({ ok: false, error: HUB_TEXT.notConfirmed('parser · Laptop') })
    sync(c, s)
    c.peers = [peerOf(DEV_S, 'Laptop', { words: false })]
    expect(await give()).toEqual({ ok: false, error: HUB_TEXT.oldDeviceWords('Laptop') })
    c.peers = [peerOf(DEV_S, 'Laptop', { online: false })]
    expect(await give()).toEqual({ ok: false, error: HUB_TEXT.wordsOffline('Laptop') })
    expect(records(c, 'task')).toEqual([])
    c.peers = [peerOf(DEV_S, 'Laptop')]
    expect(await give()).toEqual({ ok: true, info: HUB_TEXT.queuedWords('parser · Laptop', 'e10000') })
    sync(c, s)
    expect(records(s, 'task')).toEqual([expect.objectContaining({ words: 'Merge it into master.', context: 'Shall I merge feat/x into master?' })])
    expect(c.toasts).toEqual(['Your words went to parser · Laptop: «Merge it into master.»'])
  })

  it("Studio's row of Laptop's session shows the session's latest progress note while its task is open", () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    s.hub.turnEnded('tab-l1', { background: true, lastMessage: 'Waiting for the tests.' })
    // the note arrives on Studio alone: its arrival redraws the panel
    c.order.length = 0
    c.mail.merge(s.mail.all().filter(isShareable), { link: 's' })
    expect(c.order).toContain('changed')
    sync(c, s)
    expect(c.hub.view('tab-c')!.sessions[0].line).toBe('Background work · Waiting for the tests.')
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
    expect(await answer).toEqual({ ok: false, error: 'Laptop has 500 attached sessions already, the most it keeps; detach one there first.' })
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

  it('a replace while an attach is pending: the replacing attach is the pending one, so a late refusal of the replaced attach does not remove it', () => {
    c.hub.attach('tab-c', 'e10000')
    const replaced = att().id
    c.hub.make('tab-2', true)
    const replacing = records(c, 'attach').at(-1)!.id
    expect(c.store.coordinator(S.two)!.attachments).toEqual([expect.objectContaining({ device: DEV_S, session: L.one, pending: replacing })])
    c.mail.add({
      v: 1,
      id: '7b100000-0000-4000-8000-000000000009',
      from: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      to: { device: DEV_C, session: S.two, name: 'docs · Studio' },
      replyTo: replaced,
      text: 'Refused.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'detach'
    })
    expect(c.store.coordinator(S.two)!.attachments).toEqual([expect.objectContaining({ device: DEV_S, session: L.one, pending: replacing })])
  })

  it('a session that cleared on Laptop before the attach arrived is refused as not open under its session id, not as closed', async () => {
    const answer = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
    await tick()
    s.tabs = s.tabs.map((t) => (t.tabId === 'tab-l1' ? { ...t, session: NEW.one } : t))
    s.hub.sessionStarted('tab-l1', L.one, NEW.one, 'clear')
    sync(c, s)
    expect(await answer).toEqual({ ok: false, error: 'parser · Laptop is not open under this session id on its device: it was closed, or cleared to a new session id.' })
  })

  it('a progress note from a session no longer attached wakes nobody', () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    c.hub.detach('tab-c', 'e10000') // Laptop hears of it at the next sync only
    s.hub.turnEnded('tab-l1', { background: true, lastMessage: 'Waiting for the tests.' })
    sync(c, s)
    const [note] = records(c, 'progress')
    expect(note).toMatchObject({ delivered: true, read: true })
    expect(c.hub.accepts(note, 'tab-c', 'idle')).toBe(false)
  })

  it("a progress note of Laptop's session reaches Studio's coordinator, and the task stays open there", () => {
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    const [task] = records(s, 'task')
    s.hub.handedOver('tab-l1', [task], 'idle')
    s.hub.turnEnded('tab-l1', { background: true, lastMessage: 'Waiting for the tests.' })
    sync(c, s)
    const [note] = records(c, 'progress')
    expect(note).toMatchObject({ from: { device: DEV_S, session: L.one }, to: { device: DEV_C, session: S.coord }, replyTo: task.id, text: 'Waiting for the tests.', delivered: false })
    expect(c.hub.accepts(note, 'tab-c', 'prompt')).toBe(true)
    expect(s.store.hosted(L.one)!.tasks).toMatchObject([{ state: 'open' }])
  })
})

describe('new ids across devices', () => {
  let c: World
  let s: World
  const clear = (w: World, tabId: string, from: string, to: string): void => {
    w.hub.tabSession(tabId, to)
    w.hub.sessionStarted(tabId, from, to, 'clear')
  }

  beforeEach(() => {
    const worlds = deviceWorlds()
    c = worlds.c
    s = worlds.s
    c.hub.make('tab-c', false)
    c.hub.attach('tab-c', 'e10000')
    sync(c, s)
  })

  it("a task with the person's words sent to Laptop's old id is forwarded with them, so it is never handed to a watcher", async () => {
    said(c, 'Merge it into master.')
    await c.hub.tool('tab-c', { op: 'message', session: 'e10000', text: 'Merge.', words: 'Merge it into master.' }) // Laptop clears before it hears of the task
    clear(s, 'tab-l1', L.one, NEW.one)
    sync(c, s)
    const copy = records(s, 'task').find((r) => r.to.session === NEW.one)!
    expect(copy).toMatchObject({ words: 'Merge it into master.', context: 'Shall I merge feat/x into master?' })
    expect(s.hub.accepts(copy, 'tab-l1', 'idle')).toBe(false)
  })

  it("the words given to Laptop's session before its clear are not relayed to it again after the clear: they went already", async () => {
    said(c, 'Merge it into master.')
    expect(await c.hub.tool('tab-c', { op: 'message', session: 'e10000', text: 'Merge.', words: 'Merge it into master.' })).toMatchObject({ ok: true })
    sync(c, s)
    // Laptop's tab runs the new session, so the session is named after its tab
    s.tabs = s.tabs.map((t) => (t.tabId === 'tab-l1' ? { ...t, session: NEW.one } : t))
    clear(s, 'tab-l1', L.one, NEW.one)
    sync(c, s)
    expect(await c.hub.tool('tab-c', { op: 'message', session: refOf(NEW.one), text: 'Merge feat/x again.', words: 'Merge it into master.' })).toEqual({ ok: false, error: HUB_TEXT.wordsAgain('parser · Laptop') })
    expect(records(c, 'task')).toHaveLength(1)
    expect(c.toasts).toHaveLength(1)
  })

  it('a clear in the coordinator tells Laptop: the session\'s tasks then come from the new id and are taken', () => {
    clear(c, 'tab-c', S.coord, NEW.coord)
    expect(records(c, 'attach').at(-1)).toMatchObject({ was: S.coord, from: { device: DEV_C, session: NEW.coord }, to: { device: DEV_S, session: L.one } })
    sync(c, s)
    expect(s.store.hosted(L.one)!.coordinator.session).toBe(NEW.coord)
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    expect(s.store.hosted(L.one)!.tasks).toEqual([expect.objectContaining({ from: expect.objectContaining({ session: NEW.coord }) })])
  })

  it('a clear in Laptop\'s session tells Studio: the attachment follows it, and the clear\'s stopped report reaches the coordinator', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    clear(s, 'tab-l1', L.one, NEW.one)
    expect(s.mail.all().filter((r) => r.from.device === DEV_S && (r.kind === 'attach' || r.kind === 'report')).map((r) => r.kind)).toEqual(['attach', 'report'])
    sync(c, s)
    expect(c.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ session: NEW.one, lastReport: { outcome: 'stopped' } })
  })

  it('a task Studio sent to Laptop\'s old id is forwarded to the new one and taken there', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.') // Laptop clears before it hears of the task
    clear(s, 'tab-l1', L.one, NEW.one)
    sync(c, s)
    expect(s.store.hosted(NEW.one)!.tasks).toHaveLength(1)
    expect(records(s, 'task').find((r) => r.to.session === L.one)).toMatchObject({ delivered: true, read: true })
  })

  it('a report Laptop sent to the coordinator\'s old id is forwarded to its new one, which takes it', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    clear(c, 'tab-c', S.coord, NEW.coord) // Laptop finishes before it hears of the clear
    s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' })
    fire(s)
    sync(c, s)
    const reports = records(c, 'report')
    expect(reports.find((r) => r.to.session === S.coord)).toMatchObject({ delivered: true, read: true })
    const copy = reports.find((r) => r.to.session === NEW.coord)!
    expect(copy).toMatchObject({ delivered: false, text: 'Parser fixed.', from: expect.objectContaining({ session: L.one }) })
    expect(c.store.coordinator(NEW.coord)!.attachments[0].lastReport!.id).toBe(copy.id)
  })

  it("a progress note Laptop sent to the coordinator's old id is forwarded to its new one, which takes it", () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    clear(c, 'tab-c', S.coord, NEW.coord) // Laptop's turn ends before it hears of the clear
    s.hub.turnEnded('tab-l1', { background: true, lastMessage: 'Waiting for the tests.' })
    sync(c, s)
    const notes = records(c, 'progress')
    expect(notes.find((r) => r.to.session === S.coord)).toMatchObject({ delivered: true, read: true })
    const copy = notes.find((r) => r.to.session === NEW.coord)!
    expect(copy).toMatchObject({ delivered: false, text: 'Waiting for the tests.' })
    expect(c.hub.accepts(copy, 'tab-c', 'prompt')).toBe(true)
  })

  it('a progress note that waited in Studio before its coordinator cleared is forwarded to the new id at the clear, and the new coordinator takes it', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    s.hub.turnEnded('tab-l1', { background: true, lastMessage: 'Waiting for the tests.' })
    sync(c, s)
    const waiting = records(c, 'progress')[0]
    expect(waiting).toMatchObject({ to: { session: S.coord }, delivered: false, read: false })
    clear(c, 'tab-c', S.coord, NEW.coord)
    const copy = records(c, 'progress').find((r) => r.to.session === NEW.coord)!
    expect(copy).toMatchObject({ delivered: false, read: false, text: 'Waiting for the tests.', replyTo: waiting.replyTo, from: expect.objectContaining({ session: L.one }) })
    expect(c.mail.get(waiting.id)).toMatchObject({ delivered: true, read: true })
    expect(c.hub.accepts(copy, 'tab-c', 'prompt')).toBe(true)
  })

  it('a replacing coordinator takes Laptop\'s session with its task; the report goes to it with the previous coordinator\'s note', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    c.hub.make('tab-2', true)
    expect(records(c, 'attach').at(-1)).toMatchObject({ replaces: S.coord, from: { session: S.two }, to: { session: L.one } })
    sync(c, s)
    expect(s.store.hosted(L.one)).toMatchObject({ coordinator: { session: S.two }, tasks: [{ from: { session: S.coord } }] })
    s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' })
    fire(s)
    sync(c, s)
    expect(records(c, 'report').at(-1)).toMatchObject({ to: { session: S.two }, text: expect.stringMatching(/^\(This task was given by the previous coordinator, coord · Studio\.\)/) })
  })

  it('a report that waited in Studio before its coordinator cleared is forwarded to the new id at the clear, and the new coordinator takes it', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' })
    fire(s)
    sync(c, s)
    const waiting = records(c, 'report')[0]
    expect(waiting).toMatchObject({ to: { session: S.coord }, delivered: false, read: false })
    clear(c, 'tab-c', S.coord, NEW.coord)
    const copy = records(c, 'report').find((r) => r.to.session === NEW.coord)!
    expect(copy).toMatchObject({ delivered: false, read: false, text: 'Parser fixed.', from: expect.objectContaining({ session: L.one }) })
    expect(c.mail.get(waiting.id)).toMatchObject({ delivered: true, read: true })
    expect(c.hub.accepts(copy, 'tab-c', 'prompt')).toBe(true)
    expect(c.store.coordinator(NEW.coord)!.attachments[0].lastReport!.id).toBe(copy.id)
  })

  it('a report that waited in Studio for the coordinator a replacing one takes over is forwarded to the replacing coordinator', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' })
    fire(s)
    sync(c, s)
    c.hub.make('tab-2', true)
    const copy = records(c, 'report').find((r) => r.to.session === S.two)!
    expect(copy).toMatchObject({ delivered: false, read: false, text: 'Parser fixed.' })
    expect(c.store.coordinator(S.two)!.attachments[0].lastReport!.id).toBe(copy.id)
  })

  it('a clear whose new id is already in use renames nothing, and writes no attach that carries the old id', () => {
    // beta's coordinator takes the id the clear would move to, and it holds a session of Laptop: a rename onto it must tell no one
    c.hub.make('tab-b', false)
    const beta = c.store.coordinator(S.beta)!
    c.store.putCoordinator({ ...beta, attachments: [{ device: DEV_S, session: L.two, name: 'docs · Laptop', attachedAt: NOW, resolved: false, failed: false, lastReport: null, pending: null }] })
    clear(c, 'tab-c', S.coord, S.beta)
    expect(c.store.coordinator(S.coord)).not.toBeNull()
    expect(records(c, 'attach').filter((r) => r.was !== undefined)).toEqual([])
  })

  it('a remote task Laptop took but did not hand over is held once after its session clears, and the record still to hand over is accepted', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    clear(s, 'tab-l1', L.one, NEW.one)
    expect(s.store.hosted(NEW.one)!.tasks).toHaveLength(1)
    const open = records(s, 'task').filter((r) => !r.delivered)
    expect(open).toHaveLength(1)
    expect(s.hub.accepts(open[0], 'tab-l1', 'idle')).toBe(true)
  })

  it('a task Laptop holds from the coordinator that cleared is re-addressed to the new id, and its report has no previous-coordinator note', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    clear(c, 'tab-c', S.coord, NEW.coord)
    sync(c, s)
    expect(s.store.hosted(L.one)!.tasks).toEqual([expect.objectContaining({ from: expect.objectContaining({ session: NEW.coord }) })])
    s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' })
    fire(s)
    sync(c, s)
    const report = records(c, 'report').at(-1)!
    expect(report).toMatchObject({ to: { session: NEW.coord }, text: 'Parser fixed.' })
    expect(report.text.startsWith('(This task was given by the previous coordinator')).toBe(false)
  })

  it('a task sent before a clear still counts toward the cap, and is the queued task of its session', () => {
    for (let i = 0; i < MAX_TASKS_PER_SESSION; i++) expect(c.hub.message('tab-c', 'e10000', `Task ${i}.`)).toMatchObject({ ok: true })
    const first = records(c, 'task')[0]
    clear(c, 'tab-c', S.coord, NEW.coord)
    expect(c.hub.view('tab-c')!.sessions[0].task).toEqual({ id: first.id, state: 'queued', since: NOW })
    expect(c.hub.message('tab-c', 'e10000', 'One more.')).toEqual({ ok: false, error: HUB_TEXT.tooMany('parser · Laptop') })
    expect(records(c, 'task')).toHaveLength(MAX_TASKS_PER_SESSION)
  })

  it('a task sent before a clear is marked delivered and read when the attach that followed the clear is refused', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    const task = records(c, 'task')[0]
    clear(c, 'tab-c', S.coord, NEW.coord)
    c.hub.detach('tab-c', 'e10000')
    c.hub.attach('tab-c', 'e10000')
    const attachId = records(c, 'attach').at(-1)!.id
    expect(c.store.coordinator(NEW.coord)!.attachments).toEqual([expect.objectContaining({ device: DEV_S, session: L.one, pending: attachId })])
    c.mail.add({
      v: 1,
      id: '7b200000-0000-4000-8000-000000000001',
      from: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      to: { device: DEV_C, session: NEW.coord, name: 'coord · Studio' },
      replyTo: attachId,
      text: 'Refused.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'detach'
    })
    expect(c.store.coordinator(NEW.coord)!.attachments).toEqual([])
    expect(c.mail.get(task.id)).toMatchObject({ delivered: true, read: true })
  })

  it('a forwarded copy keeps the sentAt of the record it copies, so the clock of this device cannot reorder it', () => {
    c.hub.message('tab-c', 'e10000', 'Fix the parser.')
    sync(c, s)
    s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
    clear(c, 'tab-c', S.coord, NEW.coord) // Laptop finishes before it hears of the clear
    s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' })
    fire(s)
    c.now = NOW + 5000 // Studio's clock is ahead of Laptop's when the copy is written
    sync(c, s)
    const reports = records(c, 'report')
    const original = reports.find((r) => r.to.session === S.coord)!
    const copy = reports.find((r) => r.to.session === NEW.coord)!
    expect(copy.sentAt).toBe(original.sentAt)
  })

  it('a was notice goes to a pending attachment too: it stays pending under the new id until Laptop confirms it', () => {
    c.hub.detach('tab-c', 'e10000')
    c.hub.attach('tab-c', 'e10000')
    const pending = records(c, 'attach').at(-1)!.id
    clear(c, 'tab-c', S.coord, NEW.coord)
    expect(records(c, 'attach').at(-1)).toMatchObject({ was: S.coord, from: { device: DEV_C, session: NEW.coord }, to: { device: DEV_S, session: L.one } })
    expect(c.store.coordinator(NEW.coord)!.attachments).toEqual([expect.objectContaining({ device: DEV_S, session: L.one, pending })])
  })

  it('an attach that replaces a coordinator Laptop hosts nothing for is a plain attach: the session is hosted by its sender and the attach is taken', () => {
    const id = '7b300000-0000-4000-8000-000000000001'
    const { s: fresh } = deviceWorlds()
    fresh.mail.add(checkMailRecord({
      v: 1, id, from: { device: DEV_C, session: NEW.coord, name: 'coord · Studio' }, to: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      replyTo: null, text: 'Attached.', sentAt: NOW, delivered: false, read: false, kind: 'attach', project: 'acme', replaces: S.two
    })!)
    expect(fresh.store.hosted(L.one)).toMatchObject({ coordinator: { device: DEV_C, session: NEW.coord }, project: 'acme' })
    expect(fresh.mail.get(id)).toMatchObject({ delivered: true, read: true })
  })

  it('a pending attach that a replacing coordinator moved is confirmed once Laptop takes the replacing attach', () => {
    c.hub.detach('tab-c', 'e10000')
    c.hub.attach('tab-c', 'e10000')
    c.hub.make('tab-2', true)
    const replacing = records(c, 'attach').at(-1)!.id
    sync(c, s)
    expect(records(c, 'attach').find((r) => r.id === replacing)).toMatchObject({ delivered: true })
    expect(c.store.coordinator(S.two)!.attachments).toEqual([expect.objectContaining({ device: DEV_S, session: L.one, pending: null })])
  })
})

describe('start on another device', () => {
  const REFUSAL = '7c000000-0000-4000-8000-000000000003'
  const START_LAPTOP = { task: 'Write the release notes.', name: 'Release notes', folder: null, device: 'laptop', worktree: null }
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
  let c: World

  beforeEach(() => {
    c = world({ self: DEV_C, selfName: 'Studio' })
    c.peers = [peerOf(DEV_S, 'Laptop')]
    c.hub.make('tab-c', false)
  })

  it('start on Laptop opens a tab there in the folder of its acme tab with the coordinator\'s email, and is Starting… until the session comes', async () => {
    c.tabs[0] = { ...c.tabs[0], account: 'acc-1' }
    c.emails = { 'acc-1': 'sam@example.com' }
    c.remoteTabs = [remoteTab({ tabId: 'tab-l2', session: L.two, name: 'docs · Laptop' })]
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    expect(c.openedRemote).toEqual([{ device: DEV_S, req: { cwd: '/home/sam/acme', email: 'sam@example.com', title: 'Release notes' } }])
    // the Starting… row names the tab it opened on Laptop, the tab a row of another device carries
    expect(c.hub.view('tab-c')!.sessions).toEqual([expect.objectContaining({ key: 'start:rt-new', tabId: 'rt-new', marker: 'starting', line: 'Starting…', device: DEV_S, deviceName: 'Laptop' })])
    c.remoteTabs.push(remoteTab({ tabId: 'rt-new', session: L.fresh, name: 'Release notes · Laptop' }))
    c.hub.remoteChanged()
    expect(await answer).toEqual({
      ok: true,
      info: 'Started Release notes · Laptop [e40000] on Laptop in /home/sam/acme, the folder of its acme tab, on Main account; it is attached to you once Laptop confirms. Its task is its first message; its report comes to you by itself when its task ends.'
    })
    expect(records(c, 'attach')).toEqual([expect.objectContaining({ to: expect.objectContaining({ device: DEV_S, session: L.fresh }) })])
    expect(records(c, 'task')).toEqual([expect.objectContaining({ to: expect.objectContaining({ session: L.fresh }), text: 'Write the release notes.' })])
  })

  it('a coordinator without a known email starts the session on Laptop\'s main account; a folder Laptop refuses is named', async () => {
    c.remoteAnswer = { ok: true, tabId: 'rt-new', cwd: '/home/sam', accountName: 'Main account', defaulted: true }
    const answer = c.hub.start('tab-c', { ...START_LAPTOP, folder: '/nope' })
    await tick()
    expect(c.openedRemote).toEqual([{ device: DEV_S, req: { cwd: '/nope', email: null, title: 'Release notes' } }])
    c.remoteTabs.push(remoteTab({ tabId: 'rt-new', session: L.fresh, name: 'Release notes · Laptop', folder: '/home/sam' }))
    c.hub.remoteChanged()
    expect(await answer).toEqual({
      ok: true,
      info: 'Started Release notes · Laptop [e40000] on Laptop in /home/sam, its default folder (/nope is not a folder there), on Main account; it is attached to you once Laptop confirms. Its task is its first message; its report comes to you by itself when its task ends.'
    })
  })

  it('with no acme tab on Laptop it asks for no folder, and the answer says it opened in the default folder', async () => {
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    expect(c.openedRemote).toEqual([{ device: DEV_S, req: { cwd: null, email: null, title: 'Release notes' } }])
    c.remoteTabs.push(remoteTab({ tabId: 'rt-new', session: L.fresh, name: 'Release notes · Laptop', folder: '/home/sam' }))
    c.hub.remoteChanged()
    expect(await answer).toEqual({
      ok: true,
      info: 'Started Release notes · Laptop [e40000] on Laptop in /home/sam, its default folder (no acme tab is open there), on Main account; it is attached to you once Laptop confirms. Its task is its first message; its report comes to you by itself when its task ends.'
    })
  })

  it('an unknown device, an offline one, one without coordinator records and one without mail are refused, and nothing opens', async () => {
    const start = { task: 'Write the release notes.', name: null, folder: null, device: 'Tablet', worktree: null }
    expect(await c.hub.start('tab-c', start)).toEqual({ ok: false, error: 'No paired device named "Tablet".' })
    c.peers = [peerOf(DEV_S, 'Laptop', { online: false })]
    expect(await c.hub.start('tab-c', { ...start, device: 'Laptop' })).toEqual({ ok: false, error: 'Laptop is not connected; its sessions can be attached or started while it is.' })
    c.peers = [peerOf(DEV_S, 'Laptop', { coord: false })]
    expect(await c.hub.start('tab-c', { ...start, device: 'Laptop' })).toEqual({
      ok: false,
      error: 'Laptop runs a ClaudeTerm that does not know coordinators; update ClaudeTerm there to coordinate its sessions.'
    })
    c.peers = [peerOf(DEV_S, 'Laptop', { mail: false })]
    expect(await c.hub.start('tab-c', { ...start, device: 'Laptop' })).toEqual({
      ok: false,
      error: `Laptop does not take agent messages now, which coordinating its sessions needs: they are turned off there, or its Claude Code is older than ${MAIL_MIN_CLAUDE}.`
    })
    expect(c.openedRemote).toEqual([])
  })

  it('Laptop\'s refusal to open is the answer', async () => {
    c.remoteAnswer = { ok: false, error: 'The tab could not be opened' }
    expect(await c.hub.start('tab-c', START_LAPTOP)).toEqual({ ok: false, error: 'The tab could not be opened' })
    expect(c.hub.view('tab-c')!.sessions).toEqual([])
  })

  it('a device named as this device starts the session here, as part 1 does', async () => {
    void c.hub.start('tab-c', { ...START_LAPTOP, device: 'studio' })
    await tick()
    expect(c.opened).toHaveLength(1)
    expect(c.openedRemote).toEqual([])
  })

  it('a remote tab that closes before its session starts drops the start, once Laptop has listed the tab', async () => {
    c.remoteTabs = [remoteTab({ tabId: 'rt-new', session: null, name: null })]
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    c.hub.remoteChanged()
    expect(c.hub.view('tab-c')!.sessions).toEqual([expect.objectContaining({ key: 'start:rt-new', marker: 'starting' })])
    c.remoteTabs = []
    c.hub.remoteChanged()
    expect(await answer).toEqual({ ok: false, error: 'The new tab closed before its session started.' })
    expect(c.hub.view('tab-c')!.sessions).toEqual([])
    expect(records(c, 'attach')).toEqual([])
  })

  it('a remote start whose tab Laptop has not listed is not closed by a list without it: only START_WAIT_MS ends its wait', async () => {
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    c.hub.remoteChanged()
    expect(c.hub.view('tab-c')!.sessions).toEqual([expect.objectContaining({ key: 'start:rt-new', marker: 'starting' })])
    fire(c)
    expect(await answer).toEqual({
      ok: true,
      info: 'Opening Release notes on Laptop in /home/sam, its default folder (no acme tab is open there), on Main account. It shows as Starting… until its session starts; its task is sent then.'
    })
    expect(c.hub.view('tab-c')!.sessions).toEqual([expect.objectContaining({ key: 'start:rt-new', marker: 'starting' })])
  })

  it('the wait for a remote start counts from the start of the call: the time Laptop took is taken off START_WAIT_MS, and it is at least 1 s', async () => {
    c.remoteDelayMs = 15_000
    c.remoteAnswer = { ok: true, tabId: 'rt-a', cwd: '/home/sam/acme', accountName: 'Main account', defaulted: false }
    void c.hub.start('tab-c', START_LAPTOP)
    await tick()
    c.remoteDelayMs = 19_500
    c.remoteAnswer = { ok: true, tabId: 'rt-b', cwd: '/home/sam/acme', accountName: 'Main account', defaulted: false }
    void c.hub.start('tab-c', START_LAPTOP)
    await tick()
    expect(c.timers.map((t) => t.ms)).toEqual([START_WAIT_MS - 15_000, 1000])
  })

  it('a remote start counts toward the attachments of its coordinator: the start past 200 is refused with fullAttached', async () => {
    const coordinator = c.store.coordinator(S.coord)!
    c.store.putCoordinator({
      ...coordinator,
      attachments: Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => ({ device: null, session: uid(0x10000 + i), name: `session ${i}`, attachedAt: NOW, resolved: false, failed: false, lastReport: null, pending: null }))
    })
    void c.hub.start('tab-c', START_LAPTOP)
    await tick()
    expect(await c.hub.start('tab-c', START_LAPTOP)).toEqual({
      ok: false,
      error: `This coordinator has ${MAX_ATTACHMENTS} sessions attached already, the most it keeps; detach one first.`
    })
    expect(c.openedRemote).toHaveLength(1)
  })

  it('a remote start does not count toward the attached sessions of this device: it starts with 500 hosted already', async () => {
    for (let i = 0; i < MAX_HOSTED; i++) {
      c.store.putHosted({ session: uid(0x20000 + i), coordinator: { device: null, session: uid(0x30000), name: 'other' }, project: 'other', tasks: [], former: [] })
    }
    void c.hub.start('tab-c', START_LAPTOP)
    await tick()
    expect(c.openedRemote).toHaveLength(1)
  })

  it('a remote start whose attach Laptop refuses marks its task delivered and read, so it leaves no unread mark', async () => {
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    c.remoteTabs = [remoteTab({ tabId: 'rt-new', session: L.fresh, name: 'Release notes · Laptop' })]
    c.hub.remoteChanged()
    const attachId = records(c, 'attach')[0].id
    const taskId = records(c, 'task')[0].id
    expect(c.mail.get(taskId)).toMatchObject({ delivered: false, read: false })
    c.mail.add({
      v: 1,
      id: REFUSAL,
      from: { device: DEV_S, session: L.fresh, name: 'Release notes · Laptop' },
      to: { device: DEV_C, session: S.coord, name: 'coord · Studio' },
      replyTo: attachId,
      text: 'Refused.',
      sentAt: NOW,
      delivered: false,
      read: false,
      kind: 'detach'
    })
    expect(c.store.coordinator(S.coord)!.attachments).toEqual([])
    expect(c.mail.get(taskId)).toMatchObject({ delivered: true, read: true })
    await answer
  })

  it('a pending remote start does not take this device\'s hosted slot from a local start: with 499 hosted and one remote start pending, a local start opens', async () => {
    for (let i = 0; i < MAX_HOSTED - 1; i++) {
      c.store.putHosted({ session: uid(0x20000 + i), coordinator: { device: null, session: uid(0x30000), name: 'other' }, project: 'other', tasks: [], former: [] })
    }
    void c.hub.start('tab-c', START_LAPTOP)
    await tick()
    void c.hub.start('tab-c', { ...START_LAPTOP, device: null })
    await tick()
    expect(c.opened).toHaveLength(1)
  })

  it('the task of a remote start is stamped no earlier than its attach, and than the attachment, when the clock moves between the two writes', async () => {
    // the clock moves on each record the mail takes: the attach is written, then the task
    const add = c.mail.add.bind(c.mail)
    c.mail.add = (r: MailRecord) => {
      c.now += 5000
      add(r)
    }
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    c.remoteTabs = [remoteTab({ tabId: 'rt-new', session: L.fresh, name: 'Release notes · Laptop' })]
    c.hub.remoteChanged()
    await answer
    const attach = records(c, 'attach')[0]
    const task = records(c, 'task')[0]
    expect(task.sentAt).toBeGreaterThanOrEqual(attach.sentAt)
    expect(task.sentAt).toBeGreaterThanOrEqual(c.store.coordinator(S.coord)!.attachments[0].attachedAt)
  })

  it('a reply to open-tab that names a tab of this device is refused, and no tab of this device is taken for the start', async () => {
    c.remoteAnswer = { ok: true, tabId: 'tab-1', cwd: '/home/sam/acme', accountName: 'Main account', defaulted: false }
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    expect(await answer).toEqual({ ok: false, error: 'Laptop did not open a new tab; the start is refused.' })
    expect(c.hub.view('tab-c')!.sessions).toEqual([])
  })

  it('a local tab that later takes the tab id of a remote start does not settle that start', async () => {
    c.remoteAnswer = { ok: true, tabId: 'rt-x', cwd: '/home/sam/acme', accountName: 'Main account', defaulted: false }
    void c.hub.start('tab-c', START_LAPTOP)
    await tick()
    const local = uid(0x40000)
    c.tabs.push(tab('rt-x', local, ACME))
    c.hub.tabSession('rt-x', local)
    expect(c.store.hosted(local)).toBeNull()
    expect(records(c, 'task')).toEqual([])
  })

  it('a pending remote start follows its coordinator to the new id a /clear gives it: its task and attach come from the new id', async () => {
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    c.hub.tabSession('tab-c', NEW.coord)
    c.hub.sessionStarted('tab-c', S.coord, NEW.coord, 'clear')
    c.remoteTabs.push(remoteTab({ tabId: 'rt-new', session: L.fresh, name: 'Release notes · Laptop' }))
    c.hub.remoteChanged()
    await answer
    expect(records(c, 'task')).toEqual([expect.objectContaining({ from: expect.objectContaining({ session: NEW.coord }), to: expect.objectContaining({ session: L.fresh }) })])
    expect(c.store.coordinator(NEW.coord)!.attachments).toEqual([expect.objectContaining({ session: L.fresh })])
  })

  it('a pending remote start follows the coordinator that a replacing one takes over: its task and attach come from the replacing coordinator', async () => {
    const answer = c.hub.start('tab-c', START_LAPTOP)
    await tick()
    c.hub.make('tab-2', true)
    c.remoteTabs.push(remoteTab({ tabId: 'rt-new', session: L.fresh, name: 'Release notes · Laptop' }))
    c.hub.remoteChanged()
    await answer
    expect(records(c, 'task')).toEqual([expect.objectContaining({ from: expect.objectContaining({ session: S.two }), to: expect.objectContaining({ session: L.fresh }) })])
    expect(c.store.coordinator(S.two)!.attachments).toEqual([expect.objectContaining({ session: L.fresh })])
  })
})
