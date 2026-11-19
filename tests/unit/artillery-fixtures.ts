import { ARTILLERY } from '../../src/renderer/games/artillery-config'
import type { ArtilleryState, Fighter, Ground, Team } from '../../src/renderer/games/artillery-types'
import { newBattle, start } from '../../src/renderer/games/artillery-rules'

/** an empty map of the game's size: no ground at all */
export function emptyGround(): Ground {
  return { w: ARTILLERY.width, h: ARTILLERY.height, cells: new Uint8Array(ARTILLERY.width * ARTILLERY.height) }
}

/** a map whose rows top … the bottom are ground, flat from edge to edge */
export function flatGround(top: number): Ground {
  return fill(emptyGround(), 0, top, ARTILLERY.width - 1, ARTILLERY.height - 1)
}

/** sets the inclusive rectangle x0…x1, y0…y1 to ground, in place; returns the same map */
export function fill(g: Ground, x0: number, y0: number, x1: number, y1: number): Ground {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) g.cells[y * g.w + x] = 1
  }
  return g
}

/** a fighter at rest at (x, y), with 100 hp, facing right for the Clawds and left for the bugs; `over` sets any field */
export function fighter(team: Team, x: number, y: number, over: Partial<Fighter> = {}): Fighter {
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
    out: false,
    ...over
  }
}

/** a battle on its first turn with no wind: the map of seed 1, the fighters on their spots, and `over` sets any field */
export function battle(over: Partial<ArtilleryState> = {}): ArtilleryState {
  return { ...start(newBattle(1, 0, 0)), wind: 0, ...over }
}
