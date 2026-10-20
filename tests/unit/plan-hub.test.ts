import { posix, win32, type PlatformPath } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PlanHub, type PlanRead } from '../../src/main/plan-hub'

const WS = '/w/acme-shop/.superpowers/sdd/2026-10-20-csv-export'
const PLAN = '/w/acme-shop/docs/superpowers/plans/2026-10-20-csv-export.md'
const PLAN_TEXT = '# CSV Export Implementation Plan\n### Task 1: Rows\n### Task 2: Escaping\n### Task 3: Button\n### Task 4: Save dialog\n'
const LEDGER = '# SDD ledger — plan: docs/superpowers/plans/2026-10-20-csv-export.md\nTask 1: complete (commits a..b, review clean)\n'
const run = (): Record<string, string> => ({
  [`${WS}/plan-path`]: 'docs/superpowers/plans/2026-10-20-csv-export.md\n',
  [PLAN]: PLAN_TEXT,
  [`${WS}/progress.md`]: LEDGER
})

const WS2 = '/w/acme-shop/.superpowers/sdd/2026-10-21-import'
const PLAN2 = '/w/acme-shop/docs/superpowers/plans/2026-10-21-import.md'
const run2 = (): Record<string, string> => ({
  [`${WS2}/plan-path`]: 'docs/superpowers/plans/2026-10-21-import.md\n',
  [PLAN2]: '# CSV Import Implementation Plan\n### Task 1: Parse\n### Task 2: Map\n',
  [`${WS2}/progress.md`]: ''
})

function setup(initial: Record<string, string> = run(), path: PlatformPath = posix) {
  const files: Record<string, string> = { ...initial }
  const changes: string[] = []
  const reads: string[] = []
  const gate = { hold: null as Promise<void> | null }
  const seen: (string | undefined)[] = []
  const hub: PlanHub = new PlanHub({
    path,
    read: async (file): Promise<PlanRead> => {
      reads.push(file)
      const held = gate.hold
      if (held) {
        gate.hold = null
        await held
      }
      return Object.prototype.hasOwnProperty.call(files, file) ? files[file] : 'missing'
    },
    onChange: (tabId) => {
      changes.push(tabId)
      seen.push(hub.get(tabId).plan?.title)
    }
  })
  return { files, changes, seen, reads, gate, hub }
}

const RES = { title: 'CSV Export', done: 1, total: 4, finished: false }

describe('PlanHub', () => {
  it('a reported workspace shows its plan', async () => {
    const { hub, changes } = setup()
    await hub.workspace('t', WS)
    const plan = hub.get('t').plan
    expect(plan).toMatchObject(RES)
    expect(plan?.tasks.map((t) => t.state)).toEqual(['done', 'current', 'left', 'left'])
    expect(changes).toEqual(['t'])
  })

  it('a completed task shows on the next refresh; an unchanged refresh sends nothing', async () => {
    const { hub, files, changes } = setup()
    await hub.workspace('t', WS)
    files[`${WS}/progress.md`] += 'Task 2: complete\n'
    await hub.refresh()
    expect(hub.get('t').plan?.done).toBe(2)
    expect(changes.length).toBe(2)
    await hub.refresh()
    expect(changes.length).toBe(2)
  })

  it('no ledger yet: Task 1 is current', async () => {
    const { hub, files } = setup()
    delete files[`${WS}/progress.md`]
    await hub.workspace('t', WS)
    const plan = hub.get('t').plan
    expect(plan?.done).toBe(0)
    expect(plan?.tasks[0].state).toBe('current')
  })

  it('the workspace deleted: finished, every task done, kept on later refreshes', async () => {
    const { hub, files } = setup()
    await hub.workspace('t', WS)
    for (const k of Object.keys(files)) delete files[k]
    await hub.refresh()
    expect(hub.get('t').plan).toMatchObject({ done: 4, finished: true })
    expect(hub.get('t').plan?.tasks.every((t) => t.state === 'done')).toBe(true)
    await hub.refresh()
    expect(hub.get('t').plan).toMatchObject({ done: 4, finished: true })
  })

  it('the workspace back after a git clean: follows the files again', async () => {
    const { hub, files } = setup()
    const saved = run()
    await hub.workspace('t', WS)
    for (const k of Object.keys(files)) delete files[k]
    await hub.refresh()
    Object.assign(files, saved)
    await hub.refresh()
    expect(hub.get('t').plan).toMatchObject({ done: 1, finished: false })
  })

  it('a failed or half-written read keeps the last state', async () => {
    const { hub, files, changes } = setup()
    await hub.workspace('t', WS)
    const good = run()
    const broken: [string, string][] = [
      [PLAN, 'error'],
      [PLAN, ''],
      [PLAN, '# CSV'],
      [`${WS}/progress.md`, 'error'],
      [`${WS}/plan-path`, 'error']
    ]
    for (const [file, value] of broken) {
      files[file] = value
      await hub.refresh()
      expect(hub.get('t').plan?.done).toBe(1)
      files[file] = good[file]
    }
    expect(changes.length).toBe(1)
  })

  it('a workspace already gone (a restart after a clean run) shows nothing', async () => {
    const { hub, changes } = setup({})
    await hub.workspace('t', WS)
    expect(hub.get('t').plan).toBeNull()
    expect(changes).toEqual([])
  })

  it('a printed path that is not absolute is ignored', async () => {
    const { hub } = setup()
    await hub.workspace('t', '.superpowers/sdd/x')
    expect(hub.get('t').plan).toBeNull()
  })

  it('a report older than the newest one taken is ignored; equal or untimed ones are taken', async () => {
    const { hub } = setup({ ...run(), ...run2() })
    hub.session('t', 's1')
    await hub.workspace('t', WS2, 2000)
    await hub.workspace('t', WS, 1000)
    expect(hub.get('t').plan?.title).toBe('CSV Import')
    await hub.workspace('t', WS, 2000)
    expect(hub.get('t').plan?.title).toBe('CSV Export')
    await hub.workspace('t', WS2)
    expect(hub.get('t').plan?.title).toBe('CSV Import')
  })

  it('a new session takes an older time again', async () => {
    const { hub } = setup({ ...run(), ...run2() })
    hub.session('t', 's1')
    await hub.workspace('t', WS2, 2000)
    hub.session('t', 's2')
    await hub.workspace('t', WS, 1000)
    expect(hub.get('t').plan?.title).toBe('CSV Export')
  })

  it('a second workspace replaces the first; the same one reported again keeps its state', async () => {
    const { hub, files } = setup({ ...run(), ...run2() })
    await hub.workspace('t', WS)
    await hub.workspace('t', WS2)
    expect(hub.get('t').plan?.title).toBe('CSV Import')
    files[PLAN2] = 'error'
    await hub.workspace('t', WS2)
    expect(hub.get('t').plan?.title).toBe('CSV Import')
  })

  it('a workspace reported while a read runs wins', async () => {
    const { hub, gate, seen } = setup({ ...run(), ...run2() })
    let release!: () => void
    gate.hold = new Promise<void>((r) => { release = r })
    const first = hub.workspace('t', WS)
    const second = hub.workspace('t', WS2)
    release()
    await Promise.all([first, second])
    expect(hub.get('t').plan?.title).toBe('CSV Import')
    expect(seen).not.toContain('CSV Export')
  })

  it('reads of one tab never overlap; a read requested while one runs runs once more after it', async () => {
    const { hub, gate, reads } = setup()
    let release!: () => void
    gate.hold = new Promise<void>((r) => { release = r })
    const a = hub.workspace('t', WS)
    const b = hub.workspace('t', WS)
    const c = hub.workspace('t', WS)
    expect(reads).toEqual([`${WS}/plan-path`])
    release()
    await Promise.all([a, b, c])
    expect(reads.filter((r) => r.endsWith('plan-path')).length).toBe(2)
    expect(hub.get('t').plan?.done).toBe(1)
  })

  it('the promise workspace returns resolves once the read it asked for has finished', async () => {
    const { hub, files, gate } = setup()
    await hub.workspace('t', WS)
    let release!: () => void
    gate.hold = new Promise<void>((r) => { release = r })
    files[`${WS}/progress.md`] += 'Task 2: complete\n'
    let done = false
    const p = hub.workspace('t', WS).then(() => { done = true })
    await new Promise((r) => setTimeout(r, 5))
    expect(done).toBe(false)
    release()
    await p
    expect(hub.get('t').plan?.done).toBe(2)
  })

  it('a new session clears the plan; the same session id (compaction) keeps it', async () => {
    const { hub, changes } = setup()
    await hub.workspace('t', WS)
    hub.session('t', 's1')
    expect(hub.get('t').plan).not.toBeNull()
    const before = changes.length
    hub.session('t', 's2')
    expect(hub.get('t').plan).toBeNull()
    expect(changes.length).toBe(before + 1)
  })

  it('a new session while a read runs: the old plan does not come back', async () => {
    const { hub, gate, seen } = setup()
    hub.session('t', 's1')
    let release!: () => void
    gate.hold = new Promise<void>((r) => { release = r })
    const p = hub.workspace('t', WS)
    hub.session('t', 's2')
    release()
    await p
    expect(hub.get('t').plan).toBeNull()
    expect(seen).not.toContain('CSV Export')
  })

  it('removeTab while a read runs: nothing is sent afterwards', async () => {
    const { hub, gate, changes } = setup()
    let release!: () => void
    gate.hold = new Promise<void>((r) => { release = r })
    const p = hub.workspace('t', WS)
    hub.removeTab('t')
    release()
    await p
    expect(changes).toEqual([])
  })

  it('a session that ends hides the plan; the same session starting again shows it', async () => {
    const { hub } = setup()
    hub.session('t', 's1')
    await hub.workspace('t', WS)
    hub.sessionEnd('t', 's1')
    expect(hub.get('t').plan).toBeNull()
    hub.session('t', 's1')
    await hub.refresh()
    expect(hub.get('t').plan).toMatchObject(RES)
  })

  it('a late end of a replaced session changes nothing', async () => {
    const { hub } = setup()
    hub.session('t', 's1')
    hub.session('t', 's2')
    await hub.workspace('t', WS)
    hub.sessionEnd('t', 's1')
    expect(hub.get('t').plan).toMatchObject(RES)
  })

  it('removeTab forgets the tab', async () => {
    const { hub, reads } = setup()
    await hub.workspace('t', WS)
    hub.removeTab('t')
    expect(hub.get('t').plan).toBeNull()
    reads.length = 0
    await hub.refresh()
    expect(reads).toEqual([])
  })

  it('Windows: MSYS workspace and plan-path under an 8.3 folder; another spelling of the same workspace keeps it', async () => {
    const base = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\acme-shop'
    const ws = `${base}\\.superpowers\\sdd\\x`
    const planFile = `${base}\\docs\\p.md`
    const { hub, files } = setup({
      [`${ws}\\plan-path`]: '/c/Users/RUNNER~1/AppData/Local/Temp/acme-shop/docs/p.md\n',
      [planFile]: '# P Implementation Plan\n### Task 1: A\n### Task 2: B\n',
      [`${ws}\\progress.md`]: 'Task 1: complete\n'
    }, win32)
    await hub.workspace('t', '/c/Users/RUNNER~1/AppData/Local/Temp/acme-shop/.superpowers/sdd/x')
    expect(hub.get('t').plan).toMatchObject({ title: 'P', done: 1, total: 2 })
    files[planFile] = 'error'
    await hub.workspace('t', 'C:\\users\\runner~1\\AppData\\Local\\Temp\\acme-shop\\.superpowers\\sdd\\x')
    expect(hub.get('t').plan).toMatchObject({ title: 'P', done: 1, total: 2 })
  })
})
