import { chmod, copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The folder name of every copy of a browser's cookie database made by an import.
export const TEMP_PREFIX = 'ct-cookie-import-'

/** A new empty folder under tmpdir(), readable only by this user where the platform allows it. */
export async function makePrivateTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  if (process.platform !== 'win32') {
    try {
      await chmod(dir, 0o700)
    } catch (e) {
      await removeTemp(dir)
      throw e
    }
  }
  return dir
}

/**
 * Deletes a folder and what is in it. A browser's helper processes can hold a file for a moment after the browser
 * has exited, so the removal is retried. Never throws: a copy that cannot be removed is left for removeStaleTemps.
 */
export async function removeTemp(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // left behind; removeStaleTemps deletes it at the next start
  }
}

/** Copies a file when it exists. Returns false when the source is missing; other errors are thrown. */
export async function copyIfExists(src: string, dst: string): Promise<boolean> {
  try {
    await copyFile(src, dst)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

// an import's copy lives about two minutes at most: an older copy is a leftover, a younger one may be another run's import in progress
const STALE_AFTER_MS = 15 * 60_000

/** Deletes the copies an earlier run left in tmpdir(), for example after a crash: those not changed for 15 minutes. Never throws. */
export async function removeStaleTemps(): Promise<void> {
  try {
    const dir = tmpdir()
    const now = Date.now()
    const names = (await readdir(dir)).filter((name) => name.startsWith(TEMP_PREFIX))
    const stale = await Promise.all(names.map(async (name) => {
      const at = join(dir, name)
      const old = await stat(at).then((s) => now - s.mtimeMs > STALE_AFTER_MS, () => false)
      return old ? at : null
    }))
    await Promise.all(stale.filter((at): at is string => at !== null).map((at) => removeTemp(at)))
  } catch {
    // no temp folder to clean up
  }
}
