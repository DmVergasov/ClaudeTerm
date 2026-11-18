/*
 * The person's words through the coordinator: a coordinator can hand a session the person's own latest message. The words are
 * checked here, word for word, against the prompts of the coordinator's transcript and the text the window submitted into its tab,
 * so that only a message the person typed (or sent from the chat composer) in the coordinator's tab is typed into the session.
 */

import { COORD_CONTEXT_MAX, COORD_WORDS_MAX } from '../../shared/coordinator'
import { isClaudeCodeFlag, isClaudeCodeText, isObj, type Obj } from '../chat/chat-fold'
import { isClaudeTermText } from '../claudeterm-text'
import { formEntries, FORMS_KEPT, type FormEntry, type FormResult } from './form-answers'
import type { Submit } from './person-input'

/** a person's message can be passed on for this long after it was written, at most */
export const WORDS_KEEP_MS = 24 * 60 * 60 * 1000
/** a submit may come this long after the transcript gives the prompt, and a prompt's time may be this far ahead of the read: clock skew */
export const INPUT_SLACK_MS = 5000
/** the prompts of a transcript kept for the check: the latest this many */
export const WORDS_PROMPTS_KEPT = 50
/** a transcript line longer than this is not parsed: a pasted file or a tool result is read at its head and its tail only */
export const WORDS_LINE_MAX = 1_000_000
/** how much of a line too long to parse is read at its head, and how much at its tail */
const LONG_LINE_SCAN = 65_536

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const LOW_SURROGATE = /^[\udc00-\udfff]/

/** text with its line endings as LF and its outer whitespace removed */
export function normWords(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** an answer of the coordinator as the context of a message: its control characters removed, its end kept, with … in front when cut */
export function clipContext(text: string): string | null {
  const clean = normWords(text).replace(CONTROL, '')
  if (clean === '') return null
  if (clean.length <= COORD_CONTEXT_MAX) return clean
  let tail = clean.slice(clean.length - (COORD_CONTEXT_MAX - 1))
  if (LOW_SURROGATE.test(tail)) tail = tail.slice(1)
  return `…${tail}`
}

/** the tag rule of a prompt: a text that starts with a tag, such as a task notification, is a message of a tool, not the person's */
export const TAG_TEXT = /^<[A-Za-z][\w-]*[\s>/]/

/** whether a text is the person's own message: not one ClaudeTerm wrote, nor one that starts with a tag */
export function isPersonPrompt(text: string): boolean {
  const t = text.trim()
  return !isClaudeTermText(t) && !TAG_TEXT.test(t)
}

/** one transcript line's words: a prompt (of the person's kind when `plain`), an answer of the coordinator's Claude, or the answers of a form the person gave */
export type WordsLine =
  | { kind: 'prompt'; id: string; at: number; text: string; plain: boolean }
  | { kind: 'answer'; text: string }
  | { kind: 'form'; id: string; at: number; answers: FormEntry[] }

/** the text blocks of a content joined by `joiner`; a string is its own text */
function textOf(content: unknown, joiner: string): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) if (isObj(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  return parts.join(joiner)
}

/** a prompt's line: whose it is, from its origin and its text; null for what Claude Code or the history writes around a turn */
function promptOf(o: Obj, raw: string, origin: unknown, stamp: string | undefined): WordsLine | null {
  const text = normWords(raw)
  if (isClaudeCodeText(text) || text.startsWith('<local-command-')) return null
  // a message the person typed has no origin but the human one; a tag such as <task-notification> is a message of a tool
  const plain = (origin === undefined || (isObj(origin) && origin.kind === 'human')) && !TAG_TEXT.test(text) && !isClaudeTermText(text)
  const parsed = stamp === undefined ? NaN : Date.parse(stamp)
  const at = Number.isFinite(parsed) ? parsed : 0
  const id = typeof o.uuid === 'string' ? o.uuid : `at:${at}`
  return { kind: 'prompt', id, at, text, plain }
}

/**
 * a line too long to parse, read at its head and its tail: a user or queued line is still a prompt, so it blocks the earlier ones
 * (with no text, so it is never relayed); its id and its time come from the tail. A tool result, a meta or sidechain entry and a
 * compaction summary give null, as they do when parsed
 */
function longLineOf(line: string): WordsLine | null {
  const head = line.slice(0, LONG_LINE_SCAN)
  const tail = line.slice(-LONG_LINE_SCAN)
  if (!(head.includes('"type":"user"') || head.includes('"queued_command"'))) return null
  if (['"tool_use_id"', '"isSidechain":true', '"isMeta":true', '"isCompactSummary":true'].some((k) => head.includes(k))) return null
  const last = (key: string): string | null => {
    const found = [...tail.matchAll(new RegExp(`"${key}":"([^"]{1,100})"`, 'g'))]
    return found.length === 0 ? null : found[found.length - 1]![1]!
  }
  const stamp = last('timestamp')
  const parsed = stamp === null ? NaN : Date.parse(stamp)
  return { kind: 'prompt', id: last('uuid') ?? `long:${line.length}`, at: Number.isFinite(parsed) ? parsed : 0, text: '', plain: true }
}

/**
 * the answers of an AskUserQuestion result, read from its toolUseResult: a form of the person's answers, with its time and its id; null
 * when the answers are not 1 to 4 within their bounds
 */
function formOf(o: Obj, answers: Obj): WordsLine | null {
  const entries = formEntries(answers)
  if (entries === null) return null
  const parsed = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  const at = Number.isFinite(parsed) ? parsed : 0
  const id = typeof o.uuid === 'string' ? o.uuid : `at:${at}`
  return { kind: 'form', id, at, answers: entries }
}

/**
 * the words of one line of a coordinator's transcript: a prompt, an answer, a form, or null for a line that holds none of them. A line
 * that does not parse gives nothing; a line too long to parse gives what longLineOf reads of it
 */
export function wordsLine(line: string): WordsLine | null {
  if (line.length > WORDS_LINE_MAX) return longLineOf(line)
  // a result of AskUserQuestion is a tool result, so it is read as a form before the prompts' test that leaves tool results out
  const form = line.includes('"toolUseResult"') && line.includes('"answers"')
  const maybe = form ||
    (line.includes('"type":"user"') && !line.includes('"tool_use_id"')) ||
    (line.includes('"type":"assistant"') && line.includes('"type":"text"')) ||
    line.includes('"queued_command"')
  if (!maybe) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObj(parsed) || parsed.isSidechain === true || parsed.isVisibleInTranscriptOnly === true || isClaudeCodeFlag(parsed)) return null
  const o = parsed
  if (o.type === 'user' && isObj(o.toolUseResult) && isObj(o.toolUseResult.answers)) return formOf(o, o.toolUseResult.answers)
  if (o.type === 'assistant') {
    const text = textOf(isObj(o.message) ? o.message.content : undefined, '\n\n').trim()
    return text === '' ? null : { kind: 'answer', text }
  }
  if (o.type === 'attachment') {
    // a message queued while a turn ran: Claude Code keeps it as an attachment, with the prompt as its text
    const a = o.attachment
    if (!isObj(a) || a.type !== 'queued_command' || a.isMeta === true) return null
    const stamp = typeof o.timestamp === 'string' ? o.timestamp : typeof a.timestamp === 'string' ? a.timestamp : undefined
    return promptOf(o, textOf(a.prompt, '\n'), a.origin, stamp)
  }
  if (o.type === 'user') {
    if (!isObj(o.message)) return null
    const content = o.message.content
    // the result of a tool call is not a message of the person
    if (Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result')) return null
    return promptOf(o, textOf(content, '\n'), o.origin, typeof o.timestamp === 'string' ? o.timestamp : undefined)
  }
  return null
}

/** a prompt of the transcript: its text when it is the person's and short enough to pass on, its time, and the window's input before it */
export interface WordsPrompt {
  id: string
  at: number
  text: string | null
  plain: boolean
  /** the time of the previous plain prompt: the window's submit for this prompt came after it */
  after: number
  /** the coordinator's answer that came before the prompt, since the prompt before it */
  context: string | null
}

/** the latest prompts of a transcript and the answers between them, read line by line as the transcript grows */
export class WordsLog {
  private readonly list: WordsPrompt[] = []
  private readonly seen = new Set<string>()
  private readonly formList: FormResult[] = []
  private readonly formSeen = new Set<string>()
  private answer = ''
  private last: number

  /** a log for a conversation that began at `startAt`: no submit before that backs its first prompt */
  constructor(startAt = 0) {
    this.last = startAt
  }

  /** a line read at `readAt`: a prompt's own time is not believed when it is ahead of that, and then counts as the read time */
  add(line: WordsLine, readAt: number): void {
    if (line.kind === 'form') {
      // a form is kept apart: it leaves the prompts and the answers before them as they are
      if (this.formSeen.has(line.id)) return
      this.formSeen.add(line.id)
      const ahead = line.at > readAt + INPUT_SLACK_MS
      this.formList.push({ id: line.id, at: line.at === 0 || ahead ? readAt : line.at, answers: line.answers })
      if (this.formList.length > FORMS_KEPT) this.formList.shift()
      return
    }
    if (line.kind === 'answer') {
      const joined = this.answer === '' ? line.text : `${this.answer}\n\n${line.text}`
      this.answer = joined.length > 2 * COORD_CONTEXT_MAX ? joined.slice(joined.length - 2 * COORD_CONTEXT_MAX) : joined
      return
    }
    // a prompt read again (the transcript was read from its start again) is kept once
    if (this.seen.has(line.id)) {
      this.answer = ''
      return
    }
    this.seen.add(line.id)
    const ahead = line.at > readAt + INPUT_SLACK_MS
    const at = line.at === 0 || ahead ? readAt : line.at
    const text = line.plain && !ahead && line.text !== '' && line.text.length <= COORD_WORDS_MAX ? line.text : null
    this.list.push({ id: line.id, at, text, plain: line.plain, after: this.last, context: this.answer === '' ? null : clipContext(this.answer) })
    if (this.list.length > WORDS_PROMPTS_KEPT) this.list.shift()
    this.answer = ''
    if (line.plain) this.last = Math.max(this.last, at)
  }

  prompts(): readonly WordsPrompt[] {
    return this.list
  }

  /** the latest forms the person answered in the transcript, oldest first */
  forms(): readonly FormResult[] {
    return this.formList
  }
}

export type WordsCheck = { ok: true; id: string; words: string; context: string | null } | { ok: false; reason: 'not-person' | 'old' | 'not-latest' }

/**
 * whether `words` are the person's own latest message: a plain prompt whose text is the words and that the window submitted (a submit
 * after the prompt before it, up to a few seconds after its own time, with the words as one reading), the newest plain prompt of the
 * transcript, not older than a day and from this run of the app, and with no later submit of the window that wrote something
 */
export function checkWords(o: {
  words: string
  prompts: readonly WordsPrompt[]
  submits: readonly Submit[]
  now: number
  startedAt: number
}): WordsCheck {
  const words = normWords(o.words)
  if (words === '') return { ok: false, reason: 'not-person' }
  const plains = o.prompts.filter((p) => p.plain)
  const backing = (p: WordsPrompt): Submit[] =>
    o.submits.filter((s) => s.at > p.after && s.at <= p.at + INPUT_SLACK_MS && s.texts !== null && s.texts.some((t) => normWords(t) === words))
  // a prompt from before this run has no record of the window's submits: it counts here only so that it is refused as old
  const match = [...plains].reverse().find((p) => p.text === words && (p.at < o.startedAt || backing(p).length > 0))
  if (match === undefined) return { ok: false, reason: 'not-person' }
  if (match.at < o.startedAt || o.now - match.at > WORDS_KEEP_MS) return { ok: false, reason: 'old' }
  if (match !== plains[plains.length - 1]) return { ok: false, reason: 'not-latest' }
  // the person wrote again after the submit that backs the words, and the transcript may not hold it yet
  const typed = Math.max(...backing(match).map((s) => s.at))
  if (o.submits.some((s) => s.at > typed && s.wrote)) return { ok: false, reason: 'not-latest' }
  return { ok: true, id: match.id, words, context: match.context }
}
