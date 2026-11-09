import { describe, expect, it, vi } from 'vitest'
import { startPlayer } from '../../src/main/sound'

const { SLOW_START_MS } = vi.hoisted(() => ({ SLOW_START_MS: 600 }))

// On a busy Windows machine starting a process now and then takes hundreds of milliseconds, and node starts it in the
// thread that asks: here every process start in this thread takes SLOW_START_MS
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((...args: Parameters<typeof real.spawn>) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOW_START_MS)
    return real.spawn(...args)
  }) as typeof real.spawn
  return { ...real, default: { ...real, spawn }, spawn }
})

describe('the sound player off the main thread', () => {
  it('a slow start of the player leaves the event loop running, and its exit code still comes', async () => {
    const started = performance.now()
    const late = new Promise<number>((r) => setTimeout(() => r(performance.now() - started), 20))
    // a stand-in player that fails: the sound player falls back to the beep on a non-zero exit
    const child = startPlayer({ file: process.execPath, args: ['-e', 'process.exit(3)'], env: process.env })
    const exit = new Promise<number | null>((r) => child.on('exit', r))
    expect(await late).toBeLessThan(SLOW_START_MS / 2)
    expect(await exit).toBe(3)
  })

  it('a player that cannot start reports an error', async () => {
    const child = startPlayer({ file: 'no-such-player-ct', args: [], env: process.env })
    const error = await new Promise<Error>((r) => child.on('error', r))
    expect(error).toBeInstanceOf(Error)
  })
})
