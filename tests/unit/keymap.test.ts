import { describe, expect, it } from 'vitest'
import { imagePasteInput, imagePasteRoute, isImagePasteKey, isPrimaryKey, mapKey, shortcutLabel, type KeyLike } from '../../src/renderer/keymap'

describe('imagePasteInput', () => {
  it('Alt+V for Claude Code on Windows, Ctrl+V elsewhere', () => {
    expect(imagePasteInput('win32')).toBe('\x1bv')
    expect(imagePasteInput('linux')).toBe('\x16')
    expect(imagePasteInput('darwin')).toBe('\x16')
  })
})

describe('imagePasteRoute', () => {
  it('an image pasted into a remote tab is always copied there, on every system', () => {
    for (const platform of ['win32', 'darwin', 'linux']) for (const asFile of [true, false]) expect(imagePasteRoute({ platform, remote: true, asFile })).toBe('remote')
  })
  it('a local tab: a PNG file on Windows when the file route is asked, the paste key otherwise', () => {
    expect(imagePasteRoute({ platform: 'win32', remote: false, asFile: true })).toBe('file')
    expect(imagePasteRoute({ platform: 'win32', remote: false, asFile: false })).toBe('key')
    expect(imagePasteRoute({ platform: 'darwin', remote: false, asFile: false })).toBe('key')
    expect(imagePasteRoute({ platform: 'linux', remote: false, asFile: true })).toBe('key')
  })
})

const k = (code: string, mods: Partial<KeyLike> = {}, key = ''): KeyLike => ({ type: 'keydown', key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })
const cs = { ctrlKey: true, shiftKey: true }
const cmd = { metaKey: true }

describe.each(['win32', 'linux'])('mapKey on %s', (platform) => {
  const map = (e: KeyLike) => mapKey(e, platform)

  it('matches the physical key, so a Russian layout works', () => {
    expect(map(k('KeyT', cs, 'Е'))).toEqual({ type: 'newTab' })
    expect(map(k('KeyL', cs, 'Д'))).toEqual({ type: 'newClaudeTab' })
    expect(map(k('KeyW', cs, 'Ц'))).toEqual({ type: 'closeTab' })
    expect(map(k('KeyC', cs, 'С'))).toEqual({ type: 'copy' })
    expect(map(k('KeyV', cs, 'М'))).toEqual({ type: 'paste' })
    expect(map(k('KeyF', cs, 'А'))).toEqual({ type: 'find' })
    expect(map(k('KeyI', cs, 'Ш'))).toEqual({ type: 'toggleImages' })
    expect(map(k('KeyH', cs, 'Р'))).toEqual({ type: 'recentSessions' })
    expect(map(k('KeyN', cs, 'Т'))).toEqual({ type: 'toggleNote' })
    expect(map(k('KeyJ', cs, 'О'))).toEqual({ type: 'nextWaiting' })
  })

  it('maps Ctrl+Shift+D to the Changes panel, in any layout', () => {
    expect(map(k('KeyD', cs, 'D'))).toEqual({ type: 'toggleChanges' })
    expect(map(k('KeyD', cs, 'В'))).toEqual({ type: 'toggleChanges' })
  })

  it('maps Ctrl+Shift+O to the Docs panel, in any layout', () => {
    expect(map(k('KeyO', cs, 'Щ'))).toEqual({ type: 'toggleDocs' })
  })

  it('Shift+Enter sends ESC CR for a newline in the claude prompt', () => {
    expect(map(k('Enter', { shiftKey: true }))).toEqual({ type: 'send', data: '\x1b\r' })
    expect(map(k('NumpadEnter', { shiftKey: true }))).toEqual({ type: 'send', data: '\x1b\r' })
  })

  it('Ctrl+C and Ctrl+V are smart', () => {
    expect(map(k('KeyC', { ctrlKey: true }, 'с'))).toEqual({ type: 'copyOrInterrupt' })
    expect(map(k('KeyV', { ctrlKey: true }, 'м'))).toEqual({ type: 'smartPaste' })
  })

  it('tab navigation', () => {
    expect(map(k('Tab', { ctrlKey: true }))).toEqual({ type: 'nextTab' })
    expect(map(k('Tab', cs))).toEqual({ type: 'prevTab' })
    expect(map(k('Digit1', { ctrlKey: true, altKey: true }))).toEqual({ type: 'gotoTab', index: 0 })
    expect(map(k('Digit9', { ctrlKey: true, altKey: true }))).toEqual({ type: 'gotoTab', index: 8 })
  })

  it('zoom and settings', () => {
    expect(map(k('Equal', { ctrlKey: true }))).toEqual({ type: 'zoomIn' })
    expect(map(k('Minus', { ctrlKey: true }))).toEqual({ type: 'zoomOut' })
    expect(map(k('Digit0', { ctrlKey: true }))).toEqual({ type: 'zoomReset' })
    expect(map(k('Comma', { ctrlKey: true }))).toEqual({ type: 'openSettings' })
  })

  it('leaves everything else to the terminal', () => {
    expect(map(k('Enter'))).toBeNull()
    expect(map(k('KeyT', { ctrlKey: true }))).toBeNull()
    expect(map({ ...k('Enter', { shiftKey: true }), type: 'keyup' })).toBeNull()
    expect(map(k('KeyT', { ...cs, metaKey: true }))).toBeNull()
    expect(map(k('KeyT', { ...cs, altKey: true }))).toBeNull()
    expect(map(k('KeyT', cmd))).toBeNull()
  })
})

describe('mapKey on macOS', () => {
  const map = (e: KeyLike) => mapKey(e, 'darwin')

  it('⌘ takes the place of Ctrl+Shift, by the physical key', () => {
    expect(map(k('KeyT', cmd, 'е'))).toEqual({ type: 'newTab' })
    expect(map(k('KeyL', cmd))).toEqual({ type: 'newClaudeTab' })
    expect(map(k('KeyW', cmd))).toEqual({ type: 'closeTab' })
    expect(map(k('KeyF', cmd))).toEqual({ type: 'find' })
    expect(map(k('KeyI', cmd))).toEqual({ type: 'toggleImages' })
    expect(map(k('KeyD', cmd, 'в'))).toEqual({ type: 'toggleChanges' })
    expect(map(k('KeyO', cmd, 'щ'))).toEqual({ type: 'toggleDocs' })
    expect(mapKey(k('KeyN', cmd), 'darwin')).toEqual({ type: 'toggleNote' })
  })

  it('⌘C copies, ⌘V pastes text or hands a clipboard image to Claude, ⌘⇧V pastes text only', () => {
    expect(map(k('KeyC', cmd))).toEqual({ type: 'copy' })
    expect(map(k('KeyV', cmd))).toEqual({ type: 'smartPaste' })
    expect(map(k('KeyV', { ...cmd, shiftKey: true }))).toEqual({ type: 'paste' })
  })

  it('Ctrl keys go to the terminal: Ctrl+C interrupts, Ctrl+V is Claude Code\'s own image paste', () => {
    expect(map(k('KeyC', { ctrlKey: true }))).toBeNull()
    expect(map(k('KeyV', { ctrlKey: true }))).toBeNull()
    expect(map(k('KeyT', cs))).toBeNull()
    expect(map(k('KeyD', cs))).toBeNull()
  })

  it('the next tab that needs you is ⌘J', () => {
    expect(map(k('KeyJ', cmd))).toEqual({ type: 'nextWaiting' })
    expect(map(k('KeyJ', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('recent sessions are ⌘⇧H: ⌘H hides the app', () => {
    expect(map(k('KeyH', { ...cmd, shiftKey: true }))).toEqual({ type: 'recentSessions' })
    expect(map(k('KeyH', cmd))).toBeNull()
  })

  it('tab navigation: Ctrl+Tab, ⌘⇧] and ⌘⇧[, ⌘1…⌘9', () => {
    expect(map(k('Tab', { ctrlKey: true }))).toEqual({ type: 'nextTab' })
    expect(map(k('Tab', cs))).toEqual({ type: 'prevTab' })
    expect(map(k('BracketRight', { ...cmd, shiftKey: true }))).toEqual({ type: 'nextTab' })
    expect(map(k('BracketLeft', { ...cmd, shiftKey: true }))).toEqual({ type: 'prevTab' })
    expect(map(k('Digit1', cmd))).toEqual({ type: 'gotoTab', index: 0 })
    expect(map(k('Digit9', cmd))).toEqual({ type: 'gotoTab', index: 8 })
  })

  it('zoom (⌘= or ⌘+), settings, Shift+Enter', () => {
    expect(map(k('Equal', cmd))).toEqual({ type: 'zoomIn' })
    expect(map(k('Equal', { ...cmd, shiftKey: true }))).toEqual({ type: 'zoomIn' })
    expect(map(k('Minus', cmd))).toEqual({ type: 'zoomOut' })
    expect(map(k('Digit0', cmd))).toEqual({ type: 'zoomReset' })
    expect(map(k('Comma', cmd))).toEqual({ type: 'openSettings' })
    expect(map(k('Enter', { shiftKey: true }))).toEqual({ type: 'send', data: '\x1b\r' })
  })

  it('leaves the system\'s and the menu\'s keys alone: ⌘Q, ⌘M, ⌘A, ⌥⌘ combinations', () => {
    expect(map(k('KeyQ', cmd))).toBeNull()
    expect(map(k('KeyM', cmd))).toBeNull()
    expect(map(k('KeyA', cmd))).toBeNull()
    expect(map(k('KeyT', { ...cmd, altKey: true }))).toBeNull()
    expect(map(k('KeyT', { ...cmd, ctrlKey: true }))).toBeNull()
  })
})

describe('isPrimaryKey', () => {
  it('Ctrl on Windows and Linux, ⌘ on macOS, without the other modifiers', () => {
    expect(isPrimaryKey(k('KeyF', { ctrlKey: true }), 'win32')).toBe(true)
    expect(isPrimaryKey(k('KeyF', { ctrlKey: true }), 'linux')).toBe(true)
    expect(isPrimaryKey(k('KeyF', cmd), 'win32')).toBe(false)
    expect(isPrimaryKey(k('KeyF', cmd), 'darwin')).toBe(true)
    expect(isPrimaryKey(k('KeyF', { ctrlKey: true }), 'darwin')).toBe(false)
    expect(isPrimaryKey(k('KeyF', cs), 'win32')).toBe(false)
    expect(isPrimaryKey(k('KeyF', { ...cmd, altKey: true }), 'darwin')).toBe(false)
  })
})

describe('shortcutLabel', () => {
  it('names a shortcut as the platform writes it', () => {
    expect(shortcutLabel('newTab', 'win32')).toBe('Ctrl+Shift+T')
    expect(shortcutLabel('newTab', 'linux')).toBe('Ctrl+Shift+T')
    expect(shortcutLabel('newTab', 'darwin')).toBe('⌘T')
    expect(shortcutLabel('closeTab', 'darwin')).toBe('⌘W')
    expect(shortcutLabel('panelFind', 'win32')).toBe('Ctrl+F')
    expect(shortcutLabel('panelFind', 'darwin')).toBe('⌘F')
    expect(shortcutLabel('toggleNote', 'win32')).toBe('Ctrl+Shift+N')
    expect(shortcutLabel('toggleNote', 'darwin')).toBe('⌘N')
    expect(shortcutLabel('toggleDocs', 'win32')).toBe('Ctrl+Shift+O')
    expect(shortcutLabel('toggleDocs', 'darwin')).toBe('⌘O')
  })
})

describe('isImagePasteKey', () => {
  it('Ctrl+V on macOS and Alt+V on Windows are Claude Code\'s image-paste key', () => {
    expect(isImagePasteKey(k('KeyV', { ctrlKey: true }, 'м'), 'darwin')).toBe(true)
    expect(isImagePasteKey(k('KeyV', { altKey: true }, 'м'), 'win32')).toBe(true)
  })
  it('Cmd+V, Ctrl+V on Windows and Linux (smart paste) and Alt+V on macOS are not', () => {
    expect(isImagePasteKey(k('KeyV', cmd), 'darwin')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { ctrlKey: true }), 'win32')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { ctrlKey: true }), 'linux')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { altKey: true }), 'darwin')).toBe(false)
  })
  it('any other modifier, Shift included, makes it another key', () => {
    expect(isImagePasteKey(k('KeyV', { ctrlKey: true, shiftKey: true }), 'darwin')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { ctrlKey: true, altKey: true }), 'darwin')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { ctrlKey: true, metaKey: true }), 'darwin')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { altKey: true, shiftKey: true }), 'win32')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { altKey: true, ctrlKey: true }), 'win32')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { altKey: true, metaKey: true }), 'win32')).toBe(false)
  })
  it('is false on Linux for every key, and for a key release', () => {
    expect(isImagePasteKey(k('KeyV', { altKey: true }), 'linux')).toBe(false)
    expect(isImagePasteKey(k('KeyV', { ctrlKey: true, altKey: true }), 'linux')).toBe(false)
    expect(isImagePasteKey({ ...k('KeyV', { ctrlKey: true }), type: 'keyup' }, 'darwin')).toBe(false)
    expect(isImagePasteKey({ ...k('KeyV', { altKey: true }), type: 'keyup' }, 'win32')).toBe(false)
  })
})

describe('recent sessions shortcut', () => {
  it('is labelled with the key that opens it on each platform', () => {
    expect(mapKey(k('KeyH', { ctrlKey: true, shiftKey: true }), 'win32')).toEqual({ type: 'recentSessions' })
    expect(mapKey(k('KeyH', { ctrlKey: true, shiftKey: true }), 'linux')).toEqual({ type: 'recentSessions' })
    expect(shortcutLabel('recentSessions', 'win32')).toBe('Ctrl+Shift+H')
    expect(shortcutLabel('recentSessions', 'linux')).toBe('Ctrl+Shift+H')
    expect(mapKey(k('KeyH', { metaKey: true, shiftKey: true }), 'darwin')).toEqual({ type: 'recentSessions' })
    expect(shortcutLabel('recentSessions', 'darwin')).toBe('⇧⌘H')
  })
})

describe('settings shortcut', () => {
  it('is labelled with the key that opens it on each platform', () => {
    expect(mapKey(k('Comma', { ctrlKey: true }), 'win32')).toEqual({ type: 'openSettings' })
    expect(mapKey(k('Comma', { ctrlKey: true }), 'linux')).toEqual({ type: 'openSettings' })
    expect(shortcutLabel('openSettings', 'win32')).toBe('Ctrl+,')
    expect(shortcutLabel('openSettings', 'linux')).toBe('Ctrl+,')
    expect(mapKey(k('Comma', { metaKey: true }), 'darwin')).toEqual({ type: 'openSettings' })
    expect(shortcutLabel('openSettings', 'darwin')).toBe('⌘,')
  })
})
