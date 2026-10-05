import type { ImageAction } from '../shared/ipc'

// Runtime checks for untrusted renderer IPC arguments.
const MAX_DIM = 4000

export const isId = (v: unknown): v is string => typeof v === 'string'

export const isPtyData = (v: unknown): v is string => typeof v === 'string'

export const isOptionalTitle = (v: unknown): v is string | null => v === null || typeof v === 'string'

export const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

const IMAGE_ACTIONS: readonly string[] = ['open', 'reveal', 'copy-image', 'copy-path', 'remove']

export const isImageAction = (v: unknown): v is ImageAction => typeof v === 'string' && IMAGE_ACTIONS.includes(v)

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
