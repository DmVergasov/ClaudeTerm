/** the longest text of a message, in characters */
export const MAIL_TEXT_MAX = 8000
/** the longest agent name a message can be sent to, in characters: the pipe refuses more */
export const MAIL_TO_MAX = 300
/** how long a message is kept, from the time it was sent */
export const MAIL_KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** the oldest Claude Code that the mail watcher is written for */
export const MAIL_MIN_CLAUDE = '2.1.287'

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
}

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
