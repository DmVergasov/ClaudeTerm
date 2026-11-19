import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { type AttentionMessage, type AttentionReason, cutText, defaultPipeName, isUuid, LAST_MESSAGE_MAX, oneLineText, parseTasks, type PipeMessage, type PipeResponse, PROMPT_TEXT_MAX } from '../shared/protocol'
import { isBridgeId } from '../shared/remote-control'
import { compactWindow } from './compact-window'
import { statusFromStatusLine } from './status-line'

/** a settings file's text; the status line runs in a short-lived process of its own, so a small synchronous read is fine */
const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export type Sender = (pipeName: string, msg: PipeMessage) => Promise<PipeResponse>

type Obj = Record<string, unknown>

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** the hook input (JSON on stdin) as an object, or null */
export function parseInput(stdinText: string): Obj | null {
  try {
    const v: unknown = JSON.parse(stdinText)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null
  } catch {
    return null
  }
}

/** the pipe server refuses a line over 64 KB and the turn's end would be lost with it: a Stop whose message would encode longer drops its last answer */
const STOP_MESSAGE_ENCODED_MAX = 60_000

/** the tool input fields that say what a permission prompt runs or touches, the first one that is a string wins */
const PROMPT_DETAIL_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'description']

/** "Allow <tool>: <detail>", the detail the first string of command, file_path, notebook_path, url, path, pattern, description; "Allow <tool>" without one; null without a tool name */
export function permissionPrompt(tool: unknown, input: unknown): string | null {
  if (typeof tool !== 'string' || tool === '') return null
  const ti = isObj(input) ? input : {}
  const detail = PROMPT_DETAIL_FIELDS.map((k) => ti[k]).find((v): v is string => typeof v === 'string' && oneLineText(v, PROMPT_TEXT_MAX) !== '')
  return oneLineText(detail === undefined ? `Allow ${tool}` : `Allow ${tool}: ${detail}`, PROMPT_TEXT_MAX)
}

/** the first question's text of an AskUserQuestion input, or null */
export function questionPrompt(input: unknown): string | null {
  const questions = isObj(input) && Array.isArray(input.questions) ? input.questions : []
  const first = isObj(questions[0]) ? questions[0].question : undefined
  if (typeof first !== 'string') return null
  const line = oneLineText(first, PROMPT_TEXT_MAX)
  return line === '' ? null : line
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
      transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
      cwd: typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : null
    }
  }
  // an API error that ends a subagent's turn (the usage limit, an overload) runs StopFailure with its agent_id, and no
  // SubagentStop follows: it is that subagent's end, not the main conversation's
  const subagentFailed = event === 'StopFailure' && typeof input.agent_id === 'string' && input.agent_id !== ''
  if (event === 'SubagentStart' || event === 'SubagentStop' || subagentFailed) {
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
  // the folder Claude's shell is in is not the tab's: a Bash cd only looks around; the session's folder comes with the statusLine
  if (event === 'UserPromptSubmit') return { v: 1, type: 'turn', tabId, sessionId }
  if (event === 'PreToolUse' && typeof input.tool_name === 'string' && EDIT_TOOLS.has(input.tool_name)) {
    const ti = isObj(input.tool_input) ? input.tool_input : {}
    const p = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : null
    if (!p || typeof input.tool_use_id !== 'string' || input.tool_use_id === '') return null
    const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : null
    const path = isAbsolute(p) ? p : cwd ? resolve(cwd, p) : null
    return path ? { v: 1, type: 'edit_before', tabId, sessionId, toolUseId: input.tool_use_id, path } : null
  }
  const agentId = typeof input.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : null
  const attention = (reason: AttentionReason, background = false): AttentionMessage =>
    ({ v: 1, type: 'attention', tabId, sessionId, reason, ...(agentId ? { agentId } : {}), ...(background ? { background: true as const } : {}) })
  // Claude Code asks an AskUserQuestion through its permission dialog too, a second after PreToolUse reported the question:
  // that one is no permission prompt, and the question is reported already
  if (event === 'PermissionRequest') {
    if (input.tool_name === 'AskUserQuestion') return null
    const prompt = permissionPrompt(input.tool_name, input.tool_input)
    return { ...attention('permission'), ...(prompt ? { prompt } : {}) }
  }
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') {
    const prompt = questionPrompt(input.tool_input)
    return { ...attention('question'), ...(prompt ? { prompt } : {}) }
  }
  // background_tasks: the background work still in flight, which wakes the session again when it ends; capped as the pipe parser caps them
  if (event === 'Stop') {
    const done = Array.isArray(input.background_tasks)
      ? { ...attention('done', input.background_tasks.length > 0), tasks: parseTasks(input.background_tasks) }
      : attention('done')
    if (typeof input.last_assistant_message !== 'string') return done
    const withLast = { ...done, lastMessage: cutText(input.last_assistant_message, LAST_MESSAGE_MAX) }
    return JSON.stringify(withLast).length > STOP_MESSAGE_ENCODED_MAX ? done : withLast
  }
  if (event === 'StopFailure') return { ...attention('done'), error: typeof input.error === 'string' ? input.error : 'unknown' }
  return null
}

/** the Remote Control id Claude Code gives the session through its environment, or null when it gives none */
export function bridgeId(env: NodeJS.ProcessEnv): string | null {
  const id = env.CLAUDE_CODE_BRIDGE_SESSION_ID
  return isBridgeId(id) ? id : null
}

/** the pipe a hook reports to: CLAUDETERM_PIPE when the app set it, else the user's default pipe */
export function hookPipe(env: NodeJS.ProcessEnv): string {
  return env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username)
}

/** the most characters of a coordinator's instruction the hook hands Claude Code as the turn's context */
export const TURN_CONTEXT_MAX = 2000

/**
 * The line a UserPromptSubmit hook prints for the answer to its turn: the instruction the answer carries, as Claude Code's
 * additional context for the turn. Empty when the answer carries none, or one that is empty or longer than TURN_CONTEXT_MAX.
 */
export function turnContextLine(answer: PipeResponse | null): string {
  if (answer === null || !answer.ok || typeof answer.info !== 'string') return ''
  if (answer.info.length < 1 || answer.info.length > TURN_CONTEXT_MAX) return ''
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: answer.info } })}\n`
}

/** the answer to the message, or null when it did not get one */
async function deliver(msg: PipeMessage, env: NodeJS.ProcessEnv, send: Sender): Promise<PipeResponse | null> {
  try {
    return await send(hookPipe(env), msg)
  } catch {
    return null
  }
}

/** the text to print on stdout: '' for none, which every event but a coordinator's UserPromptSubmit answer is */
export async function runSessionHook(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<string> {
  const tabId = env.CLAUDETERM_TAB_ID
  if (!isUuid(tabId)) return ''
  const input = parseInput(stdinText)
  const msg = input ? hookMessage(input, tabId) : null
  if (msg === null) return ''
  // the session, its turns and its attention carry the Remote Control id: the app shows Remote Control from them
  const sent: PipeMessage = msg.type === 'session' || msg.type === 'turn' || msg.type === 'attention' ? { ...msg, remote: bridgeId(env) } : msg
  const answer = await deliver(sent, env, send)
  return msg.type === 'turn' && input?.hook_event_name === 'UserPromptSubmit' ? turnContextLine(answer) : ''
}

export async function runStatusLine(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  const tabId = env.CLAUDETERM_TAB_ID
  if (!isUuid(tabId)) return false
  const input = parseInput(stdinText)
  const msg = input ? statusFromStatusLine(input, tabId, (model, dir) => compactWindow(model, dir, env, readText)) : null
  return msg ? (await deliver({ ...msg, remote: bridgeId(env) }, env, send)) !== null : false
}
