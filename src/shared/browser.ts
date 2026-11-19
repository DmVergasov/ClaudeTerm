import { isWebUrl } from './site'

/** the browser tools Claude sees, one per command */
export const BROWSER_TOOL_NAMES = ['browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_reload', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_hover', 'browser_select_option', 'browser_scroll', 'browser_wait_for', 'browser_take_screenshot', 'browser_evaluate', 'browser_console_messages', 'browser_network_requests', 'browser_network_request', 'browser_handle_dialog', 'browser_tabs'] as const

export type BrowserCommand =
  | { op: 'navigate'; url: string } | { op: 'back' } | { op: 'forward' } | { op: 'reload' } | { op: 'snapshot' }
  | { op: 'click'; ref: string; element: string; button: 'left' | 'right' | 'middle'; doubleClick: boolean }
  | { op: 'type'; ref: string; element: string; text: string; submit: boolean; slowly: boolean }
  | { op: 'press_key'; key: string } | { op: 'hover'; ref: string; element: string }
  | { op: 'select_option'; ref: string; element: string; values: string[] }
  | { op: 'scroll'; ref: string | null; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { op: 'wait_for'; text: string | null; textGone: string | null; time: number | null }
  | { op: 'screenshot'; fullPage: boolean; ref: string | null }
  | { op: 'evaluate'; function: string; ref: string | null }
  | { op: 'console'; onlyErrors: boolean } | { op: 'network' } | { op: 'network_request'; id: string }
  | { op: 'handle_dialog'; accept: boolean; promptText: string | null }
  | { op: 'tabs'; action: 'list' | 'new' | 'select' | 'close'; index: number | null; url: string | null }
export type BrowserOp = BrowserCommand['op']

export const MAX_URL = 8192
export const MAX_TEXT = 20_000
export const MAX_FUNCTION = 30_000
export const MAX_ELEMENT = 300
export const MAX_KEY = 64
export const MAX_VALUES = 50
export const MAX_VALUE = 1000
export const MAX_WAIT_SECONDS = 60
export const MAX_SCROLL = 10_000
export const DEFAULT_SCROLL = 600
export const MAX_PAGES = 20
export const REF_RE = /^e[0-9]{1,7}$/
export const REQUEST_ID_RE = /^r[0-9]{1,7}$/

type Fields = Record<string, unknown>
export type ParsedBrowserCommand = { ok: true; command: BrowserCommand } | { ok: false; error: string }

/** thrown inside the parser when a field is refused; the message names the field */
class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message)
}

/** a required text of min to max characters */
function str(f: Fields, name: string, max: number, min = 1): string {
  const v = f[name]
  if (typeof v !== 'string' || v.length < min || v.length > max) refuse(`${name} must be a string of ${min} to ${max} characters`)
  return v
}

/** a text of min to max characters, or absent: null */
function optStr(f: Fields, name: string, max: number, min = 1): string | null {
  return f[name] === undefined || f[name] === null ? null : str(f, name, max, min)
}

/** a snapshot ref such as e12 */
function requiredRef(f: Fields): string {
  const v = str(f, 'ref', 64)
  if (!REF_RE.test(v)) refuse('ref must be a snapshot ref such as e12')
  return v
}

/** a snapshot ref such as e12, or absent: null */
function optionalRef(f: Fields): string | null {
  return f.ref === undefined || f.ref === null ? null : requiredRef(f)
}

/** true or false: the default when absent, and required when there is none */
function flag(f: Fields, name: string, def?: boolean): boolean {
  const v = f[name] ?? def
  if (typeof v !== 'boolean') refuse(`${name} must be true or false`)
  return v
}

/** one of the options; the default when absent */
function choice<T extends string>(f: Fields, name: string, options: readonly T[], def?: T): T {
  const v = f[name] ?? def
  if (typeof v !== 'string' || !options.includes(v as T)) refuse(`${name} must be ${options.map((o) => `"${o}"`).join(', ')}`)
  return v as T
}

/** a whole number from min to max; the default when absent */
function integer(f: Fields, name: string, min: number, max: number, def?: number): number {
  const v = f[name] ?? def
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) refuse(`${name} must be a whole number from ${min} to ${max}`)
  return v
}

function values(f: Fields): string[] {
  const v = f.values
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_VALUES) refuse(`values must be 1 to ${MAX_VALUES} strings`)
  const items: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || item.length > MAX_VALUE) refuse(`values must be strings of at most ${MAX_VALUE} characters`)
    items.push(item)
  }
  return items
}

/** the seconds of a wait: absent is null, otherwise more than 0 and at most MAX_WAIT_SECONDS */
function seconds(f: Fields): number | null {
  const v = f.time
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !(v > 0 && v <= MAX_WAIT_SECONDS)) refuse(`time must be more than 0 and at most ${MAX_WAIT_SECONDS} seconds`)
  return v
}

function command(f: Fields): BrowserCommand {
  switch (f.op) {
    case 'navigate': return { op: 'navigate', url: str(f, 'url', MAX_URL) }
    case 'back': return { op: 'back' }
    case 'forward': return { op: 'forward' }
    case 'reload': return { op: 'reload' }
    case 'snapshot': return { op: 'snapshot' }
    case 'click': return {
      op: 'click',
      ref: requiredRef(f),
      element: str(f, 'element', MAX_ELEMENT),
      button: choice(f, 'button', ['left', 'right', 'middle'], 'left'),
      doubleClick: flag(f, 'doubleClick', false)
    }
    case 'type': return {
      op: 'type',
      ref: requiredRef(f),
      element: str(f, 'element', MAX_ELEMENT),
      text: str(f, 'text', MAX_TEXT, 0),
      submit: flag(f, 'submit', false),
      slowly: flag(f, 'slowly', false)
    }
    case 'press_key': return { op: 'press_key', key: str(f, 'key', MAX_KEY) }
    case 'hover': return { op: 'hover', ref: requiredRef(f), element: str(f, 'element', MAX_ELEMENT) }
    case 'select_option': return { op: 'select_option', ref: requiredRef(f), element: str(f, 'element', MAX_ELEMENT), values: values(f) }
    case 'scroll': return {
      op: 'scroll',
      ref: optionalRef(f),
      direction: choice(f, 'direction', ['up', 'down', 'left', 'right']),
      amount: integer(f, 'amount', 1, MAX_SCROLL, DEFAULT_SCROLL)
    }
    case 'wait_for': {
      const text = optStr(f, 'text', MAX_TEXT)
      const textGone = optStr(f, 'textGone', MAX_TEXT)
      const time = seconds(f)
      if (text === null && textGone === null && time === null) refuse('wait_for needs text, textGone or time')
      return { op: 'wait_for', text, textGone, time }
    }
    case 'screenshot': return { op: 'screenshot', fullPage: flag(f, 'fullPage', false), ref: optionalRef(f) }
    case 'evaluate': return { op: 'evaluate', function: str(f, 'function', MAX_FUNCTION), ref: optionalRef(f) }
    case 'console': return { op: 'console', onlyErrors: flag(f, 'onlyErrors', false) }
    case 'network': return { op: 'network' }
    case 'network_request': {
      const id = str(f, 'id', 16)
      if (!REQUEST_ID_RE.test(id)) refuse('id must be a request id such as r3')
      return { op: 'network_request', id }
    }
    case 'handle_dialog': return { op: 'handle_dialog', accept: flag(f, 'accept'), promptText: optStr(f, 'promptText', MAX_TEXT, 0) }
    case 'tabs': {
      const action = choice(f, 'action', ['list', 'new', 'select', 'close'])
      // list takes no index or url; new takes an optional url; select and close need the index of a tab
      const index = action === 'select' || action === 'close' ? integer(f, 'index', 0, Number.MAX_SAFE_INTEGER) : null
      const url = action === 'new' ? optStr(f, 'url', MAX_URL) : null
      return { op: 'tabs', action, index, url }
    }
    default: refuse(`unknown browser op: ${String(f.op)}`)
  }
}

/** a browser command as Claude sends it: the op and its fields; absent optional fields take their defaults, a bad field is refused by name */
export function parseBrowserCommand(v: unknown): ParsedBrowserCommand {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: 'command must be an object' }
  try {
    return { ok: true, command: command(v as Fields) }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: e.message }
    throw e
  }
}

export const DEFAULT_PROFILE_ID = 'default'
export const PROFILE_ID_RE = /^(default|[a-z0-9]{8})$/
export const MAX_PROFILE_NAME = 40
/** a character a profile's name never has: control characters, and the bidi overrides and isolates that disguise a name */
export const UNSAFE_PROFILE_NAME = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/
export const partitionOf = (profileId: string): string => `persist:browser-${profileId}`
export type SiteAnswer = 'tab' | 'always' | 'deny'
/** the card asks about a site, or about a local file outside the tab's folder (`file`: its path; the panel offers no Always allow for it) */
export interface SiteCard { id: string; site: string; kind: 'open' | 'use'; file: boolean }
export type BrowserControl = 'idle' | 'claude' | 'person'
export interface BrowserPageView { url: string; title: string; loading: boolean }
export interface BrowserPanelState { tabId: string; profileId: string; profiles: { id: string; name: string }[]; pages: BrowserPageView[]; current: number | null; control: BrowserControl; card: SiteCard | null; canBack: boolean; canForward: boolean; devtools: boolean }
export type BrowserPanelAction =
  | { type: 'navigate'; url: string } | { type: 'back' } | { type: 'forward' } | { type: 'reload' } | { type: 'stopLoading' }
  | { type: 'newPage' } | { type: 'selectPage'; index: number } | { type: 'closePage'; index: number }
  | { type: 'setProfile'; profileId: string } | { type: 'stop' } | { type: 'handBack' }
  | { type: 'answer'; cardId: string; answer: SiteAnswer } | { type: 'devtools' } | { type: 'manageProfiles' } | { type: 'clearData' }
export interface BrowserProfileView { id: string; name: string; allowed: string[]; allowAll: boolean }
export interface BrowserProfilesView { profiles: BrowserProfileView[]; defaultId: string }
export type BrowserProfileAction =
  | { type: 'add'; name: string } | { type: 'rename'; id: string; name: string } | { type: 'remove'; id: string }
  | { type: 'setDefault'; id: string } | { type: 'disallow'; id: string; site: string } | { type: 'clearData'; id: string }
  | { type: 'allowAll'; id: string; on: boolean }
export interface BrowserTabState { profile: string; pages: string[]; current: number }

/** the saved state of a Claude tab's browser: its profile and pages; pages that are no web page are dropped, at most MAX_PAGES are kept, current is kept in range; null for a bad profile id or no object */
export function parseBrowserTabState(v: unknown): BrowserTabState | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const m = v as Fields
  if (typeof m.profile !== 'string' || !PROFILE_ID_RE.test(m.profile)) return null
  const raw: unknown[] = Array.isArray(m.pages) ? m.pages : []
  const pages = raw.filter((p): p is string => typeof p === 'string' && isWebUrl(p)).slice(0, MAX_PAGES)
  const wanted = typeof m.current === 'number' && Number.isFinite(m.current) ? Math.trunc(m.current) : 0
  return { profile: m.profile, pages, current: Math.min(Math.max(wanted, 0), Math.max(pages.length - 1, 0)) }
}

export interface ImportSourceView { id: string; label: string; available: boolean }
export type ImportStatus =
  | { state: 'idle' } | { state: 'waiting-close'; browser: string } | { state: 'importing' }
  | { state: 'setup'; browser: string } | { state: 'allow'; browser: string }
  | { state: 'pick-profile'; browser: string; profiles: { contextId: string; label: string }[] }
  | { state: 'done'; imported: number; sites: number; skipped: number; notes: string[] }
  | { state: 'failed'; error: string } | { state: 'cancelled'; imported?: number }
