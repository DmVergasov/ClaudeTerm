# Redesign, part 1: the new look — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ClaudeTerm's window a premium look — its own title bar with the usage limits, a sheet for the active tab with a header holding the panel toggles, redrawn tabs in both positions, panels, status bar, menus and Settings window, calm motion — without changing any behavior or making anything slower.

**Architecture:** Visual tokens in `colors.css` remap the existing CSS variables, so every rule picks up the new palette at once; the page gains `#titlebar`, `#sheet` and `#sheet-header`; the panel toggles move from the two tab bars into one `SheetHeader`; the usage limits move from the status bar into a `TitleBar` fed by a pure `limitMeters()`. Main gives both windows a hidden native title bar through one pure `chromeOptions()`. Motion is CSS only (transform and opacity), off under reduced motion.

**Tech Stack:** Electron 44, TypeScript (strict), plain DOM in the renderer, xterm.js, Vitest (unit, node environment), Playwright (e2e), `@fontsource-variable/inter`.

**Spec:** `docs/superpowers/specs/2026-11-10-redesign-look-design.md` — read it before every task; the plan argues from it.

## Global Constraints

- Work on the branch `feat/redesign-look`, made from `origin/master` (0.17.0), in the worktree `.claude/worktrees/feat-redesign-look`. Bring `origin/master` in once, at the end, not between tasks.
- **Never commit.** Each task ends by leaving its changes uncommitted and reporting "ready to commit" with the message given (the user's global rule). Subagents are told the same.
- No UI framework in the renderer; the renderer reaches the system only through `window.ct`; the CSP of `index.html` and `settings.html` stays as it is (fonts are bundled files).
- Comments, logs and UI strings in English. Keep each file's line endings. Match the surrounding code's style and comment density.
- `.terminal-host` never gets padding (the FitAddon measures it); insets come from its position.
- Palette, exactly: ground `#0A0A0C`, sheet `#111114`, terminal `#0E0E10`, raised `#16161A` / `#1E1E23`, hairlines `#1C1C21` / `#2A2A31`, text `#EDEDF0` / `#B5B5BE` / `#8C8C96`, accent `#D97757`, green `#63C08F`, amber `#E5B567`, red `#F2867E`, blue `#7FA7F5`, purple `#A78BFA`. No text darker than `#8C8C96` on these surfaces.
- Type: `'Inter Variable', 'Segoe UI', system-ui, sans-serif`, 13 px base, 12 px secondary, 10.5 px uppercase labels with `letter-spacing: 0.08em`, `font-variant-numeric: tabular-nums` for changing numbers. The terminal keeps the `font` setting.
- Radii: sheet 12 px, cards/menus/rows 8–10 px, chips/small buttons 6 px. Controls 28–34 px high. Title bar 44 px, top tab row 42 px, sheet header 52 px, panel header 44 px, status bar 32 px.
- Motion animates only `transform` and `opacity` (and the `width` of the small bars in the title bar and status bar); nothing delays an action; `@media (prefers-reduced-motion: reduce)` turns every animation off and leaves static states.
- Keep every existing id and class where the element keeps its role (`#tabbar`, `#tabpanel`, `#statusbar`, `.tab`, `.tp-tab`, `.tab-icon`, `.tab-title`, `.tab-new`, `.tab-menu`, `.tab-position`, `.tab-*-toggle`, `.badge`, `.status-*`, `.menu`, `.menu-item`, …); e2e specs change only where an element moved or its look is what they assert.
- Every changed behavior gets a test through its entry point (AGENTS.md); e2e tests start the app with `launchApp` / `launchClaudeTab` from `tests/e2e/helpers.ts`; nothing touches the real `~/.claude` or the real data folder; README images only from invented sessions.
- Done means `npm run typecheck`, `npm test` and the affected e2e specs green locally; the whole `npm run test:e2e` before the final task. `review.spec` and `tab-panel.spec:311` are known to flake under load: rerun them alone, and on clean `master`, before blaming a change.

## Review Focus

1. **A light terminal theme inside the dark sheet.** With `One Half Light`, the area around the terminal must be the terminal's own background, not a dark frame. → Task 4, step "light theme surround".
2. **Long titles at the minimum window width.** A long tab title, branch and folder must ellipsize in the sheet header; the toggles stay visible inside the header. → Task 4, step "long title".
3. **Tab order on top before git has answered.** Grouping on top must not write a temporary order to main while a tab's place is unknown, nor move the tabs about once it is known beyond the grouping itself. → Task 6, step "order waits for places".
4. **The panel toggled quickly, during its slide.** Open, close and open again within 100 ms ends with the panel shown and the terminal at the size it settles to, with no extra resizes left behind. → Task 7, step "rapid toggle".
5. **Many tabs on top.** With more tabs than fit, the row scrolls sideways and the active tab is brought into view, group labels included. → Task 6, step "overflow".

## The base this plan runs on

The plan was drafted against 0.14; the branch starts from `origin/master` at 0.17.0, which adds three things every task must keep working and restyle:

- **Other devices' tabs** (device sync, part 2). `TabBarItem` has `group` (the device id, `null` for this device's own tab), `deviceName` and `dim`; `TabBarGroup` describes a device. On top, after this device's tabs, each device shows as a chip `.tab-group-chip` (colored `--group-color`, foldable) followed by its tabs (`.tab.remote`, `.dim` when offline). On the left, each device is a section `.tp-section` with a header `.tp-device` (`.tp-device-bar`, `.tp-device-name`, `+` `.tp-device-new`, folded count and marks) and its tabs grouped by project (`deviceGroups`). `TabBarCallbacks.reorder(ids, group)` takes the group; `toggleGroup` and `groupMenu` exist.
- **Agent messages**: a fourth side panel `'messages'` (`mail-panel.ts`, label `Agent messages`) with its toggle `.tab-messages-toggle` and a badge of unread messages; tabs show an envelope mark `.tab-mail` (`mailMark()` in `tab-row.ts`).
- **A folder dialog** `#folder-dialog` (`folder-dialog.ts`) and a **Devices** section in Settings.

Line numbers in the tasks below may have moved; find the code by the function and class names given.

---

### Task 1: Visual foundations — tokens, Inter, icons, the Graphite theme

**Files:**
- Modify: `src/renderer/colors.css`, `src/renderer/styles.css` (the `html, body` rule's font), `src/renderer/settings.css` (body font, tokens), `src/renderer/main.ts` (first import), `src/renderer/settings-page.ts` (font import), `src/renderer/themes.ts`, `src/main/settings.ts` (`DEFAULT_SETTINGS.theme`), `src/main/index.ts` (the main window's `backgroundColor`), `package.json` (devDependency)
- Create: `src/renderer/icons.ts`
- Test: `tests/unit/icons.test.ts` (create), `tests/unit/themes.test.ts` (create), `tests/unit/settings.test.ts`, `tests/unit/settings-form.test.ts`, `tests/e2e/font.spec.ts`

**Interfaces:**
- Produces: CSS variables `--ground --sheet --term --raised --raised-2 --line --line-2 --text --text-2 --text-3 --accent --green --amber --red --blue --purple`, and the old names remapped: `--bg: var(--term)`, `--chrome: var(--sheet)`, `--chrome-2: var(--raised)`, `--fg: var(--text)`, `--muted: var(--text-3)`, `--border: var(--line-2)`.
- Produces: `export type IconName = 'search' | 'plus' | 'chevron-down' | 'chevron-right' | 'branch' | 'terminal' | 'image' | 'file-diff' | 'file-text' | 'note' | 'mail' | 'history' | 'settings' | 'panel-left' | 'panel-top' | 'x'` and `export function icon(name: IconName, size?: number): string` in `src/renderer/icons.ts` (default size 16).
- Produces: `THEMES.Graphite` in `themes.ts`; the settings default `theme: 'Graphite'`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/icons.test.ts`:
```ts
it('draws every icon as a thin stroke SVG of the size asked, hidden from screen readers', () => {
  for (const name of ICON_NAMES) {
    const svg = icon(name, 14)
    expect(svg).toMatch(/^<svg [^>]*width="14" height="14" viewBox="0 0 24 24"/)
    expect(svg).toContain('stroke-width="1.75"')
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).not.toContain('<script')
  }
})
it('defaults to 16 px', () => expect(icon('plus')).toContain('width="16"'))
```
(`ICON_NAMES: readonly IconName[]` is exported next to `icon`.)

`tests/unit/themes.test.ts`:
```ts
it('Graphite matches the window chrome', () => {
  const t = resolveTheme('Graphite')
  expect(t.background).toBe('#0E0E10')
  expect(t.foreground).toBe('#D4D4DA')
  expect(t.cursor).toBe('#D97757')
  expect(t.brightBlack).toBe('#85858F')
})
it('an unknown name still falls back to Campbell', () => expect(resolveTheme('Nope').background).toBe('#0C0C0C'))
```
In `tests/unit/settings.test.ts`, the defaults test expects `theme: 'Graphite'`, and a file that names `"theme": "Campbell"` keeps it. In `tests/unit/settings-form.test.ts`, the theme options list `['Campbell', 'One Half Dark', 'One Half Light', 'Graphite']` in `THEMES` order (put Graphite where `Object.keys(THEMES)` gives it; assert that order).

`tests/e2e/font.spec.ts`, new test `the interface is set in the bundled Inter and a new install's terminal uses Graphite`:
```ts
const { app, page } = await launchApp()
expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"Inter Variable"/)
expect(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('13px "Inter Variable"') })).toBe(true)
expect(await page.evaluate(() => window.__ct!.themeBackground())).toBe('#0E0E10')
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/icons.test.ts tests/unit/themes.test.ts tests/unit/settings.test.ts tests/unit/settings-form.test.ts`
Expected: FAIL (no `icons.ts`, no Graphite, default Campbell).

- [ ] **Step 3: Implement**

- `npm i -D @fontsource-variable/inter`; `import '@fontsource-variable/inter'` first in `main.ts` and `settings-page.ts`; body font in `styles.css` and `settings.css` as in Global Constraints. Both pages `await document.fonts.load('13px "Inter Variable"')` at the start of their boot, before building any element, so nothing reflows when the font arrives (it is a local file: the wait is a frame or two; Task 12 measures it).
- `colors.css`: the tokens and remaps above; `body { background: var(--ground) }` in `styles.css`.
- `icons.ts`: Lucide shapes (ISC license — a header comment says so and names lucide.dev), `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"`. Explicit closing tags.
- `themes.ts`: `Graphite` = background `#0E0E10`, foreground `#D4D4DA`, cursor `#D97757`, cursorAccent `#0E0E10`, selectionBackground `#FFFFFF30`, black `#1B1B1F`, red `#F2867E`, green `#63C08F`, yellow `#E5B567`, blue `#7FA7F5`, magenta `#A78BFA`, cyan `#6CC5D1`, white `#D4D4DA`, brightBlack `#85858F`, brightRed `#F7A39C`, brightGreen `#86D3A8`, brightYellow `#EECB8C`, brightBlue `#A3C0F8`, brightMagenta `#C0AAFC`, brightCyan `#93D7E0`, brightWhite `#EDEDF0`.
- `settings.ts` default `theme: 'Graphite'`; `index.ts` `backgroundColor: '#0A0A0C'`.

- [ ] **Step 4: Run the unit tests and `npx playwright test tests/e2e/font.spec.ts` (after `npm run build`)**

Expected: PASS. Then `npm run typecheck` and `npm test`: PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: the window's palette, the Inter font, a set of stroke icons and the Graphite terminal theme`

---

### Task 2: The window's own title bar (main) and the bare bar in the page

**Files:**
- Create: `src/main/window-chrome.ts`, `src/renderer/title-bar.ts`
- Modify: `src/main/index.ts` (the main window's `new BrowserWindow` and its `enter-full-screen` / `leave-full-screen` handlers), `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/env.d.ts` (the `ct` type), `src/renderer/index.html`, `src/renderer/main.ts` (boot), `src/renderer/styles.css`
- Test: `tests/unit/window-chrome.test.ts` (create), `tests/e2e/titlebar.spec.ts` (create)

**Interfaces:**
- Produces: `export const TITLE_BAR_HEIGHT = 44`, `export const SETTINGS_TITLE_BAR_HEIGHT = 36` and `export function chromeOptions(platform: NodeJS.Platform, height?: number): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'>` in `src/main/window-chrome.ts`.
- Produces: IPC channel `IPC.fullScreen` (`'window:full-screen'`), main → renderer, payload `boolean`; preload `onFullScreen(cb: (on: boolean) => void): void`.
- Produces: `export class TitleBar { constructor(root: HTMLElement, platform: string, cb: { openRecent(): void }) }` — in this task it draws only the mark, the name, an empty `.tb-center` and an empty `.tb-meters`; Task 3 adds the search button and `render(meters)`.
- Produces: `<body>` classes `platform-win32|darwin|linux` and `fullscreen`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/window-chrome.test.ts`:
```ts
it('Windows and Linux hide the title bar and keep the system buttons, drawn in the window colors', () => {
  for (const p of ['win32', 'linux'] as const) expect(chromeOptions(p)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#0A0A0C', symbolColor: '#B5B5BE', height: 44 } })
})
it('macOS insets the traffic lights in the bar', () => {
  expect(chromeOptions('darwin')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } })
})
it('the settings window gets a lower bar', () => expect(chromeOptions('win32', 36).titleBarOverlay).toEqual({ color: '#0A0A0C', symbolColor: '#B5B5BE', height: 36 }))
```
(macOS `y` for a 36 px bar is `11`; assert it too.)

`tests/e2e/titlebar.spec.ts`, test `the title bar drags the window and its controls do not`:
```ts
const { app, page } = await launchApp()
const region = (sel: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).getPropertyValue('-webkit-app-region'), sel)
expect(await region('#titlebar')).toBe('drag')
await expect(page.locator('#titlebar .tb-name')).toHaveText('ClaudeTerm')
const box = (await page.locator('#titlebar').boundingBox())!
expect(Math.round(box.height)).toBe(44)
expect(box.y).toBe(0)
```
and, skipped unless `process.platform === 'darwin'`, `full screen drops the traffic lights' gap`: `app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true))` → `page.locator('body')` gets class `fullscreen`; back → loses it.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/window-chrome.test.ts` → FAIL (no module). E2E after build → FAIL (no `#titlebar`).

- [ ] **Step 3: Implement**

- `chromeOptions`: as the tests say; `trafficLightPosition.y = Math.round((height - 16) / 2)`.
- `index.ts` spreads `chromeOptions(process.platform)` into the main window's options; on `enter-full-screen` / `leave-full-screen` (next to the existing handlers) and once on `ready-to-show` it sends `IPC.fullScreen` with `win.isFullScreen()`. The settings window keeps its system frame until Task 10.
- `index.html`: `<div id="titlebar"></div>` first in `#app`.
- `TitleBar` builds `.tb-mark` (20 px square, accent, `>_` in a monospace font, dark text), `.tb-name`, a flexible `.tb-center` and `.tb-meters`. `#titlebar { height: 44px; -webkit-app-region: drag; }`, every `button` in it `-webkit-app-region: no-drag`. Right padding leaves room for the window buttons: `padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))`; on `body.platform-darwin:not(.fullscreen)` the left padding is 84 px.
- `boot()` adds the body classes, creates the `TitleBar`, and subscribes `ct.onFullScreen`.

- [ ] **Step 4: Run tests**

`npx vitest run tests/unit/window-chrome.test.ts`, then `npm run build && npx playwright test tests/e2e/titlebar.spec.ts tests/e2e/layout.spec.ts tests/e2e/smoke.spec.ts` → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: the window draws its own title bar, with the system's window buttons kept`

---

### Task 3: The usage limits move to the title bar; the search of past sessions

**Files:**
- Create: `src/renderer/limit-meters.ts`
- Modify: `src/renderer/status-bar.ts` (drop `limitSegment`, the `limit`/`week` keys; export `duration`, `dayAndTime`, `hoursAndMinutes`), `src/renderer/title-bar.ts`, `src/renderer/keymap.ts` (LABELS), `src/renderer/main.ts` (`renderStatus`, tab close), `src/renderer/settings-page.ts:240`, `src/renderer/styles.css`
- Test: `tests/unit/limit-meters.test.ts` (create), `tests/unit/status-bar.test.ts`, `tests/unit/keymap.test.ts`, `tests/e2e/status.spec.ts`, `tests/e2e/settings.spec.ts:203-230`, `tests/e2e/titlebar.spec.ts`

**Interfaces:**
- Consumes: `limitPace`, `levelFor`, `Level` from `status-bar.ts`; `TitleBar` from Task 2.
- Produces in `src/renderer/limit-meters.ts`:
```ts
export interface LimitMeter {
  key: 'limit' | 'week'
  label: '5-HOUR' | 'WEEKLY'
  /** '24%' */
  pct: string
  /** the reset as a clock: '18:40' today, 'Thu 09:00' on another day */
  reset: string
  /** today's segment tooltip, unchanged: 'resets at 18:40, in 1 h' plus the pace line */
  title: string
  level: Level
  /** null with claude.limitPace off */
  bar: { used: number; elapsed: number } | null
}
export function resetClock(resetMs: number, now: number): string
export function limitMeters(u: StatusUpdate | null, now: number, paced: boolean): LimitMeter[]
```
- Produces: `TitleBar.render(meters: LimitMeter[]): void` draws, per meter, `.meter.meter-<key>` (plus `warn`/`crit`) with `.meter-label`, `.meter-pct`, `.meter-reset` and, when `bar` is set, `.meter-bar` with `--used` and `--elapsed`; `.tb-meters` is hidden when `meters` is empty; it updates the same elements in place (a tooltip under the mouse must survive a statusLine refresh, as in `StatusBar.render`). The search button `.tb-search`: icon `search`, text `Search past sessions`, and `shortcutLabel('recentSessions', platform)`; a click calls `cb.openRecent()`.
- Produces: `LABELS.recentSessions` in `keymap.ts`, matching the keys `mapKey` and `mapMacKey` map to `recentSessions` (the `case 'KeyH'` lines).

- [ ] **Step 1: Write the failing tests**

`tests/unit/limit-meters.test.ts` — move the limit cases out of `status-bar.test.ts` (`a limit that runs out before its reset…`, `with the pace turned off…`, the levels while the pace is not known) and assert them on `limitMeters`, keeping their exact titles. New cases:
```ts
it('names the reset by its clock time today, and by weekday and time on another day', () => {
  const now = new Date(2026, 10, 10, 15, 0).getTime()
  expect(resetClock(new Date(2026, 10, 10, 18, 40).getTime(), now)).toBe('18:40')
  expect(resetClock(new Date(2026, 10, 12, 9, 0).getTime(), now)).toBe('Thu 09:00')
})
it('a reset already past still shows its clock', () => …toBe('14:00'))
it('gives the 5-hour and weekly meters in that order, with a bar of the % used and the share of the window gone by', () => {
  const [five, week] = limitMeters(update({ fiveHour: { usedPct: 23.5, resetsAt: now / 1000 + 3600 * 4 }, sevenDay: { usedPct: 41.2, resetsAt: … } }), now, true)
  expect(five).toMatchObject({ key: 'limit', label: '5-HOUR', pct: '24%', level: 'normal', bar: { used: 24, elapsed: 20 } })
  expect(week).toMatchObject({ key: 'week', label: 'WEEKLY', pct: '41%' })
})
it('with the pace off a meter has no bar, and its level comes from the fixed 70% and 90%', …bar null, level 'warn' at 75%)
it('a used-up limit is crit and its title says so', …)
it('no status, or a status without limits, gives no meters', () => { expect(limitMeters(null, now, true)).toEqual([]) })
```
In `keymap.test.ts`, `shortcutLabel('recentSessions', 'win32')` and `(…, 'darwin')` give the labels of the keys `mapKey` / `mapMacKey` turn into `recentSessions` (read them from their `case 'KeyH'` lines). In `status-bar.test.ts`, `formats all five segments` becomes the segments without limits (model, context, agents, background) and no segment has key `limit` or `week`.

`tests/e2e/status.spec.ts`: the first test asserts `page.locator('#titlebar .meter-limit .meter-pct')` → `24%`, `.meter-week .meter-pct` → `41%`, `#statusbar .status-limit` count 0; the pace test reads `#titlebar .meter-limit` (class `crit`, the title regexes unchanged) and its `.meter-bar` style vars (`['50%', '20%']`, then `['50%', '80%']`). `settings.spec.ts` limit pace test: the locator becomes `#titlebar .meter-limit`, "no bar" becomes `.meter-bar` count 0, and the label it finds is the new one.

`tests/e2e/titlebar.spec.ts`, new tests:
- `the limits show for a Claude tab and hide for a shell tab`: status message → `.tb-meters` visible; open a shell tab → hidden; back → visible.
- `the search field opens Recent sessions`: click `#titlebar .tb-search` → `#sessions` visible.

- [ ] **Step 2: Run them and see them fail**

`npx vitest run tests/unit/limit-meters.test.ts tests/unit/status-bar.test.ts` → FAIL.

- [ ] **Step 3: Implement**

- `limitMeters` builds today's tooltip lines exactly as `limitSegment` did (5-hour: `at HH:MM`; weekly: `dayAndTime`), the pace from `limitPace` when `paced`, else `levelFor`. `resetClock`: `HH:MM` when the reset falls on the same local day as `now`, else `WEEKDAYS[day] HH:MM`.
- `main.ts`: `renderStatus(tabId)` also calls `titleBar.render(limitMeters(statusUpdates.get(tabId) ?? null, Date.now(), settings.claude.limitPace))`; where `statusBar.render(null)` runs on closing the active tab, `titleBar.render([])` runs too; `TitleBar`'s `openRecent` is `() => void sessionsWindow.open()`.
- Settings label: `Show in the title bar how fast the usage limits are spent: a bar, and a color from the pace`.
- CSS: a meter is 132 px wide, two lines (label 10 px uppercase, `%` semibold, reset right-aligned in `--text-3`), a 4 px bar under them: the used part `var(--accent)` for `limit`, `var(--blue)` for `week`, `var(--amber)` / `var(--red)` with `.warn` / `.crit` (the `%` text takes the level color too); the elapsed mark a 2 px × 8 px `var(--text)` line at `--elapsed`. The used part's width transitions over 600 ms.

- [ ] **Step 4: Run tests**

`npm test`; `npm run build && npx playwright test tests/e2e/status.spec.ts tests/e2e/settings.spec.ts tests/e2e/titlebar.spec.ts` → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: the usage limits move to the title bar, which also searches past sessions`

---

### Task 4: The sheet, its header and the panel toggles in it

**Files:**
- Create: `src/renderer/sheet-header.ts`
- Modify: `src/renderer/index.html`, `src/renderer/tab-header.ts` (toggles move out), `src/renderer/tabbar.ts` and `src/renderer/tab-panel.ts` (drop `setChanges/setDocs/setImages/setNote`), `src/renderer/tab-row.ts` (export `tabIcon`), `src/renderer/side-panel.ts:191-206` (expanded), `src/renderer/main.ts` (`refreshPanelButtons`, `renderTabs`, `applySettings`, boot), `src/renderer/styles.css`
- Test: `tests/e2e/sheet.spec.ts` (create), the expanded-panel test in `tests/e2e/side-panel.spec.ts`, and the selector updates in every spec or helper that finds a toggle under `#tabbar`, `#tabpanel` or `.tp-head` (`grep -rlE "tab-(images|changes|docs|note|messages)-toggle" tests/e2e`: today `agent-mail.ts`, `agent-messages.spec.ts`, `change-folder.spec.ts`, `docs.spec.ts`, `image-button.spec.ts`, `note-overlay.spec.ts`, `remote-tabs.spec.ts`, `review.spec.ts`, `tab-panel.spec.ts`)

**Interfaces:**
- Consumes: `TabBarItem`, `TabBarCallbacks`, `beginRename`, `shownActivity` (existing), `icon` (Task 1).
- Produces: `export function tabIcon(item: TabBarItem): HTMLElement` in `tab-row.ts` (spinner while `shownActivity(item)`, `✳` for a Claude tab, `icon('terminal', 13)` for a shell tab; class `tab-icon`); `tabParts` uses it.
- Produces in `src/renderer/sheet-header.ts`:
```ts
export type SheetHeaderCallbacks = Pick<TabBarCallbacks, 'rename' | 'toggleImages' | 'toggleChanges' | 'toggleDocs' | 'toggleMessages' | 'toggleNote'>
export class SheetHeader {
  constructor(root: HTMLElement, cb: SheetHeaderCallbacks, platform: string)
  /** the active tab; null: no tab. `deviceColor`: the color of a remote tab's device (the tab bar's `--group-color`) */
  render(item: TabBarItem | null, deviceColor?: string): void
  setChanges(available: boolean, visible: boolean, unviewed: number): void
  setDocs(available: boolean, visible: boolean): void
  setImages(visible: boolean, unseen: number): void
  setMessages(available: boolean, visible: boolean, unread: number): void
  setNote(available: boolean, visible: boolean): void
}
```
DOM: `.sh-icon` (from `tabIcon`), `.sh-title` (double-click renames with `beginRename`), for a remote tab `.sh-device` (a chip with the device's name, its color from `deviceColor`, dimmed when `item.dim`), `.sh-branch` (icon `branch` + branch; `color` the worktree's `WORKTREE_COLORS` entry), `.sh-folder`, a flexible spacer, an empty `.sh-modes` (part 2's switch), then the toggles with today's classes and tooltips — `.tab-changes-toggle` and `.tab-images-toggle` labelled `Changes` / `Media` with their `.badge`, `.tab-messages-toggle` (icon `mail`, its `.badge` of unread messages, tooltip `Agent messages`), `.tab-docs-toggle` and `.tab-note-toggle` icon-only — and `.sh-sweep` at the bottom edge. The root gets class `working` while `shownActivity(item) === 'working'`.
- Produces: `TabHeader` keeps only `plus`, `more`, `position`; `TabBar` and `TabPanel` lose `setChanges`, `setDocs`, `setImages`, `setMessages` and `setNote`.
- Produces: page structure `#app > #titlebar, #tabbar, #banner, #update-banner, #main-row > (#tabpanel, #sheet > (#sheet-header, #workspace > (#terminals, #image-panel), #statusbar))`.
- Produces: CSS variable `--term-bg` on `:root`, set by `main.ts` from `resolveTheme(settings.theme).background` at boot and on a theme change; `#terminals { background: var(--term-bg) }`.

- [ ] **Step 1: Write the failing tests** — `tests/e2e/sheet.spec.ts`:

- `the panel toggles sit in the sheet's header, in both tab positions, and open their panels`: for `tabs.position` `top` and `left` (settings), click `#sheet-header .tab-images-toggle` → `#image-panel` not `.collapsed`, the toggle `.active`; `#tabbar .tab-images-toggle`, `#tabpanel .tab-images-toggle` and `#tabpanel .tab-messages-toggle` count 0; `#sheet-header .tab-messages-toggle` is visible while `agentMessages.enabled` is on.
- `the header names the active tab and its branch, in the worktree's color`: `gitRepo()` + `gitWorktree(repo, 'feat/x')`, open a tab there → `#sheet-header .sh-title` has the tab's title, `.sh-branch` text `feat/x` and its color equals the row's worktree color.
- `double-clicking the header's title renames the tab`: dblclick `.sh-title`, type `report`, Enter → `__ct.tabTitle(id)` is `report`.
- `the line under the header runs while Claude works in the tab and stops when the turn ends`: `turn` pipe message (as `activity.spec.ts:42`) → `#sheet-header` has class `working` and `.sh-sweep` is visible; `attention`/`done` → neither.
- **Light theme surround** (Review Focus 1): settings `theme: 'One Half Light'` → `getComputedStyle(#terminals).backgroundColor` is `rgb(250, 250, 250)`.
- **Long title** (Review Focus 2): rename the tab to 200 characters, shrink the window to its minimum width (`BrowserWindow.getAllWindows()[0].setSize(200, 500)` via `app.evaluate`; the window clamps to its `minWidth`) → every toggle's bounding box lies inside `#sheet-header`'s, and `.sh-title`'s `scrollWidth > clientWidth`.

`side-panel.spec.ts:153`: `the expanded Changes panel covers the sheet, not the title bar or the tabs, and the terminal keeps its size` — the panel's box equals `#sheet`'s box (±1 px) and its top is below `#titlebar`'s bottom; the terminal's size assertions stay.

Update the toggle selectors in the specs listed under Files to `#sheet-header .tab-…-toggle`.

- [ ] **Step 2: Run `npm run build && npx playwright test tests/e2e/sheet.spec.ts` and see it fail** (no `#sheet-header`).

- [ ] **Step 3: Implement**

- `index.html` per the structure above. `refreshPanelButtons` sets the five states on `sheetHeader` only; `renderTabs` calls `sheetHeader.render(active item ?? null, color of its device when remote)` (the same `deviceColor(id)` `renderTabs` gives the groups).
- `SidePanel.apply()`: expanded width is `this.root.closest('#sheet')!.clientWidth`; CSS makes `#sheet` the panel's containing block while expanded (`#sheet { position: relative }`, `#workspace:has(> #image-panel.expanded) { position: static }`, `#image-panel.expanded { top: 0; bottom: 0; z-index: 20 }`). Beside / overlay / narrow keep today's arithmetic (the panel lies inside `#workspace` as before).
- CSS: `#main-row` on `--ground`; `#sheet` `--sheet`, 1 px `--line` border, radius 12, `margin: 0 8px 8px` (8 px left only with tabs on top; with the left column its own edge is the gap), `overflow: hidden`, column flex; `#sheet-header` 52 px; `.sh-sweep` a 2 px strip, hidden unless the header is `.working`, holding a 24%-wide gradient of the accent that runs the keyframes `sheet-sweep` (translateX(-100%) → translateX(420%), 1.8 s, infinite); `.terminal-host { inset: 12px 8px 8px 16px }`; titles, branch and folder ellipsize, the toggles never shrink.

- [ ] **Step 4: Run** `npm run typecheck`, `npm test`, `npm run build && npx playwright test tests/e2e/sheet.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/images.spec.ts tests/e2e/image-button.spec.ts tests/e2e/docs.spec.ts tests/e2e/note-overlay.spec.ts tests/e2e/notes.spec.ts tests/e2e/layout.spec.ts tests/e2e/tab-panel.spec.ts`, then `tests/e2e/review.spec.ts` alone → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: the active tab sits on a sheet whose header names it and holds the panel toggles`

---

### Task 5: Tabs on the left, and the attention badge everywhere

**Files:**
- Modify: `src/renderer/tabbar.ts` (`TabBarCallbacks`), `src/renderer/tab-header.ts`, `src/renderer/tab-panel.ts`, `src/renderer/tab-row.ts`, `src/renderer/main.ts` (callbacks), `src/renderer/styles.css`
- Test: `tests/e2e/tab-panel.spec.ts`, `tests/e2e/attention.spec.ts:19-62`, `tests/e2e/activity.spec.ts` (only if a selector moved)

**Interfaces:**
- Consumes: `tabIcon` (Task 4), `icon` (Task 1).
- Produces: `TabBarCallbacks` gains `openRecent(): void` and `openSettings(): void` (main: `sessionsWindow.open()`, `ct.openSettingsWindow()`).
- Produces: `TabHeader` built with `where === 'left'` makes `plus` a wide button `.tab-new.tp-new` with `icon('plus', 15)`, the text `New tab` and the shortcut label; on top it stays an icon button `.tab-new`. Both still call `cb.newTab()` (a tab of the default profile, as today).
- Produces: the left panel's parts `.tp-head` (`plus`, `more`), `.tp-list`, `.tp-foot` with `.tp-recent` (icon `history`, `Recent sessions`), `.tp-settings` (icon `settings`, `Settings`) and `position`.
- Produces: in `tabParts`, an attention badge `.tab-attn` as the first mark when `item.attention`, carrying `--pulse-delay` from `pulseDelay()`; `PULSE_CYCLE_MS = 2000`; the images mark `.tab-images` is `icon('image', 12)` and the count (no emoji). Rows and tabs no longer set `style.animationDelay`.

- [ ] **Step 1: Write the failing tests**

`attention.spec.ts`, first test: after the attention message, the tab has class `attention`, it holds `.tab-attn`, and
```ts
expect(await page.evaluate((id) => getComputedStyle(document.querySelector(`[data-tab-id="${id}"] .tab-attn`)!, '::after').animationName, tabId)).toBe('tab-breathe')
expect(await page.evaluate((id) => getComputedStyle(document.querySelector(`[data-tab-id="${id}"]`)!).animationName, tabId)).toBe('none')
```
the phase test finds the animation named `tab-breathe` and uses a 2000 ms cycle.

`tab-panel.spec.ts`, new tests (settings `tabs.position: 'left'`):
- `the column's New tab button opens a tab of the default profile`: `#tabpanel .tp-new` has text starting `New tab`; click → `__ct.tabIds().length` grows by one.
- `the column's footer opens Recent sessions and Settings`: `.tp-recent` → `#sessions` visible; `.tp-settings` → a second window opens (`app.windows().length === 2`).
- `the active row is raised, not barred`: the active `.tp-tab`'s computed `box-shadow` contains `inset` and its `background-color` differs from an inactive row's.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement** the interfaces above. Other devices' sections take the same language: `.tp-device` as a group head one step stronger (the device's color as a 3 px rounded bar `.tp-device-bar`, the name in `--text-2` semibold, `+` `.tp-device-new` a 24 px ghost icon button with `icon('plus', 13)`), a remote tab's row like this device's rows, dimmed (`opacity: .55`) while its device is offline. CSS: the column on `--ground`, no right border; rows radius 8, `padding: 7px 10px`, two lines (title 13 px; branch 11.5 px `--text-3`, or the worktree color); the active row `background: var(--raised-2); box-shadow: inset 0 0 0 1px #27272E`; the worktree bar stays 2 px at the left edge; group heads as uppercase labels with the chevron, folded marks as today. `.tab.attention .tab-title, .tp-tab.attention .tab-title { color: var(--text) }`; `.tab-attn` an 8 px accent dot whose `::after` ring runs `tab-breathe` (scale 1 → 2.2, opacity 0.6 → 0, 2 s, `animation-delay: var(--pulse-delay)`); under reduced motion the ring is gone and the dot stays. Remove `tab-attention`.

- [ ] **Step 4: Run** `npm test`, `npm run build && npx playwright test tests/e2e/tab-panel.spec.ts tests/e2e/attention.spec.ts tests/e2e/activity.spec.ts tests/e2e/unread.spec.ts tests/e2e/forks.spec.ts tests/e2e/remote-tabs.spec.ts tests/e2e/agent-messages.spec.ts` → PASS (rerun a flaky test alone, and on the base commit, before blaming the change).

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: the left tab column is redrawn, with a breathing badge for a tab that waits`

---

### Task 6: Tabs on top, grouped by project

**Files:**
- Modify: `src/renderer/tabbar.ts`, `src/renderer/main.ts` (`renderTabs`, `shownOrder`, `visibleOrder`), `src/renderer/styles.css`
- Test: `tests/unit/tab-groups.test.ts`, `tests/e2e/tabs.spec.ts`, `tests/e2e/remote-tabs.spec.ts` (must stay green)

**Interfaces:**
- Consumes: `panelGroups`, `panelOrder`, `groupLabels`, `moveTab`, `orderToWrite` from `tab-groups.ts`.
- Grouping by project applies to **this device's own tabs** (`item.group === null`). Other devices' chips and tabs stay as today, after them: chip, then its tabs (none when folded), dragged within their device as today (`reorder(ids, deviceId)`).
- Produces: `TabBar.visualOrder: string[]` (getter: `panelOrder(panelGroups(own items))`, this device's tabs only, like `TabPanel.visualOrder`); `export const showsGroupLabels = (groups: PanelGroup[]): boolean => groups.length > 1` in `tab-groups.ts`.
- Produces: the row's DOM: per own group, when `showsGroupLabels`, `.tb-group-label` (the label from `groupLabels`, and `.tb-group-dot` pulsing while one of its tabs `shownActivity`), its `.tab`s, then `.tb-group-sep` before the next group; then today's device chips and remote tabs, a `.tb-group-sep` before the first chip. A worktree tab has `.tab-wtline` in its worktree color. After everything: `plus`, `more`, a spacer, `position`. A drop of an own tab on an own tab uses `moveTab(panelGroups(own), from, target)` and calls `reorder(order, null)`; a drop across own and remote tabs moves nothing (as today across devices).
- Produces: `main.ts` writes this device's visual order to main through `orderToWrite` in both positions (as it does on the left today); `shownOrder()` on top returns `[...tabBar.visualOrder, ...the unfolded devices' tabs]` (today's `visibleOrder()` with its own part in the grouped order).

- [ ] **Step 1: Write the failing tests**

`tab-groups.test.ts`: `showsGroupLabels` is false for one group (a project, or only `NO_PROJECT`) and true for two.

`tabs.spec.ts`, new tests (default `tabs.position: 'top'`):
- `tabs on top are grouped by project, each group after its label`: two `gitRepo()`s, open tabs A1, B1, A2 (A, B the repos) → `#tabbar .tb-group-label` texts are the two repo names in first-tab order; `__ct.tabIds()` becomes `[A1, A2, B1]`; the `.tab`s appear in that order.
- `one project shows no label`: two tabs in one repo → `.tb-group-label` count 0.
- `dragging a tab within its group reorders it`: drag A2 onto A1 → `__ct.tabIds()` `[A2, A1, B1]`.
- **Order waits for places** (Review Focus 3): before opening the tabs, record every order main broadcasts — `page.evaluate(() => { const w = window as unknown as { orders: string[][] }; w.orders = []; window.ct.onTabsOrder((ids) => w.orders.push(ids)) })`; open A1, B1, A2 and wait for `[A1, A2, B1]` → every recorded order that holds all three tabs is `[A1, A2, B1]` (no temporary order was written while a place was unknown). `orderToWrite`'s unit tests already cover a partial place map writing nothing; keep them passing.
- **Overflow** (Review Focus 5): open 14 shell tabs, activate the last → its `.tab` bounding box lies within `#tabbar .tabs`'s visible box; activate the first → the same.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement** the interfaces; `TabBar.render` brings the active tab into view (`scrollIntoView({ inline: 'nearest', block: 'nearest' })`) when it changed, like `TabPanel.revealActive`. CSS: the row 42 px on `--ground`, `padding: 0 8px 4px 12px`; tabs 32 px pills radius 8, the active one raised as the left rows; labels uppercase 10.5 px `--text-3`; the separator a 1 px × 18 px `--line-2` line; the worktree line 2 px at the tab's bottom inside its padding.

- [ ] **Step 4: Run** `npm test`, `npm run build && npx playwright test tests/e2e/tabs.spec.ts tests/e2e/tab-panel.spec.ts tests/e2e/keys.spec.ts tests/e2e/forks.spec.ts tests/e2e/remote-tabs.spec.ts` → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: tabs on top are grouped by project, as in the left column`

---

### Task 7: The side panels and the note, redrawn; the panel slides in

**Files:**
- Modify: `src/renderer/styles.css` (`#image-panel`, `.panel-*`, `.card*`, `.review-*`, `.md-*`, `.doc-*`, the Agent messages panel's rules for `mail-panel.ts`, `#note`, `.note-*`), `src/renderer/side-panel.ts` (the hide button uses `icon('x', 14)`), `src/renderer/image-panel.ts` (a card's source chip `.card-source`)
- Test: `tests/e2e/side-panel.spec.ts`, `tests/e2e/images.spec.ts`

**Interfaces:**
- Consumes: the sheet (Task 4).
- Produces: `.card-source` — the card's `source` (`show_image`, `created`, …) in a small monospace chip in the card's first meta line.

- [ ] **Step 1: Write the failing tests**

`images.spec.ts`: a card shown by `show_image` has `.card-source` with text `show_image`.

`side-panel.spec.ts`:
- `the panel slides in when it opens`: with `reducedMotion: 'no-preference'`, right after the toggle click `document.getAnimations()` holds one named `panel-in` on `#image-panel`; with `reducedMotion: 'reduce'` none.
- **Rapid toggle** (Review Focus 4): with `sidePanel.noRoom: 'narrow'` and a maximized window, click the Media toggle three times within 100 ms (open, close, open) → after 1 s the panel is shown, the terminal's last size in `__ct.ptySizes()` is still the last one a second later (no resize trails behind), and at most one size was added since before the clicks.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.** Panel: `--sheet`-derived `#0F0F12` body, a 1 px `--line` left hairline, 44 px header (title semibold, count in `--text-3`, icon buttons 28 px radius 6); cards radius 10 on `#141418` with a `#0C0C0F` image well; Changes: file headers as card headers, the scope switch a segmented control (`.review-seg` raised active segment), comments in an accent-tinted card (`color-mix(in srgb, var(--accent) 12%, transparent)`, 1 px accent border at 40%), `Send to Claude` a primary button; the note's label and card on `--raised` with `--line-2`. `#image-panel:not(.collapsed)` runs `panel-in` (translateX(16px) → 0, opacity 0 → 1, 200 ms, ease-out) — the terminal is refitted by the existing `SidePanel.move` logic only, never per frame.

- [ ] **Step 4: Run** `npm run build && npx playwright test tests/e2e/side-panel.spec.ts tests/e2e/images.spec.ts tests/e2e/docs.spec.ts tests/e2e/note-overlay.spec.ts`, then `tests/e2e/review.spec.ts` alone → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: the side panels and the note in the new look; the panel slides in`

---

### Task 8: The status bar, redrawn

**Files:**
- Modify: `src/renderer/status-bar.ts` (`Segment`, `statusSegments`, `fill`, the separators), `src/renderer/styles.css` (`#statusbar`)
- Test: `tests/unit/status-bar.test.ts`, `tests/e2e/status.spec.ts`

**Interfaces:**
- Produces: `Segment` gains `pill?: string`; the `model` segment's `text` is the display name and its `pill` the effort (none without effort); the `context` segment gets `fill: usedPct / 100`. `fill()` draws `.status-text` and, when set, `.status-pill`; any segment with `fill` gets the bar (`--fill`, renamed from `--plan-fill`). Separators `.status-sep` are empty elements drawn as 1 px × 14 px lines.

- [ ] **Step 1: Write the failing tests**

`status-bar.test.ts`: `statusSegments` gives `{ key: 'model', text: 'Opus 5.5', pill: 'xhigh' }`, and without effort no `pill`; the context segment has `fill` 0.412 for 41.2%.
`status.spec.ts`: `#statusbar .status-model .status-text` → `Opus 5.5`, `.status-model .status-pill` → `xhigh`; `.status-context .status-text` → `ctx 41% · 82k/200k`; the `#statusbar .status-sep` text is empty.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.** CSS: the bar 32 px inside the sheet, `--text-3` text, `--text-2` values, 12 px, `gap: 18px`; the pill `padding: 0 6px; border-radius: 4px; background: var(--raised-2); font-size: 11px`; bars 44 × 4 px, `--line-2` track, fill `--text-2` for context and `--accent` for the plan, `transition: background-size 300ms` (or a width transition on an inner element).

- [ ] **Step 4: Run** `npm test`, `npm run build && npx playwright test tests/e2e/status.spec.ts tests/e2e/plan.spec.ts tests/e2e/accounts.spec.ts` → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: the status bar in the new look, the effort as a pill`

---

### Task 9: Menus, dialogs, banners, toasts, the lightbox

**Files:**
- Modify: `src/renderer/styles.css` (`.menu*`, `#sessions`, `.sessions-*`, `.session-*`, `#folder-dialog` and its parts, `#search`, `#plan-list`, `.banner*`, `.update-notes`, `.toast`, `#toasts`, `#lightbox`), `src/renderer/menu.ts` (an optional shortcut hint per item)
- Test: `tests/unit/` none (no logic); `tests/e2e/keys.spec.ts` or `recent-sessions.spec.ts` for the motion assertions below

**Interfaces:**
- Produces: `MenuItem` gains optional `hint?: string` (right-aligned `.menu-hint`, `--text-3`), used for `Recent sessions…` and `Settings…` in `newTabMenu` with `shortcutLabel('recentSessions', …)` (Task 3) and `shortcutLabel('openSettings', …)` — add `LABELS.openSettings` in `keymap.ts`, matching the keys `mapKey` and `mapMacKey` map to `openSettings` (their `case 'Comma'` lines), with a case in `tests/unit/keymap.test.ts`.

- [ ] **Step 1: Write the failing tests** — `recent-sessions.spec.ts`: `the Recent sessions dialog fades in, and not under reduced motion` (an animation named `pop-in` on `.sessions-box` right after opening; none with `reduce`). `keys.spec.ts` or the spec that opens the `▾` menu: the `Settings…` item shows its shortcut in `.menu-hint`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.** Menus: `--raised` surface, radius 12, 6 px padding, 34 px rows radius 7 with hover `#22222A`, separators `--line-2`, `box-shadow: 0 16px 40px #000A`, `pop-in` (opacity 0 → 1, scale .98 → 1, 140 ms); dialogs (`.sessions-box`, `#plan-list`, `#search`) the same surfaces and `pop-in`; banners on `--raised` with buttons in the primary / secondary / ghost styles; toasts slide up 8 px and fade in (180 ms); the lightbox backdrop fades in.

- [ ] **Step 4: Run** `npm run build && npx playwright test tests/e2e/recent-sessions.spec.ts tests/e2e/keys.spec.ts tests/e2e/restore.spec.ts tests/e2e/update.spec.ts tests/e2e/images.spec.ts` → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: menus, dialogs, banners and toasts in the new look`

---

### Task 10: The Settings window

**Files:**
- Modify: `src/main/settings-window.ts` (spread `chromeOptions(process.platform, SETTINGS_TITLE_BAR_HEIGHT)` into its BrowserWindow options), `src/renderer/settings.html` (a `#settings-titlebar` before `#settings`), `src/renderer/settings.css`, `src/renderer/settings-page.ts` (fill the bar)
- Test: `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `chromeOptions(…, SETTINGS_TITLE_BAR_HEIGHT)` (Task 2), the tokens and Inter (Task 1).

- [ ] **Step 1: Write the failing test** — `settings.spec.ts`: `the settings window has its own title bar that drags the window`: in the settings window, `#settings-titlebar` text `Settings`, `-webkit-app-region` `drag`, height 36 px; the body font is `"Inter Variable"`.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement.** The bar as the main one (ground color, drag, room for the window buttons through the same `env(titlebar-area-*)` padding, 84 px left on macOS); sections as cards on `--sheet` (the Accounts and Devices lists included), inputs and selects on `#0E0E11` with `--line-2` borders and an accent focus ring, checkboxes `accent-color: var(--accent)`, buttons in the three styles.

- [ ] **Step 4: Run** `npm run build && npx playwright test tests/e2e/settings.spec.ts tests/e2e/accounts.spec.ts` and the devices settings spec (`grep -rl "Devices" tests/e2e/*.spec.ts`) → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: the Settings window in the new look, with its own title bar`

---

### Task 11: Motion rules, end to end

**Files:**
- Modify: `src/renderer/sheet-header.ts` (badge pop), `src/renderer/styles.css` (the reduced-motion block, `badge-pop`)
- Test: `tests/e2e/motion.spec.ts` (create)

**Interfaces:**
- Produces: `SheetHeader.setImages` / `setChanges` add class `pop` to the badge (removed on `animationend`) when the count rises; `badge-pop` scales 0.8 → 1 over 200 ms.

- [ ] **Step 1: Write the failing tests** — `tests/e2e/motion.spec.ts`, all with `page.emulateMedia({ reducedMotion: 'no-preference' })` unless said:
- `an idle window runs no animation`: one shell tab, nothing waiting, after 500 ms no running animation is left outside the terminal — `document.getAnimations().filter((a) => a.playState === 'running' && !((a.effect as KeyframeEffect).target as Element | null)?.closest('.xterm')).length` is 0. (The terminal's own cursor blink, `cursorBlink: true` in `terminal-view.ts`, is the terminal's and stays.)
- `a working Claude tab runs its glyph and the line under the header, and nothing is left running after the turn`: `turn` → running animations include `tab-spin` and `sheet-sweep`; `attention`/`done` on the active tab → none running.
- `a count going up pops its badge once`: an image shown in the active tab → an animation `badge-pop` on `#sheet-header .tab-images-toggle .badge`, finished within 400 ms.
- `with reduced motion nothing runs, working and waiting alike`: `reduce`, a working tab in front and a waiting one behind → 0 running animations; the waiting tab still shows `.tab-attn`.

- [ ] **Step 2: Run them and see them fail** (the badge pop, and any rule Tasks 4–9 missed).

- [ ] **Step 3: Implement** the badge pop; one `@media (prefers-reduced-motion: reduce)` block in `styles.css` that sets `animation: none` and `transition: none` for every animated selector (keep the existing still `✻` rule).

- [ ] **Step 4: Run** `npm run build && npx playwright test tests/e2e/motion.spec.ts tests/e2e/activity.spec.ts tests/e2e/attention.spec.ts` → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `test: motion runs only while Claude works or waits, and never under reduced motion`

---

### Task 12: Performance check, README images, the hand-off list

**Files:**
- Create: `tests/perf/timing.perf.ts`, `playwright.perf.config.ts`
- Modify: `package.json` (script `"perf": "npm run build && playwright test -c playwright.perf.config.ts"`), `tests/screenshots/readme.shots.ts` (selectors that moved), `docs/images/*.png` (regenerated)

**Interfaces:**
- Produces: `npm run perf` prints one JSON line: `{ "launchToWindowMs", "launchToPromptMs", "tabSwitchMs", "panelOpenMs", "panelCloseMs", "echoUnderLoadMs" }`, each the median of 5 runs.

- [ ] **Step 1: Write the harness.** Uses `launchApp`; launch → first `page` painted, and → the first tab's prompt in `bufferText`; tab switch = `performance.now()` around `ct.activateTab(id)` until the target terminal is visible and two `requestAnimationFrame`s have passed; panel open/close the same around the Media toggle click until the panel's class settles; echo = a shell tab typing `x` while another tab runs a loop printing lines (`bellCommand`-style command from helpers), time until `bufferText` shows it. Not part of `npm run test:e2e` (separate config, `testDir: 'tests/perf'`).

- [ ] **Step 2: Measure.** Run `npm run perf` three times on a worktree of `master` (remove the `node_modules` junction with `rmdir` before `git worktree remove`, AGENTS.md) and three times on the branch. Expected: no median slower by more than 10% on the branch; if one is, find the cause before going on.

- [ ] **Step 3: Regenerate the README images** with `npm run screenshots`; keep only the images that changed because of the redesign; invented sessions only.

- [ ] **Step 4: Run everything.** `npm run typecheck`, `npm test`, `npm run test:e2e` → all green (rerun the known flaky specs alone before blaming the change).

- [ ] **Step 5: Leave uncommitted and report** the perf numbers (master vs branch) and this hand-off list for the user to check by eye: on Windows 11 — drag the window by the title bar, double-click it to maximize and again to restore (the window returns where it was, with a side panel closed meanwhile giving its width back), hover the maximize button for snap layouts, the window buttons' colors, 150% scaling; on the Mac — the traffic lights' position, full screen in and out, the gap on the left; on a Linux desktop if there is one — the window buttons drawn over the bar, dragging, double-click. Ready to commit: `chore: a timing harness for the window, and the README images in the new look`

---

### Task 13: Existing installs switch to Graphite once

Added after the plan was written: the user decided that everything new is the default, for existing installs too (spec, "The terminal"). Run it right after Task 4.

**Files:**
- Create: `src/main/look-migration.ts`
- Modify: `src/main/index.ts` (the migration runs right before the first `loadSettingsSafe(settingsPath)` at startup)
- Test: `tests/unit/look-migration.test.ts` (create), `tests/integration/look-migration.int.test.ts` (create; real files in a temp folder), `tests/e2e/font.spec.ts`

**Interfaces:**
- Consumes: `applySettingEdit(text, key, value)` from `src/main/settings.ts` (keeps unknown keys and the key order).
- Produces in `src/main/look-migration.ts`:
```ts
/** the marker in the data folder: its presence means the switch to Graphite was already considered on this install */
export const LOOK_MARKER = 'look-graphite.json'
/** settings.json text after the one-time switch: theme "Campbell" → "Graphite"; null when nothing changes */
export function graphiteEdit(text: string | null): string | null
/** once per install: applies graphiteEdit to <dataDir>/settings.json when the marker is missing, then writes the marker; never throws */
export function migrateLook(dataDir: string): void
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/look-migration.test.ts`:
- `an install still on Campbell moves to Graphite, every other key and the key order kept`: `graphiteEdit('{\n  "font": {"size": 12},\n  "theme": "Campbell",\n  "x": 1\n}')` parses to `{ font: { size: 12 }, theme: 'Graphite', x: 1 }` with keys in that order.
- `another theme, a custom theme object, no theme, an unreadable file or no file change nothing`: `graphiteEdit` gives `null` for `"One Half Dark"`, `{ "theme": { "background": "#000000" } }`, `{}`, `"{ not json"`, `null`.

`tests/integration/look-migration.int.test.ts` (a temp data folder under `tmpdir()`):
- `the switch happens once: a user who picks Campbell again keeps it`: settings.json with `"theme": "Campbell"`, `migrateLook(dir)` → file has `Graphite`, marker exists; write `Campbell` again, `migrateLook(dir)` → still `Campbell`.
- `a fresh install gets the marker, so a later Campbell is kept`: no settings.json → `migrateLook(dir)` writes no settings.json and writes the marker.
- `a broken settings.json is left as it is`: `{ not json` → unchanged byte for byte, marker written.

`tests/e2e/font.spec.ts`, new test `an install that was on Campbell starts on Graphite`: `launchApp({ settings: { theme: 'Campbell' } })` → after the first tab is active, `__ct.themeBackground()` is `#0E0E10`. (Check how `launchApp` writes `settings` into the data folder: the marker must not exist there beforehand.)

- [ ] **Step 2: Run them and see them fail** (no module; the e2e gets `#0C0C0C`).

- [ ] **Step 3: Implement.** `graphiteEdit`: parse with `JSON.parse` in a try (BOM stripped); only when the root is an object and `theme === 'Campbell'` return `applySettingEdit(text, 'theme', 'Graphite')`'s text, else `null`. `migrateLook`: if the marker exists return; read settings.json if it exists; write the edit when `graphiteEdit` gives one; then write the marker (`{ "graphite": true }`); log and swallow any error (a failed migration must not stop the app). Keep the file's line endings: if the old text used CRLF, the new text does too.

- [ ] **Step 4: Run** `npx vitest run tests/unit/look-migration.test.ts tests/integration/look-migration.int.test.ts`, `npm run typecheck`, `npm test`, `npm run build && npx playwright test tests/e2e/font.spec.ts tests/e2e/settings.spec.ts` → PASS.

- [ ] **Step 5: Leave uncommitted.** Ready to commit: `feat: an install still on the old default theme switches to Graphite once`
