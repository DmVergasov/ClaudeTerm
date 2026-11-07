import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { hasText, MAX_NOTE_LENGTH, NOTE_FORMS, type Note } from '../shared/note'
import { isUuid } from '../shared/protocol'

/** Reads the notes file: valid entries by session id; null when the text is not a JSON object. */
export function parseNotes(text: string): Map<string, Note> | null {
  return parseNotesFile(text)?.notes ?? null
}

/** As parseNotes, and whether the file held an entry that was dropped; null when the text is not a JSON object. */
export function parseNotesFile(text: string): { notes: Map<string, Note>; skipped: boolean } | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const notes = new Map<string, Note>()
  let skipped = false
  for (const [id, value] of Object.entries(raw)) {
    const note = noteEntry(id, value)
    if (note) notes.set(id, note)
    else skipped = true
  }
  return { notes, skipped }
}

/** One entry of the notes file as a note; null when the entry is not valid or has no text. */
function noteEntry(id: string, value: unknown): Note | null {
  if (!isUuid(id) || typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.text !== 'string' || v.text.length > MAX_NOTE_LENGTH) return null
  if (typeof v.shown !== 'boolean') return null
  if (!NOTE_FORMS.some((f) => f === v.form)) return null
  const note: Note = { text: v.text, shown: v.shown, form: v.form as Note['form'] }
  return hasText(note) ? note : null
}

/** Whether two notes show the same: the same text, shown and form. A note without text is the same as none. */
export function sameNote(a: Note | null, b: Note | null): boolean {
  const x = a && hasText(a) ? a : null
  const y = b && hasText(b) ? b : null
  if (x === null || y === null) return x === y
  return x.text === y.text && x.shown === y.shown && x.form === y.form
}

/** What the device sync hears of: a note this device set, and the version the edit started from. */
export interface NoteSync {
  /** the version a note's view is based on now; the UI passes it back as the base of its next set */
  version(sessionId: string): unknown
  changed(sessionId: string, note: Note | null, base: unknown): void
}

export interface SessionNotesOptions {
  debounceMs?: number
  onError?(message: string): void
  /** what the user is told: the file could not be read */
  warn?(message: string): void
}

/** The user's notes by Claude session id: ClaudeTerm's own file, never anything in Claude Code's folders. */
export class SessionNotes {
  readonly path: string
  /** the marker beside the file: the detached sessions, kept on disk while a restore is pending */
  private readonly markerPath: string
  private readonly notes = new Map<string, Note>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  /** false when a file that could not be read could not be moved aside either: it is never written over */
  private writable = true
  private sync: NoteSync | null = null
  /** the sessions set while no sync was attached: the device sync decides about them when it restores the notes */
  private readonly detached = new Set<string>()
  /** true when the file was missing, unreadable or corrupt at load, or a restore is still pending: the device sync restores the notes from the group */
  private restore = false
  private readonly listeners = new Set<(sessionId: string, note: Note | null, before: unknown) => void>()

  constructor(dir: string, private readonly opts: SessionNotesOptions = {}) {
    this.path = join(dir, 'session-notes.json')
    this.markerPath = join(dir, 'session-notes.restore.json')
    this.load()
  }

  get(sessionId: string): Note | null {
    const n = this.notes.get(sessionId)
    return n ? { ...n } : null
  }

  keys(): string[] {
    return [...this.notes.keys()]
  }

  /** Attaches the device sync, which hears of every note this device sets; null detaches it. */
  attach(sync: NoteSync | null): void {
    this.sync = sync
  }

  /** The sessions whose note was set while no sync was attached, since the last restored(). */
  detachedChanges(): ReadonlySet<string> {
    return this.detached
  }

  /** Whether the file was missing, unreadable or corrupt when it loaded: the notes then need restoring from the device sync. */
  needsRestore(): boolean {
    return this.restore
  }

  /**
   * The device sync has restored the notes: the notes not yet in the file are saved now, marker first, and then the marker goes
   * and the file is the truth from now on. When a save or the marker's removal fails, the restore stays pending.
   */
  restored(): void {
    if (this.dirty) {
      this.flush()
      if (this.dirty) return
    }
    try {
      rmSync(this.markerPath, { force: true })
    } catch (e) {
      this.opts.onError?.(`cannot remove ${this.markerPath}: ${(e as Error).message}`)
      return
    }
    this.restore = false
    this.detached.clear()
  }

  /** The version of a note the sync holds; null without a sync. */
  version(sessionId: string): unknown {
    return this.sync ? this.sync.version(sessionId) : null
  }

  /** Stores the note; null or a note without text removes it. `base` is the version the edit started from, or undefined. */
  set(sessionId: string, note: Note | null, base?: unknown): void {
    this.put(sessionId, note)
    if (!this.sync) this.detached.add(sessionId)
    this.scheduleSave()
    if (this.sync) this.sync.changed(sessionId, this.get(sessionId), base)
  }

  /**
   * A note another device changed: saved and given to the listeners with `before`, the version the store held before, and not
   * sent back to the sync. Bad values are ignored.
   */
  applySync(sessionId: string, note: Note | null, before: unknown): void {
    this.applySyncMany([[sessionId, note, before]])
  }

  /**
   * Notes another device changed, applied together: every valid change is put, the file is saved once, and then the listeners
   * are called for each change with its `before`. Bad values are ignored, and nothing is saved when no note changed.
   */
  applySyncMany(entries: Array<[sessionId: string, note: Note | null, before: unknown]>): void {
    const changed: Array<[string, unknown]> = []
    for (const [sessionId, note, before] of entries) {
      if (!isUuid(sessionId) || (note !== null && !validNote(note))) continue
      if (sameNote(this.get(sessionId), note)) continue
      this.put(sessionId, note)
      changed.push([sessionId, before])
    }
    if (changed.length === 0) return
    // written at once: a restart must not bring back the older note the debounce would leave on disk
    this.dirty = true
    this.flush()
    for (const [sessionId, before] of changed) {
      for (const cb of [...this.listeners]) cb(sessionId, this.get(sessionId), before)
    }
  }

  /** Calls cb with the notes another device changed; the returned function stops the calls. */
  onExternal(cb: (sessionId: string, note: Note | null, before: unknown) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty || !this.writable) return
    this.save()
  }

  /**
   * Saves the file. While a restore is pending the marker goes first, so a later run never trusts a file this run wrote without
   * it; when the marker cannot be written the file is not written, and the save is tried again at the next flush. A save that
   * fails makes the restore pending, and the marker is tried then too.
   */
  private save(): void {
    if (this.restore && !this.saveMarker()) return
    if (this.saveFile()) {
      this.dirty = false
      return
    }
    this.restore = true
    this.saveMarker()
  }

  private saveFile(): boolean {
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.notes), null, 2), 'utf8')
      renameSync(tmp, this.path)
      return true
    } catch (e) {
      this.opts.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
      return false
    }
  }

  private saveMarker(): boolean {
    const tmp = `${this.markerPath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify([...this.detached]), 'utf8')
      renameSync(tmp, this.markerPath)
      return true
    } catch (e) {
      this.opts.onError?.(`cannot save ${this.markerPath}: ${(e as Error).message}`)
      return false
    }
  }

  private put(sessionId: string, note: Note | null): void {
    if (note && hasText(note)) this.notes.set(sessionId, { ...note })
    else this.notes.delete(sessionId)
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 500)
  }

  private load(): void {
    this.loadMarker()
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      this.restore = true
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      this.opts.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      this.moveAside()
      return
    }
    const parsed = parseNotesFile(text)
    if (!parsed) {
      this.restore = true
      this.moveAside()
      return
    }
    // an entry the file dropped is not in the store: the group has it, so the store is restored from the group
    if (parsed.skipped) this.restore = true
    for (const [id, n] of parsed.notes) this.notes.set(id, n)
  }

  /** A marker left by a restore that did not finish: its sessions are the detached changes, and the notes still need restoring. */
  private loadMarker(): void {
    let text: string
    try {
      text = readFileSync(this.markerPath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      this.restore = true
      this.opts.onError?.(`cannot read ${this.markerPath}: ${(e as Error).message}`)
      return
    }
    this.restore = true
    try {
      const raw: unknown = JSON.parse(text)
      if (!Array.isArray(raw)) throw new Error('not a list')
      for (const id of raw) if (isUuid(id)) this.detached.add(id)
    } catch {
      this.opts.onError?.(`ignoring corrupt ${this.markerPath}`)
    }
  }

  /** a file that is not notes is kept beside the new one, never written over; the notes start empty */
  private moveAside(): void {
    const aside = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, aside)
      this.opts.warn?.(`Session notes could not be read; the file was kept as ${basename(aside)}`)
    } catch (e) {
      this.writable = false
      this.opts.onError?.(`cannot move ${this.path} aside: ${(e as Error).message}`)
      this.opts.warn?.(`Session notes could not be read and are not being saved this run: ${this.path}`)
    }
  }
}

/** A note from another device: the shape the notes file keeps. */
function validNote(v: unknown): v is Note {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const n = v as Record<string, unknown>
  return typeof n.text === 'string' && n.text.length <= MAX_NOTE_LENGTH && typeof n.shown === 'boolean' && NOTE_FORMS.some((f) => f === n.form)
}
