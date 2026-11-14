import { type ChatCallState, type ChatItem, type ChatPatch, type ChatSubagent, type ChatToolCall, isAgentId } from '../../shared/chat'
import { DEFAULT_IMAGE_EXTENSIONS, hasImageExtension } from '../../shared/image-file'
import type { ImageCard } from '../../shared/types'
import { isWithin, nativePath, pathKey } from '../path-key'

// The folding both conversations share: an assistant message's blocks, the results of its tool calls, the subagents of Agent calls and the
// list of items the chat view draws. Everything here is untrusted input: a field of the wrong type is ignored, an unknown kind gives no patch.

export interface ChatFoldOptions { now(): number; newId(): string; folder(): string }

export const TEXT_CAP = 1024 * 1024
export const OUTPUT_CAP = 64 * 1024
export const SUBJECT_CAP = 500

/** names and ids Claude Code gives: tools, tasks, subagent types, typed commands */
export const NAME_CAP = 500
const PATH_CAP = 4096
export const MODEL_CAP = 200
const MCP_INPUT_CAP = 80
export const PAGE = 200

/** the ends of background tasks the chat remembers, oldest dropped first */
const MAX_ENDED_TASKS = 500

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit']

/** the effort levels Claude Code has */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** a stream block still open: a text item being streamed, or a thinking block with its stream start and length */
export type OpenBlock = { kind: 'text'; id: string } | { kind: 'thinking'; startedAt: number; ms: number | null }

/** what an Agent call asks of its subagents: a model (an alias) and an effort, each only when it names one */
interface AgentAsk { model?: string; effort?: string }
/** a tool call's link to its tools item, when it started, the image it shows (null: none), and what an Agent call asks */
interface CallLink { itemId: string; start: number; image: string | null; ask?: AgentAsk }
/** a subagent's link to the Task call that started it */
interface TaskLink { itemId: string; callId: string; start: number }

type ToolsItem = Extract<ChatItem, { kind: 'tools' }>

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)
const pathOf = (v: unknown): string | null => {
  const s = str(v)
  return s === null ? null : cap(s, PATH_CAP)
}
const lines = (s: string): number => (s === '' ? 0 : s.split('\n').length)

/** the time from a moment to a later one, in milliseconds: a clock that stepped back gives none, never a negative time */
export const elapsed = (from: number, to: number): number => Math.max(0, to - from)
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
/** the model and effort an Agent call's input names (sdk-tools.d.ts AgentInput): a level Claude Code does not have is left out */
const agentAsk = (input: Obj): AgentAsk => ({
  ...(typeof input.model === 'string' && input.model !== '' ? { model: cap(input.model, MODEL_CAP) } : {}),
  ...(typeof input.effort === 'string' && EFFORTS.includes(input.effort) ? { effort: input.effort } : {}),
})

/**
 * The tokens of a conversation at one API call, from its usage: what it sent (input, cache written and read) and what came back;
 * null when the input count is missing or a count is not one
 */
const contextOf = (usage: unknown): number | null => {
  if (!isObj(usage) || !isCount(usage.input_tokens)) return null
  let total = usage.input_tokens
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    const n = usage[key]
    if (n === undefined || n === null) continue
    if (!isCount(n)) return null
    total += n
  }
  return total
}

/**
 * a user message Claude Code writes itself, not the person: a replay, a meta or a synthetic message, or the summary a compaction
 * leaves, which the history gives as a user message (its divider is drawn from the compaction's boundary); the main chat and an
 * agent's page drop it
 */
export const isClaudeCodeFlag = (msg: Obj): boolean => msg.isReplay === true || msg.isMeta === true || msg.isSynthetic === true || msg.isCompactSummary === true

/** a user text Claude Code writes itself: the interrupt notice, and a typed command's name, message or arguments */
export const isClaudeCodeText = (text: string): boolean => text.startsWith('[Request interrupted by user') || /^<command-(name|message|args)>/.test(text)

/** the text of a tool result: a string, or the text blocks joined with a line break */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) if (isObj(block) && typeof block.text === 'string' && block.type === 'text') parts.push(block.text)
  return parts.join('\n')
}

/**
 * The id of the agent an Agent call started, from its result: the structured result's agentId when that is an agent id, else the last
 * `agentId:` line of the text (Claude Code ends its text result with one); null when neither gives an agent id.
 */
export function resultAgentId(text: string, structured: unknown): string | null {
  const named = isObj(structured) ? structured.agentId : undefined
  if (isAgentId(named)) return named
  let last: string | null = null
  // a line starts after a '\n' or at the text's start, so a run of blank lines needs no match of its own: the regex stays linear
  for (const m of text.matchAll(/(?:^|\n)[^\S\n]*agentId:\s*([^\s(]+)/g)) last = m[1]!
  return isAgentId(last) ? last : null
}

/** a file path as a path inside the folder ('/'-separated, relative), or as it was given when outside it */
function relativePath(folder: string, file: string): string {
  const f = file.replace(/\\/g, '/')
  const dir = folder.replace(/\\/g, '/')
  if (!isWithin(dir, f)) return f
  const rel = nativePath.relative(dir, f)
  return rel === '' ? f : rel.split(nativePath.sep).join('/')
}

/** what a tool call is about, as a step row and a permission card show it (the rule below); Task 5 imports it */
export function toolSubject(name: string, input: unknown, folder: string): string {
  const i: Obj = isObj(input) ? input : {}
  let subject = ''
  if (FILE_TOOLS.includes(name)) subject = relativePath(folder, str(i.file_path) ?? '')
  else if (name === 'Bash') subject = (str(i.command) ?? '').split('\n')[0]
  else if (name === 'Glob' || name === 'Grep') subject = str(i.pattern) ?? ''
  else if (name === 'WebFetch') subject = str(i.url) ?? ''
  else if (name === 'WebSearch') subject = str(i.query) ?? ''
  else if (name === 'Task' || name === 'Agent') subject = str(i.description) ?? ''
  else if (name === 'SendMessage') subject = typeof i.to === 'string' ? `to ${i.to}` : ''
  else if (name.startsWith('mcp__')) subject = (JSON.stringify(input) ?? '').slice(0, MCP_INPUT_CAP)
  return cap(subject, SUBJECT_CAP)
}

/** the detail a call shows when it starts: from its input (Edit, Write) */
function startDetail(name: string, input: Obj): string | null {
  if (name === 'Edit') {
    const added = str(input.new_string)
    const removed = str(input.old_string)
    return added === null || removed === null ? null : `+${lines(added)} −${lines(removed)}`
  }
  if (name === 'Write') {
    const content = str(input.content)
    return content === null ? null : `+${lines(content)}`
  }
  return null
}

/** the detail a call shows once it has its result (Read: the lines read; Bash: the seconds), null when it keeps its own */
function resultDetail(name: string, output: string, ms: number): string | null {
  if (name === 'Read') return `${lines(output)} lines`
  if (name === 'Bash') return `${(ms / 1000).toFixed(1)}s`
  return null
}

/** the image a call shows once it runs: a Read or Write of an image file, or show_image; an absolute path, else null */
function imageOf(name: string, input: Obj): string | null {
  let path: string | null = null
  if ((name === 'Read' || name === 'Write') && hasImageExtension(str(input.file_path) ?? '', DEFAULT_IMAGE_EXTENSIONS)) path = pathOf(input.file_path)
  else if (name === 'mcp__claudeterm__show_image') path = pathOf(input.path)
  return path !== null && path !== '' && nativePath.isAbsolute(path) ? path : null
}

export class ChatFold {
  protected readonly o: ChatFoldOptions
  protected readonly list: ChatItem[] = []
  protected readonly at = new Map<string, number>()
  /** stream blocks of the message being streamed, by their index in it */
  protected readonly open = new Map<number, OpenBlock>()
  /** tool calls by their tool_use id: the tools item holding them and when they started */
  protected readonly calls = new Map<string, CallLink>()
  /** when the first call of each step started */
  protected readonly stepStart = new Map<string, number>()
  /** the steps' open tools item: a tool_use joins it until a text item closes it */
  protected step: string | null = null

  /** the subagents started by a Task call, by their task id */
  protected readonly tasks = new Map<string, TaskLink>()
  /** the call each agent is listed on, at its latest entry, by the agent's id; kept when the agent ends, so a resume finds it. Ids are agent ids only */
  protected readonly agentCalls = new Map<string, { itemId: string; callId: string }>()
  /** the subagent_type each Task or Agent call asked for, by the call's id: an agent found in history takes it */
  protected readonly callTypes = new Map<string, string>()
  /** the background tasks whose end the chat has drawn from a system message: their notice in the conversation adds no row */
  protected readonly ended = new Set<string>()
  /** the images item of each step, by the step's tools item */
  protected readonly stepImages = new Map<string, string>()
  /** the ids of all images items, so a change of the Media cards does not scan the whole chat */
  protected readonly imageItems = new Set<string>()

  constructor(o: ChatFoldOptions) {
    this.o = o
  }

  /** the newest `count` items, and whether older ones exist */
  page(count = PAGE): { items: ChatItem[]; hasOlder: boolean } {
    const start = Math.max(0, this.list.length - count)
    return { items: this.list.slice(start), hasOlder: start > 0 }
  }

  /** up to `count` items before the item `beforeId`; nothing for an id the chat does not hold */
  older(beforeId: string, count = PAGE): { items: ChatItem[]; hasOlder: boolean } {
    const end = this.at.get(beforeId)
    if (end === undefined) return { items: [], hasOlder: false }
    const start = Math.max(0, end - count)
    return { items: this.list.slice(start, end), hasOlder: start > 0 }
  }

  items(): readonly ChatItem[] {
    return this.list
  }

  /** the oldest open stream block of a kind, taken out of the open map: an assistant block is matched by kind, not by position */
  protected takeOpen(kind: OpenBlock['kind']): OpenBlock | undefined {
    for (const [index, entry] of this.open) {
      if (entry.kind === kind) {
        this.open.delete(index)
        return entry
      }
    }
    return undefined
  }

  /** the blocks of an assistant message, in order: its text, its thinking and its tool calls */
  protected assistantBlocks(content: unknown[], synthetic: boolean): ChatPatch[] {
    const patches: ChatPatch[] = []
    content.forEach((block: unknown) => {
      if (!isObj(block)) return
      if (block.type === 'text') patches.push(...this.settleText(block, synthetic))
      else if (block.type === 'thinking') patches.push(...this.thinking(block))
      else if (block.type === 'tool_use') patches.push(...this.toolUse(block))
    })
    return patches
  }

  /** a text block's hook: the main chat turns a command's "not available" answer into a notice; null: a plain text */
  protected notAvailable(text: string, synthetic: boolean, entry: OpenBlock | undefined): ChatPatch[] | null {
    return null
  }

  /** the whole text of a text block: sets the item a stream opened, or adds it (history) */
  protected settleText(block: Obj, synthetic: boolean): ChatPatch[] {
    const text = str(block.text)
    if (text === null) return []
    const markdown = cap(text, TEXT_CAP)
    const entry = this.takeOpen('text')
    const notice = this.notAvailable(text, synthetic, entry)
    if (notice !== null) return notice
    if (entry?.kind === 'text') return this.set({ kind: 'text', id: entry.id, markdown, streaming: false })
    return this.addText({ kind: 'text', id: this.o.newId(), markdown, streaming: false })
  }

  /** a thinking block: its time is the stream's, up to its stop or, when the message comes first, up to now */
  protected thinking(block: Obj): ChatPatch[] {
    const entry = this.takeOpen('thinking')
    const text = str(block.thinking)
    const ms = entry?.kind === 'thinking' ? (entry.ms ?? elapsed(entry.startedAt, this.o.now())) : null
    return this.add({ kind: 'thinking', id: this.o.newId(), ms, summary: text ? cap(text, TEXT_CAP) : null })
  }

  /** a tool_use joins the open step, or opens one; the call starts running */
  protected toolUse(block: Obj): ChatPatch[] {
    const rawId = str(block.id)
    const rawName = str(block.name)
    if (rawId === null || rawName === null) return []
    const id = cap(rawId, NAME_CAP)
    const name = cap(rawName, NAME_CAP)
    if (this.calls.has(id)) return []
    const input: Obj = isObj(block.input) ? block.input : {}
    const start = this.o.now()
    const image = imageOf(name, input)
    const call: ChatToolCall = {
      id, name, subject: toolSubject(name, input, this.o.folder()), detail: startDetail(name, input), state: 'running',
      output: null, error: null, editPath: EDIT_TOOLS.includes(name) ? pathOf(input.file_path) : null, agents: [], ms: null,
    }
    const ask = name === 'Task' || name === 'Agent' ? { ask: agentAsk(input) } : {}
    if (name === 'Task' || name === 'Agent') this.callTypes.set(id, cap(str(input.subagent_type) ?? 'agent', NAME_CAP))
    const open = this.step === null ? undefined : this.get(this.step)
    if (open?.kind === 'tools') {
      this.calls.set(id, { itemId: open.id, start, image, ...ask })
      return [...this.callPatch(open, [...open.calls, call], call), ...this.showImage(open.id, image)]
    }
    const item: ChatItem = { kind: 'tools', id: this.o.newId(), calls: [call], ms: null }
    this.step = item.id
    this.stepStart.set(item.id, start)
    this.calls.set(id, { itemId: item.id, start, image, ...ask })
    return [...this.add(item), ...this.showImage(item.id, image)]
  }

  /** an image a step shows: its images item follows the step's tools item, one path once */
  protected showImage(stepId: string, path: string | null): ChatPatch[] {
    if (path === null) return []
    const key = pathKey(path)
    const id = this.stepImages.get(stepId)
    const item = id === undefined ? undefined : this.get(id)
    if (item?.kind === 'images') {
      if (item.images.some(image => pathKey(image.path) === key)) return []
      return this.set({ ...item, images: [...item.images, { path, cardId: null }] })
    }
    const created: ChatItem = { kind: 'images', id: this.o.newId(), images: [{ path, cardId: null }] }
    this.stepImages.set(stepId, created.id)
    this.imageItems.add(created.id)
    return this.add(created)
  }

  /** the Media cards of the tab as they stand: an image of the chat without a card takes the card of its path, unless the card is deleted; one set patch per item that changed */
  attachCards(cards: readonly Pick<ImageCard, 'id' | 'path' | 'deleted'>[]): ChatPatch[] {
    const byPath = new Map<string, string>()
    for (const card of cards) {
      const key = pathKey(card.path)
      if (!card.deleted && !byPath.has(key)) byPath.set(key, card.id)
    }
    if (byPath.size === 0) return []
    const patches: ChatPatch[] = []
    for (const id of this.imageItems) {
      const item = this.get(id)
      if (item?.kind !== 'images') continue
      let changed = false
      const images = item.images.map(image => {
        const cardId = image.cardId === null ? byPath.get(pathKey(image.path)) ?? null : image.cardId
        if (cardId === image.cardId) return image
        changed = true
        return { ...image, cardId }
      })
      if (changed) patches.push(...this.set({ ...item, images }))
    }
    return patches
  }

  /**
   * The results of a user message: each running call it answers becomes done, or failed with its error. An Agent call that lists no agent
   * takes the one its result names (the agentId of a history line, or the structured result's), so its row can open the agent's page.
   */
  protected toolResults(content: unknown[], structured: unknown): ChatPatch[] {
    const patches: ChatPatch[] = []
    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const callId = cap(block.tool_use_id, NAME_CAP)
      const link = this.calls.get(callId)
      const item = link ? this.get(link.itemId) : undefined
      const call = item?.kind === 'tools' ? item.calls.find(c => c.id === callId) : undefined
      if (!link || item?.kind !== 'tools' || !call || call.state !== 'running') continue
      const now = this.o.now()
      const text = resultText(block.content)
      const output = cap(text, OUTPUT_CAP)
      const failed = block.is_error === true
      const ms = elapsed(link.start, now)
      const foundId = call.agents.length === 0 && (call.name === 'Task' || call.name === 'Agent') ? resultAgentId(text, structured) : null
      const found: ChatSubagent | null = foundId === null
        ? null
        : { id: foundId, description: call.subject, type: this.callTypes.get(callId) ?? 'agent', state: failed ? 'failed' : 'done', ms: null }
      if (found !== null) this.agentCalls.set(found.id, { itemId: item.id, callId })
      const next: ChatToolCall = {
        ...call, state: failed ? 'failed' : 'done', output, error: failed ? output : null, ms,
        detail: failed ? call.detail : (resultDetail(call.name, output, ms) ?? call.detail),
        ...(found === null ? {} : { agents: [found] }),
      }
      const calls = item.calls.map(c => (c.id === next.id ? next : c))
      // the step's own time goes out when its last call ends; until then the call that changed is all the window gets
      if (calls.every(c => c.state !== 'running')) {
        patches.push(...this.set({ ...item, calls, ms: elapsed(this.stepStart.get(item.id) ?? link.start, now) }))
      } else {
        patches.push(...this.callPatch(item, calls, next))
      }
    }
    return patches
  }

  /**
   * A subagent of a Task or Agent call, or of a SendMessage call: listed on the call that names it. A SendMessage call lists an agent it
   * does not list yet; an Agent or Task call lists only an agent the chat does not know. An agent the chat knows and does not list on
   * the call is the same agent again (Claude Code resumes a finished one under its task id), so it runs again.
   */
  protected taskStarted(msg: Obj): ChatPatch[] {
    const callId = typeof msg.tool_use_id === 'string' ? cap(msg.tool_use_id, NAME_CAP) : null
    const taskId = typeof msg.task_id === 'string' ? cap(msg.task_id, NAME_CAP) : null
    // only an agent id is listed: a member's mirror refuses any other id, and the whole chat with it
    if (taskId === null || !isAgentId(taskId)) return []
    const link = callId === null ? undefined : this.calls.get(callId)
    const item = link ? this.get(link.itemId) : undefined
    const call = item?.kind === 'tools' ? item.calls.find(c => c.id === callId) : undefined
    const known = this.agentCalls.has(taskId)
    if (item?.kind === 'tools' && call && ['Task', 'Agent', 'SendMessage'].includes(call.name) && !call.agents.some(a => a.id === taskId) && (call.name === 'SendMessage' || !known)) {
      const start = this.o.now()
      const agent: ChatSubagent = {
        id: taskId, description: cap(str(msg.description) ?? '', SUBJECT_CAP),
        type: cap(str(msg.subagent_type) ?? str(msg.task_type) ?? 'agent', NAME_CAP), state: 'running', ms: null, ...link?.ask, startedAt: start,
      }
      this.tasks.set(taskId, { itemId: item.id, callId: call.id, start })
      if (isAgentId(taskId)) this.agentCalls.set(taskId, { itemId: item.id, callId: call.id })
      const agents = [...call.agents, agent]
      const next: ChatToolCall = { ...call, agents, detail: agents.length > 1 ? `${agents.length} agents` : call.detail }
      return this.callPatch(item, item.calls.map(c => (c.id === call.id ? next : c)), next)
    }
    return known ? this.resume(taskId) : []
  }

  /** an agent the chat lists runs again: its latest entry is running from now, with no end and no stop; its end lands on the call it is listed on */
  private resume(taskId: string): ChatPatch[] {
    const latest = this.agentCalls.get(taskId)
    const item = latest ? this.get(latest.itemId) : undefined
    const call = item?.kind === 'tools' ? item.calls.find(c => c.id === latest?.callId) : undefined
    const agent = call?.agents.find(a => a.id === taskId)
    if (latest === undefined || item?.kind !== 'tools' || !call || !agent) return []
    const start = this.o.now()
    const running: ChatSubagent = { ...agent, state: 'running', ms: null, startedAt: start }
    delete running.stopped
    this.tasks.set(taskId, { itemId: item.id, callId: call.id, start })
    const next: ChatToolCall = { ...call, agents: call.agents.map(a => (a.id === taskId ? running : a)) }
    return this.callPatch(item, item.calls.map(c => (c.id === call.id ? next : c)), next)
  }

  /** every agent of the chat, once each: at its latest entry, in the order the agents first appeared */
  agents(): ChatSubagent[] {
    const seen = new Map<string, ChatSubagent>()
    for (const item of this.list) {
      if (item.kind !== 'tools') continue
      for (const call of item.calls) for (const agent of call.agents) seen.set(agent.id, agent)
    }
    return [...seen].map(([id, agent]) => {
      const latest = this.agentCalls.get(id)
      const item = latest ? this.get(latest.itemId) : undefined
      return item?.kind === 'tools' ? item.calls.find(c => c.id === latest?.callId)?.agents.find(a => a.id === id) ?? agent : agent
    })
  }

  /**
   * A call of a running subagent, as Claude Code passes it on (its tool_use blocks, parent_tool_use_id set): the model it runs on and
   * the tokens of its conversation, on its row. The agent is the one agent_id names; an older Claude Code names none, and then it is
   * the one agent running for the call parent_tool_use_id names, when there is one.
   */
  protected subagentCall(msg: Obj): ChatPatch[] {
    const message = isObj(msg.message) ? msg.message : null
    if (message === null) return []
    let taskId = typeof msg.agent_id === 'string' ? cap(msg.agent_id, NAME_CAP) : null
    if (taskId === null || !this.tasks.has(taskId)) {
      const callId = typeof msg.parent_tool_use_id === 'string' ? cap(msg.parent_tool_use_id, NAME_CAP) : null
      const running = callId === null ? [] : [...this.tasks].filter(([, link]) => link.callId === callId)
      taskId = running.length === 1 ? running[0]![0] : null
    }
    const link = taskId === null ? undefined : this.tasks.get(taskId)
    const item = link ? this.get(link.itemId) : undefined
    if (!link || item?.kind !== 'tools') return []
    const call = item.calls.find(c => c.id === link.callId)
    const agent = call?.agents.find(a => a.id === taskId)
    if (!call || !agent) return []
    // a message Claude Code makes itself (an error) names the model <synthetic>: it runs on no model
    const named = typeof message.model === 'string' && message.model !== '' && !message.model.startsWith('<') ? cap(message.model, MODEL_CAP) : null
    const context = contextOf(message.usage)
    const model = named ?? agent.model
    if (model === agent.model && (context === null || context === agent.context)) return []
    const next: ChatSubagent = { ...agent, ...(model === undefined ? {} : { model }), ...(context === null ? {} : { context }) }
    const updated: ChatToolCall = { ...call, agents: call.agents.map(a => (a.id === taskId ? next : a)) }
    return this.callPatch(item, item.calls.map(c => (c.id === updated.id ? updated : c)), updated)
  }

  /** a subagent finished, failed or was stopped: its state on the call that started it */
  protected taskNotification(msg: Obj): ChatPatch[] {
    const taskId = typeof msg.task_id === 'string' ? cap(msg.task_id, NAME_CAP) : null
    const link = taskId === null ? undefined : this.tasks.get(taskId)
    if (taskId === null || !link) return []
    const status = str(msg.status)
    const state: ChatCallState | null = status === 'completed' ? 'done' : status === 'failed' || status === 'stopped' ? 'failed' : null
    // a stop is a failure the person asked for: the row says so apart from a failed one
    const stopped = status === 'stopped'
    const item = this.get(link.itemId)
    if (state === null || item?.kind !== 'tools') return []
    const call = item.calls.find(c => c.id === link.callId)
    if (!call) return []
    // the stream's own duration when it gives one, never below zero; the clock's time when it gives none
    const reported = isObj(msg.usage) ? num(msg.usage.duration_ms) : null
    const ms = reported !== null ? Math.max(0, reported) : elapsed(link.start, this.o.now())
    this.tasks.delete(taskId)
    // the end of an agent the chat draws here: its notice in the conversation (a user message) adds no row of its own; any other task keeps its row
    this.ended.add(taskId)
    if (this.ended.size > MAX_ENDED_TASKS) this.ended.delete(this.ended.values().next().value as string)
    const next: ChatToolCall = {
      ...call,
      agents: call.agents.map(a => {
        if (a.id !== taskId) return a
        const ended: ChatSubagent = { ...a, state, ms }
        delete ended.stopped
        return stopped ? { ...ended, stopped: true } : ended
      }),
    }
    return this.callPatch(item, item.calls.map(c => (c.id === next.id ? next : c)), next)
  }

  /** every call still running fails with the reason, and so does every agent still running: none is left animating */
  protected failRunning(reason: string): ChatPatch[] {
    const patches: ChatPatch[] = []
    for (const [callId, link] of this.calls) {
      const item = this.get(link.itemId)
      const call = item?.kind === 'tools' ? item.calls.find(c => c.id === callId) : undefined
      if (item?.kind !== 'tools' || call === undefined) continue
      const agents = call.agents.map(a => (a.state === 'running' ? { ...a, state: 'failed' as const } : a))
      const agentsChanged = agents.some((a, i) => a !== call.agents[i])
      if (call.state !== 'running' && !agentsChanged) continue
      const next: ChatToolCall = call.state === 'running' ? { ...call, state: 'failed', error: reason, agents } : { ...call, agents }
      patches.push(...this.callPatch(item, item.calls.map(c => (c.id === callId ? next : c)), next))
    }
    return patches
  }

  protected get(id: string): ChatItem | undefined {
    const i = this.at.get(id)
    return i === undefined ? undefined : this.list[i]
  }

  /** replaces an item in place, without a patch: the caller sends it */
  protected store(item: ChatItem): void {
    const i = this.at.get(item.id)
    if (i !== undefined) this.list[i] = item
  }

  protected add(item: ChatItem): ChatPatch[] {
    this.at.set(item.id, this.list.length)
    this.list.push(item)
    return [{ op: 'add', item }]
  }

  /** a text item closes the open step */
  protected addText(item: ChatItem): ChatPatch[] {
    this.step = null
    return this.add(item)
  }

  protected set(item: ChatItem): ChatPatch[] {
    this.store(item)
    return [{ op: 'set', item }]
  }

  /**
   * Drops the oldest items until the list holds at most `max`, and rebuilds the index: true when some were dropped (an agent page keeps
   * what it drew). The state keyed by a dropped item goes with it: its calls, its tasks, its step and its images.
   */
  protected dropOldest(max: number): boolean {
    const extra = this.list.length - max
    if (extra <= 0) return false
    const dropped = new Set(this.list.splice(0, extra).map(item => item.id))
    for (const id of dropped) this.at.delete(id)
    this.list.forEach((item, i) => this.at.set(item.id, i))
    for (const [callId, link] of this.calls) {
      if (!dropped.has(link.itemId)) continue
      this.calls.delete(callId)
      this.callTypes.delete(callId)
    }
    for (const [taskId, link] of this.tasks) if (dropped.has(link.itemId)) this.tasks.delete(taskId)
    for (const [taskId, link] of this.agentCalls) if (dropped.has(link.itemId)) this.agentCalls.delete(taskId)
    for (const id of dropped) {
      this.stepStart.delete(id)
      this.imageItems.delete(id)
      const images = this.stepImages.get(id)
      if (images !== undefined) {
        this.stepImages.delete(id)
        this.imageItems.delete(images)
      }
    }
    if (this.step !== null && dropped.has(this.step)) this.step = null
    return true
  }

  /** the calls of a tools item change: the item keeps them, and the window gets the one call that changed */
  protected callPatch(item: ToolsItem, calls: ChatToolCall[], call: ChatToolCall): ChatPatch[] {
    this.store({ ...item, calls })
    return [{ op: 'call', id: item.id, call }]
  }
}
