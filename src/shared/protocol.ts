import { isAbsolute, posix } from 'node:path'
import { REVIEW_SCOPES, type ReviewScope } from './review'
import type { MainStatus } from './types'

export const PROTOCOL_VERSION = 1
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_CAPTION = 500
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_LABEL = 100
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/
const MAX_REF = 200
const MAX_PATHS = 100
const ATTENTION_REASONS: readonly string[] = ['permission', 'question', 'done'] satisfies AttentionReason[]

export interface ShowImageMessage {
  v: 1
  type: 'show_image'
  tabId: string | null
  path: string
  caption: string | null
}

export interface SessionMessage {
  v: 1
  type: 'session'
  tabId: string
  sessionId: string
  source: string
  transcriptPath: string | null
}

export interface StatusMessage extends MainStatus {
  v: 1
  type: 'status'
  tabId: string
  sessionId: string
}

export interface SubagentMessage {
  v: 1
  type: 'subagent'
  tabId: string
  sessionId: string
  event: 'start' | 'stop'
  agentId: string
  agentType: string
}

export interface SessionEndMessage {
  v: 1
  type: 'session_end'
  tabId: string
  sessionId: string
}

export type AttentionReason = 'permission' | 'question' | 'done'

/** Claude is waiting for the user: a permission prompt, an AskUserQuestion, or the end of a turn. */
export interface AttentionMessage {
  v: 1
  type: 'attention'
  tabId: string
  sessionId: string
  reason: AttentionReason
  /** the subagent whose dialog it is; absent for the main conversation */
  agentId?: string
}

/** Claude Code took a prompt (UserPromptSubmit): a turn starts. */
export interface TurnMessage {
  v: 1
  type: 'turn'
  tabId: string
  sessionId: string
  cwd: string | null
}

/** Claude is about to change a file (PreToolUse of an edit tool). ClaudeTerm reads the file before it replies. */
export interface EditBeforeMessage {
  v: 1
  type: 'edit_before'
  tabId: string
  sessionId: string
  toolUseId: string
  path: string
}

/** show_diff from the MCP server: open a diff in the tab's Changes panel. */
export interface ShowDiffMessage {
  v: 1
  type: 'show_diff'
  tabId: string | null
  /** where Claude runs: relative paths and the repository come from here */
  cwd: string
  scope: ReviewScope | null
  from: string | null
  to: string | null
  paths: string[]
  title: string | null
}

export type PipeMessage =
  | ShowImageMessage | SessionMessage | StatusMessage | SubagentMessage | SessionEndMessage | AttentionMessage
  | TurnMessage | EditBeforeMessage | ShowDiffMessage
export type PipeResponse = { ok: true; info?: string } | { ok: false; error: string }
export type ParseResult = { ok: true; message: PipeMessage } | { ok: false; error: string }

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export interface PipeContext {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  uid: number
}

export const currentPipeContext = (): PipeContext => ({ platform: process.platform, env: process.env, uid: process.getuid?.() ?? -1 })

/** Where ClaudeTerm keeps its socket outside Windows: the user's runtime folder, else a private folder in /tmp. */
export function socketDir(ctx: PipeContext): string {
  const xdg = ctx.env.XDG_RUNTIME_DIR
  return xdg && posix.isAbsolute(xdg) ? xdg : `/tmp/claudeterm-${ctx.uid}`
}

/** ClaudeTerm's address for this user: a named pipe on Windows, a Unix socket elsewhere. */
export function defaultPipeName(username: string, ctx: PipeContext = currentPipeContext()): string {
  const name = `claudeterm-${username.replace(/[^A-Za-z0-9_.-]/g, '_')}`
  return ctx.platform === 'win32' ? `\\\\.\\pipe\\${name}` : posix.join(socketDir(ctx), `${name}.sock`)
}

export function encodeMessage(msg: PipeMessage | PipeResponse): string {
  return JSON.stringify(msg) + '\n'
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const label = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_LABEL) : null)

function parseContext(v: unknown): MainStatus['context'] {
  if (!isObj(v) || !isNum(v.usedTokens) || !isNum(v.size) || v.size <= 0 || !isNum(v.usedPct)) return null
  return { usedTokens: v.usedTokens, size: v.size, usedPct: v.usedPct }
}

function parseLimit(v: unknown): MainStatus['fiveHour'] {
  if (!isObj(v) || !isNum(v.usedPct) || !isNum(v.resetsAt)) return null
  return { usedPct: v.usedPct, resetsAt: v.resetsAt }
}

export function parsePipeMessage(line: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'message must be a JSON object' }
  const m = raw as Record<string, unknown>
  if (m.v !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol version: ${String(m.v)}` }

  if (m.type === 'show_image') {
    if (typeof m.path !== 'string' || !isAbsolute(m.path)) return { ok: false, error: 'path must be an absolute path' }
    if (m.tabId !== undefined && m.tabId !== null && typeof m.tabId !== 'string') return { ok: false, error: 'tabId must be a string or null' }
    if (m.caption !== undefined && m.caption !== null && typeof m.caption !== 'string') return { ok: false, error: 'caption must be a string or null' }
    return {
      ok: true,
      message: {
        v: 1,
        type: 'show_image',
        tabId: typeof m.tabId === 'string' ? m.tabId : null,
        path: m.path,
        caption: typeof m.caption === 'string' ? m.caption.slice(0, MAX_CAPTION) : null
      }
    }
  }

  if (m.type === 'session') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    const tp = m.transcriptPath
    const transcriptPath = typeof tp === 'string' && isAbsolute(tp) && tp.toLowerCase().endsWith('.jsonl') ? tp : null
    return {
      ok: true,
      message: { v: 1, type: 'session', tabId: m.tabId, sessionId: m.sessionId, source: typeof m.source === 'string' ? m.source : 'unknown', transcriptPath }
    }
  }

  if (m.type === 'turn' || m.type === 'edit_before') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    if (m.type === 'turn') {
      const cwd = typeof m.cwd === 'string' && isAbsolute(m.cwd) ? m.cwd : null
      return { ok: true, message: { v: 1, type: 'turn', tabId: m.tabId, sessionId: m.sessionId, cwd } }
    }
    if (typeof m.toolUseId !== 'string' || !TOOL_USE_ID_RE.test(m.toolUseId)) return { ok: false, error: 'toolUseId must match [A-Za-z0-9_-]{1,200}' }
    if (typeof m.path !== 'string' || !isAbsolute(m.path)) return { ok: false, error: 'path must be an absolute path' }
    return { ok: true, message: { v: 1, type: 'edit_before', tabId: m.tabId, sessionId: m.sessionId, toolUseId: m.toolUseId, path: m.path } }
  }

  if (m.type === 'show_diff') {
    const tabId = m.tabId === null || m.tabId === undefined ? null : isUuid(m.tabId) ? m.tabId : undefined
    if (tabId === undefined) return { ok: false, error: 'tabId must be a UUID or null' }
    if (typeof m.cwd !== 'string' || !isAbsolute(m.cwd)) return { ok: false, error: 'cwd must be an absolute path' }
    const scope = m.scope === null || m.scope === undefined ? null : REVIEW_SCOPES.find((s) => s === m.scope)
    if (scope === undefined) return { ok: false, error: 'scope must be "uncommitted", "last_turn", "session" or null' }
    const ref = (v: unknown): string | null | undefined =>
      v === null || v === undefined ? null : typeof v === 'string' && v.length > 0 && v.length <= MAX_REF && !v.startsWith('-') ? v : undefined
    const from = ref(m.from)
    const to = ref(m.to)
    if (from === undefined || to === undefined) return { ok: false, error: 'from and to must be git revisions that do not start with "-"' }
    const paths = m.paths ?? []
    if (!Array.isArray(paths) || paths.length > MAX_PATHS || !paths.every((p): p is string => typeof p === 'string' && isAbsolute(p))) {
      return { ok: false, error: `paths must be at most ${MAX_PATHS} absolute paths` }
    }
    if (m.title !== null && m.title !== undefined && typeof m.title !== 'string') return { ok: false, error: 'title must be a string or null' }
    return { ok: true, message: { v: 1, type: 'show_diff', tabId, cwd: m.cwd, scope, from, to, paths, title: label(m.title) } }
  }

  if (m.type === 'status' || m.type === 'subagent' || m.type === 'session_end' || m.type === 'attention') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    const ids = { tabId: m.tabId, sessionId: m.sessionId }
    if (m.type === 'session_end') return { ok: true, message: { v: 1, type: 'session_end', ...ids } }
    if (m.type === 'attention') {
      if (typeof m.reason !== 'string' || !ATTENTION_REASONS.includes(m.reason)) return { ok: false, error: 'reason must be "permission", "question" or "done"' }
      const agent = typeof m.agentId === 'string' && AGENT_ID_RE.test(m.agentId) ? { agentId: m.agentId } : {}
      return { ok: true, message: { v: 1, type: 'attention', ...ids, reason: m.reason as AttentionReason, ...agent } }
    }
    if (m.type === 'subagent') {
      if (m.event !== 'start' && m.event !== 'stop') return { ok: false, error: 'event must be "start" or "stop"' }
      if (typeof m.agentId !== 'string' || !AGENT_ID_RE.test(m.agentId)) return { ok: false, error: 'agentId must match [A-Za-z0-9_-]{1,64}' }
      return { ok: true, message: { v: 1, type: 'subagent', ...ids, event: m.event, agentId: m.agentId, agentType: label(m.agentType) ?? 'agent' } }
    }
    const model: Obj = isObj(m.model) ? m.model : {}
    const id = label(model.id)
    if (!id) return { ok: false, error: 'model.id must be a non-empty string' }
    return {
      ok: true,
      message: { v: 1, type: 'status', ...ids, model: { id, displayName: label(model.displayName) ?? id }, effort: label(m.effort), context: parseContext(m.context), fiveHour: parseLimit(m.fiveHour), sevenDay: parseLimit(m.sevenDay) }
    }
  }

  return { ok: false, error: `unknown message type: ${String(m.type)}` }
}
