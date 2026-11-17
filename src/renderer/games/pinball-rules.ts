/**
 * Pinball's numbers, tuned by play. Field px with y down, seconds; flipper angles in radians, measured as atan2 does
 * (0 points right, more turns clockwise on the screen).
 */
export const PINBALL = {
  width: 190,
  height: 250,
  /** the physics' step and its substeps: at maxSpeed the ball moves under a quarter of its radius per substep */
  step: 1 / 120,
  substeps: 8,
  maxDt: 0.1,
  gravity: 420,
  ballR: 5,
  maxSpeed: 900,
  /** the share of the speed into a surface that comes back out */
  wallBounce: 0.5,
  flipperBounce: 0.2,
  bumperBounce: 0.5,
  /** a bumper adds this speed, px/s, straight away from its centre */
  bumperKick: 240,
  flipperLength: 34,
  flipperR: 3.5,
  /** rad/s up and back down */
  flipperUpSpeed: 24,
  flipperDownSpeed: 14,
  /** seconds to pull the plunger all the way; the launch goes from launchMin to launchMax px/s with the pull */
  plungerFill: 0.9,
  launchMin: 260,
  launchMax: 860,
  balls: 3,
  bumperPoints: 100,
  targetPoints: 250,
  /** both targets lit: this more, and they go dark again */
  targetsBonus: 1000,
  lanePoints: 500,
  /** a target hit slower than this along its normal does not count (the ball rolling down the wall) */
  targetMinSpeed: 40,
  /** seconds a bumper, a target or the lane stays lit after a hit */
  flashFor: 0.2
} as const

/** slack for the fixed-step loop, so that a frame of 0.1 s is 12 steps of 1/120 s and not 11 */
const EPSILON = 1e-9

export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface Circle {
  x: number
  y: number
  r: number
}

const seg = (x1: number, y1: number, x2: number, y2: number): Segment => ({ x1, y1, x2, y2 })

/** the rounded top: half a circle over the table, in straight pieces */
function topArc(): Segment[] {
  const cx = 95
  const cy = 92
  const r = 89
  const n = 18
  const out: Segment[] = []
  let x = cx - r
  let y = cy
  for (let i = 1; i <= n; i++) {
    const t = Math.PI + (Math.PI * i) / n
    const nx = cx + r * Math.cos(t)
    const ny = cy + r * Math.sin(t)
    out.push(seg(x, y, nx, ny))
    x = nx
    y = ny
  }
  return out
}

/** where the ball waits on the plunger, at the bottom of the lane on the right */
export const PLUNGER = { x: 177, y: 241 }

/** the lane the plunger shoots up: right of laneX; its wall ends at laneTop, below the arc */
const LANE = { x: 170, top: 80, floor: 246 }

/**
 * The table: the walls the ball bounces off, the two bracket targets (`{` on the left wall, `}` on the lane wall), the
 * three bug bumpers, the two posts of the `>_` lane at the top and the lane's box, and the flippers' pivots.
 */
export const TABLE = {
  walls: [
    ...topArc(),
    seg(6, 92, 6, 122),
    seg(6, 146, 6, 172),
    // each guide ends on the top of its flipper's pivot cap, tangent to it, so a ball rolls on from the guide onto the
    // flipper instead of catching on the cap
    seg(6, 172, 48.1, 203.2),
    seg(184, 92, 184, 250),
    seg(LANE.x, LANE.top, LANE.x, 122),
    seg(LANE.x, 146, LANE.x, LANE.floor),
    // the right guide, the same on the right pivot's cap
    seg(LANE.x, 172, 127.9, 203.2),
    seg(LANE.x, LANE.floor, 184, LANE.floor)
  ] as Segment[],
  targets: [seg(6, 122, 6, 146), seg(LANE.x, 122, LANE.x, 146)] as Segment[],
  bumpers: [
    { x: 58, y: 100, r: 11 },
    { x: 118, y: 100, r: 11 },
    { x: 88, y: 138, r: 11 }
  ] as Circle[],
  posts: [
    { x: 82, y: 36, r: 3 },
    { x: 108, y: 36, r: 3 }
  ] as Circle[],
  /** the `>_` rollover lane between the posts: the ball's centre passing into it scores */
  lane: { x0: 86, x1: 104, y0: 26, y1: 46 },
  laneX: LANE.x,
  /** left pivot, right pivot; each flipper's rest and up angles */
  flippers: [
    { x: 46, y: 206, rest: (28 * Math.PI) / 180, up: (-26 * Math.PI) / 180 },
    { x: 130, y: 206, rest: Math.PI - (28 * Math.PI) / 180, up: Math.PI + (26 * Math.PI) / 180 }
  ]
} as const

export interface Ball {
  x: number
  y: number
  vx: number
  vy: number
}

export interface Flipper {
  angle: number
  /** rad/s in the last substep: the surface speed it gives the ball */
  omega: number
}

export type PinballPhase = 'ready' | 'play' | 'over'

export interface PinballState {
  phase: PinballPhase
  score: number
  /** balls left, the one in play included */
  balls: number
  ball: Ball
  /** the ball waits on the plunger, held still */
  onPlunger: boolean
  /** how far the plunger is pulled, 0 to 1 */
  power: number
  flippers: [Flipper, Flipper]
  /** the left and the right target are lit */
  lit: [boolean, boolean]
  /** the ball's centre is in the `>_` lane */
  inLane: boolean
  /** seconds left of each bumper's, each target's and the lane's light */
  flash: { bumpers: number[]; targets: number[]; lane: number }
  acc: number
}

/** all three are held keys: the left and the right flipper, the plunger */
export interface PinballInput {
  left: boolean
  right: boolean
  plunger: boolean
}

const onPlungerBall = (): Ball => ({ x: PLUNGER.x, y: PLUNGER.y, vx: 0, vy: 0 })

/** a new game, its first ball on the plunger, waiting to be started */
export function newGame(): PinballState {
  return {
    phase: 'ready',
    score: 0,
    balls: PINBALL.balls,
    ball: onPlungerBall(),
    onPlunger: true,
    power: 0,
    flippers: [
      { angle: TABLE.flippers[0].rest, omega: 0 },
      { angle: TABLE.flippers[1].rest, omega: 0 }
    ],
    lit: [false, false],
    inLane: false,
    flash: { bumpers: [0, 0, 0], targets: [0, 0], lane: 0 },
    acc: 0
  }
}

/** a waiting game starts; one that is over starts again; one in play goes on */
export function start(s: PinballState): PinballState {
  if (s.phase === 'ready') return { ...s, phase: 'play' }
  if (s.phase === 'over') return { ...newGame(), phase: 'play' }
  return s
}

/** the launch speed for a pull of 0 to 1 */
export function launchSpeed(power: number): number {
  return PINBALL.launchMin + (PINBALL.launchMax - PINBALL.launchMin) * Math.min(1, Math.max(0, power))
}

/** a flipper's tip, from its pivot and angle */
export function flipperTip(i: 0 | 1, angle: number): { x: number; y: number } {
  const p = TABLE.flippers[i]
  return { x: p.x + PINBALL.flipperLength * Math.cos(angle), y: p.y + PINBALL.flipperLength * Math.sin(angle) }
}

/**
 * Pushes the ball out of a segment (thickened by radius) it overlaps, and bounces it off: the speed into the surface,
 * taken against the surface's own speed at the contact (a moving flipper), comes back times bounce. Returns the speed
 * it hit with along the normal, or 0 when it did not touch.
 */
function hitSegment(
  b: Ball,
  s: Segment,
  radius: number,
  bounce: number,
  surface?: (x: number, y: number) => { x: number; y: number }
): number {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((b.x - s.x1) * dx + (b.y - s.y1) * dy) / len2))
  const cx = s.x1 + t * dx
  const cy = s.y1 + t * dy
  let nx = b.x - cx
  let ny = b.y - cy
  const d = Math.hypot(nx, ny)
  const min = PINBALL.ballR + radius
  if (d >= min || d === 0) return 0
  nx /= d
  ny /= d
  b.x = cx + nx * min
  b.y = cy + ny * min
  const sv = surface ? surface(cx, cy) : { x: 0, y: 0 }
  const vn = (b.vx - sv.x) * nx + (b.vy - sv.y) * ny
  if (vn >= 0) return 0
  b.vx -= (1 + bounce) * vn * nx
  b.vy -= (1 + bounce) * vn * ny
  return -vn
}

/** the same for a circle; kick adds speed straight out of it. Returns the speed it hit with, or 0 */
function hitCircle(b: Ball, c: Circle, bounce: number, kick: number): number {
  let nx = b.x - c.x
  let ny = b.y - c.y
  const d = Math.hypot(nx, ny)
  const min = PINBALL.ballR + c.r
  if (d >= min || d === 0) return 0
  nx /= d
  ny /= d
  b.x = c.x + nx * min
  b.y = c.y + ny * min
  const vn = b.vx * nx + b.vy * ny
  if (vn >= 0) return 0
  b.vx -= (1 + bounce) * vn * nx - kick * nx
  b.vy -= (1 + bounce) * vn * ny - kick * ny
  return -vn
}

function moveFlippers(s: PinballState, input: PinballInput, h: number): void {
  const held = [input.left, input.right]
  for (const i of [0, 1] as const) {
    const f = s.flippers[i]
    const spec = TABLE.flippers[i]
    const target = held[i] ? spec.up : spec.rest
    const speed = held[i] ? PINBALL.flipperUpSpeed : PINBALL.flipperDownSpeed
    const delta = Math.max(-speed * h, Math.min(speed * h, target - f.angle))
    f.angle += delta
    f.omega = delta / h
  }
}

function lose(s: PinballState): void {
  s.balls -= 1
  if (s.balls <= 0) {
    s.phase = 'over'
    s.balls = 0
  }
  s.ball = onPlungerBall()
  s.onPlunger = true
  s.power = 0
  s.inLane = false
}

/** one substep of the ball: gravity, then every part of the table it touches */
function moveBall(s: PinballState, h: number): void {
  const b = s.ball
  b.vy += PINBALL.gravity * h
  b.x += b.vx * h
  b.y += b.vy * h

  for (const w of TABLE.walls) hitSegment(b, w, 0, PINBALL.wallBounce)
  TABLE.targets.forEach((t, i) => {
    if (hitSegment(b, t, 0, PINBALL.wallBounce) < PINBALL.targetMinSpeed) return
    s.score += PINBALL.targetPoints
    s.lit[i] = true
    s.flash.targets[i] = PINBALL.flashFor
    if (s.lit[0] && s.lit[1]) {
      s.score += PINBALL.targetsBonus
      s.lit = [false, false]
    }
  })
  for (const p of TABLE.posts) hitCircle(b, p, PINBALL.wallBounce, 0)
  TABLE.bumpers.forEach((c, i) => {
    if (hitCircle(b, c, PINBALL.bumperBounce, PINBALL.bumperKick) === 0) return
    s.score += PINBALL.bumperPoints
    s.flash.bumpers[i] = PINBALL.flashFor
  })
  for (const i of [0, 1] as const) {
    const spec = TABLE.flippers[i]
    const f = s.flippers[i]
    const tip = flipperTip(i, f.angle)
    // a point of a flipper turning at omega moves at omega × its arm, at right angles to it
    hitSegment(b, seg(spec.x, spec.y, tip.x, tip.y), PINBALL.flipperR, PINBALL.flipperBounce, (x, y) => ({
      x: -f.omega * (y - spec.y),
      y: f.omega * (x - spec.x)
    }))
  }

  const speed = Math.hypot(b.vx, b.vy)
  if (speed > PINBALL.maxSpeed) {
    b.vx *= PINBALL.maxSpeed / speed
    b.vy *= PINBALL.maxSpeed / speed
  }

  const l = TABLE.lane
  const inLane = b.x >= l.x0 && b.x <= l.x1 && b.y >= l.y0 && b.y <= l.y1
  if (inLane && !s.inLane) {
    s.score += PINBALL.lanePoints
    s.flash.lane = PINBALL.flashFor
  }
  s.inLane = inLane
}

/** one fixed step: the flippers and the ball in substeps, the plunger, a drain, a ball back in the lane */
function tick(s: PinballState, input: PinballInput): void {
  const h = PINBALL.step / PINBALL.substeps
  s.flash.bumpers = s.flash.bumpers.map((t) => Math.max(0, t - PINBALL.step))
  s.flash.targets = s.flash.targets.map((t) => Math.max(0, t - PINBALL.step))
  s.flash.lane = Math.max(0, s.flash.lane - PINBALL.step)
  for (let i = 0; i < PINBALL.substeps; i++) {
    moveFlippers(s, input, h)
    if (s.onPlunger) continue
    moveBall(s, h)
    if (s.ball.y > PINBALL.height + PINBALL.ballR) {
      lose(s)
      return
    }
  }
  if (s.onPlunger) {
    if (input.plunger) s.power = Math.min(1, s.power + PINBALL.step / PINBALL.plungerFill)
    else if (s.power > 0) {
      s.ball = { x: PLUNGER.x, y: PLUNGER.y, vx: 0, vy: -launchSpeed(s.power) }
      s.onPlunger = false
      s.power = 0
    }
    return
  }
  // a weak launch falls back down the lane: once it settles, it waits on the plunger again
  const b = s.ball
  if (b.x > TABLE.laneX && b.y > PLUNGER.y - 5 && Math.abs(b.vy) < 30 && Math.abs(b.vx) < 30) {
    s.ball = onPlungerBall()
    s.onPlunger = true
  }
}

function copy(s: PinballState): PinballState {
  return {
    ...s,
    ball: { ...s.ball },
    flippers: [{ ...s.flippers[0] }, { ...s.flippers[1] }],
    lit: [s.lit[0], s.lit[1]],
    flash: { bumpers: [...s.flash.bumpers], targets: [...s.flash.targets], lane: s.flash.lane }
  }
}

/** advances a game by dt seconds in fixed steps; a game not in play is returned as it is */
export function step(s: PinballState, input: PinballInput, dt: number): PinballState {
  if (s.phase !== 'play') return s
  const next = copy(s)
  next.acc += Math.min(PINBALL.maxDt, Math.max(0, dt))
  while (next.acc >= PINBALL.step - EPSILON && next.phase === 'play') {
    next.acc -= PINBALL.step
    tick(next, input)
  }
  if (next.phase !== 'play') next.acc = 0
  return next
}
