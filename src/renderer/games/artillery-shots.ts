import { ARTILLERY, DEPLOY, FORK, PING, SHOTS } from './artillery-config'
import { solid } from './artillery-ground'
import type { Fighter, Ground, Impact, Shot, ShotKind } from './artillery-types'

const DEG = Math.PI / 180
/** the shots that go off when they touch the ground or a fighter; a grenade bounces and a dynamite stops */
const BLOWS_UP = new Set<ShotKind>(['rocket', 'fork', 'bomblet', 'bomb'])

/** the unit direction of an aim in degrees (0 level, +90 up, −90 down) on the side f faces; y down */
export function aimVector(f: Fighter, aim: number): { dx: number; dy: number } {
  const a = aim * DEG
  return { dx: f.facing * Math.cos(a), dy: -Math.sin(a) }
}

/** starts muzzle px from the body's middle (x, y − 5) along the aim at minSpeed + power × (maxSpeed − minSpeed) */
export function launch(kind: 'rocket' | 'grenade' | 'fork', f: Fighter, owner: number, aim: number, power: number): Shot {
  const { dx, dy } = aimVector(f, aim)
  const speed = ARTILLERY.minSpeed + power * (ARTILLERY.maxSpeed - ARTILLERY.minSpeed)
  return {
    kind,
    x: f.x + dx * ARTILLERY.muzzle,
    y: f.y - 5 + dy * ARTILLERY.muzzle,
    vx: dx * speed,
    vy: dy * speed,
    fuse: SHOTS[kind].fuse,
    resting: false,
    owner,
    age: 0
  }
}

/** at the feet, still, fuse SHOTS.dynamite.fuse */
export function dynamite(f: Fighter, owner: number): Shot {
  return { kind: 'dynamite', x: f.x, y: f.y, vx: 0, vy: 0, fuse: SHOTS.dynamite.fuse, resting: false, owner, age: 0 }
}

/** DEPLOY.bombs bombs at x − gap, x, x + gap, y DEPLOY.y, vy DEPLOY.vy */
export function deployBombs(x: number, owner: number): Shot[] {
  const shots: Shot[] = []
  for (let i = 0; i < DEPLOY.bombs; i++) {
    const offset = (i - (DEPLOY.bombs - 1) / 2) * DEPLOY.gap
    shots.push({ kind: 'bomb', x: x + offset, y: DEPLOY.y, vx: 0, vy: DEPLOY.vy, fuse: null, resting: false, owner, age: 0 })
  }
  return shots
}

/** the blast of a shot of kind at (x, y), with the kind's radius, damage and push */
export function impactOf(kind: ShotKind, x: number, y: number): Impact {
  const s = SHOTS[kind]
  return { x, y, radius: s.radius, damage: s.damage, push: s.push }
}

/** true when the fighter's body box (x − 6 … x + 5, y − 9 … y) holds the cell (cx, cy) */
function inBox(f: Fighter, cx: number, cy: number): boolean {
  return cx >= f.x - ARTILLERY.halfW && cx < f.x + ARTILLERY.halfW && cy > f.y - ARTILLERY.bodyH && cy <= f.y
}

/** the bomblets a fork throws from (x, y): 2 px above it, at 30°, 60° … up, at FORK.speed */
function bomblets(s: Shot): Shot[] {
  const shots: Shot[] = []
  for (let i = 0; i < FORK.bomblets; i++) {
    const a = (30 + 30 * i) * DEG
    shots.push({
      kind: 'bomblet',
      x: s.x,
      y: s.y - 2,
      vx: Math.cos(a) * FORK.speed,
      vy: -Math.sin(a) * FORK.speed,
      fuse: null,
      resting: false,
      owner: s.owner,
      age: 0
    })
  }
  return shots
}

/** one step of a shot (mutates s): gravity, the wind if SHOTS[kind].wind, the fuse, ≤ 1 px per substep.
 *  Leaving through a side or touching row ≥ water: gone, no impact. Above the top it flies on.
 *  Ground: rocket, fork, bomblet, bomb explode; grenade bounces (reflect the blocked axis × bounce) and rests below
 *  restSpeed on ground; dynamite stops. A fighter's box (any not out, the owner too once age > 0.1 s): rocket, fork,
 *  bomblet, bomb explode. A fuse at 0 explodes where it is. A fork's impact spawns FORK.bomblets bomblets 2 px above
 *  it. age > shotMaxAge: gone. A resting shot with no ground under it falls again. */
export function shotStep(
  g: Ground,
  fighters: readonly Fighter[],
  s: Shot,
  wind: number,
  water: number,
  dt: number
): { gone: boolean; impact: Impact | null; spawn: Shot[] } {
  const none = { gone: false, impact: null, spawn: [] }
  const off = (): { gone: boolean; impact: Impact | null; spawn: Shot[] } => ({
    gone: true,
    impact: impactOf(s.kind, s.x, s.y),
    spawn: s.kind === 'fork' ? bomblets(s) : []
  })

  s.age += dt
  if (s.age > ARTILLERY.shotMaxAge) return { gone: true, impact: null, spawn: [] }
  if (s.fuse !== null) {
    s.fuse -= dt
    if (s.fuse <= 0) return off()
  }
  if (s.resting) {
    if (solid(g, s.x, Math.round(s.y) + 1)) return none
    s.resting = false
  }

  s.vy += ARTILLERY.gravity * dt
  if (SHOTS[s.kind].wind) s.vx += wind * dt
  const dx = s.vx * dt
  const dy = s.vy * dt
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(s.vx), Math.abs(s.vy)) * dt))
  for (let i = 0; i < n; i++) {
    const blockX = solid(g, s.x + dx / n, s.y)
    if (!blockX) s.x += dx / n
    const blockY = solid(g, s.x, s.y + dy / n)
    if (!blockY) s.y += dy / n
    const cx = Math.round(s.x)
    const cy = Math.round(s.y)
    if (cx < 0 || cx >= g.w || cy >= water) return { gone: true, impact: null, spawn: [] }

    if (blockX || blockY) {
      if (BLOWS_UP.has(s.kind)) {
        // the blast is where the shot met the ground or wall, not the cell before it
        if (blockX) s.x += dx / n
        if (blockY) s.y += dy / n
        return off()
      }
      if (s.kind === 'dynamite') {
        s.vx = 0
        s.vy = 0
        s.resting = true
        return none
      }
      // a grenade: reflect the blocked axis, and rest once it bounces less than restSpeed
      if (blockX) s.vx = -s.vx * SHOTS[s.kind].bounce
      if (blockY) s.vy = -s.vy * SHOTS[s.kind].bounce
      if (blockY && Math.abs(s.vy) < ARTILLERY.restSpeed) {
        s.vx = 0
        s.vy = 0
        s.resting = true
      }
      return none
    }

    if (BLOWS_UP.has(s.kind)) {
      for (let k = 0; k < fighters.length; k++) {
        const f = fighters[k]
        if (f.out) continue
        if (k === s.owner && s.age <= ARTILLERY.ownGrace) continue
        if (inBox(f, cx, cy)) return off()
      }
    }
  }
  return none
}

/** what an impact does to f (centre x, y − 5): R = radius × damageReach; null at d ≥ R; k = 1 − d / R;
 *  damage round(damage × k); push v = push × k along (centre − impact) (straight up when d < 0.5), plus −lift × v in y */
export function effect(f: Fighter, impact: Impact): { damage: number; vx: number; vy: number } | null {
  const reach = impact.radius * ARTILLERY.damageReach
  const ex = f.x - impact.x
  const ey = f.y - 5 - impact.y
  const d = Math.hypot(ex, ey)
  if (d >= reach) return null
  const k = 1 - d / reach
  const v = impact.push * k
  const ux = d < 0.5 ? 0 : ex / d
  const uy = d < 0.5 ? -1 : ey / d
  return { damage: Math.round(impact.damage * k), vx: v * ux, vy: v * uy - ARTILLERY.lift * v }
}

/** applies effect to every fighter not out (hp floored at 0, velocity added, air, fallFrom = y); the indexes hurt */
export function hurt(fighters: Fighter[], impact: Impact): number[] {
  const hit: number[] = []
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i]
    if (f.out) continue
    const e = effect(f, impact)
    if (!e) continue
    f.hp = Math.max(0, f.hp - e.damage)
    f.vx += e.vx
    f.vy += e.vy
    f.air = true
    f.fallFrom = f.y
    hit.push(i)
  }
  return hit
}

/** Ping's straight shot from the shooter's muzzle, 1 px at a time up to PING.range: the first ground cell or another
 *  fighter's box gives a PING impact there; null when it leaves the map or reaches the range */
export function pingRay(g: Ground, fighters: readonly Fighter[], shooter: number, aim: number): Impact | null {
  const f = fighters[shooter]
  const { dx, dy } = aimVector(f, aim)
  const x0 = f.x + dx * ARTILLERY.muzzle
  const y0 = f.y - 5 + dy * ARTILLERY.muzzle
  for (let t = 1; t <= PING.range; t++) {
    const x = x0 + dx * t
    const y = y0 + dy * t
    const cx = Math.round(x)
    const cy = Math.round(y)
    if (cx < 0 || cx >= g.w || cy >= g.h) return null
    const hitFighter = fighters.some((o, k) => k !== shooter && !o.out && inBox(o, cx, cy))
    if (solid(g, x, y) || hitFighter) return { x, y, radius: PING.radius, damage: PING.damage, push: PING.push }
  }
  return null
}
