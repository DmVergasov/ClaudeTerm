import type { Note } from '../../shared/note'
import { isUuid } from '../../shared/protocol'
import { type NoteSync, sameNote, type SessionNotes } from '../session-notes'
import { type StarSync, type StarredSessions } from '../starred-sessions'
import type { DeviceGroup } from './device-group'
import type { Dot, RecordUpdate, VersionVector } from './replica'
import { isPlainObject, noteOf, starOf } from './views'

/** The group calls the bridge makes: the stars and notes of the device group. */
export type BridgeGroup = Pick<DeviceGroup, 'write' | 'context' | 'state' | 'keys'>

/** The pause after the last change of a note before it is written to the group. */
const DEFAULT_DEBOUNCE_MS = 500

/** A note write that waits for its pause; `base` is the version the edit started from. */
interface PendingNote {
  note: Note | null
  base: VersionVector
  /** the base came with the edit: a late edit, typed against a note the tab no longer shows */
  late: boolean
}

/**
 * Keeps the stores (stars and notes) in step with the device group. Local changes go to the group (stars at once, notes after a
 * pause); the group's changes from other devices go to the stores and their listeners. Every change the bridge applies is saved
 * to the stores too. start() brings the stores and the group together, and restores a store whose file was lost from the group.
 */
export class StoreBridge {
  /** the version of each note the stores show: the group's context when its view was last taken */
  private readonly shown = new Map<string, VersionVector>()
  private readonly pending = new Map<string, PendingNote>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly debounceMs: number
  private active = false

  private readonly starSync: StarSync = {
    changed: (id, starred) => {
      this.group.write('stars', id, starred)
    }
  }

  private readonly noteSync: NoteSync = {
    version: (id) => ({ ...(this.shown.get(id) ?? this.group.context('notes', id)) }),
    changed: (id, note, base) => this.noteChanged(id, note, base)
  }

  constructor(
    private readonly starred: StarredSessions,
    private readonly notes: SessionNotes,
    private readonly group: BridgeGroup,
    opts: { debounceMs?: number } = {}
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  /**
   * Attaches both stores and brings them and the group together, key by key. A key the group has no state for takes the store's
   * value when it is real (a star, a note). Where the group has state, a store whose file was read at load keeps its values:
   * they go into the group where they differ, false and null included. A store whose file was lost or corrupt takes the group's
   * view for every key it did not change while sync was off, so it is restored from the group; a key it did change takes the
   * store's value. The stores' restore is done after the loops, so a throw inside them forgets nothing. Called again after the
   * group starts over.
   */
  start(): void {
    this.flush()
    const starDetached = this.starred.detachedChanges()
    const noteDetached = this.notes.detachedChanges()
    this.active = true
    this.starred.attach(this.starSync)
    this.notes.attach(this.noteSync)
    const previous = new Map(this.shown)
    this.shown.clear()
    const starRestore: Array<[string, boolean]> = []
    const starIds = new Set<string>([...this.starred.ids(), ...this.group.keys('stars')])
    for (const id of starIds) {
      const has = this.starred.ids().has(id)
      const state = this.group.state('stars', id)
      if (state === undefined) {
        if (has) this.group.write('stars', id, true)
      } else if (!this.starred.needsRestore() || starDetached.has(id)) {
        if (has !== starOf(state)) this.group.write('stars', id, has)
      } else if (has !== starOf(state)) {
        starRestore.push([id, starOf(state)])
      }
    }
    this.starred.applySyncMany(starRestore)
    const noteRestore: Array<[string, Note | null, unknown]> = []
    const noteIds = new Set<string>([...this.notes.keys(), ...this.group.keys('notes')])
    for (const id of noteIds) {
      const want = this.notes.get(id)
      const state = this.group.state('notes', id)
      if (state === undefined) {
        if (want !== null) this.group.write('notes', id, want)
      } else if (!this.notes.needsRestore() || noteDetached.has(id)) {
        if (!sameNote(want, noteOf(state))) this.group.write('notes', id, want)
      } else if (!sameNote(want, noteOf(state))) {
        noteRestore.push([id, noteOf(state), previous.get(id) ?? {}])
      }
      this.shown.set(id, this.group.context('notes', id))
    }
    this.notes.applySyncMany(noteRestore)
    this.starred.restored()
    this.notes.restored()
  }

  /** The records the group merged from other devices: the stores take the changes, after any local note write waiting on them. */
  applied(updates: RecordUpdate[]): void {
    if (!this.active) return
    for (const u of updates) {
      if (!isUuid(u.key)) continue
      if (u.col === 'stars') {
        this.starred.applySync(u.key, starOf(this.group.state('stars', u.key)))
      } else if (u.col === 'notes') {
        this.flushNote(u.key)
        const before = this.shown.get(u.key) ?? {}
        this.shown.set(u.key, this.group.context('notes', u.key))
        this.notes.applySync(u.key, noteOf(this.group.state('notes', u.key)), before)
      }
    }
  }

  /** Writes every pending note into the group now. */
  flush(): void {
    for (const id of [...this.pending.keys()]) this.flushNote(id)
  }

  /** Writes what is pending, then detaches both stores: nothing is timed or applied after it. */
  stop(): void {
    this.flush()
    this.active = false
    this.starred.attach(null)
    this.notes.attach(null)
  }

  private noteChanged(id: string, note: Note | null, base: unknown): void {
    if (!this.active) return
    const explicit = asVersion(base)
    // the version the tab showed when this edit was typed: a flush below must not change what it is based on
    const shownNow = this.shown.get(id) ?? this.group.context('notes', id)
    const waiting = this.pending.get(id)
    // a write on another base, or an edit without one after a late edit, does not join the waiting write: that one goes first
    let flushed = false
    if (waiting && (explicit ? !sameVersion(explicit, waiting.base) : waiting.late)) {
      // the waiting write goes first; the tab is typing, so its view is not handed back in the middle of the keystroke
      this.flushNote(id, false)
      flushed = true
    }
    // the base of the first change of a pause stays: the write replaces what the edit saw, and keeps what came after
    const from = this.pending.get(id)?.base ?? explicit ?? (flushed ? shownNow : this.shown.get(id) ?? this.group.context('notes', id))
    this.pending.set(id, { note, base: from, late: explicit !== null })
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.set(id, setTimeout(() => this.flushNote(id), this.debounceMs))
  }

  /**
   * Writes a pending note into the group on its base. When the group then shows something else, the store takes that view, and
   * the tab is handed it, unless `handBack` is false: the store keeps the text just typed and the tab keeps its number, and the
   * version recorded for the tab is only the write's base with its own dot, which may differ from the version the tab shows.
   */
  private flushNote(id: string, handBack = true): void {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    const before = this.group.state('notes', id)
    // the write's base with its own dot; this is not always the version the tab shows, and it is read only when the next flush
    // writes nothing, or with two tabs on one session
    let shownAs = p.base
    if (!sameNote(p.note, noteOf(before))) {
      const dot: Dot | null = this.group.write('notes', id, p.note, p.base)
      if (dot) shownAs = { ...p.base, [dot[0]]: Math.max(p.base[dot[0]] ?? 0, dot[1]) }
    }
    const after = this.group.state('notes', id)
    // the state is the same object when nothing was written, e.g. while the group is closed: the store keeps its own note
    if (after === before) return
    if (!handBack) {
      this.shown.set(id, shownAs)
      return
    }
    this.shown.set(id, this.group.context('notes', id))
    const view = noteOf(after)
    if (!sameNote(view, p.note)) this.notes.applySync(id, view, shownAs)
  }
}

/** Whether two versions hold the same sequence number for every device (a missing device counts as 0). */
function sameVersion(a: VersionVector, b: VersionVector): boolean {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((d) => (a[d] ?? 0) === (b[d] ?? 0))
}

/** A version a caller passed in: device ids with sequence numbers. Anything else is not one. */
function asVersion(v: unknown): VersionVector | null {
  if (!isPlainObject(v)) return null
  const out: VersionVector = {}
  for (const [device, seq] of Object.entries(v)) {
    if (!isUuid(device) || !Number.isSafeInteger(seq) || (seq as number) < 0) return null
    out[device] = seq as number
  }
  return out
}
