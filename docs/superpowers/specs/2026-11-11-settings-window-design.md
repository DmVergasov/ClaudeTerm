# The Settings window, redesigned — design

Date: 2026-11-11. Status: the user approved the four mockup boards ("по настройкам окей"):
`Settings-Appearance`, `Settings-Claude`, `Settings-Notifications` and `Settings-Search` on the design canvas
(https://claude.ai/artifact/XV8YQrc8PYax6fYCxfDkj1, the row "The Settings window"). This document writes those boards
down; where the boards are silent, the choice is marked **Claude's call**.

## Intent

The Settings window today is one long page of small form rows. It becomes what the boards show: a search field and a
row of tabs at the top, each tab a page of settings in cards and rows, choices you can see (theme previews, little
layout pictures) instead of drop-down lists, switches instead of checkboxes, and a search that finds a setting on any
tab and lets you change it right there. It keeps the Graphite look of the main window (part 1 of the redesign).

**Not changed:** what any setting does, its key in `settings.json`, how a change is saved (at once, one key at a time,
through `ct.setSetting`), the locked state for a broken `settings.json`, the problem notice, the error line under a
field, **Open settings.json**, opening the window at Devices or Notifications (`#devices`, `#notifications`, the bell
and `open_device_settings`), Esc closing the window, the window's own 36 px drag bar. Every setting the window edits
today stays in it, with the same key and behavior.

## Layout

From the top: the title bar (the app mark `>_` on the accent, then "Settings"), the head (the search field, then the
tabs), the page of the tab in front (the only part that scrolls), the footer.

- **Head**: content centred, at most 820 px wide, 18 px above, 28 px at the sides. The search field is 38 px high,
  radius 10, `#16161A` with a `#2A2A31` line, a search icon, the placeholder "Search settings", and the key hint
  `Ctrl+F` (`⌘F` on macOS). Under it the tabs, 38 px high, 12 px below the field, text `#8C8C96`, the tab in front
  `#EDEDF0` with a 2 px accent line under it. The tabs scroll sideways when the window is narrow. A line `#1C1C21`
  under the head.
- **Tabs, in this order:** General · Appearance · Claude Code · Notifications · Panels · Accounts · Devices. The
  window opens at General (**Claude's call**: the boards show no default; General is first), or at the tab of the
  section it is opened at.
- **Page**: centred, at most 820 px, 24 px above, 28 px at the sides, sections 28 px apart. A section has a heading
  (10.5 px, uppercase, 0.08em, `#8C8C96`) and then either a **group** of rows (a card: `#111114`, line `#1C1C21`,
  radius 12; a row is 12×16 px padded, a 500-weight label over a 12 px `#8C8C96` description on the left, the control
  on the right, a `#1C1C21` line between rows) or a set of **choice cards** (a radio group: `#16161A`, line `#2A2A31`,
  radius 10; the chosen one has the accent line, an 8% accent fill and an accent check after its name).
- **Controls**: text and number fields 30 px high, radius 7, `#0E0E11`; selects the same; a **switch** 36×20 with a
  16 px knob (off `#2A2A31` / `#B5B5BE`, on accent / white). The font size has − and + buttons around its field.
- **Footer**: under the page, always visible: a green check and "Saved as you change it", then the note "Profiles,
  image types, ignored folders, a custom theme and the image and Changes panel widths are set in settings.json"
  (today's footer text, **Claude's call**: the boards shorten it differently per tab), then **Open settings.json** as a
  ghost button.
- The window opens at 880×760 (at most the work area), at least 560×480 (**Claude's call**: the boards are 1040 wide;
  880 holds the 820 px column).

## What goes where

| Tab | Section | Setting (key) — control |
|---|---|---|
| General | Shells | Default shell (`defaultProfile`) — select · Default folder (`defaultFolder`) — text · Console host (`conpty`, Windows only) — select |
| General | Updates | Check for updates automatically (`autoUpdate`) — switch |
| Appearance | Terminal theme | `theme` — a card per built-in theme with a preview of its colors; a theme object from settings.json shows as one more card, "Custom (settings.json)", chosen and not clickable; an unknown name as "‹name› (not found)" the same way. Note under: "A theme of your own colors goes in settings.json and shows here as one more card." |
| Appearance | Terminal text | Font (`font.family`) — text · Size (`font.size`) — number with − / + · Scrollback lines (`scrollback`) — number |
| Appearance | Tabs | `tabs.position` — cards On top / On the left, each with a little picture and its value as a chip (`"top"`, `"left"`) |
| Appearance | Panels without room | `sidePanel.noRoom` — cards Over the terminal / Narrow the terminal, pictures, chips; note "The panels widen the window first. Maximized, or at the edge of the screen, it cannot widen." |
| Claude Code | *(the default view of new Claude tabs — see Chat mode)* | — |
| Claude Code | Starting Claude | Command (`claude.command`) — text, monospace · Shell for Claude tabs (`claude.shellProfile`) — select |
| Claude Code | While Claude works | Continue a cut-off response (`claude.autoContinue`) · Go on after a restart (`claude.continueAfterRestore`) · Pace of the usage limits (`claude.limitPace`) — switches |
| Claude Code | Status bar | Refresh on a timer (`claude.statusRefresh`) — switch · Refresh every (`claude.statusRefreshInterval`) — number + "seconds"; dimmed and disabled while the timer is off |
| Notifications | When a tab you are not looking at needs you | the table of cases × channels (`notifications.<case>.<channel>`) — checkboxes |
| Notifications | Sound | `notifications.sound` — cards: the system sound / Custom .wav; a **Play** button under them |
| Notifications | More | Signal a finished answer during background work (`notifications.doneWithBackgroundWork`) · Highlight a tab left unread (`notifications.autoUnread`) — switches |
| Panels | Media | `imageWatch.enabled`, `imagePanel.autoOpen` — switches |
| Panels | Changes | Editor (`review.editor`) — text · `review.statusBar`, `review.hideIgnored`, `review.hideTests`, `review.renderMarkdown` — switches · Test files (`review.testPatterns`) — the list with Restore defaults |
| Panels | Agent messages | `agentMessages.enabled`, `agentMessages.marks` — switches |
| Accounts | Accounts | the Accounts section as it is |
| Devices | Devices | the Devices section as it is, with Keep this computer awake (`devices.keepAwake`) — switch |

The Panels tab, its sections, the Updates section and the copy of the rows the boards do not show are **Claude's
call**: they take today's labels as the row label and today's hint as the description.

### Copy from the boards

- Default shell: "New tabs open in it · Automatic: PowerShell 7 if installed, else Windows PowerShell" (elsewhere
  "… Automatic: your login shell"). Console host: "How a shell talks to the window · applies to new tabs · Windows'
  own may leave lines of Claude Code's screen behind or double them". Command: "What the tab's shell runs to start
  Claude · applies to new tabs". Shell for Claude tabs: "Applies to new tabs".
- Theme cards: Graphite "ClaudeTerm's own, in the window's colors"; Campbell "Windows Terminal's default"; One Half
  Dark "Soft contrast on slate"; One Half Light "A light terminal in the dark window". The preview shows `$ npm test`,
  `✓ 42 passed` in the theme's green and a cursor block in its cursor color, on its background.
- Font: "Any monospace font on this computer". Size: "In pixels; zooming the terminal does not change it" (**Claude's
  call**: the board's "Ctrl+= and Ctrl+− change it too" is not what zoom does). Scrollback lines: "Applies to new tabs".
- Tabs: On top "A row of tabs above the sheet, grouped by project"; On the left "A list beside the sheet, Recent
  sessions at its foot". Panels without room: Over the terminal "Media and Changes cover the terminal's right side";
  Narrow the terminal "The terminal steps aside and gets narrower".
- While Claude works: "When a dropped connection cuts a response off, up to 3 times in a row"; "The tabs ClaudeTerm
  restores pick up the work Claude was doing when it closed"; "A bar and a color in the title bar from how fast each
  limit is spent". Status bar: "Off: the status bar updates with each message Claude sends"; "1–300 seconds; each
  refresh starts a few short processes per Claude tab".
- Notifications table rows: "Claude asks for permission", "Claude asks a question", "Claude finished its answer", "A
  turn another session started" with "Claude answered a message from another agent" under it, "Terminal bell".
  Columns: Sound, Taskbar flash, Notification, Tab highlight, Even in front (its tooltip: "Also while you look at the
  tab: its sound plays").
- Sound cards: "Windows default" (elsewhere "System sound") — "The sound your system uses for notifications"; "Custom
  .wav" — "Pick a file; it plays for every case above", or the chosen file's path once there is one. Choosing the
  Custom card opens the file picker, also when it is already chosen (to pick another file; **Claude's call**: the board
  has no Browse button). Play: "Plays the sound in use".
- More: "Also while agents, shell commands or monitors Claude started still run"; "A Claude tab you leave with a reply
  not read to its end, or a prompt not sent".

## Search

From the Search board.

- Typing in the field filters at once: the page shows the matching settings of **every** tab, grouped in their
  sections; each section heading reads "‹Tab› › ‹Section›". The settings work in place, as on their own tab.
- A match is a row, a set of cards, the notifications table, or the Accounts or the Devices section as a whole. It
  matches when every word typed is in its label, its description, a card's name or note, or its settings.json key
  (**Claude's call**: the key, so `scrollback` or `statusRefreshInterval` finds its row), case ignored. The matched
  text in labels, descriptions and card names is marked (accent at 25%).
- The field shows the count ("1 setting", "4 settings", "No settings") and a clear button (×) in place of the key hint.
  A first tab "All results" with the count on an accent badge comes before the others and is the one in front; every
  tab shows its own count on a badge, and a tab with none is dimmed and cannot be chosen. Choosing a tab narrows the
  results to it (**Claude's call**). With no match the page says "No settings match". Under the results: "Esc clears
  the search".
- Esc clears the search, wherever the focus is in the window; Esc with an empty search closes the window, as today.
  The clear button does the same as Esc. Clearing goes back to the tab you were on. `Ctrl+F` (`⌘F`) puts the focus in
  the field and selects its text.
- Opening the window at a section (the bell, `open_device_settings`) clears a search first.
- A hand edit of settings.json while a search is shown keeps the search and its results.

## States and motion

- **Locked** (settings.json cannot be used): the banner under the head, every control on every tab disabled — fields,
  switches, cards, the − / + buttons, Restore defaults; search and the tabs still work.
- A failed save shows its message under the row or under the cards, as today.
- Motion (only `opacity` and `transform`, off under `prefers-reduced-motion`): the page of a tab fades in over 120 ms
  with a 4 px rise; a switch's knob slides over 120 ms.
- Keys: `PageDown` / `PageUp` scroll the page from anywhere outside a text field, also right after a tab was clicked.
- At the minimum size (560×480) nothing scrolls sideways but the row of tabs: cards fall into one column.

## Chat mode

The Claude Code tab begins with a slot for the default view of new Claude tabs (the board's "New Claude tabs open in
— Chat / Terminal" cards with the "with chat mode" badge). The chat-mode plan owns that setting's key; this work leaves
an empty, hidden `<div class="settings-slot" data-slot="claude-view">` as the first child of the Claude Code page, and
the control goes there when the two branches meet, built with the same choice cards (`cardSection`).

## What is left to the builder

Pixel values beyond the ones above follow the boards' CSS. Line endings, comment style and naming follow the
surrounding code (AGENTS.md).
