// The chat of one tab: folds the SDK messages (live or from history) into the items the chat view draws.
// Everything here is untrusted input: a field of the wrong type is ignored, an unknown kind gives no patch.

import { commandWord, isHandoffLine, type ChatCard, type ChatEventSource, type ChatItem, type ChatNoticeAction, type ChatPatch, type ChatPermissionMode, type ChatSend, type ChatState } from '../../shared/chat'
import { isUuid } from '../../shared/protocol'
import { forwardLabel, notForwardedReason, parseForward } from './agent-forward'
import { ChatFold, EFFORTS, MODEL_CAP, NAME_CAP, OUTPUT_CAP, SUBJECT_CAP, TEXT_CAP, cap, elapsed, isClaudeCodeFlag, isClaudeCodeText, isObj, num, resultText, str, type ChatFoldOptions, type Obj, type OpenBlock } from './chat-fold'
export { PAGE, SUBJECT_CAP, cap, toolSubject } from './chat-fold'

const LIMIT_MS_FROM = 1e11
/** the leading tag of a message Claude Code sends in the conversation for something other than the person's typing */
const ENVELOPE = /^\s*<(task-notification|agent-message|cross-session-message|channel)(?=[\s>])/

const PERMISSION_MODES: readonly ChatPermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']
/** the resumed agents kept until their notifications come */
const MAX_RESUMED = 64

export type ChatModelOptions = ChatFoldOptions

/** a prompt we sent: `started` once its turn has begun, so it is dropped when that turn's result comes */
interface SentEntry { text: string; started: boolean; id: string }
/** a forward taken into a turn, until its SendMessage's result or its turn settles it: its item, its agent, the call that sends it (null: none claimed yet) */
interface Open { itemId: string; agentId: string; callId: string | null }
/** a SendMessage call of the turn that runs: its agent, its id, its result once it came, whether an open forward has claimed it */
interface Send { agentId: string; callId: string; result: Obj | null; claimed: boolean }
type Limit = { usedPct: number; resetsAt: number }

/** one limit of a rate_limit_event: utilization as a fraction or a percent, resetsAt in seconds or ms; null when a field is not a number */
const limitOf = (window: unknown): Limit | null => {
  if (!isObj(window)) return null
  const utilization = num(window.utilization)
  const reset = num(window.resetsAt)
  if (utilization === null || reset === null) return null
  const percent = utilization > 1 ? utilization : utilization * 100
  return { usedPct: Math.round(Math.min(100, Math.max(0, percent))), resetsAt: reset > LIMIT_MS_FROM ? Math.floor(reset / 1000) : reset }
}
export const isPermissionMode = (v: unknown): v is ChatPermissionMode => PERMISSION_MODES.includes(v as ChatPermissionMode)
const pad = (n: number): string => String(n).padStart(2, '0')

/** a token count as a compaction's divider shows it: 950, 3.9k, 27k */
function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${Math.round(n / 100) / 10}k`
  return `${Math.round(n / 1000)}k`
}

/** a duration as a compaction's divider shows it: 640 ms, 10 s */
const durationText = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)} s`)

/** the text of a user message whose content is plain text (a string, or text blocks only); null for anything else */
function plainText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (!isObj(block) || block.type !== 'text' || typeof block.text !== 'string') return null
    parts.push(block.text)
  }
  return parts.join('\n')
}

/** a message Claude Code puts in the conversation that the person did not type, as the row it is drawn as */
interface EventDraft { source: ChatEventSource; title: string; status: string | null; body: string; task: string | null }

/** the text of a field of an envelope (`<summary>…</summary>`), trimmed; null when the envelope has no such field */
function fieldOf(text: string, name: string): string | null {
  const open = `<${name}>`
  const from = text.indexOf(open)
  if (from < 0) return null
  const start = from + open.length
  const end = text.indexOf(`</${name}>`, start)
  return end < 0 ? null : text.slice(start, end).trim()
}

/** an attribute of an envelope's opening tag; null when it has none */
function attrOf(text: string, name: string): string | null {
  const m = new RegExp(`^\\s*<[^>]*?\\s${name}="([^"]*)"`).exec(text)
  return m === null ? null : m[1]!
}

/** the body of a `<tag …>body</tag>` envelope (the closing tag may be missing); the text itself when it is no envelope */
function envelopeBody(text: string): string {
  // no backtracking: the opening tag is matched at the start, and the closing tag is looked for at the end only
  const open = /^\s*<[a-z-][^>]*>/.exec(text)
  if (open === null) return text.trim()
  let body = text.slice(open[0].length).trimEnd()
  const close = body.lastIndexOf('</')
  if (close >= 0 && /^<\/[a-z-]+>$/.test(body.slice(close))) body = body.slice(0, close)
  return body.trim()
}

/**
 * The row a message the person did not type makes; null for a message that is the person's own (a bubble). With the SDK's
 * origin: anything but `human`. Without one, only a message that starts with a known envelope tag makes a row.
 */
function eventOf(origin: unknown, text: string): EventDraft | null {
  const kind = isObj(origin) ? str(origin.kind) : null
  if (kind === 'human') return null
  const tag = ENVELOPE.exec(text)?.[1] ?? null
  if (kind === null && tag === null) return null
  if (tag === 'task-notification') {
    const status = fieldOf(text, 'status')
    const id = fieldOf(text, 'task-id')
    return {
      source: 'task',
      title: cap(fieldOf(text, 'summary') ?? 'A background task ended', SUBJECT_CAP),
      status: status === null || status === 'completed' ? null : cap(status, NAME_CAP),
      body: cap(fieldOf(text, 'result') ?? fieldOf(text, 'output') ?? '', TEXT_CAP),
      task: id === null || id === '' ? null : cap(id, NAME_CAP)
    }
  }
  if (kind === 'peer' || tag === 'agent-message' || tag === 'cross-session-message') {
    const sender = isObj(origin) ? str(origin.name) ?? str(origin.from) : null
    const name = sender ?? attrOf(text, 'name') ?? attrOf(text, 'from')
    const body = (isObj(origin) ? str(origin.body) : null) ?? envelopeBody(text)
    return {
      source: 'peer',
      title: cap(name === null || name === '' ? 'Message from another session' : `Message from ${name}`, SUBJECT_CAP),
      status: null,
      body: cap(body, TEXT_CAP),
      task: null
    }
  }
  // a channel, a scheduled trigger, a coordinator, an observer or any other message Claude Code sends: its first line, and the whole text
  // folded under it; an envelope's title and body are those of its stripped body, never of its tag line
  const body = tag === null ? text : envelopeBody(text)
  const first = body.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return { source: 'message', title: cap(first, SUBJECT_CAP), status: null, body: cap(body, TEXT_CAP), task: null }
}

/** the first word of a typed command: '/context' of '/context now' */
const firstWord = (text: string): string => cap(commandWord(text), NAME_CAP)

/**
 * The answer of a command this environment does not have: the command's name. The wording is the stand-in's: Claude Code's own
 * wording was never recorded (fixture finding (f)). Only a synthetic answer to the command the user just sent counts; a sentence
 * in Claude's reply is text.
 */
const UNAVAILABLE = /^\/(\S+) isn't available in this environment\.$/
const SYNTHETIC = '<synthetic>'

/** the first line of a text, trimmed and capped at 300 */
const firstLine = (s: string): string => (s.split(/\r?\n/)[0] ?? '').trim().slice(0, 300).trim()

/** the first text block of a result's content (or its string content); '' when there is none */
function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const block = content.find((b): b is Obj => isObj(b) && b.type === 'text' && typeof b.text === 'string')
  return block === undefined ? '' : (block.text as string)
}

/** the agent a delivered SendMessage resumed: its result says `Resuming agent` and names the agent (resumedAgentId); null for any other result */
function resumedAgent(block: Obj): string | null {
  const text = cap(firstText(block.content), OUTPUT_CAP)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const json = isObj(parsed) ? parsed : null
  if (json === null || !(str(json.message) ?? '').startsWith('Resuming agent')) return null
  const id = str(json.resumedAgentId)
  return id === null || id.length > NAME_CAP ? null : id
}

/** a SendMessage result: delivered only when its first text is JSON with success true and the result is no error; else failed, with the first line of the message, else of the text */
function sendOutcome(block: Obj): { ok: true } | { ok: false; reason: string } {
  const text = cap(firstText(block.content), OUTPUT_CAP)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const json = isObj(parsed) ? parsed : null
  if (json !== null && json.success === true && block.is_error !== true) return { ok: true }
  const reason = firstLine(json === null ? '' : (str(json.message) ?? '')) || firstLine(text) || 'Not delivered'
  return { ok: false, reason }
}

export class ChatModel extends ChatFold {
  /** the prompts we sent that no echo has come back for yet, oldest first */
  private readonly sent: SentEntry[] = []
  /** the ids of the user items queued while a turn ran, oldest first */
  private readonly queue: string[] = []
  private readonly st: ChatState = { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false }
  /** a result came and no message has started the next turn yet */
  private afterResult = false
  /** a main turn runs (its state is working, or it waits on a card): set and cleared with the turn's state */
  private inTurn = false
  /** the user asked to stop the running turn: its result is an interruption */
  private interrupted = false
  /** the last command the user typed, until its output comes */
  private command: string | null = null
  /** the last message the user typed that is a command, as typed: its line goes to the terminal from a notice */
  private typed: string | null = null
  private contextPct: number | null = null
  private contextUsed: number | null = null
  private contextSize: number | null = null
  private fiveHour: Limit | null = null
  private sevenDay: Limit | null = null
  /** the reset time of the usage limit we said was reached, so it is said once */
  private rejectedAt: number | null = null
  /** the forwards taken into a turn that no result has settled yet, oldest first */
  private openForwards: Open[] = []
  /** the SendMessage calls of the turn that runs: an open forward claims the first unclaimed call to its agent */
  private sends: Send[] = []
  /** the text Claude wrote in the turn that runs, capped: the reason of a forward the turn did not send */
  private turnText = ''
  /** the turn that began last carried only forwards */
  private forwardTurn = false
  /** the agents a delivered forward resumed, until each one's notification comes: past MAX_RESUMED, the oldest goes */
  private readonly resumed = new Set<string>()
  /** a resumed agent notified: the next turn Claude starts by itself is quiet, as the forward's answer to the notice */
  private quietNext = false

  constructor(o: ChatModelOptions) {
    super(o)
  }

  /** one SDK message, live or from history; anything malformed or unknown gives [] */
  apply(msg: unknown): ChatPatch[] {
    if (!isObj(msg)) return []
    // a message of a subagent (parent_tool_use_id or agent_id set, whatever the agent_id's type) is not part of the main conversation: its own calls tell its model and context
    const ofSubagent = (typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id !== '') || (msg.agent_id !== undefined && msg.agent_id !== null)
    if (ofSubagent) return msg.type === 'assistant' ? this.subagentCall(msg) : []
    switch (msg.type) {
      case 'stream_event': {
        // a frame that begins a turn after a result: the flag of the turn before is over, and a forward this frame takes sets it again
        const begins = this.afterResult
        if (begins) this.selfStarted()
        const folded = this.taken(msg, begins)
        return [...folded.patches, ...(isObj(msg.event) ? [...this.turnBegins(folded.named), ...this.stream(msg.event)] : [])]
      }
      case 'assistant': {
        const begins = this.afterResult
        if (begins) this.selfStarted()
        const folded = this.taken(msg, begins)
        return [...folded.patches, ...this.assistant(msg, folded.named)]
      }
      case 'user': return this.user(msg)
      case 'system': return this.system(msg)
      case 'result': return this.result(msg)
      case 'rate_limit_event': return this.rateLimit(msg.rate_limit_info)
      default: return []
    }
  }

  /** the user's message, shown at once; queued while a turn runs */
  userSent(send: ChatSend, id: string = this.o.newId()): ChatPatch[] {
    const text = cap(send.text, TEXT_CAP)
    // while the queue is not empty, a send waits behind it, even when the turn is idle between two of them
    const idle = this.st.turn === 'idle'
    const waits = !idle || this.queue.length > 0
    this.sent.push({ text, started: !waits, id })
    this.step = null
    if (text.startsWith('/')) {
      this.command = firstWord(text)
      this.typed = text
    }
    // a forward the agent page sent is a forward item; a text the parser refuses is a plain message
    const forward = send.from === 'agent' ? parseForward(text) : null
    const item: ChatItem = forward === null
      ? { kind: 'user', id, text, attachments: send.attachments, queued: waits, ...(send.from === undefined ? {} : { from: send.from }) }
      : { kind: 'forward', id, agentId: forward.agentId, label: forwardLabel(forward.type, forward.description), text: forward.text, state: waits ? 'queued' : 'sending', reason: null }
    // a send that starts a turn ends the open forward first: that forward's turn is over
    const patches: ChatPatch[] = waits ? [] : this.settleOpen(false)
    patches.push(...this.add(item))
    if (!waits) {
      this.begin(item)
      patches.push(...this.beginTurn())
    } else {
      this.queue.push(item.id)
      if (idle) patches.push(...this.setState({ turn: 'working', turnStartedAt: this.o.now() }))
    }
    return patches
  }

  /** the user asked to stop the running turn: the result that follows is an interruption, when a turn runs */
  markInterrupted(): void {
    if (this.st.turn !== 'idle') this.interrupted = true
  }

  /** a permission or question card is shown and waits for the user: the turn waits */
  cardOpened(id: string, card: ChatCard): ChatPatch[] {
    const patches = this.add({ kind: 'card', id, card, answered: null })
    patches.push(...this.setState({ turn: 'waiting' }))
    return patches
  }

  /** the user answered a card: the turn waits again while another card is open, else runs */
  cardAnswered(id: string, line: string): ChatPatch[] {
    const item = this.get(id)
    const patches = item?.kind === 'card' ? this.set({ ...item, answered: line }) : []
    const stillWaiting = this.list.some(i => i.kind === 'card' && i.answered === null)
    // a card a background agent opens after the turn ended leaves the chat idle, not working with no turn to end it
    if (stillWaiting) patches.push(...this.setState({ turn: 'waiting' }))
    else if (this.inTurn) patches.push(...this.setState({ turn: 'working' }))
    else patches.push(...this.setState({ turn: 'idle', turnStartedAt: null }))
    return patches
  }

  notice(text: string, tone: 'info' | 'error', action: ChatNoticeAction | null): ChatPatch[] {
    return this.add({ kind: 'notice', id: this.o.newId(), tone, text: cap(text, OUTPUT_CAP), action })
  }

  /** a divider line; `good` is its highlighted part, when it has one */
  divider(text: string, good?: string): ChatPatch[] {
    return this.add({ kind: 'divider', id: this.o.newId(), text, ...(typeof good === 'string' ? { good } : {}) })
  }

  /** an item of the chat the hub owns: added, or set in place when an item with its id is there */
  put(item: ChatItem): ChatPatch[] {
    return this.at.has(item.id) ? this.set(item) : this.add(item)
  }

  /** removes an item; the items after it keep their order and their index; [] for an id the chat does not hold */
  drop(id: string): ChatPatch[] {
    const i = this.at.get(id)
    if (i === undefined) return []
    this.list.splice(i, 1)
    this.at.delete(id)
    for (let j = i; j < this.list.length; j++) this.at.set(this.list[j].id, j)
    return [{ op: 'remove', id }]
  }

  /** changes the state the status bar and the chat header show; [] when nothing changed */
  setState(partial: Partial<ChatState>): ChatPatch[] {
    // a turn runs from its start until its end: a card's wait keeps the turn it stops, so it does not change the flag
    if (partial.turn === 'working') this.inTurn = true
    else if (partial.turn === 'idle') this.inTurn = false
    const changed = (Object.keys(partial) as (keyof ChatState)[]).some(key => partial[key] !== this.st[key])
    if (!changed) return []
    Object.assign(this.st, partial)
    return [{ op: 'state', state: this.state() }]
  }

  state(): ChatState {
    return { ...this.st }
  }

  /** what the stream said of the status bar; null fields: not said yet */
  status(): { model: string | null; effort: string | null; contextPct: number | null; contextUsed: number | null; contextSize: number | null; fiveHour: Limit | null; sevenDay: Limit | null } {
    return { model: this.st.model, effort: this.st.effort, contextPct: this.contextPct, contextUsed: this.contextUsed, contextSize: this.contextSize, fiveHour: this.fiveHour, sevenDay: this.sevenDay }
  }

  /** the login the limits were read under is gone (a /login to another account): none until the stream reports the new one's; true when there were some */
  forgetLimits(): boolean {
    if (this.fiveHour === null && this.sevenDay === null) return false
    this.fiveHour = null
    this.sevenDay = null
    return true
  }

  /** the context fill the hub reads from the engine, with its token counts */
  setContext(c: { pct: number | null; used: number | null; size: number | null }): void {
    this.contextPct = c.pct
    this.contextUsed = c.used
    this.contextSize = c.size
  }

  /** the history of a resumed chat is in: a call still running in it was cut off, so it ends as interrupted, and its turn ends with it */
  historyLoaded(): ChatPatch[] {
    const patches = [...this.settleOpen(false), ...this.failRunning('Interrupted'), ...this.setState({ turn: 'idle', turnStartedAt: null })]
    this.resetTurnCalls()
    return patches
  }

  private beginTurn(): ChatPatch[] {
    this.afterResult = false
    return this.setState({ turn: 'working', turnStartedAt: this.o.now() })
  }

  /** a turn begins with this item: a forward it carries is open until its turn settles it; a user item makes the turn no forward turn */
  private begin(item: ChatItem): void {
    this.forwardTurn = item.kind === 'forward'
    if (item.kind === 'forward') this.openForwards.push({ itemId: item.id, agentId: item.agentId, callId: null })
  }

  /** a turn takes a send: a user item is no longer queued and makes the turn no forward turn; a queued forward is sending and open, and begins the turn only when begins */
  private unqueue(id: string, begins: boolean): ChatPatch[] {
    const item = this.get(id)
    if (item?.kind === 'user') {
      this.forwardTurn = false
      return this.set({ ...item, queued: false })
    }
    if (item?.kind === 'forward' && item.state === 'queued') {
      const sending: ChatItem = { ...item, state: 'sending' }
      if (begins) this.forwardTurn = true
      this.openForwards.push({ itemId: id, agentId: item.agentId, callId: null })
      return this.set(sending)
    }
    return []
  }

  /** the open forwards end with their turn: one whose call has no result fails, and so does each when the turn was interrupted; one without a call is skipped, with Claude's reason */
  private settleOpen(interrupted: boolean): ChatPatch[] {
    const patches: ChatPatch[] = []
    for (const open of this.openForwards.splice(0)) {
      const item = this.get(open.itemId)
      if (item?.kind !== 'forward') continue
      if (interrupted || open.callId !== null) patches.push(...this.set({ ...item, state: 'failed', reason: 'Interrupted' }))
      else patches.push(...this.set({ ...item, state: 'skipped', reason: notForwardedReason(this.turnText) }))
    }
    return patches
  }

  /** the SendMessage calls of the turn that runs, and the text Claude wrote in it; an id longer than a name is no call to match */
  private recordSends(content: unknown[]): void {
    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_use' || block.name !== 'SendMessage' || !isObj(block.input)) continue
      const to = block.input.to
      if (typeof block.id !== 'string' || block.id.length > NAME_CAP || typeof to !== 'string') continue
      this.sends.push({ agentId: to, callId: block.id, result: null, claimed: false })
    }
    const said = content.flatMap(block => (isObj(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    if (said.length > 0) this.turnText = cap(said.join('\n'), TEXT_CAP)
  }

  /** a delivered forward resumed its agent: the agent's notification, when it comes, marks the next self-started turn as a forward turn */
  private noteResumed(block: Obj): void {
    const id = resumedAgent(block)
    if (id === null) return
    this.resumed.add(id)
    if (this.resumed.size > MAX_RESUMED) this.resumed.delete(this.resumed.values().next().value as string)
  }

  /** each open forward without a call claims the first unclaimed call of the turn to its agent; one whose call has its result is settled by it */
  private attach(): ChatPatch[] {
    for (const open of this.openForwards) {
      if (open.callId !== null) continue
      const send = this.sends.find(s => !s.claimed && s.agentId === open.agentId)
      if (send === undefined) continue
      send.claimed = true
      open.callId = send.callId
    }
    const patches: ChatPatch[] = []
    for (const open of [...this.openForwards]) {
      const result = this.sends.find(s => s.callId === open.callId)?.result ?? null
      if (result === null) continue
      this.openForwards.splice(this.openForwards.indexOf(open), 1)
      const item = this.get(open.itemId)
      if (item?.kind !== 'forward') continue
      const outcome = sendOutcome(result)
      if (outcome.ok) this.noteResumed(result)
      patches.push(...this.set({ ...item, state: outcome.ok ? 'delivered' : 'failed', reason: outcome.ok ? null : outcome.reason }))
    }
    return patches
  }

  /** a tool result of the turn: the result of a SendMessage call is its send's, and settles the forward that call sends */
  private forwardResult(content: unknown[]): ChatPatch[] {
    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const send = this.sends.find(s => s.callId === block.tool_use_id && s.result === null)
      if (send !== undefined) send.result = block
    }
    return this.attach()
  }

  /** the calls and text of a turn are done with: the history's turns hold no result to end them, so each history turn resets them */
  private resetTurnCalls(): void {
    this.sends = []
    this.turnText = ''
  }

  /** a forward with no call of its own ends with the turn that took it, when no next turn is queued for it: skipped, with Claude's reason */
  private skipUnclaimed(reason: string | null): ChatPatch[] {
    const patches: ChatPatch[] = []
    for (const open of this.openForwards.filter(o => o.callId === null)) {
      this.openForwards.splice(this.openForwards.indexOf(open), 1)
      const item = this.get(open.itemId)
      if (item?.kind !== 'forward') continue
      patches.push(...this.set({ ...item, state: 'skipped', reason }))
    }
    return patches
  }

  /** a message of the person's the transcript holds: a forward's header makes a forward item, its turn settles it; any other is a user item */
  private historyMessage(text: string): ChatPatch[] {
    const forward = parseForward(text)
    const newTurn = this.st.turn === 'idle' || this.afterResult
    const patches = newTurn ? this.settleOpen(false) : []
    if (newTurn) this.resetTurnCalls()
    const id = this.o.newId()
    const item: ChatItem = forward === null
      ? { kind: 'user', id, text, attachments: [], queued: false }
      : { kind: 'forward', id, agentId: forward.agentId, label: forwardLabel(forward.type, forward.description), text: forward.text, state: 'sending', reason: null }
    this.begin(item)
    return [...patches, ...this.add(item)]
  }

  /** the sends Claude Code took into the turn, as a frame of the turn names them by their uuids: those stop being queued; named: the frame carries a valid uuid field */
  private taken(msg: Obj, begins: boolean): { patches: ChatPatch[]; named: boolean; ids: string[] } {
    const many = msg.user_message_uuids
    const named = Array.isArray(many)
      ? many.length <= 64 && many.every(id => typeof id === 'string')
      : typeof msg.user_message_uuid === 'string'
    const ids: string[] = !named ? [] : Array.isArray(many) ? (many as string[]) : [msg.user_message_uuid as string]
    const patches: ChatPatch[] = []
    for (const id of ids) {
      const at = this.queue.indexOf(id)
      if (at < 0) continue
      this.queue.splice(at, 1)
      const entry = this.sent.find(e => e.id === id)
      if (entry) entry.started = true
      patches.push(...this.unqueue(id, begins))
    }
    return { patches, named, ids }
  }

  /** a send the turn took is no longer one to wait for: its prompt entry goes */
  private dropSent(id: string): void {
    const at = this.sent.findIndex(e => e.id === id)
    if (at >= 0) this.sent.splice(at, 1)
  }

  /** the first message after a result starts the next turn: its queued prompt, if any, is no longer queued; a frame that names its sends (named) took them itself */
  private turnBegins(named = false): ChatPatch[] {
    if (!this.afterResult) return []
    this.afterResult = false
    const patches = this.st.turn === 'idle' ? this.setState({ turn: 'working', turnStartedAt: this.o.now() }) : []
    if (named) return patches
    const entry = this.sent.find(e => !e.started)
    if (entry) entry.started = true
    const id = this.queue.shift()
    if (id !== undefined) patches.push(...this.unqueue(id, true))
    return patches
  }

  private stream(ev: Obj): ChatPatch[] {
    if (ev.type === 'message_start') return this.settleOpenText()
    const index = typeof ev.index === 'number' && Number.isInteger(ev.index) ? ev.index : -1
    if (index < 0) return []
    switch (ev.type) {
      case 'content_block_start': return this.blockStart(index, ev.content_block)
      case 'content_block_delta': return this.blockDelta(index, ev.delta)
      case 'content_block_stop': return this.blockStop(index)
      default: return []
    }
  }

  private blockStart(index: number, block: unknown): ChatPatch[] {
    if (!isObj(block)) return []
    if (block.type === 'thinking') {
      this.open.set(index, { kind: 'thinking', startedAt: this.o.now(), ms: null })
      return []
    }
    if (block.type !== 'text') return []
    const id = this.o.newId()
    this.open.set(index, { kind: 'text', id })
    return this.addText({ kind: 'text', id, markdown: cap(str(block.text) ?? '', TEXT_CAP), streaming: true })
  }

  private blockDelta(index: number, delta: unknown): ChatPatch[] {
    const entry = this.open.get(index)
    if (!isObj(delta) || delta.type !== 'text_delta' || entry?.kind !== 'text') return []
    const text = str(delta.text)
    const item = this.get(entry.id)
    if (text === null || item?.kind !== 'text') return []
    const piece = cap(text, TEXT_CAP - item.markdown.length)
    if (piece === '') return []
    this.store({ ...item, markdown: item.markdown + piece })
    return [{ op: 'append', id: item.id, text: piece }]
  }

  private blockStop(index: number): ChatPatch[] {
    const entry = this.open.get(index)
    if (entry?.kind === 'thinking') entry.ms = elapsed(entry.startedAt, this.o.now())
    return []
  }

  /** a message starts: the text items still streaming from the message before get their whole text as they are */
  private settleOpenText(): ChatPatch[] {
    const patches: ChatPatch[] = []
    for (const entry of this.open.values()) {
      const item = entry.kind === 'text' ? this.get(entry.id) : undefined
      if (item?.kind === 'text') patches.push(...this.set({ ...item, streaming: false }))
    }
    this.open.clear()
    return patches
  }

  private assistant(msg: Obj, named = false): ChatPatch[] {
    const message = msg.message
    if (!isObj(message) || !Array.isArray(message.content)) return []
    const patches = this.turnBegins(named)
    // a local command's answer (/context, /config): its own item, not a message of Claude's
    if (typeof msg.local_command_source === 'string') {
      const text = resultText(message.content)
      return [...patches, ...(this.notAvailable(text, message.model === SYNTHETIC, undefined) ?? this.commandItem(text))]
    }
    this.recordSends(message.content)
    patches.push(...this.attach())
    patches.push(...this.assistantBlocks(message.content, message.model === SYNTHETIC))
    return patches
  }

  /**
   * The notice of a command this environment does not have, answered to the command the user just sent: a notice that opens the
   * line in the terminal, in the place of the text (an open text item is set). Null when the text is not that answer. The name is
   * kept for the session: the next time that command goes to the terminal.
   */
  protected override notAvailable(text: string, synthetic: boolean, entry: OpenBlock | undefined): ChatPatch[] | null {
    const unavailable = synthetic ? UNAVAILABLE.exec(text) : null
    if (unavailable === null || this.typed === null || commandWord(this.typed) !== `/${unavailable[1]!}`) return null
    const name = `/${unavailable[1]!}`
    // the typed message goes to the terminal when it is one line the handoff takes; else the name alone
    const typed = isHandoffLine(this.typed) ? this.typed : name
    const id = entry?.kind === 'text' ? entry.id : this.o.newId()
    // a name the terminal would not take gives a notice without its button
    const notice: ChatItem = isHandoffLine(typed)
      ? { kind: 'notice', id, tone: 'info', text: cap(text, OUTPUT_CAP), action: 'open-terminal', line: typed }
      : { kind: 'notice', id, tone: 'info', text: cap(text, OUTPUT_CAP), action: null }
    return entry?.kind === 'text' ? this.set(notice) : this.add(notice)
  }

  /** a local command's output: the item of the command the user typed last */
  private commandItem(output: string): ChatPatch[] {
    const command = this.command ?? ''
    this.command = null
    this.step = null
    return this.add({ kind: 'command', id: this.o.newId(), command, output: cap(output, OUTPUT_CAP) })
  }

  private user(msg: Obj): ChatPatch[] {
    if (!isObj(msg.message)) return []
    const content = msg.message.content
    if (Array.isArray(content) && content.some(block => isObj(block) && block.type === 'tool_result')) {
      return [...this.forwardResult(content), ...this.toolResults(content, msg.tool_use_result ?? msg.toolUseResult)]
    }
    // the summary a compaction leaves: a resumed conversation's history starts with it and has no boundary before it, so it draws
    // the divider; live, the boundary drew it already
    if (msg.isCompactSummary === true) return this.list.at(-1)?.kind === 'divider' ? [] : this.divider('Conversation compacted')
    if (isClaudeCodeFlag(msg)) return []
    const text = plainText(content)
    if (text === null || text === '') return []
    // a message Claude Code puts in the conversation that the person did not type: a row, not a bubble; a background task whose end
    // the chat drew from its system message adds nothing
    // the text is parsed capped, as it is drawn: a longer envelope is cut where its drawn text is
    const event = eventOf(msg.origin, cap(text, TEXT_CAP))
    if (event !== null) {
      if (event.task !== null && this.ended.has(event.task)) return []
      this.step = null
      return this.add({ kind: 'event', id: this.o.newId(), source: event.source, title: event.title, status: event.status, body: event.body })
    }
    // Claude Code's own messages: the interrupt notice, a command's output and its name, the compaction summary
    if (isClaudeCodeText(text)) return []
    const output = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-(stdout|stderr)>/.exec(text)
    if (output !== null) return this.commandItem(output[2])
    const drawn = cap(text, TEXT_CAP)
    if (this.sent[0]?.text === drawn) {
      this.sent.shift()
      return []
    }
    // a command typed in the terminal is a command of this chat too: its arguments are kept for a notice's line
    if (drawn.startsWith('/')) {
      this.command = firstWord(drawn)
      this.typed = drawn
    }
    this.step = null
    return this.historyMessage(drawn)
  }

  /** a system message: the session's init and status, a local command's output, compaction, retries, subagents */
  private system(msg: Obj): ChatPatch[] {
    switch (msg.subtype) {
      case 'init': return this.init(msg)
      case 'status': return this.statusMessage(msg)
      case 'local_command_output': return typeof msg.content === 'string' ? this.commandItem(msg.content) : []
      case 'compact_boundary': return this.compacted(msg)
      case 'session_state_changed': return this.sessionState(msg.state)
      case 'api_retry': return this.retry(msg)
      case 'task_started': return this.taskStarted(msg)
      case 'task_notification': return this.agentNotified(msg)
      default: return []
    }
  }

  /** a task's notification: a resumed agent's makes the next turn Claude starts by itself a quiet one */
  private agentNotified(msg: Obj): ChatPatch[] {
    const taskId = str(msg.task_id)
    if (taskId !== null && this.resumed.delete(taskId)) this.quietNext = true
    return this.taskNotification(msg)
  }

  /** a turn Claude starts by itself is a forward turn only when a resumed agent's notification came before it */
  private selfStarted(): void {
    this.forwardTurn = this.quietNext
    this.quietNext = false
  }

  /** a status of Claude Code: its mode, and a compaction that runs (the chat's activity) or fails (a notice) */
  private statusMessage(msg: Obj): ChatPatch[] {
    const patches: ChatPatch[] = []
    if (isPermissionMode(msg.permissionMode)) patches.push(...this.setState({ mode: msg.permissionMode }))
    if (msg.status === 'compacting') {
      if (this.st.activity?.kind !== 'compacting') patches.push(...this.setState({ activity: { kind: 'compacting', since: this.o.now() } }))
    } else if (this.st.activity?.kind === 'compacting') {
      patches.push(...this.setState({ activity: undefined }))
    }
    if (msg.compact_result === 'failed') {
      const error = str(msg.compact_error)
      patches.push(...this.notice(error === null || error === '' ? 'Compaction failed' : `Compaction failed: ${error}`, 'error', null))
    }
    return patches
  }

  /** the boundary of a compaction: its divider says what it did, with the numbers Claude Code gives; each part only when given */
  private compacted(msg: Obj): ChatPatch[] {
    const meta: Obj = isObj(msg.compact_metadata) ? msg.compact_metadata : {}
    const parts = [meta.trigger === 'auto' ? 'Conversation compacted automatically' : 'Conversation compacted']
    const before = num(meta.pre_tokens)
    const after = num(meta.post_tokens)
    const ms = num(meta.duration_ms)
    if (before !== null && after !== null) parts.push(`${tokenCount(before)} → ${tokenCount(after)} tokens`)
    if (ms !== null) parts.push(durationText(ms))
    const ended = this.st.activity?.kind === 'compacting' ? this.setState({ activity: undefined }) : []
    return [...ended, ...this.divider(parts.join(' · '))]
  }

  /** Claude Code's own account of the turn: running starts it, idle ends it unless a queued message waits, a card is left to the cards */
  private sessionState(state: unknown): ChatPatch[] {
    if (state === 'running') return this.setState(this.st.turn === 'idle' ? { turn: 'working', turnStartedAt: this.o.now() } : { turn: 'working' })
    if (state === 'idle') return this.queue.length > 0 ? [] : this.setState({ turn: 'idle', turnStartedAt: null })
    return []
  }

  private init(msg: Obj): ChatPatch[] {
    const partial: Partial<ChatState> = {}
    if (isPermissionMode(msg.permissionMode)) partial.mode = msg.permissionMode
    if (typeof msg.model === 'string' && msg.model !== '') partial.model = cap(msg.model, MODEL_CAP)
    if (isUuid(msg.session_id)) partial.sessionId = msg.session_id
    // the effort in effect for the next message: a level, or null when none is sent; anything else, or no field, keeps the last
    if (msg.effort === null) partial.effort = null
    else if (typeof msg.effort === 'string' && EFFORTS.includes(msg.effort)) partial.effort = msg.effort
    // Claude Code starts every turn with an init: after a result, the next turn runs from this one
    if (this.afterResult && this.st.turn === 'idle') Object.assign(partial, { turn: 'working', turnStartedAt: this.o.now() })
    return this.setState(partial)
  }

  private retry(msg: Obj): ChatPatch[] {
    const attempt = num(msg.attempt)
    const max = num(msg.max_retries)
    const delay = num(msg.retry_delay_ms)
    if (attempt === null || max === null || delay === null) return []
    return this.notice(`Retrying in ${Math.ceil(delay / 1000)}s · attempt ${attempt} of ${max}`, 'info', null)
  }

  /** a result ends its turn; an interrupted one says so, a failed one says why */
  private result(msg: Obj): ChatPatch[] {
    const interrupted = this.interrupted || msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools'
    this.interrupted = false
    this.afterResult = true
    // the forwards this turn carried settle first: a forward the result names is the next turn's, so it waits for its SendMessage
    const patches: ChatPatch[] = this.settleOpen(interrupted)
    // the sends the result names were folded into this turn: they leave the queue, and their prompts are no longer waiting
    const folded = this.taken(msg, false)
    patches.push(...folded.patches)
    // the calls of this turn claim the forwards it took, then the turn's calls and text are done with
    patches.push(...this.attach())
    // the reason of a forward the turn did not send is read before the turn's text goes
    const reason = notForwardedReason(this.turnText)
    this.resetTurnCalls()
    if (folded.named) {
      for (const id of folded.ids) this.dropSent(id)
    } else {
      const done = this.sent.findIndex(e => e.started)
      if (done >= 0) this.sent.splice(done, 1)
    }
    // a command's name belongs to its own output: a turn that ends without one leaves no name for the next
    this.command = null
    // a result that names no queued turn after it ends the turn: the sends still waiting stay queued, each for the frames of its own turn,
    // since Claude Code may still be on its way to run one of them
    const noTurnAfter = msg.queued_turn_count === 0
    // the turn ends with its result, unless a queued prompt still waits: Claude Code takes that prompt into the next turn at once,
    // so the first waiting send leaves the queue here, and the turn goes on with it, on a new clock
    // a result ends a compaction that never reported its end
    if (this.st.activity?.kind === 'compacting') patches.push(...this.setState({ activity: undefined }))
    const next = noTurnAfter ? undefined : this.queue.shift()
    if (next === undefined) {
      patches.push(...this.skipUnclaimed(reason))
      patches.push(...this.setState({ turn: 'idle', turnStartedAt: null }))
    } else {
      // the frames of that turn must not take another send: the first one is taken here
      this.afterResult = false
      const entry = this.sent.find(e => !e.started)
      if (entry) entry.started = true
      patches.push(...this.unqueue(next, true))
      patches.push(...this.setState({ turn: 'working', turnStartedAt: this.o.now() }))
    }
    if (interrupted) {
      patches.push(...this.settleOpenText(), ...this.failRunning('Interrupted'), ...this.notice('Interrupted', 'info', null))
    } else if (msg.is_error === true) {
      patches.push(...this.notice(this.errorText(msg), 'error', null))
    }
    return patches
  }

  private errorText(msg: Obj): string {
    const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === 'string' && e !== '') : []
    if (errors.length > 0) return cap(errors.join('; '), OUTPUT_CAP)
    const text = str(msg.result)
    if (text !== null && text !== '') return cap(text, OUTPUT_CAP)
    return 'Claude Code reported an error'
  }

  /** the process ended: what it left running ends as interrupted, and so do its agents */
  processEnded(): ChatPatch[] {
    return this.failRunning('Interrupted')
  }

  /** the forwards of the chat, oldest first */
  forwards(): Extract<ChatItem, { kind: 'forward' }>[] {
    return this.list.filter((item): item is Extract<ChatItem, { kind: 'forward' }> => item.kind === 'forward')
  }

  /** whether the turn that began last carried only forwards */
  lastTurnWasForward(): boolean {
    return this.forwardTurn
  }

  /** a forward still waiting or sending ends with the reason: its queue entry and prompt go, and it is no longer open */
  endForwards(reason: string): ChatPatch[] {
    const open = this.forwards().filter(f => f.state === 'queued' || f.state === 'sending')
    const patches: ChatPatch[] = []
    for (const item of open) {
      if (item.state === 'queued') {
        const at = this.queue.indexOf(item.id)
        if (at >= 0) this.queue.splice(at, 1)
        this.dropSent(item.id)
      }
      patches.push(...this.set({ ...item, state: 'failed', reason }))
    }
    this.openForwards.splice(0)
    return patches
  }

  /** the usage limits of the stream, as the status line gives them; a rejected limit is said once per reset */
  private rateLimit(info: unknown): ChatPatch[] {
    if (!isObj(info)) return []
    const reset = num(info.resetsAt)
    const resetsAt = reset === null ? null : reset > LIMIT_MS_FROM ? Math.floor(reset / 1000) : reset
    // both windows come in unifiedWindows; the top-level type and utilization stand in for a window it lacks or garbles
    const windows: Obj = isObj(info.unifiedWindows) ? info.unifiedWindows : {}
    const fiveHour = limitOf(windows.five_hour) ?? (info.rateLimitType === 'five_hour' ? limitOf(info) : null)
    const sevenDay = limitOf(windows.seven_day) ?? (info.rateLimitType === 'seven_day' ? limitOf(info) : null)
    if (isObj(info.unifiedWindows)) {
      // unifiedWindows lists every window the account has: one it no longer lists is gone, as after a /login to an
      // account without it. An event without the list names only its own window, and the other one stays
      this.fiveHour = fiveHour
      this.sevenDay = sevenDay
    } else {
      if (fiveHour !== null) this.fiveHour = fiveHour
      if (sevenDay !== null) this.sevenDay = sevenDay
    }
    if (info.status !== 'rejected' || resetsAt === null || this.rejectedAt === resetsAt) return []
    this.rejectedAt = resetsAt
    const at = new Date(resetsAt * 1000)
    return this.notice(`Usage limit reached · resets at ${pad(at.getHours())}:${pad(at.getMinutes())}`, 'info', null)
  }

}
