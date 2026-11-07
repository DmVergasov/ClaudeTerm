import { isAbsolute } from 'node:path'
import { DOC_ACTIONS, type DocAction } from '../shared/docs'
import type { ImageAction } from '../shared/ipc'
import { MAX_ADDRESS_LENGTH } from '../shared/devices'
import { MAX_NOTE_LENGTH, NOTE_FORMS, type NoteForm } from '../shared/note'
import { isUuid } from '../shared/protocol'
import { MAX_HASH, REVIEW_SCOPES, type ReviewScope } from '../shared/review'
import { MAX_FOLDED_GROUPS, type OpenTabRequest, type TabLayout } from '../shared/types'
import { MAX_PATH_TEXT, MAX_SNAPSHOT_BYTES, MAX_TRANSFER_FILES } from '../shared/remote'

// Runtime checks for untrusted renderer IPC arguments.
const MAX_DIM = 4000
/** a pairing code as typed, with its separators and spaces around it */
const MAX_PAIR_CODE_INPUT = 64
/** a device name as typed: the group checks its length in characters and its control characters */
const MAX_DEVICE_NAME_INPUT = 256
/** a profile's name as the group checks it */
const MAX_PROFILE_NAME = 256

export const isId = (v: unknown): v is string => typeof v === 'string'

/** a Claude Code session id */
export const isSessionId = isUuid

/** a device's id in the group */
export const isDeviceId = isUuid

/** the arguments of a new tab on another device: its device, a Claude or shell tab, a profile name (null for Claude) and an account ref */
export const isOpenRemoteTabArgs = (device: unknown, kind: unknown, profile: unknown, account: unknown): boolean =>
  isDeviceId(device) && (kind === 'claude' || kind === 'shell') && (profile === null || (typeof profile === 'string' && profile.length >= 1 && profile.length <= MAX_PROFILE_NAME)) && isAccountRef(account)

/** an address typed for a device or to join one: a name or IP address, optionally with :port */
export const isAddressInput = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ADDRESS_LENGTH

/** an address typed for a device, or null to clear it */
export const isOptionalAddress = (v: unknown): v is string | null => v === null || isAddressInput(v)

export const isPairCodeInput = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PAIR_CODE_INPUT

export const isDeviceNameInput = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_DEVICE_NAME_INPUT

export const isFlag = (v: unknown): v is boolean => typeof v === 'boolean'

export const isPtyData = (v: unknown): v is string => typeof v === 'string'

/** an extra account's id, or null for the main account */
export const isAccountRef = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 64)

export const isOptionalTitle = (v: unknown): v is string | null => v === null || typeof v === 'string'

export const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

const IMAGE_ACTIONS: readonly string[] = ['open', 'reveal', 'copy-image', 'copy-path', 'remove']

export const isImageAction = (v: unknown): v is ImageAction => typeof v === 'string' && IMAGE_ACTIONS.includes(v)

export const isDocAction = (v: unknown): v is DocAction => typeof v === 'string' && (DOC_ACTIONS as readonly string[]).includes(v)

export const isReviewScope = (v: unknown): v is ReviewScope => typeof v === 'string' && (REVIEW_SCOPES as readonly string[]).includes(v)

export const isNoteText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NOTE_LENGTH

export const isNoteForm = (v: unknown): v is NoteForm => typeof v === 'string' && (NOTE_FORMS as readonly string[]).includes(v)

/** how many tabs need the user, for the app icon's badge */
export const isTabCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000

/** the number of a tab's note an edit was typed against */
export const isGeneration = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export const isAbsPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && isAbsolute(v)

/** the files of this device dropped on a remote tab: 1 to MAX_TRANSFER_FILES absolute paths of at most MAX_PATH_TEXT, each checked as this device's own */
export const isDropPaths = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= MAX_TRANSFER_FILES && v.every((p) => isAbsPath(p) && p.length <= MAX_PATH_TEXT)

/** a path of any system, as text: bounded, and nothing else checked; the device that owns the path checks it with its own rules */
export const isPathText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH_TEXT

/** a folder as the user typed it for Change folder: bounded text, and nothing else checked; `~`, relative paths and the other system's paths are read on the tab's device */
export const isFolderInput = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PATH_TEXT

export const isLineNo = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000

/** the lines one expand click in the Changes panel asks for: from..to, at most 1000 of them */
export const isLineSpan = (from: unknown, to: unknown): boolean => isLineNo(from) && isLineNo(to) && from <= to && to - from < 1000

/** the side panel's width in px; 0: closed */
export const isPanelWidth = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_DIM

/** a change of the left tab panel's layout: each part that is present is checked */
export const isTabLayoutChange = (v: unknown): v is Partial<TabLayout> => {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  if (c.width !== undefined && (typeof c.width !== 'number' || !Number.isFinite(c.width))) return false
  if (c.folded !== undefined && !(Array.isArray(c.folded) && c.folded.length <= MAX_FOLDED_GROUPS && c.folded.every((k) => typeof k === 'string' && k.length <= 4096))) return false
  return true
}

/** a request to open a tab: its kind and folder, and each optional field of its type when it is present */
export const isOpenTabRequest = (v: unknown): v is OpenTabRequest => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  const present = (x: unknown, ok: (y: unknown) => boolean): boolean => x === undefined || ok(x)
  return (r.kind === 'claude' || r.kind === 'shell') &&
    isAbsPath(r.cwd) &&
    present(r.profile, (x) => x === null || typeof x === 'string') &&
    present(r.title, isOptionalTitle) &&
    present(r.resumeSessionId, (x) => x === null || isSessionId(x)) &&
    present(r.account, isAccountRef) &&
    present(r.muted, isFlag)
}

/** the request as a tab opens from it: the fields the guard checks, and no fork (only Fork session makes one) */
export const openTabRequestFields = (req: OpenTabRequest): OpenTabRequest => ({
  kind: req.kind,
  cwd: req.cwd,
  ...(req.profile === undefined ? {} : { profile: req.profile }),
  ...(req.title === undefined ? {} : { title: req.title }),
  ...(req.resumeSessionId === undefined ? {} : { resumeSessionId: req.resumeSessionId }),
  ...(req.account === undefined ? {} : { account: req.account }),
  ...(req.muted === undefined ? {} : { muted: req.muted }),
  fork: null
})

export const isHash = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_HASH

/** a screen copy handed back by the window: a string of at most MAX_SNAPSHOT_BYTES characters */
export const isSeedText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_SNAPSHOT_BYTES

/** the token of a seed request: a safe integer of at least 1 */
export const isSeedToken = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1

export function isPtySize(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === 'number' && typeof rows === 'number' &&
    Number.isInteger(cols) && Number.isInteger(rows) &&
    cols >= 1 && rows >= 1 && cols <= MAX_DIM && rows <= MAX_DIM
  )
}

// xterm.js answers focus/device/cursor queries through onData; those are not keystrokes.
const TERMINAL_REPORTS = /^(?:\x1b\[[IO]|\x1b\[[?>]?[\d;]*c|\x1b\[\??[\d;]*R|\x1b\[\??[\d;]*\$y)+$/

export const isUserInput = (data: string): boolean => !TERMINAL_REPORTS.test(data)

// mouse reports (SGR, X10) and the keys that scroll a view: reading a reply, not writing a prompt
const READING_INPUT = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[1456](?:;\d+)?~|\x1b\[(?:1;\d+)?[HF])+$/

/** a key that can change what a prompt holds: text, editing keys, history (arrows), a paste */
export const isPromptInput = (data: string): boolean => isUserInput(data) && !READING_INPUT.test(data)
