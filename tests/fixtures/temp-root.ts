import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Everything a test run writes goes into a folder of its own in the system temp folder, and the run deletes it when it
 * ends. The global setup of Vitest and of Playwright (temp-root-setup.ts) points TEMP, TMP and TMPDIR at it, so tmpdir()
 * in the tests lands there, and so do the processes they start: the app with its data folder and caches, the hook
 * script, git.
 */
export const TEMP_ROOT_PREFIX = 'ct-test-'
/** a root this old belongs to a run that was killed before it could delete it: the next run deletes it */
export const STALE_ROOT_MS = 24 * 3_600_000

/** makes the run's root in `systemTmp` and points the temp variables of `env` at it; deletes the roots runs left */
export function openTempRoot(env: NodeJS.ProcessEnv = process.env, systemTmp: string = tmpdir(), now: number = Date.now()): string {
  sweepStaleRoots(systemTmp, now)
  const root = mkdtempSync(join(systemTmp, TEMP_ROOT_PREFIX))
  env.TEMP = root
  env.TMP = root
  env.TMPDIR = root
  return root
}

/** deletes the run's root; what a process still holds open stays, for a later run to delete */
export function closeTempRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (e) {
    console.warn(`could not delete the test temp folder ${root}: ${(e as Error).message}`)
  }
}

function sweepStaleRoots(systemTmp: string, now: number): void {
  for (const name of readdirSync(systemTmp)) {
    if (!name.startsWith(TEMP_ROOT_PREFIX)) continue
    const dir = join(systemTmp, name)
    try {
      const s = statSync(dir)
      if (s.isDirectory() && now - s.mtimeMs > STALE_ROOT_MS) rmSync(dir, { recursive: true, force: true })
    } catch {
      // another run deletes it at the same time, or a file in it is still held open: a later run tries again
    }
  }
}
