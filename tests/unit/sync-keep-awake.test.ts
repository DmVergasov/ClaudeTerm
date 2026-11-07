import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AWAKE_INPUT_MS, KeepAwake, type PowerBlocker } from '../../src/main/sync/keep-awake'

/** a blocker that counts how often it was started and stopped */
class FakeBlocker implements PowerBlocker {
  started = 0
  stopped = 0
  start(): number {
    this.started++
    return this.started
  }
  stop(): void {
    this.stopped++
  }
}

describe('KeepAwake', () => {
  let now: number
  let enabled: boolean
  let blocker: FakeBlocker
  let k: KeepAwake

  beforeEach(() => {
    vi.useFakeTimers()
    now = 1_000_000
    enabled = true
    blocker = new FakeBlocker()
    k = new KeepAwake({ blocker, enabled: () => enabled, now: () => now })
  })

  afterEach(() => {
    k.dispose()
    vi.useRealTimers()
  })

  it('holds while a member typed in the last 30 minutes, and lets go after', () => {
    k.update({ linked: true, watchedWorking: false })
    k.input()
    expect(blocker.started).toBe(1)
    // still held just inside the window
    now += AWAKE_INPUT_MS - 1
    vi.advanceTimersByTime(60_000)
    expect(k.holding()).toBe(true)
    now += 2
    vi.advanceTimersByTime(60_000)
    expect(blocker.stopped).toBe(1)
    expect(k.holding()).toBe(false)
  })

  it('holds while a Claude tab another device has attached is working', () => {
    k.update({ linked: true, watchedWorking: true })
    expect(k.holding()).toBe(true)
    expect(blocker.started).toBe(1)
  })

  it('lets go when the setting goes off and when the last link ends', () => {
    k.update({ linked: true, watchedWorking: true })
    enabled = false
    k.update({ linked: true, watchedWorking: true })
    expect(k.holding()).toBe(false)
    expect(blocker.stopped).toBe(1)
    enabled = true
    k.update({ linked: true, watchedWorking: true })
    expect(k.holding()).toBe(true)
    k.update({ linked: false, watchedWorking: true })
    expect(k.holding()).toBe(false)
    expect(blocker.stopped).toBe(2)
  })

  it('starts the blocker once and stops it once', () => {
    k.update({ linked: true, watchedWorking: true })
    k.input()
    k.update({ linked: true, watchedWorking: true })
    k.update({ linked: true, watchedWorking: true })
    expect(blocker.started).toBe(1)
    expect(blocker.stopped).toBe(0)
    k.update({ linked: false, watchedWorking: true })
    expect(blocker.started).toBe(1)
    expect(blocker.stopped).toBe(1)
  })

  it('lets go when the last watched Claude tab stops working and no member typed recently', () => {
    k.update({ linked: true, watchedWorking: true })
    expect(k.holding()).toBe(true)
    k.update({ linked: true, watchedWorking: false })
    expect(k.holding()).toBe(false)
    expect(blocker.stopped).toBe(1)
  })

  it('a member input while no link is up holds nothing', () => {
    k.update({ linked: false, watchedWorking: false })
    k.input()
    expect(k.holding()).toBe(false)
    expect(blocker.started).toBe(0)
  })

  it('a setting turned off while held stops the blocker, and the hold does not come back by itself', () => {
    k.update({ linked: true, watchedWorking: true })
    enabled = false
    vi.advanceTimersByTime(60_000)
    expect(k.holding()).toBe(false)
    expect(blocker.stopped).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(blocker.started).toBe(1)
  })

  it('the timer runs only while holding', () => {
    expect(vi.getTimerCount()).toBe(0)
    k.update({ linked: true, watchedWorking: true })
    expect(vi.getTimerCount()).toBe(1)
    k.update({ linked: false, watchedWorking: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a sleep and wake, which bounces every link, neither leaves the hold on nor starts a second blocker', () => {
    k.update({ linked: true, watchedWorking: true })
    // the sleep: every link goes down
    k.update({ linked: false, watchedWorking: true })
    expect(k.holding()).toBe(false)
    expect(blocker.stopped).toBe(1)
    // the wake: the links come back, one after another
    k.update({ linked: true, watchedWorking: true })
    k.update({ linked: true, watchedWorking: true })
    expect(k.holding()).toBe(true)
    expect(blocker.started).toBe(2)
    expect(blocker.stopped).toBe(1)
  })

  it('dispose stops a held blocker and its timer, and nothing starts after it', () => {
    k.update({ linked: true, watchedWorking: true })
    k.dispose()
    expect(k.holding()).toBe(false)
    expect(blocker.stopped).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    k.update({ linked: true, watchedWorking: true })
    k.input()
    expect(blocker.started).toBe(1)
    expect(k.holding()).toBe(false)
  })

  it('dispose with nothing held stops nothing', () => {
    k.dispose()
    expect(blocker.started).toBe(0)
    expect(blocker.stopped).toBe(0)
  })
})
