import { isAbsolute } from 'node:path'
import type { MainStatus } from './types'

export const PROTOCOL_VERSION = 1
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_CAPTION = 500
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_LABEL = 100
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
}

export type PipeMessage = ShowImageMessage | SessionMessage | StatusMessage | SubagentMessage | SessionEndMessage | AttentionMessage
export type PipeResponse = { ok: true } | { ok: false; error: string }
export type ParseResult = { ok: true; message: PipeMessage } | { ok: false; error: string }

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function defaultPipeName(username: string): string {
  return `\\\\.\\pipe\\claudeterm-${username.replace(/[^A-Za-z0-9_.-]/g, '_')}`
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

function parseFiveHour(v: unknown): MainStatus['fiveHour'] {
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

  if (m.type === 'status' || m.type === 'subagent' || m.type === 'session_end' || m.type === 'attention') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    const ids = { tabId: m.tabId, sessionId: m.sessionId }
    if (m.type === 'session_end') return { ok: true, message: { v: 1, type: 'session_end', ...ids } }
    if (m.type === 'attention') {
      if (typeof m.reason !== 'string' || !ATTENTION_REASONS.includes(m.reason)) return { ok: false, error: 'reason must be "permission", "question" or "done"' }
      return { ok: true, message: { v: 1, type: 'attention', ...ids, reason: m.reason as AttentionReason } }
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
      message: { v: 1, type: 'status', ...ids, model: { id, displayName: label(model.displayName) ?? id }, effort: label(m.effort), context: parseContext(m.context), fiveHour: parseFiveHour(m.fiveHour) }
    }
  }

  return { ok: false, error: `unknown message type: ${String(m.type)}` }
}
