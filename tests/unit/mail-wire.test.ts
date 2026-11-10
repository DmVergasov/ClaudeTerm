import { describe, expect, it } from 'vitest'
import { parseMessage } from '../../src/main/sync/wire'
import type { MailRecord } from '../../src/shared/mail'

const A = '11111111-1111-4111-8111-111111111111'
const S1 = 'a0000000-0000-4000-8000-000000000001'
const DEV_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const DEV_B = '9a1e2f3c-4d5b-4e6f-8a7b-1c2d3e4f5a6b'
const SES_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SES_B = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

const hello = { t: 'hello', v: 1, id: A, name: 'Studio', platform: 'windows', port: 47821, addresses: ['10.0.0.2'], reachedYou: null }

const record = (id: string, over: Partial<MailRecord> = {}): MailRecord => ({
  v: 1,
  id,
  from: { device: DEV_A, session: SES_A, name: 'Parser' },
  to: { device: DEV_B, session: SES_B, name: 'Reviewer' },
  replyTo: null,
  text: 'The parser is ready for review.',
  sentAt: 1700000000000,
  delivered: false,
  read: false,
  ...over
})

describe('mail on the wire', () => {
  it('a hello with mail: 1 keeps it; a hello without it, or with mail: 2, has no mail field', () => {
    expect(parseMessage({ ...hello, mail: 1 })).toMatchObject({ t: 'hello', mail: 1 })
    expect(parseMessage(hello)).not.toHaveProperty('mail')
    expect(parseMessage({ ...hello, mail: 2 })).not.toHaveProperty('mail')
  })

  it('mail-have, mail-records and mail-accept parse; a malformed one is unknown, never a closed link', () => {
    expect(parseMessage({ t: 'mail-have', have: [[S1, 3]] })).toEqual({ t: 'mail-have', have: [[S1, 3]] })
    expect(parseMessage({ t: 'mail-have', have: 'x' })).toBe('unknown')
    expect(parseMessage({ t: 'mail-have', have: [[S1, 4]] })).toBe('unknown')
    expect(parseMessage({ t: 'mail-accept', on: true, wakes: false, claude: '2.1.287' })).toEqual({ t: 'mail-accept', on: true, wakes: false, claude: '2.1.287' })
    expect(parseMessage({ t: 'mail-accept', on: true, wakes: false, claude: null })).toEqual({ t: 'mail-accept', on: true, wakes: false, claude: null })
    expect(parseMessage({ t: 'mail-accept', on: 'yes', wakes: false, claude: null })).toBe('unknown')
    expect(parseMessage({ t: 'mail-records', records: 'x' })).toBe('unknown')
  })

  it('mail-have keeps more when it is true and drops a more that is not true', () => {
    expect(parseMessage({ t: 'mail-have', have: [[S1, 1]], more: true })).toEqual({ t: 'mail-have', have: [[S1, 1]], more: true })
    const parsed = parseMessage({ t: 'mail-have', have: [[S1, 1]], more: 'yes' }) as Record<string, unknown>
    expect(parsed).toEqual({ t: 'mail-have', have: [[S1, 1]] })
    expect(parsed).not.toHaveProperty('more')
  })

  it('mail-records drops an invalid record and keeps the valid ones', () => {
    const good = record(S1)
    const bad = record(A, { text: '' })
    const parsed = parseMessage({ t: 'mail-records', records: [good, bad] })
    expect(parsed).toEqual({ t: 'mail-records', records: [good] })
  })

  it('a mail-have over 20000 entries and mail-records over 500 records are unknown', () => {
    const have = Array.from({ length: 20001 }, () => [S1, 0])
    expect(parseMessage({ t: 'mail-have', have })).toBe('unknown')
    const records = Array.from({ length: 501 }, () => record(S1))
    expect(parseMessage({ t: 'mail-records', records })).toBe('unknown')
  })
})
