import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StarredSessions } from '../../src/main/starred-sessions'

const SID1 = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'

const dir = (): string => mkdtempSync(join(tmpdir(), 'ct-starred-'))

describe('StarredSessions', () => {
  it('a missing file means no stars', () => {
    expect([...new StarredSessions(dir()).ids()]).toEqual([])
  })

  it('stars and unstars, persisting in starred-sessions.json for the next run', () => {
    const d = dir()
    const store = new StarredSessions(d)
    store.set(SID1, true)
    store.set(SID2, true)
    store.set(SID1, true)
    store.set(SID2, false)
    expect([...store.ids()]).toEqual([SID1])
    expect(JSON.parse(readFileSync(join(d, 'starred-sessions.json'), 'utf8'))).toEqual([SID1])
    expect([...new StarredSessions(d).ids()]).toEqual([SID1])
    // written through a temp file that is gone again
    expect(readdirSync(d)).toEqual(['starred-sessions.json'])
  })

  it('a corrupt file or a file of the wrong shape means no stars, is reported and is replaced by the next change', () => {
    const d = dir()
    const errors: string[] = []
    writeFileSync(join(d, 'starred-sessions.json'), '{not json')
    const store = new StarredSessions(d, (m) => errors.push(m))
    expect([...store.ids()]).toEqual([])
    expect(errors).toHaveLength(1)
    store.set(SID1, true)
    expect([...new StarredSessions(d).ids()]).toEqual([SID1])

    writeFileSync(join(d, 'starred-sessions.json'), JSON.stringify({ a: 1 }))
    expect([...new StarredSessions(d, (m) => errors.push(m)).ids()]).toEqual([])
    expect(errors).toHaveLength(2)
  })

  it('keeps only ids that are session ids', () => {
    const d = dir()
    writeFileSync(join(d, 'starred-sessions.json'), JSON.stringify([SID1, 'nope', 7, null, SID1, SID2]))
    expect([...new StarredSessions(d).ids()]).toEqual([SID1, SID2])
  })

  it('a folder that cannot be written does not throw; the star lasts for this run', () => {
    const errors: string[] = []
    const store = new StarredSessions(join(dir(), 'missing', 'deeper'), (m) => errors.push(m))
    expect(() => store.set(SID1, true)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(store.ids().has(SID1)).toBe(true)
  })
})
