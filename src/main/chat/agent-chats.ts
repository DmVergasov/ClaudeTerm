// The agents of a chat: one conversation per subagent, folded from the frames Claude Code sends for it. An agent's model is a ChatFold, so its
// items are folded by the same code as the main conversation. Everything here is untrusted input: a frame that does not fit is dropped.

import { agentDuration, isAgentId, type AgentPatch, type ChatAgentInfo, type ChatAgentState, type ChatItem, type ChatPatch, type ChatSubagent } from '../../shared/chat'
import { ChatFold, NAME_CAP, OUTPUT_CAP, SUBJECT_CAP, TEXT_CAP, cap, elapsed, isClaudeCodeFlag, isClaudeCodeText, isObj, num, resultAgentId, resultText, str, type ChatFoldOptions, type Obj } from './chat-fold'
import type { TranscriptPage } from './agent-history'

export const MAX_AGENT_ITEMS = 1000
export const MAX_AGENT_MODELS = 50
export const MAX_AGENT_RECORDS = 500
export const MAX_EARLY_FRAMES = 200
export const AGENT_PAGE = 200
/** the transcript heads of unwatched agents a chat keeps: the least recently used go past this many, so a page left and opened again keeps its items */
export const MAX_IDLE_HEADS = 4
/** the results kept while their calls are not in the model: past this many, the oldest goes */
const MAX_ORPHANS = 500
/** a frame's uuid longer than this is no key */
const UUID_CAP = 200

/** the patches of one agent, from its revision `fromRev` to `toRev` (one revision per patch) */
export interface AgentChange { agentId: string; fromRev: number; toRev: number; patches: AgentPatch[] }
export interface AgentChatsOptions extends ChatFoldOptions { firstRev: number }
/** a tool result whose call is not held yet: the block and the structured result, by the call's id */
export interface Orphan { block: Obj; structured: unknown }
export type Orphans = Map<string, Orphan>
/** an agent's transcript as read from disk: its items (oldest first), the keys of its lines, the results waiting for their calls, and the cursor of the page before (0: none) */
interface Head { items: ChatItem[]; keys: Set<string>; orphans: Orphans; cursor: number }
/** the cursor that reads the transcript from its end: a page read from it is the newest one */
const TRANSCRIPT_END = Number.MAX_SAFE_INTEGER

const FRAME_TYPES = ['assistant', 'user', 'stream_event']

/**
 * a frame of a subagent: its type is a frame's, and it names an agent (agent_id, of any type: a malformed one is still not the main
 * conversation's) or the call it runs under (parent_tool_use_id)
 */
export function isSubagentFrame(msg: unknown): boolean {
  if (!isObj(msg) || typeof msg.type !== 'string' || !FRAME_TYPES.includes(msg.type)) return false
  const agent = msg.agent_id
  const call = msg.parent_tool_use_id
  return (agent !== undefined && agent !== null) || (typeof call === 'string' && call !== '')
}

/**
 * the keys a frame is known by: its uuid (at most UUID_CAP characters), each tool call and each tool result, and each text or thinking
 * block of a message with an id (its message id and index)
 */
export function frameKeys(msg: unknown): string[] {
  if (!isObj(msg)) return []
  const keys: string[] = []
  if (typeof msg.uuid === 'string' && msg.uuid !== '' && msg.uuid.length <= UUID_CAP) keys.push(`uuid:${msg.uuid}`)
  const message = isObj(msg.message) ? msg.message : null
  const content: unknown[] = message !== null && Array.isArray(message.content) ? message.content : []
  content.forEach((block, index) => {
    if (!isObj(block)) return
    if (block.type === 'tool_use' && typeof block.id === 'string') keys.push(`tool:${block.id}`)
    else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') keys.push(`result:${block.tool_use_id}`)
    else if ((block.type === 'text' || block.type === 'thinking') && message !== null && typeof message.id === 'string') keys.push(`block:${message.id}:${index}:${block.type}`)
  })
  return keys
}

const isPrompt = (item: ChatItem): item is Extract<ChatItem, { kind: 'prompt' }> => item.kind === 'prompt'
type Forward = Extract<ChatItem, { kind: 'forward' }>

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

/** the wrapper Claude Code puts round a message the coordinator sent an agent; the message is the text it wraps */
const COORDINATOR_LINE = /^The coordinator sent a message while you were working:\n([\s\S]*)\n\nAddress this before completing your current task\.$/
/** a background task's notice, as the transcript holds it: the agent's own tasks are drawn by their rows, not as messages */
const TASK_NOTICE = /^\s*<task-notification[\s>]/

/** the message a coordinator's user line carries, unwrapped; null for any other text */
function coordinatorMessage(text: string): string | null {
  const wrapped = COORDINATOR_LINE.exec(text)
  return wrapped === null ? null : wrapped[1]!
}

/** one agent's conversation: its frames fold into the items its page draws, by the same code as the main chat */
export class AgentModel extends ChatFold {
  /** the agent's first message from Claude is its prompt; the later ones are messages from Claude. Carried over when the model is made again */
  private prompted: boolean
  /** the oldest items went out of the list: the page says it has older ones */
  private trimmed = false
  /** the most items the model holds; a transcript page is folded whole, so its model has no limit */
  private readonly limit: number
  /** the items each key of a frame is held by: a frame whose key is held is not folded again; a key goes with its last item */
  private readonly keyItems = new Map<string, Set<string>>()
  /** tool results whose call is not in the model: kept by the call's id, so an older page's call settles with them. Only a transcript's model keeps them */
  private readonly orphans: Orphans = new Map()
  private readonly transcript: boolean
  /** the prompt the agent's task_started gave, and its item: the transcript's first line is that prompt, so it is held already */
  private startPrompt: { id: string; text: string } | null = null
  /** the forwards the chat sent this agent, by id: a message of the agent's that carries one's text is its bubble, not a message from Claude */
  private readonly forwards = new Map<string, Forward>()
  /** the forward bubbles another part of the page holds (the live items, the transcript head): a line that carries one of their texts adds none */
  private reserved = new Set<string>()
  /** the forwards whose own line of the agent's transcript has not come yet: a coordinator's line that carries one's text is that line, once */
  private readonly awaiting = new Set<string>()

  constructor(o: ChatFoldOptions, prompted = false, limit = MAX_AGENT_ITEMS, transcript = false) {
    super(o)
    this.prompted = prompted
    this.limit = limit
    this.transcript = transcript
  }

  /** a frame or system message of the agent, or of a call it made: the patches it gives; the frame's keys are held with its items */
  apply(msg: unknown): ChatPatch[] {
    if (!isObj(msg)) return []
    const patches = this.fold(msg)
    const ids = new Set<string>()
    for (const p of patches) {
      if (p.op === 'add' || p.op === 'set') ids.add(p.item.id)
      else if (p.op === 'call') ids.add(p.id)
    }
    if (ids.size > 0) for (const key of frameKeys(msg)) this.keyItems.set(key, new Set([...(this.keyItems.get(key) ?? []), ...ids]))
    return patches
  }

  /** whether the model holds the key: a frame it has folded, whose items it still holds */
  holds(key: string): boolean {
    return this.keyItems.has(key)
  }

  /** whether the oldest items went out of the list */
  hasDropped(): boolean {
    return this.trimmed
  }

  /** the results still waiting for their calls */
  leftover(): Orphans {
    return this.orphans
  }

  /** takes the results still waiting from an older page's fold, so the calls it holds settle with them */
  adopt(orphans: Orphans): void {
    for (const [id, orphan] of orphans) this.orphans.set(id, orphan)
  }

  private fold(msg: Obj): ChatPatch[] {
    switch (msg.type) {
      case 'assistant': {
        const message = msg.message
        return isObj(message) && Array.isArray(message.content) ? this.assistantBlocks(message.content, false) : []
      }
      case 'user': return this.user(msg)
      case 'attachment': return this.queued(msg)
      case 'system':
        if (msg.subtype === 'task_started') return this.taskStarted(msg)
        if (msg.subtype === 'task_notification') return this.taskNotification(msg)
        return []
      // a stream event gives nothing: the whole message comes after it
      default: return []
    }
  }

  /** whether the agent's own items hold the call: the call is one of its tool calls */
  holdsCall(callId: string): boolean {
    return this.calls.has(callId)
  }

  /** whether the agent's first message from Claude has come */
  hasPrompt(): boolean {
    return this.prompted
  }

  /**
   * The agent's prompt, from its task_started: it comes before the items the model holds, so an early frame comes after it. false when
   * the model has its prompt already.
   */
  takePrompt(text: string): boolean {
    if (this.prompted) return false
    this.prompted = true
    const item: Extract<ChatItem, { kind: 'prompt' }> = { kind: 'prompt', id: this.o.newId(), text: cap(text, TEXT_CAP), first: true }
    this.startPrompt = { id: item.id, text: item.text }
    this.list.unshift(item)
    this.list.forEach((held, i) => this.at.set(held.id, i))
    this.trim()
    return true
  }

  /** the id of the prompt the model took from its task_started, while the model holds that item: it is the model's first item */
  startId(): string | null {
    const id = this.startPrompt?.id ?? null
    return id !== null && this.at.has(id) ? id : null
  }

  /** whether a transcript line is the prompt the model took from its task_started, while that item is held */
  holdsStartPrompt(msg: unknown): boolean {
    const start = this.startPrompt
    if (start === null || this.startId() === null || !isObj(msg) || msg.type !== 'user' || !isObj(msg.message)) return false
    const text = plainText(msg.message.content)
    return text !== null && cap(text, TEXT_CAP) === start.text
  }

  /** a forward the chat sent this agent: its bubble is added at the end, or set when the model holds it */
  forward(item: Forward): ChatPatch[] {
    if (!this.at.has(item.id)) this.awaiting.add(item.id)
    this.know(item)
    return this.at.has(item.id) ? this.set(item) : this.add(item)
  }

  /** a forward the agent is sent: known to the model, so its own line in the transcript joins its bubble, without adding one */
  know(item: Forward): void {
    this.forwards.set(item.id, item)
    if (this.transcript) this.awaiting.add(item.id)
  }

  /** the forward bubbles another part of the page holds: a line that carries one of their texts adds none */
  reserve(ids: Set<string>): void {
    this.reserved = ids
  }

  /** the first forward still awaiting its own line whose text is the message, if any */
  private awaitingFor(message: string): Forward | undefined {
    for (const id of this.awaiting) {
      const item = this.forwards.get(id)
      if (item !== undefined && item.text === message) return item
    }
    return undefined
  }

  /**
   * A coordinator's message that is a forward's own line: the forward's bubble, in place, unless the model holds it or another part of the
   * page does. Undefined when no forward awaits a line with this text, so the line is a message from Claude.
   */
  private forwardLine(message: string): ChatPatch[] | undefined {
    const forward = this.awaitingFor(message)
    if (forward === undefined) return undefined
    this.awaiting.delete(forward.id)
    return this.at.has(forward.id) || this.reserved.has(forward.id) ? [] : this.add(forward)
  }

  /** a queued message of the coordinator, as the transcript's attachment line: the forward's own line when it carries a forward's text */
  private queued(msg: Obj): ChatPatch[] {
    const attachment = msg.attachment
    if (!isObj(attachment) || attachment.type !== 'queued_command' || typeof attachment.prompt !== 'string') return []
    if (!isObj(attachment.origin) || attachment.origin.kind !== 'coordinator') return []
    return this.forwardLine(attachment.prompt) ?? []
  }

  divider(text: string): ChatPatch[] {
    return this.add({ kind: 'divider', id: this.o.newId(), text })
  }

  protected override add(item: ChatItem): ChatPatch[] {
    const patches = super.add(item)
    this.trim()
    return patches
  }

  /** the oldest items go past the limit: the model says so, and the keys of what went go with them */
  private trim(): void {
    if (this.dropOldest(this.limit)) {
      this.trimmed = true
      this.forgetDropped()
    }
  }

  /** the keys of items that went out of the list go with them */
  private forgetDropped(): void {
    const held = new Set(this.items().map(item => item.id))
    for (const [key, ids] of this.keyItems) {
      for (const id of ids) if (!held.has(id)) ids.delete(id)
      if (ids.size === 0) this.keyItems.delete(key)
    }
  }

  protected override toolResults(content: unknown[], structured: unknown): ChatPatch[] {
    if (this.transcript) {
      for (const block of content) {
        if (!isObj(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const id = cap(block.tool_use_id, NAME_CAP)
        if (!this.calls.has(id)) this.keepOrphan(id, block, structured)
      }
    }
    return super.toolResults(content, structured)
  }

  /** a call that starts where a result waits for it settles with the result at once */
  protected override toolUse(block: Obj): ChatPatch[] {
    const patches = super.toolUse(block)
    const id = str(block.id)
    const orphan = id === null ? undefined : this.orphans.get(cap(id, NAME_CAP))
    if (id === null || orphan === undefined) return patches
    this.orphans.delete(cap(id, NAME_CAP))
    return [...patches, ...this.toolResults([orphan.block], orphan.structured)]
  }

  /** keeps what settling the call needs: its text as tool output caps it, its error flag, and the agent the result names (read before the cap) */
  private keepOrphan(id: string, block: Obj, structured: unknown): void {
    const text = resultText(block.content)
    const named = resultAgentId(text, structured)
    const kept: Obj = { type: 'tool_result', tool_use_id: id, content: cap(text, OUTPUT_CAP), ...(block.is_error === true ? { is_error: true } : {}) }
    this.orphans.set(id, { block: kept, structured: named === null ? null : { agentId: named } })
    if (this.orphans.size > MAX_ORPHANS) this.orphans.delete(this.orphans.keys().next().value as string)
  }

  private user(msg: Obj): ChatPatch[] {
    if (!isObj(msg.message)) return []
    const content = msg.message.content
    if (Array.isArray(content) && content.some(block => isObj(block) && block.type === 'tool_result')) {
      return this.toolResults(content, msg.tool_use_result ?? msg.toolUseResult)
    }
    const text = plainText(content)
    if (text === null || text === '') return []
    // the coordinator's line of a forward is that forward's bubble, in place; any other line, a prompt that merely carries its text included, is from Claude
    const coordinator = msg.isMeta === true && isObj(msg.origin) && msg.origin.kind === 'coordinator'
    const message = coordinator ? coordinatorMessage(text) : null
    if (message !== null) {
      const drawn = this.forwardLine(message)
      if (drawn !== undefined) return drawn
    }
    // the lines Claude Code writes itself are no message from Claude (the main chat drops them too), nor is a task's notice
    if ((isClaudeCodeFlag(msg) && !coordinator) || isClaudeCodeText(text) || TASK_NOTICE.test(text)) return []
    const first = !this.prompted
    this.prompted = true
    return this.add({ kind: 'prompt', id: this.o.newId(), text: cap(message ?? text, TEXT_CAP), first })
  }
}

/**
 * The agents of one chat. The chat calls `apply` with every stream message: a frame of a subagent, a task_started or a task_notification
 * gives changes; anything else gives none, at once.
 */
export class AgentChats {
  private readonly o: AgentChatsOptions
  private readonly models = new Map<string, AgentModel>()
  private readonly records = new Map<string, ChatAgentInfo>()
  /** the session each agent started in: its transcript is in that session's folder */
  private readonly sessions = new Map<string, string>()
  private readonly revs = new Map<string, number>()
  /** the agent each Agent call started, by the call's tool_use id */
  private readonly callTasks = new Map<string, string>()
  /** frames that name a call no task has started yet, oldest first */
  private early: { call: string; frame: Obj }[] = []
  private readonly watchers = new Map<string, number>()
  /** when each agent was used last, as a tick of a counter */
  private readonly used = new Map<string, number>()
  /** agents whose items left memory, or come from a transcript: their history is read when their page opens, unless the head is held */
  private readonly needs = new Set<string>()
  /** the transcript head of each agent whose history was read: kept while the agent is watched, and dropped with its model */
  private readonly heads = new Map<string, Head>()
  /** agents whose first message from Claude has come: kept when their model is made again */
  private readonly promptSeen = new Set<string>()
  /** the forwards the chat sent each agent, by id: a model made later knows them, and a transcript line that carries one's text joins its bubble */
  private readonly bubbles = new Map<string, Map<string, Forward>>()
  private tick = 0
  /** the highest revision handed out to any agent: a record made later starts counting from it, so a forgotten agent never goes back */
  private top: number

  constructor(o: AgentChatsOptions) {
    this.o = o
    this.top = o.firstRev
  }

  /** a stream message: a subagent's frame, a task_started or a task_notification; [] for anything else */
  apply(msg: unknown, sessionId: string | null = null): AgentChange[] {
    if (!isObj(msg)) return []
    if (isSubagentFrame(msg)) return this.frame(msg, sessionId)
    if (msg.type !== 'system') return []
    if (msg.subtype === 'task_started') return this.started(msg, sessionId)
    if (msg.subtype === 'task_notification') return this.ended(msg)
    return []
  }

  info(agentId: string): ChatAgentInfo | null {
    const record = this.records.get(agentId)
    return record === undefined ? null : { ...record }
  }

  /** the session the agent started in: its transcript is in that session's folder */
  sessionOf(agentId: string): string | null {
    return this.sessions.get(agentId) ?? null
  }

  /** the newest AGENT_PAGE items of the agent, and whether older ones exist; null for an agent the chat does not know */
  page(agentId: string): { rev: number; items: ChatItem[]; hasOlder: boolean } | null {
    if (!this.records.has(agentId)) return null
    const rev = this.revs.get(agentId) ?? this.o.firstRev
    const drawn = this.drawn(agentId)
    return { rev, items: drawn.items.slice(-AGENT_PAGE), hasOlder: drawn.hasOlder }
  }

  /**
   * The items of the agent before `beforeId`. The cursor of the transcript comes back when `beforeId` is the first item held and the
   * transcript has more before it: the caller reads that page and gives it to olderPage. An id the agent does not hold (its page left memory) gives nothing.
   * null for an agent the chat does not know.
   */
  older(agentId: string, beforeId: string): { items: ChatItem[]; hasOlder: boolean } | { cursor: number } | null {
    if (!this.records.has(agentId)) return null
    const drawn = this.drawn(agentId)
    const at = drawn.items.findIndex(item => item.id === beforeId)
    if (at < 0) return { items: [], hasOlder: false }
    // the first item held: the transcript before it is read, from the head's cursor, or from its end when no head holds the agent yet
    const head = this.heads.get(agentId)
    if (at === 0 && (head === undefined ? this.needs.has(agentId) : head.cursor > 0)) return { cursor: head?.cursor ?? TRANSCRIPT_END }
    const start = Math.max(0, at - AGENT_PAGE)
    return { items: drawn.items.slice(start, at), hasOlder: start > 0 || drawn.cursor > 0 }
  }

  /** a transcript page before the agent's head: folded, and put before the head; its newest AGENT_PAGE items are the answer */
  olderPage(agentId: string, page: TranscriptPage): { items: ChatItem[]; hasOlder: boolean } {
    if (!this.records.has(agentId)) return { items: [], hasOlder: false }
    // a page read from the transcript's end, with no head yet, starts the head
    const head = this.heads.get(agentId) ?? { items: [], keys: new Set<string>(), orphans: new Map<string, Orphan>(), cursor: 0 }
    this.heads.set(agentId, head)
    const fold = this.foldPage(agentId, head, page.lines, page.start === 0)
    const items = fold.items().slice()
    head.items = [...items, ...head.items]
    head.orphans = fold.leftover()
    head.cursor = page.start
    return { items: items.slice(-AGENT_PAGE), hasOlder: items.length > AGENT_PAGE || page.start > 0 }
  }

  /**
   * The agent's transcript, as its newest page read: the head is that page's items (its lines the agent holds are skipped), and the
   * reset that comes with it is one change of the agent. A null page is a transcript that could not be read: the head is empty then.
   */
  history(agentId: string, page: TranscriptPage | null): AgentChange[] {
    if (!this.records.has(agentId)) return []
    const head: Head = { items: [], keys: new Set(), orphans: new Map(), cursor: 0 }
    if (page !== null) {
      const fold = this.foldPage(agentId, head, page.lines, page.start === 0)
      head.items = fold.items().slice()
      head.orphans = fold.leftover()
      head.cursor = page.start
    }
    this.heads.set(agentId, head)
    this.needs.add(agentId)
    return this.change(agentId, [this.window(agentId)])
  }

  /** the agent's page as a reset: its transcript head and live items, the newest AGENT_PAGE of them */
  private window(agentId: string): ChatPatch {
    const drawn = this.drawn(agentId)
    return { op: 'reset', items: drawn.items.slice(-AGENT_PAGE), hasOlder: drawn.hasOlder }
  }

  /**
   * Folds transcript lines, oldest first, into a model of their own: its results still waiting come with it (leftover), and it
   * settles the calls an older page holds. A line with a key the head or the live model holds is skipped, and so is the transcript's
   * first line when the live model holds the prompt its task_started gave (begins: the lines start the transcript).
   */
  private foldPage(agentId: string, head: Head, lines: Record<string, unknown>[], begins: boolean): AgentModel {
    const live = this.models.get(agentId)
    const fold = new AgentModel(this.o, !begins, Infinity, true)
    fold.adopt(head.orphans)
    for (const item of this.bubbles.get(agentId)?.values() ?? []) fold.know(item)
    // a bubble the live model or the head holds is drawn already: the line that carries its text adds none
    fold.reserve(new Set([...(live?.items() ?? []), ...head.items].flatMap(item => (item.kind === 'forward' ? [item.id] : []))))
    for (const [i, msg] of lines.entries()) {
      const keys = frameKeys(msg)
      if (keys.some(key => head.keys.has(key) || (live?.holds(key) ?? false))) continue
      if (begins && i === 0 && (live?.holdsStartPrompt(msg) ?? false)) continue
      fold.apply(msg)
      for (const key of keys) head.keys.add(key)
    }
    return fold
  }

  /**
   * The items the agent's page draws, oldest first: its transcript head, then its live items; a live prompt is no first prompt once the head
   * has one. The prompt from the task_started is the agent's first item, so it stays before the head. `cursor` is where the head's older
   * transcript page ends (0: none).
   */
  private drawn(agentId: string): { items: ChatItem[]; hasOlder: boolean; cursor: number } {
    const head = this.heads.get(agentId)
    const model = this.models.get(agentId)
    const headPrompted = head !== undefined && head.items.some(isPrompt)
    const live = model === undefined ? [] : model.items().map(item => (headPrompted && isPrompt(item) && item.first ? { ...item, first: false } : item))
    const lead = model !== undefined && live.length > 0 && live[0].id === model.startId() ? live.slice(0, 1) : []
    const items = [...lead, ...(head?.items ?? []), ...live.slice(lead.length)]
    const cursor = head?.cursor ?? 0
    const hasOlder = items.length > AGENT_PAGE || cursor > 0 || (model?.hasDropped() ?? false) || (this.needs.has(agentId) && head === undefined)
    return { items, hasOlder, cursor }
  }

  /** whether the agent's items must be read from its transcript to show them: they left memory, or came from a transcript, and no head holds them */
  needsHistory(agentId: string): boolean {
    return this.needs.has(agentId) && !this.heads.has(agentId)
  }

  /**
   * A forward the chat sent an agent: its bubble is on the agent's page, added at the end or set (the same id). An agent the chat does not
   * know yet (a resumed chat's history names it after its forwards) keeps the bubble for its transcript, which places it.
   */
  forward(item: Forward): AgentChange[] {
    const id = item.agentId
    if (!isAgentId(id)) return []
    const held = this.bubbles.get(id) ?? new Map<string, Forward>()
    held.set(item.id, item)
    this.bubbles.set(id, held)
    if (!this.records.has(id)) return []
    // a bubble the transcript head holds is set there: the live model adds no second one
    const head = this.heads.get(id)
    if (head?.items.some(kept => kept.id === item.id)) {
      head.items = head.items.map(kept => (kept.id === item.id ? item : kept))
      return this.change(id, [{ op: 'set', item }])
    }
    return this.change(id, this.modelOf(id).forward(item))
  }

  /** an agent the main conversation's history names: known and ended, read from its transcript when its page opens */
  known(agent: ChatSubagent, sessionId: string | null): void {
    if (!isAgentId(agent.id) || this.records.has(agent.id)) return
    const state: ChatAgentState = agent.state === 'done' ? 'done' : agent.stopped === true ? 'stopped' : 'failed'
    this.makeRecord({ id: agent.id, type: agent.type, description: agent.description, state, startedAt: null, ms: agent.ms, parentId: null })
    this.remember(agent.id, sessionId)
    this.needs.add(agent.id)
  }

  /** a viewer opens (true) or leaves (false) the agent's page: a watched agent is never evicted; an agent the chat does not know is not watched */
  watch(agentId: string, on: boolean): void {
    if (!this.records.has(agentId)) return
    const count = this.watchers.get(agentId) ?? 0
    const next = on ? count + 1 : Math.max(0, count - 1)
    if (next === 0) this.watchers.delete(agentId)
    else this.watchers.set(agentId, next)
    this.touch(agentId)
    if (next === 0) this.keepIdleHeads()
  }

  /** the transcript heads of unwatched agents are kept, the MAX_IDLE_HEADS most recently used of them: the others go, and their next open reads the transcript again */
  private keepIdleHeads(): void {
    let idle = [...this.heads.keys()].filter(id => !this.watched(id))
    while (idle.length > MAX_IDLE_HEADS) {
      const victim = this.leastTouched(idle, () => true)
      if (victim === null) return
      this.heads.delete(victim)
      idle = idle.filter(id => id !== victim)
    }
  }

  /** the highest revision any agent has reached (firstRev before any change) */
  maxRev(): number {
    return this.top
  }

  /** a frame of an agent: by its agent_id, else by the call it runs under; a frame of a call no task has started waits */
  private frame(msg: Obj, sessionId: string | null): AgentChange[] {
    // a stream event is a partial of a message that comes whole later: it names no agent to record and no call to buffer
    if (msg.type === 'stream_event') return []
    const agent = msg.agent_id
    if (agent !== undefined && agent !== null) {
      if (!isAgentId(agent)) return []
      this.ensure(agent, sessionId)
      return this.fold(agent, msg)
    }
    const call = cap(str(msg.parent_tool_use_id) ?? '', NAME_CAP)
    const task = this.callTasks.get(call)
    if (task === undefined) {
      this.early.push({ call, frame: msg })
      if (this.early.length > MAX_EARLY_FRAMES) this.early.shift()
      return []
    }
    return this.fold(task, msg)
  }

  /**
   * A task that started: a new agent gets its record, its parent is the agent whose model holds the call; an agent the chat already
   * has is filled in when a frame made it, or resumed when it ended. The parent's model folds the message, and the frames that came
   * before it are folded now.
   */
  private started(msg: Obj, sessionId: string | null): AgentChange[] {
    const id = msg.task_id
    if (!isAgentId(id)) return []
    const call = typeof msg.tool_use_id === 'string' && msg.tool_use_id !== '' ? cap(msg.tool_use_id, NAME_CAP) : null
    const owner = call === null ? null : this.ownerOf(call)
    const type = cap(str(msg.subagent_type) ?? str(msg.task_type) ?? 'agent', NAME_CAP)
    const description = cap(str(msg.description) ?? '', SUBJECT_CAP)
    const now = this.o.now()
    const changes: AgentChange[] = []
    const record = this.records.get(id)
    // the prompt is the agent's task_started prompt; a resume's is the message Claude forwarded to it, so it is no prompt
    const prompt = typeof msg.prompt === 'string' && msg.prompt !== '' ? msg.prompt : null
    const resumed = record !== undefined && record.state !== 'running'
    if (record === undefined) {
      this.makeRecord({ id, type, description, state: 'running', startedAt: now, ms: null, parentId: owner })
      this.remember(id, sessionId)
    } else if (record.state === 'running') {
      const parentId = owner ?? record.parentId
      if (record.type !== type || record.description !== description || record.parentId !== parentId) {
        Object.assign(record, { type, description, parentId })
        changes.push(...this.change(id, [this.agentPatch(record)]))
      }
    } else {
      record.state = 'running'
      record.startedAt = now
      record.ms = null
      this.remember(id, sessionId)
      changes.push(...this.change(id, [...this.modelOf(id).divider('Resumed'), this.agentPatch(record)]))
    }
    if (prompt !== null && !resumed && this.modelOf(id).takePrompt(prompt)) {
      this.promptSeen.add(id)
      changes.push(...this.change(id, [this.window(id)]))
    }
    if (call !== null) this.callTasks.set(call, id)
    if (owner !== null) {
      const parent = this.models.get(owner)
      if (parent !== undefined) changes.push(...this.change(owner, parent.apply(msg)))
    }
    if (call !== null && this.early.some(entry => entry.call === call)) {
      const waiting = this.early.filter(entry => entry.call === call)
      this.early = this.early.filter(entry => entry.call !== call)
      for (const entry of waiting) changes.push(...this.fold(id, entry.frame))
    }
    return changes
  }

  /** a task that ended: its record takes the state and the length, its page a divider, and its parent's model folds the notice */
  private ended(msg: Obj): AgentChange[] {
    const id = msg.task_id
    if (!isAgentId(id)) return []
    const record = this.records.get(id)
    if (record === undefined || record.state !== 'running') return []
    const status = str(msg.status)
    const state: ChatAgentState | null = status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : null
    if (state === null) return []
    const now = this.o.now()
    const reported = isObj(msg.usage) ? num(msg.usage.duration_ms) : null
    const ms = reported !== null && reported >= 0 ? reported : elapsed(record.startedAt ?? now, now)
    record.state = state
    record.ms = ms
    const text = state === 'done' ? `Agent finished · ${agentDuration(ms)}` : state === 'failed' ? 'Agent failed' : 'Agent stopped'
    const changes = this.change(id, [...this.modelOf(id).divider(text), this.agentPatch(record)])
    const parentId = record.parentId
    const parent = parentId === null ? undefined : this.models.get(parentId)
    if (parentId !== null && parent !== undefined) changes.push(...this.change(parentId, parent.apply(msg)))
    return changes
  }

  /** the record of an agent a frame names, made at once: running, of no type yet, under no parent */
  private ensure(id: string, sessionId: string | null): void {
    if (!this.records.has(id)) this.makeRecord({ id, type: 'agent', description: '', state: 'running', startedAt: this.o.now(), ms: null, parentId: null })
    this.remember(id, sessionId)
  }

  /** a new record: past MAX_AGENT_RECORDS the least recently touched unwatched agent is forgotten first; it counts its revisions from the highest handed out */
  private makeRecord(record: ChatAgentInfo): void {
    if (this.records.size >= MAX_AGENT_RECORDS) this.forget()
    this.records.set(record.id, record)
    this.revs.set(record.id, Math.max(this.o.firstRev, this.top))
    this.touch(record.id)
  }

  /** an agent is forgotten whole: its record, model, history mark, session, touch time and the calls it started; a watched agent is never the one */
  private forget(): void {
    const victim = this.leastTouched(this.records.keys(), id => !this.watched(id))
    if (victim === null) return
    this.records.delete(victim)
    this.models.delete(victim)
    this.heads.delete(victim)
    this.needs.delete(victim)
    this.sessions.delete(victim)
    this.used.delete(victim)
    this.revs.delete(victim)
    this.promptSeen.delete(victim)
    this.bubbles.delete(victim)
    for (const [call, task] of this.callTasks) if (task === victim) this.callTasks.delete(call)
  }

  /** the session an agent started in is kept from its first sight */
  private remember(id: string, sessionId: string | null): void {
    if (sessionId !== null && !this.sessions.has(id)) this.sessions.set(id, sessionId)
  }

  /** the agent whose model holds the call: the parent of an agent that call started */
  private ownerOf(call: string): string | null {
    for (const [id, model] of this.models) if (model.holdsCall(call)) return id
    return null
  }

  private fold(id: string, msg: Obj): AgentChange[] {
    const model = this.modelOf(id)
    const patches = model.apply(msg)
    if (model.hasPrompt()) this.promptSeen.add(id)
    return this.change(id, patches)
  }

  /** the model of an agent, made when it is first needed; see makeRoom for what a new one takes from the others */
  private modelOf(id: string): AgentModel {
    this.touch(id)
    const known = this.models.get(id)
    if (known !== undefined) return known
    this.makeRoom()
    const model = new AgentModel(this.o, this.promptSeen.has(id))
    for (const item of this.bubbles.get(id)?.values() ?? []) model.know(item)
    this.models.set(id, model)
    return model
  }

  /**
   * Once MAX_AGENT_MODELS models hold items, a new one takes the items of the least recently touched ended unwatched model. When none is
   * ended and more than twice the cap hold items, the least recently touched unwatched running one gives its items up too. Its record
   * stays and its history is needed; a watched model is never the one.
   */
  private makeRoom(): void {
    const holders = [...this.models.keys()].filter(id => (this.models.get(id)?.items().length ?? 0) > 0)
    if (holders.length < MAX_AGENT_MODELS) return
    const ended = this.leastTouched(holders, id => this.records.get(id)?.state !== 'running' && !this.watched(id))
    const victim = ended ?? (holders.length > 2 * MAX_AGENT_MODELS ? this.leastTouched(holders, id => !this.watched(id)) : null)
    if (victim === null) return
    this.models.delete(victim)
    // its items are in the transcript now, and its head goes with them: the next open reads the transcript again
    this.heads.delete(victim)
    this.needs.add(victim)
  }

  /** the id, of those given, that was touched least recently and passes the test; null when none does */
  private leastTouched(ids: Iterable<string>, pick: (id: string) => boolean): string | null {
    let victim: string | null = null
    for (const id of ids) {
      if (!pick(id)) continue
      if (victim === null || (this.used.get(id) ?? 0) < (this.used.get(victim) ?? 0)) victim = id
    }
    return victim
  }

  private watched(id: string): boolean {
    return (this.watchers.get(id) ?? 0) > 0
  }

  private touch(id: string): void {
    this.used.set(id, ++this.tick)
  }

  /** the agent's revision moves by one per patch; a window of the agent gets the change with its revisions before and after */
  private change(id: string, patches: (ChatPatch | AgentPatch)[]): AgentChange[] {
    const kept = patches.filter((p): p is Exclude<ChatPatch, { op: 'state' }> => p.op !== 'state')
    if (kept.length === 0) return []
    // a model that trimmed its oldest items: they are in the transcript, so the agent's history is read from it when needed
    if (this.models.get(id)?.hasDropped()) {
      this.needs.add(id)
      // a kept head of an unwatched agent would leave a gap where the trimmed items were: it goes, and the next open reads the transcript
      if (!this.watched(id)) this.heads.delete(id)
    }
    const fromRev = this.revs.get(id) ?? this.o.firstRev
    const toRev = fromRev + kept.length
    this.revs.set(id, toRev)
    this.top = Math.max(this.top, toRev)
    return [{ agentId: id, fromRev, toRev, patches: kept }]
  }

  private agentPatch(record: ChatAgentInfo): AgentPatch {
    return { op: 'agent', agent: { ...record } }
  }
}
