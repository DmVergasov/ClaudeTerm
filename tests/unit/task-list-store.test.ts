import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_STORED_LISTS, parseTaskLists, TaskListStore } from '../../src/main/task-list-store'
import type { TaskList } from '../../src/shared/task-list'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const list = (title: string | null = 'Release'): TaskList => ({
  title,
  tasks: [
    { title: 'Write the notes', status: 'completed' },
    { title: 'Tag the release', status: 'pending' }
  ]
})
/** the time a file that is not a task list is moved aside at */
const T = 1_762_171_200_000
/** a session id for the n-th session of a test */
const sid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const dirs: string[] = []
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ct-task-lists-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('task list store', () => {
  it('set and flush write task-lists.json; a new store reads the list back', () => {
    const dir = newDir()
    const a = new TaskListStore(dir, { debounceMs: 60_000, now: () => 7 })
    a.set(SID, list())
    a.flush()
    expect(JSON.parse(readFileSync(join(dir, 'task-lists.json'), 'utf8'))).toEqual({ [SID]: { list: list(), changedAt: 7 } })
    expect(new TaskListStore(dir).get(SID)).toEqual(list())
  })
  it('set with null removes the list', () => {
    const dir = newDir()
    const a = new TaskListStore(dir, { debounceMs: 60_000 })
    a.set(SID, list())
    a.set(SID2, list('Other'))
    a.set(SID, null)
    a.flush()
    expect(new TaskListStore(dir).get(SID)).toBeNull()
    expect(new TaskListStore(dir).get(SID2)).toEqual(list('Other'))
  })
  it('parseTaskLists drops entries with a bad key, list, or changedAt, and answers null for text that is not a JSON object', () => {
    const good = { list: list(), changedAt: 5 }
    const raw = {
      [SID]: good,
      'not-a-uuid': good,
      [SID2]: { list: list(), changedAt: '5' },
      [sid(1)]: { list: list(), changedAt: Number.NaN },
      [sid(2)]: { list: null, changedAt: 5 },
      [sid(3)]: { list: { title: null, tasks: [] }, changedAt: 5 },
      [sid(4)]: { list: { title: null, tasks: [{ title: 'x', status: 'later' }] }, changedAt: 5 },
      [sid(5)]: { changedAt: 5 }
    }
    expect(parseTaskLists(JSON.stringify(raw))).toEqual(new Map([[SID, { list: list(), changedAt: 5 }]]))
    expect(parseTaskLists('{')).toBeNull()
    expect(parseTaskLists('[]')).toBeNull()
    expect(parseTaskLists('null')).toBeNull()
  })
  it('keeps the MAX_STORED_LISTS lists with the largest changedAt when it flushes', () => {
    const dir = newDir()
    let t = 0
    const a = new TaskListStore(dir, { debounceMs: 60_000, now: () => ++t })
    for (let n = 1; n <= MAX_STORED_LISTS + 1; n++) a.set(sid(n), list())
    a.flush()
    const stored = JSON.parse(readFileSync(join(dir, 'task-lists.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(stored)).toHaveLength(MAX_STORED_LISTS)
    expect(stored[sid(1)]).toBeUndefined()
    expect(stored[sid(MAX_STORED_LISTS + 1)]).toBeDefined()
    expect(new TaskListStore(dir).get(sid(1))).toBeNull()
  })
  it('a file that is not a task list is moved aside when the store opens, and the user is told once; the next save writes a new file', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'task-lists.json'), '{oops')
    vi.useFakeTimers({ now: T, toFake: ['Date'] })
    const warned: string[] = []
    const a = new TaskListStore(dir, { debounceMs: 60_000, warn: (m) => warned.push(m) })
    expect(a.get(SID)).toBeNull()
    expect(warned).toEqual([`Task lists could not be read; the file was kept as task-lists.json.corrupt-${T}`])
    a.set(SID, list())
    a.flush()
    expect(readFileSync(join(dir, `task-lists.json.corrupt-${T}`), 'utf8')).toBe('{oops')
    expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual({ [SID]: { list: list(), changedAt: T } })
    expect(warned).toHaveLength(1)
  })
  it('a file that is not a task list and cannot be moved aside is never written over for the whole run, and the user is told', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'task-lists.json'), '{oops')
    vi.useFakeTimers({ now: T, toFake: ['Date'] })
    // a folder where the file would be moved: the move fails on every system
    mkdirSync(join(dir, `task-lists.json.corrupt-${T}`))
    writeFileSync(join(dir, `task-lists.json.corrupt-${T}`, 'other'), 'x')
    const warned: string[] = []
    const a = new TaskListStore(dir, { debounceMs: 60_000, warn: (m) => warned.push(m) })
    expect(warned).toEqual([`Task lists could not be read and are not being saved this run: ${a.path}`])
    a.set(SID, list())
    a.flush()
    expect(a.get(SID)).toEqual(list())
    expect(readFileSync(a.path, 'utf8')).toBe('{oops')
    expect(readdirSync(dir).sort()).toEqual(['task-lists.json', `task-lists.json.corrupt-${T}`])
  })
  it('flush with nothing changed writes no file', () => {
    const dir = newDir()
    new TaskListStore(dir).flush()
    expect(existsSync(join(dir, 'task-lists.json'))).toBe(false)
  })
  it('get answers a copy', () => {
    const a = new TaskListStore(newDir())
    a.set(SID, list())
    a.get(SID)!.tasks[0]!.title = 'changed'
    expect(a.get(SID)!.tasks[0]!.title).toBe('Write the notes')
  })
})
