import { isUuid } from '../../shared/protocol'
import { MAIL_TEXT_MAX, type MailAddress, type MailRecord } from '../../shared/mail'
import { isDeviceId } from '../ipc-guards'

const NAME_MAX = 200

/** A message record from a file or a peer as a checked copy with only its own fields; null when it is not a valid record. */
export function checkMailRecord(v: unknown): MailRecord | null {
  if (!isObject(v) || v.v !== 1 || !isUuid(v.id)) return null
  const from = checkAddress(v.from)
  const to = checkAddress(v.to)
  if (!from || !to) return null
  if (v.replyTo !== null && !isUuid(v.replyTo)) return null
  if (typeof v.text !== 'string' || v.text.length < 1 || v.text.length > MAIL_TEXT_MAX) return null
  if (typeof v.sentAt !== 'number' || !Number.isFinite(v.sentAt) || v.sentAt < 0) return null
  if (typeof v.delivered !== 'boolean' || typeof v.read !== 'boolean') return null
  return {
    v: 1,
    id: v.id,
    from,
    to,
    replyTo: v.replyTo,
    text: v.text,
    sentAt: v.sentAt,
    delivered: v.delivered,
    read: v.read
  }
}

function checkAddress(v: unknown): MailAddress | null {
  if (!isObject(v)) return null
  if (v.device !== null && !isDeviceId(v.device)) return null
  if (!isUuid(v.session)) return null
  if (typeof v.name !== 'string' || v.name.length < 1 || v.name.length > NAME_MAX || /\p{Cc}/u.test(v.name)) return null
  return { device: v.device, session: v.session, name: v.name }
}

/** The same message seen twice: the first text, and every flag either copy has. */
export function mergeMail(mine: MailRecord, theirs: MailRecord): MailRecord {
  return { ...mine, delivered: mine.delivered || theirs.delivered, read: mine.read || theirs.read }
}

/** The flags of a record as a number: 1 when delivered, 2 when read. */
export function mailFlags(r: MailRecord): number {
  return (r.delivered ? 1 : 0) | (r.read ? 2 : 0)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
