// The heads of the wake texts ClaudeTerm writes for an agent, and the reading of a report's block back out of one.
// Main writes the wake texts (src/main/mail/wake-text.ts); the chat reads them to draw a report as a card.

import type { ReportOutcome } from './mail'

/** the first line of a message's block */
export const MESSAGE_WAKE_HEAD = 'Message from another agent, not from the user, through ClaudeTerm:'
/** the first line of a task's block */
export const TASK_WAKE_HEAD = 'Task from your coordinator, through ClaudeTerm:'
/** the first line of a report's block; its outcome follows it */
export const REPORT_WAKE_HEAD = 'Report from a session attached to you, through ClaudeTerm:'
/** the first lines of the three kinds of wake blocks ClaudeTerm writes */
export const WAKE_HEADS: readonly string[] = [MESSAGE_WAKE_HEAD, TASK_WAKE_HEAD, REPORT_WAKE_HEAD]

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
/** the from line: the name, then the ref in brackets, then the folder and branch in brackets when known */
const FROM = /^from: (.*) \[([^[\]]+)\](?: \(.*\))?$/
/** the id line of a report: the mail id, then the task it reports on and the session it names */
const REPORT_ID = /^id: (\S+)  \(the report on task \S+; read_session "[^"]*" shows the session\)$/

/**
 * A wake text's report blocks, and its other blocks as the rest (joined by a blank line). A text that is not wholly wake blocks
 * has no reports, and its rest is the text itself: a line out of the shape of a block anywhere makes the whole text no wake.
 */
export function splitWake(text: string): { reports: ReportWake[]; rest: string } {
  const blocks = blocksOf(text)
  if (blocks === null) return { reports: [], rest: text }
  const reports: ReportWake[] = []
  const rest: string[] = []
  for (const b of blocks) {
    if (!b.head.startsWith(REPORT_WAKE_HEAD)) {
      rest.push(b.raw)
      continue
    }
    const report = reportOf(b)
    // a report block that does not read as one is no wake at all
    if (report === null) return { reports: [], rest: text }
    reports.push(report)
  }
  return { reports, rest: rest.join('\n\n') }
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
  const head = REPORT_HEAD.exec(b.head.slice(REPORT_WAKE_HEAD.length))
  const from = FROM.exec(b.from)
  const id = REPORT_ID.exec(b.id)
  if (head === null || from === null || id === null) return null
  const outcome: ReportOutcome = head[1] === 'finished' ? 'finished' : head[1] === 'failed' ? 'failed' : 'stopped'
  // only a failed or a stopped report has a reason
  if (outcome === 'finished' && head[2] !== undefined) return null
  return {
    mailId: id[1]!,
    name: from[1]!,
    ref: from[2]!,
    outcome,
    reason: head[2] ?? null,
    text: b.quoted.join('\n')
  }
}

/** how a task ended, as a card says it: 'finished', 'failed: <reason>' ('failed' without one), 'stopped' */
export function outcomeText(outcome: ReportOutcome, reason: string | null): string {
  if (outcome === 'finished') return 'finished'
  if (outcome === 'failed') return reason === null ? 'failed' : `failed: ${reason}`
  return 'stopped'
}
