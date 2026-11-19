import { airStep, teleportOk, walk } from './artillery-bodies'
import { ARTILLERY, BOT, NO_INPUT, PING, WEAPONS } from './artillery-config'
import { clearDisc, cloneGround, standY } from './artillery-ground'
import { deployBombs, effect, impactOf, launch, pingRay, shotStep } from './artillery-shots'
import type {
  ArtilleryInput,
  ArtilleryState,
  BotDriver,
  BotTurn,
  Candidate,
  Fighter,
  Ground,
  Impact,
  Planner,
  Shot,
  WeaponId
} from './artillery-types'
import { seeded } from './random'

const DT = ARTILLERY.step
const DEG = Math.PI / 180

/** the state as the candidate's shot finds it: the shooter at c.x on the ground there, or at its real feet when c.x is where it
 *  stands, facing c.facing. The other fighters, the ground, the wind and the water are as they are. Never changes s. */
function standing(s: ArtilleryState, c: Candidate): ArtilleryState {
  const fighters = s.fighters.map((f) => ({ ...f }))
  const shooter = fighters[s.active]
  if (c.x !== shooter.x) {
    shooter.x = c.x
    shooter.y = standY(s.ground, c.x)
  }
  shooter.facing = c.facing
  return { ...s, fighters }
}

/** the substeps a body or shot takes in one step at its speed, at least 1 */
function substeps(vx: number, vy: number): number {
  return Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(vy)) * DT))
}

/** a copy of the ground with the impact's disc cut out; the given ground is not changed */
function carveDisc(g: Ground, imp: Impact): Ground {
  const out = cloneGround(g)
  clearDisc(out, imp.x, imp.y, imp.radius)
  return out
}

/** the shot's impacts as the rules would make them, on the ground as it is, the shooter standing at (c.x, standY). An
 *  impact cuts its crater before the shots still in the air fly on, as the rules do: a fork's bomblets, a deploy's first
 *  two bombs. The ground is copied only for that: a single impact (a rocket, a grenade, the last bomb, a ping) keeps the
 *  ground it was given, so no copy is made, and the copies are not made per candidate for nothing. Also returns the
 *  ground after the impacts, for the push flights of score. cost: simulated substeps. Never changes s. */
export function predict(s: ArtilleryState, c: Candidate): { impacts: Impact[]; cost: number; ground: Ground } {
  const impacts: Impact[] = []
  const at = standing(s, c)
  let ground = at.ground
  let copied = false
  let cost = 0
  const carve = (imp: Impact): void => {
    if (!copied) {
      ground = cloneGround(ground)
      copied = true
    }
    clearDisc(ground, imp.x, imp.y, imp.radius)
  }

  let shots: Shot[] = []
  switch (c.weapon) {
    case 'rocket':
    case 'grenade':
    case 'fork':
      shots = [launch(c.weapon, at.fighters[s.active], s.active, c.aim, c.power)]
      break
    case 'deploy':
      if (c.target) shots = deployBombs(Math.round(c.target.x), s.active)
      break
    case 'ping':
      // the second ray is not cut through the first one's crater: the ground is never copied for a ping
      for (let k = 0; k < PING.shots; k++) {
        cost += PING.range
        const imp = pingRay(ground, at.fighters, s.active, c.aim)
        if (imp && imp.y < at.water) impacts.push(imp)
      }
      break
  }

  for (let t = 0; t < BOT.simMax && shots.length > 0; t += DT) {
    const next: Shot[] = []
    for (let i = 0; i < shots.length; i++) {
      const sh = shots[i]
      cost += substeps(sh.vx, sh.vy)
      const r = shotStep(ground, at.fighters, sh, at.wind, at.water, DT)
      if (r.impact) {
        impacts.push(r.impact)
        // a crater is cut only when a shot still flies after this impact
        if (i + 1 < shots.length || next.length > 0 || r.spawn.length > 0) carve(r.impact)
      }
      if (!r.gone) next.push(sh)
      next.push(...r.spawn)
    }
    shots = next
  }
  return { impacts, cost, ground }
}

/** + damage to Clawds (capped at hp) + killBonus a kill + drownBonus a push into the water (each pushed fighter flown
 *  with airStep up to pushSim s); − ownWeight × the same for bugs; cost: the push flights' substeps */
export function score(s: ArtilleryState, impacts: Impact[]): { score: number; cost: number } {
  const fighters = s.fighters
  const left = fighters.map((f) => f.hp)
  const hit = fighters.map(() => false)
  const push = fighters.map(() => ({ vx: 0, vy: 0 }))
  let total = 0
  let cost = 0
  const weight = (f: Fighter): number => (f.team === 'clawd' ? 1 : -BOT.ownWeight)

  for (const imp of impacts) {
    fighters.forEach((f, i) => {
      if (f.out || left[i] <= 0) return
      const e = effect(f, imp)
      if (!e) return
      total += weight(f) * Math.min(left[i], e.damage)
      left[i] -= e.damage
      if (left[i] <= 0) total += weight(f) * BOT.killBonus
      hit[i] = true
      push[i].vx += e.vx
      push[i].vy += e.vy
    })
  }

  fighters.forEach((f, i) => {
    if (!hit[i] || left[i] <= 0) return
    const g: Fighter = { ...f, vx: f.vx + push[i].vx, vy: f.vy + push[i].vy, air: true, fallFrom: f.y }
    for (let t = 0; t < BOT.pushSim && g.air && !g.out; t += DT) {
      cost += substeps(g.vx, g.vy)
      airStep(s.ground, g, DT, s.water)
    }
    if (g.out) total += weight(f) * BOT.drownBonus
  })

  return { score: total, cost }
}

/** a grid of rocket-like candidates appended to list: aims from aimFrom to aimTo by aimStep, each of powers, at x facing facing */
function grid(list: Candidate[], weapon: WeaponId, x: number, facing: -1 | 1, aimStep: number, powers: readonly number[]): void {
  for (let aim = BOT.aimFrom; aim <= BOT.aimTo; aim += aimStep) {
    for (const power of powers) list.push({ weapon, x, facing, aim, power, target: null, retreat: 0 })
  }
}

/** the facing of a fighter at from that looks at to; fallback when they stand at the same x */
function sideOf(from: number, to: number, fallback: -1 | 1): -1 | 1 {
  if (to > from) return 1
  if (to < from) return -1
  return fallback
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** the living Clawd nearest the point from, or null when none is left */
function nearestClawd(s: ArtilleryState, from: { x: number; y: number }): Fighter | null {
  let best: Fighter | null = null
  let bestD = Infinity
  for (const g of s.fighters) {
    if (g.team !== 'clawd' || g.out) continue
    const d = dist(g, from)
    if (d < bestD) {
      best = g
      bestD = d
    }
  }
  return best
}

/** the x midway between the two living Clawds that stand closest together, when they are within clusterGap px; else null */
function clusterMiddle(s: ArtilleryState): number | null {
  const clawds = s.fighters.filter((g) => g.team === 'clawd' && !g.out)
  let middle: number | null = null
  let gap = Infinity
  for (let i = 0; i < clawds.length; i++) {
    for (let j = i + 1; j < clawds.length; j++) {
      const d = dist(clawds[i], clawds[j])
      if (d <= BOT.clusterGap && d < gap) {
        gap = d
        middle = (clawds[i].x + clawds[j].x) / 2
      }
    }
  }
  return middle
}

/** true when the impact's cell lies in the body box of f (x − 6 … x + 5, y − 9 … y) */
function inBody(f: Fighter, imp: Impact): boolean {
  const x = Math.round(imp.x)
  const y = Math.round(imp.y)
  return x >= f.x - ARTILLERY.halfW && x < f.x + ARTILLERY.halfW && y > f.y - ARTILLERY.bodyH && y <= f.y
}

/** true when the fighter, walking dir, reaches px px away without a wall or a ledge in the way */
function walkable(s: ArtilleryState, f: Fighter, dir: -1 | 1, px: number): boolean {
  const g = { ...f }
  const steps = Math.ceil((px / (ARTILLERY.walkSpeed * DT)) * 2)
  for (let i = 0; i < steps; i++) {
    walk(s.ground, g, dir, DT)
    if (g.air) return false
    if (Math.abs(g.x - f.x) >= px) return true
  }
  return false
}

/** Ping at the Clawd: aimed at its body's middle, when the straight shot from the bot's x hits that body first */
function pingCandidate(s: ArtilleryState, f: Fighter, clawd: Fighter): Candidate | null {
  const dx = clawd.x - f.x
  const facing = sideOf(f.x, clawd.x, f.facing)
  const aim = Math.min(90, Math.max(-90, Math.atan2(-(clawd.y - f.y), Math.abs(dx)) / DEG))
  const c: Candidate = { weapon: 'ping', x: f.x, facing, aim, power: 0, target: { x: clawd.x, y: clawd.y - 5 }, retreat: 0 }
  const at = standing(s, c)
  const imp = pingRay(at.ground, at.fighters, s.active, aim)
  return imp && inBody(clawd, imp) ? c : null
}

/** rm -rf at the bot's x, when a walk of rmrfAway px away from the Clawd is possible; the retreat is that walk */
function rmrfCandidate(s: ArtilleryState, f: Fighter, clawd: Fighter): Candidate | null {
  const retreat = sideOf(clawd.x, f.x, 1)
  if (!walkable(s, f, retreat, BOT.rmrfAway)) return null
  return { weapon: 'rmrf', x: f.x, facing: f.facing, aim: s.aim, power: 0, target: null, retreat }
}

/** the base grid: rocket then grenade, facing −1 then 1, aim aimFrom … aimTo by aimStep, each of powers, at the current x,
 *  retreat 0; then, with two Clawds close together, a Fork bomb grid on their side and a Deploy at their middle; then a Ping
 *  and an rm -rf when a Clawd is near enough, each with ammo. Ammo of 0 leaves a weapon out. */
export function makePlanner(s: ArtilleryState): Planner {
  const f = s.fighters[s.active]
  const x = f.x
  const list: Candidate[] = []
  for (const weapon of ['rocket', 'grenade'] as const) {
    for (const facing of [-1, 1] as const) grid(list, weapon, x, facing, BOT.aimStep, BOT.powers)
  }

  const ammo = s.ammo[s.team]
  const middle = clusterMiddle(s)
  if (middle !== null) {
    if (ammo.fork > 0) grid(list, 'fork', x, sideOf(x, middle, f.facing), BOT.aimStep, BOT.powers)
    if (ammo.deploy > 0) {
      list.push({ weapon: 'deploy', x, facing: f.facing, aim: s.aim, power: 0, target: { x: Math.round(middle), y: f.y - ARTILLERY.cursorLift }, retreat: 0 })
    }
  }

  const near = nearestClawd(s, f)
  if (near && dist(near, f) <= BOT.pingReach && ammo.ping > 0) {
    const ping = pingCandidate(s, f, near)
    if (ping) list.push(ping)
  }
  if (near && dist(near, f) <= BOT.rmrfReach && ammo.rmrf > 0) {
    const rmrf = rmrfCandidate(s, f, near)
    if (rmrf) list.push(rmrf)
  }
  return { list, next: 0, best: null, bestScore: -Infinity, stage: 'base' }
}

/** the spots 30 px either side of the bot that a walk reaches: rockets facing the nearest Clawd, aimed by spotAimStep */
function spotCandidates(s: ArtilleryState): Candidate[] {
  const f = s.fighters[s.active]
  const list: Candidate[] = []
  for (const dir of [-1, 1] as const) {
    if (!walkable(s, f, dir, BOT.spotOffset)) continue
    const to = f.x + dir * BOT.spotOffset
    const near = nearestClawd(s, { x: to, y: f.y })
    if (near) grid(list, 'rocket', to, sideOf(to, near.x, dir), BOT.spotAimStep, BOT.spotPowers)
  }
  return list
}

/** the free spot above the water that lies teleportNear px from the Clawd at cx, nearest the middle of that range; null when none */
function teleportSpot(s: ArtilleryState, cx: number): { x: number; y: number } | null {
  const [lo, hi] = BOT.teleportNear
  const mid = (lo + hi) / 2
  let best: { x: number; y: number } | null = null
  let bestGap = Infinity
  for (let x = 0; x < s.ground.w; x++) {
    const d = Math.abs(x - cx)
    if (d < lo || d > hi) continue
    const y = standY(s.ground, x)
    if (!teleportOk(s.ground, s.water, x, y)) continue
    if (Math.abs(d - mid) < bestGap) {
      best = { x, y }
      bestGap = Math.abs(d - mid)
    }
  }
  return best
}

/** Teleport to a free spot near the nearest Clawd when it has ammo, else Drill toward it when it has ammo; each scored 1 */
function lastCandidates(s: ArtilleryState): Candidate[] {
  const f = s.fighters[s.active]
  const near = nearestClawd(s, f)
  if (!near) return []
  const ammo = s.ammo[s.team]
  const spot = ammo.teleport > 0 ? teleportSpot(s, near.x) : null
  if (spot) return [{ weapon: 'teleport', x: f.x, facing: f.facing, aim: s.aim, power: 0, target: spot, retreat: 0 }]
  if (ammo.drill > 0) {
    return [{ weapon: 'drill', x: f.x, facing: sideOf(f.x, near.x, f.facing), aim: 0, power: 0, target: null, retreat: 0 }]
  }
  return []
}

/** the fighter after its retreat: walked dir for retreatTime s in fixed steps on a copy, and stopped early when it
 *  stops moving (a wall) or starts to fall (a ledge). Never changes f. */
function retreated(s: ArtilleryState, f: Fighter, dir: -1 | 1): Fighter {
  let g = { ...f }
  const steps = Math.ceil(ARTILLERY.retreatTime / DT)
  for (let i = 0; i < steps; i++) {
    const next = { ...g }
    walk(s.ground, next, dir, DT)
    // a wall keeps the fighter where it is and resets its cadence to 0
    if (next.air || (next.x === g.x && next.walked === 0)) break
    g = next
  }
  return g
}

/** the score of a candidate and the work it took. rm -rf is the dynamite at the feet, scored with the bot where its
 *  retreat really takes it (retreatTime s of walking); Teleport and Drill score 1 without a simulation; the others are
 *  simulated by predict. */
function evaluate(s: ArtilleryState, c: Candidate): { score: number; cost: number } {
  if (c.weapon === 'teleport' || c.weapon === 'drill') return { score: 1, cost: 1 }
  if (c.weapon === 'rmrf') {
    const feet = standing(s, c).fighters[s.active]
    const imp = impactOf('dynamite', feet.x, feet.y)
    const fighters = s.fighters.map((g) => ({ ...g }))
    fighters[s.active] = retreated(s, feet, c.retreat === 0 ? 1 : c.retreat)
    const sc = score({ ...s, fighters, ground: carveDisc(s.ground, imp) }, [imp])
    return { score: sc.score, cost: sc.cost + 1 }
  }
  const sim = predict(s, c)
  const sc = score({ ...standing(s, c), ground: sim.ground }, sim.impacts)
  return { score: sc.score, cost: sim.cost + sc.cost }
}

/** the search's next stage once its list is tried: spots when no shot scores above spotThreshold, last when none scores
 *  above 0, else done */
function advance(p: Planner, s: ArtilleryState): Planner {
  if (p.stage === 'base' && p.bestScore <= BOT.spotThreshold) return { ...p, stage: 'spots', list: spotCandidates(s), next: 0 }
  if (p.stage === 'spots' && p.bestScore <= 0) return { ...p, stage: 'last', list: lastCandidates(s), next: 0 }
  return { ...p, stage: 'done' }
}

/** evaluates candidates in order until `budget` substeps are spent, moving on to the next stage when a list is tried; keeps
 *  the best (ties: the earlier one). The lists of later stages are made from the state here, never changed once made. */
export function plan(p: Planner, s: ArtilleryState, budget: number): Planner {
  let cur = p
  let spent = 0
  while (cur.stage !== 'done' && spent < budget) {
    if (cur.next >= cur.list.length) {
      cur = advance(cur, s)
      continue
    }
    const c = cur.list[cur.next]
    const ev = evaluate(s, c)
    spent += ev.cost
    const better = ev.score > cur.bestScore
    cur = { ...cur, next: cur.next + 1, best: better ? c : cur.best, bestScore: better ? ev.score : cur.bestScore }
  }
  return cur
}

/** aim ± aimError × botError, power ± powerError × botError (power clamped 0.1 … 1), drawn from w.seed (advanced) */
export function withError(c: Candidate, w: ArtilleryState): Candidate {
  const r = seeded(w.seed)
  const aim = c.aim + (r.next() * 2 - 1) * BOT.aimError * w.botError
  const power = c.power + (r.next() * 2 - 1) * BOT.powerError * w.botError
  w.seed = r.seed()
  return { ...c, aim: Math.min(90, Math.max(-90, aim)), power: Math.min(1, Math.max(0.1, power)) }
}

/** the weapons that charge: the fire key holds the power, and the shot goes off on release */
function chargesPower(id: WeaponId): boolean {
  return WEAPONS.some((x) => x.id === id && x.power)
}

/** true when the active fighter's next walk step in dir keeps it on the ground: a ledge would start a fall. Never changes w. */
function nextStepOnGround(w: ArtilleryState, dir: -1 | 1): boolean {
  const g = { ...w.fighters[w.active], walked: 1 }
  walk(w.ground, g, dir, DT)
  return !g.air
}

/** the input that holds the retreat of the choice while it lasts and the next step stays on the ground; nothing otherwise */
function holdRetreat(w: ArtilleryState, b: BotTurn): ArtilleryInput {
  const r = b.choice ? b.choice.retreat : 0
  if (r === 0 || w.retreat <= 0) return NO_INPUT
  if (!nextStepOnGround(w, r < 0 ? -1 : 1)) return NO_INPUT
  return { ...NO_INPUT, left: r < 0, right: r > 0 }
}

/** a turn's start: thinking, no choice, the stuck timer at zero, the x it stands at */
function newTurn(w: ArtilleryState): BotTurn {
  return {
    stage: 'think',
    planner: makePlanner(w),
    choice: null,
    thought: BOT.thinkMin,
    stuck: 0,
    lastX: w.fighters[w.active].x,
    lastGap: Infinity,
    shots: 0
  }
}

/** the bugs' player: think (plan with BOT.budget a step, at least thinkMin s) → walk to c.x (stuck stuckFor s ends it) →
 *  face → pick → aim or move the cursor → fire (charge to c.power and release; a press for the others, two for Ping) →
 *  done; after the use holds c.retreat while retreat lasts. Walking comes before the pick: a shown cursor stops walking.
 *  The press style follows the weapon in hand; a weapon other than the choice is never fired. The bot's own turn state
 *  is w.bot, made on the turn's first call. */
export const driveBot: BotDriver = (w) => {
  if (!w.bot) w.bot = newTurn(w)
  const b = w.bot
  const f = w.fighters[w.active]
  const c = b.choice

  switch (b.stage) {
    case 'think': {
      b.planner = plan(b.planner, w, BOT.budget)
      b.thought -= DT
      if (b.thought <= 0 && b.planner.stage === 'done') {
        b.choice = b.planner.best ? withError(b.planner.best, w) : null
        b.stage = b.choice ? 'walk' : 'done'
      }
      return NO_INPUT
    }

    case 'walk': {
      if (c === null) {
        b.stage = 'done'
        return NO_INPUT
      }
      const at = Math.round(f.x)
      b.stuck = at === b.lastX ? b.stuck + DT : 0
      b.lastX = at
      if (at === c.x || b.stuck >= BOT.stuckFor) {
        b.stage = 'face'
        return NO_INPUT
      }
      return { ...NO_INPUT, left: c.x < at, right: c.x > at }
    }

    case 'face': {
      if (c === null || f.facing === c.facing) {
        b.stage = 'pick'
        return NO_INPUT
      }
      return { ...NO_INPUT, left: c.facing < 0, right: c.facing > 0 }
    }

    case 'pick': {
      b.stage = 'aim'
      if (c !== null && w.weapon !== c.weapon) return { ...NO_INPUT, pick: c.weapon }
      return NO_INPUT
    }

    case 'aim': {
      if (c === null) {
        b.stage = 'fire'
        return NO_INPUT
      }
      // the cursor or the aim moves a whole step at a time: within half a step is as good as there, and a goal that
      // no press brings closer (the rules clamp it) is given up after stuckFor s without progress
      let dx = 0
      let dy = 0
      let gap: number
      let half: number
      if (w.cursor) {
        if (!c.target) {
          b.stage = 'fire'
          return NO_INPUT
        }
        dx = c.target.x - w.cursor.x
        dy = c.target.y - w.cursor.y
        gap = Math.abs(dx) + Math.abs(dy)
        half = (ARTILLERY.cursorSpeed * DT) / 2
      } else {
        dy = c.aim - w.aim
        gap = Math.abs(dy)
        half = (ARTILLERY.aimRate * DT) / 2
      }
      b.stuck = gap < b.lastGap - 1e-9 ? 0 : b.stuck + DT
      b.lastGap = gap
      const settled = w.cursor ? Math.abs(dx) <= half && Math.abs(dy) <= half : Math.abs(dy) <= half
      if (settled || b.stuck >= BOT.stuckFor) {
        b.stage = 'fire'
        return NO_INPUT
      }
      if (w.cursor) return { ...NO_INPUT, right: dx > half, left: dx < -half, up: dy < -half, down: dy > half }
      return { ...NO_INPUT, up: dy > 0, down: dy < 0 }
    }

    case 'fire': {
      if (w.used || c === null) {
        b.stage = 'done'
        return holdRetreat(w, b)
      }
      // a refused pick leaves another weapon in hand: then nothing is fired, and the turn's clock ends it
      const weapon = w.weapon
      if (weapon !== c.weapon) {
        b.stage = 'done'
        return holdRetreat(w, b)
      }
      if (chargesPower(weapon)) {
        if (!w.charging) {
          b.shots++
          return { ...NO_INPUT, fire: true }
        }
        // hold until the power reaches c.power (within half a step), then let go, which fires
        const more = w.power + DT / ARTILLERY.chargeTime / 2 < c.power
        return more ? { ...NO_INPUT, fire: true } : NO_INPUT
      }
      // a press per shot; a press needs the key up first, so the presses alternate with a release
      const presses = weapon === 'ping' ? 2 : 1
      if (b.shots < presses && !w.fireHeld) {
        b.shots++
        return { ...NO_INPUT, fire: true }
      }
      return NO_INPUT
    }

    default:
      return holdRetreat(w, b)
  }
}
