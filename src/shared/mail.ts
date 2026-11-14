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

/** what a record is: a message between two agents, a task, a report, or the signal of a session that attaches or detaches */
export type MailKind = 'message' | 'task' | 'report' | 'attach' | 'detach'
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
  replyTo: string | null
  text: string
  sentAt: number
  delivered: boolean
  read: boolean
  /** absent: a message (every record of an older ClaudeTerm) */
  kind?: 'task' | 'report' | 'attach' | 'detach'
  /** task, attach: the coordinator's project name */
  project?: string
  /** report: how the task ended (required on a report) */
  outcome?: ReportOutcome
  /** report, failed or stopped: why */
  reason?: string
}

export const kindOf = (r: Pick<MailRecord, 'kind'>): MailKind => r.kind ?? 'message'
/** attach and detach tell a device, not a model: never handed over, counted or listed */
export const isSignal = (r: Pick<MailRecord, 'kind'>): boolean => r.kind === 'attach' || r.kind === 'detach'

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
  sentAt: number
  text: string
  delivered: boolean
  read: boolean
  kind: MailKind
  /** null unless the record is a report */
  outcome: ReportOutcome | null
  /** null when the record has no reason */
  reason: string | null
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
