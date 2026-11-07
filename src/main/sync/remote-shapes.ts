import { MAX_IMAGE_BYTES } from '../../shared/image-file'
import type { ImagesUpdate, StatusUpdate } from '../../shared/ipc'
import { isUuid } from '../../shared/protocol'
import { MAX_HASH } from '../../shared/review'
import {
  IMAGE_PART_BYTES,
  MAX_FOLDER_ENTRIES,
  MAX_PATH_TEXT,
  MAX_SNAPSHOT_BYTES,
  MAX_TRANSFER_BYTES,
  MAX_TRANSFER_FILES,
  RECENT_FOLDER_COUNT,
  TRANSFER_PART_BYTES,
  type FolderListing,
  type FolderResult,
  type PushKind,
  type RemoteSnapshot
} from '../../shared/remote'
import {
  REVIEW_SCOPES,
  type ReviewCounter,
  type ReviewFile,
  type ReviewFileNote,
  type ReviewFileStatus,
  type ReviewHunk,
  type ReviewLine,
  type ReviewLineKind,
  type ReviewScope,
  type ReviewSendState,
  type ReviewUpdate
} from '../../shared/review'
import type {
  AgentStatus,
  BackgroundTask,
  CardKind,
  ImageCard,
  ImageSource,
  MainStatus,
  PlanStatus,
  PlanTask,
  PlanTaskState,
  RecentSession,
  TabKind
} from '../../shared/types'
import { isAccountRef, isPtySize } from '../ipc-guards'
import { isChunk, isNonNegativeSafeInteger, isPositiveSafeInteger, isString, isTitle, orNull, parseCounter } from './remote-wire'
import { isPlainObject } from './views'

// The shapes of the part 2 calls and of the pushes: the arguments a call carries, the reply it answers with, and what a
// device pushes about its tabs. Everything here comes from another device, so each shape is checked, and a value that fails
// is refused: a null argument is a refusal, a null reply a failed call, a null push a dropped one.

const MAX_NAME = 255
const MAX_PROFILE = 256
const MAX_PROFILES = 64
const MAX_ACCOUNT = 64
const MAX_ACCOUNT_NAME = 256
const MAX_ACCOUNTS = 64
const MAX_DEVICE = 64
const MAX_REASON = 500
const MAX_SESSIONS = 1000
const MAX_SESSION_TEXT = 2000
const MAX_STATUS = 200
const MAX_AGENTS = 64
const MAX_BACKGROUND = 64
const MAX_CARDS = 10_000
const MAX_CAPTION = 1000
const MAX_NOTICE = 500
const MAX_PLAN_TITLE = 500
const MAX_PLAN_TASKS = 500
const MAX_REVIEW_FILES = 5000
const MAX_HUNKS = 10_000
const MAX_LINES = 100_000
const MAX_LINE_CHARS = 100_000
const MAX_SAMPLES = 10
const CARD_ID_RE = /^[0-9a-f]{20}$/
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const FOLDER_SEPARATOR = /[/\\]/

const FILE_STATUSES: readonly ReviewFileStatus[] = ['added', 'modified', 'deleted']
const FILE_NOTES: readonly ReviewFileNote[] = ['binary', 'too-large', 'eol-only', 'no-baseline', 'submodule', 'unreadable', 'too-many']
const LINE_KINDS: readonly ReviewLineKind[] = ['context', 'add', 'del']
const IMAGE_SOURCES: readonly ImageSource[] = ['created', 'shown', 'read', 'tool', 'pasted']
const CARD_KINDS: readonly CardKind[] = ['image', 'audio', 'video']
const PLAN_STATES: readonly PlanTaskState[] = ['done', 'current', 'left']

/** an object with no fields */
type Empty = Record<string, never>

/** what the Changes panel asks of a tab's review */
export type ReviewAction =
  | { k: 'scope'; scope: ReviewScope }
  | { k: 'clear' }
  | { k: 'refresh' }
  | { k: 'viewed'; path: string; hash: string; viewed: boolean }
  | { k: 'show'; path: string }

/** the arguments of each call method */
export interface CallArgs {
  attach: { id: string }
  'open-tab': { kind: TabKind; profile: string | null; account: string | null; resume: string | null }
  close: { id: string }
  'images-seen': { id: string }
  'can-send': { id: string }
  'can-fork': { id: string }
  'fork-tab': { id: string }
  restart: { id: string; live: boolean }
  rename: { id: string; title: string | null }
  mute: { id: string; muted: boolean }
  'switch-account': { id: string; account: string | null }
  'clear-task-list': { id: string }
  'image-remove': { id: string; card: string }
  image: { id: string; card: string; offset: number }
  review: { id: string; action: ReviewAction }
  profiles: Empty
  accounts: Empty
  sessions: Empty
  'open-session': { session: string }
  folders: { id: string; path: string | null }
  'change-folder': { id: string; path: string }
  'recv-begin': { id: string; files: { name: string; size: number }[] }
  'recv-part': { transfer: string; file: number; offset: number; data: string }
  'recv-end': { transfer: string }
  tabs: Empty
}

/** the reply each call method answers with */
export interface CallReplies {
  attach: RemoteSnapshot
  'open-tab': { id: string }
  close: Empty
  'images-seen': Empty
  'can-send': ReviewSendState
  'can-fork': { ok: boolean }
  'fork-tab': { id: string }
  restart: Empty
  rename: Empty
  mute: Empty
  'switch-account': { ok: boolean }
  'clear-task-list': { ok: boolean }
  'image-remove': Empty
  image: { version: number; size: number; data: string }
  review: Empty
  profiles: string[]
  accounts: { id: string; name: string }[]
  sessions: RecentSession[]
  'open-session': { id: string }
  folders: FolderResult
  'change-folder': Empty
  'recv-begin': { transfer: string }
  'recv-part': Empty
  'recv-end': { paths: string[] }
  tabs: Empty
}

export type CallMethod = keyof CallArgs

/** what a push carries, by its kind; the tab it is about is the push's own id */
export type PushValue =
  | { k: 'status'; v: Omit<StatusUpdate, 'tabId'> }
  | { k: 'plan'; v: PlanStatus | null; agentList: boolean }
  | { k: 'images'; v: Omit<ImagesUpdate, 'tabId' | 'remote'> }
  | { k: 'review'; v: Omit<ReviewUpdate, 'tabId' | 'remote'> }

/** The arguments of each call method, or null when they do not fit. Returns a copy of the known fields only. */
export const CALL_ARGS: { [M in CallMethod]: (a: unknown) => CallArgs[M] | null } = withoutPrototype({
  attach: idOf,
  'open-tab': openTabArgs,
  close: idOf,
  'images-seen': idOf,
  'can-send': idOf,
  'can-fork': idOf,
  'fork-tab': idOf,
  restart: (a) => {
    if (!isPlainObject(a)) return null
    const { id, live } = a
    if (!isUuid(id) || typeof live !== 'boolean') return null
    return { id, live }
  },
  rename: (a) => {
    if (!isPlainObject(a)) return null
    const { id, title } = a
    if (!isUuid(id) || !orNull(title, isTitle)) return null
    return { id, title: title as string | null }
  },
  mute: (a) => {
    if (!isPlainObject(a)) return null
    const { id, muted } = a
    if (!isUuid(id) || typeof muted !== 'boolean') return null
    return { id, muted }
  },
  'switch-account': (a) => {
    if (!isPlainObject(a)) return null
    const { id, account } = a
    if (!isUuid(id) || !accountRef(account)) return null
    return { id, account: account as string | null }
  },
  'clear-task-list': idOf,
  'image-remove': (a) => {
    if (!isPlainObject(a)) return null
    const { id, card } = a
    if (!isUuid(id) || !isCardId(card)) return null
    return { id, card }
  },
  image: (a) => {
    if (!isPlainObject(a)) return null
    const { id, card, offset } = a
    if (!isUuid(id) || !isCardId(card) || !isNonNegativeSafeInteger(offset)) return null
    return { id, card, offset }
  },
  review: (a) => {
    if (!isPlainObject(a)) return null
    const { id, action } = a
    if (!isUuid(id)) return null
    const found = reviewActionOf(action)
    return found ? { id, action: found } : null
  },
  profiles: emptyOf,
  accounts: emptyOf,
  sessions: emptyOf,
  'open-session': (a) => {
    if (!isPlainObject(a)) return null
    const { session } = a
    return isUuid(session) ? { session } : null
  },
  folders: (a) => {
    if (!isPlainObject(a)) return null
    const { id, path } = a
    if (!isUuid(id) || !orNull(path, (s) => isString(s, 0, MAX_PATH_TEXT))) return null
    return { id, path: path as string | null }
  },
  'change-folder': (a) => {
    if (!isPlainObject(a)) return null
    const { id, path } = a
    // an empty or blank folder is the tab device's own refusal (folderNotAbsolute), not a bad argument
    if (!isUuid(id) || !isString(path, 0, MAX_PATH_TEXT)) return null
    return { id, path }
  },
  'recv-begin': (a) => {
    if (!isPlainObject(a)) return null
    const { id, files } = a
    if (!isUuid(id) || !Array.isArray(files) || files.length < 1 || files.length > MAX_TRANSFER_FILES) return null
    const list: { name: string; size: number }[] = []
    let total = 0
    for (const f of files) {
      const file = transferFileOf(f)
      if (!file) return null
      total += file.size
      if (total > MAX_TRANSFER_BYTES) return null
      list.push(file)
    }
    return { id, files: list }
  },
  'recv-part': (a) => {
    if (!isPlainObject(a)) return null
    const { transfer, file, offset, data } = a
    if (!isUuid(transfer) || !isFileIndex(file) || !isNonNegativeSafeInteger(offset)) return null
    if (!isBase64(data, 1, TRANSFER_PART_BYTES)) return null
    return { transfer, file, offset, data }
  },
  'recv-end': transferOf,
  tabs: emptyOf
})

/** The reply of each call method, or null when it does not fit. Returns a copy of the known fields only. */
export const CALL_REPLIES: { [M in CallMethod]: (v: unknown) => CallReplies[M] | null } = withoutPrototype({
  attach: snapshotOf,
  'open-tab': idOf,
  close: emptyOf,
  'images-seen': emptyOf,
  'can-send': sendStateOf,
  'can-fork': okOf,
  'fork-tab': idOf,
  restart: emptyOf,
  rename: emptyOf,
  mute: emptyOf,
  'switch-account': okOf,
  'clear-task-list': okOf,
  'image-remove': emptyOf,
  image: imageOf,
  review: emptyOf,
  profiles: (v) => listOf(v, MAX_PROFILES, (x) => (isProfileName(x) ? x : null)),
  accounts: (v) => listOf(v, MAX_ACCOUNTS, accountEntry),
  sessions: sessionListOf,
  'open-session': idOf,
  folders: folderResultOf,
  'change-folder': emptyOf,
  'recv-begin': transferOf,
  'recv-part': emptyOf,
  'recv-end': pathsOf,
  tabs: emptyOf
})

/** The push of a kind, checked; `tabId` is the tab the push came for. A card of another tab refuses the push. */
export function parsePush(k: PushKind, v: unknown, tabId: string): PushValue | null {
  switch (k) {
    case 'status': {
      const status = statusOf(v)
      return status ? { k: 'status', v: status } : null
    }
    case 'plan': {
      // null: the plan is over
      if (v === null) return { k: 'plan', v: null, agentList: false }
      const plan = planOf(v)
      // the flag says the plan is the agent's task list: true, false or absent; anything else drops the push
      const agentList = isPlainObject(v) ? v.agentList : undefined
      if (!plan || (agentList !== undefined && typeof agentList !== 'boolean')) return null
      return { k: 'plan', v: plan, agentList: agentList === true }
    }
    case 'images': {
      const images = imagesOf(v, tabId)
      return images ? { k: 'images', v: images } : null
    }
    case 'review': {
      const review = reviewOf(v)
      return review ? { k: 'review', v: review } : null
    }
    default:
      return null
  }
}

// ---- helpers

/** one of the values: a string that is not one of them is refused */
function isOneOf<T extends string>(v: unknown, values: readonly T[]): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v)
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonNegativeNumber(v: unknown): v is number {
  return isNumber(v) && v >= 0
}

function isInteger(v: unknown): v is number {
  return Number.isSafeInteger(v)
}

function isCardId(v: unknown): v is string {
  return typeof v === 'string' && CARD_ID_RE.test(v)
}

function isFileIndex(v: unknown): v is number {
  return isNonNegativeSafeInteger(v) && v < MAX_TRANSFER_FILES
}

function isPathText(v: unknown): v is string {
  return isString(v, 1, MAX_PATH_TEXT)
}

function isProfileName(v: unknown): v is string {
  return isString(v, 1, MAX_PROFILE)
}

/** an extra account's id, or null for the main account; no NUL, like every text */
function accountRef(v: unknown): boolean {
  return isAccountRef(v) && (v === null || isString(v, 1, MAX_ACCOUNT))
}

/** a file's hash: 1 to 128 characters, no NUL; a binary file's hash in a SHA-256 repository is 71 characters */
function isHashText(v: unknown): v is string {
  return isString(v, 1, MAX_HASH)
}

/** a table with no prototype, so a method name from the network finds no entry: not Object's `constructor` or `__proto__` */
function withoutPrototype<T extends object>(table: T): T {
  return Object.freeze(Object.assign(Object.create(null), table))
}

/** base64 text whose decoded size is at least `min` and at most `max` bytes; its length is a multiple of 4 */
function isBase64(v: unknown, min: number, max: number): v is string {
  // the length bound first: a text longer than any part of `max` bytes is refused without a scan
  if (typeof v !== 'string' || v.length % 4 !== 0 || v.length > 4 * Math.ceil(max / 3) || !BASE64_RE.test(v)) return false
  const pad = v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0
  const bytes = (v.length / 4) * 3 - pad
  return bytes >= min && bytes <= max
}

/** a value that may be null: null, or what `parse` accepts; undefined when it is neither */
function maybe<T>(v: unknown, parse: (x: unknown) => T | null): T | null | undefined {
  if (v === null) return null
  return parse(v) ?? undefined
}

/** an array of at most `max` items, each one `item` accepts; null when the array is too long or one item fails */
function listOf<T>(v: unknown, max: number, item: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const x of v) {
    const y = item(x)
    if (y === null) return null
    out.push(y)
  }
  return out
}

// ---- call arguments

/** `{ id }`: a tab's UUID, the arguments of most calls and the reply of a call that opens a tab */
function idOf(v: unknown): { id: string } | null {
  if (!isPlainObject(v)) return null
  const { id } = v
  return isUuid(id) ? { id } : null
}

/** `{}`: a call with no arguments, and a reply with no fields */
function emptyOf(v: unknown): Empty | null {
  return isPlainObject(v) ? {} : null
}

function openTabArgs(a: unknown): CallArgs['open-tab'] | null {
  if (!isPlainObject(a)) return null
  const { kind, profile, account, resume } = a
  if (kind !== 'claude' && kind !== 'shell') return null
  if (!orNull(profile, isProfileName) || !orNull(account, accountRef) || !orNull(resume, isUuid)) return null
  // a conversation to resume is a Claude Code one: a shell tab has none
  if (kind === 'shell' && resume !== null) return null
  return { kind, profile: profile as string | null, account: account as string | null, resume: resume as string | null }
}

function reviewActionOf(v: unknown): ReviewAction | null {
  if (!isPlainObject(v)) return null
  switch (v.k) {
    case 'scope': {
      const { scope } = v
      return isOneOf(scope, REVIEW_SCOPES) ? { k: 'scope', scope } : null
    }
    case 'clear':
      return { k: 'clear' }
    case 'refresh':
      return { k: 'refresh' }
    case 'viewed': {
      const { path, hash, viewed } = v
      return isPathText(path) && isHashText(hash) && typeof viewed === 'boolean' ? { k: 'viewed', path, hash, viewed } : null
    }
    case 'show': {
      const { path } = v
      return isPathText(path) ? { k: 'show', path } : null
    }
    default:
      return null
  }
}

/** a file of a transfer: its name and its size in bytes */
function transferFileOf(v: unknown): { name: string; size: number } | null {
  if (!isPlainObject(v)) return null
  const { name, size } = v
  if (!isString(name, 1, MAX_NAME) || !isNonNegativeSafeInteger(size)) return null
  return { name, size }
}

/** `{ transfer }`: the arguments of recv-end, and the reply of recv-begin */
function transferOf(v: unknown): { transfer: string } | null {
  if (!isPlainObject(v)) return null
  const { transfer } = v
  return isUuid(transfer) ? { transfer } : null
}

// ---- call replies

/** the snapshot's text is terminal output, which may hold a NUL */
function snapshotOf(v: unknown): RemoteSnapshot | null {
  if (!isPlainObject(v)) return null
  const { data, seq, cols, rows } = v
  if (!isChunk(data, 0, MAX_SNAPSHOT_BYTES) || !isNonNegativeSafeInteger(seq) || !isPtySize(cols, rows)) return null
  return { data, seq, cols: cols as number, rows: rows as number }
}

function sendStateOf(v: unknown): ReviewSendState | null {
  if (!isPlainObject(v)) return null
  const { ok, reason } = v
  if (ok === true) return { ok: true }
  if (ok === false && isString(reason, 0, MAX_REASON)) return { ok: false, reason }
  return null
}

/** `{ ok }`: the answer of switch-account and can-fork */
function okOf(v: unknown): { ok: boolean } | null {
  if (!isPlainObject(v)) return null
  const { ok } = v
  return typeof ok === 'boolean' ? { ok } : null
}

function imageOf(v: unknown): CallReplies['image'] | null {
  if (!isPlainObject(v)) return null
  const { version, size, data } = v
  if (!isPositiveSafeInteger(version) || !isNonNegativeSafeInteger(size) || size > MAX_IMAGE_BYTES) return null
  if (!isBase64(data, 0, IMAGE_PART_BYTES)) return null
  return { version, size, data }
}

function accountEntry(v: unknown): { id: string; name: string } | null {
  if (!isPlainObject(v)) return null
  const { id, name } = v
  return isString(id, 1, MAX_ACCOUNT) && isString(name, 1, MAX_ACCOUNT_NAME) ? { id, name } : null
}

function sessionTextOf(v: unknown): boolean {
  return isString(v, 0, MAX_SESSION_TEXT)
}

function sessionEntry(v: unknown): RecentSession | null {
  if (!isPlainObject(v)) return null
  const { id, cwd, title, firstPrompt, lastPrompt, modifiedAt, open, starred } = v
  if (!isUuid(id) || !isPathText(cwd) || typeof open !== 'boolean' || typeof starred !== 'boolean') return null
  if (!isNonNegativeNumber(modifiedAt)) return null
  if (!orNull(title, sessionTextOf) || !orNull(firstPrompt, sessionTextOf) || !orNull(lastPrompt, sessionTextOf)) return null
  return {
    id,
    cwd,
    title: title as string | null,
    firstPrompt: firstPrompt as string | null,
    lastPrompt: lastPrompt as string | null,
    modifiedAt,
    open,
    starred
  }
}

/** the sessions a device lists: an entry that fails sessionEntry is left out and the rest are kept; a list that is not one, or is over MAX_SESSIONS, is refused */
function sessionListOf(v: unknown): RecentSession[] | null {
  if (!Array.isArray(v) || v.length > MAX_SESSIONS) return null
  const out: RecentSession[] = []
  for (const x of v) {
    const y = sessionEntry(x)
    if (y !== null) out.push(y)
  }
  return out
}

function folderName(v: unknown): string | null {
  return isString(v, 1, MAX_NAME) && !FOLDER_SEPARATOR.test(v) ? v : null
}

function listingOf(v: unknown): FolderListing | null {
  if (!isPlainObject(v)) return null
  const { device, path, sep, parent, folders, recent } = v
  if (!isString(device, 1, MAX_DEVICE) || !isPathText(path)) return null
  if (sep !== '/' && sep !== '\\') return null
  if (!orNull(parent, isPathText)) return null
  const names = listOf(folders, MAX_FOLDER_ENTRIES, folderName)
  const recents = listOf(recent, RECENT_FOLDER_COUNT, (x) => (isPathText(x) ? x : null))
  if (!names || !recents) return null
  return { device, path, sep, parent: parent as string | null, folders: names, recent: recents }
}

function folderResultOf(v: unknown): FolderResult | null {
  if (!isPlainObject(v)) return null
  const { ok, error, listing } = v
  if (ok === false) return isString(error, 0, MAX_REASON) ? { ok: false, error } : null
  if (ok !== true) return null
  const found = listingOf(listing)
  return found ? { ok: true, listing: found } : null
}

function pathsOf(v: unknown): CallReplies['recv-end'] | null {
  if (!isPlainObject(v)) return null
  const { paths } = v
  const list = listOf(paths, MAX_TRANSFER_FILES, (x) => (isPathText(x) ? x : null))
  return list ? { paths: list } : null
}

// ---- pushes

function contextOf(v: unknown): NonNullable<MainStatus['context']> | null {
  if (!isPlainObject(v)) return null
  const { usedTokens, size, usedPct } = v
  return isNumber(usedTokens) && isNumber(size) && isNumber(usedPct) ? { usedTokens, size, usedPct } : null
}

function rateOf(v: unknown): NonNullable<MainStatus['fiveHour']> | null {
  if (!isPlainObject(v)) return null
  const { usedPct, resetsAt } = v
  return isNumber(usedPct) && isNumber(resetsAt) ? { usedPct, resetsAt } : null
}

function mainOf(v: unknown): MainStatus | null {
  if (!isPlainObject(v)) return null
  const { model, effort, context, fiveHour, sevenDay } = v
  if (!isPlainObject(model)) return null
  const { id, displayName } = model
  if (!isStatusText(id) || !isStatusText(displayName) || !orNull(effort, isStatusText)) return null
  const ctx = maybe(context, contextOf)
  const five = maybe(fiveHour, rateOf)
  const seven = maybe(sevenDay, rateOf)
  if (ctx === undefined || five === undefined || seven === undefined) return null
  return { model: { id, displayName }, effort: effort as string | null, context: ctx, fiveHour: five, sevenDay: seven }
}

function isStatusText(v: unknown): v is string {
  return isString(v, 0, MAX_STATUS)
}

function agentOf(v: unknown): AgentStatus | null {
  if (!isPlainObject(v)) return null
  const { agentId, type, description, model, effort, startedAt } = v
  if (!isStatusText(agentId) || !isStatusText(type) || !isNumber(startedAt)) return null
  if (!orNull(description, isStatusText) || !orNull(model, isStatusText) || !orNull(effort, isStatusText)) return null
  return {
    agentId,
    type,
    description: description as string | null,
    model: model as string | null,
    effort: effort as string | null,
    startedAt
  }
}

function backgroundOf(v: unknown): BackgroundTask | null {
  if (!isPlainObject(v)) return null
  const { id, type, description, command } = v
  if (!isStatusText(id) || !isStatusText(type)) return null
  if (!orNull(description, isStatusText) || !orNull(command, isStatusText)) return null
  return { id, type, description: description as string | null, command: command as string | null }
}

function statusOf(v: unknown): Omit<StatusUpdate, 'tabId'> | null {
  if (!isPlainObject(v)) return null
  const { main, agents, background } = v
  const status = maybe(main, mainOf)
  const list = listOf(agents, MAX_AGENTS, agentOf)
  // a device that sends no background tasks has none
  const tasks = background === undefined ? [] : listOf(background, MAX_BACKGROUND, backgroundOf)
  if (status === undefined || !list || !tasks) return null
  return { main: status, agents: list, background: tasks }
}

function taskOf(v: unknown): PlanTask | null {
  if (!isPlainObject(v)) return null
  const { n, title, state } = v
  if (!isInteger(n) || !isString(title, 0, MAX_PLAN_TITLE) || !isOneOf(state, PLAN_STATES)) return null
  return { n, title, state }
}

function planOf(v: unknown): PlanStatus | null {
  if (!isPlainObject(v)) return null
  const { title, tasks, done, total, finished } = v
  if (!isString(title, 0, MAX_PLAN_TITLE)) return null
  const list = listOf(tasks, MAX_PLAN_TASKS, taskOf)
  if (!list || !isNonNegativeSafeInteger(done) || !isNonNegativeSafeInteger(total) || typeof finished !== 'boolean') return null
  return { title, tasks: list, done, total, finished }
}

function captionOf(v: unknown): boolean {
  return isString(v, 0, MAX_CAPTION)
}

function cardOf(v: unknown, tabId: string): ImageCard | null {
  if (!isPlainObject(v)) return null
  const { id, tabId: owner, path, relPath, name, source, kind, caption, touchedAt, version, updated, deleted } = v
  if (owner !== tabId || !isCardId(id)) return null
  if (!isPathText(path) || !isPathText(relPath) || !isString(name, 1, MAX_NAME)) return null
  if (!isOneOf(source, IMAGE_SOURCES) || !isOneOf(kind, CARD_KINDS) || !orNull(caption, captionOf)) return null
  if (!isNonNegativeNumber(touchedAt) || !isPositiveSafeInteger(version)) return null
  if (typeof updated !== 'boolean' || typeof deleted !== 'boolean') return null
  return {
    id,
    tabId,
    path,
    relPath,
    name,
    source,
    kind,
    caption: caption as string | null,
    touchedAt,
    version,
    updated,
    deleted
  }
}

function noticeOf(v: unknown): boolean {
  return isString(v, 0, MAX_NOTICE)
}

function imagesOf(v: unknown, tabId: string): Omit<ImagesUpdate, 'tabId'> | null {
  if (!isPlainObject(v)) return null
  const { cards, unseen, notice } = v
  const list = listOf(cards, MAX_CARDS, (c) => cardOf(c, tabId))
  if (!list || !isNonNegativeSafeInteger(unseen) || !orNull(notice, noticeOf)) return null
  return { cards: list, unseen, notice: notice as string | null }
}

function reviewViewOf(v: unknown): ReviewUpdate['view'] | null {
  if (!isPlainObject(v)) return null
  const { kind, scope } = v
  if (kind === 'request') return { kind: 'request' }
  if (kind === 'scope' && isOneOf(scope, REVIEW_SCOPES)) return { kind: 'scope', scope }
  return null
}

function uncommittedOf(v: unknown): ReviewUpdate['uncommitted'] | null {
  if (!isPlainObject(v)) return null
  const { available, reason } = v
  if (available === true) return { available: true }
  if (available === false && isString(reason, 0, MAX_PATH_TEXT)) return { available: false, reason }
  return null
}

function labelOf(v: unknown): boolean {
  return isString(v, 0, MAX_PATH_TEXT)
}

function lineOf(v: unknown): ReviewLine | null {
  if (!isPlainObject(v)) return null
  const { kind, text, oldNo, newNo } = v
  if (!isOneOf(kind, LINE_KINDS) || !isString(text, 0, MAX_LINE_CHARS)) return null
  if (!orNull(oldNo, isPositiveSafeInteger) || !orNull(newNo, isPositiveSafeInteger)) return null
  return { kind, text, oldNo: oldNo as number | null, newNo: newNo as number | null }
}

function hunkOf(v: unknown): ReviewHunk | null {
  if (!isPlainObject(v)) return null
  const { header, lines } = v
  if (!isString(header, 0, MAX_PATH_TEXT)) return null
  const list = listOf(lines, MAX_LINES, lineOf)
  return list ? { header, lines: list } : null
}

function fileNoteOf(v: unknown): boolean {
  return isOneOf(v, FILE_NOTES)
}

function fileOf(v: unknown): ReviewFile | null {
  if (!isPlainObject(v)) return null
  const { path, relPath, status, additions, deletions, hunks, note, canForce, hash, viewed, markdown, lineCount: count } = v
  // a device that sends no line count has no tail gap: 0 lines
  const lineCount = count === undefined ? 0 : count
  if (!isPathText(path) || !isPathText(relPath) || !isOneOf(status, FILE_STATUSES)) return null
  if (!isNonNegativeSafeInteger(additions) || !isNonNegativeSafeInteger(deletions) || !isNonNegativeSafeInteger(lineCount)) return null
  const hunkList = listOf(hunks, MAX_HUNKS, hunkOf)
  if (!hunkList || !orNull(note, fileNoteOf) || typeof canForce !== 'boolean' || !isHashText(hash)) return null
  if (typeof viewed !== 'boolean' || typeof markdown !== 'boolean') return null
  return {
    path,
    relPath,
    status,
    additions,
    deletions,
    hunks: hunkList,
    note: note as ReviewFileNote | null,
    canForce,
    hash,
    viewed,
    markdown,
    lineCount
  }
}

function reviewOf(v: unknown): Omit<ReviewUpdate, 'tabId' | 'remote'> | null {
  if (!isPlainObject(v)) return null
  const {
    view, label, uncommitted, files, additions, deletions, unviewed, ignored, hideTests, renderMarkdown, testsHidden,
    testsSample, outside, outsideSample, folder, notice, send, counter, reveal
  } = v
  const viewOf = reviewViewOf(view)
  const uncommittedState = uncommittedOf(uncommitted)
  const fileList = listOf(files, MAX_REVIEW_FILES, fileOf)
  const testsList = listOf(testsSample, MAX_SAMPLES, (x) => (isPathText(x) ? x : null))
  const outsideList = listOf(outsideSample, MAX_SAMPLES, (x) => (isPathText(x) ? x : null))
  if (!viewOf || !uncommittedState || !fileList || !testsList || !outsideList) return null
  if (!isString(label, 0, MAX_PATH_TEXT) || !isPathText(folder) || !orNull(notice, labelOf)) return null
  const sendState = sendStateOf(send)
  if (!sendState) return null
  if (!isNonNegativeSafeInteger(additions) || !isNonNegativeSafeInteger(deletions) || !isNonNegativeSafeInteger(unviewed)) return null
  if (!isNonNegativeSafeInteger(ignored) || !isNonNegativeSafeInteger(testsHidden) || !isNonNegativeSafeInteger(outside)) return null
  if (typeof hideTests !== 'boolean' || typeof renderMarkdown !== 'boolean' || typeof reveal !== 'boolean') return null
  // the counter is what RemoteTab.counter takes: null, or a counter the tab check accepts
  let counterOf: ReviewCounter | null = null
  if (counter !== null) {
    counterOf = parseCounter(counter)
    if (!counterOf) return null
  }
  return {
    view: viewOf,
    label,
    uncommitted: uncommittedState,
    files: fileList,
    additions,
    deletions,
    unviewed,
    ignored,
    hideTests,
    renderMarkdown,
    testsHidden,
    testsSample: testsList,
    outside,
    outsideSample: outsideList,
    folder,
    notice: notice as string | null,
    send: sendState,
    counter: counterOf,
    reveal
  }
}
