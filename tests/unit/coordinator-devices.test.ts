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

  it('a task written to a remote session is queued in its row until its device lists it', () => {
    attachDirect(c)
    c.remoteTabs = [remoteTab()]
    c.mail.add(checkMailRecord({
      v: 1, id: TASK, from: { device: DEV_C, session: S.coord, name: 'coord · Studio' }, to: { device: DEV_S, session: L.one, name: 'parser · Laptop' },
      replyTo: null, text: 'Fix the parser.', sentAt: NOW, delivered: false, read: false, kind: 'task', project: 'acme'
    })!)
    expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ task: { id: TASK, state: 'queued', since: NOW }, line: 'Task waiting until the session is idle' })
  })

  it('a confirmed remote attachment marks the other device\'s tab in this window; a pending one does not', () => {
    attachDirect(c)
    c.remoteTabs = [remoteTab()]
    expect(c.hub.marks()['tab-l1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId: 'tab-c' })
    attachDirect(c, ATTACH_ID)
    expect(c.hub.marks()['tab-l1']).toBeUndefined()
  })
})
