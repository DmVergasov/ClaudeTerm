import { describe, expect, it } from 'vitest'
import type { AttachBridgeSessionOptions } from '@anthropic-ai/claude-agent-sdk/bridge'
import { WIN } from '../fixtures/platform'
import { pathKey } from '../../src/main/path-key'
import { BridgeHost, type BridgeTarget, type BridgeHostDeps } from '../../src/main/remote-control/bridge-host'
import type { BridgeModule } from '../../src/main/remote-control/bridge-loader'
import type { RemoteSessionEntry } from '../../src/main/remote-control/remote-sessions'
import type { ClaudeCredentials } from '../../src/main/remote-control/claude-credentials'
import type { SdkPermissionResult } from '../../src/main/chat/chat-cards'
import { REMOTE_REASONS } from '../../src/shared/remote-control'

const TAB = 'tab-1'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const TOKEN = 'fake-access-token-0001'
const DEVICE = 'fake-device-token-0001'
const JWT = 'fake-worker-jwt-0001'
const CREDS = { worker_jwt: JWT, api_base_url: 'https://worker.example.invalid', expires_in: 3600, worker_epoch: 3 }
const FOLDER = WIN ? 'C:\\cfg' : '/cfg'
const CWD = WIN ? 'C:\\work' : '/work'
const GIT = { gitRepoUrl: 'https://git.example.invalid/acme/app.git', branch: 'fix', defaultBranch: 'main' }

/** a bridge handle that records what the host does with it */
class FakeHandle {
  writes: Record<string, unknown>[] = []; results = 0; states: string[] = []; requests: Record<string, any>[] = []; cancels: string[] = []
  closes = 0; flushes = 0; flushHangs = false; reconnects: Record<string, unknown>[] = []; seq = 7
  constructor(readonly opts: AttachBridgeSessionOptions) {}
  get sessionId(): string { return this.opts.sessionId }
  getSequenceNum(): number { return this.seq }
  getEpoch(): number | undefined { return this.opts.epoch }
  isConnected(): boolean { return true }
  write(m: unknown): void { this.writes.push(m as Record<string, unknown>) }
  sendResult(): void { this.results++ }
  sendControlRequest(r: unknown): void { this.requests.push(r as Record<string, any>) }
  sendControlResponse(): void {}
  sendControlCancelRequest(id: string): void { this.cancels.push(id) }
  async reconnectTransport(o: Record<string, unknown>): Promise<void> { this.reconnects.push(o) }
  reportState(s: string): void { this.states.push(s) }
  reportMetadata(): void {}
  reportDelivery(): void {}
  flush(): Promise<void> { this.flushes++; return this.flushHangs ? new Promise<void>(() => {}) : Promise.resolve() }
  close(): void { this.closes++ }
}

/** the host with a fake bridge (answers given in order), a fake store, chat and clock */
function host() {
  const calls: unknown[][] = []
  const answers = { create: ['cse_1'] as unknown[], creds: [CREDS] as unknown[], attachThrows: null as Error | null, attachGate: null as Promise<void> | null }
  const handles: FakeHandle[] = []
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  const bridge = {
    createCodeSession: async (...a: unknown[]) => { calls.push(['create', ...a]); return answers.create.length > 0 ? answers.create.shift() : 'cse_x' },
    fetchRemoteCredentials: async (...a: unknown[]) => { calls.push(['credentials', ...a]); return answers.creds.length > 0 ? answers.creds.shift() : CREDS },
    attachBridgeSession: async (opts: AttachBridgeSessionOptions) => {
      calls.push(['attach', opts])
      if (answers.attachGate) await answers.attachGate
      if (answers.attachThrows) throw answers.attachThrows
      const h = new FakeHandle(opts); handles.push(h); return h
    },
    isCredentialsFailure: (r: unknown) => isObj(r) && r.terminal === true,
    isCredentialsRejection: (r: unknown) => isObj(r) && r.terminal === false,
    isCreateSessionFailure: (r: unknown) => isObj(r) && r.terminal === true
  } as unknown as BridgeModule
  const stored = new Map<string, { entry: RemoteSessionEntry; account: string }>()
  const w = {
    creds: { accessToken: TOKEN, deviceToken: DEVICE, state: 'fresh' } as ClaudeCredentials,
    /** read in order before `creds`, one per read */
    credsQueue: [] as ClaudeCredentials[],
    bridgeOk: true, sent: [] as string[], answered: [] as [string, SdkPermissionResult][], answerOk: true, interrupts: 0,
    history: [] as unknown[], historyThrows: null as Error | null, storeThrows: null as Error | null, seen: [] as (string | null)[], checks: 0, logs: [] as string[], timers: [] as { ms: number; run: () => void; on: boolean }[], changes: 0
  }
  const hostRef: { h?: BridgeHost } = {}
  const d: BridgeHostDeps = {
    bridge: async () => (w.bridgeOk ? { ok: true, bridge } : { ok: false }),
    credentials: async () => w.credsQueue.shift() ?? w.creds,
    sessions: {
      get: async (sid, account) => { if (w.storeThrows) throw w.storeThrows; const s = stored.get(sid); return s && s.account === account ? s.entry : null },
      put: async (sid, account, entry) => { stored.set(sid, { entry, account }) },
      forget: async (sid) => { stored.delete(sid) }
    },
    git: async () => GIT,
    chat: {
      send: async (_t, text) => { w.sent.push(text); return null },
      answer: (_t, id, r) => { w.answered.push([id, r]); return w.answerOk },
      interrupt: () => { w.interrupts++ },
      history: async () => { if (w.historyThrows) throw w.historyThrows; return w.history },
      checkSignIn: async () => { w.checks++ }
    },
    claudeVersion: () => '2.1.323',
    later: (ms, run) => { const t = { ms, run, on: true }; w.timers.push(t); return () => { t.on = false } },
    onChange: () => { w.changes++; w.seen.push(hostRef.h?.state(TAB)?.kind ?? null) },
    log: { info: (m) => w.logs.push(m), warn: (m) => w.logs.push(m) }
  }
  /** runs the pending timers of that delay */
  const fire = (ms: number): void => { for (const t of w.timers.filter((x) => x.on && x.ms === ms)) { t.on = false; t.run() } }
  const h = new BridgeHost(d)
  hostRef.h = h
  return { h, calls, answers, handles, stored, w, fire }
}
const target = (over: Partial<BridgeTarget> = {}): BridgeTarget => ({ tabId: TAB, sessionId: SID, folder: FOLDER, env: {}, title: 'Fix the parser', cwd: CWD, model: 'claude-opus-5-5', ...over })
/** lets the attach's awaits run */
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const userLine = (uuid: string, text: string) => ({ type: 'user', uuid, session_id: SID, message: { role: 'user', content: text }, parent_tool_use_id: null })
const assistantLine = (uuid: string, text: string) => ({ type: 'assistant', uuid, session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null })

describe('BridgeHost: attach', () => {
  it('a new conversation: a new remote session, its worker token, attach; the id is stored, the history goes first, and the tab is on with its link', async () => {
    const { h, calls, handles, stored, w } = host()
    w.history = [userLine('u1', 'Fix the parser'), { type: 'system', subtype: 'init' }, assistantLine('a1', 'Done.')]
    h.attach(target())
    expect(h.state(TAB)).toEqual({ kind: 'connecting' })
    await settle()
    expect(calls.map((c) => c[0])).toEqual(['create', 'credentials', 'attach'])
    expect(calls[0]).toEqual(['create', 'https://api.anthropic.com', TOKEN, 'Fix the parser', 20_000, undefined, GIT, CWD, 'claude-opus-5-5'])
    expect(calls[1]).toEqual(['credentials', 'cse_1', 'https://api.anthropic.com', TOKEN, 20_000, DEVICE])
    const opts = calls[2][1] as AttachBridgeSessionOptions
    expect(opts).toMatchObject({ sessionId: 'cse_1', ingressToken: JWT, apiBaseUrl: CREDS.api_base_url, epoch: 3, claudeCodeVersion: '2.1.323' })
    expect(opts.initialSequenceNum).toBeUndefined()
    expect([opts.onSetModel, opts.onSetPermissionMode, opts.onRenameSession, opts.onStopTask, opts.onSetMaxThinkingTokens, opts.onBackgroundTasks]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
    expect(stored.get(SID)).toEqual({ entry: { remoteId: 'cse_1', sequenceNum: 0 }, account: pathKey(FOLDER) })
    expect(handles[0].writes.map((m) => m.uuid)).toEqual(['u1', 'a1'])
    expect(h.state(TAB)).toEqual({ kind: 'on', url: 'https://claude.ai/code/cse_1' })
  })
  it('a conversation with a stored remote session re-attaches with its sequence number and writes no history', async () => {
    const { h, calls, handles, stored, w } = host()
    stored.set(SID, { entry: { remoteId: 'cse_9', sequenceNum: 42 }, account: pathKey(FOLDER) })
    w.history = [userLine('u1', 'old')]
    h.attach(target())
    await settle()
    expect(calls.map((c) => c[0])).toEqual(['credentials', 'attach'])
    expect((calls[1][1] as AttachBridgeSessionOptions)).toMatchObject({ sessionId: 'cse_9', initialSequenceNum: 42 })
    expect(handles[0].writes).toEqual([])
  })
  it('a stored session that is gone (invalid_session_id, or a 404) is forgotten and a new one is made', async () => {
    for (const gone of [{ terminal: true, reason: 'invalid_session_id' }, { terminal: true, reason: 'request_rejected', status: 404 }]) {
      const { h, calls, answers, stored } = host()
      stored.set(SID, { entry: { remoteId: 'cse_9', sequenceNum: 42 }, account: pathKey(FOLDER) })
      answers.creds = [gone, CREDS]
      h.attach(target())
      await settle()
      expect(calls.map((c) => c[0])).toEqual(['credentials', 'create', 'credentials', 'attach'])
      expect(stored.get(SID)!.entry).toEqual({ remoteId: 'cse_1', sequenceNum: 0 })
    }
  })
  it('a stored session of another account is not used: a new one is made', async () => {
    const { h, calls, stored } = host()
    stored.set(SID, { entry: { remoteId: 'cse_9', sequenceNum: 42 }, account: 'another-folder' })
    h.attach(target())
    await settle()
    expect(calls[0][0]).toBe('create')
  })
  it('no sign-in: unavailable; an unusable record: failed; the bridge missing: unavailable; nothing is called', async () => {
    const none = host(); none.w.creds = { accessToken: null, deviceToken: null, state: 'none' }
    none.h.attach(target()); await settle()
    expect(none.h.state(TAB)).toEqual({ kind: 'unavailable', reason: 'No claude.ai sign-in found for this account' })
    const folderless = host(); folderless.h.attach(target({ folder: null })); await settle()
    expect(folderless.h.state(TAB)).toEqual({ kind: 'unavailable', reason: 'No claude.ai sign-in found for this account' })
    const bad = host(); bad.w.creds = { accessToken: null, deviceToken: null, state: 'unusable' }
    bad.h.attach(target()); await settle()
    expect(bad.h.state(TAB)).toEqual({ kind: 'failed', reason: 'Sign in to this account again (claude auth login)' })
    const old = host(); old.w.bridgeOk = false
    old.h.attach(target()); await settle()
    expect(old.h.state(TAB)).toEqual({ kind: 'unavailable', reason: "This ClaudeTerm cannot host Remote Control: the Agent SDK's bridge changed" })
    for (const x of [none, folderless, bad, old]) expect(x.calls).toEqual([])
  })
})

describe('BridgeHost: while it is on', () => {
  it('live messages are written, partial frames are not; a turn’s start reports running, its result writes, calls sendResult and reports idle', async () => {
    const { h, handles } = host()
    h.attach(target()); await settle()
    h.message(TAB, { type: 'system', subtype: 'init', session_id: SID })
    h.message(TAB, { type: 'stream_event', event: {} })
    h.message(TAB, assistantLine('a2', 'Working.'))
    h.message(TAB, { type: 'result', subtype: 'success', session_id: SID })
    expect(handles[0].writes.map((m) => m.type)).toEqual(['system', 'assistant', 'result'])
    expect(handles[0].results).toBe(1)
    // idle once attached, then the turn
    expect(handles[0].states).toEqual(['idle', 'running', 'idle'])
  })
  it('a message typed in the window is written as the user’s; one from claude.ai is not written back', async () => {
    const { h, handles } = host()
    h.attach(target()); await settle()
    h.userSent(TAB, 'u2', 'hello', null)
    h.userSent(TAB, 'u3', 'from the phone', 'remote')
    expect(handles[0].writes).toEqual([{ type: 'user', uuid: 'u2', session_id: '', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null }])
  })
  it('messages that come while attaching are written after the history, without those the history holds; a result among them still calls sendResult', async () => {
    const { h, handles, w } = host()
    w.history = [userLine('u1', 'Fix the parser')]
    h.attach(target())
    h.message(TAB, userLine('u1', 'Fix the parser'))
    h.message(TAB, assistantLine('a1', 'Done.'))
    h.message(TAB, { type: 'result', subtype: 'success', uuid: 'r1', session_id: SID })
    await settle()
    expect(handles[0].writes.map((m) => m.uuid)).toEqual(['u1', 'a1', 'r1'])
    expect(handles[0].results).toBe(1)
  })
  it('a message typed on claude.ai goes into the chat; one without text does not', async () => {
    const { h, handles, w } = host()
    h.attach(target()); await settle()
    await handles[0].opts.onInboundMessage!({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'from the phone' }] }, parent_tool_use_id: null, session_id: '' } as never)
    await handles[0].opts.onInboundMessage!({ type: 'user', message: { role: 'user', content: [] }, parent_tool_use_id: null, session_id: '' } as never)
    expect(w.sent).toEqual(['from the phone'])
  })
  it('an open card goes to claude.ai as can_use_tool with its id and requires action; claude.ai’s answer settles it; an answer to no open card, or a malformed one, is refused', async () => {
    const { h, handles, w } = host()
    h.attach(target()); await settle()
    h.cardOpened(TAB, 'card-1', { toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_1', folder: CWD })
    expect(handles[0].requests).toEqual([{ type: 'control_request', request_id: 'card-1', request: expect.objectContaining({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' }) }])
    expect(handles[0].states.at(-1)).toBe('requires_action')
    const answer = (requestId: string, response: unknown) => handles[0].opts.onPermissionResponse!({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } } as never)
    expect(answer('card-9', { behavior: 'allow' })).toBe(false)
    expect(answer('card-1', { behavior: 'maybe' })).toBe(false)
    expect(answer('card-1', { behavior: 'allow' })).not.toBe(false)
    expect(w.answered).toEqual([['card-1', { behavior: 'allow', updatedInput: { command: 'ls' } }]])
    h.cardClosed(TAB, 'card-1', 'remote')
    expect(handles[0].cancels).toEqual([])
  })
  it('a card answered in the window, or cancelled, is cancelled on claude.ai', async () => {
    const { h, handles } = host()
    h.attach(target()); await settle()
    h.cardOpened(TAB, 'card-1', { toolName: 'Bash', input: {}, folder: CWD })
    h.cardOpened(TAB, 'card-2', { toolName: 'Bash', input: {}, folder: CWD })
    h.cardClosed(TAB, 'card-1', 'window')
    h.cardClosed(TAB, 'card-2', 'cancelled')
    expect(handles[0].cancels).toEqual(['card-1', 'card-2'])
  })
  it('an interrupt from claude.ai interrupts the chat', async () => {
    const { h, handles, w } = host()
    h.attach(target()); await settle()
    handles[0].opts.onInterrupt!()
    expect(w.interrupts).toBe(1)
  })
})

describe('BridgeHost: the edges of attach and detach', () => {
  it('a message typed while the tab attaches is written once when the history already holds it', async () => {
    const { h, handles, w } = host()
    w.history = [userLine('u2', 'hello')]
    h.attach(target())
    h.userSent(TAB, 'u2', 'hello', null)
    await settle()
    expect(handles[0].writes.map((m) => m.uuid)).toEqual(['u2'])
  })
  it('partial frames are not queued: many of them while attaching do not push out a queued message', async () => {
    const { h, handles } = host()
    h.attach(target())
    h.message(TAB, assistantLine('a1', 'Done.'))
    for (let i = 0; i < 1500; i++) h.message(TAB, { type: 'stream_event', uuid: 's' + i, event: {} })
    await settle()
    expect(handles[0].writes.map((m) => m.uuid)).toEqual(['a1'])
  })
  it('a first attach that fails before its history is written stores nothing: the next attach makes a new session and writes the history', async () => {
    const { h, calls, answers, stored, w, handles } = host()
    w.history = [userLine('u1', 'Fix the parser')]
    answers.attachThrows = new Error('attach refused')
    h.attach(target()); await settle()
    expect(h.state(TAB)).toEqual({ kind: 'failed', reason: REMOTE_REASONS.unreachable })
    expect(stored.has(SID)).toBe(false)
    answers.attachThrows = null
    answers.create = ['cse_2']
    h.attach(target()); await settle()
    expect(calls.filter((c) => c[0] === 'create')).toHaveLength(2)
    expect(handles[0].writes.map((m) => m.uuid)).toEqual(['u1'])
    expect(h.state(TAB)).toEqual({ kind: 'on', url: 'https://claude.ai/code/cse_2' })
    expect(stored.get(SID)!.entry).toEqual({ remoteId: 'cse_2', sequenceNum: 0 })
  })
  it('an attach that fails is logged without its tokens, and the window hears the failed state last', async () => {
    const { h, w } = host()
    w.storeThrows = new Error(`store failed with ${TOKEN}`)
    h.attach(target()); await settle()
    expect(h.state(TAB)).toEqual({ kind: 'failed', reason: REMOTE_REASONS.unreachable })
    expect(w.logs.join('\n')).toContain('remote control: the attach failed for tab tab-1: store failed with [token]')
    expect(w.logs.join('\n')).not.toContain(TOKEN)
    expect(w.seen.at(-1)).toBe('failed')
  })

  it('a history that cannot be read is logged without the token and left out: the attach still turns on', async () => {
    const { h, handles, w } = host()
    w.historyThrows = new Error(`history failed with ${TOKEN}`)
    h.attach(target()); await settle()
    expect(h.state(TAB)).toEqual({ kind: 'on', url: 'https://claude.ai/code/cse_1' })
    expect(handles[0].writes).toEqual([])
    expect(w.logs.join('\n')).toContain('[token]')
    expect(w.logs.join('\n')).not.toContain(TOKEN)
  })
  it('an attach that throws is failed as unreachable, and the worker token stays out of the log', async () => {
    const { h, answers, w } = host()
    answers.attachThrows = new Error(`attach refused ${JWT}`)
    h.attach(target()); await settle()
    expect(h.state(TAB)).toEqual({ kind: 'failed', reason: REMOTE_REASONS.unreachable })
    expect(w.logs.join('\n')).not.toContain(JWT)
  })
  it('an attach that does not open in 30 s is failed as unreachable', async () => {
    const { h, answers, fire } = host()
    answers.attachGate = new Promise<void>(() => {})
    h.attach(target()); await settle()
    fire(30_000); await settle()
    expect(h.state(TAB)).toEqual({ kind: 'failed', reason: REMOTE_REASONS.unreachable })
  })
  it('a connection that closes while on: failed as unreachable, and its handle is closed', async () => {
    const { h, handles } = host()
    h.attach(target()); await settle()
    handles[0].opts.onClose!(4090)
    expect(h.state(TAB)).toEqual({ kind: 'failed', reason: REMOTE_REASONS.unreachable })
    expect(handles[0].closes).toBe(1)
  })
  it('detach: the last writes get 2 s to reach claude.ai, then the handle closes and the tab is off', async () => {
    const { h, handles, fire } = host()
    h.attach(target()); await settle()
    handles[0].flushHangs = true
    const done = h.detach(TAB)
    expect(h.state(TAB)).toBeNull()
    fire(2_000)
    await done
    expect(handles[0].flushes).toBe(1)
    expect(handles[0].closes).toBe(1)
  })
})
