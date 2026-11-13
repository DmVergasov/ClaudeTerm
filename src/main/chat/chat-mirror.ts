import { acceptPatches, type ChatActivity, type ChatCard, type ChatItem, type ChatPatch, type ChatSnapshot, type ChatState, type ChatToolCall } from '../../shared/chat'
import { isChatOrigin, isPermissionMode } from './chat-guards'
import { cap, PAGE, SUBJECT_CAP } from './chat-model'

// A chat as a member holds it, from the host's pushes. The host's pushes are checked here, the way the host's own
// model made them: a value that fails a check is dropped, never thrown.

// the caps of plan 1: a text item 1 MiB, tool output 64 KiB, subject 500, a card's strings 64 KiB; ids and names 500,
// paths 4096, model 200. Each one is the cap the host applies to that field (chat-model.ts, chat-cards.ts, chat-guards.ts),
// so a value the host produces always passes here
const TEXT_CAP = 1024 * 1024
const OUTPUT_CAP = 64 * 1024
const NAME_CAP = 500
const PATH_CAP = 4096
const MODEL_CAP = 200
const CARD_CAP = 64 * 1024
/** an attachment's or an image's card id (chat-guards.ts); a suggestion's label (chat-cards.ts LABEL_CAP) */
const CARD_ID_CAP = 64
const LABEL_CAP = 500

/** the most items a snapshot holds, and the most patches a batch holds */
export const MAX_CHAT_ITEMS = 2000
export const MAX_CHAT_PATCHES = 500

/** a push of a snapshot: the snapshot itself; a push of patches: the batch from fromRev to toRev */
export type ChatPush = { snapshot: ChatSnapshot } | { fromRev: number; toRev: number; patches: ChatPatch[] }

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max
const opt = (v: unknown, ok: (x: unknown) => boolean): boolean => v === null || ok(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
// a duration is for display only, so any finite number passes: a batch is not refused over one (a clock stepped back gives a negative one)
const isMs = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const isId = (v: unknown): v is string => str(v, NAME_CAP, 1)
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T)

const CALL_STATES = ['running', 'done', 'failed'] as const
const TURNS = ['idle', 'working', 'waiting'] as const
const NOTICE_ACTIONS = [null, 'restart', 'open-terminal'] as const

function isAttachment(v: unknown): boolean {
  return isObj(v) && oneOf(['image', 'file'], v.kind) && str(v.path, PATH_CAP, 1) && str(v.name, PATH_CAP)
    && isCount(v.size) && opt(v.cardId, (s) => str(s, CARD_ID_CAP))
}

function isSubagent(v: unknown): boolean {
  return isObj(v) && isId(v.id) && str(v.description, SUBJECT_CAP) && str(v.type, NAME_CAP) && oneOf(CALL_STATES, v.state) && opt(v.ms, isMs)
    && (v.model === undefined || isId(v.model)) && (v.effort === undefined || isId(v.effort)) && (v.context === undefined || isCount(v.context))
}

function isCall(v: unknown): v is ChatToolCall {
  return isObj(v) && isId(v.id) && str(v.name, NAME_CAP) && str(v.subject, SUBJECT_CAP) && opt(v.detail, (s) => str(s, OUTPUT_CAP))
    && oneOf(CALL_STATES, v.state) && opt(v.output, (s) => str(s, OUTPUT_CAP)) && opt(v.error, (s) => str(s, OUTPUT_CAP))
    && opt(v.editPath, (s) => str(s, PATH_CAP)) && Array.isArray(v.agents) && v.agents.every(isSubagent) && opt(v.ms, isMs)
}

function isSuggestion(v: unknown): boolean {
  return isObj(v) && isCount(v.index) && str(v.label, LABEL_CAP)
}

function isCard(v: unknown): v is ChatCard {
  if (!isObj(v)) return false
  switch (v.type) {
    case 'permission':
      return str(v.tool, CARD_CAP) && str(v.title, CARD_CAP) && str(v.subject, CARD_CAP) && opt(v.description, (s) => str(s, CARD_CAP))
        && opt(v.diff, (d) => isObj(d) && str(d.path, CARD_CAP) && str(d.before, CARD_CAP) && str(d.after, CARD_CAP))
        && Array.isArray(v.suggestions) && v.suggestions.every(isSuggestion) && isBool(v.defaultToNo)
    case 'question':
      return Array.isArray(v.questions) && v.questions.every((q) => isObj(q) && str(q.question, CARD_CAP) && str(q.header, CARD_CAP)
        && isBool(q.multiSelect) && Array.isArray(q.options)
        && q.options.every((o) => isObj(o) && str(o.label, CARD_CAP) && str(o.description, CARD_CAP)))
    case 'plan':
      return str(v.plan, CARD_CAP)
    case 'dialog':
      return str(v.kind, CARD_CAP) && str(v.title, CARD_CAP) && str(v.text, CARD_CAP) && Array.isArray(v.choices)
        && v.choices.every((c) => isObj(c) && str(c.id, CARD_CAP) && str(c.label, CARD_CAP))
    default:
      return false
  }
}

function isItem(v: unknown): v is ChatItem {
  if (!isObj(v) || !isId(v.id)) return false
  switch (v.kind) {
    case 'user':
      return str(v.text, TEXT_CAP) && Array.isArray(v.attachments) && v.attachments.every(isAttachment) && isBool(v.queued)
        && (v.from === undefined || isChatOrigin(v.from))
    case 'text':
      return str(v.markdown, TEXT_CAP) && isBool(v.streaming)
    case 'thinking':
      return opt(v.ms, isMs) && opt(v.summary, (s) => str(s, TEXT_CAP))
    case 'tools':
      return Array.isArray(v.calls) && v.calls.every(isCall) && opt(v.ms, isMs)
    case 'images':
      return Array.isArray(v.images) && v.images.every((i) => isObj(i) && str(i.path, PATH_CAP) && opt(i.cardId, (s) => str(s, CARD_ID_CAP)))
    case 'command':
      // the host keeps the first word of a typed command (chat-model firstWord: NAME_CAP)
      return str(v.command, NAME_CAP) && str(v.output, OUTPUT_CAP)
    case 'notice':
      // the line an 'open-terminal' notice types: a text of the output cap, or none (an item without the field is a notice without one)
      return oneOf(['info', 'error'], v.tone) && str(v.text, OUTPUT_CAP) && NOTICE_ACTIONS.some((a) => a === v.action)
        && (v.line === undefined || opt(v.line, (s) => str(s, OUTPUT_CAP)))
    case 'divider':
      return str(v.text, SUBJECT_CAP)
    case 'event':
      // a row of a message Claude Code sent, not the person's: its source, its title, its status (or none) and the text folded under it
      return oneOf(['task', 'peer', 'message'], v.source) && str(v.title, SUBJECT_CAP) && opt(v.status, (s) => str(s, NAME_CAP))
        && str(v.body, TEXT_CAP)
    case 'card':
      return isCard(v.card) && opt(v.answered, (s) => str(s, CARD_CAP))
    default:
      return false
  }
}

/** a list of items as a page or a snapshot holds them: at most MAX_CHAT_ITEMS, each one checked */
export function isItems(v: unknown): v is ChatItem[] {
  return Array.isArray(v) && v.length <= MAX_CHAT_ITEMS && v.every(isItem)
}

// a state from a device that predates the activity has none: the field is optional
function isState(v: unknown): v is ChatState {
  return isObj(v) && oneOf(TURNS, v.turn) && opt(v.turnStartedAt, isMs) && isPermissionMode(v.mode)
    && opt(v.model, (s) => str(s, MODEL_CAP)) && opt(v.effort, (s) => str(s, MODEL_CAP)) && opt(v.sessionId, isId) && isBool(v.exited)
    && (v.activity === undefined || isActivity(v.activity))
}

function isActivity(v: unknown): v is ChatActivity {
  return isObj(v) && oneOf(['compacting', 'restarting'] as const, v.kind) && isMs(v.since)
}

function isSnapshot(v: unknown): v is ChatSnapshot {
  return isObj(v) && isId(v.tabId) && isCount(v.rev) && isItems(v.items) && isBool(v.hasOlder) && isState(v.state)
}

function isPatch(v: unknown): v is ChatPatch {
  if (!isObj(v)) return false
  switch (v.op) {
    case 'add':
    case 'set':
      return isItem(v.item)
    case 'append':
      return isId(v.id) && str(v.text, TEXT_CAP)
    case 'remove':
      return isId(v.id)
    case 'call':
      return isId(v.id) && isCall(v.call)
    case 'state':
      return isState(v.state)
    case 'reset':
      return isItems(v.items) && isBool(v.hasOlder)
    default:
      return false
  }
}

/**
 * Checks a chat push. A snapshot is given as itself; a batch as { fromRev, toRev, patches }, whose revisions count its
 * patches (one revision each). Returns the push, or null when any part of it does not fit.
 */
export function parseChatPush(v: unknown): ChatPush | null {
  if (!isObj(v)) return null
  if ('patches' in v) {
    const { fromRev, toRev, patches } = v
    if (!isCount(fromRev) || !isCount(toRev) || !Array.isArray(patches) || patches.length > MAX_CHAT_PATCHES) return null
    if (toRev - fromRev !== patches.length || !patches.every(isPatch)) return null
    return { fromRev, toRev, patches }
  }
  return isSnapshot(v) ? { snapshot: v } : null
}

/**
 * A snapshot cut to fit maxBytes of JSON, and to MAX_CHAT_ITEMS: the newest items that fit, in their order, with hasOlder
 * set when some were left out. A snapshot that fits is returned as it is.
 */
export function capSnapshot(s: ChatSnapshot, maxBytes: number): ChatSnapshot {
  const cut = capItems(s.items, maxBytes - bytesOf({ ...s, items: [] }))
  return cut.cut ? { ...s, items: cut.items, hasOlder: true } : s
}

/** the JSON bytes of a value, as a frame carries it */
const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v))

/**
 * The newest items of a list that fit `budget` bytes of JSON (at most MAX_CHAT_ITEMS), in their order, and whether some were
 * left out. One walk from the newest item back, each item's JSON on its own, so it never stringifies more than the items it
 * keeps and the one that does not fit. A non-empty list never comes back empty: when even its newest item does not fit, that
 * item is cut to fit (fitItem).
 */
export function capItems(items: ChatItem[], budget: number): { items: ChatItem[]; cut: boolean } {
  let left = budget
  let kept = 0
  while (kept < items.length && kept < MAX_CHAT_ITEMS) {
    // one byte more than the item's own JSON: its comma, which a first item does not have, so the cut is never too big
    const size = bytesOf(items[items.length - 1 - kept]) + 1
    if (size > left) break
    left -= size
    kept++
  }
  if (kept === 0 && items.length > 0) return { items: [fitItem(items[items.length - 1], budget)], cut: true }
  return { items: items.slice(items.length - kept), cut: kept < items.length }
}

/**
 * An item cut to fit `budget` bytes of JSON, for the one item a cut could not keep whole. A tool step keeps its newest calls
 * whole and loses the output, detail and error of its older calls, oldest first, until it fits. A text keeps the tail of its
 * text. Any other item is returned as it is.
 */
function fitItem(item: ChatItem, budget: number): ChatItem {
  switch (item.kind) {
    case 'tools':
      return fitTools(item, budget)
    case 'text':
      return { ...item, markdown: tailOf(item.markdown, budget - bytesOf({ ...item, markdown: '' })) }
    case 'user':
      return { ...item, text: tailOf(item.text, budget - bytesOf({ ...item, text: '' })) }
    case 'event': {
      // the title is capped as the host caps it, so a long one leaves the body its share; the body keeps the tail of what the title leaves
      const title = tailOf(cap(item.title, SUBJECT_CAP), budget - bytesOf({ ...item, title: '', body: '' }))
      return { ...item, title, body: tailOf(item.body, budget - bytesOf({ ...item, title, body: '' })) }
    }
    case 'command':
      return { ...item, output: tailOf(item.output, budget - bytesOf({ ...item, output: '' })) }
    case 'thinking':
      return item.summary === null ? item : { ...item, summary: tailOf(item.summary, budget - bytesOf({ ...item, summary: '' })) }
    default:
      return item
  }
}

function fitTools(item: Extract<ChatItem, { kind: 'tools' }>, budget: number): Extract<ChatItem, { kind: 'tools' }> {
  const calls = item.calls.slice()
  // the item's JSON: its own keys with an empty list, the calls, and a comma between each two
  let total = bytesOf({ ...item, calls: [] }) + Math.max(0, calls.length - 1)
  for (const c of calls) total += bytesOf(c)
  // the newest call stays whole: only the calls before it lose their texts
  for (let i = 0; i < calls.length - 1 && total > budget; i++) {
    const c = calls[i]
    if (c.output === null && c.detail === null && c.error === null) continue
    const cut: ChatToolCall = { ...c, output: null, detail: null, error: null }
    total -= bytesOf(c) - bytesOf(cut)
    calls[i] = cut
  }
  return { ...item, calls }
}

/** the bytes one UTF-16 unit takes in a JSON string, escapes counted; a surrogate counts as an escape, a bound over its pair */
function unitBytes(code: number): number {
  if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) return 6
  if (code < 0x80) return 1
  return code < 0x800 ? 2 : 3
}

/** the longest tail of a text whose JSON string fits `room` bytes; its first unit is never half a surrogate pair */
function tailOf(s: string, room: number): string {
  let used = 0
  let start = s.length
  for (let i = s.length - 1; i >= 0; i--) {
    const bytes = unitBytes(s.charCodeAt(i))
    if (used + bytes > room) break
    used += bytes
    start = i
  }
  // a low surrogate whose high half is cut off would be a lone unit
  if (start < s.length && s.charCodeAt(start) >= 0xdc00 && s.charCodeAt(start) <= 0xdfff) start++
  return s.slice(start)
}

/** a chat as a member holds it: loaded from a snapshot, moved on by the batches the host sends */
export class ChatMirror {
  private current: ChatSnapshot | null = null

  /** the snapshot the mirror holds from now on; the mirror keeps its own copy of it */
  load(s: ChatSnapshot): void {
    this.current = structuredClone(s)
  }

  /**
   * The batch from fromRev to toRev, taken by the shared rule (acceptPatches): a batch the mirror already has is ignored,
   * one that straddles its revision is applied from the patch it lacks. false: the batch does not follow what the mirror
   * holds, or there is no snapshot yet; the member asks the host for a fresh snapshot.
   */
  apply(fromRev: number, toRev: number, patches: ChatPatch[]): boolean {
    const s = this.current
    if (!s) return false
    const accept = acceptPatches(s.rev, fromRev, toRev, patches.length)
    if (accept.kind === 'gap') return false
    if (accept.kind === 'ignore') return true
    // each patch is copied as it comes in: the mirror keeps no item that the caller still holds
    for (const p of patches.slice(accept.skip)) applyPatch(s, structuredClone(p))
    // the newest page is kept, as a local window holds it: the older items are the host's to page, and a patch for one is ignored
    if (s.items.length > PAGE) {
      s.items = s.items.slice(s.items.length - PAGE)
      s.hasOlder = true
    }
    s.rev = toRev
    return true
  }

  /** a copy of the snapshot the mirror holds: a caller may change it, and the mirror does not change */
  snapshot(): ChatSnapshot | null {
    return this.current === null ? null : structuredClone(this.current)
  }
}

/** the patch on the snapshot's own list: an item that is not there is left alone, as the view leaves it */
function applyPatch(s: ChatSnapshot, p: ChatPatch): void {
  switch (p.op) {
    case 'add':
      s.items.push(p.item)
      break
    case 'set': {
      const i = indexOf(s, p.item.id)
      if (i >= 0) s.items[i] = p.item
      break
    }
    case 'append': {
      const i = indexOf(s, p.id)
      const item = s.items[i]
      if (i >= 0 && item.kind === 'text') s.items[i] = { ...item, markdown: item.markdown + p.text }
      break
    }
    case 'remove': {
      const i = indexOf(s, p.id)
      if (i >= 0) s.items.splice(i, 1)
      break
    }
    case 'call': {
      const i = indexOf(s, p.id)
      const item = s.items[i]
      if (i < 0 || item.kind !== 'tools') break
      const calls = item.calls.some((c) => c.id === p.call.id)
        ? item.calls.map((c) => (c.id === p.call.id ? p.call : c))
        : [...item.calls, p.call]
      s.items[i] = { ...item, calls }
      break
    }
    case 'state':
      s.state = p.state
      break
    case 'reset':
      s.items = p.items
      s.hasOlder = p.hasOlder
      break
  }
}

function indexOf(s: ChatSnapshot, id: string): number {
  return s.items.findIndex((item) => item.id === id)
}
