import { posix, win32, type PlatformPath } from 'node:path'

/** node:path of the platform the app runs on. Functions take the flavour as a parameter, so tests can run both anywhere. */
export const nativePath: PlatformPath = process.platform === 'win32' ? win32 : posix

/** A path as a map key: Windows paths compare without case, Linux paths with it. */
export function pathKey(p: string, path: PlatformPath = nativePath): string {
  const n = path.normalize(p)
  return path.sep === '\\' ? n.toLowerCase() : n
}

/** C:\…, C:/… or \\server\share: a path Git Bash wants with forward slashes */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}
