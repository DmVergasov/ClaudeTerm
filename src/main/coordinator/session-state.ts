import type { CoordGroup, CoordMarker, CoordReport, CoordSessionRow, CoordTaskInfo, CoordWhy } from '../../shared/coordinator'
import { oneLineText } from '../../shared/protocol'
import type { PlanStatus } from '../../shared/types'
import type { TabLimit, TabPrompt } from '../tab-waits'

/** what a session's row is made of: the tab's and the session's facts, as the coordinator reads them */
export interface RowFacts {
  marker: CoordMarker
  closed: boolean
  exited: boolean
  working: boolean
  prompt: TabPrompt | null
  limit: TabLimit | null
  progress: PlanStatus | null
  task: CoordTaskInfo | null
  resolved: boolean
  failed: boolean
  lastReport: CoordReport | null
  /** the text of the newest progress note on the row's task; absent or null: none */
  note?: string | null
}

export const GROUP_LABELS: Record<CoordGroup, string> = { waiting: 'Waiting on you', working: 'Working', idle: 'Idle', resolved: 'Resolved' }

const REPORT_LINES: Record<CoordReport['outcome'], string> = { finished: 'Finished · report ready', stopped: 'Stopped by you', failed: 'Failed' }

/** the longest line a progress note shows on its row, in characters */
export const NOTE_LINE_MAX = 100

/** the first line with text of a progress note, one line, cut for a row */
export function noteLine(text: string): string {
  const line = text.split(/\r\n|\r|\n/).find((l) => l.trim() !== '') ?? ''
  return oneLineText(line, NOTE_LINE_MAX)
}

/** the group, the reason it waits, the line and the progress of a row, from its facts */
export function rowState(f: RowFacts, clock: (ms: number) => string): { group: CoordGroup; why: CoordWhy; line: string; progress: { done: number; total: number } | null } {
  const why: CoordWhy = f.prompt ? 'prompt' : f.limit ? 'limit' : f.failed ? 'failed' : null
  const group: CoordGroup =
    why !== null ? 'waiting' : f.marker === 'starting' || f.working || f.task !== null ? 'working' : f.resolved ? 'resolved' : 'idle'
  const progress = f.progress && !f.progress.finished ? { done: f.progress.done, total: f.progress.total } : null
  return { group, why, line: lineOf(f, clock), progress }
}

function lineOf(f: RowFacts, clock: (ms: number) => string): string {
  if (f.marker === 'starting') return 'Starting…'
  if (f.marker === 'attaching') return 'Attaching…'
  if (f.marker === 'offline') return 'Offline'
  if (f.prompt) return f.prompt.text || (f.prompt.kind === 'permission' ? 'Waiting for your permission' : 'Waiting for your answer')
  if (f.limit) return f.limit.resetsAt === null ? 'Usage limit' : `Usage limit · resets ${clock(f.limit.resetsAt)}`
  if (f.failed) return `Failed: ${f.lastReport?.reason ?? 'no reason given'}`
  if (f.closed) return 'Tab closed'
  if (f.exited) return 'Claude Code exited'
  // the session's latest word on its open task while its background work runs: the first line of its newest progress note
  if (f.note && f.task?.state === 'open' && !f.working) return `Background work · ${noteLine(f.note)}`
  if (f.progress && !f.progress.finished) {
    const counts = `${f.progress.done}/${f.progress.total}`
    const task = f.progress.tasks.find((t) => t.state === 'current') ?? f.progress.tasks.find((t) => t.state === 'left')
    return task ? `${counts} · ${task.title}` : counts
  }
  if (f.task) return f.task.state === 'queued' ? 'Task waiting until the session is idle' : 'Working on its task'
  if (f.working) return 'Working'
  if (f.lastReport) return REPORT_LINES[f.lastReport.outcome]
  return 'Idle'
}

/**
 * a row by its key, then its name (case-insensitive), then its ref; "[ref]" is taken as the ref only.
 * An ambiguous name or ref is an error that names the sessions, so the coordinator can ask for the full name.
 */
export function findRow(rows: CoordSessionRow[], target: string): { row: CoordSessionRow } | { error: string } {
  const t = target.trim()
  const bracket = /^\[(.+)\]$/.exec(t)
  if (bracket) return byRef(rows, bracket[1], t)

  const keyed = rows.filter((r) => r.key === t)
  if (keyed.length > 0) return one(keyed, t)
  const lower = t.toLowerCase()
  const named = rows.filter((r) => r.name.toLowerCase() === lower)
  if (named.length > 0) return one(named, t)
  return byRef(rows, t, t)
}

function byRef(rows: CoordSessionRow[], ref: string, target: string): { row: CoordSessionRow } | { error: string } {
  const found = rows.filter((r) => r.ref === ref)
  if (found.length === 0) return { error: `No session "${target}" here; call list_sessions.` }
  return one(found, target)
}

function one(found: CoordSessionRow[], target: string): { row: CoordSessionRow } | { error: string } {
  if (found.length === 1) return { row: found[0] }
  return { error: `"${target}" matches more than one session: ${found.map((r) => r.name).join(', ')}; use the full name.` }
}
