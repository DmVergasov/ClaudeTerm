import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESENCE_TICK_MS, PRESENT_IDLE_SECONDS, Presence } from '../../src/main/sync/presence'

describe('Presence', () => {
  let state: { focused: boolean; idle: number }
  let changes: boolean[]
  let p: Presence | null

  beforeEach(() => {
    vi.useFakeTimers()
    state = { focused: true, idle: 0 }
    changes = []
    p = null
  })

  afterEach(() => {
    p?.dispose()
    vi.useRealTimers()
  })

  function make(extra: { tickMs?: number; alwaysTick?: boolean } = {}): Presence {
    p = new Presence({
      focused: () => state.focused,
      idleSeconds: () => state.idle,
      changed: (present) => changes.push(present),
      ...extra
    })
    return p
  }

  it('is present when the window is focused and the last input is within 30 seconds', () => {
    const pr = make()
    expect(pr.present()).toBe(true)
    state.idle = PRESENT_IDLE_SECONDS - 1
    expect(pr.present()).toBe(true)
    state.idle = PRESENT_IDLE_SECONDS
    expect(pr.present()).toBe(false)
  })

  it('is not present while the window is not focused, however recent the input', () => {
    state.focused = false
    expect(make().present()).toBe(false)
  })

  it('check() reports the first present value once, and nothing while the value stays', () => {
    const pr = make()
    pr.check()
    pr.check()
    expect(changes).toEqual([true])
  })

  it('check() reports the first value as false when it is not present, so nothing is reported at the start', () => {
    state.focused = false
    const pr = make()
    pr.check()
    expect(changes).toEqual([])
  })

  it('a focused window whose machine goes idle is reported not present on the next tick', () => {
    const pr = make()
    pr.check()
    state.idle = PRESENT_IDLE_SECONDS + 1
    vi.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(changes).toEqual([true, false])
    expect(pr.present()).toBe(false)
  })

  it('ticks only while the window is focused: no timer runs when it is not, and alwaysTick runs one', () => {
    state.focused = false
    const pr = make()
    pr.check()
    expect(vi.getTimerCount()).toBe(0)
    const always = new Presence({ focused: () => false, idleSeconds: () => 0, changed: () => {}, alwaysTick: true })
    always.check()
    expect(vi.getTimerCount()).toBe(1)
    always.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a window that loses the focus stops its timer on the next check', () => {
    const pr = make()
    pr.check()
    expect(vi.getTimerCount()).toBe(1)
    state.focused = false
    pr.check()
    expect(vi.getTimerCount()).toBe(0)
    expect(changes).toEqual([true, false])
  })

  it('with alwaysTick the ticker runs from construction: a focus flip is reported on a tick with no check() call', () => {
    state.focused = false
    make({ alwaysTick: true, tickMs: 200 })
    state.focused = true
    vi.advanceTimersByTime(200)
    expect(changes).toEqual([true])
  })

  it('a tick reports presence back to true once the input is recent again', () => {
    const pr = make()
    pr.check()
    state.idle = PRESENT_IDLE_SECONDS + 1
    vi.advanceTimersByTime(PRESENCE_TICK_MS)
    state.idle = 2
    vi.advanceTimersByTime(PRESENCE_TICK_MS)
    expect(changes).toEqual([true, false, true])
  })

  it('dispose() stops the timer, and a later check reports nothing', () => {
    const pr = make()
    pr.check()
    pr.dispose()
    expect(vi.getTimerCount()).toBe(0)
    state.idle = 999
    pr.check()
    expect(changes).toEqual([true])
  })
})
