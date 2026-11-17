import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameLoop } from '../../src/renderer/games/frame-loop'

/** the frame the loop has asked for, which the test runs by hand */
let pending: FrameRequestCallback | null = null
/** how many frames the loop has asked for */
let requested = 0

function frame(now: number): void {
  const cb = pending
  expect(cb).not.toBeNull()
  pending = null
  cb!(now)
}

beforeEach(() => {
  requested = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending = cb
    requested++
    return requested
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    pending = null
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  pending = null
})

describe('FrameLoop', () => {
  it('asks for one frame at a time', () => {
    const loop = new FrameLoop(() => true)
    loop.start()
    loop.start()
    expect(requested).toBe(1)
  })

  it('its first frame only sets the clock; the next one steps the time since', () => {
    const dts: number[] = []
    const loop = new FrameLoop((dt) => (dts.push(dt), true))
    loop.start()
    frame(1000)
    expect(dts).toEqual([])
    frame(1016)
    expect(dts[0]).toBeCloseTo(0.016)
    expect(dts).toHaveLength(1)
  })

  it('a frame that says stop asks for no more, and the next start begins a new clock', () => {
    const dts: number[] = []
    const loop = new FrameLoop((dt) => (dts.push(dt), false))
    loop.start()
    frame(0)
    frame(16)
    expect(pending).toBeNull()
    loop.start()
    frame(5000)
    expect(dts).toHaveLength(1)
    expect(dts[0]).toBeCloseTo(0.016)
  })

  it('stop cancels the frame it waits for and forgets the clock', () => {
    const dts: number[] = []
    const loop = new FrameLoop((dt) => (dts.push(dt), true))
    loop.start()
    frame(0)
    loop.stop()
    expect(pending).toBeNull()
    loop.start()
    frame(9000)
    frame(9010)
    expect(dts).toHaveLength(1)
    expect(dts[0]).toBeCloseTo(0.01)
  })

  it('a frame that starts the loop again asks for exactly one new frame', () => {
    const loop = new FrameLoop(() => {
      loop.start()
      return true
    })
    loop.start()
    frame(0)
    requested = 0
    frame(16)
    expect(requested).toBe(1)
    expect(pending).not.toBeNull()
  })
})
