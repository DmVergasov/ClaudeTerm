import { isAbsolute } from 'node:path'
import { CARRY_ITEMS, FLOW_MODES, type AccountBegin, type CarryItem, type CarryLineItem, type FlowAction, type RemoveOptions } from '../shared/accounts'
import { DOC_ACTIONS, type DocAction } from '../shared/docs'
import type { ImageAction } from '../shared/ipc'
import { MAX_ADDRESS_LENGTH } from '../shared/devices'
import { MAX_NOTE_LENGTH, NOTE_FORMS, NOTE_SIDES, isNoteSize, isProjectKey, type NoteForm, type NoteSide, type NoteSize } from '../shared/note'
import { isUuid } from '../shared/protocol'
import { MAX_FILE_LINKS } from '../shared/chat-paths'
import { MAX_HASH, REVIEW_SCOPES, type ReviewScope } from '../shared/review'
import { MAX_FOLDED_GROUPS, type OpenTabRequest, type TabLayout } from '../shared/types'
import { MAX_PATH_TEXT, MAX_SNAPSHOT_BYTES, MAX_TRANSFER_FILES } from '../shared/remote'
import { MCP_EDIT_SCOPES, marketplaceSource, type McpAction, type McpAddRequest, type McpEditScope, type PluginAction, type ReloadAction } from '../shared/mcp'
import { isServerName } from '../shared/mcp-add'

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

/** an item the account flow carries over from another account */
export const isCarryItem = (v: unknown): v is CarryItem => typeof v === 'string' && (CARRY_ITEMS as readonly string[]).includes(v)

/** a line of the carry progress: a carry item, or ClaudeTerm's own tools */
export const isCarryLineItem = (v: unknown): v is CarryLineItem => isCarryItem(v) || v === 'claudeterm'

const FLOW_ACTION_KINDS: readonly string[] = ['cancel', 'show-tab', 'retry-sign-in', 'another-login', 'keep-login', 'open-tab', 'close']

/** a button of the account flow: an action, or a retry of one line of the carry progress */
export const isFlowAction = (v: unknown): v is FlowAction => {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  if (a.kind === 'retry-item') return isCarryLineItem(a.item)
  return typeof a.kind === 'string' && FLOW_ACTION_KINDS.includes(a.kind)
}

/** a request to start the account flow: a mode, an id, a name and an email of at most 200 and 254 characters, a source account, distinct carry items and the adopt flag */
export const isAccountBegin = (v: unknown): v is AccountBegin => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  const text = (x: unknown, min: number, max: number): boolean => x === null || (typeof x === 'string' && x.length >= min && x.length <= max)
  return (FLOW_MODES as readonly unknown[]).includes(r.mode) &&
    text(r.id, 1, 64) && text(r.name, 0, 200) && text(r.email, 0, 254) && text(r.source, 1, 64) &&
    Array.isArray(r.items) && r.items.every(isCarryItem) && new Set(r.items).size === r.items.length &&
    isFlag(r.adopt)
}

/** the options of a removal: both flags, or none at all */
export const isRemoveOptions = (v: unknown): v is RemoveOptions | undefined => {
  if (v === undefined) return true
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return isFlag(o.signOut) && isFlag(o.deleteFolder)
}

export const isOptionalTitle = (v: unknown): v is string | null => v === null || typeof v === 'string'

export const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

const IMAGE_ACTIONS: readonly string[] = ['open', 'reveal', 'copy-image', 'copy-path', 'remove']

export const isImageAction = (v: unknown): v is ImageAction => typeof v === 'string' && IMAGE_ACTIONS.includes(v)

export const isDocAction = (v: unknown): v is DocAction => typeof v === 'string' && (DOC_ACTIONS as readonly string[]).includes(v)

export const isReviewScope = (v: unknown): v is ReviewScope => typeof v === 'string' && (REVIEW_SCOPES as readonly string[]).includes(v)

export const isNoteText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NOTE_LENGTH

export const isNoteForm = (v: unknown): v is NoteForm => typeof v === 'string' && (NOTE_FORMS as readonly string[]).includes(v)

export const isNoteSide = (v: unknown): v is NoteSide => typeof v === 'string' && (NOTE_SIDES as readonly string[]).includes(v)

/** a note's card size, or null: the default size */
export const isNoteSizeArg = (v: unknown): v is NoteSize | null => v === null || isNoteSize(v)

/** a project's key, as TabPlace.project.key gives it */
export const isProjectKeyArg = (v: unknown): v is string => isProjectKey(v)

/** how many tabs need the user, for the app icon's badge */
export const isTabCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000

/** the number of a tab's note an edit was typed against */
export const isGeneration = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export const isAbsPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && isAbsolute(v)

/** the files of this device dropped on a remote tab: 1 to MAX_TRANSFER_FILES absolute paths of at most MAX_PATH_TEXT, each checked as this device's own */
export const isDropPaths = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= MAX_TRANSFER_FILES && v.every((p) => isAbsPath(p) && p.length <= MAX_PATH_TEXT)

/** the files dropped on a local tab, typed as text for its shell: 1 to 10 000 paths of 1 to MAX_PATH_TEXT characters (the copy's limit of 100 files does not apply) */
export const isLocalDropPaths = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= 10_000 && v.every((p) => typeof p === 'string' && p.length >= 1 && p.length <= MAX_PATH_TEXT)

/** a path of any system, as text: bounded, and nothing else checked; the device that owns the path checks it with its own rules */
export const isPathText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH_TEXT

/** the path texts a chat text asks main to resolve: at most MAX_FILE_LINKS, each of 1 to MAX_PATH_TEXT characters on one line */
export const isFileLinkPaths = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_FILE_LINKS && v.every((p) => typeof p === 'string' && p.length >= 1 && p.length <= MAX_PATH_TEXT && !/[\x00-\x1f\x7f]/.test(p))

/** a folder as the user typed it for Change folder: bounded text, and nothing else checked; `~`, relative paths and the other system's paths are read on the tab's device */
export const isFolderInput = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PATH_TEXT

export const isLineNo = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000

/** a line a chat link names: null when the text names none, else a line number */
export const isOptionalLineNo = (v: unknown): v is number | null => v === null || isLineNo(v)

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

// the answers among them (device attributes, cursor position, mode reports), not the focus reports
const TERMINAL_ANSWERS = /^(?:\x1b\[[?>]?[\d;]*c|\x1b\[\??[\d;]*R|\x1b\[\??[\d;]*\$y)+$/

/** what xterm.js answers to a program's question about the terminal, which is not typed */
export const isTerminalAnswer = (data: string): boolean => TERMINAL_ANSWERS.test(data)

// mouse reports (SGR, X10) and the keys that scroll a view: reading a reply, not writing a prompt
const READING_INPUT = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[1456](?:;\d+)?~|\x1b\[(?:1;\d+)?[HF])+$/

/** a key that can change what a prompt holds: text, editing keys, history (arrows), a paste */
export const isPromptInput = (data: string): boolean => isUserInput(data) && !READING_INPUT.test(data)

// the MCP · Plugins panel's requests: names and text bounded as the panel types them; the shapes are those of shared/mcp.ts
const MAX_MCP_TEXT = 65_536
const MAX_MCP_NAMES = 20
const MAX_MCP_NAME = 200
const MAX_MCP_SECRET = 4096
const MAX_PLUGIN_ID = 200
const MAX_PLUGIN_SOURCE = 2000
const MAX_PLUGIN_VALUES = 50
const MAX_PLUGIN_VALUE = 4096
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const PLUGIN_ID = /^[A-Za-z0-9][\w.-]*(@[A-Za-z0-9][\w.-]*)?$/
const MARKETPLACE_NAME = /^[A-Za-z0-9][\w.-]*$/
const OPTION_KEY = /^[\w.-]{1,100}$/
const RELOAD_ACTIONS: readonly string[] = ['not-now', 'restart']

/** text of 1 to max characters on one line */
const oneLine = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && !CONTROL_CHARACTER.test(v)

/** a server name as the panel passes it to a row action: 1 to 200 characters, one line, not an option */
export const isMcpName = (v: unknown): v is string => oneLine(v, MAX_MCP_NAME) && !v.startsWith('-')

const isMcpEditScope = (v: unknown): v is McpEditScope => typeof v === 'string' && (MCP_EDIT_SCOPES as readonly string[]).includes(v)

/** a row action of the servers list: its kind with the name, the scope or the switch it needs */
export const isMcpAction = (v: unknown): v is McpAction => {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  switch (a.kind) {
    case 'reconnect':
    case 'login':
    case 'cancel-login':
    case 'logout':
      return isMcpName(a.name)
    case 'toggle':
      return isMcpName(a.name) && typeof a.enabled === 'boolean'
    case 'remove':
    case 'copy-config':
      return isMcpName(a.name) && isMcpEditScope(a.scope)
    case 'open-config':
      return isMcpEditScope(a.scope)
    default:
      return false
  }
}

/** an add from pasted text: the text, the names chosen for its servers (each a valid name, at most 20), the scope and a secret or null */
export const isMcpAddRequest = (v: unknown): v is McpAddRequest => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.text === 'string' && r.text.length <= MAX_MCP_TEXT &&
    Array.isArray(r.names) && r.names.length <= MAX_MCP_NAMES && r.names.every((n) => typeof n === 'string' && isServerName(n)) &&
    isMcpEditScope(r.scope) &&
    (r.clientSecret === null || oneLine(r.clientSecret, MAX_MCP_SECRET))
}

const isPluginId = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PLUGIN_ID && PLUGIN_ID.test(v)

const isMarketplaceName = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PLUGIN_ID && MARKETPLACE_NAME.test(v)

/** plugin option values: at most 50 entries, keys of 1 to 100 characters, values of one line */
const isOptionValues = (v: unknown): v is Record<string, string> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const entries = Object.entries(v)
  return entries.length <= MAX_PLUGIN_VALUES && entries.every(([key, value]) => OPTION_KEY.test(key) && typeof value === 'string' && value.length <= MAX_PLUGIN_VALUE && !CONTROL_CHARACTER.test(value))
}

/** a plugin or marketplace action: an id (name@marketplace), a marketplace name, a source `claude plugin marketplace add` takes, or the option values */
export const isPluginAction = (v: unknown): v is PluginAction => {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  switch (a.kind) {
    case 'install':
    case 'uninstall':
    case 'enable':
    case 'disable':
    case 'update':
    case 'configure-later':
      return isPluginId(a.id)
    case 'configure':
      return isPluginId(a.id) && isOptionValues(a.values)
    case 'marketplace-add':
      return typeof a.source === 'string' && a.source.length <= MAX_PLUGIN_SOURCE && marketplaceSource(a.source) !== null
    case 'marketplace-remove':
    case 'marketplace-update':
      return isMarketplaceName(a.name)
    default:
      return false
  }
}

/** the reload card's answer: later, or restart now */
export const isReloadAction = (v: unknown): v is ReloadAction => typeof v === 'string' && RELOAD_ACTIONS.includes(v)
