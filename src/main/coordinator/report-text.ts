import type { ReportOutcome } from '../../shared/mail'

/** the longest text of a report passed on, in UTF-16 units: the mail record's own limit is MAIL_TEXT_MAX */
export const REPORT_TEXT_MAX = 6000
export const NO_ANSWER = '(The session ended its turn without an answer text.)'
export const CUT_NOTE = '[Cut: the answer is longer than ClaudeTerm passes on; the full answer is in the session.]'
export const REASONS = {
  interrupted: 'its turn was interrupted',
  clear: 'the session was cleared',
  replaced: "the person's newer words replaced it",
  exit: 'Claude Code exited',
  closed: 'its tab was closed',
  error: (error: string) => `Claude Code stopped the turn on an error (${error})`
}

/** the text of a report a session sends its coordinator when a task ends */
export function reportText(o: { outcome: ReportOutcome; reason: string | null; lastMessage: string | null; previous: string | null }): string {
  const body = o.lastMessage?.trim() || null
  let text: string
  if (o.outcome === 'finished') {
    text = body ?? NO_ANSWER
  } else {
    const reason = o.reason ?? 'no reason given'
    const head = o.outcome === 'failed' ? `The task failed: ${reason}.` : `The task was stopped by the user: ${reason}.`
    text = body ? `${head}\n\nIts last answer:\n\n${body}` : head
  }
  if (o.previous) text = `(This task was given by the previous coordinator, ${o.previous}.)\n\n${text}`
  return cutReport(text)
}

/** the text of a progress note: the turn's answer, cut as a report's is; null for a turn without an answer */
export function progressText(lastMessage: string): string | null {
  const body = lastMessage.trim()
  return body === '' ? null : cutReport(body)
}

/** a text kept to REPORT_TEXT_MAX, with the CUT_NOTE after it, when it is longer */
function cutReport(text: string): string {
  if (text.length <= REPORT_TEXT_MAX) return text

  let kept = text.slice(0, REPORT_TEXT_MAX)
  // a cut between the two halves of a surrogate pair leaves a lone high surrogate: drop it too
  const last = kept.charCodeAt(kept.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1)
  return `${kept}\n\n${CUT_NOTE}`
}
