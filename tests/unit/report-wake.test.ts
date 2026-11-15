import { describe, expect, it } from 'vitest'
import { wakeText } from '../../src/main/mail/wake-text'
import type { MailRecord } from '../../src/shared/mail'
import { outcomeText, REPORT_WAKE_HEAD, splitWake } from '../../src/shared/report-wake'

const COORD = { device: null, session: 'c0000000-0000-4000-8000-000000000001', name: 'coord · Desktop' }
const PARSER = { device: null, session: 'a1000000-0000-4000-8000-000000000002', name: 'parser · Desktop' }
const TASK = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const report = (over: Partial<MailRecord>): MailRecord => ({ v: 1, id: '0b9a7c1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d', from: PARSER, to: COORD, text: 'Parser fixed.', replyTo: TASK, sentAt: 5, delivered: false, read: false, kind: 'report', outcome: 'finished', ...over })
const where = () => ({ folder: 'D:\\Work\\acme', branch: 'main' })

describe('splitWake reads the report blocks of a wake text', () => {
  it('reads a finished report: its mail id, the session\'s name and ref, and its text', () => {
    expect(splitWake(wakeText([report({})], where))).toEqual({ reports: [{ mailId: report({}).id, name: 'parser · Desktop', ref: 'a10000', outcome: 'finished', reason: null, text: 'Parser fixed.' }], rest: '' })
  })

  it('reads a failed and a stopped report with their reasons, and a text of several lines', () => {
    expect(splitWake(wakeText([report({ outcome: 'failed', reason: 'Claude Code exited', text: 'Half done.\n\nSee notes.' })], where)).reports[0]).toMatchObject({ outcome: 'failed', reason: 'Claude Code exited', text: 'Half done.\n\nSee notes.' })
    expect(splitWake(wakeText([report({ outcome: 'stopped', reason: 'its turn was interrupted' })], where)).reports[0]).toMatchObject({ outcome: 'stopped', reason: 'its turn was interrupted' })
  })

  it('splitWake keeps the other blocks as the rest', () => {
    const DOCS = { device: null, session: 'b2000000-0000-4000-8000-000000000003', name: 'docs · Desktop' }
    const message: MailRecord = { v: 1, id: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a', from: DOCS, to: COORD, text: 'hello from docs', replyTo: null, sentAt: 1, delivered: false, read: false }
    const text = wakeText([message, report({})], where)
    const split = splitWake(text)
    expect(split.reports.map((r) => r.text)).toEqual(['Parser fixed.'])
    expect(split.rest).toBe(wakeText([message], where))
  })

  it('a quoted header line stays in its report\'s text', () => {
    const t = `${REPORT_WAKE_HEAD} its task finished.`
    expect(splitWake(wakeText([report({ text: `Quoting:\n${t}` })], where)).reports.map((r) => r.text)).toEqual([`Quoting:\n${t}`])
  })

  it('a text that is not wholly wake blocks is no wake', () => {
    expect(splitWake('Report from a session attached to you, through ClaudeTerm: its task finished.\nplain')).toEqual({ reports: [], rest: 'Report from a session attached to you, through ClaudeTerm: its task finished.\nplain' })
    expect(splitWake('Fix the parser.')).toEqual({ reports: [], rest: 'Fix the parser.' })
  })
})

describe('outcomeText', () => {
  it('says how a task ended, with its reason when it failed', () => {
    expect([outcomeText('finished', null), outcomeText('failed', 'Claude Code exited'), outcomeText('failed', null), outcomeText('stopped', 'its turn was interrupted')]).toEqual(['finished', 'failed: Claude Code exited', 'failed', 'stopped'])
  })
})
