import type { PlatformPath } from 'node:path'
import type { PlanStatus } from '../shared/types'

export interface ParsedPlan {
  title: string | null
  tasks: { n: number; title: string }[]
}

export interface ParsedLedger {
  /** numbers of the tasks the ledger records as complete */
  complete: Set<number>
  /** the ledger has a line of the final review */
  final: boolean
}

const TASK_HEADING = /^#{2,4}\s+Task\s+(\d+)\b[^:\r\n]*:\s*(.*)$/
const FENCE = /^(```|~~~)/

/**
 * The title and the tasks of a superpowers plan file: `### Task <N>: <title>` headings (levels 2 to 4) outside
 * code fences, in file order. The title is the first `# ` heading, without a trailing " Implementation Plan".
 * Null when the file has no task headings.
 */
export function parsePlan(text: string): ParsedPlan | null {
  let title: string | null = null
  const tasks: { n: number; title: string }[] = []
  const seen = new Set<number>()
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
    if (!m) continue
    const n = Number(m[1])
    if (seen.has(n)) continue
    seen.add(n)
    tasks.push({ n, title: m[2].trim() })
  }
  return tasks.length > 0 ? { title, tasks } : null
}

/** The tasks a subagent-driven-development ledger records as complete, and whether its final review is recorded. */
export function parseLedger(text: string): ParsedLedger {
  const complete = new Set<number>()
  let final = false
  for (const line of text.split('\n')) {
    const m = /^\s*Task\s+(\d+):\s*complete\b/.exec(line)
    if (m) complete.add(Number(m[1]))
    else if (/^\s*Final\b/.test(line)) final = true
  }
  return { complete, final }
}

/**
 * Where the plan stands: the task after the furthest complete one is current and every task before it is done
 * (a task the ledger skips counts as done). Finished when the last task is complete or the final review is recorded.
 */
export function planStatus(plan: ParsedPlan, ledger: ParsedLedger, fallbackTitle: string): PlanStatus {
  const total = plan.tasks.length
  let furthest = -1
  plan.tasks.forEach((t, i) => {
    if (ledger.complete.has(t.n)) furthest = i
  })
  const finished = ledger.final || furthest === total - 1
  const tasks = plan.tasks.map((t, i) => ({
    n: t.n,
    title: t.title,
    state: finished || i <= furthest ? ('done' as const) : i === furthest + 1 ? ('current' as const) : ('left' as const)
  }))
  return { title: plan.title ?? fallbackTitle, tasks, done: finished ? total : furthest + 1, total, finished }
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
