import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseProjectNotes, ProjectNotes } from '../../src/main/project-notes'
import { MAX_NOTE_LENGTH, type ProjectNote } from '../../src/shared/note'

const KEY = 'c:\\work\\acme'
const KEY2 = 'c:\\work\\other'
/** the time a file that is not notes is moved aside at */
const T = 1_762_171_200_000

const dirs: string[] = []
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ct-project-notes-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('project notes', () => {
  it('parseProjectNotes reads valid entries, drops the rest, and keeps a note whose size is bad without the size', () => {
    const raw = {
      [KEY]: { text: '- [ ] Tag the release', size: { width: 480, height: 320 } },
      '': { text: 'x' },
      ['k'.repeat(4097)]: { text: 'x' },
      'c:\\work\\long': { text: 'x'.repeat(MAX_NOTE_LENGTH + 1) },
      'c:\\work\\blank': { text: '   ' },
      'c:\\work\\number': { text: 5 },
      'c:\\work\\small': { text: 'Goal', size: { width: 1, height: 1 } }
    }
    expect(parseProjectNotes(JSON.stringify(raw))).toStrictEqual(
      new Map<string, ProjectNote>([
        [KEY, { text: '- [ ] Tag the release', size: { width: 480, height: 320 } }],
        ['c:\\work\\small', { text: 'Goal' }]
      ])
    )
  })
  it('parseProjectNotes answers null for text that is not a JSON object', () => {
    expect(parseProjectNotes('{')).toBeNull()
    expect(parseProjectNotes('[]')).toBeNull()
    expect(parseProjectNotes('null')).toBeNull()
  })
  it('set and flush write the file; a new store reads it back', () => {
    const dir = newDir()
    const a = new ProjectNotes(dir)
    a.set(KEY, { text: '- [ ] Tag the release', size: { width: 600, height: 400 } })
    a.flush()
    expect(new ProjectNotes(dir).get(KEY)).toEqual({ text: '- [ ] Tag the release', size: { width: 600, height: 400 } })
  })
  it('saves once after the debounce, and flush writes at once', () => {
    vi.useFakeTimers()
    const a = new ProjectNotes(newDir(), { debounceMs: 500 })
    a.set(KEY, { text: 'x' })
    expect(existsSync(a.path)).toBe(false)
    vi.advanceTimersByTime(500)
    expect(existsSync(a.path)).toBe(true)
    a.set(KEY2, { text: 'y' })
    a.flush()
    expect(existsSync(a.path)).toBe(true)
    expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual({ [KEY]: { text: 'x' }, [KEY2]: { text: 'y' } })
  })
  it('a note without text is removed, not stored', () => {
    const dir = newDir()
    const a = new ProjectNotes(dir)
    a.set(KEY, { text: 'x' })
    a.set(KEY, { text: '  ' })
    a.set(KEY2, { text: 'y' })
    a.set(KEY2, null)
    a.flush()
    expect(a.get(KEY)).toBeNull()
    expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual({})
  })
  it('a file that is not notes is moved aside when the store opens, and the user is told; it is never written over', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'project-notes.json'), '{oops')
    vi.useFakeTimers({ now: T, toFake: ['Date'] })
    const warned: string[] = []
    const a = new ProjectNotes(dir, { warn: (m) => warned.push(m) })
    expect(a.get(KEY)).toBeNull()
    expect(warned).toEqual([`Project notes could not be read; the file was kept as project-notes.json.corrupt-${T}`])
    a.set(KEY, { text: 'new' })
    a.flush()
    expect(readFileSync(join(dir, `project-notes.json.corrupt-${T}`), 'utf8')).toBe('{oops')
    expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual({ [KEY]: { text: 'new' } })
  })
  it('a file that is not notes and cannot be moved aside is left as it is for the whole run, and the user is told', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'project-notes.json'), '{oops')
    vi.useFakeTimers({ now: T, toFake: ['Date'] })
    // a folder where the file would be moved: the move fails on every system
    mkdirSync(join(dir, `project-notes.json.corrupt-${T}`))
    writeFileSync(join(dir, `project-notes.json.corrupt-${T}`, 'other'), 'x')
    const warned: string[] = []
    const a = new ProjectNotes(dir, { warn: (m) => warned.push(m) })
    expect(warned).toEqual([`Project notes could not be read and are not being saved this run: ${a.path}`])
    a.set(KEY, { text: 'new' })
    a.flush()
    expect(a.get(KEY)).toEqual({ text: 'new' })
    expect(readFileSync(a.path, 'utf8')).toBe('{oops')
    expect(readdirSync(dir).sort()).toEqual(['project-notes.json', `project-notes.json.corrupt-${T}`])
  })
  it('a valid file with some bad entries stays where it is', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'project-notes.json'), JSON.stringify({ [KEY]: { text: 'kept' }, '': { text: 'x' } }))
    const warned: string[] = []
    const a = new ProjectNotes(dir, { warn: (m) => warned.push(m) })
    expect(warned).toEqual([])
    expect(a.get(KEY)).toEqual({ text: 'kept' })
    expect(readdirSync(dir)).toEqual(['project-notes.json'])
  })
  it('get answers a copy', () => {
    const a = new ProjectNotes(newDir())
    a.set(KEY, { text: 'x' })
    a.get(KEY)!.text = 'changed'
    expect(a.get(KEY)!.text).toBe('x')
  })
})
