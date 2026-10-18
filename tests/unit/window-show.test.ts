import type { BrowserWindow, Rectangle } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ screen: { getAllDisplays: () => [] } }))

const { showWindow } = await import('../../src/main/window-show')

/** a window that macOS puts back onto the screen (at 0, 0) whenever it is shown */
function fakeWindow(): { win: BrowserWindow; calls: string[]; emit(event: string): void; moveTo(x: number, y: number): void } {
  const calls: string[] = []
  const listeners = new Map<string, (() => void)[]>()
  let bounds: Rectangle = { x: 0, y: 0, width: 800, height: 600 }
  const win = {
    show: () => calls.push('show'),
    showInactive: () => {
      calls.push('showInactive')
      bounds = { ...bounds, x: 0, y: 0 }
    },
    setSkipTaskbar: (skip: boolean) => calls.push(`setSkipTaskbar ${skip}`),
    setPosition: (x: number, y: number) => {
      calls.push(`setPosition ${x} ${y}`)
      bounds = { ...bounds, x, y }
    },
    setOpacity: (o: number) => calls.push(`setOpacity ${o}`),
    getBounds: () => bounds,
    isDestroyed: () => false,
    on: (event: string, fn: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn])
  } as unknown as BrowserWindow
  return {
    win,
    calls,
    emit: (event) => { for (const fn of listeners.get(event) ?? []) fn() },
    moveTo: (x, y) => { bounds = { ...bounds, x, y } }
  }
}

const onDisplay = (b: Rectangle): boolean => b.x > -1000 && b.y > -1000

describe('showWindow', () => {
  it('shows a window normally outside a test run', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, false, 'darwin', onDisplay)
    expect(calls).toEqual(['show'])
  })

  it('a test run shows it off the screen, inactive and out of the taskbar', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'win32', onDisplay)
    expect(calls).toEqual(['setSkipTaskbar true', 'setPosition -30000 -30000', 'showInactive'])
  })

  it('on macOS, which brings a window being shown onto a screen, it is moved off again after, unseen meanwhile', () => {
    const { win, calls } = fakeWindow()
    showWindow(win, true, 'darwin', onDisplay)
    expect(calls).toEqual([
      'setSkipTaskbar true',
      'setPosition -30000 -30000',
      'setOpacity 0',
      'showInactive',
      'setPosition -30000 -30000',
      'setOpacity 1'
    ])
    expect(win.getBounds()).toMatchObject({ x: -30000, y: -30000 })
  })

  it('on macOS a test window that comes back onto a screen later is moved off again, a limited number of times', () => {
    const w = fakeWindow()
    showWindow(w.win, true, 'darwin', onDisplay)
    w.emit('move')
    const settled = w.calls.length
    w.moveTo(10, 20)
    w.emit('move')
    expect(w.calls.slice(settled)).toEqual(['setPosition -30000 -30000'])
    for (let i = 0; i < 30; i++) {
      w.moveTo(10, 20)
      w.emit('resize')
    }
    expect(w.calls.filter((c) => c === 'setPosition -30000 -30000')).toHaveLength(1 + 20)
  })
})
