import { describe, expect, it } from 'vitest'
import { feet, groundY, LANDER, landingPoints, levelSpec, makeTerrain, newRun, start, step, touchdown } from '../../src/renderer/games/lander-rules'
import type { LanderInput, LanderState, Terrain } from '../../src/renderer/games/lander-rules'
import { seeded } from '../../src/renderer/games/random'

const idle: LanderInput = { thrust: false, left: false, right: false }
const thrust: LanderInput = { thrust: true, left: false, right: false }

/** flat ground at y 180 from wall to wall, the pad from x 100 to 160 */
const FLAT: Terrain = {
  points: [
    { x: 0, y: 180 },
    { x: 100, y: 180 },
    { x: 160, y: 180 },
    { x: 300, y: 180 }
  ],
  padX0: 100,
  padX1: 160,
  padY: 180
}

/** a flying craft over FLAT, high up and still, with no wind, unless told otherwise */
function flying(over: Partial<LanderState> = {}): LanderState {
  return { ...start(newRun(1)), terrain: FLAT, wind: 0, x: 130, y: 60, vx: 0, vy: 0, angle: 0, fuel: 100, ...over }
}

/** the craft just above FLAT at x, its lower foot a hair over the ground, moving as given */
function justAbove(x: number, vx: number, vy: number, angle: number): LanderState {
  const s = flying({ x, vx, vy, angle })
  const lowest = Math.max(...feet(s).map((f) => f.y))
  return { ...s, y: s.y + (180 - lowest) - 0.05 }
}

/** steps a state in 1/120 s frames for `seconds` */
function run(s: LanderState, input: LanderInput, seconds: number): LanderState {
  for (let i = 0; i < Math.round(seconds * 120); i++) s = step(s, input, 1 / 120)
  return s
}

describe('lander rules', () => {
  it('a run waits until it is started; after a crash it starts over at level 1', () => {
    const ready = newRun(5)
    expect(ready.phase).toBe('ready')
    expect(step(ready, thrust, 0.1)).toBe(ready)
    expect(start(ready).phase).toBe('flying')

    const crashed: LanderState = { ...flying({ level: 4, score: 900 }), phase: 'crashed' }
    const again = start(crashed)
    expect(again.phase).toBe('flying')
    expect(again.level).toBe(1)
    expect(again.score).toBe(0)
    expect(again.fuel).toBe(levelSpec(1).fuel)
  })

  it('gravity pulls the craft down: its vertical speed grows by gravity × time', () => {
    const s = run(flying(), idle, 1)
    expect(s.vy).toBeCloseTo(LANDER.gravity, 5)
    expect(s.y).toBeGreaterThan(60 + LANDER.gravity * 0.45)
    expect(s.vx).toBe(0)
  })

  it('thrust burns fuel and pushes along the craft\'s axis', () => {
    const up = run(flying(), thrust, 0.5)
    expect(up.fuel).toBeCloseTo(100 - LANDER.burn * 0.5, 5)
    expect(up.vy).toBeCloseTo((LANDER.gravity - LANDER.thrust) * 0.5, 5)
    expect(up.thrusting).toBe(true)

    const sideways = run(flying({ angle: 90 }), thrust, 0.5)
    expect(sideways.vx).toBeCloseTo(LANDER.thrust * 0.5, 5)
    expect(sideways.vy).toBeCloseTo(LANDER.gravity * 0.5, 5)
  })

  it('with no fuel there is no thrust', () => {
    const s = run(flying({ fuel: 0 }), thrust, 0.5)
    expect(s.fuel).toBe(0)
    expect(s.thrusting).toBe(false)
    expect(s.vy).toBeCloseTo(LANDER.gravity * 0.5, 5)
  })

  it('the arrows turn the craft, up to 90° either way', () => {
    expect(run(flying(), { ...idle, right: true }, 0.25).angle).toBeCloseTo(LANDER.turnRate * 0.25, 5)
    expect(run(flying(), { ...idle, left: true }, 0.25).angle).toBeCloseTo(-LANDER.turnRate * 0.25, 5)
    expect(run(flying(), { ...idle, right: true }, 3).angle).toBe(LANDER.maxAngle)
    expect(run(flying(), { ...idle, left: true }, 3).angle).toBe(-LANDER.maxAngle)
  })

  it('a touchdown on the pad just within every limit at once is a landing', () => {
    const s = run(justAbove(130, LANDER.safeVx - 0.5, LANDER.safeVy - 0.5, LANDER.safeAngle - 0.5), idle, 0.05)
    expect(s.phase).toBe('landed')
    expect(s.vx).toBe(0)
    expect(s.vy).toBe(0)
    expect(feet(s).every((f) => Math.abs(f.y - 180) < 0.01)).toBe(true)
  })

  it('just past any one limit, the touchdown is a crash', () => {
    const fine = { vx: 0, vy: 5, angle: 0 }
    for (const past of [{ vy: LANDER.safeVy + 0.5 }, { vx: LANDER.safeVx + 0.5 }, { vx: -LANDER.safeVx - 0.5 }, { angle: LANDER.safeAngle + 0.5 }, { angle: -LANDER.safeAngle - 0.5 }]) {
      const m = { ...fine, ...past }
      expect(run(justAbove(130, m.vx, m.vy, m.angle), idle, 0.05).phase, JSON.stringify(past)).toBe('crashed')
    }
  })

  it('a slow, upright touch with a foot off the pad is a crash', () => {
    // the left foot is at x 130 - 11 - 30 = 89, left of the pad's start at 100
    expect(run(justAbove(130 - 30, 0, 5, 0), idle, 0.05).phase).toBe('crashed')
    expect(run(justAbove(130, 0, 5, 0), idle, 0.05).phase).toBe('landed')
  })

  it('the hull touching the ground is a crash, even over the pad', () => {
    // a peak right under the craft, between its feet; the pad covers the whole field
    const peak: Terrain = {
      points: [{ x: 0, y: 180 }, { x: 115, y: 180 }, { x: 130, y: 160 }, { x: 145, y: 180 }, { x: 300, y: 180 }],
      padX0: 0,
      padX1: 300,
      padY: 180
    }
    let s = flying({ terrain: peak, y: 160 - LANDER.hullR - 1, vy: 5 })
    expect(feet(s).every((f) => f.y < groundY(peak, f.x))).toBe(true)
    s = run(s, idle, 0.5)
    expect(s.phase).toBe('crashed')
    expect(touchdown(s)).toBe('crashed')
  })

  it('a landing scores 100 × level + 2 × the fuel left, and the next level starts 1.5 s later', () => {
    const landed = run({ ...justAbove(130, 0, 5, 0), fuel: 50 }, idle, 0.05)
    expect(landed.phase).toBe('landed')
    expect(landed.score).toBe(landingPoints(1, 50))
    expect(landingPoints(1, 50)).toBe(200)
    expect(landingPoints(3, 20.4)).toBe(340)

    const still = run(landed, idle, 1.4)
    expect(still.phase).toBe('landed')
    const next = run(landed, idle, 1.6)
    expect(next.phase).toBe('flying')
    expect(next.level).toBe(2)
    expect(next.score).toBe(200)
    expect(next.fuel).toBe(levelSpec(2).fuel)
    expect(next.y).toBeLessThan(LANDER.startY + 5)
  })

  it('each level is harder: a narrower pad, rougher ground, less fuel, and wind from level 3', () => {
    const specs = [1, 2, 3, 4, 5].map(levelSpec)
    for (let i = 1; i < specs.length; i++) {
      expect(specs[i].padWidth).toBeLessThan(specs[i - 1].padWidth)
      expect(specs[i].roughness).toBeGreaterThan(specs[i - 1].roughness)
      expect(specs[i].fuel).toBeLessThan(specs[i - 1].fuel)
    }
    expect(specs[0].windMax).toBe(0)
    expect(specs[1].windMax).toBe(0)
    expect(specs[2].windMax).toBeGreaterThan(0)
    // the pad is never narrower than the craft's feet allow, and fuel never runs out entirely
    expect(levelSpec(50).padWidth).toBeGreaterThan(2 * LANDER.footX + 4)
    expect(levelSpec(50).fuel).toBeGreaterThan(0)
  })

  it('a level\'s ground runs wall to wall with one flat pad of the level\'s width, inside the field', () => {
    for (const level of [1, 4, 9]) {
      const spec = levelSpec(level)
      const t = makeTerrain(spec, seeded(level * 31).next)
      expect(t.points[0].x).toBe(0)
      expect(t.points[t.points.length - 1].x).toBe(LANDER.width)
      expect(t.padX1 - t.padX0).toBe(spec.padWidth)
      expect(groundY(t, t.padX0)).toBe(t.padY)
      expect(groundY(t, (t.padX0 + t.padX1) / 2)).toBe(t.padY)
      expect(groundY(t, t.padX1)).toBe(t.padY)
      for (let i = 1; i < t.points.length; i++) expect(t.points[i].x).toBeGreaterThan(t.points[i - 1].x)
      for (const p of t.points) {
        expect(p.y).toBeGreaterThanOrEqual(LANDER.groundTop)
        expect(p.y).toBeLessThanOrEqual(LANDER.groundBottom)
      }
    }
  })

  it('wind pushes the craft sideways', () => {
    const s = run(flying({ wind: 4 }), idle, 1)
    expect(s.vx).toBeCloseTo(4, 5)
  })

  it('the same seed makes the same level, another seed another', () => {
    expect(newRun(42)).toEqual(newRun(42))
    expect(newRun(42).terrain).not.toEqual(newRun(43).terrain)
  })

  it('a long frame steps the same as many short ones', () => {
    const input: LanderInput = { thrust: true, left: false, right: true }
    const long = step(flying({ vx: 3 }), input, 0.1)
    const short = run(flying({ vx: 3 }), input, 0.1)
    expect(long.x).toBeCloseTo(short.x, 6)
    expect(long.y).toBeCloseTo(short.y, 6)
    expect(long.fuel).toBeCloseTo(short.fuel, 6)
  })

  it('a frame longer than 0.1 s steps only 0.1 s', () => {
    expect(step(flying(), thrust, 5)).toEqual(step(flying(), thrust, 0.1))
  })

  it('the sides of the field stop the craft', () => {
    const s = run(flying({ x: 20, vx: -80 }), idle, 1)
    expect(s.x).toBe(LANDER.footX + 1)
    expect(s.vx).toBe(0)
  })

  it('a step leaves the state it was given as it was', () => {
    const s = flying({ vx: 5 })
    const before = structuredClone(s)
    step(s, { thrust: true, left: true, right: false }, 0.1)
    expect(s).toEqual(before)
  })
})
