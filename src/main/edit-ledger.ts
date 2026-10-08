import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathKey } from './path-key'

/** the largest file a snapshot keeps */
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024

export type SnapshotKind = 'absent' | 'blob' | 'binary' | 'too-large' | 'unreadable'

/** a file as it was right before Claude changed it */
export interface Snapshot {
  path: string
  /** ms since epoch: when ClaudeTerm read it, before the edit */
  at: number
  toolUseId: string
  kind: SnapshotKind
  /** sha1 of the content, when it was read: 'blob' (kept in blobs/) and 'binary' (the hash only) */
  sha: string | null
}

export type FileRead = { kind: 'absent' } | { kind: 'data'; data: Buffer } | { kind: 'too-large' } | { kind: 'unreadable' }

interface LedgerData {
  version: 1
  /** turns started in this session, by UserPromptSubmit */
  turn: number
  /** pathKey → the first snapshot in the session */
  session: Record<string, Snapshot>
  /** the latest turn that had edits: pathKey → its first snapshot in that turn */
  lastTurn: { turn: number; files: Record<string, Snapshot> } | null
  toolUseIds: string[]
}

export interface EditLedgerOptions {
  /** <dataDir>/review/<sessionId> */
  dir: string
  now(): number
  onError(message: string): void
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const KINDS: readonly string[] = ['absent', 'blob', 'binary', 'too-large', 'unreadable']
const isSnapshot = (v: unknown): v is Snapshot =>
  isObj(v) && typeof v.path === 'string' && typeof v.at === 'number' && typeof v.toolUseId === 'string' &&
  typeof v.kind === 'string' && KINDS.includes(v.kind) && (v.sha === null || typeof v.sha === 'string')
const isSnapshots = (v: unknown): v is Record<string, Snapshot> => isObj(v) && Object.values(v).every(isSnapshot)

function isLedgerData(v: unknown): v is LedgerData {
  if (!isObj(v) || v.version !== 1 || typeof v.turn !== 'number' || !isSnapshots(v.session)) return false
  if (!Array.isArray(v.toolUseIds) || !v.toolUseIds.every((x) => typeof x === 'string')) return false
  const lt = v.lastTurn
  return lt === null || (isObj(lt) && typeof lt.turn === 'number' && isSnapshots(lt.files))
}

/** a NUL byte in the first 8000 bytes, as git tells binary files */
export const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0)
/** names a file's content: snapshots, and the Viewed marks of the Changes panel */
export const contentSha = (b: Buffer): string => createHash('sha1').update(b).digest('hex')

/**
 * The files of one session as they were before Claude's first change in the session and in its latest turn
 * with edits. Kept in <dir>/ledger.json and <dir>/blobs/<sha1>, so a resumed session gets them back.
 */
export class EditLedger {
  private data: LedgerData = { version: 1, turn: 0, session: {}, lastTurn: null, toolUseIds: [] }
  private readonly seen = new Set<string>()
  /** blobs that could not be written: the ledger keeps working in memory */
  private readonly memBlobs = new Map<string, Buffer>()
  private failed = false

  constructor(private readonly o: EditLedgerOptions) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!isLedgerData(raw)) return
    this.data = raw
    for (const id of raw.toolUseIds) this.seen.add(id)
  }

  private get file(): string {
    return join(this.o.dir, 'ledger.json')
  }

  private blobPath(sha: string): string {
    return join(this.o.dir, 'blobs', sha)
  }

  startTurn(): void {
    this.data.turn += 1
    this.save()
  }

  /** Records the file before tool use `toolUseId` changes it. The first record per session and per turn wins. */
  recordBefore(toolUseId: string, path: string, read: () => FileRead): void {
    if (this.seen.has(toolUseId)) return
    this.seen.add(toolUseId)
    this.data.toolUseIds.push(toolUseId)
    if (!this.data.lastTurn || this.data.lastTurn.turn !== this.data.turn) {
      this.data.lastTurn = { turn: this.data.turn, files: {} }
    }
    const turnFiles = this.data.lastTurn.files
    const key = pathKey(path)
    const needSession = !(key in this.data.session)
    const needTurn = !(key in turnFiles)
    if (needSession || needTurn) {
      const snap = this.snapshot(toolUseId, path, read())
      if (needSession) this.data.session[key] = snap
      if (needTurn) turnFiles[key] = snap
    }
    this.save()
  }

  sessionSnapshots(): Snapshot[] {
    return Object.values(this.data.session)
  }

  /** null until Claude edits something in this session */
  lastTurnSnapshots(): Snapshot[] | null {
    return this.data.lastTurn ? Object.values(this.data.lastTurn.files) : null
  }

  has(toolUseId: string): boolean {
    return this.seen.has(toolUseId)
  }

  blobSize(sha: string): number | null {
    const mem = this.memBlobs.get(sha)
    if (mem) return mem.length
    try {
      return statSync(this.blobPath(sha)).size
    } catch {
      return null
    }
  }

  readBlob(sha: string): Buffer | null {
    const mem = this.memBlobs.get(sha)
    if (mem) return mem
    try {
      return readFileSync(this.blobPath(sha))
    } catch {
      return null
    }
  }

  private snapshot(toolUseId: string, path: string, r: FileRead): Snapshot {
    const base = { path, at: this.o.now(), toolUseId }
    if (r.kind !== 'data') return { ...base, kind: r.kind, sha: null }
    if (r.data.length > MAX_SNAPSHOT_BYTES) return { ...base, kind: 'too-large', sha: null }
    const sha = contentSha(r.data)
    // a binary file is kept by its hash only: enough to tell that it did not change (an edit that was denied)
    if (isBinary(r.data)) return { ...base, kind: 'binary', sha }
    try {
      const p = this.blobPath(sha)
      if (!existsSync(p)) {
        mkdirSync(join(this.o.dir, 'blobs'), { recursive: true })
        writeFileSync(p, r.data)
      }
    } catch (e) {
      this.fail(e)
      this.memBlobs.set(sha, r.data)
    }
    return { ...base, kind: 'blob', sha }
  }

  private save(): void {
    try {
      mkdirSync(this.o.dir, { recursive: true })
      // write and rename: a crash never leaves half a file, and the folder's time shows it is in use
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown): void {
    if (this.failed) return
    this.failed = true
    this.o.onError(`cannot save Claude's edits in ${this.o.dir}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
