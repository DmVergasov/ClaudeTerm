import { describe, expect, it } from 'vitest'
import { ARTILLERY } from '../../src/renderer/games/artillery-config'
import { airStep, bodyFree, drillStep, fallDamage, grounded, jump, teleportOk, walk } from '../../src/renderer/games/artillery-bodies'
import { clearDisc } from '../../src/renderer/games/artillery-ground'
import type { Disc, Fighter } from '../../src/renderer/games/artillery-types'
import { emptyGround, fighter, fill, flatGround } from './artillery-fixtures'

const STEP = ARTILLERY.step
const WATER = ARTILLERY.water

/** clears the cells of rows y0 … y1, the whole width */
function clearRows(g: ReturnType<typeof flatGround>, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) g.cells.fill(0, y * g.w, (y + 1) * g.w)
}

/** runs `n` walk steps in direction dir */
function walkSteps(g: ReturnType<typeof flatGround>, f: Fighter, dir: -1 | 1, n: number): void {
  for (let i = 0; i < n; i++) walk(g, f, dir, STEP)
}

describe('bodies', () => {
  it('a fighter walks on flat ground at walkSpeed', () => {
    const g = flatGround(100)
    const f = fighter('clawd', 100, 99)
    walkSteps(g, f, 1, 120)
    expect(f.x).toBe(130)
    expect(f.y).toBe(99)
    expect(f.facing).toBe(1)
  })

  it('a fighter climbs a 3-px step but not a 4-px one', () => {
    const three = fill(flatGround(100), 120, 97, 200, 99)
    const f3 = fighter('clawd', 100, 99)
    walkSteps(three, f3, 1, 240)
    expect(f3.x).toBeGreaterThan(125)
    expect(f3.y).toBe(96)

    const four = fill(flatGround(100), 120, 96, 200, 99)
    const f4 = fighter('clawd', 100, 99)
    walkSteps(four, f4, 1, 240)
    expect(f4.x).toBe(114)
    expect(f4.y).toBe(99)
  })

  it('a step down of up to 3 px keeps it on the ground', () => {
    const g = fill(fill(emptyGround(), 0, 100, 119, 159), 120, 102, 827, 159)
    const f = fighter('clawd', 110, 99)
    walkSteps(g, f, 1, 120)
    expect(f.air).toBe(false)
    expect(f.y).toBe(101)
  })

  it('walking off a ledge starts a fall', () => {
    const g = fill(flatGround(140), 0, 100, 119, 139)
    const f = fighter('clawd', 100, 99)
    walkSteps(g, f, 1, 120)
    expect(f.air).toBe(true)
  })

  it('airStep lands a falling fighter and reports the fall', () => {
    const g = flatGround(100)
    const f = fighter('clawd', 100, 40, { air: true, fallFrom: 40 })
    let last = { landed: false, fall: 0 }
    for (let n = 0; f.air && n < 2000; n++) last = airStep(g, f, STEP, WATER)
    expect(f.air).toBe(false)
    expect(f.y).toBe(99)
    expect(last.landed).toBe(true)
    expect(last.fall).toBe(59)
  })

  it('fall damage: none at fallSafe, half a point per px above it', () => {
    expect(fallDamage(ARTILLERY.fallSafe)).toBe(0)
    expect(fallDamage(50)).toBe(10)
  })

  it('a jump goes forward and up and lands without damage', () => {
    const g = flatGround(100)
    const f = fighter('clawd', 100, 99)
    jump(g, f)
    expect(f.air).toBe(true)
    let last = { landed: false, fall: 0 }
    for (let n = 0; f.air && n < 2000; n++) last = airStep(g, f, STEP, WATER)
    expect(f.air).toBe(false)
    expect(f.x).toBeGreaterThanOrEqual(135)
    expect(f.x).toBeLessThanOrEqual(150)
    expect(f.y).toBe(99)
    expect(fallDamage(last.fall)).toBe(0)
  })

  it('the map\'s sides stop a fighter, walking or flying', () => {
    const g = flatGround(100)
    const walker = fighter('clawd', 8, 99)
    walkSteps(g, walker, -1, 120)
    expect(walker.x).toBe(6)

    const flyer = fighter('clawd', 10, 99, { air: true, vx: -200, fallFrom: 99 })
    for (let n = 0; flyer.air && n < 2000; n++) airStep(g, flyer, STEP, WATER)
    expect(flyer.x).toBeGreaterThanOrEqual(6)
  })

  it('water takes a fighter out', () => {
    const g = emptyGround()
    const f = fighter('clawd', 100, 100, { air: true, fallFrom: 100 })
    for (let n = 0; !f.out && n < 2000; n++) airStep(g, f, STEP, WATER)
    expect(f.out).toBe(true)
    expect(f.hp).toBe(0)
    expect(f.y).toBeGreaterThanOrEqual(148)
  })

  it('drillStep moves the fighter along and returns discs to clear', () => {
    const f = fighter('clawd', 100, 99, { drill: { dx: 1, dy: 0, left: 40 } })
    const discs: Disc[] = []
    for (let n = 0; n < Math.round((ARTILLERY.drillTime + 0.1) / STEP); n++) discs.push(...drillStep(f, STEP))
    expect(f.x).toBe(140)
    expect(f.drill).toBeNull()
    expect(discs).toHaveLength(40)
    for (const d of discs) {
      expect(d.r).toBe(ARTILLERY.drillRadius)
      expect(d.r).toBe(8)
      expect(d.y).toBe(94)
    }
  })

  it('a fighter walks along a covered tunnel', () => {
    const g = flatGround(100)
    fill(g, 0, 80, ARTILLERY.width - 1, 84)
    clearRows(g, 85, 99)
    const f = fighter('clawd', 100, 99)
    walkSteps(g, f, 1, 120)
    expect(f.x).toBe(130)
    expect(f.y).toBe(99)
    expect(f.air).toBe(false)
  })

  it('walking under an overhang works', () => {
    const g = fill(flatGround(100), 0, 80, 300, 88)
    const f = fighter('clawd', 100, 99)
    walkSteps(g, f, 1, 120)
    expect(f.x).toBe(130)
    expect(f.y).toBe(99)
  })

  it('a step down off a ledge under a roof starts a fall', () => {
    const g = fill(fill(flatGround(140), 0, 100, 119, 139), 0, 80, 200, 89)
    const f = fighter('clawd', 100, 99)
    walkSteps(g, f, 1, 120)
    expect(f.air).toBe(true)
    expect(f.fallFrom).toBe(99)
  })

  it('a bounce is not a landing: landed only when the fighter comes to rest', () => {
    const g = flatGround(100)
    const f = fighter('clawd', 100, 40, { air: true, fallFrom: 40 })
    let bounce = { landed: true, fall: -1 }
    for (let n = 0; f.vy >= 0 && f.air && n < 2000; n++) bounce = airStep(g, f, STEP, WATER)
    expect(f.air).toBe(true)
    expect(f.vy).toBeLessThan(0)
    expect(f.y).toBe(99)
    expect(bounce).toEqual({ landed: false, fall: 0 })

    let rest = { landed: false, fall: 0 }
    for (let n = 0; f.air && n < 2000; n++) rest = airStep(g, f, STEP, WATER)
    expect(f.air).toBe(false)
    expect(rest.landed).toBe(true)
    expect(rest.fall).toBe(59)
  })

  it('a downward drill leaves the box free once its discs are cleared', () => {
    const g = flatGround(100)
    const f = fighter('clawd', 100, 99, { drill: { dx: 0, dy: 1, left: 40 } })
    for (let n = 0; n < 400; n++) {
      for (const d of drillStep(f, STEP)) clearDisc(g, d.x, d.y, d.r)
    }
    expect(f.y).toBe(139)
    expect(bodyFree(g, f.x, f.y)).toBe(true)
  })

  it('teleportOk takes a free box above the water: rock, the water line and the sides are refused', () => {
    const open = emptyGround()
    expect(teleportOk(flatGround(100), WATER, 200, 90)).toBe(true)
    expect(teleportOk(flatGround(100), WATER, 200, 110)).toBe(false)
    expect(teleportOk(open, WATER, 200, WATER - 3)).toBe(true)
    expect(teleportOk(open, WATER, 200, WATER - 2)).toBe(false)
    expect(teleportOk(open, WATER, 5, 90)).toBe(false)
    expect(teleportOk(open, WATER, ARTILLERY.width - 4, 90)).toBe(false)
  })

  it('grounded is true only with ground under the box', () => {
    const g = flatGround(100)
    expect(grounded(g, fighter('clawd', 100, 99))).toBe(true)
    expect(grounded(g, fighter('clawd', 100, 98))).toBe(false)
  })
})
