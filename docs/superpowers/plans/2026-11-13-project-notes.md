# Project notes, a note editor, and notes for Claude — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude tab's Note card gets a **Session | Project** switch (one project note per git project, shared by all its Claude tabs and worktrees, kept in ClaudeTerm's data folder), becomes a small CodeMirror editor with real checkboxes and bullets and a resize grip, and the bundled `claudeterm` MCP server gets `read_notes`, `add_to_note` and `check_note_item`, whose edits merge with what the person types.

**Architecture:** `src/shared/note.ts` grows the side, the size and the project types; `src/shared/note-items.ts` holds the Markdown item rules and Claude's two operations (`append`, `check`) as pure functions that main and the window both run. Main: `NoteHub` (session notes) learns the side, the size and Claude's operations; a new store `ProjectNotes` (`project-notes.json`) and `ProjectNoteHub`, keyed by `TabPlace.project.key`, which main already gets for every tab from `TabPlaces`; `note-replies.ts` answers three new pipe messages. Each of Claude's edits is recorded with the note number it makes; a text the window typed against an older number has those operations replayed onto it (`replayNoteOps`), which is what the window itself does when the operation reaches it, so both land on the same text with no extra round trip. MCP: `src/mcp/note-tools.ts` registers the tools. Renderer: `note-commands.ts` (CodeMirror state commands), `note-editor.ts` (the view, with widgets over `- [ ] `, `- [x] ` and `- `) and `NoteOverlay` (the switch, the counts, the label, Claude's live edits, the grip).

**Tech Stack:** Electron 44, TypeScript (strict), CodeMirror 6 (`@codemirror/state` 6.7.6, `@codemirror/view` 6.43.15, `@codemirror/commands` 6.11.1), `@modelcontextprotocol/sdk` + zod, plain DOM, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-project-notes-design.md` (approved; read it whole). The mockups (variant A) are in the conversation of 2026-11-13, not in the repository: the CSS values in Tasks 9–11 stand for them.

**Execution:** subagent-driven, implementers on Haiku (the person's standing rule; fix rounds 4–5 escalate as the skill says). Each implementer works in a worktree of its own and gets this section, Global Constraints and its task.

**Already in place:** the three CodeMirror packages are in `package.json` `devDependencies`, beside the renderer's other bundled packages (`@xterm/*`, `markdown-it`, `@fontsource-variable/inter`), which electron-vite bundles into the renderer (commit `e5f4aba`), and they are installed. No task adds a package.

## Global Constraints

- **Workspace:** work only in the worktree the controller gives you. Never `cd` to the main checkout, never touch another worktree.
- **No git writes:** never commit, stash, push, reset or create branches. Leave every change uncommitted; the controller commits each task with the Conventional Commits message its last step names.
- **Owned files:** edit only the files your task lists. A typecheck error or a failing test in a file your task does not list is other work in progress: never edit it; rerun after a few minutes; report it if it persists. A conflict with another agent's work goes to the controller.
- **Build and e2e only through the shared lock:** `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run build && npx playwright test tests/e2e/<spec> --workers=2 --reporter=line"` (`--workers=1` on a busy machine). A spec with an `@alone` test runs as `… "npm run build && node scripts/e2e.mjs tests/e2e/<spec> --reporter=line"`. `npm run typecheck` and `npx vitest run <files>` run without the lock. **No `npm install`.**
- **Tests never touch the machine:** no test starts the real `claude`, calls the API, registers the MCP server for the real user, or reads or writes the real `~/.claude` or `%APPDATA%\ClaudeTerm`. e2e tests use `tests/e2e/helpers.ts` (`launchApp`, `launchClaudeTab`, `gitRepo`, `gitWorktree`); files only under `tmpdir()`; every app a test starts is closed.
- **Claude never loses or changes the person's text:** its only edits are an append at the end and a tick or untick of one item. No tool, message or function removes or replaces text.
- **Untrusted input:** everything from the pipe and from `project-notes.json` is checked field by field: a note at most `MAX_NOTE_LENGTH` (100 000) characters, an added text 1–`NOTE_ADD_MAX` (10 000), an item 1–`NOTE_ITEM_MAX` (2 000), a project key 1–`MAX_PROJECT_KEY` (4 096) characters without NUL, a size integers within `MIN_NOTE_SIZE`…`MAX_NOTE_SIZE`. Nothing throws on bad input. Renderer IPC arguments go through `src/main/ipc-guards.ts`.
- **Main never blocks:** `project-notes.json` is read once at start (as `session-notes.json` is) and written 500 ms after the last change, atomically (`.tmp` + rename), and at once on window close, quit and before an update install.
- **Project keys** are `TabPlace.project.key` exactly as `TabPlaces` publishes it (already `pathKey`ed). Never derive a key from a path string yourself; compare keys as strings.
- **UI strings exact** as the tasks give them (English). Comments and logs English. Match the neighbours' naming and comment density; no UI framework (CodeMirror is an editor component, allowed by the spec).
- **Line endings:** the checkout has `core.autocrlf=true`; keep each file's endings (CRLF in the working tree except `src/renderer/styles.css` and `tests/e2e/note-overlay.spec.ts`, which are LF). New files: CRLF, like their neighbours.
- **CSS:** colours are the variables of `src/renderer/colors.css` (`--raised --raised-2 --line-2 --text --text-2 --text-3 --accent …`); motion animates only `transform` and `opacity`, off under `prefers-reduced-motion: reduce`.
- **Flaky specs:** `review.spec`, a fold test in `tab-panel.spec` and the git submodule tests flake under load: rerun a failing test alone through the lock before blaming the change.
- **Done for a task** = `npm run typecheck`, its `npx vitest run …` files and its e2e specs through the lock, all green.

## Streams

| Phase | Tasks | Owns (only these files are edited) |
|---|---|---|
| Shared, first, in order | 1, 2 | `src/shared/note.ts`, `src/shared/note-items.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts`, their unit tests |
| **M** (main), in order | 3 → 4 → 5 → 6 → 7 → 8 | `src/main/**`, `src/shared/protocol.ts`, `src/mcp/**`, `tests/unit/*` and `tests/integration/*` named in M's tasks, `tests/e2e/notes.spec.ts`, `tests/e2e/project-notes.spec.ts`, `tests/e2e/note-tools.spec.ts` |
| **R** (renderer), in order | 9 → 10 → 11 | `src/renderer/**`, `tests/unit/note-commands.test.ts`, `tests/e2e/helpers.ts` (one export), `tests/e2e/note-editor.spec.ts`, `tests/e2e/project-notes-card.spec.ts`, `tests/e2e/note-size.spec.ts`, and the note assertions of `tests/e2e/{note-overlay,change-folder,chat-cards,forks,remote-tabs,tab-panel}.spec.ts` |
| Final | 12 | `README.md`, `CHANGELOG.md` |

**When R starts:** 9 after 2; 10 after 7 and 9 (its e2e uses Task 6's events and Task 7's pipe messages); 11 after 10. The contract between the streams is Task 1's types and functions and Task 2's IPC.

## Decisions the design leaves to the builder (binding)

1. **Sizes.** Default `340 × 240` px, minimum `260 × 140`, largest stored `4000 × 4000`. The card is drawn at most as big as its area: from 10 px inside the left edge of the terminal's (or chat's) area to the card's right edge, and from the card's top to 10 px above the area's bottom.
2. **The merge of concurrent edits.** Claude's edits are operations (`NoteOp`: `append`, `check`) applied in main to the note's current text; each makes the next note number and goes to the window as an operation with that number. A note keeps its last 64 operations. A text typed against an older number has the operations made since replayed onto it (`replayNoteOps`), the same function the window runs on its own text when the operation arrives, so main and window end equal. An operation that no longer applies to the typed text (the person changed or duplicated that very item) does nothing: on that item the person's text wins. A text typed against a number older than the kept operations is dropped. Proving tests: Task 5 (both hubs) and Task 7 e2e.
3. **Undo:** Claude's edits enter the editor with `Transaction.addToHistory.of(false)`: the person's undo never takes them back, and the person's own undo steps map over them.
4. **Where the card state lives.** `side` and `size` are fields of the session `Note`, stored and synced with it as `shown` and `form` are. The store keeps only notes with text (as today), so a conversation whose session note is empty keeps its side and size for the run only. A project note's size is stored with the project note, under the same rule.
5. **Project notes reach the window once per run per project:** main sends a project's note (number 1) when the first Claude tab of that project shows up in this run, and keeps every loaded project for the run; the window keeps every project note it got. Later tabs of the project use what the window has.
6. **The tab mark** ("Has a note") stays the session note's.
7. **The label:** with items, `<ticked>/<all>` and the first unticked item's text; all ticked, the count and the first line; no items, the first line as today. A first line's `- [ ] `, `- [x] ` or `- ` is not shown.
8. **Enter inside an item's text** splits it into two items (the new one unticked); Enter on an empty item or bullet ends the list.
9. **Text Claude adds** has `\r\n`/`\r` turned into `\n`, leading blank lines and trailing whitespace removed (CodeMirror's text uses `\n`).
10. **The pipe's 64 KiB line** limits an added text to 10 000 characters (`NOTE_ADD_MAX`); the tool asks Claude to add a longer text in parts.
11. **The card head:** the title `Note` is replaced by the switch. A remote tab's Project side is disabled (the spec's non-goal), and so is a tab whose place is not known yet.
12. **Tool wording** is Task 8's and Task 7's (descriptions, server instructions, every reply).

## Shared files (other plans running now touch them too)

`src/main/index.ts` (Tasks 3, 5, 6, 7), `src/shared/ipc.ts` and `src/preload/index.ts` (Task 2), `src/shared/protocol.ts` and `src/main/pipe-server.ts` (Task 7), `src/mcp/show-image-server.ts` (Task 8: three lines — the import, the instructions, `registerNoteTools(server)`), `src/main/sync/views.ts` (Task 3), `src/renderer/main.ts`, `src/renderer/env.d.ts`, `src/renderer/styles.css` (Tasks 9–11), `tests/integration/mcp.int.test.ts` (Tasks 7, 8: the tool list and the handler object), `tests/integration/pipe.test.ts`, `tests/integration/session-hook.int.test.ts` (Task 7: handler fills), `tests/e2e/helpers.ts` and the note assertions of six e2e specs (Task 9), `README.md` (its tool list at "On its first start ClaudeTerm registers…" and the mermaid line) and `CHANGELOG.md` (the top section) (Task 12). Everything else is the note's own files.

## Review Focus

1. **The person types while Claude edits the same note** (a keystroke sent before Claude's edit reached the window): neither edit is lost, the caret and what is typed next stay where they were. Tests: Task 5 `'a text typed against the number before Claude's edit keeps the edit, as the window makes it'` (both hubs), Task 7 e2e `'a text typed before Claude's edit reached the window keeps Claude's edit'`, Task 10 e2e `'Claude's edit shows in the open card at once; the caret stays and what is typed next goes where it was'`.
2. **Text that only looks like an item** — `-[ ] a`, `* [ ] a`, `- [ ]x`, an indented item, `[X]`, `- [ ]` at a line's end, an item with spaces or `\r` at its end, Claude's text with `\r\n`: main, the tools, the label and the editor read it the same way. Tests: Task 1 `'parseLine …'`, `'noteItems …'`, `'appendText …'`, `'tryNoteOp check …'`.
3. **A tool call where there is no project note** — the tab's place not known yet, a folder outside git — and a tab in a linked worktree: a reply that says why, and the worktree's tab on the main worktree's note. Tests: Task 7 `'read says why a tab has no project …'`, e2e `'note_read … a tab outside git … says why'`; Task 6 e2e `'… a tab in a linked worktree writes the same note'`.
4. **A note near its length limit:** an add that would pass 100 000 characters is refused whole, nothing cut, on both sides of a replay. Tests: Task 1 `'tryNoteOp refuses an append past the limit; applyNoteOp leaves the text'`, Task 7 e2e `'add_to_note refuses text that would pass the limit'`.
5. **A damaged `project-notes.json`** (not JSON, a bad entry, a bad size): kept aside with a toast, never written over; a bad entry dropped alone; a bad size loses only the size. Tests: Task 4.

---

### Task 1: the note model and its Markdown items

**Files:**
- Modify: `src/shared/note.ts`
- Create: `src/shared/note-items.ts`
- Test: `tests/unit/note-model.test.ts` (new), `tests/unit/note-items.test.ts` (new)

**Interfaces — Consumes:** `TabPlace` (`src/shared/types.ts`, `project: { key; name; parent }`), `MAX_NOTE_LENGTH`, `hasText`.

**Interfaces — Produces** (every later task uses these names):

```ts
// src/shared/note.ts — the existing exports stay
export type NoteSide = 'session' | 'project'
export const NOTE_SIDES: readonly NoteSide[] = ['session', 'project']
export interface NoteSize { width: number; height: number }
export const NOTE_SIZE: NoteSize = { width: 340, height: 240 }        // the default
export const MIN_NOTE_SIZE: NoteSize = { width: 260, height: 140 }
export const MAX_NOTE_SIZE: NoteSize = { width: 4000, height: 4000 }  // the largest stored; the card is drawn within its area
export interface Note { text: string; shown: boolean; form: NoteForm; side?: NoteSide; size?: NoteSize }
export interface ProjectNote { text: string; size?: NoteSize }
/** a tab's project note: its project, or why it has none */
export type NoteProject = { key: string; name: string } | { key: null; why: 'remote' | 'outside' | 'unknown' }
export const MAX_PROJECT_KEY = 4096
export const NOTE_ADD_MAX = 10_000
export const NOTE_ITEM_MAX = 2_000
export function isNoteSize(v: unknown): v is NoteSize        // a plain object, integer width and height within MIN..MAX
export function isProjectKey(v: unknown): v is string        // a string of 1..MAX_PROJECT_KEY characters without '\0'
export function noteProjectOf(remote: boolean, place: TabPlace | null | undefined): NoteProject
//   remote → why 'remote'; undefined (not known yet) → 'unknown'; null (outside git) → 'outside'; else { key: place.project.key, name: place.project.name }

// src/shared/note-items.ts — no Node or DOM imports: main and the renderer both use it
export interface NoteLine { indent: number; kind: 'item' | 'bullet' | 'plain'; checked: boolean; textStart: number }
export function parseLine(line: string): NoteLine
export interface NoteItem { line: number; checked: boolean; text: string }   // line: 0-based; text trimmed
export function noteItems(text: string): NoteItem[]
export function itemCount(text: string): { checked: number; total: number }
export function firstLine(text: string): string
export function noteLabel(text: string): { count: string | null; text: string }
export type NoteOp = { kind: 'append'; text: string } | { kind: 'check'; item: string; checked: boolean }
export type OpResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'too-long'; adds: number }    // adds: how many characters the append would add
  | { ok: false; reason: 'no-match' }
  | { ok: false; reason: 'ambiguous'; matches: number }
export function appendText(text: string, addition: string): string           // no limit check
export function tryNoteOp(text: string, op: NoteOp): OpResult
export function applyNoteOp(text: string, op: NoteOp): string                 // the new text, or `text` when the op is refused
export function replayNoteOps(text: string, ops: readonly NoteOp[]): string
export interface TextChange { from: number; to: number; insert: string }
export function diffText(a: string, b: string): TextChange | null             // the one change from a to b; null when equal
```

Rules:
- `parseLine`: an item matches `/^([ \t]*)- \[([ xX])\](?: |$)/` (textStart: the match's length; `x`/`X` ticked); else a bullet matches `/^([ \t]*)- /` (textStart: indent + 2); else plain (textStart: indent). `indent` counts the leading spaces and tabs. A `\r` at the end is part of the line.
- `noteItems`: lines split on `\n`; `text` is the line from `textStart`, trimmed. `firstLine`: the first line with non-blank text, from its `textStart`, trimmed. `noteLabel`: items → `count` `"<checked>/<total>"` and the first unticked item's text, or `firstLine` when all are ticked; no items → `count: null`, `firstLine`.
- `appendText`: the addition first has `\r\n` and `\r` turned into `\n`, its leading blank lines and its trailing whitespace removed. A text that is blank (`trim() === ''`) gives the addition; one ending with a blank line (`/\n[ \t]*\n$/`) gives `text + addition`; one ending with `\n` gives `text + '\n' + addition`; any other `text + '\n\n' + addition`.
- `tryNoteOp` append: an addition empty once normalised → `empty`; a result longer than `MAX_NOTE_LENGTH` → `too-long` with `adds = result.length - text.length`; else `{ ok, text: result, changed: true }`. Check: the items whose text equals `op.item.trim()`; none → `no-match`; several → `ambiguous`; one → its box character (index `indent + 3` of its line) becomes `x` or ` `; `changed` is false when it already was ticked (`x` or `X`) or unticked, and the text is then returned unchanged.
- `diffText`: the common prefix and the common suffix (not overlapping it); the prefix never ends on a high surrogate and the suffix never starts on a low one.

- [ ] **Step 1: Write the failing tests.**
  - `tests/unit/note-model.test.ts`: `'isNoteSize takes integer sizes within the bounds'` (`{340,240}`, `{260,140}`, `{4000,4000}` true; `{259,240}`, `{340,139}`, `{4001,240}`, `{340.5,240}`, `null`, `[340,240]`, `{ width: '340', height: 240 }` false); `'isProjectKey takes 1 to 4096 characters without NUL'` (`'c:\\work\\acme'`, `'/home/u/acme'` true; `''`, `'x'.repeat(4097)`, `'a\0b'`, `5` false); `'noteProjectOf: remote, not known yet, outside git, a project'` (`(true, place)` → `{ key: null, why: 'remote' }`; `(false, undefined)` → `'unknown'`; `(false, null)` → `'outside'`; `(false, { project: { key: 'c:\\work\\acme', name: 'acme', parent: 'work' }, worktree: null, branch: 'main' })` → `{ key: 'c:\\work\\acme', name: 'acme' }`).
  - `tests/unit/note-items.test.ts`:
    - `'parseLine reads items, bullets and plain lines'`: `'- [ ] a'` → `{ indent: 0, kind: 'item', checked: false, textStart: 6 }`; `'  - [x] b'` → `{ 2, item, true, 8 }`; `'\t- [X] c'` → `{ 1, item, true, 7 }`; `'- [ ]'` → `{ 0, item, false, 5 }`; `'- [ ]x'` → `{ 0, bullet, false, 2 }`; `'- b'` → bullet textStart 2; `'-[ ] a'`, `'* [ ] a'`, `'text'` → plain textStart 0; `'  text'` → plain indent 2 textStart 2.
    - `'noteItems lists the items with their text trimmed'`: `'Goal\n- [ ] Write the tests  \n  - [x] Tag\n- bullet\n- [X] Done\r'` → `[{ line: 1, checked: false, text: 'Write the tests' }, { line: 2, checked: true, text: 'Tag' }, { line: 4, checked: true, text: 'Done' }]`; `itemCount` of it → `{ checked: 2, total: 3 }`; of `'plain'` → `{ 0, 0 }`.
    - `'firstLine skips blank lines and drops the marker'`: `'\n  - [ ] Write\nx'` → `'Write'`; `'- foo'` → `'foo'`; `'  Goal: payments  \nTODO'` → `'Goal: payments'`; `''` → `''`.
    - `'noteLabel: the count and the first unticked item; all ticked, the first line; no items, the first line'`: `'Goal\n- [x] Tag\n- [ ] Write the tests\n- [ ] Ship'` → `{ count: '1/3', text: 'Write the tests' }`; `'- [x] a\n- [x] b'` → `{ count: '2/2', text: 'a' }`; `'Goal: payments\nTODO'` → `{ count: null, text: 'Goal: payments' }`.
    - `'appendText adds after one blank line'`: `('', '- [ ] a')` → `'- [ ] a'`; `('  \n', 'x')` → `'x'`; `('Goal', 'x')` → `'Goal\n\nx'`; `('Goal\n', 'x')` → `'Goal\n\nx'`; `('Goal\n\n', 'x')` → `'Goal\n\nx'`; `('Goal\n  \n', 'x')` → `'Goal\n  \nx'`; `('Goal', '\n\n- [ ] a\r\n- [ ] b\n\n')` → `'Goal\n\n- [ ] a\n- [ ] b'`.
    - `'tryNoteOp append: an empty text is refused, a text is added'`: `('Goal', append '  \n ')` → `{ ok: false, reason: 'empty' }`; `('Goal', append '- [ ] a')` → `{ ok: true, text: 'Goal\n\n- [ ] a', changed: true }`.
    - `'tryNoteOp refuses an append past the limit; applyNoteOp leaves the text'`: `t = 'x'.repeat(MAX_NOTE_LENGTH - 5)`, append `'abcdef'` → `{ ok: false, reason: 'too-long', adds: 8 }`; `applyNoteOp(t, op) === t`.
    - `'tryNoteOp check ticks the one item with that text, ends ignored'`: `('- [ ] Write the tests\n- [ ] Ship', check ' Write the tests ', true)` → `{ ok: true, text: '- [x] Write the tests\n- [ ] Ship', changed: true }`; `('  - [ ] a', check 'a', true)` → `'  - [x] a'`; `('- [X] a', check 'a', true)` → `changed: false`, text unchanged; `('- [X] a', check 'a', false)` → `'- [ ] a'`; `('- [ ] Write the tests', check 'write the tests', true)` → `no-match`; `('- [ ] a\n- [x] a', check 'a', true)` → `{ ok: false, reason: 'ambiguous', matches: 2 }`; `('- a', check 'a', true)` → `no-match`.
    - `'replayNoteOps applies the ops in order'`: `('Goal: payments', [append '- [ ] Write the tests', check 'Write the tests' true])` → `'Goal: payments\n\n- [x] Write the tests'`.
    - `'diffText gives the one change, and never splits a surrogate pair'`: `('abc', 'abXc')` → `{ from: 2, to: 2, insert: 'X' }`; `('aXc', 'ac')` → `{ from: 1, to: 2, insert: '' }`; `('same', 'same')` → `null`; `('a😀', 'a😁')` → `{ from: 1, to: 3, insert: '😁' }`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/note-model.test.ts tests/unit/note-items.test.ts`. Expected: FAIL (the module and the functions are missing).
- [ ] **Step 3: Implement** the two files as the Interfaces and Rules say.
- [ ] **Step 4: Run** the same tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: the note model knows sides, sizes, projects and Markdown items`).

### Task 2: the IPC contract

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts`
- Test: `tests/unit/ipc-guards.test.ts`

**Interfaces — Consumes:** Task 1's `NoteSide`, `NoteSize`, `ProjectNote`, `NoteOp`, `isNoteSize`, `isProjectKey`, `NOTE_SIDES`.

**Interfaces — Produces:** `IPC` gains `notesSetSide: 'notes:set-side'`, `notesSetSize: 'notes:set-size'`, `projectNotesSetText: 'project-notes:set-text'`, `projectNotesSetSize: 'project-notes:set-size'`, `evNoteOp: 'ev:note-op'`, `evProjectNote: 'ev:project-note'`, `evProjectNoteOp: 'ev:project-note-op'`. `CtApi` gains (preload: `ipcRenderer.send` / `on(...)` like `setNoteView` and `onNote`):

```ts
/** which note a Claude tab's card shows in front; `generation` as for setNoteText */
setNoteSide(tabId: string, side: NoteSide, generation: number): void
/** the card size of a Claude tab's session note; null: the default size; `generation` as for setNoteText */
setNoteSize(tabId: string, size: NoteSize | null, generation: number): void
/** the text of the tab's project note; key: TabPlace.project.key; generation: the number of the project's note it was typed against (onProjectNote, onProjectNoteOp) */
setProjectNoteText(tabId: string, key: string, text: string, generation: number): void
/** the card size of the tab's project note; null: the default size */
setProjectNoteSize(tabId: string, key: string, size: NoteSize | null): void
/** one of Claude's edits of a tab's session note, with the number it makes: the window applies it to its text with applyNoteOp */
onNoteOp(cb: (tabId: string, op: NoteOp, generation: number) => void): Unsubscribe
/** a project's note (null: none yet) with its number, the first time a Claude tab of the project shows up in this run */
onProjectNote(cb: (key: string, note: ProjectNote | null, generation: number) => void): Unsubscribe
/** one of Claude's edits of a project's note, with the number it makes */
onProjectNoteOp(cb: (key: string, op: NoteOp, generation: number) => void): Unsubscribe
```

`src/main/ipc-guards.ts`: `export const isNoteSide = (v: unknown): v is NoteSide`, `export const isNoteSizeArg = (v: unknown): v is NoteSize | null` (null or `isNoteSize`), `export const isProjectKeyArg = (v: unknown): v is string` (`isProjectKey`).

- [ ] **Step 1: Write the failing tests** in `tests/unit/ipc-guards.test.ts`: `'isNoteSide takes session and project only'` (`'left'`, `''`, `null` false); `'isNoteSizeArg takes a size within the bounds, or null'` (`null`, `{ width: 340, height: 240 }` true; `undefined`, `{ width: 10, height: 10 }`, `{ width: 340 }` false); `'isProjectKeyArg takes a project key'` (`'c:\\work\\acme'` true; `''`, `'a\0b'` false).
- [ ] **Step 2: Run** `npx vitest run tests/unit/ipc-guards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the channels, the `CtApi` members (with the comments above), the preload entries and the guards.
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: IPC for the note's side, size, project note and Claude's edits`).

---

## Stream M (main process)

### Task 3: the session note keeps its side and its size

**Files:**
- Modify: `src/main/session-notes.ts` (`noteEntry`, `sameNote`), `src/main/sync/views.ts` (`noteOf`), `src/main/note-hub.ts` (`setSide`, `setSize`), `src/main/index.ts` (two handlers after `IPC.notesSetView`'s)
- Test: `tests/unit/session-notes.test.ts`, `tests/unit/sync-views.test.ts`, `tests/unit/note-hub.test.ts`, `tests/e2e/notes.spec.ts`

**Interfaces — Consumes:** Tasks 1–2 (`NoteSide`, `NoteSize`, `NOTE_SIDES`, `isNoteSize`, `IPC.notesSetSide`, `IPC.notesSetSize`, `isNoteSide`, `isNoteSizeArg`, `isGeneration`).

**Interfaces — Produces:** `NoteHub.setSide(tabId: string, side: NoteSide, generation: number): void` and `NoteHub.setSize(tabId: string, size: NoteSize | null, generation: number): void`, taken like `setView` (dropped unless `generation` is the tab's, then `change`); a null size removes the `size` key.

Rules:
- `noteEntry` (the file) keeps `side` when it is one of `NOTE_SIDES` and `size` when `isNoteSize`; a bad side or size is left out and the note kept. A note without a side or a size has no such key.
- `views.ts`: `validNote` stays as it is (a note from an older or a newer device with other fields stays valid); `noteOf` adds `side` and `size` from the latest live write, each only when valid.
- `sameNote` also compares the side (a missing side is `'session'`) and the size (both missing, or the same width and height). The store bridge writes a change of side or size to the device group because of it.
- `src/main/index.ts`: `ipcMain.on(IPC.notesSetSide, (_e, id, side, generation) => …)` and `ipcMain.on(IPC.notesSetSize, …)` with `isId`, `isNoteSide` / `isNoteSizeArg`, `isGeneration`, then `noteHub.setSide` / `noteHub.setSize`.

- [ ] **Step 1: Write the failing tests.**
  - `session-notes.test.ts`: `'parseNotes keeps a valid side and size and drops a bad one, not the note'` (an entry with `side: 'project', size: { width: 480, height: 320 }` read back equal; `side: 'left'` → the note without `side`; `size: { width: 10, height: 10 }` → without `size`); `'sameNote tells notes apart by side and size; no side is the session side'`.
  - `sync-views.test.ts`: `'noteOf takes the side and the size of the latest write, when they are valid'`.
  - `note-hub.test.ts`: `'the side and the size are stored with the note under the conversation; a null size removes it'` (`addTab('t1', A)`, `setText('t1', 'Goal', 0)`, `setSide('t1', 'project', 0)`, `setSize('t1', { width: 480, height: 320 }, 0)` → `store.get(A)` equals `{ text: 'Goal', shown: false, form: 'card', side: 'project', size: { width: 480, height: 320 } }`; `setSize('t1', null, 0)` → `'size' in store.get(A)!` is false); `'a side or size sent against a note the tab no longer has is dropped'`.
  - `notes.spec.ts`: `'the side in front and the card size are kept with the conversation; a size out of bounds is not taken'` — `launchClaudeTab()`, `session(…, SID_A, 'startup')`, then from the page `setNoteText(id, 'Goal', 0)`, `setNoteView(id, true, 'card', 0)`, `setNoteSide(id, 'project', 0)`, `setNoteSize(id, { width: 480, height: 320 }, 0)`, `setNoteSize(id, { width: 10, height: 10 }, 0)`; `closeWindow`; `notesFile(dataDir)` equals `{ [SID_A]: { text: 'Goal', shown: true, form: 'card', side: 'project', size: { width: 480, height: 320 } } }`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/session-notes.test.ts tests/unit/sync-views.test.ts tests/unit/note-hub.test.ts` and, through the lock, `npm run build && npx playwright test tests/e2e/notes.spec.ts --workers=2 --reporter=line`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** the same, plus `npx vitest run tests/unit/sync-store-bridge.test.ts tests/unit/sync-note-flow.test.ts`, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: a session note keeps the card's side and size`).

### Task 4: the project notes file

**Files:**
- Create: `src/main/project-notes.ts`
- Test: `tests/unit/project-notes.test.ts` (new)

**Interfaces — Consumes:** `ProjectNote`, `isNoteSize`, `isProjectKey`, `MAX_NOTE_LENGTH`, `hasText` (Task 1).

**Interfaces — Produces:**

```ts
/** Reads the project notes file: valid entries by project key; null when the text is not a JSON object. */
export function parseProjectNotes(text: string): Map<string, ProjectNote> | null
export interface ProjectNotesOptions { debounceMs?: number; onError?(message: string): void; warn?(message: string): void }
/** The person's notes by project key (TabPlace.project.key): ClaudeTerm's own file, never anything in Claude Code's folders. */
export class ProjectNotes {
  readonly path: string                                   // join(dir, 'project-notes.json')
  constructor(dir: string, opts?: ProjectNotesOptions)
  get(key: string): ProjectNote | null                    // a copy
  set(key: string, note: ProjectNote | null): void        // null or a note without text removes the entry; saved after debounceMs (default 500)
  flush(): void                                           // writes now when something changed
}
```

Rules (as `SessionNotes`, without the device sync and its restore marker): an entry is kept when its key passes `isProjectKey`, its value is an object whose `text` is a string of at most `MAX_NOTE_LENGTH` with text (`trim()` not empty); a `size` that is not `isNoteSize` is left out and the entry kept. The file is written as `JSON.stringify(Object.fromEntries(notes), null, 2)` to `<path>.tmp`, then renamed over the path. A file that is not a JSON object, or cannot be read (other than missing), is renamed to `project-notes.json.corrupt-<Date.now()>` and `warn('Project notes could not be read; the file was kept as <that name>')` is called; when the rename fails, the store never writes the file this run and warns `Project notes could not be read and are not being saved this run: <path>`. A missing file is not reported.

- [ ] **Step 1: Write the failing tests** (match `tests/unit/session-notes.test.ts`'s setup: temp folders under `tmpdir()`, removed in `afterEach`): `'parseProjectNotes reads valid entries, drops the rest, and keeps a note whose size is bad without the size'` (keys `'c:\\work\\acme'` kept; `''`, a 4 097-character key, a text of `MAX_NOTE_LENGTH + 1`, `'   '`, `text: 5` dropped; `size: { width: 1, height: 1 }` → the note without `size`); `'parseProjectNotes answers null for text that is not a JSON object'` (`'{'`, `'[]'`, `'null'`); `'set and flush write the file; a new store reads it back'` (`{ text: '- [ ] Tag the release', size: { width: 600, height: 400 } }`); `'saves once after the debounce, and flush writes at once'` (`vi.useFakeTimers()`); `'a note without text is removed, not stored'`; `'a file that is not notes is moved aside when the store opens, and the user is told; it is never written over'`; `'a file that is not notes and cannot be moved aside is left as it is for the whole run, and the user is told'` (do it as the session notes test does); `'a valid file with some bad entries stays where it is'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/project-notes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/main/project-notes.ts`.
- [ ] **Step 4: Run** it and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: project notes are kept in their own file`).

### Task 5: Claude's edits in both hubs, and the merge

**Files:**
- Create: `src/main/project-note-hub.ts`
- Modify: `src/main/note-hub.ts`, `src/main/index.ts` (the `NoteHub` construction only: `publishOp: (tabId, op, generation) => send(IPC.evNoteOp, tabId, op, generation)`)
- Test: `tests/unit/project-note-hub.test.ts` (new), `tests/unit/note-hub.test.ts`, `tests/unit/sync-note-flow.test.ts` (its `new NoteHub` gets `publishOp: () => {}`)

**Interfaces — Consumes:** Task 1 (`NoteOp`, `OpResult`, `tryNoteOp`, `replayNoteOps`, `ProjectNote`, `NoteProject`, `NoteSize`), Task 4 (`ProjectNotes.get/set`), Task 2 (`IPC.evNoteOp`).

**Interfaces — Produces:**

```ts
// src/main/note-hub.ts
export interface NoteHubDeps {
  store: Pick<SessionNotes, 'get' | 'set'>
  publish(tabId: string, note: Note | null, generation: number): void
  /** one of Claude's edits of the tab's note, with the number it makes; never for the renderer's own edits */
  publishOp(tabId: string, op: NoteOp, generation: number): void
}
// NoteHub gains:
/** one of Claude's edits (add_to_note, check_note_item) of the tab's session note; null: an unknown or a remote tab */
apply(tabId: string, op: NoteOp): OpResult | null

// src/main/project-note-hub.ts
export interface ProjectNoteHubDeps {
  store: Pick<ProjectNotes, 'get' | 'set'>
  publish(key: string, note: ProjectNote | null, generation: number): void
  publishOp(key: string, op: NoteOp, generation: number): void
}
/** Each project's note, shared by every Claude tab of the project (its worktrees included). */
export class ProjectNoteHub {
  constructor(deps: ProjectNoteHubDeps)
  /** the tab's place is known: its project, or null outside git */
  place(tabId: string, project: { key: string; name: string } | null): void
  removeTab(tabId: string): void
  projectOf(tabId: string): NoteProject           // not placed yet → why 'unknown'; null → 'outside'
  get(key: string): ProjectNote | null            // null: a key no tab has brought this run
  setText(tabId: string, key: string, text: string, generation: number): void
  setSize(tabId: string, key: string, size: NoteSize | null): void
  /** one of Claude's edits of the tab's project note; null: the tab has no project */
  apply(tabId: string, op: NoteOp): OpResult | null
}
```

Rules (Decision 2 above is the authority):
- **Applying an op** (both hubs): `r = tryNoteOp(current text, op)`; when `r.ok && r.changed`: the text becomes `r.text` and is stored (`NoteHub` through `change`, so a tab without a conversation keeps it in the hub as today); the note's number goes up by one; `{ generation, op }` is kept (the last 64, `OPS_KEPT = 64`); `publishOp` sends it. Otherwise nothing changes and nothing is sent. The result is returned either way.
- **`opsSince(note, g)`**: the kept ops with a number above `g`, when they are exactly the numbers `g+1 … current`; else null.
- **`NoteHub.setText(tabId, text, g)`** in this order: `g` is the tab's number → the text replaces; `opsSince` not null → `replayNoteOps(text, ops)` replaces (nothing published: the window computes the same); else the existing `replacedFor` and `late` branches. `give()` empties the kept ops and records `givenAt = tab.generation` (the number it gave); the `late` branch's condition becomes `generation === tab.givenAt - 1`, so a text typed against the note before a conversation change still reaches the conversation it left when Claude edited the new one in between. `setView`, `setSide` and `setSize` are taken when `g` is the tab's number or `opsSince` is not null.
- **`ProjectNoteHub`**: `place` records the tab's project; the first time a key comes this run its note is loaded from the store with number 1, and `publish(key, stored or null, 1)` is sent; a key seen before sends nothing. Loaded keys stay for the run (`removeTab` forgets only the tab). `setText`/`setSize` are dropped unless the tab's project key is `key`; `setText` follows the first two rules of `NoteHub.setText` (else dropped). Every change is stored as `{ text, size? }` (`set(key, …)`; the store drops a note without text).

- [ ] **Step 1: Write the failing tests.**
  - `project-note-hub.test.ts` (a `Map` store and arrays of `publish`/`publishOp` calls, as `note-hub.test.ts` does): `'the first tab of a project gets the stored note with number 1; another tab of it, or the same place again, publishes nothing'`; `'a project with no stored note is published as null with number 1'`; `'a tab outside git, or not placed yet, has no project note'` (`projectOf` → `{ key: null, why: 'outside' }` / `'unknown'`; `apply` → `null`); `'text typed in any tab of the project is stored under its key; a text for another key is dropped'`; `'Claude's edit is applied to the current text, stored, and published as an op with the next number'` (`apply('t1', { kind: 'append', text: '- [ ] Tag the release' })` → store text `'Release\n\n- [ ] Tag the release'`, `publishOp` `[KEY, op, 2]`); `'a refused or unchanged op stores and publishes nothing'`; **`'a text typed against the number before Claude's edit keeps the edit, as the window makes it'`** (`setText(t1, KEY, 'Release', 1)`; `apply` append `'- [ ] Tag the release'`; `setText(t1, KEY, 'Release checklist', 1)` → stored text is `'Release checklist\n\n- [ ] Tag the release'` and equals `applyNoteOp('Release checklist', op)`; then `setText(t1, KEY, 'Release checklist!\n\n- [ ] Tag the release', 2)` replaces it); `'a tick Claude made stays when the person typed elsewhere at the same moment'` (text `'- [ ] Tag\n- [ ] Ship'`; `apply` check `'Ship'`; `setText(…, 'Notes\n- [ ] Tag\n- [ ] Ship', 1)` → `'Notes\n- [ ] Tag\n- [x] Ship'`); `'when the person changed the very item Claude ticked, the person's text wins'` (stale `'- [ ] Tag\n- [ ] Ship it'` → stored as typed); `'a text typed against a number older than the kept edits is dropped'` (65 appends, then a text at number 1 → unchanged); `'the size is stored with the note; null removes it'`.
  - `note-hub.test.ts` (`setup()` records `publishOp` calls too): `'Claude's edit of the session note is stored under the conversation and published as an op with the next number'`; `'Claude's edit of a tab without a conversation stays in the hub, and is stored once when the conversation comes'`; **`'a text typed against the number before Claude's edit keeps the edit, as the window makes it'`**; `'a view, a side or a size sent against the number before Claude's edit is still taken'`; `'text typed against the note before a conversation change still goes to the conversation it left, when Claude edited the new one in between'` (store `{ [B]: beta }`; `addTab('t1', A)`; `setText('t1', 'mine', 0)`; `session('t1', B)`; `apply('t1', append 'x')`; `setText('t1', 'mine more', 0)` → `store.get(A)?.text === 'mine more'`); `'a remote tab takes no edit from Claude'` (`apply` → `null`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/project-note-hub.test.ts tests/unit/note-hub.test.ts tests/unit/sync-note-flow.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** both hubs and the one line in `index.ts`.
- [ ] **Step 4: Run** the same and `npm run typecheck`. Expected: PASS, the existing `NoteHub` tests included.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: Claude's note edits merge with what the person types`).

### Task 6: project notes in main — the store, the hub, the tabs' places, IPC

**Files:**
- Modify: `src/main/index.ts`
- Test: `tests/e2e/project-notes.spec.ts` (new)

**Interfaces — Consumes:** `ProjectNotes` (Task 4), `ProjectNoteHub` (Task 5), Task 2's channels and guards (`isProjectKeyArg`, `isNoteSizeArg`, `isNoteText`, `isGeneration`, `isId`).

**Interfaces — Produces:** in `index.ts`, beside `notes` / `noteHub`: `const projectNotesStore = new ProjectNotes(dataDir, { onError: (m) => log.warn(m), warn: toast })` and `const projectNotes = new ProjectNoteHub({ store: projectNotesStore, publish: (key, note, generation) => send(IPC.evProjectNote, key, note, generation), publishOp: (key, op, generation) => send(IPC.evProjectNoteOp, key, op, generation) })`. Task 7 uses `projectNotes` and `noteHub`.

Wiring:
- `TabPlaces`' `publish`: after `tabPlaces.set(id, place)` and **before** `send(IPC.evTabPlace, id, place)` (so a project's note reaches the window before the window learns the tab's project), for a Claude tab (`tabs.get(id)?.kind === 'claude'`): `projectNotes.place(id, place ? { key: place.project.key, name: place.project.name } : null)`.
- `onTabClosed`: `projectNotes.removeTab(tabId)`.
- `projectNotesStore.flush()` wherever `notes.flush()` is called (window `close`, quit, `beforeInstall`).
- `ipcMain.on(IPC.projectNotesSetText, (_e, id, key, text, generation) => …)` with `isId`, `isProjectKeyArg`, `isNoteText`, `isGeneration` → `projectNotes.setText`; `ipcMain.on(IPC.projectNotesSetSize, (_e, id, key, size) => …)` with `isId`, `isProjectKeyArg`, `isNoteSizeArg` → `projectNotes.setSize`.

- [ ] **Step 1: Write the failing e2e tests** (`closeWindow` and `synced` as in `notes.spec.ts`; a Claude tab is opened from the page with `window.ct.openTab({ kind: 'claude', cwd })` after `launchApp({ settings: FAKE_CLAUDE_SETTINGS })` and its first tab; the project key is read with `window.__ct!.placeOf!(id)?.project.key`; the file is `join(dataDir, 'project-notes.json')`):
  - `'the first Claude tab of a project gets its project note with number 1; a tab outside git gets none'` (record `ct.onProjectNote` before opening the tab in `gitRepo()` → `[[key, null, 1]]`; a tab in a plain temp folder: once `placeOf` is `null`, nothing more recorded).
  - `'a project note typed in one tab is stored under the project key, and a tab in a linked worktree writes the same note'` (tab 1 in `repo`, tab 2 in `gitWorktree(repo, 'feature')`, both keys equal; `setProjectNoteText(tab1, key, 'Release checklist', 1)`, `setProjectNoteText(tab2, key, 'Release checklist\n- [ ] Tag', 1)`, `synced`, `closeWindow` → the file equals `{ [key]: { text: 'Release checklist\n- [ ] Tag' } }`).
  - `'the project note's size is kept with it'` (`setProjectNoteSize(tab, key, { width: 600, height: 400 })` after a text → the entry has that `size`).
  - `'a text sent for another key, or from a tab outside git, is not kept'` (no `project-notes.json` after close).
- [ ] **Step 2: Run** through the lock `npm run build && npx playwright test tests/e2e/project-notes.spec.ts --workers=2 --reporter=line`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** it, plus `tests/e2e/notes.spec.ts` in the same locked command, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: every Claude tab of a project shares its project note`).

### Task 7: the notes over the pipe — messages and main's replies

**Files:**
- Modify: `src/shared/protocol.ts`, `src/main/pipe-server.ts`, `src/main/index.ts` (three pipe handlers), `tests/integration/pipe.test.ts`, `tests/integration/session-hook.int.test.ts`, `tests/integration/mcp.int.test.ts` (handler fills only: `noteRead`/`noteAdd`/`noteCheck: () => ({ ok: true })`)
- Create: `src/main/note-replies.ts`
- Test: `tests/unit/protocol.test.ts`, `tests/unit/note-replies.test.ts` (new), `tests/e2e/note-tools.spec.ts` (new)

**Interfaces — Consumes:** `NoteHub.get/apply`, `ProjectNoteHub.projectOf/get/apply` (Task 5), `noteItems`, `OpResult`, `NOTE_SIDES`, `NOTE_ADD_MAX`, `NOTE_ITEM_MAX`, `MAX_NOTE_LENGTH`, `hasText` (Task 1), `noteHub` and `projectNotes` in `index.ts` (Task 6).

**Interfaces — Produces:**

```ts
// src/shared/protocol.ts — in PipeMessage
/** read_notes from the MCP server: both notes of the tab, as text */
export interface NoteReadMessage { v: 1; type: 'note_read'; tabId: string }
/** add_to_note from the MCP server: text added at the end of one of the tab's notes */
export interface NoteAddMessage { v: 1; type: 'note_add'; tabId: string; note: NoteSide; text: string }
/** check_note_item from the MCP server: one checkbox item of one of the tab's notes ticked or unticked */
export interface NoteCheckMessage { v: 1; type: 'note_check'; tabId: string; note: NoteSide; item: string; checked: boolean }
// src/main/pipe-server.ts — PipeHandlers gains noteRead(msg: NoteReadMessage): PipeResponse; noteAdd(msg: NoteAddMessage): PipeResponse; noteCheck(msg: NoteCheckMessage): PipeResponse
// src/main/note-replies.ts
export interface NoteReplyDeps {
  isClaudeTab(tabId: string): boolean
  session: Pick<NoteHub, 'get' | 'apply'>
  project: Pick<ProjectNoteHub, 'projectOf' | 'get' | 'apply'>
}
export function readNotesReply(deps: NoteReplyDeps, msg: NoteReadMessage): PipeResponse
export function addToNoteReply(deps: NoteReplyDeps, msg: NoteAddMessage): PipeResponse
export function checkNoteItemReply(deps: NoteReplyDeps, msg: NoteCheckMessage): PipeResponse
```

Parse rules: `tabId` a UUID (`'tabId must be a UUID'`); `note` one of `NOTE_SIDES` (`'note must be "session" or "project"'`); `text` a string of 1–10 000 (`'text must be 1 to 10000 characters'`); `item` 1–2 000 (`'item must be 1 to 2000 characters'`); `checked` a boolean (`'checked must be a boolean'`).

Replies (exact; `<name>` is the project's name; "the note" below reads `the session note` or `the project note (<name>)`):
- Not a Claude tab: `{ ok: false, error: '<tool> works only in a ClaudeTerm Claude tab' }`, `<tool>` = `read_notes`, `add_to_note`, `check_note_item`.
- `read_notes`: `{ ok: true, info }`, info = `'## Session note\n' + (session text with text, else '(empty)') + '\n\n' + project part`. Project part: `'## Project note (<name>)\n' + (text or '(empty)')`; outside git `'## Project note\n(none: this tab\'s folder is not in a git repository)'`; not known yet `'## Project note\n(none yet: ClaudeTerm has not found this tab\'s project; try again in a moment)'`.
- No project for `add_to_note` / `check_note_item` with `note: 'project'`: `This tab has no project note: its folder is not in a git repository. Nothing was added.` / `ClaudeTerm has not found this tab's project yet; try again in a moment. Nothing was added.` (`… Nothing was changed.` for `check_note_item`).
- `add_to_note`: ok → `Added to the note.` (`Added to the session note.`, `Added to the project note (acme).`); `empty` → `The text is empty. Nothing was added.`; `too-long` → `The text would make the note longer than 100000 characters (it has <current length>, the text adds <adds>). Nothing was added.`
- `check_note_item` (`<item>` = `msg.item.trim()`): changed → `Ticked "<item>" in the note.` / `Unticked "<item>" in the note.`; unchanged → `"<item>" is already ticked in the note.` / `… already unticked …`; `no-match` → `No item "<item>" in the note. Its items:\n<list>`, or, when the note has no items, `The session note has no checkbox items.` / `The project note (<name>) has no checkbox items.`; `ambiguous` → `<n> items in the note read "<item>"; nothing was changed. Its items:\n<list>`. `<list>`: one line per item, `- [ ] <text>` or `- [x] <text>`, at most 50, then `… and <k> more`.
- `index.ts`: `noteRead`/`noteAdd`/`noteCheck` call the three functions with `{ isClaudeTab, session: noteHub, project: projectNotes }`; after `noteAdd` and `noteCheck`, `remote?.host.changed()` (the members' "has a note" flag, as `notesSetText` does).

- [ ] **Step 1: Write the failing tests.**
  - `protocol.test.ts`: `'accepts note_read, note_add and note_check'`; `'refuses a note_add with another note name, an empty text or one over 10000 characters'`; `'refuses a note_check whose checked is not a boolean, or whose item is over 2000 characters'` (exact errors above).
  - `note-replies.test.ts` (real `NoteHub` and `ProjectNoteHub` over `Map` stores; `isClaudeTab: (id) => id === TAB`): `'read gives both notes under their names; an empty note reads (empty)'`; `'read says why a tab has no project: outside git, or not found yet'`; `'add names the note it added to; an empty text, a text past the limit and a missing project are refused, nothing added'`; `'check ticks and unticks, and says when the item already was'`; `'check lists the items when none or several match, at most 50'`; `'a tab that is not a Claude tab is refused by each tool'`.
  - `tests/e2e/note-tools.spec.ts` (`launchClaudeTab`; `pipe = (m) => sendPipeMessage(pipeName, m)`; `closeWindow`, `synced`, `session` as in `notes.spec.ts`):
    - `'note_add adds to the session note after a blank line; the window gets it as an op with the next number; the file keeps it'` (`session(SID_A)`; record `ct.onNoteOp`; `setNoteText(id, 'Goal: payments', 0)`; `note_add` session `'- [ ] Write the tests'` → `{ ok: true, info: 'Added to the session note.' }`; recorded `[[id, { kind: 'append', text: '- [ ] Write the tests' }, 1]]`; after close the file's text is `'Goal: payments\n\n- [ ] Write the tests'`).
    - `'note_read answers both notes; a tab outside git has no project note, and says why'` (`setNoteText(id, 'Goal: payments', 0)`; poll `note_read` until its info ends with `(none: this tab's folder is not in a git repository)`; then equal to `'## Session note\nGoal: payments\n\n## Project note\n(none: this tab\'s folder is not in a git repository)'`).
    - `'note_add and note_check on the project note of a git tab'` (`launchClaudeTab(FAKE_CLAUDE_SETTINGS, gitRepo())`; poll until `note_read` names `## Project note (<basename(repo)>)`; add `'- [ ] Tag the release\n- [ ] Write the changelog'`; check `'Tag the release'` true → `Ticked "Tag the release" in the project note (<name>).`; read shows `- [x] Tag the release`).
    - `'note_check with no match lists the items and changes nothing'` (`setNoteText(id, '- [ ] Tag the release\n- [ ] Write the changelog', 0)`; check session `'Publish'` → `{ ok: false, error: 'No item "Publish" in the session note. Its items:\n- [ ] Tag the release\n- [ ] Write the changelog' }`; `note_read`'s session part unchanged).
    - `'add_to_note refuses text that would pass the limit, and adds nothing'` (`setNoteText(id, 'x'.repeat(MAX_NOTE_LENGTH - 5), 0)`; add `'abcdef'` → `{ ok: false, error: 'The text would make the session note longer than 100000 characters (it has 99995, the text adds 8). Nothing was added.' }`).
    - **`'a text typed before Claude's edit reached the window keeps Claude's edit'`** (git tab; `key` from `placeOf`; `setProjectNoteText(id, key, 'Release', 1)`; `note_add` project `'- [ ] Tag the release'`; then `setProjectNoteText(id, key, 'Release checklist', 1)`; `synced`; `note_read`'s project part is `'Release checklist\n\n- [ ] Tag the release'`; after close the file holds that text).
    - `'Claude's addition to a tab without a conversation is stored once the conversation starts'` (no `session` first; `note_add` session `'kept'`; then `session(SID_A)`; after close `{ [SID_A]: { text: 'kept', shown: false, form: 'card' } }`).
    - `'an unknown tab is refused'` (`note_read` with a fresh UUID → `{ ok: false, error: 'read_notes works only in a ClaudeTerm Claude tab' }`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/protocol.test.ts tests/unit/note-replies.test.ts` and through the lock `npm run build && npx playwright test tests/e2e/note-tools.spec.ts --workers=2 --reporter=line`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** the same, plus `npx vitest run tests/integration/pipe.test.ts tests/integration/session-hook.int.test.ts tests/integration/mcp.int.test.ts`, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: ClaudeTerm reads, adds to and ticks a tab's notes over the pipe`).

### Task 8: the MCP tools

**Files:**
- Create: `src/mcp/note-tools.ts`
- Modify: `src/mcp/show-image-server.ts` (import; `instructions: `${AGENT_INSTRUCTIONS}\n\n${NOTE_INSTRUCTIONS}``; `registerNoteTools(server)` before `server.connect`), `tests/integration/mcp.int.test.ts`
- Test: `tests/unit/note-tools.test.ts` (new), `tests/integration/mcp.int.test.ts`

**Interfaces — Consumes:** Task 7's messages; `sendPipeMessage`, `PipeUnavailableError`, `defaultPipeName`, `isUuid`; `ToolResult` (`src/mcp/show-image-tool.ts`); `NOTE_ADD_MAX`, `NOTE_ITEM_MAX`, `NoteSide`.

**Interfaces — Produces:**

```ts
export interface NoteToolDeps { tabId: string | null; pipeName: string; send(pipeName: string, msg: NoteReadMessage | NoteAddMessage | NoteCheckMessage): Promise<PipeResponse> }
export async function handleReadNotes(deps: NoteToolDeps): Promise<ToolResult>
export async function handleAddToNote(input: { note: NoteSide; text: string }, deps: NoteToolDeps): Promise<ToolResult>
export async function handleCheckNoteItem(input: { note: NoteSide; item: string; checked: boolean }, deps: NoteToolDeps): Promise<ToolResult>
export const NOTE_INSTRUCTIONS: string
/** registers read_notes, add_to_note and check_note_item; each call reads CLAUDETERM_TAB_ID and CLAUDETERM_PIPE as the other tools do, with a 3000 ms pipe timeout */
export function registerNoteTools(server: McpServer): void
```

Copy (exact):
- `read_notes` — title `Read the notes in ClaudeTerm`; description `Read the person's two notes for this tab in ClaudeTerm, as Markdown: the session note, kept with this conversation, and the project note, shared by every Claude tab of the same git project (its worktrees included). Checkbox items read "- [ ] text" (open) and "- [x] text" (ticked).`; no input.
- `add_to_note` — title `Add to a note in ClaudeTerm`; description `Add text at the end of the session note or the project note in ClaudeTerm, after a blank line. Use it for what the person should not lose: a TODO you found, a decision, how to reach something. The text may hold checkbox items ("- [ ] text") and bullets ("- text"). Nothing already in the note changes.`; input `note: z.enum(['session', 'project']).describe('session: the note of this conversation; project: the note shared by every Claude tab of this git project')`, `text: z.string().describe('The Markdown text to add, at most 10000 characters')`.
- `check_note_item` — title `Tick a note item in ClaudeTerm`; description `Tick (checked: true) or untick (checked: false) a checkbox item of the session note or the project note in ClaudeTerm, named by its text as read_notes shows it after "- [ ] " or "- [x] ". Use it when you finished an item.`; input `note` (as above), `item: z.string().describe("The item's text, exactly as in the note")`, `checked: z.boolean().describe('true ticks the item, false unticks it')`.
- `NOTE_INSTRUCTIONS`: `ClaudeTerm keeps two notes for this tab, written by the person: the session note, kept with this conversation, and the project note, shared by every Claude tab of the same git project. They are the person's. Read them with read_notes when your work needs their context, add what the person should not lose with add_to_note, and tick the items you finished with check_note_item. You cannot remove or rewrite their text, and should not try.`
- Results: no tab → `<tool> works only in a ClaudeTerm Claude tab` (error); add: blank text → `The text is empty. Nothing was added.`, over 10 000 → `The text is longer than 10000 characters; add it in parts.`; check: blank item → `The item is empty.`, over 2 000 → `The item is longer than 2000 characters.` (all errors, nothing sent); `PipeUnavailableError` → `ClaudeTerm is not running; the notes cannot be read.` / `ClaudeTerm is not running; nothing was added.` / `ClaudeTerm is not running; nothing was changed.` (errors); another failure → `ClaudeTerm request failed: <message>`; `{ ok: true, info }` → `{ text: info, isError: false }`; `{ ok: false, error }` → `{ text: error, isError: true }`.

- [ ] **Step 1: Write the failing tests.** `tests/unit/note-tools.test.ts` (as `task-list-tool.test.ts`): `'each tool needs a ClaudeTerm Claude tab and sends nothing'`; `'add_to_note refuses an empty text or one over 10000 characters without sending'`; `'check_note_item refuses an empty item or one over 2000 characters without sending'`; `'each tool sends its message and answers what ClaudeTerm says'` (`{ v: 1, type: 'note_add', tabId: TAB, note: 'project', text: '- [ ] Tag' }` …); `'an error from ClaudeTerm is an error result'`; `'ClaudeTerm not running is said, as an error'`. `mcp.int.test.ts`: the tool list in `'lists the tool and forwards a call to ClaudeTerm'` becomes `['add_to_note', 'check_note_item', 'device_status', 'get_task_list', 'list_agents', 'message_agent', 'open_device_settings', 'read_notes', 'set_task_list', 'show_diff', 'show_document', 'show_image']` and the instructions also contain `read_notes`, `add_to_note`, `check_note_item`; new `'forwards read_notes, add_to_note and check_note_item to ClaudeTerm and answers what it says'` (the handlers record the messages and answer an `info`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/note-tools.test.ts tests/integration/mcp.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** the same and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: Claude reads the notes, adds to them and ticks items`).

---

## Stream R (renderer)

### Task 9: the note editor — CodeMirror, checkboxes and bullets

**Files:**
- Create: `src/renderer/note-commands.ts`, `src/renderer/note-editor.ts`
- Modify: `src/renderer/note-overlay.ts` (the `<textarea>` becomes a `NoteEditor`; a toolbar at the card's foot), `src/renderer/main.ts`, `src/renderer/env.d.ts`, `src/renderer/styles.css`, `tests/e2e/helpers.ts`, the note assertions of `tests/e2e/note-overlay.spec.ts`, `change-folder.spec.ts`, `chat-cards.spec.ts`, `forks.spec.ts`, `remote-tabs.spec.ts`, `tab-panel.spec.ts`
- Test: `tests/unit/note-commands.test.ts` (new), `tests/e2e/note-editor.spec.ts` (new)

**Interfaces — Consumes:** `parseLine`, `diffText` (Task 1); `MAX_NOTE_LENGTH`; `mapKey` (`./keymap`).

**Interfaces — Produces:**

```ts
// src/renderer/note-commands.ts — @codemirror/state only (no DOM): unit-tested in node
export const toggleCheckbox: StateCommand   // the Checkbox button
export const toggleBullet: StateCommand     // the List button
export const continueList: StateCommand     // Enter
export const tickAtCaret: StateCommand      // Ctrl+Enter
export function tickLineAt(state: EditorState, pos: number): TransactionSpec | null   // a click on the box of the line at pos
// src/renderer/note-editor.ts
export interface NoteEditorOptions {
  /** a change the person made: the whole text */
  changed(text: string): void
  /** a keydown before the editor's own keys; true when it was handled (Escape, the note shortcut) */
  key(e: KeyboardEvent): boolean
}
export class NoteEditor {
  readonly dom: HTMLElement
  constructor(opts: NoteEditorOptions)
  get text(): string
  /** another note: its text, a new history, the placeholder */
  load(text: string, placeholder: string): void
  /** a change from main to the note shown (one of Claude's edits): the one change diffText gives, applied with addToHistory false; caret, selection and history kept; not reported to changed() */
  update(text: string): void
  toggleCheckbox(): void
  toggleBullet(): void
  /** the keyboard in the editor, the caret at the end */
  focus(): void
}
// NoteOverlay gains: editorText(): string — the editor's text: the note of the tab in front, kept while the card is hidden, as the textarea's value was
// CtTestHook (env.d.ts) gains: noteText?(): string — the text in the note's editor (test runs)
// tests/e2e/helpers.ts gains: export const noteText = (page: Page): Promise<string> => page.evaluate(() => window.__ct!.noteText!())
```

Rules:
- **Commands** (on the lines the selection touches; a range ending at a line's start leaves that line out): `toggleCheckbox` — every touched non-blank line an item → each loses its `- [ ] `/`- [x] ` (indent kept); else each plain line gets `- [ ] ` after its indent, each bullet's `- ` becomes `- [ ] `, items stay; blank lines are left, except a single touched blank line, which becomes `- [ ] `. `toggleBullet` — the same with `- ` (an item's marker becomes `- `). `continueList` — one empty selection in an item or bullet line at or after its `textStart`: the line's text empty → the marker goes (the line becomes empty); else a newline, the same indent and `- [ ] ` (or `- `) are inserted at the caret, the caret after them; anywhere else → `false`. `tickAtCaret` — the main caret's line is an item → its box flips (`x`/`X` → ` `, ` ` → `x`), `true`; else `false`. Each sets `userEvent` (`input`, `input.tick`) and keeps the caret with its text.
- **The editor's extensions:** `history()`; `Prec.highest(EditorView.domEventHandlers({ keydown: (e) => opts.key(e) }))`; `Prec.high(keymap.of([{ key: 'Enter', run: continueList }, { key: 'Mod-Enter', run: tickAtCaret }, { key: 'Ctrl-Enter', run: tickAtCaret }]))`; `keymap.of([...defaultKeymap, ...historyKeymap])`; `EditorView.lineWrapping`; `EditorView.contentAttributes.of({ class: 'note-text', spellcheck: 'false', 'aria-label': 'Note' })`; `placeholder(text)`; a `ViewPlugin` building the decorations of the visible lines with `parseLine`: an item gets `Decoration.line({ class: 'note-item' })` (`'note-item note-item-done'` when ticked) and `Decoration.replace({ widget })` over `[indent, textStart)` with a `<input type="checkbox" class="note-check" tabindex="-1">` (`checked` when ticked; `mousedown` → `preventDefault()` and `view.dispatch(tickLineAt(view.state, view.posAtDOM(input)))`; `ignoreEvent()` true), a bullet gets `Decoration.replace` over its `- ` with `<span class="note-bullet">•</span>`; `EditorView.atomicRanges` over those replacements; `EditorView.inputHandler`: a space typed where the line before the caret is `/^[ \t]*\[ ?\]$/` (`[ ]` or `[]`) replaces that bracket with `- [ ] `; `EditorState.changeFilter` refusing a change of the person's that makes the text longer than `MAX_NOTE_LENGTH`; `EditorView.updateListener` calling `changed` for doc changes not annotated as main's (a module `Annotation<boolean>`).
- **NoteOverlay:** the editor sits in `.note-body`; `.note-foot` holds `<button class="note-tool" data-tool="checkbox">Checkbox</button>` (title `Turn the line into a checkbox item, or back (or type [ ] at its start)`) and `<button class="note-tool" data-tool="list">List</button>` (title `Turn the line into a bullet item, or back`); a `mousedown` on them is `preventDefault()`ed (the editor keeps the caret). `key(e)`: Escape → `focusTerminal()`, the note shortcut (`mapKey(e, platform)?.type === 'toggleNote'`) → `toggle()`; both `preventDefault()` and return true. `draw()` loads the note's text only when it differs from the editor's (`load(text, 'Write a note for this session…')`), whether the card shows or not, as it set the textarea's value. Everything else (label, collapse, hide, toggle, show) stays.
- **`src/renderer/main.ts`:** the document `keydown` handler returns early, as for a `TEXTAREA`, when `target?.closest('#note .cm-content')`; `activate()`'s `busy` also counts `document.activeElement?.closest('#note .cm-content')`; the test hook gets `noteText: () => noteOverlay.editorText()`.
- **CSS** (the `#note` block of `styles.css`): `.note-body { flex: 1 1 auto; min-height: 4.5em; overflow: auto }`; `.note-body .cm-editor { height: 100% }`, `.cm-focused { outline: none }`, `.cm-scroller { font-family: inherit; line-height: 1.45 }`, `.cm-content { padding: 8px 10px; caret-color: var(--text) }`, `.cm-placeholder { color: var(--text-3) }`; `.note-check { width: 13px; height: 13px; margin: 0 6px 0 0; vertical-align: -2px; accent-color: var(--accent); cursor: pointer }`; `.note-item-done { color: var(--text-3); text-decoration: line-through }`; `.note-bullet { display: inline-block; width: 14px; color: var(--text-3) }`; `.note-foot { display: flex; gap: 4px; padding: 3px 6px; border-top: 1px solid var(--line-2) }`; `.note-tool { height: 22px; padding: 0 8px; background: none; border: 0; border-radius: 6px; color: var(--text-3); font-size: 11.5px; cursor: pointer }`, `.note-tool:hover { background: var(--raised-2); color: var(--text) }`. The old `.note-text` textarea rule goes.
- **Existing e2e assertions:** each `expect(<locator of .note-text>).toHaveValue(v[, opts])` becomes `expect.poll(() => noteText(page)[, opts]).toBe(v)` (`b.page` in `remote-tabs.spec.ts`); `toHaveAttribute('placeholder', 'Write a note for this session…')` becomes `expect(card.locator('.cm-placeholder')).toHaveText('Write a note for this session…')`. `toBeFocused()`, `click()` and `fill()` on `.note-text` stay (it is the editor's content now); if `fill` does not reach the editor, use `ControlOrMeta+KeyA` and `Delete`. Nothing else in those specs changes.

- [ ] **Step 1: Write the failing tests.**
  - `tests/unit/note-commands.test.ts` (an `EditorState` with `history()`; `run(cmd, doc, anchor, head?)` returns the new doc and caret, or null when the command answers false; `|` below marks the caret): `'toggleCheckbox turns a plain line into an item keeping its indent, and an item back'` (`'  Write'` → `'  - [ ] Write'`; `'- [x] Done'` → `'Done'`); `'toggleCheckbox turns a bullet into an item, and an empty line into an empty item'`; `'toggleCheckbox on several lines: all become items unless all are, blank lines left'` (`'a\n\nb'` all selected → `'- [ ] a\n\n- [ ] b'` and back); `'toggleBullet does the same for bullets and turns an item into a bullet'`; `'continueList at the end of an item starts a new unticked item with its indent; inside, it splits the text'` (`'  - [x] one|'` → `'  - [x] one\n  - [ ] |'`; `'- [ ] on|e'` → `'- [ ] on\n- [ ] e'`); `'continueList on an empty item or bullet ends the list; elsewhere it answers false'`; `'tickAtCaret ticks and unticks the item under the caret; [X] counts as ticked; elsewhere false'`; `'tickLineAt flips the box of the line at a position'`; `'undo after a toggle brings the text back'`.
  - `tests/e2e/note-editor.spec.ts` (`launchClaudeTab`; open the card with `#sheet-header .tab-note-toggle`; `noteText` from helpers; `card = #note .note-card`):
    - `'Checkbox turns the line into an item shown as a box, a click ticks it, and a ticked item is dimmed and struck through'` (type `Write the tests`; click `.note-tool[data-tool="checkbox"]` → `noteText` `'- [ ] Write the tests'`, one `.note-check`, the line's text `Write the tests`; click `.note-check` → `'- [x] Write the tests'`, `.cm-line.note-item-done` has `text-decoration-line` `line-through` and a colour other than a plain line's; Checkbox again → `'Write the tests'`).
    - `'typing [ ] or [] at the start of a line makes an item; Enter goes on with the list, and Enter on an empty item ends it'` (`[ ] one`, Enter, `two`, Enter, Enter, `[] three` → `'- [ ] one\n- [ ] two\n- [ ] three'`).
    - `'Ctrl+Enter ticks the item under the caret; undo and redo work across it'` (`ControlOrMeta+Enter` → `'- [x] one'`; `ControlOrMeta+KeyZ` → `'- [ ] one'`; `ControlOrMeta+Shift+KeyZ` → `'- [x] one'`).
    - `'List makes bullets shown with a dot; List again turns them back'` (`.note-bullet` visible; `'- a'` → `'a'`).
    - `'several selected lines become items at once, and back'`.
    - `'text typed through an input method goes in as typed'` (`page.keyboard.insertText('メモ: テスト')` → in `noteText`).
    - `'copy carries the Markdown, and pasted Markdown shows its boxes'` with `{ tag: '@alone' }` inside `keepingClipboard` (select all, `ControlOrMeta+KeyC` → the clipboard reads `- [ ] Write the tests`; write `- [x] Done` to the clipboard, paste on a new line → a checked `.note-check`).
    - `'what is typed is kept with the conversation as Markdown'` (session message, Checkbox on `Write the tests`, close → `session-notes.json` text `'- [ ] Write the tests'`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/note-commands.test.ts` and through the lock `npm run build && node scripts/e2e.mjs tests/e2e/note-editor.spec.ts --reporter=line`. Expected: FAIL.
- [ ] **Step 3: Implement** it, and change the existing assertions as the Rules say.
- [ ] **Step 4: Run** the same, then through the lock `npm run build && npx playwright test tests/e2e/note-overlay.spec.ts tests/e2e/notes.spec.ts tests/e2e/change-folder.spec.ts tests/e2e/chat-cards.spec.ts tests/e2e/forks.spec.ts tests/e2e/tab-panel.spec.ts tests/e2e/remote-tabs.spec.ts --workers=2 --reporter=line`, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: the note is a small editor with checkboxes and bullets`).

### Task 10: the card — Session | Project, counts, the label, Claude's edits live

**Files:**
- Modify: `src/renderer/note-overlay.ts`, `src/renderer/main.ts`, `src/renderer/styles.css`, `tests/e2e/note-overlay.spec.ts` (the `.note-title` line)
- Test: `tests/e2e/project-notes-card.spec.ts` (new)

**Interfaces — Consumes:** Task 1 (`NoteSide`, `ProjectNote`, `NoteProject`, `noteProjectOf`, `NoteOp`, `applyNoteOp`, `itemCount`, `noteLabel`), Task 2 (`setNoteSide`, `setProjectNoteText`, `onNoteOp`, `onProjectNote`, `onProjectNoteOp`), Task 9 (`NoteEditor`), main's events (Tasks 5–6) and pipe messages (Task 7) in the e2e.

**Interfaces — Produces:**

```ts
// NoteOverlayCallbacks gains
setSide(tabId: string, side: NoteSide, generation: number): void
setProjectText(tabId: string, key: string, text: string, generation: number): void
projectOf(tabId: string): NoteProject
// NoteOverlay gains
applyOp(tabId: string, op: NoteOp, generation: number): void            // Claude's edit of a session note
setProjectNote(key: string, note: ProjectNote | null, generation: number): void   // ignored when the window has that key at that number or later
applyProjectOp(key: string, op: NoteOp, generation: number): void
placeChanged(tabId: string): void                                         // the tab's project may have changed: redraw when it is in front
```

Rules:
- The window keeps project notes by key (`{ text, size?, generation }`), for the run. The side in front is the session note's `side` when it is `'project'` and `projectOf(tab).key` is not null; else `'session'`.
- **Head:** the icon, then `.note-switch` with `<button class="note-side" data-side="session">Session<span class="note-side-count"></span></button>` and the same for `project` (`Project`), then collapse and hide. The side in front has class `active` and `aria-pressed="true"`. A count shows `<ticked>/<all>` of that side's note (`itemCount`), `hidden` when it has no items. Titles: session `Session note: kept with this conversation`; project `Project note: <name>, shared by the Claude tabs of this project`. A Project side without a project has `aria-disabled="true"`, does nothing on click, and its title says why: `No project note: this folder is not in a git repository` (outside), `No project note: this tab runs on another device` (remote), `No project note yet: looking for this tab's project` (unknown). A click on the other side: the session note's `side` changes, `setSide` is sent, the editor loads that note (placeholder `Write a note for this project…` for the project) and keeps the keyboard if it had it.
- **The note in front decides** the label (`noteLabel`: `.note-label-count` with the count, hidden without one, and `.note-label-text`), whether collapse has a label to collapse to, whether toggle opens an empty card to write in, and whether a shown empty note goes once its tab is left. The tab mark stays the session note's (`hasText`).
- **Typing** on the project side updates the window's project note and sends `setProjectText(tab, key, text, its generation)`.
- **The editor reloads** only when the tab, the side or the note's text differs from what it shows (`load`); `applyOp` / `applyProjectOp` set the stored text to `applyNoteOp(text, op)` and the number, and when that note is the one in the editor (the tab in front, its side in front; the card open or not), call `editor.update(newText)` (the caret stays); a project note the window has not got yet counts as empty at number 0; the label and the counts follow in every case; `applyOp` calls `changed()` when the session note got or lost its text.
- **`src/renderer/main.ts`:** the new callbacks (`ct.setNoteSide`, `ct.setProjectNoteText`, `projectOf: (id) => noteProjectOf(tabs.get(id)?.info.remote !== undefined, places.get(id))`); `ct.onNoteOp` → `applyOp` then `renderTabs()`; `ct.onProjectNote` → `setProjectNote`; `ct.onProjectNoteOp` → `applyProjectOp`; `ct.onTabPlace` also calls `noteOverlay.placeChanged(id)`.
- **CSS:** `.note-switch { display: inline-flex; flex: 1; min-width: 0 }` holding the buttons in a box with `border: 1px solid var(--line-2); border-radius: 7px; padding: 1px`; `.note-side { height: 22px; padding: 0 8px; border-radius: 5px; background: none; border: 0; color: var(--text-3); font-size: 11.5px; cursor: pointer }`, `.note-side.active { background: var(--raised-2); color: var(--text) }`, `.note-side[aria-disabled="true"] { opacity: 0.45; cursor: default }`; `.note-side-count, .note-label-count { margin-left: 5px; color: var(--text-3); font-size: 10.5px; font-variant-numeric: tabular-nums }`. Replace `.note-title`.
- `note-overlay.spec.ts`: `expect(card.locator('.note-title')).toHaveText('Note')` becomes `expect(card.locator('.note-side[data-side="session"]')).toHaveClass(/active/)`.

- [ ] **Step 1: Write the failing e2e tests** (`launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)` with `repo = gitRepo()` unless said; `side(name) = card.locator('.note-side[data-side="<name>"]')`; wait for the project with `expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id)?.project.key ?? null, tab)).not.toBeNull()`; pipe messages as in Task 7):
  - `'the switch shows Session and Project with their counts, and the card opens on the side it was last on'` (Project → type two items with Checkbox and tick one → the Project count `1/2`, Session's count hidden; hide with `.note-hide`; the Note button → Project is `active`, `noteText` is the project note).
  - `'two tabs of one project, one in a linked worktree, share the project note'` (type `Release checklist` on tab 1's Project side; a tab in `gitWorktree(repo, 'feature')`; its card's Project side → `noteText` `'Release checklist'`; typing there shows in tab 1; a `note_add` project `- [ ] Tag` sent for tab 2 shows in tab 1's open card).
  - `'the project note comes back after a restart'` (type on the Project side; `closeWindow`; `launchApp({ dataDir, settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', repo] })`; card → Project → `noteText`).
  - `'a tab outside git has the Project side disabled, with the reason as its tooltip'` (`aria-disabled` `true`, title `No project note: this folder is not in a git repository`; a click leaves Session `active`).
  - `'collapsed, the label shows the count and the first unticked item of the note in front'` (`- [x] Tag the release\n- [ ] Write the changelog` on the Project side, collapse → `.note-label-count` `1/2`, `.note-label-text` `Write the changelog`).
  - `'Claude's edit shows in the open card at once; the caret stays and what is typed next goes where it was'` (session message; card open, type `abc`; `note_add` session `- [ ] from Claude` → `noteText` `'abc\n\n- [ ] from Claude'`; type `def` → `'abcdef\n\n- [ ] from Claude'`).
  - `'while the card shows the other note, or is collapsed, Claude's tick moves the count'` (Session in front: `note_check` on the project note → Project's count changes; collapse with the project in front: `note_check` → `.note-label-count` changes).
- [ ] **Step 2: Run** through the lock `npm run build && npx playwright test tests/e2e/project-notes-card.spec.ts --workers=2 --reporter=line`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, plus `tests/e2e/note-overlay.spec.ts tests/e2e/note-editor.spec.ts` in the same locked command (the `@alone` test as in Task 9), and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: the note card switches between the session note and the project note`).

### Task 11: resizing the card

**Files:**
- Modify: `src/renderer/note-overlay.ts`, `src/renderer/main.ts` (two callbacks), `src/renderer/styles.css`
- Test: `tests/e2e/note-size.spec.ts` (new)

**Interfaces — Consumes:** `NOTE_SIZE`, `MIN_NOTE_SIZE`, `MAX_NOTE_SIZE`, `NoteSize` (Task 1); `ct.setNoteSize`, `ct.setProjectNoteSize` (Task 2); Task 10's overlay.

**Interfaces — Produces:** `NoteOverlayCallbacks` gains `setSize(tabId: string, size: NoteSize | null, generation: number): void` and `setProjectSize(tabId: string, key: string, size: NoteSize | null): void` (`main.ts`: `ct.setNoteSize`, `ct.setProjectNoteSize`).

Rules:
- `.note-grip` (title `Drag to resize; double-click for the default size`) in the card's bottom-left corner. Dragging it (pointer capture) changes the size of the note in front live: width = start width + (start x − x), height = start height + (y − start y), each rounded and kept within `MIN_NOTE_SIZE` and the room (Decision 1: max width = the card's right edge − (the area's left edge + 10); max height = (the area's bottom − 10) − the card's top; the area is `#terminals`); never below the minimum unless the room is smaller. On release, the size goes to that note (`setSize` for the session note with its number, `setProjectSize` for the project note) and the window keeps it. A double click sets that note's size to null (the default).
- The card is drawn with the size of the note in front (`size ?? NOTE_SIZE`), clamped the same way, again when the window or the area resizes (a `ResizeObserver` on `#terminals`) and when Find opens or closes.
- CSS: `.note-card { position: relative }` with the width and height set inline; `#note` loses `max-height: 40%`; `.note-grip { position: absolute; left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; touch-action: none }` with two short diagonal lines in `var(--text-3)` (a `linear-gradient`), brighter on hover.

- [ ] **Step 1: Write the failing e2e tests** (`dragGrip(page, dx, dy)`: mouse down at the grip's centre, move by `(dx, dy)` in 5 steps, up; `box = card.boundingBox()`, compared after `Math.round`):
  - `'dragging the grip left and down makes the card bigger, and the size is kept with the session note'` (`340 × 240` first; `dragGrip(-160, +100)` → `500 × 340`; session message; close → `session-notes.json` entry has `size: { width: 500, height: 340 }` — type a text first so the note is stored).
  - `'each note keeps its own size'` (resized Session; Project → `340 × 240`; `dragGrip(-60, +60)` → `400 × 300`; Session → `500 × 340`; with project text, `project-notes.json` has the project size).
  - `'a double click on the grip goes back to the default size'` (→ `340 × 240`; after close no `size` in the entry).
  - `'the card stays within the terminal's area, and is never smaller than its minimum'` (`dragGrip(-5000, +5000)` → the card's box inside `#terminals`' box; `dragGrip(+5000, -5000)` → `260 × 140`).
- [ ] **Step 2: Run** through the lock `npm run build && npx playwright test tests/e2e/note-size.spec.ts --workers=2 --reporter=line`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, plus `tests/e2e/note-overlay.spec.ts tests/e2e/project-notes-card.spec.ts` in the same locked command, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (`feat: the note card resizes from its corner, each note its own size`).

---

### Task 12 (after both streams): README, CHANGELOG and the whole run

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: README.** Replace the **Notes** bullet with: `- **Notes** — a note of your own on each Claude tab, and one for each project. The Note button (or \`Ctrl+Shift+N\` / \`⌘N\`) opens a card over the terminal or the chat with a **Session | Project** switch: the session note stays with the conversation through \`/clear\`, a restart and Recent sessions; the project note is shared by every Claude tab of the same git project, its worktrees included, and stays on this device. **Checkbox** (or \`[ ] \` typed at a line's start) makes a line a checkbox item, ticked with a click or \`Ctrl+Enter\`; **List** makes bullets. Drag the card's bottom-left corner to make it bigger. Collapsed, the note is a small label that counts the ticked items and shows the next one. Claude can read both notes, add to them and tick items with the bundled \`read_notes\`, \`add_to_note\` and \`check_note_item\` tools, never erasing your text; what is stored is plain Markdown (\`- [ ] item\`).` In the devices paragraph, `Stars and notes are the same on every device` becomes `Stars and session notes are the same on every device`. In the shortcuts table, after the note row: `| Tick the checkbox item under the caret, in the note | \`Ctrl+Enter\` | \`⌘Enter\` |`. Add `read_notes`, `add_to_note`, `check_note_item` to the tool list after "On its first start ClaudeTerm registers its `claudeterm` MCP server" and to the mermaid `MCP:` line.
- [ ] **Step 2: CHANGELOG.** In the top section (`## 0.20.0`), under `### New`: `- **Project notes, and a note you can shape.** The note card has a **Session | Project** switch: the project note is shared by every Claude tab of the same git project, worktrees included, and stays on this device. A note can hold checkboxes — **Checkbox** in the card's toolbar, or \`[ ] \` at the start of a line — ticked with a click or \`Ctrl+Enter\`, and bullets (**List**). Drag the card's bottom-left corner to make it bigger; each note keeps its size. Collapsed, the label counts the ticked items and shows the next one.` and `- **Claude keeps your notes with you.** With the bundled \`read_notes\`, \`add_to_note\` and \`check_note_item\` tools, Claude reads both notes of its tab, adds what you should not lose and ticks what it finished. It never removes or rewrites your text, and an edit it makes while you type is merged with yours.`
- [ ] **Step 3: Run** `npm run typecheck`, `npm test`, then through the lock `npm run build && node scripts/e2e.mjs --reporter=line`. Expected: PASS (rerun a known flaky test alone before blaming the change).
- [ ] **Step 4:** The controller runs the whole-branch review the skill prescribes; its fixes are tasks of their own.
- [ ] **Step 5:** Delete what the run made outside the repository; leave the changes uncommitted (`docs: project notes, the note editor and notes for Claude`) and tell the person what is ready to commit.
