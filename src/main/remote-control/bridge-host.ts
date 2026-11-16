// Remote Control of a Claude tab: the tab's conversation is hosted on claude.ai through the Agent SDK's bridge. This file
// keeps each tab's state and carries the traffic both ways; the sign-in, the stored session ids and the bridge functions
// come in through BridgeHostDeps, so the tests run it with fakes.

import type { SDKControlRequest, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BridgeSessionHandle, AttachBridgeSessionOptions, CredentialsFailure, RemoteCredentials } from '@anthropic-ai/claude-agent-sdk/bridge'
import type { ChatSendOrigin } from '../../shared/chat'
import { isBridgeId, REMOTE_REASONS, remoteLink, remoteName, type RemoteState } from '../../shared/remote-control'
import type { PermissionAsk, SdkPermissionResult } from '../chat/chat-cards'
import { pathKey } from '../path-key'
import type { BridgeLoad } from './bridge-loader'
import type { ClaudeCredentials } from './claude-credentials'
import type { GitContext } from './git-context'
import type { RemoteSessionEntry, RemoteSessionStore } from './remote-sessions'

export const API_BASE = 'https://api.anthropic.com'
export const CALL_TIMEOUT_MS = 20_000
/** the time an attach may take to open its connection */
const CONNECT_MS = 30_000
/** the time the last writes of a session get to reach claude.ai before it closes */
const FLUSH_MS = 2_000
/** the messages and card events kept while a tab attaches; the oldest go first */
const QUEUE_MAX = 1000
/** the longest denial message sent back to claude.ai */
const DENY_MAX = 1000

export interface BridgeChat {
  /** a message typed on claude.ai, into the chat as the person's (ChatHub.send, from 'remote'); null: sent, else why not */
  send(tabId: string, text: string): Promise<string | null>
  /** settles an open card with claude.ai's answer (ChatHub.answerRemote); false: no such card, or the answer does not fit */
  answer(tabId: string, cardId: string, result: SdkPermissionResult): boolean
  interrupt(tabId: string): void
  /** the conversation so far, as the SDK's getSessionMessages gives it */
  history(tabId: string, sessionId: string): Promise<unknown[]>
  /** one call that makes the chat's Claude Code check its sign-in (accountInfo) */
  checkSignIn(tabId: string): Promise<void>
}

export interface BridgeTarget {
  tabId: string; sessionId: string
  /** the account's config folder; null: none known (the main account of a test run without CLAUDE_CONFIG_DIR) */
  folder: string | null
  env: Record<string, string>; title: string; cwd: string; model: string | null
}

export interface BridgeHostDeps {
  bridge(): Promise<BridgeLoad>
  credentials(folder: string, env: Record<string, string>): Promise<ClaudeCredentials>
  sessions: Pick<RemoteSessionStore, 'get' | 'put' | 'forget'>
  git(cwd: string): Promise<GitContext | null>
  chat: BridgeChat
  claudeVersion(): string | null
  later(ms: number, run: () => void): () => void
  onChange(tabId: string): void
  log: { info(m: string): void; warn(m: string): void }
}

type Handle = BridgeSessionHandle
type Msg = Record<string, unknown>
type Run = (h: Handle) => void

/** one Claude tab's Remote Control: its state, its bridge handle, what waits for the handle and its open cards */
interface Tab {
  gen: number
  target: BridgeTarget
  state: RemoteState
  handle: Handle | null
  /** what came while the tab connected, run in order once it is on */
  queue: Run[]
  openCards: Map<string, PermissionAsk>
  /** the uuids of the history written at the attach: a message with one of them is not written again */
  historyUuids: Set<string>
  /** the tokens read or received by this attach: they never reach a log or a state */
  secrets: string[]
}

const isRecord = (v: unknown): v is Msg => typeof v === 'object' && v !== null && !Array.isArray(v)

/** text with each secret replaced by [token]: a token never reaches a log line, an error text or a state */
export function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((s, secret) => (secret === '' ? s : s.split(secret).join('[token]')), text)
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** the text of a message from claude.ai: its string content, or its text blocks joined by a line break; '' when there is none */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n').trim()
}

/** the session is gone for good: its id is not valid, the org policy no longer takes it, or claude.ai says it is not there */
const isGone = (f: CredentialsFailure): boolean =>
  f.reason === 'invalid_session_id' || f.reason === 'session_security_tier_below_org_policy' || (f.reason === 'request_rejected' && f.status === 404)

/** a permission card as claude.ai's can_use_tool request */
function permissionRequest(cardId: string, ask: PermissionAsk): Msg {
  return {
    subtype: 'can_use_tool',
    tool_name: ask.toolName,
    input: ask.input,
    tool_use_id: ask.toolUseId ?? cardId,
    title: ask.title,
    display_name: ask.displayName,
    description: ask.description,
    permission_suggestions: ask.suggestions
  }
}

/** the answer claude.ai sent for a card as the SDK takes it back; null when the payload is malformed */
function answerResult(payload: Msg, ask: PermissionAsk): SdkPermissionResult | null {
  if (payload.behavior === 'allow' && (payload.updatedInput === undefined || isRecord(payload.updatedInput))) {
    return { behavior: 'allow', updatedInput: isRecord(payload.updatedInput) ? payload.updatedInput : ask.input }
  }
  if (payload.behavior === 'deny' && (payload.message === undefined || typeof payload.message === 'string')) {
    const message = typeof payload.message === 'string' ? Array.from(payload.message).slice(0, DENY_MAX).join('') : 'Denied on claude.ai'
    return { behavior: 'deny', message }
  }
  return null
}

export class BridgeHost {
  private readonly tabs = new Map<string, Tab>()
  private gens = 0

  constructor(private readonly d: BridgeHostDeps) {}

  /** starts the tab's Remote Control: a session on claude.ai, attached through the bridge; nothing starts when the tab is already on or connecting */
  attach(target: BridgeTarget): void {
    const cur = this.tabs.get(target.tabId)
    if (cur && (cur.state.kind === 'connecting' || (cur.state.kind === 'on' && cur.target.sessionId === target.sessionId))) return
    if (cur) void this.detach(target.tabId)
    const t: Tab = { gen: ++this.gens, target, state: { kind: 'connecting' }, handle: null, queue: [], openCards: new Map(), historyUuids: new Set(), secrets: [] }
    this.tabs.set(target.tabId, t)
    this.d.onChange(target.tabId)
    this.connect(t).catch(() => {
      if (this.current(t) && t.state.kind === 'connecting') this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
    })
  }

  /** stops the tab's Remote Control: the last writes get 2 s to reach claude.ai, then the handle closes */
  async detach(tabId: string): Promise<void> {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.tabs.delete(tabId)
    t.gen = ++this.gens
    t.queue = []
    const h = t.handle
    t.handle = null
    this.d.onChange(tabId)
    if (h) await this.flushAndClose(h)
  }

  /** null: no bridge for the tab (off) */
  state(tabId: string): RemoteState | null {
    return this.tabs.get(tabId)?.state ?? null
  }

  /** a message of the tab's conversation, from the chat: written to claude.ai */
  message(tabId: string, msg: unknown): void {
    const t = this.tabs.get(tabId)
    if (!t || !isRecord(msg)) return
    this.send(t, (h) => this.forward(t, h, msg))
  }

  /** a message the person or a sender sent into the chat: the person's own typing goes to claude.ai, what claude.ai sent does not go back */
  userSent(tabId: string, uuid: string, text: string, from: ChatSendOrigin | null): void {
    const t = this.tabs.get(tabId)
    if (!t || from === 'remote') return
    const msg: Msg = { type: 'user', uuid, session_id: '', message: { role: 'user', content: text }, parent_tool_use_id: null }
    this.send(t, (h) => {
      h.write(msg as SDKMessage)
      h.reportState('running')
    })
  }

  /** a permission card opened in the chat: claude.ai gets it as a can_use_tool request and the tab requires action */
  cardOpened(tabId: string, cardId: string, ask: PermissionAsk): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.openCards.set(cardId, ask)
    this.send(t, (h) => {
      h.sendControlRequest({ type: 'control_request', request_id: cardId, request: permissionRequest(cardId, ask) } as SDKControlRequest)
      h.reportState('requires_action')
    })
  }

  /** a card closed in the chat: claude.ai's prompt is cancelled unless claude.ai answered it; the tab runs again once no card is open */
  cardClosed(tabId: string, cardId: string, by: 'window' | 'remote' | 'cancelled'): void {
    const t = this.tabs.get(tabId)
    if (!t || !t.openCards.delete(cardId)) return
    this.send(t, (h) => {
      if (by !== 'remote') h.sendControlCancelRequest(cardId)
      if (t.openCards.size === 0) h.reportState('running')
    })
  }

  private async connect(t: Tab): Promise<void> {
    const gen = t.gen
    const alive = (): boolean => this.current(t) && t.gen === gen
    const { target } = t
    const load = await this.d.bridge()
    if (!alive()) return
    if (!load.ok) {
      this.stop(t, { kind: 'unavailable', reason: REMOTE_REASONS.bridgeChanged })
      return
    }
    const bridge = load.bridge
    if (target.folder === null) {
      this.stop(t, { kind: 'unavailable', reason: REMOTE_REASONS.noSignIn })
      return
    }
    const folder = target.folder
    const creds = await this.d.credentials(folder, target.env)
    if (!alive()) return
    if (creds.state === 'none') {
      this.stop(t, { kind: 'unavailable', reason: REMOTE_REASONS.noSignIn })
      return
    }
    // expired: Claude Code renews the sign-in, which the renew wait handles; until then the tab fails
    if (creds.state !== 'fresh' || creds.accessToken === null) {
      this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.relogin })
      return
    }
    const token = creds.accessToken
    t.secrets = [token, creds.deviceToken].filter((s): s is string => typeof s === 'string' && s !== '')
    const account = pathKey(folder)

    let entry: RemoteSessionEntry | null = await this.d.sessions.get(target.sessionId, account)
    if (!alive()) return
    let fresh = entry === null
    let remote: RemoteCredentials
    // a stored session claude.ai no longer knows is forgotten and a new one made, once
    for (;;) {
      if (entry === null) {
        const gitContext = await this.d.git(target.cwd).catch(() => null)
        if (!alive()) return
        const made = await bridge.createCodeSession(API_BASE, token, remoteName(target.title), CALL_TIMEOUT_MS, undefined, gitContext ?? undefined, target.cwd, target.model ?? undefined)
        if (!alive()) return
        if (typeof made !== 'string' || !isBridgeId(made)) {
          this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
          return
        }
        entry = { remoteId: made, sequenceNum: 0 }
        await this.d.sessions.put(target.sessionId, account, entry)
        if (!alive()) return
        fresh = true
      }
      const got = await bridge.fetchRemoteCredentials(entry.remoteId, API_BASE, token, CALL_TIMEOUT_MS, creds.deviceToken ?? undefined)
      if (!alive()) return
      if (got !== null && !bridge.isCredentialsFailure(got) && !bridge.isCredentialsRejection(got)) {
        remote = got
        break
      }
      if (!fresh && bridge.isCredentialsFailure(got) && isGone(got)) {
        await this.d.sessions.forget(target.sessionId)
        if (!alive()) return
        entry = null
        continue
      }
      this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
      return
    }
    t.secrets.push(remote.worker_jwt)

    const version = this.d.claudeVersion()
    const opts: AttachBridgeSessionOptions = {
      sessionId: entry.remoteId,
      ingressToken: remote.worker_jwt,
      apiBaseUrl: remote.api_base_url,
      epoch: remote.worker_epoch,
      ...(fresh ? {} : { initialSequenceNum: entry.sequenceNum }),
      ...(version ? { claudeCodeVersion: version } : {}),
      onInboundMessage: (msg) => this.inbound(t, msg as Msg),
      onPermissionResponse: (res) => (this.answer(t, res as Msg) ? undefined : false),
      onInterrupt: () => {
        if (this.current(t)) this.d.chat.interrupt(target.tabId)
      },
      onClose: (code) => {
        if (!this.current(t)) return
        this.d.log.warn(`remote control: the connection closed for tab ${target.tabId} (${code ?? 'no code'})`)
        this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
      }
    }
    const opened = bridge.attachBridgeSession(opts).then(
      (h): Handle | null => {
        if (!alive()) {
          h.close()
          return null
        }
        return h
      },
      (e: unknown): null => {
        this.d.log.warn(`remote control: the connection failed for tab ${target.tabId}: ${scrub(errorText(e), t.secrets)}`)
        return null
      }
    )
    let cancel = (): void => {}
    const limit = new Promise<null>((resolve) => {
      cancel = this.d.later(CONNECT_MS, () => resolve(null))
    })
    const handle = await Promise.race([opened, limit])
    cancel()
    if (!alive()) {
      handle?.close()
      return
    }
    if (handle === null) {
      this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
      return
    }
    t.handle = handle

    if (fresh) {
      let history: unknown[] = []
      try {
        history = await this.d.chat.history(target.tabId, target.sessionId)
      } catch (e) {
        this.d.log.warn(`remote control: the conversation's history cannot be read for tab ${target.tabId}: ${scrub(errorText(e), t.secrets)}`)
      }
      if (!alive()) return
      for (const m of history) {
        if (!isRecord(m) || (m.type !== 'user' && m.type !== 'assistant')) continue
        if (typeof m.uuid === 'string') t.historyUuids.add(m.uuid)
        handle.write(m as SDKMessage)
      }
    }

    const queue = t.queue
    t.queue = []
    t.state = { kind: 'on', url: remoteLink(entry.remoteId) }
    handle.reportState('idle')
    for (const run of queue) run(handle)
    this.d.onChange(target.tabId)
  }

  /** a state the tab stops in: its handle closes, what waits is dropped, and an attach still running stops too */
  private stop(t: Tab, state: RemoteState): void {
    t.gen = ++this.gens
    t.queue = []
    const h = t.handle
    t.handle = null
    h?.close()
    t.state = state
    this.d.onChange(t.target.tabId)
  }

  /** closes a handle after its last writes have had FLUSH_MS to reach claude.ai */
  private async flushAndClose(h: Handle): Promise<void> {
    let cancel = (): void => {}
    await Promise.race([
      h.flush().catch(() => undefined),
      new Promise<void>((resolve) => {
        cancel = this.d.later(FLUSH_MS, resolve)
      })
    ])
    cancel()
    h.close()
  }

  /** the tab is still the one this record describes: not detached, not replaced by a new attach */
  private current(t: Tab): boolean {
    return this.tabs.get(t.target.tabId) === t
  }

  /** runs `run` on the handle now, or once the attach has the handle: while the tab connects, what comes waits in the queue */
  private send(t: Tab, run: Run): void {
    if (t.state.kind === 'connecting') {
      t.queue.push(run)
      if (t.queue.length > QUEUE_MAX) t.queue.shift()
    } else if (t.handle) {
      run(t.handle)
    }
  }

  /** a message of the conversation to claude.ai: partial frames are left out, a turn's start and end set the state */
  private forward(t: Tab, h: Handle, msg: Msg): void {
    if (msg.type === 'stream_event') return
    if (!(typeof msg.uuid === 'string' && t.historyUuids.has(msg.uuid))) h.write(msg as SDKMessage)
    if (msg.type === 'system' && msg.subtype === 'init') h.reportState('running')
    if (msg.type === 'result') {
      h.sendResult()
      h.reportState('idle')
    }
  }

  /** a message typed on claude.ai goes into the chat as the person's; one with no text does not */
  private async inbound(t: Tab, msg: Msg): Promise<void> {
    if (!this.current(t) || msg.type !== 'user' || !isRecord(msg.message)) return
    const text = textOf(msg.message.content)
    if (text === '') return
    const refused = await this.d.chat.send(t.target.tabId, text)
    if (refused !== null) this.d.log.warn(`a message from claude.ai was not sent: ${refused}`)
  }

  /** claude.ai's answer to an open card, as the chat takes it; false when it does not answer an open card or is malformed */
  private answer(t: Tab, res: Msg): boolean {
    if (!this.current(t)) return false
    const body = res.response
    if (!isRecord(body) || body.subtype !== 'success' || typeof body.request_id !== 'string') return false
    const ask = t.openCards.get(body.request_id)
    if (!ask || !isRecord(body.response)) return false
    const result = answerResult(body.response, ask)
    if (result === null) return false
    return this.d.chat.answer(t.target.tabId, body.request_id, result)
  }
}
