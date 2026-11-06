# Task List Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two tools in the bundled `claudeterm` MCP server (`set_task_list`, `get_task_list`) let Claude keep a task list that ClaudeTerm shows in the status-bar segment and task box a superpowers plan uses, kept with the conversation.

**Architecture:** The MCP tool validates the list and sends it over the pipe. Main keeps it per tab in a `TaskListHub` that follows the tab's conversation, as `NoteHub` does, and stores it by session id in `task-lists.json` (`TaskListStore`, like `SessionNotes`). Main picks what the status bar shows from the superpowers plan and the list (`shownPlan`) and sends it on the existing `evPlan` event, with a flag that lets the task box offer Clear.

**Tech Stack:** Electron 44, TypeScript (strict), zod + `@modelcontextprotocol/sdk` in `src/mcp`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-task-list-tool-design.md`

## Global Constraints

- AGENTS.md applies: tests never touch the real `~/.claude` or `%APPDATA%\ClaudeTerm`; no real personal data in tests (invented titles and ids only); comments, logs and UI strings in English; match the surrounding code (naming, comment density); keep each file's existing line endings.
- No git commits. Leave every change in the working tree; the controller commits once at the end.
- Everything from the pipe is untrusted: main validates again whatever the MCP side checked.
- Limits: at most 100 tasks (`MAX_LIST_TASKS`), a task title at most 200 characters (`MAX_TASK_TITLE`), the list title at most 100 (`MAX_TASK_LIST_TITLE`). Longer titles are cut; more tasks are refused with an error text. Titles have runs of whitespace (newlines included) folded to one space and are trimmed; an empty task title is refused.
- Status names the agent uses: `pending`, `in_progress`, `completed` (shown as `left`, `current`, `done`).
- The list's title shown when none was given: `Tasks`.
- The store keeps the 200 most recently changed lists (`MAX_STORED_LISTS`).
- Order when a plan and a list are both there: plan in progress, list in progress; when both are finished, the one whose status changed last (`newer`).
- Permissions: ClaudeTerm's own `--settings` file allows `mcp__claudeterm__set_task_list` and `mcp__claudeterm__get_task_list`; the user's Claude settings are not touched.
- E2e run: `npm run build` once after source changes, then `npx playwright test tests/e2e/<spec> --reporter=line`.

## Review Focus

- A `set_task_list` call before the tab's first SessionStart (no session id yet): the list shows at once and is stored when the id arrives — test in Task 4.
- `task-lists.json` that is not JSON: moved aside, the window warns, the app starts, a new file is written later — test in Task 3.
- A title holding newlines or tabs (the agent pastes a paragraph): folded to one line in the status bar and the box — test in Task 1.
- A `task_list` pipe message for a shell tab, an unknown tab, or a tab that has closed: refused with the "works only in a ClaudeTerm Claude tab" text, nothing stored — tests in Task 4 (hub) and Task 5 (e2e).
- Claude exits (`session_end`) with a list up: the segment goes, as a plan's does, and the list comes back when that conversation is resumed — tests in Task 4 and Task 5.

---

### Task 1: The task list model

**Files:**
- Create: `src/shared/task-list.ts`
- Test: `tests/unit/task-list.test.ts`

**Interfaces:**
- Produces:
  - `type TaskStatus = 'pending' | 'in_progress' | 'completed'`, `const TASK_STATUSES: readonly TaskStatus[]`
  - `interface AgentTask { title: string; status: TaskStatus }`, `interface TaskList { title: string | null; tasks: AgentTask[] }` (a `TaskList` always has at least one task; no list is `null`)
  - `MAX_LIST_TASKS = 100`, `MAX_TASK_TITLE = 200`, `MAX_TASK_LIST_TITLE = 100`, `DEFAULT_TASK_LIST_TITLE = 'Tasks'`
  - `normalizeTaskList(raw: unknown): { ok: true; list: TaskList | null } | { ok: false; error: string }`
  - `taskListStatus(list: TaskList): PlanStatus` (from `src/shared/types.ts`)
  - `taskListSummary(list: TaskList | null): string`
  - `describeTaskList(list: TaskList | null): string`

- [ ] **Step 1: Write the failing tests** in `tests/unit/task-list.test.ts`:
  - `normalizeTaskList(null)` and `normalizeTaskList({ title: 'x', tasks: [] })` → `{ ok: true, list: null }`.
  - `normalizeTaskList({ title: '  Release\n prep ', tasks: [{ title: 'Write\tthe  parser', status: 'completed' }] })` → `{ ok: true, list: { title: 'Release prep', tasks: [{ title: 'Write the parser', status: 'completed' }] } }`.
  - title `'   '` or missing → `title: null`; a title of 150 characters → cut to 100; a task title of 300 → cut to 200.
  - 101 tasks → `{ ok: false, error: 'A task list holds at most 100 tasks; got 101.' }`.
  - task 2 with title `'  '` → `{ ok: false, error: 'Task 2 has no title.' }`; task 1 with status `'blocked'` → `{ ok: false, error: 'Task 1: status must be pending, in_progress or completed.' }`.
  - `'text'`, `[]`, `{ tasks: 'a' }`, `{ title: 5, tasks: [] }` → `ok: false` (errors `'The task list must be an object with a tasks array.'` for the first three, `'The title must be a string.'` for the last).
  - `taskListStatus({ title: null, tasks: [completed 'A', in_progress 'B', pending 'C'] })` → `{ title: 'Tasks', tasks: [{ n: 1, title: 'A', state: 'done' }, { n: 2, title: 'B', state: 'current' }, { n: 3, title: 'C', state: 'left' }], done: 1, total: 3, finished: false }`; all done → `finished: true`.
  - `taskListSummary(list with 1 of 3 done)` → `'Task list updated: 1 of 3 done.'`; `taskListSummary(null)` → `'Task list removed.'`.
  - `describeTaskList(null)` → `'No task list.'`; `describeTaskList({ title: 'Release prep', tasks: [completed 'A', in_progress 'B'] })` → `'Release prep: 1 of 2 done\n1. [completed] A\n2. [in_progress] B'`.

- [ ] **Step 2: Run** `npx vitest run tests/unit/task-list.test.ts` — expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/shared/task-list.ts`** with the interfaces above. Fold whitespace with `.replace(/\s+/g, ' ').trim()` before cutting.

- [ ] **Step 4: Run** `npx vitest run tests/unit/task-list.test.ts` — expected: PASS.

### Task 2: Pipe messages and the MCP tools

**Files:**
- Modify: `src/shared/protocol.ts` (message types, `PipeMessage` union, `parsePipeMessage`)
- Modify: `src/main/pipe-server.ts` (`PipeHandlers`, `handleLine` switch)
- Create: `src/mcp/task-list-tool.ts`
- Modify: `src/mcp/show-image-server.ts` (register two tools)
- Modify: `tests/integration/mcp.int.test.ts`, `tests/integration/pipe.test.ts`, `tests/integration/session-hook.int.test.ts` (their `startPipeServer` fakes gain the two handlers)
- Modify: `src/main/index.ts` only as far as needed to compile: `taskList` / `taskListGet` handlers that answer `{ ok: false, error: 'not implemented' }` (Task 5 replaces them)
- Modify: `README.md` lines 172 and 281 (the tool lists name `set_task_list` and `get_task_list` too)
- Test: `tests/unit/protocol.test.ts`, `tests/unit/task-list-tool.test.ts`, `tests/integration/mcp.int.test.ts`

**Interfaces:**
- Consumes: Task 1's `TaskList`, `TaskStatus`, `TASK_STATUSES`, `normalizeTaskList`, `taskListSummary`.
- Produces:
  - `interface TaskListMessage { v: 1; type: 'task_list'; tabId: string; list: TaskList | null }`
  - `interface TaskListGetMessage { v: 1; type: 'task_list_get'; tabId: string }`
  - `PipeHandlers.taskList(msg: TaskListMessage): PipeResponse`, `PipeHandlers.taskListGet(msg: TaskListGetMessage): PipeResponse`
  - `interface TaskListToolDeps { tabId: string | null; pipeName: string; send(pipeName: string, msg: TaskListMessage | TaskListGetMessage): Promise<PipeResponse> }`
  - `handleSetTaskList(input: { title?: string; tasks: { title: string; status: TaskStatus }[] }, deps: TaskListToolDeps): Promise<ToolResult>`, `handleGetTaskList(deps: TaskListToolDeps): Promise<ToolResult>` (`ToolResult` from `src/mcp/show-image-tool.ts`)

- [ ] **Step 1: Write the failing tests.**
  - `protocol.test.ts`: `{ v: 1, type: 'task_list', tabId: <uuid>, list: { title: 'Release prep', tasks: [{ title: 'A', status: 'completed' }] } }` parses to the same message; `list: null` parses with `list: null`; a non-UUID `tabId` → error `'tabId must be a UUID'`; 101 tasks → the error from `normalizeTaskList`; `{ v: 1, type: 'task_list_get', tabId: <uuid> }` parses.
  - `task-list-tool.test.ts` (fake `send`, like `show-document-tool.test.ts`):
    - `tabId: null` → `{ text: 'set_task_list works only in a ClaudeTerm Claude tab', isError: true }`, nothing sent; the same with `get_task_list` for the get handler.
    - a valid list → sends `{ v: 1, type: 'task_list', tabId, list: <normalized> }` and answers `res.info` with `isError: false`.
    - `tasks: []` → sends `list: null`.
    - 101 tasks → `isError: true` with the normalize error, nothing sent.
    - `send` throws `PipeUnavailableError` → set: `{ text: 'ClaudeTerm is not running; the task list is not shown.', isError: false }`, get: `{ text: 'ClaudeTerm is not running; there is no task list to read.', isError: false }`.
    - `send` answers `{ ok: false, error: 'x' }` → `{ text: 'x', isError: true }`.
    - get sends `{ v: 1, type: 'task_list_get', tabId }` and answers `res.info`.
  - `mcp.int.test.ts`: the tool list is `['get_task_list', 'set_task_list', 'show_diff', 'show_document', 'show_image']`; a `set_task_list` call reaches the pipe fake as the message above and returns the fake's `info`; a `get_task_list` call returns the fake's `info` text.

- [ ] **Step 2: Run** `npx vitest run tests/unit/protocol.test.ts tests/unit/task-list-tool.test.ts tests/integration/mcp.int.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement.** Parse `task_list` with `normalizeTaskList(m.list)`, `tabId` must be a UUID for both types. Register the tools in `show-image-server.ts` following `show_document` (same env handling, `sendPipeMessage(pipe, msg, 3000)`); schemas `title: z.string().optional()`, `tasks: z.array(z.object({ title: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }))`, no length limits in zod (cutting happens in `normalizeTaskList`). Descriptions:
  - `set_task_list`: `'Show a task list with progress in the status bar of ClaudeTerm, for multi-step work, or when the user asks for one. Send the whole list each time, every task with its status; an empty list removes it. A superpowers plan is tracked by ClaudeTerm itself: do not mirror it here.'`
  - `get_task_list`: `'Read the task list shown in ClaudeTerm for this conversation, with each task\'s status.'`

- [ ] **Step 4: Run** the three test files again and `npm run typecheck` — expected: PASS, no type errors.

### Task 3: The store

**Files:**
- Create: `src/main/task-list-store.ts`
- Test: `tests/unit/task-list-store.test.ts`

**Interfaces:**
- Consumes: Task 1's `TaskList`, `normalizeTaskList`.
- Produces:
  - `MAX_STORED_LISTS = 200`
  - `parseTaskLists(text: string): Map<string, { list: TaskList; changedAt: number }> | null`
  - `class TaskListStore { readonly path: string; constructor(dir: string, opts?: { debounceMs?: number; onError?(message: string): void; warn?(message: string): void; now?(): number }); get(sessionId: string): TaskList | null; set(sessionId: string, list: TaskList | null): void; flush(): void }`

- [ ] **Step 1: Write the failing tests** (temp folders, as `session-notes.test.ts` does):
  - set, flush, a new store on the same folder → `get` returns the list; the file is `task-lists.json` holding `{ [sid]: { list, changedAt } }`.
  - `set(sid, null)` removes the entry.
  - `parseTaskLists` drops entries whose key is not a UUID, whose `list` fails `normalizeTaskList` or is null, or whose `changedAt` is not a finite number; returns `null` for text that is not a JSON object.
  - with `now` stepping 1, 2, 3…, after 201 different sessions are set and flushed the file holds 200 entries and the first session's is gone.
  - a file with `{oops`: the store starts empty, the file is moved aside (same naming as `SessionNotes`), `warn` is called once; a later `set` + `flush` writes a new `task-lists.json`.
  - `get` returns a copy: changing it does not change the store.

- [ ] **Step 2: Run** `npx vitest run tests/unit/task-list-store.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement `TaskListStore`** by following `src/main/session-notes.ts` (debounced write through `.tmp` and rename, `load()`, moving a bad file aside, `writable`). On flush, keep the `MAX_STORED_LISTS` entries with the largest `changedAt`. `now` defaults to `Date.now`.

- [ ] **Step 4: Run** the test file — expected: PASS.

### Task 4: The hub and what the status bar shows

**Files:**
- Create: `src/main/task-list-hub.ts`
- Test: `tests/unit/task-list-hub.test.ts`

**Interfaces:**
- Consumes: Task 1's `TaskList`, `taskListStatus`; Task 3's `TaskListStore` (`get`, `set` only); `PlanStatus`.
- Produces:
  - `interface TaskListHubDeps { store: Pick<TaskListStore, 'get' | 'set'>; onChange(tabId: string): void }`
  - `class TaskListHub { addTab(tabId: string, sessionId: string | null): void; removeTab(tabId: string): void; session(tabId: string, sessionId: string, forkFrom: string | null): void; sessionEnd(tabId: string, sessionId: string): void; set(tabId: string, list: TaskList | null): boolean; get(tabId: string): TaskList | null; status(tabId: string): PlanStatus | null }`
  - `shownPlan(plan: PlanStatus | null, list: PlanStatus | null): { plan: PlanStatus | null; agentList: boolean }`

Rules (from the spec): `addTab` with a session id takes the list stored under it. `session()` to the id the tab has: nothing moves, a list hidden by `sessionEnd` shows again. `session()` to a new id: the stored list of the new id shows if there is one; else, with `forkFrom` set and a list stored under it, a copy is stored under the new id and shows (the head's stays); else the tab's list, if unfinished, moves (stored under the new id, removed from the old one); a finished list stays stored under the old id and the tab shows none. `sessionEnd` for the tab's session hides the list (kept stored); for another id it does nothing. `set` stores under the tab's session id when it has one, else keeps the list in the tab until the first id; it returns `false` for an unknown tab. `get` returns null while hidden. `onChange` fires whenever what `status()` returns changes, never otherwise; not on `removeTab`.

- [ ] **Step 1: Write the failing tests**, one per rule above, with an in-memory fake store and a recorded `onChange`, plus:
  - `set` before any session id, then `session(t, A, null)` → the store holds the list under A.
  - `set` on a removed tab → `false`, store untouched.
  - `shownPlan`: unfinished plan + unfinished list → plan, `agentList: false`; finished plan + unfinished list → list, `agentList: true`; finished plan + finished list → the one that finished last (`newer: 'list'` → list, `agentList: true`; `newer: 'plan'` → plan); null + finished list → list, `agentList: true`; null + null → `{ plan: null, agentList: false }`.

- [ ] **Step 2: Run** `npx vitest run tests/unit/task-list-hub.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement** `TaskListHub` and `shownPlan` in `src/main/task-list-hub.ts`.

- [ ] **Step 4: Run** the test file — expected: PASS.

### Task 5: Main wiring, permissions and the README

**Files:**
- Modify: `src/main/index.ts` (store and hub next to `notes`/`noteHub` around line 175; `planHub`'s `onChange` around line 236; `onTabStarted` / `onTabClosed` around line 376; the `session` and `sessionEnd` pipe handlers around line 652; the `taskList` / `taskListGet` handlers; `flush()` wherever `notes.flush()` is called)
- Modify: `src/shared/ipc.ts` (`PlanUpdate`)
- Modify: `src/main/claude-tab-settings.ts` (`claudeTabSettingsJson`)
- Modify: `README.md` (a paragraph after the superpowers plan paragraph, line 68)
- Test: `tests/unit/claude-tab-settings.test.ts`, create `tests/e2e/task-list.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `PlanUpdate` gains `agentList?: boolean` ("the plan shown is the task list Claude keeps with set_task_list, which can be cleared, not a superpowers plan"). Every `evPlan` send goes through one function: `{ tabId, ...shownPlan(planHub.get(tabId).plan, taskLists.status(tabId)) }`.

- [ ] **Step 1: Write the failing tests.**
  - `claude-tab-settings.test.ts`: `JSON.parse(claudeTabSettingsJson(...)).permissions` equals `{ allow: ['mcp__claudeterm__set_task_list', 'mcp__claudeterm__get_task_list'] }`.
  - `tests/e2e/task-list.spec.ts` (invented ids and titles; `launchClaudeTab`, `sendPipeMessage`, `makeDataDir`, `launchApp` from `helpers.ts`; a `session` helper as in `notes.spec.ts`; the plan-run helpers copied in small from `plan.spec.ts`):
    1. A `task_list` message with 3 tasks (1 done, 1 in progress) answers `{ ok: true, info: 'Task list updated: 1 of 3 done.' }`; `#statusbar .status-plan` reads `1/3 · <in-progress title>` with title attribute `Release prep — 1 of 3 done. Click for the task list`; a click shows `#plan-list` with the three titles and marks `✓ ● ○`; `task_list_get` answers `info` `'Release prep: 1 of 3 done\n1. [completed] …'`; `list: null` removes the segment.
    2. A superpowers plan in progress hides the list; deleting the plan workspace (the plan finishes) shows the list again.
    3. `/clear` (`session` with a new id, source `clear`) keeps an unfinished list on screen and `task-lists.json` has it under the new id only; with every task done, the segment goes after `/clear` and the file keeps it under the old id.
    4. Restore: a `session-state.json` with a Claude tab of session A and a `task-lists.json` holding A's list → the restored tab's segment shows it once its `session` message (source `resume`, id A) arrives.
    5. Fork: the head (session A) has a list; `window.ct.forkTab(head)`; the fork's `session` message (id B, source `fork`) → the fork shows the same list, and the file holds it under A and B.
    6. `session_end` hides the segment; a `session` message for the same id brings it back.
    7. A `task_list` message for a shell tab's id answers `{ ok: false, error: 'set_task_list works only in a ClaudeTerm Claude tab' }`.

- [ ] **Step 2: Run** `npx vitest run tests/unit/claude-tab-settings.test.ts`, then `npm run build` and `npx playwright test tests/e2e/task-list.spec.ts --reporter=line` — expected: FAIL.

- [ ] **Step 3: Implement.** Store: `new TaskListStore(dataDir, { onError: (m) => log.warn(m), warn: toast })`. Hub `onChange` and `planHub` `onChange` both call the one `evPlan` sender. `onTabStarted`: `taskLists.addTab(tab.id, tab.claudeSessionId)` for Claude tabs; `onTabClosed`: `removeTab`. `session` handler, after `tabs.setClaudeSession`: `taskLists.session(msg.tabId, msg.sessionId, msg.source === 'fork' ? tabs.get(msg.tabId)?.fork?.from ?? null : null)`. `sessionEnd` handler: `taskLists.sessionEnd(...)`. `taskList` handler: refuse unless `isClaudeTab`, then `taskLists.set(msg.tabId, msg.list)` and answer `{ ok: true, info: taskListSummary(msg.list) }`; `taskListGet`: refuse the same way (`'get_task_list works only in a ClaudeTerm Claude tab'`), answer `{ ok: true, info: describeTaskList(taskLists.get(msg.tabId)) }`. README paragraph, in the voice of line 68: Claude can also keep a task list of its own with the bundled `set_task_list` tool, when it sees fit or you ask; it shows the same way, a superpowers plan in progress comes first, the list stays with the conversation (`/clear`, Restore, Recent sessions), and the task box's Clear removes it.

- [ ] **Step 4: Run** the unit test, `npm run build`, the e2e spec, and `npx playwright test tests/e2e/plan.spec.ts tests/e2e/notes.spec.ts tests/e2e/forks.spec.ts --reporter=line` — expected: PASS.

### Task 6: Clear in the task box

**Files:**
- Modify: `src/shared/ipc.ts` (`IPC.tasksClear: 'tasks:clear'`, `clearTaskList(tabId: string): void` in the bridge type)
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts` (`ipcMain.on(IPC.tasksClear, …)`: `isId(id)` and a Claude tab, then `taskLists.set(id, null)`)
- Modify: `src/renderer/plan-list.ts`, `src/renderer/main.ts` (keep the whole `PlanUpdate` per tab, not just the plan), `src/renderer/styles.css`
- Test: `tests/e2e/task-list.spec.ts`

**Interfaces:**
- Consumes: Task 5's `PlanUpdate.agentList`.
- Produces: `PlanList` constructor takes a third argument `onClear: () => void`; `toggle(anchor, plan, clearable: boolean)` and `update(plan, clearable: boolean)`. The head holds `<button class="plan-clear" title="Remove this task list">Clear</button>` only when `clearable`.

- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/task-list.spec.ts`:
  - an agent's list: the task box has `.plan-clear`; a click closes the box, removes the segment, `task_list_get` answers `'No task list.'`, and `task-lists.json` no longer holds the session.
  - a superpowers plan's task box has no `.plan-clear`.

- [ ] **Step 2: Run** `npm run build` and `npx playwright test tests/e2e/task-list.spec.ts --reporter=line` — expected: the two new tests FAIL.

- [ ] **Step 3: Implement.** The button sits at the end of `.plan-head`, styled like the other small buttons of the window (muted, no border until hover). A click calls `onClear()` then `close()`; `main.ts` passes `() => { if (activeId) ct.clearTaskList(activeId) }`.

- [ ] **Step 4: Run** `npm run typecheck`, `npm test`, `npm run build`, `npx playwright test tests/e2e/task-list.spec.ts tests/e2e/plan.spec.ts --reporter=line` — expected: PASS.
