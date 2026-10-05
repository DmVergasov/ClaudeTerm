import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProfileDef, Settings } from '../shared/types'

export const DEFAULT_SETTINGS: Settings = {
  defaultProfile: null,
  claude: { command: 'claude', shellProfile: null },
  profiles: [],
  font: { family: 'Cascadia Mono, Consolas, monospace', size: 12 },
  theme: 'Campbell',
  scrollback: 10000,
  imageWatch: {
    enabled: true,
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    ignore: ['.git', 'node_modules', 'Intermediate', 'DerivedDataCache', 'Binaries', '.vs', '.idea'],
    maxDepth: 8
  },
  imagePanel: { autoOpen: true, width: 320, maxItems: 200 }
}

export interface ParsedSettings {
  settings: Settings
  errors: string[]
  /** true when the file could not be read at all (settings are then the defaults) */
  failed?: boolean
}

type Guard<T> = (v: unknown) => v is T
interface RawProfile { name: string; command: string; args?: string[] }

const isStr: Guard<string> = (v): v is string => typeof v === 'string' && v.length > 0
const isNullableStr: Guard<string | null> = (v): v is string | null => v === null || isStr(v)
const isBool: Guard<boolean> = (v): v is boolean => typeof v === 'boolean'
const isStrArr: Guard<string[]> = (v): v is string[] => Array.isArray(v) && v.every(isStr)
const numIn = (min: number, max: number): Guard<number> => (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTheme: Guard<Settings['theme']> = (v): v is Settings['theme'] => isStr(v) || (isPlainObj(v) && Object.values(v).every((x) => typeof x === 'string'))
const isProfiles: Guard<RawProfile[]> = (v): v is RawProfile[] =>
  Array.isArray(v) && v.every((p) => isPlainObj(p) && isStr(p.name) && isStr(p.command) && (p.args === undefined || isStrArr(p.args)))

export function parseSettings(text: string | null): ParsedSettings {
  const d = structuredClone(DEFAULT_SETTINGS)
  if (text === null || text.trim() === '') return { settings: d, errors: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { settings: d, errors: [`settings.json: ${(e as Error).message}`] }
  }
  if (!isPlainObj(raw)) return { settings: d, errors: ['settings.json: root must be an object'] }

  const errors: string[] = []
  const take = <T>(key: string, value: unknown, ok: Guard<T>, fallback: T): T => {
    if (value === undefined) return fallback
    if (ok(value)) return value
    errors.push(`settings.json: invalid value for "${key}", using default`)
    return fallback
  }
  const obj = (v: unknown): Record<string, unknown> => (isPlainObj(v) ? v : {})
  const claude = obj(raw.claude)
  const font = obj(raw.font)
  const iw = obj(raw.imageWatch)
  const ip = obj(raw.imagePanel)

  const profiles: ProfileDef[] = take('profiles', raw.profiles, isProfiles, []).map((p) => ({ name: p.name, command: p.command, args: p.args ?? [] }))

  const settings: Settings = {
    defaultProfile: take('defaultProfile', raw.defaultProfile, isNullableStr, d.defaultProfile),
    claude: {
      command: take('claude.command', claude.command, isStr, d.claude.command),
      shellProfile: take('claude.shellProfile', claude.shellProfile, isNullableStr, d.claude.shellProfile)
    },
    profiles,
    font: {
      family: take('font.family', font.family, isStr, d.font.family),
      size: take('font.size', font.size, numIn(6, 72), d.font.size)
    },
    theme: take('theme', raw.theme, isTheme, d.theme),
    scrollback: take('scrollback', raw.scrollback, numIn(0, 1_000_000), d.scrollback),
    imageWatch: {
      enabled: take('imageWatch.enabled', iw.enabled, isBool, d.imageWatch.enabled),
      extensions: take('imageWatch.extensions', iw.extensions, isStrArr, d.imageWatch.extensions),
      ignore: take('imageWatch.ignore', iw.ignore, isStrArr, d.imageWatch.ignore),
      maxDepth: take('imageWatch.maxDepth', iw.maxDepth, numIn(0, 64), d.imageWatch.maxDepth)
    },
    imagePanel: {
      autoOpen: take('imagePanel.autoOpen', ip.autoOpen, isBool, d.imagePanel.autoOpen),
      width: take('imagePanel.width', ip.width, numIn(120, 4000), d.imagePanel.width),
      maxItems: take('imagePanel.maxItems', ip.maxItems, numIn(1, 10_000), d.imagePanel.maxItems)
    }
  }
  return { settings, errors }
}

export function loadSettingsSafe(path: string): ParsedSettings {
  try {
    return loadSettingsFile(path)
  } catch (e) {
    return { settings: structuredClone(DEFAULT_SETTINGS), errors: [`Cannot read settings.json: ${(e as Error).message}; using defaults`], failed: true }
  }
}

export function loadSettingsFile(path: string): ParsedSettings {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8')
    return { settings: structuredClone(DEFAULT_SETTINGS), errors: [] }
  }
  return parseSettings(readFileSync(path, 'utf8').replace(/^﻿/, ''))
}
