import { isUuid } from '../../shared/protocol'
import { MAIL_REASON_MAX, MAIL_TEXT_MAX, REPORT_OUTCOMES, type MailAddress, type MailRecord, type ReportOutcome } from '../../shared/mail'
import { isDeviceId } from '../ipc-guards'

/** the longest name of an end of a message, in characters */
export const MAIL_NAME_MAX = 200

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
  const kind = checkKind(v)
  if (kind === null) return null
  return {
    v: 1,
    id: v.id,
    from,
    to,
    replyTo: v.replyTo,
    text: v.text,
    sentAt: v.sentAt,
    delivered: v.delivered,
    read: v.read,
    ...kind
  }
}

type KindFields = Partial<Pick<MailRecord, 'kind' | 'project' | 'outcome' | 'reason'>>

/** the kind of a record and the fields that kind keeps; null when the kind is unknown or one of its fields is not valid */
function checkKind(v: Record<string, unknown>): KindFields | null {
  if (v.kind === undefined || v.kind === 'message') return {}
  if (v.kind === 'detach') return { kind: 'detach' }
  if (v.kind === 'task' || v.kind === 'attach') {
    const project = optionalText(v.project, MAIL_NAME_MAX)
    if (project === null) return null
    return project === undefined ? { kind: v.kind } : { kind: v.kind, project }
  }
  if (v.kind === 'report') {
    if (!(REPORT_OUTCOMES as readonly unknown[]).includes(v.outcome) || !isUuid(v.replyTo)) return null
    const outcome = v.outcome as ReportOutcome
    if (outcome === 'finished') return { kind: 'report', outcome }
    const reason = optionalText(v.reason, MAIL_REASON_MAX)
    if (reason === null) return null
    return reason === undefined ? { kind: 'report', outcome } : { kind: 'report', outcome, reason }
  }
  return null
}

/** a text field that may be absent: undefined when absent, null when present but not 1 to max characters without a control character */
function optionalText(v: unknown, max: number): string | undefined | null {
  if (v === undefined) return undefined
  return typeof v === 'string' && v.length >= 1 && v.length <= max && !/\p{Cc}/u.test(v) ? v : null
}

function checkAddress(v: unknown): MailAddress | null {
  if (!isObject(v)) return null
  if (v.device !== null && !isDeviceId(v.device)) return null
  if (!isUuid(v.session)) return null
  if (typeof v.name !== 'string' || v.name.length < 1 || v.name.length > MAIL_NAME_MAX || /\p{Cc}/u.test(v.name)) return null
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
