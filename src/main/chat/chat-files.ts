import { promises as fsPromises, realpath } from 'node:fs'
import { promisify } from 'node:util'

// The files a chat start reads from disk: Claude Code's trust file, and the real path of the folder it runs in

const realpathNative = promisify(realpath.native)

/** a .claude.json larger than this is not read: its trust list is small, a huge file is not one Claude Code wrote */
const TRUST_FILE_CAP = 16 * 1024 * 1024

/** the text of Claude Code's .claude.json, or null when it is missing, unreadable or over 16 MiB (checked before reading) */
export async function readTrustFile(path: string): Promise<string | null> {
  try {
    if ((await fsPromises.stat(path)).size > TRUST_FILE_CAP) return null
    return await fsPromises.readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** the folder's real path (junctions, symlinks, 8.3 names resolved), or the folder as given when that fails */
export async function canonicalFolder(folder: string): Promise<string> {
  try {
    // Node's promise API has no native realpath; Windows needs the native one for the long name
    return process.platform === 'win32' ? await realpathNative(folder) : await fsPromises.realpath(folder)
  } catch {
    return folder
  }
}
