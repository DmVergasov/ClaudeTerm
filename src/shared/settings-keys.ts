import type { NotificationCase, NotificationChannels } from './types'

// The settings vocabulary shared by the main process (parsing, editing) and the settings window.

export const NOTIFICATION_CASES: readonly NotificationCase[] = ['permission', 'question', 'done', 'bell']
export const NOTIFICATION_CHANNELS: readonly (keyof NotificationChannels)[] = ['sound', 'flash', 'tab']
