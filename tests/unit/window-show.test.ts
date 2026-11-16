import type { BrowserWindow } from 'electron'
import { describe, expect, it } from 'vitest'
import { showWindow } from '../../src/main/window-show'

function fakeWindow(): { win: BrowserWindow; calls: string[] } {
  const calls: string[] = []
  const win = {
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
    setSkipTaskbar: (skip: boolean) => calls.push(`setSkipTaskbar ${skip}`),
    setPosition: (x: number, y: number) => calls.push(`setPosition ${x} ${y}`),
    setFocusable: (f: boolean) => calls.push(`setFocusable ${f}`),
    setOpacity: (o: number) => calls.push(`setOpacity ${o}`),
    setIgnoreMouseEvents: (i: boolean) => calls.push(`setIgnoreMouseEvents ${i}`)
  } as unknown as BrowserWindow
  return { win, calls }
}

describe('showWindow', () => {
  it('shows a window normally outside a test run', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, false, 'win32')
    expect(calls).toEqual(['show'])
  })

  it('a test run shows it off the screen, inactive and out of the taskbar; on Linux it keeps its opacity, so its page still draws', () => {
    // Electron on Linux makes the window's layer transparent, and Chromium stops drawing a page nobody can see: no frames, no animations
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'linux')
    expect(calls).toEqual(['setSkipTaskbar true', 'setIgnoreMouseEvents true', 'setPosition -30000 -30000', 'showInactive'])
  })

  it('on Windows, where maximizing an inactive window activates it, a test window also cannot take the focus', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'win32')
    expect(calls).toEqual(['setSkipTaskbar true', 'setOpacity 0', 'setIgnoreMouseEvents true', 'setFocusable false', 'setPosition -30000 -30000', 'showInactive'])
  })

  it('on macOS, which keeps a part of every window on a screen, a test run shows it where macOS puts it, inactive', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'darwin')
    expect(calls).toEqual(['setSkipTaskbar true', 'setOpacity 0', 'setIgnoreMouseEvents true', 'showInactive'])
  })
})
