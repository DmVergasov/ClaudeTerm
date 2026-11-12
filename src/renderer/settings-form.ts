import { NUMBER_LIMITS } from '../shared/settings-keys'
import { MAX_TEST_PATTERNS, MAX_TEST_PATTERN_LENGTH } from '../shared/test-files'
import type { Settings } from '../shared/types'
import { resolveTheme, THEMES } from './themes'

// What the settings window shows and accepts, kept apart from the DOM.

export interface Option { value: string; label: string }
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** the select value for a null profile (profile names are never empty) */
export const AUTOMATIC = ''
/** the select value for a theme object from settings.json */
export const CUSTOM_THEME = '\u0000custom'

export function checkNumber(key: keyof typeof NUMBER_LIMITS, text: string): Checked<number> {
  const { min, max } = NUMBER_LIMITS[key]
  const whole = key === 'scrollback' || key === 'claude.statusRefreshInterval'
  const n = Number(text.trim())
  const ok = text.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!whole || Number.isInteger(n))
  if (ok) return { ok: true, value: n }
  return { ok: false, error: whole ? `A whole number between ${min} and ${max}` : `Between ${min} and ${max}` }
}

export function checkText(text: string): Checked<string> {
  const v = text.trim()
  return v === '' ? { ok: false, error: 'Cannot be empty' } : { ok: true, value: v }
}

/** text that may be left empty: empty means null (the automatic choice) */
export function checkOptionalText(text: string): Checked<string | null> {
  const v = text.trim()
  return { ok: true, value: v === '' ? null : v }
}

/** a list of patterns, one per line: blank lines are dropped, an empty field is an empty list */
export function checkPatterns(text: string): Checked<string[]> {
  const list = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (list.length > MAX_TEST_PATTERNS) return { ok: false, error: `At most ${MAX_TEST_PATTERNS} patterns` }
  if (list.some((l) => l.length > MAX_TEST_PATTERN_LENGTH)) return { ok: false, error: `A pattern is longer than ${MAX_TEST_PATTERN_LENGTH} characters` }
  return { ok: true, value: list }
}

const plain = (names: string[]): Option[] => names.map((n) => ({ value: n, label: n }))

/** one card of the theme picker: the four colors a card shows, and whether it can be picked */
export interface ThemeChoice {
  value: string
  title: string
  note: string | null
  colors: { background: string; foreground: string; green: string; cursor: string }
  selectable: boolean
  selected: boolean
}

/** the note under each built-in theme's card */
const THEME_NOTES: Record<string, string> = {
  Graphite: "ClaudeTerm's own, in the window's colors",
  Campbell: "Windows Terminal's default",
  'One Half Dark': 'Soft contrast on slate',
  'One Half Light': 'A light terminal in the dark window'
}

function cardColors(t: { background?: string; foreground?: string; green?: string; cursor?: string }): ThemeChoice['colors'] {
  const foreground = t.foreground ?? '#FFFFFF'
  return { background: t.background ?? '#000000', foreground, green: t.green ?? foreground, cursor: t.cursor ?? foreground }
}

/** the theme cards: one per built-in theme, then a card for a theme object or a name that is not built in, chosen and not selectable */
export function themeChoices(theme: Settings['theme']): ThemeChoice[] {
  const names = Object.keys(THEMES)
  const built: ThemeChoice[] = names.map((name) => ({
    value: name,
    title: name,
    note: THEME_NOTES[name] ?? null,
    colors: cardColors(THEMES[name]),
    selectable: true,
    selected: theme === name
  }))
  if (typeof theme !== 'string') {
    return [...built, { value: CUSTOM_THEME, title: 'Custom (settings.json)', note: 'Your own colors from settings.json', colors: cardColors(resolveTheme(theme)), selectable: false, selected: true }]
  }
  if (names.includes(theme)) return built
  return [...built, { value: theme, title: `${theme} (not found)`, note: "Not one of ClaudeTerm's themes: Graphite is used", colors: cardColors(THEMES.Graphite), selectable: false, selected: true }]
}

export function profileOptions(names: string[], current: string | null): { options: Option[]; selected: string } {
  const extra = current !== null && !names.includes(current) ? [{ value: current, label: `${current} (not found)` }] : []
  return { options: [{ value: AUTOMATIC, label: 'Automatic' }, ...plain(names), ...extra], selected: current ?? AUTOMATIC }
}

export const profileValue = (v: string): string | null => (v === AUTOMATIC ? null : v)

export function soundChoice(sound: string): { custom: boolean; path: string } {
  return sound === 'system' ? { custom: false, path: '' } : { custom: true, path: sound }
}
