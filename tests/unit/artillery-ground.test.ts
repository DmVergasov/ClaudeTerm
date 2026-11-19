import { describe, expect, it } from 'vitest'
import { ARTILLERY, botErrorScale } from '../../src/renderer/games/artillery-config'
import { clearDisc, makeGround, solid, spawnSpots, standY, surfaceY } from '../../src/renderer/games/artillery-ground'
import { fill, flatGround } from './artillery-fixtures'

const W = ARTILLERY.width
const H = ARTILLERY.height
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1)

describe('makeGround', () => {
  it('the same seed gives the same ground, another seed another', () => {
    expect(makeGround(7).cells).toEqual(makeGround(7).cells)
    expect(makeGround(7).cells).not.toEqual(makeGround(8).cells)
  })

  it('the surface stays between rows 60 and 140 in every column', () => {
    for (const seed of SEEDS) {
      const g = makeGround(seed)
      for (let x = 0; x < W; x++) {
        const s = surfaceY(g, x)
        expect(s, `seed ${seed}, x ${x}`).toBeGreaterThanOrEqual(60)
        expect(s, `seed ${seed}, x ${x}`).toBeLessThanOrEqual(140)
      }
    }
  })

  it('every map has a cave: an empty cell under ground, above the water', () => {
    for (const seed of SEEDS) {
      const g = makeGround(seed)
      let cave = false
      for (let x = 0; x < W && !cave; x++) {
        for (let y = surfaceY(g, x) + 1; y < ARTILLERY.water && !cave; y++) {
          if (g.cells[y * W + x] === 0) cave = true
        }
      }
      expect(cave, `seed ${seed}`).toBe(true)
    }
  })
})

describe('solid', () => {
  it('solid: empty outside the sides and above the top, ground below the bottom', () => {
    const g = flatGround(100)
    expect(solid(g, -1, 120)).toBe(false)
    expect(solid(g, W, 120)).toBe(false)
    expect(solid(g, 100, -1)).toBe(false)
    expect(solid(g, 100, 99)).toBe(false)
    expect(solid(g, 100, H)).toBe(true)
    expect(solid(g, 100, H + 5)).toBe(true)
    expect(solid(g, 100, 120)).toBe(true)
  })
})

describe('clearDisc', () => {
  it('clearDisc clears exactly the cells within the radius and returns their box', () => {
    const g = flatGround(100)
    expect(clearDisc(g, 50, 100, 5)).toEqual({ x0: 45, y0: 95, x1: 55, y1: 105 })
    expect(solid(g, 50, 100)).toBe(false)
    expect(solid(g, 55, 100)).toBe(false)
    expect(solid(g, 56, 100)).toBe(true)
    expect(solid(g, 50, 106)).toBe(true)
  })

  it('clearDisc at the edge clips its box; a disc all outside gives null', () => {
    expect(clearDisc(flatGround(100), 2, 100, 5)).toEqual({ x0: 0, y0: 95, x1: 7, y1: 105 })
    expect(clearDisc(flatGround(100), -20, 100, 5)).toBeNull()
  })
})

describe('standY', () => {
  it('standY stands a fighter on the highest column under its box', () => {
    const g = fill(flatGround(100), 52, 97, 52, 99)
    expect(standY(g, 50)).toBe(96)
    expect(standY(g, 70)).toBe(99)
  })
})

describe('spawnSpots', () => {
  it('spawn spots: three a team, on their half, 40 px apart, above the water, on walkable ground', () => {
    for (const seed of SEEDS) {
      const g = makeGround(seed)
      const spots = spawnSpots(g, seed)
      for (const team of ['clawd', 'bug'] as const) {
        const xs = [...spots[team]].sort((a, b) => a - b)
        const [lo, hi] = team === 'clawd' ? [20, 394] : [434, 808]
        expect(xs.length, `seed ${seed} ${team}`).toBe(3)
        for (let i = 0; i < xs.length; i++) {
          const x = xs[i]
          expect(x >= lo && x <= hi, `seed ${seed} ${team} x ${x}`).toBe(true)
          if (i > 0) expect(x - xs[i - 1], `seed ${seed} ${team}`).toBeGreaterThanOrEqual(40)
          expect(standY(g, x), `seed ${seed} ${team} x ${x}`).toBeLessThan(ARTILLERY.water - 4)
          for (let i2 = -15; i2 <= 15; i2++) {
            const step = Math.abs(surfaceY(g, x + i2) - surfaceY(g, x + i2 - 1))
            expect(step, `seed ${seed} ${team} x ${x} at ${x + i2}`).toBeLessThanOrEqual(3)
          }
        }
      }
    }
  })
})

describe('botErrorScale', () => {
  it('botErrorScale is 1 at 0, shrinks with the streak, and stops at the floor', () => {
    expect(botErrorScale(0)).toBe(1)
    expect(botErrorScale(1)).toBeLessThan(1)
    expect(botErrorScale(3)).toBeLessThan(botErrorScale(1))
    expect(botErrorScale(50)).toBe(0.15)
  })
})
