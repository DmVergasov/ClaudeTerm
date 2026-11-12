import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const file = join(config, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)
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
