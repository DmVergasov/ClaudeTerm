import { MAX_NOTE_LENGTH, type NoteSide } from '../shared/note'
import { type NoteItem, type NoteOp, noteItems, type OpResult } from '../shared/note-items'
import type { NoteAddMessage, NoteCheckMessage, NoteReadMessage, PipeResponse } from '../shared/protocol'
import type { NoteHub } from './note-hub'
import type { ProjectNoteHub } from './project-note-hub'

export interface NoteReplyDeps {
  isClaudeTab(tabId: string): boolean
  session: Pick<NoteHub, 'get' | 'apply'>
  project: Pick<ProjectNoteHub, 'projectOf' | 'get' | 'apply'>
}

interface Project {
  key: string
  name: string
}

/** why a tab has no project note: its folder is outside git, or ClaudeTerm has not found its project yet */
type Gap = 'outside' | 'unknown'

/** the most items a reply lists */
const ITEMS_LISTED = 50

const refused = (tool: string): PipeResponse => ({ ok: false, error: `${tool} works only in a ClaudeTerm Claude tab` })

/** the tab's project; a remote tab's place is not known here, so it counts as not found yet */
function projectOf(deps: NoteReplyDeps, tabId: string): Project | Gap {
  const project = deps.project.projectOf(tabId)
  if (project.key !== null) return project
  return project.why === 'outside' ? 'outside' : 'unknown'
}

function gapText(gap: Gap, outcome: string): string {
  if (gap === 'outside') return `This tab has no project note: its folder is not in a git repository. ${outcome}`
  return `ClaudeTerm has not found this tab's project yet; try again in a moment. ${outcome}`
}

const textOrEmpty = (text: string | undefined): string => (text && text.trim() !== '' ? text : '(empty)')

/** the note as the replies name it: "session note", or "project note (<name>)" */
const sessionName = 'session note'
const projectName = (project: Project): string => `project note (${project.name})`

/** the items as the replies list them: one line each, at most ITEMS_LISTED */
function itemLines(items: NoteItem[]): string {
  const lines = items.slice(0, ITEMS_LISTED).map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`)
  if (items.length > ITEMS_LISTED) lines.push(`… and ${items.length - ITEMS_LISTED} more`)
  return lines.join('\n')
}

export function readNotesReply(deps: NoteReplyDeps, msg: NoteReadMessage): PipeResponse {
  if (!deps.isClaudeTab(msg.tabId)) return refused('read_notes')
  const session = `## Session note\n${textOrEmpty(deps.session.get(msg.tabId)?.text)}`
  const project = projectOf(deps, msg.tabId)
  let projectPart: string
  if (project === 'outside') projectPart = "## Project note\n(none: this tab's folder is not in a git repository)"
  else if (project === 'unknown') projectPart = "## Project note\n(none yet: ClaudeTerm has not found this tab's project; try again in a moment)"
  else projectPart = `## Project note (${project.name})\n${textOrEmpty(deps.project.get(project.key)?.text)}`
  return { ok: true, info: `${session}\n\n${projectPart}` }
}

export function addToNoteReply(deps: NoteReplyDeps, msg: NoteAddMessage): PipeResponse {
  if (!deps.isClaudeTab(msg.tabId)) return refused('add_to_note')
  const op: NoteOp = { kind: 'append', text: msg.text }
  const target = targetOf(deps, msg.tabId, msg.note, 'Nothing was added.')
  if ('error' in target) return target.error
  const result = apply(deps, msg.tabId, msg.note, op)
  if (!result) return refused('add_to_note')
  if (result.ok) return { ok: true, info: `Added to the ${target.name}.` }
  if (result.reason === 'empty') return { ok: false, error: 'The text is empty. Nothing was added.' }
  if (result.reason === 'too-long') {
    return {
      ok: false,
      error: `The text would make the ${target.name} longer than ${MAX_NOTE_LENGTH} characters (it has ${target.text.length}, the text adds ${result.adds}). Nothing was added.`
    }
  }
  return { ok: false, error: 'Nothing was added.' }
}

export function checkNoteItemReply(deps: NoteReplyDeps, msg: NoteCheckMessage): PipeResponse {
  if (!deps.isClaudeTab(msg.tabId)) return refused('check_note_item')
  const op: NoteOp = { kind: 'check', item: msg.item, checked: msg.checked }
  const target = targetOf(deps, msg.tabId, msg.note, 'Nothing was changed.')
  if ('error' in target) return target.error
  const item = msg.item.trim()
  const items = noteItems(target.text)
  const result = apply(deps, msg.tabId, msg.note, op)
  if (!result) return refused('check_note_item')
  if (result.ok) {
    if (!result.changed) return { ok: true, info: `"${item}" is already ${msg.checked ? 'ticked' : 'unticked'} in the ${target.name}.` }
    return { ok: true, info: `${msg.checked ? 'Ticked' : 'Unticked'} "${item}" in the ${target.name}.` }
  }
  if (result.reason === 'ambiguous') {
    return { ok: false, error: `${result.matches} items in the ${target.name} read "${item}"; nothing was changed. Its items:\n${itemLines(items)}` }
  }
  if (items.length === 0) return { ok: false, error: `The ${target.name} has no checkbox items.` }
  return { ok: false, error: `No item "${item}" in the ${target.name}. Its items:\n${itemLines(items)}` }
}

/** the note an edit goes to, with its name and its text before the edit; `error` when the tab has no such project */
function targetOf(deps: NoteReplyDeps, tabId: string, note: NoteSide, outcome: string): { name: string; text: string } | { error: PipeResponse } {
  if (note === 'session') return { name: sessionName, text: deps.session.get(tabId)?.text ?? '' }
  const project = projectOf(deps, tabId)
  if (typeof project === 'string') return { error: { ok: false, error: gapText(project, outcome) } }
  return { name: projectName(project), text: deps.project.get(project.key)?.text ?? '' }
}

/** the edit applied to the note: null when the tab has no such note (a remote tab) */
function apply(deps: NoteReplyDeps, tabId: string, note: NoteSide, op: NoteOp): OpResult | null {
  return note === 'session' ? deps.session.apply(tabId, op) : deps.project.apply(tabId, op)
}
