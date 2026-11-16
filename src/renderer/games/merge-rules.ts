import type { MergeSave } from '../../shared/games'

export type Dir = 'left' | 'right' | 'up' | 'down'

export const SIZE = 4

/** the exponent of a 1 MB tile */
export const GOAL = 11

/** the size of a tile with exponent e, in KB */
export function tileKB(e: number): number {
  return 2 ** (e - 1)
}

/** the size of a tile with exponent e, for display: 1 KB, 512 KB, 1 MB, 1 GB */
export function tileLabel(e: number): string {
  const kb = tileKB(e)
  if (kb < 1024) return `${kb} KB`
  if (kb < 1024 * 1024) return `${kb / 1024} MB`
  return `${kb / (1024 * 1024)} GB`
}

/** an empty board with two tiles spawned; the best score carries over */
export function newMerge(rand: () => number, best = 0): MergeSave {
  const board = spawn(spawn(new Array(SIZE * SIZE).fill(0), rand), rand)
  return { board, score: 0, best, won: false }
}

/** a new board with one tile in a random empty cell: 2 with a 10% chance, else 1; the input is not changed */
export function spawn(board: number[], rand: () => number): number[] {
  const empties: number[] = []
  board.forEach((c, i) => {
    if (c === 0) empties.push(i)
  })
  if (empties.length === 0) return board.slice()
  const cell = empties[Math.floor(rand() * empties.length)]
  const value = rand() < 0.1 ? 2 : 1
  const next = board.slice()
  next[cell] = value
  return next
}

/** the cell indexes of line n, ordered from the wall that tiles slide toward */
function line(n: number, dir: Dir): number[] {
  const cells: number[] = []
  for (let i = 0; i < SIZE; i++) {
    if (dir === 'left') cells.push(n * SIZE + i)
    else if (dir === 'right') cells.push(n * SIZE + (SIZE - 1 - i))
    else if (dir === 'up') cells.push(i * SIZE + n)
    else cells.push((SIZE - 1 - i) * SIZE + n)
  }
  return cells
}

/**
 * Slides every tile toward dir and merges equal neighbours; the pair nearest the wall merges first and a tile merges
 * at most once per move. gained is the value of the new tiles in KB. Nothing is spawned; the input is not changed.
 */
export function slide(board: number[], dir: Dir): { board: number[]; gained: number; moved: boolean } {
  const next = board.slice()
  let gained = 0
  for (let n = 0; n < SIZE; n++) {
    const cells = line(n, dir)
    const tiles = cells.map((i) => board[i]).filter((c) => c !== 0)
    const merged: number[] = []
    for (let k = 0; k < tiles.length; k++) {
      if (k + 1 < tiles.length && tiles[k] === tiles[k + 1]) {
        merged.push(tiles[k] + 1)
        gained += tileKB(tiles[k] + 1)
        k++
      } else {
        merged.push(tiles[k])
      }
    }
    cells.forEach((cell, k) => (next[cell] = merged[k] ?? 0))
  }
  return { board: next, gained, moved: next.some((c, i) => c !== board[i]) }
}

/** one move: slides, and spawns a tile only when the board moved; reachedGoal is set on the move that first makes a tile GOAL */
export function move(s: MergeSave, dir: Dir, rand: () => number): { save: MergeSave; moved: boolean; reachedGoal: boolean } {
  const slid = slide(s.board, dir)
  if (!slid.moved) return { save: s, moved: false, reachedGoal: false }
  const reachedGoal = !s.won && slid.board.some((c) => c >= GOAL)
  const score = s.score + slid.gained
  const save: MergeSave = {
    board: spawn(slid.board, rand),
    score,
    best: Math.max(s.best, score),
    won: s.won || reachedGoal
  }
  return { save, moved: true, reachedGoal }
}

/** true when some move would change the board: an empty cell, or two equal neighbours */
export function canMove(board: number[]): boolean {
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0) return true
    const col = i % SIZE
    if (col + 1 < SIZE && board[i] === board[i + 1]) return true
    if (i + SIZE < board.length && board[i] === board[i + SIZE]) return true
  }
  return false
}
