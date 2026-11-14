import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Vault } from '../../src/main/accounts'
import { SessionNotes } from '../../src/main/session-notes'
import { StarredSessions } from '../../src/main/starred-sessions'
import { DeviceGroup } from '../../src/main/sync/device-group'
import { StoreBridge } from '../../src/main/sync/store-bridge'
import { noteOf, starOf } from '../../src/main/sync/views'
import { DEVICE_COPY } from '../../src/shared/devices'
import type { Note } from '../../src/shared/note'
import { fakeVault, tempDir } from '../fixtures/sync'

const S1 = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const S2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const S3 = '6f1c2a3e-4b5d-4e7f-8a9b-0c1d2e3f4a5b'
const S4 = '7a2d3b4f-5c6e-4f80-9b0c-1d2e3f4a5b6c'
const goal: Note = { text: 'Goal: payments', shown: true, form: 'card' }

let group: DeviceGroup | null = null
const opened: DeviceGroup[] = []
const dirs: string[] = []

afterEach(async () => {
  await group?.close()
  group = null
  await Promise.all(opened.splice(0).map((g) => g.close()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** polls until the condition holds; the test fails when it does not hold in time */
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached in time')
    await sleep(10)
  }
}

/** the group sees the one other device, connected and described */
const connected = (g: DeviceGroup): boolean =>
  g.view().devices.length >= 1 && g.view().devices.every((d) => d.state.kind === 'connected' && d.platform !== null)

/** whether a file holds the text now; a file that is not there yet holds nothing */
function fileHas(path: string, text: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(text)
  } catch {
    return false
  }
}

/** a device group of this test's own, in dir, on loopback with a port the system picks */
function openGroup(dir: string, opts: { vault?: Vault; onError?: (m: string) => void } = {}): Promise<DeviceGroup> {
  return DeviceGroup.open({
    dir,
    vault: opts.vault ?? fakeVault(),
    host: '127.0.0.1',
    port: 0,
    platform: 'linux',
    appVersion: '0.18.0',
    hostName: () => 'Test device',
    addresses: () => ['127.0.0.1'],
    onData: () => {},
    onView: () => {},
    onReset: () => {},
    warn: () => {},
    onError: opts.onError ?? (() => {}),
    saveDebounceMs: 10
  }).then((g) => {
    opened.push(g)
    return g
  })
}

describe('store bridge with a device group', () => {
  it('the group holds the stars and notes that were in the stores; the files are unchanged; stop detaches', async () => {
    const dir = tempDir('bridge')
    dirs.push(dir)
    const starredText = JSON.stringify([S1, S2])
    const notesText = JSON.stringify({ [S3]: goal })
    writeFileSync(join(dir, 'starred-sessions.json'), starredText, 'utf8')
    writeFileSync(join(dir, 'session-notes.json'), notesText, 'utf8')

    const starred = new StarredSessions(dir)
    const notes = new SessionNotes(dir, { debounceMs: 10 })
    group = await DeviceGroup.open({
      dir,
      vault: fakeVault(),
      host: '127.0.0.1',
      port: 0,
      platform: 'linux',
      appVersion: '0.18.0',
      hostName: () => 'Test device',
      addresses: () => ['127.0.0.1'],
      onData: () => {},
      onView: () => {},
      onReset: () => {},
      warn: () => {},
      onError: () => {}
    })
    const bridge = new StoreBridge(starred, notes, group, { debounceMs: 10 })
    bridge.start()

    expect(starOf(group.state('stars', S1))).toBe(true)
    expect(starOf(group.state('stars', S2))).toBe(true)
    expect(noteOf(group.state('notes', S3))).toEqual(goal)

    // both files still hold the same data
    expect(readFileSync(join(dir, 'starred-sessions.json'), 'utf8')).toBe(starredText)
    expect(JSON.parse(readFileSync(join(dir, 'session-notes.json'), 'utf8'))).toEqual({ [S3]: goal })

    bridge.stop()
    starred.set(S4, true)
    expect(group.state('stars', S4)).toBeUndefined()

    expect([...new StarredSessions(dir).ids()].sort()).toEqual([S1, S2, S4].sort())
    expect(new SessionNotes(dir).get(S3)).toEqual(goal)
  })
  it('a store file that is lost or corrupt is restored from the group, and the group keeps its stars and notes', async () => {
    const dir = tempDir('bridge-corrupt')
    dirs.push(dir)
    const starred = new StarredSessions(dir)
    const notes = new SessionNotes(dir, { debounceMs: 10 })
    group = await openGroup(dir)
    const bridge = new StoreBridge(starred, notes, group, { debounceMs: 10 })
    bridge.start()
    starred.set(S1, true)
    notes.set(S3, goal)
    bridge.stop()
    notes.flush()
    expect(starOf(group.state('stars', S1))).toBe(true)
    expect(noteOf(group.state('notes', S3))).toEqual(goal)

    writeFileSync(join(dir, 'starred-sessions.json'), 'not json', 'utf8')
    writeFileSync(join(dir, 'session-notes.json'), 'not json', 'utf8')
    const starredAgain = new StarredSessions(dir)
    const notesAgain = new SessionNotes(dir, { debounceMs: 10 })
    const again = new StoreBridge(starredAgain, notesAgain, group, { debounceMs: 10 })
    again.start()

    expect(starOf(group.state('stars', S1))).toBe(true)
    expect(noteOf(group.state('notes', S3))).toEqual(goal)
    expect(starredAgain.ids().has(S1)).toBe(true)
    expect(notesAgain.get(S3)).toEqual(goal)
    again.stop()
  })

  it('a group stopped after a failed reset keeps the stars set meanwhile across a restart', async () => {
    const dirB = tempDir('bridge-stopped')
    dirs.push(dirB)
    const dirHost = tempDir('bridge-host')
    dirs.push(dirHost)
    let broken = false
    const base = fakeVault()
    const vault: Vault = {
      available: () => true,
      decrypt: base.decrypt,
      encrypt: (text) => {
        if (broken) throw new Error('keyring busy')
        return base.encrypt(text)
      }
    }
    const errors: string[] = []
    const host = await openGroup(dirHost)
    const b = await openGroup(dirB, { vault, onError: (m) => errors.push(m) })
    const v = await host.startPairing()
    expect(await b.join(`127.0.0.1:${v.self.port}`, v.pairing!.code)).toEqual({ ok: true })
    await until(() => connected(host) && connected(b))

    const starred = new StarredSessions(dirB)
    const notes = new SessionNotes(dirB, { debounceMs: 10 })
    const bridge = new StoreBridge(starred, notes, b, { debounceMs: 10 })
    bridge.start()
    // S3 is starred, then unstarred, while sync runs: the group holds it unstarred
    starred.set(S3, true)
    starred.set(S3, false)
    await until(() => fileHas(join(dirB, 'sync-replica.json'), S3))

    // the group stops after a reset that cannot encrypt its new key
    broken = true
    expect(host.remove(b.view().self.id)).toEqual({ ok: true })
    await until(() => errors.length > 0 && b.view().problem === DEVICE_COPY.syncStopped)

    // S3 is starred while the group is stopped: the store keeps the star, the group ignores the write
    starred.set(S3, true)
    await b.close()

    // a restart: new stores from the same files, a new group and a new bridge
    const starredAgain = new StarredSessions(dirB)
    const notesAgain = new SessionNotes(dirB, { debounceMs: 10 })
    const again = await openGroup(dirB)
    const bridgeAgain = new StoreBridge(starredAgain, notesAgain, again, { debounceMs: 10 })
    bridgeAgain.start()
    expect(starredAgain.ids().has(S3)).toBe(true)
    expect(starOf(again.state('stars', S3))).toBe(true)
    bridgeAgain.stop()
    bridge.stop()
  })

  it('a store file lost in a run without sync is restored at the next start, though a later run without sync wrote it again', async () => {
    const dir = tempDir('bridge-lostoff')
    dirs.push(dir)
    const N1 = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'
    const N2 = 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f'
    const N3 = 'd3e4f5a6-b7c8-4d9e-8f0a-2b3c4d5e6f70'
    const N4 = 'e4f5a6b7-c8d9-4e0f-9a1b-3c4d5e6f7081'
    const S9 = 'f5a6b7c8-d9e0-4f1a-8b2c-4d5e6f708192'
    const card = (text: string): Note => ({ text, shown: true, form: 'card' })

    // run 1: sync works; two stars and three notes, in the stores and in the group
    const g1 = await openGroup(dir)
    {
      const starred = new StarredSessions(dir)
      const notes = new SessionNotes(dir, { debounceMs: 10 })
      const bridge = new StoreBridge(starred, notes, g1, { debounceMs: 10 })
      bridge.start()
      starred.set(S1, true)
      starred.set(S2, true)
      notes.set(N1, card('plan'))
      notes.set(N2, card('payments'))
      notes.set(N3, card('release'))
      bridge.stop()
      notes.flush()
    }
    await g1.close()

    // run 2: the notes and stars files are lost; sync does not run, and the user writes the files again
    rmSync(join(dir, 'starred-sessions.json'))
    rmSync(join(dir, 'session-notes.json'))
    {
      const starred = new StarredSessions(dir)
      const notes = new SessionNotes(dir, { debounceMs: 10 })
      notes.set(N4, card('new'))
      notes.set(N1, card('rewritten'))
      starred.set(S9, true)
      notes.flush()
    }

    // run 3: sync runs again, and the group still holds the three notes and two stars
    const starred = new StarredSessions(dir)
    const notes = new SessionNotes(dir, { debounceMs: 10 })
    const g3 = await openGroup(dir)
    const bridge = new StoreBridge(starred, notes, g3, { debounceMs: 10 })
    bridge.start()
    const groupText = (id: string) => noteOf(g3.state('notes', id))?.text ?? null
    expect(groupText(N1)).toBe('rewritten')
    expect(notes.get(N1)?.text).toBe('rewritten')
    expect(groupText(N2)).toBe('payments')
    expect(notes.get(N2)?.text).toBe('payments')
    expect(groupText(N3)).toBe('release')
    expect(notes.get(N3)?.text).toBe('release')
    expect(groupText(N4)).toBe('new')
    expect(notes.get(N4)?.text).toBe('new')
    for (const id of [S1, S2, S9]) {
      expect(starOf(g3.state('stars', id))).toBe(true)
      expect(starred.ids().has(id)).toBe(true)
    }
    expect(existsSync(join(dir, 'starred-sessions.restore.json'))).toBe(false)
    expect(existsSync(join(dir, 'session-notes.restore.json'))).toBe(false)
    bridge.stop()
  })
})
