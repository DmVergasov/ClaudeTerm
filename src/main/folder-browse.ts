import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { PlatformPath } from 'node:path'
import type { DeviceResult } from '../shared/devices'
import { MAX_FOLDER_ENTRIES, MAX_PATH_TEXT, RECENT_FOLDER_COUNT, REMOTE_COPY, type FolderListing, type FolderResult } from '../shared/remote'
import type { SessionSummary } from '../shared/types'
import { nativePath, pathKey } from './path-key'

// "Change folder…" reads folders on the device that owns the tab, by that device's own system: the listing of a folder's
// subfolders, the check of a typed folder, the folders of the latest sessions, and the two calls the tab's device answers
// (the listing and the move). The input is text as the user typed it.

/** the names a folder listing takes: a name the receiver would refuse is left out */
const MAX_NAME = 255
const MAX_DEVICE = 64
const DEVICE_FALLBACK = 'device'
/** the links of a folder are checked this many at a time */
const STAT_AT_ONCE = 8
/**
 * a local listing that takes longer is an unreadable folder: a share that does not answer must not hang the window. It is
 * below CALL_TIMEOUT_MS (10 s), so a device's own message reaches the other device before "did not answer" does.
 */
const LIST_LIMIT_MS = 8_000
/** the folder names are sorted with one collator: it is built once, as the sort runs on the main process */
const COLLATE = new Intl.Collator(undefined, { sensitivity: 'base' })

export interface FolderFs {
  stat(p: string): Promise<{ isDirectory(): boolean }>
  readdir(p: string, o: { withFileTypes: true }): Promise<Dirent[]>
}

const nodeFs: FolderFs = { stat, readdir }

type Resolved = { ok: true; path: string } | { ok: false; error: string }

/**
 * The folder a typed path names, by this system's rules: trimmed; `~` alone or followed by a separator is the home folder;
 * a rooted path with no drive (`\work` on Windows) is on the home folder's drive; the path must be absolute, and it is
 * resolved (`..` and trailing separators go). A path over MAX_PATH_TEXT is not absolute to the receiver. A missing folder,
 * or a file, is the dialog's message for a folder that does not exist; a folder that cannot be looked at is unreadable.
 */
async function resolveFolder(input: string, o: { home: string; fs: FolderFs; path: PlatformPath }): Promise<Resolved> {
  const typed = input.trim()
  const rest = typed === '~' ? '' : typed.startsWith('~/') || typed.startsWith('~\\') ? typed.slice(2) : null
  const full = rest !== null ? o.path.join(o.home, rest) : rootedWithoutDrive(typed, o.path) ? o.path.resolve(o.home, typed) : typed
  if (!o.path.isAbsolute(full)) return { ok: false, error: REMOTE_COPY.folderNotAbsolute }
  const resolved = o.path.resolve(full)
  if (resolved.length > MAX_PATH_TEXT) return { ok: false, error: REMOTE_COPY.folderNotAbsolute }
  try {
    if ((await o.fs.stat(resolved)).isDirectory()) return { ok: true, path: resolved }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { ok: false, error: code === 'EACCES' || code === 'EPERM' ? REMOTE_COPY.folderUnreadable : REMOTE_COPY.folderMissing }
  }
  return { ok: false, error: REMOTE_COPY.folderMissing }
}

/** a Windows path that starts with one separator and no drive: `\work`, `/Users/x` (not a UNC path `\\server`) */
function rootedWithoutDrive(typed: string, path: PlatformPath): boolean {
  return path.sep === '\\' && /^[\\/](?![\\/])/.test(typed)
}

/** the folder a typed path names, checked; the path is the one to change to */
export async function checkFolder(input: string, o: { home: string; fs?: FolderFs; path?: PlatformPath }): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  return resolveFolder(input, { home: o.home, fs: o.fs ?? nodeFs, path: o.path ?? nativePath })
}

/**
 * The subfolders of a typed folder, by name, sorted, with the folder's parent and the recent folders the caller gives.
 * Everything the receiver checks is checked here first: a name with a separator or NUL, or over 255 characters, is left
 * out; the device is cut to 64 characters; the recent folders are the ones that fit, at most RECENT_FOLDER_COUNT.
 * A listing that does not finish in LIST_LIMIT_MS is an unreadable folder.
 */
export async function listFolder(input: string, o: { home: string; device: string; recent: string[]; fs?: FolderFs; path?: PlatformPath }): Promise<FolderResult> {
  return within(listNow(input, o), LIST_LIMIT_MS, { ok: false, error: REMOTE_COPY.folderUnreadable })
}

async function listNow(input: string, o: { home: string; device: string; recent: string[]; fs?: FolderFs; path?: PlatformPath }): Promise<FolderResult> {
  const path = o.path ?? nativePath
  const fs = o.fs ?? nodeFs
  const at = await resolveFolder(input, { home: o.home, fs, path })
  if (!at.ok) return at
  let entries: Dirent[]
  try {
    entries = await fs.readdir(at.path, { withFileTypes: true })
  } catch {
    return { ok: false, error: REMOTE_COPY.folderUnreadable }
  }
  const parent = path.dirname(at.path)
  const listing: FolderListing = {
    device: deviceName(o.device),
    path: at.path,
    sep: path.sep === '\\' ? '\\' : '/',
    parent: parent === at.path ? null : parent,
    folders: await folderNames(entries, at.path, fs, path),
    recent: o.recent.filter(fitsText).slice(0, RECENT_FOLDER_COUNT)
  }
  return { ok: true, listing }
}

/** the folders of a listing: the folders, and the links whose target is a folder; sorted, at most MAX_FOLDER_ENTRIES */
async function folderNames(entries: Dirent[], dir: string, fs: FolderFs, path: PlatformPath): Promise<string[]> {
  const names: string[] = []
  const links: string[] = []
  for (const e of entries) {
    if (!nameFits(e.name)) continue
    if (e.isDirectory()) names.push(e.name)
    else if (e.isSymbolicLink()) links.push(e.name)
  }
  for (let i = 0; i < links.length; i += STAT_AT_ONCE) {
    const batch = links.slice(i, i + STAT_AT_ONCE)
    const folders = await Promise.all(batch.map((n) => isFolder(fs, path.join(dir, n))))
    batch.forEach((n, j) => {
      if (folders[j]) names.push(n)
    })
  }
  return names.sort((a, b) => COLLATE.compare(a, b)).slice(0, MAX_FOLDER_ENTRIES)
}

/** a link's target is a folder: a link to a file, a dangling link and a link loop are not */
async function isFolder(fs: FolderFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** a folder name the receiver takes: 1 to 255 characters, no separator and no NUL */
function nameFits(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_NAME && !/[/\\\u0000]/.test(name)
}

/** a path as the listing and the recent folders take it: 1 to MAX_PATH_TEXT characters, no NUL */
function fitsText(p: string): boolean {
  return p.length >= 1 && p.length <= MAX_PATH_TEXT && !p.includes('\u0000')
}

/** the device's name for the listing: NUL removed, cut to 64 characters without splitting a surrogate pair; the fallback when empty */
function deviceName(name: string): string {
  const clean = name.replace(/\u0000/g, '')
  let end = Math.min(clean.length, MAX_DEVICE)
  if (end < clean.length && isHighSurrogate(clean.charCodeAt(end - 1))) end--
  const cut = clean.slice(0, end)
  return cut.length > 0 ? cut : DEVICE_FALLBACK
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** `work` or the time limit: the late answer is the given one */
function within<T>(work: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

/**
 * The folders of the latest sessions, newest first, each folder once by its pathKey, at most RECENT_FOLDER_COUNT. A
 * folder that is empty, too long or holds a NUL is left out.
 */
export function recentFolders(sessions: readonly SessionSummary[], path: PlatformPath = nativePath): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt)) {
    if (out.length >= RECENT_FOLDER_COUNT) break
    if (!fitsText(s.cwd)) continue
    const key = pathKey(s.cwd, path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s.cwd)
  }
  return out
}

/** what the tab-facing calls read of this device: the tab's folder, the device's name, the history and the tab manager's move */
export interface TabFolderDeps {
  home: string
  /** the folder the tab works in; null when no such tab is open here */
  tabFolder(tabId: string): string | null
  /** the device's name in the group, else this computer's host name */
  device(): string
  /** the sessions of the history, newest first */
  sessions(): Promise<SessionSummary[]>
  /** moves the tab to the folder and starts it there; false when the tab cannot move */
  changeFolder(tabId: string, path: string): Promise<boolean>
  fs?: FolderFs
  path?: PlatformPath
}

/**
 * The listing of a tab's folder (null: the tab's own) on this device. Only the first listing, of the tab's own folder,
 * carries the recent folders; a listing of another folder sends none.
 */
export async function folderListingOf(tabId: string, path: string | null, deps: TabFolderDeps): Promise<FolderResult> {
  const folder = deps.tabFolder(tabId)
  if (folder === null) return { ok: false, error: REMOTE_COPY.unknownTab }
  const recent = path === null ? recentFolders(await deps.sessions(), deps.path) : []
  return listFolder(path ?? folder, { home: deps.home, device: deps.device(), recent, fs: deps.fs, path: deps.path })
}

/** moves a tab to a folder typed for it: the folder is checked here first; a refused move is the dialog's message */
export async function changeFolderOf(tabId: string, path: string, deps: TabFolderDeps): Promise<DeviceResult> {
  const found = await checkFolder(path, { home: deps.home, fs: deps.fs, path: deps.path })
  if (!found.ok) return found
  return (await deps.changeFolder(tabId, found.path)) ? { ok: true } : { ok: false, error: REMOTE_COPY.folderChangeFailed }
}
