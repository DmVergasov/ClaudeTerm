import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { RemoteSessionStore } from '../../src/main/remote-control/remote-sessions'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_2 = '6e3d2c8b-9f5a-4b4c-a2d3-e4f5a6b7c8d9'
const SID_3 = '7f4e3d9c-0a6b-4c5d-b3e4-f5a6b7c8d9e0'
const DAY = 24 * 3_600_000
const log = { warn: () => {} }
let t = 0
let file = ''
let store: RemoteSessionStore

describe('remote session store', () => {
  beforeEach(() => {
    t = 1_763_300_000_000
    file = join(mkdtempSync(join(tmpdir(), 'ct-rs-')), 'remote-sessions.json')
    store = new RemoteSessionStore(file, () => t, log)
  })

  it('an entry put is got back for its session and account, also by a new store over the same file', async () => {
    await store.put(SID, 'c:\\cfg', { remoteId: 'cse_1', sequenceNum: 4 })
    expect(await store.get(SID, 'c:\\cfg')).toEqual({ remoteId: 'cse_1', sequenceNum: 4 })
    expect(await new RemoteSessionStore(file, () => t, log).get(SID, 'c:\\cfg')).toEqual({ remoteId: 'cse_1', sequenceNum: 4 })
  })

  it('an entry made under another account is none', async () => {
    await store.put(SID, 'c:\\cfg', { remoteId: 'cse_1', sequenceNum: 4 })
    expect(await store.get(SID, 'c:\\accounts\\work')).toBeNull()
  })

  it('an entry unused for 30 days is gone; a get keeps an entry in use', async () => {
    await store.put(SID, 'a', { remoteId: 'cse_1', sequenceNum: 1 })
    await store.put(SID_2, 'a', { remoteId: 'cse_2', sequenceNum: 1 })
    t += 20 * DAY
    await store.get(SID, 'a')
    t += 11 * DAY
    expect(await store.get(SID_2, 'a')).toBeNull()
    expect(await store.get(SID, 'a')).toEqual({ remoteId: 'cse_1', sequenceNum: 1 })
    await store.put(SID_3, 'a', { remoteId: 'cse_3', sequenceNum: 0 })
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sessions).sort()).toEqual([SID, SID_3].sort())
  })

  it('a file that is not JSON, and entries of the wrong shape, are left out; the store goes on', async () => {
    writeFileSync(file, '{oops')
    expect(await store.get(SID, 'a')).toBeNull()
    writeFileSync(file, JSON.stringify({ version: 1, sessions: { [SID]: { remoteId: 'bad id', sequenceNum: 1, account: 'a', usedAt: t }, [SID_2]: { remoteId: 'cse_2', sequenceNum: -1, account: 'a', usedAt: t } } }))
    const fresh = new RemoteSessionStore(file, () => t, log)
    expect([await fresh.get(SID, 'a'), await fresh.get(SID_2, 'a')]).toEqual([null, null])
  })

  it('puts made at once all land; forget removes one', async () => {
    await Promise.all([1, 2, 3].map((n) => store.put(`${SID.slice(0, -1)}${n}`, 'a', { remoteId: `cse_${n}`, sequenceNum: n })))
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sessions)).toHaveLength(3)
    await store.forget(`${SID.slice(0, -1)}1`)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sessions)).toHaveLength(2)
  })
})
