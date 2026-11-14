import { isAbsolute, posix } from 'node:path'
import { COORD_NAME_MAX, COORD_TASK_MAX, isWorktreeName, type CoordOp } from './coordinator'
import { MAIL_TEXT_MAX, MAIL_TO_MAX } from './mail'
import { NOTE_ADD_MAX, NOTE_ITEM_MAX, NOTE_SIDES, type NoteSide } from './note'
import { REVIEW_SCOPES, type ReviewScope } from './review'
import { normalizeTaskList, type TaskList } from './task-list'
import type { BackgroundTask, MainStatus } from './types'

export const PROTOCOL_VERSION = 1
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_CAPTION = 500
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const ERROR_RE = /^[a-z_]{1,64}$/
const MAX_LABEL = 100
/** the background tasks of a turn end, at most, and how much of each command is kept */
const MAX_TASKS = 50
const MAX_TASK_COMMAND = 300
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/
const MAX_REF = 200
const MAX_PATHS = 100
const MAX_FOLDER = 4096
const COORD_DEVICE_MAX = 200
const ATTENTION_REASONS: readonly string[] = ['permission', 'question', 'done'] satisfies AttentionReason[]
/** the longest last answer a Stop passes, and the longest line of a pending permission or question, in characters */
export const LAST_MESSAGE_MAX = 8000
export const PROMPT_TEXT_MAX = 200

/** the first max code points of text */
export function cutText(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

/** text as one line: control characters and line separators become spaces, runs of spaces one, trimmed; longer than max: max - 1 code points and "…" */
export function oneLineText(text: string, max: number): string {
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/ {2,}/g, ' ').trim()
  const points = Array.from(line)
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : line
}

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
  /** the folder Claude Code runs in as the session starts (the hook input's cwd); null or absent when it names none (a hook script of an older version sends none) */
  cwd?: string | null
}

export interface StatusMessage extends MainStatus {
  v: 1
  type: 'status'
  tabId: string
  sessionId: string
  /** the session's folder (the statusLine's workspace.project_dir): /cd and a worktree change it, a Bash cd does not */
  projectDir?: string
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
  /** done only: the turn ended while background work Claude started still runs, and Claude goes on when it ends */
  background?: true
  /** done only: the API error the turn ended in (StopFailure), e.g. server_error for a response cut off mid-stream */
  error?: string
  /** done only (Stop): the background work still running as the turn ended; absent when Claude Code does not say */
  tasks?: BackgroundTask[]
  /** permission or question: what waits for the user, as one line */
  prompt?: string
  /** done without error (Stop): Claude Code's last_assistant_message, at most LAST_MESSAGE_MAX characters */
  lastMessage?: string
}

/** Claude Code took a prompt (UserPromptSubmit): a turn starts. */
export interface TurnMessage {
  v: 1
  type: 'turn'
  tabId: string
  sessionId: string
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

/** show_document from the MCP server: open a Markdown, PDF or HTML file in the tab's Docs panel. */
export interface ShowDocumentMessage {
  v: 1
  type: 'show_document'
  tabId: string | null
  path: string
  title: string | null
}

/** set_task_list from the MCP server: the whole task list of the tab, or null to remove it. */
export interface TaskListMessage {
  v: 1
  type: 'task_list'
  tabId: string
  list: TaskList | null
}

/** get_task_list from the MCP server: asks for the task list of the tab. */
export interface TaskListGetMessage {
  v: 1
  type: 'task_list_get'
  tabId: string
}

/** device_status from the MCP server: the read-only status of device sync, as text. */
export interface DeviceStatusMessage {
  v: 1
  type: 'device_status'
}

/** open_device_settings from the MCP server: open the Settings window at the Devices section. */
export interface OpenDeviceSettingsMessage {
  v: 1
  type: 'open_device_settings'
}

/** agent_list from the MCP server: the Claude sessions this tab can message. */
export interface AgentListMessage {
  v: 1
  type: 'agent_list'
  tabId: string
}

/** agent_send from the MCP server: a message to another Claude session, as a reply to replyTo or not. */
export interface AgentSendMessage {
  v: 1
  type: 'agent_send'
  tabId: string
  to: string
  text: string
  replyTo: string | null
}

/** mail_wait from the mail watcher: held by main until mail for the tab is ready, or the watcher is superseded. */
export interface MailWaitMessage {
  v: 1
  type: 'mail_wait'
  tabId: string
  sessionId: string
}

/** read_notes from the MCP server: both notes of the tab, as text */
export interface NoteReadMessage {
  v: 1
  type: 'note_read'
  tabId: string
}

/** add_to_note from the MCP server: text added at the end of one of the tab's notes */
export interface NoteAddMessage {
  v: 1
  type: 'note_add'
  tabId: string
  note: NoteSide
  text: string
}

/** check_note_item from the MCP server: one checkbox item of one of the tab's notes ticked or unticked */
export interface NoteCheckMessage {
  v: 1
  type: 'note_check'
  tabId: string
  note: NoteSide
  item: string
  checked: boolean
}

/** a coordinator tool of the MCP server: one operation of the tab's coordinator */
export type CoordMessage = { v: 1; type: 'coord'; tabId: string } & CoordOp

export type PipeMessage =
  | ShowImageMessage | SessionMessage | StatusMessage | SubagentMessage | SessionEndMessage | AttentionMessage
  | TurnMessage | EditBeforeMessage | ShowDiffMessage | ShowDocumentMessage
  | TaskListMessage | TaskListGetMessage | DeviceStatusMessage | OpenDeviceSettingsMessage
  | AgentListMessage | AgentSendMessage | MailWaitMessage
  | NoteReadMessage | NoteAddMessage | NoteCheckMessage | CoordMessage
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

/** the background tasks of a turn end: an entry without a usable id is left out, the texts are cut to size */
function parseTasks(raw: unknown[]): BackgroundTask[] {
  const tasks: BackgroundTask[] = []
  for (const t of raw) {
    if (tasks.length === MAX_TASKS) break
    if (!isObj(t) || typeof t.id !== 'string' || !AGENT_ID_RE.test(t.id)) continue
    const command = typeof t.command === 'string' && t.command.length > 0 ? t.command.slice(0, MAX_TASK_COMMAND) : null
    tasks.push({ id: t.id, type: label(t.type) ?? 'task', description: label(t.description), command })
  }
  return tasks
}

/** a text field of 1 to max characters, or absent: null; undefined when it is given and not valid */
function optionalField(v: unknown, valid: (s: string) => boolean): string | null | undefined {
  if (v === null || v === undefined) return null
  return typeof v === 'string' && valid(v) ? v : undefined
}

const sized = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max

/** the fields of a coordinator op as the MCP server sends them; an absent optional field becomes null */
function parseCoordOp(m: Obj): { ok: true; op: CoordOp } | { ok: false; error: string } {
  if (m.op === 'list') return { ok: true, op: { op: 'list' } }
  if (m.op === 'start') {
    if (!sized(m.task, COORD_TASK_MAX)) return { ok: false, error: `task must be 1 to ${COORD_TASK_MAX} characters` }
    const name = optionalField(m.name, (s) => sized(s, COORD_NAME_MAX))
    if (name === undefined) return { ok: false, error: `name must be 1 to ${COORD_NAME_MAX} characters` }
    const folder = optionalField(m.folder, (s) => s.length <= MAX_FOLDER && !s.includes('\0') && isAbsolute(s))
    if (folder === undefined) return { ok: false, error: `folder must be an absolute path of at most ${MAX_FOLDER} characters` }
    const device = optionalField(m.device, (s) => sized(s, COORD_DEVICE_MAX))
    if (device === undefined) return { ok: false, error: `device must be 1 to ${COORD_DEVICE_MAX} characters` }
    const worktree = optionalField(m.worktree, isWorktreeName)
    if (worktree === undefined) return { ok: false, error: 'worktree must be a plain name, not a path' }
    return { ok: true, op: { op: 'start', task: m.task, name, folder, device, worktree } }
  }
  if (m.op === 'attach' || m.op === 'detach' || m.op === 'read' || m.op === 'resolve' || m.op === 'message') {
    if (!sized(m.session, MAIL_TO_MAX)) return { ok: false, error: `session must be 1 to ${MAIL_TO_MAX} characters` }
    if (m.op !== 'message') return { ok: true, op: { op: m.op, session: m.session } }
    if (!sized(m.text, COORD_TASK_MAX)) return { ok: false, error: `text must be 1 to ${COORD_TASK_MAX} characters` }
    return { ok: true, op: { op: 'message', session: m.session, text: m.text } }
  }
  return { ok: false, error: `unknown coord op: ${String(m.op)}` }
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
    const cwd = typeof m.cwd === 'string' && m.cwd !== '' && m.cwd.length <= MAX_FOLDER && !m.cwd.includes('\0') && isAbsolute(m.cwd) ? m.cwd : null
    return {
      ok: true,
      message: { v: 1, type: 'session', tabId: m.tabId, sessionId: m.sessionId, source: typeof m.source === 'string' ? m.source : 'unknown', transcriptPath, cwd }
    }
  }

  if (m.type === 'turn' || m.type === 'edit_before') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    if (m.type === 'turn') return { ok: true, message: { v: 1, type: 'turn', tabId: m.tabId, sessionId: m.sessionId } }
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

  if (m.type === 'show_document') {
    const tabId = m.tabId === null || m.tabId === undefined ? null : isUuid(m.tabId) ? m.tabId : undefined
    if (tabId === undefined) return { ok: false, error: 'tabId must be a UUID or null' }
    if (typeof m.path !== 'string' || !isAbsolute(m.path)) return { ok: false, error: 'path must be an absolute path' }
    if (m.title !== null && m.title !== undefined && typeof m.title !== 'string') return { ok: false, error: 'title must be a string or null' }
    return { ok: true, message: { v: 1, type: 'show_document', tabId, path: m.path, title: label(m.title) } }
  }

  if (m.type === 'task_list' || m.type === 'task_list_get') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (m.type === 'task_list_get') return { ok: true, message: { v: 1, type: 'task_list_get', tabId: m.tabId } }
    const list = normalizeTaskList(m.list)
    if (!list.ok) return { ok: false, error: list.error }
    return { ok: true, message: { v: 1, type: 'task_list', tabId: m.tabId, list: list.list } }
  }
  if (m.type === 'note_read' || m.type === 'note_add' || m.type === 'note_check') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (m.type === 'note_read') return { ok: true, message: { v: 1, type: 'note_read', tabId: m.tabId } }
    const note = NOTE_SIDES.find((s) => s === m.note)
    if (note === undefined) return { ok: false, error: 'note must be "session" or "project"' }
    if (m.type === 'note_add') {
      if (typeof m.text !== 'string' || m.text.length < 1 || m.text.length > NOTE_ADD_MAX) return { ok: false, error: `text must be 1 to ${NOTE_ADD_MAX} characters` }
      return { ok: true, message: { v: 1, type: 'note_add', tabId: m.tabId, note, text: m.text } }
    }
    if (typeof m.item !== 'string' || m.item.length < 1 || m.item.length > NOTE_ITEM_MAX) return { ok: false, error: `item must be 1 to ${NOTE_ITEM_MAX} characters` }
    if (typeof m.checked !== 'boolean') return { ok: false, error: 'checked must be a boolean' }
    return { ok: true, message: { v: 1, type: 'note_check', tabId: m.tabId, note, item: m.item, checked: m.checked } }
  }
  if (m.type === 'coord') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    const parsed = parseCoordOp(m)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    return { ok: true, message: { v: 1, type: 'coord', tabId: m.tabId, ...parsed.op } }
  }
  if (m.type === 'device_status') return { ok: true, message: { v: 1, type: 'device_status' } }
  if (m.type === 'open_device_settings') return { ok: true, message: { v: 1, type: 'open_device_settings' } }

  if (m.type === 'agent_list' || m.type === 'agent_send' || m.type === 'mail_wait') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (m.type === 'agent_list') return { ok: true, message: { v: 1, type: 'agent_list', tabId: m.tabId } }
    if (m.type === 'mail_wait') {
      if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
      return { ok: true, message: { v: 1, type: 'mail_wait', tabId: m.tabId, sessionId: m.sessionId } }
    }
    if (typeof m.to !== 'string' || m.to.length < 1 || m.to.length > MAIL_TO_MAX) return { ok: false, error: `to must be 1 to ${MAIL_TO_MAX} characters` }
    if (typeof m.text !== 'string' || m.text.length < 1 || m.text.length > MAIL_TEXT_MAX) return { ok: false, error: `text must be 1 to ${MAIL_TEXT_MAX} characters` }
    const replyTo = m.replyTo === null || m.replyTo === undefined ? null : isUuid(m.replyTo) ? m.replyTo : undefined
    if (replyTo === undefined) return { ok: false, error: 'replyTo must be a UUID or null' }
    return { ok: true, message: { v: 1, type: 'agent_send', tabId: m.tabId, to: m.to, text: m.text, replyTo } }
  }

  if (m.type === 'status' || m.type === 'subagent' || m.type === 'session_end' || m.type === 'attention') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    const ids = { tabId: m.tabId, sessionId: m.sessionId }
    if (m.type === 'session_end') return { ok: true, message: { v: 1, type: 'session_end', ...ids } }
    if (m.type === 'attention') {
      if (typeof m.reason !== 'string' || !ATTENTION_REASONS.includes(m.reason)) return { ok: false, error: 'reason must be "permission", "question" or "done"' }
      const agent = typeof m.agentId === 'string' && AGENT_ID_RE.test(m.agentId) ? { agentId: m.agentId } : {}
      const background = m.reason === 'done' && m.background === true ? { background: true as const } : {}
      const error = m.reason === 'done' && typeof m.error === 'string' && ERROR_RE.test(m.error) ? { error: m.error } : {}
      const tasks = m.reason === 'done' && Array.isArray(m.tasks) ? { tasks: parseTasks(m.tasks) } : {}
      const line = typeof m.prompt === 'string' ? oneLineText(m.prompt, PROMPT_TEXT_MAX) : ''
      const prompt = m.reason !== 'done' && line !== '' ? { prompt: line } : {}
      const lastMessage = m.reason === 'done' && !('error' in error) && typeof m.lastMessage === 'string' ? { lastMessage: cutText(m.lastMessage, LAST_MESSAGE_MAX) } : {}
      return { ok: true, message: { v: 1, type: 'attention', ...ids, reason: m.reason as AttentionReason, ...agent, ...background, ...error, ...tasks, ...prompt, ...lastMessage } }
    }
    if (m.type === 'subagent') {
      if (m.event !== 'start' && m.event !== 'stop') return { ok: false, error: 'event must be "start" or "stop"' }
      if (typeof m.agentId !== 'string' || !AGENT_ID_RE.test(m.agentId)) return { ok: false, error: 'agentId must match [A-Za-z0-9_-]{1,64}' }
      return { ok: true, message: { v: 1, type: 'subagent', ...ids, event: m.event, agentId: m.agentId, agentType: label(m.agentType) ?? 'agent' } }
    }
    const model: Obj = isObj(m.model) ? m.model : {}
    const id = label(model.id)
    if (!id) return { ok: false, error: 'model.id must be a non-empty string' }
    const projectDir = typeof m.projectDir === 'string' && isAbsolute(m.projectDir) ? { projectDir: m.projectDir } : {}
    return {
      ok: true,
      message: { v: 1, type: 'status', ...ids, model: { id, displayName: label(model.displayName) ?? id }, effort: label(m.effort), context: parseContext(m.context), fiveHour: parseLimit(m.fiveHour), sevenDay: parseLimit(m.sevenDay), ...projectDir }
    }
  }

  return { ok: false, error: `unknown message type: ${String(m.type)}` }
}
