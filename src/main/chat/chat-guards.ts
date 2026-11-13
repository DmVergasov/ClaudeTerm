import { HEADS_UP_ACTIONS, type ChatAnswer, type ChatAttachment, type ChatPermissionMode, type ChatSend, type HeadsUpAction } from '../../shared/chat'

// The checks on what the renderer sends back: every field's type and size

const TEXT_CAP = 64 * 1024
const PATH_CAP = 4096
const SEND_TEXT_CAP = 1024 * 1024
const MAX_ATTACHMENTS = 20
const MAX_QUESTIONS = 4
const MAX_ANSWER_LIST = 8
const MODES: readonly ChatPermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown, cap = TEXT_CAP): v is string => typeof v === 'string' && v.length <= cap
const isOptText = (v: unknown): boolean => v === null || isText(v)
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
/** a path as the local system writes it: a drive, a root or a UNC share */
const looksAbsolute = (p: string): boolean => /^([A-Za-z]:[\\/]|[\\/])/.test(p)

function isAnswers(v: unknown): boolean {
  if (!isObj(v)) return false
  const keys = Object.keys(v)
  if (keys.length > MAX_QUESTIONS) return false
  return keys.every(key => {
    const value = v[key]
    if (!isText(key)) return false
    if (isText(value)) return true
    return Array.isArray(value) && value.length <= MAX_ANSWER_LIST && value.every(item => isText(item))
  })
}

/** an answer the renderer sent to a card */
export function isChatAnswer(v: unknown): v is ChatAnswer {
  if (!isObj(v)) return false
  switch (v.type) {
    case 'permission':
      return (v.choice === 'once' || v.choice === 'deny') && (v.suggestion === null || isCount(v.suggestion)) && isOptText(v.message)
    case 'question':
      return v.answers === null || isAnswers(v.answers)
    case 'plan':
      return (v.choice === 'accept-edits' || v.choice === 'ask-edits' || v.choice === 'keep-planning') && isOptText(v.message)
    case 'dialog':
      return v.choice === null || isText(v.choice)
    default:
      return false
  }
}

function isAttachment(v: unknown): v is ChatAttachment {
  return isObj(v) && (v.kind === 'image' || v.kind === 'file') && isText(v.path, PATH_CAP) && looksAbsolute(v.path)
    && isText(v.name, PATH_CAP) && isCount(v.size) && (v.cardId === null || isText(v.cardId, 64))
}

/** a message's origin when it is not the person's own typing: the automatic continue, or the Changes panel's Send */
export const isChatOrigin = (v: unknown): boolean => v === 'auto' || v === 'review'

/** a message the user sent, with its attachments; its origin, when it has one, is one the window may name */
export function isChatSend(v: unknown): v is ChatSend {
  return isObj(v) && isText(v.text, SEND_TEXT_CAP) && Array.isArray(v.attachments)
    && v.attachments.length <= MAX_ATTACHMENTS && v.attachments.every(isAttachment)
    && (v.from === undefined || isChatOrigin(v.from))
}

export function isPermissionMode(v: unknown): v is ChatPermissionMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
}

/** the person's answer to a Heads up card */
export function isHeadsUpAction(v: unknown): v is HeadsUpAction {
  return typeof v === 'string' && (HEADS_UP_ACTIONS as readonly string[]).includes(v)
}
