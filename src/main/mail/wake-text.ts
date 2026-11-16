import { kindOf, type MailAddress, type MailRecord } from '../../shared/mail'
import { refOf, replaceControls } from './agent-directory'
import { MESSAGE_WAKE_HEAD, PERSON_WORDS_ANSWER, PERSON_WORDS_CHECKED, PERSON_WORDS_CONTEXT, PERSON_WORDS_HEAD, PERSON_WORDS_NOTE, PROGRESS_WAKE_HEAD, REPORT_WAKE_HEAD, TASK_WAKE_HEAD } from '../../shared/report-wake'

/** the blocks of a wake text are separated by a blank line */
const SEPARATOR = '\n\n'
/** every control character but tab and newline: a message text keeps its lines and its tabs, nothing else */
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
/** the line and paragraph separators are line breaks in the text: they become newlines, which are then quoted */
const LINE_SEPARATOR = /[\u2028\u2029]/g

/**
 * The text a woken agent reads: one block per message, oldest first, each block as the spec's "What the user sees" block.
 * A block names the sender, the folder and branch when known, and the id to reply with. The text of a message is quoted
 * line by line, so no line of it can read as the header of a block.
 */
export function wakeText(records: MailRecord[], senders: (a: MailAddress) => { folder: string | null; branch: string | null }): string {
  return wakeTextWithin(records, senders, Infinity).info
}

/** the wake text of the oldest records that fit in max characters, with those records; always at least one record when there are any */
export function wakeTextWithin(
  records: MailRecord[],
  senders: (a: MailAddress) => { folder: string | null; branch: string | null },
  max: number
): { taken: MailRecord[]; info: string } {
  const sorted = [...records].sort((a, b) => a.sentAt - b.sentAt)
  const blocks = sorted.map(r => block(r, senders(r.from)))
  let size = 0
  let n = 0
  for (const b of blocks) {
    const next = size + (n > 0 ? SEPARATOR.length : 0) + b.length
    if (n > 0 && next > max) break
    size = next
    n++
  }
  return { taken: sorted.slice(0, n), info: blocks.slice(0, n).join(SEPARATOR) }
}

function block(r: MailRecord, sender: { folder: string | null; branch: string | null }): string {
  const ref = refOf(r.from.session)
  const known: string[] = []
  if (sender.folder) known.push(`folder ${replaceControls(sender.folder)}`)
  if (sender.branch) known.push(`branch ${replaceControls(sender.branch)}`)
  const where = known.length > 0 ? ` (${known.join(', ')})` : ''
  const { header, id } = headerOf(r, ref)
  return [header, `from: ${replaceControls(r.from.name)} [${ref}]${where}`, id, '', quoted(r.text)].join('\n')
}

/** the first and third lines of a block: what the record is, and the id to answer with; a signal is read as a message */
function headerOf(r: MailRecord, ref: string): { header: string; id: string } {
  switch (kindOf(r)) {
    case 'task': {
      const coordinator = r.project === undefined ? 'their coordinator' : `their ${replaceControls(r.project)} coordinator`
      return {
        header: `${TASK_WAKE_HEAD} the user's instruction, given through ${coordinator}.`,
        id: `id: ${r.id}  (do it; when it is done, end your turn: ClaudeTerm sends your last answer to the coordinator as your report)`
      }
    }
    case 'report':
      return {
        header: `${REPORT_WAKE_HEAD} ${outcomeOf(r)}.`,
        id: `id: ${r.id}  (the report on task ${r.replyTo}; read_session "${ref}" shows the session)`
      }
    case 'progress':
      return {
        header: `${PROGRESS_WAKE_HEAD}.`,
        id: `id: ${r.id}  (progress on task ${r.replyTo}; its report comes when the task ends; read_session "${ref}" shows the session)`
      }
    default:
      return {
        header: MESSAGE_WAKE_HEAD,
        id: `id: ${r.id}  (reply with mcp__claudeterm__message_agent, to: "${ref}", reply_to: "${r.id}")`
      }
  }
}

/** how the task of a report ended, with its reason when it has one */
function outcomeOf(r: MailRecord): string {
  const reason = r.reason === undefined ? '' : `: ${replaceControls(r.reason)}`
  if (r.outcome === 'failed') return `its task failed${reason}`
  if (r.outcome === 'stopped') return `its task was stopped by the user${reason}`
  return 'its task finished'
}

/**
 * The text typed into a session for a task with the person's words: the person's block first, with the coordinator's answer it
 * replies to when there is one, then the task's own block. The lines of the answer and of the words are quoted, so none of them
 * can read as a head: only the lines under PERSON_WORDS_ANSWER are the person's.
 */
export function wordsText(r: MailRecord, senders: (a: MailAddress) => { folder: string | null; branch: string | null }): string {
  const lines = [`${PERSON_WORDS_HEAD} ${replaceControls(r.from.name)} ${PERSON_WORDS_CHECKED}`, PERSON_WORDS_NOTE]
  if (r.context !== undefined) lines.push(PERSON_WORDS_CONTEXT, quoted(r.context))
  lines.push(PERSON_WORDS_ANSWER, quoted(r.words ?? ''))
  return lines.join('\n') + SEPARATOR + block(r, senders(r.from))
}

/** the text with each line prefixed by "> ", an empty line as ">": no line of it starts a line of the header */
export function quoted(text: string): string {
  return text
    .replace(LINE_SEPARATOR, '\n')
    .replace(TEXT_CONTROL, '')
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}
