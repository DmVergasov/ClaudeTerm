# Artillery: a turn-based battle with destructible ground — design

## Intent

The person enjoys the mini-games window (`2026-11-16-mini-games-design.md`, `2026-11-17-physics-games-design.md`) and
asked for a game in the spirit of Worms: a turn-based artillery battle. What makes it that kind of game for them, in
their words: **destructible surroundings and a set of different weapons**. It joins Runner, Merge, Clicker, Lander,
Pinball and Sand in the same window, under the same rules: our own take on the genre, the app's own look, no loop while
nobody plays, and the game's keys never reach the tab.

It is played by one person while Claude works, so the opponent is a bot, and a battle can be left in the middle of a
turn and picked up later.

## Goals

- **Artillery:** the person's team of three Clawds against three bugs played by a bot, one fighter a turn, on a
  generated map with destructible ground, water below, wind, and eight weapons.
- The map is three windows wide; the camera follows the fighter whose turn it is and the shot in flight; a minimap strip
  shows the whole map.
- The window keeps the person's wins, current win streak and best streak in `games.json`; the game menu shows
  `wins N`.
- An existing `games.json` without the new fields loads with nothing bad and no warning.

## Non-goals

- No second human player (no hot seat), no online play, no sound, no new dependencies, no physics engine.
- No choice of team size, map, weapons or difficulty; no map editor. The bot's skill follows the person's win streak.
- No battle saved across a restart: after a restart a new battle starts, as a run does in the other games.
- No ninja rope, jetpack, girders, mines or crates. Movement is walking, jumping, Drill and Teleport.
- No change to the window (place, size, header, fold, close, keyboard hand-over) or to the six other games.

## Anti-goals (a failure even if it works)

- **A copy of Worms.** No worms, no name, look, sounds, voice lines or weapon names of that series (no holy grenade,
  banana, sheep or the like), no gravestones. The fighters are Clawd (`clawd.ts`) and Runner's bug (`bug.ts`); the
  weapons are our own, named after programming jokes, like the brackets and `null` of the other games.
- A frame that stalls while the bot plans, or a loop that runs while the game is not live.
- A shot that passes through a thin wall, or a fighter that sinks into the ground or walks through rock.
- A game key (Tab, Enter, a digit, an arrow, Space) that reaches the terminal or the chat, or moves the page's focus.
- A battle that never ends.

## Constraints

- AGENTS.md: plain TypeScript in the renderer, English strings, tests on every level where a behavior lives, the IPC
  guard checks the save, validated saves, no new dependencies, keep line endings (the games files are LF).
- Built on `origin/master` as of 2026-11-17 (0.24.0), where the window and the six games live in
  `src/renderer/games/`, the save in `src/shared/games.ts` and `src/main/games-store.ts`, the guard in
  `src/main/ipc-guards.ts` (`isGamesSave`).
- The window is 300 px wide (276 px inside its padding) and stays about 300–350 px tall.
- The window drops key repeats (`gameKeyRoute`), so a held key is down until its keyup: walking, aiming and the power
  charge follow the held state in the rules, as Sand's side moves do.
- Plain Tab, Enter and the digits 1–8 are not app shortcuts (`keymap.ts` maps only Ctrl+Tab, Shift+Enter, and digits
  with modifiers), so they reach the game as game keys, and the window's `onKey` already calls `preventDefault` on them.

## Approaches

1. **Ground as a bitmap — chosen.** The world is a grid of 1-px cells, each ground or empty. An explosion clears a
   disc, Drill clears a tunnel, and shots and fighters collide with the cells. This gives caves, overhangs and tunnels,
   which is the destructibility the person asked for. It keeps the split of the other games: a pure rules module (state,
   `step(state, input, dt)`, a seeded random in the state, no DOM) and a canvas view behind `GameView`.
2. **Ground as a height field** (one height per column, like Lander). Simpler, but no caves, tunnels or overhangs: the
   ground could only be lowered from above. Against what the person wants. Rejected.
3. **Ground as polygons** with circles cut out of them. Smooth edges, but polygon clipping without a library is a lot of
   fragile code, and the project allows no new dependencies. Rejected.

**The bot** plans by simulating candidate shots with the rules' own flight code (gravity, wind, bounces, the ground as
it is), and picks the best. A closed-form ballistic aim was rejected: it does not see a hill in the way, a bounce or a
cave. The search runs in slices across frames, so no frame stalls.

The person handed the choice of how to build it to me; these are my picks.

## What the person decided

- A turn-based artillery game in the spirit of Worms, as a seventh game in the games window.
- What matters most: destructible surroundings and a set of different weapons.
- The eight weapons as proposed (see "Weapons").
- Layout B from the mockups: the map three times the window's width, the camera following the action, a minimap strip
  on top. (Rejected: the whole map in the window, too cramped; a wider window for this game, which covers more of the
  terminal.)
- The battle as proposed: three Clawds against three bugs with 100 HP each, a new map every battle, one fighter a turn
  in rotation, walk, jump, aim and one shot, then 3 s to get away; a 45 s turn timer that stops while the game is
  paused or without the keyboard; wind that changes every turn; damage that falls off with distance, a push, fall
  damage, water that takes a fighter out; rising water after turn 30; a bot that aims with the same physics, misses
  less the longer the person's win streak, and spends specials; keyboard only; wins and the best streak kept; a battle
  kept while the window is closed or folded but not across a restart.

## The window

```
┌ Artillery ▾ ─────────────── ⏸ – ✕ ┐
│ ▬▬▬▬▬▬▭ 240   wind ◂◂  0:24   210 ▬▬▬▬▭▭ │   HUD row
│ ▁▂▃▅▆▅▃[▂▁▂▃▅▆]▅▃▂▁▂▃▅▃▂▁▂▃▅▆▅▃▂▁        │   minimap, the view's frame in it
│          ▼                             │
│          80   ⊹                  60    │
│         ▐██▌                    ▐██▌   │   field: a third of the map
│  ▁▂▃▅▆▇▆▅▃▂  ◯   ▂▃▅▇▇▅▃▂▁▂▃▅▆          │
│ ≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈ │   water
│ [↗∞][●∞][⁂1][»2][rm1][⇊1][⤓2][⌖1]     │   weapons
│ Rocket · ∞            aim 40° · power ▮▮▮▮▯▯ │
│ ←/→ walk · ↑/↓ aim · Space fire · Tab weapon │
└────────────────────────────────────────┘
```

- **HUD row** (DOM): the Clawds' total HP as a bar and a number on the left (accent), the bugs' on the right (purple);
  in the middle the wind (◂ or ▸, one to three of them by strength, none for calm) and the turn's time left on the
  person's turn, `bot` on the bot's. When the water rises, a `flood` mark joins the middle.
- **Minimap** (canvas, 276 × 34 px): the map at a third of its size, rows 58–160 (the generator keeps the ground below
  row 60), with the water, a dot per fighter in its team's colour, and a frame around the part the field shows.
- **Field** (canvas, 276 × 160 px): a third of the map, at full size.
- **Weapons** (DOM): eight cells with the weapon's glyph and what is left (`∞`, `2`, `1`); the chosen one has an accent
  border, an empty one is dimmed. On the bot's turn the strip shows the bot's choice, dimmed.
- **Info line:** the chosen weapon's name and what is left; the aim's angle and the power bar.
- **Hint line:** the keys for the moment (aiming, a cursor weapon, the retreat, the start or end screen).
- **Messages** over the field (DOM): `Space to start`, `Your turn`, `Bugs' turn`, `You win!`, `Bugs win`, `Draw`,
  `Water rising`.
- The whole window stays about 320 px tall.

The look follows the mockup the person approved: a dark sky with a few faint stars, the ground in the chrome grays with
a lighter 2-px top edge, darker sides and a sparse darker texture, the water in blue at about a fifth of opacity with a
lighter wavy line, Clawds in the accent orange, bugs in purple, each fighter's HP over it in its team's colour, a `▼`
over the fighter whose turn it is, a dotted aim line ending in a small crosshair.

## World

- **Size:** 828 × 160 field px (three times 276), y down. The camera moves only sideways.
- **Ground:** a bitmap, generated from the battle's seed: a surface from a few summed waves and a random walk, kept
  between rows 60 and 140, with some caves and an overhang carved out. The left and right edges of the map are walls for
  fighters; a shot that leaves through a side is gone. The top is open: a shot flies above it and comes back, with a
  small `^` at the field's top edge where it is.
- **Water:** from row 148 down at the start. A fighter that touches it is out; a shot that touches it sinks with no
  explosion.
- **Start spots:** the Clawds on the left half, the bugs on the right half, each on ground above the water, at least
  40 px apart, chosen from the seed.
- **Camera:** follows the active fighter while it walks and aims, the shot in flight (the first of several), the cursor
  of Deploy and Teleport, and then the next fighter; it glides rather than jumps, and stays within the map.

## Fighters

- Clawd is the 18 × 5 sprite of `clawd.ts` at unit 1 (18 × 10 px); a bug is `bug.ts`'s 7 × 5 cells of 2 px (14 × 10 px).
  Both have about the same hit box.
- **100 HP**; at 0 a fighter is out and disappears with a small puff. The fighter whose turn it is has the `▼`.
- **Walking:** ←/→, steps up to 3 px climbed, a higher step is a wall. A fighter with no ground under it falls. A fall
  higher than a threshold hurts, more the higher it was.
- **Jump:** Enter, a short hop forward and up.
- **Aim:** ↑/↓ turn the aim between straight down and straight up on the side the fighter faces; walking turns it.
- **Pushed:** a fighter hit by an explosion flies off, bounces a little, and comes to rest; it can be pushed off a ledge
  or into the water.

## Turns

- The teams take turns, the person first; within a team the fighters take turns in order, skipping those who are out.
- **The person's turn:** 45 s on the clock. Walk, jump, aim, pick a weapon, use it once. After the shot, 3 s to walk
  and jump away, with no second shot. The turn ends when that time is over and everything has come to rest (no shot in
  flight, no fuse burning, no fighter moving), or when the clock runs out, or once things rest after the active fighter
  was hurt.
- **The clock** stops once the weapon is used; the 3-s retreat takes over from there. When the clock runs out, the
  fighter's input stops and the turn ends once everything rests. A charge cut off by the clock's end or by a pause is
  dropped with no shot, as Pinball's plunger pull is. The clock keeps running between Ping's two shots: the use is
  complete only after the second shot, so a second shot cannot be held back forever.
- **The bot's turn:** the same rules; it plans (a `…` over the bug), may walk a little, turns its aim visibly, charges and
  fires, so the person can watch it.
- **Time** is counted only in `step`, so nothing moves and no clock runs while the game is not live (paused, folded,
  closed, without the keyboard, the app in the background).
- **Wind** is drawn at the start of each turn, from calm to strong either way.
- **Rising water:** from the 31st turn on, the water rises a few px at the start of each turn.
- **The end:** a team with nobody left loses; if both lose their last fighter in the same turn, it is a draw. Space
  starts a new battle. A win raises the wins and the streak (and the best streak); a loss or a draw sets the streak to 0.
- Before the first battle and after the end, the field shows the message and nothing runs.

## Weapons

Ammo is per battle and per team: each team starts with the same set and spends its own. Keys 1–8 pick a weapon, Tab
picks the next one with ammo, Shift+Tab the previous one (the window passes key codes only, so the view keeps whether
Shift is down from its keydown and keyup). A weapon that needs power is charged by holding Space (it fills in about a second and fires on its own at
full) and fires on release.

| # | Weapon | Use | Wind | Effect | Ammo |
|---|---|---|---|---|---|
| 1 | **Rocket** `↗` | aim, charge, release; flies in an arc | yes | explodes on touching ground or a fighter: a medium crater and damage | ∞ |
| 2 | **Grenade** `●` | aim, charge, release; bounces off the ground | no | explodes 3 s after the throw, wherever it is: like Rocket | ∞ |
| 3 | **Fork bomb** `⁂` | aim, charge, release; flies like Rocket | yes | on touching ground explodes and throws five bomblets up in a fan; each explodes on touch, smaller | 1 |
| 4 | **Ping** `»` | aim; Space fires a straight shot; the aim can be changed before the second | no | two shots a use, each instant along a line: a small hole, light damage, a strong push | 2 |
| 5 | **rm -rf** `rm` | Space drops it at the fighter's feet; the retreat starts at once | no | after 4 s the biggest explosion and damage | 1 |
| 6 | **Deploy** `⇊` | arrows move a cursor over the map (the camera follows), Space confirms | yes | three bombs fall from above the point, spread by the wind; each like a small Rocket | 1 |
| 7 | **Drill** `⤓` | aim down or to the side the fighter faces, Space starts | no | the fighter digs a tunnel about 40 px long, moving along it; no damage | 2 |
| 8 | **Teleport** `⌖` | cursor like Deploy, Space confirms | no | the fighter appears at the point if it is free and above the water, otherwise nothing is used; ends the turn | 1 |

- **Explosions** clear a disc of ground, hurt fighters within a radius somewhat larger than the crater (most at the
  centre, nothing at the edge), and push them away from the centre, harder the closer they were. An explosion does not
  set off another weapon's fuse.
- **No passing through:** a shot moves at most 1 px per substep against the bitmap, so it hits a 1-px wall at any
  speed.

## The bot

- **Plan:** for each target (a living Clawd) and each weapon it may use, it tries angles and powers on both sides and
  simulates each shot with the rules' own flight code, the current wind and the ground as it is, without changing the
  state, to the impact or the fuse. A shot scores the damage it would do to Clawds, a lot more for knocking one into the
  water, minus the damage to bugs. It may also try a few spots up to about 40 px away before aiming. It picks the best.
- **Specials:** Fork bomb or Deploy when two or more Clawds stand close together; rm -rf when a Clawd is next to the bug
  and the bug can get away; Ping when a Clawd is in a clear line and near; Drill or Teleport when no shot scores above
  zero (the bug is stuck in a pit or behind a wall).
- **Mistakes:** it adds a random error to the chosen angle and power, drawn from the state's seed. The error shrinks
  with the person's current win streak, down to a floor that still lets it miss now and then. At a streak of 0 it hits
  a fighter in the open about half the time. The error's scale is a parameter of the bot, so unit tests can set it to 0;
  in play the floor stays above 0.
- **Budget:** the search is split across steps, a bounded number of simulated substeps a step (a few ms of a frame), and
  ends within about a second; it is deterministic for a given state, so tests can check its choice.

## State and storage

- `GAME_IDS` gains `artillery`, after `sand`; the menu lists it last, with `wins N`.
- `GamesSave` gains `artilleryWins`, `artilleryStreak` and `artilleryBest` (the best streak): safe integers from 0 to
  10¹², like the other counters. A missing one is 0 and not bad (an older `games.json`); one that is there and out of
  range is 0 and named in `bad`. The IPC guard requires the three to be present, as it does for the later bests.
- The battle itself (map, fighters, ammo, turn) lives in memory only: closing or folding the window keeps it, a restart
  starts a new one. A battle lost to a restart counts as nothing: the wins and the streak stay as they were.
- The start and end messages show the wins, the current streak and the best streak (`wins 12 · streak 3 · best 5`).

## The view

- `ArtilleryView` implements `GameView`: `pausable` and `realtime` are true, `canPause()` is true during a battle.
- The loop (`FrameLoop`) asks for frames only while the view is live and a battle is going. The rules run fixed steps
  with an accumulator kept in the state, `dt` clamped to 0.1 s, as in the physics games.
- The ground is kept in an offscreen canvas of the whole map, painted once at the start of a battle; an explosion or a
  tunnel repaints only the box it touched (a little bigger, for the edge shading). Each frame draws the view's part of
  it, then the water, fighters, shots, the aim and the explosions' flashes.
- **State for tests:** the view puts on its element `data-phase` (`title`, `aim`, `flight`, `retreat`, `settle`, `bot`,
  `over`), `data-turn` (`you` or `bot`), `data-weapon`, `data-ammo`, `data-x` (the active fighter's x), `data-time`,
  `data-wind`, `data-hp` (the two teams' totals) and `data-camera`, so e2e reads them, not the canvas.

## Tests

As AGENTS.md requires, each behavior is tested through the entry point that uses it.

- **Unit:**
  - Ground: the same seed gives the same map; the ground stays between rows 60 and 140; start spots are on ground,
    above the water, on their own half and apart; a cleared disc and a tunnel remove exactly their cells.
  - Fighters: walking on flat ground, a 3-px step climbed and a 4-px step not, falling off a ledge, fall damage above
    the threshold and none below, the jump, the map's sides stop a fighter, water takes a fighter out.
  - Weapons, each: Rocket follows gravity and wind and explodes on the ground and on a fighter; Grenade bounces, ignores
    the wind and explodes at 3 s; Fork bomb splits into five; Ping fires two straight shots with a re-aim between; rm -rf
    lands at the feet and explodes at 4 s; Deploy drops three bombs over the cursor, drifting with the wind; Drill cuts
    its tunnel and moves the fighter; Teleport moves the fighter to a free spot and refuses rock and water without using
    the ammo; ammo counts down and an empty weapon cannot be used; no shot passes a 1-px wall at its top speed.
  - Damage: falls off with distance, none outside the radius, the push's direction, out at 0 HP.
  - Turns: the order alternates teams and skips the out; one use a turn; the 3-s retreat; the turn ends when all rests;
    the clock's end ends the turn; hurting oneself ends the turn; wind changes each turn within its limits; the water
    rises from turn 31; win, loss and draw, and what each does to wins, streak and best streak.
  - Bot: on a fixed map with a long streak (no error) it hits a lone Clawd in the open; it prefers a shot that does not
    hurt its own; its error shrinks with the streak; it uses Fork bomb on a group; its work per step is bounded; the same
    state gives the same choice.
  - Save: the new fields round-trip, a save without them has nothing bad, out-of-range values are bad, the guard needs
    them.
  - View: asks for a frame only while live and in a battle.
- **Integration:** the store round-trips the new fields; an old `games.json` without them loads with no error.
- **E2E** (`tests/e2e/games.spec.ts`): Artillery is in the menu with `wins 0` and can be picked; Space starts a battle;
  ←/→ move the active fighter (`data-x`), Enter jumps, Tab and 1–8 change the weapon, and none of these keys reaches
  the terminal or moves the focus out of the window; holding and releasing Space fires (`data-phase` goes to `flight`);
  pause stops the clock (`data-time`), and so does a click in the terminal; a `games.json` with wins written before the
  start shows them in the menu, and they survive a restart. The existing e2e test that expects six games in the menu
  now expects seven, and the README's line about the six games names seven.

## Left to the builder

- The tuned numbers: gravity, speeds, the power range, crater and damage radii and amounts, the push, the fall
  threshold, the bounce, the bot's search steps and error curve, the water's rise; recorded at the top of the rules
  modules and in this document once tuned, as in the physics games.
- How the rules split into modules (ground, fighters, weapons, turns, bot), file and class names.
- The wording of the messages and hint lines; the exact glyphs in the weapon strip.
- The generator's details (waves, caves, the overhang), as long as the map is fair enough that neither side starts in a
  hole.

## My calls (not discussed with the person, open to change)

- The name **Artillery**, plain like the other games' names.
- Clawds in accent orange against bugs in purple; the person's team is always the Clawds and goes first.
- The minimap shows rows 58–160; the generator keeps the ground below row 60 so it fits.
- The map's sides are walls for fighters and an exit for shots; the top is open, with a `^` marker; a shot that touches
  the water sinks without exploding.
- A fighter at 0 HP disappears with a puff; nothing is left on the map.
- The turn ends once things rest after the active fighter was hurt; Teleport ends the turn; rm -rf starts the retreat at
  once; Ping's two shots can be re-aimed between them; Drill digs down or to the facing side.
- An explosion does not set off another fuse.
- Tab skips weapons with no ammo; Shift+Tab goes back.
- The bot's turn is paced so it can be watched; its specials follow the rules above.
- The current streak is saved too, so the bot's skill survives a restart; a battle cut off by a restart changes nothing.
- The clock stops when the weapon is used; a charge cut off by the clock or a pause fires nothing.
- Ammo is counted per team.
- The streaks show on the start and end messages; the menu shows only `wins N`.

## Tuned numbers

Tuned by simulated play: 30 seeded battles, bot against bot, stepped through the rules' own `step` at the fixed step of
1/120 s. The bugs play `driveBot`. The Clawds play a scripted Rocket player: it aims with the bot's `predict` at the
nearest bug, takes the aim and power whose first impact lands closest to a bug, and charges to that power. The numbers
below are the ones the battles were checked against; the values are in `artillery-config.ts`, with their reasons.

- **Battle length** at a streak of 0 (the bugs at full error): 15–35 turns, median 21, all 30 battles won by the
  Clawds. The scripted Clawds aim without error, so the win count says nothing about balance. At the streak floor
  (10): 17–29 turns, median 21, 26 wins and 4 losses. Both are within the 10–40 turns the design asks for.
- **A direct Rocket hit** does 45 at the fighter's centre (radius 14, reach 1.5 × radius, damage falling off to 0 at
  the reach): 45 of 100 hp, roughly half, kept.
- **A jump on flat ground** costs nothing: the fighter lands on the row it left, so the fall is 0 (checked straight up,
  left and right).
- **Settling:** the longest settle seen was 1.53 s; `settleMax` (10 s) was reached in none of the 30 battles.
- **Clock:** no turn ended by its clock in the 30 battles.

The numbers, px and seconds with y down:

- **Motion:** gravity 150 px/s²; walk 30 px/s; climb 3 px; jump 40 px/s sideways and 80 px/s up; a fall of up to 30 rows
  is free, and each row past it costs 0.5 hp; a landing faster than 100 px/s bounces; wind up to 50 px/s²; 100 hp each.
- **Aim and cursor:** the aim turns 60°/s from −90° to 90°, starting at 30°; the cursor moves 120 px/s, starting 30 px
  above the feet.
- **Power:** a charge fills in 1 s and launches at 60–300 px/s.
- **Shots** (radius, damage, push at the centre): Rocket 14, 45, 110, on wind; Grenade 14, 45, 110, off wind, bounce 0.45,
  fuse 3 s; Fork bomb's own blast 12, 30, 90, then 5 bomblets (speed 90) of 8, 15, 60; rm -rf 30, 70, 200, off wind, fuse
  4 s; Deploy's bombs 12, 30, 90, 3 of them 12 px apart from row −20, falling at 40 px/s.
- **Ping:** blast 5, damage 20, push 180, 2 shots a use, range 300 px.
- **Drill:** 40 px long, 1.5 s, holes of radius 8.
- **Turns:** a 45-s clock; a 3-s retreat after a shot; the water rises 4 px a turn from turn 31; settle at most 10 s;
  a blast shows for 0.3 s; a shot is removed after 12 s; a shot slower than 15 px/s counts as resting.
- **Bot:** 8000 substeps of search a step and at least 0.5 s of thinking; aim steps of 5°; power steps of 0.1 from 0.2
  to 1; aim error ±8° and power error ±0.05, both scaled by 0.8 per win in the streak, never under 0.15; kill bonus 30,
  drowning bonus 100, its own fighters' damage weighted 1.5.
