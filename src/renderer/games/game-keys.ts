import { mapKey, type KeyLike } from '../keymap'

/**
 * What the game window does with a key: 'drop' (a held key's repeat), 'tab' (Esc gives the keyboard back), 'pass' (an app
 * shortcut the document handler runs, or a macOS ⌘ chord the menu takes), 'resume' (Space while paused), or 'game' (the
 * game's key; the window drops whatever the game does not handle)
 */
export type GameKeyRoute = 'drop' | 'tab' | 'pass' | 'resume' | 'game'

/** the actions the document handler leaves alone (the terminal or the chat takes them): the window routes them as game keys */
const LEFT_TO_THE_TAB = new Set(['send', 'copyOrInterrupt', 'smartPaste', 'paste', 'copy'])

export function gameKeyRoute(e: KeyLike & { repeat: boolean }, platform: string, paused: boolean): GameKeyRoute {
  if (e.repeat) return 'drop'
  if (e.code === 'Escape') return 'tab'
  const action = mapKey(e, platform)
  if (action !== null && !LEFT_TO_THE_TAB.has(action.type)) return 'pass'
  // the page gets a key before the macOS menu does (src/main/mac-menu.ts): a ⌘ chord the app does not use is passed on, so the
  // menu's ⌘Q, ⌘H, ⌘M and Edit items run
  if (action === null && platform === 'darwin' && e.metaKey) return 'pass'
  if (paused && e.type === 'keydown' && e.code === 'Space') return 'resume'
  return 'game'
}
