import { commandWord, isHandoffLine, type ChatCallState, type ChatCard, type ChatItem, type ChatNoticeAction, type ChatPatch, type ChatPermissionMode, type ChatSend, type ChatState, type ChatSubagent, type ChatToolCall } from '../../shared/chat'
import { DEFAULT_IMAGE_EXTENSIONS, hasImageExtension } from '../../shared/image-file'
import { isUuid } from '../../shared/protocol'
import type { ImageCard } from '../../shared/types'
import { isWithin, nativePath, pathKey } from '../path-key'

// The chat of one tab: folds the SDK messages (live or from history) into the items the chat view draws.
// Everything here is untrusted input: a field of the wrong type is ignored, an unknown kind gives no patch.

const TEXT_CAP = 1024 * 1024
const OUTPUT_CAP = 64 * 1024
const SUBJECT_CAP = 500
/** names and ids Claude Code gives: tools, tasks, subagent types, typed commands */
const NAME_CAP = 500
const PATH_CAP = 4096
const MODEL_CAP = 200
const MCP_INPUT_CAP = 80
export const PAGE = 200
const LIMIT_MS_FROM = 1e11

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit']
const PERMISSION_MODES: readonly ChatPermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']

export interface ChatModelOptions { now(): number; newId(): string; folder(): string }

/** a stream block still open: a text item being streamed, or a thinking block with its stream start and length */
type OpenBlock = { kind: 'text'; id: string } | { kind: 'thinking'; startedAt: number; ms: number | null }

/** a tool call's link to its tools item, when it started, and the image it shows (null: none) */
interface CallLink { itemId: string; start: number; image: string | null }
/** a subagent's link to the Task call that started it */
interface TaskLink { itemId: string; callId: string; start: number }
/** a prompt we sent: `started` once its turn has begun, so it is dropped when that turn's result comes */
interface SentEntry { text: string; started: boolean; id: string }
type ToolsItem = Extract<ChatItem, { kind: 'tools' }>
type Limit = { usedPct: number; resetsAt: number }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** one limit of a rate_limit_event: utilization as a fraction or a percent, resetsAt in seconds or ms; null when a field is not a number */
const limitOf = (window: unknown): Limit | null => {
  if (!isObj(window)) return null
  const utilization = num(window.utilization)
  const reset = num(window.resetsAt)
  if (utilization === null || reset === null) return null
  const percent = utilization > 1 ? utilization : utilization * 100
  return { usedPct: Math.round(Math.min(100, Math.max(0, percent))), resetsAt: reset > LIMIT_MS_FROM ? Math.floor(reset / 1000) : reset }
}
export const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)
const pathOf = (v: unknown): string | null => {
  const s = str(v)
  return s === null ? null : cap(s, PATH_CAP)
}
const lines = (s: string): number => (s === '' ? 0 : s.split('\n').length)
export const isPermissionMode = (v: unknown): v is ChatPermissionMode => PERMISSION_MODES.includes(v as ChatPermissionMode)
const pad = (n: number): string => String(n).padStart(2, '0')
/** the time from a moment to a later one, in milliseconds: a clock that stepped back gives none, never a negative time */
const elapsed = (from: number, to: number): number => Math.max(0, to - from)

/** the text of a tool result: a string, or the text blocks joined with a line break */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) if (isObj(block) && typeof block.text === 'string' && block.type === 'text') parts.push(block.text)
  return parts.join('\n')
}

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

/** the first word of a typed command: '/context' of '/context now' */
const firstWord = (text: string): string => cap(commandWord(text), NAME_CAP)

/**
 * The answer of a command this environment does not have: the command's name. The wording is the stand-in's: Claude Code's own
 * wording was never recorded (fixture finding (f)). Only a synthetic answer to the command the user just sent counts; a sentence
 * in Claude's reply is text.
 */
const UNAVAILABLE = /^\/(\S+) isn't available in this environment\.$/
const SYNTHETIC = '<synthetic>'

export class ChatModel {
  private readonly o: ChatModelOptions
  private readonly list: ChatItem[] = []
  private readonly at = new Map<string, number>()
  /** stream blocks of the message being streamed, by their index in it */
  private readonly open = new Map<number, OpenBlock>()
  /** tool calls by their tool_use id: the tools item holding them and when they started */
  private readonly calls = new Map<string, CallLink>()
  /** when the first call of each step started */
  private readonly stepStart = new Map<string, number>()
  /** the steps' open tools item: a tool_use joins it until a text item closes it */
  private step: string | null = null
  /** the prompts we sent that no echo has come back for yet, oldest first */
  private readonly sent: SentEntry[] = []
  /** the ids of the user items queued while a turn ran, oldest first */
  private readonly queue: string[] = []
  /** the subagents started by a Task call, by their task id */
  private readonly tasks = new Map<string, TaskLink>()
  /** the images item of each step, by the step's tools item */
  private readonly stepImages = new Map<string, string>()
  /** the ids of all images items, so a change of the Media cards does not scan the whole chat */
  private readonly imageItems = new Set<string>()
  private readonly st: ChatState = { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false }
  /** a result came and no message has started the next turn yet */
  private afterResult = false
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

  constructor(o: ChatModelOptions) {
    this.o = o
  }

  /** one SDK message, live or from history; anything malformed or unknown gives [] */
  apply(msg: unknown): ChatPatch[] {
    // a message of a subagent (parent_tool_use_id set) is not part of the main conversation
    if (!isObj(msg) || (typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id !== '')) return []
    switch (msg.type) {
      case 'stream_event': {
        const folded = this.taken(msg)
        return [...folded.patches, ...(isObj(msg.event) ? [...this.turnBegins(folded.named), ...this.stream(msg.event)] : [])]
      }
      case 'assistant': {
        const folded = this.taken(msg)
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
    const item: ChatItem = { kind: 'user', id, text, attachments: send.attachments, queued: waits, ...(send.from === undefined ? {} : { from: send.from }) }
    const patches = this.add(item)
    if (!waits) {
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
    patches.push(...this.setState({ turn: stillWaiting ? 'waiting' : 'working' }))
    return patches
  }

  notice(text: string, tone: 'info' | 'error', action: ChatNoticeAction | null): ChatPatch[] {
    return this.add({ kind: 'notice', id: this.o.newId(), tone, text: cap(text, OUTPUT_CAP), action })
  }

  divider(text: string): ChatPatch[] {
    return this.add({ kind: 'divider', id: this.o.newId(), text })
  }

  /** changes the state the status bar and the chat header show; [] when nothing changed */
  setState(partial: Partial<ChatState>): ChatPatch[] {
    const changed = (Object.keys(partial) as (keyof ChatState)[]).some(key => partial[key] !== this.st[key])
    if (!changed) return []
    Object.assign(this.st, partial)
    return [{ op: 'state', state: this.state() }]
  }

  state(): ChatState {
    return { ...this.st }
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

  /** what the stream said of the status bar; null fields: not said yet */
  status(): { model: string | null; effort: string | null; contextPct: number | null; contextUsed: number | null; contextSize: number | null; fiveHour: Limit | null; sevenDay: Limit | null } {
    return { model: this.st.model, effort: this.st.effort, contextPct: this.contextPct, contextUsed: this.contextUsed, contextSize: this.contextSize, fiveHour: this.fiveHour, sevenDay: this.sevenDay }
  }

  /** the context fill the hub reads from the engine, with its token counts */
  setContext(c: { pct: number | null; used: number | null; size: number | null }): void {
    this.contextPct = c.pct
    this.contextUsed = c.used
    this.contextSize = c.size
  }

  /** the history of a resumed chat is in: a call still running in it was cut off, so it ends as interrupted, and its turn ends with it */
  historyLoaded(): ChatPatch[] {
    return [...this.failRunning('Interrupted'), ...this.setState({ turn: 'idle', turnStartedAt: null })]
  }

  items(): readonly ChatItem[] {
    return this.list
  }

  private beginTurn(): ChatPatch[] {
    this.afterResult = false
    return this.setState({ turn: 'working', turnStartedAt: this.o.now() })
  }

  /** the sends Claude Code took into the turn, as a frame of the turn names them by their uuids: those stop being queued; named: the frame carries a valid uuid field */
  private taken(msg: Obj): { patches: ChatPatch[]; named: boolean } {
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
      const item = this.get(id)
      if (item?.kind === 'user') patches.push(...this.set({ ...item, queued: false }))
    }
    return { patches, named }
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
    const item = id === undefined ? undefined : this.get(id)
    if (item?.kind === 'user') patches.push(...this.set({ ...item, queued: false }))
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
    this.put({ ...item, markdown: item.markdown + piece })
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

  /** the oldest open stream block of a kind, taken out of the open map: an assistant block is matched by kind, not by position */
  private takeOpen(kind: OpenBlock['kind']): OpenBlock | undefined {
    for (const [index, entry] of this.open) {
      if (entry.kind === kind) {
        this.open.delete(index)
        return entry
      }
    }
    return undefined
  }

  private assistant(msg: Obj, named = false): ChatPatch[] {
    const message = msg.message
    if (!isObj(message) || !Array.isArray(message.content)) return []
    const patches = this.turnBegins(named)
    // a local command's answer (/context, /config): its own item, not a message of Claude's
    if (typeof msg.local_command_source === 'string') {
      const text = resultText(message.content)
      return [...patches, ...(this.unavailableNotice(text, message.model === SYNTHETIC, undefined) ?? this.commandItem(text))]
    }
    message.content.forEach((block: unknown) => {
      if (!isObj(block)) return
      if (block.type === 'text') patches.push(...this.settleText(block, message.model === SYNTHETIC))
      else if (block.type === 'thinking') patches.push(...this.thinking(block))
      else if (block.type === 'tool_use') patches.push(...this.toolUse(block))
    })
    return patches
  }

  /**
   * The notice of a command this environment does not have, answered to the command the user just sent: a notice that opens the
   * line in the terminal, in the place of the text (an open text item is set). Null when the text is not that answer. The name is
   * kept for the session: the next time that command goes to the terminal.
   */
  private unavailableNotice(text: string, synthetic: boolean, entry: OpenBlock | undefined): ChatPatch[] | null {
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

  /** the whole text of a text block: sets the item a stream opened, or adds it (history) */
  private settleText(block: Obj, synthetic: boolean): ChatPatch[] {
    const text = str(block.text)
    if (text === null) return []
    const markdown = cap(text, TEXT_CAP)
    const entry = this.takeOpen('text')
    const notice = this.unavailableNotice(text, synthetic, entry)
    if (notice !== null) return notice
    if (entry?.kind === 'text') return this.set({ kind: 'text', id: entry.id, markdown, streaming: false })
    return this.addText({ kind: 'text', id: this.o.newId(), markdown, streaming: false })
  }

  /** a thinking block: its time is the stream's, up to its stop or, when the message comes first, up to now */
  private thinking(block: Obj): ChatPatch[] {
    const entry = this.takeOpen('thinking')
    const text = str(block.thinking)
    const ms = entry?.kind === 'thinking' ? (entry.ms ?? elapsed(entry.startedAt, this.o.now())) : null
    return this.add({ kind: 'thinking', id: this.o.newId(), ms, summary: text ? cap(text, TEXT_CAP) : null })
  }

  /** a tool_use joins the open step, or opens one; the call starts running */
  private toolUse(block: Obj): ChatPatch[] {
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
    const open = this.step === null ? undefined : this.get(this.step)
    if (open?.kind === 'tools') {
      this.calls.set(id, { itemId: open.id, start, image })
      return [...this.callPatch(open, [...open.calls, call], call), ...this.showImage(open.id, image)]
    }
    const item: ChatItem = { kind: 'tools', id: this.o.newId(), calls: [call], ms: null }
    this.step = item.id
    this.stepStart.set(item.id, start)
    this.calls.set(id, { itemId: item.id, start, image })
    return [...this.add(item), ...this.showImage(item.id, image)]
  }

  /** an image a step shows: its images item follows the step's tools item, one path once */
  private showImage(stepId: string, path: string | null): ChatPatch[] {
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
      return this.toolResults(content)
    }
    if (msg.isReplay === true || msg.isMeta === true || msg.isSynthetic === true) return []
    const text = plainText(content)
    if (text === null || text === '') return []
    // Claude Code's own messages: the interrupt notice, a command's output and its name, the compaction summary
    if (text.startsWith('[Request interrupted by user')) return []
    if (/^<command-(name|message|args)>/.test(text)) return []
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
    return this.add({ kind: 'user', id: this.o.newId(), text: drawn, attachments: [], queued: false })
  }

  /** the results of a user message: each running call it answers becomes done, or failed with its error */
  private toolResults(content: unknown[]): ChatPatch[] {
    const patches: ChatPatch[] = []
    for (const block of content) {
      if (!isObj(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const callId = cap(block.tool_use_id, NAME_CAP)
      const link = this.calls.get(callId)
      const item = link ? this.get(link.itemId) : undefined
      const call = item?.kind === 'tools' ? item.calls.find(c => c.id === callId) : undefined
      if (!link || item?.kind !== 'tools' || !call || call.state !== 'running') continue
      const now = this.o.now()
      const output = cap(resultText(block.content), OUTPUT_CAP)
      const failed = block.is_error === true
      const ms = elapsed(link.start, now)
      const next: ChatToolCall = {
        ...call, state: failed ? 'failed' : 'done', output, error: failed ? output : null, ms,
        detail: failed ? call.detail : (resultDetail(call.name, output, ms) ?? call.detail),
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

  /** a system message: the session's init and status, a local command's output, compaction, retries, subagents */
  private system(msg: Obj): ChatPatch[] {
    switch (msg.subtype) {
      case 'init': return this.init(msg)
      case 'status': return isPermissionMode(msg.permissionMode) ? this.setState({ mode: msg.permissionMode }) : []
      case 'local_command_output': return typeof msg.content === 'string' ? this.commandItem(msg.content) : []
      case 'compact_boundary': return this.divider('Conversation compacted')
      case 'session_state_changed': return this.sessionState(msg.state)
      case 'api_retry': return this.retry(msg)
      case 'task_started': return this.taskStarted(msg)
      case 'task_notification': return this.taskNotification(msg)
      default: return []
    }
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

  /** a subagent of a Task (or Agent) call: it is listed on that call */
  private taskStarted(msg: Obj): ChatPatch[] {
    const callId = typeof msg.tool_use_id === 'string' ? cap(msg.tool_use_id, NAME_CAP) : null
    const taskId = typeof msg.task_id === 'string' ? cap(msg.task_id, NAME_CAP) : null
    if (callId === null || taskId === null) return []
    const link = this.calls.get(callId)
    const item = link ? this.get(link.itemId) : undefined
    if (item?.kind !== 'tools') return []
    const call = item.calls.find(c => c.id === callId)
    if (!call || (call.name !== 'Task' && call.name !== 'Agent') || call.agents.some(a => a.id === taskId)) return []
    const agent: ChatSubagent = {
      id: taskId, description: cap(str(msg.description) ?? '', SUBJECT_CAP),
      type: cap(str(msg.subagent_type) ?? str(msg.task_type) ?? 'agent', NAME_CAP), state: 'running', ms: null,
    }
    this.tasks.set(taskId, { itemId: item.id, callId, start: this.o.now() })
    const agents = [...call.agents, agent]
    const next: ChatToolCall = { ...call, agents, detail: agents.length > 1 ? `${agents.length} agents` : call.detail }
    return this.callPatch(item, item.calls.map(c => (c.id === callId ? next : c)), next)
  }

  /** a subagent finished, failed or was stopped: its state on the call that started it */
  private taskNotification(msg: Obj): ChatPatch[] {
    const taskId = typeof msg.task_id === 'string' ? cap(msg.task_id, NAME_CAP) : null
    const link = taskId === null ? undefined : this.tasks.get(taskId)
    if (taskId === null || !link) return []
    const status = str(msg.status)
    const state: ChatCallState | null = status === 'completed' ? 'done' : status === 'failed' || status === 'stopped' ? 'failed' : null
    const item = this.get(link.itemId)
    if (state === null || item?.kind !== 'tools') return []
    const call = item.calls.find(c => c.id === link.callId)
    if (!call) return []
    // the stream's own duration when it gives one, never below zero; the clock's time when it gives none
    const reported = isObj(msg.usage) ? num(msg.usage.duration_ms) : null
    const ms = reported !== null ? Math.max(0, reported) : elapsed(link.start, this.o.now())
    this.tasks.delete(taskId)
    const next: ChatToolCall = { ...call, agents: call.agents.map(a => (a.id === taskId ? { ...a, state, ms } : a)) }
    return this.callPatch(item, item.calls.map(c => (c.id === next.id ? next : c)), next)
  }

  /** a result ends its turn; an interrupted one says so, a failed one says why */
  private result(msg: Obj): ChatPatch[] {
    const interrupted = this.interrupted || msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools'
    this.interrupted = false
    this.afterResult = true
    const done = this.sent.findIndex(e => e.started)
    if (done >= 0) this.sent.splice(done, 1)
    // a command's name belongs to its own output: a turn that ends without one leaves no name for the next
    this.command = null
    // the turn ends with its result, unless a queued prompt still waits: Claude Code takes that prompt into the next turn at once,
    // so the first waiting send leaves the queue here, and the turn goes on with it, on a new clock
    const patches: ChatPatch[] = []
    const next = this.queue.shift()
    if (next === undefined) {
      patches.push(...this.setState({ turn: 'idle', turnStartedAt: null }))
    } else {
      // the frames of that turn must not take another send: the first one is taken here
      this.afterResult = false
      const entry = this.sent.find(e => !e.started)
      if (entry) entry.started = true
      const item = this.get(next)
      if (item?.kind === 'user') patches.push(...this.set({ ...item, queued: false }))
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

  /** every call still running fails with the reason */
  private failRunning(reason: string): ChatPatch[] {
    const patches: ChatPatch[] = []
    for (const [callId, link] of this.calls) {
      const item = this.get(link.itemId)
      const call = item?.kind === 'tools' ? item.calls.find(c => c.id === callId) : undefined
      if (item?.kind !== 'tools' || call?.state !== 'running') continue
      const next: ChatToolCall = { ...call, state: 'failed', error: reason }
      patches.push(...this.callPatch(item, item.calls.map(c => (c.id === callId ? next : c)), next))
    }
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
    if (fiveHour !== null) this.fiveHour = fiveHour
    if (sevenDay !== null) this.sevenDay = sevenDay
    if (info.status !== 'rejected' || resetsAt === null || this.rejectedAt === resetsAt) return []
    this.rejectedAt = resetsAt
    const at = new Date(resetsAt * 1000)
    return this.notice(`Usage limit reached · resets at ${pad(at.getHours())}:${pad(at.getMinutes())}`, 'info', null)
  }

  private get(id: string): ChatItem | undefined {
    const i = this.at.get(id)
    return i === undefined ? undefined : this.list[i]
  }

  private put(item: ChatItem): void {
    const i = this.at.get(item.id)
    if (i !== undefined) this.list[i] = item
  }

  private add(item: ChatItem): ChatPatch[] {
    this.at.set(item.id, this.list.length)
    this.list.push(item)
    return [{ op: 'add', item }]
  }

  /** a text item closes the open step */
  private addText(item: ChatItem): ChatPatch[] {
    this.step = null
    return this.add(item)
  }

  private set(item: ChatItem): ChatPatch[] {
    this.put(item)
    return [{ op: 'set', item }]
  }

  /** the calls of a tools item change: the item keeps them, and the window gets the one call that changed */
  private callPatch(item: ToolsItem, calls: ChatToolCall[], call: ChatToolCall): ChatPatch[] {
    this.put({ ...item, calls })
    return [{ op: 'call', id: item.id, call }]
  }
}
