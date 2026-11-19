import { describe, expect, it } from 'vitest'
import { appKeyFor, type PageKeyInput } from '../../src/main/browser/app-keys'

// a key of a Browser page as before-input-event reports it: Electron's Input, of which the shortcuts read the key, the code and the modifiers
function key(code: string, key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}, type = 'keyDown'): PageKeyInput {
  return { type, key, code, control: mods.ctrl ?? false, shift: mods.shift ?? false, alt: mods.alt ?? false, meta: mods.meta ?? false }
}

describe('appKeyFor: the keys of a Browser page that the window runs', () => {
  it('Ctrl+Shift+B toggles the Browser panel on Windows and Linux', () => {
    expect(appKeyFor(key('KeyB', 'B', { ctrl: true, shift: true }), 'win32')).toEqual({ type: 'toggleBrowser' })
    expect(appKeyFor(key('KeyB', 'B', { ctrl: true, shift: true }), 'linux')).toEqual({ type: 'toggleBrowser' })
  })

  it('⌘B toggles the Browser panel on macOS', () => {
    expect(appKeyFor(key('KeyB', 'b', { meta: true }), 'darwin')).toEqual({ type: 'toggleBrowser' })
  })

  it('Ctrl+Tab goes to the next tab, Ctrl+Shift+Tab to the previous one', () => {
    expect(appKeyFor(key('Tab', 'Tab', { ctrl: true }), 'win32')).toEqual({ type: 'nextTab' })
    expect(appKeyFor(key('Tab', 'Tab', { ctrl: true, shift: true }), 'win32')).toEqual({ type: 'prevTab' })
  })

  it('Ctrl+Shift+T opens a new tab', () => {
    expect(appKeyFor(key('KeyT', 'T', { ctrl: true, shift: true }), 'win32')).toEqual({ type: 'newTab' })
  })

  it('Ctrl+Alt+2 switches to the second tab', () => {
    expect(appKeyFor(key('Digit2', '2', { ctrl: true, alt: true }), 'win32')).toEqual({ type: 'gotoTab', index: 1 })
  })

  it('a plain letter, a plain Enter and a key with no shortcut go to the page', () => {
    expect(appKeyFor(key('KeyA', 'a'), 'win32')).toBeNull()
    expect(appKeyFor(key('Enter', 'Enter'), 'win32')).toBeNull()
    expect(appKeyFor(key('KeyZ', 'z', { ctrl: true }), 'win32')).toBeNull()
  })

  it('only a key going down is an app shortcut: a key coming up is left to the page', () => {
    expect(appKeyFor(key('KeyB', 'B', { ctrl: true, shift: true }, 'keyUp'), 'win32')).toBeNull()
  })

  // the page keeps its own editing keys: copy, paste and Enter-send
  it('Ctrl+C and Ctrl+V stay with the page', () => {
    expect(appKeyFor(key('KeyC', 'c', { ctrl: true }), 'win32')).toBeNull()
    expect(appKeyFor(key('KeyV', 'v', { ctrl: true }), 'win32')).toBeNull()
  })

  it('Ctrl+Shift+C and Ctrl+Shift+V stay with the page on Windows', () => {
    expect(appKeyFor(key('KeyC', 'C', { ctrl: true, shift: true }), 'win32')).toBeNull()
    expect(appKeyFor(key('KeyV', 'V', { ctrl: true, shift: true }), 'win32')).toBeNull()
  })

  it('⌘C, ⌘V and ⌘⇧V stay with the page on macOS', () => {
    expect(appKeyFor(key('KeyC', 'c', { meta: true }), 'darwin')).toBeNull()
    expect(appKeyFor(key('KeyV', 'v', { meta: true }), 'darwin')).toBeNull()
    expect(appKeyFor(key('KeyV', 'V', { meta: true, shift: true }), 'darwin')).toBeNull()
  })

  it('Shift+Enter sends to the terminal, so the page keeps it, on Windows and macOS', () => {
    expect(appKeyFor(key('Enter', 'Enter', { shift: true }), 'win32')).toBeNull()
    expect(appKeyFor(key('Enter', 'Enter', { shift: true }), 'darwin')).toBeNull()
  })

  // zoom is the page's on every platform: a map or a diagram editor takes Ctrl+= and Ctrl+- for itself
  it('Ctrl+= and Ctrl+- stay with the page, and ⌘0 does too', () => {
    expect(appKeyFor(key('Equal', '=', { ctrl: true }), 'win32')).toBeNull()
    expect(appKeyFor(key('Minus', '-', { ctrl: true }), 'win32')).toBeNull()
    expect(appKeyFor(key('Digit0', '0', { meta: true }), 'darwin')).toBeNull()
  })

  // AltGr is Ctrl+Alt on Windows: a character it types is the page's, as the composer keeps it
  it('an AltGr character stays with the page: AltGr+2 is @ on a Spanish layout, not a tab switch', () => {
    expect(appKeyFor(key('Digit2', '@', { ctrl: true, alt: true }), 'win32')).toBeNull()
    expect(appKeyFor(key('Digit7', '{', { ctrl: true, alt: true }), 'win32')).toBeNull()
  })

  // a dead key (AltGr+e on a French layout, say) is the first half of a character: the page types it
  it('an AltGr dead key stays with the page, and a real Ctrl+Alt+2 still switches tabs', () => {
    expect(appKeyFor(key('Digit2', 'Dead', { ctrl: true, alt: true }), 'win32')).toBeNull()
    expect(appKeyFor(key('Digit2', '2', { ctrl: true, alt: true }), 'win32')).toEqual({ type: 'gotoTab', index: 1 })
  })
})
