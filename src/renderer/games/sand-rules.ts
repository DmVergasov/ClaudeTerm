import { seeded } from './random'

/** Sand's numbers, tuned by play: the board in grains, seconds; speeds in grains per second */
export const SAND = {
  /** 14 × 20 cells of 3 × 3 grains: a grid of 42 × 60 grains, 2 520 cells a tick; the widest piece is under a quarter of the board */
  cols: 14,
  rows: 20,
  k: 3,
  width: 42,
  height: 60,
  /** the sand's tick and the longest frame it catches up on */
  step: 1 / 60,
  maxDt: 0.1,
  /** the piece's fall speed rises with the score from fallStart, by fallPerPoint a point, up to fallMax */
  fallStart: 10,
  fallPerPoint: 1 / 200,
  fallMax: 40,
  softFall: 60,
  /** a held ←/→ moves again after repeatDelay, then every repeatEvery */
  repeatDelay: 0.16,
  repeatEvery: 0.055,
  colors: 4,
  shades: 4,
  /** seconds the grains of a clear flash before they are gone from the picture */
  flashFor: 0.25
} as const

/** slack for the fixed-step loop, so that a frame of 0.1 s is 6 steps of 1/60 s and not 5 */
const EPSILON = 1e-9

/**
 * Our own pieces of 3 and 5 cells (no 4-cell piece), each in a box of `size` × `size` cells, as [row, col]: a dash, a
 * corner, a plus, a bracket `[`, a tee and a step.
 */
export const PIECES: readonly { name: string; size: number; cells: readonly (readonly [number, number])[] }[] = [
  { name: 'dash', size: 3, cells: [[1, 0], [1, 1], [1, 2]] },
  { name: 'corner', size: 2, cells: [[0, 0], [1, 0], [1, 1]] },
  { name: 'plus', size: 3, cells: [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]] },
  { name: 'bracket', size: 3, cells: [[0, 0], [0, 1], [1, 0], [2, 0], [2, 1]] },
  { name: 'tee', size: 3, cells: [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]] },
  { name: 'step', size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]] }
]

export interface Piece {
  shape: number
  /** quarter turns clockwise, 0 to 3 */
  turn: number
  color: number
  /** the box's top-left corner, in grains; y may be above the board */
  x: number
  y: number
}

export type SandPhase = 'ready' | 'playing' | 'over'

export interface SandState {
  phase: SandPhase
  /** width × height grains, row by row: 0 is empty, else 1 + color × shades + shade */
  grid: Uint8Array
  piece: Piece | null
  next: { shape: number; color: number }
  score: number
  /** clears since the sand last came to rest */
  chain: number
  /** a piece landed since the last tick: the tick looks for a clear */
  landed: boolean
  /** grains of fall not yet made */
  fall: number
  /** the side a held key moves to, and the time to its next move */
  hold: { dir: -1 | 0 | 1; wait: number }
  /** the grains the last clear took, and how long they still flash */
  flash: { cells: number[]; left: number }
  tick: number
  seed: number
  acc: number
}

/** left, right, down: held; turn, drop, tapLeft, tapRight: pressed since the last frame */
export interface SandInput {
  left: boolean
  right: boolean
  down: boolean
  turn: boolean
  drop: boolean
  tapLeft: boolean
  tapRight: boolean
}

const W = SAND.width
const H = SAND.height
const K = SAND.k

/** the colour of a grain, 0 to 3 */
export const colorOf = (v: number): number => Math.floor((v - 1) / SAND.shades)

/** a grain of a colour and a shade */
export const grain = (color: number, shade: number): number => 1 + color * SAND.shades + shade

/** a piece's cells after its turns, as [row, col] in its box */
export function pieceCells(p: Pick<Piece, 'shape' | 'turn'>): [number, number][] {
  const { size, cells } = PIECES[p.shape]
  return cells.map(([r, c]) => {
    let row = r
    let col = c
    for (let i = 0; i < p.turn; i++) [row, col] = [col, size - 1 - row]
    return [row, col]
  })
}

/** the grains a piece covers, as board indices; a grain above the board is -1 */
function pieceGrains(p: Piece): number[] {
  const out: number[] = []
  for (const [r, c] of pieceCells(p)) {
    for (let dy = 0; dy < K; dy++) {
      for (let dx = 0; dx < K; dx++) {
        const x = p.x + c * K + dx
        const y = p.y + r * K + dy
        out.push(y < 0 ? -1 : y * W + x)
      }
    }
  }
  return out
}

/** the piece is inside the walls, above the floor, and on no sand; above the top is free */
export function fits(grid: Uint8Array, p: Piece): boolean {
  for (const [r, c] of pieceCells(p)) {
    const x0 = p.x + c * K
    const y0 = p.y + r * K
    if (x0 < 0 || x0 + K > W || y0 + K > H) return false
    for (let dy = 0; dy < K; dy++) {
      const y = y0 + dy
      if (y < 0) continue
      for (let dx = 0; dx < K; dx++) if (grid[y * W + x0 + dx] !== 0) return false
    }
  }
  return true
}

/** a piece where new pieces appear: its box centred on the cells, its top cell in the top row */
export function spawn(shape: number, color: number): Piece {
  const { size } = PIECES[shape]
  const top = Math.min(...PIECES[shape].cells.map(([r]) => r))
  return { shape, turn: 0, color, x: Math.floor((SAND.cols - size) / 2) * K, y: -top * K }
}

/** the piece's fall speed at a score, grains per second */
export function fallSpeed(score: number): number {
  return Math.min(SAND.fallMax, SAND.fallStart + score * SAND.fallPerPoint)
}

/** a new game on an empty board, waiting to be started */
export function newGame(seed: number): SandState {
  const rand = seeded(seed)
  const next = { shape: Math.floor(rand.next() * PIECES.length), color: Math.floor(rand.next() * SAND.colors) }
  return {
    phase: 'ready',
    grid: new Uint8Array(W * H),
    piece: null,
    next,
    score: 0,
    chain: 0,
    landed: false,
    fall: 0,
    hold: { dir: 0, wait: 0 },
    flash: { cells: [], left: 0 },
    tick: 0,
    seed: rand.seed(),
    acc: 0
  }
}

/** a waiting game starts with its first piece; one that is over starts again on an empty board; one playing goes on */
export function start(s: SandState): SandState {
  if (s.phase === 'playing') return s
  const base = s.phase === 'over' ? newGame(s.seed) : s
  const rand = seeded(base.seed)
  const piece = spawn(base.next.shape, base.next.color)
  const next = { shape: Math.floor(rand.next() * PIECES.length), color: Math.floor(rand.next() * SAND.colors) }
  return { ...base, phase: 'playing', grid: base.grid.slice(), piece, next, seed: rand.seed() }
}

/** the piece moved a cell to the side, or as far as it is free */
function slide(grid: Uint8Array, p: Piece, dir: -1 | 1): Piece {
  let moved = p
  for (let i = 0; i < K; i++) {
    const tried = { ...moved, x: moved.x + dir }
    if (!fits(grid, tried)) break
    moved = tried
  }
  return moved
}

/** the sand's tick: from the bottom row up, a grain falls, else slides down left or right, else rests; true when one moved */
function settle(grid: Uint8Array, piece: Uint8Array, tick: number, rand: () => number): boolean {
  let moved = false
  const free = (i: number): boolean => grid[i] === 0 && piece[i] === 0
  for (let y = H - 2; y >= 0; y--) {
    const leftToRight = ((y + tick) & 1) === 0
    for (let i = 0; i < W; i++) {
      const x = leftToRight ? i : W - 1 - i
      const at = y * W + x
      const v = grid[at]
      if (v === 0) continue
      const below = at + W
      if (free(below)) {
        grid[below] = v
        grid[at] = 0
        moved = true
        continue
      }
      const canLeft = x > 0 && free(below - 1)
      const canRight = x < W - 1 && free(below + 1)
      if (!canLeft && !canRight) continue
      const to = canLeft && canRight ? (rand() < 0.5 ? below - 1 : below + 1) : canLeft ? below - 1 : below + 1
      grid[to] = v
      grid[at] = 0
      moved = true
    }
  }
  return moved
}

/** the grains of every one-colour region, 8-connected, that touches both the left and the right wall */
export function findClears(grid: Uint8Array): number[] {
  const seen = new Uint8Array(W * H)
  const out: number[] = []
  for (let y = 0; y < H; y++) {
    const startAt = y * W
    if (grid[startAt] === 0 || seen[startAt] === 1) continue
    const color = colorOf(grid[startAt])
    const region: number[] = []
    const todo = [startAt]
    seen[startAt] = 1
    let right = false
    while (todo.length > 0) {
      const i = todo.pop()!
      region.push(i)
      const x = i % W
      const iy = (i - x) / W
      if (x === W - 1) right = true
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = iy + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
          const j = ny * W + nx
          if (seen[j] === 1 || grid[j] === 0 || colorOf(grid[j]) !== color) continue
          seen[j] = 1
          todo.push(j)
        }
      }
    }
    if (right) out.push(...region)
  }
  return out
}

/** the next piece appears where new pieces appear, if it has room there; true when it did */
function bringNext(s: SandState, rand: () => number): boolean {
  const fresh = spawn(s.next.shape, s.next.color)
  if (!fits(s.grid, fresh)) return false
  s.piece = fresh
  s.next = { shape: Math.floor(rand() * PIECES.length), color: Math.floor(rand() * SAND.colors) }
  return true
}

/** the piece breaks into grains of its colour, each with a random shade, and the next piece appears if it has room;
 * if not, it waits for the sand to pour away (see tick). A piece that lands sticking out above the board ends the game */
function land(s: SandState, piece: Piece, rand: () => number): void {
  const grains = pieceGrains(piece)
  for (const i of grains) if (i >= 0) s.grid[i] = grain(piece.color, Math.floor(rand() * SAND.shades))
  s.fall = 0
  s.landed = true
  s.piece = null
  if (grains.some((i) => i < 0)) s.phase = 'over'
  else bringNext(s, rand)
}

/** the keys pressed since the last frame, at once: a turn if it fits, a tap's move, a drop to the bottom */
function press(s: SandState, input: SandInput, rand: () => number): void {
  if (s.piece === null) return
  if (input.turn) {
    const turned = { ...s.piece, turn: (s.piece.turn + 1) % 4 }
    if (fits(s.grid, turned)) s.piece = turned
  }
  if (input.tapLeft !== input.tapRight) {
    const dir: -1 | 1 = input.tapLeft ? -1 : 1
    s.piece = slide(s.grid, s.piece, dir)
    s.hold = { dir, wait: SAND.repeatDelay }
  }
  if (input.drop) {
    let p = s.piece
    while (fits(s.grid, { ...p, y: p.y + 1 })) p = { ...p, y: p.y + 1 }
    land(s, p, rand)
  }
}

/** one fixed step: a held key's repeat, the fall and a landing, the sand's tick, then a clear */
function tick(s: SandState, input: SandInput, rand: () => number): void {
  if (s.piece !== null) {
    const dir: -1 | 0 | 1 = input.left === input.right ? 0 : input.left ? -1 : 1
    if (dir === 0) s.hold = { dir: 0, wait: 0 }
    else if (dir !== s.hold.dir) s.hold = { dir, wait: SAND.repeatDelay }
    else {
      let wait = s.hold.wait - SAND.step
      if (wait <= 0) {
        s.piece = slide(s.grid, s.piece, dir)
        wait += SAND.repeatEvery
      }
      s.hold = { dir, wait }
    }

    s.fall += (input.down ? Math.max(SAND.softFall, fallSpeed(s.score)) : fallSpeed(s.score)) * SAND.step
    while (s.fall >= 1 && s.piece !== null) {
      s.fall -= 1
      const lower: Piece = { ...s.piece, y: s.piece.y + 1 }
      if (fits(s.grid, lower)) s.piece = lower
      else land(s, s.piece, rand)
    }
  }

  const mask = new Uint8Array(W * H)
  if (s.piece !== null) for (const i of pieceGrains(s.piece)) if (i >= 0) mask[i] = 1
  const moved = settle(s.grid, mask, s.tick, rand)
  s.tick += 1
  if (s.flash.left > 0) s.flash = { cells: s.flash.cells, left: Math.max(0, s.flash.left - SAND.step) }

  const cleared = findClears(s.grid)
  if (cleared.length > 0) {
    for (const i of cleared) s.grid[i] = 0
    s.chain += 1
    s.score += cleared.length * s.chain
    s.flash = { cells: cleared, left: SAND.flashFor }
  } else if (!moved && !s.landed) s.chain = 0
  s.landed = false
  // a next piece waiting for room comes as soon as it has some; if the sand came to rest without making room, it is over
  if (s.phase === 'playing' && s.piece === null && !bringNext(s, rand) && !moved && cleared.length === 0) s.phase = 'over'
}

/** advances a game by dt seconds: the presses at once, then fixed steps; a game not playing is returned as it is */
export function step(s: SandState, input: SandInput, dt: number): SandState {
  if (s.phase !== 'playing') return s
  const rand = seeded(s.seed)
  const w: SandState = { ...s, grid: s.grid.slice() }
  press(w, input, rand.next)
  w.acc += Math.min(SAND.maxDt, Math.max(0, dt))
  while (w.acc >= SAND.step - EPSILON && w.phase === 'playing') {
    w.acc -= SAND.step
    tick(w, input, rand.next)
  }
  if (w.phase !== 'playing') w.acc = 0
  w.seed = rand.seed()
  return w
}
