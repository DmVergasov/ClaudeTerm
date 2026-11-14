import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EffortLevel, ModelInfo, PermissionResult, Query, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { ChatCommandInfo, ChatModelInfo } from '../../shared/chat'
import type { ChatEngine, ChatEngineHandlers, ChatEngineStart, McpLiveServer, StartChatEngine } from './chat-engine'
import { spawnChatProcess, type ChatLaunch } from './claude-spawn'

// One conversation with the user's Claude Code through the Agent SDK's query() in streaming-input mode. The SDK starts
// no process of its own: every Claude Code process is started by spawnChatProcess, with the user's claude command

const DEFAULT_GRACE_MS = 2500
const EXIT_WAIT_MS = 1000
const GROUP_KILL_MS = 2000
const SHELL_NOTICE = /^(?:bash|zsh): (?:cannot set terminal process group|no job control in this shell|can't set tty pgrp)/
const NAME_CAP = 500
const TEXT_CAP = 64 * 1024

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')

let sdk: Promise<Sdk> | undefined

/** the Agent SDK, loaded at run time the first time a conversation starts: the only place it is imported */
export function loadSdk(): Promise<Sdk> {
  // a test run tells the e2e tests when the SDK has been loaded (the chat starts it, a shell tab does not)
  if (process.env.CLAUDETERM_TEST === '1') (globalThis as { ctChatSdkLoaded?: boolean }).ctChatSdkLoaded = true
  sdk ??= import('@anthropic-ai/claude-agent-sdk')
  return sdk
}

/** the prompt stream: messages pushed by send, read by the query in order; a push never waits */
class PromptQueue {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(message: SDKUserMessage): void {
    if (this.closed) return
    this.items.push(message)
    this.wakeUp()
  }

  end(): void {
    this.closed = true
    this.wakeUp()
  }

  private wakeUp(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>(resolve => {
        this.wake = resolve
      })
    }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** a string from Claude Code, capped; anything else is empty */
const text = (v: unknown, cap = TEXT_CAP): string => (typeof v === 'string' ? v.slice(0, cap) : '')

const MCP_STATUSES: McpLiveServer['status'][] = ['connected', 'failed', 'needs-auth', 'pending', 'disabled']

/** a string from Claude Code, capped; null when it is missing, empty or not a string */
const optText = (v: unknown, cap: number): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, cap) : null)

/** the target of a server: its URL, else its command and arguments joined by spaces; the headers and env are never read */
function targetOf(config: Record<string, unknown>): string | null {
  const url = optText(config.url, 2000)
  if (url !== null) return url
  const command = optText(config.command, 1000)
  if (command === null) return null
  const args = Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === 'string').slice(0, 50).map(a => a.slice(0, 500)) : []
  return [command, ...args].join(' ')
}

/** the tool names of a server: up to 500, each capped; other entries are left out */
function toolNames(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const names: string[] = []
  for (const tool of list) {
    const name = isObj(tool) ? optText(tool.name, 200) : null
    if (name !== null) names.push(name)
    if (names.length === 500) break
  }
  return names
}

/** the servers Claude Code reports for the session: an entry without a usable name or a known status is left out; a non-array answer gives none */
function mcpServersOf(list: unknown): McpLiveServer[] {
  if (!Array.isArray(list)) return []
  const servers: McpLiveServer[] = []
  for (const s of list) {
    if (!isObj(s)) continue
    const name = typeof s.name === 'string' && s.name !== '' && s.name.length <= 200 ? s.name : null
    const status = MCP_STATUSES.find(known => known === s.status)
    if (name === null || status === undefined) continue
    const info = isObj(s.serverInfo) ? s.serverInfo : {}
    const config = isObj(s.config) ? s.config : {}
    servers.push({
      name, status, error: optText(s.error, 2000), version: optText(info.version, 100), scope: optText(s.scope, 50), source: optText(s.source, 50),
      transport: optText(config.type, 50), target: targetOf(config), tools: toolNames(s.tools),
    })
  }
  return servers
}

function commandInfo(c: SlashCommand, terminal: Set<string>): ChatCommandInfo {
  const name = text(c.name, NAME_CAP)
  const colon = name.indexOf(':')
  return {
    name,
    description: text(c.description),
    argumentHint: text(c.argumentHint),
    group: c.builtin === true ? 'builtin' : 'plugin',
    source: colon > 0 ? name.slice(0, colon) : null,
    terminal: terminal.has(name)
  }
}

function modelInfo(m: ModelInfo): ChatModelInfo {
  const resolved = text(m.resolvedModel, NAME_CAP)
  return {
    value: text(m.value, NAME_CAP),
    displayName: text(m.displayName, NAME_CAP) || text(m.value, NAME_CAP),
    description: text(m.description),
    efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter(e => typeof e === 'string') : [],
    // the full id the alias resolves to: the chat's model is named by it, so the composer finds the entry by it
    ...(resolved === '' ? {} : { resolved }),
    // whether the model runs auto mode: the modes a chat offers depend on the model it runs
    autoMode: m.supportsAutoMode === true
  }
}

export const startSdkEngine: StartChatEngine = (o: ChatEngineStart, h: ChatEngineHandlers): ChatEngine => {
  const queue = new PromptQueue()
  const terminal = new Set<string>() // the terminal_slash_commands of the last init
  let child: ChildProcess | undefined
  let killed = false
  let ending = false // the end was asked for by close() or kill()
  let exited = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<AbortController>() // the asks the handler has not answered yet

  // an ask still open when the conversation ends is answered as a denial, so nothing waits on a dead process
  const endAsks = (): void => {
    for (const ask of [...pending]) ask.abort()
  }

  // the exit comes once, whether the query ends by itself, fails, or never starts
  const finish = (code: number | null): void => {
    if (exited) return
    exited = true
    queue.end()
    endAsks()
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    h.exit(code)
  }

  // resolves when the process has exited, or after ms
  const waitExit = (proc: ChildProcess, ms: number): Promise<void> =>
    new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

  // the process may still be ending when the query's iterator ends: its exit code is taken once it has come. A process
  // still alive after the wait is killed first, so an exit is never reported for a live process
  async function exitCode(): Promise<number | null> {
    const proc = child
    if (proc === undefined) return null
    if (proc.exitCode === null && proc.signalCode === null) {
      await waitExit(proc, EXIT_WAIT_MS)
      if (proc.exitCode === null && proc.signalCode === null) {
        killChild(true)
        await waitExit(proc, EXIT_WAIT_MS)
      }
    }
    return proc.exitCode
  }

  let groupTimer: ReturnType<typeof setTimeout> | undefined

  // POSIX: the process leads a group of its own (spawnChatProcess), and the group gets the signal, so the commands and
  // servers Claude Code started end with it. A group that is gone (ESRCH) is not an error.
  const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch {
      // the group has no processes left
    }
  }
  const groupAlive = (pid: number): boolean => {
    try {
      process.kill(-pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  // hard: the group is killed at once. Otherwise it is asked to end (SIGTERM), and killed (SIGKILL) if it is still there after GROUP_KILL_MS
  const killChild = (hard: boolean): void => {
    killed = true
    const proc = child
    if (proc === undefined) return // the spawn callback kills it as soon as it starts
    // a process that has exited is not signalled again: its pid may belong to another process by now
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const pid = proc.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      // the claude command may be a cmd.exe shim: its tree goes too
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
      return
    }
    if (hard) {
      signalGroup(pid, 'SIGKILL')
      return
    }
    signalGroup(pid, 'SIGTERM')
    if (groupTimer === undefined) {
      groupTimer = setTimeout(() => {
        groupTimer = undefined
        if (groupAlive(pid)) signalGroup(pid, 'SIGKILL')
      }, GROUP_KILL_MS)
      groupTimer.unref()
    }
  }

  const query: Promise<Query> = loadSdk().then(sdk =>
    sdk.query({
      prompt: queue,
      options: {
        cwd: o.cwd,
        env: o.env,
        pathToClaudeCodeExecutable: o.launch.how === 'shell' ? o.launch.shell : o.launch.file,
        spawnClaudeCodeProcess: options => {
          // stdio is piped, so the streams exist
          const proc = spawnChatProcess(o.launch, options.args, options.cwd ?? o.cwd, options.env) as ChildProcessWithoutNullStreams
          child = proc
          if (killed) killChild(true)
          // POSIX: the group can outlive its leader (a background shell Claude Code left running). When the end was asked for,
          // the group gets one SIGKILL once the leader has gone; an exit nobody asked for is not swept
          const pid = proc.pid
          if (process.platform !== 'win32' && pid !== undefined) {
            proc.once('exit', () => {
              if (ending) signalGroup(pid, 'SIGKILL')
            })
          }
          return proc
        },
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        perTaskStopAffordance: true,
        // a subagent's text and thinking come to the chat, each agent's page shows them
        forwardSubagentText: true,
        extraArgs: o.settingsPath === null ? {} : { settings: o.settingsPath },
        canUseTool: (toolName, input, opts) => {
          const ask = new AbortController()
          pending.add(ask)
          const stop = (): void => ask.abort()
          if (opts.signal.aborted) stop()
          else opts.signal.addEventListener('abort', stop, { once: true })
          const denied: PermissionResult = { behavior: 'deny', message: 'The chat ended.', interrupt: true }
          return new Promise<PermissionResult>(resolve => {
            const done = (result: PermissionResult): void => {
              pending.delete(ask)
              resolve(result)
            }
            ask.signal.addEventListener('abort', () => done(denied), { once: true })
            h.ask({
              toolName,
              input,
              title: opts.title,
              description: opts.description,
              displayName: opts.displayName,
              suggestions: opts.suggestions,
              defaultToNo: opts.defaultToNo,
              suppressAlwaysAllowRule: opts.suppressAlwaysAllowRule
            }, ask.signal).then(done as (r: unknown) => void, () => done(denied))
          })
        },
        // the dialogs are not shown in this version: the engine answers each one as cancelled
        onUserDialog: async request => {
          h.dialog(request.dialogKind, request.payload)
          return { behavior: 'cancelled' }
        },
        supportedDialogKinds: [],
        stderr: text => {
          // an interactive shell started without a terminal says these lines first: they are the shell's, not Claude Code's reason
          const kept = text.split('\n').filter(line => !SHELL_NOTICE.test(line)).join('\n')
          if (kept.trim() !== '') h.stderr(kept)
        },
        ...(o.sessionId === null ? { sessionId: o.newSessionId } : { resume: o.sessionId, ...(o.fork ? { forkSession: true } : {}) })
      }
    })
  )

  // Claude Code answers initialize before any turn: the engine is ready then, with the mode it reports and the models it lists
  void query.then(q => q.initializationResult()).then(
    result => {
      // the SDK's type does not name this field: it is read as Claude Code sends it
      const mode = (result as { current_permission_mode?: unknown }).current_permission_mode
      const models = Array.isArray(result.models) ? result.models.filter(m => isObj(m) && text(m.value) !== '').map(modelInfo) : []
      h.ready({ permissionMode: typeof mode === 'string' ? mode : null, models })
    },
    () => undefined // a start that fails ends through the exit
  )

  // the query's messages go to the handler in order; its iterator ending or throwing is the one exit
  void query.then(
    async q => {
      try {
        for await (const m of q) {
          noteInit(m)
          h.message(m)
        }
        finish(await exitCode())
      } catch {
        finish(await exitCode())
      }
    },
    () => finish(null)
  )

  function noteInit(m: unknown): void {
    if (!isObj(m) || m.type !== 'system' || m.subtype !== 'init') return
    terminal.clear()
    if (Array.isArray(m.terminal_slash_commands)) {
      for (const name of m.terminal_slash_commands) if (typeof name === 'string') terminal.add(name)
    }
  }

  return {
    send(message, images, uuid) {
      const content = [
        { type: 'text', text: message },
        ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }))
      ]
      queue.push({
        type: 'user',
        uuid: uuid as SDKUserMessage['uuid'],
        message: { role: 'user', content: content as SDKUserMessage['message']['content'] },
        parent_tool_use_id: null
      })
    },

    // an interrupt ends the running turn only: the query goes on with the next message
    async interrupt() {
      await (await query).interrupt()
    },

    async setPermissionMode(mode) {
      await (await query).setPermissionMode(mode)
    },

    async setModel(model) {
      await (await query).setModel(model ?? undefined)
    },

    // the effort goes to the flag settings: it applies to the running conversation, as Claude Code's own /effort does
    async setEffort(level) {
      await (await query).applyFlagSettings({ effortLevel: level as EffortLevel | null })
    },

    async stopTask(taskId) {
      await (await query).stopTask(taskId)
    },

    async commands() {
      const list = await (await query).supportedCommands()
      return list.filter(c => isObj(c) && text(c.name) !== '').map(c => commandInfo(c, terminal))
    },

    async models() {
      const list = await (await query).supportedModels()
      return list.filter(m => isObj(m) && text(m.value) !== '').map(modelInfo)
    },

    async context() {
      const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
      try {
        const usage = await (await query).getContextUsage({ detail: 'summary' })
        const pct = usage.percentage
        return { pct: typeof pct === 'number' && Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null, used: count(usage.totalTokens), size: count(usage.maxTokens) }
      } catch {
        return { pct: null, used: null, size: null }
      }
    },

    // the init names the effort only on a Remote Control host: this session reads it from the settings Claude Code applies
    async effort() {
      try {
        const settings = (await (await query as unknown as { getSettings(): Promise<unknown> }).getSettings()) as { applied?: { effort?: unknown } } | null
        const applied = isObj(settings) && isObj(settings.applied) ? settings.applied.effort : undefined
        return applied === null || typeof applied === 'string' ? applied : undefined
      } catch {
        return undefined
      }
    },

    // the servers as the session loads them now; a reconnect or a switch reaches the running session, not the files
    async mcpStatus() {
      return mcpServersOf(await (await query).mcpServerStatus())
    },

    async reconnectMcp(name) {
      await (await query).reconnectMcpServer(name)
    },

    async toggleMcp(name, enabled) {
      await (await query).toggleMcpServer(name, enabled)
    },

    close(graceMs = DEFAULT_GRACE_MS) {
      ending = true
      queue.end()
      endAsks()
      if (graceTimer === undefined && !exited) {
        graceTimer = setTimeout(() => {
          graceTimer = undefined
          killChild(false)
        }, graceMs)
        graceTimer.unref()
      }
    },

    // a hard end: the process and its group are killed at once (the app quits with no process left)
    kill() {
      ending = true
      endAsks()
      killChild(true)
    }
  }
}

export interface AskOnce {
  launch: Exclude<ChatLaunch, { how: 'none' }>
  cwd: string
  env: Record<string, string>
  model: string
  system: string
  prompt: string
  /** the answer is given up after this long, and the process killed */
  timeoutMs: number
}

/** the process of a single question, and the group it leads on POSIX, killed: it is not waited for */
function killQuestion(proc: ChildProcess | undefined): void {
  const pid = proc?.pid
  if (proc === undefined || pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // the group is gone
  }
}

/**
 * One question to the user's Claude Code, answered in one turn: no tools, no settings, MCP servers or CLAUDE.md of the user,
 * and no session kept in their history. Its answer's text; it fails when Claude Code gives no answer, an error, or none in time.
 */
export async function askOnce(o: AskOnce): Promise<string> {
  const sdk = await loadSdk()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), o.timeoutMs)
  let child: ChildProcess | undefined
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: o.prompt }, parent_tool_use_id: null }
  }
  try {
    const q = sdk.query({
      prompt: prompt(),
      options: {
        cwd: o.cwd,
        env: o.env,
        model: o.model,
        systemPrompt: o.system,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        abortController: abort,
        pathToClaudeCodeExecutable: o.launch.how === 'shell' ? o.launch.shell : o.launch.file,
        spawnClaudeCodeProcess: options => {
          child = spawnChatProcess(o.launch, options.args, options.cwd ?? o.cwd, options.env) as ChildProcessWithoutNullStreams
          return child as ChildProcessWithoutNullStreams
        },
        stderr: () => undefined
      }
    })
    for await (const m of q) {
      if (m.type !== 'result') continue
      if (m.subtype === 'success' && typeof m.result === 'string') return m.result
      throw new Error(`Claude Code answered with ${m.subtype}`)
    }
    throw new Error('Claude Code ended without an answer')
  } finally {
    clearTimeout(timer)
    killQuestion(child)
  }
}
