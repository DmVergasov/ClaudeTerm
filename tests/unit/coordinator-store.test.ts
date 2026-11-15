import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoordinatorStore, type StoredCoordinator, type StoredHosted } from '../../src/main/coordinator/coordinator-store'

const A = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const A2 = '40516273-8d9e-4f0a-9b2c-3d4e5f607182'
const S = '2e3f4051-6b7c-4d8e-9f0a-1b2c3d4e5f60'
const S2 = '3f405162-7c8d-4e9f-8a1b-2c3d4e5f6071'
const S3 = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'
const S4 = '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f'
const DEV = '62738495-0fb0-4b2c-9d4e-5f6071829304'
const TASK = '73849506-1ac1-4c3d-8e5f-60718293a4b5'
const REPORT = '84950617-2bd2-4d4e-9f60-718293a4b5c6'
const ATTACH = '95061728-3ce3-4e5f-8a0b-3c4d5e6f7081'

/** the n-th id of a test, a UUID */
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const coord: StoredCoordinator = {
  session: A,
  project: { key: '/work/shop', name: 'Shop' },
  since: 100,
  attachments: [
    {
      device: null,
      session: S,
      name: 'Checkout',
      attachedAt: 200,
      resolved: false,
      failed: false,
      pending: null,
      lastReport: { id: REPORT, outcome: 'finished', reason: null, at: 300 }
    },
    { device: DEV, session: S, name: 'Search', attachedAt: 210, resolved: true, failed: false, pending: null, lastReport: null }
  ],
  former: []
}
const hosted: StoredHosted = {
  session: S,
  coordinator: { device: null, session: A, name: 'Coordinator' },
  project: 'Shop',
  former: [],
  tasks: [{ id: TASK, from: { device: null, session: A, name: 'Coordinator' }, state: 'queued', queuedAt: 400, deliveredAt: null }]
}

const dirs: string[] = []
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ct-coord-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('coordinator store', () => {
  it('a coordinator, its attachments and a hosted session with its tasks are on disk after flush and come back', () => {
    const dir = newDir()
    const a = new CoordinatorStore(dir, { debounceMs: 60_000 })
    a.putCoordinator(coord)
    a.putHosted(hosted)
    a.flush()
    expect(JSON.parse(readFileSync(join(dir, 'coordinators.json'), 'utf8'))).toEqual({
      version: 1,
      coordinators: [coord],
      hosted: [hosted]
    })
    const b = new CoordinatorStore(dir)
    expect(b.coordinators()).toEqual([coord])
    expect(b.hosted(S)).toEqual(hosted)
    expect(b.allHosted()).toEqual([hosted])
  })

  it('coordinatorOf finds the coordinator of a project key', () => {
    const store = new CoordinatorStore(newDir(), { debounceMs: 60_000 })
    store.putCoordinator(coord)
    expect(store.coordinatorOf('/work/shop')).toEqual(coord)
    expect(store.coordinatorOf('/work/other')).toBeNull()
    expect(store.coordinator(A)).toEqual(coord)
  })

  it('renameSession moves the coordinator\'s own id, the attachments and the hosted entry of this device, a hosted coordinator address and the tasks it gave', () => {
    const store = new CoordinatorStore(newDir(), { debounceMs: 60_000 })
    store.putCoordinator(coord)
    store.putHosted(hosted)

    expect(store.renameSession(S, S2)).toBe(true)
    expect(store.coordinator(A)?.attachments.map((x) => [x.device, x.session])).toEqual([
      [null, S2],
      [DEV, S]
    ])
    expect(store.hosted(S)).toBeNull()
    expect(store.hosted(S2)?.coordinator).toEqual({ device: null, session: A, name: 'Coordinator' })

    expect(store.renameSession(A, A2)).toBe(true)
    expect(store.coordinator(A)).toBeNull()
    expect(store.coordinator(A2)?.attachments.map((x) => [x.device, x.session])).toEqual([
      [null, S2],
      [DEV, S]
    ])
    expect(store.hosted(S2)?.coordinator.session).toBe(A2)
    expect(store.hosted(S2)?.tasks[0].from.session).toBe(A2)

    expect(store.renameSession(S3, A)).toBe(false)
  })

  it('renameSession onto an id that already names a hosted entry or a coordinator of this device changes nothing', () => {
    const store = new CoordinatorStore(newDir(), { debounceMs: 60_000 })
    store.putCoordinator(coord)
    store.putHosted(hosted)
    // S2 is a hosted session of another coordinator, A2 is a coordinator of its own
    store.putHosted({ ...hosted, session: S2, coordinator: { device: DEV, session: A2, name: 'Other' }, tasks: [] })
    store.putCoordinator({ ...coord, session: A2, project: { key: '/work/other', name: 'Other' }, attachments: [] })
    const before = { coordinators: store.coordinators(), hosted: store.allHosted() }

    expect(store.renameSession(S, S2)).toBe(false)
    expect(store.renameSession(A, A2)).toBe(false)
    expect(store.coordinators()).toEqual(before.coordinators)
    expect(store.allHosted()).toEqual(before.hosted)
    expect(store.coordinator(A)).toEqual(coord)
    expect(store.hosted(S)).toEqual(hosted)
  })

  it('entries that do not check are skipped and the rest kept', () => {
    const dir = newDir()
    const badAttachment = { ...coord.attachments[0], name: 'Check\nout' }
    const outcomeless = { ...coord.attachments[0], session: S3, lastReport: { id: REPORT, outcome: 'maybe', reason: null, at: 1 } }
    const emptyReason = { ...coord.attachments[0], session: S4, lastReport: { id: REPORT, outcome: 'failed', reason: '', at: 1 } }
    const controlReason = { ...coord.attachments[0], session: S4, lastReport: { id: REPORT, outcome: 'stopped', reason: 'a\u0007b', at: 1 } }
    const doneTask = { ...hosted.tasks[0], state: 'done' }
    const raw = {
      version: 1,
      coordinators: [
        { ...coord, attachments: [...coord.attachments, badAttachment, outcomeless, emptyReason, controlReason] },
        { ...coord, session: 'not-a-uuid', project: { key: '/work/x', name: 'X' } },
        { ...coord, session: S3, project: { key: '/bad\u0000key', name: 'Bad' } }
      ],
      hosted: [
        { ...hosted, tasks: [...hosted.tasks, doneTask] },
        { ...hosted, session: S3, tasks: [doneTask] },
        { ...hosted, session: 'bad-session' }
      ]
    }
    writeFileSync(join(dir, 'coordinators.json'), JSON.stringify(raw), 'utf8')

    const store = new CoordinatorStore(dir)
    expect(store.coordinator(A)?.attachments).toHaveLength(2)
    expect(store.coordinators()).toEqual([coord])
    expect(store.allHosted()).toEqual([hosted, { ...hosted, session: S3, tasks: [] }])
  })

  it('the load keeps the first 50 coordinators, 200 attachments of one, 500 hosted sessions and 20 tasks of one, in file order', () => {
    const dir = newDir()
    const coordinators = Array.from({ length: 51 }, (_, i) => ({
      session: uuid(i + 1),
      project: { key: `/work/p${i}`, name: `P${i}` },
      since: 1,
      attachments:
        i === 0
          ? Array.from({ length: 201 }, (_, j) => ({
              device: null,
              session: uuid(10_000 + j),
              name: `S${j}`,
              attachedAt: 1,
              resolved: false,
              failed: false,
              lastReport: null
            }))
          : []
    }))
    const hosted = Array.from({ length: 501 }, (_, i) => ({
      session: uuid(20_000 + i),
      coordinator: { device: null, session: uuid(1), name: 'Coordinator' },
      project: 'P0',
      tasks:
        i === 0
          ? Array.from({ length: 21 }, (_, j) => ({
              id: uuid(30_000 + j),
              from: { device: null, session: uuid(1), name: 'Coordinator' },
              state: 'queued',
              queuedAt: j + 1,
              deliveredAt: null
            }))
          : []
    }))
    writeFileSync(join(dir, 'coordinators.json'), JSON.stringify({ version: 1, coordinators, hosted }), 'utf8')

    const store = new CoordinatorStore(dir)
    const kept = store.coordinators()
    expect(kept.map((c) => c.session)).toEqual(coordinators.slice(0, 50).map((c) => c.session))
    expect(kept[0].attachments).toHaveLength(200)
    expect(kept[0].attachments.map((a) => a.session)).toEqual(coordinators[0].attachments.slice(0, 200).map((a) => a.session))
    const all = store.allHosted()
    expect(all.map((h) => h.session)).toEqual(hosted.slice(0, 500).map((h) => h.session))
    expect(all[0].tasks).toHaveLength(20)
    expect(all[0].tasks.map((t) => t.id)).toEqual(hosted[0].tasks.slice(0, 20).map((t) => t.id))
  })

  it('a file that is not coordinators is moved aside and the store opens empty', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'coordinators.json'), '[]', 'utf8')
    const warn = vi.fn()

    const store = new CoordinatorStore(dir, { warn })
    expect(store.coordinators()).toEqual([])
    expect(store.allHosted()).toEqual([])
    expect(existsSync(join(dir, 'coordinators.json'))).toBe(false)
    const kept = readdirSync(dir).filter((f) => f.startsWith('coordinators.json.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(`Coordinators could not be read; the file was kept as ${kept[0]}`)
  })

  it('an attachment keeps its pending attach id; a file of part 1 without pending or former loads them as null and []', () => {
    const dir = newDir()
    const bare = { device: null, name: 'Checkout', attachedAt: 200, resolved: false, failed: false, lastReport: null }
    const part1 = {
      version: 1,
      coordinators: [
        {
          session: A,
          project: { key: '/work/shop', name: 'Shop' },
          since: 100,
          attachments: [
            { ...bare, session: S },
            { ...bare, session: S2, pending: ATTACH },
            { ...bare, session: S3, pending: 'x' }
          ]
        }
      ],
      hosted: [{ session: S, coordinator: { device: null, session: A, name: 'Coordinator' }, project: 'Shop', tasks: [] }]
    }
    writeFileSync(join(dir, 'coordinators.json'), JSON.stringify(part1), 'utf8')

    const store = new CoordinatorStore(dir)
    expect(store.coordinator(A)!.attachments.map((a) => [a.session, a.pending])).toEqual([
      [S, null],
      [S2, ATTACH]
    ])
    expect(store.coordinator(A)!.former).toEqual([])
    expect(store.hosted(S)!.former).toEqual([])
  })

  it('former loads its UUID entries in file order, at most 8', () => {
    const dir = newDir()
    const junk = ['x', ATTACH, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(uuid)]
    const part = {
      version: 1,
      coordinators: [{ session: A, project: { key: '/work/shop', name: 'Shop' }, since: 100, attachments: [], former: junk }],
      hosted: [{ session: S, coordinator: { device: null, session: A, name: 'Coordinator' }, project: 'Shop', tasks: [], former: junk }]
    }
    writeFileSync(join(dir, 'coordinators.json'), JSON.stringify(part), 'utf8')

    const store = new CoordinatorStore(dir)
    const expected = [ATTACH, ...[1, 2, 3, 4, 5, 6, 7].map(uuid)]
    expect(store.coordinator(A)!.former).toEqual(expected)
    expect(store.hosted(S)!.former).toEqual(expected)
  })

  it('former loads without repeats and without the entry\'s own id', () => {
    const dir = newDir()
    const part = {
      version: 1,
      coordinators: [{ session: A, project: { key: '/work/shop', name: 'Shop' }, since: 100, attachments: [], former: [S, S, A, S2] }],
      hosted: [{ session: S, coordinator: { device: null, session: A, name: 'Coordinator' }, project: 'Shop', tasks: [], former: [S3, S3, S, S4] }]
    }
    writeFileSync(join(dir, 'coordinators.json'), JSON.stringify(part), 'utf8')

    const store = new CoordinatorStore(dir)
    expect(store.coordinator(A)!.former).toEqual([S, S2])
    expect(store.hosted(S)!.former).toEqual([S3, S4])
  })

  it('renameSession keeps the old id first in former, at most 8, and never the id it takes', () => {
    const store = new CoordinatorStore(newDir(), { debounceMs: 60_000 })
    store.putCoordinator(coord)
    store.putHosted(hosted)

    expect(store.renameSession(S, S2)).toBe(true)
    expect(store.hosted(S2)!.former).toEqual([S])
    expect(store.renameSession(S2, S)).toBe(true)
    expect(store.hosted(S)!.former).toEqual([S2])
    expect(store.renameSession(S, S2)).toBe(true)
    expect(store.hosted(S2)!.former).toEqual([S])

    expect(store.renameSession(A, A2)).toBe(true)
    expect(store.coordinator(A2)!.former).toEqual([A])
    let current = A2
    for (let n = 1; n <= 9; n++) {
      expect(store.renameSession(current, uuid(n))).toBe(true)
      current = uuid(n)
    }
    expect(store.coordinator(current)!.former).toEqual([8, 7, 6, 5, 4, 3, 2, 1].map(uuid))
  })

  it('coordinatorBy and hostedBy find an entry by its current id or a former one, and an unknown id gives null', () => {
    const store = new CoordinatorStore(newDir(), { debounceMs: 60_000 })
    store.putCoordinator(coord)
    store.putHosted(hosted)
    expect(store.renameSession(S, S2)).toBe(true)
    expect(store.renameSession(A, A2)).toBe(true)

    expect(store.coordinatorBy(A2)!.session).toBe(A2)
    expect(store.coordinatorBy(A)!.session).toBe(A2)
    expect(store.hostedBy(S2)!.session).toBe(S2)
    expect(store.hostedBy(S)!.session).toBe(S2)
    expect(store.coordinatorBy(uuid(99))).toBeNull()
    expect(store.hostedBy(uuid(99))).toBeNull()
  })
})
