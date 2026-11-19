# Workflow agents in the agents lists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Workflow run's agents show in the chat's dock, on the agent page and in a new click-opened ⚙ card of the status bar, as a group per run that looks like the ordinary subagents' rows.

**Architecture:** One pure row shape (`src/shared/workflow.ts`) is filled from two sources. The chat fills it from the SDK stream (`task_started` / `task_progress` / `task_notification` with `workflow_progress`), and from `workflows/<runId>.json` after a restart. The status bar fills it from the hooks plus the run folder the transcript feed reads (`subagents/workflows/<runId>/`). The renderer draws both through one `fillAgentsCard`.

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), plain DOM in the renderer, Vitest (unit, integration), Playwright (e2e), the stand-in `claude` in `tests/fixtures/fake-claude`.

**Spec:** `docs/superpowers/specs/2026-11-19-workflow-agents-list-design.md`. Read it first: this plan argues from it and does not repeat its reasons.

## Global Constraints

- The branch is `worktree-feat-workflow-agents-list`, on top of `0dd2d80`. Do not rebase or merge anything into it.
- **No commits.** The global rule says the work stays uncommitted until the person asks. Each task ends with "leave the changes uncommitted".
- **Local tests: only the affected ones.** Run `npm run typecheck` and the test files the task names. Do not run the whole `npm test` or `npm run test:e2e`; the full suites run in CI.
- Tests never start the real `claude`, never read or write the real `~/.claude` or `%APPDATA%\ClaudeTerm`, and write only under `tmpdir()`.
- Every UI-visible string, comment and log is English. Exact strings: `N agents · M done`, `<phase> · N of M done`, `workflow`, `attempt N`, `done · 2m 14s`, `failed`, `stopped`, `The workflow asked`, `The agent answers in the main conversation, not to its workflow`, `Agents — click for the list`.
- Paths are compared with `pathKey` / `isWithin` (`src/main/path-key.ts`), never as raw strings. A runId must pass `isRunId` and an agent id `isAgentId` before either is joined into a path.
- Caps: 200 agents and 20 phases per run, labels and titles of 100 characters, tasks of 200. A run file of at most 1 MiB. At most 8 run folders watched per session. A host's push carries at most 8 runs × 64 agents. Run agents' page records are capped at 400, apart from `MAX_AGENT_RECORDS` (500).
- Match the surrounding code: its naming, its one-line doc comments, no UI framework. Keep each file's line endings.
- If another agent's work collides with yours (a build lock, a shared file), report it to the controller; do not resolve it yourself.

## Review Focus

1. **`task_started` before the Workflow call's result, or the result before it.** One call must hold one run either way. Test in Task 3: both orders give one `workflow` on the call.
2. **A Windows `Transcript dir:`** with backslashes, an 8.3 name (`C:\Users\RUNNER~1\…`) or a trailing separator. The runId is still its last segment. Test in Task 1.
3. **A huge run** (300 agent rows, `workflow_progress_omitted`, 30 phases) stays within the caps, and an unchanged progress sends nothing. Tests in Tasks 1 and 3.
4. **Claude Code restarts mid-run** (SessionStart `startup`/`resume`), or the session is `/clear`ed. Runs go; none is left running. Test in Task 8.
5. **A member with one bad run, or a call with a bad `workflow` field.** Only that run or field is dropped; the push is kept. Tests in Task 9.

---

### Task 1: The row shape (`src/shared/workflow.ts`)

**Files:**
- Create: `src/shared/workflow.ts`
- Test: `tests/unit/workflow.test.ts`

**Interfaces:**
- Consumes: `isAgentId` from `src/shared/chat.ts`.
- Produces (every later task uses these exact names):
  ```ts
  export const RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/
  export const isRunId: (v: unknown) => v is string            // string, at most 64 chars, matches the pattern
  export const MAX_RUN_AGENTS = 200, MAX_RUN_PHASES = 20, RUN_LABEL_CAP = 100, RUN_TASK_CAP = 200
  export type RunState = 'running' | 'done' | 'failed' | 'stopped'
  export type RunEnd = Exclude<RunState, 'running'>
  export interface WorkflowPhase { index: number; title: string }
  export interface WorkflowAgentRow { key; agentId; label; phase; state: 'running'|'done'|'failed'; attempt; model; effort; task; startedAt; ms }  // exactly as the spec's block
  export interface WorkflowRun { key; runId; taskId; name; state: RunState; startedAt; ms; phases: WorkflowPhase[]; agents: WorkflowAgentRow[] }  // as the spec's block
  export interface RunRows { phases: WorkflowPhase[]; agents: WorkflowAgentRow[] }
  export function parseWorkflowProgress(rows: unknown): RunRows | null
  export function foldJournal(lines: unknown[]): RunRows
  export function isWorkflowRun(v: unknown): WorkflowRun | null   // the run cleaned and capped, or null
  export function sameRun(a: WorkflowRun | undefined, b: WorkflowRun): boolean
  export function endRun(run: WorkflowRun, state: RunEnd, ms: number | null): WorkflowRun
  export function runEndState(status: unknown): RunEnd | null    // 'completed'→done, 'failed'→failed, 'killed'|'stopped'→stopped, else null
  export function runHead(run: WorkflowRun): { phase: string | null; done: number; total: number }
  export function runOfResult(text: string): { runId: string | null; taskId: string | null }
  export function workflowTask(text: string): string | null
  ```

- [ ] **Step 1: Write the failing tests** in `tests/unit/workflow.test.ts`:

```ts
const agentRow = (over: object) => ({ type: 'workflow_agent', index: 0, label: 'triage-a', phaseIndex: 0, phaseTitle: 'Triage', agentId: 'a1b2', model: 'claude-haiku-5-5', state: 'progress', startedAt: 1000, queuedAt: 900, attempt: 1, promptPreview: 'Look at crash 1', ...over })

it('turns stream rows into phases and agents', () => {
  const r = parseWorkflowProgress([{ type: 'workflow_phase', index: 0, title: 'Triage' }, agentRow({}), agentRow({ index: 1, agentId: 'c3d4', state: 'done', durationMs: 41_000, attempt: 2 })])
  expect(r).toEqual({
    phases: [{ index: 0, title: 'Triage' }],
    agents: [
      { key: '0', agentId: 'a1b2', label: 'triage-a', phase: 0, state: 'running', attempt: 1, model: 'claude-haiku-5-5', effort: null, task: 'Look at crash 1', startedAt: 1000, ms: null },
      { key: '1', agentId: 'c3d4', label: 'triage-a', phase: 0, state: 'done', attempt: 2, model: 'claude-haiku-5-5', effort: null, task: 'Look at crash 1', startedAt: 1000, ms: 41_000 },
    ],
  })
})
it('maps states: start and progress run, done is done, error failed, an unknown state runs', ...)   // 'start','progress','done','error','weird' → running, running, done, failed, running
it('skips unknown row types and the omitted count, and gives null for a non-array', ...)            // { type: 'workflow_progress_omitted', count: 40 } adds nothing; parseWorkflowProgress('x') === null
it('caps 200 agents, 20 phases, labels of 100 and tasks of 200 characters', ...)                    // 300 rows → 200; 30 phases → 20; 'l'.repeat(300) → 100; 'p'.repeat(500) → 200
it('drops a bad agent id and bad numbers, but keeps the row', ...)                                 // agentId 'bad id!' → null; startedAt NaN → null; attempt 0 → 1
it('adds a phase an agent names when no phase row has it', ...)                                    // agentRow({ phaseIndex: 2, phaseTitle: 'Fix' }) alone → phases [{ index: 2, title: 'Fix' }]
it('folds the journal: keys, attempts, results and failures', () => {
  const r = foldJournal([
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'a1', label: 'triage-a', phase: 'Triage' },
    { type: 'started', key: 'k2', agentId: 'a2', label: 'fix-b', phase: 'Fix' },
    { type: 'failed', key: 'k1', agentId: 'a1' },
    { type: 'started', key: 'k1', agentId: 'a3', label: 'triage-a', phase: 'Triage' },
    { type: 'result', key: 'k2', agentId: 'a2', result: 'ok' },
    'not an object', { type: 'started', key: 5 },
  ])
  expect(r.phases).toEqual([{ index: 0, title: 'Triage' }, { index: 1, title: 'Fix' }])
  expect(r.agents.map(a => [a.key, a.agentId, a.attempt, a.state, a.phase])).toEqual([['k1', 'a3', 2, 'running', 0], ['k2', 'a2', 1, 'done', 1]])
})
it('finds the runId and task id in a Workflow result, on any path form', () => {
  expect(runOfResult('Workflow launched.\nTask ID: w9ehhq53f\nTranscript dir: C:\\Users\\RUNNER~1\\.claude\\projects\\p\\s\\subagents\\workflows\\wf_55e3c3ec-b29')).toEqual({ runId: 'wf_55e3c3ec-b29', taskId: 'w9ehhq53f' })
  expect(runOfResult('Task ID: w1\nTranscript dir: /home/u/.claude/projects/p/s/subagents/workflows/wf_abcdef12/')).toEqual({ runId: 'wf_abcdef12', taskId: 'w1' })
  expect(runOfResult('Transcript dir: /x/wf_../etc')).toEqual({ runId: null, taskId: null })
})
it('reads a task without the harness framing', ...)  // workflowTask('[Workflow harness — computed task]\n\n  Look at   crash 1\n') === 'Look at crash 1'; '' → null; a 500-char task → 200 chars
it('isWorkflowRun keeps a good run, caps it, and refuses a bad one', ...)  // a run with 250 agents → 200; state 'odd' → null; key '' → null; runId 'nope' → runId null (field cleaned, run kept)
it('endRun ends the running agents as failed; runHead counts and names the current phase', ...)
// runHead: the phase of the agent with the latest startedAt (ties: the later row); null when the run has no phases
```

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/unit/workflow.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement `src/shared/workflow.ts`.** Notes:
  - Text fields are `oneLine`d: whitespace runs become one space, trimmed, then capped.
  - A row's `key` is `String(index)` for stream rows, the journal's `key` (a string, capped at 100) for journal rows.
  - A label that is missing becomes `agent <key>`.
  - `foldJournal` keeps the first-seen order of keys. A new `started` for a known key bumps `attempt`, takes the new `agentId` and is `running` again. Phase names become indexes in first-seen order.
  - `runOfResult` reads `Task ID: (\S+)` (must pass `isAgentId`) and the last `Transcript dir: (.+)` line. It splits that path on `/` and `\`, drops empty parts, and takes the last part (must pass `isRunId`).
  - `workflowTask` drops a first line that starts with `[Workflow harness`, then applies `oneLine` and the cap; empty → null.
  - `sameRun` is `a !== undefined && JSON.stringify(a) === JSON.stringify(b)`.

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/workflow.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 2: The stand-in's `workflow` step

**Files:**
- Modify: `tests/fixtures/fake-claude/install.ts` (the `FakeStep` union, a new `FakeWorkflow` type)
- Modify: `tests/fixtures/fake-claude/fake-claude.ts` (`runStep`, about line 856)
- Test: `tests/integration/fake-claude.int.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the stand-in is plain test code).
- Produces:
  ```ts
  | { workflow: FakeWorkflow }   // new FakeStep member, with a one-line comment like its neighbours
  export interface FakeWorkflow {
    name: string                 // workflow_name and the run file's workflowName
    phases?: string[]            // phase titles; an agent's phase is an index into them
    agents: FakeWorkflowAgent[]
    gate?: string                // the run ends once <config folder>/<gate> exists; without one, after ms
    ms?: number                  // default 300
    status?: 'completed' | 'failed' | 'killed'   // default 'completed'
  }
  export interface FakeWorkflowAgent {
    label: string; task: string; phase?: number
    attempts?: number            // 2: a first try fails and a retry runs under a new agent id (same key)
    later?: { gate: string; text: string }       // once <config folder>/<gate> exists, an assistant line with this text is appended to its transcript
  }
  ```
  Ids the stand-in uses, so tests can name them: task id `wfake<n>` (passes `isAgentId`), runId `wf_fake-<n>` (passes `isRunId`), agent ids `awf<n>` in launch order (a retry takes the next one).

- [ ] **Step 1: Write the failing test** in `tests/integration/fake-claude.int.test.ts`, following its existing stream-mode tests. Give a turn the step `{ workflow: { name: 'crash-triage', phases: ['Triage'], agents: [{ label: 'triage-a', task: 'Look at crash 1', attempts: 2 }, { label: 'triage-b', task: 'Look at crash 2' }], ms: 200 } }`. Assert:
  - an assistant `tool_use` named `Workflow`, then a user `tool_result` for it whose text has `Task ID: wfake…` and `Transcript dir: <…>/subagents/workflows/wf_fake-…`;
  - `system` `task_started` with `task_type: 'local_workflow'`, `workflow_name: 'crash-triage'` and the call's `tool_use_id`;
  - at least one `task_progress` whose `workflow_progress` has a `workflow_phase` row and `workflow_agent` rows; one of them has `attempt: 2`;
  - a final `task_notification` with `status: 'completed'`, `usage.duration_ms` and `workflow_progress` rows all `done`;
  - on disk under `<config>/projects/<cwd key>/<session>/`: `subagents/workflows/<runId>/journal.jsonl` (with `launched`, `started`, `failed`, `result` lines), `agent-<id>.jsonl` for each agent id (its first line a user message starting `[Workflow harness — computed task]`, then an assistant line), `agent-<id>.meta.json` (`description` = label, `workflowPhase`, `model`), and `workflows/<runId>.json` (`runId`, `taskId`, `workflowName`, `status`, `startTime`, `durationMs`, `workflowProgress`).

- [ ] **Step 2: Run it to see it fail.** Run: `npx vitest run tests/integration/fake-claude.int.test.ts -t workflow`. Expected: FAIL; the stand-in ignores the step.

- [ ] **Step 3: Implement the step in `fake-claude.ts`.**
  - The call ends at once with the launch result, like a `background: true` task. The run then goes on outside the turn: start the agents, emit progress, wait for the gate or `ms`, emit the end.
  - Write the files at the moments Claude Code writes them: the journal and transcripts as agents start and end, the run file at the end.
  - Write files only when `--no-session-persistence` is absent, as `writeSubagentLine` does.
  - `later` is checked every 20 ms while the run is open (see `gateOpen`).
  - The end also sends the conversation's notice of a finished background task, the way a background agent's end does (see the code around `fake-claude.ts:711`).

- [ ] **Step 4: Run it.** Run: `npx vitest run tests/integration/fake-claude.int.test.ts` and `npm run typecheck`. Expected: PASS, the existing tests too.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 3: A Workflow call holds its run in the chat

**Files:**
- Modify: `src/shared/chat.ts:42-45` (`ChatToolCall`)
- Modify: `src/main/chat/chat-fold.ts` (`toolResults` :334, `failRunning` :490, `dropOldest`, new methods)
- Modify: `src/main/chat/chat-model.ts:668-680` (`system`)
- Test: `tests/unit/chat-model.test.ts`

**Interfaces:**
- Consumes: Task 1's `WorkflowRun`, `parseWorkflowProgress`, `runOfResult`, `runEndState`, `endRun`, `sameRun`.
- Produces:
  - `ChatToolCall.workflow?: WorkflowRun`.
  - On `ChatFold`:
    - `protected readonly runTasks: Map<string, { itemId: string; callId: string }>`, keyed by task id;
    - `protected workflowStarted(msg: Obj): ChatPatch[] | null`;
    - `protected workflowProgress(msg: Obj): ChatPatch[] | null`;
    - `protected workflowEnded(msg: Obj): ChatPatch[] | null`;
    - `runs(): WorkflowRun[]`: the `workflow` of every call, in item order.

    `null` means "not a run's message", so the caller falls back to today's handling.

- [ ] **Step 1: Write the failing tests** in `tests/unit/chat-model.test.ts` (use its `model()`, `run()` and `callsOf()` helpers):

```ts
const wfCall = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tw', name: 'Workflow', input: { name: 'crash-triage' } }] } }
const wfResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tw', content: 'Workflow launched in background.\nTask ID: w9ehhq53f\nTranscript dir: C:\\p\\s\\subagents\\workflows\\wf_55e3c3ec-b29' }] } }
const wfStarted = { type: 'system', subtype: 'task_started', task_id: 'w9ehhq53f', tool_use_id: 'tw', task_type: 'local_workflow', workflow_name: 'crash-triage', description: 'Triage crashes' }
const progress = (rows: unknown[]) => ({ type: 'system', subtype: 'task_progress', task_id: 'w9ehhq53f', workflow_progress: rows })
const phase = { type: 'workflow_phase', index: 0, title: 'Triage' }
const agent = (i: number, state: string, attempt = 1) => ({ type: 'workflow_agent', index: i, label: `triage-${i}`, phaseIndex: 0, phaseTitle: 'Triage', agentId: `a${i}`, model: 'claude-haiku-5-5', state, attempt, promptPreview: `Look at crash ${i}`, startedAt: 1000 + i })

it('a Workflow call holds its run: name, subject, rows, and its end', () => {
  const { m } = model()
  run(m, [wfCall, wfResult, wfStarted, progress([phase, agent(0, 'progress'), agent(1, 'start')])])
  const call = callsOf(m)[0]
  expect(call.subject).toBe('crash-triage')
  expect(call.detail).toBe('2 agents')
  expect(call.workflow).toMatchObject({ key: 'tw', runId: 'wf_55e3c3ec-b29', taskId: 'w9ehhq53f', name: 'crash-triage', state: 'running', phases: [{ index: 0, title: 'Triage' }] })
  expect(call.workflow?.agents.map(a => a.agentId)).toEqual(['a0', 'a1'])
  m.apply({ type: 'system', subtype: 'task_notification', task_id: 'w9ehhq53f', status: 'completed', usage: { duration_ms: 134_000 }, workflow_progress: [phase, agent(0, 'done'), agent(1, 'done')] })
  expect(callsOf(m)[0].workflow).toMatchObject({ state: 'done', ms: 134_000 })
})
it('one run when task_started comes before the call\'s result', ...)          // order wfCall, wfStarted, wfResult → one workflow with runId and taskId both set
it('a progress that changes nothing sends no patch', ...)                     // apply the same progress twice: the second apply returns []
it('a run without progress shows its head', ...)                              // wfCall, wfResult, wfStarted → workflow.agents [] and state running
it('the "workflow ended" event row stays in the conversation', ...)           // after the task_notification, a user message with the task's notice (as the existing event-row tests build one, naming task w9ehhq53f) still adds an 'event' item
it('the process end and the history load end a running run as stopped, its running agents failed', ...)  // processEnded() / historyLoaded()
it('a failed Workflow call holds no run', ...)                                // tool_result is_error: true → no workflow
it('a run of 300 agents keeps 200', ...)
```

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/unit/chat-model.test.ts -t "Workflow|run"`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`toolResults`.** For a `Workflow` call whose result is not an error, `next.workflow = merge(call.workflow, runOfResult(text))`. A new run is `{ key: call.id, runId, taskId, name: 'workflow', state: 'running', startedAt: link.start, ms: null, phases: [], agents: [] }`. A known `taskId` is put in `runTasks`.
  - **`workflowStarted`.** It handles a message with `task_type === 'local_workflow'` whose `tool_use_id` names a `Workflow` call, and returns null for any other. It sets `taskId`, and `name` (`workflow_name`, `oneLine`, cap 100; `'workflow'` when empty) on the run, a new one or the existing one. It sets the call's `subject` to the name and puts the task in `runTasks`. Its patch comes from `callPatch`.
  - **`workflowProgress`.** It handles a `task_id` that is in `runTasks`. It takes `parseWorkflowProgress(msg.workflow_progress)`; null rows leave the run as it is. It sets `detail` to `` `${agents.length} agents` ``. It returns `[]` when `sameRun` says nothing changed.
  - **`workflowEnded`.** It handles a `task_id` in `runTasks` and takes `runEndState(msg.status)`; null → `[]`. `ms` is `usage.duration_ms` when it is a number ≥ 0, else elapsed since the run's start. It takes the rows when given, then `endRun`, and deletes the task from `runTasks`. It does **not** add the task to `ended`.
  - **`failRunning`.** A call whose `workflow.state === 'running'` also gets `endRun(run, 'stopped', elapsed)`. The `continue` condition counts that change too.
  - **`dropOldest`.** It drops `runTasks` entries of dropped items.
  - **`ChatModel.system`.**
    - `task_started`: `this.workflowStarted(msg) ?? this.taskStarted(msg)`.
    - `task_progress`: `this.workflowProgress(msg) ?? []`.
    - `task_notification`: `this.workflowEnded(msg) ?? this.agentNotified(msg)`.

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/chat-model.test.ts tests/unit/agent-chats.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 4: Run agents get page records, and their transcripts are found

**Files:**
- Modify: `src/shared/chat.ts:159-164` (`ChatAgentInfo`)
- Modify: `src/main/chat/agent-chats.ts` (records, `started` :576, `forget`, `makeRecord`)
- Modify: `src/main/chat/agent-history.ts` (new path functions)
- Modify: `src/main/chat/chat-hub.ts` (`apply` :939, `agentFile` :1233)
- Test: `tests/unit/agent-chats.test.ts`, `tests/integration/agent-history.int.test.ts`

**Interfaces:**
- Consumes: Task 1's `WorkflowRun`, `isRunId`; Task 3's `ChatToolCall.workflow`.
- Produces:
  - `ChatAgentInfo.workflow?: { run: string; phase: string | null; attempt: number }`;
  - `export const MAX_RUN_RECORDS = 400` in `agent-chats.ts`;
  - `AgentChats.runAgents(run: WorkflowRun, sessionId: string | null): AgentChange[]`;
  - `AgentChats.runIdOf(agentId: string): string | null`;
  - `runAgentTranscriptPath(transcript: string, sessionId: string, runId: string, agentId: string): string | null`, which builds `<dirname(transcript)>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl`, null unless `isUuid(sessionId) && isRunId(runId) && isAgentId(agentId)`;
  - `resolveRunAgentTranscript(file: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/unit/agent-chats.test.ts`:
    - `runAgents makes a record per run agent with an id: label as type, task as description, its run, phase and attempt`. Expect `c.info('a0')` toEqual `{ id: 'a0', type: 'triage-0', description: 'Look at crash 0', state: 'running', startedAt: 1000, ms: null, parentId: null, workflow: { run: 'crash-triage', phase: 'Triage', attempt: 1 } }` and `c.runIdOf('a0')` toBe `'wf_55e3c3ec-b29'`.
    - `a changed row sends an agent patch, an unchanged one nothing`. Call `runAgents` with `a0` done → one change whose patches hold `{ op: 'agent' }`. The same run again → `[]`.
    - `run agents have their own cap and never evict ordinary agents`. Make 500 ordinary agents, then 450 run agents: all 500 ordinary records remain, and run records number 400.
    - `an agent written to after its run follows the stream, not the run`. After `runAgents` (a0 done), a `task_started` `local_agent` for `a0` makes it running. A later `runAgents` with a0 `done` leaves it running; `workflow` is kept.
    - `a local_workflow task_started makes no record`.
  - `tests/integration/agent-history.int.test.ts`, with a real temp project:
    - a run agent's file inside the folder resolves to its real path;
    - a `workflows` junction (Windows) or symlink (elsewhere) leading outside the project gives null; so does a `subagents` one;
    - a bad runId gives no path;
    - on Windows, an 8.3 short form of the temp folder still resolves (as the file's test at :137 makes one).

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/unit/agent-chats.test.ts tests/integration/agent-history.int.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`runAgents`.** For each row with an `agentId`, build the info from the row: state = the row's state, `startedAt` / `ms` from the row, `parentId` null, `workflow` = run name, the phase's title (null when none), attempt.
    - A new id: `makeRecord(info, true)`, `remember`, `needs.add`, and the runId stored for it.
    - A known id: assign the changed fields and emit `agentPatch`. An id in the "out of the run" set keeps its state, `startedAt` and `ms`.
  - **`started()`.**
    - Returns `[]` for `task_type === 'local_workflow'`.
    - When it resumes an existing record (the `else` branch), it adds the id to the "out of the run" set.
  - **The caps.** `makeRecord(record, run = false)`:
    - a run record forgets the least touched unwatched *run* record while there are ≥ `MAX_RUN_RECORDS`;
    - an ordinary record forgets the least touched unwatched *ordinary* record while `records.size - runCount ≥ MAX_AGENT_RECORDS`.

    `forget(pick)` takes the predicate, and also drops the runId and the "out of the run" mark.
  - **`resolveRunAgentTranscript`.** It is `resolveAgentTranscript` with the project folder five `dirname`s up: file → run folder → `workflows` → `subagents` → session → project. Check `isWithin(project, runDir) && isWithin(runDir, real)`.
  - **`ChatHub.apply`.** After `live.model.apply(msg)`, for each patch `p.op === 'call' && p.call.workflow`, emit `live.agents.runAgents(p.call.workflow, live.model.state().sessionId)`.
  - **`ChatHub.agentFile`.** When `live.agents.runIdOf(agentId)` is set, use `runAgentTranscriptPath` and `resolveRunAgentTranscript`.

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/agent-chats.test.ts tests/integration/agent-history.int.test.ts tests/integration/agent-chat.int.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 5: A shown run agent's page reads its new lines

**Files:**
- Modify: `src/main/transcript-feed.ts:17-25` (`LineTailer` gets a start offset)
- Modify: `src/main/chat/agent-history.ts` (`TranscriptPage.end`, `readAgentPage`)
- Modify: `src/main/chat/agent-chats.ts` (`Head.end`, `history`, new `tail`, `tailStart`)
- Modify: `src/main/chat/chat-hub.ts` (`watchAgent` :603, `unwatch`, `forgetViewer`, the tab's end)
- Test: `tests/unit/agent-chats.test.ts`, `tests/integration/agent-chat.int.test.ts`

**Interfaces:**
- Consumes: Task 4's `runIdOf`, `runAgentTranscriptPath`, `resolveRunAgentTranscript`; Task 2's stand-in step (`later`).
- Produces:
  - `new LineTailer(file, chunkBytes = CHUNK_BYTES, offset = 0)`;
  - `TranscriptPage.end: number`, the byte offset the page reads up to: the file's size when read from its end, else the `end` given;
  - `AgentChats.tailStart(agentId: string): number | null`, the head's `end`, or null while no head is held;
  - `AgentChats.tail(agentId: string, lines: Record<string, unknown>[]): AgentChange[]`;
  - in `chat-hub.ts`, `export const RUN_TAIL_MS = 2000`.

- [ ] **Step 1: Write the failing tests.**
  - Unit, `tail folds new lines as adds and sets, never a reset, and skips lines the head holds`. Do `history(a0, page)` with two lines, then `tail(a0, [line2, line3])`: the patches have no `op: 'reset'`; one `add` for line3's text; line2 adds nothing. A tool result in a second `tail` call for a `tool_use` of the first gives an `op: 'call'` patch.
  - Integration in `agent-chat.int.test.ts`, with the stand-in:
    1. Script: `{ workflow: { name: 'crash-triage', agents: [{ label: 'triage-a', task: 'Look', later: { gate: 'later', text: 'Second look' } }], gate: 'end' } }`.
    2. Wait for the agent's record. Take `hub.agentSnapshot(TAB, id)` and call `hub.watchAgent(TAB, 'window', id)`.
    3. Write `<config>/later`.
    4. Within 6 s an agent change for `id` arrives with an `add` whose item text is `Second look`, and no `reset` after the snapshot.
    5. Write `<config>/end`.

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/unit/agent-chats.test.ts tests/integration/agent-chat.int.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`tail`.** For each line: if any of `frameKeys(line)` is in `head.keys` or held by the live model, skip it. Else `fold(agentId, line)` and add its keys to `head.keys`. Return the changes.
  - **The hub's tail.** One per watched run agent, keyed `` `${tabId}\n${agentId}` ``:
    - it starts in `watchAgent` when the agent has a runId and its record is `running`;
    - each `RUN_TAIL_MS` tick waits until `tailStart` is not null, then makes the `LineTailer` at that offset on the resolved file;
    - it reads `readNew()`, parses each line (a bad one is skipped) and emits `live.agents.tail(...)`;
    - it stops when no viewer watches that agent any more (`views`), when the record is no longer `running` (after one last read), or when the tab's chat ends.

    Use `setInterval`, cleared on every stop.

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/agent-chats.test.ts tests/integration/agent-chat.int.test.ts tests/integration/agent-history.int.test.ts tests/integration/transcript-feed.int.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 6: The chat's history reads run files

**Files:**
- Create: `src/main/workflow-files.ts`
- Modify: `src/main/chat/chat-fold.ts` (new `openRunIds`, `applyRunFile`)
- Modify: `src/main/chat/chat-hub.ts` (`loadHistory` :897)
- Test: `tests/integration/workflow-files.int.test.ts` (new), `tests/unit/chat-model.test.ts`, `tests/integration/agent-chat.int.test.ts`

**Interfaces:**
- Consumes: Task 1's `isRunId`, `parseWorkflowProgress`, `runEndState`, `RunEnd`, `RunRows`; Task 3's runs on calls; Task 4's `runAgents`.
- Produces:
  ```ts
  export const RUN_FILE_CAP = 1024 * 1024
  export interface RunFile { taskId: string | null; name: string | null; state: RunEnd; startedAt: number | null; ms: number | null; rows: RunRows | null }
  export function readRunFile(sessionDir: string, runId: string): Promise<RunFile | null>
  // on ChatFold:
  openRunIds(): string[]                                   // runIds of calls whose run is running
  applyRunFile(runId: string, file: RunFile): ChatPatch[]  // the run ends as the file says; subject and name from file.name
  ```

- [ ] **Step 1: Write the failing tests.**
  - `workflow-files.int.test.ts`, with a temp session folder:
    - a good file gives its fields: `status: 'completed'` → `done`; `startTime` as an ISO string or as ms → ms; rows parsed;
    - an unknown status gives `stopped`;
    - a file over 1 MiB gives null; so do bad JSON and a bad runId (`'../x'`);
    - a `workflows` junction or symlink leading outside the session folder gives null.
  - `chat-model.test.ts`:
    - `history with a run file ends the run as the file says`: apply `wfCall` and `wfResult` (Task 3), then `applyRunFile('wf_55e3c3ec-b29', { … state: 'done', name: 'crash-triage', rows })`, then `historyLoaded()`. The run is `done`, the subject is `crash-triage`, and the rows are taken.
    - `history without one shows the head, stopped`.
  - `agent-chat.int.test.ts`:
    1. A first stand-in session runs the Task 2 step to its end.
    2. A second `ChatHub` resumes the session. Its `history` dep returns the first session's messages (as the file's resume tests do).
    3. The Workflow call's run is `done` with its rows, and a run agent's record exists.

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/integration/workflow-files.int.test.ts tests/unit/chat-model.test.ts tests/integration/agent-chat.int.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`readRunFile`.** Check `isRunId(runId)`. Then `stat` the file: size ≤ `RUN_FILE_CAP`. Then `realpath` the file and the session folder and check `isWithin(realSession, realFile)`. Parse the JSON and type-check every field. `state = runEndState(status) ?? 'stopped'`. `rows = parseWorkflowProgress(workflowProgress)`. Any error gives null.
  - **`ChatHub.loadHistory`.** After the `for (const msg of messages) live.model.apply(msg)` loop and before `historyLoaded()`:
    1. `transcript = await this.d.transcript(live.tabId, sessionId)`;
    2. `sessionDir = join(dirname(transcript), sessionId)`;
    3. for each `openRunIds()`, `readRunFile`, then `live.model.applyRunFile`.

    Check `this.tabs.get(live.tabId) === live` again after the awaits. Before the `known()` loop, call `runAgents` for each of `live.model.runs()`.

- [ ] **Step 4: Run the tests.** Run the three files from Step 2 and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 7: The transcript feed reads run folders

**Files:**
- Modify: `src/main/transcript-feed.ts` (`TranscriptFeedOptions` :120, `Source` :206, `scanSubagents` :263, `read` :341, `consume` :405, new reporters)
- Test: `tests/integration/transcript-feed.int.test.ts`

**Interfaces:**
- Consumes: Task 1's `isRunId`, `workflowTask`; Task 6's `readRunFile`, `RunFile`.
- Produces, new optional options:
  ```ts
  onWorkflowRun?(run: { runId: string; name: string; taskId: string }): void   // from the main transcript's Workflow result (toolUseResult)
  onWorkflowJournal?(runId: string, lines: unknown[]): void                   // new journal lines, parsed, in order
  onWorkflowTask?(runId: string, agentId: string, task: string): void          // a run agent's task, once per agent
  onWorkflowEnd?(runId: string, file: RunFile): void                          // the run file, once per run
  ```
  - `Source` gains `runId: string | null` and `tasked: boolean`.
  - `get workflowsDir(): string` returns `join(this.subagentDir, 'workflows')`.

- [ ] **Step 1: Write the failing tests** (`describe('workflow runs')`, real temp files, `pollMs: 20` as the file's other tests use):
  - a main transcript line `{ type: 'user', toolUseResult: { status: 'async_launched', taskId: 'w9ehhq53f', taskType: 'local_workflow', workflowName: 'crash-triage', runId: 'wf_55e3c3ec-b29', transcriptDir: '…' }, message: {…} }` calls `onWorkflowRun` once with `{ runId, name: 'crash-triage', taskId: 'w9ehhq53f' }`;
  - journal lines appended in two writes arrive in two `onWorkflowJournal` calls, in order;
  - an `agent-a0.jsonl` in the run folder:
    - gives `onSubagentInfo('a0', { model, effort })`;
    - gives `onWorkflowTask(runId, 'a0', 'Look at crash 1')` from its first user line, and only once;
    - gives `onEditEvent` for an Edit result line and `onImage` for an image block, as a subagent's transcript does;
  - two runs that both hold `agent-a0.jsonl` both report: the sources do not collide;
  - `<session>/workflows/<runId>.json` written later gives one `onWorkflowEnd`;
  - a run folder name that fails `isRunId` is not read; a run folder that is a junction or symlink leading outside `subagents` is not read;
  - with 10 run folders, only the 8 newest (by mtime) are read;
  - on Windows (`it.runIf(process.platform === 'win32')`), a feed whose transcript path is given in 8.3 short form still reads the run folder. Make the short form as `tests/integration/agent-history.int.test.ts:137-143` does (`cmd.exe … %~sI`).

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/integration/transcript-feed.int.test.ts -t "workflow runs"`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`scanSubagents`.** It also lists `workflowsDir`. It keeps folders that pass `isRunId` and whose `realpath` is inside `realpath(subagentDir)`, the 8 newest by `stat` mtime. For each:
    - a `RunWatch { runId, journal: LineTailer, schedule: Backoff, ended: boolean }`;
    - a source per `agent-*.jsonl`, keyed `workflows/<runId>/<file name>`, with `agentId` from the file name and `runId` set.

    Plain subagents keep their bare-name keys.
  - **`read`.** It reads each `RunWatch`'s journal on its schedule, under the same `due` (so `poll()` reads them too). It parses each line (a bad one is skipped) and calls `onWorkflowJournal` when there are lines. When a run is not `ended` and `<dirname(main)>/<sessionId>/workflows/<runId>.json` exists, it calls `readRunFile`, then `onWorkflowEnd`, and sets `ended`.
  - **`reportWorkflowRun(src, line)`.** Main transcript only, and only lines that include `"runId"`. It parses the line and checks `toolUseResult.runId` (`isRunId`), `workflowName` (string; `oneLine`, cap 100) and `taskId` (`isAgentId`). It reports once per runId.
  - **`reportWorkflowTask(src, line)`.** Run sources only, once (`src.tasked`). On the first `type: 'user'` line, the text is a string `message.content` or its text blocks, put through `workflowTask`. Report it when it is not null. It is added to `consume`.

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/integration/transcript-feed.int.test.ts tests/integration/transcript-feed-polling.int.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 8: StatusHub keeps runs, and main wires them

**Files:**
- Modify: `src/shared/types.ts:227` (`AgentStatus`), `src/shared/ipc.ts:270` (`StatusUpdate`)
- Modify: `src/main/status-hub.ts`
- Modify: `src/main/index.ts` (`statusSoon` ~681, the `readMeta` dep ~703, the feed options ~851, the `turn` handler ~2811)
- Test: `tests/unit/status-hub.test.ts`

**Interfaces:**
- Consumes: Task 1's shape, `foldJournal`, `endRun`; Task 6's `RunFile`; Task 7's feed callbacks.
- Produces:
  - `AgentStatus.runId?: string`;
  - `StatusUpdate.runs?: WorkflowRun[]`. `get()` sets it only when the tab has runs, so the existing whole-shape assertions stay true;
  - `StatusHubDeps.readMeta(tabId: string, agentId: string, runId: string | null): AgentMeta | null`;
  - on `StatusHub`:
    ```ts
    workflowRun(tabId: string, sessionId: string, run: { runId: string; name: string; taskId: string }): void
    workflowJournal(tabId: string, sessionId: string, runId: string, lines: unknown[]): void
    workflowTask(tabId: string, sessionId: string, runId: string, agentId: string, task: string): void
    workflowEnd(tabId: string, sessionId: string, runId: string, file: RunFile): void
    turn(tabId: string, sessionId: string): void
    ```
  Each new method drops a retired session's call and a late call of a previous session, as `subagent` does.

- [ ] **Step 1: Write the failing tests** in `tests/unit/status-hub.test.ts`:
  - `a run built from the journal groups its hook agents, which show once`. Journal: started `a1` and `a2` with phase `Triage`. Hooks: subagent start `a1` and `a2`. `get(TAB).runs` has one run whose `key` and `runId` are `wf_55e3c3ec-b29`, named `workflow` until `workflowRun` names it `crash-triage`. `get(TAB).agents` has `a1` and `a2`, each with `runId: 'wf_55e3c3ec-b29'`.
  - `a run agent the hook stopped is done unless the journal says failed`.
  - `the task becomes the row's task`.
  - `subagentInfo gives a run row its model, also after its stop`.
  - `a finished run is kept until the next prompt, and goes with a session switch, end, restart or reset`. After `workflowEnd` (`state: 'done'`), `runs[0].state` is `'done'` and `agents` is `[]`. `turn(TAB, SID)` empties `runs`. The same checks for `session(TAB, other, 'startup')`, `session(TAB, SID, 'resume')`, `sessionEnd` and `resetTab`.
  - `a turn end ends a run whose task it no longer lists, and one with no task id when no workflow task is listed`. `background(TAB, SID, [])` after `workflowRun` gives state `stopped`. With `[{ id: 'w9ehhq53f', type: 'workflow', … }]` the run keeps running.
  - `an agent that starts again after its run ended is a bare row` (no `runId`).
  - `with no journal, the agents stay bare rows and the run shows its head only` (after `workflowRun` alone, `runs[0].agents` is `[]`, and `agents` carry no `runId`).
  - `get() has no runs field while the tab has none`.
  - `at most 8 runs per tab: the oldest ended one goes first`.

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/unit/status-hub.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Per run, the hub keeps** its fields, the journal lines (the last 2000), the tasks by agent id, the model infos by agent id, the ids the hooks stopped, and `ended`.
  - **`get()` builds each run's rows.**
    1. `foldJournal(lines)`.
    2. A row whose `agentId` is in `t.agents` is `running`, with its `startedAt`, `model` and `effort`.
    3. A row the journal has running but the hook stopped is `done`.
    4. Tasks come from `workflowTask`.
    5. An ended run passes through `endRun`.
  - **Linking.** `subagent` start sets `runId` when a running run's journal has the id. `workflowJournal` sets it on tracked agents its new lines name. The agent must be started after the run began, and the run must not have ended.
  - **`background()`.** After today's logic, for each running run:
    - with a `taskId`, it ends `stopped` when no task has that id;
    - without one, it ends when no task has `type === 'workflow'`.
  - **`index.ts`.**
    - the four feed callbacks go to the hub with `tabId` and `sessionId`;
    - the `turn` handler calls `statusHub.turn(msg.tabId, msg.sessionId)`;
    - `readMeta` reads `readAgentMeta(runId ? join(dir, 'workflows', runId) : dir, agentId)`;
    - `pushToMembers(..., 'status', { main, agents, background, ...(status.runs ? { runs: status.runs } : {}) })`;
    - `setAgentsRunning` stays `status.agents.length > 0`.

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/status-hub.test.ts tests/unit/session-hook.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 9: Members carry runs, and one bad run drops alone

**Files:**
- Modify: `src/main/remote-host.ts:969-997` (`clampStatus`, `clampAgent`)
- Modify: `src/main/sync/remote-shapes.ts:902-935` (`agentOf`, `statusOf`)
- Modify: `src/main/chat/chat-mirror.ts:67-71` (`isCall`), `:204` (`isAgentInfo`)
- Test: `tests/unit/remote-host.test.ts`, `tests/unit/sync-remote-shapes.test.ts`, `tests/unit/chat-mirror.test.ts`

**Interfaces:**
- Consumes: Task 1's `isWorkflowRun`, `isRunId`; Task 8's `runs` and `runId`.
- Produces: `export const MAX_PUSH_RUNS = 8, MAX_PUSH_RUN_AGENTS = 64` in `remote-host.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `remote-host.test.ts`:
    - `the status push carries runs, capped at 8 runs of 64 agents, and agents keep their runId`;
    - `a status without runs gets no runs field`.
  - `sync-remote-shapes.test.ts`:
    - `statusOf keeps good runs and drops a bad one without refusing the push`: two runs, one with `state: 'odd'` → one run; agents and background kept;
    - `an agent with a bad runId keeps its row without it`;
    - `a push with no runs has none`.
  - `chat-mirror.test.ts`:
    - `a call with a good workflow keeps it`;
    - `a call with a bad workflow is kept without the field`, and the whole chat push is accepted;
    - `agent info with a bad workflow field is kept without it`.

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/unit/remote-host.test.ts tests/unit/sync-remote-shapes.test.ts tests/unit/chat-mirror.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`clampStatus`.** It adds `runs: fit(v.runs, MAX_PUSH_RUNS, clampRun)` when `v.runs` is an array. `clampRun` is `isWorkflowRun` with its agents cut to `MAX_PUSH_RUN_AGENTS`.
  - **`clampAgent`.** It keeps `runId` when it is a string (`text(a.runId, MAX_STATUS)`).
  - **`agentOf`.** It adds `runId` only when `isRunId`; a bad one is dropped, not the row.
  - **`statusOf`.** For an array `runs`, it maps through `isWorkflowRun`, drops nulls and keeps the first 8, then adds `runs` when any are left. A missing `runs` or one that is not an array gives none.
  - **`isCall`.** When `v.workflow !== undefined`, it replaces the field with `isWorkflowRun(v.workflow)`, or deletes it when that is null, before it returns. `isAgentInfo` does the same for `workflow`:
    - `run` must be a string of 1–100 characters;
    - `phase` must be a string of at most 100 characters, or null;
    - `attempt` must be an integer ≥ 1.

- [ ] **Step 4: Run the tests.** Run the three files from Step 2, `tests/unit/sync-remote-wire.test.ts` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 10: The dock draws runs as groups

**Files:**
- Modify: `src/renderer/chat/chat-steps.ts:405-542` (`fillAgentsCard`, `fillAgent`)
- Modify: `src/renderer/chat/chat-view.ts` (`syncDock` :869, `fillDock`, `turnAgents`, `agentNow`, the page colour :492, `syncClock` :1218)
- Modify: `src/renderer/chat/chat.css` (by the `.chat-agents` rules near :1027)
- Test: `tests/e2e/chat-workflow.spec.ts` (new)

**Interfaces:**
- Consumes: Task 1's `WorkflowRun`, `runHead`; Task 3's `ChatToolCall.workflow`; Task 2's stand-in step.
- Produces, in `chat-steps.ts`:
  ```ts
  export type AgentCardRow = { kind: 'agent'; agent: ChatSubagent } | { kind: 'run'; run: WorkflowRun }
  export function fillAgentsCard(box: HTMLElement, rows: AgentCardRow[], o?: { open?(agentId: string): void; current?: string | null }): void
  export function cardAgents(rows: AgentCardRow[]): ChatSubagent[]   // every agent row in drawing order, run agents as ChatSubagent (below)
  export function cardRunning(rows: AgentCardRow[]): boolean
  ```
  - **The DOM.** Each run is `div.chat-run[data-run=<run.key>]`. It holds a head `div.chat-agent.chat-run-head` and a body `div.chat-run-body`. The head's type column is `span.chat-run-chevron` (▾/▸) plus the name. The body holds `div.chat-run-phase` lines and `div.chat-agent.chat-run-agent[data-agent=<id>]` rows.
  - **A run agent as `ChatSubagent`.** `id` is the `agentId`, or `` `${run.key}:${row.key}` `` without one. `type` is the label, `description` the task or `''`. `state`, `ms`, `model`, `effort` and `startedAt` come from the row when not null.
  - **The `attempt N` chip.** For `attempt > 1`, a `span.chat-agent-attempt` goes before the description text.
  - **Buttons.** A row is a button (role, tabindex, title, Enter/Space) only when `o.open` is given and it has a real agent id.
  - **Folding.** The head folds and unfolds the group on click or Enter/Space; `data-folded` is set on `.chat-run`. Until the person toggles it, a run is folded exactly when it is not running. A toggle is kept on the element (`data-fold="open"` or `"closed"`) while it lives.

- [ ] **Step 1: Write the failing e2e test** `tests/e2e/chat-workflow.spec.ts` (`launchChatTab`, `sendMessage` from `chat-helpers.ts`; selectors like `chat-agent-page.spec.ts`). Script: one turn, `[{ workflow: { name: 'crash-triage', phases: ['Triage'], agents: [{ label: 'triage-a', task: 'Look at crash 1', attempts: 2 }, { label: 'triage-b', task: 'Look at crash 2' }], gate: 'end' } }, { text: 'Started.' }]`.
  - `a run shows live in the dock as a group: head, phase, rows and the attempt chip`:
    - `DOCK .chat-run-head .chat-agent-type` has `crash-triage`;
    - its `.chat-agent-desc` matches `/^Triage · \d of 2 done$/`;
    - `.chat-run-phase` is `Triage`;
    - two `.chat-run-agent` rows with `triage-a` and `triage-b`;
    - `.chat-agent-attempt` is `attempt 2`;
    - the dock head is `2 agents · 0 done` (a retry is the same row);
    - the step row of the Workflow call shows `crash-triage` and `2 agents`.
  - `the group folds when the run ends, and a click unfolds it`:
    - write `<config>/end`;
    - `.chat-run` gets `data-folded`, the head reads `done · …`, and the rows are hidden;
    - a click on the head shows them.

    The dock closes 4 s after nothing runs. Click within that time, or check `.chat-run[data-folded]` before the close.
  - `a run agent's row opens its page`: a click on `triage-b` opens `.agent-page` (the header is Task 11's).

- [ ] **Step 2: Run it to see it fail.** Run: `node scripts/e2e.mjs tests/e2e/chat-workflow.spec.ts --workers=1`. Expected: FAIL, no `.chat-run`.

- [ ] **Step 3: Implement.**
  - **`chat-view`.** `dockRows` becomes `AgentCardRow[]`.
    - `turnRows()` walks the calls in order: a call's `workflow` comes first as a run row, then each of its `agents` as an agent row. That covers the calls since the person's last message, plus earlier calls' running agents and running runs.
    - `agentNow` and a new `runNow(key)` refresh the lingering rows.
    - The page colour is the index of the agent in `cardAgents(dockRows)`.
    - `syncDock` and `syncClock` use `cardRunning`.
  - **`fillAgentsCard`.**
    - The head counts `cardAgents(rows)`.
    - Colours follow the drawing order over head and agent rows: one counter, a head takes one.
    - The cleanup loop keeps a child whose `data-agent` or `data-run` is among the rows.
    - The run head carries `data-started` while running, so `tickAgentTimes` ticks it.
  - **CSS.** The rows are indented, the phase lines quiet, the chip amber. Use the theme's existing variables.

- [ ] **Step 4: Run the tests.** Run: `node scripts/e2e.mjs tests/e2e/chat-workflow.spec.ts tests/e2e/chat-agent-page.spec.ts --workers=1` and `npm run typecheck`. Expected: PASS, the agent page's existing dock tests too.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 11: The agent page of a workflow agent

**Files:**
- Modify: `src/renderer/chat/agent-page.ts` (`fillHeader` :200, the hint)
- Modify: `src/renderer/chat/agent-column.ts:357` (the prompt fold it passes)
- Modify: `src/renderer/chat/chat-items.ts:59-95` (`PromptFold`, `promptItem`)
- Modify: `src/renderer/chat/agent-text.ts` (new `RUN_HINT`)
- Modify: `src/renderer/chat/chat.css` (`.agent-attempt`, `.agent-hint-run`)
- Test: `tests/e2e/chat-workflow.spec.ts`

**Interfaces:**
- Consumes: Task 4's `ChatAgentInfo.workflow`; Task 5's tail; Task 10's dock rows.
- Produces:
  - `export const RUN_HINT = 'The agent answers in the main conversation, not to its workflow'`;
  - `PromptFold.asker?: string`. `promptItem` heads a first prompt `` `${fold.asker ?? 'Claude'} asked` ``;
  - `AgentColumn.setAsker(asker: string | undefined): void`, called by the page from `agent.workflow`.

- [ ] **Step 1: Add the failing e2e test** to `chat-workflow.spec.ts`: `a workflow agent's page: header, the workflow's prompt, the hint, and new lines while it runs`. Use the Task 10 script, with `later: { gate: 'later', text: 'Second look' }` on `triage-a`.
  - Click `triage-a`'s row. Expect:
    - `.agent-type` is `crash-triage · Triage`;
    - `.agent-desc` is `triage-a — Look at crash 1`;
    - `.agent-attempt` is `attempt 2`;
    - the first `.chat-prompt-head` is `The workflow asked`;
    - `.agent-hint-run` is the RUN_HINT text;
    - the input's placeholder is `Message the triage-a agent…`.
  - Write `<config>/later`. Within 10 s the column shows `Second look`, and the first item is still the same element (no redraw: hold a handle to it before and check `isConnected` after).

- [ ] **Step 2: Run it to see it fail.** Run: `node scripts/e2e.mjs tests/e2e/chat-workflow.spec.ts --workers=1`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **With `a.workflow` set:**
    - the type chip is `` `${w.run}${w.phase ? ` · ${w.phase}` : ''}` ``;
    - the description is `` `${a.type} — ${a.description}` `` (just the type when the description is empty);
    - a `span.agent-attempt` shows `attempt N` for N > 1, else it is hidden;
    - a second hint node `div.agent-hint-run` under `.agent-hint` shows `RUN_HINT`;
    - the column's asker is `The workflow`.
  - **Without `a.workflow`,** the new nodes are hidden, and the page is as today.

- [ ] **Step 4: Run the tests.** Run: `node scripts/e2e.mjs tests/e2e/chat-workflow.spec.ts tests/e2e/chat-agent-page.spec.ts --workers=1` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 12: The ⚙ segment and its card

**Files:**
- Create: `src/renderer/agents-card.ts`
- Modify: `src/renderer/status-bar.ts` (`statusSegments` :116-145, the constructor's callbacks :240, `markSegment` :320)
- Modify: `src/renderer/main.ts` (construction ~1740-1770, `onStatus` ~1785, tab switches ~1133 and ~2070)
- Modify: `src/renderer/index.html:26` (`<div id="agents-card" hidden></div>` beside `#plan-list`), `src/renderer/styles.css` (by `#plan-list` :667, and the no-drag list :20)
- Modify: `README.md:62`
- Test: `tests/unit/status-bar.test.ts`, `tests/e2e/status.spec.ts`

**Interfaces:**
- Consumes: Task 8's `StatusUpdate.runs` and `AgentStatus.runId`; Task 10's `fillAgentsCard`, `AgentCardRow`, `tickAgentTimes`.
- Produces:
  ```ts
  // status-bar.ts
  export const AGENTS_TITLE = 'Agents — click for the list'
  export function agentsText(u: StatusUpdate): string | null      // the segment's text, null: no segment
  // StatusBar constructor gains a 7th callback: onAgentsClick: (anchor: HTMLElement) => void = () => {}
  // agents-card.ts
  export function statusRows(u: StatusUpdate): AgentCardRow[]     // bare agents and runs, by start time
  export class AgentsCard {
    constructor(el: HTMLElement, onClosed: () => void, open: (agentId: string) => void)
    get isOpen(): boolean
    toggle(anchor: HTMLElement, u: StatusUpdate, chat: boolean): void
    update(u: StatusUpdate | null, chat: boolean): void
    close(): void
  }
  ```

- [ ] **Step 1: Write the failing tests.**
  - `status-bar.test.ts`:
    - Change line 29's expected title to `AGENTS_TITLE`.
    - `the segment counts run agents and names each run`. Bare `opus·high` agent `b1`; run `crash-triage` running with agents `a1` and `a2` running (both in `agents` with `runId`) → text `⚙ 3: opus·high, crash-triage ×2`, title `AGENTS_TITLE`.
    - `a kept finished run shows with a mark`. No agents; run done → `⚙ crash-triage ✓`; failed or stopped → `⚙ crash-triage ✕`.
    - `nothing running and no run: no segment`.
    - `statusRows puts a bare agent and a run in start order, and no run agent twice`.
  - `status.spec.ts`:
    - Change line 53 to expect the `title` `Agents — click for the list`.
    - Add `a workflow run shows as a group in the ⚙ card of a terminal tab, and stays folded until the next prompt`:
      1. Set up as the first test: a temp project with `subagents/workflows/wf_e2e-run1/` holding `journal.jsonl` (started `a1` / `a2`, phase `Triage`) and `agent-a1.jsonl` / `agent-a2.jsonl` (`assistantLine('claude-haiku-5-5', 'low')` plus a first user line with the task). Add a main transcript line with the `toolUseResult` of Task 7.
      2. Send pipe `session`, `status`, then `subagent` start `a1` and `a2`.
      3. Expect the segment `⚙ 2: crash-triage ×2`.
      4. A click opens `#agents-card`: `.chat-run-head .chat-agent-type` is `crash-triage`, with two `.chat-run-agent` rows. Their rows are not buttons (`role` absent).
      5. Esc closes it; a second open and a mousedown on `#terminals` closes it too.
      6. Append `result` lines, send `subagent` stop for both, write `<session>/workflows/wf_e2e-run1.json` with `status: 'completed'`. Expect `⚙ crash-triage ✓`.
      7. Send `{ v: 1, type: 'turn', tabId, sessionId: SID }`. Expect `.status-agents` count 0.
  - Update the in-place tooltip test at `status.spec.ts:184` if it names the agents title.

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run tests/unit/status-bar.test.ts` and `node scripts/e2e.mjs tests/e2e/status.spec.ts --workers=1`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`agentsText`.**
    - N = `u.agents.length`.
    - The groups are the bare agents' `agentGroups`, then each run in order: running → `` `${name} ×${its running agents}` `` (just `name` when 0), done → `` `${name} ✓` ``, failed or stopped → `` `${name} ✕` ``.
    - The text is `` `⚙ ${N}: ${groups}` `` when N > 0, else `` `⚙ ${groups}` `` when there are runs, else null.
  - **The segment.** `markSegment` makes `.status-agents` a button (`role`, `tabindex`, `aria-expanded`) in both kinds of tab. The click handler calls `onAgentsClick(seg)`.
  - **`AgentsCard`.** It copies `PlanList`'s open, place, Esc and mousedown handling; the mousedown ignores `.status-agents`. It draws with `fillAgentsCard(el, statusRows(u), chat ? { open } : {})`. While open, it runs a 1 s `setInterval` of `tickAgentTimes(el)`, cleared on close. `update` closes it when `u` is null or has no rows.
  - **`main.ts`.**
    - construct it beside `planList`;
    - the 7th `StatusBar` callback toggles it with the active tab's status and `chat` (the tab shows its chat);
    - `onStatus` for the active tab calls `update`;
    - close it wherever `planList.close()` is called on a tab switch;
    - `open` calls the active tab's `chat.openAgent(agentId)`.
  - **CSS.** `#agents-card` is fixed like `#plan-list`, with `width: min(640px, calc(100vw - 16px))`. Its `.chat-agents-list` gets a `max-height` of about ten rows.
  - **README.md:62.** Replace "Hover for exact token counts and a list of the agents with their tasks." with "Hover for exact token counts, and click ⚙ for a list of the agents with their tasks, a Workflow run's agents grouped by run."

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/status-bar.test.ts`, `node scripts/e2e.mjs tests/e2e/status.spec.ts tests/e2e/chat-status.spec.ts --workers=1` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

### Task 13: A member's ⚙ card shows the host's run

**Files:**
- Test: `tests/e2e/chat-devices.spec.ts` (or the paired-devices spec whose helpers fit best: look at how `chat-devices.spec.ts:443` reads a member's `#statusbar`)
- Modify: only what the test proves missing (for example the member's status view handing `runs` to `AgentsCard`)

**Interfaces:**
- Consumes: Tasks 8, 9 and 12.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test** `a member device's ⚙ card shows the host's run`. Pair two apps as the file's tests do. On the host's terminal-like Claude tab, drive the run with pipe messages and files as in Task 12. On the member:
  - the attached tab's segment reads `⚙ 2: crash-triage ×2`;
  - a click opens `#agents-card` with the `crash-triage` group;
  - its rows are not buttons.

- [ ] **Step 2: Run it.** Run: `node scripts/e2e.mjs tests/e2e/chat-devices.spec.ts --workers=1 -g "⚙ card"`. Expected: FAIL if the member's view drops `runs`. If it passes at once, check that it would fail with `runs` removed from `clampStatus` (Task 9), then restore.

- [ ] **Step 3: Fix what fails,** within the member's status path (`tab-viewer.ts` `parsePush`, the renderer's status of an attached tab).

- [ ] **Step 4: Run it.** Same command, and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave the changes uncommitted.**

---

## After the last task

- One final review of the whole branch, by one reviewer, covering every axis (the person's rule).
- Then the full `npm test` and `npm run test:e2e` run in CI on all three systems. Failures found there are fixed after CI.
- Delete the mockups' temp folder `%TEMP%\wf-mock` once the spec is approved (the controller's chore, not a task).
