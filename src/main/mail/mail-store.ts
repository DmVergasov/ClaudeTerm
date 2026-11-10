import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIL_KEEP_MS, type MailRecord } from '../../shared/mail'
import { checkMailRecord, mailFlags, mergeMail } from './mail-record'

const FILE = 'agent-messages.json'
/** how far ahead of this device's clock a message may be sent: a record further ahead is refused */
const MAIL_MAX_AHEAD_MS = 24 * 60 * 60 * 1000

/** A record may leave this device only when both its ends have a device: one with a null device is never paired and is kept here. */
export function isShareable(r: MailRecord): boolean {
  return r.from.device !== null && r.to.device !== null
}

export interface MailStoreDeps {
  dir: string
  now?(): number
  debounceMs?: number
  onError?(message: string): void
}

/** where a change came from: this device (a message written here or a mark), or the link of a peer */
export type MailOrigin = 'local' | { link: unknown }

/** The mail on this device: the messages kept for 30 days, in agent-messages.json in the data folder. */
export class MailStore {
  private readonly path: string
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly records = new Map<string, MailRecord>()
  private readonly listeners: Array<(changed: MailRecord[], origin: MailOrigin) => void> = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  /** false when a file that could not be read could not be moved aside either: it is never written over */
  private writable = true

  private constructor(private readonly deps: MailStoreDeps) {
    this.path = join(deps.dir, FILE)
    this.now = deps.now ?? Date.now
    this.debounceMs = deps.debounceMs ?? 500
  }

  /** Loads the saved mail and drops what is too old; a file that is not mail is moved aside and the store opens empty. */
  static open(deps: MailStoreDeps): MailStore {
    const store = new MailStore(deps)
    store.load()
    store.prune()
    return store
  }

  /** every message kept, the newest sent last */
  all(): MailRecord[] {
    return [...this.records.values()].sort((a, b) => a.sentAt - b.sentAt)
  }

  get(id: string): MailRecord | undefined {
    return this.records.get(id)
  }

  /** a message written here */
  add(r: MailRecord): void {
    this.records.set(r.id, r)
    this.changed([r], 'local')
  }

  /** Takes in records from a peer or a file: new ones are kept, known ones take the flags they add. Returns the records that changed. */
  merge(records: MailRecord[], origin: MailOrigin): MailRecord[] {
    const cutoff = this.now() - MAIL_KEEP_MS
    // a record sent far ahead of this clock would never be pruned: it is refused
    const latest = this.now() + MAIL_MAX_AHEAD_MS
    const changed: MailRecord[] = []
    for (const item of records) {
      const r = checkMailRecord(item)
      if (!r || r.sentAt < cutoff || r.sentAt > latest) continue
      const mine = this.records.get(r.id)
      if (!mine) {
        this.records.set(r.id, r)
        changed.push(r)
        continue
      }
      const next = mergeMail(mine, r)
      if (mailFlags(next) !== mailFlags(mine)) {
        this.records.set(next.id, next)
        changed.push(next)
      }
    }
    this.changed(changed, origin)
    return changed
  }

  /** Sets a flag on the records with these ids; returns the records that changed. */
  mark(ids: string[], flag: 'delivered' | 'read'): MailRecord[] {
    const changed: MailRecord[] = []
    for (const id of ids) {
      const r = this.records.get(id)
      if (!r || r[flag]) continue
      const next: MailRecord = flag === 'read' ? { ...r, read: true } : { ...r, delivered: true }
      this.records.set(id, next)
      changed.push(next)
    }
    this.changed(changed, 'local')
    return changed
  }

  /** The records that may leave this device, each with its flags: those with no null device. */
  digest(): [id: string, flags: number][] {
    return this.shareable().map((r): [string, number] => [r.id, mailFlags(r)])
  }

  /** The shareable records the peer lacks, or holds with fewer flags than this device. */
  missingFor(peer: [string, number][]): MailRecord[] {
    const held = new Map(peer)
    return this.shareable().filter((r) => {
      const flags = held.get(r.id)
      return flags === undefined || (flags & mailFlags(r)) !== mailFlags(r)
    })
  }

  /** Drops the messages older than 30 days; saves at once when it dropped any. */
  prune(): void {
    const cutoff = this.now() - MAIL_KEEP_MS
    let removed = false
    for (const [id, r] of this.records) {
      if (r.sentAt < cutoff) {
        this.records.delete(id)
        removed = true
      }
    }
    if (removed) {
      this.dirty = true
      this.flush()
    }
  }

  /** Calls cb after each change; the function it returns stops the calls. */
  onChange(cb: (changed: MailRecord[], origin: MailOrigin) => void): () => void {
    this.listeners.push(cb)
    return () => {
      const at = this.listeners.indexOf(cb)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  /** Saves the mail now, when a change waits to be saved. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty || !this.writable) return
    const text = JSON.stringify({ version: 1, records: this.all() }, null, 2)
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.path)
      this.dirty = false
    } catch (e) {
      // the change stays waiting: the next change or flush saves it
      this.deps.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
    }
  }

  private shareable(): MailRecord[] {
    return this.all().filter(isShareable)
  }

  /** notifies the listeners and saves after the debounce, when anything changed */
  private changed(changed: MailRecord[], origin: MailOrigin): void {
    if (changed.length === 0) return
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.debounceMs)
    for (const cb of [...this.listeners]) cb(changed, origin)
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      this.deps.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      this.moveAside()
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      raw = null
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { records?: unknown }).records)) {
      this.moveAside()
      return
    }
    // a record that is not valid is skipped; the others are kept
    for (const item of (raw as { records: unknown[] }).records) {
      const r = checkMailRecord(item)
      if (r) this.records.set(r.id, r)
    }
  }

  /** a file that is not mail is kept beside the new one, never written over; the store starts empty */
  private moveAside(): void {
    const aside = `${this.path}.corrupt-${this.now()}`
    try {
      renameSync(this.path, aside)
    } catch (e) {
      this.writable = false
      this.deps.onError?.(`cannot move ${this.path} aside: ${(e as Error).message}`)
    }
  }
}
