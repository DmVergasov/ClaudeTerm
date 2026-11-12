import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The stand-in Claude Code (fake-claude.ts) and the script a test gives it (FAKE_CLAUDE_SCRIPT)

export type FakeStep =
  | { text: string; chunks?: number; pace?: number; rate?: number } // a streamed answer; pace: ms between its pieces, so a test can look at it while it streams; rate: words (tokens) per second, the words evenly spaced (chunks and pace do not apply)
  | { tool: { name: string; input: Record<string, unknown>; result: string; isError?: boolean; ms?: number } }
  | { ask: { tool: string; input: Record<string, unknown>; suggestions?: unknown[]; defaultToNo?: boolean }; allowed: FakeStep[]; denied: FakeStep[] }
  | { gate: string } // waits until the file <config folder>/<gate> exists: a test releases the turn when it has done what it needs
  | { asks: { tool: string; input: Record<string, unknown>; suggestions?: unknown[]; defaultToNo?: boolean }[] } // every ask at once: all the requests go out, then the step waits for every answer, in any order
  | { command: string; output: string } // local command output
  | { notAvailable: string } // "/<name> isn't available in this environment."
  | { retry: { attempt: number; max: number; delayMs: number } }
  | { error: string }
  | { compact: true }
  | { wait: number }
  | { thinking: string; ms: number } // a thinking block of the message: its summary ("" for none); Claude thinks for ms
  | { task: { description: string; result: string; agents: { type: string; description: string; ms: number; failed?: boolean }[] } } // an Agent call (sdk.d.ts 6505, 6436): its subagents start at once and end at their ms (failed: they end failed); the call ends with its result
  | { crash: number; once?: boolean } // exit with this code; once: only on the first run (a marker file beside the script)
  | { noise: string } // a raw stdout line that is not a message
  | { dialog: string } // a control_request { subtype: 'request_user_dialog', dialog_kind: <it>, payload: {} }; goes on when answered
  | { child: string } // starts a process as a command or a server Claude Code started: its command line carries the marker; logs { child: <pid> }
  | { lingerMs: number } // sets how long the process runs after its input ends (a slow exit); a step of a turn or of beforeInit
  | { fold: true } // the next assistant message names the user messages read so far as taken into the turn (user_message_uuids)
  | { rateLimit: { type: 'five_hour' | 'seven_day'; utilization: number; resetsAt: number; status?: 'allowed' | 'rejected'; windows?: RateLimitWindows } } // a rate_limit_event of the stream, shaped as the recorded one (utilization 0.42 is 42 %); windows: what unifiedWindows carries, both limits when given

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
  models?: { value: string; resolvedModel?: string; displayName: string; description: string; supportedEffortLevels?: string[] }[] // resolvedModel: what the value resolves to (value when not given)
  /** the model the stream names (init and assistant messages); the recorded one when not given */
  model?: string
  beforeInit?: FakeStep[]
  turns: Record<string, FakeStep[]>
  fallback?: FakeStep[]
  /** the percentage the get_context_usage answer gives (the context fill the chat reads after each turn); the recorded one when not given */
  contextPct?: number
  /** the token counts of the get_context_usage answer (totalTokens, maxTokens); the recorded ones when not given */
  contextTokens?: number | null
  contextMax?: number | null // null: the answer carries no count of this kind
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
