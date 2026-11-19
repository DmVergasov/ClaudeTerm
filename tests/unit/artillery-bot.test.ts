import { describe, expect, it } from 'vitest'
import { ARTILLERY, BOT, NO_INPUT } from '../../src/renderer/games/artillery-config'
import { effect } from '../../src/renderer/games/artillery-shots'
import { driveBot, makePlanner, plan, predict, score, withError } from '../../src/renderer/games/artillery-bot'
import { dropCharge, step } from '../../src/renderer/games/artillery-rules'
import type { ArtilleryState, BotTurn, Candidate, Fighter } from '../../src/renderer/games/artillery-types'
import { battle, emptyGround, fighter, fill, flatGround } from './artillery-fixtures'

const DT = ARTILLERY.step

/** a battle on flat ground at row 100: the given fighters, the bugs to play (team 'bug', phase 'bot') with the bug at index `active` */
function bugTurn(fighters: Fighter[], active: number, over: Partial<ArtilleryState> = {}): ArtilleryState {
  return battle({
    ground: flatGround(100),
    fighters,
    team: 'bug',
    active,
    phase: 'bot',
    next: { clawd: 0, bug: 3 },
    botError: 0,
    ...over
  })
}

/** the Clawds at xs (the first alive, the rest out), then the bugs at xs (the first alive, the rest out) */
function sides(clawds: number[], bugs: number[]): Fighter[] {
  const c = [0, 1, 2].map((i) => (clawds[i] !== undefined ? fighter('clawd', clawds[i], 99) : fighter('clawd', 0, 99, { out: true })))
  const b = [0, 1, 2].map((i) => (bugs[i] !== undefined ? fighter('bug', bugs[i], 99) : fighter('bug', 0, 99, { out: true })))
  return [...c, ...b]
}

/** a bugs' turn set by hand: a Clawd at 300 alone, the bug at 600 with the given stage and choice */
function stubbed(bot: Partial<BotTurn>, choice: Candidate): ArtilleryState {
  const s = bugTurn(sides([300], [600]), 3)
  const turn: BotTurn = {
    stage: 'walk',
    planner: { list: [], next: 0, best: null, bestScore: -Infinity, stage: 'done' },
    choice,
    thought: 0,
    stuck: 0,
    lastX: 600,
    lastGap: Infinity,
    shots: 0,
    ...bot
  }
  return { ...s, bot: turn }
}

/** a candidate of a rocket at x facing facing, with aim and power */
function rocket(x: number, facing: -1 | 1, aim: number, power: number, over: Partial<Candidate> = {}): Candidate {
  return { weapon: 'rocket', x, facing, aim, power, target: null, retreat: 0, ...over }
}

/** the planner run until done with the budget a step, and its best candidate */
function bestOf(s: ArtilleryState): Candidate | null {
  let p = makePlanner(s)
  while (p.stage !== 'done') p = plan(p, s, BOT.budget)
  return p.best
}

describe('the bot aims with the rules physics', () => {
  it('with no error the bot hits a lone Clawd in the open', () => {
    let w = bugTurn(sides([300], [600]), 3)
    for (let i = 0; i < 20 / DT && w.team === 'bug'; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.team).toBe('clawd')
    expect(w.fighters[0].hp).toBeLessThan(100)
  })

  it('it prefers a shot that does not hurt its own', () => {
    const own = score(bugTurn(sides([], [515]), 3), [{ x: 515, y: 94, radius: 14, damage: 45, push: 110 }])
    expect(own.score).toBeLessThan(0)

    // no rm -rf or Ping in hand: with a Clawd at 15 px the bot would drop rm -rf, which has no impact of its own to check
    const base = bugTurn(sides([200, 500], [515]), 3)
    const s: ArtilleryState = { ...base, ammo: { clawd: base.ammo.clawd, bug: { ...base.ammo.bug, rmrf: 0, ping: 0 } } }
    const best = bestOf(s)
    expect(best).not.toBeNull()
    const impacts = predict(s, best as Candidate).impacts
    expect(impacts.length).toBeGreaterThan(0)
    const x = impacts[0].x
    expect(Math.abs(x - 200)).toBeLessThan(Math.abs(x - 500))
  })

  it('the same state gives the same choice', () => {
    const s = bugTurn(sides([300], [600]), 3)
    expect(bestOf(s)).toEqual(bestOf(s))
  })

  it('its work per step is bounded and it decides within about a second', () => {
    const s = bugTurn(sides([300], [600]), 3)
    // one step's budget leaves the search unfinished, and a budget of 1 evaluates exactly one candidate
    const oneStep = plan(makePlanner(s), s, BOT.budget)
    expect(oneStep.stage).not.toBe('done')
    expect(oneStep.next).toBeLessThan(oneStep.list.length)
    expect(plan(makePlanner(s), s, 1).next).toBe(1)
    let p = makePlanner(s)
    let calls = 0
    while (p.stage !== 'done' && calls < 150) {
      p = plan(p, s, BOT.budget)
      calls++
    }
    expect(p.stage).toBe('done')
    expect(calls).toBeLessThanOrEqual(150)
  })

  it('at a streak of 0 it hits about half the time', () => {
    const s = bugTurn(sides([250], [600]), 3)
    const clawd = s.fighters[0]
    const best = bestOf(s) as Candidate
    let hits = 0
    for (let seed = 1; seed <= 40; seed++) {
      const w = { ...s, seed, botError: 1 }
      const c = withError(best, w)
      const impacts = predict(s, c).impacts
      if (impacts.some((imp) => effect(clawd, imp) !== null)) hits++
    }
    expect(hits).toBeGreaterThanOrEqual(12)
    expect(hits).toBeLessThanOrEqual(28)
  })

  it("it plays with the person's controls: the aim turns gradually and the weapon is used", () => {
    let w = bugTurn(sides([300], [600]), 3)
    let prev = w.aim
    let turning = 0
    for (let i = 0; i < 10 / DT && !w.used; i++) {
      w = step(w, NO_INPUT, DT, driveBot)
      const delta = Math.abs(w.aim - prev)
      expect(delta).toBeLessThanOrEqual(ARTILLERY.aimRate * DT + 1e-9)
      if (delta > 0) turning++
      prev = w.aim
    }
    expect(w.used).toBe(true)
    expect(turning).toBeGreaterThan(1)
  })
})

describe('the bot holds its choice through the use', () => {
  it('rm -rf choice holds its retreat after the use', () => {
    const choice: Candidate = { weapon: 'rmrf', x: 600, facing: -1, aim: 30, power: 0, target: null, retreat: 1 }
    let w = stubbed({ stage: 'pick' }, choice)
    for (let i = 0; i < 10 / DT && !w.used; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(true)
    const at = w.fighters[3].x
    for (let i = 0; i < 1.5 / DT && w.retreat > 0; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.fighters[3].x).toBeGreaterThan(at)
  })

  it('rm -rf is dropped at the feet as dynamite and spends its ammo', () => {
    const choice: Candidate = { weapon: 'rmrf', x: 600, facing: -1, aim: 30, power: 0, target: null, retreat: 1 }
    let w = stubbed({ stage: 'pick' }, choice)
    for (let i = 0; i < 10 / DT && !w.used; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(true)
    const dynamite = w.shots.filter((x) => x.kind === 'dynamite')
    expect(dynamite.length).toBe(1)
    expect(dynamite[0].x).toBe(600)
    expect(w.ammo.bug.rmrf).toBe(0)
  })

  it('a pause during its charge drops the charge, and the bot still fires afterwards', () => {
    let w = bugTurn(sides([300], [600]), 3)
    for (let i = 0; i < 10 / DT && !w.charging; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.charging).toBe(true)
    w = dropCharge(w)
    let fired = false
    for (let i = 0; i < 3 / DT && !fired; i++) {
      w = step(w, NO_INPUT, DT, driveBot)
      fired = w.used || w.shots.length > 0
    }
    expect(fired).toBe(true)
  })

  it('a retreat stops at a ledge: a bug that dropped rm -rf does not walk off it', () => {
    // the rock ends at x 650: the bug at 600 retreats to the right, away from the Clawd at 300, and stops at the edge
    const ledge = fill(emptyGround(), 0, 100, 650, 159)
    const choice: Candidate = { weapon: 'rmrf', x: 600, facing: -1, aim: 30, power: 0, target: null, retreat: 1 }
    let w: ArtilleryState = { ...stubbed({ stage: 'pick' }, choice), ground: ledge }
    for (let i = 0; i < 10 / DT && !w.used; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(true)
    // the dynamite at the feet goes off after 4 s, out of the bug's reach at 56 px
    for (let i = 0; i < 10 / DT && w.team === 'bug'; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.fighters[3].out).toBe(false)
    expect(w.fighters[3].x).toBeGreaterThan(600)
    expect(w.fighters[3].x).toBeLessThanOrEqual(656)
  })

  it('a refused pick does not fire the weapon in hand in its place', () => {
    const choice = rocket(600, -1, 30, 0.5, { weapon: 'ping' })
    const s = stubbed({ stage: 'pick' }, choice)
    s.ammo.bug.ping = 0
    let w = s
    for (let i = 0; i < 2 / DT; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(false)
    expect(w.shots.length).toBe(0)
  })

  it('it walks to the choice x and faces it before it fires', () => {
    const choice = rocket(620, 1, 30, 0.5)
    let w = stubbed({ stage: 'walk' }, choice)
    for (let i = 0; i < 20 / DT && !w.used; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(true)
    expect(w.shots.length).toBeGreaterThan(0)
    expect(w.shots[0].owner).toBe(3)
    expect(w.fighters[3].x).toBe(620)
    expect(w.fighters[3].facing).toBe(1)
  })

  it('it moves the cursor to the target before it uses Deploy', () => {
    const choice: Candidate = { weapon: 'deploy', x: 600, facing: -1, aim: 30, power: 0, target: { x: 640, y: 60 }, retreat: 0 }
    let w = stubbed({ stage: 'walk' }, choice)
    for (let i = 0; i < 20 / DT && !w.used; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(true)
    const bombs = w.shots.filter((x) => x.kind === 'bomb')
    expect(bombs.length).toBe(3)
    expect(bombs[1].x).toBe(640)
  })

  it('a Deploy target at a half cell still fires within 2 s', () => {
    const choice: Candidate = { weapon: 'deploy', x: 600, facing: -1, aim: 30, power: 0, target: { x: 640.5, y: 60 }, retreat: 0 }
    let w = stubbed({ stage: 'walk' }, choice)
    for (let i = 0; i < 2 / DT && !w.used; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(true)
  })

  it('a Deploy target the rules cannot reach (below the water) gives up and fires', () => {
    const choice: Candidate = { weapon: 'deploy', x: 600, facing: -1, aim: 30, power: 0, target: { x: 640, y: 160 }, retreat: 0 }
    let w = stubbed({ stage: 'walk' }, choice)
    for (let i = 0; i < (BOT.stuckFor + 1) / DT && !w.used; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(true)
  })

  it('an aim the rules cannot reach (past 90 degrees) gives up and fires', () => {
    const choice = rocket(600, -1, 92, 0.5)
    let w = stubbed({ stage: 'aim' }, choice)
    for (let i = 0; i < (BOT.stuckFor + 3) / DT && !w.used; i++) w = step(w, NO_INPUT, DT, driveBot)
    expect(w.used).toBe(true)
  })
})

describe("the bot's specials and other spots", () => {
  it('two Clawds close together draw a Fork bomb or Deploy', () => {
    const best = bestOf(bugTurn(sides([300, 315], [650]), 3)) as Candidate
    expect(['fork', 'deploy']).toContain(best.weapon)
  })

  it('a Clawd next to the bug draws rm -rf with a retreat away', () => {
    const best = bestOf(bugTurn(sides([600], [612]), 3)) as Candidate
    expect(best.weapon).toBe('rmrf')
    expect(best.retreat).toBe(1)
  })

  it('a Clawd in a clear line nearby gets a Ping candidate; a wall between takes it away', () => {
    const open = bugTurn(sides([500], [600]), 3)
    const ping = makePlanner(open).list.find((c) => c.weapon === 'ping')
    expect(ping).toBeDefined()
    const impacts = predict(open, ping as Candidate).impacts
    expect(impacts.length).toBe(2)
    expect(Math.abs(impacts[0].x - 500)).toBeLessThanOrEqual(6)

    const walled = bugTurn(sides([500], [600]), 3, { ground: fill(flatGround(100), 540, 80, 545, 99) })
    expect(makePlanner(walled).list.some((c) => c.weapon === 'ping')).toBe(false)
  })

  it('with nothing to hit from where it stands it tries spots 30 px away', () => {
    // the Clawd is out of reach: no shot scores above spotThreshold, so the spots at 750 and 810 are tried
    const far = bugTurn(sides([20], [780]), 3)
    const spots = new Set<number>()
    let p = makePlanner(far)
    while (p.stage !== 'done') {
      if (p.stage === 'spots') {
        expect(p.bestScore).toBeLessThanOrEqual(BOT.spotThreshold)
        for (const c of p.list) spots.add(c.x)
      }
      p = plan(p, far, 1)
    }
    expect([...spots].sort((a, b) => a - b)).toEqual([750, 810])

    // a shot that scores above the threshold ends the search before the spots
    const near = bugTurn(sides([300], [600]), 3)
    let q = makePlanner(near)
    while (q.stage !== 'done') {
      expect(q.stage).not.toBe('spots')
      q = plan(q, near, BOT.budget)
    }
  })

  it('a bug stuck in a pit teleports, or drills when Teleport is spent', () => {
    // a pit 60 px deep around the bug at 600, the Clawd far to the left at 100
    const pit = fill(fill(flatGround(100), 590, 40, 592, 99), 608, 40, 610, 99)
    let w = bugTurn(sides([100], [600]), 3, { ground: pit })
    for (let i = 0; i < 60 / DT && w.team === 'bug'; i++) w = step(w, NO_INPUT, DT, driveBot)
    // the Teleport was used (one shot spent) and the bug landed 60…100 px from the Clawd at 100, not in a drill's tunnel
    expect(w.ammo.bug.teleport).toBe(0)
    expect(w.ammo.bug.drill).toBe(2)
    const landed = Math.abs(w.fighters[3].x - 100)
    expect(landed).toBeGreaterThanOrEqual(BOT.teleportNear[0])
    expect(landed).toBeLessThanOrEqual(BOT.teleportNear[1])

    const spent = bugTurn(sides([100], [600]), 3, { ground: pit })
    let v: ArtilleryState = { ...spent, ammo: { clawd: spent.ammo.clawd, bug: { ...spent.ammo.bug, teleport: 0 } } }
    for (let i = 0; i < 60 / DT && v.team === 'bug'; i++) v = step(v, NO_INPUT, DT, driveBot)
    // Drill was used once, and the bug dug its way out to the left
    expect(v.ammo.bug.drill).toBe(1)
    expect(v.fighters[3].x).toBeLessThan(590)
  })
})

describe('the bot predicts the specials as the rules fire them', () => {
  it('a Deploy candidate predicts its three bombs', () => {
    const s = bugTurn(sides([300, 315], [650]), 3)
    const deploy: Candidate = { weapon: 'deploy', x: 650, facing: -1, aim: 30, power: 0, target: { x: 307, y: 69 }, retreat: 0 }
    expect(predict(s, deploy).impacts.length).toBe(3)
  })

  it('a single impact keeps the ground it was given: no copy is made for a rocket', () => {
    const s = bugTurn(sides([300], [600]), 3)
    const rocketCand = rocket(600, -1, 30, 0.5)
    expect(predict(s, rocketCand).ground).toBe(s.ground)
  })

  it('a fork bomb carves its crater before its bomblets fly, so they do not blow up in the wall', () => {
    const s = bugTurn(sides([], [600]), 3, { ground: fill(flatGround(100), 560, 60, 570, 99) })
    const fork: Candidate = { weapon: 'fork', x: 600, facing: -1, aim: 0, power: 0.5, target: null, retreat: 0 }
    const impacts = predict(s, fork).impacts
    expect(impacts.length).toBeGreaterThan(1)
    const first = impacts[0]
    expect(impacts.slice(1).some((i) => Math.hypot(i.x - first.x, i.y - first.y) > 12)).toBe(true)
  })
})
