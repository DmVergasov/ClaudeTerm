import { isEditingKey, mapKey, type KeyAction, type KeyLike } from '../../shared/keymap'

/** the zoom keys are the page's own on a web app (a map, a diagram editor): the page keeps them, the window still zooms on them */
const ZOOM_KEYS: ReadonlySet<KeyAction['type']> = new Set(['zoomIn', 'zoomOut', 'zoomReset'])

/** what before-input-event tells of a key: the key, its code and the modifiers, as Electron's Input has them */
export interface PageKeyInput {
  type: string
  key: string
  code: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/**
 * The app's own shortcut that a key pressed in a Browser page stands for, or null when the page keeps the key. A key
 * going up is never a shortcut here. The key itself is never logged.
 */
export function appKeyFor(input: PageKeyInput, platform: string): KeyAction | null {
  if (input.type !== 'keyDown') return null
  // Windows reports AltGr as Ctrl+Alt: a character it types (AltGr+2 is @ on a Spanish layout) or a dead key that starts one is the page's; a digit is still a tab switch
  if (input.control && input.alt && (input.key === 'Dead' || ([...input.key].length === 1 && !/^\d$/.test(input.key)))) return null
  const e: KeyLike = {
    type: 'keydown',
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    metaKey: input.meta
  }
  const action = mapKey(e, platform)
  if (action === null || isEditingKey(action) || ZOOM_KEYS.has(action.type)) return null
  return action
}
