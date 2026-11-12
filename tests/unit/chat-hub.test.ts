import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatHub, type ChatHubDeps } from '../../src/main/chat/chat-hub'
import { ChatMirror } from '../../src/main/chat/chat-mirror'
import { attachmentOf } from '../../src/main/chat/chat-attachments'
import type { ChatEngine, ChatEngineHandlers, ChatEngineStart } from '../../src/main/chat/chat-engine'
import type { ChatCommandInfo, ChatModelInfo, ChatPatch, ChatPermissionMode } from '../../src/shared/chat'
import type { ImageCard, TabInfo } from '../../src/shared/types'
import type { ChatStartRequest } from '../../src/main/tab-manager'
import { fixtureHistory } from '../fixtures/chat-fixtures'

const TAB = 'tab-1'
const WORK = '/work/acme'
const SID = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const LAUNCH = { how: 'direct', file: '/usr/bin/claude' } as const

type ChatStatus = Parameters<ChatHubDeps['status']>[1]

/** a Claude tab in the work folder */
function tabInfo(id = TAB): TabInfo {
  return {
    id, kind: 'claude', profile: 'default', cwd: WORK, folder: WORK, customTitle: null, claudeSessionId: null,
    account: null, muted: false, fork: null, exited: false, activity: null, view: 'chat',
  } as TabInfo
}

/** a start request for a Claude tab, resuming `resume` when given; `exit` records the process's end */
function startReq(resume: string | null = null, id = TAB): { req: ChatStartRequest; exit: ReturnType<typeof vi.fn> } {
  const exit = vi.fn()
  const req: ChatStartRequest = {
    tab: tabInfo(id), claude: { command: 'claude', settingsPath: null, resumeSessionId: resume, forkSession: false }, env: {}, exit,
  }
  return { req, exit }
}

/** a stand-in for the engine: it records what the hub asks of it and lets the test emit messages */
class FakeEngine implements ChatEngine {
  sent: string[] = []
  images: { mediaType: string; data: string }[][] = []
  interrupts = 0
  modes: ChatPermissionMode[] = []
  modelsSet: (string | null)[] = []
  efforts: (string | null)[] = []
  effortFails = false
  cmds: ChatCommandInfo[] = []
  closes = 0
  kills = 0
  pct: number | null = 37

  constructor(readonly start: ChatEngineStart, readonly h: ChatEngineHandlers) {}

  send(text: string, images: { mediaType: string; data: string }[] = []): void {
    this.sent.push(text)
    this.images.push(images)
  }

  async interrupt(): Promise<void> {
    this.interrupts++
  }

  async setPermissionMode(mode: ChatPermissionMode): Promise<void> {
    this.modes.push(mode)
  }

  async setModel(model: string | null): Promise<void> {
    this.modelsSet.push(model)
  }

  async setEffort(effort: string | null): Promise<void> {
    if (this.effortFails) throw new Error('unknown effort level')
    this.efforts.push(effort)
  }

  async stopTask(): Promise<void> {}

  async commands(): Promise<ChatCommandInfo[]> {
    return this.cmds
  }

  async models(): Promise<ChatModelInfo[]> {
    return []
  }

  async context(): Promise<{ pct: number | null; used: number | null; size: number | null }> {
    return { pct: this.pct, used: null, size: null }
  }

  close(): void {
    this.closes++
  }

  kill(): void {
    this.kills++
  }
}

/** the files the window may attach: a stat and a read of `files`; a scaler that keeps the image as it is */
function fakeAttach(files: Map<string, Buffer>): ChatHubDeps['attach'] {
  return {
    stat: async p => {
      const data = files.get(p)
      return data ? { size: data.length, isFile: true } : null
    },
    read: async p => files.get(p) ?? Buffer.alloc(0),
    scale: async (data, mediaType) => ({ data, mediaType }),
  }
}

/** a hub with fake dependencies: the engines it started, the window's batches, and what it told the tabs */
function harness(over: Partial<Pick<ChatHubDeps, 'support' | 'history'>> & { attach?: (files: Map<string, Buffer>) => ChatHubDeps['attach'] } = {}) {
  const clock = { t: 1000 }
  const engines: FakeEngine[] = []
  const windows: { tabId: string; fromRev: number; toRev: number; patches: ChatPatch[] }[] = []
  /** the batches sent to the members of the tabs they watch, and the tabs watched */
  const remotes: { tabId: string; fromRev: number; toRev: number; patches: ChatPatch[] }[] = []
  const watched = new Set<string>()
  const calls = {
    setSession: [] as [string, string][],
    setWorking: [] as [string, boolean][],
    status: [] as [string, ChatStatus][],
    recorded: [] as string[],
    warn: [] as string[],
  }
  const env = { active: TAB as string | null }
  /** the tabs the app still has: a tab taken out of it is not there for a note */
  const alive = new Set<string>([TAB])
  const cards = new Map<string, ImageCard[]>()
  const files = new Map<string, Buffer>()
  const deps: ChatHubDeps = {
    cards: tabId => cards.get(tabId) ?? [],
    engine: (o, h) => {
      const engine = new FakeEngine(o, h)
      engines.push(engine)
      return engine
    },
    support: over.support ?? (async () => ({ launch: LAUNCH })),
    history: over.history ?? (async () => []),
    window: (tabId, fromRev, toRev, patches) => {
      windows.push({ tabId, fromRev, toRev, patches })
    },
    remote: (tabId, fromRev, toRev, patches) => {
      remotes.push({ tabId, fromRev, toRev, patches })
    },
    watched: tabId => watched.has(tabId),
    activeTabId: () => env.active,
    exists: tabId => alive.has(tabId),
    setSession: (tabId, sessionId) => calls.setSession.push([tabId, sessionId]),
    setWorking: (tabId, working) => calls.setWorking.push([tabId, working]),
    status: (tabId, s) => calls.status.push([tabId, s]),
    recordSession: sessionId => calls.recorded.push(sessionId),
    attach: over.attach ? over.attach(files) : fakeAttach(files),
    now: () => clock.t,
    log: { warn: m => calls.warn.push(m) },
  }
  return { hub: new ChatHub(deps), engines, windows, remotes, watched, calls, env, cards, files, alive }
}

/** an assistant message that reads one file: a Read of an image shows it in the chat */
/** a 1x1 PNG's signature and IHDR: the header the main process reads the size from before it decodes an image */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1])

const readFile = (path: string): Record<string, unknown> => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `read-${path}`, name: 'Read', input: { file_path: path } }] },
})

/** a Media-panel card of the tab, for a path */
const card = (id: string, path: string, deleted = false): ImageCard => ({
  id, tabId: TAB, path, name: 'shot.png', relPath: 'shot.png', source: 'read', kind: 'image', caption: null, touchedAt: 0, version: 1, updated: false, deleted,
})

/** the images item of the patches, when they carry one */
const imagesItem = (patches: ChatPatch[]) => patches.flatMap(p => (p.op === 'add' || p.op === 'set' ? [p.item] : [])).find(item => item.kind === 'images')

// Windows paths compare without case and with either separator; elsewhere only the same path matches
const SHOWN = process.platform === 'win32' ? 'C:\\work\\acme\\Shot.png' : '/work/acme/Shot.png'
const KNOWN = process.platform === 'win32' ? 'c:/WORK/acme/shot.PNG' : '/work/acme/Shot.png'

/** an SDK init message as Claude Code sends it at the start of every turn */
const init = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5', permissionMode: 'default', ...extra,
})

const result = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'result', subtype: 'success', is_error: false, result: 'done', ...extra,
})

/** lets the pending promise callbacks of the hub run */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const last = <T>(list: T[]): T => list[list.length - 1]

describe('ChatHub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a resumed tab draws its history before the process is up', async () => {
    const { hub, engines } = harness({
      support: () => new Promise(() => {}),
      history: async () => fixtureHistory().slice(0, 3),
    })
    const { req } = startReq(SID)
    hub.start(req)
    await settle()

    expect(engines).toHaveLength(0)
    const snap = hub.snapshot(TAB)
    expect(snap).not.toBeNull()
    const kinds = snap!.items.map(item => item.kind)
    expect(kinds).toContain('user')
    expect(kinds).toContain('text')
    expect(last(snap!.items)).toMatchObject({ kind: 'notice', text: 'Starting Claude…' })
  })

  it('support failing falls back with its reason', async () => {
    const { hub, engines } = harness({ support: async () => ({ reason: 'Claude Code is too old' }) })
    const { req, exit } = startReq()
    hub.start(req)
    await settle()

    expect(engines).toHaveLength(0)
    expect(exit).toHaveBeenCalledWith(null, 'Claude Code is too old')
  })

  it('init records and reports the session', async () => {
    const { hub, engines, calls } = harness()
    const { req } = startReq()
    hub.start(req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    expect(calls.setSession).toEqual([[TAB, SID]])
    expect(calls.recorded).toEqual([SID])
    expect(calls.status).toContainEqual([TAB, expect.objectContaining({ model: 'claude-haiku-5-5' })])
    expect(hub.snapshot(TAB)?.state.sessionId).toBe(SID)
  })

  it('patches for the tab in front go out at most every 16 ms, others never', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    hub.start(startReq(null, 'tab-2').req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    engines[1].h.message(init())

    expect(windows).toHaveLength(0)
    vi.advanceTimersByTime(16)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ tabId: TAB, fromRev: 0 })

    await hub.send(TAB, { text: 'first', attachments: [] })
    vi.advanceTimersByTime(15)
    expect(windows).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(windows).toHaveLength(2)
    expect(windows[1].fromRev).toBe(windows[0].toRev)
    expect(windows.every(w => w.tabId === TAB)).toBe(true)
  })

  it('a watched tab gathers its patches for the members every 50 ms, while another tab is in front', async () => {
    const { hub, engines, windows, remotes, watched, env } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    watched.add(TAB)
    env.active = 'tab-2'

    engines[0].h.message(init())
    // nothing goes out at the window's 16 ms, and nothing goes to the window: the tab is not in front
    vi.advanceTimersByTime(16)
    expect(remotes).toHaveLength(0)
    expect(windows).toHaveLength(0)
    vi.advanceTimersByTime(34)
    expect(remotes).toHaveLength(1)
    // the batch counts from the revision the member started watching at, and ends at the chat's revision
    expect(remotes[0]).toMatchObject({ tabId: TAB, toRev: hub.snapshot(TAB)!.rev })
    expect(remotes[0].toRev - remotes[0].fromRev).toBe(remotes[0].patches.length)
    expect(windows).toHaveLength(0)
  })

  it('a watched tab in front sends its patches to the window as before and to the members too', async () => {
    const { hub, engines, windows, remotes, watched } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    watched.add(TAB)
    engines[0].h.message(init())

    vi.advanceTimersByTime(16)
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ tabId: TAB, fromRev: 0 })
    vi.advanceTimersByTime(34)
    expect(remotes).toHaveLength(1)
    // the members get the patches from the moment they watch the tab: the window's batch ends with the same ones
    expect(remotes[0].toRev).toBe(windows[0].toRev)
    expect(windows[0].patches.slice(windows[0].patches.length - remotes[0].patches.length)).toEqual(remotes[0].patches)
  })

  it('patches of a tab nobody watches and nobody has in front go nowhere', async () => {
    const { hub, engines, remotes, windows, env } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    env.active = 'tab-2'
    engines[0].h.message(init())
    vi.advanceTimersByTime(200)
    expect(remotes).toHaveLength(0)
    expect(windows).toHaveLength(0)
  })

  it('remoteSnapshot is the chat as a push takes it, and null for a tab with no chat', async () => {
    const { hub, engines } = harness()
    expect(hub.remoteSnapshot(TAB)).toBeNull()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    expect(hub.remoteSnapshot(TAB)).toEqual(hub.snapshot(TAB))
    expect(hub.remoteSnapshot(TAB)).toMatchObject({ tabId: TAB, hasOlder: false })
  })

  it('an ask becomes a card and the answer goes back', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    const ctl = new AbortController()
    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, ctl.signal)
    const card = last(hub.snapshot(TAB)!.items)
    expect(card).toMatchObject({ kind: 'card', answered: null, card: { type: 'permission', tool: 'Bash' } })

    expect(hub.answer(TAB, card.id, { type: 'permission', choice: 'once', suggestion: null, message: null })).toBe(true)
    await expect(decided).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(last(hub.snapshot(TAB)!.items)).toMatchObject({ kind: 'card', answered: 'Allowed: run a command' })
  })

  it('a stray second answer is refused', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    const ctl = new AbortController()
    void engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, ctl.signal)
    const card = last(hub.snapshot(TAB)!.items)
    const deny = { type: 'permission', choice: 'deny', suggestion: null, message: 'no' } as const
    expect(hub.answer(TAB, card.id, deny)).toBe(true)
    expect(hub.answer(TAB, card.id, deny)).toBe(false)
  })

  it('an exit cancels a waiting card and says Claude Code stopped', async () => {
    const { hub, engines } = harness()
    const { req, exit } = startReq()
    hub.start(req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    const ctl = new AbortController()
    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, ctl.signal)
    engines[0].h.exit(1)

    await expect(decided).resolves.toEqual({ behavior: 'deny', message: 'Cancelled' })
    expect(exit).toHaveBeenCalledWith(1, null)
    const items = hub.snapshot(TAB)!.items
    expect(items.find(item => item.kind === 'card')).toMatchObject({ answered: 'Cancelled' })
    expect(last(items)).toMatchObject({ kind: 'notice', tone: 'error', text: 'Claude Code stopped', action: 'restart' })
    expect(hub.snapshot(TAB)!.state).toMatchObject({ exited: true, turn: 'idle' })
  })

  it('sessionChanged with clear draws New conversation', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    hub.sessionChanged(TAB, OTHER, 'clear')
    expect(last(hub.snapshot(TAB)!.items)).toMatchObject({ kind: 'divider', text: 'New conversation' })
    expect(hub.snapshot(TAB)!.state.sessionId).toBe(OTHER)
  })

  it('send to a tab with no chat is refused', async () => {
    const { hub, engines } = harness()

    expect(await hub.send(TAB, { text: 'hello', attachments: [] })).toBe('Claude Code is not running in this tab')
    expect(engines).toHaveLength(0)
    expect(hub.snapshot(TAB)).toBeNull()
  })

  it('a message sent while Claude Code starts goes out once it runs', async () => {
    let go: (s: { launch: typeof LAUNCH }) => void = () => undefined
    const { hub, engines } = harness({ support: () => new Promise(resolve => { go = resolve }) })
    hub.start(startReq().req)
    await settle()

    expect(await hub.send(TAB, { text: 'first', attachments: [] })).toBeNull()
    expect(await hub.send(TAB, { text: 'second', attachments: [] })).toBeNull()
    // the bubbles are shown at once, before the process is up
    expect(hub.snapshot(TAB)!.items.flatMap(item => (item.kind === 'user' ? [item.text] : []))).toEqual(['first', 'second'])
    expect(engines).toHaveLength(0)

    go({ launch: LAUNCH })
    await settle()
    expect(engines[0].sent).toEqual(['first', 'second'])
  })

  it('a message sent before a failed start says it was not sent', async () => {
    let go: (s: { reason: string }) => void = () => undefined
    const { hub } = harness({ support: () => new Promise(resolve => { go = resolve }) })
    const { req, exit } = startReq()
    hub.start(req)
    await settle()

    expect(await hub.send(TAB, { text: 'lost', attachments: [] })).toBeNull()
    go({ reason: 'Claude Code is too old' })
    await settle()

    expect(exit).toHaveBeenCalledWith(null, 'Claude Code is too old')
    const items = hub.snapshot(TAB)!.items
    expect(items).toContainEqual(expect.objectContaining({ kind: 'notice', tone: 'error', text: 'Not sent: Claude Code did not start', action: null }))
    expect(items.filter(item => item.kind === 'notice' && item.text.startsWith('Not sent'))).toHaveLength(1)
  })

  it('a message already handed to the engine before a failed start says it was not sent', async () => {
    const { hub, engines } = harness()
    const { req, exit } = startReq()
    hub.start(req)
    await settle()
    // the engine exists, Claude Code is not ready yet: the message went to it, and Claude Code never took it
    expect(await hub.send(TAB, { text: 'handed', attachments: [] })).toBeNull()
    expect(engines[0].sent).toEqual(['handed'])

    engines[0].h.stderr('sh: claude: not found\n')
    engines[0].h.exit(127)
    expect(exit).toHaveBeenCalledWith(null, 'Claude Code could not be started for the chat: sh: claude: not found')
    const items = hub.snapshot(TAB)!.items
    expect(items.filter(item => item.kind === 'notice' && item.text === 'Not sent: Claude Code did not start')).toHaveLength(1)
  })

  it('a snapshot does not take the window\'s patches', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    vi.advanceTimersByTime(16)
    windows.length = 0

    await hub.send(TAB, { text: 'one', attachments: [] })
    hub.snapshot(TAB)
    vi.advanceTimersByTime(16)

    expect(windows.flatMap(w => w.patches)).toContainEqual(expect.objectContaining({ op: 'add', item: expect.objectContaining({ kind: 'user', text: 'one' }) }))
  })

  it('a waiting card keeps the tab working', async () => {
    const { hub, engines, calls } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    await hub.send(TAB, { text: 'write it', attachments: [] })
    expect(last(calls.setWorking)).toEqual([TAB, true])

    const ctl = new AbortController()
    const decided = engines[0].h.ask({ toolName: 'Write', input: { file_path: `${WORK}/a.txt`, content: 'x' } }, ctl.signal)
    expect(last(calls.setWorking)).toEqual([TAB, true])

    const card = last(hub.snapshot(TAB)!.items)
    hub.answer(TAB, card.id, { type: 'permission', choice: 'once', suggestion: null, message: null })
    await decided
    engines[0].h.message(result())
    expect(last(calls.setWorking)).toEqual([TAB, false])
  })

  it('Starting ends when Claude Code is ready, before any message', async () => {
    const { hub, engines, windows, calls } = harness()
    hub.start(startReq().req)
    const starting = last(hub.snapshot(TAB)!.items)
    expect(starting).toMatchObject({ kind: 'notice', tone: 'info', text: 'Starting Claude…', action: null })

    await settle()
    // Claude Code answers initialize; it sends no init until a turn starts
    engines[0].h.ready({ permissionMode: 'default' })
    vi.advanceTimersByTime(16)
    expect(windows.flatMap(w => w.patches)).toContainEqual({ op: 'remove', id: starting.id })
    const snap = hub.snapshot(TAB)!
    expect(snap.items.some(item => item.id === starting.id)).toBe(false)
    expect(snap.state).toMatchObject({ exited: false, model: null })
    expect(calls.setWorking).toEqual([])
  })

  it('ready takes the permission mode Claude Code reports, and keeps the default for one it does not know', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'plan' })
    expect(hub.snapshot(TAB)!.state.mode).toBe('plan')

    const second = harness()
    second.hub.start(startReq(null, 'tab-2').req)
    await settle()
    second.engines[0].h.ready({ permissionMode: 'no-such-mode' })
    expect(second.hub.snapshot('tab-2')!.state.mode).toBe('default')
  })

  it('a SessionStart for the session the tab started draws no divider', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    const id = engines[0].start.newSessionId
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    hub.sessionChanged(TAB, id, 'startup')
    expect(hub.snapshot(TAB)!.items.some(item => item.kind === 'divider')).toBe(false)
    expect(hub.snapshot(TAB)!.state.sessionId).toBe(id)
  })

  it('a resumed chat names its session before any message', async () => {
    const { hub } = harness({ history: async () => [] })
    hub.start(startReq(SID).req)
    await settle()
    expect(hub.snapshot(TAB)!.state.sessionId).toBe(SID)
  })

  it('an init with a session id that is not a UUID is ignored', async () => {
    const { hub, engines, calls } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init({ session_id: 'not-a-uuid' }))

    expect(calls.setSession).toEqual([])
    expect(calls.recorded).toEqual([])
    expect(hub.snapshot(TAB)!.state.sessionId).not.toBe('not-a-uuid')
  })

  it('Claude Code not found before it is ready falls back to the terminal', async () => {
    const { hub, engines } = harness()
    const { req, exit } = startReq()
    hub.start(req)
    await settle()
    engines[0].h.stderr('sh: claude: not found\nsecond line\n')
    engines[0].h.exit(127)

    expect(exit).toHaveBeenCalledWith(null, 'Claude Code could not be started for the chat: sh: claude: not found')
    expect(hub.snapshot(TAB)!.items.some(item => item.kind === 'notice' && item.text === 'Claude Code stopped')).toBe(false)
  })

  it('another exit before ready shows Claude Code stopped', async () => {
    const { hub, engines } = harness()
    const { req, exit } = startReq()
    hub.start(req)
    await settle()
    engines[0].h.exit(1)

    expect(exit).toHaveBeenCalledWith(1, null)
    expect(last(hub.snapshot(TAB)!.items)).toMatchObject({ kind: 'notice', tone: 'error', text: 'Claude Code stopped', action: 'restart' })
  })

  it('older answers the page before an item and changes no revision', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    for (let i = 0; i < 450; i++) {
      engines[0].h.message({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000 })
    }
    vi.advanceTimersByTime(16)

    const first = hub.snapshot(TAB)!.items[0]
    const rev = hub.snapshot(TAB)!.rev
    windows.length = 0
    const page = hub.older(TAB, first.id)
    vi.advanceTimersByTime(16)
    expect(page).toMatchObject({ hasOlder: true })
    expect(page!.items).toHaveLength(200)
    expect(hub.snapshot(TAB)!.rev).toBe(rev)
    expect(windows.flatMap(w => w.patches)).toEqual([])
  })

  it('older for a tab that is not running is null', async () => {
    const { hub } = harness()
    expect(hub.older('no-such-tab', 'x')).toBeNull()
  })

  it('interrupt marks the turn and asks the engine', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    await hub.send(TAB, { text: 'count to a million', attachments: [] })
    hub.interrupt(TAB)
    expect(engines[0].interrupts).toBe(1)

    engines[0].h.message(result({ subtype: 'error_during_execution', is_error: true, result: '' }))
    const items = hub.snapshot(TAB)!.items
    expect(items.some(item => item.kind === 'notice' && item.text === 'Interrupted')).toBe(true)
    expect(items.some(item => item.kind === 'notice' && item.tone === 'error')).toBe(false)
  })

  it('context is read after each result and reported', async () => {
    const { hub, engines, calls } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    engines[0].pct = 37
    engines[0].h.message(result())
    await settle()

    expect(last(calls.status)).toEqual([TAB, expect.objectContaining({ contextPct: 37 })])
    expect(hub.snapshot(TAB)).not.toBeNull()
  })

  it('a queued ask settles Cancelled when the process exits before the history arrives', async () => {
    const { hub, engines } = harness({ history: () => new Promise(() => {}) })
    hub.start(startReq(SID).req)
    await settle()

    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, new AbortController().signal)
    engines[0].h.exit(1)
    await expect(decided).resolves.toEqual({ behavior: 'deny', message: 'Cancelled' })
  })

  it('a queued ask settles Cancelled when its tab is removed before the history arrives', async () => {
    const { hub, engines } = harness({ history: () => new Promise(() => {}) })
    hub.start(startReq(SID).req)
    await settle()

    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, new AbortController().signal)
    hub.removeTab(TAB)
    await expect(decided).resolves.toEqual({ behavior: 'deny', message: 'Cancelled' })
  })

  it('history that arrives after an unasked exit is still drawn, then the stop notice', async () => {
    let release!: (messages: unknown[]) => void
    const { hub, engines } = harness({ history: () => new Promise(resolve => { release = resolve }) })
    const { req, exit } = startReq(SID)
    hub.start(req)
    await settle()

    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, new AbortController().signal)
    engines[0].h.exit(1)
    await expect(decided).resolves.toEqual({ behavior: 'deny', message: 'Cancelled' })
    expect(exit).toHaveBeenCalledWith(1, null)

    release(fixtureHistory().slice(0, 3))
    await settle()
    const items = hub.snapshot(TAB)!.items
    const userAt = items.findIndex(item => item.kind === 'user')
    expect(userAt).toBeGreaterThanOrEqual(0)
    expect(last(items)).toMatchObject({ kind: 'notice', tone: 'error', text: 'Claude Code stopped' })
    expect(items.indexOf(last(items))).toBeGreaterThan(userAt)
    expect(hub.snapshot(TAB)!.state.exited).toBe(true)
  })

  it('an ask aborted while queued behind the history resolves Cancelled', async () => {
    const { hub, engines } = harness({ history: () => new Promise(() => {}) })
    hub.start(startReq(SID).req)
    await settle()

    const ctl = new AbortController()
    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, ctl.signal)
    ctl.abort()
    await expect(decided).resolves.toEqual({ behavior: 'deny', message: 'Cancelled' })
  })

  it('an ask whose signal aborts cancels its card once', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    const ctl = new AbortController()
    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, ctl.signal)
    const card = last(hub.snapshot(TAB)!.items)
    ctl.abort()
    await expect(decided).resolves.toEqual({ behavior: 'deny', message: 'Cancelled' })
    expect(last(hub.snapshot(TAB)!.items)).toMatchObject({ kind: 'card', id: card.id, answered: 'Cancelled' })
    expect(hub.answer(TAB, card.id, { type: 'permission', choice: 'once', suggestion: null, message: null })).toBe(false)
    ctl.abort()
    expect(hub.snapshot(TAB)!.items.filter(item => item.kind === 'card')).toHaveLength(1)
  })

  it('an answer after the process exits is refused', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, new AbortController().signal)
    const card = last(hub.snapshot(TAB)!.items)
    engines[0].h.exit(0)
    await expect(decided).resolves.toEqual({ behavior: 'deny', message: 'Cancelled' })
    expect(hub.answer(TAB, card.id, { type: 'permission', choice: 'once', suggestion: null, message: null })).toBe(false)
  })

  it('removeTab with a card open resolves it Cancelled', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, new AbortController().signal)
    hub.removeTab(TAB)
    await expect(decided).resolves.toEqual({ behavior: 'deny', message: 'Cancelled' })
  })

  it('an exit the tab asked for by stop adds no error notice', async () => {
    const { hub, engines } = harness()
    const { req, exit } = startReq()
    const handle = hub.start(req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    handle.stop()
    expect(engines[0].closes).toBe(1)
    engines[0].h.exit(0)
    expect(exit).toHaveBeenCalledWith(0, null)
    expect(hub.snapshot(TAB)!.items.some(item => item.kind === 'notice' && item.text === 'Claude Code stopped')).toBe(false)
    expect(hub.snapshot(TAB)!.state.exited).toBe(true)
  })

  it('an exit after kill adds no error notice', async () => {
    const { hub, engines } = harness()
    const { req, exit } = startReq()
    const handle = hub.start(req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    handle.kill()
    expect(engines[0].kills).toBe(1)
    engines[0].h.exit(null)
    expect(exit).toHaveBeenCalledWith(null, null)
    expect(hub.snapshot(TAB)!.items.some(item => item.kind === 'notice' && item.text === 'Claude Code stopped')).toBe(false)
  })

  it('older with an unknown id or an empty page gives no items and sends no patch', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    for (let i = 0; i < 3; i++) {
      engines[0].h.message({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000 })
    }
    vi.advanceTimersByTime(16)
    windows.length = 0

    expect(hub.older(TAB, 'no-such-id')).toEqual({ items: [], hasOlder: false })
    expect(hub.older(TAB, hub.snapshot(TAB)!.items[0].id)).toEqual({ items: [], hasOlder: false })
    vi.advanceTimersByTime(16)
    expect(windows.flatMap(w => w.patches)).toEqual([])
  })

  it('a snapshot taken with a batch pending: the batch still goes, and the revs follow the snapshot', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    vi.advanceTimersByTime(16)
    windows.length = 0

    await hub.send(TAB, { text: 'one', attachments: [] })
    const snap = hub.snapshot(TAB)!
    await hub.send(TAB, { text: 'two', attachments: [] })
    vi.advanceTimersByTime(16)

    // one batch: the window's rev may already hold 'one' (the snapshot did), so it takes the batch by its end rev
    expect(windows).toHaveLength(1)
    expect(windows[0].toRev).toBe(snap.rev + 1)
    expect(windows[0].patches.at(-1)).toMatchObject({ op: 'add', item: { kind: 'user', text: 'two' } })
    expect(windows[0].patches).toContainEqual(expect.objectContaining({ op: 'add', item: expect.objectContaining({ kind: 'user', text: 'one' }) }))
  })

  it('an images item gets its card when the card comes later', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    engines[0].h.message(readFile(SHOWN))
    vi.advanceTimersByTime(16)
    const added = imagesItem(windows.flatMap(w => w.patches))
    expect(added).toMatchObject({ kind: 'images', images: [{ path: SHOWN, cardId: null }] })
    windows.length = 0

    hub.imagesChanged(TAB, [card('card-1', KNOWN)])
    vi.advanceTimersByTime(16)

    expect(windows.flatMap(w => w.patches)).toEqual([{ op: 'set', item: { kind: 'images', id: added?.id, images: [{ path: SHOWN, cardId: 'card-1' }] } }])
  })

  it('a deleted card is not taken', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    engines[0].h.message(readFile(SHOWN))
    vi.advanceTimersByTime(16)
    windows.length = 0

    hub.imagesChanged(TAB, [card('card-1', KNOWN, true)])
    vi.advanceTimersByTime(16)

    expect(windows.flatMap(w => w.patches)).toEqual([])
  })

  it('nothing changes, nothing is sent', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    engines[0].h.message(readFile(SHOWN))
    vi.advanceTimersByTime(16)
    windows.length = 0

    hub.imagesChanged(TAB, [card('card-2', '/work/acme/other.png')])
    vi.advanceTimersByTime(16)
    expect(windows.flatMap(w => w.patches)).toEqual([])

    hub.imagesChanged(TAB, [card('card-1', KNOWN)])
    hub.imagesChanged(TAB, [card('card-1', KNOWN)])
    vi.advanceTimersByTime(16)
    expect(windows.flatMap(w => w.patches).filter(p => p.op === 'set')).toHaveLength(1)
  })

  it('an image the chat shows after its card is known gets the card at once', async () => {
    const { hub, engines, windows, cards } = harness()
    cards.set(TAB, [card('card-1', KNOWN)])
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    engines[0].h.message(readFile(SHOWN))
    vi.advanceTimersByTime(16)

    const patches = windows.flatMap(w => w.patches)
    expect(patches.at(-1)).toEqual({ op: 'set', item: { kind: 'images', id: imagesItem(patches)?.id, images: [{ path: SHOWN, cardId: 'card-1' }] } })
  })

  it('a resumed chat\'s images take their cards from the history the window gets', async () => {
    const { hub, windows, cards } = harness({ history: async () => [readFile(SHOWN)] })
    cards.set(TAB, [card('card-1', KNOWN)])
    hub.start(startReq(SID).req)
    await settle()
    vi.advanceTimersByTime(16)

    // the chat's first reset carries the starting notice; the history's reset comes after it and carries the images
    const reset = windows.flatMap(w => w.patches).filter(p => p.op === 'reset').at(-1)
    expect(reset).toMatchObject({ op: 'reset', items: expect.arrayContaining([expect.objectContaining({ kind: 'images', images: [{ path: SHOWN, cardId: 'card-1' }] })]) })
  })

  it('a message whose attached file was not attached is refused at once: no bubble, nothing sent', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())

    const file = { kind: 'file' as const, path: `${WORK}/run.exe`, name: 'run.exe', size: 1, cardId: null }
    expect(await hub.send(TAB, { text: 'run', attachments: [file] })).toBe('Cannot attach run.exe: it was not attached in this window')
    expect(engines[0].sent).toEqual([])
    expect(hub.snapshot(TAB)!.items.filter(item => item.kind === 'user')).toEqual([])
  })

  it('an attached file goes to the engine as a mention after the text', async () => {
    const { hub, engines, files } = harness()
    const path = `${WORK}/tools/run.exe`
    files.set(path, Buffer.from('x'))
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    hub.allow(TAB, [attachmentOf(path, 1)])

    const file = { kind: 'file' as const, path, name: 'run.exe', size: 1, cardId: null }
    expect(await hub.send(TAB, { text: 'run it', attachments: [file] })).toBeNull()
    expect(engines[0].sent).toEqual(['run it\n\n@tools/run.exe'])
  })

  it('an attached image goes to the engine as an image block', async () => {
    const { hub, engines, files } = harness()
    const path = `${WORK}/shot.png`
    files.set(path, PNG_BYTES)
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    hub.allow(TAB, [attachmentOf(path, 1)])

    const image = { kind: 'image' as const, path, name: 'shot.png', size: 9, cardId: null }
    expect(await hub.send(TAB, { text: 'look', attachments: [image] })).toBeNull()
    expect(engines[0].sent).toEqual(['look'])
    expect(engines[0].images).toEqual([[{ mediaType: 'image/png', data: PNG_BYTES.toString('base64') }]])
  })

  it('an image sent while Claude Code starts is held with its image and sent once it runs', async () => {
    let go: (s: { launch: typeof LAUNCH }) => void = () => undefined
    const { hub, engines, files } = harness({ support: () => new Promise(resolve => { go = resolve }) })
    const path = `${WORK}/shot.png`
    files.set(path, PNG_BYTES)
    hub.start(startReq().req)
    await settle()
    hub.allow(TAB, [attachmentOf(path, 1)])

    const image = { kind: 'image' as const, path, name: 'shot.png', size: 9, cardId: null }
    expect(await hub.send(TAB, { text: 'look', attachments: [image] })).toBeNull()
    expect(engines).toHaveLength(0)

    go({ launch: LAUNCH })
    await settle()
    expect(engines[0].sent).toEqual(['look'])
    expect(engines[0].images).toEqual([[{ mediaType: 'image/png', data: PNG_BYTES.toString('base64') }]])
  })

  it('messages keep their order while an image is prepared', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    // a slow scaler: the image takes until the gate opens
    const { hub, engines, files } = harness({
      attach: files => ({ ...fakeAttach(files), scale: async (data, mediaType) => { await gate; return { data, mediaType } } }),
    })
    const path = `${WORK}/slow.png`
    files.set(path, PNG_BYTES)
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    hub.allow(TAB, [attachmentOf(path, 1)])

    const image = { kind: 'image' as const, path, name: 'slow.png', size: 9, cardId: null }
    const withImage = hub.send(TAB, { text: 'with image', attachments: [image] })
    const plain = hub.send(TAB, { text: 'plain', attachments: [] })
    await settle()
    // the plain message waits behind the image: nothing is shown or sent yet
    expect(hub.snapshot(TAB)!.items.filter(item => item.kind === 'user')).toEqual([])
    expect(engines[0].sent).toEqual([])

    release()
    expect(await withImage).toBeNull()
    expect(await plain).toBeNull()
    expect(hub.snapshot(TAB)!.items.flatMap(item => (item.kind === 'user' ? [item.text] : []))).toEqual(['with image', 'plain'])
    expect(engines[0].sent).toEqual(['with image', 'plain'])
  })

  it('a file attached to a tab is no longer allowed once the tab closes', async () => {
    const { hub, engines, files } = harness()
    const path = `${WORK}/run.exe`
    files.set(path, Buffer.from('x'))
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    hub.allow(TAB, [attachmentOf(path, 1)])

    hub.removeTab(TAB)
    hub.start(startReq().req)
    await settle()
    engines[1].h.ready({ permissionMode: 'default' })
    engines[1].h.message(init())

    const file = { kind: 'file' as const, path, name: 'run.exe', size: 1, cardId: null }
    expect(await hub.send(TAB, { text: 'run', attachments: [file] })).toBe('Cannot attach run.exe: it was not attached in this window')
    expect(engines[1].sent).toEqual([])
  })
  it('the bubble shows an attachment as main knows it, not the values the window sent', async () => {
    const { hub, engines, files } = harness()
    const path = `${WORK}/shot.png`
    files.set(path, PNG_BYTES)
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    hub.allow(TAB, [{ ...attachmentOf(path, 9), cardId: 'card-1' }])

    await hub.send(TAB, { text: 'look', attachments: [{ kind: 'image', path, name: 'evil.exe', size: 999, cardId: 'forged' }] })
    const user = hub.snapshot(TAB)!.items.find(item => item.kind === 'user')
    expect(user).toMatchObject({ attachments: [{ kind: 'image', path, name: 'shot.png', size: PNG_BYTES.length, cardId: 'card-1' }] })
  })

  it("another tab's attachment is refused", async () => {
    const { hub, engines, files } = harness()
    const path = `${WORK}/run.exe`
    files.set(path, Buffer.from('x'))
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    hub.start(startReq(null, 'tab-2').req)
    await settle()
    engines[1].h.ready({ permissionMode: 'default' })
    engines[1].h.message(init())
    hub.allow('tab-2', [attachmentOf(path, 1)])

    const file = { kind: 'file' as const, path, name: 'run.exe', size: 1, cardId: null }
    expect(await hub.send(TAB, { text: 'run', attachments: [file] })).toBe('Cannot attach run.exe: it was not attached in this window')
    expect(engines[0].sent).toEqual([])
  })

  it('a refusal while Claude Code starts leaves nothing held: only the later message is sent', async () => {
    let go: (s: { launch: typeof LAUNCH }) => void = () => undefined
    const { hub, engines } = harness({ support: () => new Promise(resolve => { go = resolve }) })
    hub.start(startReq().req)
    await settle()

    const file = { kind: 'file' as const, path: `${WORK}/run.exe`, name: 'run.exe', size: 1, cardId: null }
    expect(await hub.send(TAB, { text: 'refused', attachments: [file] })).toBe('Cannot attach run.exe: it was not attached in this window')
    expect(await hub.send(TAB, { text: 'later', attachments: [] })).toBeNull()

    go({ launch: LAUNCH })
    await settle()
    expect(engines[0].sent).toEqual(['later'])
    expect(hub.snapshot(TAB)!.items.flatMap(item => (item.kind === 'user' ? [item.text] : []))).toEqual(['later'])
  })

  it('a tab closed while its message is prepared sends nothing and does not throw', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { hub, engines, files } = harness({
      attach: files => ({ ...fakeAttach(files), scale: async (data, mediaType) => { await gate; return { data, mediaType } } }),
    })
    const path = `${WORK}/slow.png`
    files.set(path, PNG_BYTES)
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    hub.allow(TAB, [attachmentOf(path, 9)])

    const image = { kind: 'image' as const, path, name: 'slow.png', size: 9, cardId: null }
    const pending = hub.send(TAB, { text: 'late', attachments: [image] })
    hub.removeTab(TAB)
    release()
    expect(await pending).toBe('Claude Code is not running in this tab')
    expect(engines[0].sent).toEqual([])
  })

  it('ready with mode auto adds auto to the modes of the tab; without it the modes are the three of every tab', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    expect(hub.modes(TAB)).toEqual(['default', 'acceptEdits', 'plan'])
    engines[0].h.ready({ permissionMode: 'auto' })
    expect(hub.modes(TAB)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
  })

  it('a system status that reports mode auto adds auto to the modes; another mode does not', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message({ type: 'system', subtype: 'status', permissionMode: 'plan' })
    expect(hub.modes(TAB)).not.toContain('auto')
    engines[0].h.message({ type: 'system', subtype: 'status', permissionMode: 'auto' })
    expect(hub.modes(TAB)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
  })

  it('a command the tab folder defines as .claude/commands/<name>.md or .claude/skills/<name>/ is project; the others keep their group', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ct-hub-commands-'))
    try {
      mkdirSync(join(folder, '.claude', 'commands'), { recursive: true })
      mkdirSync(join(folder, '.claude', 'skills', 'review'), { recursive: true })
      writeFileSync(join(folder, '.claude', 'commands', 'deploy.md'), '# deploy\n')
      const { hub, engines } = harness()
      const req = { ...startReq().req, tab: { ...tabInfo(), cwd: folder, folder } }
      hub.start(req)
      await settle()
      engines[0].h.ready({ permissionMode: 'default' })
      engines[0].cmds = [
        command('deploy', 'plugin'), command('review', 'plugin'), command('lint', 'plugin'), command('compact', 'builtin'),
      ]
      const groups = Object.fromEntries((await hub.commands(TAB)).map(c => [c.name, c.group]))
      expect(groups).toEqual({ deploy: 'project', review: 'project', lint: 'plugin', compact: 'builtin' })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('setModel sets the model, then the effort, of the running engine, and the state shows both', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    await hub.setModel(TAB, 'claude-opus-5-5', 'high')

    expect(engines[0].modelsSet).toEqual(['claude-opus-5-5'])
    expect(engines[0].efforts).toEqual(['high'])
    expect(hub.snapshot(TAB)!.state).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })

  it('a note for a chat that is running shows at once; one for a chat that ended shows after its next start\'s history', async () => {
    const { hub, engines } = harness({ history: async () => fixtureHistory().slice(0, 3) })
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    hub.noteForChat(TAB, 'Shown now')
    expect(hub.snapshot(TAB)!.items).toContainEqual(expect.objectContaining({ kind: 'notice', text: 'Shown now' }))

    engines[0].h.exit(0)
    hub.noteForChat(TAB, 'Shown after the history')
    hub.start(startReq(SID).req)
    await settle()

    const items = hub.snapshot(TAB)!.items
    const noteAt = items.findIndex(item => item.kind === 'notice' && item.text === 'Shown after the history')
    expect(noteAt).toBeGreaterThan(items.findIndex(item => item.kind === 'user'))
    expect(items.filter(item => item.kind === 'notice' && item.text === 'Shown now')).toHaveLength(0)
  })
  it('isRunning is true while the tab has a running chat, and false before it starts and after it ends', async () => {
    const { hub, engines } = harness()
    expect(hub.isRunning(TAB)).toBe(false)
    hub.start(startReq().req)
    await settle()
    expect(hub.isRunning(TAB)).toBe(true)
    engines[0].h.exit(0)
    expect(hub.isRunning(TAB)).toBe(false)
  })

  it('a setModel whose effort fails keeps the new model in state and the old effort', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    await hub.setModel(TAB, 'claude-opus-5-5', 'high')
    engines[0].effortFails = true

    await expect(hub.setModel(TAB, 'claude-haiku-5-5', 'no-such-level')).rejects.toThrow('unknown effort level')
    expect(hub.snapshot(TAB)!.state).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
  })

  it('a namespaced command dir:name is project when .claude/commands/dir/name.md exists in the folder', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'ct-hub-namespaced-'))
    try {
      mkdirSync(join(folder, '.claude', 'commands', 'frontend'), { recursive: true })
      writeFileSync(join(folder, '.claude', 'commands', 'frontend', 'deploy.md'), '# deploy\n')
      const { hub, engines } = harness()
      hub.start({ ...startReq().req, tab: { ...tabInfo(), cwd: folder, folder } })
      await settle()
      engines[0].h.ready({ permissionMode: 'default' })
      engines[0].cmds = [command('frontend:deploy', 'plugin'), command('frontend:lint', 'plugin')]
      const groups = Object.fromEntries((await hub.commands(TAB)).map(c => [c.name, c.group]))
      expect(groups).toEqual({ 'frontend:deploy': 'project', 'frontend:lint': 'plugin' })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('modes keeps auto across a restart of the tab, and forgets it when the tab is removed', async () => {
    const { hub, engines } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'auto' })
    hub.start(startReq().req)
    await settle()
    expect(hub.modes(TAB)).toContain('auto')
    hub.removeTab(TAB)
    expect(hub.modes(TAB)).not.toContain('auto')
  })

  it('a note for a tab that is gone is not kept for a later start of that tab', async () => {
    const { hub, alive } = harness()
    hub.start(startReq().req)
    await settle()
    hub.removeTab(TAB)
    alive.delete(TAB)
    hub.noteForChat(TAB, 'Gone note')
    alive.add(TAB)
    hub.start(startReq().req)
    await settle()
    expect(hub.snapshot(TAB)!.items.some(item => item.kind === 'notice' && item.text === 'Gone note')).toBe(false)
  })

  it('a tab that starts its chat again continues its revisions, and the new chat\'s first patch resets the window', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    await hub.send(TAB, { text: 'one', attachments: [] })
    vi.advanceTimersByTime(16)
    engines[0].h.exit(0)
    vi.advanceTimersByTime(16)
    const oldRev = hub.snapshot(TAB)!.rev

    windows.length = 0
    hub.start(startReq().req)
    vi.advanceTimersByTime(16)

    expect(hub.snapshot(TAB)!.rev).toBeGreaterThan(oldRev)
    expect(windows).toHaveLength(1)
    expect(windows[0].fromRev).toBe(oldRev)
    expect(windows[0].patches[0]).toMatchObject({ op: 'reset', items: [expect.objectContaining({ kind: 'notice', text: 'Starting Claude…' })] })
  })

  it('a tab removed for good starts its revisions again from 0', async () => {
    const { hub, engines, windows } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    vi.advanceTimersByTime(16)
    hub.removeTab(TAB)

    windows.length = 0
    hub.start(startReq().req)
    vi.advanceTimersByTime(16)

    expect(windows[0]).toMatchObject({ fromRev: 0, patches: [expect.objectContaining({ op: 'reset' })] })
  })

  it('a member that watches the tab takes the batches of a chat that starts again: its mirror of the old chat follows the reset', async () => {
    const { hub, engines, remotes, watched } = harness()
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    watched.add(TAB)
    engines[0].h.message(init())
    await hub.send(TAB, { text: 'one', attachments: [] })
    vi.advanceTimersByTime(50)
    engines[0].h.exit(0)
    vi.advanceTimersByTime(50)
    // the member holds the old chat as it is now; the batches counted from here are the new chat's
    const mirror = new ChatMirror()
    mirror.load(hub.remoteSnapshot(TAB)!)
    remotes.length = 0

    hub.start(startReq().req)
    vi.advanceTimersByTime(50)

    expect(remotes.length).toBeGreaterThan(0)
    for (const r of remotes) expect(mirror.apply(r.fromRev, r.toRev, r.patches)).toBe(true)
    expect(mirror.snapshot()!.rev).toBe(hub.snapshot(TAB)!.rev)
    expect(mirror.snapshot()!.items).toEqual(hub.snapshot(TAB)!.items)
  })

  it('a resumed chat sends its starting reset, then the history\'s reset right after it, in consecutive revisions', async () => {
    const { hub, windows } = harness({ history: async () => [readFile(SHOWN)] })
    hub.start(startReq(SID).req)
    await settle()
    vi.advanceTimersByTime(16)

    expect(windows).toHaveLength(1)
    const [batch] = windows
    const resets = batch.patches.map((p, i) => ({ p, i })).filter(({ p }) => p.op === 'reset')
    expect(resets).toHaveLength(2)
    expect(resets[0].p).toMatchObject({ op: 'reset', items: [expect.objectContaining({ kind: 'notice', text: 'Starting Claude…' })] })
    // a patch's revision is its index from the batch's fromRev: the history's reset comes next, so its fromRev is the starting reset's toRev
    expect(resets[1].i).toBe(resets[0].i + 1)
    expect(resets[1].p).toMatchObject({ op: 'reset', items: expect.arrayContaining([expect.objectContaining({ kind: 'images' })]) })
  })
})

/** a command as the engine lists it */
function command(name: string, group: ChatCommandInfo['group']): ChatCommandInfo {
  return { name, description: '', argumentHint: '', group, source: null, terminal: false }
}
