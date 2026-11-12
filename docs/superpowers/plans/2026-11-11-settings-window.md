# Settings window redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Settings window becomes the approved boards: a search field and tabs at the top, a page per tab with rows, switches and choice cards, and a search that finds and changes any setting in place.

**Architecture:** The page stays plain TypeScript and DOM. The control builders move out of `settings-page.ts` into a new `settings-controls.ts` (rows, switches, number fields with steppers, choice cards); `settings-page.ts` composes the tabs and pages and wires search and keys; the matching rules live in a new pure `settings-search.ts`. Nothing in the main process changes but the window's size; no setting key, IPC channel or preload call changes.

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), plain DOM, Vitest (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-11-settings-window-design.md`

## Global Constraints

- Work in the worktree `D:\Workspace\ClaudeTerm\.claude\worktrees\feat-redesign-look` (branch `feat/chat-mode`). Never `cd` anywhere else, never touch another worktree under `.claude/worktrees/`, **never run `npm install` / `npm ci`**.
- **Never run git** (no status, diff, add, commit, stash, branch, checkout). Leave every change uncommitted; the controller snapshots the tree.
- **The chat-mode plan runs in this same worktree at the same time.** Edit only the files your task lists. A typecheck error, a failing build or a failing test in a file your task does not list is the other work in progress: never edit it; rerun after a few minutes, and if it still blocks you, report it with the error.
- Build and e2e only through the lock, so the two streams never rebuild `out/` under each other's tests: `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/<file> --reporter=line --workers=2"`. Unit tests of your task: `npx vitest run <test files>`.
- No UI framework; the page reaches the system only through `window.ct`; the CSP of `settings.html` stays as it is. No edits to `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/shared/settings-keys.ts`, `src/main/settings.ts`.
- Comments, logs and UI strings in English. Keep each file's line endings. Match the surrounding code's style and comment density (`AGENTS.md`).
- Palette: ground `#0A0A0C` (`--ground`), sheet `#111114` (`--sheet`), raised `#16161A` / `#1E1E23` (`--raised` / `--raised-2`), fields `#0E0E11`, hairlines `#1C1C21` / `#2A2A31` (`--line` / `--line-2`), text `#EDEDF0` / `#B5B5BE` / `#8C8C96` (`--text` / `--text-2` / `--text-3`), card notes `#9D9DA7`, accent `#D97757`, green `#63C08F`, red `#F2867E`. Use the tokens of `colors.css` where one exists.
- Type: `'Inter Variable', 'Segoe UI', system-ui, sans-serif`, 13 px; descriptions 12 px; section headings 10.5 px, 600, uppercase, `letter-spacing: 0.08em`; numbers `font-variant-numeric: tabular-nums`; monospace `'Cascadia Mono', Consolas, monospace`.
- Motion animates only `transform` and `opacity`; nothing delays an action; `@media (prefers-reduced-motion: reduce)` turns every animation and transition off.
- Every setting key the window edits today stays editable with the same behavior. Keep `data-key` on every control (on each card for card choices), `.field-error`, `.settings-banner`, `.settings-notice`, `#settings-titlebar`, `#settings`, `#devices`, `#notifications`, `.section-title`, `table.notify`, `.account-*`, `.device-*`.
- Tests: every changed behavior has an e2e test through the Settings window; existing e2e assertions change only where an element moved or its control changed. Build and e2e through the lock (above), only the affected spec files. A failing test is rerun alone before blaming the change. Tests never touch the real `~/.claude` or data folder.
- Done for a task means `npm run typecheck`, `npm test` and the task's e2e specs green.
- Clean up: close every app a test or you started; temp files only under the OS temp folder.

## Review Focus

1. A broken `settings.json` (locked) while the page shows cards and steppers: every card and the − / + buttons must be disabled, not only the inputs — test in Task 5.
2. Opening the window at a section (the bell, `open_device_settings`) while a search is shown: the search clears and the section's tab shows — test in Task 7.
3. Esc pressed while the focus is in a field of a search result: it clears the search, the window stays — test in Task 7.
4. A hand edit of `settings.json` while a search is shown: the results stay filtered and the controls show the new values — test in Task 7.
5. The window at its minimum size (560×480): no page scrolls sideways — test in Task 4.

## Files

| File | Responsibility |
|---|---|
| `src/renderer/settings-search.ts` (new) | Pure: query words, whether a text matches, where the matches are, the count label |
| `src/renderer/settings-controls.ts` (new) | The control registry (`addControl`, `applyView`, `showAll`, `save`) and the builders: rows, switches, number fields with steppers, selects, lists, choice cards |
| `src/renderer/settings-page.ts` | Composition: head, tabs, pages, footer, search wiring, keys, opening at a section |
| `src/renderer/settings-form.ts` | Pure: checks, options, `themeChoices` |
| `src/renderer/settings.html` / `settings.css` | Skeleton and look |
| `src/renderer/dom.ts` | `section()` gets the new structure (used by the Accounts and Devices sections too) |
| `src/renderer/icons.ts` | Adds `check`, `play`, `volume`, `music` |
| `src/main/settings-window.ts` | Window size 880×760, minimum 560×480 |

---

### Task 1: Search matching

**Files:**
- Create: `src/renderer/settings-search.ts`
- Test: `tests/unit/settings-search.test.ts`

**Interfaces:**
- Produces: `queryWords(query: string): string[]`, `matchesQuery(text: string, words: readonly string[]): boolean`, `matchRanges(text: string, words: readonly string[]): [number, number][]`, `countLabel(n: number): string` — used by Task 7.

- [ ] **Step 1: Write the failing test** `tests/unit/settings-search.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { countLabel, matchesQuery, matchRanges, queryWords } from '../../src/renderer/settings-search'

describe('settings search', () => {
  it('queryWords: lower case, split on white space, nothing for a blank query', () => {
    expect(queryWords('  Refresh   EVERY ')).toEqual(['refresh', 'every'])
    expect(queryWords('   ')).toEqual([])
  })

  it('matchesQuery: every word somewhere in the text, case ignored', () => {
    expect(matchesQuery('Refresh every 1–300 seconds claude.statusRefreshInterval', ['refresh', 'every'])).toBe(true)
    expect(matchesQuery('Refresh on a timer', ['refresh', 'every'])).toBe(false)
    expect(matchesQuery('Scrollback lines', ['scroll'])).toBe(true)
    expect(matchesQuery('anything', [])).toBe(true)
  })

  it('matchRanges: where the words are, as [start, end) in order, overlapping or touching ones merged', () => {
    expect(matchRanges('Shell for Claude tabs', ['shell'])).toEqual([[0, 5]])
    expect(matchRanges("What the tab's shell runs to start Claude", ['shell', 'claude'])).toEqual([[15, 20], [35, 41]])
    expect(matchRanges('aaaa', ['aa'])).toEqual([[0, 4]])
    expect(matchRanges('Refresh every', ['fresh', 'refresh'])).toEqual([[0, 7]])
    expect(matchRanges('No match here', ['zzz'])).toEqual([])
  })

  it('countLabel: none, one, many', () => {
    expect(countLabel(0)).toBe('No settings')
    expect(countLabel(1)).toBe('1 setting')
    expect(countLabel(4)).toBe('4 settings')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/unit/settings-search.test.ts`
Expected: FAIL, the module cannot be found.

- [ ] **Step 3: Implement the four functions in `src/renderer/settings-search.ts`**

A header comment ("What the Settings search matches, kept apart from the DOM."). `matchesQuery` lower-cases the text once and checks `includes` per word. `matchRanges` finds every occurrence of every word in the lower-cased text (`indexOf` from each found index + 1), sorts by start, merges a range whose start is `<=` the previous end.

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run tests/unit/settings-search.test.ts` — Expected: PASS. Then `npm run typecheck` — no errors.

- [ ] **Step 5: Leave the changes uncommitted (the controller snapshots the tree)**

---

### Task 2: Theme choices, the window size and four icons

**Files:**
- Modify: `src/renderer/settings-form.ts` (add `ThemeChoice`, `themeChoices`)
- Modify: `src/main/settings-window.ts:8-9` (`SETTINGS_SIZE`, `SETTINGS_MIN`)
- Modify: `src/renderer/icons.ts` (`ICON_NAMES`, `SHAPES`)
- Test: `tests/unit/settings-form.test.ts`, `tests/unit/settings-window.test.ts`

**Interfaces:**
- Produces: `interface ThemeChoice { value: string; title: string; note: string | null; colors: { background: string; foreground: string; green: string; cursor: string }; selectable: boolean; selected: boolean }` and `themeChoices(theme: Settings['theme']): ThemeChoice[]` (Task 5); icon names `'check' | 'play' | 'volume' | 'music'` (Tasks 4, 6). `themeOptions` stays until Task 5.

- [ ] **Step 1: Write the failing tests.** Add to `tests/unit/settings-form.test.ts` (import `themeChoices` too):

```ts
  it('themeChoices: a card per built-in theme, Graphite first, the saved one chosen', () => {
    const c = themeChoices('Campbell')
    expect(c.map((x) => x.value)).toEqual(['Graphite', 'Campbell', 'One Half Dark', 'One Half Light'])
    expect(c.filter((x) => x.selected).map((x) => x.value)).toEqual(['Campbell'])
    expect(c.every((x) => x.selectable)).toBe(true)
    expect(c[0]).toMatchObject({ title: 'Graphite', note: "ClaudeTerm's own, in the window's colors", colors: { background: '#0E0E10', foreground: '#D4D4DA', green: '#63C08F', cursor: '#D97757' } })
    expect(c.map((x) => x.note)).toEqual(["ClaudeTerm's own, in the window's colors", "Windows Terminal's default", 'Soft contrast on slate', 'A light terminal in the dark window'])
  })

  it('themeChoices: a theme object from settings.json is one more card, chosen, not selectable, in its colors over Campbell', () => {
    const c = themeChoices({ background: '#101010' })
    expect(c).toHaveLength(5)
    expect(c[4]).toMatchObject({ value: CUSTOM_THEME, title: 'Custom (settings.json)', note: 'Your own colors from settings.json', selectable: false, selected: true, colors: { background: '#101010', foreground: '#CCCCCC' } })
    expect(c.filter((x) => x.selected)).toHaveLength(1)
  })

  it('themeChoices: an unknown name is one more card, chosen, not selectable, in Graphite colors', () => {
    expect(themeChoices('Solarized')[4]).toMatchObject({ value: 'Solarized', title: 'Solarized (not found)', note: "Not one of ClaudeTerm's themes: Graphite is used", selectable: false, selected: true, colors: { background: '#0E0E10' } })
  })
```

In `tests/unit/settings-window.test.ts` replace the three `settingsWindowBounds` expectations and the first title:

```ts
  it('centres the 880×760 window on the main window', () => {
    expect(settingsWindowBounds({ x: 100, y: 50, width: 1200, height: 900 }, WORK)).toEqual({ x: 260, y: 120, width: 880, height: 760 })
  })
  // keeps it inside the work area:
    expect(settingsWindowBounds({ x: 1700, y: 900, width: 600, height: 400 }, WORK)).toEqual({ x: 1040, y: 280, width: 880, height: 760 })
    expect(settingsWindowBounds({ x: -500, y: -300, width: 600, height: 400 }, WORK)).toEqual({ x: 0, y: 0, width: 880, height: 760 })
  // shrinks to a small work area:
    expect(settingsWindowBounds({ x: 2000, y: 0, width: 800, height: 600 }, { x: 1920, y: 0, width: 1024, height: 600 })).toEqual({ x: 1960, y: 0, width: 880, height: 600 })
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/settings-form.test.ts tests/unit/settings-window.test.ts` — Expected: FAIL (`themeChoices` missing, bounds 640×720).

- [ ] **Step 3: Implement**
  - `settings-form.ts`: `const THEME_NOTES: Record<string, string>` with the four notes above; `themeChoices` maps `Object.keys(THEMES)` in order; colors from `THEMES[name]` with fallbacks `background ?? '#000000'`, `foreground ?? '#FFFFFF'`, `green ?? foreground`, `cursor ?? foreground`. A non-string theme appends the custom card (colors from `resolveTheme(theme)`); a string not in `THEMES` appends the not-found card (colors from `THEMES.Graphite`).
  - `settings-window.ts`: `SETTINGS_SIZE = { width: 880, height: 760 }`, `SETTINGS_MIN = { width: 560, height: 480 }`.
  - `icons.ts`: add to `ICON_NAMES` and `SHAPES`: `check: '<path d="M20 6 9 17l-5-5"></path>'`, `play: '<polygon points="6 3 20 12 6 21 6 3"></polygon>'`, `volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>'`, `music: '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>'`.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/unit/settings-form.test.ts tests/unit/settings-window.test.ts tests/unit/icons.test.ts` — PASS; `npm run typecheck` — no errors.

- [ ] **Step 5: Leave the changes uncommitted (the controller snapshots the tree)**

---

### Task 3: Rows and switches, sections in the new order

Still one scrolling page (the tabs come in Task 4), but every setting is a row in its new section, and every on/off setting a switch.

**Files:**
- Create: `src/renderer/settings-controls.ts`
- Modify: `src/renderer/settings-page.ts` (builders move out; the page is recomposed), `src/renderer/dom.ts:7-11` (`section`), `src/renderer/settings.css`
- Test: `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `Checked`, `Option`, check functions from `settings-form.ts`.
- Produces (in `settings-controls.ts`, used by Tasks 4–7):

```ts
export interface Control { inputs: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement)[]; show(view: SettingsView): void }
export type ShowError = (message: string | null) => void
export interface RowText { label: string; description?: string | null }
export function addControl(c: Control): void
export function currentView(): SettingsView                  // the view shown last
export function applyView(v: SettingsView): void             // keeps v; every listed input disabled = v.locked; then showAll()
export function showAll(): void
export function save(key: SettingKey, value: SettingValue, error: ShowError): Promise<boolean>   // as today's save()
export function errorLine(): { line: HTMLElement; show: ShowError }
export function controlId(key: string): string               // `setting-${key.replace(/\./g, '-')}`
export function row(text: RowText, keys: readonly string[], control: HTMLElement, forId: string | null, wide?: boolean): { row: HTMLElement; error: ShowError }
export function textRow(text: RowText, key: SettingKey, get: (v: SettingsView) => string, check: (t: string) => Checked<SettingValue>, mono?: boolean): HTMLElement
export function numberRow(text: RowText, key: SettingKey, get: (v: SettingsView) => number, check: (t: string) => Checked<SettingValue>, opts?: { suffix?: string; off?: (v: SettingsView) => boolean }): HTMLElement
export function selectRow(text: RowText, key: SettingKey, options: (v: SettingsView) => { options: Option[]; selected: string }, toValue: (s: string) => SettingValue | undefined): HTMLElement
export function switchRow(text: RowText, key: SettingKey, get: (v: SettingsView) => boolean): HTMLElement
export function listRow(text: RowText, key: SettingKey, get: (v: SettingsView) => string[], defaults: readonly string[]): HTMLElement
export function checkbox(key: SettingKey, get: (v: SettingsView) => boolean, error: ShowError, label: string): HTMLInputElement   // the notifications table's boxes, as today
```

The DOM each builder makes (the contract later tasks and tests rely on):

```html
<div class="row search-unit" data-search="{label} {description} {keys joined by ' '}">
  <div class="row-text"><label class="rl" for="{controlId(key)}">{label}</label><div class="rd">{description}</div></div>
  <div class="row-control">{control}</div>
  <div class="field-error" hidden></div>
</div>
```

`.rd` is left out when there is no description. `wide` adds the class `wide` (the control goes under the text, full width: the Test files list, the Sound row). A switch is `<input type="checkbox" role="switch" class="switch" id data-key>`; text and number fields keep `class="text-input"` and get the `id`; `numberRow`'s `suffix` is a `<span class="rd unit-suffix">` after the field; its `off(v)` true dims the row (class `off`) and disables the field (`disabled = v.locked || off(v)`, set in `show`). `listRow` keeps the textarea, the **Restore defaults** button with `data-restore` and the hint as the `.rd`.

- [ ] **Step 1: Write the failing tests** in `tests/e2e/settings.spec.ts`:

```ts
test('an on/off setting is a switch in a row that names it and says what it does; its label switches it', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const box = win.locator('[data-key="claude.autoContinue"]')
  await expect(box).toHaveAttribute('role', 'switch')
  const row = win.locator('.row', { has: box })
  await expect(row.locator('.rl')).toHaveText('Continue a cut-off response')
  await expect(row.locator('.rd')).toHaveText('When a dropped connection cuts a response off, up to 3 times in a row')
  await row.locator('.rl').click()
  await expect(box).toBeChecked()
  await expect.poll(() => readSettings(dataDir).claude?.autoContinue).toBe(true)
  await app.close()
})

test('Refresh every is dimmed and cannot be changed while the timer is off', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const timer = win.locator('[data-key="claude.statusRefresh"]')
  const interval = win.locator('[data-key="claude.statusRefreshInterval"]')
  const row = win.locator('.row', { has: interval })
  await expect(interval).toBeEnabled()
  await timer.uncheck()
  await expect(interval).toBeDisabled()
  await expect(row).toHaveClass(/\boff\b/)
  await timer.check()
  await expect(interval).toBeEnabled()
  await expect(row).not.toHaveClass(/\boff\b/)
  await app.close()
})
```

In the test `Hide test files and the Test files field save …` change `win.locator('.hint', { hasText: 'One pattern per line…' })` to `win.locator('.rd', { hasText: … })` (same text). In `the Agent messages section holds its two checkboxes…` replace the order assertion with `expect(titles.indexOf('Agent messages')).toBe(titles.indexOf('Changes') + 1)` and rename the test to `the Agent messages section follows Changes and holds its two switches, both on, and turning one off saves it`.

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build` then `npx playwright test tests/e2e/settings.spec.ts --reporter=line --workers=2 -g "switch in a row|Refresh every is dimmed|Agent messages section"` — Expected: FAIL (no `role="switch"`, no `.row`, old order).

- [ ] **Step 3: Write `settings-controls.ts`** with the interfaces above: move `controls`, `view`, `showAll`, `save`, `errorLine`, `checkbox` from `settings-page.ts`; the row builders replace `field`, `textField`, `listField`, `selectField`, `checkboxField`. `window.ct` is reached as in `settings-page.ts`.

- [ ] **Step 4: Change `section()` in `dom.ts`** to return `<section class="settings-section"><h2 class="section-title">{title}{note span}</h2><div class="section-body">{content}</div></section>` (the note span keeps `section-note`). Update its doc comment.

- [ ] **Step 5: Recompose `settings-page.ts`.** `render` calls `applyView(v)`; the banner and the notice stay where they are. The sections, in this order, with these rows (label / description; key):

| Section | Rows |
|---|---|
| Shells | Default shell / `New tabs open in it · Automatic: ${win32 ? 'PowerShell 7 if installed, else Windows PowerShell' : 'your login shell'}` (select `defaultProfile`) · Default folder / "New tabs open here; a Claude tab opens in the folder of the tab it is opened from · empty: your home folder" (text `defaultFolder`) · on win32 only: Console host / "How a shell talks to the window · applies to new tabs · Windows' own may leave lines of Claude Code's screen behind or double them" (select `conpty`) |
| Updates | Check for updates automatically / — (switch `autoUpdate`) |
| Terminal theme | Theme / — (select `theme`, as today; cards come in Task 5) |
| Terminal text | Font / "Any monospace font on this computer" (text `font.family`) · Size / "In pixels; zooming the terminal does not change it" (number `font.size`) · Scrollback lines / "Applies to new tabs" (number `scrollback`) |
| Tabs | Tabs / — (select `tabs.position`, as today) |
| Panels without room | Panels without room / "The panels widen the window first. Maximized, or at the edge of the screen, it cannot widen." (select `sidePanel.noRoom`) |
| Starting Claude | Command / "What the tab's shell runs to start Claude · applies to new tabs" (text `claude.command`, mono) · Shell for Claude tabs / "Applies to new tabs" (select `claude.shellProfile`) |
| While Claude works | Continue a cut-off response / `When a dropped connection cuts a response off, up to ${MAX_AUTO_CONTINUES} times in a row` · Go on after a restart / "The tabs ClaudeTerm restores pick up the work Claude was doing when it closed" · Pace of the usage limits / "A bar and a color in the title bar from how fast each limit is spent" (switches `claude.autoContinue`, `claude.continueAfterRestore`, `claude.limitPace`) |
| Status bar | Refresh on a timer / "Off: the status bar updates with each message Claude sends" (switch `claude.statusRefresh`) · Refresh every / "1–300 seconds; each refresh starts a few short processes per Claude tab" (number `claude.statusRefreshInterval`, suffix "seconds", `off: (v) => !v.settings.claude.statusRefresh`) |
| When a tab you are not looking at needs you | the notifications table as today; this `<section>` gets `id = 'notifications'` |
| Sound | today's sound control (radios, path, Browse…, Play) inside `row({ label: 'Sound' }, ['notifications.sound'], …, null, true)` |
| More | Signal a finished answer during background work / "Also while agents, shell commands or monitors Claude started still run" (switch `notifications.doneWithBackgroundWork`) · Highlight a tab left unread / "A Claude tab you leave with a reply not read to its end, or a prompt not sent" (switch `notifications.autoUnread`) |
| Media | Show new images, audio and video from the session scratchpad / "Applies to new tabs" (switch `imageWatch.enabled`) · Open the Media panel when a new file arrives / "Applies to new tabs" (switch `imagePanel.autoOpen`) |
| Changes | Editor / "Empty: VS Code if installed, else the file is shown in its folder · {file} and {line} are filled in" (text `review.editor`) · Show the changes counter in the status bar · Hide files git ignores · Hide test files · Show Markdown files formatted (switches `review.statusBar`, `review.hideIgnored`, `review.hideTests`, `review.renderMarkdown`) · Test files / today's hint (list `review.testPatterns`) |
| Agent messages | Let agents message tabs that Claude Code's own messaging can't reach / "Agents use SendMessage first. ClaudeTerm carries a message only to a tab SendMessage doesn't list: another device, another account." · Mark tabs that got messages you haven't read / "An envelope on the tab and a counter; no sound, no pop-up." (switches `agentMessages.enabled`, `agentMessages.marks`) |
| Accounts | `accountsSection()` as it is |
| Devices | `devicesSection([switchRow({ label: REMOTE_COPY.keepAwake }, 'devices.keepAwake', …)])` |

The footer stays at the end of the page for now. `checkText` / `checkNumber` / `checkOptionalText` / `profileOptions` / `profileValue` / `themeOptions` are used as today.

- [ ] **Step 6: Restyle in `settings.css`.** Remove the rules of `section`, `.field`, `.field-label`, `.field-input`, `.check-field*`; keep `.hint` (the Accounts and Devices sections use it). Add:
  - `#settings { padding: 24px 28px 32px }`; `.settings-section + .settings-section { margin-top: 28px }`; `.section-title { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; color: var(--text-3); font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase }`; `.section-body { background: var(--sheet); border: 1px solid var(--line); border-radius: 12px }`; `.section-body:not(:has(> .row)) { padding: 12px 16px }`.
  - `.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 16px; padding: 12px 16px }`, `.row + .row { border-top: 1px solid var(--line) }`, `.row.wide { grid-template-columns: minmax(0, 1fr); row-gap: 8px }`, `.row.off { opacity: 0.5 }`, `.row .field-error { grid-column: 1 / -1 }`, `.rl { font-weight: 500 }`, `.rd { color: var(--text-3); font-size: 12px }`, `.row-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0 }`, `.row.wide .row-control { justify-content: flex-start; flex-wrap: wrap }`.
  - Fields: `.text-input, select { height: 30px; padding: 0 10px; border-radius: 7px; background: #0E0E11 }`; `input[type="text"].text-input { width: 260px }`; `.text-input.mono { font: 12.5px 'Cascadia Mono', Consolas, monospace }`; `input[type="number"].text-input { width: 90px }`; `select { width: 260px }`; number spinners hidden (`::-webkit-inner-spin-button, ::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0 }`).
  - The switch:

```css
input.switch { appearance: none; flex: none; position: relative; width: 36px; height: 20px; margin: 0; border-radius: 10px; background: var(--line-2); cursor: pointer; }
input.switch::before { content: ''; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-2); box-shadow: 0 1px 2px #0006; transition: transform 0.12s ease; }
input.switch:checked { background: var(--accent); }
input.switch:checked::before { transform: translateX(16px); background: #FFFFFF; }
input.switch:focus-visible { outline: 2px solid rgba(217, 119, 87, 0.6); outline-offset: 2px; }
input.switch:disabled { opacity: 0.5; cursor: default; }
@media (prefers-reduced-motion: reduce) { input.switch::before { transition: none; } }
```

- [ ] **Step 7: Run the settings specs**

Run: `npm run typecheck`, `npm test`, `npm run build`, then `npx playwright test tests/e2e/settings.spec.ts tests/e2e/accounts.spec.ts tests/e2e/side-panel.spec.ts --reporter=line --workers=2` — Expected: all PASS (the two new tests too).

- [ ] **Step 8: Leave the changes uncommitted (the controller snapshots the tree)**

---

### Task 4: Tabs, pages, the head and the footer

**Files:**
- Modify: `src/renderer/settings.html`, `src/renderer/settings-page.ts`, `src/renderer/settings.css`
- Modify (tests): `tests/e2e/helpers.ts`, `tests/e2e/settings.spec.ts`, `tests/e2e/accounts.spec.ts`, `tests/e2e/devices.spec.ts`, `tests/e2e/remote-tabs.spec.ts`, `tests/e2e/side-panel.spec.ts`

**Interfaces:**
- Consumes: Task 3's builders; icon `check` (Task 2).
- Produces: the DOM below; in `settings-page.ts` `type TabId = 'general' | 'appearance' | 'claude' | 'notifications' | 'panels' | 'accounts' | 'devices'`, `showTab(id: TabId): void`; in `tests/e2e/helpers.ts` `showSettingsTab(win: Page, tab: string): Promise<void>` (clicks `#settings-nav [data-tab="{tab}"]`, then `win.waitForSelector('.settings-page[data-page="{tab}"]', { state: 'visible' })`).

`settings.html` body:

```html
<div id="settings-titlebar"><span class="st-mark" aria-hidden="true"></span>Settings</div>
<div id="settings-head"></div>
<div id="settings" tabindex="-1"></div>
<footer id="settings-footer" class="settings-footer"></footer>
```

`#settings-head` gets `<div class="settings-head-inner">` holding the search label (Task 7 fills its behavior; build it now) and the nav:

```html
<label class="settings-search">{icon('search', 15)}<input id="settings-search" type="search" aria-label="Search settings" placeholder="Search settings" spellcheck="false" autocomplete="off"><kbd class="search-key">Ctrl+F</kbd></label>
<nav id="settings-nav" aria-label="Settings sections">
  <button type="button" class="settings-tab" data-tab="general" aria-current="page">General</button> … one per tab
</nav>
```

The key hint reads `⌘F` when `ct.platform === 'darwin'`. Tabs in order: General, Appearance, Claude Code (`claude`), Notifications, Panels, Accounts, Devices. `#settings` holds `<div class="settings-inner">` with the banner, the notice, then one `<div class="settings-page" data-page="{id}">` per tab in the same order, all but the one in front `hidden`. Pages: general — Shells, Updates; appearance — Terminal theme, Terminal text, Tabs, Panels without room; claude — first `<div class="settings-slot" data-slot="claude-view" hidden></div>`, then Starting Claude, While Claude works, Status bar; notifications — When a tab…, Sound, More; panels — Media, Changes, Agent messages; accounts — Accounts; devices — Devices. The footer: `<span class="saved">{icon('check', 13)}Saved as you change it</span><span class="footer-note">Profiles, image types, ignored folders, a custom theme and the image and Changes panel widths are set in settings.json</span>` + the **Open settings.json** button.

Behavior: the window starts at General. A tab click calls `showTab`. `showSection(name)` (the `#hash` and `onSettingsSection`) maps `devices` → `devices`, `notifications` → `notifications` and calls `showTab`. Esc closes the window as today. A document `keydown` for `PageDown` / `PageUp` whose target is outside `#settings` and is not a text field (`textarea`, `select`, or an `input` of type text, number, search or password) scrolls `#settings` by `±(clientHeight - 40)` and prevents the default. The focus on load stays as today (`#settings`).

CSS: `body` column: `#settings-titlebar` (as today; `.st-mark` 18×18, radius 5, accent background, `::before { content: '>_'; color: var(--ground); font: 700 10px 'Cascadia Mono', Consolas, monospace }`, 8 px before "Settings"), `#settings-head { flex: none; padding: 18px 28px 0; border-bottom: 1px solid var(--line) }`, `.settings-head-inner, .settings-inner { max-width: 820px; margin: 0 auto }`, `.settings-search { display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 8px 0 12px; background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px; color: var(--text-3) }` (its input: flex 1, no border or background, `font: inherit`, `color: var(--text)`; `::-webkit-search-cancel-button { display: none }`), `kbd.search-key { padding: 0 6px; border: 1px solid var(--line-2); border-radius: 5px; font: 11px 'Cascadia Mono', Consolas, monospace }`, `#settings-nav { display: flex; gap: 2px; margin-top: 12px; overflow-x: auto }`, `.settings-tab { display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 12px; background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--text-3); font-weight: 500; white-space: nowrap }`, `.settings-tab:hover { color: var(--text) }`, `.settings-tab[aria-current="page"] { color: var(--text); border-bottom-color: var(--accent) }`, `#settings { flex: 1; min-height: 0; overflow-y: auto }`, `.settings-page:not([hidden]) { animation: settings-page-in 120ms ease-out }` with `@keyframes settings-page-in { from { opacity: 0; transform: translateY(4px) } }` (none under reduced motion), `.settings-footer { flex: none; display: flex; align-items: center; gap: 12px; padding: 12px 28px; border-top: 1px solid var(--line); color: var(--text-3); font-size: 12px }`, `.saved { display: flex; align-items: center; gap: 6px; color: var(--green) }`, `.footer-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }`, the footer button a ghost (transparent, `color: var(--text-2)`, 30 px high, radius 7). The hover rule of `button` must not draw an accent line on `.settings-tab`.

- [ ] **Step 1: Add `showSettingsTab` to `tests/e2e/helpers.ts` and write the failing tests** in `tests/e2e/settings.spec.ts`. Give its local `openSettings` an optional third parameter `tab?: string` that calls `showSettingsTab(win, tab)` when set. Import `showSettingsTab` from `./helpers` in every spec that uses it, and `NOTIFICATION_CASES, NOTIFICATION_CHANNELS` from `../../src/shared/settings-keys` in `settings.spec.ts`.

```ts
test('the window opens at General, with its tabs in order, and a tab shows only its own settings', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await expect(win.locator('#settings-nav .settings-tab:not([hidden])')).toHaveText(['General', 'Appearance', 'Claude Code', 'Notifications', 'Panels', 'Accounts', 'Devices'])
  await expect(win.locator('#settings-nav [data-tab="general"]')).toHaveAttribute('aria-current', 'page')
  await expect(win.locator('[data-key="defaultFolder"]')).toBeVisible()
  await expect(win.locator('[data-key="claude.command"]')).toBeHidden()
  await win.locator('#settings-nav [data-tab="claude"]').click()
  await expect(win.locator('[data-key="claude.command"]')).toBeVisible()
  await expect(win.locator('[data-key="defaultFolder"]')).toBeHidden()
  await expect(win.locator('#settings-nav [data-tab="claude"]')).toHaveAttribute('aria-current', 'page')
  await expect(win.locator('#settings-nav [data-tab="general"]')).not.toHaveAttribute('aria-current', 'page')
  await app.close()
})

test('every setting lives in its tab', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const notifications = [...NOTIFICATION_CASES.flatMap((c) => NOTIFICATION_CHANNELS.map((ch) => `notifications.${c}.${ch}`)), 'notifications.autoUnread', 'notifications.doneWithBackgroundWork', 'notifications.sound'].sort()
  await expect.poll(() => win.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('.settings-page')].map((p) =>
    [p.dataset.page, [...new Set([...p.querySelectorAll<HTMLElement>('[data-key]')].map((e) => e.dataset.key!))].sort()])))).toEqual({
    general: ['autoUpdate', ...(WIN ? ['conpty'] : []), 'defaultFolder', 'defaultProfile'],
    appearance: ['font.family', 'font.size', 'scrollback', 'sidePanel.noRoom', 'tabs.position', 'theme'],
    claude: ['claude.autoContinue', 'claude.command', 'claude.continueAfterRestore', 'claude.limitPace', 'claude.shellProfile', 'claude.statusRefresh', 'claude.statusRefreshInterval'],
    notifications,
    panels: ['agentMessages.enabled', 'agentMessages.marks', 'imagePanel.autoOpen', 'imageWatch.enabled', 'review.editor', 'review.hideIgnored', 'review.hideTests', 'review.renderMarkdown', 'review.statusBar', 'review.testPatterns'],
    accounts: [],
    devices: ['devices.keepAwake']
  })
  await app.close()
})

test('Settings opened at a section shows that section\'s tab, also when it is open at another', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const [win] = await Promise.all([app.waitForEvent('window'), page.evaluate(() => window.ct.openSettingsWindow('notifications'))])
  await expect(win.locator('#settings-nav [data-tab="notifications"]')).toHaveAttribute('aria-current', 'page')
  await expect(win.locator('#notifications')).toBeVisible()
  await win.locator('#settings-nav [data-tab="general"]').click()
  await expect(win.locator('#notifications')).toBeHidden()
  await page.evaluate(() => window.ct.openSettingsWindow('notifications'))
  await expect(win.locator('#settings-nav [data-tab="notifications"]')).toHaveAttribute('aria-current', 'page')
  await expect(win.locator('#notifications')).toBeVisible()
  await app.close()
})

test('the footer says changes are saved as they are made, on every tab, with Open settings.json', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  for (const tab of ['general', 'panels']) {
    await showSettingsTab(win, tab)
    await expect(win.locator('.settings-footer .saved')).toHaveText('Saved as you change it')
    await expect(win.locator('.settings-footer button', { hasText: 'Open settings.json' })).toBeVisible()
  }
  await app.close()
})

test('at its smallest the window scrolls no page sideways', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'ClaudeTerm Settings')!.setSize(560, 480))
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(560)
  for (const tab of ['general', 'appearance', 'claude', 'notifications', 'panels', 'accounts', 'devices']) {
    await showSettingsTab(win, tab)
    expect(await win.evaluate(() => { const s = document.getElementById('settings')!; return s.scrollWidth <= s.clientWidth })).toBe(true)
  }
  await app.close()
})
```

Change these existing tests:
  - `the settings window has its own title bar…`: add `await expect(win.locator('#settings-titlebar .st-mark')).toBeVisible()`.
  - `the settings title bar stays at the top while the page scrolls…` and `PageDown scrolls Settings without a click first`: open with `openSettings(app, page, 'panels')`; rename the second to `PageDown scrolls the page of a tab, also right after its tab is clicked`.
  - `the Agent messages section follows Changes…`: replace the titles lookup with `win.locator('.settings-page[data-page="panels"] .section-title')` and assert `toEqual(['Media', 'Changes', 'Agent messages'])` on `h.childNodes[0].textContent`; open with tab `panels`.
  - Every other test that calls `openSettings` and then acts on a control passes the tab holding that control's key (General: `defaultProfile`, `defaultFolder`, `conpty`, `autoUpdate`; Appearance: `theme`, `font.*`, `scrollback`, `tabs.position`, `sidePanel.noRoom`; Claude Code `claude`: `claude.*`; Notifications: `notifications.*`; Panels: `imageWatch.*`, `imagePanel.*`, `review.*`, `agentMessages.*`). A test acting on two tabs calls `showSettingsTab` again before the second.
  - `accounts.spec.ts`: its `openSettings` calls `showSettingsTab(win, 'accounts')` before returning. `devices.spec.ts`: its `openSettings` calls `showSettingsTab(win, 'devices')`; `settingsA.locator('.section-title').first()` becomes `settingsA.locator('#devices .section-title')`.
  - `remote-tabs.spec.ts`: after each `settings.waitForSelector('#settings .section-title')` add `await showSettingsTab(settings, 'devices')`; `getByRole('checkbox', { name: 'Keep this computer awake while another device uses it' })` becomes `getByRole('switch', { name: … })`. In `open_device_settings opens the Devices section…` replace the `getBoundingClientRect().top < 40` poll with `await expect(win.locator('#settings-nav [data-tab="devices"]')).toHaveAttribute('aria-current', 'page', SLOW)` and `await expect(win.locator('#devices')).toBeVisible()`. In `open_device_settings brings a Settings window that is open to the Devices section, scrolled away from it` rename to `… that shows another tab` and replace the scroll and both `top` polls with: click `#settings-nav [data-tab="general"]`, expect `#devices` hidden, send `open_device_settings`, expect the Devices tab current (`SLOW`) and `#devices` visible.
  - `side-panel.spec.ts` (`choosing "Narrow the terminal"…`): after its `waitForSelector` add `await showSettingsTab(win, 'appearance')`.

- [ ] **Step 2: Run the new tests to see them fail**

Run: `npm run build`, `npx playwright test tests/e2e/settings.spec.ts --reporter=line --workers=2 -g "opens at General|lives in its tab|opened at a section|footer says|smallest"` — Expected: FAIL (no `#settings-nav`).

- [ ] **Step 3: Implement** `settings.html`, the head, the pages, the footer, `showTab`, `showSection`, the PageDown key, the CSS above.

- [ ] **Step 4: Run every touched spec**

Run: `npm run typecheck`, `npm test`, `npm run build`, then `npx playwright test tests/e2e/settings.spec.ts tests/e2e/accounts.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/devices.spec.ts --reporter=line --workers=2` and `npx playwright test tests/e2e/remote-tabs.spec.ts --reporter=line --workers=1 -g "Settings|open_device_settings|Devices count|Keep this computer awake|section name"` — Expected: PASS. (`remote-tabs` and `devices` pair two apps and are slow; a timeout is rerun alone once before it counts.)

- [ ] **Step 5: Leave the changes uncommitted (the controller snapshots the tree)**

---

### Task 5: Choice cards on the Appearance tab, and the size stepper

**Files:**
- Modify: `src/renderer/settings-controls.ts` (add `CardChoice`, `cardSection`; `numberRow` gets `step`), `src/renderer/settings-page.ts`, `src/renderer/settings-form.ts` (remove `themeOptions`), `src/renderer/settings.css`
- Test: `tests/e2e/settings.spec.ts`, `tests/e2e/side-panel.spec.ts`, `tests/unit/settings-form.test.ts` (remove the `themeOptions` test)

**Interfaces:**
- Consumes: `themeChoices`, `ThemeChoice` (Task 2), `currentView`, `save`, `errorLine`, `addControl` (Task 3).
- Produces (Task 6 uses `cardSection`; the chat work uses it at integration):

```ts
export interface CardChoice { value: string; title: string; note: string | null; chip?: string; art?: HTMLElement; selectable?: boolean; noteClass?: string }
export function cardSection(o: {
  title: string; key: SettingKey; small?: boolean; searchText: string
  choices: (v: SettingsView) => CardChoice[]; selected: (v: SettingsView) => string
  pick: (value: string, error: ShowError) => void; after?: HTMLElement
}): HTMLElement
// numberRow opts gain: step?: { min: number; max: number }
```

`cardSection` DOM:

```html
<section class="settings-section cards-section search-unit" data-search="{title} {searchText} {key}">
  <h2 class="section-title" id="h-{controlId(key)}">{title}</h2>
  <div class="cards [cards-small]" role="radiogroup" aria-labelledby="h-{controlId(key)}">
    <button type="button" role="radio" class="card" data-key="{key}" data-value="{value}" aria-checked="true|false">
      {art}<span class="card-text"><span class="ct">{title}<span class="card-check">{icon('check', 16)}</span></span><span class="cd {noteClass}">{note}</span><span class="chip">{chip}</span></span>
    </button>
  </div>
  <div class="field-error" hidden></div>
  {after}
</section>
```

`show(v)`: if the values of `choices(v)` differ from the buttons built, rebuild them; else keep them (the focus stays on a clicked card). Then for each button: `aria-checked` = its value equals `selected(v)`; `disabled = v.locked || choice.selectable === false`; the `.ct` text node and the `.cd` text follow the choice (`.cd` hidden when the note is null; `.chip` left out without a chip). A click calls `pick(value, error)`. The control lists no `inputs` (its `show` sets `disabled`). A stepper (`step`) puts `<button type="button" class="step" aria-label="Smaller">−</button>` before and `…aria-label="Larger">+</button>` after the field inside `<div class="stepper">`; a click saves `clamp(get(currentView()) ∓ 1, min, max)`; `show` sets `Smaller.disabled = v.locked || get(v) <= min`, `Larger.disabled = v.locked || get(v) >= max`.

The Appearance cards (in `settings-page.ts`):
  - **Terminal theme**: `small: true`; choices from `themeChoices(v.settings.theme)`; art = `<span class="swatch" aria-hidden="true">` with `style.background = colors.background`, three lines: `$ npm test` (foreground), `✓ 42 passed` (green), `$ ` + `<span class="swatch-cursor">` (background = cursor); `pick`: save `theme` unless it is the chosen one; `searchText` = the four built-in names and notes; `after` = `<p class="rd section-after">A theme of your own colors goes in settings.json and shows here as one more card.</p>`.
  - **Tabs**: `tabs.position`; On top / "A row of tabs above the sheet, grouped by project" / chip `"top"` / art `art-top`; On the left / "A list beside the sheet, Recent sessions at its foot" / `"left"` / `art-left`.
  - **Panels without room**: `sidePanel.noRoom`; Over the terminal / "Media and Changes cover the terminal's right side" / `"overlay"` / `art-overlay`; Narrow the terminal / "The terminal steps aside and gets narrower" / `"narrow"` / `art-narrow`; `after` = the note "The panels widen the window first. Maximized, or at the edge of the screen, it cannot widen." (the row of Task 3 goes).
  - **Size** in Terminal text: `step: NUMBER_LIMITS['font.size']`.

Art markup: `<span class="art art-top" aria-hidden="true"><span class="art-tabs"><i></i><i></i><i></i></span><span class="art-sheet"></span></span>`; `art-left`: `<span class="art-list"><i></i><i></i><i></i></span><span class="art-sheet"></span>`; `art-overlay` and `art-narrow`: `<span class="art-sheet"></span><span class="art-panel"></span>`.

CSS (values from the boards):

```css
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.cards.cards-small { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.card { display: flex; align-items: center; gap: 14px; height: auto; padding: 12px; background: var(--raised); border: 1px solid var(--line-2); border-radius: 10px; color: var(--text); text-align: left; }
.cards-small .card { flex-direction: column; align-items: stretch; gap: 8px; padding: 10px 10px 12px; }
.card:hover:not(:disabled) { border-color: #3A3A43; background: #1A1A1F; }
.card[aria-checked="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.card[aria-checked="true"]:disabled { opacity: 1; }
.card-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ct { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.card-check { display: none; margin-left: auto; color: var(--accent); }
.card[aria-checked="true"] .card-check { display: flex; }
.cd { color: #9D9DA7; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.chip { align-self: flex-start; padding: 1px 6px; background: #0E0E11; border: 1px solid #26262D; border-radius: 5px; color: #9D9DA7; font: 11px 'Cascadia Mono', Consolas, monospace; }
.section-after { margin: 8px 2px 0; }
.swatch { display: flex; flex-direction: column; gap: 2px; height: 62px; padding: 8px 10px; border: 1px solid #FFFFFF12; border-radius: 7px; font: 10.5px 'Cascadia Mono', Consolas, monospace; }
.swatch-cursor { display: inline-block; width: 6px; height: 11px; vertical-align: -2px; }
.art { flex: none; position: relative; display: flex; gap: 3px; width: 86px; height: 58px; padding: 5px; background: var(--ground); border: 1px solid var(--line-2); border-radius: 6px; }
.art i { display: block; height: 6px; border-radius: 2px; background: var(--line-2); }
.art-top { flex-direction: column; } .art-tabs { display: flex; gap: 3px; } .art-tabs i { width: 20px; } .art-tabs i:first-child { background: var(--accent); }
.art-list { display: flex; flex-direction: column; gap: 3px; width: 22px; } .art-list i:first-child { background: #3A3A43; }
.art-sheet { flex: 1; border-radius: 3px; background: var(--line); }
.art-panel { width: 30px; border-radius: 3px; background: #2E2E36; }
.art-overlay .art-panel { position: absolute; top: 5px; right: 5px; bottom: 5px; box-shadow: -4px 0 8px #0008; }
.stepper { display: flex; } .stepper .text-input { width: 52px; border-radius: 0; border-left: 0; border-right: 0; text-align: center; }
.step { width: 30px; height: 30px; padding: 0; background: var(--raised-2); border: 1px solid var(--line-2); color: var(--text-2); font-size: 15px; }
.step:first-child { border-radius: 7px 0 0 7px; } .step:last-child { border-radius: 0 7px 7px 0; }
```

- [ ] **Step 1: Write the failing tests** in `tests/e2e/settings.spec.ts`:

```ts
test('the theme cards preview each theme, Graphite first, and a click applies one', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page, 'appearance')
  const card = (name: string) => win.locator(`[data-key="theme"][data-value="${name}"]`)
  await expect.poll(() => win.locator('[data-key="theme"]').evaluateAll((cs) => cs.map((c) => (c as HTMLElement).dataset.value))).toEqual(['Graphite', 'Campbell', 'One Half Dark', 'One Half Light'])
  await expect(card('Graphite')).toHaveAttribute('aria-checked', 'true')
  expect(await card('One Half Light').locator('.swatch').evaluate((s) => getComputedStyle(s).backgroundColor)).toBe('rgb(250, 250, 250)')
  await card('One Half Light').click()
  await expect.poll(() => page.evaluate(() => window.__ct!.themeBackground!())).toBe('#FAFAFA')
  await expect(card('One Half Light')).toHaveAttribute('aria-checked', 'true')
  await expect(card('Graphite')).toHaveAttribute('aria-checked', 'false')
  expect(readSettings(dataDir).theme).toBe('One Half Light')
  await app.close()
})

test('the Tabs cards show their value and move the tabs to the left and back', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page, 'appearance')
  const top = win.locator('[data-key="tabs.position"][data-value="top"]')
  const left = win.locator('[data-key="tabs.position"][data-value="left"]')
  await expect(top).toHaveAttribute('aria-checked', 'true')
  await expect(left.locator('.chip')).toHaveText('"left"')
  await left.click()
  await expect(page.locator('#tabpanel')).toBeVisible()
  await expect.poll(() => readSettings(dataDir).tabs?.position).toBe('left')
  await top.click()
  await expect(page.locator('#tabpanel')).toBeHidden()
  await expect.poll(() => readSettings(dataDir).tabs?.position).toBe('top')
  await app.close()
})

test('the size buttons change the font size by one and stop at the limits', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { ...QUIET, font: { size: 71 } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page, 'appearance')
  const larger = win.getByRole('button', { name: 'Larger' })
  const smaller = win.getByRole('button', { name: 'Smaller' })
  await larger.click()
  await expect.poll(() => readSettings(dataDir).font?.size).toBe(72)
  await expect(win.locator('[data-key="font.size"]')).toHaveValue('72')
  await expect(larger).toBeDisabled()
  await smaller.click()
  await smaller.click()
  await expect.poll(() => readSettings(dataDir).font?.size).toBe(70)
  await expect(larger).toBeEnabled()
  await app.close()
})

test('a broken settings.json disables the cards and the size buttons too, until it is fixed', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page, 'appearance')
  const file = join(dataDir, 'settings.json')
  writeFileSync(file, '{ broken')
  await expect(win.locator('.settings-banner')).toBeVisible()
  await expect(win.locator('[data-key="theme"][data-value="Campbell"]')).toBeDisabled()
  await expect(win.locator('[data-key="tabs.position"][data-value="left"]')).toBeDisabled()
  await expect(win.getByRole('button', { name: 'Larger' })).toBeDisabled()
  writeFileSync(file, JSON.stringify(QUIET))
  await expect(win.locator('.settings-banner')).toBeHidden()
  await expect(win.locator('[data-key="theme"][data-value="Campbell"]')).toBeEnabled()
  await expect(win.getByRole('button', { name: 'Larger' })).toBeEnabled()
  await app.close()
})
```

Change these existing tests:
  - `size and theme apply to the terminal at once`: `selectOption('One Half Light')` becomes `win.locator('[data-key="theme"][data-value="One Half Light"]').click()`.
  - `a custom theme, an unknown profile…`: the theme line becomes `await expect(win.locator('[data-key="theme"][aria-checked="true"] .ct')).toHaveText('Custom (settings.json)')` and `await expect(win.locator('[data-key="theme"][aria-checked="true"]')).toBeDisabled()`.
  - `the Theme list starts with Graphite, the default`: delete it (the first new test covers it).
  - `side-panel.spec.ts` (`choosing "Narrow the terminal"…`): `await expect(win.locator('[data-key="sidePanel.noRoom"][data-value="overlay"]')).toHaveAttribute('aria-checked', 'true')`, then `await win.locator('[data-key="sidePanel.noRoom"][data-value="narrow"]').click()`.
  - `tests/unit/settings-form.test.ts`: remove the `themeOptions` test and import.

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build`, `npx playwright test tests/e2e/settings.spec.ts --reporter=line --workers=2 -g "theme cards|Tabs cards|size buttons|disables the cards"` — Expected: FAIL.

- [ ] **Step 3: Implement** `cardSection`, the stepper, the three card sections, the CSS; remove `themeOptions` from `settings-form.ts`.

- [ ] **Step 4: Run the specs**

Run: `npm run typecheck`, `npm test`, `npm run build`, `npx playwright test tests/e2e/settings.spec.ts tests/e2e/side-panel.spec.ts --reporter=line --workers=2` — Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted (the controller snapshots the tree)**

---

### Task 6: The Notifications page

**Files:**
- Modify: `src/renderer/settings-page.ts`, `src/renderer/settings.css`
- Test: `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `cardSection` (Task 5), `checkbox`, `save`, `showAll` (Task 3), icons `volume`, `music`, `play` (Task 2).

What changes:
  - The table: `CASE_LABELS` become `permission: 'Claude asks for permission'`, `question: 'Claude asks a question'`, `done: 'Claude finished its answer'`, `peer: 'A turn another session started'`, `bell: 'Terminal bell'`; a row header is `<th scope="row"><span class="rl">{label}</span>{note ? <span class="rd">{note}</span>}</th>` with the note `'Claude answered a message from another agent'` for `peer` only. The box `aria-label`s stay `${CASE_LABELS[c]}: ${CHANNEL_LABELS[ch]}`. The **Even in front** header gets `title="Also while you look at the tab: its sound plays"`. The section loses its old note. CSS: the table fills the card (`width: 100%; border-collapse: collapse`), a `#1C1C21` line between rows; the first column `padding: 10px 8px 10px 16px`, left-aligned; the five box columns `width: 72px; padding: 10px 2px`, centred; the column headers 11 px, `var(--text-3)`, 400 weight, `line-height: 1.25`; the row header's `.rd` on its own line (`display: block`); boxes 16×16 with the accent. (At the 560 px minimum the table must not overflow: 5 × 76 px plus the first column fits 502 px.)
  - **Sound** becomes `cardSection({ title: 'Sound', key: 'notifications.sound', … })`: choices `system` — title `ct.platform === 'win32' ? 'Windows default' : 'System sound'`, note "The sound your system uses for notifications", art `<span class="ico">{icon('volume', 17)}</span>`; `custom` — title "Custom .wav", note `soundChoice(v.settings.notifications.sound).custom ? its path : 'Pick a file; it plays for every case above'`, `noteClass: 'sound-path'`, art `<span class="ico">{icon('music', 17)}</span>`; `selected` = `'custom'` when `soundChoice(…).custom`, else `'system'`; `pick('system')` saves `'system'` unless it is chosen; `pick('custom')` always opens the picker (`ct.pickSound()`; a file is saved; cancelled → `showAll()`). `after` = `<div class="sound-play"><button type="button" class="ghost">{icon('play', 12)}Play</button><span class="rd">Plays the sound in use</span></div>`; the button calls `ct.playSound()`. CSS `.ico { flex: none; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; background: var(--raised-2); border: 1px solid var(--line-2); border-radius: 8px; color: var(--text-2) }`, `.card[aria-checked="true"] .ico { color: var(--accent) }`, `.sound-play { display: flex; align-items: center; gap: 8px; margin-top: 10px }`, a shared `.ghost` button style (transparent, `var(--line-2)` line, 30 px high, radius 7, `color: var(--text-2)`, 500 weight) that the footer button also uses.

- [ ] **Step 1: Change the tests first.** In `tests/e2e/settings.spec.ts`:
  - `the Notifications table has a row for a turn another session started…`: the label check becomes

```ts
  await expect(win.locator('table.notify tbody th .rl')).toHaveText([
    'Claude asks for permission', 'Claude asks a question', 'Claude finished its answer', 'A turn another session started', 'Terminal bell'
  ])
  await expect(win.locator('table.notify tbody th .rd')).toHaveText(['Claude answered a message from another agent'])
  await expect(win.locator('table.notify thead th', { hasText: 'Even in front' })).toHaveAttribute('title', 'Also while you look at the tab: its sound plays')
```

  - `Browse saves the picked .wav; Windows default goes back to the system sound` → rename `Custom .wav picks and saves a .wav; the system card goes back to the system sound` and use the cards:

```ts
  const system = win.locator('[data-key="notifications.sound"][data-value="system"]')
  const custom = win.locator('[data-key="notifications.sound"][data-value="custom"]')
  await expect(system).toHaveAttribute('aria-checked', 'true')
  await expect(win.locator('.sound-path')).toHaveText('Pick a file; it plays for every case above')
  await custom.click()
  await expect.poll(() => readSettings(dataDir).notifications?.sound).toBe(wav)
  await expect(win.locator('.sound-path')).toHaveText(wav)
  await expect(custom).toHaveAttribute('aria-checked', 'true')
  await expect(win.getByRole('button', { name: 'Play' })).toBeVisible()
  await system.click()
  await expect.poll(() => readSettings(dataDir).notifications?.sound).toBe('system')
  await expect(win.locator('.sound-path')).toHaveText('Pick a file; it plays for every case above')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build`, `npx playwright test tests/e2e/settings.spec.ts --reporter=line --workers=2 -g "Notifications table|Custom .wav"` — Expected: FAIL.

- [ ] **Step 3: Implement** the table, the sound cards, the CSS.

- [ ] **Step 4: Run the spec**

Run: `npm run typecheck`, `npm test`, `npm run build`, `npx playwright test tests/e2e/settings.spec.ts --reporter=line --workers=2` — Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted (the controller snapshots the tree)**

---

### Task 7: Search

**Files:**
- Modify: `src/renderer/settings-page.ts`, `src/renderer/settings.css`
- Test: `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `queryWords`, `matchesQuery`, `matchRanges`, `countLabel` (Task 1); `showTab`, the head and pages (Task 4); `.search-unit` rows and card sections (Tasks 3, 5).

What to build in `settings-page.ts`:
  - **Units.** Rows and card sections already are `.search-unit` with `data-search`. Mark three whole sections as units with `markUnit(section, extra)`: it adds `search-unit`, sets `data-search` to the section's `textContent` at build time plus `extra`, and removes `search-unit` from every element inside it. The notifications table's section (`extra` = `'notifications sound flash banner tab front'`), the Accounts section and the Devices section (`extra` = `''`).
  - **Crumbs.** Every `h2.section-title` inside a page gets `<span class="crumb">{tab name}{icon('chevron-right', 10)}</span>` appended (so its first child stays the title text). CSS: `.crumb { display: none; order: -1; align-items: center; gap: 6px }`, `body.searching .crumb { display: inline-flex }`.
  - **The head.** In the search label, after the input: `<span class="search-count" hidden></span>` and `<button type="button" class="search-clear" aria-label="Clear the search" hidden>{icon('x', 11)}</button>` before the `kbd`. A first nav button `<button type="button" class="settings-tab" data-tab="results" hidden>All results<span class="n"></span></button>`; every other tab gets `<span class="n" hidden></span>`. After the pages: `<p class="search-empty" hidden>No settings match</p>` and `<p class="search-hint rd" hidden>Esc clears the search</p>`.
  - **`applySearch()`**, run on the field's `input` event and at the end of `render` (a hand edit keeps the results): with no words, `body` loses `searching`, every unit and section is shown, the marks are removed, the count, the clear button, the results tab, the badges, the empty and hint lines are hidden, the `kbd` shown, and `showTab(current)` puts back the tab you were on. With words: `body.searching`; for each unit `hidden = !matchesQuery(unit.dataset.search!, words)`; a `.settings-section` with no shown unit (and not a unit itself) is hidden; the slot stays hidden; counts per page; a page is shown when the filter is `'results'` or its own id; `.search-count` = `countLabel(total)`; the results tab shown, its badge = total; every other tab's badge = its count (hidden at 0), and a tab with 0 gets class `none` and `disabled`; the empty line shows at 0, the hint above 0; the clear button shown, the `kbd` hidden; the `aria-current` is on the filter's tab. Marks: first unwrap every `mark.search-hit` (`replaceWith(textContent)`, then `normalize()` the parent); then in every shown unit, for each `.rl, .rd, .ct, .cd` element, each direct text-node child is split by `matchRanges(text, words)` into text and `<mark class="search-hit">` pieces.
  - **The filter.** Starting a search sets the filter to `'results'`. Clicking a tab while searching sets the filter to that tab (`'results'` included) and re-runs `applySearch`; clicking a tab with no search calls `showTab` as before (and sets `current`).
  - **Keys.** Esc: when the field has text, clear it and run `applySearch` (prevent the default), wherever the focus is; else close the window as today. `Ctrl+F` (`metaKey` instead on macOS, no Shift or Alt) focuses and selects the field. The clear button does what Esc does with text, and focuses the field.
  - **Opening at a section** (`showSection`) clears the field and runs `applySearch` before `showTab`.
  - CSS: `.settings-tab .n { min-width: 16px; padding: 0 5px; border-radius: 8px; background: var(--line-2); color: var(--text); font-size: 10.5px; font-weight: 600; line-height: 16px; text-align: center }`, `.settings-tab[data-tab="results"] .n { background: var(--accent); color: var(--ground) }`, `.settings-tab.none { opacity: 0.45; cursor: default }`, `mark.search-hit { padding: 0 1px; border-radius: 3px; background: color-mix(in srgb, var(--accent) 25%, transparent); color: var(--text) }`, `.search-clear { width: 24px; height: 24px; padding: 0; display: flex; align-items: center; justify-content: center; background: var(--raised-2); border: 0; border-radius: 6px; color: var(--text-2) }`, `.search-count { color: var(--text-3); font-size: 12px }`, `.settings-search:focus-within { border-color: color-mix(in srgb, var(--accent) 40%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent) }`, `.search-empty, .search-hint { margin: 0; text-align: center; color: var(--text-3) }`.

- [ ] **Step 1: Write the failing tests** in `tests/e2e/settings.spec.ts` (`MAC` is already imported):

```ts
/** types in the search field of a Settings window */
async function search(win: Page, text: string): Promise<void> {
  await win.locator('#settings-search').fill(text)
}

test('search shows the matching settings of every tab, marked, counted, and they work in place', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await search(win, 'scrollback')
  await expect(win.locator('.search-count')).toHaveText('1 setting')
  await expect(win.locator('#settings-nav [data-tab="results"]')).toHaveAttribute('aria-current', 'page')
  await expect(win.locator('#settings-nav [data-tab="results"] .n')).toHaveText('1')
  await expect(win.locator('#settings-nav [data-tab="appearance"] .n')).toHaveText('1')
  await expect(win.locator('#settings-nav [data-tab="general"]')).toBeDisabled()
  const row = win.locator('.row', { has: win.locator('[data-key="scrollback"]') })
  await expect(row).toBeVisible()
  await expect(row.locator('mark')).toHaveText('Scrollback')
  await expect(win.locator('[data-key="font.size"]')).toBeHidden()
  await expect(win.locator('.settings-section', { has: row }).locator('.crumb')).toHaveText('Appearance')
  await win.locator('[data-key="scrollback"]').fill('5000')
  await win.locator('[data-key="scrollback"]').press('Enter')
  await expect.poll(() => readSettings(dataDir).scrollback).toBe(5000)
  await app.close()
})

test('every word must match, a settings.json key finds its setting, and no match says so', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await search(win, 'refresh every')
  await expect(win.locator('.search-count')).toHaveText('1 setting')
  await expect(win.locator('[data-key="claude.statusRefreshInterval"]')).toBeVisible()
  await expect(win.locator('[data-key="claude.statusRefresh"]')).toBeHidden()
  await search(win, 'statusRefreshInterval')
  await expect(win.locator('.search-count')).toHaveText('1 setting')
  await search(win, 'zzzqqq')
  await expect(win.locator('.search-count')).toHaveText('No settings')
  await expect(win.locator('.search-empty')).toBeVisible()
  await expect(win.locator('#settings-nav [data-tab="claude"]')).toBeDisabled()
  await app.close()
})

test('a tab narrows the results; the clear button and Esc go back to the tab you were on; Esc again closes', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page, 'panels')
  await search(win, 'refresh every')
  await win.locator('#settings-nav [data-tab="claude"]').click()
  await expect(win.locator('#settings-nav [data-tab="claude"]')).toHaveAttribute('aria-current', 'page')
  await expect(win.locator('#settings-nav [data-tab="results"]')).toBeVisible()
  await win.locator('.search-clear').click()
  await expect(win.locator('#settings-search')).toHaveValue('')
  await expect(win.locator('#settings-nav [data-tab="results"]')).toBeHidden()
  await expect(win.locator('#settings-nav [data-tab="panels"]')).toHaveAttribute('aria-current', 'page')
  await expect(win.locator('[data-key="font.size"]')).toBeHidden()
  await search(win, 'scrollback')
  await win.locator('[data-key="scrollback"]').click()
  await win.keyboard.press('Escape')
  await expect(win.locator('#settings-search')).toHaveValue('')
  expect(app.windows()).toHaveLength(2)
  const closed = win.waitForEvent('close')
  await win.keyboard.press('Escape').catch(() => {})
  await closed
  await app.close()
})

test('Ctrl+F puts the focus in the search field', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await win.keyboard.press(MAC ? 'Meta+KeyF' : 'Control+KeyF')
  await expect(win.locator('#settings-search')).toBeFocused()
  await app.close()
})

test('a hand edit keeps the search; opening Settings at a section clears it', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await search(win, 'theme')
  await expect(win.locator('.search-count')).toHaveText('1 setting')
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...QUIET, theme: 'Campbell' }))
  await expect(win.locator('[data-key="theme"][data-value="Campbell"]')).toHaveAttribute('aria-checked', 'true')
  await expect(win.locator('.search-count')).toHaveText('1 setting')
  await expect(win.locator('[data-key="font.size"]')).toBeHidden()
  await page.evaluate(() => window.ct.openSettingsWindow('notifications'))
  await expect(win.locator('#settings-search')).toHaveValue('')
  await expect(win.locator('#settings-nav [data-tab="notifications"]')).toHaveAttribute('aria-current', 'page')
  await expect(win.locator('#notifications')).toBeVisible()
  await app.close()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build`, `npx playwright test tests/e2e/settings.spec.ts --reporter=line --workers=2 -g "search|Ctrl\\+F|hand edit keeps"` — Expected: FAIL.

- [ ] **Step 3: Implement** the units, crumbs, head parts, `applySearch`, the filter, the keys, the CSS.

- [ ] **Step 4: Run the specs that open Settings**

Run: `npm run typecheck`, `npm test`, `npm run build`, `npx playwright test tests/e2e/settings.spec.ts tests/e2e/accounts.spec.ts tests/e2e/side-panel.spec.ts --reporter=line --workers=2` — Expected: PASS (the existing `Ctrl+, opens one settings window; Esc closes it` too).

- [ ] **Step 5: Leave the changes uncommitted (the controller snapshots the tree)**

---

### Task 8: README and its Settings picture

**Files:**
- Modify: `README.md`, `tests/screenshots/readme.shots.ts` (`settings window screenshot`)

- [ ] **Step 1: The screenshot test.** In `settings window screenshot`: after the window opens, `await win.locator('#settings-nav [data-tab="appearance"]').click()`, wait for `#settings [data-key="font.size"]` (visible), then emulate `width: 880` and `height` = `document.documentElement.scrollHeight` plus the page's overflow (`#settings`'s `scrollHeight - clientHeight`), poll until `#settings`'s `scrollHeight <= clientHeight`, move the mouse to `(870, 10)`. The rest stays.

- [ ] **Step 2: README.** In `## Settings`, the first sentence becomes: "Press `Ctrl+,` (or **▾ → Settings…**) to open the settings window: tabs for General, Appearance, Claude Code, Notifications, Panels, Accounts and Devices, and a search field (`Ctrl+F`) that finds a setting on any tab and lets you change it right there. Changes apply at once." Then replace the old labels: **Show in the title bar how fast the usage limits are spent** → **Pace of the usage limits**; **Signal a finished answer also while background work… still runs** in Settings → **Signal a finished answer during background work** in Settings → Notifications; **Highlight a Claude tab you leave…** in Settings → **Highlight a tab left unread** in Settings → Notifications; **Continue a response a dropped connection cut off** → **Continue a cut-off response**; "**Tabs** in Settings" → "**Tabs** in Settings → Appearance"; "**Settings → Claude Code** has a checkbox to turn this off" → "**Go on after a restart** in **Settings → Claude Code** turns this off"; "Settings → **Agent messages**" and "Settings → Agent messages" → "Settings → Panels → **Agent messages**" / "Settings → Panels → Agent messages". Check with `grep -n "in Settings\|Settings →" README.md` that no old label is left.

- [ ] **Step 3: Regenerate the pictures**

Run: `npm run screenshots` — Expected: 4 passed; `docs/images/settings.png` shows the Appearance tab.

- [ ] **Step 4: Run every spec that opens Settings once more**

Run: `npm run typecheck`, `npm test`, `npm run build`, `npx playwright test tests/e2e/settings.spec.ts tests/e2e/accounts.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/tab-panel.spec.ts --reporter=line --workers=2` — Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted (the controller snapshots the tree)**
