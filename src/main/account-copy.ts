import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// The copies of the carry-over and the rules for the links they meet. The source is only ever read; every write goes to
// the account, through a temporary name, and a link the account has is never written through.

/** how deep a copy goes into folders: a guard against folders that link to each other */
const MAX_DEPTH = 64

/**
 * what a copy keeps away from, all paths canonical: `source` is the source's config folder, `claudeJson` its .claude.json
 * (which may lie outside the folder), `carried` the paths of every item the source carries. `at` is the place of the copied
 * path as the item shows it (`foo/back`, '' for the item's root); `notes` collects the sub-lines of the links not carried.
 */
export interface CopyGuard {
  source?: string
  claudeJson?: string
  carried?: string[]
  sourceName?: string
  at?: string
  notes?: string[]
  depth?: number
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function tempName(file: string): string {
  return `${file}.ct-${randomBytes(6).toString('hex')}`
}

/** a path with its links resolved; the path as given when it cannot be resolved */
export async function canonicalOf(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

/** the path is the folder or inside it (case-insensitive on Windows, as the platform's path rules) */
function within(path: string, folder: string): boolean {
  const rel = relative(folder, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** removes a symlink or junction at path, never what it points to; a folder or file that is not a link stays */
async function removeLink(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null)
  if (info === null || !info.isSymbolicLink()) return
  await unlink(path).catch(() => rmdir(path))
}

/**
 * writes a file through a temporary name in its folder, then renames it over the target. The file keeps its permissions
 * (a .claude.json that holds carried values stays as private as it was); the temporary file is removed on failure
 */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const mode = await stat(file).then(
    (info) => info.mode & 0o777,
    () => null
  )
  const temp = tempName(file)
  try {
    await writeFile(temp, text, { flag: 'wx', mode: mode === null ? undefined : 0o600 })
    if (mode !== null) await chmod(temp, mode)
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function copyFileAs(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true })
  const temp = tempName(dst)
  try {
    await copyFile(src, temp)
    await rename(temp, dst)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false
  )
}

function nested(guard: CopyGuard): CopyGuard {
  return { ...guard, depth: (guard.depth ?? 0) + 1 }
}

/** a link that is not carried: its sub-line names it by its place in the item and it counts no file */
function skipLink(guard: CopyGuard, src: string, text: string): number {
  guard.notes?.push(`${guard.at || basename(src)}: ${text}`)
  return 0
}

/**
 * copies a symlink. Decided before the account is touched:
 * - a link to the source folder, to a folder holding it, or to a folder above the link is not carried;
 * - a link to the source's .claude.json is not carried;
 * - a link into the source folder is copied as its content when its target lies inside a carried item, and not carried otherwise;
 * - any other link is recreated with the same target (a relative one made absolute from the link's real folder).
 * When the system refuses the link, what it points to is copied instead.
 */
async function copyLink(src: string, dst: string, guard: CopyGuard): Promise<number> {
  const written = await readlink(src)
  const parent = await canonicalOf(dirname(src))
  const absolute = isAbsolute(written) ? written : resolve(parent, written)
  const reach = await canonicalOf(absolute)
  const here = join(parent, basename(src))
  const source = guard.source
  const name = guard.sourceName ?? 'the source'
  if (source !== undefined && within(source, reach)) return skipLink(guard, src, `a link to ${name}'s whole folder, not carried`)
  if (within(here, reach)) return skipLink(guard, src, 'a link to a folder above it, not carried')
  if (guard.claudeJson !== undefined && within(reach, guard.claudeJson) && within(guard.claudeJson, reach)) {
    return skipLink(guard, src, `a link to .claude.json in ${name}'s folder, not carried`)
  }
  if (source !== undefined && within(reach, source)) {
    if (guard.carried?.some((item) => within(reach, item))) return copyTree(reach, dst, nested(guard))
    const inside = relative(source, reach).split(sep).join('/')
    return skipLink(guard, src, `a link to ${inside} in ${name}'s folder, not carried`)
  }

  // the account's own entry is replaced only now that the link is carried
  await removeLink(dst)
  await mkdir(dirname(dst), { recursive: true })
  const temp = tempName(dst)
  // on Windows a directory link is a junction, which needs no privilege
  const kind = process.platform === 'win32' && (await isDirectory(absolute)) ? 'junction' : 'file'
  try {
    await symlink(absolute, temp, kind)
    await rename(temp, dst)
    return 1
  } catch {
    await rm(temp, { force: true }).catch(() => undefined)
    return copyTree(reach, dst, nested(guard))
  }
}

/** copies a file, a symlink or a folder's contents into dst, merging into what is there; nothing of dst is deleted */
export async function copyTree(src: string, dst: string, guard: CopyGuard = {}): Promise<number> {
  if ((guard.depth ?? 0) > MAX_DEPTH) return 0
  let info: Stats
  try {
    info = await lstat(src)
  } catch (error) {
    if (isNotFound(error)) return 0
    throw error
  }
  if (info.isSymbolicLink()) return copyLink(src, dst, guard)
  // what is at dst is replaced, never written through: a link there goes first
  await removeLink(dst)
  if (info.isDirectory()) {
    await mkdir(dst, { recursive: true })
    let copied = 0
    for (const name of await readdir(src)) {
      const at = guard.at ? `${guard.at}/${name}` : name
      copied += await copyTree(join(src, name), join(dst, name), { ...nested(guard), at })
    }
    return copied
  }
  if (!info.isFile()) return 0
  await copyFileAs(src, dst)
  return 1
}
