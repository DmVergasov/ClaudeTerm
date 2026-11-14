import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachmentOf } from '../../src/main/chat/chat-attachments'
import { ChatHub } from '../../src/main/chat/chat-hub'
import type { ChatEngine, ChatEngineHandlers, McpLiveServer } from '../../src/main/chat/chat-engine'
import { openInTerminal } from '../../src/main/chat/terminal-handoff'
import { chatBatchPush, forgetCopiedBy, hostHandlers, hostTabs, pushAgentBatch } from '../../src/main/remote-host'
import { FileReceiver } from '../../src/main/sync/file-receiver'
import { sendFiles } from '../../src/main/sync/file-sender'
import { RemoteActions } from '../../src/main/sync/remote-actions'
import { connectPeer } from '../../src/main/sync/remote-link'
import { ScreenMirrors } from '../../src/main/sync/screen-mirror'
import { TabHost } from '../../src/main/sync/tab-host'
import { RemoteTabs, type ViewerEvents } from '../../src/main/sync/tab-viewer'
import type { HelloMessage } from '../../src/main/sync/wire'
import type { AgentPatch, AgentSnapshot, ChatCommandInfo, ChatItem, ChatModelInfo, ChatPatch } from '../../src/shared/chat'
import { MAX_CHAT_PUSH_BYTES } from '../../src/shared/remote'
import type { DevicePlatform } from '../../src/shared/devices'
import { B_ID, T1, T2, T3, T9, fakeHost, tabInfo, type FakeHost } from '../fixtures/host-context'
import { closeLinkPairs, linkPair, until } from '../fixtures/sync'

// A chat tab of device A (the host) mirrored on device B (the member): the host's ChatHub runs a fake engine, the devices
// talk over the in-memory link of tests/fixtures/sync.ts, and their calls are answered by A's handlers. C is a second member.

const A_ID = 'a1000000-0000-4000-8000-000000000001'
const C_ID = 'c1000000-0000-4000-8000-000000000001'
const MB = 1024 * 1024
const SID = '00000000-0000-4000-8000-0000000000aa'
/** the refusal the host gives a chat-terminal line it cannot type */
const NO_TERMINAL = 'the line cannot be typed into the terminal now'
/** the refusal the host gives a permission mode it does not offer */
const NO_MODE = 'the permission mode is not offered here'

function helloOf(id: string, name: string, platform: DevicePlatform = 'linux'): HelloMessage {
  return { t: 'hello', v: 1, id, name, platform, port: 0, addresses: [], reachedYou: null }
}

const quietEvents: ViewerEvents = {
  opened: () => {},
  updated: () => {},
  closed: () => {},
  devices: () => {},
  data: () => {},
  reset: () => {},
  exit: () => {},
  size: () => {},
  attention: () => {},
  attentionCleared: () => {},
  ring: () => {},
  push: () => {},
}

/** a stand-in for the engine: it records what the hub sends it, and the test drives its messages through the handlers */
class FakeEngine implements ChatEngine {
  sent: string[] = []

  constructor(readonly h: ChatEngineHandlers) {}

  send(text: string): void {
    this.sent.push(text)
  }

  async interrupt(): Promise<void> {}

  async setPermissionMode(): Promise<void> {}

  async setModel(): Promise<void> {}

  async setEffort(): Promise<void> {}

  async stopTask(): Promise<void> {}

  async commands(): Promise<ChatCommandInfo[]> {
    return []
  }

  async models(): Promise<ChatModelInfo[]> {
    return []
  }

  async context(): Promise<{ pct: number | null; used: number | null; size: number | null }> {
    return { pct: null, used: null, size: null }
  }

  async effort(): Promise<string | null | undefined> {
    return undefined
  }

  async mcpStatus(): Promise<McpLiveServer[]> {
    return []
  }

  async reconnectMcp(): Promise<void> {}

  async toggleMcp(): Promise<void> {}

  close(): void {}

  kill(): void {}
}

const init = { type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5', permissionMode: 'default' }
const textStart = { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }
const textDelta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })

let engine: FakeEngine | null
let hub: ChatHub
let a: FakeHost
let hostA: TabHost
let viewerA: RemoteTabs
let viewerB: RemoteTabs
let actions: RemoteActions
let links: Awaited<ReturnType<typeof linkPair>>
let chats: [string, number, number, ChatPatch[]][]
let reloads: string[]
/** the agent batches and the agent reloads the member's window got, in order */
let agentPatches: { agentId: string; fromRev: number; toRev: number; patches: AgentPatch[] }[]
let agentReloads: string[]
/** the host's agent page calls a member makes (not the pushes), and a change the host makes to the page it answers with */
let hostAgentCalls: number
let agentSkew: Partial<AgentSnapshot> | null
/** the pages made for pushes, and while a test holds `agentGate` they wait for it */
let pushedPages: number
let agentGate: Promise<void> | null
let logs: string[]
let typed: string[]
/** while set, a message that carries files waits here before the host attaches them (the order test holds a send up) */
let attachGate: Promise<void> | null
let tmpBase: string
let root: string
let receiver: FileReceiver | null

/** the member's chat of T1 is the host's: the same items, state and revision */
function sameAsHost(): boolean {
  return JSON.stringify(viewerB.chatSnapshot(T1)) === JSON.stringify(hub.remoteSnapshot(T1))
}

/** the host's page of an agent for a push; while a test holds agentGate, the page waits for it */
async function pushedPage(tabId: string, agentId: string): Promise<AgentSnapshot | null> {
  pushedPages++
  if (agentGate) await agentGate
  return hub.remoteAgentSnapshot(tabId, agentId)
}

/** the member attaches T1 (it is in front on the member) and its chat arrives */
async function attach(): Promise<void> {
  viewerB.activated(T1)
  await until(() => viewerB.chatSnapshot(T1) !== null)
}

async function settleSends(): Promise<void> {
  await until(() => sameAsHost())
}

/** a file of the member, copied to the host the way a drop is: its path on the host comes back */
async function copyToHost(name: string, data: Buffer): Promise<string[]> {
  const sent = await sendFiles(actions, T1, [{ name, size: data.length, read: async (offset, length) => data.subarray(offset, offset + length) }])
  return sent.paths
}

/** links the member with the host: its viewer lists A's tabs, and A's handlers serve its calls */
async function connect(): Promise<void> {
  const ab = await linkPair()
  links = ab
  const hostB = new TabHost({ tabs: hostTabs(fakeHost().ctx), mirrors: new ScreenMirrors({ maxSnapshotBytes: MB }) })
  connectPeer(ab.client, helloOf(A_ID, 'Studio'), hostB, viewerB, {})
  connectPeer(ab.server, helloOf(B_ID, 'Laptop'), hostA, viewerA, hostHandlers(a.ctx, B_ID))
  await until(() => viewerB.has(T1))
}

/** a second member, C, linked to the host: its own viewer, and A's handlers for it */
async function joinSecond(events: ViewerEvents = quietEvents): Promise<RemoteTabs> {
  const viewerC = new RemoteTabs({ selfId: () => C_ID, isLocal: () => false, events, reattachMs: 20 })
  const hostC = new TabHost({ tabs: hostTabs(fakeHost().ctx), mirrors: new ScreenMirrors({ maxSnapshotBytes: MB }) })
  const ac = await linkPair()
  connectPeer(ac.client, helloOf(A_ID, 'Studio'), hostC, viewerC, {})
  connectPeer(ac.server, helloOf(C_ID, 'Cellar'), hostA, viewerA, hostHandlers(a.ctx, C_ID))
  await until(() => viewerC.has(T1))
  return viewerC
}

async function setUp(): Promise<void> {
  a = fakeHost()
  // T1 is a Claude tab in its chat view; T2 is a shell tab; T3 is a Claude tab in its terminal view; T9 is not a tab of this device
  a.infos.set(T1, tabInfo(T1, { view: 'chat', activity: null }))
  a.infos.set(T3, tabInfo(T3, { view: 'terminal', activity: null }))
  engine = null
  attachGate = null
  typed = []
  hub = new ChatHub({
    engine: (_start, handlers) => {
      engine = new FakeEngine(handlers)
      return engine
    },
    support: async () => ({ launch: { how: 'direct', file: '/usr/bin/claude' } }),
    history: async () => [],
    transcript: async () => null,
    window: () => {},
    agentWindow: () => undefined,
    // what index.ts does with a member's agent batch: the batch, or the page as a snapshot, to each device that still watches it
    agentRemote: (tabId, agentId, devices, fromRev, toRev, patches) => {
      void pushAgentBatch(hostA, tabId, { agentId, fromRev, toRev, patches }, devices, () => pushedPage(tabId, agentId), (device) => hub.watchesAgent(device, tabId, agentId))
    },
    remote: (tabId, fromRev, toRev, patches) => {
      const push = chatBatchPush({ fromRev, toRev, patches }, () => hub.remoteSnapshot(tabId))
      if (push) hostA.push(tabId, push.k, push.v)
    },
    watched: (tabId) => hostA.watchers(tabId).length > 0,
    activeTabId: () => null,
    exists: () => true,
    cards: () => [],
    attach: {
      stat: async () => ({ size: 1, isFile: true }),
      read: async () => Buffer.alloc(1),
      scale: async (data, mediaType) => ({ data, mediaType }),
    },
    setSession: () => {},
    setWorking: () => {},
    status: () => {},
    recordSession: () => {},
    folder: () => {},
    now: () => Date.now(),
    log: { warn: () => {} },
  })
  // what the host's window does for the chat calls of a remote member, as index.ts does: the terminal handoff is the real one
  a.ctx.chat = {
    snapshot: (tabId) => hub.remoteSnapshot(tabId),
    send: (tabId, s) => hub.send(tabId, s),
    answer: (tabId, cardId, answer) => hub.answer(tabId, cardId, answer),
    interrupt: (tabId) => hub.interrupt(tabId),
    setMode: (tabId, mode) => hub.setMode(tabId, mode),
    setModel: (tabId, model, effort) => hub.setModel(tabId, model, effort),
    stopTask: (tabId, taskId) => hub.stopTask(tabId, taskId),
    older: (tabId, beforeId) => hub.older(tabId, beforeId),
    agentSnapshot: async (tabId, agentId) => {
      hostAgentCalls++
      const page = await hub.remoteAgentSnapshot(tabId, agentId)
      return page !== null && agentSkew !== null ? { ...page, ...agentSkew } : page
    },
    agentOlder: (tabId, agentId, beforeId) => hub.agentOlder(tabId, agentId, beforeId),
    watchAgent: (tabId, device, agentId) => hub.watchAgent(tabId, device, agentId),
    commands: (tabId) => hub.commands(tabId),
    models: (tabId) => hub.models(tabId),
    modes: (tabId) => hub.modes(tabId),
    files: async () => ['src/index.ts'],
    attach: async (tabId, paths) => {
      if (paths.length > 0 && attachGate) await attachGate
      const list = paths.map((p) => attachmentOf(p, 1))
      hub.allow(tabId, list)
      return list
    },
    setView: async () => true,
    openInTerminal: (tabId, line) =>
      openInTerminal(tabId, line, line ?? '', {
        setView: async () => true,
        promptState: async () => 'empty',
        write: (_tab, data) => {
          typed.push(data)
        },
        note: () => {},
        toast: () => {},
        sleep: async () => {},
        exists: () => true,
      }),
  }

  chats = []
  reloads = []
  agentPatches = []
  agentReloads = []
  hostAgentCalls = 0
  agentSkew = null
  pushedPages = 0
  agentGate = null
  logs = []
  hostA = new TabHost({
    tabs: hostTabs(a.ctx),
    mirrors: new ScreenMirrors({ maxSnapshotBytes: MB }),
    onPeerGone: (device) => {
      forgetCopiedBy(a.ctx, device)
      hub.forgetViewer(device)
    },
  })
  // the tab has its screen copy here, as the app opens one for every tab it has
  hostA.opened(T1, 80, 24, 1000)
  viewerA = new RemoteTabs({ selfId: () => A_ID, isLocal: () => false, events: quietEvents })
  viewerB = new RemoteTabs({
    selfId: () => B_ID,
    isLocal: () => false,
    events: {
      ...quietEvents,
      chat: (tabId, fromRev, toRev, patches) => {
        chats.push([tabId, fromRev, toRev, patches])
      },
      chatReload: (tabId) => {
        reloads.push(tabId)
      },
      chatAgent: (tabId, agentId, fromRev, toRev, patches) => {
        agentPatches.push({ agentId, fromRev, toRev, patches })
      },
      chatAgentReload: (tabId, agentId) => {
        agentReloads.push(agentId)
      },
    },
    reattachMs: 20,
    log: (m) => {
      logs.push(m)
    },
  })
  await connect()
  actions = new RemoteActions(viewerB, () => {}, () => {})

  hub.start({
    tab: a.infos.get(T1)!,
    claude: { command: 'claude', settingsPath: null, resumeSessionId: null, forkSession: false },
    env: {},
    exit: () => {},
  })
  await until(() => engine !== null)
  engine!.h.ready({ permissionMode: 'default' })
  engine!.h.message(init)
}

beforeEach(async () => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ct-remote-chat-'))
  root = join(tmpBase, 'ClaudeTerm', 'received')
  receiver = null
  await setUp()
})

afterEach(async () => {
  await closeLinkPairs()
  receiver?.dispose()
  rmSync(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('a chat tab of another device, mirrored by the member', () => {
  it("attaching gives the member the host's chat: the same items, state and revision", async () => {
    await hub.send(T1, { text: 'hello there', attachments: [] })
    engine!.h.message(textStart)
    engine!.h.message(textDelta('Hi'))
    await attach()
    await settleSends()

    expect(viewerB.tab(T1)?.view).toBe('chat')
    expect(viewerB.chatSnapshot(T1)).toEqual(hub.remoteSnapshot(T1))
    expect(viewerB.chatSnapshot(T1)?.items.map((i) => i.kind)).toEqual(['user', 'text'])
  })

  it('a streamed turn arrives at the member in order', async () => {
    await attach()
    await hub.send(T1, { text: 'stream it', attachments: [] })
    engine!.h.message(textStart)
    for (const piece of ['a', 'b', 'c']) {
      engine!.h.message(textDelta(piece))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await settleSends()

    const text = viewerB.chatSnapshot(T1)!.items.find((i) => i.kind === 'text')
    expect(text).toMatchObject({ kind: 'text', markdown: 'abc' })
    // the counted batches of the window carry the revisions in order: each one starts where the last one ended
    let rev = chats[0]?.[1] ?? 0
    for (const [, fromRev, toRev, patches] of chats) {
      expect(fromRev).toBe(rev)
      rev = toRev
      expect(toRev - fromRev).toBe(patches.length)
    }
  })

  it("a member that drops off mid-stream and comes back gets the host's chat again", async () => {
    await attach()
    await hub.send(T1, { text: 'before', attachments: [] })
    engine!.h.message(textStart)
    engine!.h.message(textDelta('one'))
    await settleSends()

    // the link says the tab is detached: the member lets go, and the host's turn goes on meanwhile
    links.server.send({ t: 'detached', id: T1 })
    await until(() => viewerB.chatSnapshot(T1) === null)
    engine!.h.message(textDelta('two'))
    engine!.h.message(textDelta('three'))
    await hub.send(T1, { text: 'after', attachments: [] })

    await until(() => sameAsHost())
    expect(viewerB.chatSnapshot(T1)!.items.find((i) => i.kind === 'text')).toMatchObject({ markdown: 'onetwothree' })
    expect(viewerB.chatSnapshot(T1)!.items.map((i) => i.kind)).toEqual(['user', 'text', 'user'])
  })

  it('a snapshot reaches the window as a reload, and each re-attach reloads again; patches are never a snapshot', async () => {
    await attach()
    await settleSends()
    expect(reloads).toEqual([T1])

    links.server.send({ t: 'detached', id: T1 })
    await until(() => viewerB.chatSnapshot(T1) === null)
    await until(() => sameAsHost())
    expect(reloads).toEqual([T1, T1])
    expect(chats.flatMap(([, , , patches]) => patches).some((p) => p.op === 'reset' || p.op === 'state')).toBe(false)
  })

  it("a chat push whose tab is not the push's tab is dropped, and the member attaches again", async () => {
    await attach()
    await settleSends()
    const bogus = { ...hub.remoteSnapshot(T1)!, tabId: T2, items: [{ kind: 'notice', id: 'bogus-1', tone: 'info', text: 'bogus', action: null }] }
    links.server.send({ t: 'push', id: T1, k: 'chat', v: bogus })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(chats.flatMap(([, , , patches]) => patches).some((p) => 'item' in p && p.item.id === 'bogus-1')).toBe(false)
    expect(reloads.every((tabId) => tabId === T1)).toBe(true)
    await until(() => sameAsHost())
  })

  it('a batch over the push cap goes through the link as a snapshot: the member reloads, and no counted batch is over the cap', async () => {
    await attach()
    await settleSends()
    const before = reloads.length
    engine!.h.message(textStart)
    // more patches than one push takes, in one turn: they leave as one batch, which becomes the chat as a snapshot
    for (let i = 0; i < 510; i++) engine!.h.message(textDelta('x'))
    await until(() => reloads.length > before)
    await settleSends()

    expect(reloads.length).toBeGreaterThan(before)
    expect(chats.every(([, , , patches]) => patches.length <= 500)).toBe(true)
    expect(viewerB.chatSnapshot(T1)!.items.find((i) => i.kind === 'text')).toMatchObject({ kind: 'text', markdown: 'x'.repeat(510) })
  })

  it('two members attached at once both converge to the host\'s chat through a streamed turn', async () => {
    const viewerC = await joinSecond()
    await attach()
    viewerC.activated(T1)
    await until(() => viewerC.chatSnapshot(T1) !== null)
    await hub.send(T1, { text: 'both', attachments: [] })
    engine!.h.message(textStart)
    for (const piece of ['p', 'q', 'r']) {
      engine!.h.message(textDelta(piece))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    await until(() => sameAsHost())
    await until(() => JSON.stringify(viewerC.chatSnapshot(T1)) === JSON.stringify(hub.remoteSnapshot(T1)))
    expect(viewerC.chatSnapshot(T1)!.items.find((i) => i.kind === 'text')).toMatchObject({ markdown: 'pqr' })
  })
})

/** an agent of the chat starts, as Claude Code's task_started says */
const agentStart = (id: string) => ({ type: 'system', subtype: 'task_started', task_id: id, subagent_type: 'Explore', description: `Look ${id}` })
/** one step of an agent: a text of its own message, under the agent's id */
const agentStep = (id: string, n: number, text: string) => ({
  type: 'assistant', agent_id: id, uuid: `${id}-uuid-${n}`, message: { id: `${id}-msg-${n}`, content: [{ type: 'text', text }] },
})

describe('a member opens an agent page, read-only', () => {
  it("a member opens an agent page: the host's snapshot, then the patches of that agent only", async () => {
    await attach()
    engine!.h.message(agentStart('agent-one'))
    engine!.h.message(agentStart('agent-two'))
    engine!.h.message(agentStep('agent-one', 1, 'First step'))
    const page = await actions.chatAgent(T1, 'agent-one')
    expect(page).toMatchObject({ tabId: T1, agentId: 'agent-one', agent: { id: 'agent-one' } })
    expect(JSON.stringify(page!.items)).toContain('First step')

    actions.chatAgentWatch(T1, 'agent-one')
    let step = 2
    // the watch is a call of its own: steps go on until one of the agent reaches the member
    await until(() => {
      engine!.h.message(agentStep('agent-one', step++, 'Second step'))
      return agentPatches.length > 0
    })
    engine!.h.message(agentStep('agent-two', 1, 'Other step'))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(agentPatches.length).toBeGreaterThan(0)
    expect(agentPatches.every((p) => p.agentId === 'agent-one')).toBe(true)
  })

  it('an agent page of a member is read-only: the host says so', async () => {
    await attach()
    engine!.h.message(agentStart('agent-one'))
    engine!.h.message(agentStep('agent-one', 1, 'Read me'))
    const page = await actions.chatAgent(T1, 'agent-one')
    expect(page?.writable).toBe(false)
  })

  it('a member that leaves the page gets no more agent patches', async () => {
    await attach()
    engine!.h.message(agentStart('agent-one'))
    actions.chatAgentWatch(T1, 'agent-one')
    let step = 1
    await until(() => {
      engine!.h.message(agentStep('agent-one', step++, 'Tick'))
      return agentPatches.length > 0
    })
    actions.chatAgentWatch(T1, null)
    // the calls of one link are served in order: the watch is off once this answers
    await actions.chatModes(T1)
    const seen = agentPatches.length
    engine!.h.message(agentStep('agent-one', step++, 'Gone'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(agentPatches.length).toBe(seen)
  })

  it('a batch over the cap reaches the member as a reload, and the page it keeps is the host\'s newest', async () => {
    await attach()
    engine!.h.message(agentStart('agent-big'))
    actions.chatAgentWatch(T1, 'agent-big')
    let step = 0
    await until(() => {
      engine!.h.message(agentStep('agent-big', step++, 'Tick'))
      return agentPatches.length > 0
    })
    const before = agentReloads.length
    // more patches than one batch takes, in one tick: they leave as one batch, which becomes the page as a snapshot
    for (let i = 0; i < 510; i++) engine!.h.message(agentStep('agent-big', 1000 + i, `part ${i}`))
    await until(() => agentReloads.length > before)

    expect(agentReloads.slice(before)).toEqual(['agent-big'])
    expect(agentPatches.every((p) => p.patches.length <= 500)).toBe(true)
    // the page the device sent is given once, with no call to the host; the next ask is the host's
    const calls = hostAgentCalls
    const kept = await actions.chatAgent(T1, 'agent-big')
    expect(hostAgentCalls).toBe(calls)
    expect(kept).toMatchObject({ agentId: 'agent-big', writable: false })
    expect(JSON.stringify(kept!.items)).toContain('part 509')
    await actions.chatAgent(T1, 'agent-big')
    expect(hostAgentCalls).toBe(calls + 1)
  })

  it('an agent page reaches only the members that watch it, though another member is attached to the tab', async () => {
    const otherEvents: string[] = []
    const viewerC = await joinSecond({ ...quietEvents, chatAgent: (_tabId, agentId) => void otherEvents.push(agentId) })
    await attach()
    viewerC.activated(T1)
    await until(() => viewerC.chatSnapshot(T1) !== null)
    engine!.h.message(agentStart('agent-one'))
    actions.chatAgentWatch(T1, 'agent-one')
    let step = 1
    await until(() => {
      engine!.h.message(agentStep('agent-one', step++, 'Tick'))
      return agentPatches.length > 0
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(agentPatches.length).toBeGreaterThan(0)
    expect(otherEvents).toEqual([])
  })

  it('an agent page goes to no member that is not attached to the tab, though it watches the page', async () => {
    await attach()
    engine!.h.message(agentStart('agent-one'))
    actions.chatAgentWatch(T1, 'agent-one')
    let step = 1
    await until(() => {
      engine!.h.message(agentStep('agent-one', step++, 'Tick'))
      return agentPatches.length > 0
    })
    // the tab's copy closes here: no member stays attached to it
    hostA.closed(T1)
    const seen = agentPatches.length
    engine!.h.message(agentStep('agent-one', step++, 'Gone'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(agentPatches.length).toBe(seen)
  })

  it('a page made for a batch over the cap reaches no member that has moved on from it meanwhile', async () => {
    await attach()
    engine!.h.message(agentStart('agent-big'))
    actions.chatAgentWatch(T1, 'agent-big')
    let step = 0
    await until(() => {
      engine!.h.message(agentStep('agent-big', step++, 'Tick'))
      return agentPatches.length > 0
    })
    let release: () => void = () => undefined
    agentGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const made = pushedPages
    for (let i = 0; i < 510; i++) engine!.h.message(agentStep('agent-big', 1000 + i, `part ${i}`))
    // the page is being made, and the member leaves it before it is sent
    await until(() => pushedPages > made)
    const reloads = agentReloads.length
    actions.chatAgentWatch(T1, null)
    await actions.chatModes(T1)
    release()
    agentGate = null
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(agentReloads.length).toBe(reloads)
  })

  it('a page the device answers for another agent or another tab than asked is no page', async () => {
    await attach()
    engine!.h.message(agentStart('agent-one'))
    const agentTwo = { id: 'agent-two', type: 'Explore', description: 'Look agent-one', state: 'running', startedAt: null, ms: null, parentId: null }
    agentSkew = { agentId: 'agent-two', agent: agentTwo as AgentSnapshot['agent'] }
    expect(await actions.chatAgent(T1, 'agent-one')).toBeNull()
    agentSkew = { tabId: T2 }
    expect(await actions.chatAgent(T1, 'agent-one')).toBeNull()
    agentSkew = null
    expect(await actions.chatAgent(T1, 'agent-one')).toMatchObject({ tabId: T1, agentId: 'agent-one' })
  })
})

describe('the calls a member makes about a chat', () => {
  it('chat-answer: the first answer is taken and the member sees true, the second is refused and the member sees false', async () => {
    await attach()
    const decided = engine!.h.ask({ toolName: 'Bash', input: { command: 'ls' } }, new AbortController().signal)
    await settleSends()
    const card = viewerB.chatSnapshot(T1)!.items.find((i) => i.kind === 'card')!
    const answer = { type: 'permission' as const, choice: 'once' as const, suggestion: null, message: null }

    await expect(actions.chatAnswer(T1, card.id, answer)).resolves.toBe(true)
    await expect(actions.chatAnswer(T1, card.id, answer)).resolves.toBe(false)
    await expect(decided).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    await settleSends()
    expect(viewerB.chatSnapshot(T1)!.items.find((i) => i.kind === 'card')).toMatchObject({ answered: 'Allowed: run a command' })
  })

  it('chat-send: a message the member sends reaches the engine', async () => {
    await attach()
    await expect(actions.chatSend(T1, { text: 'hello from B', attachments: [] })).resolves.toBeNull()
    await until(() => engine!.sent.includes('hello from B'))
  })

  it('chat-send: an attachment the member copied to the host is accepted and reaches the engine', async () => {
    receiver = new FileReceiver({ root })
    a.ctx.receiver = receiver
    await attach()
    const [path] = await copyToHost('notes.txt', Buffer.from('hello notes'))
    const attachments = [attachmentOf(path, 11)]

    await expect(actions.chatSend(T1, { text: 'see the notes', attachments })).resolves.toBeNull()
    await until(() => engine!.sent.some((t) => t.includes('see the notes') && t.includes('notes.txt')))
  })

  it('chat-send: an attachment the member did not copy here is refused, and nothing is sent', async () => {
    await attach()
    const outside = { kind: 'file' as const, path: '/outside/secret.txt', name: 'secret.txt', size: 3, cardId: null }
    await expect(actions.chatSend(T1, { text: 'leak', attachments: [outside] })).resolves.toBe('not a file sent to this device')
    expect(engine!.sent).not.toContain('leak')
  })

  it('chat-send: a file inside the received folder that the member did not copy is refused', async () => {
    receiver = new FileReceiver({ root })
    a.ctx.receiver = receiver
    await attach()
    // a file of the received folder, which no transfer of this member made
    mkdirSync(join(root, 'other'), { recursive: true })
    const stray = join(root, 'other', 'stray.txt')
    writeFileSync(stray, 'stray')

    await expect(actions.chatSend(T1, { text: 'stray', attachments: [attachmentOf(stray, 5)] })).resolves.toBe('not a file sent to this device')
    expect(engine!.sent.some((t) => t.includes('stray'))).toBe(false)
  })

  it('chat-send: a path that goes out of the copied folder with ".." is refused', async () => {
    receiver = new FileReceiver({ root })
    a.ctx.receiver = receiver
    await attach()
    const [copied] = await copyToHost('keep.txt', Buffer.from('kept'))
    mkdirSync(join(root, 'other'), { recursive: true })
    writeFileSync(join(root, 'other', 'x.txt'), 'x')
    // the copied file's folder, up and into the other folder: it names a file the member did not copy
    const escaping = `${dirname(copied)}/../other/x.txt`

    await expect(actions.chatSend(T1, { text: 'dotdot', attachments: [attachmentOf(escaping, 1)] })).resolves.toBe('not a file sent to this device')
    expect(engine!.sent.some((t) => t.includes('dotdot'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('chat-send: a case and slash variant of a file the member did not copy is refused on Windows', async () => {
    receiver = new FileReceiver({ root })
    a.ctx.receiver = receiver
    await attach()
    mkdirSync(join(root, 'other'), { recursive: true })
    writeFileSync(join(root, 'other', 'Stray.txt'), 'stray')
    const variant = `${root.toUpperCase()}/OTHER/stray.TXT`

    await expect(actions.chatSend(T1, { text: 'variant', attachments: [attachmentOf(variant, 5)] })).resolves.toBe('not a file sent to this device')
    expect(engine!.sent.some((t) => t.includes('variant'))).toBe(false)
  })

  it("chat-send: another member's copied file is refused for this member", async () => {
    receiver = new FileReceiver({ root })
    a.ctx.receiver = receiver
    await attach()
    const [bFile] = await copyToHost('bs.txt', Buffer.from('b wrote this'))
    const viewerC = await joinSecond()

    await expect(viewerC.callsOf(A_ID)!.call('chat-send', { id: T1, text: 'steal', attachments: [attachmentOf(bFile, 12)] })).rejects.toThrow('not a file sent to this device')
    expect(engine!.sent.some((t) => t.includes('steal'))).toBe(false)
  })

  it('chat-send with files keeps its place: a later plain send of the same tab waits behind it', async () => {
    receiver = new FileReceiver({ root })
    a.ctx.receiver = receiver
    await attach()
    const [path] = await copyToHost('ordered.txt', Buffer.from('abc'))
    let open!: () => void
    attachGate = new Promise<void>((resolve) => {
      open = resolve
    })

    const first = actions.chatSend(T1, { text: 'first', attachments: [attachmentOf(path, 3)] })
    const second = actions.chatSend(T1, { text: 'second', attachments: [] })
    await new Promise((resolve) => setTimeout(resolve, 100))
    attachGate = null
    open()

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    await until(() => engine!.sent.length >= 2)
    expect(engine!.sent.findIndex((t) => t.startsWith('first'))).toBeLessThan(engine!.sent.findIndex((t) => t === 'second'))
  })

  it('a member that leaves takes its copied files with it: after it links again, a message naming one is refused', async () => {
    receiver = new FileReceiver({ root })
    a.ctx.receiver = receiver
    await attach()
    const [path] = await copyToHost('keep.txt', Buffer.from('kept'))
    await expect(actions.chatSend(T1, { text: 'first', attachments: [attachmentOf(path, 4)] })).resolves.toBeNull()

    // the member's link goes away: the host forgets what the member copied
    links.client.close('member left')
    await until(() => viewerB.online(A_ID) === false)
    await connect()
    await until(() => viewerB.online(A_ID))

    await expect(actions.chatSend(T1, { text: 'again', attachments: [attachmentOf(path, 4)] })).resolves.toBe('not a file sent to this device')
  })

  it('a call for a shell tab is refused: not a chat tab', async () => {
    await attach()
    await expect(actions.chatSend(T2, { text: 'hi', attachments: [] })).resolves.toBe('not a chat tab')
    await expect(viewerB.callsOf(A_ID)!.call('chat-interrupt', { id: T2 })).rejects.toThrow('not a chat tab')
    await expect(actions.chatOlder(T2, 'any-id')).resolves.toBeNull()
  })

  it('a Claude tab in its terminal view, and a tab that is not on this device, are refused by the chat calls', async () => {
    await attach()
    const calls = viewerB.callsOf(A_ID)!
    const answer = { type: 'dialog', choice: null }
    for (const tab of [T3, T9]) {
      await expect(calls.call('chat-send', { id: tab, text: 'x', attachments: [] })).rejects.toThrow('not a chat tab')
      await expect(calls.call('chat-answer', { id: tab, cardId: 'card-1', answer })).rejects.toThrow('not a chat tab')
      await expect(calls.call('chat-older', { id: tab, beforeId: 'item-1' })).rejects.toThrow('not a chat tab')
    }
  })

  it('chat-terminal: a line with control characters is refused and nothing is typed; a printable line is typed', async () => {
    await attach()
    const calls = viewerB.callsOf(A_ID)!
    await expect(calls.call('chat-terminal', { id: T1, line: 'a\r' })).rejects.toThrow(NO_TERMINAL)
    await expect(calls.call('chat-terminal', { id: T1, line: '\u001b[31mred' })).rejects.toThrow(NO_TERMINAL)
    expect(typed).toEqual([])

    await expect(calls.call('chat-terminal', { id: T1, line: 'ls' })).resolves.toEqual({})
    expect(typed).toEqual(['ls', '\r'])
  })

  it('chat-mode: a mode the host does not offer is refused; one it offers is set', async () => {
    await attach()
    const calls = viewerB.callsOf(A_ID)!
    await expect(calls.call('chat-mode', { id: T1, mode: 'bypassPermissions' })).rejects.toThrow(NO_MODE)
    await expect(calls.call('chat-mode', { id: T1, mode: 'dontAsk' })).rejects.toThrow(NO_MODE)
    await expect(calls.call('chat-mode', { id: T1, mode: 'acceptEdits' })).resolves.toEqual({})
  })

  it('chat-older: an older page of the chat comes back; a tab with no chat gives none', async () => {
    await attach()
    await expect(actions.chatOlder(T1, 'no-such-item')).resolves.toEqual({ items: [], hasOlder: false })
    await expect(actions.chatOlder(T2, 'no-such-item')).resolves.toBeNull()
  })

  it('a refused chat-view or chat-terminal says nothing here: the caller shows the one message', async () => {
    const toasts: string[] = []
    const quiet = new RemoteActions(viewerB, (m) => toasts.push(m), () => {})
    await attach()
    await expect(quiet.chatView(T2, 'terminal')).resolves.toBe(false)
    await expect(quiet.chatTerminal(T2, 'ls')).resolves.toBe(false)
    expect(toasts).toEqual([])
  })

  it('chat-modes: a member is offered the modes its host tab offers, Auto once Claude Code reports it; a tab the host refuses gives none', async () => {
    await attach()
    await expect(actions.chatModes(T1)).resolves.toEqual(['default', 'acceptEdits', 'plan'])
    engine!.h.message({ type: 'system', subtype: 'status', permissionMode: 'auto' })
    await expect(actions.chatModes(T1)).resolves.toEqual(['default', 'acceptEdits', 'plan', 'auto'])
    await expect(actions.chatModes(T2)).resolves.toBeNull()
  })

  it('chat-older: a host page over the cap reaches the member within the cap, ends at the item before beforeId, and paging on reaches the first item', async () => {
    await attach()
    // 460 messages of 15 KiB: the newest 200 make the snapshot, and the page before the newest item is 3 MiB of JSON
    const body = 'x'.repeat(15 * 1024)
    for (let i = 0; i < 460; i++) await hub.send(T1, { text: `${i} ${body}`, attachments: [] })
    // the member is where the host is. Not the same as a whole: the host's snapshot is cut to the push limit, while the member's
    // copy, moved on by batches, keeps the older items it had; which of the two came last depends on how the sends were batched
    await until(() => {
      const member = viewerB.chatSnapshot(T1)
      const host = hub.remoteSnapshot(T1)
      return member !== null && host !== null && member.rev === host.rev && member.items.at(-1)?.id === host.items.at(-1)?.id
    })
    const beforeId = hub.remoteSnapshot(T1)!.items.at(-1)!.id
    const expectedEnd = hub.older(T1, beforeId)!.items.at(-1)!.id

    const first = await actions.chatOlder(T1, beforeId)
    expect(first).not.toBeNull()
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(MAX_CHAT_PUSH_BYTES)
    expect(first!.hasOlder).toBe(true)
    expect(first!.items.at(-1)?.id).toBe(expectedEnd)

    // paging back from the oldest item kept reaches the first message of the chat
    const older: ChatItem[] = [...first!.items]
    let page = first
    for (let n = 0; n < 10 && page && page.hasOlder && page.items.length > 0; n++) {
      page = await actions.chatOlder(T1, page.items[0].id)
      if (page) older.unshift(...page.items)
    }
    expect(page?.hasOlder).toBe(false)
    expect(older[0]).toMatchObject({ kind: 'user', text: `0 ${body}` })
  })

  it("a malformed call is refused, and the host's chat is unaffected", async () => {
    await attach()
    await hub.send(T1, { text: 'still here', attachments: [] })
    await settleSends()
    const calls = viewerB.callsOf(A_ID)!
    await expect(calls.call('chat-send', { id: T1, text: 5, attachments: [] })).rejects.toThrow('bad arguments')
    await expect(calls.call('chat-mode', { id: T1, mode: 'bogus' })).rejects.toThrow('bad arguments')
    await expect(calls.call('chat-older', { id: T1 })).rejects.toThrow('bad arguments')
    await settleSends()
    expect(viewerB.chatSnapshot(T1)!.items.map((i) => i.kind)).toEqual(['user'])
  })
})

describe("a member's refused chat pushes", () => {
  it('a chat push the member cannot check is logged once per tab and kind, and the chat stays as it was', async () => {
    await attach()
    const bad = { fromRev: 0, toRev: 1, patches: [{ op: 'no-such-op' }] }
    hostA.push(T1, 'chat-patch', bad)
    await until(() => logs.length > 0)
    hostA.push(T1, 'chat-patch', bad)
    hostA.push(T1, 'chat-patch', bad)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(logs.filter((m) => m.includes(T1) && m.includes('chat-patch'))).toHaveLength(1)
    expect(logs[0]).toContain('refused')
  })
})

describe('a watched chat that starts again', () => {
  it('the member converges to the host: the new chat comes as a snapshot, which the window reloads', async () => {
    await attach()
    await hub.send(T1, { text: 'before the restart', attachments: [] })
    await settleSends()
    const reloadsBefore = reloads.length
    const previous = engine
    // what index.ts does at a start (startChat): the chat starts, and the members that watch the tab take its snapshot at once
    hub.start({ tab: a.infos.get(T1)!, claude: { command: 'claude', settingsPath: null, resumeSessionId: null, forkSession: false }, env: {}, exit: () => {} })
    hostA.push(T1, 'chat', hub.remoteSnapshot(T1))
    await until(() => engine !== previous && engine !== null)
    engine!.h.ready({ permissionMode: 'default' })
    engine!.h.message(init)
    await until(() => reloads.length > reloadsBefore)
    await settleSends()
    expect(sameAsHost()).toBe(true)
    expect(viewerB.chatSnapshot(T1)?.items.some((i) => i.kind === 'user')).toBe(false)
  })
})

describe("the host's pushes of a chat", () => {
  it("the batch of a chat is the host's patches in order, and only the watched tab's", async () => {
    await attach()
    await settleSends()
    chats.length = 0
    await hub.send(T1, { text: 'one', attachments: [] })
    await hub.send(T1, { text: 'two', attachments: [] })
    await settleSends()
    expect(chats.flatMap(([, , , patches]) => patches).filter((p) => p.op === 'add').length).toBeGreaterThanOrEqual(2)
    expect(chats.every(([tabId]) => tabId === T1)).toBe(true)
  })
})
