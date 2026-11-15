import { resolve } from 'node:path'
import type { CoordOp } from '../shared/coordinator'
import { PipeUnavailableError } from '../shared/pipe-client'
import type { CoordMessage, PipeResponse } from '../shared/protocol'
import type { ToolResult } from './show-image-tool'

export interface CoordToolDeps {
  tabId: string | null
  pipeName: string
  cwd: string
  send(pipeName: string, msg: CoordMessage, timeoutMs: number): Promise<PipeResponse>
}

export const COORD_TOOL_NAMES = ['list_sessions', 'start_session', 'attach_session', 'detach_session', 'message_session', 'read_session', 'resolve_session'] as const

export const COORD_TOOL_DESCRIPTIONS: Record<(typeof COORD_TOOL_NAMES)[number], string> = {
  list_sessions:
    'Coordinator only: list the Claude sessions attached to this coordinator with their state, open task, last report and task list progress, then the sessions of the project that are not attached. ' +
    'Reports come to you by themselves when a task ends: do not poll. A permission prompt or a question waiting in a session is the user\'s to answer there: tell the user once where it waits, never answer it. ' +
    'A usage limit is not a failure. A stopped task was stopped by the user.',
  start_session:
    'Coordinator only: open a new Claude session in ClaudeTerm and give it a task as its first message. ' +
    'It opens in this coordinator\'s folder unless folder is given, on this coordinator\'s account, in Claude Code\'s default permission mode. ' +
    'With worktree, the session first enters a new git worktree of that name with EnterWorktree; ClaudeTerm itself creates none. ' +
    'It is attached to you at once, and its report comes to you by itself when its task ends.',
  attach_session:
    'Coordinator only: attach a running Claude session, by a ref or a name from list_sessions or list_agents; a session on a paired device is attached once that device confirms. ' +
    'Attaching sends the session nothing and does not interrupt it; give it work with message_session. A session attached to another coordinator is refused.',
  detach_session:
    'Coordinator only: detach a session from this coordinator. Its open task, if any, is dropped without a report; the session is not told and goes on as it is.',
  message_session:
    'Coordinator only: give an attached session a task. It waits until the session is idle, then reaches it as the user\'s instruction given through you. ' +
    'When the session\'s turn on it ends, ClaudeTerm sends you its last answer as a report and wakes you: do not poll or wait for it.',
  read_session:
    'Coordinator only: one session in detail: its state, a permission prompt or question waiting for the user, its open task, its last report in full and its task list.',
  resolve_session:
    'Coordinator only: mark an attached session resolved: its work for you is done. A new task un-resolves it.'
}

/** a start waits for Claude Code to open the new session; the other operations answer at once */
const START_WAIT_MS = 30_000
/** how long attach_session waits for its answer: a session on a paired device is attached once that device confirms */
export const COORD_ATTACH_TIMEOUT_MS = 15_000
const OP_WAIT_MS = 3000

export async function coordTool(name: (typeof COORD_TOOL_NAMES)[number], op: CoordOp, deps: CoordToolDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: `${name} works only in a ClaudeTerm Claude tab`, isError: true }
  const msg: CoordMessage = op.op === 'start'
    ? { v: 1, type: 'coord', tabId: deps.tabId, ...op, folder: op.folder === null ? null : resolve(deps.cwd, op.folder) }
    : { v: 1, type: 'coord', tabId: deps.tabId, ...op }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, msg, op.op === 'start' ? START_WAIT_MS : op.op === 'attach' ? COORD_ATTACH_TIMEOUT_MS : OP_WAIT_MS)
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: 'ClaudeTerm is not running.', isError: true }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: res.info ?? 'Done.', isError: false } : { text: res.error, isError: true }
}
