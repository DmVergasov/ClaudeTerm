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
    setOpacity: (o: number) => calls.push(`setOpacity ${o}`)
  } as unknown as BrowserWindow
  return { win, calls }
}

describe('showWindow', () => {
  it('shows a window normally outside a test run', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, false, 'darwin')
    expect(calls).toEqual(['show'])
  })

  it('a test run shows it off the screen, inactive and out of the taskbar', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'win32')
    expect(calls).toEqual(['setSkipTaskbar true', 'setPosition -30000 -30000', 'showInactive'])
  })

  it('on macOS, which brings a window being shown onto a screen, it is moved off again after, unseen meanwhile', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'darwin')
    expect(calls).toEqual([
      'setSkipTaskbar true',
      'setPosition -30000 -30000',
      'setOpacity 0',
      'showInactive',
      'setPosition -30000 -30000',
      'setOpacity 1'
    ])
  })
})
