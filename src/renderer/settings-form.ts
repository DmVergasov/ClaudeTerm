import { NUMBER_LIMITS } from '../shared/settings-keys'
import type { Settings } from '../shared/types'
import { THEMES } from './themes'

// What the settings window shows and accepts, kept apart from the DOM.

export interface Option { value: string; label: string }
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** the select value for a null profile (profile names are never empty) */
export const AUTOMATIC = ''
/** the select value for a theme object from settings.json */
export const CUSTOM_THEME = '\u0000custom'

export function checkNumber(key: keyof typeof NUMBER_LIMITS, text: string): Checked<number> {
  const { min, max } = NUMBER_LIMITS[key]
  const whole = key === 'scrollback'
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

const plain = (names: string[]): Option[] => names.map((n) => ({ value: n, label: n }))

export function themeOptions(theme: Settings['theme']): { options: Option[]; selected: string } {
  const names = Object.keys(THEMES)
  if (typeof theme !== 'string') return { options: [...plain(names), { value: CUSTOM_THEME, label: 'Custom (settings.json)' }], selected: CUSTOM_THEME }
  const extra = names.includes(theme) ? [] : [{ value: theme, label: `${theme} (not found)` }]
  return { options: [...plain(names), ...extra], selected: theme }
}

export function profileOptions(names: string[], current: string | null): { options: Option[]; selected: string } {
  const extra = current !== null && !names.includes(current) ? [{ value: current, label: `${current} (not found)` }] : []
  return { options: [{ value: AUTOMATIC, label: 'Automatic' }, ...plain(names), ...extra], selected: current ?? AUTOMATIC }
}

export const profileValue = (v: string): string | null => (v === AUTOMATIC ? null : v)

export function soundChoice(sound: string): { custom: boolean; path: string } {
  return sound === 'system' ? { custom: false, path: '' } : { custom: true, path: sound }
}
