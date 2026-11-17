# Physics games (Lander, Pinball, Sand) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three new games in the mini-games window — Lander, Pinball and Sand — with their best scores saved.

**Architecture:** Each game is a pure rules module (`*-rules.ts`: state, `step(state, input, dt)` with fixed steps and an
accumulator in the state, a seeded random in the state, no DOM) and a canvas view behind `GameView` (`*-view.ts`),
like Runner. A shared `FrameLoop` runs `requestAnimationFrame` only while a view is live and in play. `GamesSave` gains
three best scores that older saves lack without being bad.

**Tech Stack:** TypeScript (strict, `noUnusedLocals`), plain DOM and canvas 2D in the renderer, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-physics-games-design.md`. The base design of the window is
`docs/superpowers/specs/2026-11-16-mini-games-design.md`.

## Global Constraints

- **No commits.** Leave every change uncommitted in the worktree `D:\Workspace\ClaudeTerm\.claude\worktrees\feat-physics-games`.
  The "commit" step of the TDD cycle is skipped in every task.
- Work only inside that worktree. Never `cd` to the main checkout `D:\Workspace\ClaudeTerm`.
- AGENTS.md holds: English strings; tests through the entry point; no new dependencies; keep line endings (all the games
  files are LF); match the surrounding code (no semicolons, single quotes, 2-space indent, short doc comments on
  exports, `fmt = (n) => n.toLocaleString('en-US')` for numbers).
- The renderer has no UI framework; views build their DOM with `document.createElement` like `runner-view.ts`.
- Colours come from CSS variables read once in the constructor (`getComputedStyle(document.documentElement)`), like
  `RunnerView`.
- If another agent's work collides with yours (a shared file, a lock, a build), stop and report it; do not edit,
  revert or kill the other side's work.

## Review Focus

- **Keys held while the keyboard leaves.** A key held when the window loses the keyboard gets its keyup elsewhere: a
  view must forget held keys when it stops being live, or the thrust or a flipper stays on when the person comes back.
  Pinned by the view tests in Tasks 4–6 ("held keys are forgotten when the game stops being live").
- **The time away.** After a pause, a fold or the app in the background, the first frame must not step the time that
  passed. Pinned by `tests/unit/frame-loop.test.ts` (Task 3) and the rules' `maxDt` test (Task 2).
- **A ball stuck or flung out.** Under random flipper play the ball must stay on the table and finite. Pinned by
  "under a minute of random play the ball stays on the table" (Task 2).
- **An old `games.json`.** A save without the new fields loads whole with no warning. Pinned in Task 1 (unit and
  integration).
- **Keys reaching the terminal.** Arrows and Space in the new games never reach the tab. Pinned by the e2e tests of
  Task 7.

---

### Task 1: The save knows the three new best scores

**Files:**
- Modify: `src/shared/games.ts`
- Modify: `src/main/ipc-guards.ts:150-151`
- Test: `tests/unit/games-save.test.ts`, `tests/unit/ipc-guards.test.ts:529-537`, `tests/integration/games-store.int.test.ts`

**Interfaces:**
- Produces (in `src/shared/games.ts`):
  - `GAME_IDS = ['runner', 'merge', 'clicker', 'lander', 'pinball', 'sand'] as const` (that order).
  - `GamesSave` gains `landerBest: number`, `pinballBest: number`, `sandBest: number` (place them right after
    `runnerBest`, with one doc comment: the best scores of the games added later; a save written before them has none).
  - `EMPTY_GAMES` gains the three at `0`.
  - `export const LATER_BESTS = ['landerBest', 'pinballBest', 'sandBest'] as const` — doc: the best scores a save from
    before these games lacks; a missing one is 0, not a bad part.
  - `parseGamesSave`: for each key of `LATER_BESTS`: `undefined` → `0`, not bad; a value that fails `isScore` (safe
    integer 0..1e12) → `0` and the key pushed to `bad`; else kept. The returned save holds exactly the known fields.
  - `isGamesSave` (ipc-guards): `parseGamesSave(v).bad.length === 0 && LATER_BESTS.every((key) => key in (v as object))`
    — doc: a whole games save from the renderer: every part there and valid, none replaced or left out.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/games-save.test.ts`: add `landerBest: 120, pinballBest: 4800, sandBest: 2140` to `valid`, and the three
at `0` to the `null parts are valid` save. Add:

```ts
  it('a save from before Lander, Pinball and Sand loads whole: their bests are 0 and nothing is bad', () => {
    const old = { game: 'merge', runnerBest: 42, merge, clicker }
    const result = parseGamesSave(old)
    expect(result.save).toEqual({ ...old, landerBest: 0, pinballBest: 0, sandBest: 0 })
    expect(result.bad).toEqual([])
  })

  it('Lander, Pinball and Sand can be the last game chosen', () => {
    for (const game of ['lander', 'pinball', 'sand'] as const) {
      const result = parseGamesSave({ ...valid, game })
      expect(result.save.game).toBe(game)
      expect(result.bad).toEqual([])
    }
  })

  it('a new best that is out of range or not an integer is bad and 0; the rest is kept', () => {
    for (const [key, value] of [['landerBest', -1], ['pinballBest', 1.5], ['sandBest', 1e13], ['sandBest', '5']] as const) {
      const result = parseGamesSave({ ...valid, [key]: value })
      expect(result.save[key]).toBe(0)
      expect(result.bad).toEqual([key])
      expect(result.save.merge).toEqual(merge)
      expect(result.save.runnerBest).toBe(42)
    }
  })
```

In `tests/unit/ipc-guards.test.ts`, the `isGamesSave` test: give `save` `landerBest: 0, pinballBest: 7, sandBest: 0`
and add:

```ts
    const { landerBest, ...withoutLander } = save
    expect(landerBest).toBe(0)
    expect(isGamesSave(withoutLander)).toBe(false)
    expect(isGamesSave({ ...save, pinballBest: -1 })).toBe(false)
    expect(isGamesSave({ ...save, game: 'sand' })).toBe(true)
```

In `tests/integration/games-store.int.test.ts`: give `save` `landerBest: 120, pinballBest: 4800, sandBest: 2140`, and add:

```ts
  it('a games.json from before Lander, Pinball and Sand loads with no error, their bests at 0', () => {
    const d = dir()
    const errors: string[] = []
    const { landerBest, pinballBest, sandBest, ...old } = save
    expect([landerBest, pinballBest, sandBest]).toEqual([120, 4800, 2140])
    writeFileSync(join(d, 'games.json'), JSON.stringify(old))
    const store = new GamesStore(d, (m) => errors.push(m))
    expect(store.get()).toEqual({ ...old, landerBest: 0, pinballBest: 0, sandBest: 0 })
    expect(errors).toEqual([])
    store.set(save)
    expect(new GamesStore(d).get()).toEqual(save)
  })
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/games-save.test.ts tests/unit/ipc-guards.test.ts tests/integration/games-store.int.test.ts`
Expected: FAIL (the new fields are missing from the parsed save; the guard takes a save without `landerBest`).

- [ ] **Step 3: Implement the Interfaces above in `src/shared/games.ts` and `src/main/ipc-guards.ts`**

- [ ] **Step 4: Run them and see them pass**

Same command. Expected: PASS. Then `npm run typecheck`: errors may remain only in files of the other tasks (views
not yet built); none in the files of this task.

---

### Task 2: The rules of Lander, Pinball and Sand

The three rules modules, the seeded random and their unit tests were written and tuned while this plan was written
(53 tests, passing, type-checked under the project's strict settings). They are in `D:/ct-scratch/physics-games/proto/`.
This task moves them into the repository, tests first.

**Files:**
- Create: `src/renderer/games/random.ts`, `src/renderer/games/lander-rules.ts`, `src/renderer/games/pinball-rules.ts`,
  `src/renderer/games/sand-rules.ts`
- Test: `tests/unit/lander-rules.test.ts`, `tests/unit/pinball-rules.test.ts`, `tests/unit/sand-rules.test.ts`

**Interfaces:**
- Produces (read the files for the full doc comments):
  - `random.ts`: `interface Random { next(): number; seed(): number }`, `seeded(seed: number): Random`, `newSeed(): number`.
  - `lander-rules.ts`: `LANDER` (numbers), `levelSpec(level)`, `makeTerrain(spec, rand)`, `groundY(terrain, x)`,
    `feet(s)`, `touching(s)`, `touchdown(s)`, `landingPoints(level, fuel)`, `newRun(seed): LanderState`,
    `start(s)`, `step(s, input: LanderInput, dt)`; types `Point`, `Terrain`, `LevelSpec`,
    `LanderPhase = 'ready' | 'flying' | 'landed' | 'crashed'`, `LanderState` (fields `phase, level, score, gained,
    terrain, wind, x, y, vx, vy, angle, fuel, thrusting, timer, seed, acc`), `LanderInput = { thrust, left, right }`.
  - `pinball-rules.ts`: `PINBALL` (numbers), `TABLE` (`walls`, `targets`, `bumpers`, `posts`, `lane`, `laneX`,
    `flippers`), `PLUNGER = { x: 177, y: 241 }`, `newGame(): PinballState`, `start(s)`, `step(s, input: PinballInput, dt)`,
    `launchSpeed(power)`, `flipperTip(i: 0 | 1, angle)`; types `Segment`, `Circle`, `Ball`, `Flipper`,
    `PinballPhase = 'ready' | 'play' | 'over'`, `PinballState` (fields `phase, score, balls, ball, onPlunger, power,
    flippers, lit, inLane, flash: { bumpers, targets, lane }, acc`), `PinballInput = { left, right, plunger }`.
  - `sand-rules.ts`: `SAND` (numbers: `cols 8, rows 12, k 5, width 40, height 60`, …), `PIECES` (each
    `{ name, size, cells }`), `colorOf(v)`, `grain(color, shade)`, `pieceCells(p)`, `fits(grid, p)`, `spawn(shape, color)`,
    `fallSpeed(score)`, `findClears(grid)`, `newGame(seed): SandState`, `start(s)`, `step(s, input: SandInput, dt)`;
    types `Piece = { shape, turn, color, x, y }` (x, y in grains, the piece box's top-left), `SandPhase = 'ready' |
    'playing' | 'over'`, `SandState` (fields `phase, grid: Uint8Array, piece, next: { shape, color }, score, chain,
    landed, fall, hold, flash: { cells, left }, tick, seed, acc`), `SandInput = { left, right, down, turn, drop, tapLeft,
    tapRight }` (the first three held, the rest pressed since the last frame).

- [ ] **Step 1: Copy the tests in, with their imports pointed at the repository**

```bash
P=D:/ct-scratch/physics-games/proto
for g in lander pinball sand; do
  sed -e "s#from './\([a-z-]*\)\.ts'#from '../../src/renderer/games/\1'#" "$P/$g-rules.test.ts" > "tests/unit/$g-rules.test.ts"
done
grep -n "from '" tests/unit/lander-rules.test.ts tests/unit/pinball-rules.test.ts tests/unit/sand-rules.test.ts
```

Expected: every import is `vitest` or `../../src/renderer/games/<module>` with no `.ts` extension.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/lander-rules.test.ts tests/unit/pinball-rules.test.ts tests/unit/sand-rules.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Copy the modules in, with extension-less imports**

```bash
P=D:/ct-scratch/physics-games/proto
for m in random lander-rules pinball-rules sand-rules; do
  sed -e "s#from './\([a-z-]*\)\.ts'#from './\1'#" "$P/$m.ts" > "src/renderer/games/$m.ts"
done
grep -n "from '" src/renderer/games/random.ts src/renderer/games/*-rules.ts
```

- [ ] **Step 4: Run them and see them pass**

Same vitest command. Expected: 3 files, 53 tests, PASS. Then `npx tsc --noEmit -p tsconfig.json` shows no error in
these seven files (errors in other tasks' files are not yours).

---

### Task 3: A shared frame loop, and every game that runs in time pauses when it loses the keyboard

**Files:**
- Create: `src/renderer/games/frame-loop.ts`, `src/renderer/games/bug.ts`
- Modify: `src/renderer/games/game-view.ts`, `src/renderer/games/runner-view.ts`, `src/renderer/games/merge-view.ts`,
  `src/renderer/games/clicker-view.ts`, `src/renderer/games/games-window.ts:222-224`
- Test: `tests/unit/frame-loop.test.ts`

**Interfaces:**
- Produces:
  - `export class FrameLoop { constructor(frame: (dt: number) => boolean); start(): void; stop(): void }` in
    `frame-loop.ts`. `start()` asks for one animation frame unless one is pending. A frame: the first frame of a loop
    (no clock yet) only sets the clock and goes on; a later one calls `frame((now - last) / 1000)` and goes on only if it
    returns true; a loop that does not go on forgets its clock. `stop()` cancels the pending frame and forgets the clock.
    Doc comment: the animation loop of a game that runs in time; it asks for frames only while it is on, and its first
    frame only sets the clock, so time while it was off is never stepped.
  - `GameView` gains `readonly realtime: boolean` — doc: true for a game that moves on its own while played (Runner,
    Lander, Pinball, Sand): the window pauses it when the keyboard leaves the window or the app loses focus.
    `RunnerView.realtime = true`, `MergeView.realtime = false`, `ClickerView.realtime = false`.
  - `GamesWindow.pauseOnLeave()` pauses the game in front when `this.current?.realtime` (instead of `id === 'runner'`).
  - `bug.ts`: `export const BUG` (the 7 × 5 bug rows now in `runner-view.ts`) and `export function paintPixels(ctx, rows,
    x, y, color)` (moved from `runner-view.ts`, unchanged); `runner-view.ts` imports them from there.

- [ ] **Step 1: Write the failing test `tests/unit/frame-loop.test.ts`**

Stub `requestAnimationFrame` (keeps the callback in `pending`, returns an id that counts up) and `cancelAnimationFrame`
(clears `pending`, records the id) with `vi.stubGlobal`, as `tests/unit/runner-view.test.ts` does; `afterEach` unstubs.
Tests (the recorded `dt`s are the frame callback's arguments):

```ts
  it('asks for one frame at a time', () => {
    const loop = new FrameLoop(() => true)
    loop.start()
    loop.start()
    expect(requested).toBe(1)
  })

  it('its first frame only sets the clock; the next one steps the time since', () => {
    const dts: number[] = []
    const loop = new FrameLoop((dt) => (dts.push(dt), true))
    loop.start()
    frame(1000)
    expect(dts).toEqual([])
    frame(1016)
    expect(dts).toEqual([0.016])
  })

  it('a frame that says stop asks for no more, and the next start begins a new clock', () => {
    const dts: number[] = []
    const loop = new FrameLoop((dt) => (dts.push(dt), false))
    loop.start()
    frame(0)
    frame(16)
    expect(pending).toBeNull()
    loop.start()
    frame(5000)
    expect(dts).toEqual([0.016])
  })

  it('stop cancels the frame it waits for and forgets the clock', () => {
    const dts: number[] = []
    const loop = new FrameLoop((dt) => (dts.push(dt), true))
    loop.start()
    frame(0)
    loop.stop()
    expect(pending).toBeNull()
    loop.start()
    frame(9000)
    frame(9010)
    expect(dts).toEqual([0.01])
  })
```

(`frame(now)` runs and clears `pending`; use `toBeCloseTo` if float rounding bites.)

- [ ] **Step 2: Run it and see it fail** — `npx vitest run tests/unit/frame-loop.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement the Interfaces above.** `runner-view.ts` keeps its own loop (do not change Runner's loop).

- [ ] **Step 4: Run** `npx vitest run tests/unit/frame-loop.test.ts tests/unit/runner-view.test.ts` → PASS.

---

### Tasks 4–6: the three views — what they share

Each view is a class in its own file implementing `GameView`, built like `RunnerView` (read `runner-view.ts` first):

- Constructor `(best: number, changed: () => void, seed: () => number = newSeed)` (Pinball has no seed parameter).
- `pausable = true`, `realtime = true`. `canPause()` is true only while a run or game is in play.
- `private live = false`; `setState(shown, live)`: `this.live = shown && live`; if live and in play → `loop.start()`;
  else `loop.stop()` and forget held keys (and pending presses). Then `paint()`.
- `key(code, down)`: returns false for keys that are not the game's; for the game's keys: a keyup removes the key from
  the held set (also while not live) and returns true; a keydown while not live is ignored (returns true); otherwise it
  is recorded (held set, and a pending press where the game uses presses), may start the game, and `paint()` runs.
- The loop is a `FrameLoop` whose frame function builds the input, calls the rules' `step`, clears pending presses,
  raises `best` when the score passes it (then calls `changed()`), paints, and returns `live && in play`.
- `saveInto(save)` writes its best (`landerBest` / `pinballBest` / `sandBest`). `menuNote()` → `` `best ${fmt(best)}` ``.
- `paint()` writes the root's data attributes and the text, then draws the canvas. The canvas is sized like Runner's:
  `width/height` in field units × `devicePixelRatio`, `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`; CSS gives its size.
- Messages on the canvas use `13px` or `12px ${MONO}` with `MONO = 'ui-monospace, Consolas, monospace'`, centred.
- CSS goes into `games.css` after the Runner block, in the same style (`.lander { display: flex; flex-direction: column;
  gap: 8px; }`, heads and hints like `.runner-head` / `.runner-hint`, numbers in the monospace family).
- Register the view in `GamesWindow.init()` after Clicker, in the order Lander, Pinball, Sand:
  `new LanderView(save.landerBest, () => this.changed())`, and so on.
- Unit test file `tests/unit/physics-views.test.ts`, shared by Tasks 4–6: copy the fake DOM of
  `tests/unit/runner-view.test.ts` (its `FakeElement` gets `style: Record<string, string> = {}` and `classList = {
  toggle() {}, add() {}, remove() {} }`), the rAF stubs and `frame(now)`. Each task adds one `describe` block with:
  - `'asks for a frame only while live and in play'`: `setState(true, true)` → no pending frame; the start key → a pending
    frame; `setState(true, false)` → none; `setState(true, true)` → one again; `setState(false, false)` → none.
  - `'a key while not live does nothing'`: `setState(true, false)`; the start key → `el.dataset.phase` stays `'ready'`.
  - `'held keys are forgotten when the game stops being live'` (named per task below).
  - `'writes its best into the save'`: a view made with best 77 → `saveInto` sets its field to 77; `menuNote()` is
    `'best 77'`.

### Task 4: Lander view

**Files:** Create `src/renderer/games/lander-view.ts`; modify `games-window.ts`, `games.css`; test
`tests/unit/physics-views.test.ts`.

**Interfaces:** Consumes Task 2's `lander-rules.ts`, `random.ts`, Task 3's `FrameLoop`, `clawd.ts`'s `CLAWD` and
`paintSprite`. Produces `export class LanderView implements GameView` with `id = 'lander' as const`, `title = 'Lander'`.

- Keys: `ArrowUp` and `Space` thrust (held), `ArrowLeft`/`ArrowRight` turn (held). A keydown of `ArrowUp` or `Space`
  while `ready` starts the run (`start`) and the loop; a keydown of `Space` while `crashed` starts a new run. In play
  is `flying` or `landed`.
- DOM (root `.lander`): `.lander-head` with `.lander-score` (`score N`) and `.lander-best` (`best N`); canvas
  `.lander-canvas` (field 300 × 200; CSS `width: 298px; height: 200px; margin: 0 -12px`); `.lander-hud` with spans
  `.lander-vx` (`→ 3` for vx ≥ 0, `← 3` below), `.lander-vy` (`↓ 12` for vy ≥ 0, `↑ 4` below), `.lander-angle`
  (`∠ 4°`), `.lander-fuel` (`fuel 82`), `.lander-level` (`L2`), `.lander-wind` (`wind → 2.5` / `wind ← 2.5`, `hidden`
  when wind is 0); `.lander-hint`: `↑/Space thrust · ←/→ turn`. Numbers in the HUD are `Math.round(Math.abs(v))` (wind
  one decimal). Class `bad` (red) on `.lander-vx` / `.lander-vy` / `.lander-angle` while the value is past
  `LANDER.safeVx` / `safeVy` / `safeAngle`, and on `.lander-fuel` below 15.
- Data attributes on the root: `phase`, `level`, `fuel` (`Math.round(fuel)`), `vx`, `vy`, `angle` (each `Math.round`).
- Drawing (field px, y down; colours `--accent --text --text-3 --text-4 --line-3 --raised --raised-2 --green --red
  --amber`):
  - 24 fixed stars, 1 × 1 px in `--text-4`, in the upper half, from `seeded(7)` once at module load.
  - The ground: a path from (0, 200) along `terrain.points` to (300, 200), filled `--raised-2`, stroked `--line-3`.
  - The pad: a 2 px `--green` bar along `padY` from `padX0` to `padX1`; `[` right-aligned at `padX0 - 1` and `]`
    left-aligned at `padX1 + 1`, `11px` mono, `--text-3`, middle baseline at `padY`.
  - The craft, translated to (x, y) and rotated by `angle` degrees: while `thrusting`, a flame triangle (−4, 5), (4, 5),
    (0, 5 + len) in `--amber` with an inner one (−2, 5), (2, 5), (0, 5 + 0.6 len) in `--accent`, `len = 8 + 2 × (paints
    % 3)`; legs `--text-3` 1.5 px from (−7, 4) to (−footX, footY) and (7, 4) to (footX, footY), foot pads 6 × 2 px ending
    at `footY`; the canopy `roundRect(−11, −12, 22, 14, 5)` filled `--raised`, stroked `--text-3` (`--red` when
    crashed); Clawd `paintSprite(ctx, CLAWD, −9, −11, 1, accent or red when crashed)`; the base `fillRect(−12, 2, 24, 3)`
    `--text-3`.
  - Message at (150, 70) in `--text`: ready `Space or ↑ to start`; landed `` `Landed · +${gained}` ``; crashed
    `Crashed · Space to fly again`.
- The held-keys test: start with `ArrowUp`, hold `ArrowUp`, `setState(true, false)`, `setState(true, true)`, run two
  frames 100 ms apart → `el.dataset.fuel` is `'100'` (no thrust after coming back).

Steps: write the `describe('LanderView', …)` tests → run `npx vitest run tests/unit/physics-views.test.ts` → FAIL →
implement → PASS → `npm run typecheck` clean for these files.

### Task 5: Pinball view

**Files:** Create `src/renderer/games/pinball-view.ts`; modify `games-window.ts`, `games.css`; test
`tests/unit/physics-views.test.ts`.

**Interfaces:** Consumes `pinball-rules.ts`, `FrameLoop`, `bug.ts`. Produces `export class PinballView implements
GameView`, `id = 'pinball' as const`, `title = 'Pinball'`, constructor `(best: number, changed: () => void)`.

- Keys: `ArrowLeft`, `ArrowRight` (flippers, held) and `Space` (plunger, held). A keydown of `Space` while `ready` or
  `over` starts the game (`start`) and the loop; the same press then pulls the plunger. In play is `play`. The input
  counts a key as held if it is held now or was pressed since the last frame, so a tap shorter than a frame still acts.
- DOM (root `.pinball`): `.pinball-main` (flex row, gap 10px) with canvas `.pinball-canvas` (field 190 × 250, CSS 190 ×
  250) and `.pinball-side` (flex column, gap 10px) of four `.pinball-stat` blocks, each a `.pinball-label` and a value:
  `score` / `.pinball-score`, `best` / `.pinball-best`, `balls` / `.pinball-balls` (`● ● ○`: `●` per ball left, `○` per
  ball lost, joined by spaces), `power` / `.pinball-power` (a 6 px bar, `--raised-2`, radius 3) holding
  `.pinball-power-fill` (`--accent`, `style.width = power × 100 %`); then `.pinball-hint`: `←/→ flippers · Space launch`.
- Data attributes: `phase`, `score`, `balls`, `ball` (`plunger` or `loose`), `ballX`, `ballY` (`Math.round`), `power`
  (`Math.round(power × 100)`).
- Drawing (field 190 × 250): the table filled `--field`; each wall a 2 px `--line-3` line with round caps; each target a
  3 px line, `--amber` while lit, else `--line-3`, with `{` (left, x 13) and `}` (right, x 163, right-aligned) at y 134 in
  `16px` mono: `--text` while it flashes, `--amber` while lit, else `--text-3`; the posts as filled `--line-3` circles; `>_`
  at the lane's centre (95, 36), `11px` mono, `--green` while it flashes, else `--text-3`; each bumper a circle filled
  `--red` while it flashes, else `--raised-2`, stroked `--red` 2 px, with `BUG` painted at (x − 7, y − 5) in `--raised`
  while it flashes, else `--red`; each flipper a line from its pivot to `flipperTip` in `--accent`, width
  `2 × PINBALL.flipperR`, round caps; the plunger head `fillRect(172, 246 + 3 × power, 10, 2)` `--text-3`; the ball a
  circle of `PINBALL.ballR` in `--text`, drawn `3 × power` lower while on the plunger. Message at (88, 165) in `--text`:
  ready `Space to launch`; over `Game over` and below it `Space to play again`.
- The held-keys test: start with `Space` held, `setState(true, false)`, `setState(true, true)`, two frames 100 ms apart
  → `el.dataset.power` is `'0'` and `el.dataset.ball` is `'plunger'`. Add `'Space pulls the plunger and its release
  launches the ball'`: `Space` down, frames every 100 ms from 0 to 500 ms (a longer gap is clamped to 0.1 s by the
  rules) → `Number(power)` > 40; `Space` up, frame at 516 → `ball` is `'loose'`.

### Task 6: Sand view

**Files:** Create `src/renderer/games/sand-view.ts`; modify `games-window.ts`, `games.css`; test
`tests/unit/physics-views.test.ts`.

**Interfaces:** Consumes `sand-rules.ts`, `random.ts`, `FrameLoop`. Produces `export class SandView implements GameView`,
`id = 'sand' as const`, `title = 'Sand'`.

- Keys: `ArrowLeft`/`ArrowRight` (a press is a tap, held repeats in the rules), `ArrowDown` (held), `ArrowUp` (press:
  turn), `Space` (press: drop). A keydown of `Space` while `ready` or `over` starts the game and the loop and is not a
  drop. In play is `playing`. Presses wait in a pending input until the next frame's `step`, then are cleared.
- DOM (root `.sand`): `.sand-main` (flex row, gap 12px) with canvas `.sand-canvas` (160 × 240: 40 × 60 grains of 4 px)
  and `.sand-side` (flex column, gap 10px): `.sand-label` `next` with canvas `.sand-next` (48 × 48), `score` /
  `.sand-score`, `best` / `.sand-best`; then `.sand-hint`: `←/→ move · ↑ turn · ↓ faster · Space drop`.
- Data attributes: `phase`, `score`, `pieceX`, `pieceY` (the piece's `x`, `y` in grains; empty string with no piece),
  `chain`.
- Colours: the four piece colours are `--accent`, `--blue`, `--green`, `--amber` (colour index 0–3). A grain value `v`
  (1–16) is colour `colorOf(v)` with shade `(v - 1) % 4`; the shade multiplies the colour's RGB by `[1, 0.9, 0.8, 1.1][shade]`
  (clamped to 255). Build the 17 fill styles once (index 0 unused); parse `#rrggbb`; a colour that is not `#rrggbb`
  is used as it is for every shade.
- Drawing: the board filled `--well`; each grain a 4 × 4 `fillRect`; while `flash.left > 0`, each flash cell
  `rgba(255, 255, 255, 0.8 × left / SAND.flashFor)`; the piece's cells as 20 × 20 blocks in shade 0 with a 1 px inner
  outline in shade 2; the board's outline `--line-2`. The next piece on `.sand-next` at 12 px a cell, centred in its box.
  Message on a `--raised` band across the board's middle, in `--text`: ready `Space to start`; over `Game over` and
  `Space to play again`.
- The held-keys test: start with `Space`; hold `ArrowLeft` (keydown), `setState(true, false)`, `setState(true, true)`;
  frames at 0, then every 50 ms to 1 s → `el.dataset.pieceX` equals its value right after the restart frame (no repeat
  of a key that is no longer known to be held). Add `'←/→ move the piece a cell'`: start, frame at 0; `ArrowRight` down
  and up; frame at 16 → `pieceX` grew by `SAND.k`.

---

### Task 7: End-to-end tests

**Files:** Modify `tests/e2e/games.spec.ts`.

**Interfaces:** Consumes the classes and data attributes of Tasks 4–6, `win`, `toggle`, `ptyInput`, `pick`,
`closeWindow`, `makeDataDir`, `launchApp`, `KEYS` of the spec. Widen `pick`'s game parameter to
`'runner' | 'merge' | 'clicker' | 'lander' | 'pinball' | 'sand'`.

Tests to add (each launches its own app and closes it):

1. `'the game menu lists all six games; Lander, Pinball and Sand can be picked'` — open the window, open the menu: the
   items' `data-game` in order are `runner, merge, clicker, lander, pinball, sand`; the new ones' `.games-menu-note` is
   `best 0`. Pick each new game → `win` has `data-game` of it and `.games-title` its title.
2. `'in Lander, holding ↑ burns fuel and changes the speed; no key reaches the terminal'` — pick lander; `.lander` has
   `data-phase="ready"`, `data-fuel="100"`; note `ptyInput`; `keyboard.down('ArrowUp')`; poll `data-fuel` < 100 and
   `data-vy` < 0; `keyboard.up('ArrowUp')`; press `ArrowLeft`, `ArrowRight`, `KeyX`, `Enter`; `ptyInput` unchanged.
3. `'in Pinball, Space launches the ball'` — pick pinball; `data-ball="plunger"`; `keyboard.down('Space')`; poll
   `data-power` > 40; `keyboard.up('Space')`; expect `data-ball="loose"`; poll `data-ball-y` < 200.
4. `'in Sand, ←/→ move the piece; no key reaches the terminal'` — pick sand; press `Space` → `data-phase="playing"`;
   read `data-piece-x` (x0); press `ArrowLeft` → poll `data-piece-x` = x0 − 5; press `ArrowRight` twice → x0 + 5;
   `ptyInput` unchanged.
5. `'pause stops Lander, Pinball and Sand, and so does a click in the terminal'` — for each game, with the attribute
   that moves (`.lander` `data-vy`; `.pinball` `data-ball-y`; `.sand` `data-piece-y`): pick it; start it (Lander: press
   `Space`; Pinball: `Space` down, wait 400 ms, up, wait 150 ms; Sand: press `Space`); click `#games .games-pause` →
   `data-paused="true"`; read the attribute, wait 500 ms, read again: equal. For Lander and Sand: press `Space` →
   `data-paused="false"`, poll the attribute changes. Then click the terminal (`.terminal-host:visible .xterm`) →
   `data-paused="true"`; give the keyboard back before the next game with `win(page).click({ position: { x: 150, y: 220 } })`
   as the existing tests do (the header's name would open the menu).
6. `'the best scores of Lander, Pinball and Sand survive a restart'` — `makeDataDir()`; write `games.json` with
   `{ game: 'pinball', runnerBest: 0, landerBest: 120, sandBest: 340, merge: null, clicker: null }` (no `pinballBest`:
   an older save). Launch, open the window (it shows Pinball); `Space` down for 1100 ms (a full pull: the ball's path is
   the same every time and hits a bumper within a few seconds), up; poll `.pinball` `data-score` > 0 (timeout 15 s);
   read it as `score`; click `#games .games-close`; poll the file until `pinballBest` equals `score`, with `landerBest`
   120 and `sandBest` 340; `closeWindow`. Launch again on the same folder, open the window, open the menu: notes
   `best 120` (lander), `` `best ${score.toLocaleString('en-US')}` `` (pinball), `best 340` (sand).

Run: `npm run build` once, then `npx playwright test tests/e2e/games.spec.ts` (never `npm run test:e2e -- -g`: it runs
nothing; never the whole suite: it takes 80 minutes). Expected: every test passes, the old ones too. If an old games
test fails, run it again alone; if it fails on clean `origin/master` as well, report it as flaky rather than changing it.
