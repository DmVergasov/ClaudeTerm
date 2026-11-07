import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MAX_TRANSFER_BYTES, REMOTE_COPY } from '../../shared/remote'
import { pathKey } from '../path-key'
import { CallError } from './calls'

// The files pasted or dropped into a remote tab, received on the tab's device. Each transfer gets a new folder under the
// root. Its files are opened at their first part and closed once complete, so one file is open at a time, and they come in
// order. A transfer belongs to the device that began it; it ends, or is dropped at its idle time, its deadline or when its
// device goes away, and then its files and folder are removed.

/** the transfers open at once, and the most one device holds of them; a begin past either is refused as busy */
const MAX_OPEN = 4
const MAX_PER_OWNER = 2
/** the transfers the deadline or the idle time stopped, remembered so that a late part says it took too long */
const MAX_STOPPED = 16
const IDLE_MS = 60_000
/** a transfer's deadline: the longer of this and its size at the rate below */
const MIN_DEADLINE_MS = 2 * 60_000
const BYTES_PER_SECOND = 256 * 1024
/** the longest name kept, in UTF-8 bytes */
const MAX_NAME_BYTES = 200
const MAX_EXT_LENGTH = 10
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u2018-\u201f\u202a-\u202e\u2066-\u2069<>:"|?*$\\`';&!%]/g
const EDGE_DOTS_SPACES_RE = /^[. ]+|[. ]+$/g
const RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i
/** the refusal of a part or an end that does not fit the transfer: only a broken or hostile sender sends one */
const BAD_ARGUMENTS = 'bad arguments'

/** the name a sent name is saved under on this device: the part after the last separator, with what no file name may hold made plain */
export function plainName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  let s = trimEdges(base.replace(UNSAFE_RE, '_'))
  // the cut leaves one byte for the prefix of a reserved name below, so the prefixed name is still within the limit
  if (Buffer.byteLength(s) > MAX_NAME_BYTES - 1) s = cutBytes(s, MAX_NAME_BYTES - 1)
  // the cut can leave a dot or a space at the end: Windows drops them, so two names would become one
  s = trimEdges(s)
  if (s === '') s = 'file'
  // Windows refuses a reserved name whatever its extension, and with trailing spaces before the dot: checked after the cut
  if (RESERVED_RE.test(s.split('.')[0].replace(/ +$/, ''))) s = `_${s}`
  return s
}

function trimEdges(s: string): string {
  return s.replace(EDGE_DOTS_SPACES_RE, '')
}

/** the name cut to `max` UTF-8 bytes, at a character boundary, keeping its extension */
function cutBytes(s: string, max: number): string {
  const ext = extOf(s)
  const room = max - Buffer.byteLength(ext)
  let out = ''
  for (const ch of s.slice(0, s.length - ext.length)) {
    if (Buffer.byteLength(out + ch) > room) break
    out += ch
  }
  return out + ext
}

/** the extension of a name, its dot included: up to MAX_EXT_LENGTH characters after the last dot that is not the first character */
function extOf(s: string): string {
  const i = s.lastIndexOf('.')
  if (i <= 0) return ''
  const ext = s.slice(i)
  return ext.length - 1 <= MAX_EXT_LENGTH ? ext : ''
}

/** the names made unique in their order: a name taken already (without case) becomes `name (2).ext`, then (3) and so on */
function uniqueNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((n) => {
    const ext = extOf(n)
    const stem = n.slice(0, n.length - ext.length)
    let name = n
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${stem} (${k})${ext}`
    used.add(name.toLowerCase())
    return name
  })
}

interface OpenFile {
  path: string
  size: number
  /** the offset the next part must come at: the bytes before it are written (or being written) */
  next: number
  /** open from the file's first part until its last byte is written; null before and after */
  handle: FileHandle | null
}

interface Transfer {
  owner: string
  dir: string
  files: OpenFile[]
  /** the parts being written now: the transfer does not end while one is */
  writing: number
  /** restarted by every part: the transfer is dropped when nothing comes for idleMs */
  timer: ReturnType<typeof setTimeout> | null
  /** set at begin, never restarted: the transfer is dropped at it even while parts keep coming */
  deadline: ReturnType<typeof setTimeout> | null
}

export class FileReceiver {
  private readonly root: string
  private readonly idleMs: number
  private readonly maxBytes: number
  private readonly minDeadlineMs: number
  private readonly bytesPerSecond: number
  private readonly log: (m: string) => void
  private readonly transfers = new Map<string, Transfer>()
  /** the transfers being begun, by owner and in all: they count against the limits from the moment they start */
  private readonly openingBy = new Map<string, number>()
  private opening = 0
  /** bumped by abandon(owner) while that owner has a begin in flight: the begin then keeps nothing */
  private readonly generations = new Map<string, number>()
  /** the transfers the deadline or the idle time stopped, the last MAX_STOPPED, with their owners */
  private readonly stopped: { id: string; owner: string }[] = []
  private disposed = false

  constructor(o: { root: string; idleMs?: number; maxBytes?: number; minDeadlineMs?: number; bytesPerSecond?: number; log?: (m: string) => void }) {
    this.root = o.root
    this.idleMs = o.idleMs ?? IDLE_MS
    this.maxBytes = o.maxBytes ?? MAX_TRANSFER_BYTES
    this.minDeadlineMs = o.minDeadlineMs ?? MIN_DEADLINE_MS
    this.bytesPerSecond = o.bytesPerSecond ?? BYTES_PER_SECOND
    this.log = o.log ?? (() => {})
  }

  /**
   * A new folder under the root for these files. Refused as busy past MAX_OPEN transfers in all or MAX_PER_OWNER of this
   * owner's; too large past maxBytes; unsafe when the folders are not real folders of this user. Every failure of the
   * folder work is receiveFailed, and nothing is left behind by one.
   */
  async begin(files: { name: string; size: number }[], owner: string): Promise<string> {
    if (this.disposed) throw new CallError(REMOTE_COPY.receiveFailed)
    if (this.transfers.size + this.opening >= MAX_OPEN || this.countOf(owner) >= MAX_PER_OWNER) throw new CallError(REMOTE_COPY.receiveBusy)
    const total = files.reduce((n, f) => n + f.size, 0)
    if (total > this.maxBytes) throw new CallError(REMOTE_COPY.receiveTooLarge)
    const generation = this.generationOf(owner)
    this.opening++
    this.openingBy.set(owner, (this.openingBy.get(owner) ?? 0) + 1)
    try {
      return await this.create(files, owner, total, generation)
    } finally {
      this.opening--
      const left = (this.openingBy.get(owner) ?? 1) - 1
      if (left > 0) this.openingBy.set(owner, left)
      else this.openingBy.delete(owner)
    }
  }

  /** the folder and the files of a transfer, registered when nothing has happened to its owner or the receiver meanwhile */
  private async create(files: { name: string; size: number }[], owner: string, total: number, generation: number): Promise<string> {
    let dir: string | null = null
    try {
      await this.folders(true)
      const made = await mkdtemp(join(this.root, 't-'))
      dir = made
      const names = uniqueNames(files.map((f) => plainName(f.name)))
      const list: OpenFile[] = files.map((f, i) => ({ path: join(made, names[i]), size: f.size, next: 0, handle: null }))
      // an empty file has no part to open it at: it is made here
      for (const f of list) {
        if (f.size !== 0) continue
        const handle = await open(f.path, 'wx')
        await handle.close()
      }
      // the awaits above: a dispose or an abandon of the owner meanwhile means nothing is kept
      if (this.disposed || this.generationOf(owner) !== generation) throw new CallError(REMOTE_COPY.receiveFailed)
      const id = randomUUID()
      this.transfers.set(id, { owner, dir: made, files: list, writing: 0, timer: null, deadline: null })
      this.touch(id)
      this.setDeadline(id, total)
      return id
    } catch (e) {
      if (dir !== null) await removeDir(dir, this.log)
      if (e instanceof CallError) throw e
      throw new CallError(REMOTE_COPY.receiveFailed)
    }
  }

  /**
   * Writes a part of one file at the offset the file is at. The files come in order: every file before this one is complete.
   * A part that does not fit is refused as bad arguments; a failed write drops the transfer.
   */
  async part(transfer: string, file: number, offset: number, data: Buffer, owner: string): Promise<void> {
    const t = this.ownTransfer(transfer, owner)
    const f = t.files[file]
    if (!f || t.files.slice(0, file).some((g) => g.next !== g.size)) throw new CallError(BAD_ARGUMENTS)
    if (data.length === 0 || offset !== f.next || offset + data.length > f.size) throw new CallError(BAD_ARGUMENTS)
    f.next = offset + data.length
    t.writing++
    this.touch(transfer)
    try {
      await this.writePart(transfer, t, f, offset, data)
    } catch (e) {
      if (e instanceof CallError) throw e
      // the transfer was ended or dropped while the part was written: that is the answer
      if (this.transfers.get(transfer) !== t) throw this.goneFor(transfer, owner)
      void this.drop(transfer)
      throw new CallError(REMOTE_COPY.receiveFailed)
    } finally {
      t.writing--
    }
  }

  /** opens the file at its first part, writes the bytes, and closes the file once its last byte is written */
  private async writePart(transfer: string, t: Transfer, f: OpenFile, offset: number, data: Buffer): Promise<void> {
    if (!f.handle) {
      if (pathKey(dirname(f.path)) !== pathKey(t.dir)) throw new Error('file outside its folder')
      const handle = await open(f.path, 'wx')
      if (this.transfers.get(transfer) !== t) {
        await handle.close().catch(() => {})
        // the drop's removal may have been refused while this handle was open: the folder goes now that it is closed
        await removeDir(t.dir, this.log)
        throw this.goneFor(transfer, t.owner)
      }
      f.handle = handle
    }
    const { bytesWritten } = await f.handle.write(data, 0, data.length, offset)
    if (bytesWritten !== data.length) throw new Error('short write')
    // a drop that came while the write was pending: the close waited for it, so the part is on disk, but the transfer is gone
    if (this.transfers.get(transfer) !== t) throw this.goneFor(transfer, t.owner)
    if (f.next === f.size) {
      // a drop that came meanwhile has closed the file already
      const handle = f.handle
      f.handle = null
      if (handle) await handle.close()
    }
  }

  /** ends a transfer whose files are all complete: its files are kept, and their paths are the answer */
  async end(transfer: string, owner: string): Promise<string[]> {
    const t = this.ownTransfer(transfer, owner)
    if (t.writing > 0 || t.files.some((f) => f.next !== f.size)) throw new CallError(BAD_ARGUMENTS)
    this.release(transfer)
    await closeAll(t.files, this.log)
    return t.files.map((f) => f.path)
  }

  /**
   * Removes the t- folders under the root that are older than maxAgeMs and are real folders, except the ones of open
   * transfers. A link inside the root is left alone and never followed. Nothing is removed when the root or its parent is
   * not a real folder of this user, or is missing.
   */
  async cleanup(maxAgeMs: number): Promise<void> {
    try {
      if (!(await this.folders(false))) return
    } catch {
      return
    }
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return
    }
    const now = Date.now()
    const open = new Set([...this.transfers.values()].map((t) => pathKey(t.dir)))
    for (const e of entries) {
      if (!e.startsWith('t-')) continue
      const p = join(this.root, e)
      if (open.has(pathKey(p))) continue
      try {
        const st = await lstat(p)
        if (st.isDirectory() && now - st.mtimeMs > maxAgeMs) await rm(p, { recursive: true, force: true })
      } catch {
        // an entry that goes away or cannot be read is left as it is
      }
    }
  }

  /** the transfers of one owner end: its link is gone, so nothing more comes for them. Their files and folders are removed. */
  abandon(owner: string): void {
    if (this.openingBy.has(owner)) this.generations.set(owner, this.generationOf(owner) + 1)
    for (const [id, t] of this.transfers) if (t.owner === owner) void this.drop(id)
  }

  /** closes every open file and removes the unfinished folders; later transfers are refused. Best effort: a failure is logged. */
  dispose(): void {
    this.disposed = true
    this.stopped.length = 0
    for (const id of [...this.transfers.keys()]) void this.drop(id)
  }

  /** the transfer of this owner, or the refusal that it is not open for them */
  private ownTransfer(id: string, owner: string): Transfer {
    const t = this.transfers.get(id)
    if (!t) throw this.goneFor(id, owner)
    if (t.owner !== owner) throw new CallError(REMOTE_COPY.receiveUnknown)
    return t
  }

  /** the refusal of a transfer that is not open: it took too long when its owner's deadline or idle time stopped it, else unknown */
  private goneFor(id: string, owner: string): CallError {
    const timedOut = this.stopped.some((s) => s.id === id && s.owner === owner)
    return new CallError(timedOut ? REMOTE_COPY.receiveTimedOut : REMOTE_COPY.receiveUnknown)
  }

  /** the transfers of an owner, open and being begun */
  private countOf(owner: string): number {
    let n = this.openingBy.get(owner) ?? 0
    for (const t of this.transfers.values()) if (t.owner === owner) n++
    return n
  }

  private generationOf(owner: string): number {
    return this.generations.get(owner) ?? 0
  }

  /** (re)starts the idle timer of a transfer: it is dropped when nothing comes for idleMs */
  private touch(id: string): void {
    const t = this.transfers.get(id)
    if (!t) return
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      void this.drop(id, true)
    }, this.idleMs)
  }

  /** starts the deadline of a transfer of this size: the longer of the minimum and its size at the rate */
  private setDeadline(id: string, total: number): void {
    const t = this.transfers.get(id)
    if (!t) return
    const ms = Math.max(this.minDeadlineMs, (total / this.bytesPerSecond) * 1000)
    t.deadline = setTimeout(() => {
      void this.drop(id, true)
    }, ms)
  }

  /** forgets a transfer and stops its timers; the caller closes its files */
  private release(id: string): Transfer | null {
    const t = this.transfers.get(id)
    if (!t) return null
    this.transfers.delete(id)
    if (t.timer) clearTimeout(t.timer)
    if (t.deadline) clearTimeout(t.deadline)
    t.timer = null
    t.deadline = null
    return t
  }

  /** a transfer that is not kept: its files are closed and its folder removed */
  private async drop(id: string, stopped = false): Promise<void> {
    const t = this.release(id)
    if (!t) return
    // a transfer the deadline or the idle time stopped is remembered, so that its late parts say so
    if (stopped) {
      this.stopped.push({ id, owner: t.owner })
      if (this.stopped.length > MAX_STOPPED) this.stopped.shift()
    }
    await closeAll(t.files, this.log)
    await removeDir(t.dir, this.log)
  }

  /**
   * The root and its parent, which must be real folders of this user (not links, junctions or other files), and the root
   * must not be writable by others. With `create` the missing ones are made; without it, false says they are missing. A
   * folder that is not safe is a CallError.
   */
  private async folders(create: boolean): Promise<boolean> {
    for (const dir of [dirname(this.root), this.root]) {
      let st: Stats | null = await lstatOrNull(dir)
      if (!st) {
        if (!create) return false
        await mkdir(dir, { recursive: true, mode: 0o700 })
        st = await lstat(dir)
      }
      const ownedHere = process.platform === 'win32' || st.uid === process.getuid?.()
      // the root must not be writable by others; its parent must not be writable by anyone else (group write is allowed)
      const others = dir === this.root ? 0o022 : 0o002
      const openToOthers = process.platform !== 'win32' && (st.mode & others) !== 0
      if (!st.isDirectory() || st.isSymbolicLink() || !ownedHere || openToOthers) throw new CallError(REMOTE_COPY.receiveUnsafe)
    }
    return true
  }
}

/**
 * What a linked device going away does to the files it sent here: its transfers are removed. The host's onPeerGone is
 * this, in index.ts and in the tests, so the tests cover the wiring the app has.
 */
export function receivedPeerGone(receiver: Pick<FileReceiver, 'abandon'>): (device: string) => void {
  return (device) => {
    receiver.abandon(device)
  }
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new CallError(REMOTE_COPY.receiveFailed)
  }
}

/** closes the open files; a failure is logged, and the others are closed all the same */
async function closeAll(files: OpenFile[], log: (m: string) => void): Promise<void> {
  await Promise.all(
    files.flatMap((f) => {
      const handle = f.handle
      f.handle = null
      return handle ? [handle.close().catch((e: unknown) => log(`received files: could not close a file: ${(e as Error).message}`))] : []
    })
  )
}

/** removes a transfer's folder; a failure is logged */
async function removeDir(dir: string, log: (m: string) => void): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    log(`received files: could not remove a folder: ${(e as Error).message}`)
  }
}
