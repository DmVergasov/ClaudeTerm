import { ARTILLERY, NO_INPUT, WEAPONS, botErrorScale } from './artillery-config'
import { airStep, drillStep, drillStops, fallDamage, grounded, jump, teleportOk, walk } from './artillery-bodies'
import { clearDisc, cloneGround, makeGround, spawnSpots, standY } from './artillery-ground'
import { deployBombs, dynamite, hurt, launch, pingRay, shotStep } from './artillery-shots'
import type {
  ArtilleryInput,
  ArtilleryRecord,
  ArtilleryResult,
  ArtilleryState,
  BotDriver,
  BotTurn,
  Candidate,
  Fighter,
  Ground,
  Impact,
  Shot,
  Team,
  WeaponId
} from './artillery-types'
import { seeded } from './random'

/** slack for the fixed-step loop, so that a frame of 0.1 s is 12 steps of 1/120 s and not 11 */
const EPSILON = 1e-9

/** what one fixed step did besides the state: whether its ground is already a copy, which fighters were hurt, and whether the turn's use went off */
interface Frame {
  copied: boolean
  hit: Set<number>
  used: boolean
}

/** the bugs' driver that presses nothing: they stand still until a real bot is given */
export const idleBot: BotDriver = () => NO_INPUT

/** a map from the seed, fighters on spawnSpots at standY, full ammo per team, water 148, phase 'title', battle = seed,
 *  seed = seed, botError = errorScale */
export function newBattle(seed: number, streak: number, errorScale = botErrorScale(streak)): ArtilleryState {
  const ground = makeGround(seed)
  const spots = spawnSpots(ground, seed)
  const fighters = [
    ...spots.clawd.map((x) => spawnFighter('clawd', x, ground)),
    ...spots.bug.map((x) => spawnFighter('bug', x, ground))
  ]
  return {
    phase: 'title',
    result: null,
    battle: seed,
    ground,
    carved: [],
    water: ARTILLERY.water,
    fighters,
    active: 0,
    team: 'clawd',
    next: { clawd: 0, bug: 3 },
    turn: 0,
    wind: 0,
    clock: ARTILLERY.turnTime,
    retreat: 0,
    ended: false,
    used: false,
    settleFor: 0,
    weapon: 'rocket',
    ammo: { clawd: ammoRow(), bug: ammoRow() },
    aim: ARTILLERY.startAim,
    power: 0,
    charging: false,
    fireHeld: false,
    pingLeft: 0,
    cursor: null,
    shots: [],
    blasts: [],
    camera: cameraAt(fighters[0].x),
    bot: null,
    botError: errorScale,
    seed,
    acc: 0,
    pending: { jump: false, pick: null, cycle: 0, fire: false }
  }
}

/** turn 1: the Clawds' fighter 0, phase 'aim' */
export function start(s: ArtilleryState): ArtilleryState {
  const w = copyState(s)
  w.turn = 1
  beginTurn(w, 'clawd')
  return w
}

/** advances the battle by dt seconds in fixed steps of ARTILLERY.step; dt is clamped to maxDt. jump, pick and cycle
 *  are used by the first step only; on the bugs' turn the input comes from drive and the person's is ignored. A battle
 *  that is on its title or over is returned as it is. The state s is never changed. */
export function step(s: ArtilleryState, input: ArtilleryInput, dt: number, drive: BotDriver = idleBot): ArtilleryState {
  if (!inBattle(s)) return s
  const w = copyState(s)
  // the edges of this call, with the ones kept from calls that ran no fixed step
  const edges = {
    jump: input.jump || s.pending.jump,
    pick: input.pick ?? s.pending.pick,
    cycle: input.cycle !== 0 ? input.cycle : s.pending.cycle,
    fire: input.fire || s.pending.fire
  }
  w.acc += clamp(dt, 0, ARTILLERY.maxDt)
  let first = true
  while (w.acc >= ARTILLERY.step - EPSILON && inBattle(w)) {
    w.acc -= ARTILLERY.step
    tick(w, first ? { ...input, ...edges } : { ...input, jump: false, pick: null, cycle: 0 }, drive)
    first = false
  }
  // no fixed step ran: the edges wait in the state for the next call
  w.pending = first ? edges : { jump: false, pick: null, cycle: 0, fire: false }
  return w
}

/** a charge cut off by a pause: the charge is dropped, the fire key counts as let go (so the next press is a new one), the input
 *  edges kept for the next step are dropped too, and nothing fires */
export function dropCharge(s: ArtilleryState): ArtilleryState {
  return { ...s, charging: false, power: 0, fireHeld: false, pending: { jump: false, pick: null, cycle: 0, fire: false } }
}

/** true while the battle is on: not on its title and not over */
export function inBattle(s: ArtilleryState): boolean {
  return s.phase !== 'title' && s.phase !== 'over'
}

/** true when no shot is in the air or resting and no fighter is in the air or drilling */
export function atRest(s: ArtilleryState): boolean {
  return s.shots.length === 0 && s.fighters.every((f) => f.out || (!f.air && !f.drill))
}

/** the hit points of the team's fighters, the out ones at 0 */
export function teamHp(s: ArtilleryState, team: Team): number {
  return s.fighters.filter((f) => f.team === team).reduce((sum, f) => sum + f.hp, 0)
}

/** the record after a battle: a win adds a win and a streak step (and sets the best); a loss or a draw ends the streak */
export function tally(r: ArtilleryRecord, result: ArtilleryResult): ArtilleryRecord {
  if (result !== 'win') return { wins: r.wins, streak: 0, best: r.best }
  const streak = r.streak + 1
  return { wins: r.wins + 1, streak, best: Math.max(r.best, streak) }
}

/** one fixed step: input, walking and jumping, aim or cursor, weapon, the fire key, the clock, the use, the physics,
 *  the phase and the next turn, the camera. Mutates w, which is the step's own copy. */
function tick(w: ArtilleryState, person: ArtilleryInput, drive: BotDriver): void {
  const input = w.team === 'bug' ? drive(w) : person
  const fr: Frame = { copied: false, hit: new Set(), used: false }
  const f = w.fighters[w.active]
  const before = w.phase === 'aim' || w.phase === 'bot'
  const moving = (w.phase === 'flight' || w.phase === 'retreat') && w.retreat > 0
  const canMove = !w.ended && !f.out && !f.drill && !w.charging && w.pingLeft === 0 && (before || moving)

  if (canMove && !w.cursor) {
    const dir = input.left === input.right ? 0 : input.left ? -1 : 1
    if (dir !== 0) walk(w.ground, f, dir, ARTILLERY.step)
    if (input.jump) jump(w.ground, f)
  }

  const pressed = input.fire && !w.fireHeld
  const released = !input.fire && w.fireHeld
  w.fireHeld = input.fire
  let fireNow = false
  if (before && !w.ended) {
    aimOrMoveCursor(w, input)
    const may = !w.charging && w.pingLeft === 0
    if (may && input.pick !== null && ammoOf(w, input.pick) > 0) choose(w, f, input.pick)
    else if (may && input.cycle !== 0) {
      const id = cycled(w, input.cycle)
      if (id !== null) choose(w, f, id)
    }
    const ready = ammoOf(w, w.weapon) > 0 || w.pingLeft > 0
    if (isPower(w.weapon)) {
      if (pressed && ready && !w.charging) {
        w.charging = true
        w.power = 0
      } else if (w.charging && input.fire) {
        w.power = Math.min(1, w.power + ARTILLERY.step / ARTILLERY.chargeTime)
        fireNow = w.power >= 1
      }
      if (w.charging && released) fireNow = true
    } else {
      fireNow = pressed && ready
    }
  }

  // the turn's clock runs down until the use, on both sides; at 0 the turn ends with no shot and any charge is dropped
  if (before && !w.ended) {
    w.clock = Math.max(0, w.clock - ARTILLERY.step)
    if (w.clock === 0) {
      w.ended = true
      w.charging = false
      w.power = 0
      fireNow = false
    }
  }

  if (fireNow) use(w, f, fr)
  physics(w, fr)
  phase(w, fr, before)
  follow(w)
}

/** the cursor moves with the arrows when it is shown (not past the sides or above the top, nor below the water); otherwise up and down turn the aim */
function aimOrMoveCursor(w: ArtilleryState, input: ArtilleryInput): void {
  const up = input.up === input.down ? 0 : input.up ? 1 : -1
  const side = input.right === input.left ? 0 : input.right ? 1 : -1
  if (w.cursor) {
    const move = ARTILLERY.cursorSpeed * ARTILLERY.step
    w.cursor = {
      x: clamp(w.cursor.x + side * move, 0, w.ground.w - 1),
      y: clamp(w.cursor.y - up * move, 0, w.water - 1)
    }
  } else {
    w.aim = clamp(w.aim + up * ARTILLERY.aimRate * ARTILLERY.step, -90, 90)
  }
}

/** the weapon in hand: Deploy and Teleport show a cursor above the feet, the others none */
function choose(w: ArtilleryState, f: Fighter, id: WeaponId): void {
  w.weapon = id
  w.cursor = id === 'deploy' || id === 'teleport' ? { x: f.x, y: f.y - ARTILLERY.cursorLift } : null
}

/** the next weapon in the bar from the one in hand, in dir (−1 back, 1 forward), that has ammo; null when none has */
function cycled(w: ArtilleryState, dir: -1 | 1): WeaponId | null {
  const n = WEAPONS.length
  const at = WEAPONS.findIndex((x) => x.id === w.weapon)
  for (let k = 1; k <= n; k++) {
    const id = WEAPONS[(((at + dir * k) % n) + n) % n].id
    if (ammoOf(w, id) > 0) return id
  }
  return null
}

/** the use of the weapon in hand by the active fighter f: its shot or effect, the ammo, the retreat, the charge dropped */
function use(w: ArtilleryState, f: Fighter, fr: Frame): void {
  const owner = w.active
  const weapon = w.weapon
  let retreat: number = ARTILLERY.retreatTime
  switch (weapon) {
    case 'rocket':
    case 'grenade':
    case 'fork':
      w.shots.push(launch(weapon, f, owner, w.aim, w.power))
      break
    case 'ping':
      // the first shot spends the ammo and leaves the aim free; the second shot ends the use
      if (w.pingLeft === 0) {
        w.pingLeft = 1
        spend(w)
        shootPing(w, fr)
        return
      }
      w.pingLeft = 0
      shootPing(w, fr)
      break
    case 'rmrf':
      w.shots.push(dynamite(f, owner))
      break
    case 'deploy':
      w.shots.push(...deployBombs(Math.round(cursorOf(w, f).x), owner))
      break
    case 'drill':
      // down when the aim is below −45 degrees, else to the side the fighter faces
      f.drill =
        w.aim < -45 ? { dx: 0, dy: 1, left: ARTILLERY.drillLength } : { dx: f.facing, dy: 0, left: ARTILLERY.drillLength }
      f.walked = 0
      break
    case 'teleport': {
      // a spot that is free, above the water, moves the fighter and ends the turn; any other is refused with nothing spent
      const c = cursorOf(w, f)
      const x = Math.round(c.x)
      const y = Math.round(c.y)
      if (!teleportOk(w.ground, w.water, x, y)) return
      f.x = x
      f.y = y
      f.vx = 0
      f.vy = 0
      f.fallFrom = y
      retreat = 0
      break
    }
  }
  if (weapon !== 'ping') spend(w)
  fr.used = true
  w.used = true
  w.retreat = retreat
  w.charging = false
  w.power = 0
  w.cursor = null
}

/** one of Ping's straight shots: its impact, unless it lands at or below the water */
function shootPing(w: ArtilleryState, fr: Frame): void {
  const impact = pingRay(w.ground, w.fighters, w.active, w.aim)
  if (impact && impact.y < w.water) blow(w, fr, impact)
}

/** the physics of one step: the fighters (drilling, flying, walking off a ledge, drowning, a landing's fall), the
 *  shots, the blasts, the retreat, and whether the active fighter was hurt or is out */
function physics(w: ArtilleryState, fr: Frame): void {
  const dt = ARTILLERY.step
  for (let i = 0; i < w.fighters.length; i++) {
    const g = w.fighters[i]
    if (g.out) continue
    // a drill that has left the rock and cuts no more ground stops, and the fighter falls like any other
    if (g.drill && drillStops(w.ground, g)) g.drill = null
    if (g.drill) {
      for (const d of drillStep(g, dt)) carve(w, fr, d.x, d.y, d.r)
    } else if (g.air) {
      const r = airStep(w.ground, g, dt, w.water)
      const damage = r.landed ? fallDamage(r.fall) : 0
      if (damage > 0) {
        g.hp = Math.max(0, g.hp - damage)
        fr.hit.add(i)
      }
    } else if (!grounded(w.ground, g)) {
      g.air = true
      g.fallFrom = g.y
      g.vx = 0
      g.vy = 0
    }
    if (!g.out && Math.round(g.y) >= w.water) g.out = true
    if (g.out) retire(g)
  }

  const kept: Shot[] = []
  const spawned: Shot[] = []
  for (const s of w.shots) {
    const r = shotStep(w.ground, w.fighters, s, w.wind, w.water, dt)
    if (r.impact) blow(w, fr, r.impact)
    spawned.push(...r.spawn)
    if (!r.gone) kept.push(s)
  }
  w.shots = kept.concat(spawned)

  for (const g of w.fighters) {
    if (!g.out && g.hp <= 0) {
      retire(g)
      w.blasts.push({ x: g.x, y: g.y - 5, r: ARTILLERY.puff, left: ARTILLERY.blastTime })
    }
  }
  w.blasts = w.blasts.map((b) => ({ ...b, left: b.left - dt })).filter((b) => b.left > 0)
  if (w.retreat > 0) w.retreat = Math.max(0, w.retreat - dt)

  const active = w.fighters[w.active]
  if (fr.hit.has(w.active) || active.out) {
    w.ended = true
    w.charging = false
    w.power = 0
  }
}

/** the phase after this step: a turn that is over settles; after a use the flight, the retreat or the settle; and in
 *  settle the time counts and the turn ends at rest or when settleMax is up */
function phase(w: ArtilleryState, fr: Frame, before: boolean): void {
  if (before && !fr.used && w.ended) {
    w.phase = 'settle'
  } else if (fr.used || w.phase === 'flight' || w.phase === 'retreat') {
    if (w.shots.length > 0 || w.fighters.some((g) => !g.out && g.drill)) w.phase = 'flight'
    else w.phase = w.retreat > 0 && !w.ended ? 'retreat' : 'settle'
  }
  if (w.phase !== 'settle') return
  w.settleFor += ARTILLERY.step
  const late = w.settleFor >= ARTILLERY.settleMax
  if (late) settleDown(w)
  if (late || atRest(w)) endTurn(w)
}

/** the camera glides towards the focus: the first shot in flight, else the cursor, else the active fighter */
function follow(w: ArtilleryState): void {
  const focus = w.shots.length > 0 ? w.shots[0] : (w.cursor ?? w.fighters[w.active])
  w.camera += (cameraAt(focus.x) - w.camera) * Math.min(1, ARTILLERY.cameraGlide * ARTILLERY.step)
}

/** the ground after an impact: a crater, the hurt fighters, and a blast to show */
function blow(w: ArtilleryState, fr: Frame, impact: Impact): void {
  carve(w, fr, impact.x, impact.y, impact.radius)
  for (const i of hurt(w.fighters, impact)) fr.hit.add(i)
  w.blasts.push({ x: impact.x, y: impact.y, r: impact.radius, left: ARTILLERY.blastTime })
}

/** clears a disc of the ground and records its box. The ground is copied once per step, the first time a step carves */
function carve(w: ArtilleryState, fr: Frame, x: number, y: number, r: number): void {
  if (!fr.copied) {
    w.ground = cloneGround(w.ground)
    fr.copied = true
  }
  const box = clearDisc(w.ground, x, y, r)
  if (box) w.carved.push(box)
}

/** the turn's rest: the flying fighters and the shots are set down, the fighters drop their drills */
function settleDown(w: ArtilleryState): void {
  w.shots = []
  for (const g of w.fighters) {
    if (g.out || !(g.air || g.drill)) continue
    g.x = Math.round(g.x)
    g.y = standY(w.ground, g.x)
    g.air = false
    g.drill = null
    g.vx = 0
    g.vy = 0
    g.fallFrom = g.y
    // feet at or below the water: the fighter is out, as if it had drowned
    if (Math.round(g.y) >= w.water) retire(g)
  }
}

/** the end of a turn: a side with nobody left loses (both at once is a draw), otherwise the next turn starts */
function endTurn(w: ArtilleryState): void {
  const clawds = alive(w, 'clawd')
  const bugs = alive(w, 'bug')
  if (!clawds && !bugs) endBattle(w, 'draw')
  else if (!bugs) endBattle(w, 'win')
  else if (!clawds) endBattle(w, 'loss')
  else nextTurn(w)
}

function endBattle(w: ArtilleryState, result: ArtilleryResult): void {
  w.result = result
  w.ended = true
  w.phase = 'over'
}

/** the other team's turn: the water rises from floodFrom on, and the wind is drawn anew */
function nextTurn(w: ArtilleryState): void {
  w.turn += 1
  if (w.turn >= ARTILLERY.floodFrom) w.water -= ARTILLERY.floodRise
  beginTurn(w, w.team === 'clawd' ? 'bug' : 'clawd')
}

/** the start of a turn for team: its next living fighter, a fresh wind, a full clock and a fresh weapon in hand */
function beginTurn(w: ArtilleryState, team: Team): void {
  w.team = team
  w.active = pickActive(w, team)
  w.wind = Math.round((draw(w) * 2 - 1) * ARTILLERY.windMax)
  w.clock = ARTILLERY.turnTime
  w.retreat = 0
  w.ended = false
  w.used = false
  w.settleFor = 0
  w.weapon = 'rocket'
  w.aim = ARTILLERY.startAim
  w.power = 0
  w.charging = false
  w.cursor = null
  w.pingLeft = 0
  w.bot = null
  w.phase = team === 'clawd' ? 'aim' : 'bot'
}

/** the team's next living fighter in rotation from next[team], and the one after it becomes next */
function pickActive(w: ArtilleryState, team: Team): number {
  const base = team === 'clawd' ? 0 : 3
  for (let k = 0; k < 3; k++) {
    const i = base + ((w.next[team] - base + k) % 3)
    if (!w.fighters[i].out) {
      w.next[team] = base + ((i - base + 1) % 3)
      return i
    }
  }
  return w.next[team]
}

/** one draw from the battle's seed, which moves on */
function draw(w: ArtilleryState): number {
  const rng = seeded(w.seed)
  const v = rng.next()
  w.seed = rng.seed()
  return v
}

/** a copy of the state whose fighters, shots, carved list, ammo, next, cursor and blasts can be changed without touching s */
function copyState(s: ArtilleryState): ArtilleryState {
  return {
    ...s,
    fighters: s.fighters.map((f) => ({ ...f, drill: f.drill ? { ...f.drill } : null })),
    shots: s.shots.map((x) => ({ ...x })),
    blasts: s.blasts.slice(),
    carved: s.carved.slice(),
    next: { ...s.next },
    ammo: { clawd: { ...s.ammo.clawd }, bug: { ...s.ammo.bug } },
    cursor: s.cursor ? { ...s.cursor } : null,
    bot: s.bot ? copyBot(s.bot) : null
  }
}

/** the bot's turn copied so that a driver may change the copy's planner, stage or choice. The planner's list is shared:
 *  a candidate is never changed once listed, and a search that moves on makes a new list. */
function copyBot(b: BotTurn): BotTurn {
  const candidate = (c: Candidate): Candidate => ({ ...c, target: c.target ? { ...c.target } : null })
  return {
    ...b,
    planner: {
      ...b.planner,
      best: b.planner.best ? candidate(b.planner.best) : null
    },
    choice: b.choice ? candidate(b.choice) : null
  }
}

function spawnFighter(team: Team, x: number, g: Ground): Fighter {
  const y = standY(g, x)
  return {
    team,
    x,
    y,
    vx: 0,
    vy: 0,
    hp: ARTILLERY.hp,
    facing: team === 'clawd' ? 1 : -1,
    air: false,
    fallFrom: y,
    walked: 0,
    drill: null,
    out: false
  }
}

function ammoRow(): Record<WeaponId, number> {
  return Object.fromEntries(WEAPONS.map((x) => [x.id, x.ammo])) as Record<WeaponId, number>
}

/** the camera's x for a focus at x: centred, and within the map */
function cameraAt(x: number): number {
  return clamp(x - ARTILLERY.view / 2, 0, ARTILLERY.width - ARTILLERY.view)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function ammoOf(w: ArtilleryState, id: WeaponId): number {
  return w.ammo[w.team][id]
}

/** one shot less of the weapon in hand, unless the ammo is ∞ */
function spend(w: ArtilleryState): void {
  const row = w.ammo[w.team]
  if (row[w.weapon] !== Infinity) row[w.weapon] -= 1
}

function isPower(id: WeaponId): boolean {
  return WEAPONS.some((x) => x.id === id && x.power)
}

function cursorOf(w: ArtilleryState, f: Fighter): { x: number; y: number } {
  return w.cursor ?? { x: f.x, y: f.y - ARTILLERY.cursorLift }
}

/** a fighter that is out: no hp, not in the air, no drill */
function retire(g: Fighter): void {
  g.out = true
  g.hp = 0
  g.air = false
  g.drill = null
}

function alive(w: ArtilleryState, team: Team): boolean {
  return w.fighters.some((f) => f.team === team && !f.out)
}
