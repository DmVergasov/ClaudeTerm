// Remote Control of a Claude tab: the tab's conversation is hosted on claude.ai through the Agent SDK's bridge. This file
// keeps each tab's state and carries the traffic both ways; the sign-in, the stored session ids and the bridge functions
// come in through BridgeHostDeps, so the tests run it with fakes.

import type { SDKControlRequest, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BridgeSessionHandle, AttachBridgeSessionOptions, CredentialsFailure, RemoteCredentials } from '@anthropic-ai/claude-agent-sdk/bridge'
import type { ChatSendOrigin } from '../../shared/chat'
import { isBridgeId, REMOTE_REASONS, refusedReason, remoteLink, remoteName, RENEW_WAIT_NOTE, type RemoteState } from '../../shared/remote-control'
import { SEND_TEXT_CAP } from '../chat/chat-guards'
import { cardFor, type PermissionAsk, type SdkPermissionResult } from '../chat/chat-cards'
import { pathKey } from '../path-key'
import type { BridgeLoad, BridgeModule } from './bridge-loader'
import type { ClaudeCredentials } from './claude-credentials'
import type { GitContext } from './git-context'
import type { RemoteSessionEntry, RemoteSessionStore } from './remote-sessions'

export const API_BASE = 'https://api.anthropic.com'
export const CALL_TIMEOUT_MS = 20_000
/** the time an attach may take to open its connection */
const CONNECT_MS = 30_000
/** the time the last writes of a session get to reach claude.ai before it closes */
export const FLUSH_MS = 2_000
/** the waits after a step's misses in a row: the step that misses one more time than these fails the tab as unreachable */
export const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000] as const
/** while Claude Code renews an expired sign-in, the tab reads it again this often */
export const RENEW_EVERY_MS = 60_000
/** while a tab is on, its sequence number is stored this often */
export const SEQUENCE_EVERY_MS = 60_000
/** the time the conversation's history may take to be read; a read that takes longer counts as none */
const HISTORY_MS = 20_000
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
  /** the chat's permission cards that are open now: claude.ai is sent each one when the tab turns on */
  openCards(tabId: string): [string, PermissionAsk][]
  /** whether the chat's turn runs now, working or waiting on a card */
  working(tabId: string): boolean
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

/** the bridge, the account's folder and the remote session of a connected tab: what brings its connection back */
interface Session { bridge: BridgeModule; folder: string; remoteId: string }

/** the token claude.ai is called with, and the device token that goes with it */
interface Sign { token: string; device: string | null }

/** one Claude tab's Remote Control: its state, its bridge handle, what waits for the handle and its open cards */
interface Tab {
  gen: number
  target: BridgeTarget
  state: RemoteState
  handle: Handle | null
  /** set once the handle is open: a dropped connection is brought back with it */
  session: Session | null
  /** a close was taken and the connection is being brought back: a further close of the same handle is not taken */
  reconnecting: boolean
  /** claude.ai's sign-in was read again in this attach or reconnect: a second rejection ends it */
  renewed: boolean
  /** Claude Code's sign-in was checked (accountInfo) in this attach */
  checkedSignIn: boolean
  /** the attach's entry is kept: its history is written and stored, so a later attach may resume the session */
  kept: boolean
  /** a close that came before the entry was kept: taken once the attach has stored it */
  pendingClose: { code: number | undefined } | null
  /** cancels the tab's pending wait (a retry, the renew wait, the attach's limit): a wait cancelled never goes on */
  cancelWait: () => void
  /** cancels the tab's sequence number timer, pending while it is on */
  cancelSequence: () => void
  /** what came while the tab connected, run in order once it is on */
  queue: Run[]
  openCards: Map<string, PermissionAsk>
  /** the uuids of the history written at the attach: a message with one of them is not written again */
  historyUuids: Set<string>
  /** the tokens read or received by this attach: they never reach a log or a state */
  secrets: string[]
}

const NOOP = (): void => {}

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

/** why claude.ai refused Remote Control, in the words the user reads: an untrusted computer and a sign-in to renew have their own; any other refusal names its status */
export function refusalReason(r: { reason: string; status?: number }): string {
  if (r.reason === 'untrusted_device') return REMOTE_REASONS.untrustedDevice
  if (r.reason === 'session_stale_relogin' || r.reason === 'oauth_rejected') return REMOTE_REASONS.relogin
  return r.status === undefined ? REMOTE_REASONS.unreachable : refusedReason(r.status)
}

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
    permission_suggestions: ask.suggestions,
    // the card's own rules: claude.ai offers no always-allow rule the card would not take, and no default approval
    suppress_always_allow_rule: ask.suppressAlwaysAllowRule === true,
    default_to_no: ask.defaultToNo === true
  }
}

/** the always-allow rules claude.ai picked: each must be one the card offered (none when the card offers none); null when one is not, or the list is malformed */
function rulesOffered(v: unknown, ask: PermissionAsk): unknown[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v)) return null
  const offered = new Set((ask.suppressAlwaysAllowRule ? [] : (ask.suggestions ?? [])).map((s) => JSON.stringify(s)))
  return v.every((rule) => offered.has(JSON.stringify(rule))) ? v : null
}

/** the answer claude.ai sent for a card as the SDK takes it back; null when the payload is malformed */
function answerResult(payload: Msg, ask: PermissionAsk): SdkPermissionResult | null {
  if (payload.behavior === 'allow' && (payload.updatedInput === undefined || isRecord(payload.updatedInput))) {
    const rules = rulesOffered(payload.updatedPermissions, ask)
    if (rules === null) return null
    // a permission card runs the input the person was asked about; only a question or a plan takes claude.ai's input back
    const input = cardFor(ask).type !== 'permission' && isRecord(payload.updatedInput) ? payload.updatedInput : ask.input
    return { behavior: 'allow', updatedInput: input, ...(rules.length > 0 ? { updatedPermissions: rules } : {}) }
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
    const t: Tab = {
      gen: ++this.gens, target, state: { kind: 'connecting' }, handle: null, session: null, reconnecting: false, renewed: false, checkedSignIn: false, kept: false, pendingClose: null,
      cancelWait: NOOP, cancelSequence: NOOP, queue: [], openCards: new Map(), historyUuids: new Set(), secrets: []
    }
    this.tabs.set(target.tabId, t)
    this.d.onChange(target.tabId)
    this.connect(t).catch((e: unknown) => {
      if (!this.current(t)) return
      this.d.log.warn(`remote control: the attach failed for tab ${target.tabId}: ${scrub(errorText(e), t.secrets)}`)
      this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
    })
  }

  /** stops the tab's Remote Control: the last writes get 2 s to reach claude.ai, then the handle closes */
  async detach(tabId: string): Promise<void> {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.tabs.delete(tabId)
    this.halt(t)
    t.queue = []
    const h = t.handle
    t.handle = null
    this.d.onChange(tabId)
    if (h) await this.flushAndClose(t, h)
  }

  /** null: no bridge for the tab (off) */
  state(tabId: string): RemoteState | null {
    return this.tabs.get(tabId)?.state ?? null
  }

  /** a message of the tab's conversation, from the chat: written to claude.ai */
  message(tabId: string, msg: unknown): void {
    const t = this.tabs.get(tabId)
    if (!t || !isRecord(msg) || msg.type === 'stream_event') return
    this.send(t, (h) => this.forward(t, h, msg))
  }

  /** a message the person or a sender sent into the chat: the person's own typing goes to claude.ai, what claude.ai sent does not go back */
  userSent(tabId: string, uuid: string, text: string, from: ChatSendOrigin | null): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    // a message claude.ai sent is not written back to it, but its turn runs
    if (from === 'remote') {
      this.send(t, (h) => h.reportState('running'))
      return
    }
    const msg: Msg = { type: 'user', uuid, session_id: '', message: { role: 'user', content: text }, parent_tool_use_id: null }
    this.send(t, (h) => {
      if (!t.historyUuids.has(uuid)) h.write(msg as SDKMessage)
      h.reportState('running')
    })
  }

  /** a permission card opened in the chat: claude.ai gets it as a can_use_tool request and the tab requires action */
  cardOpened(tabId: string, cardId: string, ask: PermissionAsk): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.openCards.set(cardId, ask)
    this.send(t, (h) => {
      this.sendCard(h, cardId, ask)
      h.reportState('requires_action')
    })
  }

  private sendCard(h: Handle, cardId: string, ask: PermissionAsk): void {
    h.sendControlRequest({ type: 'control_request', request_id: cardId, request: permissionRequest(cardId, ask) } as SDKControlRequest)
  }

  /** the state a tab reports to claude.ai: a card open requires action, a turn that runs is running, else idle */
  private reportTurn(t: Tab, h: Handle): void {
    h.reportState(t.openCards.size > 0 ? 'requires_action' : this.d.chat.working(t.target.tabId) ? 'running' : 'idle')
  }

  /** a tab that turns on sends claude.ai the cards the chat holds open and it does not know yet (a card opened while the tab connected is already known and queued), then reports its turn */
  private resume(t: Tab, h: Handle): void {
    for (const [cardId, ask] of this.d.chat.openCards(t.target.tabId)) {
      if (t.openCards.has(cardId)) continue
      t.openCards.set(cardId, ask)
      this.sendCard(h, cardId, ask)
    }
    this.reportTurn(t, h)
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
    const alive = (): boolean => this.alive(t, gen)
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
    const creds = await this.signIn(t, gen, folder)
    if (!alive()) return
    let sign = this.signed(t, creds)
    if (sign === null) return
    const account = pathKey(folder)

    let entry: RemoteSessionEntry | null = await this.d.sessions.get(target.sessionId, account)
    if (!alive()) return
    // a session made here is kept only once its history is written: until then an attach that fails leaves nothing behind
    let fresh = entry === null
    let misses = 0
    let remote: RemoteCredentials
    for (;;) {
      // a stored session claude.ai no longer knows is forgotten and a new one made, once
      if (entry === null) {
        const gitContext = await this.d.git(target.cwd).catch(() => null)
        if (!alive()) return
        const made = await bridge.createCodeSession(API_BASE, sign.token, remoteName(target.title), CALL_TIMEOUT_MS, undefined, gitContext ?? undefined, target.cwd, target.model ?? undefined)
        if (!alive()) return
        if (bridge.isCreateSessionFailure(made)) {
          this.stop(t, { kind: 'failed', reason: refusalReason(made) })
          return
        }
        if (bridge.isCredentialsRejection(made)) {
          const again = await this.renewSignIn(t, gen, folder, sign.token)
          if (!alive()) return
          if (again === null) {
            this.stop(t, { kind: 'failed', reason: refusalReason(made) })
            return
          }
          sign = again
          continue
        }
        if (!isBridgeId(made)) {
          if (!(await this.missed(t, ++misses))) return
          continue
        }
        entry = { remoteId: made, sequenceNum: 0 }
        fresh = true
      }
      const got = await bridge.fetchRemoteCredentials(entry.remoteId, API_BASE, sign.token, CALL_TIMEOUT_MS, sign.device ?? undefined)
      if (!alive()) return
      if (got === null) {
        if (!(await this.missed(t, ++misses))) return
        continue
      }
      if (bridge.isCredentialsRejection(got)) {
        const again = await this.renewSignIn(t, gen, folder, sign.token)
        if (!alive()) return
        if (again === null) {
          this.stop(t, { kind: 'failed', reason: refusalReason(got) })
          return
        }
        sign = again
        continue
      }
      if (bridge.isCredentialsFailure(got)) {
        if (!fresh && isGone(got)) {
          await this.d.sessions.forget(target.sessionId)
          if (!alive()) return
          entry = null
          continue
        }
        this.stop(t, { kind: 'failed', reason: refusalReason(got) })
        return
      }
      this.addSecrets(t, [got.worker_jwt])
      remote = got
      break
    }

    const remoteId = entry.remoteId
    const opts = this.attachOptions(t, remoteId, remote, fresh ? null : entry.sequenceNum)
    let handle: Handle | null = null
    while (handle === null) {
      handle = await this.openSession(t, gen, bridge, opts)
      if (!alive()) {
        handle?.close()
        return
      }
      if (handle === null && !(await this.missed(t, ++misses))) return
    }
    t.handle = handle
    t.session = { bridge, folder, remoteId }
    // a session made here is stored only once its history is written: until then a close waits for this attach to finish
    t.kept = !fresh

    if (fresh) {
      let history: unknown[] | null = []
      let cancelLimit = NOOP
      const limit = new Promise<null>((resolve) => {
        cancelLimit = this.d.later(HISTORY_MS, () => resolve(null))
      })
      try {
        history = await Promise.race([this.d.chat.history(target.tabId, target.sessionId), limit])
      } catch (e) {
        this.d.log.warn(`remote control: the conversation's history cannot be read for tab ${target.tabId}: ${scrub(errorText(e), t.secrets)}`)
      }
      cancelLimit()
      if (history === null) this.d.log.warn(`remote control: the conversation's history did not come in time for tab ${target.tabId}`)
      if (!alive()) return
      for (const m of history ?? []) {
        if (!isRecord(m) || (m.type !== 'user' && m.type !== 'assistant')) continue
        if (typeof m.uuid === 'string') t.historyUuids.add(m.uuid)
        handle.write(m as SDKMessage)
      }
      await this.d.sessions.put(target.sessionId, account, { remoteId, sequenceNum: 0 })
      if (!alive()) return
      t.kept = true
    }
    this.resume(t, handle)
    const pending = t.pendingClose
    t.pendingClose = null
    if (pending !== null) {
      // this entry's history went to a connection that closed meanwhile: when it cannot be brought back, the entry is forgotten
      this.takeClose(t, pending.code, true)
      return
    }
    this.turnOn(t, handle, remoteId)
  }

  /** attaches the remote session: null when the attach fails or does not open within CONNECT_MS; a handle that comes after that is closed */
  private openSession(t: Tab, gen: number, bridge: BridgeModule, opts: AttachBridgeSessionOptions): Promise<Handle | null> {
    let late = false
    let cancel = NOOP
    // a close counts only from the handle the tab holds now: a handle that a failed reconnect dropped says nothing about the connection
    const own: { handle: Handle | null } = { handle: null }
    const owned: AttachBridgeSessionOptions = { ...opts, onClose: (code) => { if (own.handle !== null && own.handle === t.handle) this.closed(t, code) } }
    const opened = bridge.attachBridgeSession(owned).then(
      (h): Handle | null => {
        if (late || !this.alive(t, gen)) {
          h.close()
          return null
        }
        own.handle = h
        return h
      },
      (e: unknown): null => {
        this.d.log.warn(`remote control: the connection failed for tab ${t.target.tabId}: ${scrub(errorText(e), t.secrets)}`)
        return null
      }
    )
    const limit = new Promise<null>((resolve) => {
      cancel = this.d.later(CONNECT_MS, () => {
        late = true
        resolve(null)
      })
      t.cancelWait = cancel
    })
    return Promise.race([opened, limit]).then((h) => {
      cancel()
      return h
    })
  }

  /** the connection of a tab that is on closed. While the attach is still reading its history, the close waits for the attach to keep its entry; then it is taken as usual */
  private closed(t: Tab, code: number | undefined): void {
    if (!this.current(t) || t.reconnecting || t.handle === null || t.session === null) return
    if (!t.kept) {
      t.pendingClose = { code }
      return
    }
    this.takeClose(t, code)
  }

  /** the tab's chain starts again from the sign-in, as a first attach does: with its entry forgotten, the session is made and its history written anew */
  private restartFresh(t: Tab): void {
    this.connect(t).catch((e: unknown) => {
      if (!this.current(t)) return
      this.d.log.warn(`remote control: the attach failed for tab ${t.target.tabId}: ${scrub(errorText(e), t.secrets)}`)
      this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
    })
  }

  /** the connection closed: its sequence number is stored, and it is brought back; claude.ai refusing it (403, 404) fails the tab */
  private takeClose(t: Tab, code: number | undefined, unsent = false): void {
    const handle = t.handle
    const session = t.session
    if (handle === null || session === null) return
    this.d.log.warn(`remote control: the connection closed for tab ${t.target.tabId} (${code ?? 'no code'})`)
    void this.storeSequence(t, handle)
    this.halt(t)
    if (code === 403 || code === 404) {
      this.stop(t, { kind: 'failed', reason: refusedReason(code) })
      return
    }
    t.reconnecting = true
    t.renewed = false
    t.state = { kind: 'connecting' }
    this.d.onChange(t.target.tabId)
    const gen = t.gen
    this.reconnect(t, session, gen, unsent).catch((e: unknown) => {
      if (!this.alive(t, gen)) return
      this.d.log.warn(`remote control: the connection could not be restored for tab ${t.target.tabId}: ${scrub(errorText(e), t.secrets)}`)
      this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
    })
  }

  /** brings a dropped connection back: the sign-in is read again and a worker token fetched for the same remote session, and the reconnect takes the epoch that fetch gave. The transport is reconnected on the handle; when the SDK has closed the handle (its reconnect failed), the session is attached again from its sequence number, with no history. A miss waits the backoff and goes on */
  private async reconnect(t: Tab, session: Session, gen: number, unsent: boolean): Promise<void> {
    let handle = t.handle
    if (handle === null) return
    let misses = 0
    // the history of a session made here may have gone to the closed connection: until a reconnect works, no entry stays for it
    let mayBeUnsent = unsent
    let sequence: number | null = null
    let sign: Sign | null = null
    for (;;) {
      if (sign === null) {
        const creds = await this.signIn(t, gen, session.folder)
        if (!this.alive(t, gen)) return
        sign = this.signed(t, creds)
        if (sign === null) return
      }
      const got = await session.bridge.fetchRemoteCredentials(session.remoteId, API_BASE, sign.token, CALL_TIMEOUT_MS, sign.device ?? undefined)
      if (!this.alive(t, gen)) return
      if (got === null) {
        sign = null
        if (!(await this.missed(t, ++misses))) return
        continue
      }
      if (session.bridge.isCredentialsRejection(got)) {
        const again = await this.renewSignIn(t, gen, session.folder, sign.token)
        if (!this.alive(t, gen)) return
        if (again === null) {
          this.stop(t, { kind: 'failed', reason: refusalReason(got) })
          return
        }
        sign = again
        continue
      }
      if (session.bridge.isCredentialsFailure(got)) {
        this.stop(t, { kind: 'failed', reason: refusalReason(got) })
        return
      }
      this.addSecrets(t, [got.worker_jwt])
      if (handle !== null) {
        try {
          await handle.reconnectTransport({ ingressToken: got.worker_jwt, apiBaseUrl: got.api_base_url, epoch: got.worker_epoch })
        } catch (e) {
          if (!this.alive(t, gen)) return
          this.d.log.warn(`remote control: the connection could not be restored for tab ${t.target.tabId}: ${scrub(errorText(e), t.secrets)}`)
          // a failed reconnect closes the handle: it is dropped (closed once more, which the SDK may have done already), and the session is attached again from its sequence number
          sequence = handle.getSequenceNum()
          try {
            handle.close()
          } catch {
            // already closed by the SDK
          }
          handle = null
          t.handle = null
          sign = null
          if (mayBeUnsent) {
            // the session's history never reached claude.ai: nothing of it is kept, and the tab starts a fresh session through the first attach's path
            mayBeUnsent = false
            t.kept = false
            t.reconnecting = false
            // the cards open in the chat go to the fresh session too: resume sends each card the tab does not hold yet, and this session holds none
            t.openCards.clear()
            await this.d.sessions.forget(t.target.sessionId)
            if (!this.alive(t, gen)) return
            this.restartFresh(t)
            return
          }
          if (!(await this.missed(t, ++misses))) return
          continue
        }
        if (!this.alive(t, gen)) return
        t.reconnecting = false
        this.reportTurn(t, handle)
        this.turnOn(t, handle, session.remoteId)
        return
      }
      const attached = await this.openSession(t, gen, session.bridge, this.attachOptions(t, session.remoteId, got, sequence))
      if (!this.alive(t, gen)) {
        attached?.close()
        return
      }
      if (attached === null) {
        sign = null
        if (!(await this.missed(t, ++misses))) return
        continue
      }
      t.handle = attached
      t.reconnecting = false
      this.reportTurn(t, attached)
      this.turnOn(t, attached, session.remoteId)
      return
    }
  }

  /** the options of an attach of the tab's remote session, with its worker token and epoch and the callbacks the tab serves; a sequence number resumes the session */
  private attachOptions(t: Tab, remoteId: string, remote: RemoteCredentials, initialSequenceNum: number | null): AttachBridgeSessionOptions {
    const version = this.d.claudeVersion()
    const target = t.target
    return {
      sessionId: remoteId,
      ingressToken: remote.worker_jwt,
      apiBaseUrl: remote.api_base_url,
      epoch: remote.worker_epoch,
      ...(initialSequenceNum === null ? {} : { initialSequenceNum }),
      ...(version ? { claudeCodeVersion: version } : {}),
      onInboundMessage: (msg) => this.inbound(t, msg),
      onPermissionResponse: (res) => (this.answer(t, res) ? undefined : false),
      onInterrupt: () => {
        if (this.current(t)) this.d.chat.interrupt(target.tabId)
      },
      onClose: (code) => this.closed(t, code)
    }
  }

  /** the sign-in Claude Code has now. While it is expired, Claude Code renews it: the tab waits and reads it again every RENEW_EVERY_MS. claude.ai is asked once per attach to check its sign-in */
  private async signIn(t: Tab, gen: number, folder: string): Promise<ClaudeCredentials> {
    let creds = await this.d.credentials(folder, t.target.env)
    if (creds.state !== 'expired' || !this.alive(t, gen)) return creds
    t.state = { kind: 'connecting', note: RENEW_WAIT_NOTE }
    this.d.onChange(t.target.tabId)
    if (!t.checkedSignIn) {
      t.checkedSignIn = true
      void this.d.chat.checkSignIn(t.target.tabId).catch(() => undefined)
    }
    do {
      await this.wait(t, RENEW_EVERY_MS)
      creds = await this.d.credentials(folder, t.target.env)
    } while (creds.state === 'expired' && this.alive(t, gen))
    if (!this.alive(t, gen)) return creds
    t.state = { kind: 'connecting' }
    this.d.onChange(t.target.tabId)
    return creds
  }

  /** the sign-in as the token claude.ai is called with; no sign-in fails the tab as unavailable, a sign-in that cannot be used as a relogin */
  private signed(t: Tab, c: ClaudeCredentials): Sign | null {
    if (c.state === 'none') {
      this.stop(t, { kind: 'unavailable', reason: REMOTE_REASONS.noSignIn })
      return null
    }
    if (c.state !== 'fresh' || c.accessToken === null) {
      this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.relogin })
      return null
    }
    this.addSecrets(t, [c.accessToken, c.deviceToken])
    return { token: c.accessToken, device: c.deviceToken }
  }

  /** claude.ai rejected the token: Claude Code's sign-in is read again, once per attach or reconnect. The sign-in goes on when it is fresh with another token; null when it is not, and the tab needs a relogin */
  private async renewSignIn(t: Tab, gen: number, folder: string, rejected: string): Promise<Sign | null> {
    if (t.renewed) return null
    t.renewed = true
    const again = await this.signIn(t, gen, folder)
    if (!this.alive(t, gen)) return null
    if (again.state !== 'fresh' || again.accessToken === null || again.accessToken === rejected) return null
    this.addSecrets(t, [again.accessToken, again.deviceToken])
    return { token: again.accessToken, device: again.deviceToken }
  }

  /** a step missed (claude.ai did not answer, or the connection did not open): waits the backoff for its misses-th miss in a row and returns true, so the step goes on. The backoff is spent: the tab fails as unreachable and this returns false */
  private async missed(t: Tab, misses: number): Promise<boolean> {
    if (misses > BACKOFF_MS.length) {
      this.stop(t, { kind: 'failed', reason: REMOTE_REASONS.unreachable })
      return false
    }
    await this.wait(t, BACKOFF_MS[misses - 1])
    return true
  }

  /** waits ms on the tab: a stop of the tab cancels the wait, and then what waited never goes on */
  private wait(t: Tab, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      t.cancelWait = this.d.later(ms, () => resolve())
    })
  }

  /** the tab is on: its queued messages go to the handle, and its sequence number is stored every SEQUENCE_EVERY_MS */
  private turnOn(t: Tab, handle: Handle, remoteId: string): void {
    t.state = { kind: 'on', url: remoteLink(remoteId) }
    this.d.onChange(t.target.tabId)
    this.startSequence(t)
    const queue = t.queue
    t.queue = []
    for (const run of queue) run(handle)
  }

  /** while the tab is on, its sequence number is stored every SEQUENCE_EVERY_MS: an attach that resumes the session goes on from there */
  private startSequence(t: Tab): void {
    const tick = (): void => {
      if (t.handle !== null) void this.storeSequence(t, t.handle)
      t.cancelSequence = this.d.later(SEQUENCE_EVERY_MS, tick)
    }
    t.cancelSequence = this.d.later(SEQUENCE_EVERY_MS, tick)
  }

  /** the handle's sequence number, stored with its remote session */
  private async storeSequence(t: Tab, h: Handle): Promise<void> {
    const session = t.session
    // nothing is stored for a session whose history is not written yet
    if (session === null || !t.kept) return
    try {
      await this.d.sessions.put(t.target.sessionId, pathKey(session.folder), { remoteId: session.remoteId, sequenceNum: h.getSequenceNum() })
    } catch (e) {
      this.d.log.warn(`remote control: the sequence number cannot be stored for tab ${t.target.tabId}: ${scrub(errorText(e), t.secrets)}`)
    }
  }

  /** a state the tab stops in: its handle closes, what waits is dropped, and an attach still running stops too */
  private stop(t: Tab, state: RemoteState): void {
    this.halt(t)
    t.queue = []
    t.reconnecting = false
    const h = t.handle
    t.handle = null
    t.session = null
    h?.close()
    t.state = state
    this.d.onChange(t.target.tabId)
  }

  /** the tab's chain stops: its generation moves on, and its pending wait and sequence timer are cancelled */
  private halt(t: Tab): void {
    t.gen = ++this.gens
    t.cancelWait()
    t.cancelWait = NOOP
    t.cancelSequence()
    t.cancelSequence = NOOP
  }

  /** closes a handle after its last writes have had FLUSH_MS to reach claude.ai; its sequence number is stored once they have */
  private async flushAndClose(t: Tab, h: Handle): Promise<void> {
    let cancel = NOOP
    try {
      await Promise.race([
        h.flush().catch(() => undefined),
        new Promise<void>((resolve) => {
          cancel = this.d.later(FLUSH_MS, resolve)
        })
      ])
    } catch {
      // a flush that throws gives its writes no more time: the handle closes all the same, and the detach does not reject
    }
    cancel()
    await this.storeSequence(t, h)
    try {
      h.close()
    } catch (e) {
      this.d.log.warn(`remote control: the connection cannot be closed for tab ${t.target.tabId}: ${scrub(errorText(e), t.secrets)}`)
    }
  }

  /** the tokens a chain has read or received: a log line or a state never shows them */
  private addSecrets(t: Tab, tokens: (string | null)[]): void {
    for (const s of tokens) if (s !== null && s !== '' && !t.secrets.includes(s)) t.secrets.push(s)
  }

  /** the chain still serves the tab: not detached, not replaced by a new attach, and not stopped since it began */
  private alive(t: Tab, gen: number): boolean {
    return this.current(t) && t.gen === gen
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

  /** a message typed on claude.ai goes into the chat as the person's; one with no text does not. Images are not taken yet: their count is logged, not their content. A refusal is logged, and nothing is thrown into the SDK */
  private async inbound(t: Tab, msg: unknown): Promise<void> {
    if (!this.current(t) || !isRecord(msg) || msg.type !== 'user' || !isRecord(msg.message)) return
    const images = Array.isArray(msg.message.content) ? msg.message.content.filter((b) => isRecord(b) && b.type === 'image').length : 0
    if (images > 0) this.d.log.info(`a message from claude.ai had ${images} image(s): they are not sent to the chat`)
    const text = textOf(msg.message.content)
    if (text === '') return
    if (text.length > SEND_TEXT_CAP) {
      this.d.log.warn('a message from claude.ai was not sent: it is longer than a chat takes')
      return
    }
    try {
      const refused = await this.d.chat.send(t.target.tabId, text)
      if (refused !== null) this.d.log.warn(`a message from claude.ai was not sent: ${refused}`)
    } catch (e) {
      this.d.log.warn(`a message from claude.ai was not sent: ${scrub(errorText(e), t.secrets)}`)
    }
  }

  /** claude.ai's answer to an open card, as the chat takes it; false when it does not answer an open card or is malformed */
  private answer(t: Tab, res: unknown): boolean {
    if (!this.current(t) || !isRecord(res)) return false
    const body = res.response
    if (!isRecord(body) || body.subtype !== 'success' || typeof body.request_id !== 'string') return false
    const ask = t.openCards.get(body.request_id)
    if (!ask || !isRecord(body.response)) return false
    const result = answerResult(body.response, ask)
    if (result === null) return false
    return this.d.chat.answer(t.target.tabId, body.request_id, result)
  }
}
