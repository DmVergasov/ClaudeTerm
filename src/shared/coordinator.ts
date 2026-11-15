import { MAIL_MIN_CLAUDE, type ReportOutcome } from './mail'

/** the longest task text a coordinator sends, in characters */
export const COORD_TASK_MAX = 7000
/** the longest name of a session or a worktree a coordinator sends, in characters */
export const COORD_NAME_MAX = 100
/** the longest key of a coordinator's project, in characters */
export const COORD_KEY_MAX = 200
/** the answer to a call whose request does not pass main's check; the window words it for the fields it sent */
export const COORD_REFUSED = 'Invalid request'
/** the line that tells a coordinator's Claude to give the work to its sessions: in the role note, and in the list_sessions text and description */
export const COORD_DELEGATE = 'give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to.'

/** where a task given to a session is: queued, delivered as a prompt and not yet started, or open in a turn */
export type TaskState = 'queued' | 'delivered' | 'open'
/** the group a row is shown in */
export type CoordGroup = 'waiting' | 'working' | 'idle' | 'resolved'
/** shown on a row: starting while its tab opens, attaching until its device confirms, offline while its device is not connected */
export type CoordMarker = 'starting' | 'offline' | 'attaching' | null
/** why a row waits for the person */
export type CoordWhy = 'prompt' | 'limit' | 'failed' | null

export interface CoordReport {
  id: string
  outcome: ReportOutcome
  reason: string | null
  at: number
}

export interface CoordTaskInfo {
  id: string
  state: TaskState
  since: number
}

export interface CoordSessionRow {
  key: string // 'local:<session>'; '<device>:<session>' for a session of another device; 'start:<tabId>' while Starting…
  tabId: string | null // the tab that runs it; null when none does
  device: string | null // null: this device
  deviceName: string | null // null: this device
  session: string | null // null while Starting…
  ref: string | null
  name: string
  folder: string | null
  branch: string | null
  group: CoordGroup
  why: CoordWhy
  marker: CoordMarker
  line: string
  progress: { done: number; total: number } | null
  changedAt: number
  task: CoordTaskInfo | null
  lastReport: CoordReport | null
  attachedTo: string | null // a Not attached row: the coordinator it is attached to elsewhere
}

export interface CoordinatorView {
  tabId: string
  session: string
  project: { key: string; name: string }
  problem: string | null
  sessions: CoordSessionRow[]
  notAttached: CoordSessionRow[]
  waiting: number // attached rows in 'waiting': the header's badge
}

export type CoordMark =
  | { role: 'coordinator'; project: string; sessions: number; waiting: number }
  | { role: 'attached'; project: string; coordinator: string; coordinatorTabId: string | null }

export type CoordMarks = Record<string, CoordMark>

export type CoordResult = { ok: true; info?: string } | { ok: false; error: string; replaces?: string }

export interface CoordStartRequest {
  task: string
  name: string | null
  folder: string | null
  device: string | null // null: this device; else a paired device's name
  worktree: string | null
}

export type CoordOp =
  | { op: 'list' }
  | { op: 'start'; task: string; name: string | null; folder: string | null; device: string | null; worktree: string | null }
  | { op: 'attach' | 'detach' | 'read' | 'resolve'; session: string }
  | { op: 'message'; session: string; text: string }

const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** a git worktree name a coordinator may ask for: a plain name, never a path */
export function isWorktreeName(v: unknown): v is string {
  return typeof v === 'string' && WORKTREE_NAME.test(v)
}

/** why this device cannot coordinate now; null when it can. wakes: Claude Code is MAIL_MIN_CLAUDE or later */
export function coordinatorProblem(mailOn: boolean, wakes: boolean, claude: string | null): string | null {
  if (!mailOn) {
    return 'Coordinating sessions needs agent messages, which are turned off in ClaudeTerm on this device. Turn them on in Settings, Agent messages.'
  }
  if (!wakes) {
    return `Coordinating sessions needs Claude Code ${MAIL_MIN_CLAUDE} or later; this device runs ${claude ?? 'a version ClaudeTerm has not read yet'}.`
  }
  return null
}
