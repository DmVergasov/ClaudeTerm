import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionNotes } from '../../src/main/session-notes'
import { StarredSessions } from '../../src/main/starred-sessions'
import { type BridgeGroup, StoreBridge } from '../../src/main/sync/store-bridge'
import { emptyReplica, type RecordUpdate, Replica, type VersionVector } from '../../src/main/sync/replica'
import { noteOf, starOf } from '../../src/main/sync/views'
import type { Note } from '../../src/shared/note'

const SELF = '3c9d8e7f-1a2b-4c3d-8e9f-0a1b2c3d4e5f'
const OTHER = '4d0e9f80-2b3c-4d4e-9f0a-1b2c3d4e5f60'
const S1 = '6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b'
const S2 = '7a2d3b4f-5c6e-4f80-9b0c-1d2e3f4a5b6c'
const S3 = '8b3e4c5a-6d7f-4a91-8c1d-2e3f4a5b6c7d'

const alpha: Note = { text: 'alpha', shown: true, form: 'card' }
const dirs: string[] = []

let mine: Replica
let theirs: Replica
let starred: StarredSessions
let notes: SessionNotes
let bridge: StoreBridge
let external: Array<[string, Note | null, unknown]>
let externalIds: Array<ReadonlySet<string>>

/** a real replica for this device, behind the three calls the bridge makes on a group */
function fakeGroup(replica: Replica): BridgeGroup {
  return {
    write: (col, key, value, base?: VersionVector) => {
      replica.write(col, key, value, base)
      return null
    },
    context: (col, key) => replica.context(col, key),
    state: (col, key) => replica.get(col, key),
    keys: (col) => replica.keys(col)
  }
}

/** a write made by the other device, as it would arrive from the network */
const remoteStar = (id: string, starred: boolean): RecordUpdate => theirs.write('stars', id, starred)
const remoteNote = (id: string, note: Note | null): RecordUpdate => theirs.write('notes', id, note)

/** what the group does on receipt: merge the updates, then tell the bridge which states changed */
function receive(...updates: RecordUpdate[]): void {
  bridge.applied(mine.apply(updates))
}

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ct-bridge-unit-'))
  dirs.push(d)
  return d
}

beforeEach(() => {
  mine = new Replica(emptyReplica(SELF), () => 1000)
  theirs = new Replica(emptyReplica(OTHER), () => 2000)
  const dir = newDir()
  starred = new StarredSessions(dir)
  notes = new SessionNotes(dir, { debounceMs: 20 })
  bridge = new StoreBridge(starred, notes, fakeGroup(mine), { debounceMs: 50 })
  external = []
  externalIds = []
  notes.onExternal((id, note, before) => external.push([id, note, before]))
  starred.onExternal((ids) => externalIds.push(ids))
})

afterEach(() => {
  vi.useRealTimers()
  bridge.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('StoreBridge', () => {
  it('start writes into the group whatever the stores hold that the group does not', () => {
    starred.set(S1, true)
    notes.set(S2, alpha)
    notes.flush()
    bridge.start()
    expect(starOf(mine.get('stars', S1))).toBe(true)
    expect(noteOf(mine.get('notes', S2))).toEqual(alpha)
    bridge.start() // a second start writes nothing new
    expect(mine.seen()).toEqual({ [SELF]: 2 })
  })

  it('start: a key changed while sync was off wins over the group (unstarred and note removed while detached)', () => {
    mine.write('stars', S1, true)
    mine.write('notes', S3, alpha)
    starred.set(S1, true)
    starred.set(S1, false)
    notes.set(S3, alpha)
    notes.set(S3, null)
    bridge.start()
    expect(starOf(mine.get('stars', S1))).toBe(false)
    expect(noteOf(mine.get('notes', S3))).toBeNull()
  })

  it('start: a key not changed while sync was off is restored from the group, and nothing is written into the group', () => {
    mine.write('stars', S1, true)
    mine.write('notes', S2, alpha)
    const seen = { ...mine.seen() }
    bridge.start()
    expect(starred.ids().has(S1)).toBe(true)
    expect(notes.get(S2)).toEqual(alpha)
    expect(mine.seen()).toEqual(seen)
  })

  it('a run without sync keeps its changes: stores that loaded their files keep their stars and notes at the next start', () => {
    const afternoon: Note = { text: 'the whole afternoon of notes', shown: true, form: 'card' }
    const dir = newDir()
    writeFileSync(join(dir, 'starred-sessions.json'), JSON.stringify([]), 'utf8')
    writeFileSync(join(dir, 'session-notes.json'), JSON.stringify({ [S2]: afternoon }), 'utf8')
    // the group as the last run that had sync left it
    mine.write('stars', S1, true)
    mine.write('notes', S2, { ...alpha, text: 'first draft' })
    const s = new StarredSessions(dir)
    const n = new SessionNotes(dir, { debounceMs: 20 })
    const b = new StoreBridge(s, n, fakeGroup(mine), { debounceMs: 50 })
    b.start()
    expect(s.ids().has(S1)).toBe(false)
    expect(n.get(S2)).toEqual(afternoon)
    expect(starOf(mine.get('stars', S1))).toBe(false)
    expect(noteOf(mine.get('notes', S2))).toEqual(afternoon)
    expect(JSON.parse(readFileSync(n.path, 'utf8'))).toEqual({ [S2]: afternoon })
    b.stop()
  })

  it('restoring 50 notes into a store that lost its file saves the notes file once', () => {
    const ids = Array.from({ length: 50 }, () => randomUUID())
    for (const id of ids) mine.write('notes', id, { ...alpha, text: id })
    const dir = newDir()
    const n = new SessionNotes(dir, { debounceMs: 20 })
    const save = vi.spyOn(n, 'flush')
    const b = new StoreBridge(new StarredSessions(dir), n, fakeGroup(mine), { debounceMs: 50 })
    b.start()
    expect(save).toHaveBeenCalledTimes(1)
    expect(n.keys().sort()).toEqual([...ids].sort())
    expect(Object.keys(JSON.parse(readFileSync(n.path, 'utf8'))).sort()).toEqual([...ids].sort())
    b.stop()
  })

  it('a local star goes to the group at once; a remote one comes to the store and its listeners', () => {
    bridge.start()
    starred.set(S1, true)
    expect(starOf(mine.get('stars', S1))).toBe(true)
    receive(remoteStar(S2, true))
    expect(starred.ids().has(S2)).toBe(true)
    expect(externalIds.at(-1)!.has(S2)).toBe(true)
  })

  it('typing in a note writes once per pause', () => {
    vi.useFakeTimers()
    bridge.start()
    const before = mine.seen()[SELF] ?? 0
    notes.set(S1, { ...alpha, text: 'a' })
    vi.advanceTimersByTime(20)
    notes.set(S1, { ...alpha, text: 'ab' })
    vi.advanceTimersByTime(20)
    notes.set(S1, { ...alpha, text: 'abc' })
    vi.advanceTimersByTime(49)
    expect(mine.seen()[SELF] ?? 0).toBe(before)
    vi.advanceTimersByTime(1)
    expect(mine.seen()[SELF] ?? 0).toBe(before + 1)
    expect(noteOf(mine.get('notes', S1))).toEqual({ ...alpha, text: 'abc' })
  })

  it('a remote change while a local one waits: the local one is written first on its own base, and the joined note comes back', () => {
    bridge.start()
    notes.set(S1, { ...alpha, text: 'mine' }) // pending, base = the state before
    receive(remoteNote(S1, { ...alpha, text: 'theirs' }))
    // the pending write is stamped at flush time, after the remote stamp was observed, so it is the latest
    expect(noteOf(mine.get('notes', S1))!.text).toBe('mine\n\ntheirs')
    expect(external.at(-1)).toEqual([S1, { ...alpha, text: 'mine\n\ntheirs' }, expect.anything()])
  })

  it('a base passed to set is the base of the write', () => {
    bridge.start()
    notes.set(S1, alpha)
    notes.flush()
    bridge.flush()
    const before = notes.version(S1)
    receive(remoteNote(S1, { ...alpha, text: 'theirs' }))
    notes.set(S1, { ...alpha, text: 'mine' }, before)
    bridge.flush()
    expect(noteOf(mine.get('notes', S1))!.text.split('\n\n').sort()).toEqual(['mine', 'theirs'])
  })

  it('without a base, a local note write replaces what the group held', () => {
    bridge.start()
    notes.set(S1, alpha)
    notes.flush()
    bridge.flush()
    receive(remoteNote(S1, { ...alpha, text: 'theirs' }))
    notes.set(S1, { ...alpha, text: 'mine' })
    bridge.flush()
    expect(noteOf(mine.get('notes', S1))!.text).toBe('mine')
  })

  it('stop flushes a pending note, detaches the stores and leaves no timer running', () => {
    vi.useFakeTimers()
    bridge.start()
    notes.set(S1, alpha)
    bridge.stop()
    expect(noteOf(mine.get('notes', S1))).toEqual(alpha)
    notes.flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a group that takes no write (closed) leaves the store with its own note', () => {
    const closed = new StoreBridge(starred, notes, { ...fakeGroup(mine), write: () => null }, { debounceMs: 50 })
    closed.start()
    notes.set(S1, alpha)
    closed.flush()
    expect(notes.get(S1)).toEqual(alpha)
    expect(external).toEqual([])
    closed.stop()
  })

  it('start after a group reset writes the stores into the new replica, the pending note included', () => {
    // the group swaps in an empty replica when it starts over; the bridge is still attached to the same group object
    const swap = { replica: mine }
    const group: BridgeGroup = {
      write: (col, key, value, base?) => {
        swap.replica.write(col, key, value, base)
        return null
      },
      context: (col, key) => swap.replica.context(col, key),
      state: (col, key) => swap.replica.get(col, key),
      keys: (col) => swap.replica.keys(col)
    }
    const b = new StoreBridge(starred, notes, group, { debounceMs: 50 })
    b.start()
    starred.set(S1, true)
    notes.set(S2, alpha) // still pending when the reset comes
    const fresh = new Replica(emptyReplica(SELF), () => 3000)
    swap.replica = fresh
    b.start()
    expect(starOf(fresh.get('stars', S1))).toBe(true)
    expect(noteOf(fresh.get('notes', S2))).toEqual(alpha)
    expect(starred.ids().has(S1)).toBe(true)
    b.stop()
  })

  it('stop detaches: changes stay local', () => {
    bridge.start()
    bridge.stop()
    starred.set(S2, true)
    notes.set(S2, alpha)
    notes.flush()
    expect(mine.get('stars', S2)).toBeUndefined()
    expect(mine.get('notes', S2)).toBeUndefined()
  })

  it('an update received after stop is not applied to the stores', () => {
    bridge.start()
    bridge.stop()
    receive(remoteStar(S2, true))
    expect(starred.ids().has(S2)).toBe(false)
  })
})

describe('store hooks', () => {
  it('without a sync attached, a note has no version and the stores behave as before', () => {
    expect(notes.version(S1)).toBeNull()
    starred.set(S1, true)
    expect(starred.ids().has(S1)).toBe(true)
  })

  it('detachedChanges lists the keys set while no sync is attached; attaching keeps them until restored() clears them', () => {
    starred.set(S1, true)
    notes.set(S2, alpha)
    expect([...starred.detachedChanges()]).toEqual([S1])
    expect([...notes.detachedChanges()]).toEqual([S2])
    starred.attach({ changed: () => {} })
    notes.attach({ changed: () => {}, version: () => null })
    expect([...starred.detachedChanges()]).toEqual([S1])
    expect([...notes.detachedChanges()]).toEqual([S2])
    starred.restored()
    notes.restored()
    expect(starred.detachedChanges().size).toBe(0)
    expect(notes.detachedChanges().size).toBe(0)
  })

  it('needsRestore is true after a load that found no file or a corrupt one, and false after a load that read the file', () => {
    const missing = newDir()
    expect(new StarredSessions(missing).needsRestore()).toBe(true)
    expect(new SessionNotes(missing).needsRestore()).toBe(true)
    const corrupt = newDir()
    writeFileSync(join(corrupt, 'starred-sessions.json'), 'not json', 'utf8')
    writeFileSync(join(corrupt, 'session-notes.json'), 'not json', 'utf8')
    expect(new StarredSessions(corrupt).needsRestore()).toBe(true)
    expect(new SessionNotes(corrupt).needsRestore()).toBe(true)
    const good = newDir()
    writeFileSync(join(good, 'starred-sessions.json'), JSON.stringify([]), 'utf8')
    writeFileSync(join(good, 'session-notes.json'), JSON.stringify({}), 'utf8')
    expect(new StarredSessions(good).needsRestore()).toBe(false)
    expect(new SessionNotes(good).needsRestore()).toBe(false)
  })

  it('restored() clears needsRestore, for both stores', () => {
    const dir = newDir()
    const s = new StarredSessions(dir)
    const n = new SessionNotes(dir)
    expect(s.needsRestore()).toBe(true)
    expect(n.needsRestore()).toBe(true)
    s.restored()
    n.restored()
    expect(s.needsRestore()).toBe(false)
    expect(n.needsRestore()).toBe(false)
  })

  it('a star change reaches the sync once; an unchanged set does not', () => {
    const changed = vi.fn()
    starred.attach({ changed })
    starred.set(S1, true)
    starred.set(S1, true)
    starred.set(S1, false)
    expect(changed.mock.calls).toEqual([
      [S1, true],
      [S1, false]
    ])
  })

  it('applySync saves and tells the listeners, but does not call the sync back', () => {
    const changed = vi.fn()
    starred.attach({ changed })
    starred.applySync(S2, true)
    expect(starred.ids().has(S2)).toBe(true)
    expect(changed).not.toHaveBeenCalled()
    expect(externalIds).toEqual([new Set([S2])])
  })

  it('applySync ignores values that are not a star', () => {
    starred.applySync('not-a-uuid', true)
    starred.applySync(S2, 'yes' as unknown as boolean)
    expect(starred.ids().size).toBe(0)
    expect(externalIds).toEqual([])
  })

  it('applySync writes the note to disk at once, not after the debounce', () => {
    const dir = newDir()
    const n = new SessionNotes(dir, { debounceMs: 500 })
    n.applySync(S1, alpha, {})
    expect(JSON.parse(readFileSync(n.path, 'utf8'))).toEqual({ [S1]: alpha })
    n.flush()
  })

  it('applySync ignores a note that is not a note and removes a note whose text is blank', () => {
    notes.set(S1, alpha)
    notes.applySync(S1, { text: 5, shown: true, form: 'card' } as unknown as Note, {})
    expect(notes.get(S1)).toEqual(alpha)
    notes.applySync(S1, { text: '  ', shown: true, form: 'card' }, {})
    expect(notes.get(S1)).toBeNull()
    expect(notes.keys()).toEqual([])
  })

  it('a star file with an element that is not a star id needs a restore', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'starred-sessions.json'), JSON.stringify([S1, 'not-a-uuid']), 'utf8')
    expect(new StarredSessions(dir).needsRestore()).toBe(true)
  })

  it('a notes file that drops an entry needs a restore: the group keeps both notes and the store takes both from it', () => {
    const dir = newDir()
    const second: Note = { text: 'second', shown: true, form: 'card' }
    writeFileSync(join(dir, 'session-notes.json'), JSON.stringify({ [S1]: alpha, [S2]: { ...second, form: 'unknown-form' } }), 'utf8')
    mine.write('notes', S1, alpha)
    mine.write('notes', S2, second)
    const n = new SessionNotes(dir, { debounceMs: 20 })
    expect(n.needsRestore()).toBe(true)
    const b = new StoreBridge(new StarredSessions(dir), n, fakeGroup(mine), { debounceMs: 50 })
    b.start()
    expect(noteOf(mine.get('notes', S1))).toEqual(alpha)
    expect(noteOf(mine.get('notes', S2))).toEqual(second)
    expect(n.get(S1)).toEqual(alpha)
    expect(n.get(S2)).toEqual(second)
    b.stop()
  })

  it('a save that fails leaves needsRestore() true in both stores, and the marker keeps it true for the next load', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'starred-sessions.json'), JSON.stringify([S1]), 'utf8')
    writeFileSync(join(dir, 'session-notes.json'), JSON.stringify({ [S1]: alpha }), 'utf8')
    const errors: string[] = []
    const s = new StarredSessions(dir, (m) => errors.push(m))
    const n = new SessionNotes(dir, { debounceMs: 20, onError: (m) => errors.push(m) })
    // a folder where each store's temp file goes: the save cannot write it
    mkdirSync(join(dir, 'starred-sessions.json.tmp'))
    mkdirSync(join(dir, 'session-notes.json.tmp'))
    s.set(S2, true)
    n.set(S2, alpha)
    n.flush()
    expect(errors.length).toBe(2)
    expect(s.needsRestore()).toBe(true)
    expect(n.needsRestore()).toBe(true)
    rmSync(join(dir, 'starred-sessions.json.tmp'), { recursive: true, force: true })
    rmSync(join(dir, 'session-notes.json.tmp'), { recursive: true, force: true })
    expect(new StarredSessions(dir).needsRestore()).toBe(true)
    expect(new SessionNotes(dir).needsRestore()).toBe(true)
  })

  it('a marker beside a store file keeps its detached ids and needsRestore(), even when the file reads', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'starred-sessions.json'), JSON.stringify([S1]), 'utf8')
    writeFileSync(join(dir, 'starred-sessions.restore.json'), JSON.stringify([S2, 'not-a-uuid']), 'utf8')
    writeFileSync(join(dir, 'session-notes.json'), JSON.stringify({}), 'utf8')
    writeFileSync(join(dir, 'session-notes.restore.json'), JSON.stringify([S3]), 'utf8')
    const s = new StarredSessions(dir)
    const n = new SessionNotes(dir)
    expect(s.needsRestore()).toBe(true)
    expect([...s.detachedChanges()]).toEqual([S2])
    expect(n.needsRestore()).toBe(true)
    expect([...n.detachedChanges()]).toEqual([S3])
  })

  it('a marker that cannot be read still sets needsRestore(), with no detached ids', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'starred-sessions.json'), JSON.stringify([S1]), 'utf8')
    writeFileSync(join(dir, 'starred-sessions.restore.json'), 'not json', 'utf8')
    const s = new StarredSessions(dir)
    expect(s.needsRestore()).toBe(true)
    expect(s.detachedChanges().size).toBe(0)
  })

  it('a store that loaded its file writes no marker', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'starred-sessions.json'), JSON.stringify([S1]), 'utf8')
    writeFileSync(join(dir, 'session-notes.json'), JSON.stringify({}), 'utf8')
    const s = new StarredSessions(dir)
    const n = new SessionNotes(dir, { debounceMs: 20 })
    s.set(S2, true)
    n.set(S2, alpha)
    n.flush()
    expect(existsSync(join(dir, 'starred-sessions.restore.json'))).toBe(false)
    expect(existsSync(join(dir, 'session-notes.restore.json'))).toBe(false)
  })

  it('restoring 50 stars saves the star file once and calls the listeners once', () => {
    const ids = Array.from({ length: 50 }, () => randomUUID())
    for (const id of ids) mine.write('stars', id, true)
    const dir = newDir()
    const s = new StarredSessions(dir)
    const save = vi.spyOn(s as unknown as { save: () => void }, 'save')
    const calls = vi.fn()
    s.onExternal(calls)
    const b = new StoreBridge(s, new SessionNotes(dir), fakeGroup(mine), { debounceMs: 50 })
    b.start()
    expect(save).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(calls.mock.calls[0][0]).toEqual(new Set(ids))
    expect(s.ids().size).toBe(50)
    b.stop()
  })

  it('a marker that cannot be written and a store file that cannot be written keep the restore pending until both can be', () => {
    const dir = newDir()
    const S4 = randomUUID()
    // the run that left the marker: star and note S3, set while sync was off
    const s1 = new StarredSessions(dir)
    const n1 = new SessionNotes(dir, { debounceMs: 20 })
    s1.set(S3, true)
    n1.set(S3, alpha)
    n1.flush()
    // the group holds S1 and S2, and the stores hold only S3; the disk refuses the marker and the store files
    mine.write('stars', S1, true)
    mine.write('stars', S4, true)
    mine.write('notes', S1, alpha)
    mine.write('notes', S4, alpha)
    for (const f of ['starred-sessions.restore.json', 'starred-sessions.json', 'session-notes.restore.json', 'session-notes.json']) {
      mkdirSync(join(dir, `${f}.tmp`))
    }
    const errors: string[] = []
    const s2 = new StarredSessions(dir, (m) => errors.push(m))
    const n2 = new SessionNotes(dir, { debounceMs: 20, onError: (m) => errors.push(m) })
    const b = new StoreBridge(s2, n2, fakeGroup(mine), { debounceMs: 50 })
    b.start()
    expect(s2.ids().has(S1)).toBe(true)
    expect(existsSync(join(dir, 'starred-sessions.restore.json'))).toBe(true)
    expect(s2.needsRestore()).toBe(true)
    expect(n2.needsRestore()).toBe(true)
    b.stop()
    for (const f of ['starred-sessions.restore.json', 'starred-sessions.json', 'session-notes.restore.json', 'session-notes.json']) {
      rmSync(join(dir, `${f}.tmp`), { recursive: true, force: true })
    }
    // the next run: the marker is still there, so the stores still need a restore, and the group restores them
    const s3 = new StarredSessions(dir)
    const n3 = new SessionNotes(dir)
    expect(s3.needsRestore()).toBe(true)
    expect(n3.needsRestore()).toBe(true)
    const b3 = new StoreBridge(s3, n3, fakeGroup(mine), { debounceMs: 50 })
    b3.start()
    expect([...s3.ids()].sort()).toEqual([S1, S3, S4].sort())
    expect(JSON.parse(readFileSync(join(dir, 'starred-sessions.json'), 'utf8')).sort()).toEqual([S1, S3, S4].sort())
    expect(existsSync(join(dir, 'starred-sessions.restore.json'))).toBe(false)
    expect(existsSync(join(dir, 'session-notes.restore.json'))).toBe(false)
    b3.stop()
  })

  it('a marker that cannot be written keeps the restore pending: restored() writes neither the marker nor the store file, and the next run restores', () => {
    const dir = newDir()
    const S4 = randomUUID()
    const s1 = new StarredSessions(dir)
    const n1 = new SessionNotes(dir, { debounceMs: 20 })
    s1.set(S3, true)
    n1.set(S3, alpha)
    n1.flush()
    mine.write('stars', S1, true)
    mine.write('stars', S4, true)
    mine.write('notes', S1, alpha)
    mine.write('notes', S4, alpha)
    // only the markers' temp files are refused
    mkdirSync(join(dir, 'starred-sessions.restore.json.tmp'))
    mkdirSync(join(dir, 'session-notes.restore.json.tmp'))
    const s2 = new StarredSessions(dir)
    const n2 = new SessionNotes(dir, { debounceMs: 20 })
    const b = new StoreBridge(s2, n2, fakeGroup(mine), { debounceMs: 50 })
    b.start()
    rmSync(join(dir, 'starred-sessions.restore.json.tmp'), { recursive: true, force: true })
    rmSync(join(dir, 'session-notes.restore.json.tmp'), { recursive: true, force: true })
    b.stop()
    // the restore is still pending: the markers are on disk, and the store files are as the run left them
    expect(new StarredSessions(dir).needsRestore()).toBe(true)
    expect(new SessionNotes(dir).needsRestore()).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'starred-sessions.json'), 'utf8'))).toEqual([S3])
    // the next run restores them, and the markers go
    const s3 = new StarredSessions(dir)
    const n3 = new SessionNotes(dir)
    const b3 = new StoreBridge(s3, n3, fakeGroup(mine), { debounceMs: 50 })
    b3.start()
    expect(JSON.parse(readFileSync(join(dir, 'starred-sessions.json'), 'utf8')).sort()).toEqual([S1, S3, S4].sort())
    expect(new StarredSessions(dir).needsRestore()).toBe(false)
    expect(new SessionNotes(dir).get(S4)).toEqual(alpha)
    b3.stop()
  })

  it('a marker that restored() cannot delete keeps needsRestore() true, and a later restored() clears it', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'starred-sessions.json'), JSON.stringify([S1]), 'utf8')
    // a folder where the marker is: the marker is there, and rmSync without recursive cannot remove it
    mkdirSync(join(dir, 'starred-sessions.restore.json'))
    const errors: string[] = []
    const s = new StarredSessions(dir, (m) => errors.push(m))
    expect(s.needsRestore()).toBe(true)
    s.restored()
    expect(errors.length).toBeGreaterThan(0)
    expect(s.needsRestore()).toBe(true)
    rmSync(join(dir, 'starred-sessions.restore.json'), { recursive: true, force: true })
    s.restored()
    expect(s.needsRestore()).toBe(false)
  })

  it('a start that throws in the notes loop forgets nothing: the next start still has the detached keys and restores the stores', () => {
    const dir = newDir()
    const S4 = randomUUID()
    mine.write('stars', S1, true)
    mine.write('notes', S2, alpha)
    const s = new StarredSessions(dir)
    const n = new SessionNotes(dir, { debounceMs: 20 })
    s.set(S4, true)
    n.set(S3, alpha)
    let broken = true
    const flaky: BridgeGroup = {
      ...fakeGroup(mine),
      write: (col, key, value, base?) => {
        if (col === 'notes' && broken) throw new Error('keyring busy')
        mine.write(col, key, value, base)
        return null
      }
    }
    const first = new StoreBridge(s, n, flaky, { debounceMs: 50 })
    expect(() => first.start()).toThrow('keyring busy')
    expect(s.needsRestore()).toBe(true)
    expect(n.needsRestore()).toBe(true)
    expect([...s.detachedChanges()]).toEqual([S4])
    expect([...n.detachedChanges()]).toEqual([S3])
    broken = false
    const second = new StoreBridge(s, n, fakeGroup(mine), { debounceMs: 50 })
    second.start()
    expect(s.needsRestore()).toBe(false)
    expect(n.needsRestore()).toBe(false)
    expect(starOf(mine.get('stars', S4))).toBe(true)
    expect(noteOf(mine.get('notes', S3))).toEqual(alpha)
    expect(s.ids().has(S1)).toBe(true)
    expect(n.get(S2)).toEqual(alpha)
    second.stop()
  })
})
