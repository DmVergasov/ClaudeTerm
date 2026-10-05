import { describe, expect, it } from 'vitest'
import { formatBadge } from '../../src/renderer/badge'

describe('formatBadge', () => {
  it('hides the badge at zero or below', () => {
    expect(formatBadge(0)).toBe('')
    expect(formatBadge(-1)).toBe('')
  })
  it('shows the number up to 99', () => {
    expect(formatBadge(1)).toBe('1')
    expect(formatBadge(99)).toBe('99')
  })
  it('caps above 99', () => {
    expect(formatBadge(100)).toBe('99+')
  })
})
