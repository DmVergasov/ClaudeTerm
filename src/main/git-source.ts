import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathKey } from './path-key'

export interface GitResult {
  code: number
  stdout: Buffer
  stderr: string
}

export type GitRun = (args: string[], cwd: string, input?: string) => Promise<GitResult>

export class GitError extends Error {}

export const GIT_TIMEOUT_MS = 10_000
/** git's id of the empty tree: what a repository without commits is compared with */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_OUTPUT = 64 * 1024 * 1024

/**
 * git without a shell; stdout raw (paths and contents are bytes), a time limit, input on stdin. No fsmonitor command
 * the repository configures, and no optional index lock that could collide with Claude's own git add or commit. The file system
 * cache of Git for Windows is forced on (its default; other gits ignore the key): `git status` is slow without it.
 */
export const execGit: GitRun = (args, cwd, input) =>
  new Promise((done, fail) => {
    const name = args.find((a) => !a.startsWith('-')) ?? 'git'
    const child = spawn('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.fscache=true', '--no-optional-locks', ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let size = 0
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      fail(new GitError(`git ${name} took longer than ${GIT_TIMEOUT_MS / 1000} s`))
    }, GIT_TIMEOUT_MS)
    child.stdout.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_OUTPUT) {
        child.kill()
        fail(new GitError(`git ${name}: output too large`))
        return
      }
      out.push(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4096) err += c.toString('utf8')
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      fail(e.code === 'ENOENT' ? new GitError('git was not found') : new GitError(`cannot run git: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err })
    })
    child.stdin.on('error', () => { /* git exited before reading everything */ })
    child.stdin.end(input ?? '')
  })

/** the work tree root holding `cwd`; null outside a repository or when the folder is gone */
export async function repoRoot(run: GitRun, cwd: string): Promise<string | null> {
  // spawning in a missing folder fails like a missing git
  if (!existsSync(cwd)) return null
  const r = await run(['rev-parse', '--show-toplevel'], cwd)
  const out = r.stdout.toString('utf8').trim()
  return r.code === 0 && out ? resolve(out) : null
}

/** the commit a revision names; GitError "unknown revision: <ref>" when there is none */
export async function verifyRef(run: GitRun, root: string, ref: string): Promise<string> {
  if (ref.startsWith('-')) throw new GitError(`unknown revision: ${ref}`)
  const r = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], root)
  const sha = r.stdout.toString('utf8').trim()
  if (r.code !== 0 || !sha) throw new GitError(`unknown revision: ${ref}`)
  return sha
}

/** HEAD's commit, or the empty tree in a repository without commits */
export async function headOrEmpty(run: GitRun, root: string): Promise<string> {
  try {
    return await verifyRef(run, root, 'HEAD')
  } catch (e) {
    if (e instanceof GitError && e.message.startsWith('unknown revision')) return EMPTY_TREE
    throw e
  }
}

export type ChangeStatus = 'added' | 'modified' | 'deleted'

export interface GitChange {
  /** absolute */
  path: string
  status: ChangeStatus
}

/** paths inside the work tree, relative to its root with / */
function toSpecs(root: string, paths: string[]): string[] {
  return paths.map((p) => {
    const r = relative(root, p)
    if (r.startsWith('..') || isAbsolute(r)) throw new GitError(`outside the repository: ${p}`)
    return r === '' ? '.' : r.split(sep).join('/')
  })
}

/** Files that differ between `from` and `to` — the work tree, untracked files included, when `to` is null. */
export async function changedFiles(run: GitRun, root: string, from: string, to: string | null, paths: string[]): Promise<GitChange[]> {
  const specs = toSpecs(root, paths)
  // --literal-pathspecs: a file named x[1].ts is that file, not a pattern
  const diff = await run(['--literal-pathspecs', 'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', from, ...(to ? [to] : []), '--', ...specs], root)
  if (diff.code !== 0) throw new GitError(`git diff failed: ${diff.stderr.trim()}`)
  const parts = diff.stdout.toString('utf8').split('\0')
  const changes: GitChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]!
    const rel = parts[i + 1]!
    if (!code || !rel) continue
    changes.push({ path: resolve(root, rel), status: code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'modified' })
  }
  if (to === null) for (const path of await untrackedFiles(run, root, paths)) changes.push({ path, status: 'added' })
  return changes
}

/**
 * Untracked files that are not ignored, absolute. `git status` rather than `ls-files --others`: in a repository of tens of
 * thousands of files it takes a third of the time with Git for Windows' file system cache (core.fscache, set by execGit). Entries are `XY path` NUL-separated (no second path with --no-renames); only `??` counts.
 */
export async function untrackedFiles(run: GitRun, root: string, paths: string[]): Promise<string[]> {
  const r = await run(['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all', '--', ...toSpecs(root, paths)], root)
  if (r.code !== 0) throw new GitError(`git status failed: ${r.stderr.trim()}`)
  return r.stdout.toString('utf8').split('\0').filter((e) => e.startsWith('?? ') && e.length > 3).map((e) => resolve(root, e.slice(3)))
}

/**
 * Which of the files git ignores, one `git check-ignore`. Without --no-index: a tracked file is never ignored. Files outside
 * the work tree are not asked about and not reported. Absolute paths in, the same strings out.
 */
export async function checkIgnored(run: GitRun, root: string, paths: string[]): Promise<string[]> {
  const asked = new Map<string, string>()
  for (const p of paths) {
    const r = relative(root, p)
    if (r && !r.startsWith('..') && !isAbsolute(r)) asked.set(r.split(sep).join('/'), p)
  }
  if (asked.size === 0) return []
  const ask = (rels: string[]): Promise<GitResult> => run(['check-ignore', '-z', '--stdin'], root, rels.map((rel) => rel + '\0').join(''))
  const all = [...asked.keys()]
  let r = await ask(all)
  if (r.code !== 0 && r.code !== 1) {
    // git refuses a path inside a submodule (another repository) and fails the whole call: leave those paths out, ask once more
    const inside = (await submodulePaths(run, root)).map((s) => pathKey(s))
    const rest = all.filter((rel) => !inside.some((s) => pathKey(rel) === s || pathKey(rel).startsWith(s + sep)))
    if (rest.length < all.length) {
      if (rest.length === 0) return []
      r = await ask(rest)
    }
  }
  // 1: none of them is ignored
  if (r.code === 1) return []
  if (r.code !== 0) throw new GitError(`git check-ignore failed: ${r.stderr.trim()}`)
  return r.stdout.toString('utf8').split('\0').flatMap((rel) => asked.get(rel) ?? [])
}

/** the submodules' folders, relative to the root; none without a .gitmodules */
async function submodulePaths(run: GitRun, root: string): Promise<string[]> {
  const r = await run(['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], root)
  if (r.code !== 0) return []
  // "submodule.<name>.path", a newline, the folder
  return r.stdout.toString('utf8').split('\0').flatMap((entry) => (entry.includes('\n') ? [entry.slice(entry.indexOf('\n') + 1)] : []))
}

export interface LineCounts {
  /** absolute */
  path: string
  additions: number
  deletions: number
}

/** Lines added and removed in each file between `from` and the work tree, untracked files not included: one `git diff --numstat`. A binary file counts none. */
export async function numstat(run: GitRun, root: string, from: string): Promise<LineCounts[]> {
  const r = await run(['--literal-pathspecs', 'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', from, '--'], root)
  if (r.code !== 0) throw new GitError(`git diff failed: ${r.stderr.trim()}`)
  const out: LineCounts[] = []
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec)
    if (m) out.push({ path: resolve(root, m[3]!), additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) })
  }
  return out
}

export type RevInfo = { kind: 'blob'; id: string; size: number } | { kind: 'absent' } | { kind: 'dir' }

/** What each path is in `rev`, with blob sizes: one `git cat-file --batch-check`. */
export async function revisionInfo(run: GitRun, root: string, rev: string, paths: string[]): Promise<Map<string, RevInfo>> {
  const info = new Map<string, RevInfo>()
  if (paths.length === 0) return info
  const specs = toSpecs(root, paths)
  const r = await run(['cat-file', '--batch-check'], root, specs.map((s) => `${rev}:${s}\n`).join(''))
  if (r.code !== 0) throw new GitError(`git cat-file failed: ${r.stderr.trim()}`)
  const lines = r.stdout.toString('utf8').split('\n')
  paths.forEach((p, i) => {
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(lines[i] ?? '')
    if (!m) info.set(p, { kind: 'absent' })
    else if (m[2] === 'blob') info.set(p, { kind: 'blob', id: m[1]!, size: Number(m[3]) })
    else info.set(p, { kind: 'dir' }) // a tree, or a submodule's commit
  })
  return info
}

/** Blob contents by id: one `git cat-file --batch`. */
export async function readBlobs(run: GitRun, root: string, ids: string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>()
  if (ids.length === 0) return blobs
  const r = await run(['cat-file', '--batch'], root, ids.map((id) => `${id}\n`).join(''))
  if (r.code !== 0) throw new GitError(`git cat-file failed: ${r.stderr.trim()}`)
  const out = r.stdout
  let pos = 0
  for (const id of ids) {
    const nl = out.indexOf(0x0a, pos)
    if (nl < 0) throw new GitError('git cat-file returned less than asked')
    const m = /^[0-9a-f]+ \w+ (\d+)$/.exec(out.subarray(pos, nl).toString('utf8'))
    if (!m) throw new GitError('git cat-file returned an unexpected header')
    const size = Number(m[1])
    blobs.set(id, Buffer.from(out.subarray(nl + 1, nl + 1 + size)))
    pos = nl + 1 + size + 1
  }
  return blobs
}
