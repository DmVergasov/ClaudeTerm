import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkMailRecord } from '../../src/main/mail/mail-record'
import type { CoordSessionRow, CoordinatorView } from '../../src/shared/coordinator'
import { attachDirect, cleanWorlds, DEV_C, DEV_S, L, NO_FACTS, NOW, peerOf, remoteTab, S, world, type World } from '../fixtures/coordinator-world'

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
