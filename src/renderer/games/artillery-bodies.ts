import { ARTILLERY } from './artillery-config'
import { discTouches, solid } from './artillery-ground'
import type { Disc, Fighter, Ground } from './artillery-types'

/** the box at the rounded (x, y) holds no ground and is inside the sides (x − 6 ≥ 0, x + 5 < width) */
export function bodyFree(g: Ground, x: number, y: number): boolean {
  const cx = Math.round(x)
  const cy = Math.round(y)
  if (cx - ARTILLERY.halfW < 0 || cx + ARTILLERY.halfW - 1 >= g.w) return false
  for (let r = cy - ARTILLERY.bodyH + 1; r <= cy; r++) {
    for (let c = cx - ARTILLERY.halfW; c < cx + ARTILLERY.halfW; c++) {
      if (solid(g, c, r)) return false
    }
  }
  return true
}

/** a cell under the box's bottom row (row y + 1, columns x − 6 … x + 5) is ground, with the feet at (x, y) */
function standsOn(g: Ground, x: number, y: number): boolean {
  const cy = Math.round(y) + 1
  for (let c = Math.round(x) - ARTILLERY.halfW; c < Math.round(x) + ARTILLERY.halfW; c++) {
    if (solid(g, c, cy)) return true
  }
  return false
}

/** a cell under the box's bottom row (row y + 1, columns x − 6 … x + 5) is ground */
export function grounded(g: Ground, f: Fighter): boolean {
  return standsOn(g, f.x, f.y)
}

/** a Teleport may land the box at (x, y): the spot is free and its feet are above the water (less than 2 px above the water line) */
export function teleportOk(g: Ground, water: number, x: number, y: number): boolean {
  return y < water - 2 && bodyFree(g, x, y)
}

/** true when a drill that is on its way has no ground under the box and its next disc would cut no ground: it stops there */
export function drillStops(g: Ground, f: Fighter): boolean {
  const drill = f.drill
  if (!drill || grounded(g, f)) return false
  return !discTouches(g, f.x + drill.dx, f.y + drill.dy - 5, ARTILLERY.drillRadius)
}

/** the feet row nearest f.y, within climb px either way (up first on a tie), where a box at x fits and stands on ground; null when none */
function floorAt(g: Ground, f: Fighter, x: number): number | null {
  for (let d = 0; d <= ARTILLERY.climb; d++) {
    for (const y of d === 0 ? [f.y] : [f.y - d, f.y + d]) {
      if (bodyFree(g, x, y) && standsOn(g, x, y)) return y
    }
  }
  return null
}

/**
 * Turns f to dir; on the ground moves walkSpeed × dt through f.walked, a px at a time. The floor is looked up around
 * the feet, so a fighter walks in caves, tunnels and under overhangs: the next x takes the nearest feet row within
 * climb px where the box fits and stands on ground; a box that fits with no floor under it steps off a ledge and
 * falls (air, fallFrom = y); a box that does not fit is a wall, and it stays. Mutates f.
 */
export function walk(g: Ground, f: Fighter, dir: -1 | 1, dt: number): void {
  f.facing = dir
  if (f.air || !grounded(g, f)) return
  f.walked += ARTILLERY.walkSpeed * dt
  while (f.walked >= 1) {
    const nx = f.x + dir
    const ny = floorAt(g, f, nx)
    if (ny !== null) {
      f.x = nx
      f.y = ny
      f.walked -= 1
      continue
    }
    f.walked = 0
    if (bodyFree(g, nx, f.y)) {
      f.x = nx
      f.air = true
      f.fallFrom = f.y
      f.vx = 0
      f.vy = 0
    }
    return
  }
}

/** on the ground only: vx = facing × jumpVx, vy = −jumpVy, air, fallFrom = y */
export function jump(g: Ground, f: Fighter): void {
  if (f.air || !grounded(g, f)) return
  f.vx = f.facing * ARTILLERY.jumpVx
  f.vy = -ARTILLERY.jumpVy
  f.air = true
  f.fallFrom = f.y
}

/**
 * Gravity, then moves at most 1 px per substep: a side wall or the map's side stops vx (vx = −0.3 vx), a ceiling
 * stops vy; on contact with the ground: faster than landBounce bounces (vy = −0.3 vy, vx × 0.5) and is not a landing,
 * else it rests (air false, vx = vy = 0, x and y rounded) and fall = y − fallFrom. Feet at or below `water`: out, hp 0.
 * fallFrom tracks the highest y. landed is true only on the step the fighter comes to rest; fall is set only then.
 */
export function airStep(g: Ground, f: Fighter, dt: number, water: number): { landed: boolean; fall: number } {
  f.vy += ARTILLERY.gravity * dt
  const dx = f.vx * dt
  const dy = f.vy * dt
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
  let sx = dx / steps
  let sy = dy / steps
  let touched = false

  for (let i = 0; i < steps && !touched; i++) {
    if (sx !== 0) {
      const nx = f.x + sx
      if (bodyFree(g, nx, f.y)) {
        f.x = nx
      } else {
        f.x = Math.round(f.x)
        f.vx *= -ARTILLERY.bounce
        sx = 0
      }
    }
    if (sy !== 0) {
      const ny = f.y + sy
      if (bodyFree(g, f.x, ny)) {
        f.y = ny
      } else if (sy > 0) {
        touched = true
      } else {
        f.y = Math.round(f.y)
        f.vy = 0
        sy = 0
      }
    }
    f.fallFrom = Math.min(f.fallFrom, f.y)
    if (Math.round(f.y) >= water) {
      f.y = Math.round(f.y)
      f.out = true
      f.hp = 0
      return { landed: false, fall: 0 }
    }
  }

  if (!touched) return { landed: false, fall: 0 }
  f.y = Math.round(f.y)
  if (f.vy > ARTILLERY.landBounce) {
    f.vy *= -ARTILLERY.bounce
    f.vx *= ARTILLERY.sideBounce
    return { landed: false, fall: 0 }
  }
  f.x = Math.round(f.x)
  f.air = false
  f.vx = 0
  f.vy = 0
  return { landed: true, fall: f.y - f.fallFrom }
}

/** max(0, round((height − fallSafe) × fallDamage)) */
export function fallDamage(height: number): number {
  return Math.max(0, Math.round((height - ARTILLERY.fallSafe) * ARTILLERY.fallDamage))
}

/**
 * Moves along f.drill at drillLength / drillTime px/s and returns a disc of drillRadius centred on (x, y − 5) for
 * each whole px moved; at left ≤ 0 sets drill to null. Does not read or change the ground. The cadence accumulator is
 * f.walked.
 */
export function drillStep(f: Fighter, dt: number): Disc[] {
  const discs: Disc[] = []
  const drill = f.drill
  if (!drill) return discs
  if (drill.left <= 0) {
    f.drill = null
    return discs
  }
  f.walked += (ARTILLERY.drillLength / ARTILLERY.drillTime) * dt
  while (f.walked >= 1 && drill.left > 0) {
    // a sideways drill stops where its box would leave the map: x − 6 ≥ 0 and x + 5 < width
    const nx = f.x + drill.dx
    if (drill.dx !== 0 && (nx - ARTILLERY.halfW < 0 || nx + ARTILLERY.halfW - 1 >= ARTILLERY.width)) {
      drill.left = 0
      break
    }
    f.walked -= 1
    f.x += drill.dx
    f.y += drill.dy
    drill.left -= 1
    discs.push({ x: f.x, y: f.y - 5, r: ARTILLERY.drillRadius })
  }
  if (drill.left <= 0) f.drill = null
  return discs
}
