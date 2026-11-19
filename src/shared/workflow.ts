// A Workflow run and its agents: the shape main and the window share, and the parsers that turn the stream's rows, the
// run's journal and a Workflow result into it. Pure: no I/O

import { isAgentId } from './chat'

export const RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/
/** a run id as Claude Code writes it in the transcript dir: checked before it is a path part, a key or a name */
export const isRunId = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && RUN_ID_PATTERN.test(v)
export const MAX_RUN_AGENTS = 200
export const MAX_RUN_PHASES = 20
export const RUN_LABEL_CAP = 100
export const RUN_TASK_CAP = 200

export type RunState = 'running' | 'done' | 'failed' | 'stopped'
export type RunEnd = Exclude<RunState, 'running'>
const RUN_STATES: readonly RunState[] = ['running', 'done', 'failed', 'stopped']
const isRunState = (v: unknown): v is RunState => RUN_STATES.includes(v as RunState)

export interface WorkflowPhase { index: number; title: string }
export interface WorkflowAgentRow {
  key: string           // one per agent call: the stream's index, the journal's key
  agentId: string | null
  label: string
  phase: number | null  // index into phases
  state: 'running' | 'done' | 'failed'
  attempt: number       // 1 for a first try
  model: string | null
  effort: string | null
  task: string | null
  startedAt: number | null
  ms: number | null
}
export interface WorkflowRun {
  key: string           // never changes: the Workflow call's tool_use id in the chat, the runId in the status bar
  runId: string | null  // wf_…, once known
  taskId: string | null // the background task's id, once known
  name: string          // workflow_name; 'workflow' when not known
  state: RunState
  startedAt: number | null
  ms: number | null
  phases: WorkflowPhase[]
  agents: WorkflowAgentRow[]
}
export interface RunRows { phases: WorkflowPhase[]; agents: WorkflowAgentRow[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const phaseNumber = (v: unknown): number | null => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
const attemptOf = (v: unknown): number => {
  const n = finite(v)
  return n === null || n < 1 ? 1 : Math.floor(n)
}
/** a text field as one line, capped; null when it is not a string or is empty */
const clean = (v: unknown, cap: number): string | null => {
  if (typeof v !== 'string') return null
  const line = v.replace(/\s+/g, ' ').trim().slice(0, cap)
  return line === '' ? null : line
}
const stateOf = (v: unknown): WorkflowAgentRow['state'] => v === 'done' ? 'done' : v === 'error' ? 'failed' : 'running'

/** the phase with this index, added when it is new and there is room; null when there is no room */
const phaseAt = (phases: WorkflowPhase[], index: number, title: string): number | null => {
  if (phases.some(p => p.index === index)) return index
  if (phases.length >= MAX_RUN_PHASES) return null
  phases.push({ index, title })
  return index
}

/** the stream's rows of a Workflow run (workflow_phase, workflow_agent) as phases and agents; null when not an array */
export function parseWorkflowProgress(rows: unknown): RunRows | null {
  if (!Array.isArray(rows)) return null
  const phases: WorkflowPhase[] = []
  const agents: WorkflowAgentRow[] = []
  for (const row of rows) {
    if (!isObject(row)) continue
    if (row.type === 'workflow_phase') {
      const index = phaseNumber(row.index)
      if (index !== null) phaseAt(phases, index, clean(row.title, RUN_LABEL_CAP) ?? `phase ${index}`)
    } else if (row.type === 'workflow_agent' && agents.length < MAX_RUN_AGENTS) {
      const index = finite(row.index)
      if (index === null) continue
      const key = String(index)
      const phaseIndex = phaseNumber(row.phaseIndex)
      agents.push({
        key,
        agentId: isAgentId(row.agentId) ? row.agentId : null,
        label: clean(row.label, RUN_LABEL_CAP) ?? `agent ${key}`,
        phase: phaseIndex === null ? null : phaseAt(phases, phaseIndex, clean(row.phaseTitle, RUN_LABEL_CAP) ?? `phase ${phaseIndex}`),
        state: stateOf(row.state),
        attempt: attemptOf(row.attempt),
        model: clean(row.model, RUN_LABEL_CAP),
        effort: clean(row.effort, RUN_LABEL_CAP),
        task: clean(row.promptPreview, RUN_TASK_CAP),
        startedAt: finite(row.startedAt),
        ms: finite(row.durationMs),
      })
    }
  }
  return { phases, agents }
}

/** the run file's journal (launched, started, result, failed lines) folded into agents: one row per key, in first-seen order */
export function foldJournal(lines: unknown[]): RunRows {
  const phases: WorkflowPhase[] = []
  const agents: WorkflowAgentRow[] = []
  for (const line of lines) {
    if (!isObject(line) || typeof line.key !== 'string' || line.key === '') continue
    const key = line.key.slice(0, 100)
    const known = agents.find(a => a.key === key)
    if (line.type === 'started') {
      if (known) {
        known.attempt += 1
        known.agentId = isAgentId(line.agentId) ? line.agentId : null
        known.state = 'running'
        known.ms = null
        continue
      }
      if (agents.length >= MAX_RUN_AGENTS) continue
      const name = clean(line.phase, RUN_LABEL_CAP)
      let phase: number | null = null
      if (name !== null) {
        const found = phases.find(p => p.title === name)
        phase = found ? found.index : phaseAt(phases, phases.length, name)
      }
      agents.push({
        key,
        agentId: isAgentId(line.agentId) ? line.agentId : null,
        label: clean(line.label, RUN_LABEL_CAP) ?? `agent ${key}`,
        phase,
        state: 'running',
        attempt: 1,
        model: null,
        effort: null,
        task: null,
        startedAt: null,
        ms: null,
      })
    } else if (known && line.type === 'result') {
      known.state = 'done'
    } else if (known && line.type === 'failed') {
      known.state = 'failed'
    }
  }
  return { phases, agents }
}

/** the runId and the task id of a Workflow call's result text: the `Transcript dir:` path's last part, the `Task ID:` value */
export function runOfResult(text: string): { runId: string | null; taskId: string | null } {
  const task = /Task ID: (\S+)/.exec(text)?.[1]
  const dirs = [...text.matchAll(/Transcript dir: ([^\r\n]+)/g)]
  const dir = dirs[dirs.length - 1]?.[1]?.trim() ?? ''
  const last = dir.split(/[\\/]/).filter(part => part !== '').pop()
  return { runId: isRunId(last) ? last : null, taskId: isAgentId(task) ? task : null }
}

/** the task text of a Workflow call without its harness line, one line, capped; null when empty */
export function workflowTask(text: string): string | null {
  const lines = text.split('\n')
  const body = lines[0]?.startsWith('[Workflow harness') ? lines.slice(1).join('\n') : text
  return clean(body, RUN_TASK_CAP)
}

/** a run from a stored or sent value, cleaned and capped; null when its key, name or state is not usable */
export function isWorkflowRun(v: unknown): WorkflowRun | null {
  if (!isObject(v)) return null
  if (typeof v.key !== 'string' || v.key.trim() === '' || v.key.length > 500) return null
  if (typeof v.name !== 'string' || !isRunState(v.state)) return null
  const agents: WorkflowAgentRow[] = []
  if (Array.isArray(v.agents)) {
    for (const row of v.agents) {
      if (agents.length >= MAX_RUN_AGENTS) break
      if (!isObject(row) || typeof row.key !== 'string' || row.key === '') continue
      const key = row.key.slice(0, 100)
      agents.push({
        key,
        agentId: isAgentId(row.agentId) ? row.agentId : null,
        label: clean(row.label, RUN_LABEL_CAP) ?? `agent ${key}`,
        phase: phaseNumber(row.phase),
        state: stateOf(row.state),
        attempt: attemptOf(row.attempt),
        model: clean(row.model, RUN_LABEL_CAP),
        effort: clean(row.effort, RUN_LABEL_CAP),
        task: clean(row.task, RUN_TASK_CAP),
        startedAt: finite(row.startedAt),
        ms: finite(row.ms),
      })
    }
  }
  const phases: WorkflowPhase[] = []
  if (Array.isArray(v.phases)) {
    for (const p of v.phases) {
      const index = isObject(p) ? phaseNumber(p.index) : null
      if (index !== null) phaseAt(phases, index, clean(isObject(p) ? p.title : null, RUN_LABEL_CAP) ?? `phase ${index}`)
    }
  }
  return {
    key: v.key,
    runId: isRunId(v.runId) ? v.runId : null,
    taskId: isAgentId(v.taskId) ? v.taskId : null,
    name: clean(v.name, RUN_LABEL_CAP) ?? 'workflow',
    state: v.state,
    startedAt: finite(v.startedAt),
    ms: finite(v.ms),
    phases,
    agents,
  }
}

/** whether a progress message changed the run: an unchanged one sends nothing */
export const sameRun = (a: WorkflowRun | undefined, b: WorkflowRun): boolean => a !== undefined && JSON.stringify(a) === JSON.stringify(b)

/** the run ended: its running agents are failed, as nothing will finish them */
export function endRun(run: WorkflowRun, state: RunEnd, ms: number | null): WorkflowRun {
  return { ...run, state, ms, agents: run.agents.map(a => a.state === 'running' ? { ...a, state: 'failed' } : a) }
}

/** a task's status as the run ends: completed → done, failed → failed, killed or stopped → stopped; null for any other */
export function runEndState(status: unknown): RunEnd | null {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'killed' || status === 'stopped') return 'stopped'
  return null
}

/** the status bar's line for a run: the phase of its latest-started agent, and how many agents are done of how many */
export function runHead(run: WorkflowRun): { phase: string | null; done: number; total: number } {
  let latest: WorkflowAgentRow | null = null
  for (const a of run.agents) {
    if (latest === null || (a.startedAt ?? -Infinity) >= (latest.startedAt ?? -Infinity)) latest = a
  }
  const phase = run.phases.find(p => p.index === latest?.phase)?.title ?? null
  return { phase, done: run.agents.filter(a => a.state === 'done').length, total: run.agents.length }
}
