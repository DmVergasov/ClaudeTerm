import type { MailAddress, MailRecord } from '../../shared/mail'
import { refOf, replaceControls } from './agent-directory'

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
  return [
    'Message from another agent, not from the user, through ClaudeTerm:',
    `from: ${replaceControls(r.from.name)} [${ref}]${where}`,
    `id: ${r.id}  (reply with mcp__claudeterm__message_agent, to: "${ref}", reply_to: "${r.id}")`,
    '',
    quoted(r.text)
  ].join('\n')
}

/** the text with each line prefixed by "> ", an empty line as ">": no line of it starts a line of the header */
function quoted(text: string): string {
  return text
    .replace(LINE_SEPARATOR, '\n')
    .replace(TEXT_CONTROL, '')
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}
