import { describe, expect, it } from 'vitest'
import type { CoordGroup, CoordinatorView, CoordMarks, CoordSessionRow } from '../../src/shared/coordinator'
import { attachChoices, cardRow, checkStartForm, DEFAULT_FOLDED, FOLDER_ERROR, folderPlaceholder, NAME_ERROR, nextRedrawAt, REMOTE_FOLDER_ERROR, rowActions, rowIcon, rowTime, sessionSections, startDevices, startError, WORKTREE_ERROR, type AttachTab } from '../../src/renderer/sessions-model'

const row = (key: string, group: CoordGroup, o: Partial<CoordSessionRow> = {}): CoordSessionRow => ({
  key, tabId: `tab-${key}`, device: null, deviceName: null, session: 'a1000000-0000-4000-8000-000000000002', ref: 'a10000', name: `${key} · Desktop`,
  folder: 'D:\\Work\\acme', branch: 'main', group, why: null, marker: null, line: 'Idle', progress: null, changedAt: 0, task: null, lastReport: null, attachedTo: null, ...o
})
const view = (sessions: CoordSessionRow[], notAttached: CoordSessionRow[] = []): CoordinatorView =>
  ({ tabId: 'tab-c', session: 'c0000000-0000-4000-8000-000000000001', project: { key: 'd:\\work\\acme', name: 'acme' }, problem: null, sessions, notAttached, waiting: 0 })

describe('cardRow finds the row a report card names', () => {
  it('its ref names the row among the attached rows, and for Open among the project\'s others; Resolve acts on attached rows only', () => {
    const mine = row('mine', 'idle', { ref: 'a10000' })
    const other = row('other', 'idle', { ref: 'b20000', name: 'docs · Desktop' })
    const v = view([mine], [other])
    expect(cardRow(v, 'a10000', 'parser · Desktop', false)).toBe(mine)
    expect(cardRow(v, 'b20000', 'docs · Desktop', true)).toBe(other)
    expect(cardRow(v, 'b20000', 'docs · Desktop', false)).toBeNull()
  })

  it('a card whose ref is stale (a /clear gave the session a new id) finds the row of the same name', () => {
    const renamed = row('new', 'idle', { ref: 'c30000', name: 'parser · Desktop' })
    expect(cardRow(view([renamed]), 'a10000', 'parser · Desktop', false)).toBe(renamed)
    expect(cardRow(view([], [renamed]), 'a10000', 'parser · Desktop', true)).toBe(renamed)
  })

  it('a card that names no row of the ref or the name finds none', () => {
    expect(cardRow(view([row('x', 'idle')]), 'z90000', 'other · Desktop', true)).toBeNull()
  })
})

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
  expect(rowIcon(row('a', 'waiting', { why: 'question' }), 'waiting')).toBe('amber')
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
it('checkStartForm trims the fields and makes an empty optional field null', () => {
  expect(checkStartForm({ task: ' Write the notes. ', name: '', folder: '  ', worktree: '' })).toEqual({ req: { task: 'Write the notes.', name: null, folder: null, worktree: null } })
  expect(checkStartForm({ task: 'x', name: ' Notes ', folder: 'D:\\Work\\acme', worktree: 'notes-1' })).toEqual({ req: { task: 'x', name: 'Notes', folder: 'D:\\Work\\acme', worktree: 'notes-1' } })
  expect(checkStartForm({ task: 'x', name: '', folder: '/home/sam/acme', worktree: '' })).toMatchObject({ req: { folder: '/home/sam/acme' } })
})
it('checkStartForm refuses a blank task, a relative folder and a worktree name with a space or a slash', () => {
  expect(checkStartForm({ task: '  ', name: '', folder: '', worktree: '' })).toEqual({ error: 'A task needs a text.' })
  expect(checkStartForm({ task: 'x', name: '', folder: 'acme/sub', worktree: '' })).toEqual({ error: FOLDER_ERROR })
  expect(checkStartForm({ task: 'x', name: '', folder: '', worktree: 'a b' })).toEqual({ error: WORKTREE_ERROR })
  expect(checkStartForm({ task: 'x', name: '', folder: '', worktree: 'a/b' })).toEqual({ error: WORKTREE_ERROR })
})
it('checkStartForm accepts a full path of either system and refuses a name with a control character', () => {
  for (const folder of ['C:\\Work\\acme', 'C:/Work/acme', '\\\\server\\share', '/x']) expect(checkStartForm({ task: 'x', name: '', folder, worktree: '' })).toMatchObject({ req: { folder } })
  expect(checkStartForm({ task: 'x', name: 'Notes\u0007', folder: '', worktree: '' })).toEqual({ error: NAME_ERROR })
  expect(checkStartForm({ task: 'x', name: 'No\tte', folder: '', worktree: '' })).toEqual({ error: NAME_ERROR })
})
it('checkStartForm takes a folder of another device as that device\'s path: up to 4096 characters with no control character, any shape', () => {
  expect(checkStartForm({ task: 'x', name: '', folder: 'acme/sub', worktree: '' }, true)).toEqual({ req: { task: 'x', name: null, folder: 'acme/sub', worktree: null } })
  expect(checkStartForm({ task: 'x', name: '', folder: 'C:\\work\\acme', worktree: '' }, true)).toMatchObject({ req: { folder: 'C:\\work\\acme' } })
  expect(checkStartForm({ task: 'x', name: '', folder: 'a\u0007b', worktree: '' }, true)).toEqual({ error: REMOTE_FOLDER_ERROR })
  expect(checkStartForm({ task: 'x', name: '', folder: 'x'.repeat(4097), worktree: '' }, true)).toEqual({ error: REMOTE_FOLDER_ERROR })
  // this device's folder is still a full path here
  expect(checkStartForm({ task: 'x', name: '', folder: 'acme/sub', worktree: '' })).toEqual({ error: FOLDER_ERROR })
})
it('folderPlaceholder shows this device\'s coordinator folder, and for a paired device the rule the dialog states', () => {
  expect(folderPlaceholder({ project: 'acme', device: null, folder: 'D:\\Work\\acme' })).toBe('D:\\Work\\acme')
  expect(folderPlaceholder({ project: 'acme', device: 'Laptop', folder: 'D:\\Work\\acme' })).toBe('Empty: the folder of a acme tab on Laptop, else its default folder')
})
it('startDevices lists this device first, then each online paired device by its name in the order given; with none online, no choice', () => {
  expect(startDevices([{ name: 'Laptop', online: true }, { name: 'Tablet', online: false }, { name: 'Desk', online: true }])).toEqual([
    { device: null, label: 'This device' },
    { device: 'Laptop', label: 'Laptop' },
    { device: 'Desk', label: 'Desk' }
  ])
  expect(startDevices([{ name: 'Tablet', online: false }])).toEqual([])
  expect(startDevices([])).toEqual([])
})
it('startError is null for a start that was made, says the fields are refused for an invalid request, and shows any other error', () => {
  expect(startError({ ok: true })).toBeNull()
  expect(startError({ ok: false, error: 'Invalid request' })).toBe('ClaudeTerm refused these fields.')
  expect(startError({ ok: false, error: 'No folder D:\\gone on this device.' })).toBe('No folder D:\\gone on this device.')
})
it('attachChoices offers the other running Claude sessions, of this device and of a paired one, and says where one is attached', () => {
  const t = (id: string, o: Partial<AttachTab> = {}): AttachTab => ({ id, title: id, claude: true, device: null, session: `s-${id}`, exited: false, folder: `D:\\Work\\${id}`, branch: 'main', ...o })
  const marks: CoordMarks = { c: { role: 'coordinator', project: 'acme', sessions: 1, waiting: 0 }, a: { role: 'attached', project: 'acme', coordinator: 'c · Desktop', coordinatorTabId: 'c' },
    b: { role: 'attached', project: 'beta', coordinator: 'k · Desktop', coordinatorTabId: 'k' }, k: { role: 'coordinator', project: 'beta', sessions: 1, waiting: 0 } }
  const tabs = [t('c'), t('a'), t('b'), t('k'), t('x', { branch: null }), t('sh', { claude: false }), t('r', { device: 'Laptop' }), t('n', { session: null }), t('e', { exited: true }), t('p', { device: 'Laptop', exited: true })]
  expect(attachChoices(tabs, 'c', marks)).toEqual([
    { tabId: 'b', title: 'b', where: 'D:\\Work\\b · main', note: 'Attached to the beta coordinator' },
    { tabId: 'x', title: 'x', where: 'D:\\Work\\x', note: null },
    { tabId: 'r', title: 'r', where: 'Laptop · D:\\Work\\r · main', note: null }
  ])
})
