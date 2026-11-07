import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Coalescer } from '../../src/main/coalesce'

describe('Coalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the job once, when the wait of the first request of a burst ends', () => {
    const job = vi.fn()
    const c = new Coalescer(100, job)
    for (let i = 0; i < 20; i++) c.request()
    vi.advanceTimersByTime(99)
    expect(job).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(job).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(job).toHaveBeenCalledTimes(1)
  })

  it('a request after the job ran starts a new wait, so the job runs at most once per wait', () => {
    const job = vi.fn()
    const c = new Coalescer(100, job)
    c.request()
    vi.advanceTimersByTime(100)
    c.request()
    vi.advanceTimersByTime(50)
    c.request()
    expect(job).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(50)
    expect(job).toHaveBeenCalledTimes(2)
  })

  it('cancel drops the job that waits, and no job runs after it', () => {
    const job = vi.fn()
    const c = new Coalescer(100, job)
    c.request()
    c.cancel()
    vi.advanceTimersByTime(1000)
    expect(job).not.toHaveBeenCalled()
  })

  it('cancel with nothing waiting does nothing, and a later request still runs the job', () => {
    const job = vi.fn()
    const c = new Coalescer(100, job)
    c.cancel()
    c.request()
    vi.advanceTimersByTime(100)
    expect(job).toHaveBeenCalledTimes(1)
  })
})
