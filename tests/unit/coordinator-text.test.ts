import { describe, expect, it } from 'vitest'
import { listText, readText } from '../../src/main/coordinator/session-text'
import type { CoordSessionRow, CoordinatorView } from '../../src/shared/coordinator'

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16)

const row = (over: Partial<CoordSessionRow>): CoordSessionRow => ({
  key: 'local:x', tabId: null, device: null, deviceName: null, session: null, ref: null, name: 'x', folder: null, branch: null,
  group: 'idle', why: null, marker: null, line: 'Idle', progress: null, changedAt: 0, task: null, lastReport: null, attachedTo: null,
  ...over
})

describe('listText', () => {
  it('groups the attached rows, lists the project\'s others, and adds the notes that apply', () => {
    const waiting = row({
      key: 'local:s1', ref: '8f3a2c', name: 'Desk · Api', folder: 'D:\\Workspace\\ClaudeTerm', branch: 'feat/x',
      group: 'waiting', why: 'prompt', line: 'Allow Bash: npm test'
    })
    const working = row({
      key: 'local:s2', ref: '77ab10', name: 'Desk · Web', folder: 'D:\\Workspace\\Site', group: 'working', line: 'Working on its task',
      task: { id: 't9', state: 'open', since: Date.UTC(2026, 10, 14, 21, 5) },
      lastReport: { id: 'r1', outcome: 'stopped', reason: 'its tab was closed', at: Date.UTC(2026, 10, 14, 21, 40) }
    })
    const notAttached = row({
      key: 'local:s3', ref: 'c41d02', name: 'Desk · Docs', folder: 'D:\\Workspace\\Docs', group: 'idle', line: 'Idle', attachedTo: 'Other coordinator'
    })
    const view: CoordinatorView = {
      tabId: 'tab-1', session: 'coord-1', project: { key: 'desk', name: 'Desk' }, problem: null,
      sessions: [waiting, working], notAttached: [notAttached], waiting: 1
    }
    expect(listText(view, clock)).toBe([
      'Desk coordinator · 2 attached',
      'Waiting on you (1):',
      '- Desk · Api [8f3a2c] · Allow Bash: npm test · D:\\Workspace\\ClaudeTerm · feat/x',
      'Working (1):',
      '- Desk · Web [77ab10] · Working on its task · D:\\Workspace\\Site · task open since 21:05 · last report stopped 21:40',
      'Not attached (this project):',
      '- Desk · Docs [c41d02] · Idle · D:\\Workspace\\Docs · attached to Other coordinator',
      'Notes:',
      '- Reports come to you by themselves when a task ends; there is no need to poll or wait.',
      '- A permission prompt or question waits for the user in Desk · Api: it is theirs to answer there; tell them once where it waits.',
      '- A stopped task was stopped by the user.'
    ].join('\n'))
  })

  it('a usage limit adds its note, and a finished report idles in Idle', () => {
    const limited = row({
      key: 'local:s4', ref: 'd01e55', name: 'Desk · Ops', group: 'waiting', why: 'limit', line: 'Usage limit · resets 22:00',
      lastReport: { id: 'r2', outcome: 'finished', reason: null, at: Date.UTC(2026, 10, 14, 20, 15) }
    })
    const view: CoordinatorView = {
      tabId: 'tab-1', session: 'coord-1', project: { key: 'desk', name: 'Desk' }, problem: null,
      sessions: [limited], notAttached: [], waiting: 1
    }
    expect(listText(view, clock)).toBe([
      'Desk coordinator · 1 attached',
      'Waiting on you (1):',
      '- Desk · Ops [d01e55] · Usage limit · resets 22:00 · last report finished 20:15',
      'Notes:',
      '- Reports come to you by themselves when a task ends; there is no need to poll or wait.',
      '- A usage limit is not a failure: the session goes on after the reset.'
    ].join('\n'))
  })

  it('with nothing attached says how to attach or start one, and shows the problem', () => {
    const view: CoordinatorView = {
      tabId: 'tab-1', session: 'coord-1', project: { key: 'desk', name: 'Desk' },
      problem: 'Coordinating sessions needs agent messages, which are turned off in ClaudeTerm on this device. Turn them on in Settings, Agent messages.',
      sessions: [], notAttached: [], waiting: 0
    }
    expect(listText(view, clock)).toBe([
      'Desk coordinator · 0 attached',
      'Coordinating sessions needs agent messages, which are turned off in ClaudeTerm on this device. Turn them on in Settings, Agent messages.',
      'No sessions are attached. Attach one with attach_session, or start one with start_session.',
      'Notes:',
      '- Reports come to you by themselves when a task ends; there is no need to poll or wait.'
    ].join('\n'))
  })

  it('keeps a control character out of a name', () => {
    const view: CoordinatorView = {
      tabId: 'tab-1', session: 'coord-1', project: { key: 'desk', name: 'Desk' }, problem: null,
      sessions: [row({ key: 'local:s5', ref: 'a1b2c3', name: 'Desk\u0007 · Api', group: 'idle', line: 'Idle' })], notAttached: [], waiting: 0
    }
    expect(listText(view, clock)).toBe([
      'Desk coordinator · 1 attached',
      'Idle (1):',
      '- Desk  · Api [a1b2c3] · Idle',
      'Notes:',
      '- Reports come to you by themselves when a task ends; there is no need to poll or wait.'
    ].join('\n'))
  })

  it('listText notes an Offline row and an Attaching… row', () => {
    const offline = row({ key: 'd1:x', device: 'd1', deviceName: 'Laptop', session: 'e1000000-0000-4000-8000-000000000011', ref: 'e10000', name: 'parser · Laptop', group: 'idle', marker: 'offline', line: 'Offline' })
    const attaching = row({ key: 'd1:y', device: 'd1', deviceName: 'Laptop', session: 'e2000000-0000-4000-8000-000000000012', ref: 'e20000', name: 'docs · Laptop', group: 'idle', marker: 'attaching', line: 'Attaching…' })
    const view: CoordinatorView = {
      tabId: 'tab-c', session: 'c0000000-0000-4000-8000-000000000001', project: { key: 'd:\\work\\acme', name: 'acme' }, problem: null,
      sessions: [offline, attaching], notAttached: [], waiting: 0
    }
    const text = listText(view, clock)
    expect(text.split('\n').filter((l) => l.startsWith('- A session marked '))).toEqual([
      '- A session marked Offline is on a device that is not connected: a task given to it goes out when the device connects; detach_session works meanwhile.',
      '- A session marked Attaching… waits for its device to confirm it; it takes tasks once it does.'
    ])
    expect(text).toContain('- parser · Laptop [e10000] · Offline')
    expect(text).toContain('- docs · Laptop [e20000] · Attaching…')
  })
})

describe('readText', () => {
  it('shows the prompt as the user\'s, the open task, the task list and the last report in full', () => {
    const r = row({
      key: 'local:s1', ref: '8f3a2c', name: 'Desk · Api', folder: 'D:\\Workspace\\ClaudeTerm', branch: 'feat/x',
      group: 'waiting', why: 'prompt', line: 'Allow Bash: npm test',
      task: { id: 't1', state: 'open', since: Date.UTC(2026, 10, 14, 21, 5) },
      lastReport: { id: 'r1', outcome: 'failed', reason: 'Claude Code exited', at: Date.UTC(2026, 10, 14, 21, 40) }
    })
    expect(readText(r, {
      prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: 0 },
      report: 'The task failed: Claude Code exited.\n\nIts last answer:\n\nTests are green.',
      taskList: { title: 'Triage', tasks: [{ title: 'Reproduce', status: 'completed' }, { title: 'Fix', status: 'in_progress' }] }
    }, clock)).toBe([
      'Desk · Api [8f3a2c]',
      'State: Waiting on you · Allow Bash: npm test',
      'Folder: D:\\Workspace\\ClaudeTerm · Branch: feat/x',
      'Waiting for the user: Allow Bash: npm test. It is the user\'s to answer in that session.',
      'Open task: open since 21:05 (id t1)',
      'Task list: Triage: 1 of 2 done',
      '1. [completed] Reproduce',
      '2. [in_progress] Fix',
      'Last report: failed: Claude Code exited 21:40',
      'The task failed: Claude Code exited.',
      '',
      'Its last answer:',
      '',
      'Tests are green.'
    ].join('\n'))
  })

  it('says when a report is no longer kept, and when there is none yet', () => {
    const kept = row({
      key: 'local:s2', name: 'Desk · Web', group: 'working', line: 'Working',
      lastReport: { id: 'r3', outcome: 'finished', reason: null, at: Date.UTC(2026, 10, 14, 19, 30) }
    })
    expect(readText(kept, { prompt: null, report: null, taskList: null }, clock)).toBe([
      'Desk · Web',
      'State: Working · Working',
      'No open task.',
      'Last report: finished 19:30',
      '(The report is no longer kept.)'
    ].join('\n'))

    const fresh = row({ key: 'local:s3', name: 'Desk · Docs', group: 'idle', line: 'Idle' })
    expect(readText(fresh, { prompt: null, report: null, taskList: null }, clock)).toBe([
      'Desk · Docs',
      'State: Idle · Idle',
      'No open task.',
      'No report yet.'
    ].join('\n'))
  })
})
