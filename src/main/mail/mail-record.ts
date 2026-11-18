import { isUuid } from '../../shared/protocol'
import { COORD_CONTEXT_MAX, COORD_WORDS_MAX } from '../../shared/coordinator'
import { parsePassedAnswers, parseQuestions } from '../../shared/questions'
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

type KindFields = Partial<Pick<MailRecord, 'kind' | 'project' | 'outcome' | 'reason' | 'was' | 'replaces' | 'words' | 'context' | 'questions' | 'answers'>>

/** the kind of a record and the fields that kind keeps; null when the kind is unknown or one of its fields is not valid */
function checkKind(v: Record<string, unknown>): KindFields | null {
  if (v.kind === undefined || v.kind === 'message') return {}
  if (v.kind === 'detach') return { kind: 'detach' }
  if (v.kind === 'task' || v.kind === 'attach') {
    const project = optionalText(v.project, MAIL_NAME_MAX)
    if (project === null) return null
    const fields: KindFields = project === undefined ? { kind: v.kind } : { kind: v.kind, project }
    if (v.kind === 'task') {
      // the person's words, checked on the coordinator's device, and the coordinator's answer they reply to: a context only comes with words
      const words = optionalWords(v.words, COORD_WORDS_MAX)
      const context = optionalWords(v.context, COORD_CONTEXT_MAX)
      if (words === null || context === null || (context !== undefined && words === undefined)) return null
      if (words !== undefined) fields.words = words
      if (context !== undefined) fields.context = context
      return fields
    }
    // an attach may name the id its sender had before a clear, and the coordinator session it replaces
    const was = optionalId(v.was)
    const replaces = optionalId(v.replaces)
    if (was === null || replaces === null) return null
    if (was !== undefined) fields.was = was
    if (replaces !== undefined) fields.replaces = replaces
    return fields
  }
  if (v.kind === 'report') {
    if (!(REPORT_OUTCOMES as readonly unknown[]).includes(v.outcome) || !isUuid(v.replyTo)) return null
    const outcome = v.outcome as ReportOutcome
    if (outcome === 'finished') return { kind: 'report', outcome }
    const reason = optionalText(v.reason, MAIL_REASON_MAX)
    if (reason === null) return null
    return reason === undefined ? { kind: 'report', outcome } : { kind: 'report', outcome, reason }
  }
  // a progress note: the turn's answer on a task still open, which replyTo names
  if (v.kind === 'progress') return isUuid(v.replyTo) ? { kind: 'progress' } : null
  // a question the session asks the person names its task; the person's answers the coordinator passes on, and the withdrawal of a question answered in its tab, name the question
  if (v.kind === 'question') {
    const questions = parseQuestions(v.questions)
    return isUuid(v.replyTo) && questions !== null ? { kind: 'question', questions } : null
  }
  if (v.kind === 'answer') {
    const answers = parsePassedAnswers(v.answers)
    return isUuid(v.replyTo) && answers !== null ? { kind: 'answer', answers } : null
  }
  if (v.kind === 'withdraw') return isUuid(v.replyTo) ? { kind: 'withdraw' } : null
  return null
}

/** a text field that may be absent: undefined when absent, null when present but not 1 to max characters without a control character */
function optionalText(v: unknown, max: number): string | undefined | null {
  if (v === undefined) return undefined
  return typeof v === 'string' && v.length >= 1 && v.length <= max && !/\p{Cc}/u.test(v) ? v : null
}

/** a words or context field that may be absent: undefined when absent, null when present but not a string of 1 to max characters; lines and tabs are allowed, the typed text strips the other control characters, and text made only of whitespace or control characters is refused */
function optionalWords(v: unknown, max: number): string | undefined | null {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length < 1 || v.length > max) return null
  // whitespace or control characters alone carry no words
  return /^[\s\u0000-\u001f\u007f-\u009f]*$/.test(v) ? null : v
}

/** an id field that may be absent: undefined when absent, null when present but not a UUID */
function optionalId(v: unknown): string | undefined | null {
  if (v === undefined) return undefined
  return isUuid(v) ? v : null
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
