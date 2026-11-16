import { describe, expect, it } from 'vitest'
import { canMove, GOAL, move, newMerge, slide, spawn, tileLabel } from '../../src/renderer/games/merge-rules'
import type { MergeSave } from '../../src/shared/games'

/** a rand that returns the given numbers in order, then 0.5 */
function r(...values: number[]): () => number {
  let i = 0
  return () => (i < values.length ? values[i++] : 0.5)
}

const empty = (): number[] => new Array(16).fill(0)

/** a 4x4 board from its rows */
function rows(...lines: number[][]): number[] {
  return lines.flat()
}

describe('merge rules', () => {
  it('slides and merges a row to the left', () => {
    const cases: [number[], number[], number][] = [
      [[1, 1, 1, 1], [2, 2, 0, 0], 4],
      [[1, 1, 2, 0], [2, 2, 0, 0], 2],
      [[2, 1, 1, 0], [2, 2, 0, 0], 2],
      [[1, 0, 0, 1], [2, 0, 0, 0], 2]
    ]
    for (const [row, expected, gained] of cases) {
      const result = slide(rows(row, empty().slice(4)), 'left')
      expect(result.board.slice(0, 4)).toEqual(expected)
      expect(result.gained).toBe(gained)
      expect(result.moved).toBe(true)
    }
  })

  it('right, up and down mirror left', () => {
    const right = slide(rows([1, 1, 1, 0], empty().slice(4)), 'right')
    expect(right.board.slice(0, 4)).toEqual([0, 0, 1, 2])

    const column = (values: number[]): number[] => {
      const board = empty()
      values.forEach((v, i) => (board[i * 4 + 1] = v))
      return board
    }
    const column0 = (board: number[]): number[] => [0, 1, 2, 3].map((i) => board[i * 4 + 1])

    expect(column0(slide(column([1, 1, 0, 0]), 'up').board)).toEqual([2, 0, 0, 0])
    expect(column0(slide(column([1, 1, 0, 0]), 'down').board)).toEqual([0, 0, 0, 2])
  })

  it('a move that changes nothing does not spawn', () => {
    const s: MergeSave = { board: rows([1, 0, 0, 0], empty().slice(4)), score: 0, best: 0, won: false }
    const result = move(s, 'left', r(0, 0.5))
    expect(result.moved).toBe(false)
    expect(result.save.board).toEqual(s.board)
    expect(result.reachedGoal).toBe(false)
  })

  it('a move spawns one tile in an empty cell', () => {
    // the board has one tile at cell 0; moving left changes nothing, so use a board that moves
    const s: MergeSave = { board: rows([0, 1, 0, 0], empty().slice(4)), score: 0, best: 0, won: false }

    const one = move(s, 'left', r(0, 0.5))
    expect(one.moved).toBe(true)
    // the slide leaves the tile at cell 0; the empty cells are 1..15, so the first of them gets the 1
    expect(one.save.board[0]).toBe(1)
    expect(one.save.board[1]).toBe(1)
    expect(one.save.board.filter((c) => c !== 0)).toHaveLength(2)

    const two = move(s, 'left', r(0, 0.05))
    expect(two.save.board[1]).toBe(2)
  })

  it('score and best grow with the merges', () => {
    const s: MergeSave = { board: rows([1, 1, 0, 0], empty().slice(4)), score: 5, best: 3, won: false }
    const result = move(s, 'left', r(0, 0.5))
    expect(result.save.score).toBe(7)
    expect(result.save.best).toBe(7)

    const keepsBest: MergeSave = { ...s, best: 100 }
    expect(move(keepsBest, 'left', r(0, 0.5)).save.best).toBe(100)
  })

  it('newMerge starts with an empty board, two spawns, and keeps the best', () => {
    const s = newMerge(r(0, 0.5, 0, 0.5), 42)
    expect(s.board.filter((c) => c !== 0)).toHaveLength(2)
    expect(s.score).toBe(0)
    expect(s.best).toBe(42)
    expect(s.won).toBe(false)
    expect(newMerge(r(0, 0.5, 0, 0.5)).best).toBe(0)
  })

  it('the first 1 MB tile reaches the goal once', () => {
    expect(GOAL).toBe(11)
    const s: MergeSave = { board: rows([10, 10, 0, 0], empty().slice(4)), score: 0, best: 0, won: false }
    const first = move(s, 'left', r(0, 0.5, 0, 0.5))
    expect(first.reachedGoal).toBe(true)
    expect(first.save.won).toBe(true)
    expect(first.save.board[0]).toBe(11)

    const later: MergeSave = { board: rows([10, 10, 0, 0], empty().slice(4)), score: 0, best: 0, won: true }
    const second = move(later, 'left', r(0, 0.5))
    expect(second.moved).toBe(true)
    expect(second.reachedGoal).toBe(false)
    expect(second.save.won).toBe(true)
  })

  it('no move is left on a full board without equal neighbours', () => {
    // 1 2 1 2 / 2 1 2 1 / 1 2 1 2 / 2 1 2 1 - checkerboard, no equal neighbours
    const checker = rows([1, 2, 1, 2], [2, 1, 2, 1], [1, 2, 1, 2], [2, 1, 2, 1])
    expect(canMove(checker)).toBe(false)

    const pair = checker.slice()
    pair[1] = 1 // now cells 0 and 1 are both 1
    expect(canMove(pair)).toBe(true)

    const gap = checker.slice()
    gap[5] = 0
    expect(canMove(gap)).toBe(true)
  })

  it('labels', () => {
    expect(tileLabel(1)).toBe('1 KB')
    expect(tileLabel(10)).toBe('512 KB')
    expect(tileLabel(11)).toBe('1 MB')
    expect(tileLabel(12)).toBe('2 MB')
    expect(tileLabel(21)).toBe('1 GB')
  })

  it('spawn leaves the input array unchanged', () => {
    const board = empty()
    const spawned = spawn(board, r(0, 0.5))
    expect(board).toEqual(empty())
    expect(spawned).not.toBe(board)
  })

  it('slide leaves the input array unchanged', () => {
    const board = rows([1, 1, 0, 0], empty().slice(4))
    const copy = board.slice()
    slide(board, 'left')
    expect(board).toEqual(copy)
  })
})
