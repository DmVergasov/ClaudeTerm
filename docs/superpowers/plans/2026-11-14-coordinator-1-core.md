# Project coordinator, part 1 of 3: the core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On one device, a Claude tab can be made the coordinator of its git project and, through the bundled `claudeterm` MCP server, list, start, attach, task, read, resolve and detach the Claude sessions of the project; a task waits for an idle session, and when the session's turn on it ends, the session's last answer reaches the coordinator as a report — with no new UI (part 2 adds the window, part 3 other devices).

**Architecture:** Tasks and reports ride on agent mail. `MailRecord` gets a `kind` (`task`, `report`, `attach`, `detach`), and `MailHub` asks a filter before it hands a record over and says what it handed over. A new `CoordinatorHub` (`src/main/coordinator/`) keeps the roles, the attachments and the tasks in `coordinators.json`, keyed by session ids; it moves each task through queued → delivered → open → finished / failed / stopped from the turn events main already receives (hooks, Esc, exit, close), writes the reports, and builds the views the window and the MCP tools read. `PromptDelivery` writes a task or a report as a prompt when no mail watcher waits. Seven MCP tools reach the hub through one pipe message type, `coord`.

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), Node `net` pipe, `@modelcontextprotocol/sdk` + zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-project-coordinator-design.md` — read it before any task; this plan argues from it. Rules every change is held to: `AGENTS.md`.

## Global Constraints

- Everything in AGENTS.md applies: English comments, logs and texts; match the surrounding code; tests at the right level; keep each file's line endings (a new file takes those of the files beside it).
- Commit steps run only when the controller allows commits; until then leave the work in the working tree.
- No renderer code in this plan (part 2). No device-to-device code (part 3): a session on another device is refused with `HUB_TEXT.remote` / `HUB_TEXT.otherDevice` (Task 6, Task 8).
- Everything from the pipe and every mail record is untrusted: validated and bounded. Bounds: a task's text 1–7000 characters (`COORD_TASK_MAX = 7000`); a record's text 1–8000 (`MAIL_TEXT_MAX`); a report's text the last answer cut to 6000 characters plus a note (`REPORT_TEXT_MAX = 6000`); the last answer the hook passes ≤ 8000 characters (`LAST_MESSAGE_MAX = 8000`); a pending prompt's line ≤ 200 characters (`PROMPT_TEXT_MAX = 200`); a record's `project` and `reason` 1–200 characters without control characters (`MAIL_NAME_MAX`, `MAIL_REASON_MAX = 200`); a tab name ≤ 100 (`COORD_NAME_MAX`); a worktree name matches `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`; at most 20 tasks held per session (`MAX_TASKS_PER_SESSION`).
- Every IPC argument is checked in `src/main/ipc-guards.ts`. Paths are compared with `pathKey`; a project is `TabPlace.project.key`.
- ClaudeTerm never writes to the person's repository: no `git worktree add`; `worktree` only puts an EnterWorktree instruction before the task.
- The hook script never prints to stdout and exits 0; only the mail watcher exits 2.
- Main never blocks: the store is read once at start and written debounced (as `TaskListStore`); `start_session`'s answer is a promise; folders are checked with the async `isDirAsync`.
- Coordinating needs agent mail: `agentMessages.enabled` and Claude Code ≥ `MAIL_MIN_CLAUDE` (2.1.287). Without it, attach, message and start are refused with `coordinatorProblem(...)` (Task 4); making a coordinator and `list_sessions` still work and show the problem.
- One coordinator per project key on this device. A session is attached to at most one coordinator.
- State is keyed by Claude session ids, never tab ids. In the store, `device: null` is this device; in mail records an end on this device carries `selfDeviceId || null`, as `MailHub` writes today.
- The coordinator is woken only by a `finished` or `failed` report. A `stopped` report waits for its next turn. `attach` / `detach` records wake nobody, are written `delivered: true, read: true`, and are hidden from the Agent messages panel and the unread marks.
- Tests use invented projects, names and paths (`acme`, `parser · Desktop`), create files under `tmpdir()` only, and close what they start.

## Review Focus

1. **The Stop race:** the watcher a `Stop` starts can reach main before that turn's `done`. A task must not go into the ending turn, and a stopped report must not wake the coordinator then — Task 2 (`"next"`), Task 6 (`accepts`).
2. **The person's prompt queued during the task's turn:** Claude Code submits it right after `Stop`; the task stays open and the report is the answer after their turn — Task 7 (`REST_SETTLE_MS`), Task 12 e2e.
3. **Esc in a task turn a watcher started, or a denied permission prompt in it:** a rewake fires no `UserPromptSubmit`, so the tab is not "working", and an interrupted turn has no Stop; the task must still end as stopped, not hang as Working — Task 7 (the hub's own in-turn mark; the transcript's interrupt entry), Task 12 e2e.
4. **Quitting ClaudeTerm is not closing tabs:** open tasks survive and are not failed; the role and the attachments come back with the restore — Task 11 and Task 12 e2e (quit and restore).
5. **A new session id in the same tab** (`/clear`, a compaction, a resume under a new id, the chat view's init racing the hook): the role, the attachments and the tasks follow it; a `/clear` stops the open task — Task 6, Task 7, Task 11 e2e.

---

## File structure

| File | Responsibility |
|---|---|
| `src/shared/mail.ts` (modify) | `MailKind`, `ReportOutcome`, new record fields, view fields |
| `src/main/mail/mail-record.ts` (modify) | validation of the new kinds and fields |
| `src/main/mail/mail-store.ts` (modify) | `isShareable`: a signal between two ends of one device stays here |
| `src/main/mail/wake-text.ts` (modify) | the task and report blocks of a wake text |
| `src/main/mail/mail-hub.ts` (modify) | kinds in views and unread; hand-over filter and report; prompt take; `interrupted` |
| `src/shared/protocol.ts` (modify) | attention `prompt` / `lastMessage`; `coord` message |
| `src/hook/session-hook.ts` (modify) | Stop's last answer; the permission / question line |
| `src/main/tab-waits.ts` (create) | per tab: the dialog's prompt line, the usage-limit stop |
| `src/main/review-hub.ts`, `src/main/auto-continue.ts` (modify) | `onDialogsClosed`; `pending` |
| `src/shared/coordinator.ts` (create) | shared types, constants, `coordinatorProblem`, `CoordOp` |
| `src/main/coordinator/coordinator-store.ts` (create) | `coordinators.json` |
| `src/main/coordinator/task-machine.ts` (create) | the task's state machine |
| `src/main/coordinator/session-state.ts` (create) | a row's group and line; finding a row by name, ref or key |
| `src/main/coordinator/session-text.ts` (create) | `list_sessions` and `read_session` answers |
| `src/main/coordinator/report-text.ts` (create) | a report's text and reasons |
| `src/main/coordinator/coordinator-hub.ts` (create) | roles, attachments, tools, records, task lifecycle, views |
| `src/main/coordinator/prompt-delivery.ts` (create) | delivery as a prompt when no watcher waits |
| `src/mcp/coordinator-tools.ts` (create), `src/mcp/show-image-server.ts` (modify) | the seven MCP tools |
| `src/main/pipe-server.ts`, `src/main/claude-tab-settings.ts` (modify) | `coord` dispatch; tools auto-allowed |
| `src/main/index.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts` (modify) | wiring and the IPC surface |

---

### Task 1: Mail record kinds

**Files:**
- Modify: `src/shared/mail.ts`
- Modify: `src/main/mail/mail-record.ts:8-37`
- Modify: `src/main/mail/mail-store.ts:10-13`
- Modify: `src/main/mail/wake-text.ts:39-52`
- Modify: `src/main/mail/mail-hub.ts:220-276` (unread, conversations), `:331-350` (offer)
- Test: `tests/unit/mail-record.test.ts`, `tests/unit/wake-text.test.ts`, `tests/unit/mail-hub.test.ts`, `tests/integration/mail-store.int.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (`src/shared/mail.ts`):
  ```ts
  export type MailKind = 'message' | 'task' | 'report' | 'attach' | 'detach'
  export type ReportOutcome = 'finished' | 'failed' | 'stopped'
  export const REPORT_OUTCOMES: readonly ReportOutcome[] = ['finished', 'failed', 'stopped']
  /** the longest reason of a failed or stopped report, in characters */
  export const MAIL_REASON_MAX = 200
  export interface MailRecord {
    /* ...the fields of today... */
    /** absent: a message (every record of an older ClaudeTerm) */
    kind?: 'task' | 'report' | 'attach' | 'detach'
    /** task, attach: the coordinator's project name */
    project?: string
    /** report: how the task ended (required on a report) */
    outcome?: ReportOutcome
    /** report, failed or stopped: why */
    reason?: string
  }
  export const kindOf = (r: Pick<MailRecord, 'kind'>): MailKind => r.kind ?? 'message'
  /** attach and detach tell a device, not a model: never handed over, counted or listed */
  export const isSignal = (r: Pick<MailRecord, 'kind'>): boolean => r.kind === 'attach' || r.kind === 'detach'
  // MailMessageView gets: kind: MailKind; outcome: ReportOutcome | null; reason: string | null
  ```
- `checkMailRecord` (`mail-record.ts`) keeps the new fields: `kind` absent or `'message'` → no `kind`, no `project`/`outcome`/`reason` in the copy; an unknown `kind` → `null`. `task` and `attach` keep an optional `project` (1–`MAIL_NAME_MAX`, no `\p{Cc}`, else `null`). `report` needs `outcome` in `REPORT_OUTCOMES` and a UUID `replyTo` (the task's id), else `null`; it keeps an optional `reason` (1–`MAIL_REASON_MAX`, no `\p{Cc}`, else `null`) only when `outcome` is `failed` or `stopped`, and drops it on `finished`. `detach` keeps no extra field.
- `isShareable(r)` (`mail-store.ts`): both devices non-null, and not (`isSignal(r)` and `r.from.device === r.to.device`).
- `wake-text.ts`: the block of a record follows its kind (exact copy in the tests below); `message` keeps today's block.
- `MailHub`: `unreadByTab` and `conversations` skip `isSignal` records; each `MailMessageView` carries `kind`, `outcome` (`null` unless a report), `reason` (`null` when absent); `offer` never takes an `isSignal` record.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mail-record.test.ts` (new `describe('checkMailRecord kinds')`, with `const base = record()`, the file's valid message, and `TASK_ID` a new UUID constant):
```ts
it('keeps a task with its project; a message carries no kind', () => {
  expect(checkMailRecord({ ...base, kind: 'task', project: 'acme' })).toEqual({ ...base, kind: 'task', project: 'acme' })
  expect(checkMailRecord({ ...base, kind: 'message', project: 'acme' })).toEqual(base)
})
it('keeps a report with its outcome, its task id as replyTo and the reason of a failure', () => {
  const r = { ...base, kind: 'report', replyTo: TASK_ID, outcome: 'failed', reason: 'Claude Code exited' }
  expect(checkMailRecord(r)).toEqual(r)
  expect(checkMailRecord({ ...r, outcome: 'finished' })).toEqual({ ...base, kind: 'report', replyTo: TASK_ID, outcome: 'finished' })
})
it('refuses a report without an outcome or a replyTo, and an unknown kind', () => {
  expect(checkMailRecord({ ...base, kind: 'report', replyTo: TASK_ID })).toBeNull()
  expect(checkMailRecord({ ...base, kind: 'report', outcome: 'finished', replyTo: null })).toBeNull()
  expect(checkMailRecord({ ...base, kind: 'poll' })).toBeNull()
})
it('refuses a project or a reason over 200 characters or with a control character', () => {
  expect(checkMailRecord({ ...base, kind: 'task', project: 'x'.repeat(201) })).toBeNull()
  expect(checkMailRecord({ ...base, kind: 'attach', project: 'a\nb' })).toBeNull()
  expect(checkMailRecord({ ...base, kind: 'report', replyTo: TASK_ID, outcome: 'stopped', reason: 'x'.repeat(201) })).toBeNull()
})
```

`tests/unit/wake-text.test.ts` (new tests; `from`, `to`, `record`, `known` as in the file):
```ts
it('a task reads as the user\'s instruction through their coordinator', () => {
  expect(wakeText([record({ kind: 'task', project: 'acme', text: 'Fix the parser.' })], known)).toBe([
    'Task from your coordinator, through ClaudeTerm: the user\'s instruction, given through their acme coordinator.',
    'from: acme-dashboard · MacBook [c5df49] (folder /Users/sam/acme-dashboard, branch main)',
    `id: ${ID_1}  (do it; when it is done, end your turn: ClaudeTerm sends your last answer to the coordinator as your report)`,
    '',
    '> Fix the parser.'
  ].join('\n'))
  expect(wakeText([record({ kind: 'task', text: 'x' })], known).split('\n')[0]).toBe('Task from your coordinator, through ClaudeTerm: the user\'s instruction, given through their coordinator.')
})
it('a report names its outcome and the task it answers', () => {
  const head = (over: Partial<MailRecord>): string[] => wakeText([record({ kind: 'report', replyTo: ID_2, text: 'Parser fixed.', ...over })], known).split('\n')
  expect(head({ outcome: 'finished' })[0]).toBe('Report from a session attached to you, through ClaudeTerm: its task finished.')
  expect(head({ outcome: 'failed', reason: 'Claude Code exited' })[0]).toBe('Report from a session attached to you, through ClaudeTerm: its task failed: Claude Code exited.')
  expect(head({ outcome: 'stopped', reason: 'its turn was interrupted' })[0]).toBe('Report from a session attached to you, through ClaudeTerm: its task was stopped by the user: its turn was interrupted.')
  expect(head({ outcome: 'finished' })[2]).toBe(`id: ${ID_1}  (the report on task ${ID_2}; read_session "c5df49" shows the session)`)
  expect(head({ outcome: 'finished' })[4]).toBe('> Parser fixed.')
})
```

`tests/unit/mail-hub.test.ts` (new `describe('MailHub record kinds')`, using the file's `setup()` and `record()`):
- `attach and detach records count for no unread mark and show in no conversation` — add an unread `attach` and `detach` between `CALLER` and `LOCAL`: `unreadByTab` is `{}`, `conversations(null)` is `[]`.
- `a message view carries its kind, outcome and reason` — a `report` record `{ outcome: 'failed', reason: 'Claude Code exited', replyTo: <id> }` shows as `{ kind: 'report', outcome: 'failed', reason: 'Claude Code exited' }`; a plain one as `{ kind: 'message', outcome: null, reason: null }`.
- `a watcher is never handed an attach or detach record` — an undelivered `attach` to the watcher's session: the held wait does not resolve after `await new Promise((r) => setImmediate(r))`, and the record stays `delivered: false`.

`tests/integration/mail-store.int.test.ts`:
- `a signal between two ends of one device is not shareable; a task between two devices is` — `isShareable({...r, kind: 'attach', from: {...A, device: DEV}, to: {...B, device: DEV}})` is `false`; `digest()` leaves it out; a `task` from `DEV` to `DEV_B` is shareable.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/mail-record.test.ts tests/unit/wake-text.test.ts tests/unit/mail-hub.test.ts tests/integration/mail-store.int.test.ts`
Expected: FAIL (the new fields are dropped; the new blocks do not exist).

- [ ] **Step 3: Implement** the types and rules in the Interfaces block. The task block's first line, from line and id line, the report block's lines, are exactly those the tests assert; both keep today's `where` (folder, branch) on the from line and the quoted text after a blank line.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit/mail-record.test.ts tests/unit/wake-text.test.ts tests/unit/mail-hub.test.ts tests/integration/mail-store.int.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/shared/mail.ts src/main/mail/mail-record.ts src/main/mail/mail-store.ts src/main/mail/wake-text.ts src/main/mail/mail-hub.ts tests/unit/mail-record.test.ts tests/unit/wake-text.test.ts tests/unit/mail-hub.test.ts tests/integration/mail-store.int.test.ts
git commit -m "feat: mail records carry a kind: task, report, attach, detach"
```

---

### Task 2: MailHub hand-over controls

**Files:**
- Modify: `src/main/mail/mail-hub.ts` (deps :31-48, `TabTurns` :61-70, `takeMailTurn` :197-209, `userTurn` :212-218, `offer` :331-350, `handOver` :357-368)
- Test: `tests/unit/mail-hub.test.ts`

**Interfaces:**
- Consumes: Task 1 (`isSignal`).
- Produces (`src/main/mail/mail-hub.ts`):
  ```ts
  /** how mail reaches a tab: an idle one is woken; a busy one takes it into its running turn; "next": the watcher came in
   *  the turn that ends now (the Stop race), its wake starts the next turn; "prompt": ClaudeTerm writes it as a prompt */
  export type HandOver = 'idle' | 'running' | 'next' | 'prompt'
  // MailHubDeps gets:
  accepts?(r: MailRecord, tabId: string, into: HandOver): boolean   // absent: true for every record that is not a signal
  handedOver?(tabId: string, taken: MailRecord[], into: HandOver): void
  // MailHub gets:
  hasWatcher(tabId: string): boolean          // a wait of the tab is held now
  busy(tabId: string): boolean                // the tab's turn state says a turn runs (false for an unknown tab)
  interrupted(tabId: string): void            // Esc or Ctrl+C ended the running turn: the tab is not busy
  canTakeForPrompt(tabId: string, session: string): boolean
  takeForPrompt(tabId: string, session: string): { info: string; taken: MailRecord[] } | null
  ```
- `offer(w)` computes `into` before `handOver` changes the turn state: `idle` when `!t.busy || deps.working?.(tabId) === false`, else `next` when `w.seq === t.seq`, else `running`. A record is taken when today's checks pass, it is not a signal, and `accepts?.(r, w.tabId, into) ?? true`. After the records are marked delivered, `handedOver?.(w.tabId, taken, into)` is called.
- `takeForPrompt`: `null` when mail is off, when `deps.localTab(current(session)) !== tabId`, or when nothing is taken. Otherwise it takes, as `offer` would with `into = 'prompt'`, the oldest records that fit in `WAKE_MAX`, marks them delivered, sets the tab's `promptMail` flag, calls `handedOver(tabId, taken, 'prompt')`, and returns `{ info, taken }`. `canTakeForPrompt` answers whether `takeForPrompt` would take anything, and takes nothing.
- `TabTurns` gets `promptMail: boolean`. `userTurn`: when `promptMail` is set, it is cleared and the turn counts as one mail turn (`mailTurns = 1`); otherwise as today. `takeMailTurn` clears `promptMail`.

- [ ] **Step 1: Write the failing tests** (`describe('MailHub hand-over rules')` in `tests/unit/mail-hub.test.ts`; `accepts` and `handedOver` are added to the deps the file's `setup()` builds, through an optional argument):
- `accepts sees "idle" for an idle tab, "running" for a busy tab whose watcher came before the turn, "next" for a watcher that came in the turn` — record the `into` values: wait on an idle tab → `['idle']`; `userTurn`, then mail → `['running']` for the earlier watcher; a watcher that arrives after `userTurn` while `working` is true → `['next']`.
- `a record accepts refuses stays undelivered, and tabsChanged hands it over once accepts allows it` — `accepts` returns a flag the test flips; after the flip and `tabsChanged()` the wait resolves with the record's text.
- `handedOver gets the taken records and how they went` — `expect(handed).toEqual([{ tabId: 'tab-2', ids: [r.id], into: 'idle' }])`.
- `hasWatcher is true while a wait is held and false once it is answered or aborted`.
- `busy is true from a hand-over to an idle tab until the next done, and false after interrupted`.
- `takeForPrompt returns the wake text of what accepts allows as "prompt", marks it delivered, and the next user turn is a mail turn` — `` expect(hub.takeForPrompt('tab-2', SES_LOCAL)).toEqual({ info: expect.stringContaining(`> ${r.text}`), taken: [expect.objectContaining({ id: r.id })] }) ``; `store.get(r.id)!.delivered` is `true`; after `userTurn` the next `takeMailTurn` is `true`.
- `takeForPrompt and canTakeForPrompt give nothing when mail is off, nothing waits, or the tab does not run the session` — both `null` / `false`; nothing marked.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/mail-hub.test.ts`
Expected: FAIL (`hasWatcher`, `takeForPrompt` … are not functions).

- [ ] **Step 3: Implement** the members in the Interfaces block. `offer` keeps today's order of `handOver`, `finish`, `mark`, then calls `handedOver`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/mail-hub.test.ts && npm run typecheck`
Expected: PASS, the existing MailHub tests included.

- [ ] **Step 5: Commit**
```bash
git add src/main/mail/mail-hub.ts tests/unit/mail-hub.test.ts
git commit -m "feat: MailHub asks before it hands mail over, and can hand it over as a prompt"
```

---

### Task 3: Turn facts — what the hooks tell, and what main keeps per tab

**Files:**
- Modify: `src/shared/protocol.ts` (`AttentionMessage` :71-85, attention parse :387-394)
- Modify: `src/hook/session-hook.ts` (`hookMessage` :43-96)
- Create: `src/main/tab-waits.ts`
- Modify: `src/main/review-hub.ts` (deps; every change of `t.dialogs`: :156, :225, :235, :244, :296, :311, :438)
- Modify: `src/main/auto-continue.ts` (class :86-214)
- Test: `tests/unit/protocol.test.ts`, `tests/unit/session-hook.test.ts`, `tests/unit/tab-waits.test.ts` (create), `tests/unit/review-hub.test.ts`, `tests/unit/auto-continue.test.ts`, `tests/integration/session-hook.int.test.ts`

**Interfaces:**
- Produces (`src/shared/protocol.ts`):
  ```ts
  /** the longest last answer a Stop passes, and the longest line of a pending permission or question, in characters */
  export const LAST_MESSAGE_MAX = 8000
  export const PROMPT_TEXT_MAX = 200
  /** text as one line: control characters and line separators become spaces, runs of spaces one, trimmed; longer than max: max - 1 code points and "…" */
  export function oneLineText(text: string, max: number): string
  /** the first max code points of text */
  export function cutText(text: string, max: number): string
  // AttentionMessage gets:
  /** permission or question: what waits for the user, as one line */
  prompt?: string
  /** done without error (Stop): Claude Code's last_assistant_message, at most LAST_MESSAGE_MAX characters */
  lastMessage?: string
  ```
  Parse: `prompt` is kept for `permission` / `question` when it is a string that is not blank after `oneLineText(…, PROMPT_TEXT_MAX)`; `lastMessage` only for `done` without `error`, when a string, through `cutText(…, LAST_MESSAGE_MAX)`.
- Produces (`src/hook/session-hook.ts`):
  ```ts
  /** "Allow <tool>: <detail>", the detail the first string of command, file_path, notebook_path, url, path, pattern, description; "Allow <tool>" without one; null without a tool name */
  export function permissionPrompt(tool: unknown, input: unknown): string | null
  /** the first question's text of an AskUserQuestion input, or null */
  export function questionPrompt(input: unknown): string | null
  ```
  Both through `oneLineText(…, PROMPT_TEXT_MAX)`. `hookMessage`: `PermissionRequest` (not `AskUserQuestion`) adds `prompt` when `permissionPrompt` gives one; `PreToolUse` `AskUserQuestion` adds `prompt` from `questionPrompt`; `Stop` adds `lastMessage: cutText(input.last_assistant_message, LAST_MESSAGE_MAX)` when it is a string; `StopFailure` passes none.
- Produces (`src/main/tab-waits.ts`):
  ```ts
  export interface TabPrompt { kind: 'permission' | 'question'; text: string | null; since: number }
  export interface TabLimit { resetsAt: number | null; since: number }
  export interface TabWaitsState { prompt: TabPrompt | null; limit: TabLimit | null }
  export interface TabWaitsDeps { now(): number; onChange(tabId: string): void }
  /** what a tab waits for the person for: an open permission or question dialog, a usage limit that stopped its turn */
  export class TabWaits {
    constructor(deps: TabWaitsDeps)
    dialogOpened(tabId: string, kind: 'permission' | 'question', text: string | null): void
    dialogsClosed(tabId: string): void
    limited(tabId: string, resetsAt: number | null): void
    turnStarted(tabId: string): void   // ends the limit stop
    removeTab(tabId: string): void
    get(tabId: string): TabWaitsState  // { prompt: null, limit: null } for an unknown tab
  }
  ```
  `onChange` is called once per call that changed the state.
- Produces (`src/main/review-hub.ts`): `ReviewHubDeps.onDialogsClosed?(tabId: string): void` — called once whenever a change leaves `t.dialogs` empty after it held at least one.
- Produces (`src/main/auto-continue.ts`): `AutoContinue.pending(tabId: string): boolean` — true while a continue is armed (`timer !== null`) or the tab waits for its limit (`limitAt !== null`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/session-hook.test.ts`:
```ts
it('Stop passes the last answer, cut to 8000 characters; StopFailure passes none', () => {
  expect(hookMessage({ session_id: SID, hook_event_name: 'Stop', last_assistant_message: 'Done.' }, TAB))
    .toEqual({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', lastMessage: 'Done.' })
  expect((hookMessage({ session_id: SID, hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(9000) }, TAB) as AttentionMessage).lastMessage).toHaveLength(8000)
  expect(hookMessage({ session_id: SID, hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error' }, TAB))
    .toEqual({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', error: 'server_error' })
})
it('a permission prompt names the tool and what it runs or touches', () => {
  const p = (tool_name: string, tool_input: object) => (hookMessage({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name, tool_input }, TAB) as AttentionMessage).prompt
  expect(p('Bash', { command: 'python tools/fetch_net.py --env prod' })).toBe('Allow Bash: python tools/fetch_net.py --env prod')
  expect(p('Edit', { file_path: '/w/a.ts' })).toBe('Allow Edit: /w/a.ts')
  expect(p('mcp__acme__deploy', {})).toBe('Allow mcp__acme__deploy')
})
it('a question is its first question, on one line of at most 200 characters', () => {
  const q = hookMessage({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which\nbranch?' }] } }, TAB)
  expect(q).toEqual({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question', prompt: 'Which branch?' })
  expect(questionPrompt({ questions: [{ question: 'y'.repeat(300) }] })).toBe(`${'y'.repeat(199)}…`)
})
```
`tests/unit/protocol.test.ts`:
- `attention keeps a prompt line on permission and question, cut to 200 on one line, and drops it on done`.
- `attention keeps lastMessage only on a done without error, cut to 8000 characters`.

`tests/unit/tab-waits.test.ts`:
- `a dialog opened shows its prompt until the dialogs close` — `get(T).prompt` is `{ kind: 'permission', text: 'Allow Bash: npm test', since: NOW }`, then `null` after `dialogsClosed(T)`.
- `a usage limit stays with its reset time until the next turn starts`.
- `onChange is called for each change and not for a call that changes nothing; removeTab forgets the tab`.

`tests/unit/review-hub.test.ts` (give `setup` an optional `onDialogsClosed` and pass it to the hub):
- `onDialogsClosed is called once when the last open dialog goes, not while a subagent's dialog is still open` — `dialogOpened(TAB, null)`, `dialogOpened(TAB, 'agent-1')`, `turnEnded(TAB)` → `[]`; `subagentStopped(TAB, 'agent-1')` → `[TAB]`.

`tests/unit/auto-continue.test.ts`:
- `pending is true while a continue or a limit wait is armed, false once it ran or was cancelled`.

`tests/integration/session-hook.int.test.ts`:
- `node bundle: Stop forwards the last answer and a permission request its line, and prints nothing` — Stop input with `last_assistant_message: 'Parser fixed.'` → `got` holds `{ …, reason: 'done', lastMessage: 'Parser fixed.' }`; `PermissionRequest` with `tool_name: 'Bash', tool_input: { command: 'npm test' }` → `{ …, reason: 'permission', prompt: 'Allow Bash: npm test' }`; `stdout` is `''` and `code` is `0` for both.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/session-hook.test.ts tests/unit/protocol.test.ts tests/unit/tab-waits.test.ts tests/unit/review-hub.test.ts tests/unit/auto-continue.test.ts tests/integration/session-hook.int.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block. In `ReviewHub`, route every place that deletes from or clears `t.dialogs` through one private helper that calls `onDialogsClosed` when the map went from non-empty to empty.

- [ ] **Step 4: Run the tests**

Run: the command of Step 2, then `npm run typecheck`
Expected: PASS, the existing tests of these files included (the existing StopFailure and Stop tests keep their exact expectations).

- [ ] **Step 5: Commit**
```bash
git add src/shared/protocol.ts src/hook/session-hook.ts src/main/tab-waits.ts src/main/review-hub.ts src/main/auto-continue.ts tests/unit/session-hook.test.ts tests/unit/protocol.test.ts tests/unit/tab-waits.test.ts tests/unit/review-hub.test.ts tests/unit/auto-continue.test.ts tests/integration/session-hook.int.test.ts
git commit -m "feat: the hooks pass a turn's last answer and the line of a pending prompt; main keeps what a tab waits for"
```

---

### Task 4: Shared coordinator types, the store and the task machine

**Files:**
- Create: `src/shared/coordinator.ts`
- Create: `src/main/coordinator/coordinator-store.ts`
- Create: `src/main/coordinator/task-machine.ts`
- Test: `tests/unit/coordinator-shared.test.ts`, `tests/unit/coordinator-store.test.ts`, `tests/unit/task-machine.test.ts` (all create)

**Interfaces:**
- Consumes: Task 1 (`ReportOutcome`, `MailAddress`), Task 2 (`HandOver`).
- Produces (`src/shared/coordinator.ts`):
  ```ts
  export const COORD_TASK_MAX = 7000
  export const COORD_NAME_MAX = 100
  export const COORD_KEY_MAX = 200
  export type TaskState = 'queued' | 'delivered' | 'open'
  export type CoordGroup = 'waiting' | 'working' | 'idle' | 'resolved'
  /** shown in a row's group: offline and attaching come with part 3 */
  export type CoordMarker = 'starting' | 'offline' | 'attaching' | null
  /** why a row waits for the person */
  export type CoordWhy = 'prompt' | 'limit' | 'failed' | null
  export interface CoordReport { id: string; outcome: ReportOutcome; reason: string | null; at: number }
  export interface CoordTaskInfo { id: string; state: TaskState; since: number }
  export interface CoordSessionRow {
    key: string                       // 'local:<session>', or 'start:<tabId>' while Starting…
    tabId: string | null              // the tab that runs it; null when none does
    device: string | null             // null: this device
    deviceName: string | null         // null: this device
    session: string | null            // null while Starting…
    ref: string | null
    name: string
    folder: string | null
    branch: string | null
    group: CoordGroup
    why: CoordWhy
    marker: CoordMarker
    line: string
    progress: { done: number; total: number } | null
    changedAt: number
    task: CoordTaskInfo | null
    lastReport: CoordReport | null
    attachedTo: string | null         // a Not attached row: the coordinator it is attached to elsewhere
  }
  export interface CoordinatorView {
    tabId: string
    session: string
    project: { key: string; name: string }
    problem: string | null
    sessions: CoordSessionRow[]
    notAttached: CoordSessionRow[]
    waiting: number                   // attached rows in 'waiting': the header's badge
  }
  export type CoordMark =
    | { role: 'coordinator'; project: string; sessions: number; waiting: number }
    | { role: 'attached'; project: string; coordinator: string; coordinatorTabId: string | null }
  export type CoordMarks = Record<string, CoordMark>
  export type CoordResult = { ok: true; info?: string } | { ok: false; error: string; replaces?: string }
  export interface CoordStartRequest { task: string; name: string | null; folder: string | null; worktree: string | null }
  export type CoordOp =
    | { op: 'list' }
    | { op: 'start'; task: string; name: string | null; folder: string | null; device: string | null; worktree: string | null }
    | { op: 'attach' | 'detach' | 'read' | 'resolve'; session: string }
    | { op: 'message'; session: string; text: string }
  export function isWorktreeName(v: unknown): v is string   // /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  /** why this device cannot coordinate now; null when it can. wakes: Claude Code is MAIL_MIN_CLAUDE or later */
  export function coordinatorProblem(mailOn: boolean, wakes: boolean, claude: string | null): string | null
  ```
  Exact texts: mail off → `Coordinating sessions needs agent messages, which are turned off in ClaudeTerm on this device. Turn them on in Settings, Agent messages.`; else not `wakes` → `` `Coordinating sessions needs Claude Code ${MAIL_MIN_CLAUDE} or later; this device runs ${claude ?? 'a version ClaudeTerm has not read yet'}.` ``.
- Produces (`src/main/coordinator/coordinator-store.ts`):
  ```ts
  export const MAX_TASKS_PER_SESSION = 20
  export interface StoredAttachment { device: string | null; session: string; name: string; attachedAt: number; resolved: boolean; failed: boolean; lastReport: CoordReport | null }
  export interface StoredCoordinator { session: string; project: { key: string; name: string }; since: number; attachments: StoredAttachment[] }
  export interface StoredTask { id: string; from: MailAddress; state: TaskState; queuedAt: number; deliveredAt: number | null }
  /** a session of this device attached to a coordinator: whom it takes tasks from, and its tasks */
  export interface StoredHosted { session: string; coordinator: MailAddress; project: string; tasks: StoredTask[] }
  export interface CoordinatorData { coordinators: StoredCoordinator[]; hosted: StoredHosted[] }
  export interface CoordinatorStoreOptions { debounceMs?: number; onError?(message: string): void; warn?(message: string): void }
  export function parseCoordinators(text: string): CoordinatorData | null
  export class CoordinatorStore {
    readonly path: string                                   // <dir>/coordinators.json
    constructor(dir: string, opts?: CoordinatorStoreOptions)
    coordinators(): StoredCoordinator[]                     // copies, here and below
    coordinator(session: string): StoredCoordinator | null
    coordinatorOf(projectKey: string): StoredCoordinator | null
    hosted(session: string): StoredHosted | null
    allHosted(): StoredHosted[]
    putCoordinator(c: StoredCoordinator): void              // stores a copy, saves debounced
    removeCoordinator(session: string): void
    putHosted(h: StoredHosted): void
    removeHosted(session: string): void
    /** a tab's conversation took a new id: every place it is named on this device follows (see Step 3) */
    renameSession(from: string, to: string): boolean        // true when anything changed
    flush(): void
  }
  ```
- Produces (`src/main/coordinator/task-machine.ts`):
  ```ts
  export type TaskEvent =
    | { kind: 'handed'; into: HandOver; at: number }
    | { kind: 'turn' }
    | { kind: 'rest' }
    | { kind: 'failed'; reason: string }
    | { kind: 'stopped'; reason: string }
  export type TaskStep = { task: StoredTask } | { outcome: ReportOutcome; reason: string | null }
  /** the task after the event, its outcome, or null when the event does not apply in its state */
  export function stepTask(t: StoredTask, e: TaskEvent): TaskStep | null
  /** the delivered or open task of a session, else null */
  export function currentTask(h: StoredHosted): StoredTask | null
  /** the oldest queued task, when no task of the session is delivered or open; else null */
  export function nextTask(h: StoredHosted): StoredTask | null
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/task-machine.test.ts` — the whole table:
```ts
const q: StoredTask = { id: ID, from: COORD, state: 'queued', queuedAt: 1, deliveredAt: null }
it('a queued task handed to a watcher is open; one written as a prompt is delivered', () => {
  expect(stepTask(q, { kind: 'handed', into: 'idle', at: 5 })).toEqual({ task: { ...q, state: 'open', deliveredAt: 5 } })
  expect(stepTask(q, { kind: 'handed', into: 'prompt', at: 5 })).toEqual({ task: { ...q, state: 'delivered', deliveredAt: 5 } })
})
it('a delivered task opens with its turn; turn, rest and stop do not apply to a queued one', () => {
  const d = { ...q, state: 'delivered' as const, deliveredAt: 5 }
  expect(stepTask(d, { kind: 'turn' })).toEqual({ task: { ...d, state: 'open' } })
  for (const e of [{ kind: 'turn' }, { kind: 'rest' }, { kind: 'stopped', reason: 'its turn was interrupted' }] as TaskEvent[]) expect(stepTask(q, e)).toBeNull()
})
it('rest finishes, failed fails in any state, stopped stops a delivered or open task', () => {
  const o = { ...q, state: 'open' as const, deliveredAt: 5 }
  expect(stepTask(o, { kind: 'rest' })).toEqual({ outcome: 'finished', reason: null })
  expect(stepTask(q, { kind: 'failed', reason: 'its tab was closed' })).toEqual({ outcome: 'failed', reason: 'its tab was closed' })
  expect(stepTask(o, { kind: 'stopped', reason: 'its turn was interrupted' })).toEqual({ outcome: 'stopped', reason: 'its turn was interrupted' })
  expect(stepTask(o, { kind: 'handed', into: 'idle', at: 9 })).toBeNull()
})
it('nextTask is the oldest queued task while none is delivered or open', ...)
```
`tests/unit/coordinator-store.test.ts` (each test in its own `mkdtempSync(join(tmpdir(), 'ct-coord-'))`):
- `a coordinator, its attachments and a hosted session with its tasks are on disk after flush and come back` — `new CoordinatorStore(dir)` reads back equal data; the file is `{ "version": 1, "coordinators": [...], "hosted": [...] }`.
- `coordinatorOf finds the coordinator of a project key`.
- `renameSession moves the coordinator's own id, the attachments and the hosted entry of this device, a hosted coordinator address and the tasks it gave` — before: coordinator `A` attached `S`, hosted `S` with coordinator `A` and a task from `A`; `renameSession(S, S2)` then `renameSession(A, A2)`: coordinator `A2` attached `S2`, hosted `S2` with coordinator session `A2` and the task's `from.session` `A2`; an attachment of another device with the same session id is left as it is.
- `entries that do not check are skipped and the rest kept` — a bad session id, a task with state `'done'`, a project key with `\0`, a name with a newline.
- `a file that is not coordinators is moved aside and the store opens empty` — the folder then holds a file starting with `coordinators.json.corrupt-`, and `warn` got `Coordinators could not be read; the file was kept as <name>`.
`tests/unit/coordinator-shared.test.ts`:
- `coordinatorProblem names the setting when mail is off, the version when Claude Code is too old, and nothing otherwise` — exact texts above; `coordinatorProblem(true, true, '2.1.300')` is `null`.
- `isWorktreeName takes a plain name and refuses a path, a dash first, a space and 65 characters`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/task-machine.test.ts tests/unit/coordinator-store.test.ts tests/unit/coordinator-shared.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement.** The store follows `TaskListStore` (`src/main/task-list-store.ts`): load in the constructor, a file that is not a JSON object with `version: 1` moved aside, debounced `flush` through a `.tmp` file and a rename. Checks on load: sessions, task ids and `replyTo`s are UUIDs (`isUuid`); devices `null` or UUIDs; project keys pass `isProjectKey` (`src/shared/note.ts`); names 1–200 characters without control characters; times finite and ≥ 0; states in `TaskState`; a `lastReport` with a known outcome; bounds 50 coordinators, 200 attachments each, 500 hosted sessions, `MAX_TASKS_PER_SESSION` tasks each (the rest skipped). `renameSession(from, to)` changes: a coordinator whose `session` is `from`; every attachment with `device: null` and `session: from`; the hosted entry `from`; every hosted `coordinator` with `device: null` and `session: from`; every task `from` with `device: null` and `session: from`.

- [ ] **Step 4: Run the tests**

Run: the command of Step 2, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/shared/coordinator.ts src/main/coordinator/coordinator-store.ts src/main/coordinator/task-machine.ts tests/unit/coordinator-shared.test.ts tests/unit/coordinator-store.test.ts tests/unit/task-machine.test.ts
git commit -m "feat: the coordinator store and the task state machine"
```

---

### Task 5: Rows, answers and report texts

**Files:**
- Create: `src/main/coordinator/session-state.ts`
- Create: `src/main/coordinator/session-text.ts`
- Create: `src/main/coordinator/report-text.ts`
- Test: `tests/unit/coordinator-rows.test.ts`, `tests/unit/coordinator-text.test.ts`, `tests/unit/report-text.test.ts` (all create)

**Interfaces:**
- Consumes: Task 3 (`TabPrompt`, `TabLimit`), Task 4 (shared types), `PlanStatus` (`src/shared/types.ts`), `TaskList`, `describeTaskList` (`src/shared/task-list.ts`), `replaceControls` (`src/main/mail/agent-directory.ts`).
- Produces (`session-state.ts`):
  ```ts
  export interface RowFacts {
    marker: CoordMarker; closed: boolean; exited: boolean; working: boolean
    prompt: TabPrompt | null; limit: TabLimit | null; progress: PlanStatus | null
    task: CoordTaskInfo | null; resolved: boolean; failed: boolean; lastReport: CoordReport | null
  }
  export const GROUP_LABELS: Record<CoordGroup, string> = { waiting: 'Waiting on you', working: 'Working', idle: 'Idle', resolved: 'Resolved' }
  export function rowState(f: RowFacts, clock: (ms: number) => string): { group: CoordGroup; why: CoordWhy; line: string; progress: { done: number; total: number } | null }
  /** a row by its key, then its name (case-insensitive), then its ref; "[ref]" is taken as the ref */
  export function findRow(rows: CoordSessionRow[], target: string): { row: CoordSessionRow } | { error: string }
  ```
  `rowState` rules, in order. `why`: `prompt` → `'prompt'`; else `limit` → `'limit'`; else `failed` → `'failed'`; else `null`. `group`: `why !== null` → `'waiting'`; else `marker === 'starting' || working || task !== null` → `'working'`; else `resolved` → `'resolved'`; else `'idle'`. `line` — the first that applies:
  1. `marker === 'starting'` → `Starting…`
  2. `prompt` → `prompt.text`, else `Waiting for your permission` / `Waiting for your answer`
  3. `limit` → `Usage limit`, or `` `Usage limit · resets ${clock(resetsAt)}` `` when known
  4. `failed` → `` `Failed: ${lastReport?.reason ?? 'no reason given'}` ``
  5. `closed` → `Tab closed`
  6. `exited` → `Claude Code exited`
  7. `progress` not finished → `` `${done}/${total}` `` + `` ` · ${title}` `` of its first `current` task, else its first `left` task, when there is one
  8. `task` → `Task waiting until the session is idle` when queued, else `Working on its task`
  9. `working` → `Working`
  10. `lastReport` → `Finished · report ready` / `Stopped by you` / `Failed` by its outcome
  11. `Idle`

  `progress` is `{ done, total }` while the list is not finished, else `null`. `findRow` errors: none → `` `No session "${target}" here; call list_sessions.` ``; several → `` `"${target}" matches more than one session: ${names joined by ", "}; use the full name.` ``.
- Produces (`session-text.ts`):
  ```ts
  export function listText(v: CoordinatorView, clock: (ms: number) => string): string
  export function readText(row: CoordSessionRow, d: { prompt: TabPrompt | null; report: string | null; taskList: TaskList | null }, clock: (ms: number) => string): string
  ```
  `listText` lines: `` `${project} coordinator · ${n} attached` ``; the problem, when there is one; `No sessions are attached. Attach one with attach_session, or start one with start_session.` when `sessions` is empty; else one section per group with rows, in the order waiting, working, idle, resolved: `` `${GROUP_LABELS[g]} (${count}):` `` and a row line per session; `Not attached (this project):` and its rows when there are any; `Notes:` with `- Reports come to you by themselves when a task ends; there is no need to poll or wait.`, then `` `- A permission prompt or question waits for the user in ${names}: it is theirs to answer there; tell them once where it waits.` `` when rows have `why === 'prompt'`, `- A usage limit is not a failure: the session goes on after the reset.` when one has `why === 'limit'`, `- A stopped task was stopped by the user.` when one's `lastReport.outcome` is `stopped`. A row line: `` `- ${name}${ref ? ` [${ref}]` : ''} · ${line}` `` then, each when present, `` ` · ${folder}` ``, `` ` · ${branch}` ``, `` ` · task ${task.state} since ${clock(task.since)}` ``, `` ` · last report ${outcome} ${clock(at)}` ``, `` ` · attached to ${attachedTo}` ``; names, folders and branches through `replaceControls`.
  `readText` lines: `` `${name}${ref ? ` [${ref}]` : ''}` ``; `` `State: ${GROUP_LABELS[group]} · ${line}` ``; `` `Folder: ${folder}` `` (+ `` ` · Branch: ${branch}` ``) when the folder is known; with a prompt, `` `Waiting for the user: ${text ?? 'a permission prompt' | 'a question'}. It is the user's to answer in that session.` ``; `` `Open task: ${state} since ${clock(since)} (id ${id})` `` or `No open task.`; with a list, `` `Task list: ${describeTaskList(list)}` ``; with a report, `` `Last report: ${outcome}${reason ? `: ${reason}` : ''} ${clock(at)}` `` and on the next line its text, or `(The report is no longer kept.)` when `d.report` is null; without one, `No report yet.`
- Produces (`report-text.ts`):
  ```ts
  export const REPORT_TEXT_MAX = 6000
  export const NO_ANSWER = '(The session ended its turn without an answer text.)'
  export const CUT_NOTE = '[Cut: the answer is longer than ClaudeTerm passes on; the full answer is in the session.]'
  export const REASONS = {
    interrupted: 'its turn was interrupted', clear: 'the session was cleared', exit: 'Claude Code exited', closed: 'its tab was closed',
    error: (error: string) => `Claude Code stopped the turn on an error (${error})`
  }
  export function reportText(o: { outcome: ReportOutcome; reason: string | null; lastMessage: string | null; previous: string | null }): string
  ```
  `reportText`: `body` = the trimmed last answer, or none when it is empty. `finished` → `body ?? NO_ANSWER`. `failed` → `` `The task failed: ${reason}.` ``, `stopped` → `` `The task was stopped by the user: ${reason}.` ``, each followed by `\n\nIts last answer:\n\n${body}` when there is a body. With `previous`, `` `(This task was given by the previous coordinator, ${previous}.)\n\n` `` comes first. When the text is longer than `REPORT_TEXT_MAX` code points it is cut to that many and `` `\n\n${CUT_NOTE}` `` follows.

- [ ] **Step 1: Write the failing tests**

`tests/unit/coordinator-rows.test.ts` — one `it` per rule, with `const idle: RowFacts` (all false / null) and `clock = (ms) => new Date(ms).toISOString().slice(11, 16)`:
```ts
it('a pending prompt waits on you with its line, before a limit or a failure', () => {
  expect(rowState({ ...idle, prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: 0 }, limit: { resetsAt: null, since: 0 } }, clock))
    .toEqual({ group: 'waiting', why: 'prompt', line: 'Allow Bash: npm test', progress: null })
  expect(rowState({ ...idle, prompt: { kind: 'question', text: null, since: 0 } }, clock).line).toBe('Waiting for your answer')
})
it('a usage limit says when it resets', () => {
  expect(rowState({ ...idle, limit: { resetsAt: Date.UTC(2026, 10, 14, 22, 0), since: 0 } }, clock)).toMatchObject({ group: 'waiting', why: 'limit', line: 'Usage limit · resets 22:00' })
})
it('a failed task waits on you with its reason until it is cleared', ...)        // line 'Failed: Claude Code exited'
it('task list progress shows done/total and the current task while the list is open', () => {
  expect(rowState({ ...idle, working: true, progress: { title: 'Triage', done: 3, total: 7, finished: false, tasks: [{ n: 4, title: 'Grouping crashes by call stack', state: 'current' }] } }, clock))
    .toEqual({ group: 'working', why: null, line: '3/7 · Grouping crashes by call stack', progress: { done: 3, total: 7 } })
})
it('an open task is Working even when no turn runs', ...)                        // group 'working', 'Working on its task'
it('a finished report idles with "Finished · report ready"; resolved goes to Resolved', ...)
it('Starting…, Tab closed and Claude Code exited are their own lines', ...)
it('findRow finds by key, name, ref and [ref], and names the ambiguous ones', ...)
```
`tests/unit/coordinator-text.test.ts`:
- `listText groups the attached rows, lists the project's others, and adds the notes that apply` — a view with one waiting row (`why: 'prompt'`), one working row with a task and a stopped last report, one not attached row; compare with the full expected text, built line by line from the rules above.
- `listText with nothing attached says how to attach or start one, and shows the problem`.
- `readText shows the prompt as the user's, the open task, the task list and the last report in full`.
`tests/unit/report-text.test.ts`:
- `a finished report is the last answer, or says there was none`.
- `a failed or stopped report says why and keeps the last answer`.
- `a task of the previous coordinator says so first`.
- `a report over 6000 characters is cut with the note` — `reportText({ outcome: 'finished', reason: null, lastMessage: 'a'.repeat(7000), previous: null })` is `` `${'a'.repeat(6000)}\n\n${CUT_NOTE}` ``; a text of 6000 is kept whole.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/coordinator-rows.test.ts tests/unit/coordinator-text.test.ts tests/unit/report-text.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** the three modules as the Interfaces block says.

- [ ] **Step 4: Run the tests**

Run: the command of Step 2, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/session-state.ts src/main/coordinator/session-text.ts src/main/coordinator/report-text.ts tests/unit/coordinator-rows.test.ts tests/unit/coordinator-text.test.ts tests/unit/report-text.test.ts
git commit -m "feat: a coordinator's rows, its answers and the text of a report"
```

---

### Task 6: CoordinatorHub — roles, attachments, tasks given, views

**Files:**
- Create: `src/main/coordinator/coordinator-hub.ts`
- Test: `tests/unit/coordinator-hub.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 (`MailRecord`, `isSignal`, `kindOf`), Task 2 (`HandOver`), Task 3 (`TabWaitsState`), Task 4 (store, machine, shared types, `coordinatorProblem` is computed by the caller), Task 5 (`rowState`, `findRow`, `listText`, `readText`), `Agent`, `resolveAgent`, `refOf` (`src/main/mail/agent-directory.ts`), `checkMailRecord`, `MailStore`.
- Produces:
  ```ts
  export interface HubTab {
    tabId: string; session: string | null; account: string | null; folder: string; exited: boolean
    working: boolean                                    // TabInfo.activity === 'working'
    view: TabView | null
    project: { key: string; name: string } | null       // TabPlace.project; null outside git or not known yet
    branch: string | null
  }
  export interface CoordinatorHubDeps {
    store: CoordinatorStore
    mail: MailStore
    self(): string | null                               // this device's id; null on a device never paired
    selfName(): string
    problem(): string | null                            // coordinatorProblem(...) now
    tabs(): HubTab[]                                    // this device's Claude tabs
    agents(): Agent[]                                   // agentsNow(): names and refs of every agent
    waits(tabId: string): TabWaitsState
    progress(tabId: string): PlanStatus | null          // TaskListHub.status
    taskList(tabId: string): TaskList | null            // TaskListHub.get
    restingNow(tabId: string): boolean                  // Task 7
    isDirectory(path: string): Promise<boolean>         // Task 8
    accountLabel(account: string | null): string        // Task 8
    openTab(req: OpenTabRequest): string | null         // Task 8: the new tab's id, opened behind the tab in front
    recheckMail(): void                                 // MailHub.tabsChanged
    poke(tabId: string): void                           // PromptDelivery.poke
    changed(): void                                     // views and marks may have changed
    clock(ms: number): string                           // HH:MM
    now(): number
    later(ms: number, fn: () => void): () => void       // a timer; the function cancels it
    newId(): string
    log: Pick<Logger, 'info' | 'warn'>
  }
  export const HUB_TEXT: { /* every answer below, exact */ }
  export class CoordinatorHub {
    constructor(d: CoordinatorHubDeps)                  // subscribes to d.mail.onChange
    isCoordinator(tabId: string): boolean
    make(tabId: string, replace: boolean): CoordResult
    stop(tabId: string): CoordResult
    tool(tabId: string, op: CoordOp): Promise<PipeResponse>   // the pipe's entry; 'start' is Task 8
    list(tabId: string): PipeResponse
    read(tabId: string, target: string): PipeResponse
    attach(tabId: string, target: string): PipeResponse
    attachTab(tabId: string, sessionTabId: string): PipeResponse
    detach(tabId: string, target: string): PipeResponse
    message(tabId: string, target: string, text: string): PipeResponse
    resolve(tabId: string, target: string): PipeResponse
    accepts(r: MailRecord, tabId: string, into: HandOver): boolean
    tabSession(tabId: string, session: string | null): void   // a tab of this device opened or changed
    sessionStarted(tabId: string, before: string | null, after: string, source: string): void
    tabClosed(tabId: string): void                       // closed on purpose (never called while quitting)
    view(tabId: string): CoordinatorView | null
    marks(): CoordMarks
    dispose(): void
  }
  ```
  Private helpers later tasks use: `address(device: string | null, session: string): MailAddress` (device `null` → `self()`; name from `agents()`, else the stored name, else `` `session ${refOf(session)}` ``); `norm(device: string | null): string | null` (this device → `null`); `write(r: Omit<MailRecord, 'v' | 'id' | 'sentAt' | 'delivered' | 'read'> & { delivered?: boolean; read?: boolean }): string | null` (adds `v: 1`, `newId()`, `now()`, flags `false` unless given, runs `checkMailRecord`, `mail.add`, returns the id); `tabOfSession(session: string): HubTab | null`; `sessionOfTab(tabId: string): string | null` (the last session `tabSession` saw for the tab, also after it closed).
  `HUB_TEXT` (exact):
  ```ts
  notCoordinator: "This tab is not a coordinator. The person makes a Claude tab the coordinator of its project from the tab's context menu: Make project coordinator.",
  notClaude: 'Only a Claude tab with a session can coordinate.',
  noProject: 'Only a tab in a git project can coordinate.',
  made: (project) => `This tab is now the coordinator of ${project}.`,
  already: (project) => `This tab is already the coordinator of ${project}.`,
  taken: (project, name) => `The ${project} project already has a coordinator: ${name}.`,
  replaced: (project, old, n) => `This tab is now the coordinator of ${project}; ${n} session${n === 1 ? '' : 's'} moved from ${old}.`,
  stopped: (project, n) => `Stopped coordinating ${project}; ${n} session${n === 1 ? '' : 's'} detached.`,
  self: 'A coordinator cannot attach itself.',
  remote: (name) => `${name} runs on another device; sessions on other devices cannot be attached yet.`,
  isCoordinator: (name) => `${name} is a coordinator itself.`,
  elsewhere: (name, project, coordinator) => `${name} is attached to the ${project} coordinator (${coordinator}); it must be detached there first.`,
  alreadyAttached: (name) => `${name} is already attached.`,
  attached: (name, ref) => `Attached ${name} [${ref}]. It is not told and goes on as it is; give it a task with message_session.`,
  detached: (name, dropped) => (dropped ? `Detached ${name}; its open task was dropped.` : `Detached ${name}.`),
  noText: 'A task needs a text.',
  tooLong: `A task is at most ${COORD_TASK_MAX} characters.`,
  tooMany: (name) => `${name} holds ${MAX_TASKS_PER_SESSION} tasks already; wait for its reports.`,
  starting: (name) => `${name} is still starting; its first task is already waiting.`,
  queued: (name, ref) => `Task given to ${name} [${ref}]. It reaches the session when the session is idle, as the user's instruction through you; its report comes to you by itself when its turn on it ends.`,
  resolved: (name) => `Marked ${name} resolved.`,
  attachText: (project) => `Attached to the ${project} coordinator.`,
  detachText: (project) => `Detached from the ${project} coordinator.`
  ```
- Behaviour (what the tests pin):
  - Every tool op but `make`/`stop` starts with: the tab's session is a coordinator, else `{ ok: false, error: HUB_TEXT.notCoordinator }`. `attach`, `message` (and Task 8's `start`) then refuse with `d.problem()` when it is not null; `list`, `read`, `detach`, `resolve` do not.
  - `make`: a local Claude tab with a session (`notClaude`), with a project (`noProject`); already the coordinator → `{ ok: true, info: already }`; the project has another coordinator and `!replace` → `{ ok: false, error: taken(project, name), replaces: name }`. A tab whose session is attached somewhere is detached from it first. With `replace`, the new coordinator takes the old one's attachments (without itself) and every hosted entry of the old one gets the new `coordinator` address; their tasks keep their `from`; an `attach` record goes to each moved session; the old coordinator is removed → `{ ok: true, info: replaced(...) }`; else `{ ok: true, info: made(project) }`.
  - `stop` and `tabClosed` of a coordinator's tab: every attachment is detached as `detach` does, the coordinator removed → `stopped(...)`.
  - `attach`: the target through `resolveAgent(target, agents(), [])` (its errors are answered as they are); refusals in this order: the coordinator itself (`self`), another device's agent (`norm(agent.device) !== null`, as `agentsNow` gives this device's agents `selfDeviceId || null`: `remote`), a coordinator (`isCoordinator`), attached to this one (`{ ok: true, info: alreadyAttached }`), hosted elsewhere (`elsewhere(name, hosted.project, hosted.coordinator.name)`). Then: an attachment `{ device: null, session, name, attachedAt: now, resolved: false, failed: false, lastReport: null }`, a hosted entry `{ session, coordinator: address(null, K), project, tasks: [] }`, an `attach` record (`delivered: true, read: true`, text `attachText(project)`, `project`) → `attached(name, refOf(session))`. Nothing else is written: no task, no message. `attachTab` does the same for the session a tab of this device runs.
  - `detach`: `findRow` among the attached rows; the hosted entry removed (its tasks dropped, no report), the attachment removed, a `detach` record (`delivered: true, read: true`) → `detached(name, hadTask)`.
  - `message`: blank → `noText`; over `COORD_TASK_MAX` → `tooLong`; `findRow` among attached rows; a Starting… row → `starting(name)`; `MAX_TASKS_PER_SESSION` tasks held → `tooMany`; then a `task` record from `address(null, K)` to `address(null, S)` with `project`, and `resolved` / `failed` of the attachment cleared → `queued(name, ref)`.
  - `list` → `{ ok: true, info: listText(view(tabId), clock) }`. `read`: `findRow` among the attached and the not attached rows → `{ ok: true, info: readText(row, { prompt: row.tabId ? waits(row.tabId).prompt : null, report: row.lastReport ? mail.get(row.lastReport.id)?.text ?? null : null, taskList: row.tabId ? taskList(row.tabId) : null }, clock) }`. `resolve`: `findRow` among attached rows; the attachment's `resolved` set, `failed` cleared → `resolved(name)`. A `findRow` error answers `{ ok: false, error }`.
  - The mail listener: a `task` record to a session of this device, not delivered, unknown to its hosted entry, whose `from` is the hosted `coordinator` (same `norm(device)` and session), with fewer than `MAX_TASKS_PER_SESSION` tasks, becomes a task `{ id: r.id, from, state: 'queued', queuedAt: r.sentAt, deliveredAt: null }`; then `recheckMail()`, `poke(<its tab>)`, `changed()`. Any other `task` record is not taken.
  - `accepts`: a signal → false; `task` → `into` is `idle` or `prompt`, the record's task is held by the tab's session in state `queued`, and `nextTask(hosted)?.id === r.id`; `report` with `outcome === 'stopped'` → `into === 'running'`; anything else → true.
  - `tabSession` remembers each tab's session; when it changes from one id to another it remembers the old one for `sessionStarted`. `sessionStarted(tabId, before, after, source)`: for `source` `clear`, `compact` or `resume`, the old id (`before` when it differs from `after`, else the one `tabSession` remembered for that change) is renamed to `after` with `store.renameSession`; nothing for `startup` or the same id.
  - `view(tabId)`: null unless the tab's session is a coordinator. `sessions`: one row per attachment (key `local:<session>`, `tabId` of the tab that runs it or null, `device`/`deviceName` null, `ref`, `name` from `agents()` else the stored one, `folder`/`branch` from the tab, facts → `rowState` with `closed` = no tab runs it, `task` = `currentTask ?? nextTask` of its hosted entry as `{ id, state, since: deliveredAt ?? queuedAt }`); `notAttached`: the agents of this device whose tab is in the coordinator's project, other than the coordinator and its attached sessions, `attachedTo` the hosted coordinator's name when attached elsewhere; `changedAt`: `now()` when the row's `group` + `line` differ from the last view's for that key, else the last `changedAt`; `waiting`: attached rows in `waiting`.
  - `marks()`: each coordinator's tab → `{ role: 'coordinator', project, sessions: <rows>, waiting }`; each tab of a hosted session → `{ role: 'attached', project: hosted.project, coordinator: hosted.coordinator.name, coordinatorTabId }`.

- [ ] **Step 1: Write the failing tests** — `tests/unit/coordinator-hub.test.ts` starts with the world every hub test (here and in Tasks 7 and 8) builds on:
```ts
const NOW = 1_700_000_000_000
const ACME = { key: 'd:\\work\\acme', name: 'acme' }
const BETA = { key: 'd:\\work\\beta', name: 'beta' }
const S = {
  coord: 'c0000000-0000-4000-8000-000000000001', one: 'a1000000-0000-4000-8000-000000000002',
  two: 'b2000000-0000-4000-8000-000000000003', beta: 'be000000-0000-4000-8000-000000000004'
}
const TITLES: Record<string, string> = { 'tab-c': 'coord', 'tab-1': 'parser', 'tab-2': 'docs', 'tab-b': 'beta' }
const tab = (tabId: string, session: string | null, project: { key: string; name: string } | null, over: Partial<HubTab> = {}): HubTab =>
  ({ tabId, session, account: null, folder: 'D:\\Work\\acme', exited: false, working: false, view: 'terminal', project, branch: 'main', ...over })

function world(o: { problem?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-coord-'))
  let ids = 0
  const w = {
    now: NOW,
    tabs: [tab('tab-c', S.coord, ACME), tab('tab-1', S.one, ACME), tab('tab-2', S.two, ACME), tab('tab-b', S.beta, BETA, { folder: 'D:\\Work\\beta' })],
    waits: {} as Record<string, TabWaitsState>, progress: {} as Record<string, PlanStatus | null>, resting: {} as Record<string, boolean>,
    /** agents of other devices, listed with this device's */
    remote: [] as AgentTab[],
    dirs: new Set(['D:\\Work\\acme']), opened: [] as OpenTabRequest[], pokes: [] as string[], rechecks: 0,
    timers: [] as { ms: number; fn: () => void; cancelled: boolean }[],
    problem: o.problem ?? null,
    store: new CoordinatorStore(dir, { debounceMs: 100_000 }),
    mail: MailStore.open({ dir, now: () => NOW, debounceMs: 100_000 }),
    hub: null as unknown as CoordinatorHub
  }
  w.hub = new CoordinatorHub({
    store: w.store, mail: w.mail, self: () => null, selfName: () => 'Desktop', problem: () => w.problem,
    tabs: () => w.tabs,
    agents: () => nameAgents([...w.tabs.filter((t) => !t.exited && t.session !== null).map((t) => ({ device: null, deviceName: 'Desktop', tabId: t.tabId, session: t.session!, customTitle: TITLES[t.tabId] ?? null, folder: t.folder, branch: t.branch, title: null, busy: t.working, wakes: true, claude: '2.1.300' })), ...w.remote]),
    waits: (id) => w.waits[id] ?? { prompt: null, limit: null }, progress: (id) => w.progress[id] ?? null, taskList: () => null,
    restingNow: (id) => w.resting[id] ?? true, isDirectory: async (p) => w.dirs.has(p),
    accountLabel: (a) => (a === null ? 'Main account' : `Account ${a}`),
    openTab: (req) => { w.opened.push(req); return `new-tab-${w.opened.length}` },
    recheckMail: () => { w.rechecks++ }, poke: (id) => { w.pokes.push(id) }, changed: () => {},
    clock: (ms) => new Date(ms).toISOString().slice(11, 16), now: () => w.now,
    later: (ms, fn) => { const t = { ms, fn, cancelled: false }; w.timers.push(t); return () => { t.cancelled = true } },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    log: { info: () => {}, warn: () => {} }
  })
  for (const t of w.tabs) w.hub.tabSession(t.tabId, t.session)
  return w
}
/** runs the timers armed so far that are not cancelled */
const fire = (w: ReturnType<typeof world>): void => { for (const t of w.timers.splice(0)) if (!t.cancelled) t.fn() }
const records = (w: ReturnType<typeof world>, kind: MailRecord['kind']) => w.mail.all().filter((r) => r.kind === kind)
```
Names in this world: `coord · Desktop` [`c00000`], `parser · Desktop` [`a10000`], `docs · Desktop` [`b20000`], `beta · Desktop` [`be0000`]. The tests (`describe` blocks `roles`, `attach and detach`, `tasks given`, `views`):
```ts
it('make: a Claude tab with a session in a git project becomes the coordinator of its project, under its session id', () => {
  const w = world()
  expect(w.hub.make('tab-c', false)).toEqual({ ok: true, info: 'This tab is now the coordinator of acme.' })
  expect(w.store.coordinator(S.coord)).toMatchObject({ session: S.coord, project: ACME, attachments: [] })
  expect(w.hub.make('tab-c', false)).toEqual({ ok: true, info: 'This tab is already the coordinator of acme.' })
})
it('make: a tab without a session or without a project is refused with its reason', ...)   // HUB_TEXT.notClaude, HUB_TEXT.noProject
it('make: a second tab of the project is refused with the first one\'s name until it replaces it; its sessions and their tasks move', () => {
  const w = world(); w.hub.make('tab-c', false); w.hub.attach('tab-c', 'a10000'); w.hub.message('tab-c', 'a10000', 'Fix the parser.')
  expect(w.hub.make('tab-2', false)).toEqual({ ok: false, error: 'The acme project already has a coordinator: coord · Desktop.', replaces: 'coord · Desktop' })
  expect(w.hub.make('tab-2', true)).toEqual({ ok: true, info: 'This tab is now the coordinator of acme; 1 session moved from coord · Desktop.' })
  expect(w.store.coordinator(S.coord)).toBeNull()
  expect(w.store.hosted(S.one)).toMatchObject({ coordinator: { session: S.two }, tasks: [{ state: 'queued', from: { session: S.coord } }] })
})
it('make: an attached session that becomes a coordinator is detached first', ...)
it('stop detaches every session, drops their tasks and writes a detach record each; the tab is no longer a coordinator', ...)
it('tabClosed of the coordinator\'s tab stops it', ...)
it('a new session id from clear, compact or resume moves the role, the attachments and the hosted entry; startup does not', ...)
it('the chat view\'s new id that came before the hook still moves them: the hook\'s before is the new id', () => {
  // tabSession('tab-c', NEW) first, then sessionStarted('tab-c', NEW, NEW, 'clear'): the coordinator is now NEW
})
it('attach by ref or name attaches a session of this or another project; only an attach record is written', () => {
  const w = world(); w.hub.make('tab-c', false)
  expect(w.hub.attach('tab-c', '[a10000]')).toEqual({ ok: true, info: 'Attached parser · Desktop [a10000]. It is not told and goes on as it is; give it a task with message_session.' })
  expect(w.hub.attach('tab-c', 'beta · Desktop')).toMatchObject({ ok: true })
  expect(w.mail.all().map((r) => [r.kind, r.delivered, r.read])).toEqual([['attach', true, true], ['attach', true, true]])
  expect(w.hub.marks()['tab-1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Desktop', coordinatorTabId: 'tab-c' })
})
it('attach refuses the coordinator itself, a coordinator, a session attached elsewhere naming its coordinator, and another device\'s session', ...)
// another device's session: w.remote.push({ device: 'd0000000-0000-4000-8000-0000000000aa', deviceName: 'Laptop', tabId: 'remote-1', session: 'f5000000-0000-4000-8000-000000000006', customTitle: 'crash triage', folder: '/home/sam/acme', branch: 'main', title: null, busy: false, wakes: true, claude: '2.1.300' })
// then attach('tab-c', 'crash triage · Laptop') → { ok: false, error: 'crash triage · Laptop runs on another device; sessions on other devices cannot be attached yet.' }
it('attach and message are refused with the problem; list still answers and shows it', ...)
it('detach drops the session\'s tasks without a report and writes a detach record', ...)
it('message writes a task record from the coordinator to the session, which holds it as queued; resolved and failed are cleared', () => {
  const w = world(); w.hub.make('tab-c', false); w.hub.attach('tab-c', 'a10000'); w.hub.resolve('tab-c', 'a10000')
  expect(w.hub.message('tab-c', 'a10000', 'Fix the parser.')).toEqual({ ok: true, info: expect.stringMatching(/^Task given to parser · Desktop \[a10000\]\./) })
  const [t] = records(w, 'task')
  expect(t).toMatchObject({ from: { session: S.coord, name: 'coord · Desktop' }, to: { session: S.one }, text: 'Fix the parser.', project: 'acme', delivered: false })
  expect(w.store.hosted(S.one)!.tasks).toEqual([{ id: t.id, from: { device: null, session: S.coord, name: 'coord · Desktop' }, state: 'queued', queuedAt: NOW, deliveredAt: null }])
  expect(w.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ resolved: false, failed: false })
  expect(w.rechecks).toBeGreaterThan(0); expect(w.pokes).toContain('tab-1')
})
it('message refuses an empty text, 7001 characters, a session not attached, and a 21st task', ...)
it('a task record from anyone but the session\'s coordinator is not taken', ...)
it('accepts a task only into an idle hand-over or a prompt, only the oldest queued one, and none while one is delivered or open', ...)
it('accepts a stopped report only into a running turn, and other reports and messages into any', ...)
it('view lists the attached sessions with their group and line, and the project\'s other sessions as not attached', ...)
it('changedAt moves only when a row\'s group or line changes', ...)
it('list and read answer with listText and readText; a tab that is not a coordinator gets notCoordinator', ...)
it('resolve marks an attached session resolved', ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/coordinator-hub.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `CoordinatorHub` as the Interfaces block says. `tool()` dispatches `list`, `read`, `attach`, `detach`, `message`, `resolve`; any other op answers `{ ok: false, error: 'unknown operation' }` until Task 8 adds `start`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/coordinator-hub.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/coordinator-hub.ts tests/unit/coordinator-hub.test.ts
git commit -m "feat: CoordinatorHub makes coordinators, attaches sessions and gives them tasks"
```

---

### Task 7: CoordinatorHub — the task's lifecycle and its report

**Files:**
- Modify: `src/main/coordinator/coordinator-hub.ts`
- Test: `tests/unit/coordinator-hub.test.ts`

**Interfaces:**
- Consumes: Task 6 (the class, its deps and private helpers, `world()` and `fire()`), Task 4 (`stepTask`, `currentTask`, `nextTask`), Task 5 (`reportText`, `REASONS`), `LIMIT_ERROR` (`src/main/auto-continue.ts`).
- Produces (`CoordinatorHub`):
  ```ts
  /** a Stop that comes to rest ends the task this long after it, unless a turn starts meanwhile */
  export const REST_SETTLE_MS = 2000
  handedOver(tabId: string, taken: MailRecord[], into: HandOver): void
  turnStarted(tabId: string): void
  turnEnded(tabId: string, end: { background: boolean; lastMessage: string | null }): void
  /** continued: AutoContinue.failed answered true (a cut it continues) */
  turnFailed(tabId: string, error: string, continued: boolean): void
  /** the person ended the running turn: Esc or Ctrl+C typed, the chat's stop, or (with `at`, its transcript time) the
   *  transcript's "[Request interrupted by user" entry, which a denied permission prompt writes too, and no Stop follows */
  interrupted(tabId: string, at?: number): void
  exited(tabId: string): void                       // the tab's process exited
  ```
- Behaviour:
  - The hub keeps, in memory, the tabs in a turn (`inTurn`), one settle timer per tab, and the last answer per task id.
  - `handedOver`: each `task` record taken → `stepTask(…, { kind: 'handed', into, at: now() })`, stored; when `into !== 'prompt'` the tab is in a turn. `changed()`.
  - `turnStarted`: cancels the tab's settle timer; the tab is in a turn; its `delivered` task → `open`. When the tab is a coordinator → `recheckMail()` (a held watcher may now take a stopped report into this turn).
  - `turnEnded`: the tab is out of its turn; with a `currentTask`, a non-null `lastMessage` is kept as its last answer; without `background`, a settle timer `later(REST_SETTLE_MS, …)` → when it fires, the task is still current, the tab is not in a turn and `restingNow(tabId)` → outcome `finished`. Always: `recheckMail()`, `poke(tabId)`.
  - `turnFailed`: out of its turn, settle cancelled; `error === LIMIT_ERROR` or `continued` → no outcome; else the current task → `failed` with `REASONS.error(error)`. Then `poke(tabId)`.
  - `interrupted`: nothing unless the tab is in a turn, and, with `at`, unless `at` is not older than the current task's `deliveredAt` (the feed reads old entries when it starts); then out of its turn, settle cancelled, the current task → `stopped` with `REASONS.interrupted`; `poke(tabId)`.
  - `exited`: out of its turn, settle cancelled; the current task → `failed` with `REASONS.exit`; queued tasks stay.
  - `tabClosed` (added to Task 6's): every task of the tab's session, oldest first → `failed` with `REASONS.closed`; the attachment stays (its row says `Tab closed`).
  - `sessionStarted` with `source === 'clear'` (added to Task 6's): after the rename, the current task of the new id → `stopped` with `REASONS.clear`.
  - An outcome writes a `report` record: from `address(null, S)` to the hosted `coordinator` (device `null` → `self()`), `replyTo` the task id, `outcome`, `reason` when not null, text `reportText({ outcome, reason, lastMessage: <its last answer>, previous: <task.from.name when task.from is not the hosted coordinator> })`; the task leaves the hosted entry; then `recheckMail()`, `poke(<session's tab>)`, `changed()`. A session no longer hosted reports nothing.
  - The mail listener also takes a `report` record to a coordinator of this device: the attachment of its `from` (`norm(device)`, session) gets `lastReport = { id, outcome, reason ?? null, at: sentAt }` and `failed = outcome === 'failed'`, unless it holds this report or a newer one already; then `poke(<coordinator's tab>)`, `changed()`.

- [ ] **Step 1: Write the failing tests** (`describe('CoordinatorHub task lifecycle')`, each from `world()`, `make('tab-c')`, `attach('tab-c', 'a10000')`, `message('tab-c', 'a10000', 'Fix the parser.')`, with `task = records(w, 'task')[0]`):
```ts
it('a task handed to a watcher is open; one written as a prompt is delivered until its turn starts', () => {
  w.hub.handedOver('tab-1', [task], 'prompt')
  expect(w.store.hosted(S.one)!.tasks[0]).toMatchObject({ state: 'delivered', deliveredAt: NOW })
  w.hub.turnStarted('tab-1')
  expect(w.store.hosted(S.one)!.tasks[0].state).toBe('open')
})
it('a Stop with nothing after it finishes the task 2 s later: the report is the last answer, to the coordinator, on the task', () => {
  w.hub.handedOver('tab-1', [task], 'idle')
  w.hub.turnEnded('tab-1', { background: false, lastMessage: 'Parser fixed; 12 tests pass.' })
  expect(w.timers.map((t) => t.ms)).toEqual([2000]); expect(records(w, 'report')).toEqual([])
  fire(w)
  expect(records(w, 'report')).toEqual([expect.objectContaining({ from: expect.objectContaining({ session: S.one, name: 'parser · Desktop' }), to: expect.objectContaining({ session: S.coord }), replyTo: task.id, outcome: 'finished', text: 'Parser fixed; 12 tests pass.' })])
  expect(w.store.hosted(S.one)!.tasks).toEqual([])
  expect(w.store.coordinator(S.coord)!.attachments[0].lastReport).toMatchObject({ outcome: 'finished', reason: null })
})
it('a turn that starts within the settle keeps the task open; the report is the answer of the Stop after it', ...)
it('a Stop with background work keeps the task open; the next Stop without it ends it', ...)
it('a Stop while the tab is not resting does not end the task', ...)                 // w.resting['tab-1'] = false
it('a failed turn ClaudeTerm does not continue fails the task; a usage limit and a continued cut do not end it', () => {
  // turnFailed('tab-1', 'rate_limit', false) → no report; turnFailed('tab-1', 'server_error', true) → no report;
  // turnFailed('tab-1', 'invalid_request', false) → outcome 'failed', reason 'Claude Code stopped the turn on an error (invalid_request)'
})
it('Esc in the task\'s turn stops it, also in a turn a watcher started; Esc outside a turn does nothing', ...)
it('an interrupt read from the transcript stops the task only when it is not older than the task\'s delivery', ...)   // interrupted('tab-1', NOW - 1) → no report; interrupted('tab-1', NOW + 5) → stopped, reason 'its turn was interrupted'
it('the process exiting fails the open task and keeps the queued ones; closing the tab fails every task', ...)
it('a clear stops the open task, and the report comes from the new session id', ...)
it('a task the previous coordinator gave reports to the new one with a note', ...)   // text starts '(This task was given by the previous coordinator, coord · Desktop.)'
it('a failed report marks the attachment failed until the next task or resolve', ...)
it('after an outcome the hub rechecks the mail and pokes the session\'s tab', ...)
it('a session detached before its outcome reports nothing', ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/coordinator-hub.test.ts`
Expected: FAIL (`handedOver` … are not functions).

- [ ] **Step 3: Implement** the Behaviour list.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/coordinator-hub.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/coordinator-hub.ts tests/unit/coordinator-hub.test.ts
git commit -m "feat: a task ends at the session's rest, on a failure or on the person's stop, and reports to its coordinator"
```

---

### Task 8: CoordinatorHub — new sessions (`start_session`)

**Files:**
- Modify: `src/main/coordinator/coordinator-hub.ts`
- Test: `tests/unit/coordinator-hub.test.ts`

**Interfaces:**
- Consumes: Task 6, Task 7.
- Produces:
  ```ts
  /** how long start_session waits for the new tab's session id before it answers without one */
  export const START_WAIT_MS = 20_000
  export const worktreeInstruction = (name: string): string =>
    `First enter a new git worktree named "${name}" with your EnterWorktree tool, and do the task below there.\n\n`
  // CoordinatorHub gets:
  start(tabId: string, req: CoordStartRequest & { device: string | null }): Promise<PipeResponse>
  // HUB_TEXT gets:
  otherDevice: 'Sessions on other devices cannot be started yet; leave device out.',
  noFolder: (folder) => `No folder ${folder} on this device.`,
  notOpened: 'The new tab could not be opened.',
  closedEarly: 'The new tab closed before its session started.',
  started: (name, ref, folder, account) => `Started ${name} [${ref}] in ${folder} on ${account}, attached to you. Its task is its first message; its report comes to you by itself when the task ends.`,
  opening: (name, folder, account) => `Opening ${name} in ${folder} on ${account}. It shows as Starting… until its session starts; its task is sent then.`
  ```
- Behaviour: the coordinator check, then the problem, then the task text (`noText`, `tooLong`); `device` other than `null` or this device's name (case-insensitive) → `otherDevice`; the folder is `req.folder ?? <coordinator tab's folder>` and must pass `isDirectory` → `noFolder`; `openTab({ kind: 'claude', cwd: folder, account: <coordinator tab's account>, title: req.name })` (no view: the setting's; no permission mode: Claude Code's own) → `null` → `notOpened`. A pending start `{ tabId, coordinator: K, text: (worktree ? worktreeInstruction(worktree) : '') + task, startedAt }` is kept in memory and shown in `view()` as a row with key `start:<tabId>`, `marker: 'starting'`, `session: null`, `ref: null`, the requested name or the folder's last part. When `tabSession` gives the tab its first session id, the session is attached as `attach` does and the task record is written as `message` does, and the answer resolves `started(...)`; when `START_WAIT_MS` passes first, the answer resolves `opening(...)` and the pending start goes on; when the tab closes first, the pending start is dropped and the answer, if still open, resolves `{ ok: false, error: closedEarly }`. `tool()` dispatches `start`.

- [ ] **Step 1: Write the failing tests** (`describe('CoordinatorHub start')`):
```ts
it('start opens a Claude tab in the coordinator\'s folder, on its account, behind, named as asked', async () => {
  const w = world(); w.tabs[0] = { ...w.tabs[0], account: 'acc-1' }; w.hub.make('tab-c', false)
  const answer = w.hub.start('tab-c', { task: 'Write the release notes.', name: 'Release notes', folder: null, device: null, worktree: null })
  await new Promise((r) => setImmediate(r))   // the folder check is async
  expect(w.opened).toEqual([{ kind: 'claude', cwd: 'D:\\Work\\acme', account: 'acc-1', title: 'Release notes' }])
  expect(w.hub.view('tab-c')!.sessions).toEqual([expect.objectContaining({ key: 'start:new-tab-1', marker: 'starting', line: 'Starting…', group: 'working' })])
  w.tabs.push(tab('new-tab-1', null, ACME)); w.hub.tabSession('new-tab-1', null)
  w.tabs[4] = { ...w.tabs[4], session: S_NEW }; w.hub.tabSession('new-tab-1', S_NEW)
  expect(await answer).toEqual({ ok: true, info: `Started Release notes · Desktop [${refOf(S_NEW)}] in D:\\Work\\acme on Account acc-1, attached to you. Its task is its first message; its report comes to you by itself when the task ends.` })
  expect(records(w, 'task')).toEqual([expect.objectContaining({ to: expect.objectContaining({ session: S_NEW }), text: 'Write the release notes.' })])
})
it('a worktree name puts the EnterWorktree instruction before the task', ...)   // text === worktreeInstruction('notes') + 'Write the release notes.'
it('without a session within 20 s it answers that the session is starting, and a later session is still attached and tasked', ...)
it('a folder that is not a directory and another device are refused, and nothing opens', ...)
it('a pending start whose tab closes is dropped, and the answer says so', ...)
```
(`TITLES['new-tab-1'] = 'Release notes'` is set in the first test so that its agent name is `Release notes · Desktop`; `S_NEW = 'd4000000-0000-4000-8000-000000000005'`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/coordinator-hub.test.ts`
Expected: FAIL (`start` is not a function).

- [ ] **Step 3: Implement** the Behaviour paragraph.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/coordinator-hub.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/coordinator-hub.ts tests/unit/coordinator-hub.test.ts
git commit -m "feat: a coordinator starts a new session with its task"
```

---

### Task 9: PromptDelivery — a task or a report when no watcher waits

**Files:**
- Create: `src/main/coordinator/prompt-delivery.ts`
- Test: `tests/unit/prompt-delivery.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 (`MailHub.canTakeForPrompt`, `takeForPrompt` — through deps), `PromptState` (`src/shared/ipc.ts`), `ENTER_DELAY_MS` (`src/main/auto-continue.ts`), `TabView`.
- Produces:
  ```ts
  export interface PromptDeliveryDeps {
    session(tabId: string): string | null            // the session the tab runs; null: none, or exited
    idle(tabId: string): boolean                     // no turn, no continue armed (see Task 11)
    hasWatcher(tabId: string): boolean
    canTake(tabId: string, session: string): boolean
    take(tabId: string, session: string): { info: string } | null
    promptState(tabId: string): Promise<PromptState>
    view(tabId: string): TabView | null
    write(tabId: string, data: string): void         // writeToClaude
    delayMs: number                                  // CONTINUE_DELAY_MS in the app
    enterDelayMs?: number                            // ENTER_DELAY_MS when not given
    later?(ms: number, fn: () => void): () => void   // setTimeout when not given
    log: Pick<Logger, 'info'>
  }
  export const bracketedPaste = (text: string): string => `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`
  export class PromptDelivery {
    constructor(d: PromptDeliveryDeps)
    poke(tabId: string): void      // arms one try delayMs later; a poke while one is armed changes nothing
    forget(tabId: string): void    // cancels the armed try
    dispose(): void
  }
  ```
- A try: `session` null, not `idle`, a watcher held, or nothing `canTake` → nothing. Else `await promptState`; unless it is `'empty'`, log and stop. Then check `session`, `idle`, `hasWatcher` and `canTake` again (the tab may have changed while the window answered), `take`, and write: a `chat` tab gets `write(tabId, info)`; a terminal tab `write(tabId, bracketedPaste(info))`, then `write(tabId, '\r')` `enterDelayMs` later.

- [ ] **Step 1: Write the failing tests** (`later` collects timers as in Task 6's `world()`):
- `an idle chat tab with no watcher gets the wake text as one message after the delay` — `writes` is `[['tab-1', 'WAKE']]`.
- `a terminal tab gets it as a bracketed paste and Enter 50 ms later` — `writes` is `[['tab-1', '\x1b[200~line one\rline two\x1b[201~'], ['tab-1', '\r']]` for `info` `'line one\nline two'`, the second after the 50 ms timer.
- `nothing is written when a watcher waits, the tab works, or nothing waits`.
- `a prompt that is not empty is left alone` — `'draft'` and `'none'` write nothing and take nothing.
- `a tab that starts working while the window answers is not written into`.
- `pokes during the delay arm one try; forget cancels it`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/prompt-delivery.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `PromptDelivery`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/prompt-delivery.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/prompt-delivery.ts tests/unit/prompt-delivery.test.ts
git commit -m "feat: a task or a report is written as a prompt when no mail watcher waits"
```

---

### Task 10: The `coord` pipe message and the seven MCP tools

**Files:**
- Modify: `src/shared/protocol.ts` (new message, `PipeMessage` union :206-211, parse)
- Modify: `src/main/pipe-server.ts:2-26, 39-60`
- Create: `src/mcp/coordinator-tools.ts`
- Modify: `src/mcp/show-image-server.ts` (after `message_agent`, :198-224)
- Modify: `src/main/claude-tab-settings.ts:81`
- Test: `tests/unit/protocol.test.ts`, `tests/unit/coordinator-tools.test.ts` (create), `tests/unit/claude-tab-settings.test.ts:78-82`, `tests/integration/pipe.test.ts`, `tests/integration/mcp.int.test.ts`, `tests/integration/session-hook.int.test.ts:72-84` (the handler list)

**Interfaces:**
- Consumes: Task 4 (`CoordOp`, `COORD_TASK_MAX`, `COORD_NAME_MAX`, `isWorktreeName`).
- Produces (`src/shared/protocol.ts`):
  ```ts
  /** a coordinator tool of the MCP server: one operation of the tab's coordinator */
  export type CoordMessage = { v: 1; type: 'coord'; tabId: string } & CoordOp
  ```
  Parse: `tabId` a UUID; `op` one of the seven; `session` 1–`MAIL_TO_MAX` characters; `text` and `task` 1–`COORD_TASK_MAX`; `name` null/absent or 1–`COORD_NAME_MAX`; `folder` null/absent or an absolute path of at most `MAX_FOLDER` without `\0`; `device` null/absent or 1–200; `worktree` null/absent or `isWorktreeName`; absent optional fields become `null`. Errors name the field, as the other cases do (`` `text must be 1 to ${COORD_TASK_MAX} characters` ``).
- Produces (`src/main/pipe-server.ts`): `PipeHandlers.coord(msg: CoordMessage): Promise<PipeResponse>`; `case 'coord': return await h.coord(m)`.
- Produces (`src/mcp/coordinator-tools.ts`):
  ```ts
  export interface CoordToolDeps { tabId: string | null; pipeName: string; cwd: string; send(pipeName: string, msg: CoordMessage, timeoutMs: number): Promise<PipeResponse> }
  export const COORD_TOOL_NAMES = ['list_sessions', 'start_session', 'attach_session', 'detach_session', 'message_session', 'read_session', 'resolve_session'] as const
  export const COORD_TOOL_DESCRIPTIONS: Record<(typeof COORD_TOOL_NAMES)[number], string>
  export async function coordTool(name: (typeof COORD_TOOL_NAMES)[number], op: CoordOp, deps: CoordToolDeps): Promise<ToolResult>
  ```
  `coordTool`: no tab → `` `${name} works only in a ClaudeTerm Claude tab` ``; `start` resolves a relative `folder` against `deps.cwd`; `start` waits 30 000 ms for the pipe, the others 3000; `PipeUnavailableError` → `ClaudeTerm is not running.`; another error → `` `ClaudeTerm request failed: ${message}` ``; an answer → `{ text: info ?? 'Done.', isError: false }` or `{ text: error, isError: true }`.
  Descriptions (exact):
  - `list_sessions`: `Coordinator only: list the Claude sessions attached to this coordinator with their state, open task, last report and task list progress, then the sessions of the project that are not attached. Reports come to you by themselves when a task ends: do not poll. A permission prompt or a question waiting in a session is the user's to answer there: tell the user once where it waits, never answer it. A usage limit is not a failure. A stopped task was stopped by the user.`
  - `start_session`: `Coordinator only: open a new Claude session in ClaudeTerm and give it a task as its first message. It opens in this coordinator's folder unless folder is given, on this coordinator's account, in Claude Code's default permission mode. With worktree, the session first enters a new git worktree of that name with EnterWorktree; ClaudeTerm itself creates none. It is attached to you at once, and its report comes to you by itself when its task ends.`
  - `attach_session`: `Coordinator only: attach a running Claude session, by a ref or a name from list_sessions or list_agents. Attaching sends the session nothing and does not interrupt it; give it work with message_session. A session attached to another coordinator is refused.`
  - `detach_session`: `Coordinator only: detach a session from this coordinator. Its open task, if any, is dropped without a report; the session is not told and goes on as it is.`
  - `message_session`: `Coordinator only: give an attached session a task. It waits until the session is idle, then reaches it as the user's instruction given through you. When the session's turn on it ends, ClaudeTerm sends you its last answer as a report and wakes you: do not poll or wait for it.`
  - `read_session`: `Coordinator only: one session in detail: its state, a permission prompt or question waiting for the user, its open task, its last report in full and its task list.`
  - `resolve_session`: `Coordinator only: mark an attached session resolved: its work for you is done. A new task un-resolves it.`
  Input schemas (zod): `list_sessions` `{}`; `start_session` `{ task: z.string(), name: z.string().optional(), folder: z.string().optional(), device: z.string().optional(), worktree: z.string().optional() }`; `attach_session`, `detach_session`, `read_session`, `resolve_session` `{ session: z.string().describe('a ref or a name from list_sessions or list_agents') }`; `message_session` `{ session, text: z.string().describe('The task, at most 7000 characters') }`.
- `claude-tab-settings.ts:81`: the allow list gets the seven `mcp__claudeterm__<name>` after the four of today.

- [ ] **Step 1: Write the failing tests**
- `tests/unit/protocol.test.ts`: `coord parses each op and fills absent optional fields with null` (`{ v: 1, type: 'coord', tabId: TAB, op: 'start', task: 'x' }` → `name`, `folder`, `device`, `worktree` all `null`); `coord refuses a text over 7000 characters, a relative folder, a worktree with a slash and an unknown op`.
- `tests/unit/coordinator-tools.test.ts`: `each tool sends its op with the tab id and returns the info`; `start_session resolves a relative folder against the folder Claude runs in, and waits 30 s for the answer` — `sent[0]` is `{ v: 1, type: 'coord', tabId: TAB, op: 'start', task: 'T', name: null, folder: join(CWD, 'pkg'), device: null, worktree: null }` and the timeout `30000`; `without a tab, with ClaudeTerm gone, or refused, it says so` (the three texts above).
- `tests/unit/claude-tab-settings.test.ts:78`: the test becomes `permissions allow the claudeterm tools`, expecting the eleven names in that order.
- `tests/integration/pipe.test.ts`: `okHandlers` gets `coord: async () => ({ ok: true })`; new `routes coord to its handler` — `expect(await sendPipeMessage(pipe, { v: 1, type: 'coord', tabId: TAB, op: 'list' })).toEqual({ ok: true, info: 'listed' })`.
- `tests/integration/mcp.int.test.ts`: the handler list gets `coord`, recording messages; the expected tool list is `['add_to_note', 'attach_session', 'check_note_item', 'detach_session', 'device_status', 'get_task_list', 'list_agents', 'list_sessions', 'message_agent', 'message_session', 'open_device_settings', 'read_notes', 'read_session', 'resolve_session', 'set_task_list', 'show_diff', 'show_document', 'show_image', 'start_session']`; new `forwards message_session as a coord message` — the record is `{ v: 1, type: 'coord', tabId: TAB, op: 'message', session: 'a10000', text: 'Fix the parser.' }` and the tool's text the handler's info.
- `tests/integration/session-hook.int.test.ts`: the handler list of `listen()` gets `coord: async (m) => take(m)`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/protocol.test.ts tests/unit/coordinator-tools.test.ts tests/unit/claude-tab-settings.test.ts tests/integration/pipe.test.ts tests/integration/mcp.int.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block; register the seven tools in `show-image-server.ts` the way `message_agent` is registered (tab id from `CLAUDETERM_TAB_ID`, pipe from `CLAUDETERM_PIPE` or `defaultPipeName`, `cwd: process.cwd()`, `send: (pipe, msg, ms) => sendPipeMessage(pipe, msg, ms)`). `src/main/index.ts` must still compile: give its `startPipeServer` handlers `coord: async () => ({ ok: false, error: 'not wired yet' })` here; Task 11 replaces it.

- [ ] **Step 4: Run the tests**

Run: the command of Step 2, then `npx vitest run tests/integration/session-hook.int.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/shared/protocol.ts src/main/pipe-server.ts src/mcp/coordinator-tools.ts src/mcp/show-image-server.ts src/main/claude-tab-settings.ts src/main/index.ts tests/unit/protocol.test.ts tests/unit/coordinator-tools.test.ts tests/unit/claude-tab-settings.test.ts tests/integration/pipe.test.ts tests/integration/mcp.int.test.ts tests/integration/session-hook.int.test.ts
git commit -m "feat: the claudeterm MCP server gets the coordinator's seven tools"
```

---

### Task 11: Main wiring — the hub, its tools and the window's IPC

**Files:**
- Modify: `src/main/index.ts` — stores :326-336; status hub :616-636; places :817-827; `onTabClosed` :882-908; `events.opened` :973-982, `events.updated` :983-1004, `events.closed` :1005; `mailHub` deps :2176-2209; after `mailSync` :2219; pipe `session` handler :2230-2257; the `coord` handler of Task 10; IPC beside `IPC.mailRead` :2630; `before-quit` :3602-3620
- Modify: `src/shared/ipc.ts` (`IPC` :15-221, `CtApi`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc-guards.ts`
- Create: `tests/e2e/coordinator-helpers.ts`, `tests/e2e/coordinator.spec.ts`
- Test: `tests/unit/ipc-guards.test.ts`

**Interfaces:**
- Consumes: Tasks 2–10.
- Produces (`src/shared/ipc.ts`): `IPC.coordView 'coord:view'`, `coordMarks 'coord:marks'`, `coordMake 'coord:make'`, `coordStop 'coord:stop'`, `coordAttach 'coord:attach'`, `coordDetach 'coord:detach'`, `coordMessage 'coord:message'`, `coordResolve 'coord:resolve'`, `coordNewSession 'coord:new-session'`, `evCoordView 'ev:coord-view'`, `evCoordMarks 'ev:coord-marks'`; `CtApi`:
  ```ts
  coordView(tabId: string): Promise<CoordinatorView | null>
  coordMarks(): Promise<CoordMarks>
  coordMake(tabId: string, replace: boolean): Promise<CoordResult>
  coordStop(tabId: string): Promise<CoordResult>
  coordAttach(tabId: string, sessionTabId: string): Promise<CoordResult>
  coordDetach(tabId: string, key: string): Promise<CoordResult>
  coordMessage(tabId: string, key: string, text: string): Promise<CoordResult>
  coordResolve(tabId: string, key: string): Promise<CoordResult>
  coordNewSession(tabId: string, req: CoordStartRequest): Promise<CoordResult>
  onCoordView(cb: (tabId: string, view: CoordinatorView | null) => void): Unsubscribe
  onCoordMarks(cb: (marks: CoordMarks) => void): Unsubscribe
  ```
- Produces (`src/main/ipc-guards.ts`): `isCoordKey(v)` (1–`COORD_KEY_MAX` characters, no control character); `isCoordTaskText(v)` (a string, not blank, ≤ `COORD_TASK_MAX`); `isCoordStartRequest(v)` (`task` by `isCoordTaskText`; `name` null or 1–`COORD_NAME_MAX` on one line; `folder` null or `isAbsPath` and ≤ `MAX_PATH_TEXT`; `worktree` null or `isWorktreeName`). A request that fails its guard answers `{ ok: false, error: 'Invalid request' }`.
- Wiring in `index.ts` (variable names exact; `coordinator` is taken by `RestartCoordinator` at :1212):
  - `const coordinatorStore = new CoordinatorStore(dataDir, { onError: (m) => log.warn(m), warn: toast })` after `taskListStore`.
  - `const tabWaits = new TabWaits({ now: () => Date.now(), onChange: () => coordSoon.request() })` after `statusHub`.
  - After `mailSync`: `const promptDelivery = new PromptDelivery({...})` with `session` (a local Claude tab not exited → its `claudeSessionId`), `idle: (id) => claudeIdle(id) && !autoContinue.pending(id) && !resumeAfterRestore.has(id)`, `hasWatcher`/`canTake`/`take` from `mailHub`, `promptState` as `autoContinue`'s (`chatPromptState(...)`), `view`, `write: writeToClaude`, `delayMs: isTest && process.env.CLAUDETERM_TEST_PROMPT_DELAY_MS ? Number(process.env.CLAUDETERM_TEST_PROMPT_DELAY_MS) : CONTINUE_DELAY_MS`, `log`; where `const claudeIdle = (id: string): boolean => !tabs.isWorking(id) && !mailHub.busy(id) && (tabs.get(id)?.view !== 'chat' || chatHub.idle(id))`.
  - `const projectCoordinators = new CoordinatorHub({...})`: `tabs` from `tabs.list()` (Claude tabs; `working: t.activity === 'working'`; `project`/`branch` from `tabPlaces.get(t.id)`), `agents: agentsNow`, `self: () => selfDeviceId || null`, `selfName`, `problem: () => coordinatorProblem(settings.agentMessages.enabled, localWakes(), localVersion())`, `waits: (id) => tabWaits.get(id)`, `progress: (id) => taskLists.status(id)`, `taskList: (id) => taskLists.get(id)`, `restingNow: claudeIdle`, `isDirectory: isDirAsync`, `accountLabel`, `openTab: (req) => openTab(req, false)?.id ?? null`, `recheckMail: () => mailHub.tabsChanged()`, `poke: (id) => promptDelivery.poke(id)`, `changed: () => coordSoon.request()`, `clock: (ms) => new Date(ms).toTimeString().slice(0, 5)`, `now`, `later` (setTimeout / clearTimeout), `newId: randomUUID`, `log`.
  - `mailHub` deps: `accepts: (r, id, into) => projectCoordinators.accepts(r, id, into)`, `handedOver: (id, taken, into) => projectCoordinators.handedOver(id, taken, into)`.
  - `const coordSoon = new Coalescer(50, publishCoordinators)`: for each Claude tab whose `view()` is not null, send `IPC.evCoordView` `(tabId, view)` when its JSON differs from the last one sent; `(tabId, null)` once for a tab that had a view and has none now; `IPC.evCoordMarks` `(marks)` when the JSON differs. `coordSoon.request()` also from `taskLists`' `onChange`, the places `publish`, `events.updated` and `events.closed`.
  - `events.opened` and `events.updated`: `projectCoordinators.tabSession(t.id, t.claudeSessionId)` for a Claude tab.
  - `onTabClosed`: `if (!quitting) projectCoordinators.tabClosed(tabId)`.
  - The pipe `session` handler: `projectCoordinators.sessionStarted(msg.tabId, before, msg.sessionId, msg.source)` right before `mailTabsChanged()`.
  - The pipe `coord` handler: `coord: (msg) => projectCoordinators.tool(msg.tabId, msg)`.
  - IPC: `coordView`/`coordMarks` answer the hub; `coordMake(tabId, replace)` → `make`; `coordStop` → `stop`; `coordAttach(tabId, sessionTabId)` → `attachTab`; `coordDetach`/`coordMessage`/`coordResolve(tabId, key, …)` → `detach`/`message`/`resolve`; `coordNewSession(tabId, req)` → `start(tabId, { ...req, device: null })`. Every handler first checks `tabId` (and `sessionTabId`) with `isLocalClaudeTab` (:2806; define the coordinator handlers after it), `replace` with `typeof === 'boolean'`, and the rest with the new guards; `coordView` answers `null` and `coordMarks` `{}` when a check fails.
  - `before-quit`: `coordinatorStore.flush()` beside `taskListStore.flush()`; `promptDelivery.dispose()` and `projectCoordinators.dispose()` before `mailHub.close()`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/ipc-guards.test.ts`: `isCoordStartRequest takes a task with its optional fields and refuses a blank task, a relative folder and a bad worktree`; `isCoordKey refuses an empty key, 201 characters and a newline`.

`tests/e2e/coordinator-helpers.ts`:
```ts
/** the app with `count` Claude tabs in one git repository, each with a session, the mail watcher on */
export async function coordApp(count: number, o: { settings?: object; env?: Record<string, string>; repo?: string; transcripts?: boolean } = {}): Promise<Launched & { repo: string; tabs: string[]; sids: string[]; transcripts: string[] }>
/** a Claude tab of the running app in cwd, with a session */
export async function claudeTabIn(l: Launched, cwd: string): Promise<{ tabId: string; sid: string }>
/** a coordinator tool's pipe message from a tab, as the MCP server sends it */
export const coord = (pipeName: string, tabId: string, op: CoordOp): Promise<WaitAnswer> =>
  sendPipeMessage(pipeName, { v: 1, type: 'coord', tabId, ...op }, 30_000) as Promise<WaitAnswer>
/** Make project coordinator through the window, once git has given the tab its project */
export async function makeCoordinator(page: Page, tabId: string, replace = false): Promise<CoordResult>
export const turnOf = (pipeName: string, tabId: string, sessionId: string): Promise<unknown>
export const done = (pipeName: string, tabId: string, sessionId: string, extra: Partial<AttentionMessage> = {}): Promise<unknown>
export function within<T>(p: Promise<T>, ms: number): Promise<T>
/** passes when p has not settled within ms */
export async function stillWaiting(p: Promise<unknown>, ms: number): Promise<void>
```
`coordApp` launches `VERSION_SETTINGS` (or `o.settings`) with `args: ['--claude', repo]`, opens the other tabs with `window.ct.openTab({ kind: 'claude', cwd: repo })`, reports a session for each with `startSession` (with `transcripts`: a `session` message whose `transcriptPath` is an empty `<sid>.jsonl` it creates under `tmpdir()`, as accounts-launch.spec.ts reports one; these paths come back in `transcripts`, else `[]`), and waits for `hasMailWatcher` unless `agentMessages.enabled` is false. `makeCoordinator` repeats `window.ct.coordMake` while the answer is `HUB_TEXT.noProject`, up to 15 s.

`tests/e2e/coordinator.spec.ts` (each test closes its app in `finally`):
```ts
test('list_sessions in a tab that is not a coordinator says it is not one', async () => {
  const { app, pipeName, tabs } = await coordApp(1)
  try { expect(await coord(pipeName, tabs[0], { op: 'list' })).toEqual({ ok: false, error: HUB_TEXT.notCoordinator }) } finally { await app.close() }
})
test('a tab made coordinator through the window lists the project\'s other sessions as not attached', async () => {
  // makeCoordinator → { ok: true, info: `This tab is now the coordinator of ${basename(repo)}.` };
  // expect.poll(list info) toContain `[${refOf(sids[1])}]`; info contains 'Not attached (this project):' and 'No sessions are attached.'
})
test('a second coordinator of the project is refused with the first one\'s name; replacing moves its sessions', ...)
test('attach_session and detach_session change the marks; attaching sends the session nothing', async () => {
  // hold waitForMail(tab2); attach → ok; marks[tab2] toEqual { role: 'attached', project, coordinator: <name>, coordinatorTabId: tab1 };
  // marks[tab1].role 'coordinator'; await stillWaiting(held, 1500); detach → ok; marks[tab2] undefined
})
test('a session attached to another project\'s coordinator is refused with its coordinator\'s name', ...)
test('with agent messages off, attaching is refused with the requirement message, which the view shows too', async () => {
  // setSetting(page, 'agentMessages.enabled', false); attach → { ok: false, error: coordinatorProblem(false, true, '2.1.400') };
  // (await coordView(tab1)).problem is the same text
})
test('a task waits while its session works, also past the Stop race, and then reaches it as the user\'s instruction', async () => {
  // attach refOf(sids[1]);
  const w1 = waitForMail(pipeName, tabs[1], sids[1])          // the watcher of the last Stop, held while the next turn runs
  await turnOf(pipeName, tabs[1], sids[1])
  expect(await coord(pipeName, tabs[0], { op: 'message', session: refOf(sids[1]), text: 'Fix the parser.' })).toMatchObject({ ok: true })
  await stillWaiting(w1, 1500)                                // not into the running turn
  const w2 = waitForMail(pipeName, tabs[1], sids[1])          // the Stop's own watcher, before its done reaches main
  expect(await within(w1, 5000)).toEqual({ ok: true })        // replaced, without mail
  await stillWaiting(w2, 1000)                                // not into the turn that ends now
  await done(pipeName, tabs[1], sids[1])
  const got = await within(w2, 10_000)
  expect(got.info).toMatch(/^Task from your coordinator, through ClaudeTerm: the user's instruction, given through their .+ coordinator\./)
  expect(got.info).toContain('> Fix the parser.')
})
test('closing the coordinator\'s tab stops it: its session is no longer attached', ...)
test('the window\'s Message, Resolve and Detach act on a row of the view', async () => {
  // attach; key = view.sessions[0].key; coordResolve → group 'resolved'; coordMessage(key, 'Write the notes.') → group 'working', task.state 'queued';
  // coordDetach(key) → sessions []
})
test('the role and the attachments survive a quit and a restore', ...)   // close the window, launchApp({ dataDir }), click '.banner-restore', marks roles ['attached', 'coordinator'], list shows the ref
test('a clear in the coordinator\'s tab keeps its role under the new session id', ...)   // startSession-like message with source 'clear' and a new id; list still answers with the attached ref
test('start_session opens an attached tab, and its first task carries the worktree instruction', async () => {
  // answer = coord(tab1, { op: 'start', task: 'Write the release notes.', name: 'Release notes', folder: null, device: null, worktree: 'notes' }) (not awaited);
  // the new tab id appears; its title is 'Release notes'; startSession(newTab, sid); await answer → info starts 'Started Release notes · ' and contains `[${refOf(sid)}]`;
  // waitForMail(newTab, sid) → info contains worktreeInstruction('notes').trim() and '> Write the release notes.'
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/ipc-guards.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator.spec.ts`
Expected: FAIL (`window.ct.coordMake` is not a function; the pipe answers `not wired yet`).

- [ ] **Step 3: Implement** the wiring, the IPC, the preload methods and the guards.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm test && npm run build && node scripts/e2e.mjs coordinator.spec.ts agent-messages.spec.ts`
Expected: PASS (the agent-messages e2e still pass: plain mail is unchanged).

- [ ] **Step 5: Commit**
```bash
git add src/main/index.ts src/shared/ipc.ts src/preload/index.ts src/main/ipc-guards.ts tests/unit/ipc-guards.test.ts tests/e2e/coordinator-helpers.ts tests/e2e/coordinator.spec.ts
git commit -m "feat: coordinators, their tools and their views are wired into the app"
```

---

### Task 12: Main wiring — turn events, what tabs wait for, delivery as a prompt

**Files:**
- Modify: `src/main/index.ts` — `ReviewHub` deps :703-719; the transcript feed's `onInterrupt` :770; `onTabClosed` :882-908; `events.exit` :1042-1059; remote chat `interrupt` :1564; `writeInput` :1710-1712; pipe `attention` :2286-2326 and `turn` :2327-2336; IPC `chatInterrupt` :2826-2829
- Create: `tests/e2e/coordinator-tasks.spec.ts`

**Interfaces:**
- Consumes: Task 3 (`TabWaits`, `onDialogsClosed`, `AutoContinue.pending`, attention `prompt` / `lastMessage`), Task 7 (hub events), Task 9, Task 11 (`projectCoordinators`, `tabWaits`, `promptDelivery`, helpers).
- Wiring:
  - `ReviewHub` deps: `onDialogsClosed: (tabId) => tabWaits.dialogsClosed(tabId)`.
  - `attention`, `reason` `permission` / `question`: after `review.dialogOpened(...)`, `tabWaits.dialogOpened(msg.tabId, msg.reason, msg.prompt ?? null)`.
  - `attention`, `done` without `error`: after `autoContinue.turnEnded`, `projectCoordinators.turnEnded(msg.tabId, { background: msg.background === true, lastMessage: msg.lastMessage ?? null })`.
  - `attention`, `done` with `error`: `const continued = autoContinue.failed(msg.tabId, msg.error)`; `if (msg.error === LIMIT_ERROR) tabWaits.limited(msg.tabId, limitResetOf(statusHub.get(msg.tabId).main, Date.now()))`; `projectCoordinators.turnFailed(msg.tabId, msg.error, continued)`; then `if (continued) return { ok: true }` as today.
  - `turn`: after `autoContinue.turnStarted`, `tabWaits.turnStarted(msg.tabId)` and `projectCoordinators.turnStarted(msg.tabId)`.
  - `writeInput`: for `'\x1b'` or `'\x03'`, before `tabs.setWorking(tabId, false)`: `mailHub.interrupted(tabId)` and `projectCoordinators.interrupted(tabId)`.
  - The transcript feed's `onInterrupt` (:770): besides `review.interrupted(...)`, for `agentId === null`: `mailHub.interrupted(tabId)` and `projectCoordinators.interrupted(tabId, at)`.
  - `const interruptChat = (tabId: string): void => { chatHub.interrupt(tabId); mailHub.interrupted(tabId); projectCoordinators.interrupted(tabId) }`, used by the remote host's `chat.interrupt` and by `IPC.chatInterrupt` for a local tab.
  - `events.exit`: `projectCoordinators.exited(id)`.
  - `onTabClosed`: `tabWaits.removeTab(tabId)` and `promptDelivery.forget(tabId)`.

- [ ] **Step 1: Write the failing tests** — `tests/e2e/coordinator-tasks.spec.ts`; unless a test says otherwise it starts from `coordApp(2)`, `makeCoordinator(tab1)`, `attach` `refOf(sid2)`, a held `w = waitForMail(tab2, sid2)`, `message` `'Fix the parser.'`, `await w` (the task is open), and a held `c = waitForMail(tab1, sid1)` for the coordinator:
```ts
test('the end of a task wakes the coordinator with the session\'s last answer as a finished report', async () => {
  await done(pipeName, tab2, sid2, { lastMessage: 'Parser fixed; 12 tests pass.' })
  const report = await within(c, 15_000)
  expect(report.info).toContain('Report from a session attached to you, through ClaudeTerm: its task finished.')
  expect(report.info).toContain('> Parser fixed; 12 tests pass.')
})
test('the person\'s turn right after the Stop keeps the task open: the report is the answer after it', ...)  // done('first'), turnOf, done('second'): report has 'second', not 'first'
test('background work still running at the Stop keeps the task open', ...)   // done with background: true, tasks [...] → stillWaiting(c, 3500); done → report
test('an error ClaudeTerm does not continue fails the task', ...)            // done with error 'invalid_request' → 'its task failed: Claude Code stopped the turn on an error (invalid_request).'
test('a usage limit is no outcome: list_sessions shows it until the next turn', ...)   // error 'rate_limit' → stillWaiting(c, 3000); list has 'Usage limit'; turnOf → list has no 'Usage limit'
test('a permission prompt shows in list_sessions until the turn ends', ...)  // attention permission with prompt 'Allow Bash: npm test' → list has '- ' + name + ' [' + ref + '] · Allow Bash: npm test' and the prompt note; done → gone
test('Esc in the task\'s turn stops it: the coordinator is told at its next turn, not woken', async () => {
  await page.evaluate((id) => window.ct.writePty(id, '\x1b'), tab2)
  await stillWaiting(c, 2500)
  await turnOf(pipeName, tab1, sid1)
  expect((await within(c, 10_000)).info).toContain('its task was stopped by the user: its turn was interrupted.')
})
test('a permission prompt the person denies in the task\'s turn stops the task: the transcript says the turn was interrupted', ...)
// coordApp(2, { transcripts: true, env: { CLAUDETERM_TEST_FEED_MAX_MS: '200' } }); with the task open, append to transcripts[1] the line
// JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, timestamp: new Date().toISOString() }) + '\n'
// → stillWaiting(c, 2500); turnOf(tab1) → c's info contains 'its task was stopped by the user: its turn was interrupted.'
test('the process exiting fails the open task', ...)                         // window.ct.writePty(tab2, 'exit\r') ends the test tab's shell (as remote-tabs.spec.ts types exit) → 'its task failed: Claude Code exited.'
test('closing the session\'s tab fails its task', ...)                       // closeTab(tab2) → 'its task failed: its tab was closed.'
test('an open task survives a quit; the restored session\'s rest reports it', ...)   // quit and restore as in coordinator.spec; done(restored tab2, sid2, lastMessage) → report to a new waitForMail(restored tab1, sid1)
test('the report of a task the previous coordinator gave goes to the new one with a note', ...)  // coordApp(3); after the task is open, makeCoordinator(tab3, true); waitForMail(tab3, sid3); done(tab2) → '> (This task was given by the previous coordinator, '
test('chat view: with no watcher the task goes as a message, and the report as a message to the coordinator', async () => {
  // the stand-in runs no hooks, so no watcher ever waits: both deliveries go through PromptDelivery
  // const l = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] }, fallback: [{ text: 'Parser fixed.' }] }, { work: gitRepo(), env: { CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' } })
  // A = l.tabId; B = (await window.ct.openTab({ kind: 'claude', cwd: l.work })).id; in each (activate, then sendMessage(page, 'hello')),
  // and poll window.ct.chatSnapshot(id) until state.sessionId is set and state.turn is 'idle';
  // makeCoordinator(A); coord(A, { op: 'attach', session: refOf(sidB) }); coord(A, { op: 'message', session: refOf(sidB), text: 'Fix the parser.' });
  // expect.poll(() => userMessages(l.log).some((m) => m.startsWith('Task from your coordinator, through ClaudeTerm:') && m.includes('> Fix the parser.'))).toBe(true)
  // poll until B's state.turn is 'idle' again (its answer is done), then turnOf(B), done(B, { lastMessage: 'Parser fixed.' }) — the hooks the stand-in does not run
  // expect.poll(() => userMessages(l.log).some((m) => m.startsWith('Report from a session attached to you, through ClaudeTerm: its task finished.') && m.includes('> Parser fixed.')), { timeout: 15_000 }).toBe(true)
})
test('terminal view: with no watcher the task is typed into Claude Code\'s empty prompt', async () => {
  // const s = chatStandIn({ turns: {} }); const repo = gitRepo()
  // launchApp({ settings: { ...s.settings, claude: { ...(s.settings as any).claude, view: 'terminal' } }, args: ['--claude', repo], env: { ...s.env, CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' } })
  // a second tab: window.ct.openTab({ kind: 'claude', cwd: repo }); startSession for both (the stand-in runs no hooks); no waitForMail is held;
  // makeCoordinator(tab1); attach and message refOf(sid2) 'Fix the parser.';
  // the stand-in draws an empty prompt and logs each line it reads as { in: line } (fake-claude.ts terminal mode):
  // expect.poll(() => s.log().some((e) => typeof e.in === 'string' && e.in.includes('> Fix the parser.')), { timeout: 15_000 }).toBe(true)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && node scripts/e2e.mjs coordinator-tasks.spec.ts`
Expected: FAIL (no report comes; nothing is typed).

- [ ] **Step 3: Implement** the wiring list.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm test && npm run build && node scripts/e2e.mjs coordinator-tasks.spec.ts coordinator.spec.ts auto-continue.spec.ts agent-messages.spec.ts attention.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/index.ts tests/e2e/coordinator-tasks.spec.ts
git commit -m "feat: turn events end tasks and send reports; tasks and reports go as a prompt when no watcher waits"
```

---

## Interfaces for parts 2 and 3

**Part 2 (the window)** reads and calls only these:
- `CtApi.coordView` / `onCoordView` — the Sessions panel: `CoordinatorView.sessions` grouped by `group` (`waiting`, `working`, `idle`, `resolved`; Resolved folded), `notAttached`, each row's `why` (amber dot for `prompt`, red for `limit` / `failed`), `marker` (`starting` now; `offline`, `attaching` from part 3), `line`, `progress` (the thin bar), `changedAt`, `tabId` (Open), `key` (Message, Detach, Resolve, Attach); `problem` (the panel's notice with its link to Settings, Agent messages); `waiting` (the badge).
- `CtApi.coordMarks` / `onCoordMarks` — the tab list and the header: `coordinator` (label, `Coordinator · <sessions> sessions`, badge `waiting`), `attached` (indentation under `coordinatorTabId` in the same group, `↳ <project>` elsewhere, the header line `↳ Reports to <project> coordinator` with Detach).
- `CtApi.coordMake(tabId, replace)` — Make project coordinator; `{ ok: false, replaces }` asks whether to replace, then calls again with `replace: true`. `coordStop`, `coordAttach(tabId, sessionTabId)` (drag and drop, Attach…), `coordDetach` / `coordMessage` / `coordResolve(tabId, key)`, `coordNewSession(tabId, CoordStartRequest)`.
- `MailMessageView.kind`, `outcome`, `reason` — the Agent messages panel and the report card (`<session> · finished` / `· failed: <reason>`); a report wake starts with `Report from a session attached to you, through ClaudeTerm:`, a task wake with `Task from your coordinator, through ClaudeTerm:`.

**Part 3 (devices)** builds on:
- Addresses are `(device | null, session)` everywhere: `StoredAttachment.device`, `StoredHosted.coordinator.device`, `StoredTask.from.device`, mail record ends. A remote attachment is stored with the peer's device id; no migration is needed.
- `isShareable` already lets task, report, attach and detach records between two devices travel through `MailSync`; part 3 gates them on the peer's coordinator capability and makes the hub's mail listener take `attach` / `detach` records addressed to this device (today the hub updates both halves itself, because both ends are local).
- The hub's refusals `HUB_TEXT.remote` (attach) and `HUB_TEXT.otherDevice` (start) are where remote attach (marker `attaching` until the device confirms) and remote start (`open-tab` with a folder, account by email) go.
- A row of another device's session needs its `RowFacts` from new `RemoteTab` fields: `TabWaits.get(tabId)` (prompt, limit), `TaskListHub.status(tabId)`, the hosted current task (`currentTask` / `nextTask`), published like the other fields.
