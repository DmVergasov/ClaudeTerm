import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathKey } from '../../src/main/path-key'
import type { PermissionAsk, SdkPermissionResult } from '../../src/main/chat/chat-cards'
import type { ChatEngine, ChatEngineHandlers, ChatEngineStart } from '../../src/main/chat/chat-engine'
import { resolveChatLaunch, type ChatLaunch } from '../../src/main/chat/claude-spawn'
import { startSdkEngine } from '../../src/main/chat/sdk-engine'
import { installFakeClaude, type FakeScript } from '../fixtures/fake-claude/install'

// every process the engine starts goes through spawnChatProcess: the spy records which file it was given
const spawnedFiles = vi.hoisted(() => [] as string[])
vi.mock('../../src/main/chat/claude-spawn', async original => {
  const actual = await original<typeof import('../../src/main/chat/claude-spawn')>()
  return {
    ...actual,
    spawnChatProcess: (launch: Exclude<ChatLaunch, { how: 'none' }>, args: string[], cwd: string, env: Record<string, string | undefined>) => {
      spawnedFiles.push(launch.how === 'shell' ? launch.shell : launch.file)
      return actual.spawnChatProcess(launch, args, cwd, env)
    }
  }
})

// The SDK engine (sdk-engine.ts) driving the stand-in Claude Code (tests/fixtures/fake-claude) through the real query()

type Msg = Record<string, any>

interface Harness extends ChatEngineHandlers {
  messages: Msg[]
  asks: Omit<PermissionAsk, 'folder'>[]
  exits: (number | null)[]
  errors: string[]
  readies: { permissionMode: string | null }[]
}

let dir: string
let work: string
let config: string
let command: string
let launch: Exclude<ChatLaunch, { how: 'none' }>
let scripts = 0
const engines: { engine: ChatEngine; h: Harness }[] = []

function harness(decide: (ask: Omit<PermissionAsk, 'folder'>) => SdkPermissionResult = ask => ({ behavior: 'allow', updatedInput: ask.input })): Harness {
  const h: Harness = {
    messages: [],
    asks: [],
    exits: [],
    errors: [],
    readies: [],
    message: m => {
      h.messages.push(m as Msg)
    },
    ask: async ask => {
      h.asks.push(ask)
      return decide(ask)
    },
    dialog: () => undefined,
    ready: info => {
      h.readies.push(info)
    },
    stderr: text => {
      h.errors.push(text)
    },
    exit: code => {
      h.exits.push(code)
    }
  }
  return h
}

function writeScript(script: FakeScript): string {
  const file = join(dir, `script-${++scripts}.json`)
  writeFileSync(file, JSON.stringify(script))
  return file
}

function env(log: string, script?: string): Record<string, string> {
  const result: Record<string, string> = { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_LOG: log }
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('FAKE_CLAUDE_') && !key.startsWith('CLAUDE')) result[key] = value
  result.CLAUDE_CONFIG_DIR = config
  result.FAKE_CLAUDE_LOG = log
  if (script !== undefined) result.FAKE_CLAUDE_SCRIPT = script
  return result
}

function start(h: Harness, o: { script?: FakeScript; settingsPath?: string | null; sessionId?: string | null; newSessionId?: string; fork?: boolean; log?: string } = {}): ChatEngine {
  const log = o.log ?? join(dir, 'fake-claude.log')
  const options: ChatEngineStart = {
    launch,
    cwd: work,
    env: env(log, o.script === undefined ? undefined : writeScript(o.script)),
    settingsPath: o.settingsPath ?? null,
    sessionId: o.sessionId ?? null,
    newSessionId: o.newSessionId ?? randomUUID(),
    fork: o.fork ?? false
  }
  const engine = startSdkEngine(options, h)
  engines.push({ engine, h })
  return engine
}

async function until(test: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function results(h: Harness): Msg[] {
  return h.messages.filter(m => m.type === 'result')
}

function isTextDelta(m: Msg): boolean {
  return m.type === 'stream_event' && m.event?.delta?.type === 'text_delta'
}

function logEntries(log: string): Msg[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Msg)
}

// the arguments of each start of the stand-in, in order
function startedArgs(log: string): string[][] {
  return logEntries(log).filter(e => Array.isArray(e.argv)).map(e => e.argv as string[])
}

// the value of a flag, written as `--flag value` or `--flag=value`
function flagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1)
  }
  return undefined
}

function controlRequests(log: string, subtype: string): Msg[] {
  return logEntries(log).filter(e => e.in?.type === 'control_request' && e.in.request?.subtype === subtype).map(e => e.in.request as Msg)
}

// ends the engine and waits until its exit came, so no test leaves a process behind
async function stop(engine: ChatEngine, h: Harness): Promise<void> {
  if (h.exits.length === 0) {
    engine.kill()
    await until(() => h.exits.length > 0, 'the exit after kill', 5_000).catch(() => undefined)
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sdk-engine-'))
  work = join(dir, 'work')
  config = join(dir, 'config')
  mkdirSync(work, { recursive: true })
  mkdirSync(config, { recursive: true })
  command = installFakeClaude(join(dir, 'bin'))
  const resolved = await resolveChatLaunch(command, {
    platform: process.platform,
    isFile: p => existsSync(p),
    isExecutable: p => existsSync(p),
    where: async () => [],
    loginShell: () => '/bin/sh'
  })
  if (resolved.how === 'none') throw new Error(resolved.reason)
  launch = resolved
})

afterEach(async () => {
  for (const { engine, h } of engines.splice(0)) await stop(engine, h)
  rmSync(dir, { recursive: true, force: true })
})

describe('the SDK engine', () => {
  it("starts the user's command, not the SDK's binary", async () => {
    const h = harness()
    const log = join(dir, 'fake-claude.log')
    spawnedFiles.length = 0
    const engine = start(h, { log })
    await until(() => startedArgs(log).length === 1, 'the stand-in start')
    // the file given to spawnChatProcess is the user's command, and the stand-in (not the SDK binary) answered
    expect(spawnedFiles).toHaveLength(1)
    expect(pathKey(spawnedFiles[0])).toBe(pathKey(command))
    expect(spawnedFiles[0]).not.toContain('claude-agent-sdk')
    expect(startedArgs(log)[0]).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--input-format', 'stream-json']))
    await stop(engine, h)
  })

  it('a sent message streams back and the turn ends', async () => {
    const h = harness()
    const engine = start(h, { script: { turns: { 'Say hi': [{ text: 'Hello there, friend.', chunks: 3 }] } } })
    engine.send('Say hi', [], 'send-uuid')
    await until(() => results(h).length === 1, 'the result')
    const types = h.messages.map(m => (m.type === 'system' ? `system/${m.subtype}` : m.type))
    expect(types).toContain('system/init')
    expect(h.messages.some(isTextDelta)).toBe(true)
    expect(types).toContain('assistant')
    expect(results(h)[0]).toMatchObject({ is_error: false, terminal_reason: 'completed' })
    expect(h.exits).toEqual([])
    await stop(engine, h)
  })

  it('an ask reaches the handler and its answer reaches Claude Code', async () => {
    const h = harness(ask => ({ behavior: 'allow', updatedInput: ask.input }))
    const engine = start(h, {
      script: {
        turns: {
          'Write it': [{ ask: { tool: 'Write', input: { file_path: 'out.txt', content: 'fixture' } }, allowed: [{ text: 'Written.' }], denied: [{ text: 'Not written.' }] }]
        }
      }
    })
    engine.send('Write it', [], 'send-uuid')
    await until(() => results(h).length === 1, 'the result')
    expect(h.asks).toHaveLength(1)
    expect(h.asks[0]).toMatchObject({ toolName: 'Write', input: { file_path: 'out.txt', content: 'fixture' } })
    const text = h.messages.filter(m => m.type === 'assistant').flatMap(m => m.message.content as Msg[]).map(b => b.text ?? '').join('')
    expect(text).toContain('Written.')
    expect(text).not.toContain('Not written.')
    await stop(engine, h)
  }, 30_000)

  it('interrupt ends the turn', async () => {
    const h = harness()
    const engine = start(h, {
      script: {
        turns: {
          Count: [{ text: 'one two three four five six seven eight', chunks: 8 }, { wait: 10_000 }],
          Again: [{ text: 'Second answer.' }]
        }
      }
    })
    engine.send('Count', [], 'send-uuid')
    await until(() => h.messages.some(isTextDelta), 'the first text')
    await engine.interrupt()
    await until(() => results(h).some(r => r.terminal_reason === 'aborted_streaming'), 'the interrupted result')
    // an interrupt is not an exit: the query goes on, and the next message gets its own result
    expect(h.exits).toEqual([])

    engine.send('Again', [], 'send-uuid')
    await until(() => results(h).length === 2, 'the result after the interrupt')
    expect(results(h)[1]).toMatchObject({ is_error: false, terminal_reason: 'completed', result: 'Second answer.' })
    expect(h.exits).toEqual([])
    await stop(engine, h)
  }, 60_000)

  it('close settles an ask still pending in the handler', async () => {
    const h = harness()
    let signalAborted = false
    h.ask = (ask, signal) =>
      new Promise(resolve => {
        h.asks.push(ask)
        signal.addEventListener('abort', () => {
          signalAborted = true
          resolve({ behavior: 'deny', message: 'The chat ended.', interrupt: true })
        })
      })
    const engine = start(h, {
      script: { turns: { 'Write it': [{ ask: { tool: 'Write', input: { file_path: 'out.txt', content: 'fixture' } }, allowed: [{ text: 'Written.' }], denied: [{ text: 'Not written.' }] }] } }
    })
    engine.send('Write it', [], 'send-uuid')
    await until(() => h.asks.length === 1, 'the pending ask')
    engine.close()
    await until(() => signalAborted, 'the ask signal to abort', 3_000)
    await until(() => h.exits.length === 1, 'the exit', 6_000)
  })

  it('close kills a Claude Code that ignores the end of its input after graceMs', async () => {
    const h = harness()
    const log = join(dir, 'fake-claude.log')
    const engine = start(h, { log, script: { turns: { Hang: [{ wait: 20_000 }] } } })
    engine.send('Hang', [], 'send-uuid')
    await until(() => logEntries(log).some(e => e.in?.type === 'user'), 'the message in the stand-in')
    const began = Date.now()
    engine.close(500)
    await until(() => h.exits.length === 1, 'the exit after the grace period', 6_000)
    expect(Date.now() - began).toBeLessThan(500 + 3_000)
  })

  it('close lets Claude Code exit', async () => {
    const h = harness()
    const engine = start(h, { script: { turns: { 'Say hi': [{ text: 'Hello.' }] } } })
    engine.send('Say hi', [], 'send-uuid')
    await until(() => results(h).length === 1, 'the result')
    engine.close()
    await until(() => h.exits.length === 1, 'the exit', 3_000)
    expect(h.exits).toEqual([0])
  })

  it('ready comes from the initialize reply, before any turn', async () => {
    const h = harness()
    const log = join(dir, 'fake-claude.log')
    const engine = start(h, { log, script: { turns: { 'Say hi': [{ text: 'Hello.' }] } } })
    await until(() => h.readies.length === 1, 'the ready')
    expect(h.readies).toEqual([{ permissionMode: 'default' }])
    // Claude Code sends no init until a turn starts
    expect(h.messages.some(m => m.type === 'system' && m.subtype === 'init')).toBe(false)
    expect(controlRequests(log, 'initialize')).toHaveLength(1)
    await stop(engine, h)
  })

  it('a new session starts with the id the engine is given', async () => {
    const h = harness()
    const log = join(dir, 'fake-claude.log')
    const id = randomUUID()
    const engine = start(h, { log, newSessionId: id, script: { turns: {} } })
    await until(() => startedArgs(log).length === 1, 'the stand-in start')
    expect(flagValue(startedArgs(log)[0], '--session-id')).toBe(id)
    await stop(engine, h)
  })

  it('noise and unknown messages before init are survived', async () => {
    const h = harness()
    const engine = start(h, { script: { beforeInit: [{ noise: 'Welcome to bash' }], turns: { 'Say hi': [{ text: 'Hello.' }] } } })
    await until(() => h.readies.length === 1, 'ready')
    engine.send('Say hi', [], 'send-uuid')
    await until(() => h.messages.some(m => m.type === 'system' && m.subtype === 'init'), 'init')
    engine.send('Say hi', [], 'send-uuid')
    await until(() => results(h).length === 1, 'the result')
    expect(results(h)[0]).toMatchObject({ is_error: false })
    expect(h.exits).toEqual([])
    await stop(engine, h)
  })

  it('a crash before init calls exit once', async () => {
    const h = harness()
    const engine = start(h, { script: { beforeInit: [{ crash: 3 }], turns: {} } })
    await until(() => h.exits.length === 1, 'the exit', 10_000)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(h.exits).toEqual([3])
    await stop(engine, h)
  })

  it('commands and models come from Claude Code', async () => {
    const h = harness()
    const engine = start(h, { script: { turns: {} } })
    const commands = await engine.commands()
    const context = commands.find(c => c.name === 'context')
    expect(context).toMatchObject({ name: 'context', group: 'builtin', source: null })

    const models = await engine.models()
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(model.displayName).not.toBe('')
      expect(Array.isArray(model.efforts)).toBe(true)
    }
    await stop(engine, h)
  })

  it('a percentage-only context answer gives the fill and no counts', async () => {
    const h = harness()
    const engine = start(h, { script: { turns: {}, contextPct: 74, contextTokens: null, contextMax: null } })
    expect(await engine.context()).toEqual({ pct: 74, used: null, size: null })
    await stop(engine, h)
  })

  it('context reads the fill and the token counts of the answer', async () => {
    const h = harness()
    const engine = start(h, { script: { turns: {} } })
    const c = await engine.context()
    expect(typeof c.pct).toBe('number')
    expect(c.pct).toBeGreaterThanOrEqual(0)
    expect(c.pct).toBeLessThanOrEqual(100)
    // the recorded answer's counts (tests/fixtures/chat/control.jsonl)
    expect(c).toMatchObject({ used: 21048, size: 1000000 })
    await stop(engine, h)
  })

  it('mode, model and task stop reach Claude Code', async () => {
    const h = harness()
    const log = join(dir, 'fake-claude.log')
    const engine = start(h, { log, script: { turns: {} } })
    await engine.setPermissionMode('acceptEdits')
    await engine.setModel('haiku')
    await engine.stopTask('a1')
    expect(controlRequests(log, 'set_permission_mode')).toEqual([expect.objectContaining({ mode: 'acceptEdits' })])
    expect(controlRequests(log, 'set_model')).toEqual([expect.objectContaining({ model: 'haiku' })])
    expect(controlRequests(log, 'stop_task')).toEqual([expect.objectContaining({ task_id: 'a1' })])
    await stop(engine, h)
  })

  it('a null settings path passes no --settings', async () => {
    const settings = join(dir, 'settings.json')
    writeFileSync(settings, '{}')
    const withoutLog = join(dir, 'without.log')
    const withLog = join(dir, 'with.log')

    const first = harness()
    const without = start(first, { log: withoutLog, settingsPath: null, script: { turns: {} } })
    await until(() => startedArgs(withoutLog).length === 1, 'the start without settings')
    expect(startedArgs(withoutLog)[0]).not.toContain('--settings')
    await stop(without, first)

    const second = harness()
    const withSettings = start(second, { log: withLog, settingsPath: settings, script: { turns: {} } })
    await until(() => startedArgs(withLog).length === 1, 'the start with settings')
    expect(flagValue(startedArgs(withLog)[0], '--settings')).toBe(settings)
    await stop(withSettings, second)
  })

  it('resumes the session it is given, and forks it when asked', async () => {
    const session = '00000000-0000-4000-8000-0000000000aa'
    const resumed = harness()
    const resumeLog = join(dir, 'resume.log')
    const engine = start(resumed, { log: resumeLog, sessionId: session, script: { turns: {} } })
    await until(() => startedArgs(resumeLog).length === 1, 'the resumed start')
    expect(flagValue(startedArgs(resumeLog)[0], '--resume')).toBe(session)
    expect(startedArgs(resumeLog)[0]).not.toContain('--fork-session')
    await stop(engine, resumed)

    const forked = harness()
    const forkLog = join(dir, 'fork.log')
    const copy = start(forked, { log: forkLog, sessionId: session, fork: true, script: { turns: {} } })
    await until(() => startedArgs(forkLog).length === 1, 'the forked start')
    expect(flagValue(startedArgs(forkLog)[0], '--resume')).toBe(session)
    expect(startedArgs(forkLog)[0]).toContain('--fork-session')
    await stop(copy, forked)
  })
})
