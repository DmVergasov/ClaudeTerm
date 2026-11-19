import type { ArtilleryInput, WeaponId } from './artillery-types'

/**
 * Artillery's numbers, tuned by play. Map px with y down, seconds, px/s, degrees: an aim of 0 is level and more is up.
 */
export const ARTILLERY = {
  /** the map's size in cells: 828 across, 160 down, of which the view shows 276 */
  width: 828,
  height: 160,
  view: 276,
  /** the minimap's top row */
  minimapTop: 58,
  /** the fixed physics step, and the longest frame it catches up on */
  step: 1 / 120,
  maxDt: 0.1,
  /** the surface stays between these rows, and the water starts at water */
  groundTop: 60,
  groundBottom: 140,
  water: 148,
  /** pull on the bodies and shots, px/s² */
  gravity: 150,
  /** the strongest wind, px/s² */
  windMax: 50,
  /** hit points a fighter starts with */
  hp: 100,
  /** the body box: 6 px left of the feet, 5 right, 10 tall */
  halfW: 6,
  bodyH: 10,
  /** walking speed, and the most a fighter climbs in one step */
  walkSpeed: 30,
  climb: 3,
  /** the jump's sideways and upward speeds */
  jumpVx: 40,
  jumpVy: 80,
  /** a fall of up to fallSafe rows does no harm; each row past it costs fallDamage hp */
  fallSafe: 30,
  fallDamage: 0.5,
  /** the upward speed of a fighter that lands hard enough to bounce */
  landBounce: 100,
  /** the share of its speed a fighter keeps, reversed, when it hits a wall or bounces off a landing (a ceiling just stops it) */
  bounce: 0.3,
  /** the share of its sideways speed a fighter keeps when a landing bounces it */
  sideBounce: 0.5,
  /** a shot can touch its own owner's fighter only after this many seconds in the air, so it clears the muzzle */
  ownGrace: 0.1,
  /** the small blast a fighter makes when its hp runs out, cells */
  puff: 6,
  /** how fast the aim and the cursor move, degrees/s and px/s */
  aimRate: 60,
  cursorSpeed: 120,
  /** the cursor of Deploy and Teleport starts this far above the feet, px */
  cursorLift: 30,
  /** the aim a turn starts at, degrees */
  startAim: 30,
  /** the power charge takes chargeTime seconds to fill; a shot's speed runs from minSpeed to maxSpeed */
  chargeTime: 1,
  minSpeed: 60,
  maxSpeed: 300,
  /** the shot starts muzzle px from the feet */
  muzzle: 10,
  /** a fighter within damageReach cells of a hit's edge is hurt */
  damageReach: 1.5,
  /** the share of a hit's push that lifts the fighter off the ground */
  lift: 0.4,
  /** seconds in a turn, and the retreat after a shot */
  turnTime: 45,
  retreatTime: 3,
  /** from turn floodFrom on, the water rises floodRise px at the start of each turn */
  floodFrom: 31,
  floodRise: 4,
  /** the longest the ground may take to settle after a blast, seconds */
  settleMax: 10,
  /** the gap between the teams' spawn spots, px */
  spawnGap: 40,
  /** how fast the camera glides to follow the action, per second */
  cameraGlide: 6,
  /** how long a blast is shown, seconds */
  blastTime: 0.3,
  /** a shot that has flown this long is removed, seconds */
  shotMaxAge: 12,
  /** a shot slower than this px/s counts as resting */
  restSpeed: 15,
  /** a drill digs drillLength cells in drillTime seconds, with holes of drillRadius */
  drillLength: 40,
  drillTime: 1.5,
  drillRadius: 8
} as const

/** the shots: the blast radius in cells, the damage and push at the centre, whether wind pushes it, its fuse in seconds, and its bounce */
export const SHOTS = {
  /** the rocket flies on wind and goes off on impact */
  rocket:   { radius: 14, damage: 45, push: 110, wind: true,  fuse: null, bounce: 0 },
  /** the grenade ignores wind, bounces and goes off after its fuse */
  grenade:  { radius: 14, damage: 45, push: 110, wind: false, fuse: 3,    bounce: 0.45 },
  /** the fork's own blast, before it splits into bomblets */
  fork:     { radius: 12, damage: 30, push: 90,  wind: true,  fuse: null, bounce: 0 },
  /** a bomblet is the small shot a fork throws */
  bomblet:  { radius: 8,  damage: 15, push: 60,  wind: true,  fuse: null, bounce: 0 },
  /** the dynamite ignores wind and goes off after its fuse, with the widest blast */
  dynamite: { radius: 30, damage: 70, push: 200, wind: false, fuse: 4,    bounce: 0 },
  /** a bomb from a deploy, on wind, going off on impact */
  bomb:     { radius: 12, damage: 30, push: 90,  wind: true,  fuse: null, bounce: 0 }
} as const

/** the ping: a shot's blast radius and damage, its push, how many pings a turn gets, and how far it reaches in px */
export const PING = { radius: 5, damage: 20, push: 180, shots: 2, range: 300 } as const

/** forks throw 5 bomblets at 30°, 60°, 90°, 120°, 150° up; deploy drops 3 bombs gap px apart from above the top */
export const FORK = { bomblets: 5, speed: 90 } as const
/** the deploy: its bombs, the gap between them in px, the row they start from, and their fall speed */
export const DEPLOY = { bombs: 3, gap: 12, y: -20, vy: 40 } as const

/** the weapon bar: each weapon's id, its name and glyph, its ammo per battle (Infinity is ∞), and whether it has a power charge */
export const WEAPONS: readonly { id: WeaponId; name: string; glyph: string; ammo: number; power: boolean }[] = [
  /** the rocket: unlimited, aimed with a power charge */
  { id: 'rocket', name: 'Rocket', glyph: '↗', ammo: Infinity, power: true },
  /** the grenade: unlimited, with a power charge */
  { id: 'grenade', name: 'Grenade', glyph: '●', ammo: Infinity, power: true },
  /** the fork bomb: one shot, with a power charge */
  { id: 'fork', name: 'Fork bomb', glyph: '⁂', ammo: 1, power: true },
  /** the ping: two straight shots a use, aimed, without a power charge */
  { id: 'ping', name: 'Ping', glyph: '»', ammo: 2, power: false },
  /** rm -rf: one use, dropped at the fighter's feet; the retreat starts at once */
  { id: 'rmrf', name: 'rm -rf', glyph: 'rm', ammo: 1, power: false },
  /** the deploy: one use, aimed with the cursor; its bombs fall from above it */
  { id: 'deploy', name: 'Deploy', glyph: '⇊', ammo: 1, power: false },
  /** the drill: two uses, aimed down or to the facing side; digs a tunnel */
  { id: 'drill', name: 'Drill', glyph: '⤓', ammo: 2, power: false },
  /** the teleport: one use, aimed with the cursor; moves the fighter there */
  { id: 'teleport', name: 'Teleport', glyph: '⌖', ammo: 1, power: false }
]

/** the bugs' player: its thinking budget, its aim search and power steps, its error and how it decays, and its bonuses */
export const BOT = {
  /** the most work the bot may do on one turn's search */
  budget: 8000,
  /** the least time the bot thinks before it moves, seconds */
  thinkMin: 0.5,
  /** the aim search's step, degrees, and its range from aimFrom to aimTo */
  aimStep: 5,
  aimFrom: -10,
  aimTo: 85,
  /** the power steps the search tries */
  powers: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  /** how long, in seconds, the search simulates a shot's flight, and how long it flies a push */
  simMax: 5,
  pushSim: 3,
  /** the bot's aim error in degrees and power error, before the streak shrinks them */
  aimError: 8,
  powerError: 0.05,
  /** each win in a streak multiplies the error by errorDecay, down to errorFloor */
  errorDecay: 0.8,
  errorFloor: 0.15,
  /** the score bonuses for a kill and for drowning a fighter */
  killBonus: 30,
  drownBonus: 100,
  /** the score weight of the bot's own fighters' damage */
  ownWeight: 1.5,
  /** how far apart enemies may be and still count as one cluster, px */
  clusterGap: 30,
  /** the reach of the rm -rf and of the ping, px */
  rmrfReach: 20,
  rmrfAway: 30,
  pingReach: 120,
  /** the spot search: how far the spot is offset, the score that counts as a better spot, the aim step and the powers it tries */
  spotOffset: 30,
  spotThreshold: 10,
  spotAimStep: 10,
  spotPowers: [0.2, 0.4, 0.6, 0.8, 1],
  /** the teleport lands between these distances from the enemy, px, and the bot gives up on a stuck walk after stuckFor seconds */
  teleportNear: [60, 100],
  stuckFor: 0.5
} as const

/**
 * The bot's error scale for a battle: 1 at a streak of 0, × errorDecay per win in the streak, never under errorFloor.
 */
export function botErrorScale(streak: number): number {
  return Math.max(BOT.errorFloor, Math.pow(BOT.errorDecay, streak))
}

/** no key pressed: all false, no pick, no cycle */
export const NO_INPUT: ArtilleryInput = { left: false, right: false, up: false, down: false, fire: false, jump: false, pick: null, cycle: 0 }
