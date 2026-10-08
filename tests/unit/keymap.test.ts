import { describe, expect, it } from 'vitest'
import { imagePasteInput, mapKey, type KeyLike } from '../../src/renderer/keymap'

describe('imagePasteInput', () => {
  it('Alt+V for Claude Code on Windows, Ctrl+V elsewhere', () => {
    expect(imagePasteInput('win32')).toBe('\x1bv')
    expect(imagePasteInput('linux')).toBe('\x16')
  })
})

const k = (code: string, mods: Partial<KeyLike> = {}, key = ''): KeyLike => ({ type: 'keydown', key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })
const cs = { ctrlKey: true, shiftKey: true }

describe('mapKey', () => {
  it('matches the physical key, so a Russian layout works', () => {
    expect(mapKey(k('KeyT', cs, 'Е'))).toEqual({ type: 'newTab' })
    expect(mapKey(k('KeyL', cs, 'Д'))).toEqual({ type: 'newClaudeTab' })
    expect(mapKey(k('KeyW', cs, 'Ц'))).toEqual({ type: 'closeTab' })
    expect(mapKey(k('KeyC', cs, 'С'))).toEqual({ type: 'copy' })
    expect(mapKey(k('KeyV', cs, 'М'))).toEqual({ type: 'paste' })
    expect(mapKey(k('KeyF', cs, 'А'))).toEqual({ type: 'find' })
    expect(mapKey(k('KeyI', cs, 'Ш'))).toEqual({ type: 'toggleImages' })
    expect(mapKey(k('KeyH', cs, 'Р'))).toEqual({ type: 'recentSessions' })
  })

  it('maps Ctrl+Shift+D to the Changes panel, in any layout', () => {
    expect(mapKey(k('KeyD', cs, 'D'))).toEqual({ type: 'toggleChanges' })
    expect(mapKey(k('KeyD', cs, 'В'))).toEqual({ type: 'toggleChanges' })
  })

  it('Shift+Enter sends ESC CR for a newline in the claude prompt', () => {
    expect(mapKey(k('Enter', { shiftKey: true }))).toEqual({ type: 'send', data: '\x1b\r' })
    expect(mapKey(k('NumpadEnter', { shiftKey: true }))).toEqual({ type: 'send', data: '\x1b\r' })
  })

  it('Ctrl+C and Ctrl+V are smart', () => {
    expect(mapKey(k('KeyC', { ctrlKey: true }, 'с'))).toEqual({ type: 'copyOrInterrupt' })
    expect(mapKey(k('KeyV', { ctrlKey: true }, 'м'))).toEqual({ type: 'smartPaste' })
  })

  it('tab navigation', () => {
    expect(mapKey(k('Tab', { ctrlKey: true }))).toEqual({ type: 'nextTab' })
    expect(mapKey(k('Tab', cs))).toEqual({ type: 'prevTab' })
    expect(mapKey(k('Digit1', { ctrlKey: true, altKey: true }))).toEqual({ type: 'gotoTab', index: 0 })
    expect(mapKey(k('Digit9', { ctrlKey: true, altKey: true }))).toEqual({ type: 'gotoTab', index: 8 })
  })

  it('zoom and settings', () => {
    expect(mapKey(k('Equal', { ctrlKey: true }))).toEqual({ type: 'zoomIn' })
    expect(mapKey(k('Minus', { ctrlKey: true }))).toEqual({ type: 'zoomOut' })
    expect(mapKey(k('Digit0', { ctrlKey: true }))).toEqual({ type: 'zoomReset' })
    expect(mapKey(k('Comma', { ctrlKey: true }))).toEqual({ type: 'openSettings' })
  })

  it('leaves everything else to the terminal', () => {
    expect(mapKey(k('Enter'))).toBeNull()
    expect(mapKey(k('KeyT', { ctrlKey: true }))).toBeNull()
    expect(mapKey({ ...k('Enter', { shiftKey: true }), type: 'keyup' })).toBeNull()
    expect(mapKey(k('KeyT', { ...cs, metaKey: true }))).toBeNull()
    expect(mapKey(k('KeyT', { ...cs, altKey: true }))).toBeNull()
  })
})
