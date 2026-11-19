import { ARTILLERY } from './artillery-config'
import type { Ground, Rect, Team } from './artillery-types'
import { seeded } from './random'

const TAU = Math.PI * 2
/** the caves: up to CAVE_TRIES draws, at most CAVES carved */
const CAVE_TRIES = 20
const CAVES = 4
/** the start spots: per team, how many, how many tries each, the jitter either side, and the walkable slope */
const SPOTS = 3
const SPOT_TRIES = 50
const JITTER = 15
const WALK_STEP = 3
/** each team's half of the map, in x */
const HALVES: Record<Team, readonly [number, number]> = { clawd: [20, 394], bug: [434, 808] }

/** the map from a seed: a surface of three sine waves, caves carved under it and one overhang */
export function makeGround(seed: number): Ground {
  const w = ARTILLERY.width
  const h = ARTILLERY.height
  const rng = seeded(seed)
  const range = (a: number, b: number): number => a + (b - a) * rng.next()
  const a1 = range(18, 26)
  const p1 = range(300, 420)
  const f1 = range(0, TAU)
  const a2 = range(8, 14)
  const p2 = range(90, 140)
  const f2 = range(0, TAU)
  const a3 = range(2, 4)
  const p3 = range(25, 40)
  const f3 = range(0, TAU)

  const top: number[] = []
  for (let x = 0; x < w; x++) {
    const y = 100 + a1 * Math.sin((x * TAU) / p1 + f1) + a2 * Math.sin((x * TAU) / p2 + f2) + a3 * Math.sin((x * TAU) / p3 + f3)
    top.push(Math.min(ARTILLERY.groundBottom, Math.max(ARTILLERY.groundTop, Math.round(y))))
  }

  const g: Ground = { w, h, cells: new Uint8Array(w * h) }
  for (let x = 0; x < w; x++) {
    for (let y = top[x]; y < h; y++) g.cells[y * w + x] = 1
  }

  let carved = 0
  for (let t = 0; t < CAVE_TRIES && carved < CAVES; t++) {
    const cx = Math.round(range(60, 768))
    const cy = top[cx] + Math.round(range(18, 32))
    const rx = range(10, 22)
    const ry = range(5, 10)
    if (cy + ry < ARTILLERY.water - 2) {
      carveEllipse(g, cx, cy, rx, ry)
      carved++
    }
  }

  // the overhang: at the steepest sampled slope, an ellipse 6 px under the surface on the downhill side
  let slope = 0
  let steep = 60
  for (let x = 20; x < w - 20; x++) {
    const s = top[x + 1] - top[x - 1]
    if (Math.abs(s) > Math.abs(slope)) {
      slope = s
      steep = x
    }
  }
  const downhill = slope > 0 ? 1 : -1
  const ox = steep + 6 * downhill
  carveEllipse(g, ox, top[ox] + 6, 12, 6)
  return g
}

/** clears the cells inside an ellipse of radii rx, ry around (cx, cy), within the map */
function carveEllipse(g: Ground, cx: number, cy: number, rx: number, ry: number): void {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(g.h - 1, Math.ceil(cy + ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(g.w - 1, Math.ceil(cx + rx)); x++) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1) g.cells[y * g.w + x] = 0
    }
  }
}

/** true when the cell (x, y) is ground; x and y are rounded. Outside the sides or above the top is empty, below the bottom is ground */
export function solid(g: Ground, x: number, y: number): boolean {
  const cx = Math.round(x)
  const cy = Math.round(y)
  if (cx < 0 || cx >= g.w || cy < 0) return false
  if (cy >= g.h) return true
  return g.cells[cy * g.w + cx] === 1
}

/** a copy of the ground that can be cut without touching the original */
export function cloneGround(g: Ground): Ground {
  return { w: g.w, h: g.h, cells: g.cells.slice() }
}

/** clears every cell with (x − cx)² + (y − cy)² ≤ r², in place; the disc's box clipped to the map, null when none is in the map */
export function clearDisc(g: Ground, cx: number, cy: number, r: number): Rect | null {
  const r2 = r * r
  let box: Rect | null = null
  for (let y = Math.max(0, Math.ceil(cy - r)); y <= Math.min(g.h - 1, Math.floor(cy + r)); y++) {
    for (let x = Math.max(0, Math.ceil(cx - r)); x <= Math.min(g.w - 1, Math.floor(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue
      g.cells[y * g.w + x] = 0
      box = box
        ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) }
        : { x0: x, y0: y, x1: x, y1: y }
    }
  }
  return box
}

/** true when some ground cell lies in the disc of radius r at (cx, cy), within the map (the cells clearDisc would clear) */
export function discTouches(g: Ground, cx: number, cy: number, r: number): boolean {
  const r2 = r * r
  for (let y = Math.max(0, Math.ceil(cy - r)); y <= Math.min(g.h - 1, Math.floor(cy + r)); y++) {
    for (let x = Math.max(0, Math.ceil(cx - r)); x <= Math.min(g.w - 1, Math.floor(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2 && g.cells[y * g.w + x] === 1) return true
    }
  }
  return false
}

/** the first ground row from the top in column x; g.h when the column is empty */
export function surfaceY(g: Ground, x: number): number {
  if (x < 0 || x >= g.w) return g.h
  for (let y = 0; y < g.h; y++) {
    if (g.cells[y * g.w + x] === 1) return y
  }
  return g.h
}

/** the feet row of a fighter standing at x: the smallest surfaceY under its box (x − 6 … x + 5), minus 1 */
export function standY(g: Ground, x: number): number {
  let top = g.h
  for (let c = x - ARTILLERY.halfW; c < x + ARTILLERY.halfW; c++) {
    top = Math.min(top, surfaceY(g, c))
  }
  return top - 1
}

/** true when a fighter can stand at x: on its team's half, above the water and on ground that is flat within ±15 px */
function walkable(g: Ground, x: number, [lo, hi]: readonly [number, number]): boolean {
  if (x < lo || x > hi || standY(g, x) >= ARTILLERY.water - 4) return false
  for (let i = -JITTER; i <= JITTER; i++) {
    if (Math.abs(surfaceY(g, x + i) - surfaceY(g, x + i - 1)) > WALK_STEP) return false
  }
  return true
}

/** the first x nearest the centre, scanning outwards from it within from … to, that passes fits; undefined when none does */
function nearestFit(centre: number, from: number, to: number, fits: (x: number) => boolean): number | undefined {
  const span = Math.max(centre - from, to - centre)
  for (let d = 0; d <= span; d++) {
    for (const x of d === 0 ? [centre] : [centre + d, centre - d]) {
      if (x >= from && x <= to && fits(x)) return x
    }
  }
  return undefined
}

/** each team's x: Clawds in 20 … 394, bugs in 434 … 808, 40 px apart, on walkable ground */
export function spawnSpots(g: Ground, seed: number): Record<Team, number[]> {
  const rng = seeded(seed)
  const spots: Record<Team, number[]> = { clawd: [], bug: [] }
  for (const team of ['clawd', 'bug'] as const) {
    const half = HALVES[team]
    const xs = spots[team]
    const fits = (x: number): boolean => walkable(g, x, half) && xs.every((o) => Math.abs(o - x) >= ARTILLERY.spawnGap)
    for (let i = 0; i < SPOTS; i++) {
      // an even slot across the half: the jittered window first, then the whole slot, then the whole half, nearest the centre first
      const slot = half[0] + ((half[1] - half[0]) * (i + 0.5)) / SPOTS
      const centre = Math.round(slot)
      let x: number | undefined
      for (let t = 0; t < SPOT_TRIES && x === undefined; t++) {
        const cand = Math.round(slot + (rng.next() * 2 - 1) * JITTER)
        if (fits(cand)) x = cand
      }
      const reach = (half[1] - half[0]) / (2 * SPOTS)
      x ??= nearestFit(centre, Math.ceil(slot - reach), Math.floor(slot + reach), fits)
      x ??= nearestFit(centre, half[0], half[1], fits)
      // a half with no fitting x keeps the plain even x
      xs.push(x ?? centre)
    }
  }
  return spots
}
