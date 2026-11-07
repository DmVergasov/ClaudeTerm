import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceGroup } from '../../src/main/sync/device-group'
import { SEQ_RESERVE } from '../../src/main/sync/replica'
import { fakeVault, tempDir } from '../fixtures/sync'

const dirs: string[] = []
const opened: DeviceGroup[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((g) => g.close()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** a device group in dir, on loopback; its save pause is longer than any test, so only flush() and close() save */
function openGroup(dir: string, errors: string[]): Promise<DeviceGroup> {
  return DeviceGroup.open({
    dir,
    vault: fakeVault(),
    host: '127.0.0.1',
    port: 0,
    platform: 'linux',
    hostName: () => 'Test device',
    addresses: () => ['127.0.0.1'],
    onData: () => {},
    onView: () => {},
    onReset: () => {},
    warn: () => {},
    onError: (m) => errors.push(m),
    saveDebounceMs: 60_000
  }).then((g) => {
    opened.push(g)
    return g
  })
}

describe('the replica file after a refused save', () => {
  it('a save that failed keeps its data pending: the close saves the stars written while the disk refused', async () => {
    const dir = tempDir('replica-retry')
    dirs.push(dir)
    const errors: string[] = []
    const g = await openGroup(dir, errors)
    // a folder where the temp file goes: the save is refused
    const obstacle = join(dir, 'sync-replica.json.tmp')
    mkdirSync(obstacle)
    const keys = Array.from({ length: SEQ_RESERVE + 6 }, () => randomUUID())
    for (const k of keys) g.write('stars', k, true)
    g.flush()
    expect(errors.length).toBeGreaterThan(0)
    const self = g.view().self.id
    const highest = Math.max(...keys.map((k) => Math.max(...g.state('stars', k)!.siblings.filter((s) => s.dot[0] === self).map((s) => s.dot[1]))))
    // the disk is fine again; the group is closed without another write
    rmSync(obstacle, { recursive: true, force: true })
    await g.close()
    const saved = JSON.parse(readFileSync(join(dir, 'sync-replica.json'), 'utf8')) as {
      reserved: number
      records: { stars: Record<string, unknown> }
    }
    expect(Object.keys(saved.records.stars).sort()).toEqual([...keys].sort())
    expect(saved.reserved).toBeGreaterThanOrEqual(highest)
  })
})
