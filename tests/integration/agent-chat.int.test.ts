import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatHub } from '../../src/main/chat/chat-hub'
import { resolveChatLaunch, type ChatLaunch } from '../../src/main/chat/claude-spawn'
import { startSdkEngine } from '../../src/main/chat/sdk-engine'
import type { AgentSnapshot } from '../../src/shared/chat'
import type { TabInfo } from '../../src/shared/types'
import type { ChatHandle, ChatStartRequest } from '../../src/main/tab-manager'
import { installFakeClaude, type FakeScript } from '../fixtures/fake-claude/install'

// A ChatHub on the SDK engine, driving the stand-in Claude Code (tests/fixtures/fake-claude): the agents of a chat reach their pages

const TAB = 'tab-1'

let dir: string
let work: string
let config: string
let launch: Exclude<ChatLaunch, { how: 'none' }>
let hub: ChatHub | null = null
let chat: ChatHandle | null = null
let exits = 0

function tabInfo(): TabInfo {
  return {
    id: TAB, kind: 'claude', profile: 'default', cwd: work, folder: work, customTitle: null, claudeSessionId: null,
    account: null, muted: false, fork: null, exited: false, activity: null, view: 'chat',
  } as TabInfo
}

function env(log: string, script: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('FAKE_CLAUDE_') && !key.startsWith('CLAUDE')) result[key] = value
  result.CLAUDE_CONFIG_DIR = config
  result.FAKE_CLAUDE_LOG = log
  result.FAKE_CLAUDE_SCRIPT = script
  return result
}

function hubOnSdk(): ChatHub {
  return new ChatHub({
    engine: startSdkEngine,
    support: async () => ({ launch }),
    history: async () => [],
    transcript: async () => null,
    window: () => undefined,
    remote: () => undefined,
    agentWindow: () => undefined,
    agentRemote: () => undefined,
    watched: () => false,
    activeTabId: () => TAB,
    exists: () => true,
    cards: () => [],
    attach: {
      stat: async () => null,
      read: async () => Buffer.alloc(0),
      scale: async (data, mediaType) => ({ data, mediaType }),
    },
    setSession: () => undefined,
    setWorking: () => undefined,
    status: () => undefined,
    recordSession: () => undefined,
    folder: () => undefined,
    now: () => Date.now(),
    log: { warn: () => undefined },
  })
}

/** the value a read gives once it is there; fails after `ms` */
async function until<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-chat-'))
  work = join(dir, 'work')
  config = join(dir, 'config')
  mkdirSync(work, { recursive: true })
  mkdirSync(config, { recursive: true })
  const command = installFakeClaude(join(dir, 'bin'))
  const resolved = await resolveChatLaunch(command, {
    platform: process.platform,
    isFile: p => existsSync(p),
    isExecutable: p => existsSync(p),
    where: async () => [],
    loginShell: () => '/bin/sh',
  })
  if (resolved.how === 'none') throw new Error(resolved.reason)
  launch = resolved
  exits = 0
})

afterEach(async () => {
  if (chat !== null) {
    chat.kill()
    await until(() => exits > 0, 'the exit of the chat', 5_000).catch(() => undefined)
    chat = null
  }
  hub = null
  rmSync(dir, { recursive: true, force: true })
}, 20_000)

describe('the agent chat on the SDK engine', () => {
  it("an agent's frames reach its page, not the main conversation", async () => {
    const script: FakeScript = {
      turns: {
        Go: [{
          task: {
            description: 'Look', result: 'Found it.',
            agents: [{
              type: 'Explore', description: 'Find the total', ms: 400,
              frames: [{ thinking: 'Hmm' }, { text: 'Looking' }, { tool: { name: 'Glob', input: { pattern: '**/*.ts' }, result: 'a.ts' } }],
            }],
          },
        }],
      },
    }
    const scriptFile = join(dir, 'script.json')
    writeFileSync(scriptFile, JSON.stringify(script))
    hub = hubOnSdk()
    chat = hub.start({
      tab: tabInfo(),
      claude: { command: 'claude', settingsPath: null, resumeSessionId: null, forkSession: false },
      env: env(join(dir, 'fake-claude.log'), scriptFile),
      exit: () => {
        exits++
      },
    } satisfies ChatStartRequest)
    await until(() => hub!.isRunning(TAB), 'the chat running')
    await hub.send(TAB, { text: 'Go', attachments: [] })

    // the Agent call of the main conversation names the agent once its task has started
    const agentId = await until(() => {
      const call = hub!.snapshot(TAB)?.items.flatMap(item => (item.kind === 'tools' ? item.calls : [])).find(c => c.agents.length > 0)
      return call?.agents[0].id ?? null
    }, 'the agent of the Agent call')
    const page: AgentSnapshot = await until(async () => {
      const got = await hub!.agentSnapshot(TAB, agentId)
      return got?.agent.state === 'done' ? got : null
    }, 'the agent to end')

    const agentItems = JSON.stringify(page.items)
    expect(agentItems).toContain('Looking')
    expect(agentItems).toContain('Hmm')
    expect(agentItems).toContain('Glob')
    // the main conversation holds none of the agent's frames
    const main = JSON.stringify(hub.snapshot(TAB)!.items)
    expect(main).not.toContain('Looking')
    expect(main).not.toContain('Hmm')
    expect(main).not.toContain('Glob')
  }, 30_000)

  it('a forward round trip: the stand-in logs forwarded to the agent, the forward is delivered, and the agent runs again', async () => {
    const script: FakeScript = {
      turns: {
        Go: [{
          task: {
            description: 'Look', result: 'Found it.',
            agents: [{ type: 'Explore', description: 'Find the total', ms: 100, frames: [{ text: 'Looking' }] }],
          },
        }],
      },
    }
    const scriptFile = join(dir, 'script.json')
    writeFileSync(scriptFile, JSON.stringify(script))
    const log = join(dir, 'fake-claude.log')
    hub = hubOnSdk()
    chat = hub.start({
      tab: tabInfo(),
      claude: { command: 'claude', settingsPath: null, resumeSessionId: null, forkSession: false },
      env: env(log, scriptFile),
      exit: () => {
        exits++
      },
    } satisfies ChatStartRequest)
    await until(() => hub!.isRunning(TAB), 'the chat running')
    await hub.send(TAB, { text: 'Go', attachments: [] })
    const agentId = await until(() => {
      const call = hub!.snapshot(TAB)?.items.flatMap(item => (item.kind === 'tools' ? item.calls : [])).find(c => c.agents.length > 0)
      return call?.agents[0].id ?? null
    }, 'the agent of the Agent call')
    await until(async () => ((await hub!.agentSnapshot(TAB, agentId))?.agent.state === 'done' ? true : null), 'the agent to end')

    expect(await hub.sendToAgent(TAB, agentId, 'Look in src/charts too.')).toBeNull()
    await until(() => hub!.snapshot(TAB)?.items.some(item => item.kind === 'forward' && item.state === 'delivered') ?? false, 'the forward delivered')

    // the stand-in logged the forward it passed to the agent
    const forwarded = readFileSync(log, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => 'forwarded' in entry)
    expect(forwarded).toEqual([{ forwarded: { to: agentId, message: 'Look in src/charts too.' } }])
    // the agent ran again: it answered the message, and its page shows the forward delivered
    const page = await until(async () => {
      const got = await hub!.agentSnapshot(TAB, agentId)
      return got?.agent.state === 'done' && got.items.some(item => item.kind === 'text' && item.markdown === 'Got: Look in src/charts too.') ? got : null
    }, 'the agent to answer the forward')
    expect(page.items).toContainEqual(expect.objectContaining({ kind: 'forward', state: 'delivered' }))
    // the agent notifies, and the turn Claude starts by itself to answer it is quiet: its end is no notification
    await until(() => hub!.snapshot(TAB)?.items.some(item => item.kind === 'text' && item.markdown.startsWith('The agent answered')) ?? false, 'the follow-up turn')
    await until(() => hub!.snapshot(TAB)?.state.turn === 'idle', 'the follow-up turn to end')
    expect(hub.quietTurn(TAB)).toBe(true)
  }, 30_000)
})
