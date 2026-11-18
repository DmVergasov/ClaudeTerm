import type { PlatformPath } from 'node:path'
import type { PlanStatus } from '../shared/types'

export interface ParsedPlan {
  title: string | null
  /** `id` as the heading spells it: `3`, `9a`, `2.1`, `A1` */
  tasks: { id: string; title: string }[]
}

/** a task a ledger names: how the ledger closes it, and the lines that name and close it */
export interface LedgerTask {
  /** as the ledger first spells it */
  id: string
  /** `complete`, `dropped` (skipped, declined, cancelled…), or null while the task is open */
  closed: 'complete' | 'dropped' | null
  /** the index of the last line that names the task */
  named: number
  /** the index of the line that closes it; -1 while it is open */
  closedAt: number
}

export interface ParsedLedger {
  /** the tasks the ledger names, by id in lower case */
  tasks: Map<string, LedgerTask>
  /** the ledger has a line of the final review */
  final: boolean
}

// a task id as the superpowers scripts take it: letters and digits, optionally dot-separated, with at least one digit
// (3, 9a, 2.1, A1); a longer one is no id a plan uses
const ID = '[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*'
const MAX_ID = 24
const isId = (id: string): boolean => id.length <= MAX_ID && /\d/.test(id)
const TASK_HEADING = new RegExp(`^(#{2,4})\\s+Task\\s+(${ID})(?![A-Za-z0-9])[^:\\r\\n]*:\\s*(.*)$`)
const FENCE = /^(```|~~~)/
// ledgers are Markdown: a line may start as a list item, a heading or in bold (`- **Task 2: complete**`)
const TASK_LINE = new RegExp(`^[\\s#>*+-]*Task\\s+(${ID}):`, 'i')
// a controller may also end a longer line with it as a sentence of its own (`… verified by controller. Task 1: complete`).
// A dropped task is a word of its own after the colon (`Task 14: skipped, see the ruling above.`), not the start of a
// sentence (`Task 4: skipped 2 flaky tests`)
const DROPPED = 'dropped|skipped|declined|cancell?ed|abandoned|not needed|superseded|obsolete'
const TASK_CLOSED = new RegExp(`(?:^[\\s#>*+-]*|[.;]\\s+\\**)Task\\s+(${ID}):[\\s*]*(?:(complete)\\b|(?:${DROPPED})(?=[\\s*]*(?:$|[.,;:(—–-])))`, 'gi')
/** more parts than this for one task is no split a run makes: the task is shown whole */
const MAX_PARTS = 50

/** `id` names a part of task `of`: it goes on from it with a letter or a dot (9a, 9.1 of 9; not 12 of 1) */
const partOf = (id: string, of: string): boolean => id.length > of.length && id.startsWith(of) && /[a-z.]/.test(id[of.length])

/**
 * The title and the tasks of a superpowers plan file: `### Task <id>: <title>` headings (levels 2 to 4) outside
 * code fences, in file order. A deeper heading whose id goes on from the task's (`#### Task 7a` under `### Task 7`)
 * is a part of that task, as the skills' task-brief takes it. The title is the first `# ` heading, without a
 * trailing " Implementation Plan". Null when the file has no task headings.
 */
export function parsePlan(text: string): ParsedPlan | null {
  let title: string | null = null
  const tasks: { id: string; title: string }[] = []
  const seen = new Set<string>()
  let task: { key: string; level: number } | null = null
  let fenced = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (title === null && line.startsWith('# ')) {
      title = line.slice(2).replace(/\s+Implementation Plan\s*$/, '').trim()
      continue
    }
    const m = TASK_HEADING.exec(line)
    if (!m || !isId(m[2])) continue
    const key = m[2].toLowerCase()
    const level = m[1].length
    if (task && level > task.level && partOf(key, task.key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    task = { key, level }
    tasks.push({ id: m[2], title: m[3].trim() })
  }
  return tasks.length > 0 ? { title, tasks } : null
}

/**
 * The tasks a subagent-driven-development ledger names, and whether its final review is recorded. A task is closed
 * by a `Task <id>: complete` line, or dropped by one such as `Task <id>: skipped`; complete wins over dropped.
 */
export function parseLedger(text: string): ParsedLedger {
  const tasks = new Map<string, LedgerTask>()
  let final = false
  const name = (id: string, at: number): LedgerTask | null => {
    if (!isId(id)) return null
    const key = id.toLowerCase()
    let t = tasks.get(key)
    if (!t) {
      t = { id, closed: null, named: at, closedAt: -1 }
      tasks.set(key, t)
    }
    t.named = at
    return t
  }
  text.split('\n').forEach((line, at) => {
    const m = TASK_LINE.exec(line)
    if (m) name(m[1], at)
    for (const c of line.matchAll(TASK_CLOSED)) {
      const t = name(c[1], at)
      if (!t || t.closed === 'complete') continue
      if (c[2] || t.closed === null) {
        t.closed = c[2] ? 'complete' : 'dropped'
        t.closedAt = at
      }
    }
    if (/^[\s#>*+-]*Final\b/.test(line)) final = true
  })
  return { tasks, final }
}

/**
 * Where the plan stands, each task by its own ledger lines, whatever order the run takes: a task is done when the
 * ledger records it complete or dropped, and open until then. A task the run splits as it goes (`Task 9a:`,
 * `Task 9b:` for the plan's Task 9) is shown as the parts the ledger names, unless the ledger closes it whole.
 * The current task is the open one the ledger named last, when no task was closed after that; else the first open
 * task after the one closed last, or the first open task. Finished when every task is closed or the final review is
 * recorded.
 */
export function planStatus(plan: ParsedPlan, ledger: ParsedLedger, fallbackTitle: string): PlanStatus {
  const ids = new Set(plan.tasks.map((t) => t.id.toLowerCase()))
  const parts = new Map<string, LedgerTask[]>()
  for (const [key, t] of ledger.tasks) {
    if (ids.has(key)) continue
    // the longest plan id the ledger's id goes on from
    for (let i = key.length - 1; i > 0; i--) {
      const of = key.slice(0, i)
      if (ids.has(of) && partOf(key, of)) {
        parts.set(of, [...(parts.get(of) ?? []), t])
        break
      }
    }
  }
  const rows: { title: string; task: LedgerTask | null }[] = []
  for (const t of plan.tasks) {
    const own = ledger.tasks.get(t.id.toLowerCase()) ?? null
    const split = parts.get(t.id.toLowerCase())
    if (!own?.closed && split && split.length <= MAX_PARTS) {
      split.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true, sensitivity: 'base' }))
      for (const p of split) rows.push({ title: t.title ? `${p.id} · ${t.title}` : `Task ${p.id}`, task: p })
    } else rows.push({ title: t.title || `Task ${t.id}`, task: own })
  }
  const closed = (i: number): boolean => rows[i].task?.closed != null
  let lastClosed = -1
  let lastRow = -1
  rows.forEach((r, i) => {
    if (r.task && closed(i) && r.task.closedAt > lastClosed) {
      lastClosed = r.task.closedAt
      lastRow = i
    }
  })
  let current = -1
  let named = lastClosed
  rows.forEach((r, i) => {
    if (r.task && !closed(i) && r.task.named > named) {
      named = r.task.named
      current = i
    }
  })
  if (current < 0) current = rows.findIndex((_, i) => i > lastRow && !closed(i))
  if (current < 0) current = rows.findIndex((_, i) => !closed(i))
  const total = rows.length
  const done = rows.filter((_, i) => closed(i)).length
  const finished = ledger.final || done === total
  const tasks = rows.map((r, i) => ({
    n: i + 1,
    title: r.task?.closed === 'dropped' ? `${r.title} (dropped)` : r.title,
    state: finished || closed(i) ? ('done' as const) : i === current ? ('current' as const) : ('left' as const)
  }))
  return { title: plan.title ?? fallbackTitle, tasks, done: finished ? total : done, total, finished }
}

/** The same plan with every task done (the work is over, whatever the ledger says). */
export function asFinished(s: PlanStatus): PlanStatus {
  return { ...s, tasks: s.tasks.map((t) => ({ ...t, state: 'done' as const })), done: s.total, finished: true }
}

/** /d/Work/x (a Git Bash path) as D:\Work\x where the flavour is Windows; any other path is just normalized. */
export function fromGitBashPath(p: string, path: PlatformPath): string {
  if (path.sep === '\\') {
    const m = /^\/([A-Za-z])(\/|$)/.exec(p)
    if (m) return path.normalize(`${m[1].toUpperCase()}:\\${p.slice(m[0].length)}`)
  }
  return path.normalize(p)
}

/**
 * The plan file named by a ledger workspace's `plan-path` file (`<root>/.superpowers/sdd/<name>`): its first
 * non-empty line, relative to the workspace root unless absolute. Null when the file names nothing.
 */
export function planFileOf(workspace: string, planPathText: string, path: PlatformPath): string | null {
  const line = planPathText.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!line) return null
  const p = fromGitBashPath(line, path)
  if (path.isAbsolute(p)) return p
  return path.join(path.dirname(path.dirname(path.dirname(workspace))), p)
}
