import { describe, expect, it } from 'vitest'
import { PLAN_MARKS, planCountText } from '../../src/renderer/plan-list'

describe('plan list', () => {
  it('counts the done tasks', () => {
    expect(planCountText({ title: 'CSV Export', tasks: [], done: 3, total: 7, finished: false })).toBe('3 of 7 done')
  })

  it('marks done, current and left tasks', () => {
    expect(PLAN_MARKS).toEqual({ done: '✓', current: '●', left: '○' })
  })
})
