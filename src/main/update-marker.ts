import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Written right before restarting into an update, so the next start reopens the tabs by itself. */
export const UPDATE_MARKER = 'update-restart.json'
export const MARKER_MAX_AGE_MS = 10 * 60 * 1000

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
  return typeof at === 'number' && now >= at && now - at <= MARKER_MAX_AGE_MS
}
