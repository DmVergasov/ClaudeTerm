import { DEVICE_PLATFORMS, MAX_ADDRESS_LENGTH, MAX_DEVICE_NAME, type DevicePlatform } from '../../shared/devices'
import { isNoteSize, MAX_NOTE_LENGTH, NOTE_FORMS, NOTE_SIDES, type Note } from '../../shared/note'
import { isUuid } from '../../shared/protocol'
import { compareStamps } from './clock'
import type { Collection, KeyState, Sibling } from './replica'

const MAX_ADDRESSES = 16

/** Whether a sibling is a star: the latest write decides; no write means not starred. */
export function starOf(s?: KeyState): boolean {
  return ordered(s, true)[0]?.value === true
}

/**
 * The note a conversation shows: the live texts (not removed, not blank, equal ones once) from
 * the latest write to the earliest, joined by an empty line; the view comes from the latest write.
 */
export function noteOf(s?: KeyState): Note | null {
  const live = ordered(s, true).filter((x) => x.value !== null)
  if (live.length === 0) return null
  const texts: string[] = []
  for (const x of live) {
    const text = (x.value as Note).text
    if (text.trim().length > 0 && !texts.includes(text)) texts.push(text)
  }
  if (texts.length === 0) return null
  const latest = live[0].value as Note
  const note: Note = { text: texts.join('\n\n').slice(0, MAX_NOTE_LENGTH), shown: latest.shown, form: latest.form }
  if (NOTE_SIDES.some((s) => s === latest.side)) note.side = latest.side
  const size = latest.size
  if (isNoteSize(size)) note.size = { width: size.width, height: size.height }
  return note
}

export interface Admission {
  fingerprint: string
  addedBy: string
  addedAt: number
}

/** The admission of a device: the earliest one recorded for it. */
export function admissionOf(s?: KeyState): Admission | null {
  const first = ordered(s, false)[0]
  return first ? (first.value as Admission) : null
}

export interface Removal {
  by: string
  at: number
}

/** A device is removed once any device has recorded its removal. */
export function isRemoved(s?: KeyState): boolean {
  return !!s && s.siblings.some((x) => x.value !== null)
}

/** The earliest removal recorded for a device. */
export function removalOf(s?: KeyState): Removal | null {
  const first = ordered(s, false).find((x) => x.value !== null)
  return first ? (first.value as Removal) : null
}

export interface SelfDescription {
  name: string
  platform: DevicePlatform
  addresses: string[]
  port: number
}

/** A device's own description of itself: the latest one written. */
export function memberOf(s?: KeyState): SelfDescription | null {
  const latest = ordered(s, true)[0]
  return latest && latest.value !== null ? (latest.value as SelfDescription) : null
}

/**
 * Whether a sibling may be stored under a key in a collection. Everything from the network goes
 * through this: a device may describe only itself, and every value must have the shape its collection needs.
 */
export function validSibling(col: Collection, key: string, s: Sibling): boolean {
  if (!isPlainObject(s) || !isUuid(key)) return false
  if (!Array.isArray(s.dot) || s.dot.length !== 2 || !isUuid(s.dot[0]) || !isPositiveSafeInteger(s.dot[1])) return false
  if (!isPlainObject(s.at) || !isNonNegativeSafeInteger(s.at.t) || !isNonNegativeSafeInteger(s.at.c)) return false
  return validValue(col, key, s.dot[0], s.value)
}

function validValue(col: Collection, key: string, by: string, value: unknown): boolean {
  switch (col) {
    case 'stars':
      return typeof value === 'boolean'
    case 'notes':
      return value === null || validNote(value)
    case 'members':
      return by === key && validDescription(value)
    case 'admitted':
      return (
        isPlainObject(value) &&
        typeof value.fingerprint === 'string' &&
        /^[0-9a-f]{64}$/.test(value.fingerprint) &&
        isUuid(value.addedBy) &&
        Number.isSafeInteger(value.addedAt)
      )
    case 'removed':
      return isPlainObject(value) && isUuid(value.by) && Number.isSafeInteger(value.at)
    default:
      return false
  }
}

function validNote(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_NOTE_LENGTH &&
    typeof value.shown === 'boolean' &&
    NOTE_FORMS.some((f) => f === value.form)
  )
}

function validDescription(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const { name, platform, addresses, port } = value
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= MAX_DEVICE_NAME &&
    DEVICE_PLATFORMS.some((p) => p === platform) &&
    Array.isArray(addresses) &&
    addresses.length <= MAX_ADDRESSES &&
    addresses.every((a) => typeof a === 'string' && a.length >= 1 && a.length <= MAX_ADDRESS_LENGTH) &&
    Number.isInteger(port) &&
    (port as number) >= 1 &&
    (port as number) <= 65535
  )
}

/** The siblings of a state, sorted by stamp (the device id breaks ties); the latest first when asked. */
function ordered(s: KeyState | undefined, latestFirst: boolean): Sibling[] {
  const sorted = [...(s?.siblings ?? [])].sort((x, y) => compareStamps(x.at, x.dot[0], y.at, y.dot[0]))
  return latestFirst ? sorted.reverse() : sorted
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPositiveSafeInteger(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) > 0
}

function isNonNegativeSafeInteger(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0
}
