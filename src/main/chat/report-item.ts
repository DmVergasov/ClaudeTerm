import type { ChatItem } from '../../shared/chat'
import type { MailRecord } from '../../shared/mail'
import { refOf } from '../mail/agent-directory'

/**
 * A report record as the chat's item: the card of the report, keyed by its mail id so that one report is one card. Null for any
 * record that is not a report with its outcome.
 */
export function reportItemOf(r: MailRecord): Extract<ChatItem, { kind: 'report' }> | null {
  if (r.kind !== 'report' || r.outcome === undefined) return null
  // the mirror takes a time as a whole number of milliseconds only: any other one is no time, not a chat it cannot mirror
  return { kind: 'report', id: `report:${r.id}`, mailId: r.id, name: r.from.name, ref: refOf(r.from.session), outcome: r.outcome, reason: r.reason ?? null, at: Number.isSafeInteger(r.sentAt) ? r.sentAt : null, text: r.text }
}
