import { describe, expect, it } from 'vitest'
import { emptyReplica, Replica, type RecordUpdate, type ReplicaData } from '../../src/main/sync/replica'
import { starOf } from '../../src/main/sync/views'
import type { Note } from '../../src/shared/note'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'
const S1 = 'a0000000-0000-4000-8000-000000000001'
const S2 = 'a0000000-0000-4000-8000-000000000002'
const S3 = 'a0000000-0000-4000-8000-000000000003'
const noteA: Note = { text: 'one', shown: true, form: 'card' }
const noteB: Note = { text: 'two', shown: true, form: 'label' }

describe('Replica', () => {
  it('a later local write replaces the earlier one', () => {
    const r = new Replica(emptyReplica(A), () => 1000)
    r.write('stars', S1, true)
    r.write('stars', S1, false)
    expect(r.get('stars', S1)!.siblings.map((s) => s.value)).toEqual([false])
    expect(r.seen()).toEqual({ [A]: 2 })
  })

  it('two writes on the same base from two devices are both kept, whatever the order of arrival', () => {
    const a = new Replica(emptyReplica(A), () => 1000)
    const b = new Replica(emptyReplica(B), () => 2000)
    const wa = a.write('notes', S1, noteA)
    const wb = b.write('notes', S1, noteB)
    const x = new Replica(emptyReplica(C))
    x.apply([wa])
    x.apply([wb])
    const y = new Replica(emptyReplica(D))
    y.apply([wb])
    y.apply([wa])
    expect(x.get('notes', S1)).toEqual(y.get('notes', S1))
    expect(x.get('notes', S1)!.siblings).toHaveLength(2)
  })

  it("a write on a base that includes the other device's write replaces it", () => {
    const a = new Replica(emptyReplica(A), () => 1000)
    const b = new Replica(emptyReplica(B), () => 2000)
    const wa = a.write('notes', S1, noteA)
    b.apply([wa])
    const wb = b.write('notes', S1, noteB)
    a.apply([wb])
    expect(a.get('notes', S1)!.siblings).toHaveLength(1)
    expect(a.get('notes', S1)!.siblings[0].value).toEqual(noteB)
    expect(a.get('notes', S1)).toEqual(b.get('notes', S1))
  })

  it('a write on an older base (passed explicitly) keeps the sibling it did not see', () => {
    const a = new Replica(emptyReplica(A), () => 1000)
    const b = new Replica(emptyReplica(B), () => 2000)
    a.write('notes', S1, noteA)
    const base = a.context('notes', S1)
    const wb = b.write('notes', S1, noteB)
    a.apply([wb])
    a.write('notes', S1, { text: 'three', shown: true, form: 'card' }, base)
    const texts = a.get('notes', S1)!.siblings.map((s) => (s.value as Note).text).sort()
    expect(texts).toEqual(['three', 'two'])
  })

  it('applying the same update twice changes nothing and is not reported', () => {
    const a = new Replica(emptyReplica(A), () => 1000)
    const wa = a.write('stars', S1, true)
    const x = new Replica(emptyReplica(C))
    expect(x.apply([wa])).toHaveLength(1)
    expect(x.apply([wa])).toEqual([])
  })

  it('since() gives the records with writes the peer has not seen; absorbSeen raises seen', () => {
    const a = new Replica(emptyReplica(A), () => 1000)
    a.write('stars', S1, true)
    a.write('stars', S2, true)
    expect(a.since({ [A]: 1 }).map((u) => u.key)).toEqual([S2])
    expect(a.since({}).map((u) => u.key).sort()).toEqual([S1, S2].sort())
    a.absorbSeen({ [B]: 7 })
    expect(a.seen()[B]).toBe(7)
  })

  it('apply advances seen only over writes without a gap', () => {
    const a = new Replica(emptyReplica(A), () => 1000)
    const w1 = a.write('stars', S1, true)
    const w2 = a.write('stars', S2, true)
    const w3 = a.write('stars', S3, true)
    const x = new Replica(emptyReplica(C))
    x.apply([w3])
    expect(x.seen()[A] ?? 0).toBe(0)
    x.apply([w1, w2])
    expect(x.seen()[A]).toBe(2)
    x.apply([w3])
    expect(x.seen()[A]).toBe(3)
  })

  it('a device whose clock runs an hour ahead does not make a later change lose', () => {
    const base = 1_700_000_000_000
    const a = new Replica(emptyReplica(A), () => base)
    const fast = new Replica(emptyReplica(B), () => base + 3_600_000)
    const wf = fast.write('stars', S1, true)
    a.apply([wf])
    expect(starOf(a.get('stars', S1))).toBe(true)
    const wa = a.write('stars', S1, false)
    expect(starOf(a.get('stars', S1))).toBe(false)
    fast.apply([wa])
    expect(starOf(fast.get('stars', S1))).toBe(false)
  })

  it('a sibling that fails validSibling is dropped on apply', () => {
    const bad: RecordUpdate = {
      col: 'stars',
      key: S1,
      state: { siblings: [{ value: 'yes', at: { t: 1000, c: 0 }, dot: [B, 1] }], ctx: { [B]: 1 } }
    }
    const x = new Replica(emptyReplica(C))
    expect(x.apply([bad])).toEqual([])
    expect(x.get('stars', S1)).toBeUndefined()
  })

  it('an update with no valid sibling changes nothing, even when its context covers stored writes', () => {
    const a = new Replica(emptyReplica(A), () => 1000)
    const b = new Replica(emptyReplica(B), () => 2000)
    const wa = a.write('stars', S1, true)
    const wb = b.write('stars', S1, false)
    const x = new Replica(emptyReplica(C))
    x.apply([wa, wb])
    expect(x.get('stars', S1)!.siblings).toHaveLength(2)
    const forged: RecordUpdate[] = [
      { col: 'stars', key: S1, state: { siblings: [{ value: 'yes', at: { t: 3000, c: 0 }, dot: [B, 2] }], ctx: { [A]: 1 } } },
      { col: 'stars', key: S1, state: { siblings: [], ctx: { [A]: 1 } } }
    ]
    expect(x.apply([forged[0]])).toEqual([])
    expect(x.apply([forged[1]])).toEqual([])
    expect(x.get('stars', S1)!.siblings.map((s) => s.dot)).toEqual([[A, 1], [B, 1]])
    expect(x.seen()[B]).toBe(1)
  })

  it('malformed updates from the network are dropped without throwing', () => {
    const x = new Replica(emptyReplica(C))
    const junk = [
      { col: 'bogus', key: S1, state: { siblings: [], ctx: {} } },
      { col: 'stars', key: 'not-a-uuid', state: { siblings: [], ctx: {} } },
      { col: 'stars', key: S1, state: null }
    ] as unknown as RecordUpdate[]
    expect(() => x.apply(junk)).not.toThrow()
    expect(x.apply(junk)).toEqual([])
    expect(x.keys('stars')).toEqual([])
  })

  it('data() round-trips: a replica built from its data holds the same records and seen', () => {
    const r = new Replica(emptyReplica(A), () => 1000)
    r.write('notes', S1, noteA)
    const copy = new Replica(JSON.parse(JSON.stringify(r.data())) as ReplicaData, () => 2000)
    expect(copy.get('notes', S1)).toEqual(r.get('notes', S1))
    expect(copy.seen()).toEqual({ [A]: 1 })
  })
})
