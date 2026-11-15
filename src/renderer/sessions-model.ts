import { COORD_REFUSED, isWorktreeName, type CoordGroup, type CoordinatorView, type CoordMarks, type CoordResult, type CoordSessionRow, type CoordStartRequest } from '../shared/coordinator'
import { clockOf } from './util'

export type SectionKey = CoordGroup | 'not-attached'

export const SECTION_LABELS: Record<SectionKey, string> = {
  waiting: 'Waiting on you', working: 'Working', idle: 'Idle', resolved: 'Resolved', 'not-attached': 'Not attached'
}

/** the sections folded when the panel is first shown */
export const DEFAULT_FOLDED: readonly SectionKey[] = ['resolved']

export interface SessionSection { key: SectionKey; label: string; rows: CoordSessionRow[]; folded: boolean }

const ATTACHED_ORDER: CoordGroup[] = ['waiting', 'working', 'idle', 'resolved']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MINUTE_MS = 60_000

/** the attached rows by group in the order waiting, working, idle, resolved (each in the view's order), then the project's others; a section with no row is left out */
export function sessionSections(view: CoordinatorView, folded: ReadonlySet<SectionKey>): SessionSection[] {
  const keys: SectionKey[] = [...ATTACHED_ORDER, 'not-attached']
  const rowsOf = (key: SectionKey): CoordSessionRow[] => (key === 'not-attached' ? view.notAttached : view.sessions.filter((r) => r.group === key))
  return keys
    .map((key) => ({ key, label: SECTION_LABELS[key], rows: rowsOf(key), folded: folded.has(key) }))
    .filter((s) => s.rows.length > 0)
}

export type RowIcon = 'amber' | 'red' | 'spin' | 'check' | 'grey'

/** not-attached or marker 'offline' → grey; marker 'starting' | 'attaching' → spin; waiting → amber for why 'prompt', else red; working → spin; idle, resolved → check */
export function rowIcon(row: CoordSessionRow, section: SectionKey): RowIcon {
  if (section === 'not-attached' || row.marker === 'offline') return 'grey'
  if (row.marker === 'starting' || row.marker === 'attaching') return 'spin'
  if (section === 'waiting') return row.why === 'prompt' ? 'amber' : 'red'
  if (section === 'working') return 'spin'
  return 'check'
}

export type RowAction = 'open' | 'message' | 'detach' | 'attach' | 'resolve'

export const ACTION_LABELS: Record<RowAction, string> = { open: 'Open', message: 'Message', detach: 'Detach', attach: 'Attach', resolve: 'Resolve' }

/** the project's others: attach (with a tab); a row that starts: open (with a tab) and detach, which cancels the start; an attached row: open (with a tab), message, detach, and resolve in Idle or after a failure */
export function rowActions(row: CoordSessionRow, section: SectionKey): RowAction[] {
  const open: RowAction[] = row.tabId === null ? [] : ['open']
  if (section === 'not-attached') return row.tabId === null ? [] : ['attach']
  if (row.marker === 'starting') return [...open, 'detach']
  const resolve: RowAction[] = section === 'idle' || (section === 'waiting' && row.why === 'failed') ? ['resolve'] : []
  return [...open, 'message', 'detach', ...resolve]
}

/** when a row last changed: "now" within a minute (a time ahead of now too), "HH:MM" earlier the same local day, else "Mon D" (e.g. "Nov 13") */
export function rowTime(changedAt: number, now: number): string {
  if (Math.abs(now - changedAt) < MINUTE_MS) return 'now'
  const changed = new Date(changedAt)
  if (changed.toDateString() === new Date(now).toDateString()) return clockOf(changedAt)
  return `${MONTHS[changed.getMonth()]} ${changed.getDate()}`
}

/**
 * When the panel must draw again so that a row showing "now" turns into a clock time: a minute after the change of the
 * first such row to stop showing "now" (the rows are the attached ones); null when no row shows "now".
 */
export function nextRedrawAt(rows: CoordSessionRow[], now: number): number | null {
  let next: number | null = null
  for (const r of rows) {
    if (Math.abs(now - r.changedAt) >= MINUTE_MS) continue
    const at = r.changedAt + MINUTE_MS
    if (next === null || at < next) next = at
  }
  return next
}

export const FOLDER_ERROR = 'The folder must be a full path.'
export const WORKTREE_ERROR = 'A worktree name is letters, digits, ".", "_" and "-", starts with a letter or digit, and is at most 64 long.'
export const NAME_ERROR = 'A name is one line of plain text.'

/** the New session dialog's fields, as typed */
export interface StartForm { task: string; name: string; folder: string; worktree: string }

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
// a full path of either system: from the root (/x, \x) or from a drive (C:\x, C:/x)
const FULL_PATH = /^(?:\/|\\|[A-Za-z]:[\\/])/

/** the fields trimmed, an empty optional field null; a blank task: 'A task needs a text.'; a name with a control character: NAME_ERROR; a folder that is not a full path of either system: FOLDER_ERROR; a worktree isWorktreeName refuses: WORKTREE_ERROR */
export function checkStartForm(f: StartForm): { req: CoordStartRequest } | { error: string } {
  const task = f.task.trim()
  const name = f.name.trim()
  const folder = f.folder.trim()
  const worktree = f.worktree.trim()
  if (task === '') return { error: 'A task needs a text.' }
  if (CONTROL_CHARACTER.test(name)) return { error: NAME_ERROR }
  if (folder !== '' && !FULL_PATH.test(folder)) return { error: FOLDER_ERROR }
  if (worktree !== '' && !isWorktreeName(worktree)) return { error: WORKTREE_ERROR }
  return { req: { task, name: name === '' ? null : name, folder: folder === '' ? null : folder, worktree: worktree === '' ? null : worktree } }
}

/** the text a start main refused shows: null for a start that was made; the refusal of the fields in words of the dialog; any other error as main said it */
export function startError(r: CoordResult): string | null {
  if (r.ok) return null
  return r.error === COORD_REFUSED ? 'ClaudeTerm refused these fields.' : r.error
}

/** a tab as Attach… reads it: a local Claude tab's session, its folder and its branch */
export interface AttachTab { id: string; title: string; claude: boolean; local: boolean; session: string | null; exited: boolean; folder: string; branch: string | null }
export interface AttachChoice { tabId: string; title: string; where: string; note: string | null }

/** the tabs Attach… offers, in their order: this device's Claude tabs with a session that run, other than the coordinator, a tab attached to it, and any coordinator; where is "folder · branch"; note: `Attached to the ${project} coordinator` for a tab attached elsewhere */
export function attachChoices(tabs: AttachTab[], coordinator: string, marks: CoordMarks): AttachChoice[] {
  const choices: AttachChoice[] = []
  for (const t of tabs) {
    if (!t.claude || !t.local || t.session === null || t.exited || t.id === coordinator) continue
    const mark = marks[t.id]
    if (mark?.role === 'coordinator') continue
    if (mark?.role === 'attached' && mark.coordinatorTabId === coordinator) continue
    const where = t.branch === null ? t.folder : `${t.folder} · ${t.branch}`
    const note = mark?.role === 'attached' ? `Attached to the ${mark.project} coordinator` : null
    choices.push({ tabId: t.id, title: t.title, where, note })
  }
  return choices
}
