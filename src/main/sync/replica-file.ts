import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isUuid } from '../../shared/protocol'
import { COLLECTIONS, type Collection, type ReplicaData } from './replica'
import { parseKeyState } from './wire'
import { isPlainObject } from './views'

/** Reads the replica file: the replica data when the text has its shape; null otherwise. */
export function parseReplica(text: string): ReplicaData | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(raw) || raw.version !== 1 || !isUuid(raw.device)) return null
  if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 0) return null
  // a file saved before the reservation existed has none: its sequence number is the reservation
  const reserved: unknown = raw.reserved === undefined ? raw.seq : raw.reserved
  if (!Number.isSafeInteger(reserved) || (reserved as number) < 0) return null
  if (raw.clock !== null && !isStamp(raw.clock)) return null
  if (!isPlainObject(raw.seen) || !isPlainObject(raw.local) || !isPlainObject(raw.records)) return null
  if (!isLocal(raw.local)) return null
  const records = {} as ReplicaData['records']
  for (const col of COLLECTIONS) {
    const part = (raw.records as Record<string, unknown>)[col]
    if (part === undefined) {
      records[col] = {}
    } else if (isPlainObject(part) && Object.values(part).every(isKeyState)) {
      records[col] = part as Record<string, ReplicaData['records'][Collection][string]>
    } else {
      return null
    }
  }
  return {
    version: 1,
    device: raw.device,
    seq: Math.max(raw.seq as number, reserved as number),
    reserved: reserved as number,
    clock: raw.clock as ReplicaData['clock'],
    seen: raw.seen as ReplicaData['seen'],
    records,
    local: raw.local as unknown as ReplicaData['local']
  }
}

function isStamp(v: unknown): boolean {
  return isPlainObject(v) && typeof v.t === 'number' && typeof v.c === 'number'
}

/** the shape of one key's state, checked as the network checks it: every sibling's dot and stamp, and the context */
function isKeyState(v: unknown): boolean {
  return parseKeyState(v) !== null
}

/** the addresses object, and the name and removal of this device, each a string or null */
function isLocal(v: Record<string, unknown>): boolean {
  return isPlainObject(v.addresses) && (v.name === null || typeof v.name === 'string') && (v.removedBy === null || typeof v.removedBy === 'string')
}

export interface ReplicaFileOptions {
  debounceMs?: number
  onError?(message: string): void
  /** what the user is told: the file could not be read */
  warn?(message: string): void
}

/** This device's replica on disk: sync-replica.json in the data folder, saved after a short pause. */
export class ReplicaFile {
  readonly path: string
  private timer: ReturnType<typeof setTimeout> | null = null
  /** the newest data to save; null when nothing waits to be written */
  private pending: (() => ReplicaData) | null = null
  /** false when a file that could not be read could not be moved aside either: it is never written over */
  private writable = true

  constructor(dir: string, private readonly opts: ReplicaFileOptions = {}) {
    this.path = join(dir, 'sync-replica.json')
  }

  /** The saved replica; null when there is no file, or when the file could not be read (it is moved aside). */
  load(): ReplicaData | null {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      this.opts.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      this.moveAside()
      return null
    }
    const parsed = parseReplica(text)
    if (!parsed) {
      this.moveAside()
      return null
    }
    return parsed
  }

  /** Saves the data read at flush time, after the debounce; a later schedule replaces the pending data. */
  schedule(data: () => ReplicaData): void {
    this.pending = data
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 500)
  }

  /** Saves the pending data now. Returns true when it saved, or nothing was pending; false when the save failed. */
  flush(): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending) return true
    if (!this.writable) return false
    const next = this.pending
    this.pending = null
    let text: string
    try {
      text = JSON.stringify(next(), null, 2)
    } catch (e) {
      // the data could not be built at all: there is nothing to keep
      this.opts.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
      return false
    }
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, this.path)
      return true
    } catch (e) {
      this.opts.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
      // a refused write keeps its data: unless a newer one came meanwhile, the next flush (the close, a schedule or a send) saves it
      if (this.pending === null) this.pending = next
      return false
    }
  }

  /** Deletes the file and cancels a pending save; used when this device starts over. */
  remove(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
    try {
      rmSync(this.path, { force: true })
    } catch (e) {
      this.opts.onError?.(`cannot remove ${this.path}: ${(e as Error).message}`)
    }
  }

  /** a file that is not replica data is kept beside the new one, never written over; the replica starts empty */
  private moveAside(): void {
    const aside = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, aside)
      this.opts.warn?.(`Device sync data could not be read; the file was kept as ${basename(aside)}`)
    } catch (e) {
      this.writable = false
      this.opts.onError?.(`cannot move ${this.path} aside: ${(e as Error).message}`)
      this.opts.warn?.(`Device sync data could not be read and is not being saved this run: ${this.path}`)
    }
  }
}
