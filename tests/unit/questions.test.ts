import { describe, expect, it } from 'vitest'
import { parsePassedAnswers, parseQuestions } from '../../src/shared/questions'

const q = (over: Record<string, unknown> = {}) => ({ question: 'Where should the browser live?', header: 'Place', multiSelect: false, options: [{ label: 'Side panel', description: 'Next to Changes.' }, { label: 'Own tab', description: '' }], ...over })

describe('parseQuestions', () => {
  it('keeps the fields of 1 to 4 questions; a missing header or description is empty, a missing multiSelect false; other fields go', () => {
    expect(parseQuestions([{ question: 'Q?', options: [{ label: 'A' }, { label: 'B', extra: 1 }], extra: true }])).toEqual([
      { question: 'Q?', header: '', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }
    ])
    expect(parseQuestions([q(), q({ question: 'Two?', multiSelect: true })])).toHaveLength(2)
  })

  it('refuses anything out of bounds rather than cutting it', () => {
    for (const bad of [
      [], [q(), q({ question: '2' }), q({ question: '3' }), q({ question: '4' }), q({ question: '5' })], 'x', null, [null],
      [q({ question: '' })], [q({ question: '   ' })], [q({ question: 'x'.repeat(2001) })], [q({ header: 'h'.repeat(51) })], [q({ header: 3 })],
      [q({ multiSelect: 'yes' })], [q({ options: [{ label: 'only' }] })], [q({ options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })) })],
      [q({ options: [{ label: '' }, { label: 'B' }] })], [q({ options: [{ label: 'l'.repeat(201) }, { label: 'B' }] })],
      [q({ options: [{ label: 'A', description: 'd'.repeat(501) }, { label: 'B' }] })], [q(), q()]
    ]) expect(parseQuestions(bad)).toBeNull()
    expect(parseQuestions([q({ question: 'x'.repeat(2000), header: 'h'.repeat(50) })])).not.toBeNull()
  })
})

describe('parsePassedAnswers', () => {
  it('keeps 1 to 4 answers of three strings each, within their bounds', () => {
    const a = { question: 'Where?', asked: 'docs: Where?', answer: 'Side panel' }
    expect(parsePassedAnswers([{ ...a, extra: 1 }])).toEqual([a])
    for (const bad of [[], [a, a, a, a, a], [{ ...a, asked: '' }], [{ ...a, answer: 'x'.repeat(2001) }], [{ ...a, asked: 'x'.repeat(2001) }], [{ ...a, question: 'x'.repeat(2001) }], [{ question: 'Where?' }], 'x'])
      expect(parsePassedAnswers(bad)).toBeNull()
  })
})
