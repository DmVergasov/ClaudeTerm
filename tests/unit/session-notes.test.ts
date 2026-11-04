import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseNotes, SessionNotes } from '../../src/main/session-notes'
import { MAX_NOTE_LENGTH, type Note, type NoteForm } from '../../src/shared/note'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const note = (text: string, shown = true, form: NoteForm = 'card'): Note => ({ text, shown, form })
/** the time a file that is not notes is moved aside at */
const T = 1_762_171_200_000

const dirs: string[] = []
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ct-notes-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('session notes', () => {
  it('parseNotes reads valid entries and drops the rest', () => {
    const raw = {
      [SID]: note('Goal: payments', false, 'label'),
      'not-a-uuid': note('x'),
      [SID2]: { text: 5, shown: true, form: 'card' },
      'a3c2cf68-2929-4166-9a00-000000000001': { text: 'x', shown: 'yes', form: 'card' },
      'a3c2cf68-2929-4166-9a00-000000000002': { text: 'x', shown: true, form: 'big' },
      'a3c2cf68-2929-4166-9a00-000000000003': note('x'.repeat(MAX_NOTE_LENGTH + 1)),
      'a3c2cf68-2929-4166-9a00-000000000004': note('   \n ')
    }
    expect(parseNotes(JSON.stringify(raw))).toEqual(new Map([[SID, note('Goal: payments', false, 'label')]]))
  })
  it('parseNotes answers null for text that is not a JSON object', () => {
    expect(parseNotes('{')).toBeNull()
    expect(parseNotes('[]')).toBeNull()
    expect(parseNotes('null')).toBeNull()
  })
  it('set and flush write the file; a new store reads it back', () => {
    const dir = newDir()
    const a = new SessionNotes(dir)
    a.set(SID, note('one\ntwo', true, 'label'))
    a.flush()
    expect(new SessionNotes(dir).get(SID)).toEqual(note('one\ntwo', true, 'label'))
  })
  it('a note without text is removed, not stored', () => {
    const dir = newDir()
    const a = new SessionNotes(dir)
    a.set(SID, note('x'))
    a.set(SID, note('  '))
    a.set(SID2, note('y'))
    a.set(SID2, null)
    a.flush()
    expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual({})
  })
  it('saves once after the debounce, and flush writes at once', () => {
    vi.useFakeTimers()
    const a = new SessionNotes(newDir(), { debounceMs: 500 })
    a.set(SID, note('x'))
    expect(existsSync(a.path)).toBe(false)
    vi.advanceTimersByTime(500)
    expect(existsSync(a.path)).toBe(true)
  })
  it('flush writes at once', () => {
    const a = new SessionNotes(newDir(), { debounceMs: 60_000 })
    a.set(SID, note('x'))
    expect(existsSync(a.path)).toBe(false)
    a.flush()
    expect(existsSync(a.path)).toBe(true)
  })
  it('flush with nothing changed writes no file', () => {
    const a = new SessionNotes(newDir())
    a.flush()
    expect(existsSync(a.path)).toBe(false)
  })
  it('a missing file is not reported', () => {
    const reported: string[] = []
    new SessionNotes(newDir(), { onError: (m) => reported.push(m), warn: (m) => reported.push(m) })
    expect(reported).toEqual([])
  })
  it('a file that is not notes is moved aside when the store opens, and the user is told; it is never written over', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'session-notes.json'), '{oops')
    vi.useFakeTimers({ now: T, toFake: ['Date'] })
    const warned: string[] = []
    const a = new SessionNotes(dir, { warn: (m) => warned.push(m) })
    expect(a.get(SID)).toBeNull()
    expect(warned).toEqual([`Session notes could not be read; the file was kept as session-notes.json.corrupt-${T}`])
    a.set(SID, note('new'))
    a.flush()
    expect(readFileSync(join(dir, `session-notes.json.corrupt-${T}`), 'utf8')).toBe('{oops')
    expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual({ [SID]: note('new') })
  })
  it('a file that cannot be read is moved aside too', () => {
    const dir = newDir()
    // a folder in the file's place: reading it fails on every system
    mkdirSync(join(dir, 'session-notes.json'))
    writeFileSync(join(dir, 'session-notes.json', 'inside'), 'kept')
    const warned: string[] = []
    const a = new SessionNotes(dir, { warn: (m) => warned.push(m) })
    const kept = readdirSync(dir).filter((f) => f.startsWith('session-notes.json.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(warned).toEqual([`Session notes could not be read; the file was kept as ${kept[0]}`])
    a.set(SID, note('new'))
    a.flush()
    expect(readFileSync(join(dir, kept[0]!, 'inside'), 'utf8')).toBe('kept')
    expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual({ [SID]: note('new') })
  })
  it('a file that is not notes and cannot be moved aside is left as it is for the whole run, and the user is told', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'session-notes.json'), '{oops')
    vi.useFakeTimers({ now: T, toFake: ['Date'] })
    // a folder where the file would be moved: the move fails on every system
    mkdirSync(join(dir, `session-notes.json.corrupt-${T}`))
    writeFileSync(join(dir, `session-notes.json.corrupt-${T}`, 'other'), 'x')
    const warned: string[] = []
    const a = new SessionNotes(dir, { warn: (m) => warned.push(m) })
    expect(warned).toEqual([`Session notes could not be read and are not being saved this run: ${a.path}`])
    a.set(SID, note('new'))
    a.flush()
    expect(a.get(SID)).toEqual(note('new'))
    expect(readFileSync(a.path, 'utf8')).toBe('{oops')
    expect(readdirSync(dir).sort()).toEqual(['session-notes.json', `session-notes.json.corrupt-${T}`])
  })
  it('a valid file with some bad entries stays where it is', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'session-notes.json'), JSON.stringify({ [SID]: note('kept'), 'not-a-uuid': note('x') }))
    const warned: string[] = []
    const a = new SessionNotes(dir, { warn: (m) => warned.push(m) })
    expect(warned).toEqual([])
    expect(a.get(SID)).toEqual(note('kept'))
    expect(readdirSync(dir)).toEqual(['session-notes.json'])
  })
  it('get answers a copy', () => {
    const a = new SessionNotes(newDir())
    a.set(SID, note('x'))
    a.get(SID)!.text = 'changed'
    expect(a.get(SID)!.text).toBe('x')
  })
})
