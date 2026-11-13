import { describe, expect, it } from 'vitest'
import type { Stamp } from '../../src/main/sync/clock'
import type { KeyState, Sibling } from '../../src/main/sync/replica'
import {
  admissionOf,
  isRemoved,
  memberOf,
  noteOf,
  removalOf,
  starOf,
  validSibling,
  type SelfDescription
} from '../../src/main/sync/views'
import { MAX_NOTE_LENGTH, type Note, type NoteForm } from '../../src/shared/note'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const S1 = 'a0000000-0000-4000-8000-000000000001'

const t1: Stamp = { t: 1000, c: 0 }
const t2: Stamp = { t: 2000, c: 0 }
const t3: Stamp = { t: 3000, c: 0 }

const sib = (value: unknown, at: Stamp, by: string, seq = 1): Sibling => ({ value, at, dot: [by, seq] })
const state = (...siblings: Sibling[]): KeyState => ({ siblings, ctx: {} })
const note = (text: string, form: NoteForm): Note => ({ text, shown: true, form })
const desc: SelfDescription = { name: 'Desk', platform: 'windows', addresses: ['127.0.0.1'], port: 47821 }

describe('sync views', () => {
  it('starOf: the latest sibling; none is false', () => {
    expect(starOf(undefined)).toBe(false)
    expect(starOf(state(sib(true, t1, A), sib(false, t2, B)))).toBe(false)
    expect(starOf(state(sib(false, t1, A), sib(true, t2, B)))).toBe(true)
  })

  it('noteOf joins concurrent texts: the later text, an empty line, the other', () => {
    expect(noteOf(state(sib(note('one', 'card'), t1, A), sib(note('two', 'label'), t2, B))))
      .toEqual({ text: 'two\n\none', shown: true, form: 'label' })
  })

  it('noteOf: an empty or equal text adds nothing', () => {
    expect(noteOf(state(sib(note('', 'card'), t2, B), sib(note('x', 'card'), t1, A))))
      .toEqual({ text: 'x', shown: true, form: 'card' })
    expect(noteOf(state(sib(note('x', 'card'), t2, B), sib(note('x', 'card'), t1, A))))
      .toEqual({ text: 'x', shown: true, form: 'card' })
    expect(noteOf(state(sib(note('  \n', 'card'), t2, B)))).toBeNull()
  })

  it('noteOf: a removal concurrent with an edit keeps the edit; only removals → null', () => {
    expect(noteOf(state(sib(null, t2, B), sib(note('kept', 'card'), t1, A))))
      .toEqual({ text: 'kept', shown: true, form: 'card' })
    expect(noteOf(state(sib(null, t1, A)))).toBeNull()
    expect(noteOf(undefined)).toBeNull()
  })

  it('noteOf: three concurrent texts give the same note in every order of the siblings', () => {
    const a = sib(note('a', 'card'), t1, A)
    const b = sib(note('b', 'card'), t2, B)
    const c = sib(note('c', 'card'), t3, C)
    const expected = { text: 'c\n\nb\n\na', shown: true, form: 'card' }
    expect(noteOf(state(a, b, c))).toEqual(expected)
    expect(noteOf(state(c, a, b))).toEqual(expected)
    expect(noteOf(state(b, c, a))).toEqual(expected)
  })

  it('noteOf cuts the joined text at MAX_NOTE_LENGTH', () => {
    const long = 'x'.repeat(MAX_NOTE_LENGTH)
    const joined = noteOf(state(sib(note(long, 'card'), t2, B), sib(note('y'.repeat(10), 'card'), t1, A)))
    expect(joined!.text).toHaveLength(MAX_NOTE_LENGTH)
    expect(joined!.text).toBe(long)
  })

  it('noteOf takes the side and the size of the latest write, when they are valid', () => {
    const big = { width: 480, height: 320 }
    expect(noteOf(state(sib({ ...note('one', 'card'), side: 'project', size: big }, t1, A), sib(note('two', 'label'), t2, B))))
      .toStrictEqual({ text: 'two\n\none', shown: true, form: 'label' })
    expect(noteOf(state(sib({ ...note('one', 'card'), side: 'project', size: big }, t2, A))))
      .toStrictEqual({ text: 'one', shown: true, form: 'card', side: 'project', size: big })
    expect(noteOf(state(sib({ ...note('one', 'card'), side: 'left', size: { width: 10, height: 10 } }, t2, A))))
      .toStrictEqual({ text: 'one', shown: true, form: 'card' })
  })

  it('admissionOf: the earliest sibling; isRemoved: any sibling; removalOf: the earliest removal; memberOf: the latest sibling', () => {
    const fp = (c: string) => c.repeat(64)
    expect(admissionOf(undefined)).toBeNull()
    expect(admissionOf(state(
      sib({ fingerprint: fp('b'), addedBy: B, addedAt: 2 }, t2, A),
      sib({ fingerprint: fp('a'), addedBy: A, addedAt: 1 }, t1, B)
    ))).toEqual({ fingerprint: fp('a'), addedBy: A, addedAt: 1 })

    expect(isRemoved(undefined)).toBe(false)
    expect(isRemoved(state())).toBe(false)
    expect(isRemoved(state(sib({ by: A, at: 5 }, t1, A)))).toBe(true)
    expect(removalOf(undefined)).toBeNull()
    expect(removalOf(state(sib({ by: B, at: 9 }, t2, B), sib({ by: A, at: 5 }, t1, A))))
      .toEqual({ by: A, at: 5 })

    expect(memberOf(undefined)).toBeNull()
    const older: SelfDescription = { ...desc, name: 'Old', port: 1024 }
    expect(memberOf(state(sib(older, t1, A), sib(desc, t2, A)))).toEqual(desc)
  })

  it('validSibling', () => {
    expect(validSibling('members', A, sib(desc, t1, B))).toBe(false)
    expect(validSibling('members', A, sib(desc, t1, A))).toBe(true)
    expect(validSibling('stars', S1, sib('yes', t1, A))).toBe(false)
    expect(validSibling('stars', S1, sib(true, t1, A))).toBe(true)
    expect(validSibling('notes', S1, sib(null, t1, A))).toBe(true)
    expect(validSibling('notes', S1, sib({ text: 'x'.repeat(MAX_NOTE_LENGTH + 1), shown: true, form: 'card' }, t1, A))).toBe(false)
    expect(validSibling('notes', S1, sib({ text: 'x', shown: 'yes', form: 'card' }, t1, A))).toBe(false)
    expect(validSibling('admitted', B, sib({ fingerprint: 'f'.repeat(64), addedBy: A, addedAt: 1 }, t1, A))).toBe(true)
    expect(validSibling('admitted', B, sib({ fingerprint: 'F'.repeat(64), addedBy: A, addedAt: 1 }, t1, A))).toBe(false)
    expect(validSibling('removed', B, sib({ by: A, at: 5 }, t1, A))).toBe(true)
    expect(validSibling('removed', B, sib({ by: 'nobody', at: 5 }, t1, A))).toBe(false)
    expect(validSibling('stars', 'not-a-uuid', sib(true, t1, A))).toBe(false)
  })

  it('validSibling rejects malformed members, dots and stamps', () => {
    const badMembers: unknown[] = [
      { ...desc, name: '' },
      { ...desc, name: 'x'.repeat(65) },
      { ...desc, platform: 'plan9' },
      { ...desc, addresses: Array(17).fill('127.0.0.1') },
      { ...desc, addresses: [''] },
      { ...desc, port: 0 },
      { ...desc, port: 65536 },
      { ...desc, port: 1.5 },
      null
    ]
    for (const value of badMembers) expect(validSibling('members', A, sib(value, t1, A))).toBe(false)

    expect(validSibling('stars', S1, sib(true, t1, A, 0))).toBe(false)
    expect(validSibling('stars', S1, sib(true, t1, 'not-a-uuid'))).toBe(false)
    expect(validSibling('stars', S1, sib(true, { t: -1, c: 0 }, A))).toBe(false)
    expect(validSibling('stars', S1, sib(true, { t: 1, c: 1.5 }, A))).toBe(false)
  })
})
