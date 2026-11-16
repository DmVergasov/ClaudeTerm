import { describe, expect, it } from 'vitest'
import { EMPTY_GAMES, parseGamesSave, type GamesSave, type MergeSave, type ClickerSave } from '../../src/shared/games'

const merge: MergeSave = { board: [0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11], score: 120, best: 340, won: false }
const clicker: ClickerSave = { lines: 12.5, helpers: [1, 0, 2, 0], at: 1_700_000_000_000 }
const valid: GamesSave = { game: 'merge', runnerBest: 42, merge, clicker }

describe('games save', () => {
  it('a full valid save comes back equal, with nothing bad', () => {
    const result = parseGamesSave(valid)
    expect(result.save).toEqual(valid)
    expect(result.bad).toEqual([])
  })

  it('null parts are valid', () => {
    const save: GamesSave = { game: 'merge', runnerBest: 3, merge: null, clicker: null }
    const result = parseGamesSave(save)
    expect(result.save).toEqual(save)
    expect(result.bad).toEqual([])
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
