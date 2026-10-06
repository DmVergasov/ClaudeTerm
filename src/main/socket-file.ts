import { lstatSync, mkdirSync, unlinkSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Makes a Unix socket path ready to listen on. The private fallback folder is created (0700) and must be a folder
 * only this user can access. A socket left by a ClaudeTerm that crashed is removed: the single-instance lock
 * guarantees no other ClaudeTerm of this user listens there. Anything else at that path is left alone.
 */
export function prepareSocket(path: string, o: { privateDir: string; uid: number }): void {
  const dir = dirname(path)
  if (dir === o.privateDir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const d = lstatSync(dir)
    if (!d.isDirectory() || d.uid !== o.uid || (d.mode & 0o077) !== 0) throw new Error(`refusing to use ${dir}: it must be a folder only you can access`)
  }
  let st: Stats
  try {
    st = lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  if (!st.isSocket()) throw new Error(`refusing to replace ${path}: it is not a socket`)
  unlinkSync(path)
}

/** prepareSocket, answering why ClaudeTerm must not listen there, or null when it can */
export function socketProblem(path: string, o: { privateDir: string; uid: number }): string | null {
  try {
    prepareSocket(path, o)
    return null
  } catch (e) {
    return (e as Error).message
  }
}
