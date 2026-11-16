# Mini-games while Claude works — design

## Intent

While Claude works on a turn, the person waits: a long refactor, a test run, a review by agents. They want something
light and absorbing to play in that time, without leaving ClaudeTerm and without losing sight of the terminal. So the
games live in a small window in a corner of the terminal, not full screen, and can be paused or folded away at once.

The games stand on their own: they know nothing about Claude, and the window changes nothing in how ClaudeTerm signals.
Note what that means with the default notification settings: while the person plays over the Claude tab in front, in a
focused window, ClaudeTerm counts that tab as being looked at, so a permission prompt, a question or the end of a turn
gives no sound, tab mark, flash or banner (`front: false` in `src/main/settings.ts`, `Attention.notify`). The person
keeps an eye on the terminal and the tab's spinner, or turns on "Even in front" in Settings. The user chose this over
making the open game window count as "not in front".

## Goals

- A game window over the bottom-right corner of the tab's view (the chat or the terminal), opened from a toggle in the
  sheet header and by a shortcut.
- Three games in the first version: **Runner** (an endless runner with Claude's mascot), **Merge** (slide-and-merge
  tiles) and **Clicker** (an idle clicker).
- A pause button, a fold (minimize) button that leaves a small pill in the corner, and a close button.
- Games, their records and the clicker's progress survive closing the window and restarting the app.

## Non-goals

- No link to Claude: no auto-open while Claude works, no auto-pause when Claude finishes, no game per tab.
- No full-screen mode, no game in its own OS window, no game outside the ClaudeTerm window.
- No sound, no online scores, no sync between devices (device sync stays with stars and notes).
- No minesweeper (dropped by the user). Snake, typing and breakout games were floated and left for later.
- No new dependencies: no game engine, no UI framework.

## Anti-goals (a failure even if it works)

- The game steals keys from Claude: a key the person meant for the terminal ends up in the game, or the other way round.
- The window hides what Claude is doing: it covers the side panel or the note, or squeezes the terminal.
- It costs CPU or battery while nobody plays: an animation loop running while the window is folded, closed, paused or
  the app is in the background.
- A copy of an existing game: the games are our own takes on their genres, with their own names and look (see "The
  games"). The only borrowed character is Claude's own mascot, by the user's choice.

## Constraints

- AGENTS.md holds: plain TypeScript in the renderer, every UI-visible string in English, the renderer reaches the
  system only through the preload bridge, main checks every IPC argument (`ipc-guards.ts`), anything read from disk is
  validated and degrades gracefully, tests on all three levels where the behavior lives, CI green on Windows, Linux and
  macOS.
- The mockup the user approved was drawn with Russian labels for the discussion; the app's strings are English.
- It is built on `origin/master` as of 2026-11-16 (0.22.x), not on the older branch the discussion started from. There
  the panel toggles (Changes, Sessions, Media, Agent messages, Docs, Note) live in the sheet header above the tab's
  view (`src/renderer/sheet-header.ts`), and a Claude tab shows a chat by default (`claude.view: 'chat'`), with its
  composer along the bottom of the view. The mockup was drawn on the older look; its window, games and states carry
  over, and the button and the placement follow the new layout as described below.

## Approaches

1. **In the main window's renderer, plain TypeScript, no libraries — chosen.** The game window is an overlay inside
   `#terminals`, like the note. Runner draws on a `<canvas>`; Merge and Clicker are DOM. Each game's rules are a pure
   module without DOM, so unit tests drive them directly. State is stored by main in a JSON file in the data folder,
   like `starred-sessions.json`. It matches how the whole renderer is built.
2. **A separate small always-on-top OS window.** Playable with ClaudeTerm minimized, but it needs its own window
   management on three systems (focus, position, Linux window managers), and the user asked for it inside the app.
   Rejected.
3. **A game engine (Phaser and the like).** A megabyte of dependency for three small games, against the project's
   no-framework rule. Rejected.
4. **Text games in a terminal tab.** That is a tab, not a corner window. Rejected.

The user agreed to approach 1 and approved the mockup of the window and the three games.

## What the user decided

- A small window in a corner, not full screen.
- The games are independent of Claude; the window can be folded, and it has a pause button.
- The open game window does not change ClaudeTerm's signals: no extra sound for the tab in front while playing.
- Games: Runner with Claude's mascot Clawd drawn as it is (the user accepted the small brand risk; the sprite lives in
  one place so it can be swapped), Merge, Clicker. No minesweeper.
- Approach 1, and the mockup: the window in the bottom-right corner with header ▾ ⏸ – ✕, the three games as drawn,
  the paused state, the game menu, the dimmed state when keys go to the terminal, and the folded pill.

## The window

```
┌ Runner ▾ ─────────── ⏸ – ✕ ┐
│ score 1 240     best 3 311  │
│                             │
│  ▐▛███▜▌        }     🐞    │
│ ▝▜█████▛▘                   │
│ ─────────────────────────── │
│ Space/↑ jump · ↓ duck       │
└─────────────────────────────┘
folded:                   [🎮 Runner · paused ▴]
```

- **Place.** An overlay at the bottom right of `#terminals`, about 300 px wide and 300–350 px tall; the view keeps its
  size. It sits left of the side panel when the panel covers the view, the way the note does
  (`right: calc(… + var(--panel-cover, 0px))`). When the tab in front shows the chat, the window sits just above the
  chat's composer, so the field and its send button stay visible and usable; it follows the composer's height as it
  grows. The note stays at the top right; the two never overlap in a window of normal height.
- **Opening.** A gamepad toggle in the sheet header, after Note, shown for every tab (shell tabs too: the games are the
  window's, not a tab's). It is lit while the window is open or folded. Shortcut **Ctrl+Shift+G**, **⌘G** on macOS,
  added to `keymap.ts` with its label in the toggle's tooltip. The toggle and the shortcut toggle the window: closed →
  open, open or folded → closed.
- **Header.** The game's name with ▾ opens the game menu: the three games, each with its record (or, for Clicker, its
  line count); picking one pauses the current game and switches. Then ⏸ (▶ while paused), – (fold), ✕ (close).
- **Pause.** Runner stops and the field dims with "Paused · ▶ or Space to resume". Merge has nothing running; ⏸ just
  dims it the same way. Clicker has no pause: its button is shown disabled, since the clicker earns on its own by design.
- **Fold (–).** The window shrinks to a pill in the same corner: the gamepad icon, the game's name and "paused". The
  game pauses. A click on the pill unfolds the window; the game stays paused until the person resumes.
- **Close (✕).** The window hides; the game pauses; everything is saved. Opening it again shows the same game, paused.
- **Keys.** A click in the window gives it the keyboard: its border turns accent-colored and game keys (arrows, Space)
  go to the game, never to the tab (its terminal or its chat composer). A click in the tab's view takes the keyboard
  back: the window dims, shows "Click to play", and Runner pauses itself. App shortcuts (new tab, panels, …) keep
  working while the game has the keyboard, through the existing document-level handler in `main.ts`. Esc while the game
  has the keyboard gives it back to the tab (`focusTab`).
- **Who has the keyboard when.** Today `main.ts` hands the keyboard to the tab in front (`focusTab`: the chat composer
  or the terminal) after a header toggle, on every tab switch (`activate`) and when the app window regains focus; the
  game window joins those paths as follows:
  - opening the window (toggle, shortcut) or unfolding it (pill) gives the game the keyboard — it was opened to play;
  - a tab switch gives the keyboard to the new tab, as today: switching tabs is a move toward Claude. The game window
    stays open; it dims and Runner pauses;
  - when the app window regains focus, the keyboard goes back to the game if the game had it when the app lost focus
    (the way `#note` and `#image-panel` are already kept in the window `focus` handler), otherwise to the tab;
  - nothing else takes the keyboard from the game: a reply arriving in the chat, a new card or a status change leaves it
    where it is;
  - keys that are not game keys (letters, Enter, …) while the game has the keyboard are dropped: they never reach the
    tab, so a half-typed word cannot land in Claude's prompt.
- **One window per app window**, the same over every tab; switching tabs does not touch it.
- **After a restart** the window starts closed; the last chosen game, every game's state and the records are kept.

## The games

All three use ClaudeTerm's colors (`colors.css`) and a monospace font for numbers, so they look like part of the app.

### Runner

An endless runner. Clawd runs on a line along the bottom; obstacles scroll in from the right and get faster over time.

- **Clawd** is the mascot from Claude Code's welcome screen, drawn from its half-block art as an 18 × 5 pixel sprite
  whose pixels are twice as tall as wide, in the accent orange. It lives in one module (`clawd.ts` or similar) with a
  running frame or two (legs) and a ducking pose; Clicker reuses it.
- **Obstacles:** brackets (`}`, `{ }`, `( )`) and a small pixel bug on the ground to jump over; a flying `null` at head
  height to duck under.
- **Keys:** Space or ↑ jumps, ↓ ducks. After a crash, Space starts a new run.
- **Score** grows with distance; the record is kept. Speed rises with the score up to a cap.
- **Loop:** `requestAnimationFrame` only while a run is going and the window is open, unfolded, not paused and has the
  keyboard; it also stops when the app window loses focus or is hidden. The rules (`step(state, input, dt)` with a
  seeded random source) are pure, so tests run them without a canvas.

### Merge

Our own slide-and-merge puzzle with file sizes instead of plain numbers.

- A 4 × 4 board. Arrows slide every tile; two equal tiles that meet merge into one twice as big: 1 KB + 1 KB = 2 KB,
  … 512 KB + 512 KB = 1 MB, and on (2 MB, 4 MB, …).
- After each move that changed the board, a new tile appears in an empty cell: 1 KB mostly, 2 KB sometimes.
- **Goal: a 1 MB tile.** Reaching it shows a "1 MB!" note with "Keep going"; the game goes on for the score.
- **Score:** the sum of the merged tiles' sizes in KB; the record is kept. When no move is left, "No moves" with a
  "New game" button. A "New game" button in the window starts over at any time.
- Tile colors go from the dim chrome grays to the accent orange and on to gold for the largest, as in the mockup.

### Clicker

An idle clicker about writing code.

- A click on Clawd writes one line of code. Lines buy helpers that write lines on their own: **Intern**, **Agent**,
  **Server**, **Data center** (four in the first version). Each purchase makes the next of the same kind dearer.
- The window shows the line count, the rate per second and the shop; a helper the person cannot afford yet is dimmed.
- **It earns while away:** while the window is closed or folded, and while the app is closed, for at most 8 hours of
  absence. Back in the window, a line says what was earned while away ("+12 340 lines while you were away").
- Earnings are computed from timestamps, not a timer running in the background: the saved state holds the time it was
  last brought up to date, and opening the game (or saving it) adds what the helpers earned since. No loop runs while
  nobody looks. While the window is open, the count updates a few times a second.
- Big numbers are shortened (12.4K, 3.1M).

## State and storage

- Main keeps the games' state in `games.json` in the data folder (next to `starred-sessions.json`), written as the
  other stores are: to a `.tmp` file, then renamed. A missing, unreadable or corrupt file means a fresh start, with a
  warning in the log; each game's part is validated on its own, so one bad part does not lose the others.
- Stored: the last chosen game; Runner's record; Merge's board, score, record and whether 1 MB was reached; Clicker's
  lines, helpers bought and the time it was last brought up to date. A Runner run in progress is not kept (a restart
  starts a new run).
- The bridge gets two calls: load the state, and save it. Main checks the argument of the save with the ipc guards
  (shape, number ranges, a size limit) and ignores anything else.
- The renderer saves after a change, at most every couple of seconds, and right away when the window closes, folds,
  switches games, or the page is about to unload.

## Tests

As AGENTS.md requires, each behavior is tested through the entry point that uses it.

- **Unit** (`tests/unit`): Merge's moves, merges (one merge per tile per move), the new tile with a seeded random,
  the 1 MB goal, "No moves", scoring; Runner's jump, duck, collision, the speed ramp and the score with a fixed `dt`;
  Clicker's click, purchase prices, the rate, the earnings since a timestamp and the 8-hour cap with a fake clock;
  validation of a stored state (good, partly bad, garbage).
- **Integration** (`tests/integration`): the store against a real temp folder — saving and loading, a corrupt file,
  a part that fails validation while the others load.
- **End-to-end** (`tests/e2e`), against the real app with its own data folder:
  - the header button and the shortcut open and close the window;
  - in Merge, arrow keys change the board and nothing reaches the terminal; a click in the terminal gives the keys back;
  - pause and resume; fold to the pill and unfold; close and reopen keep the game;
  - Runner pauses when the terminal takes the keyboard (read through the window's text or a data attribute, not the
    canvas);
  - a Clicker click raises the count; a purchase lowers it and raises the rate;
  - Merge's board and the records are there after the app restarts;
  - the window stays left of the side panel when the panel is open;
  - in a chat tab the window sits above the composer, and a reply arriving in the chat leaves the keyboard with the game.

## Left to the builder

- Exact sizes, speeds, the speed ramp, Runner's obstacle spacing and hit boxes, Merge's chance of a 2 KB tile, the
  Clicker's prices, rates and price growth — tuned so each game feels good; record the numbers in the code.
- The gamepad icon's drawing, in the style of the header's other icons.
- File and class names, the IPC channel names, how the window and the games split into modules.
- Whether the README's feature list mentions the games (and if so, whether `npm run screenshots` needs a new image).

## My calls (not discussed with the user, open to change)

- The opening toggle sits in the sheet header after Note, where the other panel toggles live on today's master (the
  mockup, drawn on the older look, put it in the tab bar), and it shows for every tab.
- In the chat view the window sits above the composer instead of over it.
- The shortcut Ctrl+Shift+G / ⌘G.
- Runner pauses itself when the terminal takes the keyboard, when the window folds or closes, and when the app loses
  focus; Esc gives the keyboard back to the terminal.
- Who has the keyboard: opening or unfolding gives it to the game; a tab switch gives it to the terminal; regaining focus
  gives it back to whoever had it; non-game keys are dropped while the game has the keyboard.
- After a restart the window starts closed.
- English game names: Runner, Merge, Clicker; helpers Intern, Agent, Server, Data center.
- The Clicker's away earnings are capped at 8 hours.
