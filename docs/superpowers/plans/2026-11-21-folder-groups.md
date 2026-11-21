# Folder Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs whose folder is outside any git repository are grouped by that folder in the left panel and the tab bar; a git repository still decides the group when there is one.

**Architecture:** Only the window's grouping changes. A pure helper in `src/renderer/tab-groups.ts` turns a folder git confirmed to be outside a repository into a folder group; `panelGroups` keys a tab by its git project, else its folder group, else No project. `src/renderer/main.ts` fills the new item field from the `places` map it already keeps.

**Tech Stack:** TypeScript (strict, `noUnusedLocals`), Vitest, Playwright for Electron.

**Spec:** `docs/superpowers/specs/2026-11-21-folder-groups-design.md`

## Global Constraints

- Do not commit: leave every change in the working tree.
- Keep each file's line endings (the sources are CRLF in this checkout).
- Comments and test names in English, in the surrounding style (lower-case doc comments that say what a thing is).
- No change in `src/main`, `src/shared` or the device sync format.
- Folder groups have no **+ Coordinator** chip, no project note and no branch line.
- The home folder and drive or file-system roots stay in No project; a tab whose place is not known yet stays in No project.
- `-g` does not pass through `npm run`: run one e2e test with `npm run build` then `node scripts/e2e.mjs <spec> -g "<title part>"`.

## Review Focus

- The same folder written two ways by two tabs (`D:\W\Space` and `d:/w/space\`) must make one group, not two.
- A UNC folder (`\\nas\games\Space`) groups like any Windows folder: case-insensitive, named `Space`.
- A folder group with the same name as a git project: both labels get their parent folder.
- A paired device's tab in that device's home folder (`/home/dev`, `C:\Users\dev`) stays in No project, though this window does not know that device's home.
- A tab with a git place never goes to a folder group, whatever else its item carries.

---

### Task 1: Folder groups in the grouping module

**Files:**
- Modify: `src/renderer/tab-groups.ts` (`GroupInput`, `PanelGroup`, `panelGroups`, `groupChip`; new `FolderGroup`, `folderGroupOf`, `FOLDER_KEY_PREFIX`)
- Test: `tests/unit/tab-groups.test.ts`

**Interfaces:**
- Produces:
  - `export interface FolderGroup { key: string; name: string; parent: string }`
  - `export const FOLDER_KEY_PREFIX = 'folder:'`
  - `export function folderGroupOf(folder: string, home: string | null): FolderGroup | null` — null for `home`, for the usual home folders (`X:\Users\<name>`, `/Users/<name>`, `/home/<name>`, `/root`) and for a drive or file-system root.
  - `GroupInput` gains `outside?: FolderGroup | null` — the folder group of a tab whose folder git confirmed to be outside any repository; absent or null otherwise.
  - `PanelGroup` gains `folder?: true` — set on a folder group, whose `project` is its `FolderGroup`.

- [ ] **Step 1: Write the failing tests** in a new `describe('folder groups', …)` in `tests/unit/tab-groups.test.ts`. Use a helper `const out = (id: string, folder: string): GroupInput => ({ id, place: null, forkOf: null, outside: folderGroupOf(folder, 'C:\\Users\\dev') })`.

```ts
it('a Windows folder is keyed lower-cased with / separators and named by its own folder, its parent kept', () => {
  expect(folderGroupOf('D:\\Workspace\\SpaceGame', null)).toEqual({ key: 'folder:d:/workspace/spacegame', name: 'SpaceGame', parent: 'Workspace' })
  expect(folderGroupOf('d:/workspace/SPACEGAME\\', null)?.key).toBe('folder:d:/workspace/spacegame')
  expect(folderGroupOf('\\\\nas\\games\\Space', null)).toEqual({ key: 'folder://nas/games/space', name: 'Space', parent: 'games' })
})
it('a POSIX folder keeps its case', () => {
  expect(folderGroupOf('/srv/Games/Space/', null)).toEqual({ key: 'folder:/srv/Games/Space', name: 'Space', parent: 'Games' })
})
it('the home folder, the usual home folders and the roots have no folder group; a folder inside home has one', () => {
  for (const f of ['C:\\Users\\Dev', 'c:/users/dev/']) expect(folderGroupOf(f, 'C:\\Users\\dev')).toBeNull()
  for (const f of ['C:\\Users\\someone', '/Users/someone', '/home/someone', '/root', 'D:\\', 'D:', '/']) expect(folderGroupOf(f, null)).toBeNull()
  expect(folderGroupOf('C:\\Users\\dev\\games\\Space', 'C:\\Users\\dev')?.name).toBe('Space')
})
it('tabs outside git are grouped by their folder after the projects; unknown places and the home folder stay in No project, last', () => {
  const groups = panelGroups([tab('A', acme), out('S1', 'D:\\w\\Space'), tab('N', null), out('S2', 'd:/w/space/'), out('H', 'C:\\Users\\dev')])
  expect(groups.map((g) => g.key)).toEqual(['c:/w/acme', 'folder:d:/w/space', NO_PROJECT])
  expect(rows(groups[1])).toEqual(['S1', 'S2'])
  expect(groups[1].project).toEqual({ key: 'folder:d:/w/space', name: 'Space', parent: 'w' })
  expect(groups[1].folder).toBe(true)
  expect(groups[0].folder).toBeUndefined()
  expect(rows(groups[2])).toEqual(['N', 'H'])
})
it('a git place wins over a folder group', () => {
  const groups = panelGroups([{ id: 'G', place: acme, forkOf: null, outside: folderGroupOf('D:\\w\\Space', null) }])
  expect(groups.map((g) => g.key)).toEqual(['c:/w/acme'])
  expect(groups[0].folder).toBeUndefined()
})
it('a folder group has no coordinator chip, takes its parent in its label beside a project of its name, and moves like a project group', () => {
  const groups = panelGroups([tab('A', place('C:/w/acme')), out('F', 'D:\\games\\acme'), tab('B', blog)])
  expect(groupChip(groups[1], true, () => null)).toBeNull()
  expect(groupLabels(groups).get('folder:d:/games/acme')).toBe('acme (games)')
  expect(groupLabels(groups).get('c:/w/acme')).toBe('acme (w)')
  expect(moveGroup(groups, 'folder:d:/games/acme', 'c:/w/acme')).toEqual(['F', 'A', 'B'])
})
it('a paired device keeps the folder flag on its folder groups', () => {
  const [g] = deviceGroups('dev1', [out('S', 'D:\\w\\Space')])
  expect(g.folder).toBe(true)
  expect(g.project?.name).toBe('Space')
})
```

Add `folderGroupOf` to the import list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/tab-groups.test.ts`
Expected: FAIL (`folderGroupOf` is not exported; the new assertions fail).

- [ ] **Step 3: Implement** in `src/renderer/tab-groups.ts`:
  - `folderGroupOf`: a path is Windows-style when it starts with a drive letter (`/^[a-zA-Z]:/`) or holds a `\`. Make separators `/`, drop trailing separators, lower-case a Windows-style path; the result, prefixed with `FOLDER_KEY_PREFIX`, is the key. Null when nothing is left after the drive or the root, when it equals `home` normalised the same way, or when it matches the usual home folders (case-insensitively for `X:/users/<name>`). `name` and `parent` are the last two segments of the original path, in their own case.
  - `panelGroups`: key = `tab.place?.project.key ?? tab.outside?.key ?? NO_PROJECT`; a group's `project` is its first tab's `place?.project ?? outside ?? null`, and `folder: true` is set when that first tab has no place and has `outside`. No project stays last.
  - `groupChip`: null for a group with `folder`.
  - Update the doc comment on `NO_PROJECT` ("tabs that are not in a git repository" → the tabs with neither a project nor a folder group) and on `panelGroups`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/tab-groups.test.ts tests/unit/tab-panel-devices.test.ts` then `npm run typecheck`
Expected: all pass, typecheck clean.

---

### Task 2: The window groups tabs outside git by folder

**Files:**
- Modify: `src/renderer/tabbar.ts` (`TabBarItem`), `src/renderer/main.ts` (`tabBarItem`)
- Test: `tests/e2e/tab-panel.spec.ts`

**Interfaces:**
- Consumes: `folderGroupOf(folder: string, home: string | null): FolderGroup | null` and `GroupInput.outside` from Task 1.
- Produces: `TabBarItem.outside: FolderGroup | null`.

- [ ] **Step 1: Write the failing e2e test** in `tests/e2e/tab-panel.spec.ts`, titled `a tab in a folder outside git is grouped by its folder, with no + Coordinator; a tab in a repository keeps its project's group, and one in the home folder stays in No project`. Launch with `launchApp({ settings: left(freshFolder()) })`; make `space = join(freshFolder(), 'SpaceGame')` (`mkdirSync`) and `repo = gitRepo('acme')`; open a shell and a Claude tab in `space`, a shell in `repo` and a shell in `homedir()` (`node:os`) with the file's `openTab`. Then:

```ts
await expect(groupNamed(page, 'SpaceGame').locator('.tp-tab')).toHaveCount(2)
await expect(groupNamed(page, 'SpaceGame').locator(`[data-tab-id="${shellInSpace}"]`)).toHaveCount(1)
await expect(groupNamed(page, 'SpaceGame').locator(`[data-tab-id="${claudeInSpace}"]`)).toHaveCount(1)
await expect(groupNamed(page, 'SpaceGame').locator('.tp-coord-chip')).toHaveCount(0)
await expect(groupNamed(page, 'SpaceGame').locator('.tp-branch span')).toHaveCount(0)
await expect(groupNamed(page, 'acme').locator(`[data-tab-id="${inRepo}"]`)).toHaveCount(1)
await expect(groupNamed(page, 'No project').locator(`[data-tab-id="${atHome}"]`)).toHaveCount(1)
```

- [ ] **Step 2: Build and run it to verify it fails**

Run: `npm run build` then `node scripts/e2e.mjs tab-panel.spec.ts -g "grouped by its folder"`
Expected: FAIL — there is no `SpaceGame` group; both tabs are in No project.

- [ ] **Step 3: Implement**
  - `TabBarItem` in `src/renderer/tabbar.ts`: `outside: FolderGroup | null`, with a doc comment (the folder group of a tab git confirmed outside any repository).
  - `tabBarItem` in `src/renderer/main.ts`: `outside: places.has(id) && places.get(id) === null ? folderGroupOf(t.info.folder, remote ? null : appInfo.homeDir) : null` — a paired device's home is not known here, so only the usual home folders are recognised for its tabs.

- [ ] **Step 4: Build and run the test to verify it passes**

Run: `npm run typecheck`, `npm run build`, then `node scripts/e2e.mjs tab-panel.spec.ts -g "grouped by its folder"`
Expected: PASS.

---

### Task 3: The e2e tests that took a temp folder for No project

**Files:**
- Modify, where a test fails because of folder groups: `tests/e2e/tab-panel.spec.ts`, `tests/e2e/coordinator-chip.spec.ts`, `tests/e2e/remote-tabs.spec.ts`, `tests/e2e/activity.spec.ts`, `tests/e2e/tabs.spec.ts`, `tests/e2e/project-notes-card.spec.ts`, `tests/e2e/forks.spec.ts`, `tests/e2e/coordinator-drag.spec.ts`

**Interfaces:**
- Consumes: the behavior of Tasks 1–2: a tab in a temp folder outside git now sits in a group named after that folder (`basename(folder)`); the home folder still gives No project.

- [ ] **Step 1: Run the candidate specs on the build of Task 2**

Run: `node scripts/e2e.mjs tab-panel.spec.ts coordinator-chip.spec.ts remote-tabs.spec.ts activity.spec.ts tabs.spec.ts project-notes-card.spec.ts forks.spec.ts coordinator-drag.spec.ts`
Expected: some failures; note each failing test and its first error.

- [ ] **Step 2: Adapt each test that failed because its tabs left No project**, keeping what the test is about:
  - a test about No project itself (its name, its place last, its missing chip, its fold) keeps a tab there by opening it in `homedir()`, or asserts the same of the folder group where the test is about a group without a project (e.g. `coordinator-chip.spec.ts` line 34: the plain tab's group `basename(<its folder>)` has no chip — a folder group has none either);
  - a test that needs its tabs in one group (drags within a group, tab bar labels shown only for several groups) opens them in one shared folder;
  - `remote-tabs.spec.ts` "B's own groups come first…" expects the folder names where it expected `No project` for the devices' first tabs outside git (those tabs open in each device's `work` folder): this is the e2e proof that a paired device's tab outside git is grouped by its folder.
  - A failure with no link to groups is reported, not changed (the suite has known flaky tests).

- [ ] **Step 3: Run the specs again**

Run: the Step 1 command.
Expected: every test that failed because of folder groups passes; report any remaining failure with its error.

- [ ] **Step 4: Run the unit and integration tests and the typecheck**

Run: `npm run typecheck` and `npm test`
Expected: clean typecheck; `npm test` passes (a failure in an engine, agent-chat or account-cli integration test that also fails alone on clean master is known and is reported, not fixed).
