import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applySettingEdit } from './settings'

/** the marker in the data folder: its presence means the switch to Graphite was already considered on this install */
export const LOOK_MARKER = 'look-graphite.json'

/** settings.json text after the one-time switch: theme "Campbell" → "Graphite"; null when nothing changes */
export function graphiteEdit(text: string | null): string | null {
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if ((raw as Record<string, unknown>).theme !== 'Campbell') return null
  const edit = applySettingEdit(text, 'theme', 'Graphite')
  if (!edit.ok) return null
  // applySettingEdit always writes LF; the file keeps the line endings it had
  return text.includes('\r\n') ? edit.text.replace(/\n/g, '\r\n') : edit.text
}

/** once per install: applies graphiteEdit to <dataDir>/settings.json when the marker is missing, then writes the marker; never throws */
export function migrateLook(dataDir: string, onError?: (message: string) => void): void {
  try {
    const marker = join(dataDir, LOOK_MARKER)
    if (existsSync(marker)) return
    const path = join(dataDir, 'settings.json')
    if (existsSync(path)) {
      const next = graphiteEdit(readFileSync(path, 'utf8'))
      if (next !== null) {
        // through a temporary file renamed over settings.json: a crash mid-write leaves the old settings, never a cut-off file
        const tmp = `${path}.tmp`
        try {
          rmSync(tmp, { force: true })
          writeFileSync(tmp, next, 'utf8')
          renameSync(tmp, path)
        } catch (e) {
          // a temporary file left behind would be taken for the settings at the next start: it goes, then the error is reported
          try {
            rmSync(tmp, { force: true })
          } catch {
            // nothing more to do
          }
          throw e
        }
      }
    }
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(marker, JSON.stringify({ graphite: true }), 'utf8')
  } catch (e) {
    onError?.(`cannot switch the theme to Graphite: ${(e as Error).message}`)
  }
}
