import { describe, expect, it } from 'vitest'
import { ARTILLERY, DEPLOY, FORK, SHOTS } from '../../src/renderer/games/artillery-config'
import {
  aimVector,
  deployBombs,
  dynamite,
  effect,
  hurt,
  impactOf,
  launch,
  pingRay,
  shotStep
} from '../../src/renderer/games/artillery-shots'
import type { Fighter, Ground, Impact, Shot, ShotKind } from '../../src/renderer/games/artillery-types'
import { emptyGround, fill, fighter, flatGround } from './artillery-fixtures'

const DT = ARTILLERY.step
const WATER = ARTILLERY.water

/** a shot of kind at (x, y) moving at (vx, vy), fired by owner */
function shot(kind: ShotKind, x: number, y: number, vx = 0, vy = 0, owner = 0): Shot {
  return { kind, x, y, vx, vy, fuse: SHOTS[kind].fuse, resting: false, owner, age: 0 }
}

/** steps s until it goes off or leaves, at most `seconds`: the impact (null when it left), the shots it spawned and its age then */
function flyUntilGone(g: Ground, fighters: Fighter[], s: Shot, wind = 0, seconds = 20) {
  const spawn: Shot[] = []
  for (let i = 0; i < seconds / DT; i++) {
    const r = shotStep(g, fighters, s, wind, WATER, DT)
    spawn.push(...r.spawn)
    if (r.gone) return { impact: r.impact, spawn, age: s.age }
  }
  throw new Error('the shot never went off')
}

describe('launch and aim', () => {
  it('aim 0 is level on the side the fighter faces, +90 is up', () => {
    expect(aimVector(fighter('clawd', 100, 99), 0)).toEqual({ dx: 1, dy: -0 })
    expect(aimVector(fighter('bug', 100, 99), 0).dx).toBe(-1)
    expect(aimVector(fighter('clawd', 100, 99), 90).dy).toBeCloseTo(-1, 9)
  })

  it('launch starts at the muzzle along the aim, at the speed the power gives', () => {
    const f = fighter('clawd', 100, 99)
    const up = launch('rocket', f, 0, 90, 1)
    expect(up.x).toBeCloseTo(100, 6)
    expect(up.y).toBeCloseTo(99 - 5 - ARTILLERY.muzzle, 6)
    expect(up.vy).toBeCloseTo(-ARTILLERY.maxSpeed, 6)
    expect(up.vx).toBeCloseTo(0, 6)
    const level = launch('grenade', f, 0, 0, 0)
    expect(level.x).toBeCloseTo(100 + ARTILLERY.muzzle, 6)
    expect(level.y).toBeCloseTo(94, 6)
    expect(level.vx).toBeCloseTo(ARTILLERY.minSpeed, 6)
    expect(level.fuse).toBe(SHOTS.grenade.fuse)
  })
})

describe('shots in flight', () => {
  it('a rocket follows gravity and the wind', () => {
    const g = emptyGround()
    const still = shot('rocket', 100, 20)
    const windy = shot('rocket', 100, 20)
    for (let i = 0; i < 1 / DT; i++) {
      shotStep(g, [], still, 0, WATER, DT)
      shotStep(g, [], windy, 50, WATER, DT)
    }
    expect(still.vy).toBeCloseTo(150, 0)
    expect(windy.x).toBeGreaterThan(still.x)
  })

  it('a rocket explodes where it touches the ground', () => {
    const { impact } = flyUntilGone(flatGround(100), [], shot('rocket', 100, 50, 0, 100))
    expect(impact?.x).toBe(100)
    expect(impact?.y).toBeGreaterThanOrEqual(99)
    expect(impact?.y).toBeLessThanOrEqual(101)
    expect(impact).toMatchObject({ radius: 14, damage: 45 })
  })

  it('a rocket explodes on a fighter', () => {
    const fighters = [fighter('clawd', 100, 99), fighter('bug', 200, 99)]
    const { impact } = flyUntilGone(emptyGround(), fighters, shot('rocket', 150, 94, 200, 0, 0))
    expect(impact?.x).toBeGreaterThanOrEqual(194)
    expect(impact?.x).toBeLessThanOrEqual(205)
  })

  it('a grenade bounces, ignores the wind and explodes 3 s after the throw', () => {
    const g = flatGround(100)
    const s = shot('grenade', 100, 50)
    let steps = 0
    while (s.vy >= 0 && steps++ < 1000) shotStep(g, [], s, 50, WATER, DT)
    expect(s.vy).toBeLessThan(0)
    expect(s.x).toBe(100)
    const { impact, age } = flyUntilGone(g, [], s, 50)
    expect(impact).not.toBeNull()
    expect(age).toBeGreaterThanOrEqual(2.99)
    expect(age).toBeLessThanOrEqual(3.02)
    expect(s.x).toBe(100)
  })

  it('a fork bomb splits into five bomblets that explode on touch', () => {
    const g = flatGround(100)
    const { impact, spawn } = flyUntilGone(g, [], shot('fork', 100, 50, 0, 100))
    expect(impact).not.toBeNull()
    expect(spawn).toHaveLength(FORK.bomblets)
    for (const b of spawn) expect(b.vy).toBeLessThan(0)
    const hit = flyUntilGone(g, [], spawn[0])
    expect(hit.impact).toMatchObject({ radius: 8, damage: 15 })
  })

  it('dynamite falls, rests and explodes after 4 s', () => {
    const g = flatGround(100)
    const owner = fighter('clawd', 100, 99)
    const s = dynamite(owner, 0)
    const { impact, age } = flyUntilGone(g, [owner], s)
    expect(s.resting).toBe(true)
    expect(s.x).toBe(100)
    expect(age).toBeGreaterThanOrEqual(3.99)
    expect(age).toBeLessThanOrEqual(4.02)
    expect(impact).toMatchObject({ radius: 30, damage: 70 })
  })

  it('deploy drops three bombs 12 px apart that drift with the wind', () => {
    const bombs = deployBombs(300, 3)
    expect(bombs.map((b) => b.x)).toEqual([288, 300, 312])
    for (const b of bombs) expect(b.y).toBe(DEPLOY.y)
    for (const b of bombs) {
      const start = b.x
      const { impact } = flyUntilGone(flatGround(100), [], b, 50)
      expect(impact?.x).toBeGreaterThan(start)
    }
  })

  it('a shot leaving through a side is gone; one above the top comes back down', () => {
    const left = flyUntilGone(emptyGround(), [], shot('rocket', 5, 50, -300, 0))
    expect(left.impact).toBeNull()
    const s = shot('rocket', 400, 5, 0, -200)
    let highest = s.y
    for (let i = 0; i < 1.5 / DT; i++) {
      expect(shotStep(flatGround(100), [], s, 0, WATER, DT).gone).toBe(false)
      highest = Math.min(highest, s.y)
    }
    expect(highest).toBeLessThan(0)
    const back = flyUntilGone(flatGround(100), [], s)
    expect(back.impact?.y).toBeGreaterThanOrEqual(99)
    expect(back.impact?.y).toBeLessThanOrEqual(101)
  })

  it('a shot touching the water sinks without exploding', () => {
    const s = shot('rocket', 100, 100, 0, 50)
    const { impact } = flyUntilGone(emptyGround(), [], s)
    expect(impact).toBeNull()
    expect(s.y).toBeGreaterThanOrEqual(WATER - 0.5)
  })

  it('no shot passes a 1-px wall at the top speed', () => {
    const g = fill(emptyGround(), 300, 0, 300, ARTILLERY.height - 1)
    const { impact } = flyUntilGone(g, [], shot('rocket', 250, 80, 300, 0))
    expect(impact?.x).toBeGreaterThanOrEqual(299)
    expect(impact?.x).toBeLessThanOrEqual(300)
  })
})

describe('explosions and hits', () => {
  // a rocket's blast at (100, 100): radius 14, reach 21 cells
  const blast: Impact = impactOf('rocket', 100, 100)

  it('an explosion hurts less with distance, nothing beyond its reach, and pushes away', () => {
    const centre = effect(fighter('bug', 100, 105), blast)
    expect(centre?.damage).toBe(45)
    expect(centre?.vy).toBeLessThan(0)

    const half = effect(fighter('bug', 110.5, 105), blast)
    expect(half?.damage).toBeGreaterThanOrEqual(22)
    expect(half?.damage).toBeLessThanOrEqual(23)
    expect(Math.sign(half?.vx ?? 0)).toBe(1)
    expect(half?.vy).toBeLessThan(0)

    const left = effect(fighter('bug', 89.5, 105), blast)
    expect(Math.sign(left?.vx ?? 0)).toBe(-1)

    expect(effect(fighter('bug', 121, 105), blast)).toBeNull()
  })

  it('hurt applies damage and push to everyone in reach and returns them', () => {
    const fighters = [
      fighter('clawd', 100, 105),
      fighter('bug', 120, 105),
      fighter('bug', 300, 105),
      fighter('bug', 100, 105, { out: true })
    ]
    const hit = hurt(fighters, blast)
    expect(hit).toEqual([0, 1])
    expect(fighters[0].hp).toBe(ARTILLERY.hp - 45)
    expect(fighters[0].air).toBe(true)
    expect(fighters[0].fallFrom).toBe(105)
    expect(fighters[0].vy).toBeLessThan(0)
    expect(fighters[2].hp).toBe(ARTILLERY.hp)
    expect(fighters[2].air).toBe(false)
    expect(fighters[3].hp).toBe(ARTILLERY.hp)
  })
})

describe('ping', () => {
  it('ping hits the first fighter or ground on its line, and nothing beyond its range', () => {
    const shooter = fighter('clawd', 50, 99)
    const target = fighter('bug', 200, 99)
    const hitFighter = pingRay(emptyGround(), [shooter, target], 0, 0)
    expect(hitFighter?.x).toBeGreaterThanOrEqual(194)
    expect(hitFighter?.x).toBeLessThanOrEqual(205)
    expect(hitFighter).toMatchObject({ radius: 5, damage: 20, push: 180 })

    const wall = fill(emptyGround(), 150, 90, 150, 100)
    expect(pingRay(wall, [shooter], 0, 0)?.x).toBe(150)

    expect(pingRay(fill(emptyGround(), 400, 90, 400, 100), [shooter], 0, 0)).toBeNull()
    expect(pingRay(emptyGround(), [shooter], 0, 0)).toBeNull()
  })
})
