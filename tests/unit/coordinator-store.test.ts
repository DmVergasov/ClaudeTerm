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
const DEV = '62738495-0fb0-4b2c-9d4e-5f6071829304'
const TASK = '73849506-1ac1-4c3d-8e5f-60718293a4b5'
const REPORT = '84950617-2bd2-4d4e-9f60-718293a4b5c6'

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
      lastReport: { id: REPORT, outcome: 'finished', reason: null, at: 300 }
    },
    { device: DEV, session: S, name: 'Search', attachedAt: 210, resolved: true, failed: false, lastReport: null }
  ]
}
const hosted: StoredHosted = {
  session: S,
  coordinator: { device: null, session: A, name: 'Coordinator' },
  project: 'Shop',
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

  it('entries that do not check are skipped and the rest kept', () => {
    const dir = newDir()
    const badAttachment = { ...coord.attachments[0], name: 'Check\nout' }
    const outcomeless = { ...coord.attachments[0], session: S3, lastReport: { id: REPORT, outcome: 'maybe', reason: null, at: 1 } }
    const doneTask = { ...hosted.tasks[0], state: 'done' }
    const raw = {
      version: 1,
      coordinators: [
        { ...coord, attachments: [...coord.attachments, badAttachment, outcomeless] },
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
    expect(store.coordinators()).toEqual([coord])
    expect(store.allHosted()).toEqual([hosted, { ...hosted, session: S3, tasks: [] }])
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
})
