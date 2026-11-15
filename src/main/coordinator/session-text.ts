import type { CoordGroup, CoordSessionRow, CoordinatorView } from '../../shared/coordinator'
import { ROLE_NOTE_HEAD } from '../../shared/report-wake'
import { describeTaskList, type TaskList } from '../../shared/task-list'
import { cutText } from '../../shared/protocol'
import { replaceControls } from '../mail/agent-directory'
import { quoted } from '../mail/wake-text'
import type { TabPrompt } from '../tab-waits'
import { GROUP_LABELS } from './session-state'

const GROUPS: CoordGroup[] = ['waiting', 'working', 'idle', 'resolved']

/** the most characters of a role note: the hook's output is cut at 10,000 and the note shares it with the mail */
export const ROLE_NOTE_MAX = 1200
const NAME_MAX = 40
const LINE_MAX = 60

function rowLine(r: CoordSessionRow, clock: (ms: number) => string): string {
  let line = `- ${replaceControls(r.name)}${r.ref ? ` [${r.ref}]` : ''} · ${r.line}`
  if (r.folder) line += ` · ${replaceControls(r.folder)}`
  if (r.branch) line += ` · ${replaceControls(r.branch)}`
  if (r.task) line += ` · task ${r.task.state} since ${clock(r.task.since)}`
  if (r.lastReport) line += ` · last report ${r.lastReport.outcome} ${clock(r.lastReport.at)}`
  if (r.attachedTo) line += ` · attached to ${r.attachedTo}`
  return line
}

/** the text of list_sessions: the attached sessions by group, the project's others, and the notes that apply */
export function listText(v: CoordinatorView, clock: (ms: number) => string): string {
  const lines = [`${v.project.name} coordinator · ${v.sessions.length} attached`]
  if (v.problem) lines.push(v.problem)
  if (v.sessions.length === 0) {
    lines.push('No sessions are attached. Attach one with attach_session, or start one with start_session.')
  } else {
    for (const group of GROUPS) {
      const rows = v.sessions.filter((r) => r.group === group)
      if (rows.length === 0) continue
      lines.push(`${GROUP_LABELS[group]} (${rows.length}):`, ...rows.map((r) => rowLine(r, clock)))
    }
  }
  if (v.notAttached.length > 0) lines.push('Not attached (this project):', ...v.notAttached.map((r) => rowLine(r, clock)))

  lines.push('Notes:', '- Reports come to you by themselves when a task ends; there is no need to poll or wait.')
  const prompted = v.sessions.filter((r) => r.why === 'prompt')
  if (prompted.length > 0) {
    const names = prompted.map((r) => replaceControls(r.name)).join(', ')
    lines.push(`- A permission prompt or question waits for the user in ${names}: it is theirs to answer there; tell them once where it waits.`)
  }
  if (v.sessions.some((r) => r.why === 'limit')) lines.push('- A usage limit is not a failure: the session goes on after the reset.')
  if (v.sessions.some((r) => r.marker === 'offline')) {
    lines.push('- A session marked Offline is on a device that is not connected: a task given to it goes out when the device connects; detach_session works meanwhile.')
  }
  if (v.sessions.some((r) => r.marker === 'attaching')) lines.push('- A session marked Attaching… waits for its device to confirm it; it takes tasks once it does.')
  if (v.sessions.some((r) => r.lastReport?.outcome === 'stopped')) lines.push('- A stopped task was stopped by the user.')
  return lines.join('\n')
}

/** the text of read_session: one session in full, with its prompt, its open task, its task list and its last report */
export function readText(
  row: CoordSessionRow,
  d: { prompt: TabPrompt | null; report: string | null; taskList: TaskList | null },
  clock: (ms: number) => string
): string {
  const lines = [`${replaceControls(row.name)}${row.ref ? ` [${row.ref}]` : ''}`, `State: ${GROUP_LABELS[row.group]} · ${row.line}`]
  if (row.folder) lines.push(`Folder: ${replaceControls(row.folder)}${row.branch ? ` · Branch: ${replaceControls(row.branch)}` : ''}`)
  if (d.prompt) {
    const what = d.prompt.text || (d.prompt.kind === 'permission' ? 'a permission prompt' : 'a question')
    lines.push(`Waiting for the user: ${what}. It is the user's to answer in that session.`)
  }
  lines.push(row.task ? `Open task: ${row.task.state} since ${clock(row.task.since)} (id ${row.task.id})` : 'No open task.')
  if (d.taskList) lines.push(`Task list: ${describeTaskList(d.taskList)}`)
  if (row.lastReport) {
    const r = row.lastReport
    lines.push(`Last report: ${r.outcome}${r.reason ? `: ${r.reason}` : ''} ${clock(r.at)}`)
    lines.push(d.report ?? '(The report is no longer kept.)')
  } else {
    lines.push('No report yet.')
  }
  return lines.join('\n')
}

/**
 * The role note's text: the project, the sessions in their groups (at most `maxSessions`, the rest counted), and the problem
 * when there is one. Names and lines are cut and made one line each, so no session can add a line to the note.
 */
export function roleNoteText(v: CoordinatorView, maxSessions = 8): string {
  const head = `You coordinate ${replaceControls(v.project.name)} in ClaudeTerm:`
  let text: string
  if (v.sessions.length === 0) {
    text = `${head} no sessions are attached yet. Attach one with attach_session, or start one with start_session.`
  } else {
    const byGroup = [...v.sessions].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const shown = byGroup.slice(0, maxSessions).map((r) => `${cutText(replaceControls(r.name), NAME_MAX)} — ${cutText(replaceControls(r.line), LINE_MAX)}`)
    const rest = byGroup.length - shown.length
    if (rest > 0) shown.push(`and ${rest} more`)
    const count = byGroup.length === 1 ? '1 session' : `${byGroup.length} sessions`
    text = `${head} ${count} (${shown.join(', ')}). Reports come by themselves when a task ends; use list_sessions for more.`
  }
  if (v.problem) text += ` ${replaceControls(v.problem)}`
  // the bound counts UTF-16 units, so the cut may not leave the first half of an emoji at its end
  return text.length > ROLE_NOTE_MAX ? text.slice(0, ROLE_NOTE_MAX).replace(/[\uD800-\uDBFF]$/, '') : text
}

/** the role note as a wake block: its head, the sender ClaudeTerm, an id line that names no record, and the text quoted line by line */
export function roleBlock(text: string): string {
  return [ROLE_NOTE_HEAD, 'from: ClaudeTerm', 'id: role-note', '', quoted(text)].join('\n')
}
