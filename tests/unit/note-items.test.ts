import { describe, expect, it } from 'vitest'
import {
  appendText,
  applyNoteOp,
  diffText,
  firstLine,
  itemCount,
  noteItems,
  noteLabel,
  parseLine,
  replayNoteOps,
  tryNoteOp,
} from '../../src/shared/note-items'
import { MAX_NOTE_LENGTH } from '../../src/shared/note'

describe('note items', () => {
  it('parseLine reads items, bullets and plain lines', () => {
    expect(parseLine('- [ ] a')).toEqual({ indent: 0, kind: 'item', checked: false, textStart: 6 })
    expect(parseLine('  - [x] b')).toEqual({ indent: 2, kind: 'item', checked: true, textStart: 8 })
    expect(parseLine('\t- [X] c')).toEqual({ indent: 1, kind: 'item', checked: true, textStart: 7 })
    expect(parseLine('- [ ]')).toEqual({ indent: 0, kind: 'item', checked: false, textStart: 5 })
    expect(parseLine('- [ ]x')).toEqual({ indent: 0, kind: 'bullet', checked: false, textStart: 2 })
    expect(parseLine('- b')).toMatchObject({ kind: 'bullet', textStart: 2 })
    expect(parseLine('-[ ] a')).toMatchObject({ kind: 'plain', textStart: 0 })
    expect(parseLine('* [ ] a')).toMatchObject({ kind: 'plain', textStart: 0 })
    expect(parseLine('text')).toMatchObject({ kind: 'plain', textStart: 0 })
    expect(parseLine('  text')).toEqual({ indent: 2, kind: 'plain', checked: false, textStart: 2 })
  })

  it('noteItems lists the items with their text trimmed', () => {
    const text = 'Goal\n- [ ] Write the tests  \n  - [x] Tag\n- bullet\n- [X] Done\r'
    expect(noteItems(text)).toEqual([
      { line: 1, checked: false, text: 'Write the tests' },
      { line: 2, checked: true, text: 'Tag' },
      { line: 4, checked: true, text: 'Done' },
    ])
    expect(itemCount(text)).toEqual({ checked: 2, total: 3 })
    expect(itemCount('plain')).toEqual({ checked: 0, total: 0 })
  })

  it('firstLine skips blank lines and drops the marker', () => {
    expect(firstLine('\n  - [ ] Write\nx')).toBe('Write')
    expect(firstLine('- foo')).toBe('foo')
    expect(firstLine('  Goal: payments  \nTODO')).toBe('Goal: payments')
    expect(firstLine('')).toBe('')
  })

  it('noteLabel: the count and the first unticked item; all ticked, the first line; no items, the first line', () => {
    expect(noteLabel('Goal\n- [x] Tag\n- [ ] Write the tests\n- [ ] Ship')).toEqual({
      count: '1/3',
      text: 'Write the tests',
    })
    expect(noteLabel('- [x] a\n- [x] b')).toEqual({ count: '2/2', text: 'a' })
    expect(noteLabel('Goal: payments\nTODO')).toEqual({ count: null, text: 'Goal: payments' })
  })

  it('appendText adds after one blank line', () => {
    expect(appendText('', '- [ ] a')).toBe('- [ ] a')
    expect(appendText('  \n', 'x')).toBe('x')
    expect(appendText('Goal', 'x')).toBe('Goal\n\nx')
    expect(appendText('Goal\n', 'x')).toBe('Goal\n\nx')
    expect(appendText('Goal\n\n', 'x')).toBe('Goal\n\nx')
    expect(appendText('Goal\n  \n', 'x')).toBe('Goal\n  \nx')
    expect(appendText('Goal', '\n\n- [ ] a\r\n- [ ] b\n\n')).toBe('Goal\n\n- [ ] a\n- [ ] b')
  })

  it('tryNoteOp append: an empty text is refused, a text is added', () => {
    expect(tryNoteOp('Goal', { kind: 'append', text: '  \n ' })).toEqual({ ok: false, reason: 'empty' })
    expect(tryNoteOp('Goal', { kind: 'append', text: '- [ ] a' })).toEqual({
      ok: true,
      text: 'Goal\n\n- [ ] a',
      changed: true,
    })
  })

  it('tryNoteOp refuses an append past the limit; applyNoteOp leaves the text', () => {
    const t = 'x'.repeat(MAX_NOTE_LENGTH - 5)
    const op = { kind: 'append', text: 'abcdef' } as const
    expect(tryNoteOp(t, op)).toEqual({ ok: false, reason: 'too-long', adds: 8 })
    expect(applyNoteOp(t, op)).toBe(t)
  })

  it('tryNoteOp check ticks the one item with that text, ends ignored', () => {
    expect(tryNoteOp('- [ ] Write the tests\n- [ ] Ship', { kind: 'check', item: ' Write the tests ', checked: true })).toEqual({
      ok: true,
      text: '- [x] Write the tests\n- [ ] Ship',
      changed: true,
    })
    expect(tryNoteOp('  - [ ] a', { kind: 'check', item: 'a', checked: true })).toEqual({
      ok: true,
      text: '  - [x] a',
      changed: true,
    })
    expect(tryNoteOp('- [X] a', { kind: 'check', item: 'a', checked: true })).toEqual({
      ok: true,
      text: '- [X] a',
      changed: false,
    })
    expect(tryNoteOp('- [X] a', { kind: 'check', item: 'a', checked: false })).toEqual({
      ok: true,
      text: '- [ ] a',
      changed: true,
    })
    expect(tryNoteOp('- [ ] Write the tests', { kind: 'check', item: 'write the tests', checked: true })).toEqual({
      ok: false,
      reason: 'no-match',
    })
    expect(tryNoteOp('- [ ] a\n- [x] a', { kind: 'check', item: 'a', checked: true })).toEqual({
      ok: false,
      reason: 'ambiguous',
      matches: 2,
    })
    expect(tryNoteOp('- a', { kind: 'check', item: 'a', checked: true })).toEqual({ ok: false, reason: 'no-match' })
  })

  it('replayNoteOps applies the ops in order', () => {
    expect(
      replayNoteOps('Goal: payments', [
        { kind: 'append', text: '- [ ] Write the tests' },
        { kind: 'check', item: 'Write the tests', checked: true },
      ]),
    ).toBe('Goal: payments\n\n- [x] Write the tests')
  })

  it('diffText gives the one change, and never splits a surrogate pair', () => {
    expect(diffText('abc', 'abXc')).toEqual({ from: 2, to: 2, insert: 'X' })
    expect(diffText('aXc', 'ac')).toEqual({ from: 1, to: 2, insert: '' })
    expect(diffText('same', 'same')).toBeNull()
    expect(diffText('a😀', 'a😁')).toEqual({ from: 1, to: 3, insert: '😁' })
  })
})
