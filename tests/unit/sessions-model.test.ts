import { describe, expect, it } from 'vitest'
import type { CoordGroup, CoordinatorView, CoordSessionRow } from '../../src/shared/coordinator'
import { DEFAULT_FOLDED, nextRedrawAt, rowActions, rowIcon, rowTime, sessionSections } from '../../src/renderer/sessions-model'

const row = (key: string, group: CoordGroup, o: Partial<CoordSessionRow> = {}): CoordSessionRow => ({
  key, tabId: `tab-${key}`, device: null, deviceName: null, session: 'a1000000-0000-4000-8000-000000000002', ref: 'a10000', name: `${key} · Desktop`,
  folder: 'D:\\Work\\acme', branch: 'main', group, why: null, marker: null, line: 'Idle', progress: null, changedAt: 0, task: null, lastReport: null, attachedTo: null, ...o
})
const view = (sessions: CoordSessionRow[], notAttached: CoordSessionRow[] = []): CoordinatorView =>
  ({ tabId: 'tab-c', session: 'c0000000-0000-4000-8000-000000000001', project: { key: 'd:\\work\\acme', name: 'acme' }, problem: null, sessions, notAttached, waiting: 0 })

it('sections come in the order waiting, working, idle, resolved, then the project\'s others; an empty one is left out', () => {
  const s = sessionSections(view([row('a', 'idle'), row('b', 'waiting'), row('c', 'idle')], [row('d', 'idle')]), new Set(DEFAULT_FOLDED))
  expect(s.map((x) => [x.key, x.label, x.rows.map((r) => r.key), x.folded])).toEqual([
    ['waiting', 'Waiting on you', ['b'], false], ['idle', 'Idle', ['a', 'c'], false], ['not-attached', 'Not attached', ['d'], false]
  ])
})
it('a folded section keeps its rows, for its count', () => {
  expect(sessionSections(view([row('r', 'resolved')]), new Set(DEFAULT_FOLDED))).toEqual([{ key: 'resolved', label: 'Resolved', rows: [expect.objectContaining({ key: 'r' })], folded: true }])
})
it('rowActions: Open with a tab, Message and Detach for an attached row; Resolve in Idle and after a failure; Attach for the others; Open and Detach while it starts', () => {
  expect(rowActions(row('a', 'working'), 'working')).toEqual(['open', 'message', 'detach'])
  expect(rowActions(row('a', 'idle'), 'idle')).toEqual(['open', 'message', 'detach', 'resolve'])
  expect(rowActions(row('a', 'waiting', { why: 'failed' }), 'waiting')).toEqual(['open', 'message', 'detach', 'resolve'])
  expect(rowActions(row('a', 'idle', { tabId: null }), 'idle')).toEqual(['message', 'detach', 'resolve'])
  expect(rowActions(row('a', 'working', { marker: 'starting' }), 'working')).toEqual(['open', 'detach'])
  expect(rowActions(row('a', 'working', { marker: 'starting', tabId: null }), 'working')).toEqual(['detach'])
  expect(rowActions(row('a', 'idle'), 'not-attached')).toEqual(['attach'])
  expect(rowActions(row('a', 'idle', { tabId: null }), 'not-attached')).toEqual([])
})
it('rowIcon: amber for a pending prompt, red for a limit or a failure, the spinner at work or starting, a check when idle or resolved, grey for the others and an offline session', () => {
  expect(rowIcon(row('a', 'waiting', { why: 'prompt' }), 'waiting')).toBe('amber')
  expect(rowIcon(row('a', 'waiting', { why: 'limit' }), 'waiting')).toBe('red')
  expect(rowIcon(row('a', 'waiting', { why: 'failed' }), 'waiting')).toBe('red')
  expect(rowIcon(row('a', 'working'), 'working')).toBe('spin')
  expect(rowIcon(row('a', 'working', { marker: 'starting' }), 'working')).toBe('spin')
  expect(rowIcon(row('a', 'idle'), 'idle')).toBe('check')
  expect(rowIcon(row('a', 'resolved'), 'resolved')).toBe('check')
  expect(rowIcon(row('a', 'idle', { marker: 'offline' }), 'idle')).toBe('grey')
  expect(rowIcon(row('a', 'working'), 'not-attached')).toBe('grey')
})
it('rowTime says now within a minute, the clock time today, and the day before that', () => {
  const at = new Date(2026, 10, 14, 9, 5).getTime()
  expect(rowTime(at, at + 59_000)).toBe('now')
  expect(rowTime(at + 5000, at)).toBe('now')
  expect(rowTime(at, new Date(2026, 10, 14, 19, 0).getTime())).toBe('09:05')
  expect(rowTime(new Date(2026, 10, 13, 23, 59).getTime(), new Date(2026, 10, 14, 0, 30).getTime())).toBe('Nov 13')
})
describe('nextRedrawAt', () => {
  const now = new Date(2026, 10, 14, 9, 5).getTime()
  it('is null when no row shows now', () => {
    expect(nextRedrawAt([], now)).toBeNull()
    expect(nextRedrawAt([row('a', 'idle', { changedAt: now - 60_000 })], now)).toBeNull()
  })
  it('is a minute after the change of the first row that shows now to stop', () => {
    expect(nextRedrawAt([row('a', 'idle', { changedAt: now - 20_000 }), row('b', 'idle', { changedAt: now - 50_000 }), row('c', 'idle', { changedAt: now - 120_000 })], now)).toBe(now + 10_000)
  })
  it('a row changed ahead of now counts from its own change', () => {
    expect(nextRedrawAt([row('a', 'idle', { changedAt: now + 5_000 })], now)).toBe(now + 65_000)
  })
})
