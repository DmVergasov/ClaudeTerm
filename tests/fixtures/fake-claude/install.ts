import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The stand-in Claude Code (fake-claude.ts) and the script a test gives it (FAKE_CLAUDE_SCRIPT)

export type FakeStep =
  | { text: string; chunks?: number; pace?: number; rate?: number } // a streamed answer; pace: ms between its pieces, so a test can look at it while it streams; rate: words (tokens) per second, the words evenly spaced (chunks and pace do not apply)
  | { tool: { name: string; input: Record<string, unknown>; result: string; isError?: boolean; ms?: number; output?: unknown } } // output: the structured tool_use_result of the call (default: the text)
  | { ask: { tool: string; input: Record<string, unknown>; suggestions?: unknown[]; defaultToNo?: boolean }; allowed: FakeStep[]; denied: FakeStep[] }
  | { gate: string } // waits until the file <config folder>/<gate> exists: a test releases the turn when it has done what it needs
  | { asks: { tool: string; input: Record<string, unknown>; suggestions?: unknown[]; defaultToNo?: boolean }[] } // every ask at once: all the requests go out, then the step waits for every answer, in any order
  | { command: string; output: string } // local command output
  | { notAvailable: string } // "/<name> isn't available in this environment."
  | { retry: { attempt: number; max: number; delayMs: number } }
  | { error: string }
  | { compact: true | FakeCompact }
  | { wait: number }
  | { thinking: string; ms: number } // a thinking block of the message: its summary ("" for none); Claude thinks for ms
  | { task: { description: string; result: string; background?: true; agents: { type: string; description: string; ms: number; failed?: boolean; model?: string; effort?: string; work?: { model: string; context: number } }[] } } // an Agent call (sdk.d.ts 6505, 6436): its subagents start at once and end at their ms (failed: they end failed); the call ends with its result; background: the call ends at once with the launch notice, and each agent ends at its ms after that, outliving the turn. model, effort: what the call asks for (AgentInput); work: the subagent's own call, passed on as Claude Code does (its model, and its usage with this many tokens)
  | { crash: number; once?: boolean } // exit with this code; once: only on the first run (a marker file beside the script)
  | { noise: string } // a raw stdout line that is not a message
  | { dialog: string } // a control_request { subtype: 'request_user_dialog', dialog_kind: <it>, payload: {} }; goes on when answered
  | { child: string } // starts a process as a command or a server Claude Code started: its command line carries the marker; logs { child: <pid> }
  | { lingerMs: number } // sets how long the process runs after its input ends (a slow exit); a step of a turn or of beforeInit
  | { fold: true | 'result' } // true: the next assistant message names the user messages read so far as taken into the turn (user_message_uuids); 'result': the messages still waiting are taken into the turn, named only on its result (user_message_uuids), and no turn of their own runs them
  | { inject: { text: string; origin?: Record<string, unknown> } } // a user-role message Claude Code puts in the conversation itself (a background task's notice, another session's message); origin: the SDK's origin of it, none when not given
  | { rateLimit: { type: 'five_hour' | 'seven_day'; utilization: number; resetsAt: number; status?: 'allowed' | 'rejected'; windows?: RateLimitWindows } } // a rate_limit_event of the stream, shaped as the recorded one (utilization 0.42 is 42 %); windows: what unifiedWindows carries, every window the account has; left out, the event has no unifiedWindows and names its own window alone
  | { cli: string[] } // Claude runs `claude <args>` with Bash: a Bash tool_use (input.command = 'claude ' + args joined by spaces), then the stand-in's own CLI runs in-process, then the tool_result with its stdout

/** a compaction (compact: true is one with the defaults): gate holds it until the file <config folder>/<gate> exists; fail ends it as a failure with this error; the numbers go in its boundary */
export interface FakeCompact { trigger?: 'manual' | 'auto'; preTokens?: number; postTokens?: number; durationMs?: number; gate?: string; fail?: string }

/** the windows of a rate_limit_event's unifiedWindows: each limit's utilization (a fraction) and reset (seconds) */
export type RateLimitWindows = { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow }
export type RateLimitWindow = { utilization: number; resetsAt: number; status?: 'allowed' | 'allowed_warning' | 'rejected' }

export interface FakeScript {
  version?: string
  /** the commands the initialize reply lists (supportedCommands); the recorded list when not given */
  commands?: { name: string; description: string; argumentHint: string; builtin?: boolean }[]
  /** the commands init names as terminal_slash_commands; none when not given */
  terminalCommands?: string[]
  /** the models the initialize reply lists (supportedModels); the recorded list when not given */
  models?: { value: string; resolvedModel?: string; displayName: string; description: string; supportedEffortLevels?: string[]; supportsAutoMode?: boolean }[] // resolvedModel: what the value resolves to (value when not given); supportsAutoMode: the model runs auto mode (only with autoMode: true)
  /** whether the models the initialize reply lists run auto mode: without it (or not true) no model does, as before; true keeps the recorded list's flags and a script's own */
  autoMode?: boolean
  /** the model the stream names (init and assistant messages); the recorded one when not given */
  model?: string
  /** the effort in effect the init names (null: none is sent); the init names no effort when not given */
  effort?: string | null
  /** the effort the get_settings answer reports as applied.effort (null: none); the answer names no effort when not given */
  appliedEffort?: string | null
  /** the mode Claude Code says it starts in, in its initialize reply (current_permission_mode); the recorded one when not given */
  permissionMode?: string
  /** the mode the init of the first turn names (its permissionMode); the recorded one when not given */
  initPermissionMode?: string
  beforeInit?: FakeStep[]
  turns: Record<string, FakeStep[]>
  fallback?: FakeStep[]
  /** the percentage the get_context_usage answer gives (the context fill the chat reads); the recorded one when not given, none when null */
  contextPct?: number | null
  /** the token counts of the get_context_usage answer (totalTokens, maxTokens); the recorded ones when not given */
  contextTokens?: number | null
  contextMax?: number | null // null: the answer carries no count of this kind
  /** the folder the init names (Claude Code's working folder: a resumed session's worktree); the folder it was started in when not given */
  cwd?: string
  /** the answers to ClaudeTerm's Heads up questions (src/main/chat/heads-up.ts): a check's, and Explain more's */
  headsUp?: { check?: string; explain?: string }
  /** the MCP servers the session loaded, by name: every one is connected with the tool `ping` unless given here (a status, a failure's error, its tools, its version); pendingMs: 'pending' that long after the start */
  mcp?: Record<string, { status?: 'connected' | 'failed' | 'needs-auth'; error?: string; tools?: string[]; version?: string; pendingMs?: number }>
  /** `claude mcp login <name>`: waits for <config folder>/<gate>; fail: that message on stderr, exit 1. A name not given logs in at once */
  mcpLogin?: Record<string, { gate?: string; fail?: string }>
  /** what `claude plugin marketplace add <source>` can add, by its exact source */
  marketplaces?: FakeMarketplace[]
  /** a CLI call whose arguments (joined by spaces, `--` left out) start with the key fails with that message, exit 1 */
  cliFail?: Record<string, string>
  /** a CLI call whose arguments start with the key waits, after it is logged, until the file <config folder>/<gate> exists: a test holds it while it does something else */
  cliGate?: Record<string, string>
}

export interface FakeMarketplace { name: string; source: string; plugins: FakePlugin[] }
export interface FakePlugin {
  name: string
  description: string
  version: string
  installVersion?: string
  installs?: number
  /** the MCP servers the plugin ships (its .mcp.json), each started as `fake-mcp <name>` */
  mcpServers?: string[]
  options?: { key: string; title: string; description?: string; required: boolean; sensitive: boolean }[]
}

const STAND_IN = resolve(import.meta.dirname, 'fake-claude.ts')

/** writes a command that runs the stand-in Claude Code, for claude.command; returns its path */
export function installFakeClaude(dir: string): string {
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    const file = join(dir, 'claude.cmd')
    writeFileSync(file, `@"${process.execPath}" --experimental-strip-types --no-warnings "${STAND_IN}" %*\r\n`)
    return file
  }
  const file = join(dir, 'claude')
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${STAND_IN}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}
