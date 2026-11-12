import { describe, expect, it } from 'vitest'
import { elapsedText } from '../../src/renderer/chat/chat-steps'

// the working line's time: seconds under a minute, then minutes with two-digit seconds
describe('elapsedText', () => {
  it('shows whole seconds under a minute', () => {
    expect(elapsedText(0)).toBe('0s')
    expect(elapsedText(5_000)).toBe('5s')
    expect(elapsedText(59_999)).toBe('59s')
  })

  it('shows minutes and two-digit seconds from a minute on', () => {
    expect(elapsedText(60_000)).toBe('1m 00s')
    expect(elapsedText(65_000)).toBe('1m 05s')
    expect(elapsedText(3_600_000)).toBe('60m 00s')
  })
})
