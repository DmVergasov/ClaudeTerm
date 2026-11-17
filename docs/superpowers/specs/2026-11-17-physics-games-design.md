# Physics games: Lander, Pinball and Sand — design

## Intent

The person enjoys the mini-games window (`2026-11-16-mini-games-design.md`) and asked for more games, "something
physical", then left the choice to the coordinator, who picked **Lander** and **Pinball**. They then added a third: a
falling-sand block puzzle ("как вариант можно сделать песочный тетрис"), shown with a screenshot of an indie sand-block
game. All three join Runner, Merge and Clicker in the same window, under the same rules: our own takes on the genres,
the app's own look, no loop while nobody plays, and the game's keys never reach the tab.

## Goals

- **Lander:** fly Clawd's craft down to a flat pad on seeded, generated terrain, with gravity, inertia and fuel.
- **Pinball:** a small vertical table with two flippers, bug bumpers, bracket targets and a plunger; 3 balls a game.
- **Sand:** pieces fall as solids, land and break into sand that pours; a one-colour band from wall to wall clears.
- Each keeps its best score in `games.json`; the game menu lists all six games with their notes.
- An existing `games.json` without the new fields loads with nothing bad and no warning.

## Non-goals

- No change to the window itself (place, keys, fold, close, keyboard hand-over), to Runner, Merge or Clicker, beyond
  what the new games need (a game that runs in time pauses when the keyboard leaves it).
- No run in progress is saved: a Lander run, a Pinball game and a Sand game start over after a restart, as Runner does.
- No sound, no online scores, no new dependencies, no physics engine.

## Anti-goals (a failure even if it works)

- A copy of an existing game: the names, the look, the levels and the table layout are ours. Sand is not called
  Tetris or Sandtrix, uses no classic tetromino (no 4-cell piece at all) and no 10 × 20 well.
- A ball that tunnels through a flipper or a wall, or a craft that sinks through the ground.
- An animation loop while a game is not live (folded, closed, paused, no keyboard, app in the background).
- A grid so big that a tick costs more than a few thousand cells.

## Constraints

- AGENTS.md: plain TypeScript in the renderer, English strings, tests on every level where a behavior lives, the IPC
  guard checks the save, validated saves, no new dependencies, keep line endings (the games files are LF).
- Built on `origin/master` as of 2026-11-17 (0.23.0 not yet released).
- The window is 300 px wide (276 px inside its padding) and should stay about 300–350 px tall.

## Approaches

1. **Same split as Runner — chosen.** Each game is a pure rules module (`*-rules.ts`: state, `step(state, input, dt)`,
   a seeded random kept in the state, no DOM) and a canvas view behind `GameView` (`*-view.ts`). The rules run fixed
   steps with an accumulator kept in the state, so a frame of any length advances the same way and tests drive the
   rules directly. Matches the existing games and AGENTS.md.
2. **A small shared physics module** (bodies, shapes, a solver) used by Lander and Pinball. Lander needs only a point
   craft against a height field, Pinball a circle against segments and circles; a general module would be more code than
   both and harder to test. Rejected.
3. **DOM instead of canvas** for Sand (a grid of divs). Thousands of grains as elements is slow and heavy. Rejected.

## Shared

- **Seeded random.** `random.ts`: a 32-bit generator (mulberry32). The state holds `seed`; `step` draws from it and
  stores the next seed, so the same state and inputs give the same result. A new run's seed comes from `Math.random`.
- **Fixed timestep.** `step(state, input, dt)` clamps `dt` to 0.1 s, adds it to `state.acc` and runs fixed steps while
  `acc >= STEP`. Edge inputs (a press since the last frame) are used by the first fixed step only.
- **Loop.** As in Runner: `requestAnimationFrame` only while the view is live and the game is in play; the first frame
  of a loop only sets the clock.
- **Pause.** Pausable during a run (`canPause()` is true only then), like Runner. The window's `pauseOnLeave` now pauses
  every game that runs in time (`GameView.realtime`: Runner, Lander, Pinball, Sand), not only Runner.
- **State for tests.** Each view puts its state on its element as data attributes (`data-phase`, the HUD numbers, the
  piece's place, the ball's place), so e2e reads them, not the canvas.
- **Menu.** The menu lists Runner, Merge, Clicker, Lander, Pinball, Sand, each with `best N` (Clicker: its lines).

## Lander

```
┌ Lander ▾ ──────────── ⏸ – ✕ ┐
│ score 340          best 900  │
│      .        ╭─╮       .    │
│   .           │▟▙│           │
│              /    \          │
│      /\       ▼▼           . │
│  ___/  \__   [====]   /\__   │
│ → 3  ↓ 12  ∠ 4°  fuel 82  L2 │
│   ↑/Space thrust · ←/→ turn  │
└──────────────────────────────┘
```

- **World:** 300 × 200 field px, y down. The craft is a small capsule with Clawd (`clawd.ts`, unit 1) as the pilot,
  two legs with feet, and a flickering flame (amber and accent) under it while it thrusts.
- **Terrain:** a polyline across the field with points about every 15 px, from a seeded random walk; one flat pad,
  drawn in green between `[` and `]`. The rest is a filled ridge in the chrome grays.
- **Keys:** ↑ or Space thrusts along the craft's axis; ← and → rotate it. Space or ↑ starts a run; after a crash,
  Space starts a new one.
- **Physics:** gravity, thrust along the axis, inertia; thrust burns fuel; with no fuel there is no thrust. The sides of
  the field stop the craft; above the top it flies on, unseen.
- **Touchdown:** the first contact with the ground decides. A **landing** needs both feet over the pad, |vy|, |vx| and
  |angle| within their limits; anything else that touches the ground (a foot off the pad, the hull, too fast, tilted) is
  a **crash**. The limits are inclusive.
- **Score:** a landing gives `100 × level + 2 × fuel left`. After 1.5 s the next level starts: a narrower pad, rougher
  terrain, less fuel, and from level 3 a wind that pushes sideways. A crash ends the run; the best score is kept.
- **HUD** (DOM): horizontal and vertical speed, angle, fuel and level; a value outside its landing limit is red.

## Pinball

```
┌ Pinball ▾ ─────────── ⏸ – ✕ ┐
│ ╭──────────────────╮ score   │
│ │    ( >_ )      │ │   1 250 │
│ │  (🐞)   (🐞)    │ │ best    │
│ │{     (🐞)     }│ │   4 800 │
│ │                │ │ balls   │
│ │ \            / │o│   ● ● ○ │
│ │  \_       _/   │▒│ power   │
│ ╰─────    ───────╯ │   ▮▮▮▯  │
│ ←/→ flippers · Space launch  │
└──────────────────────────────┘
```

- **Table:** 190 × 250 field px, y down, on the left of the window; the score, best, balls and plunger power in a
  column on the right (DOM).
- **Parts:** outer walls with a rounded top, a plunger lane on the right, two flippers, two slanted guides down to the
  flippers (each ends on top of its flipper's pivot, so a ball rolls on from the guide onto the flipper), three round
  bumpers with Runner's pixel bug, two bracket targets (`{` on the left, `}` on the right) and a top rollover lane marked
  `>_`.
- **Keys:** ← and → hold the left and right flipper up; Space is the plunger: hold to pull (the power fills in about a
  second), release to launch, harder the longer it was held. Space starts a game, and a new one after the last ball.
- **Physics:** a circle against segments and circles. Flippers are rotating capsules that give the ball their surface
  speed at the contact point. Fixed substeps small enough that the fastest ball (the speed cap) moves less than a
  quarter of its radius per substep, so it never tunnels through a flipper or a wall.
- **Score:** a bumper kick 100; a bracket target 250, and both lit 1 000 more (they reset); the top lane 500.
- **Balls:** 3 per game. A ball that falls out between the flippers is lost; the next waits on the plunger; the third
  lost ends the game. A ball that falls back into the plunger lane rests on the plunger and can be launched again.

## Sand

```
┌ Sand ▾ ────────────── ⏸ – ✕ ┐
│ ┌────────────────┐  next     │
│ │      ▓▓▓       │   ░░      │
│ │      ▓         │   ░░░     │
│ │                │  score    │
│ │                │    2 140  │
│ │░░        ▒▒▒   │  best     │
│ │░░░░▒▒▒▒▒▒▒▒▓▓▓▓│    6 020  │
│ │▓▓▓▓▓▓▓▒▒▒▒░░░░░│           │
│ └────────────────┘           │
│ ←/→ move · ↑ turn · ↓ · Space│
└──────────────────────────────┘
```

- **Board:** 14 × 20 cells, each cell 3 × 3 grains: a grid of 42 × 60 grains (2 520 cells a tick), each grain 4 px, so
  the board is 168 × 240 px and the widest piece spans at most a quarter of it. The next piece, the score and the best
  are in a column on the right. (First built as 8 × 12 cells of 5 × 5 grains; the person found the pieces too big.)
- **Pieces:** our own set of 3- and 5-cell shapes, none of 4 cells: dash (3 in a row), corner (3), plus (5),
  bracket (5, a `[`), tee (5) and step (5, a stair). One colour each, picked from four app colours.
- **Keys:** ←/→ move the piece a cell (holding repeats), ↑ turns it clockwise, ↓ drops it faster, Space drops it at
  once. Space starts a game, and a new one after it ends.
- **Falling piece:** a solid that moves by grains down and by cells sideways; a side move goes as far as it is free
  (up to a cell), a turn that would hit a wall or sand does not happen. When a grain of the piece has sand or the floor
  under it, it lands and breaks into its grains, each with a slight shade of its colour.
- **Sand:** a cellular automaton at a fixed tick: a grain falls if the grain under it is empty, else it slides down
  left or right (picked at random when both are free), else it rests.
- **Clear:** a connected region of one colour (8-connected) that touches both the left and the right wall clears at
  once, with a short flash. It scores the grains it removed times the chain: the first clear since the sand last came
  to rest counts once, the next twice, and so on.
- **Speed:** the fall speed rises with the score up to a cap.
- **Game over:** when the next piece has no room where it appears once the sand has come to rest: while the grains of
  a landed piece still pour, the next piece waits. The best score is kept.

## State and storage

- `GamesSave` gains `landerBest`, `pinballBest` and `sandBest`: safe integers from 0 to 10¹², like `runnerBest`.
  `GAME_IDS` gains `lander`, `pinball` and `sand`.
- `parseGamesSave`: a missing field is 0 and not bad (an older `games.json`); a field that is there and out of range or
  not an integer is 0 and named in `bad`.
- The IPC guard (`isGamesSave`) also requires the three fields to be present: the renderer always sends a whole save.

## Tests

- **Unit:**
  - Lander: gravity, thrust burns fuel and accelerates along the axis, no fuel no thrust, rotation and its limit, a safe
    landing at each limit and a crash just past it, a touch outside the pad or with the hull is a crash, level
    progression (pad, roughness, fuel, wind), the score.
  - Pinball: gravity, a wall bounce, a flipper sends a ball up, a bumper kicks and scores, a target and the both-lit
    bonus, the top lane, a drain loses a ball, the third drain ends the game, plunger strength grows with the hold and is
    capped, no tunneling through a wall or a moving flipper at the speed cap.
  - Sand: a grain falls, slides diagonally and rests; a landed piece becomes grains; a wall-to-wall one-colour region
    clears and scores; one broken by another colour does not; 8-connectivity (a diagonal-only path clears); a turn
    blocked by a wall or by sand; game over at the top; the chain.
  - Save: the new fields round-trip, a save without them has nothing bad, out-of-range values are bad, the guard needs
    them.
  - Views: each new view asks for a frame only while it is live and in play.
- **Integration:** the store round-trips the new fields; an old `games.json` without them loads with no error.
- **E2E** (`tests/e2e/games.spec.ts`): the three games are in the menu and can be picked; in Lander holding ↑ lowers
  the fuel and changes the speed and no key reaches the terminal; in Pinball Space launches the ball; in Sand ←/→ move
  the piece and no key reaches the terminal; pause stops all three, and so does a click in the terminal; the best scores
  survive a restart.

## Left to the builder

- The tuned numbers (gravity, thrust, limits, table layout, speeds); recorded in the rules modules.
- File and class names.

## My calls (not discussed with the person, open to change)

- Names: **Lander**, **Pinball**, **Sand**.
- The menu keeps Runner, Merge and Clicker first and adds the three new games after them.
- Every game that runs in time (Runner, Lander, Pinball, Sand) pauses itself when the keyboard leaves the window or the
  app loses focus, as Runner already did.
- Lander: y down in field px; the sides stop the craft, the top is open; the first ground contact decides; limits are
  inclusive; the next level starts by itself 1.5 s after a landing; wind from level 3.
- Lander levels: pad, roughness and fuel change per level down to a floor; the start is seeded.
- Pinball: a single drain between the flippers (no outlanes); a weak launch that falls back rests on the plunger again;
  the targets are `{` `}` and a `>_` top lane; the side column is DOM.
- Sand: 14 × 20 cells of 3 × 3 grains; 8-connectivity, because sand settles in 45° slopes and a one-grain diagonal band
  should count; a side move is one cell (as far as free), with hold-to-repeat in the rules since the window drops key
  repeats; no wall kicks; no lock delay; game over only when the next piece has no room once the sand has come to
  rest; chain = clears since the sand last rested.
- Sand colours: accent, blue, green and amber from `colors.css`.
- Sand: a piece that lands with part of it still above the board also ends the game (its grains would have nowhere to go).
- Lander: above the top of the field the craft is out of sight; a small `^` at the top edge shows where it is.
- Pinball: a plunger pull stopped by a pause, or by a click away, goes back to nothing; the resume does not launch.
- Pinball: a ball knocked under a guide in the drain can be drawn past the wall for a few frames before it counts as
  lost; left as it is (cosmetic, and the ball is already lost).
- The tuned numbers are listed at the top of each rules module, and below.

## Tuned numbers

Tuned with simulated play of the rules (an autopilot for Lander, random and scripted play for Pinball and Sand) and
checked by playing in the app.

- **Lander** (field px, y down): gravity 22 px/s², thrust 52 px/s² (2.4 × gravity), turning 120°/s up to ±90°, fuel
  burned 12 a second of thrust. A landing needs |vy| ≤ 16 px/s, |vx| ≤ 9 px/s and |angle| ≤ 10°. Feet 11 px either side
  and 11 px below the centre, hull radius 9 px. Level n: pad 64 − 6(n − 1) px (at least 30), roughness 22 + 8(n − 1) px
  a point (at most 60), fuel 100 − 6(n − 1) (at least 50), wind from level 3 up to 2(n − 2) px/s² (at most 8). A landing
  scores 100 × level + 2 × fuel left; the next level starts 1.5 s later. The start drifts up to 25 px/s sideways.
  Fixed step 1/120 s.
- **Pinball** (table 190 × 250 px): gravity 420 px/s², ball radius 5 px, speed cap 900 px/s, 8 substeps of 1/960 s (under
  a quarter of the ball's radius per substep at the cap). Bounce: walls 0.5, flippers 0.2, bumpers 0.5 plus a 240 px/s
  kick. Flippers 34 px long, up at 24 rad/s and down at 14 rad/s, from 28° below to 26° above level. The plunger fills in
  0.9 s and launches at 260–860 px/s; a launch under about 370 px/s falls back onto the plunger. Points: bumper 100,
  target 250, both targets 1 000 more, `>_` lane 500.
- **Sand**: 14 × 20 cells of 3 × 3 grains (42 × 60 grains, 4 px each), sand tick 1/60 s. The piece falls 10 grains/s plus
  one for every 200 points, at most 40; ↓ makes it 60. A held ←/→ repeats after 0.16 s, then every 0.055 s. A clear
  flashes for 0.25 s. 8-connected regions; a clear scores grains × its place in the chain.
