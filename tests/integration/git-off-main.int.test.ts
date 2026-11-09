import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { execGit } from '../../src/main/git-source'

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

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-git-'))
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
  return dir
}

describe('git off the main thread', () => {
  it('a slow start of git leaves the event loop running, and git still answers', async () => {
    const dir = repo()
    const started = performance.now()
    const late = new Promise<number>((r) => setTimeout(() => r(performance.now() - started), 20))
    const run = execGit(['rev-parse', '--show-toplevel'], dir)
    // the window's input, its tab switches and every terminal's output wait for this loop: a 20 ms timer fires on time
    expect(await late).toBeLessThan(SLOW_START_MS / 2)
    const r = await run
    expect(r.code).toBe(0)
    expect(realpathSync.native(r.stdout.toString('utf8').trim())).toBe(realpathSync.native(dir))
  })
})
