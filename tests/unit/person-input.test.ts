import { describe, expect, it } from 'vitest'
import { PersonInput, SUBMITS_KEPT } from '../../src/main/coordinator/person-input'
import { COORD_WORDS_MAX } from '../../src/shared/coordinator'

describe('PersonInput', () => {
  it("typed text and Enter give one submit, with the text the window's prompt held when it was submitted", () => {
    const p = new PersonInput()
    p.keys('t1', 'Merge it.\r', 5000)
    expect(p.submits('t1')).toEqual([{ at: 5000, texts: ['Merge it.'], wrote: true }])
  })

  it('Backspace fixes a typo: the prompt holds what is left', () => {
    const p = new PersonInput()
    p.keys('t1', 'Mergx\x7fe it.\r', 1)
    expect(p.submits('t1')).toEqual([{ at: 1, texts: ['Merge it.'], wrote: true }])
  })

  it('Shift+Enter and a backslash before Enter both make a line break inside one submit', () => {
    const p = new PersonInput()
    p.keys('t1', 'a\x1b\rb\r', 1)
    p.keys('t2', 'a\\\rb\r', 1)
    expect(p.submits('t1')).toEqual([{ at: 1, texts: ['a\nb'], wrote: true }])
    expect(p.submits('t2')).toEqual([{ at: 1, texts: ['a\nb'], wrote: true }])
  })

  it('a bracketed paste with a line break in it, split across two keys calls, is one text', () => {
    const p = new PersonInput()
    p.keys('t1', '\x1b[200~first\r', 1)
    p.keys('t1', 'second\x1b[201~\r', 2)
    expect(p.submits('t1')).toEqual([{ at: 2, texts: ['first\nsecond'], wrote: true }])
  })

  it('a left arrow makes the prompt unknown: its submit has no text, and the next prompt is known again', () => {
    const p = new PersonInput()
    p.keys('t1', 'Merge\x1b[D\r', 1)
    p.keys('t1', 'ok\r', 2)
    expect(p.submits('t1')).toEqual([
      { at: 1, texts: null, wrote: false },
      { at: 2, texts: ['ok'], wrote: true }
    ])
  })

  it('Esc or Ctrl+C on an empty prompt changes nothing; on a written one the submit is unknown', () => {
    const p = new PersonInput()
    p.keys('t1', '\x1b', 1)
    p.keys('t1', '\x03', 2)
    p.keys('t1', 'ok\r', 3)
    expect(p.submits('t1')).toEqual([{ at: 3, texts: ['ok'], wrote: true }])
    p.keys('t2', 'ab\x1b', 1)
    p.keys('t2', '\r', 2)
    p.keys('t3', 'ab\x03', 1)
    p.keys('t3', '\r', 2)
    expect(p.submits('t2')).toEqual([{ at: 2, texts: null, wrote: false }])
    expect(p.submits('t3')).toEqual([{ at: 2, texts: null, wrote: false }])
  })

  it('a digit typed into an empty prompt has two readings, with it and without it', () => {
    const p = new PersonInput()
    p.keys('t1', '1ok\r', 1)
    expect(p.submits('t1')).toEqual([{ at: 1, texts: ['1ok', 'ok'], wrote: true }])
    p.keys('t2', '1\r', 1)
    expect(p.submits('t2')).toEqual([{ at: 1, texts: ['1', ''], wrote: false }])
  })

  it('an Enter on an empty prompt pushes nothing', () => {
    const p = new PersonInput()
    p.keys('t1', '\r', 1)
    expect(p.submits('t1')).toEqual([])
  })

  it(`a prompt longer than ${COORD_WORDS_MAX} characters is unknown, and its submit still counts as written`, () => {
    const p = new PersonInput()
    p.keys('t1', 'a'.repeat(COORD_WORDS_MAX + 1), 1)
    p.keys('t1', '\r', 2)
    expect(p.submits('t1')).toEqual([{ at: 2, texts: null, wrote: true }])
  })

  it('sent pushes its text and leaves a typed prompt alone', () => {
    const p = new PersonInput()
    p.keys('t1', 'Mer', 1)
    p.sent('t1', 'Merge it.', 2)
    p.sent('t1', '  ', 3)
    p.keys('t1', 'ge\r', 4)
    expect(p.submits('t1')).toEqual([
      { at: 2, texts: ['Merge it.'], wrote: true },
      { at: 4, texts: ['Merge'], wrote: true }
    ])
  })

  it(`keeps only the latest ${SUBMITS_KEPT} submits of a tab`, () => {
    const p = new PersonInput()
    for (let i = 0; i < SUBMITS_KEPT + 3; i++) p.sent('t1', `m${i}`, i)
    expect(p.submits('t1')).toHaveLength(SUBMITS_KEPT)
    expect(p.submits('t1')[0]!.at).toBe(3)
    expect(p.submits('t1').at(-1)!.at).toBe(SUBMITS_KEPT + 2)
  })

  it('drop forgets the tab: its submits, and its typed prompt', () => {
    const p = new PersonInput()
    p.sent('t1', 'Merge it.', 1)
    p.keys('t1', 'ab', 2)
    p.drop('t1')
    p.keys('t1', '\r', 3)
    expect(p.submits('t1')).toEqual([])
  })
})
