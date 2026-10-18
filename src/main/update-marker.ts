import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Written right before restarting into an update, so the next start reopens the tabs by itself. */
export const UPDATE_MARKER = 'update-restart.json'
export const MARKER_MAX_AGE_MS = 10 * 60 * 1000
/** How far ahead of now a marker may be: the clock can be stepped back between quit and restart (WSL, NTP) */
export const MARKER_CLOCK_SLACK_MS = 60 * 1000

export function writeUpdateMarker(dir: string, now: number): boolean {
  try {
    writeFileSync(join(dir, UPDATE_MARKER), JSON.stringify({ at: now }))
    return true
  } catch {
    return false
  }
}

/** True when the previous run restarted into an update a moment ago. The marker is removed either way. */
export function consumeUpdateMarker(dir: string, now: number): boolean {
  const path = join(dir, UPDATE_MARKER)
  let at: unknown = null
  try {
    at = (JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown }).at
  } catch {
    // no marker, or an unreadable one
  }
  try {
    rmSync(path, { force: true })
  } catch {
    // a marker we cannot delete is ignored next time by its age
  }
  return typeof at === 'number' && now - at >= -MARKER_CLOCK_SLACK_MS && now - at <= MARKER_MAX_AGE_MS
}

/** Written by the macOS swap script with the version it could not install (see mac-update.ts) */
export const FAILED_UPDATE = 'update-failed.txt'

/** The version the last swap could not install, or null. The file is removed either way. */
export function consumeFailedUpdate(dir: string): string | null {
  const path = join(dir, FAILED_UPDATE)
  let text = ''
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
  try {
    rmSync(path, { force: true })
  } catch {
    // read again next time: the version is then offered on its release page once more
  }
  return /^\d+\.\d+\.\d+$/.test(text) ? text : null
}
