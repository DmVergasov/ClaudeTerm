# Review Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Changes** tab in the right-hand panel of a Claude tab. It shows the diff of the uncommitted changes, of Claude's last turn or of the whole session; the user comments on lines and sends all the comments to Claude in one message. Claude can open any diff itself with a new `show_diff` MCP tool.

**Architecture:**
- **Main process.** Every view becomes a list of `{ path, before, after }`; one diff builder (jsdiff) turns it into hunks.
  - The git source covers Uncommitted and `from`/`to`.
  - Claude's own edits come from two new hooks. `UserPromptSubmit` starts a turn. `PreToolUse` of the edit tools makes main snapshot the file before Claude changes it; the snapshots live in an on-disk ledger per session.
  - The session transcripts fill in edits the ledger never saw.
  - `ReviewHub` holds each tab's view, viewed marks and the dialog guard, and pushes a `ReviewUpdate` over IPC.
- **Renderer.** The image panel becomes a shell with two tabs (`SidePanel`). `ReviewPanel` renders files, hunks and comments, and sends the comment message with `term.paste` plus Enter.

**Tech Stack:** Electron 44 (main/preload/renderer), TypeScript, node-pty, xterm.js; `diff` (jsdiff) and `cross-spawn`, bundled; the git CLI; Vitest (unit, integration); Playwright Electron (e2e, screenshots).

**Spec:** `docs/superpowers/specs/2026-10-08-review-panel-design.md`

## Global Constraints

- **No commits.** This is the user's global rule. Every "Leave uncommitted" step means: run the checks, do not `git commit`, and list the touched files in the report. Subagents must not commit either.
- **No release.** This feature is released only on the user's word: no version bump, no CHANGELOG release section, no tag, no Release workflow.
- **Hooks print nothing.** UserPromptSubmit stdout would become Claude's context. The hook script must never write to stdout.
- **The project folder is never watched.**
- **UI strings (English, exact):**
  - Panel tabs: `Images`, `Changes`. Scope buttons: `Uncommitted`, `Last turn`, `Session`. Buttons: `Send to Claude`, `Add comment`, `Save`, `Cancel`, `Edit`, `Delete`. Footer: `N comment(s)`. Empty states: `No changes`, `No changes in this view`. Comment box placeholder: `Comment for Claude`.
  - Menus: `Comment`, `Open in editor at line N`, `Copy path:line`, `Open in editor`, `Copy path`.
  - Note rows: `binary`, `too large`, `show anyway`, `line endings changed only`, `no baseline — use Uncommitted`, `submodule`, `can't be read`, `not shown`, `Comments outside this view (n)`, `outdated`.
  - Send refusals: `Answer Claude's prompt in the terminal first`, `Claude is not running in this tab`.
  - Uncommitted unavailable: `Not a git repository`, `git was not found`.
  - Notice: `Too many changes to show at once — narrow the view with a smaller scope or paths`.
  - Status bar: `± N file(s) +A −D`; tooltip `Uncommitted changes in <root>` or `Claude's edits in this session`.
  - Settings page: section `Review` (`the Changes panel`), field `Editor`, checkbox `Show the changes counter in the status bar`.
- **Shortcut:** `Ctrl+Shift+D` (physical key `KeyD`) toggles Changes. `Ctrl+Shift+I` still toggles Images.
- **Limits:**

  | limit | value |
  |---|---|
  | one side | 1 MB (`MAX_SIDE_BYTES`) |
  | "show anyway" and snapshots | 10 MB (`MAX_FORCED_BYTES`, `MAX_SNAPSHOT_BYTES`) |
  | files per view | 500 |
  | text per view | 5 MB |
  | changed lines before a file starts folded | 1000 |
  | quote lines | 6 |
  | re-anchoring window | 50 lines |
  | recompute debounce | 300 ms |
  | ledger cleanup | 7 days |
  | git timeout | 10 s |
  | pause before Enter | 50 ms |
  | expanded panel | 85% of the window |
  | `review.width` default | 640 |
  | edit_before pipe timeout in the hook | 8000 ms |
  | show_diff pipe timeout in the MCP server | 15 000 ms |
- **Send message format:** exactly the spec's example (header `Review comments on the changes (<label>):`, a blank line, numbered blocks, 3-space indent, `> ` quotes).
- **Dependencies:** `npm install --save-dev diff cross-spawn @types/cross-spawn`. Both are bundled into main by electron-vite, like `zod`. Nothing is added to `dependencies`.
- **Screenshots:** invented data only, never the user's projects or sessions.
- **Checks:** `npm run typecheck` and `npm test` must pass after every task. Run e2e (`npm run test:e2e`) where a task says so.

## Review Focus

1. **Claude edits the same file several times in one turn.** Last turn must compare against the file before the *first* edit of that turn, not the last. → Task 3 test "the first snapshot per turn and per session wins".
2. **One file reported with different letter case or separators by the hook, the transcript and git** (Windows: `d:\x\a.ts`, `D:\x\a.ts`, `x/a.ts`). It must be one file in the view, not two. → Task 6 test "paths that differ only in case are one file" (`pathKey` grouping).
3. **Non-ASCII file names** (Cyrillic folders and files). git output must be read as raw UTF-8 with `-z`, so the files show with their real names and contents. → Task 4 integration test "a file with a Cyrillic name".
4. **Claude edits while a view is computing, or the user switches scope mid-compute.** The panel must never end up showing an older result than the latest state. → Task 7 tests "a trigger during a compute runs it again" and "a scope change during a compute discards the stale result".
5. **The user types a comment while Claude's edits re-render the panel.** The draft text, focus and caret survive the re-render. → Task 12: `ReviewPanel.render()` keeps the draft, its focus and caret; Task 13 e2e "a draft survives an update".

---

## File Structure

New files:

| file | job |
|---|---|
| `src/shared/review.ts` | review types shared by main and renderer (`ReviewScope`, `ReviewFile`, `ReviewUpdate`, …) |
| `src/main/transcript-edits.ts` | pure: turn starts and edit results in transcript lines |
| `src/main/baselines.ts` | pure: undo patches (`reverseApply`), the history baseline |
| `src/main/edit-ledger.ts` | snapshots per session and turn, the blob store, `ledger.json` |
| `src/main/git-source.ts` | the git CLI: root, refs, changed files, revision sizes and blobs |
| `src/main/review-diff.ts` | pure: `Side`, `DiffInput`, `buildFile` (EOL, binary, sizes, hunks) |
| `src/main/review-sources.ts` | the inputs of a git view and of a ledger view, with the byte budget |
| `src/main/review-hub.ts` | per-tab review state, triggers, viewed marks, dialog guard, counter, `show_diff` |
| `src/main/editor-launch.ts` | the `review.editor` template and launching it |
| `src/mcp/show-diff-tool.ts` | the `show_diff` input checks and the pipe call |
| `src/renderer/side-panel.ts` | the right-hand panel shell: two tabs, widths, expand, hide |
| `src/renderer/review-comments.ts` | pure: comment anchors, re-anchoring, the Send message |
| `src/renderer/review-panel.ts` | the Changes tab DOM |

New tests:
- unit: `transcript-edits`, `baselines`, `edit-ledger`, `review-diff`, `review-sources`, `review-hub`, `editor-launch`, `show-diff-tool`, `review-comments`; additions to `protocol`, `session-hook`, `claude-tab-settings`, `settings`, `settings-keys`, `settings-form`, `ipc-guards`, `keymap`, `status-bar`;
- integration: `git-source.int.test.ts`, `review-sources.int.test.ts`, plus additions to `mcp.int.test.ts`, `pipe.test.ts`, `session-hook.int.test.ts` and `transcript-feed.int.test.ts`;
- `SidePanel` has no unit test: it is DOM only, and the e2e tests drive it (the existing image tests and `review.spec.ts`);
- e2e: `review.spec.ts`;
- screenshots: an addition to `readme.shots.ts`.

Modified:

| file | change |
|---|---|
| `src/shared/protocol.ts` | messages `turn`, `edit_before`, `show_diff`; `attention.agentId`; `PipeResponse.info` |
| `src/hook/session-hook.ts`, `src/hook/main.ts` | the new events; a longer timeout for `edit_before` |
| `src/main/claude-tab-settings.ts` | the two hooks |
| `src/main/pipe-server.ts` | the three handlers |
| `src/main/transcript-feed.ts` | `onEditEvent` and `onAssistant` callbacks |
| `src/main/index.ts` | wiring |
| `src/main/ipc-guards.ts` | review argument checks |
| `src/shared/ipc.ts`, `src/preload/index.ts` | review channels |
| `src/shared/types.ts`, `src/main/settings.ts`, `src/shared/settings-keys.ts`, `src/renderer/settings-form.ts`, `src/renderer/settings-page.ts` | `review` settings |
| `src/mcp/show-image-server.ts` | registers `show_diff` (the file keeps its name: the MCP registration points at it) |
| `src/renderer/image-panel.ts` | renders into the Images body of `SidePanel` |
| `src/renderer/status-bar.ts` | the `changes` segment |
| `src/renderer/keymap.ts` | `toggleChanges` |
| `src/renderer/main.ts`, `src/renderer/env.d.ts`, `src/renderer/styles.css` | wiring and styles |
| `tests/fixtures/transcript.ts` | edit and prompt line helpers |
| `tests/e2e/helpers.ts` | `gitRepo()` helper; `launchClaudeTab` takes the folder to open |
| `README.md` | feature section, shortcut row, settings block and the settings.json-only sentence, hooks in "Good to know" |
| `package.json`, `package-lock.json` | dev dependencies |

---

### Task 1: Protocol, hooks and pipe handlers

**Files:**
- Create: `src/shared/review.ts`
- Modify: `src/shared/protocol.ts`, `src/hook/session-hook.ts`, `src/hook/main.ts`, `src/main/claude-tab-settings.ts`, `src/main/pipe-server.ts`, `src/main/index.ts` (stub handlers)
- Test: `tests/unit/protocol.test.ts`, `tests/unit/session-hook.test.ts`, `tests/unit/claude-tab-settings.test.ts`, `tests/integration/pipe.test.ts`, `tests/integration/mcp.int.test.ts`, `tests/integration/session-hook.int.test.ts`

**Interfaces:**
- Produces in `src/shared/review.ts`: `ReviewScope`, `REVIEW_SCOPES`, `SCOPE_LABELS`, `NOT_RUNNING`, `IN_DIALOG`, `ReviewLineKind`, `ReviewLine`, `ReviewHunk`, `ReviewFileStatus`, `ReviewFileNote`, `ReviewFile`, `ReviewSendState`, `ReviewCounter`, `ReviewUpdate` (full text in Step 1).
- Produces in `src/shared/protocol.ts`:
  - `TurnMessage { v: 1; type: 'turn'; tabId: string; sessionId: string; cwd: string | null }`
  - `EditBeforeMessage { v: 1; type: 'edit_before'; tabId: string; sessionId: string; toolUseId: string; path: string }`
  - `ShowDiffMessage { v: 1; type: 'show_diff'; tabId: string | null; cwd: string; scope: ReviewScope | null; from: string | null; to: string | null; paths: string[]; title: string | null }`
  - `AttentionMessage.agentId?: string`
  - `PipeResponse = { ok: true; info?: string } | { ok: false; error: string }`
- Produces in `src/main/pipe-server.ts`: `PipeHandlers.turn(msg: TurnMessage): PipeResponse`, `PipeHandlers.editBefore(msg: EditBeforeMessage): PipeResponse`, `PipeHandlers.showDiff(msg: ShowDiffMessage): Promise<PipeResponse>`.

- [ ] **Step 1: Create the shared review types**

`src/shared/review.ts`:

```ts
// What the main process and the Changes panel exchange about a review.

export type ReviewScope = 'uncommitted' | 'last_turn' | 'session'
export const REVIEW_SCOPES: readonly ReviewScope[] = ['uncommitted', 'last_turn', 'session']
/** the view's name in the Send message and in show_diff labels */
export const SCOPE_LABELS: Record<ReviewScope, string> = { uncommitted: 'uncommitted', last_turn: 'last turn', session: 'session' }

/** why Send is refused: the main process says it, the Changes panel shows it */
export const NOT_RUNNING = 'Claude is not running in this tab'
export const IN_DIALOG = "Answer Claude's prompt in the terminal first"

export type ReviewLineKind = 'context' | 'add' | 'del'

export interface ReviewLine {
  kind: ReviewLineKind
  text: string
  /** the line's number on the old side; null for an added line */
  oldNo: number | null
  /** the line's number on the new side; null for a deleted line */
  newNo: number | null
}

export interface ReviewHunk {
  /** "@@ -38,7 +38,9 @@" */
  header: string
  lines: ReviewLine[]
}

export type ReviewFileStatus = 'added' | 'modified' | 'deleted'

/** why a file shows one row instead of hunks */
export type ReviewFileNote = 'binary' | 'too-large' | 'eol-only' | 'no-baseline' | 'submodule' | 'unreadable' | 'too-many'

export interface ReviewFile {
  /** absolute */
  path: string
  /** what the panel shows: relative to the repository root or the tab's folder, with / separators */
  relPath: string
  status: ReviewFileStatus
  additions: number
  deletions: number
  hunks: ReviewHunk[]
  note: ReviewFileNote | null
  /** a "too large" file can be built anyway: both sides are at most 10 MB */
  canForce: boolean
  /** names the file's current content: a Viewed mark lasts while it stays the same */
  hash: string
  viewed: boolean
}

export type ReviewSendState = { ok: true } | { ok: false; reason: string }

export interface ReviewCounter {
  files: number
  additions: number
  deletions: number
  /** the status bar tooltip */
  title: string
}

export interface ReviewUpdate {
  tabId: string
  view: { kind: 'scope'; scope: ReviewScope } | { kind: 'request' }
  /** "uncommitted", "last turn", "session", or the show_diff chip text */
  label: string
  uncommitted: { available: true } | { available: false; reason: string }
  files: ReviewFile[]
  additions: number
  deletions: number
  unviewed: number
  notice: string | null
  send: ReviewSendState
  counter: ReviewCounter | null
  /** show_diff asked to open the panel */
  reveal: boolean
}
```

- [ ] **Step 2: Write the failing protocol tests**

Append to `tests/unit/protocol.test.ts` (the file already defines `TAB`, `SID`, `WIN`):

```ts
describe('parsePipeMessage: review messages', () => {
  const ids = { v: 1, tabId: TAB, sessionId: SID }
  const FILE = WIN ? 'D:\\proj\\src\\a.ts' : '/proj/src/a.ts'
  const CWD = WIN ? 'D:\\proj' : '/proj'

  it('accepts a turn with or without a usable cwd', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'turn', cwd: CWD }))).toEqual({ ok: true, message: { ...ids, type: 'turn', cwd: CWD } })
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'turn', cwd: 'relative' }))).toEqual({ ok: true, message: { ...ids, type: 'turn', cwd: null } })
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'turn', tabId: 'x' })).ok).toBe(false)
  })

  it('accepts edit_before with a tool use id and an absolute path', () => {
    const m = { ...ids, type: 'edit_before', toolUseId: 'toolu_01AbC-d_9', path: FILE }
    expect(parsePipeMessage(JSON.stringify(m))).toEqual({ ok: true, message: m })
    expect(parsePipeMessage(JSON.stringify({ ...m, path: 'src/a.ts' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...m, toolUseId: 'a b' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...m, toolUseId: '' })).ok).toBe(false)
  })

  it('accepts show_diff and cuts the title to 100 characters', () => {
    const m = { v: 1, type: 'show_diff', tabId: TAB, cwd: CWD, scope: null, from: 'HEAD~3', to: null, paths: [FILE], title: 'x'.repeat(150) }
    const r = parsePipeMessage(JSON.stringify(m))
    expect(r).toEqual({ ok: true, message: { ...m, title: 'x'.repeat(100) } })
    const scoped = { ...m, scope: 'last_turn', from: null, paths: [], title: null }
    expect(parsePipeMessage(JSON.stringify(scoped))).toEqual({ ok: true, message: scoped })
    expect(parsePipeMessage(JSON.stringify({ ...m, tabId: null }))).toMatchObject({ ok: true, message: { tabId: null } })
  })

  it('rejects show_diff with a ref that starts with "-", a relative path or an unknown scope', () => {
    const m = { v: 1, type: 'show_diff', tabId: TAB, cwd: CWD, scope: null, from: null, to: null, paths: [], title: null }
    expect(parsePipeMessage(JSON.stringify({ ...m, from: '--output=x' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...m, to: '-x' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...m, paths: ['src'] })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...m, scope: 'week' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...m, cwd: 'proj' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...m, paths: Array.from({ length: 101 }, () => FILE) })).ok).toBe(false)
  })

  it('keeps a valid agentId on attention and drops a bad one', () => {
    const a = { ...ids, type: 'attention', reason: 'permission' }
    expect(parsePipeMessage(JSON.stringify({ ...a, agentId: 'a40a10c1d655cf759' }))).toEqual({ ok: true, message: { ...a, agentId: 'a40a10c1d655cf759' } })
    expect(parsePipeMessage(JSON.stringify({ ...a, agentId: '../x' }))).toEqual({ ok: true, message: a })
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: FAIL — `unknown message type: turn` and similar.

- [ ] **Step 4: Extend the protocol**

In `src/shared/protocol.ts`:

1. Imports and constants. Add the import and three constants after `MAX_LABEL`:

```ts
import { REVIEW_SCOPES, type ReviewScope } from './review'
```
```ts
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/
const MAX_REF = 200
const MAX_PATHS = 100
```

2. Message types. Add after `AttentionMessage`, and give `AttentionMessage` the optional field:

```ts
/** Claude is waiting for the user: a permission prompt, an AskUserQuestion, or the end of a turn. */
export interface AttentionMessage {
  v: 1
  type: 'attention'
  tabId: string
  sessionId: string
  reason: AttentionReason
  /** the subagent whose dialog it is; absent for the main conversation */
  agentId?: string
}

/** Claude Code took a prompt (UserPromptSubmit): a turn starts. */
export interface TurnMessage {
  v: 1
  type: 'turn'
  tabId: string
  sessionId: string
  cwd: string | null
}

/** Claude is about to change a file (PreToolUse of an edit tool). ClaudeTerm reads the file before it replies. */
export interface EditBeforeMessage {
  v: 1
  type: 'edit_before'
  tabId: string
  sessionId: string
  toolUseId: string
  path: string
}

/** show_diff from the MCP server: open a diff in the tab's Changes panel. */
export interface ShowDiffMessage {
  v: 1
  type: 'show_diff'
  tabId: string | null
  /** where Claude runs: relative paths and the repository come from here */
  cwd: string
  scope: ReviewScope | null
  from: string | null
  to: string | null
  paths: string[]
  title: string | null
}
```

3. The unions:

```ts
export type PipeMessage =
  | ShowImageMessage | SessionMessage | StatusMessage | SubagentMessage | SessionEndMessage | AttentionMessage
  | TurnMessage | EditBeforeMessage | ShowDiffMessage
export type PipeResponse = { ok: true; info?: string } | { ok: false; error: string }
```

4. Parsing. In `parsePipeMessage`, insert before the `if (m.type === 'status' || …)` block:

```ts
  if (m.type === 'turn' || m.type === 'edit_before') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    if (m.type === 'turn') {
      const cwd = typeof m.cwd === 'string' && isAbsolute(m.cwd) ? m.cwd : null
      return { ok: true, message: { v: 1, type: 'turn', tabId: m.tabId, sessionId: m.sessionId, cwd } }
    }
    if (typeof m.toolUseId !== 'string' || !TOOL_USE_ID_RE.test(m.toolUseId)) return { ok: false, error: 'toolUseId must match [A-Za-z0-9_-]{1,200}' }
    if (typeof m.path !== 'string' || !isAbsolute(m.path)) return { ok: false, error: 'path must be an absolute path' }
    return { ok: true, message: { v: 1, type: 'edit_before', tabId: m.tabId, sessionId: m.sessionId, toolUseId: m.toolUseId, path: m.path } }
  }

  if (m.type === 'show_diff') {
    const tabId = m.tabId === null || m.tabId === undefined ? null : isUuid(m.tabId) ? m.tabId : undefined
    if (tabId === undefined) return { ok: false, error: 'tabId must be a UUID or null' }
    if (typeof m.cwd !== 'string' || !isAbsolute(m.cwd)) return { ok: false, error: 'cwd must be an absolute path' }
    const scope = m.scope === null || m.scope === undefined ? null : REVIEW_SCOPES.find((s) => s === m.scope)
    if (scope === undefined) return { ok: false, error: 'scope must be "uncommitted", "last_turn", "session" or null' }
    const ref = (v: unknown): string | null | undefined =>
      v === null || v === undefined ? null : typeof v === 'string' && v.length > 0 && v.length <= MAX_REF && !v.startsWith('-') ? v : undefined
    const from = ref(m.from)
    const to = ref(m.to)
    if (from === undefined || to === undefined) return { ok: false, error: 'from and to must be git revisions that do not start with "-"' }
    const paths = m.paths ?? []
    if (!Array.isArray(paths) || paths.length > MAX_PATHS || !paths.every((p): p is string => typeof p === 'string' && isAbsolute(p))) {
      return { ok: false, error: `paths must be at most ${MAX_PATHS} absolute paths` }
    }
    if (m.title !== null && m.title !== undefined && typeof m.title !== 'string') return { ok: false, error: 'title must be a string or null' }
    return { ok: true, message: { v: 1, type: 'show_diff', tabId, cwd: m.cwd, scope, from, to, paths, title: label(m.title) } }
  }
```

`label()` already trims to `MAX_LABEL` (100) and turns `''` into `null`.

5. In the `attention` branch, keep a valid agent id:

```ts
    if (m.type === 'attention') {
      if (typeof m.reason !== 'string' || !ATTENTION_REASONS.includes(m.reason)) return { ok: false, error: 'reason must be "permission", "question" or "done"' }
      const agent = typeof m.agentId === 'string' && AGENT_ID_RE.test(m.agentId) ? { agentId: m.agentId } : {}
      return { ok: true, message: { v: 1, type: 'attention', ...ids, reason: m.reason as AttentionReason, ...agent } }
    }
```

- [ ] **Step 5: Run the protocol tests**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing hook tests**

Append to `tests/unit/session-hook.test.ts` (it defines `TAB`, `SID`, `ENV`, `AGENT`):

```ts
describe('runSessionHook: review events', () => {
  const CWD = process.platform === 'win32' ? 'D:\\proj' : '/proj'
  const ABS = process.platform === 'win32' ? 'D:\\proj\\src\\a.ts' : '/proj/src/a.ts'

  it('maps UserPromptSubmit to a turn with the cwd', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'fix it', cwd: CWD }), ENV, send)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'turn', tabId: TAB, sessionId: SID, cwd: CWD })
  })

  it('maps PreToolUse of Edit, Write, MultiEdit and NotebookEdit to edit_before', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const pre = (tool_name: string, tool_input: object, tool_use_id = 'toolu_1') =>
      runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id, cwd: CWD }), ENV, send)
    await pre('Edit', { file_path: ABS, old_string: 'a', new_string: 'b' })
    await pre('Write', { file_path: 'src/a.ts', content: 'x' }, 'toolu_2')
    await pre('MultiEdit', { file_path: ABS, edits: [] }, 'toolu_3')
    await pre('NotebookEdit', { notebook_path: ABS, new_source: '' }, 'toolu_4')
    const msg = (toolUseId: string) => ({ v: 1, type: 'edit_before', tabId: TAB, sessionId: SID, toolUseId, path: ABS })
    expect(send).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\x', msg('toolu_1'))
    expect(send).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\x', msg('toolu_2'))
    expect(send).toHaveBeenNthCalledWith(3, '\\\\.\\pipe\\x', msg('toolu_3'))
    expect(send).toHaveBeenNthCalledWith(4, '\\\\.\\pipe\\x', msg('toolu_4'))
  })

  it('ignores PreToolUse of other tools and edits without a path or a tool use id', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't' }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, tool_use_id: 't' }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: ABS } }), ENV, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('puts the subagent id on a permission prompt from a subagent', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id: AGENT }), ENV, send)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'permission', agentId: AGENT })
  })
})
```

In `tests/unit/claude-tab-settings.test.ts`, change the expected `hooks` in "claudeTabSettingsJson declares…" to:

```ts
      hooks: {
        SessionStart: hook,
        SubagentStart: hook,
        SubagentStop: hook,
        SessionEnd: hook,
        PermissionRequest: hook,
        UserPromptSubmit: hook,
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [run] }, { matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [run] }],
        Stop: hook
      }
```

- [ ] **Step 7: Run them to see them fail**

Run: `npx vitest run tests/unit/session-hook.test.ts tests/unit/claude-tab-settings.test.ts`
Expected: FAIL — no `turn`/`edit_before` messages; the hooks object differs.

- [ ] **Step 8: Map the hook events**

In `src/hook/session-hook.ts`:

1. Add the import and a constant:

```ts
import { isAbsolute, resolve } from 'node:path'
```
```ts
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
```

2. In `hookMessage`, replace the lines from `const attention = …` to the end of the function with:

```ts
  if (event === 'UserPromptSubmit') {
    return { v: 1, type: 'turn', tabId, sessionId, cwd: typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : null }
  }
  if (event === 'PreToolUse' && typeof input.tool_name === 'string' && EDIT_TOOLS.has(input.tool_name)) {
    const ti = isObj(input.tool_input) ? input.tool_input : {}
    const p = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : null
    if (!p || typeof input.tool_use_id !== 'string' || input.tool_use_id === '') return null
    const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : null
    const path = isAbsolute(p) ? p : cwd ? resolve(cwd, p) : null
    return path ? { v: 1, type: 'edit_before', tabId, sessionId, toolUseId: input.tool_use_id, path } : null
  }
  const agentId = typeof input.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : null
  const attention = (reason: AttentionReason): PipeMessage => ({ v: 1, type: 'attention', tabId, sessionId, reason, ...(agentId ? { agentId } : {}) })
  if (event === 'PermissionRequest') return attention('permission')
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') return attention('question')
  if (event === 'Stop') return attention('done')
  return null
```

In `src/hook/main.ts`, give `edit_before` a longer timeout. Main reads the file before answering, and the edit must wait for that:

```ts
      : runSessionHook(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, msg.type === 'edit_before' ? 8000 : 2000))
```

In `src/main/claude-tab-settings.ts` `claudeTabSettingsJson`, add the hooks:

```ts
        PermissionRequest: hook,
        // a turn starts: Last turn compares with the files as they were before it
        UserPromptSubmit: hook,
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: [run] },
          // ClaudeTerm keeps each file as it was before Claude's first change in the turn and in the session
          { matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [run] }
        ],
        Stop: hook
```

- [ ] **Step 9: Add the pipe handlers**

In `src/main/pipe-server.ts`:
- import `EditBeforeMessage`, `ShowDiffMessage`, `TurnMessage`;
- extend `PipeHandlers`:

```ts
  turn(msg: TurnMessage): PipeResponse
  editBefore(msg: EditBeforeMessage): PipeResponse
  showDiff(msg: ShowDiffMessage): Promise<PipeResponse>
```

- add the cases to the `switch` in `handleLine`:

```ts
      case 'turn': return h.turn(m)
      case 'edit_before': return h.editBefore(m)
      case 'show_diff': return await h.showDiff(m)
```

In `src/main/index.ts`, add stub handlers next to `attention` in `startPipeServer(pipeName, { … })`. Task 10 replaces them.

```ts
    turn: (msg) => (isClaudeTab(msg.tabId) ? { ok: true } : { ok: false, error: `unknown claude tab: ${msg.tabId}` }),
    editBefore: (msg) => (isClaudeTab(msg.tabId) ? { ok: true } : { ok: false, error: `unknown claude tab: ${msg.tabId}` }),
    showDiff: async () => ({ ok: false, error: 'show_diff works only in a ClaudeTerm Claude tab' })
```

Add the same three handlers to every test server (each builds a whole `PipeHandlers`, so the typecheck fails without them):
- `tests/integration/pipe.test.ts` `okHandlers`: `turn: () => ({ ok: true }), editBefore: () => ({ ok: true }), showDiff: async () => ({ ok: true })`;
- the `startPipeServer` call in `tests/integration/mcp.int.test.ts`: the same three;
- the `startPipeServer` call in `listen()` of `tests/integration/session-hook.int.test.ts`, which records every message with `take`:

```ts
  server = await startPipeServer(pipe, {
    showImage: async () => ({ ok: true }), session: take, status: take, subagent: take, sessionEnd: take, attention: take,
    turn: take, editBefore: take, showDiff: async (m) => take(m)
  })
```

Also add to `pipe.test.ts`:

```ts
  it('routes edit_before and passes show_diff replies through, info included', async () => {
    const pipe = newPipe()
    const FILE = WIN ? 'C:\\x\\a.ts' : '/x/a.ts'
    const got: string[] = []
    server = await startPipeServer(pipe, {
      ...okHandlers,
      editBefore: (m) => { got.push(m.path); return { ok: true } },
      showDiff: async () => ({ ok: true, info: 'Opened 1 file (+1 −0) in the Changes panel.' })
    })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'edit_before', tabId: TAB, sessionId: SID, toolUseId: 'toolu_1', path: FILE })).toEqual({ ok: true })
    expect(got).toEqual([FILE])
    const cwd = WIN ? 'C:\\x' : '/x'
    expect(await sendPipeMessage(pipe, { v: 1, type: 'show_diff', tabId: TAB, cwd, scope: null, from: null, to: null, paths: [], title: null }))
      .toEqual({ ok: true, info: 'Opened 1 file (+1 −0) in the Changes panel.' })
  })
```

- [ ] **Step 10: Run the tests and the typecheck**

Run: `npx vitest run tests/unit/session-hook.test.ts tests/unit/claude-tab-settings.test.ts tests/unit/protocol.test.ts tests/integration/pipe.test.ts tests/integration/mcp.int.test.ts tests/integration/session-hook.int.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 11: Leave uncommitted** — report the files touched.

---

### Task 2: Edits in transcripts and undoing patches

**Files:**
- Create: `src/main/transcript-edits.ts`, `src/main/baselines.ts`
- Modify: `tests/fixtures/transcript.ts`
- Test: `tests/unit/transcript-edits.test.ts`, `tests/unit/baselines.test.ts`

**Interfaces:**
- Produces (`transcript-edits.ts`):
  - `interface PatchHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }`
  - `type TranscriptEditEvent = { kind: 'prompt'; at: number; id: string } | { kind: 'edit'; at: number; toolUseId: string; path: string; created: boolean; originalFile: string | null; patch: PatchHunk[] }`
  - `parseEditEvents(line: string, opts: { main: boolean }): TranscriptEditEvent[]`
  - `isAssistantLine(line: string): boolean`
- Produces (`baselines.ts`):
  - `interface HistoryEdit { at: number; toolUseId: string; path: string; created: boolean; originalFile: string | null; patch: PatchHunk[] }`
  - `type HistoryBaseline = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'none' }`
  - `reverseApply(text: string, hunks: PatchHunk[]): string | null`
  - `historyBaseline(edits: HistoryEdit[], later: string | null): HistoryBaseline`
- Produces (fixtures): `editResultLine(o)`, `promptLine(text, o?)`.

- [ ] **Step 1: Add transcript fixture helpers**

Append to `tests/fixtures/transcript.ts`:

```ts
/** A user prompt as Claude Code writes it to the main transcript. */
export function promptLine(text: string, o: { timestamp?: string; uuid?: string; isMeta?: boolean; isSidechain?: boolean } = {}): string {
  return JSON.stringify({
    type: 'user',
    uuid: o.uuid ?? `u-${text.length}-${o.timestamp ?? ''}`,
    timestamp: o.timestamp ?? '2026-10-08T10:00:00.000Z',
    isSidechain: o.isSidechain ?? false,
    ...(o.isMeta ? { isMeta: true } : {}),
    message: { role: 'user', content: text }
  })
}

/** The result of an Edit or Write, with Claude Code's toolUseResult. */
export function editResultLine(o: {
  toolUseId: string
  filePath: string
  patch?: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]
  originalFile?: string | null
  created?: boolean
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: o.timestamp ?? '2026-10-08T10:00:05.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: o.toolUseId, content: 'ok' }] },
    toolUseResult: {
      ...(o.created !== undefined ? { type: o.created ? 'create' : 'update' } : {}),
      filePath: o.filePath,
      structuredPatch: o.patch ?? [],
      originalFile: o.originalFile ?? null,
      userModified: false
    }
  })
}
```

- [ ] **Step 2: Write the failing parser tests**

`tests/unit/transcript-edits.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isAssistantLine, parseEditEvents } from '../../src/main/transcript-edits'
import { assistantLine, editResultLine, promptLine, toolResultLine } from '../fixtures/transcript'

const HUNK = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }

describe('parseEditEvents', () => {
  it('reads a typed prompt in the main transcript as a turn start', () => {
    expect(parseEditEvents(promptLine('fix the bug', { timestamp: '2026-10-08T10:00:00.000Z', uuid: 'p1' }), { main: true }))
      .toEqual([{ kind: 'prompt', at: Date.parse('2026-10-08T10:00:00.000Z'), id: 'p1' }])
  })

  it('takes text blocks as a prompt, but not tool results, meta, sidechain or subagent entries', () => {
    const blocks = JSON.stringify({ type: 'user', uuid: 'p2', timestamp: '2026-10-08T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
    expect(parseEditEvents(blocks, { main: true })).toHaveLength(1)
    expect(parseEditEvents(toolResultLine('t1'), { main: true })).toEqual([])
    expect(parseEditEvents(promptLine('x', { isMeta: true }), { main: true })).toEqual([])
    expect(parseEditEvents(promptLine('x', { isSidechain: true }), { main: true })).toEqual([])
    expect(parseEditEvents(promptLine('x'), { main: false })).toEqual([])
    const compact = JSON.stringify({ type: 'user', uuid: 'c', isCompactSummary: true, message: { role: 'user', content: 'summary' } })
    expect(parseEditEvents(compact, { main: true })).toEqual([])
  })

  it('reads an Edit result with its patch and original file', () => {
    const line = editResultLine({ toolUseId: 'toolu_1', filePath: 'D:\\p\\a.ts', patch: [HUNK], originalFile: 'a\n', timestamp: '2026-10-08T10:00:05.000Z' })
    expect(parseEditEvents(line, { main: true })).toEqual([
      { kind: 'edit', at: Date.parse('2026-10-08T10:00:05.000Z'), toolUseId: 'toolu_1', path: 'D:\\p\\a.ts', created: false, originalFile: 'a\n', patch: [HUNK] }
    ])
  })

  it('reads a Write that creates a file, also in a subagent transcript', () => {
    const line = editResultLine({ toolUseId: 'toolu_2', filePath: '/p/new.ts', created: true })
    expect(parseEditEvents(line, { main: false })).toMatchObject([{ kind: 'edit', created: true, originalFile: null, patch: [] }])
  })

  it('drops malformed hunks and lines that are not JSON', () => {
    const line = editResultLine({ toolUseId: 't', filePath: '/p/a.ts', patch: [HUNK, { oldStart: 'x' } as never] })
    expect(parseEditEvents(line, { main: true })).toMatchObject([{ patch: [HUNK] }])
    expect(parseEditEvents('{"structuredPatch": ', { main: true })).toEqual([])
  })
})

describe('isAssistantLine', () => {
  it('tells assistant entries from the rest', () => {
    expect(isAssistantLine(assistantLine('claude-opus-5-5'))).toBe(true)
    expect(isAssistantLine(promptLine('x'))).toBe(false)
    expect(isAssistantLine('not json "type":"assistant"')).toBe(false)
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/transcript-edits.test.ts`
Expected: FAIL — cannot find module `transcript-edits`.

- [ ] **Step 4: Write the parser**

`src/main/transcript-edits.ts`:

```ts
/** One hunk of Claude Code's structuredPatch (jsdiff's format): lines start with ' ', '-', '+' or '\'. */
export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type TranscriptEditEvent =
  | { kind: 'prompt'; at: number; id: string }
  | { kind: 'edit'; at: number; toolUseId: string; path: string; created: boolean; originalFile: string | null; patch: PatchHunk[] }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function isHunk(v: unknown): v is PatchHunk {
  return (
    isObj(v) && typeof v.oldStart === 'number' && typeof v.oldLines === 'number' && typeof v.newStart === 'number' &&
    typeof v.newLines === 'number' && Array.isArray(v.lines) && v.lines.every((l) => typeof l === 'string')
  )
}

/** typed text: a string, or text blocks without tool results */
function isTyped(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((b) => isObj(b) && b.type === 'text') && !content.some((b) => isObj(b) && b.type === 'tool_result')
}

/**
 * Turn starts and file edits in one transcript line. A turn starts with a prompt in the main transcript;
 * an edit is the toolUseResult Claude Code stores with an Edit or Write result, in any transcript.
 */
export function parseEditEvents(line: string, opts: { main: boolean }): TranscriptEditEvent[] {
  // most lines are neither: skip the JSON parse for them (a prompt never holds an unescaped "tool_use_id")
  const maybeEdit = line.includes('"structuredPatch"')
  const maybePrompt = opts.main && line.includes('"type":"user"') && !line.includes('"tool_use_id"')
  if (!maybeEdit && !maybePrompt) return []
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObj(o) || o.type !== 'user') return []
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : Number.NaN
  const at = Number.isNaN(ts) ? 0 : ts
  const content = isObj(o.message) ? o.message.content : undefined
  const r = o.toolUseResult
  if (isObj(r) && typeof r.filePath === 'string' && Array.isArray(r.structuredPatch)) {
    const result = Array.isArray(content) ? content.find((b) => isObj(b) && b.type === 'tool_result') : undefined
    const toolUseId = isObj(result) && typeof result.tool_use_id === 'string' ? result.tool_use_id : null
    if (!toolUseId) return []
    return [{
      kind: 'edit',
      at,
      toolUseId,
      path: r.filePath,
      created: r.type === 'create',
      originalFile: typeof r.originalFile === 'string' ? r.originalFile : null,
      patch: r.structuredPatch.filter(isHunk)
    }]
  }
  if (!opts.main || o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true || o.isVisibleInTranscriptOnly === true) return []
  if (!isTyped(content)) return []
  return [{ kind: 'prompt', at, id: typeof o.uuid === 'string' ? o.uuid : `${at}` }]
}

/** an assistant entry: Claude wrote a new message, so a dialog it raised before is answered */
export function isAssistantLine(line: string): boolean {
  if (!line.includes('"type":"assistant"')) return false
  try {
    const o: unknown = JSON.parse(line)
    return isObj(o) && o.type === 'assistant'
  } catch {
    return false
  }
}
```

- [ ] **Step 5: Run the parser tests**

Run: `npx vitest run tests/unit/transcript-edits.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing baseline tests**

`tests/unit/baselines.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { historyBaseline, reverseApply, type HistoryEdit } from '../../src/main/baselines'

const edit = (o: Partial<HistoryEdit>): HistoryEdit => ({ at: 1, toolUseId: 't', path: '/p/a.ts', created: false, originalFile: null, patch: [], ...o })

describe('reverseApply', () => {
  it('undoes a hunk at its place', () => {
    const after = 'one\ntwo\nTHREE\nfour\n'
    const hunk = { oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [' two', '-three', '+THREE', ' four'] }
    expect(reverseApply(after, [hunk])).toBe('one\ntwo\nthree\nfour\n')
  })

  it('finds a hunk that moved, and undoes several hunks of one edit', () => {
    const after = 'x\none\nB\nthree\nfour\nfive\nsix\nG\n'
    const hunks = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-b', '+B', ' three'] },
      { oldStart: 6, oldLines: 2, newStart: 6, newLines: 2, lines: [' six', '-g', '+G'] }
    ]
    expect(reverseApply(after, hunks)).toBe('x\none\nb\nthree\nfour\nfive\nsix\ng\n')
  })

  it('keeps CRLF line endings and ignores a "no newline" marker', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b', '\\ No newline at end of file'] }
    expect(reverseApply('b\r\nc\r\n', [hunk])).toBe('a\r\nc\r\n')
  })

  it('returns null when the text no longer holds the hunk', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
    expect(reverseApply('zzz\n', [hunk])).toBeNull()
  })
})

describe('historyBaseline', () => {
  const p1 = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v1', '+v2'] }
  const p2 = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v2', '+v3'] }

  it('uses the first edit\'s original file when Claude Code stored it', () => {
    expect(historyBaseline([edit({ originalFile: 'v1\n', patch: [p1] }), edit({ patch: [p2] })], 'v3\n')).toEqual({ kind: 'text', text: 'v1\n' })
  })

  it('undoes every edit, newest first, when there is no original file', () => {
    expect(historyBaseline([edit({ patch: [p1] }), edit({ patch: [p2] })], 'v3\n')).toEqual({ kind: 'text', text: 'v1\n' })
  })

  it('jumps to a later edit\'s original file on the way back', () => {
    expect(historyBaseline([edit({ patch: [p1] }), edit({ originalFile: 'v2\n', patch: [p2] })], 'garbled\n')).toEqual({ kind: 'text', text: 'v1\n' })
  })

  it('says absent for a file the first edit created', () => {
    expect(historyBaseline([edit({ created: true }), edit({ patch: [p2] })], 'v3\n')).toEqual({ kind: 'absent' })
  })

  it('has no baseline when a patch does not apply, the later text is unknown or a later edit recreated the file', () => {
    expect(historyBaseline([edit({ patch: [p1] })], 'changed by bash\n')).toEqual({ kind: 'none' })
    expect(historyBaseline([edit({ patch: [p1] })], null)).toEqual({ kind: 'none' })
    expect(historyBaseline([edit({ patch: [p1] }), edit({ created: true })], 'v2\n')).toEqual({ kind: 'none' })
    expect(historyBaseline([], 'x')).toEqual({ kind: 'none' })
  })
})
```

- [ ] **Step 7: Run them to see them fail**

Run: `npx vitest run tests/unit/baselines.test.ts`
Expected: FAIL — cannot find module `baselines`.

- [ ] **Step 8: Write the baselines**

`src/main/baselines.ts`:

```ts
import type { PatchHunk } from './transcript-edits'

/** An edit the transcript tells about: what Claude Code stored with its result. */
export interface HistoryEdit {
  at: number
  toolUseId: string
  path: string
  created: boolean
  originalFile: string | null
  patch: PatchHunk[]
}

export type HistoryBaseline = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'none' }

/** how far from its recorded place a hunk is looked for */
const MAX_OFFSET = 200

function matchesAt(lines: string[], block: string[], at: number): boolean {
  if (at < 0 || at + block.length > lines.length) return false
  for (let i = 0; i < block.length; i++) if (lines[at + i] !== block[i]) return false
  return true
}

/** The text before an edit, from the text after it and the edit's hunks; null when a hunk does not fit. */
export function reverseApply(text: string, hunks: PatchHunk[]): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const body = h.lines.filter((l) => !l.startsWith('\\'))
    const strip = (l: string): string => l.slice(1).replace(/\r$/, '')
    const after = body.filter((l) => l[0] === ' ' || l[0] === '+').map(strip)
    const before = body.filter((l) => l[0] === ' ' || l[0] === '-').map(strip)
    // an empty new side sits after line newStart; otherwise it starts at line newStart
    const expected = after.length === 0 ? h.newStart : h.newStart - 1
    let at = -1
    for (let d = 0; d <= MAX_OFFSET && at < 0; d++) {
      if (matchesAt(lines, after, expected - d)) at = expected - d
      else if (d > 0 && matchesAt(lines, after, expected + d)) at = expected + d
    }
    if (at < 0) return null
    lines.splice(at, after.length, ...before)
  }
  return lines.join(eol)
}

/**
 * A file's content before the first of `edits` (one file, oldest first). The first edit's originalFile when
 * Claude Code stored it; otherwise `later` — the content right after the last edit — with the edits undone,
 * newest first, taking a stored originalFile on the way where there is one.
 */
export function historyBaseline(edits: HistoryEdit[], later: string | null): HistoryBaseline {
  const first = edits[0]
  if (!first) return { kind: 'none' }
  if (first.created) return { kind: 'absent' }
  if (first.originalFile !== null) return { kind: 'text', text: first.originalFile }
  let text = later
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!
    if (e.originalFile !== null) {
      text = e.originalFile
      continue
    }
    // a file created again after the first edit: what came before cannot be rebuilt
    if (e.created || text === null) return { kind: 'none' }
    text = reverseApply(text, e.patch)
    if (text === null) return { kind: 'none' }
  }
  return text === null ? { kind: 'none' } : { kind: 'text', text }
}
```

- [ ] **Step 9: Run the baseline tests**

Run: `npx vitest run tests/unit/baselines.test.ts tests/unit/transcript-edits.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Leave uncommitted.**

---

### Task 3: The edit ledger

**Files:**
- Create: `src/main/edit-ledger.ts`
- Test: `tests/unit/edit-ledger.test.ts`

**Interfaces:**
- Consumes: `pathKey(p: string): string` from `src/main/path-key.ts`.
- Produces:
  - `MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024`
  - `isBinary(b: Buffer): boolean` (a NUL byte in the first 8000 bytes) and `contentSha(b: Buffer): string` (sha1, hex) — Task 5 and Task 6 use them too
  - `type SnapshotKind = 'absent' | 'blob' | 'binary' | 'too-large' | 'unreadable'`
  - `interface Snapshot { path: string; at: number; toolUseId: string; kind: SnapshotKind; sha: string | null }` — `sha` is set for every content that was read: a `'blob'` (stored in `blobs/`) and a `'binary'` file (hash only, no blob); null for `'absent'`, `'too-large'` (over 10 MB) and `'unreadable'`
  - `type FileRead = { kind: 'absent' } | { kind: 'data'; data: Buffer } | { kind: 'too-large' } | { kind: 'unreadable' }`
  - `class EditLedger` with `constructor(o: { dir: string; now(): number; onError(message: string): void })` and the methods `startTurn(): void`, `recordBefore(toolUseId: string, path: string, read: () => FileRead): void`, `sessionSnapshots(): Snapshot[]`, `lastTurnSnapshots(): Snapshot[] | null`, `has(toolUseId: string): boolean`, `blobSize(sha: string): number | null`, `readBlob(sha: string): Buffer | null`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/edit-ledger.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EditLedger, MAX_SNAPSHOT_BYTES, type FileRead } from '../../src/main/edit-ledger'

const data = (s: string): FileRead => ({ kind: 'data', data: Buffer.from(s) })
function ledger(dir = join(mkdtempSync(join(tmpdir(), 'ct-ledger-')), 'sid'), now = () => 1000) {
  const onError = vi.fn()
  return { l: new EditLedger({ dir, now, onError }), dir, onError }
}

describe('EditLedger', () => {
  it('the first snapshot per turn and per session wins', () => {
    const { l } = ledger()
    l.startTurn()
    l.recordBefore('t1', '/p/a.ts', () => data('v1'))
    l.recordBefore('t2', '/p/a.ts', () => data('v2'))
    expect(l.sessionSnapshots().map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v1'])
    expect(l.lastTurnSnapshots()!.map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v1'])
    l.startTurn()
    l.recordBefore('t3', '/p/a.ts', () => data('v3'))
    l.recordBefore('t4', '/p/a.ts', () => data('v4'))
    expect(l.sessionSnapshots().map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v1'])
    expect(l.lastTurnSnapshots()!.map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v3'])
  })

  it('keeps the last turn with edits through a turn without edits', () => {
    const { l } = ledger()
    l.startTurn()
    l.recordBefore('t1', '/p/a.ts', () => data('v1'))
    l.startTurn() // a question, no edits
    expect(l.lastTurnSnapshots()!.map((s) => s.toolUseId)).toEqual(['t1'])
  })

  it('has no last turn before any edit, and records each tool use once', () => {
    const { l } = ledger()
    expect(l.lastTurnSnapshots()).toBeNull()
    const read = vi.fn(() => data('x'))
    l.recordBefore('t1', '/p/a.ts', read)
    l.recordBefore('t1', '/p/b.ts', read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(l.has('t1')).toBe(true)
    expect(l.has('t2')).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('treats paths that differ only in case as one file on Windows', () => {
    const { l } = ledger()
    l.recordBefore('t1', 'D:\\p\\A.ts', () => data('v1'))
    l.recordBefore('t2', 'd:\\p\\a.ts', () => data('v2'))
    expect(l.sessionSnapshots()).toHaveLength(1)
  })

  it('records absent, too large and unreadable files without content, and a binary file by its hash only', () => {
    const { l } = ledger()
    const png = Buffer.from([1, 0, 2])
    const pngSha = createHash('sha1').update(png).digest('hex')
    l.recordBefore('t1', '/p/new.ts', () => ({ kind: 'absent' }))
    l.recordBefore('t2', '/p/img.png', () => ({ kind: 'data', data: png }))
    l.recordBefore('t3', '/p/big.bin', () => ({ kind: 'data', data: Buffer.alloc(MAX_SNAPSHOT_BYTES + 1) }))
    l.recordBefore('t4', '/p/locked.ts', () => ({ kind: 'unreadable' }))
    expect(l.sessionSnapshots().map((s) => [s.kind, s.sha])).toEqual([['absent', null], ['binary', pngSha], ['too-large', null], ['unreadable', null]])
    expect(l.readBlob(pngSha)).toBeNull()
  })

  it('saves to ledger.json and blobs, and loads them back for the same session', () => {
    const { l, dir } = ledger(undefined, () => 4242)
    l.startTurn()
    l.recordBefore('t1', '/p/a.ts', () => data('hello'))
    const snap = l.sessionSnapshots()[0]!
    expect(readFileSync(join(dir, 'blobs', snap.sha!), 'utf8')).toBe('hello')
    const again = new EditLedger({ dir, now: () => 0, onError: () => {} })
    expect(again.sessionSnapshots()).toEqual([{ path: '/p/a.ts', at: 4242, toolUseId: 't1', kind: 'blob', sha: snap.sha }])
    expect(again.lastTurnSnapshots()).toHaveLength(1)
    expect(again.has('t1')).toBe(true)
    expect(again.blobSize(snap.sha!)).toBe(5)
    again.startTurn()
    again.recordBefore('t2', '/p/a.ts', () => data('second'))
    expect(again.lastTurnSnapshots()!.map((s) => s.toolUseId)).toEqual(['t2'])
  })

  it('ignores a broken ledger.json', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ct-ledger-')), 'sid')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ledger.json'), '{"version":1,"turn":"x"}')
    const { l } = ledger(dir)
    expect(l.sessionSnapshots()).toEqual([])
  })

  it('keeps working in memory when the folder cannot be written, and says so once', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ct-ledger-'))
    const blocker = join(parent, 'file')
    writeFileSync(blocker, 'x') // a file where the folder should be
    const { l, onError } = ledger(join(blocker, 'sid'))
    l.recordBefore('t1', '/p/a.ts', () => data('v1'))
    l.recordBefore('t2', '/p/b.ts', () => data('v2'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(l.sessionSnapshots().map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v1', 'v2'])
    rmSync(parent, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/edit-ledger.test.ts`
Expected: FAIL — cannot find module `edit-ledger`.

- [ ] **Step 3: Write the ledger**

`src/main/edit-ledger.ts`:

```ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathKey } from './path-key'

/** the largest file a snapshot keeps */
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024

export type SnapshotKind = 'absent' | 'blob' | 'binary' | 'too-large' | 'unreadable'

/** a file as it was right before Claude changed it */
export interface Snapshot {
  path: string
  /** ms since epoch: when ClaudeTerm read it, before the edit */
  at: number
  toolUseId: string
  kind: SnapshotKind
  /** sha1 of the content, when it was read: 'blob' (kept in blobs/) and 'binary' (the hash only) */
  sha: string | null
}

export type FileRead = { kind: 'absent' } | { kind: 'data'; data: Buffer } | { kind: 'too-large' } | { kind: 'unreadable' }

interface LedgerData {
  version: 1
  /** turns started in this session, by UserPromptSubmit */
  turn: number
  /** pathKey → the first snapshot in the session */
  session: Record<string, Snapshot>
  /** the latest turn that had edits: pathKey → its first snapshot in that turn */
  lastTurn: { turn: number; files: Record<string, Snapshot> } | null
  toolUseIds: string[]
}

export interface EditLedgerOptions {
  /** <dataDir>/review/<sessionId> */
  dir: string
  now(): number
  onError(message: string): void
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const KINDS: readonly string[] = ['absent', 'blob', 'binary', 'too-large', 'unreadable']
const isSnapshot = (v: unknown): v is Snapshot =>
  isObj(v) && typeof v.path === 'string' && typeof v.at === 'number' && typeof v.toolUseId === 'string' &&
  typeof v.kind === 'string' && KINDS.includes(v.kind) && (v.sha === null || typeof v.sha === 'string')
const isSnapshots = (v: unknown): v is Record<string, Snapshot> => isObj(v) && Object.values(v).every(isSnapshot)

function isLedgerData(v: unknown): v is LedgerData {
  if (!isObj(v) || v.version !== 1 || typeof v.turn !== 'number' || !isSnapshots(v.session)) return false
  if (!Array.isArray(v.toolUseIds) || !v.toolUseIds.every((x) => typeof x === 'string')) return false
  const lt = v.lastTurn
  return lt === null || (isObj(lt) && typeof lt.turn === 'number' && isSnapshots(lt.files))
}

/** a NUL byte in the first 8000 bytes, as git tells binary files */
export const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0)
/** names a file's content: snapshots, and the Viewed marks of the Changes panel */
export const contentSha = (b: Buffer): string => createHash('sha1').update(b).digest('hex')

/**
 * The files of one session as they were before Claude's first change in the session and in its latest turn
 * with edits. Kept in <dir>/ledger.json and <dir>/blobs/<sha1>, so a resumed session gets them back.
 */
export class EditLedger {
  private data: LedgerData = { version: 1, turn: 0, session: {}, lastTurn: null, toolUseIds: [] }
  private readonly seen = new Set<string>()
  /** blobs that could not be written: the ledger keeps working in memory */
  private readonly memBlobs = new Map<string, Buffer>()
  private failed = false

  constructor(private readonly o: EditLedgerOptions) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!isLedgerData(raw)) return
    this.data = raw
    for (const id of raw.toolUseIds) this.seen.add(id)
  }

  private get file(): string {
    return join(this.o.dir, 'ledger.json')
  }

  private blobPath(sha: string): string {
    return join(this.o.dir, 'blobs', sha)
  }

  startTurn(): void {
    this.data.turn += 1
    this.save()
  }

  /** Records the file before tool use `toolUseId` changes it. The first record per session and per turn wins. */
  recordBefore(toolUseId: string, path: string, read: () => FileRead): void {
    if (this.seen.has(toolUseId)) return
    this.seen.add(toolUseId)
    this.data.toolUseIds.push(toolUseId)
    if (this.data.lastTurn?.turn !== this.data.turn) this.data.lastTurn = { turn: this.data.turn, files: {} }
    const turnFiles = this.data.lastTurn.files
    const key = pathKey(path)
    const needSession = !(key in this.data.session)
    const needTurn = !(key in turnFiles)
    if (needSession || needTurn) {
      const snap = this.snapshot(toolUseId, path, read())
      if (needSession) this.data.session[key] = snap
      if (needTurn) turnFiles[key] = snap
    }
    this.save()
  }

  sessionSnapshots(): Snapshot[] {
    return Object.values(this.data.session)
  }

  /** null until Claude edits something in this session */
  lastTurnSnapshots(): Snapshot[] | null {
    return this.data.lastTurn ? Object.values(this.data.lastTurn.files) : null
  }

  has(toolUseId: string): boolean {
    return this.seen.has(toolUseId)
  }

  blobSize(sha: string): number | null {
    const mem = this.memBlobs.get(sha)
    if (mem) return mem.length
    try {
      return statSync(this.blobPath(sha)).size
    } catch {
      return null
    }
  }

  readBlob(sha: string): Buffer | null {
    const mem = this.memBlobs.get(sha)
    if (mem) return mem
    try {
      return readFileSync(this.blobPath(sha))
    } catch {
      return null
    }
  }

  private snapshot(toolUseId: string, path: string, r: FileRead): Snapshot {
    const base = { path, at: this.o.now(), toolUseId }
    if (r.kind !== 'data') return { ...base, kind: r.kind, sha: null }
    if (r.data.length > MAX_SNAPSHOT_BYTES) return { ...base, kind: 'too-large', sha: null }
    const sha = contentSha(r.data)
    // a binary file is kept by its hash only: enough to tell that it did not change (an edit that was denied)
    if (isBinary(r.data)) return { ...base, kind: 'binary', sha }
    try {
      const p = this.blobPath(sha)
      if (!existsSync(p)) {
        mkdirSync(join(this.o.dir, 'blobs'), { recursive: true })
        writeFileSync(p, r.data)
      }
    } catch (e) {
      this.fail(e)
      this.memBlobs.set(sha, r.data)
    }
    return { ...base, kind: 'blob', sha }
  }

  private save(): void {
    try {
      mkdirSync(this.o.dir, { recursive: true })
      // write and rename: a crash never leaves half a file, and the folder's time shows it is in use
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown): void {
    if (this.failed) return
    this.failed = true
    this.o.onError(`cannot save Claude's edits in ${this.o.dir}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/edit-ledger.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 4: The git source

**Files:**
- Create: `src/main/git-source.ts`
- Test: `tests/integration/git-source.int.test.ts`

**Interfaces:**
- Produces:
  - `interface GitResult { code: number; stdout: Buffer; stderr: string }`
  - `type GitRun = (args: string[], cwd: string, input?: string) => Promise<GitResult>`
  - `class GitError extends Error`
  - `GIT_TIMEOUT_MS = 10_000`, `EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'`
  - `execGit: GitRun`
  - `repoRoot(run: GitRun, cwd: string): Promise<string | null>`
  - `verifyRef(run: GitRun, root: string, ref: string): Promise<string>`
  - `headOrEmpty(run: GitRun, root: string): Promise<string>`
  - `type ChangeStatus = 'added' | 'modified' | 'deleted'`, `interface GitChange { path: string; status: ChangeStatus }`
  - `changedFiles(run: GitRun, root: string, from: string, to: string | null, paths: string[]): Promise<GitChange[]>`
  - `type RevInfo = { kind: 'blob'; id: string; size: number } | { kind: 'absent' } | { kind: 'dir' }`
  - `revisionInfo(run: GitRun, root: string, rev: string, paths: string[]): Promise<Map<string, RevInfo>>`
  - `readBlobs(run: GitRun, root: string, ids: string[]): Promise<Map<string, Buffer>>`

- [ ] **Step 1: Write the failing integration tests**

`tests/integration/git-source.int.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changedFiles, EMPTY_TREE, execGit, GitError, headOrEmpty, readBlobs, repoRoot, revisionInfo, verifyRef } from '../../src/main/git-source'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-git-'))
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'core.autocrlf', 'false')
  return dir
}
const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
const commitAll = (dir: string, msg: string): void => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg) }
const rel = (dir: string, changes: { path: string; status: string }[]) =>
  changes.map((c) => [c.path.slice(dir.length + 1).split('\\').join('/'), c.status]).sort()

describe('git source', () => {
  it('finds the root from a subfolder, and null outside a repository', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    expect(await repoRoot(execGit, join(dir, 'src'))).toBe(dir)
    const outside = mkdtempSync(join(tmpdir(), 'ct-nogit-'))
    expect(await repoRoot(execGit, outside)).toBeNull()
    expect(await repoRoot(execGit, join(outside, 'missing'))).toBeNull()
  })

  it('lists modified, added, untracked and deleted files against HEAD', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'a\n')
    writeFileSync(join(dir, 'gone.ts'), 'g\n')
    commitAll(dir, 'one')
    writeFileSync(join(dir, 'a.ts'), 'A\n')
    rmSync(join(dir, 'gone.ts'))
    writeFileSync(join(dir, 'staged.ts'), 's\n')
    git(dir, 'add', 'staged.ts')
    writeFileSync(join(dir, 'new.ts'), 'n\n')
    expect(rel(dir, await changedFiles(execGit, dir, 'HEAD', null, []))).toEqual([
      ['a.ts', 'modified'], ['gone.ts', 'deleted'], ['new.ts', 'added'], ['staged.ts', 'added']
    ])
  })

  it('compares two revisions and limits to paths, taking them literally', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'x[1].ts'), '1\n')
    writeFileSync(join(dir, 'src', 'x1.ts'), '1\n')
    writeFileSync(join(dir, 'b.ts'), '1\n')
    commitAll(dir, 'one')
    writeFileSync(join(dir, 'src', 'x[1].ts'), '2\n')
    writeFileSync(join(dir, 'src', 'x1.ts'), '2\n')
    writeFileSync(join(dir, 'b.ts'), '2\n')
    commitAll(dir, 'two')
    expect(rel(dir, await changedFiles(execGit, dir, 'HEAD~1', 'HEAD', [join(dir, 'src', 'x[1].ts')]))).toEqual([['src/x[1].ts', 'modified']])
    expect(rel(dir, await changedFiles(execGit, dir, 'HEAD~1', 'HEAD', [join(dir, 'src')]))).toEqual([['src/x1.ts', 'modified'], ['src/x[1].ts', 'modified']])
    await expect(changedFiles(execGit, dir, 'HEAD~1', 'HEAD', [mkdtempSync(join(tmpdir(), 'ct-out-'))])).rejects.toThrow(GitError)
  })

  it('a file with a Cyrillic name keeps its name and content', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'отчёты'))
    const file = join(dir, 'отчёты', 'итоги.md')
    writeFileSync(file, 'было\n')
    commitAll(dir, 'one')
    writeFileSync(file, 'стало\n')
    const changes = await changedFiles(execGit, dir, 'HEAD', null, [])
    expect(changes).toEqual([{ path: file, status: 'modified' }])
    const info = await revisionInfo(execGit, dir, 'HEAD', [file])
    const blob = info.get(file)
    expect(blob?.kind).toBe('blob')
    const blobs = await readBlobs(execGit, dir, [blob?.kind === 'blob' ? blob.id : ''])
    expect([...blobs.values()][0]!.toString('utf8')).toBe('было\n')
  })

  it('reads sizes and blobs in one go; absent files and folders are told apart', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'hello')
    writeFileSync(join(dir, 'b.txt'), 'world!')
    mkdirSync(join(dir, 'd'))
    writeFileSync(join(dir, 'd', 'x'), 'x')
    commitAll(dir, 'one')
    const info = await revisionInfo(execGit, dir, 'HEAD', [join(dir, 'a.txt'), join(dir, 'b.txt'), join(dir, 'none.txt'), join(dir, 'd')])
    expect([...info.values()].map((i) => (i.kind === 'blob' ? ['blob', i.size] : [i.kind]))).toEqual([['blob', 5], ['blob', 6], ['absent'], ['dir']])
    const ids = [...info.values()].flatMap((i) => (i.kind === 'blob' ? [i.id] : []))
    const blobs = await readBlobs(execGit, dir, ids)
    expect(ids.map((id) => blobs.get(id)!.toString())).toEqual(['hello', 'world!'])
  })

  it('verifies refs, refuses options, and uses the empty tree before the first commit', async () => {
    const dir = repo()
    expect(await headOrEmpty(execGit, dir)).toBe(EMPTY_TREE)
    writeFileSync(join(dir, 'a.ts'), 'a\n')
    expect(await changedFiles(execGit, dir, EMPTY_TREE, null, [])).toEqual([{ path: join(dir, 'a.ts'), status: 'added' }])
    commitAll(dir, 'one')
    expect(await verifyRef(execGit, dir, 'HEAD')).toMatch(/^[0-9a-f]{40}$/)
    await expect(verifyRef(execGit, dir, 'mastr')).rejects.toThrow('unknown revision: mastr')
    await expect(verifyRef(execGit, dir, '--output=x')).rejects.toThrow('unknown revision: --output=x')
  })

  it('does not list a file whose only difference is autocrlf conversion', async () => {
    const dir = repo()
    git(dir, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(dir, 'a.ts'), 'one\r\ntwo\r\n')
    commitAll(dir, 'one')
    expect(await changedFiles(execGit, dir, 'HEAD', null, [])).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/git-source.int.test.ts`
Expected: FAIL — cannot find module `git-source`.

- [ ] **Step 3: Write the git source**

`src/main/git-source.ts`:

```ts
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface GitResult {
  code: number
  stdout: Buffer
  stderr: string
}

export type GitRun = (args: string[], cwd: string, input?: string) => Promise<GitResult>

export class GitError extends Error {}

export const GIT_TIMEOUT_MS = 10_000
/** git's id of the empty tree: what a repository without commits is compared with */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_OUTPUT = 64 * 1024 * 1024

/** git without a shell; stdout raw (paths and contents are bytes), a time limit, input on stdin */
export const execGit: GitRun = (args, cwd, input) =>
  new Promise((done, fail) => {
    const name = args.find((a) => !a.startsWith('-')) ?? 'git'
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let size = 0
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      fail(new GitError(`git ${name} took longer than ${GIT_TIMEOUT_MS / 1000} s`))
    }, GIT_TIMEOUT_MS)
    child.stdout.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_OUTPUT) {
        child.kill()
        fail(new GitError(`git ${name}: output too large`))
        return
      }
      out.push(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4096) err += c.toString('utf8')
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      fail(e.code === 'ENOENT' ? new GitError('git was not found') : new GitError(`cannot run git: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err })
    })
    child.stdin.on('error', () => { /* git exited before reading everything */ })
    child.stdin.end(input ?? '')
  })

/** the work tree root holding `cwd`; null outside a repository or when the folder is gone */
export async function repoRoot(run: GitRun, cwd: string): Promise<string | null> {
  // spawning in a missing folder fails like a missing git
  if (!existsSync(cwd)) return null
  const r = await run(['rev-parse', '--show-toplevel'], cwd)
  const out = r.stdout.toString('utf8').trim()
  return r.code === 0 && out ? resolve(out) : null
}

/** the commit a revision names; GitError "unknown revision: <ref>" when there is none */
export async function verifyRef(run: GitRun, root: string, ref: string): Promise<string> {
  if (ref.startsWith('-')) throw new GitError(`unknown revision: ${ref}`)
  const r = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], root)
  const sha = r.stdout.toString('utf8').trim()
  if (r.code !== 0 || !sha) throw new GitError(`unknown revision: ${ref}`)
  return sha
}

/** HEAD's commit, or the empty tree in a repository without commits */
export async function headOrEmpty(run: GitRun, root: string): Promise<string> {
  try {
    return await verifyRef(run, root, 'HEAD')
  } catch (e) {
    if (e instanceof GitError && e.message.startsWith('unknown revision')) return EMPTY_TREE
    throw e
  }
}

export type ChangeStatus = 'added' | 'modified' | 'deleted'

export interface GitChange {
  /** absolute */
  path: string
  status: ChangeStatus
}

/** paths inside the work tree, relative to its root with / */
function toSpecs(root: string, paths: string[]): string[] {
  return paths.map((p) => {
    const r = relative(root, p)
    if (r.startsWith('..') || isAbsolute(r)) throw new GitError(`outside the repository: ${p}`)
    return r === '' ? '.' : r.split(sep).join('/')
  })
}

/** Files that differ between `from` and `to` — the work tree, untracked files included, when `to` is null. */
export async function changedFiles(run: GitRun, root: string, from: string, to: string | null, paths: string[]): Promise<GitChange[]> {
  const specs = toSpecs(root, paths)
  // --literal-pathspecs: a file named x[1].ts is that file, not a pattern
  const diff = await run(['--literal-pathspecs', 'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', from, ...(to ? [to] : []), '--', ...specs], root)
  if (diff.code !== 0) throw new GitError(`git diff failed: ${diff.stderr.trim()}`)
  const parts = diff.stdout.toString('utf8').split('\0')
  const changes: GitChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]!
    const rel = parts[i + 1]!
    if (!code || !rel) continue
    changes.push({ path: resolve(root, rel), status: code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'modified' })
  }
  if (to === null) {
    const untracked = await run(['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...specs], root)
    if (untracked.code !== 0) throw new GitError(`git ls-files failed: ${untracked.stderr.trim()}`)
    for (const rel of untracked.stdout.toString('utf8').split('\0')) if (rel) changes.push({ path: resolve(root, rel), status: 'added' })
  }
  return changes
}

export type RevInfo = { kind: 'blob'; id: string; size: number } | { kind: 'absent' } | { kind: 'dir' }

/** What each path is in `rev`, with blob sizes: one `git cat-file --batch-check`. */
export async function revisionInfo(run: GitRun, root: string, rev: string, paths: string[]): Promise<Map<string, RevInfo>> {
  const info = new Map<string, RevInfo>()
  if (paths.length === 0) return info
  const specs = toSpecs(root, paths)
  const r = await run(['cat-file', '--batch-check'], root, specs.map((s) => `${rev}:${s}\n`).join(''))
  if (r.code !== 0) throw new GitError(`git cat-file failed: ${r.stderr.trim()}`)
  const lines = r.stdout.toString('utf8').split('\n')
  paths.forEach((p, i) => {
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(lines[i] ?? '')
    if (!m) info.set(p, { kind: 'absent' })
    else if (m[2] === 'blob') info.set(p, { kind: 'blob', id: m[1]!, size: Number(m[3]) })
    else info.set(p, { kind: 'dir' }) // a tree, or a submodule's commit
  })
  return info
}

/** Blob contents by id: one `git cat-file --batch`. */
export async function readBlobs(run: GitRun, root: string, ids: string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>()
  if (ids.length === 0) return blobs
  const r = await run(['cat-file', '--batch'], root, ids.map((id) => `${id}\n`).join(''))
  if (r.code !== 0) throw new GitError(`git cat-file failed: ${r.stderr.trim()}`)
  const out = r.stdout
  let pos = 0
  for (const id of ids) {
    const nl = out.indexOf(0x0a, pos)
    if (nl < 0) throw new GitError('git cat-file returned less than asked')
    const m = /^[0-9a-f]+ \w+ (\d+)$/.exec(out.subarray(pos, nl).toString('utf8'))
    if (!m) throw new GitError('git cat-file returned an unexpected header')
    const size = Number(m[1])
    blobs.set(id, Buffer.from(out.subarray(nl + 1, nl + 1 + size)))
    pos = nl + 1 + size + 1
  }
  return blobs
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/git-source.int.test.ts && npm run typecheck`
Expected: PASS. On Windows, check `repoRoot(...)` against `dir`: git prints `C:/…`, and `resolve` turns it into `C:\…`. If the temp folder is an 8.3 short path (`RUNNER~1`), compare with `realpathSync.native(dir)` in the test instead.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 5: Building a file's diff

**Files:**
- Modify: `package.json`, `package-lock.json` (dev dependencies `diff`, `cross-spawn`, `@types/cross-spawn`)
- Create: `src/main/review-diff.ts`
- Test: `tests/unit/review-diff.test.ts`

**Interfaces:**
- Consumes: `ReviewFile`, `ReviewFileNote`, `ReviewFileStatus`, `ReviewHunk`, `ReviewLine` from `src/shared/review.ts`; `isBinary`, `contentSha` from `src/main/edit-ledger.ts` (Task 3: one binary rule and one content hash for the ledger and the diff).
- Produces:
  - constants `MAX_SIDE_BYTES = 1024 * 1024`, `MAX_FORCED_BYTES = 10 * 1024 * 1024`, `MAX_FILES = 500`, `MAX_TOTAL_BYTES = 5 * 1024 * 1024`
  - `type Side = { kind: 'data'; data: Buffer } | { kind: 'absent' } | { kind: 'binary' } | { kind: 'too-large'; size: number } | { kind: 'dir' } | { kind: 'none' } | { kind: 'unreadable' } | { kind: 'skipped' }`
  - `interface DiffInput { path: string; relPath: string; before: Side; after: Side; forced: boolean; status?: ReviewFileStatus }`
  - `normalizeEol(s: string): string`
  - `toHunks(before: string, after: string): { hunks: ReviewHunk[]; additions: number; deletions: number }`
  - `buildFile(input: DiffInput): ReviewFile | null`

- [ ] **Step 1: Add the dependencies**

Run: `npm install --save-dev diff cross-spawn @types/cross-spawn`
Expected: `package.json` lists them under `devDependencies`; `node_modules/diff/package.json` exists. `diff` ships its own types (v8+). If the installed major is below 8, also run `npm install --save-dev @types/diff`.

- [ ] **Step 2: Write the failing tests**

`tests/unit/review-diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildFile, MAX_FORCED_BYTES, toHunks, type DiffInput, type Side } from '../../src/main/review-diff'

const text = (s: string): Side => ({ kind: 'data', data: Buffer.from(s) })
const input = (before: Side, after: Side, o: Partial<DiffInput> = {}): DiffInput => ({ path: '/r/a.ts', relPath: 'a.ts', before, after, forced: false, ...o })

describe('toHunks', () => {
  it('numbers the lines on both sides and counts the changes', () => {
    const r = toHunks('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n')
    expect(r.additions).toBe(2)
    expect(r.deletions).toBe(1)
    expect(r.hunks).toHaveLength(1)
    expect(r.hunks[0]!.header).toBe('@@ -1,3 +1,4 @@')
    expect(r.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'one', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'two', oldNo: 2, newNo: null },
      { kind: 'add', text: 'TWO', oldNo: null, newNo: 2 },
      { kind: 'context', text: 'three', oldNo: 3, newNo: 3 },
      { kind: 'add', text: 'four', oldNo: null, newNo: 4 }
    ])
  })

  it('leaves out the "no newline at end of file" marker', () => {
    const r = toHunks('a', 'b')
    expect(r.hunks[0]!.lines.map((l) => l.kind)).toEqual(['del', 'add'])
  })
})

describe('buildFile', () => {
  it('shows a change and hashes the new side', () => {
    const f = buildFile(input(text('a\n'), text('b\n')))!
    expect(f).toMatchObject({ status: 'modified', additions: 1, deletions: 1, note: null, canForce: false, viewed: false })
    expect(f.hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('hides a file whose sides are equal, and reports line endings as the only change', () => {
    expect(buildFile(input(text('a\nb\n'), text('a\nb\n')))).toBeNull()
    expect(buildFile(input(text('a\r\nb\r\n'), text('a\nb\n')))).toMatchObject({ note: 'eol-only', hunks: [] })
  })

  it('compares CRLF and LF sides by their content', () => {
    const f = buildFile(input(text('a\r\nb\r\n'), text('a\nB\n')))!
    expect(f.hunks[0]!.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['context:a', 'del:b', 'add:B'])
  })

  it('tells added and deleted files, and drops a file absent on both sides', () => {
    expect(buildFile(input({ kind: 'absent' }, text('x\n')))).toMatchObject({ status: 'added', additions: 1 })
    expect(buildFile(input(text('x\n'), { kind: 'absent' }))).toMatchObject({ status: 'deleted', deletions: 1, hash: 'absent' })
    expect(buildFile(input({ kind: 'absent' }, text('')))).toMatchObject({ status: 'added', hunks: [] })
    expect(buildFile(input({ kind: 'absent' }, { kind: 'absent' }))).toBeNull()
  })

  it('gives a row instead of hunks for binary, no baseline, submodule, unreadable and skipped files', () => {
    expect(buildFile(input(text('a'), { kind: 'data', data: Buffer.from([0, 1]) }))!.note).toBe('binary')
    expect(buildFile(input({ kind: 'binary' }, text('a')))!.note).toBe('binary')
    expect(buildFile(input({ kind: 'none' }, text('a')))!.note).toBe('no-baseline')
    expect(buildFile(input(text('a'), { kind: 'dir' }))!.note).toBe('submodule')
    expect(buildFile(input(text('a'), { kind: 'unreadable' }))!.note).toBe('unreadable')
    expect(buildFile(input({ kind: 'skipped' }, { kind: 'skipped' }, { status: 'deleted' }))).toMatchObject({ note: 'too-many', status: 'deleted' })
  })

  it('offers "show anyway" for a too large file up to 10 MB, unless it was already asked for', () => {
    expect(buildFile(input({ kind: 'too-large', size: 2_000_000 }, text('a')))).toMatchObject({ note: 'too-large', canForce: true })
    expect(buildFile(input({ kind: 'too-large', size: MAX_FORCED_BYTES + 1 }, text('a')))).toMatchObject({ note: 'too-large', canForce: false })
    expect(buildFile(input({ kind: 'too-large', size: 2_000_000 }, text('a'), { forced: true }))).toMatchObject({ note: 'too-large', canForce: false })
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/review-diff.test.ts`
Expected: FAIL — cannot find module `review-diff`.

- [ ] **Step 4: Write the diff builder**

`src/main/review-diff.ts`:

```ts
import { structuredPatch } from 'diff'
import type { ReviewFile, ReviewFileStatus, ReviewHunk, ReviewLine } from '../shared/review'
import { contentSha, isBinary } from './edit-ledger'

/** a side larger than this shows "too large" */
export const MAX_SIDE_BYTES = 1024 * 1024
/** "show anyway" builds sides up to this size */
export const MAX_FORCED_BYTES = 10 * 1024 * 1024
/** a view with more files lists them without reading them */
export const MAX_FILES = 500
/** a view reads at most about this much text */
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024

/** one side of a file in a view */
export type Side =
  | { kind: 'data'; data: Buffer }
  | { kind: 'absent' }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'dir' }
  /** no baseline could be found (the before side of Claude's edits) */
  | { kind: 'none' }
  | { kind: 'unreadable' }
  /** not read: the view is over its limits */
  | { kind: 'skipped' }

export interface DiffInput {
  path: string
  relPath: string
  before: Side
  after: Side
  /** "show anyway" was asked for this file */
  forced: boolean
  /** git's status, for files whose sides were not read */
  status?: ReviewFileStatus
}

export const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n')
/** names the current content for Viewed; a too large file is named by its size, so a change still clears the mark */
const hashOf = (s: Side): string => (s.kind === 'data' ? contentSha(s.data) : s.kind === 'too-large' ? `too-large:${s.size}` : s.kind)

export function toHunks(before: string, after: string): { hunks: ReviewHunk[]; additions: number; deletions: number } {
  const patch = structuredPatch('a', 'b', before, after, '', '', { context: 3 })
  let additions = 0
  let deletions = 0
  const hunks = patch.hunks.map((h): ReviewHunk => {
    let oldNo = h.oldStart
    let newNo = h.newStart
    const lines: ReviewLine[] = []
    for (const l of h.lines) {
      const text = l.slice(1)
      if (l[0] === '+') {
        lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ })
        additions++
      } else if (l[0] === '-') {
        lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null })
        deletions++
      } else if (l[0] === ' ') {
        lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ })
      }
      // '\ No newline at end of file' is not a line
    }
    return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines }
  })
  return { hunks, additions, deletions }
}

/** The review entry for one file; null when there is nothing to show (both sides the same, or absent). */
export function buildFile(input: DiffInput): ReviewFile | null {
  const { before, after } = input
  if (before.kind === 'absent' && after.kind === 'absent') return null
  const status: ReviewFileStatus = input.status ?? (before.kind === 'absent' ? 'added' : after.kind === 'absent' ? 'deleted' : 'modified')
  const file: ReviewFile = {
    path: input.path, relPath: input.relPath, status, additions: 0, deletions: 0, hunks: [], note: null, canForce: false, hash: hashOf(after), viewed: false
  }
  const kinds = [before.kind, after.kind]
  if (kinds.includes('skipped')) return { ...file, note: 'too-many' }
  if (before.kind === 'none') return { ...file, note: 'no-baseline' }
  if (kinds.includes('unreadable')) return { ...file, note: 'unreadable' }
  if (kinds.includes('dir')) return { ...file, note: 'submodule' }
  if (kinds.includes('binary')) return { ...file, note: 'binary' }
  if (before.kind === 'too-large' || after.kind === 'too-large') {
    const fits = [before, after].every((s) => s.kind !== 'too-large' || s.size <= MAX_FORCED_BYTES)
    return { ...file, note: 'too-large', canForce: fits && !input.forced }
  }
  const b = before.kind === 'data' ? before.data : Buffer.alloc(0)
  const a = after.kind === 'data' ? after.data : Buffer.alloc(0)
  if (isBinary(b) || isBinary(a)) return { ...file, note: 'binary' }
  const bt = normalizeEol(b.toString('utf8'))
  const at = normalizeEol(a.toString('utf8'))
  if (status === 'modified' && bt === at) return b.equals(a) ? null : { ...file, note: 'eol-only' }
  return { ...file, ...toHunks(bt, at) }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/review-diff.test.ts && npm run typecheck`
Expected: PASS. If jsdiff numbers an empty old side's hunk `-0,0`, the "added" expectations above still hold (only the new side is checked).

- [ ] **Step 6: Leave uncommitted.**

---

### Task 6: The inputs of a view

**Files:**
- Create: `src/main/review-sources.ts`
- Test: `tests/unit/review-sources.test.ts`, `tests/integration/review-sources.int.test.ts`

**Interfaces:**
- Consumes:
  - `historyBaseline`, `HistoryEdit` (Task 2);
  - `Snapshot`, `FileRead`, `MAX_SNAPSHOT_BYTES`, `contentSha` (Task 3);
  - `changedFiles`, `revisionInfo`, `readBlobs`, `repoRoot`, `verifyRef`, `headOrEmpty`, `execGit`, `GitRun`, `RevInfo`, `GitChange` (Task 4);
  - `Side`, `DiffInput`, the limits (Task 5);
  - `pathKey` from `path-key.ts`.
- Produces:
  - `type DiskInfo = { kind: 'file'; size: number } | { kind: 'absent' } | { kind: 'dir' } | { kind: 'unreadable' }`
  - `interface SourceIo { git: GitRun; diskInfo(path: string): DiskInfo; readDisk(path: string): Buffer | null }`, and `nodeIo: SourceIo`
  - `interface LedgerView { sessionSnapshots(): Snapshot[]; lastTurnSnapshots(): Snapshot[] | null; has(toolUseId: string): boolean; blobSize(sha: string): number | null; readBlob(sha: string): Buffer | null }`, and `EMPTY_LEDGER: LedgerView` (`EditLedger` satisfies `LedgerView`)
  - `interface TranscriptLog { prompts: number[]; edits: HistoryEdit[] }`
  - `interface Inputs { inputs: DiffInput[]; tooMany: boolean }`
  - `relPathFor(base: string, path: string): string`
  - `readForSnapshot(io: SourceIo, path: string): FileRead`
  - `gitInputs(io: SourceIo, root: string, from: string, to: string | null, paths: string[], forced: (path: string) => boolean): Promise<Inputs>`
  - `ledgerInputs(io: SourceIo, ledger: LedgerView, log: TranscriptLog, scope: 'last_turn' | 'session', base: string, forced: (path: string) => boolean): Inputs` — leaves out a file whose content on disk still has its snapshot's `sha` (a denied edit), binary and over-1-MB files included
  - `interface ReviewSources { root(cwd: string): Promise<{ root: string } | { root: null; problem: string }>; verify(root: string, ref: string): Promise<void>; head(root: string): Promise<string>; git(root: string, from: string, to: string | null, paths: string[], forced: (path: string) => boolean): Promise<Inputs>; ledger(ledger: LedgerView, log: TranscriptLog, scope: 'last_turn' | 'session', base: string, forced: (path: string) => boolean): Inputs; read(path: string): FileRead }`
  - `createSources(io: SourceIo): ReviewSources`

- [ ] **Step 1: Write the failing unit tests (Claude's edits)**

`tests/unit/review-sources.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HistoryEdit } from '../../src/main/baselines'
import { EditLedger } from '../../src/main/edit-ledger'
import { EMPTY_LEDGER, ledgerInputs, readForSnapshot, relPathFor, type SourceIo, type TranscriptLog } from '../../src/main/review-sources'

const BASE = process.platform === 'win32' ? 'D:\\proj' : '/proj'
const P = (rel: string): string => join(BASE, rel)

/** an in-memory disk */
function io(files: Record<string, string | Buffer>): SourceIo {
  const get = (p: string): string | Buffer | undefined => files[p]
  return {
    git: async () => { throw new Error('no git here') },
    diskInfo: (p) => {
      const f = get(p)
      return f === undefined ? { kind: 'absent' } : { kind: 'file', size: Buffer.byteLength(f) }
    },
    readDisk: (p) => {
      const f = get(p)
      return f === undefined ? null : Buffer.from(f)
    }
  }
}
const newLedger = (): EditLedger => new EditLedger({ dir: join(mkdtempSync(join(tmpdir(), 'ct-src-')), 'sid'), now: () => 1000, onError: () => {} })
const edit = (o: Partial<HistoryEdit>): HistoryEdit => ({ at: 1, toolUseId: 't', path: P('a.ts'), created: false, originalFile: null, patch: [], ...o })
const noLog: TranscriptLog = { prompts: [], edits: [] }
const sides = (r: ReturnType<typeof ledgerInputs>) =>
  r.inputs.map((i) => [i.relPath, i.before.kind === 'data' ? i.before.data.toString() : i.before.kind, i.after.kind === 'data' ? i.after.data.toString() : i.after.kind])

describe('ledgerInputs', () => {
  it('compares the session snapshots with the files on disk', () => {
    const l = newLedger()
    l.startTurn()
    l.recordBefore('t1', P('src/a.ts'), () => ({ kind: 'data', data: Buffer.from('old\n') }))
    l.recordBefore('t2', P('new.ts'), () => ({ kind: 'absent' }))
    const r = ledgerInputs(io({ [P('src/a.ts')]: 'new\n', [P('new.ts')]: 'x\n' }), l, noLog, 'session', BASE, () => false)
    expect(sides(r)).toEqual([['new.ts', 'absent', 'x\n'], ['src/a.ts', 'old\n', 'new\n']])
    expect(r.tooMany).toBe(false)
  })

  it('uses the last turn with edits for last_turn', () => {
    const l = newLedger()
    l.startTurn()
    l.recordBefore('t1', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('v1\n') }))
    l.startTurn()
    l.recordBefore('t2', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('v2\n') }))
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'v3\n' }), l, noLog, 'last_turn', BASE, () => false))).toEqual([['a.ts', 'v2\n', 'v3\n']])
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'v3\n' }), l, noLog, 'session', BASE, () => false))).toEqual([['a.ts', 'v1\n', 'v3\n']])
  })

  it('falls back to the transcript for edits the ledger never saw', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v1', '+v2'] }
    const log: TranscriptLog = { prompts: [0], edits: [edit({ at: 10, toolUseId: 'h1', patch: [hunk] })] }
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'v2\n' }), EMPTY_LEDGER, log, 'session', BASE, () => false))).toEqual([['a.ts', 'v1\n', 'v2\n']])
  })

  it('undoes history edits from the first snapshot, and ignores unrecorded edits after it', () => {
    const l = newLedger()
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v1', '+v2'] }
    // t1 ran before ClaudeTerm watched; t2 was recorded at 1000 with the file at v2; h3 at 2000 slipped past the hook
    l.recordBefore('t2', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('v2\n') }))
    const log: TranscriptLog = { prompts: [], edits: [edit({ at: 10, toolUseId: 't1', patch: [hunk] }), edit({ at: 2000, toolUseId: 'h3', patch: [] })] }
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'v3\n' }), l, log, 'session', BASE, () => false))).toEqual([['a.ts', 'v1\n', 'v3\n']])
  })

  it.skipIf(process.platform !== 'win32')('paths that differ only in case are one file', () => {
    const l = newLedger()
    l.recordBefore('t1', 'D:\\proj\\A.ts', () => ({ kind: 'data', data: Buffer.from('v1\n') }))
    const log: TranscriptLog = { prompts: [], edits: [edit({ at: 5000, toolUseId: 'h9', path: 'd:\\proj\\a.ts' })] }
    expect(ledgerInputs(io({ 'D:\\proj\\A.ts': 'v2\n' }), l, log, 'session', BASE, () => false).inputs).toHaveLength(1)
  })

  it('takes the last transcript turn with edits when the ledger has none', () => {
    const h = (from: string, to: string) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${from}`, `+${to}`] }]
    const log: TranscriptLog = {
      prompts: [100, 200, 300],
      edits: [edit({ at: 150, toolUseId: 'a', path: P('a.ts'), patch: h('a1', 'a2') }), edit({ at: 250, toolUseId: 'b', path: P('b.ts'), patch: h('b1', 'b2') })]
    }
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'a2\n', [P('b.ts')]: 'b2\n' }), EMPTY_LEDGER, log, 'last_turn', BASE, () => false))).toEqual([['b.ts', 'b1\n', 'b2\n']])
  })

  it('marks big files too large unless forced, and stops reading past the view budget', () => {
    const big = 'x'.repeat(2_000_000)
    const l = newLedger()
    l.recordBefore('t1', P('big.txt'), () => ({ kind: 'absent' }))
    expect(ledgerInputs(io({ [P('big.txt')]: big }), l, noLog, 'session', BASE, () => false).inputs[0]!.after).toEqual({ kind: 'too-large', size: 2_000_000 })
    expect(ledgerInputs(io({ [P('big.txt')]: big }), l, noLog, 'session', BASE, () => true).inputs[0]!.after.kind).toBe('data')
    const many = newLedger()
    const files: Record<string, string> = {}
    for (let i = 0; i < 7; i++) {
      many.recordBefore(`t${i}`, P(`f${i}.txt`), () => ({ kind: 'absent' }))
      files[P(`f${i}.txt`)] = 'y'.repeat(900_000)
    }
    const r = ledgerInputs(io(files), many, noLog, 'session', BASE, () => false)
    expect(r.tooMany).toBe(true)
    expect(r.inputs.filter((i) => i.after.kind === 'skipped').length).toBeGreaterThan(0)
  })

  it('drops a file that still holds what its snapshot recorded (a denied edit), binary and big files too', () => {
    const l = newLedger()
    const png = Buffer.from([137, 80, 78, 71, 0, 1])
    const big = 'z'.repeat(2_000_000)
    l.recordBefore('t1', P('img.png'), () => ({ kind: 'data', data: png }))
    l.recordBefore('t2', P('big.txt'), () => ({ kind: 'data', data: Buffer.from(big) }))
    l.recordBefore('t3', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('same\n') }))
    expect(ledgerInputs(io({ [P('img.png')]: png, [P('big.txt')]: big, [P('a.ts')]: 'same\n' }), l, noLog, 'session', BASE, () => false).inputs).toEqual([])
    const changed = ledgerInputs(io({ [P('img.png')]: Buffer.from([137, 80, 78, 71, 0, 2]), [P('big.txt')]: big, [P('a.ts')]: 'same\n' }), l, noLog, 'session', BASE, () => false)
    expect(changed.inputs.map((i) => [i.relPath, i.before.kind])).toEqual([['img.png', 'binary']])
  })
})

describe('helpers', () => {
  it('relPathFor gives a /-path inside the base and the full path outside', () => {
    expect(relPathFor(BASE, P('src/a.ts'))).toBe('src/a.ts')
    const outside = process.platform === 'win32' ? 'E:\\x\\b.ts' : '/x/b.ts'
    expect(relPathFor(BASE, outside)).toBe(outside)
  })

  it('readForSnapshot reads small files and tells absent and too large ones', () => {
    const disk = io({ [P('a.ts')]: 'a' })
    expect(readForSnapshot(disk, P('a.ts'))).toEqual({ kind: 'data', data: Buffer.from('a') })
    expect(readForSnapshot(disk, P('none.ts'))).toEqual({ kind: 'absent' })
    const huge: SourceIo = { ...disk, diskInfo: () => ({ kind: 'file', size: 11 * 1024 * 1024 }) }
    expect(readForSnapshot(huge, P('a.ts'))).toEqual({ kind: 'too-large' })
  })
})
```

- [ ] **Step 2: Write the failing integration test (git)**

`tests/integration/review-sources.int.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSources, gitInputs, nodeIo } from '../../src/main/review-sources'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-rsrc-'))
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.ts'), 'one\n')
  writeFileSync(join(dir, 'big.txt'), 'b')
  git('add', '-A')
  git('commit', '-qm', 'one')
  return dir
}

describe('gitInputs', () => {
  it('reads HEAD and the work tree, untracked files and too large ones included', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'two\n')
    writeFileSync(join(dir, 'new.ts'), 'n\n')
    writeFileSync(join(dir, 'big.txt'), 'z'.repeat(1_100_000))
    const r = await gitInputs(nodeIo, dir, 'HEAD', null, [], () => false)
    const view = r.inputs.map((i) => [i.relPath, i.before.kind === 'data' ? i.before.data.toString() : i.before.kind, i.after.kind === 'data' ? i.after.data.toString().slice(0, 5) : i.after.kind])
    expect(view).toEqual([['a.ts', 'one\n', 'two\n'], ['big.txt', 'b', 'too-large'], ['new.ts', 'absent', 'n\n']])
    const forced = await gitInputs(nodeIo, dir, 'HEAD', null, [join(dir, 'big.txt')], () => true)
    expect(forced.inputs[0]!.after.kind).toBe('data')
  })

  it('createSources reports a folder outside git and a bad revision', async () => {
    const s = createSources(nodeIo)
    expect(await s.root(mkdtempSync(join(tmpdir(), 'ct-nogit-')))).toEqual({ root: null, problem: 'Not a git repository' })
    const dir = repo()
    await expect(s.verify(dir, 'nope')).rejects.toThrow('unknown revision: nope')
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/review-sources.test.ts tests/integration/review-sources.int.test.ts`
Expected: FAIL — cannot find module `review-sources`.

- [ ] **Step 4: Write the sources**

`src/main/review-sources.ts`:

```ts
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { historyBaseline, type HistoryEdit } from './baselines'
import { contentSha, MAX_SNAPSHOT_BYTES, type FileRead, type Snapshot } from './edit-ledger'
import { changedFiles, execGit, headOrEmpty, readBlobs, repoRoot, revisionInfo, verifyRef, type GitChange, type GitRun, type RevInfo } from './git-source'
import { pathKey } from './path-key'
import { MAX_FILES, MAX_FORCED_BYTES, MAX_SIDE_BYTES, MAX_TOTAL_BYTES, type DiffInput, type Side } from './review-diff'

export type DiskInfo = { kind: 'file'; size: number } | { kind: 'absent' } | { kind: 'dir' } | { kind: 'unreadable' }

export interface SourceIo {
  git: GitRun
  diskInfo(path: string): DiskInfo
  /** null when the file cannot be read now */
  readDisk(path: string): Buffer | null
}

export const nodeIo: SourceIo = {
  git: execGit,
  diskInfo: (p) => {
    try {
      const st = statSync(p)
      return st.isDirectory() ? { kind: 'dir' } : { kind: 'file', size: st.size }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unreadable' }
    }
  },
  readDisk: (p) => {
    try {
      return readFileSync(p)
    } catch {
      return null
    }
  }
}

/** what a view needs from the edit ledger */
export interface LedgerView {
  sessionSnapshots(): Snapshot[]
  lastTurnSnapshots(): Snapshot[] | null
  has(toolUseId: string): boolean
  blobSize(sha: string): number | null
  readBlob(sha: string): Buffer | null
}

export const EMPTY_LEDGER: LedgerView = { sessionSnapshots: () => [], lastTurnSnapshots: () => null, has: () => false, blobSize: () => null, readBlob: () => null }

/** Claude's edits as the session's transcripts tell them */
export interface TranscriptLog {
  /** when each prompt was written: the turn starts */
  prompts: number[]
  /** not sorted: subagent transcripts are read after the main one */
  edits: HistoryEdit[]
}

export interface Inputs {
  inputs: DiffInput[]
  /** some files were not read: the view is over its limits */
  tooMany: boolean
}

/** where a view's files come from; the hub's tests replace it */
export interface ReviewSources {
  root(cwd: string): Promise<{ root: string } | { root: null; problem: string }>
  verify(root: string, ref: string): Promise<void>
  head(root: string): Promise<string>
  git(root: string, from: string, to: string | null, paths: string[], forced: (path: string) => boolean): Promise<Inputs>
  ledger(ledger: LedgerView, log: TranscriptLog, scope: 'last_turn' | 'session', base: string, forced: (path: string) => boolean): Inputs
  /** the file as it is now, for a snapshot */
  read(path: string): FileRead
}

/** a path relative to the base with /, or the full path when it is outside */
export function relPathFor(base: string, path: string): string {
  const r = relative(base, path)
  return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : path
}

export function readForSnapshot(io: SourceIo, path: string): FileRead {
  const info = io.diskInfo(path)
  if (info.kind === 'absent') return { kind: 'absent' }
  if (info.kind !== 'file') return { kind: 'unreadable' }
  if (info.size > MAX_SNAPSHOT_BYTES) return { kind: 'too-large' }
  const data = io.readDisk(path)
  return data ? { kind: 'data', data } : { kind: 'unreadable' }
}

/** the bytes a view has read so far */
class Budget {
  private used = 0
  exhausted = false

  take(bytes: number): boolean {
    if (this.exhausted) return false
    if (this.used > 0 && this.used + bytes > MAX_TOTAL_BYTES) {
      this.exhausted = true
      return false
    }
    this.used += bytes
    return true
  }
}

const limitOf = (forced: boolean): number => (forced ? MAX_FORCED_BYTES : MAX_SIDE_BYTES)

function sized(size: number, forced: boolean, budget: Budget, read: () => Buffer | null): Side {
  if (size > limitOf(forced)) return { kind: 'too-large', size }
  if (!budget.take(size)) return { kind: 'skipped' }
  const data = read()
  return data ? { kind: 'data', data } : { kind: 'unreadable' }
}

function diskSide(io: SourceIo, path: string, forced: boolean, budget: Budget): Side {
  const info = io.diskInfo(path)
  if (info.kind === 'absent') return { kind: 'absent' }
  if (info.kind === 'dir') return { kind: 'dir' }
  if (info.kind === 'unreadable') return { kind: 'unreadable' }
  return sized(info.size, forced, budget, () => io.readDisk(path))
}

const byPath = <T extends { path: string }>(a: T, b: T): number => a.path.localeCompare(b.path)

export async function gitInputs(io: SourceIo, root: string, from: string, to: string | null, paths: string[], forced: (path: string) => boolean): Promise<Inputs> {
  const changes = (await changedFiles(io.git, root, from, to, paths)).sort(byPath)
  const skipped = (c: GitChange): DiffInput => ({ path: c.path, relPath: relPathFor(root, c.path), before: { kind: 'skipped' }, after: { kind: 'skipped' }, forced: false, status: c.status })
  if (changes.length > MAX_FILES) return { inputs: changes.map(skipped), tooMany: true }
  const all = changes.map((c) => c.path)
  const before = await revisionInfo(io.git, root, from, all)
  const after = to === null ? null : await revisionInfo(io.git, root, to, all)
  const budget = new Budget()
  const ids = new Set<string>()
  type Planned = Side | { kind: 'blob'; id: string }
  const plan = (info: RevInfo | undefined, f: boolean): Planned => {
    if (!info || info.kind === 'absent') return { kind: 'absent' }
    if (info.kind === 'dir') return { kind: 'dir' }
    if (info.size > limitOf(f)) return { kind: 'too-large', size: info.size }
    if (!budget.take(info.size)) return { kind: 'skipped' }
    ids.add(info.id)
    return { kind: 'blob', id: info.id }
  }
  const planned = changes.map((c) => {
    const f = forced(c.path)
    return { c, f, b: plan(before.get(c.path), f), a: after ? plan(after.get(c.path), f) : diskSide(io, c.path, f, budget) }
  })
  const blobs = await readBlobs(io.git, root, [...ids])
  const side = (p: Planned): Side => (p.kind === 'blob' ? { kind: 'data', data: blobs.get(p.id) ?? Buffer.alloc(0) } : p)
  return {
    inputs: planned.map(({ c, f, b, a }) => ({ path: c.path, relPath: relPathFor(root, c.path), before: side(b), after: side(a), forced: f, status: c.status })),
    tooMany: budget.exhausted
  }
}

interface FileHistory {
  path: string
  /** the ledger's first snapshot of the file in the view */
  snap: Snapshot | null
  /** edits the ledger did not see, before that snapshot, oldest first */
  history: HistoryEdit[]
}

function groupByFile(edits: HistoryEdit[]): Map<string, HistoryEdit[]> {
  const out = new Map<string, HistoryEdit[]>()
  for (const e of [...edits].sort((a, b) => a.at - b.at)) {
    const key = pathKey(e.path)
    const list = out.get(key)
    if (list) list.push(e)
    else out.set(key, [e])
  }
  return out
}

function sessionFiles(ledger: LedgerView, log: TranscriptLog): FileHistory[] {
  const snaps = new Map(ledger.sessionSnapshots().map((s) => [pathKey(s.path), s]))
  const unrecorded = groupByFile(log.edits.filter((e) => !ledger.has(e.toolUseId)))
  const out: FileHistory[] = []
  for (const key of new Set([...snaps.keys(), ...unrecorded.keys()])) {
    const snap = snaps.get(key) ?? null
    const edits = unrecorded.get(key) ?? []
    // an edit the hook missed after the first snapshot changes nothing: the snapshot is the session's start
    const history = edits.filter((e) => snap === null || e.at < snap.at)
    out.push({ path: snap?.path ?? edits[0]!.path, snap, history })
  }
  return out
}

function lastTurnFiles(ledger: LedgerView, log: TranscriptLog): FileHistory[] {
  const snaps = ledger.lastTurnSnapshots()
  if (snaps !== null) return snaps.map((s) => ({ path: s.path, snap: s, history: [] }))
  const prompts = [...log.prompts].sort((a, b) => a - b)
  const turnOf = (at: number): number => prompts.filter((p) => p <= at).length
  const edits = log.edits.filter((e) => !ledger.has(e.toolUseId))
  if (edits.length === 0) return []
  const last = Math.max(...edits.map((e) => turnOf(e.at)))
  return [...groupByFile(edits.filter((e) => turnOf(e.at) === last)).values()].map((h) => ({ path: h[0]!.path, snap: null, history: h }))
}

function snapSide(ledger: LedgerView, snap: Snapshot, forced: boolean, budget: Budget): Side {
  switch (snap.kind) {
    case 'absent': return { kind: 'absent' }
    case 'binary': return { kind: 'binary' }
    case 'too-large': return { kind: 'too-large', size: Number.POSITIVE_INFINITY }
    case 'unreadable': return { kind: 'none' }
    case 'blob': {
      const size = snap.sha ? ledger.blobSize(snap.sha) : null
      if (size === null || !snap.sha) return { kind: 'none' }
      const side = sized(size, forced, budget, () => ledger.readBlob(snap.sha!))
      return side.kind === 'unreadable' ? { kind: 'none' } : side
    }
  }
}

function snapText(ledger: LedgerView, snap: Snapshot): string | null {
  if (snap.kind !== 'blob' || !snap.sha) return null
  return ledger.readBlob(snap.sha)?.toString('utf8') ?? null
}

function diskText(io: SourceIo, path: string): string | null {
  const info = io.diskInfo(path)
  if (info.kind !== 'file' || info.size > MAX_FORCED_BYTES) return null
  return io.readDisk(path)?.toString('utf8') ?? null
}

function beforeSide(io: SourceIo, ledger: LedgerView, f: FileHistory, forced: boolean, budget: Budget): Side {
  if (f.history.length === 0) return f.snap ? snapSide(ledger, f.snap, forced, budget) : { kind: 'none' }
  // the content right after the last history edit: the first snapshot, or the file now
  const later = f.snap ? snapText(ledger, f.snap) : diskText(io, f.path)
  const b = historyBaseline(f.history, later)
  if (b.kind !== 'text') return { kind: b.kind }
  const data = Buffer.from(b.text, 'utf8')
  if (data.length > limitOf(forced)) return { kind: 'too-large', size: data.length }
  return budget.take(data.length) ? { kind: 'data', data } : { kind: 'skipped' }
}

/**
 * The file on disk holds exactly what the snapshot recorded: the edit was denied, or undone. Told by the hash,
 * so it works for binary files and files too large to diff as well.
 */
function unchanged(io: SourceIo, ledger: LedgerView, snap: Snapshot): boolean {
  if (snap.sha === null) return false
  const info = io.diskInfo(snap.path)
  if (info.kind !== 'file' || info.size > MAX_SNAPSHOT_BYTES) return false
  // a stored blob of another size cannot be the same content: no need to read the file
  if (snap.kind === 'blob' && ledger.blobSize(snap.sha) !== info.size) return false
  const data = io.readDisk(snap.path)
  return data !== null && contentSha(data) === snap.sha
}

export function ledgerInputs(io: SourceIo, ledger: LedgerView, log: TranscriptLog, scope: 'last_turn' | 'session', base: string, forced: (path: string) => boolean): Inputs {
  const files = (scope === 'session' ? sessionFiles(ledger, log) : lastTurnFiles(ledger, log)).sort(byPath)
  if (files.length > MAX_FILES) {
    return { inputs: files.map((f) => ({ path: f.path, relPath: relPathFor(base, f.path), before: { kind: 'skipped' }, after: { kind: 'skipped' }, forced: false, status: 'modified' })), tooMany: true }
  }
  const budget = new Budget()
  const inputs = files.flatMap((f): DiffInput[] => {
    if (f.history.length === 0 && f.snap !== null && unchanged(io, ledger, f.snap)) return []
    const fz = forced(f.path)
    return [{ path: f.path, relPath: relPathFor(base, f.path), before: beforeSide(io, ledger, f, fz, budget), after: diskSide(io, f.path, fz, budget), forced: fz }]
  })
  return { inputs, tooMany: budget.exhausted }
}

export function createSources(io: SourceIo): ReviewSources {
  return {
    root: async (cwd) => {
      try {
        const root = await repoRoot(io.git, cwd)
        return root ? { root } : { root: null, problem: 'Not a git repository' }
      } catch (e) {
        return { root: null, problem: e instanceof Error ? e.message : String(e) }
      }
    },
    verify: async (root, ref) => {
      await verifyRef(io.git, root, ref)
    },
    head: (root) => headOrEmpty(io.git, root),
    git: (root, from, to, paths, forced) => gitInputs(io, root, from, to, paths, forced),
    ledger: (ledger, log, scope, base, forced) => ledgerInputs(io, ledger, log, scope, base, forced),
    read: (path) => readForSnapshot(io, path)
  }
}
```

`historyBaseline` returns `{ kind: 'absent' }` or `{ kind: 'none' }` for non-text results; `{ kind: b.kind }` maps both onto `Side` as is.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/review-sources.test.ts tests/integration/review-sources.int.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Leave uncommitted.**

---

### Task 7: ReviewHub

**Files:**
- Create: `src/main/review-hub.ts`
- Test: `tests/unit/review-hub.test.ts`

**Interfaces:**
- Consumes:
  - `ReviewSources`, `EMPTY_LEDGER`, `TranscriptLog`, `relPathFor` (Task 6);
  - `buildFile`, `DiffInput` (Task 5);
  - `EditLedger` (Task 3);
  - `TranscriptEditEvent` (Task 2);
  - `ReviewUpdate`, `ReviewScope`, `ReviewSendState`, `ReviewCounter`, `ReviewFile`, `SCOPE_LABELS`, `NOT_RUNNING`, `IN_DIALOG` (Task 1, `src/shared/review.ts`);
  - `PipeResponse` (Task 1).
- Produces:
  - `interface ReviewRequest { cwd: string; scope: ReviewScope | null; from: string | null; to: string | null; paths: string[]; title: string | null }`
  - `interface ReviewHubDeps { sources: ReviewSources; ledgerFor(sessionId: string): EditLedger; activeTabId(): string | null; publish(update: ReviewUpdate): void; onError(message: string): void; debounceMs?: number }`
  - `TOO_MANY_NOTICE`
  - `class ReviewHub` with these methods:
    - tabs: `addTab(tabId, cwd, claude)`, `removeTab(tabId)`, `dispose()`;
    - Claude's session: `sessionStarted(tabId, sessionId)`, `sessionEnded(tabId, sessionId)` (ignores a session the tab has left), `turn(tabId, sessionId, cwd: string | null)`, `recordBefore(tabId, sessionId, toolUseId, path)`, `transcriptEvent(tabId, ev: TranscriptEditEvent)`, `assistantEntry(tabId, agentId: string | null)`, `dialogOpened(tabId, agentId: string | null)`, `turnEnded(tabId)`, `canSend(tabId): ReviewSendState`;
    - the view: `setScope(tabId, scope)`, `clearRequest(tabId)`, `showFile(tabId, path)`, `setViewed(tabId, path, hash, viewed)`;
    - computing: `trigger(tabId)`, `activated(tabId)` (always computes), `refresh(tabId)`, `showRequest(tabId: string | null, req: ReviewRequest): Promise<PipeResponse>`.
- The Send guard keeps a set of open dialogs per tab, one per agent (`null` = the main conversation): `dialogOpened` adds the agent; its next assistant entry removes it; a prompt (`turn`) and `Stop` (`turnEnded`) remove only the main conversation's; the start or end of the session removes all. Send is blocked while the set is not empty.

- [ ] **Step 1: Write the failing tests**

`tests/unit/review-hub.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditLedger } from '../../src/main/edit-ledger'
import type { DiffInput } from '../../src/main/review-diff'
import { ReviewHub, type ReviewRequest } from '../../src/main/review-hub'
import type { Inputs, ReviewSources, TranscriptLog } from '../../src/main/review-sources'
import { IN_DIALOG, NOT_RUNNING, type ReviewUpdate } from '../../src/shared/review'

const ROOT = process.platform === 'win32' ? 'D:\\repo' : '/repo'
const TAB = 'tab-1'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const input = (rel: string, before: string | null, after: string | null): DiffInput => ({
  path: join(ROOT, rel), relPath: rel, forced: false,
  before: before === null ? { kind: 'absent' } : { kind: 'data', data: Buffer.from(before) },
  after: after === null ? { kind: 'absent' } : { kind: 'data', data: Buffer.from(after) }
})
const result = (...inputs: DiffInput[]): Inputs => ({ inputs, tooMany: false })

function setup(o: Partial<ReviewSources> = {}, active: string | null = TAB) {
  const published: ReviewUpdate[] = []
  const git = vi.fn(async () => result(input('a.ts', 'a\n', 'b\n')))
  const ledger = vi.fn(() => result(input('s.ts', 'x\n', 'y\n')))
  const sources: ReviewSources = {
    root: async () => ({ root: ROOT }),
    verify: async () => {},
    head: async () => 'HEAD',
    git,
    ledger,
    read: () => ({ kind: 'data', data: Buffer.from('before\n') }),
    ...o
  }
  const dir = mkdtempSync(join(tmpdir(), 'ct-hub-'))
  let activeId = active
  const hub = new ReviewHub({
    sources,
    ledgerFor: (sid) => new EditLedger({ dir: join(dir, sid), now: () => 1, onError: () => {} }),
    activeTabId: () => activeId,
    publish: (u) => published.push(u),
    onError: () => {}
  })
  hub.addTab(TAB, ROOT, true)
  return { hub, published, git, ledger, setActive: (id: string | null) => { activeId = id }, last: () => published[published.length - 1]! }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ReviewHub views', () => {
  it('starts on Uncommitted in a repository and counts the changes', async () => {
    const { hub, last } = setup()
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ view: { kind: 'scope', scope: 'uncommitted' }, label: 'uncommitted', uncommitted: { available: true }, additions: 1, deletions: 1, unviewed: 1 })
    expect(last().counter).toEqual({ files: 1, additions: 1, deletions: 1, title: `Uncommitted changes in ${ROOT}` })
  })

  it('starts on Session outside a repository and says why Uncommitted is off', async () => {
    const { hub, last, git } = setup({ root: async () => ({ root: null, problem: 'Not a git repository' }) })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ view: { kind: 'scope', scope: 'session' }, uncommitted: { available: false, reason: 'Not a git repository' } })
    expect(last().counter?.title).toBe("Claude's edits in this session")
    expect(git).not.toHaveBeenCalled()
  })

  it('computes only the tab in front; another tab waits until it is activated', async () => {
    const { hub, published, setActive } = setup()
    setActive('other')
    hub.trigger(TAB)
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toHaveLength(0)
    setActive(TAB)
    hub.activated(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveLength(1)
  })

  it('debounces triggers by 300 ms', async () => {
    const { hub, git } = setup()
    hub.trigger(TAB)
    hub.trigger(TAB)
    await vi.advanceTimersByTimeAsync(200)
    hub.trigger(TAB)
    await vi.advanceTimersByTimeAsync(299)
    expect(git).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(git).toHaveBeenCalledTimes(1)
  })

  it('a trigger during a compute runs it again', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const git = vi.fn(async () => { await gate; return result(input('a.ts', 'a\n', 'b\n')) })
    const { hub, published } = setup({ git })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(git).toHaveBeenCalledTimes(2)
    expect(published).toHaveLength(2)
  })

  it('a scope change during a compute discards the stale result', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const git = vi.fn(async () => { await gate; return result(input('a.ts', 'a\n', 'b\n')) })
    const { hub, published } = setup({ git })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    hub.setScope(TAB, 'session')
    release()
    await vi.advanceTimersByTimeAsync(0)
    // the compute that started on Uncommitted publishes nothing, and no Session update carries its files
    expect(published.length).toBeGreaterThan(0)
    expect(published.map((u) => u.label)).not.toContain('uncommitted')
    expect(published.filter((u) => u.label === 'session').flatMap((u) => u.files.map((f) => f.relPath))).not.toContain('a.ts')
    expect(published[published.length - 1]!.label).toBe('session')
  })

  it('computes again when the tab comes to the front, even with nothing new', async () => {
    const { hub, published, git } = setup()
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(git).toHaveBeenCalledTimes(1)
    // files may have changed outside Claude meanwhile: activation always computes
    hub.activated(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(git).toHaveBeenCalledTimes(2)
    expect(published).toHaveLength(2)
  })

  it('keeps a Viewed mark while the file stays the same', async () => {
    const files = { after: 'b\n' }
    const { hub, last } = setup({ git: async () => result(input('a.ts', 'a\n', files.after)) })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    const f = last().files[0]!
    hub.setViewed(TAB, f.path, f.hash, true)
    expect(last()).toMatchObject({ unviewed: 0, files: [{ viewed: true }] })
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last().files[0]!.viewed).toBe(true)
    files.after = 'c\n'
    hub.refresh(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ unviewed: 1, files: [{ viewed: false }] })
  })
})

describe('ReviewHub show_diff', () => {
  const req = (o: Partial<ReviewRequest> = {}): ReviewRequest => ({ cwd: ROOT, scope: null, from: 'HEAD~3', to: null, paths: [], title: null, ...o })

  it('opens the request with a chip label and asks the panel to show itself', async () => {
    const { hub, last, git } = setup()
    const r = await hub.showRequest(TAB, req({ paths: [join(ROOT, 'src')] }))
    expect(r).toEqual({ ok: true, info: 'Opened 1 file (+1 −1) in the Changes panel.' })
    expect(git.mock.calls[0]!.slice(0, 4)).toEqual([ROOT, 'HEAD~3', null, [join(ROOT, 'src')]])
    expect(last()).toMatchObject({ view: { kind: 'request' }, label: 'HEAD~3 → working tree · src', reveal: true })
    hub.clearRequest(TAB)
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toMatchObject({ view: { kind: 'scope', scope: 'uncommitted' }, reveal: false })
  })

  it('uses the title and reports an empty view', async () => {
    const { hub, last } = setup({ git: async () => result() })
    expect(await hub.showRequest(TAB, req({ title: 'Auth refactor' }))).toEqual({ ok: true, info: 'No changes in this view.' })
    expect(last().label).toBe('Auth refactor')
  })

  it('refuses outside a Claude tab, outside git, a bad revision and empty paths', async () => {
    const { hub } = setup()
    expect(await hub.showRequest(null, req())).toEqual({ ok: false, error: 'show_diff works only in a ClaudeTerm Claude tab' })
    hub.addTab('shell', ROOT, false)
    expect(await hub.showRequest('shell', req())).toEqual({ ok: false, error: 'show_diff works only in a ClaudeTerm Claude tab' })
    const nogit = setup({ root: async () => ({ root: null, problem: 'Not a git repository' }) })
    expect(await nogit.hub.showRequest(TAB, req())).toEqual({ ok: false, error: `not a git repository: ${ROOT}` })
    const badref = setup({ verify: async (_r, ref) => { throw new Error(`unknown revision: ${ref}`) } })
    expect(await badref.hub.showRequest(TAB, req({ from: 'mastr' }))).toEqual({ ok: false, error: 'unknown revision: mastr' })
    const empty = setup({ git: async () => result() })
    expect(await empty.hub.showRequest(TAB, req({ paths: [join(ROOT, 'nope')] }))).toEqual({ ok: false, error: `nothing in the view for paths: ${join(ROOT, 'nope')}` })
  })

  it('a scope request with paths filters Claude\'s edits', async () => {
    const { hub, last } = setup({ ledger: () => result(input('src/a.ts', 'a\n', 'b\n'), input('docs/b.md', 'a\n', 'b\n')) })
    await hub.showRequest(TAB, req({ from: null, scope: 'session', paths: [join(ROOT, 'src')] }))
    expect(last().files.map((f) => f.relPath)).toEqual(['src/a.ts'])
    expect(last().label).toBe('session · src')
  })
})

describe('ReviewHub Send guard', () => {
  it('blocks Send until Claude runs, during a dialog of the same agent, and after the session ends', async () => {
    const { hub } = setup()
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: NOT_RUNNING })
    hub.sessionStarted(TAB, SID)
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    hub.dialogOpened(TAB, 'a1')
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, null)
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, 'a1')
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    hub.dialogOpened(TAB, null)
    hub.turnEnded(TAB)
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    hub.sessionEnded(TAB, SID)
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: NOT_RUNNING })
  })

  it('keeps Send blocked while any agent has a dialog open; Stop answers only the main conversation\'s', async () => {
    const { hub } = setup()
    hub.sessionStarted(TAB, SID)
    hub.dialogOpened(TAB, 'a1')
    hub.dialogOpened(TAB, 'a2')
    hub.assistantEntry(TAB, 'a2')
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, 'a1')
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    // a background subagent's dialog outlives the main conversation's Stop
    hub.dialogOpened(TAB, null)
    hub.dialogOpened(TAB, 'a1')
    hub.turnEnded(TAB)
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: IN_DIALOG })
    hub.assistantEntry(TAB, 'a1')
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    // the end of the session closes every dialog
    hub.dialogOpened(TAB, 'a2')
    hub.sessionEnded(TAB, SID)
    hub.sessionStarted(TAB, SID)
    expect(hub.canSend(TAB)).toEqual({ ok: true })
  })

  it('ignores the end of a session the tab has already left', async () => {
    const NEXT = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
    const { hub } = setup()
    hub.sessionStarted(TAB, SID)
    hub.sessionStarted(TAB, NEXT)
    // /clear: the old session's SessionEnd may come after the new session started
    hub.sessionEnded(TAB, SID)
    expect(hub.canSend(TAB)).toEqual({ ok: true })
    hub.sessionEnded(TAB, NEXT)
    expect(hub.canSend(TAB)).toEqual({ ok: false, reason: NOT_RUNNING })
  })

  it('republishes the send state without computing again', async () => {
    const { hub, published, git } = setup()
    hub.sessionStarted(TAB, SID)
    await vi.advanceTimersByTimeAsync(300)
    const computed = git.mock.calls.length
    hub.dialogOpened(TAB, null)
    expect(published[published.length - 1]!.send).toEqual({ ok: false, reason: IN_DIALOG })
    expect(git.mock.calls.length).toBe(computed)
  })
})

describe('ReviewHub edits', () => {
  it('records snapshots in the session ledger and starts turns', async () => {
    const seen: { scope: string; snaps: number }[] = []
    const { hub } = setup({
      ledger: (l, _log, scope) => { seen.push({ scope, snaps: (scope === 'session' ? l.sessionSnapshots() : l.lastTurnSnapshots() ?? []).length }); return result() }
    })
    hub.turn(TAB, SID, null)
    hub.recordBefore(TAB, SID, 'toolu_1', join(ROOT, 'a.ts'))
    hub.setScope(TAB, 'last_turn')
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.some((s) => s.scope === 'last_turn' && s.snaps === 1)).toBe(true)
  })

  it('takes each transcript event once and triggers a compute on an edit', async () => {
    const logs: number[] = []
    const { hub } = setup({ ledger: (_l, log) => { logs.push(log.edits.length); return result() } })
    hub.sessionStarted(TAB, SID)
    hub.setScope(TAB, 'session')
    await vi.advanceTimersByTimeAsync(0)
    const ev = { kind: 'edit' as const, at: 5, toolUseId: 'h1', path: join(ROOT, 'a.ts'), created: false, originalFile: 'x', patch: [] }
    hub.transcriptEvent(TAB, ev)
    hub.transcriptEvent(TAB, ev)
    await vi.advanceTimersByTimeAsync(300)
    expect(logs[logs.length - 1]).toBe(1)
  })

  it('keeps the original content of a file\'s first edit in each turn, by the turn the edit belongs to', async () => {
    const logs: TranscriptLog[] = []
    const { hub } = setup({ ledger: (_l, log) => { logs.push(log); return result() } })
    hub.sessionStarted(TAB, SID)
    hub.setScope(TAB, 'session')
    const edit = (toolUseId: string, at: number, originalFile: string) =>
      ({ kind: 'edit' as const, at, toolUseId, path: join(ROOT, 'a.ts'), created: false, originalFile, patch: [] })
    hub.transcriptEvent(TAB, { kind: 'prompt', at: 100, id: 'p1' })
    hub.transcriptEvent(TAB, { kind: 'prompt', at: 300, id: 'p2' })
    hub.transcriptEvent(TAB, edit('m1', 350, 'turn 2'))
    hub.transcriptEvent(TAB, edit('m2', 360, 'turn 2 again'))
    // a subagent's transcript read after the later prompt: its edit is the first of turn 1
    hub.transcriptEvent(TAB, edit('s1', 150, 'turn 1'))
    await vi.advanceTimersByTimeAsync(300)
    expect(logs[logs.length - 1]!.edits.map((e) => [e.toolUseId, e.originalFile])).toEqual([['m1', 'turn 2'], ['m2', null], ['s1', 'turn 1']])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/review-hub.test.ts`
Expected: FAIL — cannot find module `review-hub`.

- [ ] **Step 3: Write the hub**

`src/main/review-hub.ts`:

```ts
import { sep } from 'node:path'
import type { PipeResponse } from '../shared/protocol'
import { IN_DIALOG, NOT_RUNNING, SCOPE_LABELS, type ReviewCounter, type ReviewFile, type ReviewScope, type ReviewSendState, type ReviewUpdate } from '../shared/review'
import type { EditLedger } from './edit-ledger'
import { pathKey } from './path-key'
import { buildFile, type DiffInput } from './review-diff'
import { EMPTY_LEDGER, relPathFor, type Inputs, type ReviewSources, type TranscriptLog } from './review-sources'
import type { TranscriptEditEvent } from './transcript-edits'

/** a diff Claude asked for with show_diff */
export interface ReviewRequest {
  cwd: string
  scope: ReviewScope | null
  from: string | null
  to: string | null
  paths: string[]
  title: string | null
}

export interface ReviewHubDeps {
  sources: ReviewSources
  ledgerFor(sessionId: string): EditLedger
  activeTabId(): string | null
  publish(update: ReviewUpdate): void
  onError(message: string): void
  debounceMs?: number
}

export const TOO_MANY_NOTICE = 'Too many changes to show at once — narrow the view with a smaller scope or paths'

interface TabState {
  tabId: string
  cwd: string
  claude: boolean
  sessionId: string | null
  ledger: EditLedger | null
  log: TranscriptLog
  /** transcript events already taken (a feed may read a transcript again) */
  logIds: Set<string>
  /** "<pathKey>@<turn start>": the first edit of a file in a turn keeps its originalFile */
  keptOriginal: Set<string>
  scope: ReviewScope | null
  request: ReviewRequest | null
  forced: Set<string>
  /** pathKey → the hash the file had when it was marked viewed */
  viewed: Map<string, string>
  running: boolean
  /** the agents with a dialog open in the terminal (null = the main conversation); Send waits while any is open */
  dialogs: Set<string | null>
  /** bumped whenever what the view is changes: a compute that started before is stale */
  gen: number
  computing: boolean
  rerun: boolean
  timer: ReturnType<typeof setTimeout> | null
  last: ReviewUpdate | null
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const total = (files: ReviewFile[], key: 'additions' | 'deletions'): number => files.reduce((n, f) => n + f[key], 0)
const built = (inputs: DiffInput[]): ReviewFile[] => inputs.map(buildFile).filter((f): f is ReviewFile => f !== null)

function within(dir: string, path: string): boolean {
  const d = pathKey(dir)
  const p = pathKey(path)
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep)
}

function requestLabel(r: ReviewRequest, base: string): string {
  if (r.title) return r.title
  const what = r.from !== null ? `${r.from} → ${r.to ?? 'working tree'}` : SCOPE_LABELS[r.scope ?? 'uncommitted']
  return r.paths.length > 0 ? `${what} · ${r.paths.map((p) => relPathFor(base, p)).join(', ')}` : what
}

/** Each Claude tab's review: what the Changes panel shows, when it is computed, and whether Send may write now. */
export class ReviewHub {
  private readonly tabs = new Map<string, TabState>()

  constructor(private readonly d: ReviewHubDeps) {}

  addTab(tabId: string, cwd: string, claude: boolean): void {
    if (this.tabs.has(tabId)) return
    this.tabs.set(tabId, {
      tabId, cwd, claude, sessionId: null, ledger: null, log: { prompts: [], edits: [] }, logIds: new Set(), keptOriginal: new Set(),
      scope: null, request: null, forced: new Set(), viewed: new Map(), running: false,
      dialogs: new Set(), gen: 0, computing: false, rerun: false, timer: null, last: null
    })
  }

  removeTab(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (t?.timer) clearTimeout(t.timer)
    this.tabs.delete(tabId)
  }

  dispose(): void {
    for (const id of [...this.tabs.keys()]) this.removeTab(id)
  }

  // ---- Claude's session

  sessionStarted(tabId: string, sessionId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.useSession(t, sessionId)
    t.running = true
    t.dialogs.clear()
    this.publishState(t)
    this.trigger(tabId)
  }

  /** the end of a session the tab has left (a late SessionEnd after /clear) changes nothing */
  sessionEnded(tabId: string, sessionId: string): void {
    const t = this.tabs.get(tabId)
    if (!t || t.sessionId !== sessionId) return
    t.running = false
    t.dialogs.clear()
    this.publishState(t)
  }

  turn(tabId: string, sessionId: string, cwd: string | null): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.useSession(t, sessionId)
    if (cwd) t.cwd = cwd
    t.running = true
    t.dialogs.delete(null)
    t.ledger!.startTurn()
    this.publishState(t)
  }

  /** Claude is about to change `path`: keep the file as it is now */
  recordBefore(tabId: string, sessionId: string, toolUseId: string, path: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.useSession(t, sessionId)
    t.ledger!.recordBefore(toolUseId, path, () => this.d.sources.read(path))
  }

  transcriptEvent(tabId: string, ev: TranscriptEditEvent): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    const id = ev.kind === 'prompt' ? `p:${ev.id}` : `e:${ev.toolUseId}`
    if (t.logIds.has(id)) return
    t.logIds.add(id)
    if (ev.kind === 'prompt') {
      t.log.prompts.push(ev.at)
      return
    }
    // only a file's first edit in a turn needs its original content; the rest would only take memory.
    // The turn is the edit's own (the latest prompt at or before it): a subagent's transcript may be read after later prompts
    const turnStart = t.log.prompts.reduce((m, p) => (p <= ev.at && p > m ? p : m), Number.NEGATIVE_INFINITY)
    const turnKey = `${pathKey(ev.path)}@${turnStart}`
    const keep = !t.keptOriginal.has(turnKey)
    t.keptOriginal.add(turnKey)
    t.log.edits.push({ at: ev.at, toolUseId: ev.toolUseId, path: ev.path, created: ev.created, originalFile: keep ? ev.originalFile : null, patch: ev.patch })
    this.trigger(tabId)
  }

  /** an assistant entry of the main conversation (null) or of a subagent: a dialog that agent raised is answered */
  assistantEntry(tabId: string, agentId: string | null): void {
    const t = this.tabs.get(tabId)
    if (!t || !t.dialogs.delete(agentId)) return
    this.publishState(t)
  }

  dialogOpened(tabId: string, agentId: string | null): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.dialogs.add(agentId)
    this.publishState(t)
  }

  /** Stop: the turn is over, files Claude changed through Bash are in place now; a subagent's dialog may still be open */
  turnEnded(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.dialogs.delete(null)
    this.publishState(t)
    this.trigger(tabId)
  }

  canSend(tabId: string): ReviewSendState {
    const t = this.tabs.get(tabId)
    return t ? this.sendState(t) : { ok: false, reason: NOT_RUNNING }
  }

  // ---- what the view shows

  setScope(tabId: string, scope: ReviewScope): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.scope = scope
    t.request = null
    t.forced.clear()
    t.gen++
    this.refresh(tabId)
  }

  clearRequest(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.request = null
    t.forced.clear()
    t.gen++
    this.refresh(tabId)
  }

  /** "show anyway" for a too large file */
  showFile(tabId: string, path: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.forced.add(pathKey(path))
    t.gen++
    this.refresh(tabId)
  }

  setViewed(tabId: string, path: string, hash: string, viewed: boolean): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    if (viewed) t.viewed.set(pathKey(path), hash)
    else t.viewed.delete(pathKey(path))
    this.publishState(t)
  }

  // ---- when to compute

  /** something changed for the tab: compute it soon if it is in front; a tab behind computes when it comes to the front */
  trigger(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t?.claude || this.d.activeTabId() !== tabId) return
    this.schedule(t, this.d.debounceMs ?? 300)
  }

  /** the tab came to the front: files may have changed outside Claude meanwhile, so it always computes */
  activated(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (t?.claude) this.schedule(t, 0)
  }

  refresh(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (t?.claude) this.schedule(t, 0)
  }

  async showRequest(tabId: string | null, req: ReviewRequest): Promise<PipeResponse> {
    const t = tabId ? this.tabs.get(tabId) : undefined
    if (!t?.claude) return { ok: false, error: 'show_diff works only in a ClaudeTerm Claude tab' }
    if (req.from !== null || (req.scope ?? 'uncommitted') === 'uncommitted') {
      const r = await this.d.sources.root(req.cwd)
      if (r.root === null) return { ok: false, error: r.problem === 'Not a git repository' ? `not a git repository: ${req.cwd}` : r.problem }
      for (const ref of [req.from, req.to]) {
        if (ref === null) continue
        try {
          await this.d.sources.verify(r.root, ref)
        } catch (e) {
          return { ok: false, error: message(e) }
        }
      }
    }
    const update = await this.build(t, req, new Set())
    if (!this.tabs.has(t.tabId)) return { ok: false, error: 'the tab was closed' }
    if (update.files.length === 0 && update.notice) return { ok: false, error: update.notice }
    if (update.files.length === 0 && req.paths.length > 0) return { ok: false, error: `nothing in the view for paths: ${req.paths.join(', ')}` }
    t.request = req
    t.forced.clear()
    t.gen++
    t.last = update
    this.d.publish({ ...this.withState(t, update), reveal: true })
    const n = update.files.length
    return { ok: true, info: n === 0 ? 'No changes in this view.' : `Opened ${n} file${n === 1 ? '' : 's'} (+${update.additions} −${update.deletions}) in the Changes panel.` }
  }

  // ---- inside

  private useSession(t: TabState, sessionId: string): void {
    if (t.sessionId === sessionId && t.ledger) return
    t.sessionId = sessionId
    t.ledger = this.d.ledgerFor(sessionId)
    t.log = { prompts: [], edits: [] }
    t.logIds.clear()
    t.keptOriginal.clear()
    t.gen++
  }

  private schedule(t: TabState, ms: number): void {
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      t.timer = null
      this.compute(t).catch((e) => this.d.onError(`review: ${message(e)}`))
    }, ms)
  }

  private async compute(t: TabState): Promise<void> {
    if (t.computing) {
      t.rerun = true
      return
    }
    t.computing = true
    try {
      do {
        t.rerun = false
        const gen = t.gen
        const update = await this.build(t, t.request, t.forced)
        if (!this.tabs.has(t.tabId)) return
        if (gen !== t.gen) {
          t.rerun = true
          continue
        }
        t.last = update
        this.d.publish(this.withState(t, update))
      } while (t.rerun)
    } finally {
      t.computing = false
    }
  }

  /** the view is taken as it is when the compute starts (`request` and `t.scope`): a change while it runs makes the result stale, never mixed */
  private async build(t: TabState, request: ReviewRequest | null, forcedKeys: ReadonlySet<string>): Promise<ReviewUpdate> {
    const chosen = t.scope
    const cwd = request?.cwd ?? t.cwd
    const r = await this.d.sources.root(cwd)
    const root = r.root
    const problem = r.root === null ? r.problem : ''
    const scope: ReviewScope = chosen ?? (root ? 'uncommitted' : 'session')
    if (t.scope === null) t.scope = scope
    const base = root ?? cwd
    const forced = (p: string): boolean => forcedKeys.has(pathKey(p))
    const view = await this.inputs(t, request, scope, root, problem, base, forced)
    const files = built(view.inputs)
    return {
      tabId: t.tabId,
      view: request ? { kind: 'request' } : { kind: 'scope', scope },
      label: request ? requestLabel(request, base) : SCOPE_LABELS[scope],
      uncommitted: root ? { available: true } : { available: false, reason: problem },
      files,
      additions: total(files, 'additions'),
      deletions: total(files, 'deletions'),
      unviewed: files.length,
      notice: view.notice,
      send: this.sendState(t),
      counter: await this.counter(t, request, scope, root, files, base),
      reveal: false
    }
  }

  private async inputs(
    t: TabState, request: ReviewRequest | null, scope: ReviewScope, root: string | null, problem: string, base: string, forced: (p: string) => boolean
  ): Promise<{ inputs: DiffInput[]; notice: string | null }> {
    const s = this.d.sources
    const wanted: ReviewScope | null = request ? (request.from !== null ? null : request.scope ?? 'uncommitted') : scope
    const paths = request?.paths ?? []
    try {
      let r: Inputs
      if (wanted === 'last_turn' || wanted === 'session') {
        r = s.ledger(t.ledger ?? EMPTY_LEDGER, t.log, wanted, base, forced)
        if (paths.length > 0) r = { ...r, inputs: r.inputs.filter((i) => paths.some((p) => within(p, i.path))) }
      } else {
        if (!root) return { inputs: [], notice: problem }
        const from = request?.from ?? (await s.head(root))
        r = await s.git(root, from, request?.to ?? null, paths, forced)
      }
      return { inputs: r.inputs, notice: r.tooMany ? TOO_MANY_NOTICE : null }
    } catch (e) {
      return { inputs: [], notice: message(e) }
    }
  }

  /** the status bar counter: Uncommitted in a repository, else the session; `viewScope` is the scope the panel shows */
  private async counter(
    t: TabState, request: ReviewRequest | null, viewScope: ReviewScope, root: string | null, files: ReviewFile[], base: string
  ): Promise<ReviewCounter | null> {
    const scope: ReviewScope = root ? 'uncommitted' : 'session'
    const shown = !request && viewScope === scope ? files : built((await this.inputs(t, null, scope, root, '', base, () => false)).inputs)
    if (shown.length === 0) return null
    return {
      files: shown.length,
      additions: total(shown, 'additions'),
      deletions: total(shown, 'deletions'),
      title: root ? `Uncommitted changes in ${root}` : "Claude's edits in this session"
    }
  }

  private withState(t: TabState, u: ReviewUpdate): ReviewUpdate {
    const files = u.files.map((f) => ({ ...f, viewed: t.viewed.get(pathKey(f.path)) === f.hash }))
    return { ...u, files, unviewed: files.filter((f) => !f.viewed).length, send: this.sendState(t) }
  }

  private sendState(t: TabState): ReviewSendState {
    if (!t.running) return { ok: false, reason: NOT_RUNNING }
    if (t.dialogs.size > 0) return { ok: false, reason: IN_DIALOG }
    return { ok: true }
  }

  private publishState(t: TabState): void {
    if (t.last) this.d.publish(this.withState(t, t.last))
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/review-hub.test.ts && npm run typecheck`
Expected: PASS. Check two tests for timing:
- "a trigger during a compute runs it again" relies on `refresh` scheduling with 0 ms while `compute` is waiting on the gate: the second compute call sets `rerun`, and the loop runs `git` again after the gate opens.
- "republishes the send state" relies on `sessionStarted` publishing nothing before the first compute (`t.last` is null), so the debounced compute runs first.
- "a scope change during a compute" relies on `build` taking the scope at its start: the compute that began on Uncommitted builds an 'uncommitted' update with `a.ts`, the `gen` check drops it, and the loop and the scheduled refresh publish only the Session view (once or twice, depending on timer order — the test does not count them).

- [ ] **Step 5: Leave uncommitted.**

---

### Task 8: The `show_diff` MCP tool

**Files:**
- Create: `src/mcp/show-diff-tool.ts`
- Modify: `src/mcp/show-image-server.ts`
- Test: `tests/unit/show-diff-tool.test.ts`, `tests/integration/mcp.int.test.ts`

**Interfaces:**
- Consumes: `ShowDiffMessage`, `PipeResponse` (Task 1); `PipeUnavailableError`; `ToolResult` from `show-image-tool.ts`.
- Produces: `interface ShowDiffInput { scope?: ReviewScope; from?: string; to?: string; paths?: string[]; title?: string }`, `interface ShowDiffDeps { cwd: string; tabId: string | null; pipeName: string; send(pipeName: string, msg: ShowDiffMessage): Promise<PipeResponse> }`, `handleShowDiff(input: ShowDiffInput, deps: ShowDiffDeps): Promise<ToolResult>`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/show-diff-tool.test.ts`:

```ts
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { handleShowDiff, type ShowDiffDeps } from '../../src/mcp/show-diff-tool'
import { PipeUnavailableError } from '../../src/shared/pipe-client'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const CWD = process.platform === 'win32' ? 'D:\\proj' : '/proj'
const deps = (send: ShowDiffDeps['send'], tabId: string | null = TAB): ShowDiffDeps => ({ cwd: CWD, tabId, pipeName: 'pipe', send })

describe('handleShowDiff', () => {
  it('sends the request with paths resolved against the working folder and returns ClaudeTerm\'s reply', async () => {
    const send = vi.fn(async () => ({ ok: true as const, info: 'Opened 2 files (+3 −1) in the Changes panel.' }))
    const r = await handleShowDiff({ from: ' HEAD~3 ', paths: ['src', join(CWD, 'tests')], title: ' Auth ' }, deps(send))
    expect(r).toEqual({ text: 'Opened 2 files (+3 −1) in the Changes panel.', isError: false })
    expect(send).toHaveBeenCalledWith('pipe', { v: 1, type: 'show_diff', tabId: TAB, cwd: CWD, scope: null, from: 'HEAD~3', to: null, paths: [join(CWD, 'src'), join(CWD, 'tests')], title: 'Auth' })
  })

  it('passes a scope when there is no from', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await handleShowDiff({ scope: 'last_turn' }, deps(send))
    expect(send).toHaveBeenCalledWith('pipe', expect.objectContaining({ scope: 'last_turn', from: null, paths: [], title: null }))
  })

  it('refuses options as revisions, to without from, too many paths, and running outside a ClaudeTerm tab', async () => {
    const send = vi.fn()
    expect((await handleShowDiff({ from: '--output=x' }, deps(send))).isError).toBe(true)
    expect((await handleShowDiff({ from: '' }, deps(send))).isError).toBe(true)
    expect(await handleShowDiff({ to: 'HEAD' }, deps(send))).toEqual({ text: 'to needs from: pass the revision to compare with', isError: true })
    expect((await handleShowDiff({ paths: Array.from({ length: 101 }, () => 'a') }, deps(send))).isError).toBe(true)
    expect(await handleShowDiff({}, deps(send, null))).toEqual({ text: 'show_diff works only in a ClaudeTerm Claude tab', isError: true })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports ClaudeTerm\'s refusals and a missing ClaudeTerm as errors', async () => {
    expect(await handleShowDiff({}, deps(async () => ({ ok: false as const, error: 'unknown revision: mastr' })))).toEqual({ text: 'unknown revision: mastr', isError: true })
    expect(await handleShowDiff({}, deps(async () => { throw new PipeUnavailableError('ENOENT') }))).toEqual({ text: 'ClaudeTerm is not running, so there is no panel to show the diff in', isError: true })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/show-diff-tool.test.ts`
Expected: FAIL — cannot find module `show-diff-tool`.

- [ ] **Step 3: Write the tool**

`src/mcp/show-diff-tool.ts`:

```ts
import { isAbsolute, resolve } from 'node:path'
import { PipeUnavailableError } from '../shared/pipe-client'
import type { PipeResponse, ShowDiffMessage } from '../shared/protocol'
import type { ReviewScope } from '../shared/review'
import type { ToolResult } from './show-image-tool'

export interface ShowDiffInput {
  scope?: ReviewScope
  from?: string
  to?: string
  paths?: string[]
  title?: string
}

export interface ShowDiffDeps {
  cwd: string
  tabId: string | null
  pipeName: string
  send(pipeName: string, msg: ShowDiffMessage): Promise<PipeResponse>
}

const MAX_PATHS = 100

export async function handleShowDiff(input: ShowDiffInput, deps: ShowDiffDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: 'show_diff works only in a ClaudeTerm Claude tab', isError: true }
  const from = input.from?.trim()
  const to = input.to?.trim()
  for (const [name, v] of [['from', from], ['to', to]] as const) {
    if (v !== undefined && (v === '' || v.startsWith('-'))) return { text: `${name} must be a git revision such as HEAD~3, a branch or a commit`, isError: true }
  }
  if (to !== undefined && from === undefined) return { text: 'to needs from: pass the revision to compare with', isError: true }
  const raw = input.paths ?? []
  if (raw.length > MAX_PATHS) return { text: `at most ${MAX_PATHS} paths`, isError: true }
  const title = input.title?.trim()
  const msg: ShowDiffMessage = {
    v: 1,
    type: 'show_diff',
    tabId: deps.tabId,
    cwd: deps.cwd,
    scope: from !== undefined ? null : input.scope ?? null,
    from: from ?? null,
    to: to ?? null,
    paths: raw.map((p) => (isAbsolute(p) ? p : resolve(deps.cwd, p))),
    title: title ? title.slice(0, 100) : null
  }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, msg)
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: 'ClaudeTerm is not running, so there is no panel to show the diff in', isError: true }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: res.info ?? 'Opened in the Changes panel.', isError: false } : { text: res.error, isError: true }
}
```

In `src/mcp/show-image-server.ts`, import `handleShowDiff` and register the tool before `void server.connect(...)`:

```ts
server.registerTool(
  'show_diff',
  {
    title: 'Show a diff in ClaudeTerm',
    description:
      'Open a diff in the Changes panel next to the terminal in ClaudeTerm, where the user reviews it and comments on lines. ' +
      'Use it when the user asks to see a diff or the changes. Without arguments it shows the uncommitted changes. ' +
      'To review a branch like a pull request, pass the output of `git merge-base <base branch> HEAD` as from.',
    inputSchema: {
      scope: z.enum(['uncommitted', 'last_turn', 'session']).optional()
        .describe('uncommitted (default): everything not committed; last_turn: what Claude changed in its latest turn with edits; session: what Claude changed in this conversation. Ignored when from is given'),
      from: z.string().optional().describe('A git revision to compare with: HEAD~3, a branch, a tag or a commit'),
      to: z.string().optional().describe('A git revision to compare up to; default: the working tree'),
      paths: z.array(z.string()).optional().describe('Files or folders to limit the diff to, absolute or relative to the current directory'),
      title: z.string().optional().describe('A short title shown above the diff')
    }
  },
  async (input) => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await handleShowDiff(input, {
      cwd: process.cwd(),
      tabId: isUuid(tabId) ? tabId : null,
      pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
      // the diff is read before ClaudeTerm answers: git in a big repository takes a while
      send: (pipe, msg) => sendPipeMessage(pipe, msg, 15_000)
    })
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)
```

- [ ] **Step 4: Extend the MCP integration test**

In `tests/integration/mcp.int.test.ts`:
- collect show_diff messages: `const diffs: ShowDiffMessage[] = []` (import the type);
- make the server's `showDiff` handler `async (m) => { diffs.push(m); return { ok: true, info: 'Opened 1 file (+1 −0) in the Changes panel.' } }`;
- change the tools assertion to `expect(tools.tools.map((t) => t.name).sort()).toEqual(['show_diff', 'show_image'])`;
- add:

```ts
  it('forwards show_diff with paths resolved against its folder', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const res = await client.callTool({ name: 'show_diff', arguments: { from: 'HEAD~1', paths: ['out'] } })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: 'Opened 1 file (+1 −0) in the Changes panel.' }])
    expect(diffs).toEqual([{ v: 1, type: 'show_diff', tabId: TAB, cwd: work, scope: null, from: 'HEAD~1', to: null, paths: [join(work, 'out')], title: null }])
    await client.close()
  })
```

If `cwd` differs from `work` only by an 8.3 short name or a symlinked temp folder (macOS-style `/private`), compare with `realpathSync.native(work)`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/show-diff-tool.test.ts tests/integration/mcp.int.test.ts && npm run typecheck && npm run build:resources`
Expected: PASS; `resources/mcp/show-image-server.js` rebuilds without errors.

- [ ] **Step 6: Leave uncommitted.**

---

### Task 9: Review settings and the editor launcher

**Files:**
- Create: `src/main/editor-launch.ts`
- Modify: `src/shared/types.ts`, `src/main/settings.ts`, `src/shared/settings-keys.ts`, `src/renderer/settings-form.ts`, `src/renderer/settings-page.ts`
- Test: `tests/unit/editor-launch.test.ts`, `tests/unit/settings.test.ts`, `tests/unit/settings-keys.test.ts`, `tests/unit/settings-form.test.ts`

**Interfaces:**
- Produces:
  - `Settings.review: { editor: string | null; statusBar: boolean; width: number }` (defaults `null`, `true`, `640`)
  - `SettingKey` adds `'review.editor' | 'review.statusBar'`
  - `checkOptionalText(text: string): Checked<string | null>` in `settings-form.ts`
  - in `editor-launch.ts`:
    - `splitCommand(template: string): string[]`
    - `fillTemplate(args: string[], file: string, line: number): string[]`
    - `DEFAULT_EDITOR: string[]`
    - `interface Launched { on(event: 'error', listener: (e: Error) => void): unknown; unref(): void }`
    - `interface EditorDeps { spawn(command: string, args: string[]): Launched; openPath(file: string): Promise<string>; onError(message: string): void }`
    - `launchEditor(template: string | null, file: string, line: number, d: EditorDeps): void`
    - `spawnDetached(command: string, args: string[]): Launched`

- [ ] **Step 1: Write the failing tests**

`tests/unit/editor-launch.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { fillTemplate, launchEditor, splitCommand } from '../../src/main/editor-launch'

function child(fail?: Error) {
  const c = Object.assign(new EventEmitter(), { unref: vi.fn() })
  if (fail) queueMicrotask(() => c.emit('error', fail))
  return c
}

describe('splitCommand', () => {
  it('splits on spaces and keeps quoted parts together', () => {
    expect(splitCommand('code --goto {file}:{line}')).toEqual(['code', '--goto', '{file}:{line}'])
    expect(splitCommand('"C:\\Program Files\\JetBrains\\Rider\\bin\\rider64.exe" --line {line} "{file}"'))
      .toEqual(['C:\\Program Files\\JetBrains\\Rider\\bin\\rider64.exe', '--line', '{line}', '{file}'])
    expect(splitCommand('   ')).toEqual([])
    expect(splitCommand('a ""')).toEqual(['a', ''])
  })
})

describe('fillTemplate', () => {
  it('puts the file and the line into every argument', () => {
    expect(fillTemplate(['--goto', '{file}:{line}', '{line}'], 'D:\\p\\a b.ts', 7)).toEqual(['--goto', 'D:\\p\\a b.ts:7', '7'])
  })
})

describe('launchEditor', () => {
  it('runs the template as a command with arguments', () => {
    const spawn = vi.fn(() => child())
    launchEditor('subl {file}:{line}', '/p/a.ts', 12, { spawn, openPath: vi.fn(), onError: vi.fn() })
    expect(spawn).toHaveBeenCalledWith('subl', ['/p/a.ts:12'])
  })

  it('tries VS Code by default and opens the file with the system app when code is missing', async () => {
    const spawn = vi.fn(() => child(new Error('spawn code ENOENT')))
    const openPath = vi.fn(async () => '')
    const onError = vi.fn()
    launchEditor(null, '/p/a.ts', 3, { spawn, openPath, onError })
    expect(spawn).toHaveBeenCalledWith('code', ['--goto', '/p/a.ts:3'])
    await vi.waitFor(() => expect(openPath).toHaveBeenCalledWith('/p/a.ts'))
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports an editor that does not start, and an empty template', async () => {
    const onError = vi.fn()
    launchEditor('subl {file}', '/p/a.ts', 1, { spawn: () => child(new Error('spawn subl ENOENT')), openPath: vi.fn(), onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Cannot start the editor (subl): spawn subl ENOENT'))
    launchEditor('  ', '/p/a.ts', 1, { spawn: vi.fn(), openPath: vi.fn(), onError })
    expect(onError).toHaveBeenLastCalledWith('review.editor is empty')
  })
})
```

Add to `tests/unit/settings.test.ts`:

```ts
describe('review settings', () => {
  it('defaults: no editor, the counter on, 640 px', () => {
    expect(parseSettings('{}').settings.review).toEqual({ editor: null, statusBar: true, width: 640 })
  })

  it('takes valid values and reports invalid ones', () => {
    expect(parseSettings(JSON.stringify({ review: { editor: 'code --goto {file}:{line}', statusBar: false, width: 900 } })).settings.review)
      .toEqual({ editor: 'code --goto {file}:{line}', statusBar: false, width: 900 })
    const bad = parseSettings(JSON.stringify({ review: { editor: 5, width: 10 } }))
    expect(bad.settings.review).toEqual({ editor: null, statusBar: true, width: 640 })
    expect(bad.errors).toEqual(['settings.json: invalid value for "review.editor", using default', 'settings.json: invalid value for "review.width", using default'])
  })
})
```

In `tests/unit/settings-keys.test.ts`, change the first test to:

```ts
  it('lists the 12 notification cells, the sound and the twelve plain settings', () => {
    expect(SETTING_KEYS).toHaveLength(25)
    expect(SETTING_KEYS).toContain('notifications.bell.tab')
    expect(SETTING_KEYS).toContain('notifications.sound')
    expect(SETTING_KEYS).toContain('claude.shellProfile')
    expect(SETTING_KEYS).toContain('review.editor')
    expect(SETTING_KEYS).toContain('review.statusBar')
  })
```

Add to `tests/unit/settings-form.test.ts` (import `checkOptionalText`):

```ts
describe('checkOptionalText', () => {
  it('takes empty text as null and trims the rest', () => {
    expect(checkOptionalText('   ')).toEqual({ ok: true, value: null })
    expect(checkOptionalText(' code --goto {file}:{line} ')).toEqual({ ok: true, value: 'code --goto {file}:{line}' })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/editor-launch.test.ts tests/unit/settings.test.ts tests/unit/settings-keys.test.ts tests/unit/settings-form.test.ts`
Expected: FAIL — missing module, missing `review`, 23 keys, missing `checkOptionalText`.

- [ ] **Step 3: Add the settings**

`src/shared/types.ts`, in `Settings` after `notifications`:

```ts
  /** the Changes panel */
  review: { editor: string | null; statusBar: boolean; width: number }
```

`src/main/settings.ts`:
- in `DEFAULT_SETTINGS` after `notifications`: `review: { editor: null, statusBar: true, width: 640 },`;
- in `parseSettings`: `const rv = obj(raw.review)` next to the other `obj(...)` lines, and in the result after `notifications,`:

```ts
    review: {
      editor: take('review.editor', rv.editor, isNullableStr, d.review.editor),
      statusBar: take('review.statusBar', rv.statusBar, isBool, d.review.statusBar),
      width: take('review.width', rv.width, numIn(240, 4000), d.review.width)
    },
```

`src/shared/settings-keys.ts`: add `| 'review.editor' | 'review.statusBar'` to `SettingKey`, and `'review.editor', 'review.statusBar'` to `SETTING_KEYS` after `'imagePanel.autoOpen'`.

`src/renderer/settings-form.ts`, after `checkText`:

```ts
/** text that may be left empty: empty means null (the automatic choice) */
export function checkOptionalText(text: string): Checked<string | null> {
  const v = text.trim()
  return { ok: true, value: v === '' ? null : v }
}
```

`src/renderer/settings-page.ts`: import `checkOptionalText`, and add a section after `Images`:

```ts
  section('Review', 'the Changes panel',
    textField('Editor', 'review.editor', 'text', (v) => v.settings.review.editor ?? '', checkOptionalText,
      'empty: VS Code if installed, else the default app · {file} and {line} are filled in'),
    checkboxField('review.statusBar', 'Show the changes counter in the status bar', (v) => v.settings.review.statusBar)),
```

and in the footer text below the sections, `the image panel size` becomes `the image and Changes panel widths` (`review.width` is set in settings.json only).

- [ ] **Step 4: Write the editor launcher**

`src/main/editor-launch.ts`:

```ts
import crossSpawn from 'cross-spawn'

/** what launchEditor needs of a started process */
export interface Launched {
  on(event: 'error', listener: (e: Error) => void): unknown
  unref(): void
}

export interface EditorDeps {
  spawn(command: string, args: string[]): Launched
  /** the system's app for the file; resolves to an error message, '' when it worked */
  openPath(file: string): Promise<string>
  onError(message: string): void
}

export const DEFAULT_EDITOR = ['code', '--goto', '{file}:{line}']

/** "code --goto {file}:{line}" as arguments: spaces split them, double quotes group and are dropped */
export function splitCommand(template: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quoted = false
  for (const ch of template) {
    if (ch === '"') {
      quoted = !quoted
      has = true
    } else if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}

export function fillTemplate(args: string[], file: string, line: number): string[] {
  return args.map((a) => a.replaceAll('{file}', file).replaceAll('{line}', String(line)))
}

/** Opens the file at the line with review.editor; null tries VS Code, then the system's app for the file. */
export function launchEditor(template: string | null, file: string, line: number, d: EditorDeps): void {
  const [command, ...args] = fillTemplate(template === null ? DEFAULT_EDITOR : splitCommand(template), file, line)
  if (!command) {
    d.onError('review.editor is empty')
    return
  }
  const failed = (e: Error): void => {
    if (template !== null) {
      d.onError(`Cannot start the editor (${command}): ${e.message}`)
      return
    }
    void d.openPath(file).then((err) => {
      if (err) d.onError(`Cannot open ${file}: ${err}`)
    })
  }
  let child: Launched
  try {
    child = d.spawn(command, args)
  } catch (e) {
    failed(e as Error)
    return
  }
  child.on('error', failed)
  child.unref()
}

/** cross-spawn finds code.cmd through PATHEXT and quotes the arguments for cmd.exe; the editor runs on its own */
export function spawnDetached(command: string, args: string[]): Launched {
  return crossSpawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/editor-launch.test.ts tests/unit/settings.test.ts tests/unit/settings-keys.test.ts tests/unit/settings-form.test.ts && npm run typecheck`
Expected: PASS. `DEFAULT_SETTINGS` now has `review`; any existing test comparing whole settings objects keeps passing, because it compares against `DEFAULT_SETTINGS` itself.

- [ ] **Step 6: Leave uncommitted.**

---

### Task 10: Main process wiring

**Files:**
- Modify: `src/main/transcript-feed.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts`, `src/main/index.ts`
- Test: `tests/integration/transcript-feed.int.test.ts`, `tests/unit/ipc-guards.test.ts`

**Interfaces:**
- Consumes: everything of Tasks 1–9; `NOT_RUNNING` from `src/shared/review.ts` (Task 1); `ReviewHub.sessionEnded(tabId, sessionId)` (Task 7).
- Produces:
  - `TranscriptFeedOptions.onEditEvent?(ev: TranscriptEditEvent): void`, `TranscriptFeedOptions.onAssistant?(agentId: string | null, at: number): void`
  - IPC names `IPC.reviewSetScope`, `IPC.reviewClearRequest`, `IPC.reviewRefresh`, `IPC.reviewSetViewed`, `IPC.reviewShowFile`, `IPC.reviewOpenEditor`, `IPC.reviewCanSend`, `IPC.evReview`
  - `CtApi` methods (no getter: updates are pushed through `onReview`, and activating a tab computes it):
    - `setReviewScope(tabId, scope: ReviewScope): void`
    - `clearReviewRequest(tabId): void`
    - `refreshReview(tabId): void`
    - `setReviewViewed(tabId, path, hash, viewed: boolean): void`
    - `showReviewFile(tabId, path): void`
    - `openInEditor(path, line: number): void`
    - `reviewCanSend(tabId): Promise<ReviewSendState>`
    - `onReview(cb: (u: ReviewUpdate) => void): Unsubscribe`
  - guards `isReviewScope`, `isAbsPath`, `isLineNo`, `isHash`

- [ ] **Step 1: Write the failing tests**

Add inside `describe('TranscriptFeed', …)` in `tests/integration/transcript-feed.int.test.ts` (add `editResultLine` and `promptLine` to its `../fixtures/transcript` import):

```ts
  it('reports turn starts, edits and assistant entries, subagents included', async () => {
    const { projectDir, transcriptPath, cacheRoot } = setup()
    writeFileSync(transcriptPath, [promptLine('go', { uuid: 'p1' }), editResultLine({ toolUseId: 't1', filePath: '/p/a.ts' }), assistantLine('claude-opus-5-5')].join('\n') + '\n')
    const subagents = join(projectDir, SID, 'subagents')
    mkdirSync(subagents, { recursive: true })
    writeFileSync(join(subagents, 'agent-a1.jsonl'), [editResultLine({ toolUseId: 't2', filePath: '/p/b.ts' }), assistantLine('claude-opus-5-5')].join('\n') + '\n')
    const events: string[] = []
    const feed = new TranscriptFeed({
      transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: () => {},
      onEditEvent: (ev) => events.push(ev.kind === 'prompt' ? 'prompt' : `edit:${ev.toolUseId}`),
      onAssistant: (agentId) => events.push(`assistant:${agentId ?? 'main'}`)
    })
    feed.scanSubagents()
    await feed.poll()
    expect(events).toEqual(['prompt', 'edit:t1', 'assistant:main', 'edit:t2', 'assistant:a1'])
  })
```

Add to `tests/unit/ipc-guards.test.ts` (and `isAbsPath`, `isHash`, `isLineNo`, `isReviewScope` to its import):

```ts
describe('review guards', () => {
  it('checks scopes, absolute paths, line numbers and hashes', () => {
    expect(isReviewScope('last_turn')).toBe(true)
    expect(isReviewScope('week')).toBe(false)
    expect(isAbsPath(process.platform === 'win32' ? 'D:\\p\\a.ts' : '/p/a.ts')).toBe(true)
    expect(isAbsPath('a.ts')).toBe(false)
    expect(isLineNo(1)).toBe(true)
    expect(isLineNo(0)).toBe(false)
    expect(isLineNo(1.5)).toBe(false)
    expect(isHash('0123456789abcdef0123456789abcdef01234567')).toBe(true)
    expect(isHash('x'.repeat(65))).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/transcript-feed.int.test.ts tests/unit/ipc-guards.test.ts`
Expected: FAIL — the callbacks are never called; the guards do not exist.

- [ ] **Step 3: Feed the review events**

`src/main/transcript-feed.ts`:
- import `{ assistantTime, parseEditEvents, type TranscriptEditEvent } from './transcript-edits'`;
- add to `TranscriptFeedOptions`:

```ts
  /** turn starts (main transcript) and file edits (all transcripts), for the Changes panel */
  onEditEvent?(ev: TranscriptEditEvent): void
  /** an assistant entry: null for the main conversation, else the subagent's id; `at` is its transcript timestamp (0 when it has none) */
  onAssistant?(agentId: string | null, at: number): void
```

- in `consume`, call `this.reportReview(src, line)` right after `this.reportInfo(src, line)`, and add the method:

```ts
  private reportReview(src: Source, line: string): void {
    try {
      if (this.o.onEditEvent) for (const ev of parseEditEvents(line, { main: src.agentId === null })) this.o.onEditEvent(ev)
      const at = this.o.onAssistant ? assistantTime(line) : null
      if (at !== null) this.o.onAssistant?.(src.agentId, at)
    } catch (e) {
      this.report(e)
    }
  }
```

- [ ] **Step 4: IPC channels, preload and guards**

`src/shared/ipc.ts`:
- import `type { ReviewScope, ReviewSendState, ReviewUpdate } from './review'`;
- add to `IPC` (before `evTabOpened`):

```ts
  reviewSetScope: 'review:set-scope',
  reviewClearRequest: 'review:clear-request',
  reviewRefresh: 'review:refresh',
  reviewSetViewed: 'review:set-viewed',
  reviewShowFile: 'review:show-file',
  reviewOpenEditor: 'review:open-editor',
  reviewCanSend: 'review:can-send',
```

  and `evReview: 'ev:review'` after `evUpdate`;
- add to `CtApi`:

```ts
  setReviewScope(tabId: string, scope: ReviewScope): void
  /** back from a show_diff request to the scope chosen before */
  clearReviewRequest(tabId: string): void
  refreshReview(tabId: string): void
  setReviewViewed(tabId: string, path: string, hash: string, viewed: boolean): void
  /** "show anyway" for a too large file */
  showReviewFile(tabId: string, path: string): void
  openInEditor(path: string, line: number): void
  /** whether Send may write into the tab now */
  reviewCanSend(tabId: string): Promise<ReviewSendState>
  onReview(cb: (update: ReviewUpdate) => void): Unsubscribe
```

`src/preload/index.ts`, add to `api`:

```ts
  setReviewScope: (tabId, scope) => ipcRenderer.send(IPC.reviewSetScope, tabId, scope),
  clearReviewRequest: (tabId) => ipcRenderer.send(IPC.reviewClearRequest, tabId),
  refreshReview: (tabId) => ipcRenderer.send(IPC.reviewRefresh, tabId),
  setReviewViewed: (tabId, path, hash, viewed) => ipcRenderer.send(IPC.reviewSetViewed, tabId, path, hash, viewed),
  showReviewFile: (tabId, path) => ipcRenderer.send(IPC.reviewShowFile, tabId, path),
  openInEditor: (path, line) => ipcRenderer.send(IPC.reviewOpenEditor, path, line),
  reviewCanSend: (tabId) => ipcRenderer.invoke(IPC.reviewCanSend, tabId),
  onReview: (cb) => on(IPC.evReview, cb),
```

`src/main/ipc-guards.ts`:

```ts
import { isAbsolute } from 'node:path'
import { REVIEW_SCOPES, type ReviewScope } from '../shared/review'
```
```ts
export const isReviewScope = (v: unknown): v is ReviewScope => typeof v === 'string' && (REVIEW_SCOPES as readonly string[]).includes(v)

export const isAbsPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && isAbsolute(v)

export const isLineNo = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000

export const isHash = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64
```

- [ ] **Step 5: Wire the hub into main**

In `src/main/index.ts`:

1. Imports:

```ts
import { NOT_RUNNING } from '../shared/review'
import { EditLedger } from './edit-ledger'
import { launchEditor, spawnDetached } from './editor-launch'
import { isAbsPath, isHash, isLineNo, isReviewScope } from './ipc-guards'   // merge into the existing ipc-guards import
import { ReviewHub } from './review-hub'
import { createSources, nodeIo } from './review-sources'
```

2. After the `statusHub` block:

```ts
  const reviewRoot = join(dataDir, 'review')
  // Claude's edits of sessions untouched for a week go, like the image cache
  cleanupImageCache(reviewRoot, 7 * 24 * 60 * 60 * 1000)
  const review = new ReviewHub({
    sources: createSources(nodeIo),
    ledgerFor: (sessionId) => new EditLedger({ dir: join(reviewRoot, sessionId), now: () => Date.now(), onError: (m) => log.warn(m) }),
    activeTabId: () => tabs.activeTabId(),
    publish: (u) => send(IPC.evReview, u),
    onError: (m) => log.warn(m)
  })
```

`tabs` is declared further down; the closures run only after bootstrap has built it.

3. `startTabImages` gets `review.addTab(tab.id, tab.cwd, tab.kind === 'claude')`, and `onTabClosed` gets `review.removeTab(tabId)`.

4. In `TabManager` `events`: `activated: (id) => { send(IPC.evTabActivated, id); review.activated(id) },`.

5. In `attachTranscript`'s `new TranscriptFeed({ … })`, add:

```ts
      onEditEvent: (ev) => review.transcriptEvent(tabId, ev),
      onAssistant: (agentId, at) => review.assistantEntry(tabId, agentId, at),
```

6. Pipe handlers. Replace the Task 1 stubs and extend the others:

```ts
    session: (msg) => {
      // …existing lines…
      statusHub.session(msg.tabId, msg.sessionId, msg.source)
      // compact keeps the open dialogs: the conversation goes on
      review.sessionStarted(msg.tabId, msg.sessionId, msg.source)
      if (msg.transcriptPath) attachTranscript(msg.tabId, msg.sessionId, msg.transcriptPath)
      return { ok: true }
    },
```
```ts
    sessionEnd: (msg) => {
      // …existing lines…
      statusHub.sessionEnd(msg.tabId, msg.sessionId)
      // a late SessionEnd of the session before /clear leaves the new one running
      review.sessionEnded(msg.tabId, msg.sessionId)
      return { ok: true }
    },
    attention: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      // Send must never press Enter into a dialog; the end of a turn is a moment to look at the changes
      if (msg.reason === 'done') review.turnEnded(msg.tabId)
      else review.dialogOpened(msg.tabId, msg.agentId ?? null)
      const signalled = attention.notify(msg.tabId, msg.reason)
      log.info(`attention ${msg.reason} tab=${msg.tabId}${signalled ? '' : ' (seen)'}`)
      return { ok: true }
    },
    turn: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      review.turn(msg.tabId, msg.sessionId, msg.cwd)
      return { ok: true }
    },
    editBefore: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      // the reply lets the edit go ahead: the file is read before it
      review.recordBefore(msg.tabId, msg.sessionId, msg.toolUseId, msg.path)
      return { ok: true }
    },
    showDiff: (msg) => review.showRequest(msg.tabId, { cwd: msg.cwd, scope: msg.scope, from: msg.from, to: msg.to, paths: msg.paths, title: msg.title })
```

7. IPC handlers, next to the image handlers:

```ts
  ipcMain.on(IPC.reviewSetScope, (_e, tabId: unknown, scope: unknown) => { if (isId(tabId) && isReviewScope(scope)) review.setScope(tabId, scope) })
  ipcMain.on(IPC.reviewClearRequest, (_e, tabId: unknown) => { if (isId(tabId)) review.clearRequest(tabId) })
  ipcMain.on(IPC.reviewRefresh, (_e, tabId: unknown) => { if (isId(tabId)) review.refresh(tabId) })
  ipcMain.on(IPC.reviewSetViewed, (_e, tabId: unknown, path: unknown, hash: unknown, viewed: unknown) => {
    if (isId(tabId) && isAbsPath(path) && isHash(hash) && typeof viewed === 'boolean') review.setViewed(tabId, path, hash, viewed)
  })
  ipcMain.on(IPC.reviewShowFile, (_e, tabId: unknown, path: unknown) => { if (isId(tabId) && isAbsPath(path)) review.showFile(tabId, path) })
  ipcMain.on(IPC.reviewOpenEditor, (_e, path: unknown, line: unknown) => {
    if (isAbsPath(path) && isLineNo(line)) launchEditor(settings.review.editor, path, line, { spawn: spawnDetached, openPath: (p) => shell.openPath(p), onError: toast })
  })
  ipcMain.handle(IPC.reviewCanSend, (_e, tabId: unknown) => (isId(tabId) ? review.canSend(tabId) : { ok: false, reason: NOT_RUNNING }))
```

8. The window coming back to the front recomputes the active tab. This catches the user's own edits in an editor:

```ts
  win.on('focus', () => {
    win?.flashFrame(false)
    const id = tabs.activeTabId()
    if (id) review.trigger(id)
  })
```

9. In `before-quit`, after `tabs.disposeAll()`: `review.dispose()`.

- [ ] **Step 6: Run the tests and the build**

Run: `npx vitest run tests/integration/transcript-feed.int.test.ts tests/unit/ipc-guards.test.ts && npm run typecheck && npm test && npm run build`
Expected: PASS; the build bundles `diff` and `cross-spawn` into `out/main/index.js` without errors.

- [ ] **Step 7: Leave uncommitted.**

---

### Task 11: The side panel with two tabs

**Files:**
- Create: `src/renderer/side-panel.ts`
- Modify: `src/renderer/image-panel.ts`, `src/renderer/keymap.ts`, `src/renderer/main.ts`, `src/renderer/styles.css`
- Test: `tests/unit/keymap.test.ts`; e2e `tests/e2e/image-button.spec.ts` and `tests/e2e/images.spec.ts` must keep passing

**Interfaces:**
- Produces:
  - `type PanelTab = 'images' | 'changes'`
  - `class SidePanel`:
    - `constructor(root: HTMLElement, widths: Record<PanelTab, number>)`
    - members `bodies: Record<PanelTab, HTMLElement>`, `tools: HTMLElement`, `onChange: () => void`
    - getters `visible`, `tab`, `expanded`
    - methods `isShowing(tab)`, `open(tab)`, `hide()`, `toggle(tab)`, `setBadge(tab, n)`, `setAvailable(tab, available)`, `setExpanded(on)`
  - `class ImagePanel`:
    - `constructor(root: HTMLElement, panel: SidePanel, cb: ImagePanelCallbacks, autoOpen: () => boolean)`
    - getter `visible` (the Images tab is on screen)
    - methods `toggle()`, `panelChanged()`, `show(update)`
  - `KeyAction` adds `{ type: 'toggleChanges' }` (Ctrl+Shift+D)

- [ ] **Step 1: Write the failing keymap test**

Add inside `describe('mapKey', …)` in `tests/unit/keymap.test.ts` (it already has the helpers `k(code, mods, key)` and `cs`):

```ts
  it('maps Ctrl+Shift+D to the Changes panel, in any layout', () => {
    expect(mapKey(k('KeyD', cs, 'D'))).toEqual({ type: 'toggleChanges' })
    expect(mapKey(k('KeyD', cs, 'В'))).toEqual({ type: 'toggleChanges' })
  })
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/unit/keymap.test.ts`
Expected: FAIL — `null`.

- [ ] **Step 3: Add the key**

`src/renderer/keymap.ts`: add `| { type: 'toggleChanges' }` to `KeyAction`, and `case 'KeyD': return { type: 'toggleChanges' }` to the `Ctrl+Shift` switch.

- [ ] **Step 4: Write the side panel**

`src/renderer/side-panel.ts`:

```ts
export type PanelTab = 'images' | 'changes'

const TABS: readonly PanelTab[] = ['images', 'changes']
const LABELS: Record<PanelTab, string> = { images: 'Images', changes: 'Changes' }
/** how wide a drag may make each tab, as a share of the window */
const MAX_SHARE: Record<PanelTab, number> = { images: 0.7, changes: 0.85 }
const EXPANDED_SHARE = 0.85
const MIN_WIDTH = 180

/** The right-hand panel: Images and Changes, one shown at a time, each with its own width. */
export class SidePanel {
  readonly bodies: Record<PanelTab, HTMLElement>
  /** the Changes tab puts its buttons here */
  readonly tools: HTMLElement
  /** shown, hidden, switched or expanded */
  onChange: () => void = () => {}
  private shownTab: PanelTab | null = null
  private currentTab: PanelTab = 'images'
  private isExpanded = false
  private readonly buttons: Record<PanelTab, HTMLButtonElement>
  private readonly badges: Record<PanelTab, HTMLElement>
  private readonly available: Record<PanelTab, boolean> = { images: true, changes: false }

  constructor(private readonly root: HTMLElement, private readonly widths: Record<PanelTab, number>) {
    const handle = document.createElement('div')
    handle.className = 'panel-resize'
    const header = document.createElement('div')
    header.className = 'panel-header'
    const tabs = document.createElement('div')
    tabs.className = 'panel-tabs'
    const buttons = {} as Record<PanelTab, HTMLButtonElement>
    const badges = {} as Record<PanelTab, HTMLElement>
    for (const tab of TABS) {
      const b = document.createElement('button')
      b.className = 'panel-tab'
      b.dataset.tab = tab
      b.textContent = LABELS[tab]
      b.hidden = !this.available[tab]
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.hidden = true
      b.append(badge)
      b.addEventListener('click', () => this.open(tab))
      tabs.append(b)
      buttons[tab] = b
      badges[tab] = badge
    }
    this.buttons = buttons
    this.badges = badges
    this.tools = document.createElement('div')
    this.tools.className = 'panel-tools'
    const hide = document.createElement('button')
    hide.className = 'panel-hide'
    hide.textContent = '–'
    hide.title = 'Hide'
    hide.addEventListener('click', () => this.hide())
    header.append(tabs, this.tools, hide)
    const body = (tab: PanelTab): HTMLElement => {
      const el = document.createElement('div')
      el.className = `panel-body panel-${tab}`
      return el
    }
    this.bodies = { images: body('images'), changes: body('changes') }
    root.replaceChildren(handle, header, this.bodies.images, this.bodies.changes)
    this.setupResize(handle)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isExpanded && !e.defaultPrevented) this.setExpanded(false)
    })
    window.addEventListener('resize', () => this.apply())
    this.apply()
  }

  get visible(): boolean {
    return this.shownTab !== null
  }

  get tab(): PanelTab {
    return this.currentTab
  }

  get expanded(): boolean {
    return this.isExpanded
  }

  isShowing(tab: PanelTab): boolean {
    return this.shownTab === tab
  }

  open(tab: PanelTab): void {
    if (!this.available[tab] || this.shownTab === tab) return
    this.currentTab = tab
    this.shownTab = tab
    if (tab !== 'changes') this.isExpanded = false
    this.apply()
    this.onChange()
  }

  hide(): void {
    if (this.shownTab === null) return
    this.shownTab = null
    this.isExpanded = false
    this.apply()
    this.onChange()
  }

  toggle(tab: PanelTab): void {
    if (this.shownTab === tab) this.hide()
    else this.open(tab)
  }

  setBadge(tab: PanelTab, n: number): void {
    this.badges[tab].textContent = String(n)
    this.badges[tab].hidden = n === 0
  }

  /** Changes exists only for Claude tabs: a shell tab shows Images in its place */
  setAvailable(tab: PanelTab, available: boolean): void {
    if (this.available[tab] === available) return
    this.available[tab] = available
    this.buttons[tab].hidden = !available
    if (available || this.currentTab !== tab) return
    this.currentTab = tab === 'changes' ? 'images' : 'changes'
    if (this.shownTab !== null) this.shownTab = this.currentTab
    this.isExpanded = false
    this.apply()
    this.onChange()
  }

  setExpanded(on: boolean): void {
    const next = on && this.shownTab === 'changes'
    if (next === this.isExpanded) return
    this.isExpanded = next
    this.apply()
    this.onChange()
  }

  private apply(): void {
    this.root.classList.toggle('collapsed', this.shownTab === null)
    this.root.classList.toggle('expanded', this.isExpanded)
    for (const t of TABS) {
      this.buttons[t].classList.toggle('active', this.currentTab === t)
      this.bodies[t].hidden = this.currentTab !== t
    }
    this.tools.hidden = this.currentTab !== 'changes'
    const width = this.isExpanded ? Math.round(window.innerWidth * EXPANDED_SHARE) : this.widths[this.currentTab]
    this.root.style.width = `${width}px`
  }

  private setupResize(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const tab = this.currentTab
      const startX = e.clientX
      const startW = this.root.getBoundingClientRect().width
      this.isExpanded = false
      this.root.classList.remove('expanded')
      const move = (ev: MouseEvent): void => {
        this.widths[tab] = Math.min(Math.max(startW + (startX - ev.clientX), MIN_WIDTH), Math.round(window.innerWidth * MAX_SHARE[tab]))
        this.root.style.width = `${this.widths[tab]}px`
      }
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        this.onChange()
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
  }
}
```

- [ ] **Step 5: Move the image panel into the Images body**

In `src/renderer/image-panel.ts`:
- import `type { SidePanel } from './side-panel'`;
- remove the fields `collapsed` and `width`, the property `onVisibilityChange`, and the methods `setCollapsed` and `setupResize`;
- replace the constructor and the visibility members with:

```ts
  constructor(root: HTMLElement, private readonly panel: SidePanel, private readonly cb: ImagePanelCallbacks, private readonly autoOpen: () => boolean) {
    this.noticeEl = document.createElement('div')
    this.noticeEl.className = 'panel-notice'
    this.list = document.createElement('div')
    this.list.className = 'panel-list'
    root.replaceChildren(this.noticeEl, this.list)
  }

  /** the Images tab is on screen */
  get visible(): boolean {
    return this.panel.isShowing('images')
  }

  toggle(): void {
    this.panel.toggle('images')
  }

  /** the side panel was shown, hidden or switched */
  panelChanged(): void {
    if (this.visible && this.current && this.current.unseen > 0) this.cb.markSeen(this.current.tabId)
  }

  show(update: ImagesUpdate): void {
    this.current = update
    // a new image opens the panel only when it is closed: it never takes the place of Changes
    if (update.cards.length > 0 && !this.panel.visible && this.autoOpen() && !this.autoOpened.has(update.tabId)) {
      this.autoOpened.add(update.tabId)
      this.panel.open('images')
    }
    this.renderList()
    if (this.visible && update.unseen > 0) this.cb.markSeen(update.tabId)
  }
```

`renderList` and `renderCard` stay as they are.

- [ ] **Step 6: Use the side panel in main.ts**

In `src/renderer/main.ts`:
1. `import { SidePanel } from './side-panel'` and `let sidePanel: SidePanel`.
2. Replace the `imagePanel = new ImagePanel(...)` statement and the two lines after it (`toggleImagePanel = …`, `imagePanel.onVisibilityChange = refreshImageButton`) with the block below; the `refreshImageButton()` call that follows them stays:

```ts
  sidePanel = new SidePanel(document.getElementById('image-panel')!, { images: settings.imagePanel.width, changes: settings.review.width })
  imagePanel = new ImagePanel(
    sidePanel.bodies.images,
    sidePanel,
    {
      action: (id, action) => ct.imageAction(id, action),
      insertPath: (p) => {
        if (!activeId) return
        handleInput(activeId, `"${p}" `)
        tabs.get(activeId)?.view.term.focus()
      },
      open: (cards, index) => lightbox.open(cards, index),
      markSeen: (tabId) => ct.markImagesSeen(tabId)
    },
    () => settings.imagePanel.autoOpen
  )
  toggleImagePanel = () => imagePanel.toggle()
  sidePanel.onChange = () => {
    imagePanel.panelChanged()
    refreshImageButton()
  }
```

3. `refreshImageButton`:

```ts
function refreshImageButton(): void {
  const unseen = activeId ? imageUpdates.get(activeId)?.unseen ?? 0 : 0
  tabBar.setImages(imagePanel.visible, unseen)
  sidePanel.setBadge('images', unseen)
}
```

4. `runAction`: `case 'toggleChanges': if (t?.info.kind === 'claude') sidePanel.toggle('changes'); break`.
5. `activate`: before `imagePanel.show(…)`, add `sidePanel.setAvailable('changes', tabs.get(tabId)?.info.kind === 'claude')`. Change the focus check to keep a comment box focused:

```ts
  const busy = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
  const focus = !busy
```

6. The document `keydown` handler leaves text areas alone: `if (target?.closest('.xterm') || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return`.
7. The window `focus` handler keeps focus in the panel: add `if (document.activeElement?.closest('#image-panel')) return` after the `sessionsWindow.isOpen` check.

- [ ] **Step 7: Styles**

In `src/renderer/styles.css`, replace the `.panel-header` and `.panel-header button` rules with:

```css
.panel-header { display: flex; align-items: center; gap: 4px; padding: 0 6px; border-bottom: 1px solid var(--border); color: var(--muted); }
.panel-tabs { display: flex; gap: 2px; }
.panel-tab { position: relative; background: none; border: 0; color: var(--muted); padding: 7px 10px; cursor: pointer; font: inherit; }
.panel-tab:hover { color: var(--fg); }
.panel-tab.active { color: var(--fg); box-shadow: inset 0 -2px 0 var(--accent); }
.panel-tab .badge { display: inline-block; min-width: 14px; height: 14px; margin-left: 5px; padding: 0 3px; box-sizing: border-box; border-radius: 7px; background: var(--accent); color: #111; font-size: 10px; line-height: 14px; font-weight: 600; text-align: center; }
.panel-tab .badge[hidden] { display: none; }
.panel-tools { margin-left: auto; display: flex; gap: 2px; }
.panel-tools[hidden] { display: none; }
.panel-tools button, .panel-hide { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 15px; padding: 4px 6px; }
.panel-tools button:hover, .panel-hide:hover { color: var(--fg); }
.panel-tools button.active { color: var(--accent); }
.panel-tools[hidden] + .panel-hide { margin-left: auto; }
.panel-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.panel-body[hidden] { display: none; }
```

- [ ] **Step 8: Run the checks**

Run: `npx vitest run tests/unit/keymap.test.ts && npm run typecheck && npm test && npx playwright test tests/e2e/image-button.spec.ts tests/e2e/images.spec.ts tests/e2e/layout.spec.ts`

(`npm run build` first if the e2e config does not build; `npm run test:e2e` builds and runs everything.)

Expected: PASS — the images button, `Ctrl+Shift+I`, the badge and auto-open behave as before.

- [ ] **Step 9: Leave uncommitted.**

---

### Task 12: The Changes panel, comments, Send and the status bar counter

**Files:**
- Create: `src/renderer/review-comments.ts`, `src/renderer/review-panel.ts`
- Modify: `src/renderer/status-bar.ts`, `src/renderer/main.ts`, `src/renderer/env.d.ts`, `src/renderer/styles.css`
- Test: `tests/unit/review-comments.test.ts`, `tests/unit/status-bar.test.ts`

**Interfaces:**
- Consumes: `ReviewUpdate`, `ReviewFile`, `ReviewLine`, `ReviewCounter`, `NOT_RUNNING` (Task 1); `SidePanel` (Task 11); `CtApi` review methods (Task 10).
- Produces (`review-comments.ts`):
  - `interface AnchorLine { kind: ReviewLineKind; text: string; oldNo: number | null; newNo: number | null }`
  - `interface CommentAnchor { path: string; relPath: string; lines: AnchorLine[]; viewKey: string }`
  - `interface ReviewComment { id: string; anchor: CommentAnchor; text: string; outdated: boolean }`
  - `interface Located { file: number; hunk: number; from: number; to: number }`
  - `MAX_QUOTE_LINES = 6`, `NEAR_LINES = 50`
  - `viewKeyOf(u)`, `anchorOf(file, lines, viewKey)`, `locate(anchor, files, samePath)`, `moveAnchor(anchor, files, at)`, `location(anchor)`, `describeLines(anchor)`, `formatSendMessage(label, comments)`
- Produces (`review-panel.ts`):
  - `interface ReviewPanelCallbacks { setScope; clearRequest; refresh; setViewed; showFile; openEditor; copyText; send(tabId, message): Promise<string | null> }`
  - `class ReviewPanel` with `constructor(root, panel: SidePanel, cb, platform: string)` and the methods `show(update: ReviewUpdate | null)`, `dropTab(tabId)`, `panelChanged()`
- Produces (`status-bar.ts`): `Segment.key` adds `'changes'`; `changesSegment(c: ReviewCounter): Segment` (`statusSegments(u, now)` stays as it is); `StatusBar` gets `constructor(el, onChangesClick?: () => void)` and `render(u, changes = null, now = Date.now())`, which shows the counter after Claude's segments, and alone when the tab has no status yet (before the first statusLine, after the session ends).

- [ ] **Step 1: Write the failing comment tests**

`tests/unit/review-comments.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { anchorOf, formatSendMessage, locate, location, moveAnchor, type ReviewComment } from '../../src/renderer/review-comments'
import type { ReviewFile, ReviewLine } from '../../src/shared/review'

const L = (kind: ReviewLine['kind'], text: string, oldNo: number | null, newNo: number | null): ReviewLine => ({ kind, text, oldNo, newNo })
const file = (relPath: string, lines: ReviewLine[], path = `/r/${relPath}`): ReviewFile => ({
  path, relPath, status: 'modified', additions: 0, deletions: 0, hunks: [{ header: '@@', lines }], note: null, canForce: false, hash: 'h', viewed: false
})
const same = (a: string, b: string): boolean => a === b
const comment = (anchor: ReviewComment['anchor'], text: string, outdated = false): ReviewComment => ({ id: 'c', anchor, text, outdated })

describe('formatSendMessage', () => {
  it('writes the spec example', () => {
    const hub = file('src/main/image-hub.ts', [L('context', '    const key = pathKey(p)', 39, 39), L('del', '    if (seen.has(p)) return', 40, null), L('add', '    if (seen.has(key)) return', null, 40), L('add', '    seen.add(key)', null, 41)])
    const test = file('tests/unit/image-hub.test.ts', [L('del', '    expect(hub.size).toBe(1)', 12, null)])
    const msg = formatSendMessage('uncommitted', [
      comment(anchorOf(hub, hub.hunks[0]!.lines.slice(2, 4), 'scope:uncommitted'), "What if p is empty? pathKey('') returns '.' here."),
      comment(anchorOf(test, test.hunks[0]!.lines, 'scope:uncommitted'), 'Why was this check dropped?')
    ])
    expect(msg).toBe([
      'Review comments on the changes (uncommitted):',
      '',
      '1. src/main/image-hub.ts:40-41',
      '   > if (seen.has(key)) return',
      '   > seen.add(key)',
      "   What if p is empty? pathKey('') returns '.' here.",
      '',
      '2. tests/unit/image-hub.test.ts:12 (removed line, was: expect(hub.size).toBe(1))',
      '   Why was this check dropped?'
    ].join('\n'))
  })

  it('cuts a quote at 6 lines, marks mixed lines and outdated comments', () => {
    const lines = Array.from({ length: 8 }, (_, i) => L('add', `line ${i + 1}`, null, i + 1))
    const f = file('a.ts', lines)
    const long = formatSendMessage('session', [comment(anchorOf(f, lines, 'k'), 'Too long')])
    expect(long.split('\n').filter((l) => l.startsWith('   >'))).toEqual(['   > line 1', '   > line 2', '   > line 3', '   > line 4', '   > line 5', '   > line 6', '   > …'])
    const mixed = file('b.ts', [L('del', 'old', 3, null), L('add', 'new', null, 3)])
    expect(formatSendMessage('last turn', [comment(anchorOf(mixed, mixed.hunks[0]!.lines, 'k'), 'Hm', true)])).toBe(
      ['Review comments on the changes (last turn):', '', '1. b.ts:3 (outdated: the lines changed since)', '   > -old', '   > +new', '   Hm'].join('\n')
    )
  })

  it('names a range of removed lines', () => {
    const f = file('c.ts', [L('del', 'a', 7, null), L('del', 'b', 8, null)])
    expect(location(anchorOf(f, f.hunks[0]!.lines, 'k'))).toBe('c.ts:7-8 (removed lines)')
  })
})

describe('locate', () => {
  const lines = [L('context', 'x', 1, 1), L('add', 'target', null, 2), L('context', 'y', 2, 3)]
  const f = file('a.ts', lines)
  const anchor = anchorOf(f, [lines[1]!], 'k')

  it('finds the same lines after they moved, and moves the anchor', () => {
    const moved = file('a.ts', [L('context', 'z', 1, 1), ...Array.from({ length: 10 }, (_, i) => L('add', `n${i}`, null, i + 2)), L('add', 'target', null, 12)])
    const at = locate(anchor, [moved], same)
    expect(at).toEqual({ file: 0, hunk: 0, from: 11, to: 11 })
    expect(moveAnchor(anchor, [moved], at!).lines[0]!.newNo).toBe(12)
  })

  it('takes the nearest copy and gives up beyond 50 lines or when the text changed', () => {
    const twice = file('a.ts', [L('add', 'target', null, 60), L('context', 'q', 1, 61), L('add', 'target', null, 3)])
    expect(locate(anchor, [twice], same)).toEqual({ file: 0, hunk: 0, from: 2, to: 2 })
    expect(locate(anchor, [file('a.ts', [L('add', 'target', null, 80)])], same)).toBeNull()
    expect(locate(anchor, [file('a.ts', [L('add', 'TARGET', null, 2)])], same)).toBeNull()
    expect(locate(anchor, [file('b.ts', lines)], same)).toBeNull()
  })

  it('compares paths with the given rule', () => {
    const upper = file('a.ts', lines, '/R/A.TS')
    expect(locate(anchor, [upper], (a, b) => a.toLowerCase() === b.toLowerCase())).not.toBeNull()
  })
})
```

Add at the end of `tests/unit/status-bar.test.ts` (and `changesSegment` to its `../../src/renderer/status-bar` import):

```ts
describe('changesSegment', () => {
  it('counts the files and lines, and names the scope in the title', () => {
    expect(changesSegment({ files: 3, additions: 40, deletions: 12, title: 'Uncommitted changes in D:\\repo' }))
      .toEqual({ key: 'changes', text: '± 3 files +40 −12', title: 'Uncommitted changes in D:\\repo', level: 'normal' })
    expect(changesSegment({ files: 1, additions: 1, deletions: 0, title: 't' }).text).toBe('± 1 file +1 −0')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/review-comments.test.ts tests/unit/status-bar.test.ts`
Expected: FAIL — missing module; no `changesSegment` export.

- [ ] **Step 3: Write the comment helpers**

`src/renderer/review-comments.ts`:

```ts
import type { ReviewFile, ReviewLine, ReviewLineKind } from '../shared/review'

export interface AnchorLine {
  kind: ReviewLineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

/** what a comment is about: lines of a file, by their text and place */
export interface CommentAnchor {
  path: string
  relPath: string
  lines: AnchorLine[]
  /** the view it was written in: there it follows its lines; elsewhere it is only looked up */
  viewKey: string
}

export interface ReviewComment {
  id: string
  anchor: CommentAnchor
  text: string
  outdated: boolean
}

export interface Located {
  file: number
  hunk: number
  from: number
  to: number
}

export const MAX_QUOTE_LINES = 6
export const NEAR_LINES = 50

export function viewKeyOf(u: { view: { kind: 'scope'; scope: string } | { kind: 'request' }; label: string }): string {
  return u.view.kind === 'scope' ? `scope:${u.view.scope}` : `request:${u.label}`
}

export function anchorOf(file: ReviewFile, lines: ReviewLine[], viewKey: string): CommentAnchor {
  return { path: file.path, relPath: file.relPath, lines: lines.map((l) => ({ ...l })), viewKey }
}

const position = (l: { oldNo: number | null; newNo: number | null }, side: 'new' | 'old'): number => (side === 'new' ? l.newNo : l.oldNo) ?? 0

/** The anchor's lines in `files`: the same lines of the same file, nearest to where they were, within 50 lines. */
export function locate(anchor: CommentAnchor, files: ReviewFile[], samePath: (a: string, b: string) => boolean): Located | null {
  const fi = files.findIndex((f) => samePath(f.path, anchor.path))
  const first = anchor.lines[0]
  if (fi < 0 || !first) return null
  const side = first.newNo !== null ? 'new' : 'old'
  const target = position(first, side)
  let best: Located | null = null
  let bestDist = Number.POSITIVE_INFINITY
  files[fi]!.hunks.forEach((h, hi) => {
    for (let i = 0; i + anchor.lines.length <= h.lines.length; i++) {
      if (!anchor.lines.every((w, k) => h.lines[i + k]!.kind === w.kind && h.lines[i + k]!.text === w.text)) continue
      const dist = Math.abs(position(h.lines[i]!, side) - target)
      if (dist <= NEAR_LINES && dist < bestDist) {
        best = { file: fi, hunk: hi, from: i, to: i + anchor.lines.length - 1 }
        bestDist = dist
      }
    }
  })
  return best
}

/** the anchor moved to where `at` found its lines */
export function moveAnchor(anchor: CommentAnchor, files: ReviewFile[], at: Located): CommentAnchor {
  return { ...anchor, lines: files[at.file]!.hunks[at.hunk]!.lines.slice(at.from, at.to + 1).map((l) => ({ ...l })) }
}

function range(nums: number[]): string {
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  return lo === hi ? `${lo}` : `${lo}-${hi}`
}

/** "src/a.ts:40-41", or the old numbers of removed lines */
export function location(a: CommentAnchor): string {
  const news = a.lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))
  if (news.length > 0) return `${a.relPath}:${range(news)}`
  const olds = a.lines.flatMap((l) => (l.oldNo === null ? [] : [l.oldNo]))
  if (a.lines.length === 1) return `${a.relPath}:${range(olds)} (removed line, was: ${a.lines[0]!.text.trim()})`
  return `${a.relPath}:${range(olds)} (removed lines)`
}

/** "Line 40", "Lines 40–41", "Removed line 12" — the header of a comment box */
export function describeLines(a: CommentAnchor): string {
  const news = a.lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))
  const nums = news.length > 0 ? news : a.lines.flatMap((l) => (l.oldNo === null ? [] : [l.oldNo]))
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  const what = news.length > 0 ? 'Line' : 'Removed line'
  return lo === hi ? `${what} ${lo}` : `${what}s ${lo}–${hi}`
}

const indentOf = (s: string): number => /^\s*/.exec(s)![0].length

function quote(a: CommentAnchor): string[] {
  // a single removed line is quoted in the location already
  if (a.lines.length === 1 && a.lines[0]!.kind === 'del') return []
  const mixed = a.lines.some((l) => l.kind === 'del') && a.lines.some((l) => l.kind !== 'del')
  const mark = (l: AnchorLine): string => (!mixed ? '' : l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ')
  const shown = a.lines.slice(0, MAX_QUOTE_LINES)
  const cut = Math.min(...shown.filter((l) => l.text.trim() !== '').map((l) => indentOf(l.text)))
  const out = shown.map((l) => `   > ${mark(l)}${l.text.slice(Number.isFinite(cut) ? Math.min(cut, indentOf(l.text)) : 0)}`.trimEnd())
  if (a.lines.length > MAX_QUOTE_LINES) out.push('   > …')
  return out
}

/** The message Send writes into Claude's prompt. */
export function formatSendMessage(label: string, comments: ReviewComment[]): string {
  const blocks = comments.map((c, i) => {
    const where = location(c.anchor) + (c.outdated ? ' (outdated: the lines changed since)' : '')
    const body = c.text.trim().split(/\r?\n/).map((l) => `   ${l}`.trimEnd())
    return [`${i + 1}. ${where}`, ...quote(c.anchor), ...body].join('\n')
  })
  return [`Review comments on the changes (${label}):`, '', blocks.join('\n\n')].join('\n')
}
```

- [ ] **Step 4: Add the status bar segment**

In `src/renderer/status-bar.ts`:
- import `type { ReviewCounter } from '../shared/review'`;
- `key: 'model' | 'context' | 'limit' | 'week' | 'agents' | 'changes'`;
- `statusSegments` stays as it is; after it, add:

```ts
/** the Changes counter: not part of Claude's status, so it shows before the first statusLine and after the session ends too */
export function changesSegment(c: ReviewCounter): Segment {
  return { key: 'changes', text: `± ${c.files} file${c.files === 1 ? '' : 's'} +${c.additions} −${c.deletions}`, title: c.title, level: 'normal' }
}
```

- `StatusBar` (only the constructor and the first line of `render` change):

```ts
export class StatusBar {
  constructor(private readonly el: HTMLElement, onChangesClick: () => void = () => {}) {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.status-changes')) onChangesClick()
    })
  }

  render(u: StatusUpdate | null, changes: ReviewCounter | null = null, now = Date.now()): void {
    const segments = [...(u ? statusSegments(u, now) : []), ...(changes ? [changesSegment(changes)] : [])]
    // …the rest of the method unchanged
  }
}
```

- [ ] **Step 5: Write the Changes panel**

`src/renderer/review-panel.ts`:

```ts
import type { ReviewFile, ReviewFileNote, ReviewHunk, ReviewLine, ReviewScope, ReviewUpdate } from '../shared/review'
import { showMenu } from './menu'
import { anchorOf, describeLines, formatSendMessage, locate, moveAnchor, viewKeyOf, type CommentAnchor, type Located, type ReviewComment } from './review-comments'
import type { SidePanel } from './side-panel'

export interface ReviewPanelCallbacks {
  setScope(tabId: string, scope: ReviewScope): void
  clearRequest(tabId: string): void
  refresh(tabId: string): void
  setViewed(tabId: string, path: string, hash: string, viewed: boolean): void
  showFile(tabId: string, path: string): void
  openEditor(path: string, line: number): void
  copyText(text: string): void
  /** writes the message into Claude's prompt and presses Enter; resolves to null, or to why it was not sent */
  send(tabId: string, message: string): Promise<string | null>
}

const SCOPES: { scope: ReviewScope; label: string }[] = [
  { scope: 'uncommitted', label: 'Uncommitted' },
  { scope: 'last_turn', label: 'Last turn' },
  { scope: 'session', label: 'Session' }
]
/** a file with more changed lines than this starts folded */
export const FOLD_LINES = 1000
const NOTES: Record<ReviewFileNote, string> = {
  binary: 'binary',
  'too-large': 'too large',
  'eol-only': 'line endings changed only',
  'no-baseline': 'no baseline — use Uncommitted',
  submodule: 'submodule',
  unreadable: "can't be read",
  'too-many': 'not shown'
}
const STATUS: Record<ReviewFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D' }

interface Draft {
  anchor: CommentAnchor
  text: string
  /** the comment being edited; null for a new one */
  editing: string | null
}

interface TabComments {
  comments: ReviewComment[]
  draft: Draft | null
  /** files folded or unfolded by hand: path → folded */
  folds: Map<string, boolean>
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** the new-side line to open in an editor for a line of a hunk: its own, or the nearest one */
function editorLine(h: ReviewHunk, index: number): number {
  for (let i = index; i < h.lines.length; i++) if (h.lines[i]!.newNo !== null) return h.lines[i]!.newNo!
  for (let i = index; i >= 0; i--) if (h.lines[i]!.newNo !== null) return h.lines[i]!.newNo!
  return 1
}

const firstLine = (f: ReviewFile): number => (f.hunks[0] ? editorLine(f.hunks[0], 0) : 1)

let nextId = 1

/** The Changes tab: scopes, files, hunks, comments and Send. */
export class ReviewPanel {
  private update: ReviewUpdate | null = null
  private readonly perTab = new Map<string, TabComments>()
  private readonly scopeBar = el('div', 'review-scope')
  private readonly noticeEl = el('div', 'panel-notice')
  private readonly outsideEl = el('div', 'review-outside')
  private readonly filesEl = el('div', 'review-files')
  private readonly footer = el('div', 'review-footer')
  private readonly countEl = el('span', 'review-count')
  private readonly sendBtn = el('button', 'review-send', 'Send to Claude')
  private readonly expandBtn = el('button', 'review-expand', '⤢')
  private draftArea: HTMLTextAreaElement | null = null
  private drag: { file: number; hunk: number; from: number; to: number } | null = null
  private sending = false
  private sendError: string | null = null
  private wasShowing = false
  private readonly samePath: (a: string, b: string) => boolean

  constructor(root: HTMLElement, private readonly panel: SidePanel, private readonly cb: ReviewPanelCallbacks, platform: string) {
    this.samePath = platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b
    const refresh = el('button', 'review-refresh', '⟳')
    refresh.title = 'Refresh'
    refresh.addEventListener('click', () => { if (this.update) this.cb.refresh(this.update.tabId) })
    this.expandBtn.title = 'Expand'
    this.expandBtn.addEventListener('click', () => this.panel.setExpanded(!this.panel.expanded))
    panel.tools.append(refresh, this.expandBtn)
    this.sendBtn.addEventListener('click', () => void this.sendAll())
    this.footer.append(this.countEl, this.sendBtn)
    root.replaceChildren(this.scopeBar, this.noticeEl, this.outsideEl, this.filesEl, this.footer)
    document.addEventListener('mouseup', () => this.endDrag())
    this.render()
  }

  /** the active tab's review; null for a shell tab */
  show(update: ReviewUpdate | null): void {
    if (update?.tabId !== this.update?.tabId) this.sendError = null
    this.update = update
    if (update) this.reanchor(update)
    this.render()
  }

  dropTab(tabId: string): void {
    this.perTab.delete(tabId)
  }

  /** the side panel changed: opening Changes recomputes it */
  panelChanged(): void {
    this.expandBtn.classList.toggle('active', this.panel.expanded)
    const showing = this.panel.isShowing('changes')
    if (showing && !this.wasShowing && this.update) this.cb.refresh(this.update.tabId)
    this.wasShowing = showing
  }

  private state(tabId: string): TabComments {
    let s = this.perTab.get(tabId)
    if (!s) {
      s = { comments: [], draft: null, folds: new Map() }
      this.perTab.set(tabId, s)
    }
    return s
  }

  /** comments written in this view follow their lines; ones whose lines are gone become outdated */
  private reanchor(u: ReviewUpdate): void {
    const s = this.state(u.tabId)
    const key = viewKeyOf(u)
    for (const c of s.comments) {
      if (c.anchor.viewKey !== key) continue
      const at = locate(c.anchor, u.files, this.samePath)
      if (at) {
        c.anchor = moveAnchor(c.anchor, u.files, at)
        c.outdated = false
      } else {
        c.outdated = true
      }
    }
    if (s.draft?.anchor.viewKey === key) {
      const at = locate(s.draft.anchor, u.files, this.samePath)
      if (at) s.draft.anchor = moveAnchor(s.draft.anchor, u.files, at)
    }
  }

  private render(): void {
    const u = this.update
    // keep the comment being typed, its focus and caret, across the re-render
    const prev = this.draftArea
    const caret = prev !== null && document.activeElement === prev ? ([prev.selectionStart, prev.selectionEnd] as const) : null
    this.draftArea = null
    if (!u) {
      this.scopeBar.replaceChildren()
      this.noticeEl.hidden = true
      this.outsideEl.replaceChildren()
      this.outsideEl.hidden = true
      this.filesEl.replaceChildren(el('div', 'panel-empty', 'No changes'))
      this.footer.hidden = true
      return
    }
    const s = this.state(u.tabId)
    this.renderScope(u)
    this.noticeEl.textContent = u.notice ?? ''
    this.noticeEl.hidden = !u.notice
    const placed = new Map<string, ReviewComment[]>()
    const outside: ReviewComment[] = []
    for (const c of s.comments) {
      const at = c.outdated ? null : locate(c.anchor, u.files, this.samePath)
      if (!at) {
        outside.push(c)
        continue
      }
      const key = `${at.file}:${at.hunk}:${at.to}`
      placed.set(key, [...(placed.get(key) ?? []), c])
    }
    const draftAt = s.draft ? locate(s.draft.anchor, u.files, this.samePath) : null
    this.renderOutside(u, s, outside, s.draft !== null && draftAt === null)
    this.filesEl.replaceChildren(
      ...(u.files.length === 0 ? [el('div', 'panel-empty', 'No changes in this view')] : u.files.map((f, i) => this.renderFile(u, s, f, i, placed, draftAt)))
    )
    this.renderFooter(u, s)
    if (caret) this.focusDraft(caret)
  }

  /** focus the comment box, with the caret where it was; a method of its own, so that TypeScript reads draftArea anew */
  private focusDraft(caret?: readonly [number, number]): void {
    const area = this.draftArea
    if (!area) return
    area.focus()
    if (caret) area.setSelectionRange(caret[0], caret[1])
  }

  private renderScope(u: ReviewUpdate): void {
    const parts: HTMLElement[] = []
    if (u.view.kind === 'request') {
      const chip = el('span', 'review-chip')
      const close = el('button', 'review-chip-close', '✕')
      close.title = 'Back to the scopes'
      close.addEventListener('click', () => this.cb.clearRequest(u.tabId))
      chip.append(el('span', 'review-chip-text', u.label), close)
      parts.push(chip)
    } else {
      const current = u.view.scope
      const seg = el('div', 'review-seg')
      for (const s of SCOPES) {
        const b = el('button', `review-seg-btn${current === s.scope ? ' active' : ''}`, s.label)
        b.dataset.scope = s.scope
        if (s.scope === 'uncommitted' && !u.uncommitted.available) {
          b.disabled = true
          b.title = u.uncommitted.reason
        }
        b.addEventListener('click', () => this.cb.setScope(u.tabId, s.scope))
        seg.append(b)
      }
      parts.push(seg)
    }
    const n = u.files.length
    const summary = el('span', 'review-summary')
    summary.append(`${n} file${n === 1 ? '' : 's'} · `, el('span', 'review-add', `+${u.additions}`), ' ', el('span', 'review-del', `−${u.deletions}`))
    this.scopeBar.replaceChildren(...parts, summary)
  }

  private renderOutside(u: ReviewUpdate, s: TabComments, outside: ReviewComment[], draftHere: boolean): void {
    const items: HTMLElement[] = []
    if (outside.length > 0 || draftHere) {
      items.push(el('div', 'review-outside-title', `Comments outside this view (${outside.length})`))
      for (const c of outside) if (s.draft?.editing !== c.id) items.push(this.renderComment(s, c))
      if (draftHere) items.push(this.renderDraft(u, s))
    }
    this.outsideEl.replaceChildren(...items)
    this.outsideEl.hidden = items.length === 0
  }

  private renderFile(u: ReviewUpdate, s: TabComments, f: ReviewFile, fi: number, placed: Map<string, ReviewComment[]>, draftAt: Located | null): HTMLElement {
    const box = el('div', `review-file${f.viewed ? ' viewed' : ''}`)
    box.dataset.path = f.relPath
    const folded = s.folds.get(f.path) ?? (f.viewed || f.additions + f.deletions > FOLD_LINES)
    const head = el('div', 'review-file-head')
    const viewed = el('input', 'review-viewed')
    viewed.type = 'checkbox'
    viewed.checked = f.viewed
    viewed.title = 'Viewed'
    viewed.addEventListener('click', (e) => e.stopPropagation())
    viewed.addEventListener('change', () => {
      s.folds.delete(f.path)
      this.cb.setViewed(u.tabId, f.path, f.hash, viewed.checked)
    })
    const slash = f.relPath.lastIndexOf('/')
    const name = el('span', 'review-name')
    name.append(el('span', 'review-dir', slash >= 0 ? f.relPath.slice(0, slash + 1) : ''), f.relPath.slice(slash + 1))
    name.title = f.path
    const counts = el('span', 'review-counts')
    counts.append(el('span', 'review-add', `+${f.additions}`), ' ', el('span', 'review-del', `−${f.deletions}`))
    const more = el('button', 'review-more', '⋯')
    more.title = 'More'
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      const r = more.getBoundingClientRect()
      showMenu({ x: r.left, y: r.bottom }, [
        { label: 'Open in editor', action: () => this.cb.openEditor(f.path, firstLine(f)) },
        { label: 'Copy path', action: () => this.cb.copyText(f.path) }
      ])
    })
    head.append(viewed, el('span', 'review-arrow', folded ? '▸' : '▾'), name, el('span', `review-status ${f.status}`, STATUS[f.status]), counts, more)
    head.addEventListener('click', () => {
      s.folds.set(f.path, !folded)
      this.render()
    })
    box.append(head)
    if (folded) return box
    if (f.note) {
      const row = el('div', 'review-note', NOTES[f.note])
      if (f.note === 'too-large' && f.canForce) {
        const link = el('button', 'review-force', 'show anyway')
        link.addEventListener('click', () => this.cb.showFile(u.tabId, f.path))
        row.append(' — ', link)
      }
      box.append(row)
      return box
    }
    f.hunks.forEach((h, hi) => box.append(this.renderHunk(u, s, f, fi, h, hi, placed, draftAt)))
    return box
  }

  private renderHunk(u: ReviewUpdate, s: TabComments, f: ReviewFile, fi: number, h: ReviewHunk, hi: number, placed: Map<string, ReviewComment[]>, draftAt: Located | null): HTMLElement {
    const box = el('div', 'review-hunk')
    box.append(el('div', 'review-hunk-head', h.header))
    h.lines.forEach((line: ReviewLine, li) => {
      const row = el('div', `review-line ${line.kind}`)
      row.dataset.file = String(fi)
      row.dataset.hunk = String(hi)
      row.dataset.line = String(li)
      const gutter = el('span', 'review-gutter')
      const no = line.newNo ?? line.oldNo
      gutter.append(el('span', 'review-no', no === null ? '' : String(no)))
      const plus = el('span', 'review-plus', '+')
      plus.title = 'Comment'
      plus.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.drag = { file: fi, hunk: hi, from: li, to: li }
        this.markDrag()
      })
      gutter.append(plus)
      row.addEventListener('mouseenter', () => {
        if (this.drag && this.drag.file === fi && this.drag.hunk === hi) {
          this.drag.to = li
          this.markDrag()
        }
      })
      row.append(gutter, el('span', 'review-code', line.text))
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const at = editorLine(h, li)
        showMenu({ x: e.clientX, y: e.clientY }, [
          { label: 'Comment', action: () => this.startDraft(u, f, h, li, li) },
          { label: `Open in editor at line ${at}`, action: () => this.cb.openEditor(f.path, at) },
          { label: 'Copy path:line', action: () => this.cb.copyText(`${f.relPath}:${no ?? at}`) }
        ])
      })
      box.append(row)
      for (const c of placed.get(`${fi}:${hi}:${li}`) ?? []) if (s.draft?.editing !== c.id) box.append(this.renderComment(s, c))
      if (s.draft && draftAt && draftAt.file === fi && draftAt.hunk === hi && draftAt.to === li) box.append(this.renderDraft(u, s))
    })
    return box
  }

  private markDrag(): void {
    const d = this.drag
    for (const row of this.filesEl.querySelectorAll<HTMLElement>('.review-line')) {
      const li = Number(row.dataset.line)
      const on = d !== null && Number(row.dataset.file) === d.file && Number(row.dataset.hunk) === d.hunk && li >= Math.min(d.from, d.to) && li <= Math.max(d.from, d.to)
      row.classList.toggle('selected', on)
    }
  }

  private endDrag(): void {
    const d = this.drag
    if (!d) return
    this.drag = null
    const u = this.update
    const f = u?.files[d.file]
    const h = f?.hunks[d.hunk]
    if (u && f && h) this.startDraft(u, f, h, Math.min(d.from, d.to), Math.max(d.from, d.to))
    else this.markDrag()
  }

  private startDraft(u: ReviewUpdate, f: ReviewFile, h: ReviewHunk, from: number, to: number): void {
    this.state(u.tabId).draft = { anchor: anchorOf(f, h.lines.slice(from, to + 1), viewKeyOf(u)), text: '', editing: null }
    this.render()
    this.focusDraft()
  }

  private renderDraft(u: ReviewUpdate, s: TabComments): HTMLElement {
    const d = s.draft!
    const box = el('div', 'review-comment-box')
    box.append(el('div', 'review-comment-meta', describeLines(d.anchor)))
    const area = el('textarea', 'review-comment-input')
    area.value = d.text
    area.placeholder = 'Comment for Claude'
    area.addEventListener('input', () => { d.text = area.value })
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault()
        this.saveDraft(u.tabId)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.cancelDraft(u.tabId)
      }
    })
    const cancel = el('button', 'review-btn', 'Cancel')
    cancel.addEventListener('click', () => this.cancelDraft(u.tabId))
    const save = el('button', 'review-btn primary', d.editing ? 'Save' : 'Add comment')
    save.addEventListener('click', () => this.saveDraft(u.tabId))
    const buttons = el('div', 'review-comment-btns')
    buttons.append(cancel, save)
    box.append(area, buttons)
    this.draftArea = area
    return box
  }

  private saveDraft(tabId: string): void {
    const s = this.state(tabId)
    const d = s.draft
    if (!d) return
    const text = d.text.trim()
    if (text === '') {
      this.cancelDraft(tabId)
      return
    }
    if (d.editing) {
      const c = s.comments.find((x) => x.id === d.editing)
      if (c) c.text = text
    } else {
      s.comments.push({ id: `c${nextId++}`, anchor: d.anchor, text, outdated: false })
    }
    s.draft = null
    this.render()
  }

  private cancelDraft(tabId: string): void {
    this.state(tabId).draft = null
    this.render()
  }

  private renderComment(s: TabComments, c: ReviewComment): HTMLElement {
    const box = el('div', `review-comment${c.outdated ? ' outdated' : ''}`)
    const meta = el('div', 'review-comment-meta', `${c.anchor.relPath} · ${describeLines(c.anchor)}`)
    if (c.outdated) meta.append(' · ', el('span', 'review-outdated', 'outdated'))
    const edit = el('button', 'review-link', 'Edit')
    edit.addEventListener('click', () => {
      s.draft = { anchor: c.anchor, text: c.text, editing: c.id }
      this.render()
      this.focusDraft()
    })
    const del = el('button', 'review-link', 'Delete')
    del.addEventListener('click', () => {
      s.comments = s.comments.filter((x) => x.id !== c.id)
      this.render()
    })
    const buttons = el('div', 'review-comment-btns')
    buttons.append(edit, del)
    box.append(meta, el('div', 'review-comment-text', c.text), buttons)
    return box
  }

  private renderFooter(u: ReviewUpdate, s: TabComments): void {
    const n = s.comments.length
    this.footer.hidden = false
    this.countEl.textContent = this.sendError ?? `${n} comment${n === 1 ? '' : 's'}`
    this.countEl.classList.toggle('error', this.sendError !== null)
    const blocked = u.send.ok ? null : u.send.reason
    this.sendBtn.disabled = n === 0 || blocked !== null || this.sending
    // a Send refused at the last moment keeps the comments, and the button says why
    this.sendBtn.title = blocked ?? this.sendError ?? ''
  }

  private async sendAll(): Promise<void> {
    const u = this.update
    if (!u || this.sending) return
    const s = this.state(u.tabId)
    if (s.comments.length === 0) return
    this.sending = true
    this.sendError = null
    this.renderFooter(u, s)
    const error = await this.cb.send(u.tabId, formatSendMessage(u.label, s.comments))
    this.sending = false
    this.sendError = error
    if (error === null) {
      s.comments = []
      s.draft = null
    }
    this.render()
  }
}
```

- [ ] **Step 6: Wire the panel, Send and the counter into main.ts**

In `src/renderer/main.ts`:

1. Imports and state:

```ts
import { NOT_RUNNING, type ReviewCounter, type ReviewUpdate } from '../shared/review'
import { ReviewPanel } from './review-panel'
```
```ts
let reviewPanel: ReviewPanel
const reviewUpdates = new Map<string, ReviewUpdate>()
/** tabs whose show_diff should open Changes when they come to the front */
const pendingReveal = new Set<string>()
/** what each tab was sent, in test runs: the e2e tests read what Send wrote */
const inputLog = new Map<string, string>()
```

2. `handleInput` records in test runs. Add as the first line inside the function, after the `if (!t) return` check:

```ts
  if (appInfo.test) inputLog.set(tabId, (inputLog.get(tabId) ?? '') + data)
```

3. The Send path and the counter:

```ts
/** the status bar counter for a tab, unless review.statusBar turned it off */
function counterOf(tabId: string | null): ReviewCounter | null {
  return tabId && settings.review.statusBar ? reviewUpdates.get(tabId)?.counter ?? null : null
}

/** Send: the same path as pasting text (bracketed when Claude Code asked for it), then Enter on its own */
async function sendToClaude(tabId: string, message: string): Promise<string | null> {
  const state = await ct.reviewCanSend(tabId)
  if (!state.ok) return state.reason
  const t = tabs.get(tabId)
  if (!t || t.info.exited) return NOT_RUNNING
  t.view.term.paste(message)
  await new Promise((r) => setTimeout(r, 50))
  handleInput(tabId, '\r')
  if (tabId === activeId) t.view.term.focus()
  return null
}
```

4. Every `statusBar.render(x)` call passes the counter: `statusBar.render(statusUpdates.get(id) ?? null, counterOf(id))`. That covers `activate` (step 7) and the `onStatus` handler (`statusBar.render(u, counterOf(u.tabId))`); `statusBar.render(null)` in `onTabClosed` stays. A tab with no status yet (or after its session ended) still gets its counter: `render` shows the `changes` segment alone.

5. Build the status bar with the click:

```ts
  statusBar = new StatusBar(document.getElementById('statusbar')!, () => sidePanel.open('changes'))
```

6. After the `imagePanel` construction from Task 11:

```ts
  reviewPanel = new ReviewPanel(
    sidePanel.bodies.changes,
    sidePanel,
    {
      setScope: (id, scope) => ct.setReviewScope(id, scope),
      clearRequest: (id) => ct.clearReviewRequest(id),
      refresh: (id) => ct.refreshReview(id),
      setViewed: (id, path, hash, viewed) => ct.setReviewViewed(id, path, hash, viewed),
      showFile: (id, path) => ct.showReviewFile(id, path),
      openEditor: (path, line) => ct.openInEditor(path, line),
      copyText: (text) => ct.writeClipboardText(text),
      send: (id, message) => sendToClaude(id, message)
    },
    ct.platform
  )
  sidePanel.onChange = () => {
    imagePanel.panelChanged()
    reviewPanel.panelChanged()
    refreshImageButton()
  }
  ct.onReview((u) => {
    reviewUpdates.set(u.tabId, u)
    if (u.reveal) pendingReveal.add(u.tabId)
    if (u.tabId !== activeId) return
    reviewPanel.show(u)
    sidePanel.setBadge('changes', u.unviewed)
    if (pendingReveal.delete(u.tabId)) sidePanel.open('changes')
    statusBar.render(statusUpdates.get(u.tabId) ?? null, counterOf(u.tabId))
  })
```

7. `activate(tabId)`. The whole function after this task (Task 11's focus check stays; Task 11's `sidePanel.setAvailable(…)` line becomes the five lines from `const claude`; the `statusBar.render` line passes the counter):

```ts
function activate(tabId: string): void {
  activeId = tabId
  const busy = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
  const focus = !busy
  for (const [id, t] of tabs) t.view.show(id === tabId, focus)
  const t = tabs.get(tabId)
  if (t) {
    t.bell = false
    t.attention = false
  }
  renderTabs()
  const claude = t?.info.kind === 'claude'
  reviewPanel.show(claude ? reviewUpdates.get(tabId) ?? null : null)
  sidePanel.setAvailable('changes', claude)
  sidePanel.setBadge('changes', claude ? reviewUpdates.get(tabId)?.unviewed ?? 0 : 0)
  if (pendingReveal.delete(tabId)) sidePanel.open('changes')
  imagePanel.show(imageUpdates.get(tabId) ?? { tabId, cards: [], unseen: 0, notice: null })
  statusBar.render(statusUpdates.get(tabId) ?? null, counterOf(tabId))
}
```

8. `onTabClosed`: also `reviewUpdates.delete(id)`, `reviewPanel.dropTab(id)`, `pendingReveal.delete(id)`, `inputLog.delete(id)`.

9. `applySettings`: at the end, `if (activeId) statusBar.render(statusUpdates.get(activeId) ?? null, counterOf(activeId))`.

10. The test hook gains one entry:

```ts
      ptyInput: (id) => inputLog.get(id ?? activeId ?? '') ?? '',
```

`src/renderer/env.d.ts`, in `CtTestHook`:

```ts
  /** everything written to a tab's terminal input (test runs) */
  ptyInput?(id?: string): string
```

- [ ] **Step 7: Styles**

Append to `src/renderer/styles.css`:

```css
.review-scope { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 8px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.review-seg { display: flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.review-seg-btn { background: none; border: 0; color: var(--muted); padding: 3px 9px; cursor: pointer; font: inherit; }
.review-seg-btn + .review-seg-btn { border-left: 1px solid var(--border); }
.review-seg-btn.active { background: var(--accent); color: #111; }
.review-seg-btn:disabled { opacity: 0.45; cursor: default; }
.review-chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; padding: 2px 4px 2px 8px; border: 1px dashed var(--border); border-radius: 4px; color: var(--fg); }
.review-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-chip-close { background: none; border: 0; color: var(--muted); cursor: pointer; }
.review-summary { margin-left: auto; white-space: nowrap; }
.review-add { color: #7ee2a8; }
.review-del { color: #ff9b94; }
.review-outside { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.review-outside[hidden] { display: none; }
.review-outside-title { margin-bottom: 4px; color: var(--muted); font-size: 12px; }
.review-files { flex: 1; overflow: auto; }
.review-file-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--chrome-2); border-bottom: 1px solid var(--border); cursor: pointer; user-select: none; font-size: 12px; }
.review-file.viewed .review-file-head { opacity: 0.6; }
.review-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-dir { color: var(--muted); }
.review-status { color: #e5c07b; font: 11px Consolas, monospace; }
.review-status.added { color: #7ee2a8; }
.review-status.deleted { color: #ff9b94; }
.review-counts { margin-left: auto; font: 11px Consolas, monospace; white-space: nowrap; }
.review-more { background: none; border: 0; color: var(--muted); cursor: pointer; }
.review-note { padding: 6px 12px; color: var(--muted); font-size: 12px; }
.review-force { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; }
.review-hunk { width: max-content; min-width: 100%; }
.review-hunk-head { padding: 2px 8px; color: var(--muted); background: #ffffff08; font: 11px Consolas, monospace; }
.review-line { display: flex; font: 12px/1.5 Consolas, "Cascadia Mono", monospace; white-space: pre; }
.review-line.add { background: rgba(46, 160, 67, 0.15); }
.review-line.del { background: rgba(248, 81, 73, 0.15); }
.review-line.selected { box-shadow: inset 3px 0 0 var(--accent); }
.review-gutter { position: relative; flex: 0 0 auto; width: 46px; padding-right: 6px; text-align: right; color: var(--muted); user-select: none; }
.review-plus { position: absolute; left: 2px; top: 2px; width: 15px; height: 15px; border-radius: 3px; background: var(--accent); color: #111; font: bold 12px/15px sans-serif; text-align: center; cursor: pointer; visibility: hidden; }
.review-line:hover .review-plus { visibility: visible; }
.review-code { padding: 0 8px 0 6px; }
.review-comment, .review-comment-box { margin: 4px 8px 6px 52px; padding: 6px 8px; max-width: 560px; border: 1px solid var(--accent); border-radius: 5px; background: #261b17; font: 12px "Segoe UI", system-ui, sans-serif; white-space: normal; }
.review-outside .review-comment, .review-outside .review-comment-box { margin-left: 0; }
.review-comment.outdated { border-style: dashed; }
.review-comment-meta { margin-bottom: 3px; color: var(--muted); font-size: 11px; }
.review-outdated { color: #e5c07b; }
.review-comment-text { white-space: pre-wrap; }
.review-comment-input { width: 100%; min-height: 54px; box-sizing: border-box; resize: vertical; padding: 4px 6px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; font: inherit; }
.review-comment-input:focus { outline: none; border-color: var(--accent); }
.review-comment-btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
.review-btn { background: var(--chrome-2); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 2px 10px; cursor: pointer; font: inherit; }
.review-btn.primary { background: var(--accent); color: #111; border-color: var(--accent); }
.review-link { background: none; border: 0; color: var(--muted); cursor: pointer; font: inherit; padding: 0 2px; }
.review-link:hover { color: var(--fg); }
.review-footer { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-top: 1px solid var(--border); }
.review-footer[hidden] { display: none; }
.review-count { flex: 1; color: var(--muted); font-size: 12px; }
.review-count.error { color: #e06c75; }
.review-send { background: var(--accent); color: #111; border: 0; border-radius: 4px; padding: 4px 12px; cursor: pointer; font: inherit; }
.review-send:disabled { opacity: 0.45; cursor: default; }
#statusbar .status-changes { cursor: pointer; }
#statusbar .status-changes:hover { color: var(--fg); }
```

- [ ] **Step 8: Run the checks**

Run: `npx vitest run tests/unit/review-comments.test.ts tests/unit/status-bar.test.ts && npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 9: Leave uncommitted.**

---

### Task 13: End-to-end tests

**Files:**
- Modify: `tests/e2e/helpers.ts`
- Create: `tests/e2e/review.spec.ts`

**Interfaces:**
- Produces:
  - `gitRepo(): string` — a repository with one commit: `a.ts` = `one\ntwo\nthree\n`;
  - `launchClaudeTab(settings?, work?)` — `work` is an optional folder to open.

- [ ] **Step 1: Extend the helpers**

In `tests/e2e/helpers.ts`:

```ts
/** a git repository with one commit: a.ts = "one\ntwo\nthree\n" */
export function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-repo-'))
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-qm', 'one')
  return dir
}
```

and let `launchClaudeTab` take the folder:

```ts
export async function launchClaudeTab(settings: object = FAKE_CLAUDE_SETTINGS, work: string = mkdtempSync(join(tmpdir(), 'ct-work-'))): Promise<Launched & { work: string; tabId: string }> {
  const launched = await launchApp({ settings, args: ['--claude', work] })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, work, tabId }
}
```

- [ ] **Step 2: Write the e2e tests**

`tests/e2e/review.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { assistantLine, editResultLine } from '../fixtures/transcript'
import { FAKE_CLAUDE_SETTINGS, gitRepo, launchApp, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

/** a Claude tab in a fresh repository whose session ClaudeTerm knows, with an empty transcript; `edit` changes files first */
async function reviewTab(edit?: (repo: string) => void) {
  const repo = gitRepo()
  edit?.(repo)
  const launched = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  expect(await sendPipeMessage(launched.pipeName, { v: 1, type: 'session', tabId: launched.tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  return { ...launched, repo, transcriptPath, a: join(repo, 'a.ts') }
}
const upper = (repo: string): void => writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\n')
/** a transcript line written now: only an assistant entry newer than a dialog closes it */
const now = (line: string): string => JSON.stringify({ ...(JSON.parse(line) as object), timestamp: new Date().toISOString() })
const panel = (page: Page) => page.locator('#image-panel')
const changesTab = (page: Page) => page.locator('.panel-tab[data-tab="changes"]')
const file = (page: Page, rel: string) => page.locator(`.review-file[data-path="${rel}"]`)
const added = (page: Page, rel: string) => file(page, rel).locator('.review-line.add .review-code')

async function addComment(page: Page, rel: string, text: string): Promise<void> {
  const row = file(page, rel).locator('.review-line.add').first()
  await row.hover()
  await row.locator('.review-plus').click()
  await page.locator('.review-comment-input').fill(text)
  await page.locator('.review-btn.primary').click()
}

test('Ctrl+Shift+D opens Changes with the uncommitted diff; scopes switch', async () => {
  const { app, page } = await reviewTab(upper)
  await page.keyboard.press('Control+Shift+KeyD')
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect(changesTab(page)).toHaveClass(/active/)
  await expect(file(page, 'a.ts').locator('.review-status')).toHaveText('M')
  await expect(file(page, 'a.ts').locator('.review-line.del .review-code')).toHaveText('two')
  await expect(added(page, 'a.ts')).toHaveText('TWO')
  await expect(page.locator('.review-summary')).toHaveText('1 file · +1 −1')
  await page.locator('.review-seg-btn[data-scope="session"]').click()
  await expect(page.locator('.review-files .panel-empty')).toHaveText('No changes in this view')
  await page.locator('.panel-hide').click()
  await expect(panel(page)).toHaveClass(/collapsed/)
  await app.close()
})

// also the spec's edit_before round trip: main replies only after it has read the file, so the baseline is the old text
test('Last turn and Session compare with the files before Claude changed them', async () => {
  const { app, page, tabId, pipeName, transcriptPath, repo, a } = await reviewTab()
  const turn = () => sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd: repo })
  const before = (toolUseId: string) => sendPipeMessage(pipeName, { v: 1, type: 'edit_before', tabId, sessionId: SID, toolUseId, path: a })
  expect(await turn()).toEqual({ ok: true })
  expect(await before('toolu_1')).toEqual({ ok: true })
  writeFileSync(a, 'one\ntwo\nthree\nfour\n')
  appendFileSync(transcriptPath, editResultLine({ toolUseId: 'toolu_1', filePath: a }) + '\n')
  await page.keyboard.press('Control+Shift+KeyD')
  await page.locator('.review-seg-btn[data-scope="last_turn"]').click()
  // Uncommitted would show 'four' too: the active button proves the view is Last turn
  await expect(page.locator('.review-seg-btn.active')).toHaveText('Last turn')
  await expect(added(page, 'a.ts')).toHaveText('four')
  expect(await turn()).toEqual({ ok: true })
  expect(await before('toolu_2')).toEqual({ ok: true })
  writeFileSync(a, 'zero\none\ntwo\nthree\nfour\n')
  appendFileSync(transcriptPath, editResultLine({ toolUseId: 'toolu_2', filePath: a }) + '\n')
  await expect(added(page, 'a.ts')).toHaveText('zero', { timeout: 10_000 })
  await page.locator('.review-seg-btn[data-scope="session"]').click()
  await expect(added(page, 'a.ts')).toHaveText(['zero', 'four'])
  await app.close()
})

test('Viewed folds a file until it changes again', async () => {
  const { app, page, a } = await reviewTab(upper)
  await page.keyboard.press('Control+Shift+KeyD')
  await expect(changesTab(page).locator('.badge')).toHaveText('1')
  await file(page, 'a.ts').locator('.review-viewed').check()
  await expect(file(page, 'a.ts')).toHaveClass(/viewed/)
  await expect(changesTab(page).locator('.badge')).toBeHidden()
  await expect(file(page, 'a.ts').locator('.review-line')).toHaveCount(0)
  writeFileSync(a, 'one\nTWO\nTHREE\n')
  await page.locator('.review-refresh').click()
  await expect(file(page, 'a.ts')).not.toHaveClass(/viewed/)
  await expect(changesTab(page).locator('.badge')).toHaveText('1')
  await app.close()
})

test('a comment is sent to Claude as one message followed by Enter', async () => {
  const { app, page, tabId } = await reviewTab(upper)
  await page.keyboard.press('Control+Shift+KeyD')
  await addComment(page, 'a.ts', 'Why upper case?')
  await expect(page.locator('.review-count')).toHaveText('1 comment')
  await page.locator('.review-send').click()
  await expect(page.locator('.review-count')).toHaveText('0 comments')
  // xterm's paste turns \n into \r, and wraps the text in bracketed-paste markers when the shell asked for them
  const sent = (await page.evaluate((id) => window.__ct!.ptyInput!(id), tabId)).replace(/\x1b\[20[01]~/g, '')
  expect(sent).toContain('Review comments on the changes (uncommitted):\r\r1. a.ts:2\r   > TWO\r   Why upper case?\r')
  await app.close()
})

test('Send waits while Claude shows a permission prompt, until the agent that asked goes on', async () => {
  const { app, page, tabId, pipeName, transcriptPath, a } = await reviewTab(upper)
  await page.keyboard.press('Control+Shift+KeyD')
  await addComment(page, 'a.ts', 'Hm')
  const sendBtn = page.locator('.review-send')
  await expect(sendBtn).toBeEnabled()
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(sendBtn).toBeDisabled()
  await expect(sendBtn).toHaveAttribute('title', "Answer Claude's prompt in the terminal first")
  // a subagent writes on: that does not answer the main conversation's prompt. Its edit, read in the same
  // poll right after its assistant entry, shows when the feed has read both
  writeFileSync(a, 'one\nTWO\nthree\nfive\n')
  const subagents = join(dirname(transcriptPath), SID, 'subagents')
  mkdirSync(subagents, { recursive: true })
  writeFileSync(join(subagents, 'agent-a9.jsonl'), [now(assistantLine('claude-opus-5-5')), editResultLine({ toolUseId: 'toolu_9', filePath: a })].join('\n') + '\n')
  await expect(added(page, 'a.ts')).toHaveText(['TWO', 'five'], { timeout: 10_000 })
  await expect(sendBtn).toBeDisabled()
  appendFileSync(transcriptPath, now(assistantLine('claude-opus-5-5')) + '\n')
  await expect(sendBtn).toBeEnabled({ timeout: 10_000 })
  await app.close()
})

test('a draft survives an update of the panel', async () => {
  const { app, page, tabId, pipeName, a } = await reviewTab(upper)
  await page.keyboard.press('Control+Shift+KeyD')
  const row = file(page, 'a.ts').locator('.review-line.add').first()
  await row.hover()
  await row.locator('.review-plus').click()
  await page.keyboard.type('abc')
  writeFileSync(a, 'one\nTWO\nthree\nfour\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  await expect(added(page, 'a.ts')).toHaveText(['TWO', 'four'])
  await page.keyboard.type('def')
  await expect(page.locator('.review-comment-input')).toHaveValue('abcdef')
  await app.close()
})

test('show_diff opens a request with a chip; the chip goes back to the scopes', async () => {
  const { app, page, tabId, pipeName, repo } = await reviewTab((r) => {
    upper(r)
    writeFileSync(join(r, 'b.ts'), 'b\n')
  })
  const msg = { v: 1 as const, type: 'show_diff' as const, tabId, cwd: repo, scope: null, from: 'HEAD', to: null, paths: [join(repo, 'a.ts')], title: null }
  expect(await sendPipeMessage(pipeName, msg)).toEqual({ ok: true, info: 'Opened 1 file (+1 −1) in the Changes panel.' })
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect(page.locator('.review-chip-text')).toHaveText('HEAD → working tree · a.ts')
  await expect(page.locator('.review-file')).toHaveCount(1)
  await page.locator('.review-chip-close').click()
  await expect(page.locator('.review-seg-btn.active')).toHaveText('Uncommitted')
  await expect(page.locator('.review-file')).toHaveCount(2)
  expect(await sendPipeMessage(pipeName, { ...msg, from: 'mastr' })).toEqual({ ok: false, error: 'unknown revision: mastr' })
  await app.close()
})

// no status message: the counter is not part of Claude's status line and shows before the first one
test('the status bar counter shows the uncommitted changes without a status line, and opens the panel', async () => {
  const { app, page } = await reviewTab(upper)
  const counter = page.locator('#statusbar .status-changes')
  await expect(counter).toHaveText('± 1 file +1 −1', { timeout: 10_000 })
  await counter.click()
  await expect(changesTab(page)).toHaveClass(/active/)
  await app.close()
})

test('a shell tab has no Changes tab', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await page.keyboard.press('Control+Shift+KeyI')
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect(changesTab(page)).toBeHidden()
  await page.keyboard.press('Control+Shift+KeyD')
  await expect(page.locator('.panel-tab[data-tab="images"]')).toHaveClass(/active/)
  await app.close()
})
```

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e`
Expected: the new tests and the existing ones pass. If `Ctrl+Shift+D` does nothing in a test, focus is on no element that forwards keys: click `.terminal-host:visible .xterm` before pressing, as `readme.shots.ts` does.

- [ ] **Step 4: Leave uncommitted.**

---

### Task 14: README and the screenshot

**Files:**
- Modify: `README.md`, `tests/screenshots/readme.shots.ts`
- Create (generated): `docs/images/review-panel.png`

- [ ] **Step 1: Add the screenshot test**

Append to `tests/screenshots/readme.shots.ts` (add `execFileSync` from `node:child_process` to the imports). The code is invented sample code for the demo project, never the user's files:

```ts
const REVENUE_BEFORE = `import { monthlyRevenue } from '../data/sales'

export function revenueByMonth(year: number): number[] {
  const rows = monthlyRevenue(year)
  return rows.map((r) => r.total)
}

export function growth(current: number[], previous: number[]): number[] {
  return current.map((v, i) => v / previous[i] - 1)
}
`
const REVENUE_AFTER = `import { monthlyRevenue } from '../data/sales'

export function revenueByMonth(year: number): number[] {
  const rows = monthlyRevenue(year)
  return rows.map((r) => Math.round(r.total / 1000))
}

export function growth(current: number[], previous: number[]): number[] {
  return current.map((v, i) => (previous[i] ? v / previous[i] - 1 : 0))
}
`
const YOY = `import { growth, revenueByMonth } from './revenue'

export function yearOverYear(year: number): number[] {
  return growth(revenueByMonth(year), revenueByMonth(year - 1))
}
`

test('review panel screenshot', async () => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'ct-shots-review-'))
  const project = join(root, 'acme-dashboard')
  mkdirSync(join(project, 'src', 'charts'), { recursive: true })
  copyFileSync(DEMO_CLAUDE, join(project, 'demo-claude.mjs'))
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: project, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 'demo@example.com')
  git('config', 'user.name', 'Demo')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(project, '.gitignore'), 'demo-claude.mjs\n')
  writeFileSync(join(project, 'src', 'charts', 'revenue.ts'), REVENUE_BEFORE)
  git('add', '-A')
  git('commit', '-qm', 'charts')
  writeFileSync(join(project, 'src', 'charts', 'revenue.ts'), REVENUE_AFTER)
  writeFileSync(join(project, 'src', 'charts', 'yoy.ts'), YOY)

  // like the hero shot: a Claude config and a temp folder of its own, so nothing of the real machine shows
  const temp = join(root, 'temp')
  mkdirSync(temp)
  const settings = { claude: { command: 'node demo-claude.mjs', shellProfile: 'Windows PowerShell' }, defaultProfile: 'Windows PowerShell' }
  const { app, page, pipeName } = await launchApp({
    settings, args: ['--claude', project], env: { CLAUDE_CONFIG_DIR: join(root, 'claude-config'), TEMP: temp, TMP: temp }
  })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })
  await expect.poll(() => bufferText(page, tabId), { timeout: 20_000 }).toContain('North America leads Q3')

  const projects = join(root, 'claude-projects', 'D--work-acme-dashboard')
  mkdirSync(projects, { recursive: true })
  const transcriptPath = join(projects, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  expect(await sendPipeMessage(pipeName, {
    v: 1, type: 'status', tabId, sessionId: SID, model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'high',
    context: { usedTokens: 54_210, size: 200_000, usedPct: 27.1 }, fiveHour: { usedPct: 18.2, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 }, sevenDay: null
  })).toEqual({ ok: true })

  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyD')
  const revenue = page.locator('.review-file[data-path="src/charts/revenue.ts"]')
  await expect(revenue.locator('.review-line.add')).toHaveCount(2)
  const row = revenue.locator('.review-line.add').first()
  await row.hover()
  await row.locator('.review-plus').click()
  await page.locator('.review-comment-input').fill('Keep the raw totals here and round only in the chart labels — the CSV export reads this too.')
  await page.locator('.review-btn.primary').click()
  await expect(page.locator('.review-count')).toHaveText('1 comment')
  await page.mouse.move(300, 300)
  await page.screenshot({ path: join(OUT, 'review-panel.png') })
  await app.close()
})
```

- [ ] **Step 2: Generate it and look at it**

Run: `npm run screenshots`
Expected: `docs/images/review-panel.png` exists. Open it (Read the image). Check five things:
- the terminal on the left;
- the Changes panel on the right with `Uncommitted`;
- two files with their hunks;
- the comment under the `Math.round` line;
- the counter in the status bar.

The other README screenshots are regenerated too. Leave them only if they changed visibly because of this feature (the panel header now has tabs); otherwise restore them with `git checkout -- docs/images/hero.png docs/images/lightbox.png docs/images/status-bar.png docs/images/new-tab-menu.png docs/images/recent-sessions.png docs/images/settings.png`.

- [ ] **Step 3: Update the README**

In `README.md`:

1. After the "Know when Claude is waiting for you" section, add:

```markdown
### 🔍 Review Claude's changes next to the conversation

Press `Ctrl+Shift+D` — or click the changes counter in the status bar — to open **Changes** beside a Claude tab:

- **Uncommitted** — everything not committed yet, untracked files included. **Last turn** — what Claude changed in its latest turn with edits. **Session** — everything it changed in this conversation. Last turn and Session work without git too: ClaudeTerm keeps each file as it was right before Claude's first change.
- **Comment on lines** — hover a line and click **+**, or drag along the margin for several lines. **Send to Claude** writes all your comments as one message — file, line and the quoted code — and sends it. The diff updates while Claude works on them.
- **Viewed** folds the files you are done with; a file Claude changes again unfolds.
- **Ask in words** — "show me the diff of the last three commits, only src/main": Claude opens it in the panel with the bundled `show_diff` tool.
- Right-click a line to open the file at that line in your editor (VS Code by default, or your own command in `review.editor`).

<p align="center"><img src="docs/images/review-panel.png" width="820" alt="The Changes panel: the uncommitted diff of two files beside the conversation, with a comment for Claude under a changed line"></p>
```

2. In the shortcut table, after the image panel row: `| Show / hide the Changes panel | \`Ctrl+Shift+D\` |`.

3. In the settings example, after `"notifications": { … },`:

```jsonc
  "review": {                      // the Changes panel
    "editor": null,                // e.g. "code --goto {file}:{line}" or "rider64 --line {line} {file}"; null = VS Code if installed, else the default app
    "statusBar": true,             // the changes counter in the status bar
    "width": 640                   // the panel's width when it opens, in px
  },
```

4. In "Good to know":
   - in the hook list, `PreToolUse` (only for `AskUserQuestion`) becomes `UserPromptSubmit`, `PreToolUse` (for `AskUserQuestion` and the edit tools `Edit`, `MultiEdit`, `Write`, `NotebookEdit`);
   - add "the Changes panel" to what the hooks are for;
   - add the sentence: "Before Claude edits a file, ClaudeTerm keeps a copy of it in `%APPDATA%\ClaudeTerm\review` (`~/.config/ClaudeTerm/review` on Linux), so Last turn and Session know the file before the edit; copies of a conversation untouched for a week are deleted."

5. In **Install**, the MCP sentence: `(the \`show_image\` tool)` → `(the \`show_image\` and \`show_diff\` tools)`.

6. In **Settings**, the paragraph under the settings screenshot (`Everything is stored in …`): `a custom theme and the image panel size are set only there` → `a custom theme and the image and Changes panel widths are set only there` (`review.width` is settings.json-only, like the settings window's footer from Task 9).

Do not touch `CHANGELOG.md`: its release section is written when the user asks for the release.

- [ ] **Step 4: Final checks**

Run: `npm run typecheck && npm test && npm run test:e2e`
Expected: all pass.

- [ ] **Step 5: Leave uncommitted** — report the complete list of changed and new files; do not commit, do not bump the version, do not release.
