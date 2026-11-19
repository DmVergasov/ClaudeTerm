import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isAgentId } from '../shared/chat'
import { isRunId, parseWorkflowProgress, RUN_LABEL_CAP, runEndState, type RunEnd, type RunRows } from '../shared/workflow'
import { isWithin } from './path-key'

// The run file Claude Code writes when a Workflow run ends: <session folder>/workflows/<runId>.json. It is read when a chat's history is
// read, and when a background run's transcript is read. Everything in it is untrusted: a field of the wrong type is dropped, a file that
// is too big, is not JSON or lies outside the session folder is no file at all.

/** a run file over this many bytes is not read */
export const RUN_FILE_CAP = 1024 * 1024

/** the fields of a run file the chat takes: a null is a field the file does not give */
export interface RunFile {
  taskId: string | null
  name: string | null
  state: RunEnd
  startedAt: number | null
  ms: number | null
  rows: RunRows | null
}

type Obj = Record<string, unknown>
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null

/** the run's start: milliseconds, or an ISO date string read as one; null for anything else */
function startOf(v: unknown): number | null {
  const ms = finite(v)
  if (ms !== null) return ms
  if (typeof v !== 'string') return null
  const parsed = Date.parse(v)
  return Number.isFinite(parsed) ? parsed : null
}

/** a run file's parsed JSON, typed field by field; null when it is not an object */
function runFileOf(value: unknown): RunFile | null {
  if (!isObject(value)) return null
  const name = typeof value.workflowName === 'string' ? value.workflowName.replace(/\s+/g, ' ').trim().slice(0, RUN_LABEL_CAP) : ''
  const ms = finite(value.durationMs)
  return {
    taskId: isAgentId(value.taskId) ? value.taskId : null,
    name: name === '' ? null : name,
    state: runEndState(value.status) ?? 'stopped',
    startedAt: startOf(value.startTime),
    ms: ms !== null && ms >= 0 ? ms : null,
    rows: parseWorkflowProgress(value.workflowProgress),
  }
}

/**
 * The run file of a Workflow run in a session folder, typed; null when the run id is not a run id, the file is missing, over RUN_FILE_CAP,
 * not JSON, or reached through a link that leads outside the session folder.
 */
export async function readRunFile(sessionDir: string, runId: string): Promise<RunFile | null> {
  if (!isRunId(runId)) return null
  try {
    const file = join(sessionDir, 'workflows', `${runId}.json`)
    const info = await stat(file)
    if (!info.isFile() || info.size > RUN_FILE_CAP) return null
    // the real places decide: a workflows folder that is a link out of the session is refused
    const real = await realpath(file)
    if (!isWithin(await realpath(sessionDir), real)) return null
    return runFileOf(JSON.parse(await readFile(real, 'utf8')) as unknown)
  } catch {
    return null
  }
}
