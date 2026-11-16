import { describe, expect, it } from 'vitest'
import { CLAWD, CLAWD_DUCK, CLAWD_STEP, paintSprite } from '../../src/renderer/games/clawd'
import { hitBox, newRun, OBSTACLES, RUNNER, start, step } from '../../src/renderer/games/runner-rules'
import type { Obstacle, RunnerInput, RunnerState } from '../../src/renderer/games/runner-rules'

const none: RunnerInput = { jump: false, duck: false }
const jump: RunnerInput = { jump: true, duck: false }
const duck: RunnerInput = { jump: false, duck: true }

/** a rand that always returns v */
function always(v: number): () => number {
  return () => v
}

/** a rand that returns the given values in order, then 0.99 */
function sequence(...values: number[]): () => number {
  let i = 0
  return () => (i < values.length ? values[i++] : 0.99)
}

/** a started run with the given obstacles */
function running(...obstacles: Obstacle[]): RunnerState {
  return { ...start(newRun()), obstacles }
}

describe('runner rules', () => {
  it('a run waits until it is started', () => {
    const ready = newRun()
    expect(step(ready, jump, 0.01, always(0.5))).toBe(ready)
    expect(start(ready).phase).toBe('running')

    const over: RunnerState = { ...start(ready), phase: 'over' }
    const again = start(over)
    expect(again.phase).toBe('running')
    expect(again.score).toBe(0)
    expect(again.obstacles).toEqual([])
  })

  it('a jump lands after 2 × jumpSpeed / gravity seconds', () => {
    let s = step(start(newRun()), jump, 0.01, always(0.5))
    const heights = [s.y]
    for (let i = 0; i < 200 && s.y !== 0; i++) {
      s = step(s, none, 0.01, always(0.5))
      heights.push(s.y)
    }
    const seconds = heights.length * 0.01
    expect(heights.slice(0, -1).every((y) => y > 0)).toBe(true)
    expect(heights[heights.length - 1]).toBe(0)
    expect(seconds).toBeGreaterThanOrEqual(0.62)
    expect(seconds).toBeLessThanOrEqual(0.66)
  })

  it('no second jump in the air', () => {
    let s = step(start(newRun()), jump, 0.01, always(0.5))
    for (let i = 0; i < 30; i++) s = step(s, none, 0.01, always(0.5))
    const before = s
    const after = step(s, jump, 0.01, always(0.5))
    expect(after.y).toBeGreaterThan(0)
    expect(after.vy).toBeLessThan(before.vy)
  })

  it('a ground obstacle ends a run that does not jump, and not one that jumps in time', () => {
    let idle = running({ kind: 'bracket', x: 70 })
    for (let i = 0; i < 200 && idle.phase === 'running'; i++) idle = step(idle, none, 0.01, always(0.5))
    expect(idle.phase).toBe('over')

    let jumper = step(running({ kind: 'bracket', x: 70 }), jump, 0.01, always(0.5))
    for (let i = 0; i < 100; i++) jumper = step(jumper, none, 0.01, always(0.5))
    expect(jumper.phase).toBe('running')
  })

  it('ducking clears a flyer; standing hits it', () => {
    let standing = running({ kind: 'null', x: 70 })
    for (let i = 0; i < 100 && standing.phase === 'running'; i++) standing = step(standing, none, 0.01, always(0.5))
    expect(standing.phase).toBe('over')

    let ducked = running({ kind: 'null', x: 70 })
    for (let i = 0; i < 100; i++) ducked = step(ducked, duck, 0.01, always(0.5))
    expect(ducked.phase).toBe('running')
    expect(ducked.ducking).toBe(true)
  })

  it('score is a tenth of the distance and speed grows to its cap', () => {
    let s = running()
    for (let i = 0; i < 1000; i++) {
      s = step({ ...s, obstacles: [] }, none, 0.05, always(0.5))
      expect(s.score).toBe(Math.floor(s.distance / 10))
      expect(s.speed).toBe(Math.min(RUNNER.maxSpeed, RUNNER.startSpeed + RUNNER.speedPerPoint * s.score))
    }
    expect(s.phase).toBe('running')
    expect(s.speed).toBe(RUNNER.maxSpeed)
  })

  it('the gap to the next obstacle is rolled once, when an obstacle spawns', () => {
    // the gap rolled at the first spawn is 0.8 × 200 = 160, so the next obstacle comes once the first is left of 140
    let s = step(running(), none, 0.01, sequence(0, 0))
    expect(s.obstacles).toHaveLength(1)
    for (let i = 0; i < 200 && s.obstacles.length === 1; i++) {
      const before = s.obstacles[0].x
      s = step(s, none, 0.01, always(0.99))
      if (s.obstacles.length === 2) {
        expect(before).toBeGreaterThanOrEqual(140)
        expect(s.obstacles[0].x).toBeLessThan(140)
      }
    }
    expect(s.obstacles).toHaveLength(2)
  })

  it('step leaves the state it is given unchanged', () => {
    const s = running({ kind: 'bracket', x: 70 })
    const before = JSON.stringify(s)
    const next = step(s, jump, 0.5, always(0.5))
    expect(JSON.stringify(s)).toBe(before)
    expect(next).not.toBe(s)
    expect(next.obstacles).not.toBe(s.obstacles)
  })

  it('dt is clamped', () => {
    const s = running()
    const next = step(s, none, 5, always(0.5))
    expect(next.distance).toBeCloseTo(s.speed * RUNNER.maxDt)
    expect(next.frame).toBe(1)
  })

  it('no flyers before the score reaches flyersFrom', () => {
    let s = running()
    const seen: string[] = []
    for (let i = 0; i < 100; i++) {
      s = step(s, none, 0.01, always(0))
      expect(s.score).toBeLessThan(RUNNER.flyersFrom)
      seen.push(...s.obstacles.map((o) => o.kind))
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).not.toContain('null')
  })

  it('every ground obstacle kind comes up, each in an equal quarter of the rolls', () => {
    const counts: Record<string, number> = {}
    for (let i = 0; i < 400; i++) {
      const s = step(running(), none, 0.01, always((i + 0.5) / 400))
      const kind = s.obstacles[0].kind
      counts[kind] = (counts[kind] ?? 0) + 1
    }
    expect(counts).toEqual({ bracket: 100, braces: 100, parens: 100, bug: 100 })
  })

  it('flyers come in once the score reaches flyersFrom', () => {
    const s = step({ ...running(), score: RUNNER.flyersFrom, distance: RUNNER.flyersFrom * 10 }, none, 0.01, always(0))
    expect(s.obstacles.map((o) => o.kind)).toEqual(['null'])
    expect(OBSTACLES.null.y).toBe(17)
  })

  it('hitBox is the standing or the ducking box of Clawd', () => {
    expect(hitBox(newRun())).toEqual({ x: RUNNER.clawdX, y: 0, w: RUNNER.clawdW, h: RUNNER.clawdH })
    expect(hitBox({ ...newRun(), ducking: true }).h).toBe(RUNNER.duckH)
  })

  it('Clawd is 18 by 5 pixels', () => {
    for (const rows of [CLAWD, CLAWD_STEP]) {
      expect(rows).toHaveLength(5)
      rows.forEach((row) => expect(row).toHaveLength(18))
    }
    expect(CLAWD_DUCK).toHaveLength(4)
    CLAWD_DUCK.forEach((row) => expect(row).toHaveLength(18))
    expect(CLAWD_DUCK).toEqual(CLAWD.slice(1))
    expect(CLAWD_STEP.slice(0, 4)).toEqual(CLAWD.slice(0, 4))
    expect(CLAWD_STEP[4]).toBe('...#.#....#.#.....')
  })

  it('paintSprite fills one unit-wide, two-unit-tall rectangle per filled pixel', () => {
    const calls: number[][] = []
    const ctx = { fillStyle: '', fillRect: (...args: number[]) => calls.push(args) } as unknown as CanvasRenderingContext2D
    paintSprite(ctx, ['#.', '.#'], 10, 20, 3, 'red')
    expect(ctx.fillStyle).toBe('red')
    expect(calls).toEqual([
      [10, 20, 3, 6],
      [13, 26, 3, 6]
    ])
  })
})
