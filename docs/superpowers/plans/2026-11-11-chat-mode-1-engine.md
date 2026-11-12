# Chat mode, plan 1 of 4: the engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Order of the chat mode plans** (each ends in working, tested software; run them in this order, in this worktree):
1. `2026-11-11-chat-mode-1-engine.md` — the SDK, the stand-in, the chat process per tab, the model in main, the view switch, a plain chat view.
2. `2026-11-11-chat-mode-2-conversation.md` — the conversation as drawn: Markdown, steps, subagents, images, notices, history paging, Find, the DOM window.
3. `2026-11-11-chat-mode-3-composer.md` — the composer, the cards, the slash menu, opening in the terminal, the status bar and "give this to Claude" in chat view.
4. `2026-11-11-chat-mode-4-devices.md` — other devices' chat tabs, the perf harness, README and screenshots, integration with the Settings redesign.

**Goal:** A Claude tab can run its conversation through the Agent SDK instead of a PTY, with one model of the conversation in main, a Chat | Terminal switch that never runs two processes on one session, and a plain chat view that sends, streams, interrupts and answers permissions.

**Architecture:** `TabManager` starts either a PTY (terminal view) or a chat process (chat view) for a Claude tab, through a new `startChat` dependency that `ChatHub` (`src/main/chat/chat-hub.ts`) provides. `ChatHub` runs the SDK (`sdk-engine.ts`, loaded with `await import()` only when the first chat tab starts) against the user's own Claude command (`claude-spawn.ts`), folds every SDK message into a pure `ChatModel` (`chat-model.ts`), and sends the window a snapshot plus per-frame patches for the tab in front only. Tests drive a stand-in Claude Code (`tests/fixtures/fake-claude/`) that replays recorded protocol fixtures.

**Tech Stack:** Electron 44, TypeScript (strict), `@anthropic-ai/claude-agent-sdk` 0.3.322 (exact), Vitest, Playwright, Node 22 type stripping for the stand-in.

**Spec:** `docs/superpowers/specs/2026-11-11-chat-mode-design.md` (approved by the user 2026-11-11). Visual reference: the boards Main, Working, Approve, Slash, Tabs of https://claude.ai/artifact/XV8YQrc8PYax6fYCxfDkj1 (copies in the scratchpad `settings-canvas/project/*.dc.html`).

## Global Constraints

- Work in `D:\Workspace\ClaudeTerm\.claude\worktrees\feat-redesign-look`, branch `feat/chat-mode`. Never `cd` to the main checkout `D:\Workspace\ClaudeTerm`; never touch another worktree under `.claude/worktrees/`.
- **Never commit, never stash, never push, never create branches.** Leave every change uncommitted (the user's global rule; the controller snapshots the tree).
- **The Settings plan (`docs/superpowers/plans/2026-11-11-settings-window.md`) runs in this same worktree at the same time.** Edit only the files your task lists. A typecheck error, a failing build or a failing test in a file your task does not list is the other work in progress: never edit it; rerun after a few minutes, and if it still blocks, report it with the error.
- **Files the Settings plan owns — chat tasks never edit them:** `src/renderer/settings-page.ts`, `src/renderer/settings-form.ts`, `src/renderer/settings.css`, `src/renderer/settings.html`, `src/renderer/settings-controls.ts`, `src/renderer/settings-search.ts`, `src/renderer/dom.ts`, `src/main/settings-window.ts`, `tests/e2e/settings.spec.ts`. Both plans may add to `src/renderer/icons.ts` and `tests/e2e/helpers.ts`: add only, never reorder or rewrite existing entries (Task 2's one property on `FAKE_CLAUDE_SETTINGS.claude` is the only change to an existing entry). The Settings controls for chat are added at integration (plan 4, last section).
- **Files both plans edit — `tests/e2e/helpers.ts`, `tests/e2e/accounts.spec.ts`, `tests/e2e/remote-tabs.spec.ts`:** re-read the file right before each edit, change only the lines the task names, with an Edit whose `old_string` is unique; never rewrite or reformat the file. In `helpers.ts` add only (Task 2's one property excepted).
- **Build and e2e only through the lock:** `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/<file> --reporter=line --workers=2"`. A task's unit and integration tests: `npx vitest run <test files>`. `npm install` runs only in Task 0 (the controller), never inside a task that edits code.
- **No test starts the real `claude`, calls the Anthropic API, or reads or writes the real `~/.claude`, `~/.claude.json` or `%APPDATA%\ClaudeTerm`.** Chat tests run the stand-in of Task 6 with `CLAUDE_CONFIG_DIR` set to a temp folder. Only Task 0 (controller-only) talks to the real Claude Code.
- `@anthropic-ai/claude-agent-sdk` is pinned to exactly `0.3.322`. It is loaded only by `await import('@anthropic-ai/claude-agent-sdk')` inside `src/main/chat/sdk-engine.ts`; every other file uses `import type` only. The renderer, preload and hook never import it. Every Claude Code process is started by our `spawnClaudeCodeProcess` with the user's `claude.command`; the SDK's own platform binaries are never run, installed into the app or shipped.
- Everything from the Claude Code process (stdout lines, SDK messages, control requests), from transcripts and from `.claude.json` is untrusted: check every field's type, cap string sizes (text item 1 MiB, tool output 64 KiB, subject 500 chars, a card's strings 64 KiB), drop unknown kinds without throwing.
- Main never blocks: the SDK, history and file reads are async; nothing loops over a whole conversation per patch. The renderer reaches the system only through `window.ct`; main checks every IPC argument (`src/main/ipc-guards.ts` style) and every renderer-sent `ChatAnswer` / `ChatSend` (`src/main/chat/chat-guards.ts`).
- Paths are compared with `pathKey` (`src/main/path-key.ts`), never as raw strings.
- **The terminal view works exactly as today.** Every existing unit, integration and e2e test keeps passing. Existing e2e tests keep Claude tabs in the terminal view through `view: 'terminal'` in `FAKE_CLAUDE_SETTINGS.claude` (Task 2).
- Comments, logs and UI strings in English. Match the surrounding code's naming and comment density. Keep each file's line endings. No UI framework in the renderer.
- Palette (part 1): ground `#0A0A0C`, sheet `#111114`, raised `#16161A` / `#1E1E23`, user bubble `#1C1C22`, hairlines `#1C1C21` / `#2A2A31`, text `#EDEDF0` / `#B5B5BE` / `#8C8C96`, accent `#D97757`, green `#63C08F`, amber `#E5B567`, red `#F2867E`, blue `#7FA7F5`. Use the CSS variables of `src/renderer/colors.css`. UI text Inter, code the monospace `font` setting. Motion animates only `transform` and `opacity`; `@media (prefers-reduced-motion: reduce)` turns it off.
- Chat styles live in `src/renderer/chat/chat.css`, imported by `src/renderer/chat/chat-view.ts`. `styles.css` gets only what the sheet itself needs (the switch in `.sh-modes`).
- Some e2e specs flake under load (`review.spec`, a fold test in `tab-panel.spec`): rerun a failing test alone (through the lock) before blaming the change. Close every app a test starts; temp files only under `tmpdir()`.
- Done for a task = `npm run typecheck`, the task's `npx vitest run …` files, and its e2e specs through the lock, green; `npm test` green where the task says so.

## Review Focus

1. **Claude Code dies at once** (bad login, a crash, a wrong flag): the tab shows "Claude Code stopped" with **Restart**, never a restart loop or a stuck "Starting…". Test: Task 13, stand-in `{ "crash": 1 }` before `init`.
2. **Noise on Claude's stdout** (a login shell's banner, an unknown message type, a half line): ignored; the conversation still works. Test: Task 8, stand-in `noise` lines before `init`.
3. **A switch asked for while a card waits or a turn runs**: refused in main too, not only by the disabled button. Test: Task 10 `setView` refusal tests and Task 11 `'a waiting card keeps the tab working'`.
4. **Closing a chat tab mid-turn**: the Claude process ends; nothing keeps running. Test: Task 13, `processAlive(marker)` false after close.
5. **A new session id from SessionStart** (`/clear`, a compaction that starts a new session): the chat follows it with a divider and the tab's `claudeSessionId` changes. Test: Task 11 unit test with `sessionChanged(tab, id, 'clear')`.

---

### Task 0 (controller-only — the main session runs it, not a Haiku implementer): install the SDK, record the protocol fixtures

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `scripts/record-chat-fixtures.mjs`, `tests/fixtures/chat/*.jsonl`, `tests/fixtures/chat/spawn-args.json`, `tests/fixtures/chat/history.json`, `tests/fixtures/chat/README.md`

The user agreed (2026-11-11) to a few short Haiku turns on their account. Nothing personal may reach the fixtures.

- [ ] **Step 1: Install the SDK, pinned.** `npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.322`. Check: `package.json` has `"@anthropic-ai/claude-agent-sdk": "0.3.322"`; `node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(typeof m.query, typeof m.getSessionMessages))"` prints `function function`.
- [ ] **Step 2: Write `scripts/record-chat-fixtures.mjs`** (committed later with the fixtures; English comments; no personal data in it). It:
  - makes a throwaway folder `mkdtemp(join(tmpdir(), 'ct-chat-fixture-'))` holding `notes.txt` = `first line of the fixture\nsecond line\n`, and a second temp folder with `settings.json` whose `statusLine` and hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse` matcher `AskUserQuestion`, `PermissionRequest`, `Stop`) each run `"<process.execPath>" -e "<append {hook, stdin} as a JSON line to hooks.log>"`;
  - finds the user's `claude` (`where.exe claude` / `command -v claude` in the login shell) and runs each scenario as its own `query({ prompt: <async iterable>, options })` with `cwd: work`, `model: 'haiku'`, `settingSources: []` (the user's own settings, CLAUDE.md, plugins and MCP servers stay out of the recording), `systemPrompt: { type: 'preset', preset: 'claude_code' }`, `includePartialMessages: true`, `perTaskStopAffordance: true`, `extraArgs: { settings: <settings.json> }`, `canUseTool` as the scenario says, and `spawnClaudeCodeProcess` that starts the user's claude (a `.cmd` shim through `cmd.exe /d /s /c`) with `options.args`, records `options.args` once, and tees every stdin line written and stdout line read to `<temp>/<scenario>.raw.jsonl` as `{ "dir": "in" | "out", "line": <parsed JSON or the raw string> }`;
  - scenarios (prompts exactly):
    - `answer`: "Reply with exactly this sentence and nothing else: The fixture says hello."
    - `read`: "Read notes.txt in the current folder and reply with its first line only."
    - `permission-allow`: "Create a file named out.txt that contains the single word fixture." — `canUseTool` → `{ behavior: 'allow', updatedInput: input }`; also write the `options` keys and `suggestions` it got to the raw log.
    - `permission-deny`: "Run the shell command `echo fixture` with the Bash tool." — `canUseTool` → `{ behavior: 'deny', message: 'The user said no.' }`.
    - `question`: "Use the AskUserQuestion tool to ask me one question: which format I want, with the options PDF report and HTML page. Then reply with only my answer." — `canUseTool` → `{ behavior: 'allow', updatedInput: { questions: input.questions, answers: { [input.questions[0].question]: 'PDF report' } } }`.
    - `plan`: `permissionMode: 'plan'`; "Make a two-step plan to add a line to notes.txt, then call ExitPlanMode with it. Do not edit anything." — `ExitPlanMode` → `{ behavior: 'deny', message: 'Keep planning.' }`.
    - `slash`: "/context", then after its result "/config".
    - `compact`: "Say one.", "Say two.", then "/compact".
    - `interrupt`: "Count from 1 to 200, one number per line." and `query.interrupt()` after the first text delta.
    - `control`: after `init`, `supportedCommands()`, `supportedModels()`, `getContextUsage()`, `setPermissionMode('acceptEdits')`, `setModel('haiku')`.
    - `resume`: `resume: <session id of answer>`, "Say again."; then `getSessionMessages(<that id>, { dir: work, includeSystemMessages: true })` written to `<temp>/history.raw.json`.
- [ ] **Step 3: Run it once:** `node scripts/record-chat-fixtures.mjs`. Expected: one raw file per scenario, `hooks.log`, the spawn args.
- [ ] **Step 4: Scrub into `tests/fixtures/chat/<scenario>.jsonl`** (same `{dir, line}` lines), `spawn-args.json` and `history.json`:
  - session ids → `00000000-0000-4000-8000-00000000000N` (one per real id, the same everywhere); every `uuid` → `11111111-1111-4111-8111-` + a 12-digit counter; `msg_…`, `toolu_…`, `req_…`, `request_id` values → `msg_fixture_N`, `toolu_fixture_N`, `req_fixture_N`;
  - the work folder (every spelling: `\`, `/`, JSON-escaped, the `~/.claude/projects` munged form) → `{{CWD}}`; the home folder → `{{HOME}}`; the settings file → `{{SETTINGS}}`;
  - account and organization data (email, names, uuids, `apiKeySource` detail, subscription) → `user@example.com`, `Example Org`, zero uuids, `pro`;
  - every assistant text, thinking text and summary → invented English of about the same length; `mcp_servers`, `plugins`, `skills`, `agents`, `memory_paths` → empty lists or invented names; `slash_commands` → the built-ins plus `acme-deploy`; limits → round invented numbers;
  - then search the fixtures for the user's name, login, email, home path, machine name and organization: no hit.
- [ ] **Step 5: Write `tests/fixtures/chat/README.md`:** the Claude Code version recorded with (`claude --version`), the SDK version, one line per fixture, the placeholders, and these findings that later tasks rely on:
  - (a) the arguments the SDK passes to `spawnClaudeCodeProcess` (also `spawn-args.json`);
  - (b) whether the `statusLine` command ran in this mode;
  - (c) which hooks fired, with `SessionStart`'s `source`;
  - (d) the fields of a `can_use_tool` request (title, description, displayName, decisionReason, permission_suggestions, blocked_path, tool_use_id, defaultToNo);
  - (e) how a message sent during a turn is acknowledged;
  - (f) the exact reply to `/config`;
  - (g) whether a `file_suggestions` control request is answered;
  - (h) the session id after `/compact`;
  - (i) the models and effort levels `supportedModels()` lists;
  - **Version floor:** the lower of `2.1.322` and the recorded version.
- [ ] **Step 6: Clean up:** delete the temp folders; delete `~/.claude/projects/<munged work path>` and, for each recorded session id, `~/.claude/file-history/<id>`, `~/.claude/todos/<id>*`, `~/.claude/session-env/<id>` where present. Leave `~/.claude.json` alone and tell the user Claude Code added an entry for the deleted temp folder there.
- [ ] **Step 7: Rulings.** If finding (c) shows a hook that did not fire, add to Task 11's brief the matching `deps.attention(tabId, reason)` call (`permission` / `question` on a card, `done` on a turn's `result`) and the `deps.setWorking` calls. If the floor is not `2.1.322`, edit Task 9's value. Leave the changes uncommitted.

### Task 1: ship the SDK's notice, never its binaries

**Files:**
- Modify: `THIRD-PARTY-NOTICES.md`, `electron-builder.yml`
- Test: `tests/unit/third-party-notices.test.ts`

- [ ] **Step 1: Write the failing tests** in the existing `describe('third-party notices')`:

```ts
it('electron-builder leaves out the Agent SDK\'s platform packages', () => {
  expect(read('electron-builder.yml')).toMatch(/files:[\s\S]*- "!node_modules\/@anthropic-ai\/claude-agent-sdk-\*\/\*\*"/)
})
it('package.json pins the Agent SDK to one version', () => {
  expect(JSON.parse(read('package.json')).dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.322')
})
it('the notices name the Claude Agent SDK and the terms it is used under', () => {
  const notices = read('THIRD-PARTY-NOTICES.md')
  expect(notices).toMatch(/## Claude Agent SDK[\s\S]*@anthropic-ai\/claude-agent-sdk 0\.3\.322/)
  expect(notices).toContain('© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.')
})
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/third-party-notices.test.ts`. Expected: the builder and notices tests FAIL.
- [ ] **Step 3: Implement.** In `electron-builder.yml` under `files:` add the line `  - "!node_modules/@anthropic-ai/claude-agent-sdk-*/**"`. In `THIRD-PARTY-NOTICES.md` add a section `## Claude Agent SDK` naming `@anthropic-ai/claude-agent-sdk 0.3.322`, the quoted license line above verbatim, and: "ClaudeTerm uses the SDK unmodified to talk to the Claude Code the user installed. It ships none of the SDK's Claude Code binaries. The SDK is not covered by ClaudeTerm's MIT License."
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (the controller snapshots the tree).

### Task 2: tab views and the "Claude tabs open in" setting

**Files:**
- Create: `src/shared/chat.ts`
- Modify: `src/shared/types.ts`, `src/shared/settings-keys.ts`, `src/main/settings.ts`, `src/main/session-store.ts`, `src/main/tab-manager.ts`, `src/main/sync/remote-actions.ts` (`remoteTabInfo`), `src/main/index.ts` (restore and `TabManager` deps), every other place that builds a `TabInfo` (typecheck lists them), `tests/e2e/helpers.ts`, `tests/e2e/accounts.spec.ts`, `tests/e2e/remote-tabs.spec.ts`
- Test: `tests/unit/settings.test.ts`, `tests/unit/session-store.test.ts`, `tests/unit/tab-manager.test.ts` (find the existing files by these names; add to them); existing tests this task breaks and updates: `tests/unit/settings-keys.test.ts`, `tests/integration/sync-remote-actions.int.test.ts`
- The three e2e files are being edited by the Settings plan too: re-read each one right before editing it, change only the lines named in Step 3, add only in `helpers.ts`.

**Interfaces:**
- Produces: `src/shared/chat.ts` exactly as below (later tasks fill these shapes, they do not change them); `TabInfo.view: TabView | null`; `OpenTabRequest.view?: TabView`; `SessionSnapshotTab.view: TabView | null`; `Settings.claude.view: TabView`; `TabManagerDeps.defaultView?(): TabView`.

```ts
// src/shared/chat.ts — the chat view's data, shared by main and the window
export type TabView = 'chat' | 'terminal'
export const TAB_VIEWS: readonly TabView[] = ['chat', 'terminal']
export const isTabView = (v: unknown): v is TabView => v === 'chat' || v === 'terminal'

export type ChatTurn = 'idle' | 'working' | 'waiting'
export type ChatPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'

/** a file the user attached, on this computer: main reads it when the message goes; cardId: its Media card, for a thumbnail */
export interface ChatAttachment { kind: 'image' | 'file'; path: string; name: string; size: number; cardId: string | null }
export interface ChatSend { text: string; attachments: ChatAttachment[] }

export type ChatCallState = 'running' | 'done' | 'failed'
export interface ChatSubagent { id: string; description: string; type: string; state: ChatCallState; ms: number | null }
export interface ChatToolCall {
  id: string; name: string; subject: string; detail: string | null; state: ChatCallState
  output: string | null; error: string | null; editPath: string | null; agents: ChatSubagent[]; ms: number | null
}
export type ChatNoticeAction = 'restart' | 'open-terminal'

export type ChatItem =
  | { kind: 'user'; id: string; text: string; attachments: ChatAttachment[]; queued: boolean }
  | { kind: 'text'; id: string; markdown: string; streaming: boolean }
  | { kind: 'thinking'; id: string; ms: number | null; summary: string | null }
  | { kind: 'tools'; id: string; calls: ChatToolCall[]; ms: number | null }
  | { kind: 'images'; id: string; images: { path: string; cardId: string | null }[] }
  | { kind: 'command'; id: string; command: string; output: string }
  | { kind: 'notice'; id: string; tone: 'info' | 'error'; text: string; action: ChatNoticeAction | null }
  | { kind: 'divider'; id: string; text: string }
  | { kind: 'card'; id: string; card: ChatCard; answered: string | null }

export interface ChatSuggestion { index: number; label: string }
export interface ChatQuestion { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }
export type ChatCard =
  | { type: 'permission'; tool: string; title: string; subject: string; description: string | null
      diff: { path: string; before: string; after: string } | null; suggestions: ChatSuggestion[]; defaultToNo: boolean }
  | { type: 'question'; questions: ChatQuestion[] }
  | { type: 'plan'; plan: string }
  | { type: 'dialog'; kind: string; title: string; text: string; choices: { id: string; label: string }[] }

export type ChatAnswer =
  | { type: 'permission'; choice: 'once' | 'deny'; suggestion: number | null; message: string | null }
  | { type: 'question'; answers: Record<string, string | string[]> | null }
  | { type: 'plan'; choice: 'accept-edits' | 'ask-edits' | 'keep-planning'; message: string | null }
  | { type: 'dialog'; choice: string | null }

export interface ChatState {
  turn: ChatTurn; turnStartedAt: number | null; mode: ChatPermissionMode
  model: string | null; effort: string | null; sessionId: string | null; exited: boolean
}
export interface ChatSnapshot { tabId: string; rev: number; items: ChatItem[]; hasOlder: boolean; state: ChatState }
export type ChatPatch =
  | { op: 'add'; item: ChatItem }
  | { op: 'set'; item: ChatItem }
  | { op: 'append'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'older'; items: ChatItem[]; hasOlder: boolean }
  | { op: 'state'; state: ChatState }
  | { op: 'reset'; items: ChatItem[]; hasOlder: boolean }
export interface ChatCommandInfo { name: string; description: string; argumentHint: string; group: 'builtin' | 'project' | 'plugin'; source: string | null; terminal: boolean }
export interface ChatModelInfo { value: string; displayName: string; description: string; efforts: string[] }
```

- [ ] **Step 1: Write the failing tests.**
  - settings: `parseSettings(JSON.stringify({ claude: {} }))` gives `settings.claude.view === 'chat'` and `errors` `[]`; `{ claude: { view: 'terminal' } }` gives `'terminal'`; `{ claude: { view: 'tabs' } }` gives `'chat'` and `errors` toEqual `['settings.json: invalid value for "claude.view", using default']`; `isSettingKey('claude.view')` is true.
  - existing `tests/unit/settings-keys.test.ts` (lines 5-6): the title becomes `'lists the 25 notification cells, the sound, doneWithBackgroundWork, autoUnread and the twenty-eight plain settings'`, `toHaveLength(57)` becomes `toHaveLength(58)`, and one line `expect(SETTING_KEYS).toContain('claude.view')` follows it.
  - existing `tests/integration/sync-remote-actions.int.test.ts` (the `expect(remoteTabInfo(A_ID, tab)).toEqual({ … })` near line 575): add `view: 'terminal',` after `activity: null,`.
  - session store: a snapshot tab `{ kind: 'claude', …, view: 'terminal' }` parses with `view: 'terminal'`; `'chat'` stays `'chat'`; a Claude tab without `view` (written before this version) parses with `view: null`; a shell tab always parses with `view: null`; `view: 7` parses as `null`.
  - tab manager: `open({ kind: 'claude', cwd })` with `deps.defaultView = () => 'chat'` gives `view: 'chat'`; with `view: 'terminal'` in the request gives `'terminal'`; a shell tab gives `view: null`; without `deps.defaultView` a Claude tab gives `'terminal'`; `snapshot()[i].view` equals the tab's view.
- [ ] **Step 2: Run** `npx vitest run tests/unit/settings.test.ts tests/unit/session-store.test.ts tests/unit/tab-manager.test.ts tests/unit/settings-keys.test.ts tests/integration/sync-remote-actions.int.test.ts`. Expected: FAIL (`view` unknown, 57 keys, no `view` in `remoteTabInfo`).
- [ ] **Step 3: Implement.**
  - `src/shared/chat.ts` as above. `TabInfo.view: TabView | null` (required, so typecheck finds every place that builds one: shell tabs and setup-token tabs `null`; `remoteTabInfo` in `src/main/sync/remote-actions.ts` sets `view: tab.kind === 'claude' ? 'terminal' : null` until plan 4). `OpenTabRequest.view?: TabView`. `SessionSnapshotTab.view: TabView | null`. `Settings.claude.view: TabView`.
  - `settings-keys.ts`: `'claude.view'` in `SettingKey` and `SETTING_KEYS`. `settings.ts`: default `view: 'chat'`, validated with `isTabView`.
  - `TabManager.open`: `view: req.kind === 'claude' && !opts.setupToken ? req.view ?? this.deps.defaultView?.() ?? 'terminal' : null`; `snapshot()` carries `view`. `session-store.ts` parses `view` with `isTabView`, `null` otherwise and for shell tabs.
  - `index.ts`: `defaultView: () => settings.claude.view`; restoring a saved tab passes `view: t.view ?? undefined` (a tab saved before this version opens in the view the setting names: Chat by default — the user's "по дефолту всё новое").
  - Nothing starts differently yet: a tab with `view: 'chat'` still runs its PTY until Task 10 wires `startChat`.
  - The setting is edited only in `settings.json` until the Settings integration of plan 4. `isOpenTabRequest` and `openTabRequestFields` in `src/main/ipc-guards.ts` stay unchanged: a window cannot pick a view when it opens a tab (the spec's switch and the setting are the two ways to pick one).
  - e2e (re-read each file first; change only these lines): in `helpers.ts` add `view: 'terminal',` inside the `claude` object of `FAKE_CLAUDE_SETTINGS` on both platforms; in `accounts.spec.ts` (the `claude: {` object near line 18) and `remote-tabs.spec.ts` (near line 1006) add `view: 'terminal'` to the `claude` objects that do not spread `FAKE_CLAUDE_SETTINGS.claude`. Grep `claude: {` in `tests/e2e` once more: every Claude settings object either spreads `FAKE_CLAUDE_SETTINGS.claude` or names `view: 'terminal'`.
- [ ] **Step 4: Run** the unit command, then `npm run typecheck`, `npm test`, and `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/tabs.spec.ts tests/e2e/accounts.spec.ts --reporter=line --workers=2"`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 3: the chat model, part 1 — text, thinking and tool steps

**Files:**
- Create: `src/main/chat/chat-model.ts`, `tests/fixtures/chat-fixtures.ts`
- Test: `tests/unit/chat-model.test.ts`

**Interfaces:**
- Consumes: `ChatItem`, `ChatPatch`, `ChatToolCall`, `ChatSend` from `src/shared/chat.ts`.
- Produces:

```ts
export interface ChatModelOptions { now(): number; newId(): string; folder(): string }
export class ChatModel {
  constructor(o: ChatModelOptions)
  /** one SDK message, live or from history; anything malformed or unknown gives [] */
  apply(msg: unknown): ChatPatch[]
  /** the user's message, shown at once; queued while a turn runs */
  userSent(send: ChatSend): ChatPatch[]
  items(): readonly ChatItem[]
}
/** what a tool call is about, as a step row and a permission card show it (the rule below); Task 5 imports it */
export function toolSubject(name: string, input: unknown, folder: string): string
// tests/fixtures/chat-fixtures.ts
export function fixtureLines(name: string, dir: 'in' | 'out', vars?: { cwd?: string; home?: string; settings?: string }): unknown[]
```

Rules (the fixtures of Task 0 show the exact shapes; `tests/fixtures/chat/README.md` names them):
- `stream_event` `content_block_start` of a `text` block opens a `text` item with `streaming: true` (patch `add`); each `text_delta` gives `{ op: 'append', id, text }`; the `assistant` message that carries the block sets the item's whole `markdown` with `streaming: false` (patch `set`). Without stream events (history), the `assistant` message adds the `text` item directly. Two text blocks of one message are two items.
- A `thinking` block gives one `thinking` item: `summary` = its text when non-empty, else `null`; `ms` from its stream start to its stop (`now()`), `null` from history.
- `tool_use` blocks join the open `tools` item (the step); a `text` item after them closes the step; the next `tool_use` opens a new one. A call starts `running`. `tool_result` blocks in a `user` message set the call to `done`, or `failed` with `error` (the result text) when `is_error`; `output` = the result text (string content, or its text blocks joined with `\n`), first 64 KiB. `ms` of a call: `tool_use` to result; of the step: its first call's start to its last result.
- `subject` = `toolSubject(name, input, folder())`, by tool: `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` → `input.file_path` (relative to `folder()` when inside it, compared with `pathKey`); `Bash` → the first line of `input.command`; `Glob`, `Grep` → `input.pattern`; `WebFetch` → `input.url`; `WebSearch` → `input.query`; `Task` and `Agent` → `input.description`; a name starting `mcp__` → `JSON.stringify(input)` cut to 80 chars; otherwise `''`. Cap 500 chars.
- `detail`: `Read` → `"<n> lines"` from the output's line count; `Edit` → `"+<a> −<r>"` from `new_string` / `old_string` line counts; `Write` → `"+<n>"`; `Bash` → `"<s>s"` with one decimal from `ms`; otherwise `null`. `editPath` = the absolute `file_path` for `Write`, `Edit`, `MultiEdit`.
- A `user` message whose content is plain text (a string, or text blocks only) and that is not `isMeta` adds a `user` item (history). It is skipped instead when it is a replay of one we sent: `isReplay: true`, or its text equals the text of the oldest `userSent` item not matched yet (that item is then matched). `userSent` adds `{ kind: 'user', text, attachments, queued: false }` (Task 4 sets `queued`).
- Ids come from `newId()`; tool calls keep the `tool_use` id.

- [ ] **Step 1: Write the failing tests** (`describe('ChatModel')`), each built from fixtures with `fixtureLines(name, 'out')` applied in order:
  - `'answer' streams one text item and settles it'`: the patches hold one `add` of a `text` item with `streaming: true`, at least one `append`, and a final `set` whose `markdown` is the fixture's whole answer and `streaming` false; `items()` ends with that one text item.
  - `'read' gives a step with a done Read call whose subject is notes.txt and detail counts its lines'`: one `tools` item, call `{ name: 'Read', subject: 'notes.txt', state: 'done' }`, `detail` matching `/^\d+ lines$/`.
  - `'a failed call keeps its error'`: a hand-made `user` tool_result with `is_error: true` and content `'boom'` → the call is `failed` with `error: 'boom'`.
  - `'malformed messages give no patches'`: `apply(null)`, `apply('x')`, `apply({ type: 'assistant' })`, `apply({ type: 'nope' })` each return `[]`.
  - `'a 2 MiB delta stops at 1 MiB'`: one text block with deltas totalling 2 MiB → the item's markdown length ≤ 1 MiB + 1.
  - `'Bash subject is the first line and detail its seconds'`: hand-made `tool_use` Bash `{ command: 'npm test\nnpm run build' }` with a fake clock 1200 ms to its result → subject `'npm test'`, detail `'1.2s'`.
  - `'history draws each message once'`: every message of `tests/fixtures/chat/history.json` (placeholders replaced as `fixtureLines` does) through `apply` → `items()` holds only `user`, `text` and `tools` items; the number of `user` items equals the number of plain-text user prompts in the file; no two consecutive items have the same kind and text.
  - `'a replayed message we sent is not drawn twice'`: `userSent({ text: 'hi', attachments: [] })`, then `apply({ type: 'user', isReplay: true, message: { role: 'user', content: 'hi' } })` and `apply({ type: 'user', message: { role: 'user', content: 'hi' } })` → `items()` holds one `user` item.
  - `'toolSubject'`: `toolSubject('Read', { file_path: '/work/acme/src/a.ts' }, '/work/acme')` is `'src/a.ts'`; `toolSubject('Grep', { pattern: 'TODO' }, '/w')` is `'TODO'`; `toolSubject('Nope', {}, '/w')` is `''`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-model.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `ChatModel` and `fixtureLines` (reads `tests/fixtures/chat/<name>.jsonl`, keeps the lines of `dir`, replaces `{{CWD}}`, `{{HOME}}`, `{{SETTINGS}}` with the given values JSON-escaped, defaults `/work/acme`, `/home/user`, `/tmp/settings.json`).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 4: the chat model, part 2 — subagents, images, commands, notices, state, paging

**Files:**
- Modify: `src/main/chat/chat-model.ts`
- Test: `tests/unit/chat-model.test.ts`

**Interfaces:**
- Produces, added to `ChatModel`:

```ts
notice(text: string, tone: 'info' | 'error', action: ChatNoticeAction | null): ChatPatch[]
divider(text: string): ChatPatch[]
cardOpened(id: string, card: ChatCard): ChatPatch[]
cardAnswered(id: string, line: string): ChatPatch[]
setState(partial: Partial<ChatState>): ChatPatch[]   // [] when nothing changed
state(): ChatState
/** the newest `count` items (default 200) and whether older ones exist */
page(count?: number): { items: ChatItem[]; hasOlder: boolean }
/** up to `count` items before the item `beforeId` */
older(beforeId: string, count?: number): { items: ChatItem[]; hasOlder: boolean }
/** what the stream said of the status bar; null fields: not said yet */
status(): { model: string | null; effort: string | null; contextPct: number | null; fiveHour: { usedPct: number; resetsAt: number } | null; sevenDay: { usedPct: number; resetsAt: number } | null }
/** the hub's answer from engine.contextPct(), kept for status() */
setContextPct(pct: number | null): void
/** the user asked to stop the running turn: its result is an interruption, not an error */
markInterrupted(): void
```

Rules:
- `system` `init`: state `model`, `mode` (= `permissionMode`), `sessionId`; nothing in the conversation.
- `system` `status` with `permissionMode`: state `mode`.
- `userSent` while `turn !== 'idle'` adds the item with `queued: true`; while idle with `queued: false`, and the turn starts (`working`, `turnStartedAt = now()`). The first `assistant` / `stream_event` after a `result` also starts a turn; then the oldest `queued` user item becomes `queued: false` (patch `set`). `result`: turn `idle`, `turnStartedAt: null`. `cardOpened`: turn `waiting`; `cardAnswered`: back to `working`.
- `task_started` with a `tool_use_id` of a `Task` / `Agent` call: a `ChatSubagent` `{ id: task_id, description, type: subagent_type ?? task_type ?? 'agent', state: 'running', ms: null }` on that call; `task_notification` `completed` → `done`, `failed` / `stopped` → `failed`, `ms` from `usage.duration_ms` else start to now. The call's `detail` becomes `"<n> agents"` when it has more than one.
- Images: a `Read` or `Write` whose `file_path`'s extension is in `DEFAULT_IMAGE_EXTENSIONS` (`src/shared/image-file.ts`; any case), or a `mcp__claudeterm__show_image` call with `input.path`, adds after its step an `images` item `{ path: <absolute>, cardId: null }` (one item per step, paths appended to it, no duplicate path).
- `system` `local_command_output` → a `command` item: `command` = the text of the last user message that started with `/` (first word), `output` = `content`, cut to 64 KiB.
- `system` `compact_boundary` → divider `'Conversation compacted'`.
- `system` `api_retry` → notice `'Retrying in <s>s · attempt <attempt> of <max_retries>'` (`s` = `retry_delay_ms / 1000` rounded up), tone `info`.
- An interrupted `result` — one that comes after `markInterrupted()` in the same turn, or whose `terminal_reason` is `'aborted_streaming'` or `'aborted_tools'` — adds the notice `'Interrupted'`, tone `info`, action `null`, and no error notice; every text item still `streaming` gets `streaming: false` (patch `set`); every `running` call becomes `failed` with `error: 'Interrupted'`. The mark clears with the result.
- Any other `result` with `is_error: true` → notice tone `error`: its `errors` joined with `'; '`, else its `result` text, else `'Claude Code reported an error'`.
- `rate_limit_event`: `rate_limit_info.rateLimitType` `five_hour` / `seven_day` with `utilization` and `resetsAt` fill `status().fiveHour` / `sevenDay` as `{ usedPct, resetsAt }` in the units of `MainStatus` (`src/shared/types.ts`, as the status line gives them): `usedPct` = `utilization × 100` (the SDK gives a fraction 0–1; a value above 1 is taken as a percent already), clamped to 0–100; `resetsAt` in Unix seconds as given (a value above 10^11 is milliseconds and is divided by 1000, rounded down). `status: 'rejected'` adds notice `'Usage limit reached · resets at <HH:MM>'` (local time of `resetsAt`) once per `resetsAt`.
- `status().contextPct` is the last `setContextPct` value; `status().effort` is `state().effort`.
- `cardOpened` adds `{ kind: 'card', id, card, answered: null }`; `cardAnswered` sets `answered: line`.

- [ ] **Step 1: Write the failing tests:**
  - `'init sets model, mode and session id'` from `answer` fixture: `state()` has the fixture's model, `mode: 'default'`, the placeholder session id.
  - `'a turn runs from the message to its result'`: `userSent({ text: 'hi', attachments: [] })` then the `answer` out lines → states seen in order `working` … `idle`, `turnStartedAt` null at the end.
  - `'a message sent during a turn is queued until its turn starts'`: second `userSent` while `working` gives `queued: true`; after the first `result` and the next `assistant` it is `queued: false`.
  - `'/compact draws a divider'` from `compact`: a `divider` with `'Conversation compacted'`.
  - `'/context output is a command item'`: `userSent({ text: '/context', attachments: [] })` first (the fixture's `out` lines do not carry the typed command), then the `slash` out lines → a `command` item with `command: '/context'` and non-empty output.
  - `'an interrupted turn says Interrupted, not an error'`: `userSent`, the `interrupt` out lines up to its first text delta, `markInterrupted()`, then the rest → a notice `'Interrupted'` with tone `info`; no notice with tone `error`; no text item still `streaming`. And a hand-made `{ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', … }` without the mark → the same `'Interrupted'` notice.
  - `'limits and context fill status()'`: a hand-made `rate_limit_event` `{ rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1767225600 } }` and `setContextPct(37)` → `status()` has `fiveHour: { usedPct: 42, resetsAt: 1767225600 }`, `contextPct: 37`.
  - `'setState with no change gives no patch'`: `setState({ mode: state().mode })` returns `[]`.
  - `'a retry is a notice line'`: hand-made `{ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 3500, … }` → notice `'Retrying in 4s · attempt 2 of 10'`.
  - `'an error result is an error notice'`; `'a rejected limit says when it resets, once'`.
  - `'subagents of a Task call'`: hand-made Task `tool_use` id `t1`, `task_started` (`tool_use_id: 't1'`, `task_id: 'a1'`), `task_notification` `completed` → the call's `agents[0]` is `done`.
  - `'a Read of a png adds an images item'`.
  - `'page and older walk 450 items in pages of 200'`: 450 `notice()` calls → `page()` has 200 items, `hasOlder` true; `older(first.id)` 200 more, `hasOlder` true; then 50, `hasOlder` false.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-model.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the rules above in `chat-model.ts`.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 5: cards and answers

**Files:**
- Create: `src/main/chat/chat-cards.ts`, `src/main/chat/chat-guards.ts`
- Test: `tests/unit/chat-cards.test.ts`

**Interfaces:**
- Produces:

```ts
// chat-cards.ts — Claude Code's asks as cards, and the user's answers as what the SDK takes back
export interface PermissionAsk { toolName: string; input: Record<string, unknown>; title?: string; description?: string; displayName?: string; suggestions?: unknown[]; defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean; folder: string }
export function cardFor(ask: PermissionAsk): ChatCard   // AskUserQuestion → question, ExitPlanMode → plan, else permission
export function suggestionLabel(s: unknown): string | null   // null: a suggestion this version cannot word
export type SdkPermissionResult = { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string; interrupt?: boolean }
export function resultFor(ask: PermissionAsk, card: ChatCard, answer: ChatAnswer): SdkPermissionResult | null   // null: the answer does not fit the card
export function answeredLine(card: ChatCard, answer: ChatAnswer): string
// chat-guards.ts
export function isChatAnswer(v: unknown): v is ChatAnswer
export function isChatSend(v: unknown): v is ChatSend
export function isPermissionMode(v: unknown): v is ChatPermissionMode
```

Rules:
- Permission card: `title` = `ask.title` when given, else by tool: `Write`/`Edit`/`MultiEdit` → `'Claude wants to edit <subject>'`, `Bash` → `'Claude wants to run a command'`, `WebFetch` → `'Claude wants to fetch <url>'`, `mcp__…` → `'Claude wants to use <server> · <tool>'`, else `'Claude wants to use <toolName>'`. `subject` = `toolSubject(ask.toolName, ask.input, ask.folder)`, imported from `chat-model.ts` (Task 3) — never a copy of it. `description` = `ask.description` ?? `input.description` (Bash) ?? `null`. `diff` for `Edit` = `{ path, before: old_string, after: new_string }`, for `Write` = `{ path, before: '', after: content }`, else `null` (each string cut to 64 KiB). `suggestions`: none when `suppressAlwaysAllowRule`; otherwise each worded suggestion with its index. Wording: `setMode` `acceptEdits` → `'Allow edits for this session'`; `addRules` with destination `session` → `'Allow <rule> for this session'`, with `localSettings` / `projectSettings` / `userSettings` → `'Always allow <rule>'`, where `<rule>` is `toolName(ruleContent)` or `toolName`; `addDirectories` → `'Allow access to <dir> for this session'`; others are left out.
- Question card: `questions` from `input.questions` (each `question`, `header`, `multiSelect`, `options[{label, description}]`), at most 4 questions and 8 options each; a malformed input gives a permission card for `AskUserQuestion` instead.
- Plan card: `plan` = `input.plan` string.
- `resultFor`: permission `once` → `{ behavior: 'allow', updatedInput: ask.input }`; with `suggestion` i → also `updatedPermissions: [ask.suggestions[i]]`; `deny` → `{ behavior: 'deny', message: answer.message ?? 'The user denied this.' }`. Question with `answers` → `{ behavior: 'allow', updatedInput: { ...ask.input, answers: <each value as a string> } }` (every key a question of the card, every value one of its labels or free text; a `string[]` answer of a multi-select question goes as its labels joined with `', '`, as the `question` fixture's host answer shapes it); `answers: null` → `{ behavior: 'deny', message: 'The user declined to answer.' }`. Plan `accept-edits` → allow with `updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]`; `ask-edits` → allow with `setMode` `default`; `keep-planning` → deny with `answer.message ?? 'Keep planning.'`.
- `answeredLine`: question → `'You answered: <labels joined by ", ">'` or `'You declined to answer'`; permission once → `'Allowed: <title without "Claude wants to ">'`, with a suggestion → `'Allowed for this session: …'` / `'Always allowed: …'`, deny → `'Denied: …'`; plan → `'Plan approved'` / `'Kept planning'`.
- Guards reject anything else: wrong `type`, extra-long strings (message 64 KiB), non-integer `suggestion`, answers that are not string or string arrays; `isChatSend`: `text` ≤ 1 MiB, at most 20 attachments with `kind` image/file, absolute-looking `path` ≤ 4096, `size` a non-negative safe integer, `cardId` a string ≤ 64 or `null`.

- [ ] **Step 1: Write the failing tests:** one per rule above, using the `permission-allow`, `permission-deny`, `question` and `plan` fixtures' `can_use_tool` requests (their `request` objects as `PermissionAsk`): the Write card's title and diff; the Bash card's subject `'echo fixture'` and its suggestion labels; `resultFor` of the question with `{ 'Which format…?': 'PDF report' }` equals the shape the fixture's host answer had; a plan `keep-planning`; `suppressAlwaysAllowRule` drops suggestions; the Write card's `subject` equals `toolSubject('Write', <its input>, <its folder>)`; a multi-select answer `{ 'Which parts?': ['Chart', 'Export'] }` goes as `answers: { 'Which parts?': 'Chart, Export' }`; guards reject `{ type: 'permission', choice: 'always' }` and accept each valid shape.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-cards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 6: the stand-in Claude Code

**Files:**
- Create: `tests/fixtures/fake-claude/fake-claude.ts`, `tests/fixtures/fake-claude/install.ts`
- Test: `tests/integration/fake-claude.int.test.ts`

**Interfaces:**
- Produces:

```ts
// install.ts — a command that runs the stand-in, for claude.command
export function installFakeClaude(dir: string): string   // returns the command: <dir>/claude.cmd on Windows, <dir>/claude elsewhere
export type FakeStep =
  | { text: string; chunks?: number }                                   // a streamed answer
  | { tool: { name: string; input: Record<string, unknown>; result: string; isError?: boolean; ms?: number } }
  | { ask: { tool: string; input: Record<string, unknown>; suggestions?: unknown[]; defaultToNo?: boolean }; allowed: FakeStep[]; denied: FakeStep[] }
  | { command: string; output: string }                                 // local command output
  | { notAvailable: string }                                            // "/<name> isn't available in this environment."
  | { retry: { attempt: number; max: number; delayMs: number } }
  | { error: string }
  | { compact: true }
  | { wait: number }
  | { crash: number; once?: boolean }                                    // exit with this code; once: only on the first run (a marker file beside the script)
  | { noise: string }                                                    // a raw stdout line that is not a message
  | { dialog: string }                                                   // a control_request { subtype: 'request_user_dialog', dialog_kind: <it>, payload: {} }; goes on when answered
export interface FakeScript { version?: string; beforeInit?: FakeStep[]; turns: Record<string, FakeStep[]>; fallback?: FakeStep[] }
```

Behaviour of `fake-claude.ts` (Node, run with `--experimental-strip-types --no-warnings`; node built-ins only, no project imports):
- `--version` prints `<script.version ?? '2.1.322'> (Claude Code)` and exits 0.
- Without `--input-format stream-json` (the terminal view) it prints `fake-claude <args joined by spaces>` and echoes each stdin line as `you said: <line>` until stdin ends.
- With it: reads JSON lines from stdin; answers each `control_request` with a `control_response` built from the recorded ones in `tests/fixtures/chat/control.jsonl` / `answer.jsonl` (initialize, interrupt, set_permission_mode, set_model, get_context_usage, mcp_status, stop_task: success); after the initialize response runs `beforeInit` steps, then emits the recorded `system/init` with `session_id` = `--session-id`, else `--resume` (a new id with `--fork-session`), else a new UUID, and `cwd` = its working folder; for each user message runs `turns[<its text>] ?? fallback ?? [{ text: 'ok' }]`, then a `result`; `ask` steps send a `control_request` `can_use_tool` shaped as the recorded one and wait for the response, then run `allowed` or `denied`; `interrupt` ends the running turn with the recorded interrupted result.
- Writes a transcript line per user and assistant message to `<CLAUDE_CONFIG_DIR>/projects/<cwd with every non-alphanumeric char as ->/<session>.jsonl` (`entrypoint: 'sdk-ts'`), so resume and Recent sessions find it.
- When `FAKE_CLAUDE_LOG` is set, appends JSON lines to it: `{ "argv": [...], "pid": n }` when it starts, `{ "in": <each stdin line parsed> }`, and `{ "exit": code, "pid": n }` as it ends (on stdin's end, a crash step or SIGTERM). Reads the script from `FAKE_CLAUDE_SCRIPT` when set.
- Both modes hold a lock per session: at start, when a session id is known (`--resume` / `--session-id`), it reads `<CLAUDE_CONFIG_DIR>/fake-claude-<id>.lock`; a pid there that is still alive (`process.kill(pid, 0)`) logs `{ "overlap": "<id>" }`; then it writes its own pid there and deletes the file as it ends.
- `installFakeClaude`: Windows writes `claude.cmd` = `@"<process.execPath>" --experimental-strip-types --no-warnings "<abs fake-claude.ts>" %*`; elsewhere `claude` = `#!/bin/sh\nexec "<process.execPath>" --experimental-strip-types --no-warnings "<abs fake-claude.ts>" "$@"\n`, mode 0o755.

- [ ] **Step 1: Write the failing tests** (spawn the installed command directly with `child_process`, `CLAUDE_CONFIG_DIR` in a temp folder):
  - `'--version names a Claude Code version'`: stdout matches `/^2\.1\.322 \(Claude Code\)/`.
  - `'answers initialize and starts with init'`: write the recorded initialize request from `fixtureLines('answer', 'in')[0]` → first two stdout messages are a `control_response` with its `request_id` and a `system`/`init` with the `--session-id` given.
  - `'a scripted turn streams text and ends with a result'`; `'an ask waits for the host's answer'` (allow → `allowed` steps run); `'crash exits with the code'`; `'writes the transcript where Claude Code would'`.
  - `'each scripted step kind emits its message'`: one turn of `retry`, `command`, `notAvailable`, `compact`, `dialog`, `error` → stdout holds in order a `system`/`api_retry` with `attempt`/`max_retries`/`retry_delay_ms`, a `system`/`local_command_output` with the `output`, an assistant text `/<name> isn't available in this environment.`, a `system`/`compact_boundary`, a `control_request` with `subtype: 'request_user_dialog'` (answered by the test), and a `result` with `is_error: true` and the error text.
  - `'two processes on one session id log an overlap'`: start the stand-in in stream mode with `--resume <id>` and keep it running; start a second one with `--resume <id>` → the log holds `{ "overlap": "<id>" }`; end both; start a third with the same id after both exited → no new `overlap` entry; the lock file is gone after the last exit. (Task 13's "no two processes on one session" check rests on this.)
- [ ] **Step 2: Run** `npx vitest run tests/integration/fake-claude.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** it, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 7: starting the user's Claude command without a terminal

**Files:**
- Create: `src/main/chat/claude-spawn.ts`
- Test: `tests/unit/claude-spawn.test.ts`, `tests/integration/claude-spawn.int.test.ts`

**Interfaces:**
- Produces:

```ts
export type ChatLaunch =
  | { how: 'direct'; file: string }
  | { how: 'cmd'; file: string }                      // a .cmd / .bat shim, run by cmd.exe
  | { how: 'shell'; shell: string; command: string }  // the login shell execs the command line
  | { how: 'none'; reason: string }
export interface ChatLaunchDeps { platform: NodeJS.Platform; isFile(p: string): boolean; isExecutable(p: string): boolean; where(name: string): Promise<string[]>; loginShell(): string | null }
export function resolveChatLaunch(command: string, deps: ChatLaunchDeps): Promise<ChatLaunch>
/** cmd.exe's command line for a batch file and its arguments, escaped as cross-spawn escapes for .cmd shims */
export function cmdShimLine(file: string, args: string[]): string
export function spawnChatProcess(launch: Exclude<ChatLaunch, { how: 'none' }>, args: string[], cwd: string, env: Record<string, string | undefined>): ChildProcess
```

Rules:
- Absolute path to an existing file: Windows `.exe` → `direct`, `.cmd` / `.bat` → `cmd`, any other extension → `none`; elsewhere `direct` when executable, else `none`.
- A bare name (no whitespace, no `/` `\` `"` `'`): Windows → `where(name)`: first `.exe` → `direct`, else first `.cmd` / `.bat` → `cmd`, else `none`; elsewhere → `shell` with `loginShell()` (`none` when null).
- Anything else (arguments, shell syntax): Windows → `none`; elsewhere → `shell`.
- `none.reason` = `The Claude command "<command>" cannot be started without a terminal`.
- `claude.shellProfile` (a WSL or Git Bash profile the Claude tabs' terminal runs in) is not used here: the command is resolved on this computer as above. A Claude Code found only inside such a shell resolves to `none` (Windows) and the tab opens in the terminal with that reason; say so in the function's doc comment.
- `spawnChatProcess`: `direct` → `spawn(file, args, { cwd, env, stdio: 'pipe', windowsHide: true })`; `cmd` → `spawn(ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', '"' + cmdShimLine(file, args) + '"'], { …, windowsVerbatimArguments: true })`; `shell` → `spawn(shell, ['-l', '-c', 'exec ' + command + ' ' + args.map(a => quoteForShell(shellFamily({ name: 'login', command: shell, args: [] }), a)).join(' ')], …)` (`quoteForShell`, `shellFamily` from `src/main/profiles.ts`).
- `cmdShimLine`: each arg MSVCRT-quoted (backslashes before a `"` doubled, `"` → `\"`, wrapped in `"…"`), then every `( ) % ! ^ " < > & | ; , space` prefixed with `^` twice (cross-spawn's `escapeArgument(arg, true)`); the file path quoted and meta-escaped once.

- [ ] **Step 1: Write the failing tests.** Unit (fake deps): each rule row above, on `win32` and `linux`. Integration (real processes, temp folder): a `.cmd` shim (Windows only) and a direct `process.execPath` both receive `['plain', 'with space', 'quote"inside', '{"json":["a b"]}', '%PATH%', 'a^b&c|d', '']` unchanged (the program prints `JSON.stringify(process.argv.slice(2))`); `shell` (not Windows) runs `node` by bare name through the login shell with the same arguments; the recorded `spawn-args.json` arguments pass through the `.cmd` shim unchanged.
- [ ] **Step 2: Run** `npx vitest run tests/unit/claude-spawn.test.ts tests/integration/claude-spawn.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `claude-spawn.ts`.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 8: the SDK engine

**Files:**
- Create: `src/main/chat/chat-engine.ts`, `src/main/chat/sdk-engine.ts`
- Test: `tests/integration/sdk-engine.int.test.ts`, `tests/e2e/bundle.spec.ts` (e2e: CI and the lock run it after the build, so it never skips)

**Interfaces:**
- Consumes: `ChatLaunch`, `spawnChatProcess` (Task 7); `PermissionAsk`, `SdkPermissionResult` (Task 5); the stand-in (Task 6).
- Produces:

```ts
// chat-engine.ts — what ChatHub needs of a running conversation; the SDK is one implementation, tests use fakes
export interface ChatEngineStart {
  launch: Exclude<ChatLaunch, { how: 'none' }>; cwd: string; env: Record<string, string>
  settingsPath: string | null   // ClaudeLaunch.settingsPath (src/main/profiles.ts): our hook settings file, null when there is none
  sessionId: string | null      // resume this one; null: a new session
  fork: boolean                 // with sessionId: start a copy of it
}
export interface ChatEngineHandlers {
  message(m: unknown): void
  ask(ask: Omit<PermissionAsk, 'folder'>, signal: AbortSignal): Promise<SdkPermissionResult>
  dialog(kind: string, payload: unknown): void      // answered 'cancelled' by the engine
  stderr(text: string): void
  exit(code: number | null): void
}
export interface ChatEngine {
  send(text: string, images: { mediaType: string; data: string }[]): void
  interrupt(): Promise<void>
  setPermissionMode(mode: ChatPermissionMode): Promise<void>
  setModel(model: string | null): Promise<void>
  stopTask(taskId: string): Promise<void>
  commands(): Promise<ChatCommandInfo[]>
  models(): Promise<ChatModelInfo[]>
  contextPct(): Promise<number | null>
  /** ends the input: Claude Code exits by itself; after `graceMs` (default 2500) the process is killed */
  close(graceMs?: number): void
  kill(): void
}
export type StartChatEngine = (o: ChatEngineStart, h: ChatEngineHandlers) => ChatEngine
// sdk-engine.ts
export const startSdkEngine: StartChatEngine
export function loadSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')>   // the one dynamic import, cached
```

Rules:
- `query({ prompt: <an async queue of SDKUserMessage>, options })` with `cwd`, `env`, `pathToClaudeCodeExecutable: launch.how === 'shell' ? launch.shell : launch.file` (narrowed on `how`: `file` exists only on `direct` / `cmd`, `shell` only on `shell`), `spawnClaudeCodeProcess: (o) => spawnChatProcess(launch, o.args, o.cwd ?? cwd, o.env)`, `settingSources: ['user', 'project', 'local']`, `systemPrompt: { type: 'preset', preset: 'claude_code' }`, `includePartialMessages: true`, `perTaskStopAffordance: true`, `extraArgs: settingsPath === null ? {} : { settings: settingsPath }`, `canUseTool: (toolName, input, o) => h.ask({ toolName, input, title: o.title, description: o.description, displayName: o.displayName, suggestions: o.suggestions, defaultToNo: o.defaultToNo, suppressAlwaysAllowRule: o.suppressAlwaysAllowRule }, o.signal)`, `onUserDialog: async (r) => { h.dialog(r.dialogKind, r.payload); return { behavior: 'cancelled' } }`, `supportedDialogKinds: []`, `stderr: h.stderr`; `resume: sessionId` (+ `forkSession: true` when `fork`), else `sessionId: randomUUID()`.
- Messages of the query's iterator go to `h.message` one by one; the iterator ending or throwing calls `h.exit` once, with the process's exit code when known, else `null`.
- `send` pushes `{ type: 'user', message: { role: 'user', content: [text block, …image blocks] }, parent_tool_use_id: null }`; the queue never blocks the caller.
- `commands()`: `supportedCommands()` mapped to `ChatCommandInfo`: `group` `'builtin'` when the command's `builtin` is true, else `'plugin'` (plan 3 tells project commands apart); `source` = the part before `:` of a name like `plugin:command`, else `null`; `terminal` true for names in the last `init`'s `terminal_slash_commands`. `models()`: `supportedModels()` → `{ value, displayName, description, efforts: supportedEffortLevels ?? [] }`. `contextPct()`: from `getContextUsage()`'s percentage field (the fixture shows its name), `null` on failure.
- `close` ends the input queue, then `kill()` after `graceMs` if `exit` has not come; `kill` kills the child process (`SIGKILL`).

- [ ] **Step 1: Write the failing tests** (the real SDK against the stand-in over real pipes; `CLAUDE_CONFIG_DIR` temp):
  - `'starts the user's command, not the SDK's binary'`: the stand-in's log first line holds its own path as argv[1] and the flags of `spawn-args.json` (`--output-format`, `--input-format`).
  - `'a sent message streams back and the turn ends'`: messages include `system/init`, at least one `stream_event`, an `assistant` and a `result`.
  - `'an ask reaches the handler and its answer reaches Claude Code'`: script `ask` Write → `h.ask` called with `toolName: 'Write'`; answering allow runs the `allowed` steps.
  - `'interrupt ends the turn'`; `'close lets Claude Code exit'`: `exit` called within 3 s; `'noise and unknown messages before init are survived'` (`beforeInit: [{ noise: 'Welcome to bash' }]`): init still arrives and a turn works; `'a crash before init calls exit once'`.
  - `'commands and models come from Claude Code'`: `commands()` holds an entry with `name: 'context'` and `group: 'builtin'`; `models()` is non-empty and every entry has a non-empty `displayName` and an `efforts` array.
  - `'contextPct reads the context usage'`: a number from 0 to 100 (the stand-in answers `get_context_usage` as recorded).
  - `'mode, model and task stop reach Claude Code'`: `setPermissionMode('acceptEdits')`, `setModel('haiku')`, `stopTask('a1')` → the stand-in log holds `in` control requests `set_permission_mode` with `mode: 'acceptEdits'`, `set_model` with `model: 'haiku'`, `stop_task` with `task_id: 'a1'`.
  - `'a null settings path passes no --settings'`: started with `settingsPath: null` → the logged argv has no `--settings`; with a path → `--settings <path>`.
  - `tests/e2e/bundle.spec.ts`, `test('the Agent SDK stays out of the main bundle', …)` (no app launch, no skip): reads `out/main/index.js` from the repository root (as `helpers.ts` resolves `ROOT`); it matches `/(import|require)\(\s*["']@anthropic-ai\/claude-agent-sdk["']\s*\)/` and does not contain `CLAUDE_AGENT_SDK_VERSION="0.3.322"`. A missing file fails the test.
- [ ] **Step 2: Run** `npx vitest run tests/integration/sdk-engine.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** it, then `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/bundle.spec.ts --reporter=line --workers=2"`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 9: may this tab chat? — version, trust, command

**Files:**
- Create: `src/main/chat/chat-support.ts`
- Test: `tests/unit/chat-support.test.ts`

**Interfaces:**
- Produces:

```ts
export const CHAT_MIN_CLAUDE_VERSION = '2.1.322'   // Task 0's README "Version floor" (the controller sets it)
export function versionBlock(command: string, version: string | null): string | null
export function isTrusted(claudeJson: string, folder: string): boolean   // the text of .claude.json
export function trustFile(env: Record<string, string | undefined>, home: string): string  // <CLAUDE_CONFIG_DIR or home>/.claude.json
export interface ChatSupportDeps { version(command: string): Promise<string | null>; readTrust(file: string): Promise<string | null>; launch(command: string): Promise<ChatLaunch>; home: string }
/** null and the launch: the tab can chat; otherwise why it opens in the terminal */
export function chatSupport(command: string, folder: string, env: Record<string, string | undefined>, deps: ChatSupportDeps): Promise<{ launch: Exclude<ChatLaunch, { how: 'none' }> } | { reason: string }>
```

Rules (reasons are exact UI strings):
- version `null` → `Chat needs Claude Code ${CHAT_MIN_CLAUDE_VERSION} or later, and the version of "${command}" could not be read; the tab opened in the terminal`; older than the floor (`versionAtLeast` from `claude-version.ts`) → `Chat needs Claude Code ${CHAT_MIN_CLAUDE_VERSION} or later (this is ${version}); the tab opened in the terminal`.
- `launch` `none` → its reason + `; the tab opened in the terminal`.
- Trust: `.claude.json` parsed defensively (over 16 MB, unreadable or invalid → not trusted); trusted when `projects[key].hasTrustDialogAccepted === true` for the folder or any parent folder, keys compared with `pathKey` (a key may use `/` on Windows). Untrusted → `Claude Code has not been told to trust ${folder} yet; the tab opened in the terminal for its trust question`.
- Checks run in this order: launch, version, trust; the first failing one is the reason.

- [ ] **Step 1: Write the failing tests:** each reason; a trusted parent trusts its child; `C:/Work/Acme` trusts `c:\work\acme\src` on Windows paths (`pathKey` with `win32`); invalid JSON and a 17 MB file are untrusted; `trustFile` prefers `CLAUDE_CONFIG_DIR`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-support.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it. `version` in `index.ts` (Task 12) waits for the running probe of `probeVersion` (Task 12 makes the probe return its promise).
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 10: the tab manager runs a chat process or a PTY, and switches between them

**Files:**
- Modify: `src/main/tab-manager.ts`
- Test: `tests/unit/tab-manager.test.ts`

**Interfaces:**
- Consumes: `ClaudeLaunch` (`src/main/profiles.ts`).
- Produces:

```ts
export interface ResolvedLaunch { …; claude?: ClaudeLaunch }      // a Claude tab's launch inputs, for its chat process
export interface ChatHandle { stop(): void; kill(): void }
export interface ChatStartRequest { tab: TabInfo; claude: ClaudeLaunch; env: Record<string, string>; exit(code: number | null, fallback: string | null): void }
// TabManagerDeps:
startChat?(req: ChatStartRequest): ChatHandle
onChatFallback?(tabId: string, reason: string): void
// TabManager:
setView(tabId: string, view: TabView): Promise<boolean>
```

Rules:
- `start(rec)`: a Claude tab with `view === 'chat'`, a `launch.claude` and `deps.startChat` runs `startChat` instead of `spawn` (same `env` as the PTY gets, same `gen` / `stopped` bookkeeping). `exit(code, null)` → the tab exits as a PTY exit does. `exit(_, fallback)` → `info.view = 'terminal'`, `events.updated`, `onChatFallback(id, fallback)`, `changed()`, then the PTY starts in the same tab.
- Everywhere a PTY is killed (`close`, `relaunch`, `disposeAll`) the chat handle is stopped too: `close` and `relaunch` call `stop()`, `disposeAll` calls `kill()`. `write` and `resize` ignore a chat tab.
- `setView(tabId, view)`: false for an unknown, shell, remote, restarting or preparing tab, for the view it already has, and while `this.activityOf(rec) === 'working'` — the same condition that disables the switch in the window (`info.activity`): a turn runs, a card waits (Task 11 keeps a waiting turn working), or agents run. Otherwise: `info.view = view`, `events.updated`, `changed()`; stop the current process (`chat.stop()` / `pty.kill()`); wait for `rec.stopped` up to 5000 ms, then `chat.kill()` and wait up to 2000 ms more; only after the old process has exited, resolve the launch again with the conversation's resume id (as `restart` does) and `start`. True when the other view started. During the wait `rec.restarting` is true.
- `resolveLaunch` in `index.ts` puts the `claude` object it built into `ResolvedLaunch.claude` (Task 12 does the `index.ts` side; here only the type).

- [ ] **Step 1: Write the failing tests** with a fake `startChat` whose handle records `stop` / `kill` and exits only when the test says:
  - `'a chat tab starts its chat process, not a PTY'`; `'a fallback starts the PTY in the same tab and says why'`;
  - `'setView waits for the old process before starting the new one'`: switch terminal → chat; the fake PTY exits only after 1 s: `startChat` is not called before that exit, and is called after;
  - `'setView kills a chat process that does not stop'`: the chat handle ignores `stop`; after 5 s (fake timers) `kill` is called, its exit then starts the PTY;
  - `'setView is refused while a turn runs'` (`setWorking(id, true)` first), `'… while agents run'` (`setAgentsRunning(id, true)` first), and for a shell tab, an unknown id, a remote tab, a tab that is restarting (a `restart` not yet resolved), a tab still preparing, and the view the tab already has — each resolves false and starts nothing;
  - `'closing a chat tab stops its process'`; `'restarting a chat tab stops its process first'` (`relaunch` calls `stop()` before the new `startChat`); `'disposeAll kills chat processes'` (`kill()` called); `'write and resize ignore a chat tab'` (no throw, nothing recorded); `'the snapshot keeps the new view'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/tab-manager.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it and `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 11: ChatHub — one conversation model per tab, in main

**Files:**
- Create: `src/main/chat/chat-hub.ts`, `src/main/chat/chat-sessions.ts`
- Test: `tests/unit/chat-hub.test.ts`, `tests/unit/chat-sessions.test.ts`

**Interfaces:**
- Consumes: `ChatModel` (Tasks 3–4), `cardFor` / `resultFor` / `answeredLine` (Task 5), `StartChatEngine` (Task 8), `chatSupport` (Task 9), `ChatStartRequest` / `ChatHandle` (Task 10).
- Produces:

```ts
export interface ChatHubDeps {
  engine: StartChatEngine
  support(tab: TabInfo, env: Record<string, string>): Promise<{ launch: Exclude<ChatLaunch, { how: 'none' }> } | { reason: string }>
  history(sessionId: string, folder: string): Promise<unknown[]>     // getSessionMessages with includeSystemMessages
  window(tabId: string, fromRev: number, toRev: number, patches: ChatPatch[]): void
  activeTabId(): string | null
  setSession(tabId: string, sessionId: string): void                 // tabs.setClaudeSession(tabId, id, 'startup')
  setWorking(tabId: string, working: boolean): void
  status(tabId: string, s: ReturnType<ChatModel['status']>): void
  recordSession(sessionId: string): void
  now(): number
  log: { warn(m: string): void }
}
export class ChatHub {
  constructor(d: ChatHubDeps)
  start(req: ChatStartRequest): ChatHandle
  snapshot(tabId: string): ChatSnapshot | null
  send(tabId: string, s: ChatSend): string | null              // null: sent or queued; else why not (exact: 'Claude Code is not running in this tab')
  interrupt(tabId: string): void
  answer(tabId: string, cardId: string, a: ChatAnswer): boolean
  setMode(tabId: string, mode: ChatPermissionMode): Promise<void>
  setModel(tabId: string, model: string | null, effort: string | null): Promise<void>
  stopTask(tabId: string, taskId: string): Promise<void>
  commands(tabId: string): Promise<ChatCommandInfo[]>
  models(tabId: string): Promise<ChatModelInfo[]>
  older(tabId: string, beforeId: string): void                 // an 'older' patch to the window
  sessionChanged(tabId: string, sessionId: string, source: string): void
  activated(tabId: string): void                               // the window shows this tab now: patches for others stop
  removeTab(tabId: string): void
}
// chat-sessions.ts — the chat sessions ClaudeTerm started, so Recent sessions lists them (Claude Code marks them as SDK sessions)
export class ChatSessions { constructor(file: string); has(sessionId: string): boolean; add(sessionId: string): void }   // chat-sessions.json, at most 2000 ids, newest kept; mirror src/main/starred-sessions.ts (its load, its temp-file-and-rename write)
```

Rules:
- `start(req)`: the model is created at once with `newId: () => randomUUID()` (`node:crypto`), `now: deps.now`, `folder: () => req.tab.cwd`; it gets the notice `'Starting Claude…'` (tone `info`, no action) at once, and that notice is removed (a `remove` patch) when `init` arrives or the process exits, whichever comes first; a history `reset` keeps it last until then; when `req.claude.resumeSessionId` is set, history loads first (`history()` → `model.apply` each → one `reset` patch), the process starts in parallel. `support()` failing → `req.exit(null, reason)`. Otherwise `engine(...)` with `sessionId: req.claude.resumeSessionId`, `fork: req.claude.forkSession`, `settingsPath: req.claude.settingsPath`. The returned handle's `stop()` = `engine.close()`, `kill()` = `engine.kill()`; before the engine exists, `stop` cancels the start and calls `exit(null, null)`.
- Every engine message → `model.apply`; `init`'s `session_id` → `setSession`, `recordSession`; whenever `state().turn` changes, `setWorking(tabId, turn !== 'idle')` (a turn waiting on a card counts as working, so the switch stays refused). After each `result`: `engine.contextPct()` → `model.setContextPct(pct)`, then `status(tabId, model.status())`; `status` is also called after `init` and after a `rate_limit_event`, and never while `model.status().model` is null. An exit → notice `'Claude Code stopped'` tone error, action `restart`, state `exited: true`, then `req.exit(code, null)`.
- `interrupt(tabId)`: `model.markInterrupted()`, then `engine.interrupt()`. `setMode(tabId, mode)`: `engine.setPermissionMode(mode)`, then `model.setState({ mode })`. `setModel(tabId, model, effort)`: `engine.setModel(model)`, then `model.setState({ model, effort })` (plan 3 also sends the effort to Claude Code). `stopTask`, `commands`, `models`: the engine's methods (`[]` for a tab without an engine). `older(tabId, beforeId)`: `model.older(beforeId)` sent at once as one `{ op: 'older', items, hasOlder }` patch, whatever tab is in front. Every method on a tab without a running engine does nothing (and `commands` / `models` give `[]`).
- `ask` → `cardFor` → `model.cardOpened(<new id>, card)`; the promise resolves when `answer()` gets a fitting answer (`resultFor` not null) — then `cardAnswered(id, answeredLine(...))`. An aborted signal or the process exiting resolves `{ behavior: 'deny', message: 'Cancelled' }` and marks the card `answered: 'Cancelled'`. A second answer to an answered card returns false.
- `dialog(kind)` → notice `'Claude Code asked something the chat cannot show yet'` with action `open-terminal`.
- Patches: rev counts every patch of the tab. For the tab `activeTabId()` names, patches gather and go out together at most every 16 ms (`setTimeout`), as `window(tabId, fromRev, toRev, patches)`; for other tabs nothing is sent (the window asks for a snapshot when it shows them).
- `sessionChanged(id, source)`: an id other than the model's → divider `'New conversation'` (`source` `clear`, `startup`, `resume`) or `'Conversation compacted'` (`compact`), state `sessionId`.
- `send`: when the process runs, `model.userSent` and `engine.send(text, [])` (attachments come in plan 3); else the refusal string.

- [ ] **Step 1: Write the failing tests** with a fake engine (records sends, lets the test emit messages, asks and exit) and fake clock:
  - `'a resumed tab draws its history before the process is up'`: `history` resolves 3 fixture messages, the engine is not started yet → `snapshot()` holds their items.
  - `'support failing falls back with its reason'`; `'init records and reports the session'`;
  - `'patches for the tab in front go out at most every 16 ms, others never'`;
  - `'an ask becomes a card and the answer goes back'`; `'a stray second answer is refused'`; `'an exit cancels a waiting card and says Claude Code stopped'`;
  - `'sessionChanged with clear draws New conversation'` (Review Focus 5); `'send before the process runs is refused'`;
  - `'a waiting card keeps the tab working'`: a turn starts, an ask opens a card → the last `setWorking` call is `(tabId, true)`; after the `result` it is `(tabId, false)`;
  - `'Starting Claude… goes when init comes'`: right after `start` the snapshot holds that notice; the engine emits `init` → a `remove` patch with its id;
  - `'older sends the page before an item'`: the fake engine emits `init`, then 450 `{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000 }` messages (450 notices); `older(tabId, <the first item id of snapshot()>)` → one `older` patch with 200 items and `hasOlder: true`;
  - `'interrupt marks the turn and asks the engine'`: the fake engine records `interrupt`; its next `result` gives an `'Interrupted'` notice and no error notice;
  - `'context is read after each result and reported'`: the fake engine's `contextPct` resolves 37 → `status` called with `contextPct: 37`;
  - chat sessions: `'keeps the newest 2000 ids across a reload'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-hub.test.ts tests/unit/chat-sessions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 12: main wiring — IPC, preload, Recent sessions, status

**Files:**
- Create: `tests/e2e/chat-helpers.ts` (`launchChatTab`, see Task 13's Interfaces; Task 13 uses it), `tests/e2e/chat-wiring.spec.ts`
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/main/session-history.ts`
- Test: `tests/integration/chat-sessions-history.int.test.ts`, `tests/unit/session-history.test.ts` (existing name, add), `tests/e2e/chat-wiring.spec.ts`
- `src/main/ipc-guards.ts` is not changed: the handlers use its existing `isId`, `isTabView` from `src/shared/chat.ts` and the guards of `src/main/chat/chat-guards.ts` (tested in Task 5).

**Interfaces:**
- Produces (IPC names and `CtApi` methods; later plans use exactly these):

```ts
// IPC
chatSnapshot: 'chat:snapshot', chatSend: 'chat:send', chatInterrupt: 'chat:interrupt', chatAnswer: 'chat:answer',
chatSetMode: 'chat:set-mode', chatSetModel: 'chat:set-model', chatStopTask: 'chat:stop-task', chatCommands: 'chat:commands',
chatModels: 'chat:models', chatOlder: 'chat:older', tabsSetView: 'tabs:set-view', evChatPatch: 'ev:chat-patch'
// CtApi
chatSnapshot(tabId: string): Promise<ChatSnapshot | null>
chatSend(tabId: string, s: ChatSend): Promise<string | null>
chatInterrupt(tabId: string): void
chatAnswer(tabId: string, cardId: string, a: ChatAnswer): Promise<boolean>
chatSetMode(tabId: string, mode: ChatPermissionMode): void
chatSetModel(tabId: string, model: string | null, effort: string | null): void
chatStopTask(tabId: string, taskId: string): void
chatCommands(tabId: string): Promise<ChatCommandInfo[]>
chatModels(tabId: string): Promise<ChatModelInfo[]>
chatOlder(tabId: string, beforeId: string): void
setTabView(tabId: string, view: TabView): Promise<boolean>
onChatPatch(cb: (tabId: string, fromRev: number, toRev: number, patches: ChatPatch[]) => void): Unsubscribe
```

Rules:
- `index.ts` builds one `ChatHub`: `engine: startSdkEngine`; `support` = `chatSupport(settings.claude.command, tab.cwd, env, { version: (c) => <the probe's promise for c>, readTrust: <fs.promises.readFile, null on error>, launch: (c) => resolveChatLaunch(c, <real deps: where.exe through execRunner, isExecutableFile, loginShell>), home: homedir() })` — `probeVersion` keeps a `Map<string, Promise<string | null>>` so a chat start can wait for the probe already running; `history` = `(await loadSdk()).getSessionMessages(id, { dir: folder, includeSystemMessages: true })`; `window` sends `IPC.evChatPatch` to the main window; `activeTabId: () => tabs.activeTabId()`; `setSession` = `tabs.setClaudeSession(id, sid, 'startup')`; `setWorking` = `tabs.setWorking`; `status` feeds `statusHub.status({ v: 1, type: 'status', tabId, sessionId, model: { id: model, displayName: model }, effort, context: <from contextPct, size 0 when unknown>, fiveHour, sevenDay })` only while the tab is in chat view; `recordSession` = `chatSessions.add`.
- `TabManager` deps: `startChat: (req) => chatHub.start(req)`, `onChatFallback: (_id, reason) => toast(reason)`; `resolveLaunch` sets `claude` on the launch it returns for Claude tabs. The `session` pipe message also calls `chatHub.sessionChanged(tabId, sessionId, source)`; tab activation calls `chatHub.activated(id)`; tab close calls `chatHub.removeTab(id)`.
- Every handler checks its arguments (`isId`, `isTabView`, `isChatSend`, `isChatAnswer`, `isPermissionMode`, strings ≤ 256 for model / effort / task id) and that the tab is a local Claude tab. Wrong arguments: `chatSnapshot` → `null`, `chatSend` → `'Invalid message'`, `chatAnswer` / `setTabView` → `false`, the others do nothing. Right arguments for a tab without a chat (a shell tab, a remote tab, a terminal-view tab): `chatSnapshot` → `null`, `chatSend` → the hub's `'Claude Code is not running in this tab'`, `setTabView` → whatever `tabs.setView` answers (false for shell and remote tabs).
- `SessionHistory`: constructor `(projectsDir, fs = nodeHistoryFs, alsoInteractive: (sessionId: string) => boolean = () => false)`; `parseSessionHead(text, whole, knownChat = false)` and `parseSessionTail(text, fromStart, knownChat = false)` treat the entrypoint `'sdk-ts'` as interactive when `knownChat` is true; `SessionHistory` passes `this.alsoInteractive(<the file's session id: its name without .jsonl>)` to both. `index.ts` passes `(id) => chatSessions.has(id)`.

- [ ] **Step 1: Write the failing tests:**
  - session-history: unit `'parseSessionHead lists an sdk-ts session it knows as a chat'` (`entrypoint: 'sdk-ts'` → `null` without `knownChat`, a head with it); integration: an `entrypoint: 'sdk-ts'` transcript is hidden, and listed once `alsoInteractive` knows its id (real files in a temp projects dir).
  - `tests/e2e/chat-wiring.spec.ts` (`launchChatTab`; this task has no chat drawing yet, so the tests call `window.ct` through `page.evaluate` and read the status bar):
    - `'a chat tab reports the model Claude Code started with'`: after start, `#statusbar .status-model .status-text` shows the `model` of the `answer` fixture's `system/init` (read with `fixtureLines('answer', 'out')`).
    - `'a session message moves a chat tab to the new conversation'`: the pipe message `{ v: 1, type: 'session', tabId, sessionId: '00000000-0000-4000-8000-000000000099', source: 'clear', transcriptPath: null }` → `ct.chatSnapshot(tabId)` has a `divider` item `'New conversation'` and `state.sessionId` equal to that id.
    - `'chat calls for a shell tab do nothing'`: a shell tab's id → `chatSnapshot` `null`, `setTabView(id, 'chat')` `false`, `chatSend(id, { text: 'x', attachments: [] })` `'Claude Code is not running in this tab'`; the chat tab's id with `chatSend(id, { text: 7 })` → `'Invalid message'` and the stand-in log holds no user message.
- [ ] **Step 2: Run** `npx vitest run tests/integration/chat-sessions-history.int.test.ts tests/unit/session-history.test.ts` and `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/chat-wiring.spec.ts --reporter=line --workers=2"`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring, the IPC / preload surface above, and `chat-helpers.ts`.
- [ ] **Step 4: Run** them, `npm run typecheck`, `npm test`, then `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/chat-wiring.spec.ts tests/e2e/tabs.spec.ts tests/e2e/accounts.spec.ts --reporter=line --workers=2"`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 13: the plain chat view, the Chat | Terminal switch, end to end

**Files:**
- Create: `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat-items.ts`, `src/renderer/chat/chat-composer.ts`, `src/renderer/chat/chat.css`, `tests/e2e/chat.spec.ts`
- Modify: `src/renderer/main.ts`, `src/renderer/sheet-header.ts`, `src/renderer/styles.css` (the switch only), `src/renderer/icons.ts` (`message-square`, `terminal` if missing; add only), `tests/fixtures/fake-claude/fake-claude.ts` only if a step below needs a fix (report it)

**Interfaces:**
- Consumes: the `CtApi` chat methods and `launchChatTab` (Task 12); `ct.restartTab(id, live)` (`src/preload/index.ts`).
- Produces:

```ts
// chat-view.ts
export interface ChatViewOptions {
  tabId: string; container: HTMLElement; platform: string
  send(s: ChatSend): void; interrupt(): void; answer(cardId: string, a: ChatAnswer): void
  restart(): void; openTerminal(): void; older(beforeId: string): void
}
export class ChatView {
  readonly element: HTMLDivElement            // class 'chat-host', inside #terminals
  constructor(o: ChatViewOptions)
  show(visible: boolean, focus?: boolean): void
  load(s: ChatSnapshot): void
  /** false: the patches do not follow the view's revision; the caller asks for a snapshot */
  patch(fromRev: number, toRev: number, patches: ChatPatch[]): boolean
  focus(): void
  dispose(): void
}
// chat-items.ts
export interface ItemCallbacks { answer(cardId: string, a: ChatAnswer): void; restart(): void; openTerminal(): void }
export function renderItem(item: ChatItem, cb: ItemCallbacks): HTMLElement   // plan 2 replaces each kind's drawing
// chat-composer.ts
export class ChatComposer { readonly element: HTMLDivElement; constructor(o: { send(text: string): void; interrupt(): void }); setTurn(turn: ChatTurn): void; focus(): void }
// sheet-header.ts
setModes(m: { view: TabView; busy: boolean } | null): void        // null hides the switch (shell tabs, remote tabs)
// callbacks: switchView(view: TabView): void
// tests/e2e/chat-helpers.ts (created in Task 12)
/** version: written as the script's FakeScript.version, which the stand-in prints for --version (the app's version probe reads it) */
export async function launchChatTab(script: FakeScript, o?: { trusted?: boolean; version?: string; work?: string }): Promise<Launched & { work: string; config: string; tabId: string; log(): unknown[] }>
```

Rules:
- Plain drawing for now (plan 2 draws the boards): `user` → a right-aligned bubble with the text; `text` → the Markdown source as text (`white-space: pre-wrap`, `textContent`, never `innerHTML`); `tools` → one row per call `name subject` with ✓ / ✕ / spinner; `notice` → one line, with a **Restart** button for `restart` (calls `restart()` = `ct.restartTab(tabId, false)`) and **Open in the terminal** for `open-terminal` (calls `openTerminal()` = `ct.setTabView(tabId, 'terminal')`); `divider` → a centred line with its text; `card` → a minimal card: permission **Allow once** (`{ type: 'permission', choice: 'once', suggestion: null, message: null }`) / **Deny** (`choice: 'deny'`), question the first question's options as buttons (`{ type: 'question', answers: { [question]: label } }`) and **Skip** (`answers: null`), plan **Approve** (`{ type: 'plan', choice: 'ask-edits', message: null }`) / **Keep planning** (`choice: 'keep-planning'`); once `answered`, the card is one line with that text; other kinds and `dialog` cards (none are made in part 2: Task 11 turns every dialog into a notice) → one quiet line naming the kind.
- The column: `.chat-scroll` (scrolls) holding `.chat-column` (max-width 860 px, centred, 36 px side padding), then `.chat-composer` at the bottom. It sticks to the bottom while new items come unless the user scrolled up.
- Composer: a `textarea` (`.chat-input`), Enter sends (empty text is not sent), Shift+Enter is a newline, Esc calls `interrupt()` while a turn runs; the placeholder is `Message Claude…`, while working `Queue a follow-up…`.
- `main.ts`: `TabState.chat: ChatView | null` — created in `addTab` for local Claude tabs (not remote, not setup-token); `activate` shows the chat when `info.view === 'chat'`, else the terminal, and asks `ct.chatSnapshot(id)` to `load` it; `ct.onChatPatch` → `chat.patch(...)` and, on false, a new `chatSnapshot`; `onTabUpdated` with a changed `view` re-shows the tab and reloads the snapshot; `sendToClaude` (Review Send, plan Send, `window.__ct.sendText`) in chat view calls `ct.chatSend(id, { text: message, attachments: [] })` and returns its refusal.
- **A tab in chat view has no xterm** (the spec: "In chat view, the tab runs the SDK process and has no PTY and no xterm"). `TabState.view` becomes `TerminalView | null`. Move the `new TerminalView({ … })` + `attachTerminalMouse` block of `addTab` into `makeTerminal(info: TabInfo): TerminalView`; `addTab` calls it unless the tab is a local Claude tab with `info.view === 'chat'`; `ensureTerminal(id): TerminalView` makes it when missing. `onTabUpdated` with `view` → `'terminal'` calls `ensureTerminal` before the PTY's first output can arrive (the update comes before the PTY starts); PTY output for a tab without a terminal also calls `ensureTerminal` first. `view` → `'chat'` disposes the tab's `TerminalView` and sets it to `null`. Every other `t.view` use (typecheck lists them, about 36 in `main.ts`) reads `t.view?.…` and treats a missing terminal as an empty one: no screen text (`leftUnfinished` gets `''`), `bufferText` `''`, theme background `null`, nothing to fit, focus or search.
- Focus: dirty `main.ts` has about ten `….view.term.focus()` calls (grep `term.focus()`); each goes through one `focusTab(id)` that focuses the composer in chat view and the terminal otherwise.
- Switch: two buttons in `.sh-modes`, `.sh-mode[data-view="chat"]` (icon `message-square`, label `Chat`) and `.sh-mode[data-view="terminal"]` (icon `terminal`, label `Terminal`), the current one `aria-pressed="true"`; shown for local Claude tabs only. While `info.activity === 'working'` both are disabled with the title `Claude is working — switch when it finishes, or press Esc to stop it`. A click on the other view: when the tab's status lists background tasks (`statusUpdates` `background.length = n > 0`), a confirm row `.sh-mode-confirm` appears under the switch: `${n} background task${n === 1 ? '' : 's'} will stop. Switch anyway?` with **Switch** and **Cancel**; otherwise `ct.setTabView(id, view)` at once.

- [ ] **Step 1: Write the failing e2e tests** (`tests/e2e/chat.spec.ts`; `launchChatTab` (Task 12) installs the stand-in into a temp folder, writes the script, `.claude.json` trusting the work folder unless `trusted: false`, and starts the app with `FAKE_CLAUDE_SETTINGS` + `claude: { …, command: <stand-in>, view: 'chat' }` and env `CLAUDE_CONFIG_DIR`, `FAKE_CLAUDE_SCRIPT`, `FAKE_CLAUDE_LOG`):
  - `'a message is sent and the answer streams in'`: type `hello`, Enter → a `.chat-user` bubble `hello`, then the scripted text in the column.
  - `'a chat tab has no terminal'`: in chat view `#terminals .terminal-host` count is 0 and `.chat-host` is visible; after switching to Terminal there is one `.terminal-host`; after switching back, 0 again.
  - `'Enter on empty text sends nothing, Shift+Enter makes a new line'`: Enter in the empty composer → the stand-in log holds no user message; typing `a`, Shift+Enter, `b` → `.chat-input` value `'a\nb'`, no message sent.
  - `'the composer says what Enter will do'`: placeholder `Message Claude…` while idle; `Queue a follow-up…` while a turn runs (script `[{ wait: 3000 }]`), back after it.
  - `'the column sticks to the bottom unless scrolled up'`: a turn of 80 lines → `.chat-scroll` `scrollTop + clientHeight ≥ scrollHeight − 2`; scroll to the top, another 80-line turn → `scrollTop` unchanged (±1).
  - `'a question card is answered, or skipped'`: an `ask` of `AskUserQuestion` with two options → clicking the second option → the stand-in log holds the `can_use_tool` response with `answers` `{ <question>: <second label> }` and the card becomes one line; a second ask, **Skip** → a deny response.
  - `'a plan card approves or keeps planning'`: an `ask` of `ExitPlanMode` → **Approve** → an allow response with `updatedPermissions` `setMode` `default`; another → **Keep planning** → a deny with `Keep planning.`.
  - `'a dialog says the chat cannot show it, and opens the terminal'`: a turn `[{ dialog: 'example' }, { text: 'done' }]` → the notice `Claude Code asked something the chat cannot show yet`; once the turn has ended, its **Open in the terminal** → `.sh-mode[data-view="terminal"]` has `aria-pressed="true"` and the tab shows its `.terminal-host`.
  - `'switching with background tasks asks first'`: after a turn, the pipe message `{ v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [{ id: 'b1', type: 'shell', description: 'Run the e2e suite', command: 'npx playwright test' }] }` → clicking Terminal shows `.sh-mode-confirm` `1 background task will stop. Switch anyway?`; **Cancel** keeps Chat; clicking Terminal again and **Switch** switches.
  - `'Send from a panel goes to the chat as a message'`: `window.__ct.sendText(tabId, 'Look at a.ts')` → the stand-in log holds a user message `Look at a.ts` and a `.chat-user` bubble shows it.
  - `'Esc interrupts a running turn'` (script `[{ wait: 10000 }]`): Esc → the stand-in log holds an `interrupt` control request.
  - `'a permission card allows once and denies'`.
  - `'switching to the terminal and back keeps the conversation'`: after one turn, click Terminal → the terminal shows `fake-claude` with `--resume <the session id>`; click Chat → the stand-in's log shows a start with `--resume` of the same id and the earlier messages are in the column; the log holds no `overlap` entry (two processes never held the session at once).
  - `'the switch is disabled while Claude works'`.
  - `'a restored chat tab opens in chat with its history'`: a `session-state.json` with a Claude tab `view: 'chat'` and a session transcript → the column shows the history.
  - `'an untrusted folder opens in the terminal and says why'`; `'an old Claude Code opens in the terminal and says why'` (`version: '2.1.100'`); a toast with the reason shows each time.
  - `'Claude Code stopping shows Restart, and Restart starts it again'` (`beforeInit: [{ crash: 1, once: true }]`): the notice `Claude Code stopped` with **Restart**; Restart → the stand-in's second start answers a message (Review Focus 1).
  - `'closing a chat tab ends its Claude Code'`: `processAlive(<the stand-in's folder>)` false after closing (Review Focus 4).
  - `'reduced motion: the chat has no running animation'`: while a turn runs (script `[{ wait: 5000 }]`), first without reduced motion at least one `.chat-host *` has a computed `animationName` other than `none` (the spinner), then with `emulateMedia({ reducedMotion: 'reduce' })` every `.chat-host *` computed `animationName` is `none`.
- [ ] **Step 2: Run** `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/chat.spec.ts --reporter=line --workers=2"`. Expected: FAIL.
- [ ] **Step 3: Implement** the renderer files, the switch and `main.ts` changes.
- [ ] **Step 4: Run** the chat spec the same way, then `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/sheet.spec.ts tests/e2e/tabs.spec.ts tests/e2e/restore.spec.ts tests/e2e/review.spec.ts tests/e2e/attention.spec.ts tests/e2e/keys.spec.ts --reporter=line --workers=2"`, `npm run typecheck`, `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.
