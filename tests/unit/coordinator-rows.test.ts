import { describe, expect, it } from 'vitest'
import { findRow, rowState, type RowFacts } from '../../src/main/coordinator/session-state'
import type { CoordSessionRow } from '../../src/shared/coordinator'
import type { PlanStatus } from '../../src/shared/types'

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16)

const idle: RowFacts = {
  marker: null, closed: false, exited: false, working: false, prompt: null, limit: null,
  progress: null, task: null, resolved: false, failed: false, lastReport: null
}

const plan = (over: Partial<PlanStatus>): PlanStatus => ({ title: 'Triage', tasks: [], done: 3, total: 7, finished: false, ...over })

describe('rowState', () => {
  it('starting is its own line and works', () => {
    expect(rowState({ ...idle, marker: 'starting' }, clock)).toEqual({ group: 'working', why: null, line: 'Starting…', progress: null })
  })

  it('Attaching… and Offline are their own lines; the group stays what the facts give', () => {
    expect(rowState({ ...idle, marker: 'attaching' }, clock)).toEqual({ group: 'idle', why: null, line: 'Attaching…', progress: null })
    expect(rowState({ ...idle, marker: 'offline', working: true }, clock)).toMatchObject({ group: 'working', line: 'Offline' })
    expect(rowState({ ...idle, marker: 'offline', prompt: { kind: 'question', text: null, since: 0 } }, clock)).toMatchObject({ group: 'waiting', why: 'prompt', line: 'Offline' })
  })

  it('a pending prompt waits on you with its line, before a limit or a failure', () => {
    expect(rowState({ ...idle, prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: 0 }, limit: { resetsAt: null, since: 0 }, failed: true }, clock))
      .toEqual({ group: 'waiting', why: 'prompt', line: 'Allow Bash: npm test', progress: null })
  })

  it('a prompt without text says what it waits for', () => {
    expect(rowState({ ...idle, prompt: { kind: 'permission', text: null, since: 0 } }, clock))
      .toEqual({ group: 'waiting', why: 'prompt', line: 'Waiting for your permission', progress: null })
    expect(rowState({ ...idle, prompt: { kind: 'question', text: null, since: 0 } }, clock))
      .toEqual({ group: 'waiting', why: 'prompt', line: 'Waiting for your answer', progress: null })
  })

  it('a usage limit says when it resets', () => {
    expect(rowState({ ...idle, limit: { resetsAt: Date.UTC(2026, 10, 14, 22, 0), since: 0 } }, clock))
      .toEqual({ group: 'waiting', why: 'limit', line: 'Usage limit · resets 22:00', progress: null })
  })

  it('a usage limit without a reset time is just Usage limit, before a failure', () => {
    expect(rowState({ ...idle, limit: { resetsAt: null, since: 0 }, failed: true, lastReport: { id: 'r1', outcome: 'failed', reason: 'x', at: 0 } }, clock))
      .toEqual({ group: 'waiting', why: 'limit', line: 'Usage limit', progress: null })
  })

  it('a failed task waits on you with its reason', () => {
    expect(rowState({ ...idle, failed: true, lastReport: { id: 'r1', outcome: 'failed', reason: 'Claude Code exited', at: 0 } }, clock))
      .toEqual({ group: 'waiting', why: 'failed', line: 'Failed: Claude Code exited', progress: null })
  })

  it('a failed task with no reason says so', () => {
    expect(rowState({ ...idle, failed: true, lastReport: null }, clock))
      .toEqual({ group: 'waiting', why: 'failed', line: 'Failed: no reason given', progress: null })
  })

  it('a failure that is cleared is only its last report, idle', () => {
    expect(rowState({ ...idle, failed: false, lastReport: { id: 'r1', outcome: 'failed', reason: 'x', at: 0 } }, clock))
      .toEqual({ group: 'idle', why: null, line: 'Failed', progress: null })
  })

  it('a closed tab says so, and an exited Claude Code says so', () => {
    expect(rowState({ ...idle, closed: true }, clock)).toEqual({ group: 'idle', why: null, line: 'Tab closed', progress: null })
    expect(rowState({ ...idle, exited: true }, clock)).toEqual({ group: 'idle', why: null, line: 'Claude Code exited', progress: null })
  })

  it('task list progress shows done/total and the current task while the list is open', () => {
    expect(rowState({ ...idle, working: true, progress: plan({ tasks: [{ n: 4, title: 'Grouping crashes by call stack', state: 'current' }] }) }, clock))
      .toEqual({ group: 'working', why: null, line: '3/7 · Grouping crashes by call stack', progress: { done: 3, total: 7 } })
  })

  it('task list progress falls back to the first task left, and to the counts alone', () => {
    expect(rowState({ ...idle, progress: plan({ tasks: [{ n: 1, title: 'Read the logs', state: 'done' }, { n: 2, title: 'Write the summary', state: 'left' }] }) }, clock))
      .toEqual({ group: 'idle', why: null, line: '3/7 · Write the summary', progress: { done: 3, total: 7 } })
    expect(rowState({ ...idle, progress: plan({ tasks: [] }) }, clock))
      .toEqual({ group: 'idle', why: null, line: '3/7', progress: { done: 3, total: 7 } })
  })

  it('a finished task list is no progress', () => {
    expect(rowState({ ...idle, progress: plan({ done: 7, total: 7, finished: true }) }, clock))
      .toEqual({ group: 'idle', why: null, line: 'Idle', progress: null })
  })

  it('an open task is Working even when no turn runs', () => {
    expect(rowState({ ...idle, task: { id: 't1', state: 'open', since: 0 } }, clock))
      .toEqual({ group: 'working', why: null, line: 'Working on its task', progress: null })
  })

  it('a queued task waits until the session is idle', () => {
    expect(rowState({ ...idle, task: { id: 't1', state: 'queued', since: 0 } }, clock))
      .toEqual({ group: 'working', why: null, line: 'Task waiting until the session is idle', progress: null })
  })

  it('a running turn with no task is Working', () => {
    expect(rowState({ ...idle, working: true }, clock)).toEqual({ group: 'working', why: null, line: 'Working', progress: null })
  })

  it("an open task's progress note is the line while no turn runs: its first line with text, cut at 100", () => {
    const open: RowFacts = { ...idle, task: { id: 't', state: 'open', since: 0 } }
    expect(rowState({ ...open, note: "\n  I wait for the person's go to push.\nTests run." }, clock))
      .toEqual({ group: 'working', why: null, line: "Background work · I wait for the person's go to push.", progress: null })
    expect(rowState({ ...open, note: 'x'.repeat(150) }, clock).line).toBe(`Background work · ${'x'.repeat(99)}…`)
    expect(rowState({ ...open, note: 'Waiting.', working: true }, clock).line).toBe('Working on its task')
    expect(rowState({ ...open, note: 'Waiting.', prompt: { kind: 'permission', text: 'Allow Bash: git push', since: 0 } }, clock).line).toBe('Allow Bash: git push')
    expect(rowState({ ...open, note: 'Waiting.', progress: plan({ tasks: [{ n: 1, title: 'Run e2e', state: 'current' }] }) }, clock).line).toBe('Background work · Waiting.')
    expect(rowState({ ...idle, task: { id: 't', state: 'queued', since: 0 }, note: 'Waiting.' }, clock).line).toBe('Task waiting until the session is idle')
  })

  it('a finished report idles with its line; a stopped and a failed report say so', () => {
    const report = (outcome: 'finished' | 'stopped' | 'failed') => ({ id: 'r1', outcome, reason: null, at: 0 })
    expect(rowState({ ...idle, lastReport: report('finished') }, clock))
      .toEqual({ group: 'idle', why: null, line: 'Finished · report ready', progress: null })
    expect(rowState({ ...idle, lastReport: report('stopped') }, clock))
      .toEqual({ group: 'idle', why: null, line: 'Stopped by you', progress: null })
    expect(rowState({ ...idle, lastReport: report('failed') }, clock))
      .toEqual({ group: 'idle', why: null, line: 'Failed', progress: null })
  })

  it('a resolved session goes to Resolved, whatever its last report says', () => {
    expect(rowState({ ...idle, resolved: true, lastReport: { id: 'r1', outcome: 'finished', reason: null, at: 0 } }, clock))
      .toEqual({ group: 'resolved', why: null, line: 'Finished · report ready', progress: null })
    expect(rowState({ ...idle, resolved: true }, clock))
      .toEqual({ group: 'resolved', why: null, line: 'Idle', progress: null })
  })

  it('a session with nothing to report is Idle', () => {
    expect(rowState(idle, clock)).toEqual({ group: 'idle', why: null, line: 'Idle', progress: null })
  })
})

describe('findRow', () => {
  const row = (over: Partial<CoordSessionRow>): CoordSessionRow => ({
    key: 'local:x', tabId: null, device: null, deviceName: null, session: null, ref: null, name: 'x', folder: null, branch: null,
    group: 'idle', why: null, marker: null, line: 'Idle', progress: null, changedAt: 0, task: null, lastReport: null, attachedTo: null,
    ...over
  })
  const api = row({ key: 'local:s1', name: 'Desk · Api', ref: '8f3a2c' })
  const web = row({ key: 'local:s2', name: 'Desk · Web', ref: '77ab10' })
  const other = row({ key: 'remote:dev1:s9', name: 'desk · API', ref: '5c0e77' })
  const rows = [api, web, other]

  it('finds a row by its key', () => {
    expect(findRow(rows, 'local:s2')).toEqual({ row: web })
  })

  it('finds a row by its name, in any case', () => {
    expect(findRow(rows, 'DESK · WEB')).toEqual({ row: web })
  })

  it('finds a row by its ref, bare or in brackets', () => {
    expect(findRow(rows, '77ab10')).toEqual({ row: web })
    expect(findRow(rows, '[77ab10]')).toEqual({ row: web })
  })

  it('says no session matches, in one line', () => {
    expect(findRow(rows, 'Nope')).toEqual({ error: 'No session "Nope" here; call list_sessions.' })
    expect(findRow(rows, '[123abc]')).toEqual({ error: 'No session "[123abc]" here; call list_sessions.' })
  })

  it('says several sessions match, and names them', () => {
    expect(findRow(rows, 'Desk · Api')).toEqual({
      error: '"Desk · Api" matches more than one session: Desk · Api, desk · API; use the full name.'
    })
  })
})
