import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseNotes, SessionNotes } from '../../src/main/session-notes'
import { MAX_NOTE_LENGTH, type Note, type NoteForm } from '../../src/shared/note'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const note = (text: string, shown = true, form: NoteForm = 'card'): Note => ({ text, shown, form })

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
  it('a corrupt file is reported and ignored; a missing file is not reported', () => {
    const dir = newDir()
    const errors: string[] = []
    new SessionNotes(dir, { onError: (m) => errors.push(m) })
    expect(errors).toEqual([])
    writeFileSync(join(dir, 'session-notes.json'), '{oops')
    const b = new SessionNotes(dir, { onError: (m) => errors.push(m) })
    expect(errors).toEqual([`ignoring corrupt ${b.path}`])
    expect(b.get(SID)).toBeNull()
  })
  it('get answers a copy', () => {
    const a = new SessionNotes(newDir())
    a.set(SID, note('x'))
    a.get(SID)!.text = 'changed'
    expect(a.get(SID)!.text).toBe('x')
  })
})
