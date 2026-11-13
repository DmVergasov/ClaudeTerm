import { describe, expect, it } from 'vitest'
import { durationText, elapsedText } from '../../src/renderer/chat/chat-steps'

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

// a done agent's time: whole seconds rounded, at least one, and the working line's minutes from a minute on
describe('durationText', () => {
  it('rounds to whole seconds, at least one', () => {
    expect(durationText(400)).toBe('1s')
    expect(durationText(5_600)).toBe('6s')
    expect(durationText(14_200)).toBe('14s')
  })

  it('shows minutes and two-digit seconds from a minute on, as a running agent does', () => {
    expect(durationText(59_600)).toBe('1m 00s')
    expect(durationText(150_000)).toBe('2m 30s')
  })
})
