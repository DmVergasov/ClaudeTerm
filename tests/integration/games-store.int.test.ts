import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GamesStore } from '../../src/main/games-store'
import { EMPTY_GAMES, type GamesSave } from '../../src/shared/games'

const dir = (): string => mkdtempSync(join(tmpdir(), 'ct-games-'))

const save: GamesSave = {
  game: 'merge',
  runnerBest: 42,
  merge: { board: [0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11], score: 120, best: 340, won: false },
  clicker: { lines: 12.5, helpers: [1, 0, 2, 0], at: 1_700_000_000_000 },
}

describe('GamesStore', () => {
  it('a missing file is an empty save and no error', () => {
    const errors: string[] = []
    expect(new GamesStore(dir(), (m) => errors.push(m)).get()).toEqual(EMPTY_GAMES)
    expect(errors).toEqual([])
  })

  it('a save comes back in the next run, written through a temp file that is gone again', () => {
    const d = dir()
    new GamesStore(d).set(save)
    expect(new GamesStore(d).get()).toEqual(save)
    expect(readdirSync(d)).toEqual(['games.json'])
  })

  it('a corrupt file is an empty save, reported once, and replaced by the next save', () => {
    const d = dir()
    const errors: string[] = []
    writeFileSync(join(d, 'games.json'), '{not json')
    const store = new GamesStore(d, (m) => errors.push(m))
    expect(store.get()).toEqual(EMPTY_GAMES)
    expect(errors).toHaveLength(1)
    store.set(save)
    expect(new GamesStore(d).get()).toEqual(save)
    expect(errors).toHaveLength(1)
  })

  it('a bad part is dropped and reported; the other parts load', () => {
    const d = dir()
    const errors: string[] = []
    writeFileSync(join(d, 'games.json'), JSON.stringify({ ...save, clicker: { lines: -1 } }))
    const store = new GamesStore(d, (m) => errors.push(m))
    expect(store.get()).toEqual({ ...save, clicker: null })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('clicker')
  })

  it('a folder that cannot be written does not throw; the save lasts for this run', () => {
    const errors: string[] = []
    const store = new GamesStore(join(dir(), 'missing', 'deeper'), (m) => errors.push(m))
    expect(() => store.set(save)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(store.get()).toEqual(save)
  })
})
