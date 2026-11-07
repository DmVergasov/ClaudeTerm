import { isUuid } from '../../shared/protocol'
import { Clock, type Stamp } from './clock'
import { isPlainObject, validSibling } from './views'

/** The record kinds a replica keeps; each key of each kind is synced on its own. */
export type Collection = 'admitted' | 'removed' | 'members' | 'stars' | 'notes'

export const COLLECTIONS: readonly Collection[] = ['admitted', 'removed', 'members', 'stars', 'notes']

/** The write that produced a sibling: the writing device and its sequence number. */
export type Dot = [by: string, seq: number]

export type VersionVector = Record<string, number>

/** One concurrent value of a key; `dot` tells the writes apart. */
export interface Sibling {
  value: unknown
  at: Stamp
  dot: Dot
}

/** The concurrent values of a key, and the writes they have seen (`ctx`). */
export interface KeyState {
  siblings: Sibling[]
  ctx: VersionVector
}

export interface RecordUpdate {
  col: Collection
  key: string
  state: KeyState
}

export interface LocalState {
  addresses: Record<string, string>
  name: string | null
  removedBy: string | null
}

/**
 * How many sequence numbers a save reserves past the one in use. A crash loses the writes made after the last save, and the
 * numbers they used may already have left the device: a reopened replica starts above the reserved numbers, not at the saved one.
 */
export const SEQ_RESERVE = 64

export interface ReplicaData {
  version: 1
  device: string
  seq: number
  /** the highest sequence number that may have been used; the replica file is saved before a write using a number above the last reserved one leaves the device */
  reserved: number
  clock: Stamp | null
  seen: VersionVector
  records: Record<Collection, Record<string, KeyState>>
  local: LocalState
}

export function emptyReplica(device: string): ReplicaData {
  return {
    version: 1,
    device,
    seq: 0,
    reserved: 0,
    clock: null,
    seen: {},
    records: { admitted: {}, removed: {}, members: {}, stars: {}, notes: {} },
    local: { addresses: {}, name: null, removedBy: null }
  }
}

/**
 * This device's copy of the synced records. Every write gets a dot; concurrent writes stay as
 * siblings until a later write that has seen them replaces them. Applying updates in any order
 * gives the same states.
 */
export class Replica {
  readonly device: string
  local: LocalState
  private readonly clock: Clock
  private seq: number
  private reserved: number
  /** set when a write moved the reservation: the saved file must carry it before the write leaves the device */
  private reserveUnsaved = false
  private readonly seenVv: VersionVector
  private readonly records: Record<Collection, Record<string, KeyState>>

  constructor(data: ReplicaData, now: () => number = () => Date.now()) {
    this.device = data.device
    // numbers up to the reservation may have been used before the save, so none of them is used again
    this.seq = Math.max(data.seq, data.reserved)
    this.reserved = data.reserved
    this.seenVv = copy(data.seen)
    this.records = copy(data.records)
    this.local = copy(data.local)
    this.clock = new Clock(data.clock, now)
  }

  get(col: Collection, key: string): KeyState | undefined {
    return this.stateOf(col, key)
  }

  keys(col: Collection): string[] {
    return Object.keys(this.records[col])
  }

  /** The writes a key's current state has seen. */
  context(col: Collection, key: string): VersionVector {
    return copy(this.stateOf(col, key)?.ctx ?? {})
  }

  /** A local write. `base` is what the writer saw: the siblings it covers are replaced, the rest stay. */
  write(col: Collection, key: string, value: unknown, base: VersionVector = this.context(col, key)): RecordUpdate {
    this.seq += 1
    if (this.seq > this.reserved) {
      this.reserved = this.seq + SEQ_RESERVE
      this.reserveUnsaved = true
    }
    this.seenVv[this.device] = this.seq
    const dot: Dot = [this.device, this.seq]
    const at = this.clock.now()
    const cur = this.stateOf(col, key) ?? { siblings: [], ctx: {} }
    const siblings = cur.siblings.filter((s) => !covers(base, s.dot))
    siblings.push({ value, at, dot })
    const ctx = maxVV(cur.ctx, base)
    ctx[this.device] = this.seq
    const state = sorted({ siblings, ctx })
    this.store(col, key, state)
    return { col, key, state: copy(state) }
  }

  /** Merges updates from another device. Returns the states that changed. */
  apply(updates: RecordUpdate[]): RecordUpdate[] {
    const changed: RecordUpdate[] = []
    const received = new Map<string, number[]>()
    for (const u of updates) {
      const incoming = this.checked(u)
      if (!incoming) continue
      for (const s of incoming.siblings) {
        this.clock.observe(s.at)
        if (s.dot[0] === this.device) continue
        received.set(s.dot[0], [...(received.get(s.dot[0]) ?? []), s.dot[1]])
      }
      const cur = this.stateOf(u.col, u.key) ?? { siblings: [], ctx: {} }
      const merged = merge(cur, incoming)
      if (merged.siblings.length === 0 || sameState(merged, cur)) continue
      this.store(u.col, u.key, merged)
      changed.push({ col: u.col, key: u.key, state: copy(merged) })
    }
    for (const [device, seqs] of received) {
      let seen = this.seenVv[device] ?? 0
      for (const q of seqs.sort((x, y) => x - y)) if (q === seen + 1) seen = q
      if (seen > (this.seenVv[device] ?? 0)) this.seenVv[device] = seen
    }
    return changed
  }

  /** The records holding a write the peer (by its seen vector) has not seen. */
  since(peer: VersionVector): RecordUpdate[] {
    const out: RecordUpdate[] = []
    for (const col of COLLECTIONS) {
      for (const key of this.keys(col)) {
        const state = this.records[col][key]
        if (state.siblings.some((s) => s.dot[1] > (peer[s.dot[0]] ?? 0))) out.push({ col, key, state: copy(state) })
      }
    }
    return out
  }

  /**
   * Whether a write moved the sequence reservation and the replica file has not been saved since: the group saves before it
   * sends anything. Returns true once per reservation.
   */
  takeReserveSave(): boolean {
    const unsaved = this.reserveUnsaved
    this.reserveUnsaved = false
    return unsaved
  }

  /** The save that `takeReserveSave` asked for failed: the reservation is unsaved again, and the next send tries once more. */
  reserveSaveFailed(): void {
    this.reserveUnsaved = true
  }

  seen(): VersionVector {
    return copy(this.seenVv)
  }

  /** Raises the seen vector to a peer's, ignoring entries that are not device ids with sequence numbers. */
  absorbSeen(v: VersionVector): void {
    if (!isPlainObject(v)) return
    for (const [device, seq] of Object.entries(v)) {
      if (!isUuid(device) || !Number.isSafeInteger(seq) || seq < 0) continue
      if (seq > (this.seenVv[device] ?? 0)) this.seenVv[device] = seq
    }
  }

  data(): ReplicaData {
    return copy({
      version: 1,
      device: this.device,
      seq: this.seq,
      reserved: this.reserved,
      clock: this.clock.last(),
      seen: this.seenVv,
      records: this.records,
      local: this.local
    })
  }

  private stateOf(col: Collection, key: string): KeyState | undefined {
    return Object.prototype.hasOwnProperty.call(this.records[col], key) ? this.records[col][key] : undefined
  }

  private store(col: Collection, key: string, state: KeyState): void {
    this.records[col][key] = state
  }

  /**
   * An update from the network, with its siblings and context checked. Null when the key is not valid,
   * or when no sibling survives: a context alone must not remove what this device holds.
   */
  private checked(u: RecordUpdate): KeyState | null {
    if (!isPlainObject(u) || !COLLECTIONS.some((c) => c === u.col) || !isUuid(u.key)) return null
    const st: unknown = u.state
    if (!isPlainObject(st) || !Array.isArray(st.siblings)) return null
    const siblings: Sibling[] = []
    for (const s of st.siblings as Sibling[]) {
      if (!validSibling(u.col, u.key, s)) continue
      siblings.push({ value: s.value, at: { t: s.at.t, c: s.at.c }, dot: [s.dot[0], s.dot[1]] })
    }
    if (siblings.length === 0) return null
    return sorted({ siblings, ctx: sanitizeVV(st.ctx) })
  }
}

function merge(a: KeyState, b: KeyState): KeyState {
  const inB = dotSet(b.siblings)
  const keepA = a.siblings.filter((s) => !covers(b.ctx, s.dot) || inB.has(dotKey(s.dot)))
  const inA = dotSet(keepA)
  const keepB = b.siblings.filter((s) => !covers(a.ctx, s.dot) && !inA.has(dotKey(s.dot)))
  return sorted({ siblings: [...keepA, ...keepB], ctx: maxVV(a.ctx, b.ctx) })
}

/** Siblings sorted by dot, so equal states compare and serialize equally. */
function sorted(state: KeyState): KeyState {
  const siblings = [...state.siblings].sort((x, y) =>
    x.dot[0] !== y.dot[0] ? (x.dot[0] < y.dot[0] ? -1 : 1) : x.dot[1] - y.dot[1]
  )
  return { siblings, ctx: state.ctx }
}

/** A dot names one write, so two states with the same dots and context hold the same values. */
function sameState(a: KeyState, b: KeyState): boolean {
  const ka = [...dotSet(a.siblings)].sort()
  const kb = [...dotSet(b.siblings)].sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  const da = Object.keys(a.ctx)
  return da.length === Object.keys(b.ctx).length && da.every((d) => a.ctx[d] === b.ctx[d])
}

function covers(vv: VersionVector, dot: Dot): boolean {
  return (vv[dot[0]] ?? 0) >= dot[1]
}

function maxVV(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a }
  for (const [device, seq] of Object.entries(b)) out[device] = Math.max(out[device] ?? 0, seq)
  return out
}

function sanitizeVV(v: unknown): VersionVector {
  const out: VersionVector = {}
  if (!isPlainObject(v)) return out
  for (const [device, seq] of Object.entries(v)) {
    if (isUuid(device) && Number.isSafeInteger(seq) && (seq as number) >= 0) out[device] = seq as number
  }
  return out
}

function dotKey(dot: Dot): string {
  return `${dot[0]}/${dot[1]}`
}

function dotSet(siblings: Sibling[]): Set<string> {
  return new Set(siblings.map((s) => dotKey(s.dot)))
}

function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
