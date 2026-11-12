import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'
import type { GitRun } from '../git-source'
import { pathKey } from '../path-key'

// The files of a chat's folder, for the composer's @ picker: git's own list when the folder is in a repository, else a walk

/** a list older than this is read again */
const TTL_MS = 30_000
/** a repository's list is cut at this many paths */
const MAX_FILES = 20_000
/** the walk outside git stops at this many files, and at this many folders down */
const WALK_FILES = 5_000
const WALK_DEPTH = 6
/** folders the walk never enters */
const SKIP = new Set(['.git', 'node_modules'])

// the listing of each folder, as a promise: calls while it is being made share it
const cache = new Map<string, { at: number; files: Promise<string[]> }>()

/** the files of a folder, relative to it with '/': at most 20 000; cached 30 s per folder */
export function projectFiles(folder: string, run: GitRun): Promise<string[]> {
  const key = pathKey(folder)
  const now = Date.now()
  for (const [k, entry] of cache) {
    if (now - entry.at >= TTL_MS) cache.delete(k)
  }
  const hit = cache.get(key)
  if (hit) return hit.files
  const files = listFiles(folder, run)
  const entry = { at: now, files }
  cache.set(key, entry)
  // a listing that fails is not kept: the next call makes it again
  files.catch(() => {
    if (cache.get(key) === entry) cache.delete(key)
  })
  return files
}

/** git's list, else the walk */
async function listFiles(folder: string, run: GitRun): Promise<string[]> {
  return (await gitFiles(folder, run)) ?? (await walkFiles(folder))
}

/** the tracked files and the untracked ones git does not ignore; null when the folder is not in a repository */
async function gitFiles(folder: string, run: GitRun): Promise<string[] | null> {
  let r
  try {
    r = await run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], folder)
  } catch {
    return null
  }
  if (r.code !== 0) return null
  return r.stdout.toString('utf8').split('\0').filter(f => f !== '').slice(0, MAX_FILES)
}

/** a breadth-first walk of the folder: the files up to WALK_DEPTH folders down, the folders in SKIP left out */
async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = []
  let level: { dir: string; rel: string }[] = [{ dir: root, rel: '' }]
  for (let depth = 0; level.length > 0 && depth <= WALK_DEPTH && files.length < WALK_FILES; depth++) {
    const next: { dir: string; rel: string }[] = []
    for (const { dir, rel } of level) {
      if (files.length >= WALK_FILES) break
      const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => null)
      if (entries === null) continue
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isFile()) {
          if (files.length < WALK_FILES) files.push(path)
        } else if (entry.isDirectory() && depth < WALK_DEPTH) {
          next.push({ dir: join(dir, entry.name), rel: path })
        }
      }
    }
    level = next
  }
  return files
}

/** the letters of `q` in `s`, in order */
function isSubsequence(q: string, s: string): boolean {
  let i = 0
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++
  }
  return i === q.length
}

/** the files the query's letters match in order, ignoring case: a name hit first, then the shorter paths; at most `limit` */
export function matchFiles(files: string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase()
  const hits: { path: string; nameHit: number }[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    if (!isSubsequence(q, lower)) continue
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    hits.push({ path, nameHit: isSubsequence(q, name) ? 0 : 1 })
  }
  hits.sort((a, b) => a.nameHit - b.nameHit || a.path.length - b.path.length)
  return hits.slice(0, limit).map(hit => hit.path)
}
