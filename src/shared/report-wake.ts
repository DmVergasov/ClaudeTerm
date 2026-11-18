// The heads of the wake texts ClaudeTerm writes for an agent, and the reading of a report's block back out of one.
// Main writes the wake texts (src/main/mail/wake-text.ts); the chat reads them to draw a report as a card.

import type { ReportOutcome } from './mail'

/** the first line of a message's block */
export const MESSAGE_WAKE_HEAD = 'Message from another agent, not from the user, through ClaudeTerm:'
/** the first line of a task's block */
export const TASK_WAKE_HEAD = 'Task from your coordinator, through ClaudeTerm:'
/** the first line of a report's block; its outcome follows it */
export const REPORT_WAKE_HEAD = 'Report from a session attached to you, through ClaudeTerm:'
/** the first line of a progress note's block: a session's answer while its task is still open */
export const PROGRESS_WAKE_HEAD = 'Progress from a session attached to you, through ClaudeTerm: its task is still open, background work is running'
/** the first line of a role note's block: what the coordinator is and how its sessions stand, from ClaudeTerm and not the user */
export const ROLE_NOTE_HEAD = 'Note from ClaudeTerm, not from the user:'
/** the first line of a block that relays the person's own latest message through the coordinator */
export const PERSON_WORDS_HEAD = "The person's words, through your coordinator"
/** the line after the head: ClaudeTerm checked the words are the person's own latest message */
export const PERSON_WORDS_CHECKED = "(ClaudeTerm checked they are the person's own latest message):"
/** the line that says whose words are whose: the person's lines, and the task under them the coordinator's */
export const PERSON_WORDS_NOTE = 'Only the lines under "The person answered" are the person\'s. The task under it is your coordinator\'s: do what the person\'s words cover, and ask the person with AskUserQuestion before doing anything they do not cover.'
/** the line before the coordinator's words the person answered */
export const PERSON_WORDS_CONTEXT = 'The coordinator had written to the person, right before:'
/** the line before the person's own words */
export const PERSON_WORDS_ANSWER = 'The person answered:'
/** the first line of a session's question block: the coordinator asks the person, and passes the answers back */
export const QUESTION_WAKE_HEAD = 'Question from a session attached to you, through ClaudeTerm: its task waits for the person\'s answer.'
/** the first line of an answer's block: the coordinator's answer to the question of this session */
export const ANSWER_WAKE_HEAD = 'Answer from your coordinator, through ClaudeTerm: the person answered your question.'
/** the first line of a block that types the person's answers into a session: the coordinator's question form checked them */
export const PERSON_ANSWERS_HEAD = 'The person\'s answers, through your coordinator'
/** the line after the head: ClaudeTerm checked the answers in the coordinator's question form */
export const PERSON_ANSWERS_CHECKED = '(ClaudeTerm checked them in the coordinator\'s question form):'
/** the line that says whose answers are whose: the person's lines, which answer the session's own questions */
export const PERSON_ANSWERS_NOTE = 'Only the lines under "The person answered" are the person\'s. They answer the questions you asked with AskUserQuestion: go on with your task.'
/** the line before the session's question an answer is for */
export const PERSON_ANSWERS_QUESTION = 'Your question:'
/** the line before the question as the coordinator asked it */
export const PERSON_ANSWERS_ASKED = 'The coordinator asked the person:'
/** the quoted body of an answer's block: the person's answers are in the text typed for the session */
export const ANSWERS_ABOVE = 'The person\'s answers are above.'
/** the first lines of the kinds of wake blocks ClaudeTerm writes */
export const WAKE_HEADS: readonly string[] = [MESSAGE_WAKE_HEAD, TASK_WAKE_HEAD, REPORT_WAKE_HEAD, PROGRESS_WAKE_HEAD, ROLE_NOTE_HEAD, PERSON_WORDS_HEAD, QUESTION_WAKE_HEAD, ANSWER_WAKE_HEAD, PERSON_ANSWERS_HEAD]

/** a report block as the chat reads it: the mail it came in, the session that sent it (its name and ref), and how its task ended */
export interface ReportWake {
  mailId: string
  name: string
  ref: string
  outcome: ReportOutcome
  reason: string | null
  text: string
}

interface Block {
  head: string
  from: string
  id: string
  quoted: string[]
  // the block's own lines in the text, from its head to its last quoted line
  raw: string
}

/** the outcome of a report's head line, after REPORT_WAKE_HEAD: " its task finished." and so on */
const REPORT_HEAD = /^ its task (finished|failed|was stopped by the user)(?:: (.+))?\.$/
/** the id line of a report: the mail id, the task it reports on, and the ref of the session it names */
const REPORT_ID = /^id: (\S+)  \(the report on task \S+; read_session "([^"]*)" shows the session\)$/

/**
 * A wake text's report blocks, its role notes (each as its text, quoted lines unquoted), and its other blocks as the rest (joined
 * by a blank line). A text that is not wholly wake blocks has no reports or notes, and its rest is the text itself: a line out of
 * the shape of a block anywhere makes the whole text no wake.
 */
export function splitWake(text: string): { reports: ReportWake[]; notes: string[]; rest: string } {
  const blocks = blocksOf(text)
  if (blocks === null) return { reports: [], notes: [], rest: text }
  const reports: ReportWake[] = []
  const notes: string[] = []
  const rest: string[] = []
  for (const b of blocks) {
    if (b.head.startsWith(ROLE_NOTE_HEAD)) {
      notes.push(b.quoted.join('\n'))
      continue
    }
    if (!b.head.startsWith(REPORT_WAKE_HEAD)) {
      rest.push(b.raw)
      continue
    }
    const report = reportOf(b)
    // a report block that does not read as one is no wake at all
    if (report === null) return { reports: [], notes: [], rest: text }
    reports.push(report)
  }
  return { reports, notes, rest: rest.join('\n\n') }
}

/** the blocks of a text, or null when a line is out of their shape */
function blocksOf(text: string): Block[] | null {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0
  for (;;) {
    const head = lines[i]
    const from = lines[i + 1]
    const id = lines[i + 2]
    if (head === undefined || !WAKE_HEADS.some(h => head.startsWith(h))) return null
    if (from === undefined || !from.startsWith('from: ') || id === undefined || !id.startsWith('id: ') || lines[i + 3] !== '') return null
    const quoted: string[] = []
    let j = i + 4
    while (j < lines.length && lines[j] !== '') {
      const line = lines[j]
      if (line === '>') quoted.push('')
      else if (line.startsWith('> ')) quoted.push(line.slice(2))
      else return null
      j++
    }
    if (quoted.length === 0) return null
    blocks.push({ head, from, id, quoted, raw: lines.slice(i, j).join('\n') })
    if (j === lines.length) return blocks
    // the blank line between two blocks: a text that ends on it, or has two, is no wake
    i = j + 1
    if (i >= lines.length) return null
  }
}

/** a report block read: its head's outcome and reason, its from and id lines, and its quoted text; null when any of them is out of shape */
function reportOf(b: Block): ReportWake | null {
  // the head is read first: a block whose head is no report's does no more work on its other lines
  const head = REPORT_HEAD.exec(b.head.slice(REPORT_WAKE_HEAD.length))
  if (head === null) return null
  const outcome: ReportOutcome = head[1] === 'finished' ? 'finished' : head[1] === 'failed' ? 'failed' : 'stopped'
  // only a failed or a stopped report has a reason
  if (outcome === 'finished' && head[2] !== undefined) return null
  const id = REPORT_ID.exec(b.id)
  if (id === null) return null
  const ref = id[2]!
  return {
    mailId: id[1]!,
    name: nameOf(b.from, ref),
    ref,
    outcome,
    reason: head[2] ?? null,
    text: b.quoted.join('\n')
  }
}

/**
 * The name of a from line (`from: <name> [<ref>]`, then the folder and branch in brackets when known): the text up to the ref in
 * brackets, else up to the first parenthesis, else the rest. Plain string searches, so no line can make this slow.
 */
function nameOf(from: string, ref: string): string {
  const body = from.slice('from: '.length)
  const byRef = body.indexOf(` [${ref}]`)
  if (byRef >= 0) return body.slice(0, byRef)
  const paren = body.indexOf(' (')
  return paren >= 0 ? body.slice(0, paren) : body
}

/** the parts of a text typed for a task with the person's words: the coordinator, its answer when the words reply to one, the words, and the task */
export interface PersonWordsWake {
  coordinator: string
  context: string | null
  words: string
  task: string
}

/**
 * The reading of the text typed for a task with the person's words, unquoted line by line; null when a line is out of that shape
 * anywhere, the task's block included. Only the lines under PERSON_WORDS_ANSWER are the person's, and the head names the coordinator.
 */
export function splitPersonWords(text: string): PersonWordsWake | null {
  const lines = text.split('\n')
  const headStart = `${PERSON_WORDS_HEAD} `
  const headEnd = ` ${PERSON_WORDS_CHECKED}`
  const head = lines[0] ?? ''
  if (head.length <= headStart.length + headEnd.length || !head.startsWith(headStart) || !head.endsWith(headEnd)) return null
  const coordinator = head.slice(headStart.length, head.length - headEnd.length)
  if (lines[1] !== PERSON_WORDS_NOTE) return null
  let i = 2
  let context: string | null = null
  if (lines[i] === PERSON_WORDS_CONTEXT) {
    const run = quotedRun(lines, i + 1)
    if (run === null || lines[run.next] !== PERSON_WORDS_ANSWER) return null
    context = run.text
    i = run.next
  }
  if (lines[i] !== PERSON_WORDS_ANSWER) return null
  const words = quotedRun(lines, i + 1)
  if (words === null || lines[words.next] !== '') return null
  const blocks = blocksOf(lines.slice(words.next + 1).join('\n'))
  if (blocks === null || blocks.length !== 1 || !blocks[0]!.head.startsWith(TASK_WAKE_HEAD)) return null
  return { coordinator, context, words: words.text, task: blocks[0]!.quoted.join('\n') }
}

/** the quoted lines from line `from` on, unquoted and joined, with the index of the first line after them; null when none is quoted */
function quotedRun(lines: string[], from: number): { text: string; next: number } | null {
  const out: string[] = []
  let j = from
  for (; j < lines.length; j++) {
    const line = lines[j]!
    if (line === '>') out.push('')
    else if (line.startsWith('> ')) out.push(line.slice(2))
    else break
  }
  return out.length === 0 ? null : { text: out.join('\n'), next: j }
}

/** how a task ended, as a card says it: 'finished', 'failed: <reason>' ('failed' without one), 'stopped' */
export function outcomeText(outcome: ReportOutcome, reason: string | null): string {
  if (outcome === 'finished') return 'finished'
  if (outcome === 'failed') return reason === null ? 'failed' : `failed: ${reason}`
  return 'stopped'
}
