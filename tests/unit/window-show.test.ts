import type { BrowserWindow } from 'electron'
import { describe, expect, it } from 'vitest'
import { showWindow } from '../../src/main/window-show'

function fakeWindow(): { win: BrowserWindow; calls: string[] } {
  const calls: string[] = []
  const win = {
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
    setSkipTaskbar: (skip: boolean) => calls.push(`setSkipTaskbar ${skip}`),
    setPosition: (x: number, y: number) => calls.push(`setPosition ${x} ${y}`)
  } as unknown as BrowserWindow
  return { win, calls }
}

describe('showWindow', () => {
  it('shows a window normally outside a test run', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, false, 'win32')
    expect(calls).toEqual(['show'])
  })

  it('a test run shows it off the screen, inactive and out of the taskbar', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'linux')
    expect(calls).toEqual(['setSkipTaskbar true', 'setPosition -30000 -30000', 'showInactive'])
  })

  it('on macOS, which keeps a part of every window on a screen, a test run shows it where macOS puts it, inactive', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'darwin')
    expect(calls).toEqual(['setSkipTaskbar true', 'showInactive'])
  })
})
