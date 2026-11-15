# Coordinator Chip on the Project Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chip on each of this device's project group headers in the left tab panel: `● Coordinator` brings the project's coordinator to the front; `+ Coordinator` opens a new Claude tab in the project's main folder, which main makes the project's coordinator as soon as the tab has a session and a project.

**Architecture:** Main keeps a "to be made coordinator" entry per project in `CoordinatorHub` (`startCoordinator`). The hub resolves it when the new tab has both a session (`tabSession` / `sessionStarted`) and a project (the new `placeChanged`, called from `TabPlaces`' publish), by calling `make(tabId, false)`. The IPC answer waits for that, so the renderer can show a refusal as a toast. The renderer works out each group's chip with a pure `groupChip()` in `tab-groups.ts` and draws it in `TabPanel.renderGroup`. The chip never toggles the fold and never starts a group drag.

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), plain-DOM renderer, Vitest (unit, integration), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-15-coordinator-chip-design.md`. The approved mockup is `D:/ct-scratch/coord-indicator-mockup/chip-b2.png`. Variant B, outside the repository. The coordinator's own design is `docs/superpowers/specs/2026-11-14-project-coordinator-design.md`.

## Global Constraints

- The rules in `AGENTS.md` apply: every behaviour is tested through its entry point, tests use temp folders only, main checks every IPC argument with `ipc-guards.ts`, paths are compared with `pathKey`, git runs only through `execGit`, the main process does not block, all copy is English.
- The files are CRLF in this checkout. Keep each file's line endings. A new file takes its neighbours' line endings.
- `feat/coordinator-delegate` is merged into this branch before these tasks run. It adds `turnNote` to the hub, changes the `turn` wiring in `src/main/index.ts` and adds `COORD_DELEGATE` to `src/shared/coordinator.ts`. Places are named by function, not by line. Leave that branch's code as it is.
- **Do not commit.** The user's standing rule overrides the skill's commit steps. Leave each task's work uncommitted and report the changed files with the suggested message.
- If the build, the e2e run or a file collides with another agent's work (a locked DLL or file, an app that is running, a shared file it edits), report the collision to your dispatcher. Never edit, revert or kill the other side's work.
- Chip copy, from the spec: the word is `Coordinator`. `● Coordinator` is drawn in the accent: accent text, an accent dot and a thin accent outline. `+ Coordinator` is muted text with a dashed outline. **No tooltip**: no `title` on the chip.
- Where the chip appears: on a project group's header in **this device's** part of the left panel, between the project's name and its tab count, and on a folded group too. It never appears on the "No project" group, on a paired device's groups, or in the tabs-at-top layout.
- A narrow panel, `@container tabpanel (width < 200px)` (the panel's existing narrow breakpoint): the chip keeps its dot or its `+` without the word. The project's name gives way first and ends in an ellipsis.
- A `●` click brings the coordinator's tab to the front. A `+` click opens a Claude tab the way **+ New tab** does: no `account` (the active Claude tab's account, else Main account), no `view` (the setting's view), no permission mode and no first message. The tab opens in the project's main worktree folder, or in the clicked group tab's folder for a bare repository. It stands first in its group and is the active tab.
- If the new tab closes or exits before it has a session, nothing is made and nothing is shown. If `make` refuses (another coordinator of the project, the limit of 50), the tab stays an ordinary tab and `make`'s error shows as a toast, through the same `toastFailure` the context menu uses.
- Anti-goals: a second click while the tab is starting brings that tab to the front and opens nothing. The chip never pulses or spins, and nothing is sent to the coordinator. A click on the chip never toggles the group's fold, and a press on the chip never starts a group drag.
- Not in scope: attaching sessions to the new coordinator, replacing a running coordinator from the chip, and a coordinator for a paired device's project.

## Review Focus

- **The session starts before git has given the new tab its project** (a fast SessionStart on a busy machine). The person expects the tab to become the coordinator, not a toast saying "Only a tab in a git project can coordinate." Pinned by the Task 1 hub test "…once it has a session and then its project…".
- **Two quick clicks while main is still asking git for the main folder.** The person expects one tab. Pinned by the Task 1 hub test "a second start while the folder is looked up opens nothing…".
- **A project group made only of shell tabs.** The person expects `+ Coordinator` to work the same way. Pinned by the Task 3 e2e test "a project of shell tabs only gets its coordinator the same way".
- **git prints the main folder with `/` on Windows, and with long names where the tab has 8.3 short ones.** The person expects the new tab to land in the same group, with a normal folder path. Pinned by the Task 1 integration test ("…in the platform's separators") and by Task 3's main-folder e2e (same project key, `worktree: null`).
- **A coordinator kept in coordinators.json whose tab is not open** (ClaudeTerm quit and the restore was not taken). The chip shows `+`. The person expects to learn why no coordinator can start, not to get a useless tab. Pinned by the Task 1 hub test "a coordinator kept for the project whose tab is not open…".

---

### Task 1: Main — the pending make, the main folder, the tab placed first, the IPC

**Files:**
- Modify: `src/main/tab-places.ts` (new export next to `folderPlace`)
- Modify: `src/main/tab-manager.ts` (`TabManager.open`)
- Modify: `src/main/coordinator/coordinator-hub.ts`
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`
- Modify: `src/main/index.ts`: the `places` publish callback, the `new CoordinatorHub({…})` deps, and the coordinator `ipcMain.handle` block
- Modify: `tests/fixtures/coordinator-world.ts`
- Test: `tests/integration/tab-places.int.test.ts`, `tests/unit/tab-manager.test.ts`, `tests/unit/coordinator-hub.test.ts`

**Interfaces:**
- Consumes: the existing `CoordinatorHub.make(tabId, replace): CoordResult`, `HUB_TEXT.taken`, `CoordinatorStore.coordinatorOf(projectKey)`, `execGit`, `GitRun`, `nativePath`, `isId` (ipc-guards) and `tabPlaces` (index.ts).
- Produces:
  - `export async function mainWorktreeFolder(run: GitRun, folder: string): Promise<string | null>` in `src/main/tab-places.ts`.
  - `TabManager.open(req, opts: { activate?: boolean; setupToken?: boolean; signIn?: SignInLaunch; before?: string })`.
  - `CoordinatorHubDeps` gains `mainFolder(folder: string): Promise<string | null>`, `openCoordinatorTab(cwd: string, projectKey: string): string | null` and `activate(tabId: string): void`.
  - `CoordinatorHub.startCoordinator(projectKey: string, folder: string): Promise<CoordResult | null>` and `CoordinatorHub.placeChanged(tabId: string): void`.
  - IPC: `IPC.coordStartCoordinator = 'coord:start-coordinator'`. Bridge: `window.ct.coordStartCoordinator(tabId: string): Promise<CoordResult | null>`. `tabId` is any tab of this device in the group, shell or Claude. `null` means there is nothing to tell. An argument that fails the check answers `{ ok: false, error: COORD_REFUSED }`.

- [ ] **Step 1: Write the failing integration tests for `mainWorktreeFolder`**

In `tests/integration/tab-places.int.test.ts`, import `mainWorktreeFolder` next to `folderPlace` and `normalize` from `node:path`. Append:

```ts
describe("the folder a project's new tab opens in", () => {
  /** the same folder however it is written: its real path as a pathKey */
  const same = (p: string): string => pathKey(realpathSync.native(p))

  it("is the main worktree, from the main worktree and from a subfolder of a linked worktree, in the platform's separators", async () => {
    const parent = tempParent()
    const dir = repo(join(parent, 'shop'))
    const linked = join(parent, 'shop-x')
    git(dir, 'worktree', 'add', '-q', '-b', 'feat/x', linked)
    mkdirSync(join(linked, 'src'), { recursive: true })
    const fromMain = await mainWorktreeFolder(execGit, dir)
    const fromLinked = await mainWorktreeFolder(execGit, join(linked, 'src'))
    expect(same(fromMain!)).toBe(same(dir))
    expect(same(fromLinked!)).toBe(same(dir))
    expect(fromLinked).toBe(normalize(fromLinked!))
  })

  it("is a submodule's own folder", async () => {
    const parent = tempParent()
    const lib = repo(join(parent, 'lib-src'))
    const app = repo(join(parent, 'app'))
    git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'sub')
    commitAll(app, 'add the submodule')
    expect(same((await mainWorktreeFolder(execGit, join(app, 'sub')))!)).toBe(same(join(app, 'sub')))
  })

  it('is null for a bare repository, a folder outside git and a folder that does not exist', async () => {
    // the bare repository with a worktree, set up as in 'gives a bare repository with a worktree the name of the repository'
    const parent = tempParent()
    const bare = join(parent, 'acme.git')
    git(parent, 'init', '-q', '--bare', bare)
    const seed = join(parent, 'seed')
    git(parent, 'clone', '-q', bare, seed)
    git(seed, 'config', 'user.email', 't@example.com')
    git(seed, 'config', 'user.name', 'T')
    git(seed, 'config', 'core.autocrlf', 'false')
    git(seed, 'checkout', '-q', '-b', 'main')
    writeFileSync(join(seed, 'README.md'), 'acme\n')
    commitAll(seed, 'one')
    git(seed, 'push', '-q', 'origin', 'main')
    const folder = join(parent, 'acme-main')
    git(bare, 'worktree', 'add', '-q', folder, 'main')
    expect(await mainWorktreeFolder(execGit, folder)).toBeNull()
    expect(await mainWorktreeFolder(execGit, mkdtempSync(join(tmpdir(), 'ct-nogit-')))).toBeNull()
    expect(await mainWorktreeFolder(execGit, join(tempParent(), 'missing'))).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/integration/tab-places.int.test.ts`
Expected: FAIL. `mainWorktreeFolder` is not exported.

- [ ] **Step 3: Implement `mainWorktreeFolder(run: GitRun, folder: string): Promise<string | null>` in `src/main/tab-places.ts`**

Make the same calls as `folderPlace`, in order:
1. The `access(folder)` check. A missing folder gives `null`.
2. `rev-parse --show-toplevel --show-superproject-working-tree`. If line 2 is set (a submodule), answer the top folder.
3. Otherwise `worktree list --porcelain`. Take the first entry, `parseWorktreeList(...)[0]`. A bare entry, a missing entry or a non-zero exit gives `null`.

Pass every path you answer through `nativePath.normalize`. Catch `GitError` and answer `null`, as `folderPlace` does. Doc comment: "the folder a new tab of `folder`'s project opens in: the main worktree's folder (a submodule's own); null for a bare repository, a folder outside git or gone, or when git cannot tell".

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/integration/tab-places.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing TabManager tests**

In `tests/unit/tab-manager.test.ts`, inside the `describe` that holds the fork-order tests ("a fork stands right after its family…"), add:

```ts
  it('a tab opened before another stands right before it, and the window hears the order before the tab starts', () => {
    let heard: string[] = []
    const { tm, log } = setup({ onTabStarted: () => { heard = log.filter((l) => l.startsWith('order:')) } })
    const A = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    const B = tm.open({ kind: 'shell', cwd: 'D:\\y' })
    const N = tm.open({ kind: 'shell', cwd: 'D:\\x' }, { before: B.id })
    expect(tm.list().map((t) => t.id)).toEqual([A.id, N.id, B.id])
    expect(heard).toEqual([`order:${A.id},${N.id},${B.id}`])
    expect(tm.activeTabId()).toBe(N.id)
  })

  it('a tab opened before a tab that is not open goes to the end, and no order is announced', () => {
    const { tm, log } = setup()
    const A = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    const N = tm.open({ kind: 'shell', cwd: 'D:\\x' }, { before: 'gone' })
    expect(tm.list().map((t) => t.id)).toEqual([A.id, N.id])
    expect(log.filter((l) => l.startsWith('order:'))).toEqual([])
  })
```

Run: `npx vitest run tests/unit/tab-manager.test.ts`
Expected: FAIL. TypeScript rejects `before`, or the order is `[A, B, N]`.

- [ ] **Step 6: Implement `before` in `TabManager.open`**

Add `before?: string` to `open`'s `opts` type. Comment: "the new tab stands right before this tab of the order; one that is not open is ignored". A tab that is not a fork and whose `before` is in `this.order` is spliced in at that index. Otherwise it is pushed, as today. Announce `this.deps.events.order([...this.order])` right after `events.opened`, as a fork does, and so before `onTabStarted`. The window must hear the order before the tab's place can arrive, or its write-back of the panel order would put the tab last.

Run: `npx vitest run tests/unit/tab-manager.test.ts`
Expected: PASS.

- [ ] **Step 7: Give the hub's test world the three new deps**

In `tests/fixtures/coordinator-world.ts`, add these fields to `w`:

```ts
    /** what the hub's mainFolder answers: the project's main folder, or null (a bare repository); mainFolderThrows: the lookup fails */
    mainFolder: 'D:\\Work\\acme' as string | null,
    mainFolderThrows: false,
    /** the hub's openCoordinatorTab calls, in order: each opens `chip-tab-<n>` in w.tabs, with no session and no project yet, unless openFails */
    openedCoordinators: [] as { cwd: string; projectKey: string }[],
    openFails: false,
    /** the tabs the hub brought to the front, in order */
    activated: [] as string[],
```

Add these to the `new CoordinatorHub({…})` deps:

```ts
    mainFolder: async () => {
      if (w.mainFolderThrows) throw new Error('git failed')
      return w.mainFolder
    },
    openCoordinatorTab: (cwd, projectKey) => {
      w.openedCoordinators.push({ cwd, projectKey })
      if (w.openFails) return null
      const id = `chip-tab-${w.openedCoordinators.length}`
      w.tabs.push(tab(id, null, null, { folder: cwd }))
      return id
    },
    activate: (tabId) => {
      w.activated.push(tabId)
    },
```

- [ ] **Step 8: Write the failing hub tests**

Append to the end of `tests/unit/coordinator-hub.test.ts`. It uses the module's `update`, `tick`, `refOf`, `uid`, `NOW`, `MAX_COORDINATORS`, `HUB_TEXT` and `type World`.

```ts
describe("the chip's coordinator start", () => {
  const S_CHIP = 'd5000000-0000-4000-8000-000000000006'
  /** the folder of the group's tab the chip names: a linked worktree of acme */
  const WT = 'D:\\Work\\acme-wt'
  /** whether a promise has settled by the next turn of the event loop */
  const settledNow = async (p: Promise<unknown>): Promise<boolean> => {
    let done = false
    void p.then(() => { done = true })
    await tick()
    return done
  }

  it("opens a Claude tab in the project's main folder and makes it the coordinator once it has a session and then its project; nothing is sent to it", async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, WT)
    await tick()
    expect(w.openedCoordinators).toEqual([{ cwd: 'D:\\Work\\acme', projectKey: ACME.key }])
    update(w, 'chip-tab-1', { session: S_CHIP })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    expect(await settledNow(answer)).toBe(false)
    expect(w.store.coordinators()).toEqual([])
    update(w, 'chip-tab-1', { project: ACME })
    w.hub.placeChanged('chip-tab-1')
    expect(await answer).toEqual({ ok: true, info: 'This tab is now the coordinator of acme.' })
    expect(w.hub.isCoordinator('chip-tab-1')).toBe(true)
    expect(w.store.coordinator(S_CHIP)).toMatchObject({ project: ACME, attachments: [] })
    expect(w.mail.all()).toEqual([])
    expect(w.pokes).toEqual([])
  })

  it('with its project known first, the session that SessionStart reports makes it', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, WT)
    await tick()
    update(w, 'chip-tab-1', { project: ACME })
    w.hub.placeChanged('chip-tab-1')
    expect(await settledNow(answer)).toBe(false)
    update(w, 'chip-tab-1', { session: S_CHIP })
    w.hub.sessionStarted('chip-tab-1', null, S_CHIP, 'startup')
    expect(await answer).toEqual({ ok: true, info: 'This tab is now the coordinator of acme.' })
  })

  it("a bare repository, or a lookup that fails, opens the tab in the folder of the group's tab", async () => {
    const bare = world()
    bare.mainFolder = null
    void bare.hub.startCoordinator(ACME.key, WT)
    const failed = world()
    failed.mainFolderThrows = true
    void failed.hub.startCoordinator(ACME.key, WT)
    await tick()
    expect(bare.openedCoordinators).toEqual([{ cwd: WT, projectKey: ACME.key }])
    expect(failed.openedCoordinators).toEqual([{ cwd: WT, projectKey: ACME.key }])
  })

  it('a second start while the folder is looked up opens nothing; one while the tab waits for its session brings that tab to the front and opens nothing', async () => {
    const w = world()
    void w.hub.startCoordinator(ACME.key, WT)
    expect(await w.hub.startCoordinator(ACME.key, WT)).toBeNull()
    expect(w.activated).toEqual([])
    await tick()
    expect(await w.hub.startCoordinator(ACME.key, WT)).toBeNull()
    expect(w.activated).toEqual(['chip-tab-1'])
    expect(w.openedCoordinators).toHaveLength(1)
  })

  it('a project with a coordinator brings its tab to the front and opens nothing', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    expect(await w.hub.startCoordinator(ACME.key, WT)).toBeNull()
    expect(w.activated).toEqual(['tab-c'])
    expect(w.openedCoordinators).toEqual([])
  })

  it('a coordinator kept for the project whose tab is not open is named in a refusal, and nothing opens', async () => {
    const w = world()
    w.hub.make('tab-c', false)
    w.tabs = w.tabs.filter((t) => t.tabId !== 'tab-c')
    expect(await w.hub.startCoordinator(ACME.key, WT)).toEqual({ ok: false, error: HUB_TEXT.taken('acme', `session ${refOf(S.coord)}`) })
    expect(w.openedCoordinators).toEqual([])
    expect(w.activated).toEqual([])
  })

  it('the tab closed before its session started: nothing is made, the answer is null, and the next start opens a tab again', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, WT)
    await tick()
    w.tabs = w.tabs.filter((t) => t.tabId !== 'chip-tab-1')
    w.hub.tabClosed('chip-tab-1')
    expect(await answer).toBeNull()
    expect(w.store.coordinators()).toEqual([])
    void w.hub.startCoordinator(ACME.key, WT)
    await tick()
    expect(w.openedCoordinators).toHaveLength(2)
  })

  it('the tab exited before its session started: nothing is made, also when a session comes later', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, WT)
    await tick()
    update(w, 'chip-tab-1', { exited: true })
    w.hub.exited('chip-tab-1')
    expect(await answer).toBeNull()
    update(w, 'chip-tab-1', { session: S_CHIP, project: ACME })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    w.hub.placeChanged('chip-tab-1')
    expect(w.store.coordinators()).toEqual([])
  })

  it('a coordinator of the project made meanwhile: the tab stays an ordinary tab, and the answer is the refusal', async () => {
    const w = world()
    const answer = w.hub.startCoordinator(ACME.key, WT)
    await tick()
    w.hub.make('tab-c', false)
    update(w, 'chip-tab-1', { session: S_CHIP, project: ACME })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    expect(await answer).toEqual({ ok: false, error: 'The acme project already has a coordinator: coord · Desktop.', replaces: 'coord · Desktop' })
    expect(w.hub.isCoordinator('chip-tab-1')).toBe(false)
  })

  it('the coordinator limit refuses it the same way', async () => {
    const w = world()
    for (let i = 0; i < MAX_COORDINATORS; i++) {
      w.store.putCoordinator({ session: uid(0x20000 + i), project: { key: `/p/${i}`, name: `p${i}` }, since: NOW, attachments: [], former: [] })
    }
    const answer = w.hub.startCoordinator(ACME.key, WT)
    await tick()
    update(w, 'chip-tab-1', { session: S_CHIP, project: ACME })
    w.hub.tabSession('chip-tab-1', S_CHIP)
    expect(await answer).toEqual({ ok: false, error: HUB_TEXT.fullCoordinators })
  })

  it('a tab that does not open answers null, and the next start tries again', async () => {
    const w = world()
    w.openFails = true
    expect(await w.hub.startCoordinator(ACME.key, WT)).toBeNull()
    w.openFails = false
    void w.hub.startCoordinator(ACME.key, WT)
    await tick()
    expect(w.openedCoordinators).toHaveLength(2)
    expect(w.tabs.map((t) => t.tabId)).toContain('chip-tab-2')
  })
})
```

Run: `npx vitest run tests/unit/coordinator-hub.test.ts`
Expected: FAIL. `startCoordinator` and `placeChanged` do not exist, and `CoordinatorHubDeps` has no `mainFolder`.

- [ ] **Step 9: Implement the pending make in `src/main/coordinator/coordinator-hub.ts`**

- Add the three deps to `CoordinatorHubDeps`, after `openRemoteTab`, each with a one-line comment as its neighbours have: `mainFolder(folder: string): Promise<string | null>`, `openCoordinatorTab(cwd: string, projectKey: string): string | null` and `activate(tabId: string): void`.
- Next to `PendingStart`, add `interface PendingMake { tabId: string | null; answer: ((r: CoordResult | null) => void) | null }`. `tabId` is null while the main folder is being looked up. `answer` is null until the promise exists.
- Add the field `private readonly makes = new Map<string, PendingMake>()`, keyed by project key. Comment: "the chip's coordinator starts, by project key: a tab that becomes the project's coordinator once it has a session and a project".
- Add `async startCoordinator(projectKey: string, folder: string): Promise<CoordResult | null>`. Its doc comment says what the Interfaces block says. The order matters:
  1. `const c = this.d.store.coordinatorOf(projectKey)`. If it exists and `this.tabOfSession(c.session)` finds its tab, call `d.activate` on that tab and return `null`. If it exists without a tab, return `fail(HUB_TEXT.taken(c.project.name, this.nameOf(c.session)))`.
  2. If `this.makes.get(projectKey)` exists, call `d.activate(entry.tabId)` when its `tabId` is not null, and return `null`.
  3. Put the `PendingMake` `{ tabId: null, answer: null }` into `makes` **before** the first `await`.
  4. `const cwd = (await this.d.mainFolder(folder).catch(() => null)) ?? folder`.
  5. `const tabId = this.d.openCoordinatorTab(cwd, projectKey)`. If it is `null`, delete the entry and return `null` (main has already shown "Cannot open tab: …").
  6. Set `entry.tabId = tabId`. Return a `new Promise` whose executor sets `entry.answer` and then calls `this.settleMake(tabId)`.
- Add `placeChanged(tabId: string): void`, which calls `this.settleMake(tabId)`.
- Add `private settleMake(tabId: string): void`. Find the entry whose `tabId` matches, and the tab in `this.d.tabs()`. No entry, or no tab: return (a closed tab is ended by `tabClosed`). `tab.exited`: `this.endMake(tabId)`. `session === null` or `project === null`: return and wait. Otherwise delete the entry **first**, then call `entry.answer?.(this.make(tabId, false))`.
- Add `private endMake(tabId: string): void`, which deletes the entry of that tab, if there is one, and answers it `null`.
- Hooks: in `tabSession`, after its `startArrived` call, add `if (session !== null) this.settleMake(tabId)`. In `sessionStarted`, call `this.settleMake(tabId)` right after its `startArrived(tabId, after)`. In `exited` and in `tabClosed`, call `this.endMake(tabId)`. In `dispose`, call `this.makes.clear()`.

Run: `npx vitest run tests/unit/coordinator-hub.test.ts`
Expected: PASS, the existing tests included.

- [ ] **Step 10: The IPC channel, the bridge and the wiring in `src/main/index.ts`**

- `src/shared/ipc.ts`: add `coordStartCoordinator: 'coord:start-coordinator'` after `coordNewSession`. Add `coordStartCoordinator(tabId: string): Promise<CoordResult | null>` to the API after `coordNewSession(...)`. Its doc comment: "+ Coordinator on a project group's header: tabId is a tab of this device in the group. A Claude tab opens in the project's main folder and becomes its coordinator once its session starts, and the answer waits for that. Null: nothing to tell (the project's coordinator or its starting tab was brought to the front, or the new tab closed, exited or did not open)".
- `src/preload/index.ts`: add `coordStartCoordinator: (tabId) => ipcRenderer.invoke(IPC.coordStartCoordinator, tabId),` after `coordNewSession`.
- `src/main/index.ts`:
  - Import `mainWorktreeFolder` with `TabPlaces`.
  - In the `places = new TabPlaces({ publish })` callback, after `tabPlaces.set(id, place)` and before `coordSoon.request()`, call `projectCoordinators.placeChanged(id)`. Comment: "a tab the chip opened becomes the coordinator once it has its project too".
  - In `new CoordinatorHub({…})`, after `openRemoteTab`, add these three deps:
    - `mainFolder: (folder) => mainWorktreeFolder(execGit, folder)`
    - `activate: (id) => tabs.activate(id)`
    - `openCoordinatorTab: (cwd, projectKey)`. It opens like `openTab` does: `try { return tabs.open({ kind: 'claude', cwd }, { before }).id } catch (e) { toast(`Cannot open tab: ${(e as Error).message}`); return null }`. Here `before = tabs.list().find((t) => tabPlaces.get(t.id)?.project.key === projectKey)?.id`, the project's first tab in the order. Leave out `account` and `view`, so the tab opens as **+ New tab** opens one, and in front.
  - After the `IPC.coordNewSession` handler, add the handler below. `isId` is the ipc-guards check. A tab that is not this device's, or has no project, is refused.

```ts
  // the chip's + Coordinator: a tab of this device in a git project names the project; its folder is where a bare repository's coordinator opens
  ipcMain.handle(IPC.coordStartCoordinator, (_e, tabId: unknown): Promise<CoordResult | null> => {
    const tab = isId(tabId) ? tabs.get(tabId) : null
    const place = tab ? (tabPlaces.get(tab.id) ?? null) : null
    return tab && place ? projectCoordinators.startCoordinator(place.project.key, tab.folder) : Promise.resolve(coordRefused)
  })
```

Task 3's e2e exercises this wiring through the window: the refusals, the main folder, the placement and the session.

- [ ] **Step 11: Verify**

Run: `npm run typecheck` and then `npm test`.
Expected: both pass.

- [ ] **Step 12: Leave the work uncommitted**

Report the changed files. Suggested message: `feat: main starts a project's coordinator from a new tab once its session starts`.

---

### Task 2: Renderer — the chip on the project header

**Files:**
- Modify: `src/renderer/tab-groups.ts`
- Modify: `src/renderer/tabbar.ts` (`TabBarCallbacks`)
- Modify: `src/renderer/tab-panel.ts` (`renderGroup`, a new private method)
- Modify: `src/renderer/main.ts` (`tabCallbacks`)
- Modify: `src/renderer/styles.css`
- Modify (test locators only): `tests/e2e/tab-panel.spec.ts`, `tests/e2e/activity.spec.ts`
- Test: `tests/unit/tab-groups.test.ts`

**Interfaces:**
- Consumes: `window.ct.coordStartCoordinator(tabId: string): Promise<CoordResult | null>` from Task 1, and `toastFailure(r: CoordResult)` in `main.ts` (the menu's refusal path, `showToast(r.error)`).
- Produces:
  - `export type GroupChip = { kind: 'running'; tabId: string } | { kind: 'start'; tabId: string }` and `export function groupChip(group: PanelGroup, own: boolean, coordOf: (id: string) => CoordMark | null): GroupChip | null` in `tab-groups.ts`.
  - `TabBarCallbacks.startCoordinator(tabId: string): void`.
  - DOM, used by Task 3: inside `.tp-group-head`, right after `.tp-group-name`, a `<button type="button" class="tp-coord-chip running|start">` that holds `<span class="tp-coord-chip-mark">` (the dot for `running`, `icon('plus', 10)` for `start`) and `<span class="tp-coord-chip-word">Coordinator</span>`. The button has no `title`.

- [ ] **Step 1: Write the failing unit tests for `groupChip`**

In `tests/unit/tab-groups.test.ts`, add `deviceGroups` and `groupChip` to the import from `tab-groups`. Append:

```ts
describe("the coordinator chip on a group's header", () => {
  const C: CoordMark = { role: 'coordinator', project: 'acme', sessions: 0, waiting: 0 }
  const to = (coordinatorTabId: string): CoordMark => ({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId })
  const marks = (m: Record<string, CoordMark>) => (id: string): CoordMark | null => m[id] ?? null

  it("a group of this device with a coordinator shows it running, with the coordinator's tab", () => {
    const [g] = panelGroups([tab('A', acme), tab('C', acme)])
    expect(groupChip(g, true, marks({ C }))).toEqual({ kind: 'running', tabId: 'C' })
  })
  it('a group of this device without one offers a start from its first row; an attached row is no coordinator', () => {
    const [g] = panelGroups([tab('A', acme), tab('B', acme)])
    expect(groupChip(g, true, marks({ A: to('Z') }))).toEqual({ kind: 'start', tabId: 'A' })
  })
  it("a pulled row (a paired device's session) is never the tab a start is asked from", () => {
    const g: PanelGroup = { key: acme.project.key, project: acme.project, rows: [{ id: 'R', fork: false, block: 'X', attached: true, pulled: true }, { id: 'A', fork: false }] }
    expect(groupChip(g, true, marks({}))).toEqual({ kind: 'start', tabId: 'A' })
  })
  it("No project and a paired device's groups have no chip, a coordinator there included", () => {
    const [none] = panelGroups([tab('N', null)])
    expect(groupChip(none, true, marks({}))).toBeNull()
    const [remote] = deviceGroups('dev-a', [tab('C', acme)])
    expect(groupChip(remote, false, marks({ C }))).toBeNull()
  })
})
```

Run: `npx vitest run tests/unit/tab-groups.test.ts`
Expected: FAIL. `groupChip` is not exported.

- [ ] **Step 2: Implement `groupChip` in `src/renderer/tab-groups.ts`**

The rule, which also goes in its doc comment:
- `null` when `!own` or `group.project === null`.
- Otherwise `running` with the first row that is not pulled and whose mark has `role: 'coordinator'`.
- Otherwise `start` with the first row that is not pulled.
- `null` when the group has no such row.

Put `GroupChip` above it.

Run: `npx vitest run tests/unit/tab-groups.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the callback, draw the chip, style it**

- `src/renderer/tabbar.ts`: add `startCoordinator(tabId: string): void` to `TabBarCallbacks`, after `attachTab`. Doc: "+ Coordinator on a project group's header in the left panel: a tab of this device in the group".
- `src/renderer/main.ts`: in `tabCallbacks`, next to `attachTab`, add `startCoordinator: (id) => void ct.coordStartCoordinator(id).then((r) => { if (r !== null) toastFailure(r) }),`.
- `src/renderer/tab-panel.ts`:
  - In `renderGroup`, compute `const chip = groupChip(group, section.device === null, (id) => byId.get(id)?.coord ?? null)`.
  - Change `head.append(chevron, name)` to `head.append(chevron, name, ...(chip ? [this.coordChip(chip)] : []))`. The spinner, the dot and the count still follow it.
  - Add `private coordChip(chip: GroupChip): HTMLButtonElement`, which builds the DOM in the Interfaces block. It has no `title`. Its `click` calls `e.stopPropagation()` (the header's click would toggle the fold), then `this.cb.activate(chip.tabId)` for `running` or `this.cb.startCoordinator(chip.tabId)` for `start`. Set `el.draggable = true` and give it its own `dragstart` that calls `e.preventDefault()` and `e.stopPropagation()`. The header is draggable, and only a draggable chip is the drag's source, so this cancels the group drag that a press on the chip would start.
  - Change the class comment's "Groups fold on a click on their header" to "…on their header (not on its coordinator chip)".
- `src/renderer/styles.css`: add after the `@keyframes tp-dot-pulse` line:

```css
/* the coordinator chip on a project's header, between its name and its count: ● Coordinator in the accent with a thin accent
   outline while the project has a coordinator here, + Coordinator muted and dashed while it has none. It never moves */
.tp-coord-chip { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 5px; box-sizing: border-box; height: 18px; padding: 0 7px; border-radius: 9px; background: none; font: inherit; font-size: 10.5px; line-height: 1; white-space: nowrap; cursor: pointer; }
.tp-coord-chip.running { border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); color: var(--accent); }
.tp-coord-chip.start { border: 1px dashed var(--line-3); color: var(--text-3); }
.tp-coord-chip.start:hover { border-color: var(--text-3); color: var(--text-2); }
.tp-coord-chip-mark { flex: none; display: inline-flex; align-items: center; justify-content: center; }
.tp-coord-chip.running .tp-coord-chip-mark { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
```

  Then add these lines inside the existing `@container tabpanel (width < 200px) { … }` block:

```css
  /* the coordinator chip keeps its dot or its +, as a circle; the project's name has given way before it */
  .tp-coord-chip-word { display: none; }
  .tp-coord-chip { width: 18px; padding: 0; }
```

- [ ] **Step 4: Keep the existing header clicks on the header, off the chip**

The centre of a project group's header can now land on the chip. In these tests, change each `<group>.locator('.tp-group-head').click()` on a **project** group to `<group>.locator('.tp-group-name').click()`. Leave the `noProject` clicks alone, since No project has no chip.
- `tests/e2e/tab-panel.spec.ts`: 'a folded group shows its count and a dot, and stays folded after a restart' (the `groupA` click and the `groupB` click), 'a tab in a folded group unfolds its group when it becomes the active tab', 'with tabs on the left, a new tab unfolds its project group and leaves No project folded' (the `groupA` click only), and 'switching the tabs to the left unfolds the group of the active tab'.
- In 'a group is dragged by its header', drag from the name: `groupB.locator('.tp-group-name').dragTo(groupA.locator('.tp-group-head'))`.
- `tests/e2e/activity.spec.ts`: in 'a folded group spins while Claude works in one of its tabs…', change `group.locator('.tp-group-head').click()` to `group.locator('.tp-group-name').click()`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck`, then `npx vitest run tests/unit/tab-groups.test.ts`, then `npm run build`, then `node scripts/e2e.mjs tab-panel activity coordinator-tabs coordinator-drag coordinator-menu`.
Expected: all pass. A known flake: a fold test in `tab-panel.spec.ts` fails about 15% of the time on Windows, before any change too. Rerun that one test alone before blaming the change.

- [ ] **Step 6: Leave the work uncommitted**

Report the changed files. Suggested message: `feat: the coordinator chip on a project's header in the left panel`.

---

### Task 3: End to end — `tests/e2e/coordinator-chip.spec.ts`, and the release notes

**Files:**
- Create: `tests/e2e/coordinator-chip.spec.ts`
- Modify: `CHANGELOG.md` (the 0.22.0 section), `README.md` (the coordinator section)

**Interfaces:**
- Consumes:
  - DOM from Task 2: `.tp-coord-chip.running|.start`, `.tp-coord-chip-mark`, `.tp-coord-chip-word`.
  - `window.ct.coordStartCoordinator` from Task 1.
  - From `coordinator-helpers`: `coordApp(count, { settings, repo })`, `claudeTabIn(l, cwd)`, `makeCoordinator(page, tabId)`, `coordDevices({ a: { settings } })`.
  - From `coordinator-window`: `LEFT`, `marksOf`, `panelRows`, `tabOrder`, `dragOnto`.
  - From `agent-mail`: `startSession(pipeName, tabId, sid)`.
  - From `device-pair`: `closePaired`, `SLOW`.
  - From `helpers`: `gitRepo(name?)`, `gitWorktree(repo, branch)`, `openTabInFront(page, kind, cwd)`, `panelSettled(page)`.

- [ ] **Step 1: Write the spec**

```ts
import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { COORD_REFUSED } from '../../src/shared/coordinator'
import { startSession } from './agent-mail'
import { claudeTabIn, coordApp, coordDevices, makeCoordinator } from './coordinator-helpers'
import { dragOnto, LEFT, marksOf, panelRows, tabOrder } from './coordinator-window'
import { closePaired, SLOW } from './device-pair'
import { gitRepo, gitWorktree, openTabInFront, panelSettled } from './helpers'

// The coordinator chip on a project's header in the left panel (docs/superpowers/specs/2026-11-15-coordinator-chip-design.md)

const expect = baseExpect.configure({ timeout: 15_000 })

test.afterEach(closePaired)

/** this device's group of the project named `name` (a paired device's section is left out) */
const groupNamed = (page: Page, name: string): Locator =>
  page.locator('#tabpanel .tp-list > .tp-group').filter({ has: page.locator('.tp-group-name', { hasText: new RegExp(`^${name}$`) }) })
const chipOf = (page: Page, name: string): Locator => groupNamed(page, name).locator('.tp-coord-chip')
const activeTab = (page: Page): Promise<string | null> => page.evaluate(() => window.__ct!.activeTabId())
const placeOf = (page: Page, id: string) => page.evaluate((tabId) => window.__ct!.placeOf!(tabId) ?? null, id)
/** a refusal of the chip's start: every coordinator refusal names a coordinator */
const refusal = (page: Page): Locator => page.locator('.toast', { hasText: /coordinat/i })

/** the tab the window lists that was not in `before`: the tab a + Coordinator click opened */
async function openedSince(page: Page, before: string[]): Promise<string> {
  const added = await page.waitForFunction((old) => window.__ct!.tabIds().find((id) => !old.includes(id)) ?? false, before)
  return (await added.jsonValue()) as string
}

test('a project group shows + Coordinator between its name and its count, ● Coordinator once it has a coordinator, folded too; No project has none, the chip has no tooltip, and main refuses a tab outside a project', async () => {
  const l = await coordApp(1, { settings: LEFT })
  const { page, tabs: [t0], repo } = l
  try {
    const plain = await openTabInFront(page, 'shell', mkdtempSync(join(tmpdir(), 'ct-plain-')))
    const group = groupNamed(page, basename(repo))
    const chip = chipOf(page, basename(repo))
    await expect(chip).toHaveClass(/\bstart\b/)
    await expect(chip.locator('.tp-coord-chip-word')).toHaveText('Coordinator')
    await expect(chip.locator('.tp-coord-chip-mark')).toBeVisible()
    expect(await chip.getAttribute('title')).toBeNull()
    expect(await group.locator('.tp-group-head').evaluate((h) => ({
      before: h.querySelector('.tp-coord-chip')!.previousElementSibling!.className,
      last: h.lastElementChild!.className
    }))).toEqual({ before: 'tp-group-name', last: 'tp-group-count' })
    await expect(groupNamed(page, 'No project').locator('.tp-coord-chip')).toHaveCount(0)
    expect(await page.evaluate(() => window.ct.coordStartCoordinator('no-such-tab'))).toEqual({ ok: false, error: COORD_REFUSED })
    expect(await page.evaluate((id) => window.ct.coordStartCoordinator(id), plain)).toEqual({ ok: false, error: COORD_REFUSED })

    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect(chip).toHaveClass(/\brunning\b/)
    await expect(chip.locator('.tp-coord-chip-word')).toHaveText('Coordinator')
    await group.locator('.tp-group-name').click()
    await expect(group).toHaveClass(/\bfolded\b/)
    await expect(chip).toHaveClass(/\brunning\b/)
    // ● on a folded group: the coordinator's tab comes to the front, and the tab in front is never under a folded group
    await chip.click()
    await expect.poll(() => activeTab(page)).toBe(t0)
    await expect(group).not.toHaveClass(/\bfolded\b/)
  } finally {
    await l.app.close()
  }
})

test("● Coordinator brings the coordinator's tab to the front; a chip's click never folds its group, and a drag from a chip moves no group and opens no tab", async () => {
  const l = await coordApp(2, { settings: LEFT })
  const { page, tabs: [t0, t1], repo } = l
  try {
    const otherRepo = gitRepo()
    await claudeTabIn(l, otherRepo)
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    const group = groupNamed(page, basename(repo))
    await expect(chipOf(page, basename(repo))).toHaveClass(/\brunning\b/)
    await page.evaluate((id) => window.ct.activateTab(id), t1)
    await expect.poll(() => activeTab(page)).toBe(t1)

    // the tab that comes to the front would unfold a group the click had folded: an observer sees any fold on the way
    const key = (await group.getAttribute('data-group'))!
    await page.evaluate((k) => {
      const w = window as unknown as { sawFolded: boolean }
      w.sawFolded = false
      new MutationObserver(() => {
        if ([...document.querySelectorAll<HTMLElement>('#tabpanel .tp-group.folded')].some((g) => g.dataset.group === k)) w.sawFolded = true
      }).observe(document.getElementById('tabpanel')!, { subtree: true, childList: true, attributes: true })
    }, key)
    await chipOf(page, basename(repo)).click()
    await expect.poll(() => activeTab(page)).toBe(t0)
    await expect(group).not.toHaveClass(/\bfolded\b/)
    expect(await page.evaluate(() => (window as unknown as { sawFolded: boolean }).sawFolded)).toBe(false)
    await expect(group.locator('.tp-tab')).toHaveCount(2)

    await expect(chipOf(page, basename(otherRepo))).toHaveClass(/\bstart\b/)
    const order = await tabOrder(page)
    await dragOnto(page, chipOf(page, basename(otherRepo)), group.locator('.tp-group-head'))
    await page.waitForTimeout(500)
    expect(await tabOrder(page)).toEqual(order)
    expect(await page.locator('#tabpanel .tp-list > .tp-group .tp-group-name').allTextContents()).toEqual([basename(repo), basename(otherRepo)])
    await expect(groupNamed(page, basename(otherRepo))).not.toHaveClass(/\bfolded\b/)
  } finally {
    await l.app.close()
  }
})

test("+ Coordinator opens a Claude tab in the project's main folder, first in its group and in front, which becomes the coordinator once its session starts; a second click meanwhile brings that tab to the front and opens no other", async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/chip')
  const l = await coordApp(2, { settings: LEFT, repo: worktree })
  const { page, pipeName, tabs: [t0, t1] } = l
  const name = basename(repo)
  try {
    const chip = chipOf(page, name)
    await expect(chip).toHaveClass(/\bstart\b/)
    const before = await tabOrder(page)
    await chip.click()
    const tab = await openedSince(page, before)
    await expect.poll(() => activeTab(page)).toBe(tab)
    // the main worktree: the project of the group's tabs, not their linked worktree
    const project = (await placeOf(page, t0))!.project.key
    await expect.poll(async () => {
      const p = await placeOf(page, tab)
      return p ? { key: p.project.key, worktree: p.worktree } : null
    }).toEqual({ key: project, worktree: null })
    await expect.poll(() => tabOrder(page)).toEqual([tab, t0, t1])
    await expect.poll(async () => (await panelRows(page))[0]?.id).toBe(tab)
    await expect(groupNamed(page, name)).not.toHaveClass(/\bfolded\b/)
    expect((await marksOf(page))[tab]).toBeUndefined()
    await expect(chip).toHaveClass(/\bstart\b/)
    expect(await chip.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0)

    await page.evaluate((id) => window.ct.activateTab(id), t1)
    await expect.poll(() => activeTab(page)).toBe(t1)
    await chip.click()
    await expect.poll(() => activeTab(page)).toBe(tab)
    await page.waitForTimeout(500)
    expect(await tabOrder(page)).toHaveLength(3)

    expect(await startSession(pipeName, tab, randomUUID())).toEqual({ ok: true })
    await expect.poll(async () => (await marksOf(page))[tab]?.role).toBe('coordinator')
    await expect(chip).toHaveClass(/\brunning\b/)
    await expect.poll(async () => (await panelRows(page))[0]).toEqual({ id: tab, attached: false, label: 'Coordinator', to: null })
    expect(await chip.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0)
    await expect(refusal(page)).toHaveCount(0)
  } finally {
    await l.app.close()
  }
})

test('a tab closed before its session starts leaves no coordinator and no toast, and the next + Coordinator opens a new tab', async () => {
  const l = await coordApp(1, { settings: LEFT })
  const { page, pipeName, repo } = l
  try {
    const chip = chipOf(page, basename(repo))
    const before = await tabOrder(page)
    await chip.click()
    const first = await openedSince(page, before)
    await page.evaluate((id) => window.ct.closeTab(id), first)
    await expect.poll(() => tabOrder(page)).toEqual(before)
    await page.waitForTimeout(500)
    expect(Object.values(await marksOf(page)).filter((m) => m.role === 'coordinator')).toEqual([])
    await expect(chip).toHaveClass(/\bstart\b/)
    await expect(refusal(page)).toHaveCount(0)

    await chip.click()
    const second = await openedSince(page, before)
    expect(second).not.toBe(first)
    expect(await startSession(pipeName, second, randomUUID())).toEqual({ ok: true })
    await expect.poll(async () => (await marksOf(page))[second]?.role).toBe('coordinator')
  } finally {
    await l.app.close()
  }
})

test('a coordinator made meanwhile refuses the new tab: it stays an ordinary tab, and the refusal shows as a toast', async () => {
  const l = await coordApp(1, { settings: LEFT })
  const { page, pipeName, tabs: [t0], repo } = l
  try {
    const before = await tabOrder(page)
    await chipOf(page, basename(repo)).click()
    const tab = await openedSince(page, before)
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await startSession(pipeName, tab, randomUUID())).toEqual({ ok: true })
    await expect(page.locator('.toast', { hasText: `The ${basename(repo)} project already has a coordinator:` })).toBeVisible()
    const marks = await marksOf(page)
    expect(marks[tab]).toBeUndefined()
    expect(marks[t0]).toMatchObject({ role: 'coordinator' })
    expect(await tabOrder(page)).toContain(tab)
    await expect(chipOf(page, basename(repo))).toHaveClass(/\brunning\b/)
  } finally {
    await l.app.close()
  }
})

test('a project of shell tabs only gets its coordinator the same way', async () => {
  const l = await coordApp(1, { settings: LEFT })
  const { page, pipeName } = l
  try {
    const shellRepo = gitRepo()
    const shell = await openTabInFront(page, 'shell', shellRepo)
    const chip = chipOf(page, basename(shellRepo))
    await expect(chip).toHaveClass(/\bstart\b/)
    const before = await tabOrder(page)
    await chip.click()
    const tab = await openedSince(page, before)
    await expect.poll(async () => (await placeOf(page, tab))?.project.key).toBe((await placeOf(page, shell))!.project.key)
    expect(await startSession(pipeName, tab, randomUUID())).toEqual({ ok: true })
    await expect.poll(async () => (await marksOf(page))[tab]?.role).toBe('coordinator')
    await expect(chip).toHaveClass(/\brunning\b/)
  } finally {
    await l.app.close()
  }
})

test("a narrow panel: the chip keeps its dot or its + without the word, and the project's name gives way first", async () => {
  const repo = gitRepo('acme-dashboard-reports')
  const l = await coordApp(1, { settings: LEFT, repo })
  const { page, tabs: [t0] } = l
  try {
    const otherRepo = gitRepo()
    await claudeTabIn(l, otherRepo)
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    const running = chipOf(page, basename(repo))
    const start = chipOf(page, basename(otherRepo))
    await expect(running).toHaveClass(/\brunning\b/)
    const head = groupNamed(page, basename(repo)).locator('.tp-group-head')
    /** whether the name is cut, and whether the chip and the count lie whole inside the header */
    const fit = (): Promise<{ cut: boolean; chip: boolean; count: boolean }> => head.evaluate((h) => {
      const name = h.querySelector<HTMLElement>('.tp-group-name')!
      const box = h.getBoundingClientRect()
      const inside = (el: Element): boolean => { const b = el.getBoundingClientRect(); return b.left >= box.left && b.right <= box.right }
      return { cut: name.scrollWidth > name.clientWidth, chip: inside(h.querySelector('.tp-coord-chip')!), count: inside(h.querySelector('.tp-group-count')!) }
    })
    // as wide as it starts: the name is cut already, and both chips keep their word
    await expect(running.locator('.tp-coord-chip-word')).toBeVisible()
    await expect(start.locator('.tp-coord-chip-word')).toBeVisible()
    expect(await fit()).toEqual({ cut: true, chip: true, count: true })

    await panelSettled(page)
    const handle = (await page.locator('#tabpanel .tp-resize').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 1000, handle.y + handle.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => page.locator('#tabpanel').evaluate((el) => el.getBoundingClientRect().width)).toBe(110)
    for (const chip of [running, start]) {
      await expect(chip.locator('.tp-coord-chip-word')).toBeHidden()
      await expect(chip.locator('.tp-coord-chip-mark')).toBeVisible()
    }
    expect(await fit()).toEqual({ cut: true, chip: true, count: true })
  } finally {
    await l.app.close()
  }
})

test("with the tabs at the top there is no chip: the coordinator's tab keeps its mark", async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    await claudeTabIn(l, gitRepo())
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect(page.locator('#tabbar .tb-group-label')).toHaveCount(2)
    await expect(page.locator(`#tabbar .tab[data-tab-id="${t0}"] .tab-coord`)).toHaveText('Coordinator')
    await expect(page.locator('.tp-coord-chip')).toHaveCount(0)
  } finally {
    await l.app.close()
  }
})

test("a paired device's groups have no chip; this device's project has its own", async () => {
  test.setTimeout(180_000)
  const { a, coordTab } = await coordDevices({ a: { settings: LEFT } })
  const section = a.page.locator('#tabpanel .tp-section')
  await expect(section.locator('.tp-group')).not.toHaveCount(0, SLOW)
  await expect(a.page.locator('#tabpanel .tp-list > .tp-group .tp-coord-chip.running')).toHaveCount(1)
  await expect(section.locator('.tp-coord-chip')).toHaveCount(0)
  expect((await marksOf(a.page))[coordTab]).toMatchObject({ role: 'coordinator' })
})
```

- [ ] **Step 2: Run the spec**

Run: `npm run build` and then `node scripts/e2e.mjs coordinator-chip`.
Expected: 9 passed. A failure is a defect in Task 1 or Task 2. Report it with the failing assertion; do not loosen the test.

- [ ] **Step 3: Prove the anti-goal tests bite**

These tests were written after the code, so check that they fail without it. Make each change below, rebuild, run the test, see it FAIL, then restore the line exactly.

- (a) In `TabPanel.coordChip`'s click handler, remove `e.stopPropagation()`. Then `npm run build && node scripts/e2e.mjs coordinator-chip -g "never folds"`. Expected: FAIL on `sawFolded` (the header folds the group; the activation then unfolds it, so only the observer sees it).
- (b) In `TabPanel.coordChip`, remove the `dragstart` handler. Same command. Expected: FAIL (the group order changes).
- (c) In `CoordinatorHub.startCoordinator`, skip step 2 (the check for a start already under way). Then `node scripts/e2e.mjs coordinator-chip -g "second click"` after a build. Expected: FAIL (a fourth tab).

Restore all three, then run `git diff --stat` and check that only the intended files show changes.

- [ ] **Step 4: The release notes and the README**

Both files are CRLF. Keep that.
- `CHANGELOG.md`, `## 0.22.0` → `### New`, first bullet. Insert after the sentence that ends "…with your own tabs, on this computer or a paired one.":
  ` With the tabs on the left, each project's header shows whether it has one: **● Coordinator** brings it to the front, and **+ Coordinator** opens a new Claude tab in the project's folder that becomes its coordinator.`
- `README.md`, section `### 🧭 A coordinator for your project's sessions`, the paragraph that starts "**Make project coordinator** in a Claude tab's right-click menu…". Insert after "(one per project on a device; **Stop coordinating** ends it, and the sessions go on working).":
  ` With the tabs on the left, each project's header shows a **Coordinator** chip: **● Coordinator** takes you to the project's coordinator, and **+ Coordinator** opens a new Claude tab in the project's main folder and makes it the coordinator as soon as its session starts.`

- [ ] **Step 5: The whole check**

Run: `npm run typecheck`, then `npm test`, then `npm run test:e2e`. On a busy machine use `npm run build && node scripts/e2e.mjs --workers=1`.
Expected: all green. Known flakes, which fail on clean master too: `review.spec` and the git submodule tests under load, the `tab-panel.spec` fold race, and `account-add.spec` "checks the sign-ins". Rerun a failure alone, and on clean master, before blaming the change.

- [ ] **Step 6: Leave the work uncommitted**

Report the changed files. Suggested messages: `test: the coordinator chip end to end`, and `docs: the coordinator chip in the README and the 0.22.0 notes`.
