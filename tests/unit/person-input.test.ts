import { describe, expect, it } from 'vitest'
import { INPUT_RUNS_KEPT, PersonInput } from '../../src/main/coordinator/person-input'

describe('PersonInput', () => {
  it('keys close in time are one run; between tells whether a run reaches into the span', () => {
    const p = new PersonInput()
    p.note('t1', 1000)
    p.note('t1', 2500)
    p.note('t1', 4000)
    p.note('t1', 10_000)
    expect(p.between('t1', 3999, 5000)).toBe(true)
    expect(p.between('t1', 4000, 9999)).toBe(false)
    expect(p.between('t1', 4000, 10_000)).toBe(true)
    expect(p.between('t1', 0, 999)).toBe(false)
    expect(p.between('t2', 0, 20_000)).toBe(false)
  })

  it(`keeps the last ${INPUT_RUNS_KEPT} runs of a tab, and forgets a tab that closed`, () => {
    const p = new PersonInput()
    for (let i = 0; i <= INPUT_RUNS_KEPT; i++) p.note('t1', i * 10_000)
    expect(p.between('t1', -1, 0)).toBe(false)
    expect(p.between('t1', 9999, 10_000)).toBe(true)
    p.drop('t1')
    expect(p.between('t1', 0, Infinity)).toBe(false)
  })
})
