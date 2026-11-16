import { describe, expect, it } from 'vitest'
import { kindLabel } from '../../src/renderer/mail-panel'

describe('kindLabel', () => {
  it('kindLabel names a task and a report with its outcome, and nothing for a plain message', () => {
    expect(kindLabel({ kind: 'message', outcome: null, reason: null })).toBeNull()
    expect(kindLabel({ kind: 'task', outcome: null, reason: null })).toBe('Task')
    expect(kindLabel({ kind: 'report', outcome: 'finished', reason: null })).toBe('Report · finished')
    expect(kindLabel({ kind: 'report', outcome: 'failed', reason: 'Claude Code exited' })).toBe('Report · failed: Claude Code exited')
    expect(kindLabel({ kind: 'report', outcome: 'stopped', reason: 'its turn was interrupted' })).toBe('Report · stopped')
  })

  it('kindLabel names a report without an outcome as a plain report', () => {
    expect(kindLabel({ kind: 'report', outcome: null, reason: null })).toBe('Report')
  })

  it('kindLabel names a progress note', () => {
    expect(kindLabel({ kind: 'progress', outcome: null, reason: null })).toBe('Progress')
  })
})
