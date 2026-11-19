/** the two sides: the Clawds (the player) and the bugs (the bot) */
export type Team = 'clawd' | 'bug'
/** the weapons in the bar, in order */
export type WeaponId = 'rocket' | 'grenade' | 'fork' | 'ping' | 'rmrf' | 'deploy' | 'drill' | 'teleport'
/** the flying things a weapon makes: a rocket, a grenade, a fork and its bomblets, a dynamite, a bomb */
export type ShotKind = 'rocket' | 'grenade' | 'fork' | 'bomblet' | 'dynamite' | 'bomb'
/** title screen, the player aiming, a shot in the air, the camera going back, the ground settling, the bot's turn, game over */
export type ArtilleryPhase = 'title' | 'aim' | 'flight' | 'retreat' | 'settle' | 'bot' | 'over'
/** how the battle ended, from the player's side */
export type ArtilleryResult = 'win' | 'loss' | 'draw'
/** inclusive cell bounds */
export interface Rect { x0: number; y0: number; x1: number; y1: number }
/** a disc of cells: centre x, y and radius r, in cells */
export interface Disc { x: number; y: number; r: number }
/** w × h cells row by row; 1 is ground, 0 is empty */
export interface Ground { w: number; h: number; cells: Uint8Array }
/** x, y: the feet, the bottom-middle cell of the body box x − 6 … x + 5, y − 9 … y */
export interface Fighter {
  /** whose fighter this is */
  team: Team
  /** the feet: the bottom-middle cell of the body box */
  x: number
  y: number
  /** velocity in px/s */
  vx: number
  vy: number
  /** hit points, 0 is dead */
  hp: number
  /** the way it faces: −1 left, 1 right */
  facing: -1 | 1
  /** true while it is in the air (falling or jumping) */
  air: boolean
  /** the row it started its fall from, to hurt it by the height it fell */
  fallFrom: number
  /** px walked in the current walk, for the step cadence */
  walked: number
  /** a drill in progress: the direction of each step and the steps left, or null */
  drill: { dx: number; dy: number; left: number } | null
  /** true once it has fallen into the water or off the map */
  out: boolean
}
/** a shot in the air or resting on the ground */
export interface Shot {
  /** what it is */
  kind: ShotKind
  x: number
  y: number
  /** velocity in px/s */
  vx: number
  vy: number
  /** seconds until it goes off by itself, or null for a shot that goes off on impact */
  fuse: number | null
  /** true once it has stopped moving */
  resting: boolean
  /** index in state.fighters of the fighter that fired it */
  owner: number
  /** seconds since it was fired */
  age: number
}
/** a hit: where it lands, how far it reaches, how much it hurts, how hard it pushes */
export interface Impact { x: number; y: number; radius: number; damage: number; push: number }
/** a blast's picture: its centre, radius and the seconds left to show it */
export interface Blast { x: number; y: number; r: number; left: number }
/** left … fire: held (fire also true on the frame Space was tapped); jump, pick, cycle: pressed since the last frame */
export interface ArtilleryInput {
  /** ← held */
  left: boolean
  /** → held */
  right: boolean
  /** ↑ held: raises the aim or the cursor */
  up: boolean
  /** ↓ held: lowers the aim or the cursor */
  down: boolean
  /** Space held, or tapped this frame */
  fire: boolean
  /** a jump pressed this frame */
  jump: boolean
  /** a weapon picked this frame, or null */
  pick: WeaponId | null
  /** the weapon bar cycled this frame: −1 back, 1 forward, 0 none */
  cycle: -1 | 0 | 1
}
/** one way the bot could play this turn: the weapon, where it stands and faces, its aim and power, where it aims, and how it retreats */
export interface Candidate {
  weapon: WeaponId
  /** the x it stands at */
  x: number
  facing: -1 | 1
  /** aim angle in degrees, 0 is level and more is up */
  aim: number
  /** power in 0…1 of the shot's speed range */
  power: number
  /** the cell it aims at, or null for a weapon that needs no target */
  target: { x: number; y: number } | null
  /** the way it retreats after firing, or 0 for none */
  retreat: -1 | 0 | 1
}
/** the bot's search: the candidates to try, the next to try, the best so far and its score, and the stage of the search */
export interface Planner {
  list: Candidate[]
  next: number
  best: Candidate | null
  bestScore: number
  stage: 'base' | 'spots' | 'last' | 'done'
}
/** the bot's turn in progress: its stage, the planner, the choice it made, the thinking time left, the stuck timer, the x it was last at and the shots it has fired */
export interface BotTurn {
  stage: 'think' | 'pick' | 'walk' | 'face' | 'aim' | 'fire' | 'done'
  planner: Planner
  choice: Candidate | null
  /** seconds of thinking left */
  thought: number
  /** seconds the bot has been without moving */
  stuck: number
  /** the x it stood at last check, to tell when it is stuck */
  lastX: number
  /** the distance to the aim or the cursor target at the last aim step, to tell when the aim is stuck */
  lastGap: number
  /** shots fired this turn */
  shots: number
}
/** the record kept between battles: wins, the win streak and the best streak */
export interface ArtilleryRecord { wins: number; streak: number; best: number }
/** the bugs' player: called on each fixed step of their turn with the step's working state; may change w.bot and w.seed */
export type BotDriver = (w: ArtilleryState) => ArtilleryInput
/** the whole game state of a battle */
export interface ArtilleryState {
  /** the screen or turn the game is in */
  phase: ArtilleryPhase
  /** how the battle ended, or null while it goes on */
  result: ArtilleryResult | null
  /** the battle's number in this run, from 1 */
  battle: number
  /** the terrain */
  ground: Ground
  /** the cell boxes dug out so far, for the picture */
  carved: Rect[]
  /** the row the water starts at */
  water: number
  fighters: Fighter[]  // the Clawds 0–2, then the bugs 3–5
  /** index in fighters of the one whose turn it is */
  active: number
  /** the team whose turn it is */
  team: Team
  /** per team, the index in fighters of the next fighter to take a turn */
  next: Record<Team, number>
  /** the turn number in this battle */
  turn: number
  /** the wind: px/s², positive blows right */
  wind: number
  /** seconds left in the turn */
  clock: number
  /** seconds of retreat left after a shot, or 0; the fighter may walk and jump while it is above 0 */
  retreat: number
  /** true once the battle is decided, so no further turn starts */
  ended: boolean
  /** true once the active fighter has fired this turn */
  used: boolean
  /** the time the ground has been settling for */
  settleFor: number
  /** the weapon in hand */
  weapon: WeaponId
  /** the shots each team has left, per weapon; Infinity is ∞ */
  ammo: Record<Team, Record<WeaponId, number>>  // Infinity is ∞
  /** aim angle in degrees, 0 is level and more is up */
  aim: number
  /** power in 0…1 of the shot's speed range */
  power: number
  /** true while the fire key charges the power */
  charging: boolean
  /** true while fire is held down, so a shot is not fired twice */
  fireHeld: boolean
  /** seconds of the ping's shots left to show */
  pingLeft: number
  /** the aim cursor for the cell-targeted weapons, or null */
  cursor: { x: number; y: number } | null
  /** the shots in the air or resting */
  shots: Shot[]
  /** the blasts to show */
  blasts: Blast[]
  /** the camera's x in px, gliding to follow the action */
  camera: number
  /** the bot's turn in progress, or null when it is not the bot's turn */
  bot: BotTurn | null
  /** the bot's aim error, scaled by botErrorScale for the streak */
  botError: number
  /** the random seed, moved on by every draw */
  seed: number
  /** a running accumulator, kept in the state for the rules that need one */
  acc: number
  /** input edges from a step call that ran no fixed step (dt too small): kept until the next fixed step uses them. jump, pick, cycle, and fire pressed (fire is OR-ed in) */
  pending: { jump: boolean; pick: WeaponId | null; cycle: -1 | 0 | 1; fire: boolean }
}
