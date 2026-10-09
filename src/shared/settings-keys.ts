import { MAX_TEST_PATTERNS, MAX_TEST_PATTERN_LENGTH } from './test-files'
import type { NotificationCase, NotificationChannels } from './types'

// The settings vocabulary shared by the main process (parsing, editing) and the settings window.

export const NOTIFICATION_CASES: readonly NotificationCase[] = ['permission', 'question', 'done', 'bell']
export const NOTIFICATION_CHANNELS: readonly (keyof NotificationChannels)[] = ['sound', 'flash', 'tab']

/** number ranges the parser and the settings window both check */
export const NUMBER_LIMITS = {
  'font.size': { min: 6, max: 72 },
  scrollback: { min: 0, max: 1_000_000 }
} as const

/** the settings the settings window edits */
export type SettingKey =
  | `notifications.${NotificationCase}.${keyof NotificationChannels}`
  | 'notifications.sound'
  | 'font.family' | 'font.size' | 'theme' | 'scrollback'
  | 'defaultProfile' | 'claude.command' | 'claude.shellProfile'
  | 'imageWatch.enabled' | 'imagePanel.autoOpen' | 'autoUpdate'
  | 'review.editor' | 'review.statusBar' | 'review.hideIgnored' | 'review.hideTests' | 'review.testPatterns'

export type SettingValue = string | number | boolean | null | string[]

export const SETTING_KEYS: readonly SettingKey[] = [
  ...NOTIFICATION_CASES.flatMap((c) => NOTIFICATION_CHANNELS.map((ch) => `notifications.${c}.${ch}` as const)),
  'notifications.sound',
  'font.family', 'font.size', 'theme', 'scrollback',
  'defaultProfile', 'claude.command', 'claude.shellProfile',
  'imageWatch.enabled', 'imagePanel.autoOpen', 'review.editor', 'review.statusBar', 'review.hideIgnored', 'review.hideTests', 'review.testPatterns', 'autoUpdate'
]

export const isSettingKey = (v: unknown): v is SettingKey => typeof v === 'string' && (SETTING_KEYS as readonly string[]).includes(v)

export const isSettingValue = (v: unknown): v is SettingValue =>
  (Array.isArray(v) && v.length <= MAX_TEST_PATTERNS && v.every((x) => typeof x === 'string' && x.length <= MAX_TEST_PATTERN_LENGTH)) || v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
