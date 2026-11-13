import type { ChatCommandInfo, ChatModelInfo, ChatPermissionMode } from '../../shared/chat'
import type { PermissionAsk, SdkPermissionResult } from './chat-cards'
import type { ChatLaunch } from './claude-spawn'

// What ChatHub needs of a running conversation: the SDK is one implementation, the tests use fakes

export interface ChatEngineStart {
  launch: Exclude<ChatLaunch, { how: 'none' }>; cwd: string; env: Record<string, string>
  settingsPath: string | null   // ClaudeLaunch.settingsPath (src/main/profiles.ts): our hook settings file, null when there is none
  sessionId: string | null      // resume this one; null: a new session
  newSessionId: string          // the id a new session starts with (not used when resuming)
  fork: boolean                 // with sessionId: start a copy of it
}

export interface ChatEngineHandlers {
  /** called once, when Claude Code has answered initialize: before any turn, so before any init */
  /** models: the list Claude Code gives in its answer (none when not given) */
  ready(info: { permissionMode: string | null; models?: ChatModelInfo[] }): void
  message(m: unknown): void
  ask(ask: Omit<PermissionAsk, 'folder'>, signal: AbortSignal): Promise<SdkPermissionResult>
  dialog(kind: string, payload: unknown): void      // answered 'cancelled' by the engine
  stderr(text: string): void
  exit(code: number | null): void
}

/** an MCP server the running session loads, as Claude Code reports it: the fields the answer gives, each checked and capped by the engine (null: not given) */
export interface McpLiveServer {
  name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; error: string | null; version: string | null
  scope: string | null; source: string | null; transport: string | null; target: string | null; tools: string[]
}

/** the context fill, as the engine reads it: the percentage, and the token counts when the answer gives them (null: not given) */
export interface ChatContext { pct: number | null; used: number | null; size: number | null }

export interface ChatEngine {
  /** the uuid is the send's id: Claude Code names it in the frames of the turn that takes it */
  send(text: string, images: { mediaType: string; data: string }[], uuid: string): void
  interrupt(): Promise<void>
  setPermissionMode(mode: ChatPermissionMode): Promise<void>
  setModel(model: string | null): Promise<void>
  /** the effort of the model: null for the default */
  setEffort(level: string | null): Promise<void>
  stopTask(taskId: string): Promise<void>
  commands(): Promise<ChatCommandInfo[]>
  models(): Promise<ChatModelInfo[]>
  context(): Promise<ChatContext>
  /** the effort Claude Code applies to the next message (get_settings, applied.effort): a level, null for none, undefined when it cannot be read */
  effort(): Promise<string | null | undefined>
  /** the MCP servers the session loads, as Claude Code reports them now */
  mcpStatus(): Promise<McpLiveServer[]>
  reconnectMcp(name: string): Promise<void>
  toggleMcp(name: string, enabled: boolean): Promise<void>
  /** ends the input: Claude Code exits by itself; after `graceMs` (default 2500) the process is killed */
  close(graceMs?: number): void
  kill(): void
}

export type StartChatEngine = (o: ChatEngineStart, h: ChatEngineHandlers) => ChatEngine
