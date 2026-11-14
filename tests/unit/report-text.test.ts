import { describe, expect, it } from 'vitest'
import { CUT_NOTE, NO_ANSWER, REASONS, REPORT_TEXT_MAX, reportText } from '../../src/main/coordinator/report-text'
import { MAIL_TEXT_MAX } from '../../src/shared/mail'

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('reportText', () => {
  it('a finished report is the last answer, trimmed, or says there was none', () => {
    expect(reportText({ outcome: 'finished', reason: null, lastMessage: '  Done: 3 tests fixed.\n', previous: null }))
      .toBe('Done: 3 tests fixed.')
    expect(reportText({ outcome: 'finished', reason: null, lastMessage: '   ', previous: null })).toBe(NO_ANSWER)
    expect(reportText({ outcome: 'finished', reason: null, lastMessage: null, previous: null })).toBe(NO_ANSWER)
    expect(NO_ANSWER).toBe('(The session ended its turn without an answer text.)')
  })

  it('a failed or stopped report says why and keeps the last answer', () => {
    expect(reportText({ outcome: 'failed', reason: 'Claude Code exited', lastMessage: 'Half way.', previous: null }))
      .toBe('The task failed: Claude Code exited.\n\nIts last answer:\n\nHalf way.')
    expect(reportText({ outcome: 'stopped', reason: REASONS.interrupted, lastMessage: null, previous: null }))
      .toBe('The task was stopped by the user: its turn was interrupted.')
    expect(reportText({ outcome: 'failed', reason: null, lastMessage: null, previous: null }))
      .toBe('The task failed: no reason given.')
    expect(reportText({ outcome: 'stopped', reason: REASONS.error('overloaded'), lastMessage: 'Partly done.', previous: null }))
      .toBe('The task was stopped by the user: Claude Code stopped the turn on an error (overloaded).\n\nIts last answer:\n\nPartly done.')
  })

  it('a task of the previous coordinator says so first', () => {
    expect(reportText({ outcome: 'finished', reason: null, lastMessage: 'Ok.', previous: 'Coordinator · desk' }))
      .toBe('(This task was given by the previous coordinator, Coordinator · desk.)\n\nOk.')
  })

  it('a report over 6000 characters is cut with the note', () => {
    expect(reportText({ outcome: 'finished', reason: null, lastMessage: 'a'.repeat(7000), previous: null }))
      .toBe(`${'a'.repeat(6000)}\n\n${CUT_NOTE}`)
    expect(reportText({ outcome: 'finished', reason: null, lastMessage: 'a'.repeat(6000), previous: null }))
      .toBe('a'.repeat(6000))
    expect(REPORT_TEXT_MAX).toBe(6000)
  })

  it('a cut report is within the mail limit, ends with the note and keeps no lone surrogate', () => {
    const text = reportText({ outcome: 'finished', reason: null, lastMessage: '😀'.repeat(7000), previous: 'Coordinator · desk' })
    expect(text.length).toBeLessThanOrEqual(MAIL_TEXT_MAX)
    expect(text.endsWith(CUT_NOTE)).toBe(true)
    expect(LONE_SURROGATE.test(text)).toBe(false)
  })

  it('a cut that falls between the two halves of an emoji drops the high half', () => {
    const text = reportText({ outcome: 'finished', reason: null, lastMessage: `a${'😀'.repeat(7000)}`, previous: null })
    expect(text).toBe(`a${'😀'.repeat(2999)}\n\n${CUT_NOTE}`)
    expect(text.length).toBe(5999 + 2 + CUT_NOTE.length)
    expect(LONE_SURROGATE.test(text)).toBe(false)
  })

  it('3000 emoji, 6000 units, are kept whole without the note', () => {
    expect(reportText({ outcome: 'finished', reason: null, lastMessage: '😀'.repeat(3000), previous: null }))
      .toBe('😀'.repeat(3000))
  })
})
