import { describe, expect, it } from 'vitest'
import { colorOf, fallSpeed, findClears, fits, grain, newGame, pieceCells, PIECES, SAND, spawn, start, step } from '../../src/renderer/games/sand-rules'
import type { Piece, SandInput, SandState } from '../../src/renderer/games/sand-rules'

const W = SAND.width
const H = SAND.height
const K = SAND.k
const idle: SandInput = { left: false, right: false, down: false, turn: false, drop: false, tapLeft: false, tapRight: false }
const DASH = PIECES.findIndex((p) => p.name === 'dash')

const at = (x: number, y: number): number => y * W + x

/** a game in play with no piece, so only the sand moves, on a grid the test fills */
function sandOnly(fill: (grid: Uint8Array) => void): SandState {
  const s = start(newGame(1))
  const grid = new Uint8Array(W * H)
  fill(grid)
  return { ...s, grid, piece: null }
}

/** a game in play with this piece on an empty grid, or the grid the test fills */
function withPiece(piece: Piece, fill: (grid: Uint8Array) => void = () => {}): SandState {
  return { ...sandOnly(fill), piece }
}

/** steps a state in 1/60 s frames for `seconds` */
function run(s: SandState, input: SandInput, seconds: number): SandState {
  for (let i = 0; i < Math.round(seconds * 60); i++) s = step(s, input, 1 / 60)
  return s
}

const grains = (s: SandState): number => s.grid.reduce((n, v) => n + (v === 0 ? 0 : 1), 0)

describe('sand rules', () => {
  it('the piece set is our own: pieces of 3 and 5 cells, none of 4, small next to a board that is not 10 × 20', () => {
    for (const p of PIECES) expect([3, 5]).toContain(p.cells.length)
    expect([SAND.cols, SAND.rows]).not.toEqual([10, 20])
    expect([W, H]).toEqual([SAND.cols * K, SAND.rows * K])
    // the widest piece spans at most a quarter of the board
    expect(Math.max(...PIECES.map((p) => p.size)) / SAND.cols).toBeLessThanOrEqual(0.25)
    expect(W * H).toBeLessThanOrEqual(4000)
  })

  it('a game waits until it is started; one that is over starts again on an empty board', () => {
    const ready = newGame(3)
    expect(ready.phase).toBe('ready')
    expect(ready.piece).toBeNull()
    expect(step(ready, { ...idle, drop: true }, 0.1)).toBe(ready)
    const playing = start(ready)
    expect(playing.phase).toBe('playing')
    expect(playing.piece).toEqual(spawn(ready.next.shape, ready.next.color))

    const over: SandState = { ...sandOnly((g) => g.fill(grain(0, 0), 0, 400)), phase: 'over', score: 77 }
    const again = start(over)
    expect(again.phase).toBe('playing')
    expect(again.score).toBe(0)
    expect(grains(again)).toBe(0)
  })

  it('a grain falls, and rests on the floor', () => {
    let s = sandOnly((g) => (g[at(10, 0)] = grain(1, 0)))
    s = run(s, idle, 2)
    expect(s.grid[at(10, H - 1)]).toBe(grain(1, 0))
    expect(grains(s)).toBe(1)
    const rested = run(s, idle, 0.5)
    expect(rested.grid).toEqual(s.grid)
  })

  it('a grain on a grain slides down diagonally to the floor beside it', () => {
    let s = sandOnly((g) => {
      g[at(20, H - 1)] = grain(0, 0)
      g[at(20, H - 2)] = grain(1, 0)
    })
    s = step(s, idle, 1 / 60)
    expect(s.grid[at(20, H - 2)]).toBe(0)
    expect(s.grid[at(19, H - 1)] + s.grid[at(21, H - 1)]).toBe(grain(1, 0))
    expect(s.grid[at(20, H - 1)]).toBe(grain(0, 0))
  })

  it('a grain with both lower sides taken rests', () => {
    let s = sandOnly((g) => {
      for (const x of [19, 20, 21]) g[at(x, H - 1)] = grain(0, 0)
      g[at(20, H - 2)] = grain(1, 0)
    })
    s = run(s, idle, 0.2)
    expect(s.grid[at(20, H - 2)]).toBe(grain(1, 0))
  })

  it('a landed piece breaks into its grains, all of its colour, and the next piece comes', () => {
    // a dash lying in its box's middle row, just above the floor
    const piece: Piece = { shape: DASH, turn: 0, color: 2, x: 10, y: H - 2 * K }
    const before = withPiece(piece)
    const s = run(before, idle, 0.2)
    // its grains start to pour at once, so they are counted, not looked up where the cells were
    expect(grains(s)).toBe(3 * K * K)
    s.grid.forEach((v, i) => {
      if (v === 0) return
      expect(colorOf(v)).toBe(2)
      expect(Math.floor(i / W)).toBeGreaterThanOrEqual(H - K)
    })
    const fresh = spawn(before.next.shape, before.next.color)
    expect(s.piece).toMatchObject({ shape: fresh.shape, color: fresh.color, turn: 0, x: fresh.x })
  })

  it('a drop lands the piece at once', () => {
    const piece: Piece = { shape: DASH, turn: 0, color: 1, x: 10, y: 0 }
    const s = step(withPiece(piece), { ...idle, drop: true }, 1 / 60)
    expect(grains(s)).toBe(3 * K * K)
    expect(colorOf(s.grid[at(10, H - 1)])).toBe(1)
  })

  it('a one-colour band from wall to wall clears, and scores its grains', () => {
    let s = sandOnly((g) => {
      for (let x = 0; x < W; x++) g[at(x, H - 1)] = grain(3, x % SAND.shades)
    })
    s = step(s, idle, 1 / 60)
    expect(grains(s)).toBe(0)
    expect(s.score).toBe(W)
    expect(s.flash.cells).toHaveLength(W)
  })

  it('a band broken by another colour does not clear', () => {
    let s = sandOnly((g) => {
      for (let x = 0; x < W; x++) g[at(x, H - 1)] = grain(x === 20 ? 1 : 3, 0)
    })
    s = run(s, idle, 0.2)
    expect(grains(s)).toBe(W)
    expect(s.score).toBe(0)
  })

  it('regions are 8-connected: a band joined only at its corners clears, the other colours stay', () => {
    // colour 0 zigzags between the two bottom rows; colours 1 and 2 fill the other cells and touch only at corners
    const zigzag = (g: Uint8Array): void => {
      for (let x = 0; x < W; x++) {
        g[at(x, H - 1)] = grain(x % 2 === 0 ? 0 : 1, 0)
        g[at(x, H - 2)] = grain(x % 2 === 0 ? 2 : 0, 0)
      }
    }
    const grid = new Uint8Array(W * H)
    zigzag(grid)
    expect(findClears(grid).sort((a, b) => a - b)).toEqual(
      [...Array(W).keys()].map((x) => (x % 2 === 0 ? at(x, H - 1) : at(x, H - 2))).sort((a, b) => a - b)
    )
    const s = step(sandOnly(zigzag), idle, 1 / 60)
    expect(s.score).toBe(W)
    expect([...s.grid].filter((v) => v !== 0 && colorOf(v) === 0)).toHaveLength(0)
    expect(grains(s)).toBe(W)
  })

  it('a region that touches one wall only does not clear', () => {
    const grid = new Uint8Array(W * H)
    for (let x = 0; x < W - 1; x++) grid[at(x, H - 1)] = grain(0, 0)
    expect(findClears(grid)).toEqual([])
  })

  it('a second clear before the sand rests is a chain and scores double', () => {
    // the bottom row clears first; the row above it falls, and a grain falling down the right wall completes it
    let s = sandOnly((g) => {
      for (let x = 0; x < W; x++) g[at(x, H - 1)] = grain(0, 0)
      for (let x = 0; x < W - 1; x++) g[at(x, H - 2)] = grain(1, 0)
      g[at(W - 1, H - 10)] = grain(1, 0)
    })
    s = run(s, idle, 0.5)
    expect(s.score).toBe(W * 1 + W * 2)
    expect(grains(s)).toBe(0)
    expect(run(s, idle, 0.1).chain).toBe(0)
  })

  it('a turn happens when it fits, and not when a wall or sand is in the way', () => {
    const upright: Piece = { shape: DASH, turn: 1, color: 0, x: 10, y: 10 }
    expect(pieceCells(upright).every(([, c]) => c === 1)).toBe(true)
    const free = step(withPiece(upright), { ...idle, turn: true }, 1 / 60)
    expect(free.piece!.turn).toBe(2)

    // upright against the left wall: lying down it would stick out of the wall
    const atWall: Piece = { ...upright, x: -K }
    expect(fits(new Uint8Array(W * H), atWall)).toBe(true)
    const walled = step(withPiece(atWall), { ...idle, turn: true }, 1 / 60)
    expect(walled.piece!.turn).toBe(1)
    expect(walled.piece!.x).toBe(-K)

    // a grain where the lying dash's left end would be
    const blocked = step(withPiece(upright, (g) => (g[at(11, 10 + K + 2)] = grain(1, 0))), { ...idle, turn: true }, 1 / 60)
    expect(blocked.piece!.turn).toBe(1)
  })

  it('a tap moves the piece a cell; a held key repeats until the wall stops it', () => {
    const piece: Piece = { shape: DASH, turn: 0, color: 0, x: 10, y: 0 }
    const tapped = step(withPiece(piece), { ...idle, tapRight: true, right: true }, 1 / 60)
    expect(tapped.piece!.x).toBe(10 + K)
    const left = step(withPiece(piece), { ...idle, tapLeft: true, left: true }, 1 / 60)
    expect(left.piece!.x).toBe(10 - K)

    const held = run(tapped, { ...idle, right: true }, 1)
    expect(held.piece!.x).toBe(W - 3 * K)
  })

  it('a side move goes as far as it is free', () => {
    const piece: Piece = { shape: DASH, turn: 0, color: 0, x: 10, y: 20 }
    // sand in the dash's row with one free grain between it and the dash's right end
    const s = step(withPiece(piece, (g) => (g[at(10 + 3 * K + 1, 20 + K)] = grain(1, 0))), { ...idle, tapRight: true }, 1 / 60)
    expect(s.piece!.x).toBe(11)
  })

  it('a new piece with no room where it appears, once the sand is at rest, ends the game', () => {
    // two-grain stripes of two colours fill the board below the top 10 rows: they stand still and touch no other stripe of their colour
    let s = withPiece({ shape: DASH, turn: 0, color: 3, x: 10, y: 0 }, (g) => {
      for (let y = 10; y < H; y++) for (let x = 0; x < W; x++) g[at(x, y)] = grain((x >> 1) % 2, 0)
    })
    for (let i = 0; i < 600 && s.phase === 'playing'; i++) s = step(s, { ...idle, drop: true }, 1 / 60)
    expect(s.phase).toBe('over')
    expect(s.piece).toBeNull()
    expect(step(s, idle, 0.1)).toBe(s)
  })

  it('a piece that lands where the next one appears does not end the game: the next waits until the grains pour away', () => {
    const PLUS = PIECES.findIndex((p) => p.name === 'plus')
    // flat sand from row 17 down, in stripes of four colours one grain wide, so nothing clears and nothing moves
    let s = withPiece(spawn(PLUS, 0), (g) => {
      for (let y = 17; y < H; y++) for (let x = 0; x < W; x++) g[at(x, y)] = grain(x % 4, 0)
    })
    s = { ...s, next: { shape: PLUS, color: 1 } }
    // dropped, the plus stands on the sand up to row 8, where the next plus would appear
    s = step(s, { ...idle, drop: true }, 0)
    expect(fits(s.grid, spawn(PLUS, 1))).toBe(false)
    expect(s.phase).toBe('playing')
    expect(s.piece).toBeNull()
    // its grains pour into a low heap, and the next plus comes
    for (let i = 0; i < 300 && s.piece === null; i++) s = step(s, idle, 1 / 60)
    expect(s.phase).toBe('playing')
    expect(s.piece).toMatchObject({ shape: PLUS, color: 1 })
  })

  it('a piece that lands sticking out above the board ends the game, even with room for the next', () => {
    // a 45° heap peaking at the left wall: its top is 2 cells down over the first cell's columns and one grain lower per
    // column to the right, so it stands still and leaves the place where pieces appear free; stripes of two colours, so
    // nothing clears
    const peak = 2 * K
    const heap = (g: Uint8Array): void => {
      for (let x = 0; x < W; x++) for (let y = peak + Math.max(0, x - (K - 1)); y < H; y++) g[at(x, y)] = grain((x >> 1) % 2, 0)
    }
    // an upright dash, 3 cells tall, on the heap's peak: its top cell is above the board
    const upright: Piece = { shape: DASH, turn: 1, color: 3, x: -K, y: peak - 3 * K }
    const s = step(withPiece(upright, heap), { ...idle, drop: true }, 1 / 60)
    expect(fits(s.grid, spawn(0, 0))).toBe(true)
    expect(s.phase).toBe('over')
  })

  it('the fall speeds up with the score, up to a cap', () => {
    expect(fallSpeed(0)).toBe(SAND.fallStart)
    expect(fallSpeed(2000)).toBeGreaterThan(fallSpeed(0))
    expect(fallSpeed(1e9)).toBe(SAND.fallMax)
    const piece: Piece = { shape: DASH, turn: 0, color: 0, x: 10, y: 0 }
    const slow = run(withPiece(piece), idle, 0.5)
    const fast = run({ ...withPiece(piece), score: 3000 }, idle, 0.5)
    expect(fast.piece!.y).toBeGreaterThan(slow.piece!.y)
    const soft = run(withPiece(piece), { ...idle, down: true }, 0.5)
    expect(soft.piece!.y).toBeGreaterThan(fast.piece!.y)
  })

  it('the same seed deals the same pieces', () => {
    const a = run(start(newGame(9)), { ...idle, drop: true }, 0.05)
    const b = run(start(newGame(9)), { ...idle, drop: true }, 0.05)
    expect(a.grid).toEqual(b.grid)
    expect(a.next).toEqual(b.next)
  })

  it('a step leaves the state it was given as it was', () => {
    const s = withPiece({ shape: DASH, turn: 0, color: 1, x: 10, y: 40 }, (g) => {
      g[at(5, 0)] = grain(2, 0)
      for (let x = 0; x < W; x++) g[at(x, H - 1)] = grain(0, 0)
    })
    const before = structuredClone(s)
    step(s, { ...idle, drop: true, tapLeft: true }, 0.1)
    expect(s).toEqual(before)
  })
})
