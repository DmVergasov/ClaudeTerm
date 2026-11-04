import { isAbsolute } from 'node:path'
import type { ImageAction } from '../shared/ipc'
import { isUuid } from '../shared/protocol'
import { REVIEW_SCOPES, type ReviewScope } from '../shared/review'
import type { OpenTabRequest, TabLayout } from '../shared/types'

// Runtime checks for untrusted renderer IPC arguments.
const MAX_DIM = 4000

export const isId = (v: unknown): v is string => typeof v === 'string'

/** a Claude Code session id */
export const isSessionId = isUuid

export const isFlag = (v: unknown): v is boolean => typeof v === 'boolean'

export const isPtyData = (v: unknown): v is string => typeof v === 'string'

/** an extra account's id, or null for the main account */
export const isAccountRef = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 64)

export const isOptionalTitle = (v: unknown): v is string | null => v === null || typeof v === 'string'

export const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

const IMAGE_ACTIONS: readonly string[] = ['open', 'reveal', 'copy-image', 'copy-path', 'remove']

export const isImageAction = (v: unknown): v is ImageAction => typeof v === 'string' && IMAGE_ACTIONS.includes(v)

export const isReviewScope = (v: unknown): v is ReviewScope => typeof v === 'string' && (REVIEW_SCOPES as readonly string[]).includes(v)

export const isAbsPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && isAbsolute(v)

export const isLineNo = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000

/** the side panel's width in px; 0: closed */
export const isPanelWidth = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_DIM

/** a change of the left tab panel's layout: each part that is present is checked */
export const isTabLayoutChange = (v: unknown): v is Partial<TabLayout> => {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  if (c.width !== undefined && (typeof c.width !== 'number' || !Number.isFinite(c.width))) return false
  if (c.folded !== undefined && !(Array.isArray(c.folded) && c.folded.length <= 200 && c.folded.every((k) => typeof k === 'string' && k.length <= 4096))) return false
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

export const isHash = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64

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
