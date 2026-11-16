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
      { at: 1, texts: null, wrote: true },
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
    expect(p.submits('t2')).toEqual([{ at: 2, texts: null, wrote: true }])
    expect(p.submits('t3')).toEqual([{ at: 2, texts: null, wrote: true }])
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

  it('a draft survives a dialog: the keys and the Enter typed into the dialog push nothing, and the prompt is what it was', () => {
    const p = new PersonInput()
    p.keys('t', 'Merge it', 1000)
    p.keys('t', '1', 2000, true)
    p.keys('t', '\r', 2100, true)
    expect(p.submits('t')).toEqual([])
    p.keys('t', ' now\r', 3000)
    expect(p.submits('t')).toEqual([{ at: 3000, texts: ['Merge it now'], wrote: true }])
  })

  it('a written answer in a dialog is a submit with no text, and the Enter after a digit answer pushes nothing', () => {
    const p = new PersonInput()
    p.keys('t', 'no, wait\r', 1000, true)
    expect(p.submits('t')).toEqual([{ at: 1000, texts: null, wrote: true }])
    p.keys('t', '2\r', 2000, true)
    expect(p.submits('t')).toEqual([{ at: 1000, texts: null, wrote: true }])
  })

  it('a pasted answer in a dialog is an answer too, and Backspace and Esc in a dialog change nothing', () => {
    const p = new PersonInput()
    p.keys('t', 'Merge it', 1000)
    p.keys('t', '\x1b[200~pasted\x1b[201~\x7f\x1b', 2000, true)
    p.keys('t', '\r', 3000, true)
    expect(p.submits('t')).toEqual([{ at: 3000, texts: null, wrote: true }])
    p.keys('t', ' now\r', 4000)
    expect(p.submits('t')).toEqual([
      { at: 3000, texts: null, wrote: true },
      { at: 4000, texts: ['Merge it now'], wrote: true }
    ])
  })

  it('a command line (bash mode or a slash command) backs no prompt, and a line with readings that are not commands keeps those', () => {
    const p = new PersonInput()
    p.keys('t1', '!git push --force\r', 1)
    p.keys('t2', '/model\r', 2)
    p.keys('t3', '1/2 done\r', 3)
    expect(p.submits('t1')).toEqual([{ at: 1, texts: null, wrote: true }])
    expect(p.submits('t2')).toEqual([{ at: 2, texts: null, wrote: true }])
    expect(p.submits('t3')).toEqual([{ at: 3, texts: ['1/2 done'], wrote: true }])
  })

  it('a paste whose end marker is split across two calls is one text', () => {
    const p = new PersonInput()
    p.keys('t', '\x1b[200~pasted\x1b[20', 1)
    p.keys('t', '1~', 2)
    p.keys('t', '\r', 3)
    expect(p.submits('t')).toEqual([{ at: 3, texts: ['pasted'], wrote: true }])
  })

  it('a paste whose start marker is split across two calls is one text', () => {
    const p = new PersonInput()
    p.keys('t', '\x1b[20', 1)
    p.keys('t', '0~pasted\x1b[201~\r', 2)
    expect(p.submits('t')).toEqual([{ at: 2, texts: ['pasted'], wrote: true }])
  })

  it('a split marker that is not a marker is processed as typed', () => {
    const p = new PersonInput()
    p.keys('t', 'a\x1b[2', 1)
    p.keys('t', 'Z\r', 2)
    expect(p.submits('t')).toEqual([{ at: 2, texts: null, wrote: true }])
  })

  it('many leading digits: the readings keep the longest one and the one with every digit an answer, and the text is still known', () => {
    const p = new PersonInput()
    p.keys('t', '123456789 is the id\r', 1)
    const [s] = p.submits('t')
    expect(s!.texts).toEqual(expect.arrayContaining(['123456789 is the id', ' is the id']))
    expect(s!.wrote).toBe(true)
  })

  it('a command line is dropped reading by reading: the readings that are not commands are kept, and a line of only a command has no text', () => {
    const p = new PersonInput()
    p.keys('t1', '1!git push --force\r', 1)
    p.keys('t2', '!git push\r', 2)
    expect(p.submits('t1')).toEqual([{ at: 1, texts: ['1!git push --force'], wrote: true }])
    expect(p.submits('t2')).toEqual([{ at: 2, texts: null, wrote: true }])
  })

  it('a typed prompt edited with an arrow key is a submit the person wrote; history recall alone is not, and a digit alone is not', () => {
    const p = new PersonInput()
    p.keys('t1', 'ab\x1b[Dc\r', 1)
    p.keys('t2', '\x1b[A\r', 2)
    p.keys('t3', '1\x1b[A\r', 3)
    expect(p.submits('t1')).toEqual([{ at: 1, texts: null, wrote: true }])
    expect(p.submits('t2')).toEqual([{ at: 2, texts: null, wrote: false }])
    expect(p.submits('t3')).toEqual([{ at: 3, texts: null, wrote: false }])
  })

  it('a pasted text counts as typed: a paste edited with an arrow key is a submit the person wrote', () => {
    const p = new PersonInput()
    p.keys('t', '\x1b[200~Merge it\x1b[201~\x1b[D\r', 1)
    expect(p.submits('t')).toEqual([{ at: 1, texts: null, wrote: true }])
  })

  it('a paste begun in the draft and ended in a dialog leaves the draft unknown', () => {
    const p = new PersonInput()
    p.keys('t', 'Merge it ', 1000)
    p.keys('t', '\x1b[200~pas', 2000)
    p.keys('t', 'ted\x1b[201~', 3000, true)
    p.keys('t', '\r', 4000)
    expect(p.submits('t')).toEqual([{ at: 4000, texts: null, wrote: true }])
  })

  it('a paste begun in a dialog and continued in the draft leaves the draft unknown', () => {
    const p = new PersonInput()
    p.keys('t', 'Merge it', 1000)
    p.keys('t', '\x1b[200~pas', 2000, true)
    p.keys('t', 'ted\x1b[201~\r', 3000)
    expect(p.submits('t')).toEqual([{ at: 3000, texts: null, wrote: true }])
  })

  it('dialogWrote is reset by a draft key: a dialog Enter after "no wait", Esc, a draft key and a digit pushes nothing', () => {
    const p = new PersonInput()
    p.keys('t', 'no wait', 1000, true)
    p.keys('t', '\x1b', 2000, true)
    p.keys('t', 'ok', 3000)
    p.keys('t', '1\r', 4000, true)
    expect(p.submits('t')).toEqual([])
  })

  it('a CR at the end of a pasted piece waits for the next piece, so a CRLF split across two calls is one line break', () => {
    const p = new PersonInput()
    p.keys('t', '\x1b[200~Merge it.\r', 1)
    p.keys('t', '\nThen push.\x1b[201~\r', 2)
    expect(p.submits('t')).toEqual([{ at: 2, texts: ['Merge it.\nThen push.'], wrote: true }])
  })
})
