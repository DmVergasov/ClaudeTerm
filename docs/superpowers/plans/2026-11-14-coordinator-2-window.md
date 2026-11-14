# Project coordinator, part 2 of 3: the window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the window of its own device, the person makes, stops and replaces a coordinator from the tab's menu, sees it and its attached sessions in the tab list and the header, works with its sessions in the Sessions panel (open, message, detach, attach, resolve, New session, Attach…), attaches and detaches tabs by drag and drop, reads each report as a card in the coordinator's chat, and finds tasks and reports named as such in the Agent messages panel.

**Architecture:** The renderer reads part 1's state only through `window.ct`: the marks (`coordMarks` / `onCoordMarks`) drive the tab list, the tab menu and the header; a coordinator's view (`coordView` / `onCoordView`) drives the Sessions panel; every action is one part 1 IPC call whose `CoordResult` error is shown (a toast, or the dialog's error line). The tab list keeps its code and gains two pure functions in `tab-groups.ts`: `arrangeCoordinators` puts a coordinator's attached rows right after it (the window's order write-back makes that the real tab order) and `panelDrop` decides what a drop does. Main gains three small things: a `report` chat item that `ChatHub` puts when a report is handed to a chat tab, a re-publish of the views when the mail setting or the Claude Code version changes, and an `agent-messages` Settings section to link to.

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), plain DOM in the renderer, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-project-coordinator-design.md` — above all "What the person sees (approved mockup, variant A)", "Drag and drop in the tab list" and "States". Part 1, which this plan builds on: `docs/superpowers/plans/2026-11-14-coordinator-1-core.md` — its Task 4 (`src/shared/coordinator.ts`), Task 11 (the IPC and `tests/e2e/coordinator-helpers.ts`) and "Interfaces for parts 2 and 3". The approved mockup's markup and styles: `D:/ct-scratch/projects-mockup/mock-edits.js` (MODE `coordinator` and `session`), screenshots `D:/ct-scratch/projects-mockup/v2/shot-coordinator.png`, `shot-session.png`. Rules: `AGENTS.md`.

## Global Constraints

- Everything in AGENTS.md applies: English comments and UI strings, no UI framework, match the surrounding code, keep each file's line endings (a new file takes those of the files beside it), tests at the right level.
- Commit steps run only when the controller allows commits; until then leave the work in the working tree.
- Part 1's names are used exactly: `CoordinatorView`, `CoordSessionRow` (`key`, `tabId`, `device`, `deviceName`, `ref`, `name`, `folder`, `branch`, `group`, `why`, `marker`, `line`, `progress`, `changedAt`, `lastReport`, `attachedTo`), `CoordGroup`, `CoordMark`, `CoordMarks`, `CoordResult`, `CoordStartRequest`, `isWorktreeName`, `COORD_TASK_MAX`, `COORD_NAME_MAX` (`src/shared/coordinator.ts`); `MailMessageView.kind/outcome/reason`, `ReportOutcome` (`src/shared/mail.ts`); `window.ct.coordView`, `onCoordView`, `coordMarks`, `onCoordMarks`, `coordMake`, `coordStop`, `coordAttach`, `coordDetach`, `coordMessage`, `coordResolve`, `coordNewSession`. The e2e tests use part 1's `tests/e2e/coordinator-helpers.ts` (`coordApp`, `claudeTabIn`, `coord`, `makeCoordinator`, `turnOf`, `done`, `within`, `stillWaiting`) and drive the state through its real entry points: the `coord` pipe message and `window.ct.*`.
- This device only. Remote tabs are never offered a drop-to-attach; a row's device chip is drawn only when `row.deviceName !== null` (part 3 feeds it); a row's `marker` is drawn generically (`starting` and `attaching` spin, `offline` is a grey dot).
- The look reuses the app's classes and theme variables (no new colour values): the tab rows (`.tp-*`, `.tab`), the panel (`.panel-*`), the header toggles, the MCP Add dialog (`mcp-add-scrim`, `mcp-add`, `mcp-add-head`, `mcp-add-title`, `mcp-ghost`, `mcp-add-body`, `mcp-add-label`, `mcp-add-field`, `mcp-add-name`, `mcp-add-bottom`, `mcp-add-actions`, `mcp-btn`, `mcp-add-error`), the chat's agents block (`chat-agents`, `chat-agents-head`, `chat-step-state`, `chat-button`, `chat-text`). The new classes are the mockup's `mk-*` renamed: `coord-*` in the panel, the dialogs and the report card; `tab-coord`, `tp-coord-to`, `sh-coord`, `sh-reports`, `sh-detach`, `mail-kind`.
- Text from main (names, projects, folders, lines, report texts) is set as text (`textContent`), never as markup; a report's Markdown goes through `chatMarkdownHtml` only.
- Every UI string is exactly as written in the task that introduces it.
- The left panel and the tab bar rebuild their rows on every render, and the Sessions panel rebuilds its rows on every view: e2e tests read rows in one `evaluate`, drag with `page.mouse`, and retry a drag with `expect(...).toPass()`. Tests use invented projects and names, files under `tmpdir()` only, and close the app in `finally`.

## Review Focus

1. **Redraws under the person's hands:** the views change whenever a session works or waits, so the Sessions panel redraws while the person types a task into it — the Message box keeps its draft and its focus (Task 5 test `the Message box keeps its draft and its focus while the rows change`).
2. **Keys typed into the panel's box or a dialog never reach the tab:** Esc there would interrupt Claude (part 1 ends the task as stopped) — Task 2 test `Esc closes the replace question and types nothing into the tab`, Task 5 and Task 6 tests on Esc.
3. **Untrusted names and report texts:** a tab renamed to markup, and a report with HTML in it, show as text — Task 4 test `a session name with markup in it shows as text`, Task 8 unit test on `splitWake` and e2e on the card body.
4. **Wake texts that mix kinds or quote a header line:** a prompt-delivered wake holds a report and a plain message, or a report quotes a "Report from…" line — Task 8 unit tests `splitWake keeps the other blocks as the rest` and `a quoted header line stays in its report's text`.
5. **The coordinator stopped while its panel or a dialog is open:** the panel leaves, and a dialog's action answers with main's refusal instead of failing silently — Task 4 test `stopping the coordinator takes the Sessions panel away`, Task 6 test `a dialog of a coordinator that stopped shows main's refusal`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/renderer/tab-groups.ts` (modify) | `arrangeCoordinators`, the block marks on rows; `dropAttaches`, `panelDrop` |
| `src/renderer/tabbar.ts`, `tab-row.ts`, `tab-panel.ts` (modify) | `TabBarItem.coord`, the Coordinator label, the indented block, `↳ <project>`, the drops |
| `src/renderer/coord-dialog.ts` (create) | a modal in the app's dialog style; a yes/no question |
| `src/renderer/coord-dialogs.ts` (create) | New session and Attach… |
| `src/renderer/sessions-model.ts` (create) | the panel's pure logic: sections, icons, actions, times, the start form, the attach choices |
| `src/renderer/sessions-panel.ts` (create) | the Sessions panel |
| `src/renderer/side-panel.ts`, `sheet-header.ts` (modify) | the `sessions` panel tab; the toggle, its badge, the header lines and Detach |
| `src/renderer/main.ts` (modify) | the marks and views, the tab menu items, the wiring of every part |
| `src/renderer/mail-panel.ts`, `util.ts` (modify) | `kindLabel`; `labelOf` moves to `util.ts` |
| `src/shared/report-wake.ts` (create) | reading the report blocks of a wake text; `outcomeText` |
| `src/shared/chat.ts`, `src/main/chat/report-item.ts` (create), `src/main/chat/chat-hub.ts` (modify) | the `report` chat item and its putting |
| `src/renderer/chat/report-card.ts` (create), `chat-items.ts`, `chat-find.ts`, `chat-view.ts` (modify) | the report card |
| `src/main/index.ts`, `src/shared/ipc.ts`, `src/renderer/settings-page.ts` (modify) | report cards on hand-over; re-publish on setting and version changes; the `agent-messages` section |
| `src/renderer/styles.css`, `src/renderer/chat/chat.css` (modify) | the new classes |
| `tests/e2e/coordinator-window.ts` (create) | e2e helpers of this plan |

---

### Task 1: The marks in the window, and the tab list's coordinator block

**Files:**
- Modify: `src/renderer/tab-groups.ts` (types :6-8; new functions after `moveInGroup` :230-244)
- Modify: `src/renderer/tabbar.ts` (`TabBarItem` :10-41, `visualOrder` :122-125, `render` :131-149, `renderTab` :234-260, `dropOn` :266-285)
- Modify: `src/renderer/tab-row.ts` (`TabParts` :84-90, `tabParts` :98-152)
- Modify: `src/renderer/tab-panel.ts` (`sections` :139-148, `renderRow` :276-328)
- Modify: `src/renderer/main.ts` (state after :101, `tabBarItem` :202-227, boot after the `onTabPlace` subscription :1380-1390)
- Modify: `src/renderer/styles.css` (after the `.tp-branch` rules :193-195)
- Create: `tests/e2e/coordinator-window.ts`, `tests/e2e/coordinator-tabs.spec.ts`
- Test: `tests/unit/tab-groups.test.ts`

**Interfaces:**
- Consumes: `CoordMark`, `CoordMarks` (`src/shared/coordinator.ts`); `ct.coordMarks()`, `ct.onCoordMarks(cb)`.
- Produces (`src/renderer/tab-groups.ts`):
  ```ts
  export interface PanelRow {
    id: string; fork: boolean
    /** the row stands in a coordinator's block: the coordinator's tab id; absent outside one */
    block?: string
    /** a row of the block other than the coordinator's family: an attached session (or a fork of one), drawn indented */
    attached?: true
  }
  /**
   * Each group that holds a coordinator (a row whose mark is { role: 'coordinator' }): the units whose first row is attached to
   * it (mark { role: 'attached', coordinatorTabId: <its id> }) move right after the coordinator's unit, in their order; the
   * coordinator's unit gets `block`, the moved units `block` and `attached`. A unit is a row and the fork rows after it when
   * `families` (the left panel), a single row otherwise (the tab bar). A group without a coordinator is returned as it is.
   */
  export function arrangeCoordinators(groups: PanelGroup[], coordOf: (id: string) => CoordMark | null, families: boolean): PanelGroup[]
  ```
- Produces (`src/renderer/tabbar.ts`): `TabBarItem.coord: CoordMark | null` — "the tab's part in a coordinator of this device; null: none". `visualOrder` is `panelOrder(arrangeCoordinators(storedGroups(own), coordOf, false))`; `render` and `dropOn` use the same arranged groups.
- Produces (`src/renderer/tab-row.ts`): `TabParts.coord: HTMLElement | null` — for `item.coord?.role === 'coordinator'` a `<span class="tab-coord">Coordinator</span>` with `title` `` `Coordinator of ${project}` ``; drawn right after the title, before the marks, in the pill and in the row.
- Produces (`src/renderer/main.ts`): `let coordMarks: CoordMarks = {}`; `const coordMarkOf = (id: string | null): CoordMark | null`; `function applyMarks(m: CoordMarks): void` (sets `coordMarks`, then `renderTabs()`; later tasks add to it). Boot subscribes `ct.onCoordMarks` (sets a `coordMarksSeen` flag, then `applyMarks`) and then asks `ct.coordMarks()`, applied only when no event came first (as `remoteDevicesSeen` does for the devices). `tabBarItem` sets `coord: coordMarkOf(id)`.
- Produces (`tests/e2e/coordinator-window.ts`):
  ```ts
  /** coordApp's settings with the tabs in the left panel */
  export const LEFT = { ...VERSION_SETTINGS, tabs: { position: 'left' } }
  export const marksOf = (page: Page): Promise<CoordMarks> => page.evaluate(() => window.ct.coordMarks())
  export const tabOrder = (page: Page): Promise<string[]> => page.evaluate(() => window.__ct!.tabIds())
  export const pill = (page: Page, id: string): Locator => page.locator(`#tabbar .tab[data-tab-id="${id}"]`)
  export const tpRow = (page: Page, id: string): Locator => page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"]`)
  export interface PanelRowSeen { id: string; attached: boolean; label: string | null; to: string | null }
  /** the left panel's rows in one read (the panel rebuilds them on every render): indented, the Coordinator label, the ↳ mark */
  export function panelRows(page: Page): Promise<PanelRowSeen[]>
  ```

- [ ] **Step 1: Write the failing unit tests** — a new `describe('coordinator blocks')` in `tests/unit/tab-groups.test.ts`, with the file's `tab`, `acme`, `blog`, and:
```ts
const C: CoordMark = { role: 'coordinator', project: 'acme', sessions: 2, waiting: 0 }
const to = (coordinatorTabId: string): CoordMark => ({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId })
const marks = (m: Record<string, CoordMark>) => (id: string): CoordMark | null => m[id] ?? null
/** a row as `A`, `A1 (fork)`, with its block: `A [C attached]` */
const shown = (g: PanelGroup): string[] => g.rows.map((r) => `${r.id}${r.fork ? ' (fork)' : ''}${r.block ? ` [${r.block}${r.attached ? ' attached' : ''}]` : ''}`)

it('the attached tabs of the coordinator\'s group come right after it, in their tab order, and the block is marked', () => {
  const g = arrangeCoordinators(panelGroups([tab('A1', acme), tab('C', acme), tab('X', acme), tab('A2', acme)]), marks({ C, A1: to('C'), A2: to('C') }), true)
  expect(shown(g[0])).toEqual(['C [C]', 'A1 [C attached]', 'A2 [C attached]', 'X'])
})
it('a tab attached from another group, or to a coordinator that is not in its group, keeps its place and has no block', () => {
  const g = arrangeCoordinators(panelGroups([tab('C', acme), tab('B', blog), tab('Y', acme)]), marks({ C, B: to('C'), Y: to('Z') }), true)
  expect(shown(g[0])).toEqual(['C [C]', 'Y'])
  expect(shown(g[1])).toEqual(['B'])
})
it('with families an attached tab brings its forks, and the coordinator keeps its own', () => {
  const g = arrangeCoordinators(panelGroups([tab('A', acme), tab('C', acme), tab('A1', acme, 'A'), tab('C1', acme, 'C')]), marks({ C, A: to('C') }), true)
  expect(shown(g[0])).toEqual(['C [C]', 'C1 (fork) [C]', 'A [C attached]', 'A1 (fork) [C attached]'])
})
it('without families (the tab bar) each tab moves alone, a fork too', () => {
  const g = arrangeCoordinators(storedGroups([tab('F', acme, 'X'), tab('X', acme), tab('C', acme)]), marks({ C, F: to('C') }), false)
  expect(g[0].rows.map((r) => r.id)).toEqual(['X', 'C', 'F'])
})
it('arranging the order it gave changes nothing, so the written order stays', () => {
  const m = marks({ C, A2: to('C') })
  const once = panelOrder(arrangeCoordinators(panelGroups(['A2', 'X', 'C'].map((id) => tab(id, acme))), m, true))
  expect(once).toEqual(['X', 'C', 'A2'])
  expect(panelOrder(arrangeCoordinators(panelGroups(once.map((id) => tab(id, acme))), m, true))).toEqual(once)
})
it('a group without a coordinator is the same', () => {
  const groups = panelGroups([tab('A', acme), tab('B', acme)])
  expect(arrangeCoordinators(groups, marks({ B: to('Z') }), true)).toEqual(groups)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/tab-groups.test.ts`
Expected: FAIL (`arrangeCoordinators` is not exported).

- [ ] **Step 3: Implement `arrangeCoordinators`** as its comment says (units of a group: with `families` a row that is not a fork starts a unit and the fork rows after it join it, a leading fork row is a unit of its own; without, every row is a unit). Copy rows when adding `block` / `attached`; never mutate the input.

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run tests/unit/tab-groups.test.ts tests/unit/tab-panel-devices.test.ts`
Expected: PASS, the existing ones included.

- [ ] **Step 5: Write the failing e2e tests** — `tests/e2e/coordinator-window.ts` as in Interfaces (`panelRows` maps each `#tabpanel .tp-tab` to `{ id: dataset.tabId, attached: classList.contains('coord-attached'), label: .tab-coord text or null, to: .tp-coord-to text or null }`), and `tests/e2e/coordinator-tabs.spec.ts` (`const expect = baseExpect.configure({ timeout: 15_000 })`):
```ts
test('the coordinator\'s row is labelled, its attached sessions of the project follow it indented, and one of another project shows where it reports', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, pipeName, tabs: [t0, t1, t2], sids, repo } = l
  try {
    const other = await claudeTabIn(l, gitRepo())
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2, other.tabId])
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[2]) })).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(other.sid) })).toMatchObject({ ok: true })
    // the block is the real tab order: the window wrote it back
    await expect.poll(() => tabOrder(page)).toEqual([t0, t2, t1, other.tabId])
    await expect.poll(() => panelRows(page)).toEqual([
      { id: t0, attached: false, label: 'Coordinator', to: null },
      { id: t2, attached: true, label: null, to: null },
      { id: t1, attached: false, label: null, to: null },
      { id: other.tabId, attached: false, label: null, to: `↳ ${basename(repo)}` }
    ])
  } finally { await l.app.close() }
})
test('a detached row is an ordinary row again, where it stands', async () => {
  // as above with t2 attached; then coord(pipeName, t0, { op: 'detach', session: refOf(sids[2]) })
  // → panelRows: t2 { attached: false, label: null, to: null }; tabOrder stays [t0, t2, t1]
})
test('tabs at the top: the coordinator\'s tab carries the mark, its attached tab moves next to it, nothing is indented or marked ↳', async () => {
  // coordApp(3) (tabs on top); makeCoordinator(t0); attach refOf(sids[2])
  // → expect.poll(tabOrder).toEqual([t0, t2, t1]); pill(page, t0).locator('.tab-coord') has text 'Coordinator';
  //   page.locator('#tabbar .tp-coord-to') and '#tabbar .coord-attached' have count 0
})
```

- [ ] **Step 6: Run them to see them fail**

Run: `npm run build && node scripts/e2e.mjs coordinator-tabs.spec.ts`
Expected: FAIL (no `.tab-coord`; the order stays `[t0, t1, t2, …]`).

- [ ] **Step 7: Implement the window's part**
  - `main.ts`: the state, `applyMarks`, the subscription and `coord: coordMarkOf(id)` (Interfaces).
  - `tab-row.ts`: `TabParts.coord`.
  - `tabbar.ts`: `TabBarItem.coord`; the arranged groups in `visualOrder`, `render` and `dropOn` (`coordOf` from the items); `renderTab` appends `parts.coord` after `parts.label`.
  - `tab-panel.ts`: `sections()` arranges each section's groups (`families: true`, `coordOf` from `this.items`), so `visualOrder`, `deviceOrder`, `unfoldFor` and `draw` all see the block; `renderRow` adds the class `coord-attached` when `row.attached`, appends `parts.coord` after the title, and for `item.coord?.role === 'attached'` on a row with no `block` appends `<span class="tp-coord-to">` with `` `↳ ${item.coord.project}` `` (title `` `Reports to the ${item.coord.project} coordinator` ``) at the end of the `.tp-branch` line, or of a new `.tp-branch` line without the branch icon when the row has no place.
  - `styles.css`, after `.tp-branch svg`:
  ```css
  /* the coordinator's label, its block of attached rows with their guide line, and an attached row elsewhere */
  .tab-coord { flex: none; margin-left: 6px; color: var(--accent); font-size: 11px; white-space: nowrap; }
  .tp-tab.coord-attached { margin-left: 16px; }
  .tp-tab.coord-attached::before { content: ''; position: absolute; left: -9px; top: -3px; bottom: -3px; border-left: 1px solid var(--line-3); }
  .tp-coord-to { flex: none; margin-left: 6px; color: var(--text-3); font-size: 11px; white-space: nowrap; }
  ```

- [ ] **Step 8: Run the tests and the type check**

Run: `npm run typecheck && npx vitest run tests/unit/tab-groups.test.ts && npm run build && node scripts/e2e.mjs coordinator-tabs.spec.ts tab-panel.spec.ts tabs.spec.ts`
Expected: PASS (tab-panel.spec.ts:311 fails about 15 % of runs on Windows on master too: rerun it alone before blaming this task).

- [ ] **Step 9: Commit**
```bash
git add src/renderer/tab-groups.ts src/renderer/tabbar.ts src/renderer/tab-row.ts src/renderer/tab-panel.ts src/renderer/main.ts src/renderer/styles.css tests/unit/tab-groups.test.ts tests/e2e/coordinator-window.ts tests/e2e/coordinator-tabs.spec.ts
git commit -m "feat: the tab list shows a coordinator and its attached sessions"
```

---

### Task 2: The tab menu — Make project coordinator, Stop coordinating, Detach; the replace question

**Files:**
- Create: `src/renderer/coord-dialog.ts`
- Modify: `src/renderer/main.ts` (`tabMenu` :1191-1220; new functions beside it; state beside `coordMarks`)
- Modify: `src/renderer/styles.css` (append)
- Modify: `tests/e2e/coordinator-window.ts`
- Create: `tests/e2e/coordinator-menu.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`coordMarks`, `coordMarkOf`, `marksOf`, `pill`); `places` (main.ts :83); `ct.coordMake`, `ct.coordStop`, `ct.coordDetach`, `ct.coordView`, `ct.onCoordView`.
- Produces (`src/renderer/coord-dialog.ts`):
  ```ts
  export interface DialogOptions {
    /** the card's data-dialog, for the tests and the styles */
    id: string
    title: string
    body: HTMLElement[]
    /** the primary button's label; null: the dialog has Cancel only */
    action: string | null
    /** the primary button, Enter in an input, Ctrl/Cmd+Enter in a textarea: answers the error to show, or null to close */
    submit?: () => Promise<string | null>
    /** whether the primary button is enabled now: asked on every input event inside the dialog */
    ready?: () => boolean
    /** the dialog closed, by any way */
    closed?: () => void
  }
  export interface DialogHandle { close(): void; error(text: string): void; busy(on: boolean, label?: string): void }
  /** a modal in the MCP Add dialog's style, on document.body; its keys stay in it, Escape and a click on the scrim close it */
  export function openDialog(o: DialogOptions): DialogHandle
  /** a yes/no question in that style: true when its action was clicked */
  export function confirmDialog(o: { id: string; title: string; text: string; action: string }): Promise<boolean>
  ```
  Markup: `div.mcp-add-scrim > div.mcp-add.coord-dialog[data-dialog=<id>][role=dialog][aria-modal=true]` holding `div.mcp-add-head` (`h2.mcp-add-title`, a `button.mcp-ghost` ✕ with aria-label `Close`), `div.mcp-add-body` (the body), `div.mcp-add-bottom > div.mcp-add-actions` (`button.mcp-btn.ghost` `Cancel`, then `button.mcp-btn.primary` with the action when there is one) and `div.mcp-add-error`. The scrim's `keydown` always calls `stopPropagation()`. While `busy(true, label)` both buttons are disabled and the action shows `label`. Focus on open: the first input or textarea of the body, else the action, else Cancel; on close the focus goes back to the element that had it. `confirmDialog`'s body is `div.coord-dialog-text` with the text.
- Produces (`src/renderer/main.ts`):
  ```ts
  /** each coordinator tab's view, as main last published it or answered for it */
  const coordViews = new Map<string, CoordinatorView>()
  /** a coordinator's view: the one held, else asked for and held; null when the tab is no coordinator */
  async function coordViewOf(tabId: string): Promise<CoordinatorView | null>
  /** a failed CoordResult as a toast */
  function toastFailure(r: CoordResult): void
  /** Detach of an attached tab (its menu, its header, a drag out of its block): the coordinator's view names its row */
  async function detachFromCoordinator(tabId: string): Promise<void>
  /** Make project coordinator: a replace asks first */
  async function makeCoordinatorFrom(tabId: string): Promise<void>
  ```
  Boot subscribes `ct.onCoordView((tabId, view) => …)`: a view is held in `coordViews`, `null` deletes it (later tasks add to this handler).
- Produces (`tests/e2e/coordinator-window.ts`):
  ```ts
  /** right-clicks the tab (a pill on top, a row on the left) until its menu offers the item enabled, then clicks it */
  export async function menuItem(page: Page, tabId: string, label: string): Promise<void>
  ```
  (Its body: `const tab = page.locator(`#tabbar .tab[data-tab-id="${tabId}"]:visible, #tabpanel .tp-tab[data-tab-id="${tabId}"]:visible`).first()`, `const item = page.locator('.menu .menu-item:not(.disabled)', { hasText: label })`, then `await expect(async () => { await tab.click({ button: 'right' }); await expect(item).toBeVisible({ timeout: 1000 }) }).toPass({ timeout: 15_000 })` and `await item.click()`; a second right-click replaces the menu, so no Escape is pressed.)

- [ ] **Step 1: Write the failing e2e tests** — `tests/e2e/coordinator-menu.spec.ts`:
```ts
test('Make project coordinator makes a Claude tab of a git project its coordinator; Stop coordinating ends it', async () => {
  const l = await coordApp(2)
  const { page, tabs: [t0] } = l
  try {
    await menuItem(page, t0, 'Make project coordinator')
    await expect(pill(page, t0).locator('.tab-coord')).toHaveText('Coordinator')
    expect((await marksOf(page))[t0]).toMatchObject({ role: 'coordinator' })
    await menuItem(page, t0, 'Stop coordinating')
    await expect(pill(page, t0).locator('.tab-coord')).toHaveCount(0)
    expect((await marksOf(page))[t0]).toBeUndefined()
  } finally { await l.app.close() }
})
test('a second tab of the project asks before it replaces the coordinator: Cancel keeps it, Replace moves its sessions', async () => {
  const l = await coordApp(3)
  const { page, pipeName, tabs: [t0, t1, t2], sids, repo } = l
  try {
    await makeCoordinator(page, t0)
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[2]) })
    const dialog = page.locator('.coord-dialog[data-dialog="replace"]')
    await menuItem(page, t1, 'Make project coordinator')
    await expect(dialog.locator('.mcp-add-title')).toHaveText(`Replace the coordinator of ${basename(repo)}?`)
    await dialog.locator('button', { hasText: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect((await marksOf(page))[t0]).toMatchObject({ role: 'coordinator' })
    await menuItem(page, t1, 'Make project coordinator')
    await dialog.locator('button', { hasText: 'Replace' }).click()
    await expect.poll(async () => (await marksOf(page))[t1]?.role).toBe('coordinator')
    const marks = await marksOf(page)
    expect(marks[t0]).toBeUndefined()
    expect(marks[t2]).toMatchObject({ role: 'attached', coordinatorTabId: t1 })
  } finally { await l.app.close() }
})
test('Esc closes the replace question and types nothing into the tab', async () => {
  // as above up to the dialog; const before = await page.evaluate((id) => window.__ct!.ptyInput!(id), t1);
  // page.keyboard.press('Escape') → dialog count 0; ptyInput(t1) still equals before; marks[t0] still the coordinator
})
test('an attached tab\'s menu detaches it from its coordinator', async () => {
  // coordApp(2); makeCoordinator(t0); attach refOf(sids[1]); poll marks[t1].role 'attached'
  // menuItem(page, t1, `Detach from the ${basename(repo)} coordinator`) → poll marks[t1] toBeUndefined()
})
test('a shell tab and a Claude tab outside git have no coordinator item', async () => {
  // coordApp(1); const shell = await openTabInFront(page, 'shell', repo);
  // const plain = await claudeTabIn(l, mkdtempSync(join(tmpdir(), 'ct-plain-')));
  // poll page.evaluate((id) => window.__ct!.placeOf!(id) === null, plain.tabId) → true
  // for each of shell and plain.tabId: right-click its pill, then
  //   expect(await page.locator('.menu .menu-item').allTextContents()).not.toContain('Make project coordinator')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && node scripts/e2e.mjs coordinator-menu.spec.ts`
Expected: FAIL (the menu has no such item).

- [ ] **Step 3: Implement**
  - `coord-dialog.ts` as in Interfaces; `styles.css` gains:
  ```css
  /* the coordinator's dialogs, in the MCP Add dialog's style */
  .coord-dialog { width: 460px; }
  .coord-dialog-text { color: var(--text-2); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  ```
  - `tabMenu`: a block before the last separator and `Close tab`, for a local Claude tab (`claude && !t.info.remote`), preceded by a separator when it has items:
    - mark `attached` with `coordinatorTabId !== null` → `` `Detach from the ${mark.project} coordinator` `` → `detachFromCoordinator(id)`;
    - mark `coordinator` → `Stop coordinating` → `ct.coordStop(id).then(toastFailure)`;
    - else, when `places.get(id)` is a place (not null, not undefined) → `Make project coordinator`, `disabled` while `sessionId === null` → `makeCoordinatorFrom(id)`.
  - `makeCoordinatorFrom(tabId)`: `ct.coordMake(tabId, false)`; `{ ok: false, replaces }` → `confirmDialog({ id: 'replace', title: `Replace the coordinator of ${project}?`, text: `${replaces} coordinates ${project} now. This tab takes over its sessions and their open tasks.`, action: 'Replace' })` with `project = places.get(tabId)?.project.name ?? 'this project'`; true → `ct.coordMake(tabId, true)` → `toastFailure`; any other failure → `toastFailure`.
  - `detachFromCoordinator(tabId)`: the mark must be `attached` with a `coordinatorTabId`; `coordViewOf` it; the row with `row.tabId === tabId`; none → `showToast('This session is not attached to a coordinator here.')`; else `ct.coordDetach(coordinatorTabId, row.key).then(toastFailure)`.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm run build && node scripts/e2e.mjs coordinator-menu.spec.ts coordinator-tabs.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/renderer/coord-dialog.ts src/renderer/main.ts src/renderer/styles.css tests/e2e/coordinator-window.ts tests/e2e/coordinator-menu.spec.ts
git commit -m "feat: the tab menu makes, stops and replaces a coordinator, and detaches a session"
```

---

### Task 3: The header — the Sessions toggle and its badge, the coordinator's line, the attached session's line and Detach

**Files:**
- Modify: `src/renderer/side-panel.ts` (:4-9, :36, :63-77)
- Modify: `src/renderer/sheet-header.ts` (`signature` :12-16, callbacks :18, toggles :90-95, setters after `setMessages` :242-246, `drawLeft` :277-319)
- Modify: `src/renderer/tabbar.ts` (`TabBarCallbacks` :60-82)
- Modify: `src/renderer/main.ts` (`refreshPanelButtons` :315-328, `activate` :1040-1081, `tabCallbacks` :1301-1346, `SidePanel` widths :1551, `applyMarks`)
- Modify: `src/renderer/styles.css` (:70-71, :145-150; append)
- Modify: `tests/e2e/coordinator-window.ts`
- Create: `tests/e2e/coordinator-header.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`TabBarItem.coord`, `coordMarkOf`, `applyMarks`), Task 2 (`detachFromCoordinator`).
- Produces (`side-panel.ts`): `PanelTab` gains `'sessions'` (`TABS` after `'changes'`, `LABELS.sessions = 'Sessions'`, `MAX_SHARE.sessions = 0.7`, unavailable by default, its own body `panel-body panel-sessions` and tools group).
- Produces (`tabbar.ts`): `TabBarCallbacks.toggleSessions(): void` and `TabBarCallbacks.detachTab(id: string): void`; `SheetHeaderCallbacks` picks both.
- Produces (`sheet-header.ts`): a `tab-sessions-toggle` button (`icon('users', 16)`, label `Sessions`, title `Sessions`, with a badge) between Changes and Media; `setSessions(available: boolean, visible: boolean, waiting: number, tab: string | null): void` (as `setMessages`). The left part, keyed by the signature (which adds `item.coord`):
  - `role: 'coordinator'` → right after `.sh-branch`: `<span class="sh-coord">Coordinator · <b>N</b> session(s)</span>` — `N` is `coord.sessions`, `session` when it is 1, else `sessions`;
  - `role: 'attached'` → last: `<span class="sh-reports">↳ Reports to <b>project</b> coordinator</span>`, then, when `coordinatorTabId !== null`, `<button class="sh-detach" type="button">Detach</button>` with title `` `Detach from the ${project} coordinator` `` → `cb.detachTab(item.id)`. All text set as text.
- Produces (`main.ts`): `const SESSIONS_PANEL_WIDTH = 340` (the panel's width, not a setting, beside `MCP_PANEL_WIDTH`); `function syncSessions(): void` — `sidePanel.setAvailable('sessions', coordMarkOf(activeId)?.role === 'coordinator')`, called from `activate` (after `mailPanel.show`) and from `applyMarks` (Task 4 adds the panel to it). `refreshPanelButtons` calls `sheetHeader.setSessions(coordinator, sidePanel.isShowing('sessions'), coordinator ? mark.waiting : 0, activeId)`. `tabCallbacks.toggleSessions` toggles `'sessions'` then focuses the tab, as `toggleMessages` does; `tabCallbacks.detachTab = (id) => void detachFromCoordinator(id)`.
- Produces (`tests/e2e/coordinator-window.ts`):
  ```ts
  export const sessionsToggle = (page: Page): Locator => page.locator('#sheet-header .tab-sessions-toggle')
  /** opens the Sessions panel with its toggle and waits until it has slid in */
  export async function openSessions(page: Page): Promise<void>   // click, then panelSettled(page, true)
  ```

- [ ] **Step 1: Write the failing e2e tests** — `tests/e2e/coordinator-header.spec.ts` (`activate` from `agent-mail.ts`):
```ts
test('a coordinator\'s header counts its sessions and has the Sessions toggle with the number that wait; other tabs have neither', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    await makeCoordinator(page, t0)
    await activate(page, t0)
    await expect(page.locator('#sheet-header .sh-coord')).toHaveText('Coordinator · 0 sessions')
    await expect(sessionsToggle(page)).toBeVisible()
    await expect(sessionsToggle(page).locator('.badge')).toBeHidden()
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })
    await expect(page.locator('#sheet-header .sh-coord')).toHaveText('Coordinator · 1 session')
    await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: t1, sessionId: sids[1], reason: 'permission', prompt: 'Allow Bash: npm test' })
    await expect(sessionsToggle(page).locator('.badge')).toHaveText('1')
    await done(pipeName, t1, sids[1])
    await expect(sessionsToggle(page).locator('.badge')).toBeHidden()
    await activate(page, t1)
    await expect(sessionsToggle(page)).toBeHidden()
    await expect(page.locator('#sheet-header .sh-coord')).toHaveCount(0)
  } finally { await l.app.close() }
})
test('the Sessions toggle opens and closes the Sessions panel', async () => {
  // coordApp(1); makeCoordinator(t0); activate(t0); openSessions(page)
  // → '#image-panel .panel-title' has text 'Sessions'; '#image-panel .panel-sessions' visible; sessionsToggle has class /active/
  // sessionsToggle.click() → '#image-panel' has class /collapsed/
})
test('an attached session\'s header says where it reports, and its Detach detaches it', async () => {
  // coordApp(2); makeCoordinator(t0); attach refOf(sids[1]); activate(t1)
  // → '#sheet-header .sh-reports' has text `↳ Reports to ${basename(repo)} coordinator`
  // '#sheet-header .sh-detach'.click() → poll marks[t1] toBeUndefined(); '.sh-reports' count 0
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && node scripts/e2e.mjs coordinator-header.spec.ts`
Expected: FAIL (no `.sh-coord`, no toggle).

- [ ] **Step 3: Implement** the Interfaces block. `main.ts:1551`: the `SidePanel` widths record gains `sessions: SESSIONS_PANEL_WIDTH`. `styles.css`: add the toggle beside `.tab-messages-toggle` in every selector list that names it — `#sheet-header .tab-sessions-toggle` in the rules at :70, :71 and :148, `.tab-sessions-toggle` (with `:hover`, `.badge`, `.badge[hidden]` as the neighbours have them) in the rules at :145, :146, :149 and :150 — and append:
```css
/* the coordinator's line in its header, and an attached session's line with its Detach */
.sh-coord, .sh-reports { flex: none; color: var(--text-3); font-size: 12px; white-space: nowrap; }
.sh-coord b, .sh-reports b { color: var(--text-2); font-weight: 600; }
.sh-detach { flex: none; padding: 2px 8px; border: 1px solid var(--line-2); border-radius: 6px; background: none; color: var(--text-2); font: inherit; font-size: 12px; cursor: pointer; }
.sh-detach:hover { color: var(--text); }
```

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm run build && node scripts/e2e.mjs coordinator-header.spec.ts side-panel.spec.ts sheet.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/renderer/side-panel.ts src/renderer/sheet-header.ts src/renderer/tabbar.ts src/renderer/main.ts src/renderer/styles.css tests/e2e/coordinator-window.ts tests/e2e/coordinator-header.spec.ts
git commit -m "feat: a coordinator's header has the Sessions toggle; an attached session's says where it reports"
```

---

### Task 4: The Sessions panel — groups, rows, folding, and the notice of what is missing

**Files:**
- Create: `src/renderer/sessions-model.ts`, `src/renderer/sessions-panel.ts`
- Modify: `src/renderer/util.ts` (append `labelOf`), `src/renderer/mail-panel.ts:23-27` (imports `labelOf` from `util.ts` instead of its own)
- Modify: `src/renderer/main.ts` (boot beside `MailPanel` :1626-1629; `sidePanel.onChange` :1643-1650; `syncSessions`; the `onCoordView` handler)
- Modify: `src/shared/ipc.ts:288-289`, `src/renderer/settings-page.ts` (the Agent messages section :266-270, `SECTIONS` :490)
- Modify: `src/main/index.ts` (the version probe's answer, beside `if (localVersion() !== versionBefore) mailSync.announce()`; the settings apply, beside `if (agentsChanged || localVersion() !== versionBefore || localWakes() !== wakesBefore) mailSync.announce()`)
- Modify: `src/renderer/styles.css` (append)
- Modify: `tests/e2e/coordinator-window.ts`
- Create: `tests/unit/sessions-model.test.ts`, `tests/e2e/coordinator-panel.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`coordViews`, `coordViewOf`), Task 3 (`'sessions'` panel tab, `syncSessions`); `spinner` (`tab-row.ts`), `icon`, `deviceColor` (`src/shared/remote.ts`); part 1's `coordSoon` in `index.ts`.
- Produces (`src/renderer/util.ts`): `export const labelOf = (name: string): string` — the part before the last `' · '` (the device), else the name.
- Produces (`src/renderer/sessions-model.ts`, pure, no DOM):
  ```ts
  export type SectionKey = CoordGroup | 'not-attached'
  export const SECTION_LABELS: Record<SectionKey, string> = { waiting: 'Waiting on you', working: 'Working', idle: 'Idle', resolved: 'Resolved', 'not-attached': 'Not attached' }
  export const DEFAULT_FOLDED: readonly SectionKey[] = ['resolved']
  export interface SessionSection { key: SectionKey; label: string; rows: CoordSessionRow[]; folded: boolean }
  /** the attached rows by group in the order waiting, working, idle, resolved (each in the view's order), then the project's others; a section with no row is left out */
  export function sessionSections(view: CoordinatorView, folded: ReadonlySet<SectionKey>): SessionSection[]
  export type RowIcon = 'amber' | 'red' | 'spin' | 'check' | 'grey'
  /** not-attached or marker 'offline' → grey; marker 'starting' | 'attaching' → spin; waiting → amber for why 'prompt', else red; working → spin; idle, resolved → check */
  export function rowIcon(row: CoordSessionRow, section: SectionKey): RowIcon
  /** when a row last changed: "now" within a minute (a time ahead of now too), "HH:MM" earlier the same local day, else "Mon D" (e.g. "Nov 13") */
  export function rowTime(changedAt: number, now: number): string
  ```
- Produces (`src/renderer/sessions-panel.ts`):
  ```ts
  export interface SessionsPanelCallbacks { openSettings(): void }
  export class SessionsPanel {
    constructor(body: HTMLElement, panel: SidePanel, cb: SessionsPanelCallbacks)
    /** the tab in front and its view: null for a tab that is no coordinator, or a view not loaded yet */
    show(tabId: string | null, view: CoordinatorView | null): void
    /** draws again while the panel shows Sessions */
    refresh(): void
  }
  ```
  The body holds, in this order: the notice (`div.panel-notice.coord-problem`, hidden without a problem: a span with `view.problem`, then `button.coord-link` `Open Settings` → `cb.openSettings()`), the list (`div.coord-list`), and when there is no row at all `div.panel-empty` with `No sessions yet. Start one with New session, attach one with Attach…, or drop a tab here.`. A section is `section.coord-group[data-group=<key>]` (plus `folded`), its head a `button.coord-gh` (`span.tp-chevron` with `icon('chevron-down', 12)`, a span with the label, `span.n` with the count) that folds and unfolds it (the folds start as `DEFAULT_FOLDED` and are the panel's, in memory); its rows only while unfolded. A row is `div.coord-row[data-key]` (plus `data-tab-id` when `tabId` is not null, plus `marker-<marker>` when there is one):
  - `div.coord-l1`: the icon (`span.coord-dot` + `amber` / `red` / nothing for grey; `spinner('tab-icon')` for spin; `span.coord-ico` with `icon('check', 12)`), `span.coord-name` (`labelOf(row.name)`, title `row.name`), when `deviceName !== null` a `span.coord-dev` (`<i>` coloured `deviceColor(row.device)`, then the name), `span.coord-time` (`rowTime`; empty for the project's others);
  - `div.coord-l2`: `folder · branch` (either alone when the other is null; no line when both are);
  - `div.coord-l3`: an attached row's `line`, `warn` for why `prompt`, `err` for `limit` / `failed`; a row of the project's others has `` `Attached to ${row.attachedTo}` `` when `attachedTo` is not null, else no line;
  - `div.coord-prog > i` (width `` `${Math.round(done / total * 100)}%` ``) for an attached row with `progress`.
  While a row shows "now", the panel draws again 60 s later.
- Produces (`main.ts`): `let sessionsPanel: SessionsPanel` built on `sidePanel.bodies.sessions` with `openSettings: () => ct.openSettingsWindow('agent-messages')`; `syncSessions` also calls `sessionsPanel.show(id, coordViews.get(id) ?? null)` for a coordinator in front (else `show(null, null)`) and, when no view is held, `coordViewOf(id)` then `show` again if that tab is still in front; the `onCoordView` handler calls `sessionsPanel.show(tabId, view)` when `tabId === activeId`; `sidePanel.onChange` calls `sessionsPanel.refresh()`.
- Produces (`src/shared/ipc.ts`): `SettingsSection` gains `'agent-messages'` (and `isSettingsSection`). `settings-page.ts`: the Agent messages section gets `id: 'agent-messages'` (with `Object.assign`, as the notifications section does) and `SECTIONS` maps `'agent-messages'` to the `'panels'` tab.
- Produces (`index.ts`): `coordSoon.request()` at both announce places, so a view's `problem` is published when the mail setting or the Claude Code version changes.
- Produces (`tests/e2e/coordinator-window.ts`):
  ```ts
  export const sessionRow = (page: Page, key: string): Locator => page.locator(`#image-panel .panel-sessions .coord-row[data-key="${key}"]`)
  export const sessionGroup = (page: Page, group: string): Locator => page.locator(`#image-panel .panel-sessions .coord-group[data-group="${group}"]`)
  export const rowKey = (sid: string): string => `local:${sid}`
  ```

- [ ] **Step 1: Write the failing unit tests** — `tests/unit/sessions-model.test.ts`:
```ts
const row = (key: string, group: CoordGroup, o: Partial<CoordSessionRow> = {}): CoordSessionRow => ({
  key, tabId: `tab-${key}`, device: null, deviceName: null, session: 'a1000000-0000-4000-8000-000000000002', ref: 'a10000', name: `${key} · Desktop`,
  folder: 'D:\\Work\\acme', branch: 'main', group, why: null, marker: null, line: 'Idle', progress: null, changedAt: 0, task: null, lastReport: null, attachedTo: null, ...o
})
const view = (sessions: CoordSessionRow[], notAttached: CoordSessionRow[] = []): CoordinatorView =>
  ({ tabId: 'tab-c', session: 'c0000000-0000-4000-8000-000000000001', project: { key: 'd:\\work\\acme', name: 'acme' }, problem: null, sessions, notAttached, waiting: 0 })

it('sections come in the order waiting, working, idle, resolved, then the project\'s others; an empty one is left out', () => {
  const s = sessionSections(view([row('a', 'idle'), row('b', 'waiting'), row('c', 'idle')], [row('d', 'idle')]), new Set(DEFAULT_FOLDED))
  expect(s.map((x) => [x.key, x.label, x.rows.map((r) => r.key), x.folded])).toEqual([
    ['waiting', 'Waiting on you', ['b'], false], ['idle', 'Idle', ['a', 'c'], false], ['not-attached', 'Not attached', ['d'], false]
  ])
})
it('a folded section keeps its rows, for its count', () => {
  expect(sessionSections(view([row('r', 'resolved')]), new Set(DEFAULT_FOLDED))).toEqual([{ key: 'resolved', label: 'Resolved', rows: [expect.objectContaining({ key: 'r' })], folded: true }])
})
it('rowIcon: amber for a pending prompt, red for a limit or a failure, the spinner at work or starting, a check when idle or resolved, grey for the others and an offline session', () => {
  expect(rowIcon(row('a', 'waiting', { why: 'prompt' }), 'waiting')).toBe('amber')
  expect(rowIcon(row('a', 'waiting', { why: 'limit' }), 'waiting')).toBe('red')
  expect(rowIcon(row('a', 'waiting', { why: 'failed' }), 'waiting')).toBe('red')
  expect(rowIcon(row('a', 'working'), 'working')).toBe('spin')
  expect(rowIcon(row('a', 'working', { marker: 'starting' }), 'working')).toBe('spin')
  expect(rowIcon(row('a', 'idle'), 'idle')).toBe('check')
  expect(rowIcon(row('a', 'resolved'), 'resolved')).toBe('check')
  expect(rowIcon(row('a', 'idle', { marker: 'offline' }), 'idle')).toBe('grey')
  expect(rowIcon(row('a', 'working'), 'not-attached')).toBe('grey')
})
it('rowTime says now within a minute, the clock time today, and the day before that', () => {
  const at = new Date(2026, 10, 14, 9, 5).getTime()
  expect(rowTime(at, at + 59_000)).toBe('now')
  expect(rowTime(at + 5000, at)).toBe('now')
  expect(rowTime(at, new Date(2026, 10, 14, 19, 0).getTime())).toBe('09:05')
  expect(rowTime(new Date(2026, 10, 13, 23, 59).getTime(), new Date(2026, 10, 14, 0, 30).getTime())).toBe('Nov 13')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/sessions-model.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `sessions-model.ts`** and `labelOf`; run the unit tests again: PASS.

- [ ] **Step 4: Write the failing e2e tests** — `tests/e2e/coordinator-panel.spec.ts`:
```ts
const LIST = { title: 'Triage', tasks: [{ title: 'Collect crashes', status: 'completed' }, { title: 'Grouping crashes by call stack', status: 'in_progress' }, { title: 'Write the report', status: 'pending' }] }

test('the Sessions panel groups the attached sessions by state and lists the project\'s others as not attached', async () => {
  const l = await coordApp(4)
  const { page, pipeName, tabs: [t0, t1, t2], sids, repo } = l
  try {
    await makeCoordinator(page, t0)
    for (const s of [sids[1], sids[2]]) expect(await coord(pipeName, t0, { op: 'attach', session: refOf(s) })).toMatchObject({ ok: true })
    await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: t1, sessionId: sids[1], reason: 'permission', prompt: 'Allow Bash: npm test' })
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'task_list', tabId: t2, list: LIST })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const waiting = sessionGroup(page, 'waiting')
    await expect(waiting.locator('.coord-gh .n')).toHaveText('1')
    await expect(waiting.locator(`.coord-row[data-key="${rowKey(sids[1])}"] .coord-l3.warn`)).toHaveText('Allow Bash: npm test')
    await expect(waiting.locator('.coord-dot.amber')).toHaveCount(1)
    await expect(sessionRow(page, rowKey(sids[2])).locator('.coord-l3')).toHaveText('1/3 · Grouping crashes by call stack')
    await expect(sessionRow(page, rowKey(sids[2])).locator('.coord-prog')).toHaveCount(1)
    await expect(sessionGroup(page, 'not-attached').locator(`.coord-row[data-key="${rowKey(sids[3])}"] .coord-l2`)).toContainText(basename(repo))
  } finally { await l.app.close() }
})
test('Resolved is folded and opens on a click', async () => {
  // coordApp(2); make; attach sids[1]; activate(t0); openSessions;
  // key = rowKey(sids[1]); page.evaluate(([t, k]) => window.ct.coordResolve(t, k), [t0, key]) → { ok: true }
  // sessionGroup(page, 'resolved'): has class /folded/, '.coord-gh .n' '1', '.coord-row' count 0; click '.coord-gh' → sessionRow(page, key) visible
})
test('with agent messages off the panel says what is missing, and its link opens Settings at Agent messages', async () => {
  // coordApp(1); make; activate(t0); openSessions; setSetting(page, 'agentMessages.enabled', false)
  // → '#image-panel .coord-problem' contains 'Coordinating sessions needs agent messages'
  // const [win] = await Promise.all([l.app.waitForEvent('window'), page.locator('#image-panel .coord-problem .coord-link').click()])
  // await expect(win.locator('#agent-messages')).toBeVisible()
})
test('a session name with markup in it shows as text', async () => {
  // coordApp(2); make; const name = '<img src=x onerror="window.__hit=1">'
  // page.evaluate(([id, n]) => window.ct.renameTab(id, n), [t1, name]);
  // expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle!(id), t1)).toBe(name)   // main has the name before the attach builds the view
  // attach sids[1]; activate(t0); openSessions
  // → sessionRow(page, rowKey(sids[1])).locator('.coord-name') has text name; '#image-panel img' count 0;
  //   page.evaluate(() => (window as any).__hit) is undefined
})
test('stopping the coordinator takes the Sessions panel away', async () => {
  // coordApp(1); make; activate(t0); openSessions; page.evaluate((id) => window.ct.coordStop(id), t0) → ok
  // → sessionsToggle hidden; '#image-panel .panel-sessions' hidden
})
test('an empty coordinator says how to get sessions', async () => {
  // coordApp(1); make; activate; openSessions → '#image-panel .panel-sessions .panel-empty' has text
  //   'No sessions yet. Start one with New session, attach one with Attach…, or drop a tab here.'
})
```

- [ ] **Step 5: Run them to see them fail**

Run: `npm run build && node scripts/e2e.mjs coordinator-panel.spec.ts`
Expected: FAIL (the panel body is empty).

- [ ] **Step 6: Implement** `SessionsPanel`, the `main.ts` wiring, the Settings section and the two `coordSoon.request()` calls in `index.ts`. `styles.css` gains (the mockup's `mk-*` with the `coord-` names):
```css
/* the Sessions panel: its notice, its groups and its rows */
.coord-problem { display: flex; align-items: center; gap: 8px; }
.coord-problem[hidden] { display: none; }
.coord-link { flex: none; margin-left: auto; padding: 2px 8px; border: 1px solid var(--line-2); border-radius: 6px; background: none; color: var(--text-2); font: inherit; font-size: 12px; cursor: pointer; }
.coord-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 12px; }
.coord-gh { display: flex; align-items: center; gap: 6px; width: 100%; height: 28px; margin-top: 8px; padding: 0 6px; border: 0; background: none; color: var(--text-3); font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; cursor: pointer; }
.coord-gh .n { margin-left: auto; font-weight: 500; letter-spacing: 0; }
.coord-gh .tp-chevron { display: inline-flex; }
.coord-group.folded .coord-gh .tp-chevron { transform: rotate(-90deg); }
.coord-row { padding: 7px 10px 8px; border-radius: 8px; }
.coord-row:hover { background: var(--item-hover); }
.coord-row.marker-offline { opacity: 0.6; }
.coord-l1 { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--text); font-size: 13px; }
.coord-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coord-time { flex: none; margin-left: auto; color: var(--text-4); font-size: 11px; }
.coord-l2 { margin: 2px 0 0 19px; overflow: hidden; color: var(--text-3); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.coord-l3 { margin: 3px 0 0 19px; color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }
.coord-l3.warn { color: var(--amber); }
.coord-l3.err { color: var(--red); }
.coord-ico { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 12px; height: 12px; color: var(--green); }
.coord-dot { flex: none; width: 7px; height: 7px; margin: 0 2.5px; border-radius: 50%; background: var(--text-4); }
.coord-dot.amber { background: var(--amber); }
.coord-dot.red { background: var(--red); }
.coord-dev { display: inline-flex; flex: none; align-items: center; gap: 5px; color: var(--text-3); font-size: 11px; }
.coord-dev i { width: 3px; height: 11px; border-radius: 2px; }
.coord-prog { height: 3px; margin: 6px 0 0 19px; overflow: hidden; border-radius: 2px; background: var(--raised-2); }
.coord-prog i { display: block; height: 100%; background: var(--blue); }
```

- [ ] **Step 7: Run the tests**

Run: `npm run typecheck && npx vitest run tests/unit/sessions-model.test.ts && npm run build && node scripts/e2e.mjs coordinator-panel.spec.ts agent-messages.spec.ts settings.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**
```bash
git add src/renderer/sessions-model.ts src/renderer/sessions-panel.ts src/renderer/util.ts src/renderer/mail-panel.ts src/renderer/main.ts src/shared/ipc.ts src/renderer/settings-page.ts src/main/index.ts src/renderer/styles.css tests/unit/sessions-model.test.ts tests/e2e/coordinator-window.ts tests/e2e/coordinator-panel.spec.ts
git commit -m "feat: the Sessions panel shows a coordinator's sessions by state"
```

---

### Task 5: The rows' actions — Open, Message, Detach, Attach, Resolve

**Files:**
- Modify: `src/renderer/sessions-model.ts`, `src/renderer/sessions-panel.ts`, `src/renderer/main.ts` (the `SessionsPanel` callbacks), `src/renderer/styles.css`
- Test: `tests/unit/sessions-model.test.ts`, `tests/e2e/coordinator-panel.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`toastFailure`), Task 4 (the panel, `SectionKey`, `rowKey`, `sessionRow`, `sessionGroup`); `COORD_TASK_MAX`.
- Produces (`sessions-model.ts`):
  ```ts
  export type RowAction = 'open' | 'message' | 'detach' | 'attach' | 'resolve'
  export const ACTION_LABELS: Record<RowAction, string> = { open: 'Open', message: 'Message', detach: 'Detach', attach: 'Attach', resolve: 'Resolve' }
  /** the project's others: attach (with a tab); a row that starts: open (with a tab); an attached row: open (with a tab), message, detach, and resolve in Idle or after a failure */
  export function rowActions(row: CoordSessionRow, section: SectionKey): RowAction[]
  ```
- Produces (`SessionsPanelCallbacks` gains):
  ```ts
  open(tabId: string): void
  attach(coordinatorTabId: string, sessionTabId: string): void
  detach(coordinatorTabId: string, key: string): void
  resolve(coordinatorTabId: string, key: string): void
  /** null: the task was given; else why not */
  message(coordinatorTabId: string, key: string, text: string): Promise<string | null>
  ```
  `main.ts`: `open` → `ct.activateTab`; `attach`, `detach`, `resolve` → `ct.coordAttach` / `ct.coordDetach` / `ct.coordResolve` then `toastFailure`; `message` → `ct.coordMessage`, answering `r.ok ? null : r.error`.
- Panel behaviour: a row gets `div.coord-acts` with one `button` per action (`coord-btn acc` for Open, `coord-btn ghost` for the others), shown on hover and on focus within; a click on a button acts and does not reach the row; a click elsewhere on a row with a `tabId` opens it. Message opens the Message box: one `div.coord-compose` built once at the bottom of the panel body (never rebuilt by a redraw): `div.coord-compose-head` `` `Task for ${labelOf(row.name)}` ``, `textarea.coord-compose-field` (placeholder `What should this session do?`, `maxLength = COORD_TASK_MAX`), `div.coord-compose-error`, `div.coord-compose-actions` with `Cancel` (`coord-btn ghost`) and `Send` (`coord-btn acc`, disabled while the text is blank). Enter sends, Shift+Enter is a new line, Escape cancels; its `keydown` always calls `stopPropagation()`. Send → `cb.message`; null closes and clears the box, a string shows in the error line. A `show()` for another tab, or a view in which the row's key is gone, closes the box.

- [ ] **Step 1: Write the failing unit test** (in `tests/unit/sessions-model.test.ts`):
```ts
it('rowActions: Open with a tab, Message and Detach for an attached row; Resolve in Idle and after a failure; Attach for the others; Open only while it starts', () => {
  expect(rowActions(row('a', 'working'), 'working')).toEqual(['open', 'message', 'detach'])
  expect(rowActions(row('a', 'idle'), 'idle')).toEqual(['open', 'message', 'detach', 'resolve'])
  expect(rowActions(row('a', 'waiting', { why: 'failed' }), 'waiting')).toEqual(['open', 'message', 'detach', 'resolve'])
  expect(rowActions(row('a', 'idle', { tabId: null }), 'idle')).toEqual(['message', 'detach', 'resolve'])
  expect(rowActions(row('a', 'working', { marker: 'starting' }), 'working')).toEqual(['open'])
  expect(rowActions(row('a', 'idle'), 'not-attached')).toEqual(['attach'])
  expect(rowActions(row('a', 'idle', { tabId: null }), 'not-attached')).toEqual([])
})
```

- [ ] **Step 2: Write the failing e2e tests** (in `tests/e2e/coordinator-panel.spec.ts`; `act(page, key, label)` is a local helper: `sessionRow(page, key).hover()`, then click its `.coord-acts button` with that text):
```ts
test('Open and a click on a row bring the session\'s tab to the front', async () => {
  // coordApp(2); make; attach sids[1]; activate(t0); openSessions; act(page, rowKey(sids[1]), 'Open')
  // → poll window.__ct!.activeTabId() === t1; activate(t0); sessionRow(...).locator('.coord-name').click() → t1 again
})
test('Message gives the session a task from the panel', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    await makeCoordinator(page, t0)
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })
    const mail = waitForMail(pipeName, t1, sids[1])
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Message')
    await expect(page.locator('#image-panel .coord-compose-head')).toHaveText(/^Task for /)
    await page.locator('#image-panel .coord-compose-field').fill('Fix the parser.')
    await page.keyboard.press('Enter')
    await expect(page.locator('#image-panel .coord-compose')).toBeHidden()
    const got = await within(mail, 10_000)
    expect(got.info).toMatch(/^Task from your coordinator, through ClaudeTerm:/)
    expect(got.info).toContain('> Fix the parser.')
    await expect(sessionGroup(page, 'working').locator(`.coord-row[data-key="${rowKey(sids[1])}"]`)).toHaveCount(1)
  } finally { await l.app.close() }
})
test('Resolve, Detach and Attach move the row between the groups', async () => {
  // coordApp(2); make; attach sids[1]; openSessions; act 'Resolve' → sessionGroup 'resolved' '.coord-gh .n' '1'
  // click the resolved head; act 'Detach' → the row is in sessionGroup 'not-attached'; act 'Attach' → the row is in sessionGroup 'idle'
})
test('a task the hub refuses shows why under the Message box', async () => {
  // coordApp(2); make; attach sids[1]; openSessions; setSetting(page, 'agentMessages.enabled', false); act 'Message'; fill 'x'; Enter
  // → '#image-panel .coord-compose-error' contains 'Coordinating sessions needs agent messages'; the box stays shown
})
test('the Message box keeps its draft and its focus while the rows change, and Esc closes it without reaching the tab', async () => {
  // coordApp(3); make; attach sids[1] and sids[2]; activate(t0); openSessions; act(rowKey(sids[1]), 'Message')
  // const field = page.locator('#image-panel .coord-compose-field'); await field.pressSequentially('Fix th')
  // const before = await page.evaluate((id) => window.__ct!.ptyInput!(id), t0)
  // await turnOf(pipeName, t2, sids[2])   // the view changes: t2 works
  // await expect(sessionGroup(page, 'working').locator(`.coord-row[data-key="${rowKey(sids[2])}"]`)).toHaveCount(1)
  // await expect(field).toHaveValue('Fix th'); await expect(field).toBeFocused()
  // page.keyboard.press('Escape') → '.coord-compose' hidden; ptyInput(t0) still equals before
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/sessions-model.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator-panel.spec.ts`
Expected: FAIL (`rowActions` missing; no `.coord-acts`).

- [ ] **Step 4: Implement** the Interfaces block. `styles.css` gains:
```css
/* the rows' buttons, shown on hover, and the Message box at the panel's foot */
.coord-btn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--raised); color: var(--text-2); font: inherit; font-size: 12px; cursor: pointer; }
.coord-btn:hover:not(:disabled) { color: var(--text); }
.coord-btn:disabled { opacity: 0.5; cursor: default; }
.coord-btn.ghost { border-color: var(--line); background: none; color: var(--text-3); }
.coord-btn.acc { border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: none; color: var(--accent); }
.coord-acts { display: none; gap: 6px; margin: 8px 0 0 19px; }
.coord-row:hover .coord-acts, .coord-row:focus-within .coord-acts { display: flex; }
.coord-compose { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 10px 14px 12px; border-top: 1px solid var(--line); }
.coord-compose[hidden] { display: none; }
.coord-compose-head { color: var(--text-2); font-size: 12px; font-weight: 600; }
.coord-compose-field { box-sizing: border-box; width: 100%; min-height: 64px; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--field); color: var(--text); font: inherit; font-size: 12.5px; resize: vertical; }
.coord-compose-field:focus { outline: none; border-color: var(--accent); }
.coord-compose-error { color: var(--red); font-size: 12px; }
.coord-compose-error:empty { display: none; }
.coord-compose-actions { display: flex; justify-content: flex-end; gap: 6px; }
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npx vitest run tests/unit/sessions-model.test.ts && npm run build && node scripts/e2e.mjs coordinator-panel.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src/renderer/sessions-model.ts src/renderer/sessions-panel.ts src/renderer/main.ts src/renderer/styles.css tests/unit/sessions-model.test.ts tests/e2e/coordinator-panel.spec.ts
git commit -m "feat: the Sessions panel opens, messages, detaches, attaches and resolves a session"
```

---

### Task 6: New session and Attach…

**Files:**
- Create: `src/renderer/coord-dialogs.ts`
- Modify: `src/renderer/sessions-model.ts`, `src/renderer/sessions-panel.ts`, `src/renderer/main.ts`, `src/renderer/styles.css`
- Test: `tests/unit/sessions-model.test.ts`
- Create: `tests/e2e/coordinator-dialogs.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`openDialog`, `DialogHandle`), Task 4/5 (the panel); `isWorktreeName`, `CoordStartRequest`, `CoordMarks`, `CoordResult`.
- Produces (`sessions-model.ts`):
  ```ts
  export const FOLDER_ERROR = 'The folder must be a full path.'
  export const WORKTREE_ERROR = 'A worktree name is letters, digits, ".", "_" and "-", starts with a letter or digit, and is at most 64 long.'
  export interface StartForm { task: string; name: string; folder: string; worktree: string }
  /** the fields trimmed, an empty optional field null; a blank task: 'A task needs a text.'; a folder that is not a full path of either system (/x, \x, C:\x, C:/x): FOLDER_ERROR; a worktree isWorktreeName refuses: WORKTREE_ERROR */
  export function checkStartForm(f: StartForm): { req: CoordStartRequest } | { error: string }
  export interface AttachTab { id: string; title: string; claude: boolean; local: boolean; session: string | null; exited: boolean; folder: string; branch: string | null }
  export interface AttachChoice { tabId: string; title: string; where: string; note: string | null }
  /** the tabs Attach… offers, in their order: this device's Claude tabs with a session that run, other than the coordinator, a tab attached to it, and any coordinator; where is "folder · branch"; note: `Attached to the ${project} coordinator` for a tab attached elsewhere */
  export function attachChoices(tabs: AttachTab[], coordinator: string, marks: CoordMarks): AttachChoice[]
  ```
- Produces (`coord-dialogs.ts`):
  ```ts
  /** New session: Task, Name, Folder (empty: the coordinator's), Worktree; Start asks main and closes on its yes */
  export function openNewSessionDialog(o: { folder: string; start(req: CoordStartRequest): Promise<CoordResult> }): void
  /** Attach…: a list of the choices; a click attaches, and closes on main's yes */
  export function openAttachDialog(o: { choices: AttachChoice[]; attach(tabId: string): Promise<CoordResult> }): void
  ```
  New session (`id: 'new-session'`, title `New session`, action `Start`, busy label `Starting…`, `ready` = the task is not blank): fields, each a `label.mcp-add-label` over its control inside a `div.mcp-add-server`: `Task` → `textarea.mcp-add-field[name=task]` (placeholder `What should the new session do?`, `maxLength = COORD_TASK_MAX`); `Name` → `input.mcp-add-name[name=name]` (placeholder `Optional`, `maxLength = COORD_NAME_MAX`); `Folder` → `input.mcp-add-name[name=folder]` (placeholder: the coordinator's folder); `Worktree` → `input.mcp-add-name[name=worktree]` (placeholder `Optional`) with `div.coord-field-hint` `The session first enters a new git worktree of this name.`. Submit: `checkStartForm` error → shown; else `busy(true, 'Starting…')`, `start(req)`, `busy(false)`; `ok` → null (closes), else its error. Cancel closes at any time; a start already asked for goes on.
  Attach… (`id: 'attach'`, title `Attach a session`, action null): `div.coord-dialog-text` `Pick a Claude session of this device. It is not told and goes on as it is.`, then `div.coord-picks` with one `button.coord-pick[data-tab-id]` per choice (`span.coord-pick-title`, `span.coord-pick-where`, `span.coord-pick-note` when there is a note), or `div.coord-picks-empty` `No other Claude session runs on this device.`. A click: `busy(true)`, `attach(tabId)`; `ok` closes, else `error(r.error)` and `busy(false)`.
- Produces (`SessionsPanelCallbacks` gains): `newSession(coordinatorTabId: string): void`, `attachOther(coordinatorTabId: string): void`. The panel body gets, between the notice and the list, `div.coord-bar` with `button.coord-btn` `New session` (`icon('plus', 13)` before the text) and `button.coord-btn` `Attach…`. `main.ts`: `newSession` → `openNewSessionDialog({ folder: <the coordinator tab's info.folder>, start: (req) => ct.coordNewSession(c, req) })`; `attachOther` → `openAttachDialog({ choices: attachChoices(<every tab as AttachTab: title titleOf(t), claude kind, local !info.remote, session info.claudeSessionId, exited, folder info.folder, branch places.get(id)?.branch ?? null>, c, coordMarks), attach: (id) => ct.coordAttach(c, id) })`.

- [ ] **Step 1: Write the failing unit tests** (in `tests/unit/sessions-model.test.ts`):
```ts
it('checkStartForm trims the fields and makes an empty optional field null', () => {
  expect(checkStartForm({ task: ' Write the notes. ', name: '', folder: '  ', worktree: '' })).toEqual({ req: { task: 'Write the notes.', name: null, folder: null, worktree: null } })
  expect(checkStartForm({ task: 'x', name: ' Notes ', folder: 'D:\\Work\\acme', worktree: 'notes-1' })).toEqual({ req: { task: 'x', name: 'Notes', folder: 'D:\\Work\\acme', worktree: 'notes-1' } })
  expect(checkStartForm({ task: 'x', name: '', folder: '/home/sam/acme', worktree: '' })).toMatchObject({ req: { folder: '/home/sam/acme' } })
})
it('checkStartForm refuses a blank task, a relative folder and a worktree name with a space or a slash', () => {
  expect(checkStartForm({ task: '  ', name: '', folder: '', worktree: '' })).toEqual({ error: 'A task needs a text.' })
  expect(checkStartForm({ task: 'x', name: '', folder: 'acme/sub', worktree: '' })).toEqual({ error: FOLDER_ERROR })
  expect(checkStartForm({ task: 'x', name: '', folder: '', worktree: 'a b' })).toEqual({ error: WORKTREE_ERROR })
  expect(checkStartForm({ task: 'x', name: '', folder: '', worktree: 'a/b' })).toEqual({ error: WORKTREE_ERROR })
})
it('attachChoices offers the other running Claude sessions of this device and says where one is attached', () => {
  const t = (id: string, o: Partial<AttachTab> = {}): AttachTab => ({ id, title: id, claude: true, local: true, session: `s-${id}`, exited: false, folder: `D:\\Work\\${id}`, branch: 'main', ...o })
  const marks: CoordMarks = { c: { role: 'coordinator', project: 'acme', sessions: 1, waiting: 0 }, a: { role: 'attached', project: 'acme', coordinator: 'c · Desktop', coordinatorTabId: 'c' },
    b: { role: 'attached', project: 'beta', coordinator: 'k · Desktop', coordinatorTabId: 'k' }, k: { role: 'coordinator', project: 'beta', sessions: 1, waiting: 0 } }
  const tabs = [t('c'), t('a'), t('b'), t('k'), t('x', { branch: null }), t('sh', { claude: false }), t('r', { local: false }), t('n', { session: null }), t('e', { exited: true })]
  expect(attachChoices(tabs, 'c', marks)).toEqual([
    { tabId: 'b', title: 'b', where: 'D:\\Work\\b · main', note: 'Attached to the beta coordinator' },
    { tabId: 'x', title: 'x', where: 'D:\\Work\\x', note: null }
  ])
})
```

- [ ] **Step 2: Write the failing e2e tests** — `tests/e2e/coordinator-dialogs.spec.ts` (`bar(page, label)` = `page.locator('#image-panel .coord-bar button', { hasText: label })`):
```ts
test('New session opens an attached Claude tab named as asked, Starting… until its session starts, with its task as its first message', async () => {
  const l = await coordApp(1)
  const { page, pipeName, tabs: [t0] } = l
  try {
    await makeCoordinator(page, t0)
    await activate(page, t0)
    await openSessions(page)
    const before = await tabOrder(page)
    await bar(page, 'New session').click()
    const dialog = page.locator('.coord-dialog[data-dialog="new-session"]')
    await dialog.locator('textarea[name="task"]').fill('Write the release notes.')
    await dialog.locator('input[name="name"]').fill('Release notes')
    await dialog.locator('button', { hasText: 'Start' }).click()
    await expect.poll(async () => (await tabOrder(page)).length).toBe(before.length + 1)
    const fresh = (await tabOrder(page)).find((id) => !before.includes(id))!
    await expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle!(id), fresh)).toBe('Release notes')
    await expect(sessionRow(page, `start:${fresh}`).locator('.coord-l3')).toHaveText('Starting…')
    const sid = randomUUID()
    expect(await startSession(pipeName, fresh, sid)).toEqual({ ok: true })
    await expect(dialog).toHaveCount(0)
    expect((await within(waitForMail(pipeName, fresh, sid), 10_000)).info).toContain('> Write the release notes.')
    await expect(sessionRow(page, rowKey(sid))).toHaveCount(1)
  } finally { await l.app.close() }
})
test('New session checks its fields before it asks, and shows main\'s refusal', async () => {
  // coordApp(1); make; activate; openSessions; open New session; Start is disabled while the task is empty
  // task 'x', folder 'relative/dir' → Start → '.coord-dialog .mcp-add-error' has text 'The folder must be a full path.'
  // folder '', worktree 'a b' → Start → error WORKTREE_ERROR
  // worktree '', folder join(tmpdir(), 'ct-no-such-folder') → Start → error `No folder ${that path} on this device.`
  // tabOrder still has before.length tabs
})
test('Attach… lists the other Claude sessions of this device, of another project too, and attaches the one picked', async () => {
  // const l = await coordApp(2); const other = await claudeTabIn(l, gitRepo()); make t0; activate t0; openSessions; bar 'Attach…'
  // dialog '.coord-dialog[data-dialog="attach"]': its '.coord-pick' data-tab-id values (one evaluate) equal [t1, other.tabId]
  // click the pick of other.tabId → dialog count 0; poll marks[other.tabId] toMatchObject({ role: 'attached', coordinatorTabId: t0 })
})
test('Attach… with no other session says so', async () => {
  // coordApp(1); make; openSessions; 'Attach…' → '.coord-picks-empty' has text 'No other Claude session runs on this device.'
})
test('keys typed in a dialog stay in it, and Esc closes it', async () => {
  // coordApp(1); make; openSessions; const before = ptyInput(t0); New session; type 'abc' into the task; Escape
  // → dialog count 0; ptyInput(t0) equals before
})
test('a dialog of a coordinator that stopped shows main\'s refusal', async () => {
  // coordApp(1); make; openSessions; New session; fill the task; page.evaluate((id) => window.ct.coordStop(id), t0)
  // Start → '.coord-dialog .mcp-add-error' contains 'This tab is not a coordinator.'
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/sessions-model.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator-dialogs.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** the Interfaces block. `styles.css` gains:
```css
/* the Sessions panel's toolbar, and the dialogs' fields and choices */
.coord-bar { display: flex; flex: none; gap: 6px; padding: 10px 14px 4px; }
.coord-field-hint { color: var(--text-3); font-size: 11.5px; }
.coord-picks { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; }
.coord-pick { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--raised); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.coord-pick:hover:not(:disabled) { border-color: var(--accent); }
.coord-pick-title { color: var(--text); font-size: 12.5px; }
.coord-pick-where, .coord-pick-note, .coord-picks-empty { color: var(--text-3); font-size: 11.5px; overflow-wrap: anywhere; }
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npx vitest run tests/unit/sessions-model.test.ts && npm run build && node scripts/e2e.mjs coordinator-dialogs.spec.ts coordinator-panel.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src/renderer/coord-dialogs.ts src/renderer/sessions-model.ts src/renderer/sessions-panel.ts src/renderer/main.ts src/renderer/styles.css tests/unit/sessions-model.test.ts tests/e2e/coordinator-dialogs.spec.ts
git commit -m "feat: New session and Attach… in the Sessions panel"
```

---

### Task 7: Drag and drop — attach onto the coordinator, detach out of its block, attach onto the Sessions panel

**Files:**
- Modify: `src/renderer/tab-groups.ts` (after `arrangeCoordinators`)
- Modify: `src/renderer/tabbar.ts` (`TabBarCallbacks`, `TAB_DRAG` :85-88, `renderTab` :252-258, `dropOn`)
- Modify: `src/renderer/tab-panel.ts` (`renderRow` :284-290, `dropTab` :330-335)
- Modify: `src/renderer/sessions-panel.ts`, `src/renderer/main.ts` (`tabCallbacks`, `detachFromCoordinator`, `tabBarItem`, `applyMarks`, the panel's callbacks), `src/renderer/styles.css`
- Modify: `tests/e2e/coordinator-window.ts`
- Test: `tests/unit/tab-groups.test.ts`
- Create: `tests/e2e/coordinator-drag.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`arrangeCoordinators`, `PanelRow.block`), Task 2 (`detachFromCoordinator`, `toastFailure`), Task 3 (`TabBarCallbacks.detachTab`), Task 4 (the panel); `moveTab`.
- Produces (`tab-groups.ts`):
  ```ts
  /** what a drop needs to know of a row: Claude or shell, this device's, its mark, the block it stands in (its PanelRow's block) */
  export interface DropRow { id: string; claude: boolean; local: boolean; coord: CoordMark | null; block: string | null }
  export type PanelDrop =
    | { kind: 'attach'; coordinator: string; tab: string }
    | { kind: 'detach'; coordinator: string; tab: string; order: string[] | null }
    | { kind: 'reorder'; order: string[] }
  /** a Claude tab of this device, no coordinator itself, dropped on another tab that is a coordinator it is not attached to (one attached to another coordinator is asked for too: main answers with the refusal) */
  export function dropAttaches(drag: DropRow, target: DropRow): boolean
  /**
   * What a row dropped on another row of the left panel does; null: nothing. `groups`: the target's section, arranged.
   * In order: the same row → null; the target is a coordinator → attach when dropAttaches, else null; the dragged row is an
   * attached session standing in its coordinator's block and the target is outside that block → detach, with moveTab's order
   * (null across groups); the target is in a block the dragged row is not in → null; else moveTab's order as a reorder (null
   * when it gives none).
   */
  export function panelDrop(groups: PanelGroup[], drag: DropRow, target: DropRow): PanelDrop | null
  ```
- Produces (`tabbar.ts`): `TabBarCallbacks.attachTab(coordinatorId: string, tabId: string): void`; `export const draggingTab = (): string | null` and `export function setDragging(id: string | null): void` — the tab a drag of the bar or the panel carries, read by `dragover` to light a drop target (`dataTransfer` data cannot be read during a drag). Both `dragstart` handlers that set `TAB_DRAG` (`tabbar.ts:253`, `tab-panel.ts:285`) also call `setDragging(item.id)`; `tabbar.ts` clears it on the document's `dragend` and `drop` (capture phase, registered once at module load).
- Produces (`SessionsPanelCallbacks` gains): `dropTab(coordinatorTabId: string, tabId: string): void` — a tab dropped on the panel.
- Behaviour:
  - Left panel: `dropTab` builds `DropRow`s (the item's `kind`, `group === null`, `coord`, and the row's `block` found in any section) and acts on `panelDrop`: attach → `cb.attachTab`; detach → `cb.detachTab(tab)`, then `cb.reorder(order, <section device>)` when `order` is not null; reorder → `cb.reorder`. A row's `dragover` adds the class `coord-drop` while `dropAttaches(draggingTab's row, this row)`; `dragleave` and `drop` remove it.
  - Tab bar: `dropOn` first asks `dropAttaches` (blocks are null on top) → `cb.attachTab`; else as today. The same `coord-drop` light on a pill.
  - Sessions panel: its body takes a tab drag (`dragover` with `TAB_DRAG` → `preventDefault()`, class `coord-drop` on the body; `dragleave` out of the body and `drop` remove it); a drop → `cb.dropTab(coordinatorTabId, <the dragged id>)`.
  - `main.ts`: `tabCallbacks.attachTab = (c, id) => void ct.coordAttach(c, id).then(toastFailure)`; the panel's `dropTab(c, id)` does the same for a local Claude tab other than `c`, and nothing else. `detachFromCoordinator` puts the tab in `const detaching = new Set<string>()` and calls `renderTabs()` before it asks main; `tabBarItem` gives a tab in `detaching` `coord: null`; it leaves the set when `applyMarks` brings marks without its attachment, or when the detach fails. (A drop's reorder reaches main before the new marks: without this the old block pulls the row back and the window writes that order back.)
- Produces (`tests/e2e/coordinator-window.ts`):
  ```ts
  /** a mouse drag from the centre of one element to the centre of another, each measured in one evaluate */
  export async function dragOnto(page: Page, from: Locator, to: Locator): Promise<void>
  ```

- [ ] **Step 1: Write the failing unit tests** (a new `describe('drops on a coordinator\'s block')` in `tests/unit/tab-groups.test.ts`, with Task 1's `C`, `to`, `marks`):
```ts
const m = marks({ C, A1: to('C'), A2: to('C') })
const g = arrangeCoordinators(panelGroups(['C', 'A1', 'A2', 'X', 'S'].map((id) => tab(id, acme))), m, true)
const row = (id: string, o: Partial<DropRow> = {}): DropRow => ({ id, claude: true, local: true, coord: m(id), block: g[0].rows.find((r) => r.id === id)?.block ?? null, ...o })

it('a Claude tab dropped on the coordinator\'s row attaches it', () => {
  expect(panelDrop(g, row('X'), row('C'))).toEqual({ kind: 'attach', coordinator: 'C', tab: 'X' })
})
it('the coordinator\'s own attached tab, a shell tab and another device\'s tab dropped on it do nothing', () => {
  expect(panelDrop(g, row('A1'), row('C'))).toBeNull()
  expect(panelDrop(g, row('S', { claude: false }), row('C'))).toBeNull()
  expect(panelDrop(g, row('X', { local: false }), row('C'))).toBeNull()
})
it('an attached row dropped on a row outside the block is detached and put there', () => {
  expect(panelDrop(g, row('A1'), row('X'))).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: ['C', 'A2', 'X', 'A1', 'S'] })
})
it('an attached row dropped on a row of another group is detached and stays in its group', () => {
  expect(panelDrop(g, row('A1'), { id: 'B', claude: true, local: true, coord: null, block: null })).toEqual({ kind: 'detach', coordinator: 'C', tab: 'A1', order: null })
})
it('an attached row dropped on another of the block reorders the block', () => {
  expect(panelDrop(g, row('A2'), row('A1'))).toEqual({ kind: 'reorder', order: ['C', 'A2', 'A1', 'X', 'S'] })
})
it('an outside row dropped into the block does nothing; outside rows reorder as before', () => {
  expect(panelDrop(g, row('X'), row('A1'))).toBeNull()
  expect(panelDrop(g, row('S'), row('X'))).toEqual({ kind: 'reorder', order: ['C', 'A1', 'A2', 'S', 'X'] })
})
it('dropAttaches refuses the coordinator itself, another coordinator and a target that is no coordinator', () => {
  expect(dropAttaches(row('X'), row('A1'))).toBe(false)
  expect(dropAttaches(row('C'), row('C'))).toBe(false)
  expect(dropAttaches(row('K', { coord: { role: 'coordinator', project: 'beta', sessions: 0, waiting: 0 } }), row('C'))).toBe(false)
  expect(dropAttaches(row('X'), row('C'))).toBe(true)
})
```

- [ ] **Step 2: Write the failing e2e tests** — `tests/e2e/coordinator-drag.spec.ts` (left panel unless said; every drag in `expect(async () => { await dragOnto(...); await expect.poll(<its effect>, { timeout: 3000 })... }).toPass({ timeout: 30_000 })`):
```ts
test('a Claude tab dropped onto the coordinator\'s row is attached and moves under it', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, tabs: [t0, t1, t2] } = l
  try {
    await makeCoordinator(page, t0)
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2])
    await expect(async () => {
      await dragOnto(page, tpRow(page, t2), tpRow(page, t0))
      await expect.poll(async () => (await marksOf(page))[t2], { timeout: 3000 }).toMatchObject({ role: 'attached', coordinatorTabId: t0 })
    }).toPass({ timeout: 30_000 })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t2, t1])
  } finally { await l.app.close() }
})
test('an attached row dropped onto a row outside its block is detached and stays where it was dropped', async () => {
  // make t0; attach refOf(sids[1]) by the pipe; poll tabOrder [t0, t1, t2]; drag t1 onto t2
  // → poll marks[t1] toBeUndefined(); poll tabOrder toEqual [t0, t2, t1]; panelRows: t1 { attached: false }
})
test('an attached row dropped onto another attached row reorders the block; both stay attached', async () => {
  // make t0; attach sids[1], then sids[2]; poll tabOrder [t0, t1, t2]; drag t2 onto t1
  // → poll tabOrder [t0, t2, t1]; marks[t1] and marks[t2] both { role: 'attached', coordinatorTabId: t0 }
})
test('a tab dropped onto the Sessions panel is attached', async () => {
  // make t0; activate(t0); openSessions; drag tpRow(t1) onto page.locator('#image-panel .panel-sessions')
  // → marks[t1] { role: 'attached', coordinatorTabId: t0 }; sessionRow(page, rowKey(sids[1])) visible
})
test('tabs at the top: a tab dropped onto the coordinator\'s tab is attached', async () => {
  // coordApp(3) (tabs on top); make t0; drag pill(t2) onto pill(t0) → marks[t2] attached to t0; poll tabOrder [t0, t2, t1]
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/tab-groups.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator-drag.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** the Interfaces block and its Behaviour list. `styles.css` gains:
```css
/* a drop target of a tab drag: the coordinator's row or tab, and the Sessions panel */
.tp-tab.coord-drop, .tab.coord-drop { box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.panel-sessions.coord-drop { box-shadow: inset 0 0 0 2px var(--accent); }
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npx vitest run tests/unit/tab-groups.test.ts && npm run build && node scripts/e2e.mjs coordinator-drag.spec.ts coordinator-tabs.spec.ts tab-panel.spec.ts tabs.spec.ts`
Expected: PASS (tab-panel.spec.ts:311: see Task 1).

- [ ] **Step 6: Commit**
```bash
git add src/renderer/tab-groups.ts src/renderer/tabbar.ts src/renderer/tab-panel.ts src/renderer/sessions-panel.ts src/renderer/main.ts src/renderer/styles.css tests/unit/tab-groups.test.ts tests/e2e/coordinator-window.ts tests/e2e/coordinator-drag.spec.ts
git commit -m "feat: a tab dropped onto its coordinator or its Sessions panel is attached, and dragged out of the block detached"
```

---

### Task 8: The report card in the coordinator's chat

How a report reaches the chat view today: a report handed to the coordinator's mail watcher wakes Claude Code with a system reminder, which the chat model drops (`isClaudeCodeFlag`, and `attachment` messages): the chat shows nothing of it. A report written as a prompt (part 1's `PromptDelivery`, when no watcher waits) goes through `ChatHub.send` and is a `user` item with the wake text. So the card has two sources: main puts a `report` item when MailHub hands a report record to a tab (both ways call `handedOver`, a prompt's before its text is sent), and the chat view draws the report blocks of a `user` item's text as cards, unless the column already holds that report's item (a conversation read back from its transcript has only the text; such a card has no time). The terminal view is unchanged: it keeps the mail text.

**Files:**
- Create: `src/shared/report-wake.ts`, `src/main/chat/report-item.ts`, `src/renderer/chat/report-card.ts`
- Modify: `src/shared/chat.ts` (`ChatItem` :47-67)
- Modify: `src/main/chat/chat-hub.ts` (after `reloadCard` :362-377)
- Modify: `src/main/index.ts` (part 1's `handedOver` line in the `mailHub` deps)
- Modify: `src/renderer/chat/chat-items.ts` (`ItemCallbacks` :12-32, `renderItem` :55-71, `userItem` :138-144)
- Modify: `src/renderer/chat/chat-find.ts` (the item text switch, near :92), `src/renderer/chat/chat-view.ts` (`ChatViewOptions` :22-72, `this.cb` :233-250)
- Modify: `src/renderer/main.ts` (the `ChatView` options :837-880), `src/renderer/chat/chat.css` (append)
- Create: `tests/unit/report-wake.test.ts`, `tests/unit/report-item.test.ts`, `tests/e2e/coordinator-report.spec.ts`
- Test: `tests/unit/chat-hub.test.ts`

**Interfaces:**
- Consumes: part 1's wake text (`src/main/mail/wake-text.ts`), `ReportOutcome`, `MailRecord`, `refOf` (`src/main/mail/agent-directory.ts`); Task 2 (`coordViewOf`, `toastFailure`); `labelOf` (Task 4).
- Produces (`src/shared/report-wake.ts`):
  ```ts
  export const REPORT_WAKE_HEAD = 'Report from a session attached to you, through ClaudeTerm:'
  /** the first lines of the three kinds of wake blocks ClaudeTerm writes */
  export const WAKE_HEADS: readonly string[] = ['Message from another agent, not from the user, through ClaudeTerm:', 'Task from your coordinator, through ClaudeTerm:', REPORT_WAKE_HEAD]
  export interface ReportWake { mailId: string; name: string; ref: string; outcome: ReportOutcome; reason: string | null; text: string }
  /** a wake text's report blocks, and its other blocks as the rest (joined by a blank line); a text that is not wholly wake blocks: no reports, the rest is the text */
  export function splitWake(text: string): { reports: ReportWake[]; rest: string }
  /** 'finished', 'failed: <reason>' ('failed' without one), 'stopped' */
  export function outcomeText(outcome: ReportOutcome, reason: string | null): string
  ```
  Reading: a block is a head line (it starts with one of `WAKE_HEADS`), a `from: ` line, an `id: ` line, an empty line, one or more lines starting with `>`; blocks are separated by one empty line. A report block's head is `` `${REPORT_WAKE_HEAD} its task ` `` + `finished.` / `failed.` / `failed: <reason>.` / `was stopped by the user.` / `was stopped by the user: <reason>.`; its id line `` `id: <uuid>  (the report on task <uuid>; read_session "<ref>" shows the session)` ``; its name is the from line after `from: ` up to `` ` [${ref}]` `` (else up to ` (`, else the rest); its text is the quoted lines, `>` → empty line, `> x` → `x`. A line out of this shape anywhere: not a wake.
- Produces (`src/shared/chat.ts`): `ChatItem` gains `| { kind: 'report'; id: string; mailId: string; name: string; ref: string; outcome: ReportOutcome; reason: string | null; at: number | null; text: string }` — "a report a coordinator was handed: its card".
- Produces (`src/main/chat/report-item.ts`): `export function reportItemOf(r: MailRecord): Extract<ChatItem, { kind: 'report' }> | null` — null unless `r.kind === 'report'` with an `outcome`; else `{ kind: 'report', id: `report:${r.id}`, mailId: r.id, name: r.from.name, ref: refOf(r.from.session), outcome: r.outcome, reason: r.reason ?? null, at: r.sentAt, text: r.text }`.
- Produces (`ChatHub`): `reportCard(tabId: string, item: Extract<ChatItem, { kind: 'report' }>): void` — as `reloadCard`: no live chat or an ended one → nothing; else `whenLoaded`, then `publish(live, live.model.put(item))` (one item per mail id).
- Produces (`index.ts`): the `mailHub` deps' `handedOver` becomes `(id, taken, into) => { projectCoordinators.handedOver(id, taken, into); for (const r of taken) { const item = reportItemOf(r); if (item) chatHub.reportCard(id, item) } }`.
- Produces (renderer):
  ```ts
  // src/renderer/chat/report-card.ts
  export type ReportCardData = Omit<Extract<ChatItem, { kind: 'report' }>, 'kind' | 'id'>
  /** the card: the agents block's look; its head the state icon, `<label> · <outcomeText>` and ` · HH:MM` when at is known, then Open session and Resolve; its body the text as Markdown with its paths */
  export function reportCard(card: ReportCardData, cb: ItemCallbacks): HTMLElement
  // ItemCallbacks gains
  /** whether the column holds an item of this id */
  hasItem(id: string): boolean
  /** a report card's buttons, by the session's ref and name; null: the card has none (another device's chat) */
  report: { open(ref: string, name: string): void; resolve(ref: string, name: string): void } | null
  // ChatViewOptions gains
  report: { open(ref: string, name: string): void; resolve(ref: string, name: string): void } | null
  ```
  Markup: `div.chat-agents.coord-report[data-outcome]` > `div.chat-agents-head` (`span.chat-step-state.done` with `icon('check', 13)` for finished, `.failed` with `icon('x', 13)` for failed, `.stopped` with `icon('x', 13)` for stopped; `span.coord-report-title` holding `<b>` with `labelOf(name)` and the text after it; `span.coord-report-acts` with `button.chat-button` `Open session` and `Resolve` when `cb.report` is not null) and `div.coord-report-body.chat-text` (`chatMarkdownHtml(text, { paths: true })`, clicks through `markdownClick(e, cb)`). Time: `new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`.
  `renderItem` draws `report` items with `reportCard`. `userItem`: when `splitWake(item.text).reports` is not empty it returns a `div.chat-item.coord-wake` holding a card (with `at: null`) for each report whose `report:<mailId>` the column does not hold (`cb.hasItem`), then, when the rest is not empty, a `div.chat-user-row` with `userBubble(rest)` (and the attachments, as today); a text without reports is drawn as today. `chat-find.ts`: a report item's text is `` `${item.name}\n${item.text}` ``. `ChatView`: `hasItem: (id) => this.get(id) !== undefined`, `report: o.report`. The chat mirror (`itemForMembers`) passes a report item to a member device as it is: that window draws it without buttons (its tab is remote, so `report` is null). `main.ts` passes `report: remote ? null : { open, resolve }` for the tab: both find the row of `coordViewOf(tabId)` whose `ref` is the card's; none → `` showToast(`${labelOf(name)} is no longer attached to this coordinator.`) ``; open with `row.tabId === null` → `` showToast(`${labelOf(name)} has no open tab.`) ``, else `ct.activateTab(row.tabId)`; resolve → `ct.coordResolve(tabId, row.key).then(toastFailure)`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/report-wake.test.ts` — the texts come from part 1's own `wakeText`, so a change of that format fails here:
```ts
const COORD = { device: null, session: 'c0000000-0000-4000-8000-000000000001', name: 'coord · Desktop' }
const PARSER = { device: null, session: 'a1000000-0000-4000-8000-000000000002', name: 'parser · Desktop' }
const TASK = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const report = (over: Partial<MailRecord>): MailRecord => ({ v: 1, id: '0b9a7c1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d', from: PARSER, to: COORD, text: 'Parser fixed.', replyTo: TASK, sentAt: 5, delivered: false, read: false, kind: 'report', outcome: 'finished', ...over })
const where = () => ({ folder: 'D:\\Work\\acme', branch: 'main' })

it('reads a finished report: its mail id, the session\'s name and ref, and its text', () => {
  expect(splitWake(wakeText([report({})], where))).toEqual({ reports: [{ mailId: report({}).id, name: 'parser · Desktop', ref: 'a10000', outcome: 'finished', reason: null, text: 'Parser fixed.' }], rest: '' })
})
it('reads a failed and a stopped report with their reasons, and a text of several lines', () => {
  expect(splitWake(wakeText([report({ outcome: 'failed', reason: 'Claude Code exited', text: 'Half done.\n\nSee notes.' })], where)).reports[0]).toMatchObject({ outcome: 'failed', reason: 'Claude Code exited', text: 'Half done.\n\nSee notes.' })
  expect(splitWake(wakeText([report({ outcome: 'stopped', reason: 'its turn was interrupted' })], where)).reports[0]).toMatchObject({ outcome: 'stopped', reason: 'its turn was interrupted' })
})
it('splitWake keeps the other blocks as the rest', () => {
  const DOCS = { device: null, session: 'b2000000-0000-4000-8000-000000000003', name: 'docs · Desktop' }
  const message: MailRecord = { v: 1, id: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a', from: DOCS, to: COORD, text: 'hello from docs', replyTo: null, sentAt: 1, delivered: false, read: false }
  const text = wakeText([message, report({})], where)
  const split = splitWake(text)
  expect(split.reports.map((r) => r.text)).toEqual(['Parser fixed.'])
  expect(split.rest).toBe(wakeText([message], where))
})
it('a quoted header line stays in its report\'s text', () => {
  const t = `${REPORT_WAKE_HEAD} its task finished.`
  expect(splitWake(wakeText([report({ text: `Quoting:\n${t}` })], where)).reports.map((r) => r.text)).toEqual([`Quoting:\n${t}`])
})
it('a text that is not wholly wake blocks is no wake', () => {
  expect(splitWake('Report from a session attached to you, through ClaudeTerm: its task finished.\nplain')).toEqual({ reports: [], rest: 'Report from a session attached to you, through ClaudeTerm: its task finished.\nplain' })
  expect(splitWake('Fix the parser.')).toEqual({ reports: [], rest: 'Fix the parser.' })
})
it('outcomeText', () => {
  expect([outcomeText('finished', null), outcomeText('failed', 'Claude Code exited'), outcomeText('failed', null), outcomeText('stopped', 'its turn was interrupted')]).toEqual(['finished', 'failed: Claude Code exited', 'failed', 'stopped'])
})
```
`tests/unit/report-item.test.ts`: `a report record is a report item keyed by its mail id; any other record is none` — `reportItemOf(report({ outcome: 'failed', reason: 'Claude Code exited' }))` equals `{ kind: 'report', id: 'report:0b9a7c1e-…', mailId: '0b9a7c1e-…', name: 'parser · Desktop', ref: 'a10000', outcome: 'failed', reason: 'Claude Code exited', at: 5, text: 'Parser fixed.' }`; a task record and a plain message give `null`.
`tests/unit/chat-hub.test.ts`, after the `reloadCard` test and set up as it is (`harness()`, `hub.start(startReq().req)`, `settle()`, `engines[0].h.ready(...)`, `engines[0].h.message(init())`, `vi.advanceTimersByTime(16)`, `windows.length = 0`, its `flushed()`): `reportCard puts one card per report` — `hub.reportCard(TAB, item)` → `flushed()` is `['add']`; again → `['set']`; `hub.snapshot(TAB)!.items.filter((i) => i.kind === 'report')` is `[item]`; `hub.reportCard('no-such-tab', item)` throws nothing. `item` is `reportItemOf(...)` of a report record.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/report-wake.test.ts tests/unit/report-item.test.ts tests/unit/chat-hub.test.ts`
Expected: FAIL (modules and method missing).

- [ ] **Step 3: Implement** `report-wake.ts`, the `report` item, `reportItemOf` and `reportCard` (hub); run the unit tests: PASS.

- [ ] **Step 4: Write the failing e2e tests** — `tests/e2e/coordinator-report.spec.ts`. A local helper `chatPair(env = {})`: `launchChatTab({ turns: { hello: [{ text: 'Hi there' }] }, fallback: [{ text: 'Noted.' }] }, { work: gitRepo(), env })` → `a = l.tabId`, `b = await openTabInFront(l.page, 'claude', l.work)`; for each of `a`, `b`: `activate`, `sendMessage(page, 'hello')`, then poll `window.ct.chatSnapshot(id)` until `state.sessionId` is set and `state.turn` is `'idle'`; returns `{ l, a, b, sidA, sidB }`.
```ts
test('a report handed to the coordinator\'s watcher shows in its chat as a card, its file links working', async () => {
  const { l, a, b, sidA, sidB } = await chatPair()
  const { page, pipeName } = l
  try {
    mkdirSync(join(l.work, 'notes'), { recursive: true })
    writeFileSync(join(l.work, 'notes', 'report.md'), '# Report\n')
    await makeCoordinator(page, a)
    await coord(pipeName, a, { op: 'attach', session: refOf(sidB) })
    const task = waitForMail(pipeName, b, sidB)
    await coord(pipeName, a, { op: 'message', session: refOf(sidB), text: 'Fix the parser.' })
    await within(task, 10_000)
    const wake = waitForMail(pipeName, a, sidA)
    await done(pipeName, b, sidB, { lastMessage: 'Parser fixed; see notes/report.md. <b>bold?</b>' })
    await within(wake, 15_000)
    await activate(page, a)
    const card = page.locator('.chat-host:visible .coord-report')
    await expect(card).toHaveCount(1)
    await expect(card.locator('.coord-report-title')).toContainText(' · finished · ')
    await expect(card.locator('.coord-report-body .chat-file-link')).toHaveText(['notes/report.md'])
    await expect(card.locator('.coord-report-body')).toContainText('<b>bold?</b>')
    await card.locator('button', { hasText: 'Open session' }).click()
    await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(b)
    await activate(page, a)
    await card.locator('button', { hasText: 'Resolve' }).click()
    await expect.poll(async () => (await page.evaluate((id) => window.ct.coordView(id), a))?.sessions[0]?.group).toBe('resolved')
  } finally { await l.app.close() }
})
test('a report written as a prompt shows as its card, not as a message bubble', async () => {
  // const { l, a, b, sidA, sidB } = await chatPair({ CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' })   // no watcher is held: both go as prompts
  // makeCoordinator(a); attach; message 'Fix the parser.'
  // poll userMessages(l.log) has one starting 'Task from your coordinator, through ClaudeTerm:'; poll b's state.turn 'idle'
  // turnOf(pipeName, b, sidB); done(pipeName, b, sidB, { lastMessage: 'Parser fixed.' })
  // poll userMessages(l.log) has one starting REPORT_WAKE_HEAD (it went to Claude Code), timeout 15 s
  // activate(a): '.chat-host:visible .coord-report' count 1, its body 'Parser fixed.';
  //   '.chat-host:visible .chat-user' with text REPORT_WAKE_HEAD count 0
})
test('a report wake that came only as text is drawn as a card from it, without a time; other mail in it stays a bubble', async () => {
  // const l = await launchChatTab({ turns: {}, fallback: [{ text: 'Noted.' }] }); await chatReady(l.page); const MAIL = randomUUID(), TASK = randomUUID()
  // const text = wake text built in the test, lines joined by '\n': a message block from 'docs · Desktop' [b20000] with '> hello from docs',
  //   a blank line, then a report block: `${REPORT_WAKE_HEAD} its task failed: Claude Code exited.`,
  //   'from: parser · Desktop [a10000] (folder D:\\Work\\acme, branch main)',
  //   `id: ${MAIL}  (the report on task ${TASK}; read_session "a10000" shows the session)`, '', '> Half done.'
  // page.evaluate(([id, t]) => window.ct.chatSend(id, { text: t, attachments: [] }), [l.tabId, text]) → null
  // card: '.coord-report-title' has text 'parser · failed: Claude Code exited'; body 'Half done.'
  // '.chat-host:visible .chat-user' contains 'hello from docs' and does not contain REPORT_WAKE_HEAD
})
```

- [ ] **Step 5: Run them to see them fail**

Run: `npm run build && node scripts/e2e.mjs coordinator-report.spec.ts`
Expected: FAIL (no `.coord-report`).

- [ ] **Step 6: Implement** the renderer and the `index.ts` line; `npm run typecheck` names every switch over `ChatItem` that lacks the new case. `chat.css` gains:
```css
/* a report of a session attached to the coordinator: the agents block's look, its text under its head */
.chat-agents.coord-report { margin: 0 0 10px; }
.coord-report .chat-agents-head { display: flex; align-items: center; gap: 8px; }
.coord-report-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coord-report-title b { color: var(--text); font-weight: 600; }
.coord-report-acts { display: flex; flex: none; gap: 6px; margin-left: auto; }
.coord-report-acts .chat-button { border-color: var(--line-2); background: none; color: var(--text-3); }
.coord-report .chat-step-state.stopped { color: var(--text-3); }
.coord-report[data-outcome="failed"] { border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }
.coord-report-body { padding: 8px 12px 10px; border-top: 1px solid var(--line); color: var(--text-2); font-size: 13px; line-height: 1.5; }
```

- [ ] **Step 7: Run the tests**

Run: `npm run typecheck && npm test && npm run build && node scripts/e2e.mjs coordinator-report.spec.ts chat-event-rows.spec.ts chat-conversation.spec.ts chat-file-links.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**
```bash
git add src/shared/report-wake.ts src/shared/chat.ts src/main/chat/report-item.ts src/main/chat/chat-hub.ts src/main/index.ts src/renderer/chat/report-card.ts src/renderer/chat/chat-items.ts src/renderer/chat/chat-find.ts src/renderer/chat/chat-view.ts src/renderer/main.ts src/renderer/chat/chat.css tests/unit/report-wake.test.ts tests/unit/report-item.test.ts tests/unit/chat-hub.test.ts tests/e2e/coordinator-report.spec.ts
git commit -m "feat: a report shows as a card in the coordinator's chat"
```

---

### Task 9: The Agent messages panel names tasks and reports

**Files:**
- Modify: `src/renderer/mail-panel.ts` (`message` :110-118; new export)
- Modify: `src/renderer/styles.css` (after `.mail-time` :314)
- Create: `tests/unit/mail-panel.test.ts`, `tests/e2e/coordinator-mail.spec.ts`

**Interfaces:**
- Consumes: `MailMessageView.kind/outcome/reason` (part 1), `outcomeText` (Task 8).
- Produces (`mail-panel.ts`):
  ```ts
  /** what a message is, when it is not a plain message: "Task", or "Report · <outcomeText>" */
  export function kindLabel(m: Pick<MailMessageView, 'kind' | 'outcome' | 'reason'>): string | null
  ```
  A message with a label shows `span.mail-kind` after `.mail-device` in its meta (`failed` added for a failed report).

- [ ] **Step 1: Write the failing tests**

`tests/unit/mail-panel.test.ts`:
```ts
it('kindLabel names a task and a report with its outcome, and nothing for a plain message', () => {
  expect(kindLabel({ kind: 'message', outcome: null, reason: null })).toBeNull()
  expect(kindLabel({ kind: 'task', outcome: null, reason: null })).toBe('Task')
  expect(kindLabel({ kind: 'report', outcome: 'finished', reason: null })).toBe('Report · finished')
  expect(kindLabel({ kind: 'report', outcome: 'failed', reason: 'Claude Code exited' })).toBe('Report · failed: Claude Code exited')
  expect(kindLabel({ kind: 'report', outcome: 'stopped', reason: 'its turn was interrupted' })).toBe('Report · stopped')
})
```
`tests/e2e/coordinator-mail.spec.ts`:
```ts
test('the Agent messages panel shows a task and its report with their kinds, and no attach record', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    await makeCoordinator(page, t0)
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })
    const task = waitForMail(pipeName, t1, sids[1])
    await coord(pipeName, t0, { op: 'message', session: refOf(sids[1]), text: 'Fix the parser.' })
    await within(task, 10_000)
    await activate(page, t1)
    await openPanelFocused(page)
    const given = page.locator('#image-panel .mail-message', { hasText: 'Fix the parser.' })
    await expect(given.locator('.mail-kind')).toHaveText('Task')
    // the attach is no message: the tab's conversation holds the task alone
    await expect(page.locator('#image-panel .mail-message')).toHaveCount(1)
    const wake = waitForMail(pipeName, t0, sids[0])
    await done(pipeName, t1, sids[1], { lastMessage: 'Parser fixed.' })
    await within(wake, 15_000)
    await activate(page, t0)
    await expect(page.locator('#image-panel .mail-message', { hasText: 'Parser fixed.' }).locator('.mail-kind')).toHaveText('Report · finished')
  } finally { await l.app.close() }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/mail-panel.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator-mail.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `kindLabel` and the meta's span. `styles.css` gains, after `.mail-time`:
```css
.mail-kind { flex: none; padding: 0 6px; border: 1px solid var(--line-2); border-radius: 6px; color: var(--text-2); font-size: 11px; white-space: nowrap; }
.mail-kind.failed { border-color: color-mix(in srgb, var(--red) 40%, var(--line-2)); color: var(--red); }
```

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx vitest run tests/unit/mail-panel.test.ts && npm run build && node scripts/e2e.mjs coordinator-mail.spec.ts agent-messages.spec.ts`
Expected: PASS.

- [ ] **Step 5: The whole branch**

Run: `npm run typecheck && npm test && npm run test:e2e`
Expected: PASS (review.spec and git-submodule tests can fail under load on this machine: rerun them alone, and on clean master, before blaming the branch).

- [ ] **Step 6: Commit**
```bash
git add src/renderer/mail-panel.ts src/renderer/styles.css tests/unit/mail-panel.test.ts tests/e2e/coordinator-mail.spec.ts
git commit -m "feat: the Agent messages panel names tasks and reports"
```

---

## Interfaces for part 3

Part 3's plan (`docs/superpowers/plans/2026-11-14-coordinator-3-devices.md`, "What part 2 reads from part 3") was checked against this one:

- Detach of an attached tab: the header's Detach and the tab menu's item both call `detachFromCoordinator(tabId)` (`main.ts`), the one renderer call of `ct.coordDetach` that takes a mark's `coordinatorTabId`; both are shown only while `coordinatorTabId !== null`. Part 3's Task 6 Step 3 replaces that call with `ct.coordLeave(tabId)` and shows both for `coordinatorTabId: null` too. The Sessions panel's Detach passes the view's own tab id and stays as it is.
- A remote tab's mark: part 3 adds marks for remote tabs (`CoordMarks` keyed by their tab ids); `TabBarItem.coord` and `arrangeCoordinators` already treat them like local ones (a remote section's groups are arranged too).
- Drag and drop: `dropAttaches` requires `drag.local`; part 3 lifts it once `coordAttach` takes a remote tab, and the Sessions panel's `dropTab` handler the same.
- The Sessions panel draws `row.deviceName` as the device chip and any `marker` (`offline` grey, `attaching` spinning); `attachChoices` lists local tabs only.
- The report card has no device name yet: part 3 adds one to `ReportCardData` from the record's `from.device`.

## Spec coverage

| Design | Task |
|---|---|
| Tab list: Coordinator label, the block, `↳ <project>`, tabs at the top | 1 |
| Header: `Coordinator · N sessions`, the Sessions toggle and its badge, the attached session's line and Detach | 3 |
| Sessions panel: groups with counts and folding, rows, icons, `folder · branch`, the status line, the progress bar, the time | 4 |
| Hover: Open, Message, Detach / Attach / Resolve; a click opens; the problem with its link to the setting | 4, 5 |
| Toolbar: New session, Attach… | 6 |
| Drag and drop: onto the coordinator, out of its block, within it, onto the Sessions panel, tabs at the top | 7 |
| Context menu: Make project coordinator, Stop coordinating, the replace question; detaching from the menu | 2 |
| The report card, its file links, Open session / Resolve; the terminal view unchanged | 8 |
| Agent messages: tasks and reports with their kind, never attach / detach | 9 |
