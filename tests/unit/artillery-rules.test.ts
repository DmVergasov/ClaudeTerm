import { describe, expect, it } from 'vitest'
import { ARTILLERY, NO_INPUT } from '../../src/renderer/games/artillery-config'
import { makeGround, spawnSpots, standY } from '../../src/renderer/games/artillery-ground'
import {
  atRest,
  dropCharge,
  idleBot,
  inBattle,
  newBattle,
  start,
  step,
  tally,
  teamHp
} from '../../src/renderer/games/artillery-rules'
import type { ArtilleryInput, ArtilleryState, BotDriver, BotTurn, Fighter, Shot } from '../../src/renderer/games/artillery-types'
import { battle, emptyGround, fighter, fill, flatGround } from './artillery-fixtures'

const FRAME = 1 / 60

/** the input with the keys given and nothing else pressed */
function keys(over: Partial<ArtilleryInput> = {}): ArtilleryInput {
  return { ...NO_INPUT, ...over }
}

/** steps the state for `seconds` in 1/60-s frames, with the same input held in each frame */
function run(s: ArtilleryState, input: ArtilleryInput, seconds: number, drive?: BotDriver): ArtilleryState {
  let w = s
  for (let i = 0; i < Math.round(seconds / FRAME); i++) w = step(w, input, FRAME, drive)
  return w
}

/** the field: a flat floor at row 100, the Clawd alone at x 50 and the bug alone at x 700; the others are out */
function field(over: Partial<ArtilleryState> = {}): ArtilleryState {
  return battle({
    ground: flatGround(100),
    fighters: [
      fighter('clawd', 50, 99),
      fighter('clawd', 200, 99, { out: true }),
      fighter('clawd', 300, 99, { out: true }),
      fighter('bug', 700, 99),
      fighter('bug', 750, 99, { out: true }),
      fighter('bug', 800, 99, { out: true })
    ],
    ...over
  })
}

/** a field with fighters that have hp 1000, so that a turn's own harm does not kill them */
function tough(team: 'clawd' | 'bug', x: number, over: Partial<Fighter> = {}): Fighter {
  return fighter(team, x, 99, { hp: 1000, ...over })
}

/** a fighter-by-fighter lineup on the flat floor: the Clawd at 50 alive, the Clawd at 200 out, the Clawd at 300 alive, the bug at 700 alive, the other two bugs out */
function lineup(): Fighter[] {
  return [
    tough('clawd', 50),
    tough('clawd', 200, { out: true }),
    tough('clawd', 300),
    tough('bug', 700),
    tough('bug', 750, { out: true }),
    tough('bug', 800, { out: true })
  ]
}

/** the states at the start of the first `turns` turns, s being the first: each turn is put at rest in settle, so the next step ends it */
function turnsOf(s: ArtilleryState, turns: number): ArtilleryState[] {
  const starts = [s]
  while (starts.length < turns) {
    const last = starts[starts.length - 1]
    starts.push(step({ ...last, phase: 'settle', used: true }, keys(), FRAME))
  }
  return starts
}

describe('artillery rules: the battle', () => {
  it('a new battle waits on its title; start gives the Clawds the first turn with a full clock', () => {
    const s = newBattle(5, 0)
    expect(s.phase).toBe('title')
    expect(s.fighters.map((f) => f.team)).toEqual(['clawd', 'clawd', 'clawd', 'bug', 'bug', 'bug'])
    expect(s.fighters.every((f) => f.hp === 100 && !f.out)).toBe(true)
    const spots = spawnSpots(makeGround(5), 5)
    expect(s.fighters.map((f) => f.x)).toEqual([...spots.clawd, ...spots.bug])
    expect(s.fighters.every((f) => f.y === standY(s.ground, f.x))).toBe(true)

    const t = start(s)
    expect(t.phase).toBe('aim')
    expect(t.team).toBe('clawd')
    expect(t.active).toBe(0)
    expect(t.clock).toBe(ARTILLERY.turnTime)
    expect(t.turn).toBe(1)
    expect(Math.abs(t.wind)).toBeLessThanOrEqual(50)
    expect(t.ammo.clawd).toEqual({ rocket: Infinity, grenade: Infinity, fork: 1, ping: 2, rmrf: 1, deploy: 1, drill: 2, teleport: 1 })
  })

  it('holding Space charges the power; the release fires a rocket and starts the retreat', () => {
    let w = run(field(), keys({ fire: true }), 0.5)
    expect(w.charging).toBe(true)
    expect(w.power).toBeGreaterThan(0.45)
    expect(w.power).toBeLessThan(0.55)
    expect(w.shots).toHaveLength(0)

    w = step(w, keys(), FRAME)
    expect(w.shots).toHaveLength(1)
    expect(w.shots[0].kind).toBe('rocket')
    expect(w.shots[0].owner).toBe(0)
    expect(w.used).toBe(true)
    expect(w.phase).toBe('flight')
    expect(w.retreat).toBeCloseTo(3, 1)
    expect(w.charging).toBe(false)
  })

  it('a full charge fires by itself', () => {
    const w = run(field(), keys({ fire: true }), 1.2)
    expect(w.shots).toHaveLength(1)
    expect(w.used).toBe(true)
    expect(w.charging).toBe(false)
  })

  it('one use a turn: Space after the shot fires nothing', () => {
    let w = run(field(), keys({ fire: true }), 0.2)
    w = step(w, keys(), FRAME)
    expect(w.shots).toHaveLength(1)
    const clock = w.clock
    w = run(w, keys({ fire: true }), 0.2)
    expect(w.shots).toHaveLength(1)
    expect(w.charging).toBe(false)
    expect(w.clock).toBe(clock)
  })

  it('the clock runs only before the use; at 0 the turn ends without a shot and the bugs go next', () => {
    let w = run(field(), keys(), ARTILLERY.turnTime + 0.1)
    expect(w.shots).toHaveLength(0)
    expect(w.team).toBe('bug')
    expect(w.phase).toBe('bot')

    const shot = step(run(field(), keys({ fire: true }), 0.3), keys(), FRAME)
    expect(shot.used).toBe(true)
    const clock = shot.clock
    w = run(shot, keys(), 2)
    expect(w.clock).toBe(clock)
  })

  it('a charge cut off by the clock fires nothing', () => {
    let w = run(field({ clock: 0.5 }), keys({ fire: true }), 0.7)
    expect(w.shots).toHaveLength(0)
    expect(w.team).toBe('bug')
    expect(w.turn).toBe(2)
    w = run(w, keys(), 0.1)
    expect(w.shots).toHaveLength(0)
  })

  it('dropCharge drops the charge without a shot', () => {
    const w = run(field(), keys({ fire: true }), 0.5)
    const dropped = dropCharge(w)
    expect(dropped.charging).toBe(false)
    expect(dropped.power).toBe(0)
    expect(dropped.shots).toHaveLength(0)
    const after = run(dropped, keys(), 0.2)
    expect(after.shots).toHaveLength(0)
    expect(after.charging).toBe(false)
  })

  it('a fire tap kept from a call with no fixed step does not survive a pause', () => {
    // the tap waits in pending; the pause drops the charge and the kept edges with it, so nothing fires after it
    const kept = step(field({ weapon: 'ping', aim: -20 }), keys({ fire: true }), 0.001)
    const paused = dropCharge(kept)
    const after = step(paused, NO_INPUT, 0.02)
    expect(after.pingLeft).toBe(0)
    expect(after.ammo.clawd.ping).toBe(2)
    expect(after.carved).toHaveLength(0)
  })

  it('during the retreat the fighter walks and jumps but cannot fire', () => {
    // a rocket fired to the left leaves the map at once; a far grenade with a long fuse keeps the turn going after the retreat
    const grenade: Shot = { kind: 'grenade', x: 300, y: 99, vx: 0, vy: 0, fuse: 6, resting: true, owner: 0, age: 0 }
    const side = field({
      aim: 0,
      shots: [grenade],
      fighters: [
        fighter('clawd', 20, 99, { facing: -1 }),
        fighter('clawd', 200, 99, { out: true }),
        fighter('clawd', 300, 99, { out: true }),
        fighter('bug', 700, 99),
        fighter('bug', 750, 99, { out: true }),
        fighter('bug', 800, 99, { out: true })
      ]
    })
    let w = run(side, keys({ fire: true }), 0.1)
    w = run(w, keys(), 0.2)
    expect(w.weapon).toBe('rocket')
    expect(w.used).toBe(true)
    expect(w.retreat).toBeGreaterThan(0)
    const shots = w.shots.length

    // a press in the retreat starts no charge, and a tap fires nothing
    w = step(w, keys({ fire: true }), FRAME)
    expect(w.charging).toBe(false)
    w = step(w, keys(), FRAME)
    expect(w.shots.length).toBe(shots)
    expect(w.charging).toBe(false)

    // a jump is allowed in the retreat, and the fighter walks right while the retreat runs
    w = step(w, keys({ jump: true }), FRAME)
    expect(w.fighters[0].air).toBe(true)
    let frames = 0
    while (w.retreat > 0 && frames < 600) {
      w = step(w, keys({ right: true }), FRAME)
      frames++
    }
    const end = w.fighters[0].x
    expect(end - 20).toBeGreaterThan(30)

    // the retreat is over but the grenade still burns: the turn is still the Clawds', and the arrow moves nothing
    expect(w.team).toBe('clawd')
    expect(w.shots.some((s) => s.kind === 'grenade')).toBe(true)
    w = run(w, keys({ right: true }), 1)
    expect(w.team).toBe('clawd')
    expect(w.fighters[0].x).toBe(end)
  })

  it('the turn ends when the retreat is over and everything rests', () => {
    let w = run(field(), keys({ fire: true }), 0.3)
    w = step(w, keys(), FRAME)
    w = run(w, keys(), 10)
    expect(w.team).toBe('bug')
    expect(w.phase).toBe('bot')
    expect(w.turn).toBe(2)
  })

  it('hurting yourself ends the turn at once, not after the retreat', () => {
    let w = run(field({ aim: -90 }), keys({ fire: true }), 0.2)
    w = step(w, keys(), FRAME)
    expect(w.ended).toBe(true)
    expect(w.fighters[0].hp).toBeLessThan(100)
    expect(w.phase).toBe('settle')

    // the blast throws the fighter up and into its own crater: it lands in about 2 s, well before the 3-s retreat would end
    w = run(w, keys(), 2.5)
    expect(w.team).toBe('bug')
  })

  it('a turn ended by a self-hit keeps the hurt fighter from walking', () => {
    // a far grenade keeps a shot in the air, so the turn waits while the hurt fighter lands and stands
    const grenade: Shot = { kind: 'grenade', x: 300, y: 99, vx: 0, vy: 0, fuse: 4, resting: true, owner: 0, age: 0 }
    let w = run(field({ aim: -90, shots: [grenade] }), keys({ fire: true }), 0.2)
    w = step(w, keys(), FRAME)
    expect(w.ended).toBe(true)
    const x = w.fighters[0].x
    w = run(w, keys({ left: true }), 3)
    expect(w.fighters[0].x).toBe(x)
    expect(w.fighters[0].out).toBe(false)
  })

  it('turns rotate within a team and skip the out', () => {
    const starts = turnsOf(battle({ ground: flatGround(100), fighters: lineup() }), 3)
    expect(starts.map((s) => s.active)).toEqual([0, 3, 2])
    expect(starts[2].team).toBe('clawd')
  })

  it('wind changes every turn within its limits', () => {
    const starts = turnsOf(battle({ ground: flatGround(100), fighters: lineup() }), 5)
    const winds = starts.slice(1).map((s) => s.wind)
    expect(winds).toHaveLength(4)
    for (const wind of winds) {
      expect(Number.isInteger(wind)).toBe(true)
      expect(Math.abs(wind)).toBeLessThanOrEqual(ARTILLERY.windMax)
    }
    expect(new Set(winds).size).toBeGreaterThan(1)
  })

  it('the water rises from turn 31', () => {
    const before = field({ turn: 29, phase: 'settle', used: true })
    expect(step(before, keys(), FRAME).water).toBe(ARTILLERY.water)

    const late = field({ turn: 30, phase: 'settle', used: true })
    const w = step(late, keys(), FRAME)
    expect(w.turn).toBe(31)
    expect(w.water).toBe(ARTILLERY.water - ARTILLERY.floodRise)
  })

  it('the battle ends: no bugs is a win, no Clawds a loss, both a draw', () => {
    const clawd = fighter('clawd', 50, 99)
    const bug = fighter('bug', 700, 99)
    const out = (f: Fighter): Fighter => ({ ...f, out: true })

    const won = step(field({ phase: 'settle', used: true, fighters: [clawd, out(bug)] }), keys(), FRAME)
    expect(won.phase).toBe('over')
    expect(won.result).toBe('win')
    expect(inBattle(won)).toBe(false)
    expect(step(won, keys(), FRAME)).toBe(won)

    const lost = step(field({ phase: 'settle', used: true, fighters: [out(clawd), bug] }), keys(), FRAME)
    expect(lost.result).toBe('loss')

    const drawn = step(field({ phase: 'settle', used: true, fighters: [out(clawd), out(bug)] }), keys(), FRAME)
    expect(drawn.result).toBe('draw')
  })

  it('tally: a win raises wins, streak and best; a loss or a draw resets the streak', () => {
    expect(tally({ wins: 2, streak: 2, best: 2 }, 'win')).toEqual({ wins: 3, streak: 3, best: 3 })
    expect(tally({ wins: 3, streak: 1, best: 3 }, 'win')).toEqual({ wins: 4, streak: 2, best: 3 })
    expect(tally({ wins: 4, streak: 2, best: 3 }, 'loss')).toEqual({ wins: 4, streak: 0, best: 3 })
    expect(tally({ wins: 4, streak: 2, best: 3 }, 'draw')).toEqual({ wins: 4, streak: 0, best: 3 })
  })

  it('teamHp adds up the hit points of a team, out fighters at 0', () => {
    const s = field({ fighters: [fighter('clawd', 50, 99, { hp: 40 }), fighter('clawd', 200, 99, { hp: 0, out: true }), fighter('bug', 700, 99)] })
    expect(teamHp(s, 'clawd')).toBe(40)
    expect(teamHp(s, 'bug')).toBe(100)
  })

  it('an explosion carves the ground, records its box and leaves the old state untouched', () => {
    const rocket: Shot = { kind: 'rocket', x: 120, y: 98, vx: 0, vy: 50, fuse: null, resting: false, owner: 0, age: 0 }
    const s = field({ shots: [rocket], phase: 'flight', used: true })
    const cells = s.ground.cells.slice()

    const w = run(s, keys(), 0.2)
    expect(w.ground.cells[100 * w.ground.w + 120]).toBe(0)
    expect(w.carved).toHaveLength(1)
    expect(w.carved[0].x0).toBeLessThanOrEqual(120)
    expect(w.carved[0].x1).toBeGreaterThanOrEqual(120)
    expect(s.ground.cells).toEqual(cells)
    expect(s.carved).toHaveLength(0)
  })

  it('Deploy and Teleport show a cursor that the arrows move', () => {
    let w = step(field(), keys({ pick: 'deploy' }), FRAME)
    expect(w.weapon).toBe('deploy')
    expect(w.cursor).toEqual({ x: 50, y: 69 })

    w = run(w, keys({ right: true, up: true }), 0.5)
    expect(w.cursor?.x).toBeCloseTo(110, 1)
    expect(w.cursor?.y).toBeCloseTo(9, 1)
    expect(w.fighters[0].x).toBe(50)

    w = step(w, keys({ pick: 'teleport' }), FRAME)
    expect(w.weapon).toBe('teleport')
    expect(w.cursor).toEqual({ x: 50, y: 69 })
  })

  it('Teleport moves the fighter to a free spot and ends the turn; rock or water refuses it and keeps the ammo', () => {
    const free = { ...field({ weapon: 'teleport' }), cursor: { x: 200, y: 90 } }
    let w = step(free, keys({ fire: true }), FRAME)
    expect(w.ammo.clawd.teleport).toBe(0)
    w = run(w, keys(), 1)
    expect(w.fighters[0].x).toBe(200)
    expect(w.team).toBe('bug')

    const rock = { ...field({ weapon: 'teleport' }), cursor: { x: 200, y: 110 } }
    let r = step(rock, keys({ fire: true }), FRAME)
    expect(r.ammo.clawd.teleport).toBe(1)
    expect(r.used).toBe(false)
    expect(r.phase).toBe('aim')
    expect(r.fighters[0].x).toBe(50)

    // a pit cleared down past the water, so the spot at 147 is free ground and only the water refuses it
    const pit = flatGround(100)
    for (let y = 100; y < ARTILLERY.height; y++) for (let x = 190; x <= 210; x++) pit.cells[y * pit.w + x] = 0
    const water = { ...field({ ground: pit, weapon: 'teleport' }), cursor: { x: 200, y: 147 } }
    r = step(water, keys({ fire: true }), FRAME)
    expect(r.ammo.clawd.teleport).toBe(1)
    expect(r.used).toBe(false)
    expect(r.fighters[0].x).toBe(50)
  })

  it('Ping fires two shots and the aim can change between them', () => {
    // aimed down at the floor: each ping digs a hole where it lands
    let w = step(field({ weapon: 'ping', aim: -20 }), keys({ fire: true }), FRAME)
    expect(w.carved).toHaveLength(1)
    expect(w.ammo.clawd.ping).toBe(1)
    expect(w.pingLeft).toBe(1)
    expect(w.used).toBe(false)

    w = run(w, keys({ up: true }), 0.1)
    expect(w.aim).toBeCloseTo(-14, 1)

    w = step(w, keys(), FRAME)
    w = step(w, keys({ fire: true }), FRAME)
    expect(w.carved).toHaveLength(2)
    expect(w.used).toBe(true)
    expect(w.pingLeft).toBe(0)
    expect(w.ammo.clawd.ping).toBe(1)
    expect(w.phase).toBe('retreat')
  })

  it('rm -rf drops at the feet and the retreat starts at once', () => {
    let w = step(field({ weapon: 'rmrf' }), keys({ fire: true }), FRAME)
    expect(w.shots).toHaveLength(1)
    expect(w.shots[0].kind).toBe('dynamite')
    expect(w.shots[0].x).toBe(50)
    expect(w.phase).toBe('flight')
    expect(w.retreat).toBeCloseTo(3, 1)

    w = run(w, keys(), 4.2)
    expect(w.shots).toHaveLength(0)
    expect(w.carved.length).toBeGreaterThan(0)
  })

  it('Drill digs down when aimed down, to the side otherwise', () => {
    let w = step(field({ aim: -60, weapon: 'drill' }), keys({ fire: true }), FRAME)
    expect(w.fighters[0].drill).toEqual({ dx: 0, dy: 1, left: 40 })
    w = run(w, keys(), 1.6)
    expect(w.fighters[0].drill).toBeNull()
    expect(w.fighters[0].y).toBeGreaterThan(130)
    expect(w.carved.length).toBeGreaterThan(0)

    let side = step(field({ aim: 0, weapon: 'drill' }), keys({ fire: true }), FRAME)
    expect(side.fighters[0].drill).toEqual({ dx: 1, dy: 0, left: 40 })
    side = run(side, keys(), 1.6)
    expect(side.fighters[0].drill).toBeNull()
    expect(side.fighters[0].x).toBe(90)
  })

  it('pick and Tab skip weapons with no ammo; Shift+Tab goes back', () => {
    const base = field()
    const noFork = { ...base.ammo, clawd: { ...base.ammo.clawd, fork: 0 } }
    let w = field({ weapon: 'grenade', ammo: noFork })
    w = step(w, keys({ cycle: 1 }), FRAME)
    expect(w.weapon).toBe('ping')
    w = step(w, keys({ cycle: -1 }), FRAME)
    expect(w.weapon).toBe('grenade')
    w = step(w, keys({ pick: 'fork' }), FRAME)
    expect(w.weapon).toBe('grenade')
  })

  it("the bugs' turn takes its input from the driver and ignores the person's", () => {
    const s = field({ team: 'bug', active: 3, phase: 'bot' })
    const left: BotDriver = () => keys({ left: true })
    const w = run(s, keys({ right: true }), 1, left)
    const x = w.fighters[3].x
    expect(x).toBeGreaterThanOrEqual(669)
    expect(x).toBeLessThanOrEqual(671)
  })

  it('a turn that never comes to rest ends after settleMax', () => {
    const grenade: Shot = { kind: 'grenade', x: 300, y: 99, vx: 0, vy: 0, fuse: 1000, resting: true, owner: 0, age: 0 }
    let w = field({ phase: 'settle', used: true, retreat: 0, shots: [grenade] })
    w = run(w, keys(), ARTILLERY.settleMax + 0.1)
    expect(w.team).toBe('bug')
    expect(w.shots).toEqual([])
  })

  it('a fighter set down by settleMax over an empty column is out: the battle counts it', () => {
    // the Clawd at 500 is in the air over a hole that goes down past the water; the bug at 700 stands on rock
    const hole = flatGround(100)
    for (let y = 100; y < ARTILLERY.height; y++) for (let x = 480; x <= 520; x++) hole.cells[y * hole.w + x] = 0
    const s = field({
      ground: hole,
      phase: 'settle',
      used: true,
      retreat: 0,
      settleFor: ARTILLERY.settleMax,
      fighters: [
        fighter('clawd', 500, 50, { air: true, fallFrom: 50 }),
        fighter('clawd', 200, 99, { out: true }),
        fighter('clawd', 300, 99, { out: true }),
        fighter('bug', 700, 99),
        fighter('bug', 750, 99, { out: true }),
        fighter('bug', 800, 99, { out: true })
      ]
    })
    const w = step(s, keys(), FRAME)
    expect(w.fighters[0].out).toBe(true)
    expect(w.phase).toBe('over')
    expect(w.result).toBe('loss')
  })

  it('a shot out of the side still ends the turn', () => {
    const s = field({
      aim: 0,
      fighters: [
        fighter('clawd', 20, 99, { facing: -1 }),
        fighter('clawd', 200, 99, { out: true }),
        fighter('clawd', 300, 99, { out: true }),
        fighter('bug', 700, 99),
        fighter('bug', 750, 99, { out: true }),
        fighter('bug', 800, 99, { out: true })
      ]
    })
    const w = run(s, keys({ fire: true }), 1.2)
    expect(w.used).toBe(true)
    expect(w.shots).toHaveLength(0)
    const after = run(w, keys(), 5)
    expect(after.team).toBe('bug')
  })

  it('the camera follows a shot in flight and stays within the map', () => {
    let w = run(field({ aim: 45 }), keys({ fire: true }), 1.2)
    w = run(w, keys(), 1)
    expect(w.shots).toHaveLength(1)
    const shot = w.shots[0]
    expect(w.camera).toBeGreaterThan(0)
    expect(shot.x).toBeGreaterThanOrEqual(w.camera)
    expect(shot.x).toBeLessThanOrEqual(w.camera + ARTILLERY.view)
    expect(w.camera).toBeGreaterThanOrEqual(0)
    expect(w.camera).toBeLessThanOrEqual(ARTILLERY.width - ARTILLERY.view)
  })

  it('a fighter that drowns while drilling ends the battle: the drill stops with it', () => {
    // a drill straight down from the edge of a floor at row 125 runs into the water at 148
    const s = field({
      ground: flatGround(125),
      aim: -60,
      weapon: 'drill',
      fighters: [
        fighter('clawd', 50, 124),
        fighter('clawd', 200, 99, { out: true }),
        fighter('clawd', 300, 99, { out: true }),
        fighter('bug', 700, 99),
        fighter('bug', 750, 99, { out: true }),
        fighter('bug', 800, 99, { out: true })
      ]
    })
    let w = step(s, keys({ fire: true }), FRAME)
    w = run(w, keys(), 5)
    expect(w.fighters[0].out).toBe(true)
    expect(w.fighters[0].drill).toBeNull()
    expect(w.phase).toBe('over')
    expect(w.result).toBe('loss')
  })

  it('a sideways drill stops at the side of the map: the box stays inside', () => {
    const s = field({
      aim: 0,
      weapon: 'drill',
      fighters: [
        fighter('clawd', 20, 99, { facing: -1 }),
        fighter('clawd', 200, 99, { out: true }),
        fighter('clawd', 300, 99, { out: true }),
        fighter('bug', 700, 99),
        fighter('bug', 750, 99, { out: true }),
        fighter('bug', 800, 99, { out: true })
      ]
    })
    let w = step(s, keys({ fire: true }), FRAME)
    expect(w.fighters[0].drill).toEqual({ dx: -1, dy: 0, left: 40 })
    w = run(w, keys(), 2)
    expect(w.fighters[0].x).toBe(6)
    expect(w.fighters[0].drill).toBeNull()
  })

  it('a sideways drill that reaches a cliff edge stops there, and the fighter falls', () => {
    // rock to x 600 and again from 650: the drill digs right from 590, and once neither its feet nor its next disc touch rock, it stops
    const cliff = fill(fill(emptyGround(), 0, 100, 600, 159), 650, 100, ARTILLERY.width - 1, 159)
    const s = field({
      ground: cliff,
      aim: 0,
      weapon: 'drill',
      fighters: [
        fighter('clawd', 590, 99),
        fighter('clawd', 200, 99, { out: true }),
        fighter('clawd', 300, 99, { out: true }),
        fighter('bug', 700, 99),
        fighter('bug', 750, 99, { out: true }),
        fighter('bug', 800, 99, { out: true })
      ]
    })
    let w = step(s, keys({ fire: true }), FRAME)
    expect(w.fighters[0].drill).not.toBeNull()
    for (let i = 0; i < 4 / FRAME && !w.fighters[0].air; i++) w = step(w, keys(), FRAME)
    expect(w.fighters[0].air).toBe(true)
    expect(w.fighters[0].x).toBeLessThanOrEqual(612)
  })

  it("the bugs' turn has a clock too: with idleBot it passes to the Clawds after 45 s", () => {
    const w = run(field({ team: 'bug', active: 3, phase: 'bot' }), keys(), ARTILLERY.turnTime + 0.1)
    expect(w.team).toBe('clawd')
    expect(w.turn).toBe(2)
  })

  it('a driver that changes w.bot leaves the state it was given untouched', () => {
    const bot: BotTurn = {
      stage: 'think',
      planner: { list: [{ weapon: 'rocket', x: 700, facing: -1, aim: 30, power: 0.5, target: { x: 50, y: 99 }, retreat: 0 }], next: 0, best: null, bestScore: 0, stage: 'base' },
      choice: { weapon: 'rocket', x: 700, facing: -1, aim: 30, power: 0.5, target: { x: 50, y: 99 }, retreat: 0 },
      thought: 1,
      stuck: 0,
      lastX: 700,
      lastGap: 0,
      shots: 0
    }
    const s = field({ team: 'bug', active: 3, phase: 'bot', bot })
    const before = JSON.parse(JSON.stringify(s.bot))
    const driver: BotDriver = (w) => {
      if (w.bot) {
        w.bot.stage = 'walk'
        w.bot.planner.next = 5
        if (w.bot.choice) w.bot.choice.power = 1
      }
      return NO_INPUT
    }
    const w = step(s, NO_INPUT, FRAME, driver)
    expect(w.bot?.stage).toBe('walk')
    expect(s.bot).toEqual(before)
  })

  it('an input that arrives in a call with no fixed step is kept for the next one', () => {
    const a = step(field(), keys({ pick: 'grenade' }), 0.001)
    expect(a.weapon).toBe('rocket')
    const b = step(a, keys(), 0.02)
    expect(b.weapon).toBe('grenade')
  })

  it('a fire tap in such a call is kept too', () => {
    const a = step(field({ weapon: 'ping', aim: -20 }), keys({ fire: true }), 0.001)
    const b = step(a, keys(), 0.02)
    expect(b.pingLeft).toBe(1)
    expect(b.carved).toHaveLength(1)
  })

  it('an idle bot presses nothing', () => {
    expect(idleBot(field())).toEqual(NO_INPUT)
  })

  it('a resting battle is at rest, a flying shot is not', () => {
    expect(atRest(field())).toBe(true)
    const shot: Shot = { kind: 'rocket', x: 200, y: 50, vx: 0, vy: 0, fuse: null, resting: false, owner: 0, age: 0 }
    expect(atRest(field({ shots: [shot] }))).toBe(false)
  })
})
