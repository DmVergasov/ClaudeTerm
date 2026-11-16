import { describe, expect, it } from 'vitest'
import { gameKeyRoute } from '../../src/renderer/games/game-keys'
import type { KeyLike } from '../../src/renderer/keymap'

const key = (code: string, mods: Partial<KeyLike & { repeat: boolean }> = {}): KeyLike & { repeat: boolean } => ({
  type: 'keydown', key: code, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...mods
})
const cmd = { metaKey: true }
const cs = { ctrlKey: true, shiftKey: true }

describe('gameKeyRoute on macOS', () => {
  const route = (e: ReturnType<typeof key>, paused = false) => gameKeyRoute(e, 'darwin', paused)

  it('a ⌘ chord the app does not use passes to the menu: ⌘Q, ⌘H', () => {
    expect(route(key('KeyQ', cmd))).toBe('pass')
    expect(route(key('KeyH', cmd))).toBe('pass')
  })

  it('a ⌘ chord the app maps is an app shortcut: ⌘G passes too, and the document handler runs it', () => {
    expect(route(key('KeyG', cmd))).toBe('pass')
  })

  it('⌘C and ⌘V are not app shortcuts for the document handler: they are the game\'s keys', () => {
    expect(route(key('KeyC', cmd))).toBe('game')
    expect(route(key('KeyV', cmd))).toBe('game')
  })

  it('a plain key is the game\'s', () => {
    expect(route(key('KeyX'))).toBe('game')
  })
})

describe('gameKeyRoute on Windows', () => {
  const route = (e: ReturnType<typeof key>, paused = false) => gameKeyRoute(e, 'win32', paused)

  it('an app shortcut passes to the document handler', () => {
    expect(route(key('KeyT', cs))).toBe('pass')
  })

  it('Shift+Enter, Ctrl+C and Ctrl+V are not app shortcuts for the document handler: they are the game\'s keys', () => {
    expect(route(key('Enter', { shiftKey: true }))).toBe('game')
    expect(route(key('KeyC', { ctrlKey: true }))).toBe('game')
    expect(route(key('KeyV', { ctrlKey: true }))).toBe('game')
  })

  it('a plain key is the game\'s', () => {
    expect(route(key('KeyX'))).toBe('game')
  })

  it('a held key\'s repeat is dropped, whatever it is', () => {
    expect(route(key('ArrowLeft', { repeat: true }))).toBe('drop')
  })

  it('Escape gives the keyboard back to the tab', () => {
    expect(route(key('Escape'))).toBe('tab')
  })

  it('Space while paused resumes; while running it is the game\'s', () => {
    expect(route(key('Space'), true)).toBe('resume')
    expect(route(key('Space'), false)).toBe('game')
  })

  it('a key release is never a resume', () => {
    expect(route({ ...key('Space'), type: 'keyup' }, true)).toBe('game')
  })
})
