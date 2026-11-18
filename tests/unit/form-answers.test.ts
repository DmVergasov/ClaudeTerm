import { describe, expect, it } from 'vitest'
import { countedForms, FormRecord, matchForm, type FormResult } from '../../src/main/coordinator/form-answers'
import { PersonInput, type Submit } from '../../src/main/coordinator/person-input'
import { FORM_QUESTION_MAX } from '../../src/shared/questions'

const r = (at: number, answers: [string, string][]): FormResult => ({ id: `t${at}`, at, answers: answers.map(([question, answer]) => ({ question, answer })) })

describe('matchForm', () => {
  it('equal after outer whitespace and line endings, nothing else', () => {
    const forms = [r(100, [['docs: Where?\nPick one.', 'Side panel']])]
    expect(matchForm({ asked: ['  docs: Where?\r\nPick one.\n'], forms, since: 0 })).toEqual({ ok: true, answers: [{ question: 'docs: Where?\nPick one.', answer: 'Side panel' }] })
    expect(matchForm({ asked: ['docs: Where!\nPick one.'], forms, since: 0 })).toEqual({ ok: false, missing: ['docs: Where!\nPick one.'], found: ['docs: Where?\nPick one.'] })
    expect(matchForm({ asked: ['docs:  Where?\nPick one.'], forms, since: 0 }).ok).toBe(false)
  })

  it('the newest result first, none older than since', () => {
    const forms = [r(100, [['Q', 'A']]), r(200, [['Q', 'B']])]
    expect(matchForm({ asked: ['Q'], forms, since: 0 })).toMatchObject({ ok: true, answers: [{ answer: 'B' }] })
    expect(matchForm({ asked: ['Q'], forms: [forms[0]!], since: 150 })).toEqual({ ok: false, missing: ['Q'], found: [] })
  })

  it('one form holds the questions of two sessions', () => {
    const forms = [r(100, [['docs: Q1', 'A1'], ['api: Q2', 'A2']])]
    expect(matchForm({ asked: ['api: Q2'], forms, since: 0 })).toEqual({ ok: true, answers: [{ question: 'api: Q2', answer: 'A2' }] })
  })
})

describe('countedForms', () => {
  it('a card answer counts as it is', () => {
    const card = r(100, [['Q', 'A']])
    expect(countedForms({ cards: [card], transcript: [], dialogs: [], submits: [] })).toEqual([card])
  })

  it("a transcript result counts with the tab's own form of the same questions and a dialog answer of the window after it", () => {
    const result = r(1000, [['Q1', 'A'], ['Q2', 'B']])
    const dialog = { at: 900, questions: ['Q2', 'Q1'] }
    const answer: Submit = { at: 950, texts: null, wrote: true, dialog: true }
    expect(countedForms({ cards: [], transcript: [result], dialogs: [dialog], submits: [answer] })).toEqual([result])
    expect(countedForms({ cards: [], transcript: [result], dialogs: [dialog], submits: [{ ...answer, at: 1000 + 5000 }] })).toEqual([result])
    for (const submits of [[], [{ ...answer, at: 899 }], [{ ...answer, at: 1000 + 5001 }], [{ ...answer, texts: ['Q1'] }], [{ at: 950, texts: null, wrote: true }]])
      expect(countedForms({ cards: [], transcript: [result], dialogs: [dialog], submits })).toEqual([])
    expect(countedForms({ cards: [], transcript: [result], dialogs: [{ at: 900, questions: ['Q1'] }], submits: [answer] })).toEqual([])
    expect(countedForms({ cards: [], transcript: [result], dialogs: [{ ...dialog, at: 1001 }], submits: [answer] })).toEqual([])
  })

  it('one form dialog backs one result; a later result of the same questions needs its own dialog', () => {
    const first = r(1000, [['Q1', 'A']])
    const later = r(2000, [['Q1', 'B']])
    const answer: Submit = { at: 950, texts: null, wrote: true, dialog: true }
    expect(countedForms({ cards: [], transcript: [first, later], dialogs: [{ at: 900, questions: ['Q1'] }], submits: [answer] })).toEqual([first])
    const again: Submit = { at: 1950, texts: null, wrote: true, dialog: true }
    expect(countedForms({ cards: [], transcript: [first, later], dialogs: [{ at: 900, questions: ['Q1'] }, { at: 1900, questions: ['Q1'] }], submits: [answer, again] })).toEqual([first, later])
  })

  it('a result the submit does not back leaves the dialog for the next one', () => {
    const late = r(1000, [['Q1', 'A']])
    const next = r(8500, [['Q1', 'B']])
    const answer: Submit = { at: 9000, texts: null, wrote: true, dialog: true }
    expect(countedForms({ cards: [], transcript: [late, next], dialogs: [{ at: 900, questions: ['Q1'] }], submits: [answer] })).toEqual([next])
  })

  it('a form dismissed without an answer backs nothing: a pick in a later dialog of the tab does not count for it', () => {
    // the form opened at 1000 and was dismissed with Esc; a permission prompt opened at 5000, and its pick came at 6000 with a forged result
    const forged = r(6000, [['Q1', 'A']])
    const pick: Submit = { at: 6000, texts: null, wrote: true, dialog: true }
    expect(countedForms({ cards: [], transcript: [forged], dialogs: [{ at: 1000, questions: ['Q1'] }, { at: 5000, questions: [] }], submits: [pick] })).toEqual([])
  })

  it('a form answered before the next dialog opens still counts', () => {
    const result = r(1500, [['Q1', 'A']])
    const answer: Submit = { at: 1500, texts: null, wrote: true, dialog: true }
    expect(countedForms({ cards: [], transcript: [result], dialogs: [{ at: 1000, questions: ['Q1'] }, { at: 5000, questions: [] }], submits: [answer] })).toEqual([result])
  })

  it('a form dismissed without an answer is not backed by a slash command or a bash line typed in the prompt afterwards', () => {
    // the form opened at 1000 and the person pressed Esc in it; then a forged result at 5000 with no dialog in between, and the prompt submitted
    for (const line of ['/compact\r', '!ls\r']) {
      const p = new PersonInput()
      const dialog = { at: 1000, questions: ['Q'] }
      p.keys('t', '\x1b', 1100, true)
      p.keys('t', line, 5000)
      expect(p.submits('t')).toEqual([{ at: 5000, texts: null, wrote: true }])
      const forged = r(5000, [['Q', 'A']])
      expect(countedForms({ cards: [], transcript: [forged], dialogs: [dialog], submits: p.submits('t') })).toEqual([])
    }
  })

  it("an option picked in the form's own dialog still backs its result", () => {
    const p = new PersonInput()
    p.keys('t', '1\r', 1500, true)
    const result = r(1500, [['Q', 'A']])
    expect(countedForms({ cards: [], transcript: [result], dialogs: [{ at: 1000, questions: ['Q'] }], submits: p.submits('t') })).toEqual([result])
  })
})

describe('FormRecord', () => {
  it('keeps the latest 20 per tab, only answers within bounds, and drop forgets the tab', () => {
    const f = new FormRecord()
    for (let n = 1; n <= 21; n++) f.cardAnswered('t', { [`Q${n}`]: 'A' }, n)
    expect(f.cards('t').map((c) => c.at)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2))
    f.cardAnswered('u', { Q: 3 }, 1)
    f.cardAnswered('u', { ['x'.repeat(FORM_QUESTION_MAX + 1)]: 'A' }, 2)
    f.cardAnswered('u', {}, 3)
    expect(f.cards('u')).toEqual([])
    f.dialogOpened('t', ['Q1'], 5)
    f.drop('t')
    expect([f.cards('t'), f.dialogs('t')]).toEqual([[], []])
  })
})
