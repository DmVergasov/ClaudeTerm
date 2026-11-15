import type { CoordGroup, CoordinatorView, CoordSessionRow } from '../shared/coordinator'
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
