# Redesign, part 1: the new look — design

Date: 2026-11-10
Status: approved by the user

## Why

The user wants ClaudeTerm to look and feel like expensive, carefully made software, not like a plain terminal with
extras. They showed another Claude Code front end as a reference for the level of finish ("not like this exactly, just
an example"): a window with its own title bar, a calm dark palette, a side column of navigation, usage meters at the
top, tidy toolbars.

The whole wish is bigger than a new skin, and is split in three, built in this order:

1. **Part 1 (this document): the new look.** The window, the tabs (on the left and on top), the side panels, the
   status bar, menus, dialogs and the Settings window get a new visual design, the usage limits move to a title bar of
   ClaudeTerm's own, and Claude's work gets tasteful motion. What a Claude tab shows stays Claude Code's terminal.
2. **Part 2 (a later design): the chat mode.** A Claude tab can show the conversation as ClaudeTerm's own chat
   instead of the terminal: messages, tool calls, Claude's questions with answer choices, permission requests, slash
   commands, attachments, all of them working. The terminal stays available as an option per tab.
3. **Part 3 (a later design): attachments from other devices.** In the chat, a file or screenshot from another
   device of the user's device group (see `2026-11-04-device-sync-design.md`) is attached as easily as a local one.

Part 1 comes first because parts 2 and 3 are drawn inside the frame part 1 builds: the sheet, its header, the panel
toggles, the status bar, the motion rules and the performance rules.

The user decided:

- The app gets a new design that reads as premium software; the reference is an example of the level, not a
  template to copy.
- Both tab layouts stay: tabs on the left and tabs on top. The mockup must show and the design must cover both.
- Motion where Claude works, and in a few other places, "in moderation".
- **The app must fly.** Nothing in the new design may make it slower or laggy; this is a requirement of every part.
- The chat mode, with the terminal kept as an option, every Claude Code feature working in it (questions with
  choices, permissions, slash commands) and attachments, including from other devices: parts 2 and 3.

The user saw the mockup (the canvas "ClaudeTerm redesign", https://claude.ai/artifact/XV8YQrc8PYax6fYCxfDkj1, private
to the user: six screens, chat mode in most of them) and asked for this design to be written without changes to it.
The board "Terminal mode (classic, optional)" is the closest to what part 1 delivers; the other boards show the frame
part 1 builds with part 2's chat inside it.

## Background: what exists today

- The window: `src/main/index.ts` creates the `BrowserWindow` with the system's own frame (`autoHideMenuBar`, no
  `titleBarStyle`), background `#0C0C0C`. macOS has its menu (`src/main/mac-menu.ts`). The window's size and state are
  kept by `src/main/window-state.ts`.
- The page: `src/renderer/index.html` — `#tabbar` (top tabs), `#banner`, `#update-banner`, `#main-row` with
  `#tabpanel` (left tabs) and `#workspace` (`#terminals`, `#image-panel` — the side panel that holds Media, Changes and
  Docs), `#statusbar`; dialogs and popups at the end (`#search`, `#plan-list`, `#lightbox`, `#sessions`, `#toasts`).
- Styles: `src/renderer/styles.css` with the colors in `src/renderer/colors.css` (`--bg`, `--chrome`, `--chrome-2`,
  `--fg`, `--muted`, `--accent` = `#D97757`, `--border`); the Settings window has `settings.css`. Font: Segoe UI /
  system UI at 13 px; no font files are bundled.
- Tabs: `tabs.position` (`top` | `left`, default `top`). Top: `src/renderer/tabbar.ts`, a flat row of tabs, then
  `+`, `▾` (shell profiles and more) and the toggles of the side panels and the note. Left: `src/renderer/tab-panel.ts`
  with `tab-row.ts`, `tab-header.ts`; tabs grouped by project (`tab-groups.ts`, `panelGroups`), two-line rows (title,
  then branch), a colored bar for a linked worktree, forks indented, foldable groups, a resizable width.
- Tab states drawn today: Claude working (the icon runs through Claude Code's spinner glyphs, `.spin`), waiting for
  the user (`.attention`, a pulsing background until the tab is opened), the bell, muted, exited (struck through),
  unread images, a note.
- The status bar (`src/renderer/status-bar.ts`, segments `account`, `model`, `context`, `limit`, `week`, `agents`,
  `background`, `plan`, `changes`): the active Claude tab's statusLine data; the two limits draw a bar with a mark at
  the share of the window gone by and are colored by the pace (`limitPace`, setting `claude.limitPace`).
- The terminal: xterm.js in `.terminal-host`, which has no padding on purpose (the FitAddon measures it; the gutter is
  its `inset`). Themes in `src/renderer/themes.ts` (Campbell, One Half Dark, One Half Light; default Campbell). Font
  setting default `Cascadia Mono, Consolas, Menlo, monospace`, 12 px.
- Shortcuts in `src/renderer/keymap.ts` (new tab, close tab, toggles of the panels and the note, next waiting tab,
  Recent sessions, Settings).
- Tests: about 30 e2e specs in `tests/e2e` find things by ids and classes (`#tabpanel`, `#statusbar`, `.tab`,
  `.terminal-host`, `.menu-item`, `.panel-docs`, …); `npm run screenshots` (`tests/screenshots/readme.shots.ts`) makes
  the README images from invented sessions.

## Goals

- At first sight ClaudeTerm reads as a calm, precise, premium app, on Windows 10/11, macOS and Linux, with either tab
  layout.
- The window has a title bar of its own: the app's mark and name, the search of past sessions, and the two usage
  limits as small meters; the system's window buttons (or traffic lights) stay where the user expects them.
- The active tab sits on a "sheet": a panel with rounded corners set into the window, with a header that names the
  tab and holds the panel toggles.
- Every place the user meets is redrawn in one visual language: tabs in both layouts, side panels (Media, Changes,
  Docs), the note, menus, toasts, banners, Recent sessions, the plan list, the search box, the lightbox, the status bar,
  the Settings window, and a new default terminal theme that matches.
- Claude's work is visible through motion that is calm and cheap: the working glyph, a thin line running under the
  header while Claude works in the tab, a breathing mark on a tab that waits for the user, panels and menus that ease
  in. Nothing moves when nothing happens.
- It is at least as fast as today everywhere (see Performance), with no work at all while the window is idle.
- Everything works as before: every feature, shortcut, setting and state keeps its behavior; only the look and the
  places named below change.

## Non-goals

- The chat mode, the Chat / Terminal switch, the composer, the question and permission cards, the slash command menu:
  part 2. Part 1 leaves room for the switch in the sheet's header but does not show it.
- Attachments from other devices: part 3.
- A light version of the window chrome. The terminal keeps its light theme for whoever picks it; the chrome stays dark
  in part 1. *(Claude's call: a second chrome palette doubles the visual work and its tests; the tokens below make it
  a later, separate change.)*
- New navigation the reference has and ClaudeTerm does not (Dashboard, Files, Tickets, Cost, …). Part 1 changes how
  existing things look and where a few of them sit, nothing more.
- Searching open tabs from the title bar: the search field opens the existing Recent sessions window. *(Claude's
  call; the mockup's "Search tabs and past sessions" becomes "Search past sessions".)*

## Anti-goals — it fails even if it looks right when

- **Anything feels slower**: typing echo, switching tabs, opening a panel, scrolling the terminal, starting the app.
- **The window costs CPU or battery while idle**, because something keeps animating or polling.
- **A terminal is refitted again and again** during an animation (Claude Code redraws its whole screen on every
  resize), or ends one row or column off.
- **A feature, state or shortcut disappears or changes** on the way: a tab state that is no longer visible, a toggle
  that moved without its shortcut, a setting that no longer applies.
- **Motion gets in the way**: blinking that pulls the eye from the work, motion that ignores the system's "reduce
  motion", animations that delay an action (a panel that opens only after its animation).
- **The window misbehaves as a window**: it cannot be dragged, double-clicking the title bar does not maximize, Windows
  11's snap layouts do not appear on the maximize button, the traffic lights overlap content on macOS.

## Constraints

- Electron 44, plain TypeScript, no UI framework in the renderer (AGENTS.md). The renderer stays sandboxed; the CSP of
  `index.html` stays as strict: fonts are bundled files, never fetched from the network.
- Comments, logs and UI strings in English.
- The FitAddon rule: nothing gives `.terminal-host` padding; insets come from its position.
- Everything AGENTS.md asks of tests: every changed behavior has a test through its entry point; e2e tests use their
  own data folder; README images come from invented data only.
- Fonts: bundled font files must allow redistribution (SIL OFL or similar), and the license goes with them.

## What the user sees

The mockup is the reference for proportions and colors. The names and values below are the design's; the builder may
tune values by a few pixels to what renders best, but keeps the structure.

### The visual language

- **Palette** (dark; defined once as CSS custom properties in `colors.css` and shared with `settings.css`):
  - app ground `#0A0A0C` (title bar, side column, around the sheet); sheet `#111114`; terminal `#0E0E10`; raised
    surfaces (menus, cards, inputs) `#16161A` to `#1E1E23`; hairlines `#1C1C21` to `#2A2A31`;
  - text `#EDEDF0`, secondary `#B5B5BE`, tertiary `#8C8C96` (the darkest text color allowed: every text color keeps a
    contrast of at least 4.5:1 on the surface it sits on);
  - accent `#D97757` (the clay of today), used sparingly: the working state, the active toggle's badge, primary
    buttons, focus rings; status colors: green `#63C08F` (done, added lines), amber `#E5B567` (waiting for a
    permission, warnings), red `#F2867E` (removed lines, errors), blue `#7FA7F5` (the weekly limit, links), purple
    `#A78BFA` (a worktree's default color; the existing worktree colors stay).
- **Type**: Inter for the interface (bundled, variable woff2), 13 px base, 12 px secondary, 10.5 px uppercase labels
  with letter spacing 0.08em; tabular figures for numbers that change. The terminal keeps the user's `font` setting.
  *(Claude's call: Inter renders the same on all three systems, which Segoe UI / SF Pro / Cantarell do not; JetBrains
  Mono may be bundled too for code in panels, the terminal default stays Cascadia Mono.)*
- **Shapes**: radius 12 px for the sheet, 8–10 px for cards, menus and rows, 6 px for chips and small buttons; 1 px
  hairlines instead of heavy borders; shadows only on things that float (menus, popups, dialogs).
- **Icons**: one set of thin stroke icons (1.75 px at 24 px, drawn at 13–16 px), inline SVG, no emoji, no icon font.
  *(Claude's call: Lucide's shapes, which are ISC-licensed; the few icons used are copied in, no package.)*
- **Spacing**: a 4 px grid; controls 28–34 px high; touch targets of the title bar at least 30 px.

### The window and its title bar

- ClaudeTerm draws its own title bar, 44 px high:
  - Windows and Linux: the system's own window buttons stay, drawn over ClaudeTerm's title bar in its colors
    (`titleBarStyle: 'hidden'` with `titleBarOverlay`), so Windows 11's snap layouts keep working. *(Claude's call. If
    `titleBarOverlay` turns out not to work on a Linux desktop, Linux keeps the system frame and the bar loses only its
    window buttons' area: the builder verifies on Ubuntu with GNOME.)*
  - macOS: the traffic lights stay, inset in the bar (`titleBarStyle: 'hiddenInset'`, `trafficLightPosition`); the bar's
    content starts after them.
- The bar is a drag area; its controls are not. Double-click maximizes (the system's behavior). In full screen on
  macOS the bar stays, without the traffic lights' gap.
- Left: the app's mark (a 20 px rounded square in the accent with `>_`) and "ClaudeTerm".
- Middle: a search field, "Search past sessions", with its shortcut; clicking it, or the shortcut, opens the Recent
  sessions window as today.
- Right, before the window buttons: the two usage limits, **5-HOUR** and **WEEKLY**, as meters: the label, the % used,
  the reset as a clock time (`18:40`, or `Thu 09:00` when it is not today — a time, not a countdown, so nothing has to
  tick), and under them a 4 px bar with the used part and a 2 px mark where the time gone by stands. They move here
  from the status bar and keep everything they have there: the values come from the active tab's statusLine, the pace
  levels and forecast (`limitPace`), the tooltip. When the status bar would show no limits (a shell tab, no statusLine
  yet), the meters are hidden, as the segments are today. *(Claude's calls below, from the builder check.)*
  - Colors: at the normal level the 5-hour bar is the accent and the weekly bar blue, so the two read apart; warn
    turns either amber, crit red, as the levels color the segments today.
  - `claude.limitPace` keeps its meaning: off, a meter shows what the segment shows today with it off — the % and
    the time, colored by the fixed 70% and 90%, no bar, no mark, no forecast. Its label in Settings says "title bar"
    instead of "status bar".
- The window's background color at creation becomes the app ground, so no flash of another color shows at start.

### Tabs on the left (`tabs.position: left`)

- The column lies on the app ground, not on a panel of its own; it keeps its width setting and its resize handle.
- At its top: a **New tab** button the width of the column (with its shortcut on the right) that does exactly what
  today's `+` does (it opens a tab of the default profile), and a `▾` button beside it that opens today's menu of
  shell profiles and more.
- Groups: an uppercase label with a chevron and the marks a group head has today, restyled (folded: the count, the
  spinner while Claude works in one of its tabs, the pulsing dot when one waits, the steady dot for a bell); folding as
  today.
- Rows: 8 px radius, two lines (title; branch with its icon, in the worktree's color for a linked worktree), the state
  glyph on the left, the row's marks on the right (unread images, muted, bell, note, close). The active row is raised:
  a lighter surface and a 1 px inner hairline, not a colored bar. A worktree keeps its 2 px colored bar at the left
  edge. Forks keep their indent.

#### Tab states: today's, redrawn

Part 1 keeps today's state model exactly — `activity` (working or not) and the one `attention` flag, set by the same
cases and the same `notifications.<case>.tab` settings, only on tabs that are not active, cleared when the tab is
opened. It adds no state: there is no "done" state and no "time since Claude finished" (the mockup's green dots and
"done" labels belong to part 2's chat). *(Claude's call, from the builder check: the mockup's extra states would need
main to send more than it sends today, which is part 2's business.)*

- Working: the spinner glyph in the accent, on rows and tabs, in the background too.
- Attention (whatever its reason — a finished turn, a question, a permission, Mark as unread): the tab's title turns
  to the primary text color and a small accent badge beside it breathes (see Motion), instead of today's pulsing
  background.
- Shell tabs: a terminal icon. Exited: struck through and dimmed. Muted, bell, note, unread images: small marks on the
  right, as today.
- At the bottom: **Recent sessions** and **Settings**.
- The side panel toggles move from the column's header to the sheet's header (below); their shortcuts stay.

### Tabs on top (`tabs.position: top`)

- A row of tabs, 42 px, under the title bar, on the app ground.
- Tabs are 32 px pills with an 8 px radius: the state glyph, the title, the tab's marks (unread images, muted, bell,
  note, the attention badge) after the title as today, and the close button; the active tab is raised like the active
  row on the left. Widths stay as today (90–220 px).
- **The tabs are grouped by project here too**, in the same groups and order as the left column (`panelGroups`): a
  group's uppercase label, with the working dot, stands before its tabs, and a thin divider separates groups. When all
  tabs are in one project, or none is in a project, no label shows. A worktree's tab has a 2 px line in its color
  under its title. Groups do not fold here. *(Claude's call, from the mockup; tabs on top are not grouped today.)*
- After the tabs: `+` and `▾` as today. At the far right: a button that moves the tabs to the left, and the
  matching button in the left column moves them back. *(Claude's call: today this is the `.tab-position` button.)*
- With more tabs than fit, the row scrolls sideways as today.

### The sheet and its header

- The active tab's content lies on the sheet: `#111114`, 1 px hairline, radius 12, inset 8 px from the window's edges
  (and from the left column when there is one).
- The header, 52 px: the tab's state glyph, its title (14 px, semibold; double-click renames as the tab does today), a
  chip with the branch (in the worktree's color), the folder in tertiary text, and on the right the toggles: **Changes**
  and **Media** as labelled buttons, Docs and Note as icon buttons, all with tooltips naming their shortcuts. The
  active toggle is raised. Their badges count what they count today (unseen images, unviewed changes), in the accent,
  hidden at 0. *(Claude's call, from the builder check: the mockup's grey "total" badge is dropped.)*
- A shell tab's header shows its title, folder and the toggles that apply to it today.
- Space for part 2's Chat / Terminal switch is left before the toggles.
- While Claude works in the tab, a 2 px line in the accent runs along the header's bottom edge (see Motion).

#### Where the side panel sits

Inside the sheet, as in the mockup: the sheet's header spans the whole sheet, over the terminal and the panel; the
status bar spans its whole width under both; the panel lies between them at the sheet's right, with a hairline on its
left and its own 44 px header at its top (it does not line up with the 52 px header above it; it sits under it). *(Claude's
calls, from the builder check.)*

- The modes stay as they are: beside — main widens the window by the panel's width, exactly as `panel-room.ts` does
  today (the panel is inside the sheet, so there is no extra gap to add); overlay — the panel lies over the
  terminal's right part with its shadow; narrow — the terminal narrows.
- Expanded covers the sheet below its header, the status bar included; the sheet's header (its panel toggles and
  Note), the title bar and the tabs on top stay visible and usable. The note's `--panel-cover` offset keeps working against the panel's new box.

### The terminal

- The terminal sits in the sheet under the header, on `#0E0E10`, with an inset of 12–16 px from the sheet's edges
  (by the host's position, not padding).
- A new theme **Graphite** in `themes.ts`, matching the chrome (background `#0E0E10`, foreground `#D4D4DA`, a softer
  bright white, the palette's green, amber, red, blue and purple for the ANSI colors, the accent for the cursor), is
  the default, for new installs and existing ones alike (the user's decision: everything new is the default). The
  first run writes every default to `settings.json`, so an existing install's `Campbell` cannot be told from a chosen
  one: once, on the first start of this version, a `theme` of exactly `"Campbell"` becomes `"Graphite"` (the edit
  keeps every other key and the key order). A marker file in the data folder records that the switch was made, so
  a user who picks Campbell again afterwards keeps it. Any other theme, a custom theme object, or a settings.json the
  app cannot read is left alone; a fresh install writes the marker too.

### The side panels

- Media, Changes and Docs keep their behavior, sizes, resizing, the beside / overlay / narrow modes and the Changes
  scopes. They get the new language: a 44 px header with the title and its count, icon buttons; content in cards (10 px
  radius) on `#0F0F12`; Media's images on a dark well with the file name, folder, time and a small source chip
  (`show_image`, `created`, …); Changes' file headers as card headers, the scope switch as a segmented control,
  comments in an accent-tinted card, the "Send to Claude" button as the primary button.
- The note keeps its place over the terminal's top right and its behavior; its label and card take the new surfaces.

### The status bar

- Lies along the sheet's bottom, 32 px, inside the sheet. Segments are separated by thin dividers, numbers use
  tabular figures, a segment's bar (context, plan) is a 44 px, 4 px bar.
- It keeps every segment and its behavior except the two limits, which moved to the title bar: account, model with the
  effort as a small pill, context, agents, background tasks, plan (opens the plan list), changes (opens Changes).

### Menus, dialogs and the rest

- Menus and popups: raised surface, 12 px radius, 6 px inner padding, 34 px rows with an icon slot, shortcuts right
  aligned in tertiary text, section labels in the uppercase style, a soft large shadow.
- Recent sessions, the search box, the plan list, banners (restore, update, what's new), toasts and the lightbox take
  the same surfaces, inputs and buttons. Buttons: primary (accent background, dark text), secondary (raised, hairline),
  ghost (text only until hover).
- The Settings window takes the same palette, type and controls, with its own title bar like the main window's.

### Motion

Motion says what Claude is doing and confirms what the user did; it never decorates an idle screen.

- **Claude works in a tab**: its glyph runs through Claude Code's spinner glyphs (as today); its group's dot pulses (as
  today); the line under the sheet's header runs (a short gradient of the accent sweeping across, about 1.8 s per pass).
- **Claude waits for the user** (attention): the tab's badge breathes, a soft ring growing and fading every 2 s, until
  the tab is opened, as long as today's pulse runs. *(Replaces today's pulsing background; the ring is a small
  compositor-only animation.)*
- **A count goes up** (unread images, changed files): the badge pops once (scale 0.8 → 1, 200 ms).
- **Panels** slide in from their edge (transform, 180–220 ms, ease-out); **menus and popups** fade and scale in from
  98% (120–160 ms); **toasts** slide up; **dialogs** fade in with their backdrop.
- **Values that change** (bars in the status bar and the title bar meters) glide to their new width (transition 300–600
  ms).
- Rules for all of it:
  - Only `transform` and `opacity` animate (and `width` of the small bars, which lie outside the terminal's layout).
  - An animation never delays an action: a panel's content is usable from the first frame; a terminal is refitted
    once, when the panel has its final size, never per frame.
  - What lies inside a tab's content (the sweep line, a panel's motion) runs only for the active tab; the glyphs and
    badges of other tabs in the tab bar or column keep running, because they are what tells the user that Claude
    works or waits elsewhere. Nothing runs while the window is hidden or minimized.
  - `prefers-reduced-motion: reduce` turns all of it off, leaving the static states (a static glyph, a static tinted
    badge, no sweep).

## Performance

Required in every part, measured on the CI machines' class of hardware and on the user's machine:

- **Idle is free**: with no tab working, none waiting for the user and the window still, the renderer does no style
  recalculation or painting over time (DevTools Performance: no recurring frames), and no timer ticks — nothing in the
  new design counts down. While tabs work or wait, the only recurring work is their small compositor animations.
- **No regressions** against the current release, measured the same way before and after:
  - the time from launch to the first painted window and to the first tab's prompt;
  - switching between two tabs (to the new tab painted);
  - opening and closing the side panel;
  - typing echo in a shell tab under load (Claude working in another tab).
- **Smooth**: animations hold 60 fps on a 4K display on the CI runners' hardware class; no long task over 50 ms comes
  from the redesign.
- **Cheap CSS**: no `backdrop-filter` on large areas (the note's small blur may stay), no box-shadow animations on large
  elements, `will-change` only on what animates, at the time it animates.
- **Fonts** load from the app's files with `font-display: block` for at most a frame-short moment and are preloaded,
  so the interface does not reflow after start.

*(Claude's call: the builder writes a small timing harness for the four measurements, runs it on master and on the
branch, and puts the numbers in the pull request; exact thresholds beyond "not slower" are not set.)*

## Testing

- Unit: the tab grouping on top (reusing `panelGroups`), the limit meters' model (moved from the status bar segments:
  values, levels and colors, the elapsed mark, the reset as a clock time, pace off, hidden when there are no limits),
  the Graphite theme's presence and the default for new settings.
- E2E (through the window):
  - the title bar: the meters show the active tab's limits and hide for a shell tab; the search field opens Recent
    sessions; the window can be maximized by double-clicking the bar (where the platform allows testing it);
  - the panel toggles in the sheet's header open and close each panel, show their counts, keep their shortcuts, for
    both tab positions;
  - tabs on top are grouped by project with labels, and show no label with one project;
  - the attention state (its badge on rows and tabs, cleared on opening) and the working state (the glyph, and the
    sweep line present while working and gone after), in both tab positions;
  - the side panel inside the sheet: beside, overlay, narrow and expanded, the window widening exactly as today;
  - the limit meters with `claude.limitPace` on and off;
  - with reduced motion emulated, no animation runs;
  - the status bar no longer shows the limits and still shows the other segments;
  - the existing specs pass, updated only where an element moved (ids and classes are kept wherever an element keeps
    its role, so the specs keep finding them).
- `npm run screenshots` regenerates the README images with the new look, from the invented sessions only.

## Left to the builder

- Exact pixel values within the stated ranges, the precise easing curves, the icon set's selection.
- How the title bar is built per platform, within the rules above, and verifying `titleBarOverlay` on Linux.
  CI covers the three systems under test, but not a real desktop (Linux runs under xvfb); the plan ends with a short
  hand-off list for the user to check by eye on their Mac and, if they have one, a Linux desktop: dragging, double-click,
  the window buttons, the traffic lights, full screen. *(Claude's call.)*
- Whether `colors.css` becomes the single token file for both windows or the Settings window imports it.
- The order of the work. *(Claude's suggestion: tokens and fonts; title bar and window; the sheet and its header with
  the toggles; tabs on the left; tabs on top; panels; status bar; menus and dialogs; Settings window; motion;
  performance pass; screenshots.)*
