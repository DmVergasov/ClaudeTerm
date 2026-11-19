/** One `Input.dispatchKeyEvent` call */
export interface KeyEvent {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  modifiers: number
  text?: string
}

interface Modifier { bit: number; key: string; code: string; vk: number }
interface KeyPart { key: string; code: string; vk: number; text?: string }

const ALT = 1
const CONTROL = 2
const META = 4
const SHIFT = 8

const MODIFIERS = new Map<string, Modifier>([
  ['Alt', { bit: ALT, key: 'Alt', code: 'AltLeft', vk: 18 }],
  ['Control', { bit: CONTROL, key: 'Control', code: 'ControlLeft', vk: 17 }],
  ['Ctrl', { bit: CONTROL, key: 'Control', code: 'ControlLeft', vk: 17 }],
  ['Meta', { bit: META, key: 'Meta', code: 'MetaLeft', vk: 91 }],
  ['Command', { bit: META, key: 'Meta', code: 'MetaLeft', vk: 91 }],
  ['Shift', { bit: SHIFT, key: 'Shift', code: 'ShiftLeft', vk: 16 }],
])

const NAMED = new Map<string, KeyPart>([
  ['Enter', { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }],
  ['Tab', { key: 'Tab', code: 'Tab', vk: 9 }],
  ['Escape', { key: 'Escape', code: 'Escape', vk: 27 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', vk: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', vk: 46 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }],
  ['Home', { key: 'Home', code: 'Home', vk: 36 }],
  ['End', { key: 'End', code: 'End', vk: 35 }],
  ['PageUp', { key: 'PageUp', code: 'PageUp', vk: 33 }],
  ['PageDown', { key: 'PageDown', code: 'PageDown', vk: 34 }],
  ['Space', { key: ' ', code: 'Space', vk: 32, text: ' ' }],
])
for (let n = 1; n <= 12; n++) NAMED.set(`F${n}`, { key: `F${n}`, code: `F${n}`, vk: 111 + n })

function mainKey(token: string): KeyPart | null {
  const named = NAMED.get(token)
  if (named) return named
  const chars = Array.from(token)
  if (chars.length !== 1) return null
  const ch = chars[0]
  if (/^[a-zA-Z]$/.test(ch)) {
    const upper = ch.toUpperCase()
    return { key: ch, code: `Key${upper}`, vk: upper.charCodeAt(0), text: ch }
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch }
  return { key: ch, code: '', vk: ch.charCodeAt(0), text: ch }
}

/**
 * The events that press a key combo such as `Enter`, `Control+a` or `Shift+Tab`:
 * each modifier down, the main key down (with text when it is printable and no
 * Control, Alt or Meta is held), its up, then the modifiers up in reverse order.
 * Null when a name is unknown.
 */
export function keyEvents(combo: string): KeyEvent[] | null {
  const tokens = combo.split('+')
  const main = tokens.pop() ?? ''
  const pressed: Modifier[] = []
  for (const token of tokens) {
    const mod = MODIFIERS.get(token)
    if (!mod) return null
    pressed.push(mod)
  }

  let key: KeyPart | null = null
  const modifierKey = MODIFIERS.get(main)
  if (modifierKey) pressed.push(modifierKey)
  else {
    key = mainKey(main)
    if (!key) return null
  }

  const events: KeyEvent[] = []
  let held = 0
  for (const mod of pressed) {
    held |= mod.bit
    events.push({ type: 'keyDown', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk, modifiers: held })
  }
  if (key) {
    const withText = key.text !== undefined && (held & (CONTROL | ALT | META)) === 0
    const down: KeyEvent = { type: withText ? 'keyDown' : 'rawKeyDown', key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, modifiers: held }
    if (withText) down.text = key.text
    events.push(down)
    events.push({ type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, modifiers: held })
  }
  for (let i = pressed.length - 1; i >= 0; i--) {
    held &= ~pressed[i].bit
    events.push({ type: 'keyUp', key: pressed[i].key, code: pressed[i].code, windowsVirtualKeyCode: pressed[i].vk, modifiers: held })
  }
  return events
}
