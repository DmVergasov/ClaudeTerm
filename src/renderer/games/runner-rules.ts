/** the runner's field, in field pixels; y is measured up from the ground */
export const RUNNER = {
  width: 300,
  clawdX: 24,
  clawdW: 36,
  clawdH: 20,
  duckH: 16,
  gravity: 2000,
  jumpSpeed: 640,
  startSpeed: 200,
  maxSpeed: 480,
  speedPerPoint: 0.5,
  maxDt: 0.05,
  flyersFrom: 100
} as const

export type ObstacleKind = 'bracket' | 'braces' | 'parens' | 'bug' | 'null'

/** the box of each obstacle kind: w wide, h tall, its bottom at y above the ground */
export const OBSTACLES: Record<ObstacleKind, { w: number; h: number; y: number }> = {
  bracket: { w: 14, h: 24, y: 0 },
  braces: { w: 28, h: 24, y: 0 },
  parens: { w: 28, h: 24, y: 0 },
  bug: { w: 14, h: 10, y: 0 },
  null: { w: 30, h: 12, y: 17 }
}

/** the ground kinds, one of them picked in equal shares */
const GROUND_KINDS: ObstacleKind[] = ['bracket', 'braces', 'parens', 'bug']

export interface Obstacle {
  kind: ObstacleKind
  x: number
}

export type RunnerPhase = 'ready' | 'running' | 'over'

export interface RunnerState {
  phase: RunnerPhase
  y: number
  vy: number
  ducking: boolean
  distance: number
  score: number
  speed: number
  /** the distance to the next obstacle, rolled when an obstacle spawns */
  gap: number
  obstacles: Obstacle[]
  frame: number
}

/** jump: pressed this frame (edge); duck: held */
export interface RunnerInput {
  jump: boolean
  duck: boolean
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** a new run, waiting to be started */
export function newRun(): RunnerState {
  return {
    phase: 'ready',
    y: 0,
    vy: 0,
    ducking: false,
    distance: 0,
    score: 0,
    speed: RUNNER.startSpeed,
    gap: 0,
    obstacles: [],
    frame: 0
  }
}

/** a fresh running state; a run that is already running is returned as it is */
export function start(s: RunnerState): RunnerState {
  if (s.phase === 'running') return s
  return { ...newRun(), phase: 'running' }
}

function clawdBox(y: number, ducking: boolean): Box {
  return { x: RUNNER.clawdX, y, w: RUNNER.clawdW, h: ducking ? RUNNER.duckH : RUNNER.clawdH }
}

/** Clawd's box in field pixels */
export function hitBox(s: RunnerState): Box {
  return clawdBox(s.y, s.ducking)
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** a new obstacle at the right edge; a flyer only from flyersFrom points, a quarter of the time */
function spawn(score: number, rand: () => number): Obstacle {
  if (score >= RUNNER.flyersFrom && rand() < 0.25) return { kind: 'null', x: RUNNER.width }
  const kind = GROUND_KINDS[Math.floor(rand() * GROUND_KINDS.length)]
  return { kind, x: RUNNER.width }
}

/** advances a running run by dt seconds (clamped); returns the same state when the run is not running */
export function step(s: RunnerState, input: RunnerInput, dt: number, rand: () => number): RunnerState {
  if (s.phase !== 'running') return s
  const t = Math.min(dt, RUNNER.maxDt)

  const onGround = s.y === 0
  let vy = s.vy
  let ducking = false
  if (onGround && input.jump) vy = RUNNER.jumpSpeed
  else if (onGround) ducking = input.duck

  vy -= RUNNER.gravity * t
  let y = s.y + vy * t
  if (y <= 0) {
    y = 0
    vy = 0
  }

  const move = s.speed * t
  const obstacles = s.obstacles
    .map((o) => ({ kind: o.kind, x: o.x - move }))
    .filter((o) => o.x + OBSTACLES[o.kind].w >= 0)
  const distance = s.distance + move
  const score = Math.floor(distance / 10)
  const speed = Math.min(RUNNER.maxSpeed, RUNNER.startSpeed + RUNNER.speedPerPoint * score)

  const last = obstacles[obstacles.length - 1]
  let gap = s.gap
  if (!last || last.x < RUNNER.width - gap) {
    gap = speed * (0.8 + 0.8 * rand())
    obstacles.push(spawn(score, rand))
  }

  const box = clawdBox(y, ducking)
  const hit = obstacles.some((o) => {
    const shape = OBSTACLES[o.kind]
    return overlaps(box, { x: o.x, y: shape.y, w: shape.w, h: shape.h })
  })

  return {
    phase: hit ? 'over' : 'running',
    y,
    vy,
    ducking,
    distance,
    score,
    speed,
    gap,
    obstacles,
    frame: s.frame + 1
  }
}
