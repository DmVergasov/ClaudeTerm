# Artillery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seventh game in the mini-games window: a turn-based artillery battle, three Clawds against three bugs played
by a bot, on a generated bitmap map with destructible ground, water, wind and eight weapons.

**Architecture:** Pure rules modules without DOM (`artillery-*.ts` in `src/renderer/games/`): the ground bitmap, the
fighters' bodies, the shots and explosions, the battle's turns, and the bot, which plays through the same input as the
person. A canvas view behind `GameView` draws it and puts its state on data attributes for e2e. Three counters join
`games.json`.

**Tech Stack:** TypeScript (strict), canvas 2D, Vitest, Playwright (Electron). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-artillery-design.md` (read it before any task; it is the authority on
behaviour, this plan on names and structure).

## Global Constraints

- Work in a git worktree on a new branch `feat/artillery` from `origin/master` (0.24.0). The spec and this plan are
  untracked files of the main checkout: copy both into the worktree's `docs/superpowers/` first.
- **No commits.** The user's rule: never commit unless they ask in the conversation. Leave every change uncommitted;
  this plan has no commit steps. Subagents do not commit either.
- AGENTS.md holds: plain TypeScript in the renderer, no UI framework, every UI-visible string in English, no new
  dependencies, tests on every level where a behaviour lives, keep line endings (the games files are LF).
- Tests never touch the real machine: e2e uses `launchApp`/`makeDataDir` from `tests/e2e/helpers.ts`; files go under
  `tmpdir()`.
- The window is 300 px wide (276 px inside its 12-px padding) and must stay at most 350 px tall with Artillery shown.
- Map 828 × 160 field px (three times 276), y down; the field shows 276 × 160; the minimap 276 × 34 shows rows 58–160.
- The window drops key repeats; held keys are tracked from keydown to keyup by the view.
- Every tuned number lives in `ARTILLERY`, `SHOTS`, `PING`, `WEAPONS` or `BOT` in `artillery-config.ts`, never inline.
- The rules never mutate the state they are given: `step` works on a copy (fighters and shots copied, the ground
  copied only when it is carved); the bot's simulations never change the state.
- If another agent's work collides with yours (a shared file, the build, a lock), report it to the coordinator; do not
  change or revert their work.

## Review Focus

1. **A charge cut off by a pause or by the keyboard leaving fires nothing**, and held keys are forgotten: a person who
   clicks into the terminal mid-charge must not fire on return, and a fighter must not keep walking. → Task 8 test
   "drops held keys and the charge when the keyboard leaves".
2. **A turn always ends**: a grenade, fighter or tunnel that never comes to rest ends the turn after `settleMax`
   (10 s). → Task 5 test "a turn that never comes to rest ends after settleMax".
3. **A shot that leaves the map through a side, or flies above the top, never stalls the turn.** → Task 4 tests on
   sides and top; Task 5 test "a shot out of the side still ends the turn".
4. **The bot really plays in the app**: the view passes `driveBot` to `step`; if it did not, the bugs' turn would hang.
   → Task 9 e2e "a shot hands the turn to the bot, and the bot hands it back".
5. **The window keeps its size** with Artillery: at most 300 × 350 px, nothing wider than the window. → Task 9 e2e
   "the window with Artillery stays within 300 × 350 px".

---

## File structure

| File | Responsibility |
|---|---|
| `src/shared/games.ts` (modify) | `artillery` id; `artilleryWins`, `artilleryStreak`, `artilleryBest` |
| `src/renderer/games/artillery-types.ts` | every Artillery type, no code |
| `src/renderer/games/artillery-config.ts` | the tuned numbers, the weapons table, `botErrorScale` |
| `src/renderer/games/artillery-ground.ts` | the bitmap: generation, queries, carving, start spots |
| `src/renderer/games/artillery-bodies.ts` | fighters: walk, jump, fall, land, drill |
| `src/renderer/games/artillery-shots.ts` | shots in flight, explosions' damage and push, Ping's ray |
| `src/renderer/games/artillery-rules.ts` | the battle: turns, input, weapon use, phases, camera, result, tally |
| `src/renderer/games/artillery-bot.ts` | the planner, its specials, and the driver that plays the bugs' turn |
| `src/renderer/games/artillery-view.ts` | the `GameView`: DOM, canvas, keys, loop, data attributes |
| `src/renderer/games/games.css` (modify) | `.artillery…` styles |
| `src/renderer/games/games-window.ts` (modify) | registers the view |
| `tests/unit/artillery-fixtures.ts` | test helpers: grounds, fighters, battles |
| `tests/unit/artillery-{ground,bodies,shots,rules,bot}.test.ts` | unit tests |
| `tests/unit/physics-views.test.ts`, `games-save.test.ts`, `ipc-guards.test.ts`, `tests/integration/games-store.int.test.ts`, `tests/e2e/games.spec.ts`, `README.md` (modify) | as each task says |

Unit tests run with `npx vitest run <file>`; the full checks are `npm run typecheck`, `npm test`, `npm run test:e2e`.

---

### Task 1: The save's new id and counters

**Files:**
- Modify: `src/shared/games.ts`, `src/main/ipc-guards.ts:151` (only if needed, see Step 3)
- Modify every `GamesSave` literal that the typecheck flags: `tests/unit/games-save.test.ts`,
  `tests/unit/ipc-guards.test.ts`, `tests/unit/physics-views.test.ts`, `tests/integration/games-store.int.test.ts`,
  `src/renderer/games/games-window.ts` if it builds one (find them with `git grep -n sandBest`)
- Test: `tests/unit/games-save.test.ts`, `tests/unit/ipc-guards.test.ts`, `tests/integration/games-store.int.test.ts`

**Interfaces:**
- Produces: `GAME_IDS` ends with `'artillery'`; `GamesSave.artilleryWins`, `.artilleryStreak`, `.artilleryBest`
  (numbers); `EMPTY_GAMES` has them at 0; `LATER_BESTS` (keep the name, update its comment to "the counters a save
  from before these games lacks") ends with the three new keys.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/games-save.test.ts` add the three fields to `valid` (`artilleryWins: 3, artilleryStreak: 1,
artilleryBest: 2`) and to the other literals (zeros), then:

```ts
it('a save from before Artillery loads whole: its counters are 0 and nothing is bad', () => {
  const { artilleryWins, artilleryStreak, artilleryBest, ...old } = valid
  const result = parseGamesSave(old)
  expect(result.save).toEqual({ ...old, artilleryWins: 0, artilleryStreak: 0, artilleryBest: 0 })
  expect(result.bad).toEqual([])
})
it('Artillery can be the last game chosen', () => {
  expect(parseGamesSave({ ...valid, game: 'artillery' })).toEqual({ save: { ...valid, game: 'artillery' }, bad: [] })
})
it('an Artillery counter out of range or not an integer is bad and 0', () => {
  const result = parseGamesSave({ ...valid, artilleryWins: -1, artilleryStreak: 1.5, artilleryBest: 1e13 })
  expect(result.save).toMatchObject({ artilleryWins: 0, artilleryStreak: 0, artilleryBest: 0 })
  expect(result.bad).toEqual(expect.arrayContaining(['artilleryWins', 'artilleryStreak', 'artilleryBest']))
})
```

In `tests/unit/ipc-guards.test.ts`, in the `isGamesSave` test, add the three fields to its save and assert
`isGamesSave(saveWithoutArtilleryWins)` is `false`. In `tests/integration/games-store.int.test.ts` add
`it('a games.json from before Artillery loads with no error, its counters at 0')`, written like the existing
"from before Lander, Pinball and Sand" test.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/games-save.test.ts tests/unit/ipc-guards.test.ts tests/integration/games-store.int.test.ts`
Expected: FAIL (the new fields are missing / `artillery` is an unknown game).

- [ ] **Step 3: Add the id and the three counters in `src/shared/games.ts`**

Append `'artillery'` to `GAME_IDS`, the three fields to `GamesSave` (doc comment: wins, the current win streak, the
best streak), zeros to `EMPTY_GAMES`, the three keys to `LATER_BESTS`, and widen the `later` record in
`parseGamesSave` to cover them. `isGamesSave` already requires every `LATER_BESTS` key, so it needs no change.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/unit/games-save.test.ts tests/unit/ipc-guards.test.ts tests/integration/games-store.int.test.ts` → PASS.
Run: `npm run typecheck` → no errors (fix every `GamesSave` literal it names by adding the three zeros).

---

### Task 2: Types, numbers and the ground

**Files:**
- Create: `src/renderer/games/artillery-types.ts`, `src/renderer/games/artillery-config.ts`,
  `src/renderer/games/artillery-ground.ts`, `tests/unit/artillery-fixtures.ts`
- Test: `tests/unit/artillery-ground.test.ts`

**Interfaces:**
- Produces (`artillery-types.ts`, exactly these names; doc-comment each field):

```ts
export type Team = 'clawd' | 'bug'
export type WeaponId = 'rocket' | 'grenade' | 'fork' | 'ping' | 'rmrf' | 'deploy' | 'drill' | 'teleport'
export type ShotKind = 'rocket' | 'grenade' | 'fork' | 'bomblet' | 'dynamite' | 'bomb'
export type ArtilleryPhase = 'title' | 'aim' | 'flight' | 'retreat' | 'settle' | 'bot' | 'over'
export type ArtilleryResult = 'win' | 'loss' | 'draw'
/** inclusive cell bounds */
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Disc { x: number; y: number; r: number }
/** w × h cells row by row; 1 is ground, 0 is empty */
export interface Ground { w: number; h: number; cells: Uint8Array }
/** x, y: the feet, the bottom-middle cell of the body box x − 6 … x + 5, y − 9 … y */
export interface Fighter {
  team: Team; x: number; y: number; vx: number; vy: number; hp: number; facing: -1 | 1
  air: boolean; fallFrom: number; walked: number
  drill: { dx: number; dy: number; left: number } | null
  out: boolean
}
export interface Shot { kind: ShotKind; x: number; y: number; vx: number; vy: number; fuse: number | null; resting: boolean; owner: number; age: number }
export interface Impact { x: number; y: number; radius: number; damage: number; push: number }
export interface Blast { x: number; y: number; r: number; left: number }
/** left … fire: held (fire also true on the frame Space was tapped); jump, pick, cycle: pressed since the last frame */
export interface ArtilleryInput { left: boolean; right: boolean; up: boolean; down: boolean; fire: boolean; jump: boolean; pick: WeaponId | null; cycle: -1 | 0 | 1 }
export interface Candidate { weapon: WeaponId; x: number; facing: -1 | 1; aim: number; power: number; target: { x: number; y: number } | null; retreat: -1 | 0 | 1 }
export interface Planner { list: Candidate[]; next: number; best: Candidate | null; bestScore: number; stage: 'base' | 'spots' | 'last' | 'done' }
export interface BotTurn { stage: 'think' | 'pick' | 'walk' | 'face' | 'aim' | 'fire' | 'done'; planner: Planner; choice: Candidate | null; thought: number; stuck: number; lastX: number; shots: number }
export interface ArtilleryRecord { wins: number; streak: number; best: number }
/** the bugs' player: called on each fixed step of their turn with the step's working state; may change w.bot and w.seed */
export type BotDriver = (w: ArtilleryState) => ArtilleryInput
export interface ArtilleryState {
  phase: ArtilleryPhase; result: ArtilleryResult | null; battle: number
  ground: Ground; carved: Rect[]; water: number
  fighters: Fighter[]  // the Clawds 0–2, then the bugs 3–5
  active: number; team: Team; next: Record<Team, number>; turn: number; wind: number
  clock: number; retreat: number; ended: boolean; used: boolean; settleFor: number
  weapon: WeaponId; ammo: Record<Team, Record<WeaponId, number>>  // Infinity is ∞
  aim: number; power: number; charging: boolean; fireHeld: boolean; pingLeft: number
  cursor: { x: number; y: number } | null
  shots: Shot[]; blasts: Blast[]; camera: number
  bot: BotTurn | null; botError: number; seed: number; acc: number
}
```

- Produces (`artillery-config.ts`): `ARTILLERY`, `SHOTS`, `PING`, `WEAPONS`, `BOT` (`as const` objects with these
  starting values, each with a one-line comment; Task 10 records the tuned values), and `botErrorScale`:

```ts
export const ARTILLERY = {
  width: 828, height: 160, view: 276, minimapTop: 58, step: 1 / 120, maxDt: 0.1,
  groundTop: 60, groundBottom: 140, water: 148, gravity: 150, windMax: 50,
  hp: 100, halfW: 6, bodyH: 10, walkSpeed: 30, climb: 3, jumpVx: 40, jumpVy: 80,
  fallSafe: 30, fallDamage: 0.5, landBounce: 100, aimRate: 60, cursorSpeed: 120, startAim: 30,
  chargeTime: 1, minSpeed: 60, maxSpeed: 300, muzzle: 10, damageReach: 1.5, lift: 0.4,
  turnTime: 45, retreatTime: 3, floodFrom: 31, floodRise: 4, settleMax: 10, spawnGap: 40,
  cameraGlide: 6, blastTime: 0.3, shotMaxAge: 12, restSpeed: 15,
  drillLength: 40, drillTime: 1.5, drillRadius: 8
} as const
export const SHOTS = {
  rocket:   { radius: 14, damage: 45, push: 110, wind: true,  fuse: null, bounce: 0 },
  grenade:  { radius: 14, damage: 45, push: 110, wind: false, fuse: 3,    bounce: 0.45 },
  fork:     { radius: 12, damage: 30, push: 90,  wind: true,  fuse: null, bounce: 0 },
  bomblet:  { radius: 8,  damage: 15, push: 60,  wind: true,  fuse: null, bounce: 0 },
  dynamite: { radius: 30, damage: 70, push: 200, wind: false, fuse: 4,    bounce: 0 },
  bomb:     { radius: 12, damage: 30, push: 90,  wind: true,  fuse: null, bounce: 0 }
} as const
export const PING = { radius: 5, damage: 20, push: 180, shots: 2, range: 300 } as const
/** forks throw 5 bomblets at 30°, 60°, 90°, 120°, 150° up; deploy drops 3 bombs gap px apart from above the top */
export const FORK = { bomblets: 5, speed: 90 } as const
export const DEPLOY = { bombs: 3, gap: 12, y: -20, vy: 40 } as const
export const WEAPONS: readonly { id: WeaponId; name: string; glyph: string; ammo: number; power: boolean }[] = [
  { id: 'rocket', name: 'Rocket', glyph: '↗', ammo: Infinity, power: true },
  { id: 'grenade', name: 'Grenade', glyph: '●', ammo: Infinity, power: true },
  { id: 'fork', name: 'Fork bomb', glyph: '⁂', ammo: 1, power: true },
  { id: 'ping', name: 'Ping', glyph: '»', ammo: 2, power: false },
  { id: 'rmrf', name: 'rm -rf', glyph: 'rm', ammo: 1, power: false },
  { id: 'deploy', name: 'Deploy', glyph: '⇊', ammo: 1, power: false },
  { id: 'drill', name: 'Drill', glyph: '⤓', ammo: 2, power: false },
  { id: 'teleport', name: 'Teleport', glyph: '⌖', ammo: 1, power: false }
]
export const BOT = {
  budget: 8000, thinkMin: 0.5, aimStep: 5, aimFrom: -10, aimTo: 85, powers: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  simMax: 5, pushSim: 3, aimError: 8, powerError: 0.1, errorDecay: 0.8, errorFloor: 0.15,
  killBonus: 30, drownBonus: 100, ownWeight: 1.5, clusterGap: 30, rmrfReach: 20, rmrfAway: 30,
  pingReach: 120, spotOffset: 30, spotThreshold: 10, spotAimStep: 10, spotPowers: [0.2, 0.4, 0.6, 0.8, 1],
  teleportNear: [60, 100], stuckFor: 0.5
} as const
/** the bot's error scale for a battle: 1 at a streak of 0, × errorDecay per win in the streak, never under errorFloor */
export function botErrorScale(streak: number): number
/** no key: all false, pick null, cycle 0 */
export const NO_INPUT: ArtilleryInput
```

- Produces (`artillery-ground.ts`):

```ts
export function makeGround(seed: number): Ground
/** outside the sides or above the top: empty; below the bottom: ground; x and y are rounded */
export function solid(g: Ground, x: number, y: number): boolean
export function cloneGround(g: Ground): Ground
/** clears every cell with (x − cx)² + (y − cy)² ≤ r², in place; the changed box clipped to the map, null when none */
export function clearDisc(g: Ground, cx: number, cy: number, r: number): Rect | null
/** the first ground row from the top in column x; g.h when the column is empty */
export function surfaceY(g: Ground, x: number): number
/** the feet row of a fighter standing at x: the smallest surfaceY under its box (x − 6 … x + 5), minus 1 */
export function standY(g: Ground, x: number): number
/** each team's x: Clawds in 20 … 394, bugs in 434 … 808, 40 px apart, on walkable ground */
export function spawnSpots(g: Ground, seed: number): Record<Team, number[]>
```

- Produces (`tests/unit/artillery-fixtures.ts`, used by later tasks):
  `flatGround(top: number): Ground` (rows `top` … 159 ground), `fill(g, x0, y0, x1, y1): Ground` (sets the inclusive
  rect to ground, returns `g`), `emptyGround(): Ground`, `fighter(team, x, y, over?: Partial<Fighter>): Fighter`
  (hp 100, facing 1 for Clawds and −1 for bugs, everything else at rest).

- [ ] **Step 1: Write the failing tests** in `tests/unit/artillery-ground.test.ts`:

```ts
it('the same seed gives the same ground, another seed another')        // cells equal for 7/7, differ for 7/8
it('the surface stays between rows 60 and 140 in every column')        // seeds 1–20, every x: 60 ≤ surfaceY ≤ 140
it('every map has a cave: an empty cell under ground, above the water') // seeds 1–20
it('solid: empty outside the sides and above the top, ground below the bottom')
it('clearDisc clears exactly the cells within the radius and returns their box', () => {
  const g = flatGround(100)
  expect(clearDisc(g, 50, 100, 5)).toEqual({ x0: 45, y0: 95, x1: 55, y1: 105 })
  expect(solid(g, 50, 100)).toBe(false); expect(solid(g, 55, 100)).toBe(false)
  expect(solid(g, 56, 100)).toBe(true);  expect(solid(g, 50, 106)).toBe(true)
})
it('clearDisc at the edge clips its box; a disc all outside gives null') // (2,100,5) → x0 0; (−20,100,5) → null
it('standY stands a fighter on the highest column under its box', () => {
  const g = fill(flatGround(100), 52, 97, 52, 99)
  expect(standY(g, 50)).toBe(96); expect(standY(g, 70)).toBe(99)
})
it('spawn spots: three a team, on their half, 40 px apart, above the water, on walkable ground')
// seeds 1–20: lengths 3; Clawd x in [20, 394], bug x in [434, 808]; sorted neighbours ≥ 40 apart;
// standY < 148 − 4; for x + i, i = −15 … 15: |surfaceY(x+i) − surfaceY(x+i−1)| ≤ 3
it('botErrorScale is 1 at 0, shrinks with the streak, and stops at the floor') // 1; s(1) < 1; s(3) < s(1); s(50) = 0.15
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/artillery-ground.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Write the types, the config and the ground module**

`makeGround`: draw everything from `seeded(seed)` (`random.ts`). Surface:
`100 + A1·sin(x·2π/P1 + φ1) + A2·sin(x·2π/P2 + φ2) + A3·sin(x·2π/P3 + φ3)` with A1 ∈ [18, 26], P1 ∈ [300, 420],
A2 ∈ [8, 14], P2 ∈ [90, 140], A3 ∈ [2, 4], P3 ∈ [25, 40], φ ∈ [0, 2π), rounded and clamped to [60, 140]; every cell
from the surface down is ground. Caves: up to 20 tries to carve 4 ellipses with cx ∈ [60, 768], cy = surface(cx) +
18 … 32, rx ∈ [10, 22], ry ∈ [5, 10], kept only when cy + ry < water − 2; at least 2 are carved. One overhang: an
ellipse rx 12, ry 6 at the steepest sampled slope, centred 6 px under the surface on its downhill side.
`spawnSpots`: per team, even slots across its half with a seeded jitter of ±15 px, each tried up to 50 times until it
is walkable (the ±15-px rule of the test) and 40 px from the others; a slot that never fits takes its plain even x.

- [ ] **Step 4: Run** the test file → PASS; `npm run typecheck` → no errors.

---

### Task 3: Fighters' bodies

**Files:**
- Create: `src/renderer/games/artillery-bodies.ts`
- Test: `tests/unit/artillery-bodies.test.ts`

**Interfaces:**
- Consumes: Task 2's types, `ARTILLERY`, `solid`, fixtures.
- Produces:

```ts
/** the box at the rounded (x, y) holds no ground and is inside the sides (x − 6 ≥ 0, x + 5 < width) */
export function bodyFree(g: Ground, x: number, y: number): boolean
/** a cell under the box's bottom row (row y + 1, columns x − 6 … x + 5) is ground */
export function grounded(g: Ground, f: Fighter): boolean
/** turns f to dir; on the ground moves walkSpeed × dt through f.walked, a px at a time: up to climb px up or down
 *  (snapped), a higher step stops it; off a ledge it starts falling (air, fallFrom = y). Mutates f. */
export function walk(g: Ground, f: Fighter, dir: -1 | 1, dt: number): void
/** on the ground only: vx = facing × jumpVx, vy = −jumpVy, air, fallFrom = y */
export function jump(g: Ground, f: Fighter): void
/** gravity, then moves at most 1 px per substep: a side wall or the map's side stops vx (vx = −0.3 vx), a ceiling
 *  stops vy; on landing: faster than landBounce bounces (vy = −0.3 vy, vx × 0.5), else it rests (air false, vx = vy
 *  = 0, x and y rounded) and fall = y − fallFrom. Feet at or below `water`: out, hp 0. fallFrom tracks the highest y. */
export function airStep(g: Ground, f: Fighter, dt: number, water: number): { landed: boolean; fall: number }
/** max(0, round((height − fallSafe) × fallDamage)) */
export function fallDamage(height: number): number
/** moves along f.drill at drillLength / drillTime px/s and returns a disc of drillRadius centred on (x, y − 5) for
 *  each whole px moved; at left ≤ 0 sets drill to null. Does not read or change the ground. */
export function drillStep(f: Fighter, dt: number): Disc[]
```

- [ ] **Step 1: Write the failing tests** (STEP = `ARTILLERY.step`):

```ts
it('a fighter walks on flat ground at walkSpeed')           // flatGround(100), (100, 99), 120 steps right → x 130, y 99, facing 1
it('a fighter climbs a 3-px step but not a 4-px one')       // fill(…,120,97,200,99): after 2 s x > 125, y 96;
                                                             // fill(…,120,96,200,99): after 2 s x 114, y 99
it('a step down of up to 3 px keeps it on the ground')     // ground at 100 for x < 120, at 102 from 120: air false, y 101
it('walking off a ledge starts a fall')                     // ground at 140, block x 0–119 rows 100–139: walking right → air true
it('airStep lands a falling fighter and reports the fall')  // flatGround(100), (100, 40) air, fallFrom 40 → y 99, air false, fall 59
it('fall damage: none at fallSafe, half a point per px above it')  // fallDamage(30) 0, fallDamage(50) 10
it('a jump goes forward and up and lands without damage')  // x lands in 135–150, y 99, fallDamage(fall) 0
it('the map\'s sides stop a fighter, walking or flying')   // walking left from 8 → x 6; flying vx −200 from 10 → x ≥ 6
it('water takes a fighter out')                             // emptyGround, falls from 100 → out true, hp 0, y ≥ 148
it('drillStep moves the fighter along and returns discs to clear') // drill {1,0,40}: after drillTime + 0.1 s x 140, drill null, every disc r 7 at y 94
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/artillery-bodies.test.ts` → FAIL.
- [ ] **Step 3: Implement** the functions above in `artillery-bodies.ts`.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → no errors.

---

### Task 4: Shots, explosions and Ping

**Files:**
- Create: `src/renderer/games/artillery-shots.ts`
- Test: `tests/unit/artillery-shots.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 (`solid`, `bodyFree` not needed; fighters' boxes are x − 6 … x + 5, y − 9 … y).
- Produces:

```ts
/** the unit direction of an aim in degrees (0 level, +90 up, −90 down) on the side f faces; y down */
export function aimVector(f: Fighter, aim: number): { dx: number; dy: number }
/** starts muzzle px from the body's middle (x, y − 5) along the aim at minSpeed + power × (maxSpeed − minSpeed) */
export function launch(kind: 'rocket' | 'grenade' | 'fork', f: Fighter, owner: number, aim: number, power: number): Shot
/** at the feet, still, fuse SHOTS.dynamite.fuse */
export function dynamite(f: Fighter, owner: number): Shot
/** DEPLOY.bombs bombs at x − gap, x, x + gap, y DEPLOY.y, vy DEPLOY.vy */
export function deployBombs(x: number, owner: number): Shot[]
export function impactOf(kind: ShotKind, x: number, y: number): Impact
/** one step of a shot (mutates s): gravity, the wind if SHOTS[kind].wind, the fuse, ≤ 1 px per substep.
 *  Leaving through a side or touching row ≥ water: gone, no impact. Above the top it flies on.
 *  Ground: rocket, fork, bomblet, bomb explode; grenade bounces (reflect the blocked axis × bounce) and rests below
 *  restSpeed on ground; dynamite stops. A fighter's box (any not out, the owner too once age > 0.1 s): rocket, fork,
 *  bomblet, bomb explode. A fuse at 0 explodes where it is. A fork's impact spawns FORK.bomblets bomblets 2 px above
 *  it. age > shotMaxAge: gone. A resting shot with no ground under it falls again. */
export function shotStep(g: Ground, fighters: readonly Fighter[], s: Shot, wind: number, water: number, dt: number): { gone: boolean; impact: Impact | null; spawn: Shot[] }
/** what an impact does to f (centre x, y − 5): R = radius × damageReach; null at d ≥ R; k = 1 − d / R;
 *  damage round(damage × k); push v = push × k along (centre − impact) (straight up when d < 0.5), plus −lift × v in y */
export function effect(f: Fighter, impact: Impact): { damage: number; vx: number; vy: number } | null
/** applies effect to every fighter not out (hp floored at 0, velocity added, air, fallFrom = y); the indexes hurt */
export function hurt(fighters: Fighter[], impact: Impact): number[]
/** Ping's straight shot from the shooter's muzzle, 1 px at a time up to PING.range: the first ground cell or another
 *  fighter's box gives a PING impact there; null when it leaves the map or reaches the range */
export function pingRay(g: Ground, fighters: readonly Fighter[], shooter: number, aim: number): Impact | null
```

- [ ] **Step 1: Write the failing tests:**

```ts
it('a rocket follows gravity and the wind')                    // after 1 s: vy grew by ~150; x with wind 50 > x without
it('a rocket explodes where it touches the ground')           // flatGround(100), (100,50) vy 100 → impact x 100, y 99–101, radius 14, damage 45
it('a rocket explodes on a fighter')                          // fighter at (200,99); rocket (150,94) vx 200 → impact x in 194–205
it('a grenade bounces, ignores the wind and explodes 3 s after the throw') // vy < 0 after first touch; x stays 100 with wind 50; impact at age 2.99–3.02
it('a fork bomb splits into five bomblets that explode on touch') // spawn: 5 bomblets, all vy < 0; a bomblet's impact radius 8, damage 15
it('dynamite falls, rests and explodes after 4 s')            // impact at age 3.99–4.02, radius 30, damage 70
it('deploy drops three bombs 12 px apart that drift with the wind') // deployBombs(300,3) xs [288,300,312], y −20; with wind 50 each impact x > its start
it('a shot leaving through a side is gone; one above the top comes back down') // (5,50) vx −300 → gone, no impact; (400,5) vy −200: y < 0 and not gone, later an impact on flatGround(100)
it('a shot touching the water sinks without exploding')       // emptyGround: gone at y ≥ 148, impact null
it('no shot passes a 1-px wall at the top speed')             // fill(emptyGround(),300,0,300,159); rocket (250,80) vx 300 → impact x 299–300
it('an explosion hurts less with distance, nothing beyond its reach, and pushes away') // d 0 → 45; d = R/2 → 22 or 23; d ≥ R → null; vx sign = sign(f.x − impact.x); vy < 0
it('hurt applies damage and push to everyone in reach and returns them')
it('ping hits the first fighter or ground on its line, and nothing beyond its range') // fighter at 200 → x in 194–205; wall at 150 → x 150; nothing within 300 px → null
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/artillery-shots.test.ts` → FAIL.
- [ ] **Step 3: Implement** `artillery-shots.ts` as specified above. Substeps: `n = max(1, ceil(max(|vx|, |vy|) × dt))`,
  velocity updated once per step before moving.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → no errors.

---

### Task 5: The battle's rules

**Files:**
- Create: `src/renderer/games/artillery-rules.ts`
- Modify: `tests/unit/artillery-fixtures.ts` (add `battle`)
- Test: `tests/unit/artillery-rules.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:

```ts
export const idleBot: BotDriver                                  // returns NO_INPUT (BotDriver and NO_INPUT come from Task 2)
/** a map from the seed, fighters on spawnSpots at standY, full ammo per team, water 148, phase 'title', battle = seed,
 *  seed = seed, botError = errorScale */
export function newBattle(seed: number, streak: number, errorScale?: number): ArtilleryState  // default botErrorScale(streak)
/** turn 1: the Clawds' fighter 0, phase 'aim' */
export function start(s: ArtilleryState): ArtilleryState
/** fixed steps of ARTILLERY.step with an accumulator, dt clamped to maxDt; jump, pick and cycle used by the first step only;
 *  on the bugs' turn the input comes from `drive`, the person's is ignored */
export function step(s: ArtilleryState, input: ArtilleryInput, dt: number, drive?: BotDriver): ArtilleryState  // default idleBot
/** charging false, power 0: a charge cut off by a pause fires nothing */
export function dropCharge(s: ArtilleryState): ArtilleryState
export function inBattle(s: ArtilleryState): boolean             // phase not 'title' or 'over'
export function atRest(s: ArtilleryState): boolean               // no shots, no fighter in the air or drilling
export function teamHp(s: ArtilleryState, team: Team): number
export function tally(r: ArtilleryRecord, result: ArtilleryResult): ArtilleryRecord
```

- Fixture: `battle(over: Partial<ArtilleryState> = {}): ArtilleryState` = `{ ...start(newBattle(1, 0, 0)), wind: 0, ...over }`.

**One fixed step** (`tick(w, input, drive)` on the step's working copy; carving goes through one helper that copies
the ground once per step, clears the discs and appends their boxes to `carved`):

1. Input: on the bugs' turn `input = drive(w)`.
2. `before` = phase is `aim` or `bot`. `canMove` = not ended, the active fighter not out and not drilling, not charging,
   `pingLeft` 0, and (`before`, or phase `flight`/`retreat` with `retreat > 0`).
3. canMove and no cursor: left xor right walks (grounded fighters only); jump edge jumps.
4. `before` and not ended: with a cursor, the arrows move it (cursorSpeed, clamped to the map above the water), else
   up/down turn the aim (aimRate, clamped to ±90). pick/cycle (not charging, `pingLeft` 0) choose a weapon with ammo
   (cycle skips empty ones, wrapping); Deploy and Teleport set the cursor to (x, y − 30), others clear it.
   Fire: press = `fire && !fireHeld`, release = `!fire && fireHeld`. Power weapons: press starts charging at 0, held
   adds `step / chargeTime`, at 1 or on release → use. Others: press → use. On the person's turn before the use the
   clock runs down; at 0: ended, charge dropped. `fireHeld = fire`.
5. Use: Rocket/Grenade/Fork launch; Ping applies `pingRay` (first press: `pingLeft = 1`, ammo − 1; second press:
   `pingLeft = 0`, used); rm -rf drops dynamite; Deploy drops bombs at the cursor; Drill starts down when aim < −45,
   else to the facing side; Teleport moves the fighter when `bodyFree` there and y < water − 2 (ends the turn), else
   nothing is spent. A use: ammo − 1 (not ∞), used, retreat = retreatTime (Teleport: none), charge dropped, cursor cleared.
6. Physics: fighters (drill → carve its discs; air → `airStep`, a landing's `fallDamage` hurts; on the ground but not
   grounded → air; feet ≥ water → out, hp 0), shots (`shotStep`; an impact carves its disc, `hurt`s, adds a blast;
   spawns join; gone ones leave), blasts age, hp 0 → out with a small blast. The active fighter hurt or out → ended,
   charge dropped. `retreat` counts down after the use.
7. Phase: `before` and ended → `settle`. After the use: shots or a drill → `flight`; else retreat left and not ended →
   `retreat`; else `settle`. In `settle`: `settleFor += step`; at rest or `settleFor ≥ settleMax` (then shots are
   dropped and flying fighters set down at `standY`) → end of turn: no bugs and no Clawds → `over`, `draw`; no bugs →
   `win`; no Clawds → `loss`; else the next turn.
8. Next turn: `turn + 1`; from `floodFrom` on `water −= floodRise`; wind = round((rand × 2 − 1) × windMax); the other
   team; its next living fighter in rotation; clock turnTime; retreat 0; ended, used false; settleFor 0; weapon
   rocket; aim startAim; no charge, cursor or ping; bot null; phase `aim` (Clawds) or `bot` (bugs).
9. Camera: focus on the first shot, else the cursor, else the active fighter; target = clamp(focus.x − view / 2, 0,
   width − view); `camera += (target − camera) × min(1, cameraGlide × step)`.

- [ ] **Step 1: Write the failing tests** (use `battle({ ground: flatGround(100), fighters: [...] })` with fighters
  from the fixture placed on row 99 wherever positions matter; `run(s, input, seconds, drive?)` as a local helper that
  steps in 1/60-s frames):

```ts
it('a new battle waits on its title; start gives the Clawds the first turn with a full clock')
// newBattle(5,0): phase 'title', 6 fighters, teams clawd×3 then bug×3, hp 100; start: 'aim', team clawd, active 0,
// clock 45, turn 1, |wind| ≤ 50, ammo.clawd: fork 1, ping 2, rmrf 1, deploy 1, drill 2, teleport 1, rocket ∞
it('holding Space charges the power; the release fires a rocket and starts the retreat') // 0.5 s → power 0.45–0.55; release → 1 shot, used, phase 'flight', retreat ≈ 3
it('a full charge fires by itself')
it('one use a turn: Space after the shot fires nothing')
it('the clock runs only before the use; at 0 the turn ends without a shot and the bugs go next') // after 45 s ended; then team 'bug', phase 'bot'
it('a charge cut off by the clock fires nothing')
it('dropCharge drops the charge without a shot')
it('during the retreat the fighter walks and jumps but cannot fire')
it('the turn ends when the retreat is over and everything rests')
it('hurting yourself ends the turn')                    // aim −90, power 0.2: own blast → ended; walking keys do nothing
it('turns rotate within a team and skip the out')       // fighters[1].out → the Clawds' second turn is fighter 2
it('wind changes every turn within its limits')
it('the water rises from turn 31')                      // turn 30 ends → turn 31, water 144
it('the battle ends: no bugs is a win, no Clawds a loss, both a draw')
it('tally: a win raises wins, streak and best; a loss or a draw resets the streak') // {2,2,2}+win → {3,3,3}; {3,1,3}+win → {4,2,3}; +loss → streak 0
it('an explosion carves the ground, records its box and leaves the old state untouched')
it('Deploy and Teleport show a cursor that the arrows move')
it('Teleport moves the fighter to a free spot and ends the turn; rock or water refuses it and keeps the ammo')
it('Ping fires two shots and the aim can change between them')
it('rm -rf drops at the feet and the retreat starts at once')
it('Drill digs down when aimed down, to the side otherwise')
it('pick and Tab skip weapons with no ammo; Shift+Tab goes back') // fork 0: cycle +1 from grenade → ping; cycle −1 → grenade
it('the bugs\' turn takes its input from the driver and ignores the person\'s')
it('a turn that never comes to rest ends after settleMax')   // a resting grenade with fuse 1000 in 'settle' → after 10.1 s the next turn, shots []
it('a shot out of the side still ends the turn')             // a Clawd at x 20 facing −1, aim 0, full power → turn passes to the bugs
it('the camera follows a shot in flight and stays within the map')
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/artillery-rules.test.ts` → FAIL.
- [ ] **Step 3: Implement** `artillery-rules.ts` as described; `EPSILON` slack as in `lander-rules.ts`.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → no errors.

---

### Task 6: The bot that aims, and plays its turn

**Files:**
- Create: `src/renderer/games/artillery-bot.ts`
- Test: `tests/unit/artillery-bot.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 (`newBattle`, `start`, `step` and the fixture `battle` in tests; the module itself imports only
  types, config (`NO_INPUT`, `BOT`), ground, bodies and shots — never the rules).
- Produces:

```ts
/** the shot's impacts as the rules would make them, on the ground as it is, the shooter standing at (c.x, standY);
 *  cost: simulated substeps. Never changes s. */
export function predict(s: ArtilleryState, c: Candidate): { impacts: Impact[]; cost: number }
/** + damage to Clawds (capped at hp) + killBonus a kill + drownBonus a push into the water (each pushed fighter flown
 *  with airStep up to pushSim s); − ownWeight × the same for bugs; cost: the push flights' substeps */
export function score(s: ArtilleryState, impacts: Impact[], shooter: number): { score: number; cost: number }
/** Task 6: the base grid only — rocket then grenade, facing −1 then 1, aim aimFrom … aimTo by aimStep, each of powers,
 *  at the current x, retreat 0 */
export function makePlanner(s: ArtilleryState): Planner
/** evaluates candidates in order until `budget` substeps are spent; keeps the best (ties: the earlier one) */
export function plan(p: Planner, s: ArtilleryState, budget: number): Planner
/** aim ± aimError × botError, power ± powerError × botError (power clamped 0.1 … 1), drawn from w.seed (advanced) */
export function withError(c: Candidate, w: ArtilleryState): Candidate
/** the bugs' player: think (plan with BOT.budget a step, at least thinkMin s) → pick → walk to c.x (stuck stuckFor s
 *  ends it) → face → aim or move the cursor → fire (charge to c.power and release; a press for the others, two for
 *  Ping) → done; after the use holds c.retreat while retreat lasts */
export const driveBot: BotDriver
```

- [ ] **Step 1: Write the failing tests:**

```ts
it('with no error the bot hits a lone Clawd in the open')
// battle: flatGround(100), a Clawd at 300, a bug at 600, the rest out, team 'bug', phase 'bot', botError 0:
// run step(…, driveBot) until the team is 'clawd' again (≤ 20 s) → the Clawd's hp < 100
it('it prefers a shot that does not hurt its own')      // score of an impact on a bug < 0; with a Clawd at 200 alone and one at 500 next to a bug at 515, the chosen impact is nearer 200
it('the same state gives the same choice')
it('its work per step is bounded and it decides within about a second') // plan(p, s, BOT.budget) until done: ≤ 150 calls
it('at a streak of 0 it hits about half the time')      // botError 1, seeds 1–40 for w.seed: predicted impacts that hurt the lone Clawd at 250 px: 12–28 of 40
it('it plays with the person\'s controls: the aim turns gradually and the weapon is used') // |Δaim| per step ≤ aimRate × step + 1e-9; used within 10 s
it('rm -rf choice holds its retreat after the use')     // a stub choice with retreat 1 → x grows during the retreat
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/artillery-bot.test.ts` → FAIL.
- [ ] **Step 3: Implement** `artillery-bot.ts`. `predict` runs `shotStep` on its own copies (fork bomblets included,
  `simMax` s at most) with a copy of the fighters where the shooter stands at `c.x`. The driver keeps its state in
  `w.bot` (created on the first call of a turn), and returns `NO_INPUT`-based inputs. Tune `aimError`/`powerError` until
  the "about half the time" test passes, and keep the values in `BOT`.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → no errors.

---

### Task 7: The bot's specials and other spots

**Files:**
- Modify: `src/renderer/games/artillery-bot.ts`
- Test: `tests/unit/artillery-bot.test.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces: `makePlanner` and `plan` extended (same signatures). Stages: `base` (Task 6's grid, then, when two Clawds
  stand within clusterGap px of each other and there is ammo: Fork bomb with the same grid on the side facing them,
  and one Deploy candidate at their middle; a Ping candidate aimed at a Clawd's body middle when one is within
  pingReach px and `pingRay` hits it; an rm -rf candidate when a Clawd is within rmrfReach px and a walk of rmrfAway px
  away is possible, with that retreat) → `spots` (only when bestScore ≤ spotThreshold: rocket candidates at x ±
  spotOffset that a walk reaches, facing the nearest Clawd, aims by spotAimStep, spotPowers) → `last` (only when
  bestScore ≤ 0: Teleport, if ammo, to a free spot teleportNear px from the nearest Clawd, else Drill, if ammo,
  toward it; each scored 1) → `done`. rm -rf, Teleport and Drill are scored without `predict` (rm -rf: `score` of its
  impact at the feet with the shooter moved rmrfAway px).

- [ ] **Step 1: Write the failing tests:**

```ts
it('two Clawds close together draw a Fork bomb or Deploy')        // Clawds at 300 and 315, a bug at 650 → weapon ∈ {fork, deploy}
it('a Clawd next to the bug draws rm -rf with a retreat away')     // Clawd at 600, bug at 612, open ground → rmrf, retreat 1
it('a Clawd in a clear line nearby gets a Ping candidate; a wall between takes it away')
it('with nothing to hit from where it stands it tries spots 30 px away') // spots listed only when bestScore ≤ 10
it('a bug stuck in a pit teleports, or drills when Teleport is spent')  // pit walls 60 px high around it, Clawds far
```

- [ ] **Step 2: Run** → FAIL.  **Step 3: Implement.**  **Step 4: Run** the bot tests → PASS; `npm run typecheck`.

---

### Task 8: The view, its styles, and its place in the window

**Files:**
- Create: `src/renderer/games/artillery-view.ts`
- Modify: `src/renderer/games/games.css` (an `.artillery` block after Sand's), `src/renderer/games/games-window.ts:118-125`
- Test: `tests/unit/physics-views.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:

```ts
export class ArtilleryView implements GameView {
  readonly id = 'artillery'; readonly title = 'Artillery'; readonly pausable = true; readonly realtime = true
  constructor(record: ArtilleryRecord, changed: () => void, seed?: () => number)  // seed defaults to newSeed
}
```

  Registered in `games-window.ts` after `SandView`:
  `new ArtilleryView({ wins: save.artilleryWins, streak: save.artilleryStreak, best: save.artilleryBest }, () => this.changed())`.

- Behaviour:
  - DOM (class names): `.artillery` › `.artillery-hud` (`.artillery-team.clawd` bar + number, `.artillery-mid` wind
    arrows + time or `bot`, + `flood` from turn 31, `.artillery-team.bug`), `canvas.artillery-mini` 276 × 34,
    `.artillery-stage` (`canvas.artillery-field` 276 × 160 and `.artillery-message` over it),
    `.artillery-weapons` (8 `.artillery-weapon` cells: glyph + ammo; `.chosen`, `.empty`; the strip gets `.bot`, dimmed,
    on the bugs' turn and shows their choice), `.artillery-info`, `.artillery-hint`. Gaps of 4 px, so the window stays
    ≤ 350 px tall.
  - Keys: arrows, Space, Enter, NumpadEnter, Tab, Digit1–8, ShiftLeft, ShiftRight are the game's (`key` returns true;
    while not live they are taken and ignored). Held: arrows, Space, Shift. Edges until the next frame: Enter/NumpadEnter
    → jump, DigitN → pick WEAPONS[N − 1], Tab → cycle (−1 with Shift held), a Space keydown → fire for that frame.
    Space in `title` → `start`; in `over` → `start(newBattle(seed(), record.streak))`; both start the loop.
  - `setState(shown, live)`: live → the loop runs while `inBattle`; otherwise the loop stops, held keys and edges are
    cleared and `state = dropCharge(state)`.
  - Frame: `step(state, input, dt, driveBot)`; on the step into `over`: `record = tally(record, result)`, `changed()`.
  - `canPause()` = `inBattle(state)`; `saveInto` writes the three counters; `menuNote()` = `wins N` (`toLocaleString('en-US')`).
  - Data attributes on `.artillery`: `phase`, `turn` (`you`/`bot`), `weapon`, `ammo` (`∞` or a number), `x` (the active
    fighter's rounded x), `air` (`true`/`false`), `time` (ceil of the clock), `wind` (rounded), `hp` (`clawds/bugs`),
    `camera` (rounded).
  - Messages: `Space to start` with `wins N · streak N · best N` (title); `Your turn` / `Bugs' turn` for the first
    1.2 s of a turn (+ ` · water rising` from turn 31); `You win!` / `Bugs win` / `Draw` with the record and
    `Space for a new battle` (over).
  - Hint: `←/→ walk · ↑/↓ aim · Space fire · Tab weapon`; with a cursor `arrows move · Space here`; in the retreat
    `←/→ get away · Enter jump`.
  - Drawing per the spec's look; colours from the CSS variables as `LanderView` reads them (`--accent`, `--purple`,
    `--blue`, `--amber`, `--red`, `--text`, `--text-3`, `--line-2`, `--line-3`, `--raised-2`, `--well`). The ground is
    kept in an offscreen 828 × 160 canvas painted with `fillRect` runs (no `ImageData`: the unit tests' fake canvas has
    none), fully when `state.battle` changes and box by box for new `carved` entries (each box + 2 px). On the field:
    each fighter's HP over it, `▼` over the active one, `…` over a bug while `bot.stage` is `think`, the dotted aim with
    its crosshair before the use, the cursor's crosshair, shots, blasts, and a small `^` at the top edge under a shot
    that is above the map.
  - Use only DOM calls `FakeElement` in `physics-views.test.ts` supports (or extend `FakeElement` in the test).

- [ ] **Step 1: Write the failing tests** in `tests/unit/physics-views.test.ts`:

```ts
describe('ArtilleryView', () => {
  it('asks for a frame only while live and in a battle')   // title: no frame; Space → frame pending; setState(true,false) → none
  it('drops held keys and the charge when the keyboard leaves') // hold Space 0.3 s of frames, setState(true,false), setState(true,true): data-phase still 'aim', no shot; ArrowRight held then leave → data-x unchanged after frames
  it('puts the battle on its data attributes')             // after Space: phase aim, turn you, weapon rocket, ammo ∞, time 45; Digit2 → weapon grenade
  it('saves its record and shows its wins in the menu')    // new ArtilleryView({wins:3,streak:1,best:2}) → saveInto: 3/1/2; menuNote 'wins 3'
})
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/physics-views.test.ts` → FAIL.
- [ ] **Step 3: Implement** the view, the CSS block and the registration.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → no errors; `npm test` → all green.

---

### Task 9: End-to-end tests and the README

**Files:**
- Modify: `tests/e2e/games.spec.ts` (the `pick` helper's game type gains `'artillery'`; the menu test; new tests),
  `README.md:127`

**Interfaces:**
- Consumes: Task 8's class names and data attributes.

- [ ] **Step 1: Write the tests** (`const artillery = (page) => page.locator('#games .artillery')`):

```ts
test('the game menu lists all seven games; Lander, Pinball, Sand and Artillery can be picked')
// ids end with 'artillery'; its note 'wins 0'; picking it → data-game 'artillery', title 'Artillery'
test('in Artillery, the keys move, jump and pick weapons; nothing reaches the terminal or leaves the window')
// Space → data-phase 'aim'; hold ArrowRight 600 ms → data-x grows; Enter → data-air 'true';
// Digit2 → weapon grenade; Tab → fork; Shift+Tab → grenade; Digit8 → teleport;
// ptyInput unchanged; win(page) keeps data-keyboard 'game'
test('a shot hands the turn to the bot, and the bot hands it back')      // Review Focus 4; test.setTimeout(90_000)
// hold Space 1100 ms; data-phase leaves 'aim'; data-turn 'bot' within 30 s; then 'you' (or data-phase 'over') within 30 s
test('pause and a click in the terminal stop Artillery\'s clock')
// data-time falls while live; ⏸ → unchanged over 1.5 s; ▶ → falls; click in the terminal → unchanged over 1.5 s
test('Artillery\'s wins survive a restart')
// games.json written with artilleryWins 3, artilleryStreak 1, artilleryBest 2 → menu 'wins 3'; open Artillery, close
// the window, restart with the same dataDir → menu 'wins 3'; games.json still has the three
test('the window with Artillery stays within 300 × 350 px')              // Review Focus 5: boundingBox width ≤ 302, height ≤ 350
```

- [ ] **Step 2: Run** `npm run test:e2e -- tests/e2e/games.spec.ts` → the new tests pass (they test Task 8's work;
  if one fails, fix the view, not the test). Before Task 8 they would fail: confirm by reasoning that each asserts a
  behaviour Task 8 adds.
- [ ] **Step 3: README** line 127: "seven games … Runner, Merge, Clicker, Lander, Pinball, Sand and Artillery."
- [ ] **Step 4: Run** the full games e2e file → PASS.

---

### Task 10: Tune, record the numbers, and run everything

**Files:**
- Modify: `src/renderer/games/artillery-config.ts` (tuned values), `docs/superpowers/specs/2026-11-17-artillery-design.md`
  (a "Tuned numbers" section at the end, like the physics games' design)

- [ ] **Step 1: Tune by simulated play** with a scratch script under `tmpdir()` (deleted afterwards): run 30 seeded
  battles bot-against-bot through `step` and check that a battle ends in 10–40 turns, that a direct Rocket hit takes
  roughly half a fighter's HP, that a jump never hurts on flat ground, and that no battle reaches `settleMax` more than
  once in 30. Adjust only the config numbers.
- [ ] **Step 2: Record** the final numbers in the spec's new "Tuned numbers" section.
- [ ] **Step 3: Run** `npm run typecheck`, `npm test`, `npm run test:e2e`. Expected: all green. Report the output.
- [ ] **Step 4: Clean up**: delete the scratch script and anything else made for the work outside the repository;
  leave the worktree and its uncommitted changes for the user.
