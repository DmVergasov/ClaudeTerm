import type { AskedQuestion, PassedAnswer } from './questions'

/** the longest text of a message, in characters */
export const MAIL_TEXT_MAX = 8000
/** the longest agent name a message can be sent to, in characters: the pipe refuses more */
export const MAIL_TO_MAX = 300
/** how long a message is kept, from the time it was sent */
export const MAIL_KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** the oldest Claude Code that the mail watcher is written for */
export const MAIL_MIN_CLAUDE = '2.1.287'
/** the longest reason of a failed or stopped report, in characters */
export const MAIL_REASON_MAX = 200

/** what a record is: a message between two agents, a task, a report, a progress note on a task, the signal of a session that attaches or detaches, a session's question the person answers, the person's answers passed on, or the withdrawal of a question answered in its tab */
export type MailKind = 'message' | 'task' | 'report' | 'attach' | 'detach' | 'progress' | 'question' | 'answer' | 'withdraw'
/** how the task of a report ended */
export type ReportOutcome = 'finished' | 'failed' | 'stopped'
export const REPORT_OUTCOMES: readonly ReportOutcome[] = ['finished', 'failed', 'stopped']

/** one end of a conversation: device null is this device on a device never paired (such records never leave it) */
export interface MailAddress {
  device: string | null
  session: string
  name: string
}

export interface MailRecord {
  v: 1
  id: string
  from: MailAddress
  to: MailAddress
  /** progress: the task the note is on (required) */
  replyTo: string | null
  text: string
  sentAt: number
  delivered: boolean
  read: boolean
  /** absent: a message (every record of an older ClaudeTerm) */
  kind?: 'task' | 'report' | 'attach' | 'detach' | 'progress' | 'question' | 'answer' | 'withdraw'
  /** task, attach: the coordinator's project name */
  project?: string
  /** report: how the task ended (required on a report) */
  outcome?: ReportOutcome
  /** report, failed or stopped: why */
  reason?: string
  /** attach: the sender's end took a new session id (a clear, a compaction); was is the id it had. The receiver re-keys what it holds of that end, the tasks it gave included */
  was?: string
  /** attach: the coordinator session the sender replaces on its device. The session moves to the sender; its tasks keep their giver */
  replaces?: string
  /** task: the person's own message the coordinator passed on, checked on the coordinator's device; it is typed into the session's prompt, never handed to a watcher */
  words?: string
  /** task with words: the coordinator's answer the words reply to */
  context?: string
  /** question: the questions the session asks the person, in the coordinator's form; set on a question only */
  questions?: AskedQuestion[]
  /** answer: the questions the coordinator passes on with the person's answers; set on an answer only */
  answers?: PassedAnswer[]
}

export const kindOf = (r: Pick<MailRecord, 'kind'>): MailKind => r.kind ?? 'message'
/** attach, detach and withdraw tell a device, not a model: never handed over, counted or listed */
export const isSignal = (r: Pick<MailRecord, 'kind'>): boolean => r.kind === 'attach' || r.kind === 'detach' || r.kind === 'withdraw'

/** unread messages per tab id, for the marks */
export type MailUnread = Record<string, number>

export interface MailEndView {
  name: string
  device: string | null
  deviceName: string
}

export interface MailMessageView {
  id: string
  from: MailEndView
  /** the end of the conversation the message came from */
  side: 'a' | 'b'
  sentAt: number
  text: string
  delivered: boolean
  read: boolean
  kind: MailKind
  /** null unless the record is a report */
  outcome: ReportOutcome | null
  /** null when the record has no reason */
  reason: string | null
  /** true for a task that carries the person's words */
  words: boolean
}

export interface MailConversationView {
  key: string
  /** the end that is the tab the conversations were asked for; null when all were asked for */
  mine: 'a' | 'b' | null
  a: MailEndView
  b: MailEndView
  lastAt: number
  messages: MailMessageView[]
}
