import { describe, expect, it } from 'vitest'
import { flipperTip, launchSpeed, newGame, PINBALL, PLUNGER, start, step, TABLE } from '../../src/renderer/games/pinball-rules'
import type { Ball, PinballInput, PinballState } from '../../src/renderer/games/pinball-rules'
import { seeded } from '../../src/renderer/games/random'

const idle: PinballInput = { left: false, right: false, plunger: false }

/** a game in play with its ball loose where the test puts it */
function loose(ball: Ball, over: Partial<PinballState> = {}): PinballState {
  return { ...start(newGame()), onPlunger: false, ball, ...over }
}

/** steps a state in 1/120 s frames for `seconds`, or until `until` holds */
function run(s: PinballState, input: PinballInput, seconds: number, until?: (s: PinballState) => boolean): PinballState {
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    s = step(s, input, 1 / 120)
    if (until?.(s)) break
  }
  return s
}

describe('pinball rules', () => {
  it('a game waits on the plunger until it is started; one that is over starts again with 3 balls', () => {
    const ready = newGame()
    expect(ready.phase).toBe('ready')
    expect(ready.onPlunger).toBe(true)
    expect(step(ready, { ...idle, plunger: true }, 0.1)).toBe(ready)
    expect(start(ready).phase).toBe('play')

    const over: PinballState = { ...start(ready), phase: 'over', balls: 0, score: 900 }
    const again = start(over)
    expect(again.phase).toBe('play')
    expect(again.balls).toBe(PINBALL.balls)
    expect(again.score).toBe(0)
  })

  it('gravity pulls a free ball down', () => {
    const s = run(loose({ x: 88, y: 60, vx: 0, vy: 0 }), idle, 0.1)
    expect(s.ball.vy).toBeCloseTo(PINBALL.gravity * 0.1, 3)
    expect(s.ball.x).toBe(88)
    expect(s.ball.y).toBeGreaterThan(60)
  })

  it('a wall bounces the ball back, slower', () => {
    const s = run(loose({ x: 30, y: 110, vx: -300, vy: 0 }), idle, 0.15)
    expect(s.ball.vx).toBeGreaterThan(0)
    expect(s.ball.vx).toBeLessThan(300)
    expect(s.ball.x).toBeGreaterThan(6 + PINBALL.ballR - 0.01)
  })

  it('a raised flipper sends a ball resting on it up the table', () => {
    // the ball lies on the left flipper, a little out from the pivot
    const f = TABLE.flippers[0]
    const along = 18
    const nx = Math.sin(f.rest)
    const ny = -Math.cos(f.rest)
    const gap = PINBALL.ballR + PINBALL.flipperR + 0.1
    const ball = { x: f.x + along * Math.cos(f.rest) + nx * gap, y: f.y + along * Math.sin(f.rest) + ny * gap, vx: 0, vy: 0 }
    const flipped = run(loose(ball), { ...idle, left: true }, 0.05)
    expect(flipped.ball.vy).toBeLessThan(-250)
    expect(flipped.ball.y).toBeLessThan(ball.y)

    // left alone, it rolls down off the tip instead
    const rolled = run(loose(ball), idle, 0.05)
    expect(rolled.ball.vy).toBeGreaterThan(0)
  })

  it('a ball cradled on a raised flipper rolls off it when the flipper drops, on either side', () => {
    for (const i of [0, 1] as const) {
      const spec = TABLE.flippers[i]
      const held: PinballInput = { ...idle, left: i === 0, right: i === 1 }
      // the ball dropped onto the middle of the raised flipper rolls back into the corner by the pivot and stays there
      const tip = flipperTip(i, spec.up)
      const raised = run(start(newGame()), held, 0.2)
      let s: PinballState = { ...raised, onPlunger: false, ball: { x: (spec.x + tip.x) / 2, y: (spec.y + tip.y) / 2 - 12, vx: 0, vy: 0 } }
      s = run(s, held, 1.5)
      expect(Math.hypot(s.ball.x - spec.x, s.ball.y - spec.y)).toBeLessThan(15)
      expect(Math.hypot(s.ball.vx, s.ball.vy)).toBeLessThan(5)
      // let go, the flipper drops and the ball rolls down it and out between the flippers
      s = run(s, idle, 2, (t) => t.onPlunger)
      expect(s.onPlunger).toBe(true)
      expect(s.balls).toBe(PINBALL.balls - 1)
    }
  })

  it('a flipper raised with a key stays up and drops when the key is let go', () => {
    const up = run(start(newGame()), { ...idle, right: true }, 0.2)
    expect(up.flippers[1].angle).toBeCloseTo(TABLE.flippers[1].up, 6)
    expect(up.flippers[0].angle).toBeCloseTo(TABLE.flippers[0].rest, 6)
    const down = run(up, idle, 0.3)
    expect(down.flippers[1].angle).toBeCloseTo(TABLE.flippers[1].rest, 6)
  })

  it('a bumper kicks the ball away and scores', () => {
    const bumper = TABLE.bumpers[0]
    const s = run(loose({ x: bumper.x - 25, y: bumper.y, vx: 150, vy: 0 }), idle, 0.2, (s) => s.score > 0)
    expect(s.score).toBe(PINBALL.bumperPoints)
    expect(s.ball.vx).toBeLessThan(-PINBALL.bumperKick * 0.8)
    expect(s.flash.bumpers[0]).toBeGreaterThan(0)
  })

  it('a target lights and scores; with both lit the bonus comes and they go dark', () => {
    const left = run(loose({ x: 20, y: 134, vx: -200, vy: 0 }), idle, 0.1, (s) => s.score > 0)
    expect(left.score).toBe(PINBALL.targetPoints)
    expect(left.lit).toEqual([true, false])

    const both = run(loose({ x: 155, y: 134, vx: 200, vy: 0 }, { lit: [true, false], score: 250 }), idle, 0.1, (s) => s.score > 250)
    expect(both.score).toBe(250 + PINBALL.targetPoints + PINBALL.targetsBonus)
    expect(both.lit).toEqual([false, false])
  })

  it('the ball rolling slowly down a target does not light it', () => {
    const s = run(loose({ x: 6 + PINBALL.ballR, y: 110, vx: -5, vy: 20 }), idle, 0.3)
    expect(s.score).toBe(0)
    expect(s.lit).toEqual([false, false])
  })

  it('the >_ lane scores once as the ball goes up through it', () => {
    const lane = TABLE.lane
    const s = run(loose({ x: (lane.x0 + lane.x1) / 2, y: 70, vx: 0, vy: -300 }), idle, 0.5, (s) => s.ball.y < lane.y0 - 3)
    expect(s.ball.y).toBeLessThan(lane.y0)
    expect(s.score).toBe(PINBALL.lanePoints)
  })

  it('a ball that falls out between the flippers is lost, and the next waits on the plunger', () => {
    const s = run(loose({ x: 88, y: 236, vx: 0, vy: 120 }), idle, 0.3, (s) => s.onPlunger)
    expect(s.balls).toBe(PINBALL.balls - 1)
    expect(s.onPlunger).toBe(true)
    expect(s.ball).toEqual({ x: PLUNGER.x, y: PLUNGER.y, vx: 0, vy: 0 })
    expect(s.phase).toBe('play')
  })

  it('losing the last ball ends the game, keeping the score', () => {
    const s = run(loose({ x: 88, y: 236, vx: 0, vy: 120 }, { balls: 1, score: 1234 }), idle, 0.3)
    expect(s.phase).toBe('over')
    expect(s.balls).toBe(0)
    expect(s.score).toBe(1234)
    expect(step(s, idle, 0.1)).toBe(s)
  })

  it('the plunger launches harder the longer it is held, up to a cap', () => {
    const launched = (hold: number): number => {
      let s = run(start(newGame()), { ...idle, plunger: true }, hold)
      s = step(s, idle, 1 / 120)
      expect(s.onPlunger).toBe(false)
      return -s.ball.vy
    }
    const short = launched(0.2)
    const long = launched(0.6)
    expect(short).toBeCloseTo(launchSpeed(0.2 / PINBALL.plungerFill), 0)
    expect(long).toBeGreaterThan(short + 100)
    expect(launched(3)).toBeCloseTo(PINBALL.launchMax, 6)
    expect(launchSpeed(5)).toBe(PINBALL.launchMax)
  })

  it('a weak launch falls back down the lane and waits on the plunger again', () => {
    let s = run(start(newGame()), { ...idle, plunger: true }, 1 / 60)
    s = run(s, idle, 3, (t) => t.onPlunger)
    expect(s.onPlunger).toBe(true)
    expect(s.balls).toBe(PINBALL.balls)
  })

  it('a full launch goes round the top into the table', () => {
    let s = run(start(newGame()), { ...idle, plunger: true }, 1)
    s = run(s, idle, 1, (t) => t.ball.x < 100)
    expect(s.ball.x).toBeLessThan(100)
    expect(s.onPlunger).toBe(false)
  })

  it('no speed is above the cap', () => {
    const s = step(loose({ x: 88, y: 120, vx: 4000, vy: -4000 }), idle, 1 / 120)
    expect(Math.hypot(s.ball.vx, s.ball.vy)).toBeLessThanOrEqual(PINBALL.maxSpeed + 1e-6)
  })

  it('a ball at the speed cap never tunnels through a wall', () => {
    // along y 160, below the bumpers, into the lower part of the left wall; from 16 starts, so that one of them reaches
    // the wall at any point of a step
    for (let i = 0; i < 16; i++) {
      let s = loose({ x: 120 + i * 0.5, y: 160, vx: -PINBALL.maxSpeed, vy: 0 })
      for (let j = 0; j < 24; j++) {
        s = step(s, idle, 1 / 120)
        expect(s.ball.x).toBeGreaterThan(6)
      }
      expect(s.ball.vx).toBeGreaterThan(0)
    }
  })

  it('a ball at the speed cap never tunnels through a rising flipper', () => {
    const f = TABLE.flippers[0]
    // straight down onto the middle of the left flipper while it swings up
    const x = f.x + 20
    let s = loose({ x, y: 170, vx: 0, vy: PINBALL.maxSpeed })
    const lineY = (s: PinballState): number => {
      const tip = flipperTip(0, s.flippers[0].angle)
      return f.y + ((tip.y - f.y) * (s.ball.x - f.x)) / (tip.x - f.x)
    }
    for (let i = 0; i < 24; i++) {
      s = step(s, { ...idle, left: true }, 1 / 120)
      if (Math.abs(s.ball.x - f.x) < PINBALL.flipperLength) expect(s.ball.y).toBeLessThan(lineY(s))
    }
    expect(s.ball.vy).toBeLessThan(0)
  })

  it('under a minute of random play the ball stays on the table', () => {
    for (const seed of [1, 2, 3]) {
      const rand = seeded(seed)
      let s = start(newGame())
      let input = idle
      for (let i = 0; i < 60 * 120 && s.phase === 'play'; i++) {
        if (i % 12 === 0) input = { left: rand.next() < 0.4, right: rand.next() < 0.4, plunger: s.onPlunger && rand.next() < 0.7 }
        s = step(s, input, 1 / 120)
        expect(Number.isFinite(s.ball.x) && Number.isFinite(s.ball.y)).toBe(true)
        expect(s.ball.x).toBeGreaterThan(6)
        expect(s.ball.x).toBeLessThan(184)
        expect(s.ball.y).toBeGreaterThan(0)
        expect(s.ball.y).toBeLessThan(PINBALL.height + 2 * PINBALL.ballR)
      }
    }
  })

  it('a step leaves the state it was given as it was', () => {
    const s = loose({ x: 60, y: 120, vx: 100, vy: -50 })
    const before = structuredClone(s)
    step(s, { left: true, right: false, plunger: false }, 0.05)
    expect(s).toEqual(before)
  })
})
