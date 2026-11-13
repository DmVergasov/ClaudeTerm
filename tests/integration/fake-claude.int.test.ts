import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureLines } from '../fixtures/chat-fixtures'
import { installFakeClaude, type FakeScript } from '../fixtures/fake-claude/install'

// The stand-in Claude Code (tests/fixtures/fake-claude/fake-claude.ts) run as the installed command

type Msg = Record<string, any>

interface Run {
  child: ChildProcess
  out: Msg[]
  stdout: string
  stderr: string
  exit: Promise<number | null>
}

let dir: string
let work: string
let config: string
let log: string
let command: string
let scripts = 0
const runs: Run[] = []

const STREAM = ['--output-format', 'stream-json', '--input-format', 'stream-json']
const initLine = fixtureLines('answer', 'in')[0] as Msg

function user(text: string): Msg {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } }
}

function writeScript(script: FakeScript): string {
  const file = join(dir, `script-${++scripts}.json`)
  writeFileSync(file, JSON.stringify(script))
  return file
}

function env(script?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_LOG: log }
  delete result.FAKE_CLAUDE_SCRIPT
  if (script !== undefined) result.FAKE_CLAUDE_SCRIPT = script
  return result
}

// every process a test starts is tracked, so the cleanup stops it whatever the test did
function track(child: ChildProcess): Run {
  const run: Run = { child, out: [], stdout: '', stderr: '', exit: new Promise(resolve => child.once('exit', code => resolve(code))) }
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    run.stdout += chunk
    buffer += chunk
    let end = buffer.indexOf('\n')
    while (end >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        run.out.push(JSON.parse(line) as Msg)
      } catch {
        // a raw line that is not a message
      }
      end = buffer.indexOf('\n')
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    run.stderr += chunk
  })
  runs.push(run)
  return run
}

function start(args: string[], script?: FakeScript): Run {
  const file = script ? writeScript(script) : undefined
  return track(spawn(command, args, { cwd: work, env: env(file), shell: process.platform === 'win32', windowsHide: true }))
}

function send(run: Run, message: unknown): void {
  run.child.stdin?.write(JSON.stringify(message) + '\n')
}

const STAND_IN = resolve(import.meta.dirname, '..', 'fixtures', 'fake-claude', 'fake-claude.ts')

// a CLI call (claude mcp …, claude plugin …): node runs the stand-in file itself, so the arguments reach it as given
function cli(args: string[], script?: string, input = ''): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', STAND_IN, ...args], { cwd: work, env: env(script), input, encoding: 'utf8', windowsHide: true })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function readJson(file: string): Msg {
  return JSON.parse(readFileSync(file, 'utf8')) as Msg
}

function finish(run: Run): Promise<number | null> {
  run.child.stdin?.end()
  return run.exit
}

async function until(test: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function textOf(message: Msg): string {
  return (message.message?.content ?? []).filter((b: Msg) => b.type === 'text').map((b: Msg) => b.text).join('')
}

function logEntries(): Msg[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Msg)
}

function lockFile(id: string): string {
  return join(config, `fake-claude-${id}.lock`)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// on Windows the command is a cmd wrapper: taskkill /T ends the node process under it too
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  work = join(dir, 'work')
  config = join(dir, 'config')
  log = join(dir, 'fake-claude.log')
  mkdirSync(work, { recursive: true })
  mkdirSync(config, { recursive: true })
  command = installFakeClaude(join(dir, 'bin'))
})

afterEach(async () => {
  for (const run of runs.splice(0)) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) continue
    run.child.stdin?.end()
    const gone = await Promise.race([run.exit.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))])
    if (!gone) killTree(run.child)
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('the stand-in Claude Code', () => {
  it('--version names a Claude Code version', async () => {
    const run = start(['--version'])
    expect(await run.exit).toBe(0)
    expect(run.stdout).toMatch(/^2\.1\.322 \(Claude Code\)/)
  })

  it('answers initialize, and sends init only when a turn starts, as Claude Code does', async () => {
    const session = randomUUID()
    const run = start([...STREAM, '--session-id', session], { turns: { 'Say hi': [{ text: 'Hi' }] } })
    send(run, initLine)
    await until(() => run.out.length >= 1, 'the initialize reply')
    expect(run.out[0]).toMatchObject({ type: 'control_response', response: { request_id: initLine.request_id } })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(run.out.some(m => m.type === 'system' && m.subtype === 'init')).toBe(false)

    send(run, user('Say hi'))
    await until(() => run.out.some(m => m.type === 'result'), 'the result')
    const running = run.out.findIndex(m => m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'running')
    const init = run.out.findIndex(m => m.type === 'system' && m.subtype === 'init')
    expect(running).toBeGreaterThan(0)
    expect(init).toBeGreaterThan(running)
    expect(run.out[init]).toMatchObject({ session_id: session })
    await finish(run)
  })

  it('a beforeInit step runs before the initialize reply', async () => {
    const run = start([...STREAM, '--session-id', randomUUID()], { beforeInit: [{ crash: 5 }], turns: {} })
    send(run, initLine)
    expect(await run.exit).toBe(5)
    expect(run.out.some(m => m.type === 'control_response')).toBe(false)
  })

  it('a scripted turn streams text and ends with a result', async () => {
    const session = randomUUID()
    const run = start([...STREAM, '--session-id', session], { turns: { 'Say hi': [{ text: 'Hello there, friend.', chunks: 3 }] } })
    send(run, initLine)
    send(run, user('Say hi'))
    await until(() => run.out.some(m => m.type === 'result'), 'the result')
    const streamed = run.out
      .filter(m => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta')
      .map(m => m.event.delta.text)
      .join('')
    expect(streamed).toBe('Hello there, friend.')
    const assistant = run.out.find(m => m.type === 'assistant')
    expect(textOf(assistant as Msg)).toBe('Hello there, friend.')
    expect(run.out.find(m => m.type === 'result')).toMatchObject({ subtype: 'success', is_error: false, session_id: session })
    await finish(run)
  })

  it('an ask waits for the host\'s answer', async () => {
    const session = randomUUID()
    const script: FakeScript = {
      turns: {
        'Write it': [
          {
            ask: { tool: 'Write', input: { file_path: 'out.txt', content: 'fixture' } },
            allowed: [{ text: 'Written.' }],
            denied: [{ text: 'Not written.' }]
          }
        ]
      }
    }
    const run = start([...STREAM, '--session-id', session], script)
    send(run, initLine)
    send(run, user('Write it'))
    await until(() => run.out.some(m => m.type === 'control_request' && m.request?.subtype === 'can_use_tool'), 'the permission request')
    const request = run.out.find(m => m.request?.subtype === 'can_use_tool') as Msg
    expect(request.request).toMatchObject({ tool_name: 'Write', input: { file_path: 'out.txt', content: 'fixture' } })
    expect(run.out.some(m => m.type === 'result')).toBe(false)
    expect(run.out.some(m => m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'requires_action')).toBe(true)
    send(run, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: { behavior: 'allow', updatedInput: request.request.input, toolUseID: request.request.tool_use_id }
      }
    })
    await until(() => run.out.some(m => m.type === 'result'), 'the result')
    const states = run.out.filter(m => m.type === 'system' && m.subtype === 'session_state_changed').map(m => m.state)
    expect(states).toEqual(['running', 'requires_action', 'running', 'idle'])
    const texts = run.out.filter(m => m.type === 'assistant').map(textOf)
    expect(texts).toContain('Written.')
    expect(texts).not.toContain('Not written.')
    await finish(run)
  })

  it('crash exits with the code', async () => {
    const session = randomUUID()
    const run = start([...STREAM, '--session-id', session], { turns: { boom: [{ crash: 7 }] } })
    send(run, initLine)
    send(run, user('boom'))
    expect(await run.exit).toBe(7)
  })

  it('an unknown step kind fails the run with a message', async () => {
    const script = { turns: { odd: [{ bogus: true }] } } as unknown as FakeScript
    const run = start([...STREAM, '--session-id', randomUUID()], script)
    send(run, initLine)
    send(run, user('odd'))
    expect(await run.exit).not.toBe(0)
    expect(run.stderr).toContain('unknown step')
  })

  it('writes the transcript where Claude Code would', async () => {
    const session = randomUUID()
    const run = start([...STREAM, '--session-id', session], { turns: { 'Say hi': [{ text: 'Hello there' }] } })
    send(run, initLine)
    send(run, user('Say hi'))
    await until(() => run.out.some(m => m.type === 'result'), 'the result')
    await finish(run)
    const file = join(config, 'projects', realpathSync.native(work).replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Msg)
    expect(lines[0]).toMatchObject({ type: 'user', sessionId: session, entrypoint: 'sdk-ts', message: { content: 'Say hi' } })
    expect(lines[1]).toMatchObject({ type: 'assistant', sessionId: session, entrypoint: 'sdk-ts' })
    expect(textOf(lines[1] as Msg)).toBe('Hello there')
  })

  it('a command step is a local command turn as Claude Code sends it', async () => {
    const session = randomUUID()
    const output = 'Usage: /config key=value [key=value ...]'
    const run = start([...STREAM, '--session-id', session], { turns: { 'Say hi': [{ text: 'Hi' }], '/config': [{ command: 'config', output }] } })
    send(run, initLine)
    send(run, user('Say hi'))
    await until(() => run.out.filter(m => m.type === 'result').length === 1, 'the first result')
    send(run, user('/config'))
    await until(() => run.out.filter(m => m.type === 'result').length === 2, 'the local command result')
    // the /config turn: after the first turn's result, as the recording has it: running, init, the answer, the result
    const firstResult = run.out.findIndex(m => m.type === 'result')
    const turnStart = run.out.findIndex((m, index) => index > firstResult && m.subtype === 'session_state_changed' && m.state === 'running')
    const turnEnd = run.out.findIndex((m, index) => index > firstResult && m.type === 'result')
    const turn = run.out.slice(turnStart, turnEnd + 1)
    const types = turn.map(m => (m.type === 'system' ? `system/${m.subtype}` : m.type))
    expect(types).toEqual(['system/session_state_changed', 'system/init', 'assistant', 'result'])
    expect(turn.some(m => m.type === 'stream_event')).toBe(false)
    expect(turn.some(m => m.subtype === 'status' && m.status === 'requesting')).toBe(false)
    const localResult = run.out.filter(m => m.type === 'result')[1]
    const assistant = turn.find(m => m.type === 'assistant') as Msg
    expect(assistant).toMatchObject({
      message: { model: '<synthetic>', stop_reason: 'end_turn' },
      local_command_source: `<local-command-stdout>${output}</local-command-stdout>`,
      local_command_run: { command: 'config', args: '' }
    })
    expect(textOf(assistant)).toBe(output)
    expect(localResult).toMatchObject({ num_turns: 0, stop_reason: null, is_error: false, local_command: 'config', result: output })
    await finish(run)
  })

  it('each scripted step kind emits its message', async () => {
    const session = randomUUID()
    const script: FakeScript = {
      turns: {
        Everything: [
          { retry: { attempt: 1, max: 3, delayMs: 500 } },
          { notAvailable: 'review' },
          { compact: true },
          { dialog: 'trust' },
          { error: 'Something broke' }
        ]
      }
    }
    const run = start([...STREAM, '--session-id', session], script)
    send(run, initLine)
    send(run, user('Everything'))
    await until(() => run.out.some(m => m.type === 'control_request' && m.request?.subtype === 'request_user_dialog'), 'the dialog')
    const dialog = run.out.find(m => m.request?.subtype === 'request_user_dialog') as Msg
    expect(dialog.request).toMatchObject({ dialog_kind: 'trust' })
    send(run, { type: 'control_response', response: { subtype: 'success', request_id: dialog.request_id, response: {} } })
    await until(() => run.out.some(m => m.type === 'result'), 'the result')
    const at = (test: (m: Msg) => boolean): number => run.out.findIndex(test)
    const order = [
      at(m => m.type === 'system' && m.subtype === 'api_retry'),
      at(m => m.type === 'assistant' && textOf(m) === "/review isn't available in this environment."),
      at(m => m.type === 'system' && m.subtype === 'compact_boundary'),
      at(m => m.type === 'control_request' && m.request?.subtype === 'request_user_dialog'),
      at(m => m.type === 'result' && m.is_error === true)
    ]
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(run.out[order[0]]).toMatchObject({ attempt: 1, max_retries: 3, retry_delay_ms: 500 })
    expect(run.out[order[4]]).toMatchObject({ is_error: true, result: 'Something broke' })
    await finish(run)
  })

  it('result and assistant messages carry the fields the recorded ones carry', async () => {
    const session = randomUUID()
    const script: FakeScript = {
      turns: {
        'Say hi': [{ text: 'Hello there' }],
        'Write it': [{ ask: { tool: 'Write', input: { file_path: 'out.txt', content: 'fixture' } }, allowed: [{ text: 'Written.' }], denied: [] }],
        Count: [{ text: 'one two three', chunks: 3 }, { wait: 10_000 }],
        '/config': [{ command: 'config', output: 'Usage' }]
      }
    }
    const run = start([...STREAM, '--session-id', session], script)
    send(run, initLine)
    send(run, user('Say hi'))
    await until(() => run.out.filter(m => m.type === 'result').length === 1, 'the first result')
    send(run, user('Write it'))
    await until(() => run.out.some(m => m.request?.subtype === 'can_use_tool'), 'the permission request')
    const request = run.out.find(m => m.request?.subtype === 'can_use_tool') as Msg
    send(run, { type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { behavior: 'allow', updatedInput: request.request.input } } })
    await until(() => run.out.filter(m => m.type === 'result').length === 2, 'the second result')
    send(run, user('Count'))
    await until(() => run.out.some(m => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta' && run.out.filter(r => r.type === 'result').length === 2), 'the first text of the interrupted turn')
    send(run, { type: 'control_request', request_id: 'req_interrupt_test', request: { subtype: 'interrupt' } })
    await until(() => run.out.filter(m => m.type === 'result').length === 3, 'the interrupted result')
    send(run, user('/config'))
    await until(() => run.out.filter(m => m.type === 'result').length === 4, 'the local command result')
    await finish(run)

    const recorded = (name: string, pick: (m: Msg) => boolean): string[] => Object.keys((fixtureLines(name, 'out') as Msg[]).find(pick) as Msg)
    const results = run.out.filter(m => m.type === 'result')
    const missing = (keys: string[], message: Msg): string[] => keys.filter(key => !(key in message))
    expect(missing(recorded('answer', m => m.type === 'result'), results[0])).toEqual([])
    expect(missing(recorded('interrupt', m => m.type === 'result'), results[2])).toEqual([])
    expect(results[2]).toMatchObject({ is_error: true, terminal_reason: 'aborted_streaming', subtype: 'error_during_execution' })
    expect(missing(recorded('answer', m => m.type === 'assistant'), run.out.find(m => m.type === 'assistant') as Msg)).toEqual([])
    expect(missing(recorded('permission-allow', m => m.type === 'user' && Array.isArray(m.message?.content)), run.out.find(m => m.type === 'user' && Array.isArray(m.message?.content)) as Msg)).toEqual([])
    expect(missing(recorded('slash', m => m.local_command_run?.command === 'config'), run.out.find(m => m.local_command_source) as Msg)).toEqual([])
    expect(missing(recorded('slash', m => m.type === 'result' && m.local_command === 'config'), results[3])).toEqual([])
    for (const message of run.out.filter(m => m.type === 'assistant' || (m.type === 'user' && Array.isArray(m.message?.content)))) {
      expect(typeof message.timestamp).toBe('string')
    }
    expect(run.out.find(m => m.type === 'assistant' && typeof m.request_id === 'string')).toBeDefined()
    expect(run.out.find(m => m.type === 'user' && Array.isArray(m.message?.content) && m.message.content[0].type === 'tool_result')).toHaveProperty('tool_use_result')
  })

  it('two processes on one session id log an overlap', async () => {
    const session = randomUUID()
    const args = [...STREAM, '--resume', session]
    const first = start(args)
    await until(() => existsSync(lockFile(session)), 'the first lock')
    const second = start(args)
    await until(() => logEntries().filter(e => e.argv).length === 2, 'the second start')
    expect(await finish(second)).toBe(0)
    expect(logEntries()).toContainEqual({ overlap: session })
    expect(await finish(first)).toBe(0)
    expect(existsSync(lockFile(session))).toBe(false)
    const overlaps = logEntries().filter(e => e.overlap === session).length

    const third = start(args)
    await until(() => logEntries().filter(e => e.argv).length === 3, 'the third start')
    expect(await finish(third)).toBe(0)
    expect(logEntries().filter(e => e.overlap === session)).toHaveLength(overlaps)
    expect(existsSync(lockFile(session))).toBe(false)
  })

  it('a fork beside a live head logs no overlap', async () => {
    const session = randomUUID()
    const head = start([...STREAM, '--resume', session])
    await until(() => existsSync(lockFile(session)), 'the head lock')
    // a fork is a new session that starts from the head's: it does not hold the head's lock, so it overlaps nothing
    const fork = start([...STREAM, '--resume', session, '--fork-session'])
    await until(() => logEntries().filter(e => e.argv).length === 2, 'the fork start')
    expect(await finish(fork)).toBe(0)
    expect(logEntries().some(e => e.overlap !== undefined)).toBe(false)
    expect(await finish(head)).toBe(0)
  })

  it('a terminal start on a session a chat process holds logs an overlap', async () => {
    const session = randomUUID()
    const chat = start([...STREAM, '--resume', session])
    await until(() => existsSync(lockFile(session)), 'the chat lock')
    // the terminal view takes the same session lock, so a terminal beside a live chat process is seen
    const terminal = start(['--resume', session])
    await until(() => logEntries().filter(e => e.argv).length === 2, 'the terminal start')
    expect(await finish(terminal)).toBe(0)
    expect(logEntries()).toContainEqual({ overlap: session })
    expect(await finish(chat)).toBe(0)
  })

  it('the real SDK drives it: text, an allowed and a denied ask, an interrupt mid-answer', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const script: FakeScript = {
      turns: {
        'Say hi': [{ text: 'Hello there, friend.', chunks: 3 }],
        'Write allowed': [{ ask: { tool: 'Write', input: { file_path: 'allowed.txt', content: 'fixture' } }, allowed: [{ text: 'Written.' }], denied: [{ text: 'Not written.' }] }],
        'Write denied': [{ ask: { tool: 'Write', input: { file_path: 'denied.txt', content: 'fixture' } }, allowed: [{ text: 'Written.' }], denied: [{ text: 'Not written.' }] }],
        Count: [{ text: 'one two three four five six seven eight', chunks: 8 }, { wait: 10_000 }]
      }
    }
    const scriptFile = writeScript(script)
    const prompts: SDKUserMessage[] = ['Say hi', 'Write allowed', 'Write denied', 'Count'].map(text => ({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null
    }))
    let closed = false
    let wake: (() => void) | undefined
    async function* promptStream(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        const next = prompts.shift()
        if (next) yield next
        else if (closed) return
        else await new Promise<void>(resolve => (wake = resolve))
      }
    }
    const decisions: string[] = []
    const canUseTool = async (_tool: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      const allowed = input.file_path === 'allowed.txt'
      decisions.push(allowed ? 'allow' : 'deny')
      return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Not for this test.' }
    }

    const spawned: Run[] = []
    const q = query({
      prompt: promptStream(),
      options: {
        cwd: work,
        model: 'haiku',
        settingSources: [],
        includePartialMessages: true,
        canUseTool,
        spawnClaudeCodeProcess: options => {
          const child = spawn(command, options.args, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env, CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SCRIPT: scriptFile },
            shell: process.platform === 'win32',
            windowsHide: true
          })
          spawned.push(track(child))
          return child
        }
      }
    })

    const messages: Msg[] = []
    let results = 0
    let interrupted = false
    let thrown: Error | undefined
    try {
      for await (const message of q) {
        const msg = message as Msg
        messages.push(msg)
        if (msg.type === 'result') results++
        if (!interrupted && results === 3 && msg.type === 'stream_event' && msg.event?.delta?.type === 'text_delta') {
          interrupted = true
          await q.interrupt()
          // Count is the last prompt: ending the prompt stream lets the query end after its interrupted result
          closed = true
          wake?.()
        }
      }
    } catch (error) {
      thrown = error as Error
    }
    closed = true
    wake?.()

    // the interrupted turn ends the query: the SDK may throw its error result after the result message
    if (thrown !== undefined) expect(thrown.message).toContain('Claude Code returned an error result')
    expect(interrupted).toBe(true)
    expect(await spawned[0].exit).toBe(0)

    expect(messages.find(m => m.type === 'system' && m.subtype === 'init')).toBeDefined()
    const firstResult = messages.findIndex(m => m.type === 'result')
    const greeting = messages.slice(0, firstResult).filter(m => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta').map(m => m.event.delta.text).join('')
    expect(greeting).toBe('Hello there, friend.')

    expect(decisions).toEqual(['allow', 'deny'])
    const toolResults = messages
      .filter(m => m.type === 'user' && Array.isArray(m.message?.content) && m.message.content[0]?.type === 'tool_result')
      .map(m => m.message.content[0] as Msg)
    expect(toolResults.find(r => r.is_error === false)?.content).toBe('ok')
    expect(toolResults.find(r => r.is_error === true)?.content).toBe('Not for this test.')

    const lastResult = messages.filter(m => m.type === 'result').at(-1) as Msg
    expect(lastResult).toMatchObject({ is_error: true, terminal_reason: 'aborted_streaming' })
    expect(messages.some(m => m.type === 'user' && JSON.stringify(m.message?.content).includes('[Request interrupted by user]'))).toBe(true)
  }, 60_000)

  it('getSessionMessages reads the stand-in\'s transcript whole', async () => {
    const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
    const session = randomUUID()
    const first = start([...STREAM, '--session-id', session], { turns: { 'Say hi': [{ text: 'Hello there' }] } })
    send(first, initLine)
    send(first, user('Say hi'))
    await until(() => first.out.some(m => m.type === 'result'), 'the result')
    await finish(first)

    // a resumed conversation continues the same transcript file
    const resumed = start([...STREAM, '--resume', session])
    send(resumed, initLine)
    send(resumed, user('Say again'))
    await until(() => resumed.out.some(m => m.type === 'result'), 'the resumed result')
    await finish(resumed)

    // the SDK reads the transcript from the config folder of its environment
    const before = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = config
    try {
      const messages = await getSessionMessages(session, { dir: work })
      expect(messages.map(m => m.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = before
    }
  })
})

describe('the stand-in\'s claude mcp, claude plugin and the session\'s MCP requests', () => {
  const MARKET: FakeScript['marketplaces'] = [{
    name: 'fake-tools',
    source: 'acme/fake-tools',
    plugins: [{
      name: 'fake-docs',
      description: 'Docs for the fake project',
      version: '1.2.0',
      installs: 7,
      mcpServers: ['docs'],
      options: [{ key: 'API_TOKEN', title: 'API token', description: 'Token for the docs API', required: true, sensitive: true }]
    }]
  }]

  it('claude mcp add-json writes the server where Claude Code keeps it, per scope', () => {
    writeFileSync(join(config, '.claude.json'), JSON.stringify({ numStartups: 3 }))
    expect(cli(['mcp', 'add-json', '--scope', 'user', '--', 'docs', '{"type":"http","url":"https://docs.example/mcp"}'])).toMatchObject({ code: 0, stdout: 'Added http MCP server docs to user config\n' })
    expect(cli(['mcp', 'add-json', '--', 'tool', '{"command":"node","args":["tool.js"]}'])).toMatchObject({ code: 0, stdout: 'Added stdio MCP server tool to local config\n' })
    expect(cli(['mcp', 'add-json', '--scope', 'project', '--', 'repo', '{"command":"npx","args":["repo-mcp"]}'])).toMatchObject({ code: 0, stdout: 'Added stdio MCP server repo to project config\n' })

    const claudeJson = readJson(join(config, '.claude.json'))
    expect(claudeJson.numStartups).toBe(3)
    expect(claudeJson.mcpServers).toEqual({ docs: { type: 'http', url: 'https://docs.example/mcp' } })
    expect(claudeJson.projects[realpathSync.native(work)].mcpServers).toEqual({ tool: { command: 'node', args: ['tool.js'] } })
    expect(readJson(join(work, '.mcp.json')).mcpServers).toEqual({ repo: { command: 'npx', args: ['repo-mcp'] } })
    expect(cli(['mcp', 'add-json', '--scope', 'user', '--', 'docs', '{"command":"node"}'])).toMatchObject({ code: 1, stderr: 'MCP server docs already exists in user config\n' })
    expect(cli(['mcp', 'add-json', '--', 'bad', '{not json'])).toMatchObject({ code: 1, stderr: 'Invalid JSON\n' })
  })

  it('claude mcp remove takes it out, and an unknown name fails with its message', () => {
    cli(['mcp', 'add-json', '--scope', 'user', '--', 'docs', '{"type":"http","url":"https://docs.example/mcp"}'])
    expect(cli(['mcp', 'remove', '--scope', 'user', '--', 'docs'])).toMatchObject({ code: 0 })
    expect(readJson(join(config, '.claude.json')).mcpServers).toEqual({})
    expect(cli(['mcp', 'remove', '--', 'docs'])).toMatchObject({ code: 1, stderr: 'No MCP server found with name: docs\n' })
  })

  it('claude mcp login waits for its gate; a scripted failure exits 1 with the message', async () => {
    const login = start(['mcp', 'login', '--', 'sentry'], { turns: {}, mcpLogin: { sentry: { gate: 'release-login.txt' } } })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(login.child.exitCode).toBeNull()
    writeFileSync(join(config, 'release-login.txt'), '')
    expect(await login.exit).toBe(0)
    expect(login.stdout).toBe('Authentication successful\n')
    expect(readJson(join(config, 'fake-mcp-auth.json'))).toEqual({ sentry: true })

    const broken = start(['mcp', 'login', '--', 'broken'], { turns: {}, mcpLogin: { broken: { fail: 'Invalid client secret' } } })
    expect(await broken.exit).toBe(1)
    expect(broken.stderr).toContain('Invalid client secret')
  })

  it('a stand-in whose parent is killed exits by itself, so a gate that never opens cannot orphan it', async () => {
    // a parent process starts `claude mcp login` (its gate never opens) and is killed: the stand-in must end on its own
    const file = writeScript({ turns: {}, mcpLogin: { sentry: { gate: 'never-released.txt' } } })
    const args = ['--experimental-strip-types', '--no-warnings', STAND_IN, 'mcp', 'login', '--', 'sentry']
    const parentCode = "const { spawn } = require('node:child_process'); spawn(process.execPath, JSON.parse(process.argv[1]), { stdio: 'ignore', windowsHide: true }); setInterval(() => {}, 1000)"
    const parent = track(spawn(process.execPath, ['-e', parentCode, JSON.stringify(args)], { cwd: work, env: env(file), stdio: 'ignore', windowsHide: true }))
    const started = (): Msg | undefined => logEntries().find(entry => Array.isArray(entry.argv) && entry.argv.includes('login'))
    await until(() => started() !== undefined, 'the stand-in to start its login')
    const pid = started()?.pid as number
    try {
      parent.child.kill('SIGKILL')
      // it ends by its own exit (logged) or is gone; a process that is only a zombie still answers to a signal 0, so the log counts too
      await until(() => logEntries().some(entry => entry.exit !== undefined && entry.pid === pid) || !processExists(pid), 'the stand-in to exit after its parent', 10_000)
    } finally {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    }
  })

  it('plugin marketplace add, install, list --json and configure answer as Claude Code does', () => {
    const script = writeScript({ turns: {}, marketplaces: MARKET })
    expect(cli(['plugin', 'marketplace', 'add', '--', 'acme/fake-tools'], script)).toMatchObject({ code: 0, stdout: 'Successfully added marketplace: fake-tools\n' })
    expect(cli(['plugin', 'install', '--', 'fake-docs@fake-tools'], script)).toMatchObject({ code: 0 })

    expect(readJson(join(config, 'plugins', 'installed_plugins.json'))).toMatchObject({ version: 2, plugins: { 'fake-docs@fake-tools': [{ scope: 'user', version: '1.2.0' }] } })
    expect(readJson(join(config, 'settings.json'))).toEqual({ enabledPlugins: { 'fake-docs@fake-tools': true } })
    const list = JSON.parse(cli(['plugin', 'list', '--json'], script).stdout) as Msg[]
    expect(list).toEqual([{
      id: 'fake-docs@fake-tools', version: '1.2.0', scope: 'user', enabled: true, installPath: expect.any(String),
      installedAt: expect.any(String), lastUpdated: expect.any(String), mcpServers: { docs: {} }
    }])

    const before = JSON.parse(cli(['plugin', 'configure', '--json', '--', 'fake-docs@fake-tools'], script).stdout) as Msg
    expect(before).toMatchObject({
      pluginId: 'fake-docs@fake-tools',
      schema: { API_TOKEN: { type: 'string', title: 'API token', description: 'Token for the docs API', required: true, sensitive: true } },
      configured: [],
      unconfigured: ['API_TOKEN']
    })
    expect(cli(['plugin', 'configure', '--values-stdin', '--', 'fake-docs@fake-tools'], script, JSON.stringify({ API_TOKEN: 's3cret-value' }))).toMatchObject({ code: 0 })
    const calls = logEntries().filter(entry => Array.isArray(entry.cli))
    expect(calls.at(-1)).toMatchObject({ stdinKeys: ['API_TOKEN'], secretEnv: false })
    expect(readFileSync(log, 'utf8')).not.toContain('s3cret-value')
    expect(JSON.parse(cli(['plugin', 'configure', '--json', '--', 'fake-docs@fake-tools'], script).stdout)).toMatchObject({ configured: ['API_TOKEN'], unconfigured: [] })
  })

  it('cliFail fails a matching call with its message', () => {
    const script = writeScript({ turns: {}, marketplaces: MARKET, cliFail: { 'plugin install': 'Network unreachable' } })
    expect(cli(['plugin', 'install', '--scope', 'user', '--', 'fake-docs@fake-tools'], script)).toMatchObject({ code: 1, stderr: 'Network unreachable\n' })
    expect(cli(['plugin', 'list', '--json'], script)).toMatchObject({ code: 0 })
  })

  it('mcp_status lists what the session loaded with the scripted statuses; mcp_reconnect and mcp_toggle change them', async () => {
    const real = realpathSync.native(work)
    writeFileSync(join(config, '.claude.json'), JSON.stringify({
      mcpServers: {
        docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer t' } },
        sentry: { type: 'http', url: 'https://sentry.example/mcp' },
        flaky: { command: 'node', args: ['flaky.js'] },
        slow: { command: 'node', args: ['slow.js'] }
      },
      projects: { [real]: { mcpServers: { tool: { command: 'node', args: ['tool.js'] } }, enabledMcpjsonServers: ['repo'] } }
    }))
    writeFileSync(join(work, '.mcp.json'), JSON.stringify({ mcpServers: { repo: { command: 'npx', args: ['repo-mcp'] }, unapproved: { command: 'npx', args: ['x'] } } }))
    const script: FakeScript = {
      turns: {},
      mcp: { sentry: { status: 'needs-auth' }, flaky: { status: 'failed', error: 'spawn node ENOENT' }, slow: { pendingMs: 60_000 } },
      mcpLogin: {}
    }
    const scriptFile = writeScript(script)
    const run = start([...STREAM, '--session-id', randomUUID()], script)
    send(run, initLine)
    await until(() => run.out.some(m => m.type === 'control_response'), 'the initialize reply')

    const answer = async (request: Msg): Promise<Msg> => {
      const id = `req_${randomUUID()}`
      send(run, { type: 'control_request', request_id: id, request })
      await until(() => run.out.some(m => m.type === 'control_response' && m.response?.request_id === id), `the answer to ${request.subtype}`)
      return run.out.find(m => m.type === 'control_response' && m.response?.request_id === id)!.response as Msg
    }
    const statuses = async (): Promise<Record<string, Msg>> => {
      const reply = await answer({ subtype: 'mcp_status' })
      return Object.fromEntries((reply.response.mcpServers as Msg[]).map(server => [server.name, server]))
    }

    const first = await statuses()
    expect(Object.keys(first).sort()).toEqual(['docs', 'flaky', 'repo', 'sentry', 'slow', 'tool'])
    expect(first.docs).toMatchObject({
      status: 'connected', scope: 'user', source: 'user', serverInfo: { name: 'docs', version: '1.0.0' }, tools: [{ name: 'ping' }],
      config: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer t' } }
    })
    expect(first.tool).toMatchObject({ status: 'connected', scope: 'local', source: 'local' })
    expect(first.repo).toMatchObject({ status: 'connected', scope: 'project', source: 'project' })
    expect(first.sentry.status).toBe('needs-auth')
    expect(first.flaky).toMatchObject({ status: 'failed', error: 'spawn node ENOENT' })
    expect(first.slow.status).toBe('pending')

    // a reconnect of a server that needs login does nothing until the login is stored
    expect(await answer({ subtype: 'mcp_reconnect', serverName: 'sentry' })).toMatchObject({ subtype: 'success', response: {} })
    expect((await statuses()).sentry.status).toBe('needs-auth')
    expect(await answer({ subtype: 'mcp_reconnect', serverName: 'nope' })).toMatchObject({ subtype: 'error', error: 'Server not found: nope' })
    expect(cli(['mcp', 'login', '--', 'sentry'], scriptFile)).toMatchObject({ code: 0 })
    await answer({ subtype: 'mcp_reconnect', serverName: 'sentry' })
    expect((await statuses()).sentry.status).toBe('connected')

    expect(await answer({ subtype: 'mcp_toggle', serverName: 'docs', enabled: false })).toMatchObject({ subtype: 'success' })
    expect((await statuses()).docs.status).toBe('disabled')
    expect(readJson(join(config, '.claude.json')).projects[real].disabledMcpServers).toEqual(['docs'])
    await answer({ subtype: 'mcp_toggle', serverName: 'docs', enabled: true })
    expect((await statuses()).docs.status).toBe('connected')
    expect(readJson(join(config, '.claude.json')).projects[real].disabledMcpServers).toEqual([])
    await finish(run)
  })

  it('a cli step is a Bash call whose result is the CLI\'s output', async () => {
    const args = ['mcp', 'add-json', '--scope', 'user', '--', 'docs', '{"type":"http","url":"https://docs.example/mcp"}']
    const run = start([...STREAM, '--session-id', randomUUID()], { turns: { 'Add docs': [{ cli: args }, { text: 'Added.' }] } })
    send(run, initLine)
    send(run, user('Add docs'))
    await until(() => run.out.some(m => m.type === 'result'), 'the result')
    const call = run.out.find(m => m.type === 'assistant' && m.message?.content?.[0]?.type === 'tool_use')!.message.content[0] as Msg
    expect(call).toMatchObject({ name: 'Bash', input: { command: `claude ${args.join(' ')}` } })
    const result = run.out.find(m => m.type === 'user' && m.message?.content?.[0]?.type === 'tool_result')!.message.content[0] as Msg
    expect(result).toMatchObject({ tool_use_id: call.id, content: 'Added http MCP server docs to user config', is_error: false })
    expect(readJson(join(config, '.claude.json')).mcpServers).toEqual({ docs: { type: 'http', url: 'https://docs.example/mcp' } })
    await finish(run)
  })
})
