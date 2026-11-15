import { describe, expect, it } from 'vitest'
import { reportItemOf } from '../../src/main/chat/report-item'
import type { MailRecord } from '../../src/shared/mail'

const COORD = { device: null, session: 'c0000000-0000-4000-8000-000000000001', name: 'coord · Desktop' }
const PARSER = { device: null, session: 'a1000000-0000-4000-8000-000000000002', name: 'parser · Desktop' }
const TASK = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const report = (over: Partial<MailRecord>): MailRecord => ({ v: 1, id: '0b9a7c1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d', from: PARSER, to: COORD, text: 'Parser fixed.', replyTo: TASK, sentAt: 5, delivered: false, read: false, kind: 'report', outcome: 'finished', ...over })

describe('reportItemOf', () => {
  it('a report record is a report item keyed by its mail id; any other record is none', () => {
    expect(reportItemOf(report({ outcome: 'failed', reason: 'Claude Code exited' }))).toEqual({
      kind: 'report', id: 'report:0b9a7c1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d', mailId: '0b9a7c1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d', name: 'parser · Desktop', ref: 'a10000',
      outcome: 'failed', reason: 'Claude Code exited', at: 5, text: 'Parser fixed.'
    })
    expect(reportItemOf(report({ kind: 'task', outcome: undefined }))).toBeNull()
    expect(reportItemOf(report({ kind: undefined, outcome: undefined }))).toBeNull()
  })
})
