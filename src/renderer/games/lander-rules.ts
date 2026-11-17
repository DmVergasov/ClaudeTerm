import { seeded } from './random'

/**
 * Lander's numbers, tuned by play. Field px with y down, seconds, degrees: an angle of 0 is upright, more is turned
 * clockwise (the nose to the right).
 */
export const LANDER = {
  width: 300,
  height: 200,
  /** the physics' fixed step, and the longest frame it catches up on */
  step: 1 / 120,
  maxDt: 0.1,
  gravity: 22,
  thrust: 52,
  turnRate: 120,
  maxAngle: 90,
  /** fuel burned per second of thrust */
  burn: 12,
  /** a landing needs |vy|, |vx| and |angle| at most these (px/s, px/s, degrees) */
  safeVy: 16,
  safeVx: 9,
  safeAngle: 10,
  /** the feet, from the craft's centre; the hull is a circle of hullR around the centre */
  footX: 11,
  footY: 11,
  hullR: 9,
  startY: 24,
  /** a level starts with a sideways drift of up to this, either way */
  startDrift: 25,
  /** seconds from a landing to the next level */
  landedFor: 1.5,
  /** the ground's points are this far apart, and the ground stays between groundTop and groundBottom */
  segment: 15,
  groundTop: 105,
  groundBottom: 192,
  padTop: 140,
  padBottom: 180,
  /** a landing scores pointsPerLevel × level + pointsPerFuel × the fuel left */
  pointsPerLevel: 100,
  pointsPerFuel: 2
} as const

/** slack for the fixed-step loop, so that a frame of 0.1 s is 12 steps of 1/120 s and not 11 */
const EPSILON = 1e-9

export interface LevelSpec {
  padWidth: number
  /** how far the ground may climb or drop from one point to the next */
  roughness: number
  fuel: number
  /** the wind's strength is up to this, px/s² */
  windMax: number
}

/** each level: a narrower pad, rougher ground and less fuel, down to a floor; a wind from level 3 */
export function levelSpec(level: number): LevelSpec {
  const n = level - 1
  return {
    padWidth: Math.max(30, 64 - 6 * n),
    roughness: Math.min(60, 22 + 8 * n),
    fuel: Math.max(50, 100 - 6 * n),
    windMax: level < 3 ? 0 : Math.min(8, 2 * (level - 2))
  }
}

export interface Point {
  x: number
  y: number
}

export interface Terrain {
  /** the ground line from x 0 to the field's width, left to right */
  points: Point[]
  padX0: number
  padX1: number
  padY: number
}

export type LanderPhase = 'ready' | 'flying' | 'landed' | 'crashed'

export interface LanderState {
  phase: LanderPhase
  level: number
  score: number
  /** the points of the last landing, shown while landed */
  gained: number
  terrain: Terrain
  /** the sideways push, px/s², + to the right */
  wind: number
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  fuel: number
  /** the engine fired in the last step: the view draws the flame */
  thrusting: boolean
  /** seconds since the landing */
  timer: number
  seed: number
  /** frame time not yet stepped */
  acc: number
}

/** all three are held keys */
export interface LanderInput {
  thrust: boolean
  left: boolean
  right: boolean
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** seeded ground with one flat pad; the ground next to the pad drops first, so the pad is never in a pit */
export function makeTerrain(spec: LevelSpec, rand: () => number): Terrain {
  const { width, segment, groundTop, groundBottom, padTop, padBottom } = LANDER
  const padX0 = Math.round(20 + rand() * (width - 40 - spec.padWidth))
  const padX1 = padX0 + spec.padWidth
  const padY = Math.round(padTop + rand() * (padBottom - padTop))
  const walk = (y: number, first: boolean): number => {
    const d = first ? rand() * spec.roughness : (rand() * 2 - 1) * spec.roughness
    return Math.round(clamp(y + d, groundTop, groundBottom))
  }
  const left: Point[] = []
  let y = padY
  for (let x = padX0 - segment; x > 0; x -= segment) {
    y = walk(y, left.length === 0)
    left.unshift({ x, y })
  }
  left.unshift({ x: 0, y: walk(y, left.length === 0) })
  const right: Point[] = []
  y = padY
  for (let x = padX1 + segment; x < width; x += segment) {
    y = walk(y, right.length === 0)
    right.push({ x, y })
  }
  right.push({ x: width, y: walk(y, right.length === 0) })
  return { points: [...left, { x: padX0, y: padY }, { x: padX1, y: padY }, ...right], padX0, padX1, padY }
}

/** the ground's height (its y) at x */
export function groundY(t: Terrain, x: number): number {
  const p = t.points
  if (x <= p[0].x) return p[0].y
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i].x) {
      const a = p[i - 1]
      const b = p[i]
      return b.x === a.x ? Math.min(a.y, b.y) : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x)
    }
  }
  return p[p.length - 1].y
}

/** a point of the craft, given from its centre in the craft's own axes, in field px */
function local(s: Pick<LanderState, 'x' | 'y' | 'angle'>, lx: number, ly: number): Point {
  const a = (s.angle * Math.PI) / 180
  const c = Math.cos(a)
  const n = Math.sin(a)
  return { x: s.x + lx * c - ly * n, y: s.y + lx * n + ly * c }
}

/** the left and the right foot, in field px */
export function feet(s: Pick<LanderState, 'x' | 'y' | 'angle'>): [Point, Point] {
  return [local(s, -LANDER.footX, LANDER.footY), local(s, LANDER.footX, LANDER.footY)]
}

function distToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1)
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
}

/** the hull, a circle around the centre, touches or is under the ground */
function hullTouches(t: Terrain, x: number, y: number): boolean {
  if (y >= groundY(t, x)) return true
  const p = t.points
  for (let i = 1; i < p.length; i++) {
    if (p[i].x < x - LANDER.hullR || p[i - 1].x > x + LANDER.hullR) continue
    if (distToSegment(x, y, p[i - 1], p[i]) < LANDER.hullR) return true
  }
  return false
}

/** a foot or the hull touches the ground */
export function touching(s: Pick<LanderState, 'x' | 'y' | 'angle' | 'terrain'>): boolean {
  return feet(s).some((f) => f.y >= groundY(s.terrain, f.x)) || hullTouches(s.terrain, s.x, s.y)
}

/** what a touch of the ground is: a landing needs both feet over the pad, the hull clear, and |vy|, |vx|, |angle| within limits */
export function touchdown(s: Pick<LanderState, 'x' | 'y' | 'vx' | 'vy' | 'angle' | 'terrain'>): 'landed' | 'crashed' {
  const t = s.terrain
  const onPad = (p: Point): boolean => p.x >= t.padX0 && p.x <= t.padX1
  const safe =
    feet(s).every(onPad) &&
    !hullTouches(t, s.x, s.y) &&
    Math.abs(s.vy) <= LANDER.safeVy &&
    Math.abs(s.vx) <= LANDER.safeVx &&
    Math.abs(s.angle) <= LANDER.safeAngle
  return safe ? 'landed' : 'crashed'
}

/** the points of a landing at a level with this much fuel left */
export function landingPoints(level: number, fuel: number): number {
  return LANDER.pointsPerLevel * level + LANDER.pointsPerFuel * Math.round(fuel)
}

/** a level's start: its ground, wind, fuel, and the craft at the top with a seeded drift */
function enterLevel(level: number, score: number, seed: number, phase: LanderPhase): LanderState {
  const rand = seeded(seed)
  const spec = levelSpec(level)
  const terrain = makeTerrain(spec, rand.next)
  const wind = spec.windMax === 0 ? 0 : Math.round((rand.next() * 2 - 1) * spec.windMax * 10) / 10
  const x = Math.round(40 + rand.next() * (LANDER.width - 80))
  const vx = Math.round((rand.next() * 2 - 1) * LANDER.startDrift)
  return {
    phase,
    level,
    score,
    gained: 0,
    terrain,
    wind,
    x,
    y: LANDER.startY,
    vx,
    vy: 0,
    angle: 0,
    fuel: spec.fuel,
    thrusting: false,
    timer: 0,
    seed: rand.seed(),
    acc: 0
  }
}

/** a new run at level 1, waiting to be started */
export function newRun(seed: number): LanderState {
  return enterLevel(1, 0, seed, 'ready')
}

/** a waiting run starts; a crashed one starts over at level 1; one flying or landed goes on as it is */
export function start(s: LanderState): LanderState {
  if (s.phase === 'ready') return { ...s, phase: 'flying' }
  if (s.phase === 'crashed') return enterLevel(1, 0, s.seed, 'flying')
  return s
}

/** one fixed step of flight: turn, thrust, gravity and wind, the field's sides, then the ground decides */
function fly(s: LanderState, input: LanderInput): LanderState {
  const h = LANDER.step
  const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0)
  const angle = clamp(s.angle + turn * LANDER.turnRate * h, -LANDER.maxAngle, LANDER.maxAngle)
  const thrusting = input.thrust && s.fuel > 0
  const fuel = thrusting ? Math.max(0, s.fuel - LANDER.burn * h) : s.fuel
  const a = (angle * Math.PI) / 180
  const ax = s.wind + (thrusting ? LANDER.thrust * Math.sin(a) : 0)
  const ay = LANDER.gravity - (thrusting ? LANDER.thrust * Math.cos(a) : 0)
  let vx = s.vx + ax * h
  const vy = s.vy + ay * h
  let x = s.x + vx * h
  const y = s.y + vy * h
  const edge = LANDER.footX + 1
  if (x < edge) {
    x = edge
    vx = Math.max(0, vx)
  } else if (x > LANDER.width - edge) {
    x = LANDER.width - edge
    vx = Math.min(0, vx)
  }
  const moved: LanderState = { ...s, angle, fuel, thrusting, vx, vy, x, y }
  if (!touching(moved)) return moved
  if (touchdown(moved) === 'crashed') return { ...moved, phase: 'crashed', thrusting: false }
  const gained = landingPoints(s.level, fuel)
  return {
    ...moved,
    phase: 'landed',
    x,
    y: s.terrain.padY - LANDER.footY,
    vx: 0,
    vy: 0,
    angle: 0,
    thrusting: false,
    score: s.score + gained,
    gained,
    timer: 0
  }
}

/** advances a run by dt seconds in fixed steps; a run that is not flying or landed is returned as it is */
export function step(s: LanderState, input: LanderInput, dt: number): LanderState {
  if (s.phase !== 'flying' && s.phase !== 'landed') return s
  let acc = s.acc + clamp(dt, 0, LANDER.maxDt)
  let next = s
  while (acc >= LANDER.step - EPSILON && (next.phase === 'flying' || next.phase === 'landed')) {
    acc -= LANDER.step
    if (next.phase === 'flying') next = fly(next, input)
    else {
      const timer = next.timer + LANDER.step
      next = timer >= LANDER.landedFor ? enterLevel(next.level + 1, next.score, next.seed, 'flying') : { ...next, timer }
    }
  }
  return { ...next, acc: next.phase === 'crashed' ? 0 : acc }
}
