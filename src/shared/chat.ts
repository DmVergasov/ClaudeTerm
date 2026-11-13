// The chat view's data, shared by main and the window

import type { ReloadAction } from './mcp'

export type TabView = 'chat' | 'terminal'
export const TAB_VIEWS: readonly TabView[] = ['chat', 'terminal']
export const isTabView = (v: unknown): v is TabView => v === 'chat' || v === 'terminal'

export type ChatTurn = 'idle' | 'working' | 'waiting'
export type ChatPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'

/** a file the user attached, on this computer: main reads it when the message goes; cardId: its Media card, for a thumbnail;
 * oversize: an image too big to scale in main, which goes to Claude as its path */
export interface ChatAttachment { kind: 'image' | 'file'; path: string; name: string; size: number; cardId: string | null; oversize?: boolean }
/** who sent a message that is not the user's own typing: an auto-continue, or the Review panel's Send. Such a message is no recall */
export type ChatSendOrigin = 'auto' | 'review'
export interface ChatSend { text: string; attachments: ChatAttachment[]; from?: ChatSendOrigin }

/** the longest line the terminal handoff types: one line of printable text, as main checks it before it types it */
export const HANDOFF_LINE_CAP = 2000
const CONTROL = /[\u0000-\u001f\u007f]/
/** the rule of a line the terminal handoff types: printable, 1 to 2000 characters */
export const isHandoffLine = (line: string): boolean => line.length > 0 && line.length <= HANDOFF_LINE_CAP && !CONTROL.test(line)
/** the first word of a typed command, as the notices and the menu name it: `/context` of `/context now` */
export const commandWord = (text: string): string => text.split(/\s/)[0] ?? text

export type ChatCallState = 'running' | 'done' | 'failed'
/**
 * A subagent of an Agent call. model: the model its call asks for (an alias), then the one it runs on (an id); effort: the level
 * its call asks for; context: the tokens of its own conversation at its last call. Each is absent while not known, and from an
 * older device.
 */
export interface ChatSubagent {
  id: string; description: string; type: string; state: ChatCallState; ms: number | null
  model?: string; effort?: string; context?: number
  /** when it started (ms since the epoch, main's clock): a running row counts up from it */
  startedAt?: number
}
export interface ChatToolCall {
  id: string; name: string; subject: string; detail: string | null; state: ChatCallState
  output: string | null; error: string | null; editPath: string | null; agents: ChatSubagent[]; ms: number | null
}
export type ChatNoticeAction = 'restart' | 'open-terminal' | 'open-mcp'

export type ChatItem =
  | { kind: 'user'; id: string; text: string; attachments: ChatAttachment[]; queued: boolean; from?: ChatSendOrigin }
  | { kind: 'text'; id: string; markdown: string; streaming: boolean }
  | { kind: 'thinking'; id: string; ms: number | null; summary: string | null }
  | { kind: 'tools'; id: string; calls: ChatToolCall[]; ms: number | null }
  | { kind: 'images'; id: string; images: { path: string; cardId: string | null }[] }
  | { kind: 'command'; id: string; command: string; output: string }
  | { kind: 'notice'; id: string; tone: 'info' | 'error'; text: string; action: ChatNoticeAction | null; line?: string | null }
  | { kind: 'divider'; id: string; text: string; good?: string }
  | { kind: 'card'; id: string; card: ChatCard; answered: string | null }
  // a card that a change outside the chat asks the person to act on (a new MCP server: Restart the session to load it)
  | { kind: 'reload'; id: string; title: string; text: string; action: ReloadAction | null }
  // a message Claude Code puts in the conversation that is not the person's: a background task's end, another session's message, a channel's
  | { kind: 'event'; id: string; source: ChatEventSource; title: string; status: string | null; body: string }

/** what an event row is about: a background task (task), another Claude session (peer), any other message (message) */
export type ChatEventSource = 'task' | 'peer' | 'message'

export interface ChatSuggestion { index: number; label: string }
export interface ChatQuestion { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }
export type ChatCard =
  | { type: 'permission'; tool: string; title: string; subject: string; description: string | null
      diff: { path: string; before: string; after: string } | null; suggestions: ChatSuggestion[]; defaultToNo: boolean }
  | { type: 'question'; questions: ChatQuestion[] }
  | { type: 'plan'; plan: string }
  | { type: 'dialog'; kind: string; title: string; text: string; choices: { id: string; label: string }[] }

export type ChatAnswer =
  | { type: 'permission'; choice: 'once' | 'deny'; suggestion: number | null; message: string | null }
  | { type: 'question'; answers: Record<string, string | string[]> | null }
  | { type: 'plan'; choice: 'accept-edits' | 'ask-edits' | 'keep-planning'; message: string | null }
  | { type: 'dialog'; choice: string | null }

/** what the chat does between its turns: Claude Code compacts the conversation, or the chat restarts it; since: when it began */
export interface ChatActivity { kind: 'compacting' | 'restarting'; since: number }

export interface ChatState {
  turn: ChatTurn; turnStartedAt: number | null; mode: ChatPermissionMode
  model: string | null; effort: string | null; sessionId: string | null; exited: boolean
  /** optional: absent when nothing is going on outside the turns */
  activity?: ChatActivity
}
export interface ChatSnapshot { tabId: string; rev: number; items: ChatItem[]; hasOlder: boolean; state: ChatState }
export type ChatPatch =
  | { op: 'add'; item: ChatItem }
  | { op: 'set'; item: ChatItem }
  | { op: 'append'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'call'; id: string; call: ChatToolCall }   // in the tools item `id`: replaces the call with the same call.id, or appends it
  | { op: 'state'; state: ChatState }
  | { op: 'reset'; items: ChatItem[]; hasOlder: boolean }

/**
 * A Heads up card above a chat's message box: what a side agent, reading the conversation while Claude works, found the
 * person should know. `heads-up`: about the work in this session (a decision Claude made, a result that may be off);
 * `should-know`: how something works that matters for their work. `more` is the longer explanation asked for with Explain
 * more, while `explaining` it is on its way; `explainError` says why it did not come.
 */
export interface HeadsUpCard {
  id: string
  tag: 'heads-up' | 'should-know'
  title: string
  text: string
  more: string | null
  explaining: boolean
  explainError: string | null
}
/** Got it closes the card, Not relevant closes it and the topic is not offered again, Explain more asks for more */
export type HeadsUpAction = 'got-it' | 'not-relevant' | 'explain'
export const HEADS_UP_ACTIONS: readonly HeadsUpAction[] = ['got-it', 'not-relevant', 'explain']

/** the messages the user typed in a chat, oldest first: what ↑ recalls. Auto-continue prompts and Review sends are not the user's */
export function typedMessages(items: readonly ChatItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'user' && item.from === undefined && item.text !== '' ? [item.text] : []))
}

/** how a viewer at revision `rev` takes a batch (fromRev, toRev, n patches, one revision each) */
export type PatchAccept = { kind: 'ignore' } | { kind: 'apply'; skip: number } | { kind: 'gap' }

/** a batch the viewer already has is ignored; one that starts at or before its revision is applied past what it has; else a gap */
export function acceptPatches(rev: number, fromRev: number, toRev: number, count: number): PatchAccept {
  if (toRev <= rev) return { kind: 'ignore' }
  if (fromRev > rev || toRev - fromRev !== count) return { kind: 'gap' }
  return { kind: 'apply', skip: rev - fromRev }
}
export interface ChatCommandInfo { name: string; description: string; argumentHint: string; group: 'builtin' | 'project' | 'plugin'; source: string | null; terminal: boolean }
/** `resolved`: the full model id the SDK resolves the entry to (an alias such as `opus` resolves to it); absent when the SDK sends none */
export interface ChatModelInfo {
  value: string
  displayName: string
  description: string
  efforts: string[]
  resolved?: string
  /** the model runs auto mode: an older device's list has no flag (absent) */
  autoMode?: boolean
}
