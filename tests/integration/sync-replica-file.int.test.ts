import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ReplicaFile } from '../../src/main/sync/replica-file'
import { emptyReplica, type ReplicaData } from '../../src/main/sync/replica'

const DEVICE = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

const dir = (): string => mkdtempSync(join(tmpdir(), 'ct-replica-'))

const sample = (): ReplicaData => {
  const data = emptyReplica(DEVICE)
  data.seq = 3
  data.clock = { t: 1700000000000, c: 2 }
  data.seen = { [DEVICE]: 3 }
  data.local.name = 'Work laptop'
  return data
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('ReplicaFile', () => {
  it('a missing file loads as null', () => {
    const warnings: string[] = []
    const file = new ReplicaFile(dir(), { warn: (m) => warnings.push(m) })
    expect(file.load()).toBeNull()
    expect(warnings).toEqual([])
  })

  it('saves after the debounce, through a temp file, and loads the same data', async () => {
    const d = dir()
    const file = new ReplicaFile(d, { debounceMs: 20 })
    const data = sample()
    file.schedule(() => data)
    expect(readdirSync(d)).toEqual([])
    await wait(60)
    expect(readdirSync(d)).toEqual(['sync-replica.json'])
    expect(new ReplicaFile(d).load()).toEqual(data)
  })

  it('flush writes at once; schedule after flush writes again later', async () => {
    const d = dir()
    const file = new ReplicaFile(d, { debounceMs: 20 })
    const first = sample()
    file.schedule(() => first)
    file.flush()
    expect(new ReplicaFile(d).load()).toEqual(first)

    const second = sample()
    second.seq = 4
    second.seen = { [DEVICE]: 4 }
    file.schedule(() => second)
    expect(new ReplicaFile(d).load()).toEqual(first)
    await wait(60)
    expect(new ReplicaFile(d).load()).toEqual(second)
  })

  it('flush with nothing scheduled writes nothing', () => {
    const d = dir()
    new ReplicaFile(d).flush()
    expect(readdirSync(d)).toEqual([])
  })

  it('remove deletes the file, cancels a pending save, and is quiet when there is no file', async () => {
    const d = dir()
    const file = new ReplicaFile(d, { debounceMs: 20 })
    file.schedule(() => sample())
    file.flush()
    expect(readdirSync(d)).toEqual(['sync-replica.json'])
    file.remove()
    expect(readdirSync(d)).toEqual([])
    expect(() => file.remove()).not.toThrow()

    file.schedule(() => sample())
    file.remove()
    await wait(60)
    expect(readdirSync(d)).toEqual([])
  })

  it('a file that is not replica data is moved aside, reported, and loads as null', () => {
    const d = dir()
    const path = join(d, 'sync-replica.json')
    writeFileSync(path, '{nope')
    const warnings: string[] = []
    const file = new ReplicaFile(d, { warn: (m) => warnings.push(m) })
    expect(file.load()).toBeNull()
    expect(readdirSync(d).some((n) => n.startsWith('sync-replica.json.corrupt-'))).toBe(true)
    expect(readdirSync(d).includes('sync-replica.json')).toBe(false)
    expect(warnings).toEqual([
      expect.stringMatching(/^Device sync data could not be read; the file was kept as sync-replica\.json\.corrupt-\d+$/)
    ])
  })

  it('a file of a wrong version or shape is moved aside too', () => {
    const cases: unknown[] = [
      { ...sample(), version: 2 },
      { version: 1, device: 'x' },
      { ...sample(), seq: -1 },
      { ...sample(), seq: 1.5 },
      { ...sample(), seen: [] },
      { ...sample(), local: null },
      { ...sample(), clock: 'now' },
      { ...sample(), records: { admitted: {}, removed: 'x', members: {}, stars: {}, notes: {} } },
      { ...sample(), records: { admitted: {}, removed: {}, members: {}, stars: {}, notes: { [DEVICE]: 5 } } },
      { ...sample(), records: { admitted: {}, removed: {}, members: {}, stars: { [DEVICE]: { siblings: 'x', ctx: {} } }, notes: {} } },
      { ...sample(), records: { admitted: {}, removed: {}, members: {}, stars: { [DEVICE]: { siblings: [], ctx: [] } }, notes: {} } },
      { ...sample(), local: { addresses: [], name: null, removedBy: null } },
      { ...sample(), local: { addresses: {}, name: 7, removedBy: null } },
      { ...sample(), local: { addresses: {}, name: null, removedBy: {} } },
      [1, 2, 3]
    ]
    for (const bad of cases) {
      const d = dir()
      writeFileSync(join(d, 'sync-replica.json'), JSON.stringify(bad))
      const warnings: string[] = []
      expect(new ReplicaFile(d, { warn: (m) => warnings.push(m) }).load()).toBeNull()
      expect(readdirSync(d).some((n) => n.startsWith('sync-replica.json.corrupt-'))).toBe(true)
      expect(warnings).toHaveLength(1)
    }
  })

  it('a file whose saved sibling has no dot, or a bad dot or stamp, is moved aside too', () => {
    const key = '6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b'
    const withSibling = (sibling: unknown) => ({
      ...sample(),
      records: { admitted: {}, removed: {}, members: {}, stars: {}, notes: { [key]: { siblings: [sibling], ctx: { [DEVICE]: 1 } } } }
    })
    const good = withSibling({ value: 'a note', at: { t: 1, c: 0 }, dot: [DEVICE, 1] })
    const bad: unknown[] = [
      withSibling({ value: 'a note', at: { t: 1, c: 0 } }),
      withSibling({ value: 'a note', at: { t: 1, c: 0 }, dot: [DEVICE] }),
      withSibling({ value: 'a note', at: { t: 1, c: 0 }, dot: ['not-a-device', 1] }),
      withSibling({ value: 'a note', at: { t: 1, c: 0 }, dot: [DEVICE, 0] }),
      withSibling({ value: 'a note', dot: [DEVICE, 1] }),
      withSibling({ value: 'a note', at: { t: '1', c: 0 }, dot: [DEVICE, 1] })
    ]
    const d = dir()
    writeFileSync(join(d, 'sync-replica.json'), JSON.stringify(good))
    expect(new ReplicaFile(d).load()).not.toBeNull()
    for (const each of bad) {
      const d2 = dir()
      writeFileSync(join(d2, 'sync-replica.json'), JSON.stringify(each))
      const warnings: string[] = []
      expect(new ReplicaFile(d2, { warn: (m) => warnings.push(m) }).load()).toBeNull()
      expect(readdirSync(d2).some((n) => n.startsWith('sync-replica.json.corrupt-'))).toBe(true)
      expect(warnings).toHaveLength(1)
    }
  })

  it('a file with a missing collection gets the missing collections as empty', () => {
    const d = dir()
    const partial = sample() as unknown as { records: Record<string, unknown> }
    partial.records = { admitted: { k: { siblings: [], ctx: {} } } }
    writeFileSync(join(d, 'sync-replica.json'), JSON.stringify(partial))
    const loaded = new ReplicaFile(d).load()
    expect(loaded?.records).toEqual({
      admitted: { k: { siblings: [], ctx: {} } },
      removed: {},
      members: {},
      stars: {},
      notes: {}
    })
  })

  it('a file saved before the reserved sequence number existed loads with it equal to seq', () => {
    const d = dir()
    const old = sample() as unknown as Record<string, unknown>
    delete old.reserved
    writeFileSync(join(d, 'sync-replica.json'), JSON.stringify(old))
    expect(new ReplicaFile(d).load()?.reserved).toBe(3)
  })

  it('a folder that cannot be written reports through onError and does not throw', () => {
    const errors: string[] = []
    const file = new ReplicaFile(join(dir(), 'missing', 'deeper'), { onError: (m) => errors.push(m) })
    expect(() => file.schedule(() => sample())).not.toThrow()
    expect(() => file.flush()).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^cannot save /)
  })

  it('a getter that throws is reported through onError by flush, and does not escape', () => {
    const errors: string[] = []
    const file = new ReplicaFile(dir(), { onError: (m) => errors.push(m) })
    file.schedule(() => {
      throw new Error('boom')
    })
    expect(() => file.flush()).not.toThrow()
    expect(errors).toEqual([expect.stringMatching(/^cannot save .*boom$/)])
    // the failed data is dropped, so a later flush does not retry it
    file.flush()
    expect(errors).toHaveLength(1)
  })

  it('a getter that throws inside the debounce timer does not become an uncaught exception', async () => {
    const d = dir()
    const errors: string[] = []
    const file = new ReplicaFile(d, { debounceMs: 5, onError: (m) => errors.push(m) })
    file.schedule(() => {
      throw new Error('boom')
    })
    await wait(40)
    expect(errors).toHaveLength(1)
    expect(readdirSync(d)).toEqual([])
  })

  it('when the file cannot be moved aside, nothing is written over it: load reports, flush writes nothing', () => {
    const d = dir()
    const path = join(d, 'sync-replica.json')
    const original = '{nope'
    writeFileSync(path, original)
    // the move-aside target already exists as a directory, so renaming the file onto it fails on every platform
    const fixed = 1700000000000
    mkdirSync(`${path}.corrupt-${fixed}`)
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixed)
    const warnings: string[] = []
    const errors: string[] = []
    try {
      const file = new ReplicaFile(d, { warn: (m) => warnings.push(m), onError: (m) => errors.push(m) })
      expect(file.load()).toBeNull()
      expect(errors).toEqual([expect.stringMatching(/^cannot move .* aside: /)])
      expect(warnings).toEqual([
        `Device sync data could not be read and is not being saved this run: ${path}`
      ])

      file.schedule(() => sample())
      file.flush()
      expect(readFileSync(path, 'utf8')).toBe(original)
      expect(readdirSync(d).sort()).toEqual(['sync-replica.json', `sync-replica.json.corrupt-${fixed}`])
      expect(errors).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })
})
