// The stand-in Claude Code for the tests: the stream-json protocol over stdin and stdout, scripted per turn by the file
// in FAKE_CLAUDE_SCRIPT. Node built-ins only, run with --experimental-strip-types. Its replies follow the recorded
// protocol fixtures in tests/fixtures/chat (README.md there).

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { FakeCompact, FakeScript, FakeStep, RateLimitWindows } from './install'

type Msg = Record<string, any>

interface Turn {
  text: string
  error?: string
  denials: Msg[]
}

type Outcome = 'done' | 'error' | 'interrupted'

const VERSION = '2.1.322'
const MODEL = 'claude-haiku-5-5'
// the model the stream names: the script's, or the recorded one
const currentModel = (): string => script.model ?? MODEL
const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const CHAT = resolve(dirname(process.argv[1]), '..', 'chat')
const INTERRUPTED_ERROR = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'
const REQUIRES_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode'])

const argv = process.argv.slice(2)
const logFile = process.env.FAKE_CLAUDE_LOG
const scriptFile = process.env.FAKE_CLAUDE_SCRIPT
const script: FakeScript = scriptFile ? (JSON.parse(readFileSync(scriptFile, 'utf8')) as FakeScript) : { turns: {} }
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

function flag(name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1)
  }
  return undefined
}

function has(name: string): boolean {
  return argv.includes(name)
}

function logLine(entry: object): void {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n')
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, 'utf8'))
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// a gate of a CLI call waits for its file; the process ends when the parent that started it is gone, so a call the app
// abandoned (a sign-in at quit) does not outlive the app
async function waitForGate(file: string): Promise<void> {
  while (!existsSync(file)) {
    if (!alive(process.ppid)) exit(1)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// the session: a process per session id holds a lock file; a second one that starts on a live lock logs an overlap.
// Both views take it when the start names a session (--session-id or --resume)
const sessionArg = flag('--session-id')
const resumeArg = flag('--resume')
const knownId = sessionArg ?? resumeArg
const session = sessionArg ?? (resumeArg !== undefined && !has('--fork-session') ? resumeArg : randomUUID())
const lockFile = knownId !== undefined ? join(configDir, `fake-claude-${knownId}.lock`) : undefined
let lockHeld = false

function takeLock(): void {
  // a fork is a new session that starts from the head's: it takes no lock and overlaps nothing
  if (lockFile === undefined || has('--fork-session')) return
  const other = readPid(lockFile)
  if (other !== undefined && alive(other)) logLine({ overlap: knownId })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(lockFile, String(process.pid))
  lockHeld = true
}

function releaseLock(): void {
  if (lockFile !== undefined && lockHeld && readPid(lockFile) === process.pid) rmSync(lockFile, { force: true })
}

// a lingerMs step sets how long the process runs after its input ends (a slow exit); the exit is logged when it comes
let lingerMs = 0
let exiting = false

function exitWhenInputEnds(): void {
  if (exiting) return
  exiting = true
  setTimeout(() => exit(0), lingerMs)
}

function exit(code: number): void {
  logLine({ exit: code, pid: process.pid })
  releaseLock()
  // the callback runs after the messages written before it have left the process
  process.stdout.write('', () => process.exit(code))
}

function fail(error: unknown): void {
  process.stderr.write(`fake-claude: ${String(error)}\n`)
  exit(1)
}

// ---- stream-json mode ----

const projectDir = join(configDir, 'projects', realpathSync.native(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'))
const waiting = new Set<(value?: Msg) => void>() // steps paused on a timer, a dialog or a permission answer
const answers = new Map<string, (value?: Msg) => void>() // request id -> the step waiting for its answer
const queue: string[] = []
// the uuid of each user message read, in order; a fold step names them on the next assistant message
const readUuids: string[] = []
let foldNext: string[] | null = null
// the sends a 'result' fold took into the turn: named on the turn's result only
let foldResult: string[] | null = null
const recorded = new Map<string, Msg>() // the recorded control responses by request subtype
let initTemplate: Msg = {}
let templates: Record<'result' | 'interruptedResult' | 'localResult', Msg> = { result: {}, interruptedResult: {}, localResult: {} }
let resultCount = 0
let started = false
let needInit = true
let aborted = false
let busy = false
let ended = false
let seq = 0

function emit(message: Msg): void {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function sys(subtype: string, fields: Msg): Msg {
  return { type: 'system', subtype, session_id: session, uuid: randomUUID(), ...fields }
}

function stream(event: Msg): void {
  emit({ type: 'stream_event', event, session_id: session, uuid: randomUUID(), parent_tool_use_id: null })
}

function state(value: string): Msg {
  return sys('session_state_changed', { state: value, sdk_host_only: true })
}

function stamp(): string {
  return new Date().toISOString()
}

// the uuid of the transcript's last line before this run writes to it; undefined until it is read
let transcriptTail: string | null | undefined

// the uuid of a transcript file's last line: a resumed conversation's next line chains to it, as Claude Code's do
function lastLineUuid(file: string): string | null {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
    const last = JSON.parse(lines[lines.length - 1] ?? 'null') as { uuid?: unknown } | null
    return typeof last?.uuid === 'string' ? last.uuid : null
  } catch {
    return null
  }
}

// the transcript file Claude Code would write: one line per user and assistant message, each chained to the line before it
// (the SDK reads a session by walking that chain back from its last line); none for a session that is not kept
function record(type: 'user' | 'assistant', message: Msg): void {
  if (has('--no-session-persistence')) return
  mkdirSync(projectDir, { recursive: true })
  const file = join(projectDir, `${session}.jsonl`)
  if (transcriptTail === undefined) transcriptTail = lastLineUuid(file)
  const uuid = randomUUID()
  const line = {
    parentUuid: transcriptTail,
    isSidechain: false,
    userType: 'external',
    cwd: process.cwd(),
    sessionId: session,
    version: VERSION,
    type,
    message,
    uuid,
    timestamp: stamp(),
    entrypoint: 'sdk-ts'
  }
  appendFileSync(file, JSON.stringify(line) + '\n')
  transcriptTail = uuid
}

// replaces the placeholders of the recorded fixtures with this run's folder, home and settings file
function fill(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .split('{{CWD}}').join(process.cwd())
      .split('{{HOME}}').join(homedir())
      .split('{{SETTINGS}}').join(flag('--settings') ?? '')
  }
  if (Array.isArray(value)) return value.map(fill)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
  return value
}

// the first recorded line of a fixture that matches: its `out` message, with the placeholders filled
function fromFixture(name: string, pick: (m: Msg) => boolean): Msg {
  const lines = readFileSync(join(CHAT, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { dir: string; line: Msg })
  const found = lines.find(entry => entry.dir === 'out' && pick(entry.line))
  return found ? (fill(found.line) as Msg) : {}
}

// the recorded control responses by request subtype, and the recorded init message
function loadRecorded(): void {
  for (const name of ['answer', 'control', 'interrupt']) {
    const lines = readFileSync(join(CHAT, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { dir: string; line: Msg })
    const subtypes = new Map<string, string>()
    for (const { dir, line } of lines) {
      if (dir === 'in' && line.type === 'control_request') subtypes.set(line.request_id, line.request.subtype)
      if (dir === 'out' && line.type === 'control_response') {
        const subtype = subtypes.get(line.response.request_id)
        if (subtype !== undefined && !recorded.has(subtype)) recorded.set(subtype, fill(line.response.response) as Msg)
      }
    }
  }
  initTemplate = fromFixture('answer', m => m.type === 'system' && m.subtype === 'init')
  templates = {
    result: fromFixture('answer', m => m.type === 'result'),
    interruptedResult: fromFixture('interrupt', m => m.type === 'result'),
    localResult: fromFixture('slash', m => m.type === 'result' && 'local_command' in m)
  }
}

function reply(requestId: string, body: Msg): void {
  emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: body } })
}

// a rate_limit_event of the stream: the recorded one's fields (tests/fixtures/chat/answer.jsonl); unifiedWindows, which names
// every window the account has, only when the step gives the windows: without it the event names its own window alone
function emitRateLimit(limit: { type: 'five_hour' | 'seven_day'; utilization: number; resetsAt: number; status?: 'allowed' | 'rejected'; windows?: RateLimitWindows }): void {
  const status = limit.status ?? 'allowed'
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      resetsAt: limit.resetsAt,
      rateLimitType: limit.type,
      utilization: limit.utilization,
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false,
      ...(limit.windows ? { unifiedWindows: limit.windows } : {}),
      overageEnabled: false
    },
    uuid: randomUUID(),
    session_id: session
  })
}

function emitInit(): void {
  const terminal = script.terminalCommands === undefined ? {} : { terminal_slash_commands: script.terminalCommands }
  const effort = script.effort === undefined ? {} : { effort: script.effort }
  const mode = script.initPermissionMode === undefined ? {} : { permissionMode: script.initPermissionMode }
  emit({ ...initTemplate, ...terminal, ...effort, ...mode, model: currentModel(), session_id: session, cwd: script.cwd ?? process.cwd(), claude_code_version: script.version ?? VERSION, uuid: randomUUID() })
  needInit = false
}

// the initialize reply, with the script's commands and models in place of the recorded lists (the SDK's supportedCommands and
// supportedModels read them from it)
function initializeReply(): Msg {
  const body: Msg = { ...(recorded.get('initialize') ?? {}) }
  if (script.commands !== undefined) {
    body.commands = script.commands.map(c => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, builtin: c.builtin === true }))
  }
  if (script.models !== undefined) {
    body.models = script.models.map(m => ({
      value: m.value,
      resolvedModel: m.resolvedModel ?? m.value,
      displayName: m.displayName,
      description: m.description,
      supportsEffort: (m.supportedEffortLevels ?? []).length > 0,
      supportedEffortLevels: m.supportedEffortLevels ?? [],
      ...(script.autoMode === true && m.supportsAutoMode === true ? { supportsAutoMode: true } : {})
    }))
  } else if (script.autoMode !== true && Array.isArray(body.models)) {
    // the recorded list marks every model as running auto mode: without the option no model does
    body.models = (body.models as Msg[]).map(({ supportsAutoMode: _, ...m }) => m)
  }
  if (script.permissionMode !== undefined) body.current_permission_mode = script.permissionMode
  return body
}

// a result message: the recorded result's fields, with this turn's values
function resultMessage(template: Msg, fields: Msg): Msg {
  const folded = foldResult === null ? {} : { user_message_uuids: foldResult }
  foldResult = null
  return { ...template, session_id: session, uuid: randomUUID(), num_turns: 1, total_cost_usd: 0, result_index: resultCount++, queued_turn_count: queue.length, ...folded, ...fields }
}

// a pause that ends after ms, when its request is answered, or when an interrupt arrives (it resolves undefined)
function waitFor(ms?: number, requestId?: string): Promise<Msg | undefined> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value?: Msg): void => {
      if (timer !== undefined) clearTimeout(timer)
      waiting.delete(finish)
      if (requestId !== undefined) answers.delete(requestId)
      resolve(value)
    }
    if (ms !== undefined) timer = setTimeout(() => finish(), ms)
    waiting.add(finish)
    if (requestId !== undefined) answers.set(requestId, finish)
  })
}

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function startMessage(): string {
  const id = `msg_fake_${++seq}`
  stream({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: currentModel(), content: [], stop_reason: null, stop_sequence: null, usage: USAGE } })
  return id
}

// the assistant message with its fields as the recorded ones have them
function endMessage(id: string, content: Msg[], stopReason: string): void {
  const message = {
    model: currentModel(),
    id,
    type: 'message',
    role: 'assistant',
    content,
    container: null,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: USAGE,
    input_transformations: [],
    diagnostics: null,
    context_management: null
  }
  const folded = foldNext === null ? {} : { user_message_uuids: foldNext }
  foldNext = null
  emit({ type: 'assistant', message, parent_tool_use_id: null, session_id: session, uuid: randomUUID(), timestamp: stamp(), request_id: `req_fake_${++seq}`, ...folded })
  record('assistant', message)
  stream({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: USAGE })
  stream({ type: 'message_stop' })
}

async function streamText(text: string, chunks: number, turn: Turn, pace = 0, rate = 0): Promise<Outcome> {
  const id = startMessage()
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, chunks)))
  const pieces: string[] = []
  if (rate > 0) pieces.push(...(text.match(/\s*\S+\s*/g) ?? [])) // a word with the spaces around it
  else for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size))
  const started = Date.now()
  let sent = ''
  for (const [index, piece] of pieces.entries()) {
    // a rate spaces the words by their due times, so a late timer does not slow the stream down
    if (rate > 0) await waitFor(Math.max(0, started + (index * 1000) / rate - Date.now()))
    else await (pace > 0 ? waitFor(pace) : tick()) // lets the stdin lines (an interrupt) be read between the pieces
    if (aborted) break
    sent += piece
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
  }
  stream({ type: 'content_block_stop', index: 0 })
  endMessage(id, [{ type: 'text', text: sent }], 'end_turn')
  turn.text += sent
  return aborted ? 'interrupted' : 'done'
}

// a tool call the model makes: its tool_use message; the caller sends the result
function emitToolUse(name: string, input: Record<string, unknown>): string {
  const id = startMessage()
  const toolId = `toolu_fake_${++seq}`
  const block = { type: 'tool_use', id: toolId, name, input, caller: { type: 'direct' } }
  stream({ type: 'content_block_start', index: 0, content_block: { ...block, input: {} } })
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
  stream({ type: 'content_block_stop', index: 0 })
  endMessage(id, [block], 'tool_use')
  return toolId
}

function emitToolResult(toolUseId: string, content: string, isError: boolean, decision?: 'accept' | 'deny', output?: unknown): void {
  const message = { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] }
  emit({
    type: 'user',
    message,
    parent_tool_use_id: null,
    session_id: session,
    uuid: randomUUID(),
    timestamp: stamp(),
    tool_use_result: isError ? content : output ?? { type: 'text', content },
    tool_result_meta: decision === undefined ? [] : [{ id: toolUseId, permission_decision: { decision, source: 'user_temporary' } }]
  })
  record('user', message)
}

async function toolStep(tool: { name: string; input: Record<string, unknown>; result: string; isError?: boolean; ms?: number; output?: unknown }): Promise<Outcome> {
  const toolId = emitToolUse(tool.name, tool.input)
  await waitFor(tool.ms ?? 0)
  if (aborted) return 'interrupted'
  emitToolResult(toolId, tool.result, tool.isError ?? false, undefined, tool.output)
  return 'done'
}

async function askStep(step: { ask: { tool: string; input: Record<string, unknown>; suggestions?: unknown[]; defaultToNo?: boolean }; allowed: FakeStep[]; denied: FakeStep[] }, turn: Turn): Promise<Outcome> {
  const { tool, input, suggestions } = step.ask
  // defaultToNo is never sent (the fixtures' finding d), so the stand-in does not send it either
  const toolId = emitToolUse(tool, input)
  emit(state('requires_action'))
  const requestId = `req_fake_${++seq}`
  const request: Msg = { subtype: 'can_use_tool', tool_name: tool, display_name: tool, input, tool_use_id: toolId }
  if (suggestions !== undefined) request.permission_suggestions = suggestions
  if (REQUIRES_INTERACTION.has(tool)) request.requires_user_interaction = true
  emit({ type: 'control_request', request_id: requestId, request })
  const response = await waitFor(undefined, requestId)
  if (aborted) return 'interrupted'
  emit(state('running'))
  if (response?.behavior === 'allow') {
    emitToolResult(toolId, 'ok', false, 'accept')
    return runSteps(step.allowed, turn)
  }
  const message = typeof response?.message === 'string' ? response.message : 'The user denied this tool.'
  emitToolResult(toolId, message, true, 'deny')
  turn.denials.push({ tool_name: tool, tool_use_id: toolId, tool_input: input })
  return runSteps(step.denied, turn)
}

// every ask at once: each request is sent before any is answered, then the step waits for all the answers, in any order.
// Each answer is logged as the other steps log theirs; the answers allow or deny their tools as askStep does
async function asksStep(asks: { tool: string; input: Record<string, unknown>; suggestions?: unknown[]; defaultToNo?: boolean }[], turn: Turn): Promise<Outcome> {
  const pending = asks.map(ask => ({ ask, toolId: emitToolUse(ask.tool, ask.input), requestId: `req_fake_${++seq}` }))
  emit(state('requires_action'))
  for (const { ask, toolId, requestId } of pending) {
    const request: Msg = { subtype: 'can_use_tool', tool_name: ask.tool, display_name: ask.tool, input: ask.input, tool_use_id: toolId }
    if (ask.suggestions !== undefined) request.permission_suggestions = ask.suggestions
    if (REQUIRES_INTERACTION.has(ask.tool)) request.requires_user_interaction = true
    // the SDK takes default_to_no from the request (sdk core.mjs); the real CLI does not send it (the fixtures' finding d)
    if (ask.defaultToNo === true) request.default_to_no = true
    emit({ type: 'control_request', request_id: requestId, request })
  }
  const responses = await Promise.all(pending.map(({ requestId }) => waitFor(undefined, requestId)))
  if (aborted) return 'interrupted'
  emit(state('running'))
  pending.forEach(({ ask, toolId }, i) => {
    const response = responses[i]
    logLine({ answer: { tool: ask.tool, response } })
    if (response?.behavior === 'allow') {
      emitToolResult(toolId, 'ok', false, 'accept')
      return
    }
    const message = typeof response?.message === 'string' ? response.message : 'The user denied this tool.'
    emitToolResult(toolId, message, true, 'deny')
    turn.denials.push({ tool_name: ask.tool, tool_use_id: toolId, tool_input: ask.input })
  })
  return 'done'
}

// a thinking block: its stream starts, Claude thinks for the step's time, the stream stops; the message carries the summary
async function thinkingStep(step: { thinking: string; ms: number }): Promise<Outcome> {
  const id = startMessage()
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  await waitFor(step.ms)
  stream({ type: 'content_block_stop', index: 0 })
  endMessage(id, [{ type: 'thinking', thinking: step.thinking }], 'end_turn')
  return aborted ? 'interrupted' : 'done'
}

// several tool calls the model makes in one message (parallel calls), as the recorded stream has them: one assistant line per
// tool_use block, all with the message id, the last one carrying the stop; the caller sends each call's result. Returns the ids.
function emitToolUses(calls: { name: string; input: Record<string, unknown> }[]): string[] {
  const id = startMessage()
  const blocks = calls.map((call) => ({ type: 'tool_use', id: `toolu_fake_${++seq}`, name: call.name, input: call.input, caller: { type: 'direct' } }))
  blocks.forEach((block, index) => {
    stream({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
    stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    stream({ type: 'content_block_stop', index })
  })
  blocks.forEach((block, index) => {
    const last = index === blocks.length - 1
    const message = {
      model: currentModel(),
      id,
      type: 'message',
      role: 'assistant',
      content: [block],
      container: null,
      stop_reason: last ? 'tool_use' : null,
      stop_sequence: null,
      stop_details: null,
      usage: USAGE,
      input_transformations: [],
      diagnostics: null,
      context_management: null
    }
    emit({ type: 'assistant', message, parent_tool_use_id: null, session_id: session, uuid: randomUUID(), timestamp: stamp(), request_id: `req_fake_${++seq}` })
    record('assistant', message)
  })
  stream({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: USAGE })
  stream({ type: 'message_stop' })
  return blocks.map((block) => block.id)
}

// A subagent's own tool call, as Claude Code passes it on by default (sdk.d.ts forwardSubagentText): an assistant message with
// parent_tool_use_id set to the Agent call and agent_id to its task id (SDKAssistantMessage), carrying the subagent's model and
// the usage of its API call, here all of it read from the cache
function subagentCall(toolId: string, taskId: string, type: string, description: string, work: { model: string; context: number }): void {
  const message = {
    model: work.model,
    id: `msg_fake_${++seq}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: `toolu_fake_${++seq}`, name: 'Grep', input: { pattern: 'total' }, caller: { type: 'direct' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: work.context, output_tokens: 0 }
  }
  emit({ type: 'assistant', message, parent_tool_use_id: toolId, agent_id: taskId, subagent_type: type, task_description: description, session_id: session, uuid: randomUUID(), timestamp: stamp() })
}

// Agent calls, one per subagent, in one assistant message (parallel calls, as Claude Code makes them). Each subagent is
// reported as the SDK reports it (SDKTaskStartedMessage, sdk.d.ts 6505; SDKTaskNotificationMessage, sdk.d.ts 6436): its
// task_started names its call in tool_use_id, and its task_notification comes at its ms. A call's result follows its end.
// The input is the SDK's AgentInput (sdk-tools.d.ts 763): description and prompt are required.
async function taskStep(step: { description: string; result: string; background?: true; agents: { type: string; description: string; ms: number; failed?: boolean; model?: string; effort?: string; work?: { model: string; context: number } }[] }): Promise<Outcome> {
  const toolIds = emitToolUses(step.agents.map((agent) => ({
    name: 'Agent',
    input: {
      description: agent.description, prompt: agent.description, subagent_type: agent.type,
      ...(agent.model === undefined ? {} : { model: agent.model }), ...(agent.effort === undefined ? {} : { effort: agent.effort })
    }
  })))
  const agents = step.agents.map((agent, i) => ({ agent, toolId: toolIds[i], taskId: `task_fake_${++seq}` }))
  for (const { agent, toolId, taskId } of agents) {
    emit(sys('task_started', { task_id: taskId, tool_use_id: toolId, description: agent.description, subagent_type: agent.type, task_type: 'local_agent' }))
    if (agent.work !== undefined) subagentCall(toolId, taskId, agent.type, agent.description, agent.work)
  }
  // a background agent: its call ends at once with the launch notice, and the agent ends at its ms, after the turn's result has gone
  if (step.background === true) {
    for (const { agent, toolId, taskId } of agents) {
      emitToolResult(toolId, 'Async agent launched successfully.', false)
      setTimeout(() => emit(sys('task_notification', { task_id: taskId, tool_use_id: toolId, status: 'completed', output_file: '', summary: agent.description, usage: { total_tokens: 0, tool_uses: 0, duration_ms: agent.ms } })), agent.ms)
    }
    return 'done'
  }
  let at = 0
  for (const entry of [...agents].sort((a, b) => a.agent.ms - b.agent.ms)) {
    await waitFor(Math.max(0, entry.agent.ms - at))
    at = Math.max(at, entry.agent.ms)
    if (aborted) return 'interrupted'
    const failed = entry.agent.failed === true
    emit(sys('task_notification', { task_id: entry.taskId, tool_use_id: entry.toolId, status: failed ? 'failed' : 'completed', output_file: '', summary: entry.agent.description, usage: { total_tokens: 0, tool_uses: 0, duration_ms: entry.agent.ms } }))
    emitToolResult(entry.toolId, failed ? 'The agent failed.' : step.result, failed)
  }
  return 'done'
}

async function runStep(step: FakeStep, turn: Turn): Promise<Outcome> {
  if ('text' in step) return streamText(step.text, step.chunks ?? 1, turn, step.pace ?? 0, step.rate ?? 0)
  if ('tool' in step) return toolStep(step.tool)
  if ('ask' in step) return askStep(step, turn)
  if ('asks' in step) return asksStep(step.asks, turn)
  if ('gate' in step) {
    // the turn waits here until the test writes the file: no timing decides when the next step starts
    while (!existsSync(join(configDir, step.gate)) && !aborted) await waitFor(20)
    return aborted ? 'interrupted' : 'done'
  }
  if ('command' in step) throw new Error('a command step is a local command turn of its own')
  if ('notAvailable' in step) {
    return streamText(`/${step.notAvailable.replace(/^\//, '')} isn't available in this environment.`, 1, turn)
  }
  if ('retry' in step) {
    emit(sys('api_retry', { attempt: step.retry.attempt, max_retries: step.retry.max, retry_delay_ms: step.retry.delayMs, error_status: null, error: 'overloaded' }))
    return 'done'
  }
  if ('error' in step) {
    turn.error = step.error
    return 'error'
  }
  if ('compact' in step) {
    const options: FakeCompact = typeof step.compact === 'object' ? step.compact : {}
    emit(sys('status', { status: 'compacting' }))
    // a gate holds the compaction until the test writes its file: the chat shows the compaction meanwhile
    while (options.gate !== undefined && !existsSync(join(configDir, options.gate)) && !aborted) await waitFor(20)
    if (aborted) return 'interrupted'
    if (options.fail !== undefined) {
      emit(sys('status', { status: null, compact_result: 'failed', compact_error: options.fail }))
      return 'done'
    }
    emit(sys('status', { status: null, compact_result: 'success' }))
    const metadata = {
      trigger: options.trigger ?? 'manual', pre_tokens: options.preTokens ?? 0,
      ...(options.postTokens === undefined ? {} : { post_tokens: options.postTokens }),
      ...(options.durationMs === undefined ? {} : { duration_ms: options.durationMs }),
    }
    emit(sys('compact_boundary', { compact_metadata: metadata }))
    return 'done'
  }
  if ('rateLimit' in step) {
    emitRateLimit(step.rateLimit)
    return 'done'
  }
  if ('thinking' in step) return thinkingStep(step)
  if ('task' in step) return taskStep(step.task)
  if ('fold' in step) {
    if (step.fold === 'result') {
      // the sends still waiting are taken into this turn: the turn's result names them, and no turn of their own runs them
      foldResult = readUuids.slice(readUuids.length - queue.length)
      queue.splice(0)
    } else {
      foldNext = [...readUuids]
    }
    return 'done'
  }
  if ('wait' in step) {
    await waitFor(step.wait)
    return aborted ? 'interrupted' : 'done'
  }
  if ('crash' in step) {
    if (step.once) {
      const marker = `${scriptFile ?? join(configDir, 'fake-claude')}.crashed-${createHash('sha1').update(JSON.stringify(step)).digest('hex').slice(0, 12)}`
      if (existsSync(marker)) return 'done'
      writeFileSync(marker, '')
    }
    exit(step.crash)
    return new Promise<never>(() => undefined) // the process ends in exit()
  }
  if ('inject' in step) {
    // a user-role message Claude Code writes into the stream itself: its origin is the SDK's, none when the step gives none
    emit({ type: 'user', message: { role: 'user', content: step.inject.text }, parent_tool_use_id: null, session_id: session, uuid: randomUUID(), timestamp: stamp(), ...(step.inject.origin === undefined ? {} : { origin: step.inject.origin }) })
    return 'done'
  }
  if ('noise' in step) {
    process.stdout.write(`${step.noise}\n`)
    return 'done'
  }
  if ('lingerMs' in step) {
    lingerMs = step.lingerMs
    return 'done'
  }
  if ('child' in step) {
    // a process Claude Code started (a command, a server): its command line carries the marker, and its pid is logged
    const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', step.child], { stdio: 'ignore' })
    proc.unref()
    logLine({ child: proc.pid })
    return 'done'
  }
  if ('dialog' in step) {
    const requestId = `req_fake_${++seq}`
    emit({ type: 'control_request', request_id: requestId, request: { subtype: 'request_user_dialog', dialog_kind: step.dialog, payload: {} } })
    await waitFor(undefined, requestId)
    return aborted ? 'interrupted' : 'done'
  }
  if ('cli' in step) return cliStep(step.cli)
  throw new Error(`unknown step in the script: ${JSON.stringify(step)}`)
}

async function runSteps(steps: FakeStep[], turn: Turn): Promise<Outcome> {
  for (const step of steps) {
    if (aborted) return 'interrupted'
    const outcome = await runStep(step, turn)
    if (outcome !== 'done') return outcome
  }
  return 'done'
}

// a line Claude Code answers itself (/config, /context): no model call, a <synthetic> assistant message, num_turns 0
async function runLocalTurn(step: { command: string; output: string }, text: string): Promise<void> {
  emit(state('running'))
  if (needInit) emitInit()
  record('user', { role: 'user', content: text })
  const command = step.command.replace(/^\//, '')
  const message = {
    id: randomUUID(),
    type: 'message',
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: step.output }],
    container: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: USAGE,
    diagnostics: null
  }
  emit({
    type: 'assistant',
    message,
    parent_tool_use_id: null,
    local_command_source: `<local-command-stdout>${step.output}</local-command-stdout>`,
    session_id: session,
    uuid: randomUUID(),
    timestamp: stamp(),
    local_command_run: { command, args: '' }
  })
  record('assistant', message)
  emit(resultMessage(templates.localResult, { is_error: false, subtype: 'success', num_turns: 0, stop_reason: null, local_command: command, result: step.output }))
  needInit = true
  if (queue.length === 0) emit(state('idle'))
}

// a command this environment does not have is answered by Claude Code itself, as a synthetic message with no model call. The
// wording is the stand-in's: no real answer was recorded (the fixtures' finding (f)), so only the shape is what the chat reads.
async function runUnavailableTurn(name: string, text: string): Promise<void> {
  emit(state('running'))
  if (needInit) emitInit()
  record('user', { role: 'user', content: text })
  const sentence = `/${name.replace(/^\//, '')} isn't available in this environment.`
  const message = {
    id: randomUUID(),
    type: 'message',
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: sentence }],
    container: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: USAGE,
    diagnostics: null
  }
  emit({ type: 'assistant', message, parent_tool_use_id: null, session_id: session, uuid: randomUUID(), timestamp: stamp(), request_id: `req_fake_${++seq}` })
  record('assistant', message)
  emit(resultMessage(templates.localResult, { is_error: false, subtype: 'success', num_turns: 0, stop_reason: null, local_command: name.replace(/^\//, ''), result: sentence }))
  needInit = true
  if (queue.length === 0) emit(state('idle'))
}

// a question of ClaudeTerm's Heads up (src/main/chat/heads-up.ts), known by how it starts: answered from the script's headsUp
function headsUpSteps(text: string): FakeStep[] | undefined {
  if (text.startsWith('Offered already, do not offer again:')) return [{ text: script.headsUp?.check ?? 'topic: none' }]
  if (text.startsWith('The card said (')) return [{ text: script.headsUp?.explain ?? '' }]
  return undefined
}

async function runTurn(text: string): Promise<void> {
  aborted = false
  const steps = headsUpSteps(text) ?? (Object.hasOwn(script.turns, text) ? script.turns[text] : script.fallback ?? [{ text: 'ok' }])
  if (steps.length === 1 && 'command' in steps[0]) return runLocalTurn(steps[0], text)
  if (steps.length === 1 && 'notAvailable' in steps[0]) return runUnavailableTurn(steps[0].notAvailable, text)
  emit(state('running'))
  if (needInit) emitInit()
  record('user', { role: 'user', content: text })
  emit(sys('status', { status: 'requesting' }))
  const turn: Turn = { text: '', denials: [] }
  const outcome = await runSteps(steps, turn)
  needInit = true
  if (outcome === 'interrupted') {
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: session, uuid: randomUUID(), timestamp: stamp() })
    emit(resultMessage(templates.interruptedResult, { subtype: 'error_during_execution', is_error: true, stop_reason: null, terminal_reason: 'aborted_streaming', errors: [INTERRUPTED_ERROR], permission_denials: turn.denials, api_error_status: null }))
  } else if (outcome === 'error') {
    emit(resultMessage(templates.interruptedResult, { subtype: 'error_during_execution', is_error: true, stop_reason: null, terminal_reason: 'error', errors: [turn.error], result: turn.error, permission_denials: turn.denials, api_error_status: null }))
  } else {
    emit(resultMessage(templates.result, { subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed', result: turn.text, permission_denials: turn.denials, api_error_status: null }))
  }
  if (queue.length === 0) emit(state('idle'))
}

// Claude Code answers initialize at once and sends no init: its init comes with the first turn (runTurn), as recorded.
// beforeInit steps run before the answer, so a step that exits leaves the engine not ready
async function initialize(requestId: string): Promise<void> {
  busy = true
  try {
    await runSteps(script.beforeInit ?? [], { text: '', denials: [] })
    reply(requestId, initializeReply())
    started = true
    busy = false
    void drain()
  } catch (error) {
    fail(error)
  }
}

// runs the queued messages one turn at a time; a message that arrives mid-turn waits for the turn's result
async function drain(): Promise<void> {
  if (busy) return
  busy = true
  try {
    while (started && queue.length > 0) await runTurn(queue.shift() as string)
  } catch (error) {
    fail(error)
  }
  busy = false
  if (ended && (!started || queue.length === 0)) exitWhenInputEnds()
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

function onControl(msg: Msg): void {
  const requestId = String(msg.request_id ?? '')
  const request: Msg = msg.request ?? {}
  switch (request.subtype) {
    case 'initialize':
      void initialize(requestId)
      return
    case 'interrupt':
      reply(requestId, recorded.get('interrupt') ?? { still_queued: [] })
      aborted = true
      for (const wake of [...waiting]) wake()
      return
    case 'set_permission_mode':
      reply(requestId, { mode: request.mode })
      return
    case 'set_model':
      reply(requestId, { model: request.model })
      return
    case 'apply_flag_settings':
      reply(requestId, {})
      return
    case 'mcp_status':
    case 'mcp_reconnect':
    case 'mcp_toggle':
      mcpControl(requestId, request)
      return
    case 'stop_task':
      reply(requestId, {})
      return
    case 'get_settings':
      // the effort Claude Code applies (appliedEffort): the one a host that the init does not tell reads from here
      reply(requestId, { effective: {}, sources: [], applied: script.appliedEffort === undefined ? {} : { effort: script.appliedEffort } })
      return
    case 'get_context_usage':
      // the fill the script gives (contextPct), in the recorded answer's shape
      const answer: Msg = { ...(recorded.get('get_context_usage') ?? {}), ...(script.contextPct === undefined ? {} : { percentage: script.contextPct }) }
      // a count the script gives as null is left out of the answer: a percentage-only answer
      if (script.contextTokens === null) delete answer.totalTokens
      else if (script.contextTokens !== undefined) answer.totalTokens = script.contextTokens
      if (script.contextMax === null) delete answer.maxTokens
      else if (script.contextMax !== undefined) answer.maxTokens = script.contextMax
      reply(requestId, answer)
      return
    default:
      if (recorded.has(request.subtype)) {
        reply(requestId, recorded.get(request.subtype) as Msg)
        return
      }
      emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `unsupported control request: ${String(request.subtype)}` } })
  }
}

function streamMode(): void {
  loadRecorded()
  mcpSession() // the MCP servers the session loads, as they are at its start
  const rl = createInterface({ input: process.stdin })
  rl.on('line', line => {
    let msg: Msg
    try {
      msg = JSON.parse(line) as Msg
    } catch {
      return // not a message
    }
    if (!msg || typeof msg !== 'object') return
    logLine({ in: msg })
    if (msg.type === 'control_request') onControl(msg)
    else if (msg.type === 'control_response') {
      const id = msg.response?.request_id
      if (typeof id === 'string') answers.get(id)?.(msg.response?.response)
    } else if (msg.type === 'user') {
      if (typeof msg.uuid === 'string') readUuids.push(msg.uuid)
      queue.push(contentText(msg.message?.content))
      void drain()
    }
  })
  rl.on('close', () => {
    ended = true
    void drain()
  })
}

// ---- the MCP servers, the plugins and the CLI (claude mcp …, claude plugin …) ----

type Scope = 'user' | 'local' | 'project'
type Market = NonNullable<FakeScript['marketplaces']>[number]
type Plugin = Market['plugins'][number]
type McpOptions = NonNullable<FakeScript['mcp']>[string]
interface CliResult { code: number; stdout: string; stderr: string }
interface CliCall { words: string[]; flags: Map<string, string>; scope?: Scope; values?: Record<string, string> | null }
interface McpServer { name: string; config: Msg; scope?: string; source: string }
interface SessionMcp { servers: McpServer[]; disabled: Set<string>; reconnected: Set<string>; startedAt: number }

let mcpState: SessionMcp | undefined

const claudeJsonFile = (): string => join(configDir, '.claude.json')
const settingsFile = (): string => join(configDir, 'settings.json')
const pluginsDir = (): string => join(configDir, 'plugins')
const installedFile = (): string => join(pluginsDir(), 'installed_plugins.json')
const marketsFile = (): string => join(pluginsDir(), 'known_marketplaces.json')
const optionsFile = (): string => join(pluginsDir(), 'fake-options.json')
const authFile = (): string => join(configDir, 'fake-mcp-auth.json')
const catalogFile = (market: string): string => join(pluginsDir(), 'marketplaces', market, '.claude-plugin', 'marketplace.json')
const cacheDir = (market: string, name: string, version: string): string => join(pluginsDir(), 'cache', market, name, version)

// a configuration file read as an object: {} when it is missing or is not one
function readJsonFile(file: string): Msg {
  if (!existsSync(file)) return {}
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Msg) : {}
  } catch {
    return {}
  }
}

// changes a configuration file in place: the keys it edits leave the others as they are
function editJson(file: string, edit: (value: Msg) => void): void {
  const value = readJsonFile(file)
  edit(value)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

// the key of this folder in .claude.json's projects: an existing key equal to its real path (case and slashes ignored), else the real path
function folderKey(config: Msg, folder: string): string {
  const real = realpathSync.native(folder)
  const fold = (path: string): string => path.replace(/\\/g, '/').toLowerCase()
  return Object.keys(config.projects ?? {}).find(key => fold(key) === fold(real)) ?? real
}

function isScope(value: string | undefined): value is Scope {
  return value === 'user' || value === 'local' || value === 'project'
}

// the servers a scope holds
function scopeServers(scope: Scope): Msg {
  if (scope === 'project') return readJsonFile(join(process.cwd(), '.mcp.json')).mcpServers ?? {}
  const config = readJsonFile(claudeJsonFile())
  if (scope === 'user') return config.mcpServers ?? {}
  return config.projects?.[folderKey(config, process.cwd())]?.mcpServers ?? {}
}

function saveScopeServers(scope: Scope, servers: Msg): void {
  if (scope === 'project') {
    editJson(join(process.cwd(), '.mcp.json'), value => { value.mcpServers = servers })
  } else if (scope === 'user') {
    editJson(claudeJsonFile(), value => { value.mcpServers = servers })
  } else {
    editJson(claudeJsonFile(), value => {
      const key = folderKey(value, process.cwd())
      value.projects = { ...(value.projects ?? {}), [key]: { ...(value.projects?.[key] ?? {}), mcpServers: servers } }
    })
  }
}

const out = (text: string): CliResult => ({ code: 0, stdout: `${text}\n`, stderr: '' })
const bad = (text: string): CliResult => ({ code: 1, stdout: '', stderr: `${text}\n` })

// the words of a CLI call and its options: options are read up to '--', everything after it is a word (commander takes both ways)
function parseCliArgs(args: string[]): { words: string[]; flags: Map<string, string> } {
  const words: string[] = []
  const flags = new Map<string, string>()
  let positional = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (positional) words.push(arg)
    else if (arg === '--') positional = true
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq >= 0) flags.set(arg.slice(0, eq), arg.slice(eq + 1))
      else if (arg === '--scope') flags.set(arg, args[++i] ?? '')
      else flags.set(arg, '')
    } else words.push(arg)
  }
  return { words, flags }
}

// the values --values-stdin reads: a JSON object of strings, or null
function parseValues(text: string): Record<string, string> | null {
  try {
    const value = JSON.parse(text) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return Object.values(value).every(v => typeof v === 'string') ? (value as Record<string, string>) : null
  } catch {
    return null
  }
}

// the stdin of a CLI call, read to its end
function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { text += chunk })
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(text))
  })
}

async function mcpCommand(verb: string | undefined, args: string[], call: CliCall): Promise<CliResult> {
  const [name, json] = args
  switch (verb) {
    case 'add-json': {
      let entry: unknown
      try {
        entry = JSON.parse(json ?? '')
      } catch {
        return bad('Invalid JSON')
      }
      if (name === undefined || entry === null || typeof entry !== 'object' || Array.isArray(entry)) return bad('Invalid JSON')
      const scope = call.scope ?? 'local'
      const servers = scopeServers(scope)
      if (Object.hasOwn(servers, name)) return bad(`MCP server ${name} already exists in ${scope} config`)
      saveScopeServers(scope, { ...servers, [name]: entry })
      return out(`Added ${(entry as Msg).type ?? 'stdio'} MCP server ${name} to ${scope} config`)
    }
    case 'remove': {
      const scopes: Scope[] = call.scope === undefined ? ['local', 'project', 'user'] : [call.scope]
      const from = scopes.find(scope => name !== undefined && Object.hasOwn(scopeServers(scope), name))
      if (from === undefined || name === undefined) return bad(`No MCP server found with name: ${name}`)
      const servers = { ...scopeServers(from) }
      delete servers[name]
      saveScopeServers(from, servers)
      return out(`Removed MCP server ${name} from ${from} config`)
    }
    case 'login': {
      if (name === undefined) return bad('Missing server name')
      const plan = script.mcpLogin?.[name]
      const gate = plan?.gate
      if (gate !== undefined) {
        await waitForGate(join(configDir, gate))
      }
      if (plan?.fail !== undefined) return bad(plan.fail)
      editJson(authFile(), value => { value[name] = true })
      return out('Authentication successful')
    }
    case 'logout': {
      if (name === undefined) return bad('Missing server name')
      editJson(authFile(), value => { delete value[name] })
      return out('Logged out')
    }
    default:
      return bad(`Unknown command: mcp ${verb ?? ''}`)
  }
}

function markets(): Market[] {
  return script.marketplaces ?? []
}

// the added marketplaces, as known_marketplaces.json keeps them
function knownMarkets(): Msg {
  return readJsonFile(marketsFile())
}

function writeCatalog(market: Market): void {
  editJson(catalogFile(market.name), value => {
    value.name = market.name
    value.plugins = market.plugins.map(plugin => ({ name: plugin.name, description: plugin.description, version: plugin.version }))
  })
}

// the plugin an id (name@market) or a bare name means, in an added marketplace
function findPlugin(ref: string): { market: string; plugin: Plugin } | undefined {
  const at = ref.indexOf('@')
  const name = at < 0 ? ref : ref.slice(0, at)
  const only = at < 0 ? undefined : ref.slice(at + 1)
  for (const market of Object.keys(knownMarkets())) {
    if (only !== undefined && market !== only) continue
    const plugin = markets().find(m => m.name === market)?.plugins.find(p => p.name === name)
    if (plugin !== undefined) return { market, plugin }
  }
  return undefined
}

function installedPlugins(): Msg {
  return readJsonFile(installedFile()).plugins ?? {}
}

function saveInstalled(edit: (plugins: Msg) => void): void {
  editJson(installedFile(), value => {
    const plugins: Msg = value.plugins ?? {}
    edit(plugins)
    value.version = 2
    value.plugins = plugins
  })
}

// the MCP servers a plugin installed at this folder ships (its .mcp.json)
function pluginServers(installPath: string): Msg {
  return readJsonFile(join(installPath, '.mcp.json')).mcpServers ?? {}
}

function writePluginServers(installPath: string, plugin: Plugin | undefined): void {
  editJson(join(installPath, '.mcp.json'), value => {
    value.mcpServers = Object.fromEntries((plugin?.mcpServers ?? []).map(name => [name, { command: 'fake-mcp', args: [name] }]))
  })
}

function installedList(): Msg[] {
  const enabled: Msg = readJsonFile(settingsFile()).enabledPlugins ?? {}
  return Object.entries(installedPlugins()).flatMap(([id, entries]) => (entries as Msg[]).map(entry => ({
    id,
    version: entry.version,
    scope: entry.scope,
    enabled: enabled[id] === true,
    installPath: entry.installPath,
    installedAt: entry.installedAt,
    lastUpdated: entry.lastUpdated,
    projectPath: entry.projectPath,
    mcpServers: Object.fromEntries(Object.keys(pluginServers(entry.installPath)).map(name => [name, {}]))
  })))
}

async function pluginCommand(verb: string | undefined, args: string[], call: CliCall): Promise<CliResult> {
  const [ref] = args
  switch (verb) {
    case 'marketplace':
      return marketplaceCommand(args[0], args.slice(1))
    case 'list': {
      const installed = installedList()
      if (!call.flags.has('--available')) return out(JSON.stringify(installed))
      const ids = new Set(installed.map(entry => String(entry.id)))
      const available = Object.keys(knownMarkets()).flatMap(market => ((readJsonFile(catalogFile(market)).plugins ?? []) as Msg[])
        .map(plugin => ({ pluginId: `${plugin.name}@${market}`, name: plugin.name, description: plugin.description, marketplaceName: market, version: plugin.version, source: 'fake', installCount: findPlugin(`${plugin.name}@${market}`)?.plugin.installs ?? 0 }))
        .filter(plugin => !ids.has(plugin.pluginId)))
      return out(JSON.stringify({ installed, available }))
    }
    case 'install': {
      const found = ref === undefined ? undefined : findPlugin(ref)
      if (found === undefined) return bad(`Plugin "${ref}" not found in any marketplace`)
      const { market, plugin } = found
      const id = `${plugin.name}@${market}`
      const version = plugin.installVersion ?? plugin.version
      const installPath = cacheDir(market, plugin.name, version)
      writePluginServers(installPath, plugin)
      const scope = call.scope ?? 'user'
      const now = new Date().toISOString()
      saveInstalled(plugins => {
        const others = ((plugins[id] ?? []) as Msg[]).filter(entry => entry.scope !== scope)
        plugins[id] = [...others, { scope, installPath, version, installedAt: now, lastUpdated: now, ...(scope === 'user' ? {} : { projectPath: process.cwd() }) }]
      })
      editJson(settingsFile(), value => { value.enabledPlugins = { ...(value.enabledPlugins ?? {}), [id]: true } })
      return out(`Successfully installed plugin: ${id}`)
    }
    case 'uninstall': {
      const id = ref ?? ''
      const entries = (installedPlugins()[id] ?? []) as Msg[]
      const removed = entries.filter(entry => call.scope === undefined || entry.scope === call.scope)
      if (removed.length === 0) return bad(`Plugin "${id}" is not installed`)
      const kept = entries.filter(entry => !removed.includes(entry))
      saveInstalled(plugins => {
        if (kept.length === 0) delete plugins[id]
        else plugins[id] = kept
      })
      if (kept.length === 0) editJson(settingsFile(), value => { if (value.enabledPlugins) delete value.enabledPlugins[id] })
      return out(`Successfully uninstalled plugin: ${id}`)
    }
    case 'enable':
    case 'disable': {
      const id = ref ?? ''
      if (!Object.hasOwn(installedPlugins(), id)) return bad(`Plugin "${id}" is not installed`)
      editJson(settingsFile(), value => { value.enabledPlugins = { ...(value.enabledPlugins ?? {}), [id]: verb === 'enable' } })
      return out(`Successfully ${verb}d plugin: ${id}`)
    }
    case 'update': {
      const id = ref ?? ''
      const [name = '', market = ''] = id.split('@')
      const entries = (installedPlugins()[id] ?? []) as Msg[]
      if (entries.length === 0) return bad(`Plugin "${id}" is not installed`)
      const catalog = ((readJsonFile(catalogFile(market)).plugins ?? []) as Msg[]).find(plugin => plugin.name === name)
      if (catalog === undefined) return bad(`Plugin "${id}" not found in any marketplace`)
      const version = String(catalog.version)
      if (entries.every(entry => entry.version === version)) return out(`Plugin "${id}" is already at version ${version}`)
      const installPath = cacheDir(market, name, version)
      writePluginServers(installPath, findPlugin(id)?.plugin)
      const now = new Date().toISOString()
      saveInstalled(plugins => {
        plugins[id] = entries.map(entry => ({ ...entry, version, installPath, lastUpdated: now }))
      })
      return out(`Successfully updated plugin: ${id} to version ${version}`)
    }
    case 'configure': {
      const found = ref === undefined ? undefined : findPlugin(ref)
      if (found === undefined) return bad(`Plugin "${ref}" not found`)
      const id = `${found.plugin.name}@${found.market}`
      const stored = (readJsonFile(optionsFile())[id] ?? []) as string[]
      if (call.flags.has('--values-stdin')) {
        if (call.values === null || call.values === undefined) return bad('Invalid JSON')
        const keys = Object.keys(call.values)
        editJson(optionsFile(), value => { value[id] = [...new Set([...stored, ...keys])] })
        return out(`Configured plugin: ${id}`)
      }
      if (call.flags.has('--json')) {
        const options = found.plugin.options ?? []
        return out(JSON.stringify({
          pluginId: id,
          displayName: found.plugin.name,
          schema: Object.fromEntries(options.map(option => [option.key, { type: 'string', title: option.title, description: option.description, required: option.required, sensitive: option.sensitive }])),
          configured: options.filter(option => stored.includes(option.key)).map(option => option.key),
          unconfigured: options.filter(option => !stored.includes(option.key)).map(option => option.key)
        }))
      }
      return bad('configure needs --json or --values-stdin')
    }
    default:
      return bad(`Unknown command: plugin ${verb ?? ''}`)
  }
}

async function marketplaceCommand(action: string | undefined, args: string[]): Promise<CliResult> {
  const known = knownMarkets()
  const name = args[0] ?? ''
  switch (action) {
    case 'add': {
      const market = markets().find(m => m.source === args[0])
      if (market === undefined) return bad(`Failed to add marketplace: no marketplace manifest found at ${args[0]}`)
      writeCatalog(market)
      editJson(marketsFile(), value => {
        value[market.name] = { source: { source: 'github', repo: market.source }, installLocation: join(pluginsDir(), 'marketplaces', market.name), lastUpdated: new Date().toISOString() }
      })
      return out(`Successfully added marketplace: ${market.name}`)
    }
    case 'remove': {
      if (!Object.hasOwn(known, name)) return bad(`Marketplace not found: ${name}`)
      editJson(marketsFile(), value => { delete value[name] })
      rmSync(join(pluginsDir(), 'marketplaces', name), { recursive: true, force: true })
      return out(`Successfully removed marketplace: ${name}`)
    }
    case 'update': {
      const names = args.length > 0 ? args : Object.keys(known)
      const lines: string[] = []
      for (const updated of names) {
        if (!Object.hasOwn(known, updated)) return bad(`Marketplace not found: ${updated}`)
        const market = markets().find(m => m.source === known[updated]?.source?.repo)
        if (market === undefined) return bad(`Failed to update marketplace: ${updated}`)
        writeCatalog(market)
        lines.push(`Successfully updated marketplace: ${updated}`)
      }
      return out(lines.join('\n'))
    }
    case 'list':
      return out(JSON.stringify(Object.entries(known).map(([market, value]) => ({ name: market, source: 'github', repo: value?.source?.repo, installLocation: value?.installLocation }))))
    default:
      return bad(`Unknown command: plugin marketplace ${action ?? ''}`)
  }
}

// a CLI call: its words and options are read, logged (the keys of --values-stdin, never its values), then answered: a cliFail
// first, then the subcommand
async function runCli(args: string[], input: () => Promise<string>): Promise<CliResult> {
  const { words, flags } = parseCliArgs(args)
  const values = flags.has('--values-stdin') ? parseValues(await input()) : undefined
  logLine({ cli: args, secretEnv: process.env.MCP_CLIENT_SECRET !== undefined, stdinKeys: values ? Object.keys(values) : null })
  const joined = args.filter(arg => arg !== '--').join(' ')
  const held = Object.entries(script.cliGate ?? {}).find(([key]) => joined.startsWith(key))
  if (held !== undefined) {
    await waitForGate(join(configDir, held[1]))
  }
  const failure = Object.entries(script.cliFail ?? {}).find(([key]) => joined.startsWith(key))
  if (failure !== undefined) return bad(failure[1])
  const scopeArg = flags.get('--scope')
  if (scopeArg !== undefined && !isScope(scopeArg)) return bad(`Invalid scope: ${scopeArg}`)
  const call: CliCall = { words, flags, scope: isScope(scopeArg) ? scopeArg : undefined, values }
  const [group, verb, ...rest] = words
  if (group === 'mcp') return mcpCommand(verb, rest, call)
  if (group === 'plugin') return pluginCommand(verb, rest, call)
  return bad(`Unknown command: ${joined}`)
}

// the CLI mode (argv starts with mcp or plugin): answers, prints and exits; the stdin is read for --values-stdin only
async function cliMode(): Promise<void> {
  try {
    const result = await runCli(argv, readStdin)
    process.stdout.write(result.stdout, () => process.stderr.write(result.stderr, () => exit(result.code)))
  } catch (error) {
    fail(error)
  }
}

// a CLI call the model makes with Bash: its tool_use, the CLI run in this process, then the result with its stdout
async function cliStep(args: string[]): Promise<Outcome> {
  const toolId = emitToolUse('Bash', { command: `claude ${args.join(' ')}` })
  const result = await runCli(args, async () => '')
  emitToolResult(toolId, result.stdout.trimEnd(), result.code !== 0)
  return 'done'
}

// the servers the session loads at its start, as Claude Code loads them: the user's, the folder's (local), the project's approved
// in .mcp.json, and those of the installed plugins that are enabled; the folder's disabledMcpServers switch some off
function loadSessionMcp(): SessionMcp {
  const cwd = process.cwd()
  const config = readJsonFile(claudeJsonFile())
  const settings = readJsonFile(settingsFile())
  const folder: Msg = config.projects?.[folderKey(config, cwd)] ?? {}
  // a server's config as Claude Code sends it: its type (stdio when none is written) and every field of its entry
  const serverConfig = (entry: unknown): Msg => ({ type: 'stdio', ...(entry as Msg) })
  const servers: McpServer[] = []
  for (const [name, entry] of Object.entries(config.mcpServers ?? {})) servers.push({ name, config: serverConfig(entry), scope: 'user', source: 'user' })
  for (const [name, entry] of Object.entries(folder.mcpServers ?? {})) servers.push({ name, config: serverConfig(entry), scope: 'local', source: 'local' })
  const approved = (name: string): boolean => {
    const all = folder.enableAllProjectMcpServers === true || settings.enableAllProjectMcpServers === true
    const enabled = [...(folder.enabledMcpjsonServers ?? []), ...(settings.enabledMcpjsonServers ?? [])]
    const disabled = [...(folder.disabledMcpjsonServers ?? []), ...(settings.disabledMcpjsonServers ?? [])]
    return (all || enabled.includes(name)) && !disabled.includes(name)
  }
  for (const [name, entry] of Object.entries(readJsonFile(join(cwd, '.mcp.json')).mcpServers ?? {})) {
    if (approved(name)) servers.push({ name, config: serverConfig(entry), scope: 'project', source: 'project' })
  }
  const enabledPlugins: Msg = settings.enabledPlugins ?? {}
  for (const [id, entries] of Object.entries(installedPlugins())) {
    const first = (entries as Msg[])[0]
    if (enabledPlugins[id] !== true || first === undefined) continue
    for (const [name, entry] of Object.entries(pluginServers(first.installPath))) {
      servers.push({ name: `plugin:${id.split('@')[0]}:${name}`, config: serverConfig(entry), source: 'plugin' })
    }
  }
  return { servers, disabled: new Set<string>(folder.disabledMcpServers ?? []), reconnected: new Set<string>(), startedAt: Date.now() }
}

// the session's MCP state: loaded at its start, changed by its control requests
function mcpSession(): SessionMcp {
  mcpState ??= loadSessionMcp()
  return mcpState
}

function loggedIn(name: string): boolean {
  return readJsonFile(authFile())[name] === true
}

// the status of each server the session loaded, from the script's options (every one connected with the tool ping by default)
function mcpStatuses(state: SessionMcp): Msg[] {
  return state.servers.map(server => {
    const options: McpOptions = script.mcp?.[server.name] ?? {}
    let status: string = options.status ?? 'connected'
    if (state.disabled.has(server.name)) status = 'disabled'
    else if (options.pendingMs !== undefined && Date.now() - state.startedAt < options.pendingMs) status = 'pending'
    else if (status === 'needs-auth' && state.reconnected.has(server.name)) status = 'connected'
    const connected = status === 'connected'
    return {
      name: server.name,
      status,
      ...(connected ? { serverInfo: { name: server.name, version: options.version ?? '1.0.0' }, tools: (options.tools ?? ['ping']).map(name => ({ name })) } : {}),
      ...(options.error === undefined ? {} : { error: options.error }),
      config: server.config,
      scope: server.scope,
      source: server.source
    }
  })
}

// the session's MCP requests: mcp_status lists its servers; mcp_reconnect brings a server that needs login up once it is logged in;
// mcp_toggle switches a server on or off, and the folder's disabledMcpServers keeps it. An unknown name is an error reply
function mcpControl(requestId: string, request: Msg): void {
  const state = mcpSession()
  if (request.subtype === 'mcp_status') {
    reply(requestId, { mcpServers: mcpStatuses(state) })
    return
  }
  const name = String(request.serverName ?? '')
  if (!state.servers.some(server => server.name === name)) {
    emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Server not found: ${name}` } })
    return
  }
  if (request.subtype === 'mcp_reconnect') {
    if (script.mcp?.[name]?.status === 'needs-auth' && loggedIn(name)) state.reconnected.add(name)
    reply(requestId, {})
    return
  }
  if (request.enabled === true) state.disabled.delete(name)
  else state.disabled.add(name)
  editJson(claudeJsonFile(), value => {
    const key = folderKey(value, process.cwd())
    value.projects = { ...(value.projects ?? {}), [key]: { ...(value.projects?.[key] ?? {}), disabledMcpServers: [...state.disabled] } }
  })
  reply(requestId, {})
}

// ---- start ----

logLine({ argv, pid: process.pid })

if (argv[0] === 'mcp' || argv[0] === 'plugin') {
  void cliMode()
} else if (has('--version')) {
  process.stdout.write(`${script.version ?? VERSION} (Claude Code)\n`)
  exit(0)
} else if (flag('--input-format') !== 'stream-json') {
  // the terminal view: no stream-json, echo each line; it takes the session lock like the chat view does
  takeLock()
  process.stdout.write(`fake-claude ${argv.join(' ')}\n`)
  // Claude Code's prompt, drawn between two rules as ClaudeTerm reads it: the handoff of a chat command waits for it to be empty
  const promptBlock = (): void => {
    const rule = '─'.repeat(40)
    process.stdout.write(`${rule}\n❯ \n${rule}\n`)
  }
  promptBlock()
  const rl = createInterface({ input: process.stdin })
  rl.on('line', line => {
    logLine({ in: line })
    process.stdout.write(`you said: ${line}\n`)
    promptBlock()
  })
  rl.on('close', () => exit(0))
} else {
  takeLock()
  streamMode()
}
