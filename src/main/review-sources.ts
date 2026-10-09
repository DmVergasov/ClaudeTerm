import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { historyBaseline, type HistoryEdit } from './baselines'
import { contentSha, isBinary, MAX_SNAPSHOT_BYTES, type FileRead, type Snapshot } from './edit-ledger'
import { changedFiles, checkIgnored, execGit, headOrEmpty, numstat, readBlobs, repoRoot, revisionInfo, untrackedFiles, verifyRef, type GitChange, type GitRun, type RevInfo } from './git-source'
import { pathKey } from './path-key'
import { MAX_FILES, MAX_FORCED_BYTES, MAX_SIDE_BYTES, MAX_TOTAL_BYTES, type DiffInput, type Side } from './review-diff'

export type DiskInfo = { kind: 'file'; size: number } | { kind: 'absent' } | { kind: 'dir' } | { kind: 'unreadable' }

export interface SourceIo {
  git: GitRun
  diskInfo(path: string): DiskInfo
  /** null when the file cannot be read now */
  readDisk(path: string): Buffer | null
}

export const nodeIo: SourceIo = {
  git: execGit,
  diskInfo: (p) => {
    try {
      const st = statSync(p)
      return st.isDirectory() ? { kind: 'dir' } : { kind: 'file', size: st.size }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unreadable' }
    }
  },
  readDisk: (p) => {
    try {
      return readFileSync(p)
    } catch {
      return null
    }
  }
}

/** what a view needs from the edit ledger */
export interface LedgerView {
  sessionSnapshots(): Snapshot[]
  lastTurnSnapshots(): Snapshot[] | null
  has(toolUseId: string): boolean
  blobSize(sha: string): number | null
  readBlob(sha: string): Buffer | null
}

export const EMPTY_LEDGER: LedgerView = { sessionSnapshots: () => [], lastTurnSnapshots: () => null, has: () => false, blobSize: () => null, readBlob: () => null }

/** Claude's edits as the session's transcripts tell them */
export interface TranscriptLog {
  /** when each prompt was written: the turn starts */
  prompts: number[]
  /** not sorted: subagent transcripts are read after the main one */
  edits: HistoryEdit[]
}

export interface Inputs {
  inputs: DiffInput[]
  /** some files were not read, or not listed: the view is over its limits */
  tooMany: boolean
  /** files a view left out by name (absolute), never read: the hub counts them */
  excluded?: string[]
}

/** what the status bar counter shows */
export interface Totals {
  files: number
  additions: number
  deletions: number
}

/** where a view's files come from; the hub's tests replace it */
export interface ReviewSources {
  root(cwd: string): Promise<{ root: string } | { root: null; problem: string }>
  verify(root: string, ref: string): Promise<void>
  head(root: string): Promise<string>
  git(root: string, from: string, to: string | null, paths: string[], forced: (path: string) => boolean, exclude: (relPath: string) => boolean): Promise<Inputs>
  /** the files a ledger view would list, before any is read */
  ledgerPaths(ledger: LedgerView, log: TranscriptLog, scope: 'last_turn' | 'session'): string[]
  ledger(ledger: LedgerView, log: TranscriptLog, scope: 'last_turn' | 'session', base: string, forced: (path: string) => boolean, exclude: (path: string) => boolean): Inputs
  /** which of the files git ignores (absolute paths); a failure throws */
  ignored(root: string, paths: string[]): Promise<string[]>
  /** the uncommitted changes counted, without diffing them */
  totals(root: string): Promise<Totals>
  /** the file as it is now, for a snapshot */
  read(path: string): FileRead
}

/** a path relative to the base with /, or the full path when it is outside */
export function relPathFor(base: string, path: string): string {
  const r = relative(base, path)
  return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : path
}

export function readForSnapshot(io: SourceIo, path: string): FileRead {
  const info = io.diskInfo(path)
  if (info.kind === 'absent') return { kind: 'absent' }
  if (info.kind !== 'file') return { kind: 'unreadable' }
  if (info.size > MAX_SNAPSHOT_BYTES) return { kind: 'too-large' }
  const data = io.readDisk(path)
  return data ? { kind: 'data', data } : { kind: 'unreadable' }
}

/** the bytes a view has read so far */
class Budget {
  private used = 0
  exhausted = false

  take(bytes: number): boolean {
    if (this.exhausted) return false
    if (this.used > 0 && this.used + bytes > MAX_TOTAL_BYTES) {
      this.exhausted = true
      return false
    }
    this.used += bytes
    return true
  }
}

const limitOf = (forced: boolean): number => (forced ? MAX_FORCED_BYTES : MAX_SIDE_BYTES)

function sized(size: number, forced: boolean, budget: Budget, read: () => Buffer | null): Side {
  if (size > limitOf(forced)) return { kind: 'too-large', size }
  if (!budget.take(size)) return { kind: 'skipped' }
  const data = read()
  return data ? { kind: 'data', data } : { kind: 'unreadable' }
}

function diskSide(io: SourceIo, path: string, forced: boolean, budget: Budget): Side {
  const info = io.diskInfo(path)
  if (info.kind === 'absent') return { kind: 'absent' }
  if (info.kind === 'dir') return { kind: 'dir' }
  if (info.kind === 'unreadable') return { kind: 'unreadable' }
  return sized(info.size, forced, budget, () => io.readDisk(path))
}

const byPath = <T extends { path: string }>(a: T, b: T): number => a.path.localeCompare(b.path)

/** `exclude` takes a file's path inside the repository (with /) and names the files left out of the view: listed in `excluded`, not read, not counted against the limits */
export async function gitInputs(
  io: SourceIo, root: string, from: string, to: string | null, paths: string[], forced: (path: string) => boolean, exclude: (relPath: string) => boolean = () => false
): Promise<Inputs> {
  const listed = (await changedFiles(io.git, root, from, to, paths)).sort(byPath)
  // every path is the root and git's relative path: no path.relative per file
  const prefix = resolve(root).length
  const changes: GitChange[] = []
  const excluded: string[] = []
  for (const c of listed) {
    if (exclude(c.path.slice(prefix).replace(/^[\\/]+/, '').replaceAll(sep, '/'))) excluded.push(c.path)
    else changes.push(c)
  }
  const skipped = (c: GitChange): DiffInput => ({ path: c.path, relPath: relPathFor(root, c.path), before: { kind: 'skipped' }, after: { kind: 'skipped' }, forced: false, status: c.status })
  // an untracked node_modules is tens of thousands of files: the first ones are listed, the rest left out
  if (changes.length > MAX_FILES) return { inputs: changes.slice(0, MAX_FILES).map(skipped), tooMany: true, excluded }
  const all = changes.map((c) => c.path)
  const before = await revisionInfo(io.git, root, from, all)
  const after = to === null ? null : await revisionInfo(io.git, root, to, all)
  const budget = new Budget()
  const ids = new Set<string>()
  type Planned = Side | { kind: 'blob'; id: string }
  const plan = (info: RevInfo | undefined, f: boolean): Planned => {
    if (!info || info.kind === 'absent') return { kind: 'absent' }
    if (info.kind === 'dir') return { kind: 'dir' }
    if (info.size > limitOf(f)) return { kind: 'too-large', size: info.size }
    if (!budget.take(info.size)) return { kind: 'skipped' }
    ids.add(info.id)
    return { kind: 'blob', id: info.id }
  }
  const planned = changes.map((c) => {
    const f = forced(c.path)
    return { c, f, b: plan(before.get(c.path), f), a: after ? plan(after.get(c.path), f) : diskSide(io, c.path, f, budget) }
  })
  const blobs = await readBlobs(io.git, root, [...ids])
  const side = (p: Planned): Side => (p.kind === 'blob' ? { kind: 'data', data: blobs.get(p.id) ?? Buffer.alloc(0) } : p)
  return {
    inputs: planned.map(({ c, f, b, a }) => ({ path: c.path, relPath: relPathFor(root, c.path), before: side(b), after: side(a), forced: f, status: c.status })),
    tooMany: budget.exhausted,
    excluded
  }
}

interface FileHistory {
  path: string
  /** the ledger's first snapshot of the file in the view */
  snap: Snapshot | null
  /** edits the ledger did not see, before that snapshot, oldest first */
  history: HistoryEdit[]
}

function groupByFile(edits: HistoryEdit[]): Map<string, HistoryEdit[]> {
  const out = new Map<string, HistoryEdit[]>()
  for (const e of [...edits].sort((a, b) => a.at - b.at)) {
    const key = pathKey(e.path)
    const list = out.get(key)
    if (list) list.push(e)
    else out.set(key, [e])
  }
  return out
}

function sessionFiles(ledger: LedgerView, log: TranscriptLog): FileHistory[] {
  const snaps = new Map(ledger.sessionSnapshots().map((s) => [pathKey(s.path), s]))
  const unrecorded = groupByFile(log.edits.filter((e) => !ledger.has(e.toolUseId)))
  const out: FileHistory[] = []
  for (const key of new Set([...snaps.keys(), ...unrecorded.keys()])) {
    const snap = snaps.get(key) ?? null
    const edits = unrecorded.get(key) ?? []
    // an edit the hook missed after the first snapshot changes nothing: the snapshot is the session's start
    const history = edits.filter((e) => snap === null || e.at < snap.at)
    out.push({ path: snap?.path ?? edits[0]!.path, snap, history })
  }
  return out
}

function lastTurnFiles(ledger: LedgerView, log: TranscriptLog): FileHistory[] {
  const snaps = ledger.lastTurnSnapshots()
  if (snaps !== null) return snaps.map((s) => ({ path: s.path, snap: s, history: [] }))
  const prompts = [...log.prompts].sort((a, b) => a - b)
  const turnOf = (at: number): number => prompts.filter((p) => p <= at).length
  const edits = log.edits.filter((e) => !ledger.has(e.toolUseId))
  if (edits.length === 0) return []
  const last = Math.max(...edits.map((e) => turnOf(e.at)))
  return [...groupByFile(edits.filter((e) => turnOf(e.at) === last)).values()].map((h) => ({ path: h[0]!.path, snap: null, history: h }))
}

function snapSide(ledger: LedgerView, snap: Snapshot, forced: boolean, budget: Budget): Side {
  switch (snap.kind) {
    case 'absent': return { kind: 'absent' }
    case 'binary': return { kind: 'binary' }
    case 'too-large': return { kind: 'too-large', size: Number.POSITIVE_INFINITY }
    case 'unreadable': return { kind: 'none' }
    case 'blob': {
      const size = snap.sha ? ledger.blobSize(snap.sha) : null
      if (size === null || !snap.sha) return { kind: 'none' }
      const side = sized(size, forced, budget, () => ledger.readBlob(snap.sha!))
      return side.kind === 'unreadable' ? { kind: 'none' } : side
    }
  }
}

function snapText(ledger: LedgerView, snap: Snapshot): string | null {
  if (snap.kind !== 'blob' || !snap.sha) return null
  return ledger.readBlob(snap.sha)?.toString('utf8') ?? null
}

function diskText(io: SourceIo, path: string): string | null {
  const info = io.diskInfo(path)
  if (info.kind !== 'file' || info.size > MAX_FORCED_BYTES) return null
  return io.readDisk(path)?.toString('utf8') ?? null
}

function beforeSide(io: SourceIo, ledger: LedgerView, f: FileHistory, forced: boolean, budget: Budget): Side {
  if (f.history.length === 0) return f.snap ? snapSide(ledger, f.snap, forced, budget) : { kind: 'none' }
  // the content right after the last history edit: the first snapshot, or the file now
  const later = f.snap ? snapText(ledger, f.snap) : diskText(io, f.path)
  const b = historyBaseline(f.history, later)
  if (b.kind !== 'text') return { kind: b.kind }
  const data = Buffer.from(b.text, 'utf8')
  if (data.length > limitOf(forced)) return { kind: 'too-large', size: data.length }
  return budget.take(data.length) ? { kind: 'data', data } : { kind: 'skipped' }
}

/**
 * The file on disk holds exactly what the snapshot recorded: the edit was denied, or undone. Told by the hash,
 * so it works for binary files and files too large to diff as well.
 */
function unchanged(io: SourceIo, ledger: LedgerView, snap: Snapshot): boolean {
  if (snap.sha === null) return false
  const info = io.diskInfo(snap.path)
  if (info.kind !== 'file' || info.size > MAX_SNAPSHOT_BYTES) return false
  // a stored blob of another size cannot be the same content: no need to read the file
  if (snap.kind === 'blob' && ledger.blobSize(snap.sha) !== info.size) return false
  const data = io.readDisk(snap.path)
  return data !== null && contentSha(data) === snap.sha
}

/** the files a ledger view would list, before any is read */
export function ledgerPaths(ledger: LedgerView, log: TranscriptLog, scope: 'last_turn' | 'session'): string[] {
  return (scope === 'session' ? sessionFiles(ledger, log) : lastTurnFiles(ledger, log)).map((f) => f.path)
}

/** `exclude` names the files left out of the view: they are not read at all */
export function ledgerInputs(
  io: SourceIo, ledger: LedgerView, log: TranscriptLog, scope: 'last_turn' | 'session', base: string, forced: (path: string) => boolean,
  exclude: (path: string) => boolean = () => false
): Inputs {
  const files = (scope === 'session' ? sessionFiles(ledger, log) : lastTurnFiles(ledger, log)).filter((f) => !exclude(f.path)).sort(byPath)
  if (files.length > MAX_FILES) {
    const listed = files.slice(0, MAX_FILES)
    return { inputs: listed.map((f) => ({ path: f.path, relPath: relPathFor(base, f.path), before: { kind: 'skipped' }, after: { kind: 'skipped' }, forced: false, status: 'modified' })), tooMany: true }
  }
  const budget = new Budget()
  const inputs = files.flatMap((f): DiffInput[] => {
    if (f.history.length === 0 && f.snap !== null && unchanged(io, ledger, f.snap)) return []
    const fz = forced(f.path)
    return [{ path: f.path, relPath: relPathFor(base, f.path), before: beforeSide(io, ledger, f, fz, budget), after: diskSide(io, f.path, fz, budget), forced: fz }]
  })
  return { inputs, tooMany: budget.exhausted }
}

/** a file's lines as the diff counts them (a last line without a newline counts); none for a binary file */
export function lineCount(data: Buffer): number {
  if (data.length === 0 || isBinary(data)) return 0
  let n = 0
  for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a, at + 1)) n++
  return data[data.length - 1] === 0x0a ? n : n + 1
}

/**
 * The status bar counter in a repository while the panel shows another view: git's numstat against HEAD, and
 * untracked files by their lines. Like a view, only the first MAX_FILES untracked files are read, within its budget;
 * the others, and binary or too large files, count no lines.
 */
export async function gitTotals(io: SourceIo, root: string): Promise<Totals> {
  const tracked = await numstat(io.git, root, await headOrEmpty(io.git, root))
  const untracked = await untrackedFiles(io.git, root, [])
  let additions = 0
  let deletions = 0
  for (const c of tracked) {
    additions += c.additions
    deletions += c.deletions
  }
  const budget = new Budget()
  for (const path of untracked.slice(0, MAX_FILES)) {
    const info = io.diskInfo(path)
    if (info.kind !== 'file' || info.size > MAX_SIDE_BYTES || !budget.take(info.size)) continue
    const data = io.readDisk(path)
    if (data) additions += lineCount(data)
  }
  return { files: tracked.length + untracked.length, additions, deletions }
}

export function createSources(io: SourceIo): ReviewSources {
  return {
    root: async (cwd) => {
      try {
        const root = await repoRoot(io.git, cwd)
        return root ? { root } : { root: null, problem: 'Not a git repository' }
      } catch (e) {
        return { root: null, problem: e instanceof Error ? e.message : String(e) }
      }
    },
    verify: async (root, ref) => {
      await verifyRef(io.git, root, ref)
    },
    head: (root) => headOrEmpty(io.git, root),
    git: (root, from, to, paths, forced, exclude) => gitInputs(io, root, from, to, paths, forced, exclude),
    ledgerPaths,
    ledger: (ledger, log, scope, base, forced, exclude) => ledgerInputs(io, ledger, log, scope, base, forced, exclude),
    ignored: (root, paths) => checkIgnored(io.git, root, paths),
    totals: (root) => gitTotals(io, root),
    read: (path) => readForSnapshot(io, path)
  }
}
