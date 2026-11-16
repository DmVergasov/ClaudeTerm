import { describe, expect, it } from 'vitest'
import { checkMailRecord, mailFlags, mergeMail } from '../../src/main/mail/mail-record'
import type { MailRecord } from '../../src/shared/mail'

const ID = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const DEV_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const DEV_B = '9a1e2f3c-4d5b-4e6f-8a7b-1c2d3e4f5a6b'
const SES_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SES_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const TASK_ID = '2c9d0e1f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const OLD = '4b7c6d5e-9f8a-4b3c-8d2e-1f0a9b8c7d6e'
const PREV = '5c8d7e6f-0a9b-4c4d-9e3f-2a1b0c9d8e7f'

const record = (): MailRecord => ({
  v: 1,
  id: ID,
  from: { device: DEV_A, session: SES_A, name: 'Parser' },
  to: { device: DEV_B, session: SES_B, name: 'Reviewer' },
  replyTo: null,
  text: 'The parser is ready for review.',
  sentAt: 1700000000000,
  delivered: false,
  read: false
})

describe('checkMailRecord', () => {
  it('accepts a well-formed record and returns a copy without extra fields', () => {
    const input = { ...record(), extra: 'dropped' }
    const checked = checkMailRecord(input)
    expect(checked).toEqual(record())
    expect(checked).not.toBe(input)
    expect(checked).not.toHaveProperty('extra')
  })

  it('rejects a bad id, a non-UUID session, a text of 0 or 8001 characters, a non-boolean flag, a wrong v', () => {
    const bad: unknown[] = [
      { ...record(), id: 'not-a-uuid' },
      { ...record(), from: { ...record().from, session: 'x' } },
      { ...record(), text: '' },
      { ...record(), text: 'x'.repeat(8001) },
      { ...record(), read: 'yes' },
      { ...record(), delivered: 1 },
      { ...record(), v: 2 }
    ]
    for (const v of bad) expect(checkMailRecord(v)).toBeNull()
  })

  it('accepts a text of exactly 8000 characters', () => {
    expect(checkMailRecord({ ...record(), text: 'x'.repeat(8000) })?.text.length).toBe(8000)
  })

  it('accepts device null in from and to', () => {
    const r = checkMailRecord({ ...record(), from: { ...record().from, device: null }, to: { ...record().to, device: null } })
    expect(r?.from.device).toBeNull()
    expect(r?.to.device).toBeNull()
  })

  it('rejects a name that is empty, longer than 200 characters or has a control character', () => {
    expect(checkMailRecord({ ...record(), to: { ...record().to, name: '' } })).toBeNull()
    expect(checkMailRecord({ ...record(), to: { ...record().to, name: 'n'.repeat(201) } })).toBeNull()
    expect(checkMailRecord({ ...record(), to: { ...record().to, name: 'bad\nname' } })).toBeNull()
  })

  it('rejects a negative or non-finite sentAt and a replyTo that is not a UUID', () => {
    expect(checkMailRecord({ ...record(), sentAt: -1 })).toBeNull()
    expect(checkMailRecord({ ...record(), sentAt: Infinity })).toBeNull()
    expect(checkMailRecord({ ...record(), replyTo: 'x' })).toBeNull()
  })
})

describe('checkMailRecord kinds', () => {
  const base = record()

  it('keeps a task with its project; a message carries no kind', () => {
    expect(checkMailRecord({ ...base, kind: 'task', project: 'acme' })).toEqual({ ...base, kind: 'task', project: 'acme' })
    expect(checkMailRecord({ ...base, kind: 'message', project: 'acme' })).toEqual(base)
  })

  it('keeps a report with its outcome, its task id as replyTo and the reason of a failure', () => {
    const r = { ...base, kind: 'report', replyTo: TASK_ID, outcome: 'failed', reason: 'Claude Code exited' }
    expect(checkMailRecord(r)).toEqual(r)
    expect(checkMailRecord({ ...r, outcome: 'finished' })).toEqual({ ...base, kind: 'report', replyTo: TASK_ID, outcome: 'finished' })
  })

  it('refuses a report without an outcome or a replyTo, and an unknown kind', () => {
    expect(checkMailRecord({ ...base, kind: 'report', replyTo: TASK_ID })).toBeNull()
    expect(checkMailRecord({ ...base, kind: 'report', outcome: 'finished', replyTo: null })).toBeNull()
    expect(checkMailRecord({ ...base, kind: 'poll' })).toBeNull()
  })

  it('refuses a project or a reason over 200 characters or with a control character', () => {
    expect(checkMailRecord({ ...base, kind: 'task', project: 'x'.repeat(201) })).toBeNull()
    expect(checkMailRecord({ ...base, kind: 'attach', project: 'a\nb' })).toBeNull()
    expect(checkMailRecord({ ...base, kind: 'report', replyTo: TASK_ID, outcome: 'stopped', reason: 'x'.repeat(201) })).toBeNull()
  })

  it('an attach keeps was and replaces when they are session ids; other kinds drop them', () => {
    const a = { ...base, kind: 'attach', project: 'acme', was: OLD, replaces: PREV }
    expect(checkMailRecord(a)).toEqual(a)
    expect(checkMailRecord({ ...a, was: 'not-an-id' })).toBeNull()
    expect(checkMailRecord({ ...a, replaces: 'not-an-id' })).toBeNull()
    expect(checkMailRecord({ ...base, kind: 'task', project: 'acme', was: OLD })).toEqual({ ...base, kind: 'task', project: 'acme' })
  })

  it('keeps a progress note with its task id as replyTo, and drops the fields of other kinds', () => {
    const p = { ...base, kind: 'progress', replyTo: TASK_ID }
    expect(checkMailRecord(p)).toEqual(p)
    expect(checkMailRecord({ ...p, outcome: 'finished', reason: 'x', project: 'acme' })).toEqual(p)
  })

  it('refuses a progress note without a task id', () => {
    expect(checkMailRecord({ ...base, kind: 'progress', replyTo: null })).toBeNull()
  })
})

describe('mergeMail', () => {
  it('keeps the first text and ORs the flags', () => {
    const r = record()
    const merged = mergeMail({ ...r, read: false, delivered: true }, { ...r, text: 'other', read: true, delivered: false })
    expect(merged).toEqual({ ...r, delivered: true, read: true })
  })
})

describe('mailFlags', () => {
  it('is 0, 1, 2 or 3 for delivered and read', () => {
    expect(mailFlags({ ...record(), delivered: false, read: false })).toBe(0)
    expect(mailFlags({ ...record(), delivered: true, read: false })).toBe(1)
    expect(mailFlags({ ...record(), delivered: false, read: true })).toBe(2)
    expect(mailFlags({ ...record(), delivered: true, read: true })).toBe(3)
  })
})
