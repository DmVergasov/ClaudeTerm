# Mini-games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small game window over the bottom-right corner of the tab's view with three games (Runner, Merge, Clicker), opened by a sheet-header toggle and Ctrl+Shift+G / ⌘G, with pause, fold and close, and state kept across restarts.

**Architecture:** The games' rules are pure modules in `src/renderer/games/` (no DOM, seeded randomness, injected clock), each with a thin view. `GamesWindow` owns the overlay (`#games` inside `#terminals`), the header, the pill, the keyboard model and saving. Main keeps the state in `games.json` in the data folder through two IPC calls; the save format and its validation live in `src/shared/games.ts`, used by both sides.

**Tech Stack:** Electron, TypeScript (strict), plain DOM and `<canvas>`, Vitest, Playwright.

**Spec:** `D:\Workspace\ClaudeTerm\docs\superpowers\specs\2026-11-16-mini-games-design.md`

**Base:** `origin/master` at `cfe077a` (fetched again on 2026-11-16 before execution: unchanged). The work goes into a new worktree `D:\ct-scratch\mini-games` on a new branch `feat/mini-games` made from that commit. The main checkout (`D:\Workspace\ClaudeTerm`, on the merged `feat/tab-working-spinner`) and the local `master` (checked out in another worktree) are not touched. Master is not merged in again in the middle of the plan; if it moves, it is brought in once at the end.

## Global Constraints

- Build on `origin/master` (0.22.x as of 2026-11-16) in a new worktree on a new branch `feat/mini-games`, never on the old `feat/tab-working-spinner` checkout. Line numbers below are from `origin/master` at `cfe077a`; find the code by the names given if they moved.
- **Do not commit.** Leave every change uncommitted; the user commits.
- No new dependencies, no UI framework. Every UI-visible string is English. Comments in English.
- The renderer reaches the system only through the preload bridge (`window.ct`); main checks every IPC argument with a guard in `src/main/ipc-guards.ts`.
- Anything read from `games.json` or received over IPC is validated; bad parts degrade to a fresh start of that part.
- Match the surrounding code: naming, comment density, idioms; keep each file's line endings.
- Tests: unit in `tests/unit/*.test.ts`, integration in `tests/integration/*.int.test.ts`, e2e in `tests/e2e/games.spec.ts`. Tests write only under `tmpdir()`, start the app through `tests/e2e/helpers.ts`, and close what they start.
- Done means `npm run typecheck`, `npm test` and `npm run test:e2e` pass.
- Theme variables (colors.css on master): `--accent`, `--raised`, `--raised-2`, `--line-2`, `--text`, `--text-3`, `--term`. Monospace for numbers.

## Review Focus

1. **A reply in the chat steals the keyboard from the game.** The chat view may focus its composer when content arrives; the person expects the game to keep the keyboard (Task 7 pins it with an e2e test).
2. **App shortcuts while the game has the keyboard.** Ctrl+Shift+T, Ctrl+Tab, the panel shortcuts must still work, and a tab switch must give the keyboard to the new tab (Task 6 pins new tab and tab switch).
3. **Held keys.** Holding Space must not make Clawd hop again and again, and holding an arrow must not run several Merge moves: the window drops auto-repeated keydowns (`e.repeat`) (Task 6 e2e test with synthetic repeated keydowns).
4. **The clock jumps back** (sleep, time zone, manual change): the Clicker must not lose lines or earn a negative amount (Task 5 unit test).
5. **A big frame gap** (window hidden, machine asleep) must not throw Clawd through obstacles: `step` clamps `dt` to 0.05 s and the loop stops while hidden (Task 4 unit test, Task 8 loop rule).

---

### Task 1: The save format and its validation

**Files:**
- Create: `src/shared/games.ts`
- Test: `tests/unit/games-save.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GAME_IDS = ['runner', 'merge', 'clicker'] as const
  export type GameId = (typeof GAME_IDS)[number]
  /** board: 16 cells row by row; 0 is empty, e > 0 is a tile of 2^(e-1) KB (1 → 1 KB, 11 → 1 MB) */
  export interface MergeSave { board: number[]; score: number; best: number; won: boolean }
  /** lines may be fractional; helpers: how many of each of the 4 helpers; at: ms since epoch the lines were last brought up to date */
  export interface ClickerSave { lines: number; helpers: number[]; at: number }
  export interface GamesSave { game: GameId; runnerBest: number; merge: MergeSave | null; clicker: ClickerSave | null }
  export const EMPTY_GAMES: GamesSave // { game: 'runner', runnerBest: 0, merge: null, clicker: null }
  /** each part checked on its own: a bad part is replaced by its empty value and named in `bad` ('game', 'runnerBest', 'merge', 'clicker'); a non-object is EMPTY_GAMES with bad ['all'] */
  export function parseGamesSave(raw: unknown): { save: GamesSave; bad: string[] }
  ```
- Limits: board length exactly 16, each cell an integer 0..30; `score`, `best`, `runnerBest` safe integers 0..1e12; `won` boolean; `lines` finite 0..1e15; `helpers` length exactly 4, integers 0..1e6; `at` finite ≥ 0. `merge: null` and `clicker: null` are valid. The parsed save holds only the known fields (copies, not the input objects).

- [ ] **Step 1: Write the failing tests** in `tests/unit/games-save.test.ts`:
  - `'a full valid save comes back equal, with nothing bad'` — a save with all parts → `save` deep-equals it, `bad` is `[]`.
  - `'null parts are valid'` — `{ game: 'merge', runnerBest: 3, merge: null, clicker: null }` → same, `bad: []`.
  - `'one bad part is dropped, the others are kept'` — `merge.board` of length 15 → `save.merge === null`, `bad` is `['merge']`, `runnerBest` and `clicker` kept.
  - `'an unknown game falls back to runner'` — `game: 'chess'` → `save.game === 'runner'`, `bad` contains `'game'`.
  - `'out-of-range numbers are bad'` — cell 31, `helpers` `[1, -1, 0, 0]`, `lines: Infinity`, `runnerBest: 1.5` each make their part bad.
  - `'garbage is an empty save'` — `null`, `'x'`, `[]` → `EMPTY_GAMES`, `bad: ['all']`.
  - `'extra fields are not kept'` — `{ ...valid, extra: 1, merge: { ...m, x: 2 } }` → no `extra`, no `x`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/games-save.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/shared/games.ts` as in Interfaces.
- [ ] **Step 4: Run** `npx vitest run tests/unit/games-save.test.ts` — expect PASS.

### Task 2: The store in main and the IPC calls

**Files:**
- Create: `src/main/games-store.ts`
- Modify: `src/shared/ipc.ts` (IPC constant ~:16–237; `CtApi` ~:313), `src/preload/index.ts` (next to `getTabLayout` ~:96), `src/main/ipc-guards.ts`, `src/main/index.ts` (store next to `TabLayoutStore` ~:320; handlers next to `IPC.layoutGet` ~:2953)
- Test: `tests/integration/games-store.int.test.ts`, `tests/unit/ipc-guards.test.ts` (add)

**Interfaces:**
- Consumes: `GamesSave`, `EMPTY_GAMES`, `parseGamesSave` (Task 1).
- Produces:
  ```ts
  // src/main/games-store.ts — modelled on TabLayoutStore (src/main/tab-layout.ts)
  export class GamesStore {
    readonly path: string // join(dir, 'games.json')
    constructor(dir: string, onError?: (message: string) => void)
    get(): GamesSave
    set(save: GamesSave): void // writes `${path}.tmp`, then renameSync over path
  }
  // src/shared/ipc.ts
  gamesGet: 'games:get', gamesSet: 'games:set'
  getGames(): Promise<GamesSave>      // CtApi, ipcRenderer.invoke(IPC.gamesGet)
  saveGames(save: GamesSave): void    // CtApi, ipcRenderer.send(IPC.gamesSet, save)
  // src/main/ipc-guards.ts
  export const isGamesSave = (v: unknown): v is GamesSave => parseGamesSave(v).bad.length === 0
  ```
- Main: `const games = new GamesStore(dataDir, (m) => log.warn(m))`; `ipcMain.handle(IPC.gamesGet, (): GamesSave => games.get())`; `ipcMain.on(IPC.gamesSet, (_e, v: unknown) => { if (isGamesSave(v)) games.set(parseGamesSave(v).save) })`.
- Load: a missing file is `EMPTY_GAMES` with no message; unreadable or not JSON → `EMPTY_GAMES` and one `onError`; parsed with bad parts → the good parts, and one `onError` naming the bad parts.

- [ ] **Step 1: Write the failing tests.** `tests/integration/games-store.int.test.ts` (style of `tests/integration/starred-sessions.int.test.ts`, folders from `mkdtempSync(join(tmpdir(), 'ct-games-'))`):
  - `'a missing file is an empty save and no error'`.
  - `'a save comes back in the next run, written through a temp file that is gone again'` — `set` then `new GamesStore(d).get()` equal; `readdirSync(d)` is `['games.json']`.
  - `'a corrupt file is an empty save, reported once, and replaced by the next save'`.
  - `'a bad part is dropped and reported; the other parts load'` — file with a bad `clicker` and a good `merge` → `merge` kept, `clicker` null, one error mentioning `clicker`.
  
  In `tests/unit/ipc-guards.test.ts` add `'isGamesSave takes a valid save and refuses a bad part or garbage'`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/games-store.int.test.ts tests/unit/ipc-guards.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the store, the guard, the IPC names, the `CtApi` methods (with one-line doc comments like their neighbours), the preload lines and the main wiring.
- [ ] **Step 4: Run** the same command — expect PASS; then `npm run typecheck` — expect no errors.

### Task 3: Merge rules

**Files:**
- Create: `src/renderer/games/merge-rules.ts`
- Test: `tests/unit/merge-rules.test.ts`

**Interfaces:**
- Consumes: `MergeSave` (Task 1).
- Produces:
  ```ts
  export type Dir = 'left' | 'right' | 'up' | 'down'
  export const SIZE = 4
  /** the exponent of a 1 MB tile */
  export const GOAL = 11
  export function tileKB(e: number): number            // 2 ** (e - 1)
  export function tileLabel(e: number): string          // 1 → '1 KB', 10 → '512 KB', 11 → '1 MB', 12 → '2 MB', 21 → '1 GB'
  export function newMerge(rand: () => number, best?: number): MergeSave // empty board + two spawns, score 0, won false, best kept
  export function slide(board: number[], dir: Dir): { board: number[]; gained: number; moved: boolean } // no spawn; gained in KB
  export function spawn(board: number[], rand: () => number): number[] // first rand() picks the empty cell (floor(r * empties)), second: 2 if < 0.1 else 1
  export function move(s: MergeSave, dir: Dir, rand: () => number): { save: MergeSave; moved: boolean; reachedGoal: boolean }
  export function canMove(board: number[]): boolean
  ```
- Rules: tiles slide toward `dir`; the pair nearest the wall merges first; a tile merges at most once per move. `move` spawns only when the board moved; `score += gained`; `best = max(best, score)`; `reachedGoal` is true only on the move that first makes a tile ≥ `GOAL` while `won` was false, and sets `won`.

- [ ] **Step 1: Write the failing tests** (`r(...)` builds a `rand` from a list of numbers):
  - `'slides and merges a row to the left'` — rows `[1,1,1,1]→[2,2,0,0]` gained 4; `[1,1,2,0]→[2,2,0,0]` gained 2; `[2,1,1,0]→[2,2,0,0]` gained 2; `[1,0,0,1]→[2,0,0,0]` gained 2.
  - `'right, up and down mirror left'` — `[1,1,1,0]` right → `[0,0,1,2]`; a column `[1,1,0,0]` up → `[2,0,0,0]`, down → `[0,0,0,2]`.
  - `'a move that changes nothing does not spawn'` — `move` on `[1,0,…]` left: `moved` false, board unchanged.
  - `'a move spawns one tile in an empty cell'` — with `r(0, 0.5)` the first empty cell gets 1; with `r(0, 0.05)` it gets 2.
  - `'score and best grow with the merges'`.
  - `'the first 1 MB tile reaches the goal once'` — two 10s merge → `reachedGoal` true, `won` true; another pair of 10s later → `reachedGoal` false.
  - `'no move is left on a full board without equal neighbours'` — `canMove` false; one equal pair → true.
  - `'labels'` — `tileLabel` values as in Interfaces.
- [ ] **Step 2: Run** `npx vitest run tests/unit/merge-rules.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `merge-rules.ts`.
- [ ] **Step 4: Run** the same — expect PASS.

### Task 4: Runner rules and the Clawd sprite

**Files:**
- Create: `src/renderer/games/runner-rules.ts`, `src/renderer/games/clawd.ts`
- Test: `tests/unit/runner-rules.test.ts`

**Interfaces:**
- Produces (`clawd.ts`):
  ```ts
  /** Clawd from Claude Code's welcome screen: 18 × 5 pixels, each twice as tall as wide; '#' is filled */
  export const CLAWD: readonly string[] = [
    '...############...',
    '...##.######.##...',
    '.################.',
    '...############...',
    '....#.#....#.#....'
  ]
  /** the second running frame: the legs one pixel to the left */
  export const CLAWD_STEP: readonly string[]  // rows 0–3 as CLAWD, row 4 '...#.#....#.#.....'
  /** ducking: the top row dropped */
  export const CLAWD_DUCK: readonly string[]  // CLAWD rows 1–4
  /** paints rows at (x, y) top-left, `unit` px wide and 2 × unit tall per pixel */
  export function paintSprite(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number, unit: number, color: string): void
  ```
- Produces (`runner-rules.ts`), units are field pixels, y measured up from the ground:
  ```ts
  export const RUNNER = { width: 300, clawdX: 24, clawdW: 36, clawdH: 20, duckH: 16, gravity: 2000, jumpSpeed: 640,
    startSpeed: 200, maxSpeed: 480, speedPerPoint: 0.5, maxDt: 0.05, flyersFrom: 100 } as const
  export type ObstacleKind = 'bracket' | 'braces' | 'bug' | 'null'
  export const OBSTACLES: Record<ObstacleKind, { w: number; h: number; y: number }> =
    { bracket: { w: 14, h: 24, y: 0 }, braces: { w: 28, h: 24, y: 0 }, bug: { w: 14, h: 10, y: 0 }, null: { w: 30, h: 12, y: 17 } }
  export interface Obstacle { kind: ObstacleKind; x: number }
  export type RunnerPhase = 'ready' | 'running' | 'over'
  export interface RunnerState { phase: RunnerPhase; y: number; vy: number; ducking: boolean; distance: number; score: number; speed: number; obstacles: Obstacle[]; frame: number }
  /** jump: pressed this frame (edge); duck: held */
  export interface RunnerInput { jump: boolean; duck: boolean }
  export function newRun(): RunnerState                 // 'ready', y 0, speed startSpeed, no obstacles
  export function start(s: RunnerState): RunnerState    // from 'ready' or 'over': a fresh 'running' state
  export function step(s: RunnerState, input: RunnerInput, dt: number, rand: () => number): RunnerState
  export function hitBox(s: RunnerState): { x: number; y: number; w: number; h: number }
  ```
- `step` (only in 'running'; returns `s` unchanged otherwise): clamp `dt` to `maxDt`; a jump starts only on the ground (`vy = jumpSpeed`); ducking only on the ground; move obstacles left by `speed * dt`, drop those with `x + w < 0`; `distance += speed * dt`; `score = Math.floor(distance / 10)`; `speed = Math.min(maxSpeed, startSpeed + speedPerPoint * score)`; spawn a new obstacle at `x = width` when there is none or the last one's `x < width - gap`, `gap = speed * (0.8 + 0.8 * rand())`; kind from `rand()`: `'null'` only when `score >= flyersFrom` and `r < 0.25`, else bracket / braces / bug in equal thirds; overlap of `hitBox` with an obstacle box → phase `'over'`. `frame` counts steps for the leg animation.

- [ ] **Step 1: Write the failing tests:**
  - `'a run waits until it is started'` — `step(newRun(), …)` returns the same state; `start` makes it 'running'.
  - `'a jump lands after 2 × jumpSpeed / gravity seconds'` — step with `jump` once, then 0.01 s steps without; y > 0 throughout and back to 0 within 0.64 ± 0.02 s.
  - `'no second jump in the air'` — a jump pressed mid-air does not change `vy` upward.
  - `'a ground obstacle ends a run that does not jump, and not one that jumps in time'` — a bracket placed just right of Clawd.
  - `'ducking clears a flyer; standing hits it'` — a `'null'` obstacle approaching.
  - `'score is a tenth of the distance and speed grows to its cap'` — after long running (no obstacles: `rand` returning values that keep gaps huge, or remove obstacles between steps), `speed` ≤ `maxSpeed` and equals the formula.
  - `'dt is clamped'` — one step with `dt = 5` moves the distance by `speed * 0.05`.
  - `'no flyers before the score reaches flyersFrom'` — with `rand` always 0, spawned kinds below 100 points are never `'null'`.
  - `'Clawd is 18 by 5 pixels'` — every row of `CLAWD`, `CLAWD_STEP` has length 18, five rows; `CLAWD_DUCK` has four.
- [ ] **Step 2: Run** `npx vitest run tests/unit/runner-rules.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** both modules (`paintSprite` uses `ctx.fillRect` per filled pixel).
- [ ] **Step 4: Run** the same — expect PASS.

### Task 5: Clicker rules

**Files:**
- Create: `src/renderer/games/clicker-rules.ts`
- Test: `tests/unit/clicker-rules.test.ts`

**Interfaces:**
- Consumes: `ClickerSave` (Task 1).
- Produces:
  ```ts
  export const HELPERS = [
    { name: 'Intern', cost: 15, rate: 1 },
    { name: 'Agent', cost: 100, rate: 8 },
    { name: 'Server', cost: 1100, rate: 47 },
    { name: 'Data center', cost: 12000, rate: 260 }
  ] as const
  export const PRICE_GROWTH = 1.15
  export const AWAY_CAP_MS = 8 * 60 * 60 * 1000
  /** an absence shorter than this gets no "while you were away" line */
  export const AWAY_NOTE_MS = 60_000
  export function newClicker(now: number): ClickerSave            // lines 0, helpers [0,0,0,0], at now
  export function rate(s: ClickerSave): number                    // lines per second
  export function price(s: ClickerSave, helper: number): number   // Math.ceil(cost * PRICE_GROWTH ** owned)
  export function click(s: ClickerSave): ClickerSave              // lines + 1
  export function buy(s: ClickerSave, helper: number): ClickerSave | null // null when lines < price
  /** brings lines up to `now`: away = max(0, now - at); earned = rate × min(away, AWAY_CAP_MS) / 1000; at = now */
  export function catchUp(s: ClickerSave, now: number): { save: ClickerSave; earned: number; away: number }
  export function shortNumber(n: number): string                  // floor first: 999 → '999', 1000 → '1K', 12400 → '12.4K', 12449 → '12.4K', 3_100_000 → '3.1M', 2.5e9 → '2.5B'
  ```

- [ ] **Step 1: Write the failing tests:**
  - `'a click writes a line'`.
  - `'prices grow by 15% per helper owned'` — Intern: 15, then 18, then 20.
  - `'buying spends the price and raises the rate; too poor is null'` — 15 lines buy an Intern → lines 0, `rate` 1; 14 lines → `null`.
  - `'catching up adds what the helpers wrote'` — helpers `[2,1,0,0]` (rate 10), 30 s later → earned 300, `at` = now.
  - `'an absence counts for at most 8 hours'` — 10 h later → earned 288000.
  - `'a clock that went back earns nothing and loses nothing'` — `now < at` → earned 0, lines unchanged, `at` = now.
  - `'short numbers'` — the values in Interfaces.
- [ ] **Step 2: Run** `npx vitest run tests/unit/clicker-rules.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `clicker-rules.ts`.
- [ ] **Step 4: Run** the same — expect PASS.

### Task 6: The game window with Merge, the toggle and the shortcut

**Files:**
- Create: `src/renderer/games/game-view.ts`, `src/renderer/games/games-window.ts`, `src/renderer/games/merge-view.ts`, `src/renderer/games/games.css` (imported from `games-window.ts` as `chat-view.ts` imports `./chat.css`)
- Modify: `src/renderer/keymap.ts`, `src/renderer/icons.ts`, `src/renderer/sheet-header.ts` (toggle after Note ~:98–99, `setGames`), `src/renderer/tabbar.ts` (`TabBarCallbacks` ~:63), `src/renderer/styles.css` (add `.tab-games-toggle` to every toggle selector list: ~:70, :71, :145–146, :148), `src/renderer/index.html` (`#terminals` gets `<div id="games"></div>` after `#search`), `src/renderer/main.ts` (see below), `tests/e2e/helpers.ts` (`KEYS.games`, `KEY_LABELS.games`), `tests/unit/keymap.test.ts`
- Test: `tests/e2e/games.spec.ts` (new)

**Interfaces:**
- Consumes: Tasks 1–3 (`GamesSave`, `getGames`/`saveGames`, merge rules).
- Produces:
  ```ts
  // game-view.ts
  export interface GameView {
    readonly id: GameId
    readonly title: string            // 'Runner' | 'Merge' | 'Clicker'
    readonly el: HTMLElement
    readonly pausable: boolean        // false for Clicker
    /** a key while the game has the keyboard (repeats already dropped); true when it is one of the game's keys */
    key(code: string, down: boolean): boolean
    /** shown: the window is open, unfolded and shows this game; live: shown, not paused, the game has the keyboard and the app is focused */
    setState(shown: boolean, live: boolean): void
    /** writes its part into the save */
    saveInto(save: GamesSave): void
    /** its line in the game menu: 'best 3,311' or '12.4K lines' */
    menuNote(): string
  }
  // games-window.ts
  export type GamesWindowState = 'closed' | 'open' | 'folded'
  export interface GamesWindowCallbacks {
    load(): Promise<GamesSave>
    save(save: GamesSave): void
    /** the keyboard goes back to the tab in front */
    focusTab(): void
    /** opened, folded or closed: the sheet header's Games toggle follows */
    changed(): void
  }
  export class GamesWindow {
    constructor(root: HTMLElement, cb: GamesWindowCallbacks, platform: string)
    /** loads the save; until it has, toggle() does nothing */
    init(): Promise<void>
    state(): GamesWindowState
    /** closed → open (the game takes the keyboard); open or folded → closed */
    toggle(): void
    /** lifts the window above the chat composer of the tab in front, if one is shown (Task 7 fills it in; here a no-op) */
    place(): void
  }
  // merge-view.ts
  export class MergeView implements GameView { constructor(save: MergeSave | null, changed: () => void, rand?: () => number) }
  // keymap.ts
  { type: 'toggleGames' }   // KeyAction; LABELS.toggleGames = ['Ctrl+Shift+G', '⌘G']; Ctrl+Shift+KeyG in mapKey, Meta+KeyG in mapMacKey
  // icons.ts
  'gamepad'                 // added to ICON_NAMES and SHAPES: Lucide gamepad-2
  // sheet-header.ts
  setGames(open: boolean): void   // classList 'active'; the toggle is always shown
  // tabbar.ts TabBarCallbacks
  toggleGames(): void       // also picked into SheetHeaderCallbacks
  ```
- The Lucide gamepad-2 shape for `SHAPES.gamepad`: `<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>`
- The toggle: `this.toggle('tab-games-toggle', '', \`Games (${shortcutLabel('toggleGames', platform)})\`, icon('gamepad', 16), () => cb.toggleGames(), false)`, appended after `this.note`.
- DOM and attributes the tests use: `#games .games-window` with `data-game` (GameId), `data-keyboard` (`'game'` | `'tab'`), `data-paused` (`'true'` | `'false'`), `tabIndex = 0`; header `.games-name` (title + ▾, opens `.games-menu` with `.games-menu-item[data-game]`, each showing `menuNote()`), `.games-pause` (⏸, ▶ while paused, `disabled` when the view is not pausable), `.games-fold` (–), `.games-close` (✕); `.games-paused` overlay "Paused · ▶ or Space to resume"; `.games-tip` "Click to play" while `data-keyboard="tab"`; `#games .games-pill` (gamepad icon, title, "paused", ▴). Merge: `.merge-board` with `data-cells` = the 16 exponents joined by `,`, `.merge-score` ("score 1,240"), `.merge-best` ("best 3,311"), `.merge-new` ("New game"), a "1 MB!" note with "Keep going", a "No moves" note. Numbers with `toLocaleString('en-US')`.
- `GamesWindow` behaviour (spec, "The window"):
  - The window holds the views it is given, in the order Runner, Merge, Clicker (this task has only Merge; Tasks 8 and 9 add theirs); a `save.game` without a view shows the first view there is.
  - `toggle()` from closed shows the window for `save.game`, focuses `.games-window`; from open/folded hides all, saves at once, and pauses a pausable game. Closing leaves focus to main (below).
  - Keyboard: `focusin` → `data-keyboard="game"`; `focusout` to outside the window → `'tab'` and, for Runner, paused. `window` `blur` → Runner paused. `keydown`/`keyup` on `.games-window`: `e.repeat` → `preventDefault` and stop; `Escape` → `cb.focusTab()`; `mapKey(e, platform) !== null` → return untouched (the document handler in main.ts runs app shortcuts); paused + `Space` → resume; else `view.key(e.code, down)`; every key not returned above gets `preventDefault()` (dropped, never reaches the tab).
  - Fold → pill, pause, save now; a click on the pill unfolds and focuses the window, still paused. Switching game in the menu: pause the current one, save now, `save.game` = the new one.
  - Saving: `changed()` from a view schedules `cb.save` after 2000 ms (one pending at a time); fold, close, switch and `window` `beforeunload` save at once.
  - Merge view: arrows move (`move` from Task 3) when not paused; `.merge-new` starts over keeping `best`.
- main.ts (`origin/master`):
  - `let gamesWindow: GamesWindow`; built after `noteOverlay` with `load: () => ct.getGames()`, `save: (s) => ct.saveGames(s)`, `focusTab: () => { if (activeId) focusTab(activeId) }`, `changed: () => refreshPanelButtons()`; then `void gamesWindow.init()`.
  - `runAction` gets `case 'toggleGames': gamesWindow.toggle(); if (gamesWindow.state() === 'closed' && activeId) focusTab(activeId); break`.
  - `tabCallbacks.toggleGames = () => runAction({ type: 'toggleGames' }, activeId)` — no `focusTab` after it.
  - `refreshPanelButtons()` adds `sheetHeader.setGames(gamesWindow.state() !== 'closed')` and `gamesWindow.place()` (guard for `gamesWindow` not built yet, as the function guards `imagePanel`).
  - The window `focus` handler's exception becomes `closest('#image-panel, #note, #games')`.

- [ ] **Step 1: Write the failing unit tests** in `tests/unit/keymap.test.ts`: `'Ctrl+Shift+G and ⌘G toggle the games'` (mapKey on win32/linux and darwin) and `shortcutLabel('toggleGames', …)` → `'Ctrl+Shift+G'` / `'⌘G'`.
- [ ] **Step 2: Write the failing e2e tests** in `tests/e2e/games.spec.ts` with `launchApp()` (a shell tab; `__ct.ptyInput()` shows what reached it):
  - `'the Games toggle and the shortcut open and close the game window'` — toggle `#sheet-header .tab-games-toggle` has title `Games (${KEY_LABELS.games})`, not active; click → `.games-window` visible and focused, toggle active; `KEYS.games` → hidden, toggle not active, the terminal input focused; `KEYS.games` again → visible.
  - `'Merge takes the arrows and drops other keys; nothing reaches the tab'` — open, pick Merge in the menu; note `ptyInput`; press the four arrows and `x`, `Enter`; `data-cells` changed after at least one arrow (poll); `ptyInput` unchanged.
  - `'a click in the terminal takes the keyboard back, a click in the window gives it to the game, Esc gives it back'` — `data-keyboard` `'tab'` / `'game'` / `'tab'`, `.games-tip` visible while `'tab'`; typed text after the terminal click shows in `ptyInput`.
  - `'auto-repeated keys are dropped'` — with Merge focused, dispatch on `.games-window` a `new KeyboardEvent('keydown', { code, key: code, repeat: true, bubbles: true })` for each of the four arrows (via `page.evaluate`); `data-cells` unchanged.
  - `'app shortcuts work while the game has the keyboard, and a tab switch gives the keyboard to the new tab'` — with the game focused press `KEYS.newTab` → two tabs, the new one in front, `data-keyboard="tab"`; the window still visible.
  - `'pause, fold and close keep the game'` — `.games-pause` → `data-paused="true"`, `.games-paused` visible, arrows do not change `data-cells`; Space resumes; `.games-fold` → window hidden, `.games-pill` visible with text containing `Merge` and `paused`; click the pill → window visible, focused, `data-paused="true"`; `.games-close` → hidden; toggle → same `data-cells`.
- [ ] **Step 3: Run** `npx vitest run tests/unit/keymap.test.ts` and `npm run test:e2e -- games.spec.ts` — expect FAIL.
- [ ] **Step 4: Implement** everything in Files and Interfaces.
- [ ] **Step 5: Run** the same commands — expect PASS; `npm run typecheck` — no errors; `npm test` — all pass.

### Task 7: Placement and keeping the games across restarts

**Files:**
- Modify: `src/renderer/games/games-window.ts` (`place()`), `src/renderer/games/games.css`, and only if the chat reply test fails: the chat code that takes the focus (find it in `src/renderer/chat/`), changed so it never takes the keyboard from `#games`
- Test: `tests/e2e/games.spec.ts` (add)

**Interfaces:**
- Consumes: Task 6.
- CSS: `#games { position: absolute; right: calc(14px + var(--panel-cover, 0px)); bottom: calc(10px + var(--games-lift, 0px)); z-index: 5; }`.
- `place()`: finds the shown composer (`.chat-composer` whose `offsetParent !== null` inside `#terminals`), sets `--games-lift` on the root to its `offsetHeight` px (0 when none), and keeps one `ResizeObserver` on that composer (re-attached when it changes) so the window follows the composer's growth.

- [ ] **Step 1: Write the failing e2e tests:**
  - `'the window stays left of the side panel'` — open Media (`KEYS.images`), then the games; `.games-window` box right ≤ `#image-panel` box left.
  - `'in a chat tab the window sits above the composer'` — `launchChatTab` (tests/e2e/chat-helpers.ts) with a script as other chat specs use; open the games; `.games-window` box bottom ≤ the box top of `.chat-host:visible .chat-composer`.
  - `'a reply in the chat leaves the keyboard with the game'` — same app: send a prompt from `CHAT_INPUT` that the script answers, click the game window, wait for the reply to show in the chat; `data-keyboard` still `'game'` and `CHAT_INPUT` is not focused.
  - `'games and the last game chosen survive a restart; the window starts closed'` — `makeDataDir()`, `launchApp({ dataDir })`, open, pick Merge, press arrows until `data-cells` changes, read it, close the window (✕), close the app's window and wait for the app to close (as `closeWindow` in `tests/e2e/note-overlay.spec.ts` does); `launchApp({ dataDir })` again: `.games-window` hidden; `KEYS.games` → `data-game="merge"`, same `data-cells`.
- [ ] **Step 2: Run** `npm run test:e2e -- games.spec.ts` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** `place()` and the CSS (and the chat focus fix if needed).
- [ ] **Step 4: Run** `npm run test:e2e -- games.spec.ts` — expect PASS.

### Task 8: Runner view

**Files:**
- Create: `src/renderer/games/runner-view.ts`
- Modify: `src/renderer/games/games-window.ts` (register the view), `src/renderer/games/games.css`
- Test: `tests/e2e/games.spec.ts` (add)

**Interfaces:**
- Consumes: `GameView` (Task 6), runner rules and `paintSprite`/`CLAWD*` (Task 4).
- Produces: `export class RunnerView implements GameView { constructor(best: number, changed: () => void, rand?: () => number) }` — `pausable: true`, `saveInto` writes `runnerBest`, `menuNote()` → `best ${n}`.
- DOM: `.runner` with `data-phase` (`RunnerPhase`), `.runner-score` ("score 1,240"), `.runner-best` ("best 3,311"), a `<canvas>` 300 × 190 CSS px scaled by `devicePixelRatio`, a hint line "Space/↑ jump · ↓ duck"; on the canvas: ground line, Clawd in `--accent` (unit 2 → 36 × 20 px; `CLAWD`/`CLAWD_STEP` alternating every 6 frames; `CLAWD_DUCK` while ducking), brackets and braces as monospace glyphs `}`/`{ }`, the bug as a small red pixel sprite, `null` as a small amber label. 'ready' shows "Space to start", 'over' shows "Game over · Space to run again".
- Keys: `Space`/`ArrowUp` down → in 'ready'/'over' `start()`, in 'running' a jump on the next step; `ArrowDown` down/up → duck held/released. Other codes → false.
- Loop: `requestAnimationFrame` only while `live` and phase 'running'; `dt` from the frame timestamps; stops on `setState(_, false)`. A new best calls `changed()`.

- [ ] **Step 1: Write the failing e2e test** `'Runner starts with Space and pauses itself when the tab takes the keyboard'` — fresh data dir: opening shows Runner (`data-game="runner"`), `.runner[data-phase="ready"]`; Space → `'running'`; click in the terminal → `data-keyboard="tab"`, `data-paused="true"`; click the window → `data-keyboard="game"`, still paused; Space → `data-paused="false"`.
- [ ] **Step 2: Run** `npm run test:e2e -- games.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** the view and register it.
- [ ] **Step 4: Run** the same — expect PASS.

### Task 9: Clicker view and the README

**Files:**
- Create: `src/renderer/games/clicker-view.ts`
- Modify: `src/renderer/games/games-window.ts` (register the view), `src/renderer/games/games.css`, `README.md` (Features list and Keyboard shortcuts table)
- Test: `tests/e2e/games.spec.ts` (add)

**Interfaces:**
- Consumes: `GameView` (Task 6), clicker rules (Task 5), `paintSprite`/`CLAWD` (Task 4).
- Produces: `export class ClickerView implements GameView { constructor(save: ClickerSave | null, changed: () => void, now?: () => number) }` — `pausable: false`; `menuNote()` → `${shortNumber(lines)} lines`.
- DOM: `.clicker-count` (`shortNumber(lines)`), `.clicker-rate` (`+${shortNumber(rate)} per second`), `.clicker-clawd` (a button with Clawd painted on a small canvas; a click → `click`, a short "+1" float), `.clicker-buy[data-helper="0..3"]` rows with the helper's name, how many are owned and the price, `disabled` while unaffordable; `.clicker-away` ("+7.2K lines while you were away", hidden otherwise).
- Time: on `setState(true, …)` → `catchUp(now())`; if `away >= AWAY_NOTE_MS` and `earned > 0`, show `.clicker-away` until the next click or purchase. While shown, a 250 ms interval runs `catchUp` and redraws; on `setState(false, …)` the interval stops (no timer while hidden). `saveInto` catches up first, so `at` is current.

- [ ] **Step 1: Write the failing e2e tests:**
  - `'a click on Clawd writes a line; an Intern costs 15 and then writes lines by itself'` — pick Clicker; `.games-pause` disabled; 15 clicks on `.clicker-clawd` → `.clicker-count` "15"; `.clicker-buy[data-helper="0"]` enabled, click → count "0", `.clicker-rate` "+1 per second"; count reaches "1" or more within 3 s.
  - `'lines written while the app was closed are counted, at most 8 hours'` — before launching, write `games.json` into `makeDataDir()` with `{ game: 'clicker', runnerBest: 0, merge: null, clicker: { lines: 0, helpers: [1,0,0,0], at: Date.now() - 2 * 3600_000 } }`; open the games → `.clicker-away` contains `+7.2K lines while you were away`.
- [ ] **Step 2: Run** `npm run test:e2e -- games.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** the view, register it, and add to README: a Features bullet — "**Mini-games** — a small window in the corner of the tab with three games for the wait while Claude works: Runner, Merge and Clicker. The gamepad button in the tab's header or `Ctrl+Shift+G` (`⌘G` on macOS) opens it; pause, fold or close it at any time, and the games and records are kept." — and a row for `Ctrl+Shift+G` / `⌘G` "Mini-games" in the Keyboard shortcuts table, in its format.
- [ ] **Step 4: Run** `npm run test:e2e -- games.spec.ts` — expect PASS.
- [ ] **Step 5: Full check** — `npm run typecheck`, `npm test`, `npm run test:e2e` — all pass. Leave everything uncommitted and report the list of changed files.
