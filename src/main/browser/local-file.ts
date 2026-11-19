import type { PlatformPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWithin, nativePath, pathKey } from '../path-key'

/** the OS path a file: URL names, or null when the text is no file URL */
export function filePathOf(url: string): string | null {
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

/**
 * Whether a file lies inside a folder, both as their real paths: links (symlinks, junctions) are followed, so a link inside the
 * folder that leads outside makes its files outside. A file that does not exist yet is placed by its nearest existing parent.
 * `realpath` throws for a path that does not exist. A `..` is resolved by the disk, after the links before it, as the OS does.
 */
export function fileInside(file: string, folder: string, realpath: (p: string) => string, path: PlatformPath = nativePath): boolean {
  let realFolder: string
  try {
    realFolder = realpath(folder)
  } catch {
    return false
  }
  const realFile = realpathOfNearest(file, realpath, path)
  return realFile !== null && isWithin(realFolder, realFile, path) && pathKey(realFile, path) !== pathKey(realFolder, path)
}

/**
 * The folder whose files are free for Claude: the tab's own folder, but none when the tab has no folder, when the folder does not
 * exist, when it is a filesystem root, or when it is the person's home folder (a file in it, Downloads included, would be free).
 * Compared as real paths, and with pathKey.
 */
export function tabFolderFor(folder: string | null, home: string, realpath: (p: string) => string, path: PlatformPath = nativePath): string | null {
  if (folder === null) return null
  let real: string
  try {
    real = realpath(folder)
  } catch {
    return null
  }
  if (path.parse(real).root === real) return null
  let realHome = home
  try {
    realHome = realpath(home)
  } catch {
    // no real path for the home folder: it is compared as it is given
  }
  return pathKey(real, path) === pathKey(realHome, path) ? null : real
}

/** the real path of a path, or of its nearest existing parent with the rest of the path after it; null when no parent exists */
function realpathOfNearest(p: string, realpath: (p: string) => string, path: PlatformPath): string | null {
  const rest: string[] = []
  let current = p
  for (;;) {
    try {
      return path.join(realpath(current), ...rest)
    } catch {
      // the path does not exist: its last name goes to the rest, and its parent is tried
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    rest.unshift(path.basename(current))
    current = parent
  }
}
