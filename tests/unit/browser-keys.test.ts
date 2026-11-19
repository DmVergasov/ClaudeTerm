import { describe, expect, it } from 'vitest'
import { keyEvents } from '../../src/main/browser/keys'

describe('keyEvents: named keys', () => {
  it('sends Enter as a keyDown with text and a keyUp', () => {
    expect(keyEvents('Enter')).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    ])
  })

  it('sends a non-printable key as a rawKeyDown without text', () => {
    expect(keyEvents('Escape')).toEqual([
      { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0 },
      { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0 },
    ])
  })

  it('sends Space as a space character with its own key code', () => {
    expect(keyEvents('Space')?.[0]).toEqual({ type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, modifiers: 0, text: ' ' })
  })

  it('knows the function keys F1 to F12', () => {
    expect(keyEvents('F1')?.[0]).toMatchObject({ key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 })
    expect(keyEvents('F12')?.[0]).toMatchObject({ key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 })
  })

  it('matches named keys case-sensitively', () => {
    expect(keyEvents('enter')).toBeNull()
    expect(keyEvents('ENTER')).toBeNull()
  })
})

describe('keyEvents: modifiers', () => {
  it('sends Control+a as the modifier down, a rawKeyDown with no text, then the releases', () => {
    const events = keyEvents('Control+a')
    expect(events).toHaveLength(4)
    expect(events?.[0]).toEqual({ type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
    expect(events?.[1]).toEqual({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    expect(events?.[2]).toEqual({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    expect(events?.[3]).toEqual({ type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
  })

  it('sends Shift+Tab with the Shift down around the Tab', () => {
    expect(keyEvents('Shift+Tab')).toEqual([
      { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 },
      { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
      { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
      { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 },
    ])
  })

  it('names the Alt, Meta and Command modifiers with their key codes', () => {
    expect(keyEvents('Alt')).toEqual([
      { type: 'keyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 },
      { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 0 },
    ])
    expect(keyEvents('Command+x')?.[0]).toEqual({ type: 'keyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 4 })
  })

  it('reads Ctrl as Control', () => {
    expect(keyEvents('Ctrl+a')).toEqual(keyEvents('Control+a'))
  })
})

describe('keyEvents: characters and unknown keys', () => {
  it('sends a printable character with its text', () => {
    expect(keyEvents('é')).toHaveLength(2)
    expect(keyEvents('é')?.[0]).toMatchObject({ type: 'keyDown', key: 'é', text: 'é' })
  })

  it('gives a digit its Digit code', () => {
    expect(keyEvents('7')?.[0]).toEqual({ type: 'keyDown', key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, modifiers: 0, text: '7' })
  })

  it('returns null for an unknown key', () => {
    expect(keyEvents('Bogus')).toBeNull()
    expect(keyEvents('Shift+Bogus')).toBeNull()
    expect(keyEvents('Shift+')).toBeNull()
  })
})
