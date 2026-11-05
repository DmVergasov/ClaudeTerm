# Vertical Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The user's instruction: implementers run on the `haiku` model.**

**Goal:** Tabs can sit on the left as a panel grouped by project, showing each tab's branch, marking extra git worktrees with a colored bar, and keeping forks (made with the new **Fork session** tab menu item) under the tab they came from.

**Architecture:** Main learns each tab's project / worktree / branch from git (`tab-places.ts`) and keeps forks in `TabManager` (`TabInfo.fork`, placement, restore). The renderer derives the left panel's groups and order from the tab order and the places (`tab-groups.ts`, pure), draws them (`tab-panel.ts`) and writes drags back as a new whole order. `tabs.position` is a setting; the panel's width and folded groups live in `tab-layout.json`.

**Tech Stack:** Electron 44, TypeScript (strict), plain DOM renderer, Vitest (unit, integration with real git), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-04-vertical-tabs-design.md`

## Global Constraints

- `tabs.position`: `"top" | "left"`, default `"top"`.
- UI strings, exactly: settings select label `Tabs`, options `On top` / `On the left`; position button tooltips `Tabs on the left` (shown on top) / `Tabs on top` (shown on the left); group `No project`; tab menu item `Fork session`; fork title suffix ` (fork)`; worktree tooltip line `worktree: <path>`; branch tooltip line `branch: <branch>`.
- Left panel width: 240 px default, kept between 160 and 480 px.
- Worktree palette, in order (6 colors): `#61afef`, `#c678dd`, `#56b6c2`, `#98c379`, `#e5c07b`, `#be5046`.
- Fork launch: `claude … --resume <session id> --fork-session`. A fork tab's `claudeSessionId` is `null` until its `SessionStart` arrives.
- Git only through `execGit` (`src/main/git-source.ts`), read-only; the main process never blocks; paths compared with `pathKey`.
- IPC arguments are checked in main (`ipc-guards.ts`); `tab-layout.json` is untrusted on read.
- AGENTS.md: strict TS (`noUnusedLocals`), English comments in the surrounding style, keep line endings, tests never touch the real `~/.claude` or `%APPDATA%\ClaudeTerm`, invented names in tests. Conventional Commits; every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Two projects whose folders have the same name: their group headers must differ (`acme (work)` / `acme (home)`) — test in Task 6.
- A branch switched with `git checkout` while the tab is open: the branch line updates when the tab comes to the front — test in Task 4.
- A tab whose folder was deleted, or git missing: the tab goes to `No project` without errors — test in Task 4.
- A snapshot whose fork points at a tab that is not before it, or at a shell tab: restored as a plain tab — test in Task 2.
- The same repository opened through two spellings of its path (`\` and `/`, different case on Windows): one group — test in Task 4.

---

### Task 1: The `tabs.position` setting and the `--fork-session` launch line

**Files:**
- Modify: `src/shared/types.ts`, `src/main/settings.ts`, `src/shared/settings-keys.ts`, `src/renderer/settings-page.ts`, `src/main/profiles.ts`, `src/main/index.ts` (the two `buildLaunch(... 'claude', {...})` calls in `resolveLaunch`)
- Test: `tests/unit/settings.test.ts`, `tests/unit/settings-keys.test.ts`, `tests/unit/profiles.test.ts`

**Interfaces:**
- Produces: `export type TabPosition = 'top' | 'left'`; `Settings.tabs: { position: TabPosition }`; `DEFAULT_SETTINGS.tabs = { position: 'top' }`; `SettingKey` gains `'tabs.position'`; `ClaudeLaunch.forkSession: boolean`.

- [ ] **Step 1: Write the failing tests**

`settings.test.ts`, next to the `sidePanel.noRoom` test:
```ts
it('tabs.position: on top by default, left when set, other values fall back', () => {
  expect(DEFAULT_SETTINGS.tabs).toEqual({ position: 'top' })
  expect(parseSettings(JSON.stringify({ tabs: { position: 'left' } })).settings.tabs).toEqual({ position: 'left' })
  expect(parseSettings(JSON.stringify({ tabs: { position: 'bottom' } })).settings.tabs).toEqual({ position: 'top' })
})
it('applySettingEdit writes tabs.position', () => {
  const r = applySettingEdit('{}', 'tabs.position', 'left')
  expect(r.ok && JSON.parse(r.text)).toEqual({ tabs: { position: 'left' } })
})
```
`settings-keys.test.ts`: `expect(isSettingKey('tabs.position')).toBe(true)`.
`profiles.test.ts`, next to the `--resume` test (reuse its `claude` fixture, adding `forkSession: false` to it):
```ts
it('buildClaudeCommandLine adds --fork-session after --resume', () => {
  expect(buildClaudeCommandLine('powershell', { ...claude, resumeSessionId: SID, forkSession: true })).toMatch(new RegExp(` --resume ${SID} --fork-session$`))
  expect(() => buildClaudeCommandLine('powershell', { ...claude, resumeSessionId: null, forkSession: true })).toThrow('--fork-session needs a session to resume')
})
```
(`SID` = any UUID constant the file already has, or add one.)

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/settings.test.ts tests/unit/settings-keys.test.ts tests/unit/profiles.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**
- `settings.ts`: `tabs: { position: take('tabs.position', obj(raw.tabs).position, isTabPosition, d.tabs.position) }` with a guard like `isNoRoom`.
- `settings-page.ts`: in the Appearance section after `Panels without room`: `selectField('Tabs', 'tabs.position', (v) => ({ options: TAB_POSITION_OPTIONS, selected: v.settings.tabs.position }), (s) => s)` with `TAB_POSITION_OPTIONS = [{ value: 'top', label: 'On top' }, { value: 'left', label: 'On the left' }]`.
- `profiles.ts`: `ClaudeLaunch.forkSession: boolean`; `buildClaudeCommandLine` appends ` --fork-session` after ` --resume <id>` when `forkSession`; throws `Error('--fork-session needs a session to resume')` when `forkSession` and no session. Every existing `ClaudeLaunch` literal (index.ts, tests) passes `forkSession: false`.

- [ ] **Step 4: Run them and see them pass**, then `npm run typecheck` and `npm test`.

- [ ] **Step 5: Commit** — `feat: the tabs.position setting and the --fork-session launch line`

---

### Task 2: Forks in `TabManager` and in the session snapshot

**Files:**
- Modify: `src/shared/types.ts`, `src/main/tab-manager.ts`, `src/main/session-store.ts`
- Test: `tests/unit/tab-manager.test.ts`, `tests/unit/session-store.test.ts`

**Interfaces:**
- Consumes: `ClaudeLaunch.forkSession` (Task 1) — not directly; `LaunchRequest` carries `fork`.
- Produces, in `types.ts`:
  - `export interface TabFork { /** the family's head while it is open */ of: string | null; /** the session id the fork was made from */ from: string }`
  - `TabInfo.fork: TabFork | null`; `OpenTabRequest.fork?: TabFork | null`
  - `SessionSnapshotTab.fork: { of: number | null; from: string } | null` — `of` is the head's index in the snapshot's tab list
- Produces, in `TabManager`: `canFork(tabId: string): boolean`; `fork(tabId: string): TabInfo | null`.

Rules (spec, Forks):
- `open(req)`: `info.fork` = for a Claude tab with `req.fork`: `{ of: req.fork.of if that tab exists, else null, from: req.fork.from }`; otherwise `null`. `claudeSessionId` stays `req.resumeSessionId ?? null` (a new fork has none). When `info.fork?.of` is set, the tab is inserted in `order` right after the family's last tab — the last index `i` with `order[i] === of` or `tabs.get(order[i]).info.fork?.of === of` — and `events.order([...order])` is emitted; otherwise it is appended as now.
- `canFork(tabId)`: a Claude tab whose `resumeId(rec)` is not null.
- `fork(tabId)`: null unless `canFork`; otherwise `open({ kind: 'claude', cwd: info.cwd, account: info.account, title: info.customTitle === null ? null : `${info.customTitle} (fork)`, fork: { of: info.fork?.of ?? info.id, from: resumeId(rec)! } })`.
- `close(tabId)`: every tab whose `fork.of === tabId` gets `fork = { of: null, from }` and an `events.updated`.
- `restart` and `switchAccount` pass `fork: rec.info.fork` in the `resolveLaunch` request (with `resumeSessionId: this.resumeId(rec)` as now). `resolveLaunch` (Task 3) turns "no session + fork" into the fork launch.
- `snapshot()`: `fork: info.fork ? { of: info.fork.of === null || order.indexOf(info.fork.of) < 0 ? null : order.indexOf(info.fork.of), from: info.fork.from } : null`.
- `parseSnapshot`: `fork` kept only for a Claude tab, with `from` a UUID; `of` kept only when it is an integer `>= 0`, less than this tab's index, and the tab at `of` is a Claude tab — else `of: null`; anything else → `fork: null`. Old snapshots (no `fork`) → `null`.

- [ ] **Step 1: Write the failing tests** (`tab-manager.test.ts` uses its `setup()`; give `resumable` a stub returning true unless a test says otherwise):
  - `fork opens a Claude tab in the parent's folder and account, with no session id, launched to fork the parent's conversation`: parent with `claudeSessionId = SID_A` (open with `resumeSessionId: SID_A`); `fork(parent.id)` → new `TabInfo` with `kind: 'claude'`, same `cwd` and `account`, `claudeSessionId: null`, `fork: { of: parent.id, from: SID_A }`; the last `LaunchRequest` has `resumeSessionId` null/undefined and `fork: { of: parent.id, from: SID_A }`.
  - `a fork of a renamed tab starts with its name and (fork)`: parent renamed `auth refactor` → fork's `customTitle === 'auth refactor (fork)'`; an unnamed parent → fork's `customTitle === null`.
  - `a fork stands right after its family, and a fork of a fork joins the family`: tabs A, B; fork A → order `[A, A1, B]`; fork A1 (give A1 a session with `setClaudeSession`) → order `[A, A1, A2, B]` and `A2.fork.of === A`; the log has an `order:` entry.
  - `canFork is false for a shell tab, a Claude tab without a session, and one whose conversation cannot be resumed` (`resumable` returning false).
  - `closing the head turns its forks into ordinary tabs; closing a fork leaves the family`: A, A1, A2; close A1 → `A2.fork.of === A`; close A → `A2.fork` is `{ of: null, from: SID_A }` and the log has `updated:A2`.
  - `restart of a fork without its own conversation forks again; with one it resumes it`: fork F (no session) exits; `restart(F)` → last `LaunchRequest` has `resumeSessionId` null and `fork` set; after `setClaudeSession(F, SID_B)` → `resumeSessionId: SID_B`.
  - `snapshot keeps a fork's head as an index`: `[A, A1]` → `snapshot()[1].fork` is `{ of: 0, from: SID_A }`; after closing A → `{ of: null, from: SID_A }`.
  `session-store.test.ts`: `parseSnapshot keeps a fork whose head comes before it, and drops a bad one`: valid `{ of: 0, from: SID }` on tab 1 kept; `of: 1` on tab 0 → `of: null`; `of` pointing at a shell tab → `of: null`; `from: 'x'` → `fork: null`; on a shell tab → `fork: null`; an old snapshot without `fork` → `null`. Update the file's `claudeTab`/`shellTab` fixtures with `fork: null`.

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/unit/tab-manager.test.ts tests/unit/session-store.test.ts`.

- [ ] **Step 3: Implement** the rules above. Fix every `TabInfo` / `SessionSnapshotTab` literal the compiler finds (`fork: null`).

- [ ] **Step 4: Run them and see them pass**, then `npm run typecheck`, `npm test`.

- [ ] **Step 5: Commit** — `feat: tabs can be forked, and forks keep their family`

---

### Task 3: Forking from main: the launch, IPC and Restore

**Files:**
- Modify: `src/main/index.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`
- Create: `tests/e2e/forks.spec.ts`
- Modify: `tests/e2e/helpers.ts`

**Interfaces:**
- Consumes: `TabManager.canFork/fork`, `TabInfo.fork`, `SessionSnapshotTab.fork` (Task 2), `ClaudeLaunch.forkSession` (Task 1).
- Produces: `IPC.tabsCanFork = 'tabs:can-fork'` (invoke), `IPC.tabsFork = 'tabs:fork'` (send); `CtApi.canForkTab(tabId: string): Promise<boolean>`, `CtApi.forkTab(tabId: string): void`. Helper `writeTranscript(config: string, cwd: string, id: string): string` in `tests/e2e/helpers.ts` — writes `<config>/projects/<cwd with every non-alphanumeric char as ->/<id>.jsonl` holding one line `{"type":"user","cwd":<cwd>,"entrypoint":"cli","isSidechain":false,"message":{"role":"user","content":"hello"}}` and returns its path.

- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/forks.spec.ts` (pattern: `restore.spec.ts`; the stand-in `claude` prints its arguments; a session is given to a tab with `sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source, transcriptPath })` where `transcriptPath` is a file made with `writeTranscript` in a temp `CLAUDE_CONFIG_DIR`, so the conversation can be resumed). Read tab order with `window.__ct!.tabIds()` and the snapshot from `<dataDir>/session-state.json` (poll: it is saved after 500 ms):
  1. `a Claude tab without a conversation cannot be forked` — `ct.canForkTab(id)` is false.
  2. `Fork session opens a tab that forks the conversation, after its family, without a session of its own` — tabs A (Claude, session SID_A with transcript) and B (shell); `canForkTab(A)` true; `forkTab(A)` → `tabIds()` is `[A, F, B]`; F's buffer contains `--resume ${SID_A} --fork-session`; the snapshot's F has `claudeSessionId: null` and `fork: { of: 0, from: SID_A }`; after `session` for F with `SID_B`, `source: 'fork'` → the snapshot's F has `claudeSessionId: SID_B`.
  3. `a fork of a fork joins the family` — F given SID_B with a transcript; `forkTab(F)` → `[A, F, F2, B]`, snapshot F2 `fork.of === 0`.
  4. `closing the head turns the forks into ordinary tabs` — close A → snapshot F `fork: { of: null, from: SID_A }`.
  5. `Restore keeps forks under their head, and forks again a fork that had no conversation of its own` — snapshot file with A (SID_A) and F `{ claudeSessionId: SID_B, fork: { of: 0, from: SID_A } }`, no transcript for SID_B → after Restore F's buffer contains `--resume ${SID_A} --fork-session`; with a transcript for SID_B in the test's `CLAUDE_CONFIG_DIR` → F's buffer contains `--resume ${SID_B}` and not `--fork-session`; in both, `tabIds()` is `[A, F]`.

- [ ] **Step 2: Run them and see them fail** — `npm run build && npx playwright test tests/e2e/forks.spec.ts`.

- [ ] **Step 3: Implement in `src/main/index.ts`**
- `resolveLaunch` for a Claude tab: `const forkFrom = !req.resumeSessionId && req.fork ? req.fork.from : null`; the launch gets `resumeSessionId: req.resumeSessionId ?? forkFrom, forkSession: forkFrom !== null`.
- `ipcMain.handle(IPC.tabsCanFork, (_e, id: unknown) => isId(id) && tabs.canFork(id))`; `ipcMain.on(IPC.tabsFork, (_e, id: unknown) => { if (isId(id)) tabs.fork(id) })`; preload entries.
- `runRestore` becomes async: opened tabs are remembered by snapshot index; a snapshot tab with `fork` opens with `fork: { of: <the opened id of index fork.of, or null>, from }` and with `resumeSessionId` = its `claudeSessionId` only when that conversation has a transcript — `await findTranscript(join(claudeProjectsDir(process.env, homedir()), t.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`), id) !== null` — else `null` (so it forks again). Tabs without `fork` restore as now.

- [ ] **Step 4: Run them and see them pass**, then `npm run typecheck`, `npm test`, and `npx playwright test tests/e2e/restore.spec.ts tests/e2e/recent-sessions.spec.ts`.

- [ ] **Step 5: Commit** — `feat: Fork session from main, kept across Restore`

---

### Task 4: Each tab's project, worktree and branch

**Files:**
- Create: `src/main/tab-places.ts`, `tests/unit/tab-places.test.ts`, `tests/integration/tab-places.int.test.ts`
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  /** where a tab's folder is in git: its project, the linked worktree it is in (null for the main worktree), its branch */
  export interface TabPlace {
    project: { key: string; name: string; parent: string }
    worktree: { path: string; color: number } | null
    branch: string
  }
  ```
  `project.key` = `pathKey` of the main worktree's (or bare repository's) path; `name` = its folder name (a bare `acme.git` → `acme`); `parent` = the name of the folder holding it (for telling apart projects with the same name).
- Produces, in `tab-places.ts`:
  - `export const WORKTREE_COLORS = 6`
  - `export interface WorktreeEntry { path: string; bare: boolean; branch: string | null; head: string | null }`
  - `export function parseWorktreeList(porcelain: string): WorktreeEntry[]` — blocks separated by blank lines; `worktree <path>`, `bare`, `branch refs/heads/<name>` → `<name>`, `HEAD <sha>`, `detached`.
  - `export function worktreeColors(paths: string[], size = WORKTREE_COLORS): Map<string, number>` — keys `pathKey(path)`.
  - `export async function folderPlace(run: GitRun, folder: string): Promise<TabPlace | null>`
  - `export class TabPlaces { constructor(deps: { run: GitRun; publish(tabId: string, place: TabPlace | null): void }); addTab(tabId: string, cwd: string): void; removeTab(tabId: string): void; refresh(tabId: string): void; refreshAll(): void }`
- Produces IPC: `IPC.evTabPlace = 'ev:tab-place'`; `CtApi.onTabPlace(cb: (tabId: string, place: TabPlace | null) => void): Unsubscribe`.

Algorithms:
- `worktreeColors`: sort the paths by `pathKey`; for each, `start = hash(pathKey(path)) % size` where `hash` is a 32-bit FNV-1a of the string; take the first index from `start` (wrapping) not used yet by an earlier path; when all are used, take `start`.
- `folderPlace`: if the folder does not exist → null. `rev-parse --show-toplevel` → `top` (code ≠ 0 or empty → null). `worktree list --porcelain` → entries (empty → null). `main = entries[0]`. `bare = main.bare`. Project: `{ key: pathKey(main.path), name: bare ? basename(main.path).replace(/\.git$/i, '') : basename(main.path), parent: basename(dirname(main.path)) }`. Linked paths: `bare ? entries.filter((e) => !e.bare).map((e) => e.path) : entries.slice(1).map((e) => e.path)`. The folder's entry: the one with `pathKey(e.path) === pathKey(top)`. Worktree: `bare || pathKey(top) !== pathKey(main.path) ? { path: entry.path, color: worktreeColors(linked).get(pathKey(entry.path))! } : null`. Branch: `entry.branch ?? (entry.head ?? '').slice(0, 7)`. Any `GitError` (git missing, timeout) → null.
- `TabPlaces`: per tab its `cwd`; `addTab` and `refresh` ask `folderPlace` for that folder and `publish` when the answer differs from the last one published for the tab (compare `JSON.stringify`); a tab removed meanwhile publishes nothing. Concurrent asks for the same folder share one promise; `refreshAll` refreshes every tab.

- [ ] **Step 1: Write the failing tests**
  - Unit (`tab-places.test.ts`): `parseWorktreeList` on a fixed porcelain text with a main worktree on `main`, a linked one on `feat/x`, a detached one, and a bare repository's list; `worktreeColors` gives different colors to 6 paths, the same map for the same paths in any input order, and a color unchanged for a path when another path is added that does not collide with it.
  - Integration (`tab-places.int.test.ts`, real git in temp folders as `git-source.int.test.ts` does):
    - main worktree → `{ project: { key, name: <repo folder name>, parent }, worktree: null, branch: <current branch> }`;
    - a linked worktree (`git worktree add -b feat/x <path>`) → same `project.key`, `worktree.path` that folder, `branch: 'feat/x'`;
    - a subfolder of the repository → same as its worktree;
    - detached HEAD (`git checkout --detach`) → `branch` is the 7-character commit id;
    - a submodule (`git -c protocol.file.allow=always submodule add <other repo> sub`) → its own project (`name: 'sub'`), not the superproject;
    - a bare repository `acme.git` with a worktree → `name: 'acme'` and a non-null `worktree`;
    - a folder outside git → null; a folder that does not exist → null;
    - the same repository given as `path` and as `path` with `/` separators (and upper-case on Windows) → equal `project.key`;
    - after `git checkout -b other` in the repository, `TabPlaces.refresh(tab)` publishes `branch: 'other'`.

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/unit/tab-places.test.ts tests/integration/tab-places.int.test.ts`.

- [ ] **Step 3: Implement** `tab-places.ts`, the type, the IPC channel and preload entry. Wire in `index.ts`: `const places = new TabPlaces({ run: execGit, publish: (id, place) => send(IPC.evTabPlace, id, place) })`; `onTabStarted` → `places.addTab(tab.id, tab.cwd)`; `onTabClosed` → `places.removeTab(tabId)`; `events.activated` → `places.refresh(id)`; `win.on('focus')` → `places.refreshAll()`; the pipe `attention` handler with `reason === 'done'` → `places.refresh(msg.tabId)`.

- [ ] **Step 4: Run them and see them pass**, then `npm run typecheck`, `npm test`.

- [ ] **Step 5: Commit** — `feat: main knows each tab's project, worktree and branch`

---

### Task 5: The left panel's layout state

**Files:**
- Create: `src/main/tab-layout.ts`, `tests/unit/tab-layout.test.ts`
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts`, `src/main/index.ts`

**Interfaces:**
- Produces: `export interface TabLayout { width: number; folded: string[] }` (`types.ts`); `export const TAB_PANEL_WIDTH = { min: 160, max: 480, initial: 240 }` (`types.ts`); `export class TabLayoutStore { readonly path: string; constructor(dir: string, onError?: (m: string) => void); get(): TabLayout; set(change: Partial<TabLayout>): void }` — file `tab-layout.json`, written like `StarredSessions` (`.tmp` + rename) on every `set`; `IPC.layoutGet = 'layout:get'` (invoke → `TabLayout`), `IPC.layoutSet = 'layout:set'` (send `Partial<TabLayout>`); `CtApi.getTabLayout(): Promise<TabLayout>`, `CtApi.setTabLayout(change: Partial<TabLayout>): void`; guard `isTabLayoutChange(v): v is Partial<TabLayout>` — an object whose `width`, if present, is a finite number and whose `folded`, if present, is an array of at most 200 strings of at most 4096 characters.

- [ ] **Step 1: Write the failing tests** (`tab-layout.test.ts`, temp dirs): a missing file → `{ width: 240, folded: [] }`; `set({ width: 300 })` then a new store reads `{ width: 300, folded: [] }`; `set({ folded: ['k'] })` keeps the width; a width outside 160–480 is clamped on `set` and on read; a corrupt file → the defaults and `onError('ignoring corrupt <path>')`; non-string entries of `folded` dropped. `ipc-guards.test.ts`: `isTabLayoutChange`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement**; in `index.ts`: `const tabLayout = new TabLayoutStore(dataDir, toast)`; `ipcMain.handle(IPC.layoutGet, () => tabLayout.get())`; `ipcMain.on(IPC.layoutSet, (_e, c: unknown) => { if (isTabLayoutChange(c)) tabLayout.set(c) })`.

- [ ] **Step 4: Run them and see them pass**, `npm run typecheck`, `npm test`.

- [ ] **Step 5: Commit** — `feat: the left tab panel's width and folded groups are kept`

---

### Task 6: The left panel's groups and order (pure)

**Files:**
- Create: `src/renderer/tab-groups.ts`, `tests/unit/tab-groups.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const NO_PROJECT = '~none'
  export interface GroupInput { id: string; place: TabPlace | null; forkOf: string | null }
  export interface PanelRow { id: string; fork: boolean }
  export interface PanelGroup { key: string; project: TabPlace['project'] | null; rows: PanelRow[] }
  export function panelGroups(tabs: GroupInput[]): PanelGroup[]
  export function panelOrder(groups: PanelGroup[]): string[]
  export function moveTab(groups: PanelGroup[], dragId: string, targetId: string): string[] | null
  export function moveGroup(groups: PanelGroup[], dragKey: string, targetKey: string): string[] | null
  export function groupLabels(groups: PanelGroup[]): Map<string, string>
  ```
  `tabs` come in the tab order main keeps.

Rules:
- `panelGroups`: a tab's group key is `place?.project.key ?? NO_PROJECT`; groups in the order of their first tab, `NO_PROJECT` last. Inside a group, rows in tab order, except that a tab whose `forkOf` names a tab of the same group stands right after that head and the head's earlier forks (`fork: true`); a fork whose head is not in the list (or is in another group) is an ordinary row with `fork: false`.
- `panelOrder`: the rows of every group, in order.
- `moveTab`: a fork moves only to another row of its own family (`targetId` is its head or a fork of the same head), and lands at the target's place among the forks; a non-fork tab moves only to another non-fork row of its own group, carrying its forks with it, and lands before the target's family when moving up, after it when moving down. Anything else → `null`. The result is the new whole order.
- `moveGroup`: the group `dragKey` moves before `targetKey` when moving up, after it when moving down; `NO_PROJECT` never moves and nothing moves after it. Result: the new whole order; `null` when nothing changes.
- `groupLabels`: a project's label is its `name`; when two groups have the same name, each becomes `name (parent)`; `NO_PROJECT` → `No project`.

- [ ] **Step 1: Write the failing tests** — one per rule, with places built by a small helper (`place('C:/w/acme')` etc.): two projects and a tab outside git in mixed order → groups and their order, `NO_PROJECT` last; a family `[A, B, A1]` (A1 fork of A) → group rows `A, A1(fork), B`; a fork whose head is closed → ordinary; `panelOrder` flattening; `moveTab` within a group (up and down, family carried), a fork within its family, a fork onto another family → null, a tab onto another group → null; `moveGroup` up and down and onto `NO_PROJECT`; `groupLabels` with `acme` in `work` and in `home`.

- [ ] **Step 2–4:** run, implement, run (`npx vitest run tests/unit/tab-groups.test.ts`), `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat: the left tab panel's groups and order`

---

### Task 7: The left tab panel

**Files:**
- Create: `src/renderer/tab-panel.ts`, `tests/e2e/tab-panel.spec.ts`
- Modify: `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/main.ts`, `src/renderer/tabbar.ts`, `tests/e2e/helpers.ts`

**Interfaces:**
- Consumes: `Settings.tabs.position` (Task 1), `CtApi.onTabPlace` (Task 4), `getTabLayout/setTabLayout`, `TAB_PANEL_WIDTH` (Task 5), `panelGroups`, `panelOrder`, `groupLabels`, `NO_PROJECT` (Task 6).
- Produces:
  - `TabBarItem` gains `place: TabPlace | null` and `forkOf: string | null`; `TabBarCallbacks` gains `switchPosition(): void`.
  - `export class TabPanel { constructor(root: HTMLElement, cb: TabBarCallbacks, platform: string, layout: TabLayout, saveLayout: (c: Partial<TabLayout>) => void); render(items: TabBarItem[], activeId: string | null): void; setChanges(available: boolean, visible: boolean, unviewed: number): void; setImages(visible: boolean, unseen: number): void; unfoldFor(tabId: string): void; get visualOrder(): string[] }`
  - DOM contract (tests rely on it): `#tabpanel` (a sibling before `#workspace`, inside a new `#main-row` flex row that holds `#tabpanel` and `#workspace`); header `.tp-head` with `.tab-new`, `.tab-menu`, `.tab-changes-toggle`, `.tab-images-toggle`, `.tab-position`; `.tp-list`; group `.tp-group[data-group="<key>"]` (class `folded`) with header `.tp-group-head` holding `.tp-group-name`, and when folded `.tp-group-count` and `.tp-group-dot` (class `pulse` for attention); rows `.tp-tab[data-tab-id]` (classes `active`, `attention`, `exited`, `fork`) with `.tab-icon`, `.tab-title`, `.tab-muted`, `.tab-bell`, `.tab-images`, `.tab-close`, and a second line `.tp-branch`; a linked worktree's row has `.tp-wtbar` with `style.background` set to the palette color and its `.tp-branch` colored the same; `.tp-resize` on the panel's right edge. On top, `#tabbar` gets a `.tab-position` button at its right end.

Behavior (spec, The left panel): `main.ts` shows `#tabbar` or `#tabpanel` by `settings.tabs.position` (and switches on `applySettings`); both get the same items and callbacks; `switchPosition` calls `ct.setSetting('tabs.position', <the other>)`. Rows render as the spec describes (row tooltip: title, folder, `branch: …`, `worktree: …`); the palette colors are the Global Constraints' list indexed by `place.worktree.color`. A click on `.tp-group-head` folds/unfolds it and calls `saveLayout({ folded })` (keys); folded groups show the count and the dot (pulsing if a tab has `attention`, steady if one has `bell`). Dragging `.tp-resize` sets the width within `TAB_PANEL_WIDTH` and calls `saveLayout({ width })` on mouse up. Double-click renames, middle-click closes, right-click opens the tab menu, as `TabBar` does (reuse its rename code by moving it into a shared function if needed). `main.ts` keeps the places from `onTabPlace` per tab and passes them in the items; the tab title gets ` (fork)` when `info.fork` is set and `customTitle` is null (`titleOf`).

- [ ] **Step 1: Write the failing e2e tests** (`tab-panel.spec.ts`; helpers: `gitRepo()` exists, add `gitWorktree(repo: string, branch: string): string` running `git worktree add -b <branch> <new temp folder>`; open shell tabs with `ct.openTab({ kind: 'shell', cwd })`; read the current branch with `git rev-parse --abbrev-ref HEAD`):
  1. `the position button and the Settings window put the tabs on the left and back` — default: `#tabbar` visible, `#tabpanel` hidden; click `#tabbar .tab-position` (title `Tabs on the left`) → `#tabpanel` visible, `#tabbar` hidden, `settings.json` has `tabs.position: 'left'`; click `#tabpanel .tab-position` (title `Tabs on top`) → back; in the Settings window select `On the left` in the `Tabs` field → the panel shows.
  2. `tabs are grouped by project, with No project last` — settings `tabs.position: 'left'`; tabs in repo A, a non-git folder, repo B, repo A again → `.tp-group-name` texts (case-insensitive) `[A's folder, B's folder, 'No project']`; group A holds two rows.
  3. `every tab in git shows its branch; a linked worktree's tab has a colored bar` — tab in repo A and in a worktree of A on `feat/x` → both in group A; `.tp-branch` texts `[<A's branch>, 'feat/x']`; only the worktree row has `.tp-wtbar`; the non-git tab has no `.tp-branch`.
  4. `a folded group shows its count and a dot, and stays folded after a restart` — fold group A (2 tabs) → `.tp-group-count` text `2`, rows hidden; ring the bell in A's inactive tab (`bellCommand()` typed into it before activating another) → `.tp-group-dot` visible without `pulse`; a Claude tab in group B (inactive) gets a pipe `attention` message with `reason: 'permission'`, fold B → B's `.tp-group-dot` has `pulse`; close the window and launch again with the same data dir, Restore → group A still `folded`.
  5. `the panel's width is dragged and kept` — drag `.tp-resize` 100 px right → `#tabpanel` width 340; drag far left → 160; relaunch with the same data dir → 160.
  6. `the panel header's buttons work like the tab bar's` — `.tp-head .tab-images-toggle` opens and closes the Media panel; `.tp-head .tab-new` opens a tab.
  7. `the terminal is not resized when nothing in the layout changes` — with the panel on the left, open and switch tabs; `ptySizes` of the first tab has one entry after it settled.

- [ ] **Step 2: Run them and see them fail** — `npm run build && npx playwright test tests/e2e/tab-panel.spec.ts`.

- [ ] **Step 3: Implement** `tab-panel.ts`, the HTML (`#main-row`), styles (the prototype's look: rows 2 lines, 26/15 px, group headers 10.5 px uppercase, `.tp-wtbar` 3 px wide at `left: 6px`, active row `inset 2px 0 0 var(--accent)`), the `TabBar` position button (vertical-split icon from the prototype), and the `main.ts` wiring.

- [ ] **Step 4: Run them and see them pass**, then `npm run typecheck`, `npm test`, `npx playwright test tests/e2e/tabs.spec.ts tests/e2e/image-button.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/layout.spec.ts`.

- [ ] **Step 5: Commit** — `feat: tabs on the left, grouped by project, with branches and worktrees`

---

### Task 8: Forks in the window

**Files:**
- Modify: `src/renderer/main.ts`, `src/renderer/tab-panel.ts`, `src/renderer/styles.css`
- Test: `tests/e2e/forks.spec.ts`

**Interfaces:**
- Consumes: `ct.canForkTab`, `ct.forkTab` (Task 3), `TabPanel` rows with class `fork` (Task 7), `panelGroups` (Task 6).

Behavior: the tab menu (`tabMenu` in `main.ts`) of a Claude tab gets `Fork session` right after `Restart session`, enabled when `await ct.canForkTab(id)` (asked before the menu shows, like the star), and running `ct.forkTab(id)`. In the left panel a fork row has class `fork`, indented one level (`padding-left` + 14 px) with a `↳` before its icon.

- [ ] **Step 1: Write the failing e2e tests** (append to `forks.spec.ts`):
  1. `the tab menu forks a Claude tab, and the fork shows as one` — a Claude tab without a session: right-click → `Fork session` has class `disabled`; after its session with a transcript: right-click → `Fork session` → a new tab titled `<parent's title> (fork)` (`window.__ct!.tabTitle`); on the left, its row has class `fork` and stands right after the parent's row.
  2. `a renamed tab's fork starts with its name` — rename the parent `auth refactor` (double-click, type, Enter) → fork title `auth refactor (fork)`.
  3. `closing the head leaves its forks as ordinary rows that keep (fork)` — on the left, close the parent → the fork row has no class `fork`, its title still ends with ` (fork)`.
  4. `on top, a new fork stands after its family` — tabs `[A, B]`, fork A twice → `#tabbar .tab` order `A, A (fork), A (fork), B`.

- [ ] **Step 2–4:** run (`npm run build && npx playwright test tests/e2e/forks.spec.ts`), implement, run; then `npm run typecheck`, `npm test`.

- [ ] **Step 5: Commit** — `feat: Fork session in the tab menu, forks shown under their tab`

---

### Task 9: Order on the left: dragging, the keyboard, unfolding; README

**Files:**
- Modify: `src/renderer/tab-panel.ts`, `src/renderer/main.ts`, `README.md`, `docs/images/*` (only those that change)
- Test: `tests/e2e/tab-panel.spec.ts`

**Interfaces:**
- Consumes: `moveTab`, `moveGroup`, `panelOrder` (Task 6), `TabPanel.visualOrder`, `TabPanel.unfoldFor` (Task 7), `ct.reorderTabs`.

Behavior: in the left panel, dragging a row onto another row calls `moveTab` and, when it answers an order, `cb.reorder(order)`; dragging a group header onto another calls `moveGroup` likewise. With tabs on the left, `cycleTabs` and `gotoTab` in `main.ts` use `tabPanel.visualOrder` instead of `order`. When a tab becomes active (`activate`) while on the left, `tabPanel.unfoldFor(tabId)` unfolds its group and saves the folded list.

- [ ] **Step 1: Write the failing e2e tests** (append to `tab-panel.spec.ts`; drag with Playwright's `dragTo`, as `tabs.spec.ts` does):
  1. `Ctrl+Tab and Ctrl+Alt+N follow the panel's order` — tabs opened A1 (repo A), B1 (repo B), A2 (repo A) → panel order `A1, A2, B1`; active A1, press `KEYS.nextTab` → A2 active, again → B1; `Control+Alt+Digit2` (`Meta+Digit2` on macOS) → A2.
  2. `a tab in a folded group that becomes active unfolds it` — fold group B, press `KEYS.nextTab` until B1 is active → group B not `folded`; after a relaunch with the same data dir and Restore it is still unfolded.
  3. `a tab is dragged within its group, not into another` — drag A2 onto A1 → `tabIds()` order has A2 before A1; drag A1 onto B1 → order unchanged.
  4. `a group is dragged by its header` — drag group B's header onto group A's → `tabIds()` order starts with B1.
  5. `a family moves together, and a fork stays in its family` — (Claude tab with a session + transcript, as in `forks.spec.ts`) A, fork A1, B in the same repo → drag A onto B → order `B, A, A1`; drag A1 onto B → unchanged.

- [ ] **Step 2–4:** run, implement, run (`npm run build && npx playwright test tests/e2e/tab-panel.spec.ts tests/e2e/keys.spec.ts tests/e2e/tabs.spec.ts`).

- [ ] **Step 5: README** — Features → "A real terminal, with tabs": a bullet on tabs on the left (grouped by project, branch on every tab, a colored bar for a worktree, folding) and on **Fork session**; the `tabs.position` row in the settings table. Run `npm run screenshots`; commit only the images that changed because of this work, invented data only.

- [ ] **Step 6: Whole suite** — `npm run typecheck`, `npm test`, `npm run test:e2e`; a failure outside these files: rerun it alone and compare with the base commit before calling it unrelated.

- [ ] **Step 7: Commit** — `feat: the left panel's order follows drags and the keyboard`; README and images in a `docs:` commit.
