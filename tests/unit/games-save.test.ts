import { describe, expect, it } from 'vitest'
import { EMPTY_GAMES, parseGamesSave, type GamesSave, type MergeSave, type ClickerSave } from '../../src/shared/games'

const merge: MergeSave = { board: [0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11], score: 120, best: 340, won: false }
const clicker: ClickerSave = { lines: 12.5, helpers: [1, 0, 2, 0], at: 1_700_000_000_000 }
const valid: GamesSave = { game: 'merge', runnerBest: 42, landerBest: 120, pinballBest: 4800, sandBest: 2140, artilleryWins: 3, artilleryStreak: 1, artilleryBest: 2, merge, clicker }

describe('games save', () => {
  it('a full valid save comes back equal, with nothing bad', () => {
    const result = parseGamesSave(valid)
    expect(result.save).toEqual(valid)
    expect(result.bad).toEqual([])
  })

  it('null parts are valid', () => {
    const save: GamesSave = { game: 'merge', runnerBest: 3, landerBest: 0, pinballBest: 0, sandBest: 0, artilleryWins: 0, artilleryStreak: 0, artilleryBest: 0, merge: null, clicker: null }
    const result = parseGamesSave(save)
    expect(result.save).toEqual(save)
    expect(result.bad).toEqual([])
  })

  it('a save from before Lander, Pinball and Sand loads whole: their bests are 0 and nothing is bad', () => {
    const old = { game: 'merge', runnerBest: 42, merge, clicker }
    const result = parseGamesSave(old)
    expect(result.save).toEqual({ ...old, landerBest: 0, pinballBest: 0, sandBest: 0, artilleryWins: 0, artilleryStreak: 0, artilleryBest: 0 })
    expect(result.bad).toEqual([])
  })

  it('a save from before Artillery loads whole: its counters are 0 and nothing is bad', () => {
    const { artilleryWins, artilleryStreak, artilleryBest, ...old } = valid
    const result = parseGamesSave(old)
    expect(result.save).toEqual({ ...old, artilleryWins: 0, artilleryStreak: 0, artilleryBest: 0 })
    expect(result.bad).toEqual([])
  })

  it('Artillery can be the last game chosen', () => {
    expect(parseGamesSave({ ...valid, game: 'artillery' })).toEqual({ save: { ...valid, game: 'artillery' }, bad: [] })
  })

  it('an Artillery counter out of range or not an integer is bad and 0', () => {
    const result = parseGamesSave({ ...valid, artilleryWins: -1, artilleryStreak: 1.5, artilleryBest: 1e13 })
    expect(result.save).toMatchObject({ artilleryWins: 0, artilleryStreak: 0, artilleryBest: 0 })
    expect(result.bad).toEqual(expect.arrayContaining(['artilleryWins', 'artilleryStreak', 'artilleryBest']))
  })

  it('Lander, Pinball and Sand can be the last game chosen', () => {
    for (const game of ['lander', 'pinball', 'sand'] as const) {
      const result = parseGamesSave({ ...valid, game })
      expect(result.save.game).toBe(game)
      expect(result.bad).toEqual([])
    }
  })

  it('a new best that is out of range or not an integer is bad and 0; the rest is kept', () => {
    for (const [key, value] of [['landerBest', -1], ['pinballBest', 1.5], ['sandBest', 1e13], ['sandBest', '5']] as const) {
      const result = parseGamesSave({ ...valid, [key]: value })
      expect(result.save[key]).toBe(0)
      expect(result.bad).toEqual([key])
      expect(result.save.merge).toEqual(merge)
      expect(result.save.runnerBest).toBe(42)
    }
  })

  it('one bad part is dropped, the others are kept', () => {
    const result = parseGamesSave({ ...valid, merge: { ...merge, board: merge.board.slice(0, 15) } })
    expect(result.save.merge).toBeNull()
    expect(result.bad).toEqual(['merge'])
    expect(result.save.runnerBest).toBe(42)
    expect(result.save.clicker).toEqual(clicker)
  })

  it('an unknown game falls back to runner', () => {
    const result = parseGamesSave({ ...valid, game: 'chess' })
    expect(result.save.game).toBe('runner')
    expect(result.bad).toContain('game')
  })

  it('out-of-range numbers are bad', () => {
    const cell = parseGamesSave({ ...valid, merge: { ...merge, board: [31, ...merge.board.slice(1)] } })
    expect(cell.save.merge).toBeNull()
    expect(cell.bad).toEqual(['merge'])

    const helpers = parseGamesSave({ ...valid, clicker: { ...clicker, helpers: [1, -1, 0, 0] } })
    expect(helpers.save.clicker).toBeNull()
    expect(helpers.bad).toEqual(['clicker'])

    const lines = parseGamesSave({ ...valid, clicker: { ...clicker, lines: Infinity } })
    expect(lines.save.clicker).toBeNull()
    expect(lines.bad).toEqual(['clicker'])

    const best = parseGamesSave({ ...valid, runnerBest: 1.5 })
    expect(best.save.runnerBest).toBe(0)
    expect(best.bad).toEqual(['runnerBest'])
  })

  it('garbage is an empty save', () => {
    for (const raw of [null, 'x', []]) {
      const result = parseGamesSave(raw)
      expect(result.save).toEqual(EMPTY_GAMES)
      expect(result.bad).toEqual(['all'])
    }
  })

  it('extra fields are not kept', () => {
    const result = parseGamesSave({ ...valid, extra: 1, merge: { ...merge, x: 2 } })
    expect(result.save).not.toHaveProperty('extra')
    expect(result.save.merge).not.toHaveProperty('x')
    expect(result.save.merge).toEqual(merge)
  })
})
