import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resizeWindow, type ResizableWindow } from '../../src/main/resize-window'

type Rect = { x: number; y: number; width: number; height: number }

class FakeWindow extends EventEmitter implements ResizableWindow {
  b: Rect = { x: 100, y: 50, width: 1000, height: 700 }
  /** what setBounds does with the rectangle: take it at once, take it later (with a resize event), or ignore it */
  onSet: (r: Rect) => void = (r) => { this.b = { ...r } }
  getBounds = (): Rect => ({ ...this.b })
  setBounds = (r: Rect): void => this.onSet(r)
}

const GROWN: Rect = { x: 100, y: 50, width: 1640, height: 700 }

describe('resizeWindow', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('answers at once, without waiting for a resize event or a time limit, when setBounds did not change the window', async () => {
    const w = new FakeWindow()
    w.onSet = () => undefined
    let answer: boolean | undefined
    void resizeWindow(w, GROWN).then((grew) => { answer = grew })
    await vi.advanceTimersByTimeAsync(0)
    expect(answer).toBe(false)
    expect(w.listenerCount('resize')).toBe(0)
  })

  it('answers true when the window changed, once its resize event came', async () => {
    const w = new FakeWindow()
    w.onSet = (r) => { w.b = { ...r }; setTimeout(() => w.emit('resize'), 40) }
    let answer: boolean | undefined
    void resizeWindow(w, GROWN).then((grew) => { answer = grew })
    await vi.advanceTimersByTimeAsync(10)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(40)
    expect(answer).toBe(true)
    expect(w.listenerCount('resize')).toBe(0)
  })

  it('a window that changed but never sends its resize event is waited for only a short time', async () => {
    const w = new FakeWindow()
    let answer: boolean | undefined
    void resizeWindow(w, GROWN).then((grew) => { answer = grew })
    await vi.advanceTimersByTimeAsync(150)
    expect(answer).toBe(true)
    expect(w.listenerCount('resize')).toBe(0)
  })
})
