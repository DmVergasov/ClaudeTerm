import { userInfo } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { type AttentionReason, defaultPipeName, isUuid, type PipeMessage, type PipeResponse } from '../shared/protocol'
import { statusFromStatusLine } from './status-line'

export type Sender = (pipeName: string, msg: PipeMessage) => Promise<PipeResponse>

type Obj = Record<string, unknown>

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseInput(stdinText: string): Obj | null {
  try {
    const v: unknown = JSON.parse(stdinText)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null
  } catch {
    return null
  }
}

/** Pipe message for a hook event; SessionStart is assumed when hook_event_name is missing. */
export function hookMessage(input: Obj, tabId: string): PipeMessage | null {
  const sessionId = input.session_id
  if (!isUuid(sessionId)) return null
  const event = input.hook_event_name ?? 'SessionStart'
  if (event === 'SessionStart') {
    return {
      v: 1,
      type: 'session',
      tabId,
      sessionId,
      source: typeof input.source === 'string' ? input.source : 'unknown',
      transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null
    }
  }
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    if (typeof input.agent_id !== 'string' || input.agent_id === '') return null
    return {
      v: 1,
      type: 'subagent',
      tabId,
      sessionId,
      event: event === 'SubagentStart' ? 'start' : 'stop',
      agentId: input.agent_id,
      agentType: typeof input.agent_type === 'string' ? input.agent_type : 'agent'
    }
  }
  if (event === 'SessionEnd') return { v: 1, type: 'session_end', tabId, sessionId }
  if (event === 'UserPromptSubmit') {
    return { v: 1, type: 'turn', tabId, sessionId, cwd: typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : null }
  }
  if (event === 'PreToolUse' && typeof input.tool_name === 'string' && EDIT_TOOLS.has(input.tool_name)) {
    const ti = isObj(input.tool_input) ? input.tool_input : {}
    const p = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : null
    if (!p || typeof input.tool_use_id !== 'string' || input.tool_use_id === '') return null
    const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : null
    const path = isAbsolute(p) ? p : cwd ? resolve(cwd, p) : null
    return path ? { v: 1, type: 'edit_before', tabId, sessionId, toolUseId: input.tool_use_id, path } : null
  }
  const agentId = typeof input.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : null
  const attention = (reason: AttentionReason): PipeMessage => ({ v: 1, type: 'attention', tabId, sessionId, reason, ...(agentId ? { agentId } : {}) })
  if (event === 'PermissionRequest') return attention('permission')
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') return attention('question')
  if (event === 'Stop') return attention('done')
  return null
}

async function deliver(msg: PipeMessage, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  try {
    await send(env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username), msg)
    return true
  } catch {
    return false
  }
}

export async function runSessionHook(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  const tabId = env.CLAUDETERM_TAB_ID
  if (!isUuid(tabId)) return false
  const input = parseInput(stdinText)
  const msg = input ? hookMessage(input, tabId) : null
  return msg ? deliver(msg, env, send) : false
}

export async function runStatusLine(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  const tabId = env.CLAUDETERM_TAB_ID
  if (!isUuid(tabId)) return false
  const input = parseInput(stdinText)
  const msg = input ? statusFromStatusLine(input, tabId) : null
  return msg ? deliver(msg, env, send) : false
}
