import { type MailRecord } from '../../shared/mail'
import { isUuid } from '../../shared/protocol'
import { MAX_INPUT_CHARS, MAX_OUT_CHARS, MAX_PATH_TEXT, MAX_REMOTE_TABS, PUSH_KINDS, type PushKind, type RemoteTab } from '../../shared/remote'
import type { ReviewCounter } from '../../shared/review'
import { NOTIFICATION_CASES } from '../../shared/settings-keys'
import { WORKTREE_COLORS, type NotificationCase, type TabKind, type TabPlace } from '../../shared/types'
import { isPtySize } from '../ipc-guards'
import { checkMailRecord } from '../mail/mail-record'
import { isPlainObject } from './views'

// The shapes of the part 2 messages: remote tabs, their output and input, and the calls and replies. Everything here is
// checked, and a message that fails is dropped by its caller.

/** A part 2 message. `a` and `v` are checked by the handler that uses them. */
export type RemoteMessage =
  | { t: 'call'; id: number; m: string; a: unknown }
  | { t: 'reply'; id: number; ok: true; v: unknown }
  | { t: 'reply'; id: number; ok: false; e: string }
  | { t: 'tabs'; tabs: RemoteTab[] }
  | { t: 'tab'; tab: RemoteTab }
  | { t: 'tab-closed'; id: string }
  | { t: 'out'; id: string; seq: number; d: string }
  | { t: 'reset'; id: string; seq: number }
  | { t: 'exit'; id: string; seq: number; code: number }
  | { t: 'detached'; id: string }
  | { t: 'push'; id: string; k: PushKind; v: unknown }
  | { t: 'in'; id: string; d: string }
  | { t: 'claim'; id: string; cols: number; rows: number }
  | { t: 'front'; id: string | null; present: boolean; focused: boolean }
  | { t: 'ring'; id: string; reason: NotificationCase }
  /** the ids and flags of the mail a device holds (1 delivered, 2 read), for the other side to send what it lacks */
  | { t: 'mail-have'; have: [string, number][]; more?: true }
  | { t: 'mail-records'; records: MailRecord[] }
  | { t: 'mail-accept'; on: boolean; wakes: boolean; claude: string | null }

/** The shape of a call's method name on the wire; a call whose name does not match is not sent, and a peer refuses one that does not. */
export const METHOD_RE = /^[a-z][a-z-]{0,31}$/
/** the largest size a member may claim for a tab of this device: a copy of 1000 by 500 cells, far under a local size's limit */
export const MAX_REMOTE_COLS = 1000
export const MAX_REMOTE_ROWS = 500
const MAX_ERROR_LENGTH = 1000
const MAX_TITLE_LENGTH = 1000
const MAX_STATUS_LENGTH = 200
const MAX_PROFILE_LENGTH = 256
const MAX_ACCOUNT_LENGTH = 64
const MAX_ACCOUNT_NAME_LENGTH = 256
const MAX_PLACE_NAME_LENGTH = 256
const MAX_BRANCH_LENGTH = 256
/** the most entries a mail-have may carry, and the most records a mail-records may carry */
export const MAX_HAVE_ENTRIES = 20_000
export const MAX_MAIL_RECORDS = 500
const MAX_CLAUDE_LENGTH = 32
// a C0 control character: a branch name holds none
const C0_RE = /[\u0000-\u001f]/

/**
 * Checks the shape of a part 2 message. 'unknown': a type this version does not know. null: malformed.
 * Called by parseMessage for every type it does not know itself.
 */
export function parseRemoteMessage(v: Record<string, unknown>): RemoteMessage | 'unknown' | null {
  switch (v.t) {
    case 'call': {
      const { id, m } = v
      if (!isPositiveSafeInteger(id) || typeof m !== 'string' || !METHOD_RE.test(m) || !('a' in v)) return null
      return { t: 'call', id, m, a: v.a }
    }
    case 'reply': {
      const { id } = v
      if (!isPositiveSafeInteger(id)) return null
      if (v.ok === true) return 'v' in v ? { t: 'reply', id, ok: true, v: v.v } : null
      if (v.ok === false) return isString(v.e, 1, MAX_ERROR_LENGTH) ? { t: 'reply', id, ok: false, e: v.e } : null
      return null
    }
    case 'tabs': {
      const { tabs } = v
      if (!Array.isArray(tabs) || tabs.length > MAX_REMOTE_TABS) return null
      // an entry that fails its check is left out; the rest are kept
      const list: RemoteTab[] = []
      for (const t of tabs) {
        const tab = parseRemoteTab(t)
        if (tab) list.push(tab)
      }
      return { t: 'tabs', tabs: list }
    }
    case 'tab': {
      const tab = parseRemoteTab(v.tab)
      return tab ? { t: 'tab', tab } : null
    }
    case 'tab-closed': {
      const { id } = v
      return isUuid(id) ? { t: 'tab-closed', id } : null
    }
    case 'out': {
      const { id, seq, d } = v
      return isUuid(id) && isPositiveSafeInteger(seq) && isChunk(d, 0, MAX_OUT_CHARS) ? { t: 'out', id, seq, d } : null
    }
    case 'reset': {
      const { id, seq } = v
      return isUuid(id) && isPositiveSafeInteger(seq) ? { t: 'reset', id, seq } : null
    }
    case 'exit': {
      const { id, seq, code } = v
      return isUuid(id) && isPositiveSafeInteger(seq) && Number.isSafeInteger(code) ? { t: 'exit', id, seq, code: code as number } : null
    }
    case 'detached': {
      const { id } = v
      return isUuid(id) ? { t: 'detached', id } : null
    }
    case 'push': {
      const { id, k } = v
      const kind = PUSH_KINDS.find((p) => p === k)
      if (!isUuid(id) || !kind || !('v' in v)) return null
      return { t: 'push', id, k: kind, v: v.v }
    }
    case 'in': {
      const { id, d } = v
      return isUuid(id) && isChunk(d, 1, MAX_INPUT_CHARS) ? { t: 'in', id, d } : null
    }
    case 'claim': {
      // a member's claim resizes this device's tab: it is bounded lower than a size this device gives itself
      const { id, cols, rows } = v
      const fits = typeof cols === 'number' && typeof rows === 'number' && cols <= MAX_REMOTE_COLS && rows <= MAX_REMOTE_ROWS
      return isUuid(id) && fits && isPtySize(cols, rows) ? { t: 'claim', id, cols: cols as number, rows: rows as number } : null
    }
    case 'front': {
      // present is absent from an older member, which is not present; focused is all a 0.15.0 member sends, and clears its mark as before; any other value is a bad message
      const { id, present, focused } = v
      if (present !== undefined && typeof present !== 'boolean') return null
      if (focused !== undefined && typeof focused !== 'boolean') return null
      const flags = { present: present === true, focused: focused === true }
      if (id === null) return { t: 'front', id: null, ...flags }
      return isUuid(id) ? { t: 'front', id, ...flags } : null
    }
    case 'ring': {
      // a tab's attention rung on a member that is present with the tab in front: the tab and its case, nothing else
      const { id, reason } = v
      return isUuid(id) && NOTIFICATION_CASES.some((c) => c === reason) ? { t: 'ring', id, reason: reason as NotificationCase } : null
    }
    case 'mail-have': {
      // every entry is an id and its flags; one entry that does not fit fails the whole list
      const { have } = v
      if (!Array.isArray(have) || have.length > MAX_HAVE_ENTRIES) return null
      const list: [string, number][] = []
      for (const e of have) {
        if (!Array.isArray(e) || e.length !== 2 || !isUuid(e[0]) || !isFlags(e[1])) return null
        list.push([e[0], e[1]])
      }
      // more is kept only when it is true: the digest goes on in the next message
      return { t: 'mail-have', have: list, ...(v.more === true ? { more: true as const } : {}) }
    }
    case 'mail-records': {
      // a record that fails its check is left out; the rest are kept
      const { records } = v
      if (!Array.isArray(records) || records.length > MAX_MAIL_RECORDS) return null
      const list: MailRecord[] = []
      for (const r of records) {
        const record = checkMailRecord(r)
        if (record) list.push(record)
      }
      return { t: 'mail-records', records: list }
    }
    case 'mail-accept': {
      const { on, wakes, claude } = v
      if (typeof on !== 'boolean' || typeof wakes !== 'boolean' || !orNull(claude, (s) => isString(s, 1, MAX_CLAUDE_LENGTH))) return null
      return { t: 'mail-accept', on, wakes, claude: claude as string | null }
    }
    default:
      return 'unknown'
  }
}

/** Checks one tab as a device describes it; returns a copy holding only its known fields, or null when it does not fit. */
export function parseRemoteTab(v: unknown): RemoteTab | null {
  if (!isPlainObject(v)) return null
  const {
    id, kind, profile, cwd, customTitle, title, claudeSessionId, account, accountName, muted, exited, working,
    attention, attentionSeq, images, note, counter, status, size, place, placeKnown, folder, forkOf, fork
  } = v
  if (!isUuid(id) || (kind !== 'claude' && kind !== 'shell')) return null
  if (!isString(profile, 1, MAX_PROFILE_LENGTH) || !isString(cwd, 1, MAX_PATH_TEXT)) return null
  if (!orNull(customTitle, isTitle) || !orNull(title, isTitle) || !orNull(claudeSessionId, isUuid)) return null
  if (!orNull(account, (s) => isString(s, 1, MAX_ACCOUNT_LENGTH)) || !orNull(accountName, (s) => isString(s, 0, MAX_ACCOUNT_NAME_LENGTH))) return null
  if (typeof muted !== 'boolean' || typeof exited !== 'boolean' || typeof working !== 'boolean' || typeof note !== 'boolean') return null
  if (!orNull(attention, (s) => NOTIFICATION_CASES.some((c) => c === s))) return null
  if (!isNonNegativeSafeInteger(attentionSeq) || !isNonNegativeSafeInteger(images)) return null
  if (!orNull(status, (s) => isString(s, 0, MAX_STATUS_LENGTH))) return null
  let counterOf: ReviewCounter | null = null
  if (counter !== null) {
    counterOf = parseCounter(counter)
    if (!counterOf) return null
  }
  if (!isPlainObject(size) || !isPtySize(size.cols, size.rows) || !orNull(size.by, isUuid)) return null
  // a device of an older build sends no place, head or fork: none of them is a tab's; a head that does not fit is no head
  return {
    id,
    kind: kind as TabKind,
    profile,
    cwd,
    customTitle: customTitle as string | null,
    title: title as string | null,
    claudeSessionId: claudeSessionId as string | null,
    account: account as string | null,
    accountName: accountName as string | null,
    muted,
    exited,
    working,
    attention: attention as NotificationCase | null,
    attentionSeq,
    images,
    note,
    counter: counterOf,
    status: status as string | null,
    size: { cols: size.cols as number, rows: size.rows as number, by: size.by as string | null },
    place: parsePlace(place),
    // an older device sends no placeKnown: its place is known
    placeKnown: placeKnown !== false,
    // checked like the cwd; a folder that is missing or invalid is the cwd
    folder: isString(folder, 1, MAX_PATH_TEXT) ? folder : cwd,
    // a head is kept only for a fork: a head of a tab that is no fork is no head
    forkOf: fork === true && isUuid(forkOf) ? forkOf : null,
    fork: fork === true
  }
}

/**
 * A tab's place as a device describes it: a copy of its fields when every one fits its check (the project's key up to
 * MAX_PATH_TEXT, its parent 0 to MAX_PATH_TEXT, its name up to 256, no NUL in them; a worktree's path up to MAX_PATH_TEXT and its colour an index of WORKTREE_COLORS;
 * a branch of 1 to 256 characters with no control character). Anything else is null.
 */
export function parsePlace(v: unknown): TabPlace | null {
  if (!isPlainObject(v)) return null
  const { project, worktree, branch } = v
  if (!isPlainObject(project)) return null
  const { key, name, parent } = project
  // no NUL in a path or a name; an empty parent is a repository directly under a root (C:\acme, /app)
  if (!isString(key, 1, MAX_PATH_TEXT) || !isString(name, 1, MAX_PLACE_NAME_LENGTH) || !isString(parent, 0, MAX_PATH_TEXT)) return null
  const linked = worktreeOf(worktree)
  if (linked === undefined) return null
  if (!isChunk(branch, 1, MAX_BRANCH_LENGTH) || C0_RE.test(branch)) return null
  return { project: { key, name, parent }, worktree: linked, branch }
}

/** a worktree that fits its check, a copy of it; null for the main worktree; undefined when it does not fit */
function worktreeOf(v: unknown): TabPlace['worktree'] | undefined {
  if (v === null) return null
  if (!isPlainObject(v)) return undefined
  const { path, color } = v
  if (!isString(path, 1, MAX_PATH_TEXT)) return undefined
  if (!Number.isSafeInteger(color) || (color as number) < 0 || (color as number) >= WORKTREE_COLORS.length) return undefined
  return { path, color: color as number }
}

export function parseCounter(v: unknown): ReviewCounter | null {
  if (!isPlainObject(v)) return null
  const { files, additions, deletions, title } = v
  if (!isNonNegativeSafeInteger(files) || !isNonNegativeSafeInteger(additions) || !isNonNegativeSafeInteger(deletions)) return null
  if (!isString(title, 0, MAX_TITLE_LENGTH)) return null
  return { files, additions, deletions, title }
}

export function isTitle(v: unknown): boolean {
  return isString(v, 0, MAX_TITLE_LENGTH)
}

/** null, or a value the check accepts */
export function orNull(v: unknown, ok: (x: unknown) => boolean): boolean {
  return v === null || ok(v)
}

/** A text field: a string of min to max characters with no NUL. */
export function isString(v: unknown, min: number, max: number): v is string {
  return isChunk(v, min, max) && !v.includes('\u0000')
}

/** Terminal data: a string of min to max characters. It may hold a NUL, as a program's output can. */
export function isChunk(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}

export function isPositiveSafeInteger(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0
}

export function isNonNegativeSafeInteger(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0
}

/** the flags of a mail record: an integer from 0 to 3 */
function isFlags(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3
}
