# Workflow agents in the agents lists — design

Date: 2026-11-19
Status: draft 3, checked against the code; the person's answers in; for approval
Builds on: `2026-11-12-agent-chat-design.md` (the dock and the agent page), `2026-11-11-chat-mode-design.md` (the chat), and the
fix `0dd2d80` (agents an API error or a usage limit stopped leave the status bar). `0dd2d80` is not in `origin/master` yet;
see *Before the work*.

## Why

A user of the app reported 30 rows `workflow-subagent · … · 1001 min` under the status bar's ⚙ after a Workflow run. The
rows that stayed are fixed by `0dd2d80`, but a run's agents still show badly everywhere:

- in the ⚙ tooltip they are bare rows: no model ("…"), no description, no run, no phase;
- the chat's dock and agent page do not show them at all.

The person's words: "Workflow agents should be shown in the agents list in general, not only in this little status bar", and
"show them exactly as when the main session starts a subagent".

## Background: what exists

**ClaudeTerm's lists of the tab's own subagents** (no other list shows subagents):

- **The status bar's ⚙ segment** (`src/renderer/status-bar.ts:134`), in terminal and chat tabs. It hides while the status
  has no `main` (`status-bar.ts:118`); in a chat tab `main` comes from the chat (`src/main/index.ts:1351`).
  - Its text is `⚙ N: opus·high ×2, …`; its native tooltip has one line per running agent:
    `type · model·effort · N min · "description"`.
  - Its data comes from `StatusHub` (`src/main/status-hub.ts`). Agents arrive with the SubagentStart hook and leave with
    SubagentStop. A chat tab's Claude Code runs the tab's hook settings too (`sdk-engine.ts:270`), so its agents come the
    same way. Model and effort come from the transcript feed (`onSubagentInfo`), the description from
    `subagents/agent-<id>.meta.json` (`readMeta`, `src/main/index.ts:703`).
  - The segment has no click action. Members get the status through `pushToMembers(tabId, 'status', …)`
    (`index.ts:693`), which the host clamps field by field (`clampStatus`, `src/main/sync/remote-host.ts:970`).
- **The chat's dock** (`fillAgentsCard`, `src/renderer/chat/chat-steps.ts:411`; `syncDock`/`turnAgents`,
  `src/renderer/chat/chat-view.ts:869`).
  - Its head reads "N agents · M done", then one row per agent: state, type, description, `model · effort · ctx`, and a
    running time with a bar, or `done · 2m 30s` / `failed`.
  - Its rows are the `agents` of Task/Agent and SendMessage tool calls (`chat-fold.ts`, `chat-view.ts:902`). The dock shows
    while one runs and closes 4 s after the last ends (`DOCK_LINGER_MS`). It scrolls past five rows (`chat.css:1027`).
  - A row opens the agent's page (`agent-page.ts`). The page reads `subagents/agent-<id>.jsonl` backward
    (`readAgentPage`) and takes live frames from the stream. An agent the stream never announced cannot be opened, and
    nothing re-reads a running agent's transcript.
  - The page's first item is headed "Claude asked" by the renderer, from the item's `first` flag alone
    (`chat-items.ts:91`). Its hint is one string (`agent-page.ts:206`).
- **The transcript feed** (`src/main/transcript-feed.ts`) reads every subagent transcript in `subagents/` as a source of its
  own. Each line feeds the model and effort (`onSubagentInfo`), the Changes panel's edits (`onEditEvent`), the Media
  panel's images (`onImage`), and the other checks of `consume` (`transcript-feed.ts:405`). Run folders under
  `subagents/workflows/` are not read today, so a workflow agent's edits and images do not reach those panels.

**What Claude Code gives for a Workflow run.** Checked with real runs on Claude Code 2.1.328.

- **Hooks.**
  - SubagentStart and SubagentStop with `agent_type: "workflow-subagent"` and the agent's id, but no run id.
  - An API error that ends an agent's turn sends StopFailure with its `agent_id` and no SubagentStop (handled by `0dd2d80`).
  - The turn end's (Stop's) `background_tasks` lists the run as one task: `{id, type: "workflow", status, description,
    name}`, whose `id` is the Workflow result's `Task ID` (seen as `w9ehhq53f` in both).
- **The stream** (the chat's SDK session):
  - `task_started` with `task_type: "local_workflow"`, `workflow_name` (the script's `meta.name`), `description` and the
    Workflow call's `tool_use_id`;
  - `task_progress` and the final `task_notification` carry `workflow_progress`, the whole run each time:
    - `{type: "workflow_phase", index, title}`;
    - `{type: "workflow_agent", index, label, phaseIndex, phaseTitle, agentId?, model, state, startedAt?, queuedAt, attempt?,
      promptPreview, lastToolName?, lastToolSummary?, tokens?, toolCalls?, durationMs?, resultPreview?}`;
  - `state` was seen as `start`, `progress` and `done`; Claude Code also writes `error`. `workflow_progress_omitted`
    counts rows left out.
  - **`workflow_progress` is not in the SDK's public types (0.3.322): an undocumented format.**
  - No frame of a workflow agent's own conversation comes through the stream.
  - Today `ChatModel.system` drops `task_progress`, and `task_started` links only Task/Agent/SendMessage calls
    (`chat-fold.ts:374`), so a run's `task_notification` finds no link and its "workflow ended" message shows as an event
    row in the conversation.
- **Files** in the session folder `<projects dir>/<sessionId>/`:
  - `subagents/workflows/<runId>/journal.jsonl`, written as the run goes:
    - `{"type":"launched"}`;
    - `{"type":"started","key","agentId","label","phase"}`;
    - `{"type":"result","key","agentId","result",…}`;
    - `{"type":"failed","key","agentId"}`.

    A retry starts the same `key` again under a new `agentId`.
  - `subagents/workflows/<runId>/agent-<id>.jsonl`: the agent's transcript. Its first user message is the task, framed by
    "[Workflow harness — computed task] …".
  - `subagents/workflows/<runId>/agent-<id>.meta.json`: `description` (= the label), `workflowPhase`, `model`, ….
  - `workflows/<runId>.json`, written when the run ends: `runId`, `taskId`, `workflowName`, `status`, `startTime`,
    `durationMs`, `agentCount`, and `workflowProgress` (the same rows as the stream).
  - `runId` looks like `wf_55e3c3ec-b29` (Claude Code checks `^wf_[a-z0-9-]{6,}$`).
- **The main transcript.**
  - The Workflow call's result line has `toolUseResult: {status: "async_launched", taskId, taskType, workflowName, runId,
    transcriptDir, scriptPath}`. The transcript feed sees this raw line.
  - Its text says `Task ID: <taskId>` and `Transcript dir: …\subagents\workflows\<runId>`.
  - The chat's history comes from the SDK's `getSessionMessages`, which keeps the text but drops `toolUseResult`.
- **Writing to a workflow agent.**
  - `SendMessage` with a workflow agent's id resumes it as an ordinary background subagent (`task_started` with
    `task_type: "local_agent"`, the same id). The agent received the message, and its answer went to the main conversation.
  - `ListAgents` does not list it.

## Goals

1. **The same lists.** A Workflow run's agents show wherever the main conversation's subagents show, and look the same: the
   chat's dock, the agent page, and the status bar's agents list.
2. **A run is a group.**
   - A head row reads `<name> · <current phase> · N of M done`, and under it come the run's agents by phase.
   - A retry stays the same row, marked `attempt 2`.
   - A run that ended folds into its head row.
3. **The ⚙ card.** A click on the status bar's ⚙ opens a card with the dock's own rows, ordinary subagents and runs alike, in
   terminal and chat tabs.
4. **A finished run stays in the card.** It stays folded until the session's next prompt.
5. **Less, not broken.** Each source is optional. When one is missing or changes shape, less shows and nothing breaks.

## Non-goals

- Stopping a run or one of its agents from these lists. The background task's ✕ in a chat tab stays the way to stop a run.
- Showing a run's script, logs or result.
- Remote runs (`task_type: "remote_agent"`) and agent teams.
- Restoring a folded or unfolded state after the app restarts.

## Anti-goals: it fails even if it looks right when

- A running agent leaves a list, or an ended one shows as running (the `0dd2d80` bug again). This includes a run left
  spinning after Claude Code exits, a turn is interrupted, or the history is reloaded.
- An agent shows twice: once bare, once in its group.
- An id or a name from the stream or a file builds a path outside the session's folder.
- A run of 50 agents with retries makes typing lag, or the dock grows past its cap.
- A finished run keeps the tab "working" (its spinner, a coordinator's busy flag).
- One bad field from a member or a file makes the whole status or chat push be refused.
- An open agent page jumps or redraws while its transcript is re-read.

## Decisions

The person's:

- Show workflow agents everywhere subagents show, looking the same (mockups 1–3).
- A run is a group: a head row, agents by phase, `attempt N`, folded when ended (mockups 1–2).
- The ⚙ list is a card like the dock, opened by a click (mockups 6–7). Ordinary subagents get it too, in place of the
  tooltip's list.
- A finished run stays in the status bar's card, folded, until the next message (mockups 5 and 7).
- Approach A: each view keeps its own source.
  - The chat takes the stream live, and `workflows/<runId>.json` after a restart.
  - The status bar takes the hooks and the run folder.
  - Both turn into one shape of rows.
- English labels (`1 of 3 done`, `attempt 2`). The agent's label goes in the type column. The segment counts a run as
  `crash-triage ×2`. The dock keeps its scroll past five rows.
- The agent page of a workflow agent keeps the ordinary composer, with the hint "The agent answers in the main
  conversation, not to its workflow".
- A workflow agent's transcript is read like any subagent's: its edits show in the Changes panel and its images in the
  Media panel.
- An agent the main session writes to after its run ended shows as an ordinary subagent row while it runs, not inside its
  run's group.
- The branch is built on the fix `0dd2d80`; the feature's pull request goes after the fix's.

The controller's calls are marked *(controller's call)* where they are made.

## Approaches

- **A. Each view its own source (chosen).** The chat already builds its rows from the stream and the status bar from the
  hooks; each keeps that, and both feed one row shape. The chat gets what only the stream has, live: attempts, the agent's
  task, tokens. The cost is two readers: the stream and the run folder.
- **B. The run folder for both views.** One reader, polled by the transcript feed. The chat would update only as the folder
  is polled, and would lose the stream's attempts and live state.
- **C. Hooks only.** Rejected: the hooks carry no run id, so nothing can be grouped.

## Before the work

`0dd2d80` sits on `worktree-fix-workflow-agents-linger` and `integration/local-master`, not on `origin/master`. Its parent is
`6e47d0b`. The branch `worktree-feat-workflow-agents-list` has been fast-forwarded to `0dd2d80` (no new commit), so the
StopFailure stop and the agentless-tasks net are there to build on. The feature's pull request goes after the fix's.

## What the person sees

### The rows (one drawing for the dock and the card)

- **An ordinary subagent's row** is unchanged.
- **A run's head row** fills the same columns:
  - the state: a ring while it runs, ✓ done, ✕ failed or stopped;
  - a chevron (▾ open, ▸ folded), then the run's name in the type column;
  - the description `<current phase> · N of M done`. The current phase is the phase of the agent started last. It is left
    out when the run has no phases. M counts the agent calls known so far;
  - `workflow` in the meta column;
  - the run's running time and bar, or `done · 2m 14s`, `failed` or `stopped`.
- **A phase line** is the phase's title, quiet, indented under the head. There is none when the run has no phases.
- **A run agent's row** is an ordinary row, indented:
  - its label in the type column;
  - its task in the description: the stream's `promptPreview`, or in the status bar the task from its transcript (below);
  - its model family and effort in the meta column;
  - its time and bar, or `done · 41s` / `failed`.

  A retried agent has an `attempt N` chip before its description (amber, quiet).
- **Order.** Rows keep their start order. A run sits where it started (its `task_started`, or its first agent).
- **The card's head** reads `N agents · M done` and counts the run agents too.
- **Folding.**
  - A run folds when it ends. A click (or Enter/Space) on a head row folds or unfolds it.
  - While the card or dock lives, a run keeps the folding the person gave it *(controller's call)*. A run's element is keyed
    by a key that never changes (below), so the folding survives the run's id becoming known.
- **Colours.** Each agent row takes its colour by its place among the card's agent rows, as today. A run's head takes the
  next colour *(controller's call)*. The agent page takes the same colour as its row.

### The chat's dock

- **Rows.** The dock lists the subagents it lists today, plus the runs of Workflow calls in the same window: the calls since
  the person's last message, plus runs of earlier turns that still run.
- **Opening and closing.** The dock opens while any subagent or run agent runs, and closes 4 s after none does, as today.
  The list still scrolls past five rows; a group's rows count.
- **Clicks.**
  - A run agent's row opens its agent page; the open one is marked.
  - A head row folds or unfolds.
- **The Workflow call's step row.** Its subject is the run's name (empty today). Its detail is `N agents`.
- **The run's end in the conversation.** The "workflow ended" event row stays, as today *(controller's call)*.
- **An agent written to after its run.** When the main session's `SendMessage` resumes a workflow agent, it shows
  as an ordinary subagent row on that SendMessage call, as any agent written to does today. Its run's group keeps the
  agent's row from the run, ended.
- **Claude Code exits, a turn is interrupted, or the history is reloaded:** a run still running ends as `stopped`, and its
  running agents as failed, as running background agents end today.

### The agent page of a workflow agent

- **The page is the same page.** Its header differs in three places:
  - the type chip reads `<run name> · <phase>`;
  - the description reads `<label> — <task>`;
  - an `attempt N` chip shows for a retried agent.
- **The column** comes from the agent's transcript `subagents/workflows/<runId>/agent-<id>.jsonl`.
  - Its first item, the task, is headed "The workflow asked" instead of "Claude asked".
  - The harness framing around the task is dropped when it is recognised.
- **Live updates.** No frame comes live. While the page shows and the agent runs, the new lines of its transcript are read
  every 2 s *(controller's call; the builder may tune the interval)* and added to the column as new items. The column does
  not redraw or jump.
- **Writing.** The ordinary composer: the person's message is forwarded with `SendMessage`, as for any subagent. Under the
  usual hint a second line reads "The agent answers in the main conversation, not to its workflow". The placeholder reads
  `Message the <label> agent…`.
- **Members** read the page, read-only, as today.

### The status bar

- **The segment's text.** It reads `⚙ N: <groups>`:
  - N counts the running agents, ordinary and run agents.
  - Ordinary agents are grouped by model·effort, as today.
  - A running run reads `<name> ×<its running agents>`.
  - A finished run kept in the card reads `<name> ✓` (or `✕` when it failed or stopped).
  - With nothing running but a kept run, the text is `⚙ <name> ✓`.
  - The segment hides when there is nothing to show, and while the status has no `main`, as today.
- **The segment's tooltip** becomes `Agents — click for the list` *(controller's call)*. The README's "Hover for … a list of
  the agents with their tasks" becomes "click ⚙ for a list of the agents with their tasks".
- **The card.** A click on the segment opens it above the segment, as the plan list and the background tasks' list open:
  - its head and rows as above;
  - it updates live while open, and its times tick every second;
  - Esc, a click outside, or a second click on the segment closes it;
  - its width is about 640 px, capped by the window; its list scrolls past ten rows *(controller's call)*.
- **Clicks in the card.**
  - In a chat tab, a run agent's row or an ordinary row opens the agent page, as in the dock.
  - In a terminal tab, the rows are not buttons; head rows still fold.
- **What the card holds.**
  - Ordinary subagents: the running ones, as today. They leave at their stop.
  - A run: its agents, with their states. When the run ends it stays, folded, until the session's next prompt
    (UserPromptSubmit), the session's end, or another session in the tab *(controller's call: any prompt counts, the
    person's own message, a forward from an agent page, Review's Send or an auto-continue; the hook does not say who wrote
    it)*.
  - An agent written to after its run ended shows as an ordinary row while it runs, not inside the kept run.
- **The tab's activity** (its spinner, the coordinator's busy flag) counts running agents only.

### The Changes and Media panels

A workflow agent's transcript is read like any subagent's. Its file edits show in the Changes panel and its images in the
Media panel, as an ordinary subagent's do.

### Other devices

- **The status push carries the runs.**
  - The host caps them: 8 runs, 64 agents per run *(controller's call)*.
  - A member checks them on their own: a run that fails the check is dropped, not the whole push.
  - An older member drops the new field. It still sees every running agent as a bare row, because running agents stay in
    `agents` (below).
- **A member's dock** gets runs through the mirrored chat items, as it gets subagents today. An older member's call check
  (`chat-mirror.ts:67`) keeps a call with the new `workflow` field and ignores it, so no down-conversion is needed.
- **The card** opens on a member as on the host, read-only.

## How it works

### One shape (`src/shared/workflow.ts`, new, pure)

```ts
export type RunState = 'running' | 'done' | 'failed' | 'stopped'
export interface WorkflowRun {
  key: string           // never changes: the Workflow call's tool_use id in the chat, the runId in the status bar
  runId: string | null  // wf_…, once known
  taskId: string | null // the background task's id, once known
  name: string          // workflow_name; 'workflow' when not known
  state: RunState
  startedAt: number | null
  ms: number | null
  phases: { index: number; title: string }[]
  agents: WorkflowAgentRow[]
}
export interface WorkflowAgentRow {
  key: string           // one per agent call: the stream's index, the journal's key
  agentId: string | null
  label: string
  phase: number | null  // index into phases
  state: 'running' | 'done' | 'failed'
  attempt: number       // 1 for a first try
  model: string | null
  effort: string | null
  task: string | null
  startedAt: number | null
  ms: number | null
}
```

- **`parseWorkflowProgress(rows: unknown): { phases, agents } | null`** turns the stream's and the run file's rows into this
  shape.
  - States: `start` and `progress` → running, `done` → done, `error` → failed, an unknown state → running.
  - Caps: 200 agents, 20 phases, labels and titles of 100 characters, tasks of 200.
  - An `agentId` must pass `isAgentId`, numbers must be finite; unknown row types are skipped.
- **The journal's fold** (`foldJournal(lines)`), pure, turns `started` / `result` / `failed` lines into the same agent rows.
  - The key is the journal's `key`; `attempt` counts its `started` lines.
  - The phases are the distinct `phase` names in the order they first come.
- **`isWorkflowRun(v)`**, the check a member and the chat mirror use: it returns the run cleaned and capped, or null.
- **When a run ends,** an agent row still `running` is shown as failed *(controller's call)*.
- **`sameRun(a, b)`** tells whether a progress message changed anything, so an unchanged one sends nothing.

### The chat (main)

- **`ChatToolCall` gets `workflow?: WorkflowRun`.** `chat-fold.ts` keeps it:
  - `task_started` with `task_type: "local_workflow"` whose `tool_use_id` is a Workflow call starts the run: key the call's
    id, `taskId` the task id, name `workflow_name`. A `call` patch sets the call's subject to the name (the step row
    redraws its subject on every fill, `chat-steps.ts:300`). The task is linked in a map of runs of its own, apart from
    `tasks`;
  - `task_progress` for that task with `workflow_progress` replaces the run's phases and agents. A progress that changes
    nothing sends no patch;
  - `task_notification` for that task ends the run: completed → done, failed → failed, killed or stopped → stopped.
    `usage.duration_ms` is its `ms`, and its rows are taken when given. The task id is not added to `ended`, so the
    "workflow ended" event row stays (`chat-model.ts:645`);
  - `ChatModel.system` routes `task_progress` to the fold; today it drops it.
  - `failRunning` (`chat-fold.ts:490`, used by `processEnded` and `historyLoaded`) also ends a call's running run as
    `stopped`, though the call itself is already done after `async_launched`.
  - The runId comes from the Workflow result's text (`Transcript dir:` line). It is used only when its last segment matches
    `^wf_[a-z0-9-]{6,}$`.
- **Records for the page.** `AgentChats` gets a method of its own for run agents (`known()` does not fit: it never records
  a running agent, never updates a record, and keeps no run). The hub calls it with each run agent that has an `agentId`
  whenever the run's rows change:
  - it creates or updates the record: type the label, description the task, state running / done / failed, the run's
    name, phase, attempt and runId;
  - a change of state or of these fields sends an `agentPatch`, so an open page's header follows;
  - run agents' records have their own cap (400), apart from `MAX_AGENT_RECORDS`, so a big run never evicts ordinary
    agents' records *(controller's call)*.
- **`ChatAgentInfo` gets `workflow?: { run: string; phase: string | null; attempt: number }`.** The page draws its type
  chip, its `attempt` chip and the "The workflow asked" heading from it. An older member's check keeps the info with the
  field and ignores it.
- **The transcript's path.** `agentFile` (`chat-hub.ts:1233`) builds `subagents/workflows/<runId>/agent-<id>.jsonl` for a run
  agent. The check is a variant of `resolveAgentTranscript` (`agent-history.ts:36`) anchored at the project folder five
  levels up, not three, so a `subagents` or `workflows` junction leading out is refused.
- **The page's re-read.** `ChatHub.watchAgent` and its `views` (`chat-hub.ts:603`) know every viewer, the window's and the
  members'. While one views a run agent that runs, a forward tail (`LineTailer`, `transcript-feed.ts:17`) reads the
  transcript's new lines every 2 s. They are folded into the page's head, skipped when their key is already in
  `head.keys`, and sent as add and set patches, never as a `reset`. The tail stops when the last viewer leaves or the agent
  ends.
- **History.** `ChatHub.loadHistory` finds Workflow calls whose result text names a runId, and reads
  `<session dir>/workflows/<runId>.json`: at most 1 MB, realpath inside the session folder. The session folder is
  `dirname(d.transcript(tabId, sessionId))` joined with the session id. The file is read before `historyLoaded()` and
  before the run agents' records are made. It applies the file's status and rows as a final `task_notification` would. A
  run without the file shows its head only, as `stopped`.

### The status bar (main)

- **The transcript feed.**
  - **Main transcript.** A line whose `toolUseResult` has `runId`, `workflowName` and `taskId` (prefilter: the line
    includes `"runId"`) calls `onWorkflowRun({ runId, name, taskId })`.
  - **Run folders.** The subagent scan also lists `subagents/workflows/`: run folders whose name matches the runId pattern,
    the 8 newest.
    - It tails each run's `journal.jsonl` (`onWorkflowJournal(runId, lines)`).
    - Each `agent-*.jsonl` in a run folder becomes a source like a subagent's, so model and effort come through
      `onSubagentInfo` and edits and images reach their panels. Sources are keyed by their path below `subagents/`, not by
      the bare file name (`transcript-feed.ts:273`), so two runs' files never collide.
    - The first user line of a run agent's transcript gives its task, once per agent (`onWorkflowTask(runId, agentId,
      task)`; harness framing dropped, 200 characters).
    - The run folder's realpath must be inside the session's `subagents` folder.
  - **Run file.** It notices `<session>/workflows/<runId>.json` and reads its status and rows once (`onWorkflowEnd`).
  - The existing backoff and wake rules apply to these sources too.
- **`StatusHub`** keeps a tab's runs:
  - **Building them.** Runs are built from the journal fold, named and given their task id by `onWorkflowRun`, and ended by
    `onWorkflowEnd`.
  - **Which agents run.** The hooks still decide this. A run agent whose id got SubagentStop (or the StopFailure stop) is
    done, unless the journal says failed. One that got SubagentStart is running.
  - **Linking.** `AgentStatus` gains `runId?`, set once the agent's id shows in a run's journal and the run is still
    running. Until then it is a bare row, as today. An agent that starts again after its run ended stays bare.
  - **Kept runs.** A run that ended is kept, folded, until `turn(tabId, sessionId)`, the session's end or switch, or
    `resetTab`. `index.ts`'s `turn` pipe handler (`index.ts:2811`) calls `statusHub.turn`.
  - **The turn end's check, per run** (new, beside `0dd2d80`'s net): at a turn end with a background list, a running run
    whose task id is known ends as `stopped` when that id is not listed; one whose task id is not known ends when no task
    of type `workflow` is listed.
  - `readMeta` also looks in the agent's run folder, once its run is known.
- **`StatusUpdate` gains `runs?: WorkflowRun[]`**, absent meaning none, as `statusOf` treats `background`
  (`remote-shapes.ts:931`). Optional, so the tests' status literals and whole-shape assertions stay valid. `agents` stays
  the list of running agents; a run's agents are in both. The renderer draws an agent whose `runId` names a run in `runs`
  inside its group, never also as a bare row.
- **The tab's activity** (`setAgentsRunning`) stays `agents.length > 0`. `agents` holds running agents only, so a kept
  run does not count.
- **Members.**
  - `pushToMembers(…, 'status', …)` (`index.ts:693`) and `clampStatus` (`remote-host.ts:970`) carry `runs`, capped.
  - `clampAgent` (`remote-host.ts:987`) and the member's `agentOf` (`remote-shapes.ts:902`) keep `runId`; without it a
    new member would draw run agents twice.
  - The member's `statusOf` reads `runs` with a list that drops bad items (`isWorkflowRun`), not `listOf`, which refuses
    the whole push on one bad item (`remote-shapes.ts:642`).
  - The mirrored chat: a new member's `isCall` check removes a `workflow` field that fails `isWorkflowRun` and keeps the
    call, so `isItems` / `parseChatPush` (`chat-mirror.ts:146`) never refuse a push for it.

### The renderer

- **`fillAgentsCard`** (`chat-steps.ts`) takes rows that are subagents or runs, and draws run groups.
  - A row is kept by its id (`data-agent`, `data-run` with the run's `key`), as today, so the rings and bars carry on.
  - The cleanup loop (`chat-steps.ts:455`) keeps group elements; today it removes every child without `data-agent`.
  - The fold state of a run lives on its group's element.
- **The dock** (`chat-view.ts`): `turnAgents` also collects the calls' runs, and the dock shows while anything runs. The
  callers of `dockRows` follow: the page colour (`chat-view.ts:492`), the linger (`:881`) and the clock (`:1221`).
- **The ⚙ card** (`src/renderer/agents-card.ts`, new, following `PlanList`) draws through `fillAgentsCard`. It turns each
  `AgentStatus` into a subagent row, and takes `runs` as they are. It ticks its times on a 1 s timer of its own while open
  (`tickAgentTimes` runs on ChatView's clock).
- **The segment** (`status-bar.ts`): the new text and tooltip, and a click that toggles the card.
- **The agent page** (`agent-page.ts`, `chat-items.ts`): the header from `workflow`; the second hint line as a node of its
  own; the "The workflow asked" heading when the page's agent has `workflow`.
- **CSS.** The group's head, phase lines, indented rows and the `attempt` chip go in `chat.css`; the card's popover goes in
  `styles.css`, by the plan list's.

## Untrusted input

Everything here comes from Claude Code or from files it wrote, so:

- **Fields.** Every field from the stream, the journal, a meta file, a run file or a transcript is type-checked and capped.
  Unknown row types are skipped, and unknown states are mapped as above.
- **Paths.**
  - A runId must match `^wf_[a-z0-9-]{6,}$`, and an agent id `isAgentId`, before either is joined into a path.
  - Paths are resolved (realpath, compared with `pathKey`) inside the session's `subagents` or `workflows` folder. A
    junction or symlink that leads out is not read.
- **Reads.**
  - The journal is tailed like a transcript.
  - The run file is read once, at most 1 MB.
  - At most 8 run folders are watched per session.
  - A transcript's first user line gives the task; its text is capped at 200 characters.
- **Members** check the runs of a push on their own (see Other devices).

## Failure modes

- **The stream has no `workflow_progress`,** or it changes shape: the chat shows the run's head (from `task_started`) with
  no agents. The status bar still groups the agents from the journal.
- **The journal is missing or changes shape:** the status bar shows the run's agents as bare rows, as today, with their
  model when their transcript is found.
- **No Workflow result in the main transcript:** the run is named `workflow`.
- **No run file when the chat's history is read** (the app closed while the run went on, or the file was deleted): the
  run's head only, as `stopped`.
- **A run that never ends in the files** (Claude Code killed): it ends at the session's end, at a restart of the process
  (SessionStart startup/resume), or by the turn end's check.

## Tests

No test starts the real `claude` or reads the real `~/.claude`. Files go under `tmpdir()`.

### Tests that change

- `tests/unit/status-bar.test.ts:29` and `tests/e2e/status.spec.ts:53` assert the old tooltip; they move to the new one and
  the card.

### The stand-in (`tests/fixtures/fake-claude`)

- **A `workflow` step**, a new member of the `FakeStep` union (`install.ts`).
  - It emits a Workflow `tool_use`, its result with `Task ID:` and `Transcript dir:`, `task_started` (`local_workflow`,
    `workflow_name`), scripted `task_progress` rows and a `task_notification`.
  - It writes the run folder (the journal, meta files, agent transcripts) and the run file under its session folder,
    `<CLAUDE_CONFIG_DIR>/projects/<cwd>/<session>/` (`fake-claude.ts:128`).
  - It has a gate of its own that holds the run open; today's gate exists only on a background agent (`fake-claude.ts:638`).
  - The stand-in runs no hooks, so it serves the chat tests. The ⚙ card is tested in a terminal tab with pipe messages
    and files, as `status.spec.ts` does.

### Unit (`tests/unit`)

- **`workflow.test.ts`:**
  - `parseWorkflowProgress`: rows, states, caps, unknown kinds, bad ids, `workflow_progress_omitted`;
  - `foldJournal`: keys and attempts, results, failures, lines in a broken shape;
  - `isWorkflowRun`: a good run, caps, a bad field.
- **`chat-model.test.ts`:**
  - `task_started` → `task_progress` → `task_notification` give the call its run and subject;
  - an unchanged progress sends no patch;
  - a run without progress shows its head;
  - the "workflow ended" event row stays;
  - `processEnded` and `historyLoaded` end a running run as stopped;
  - history with a run file, and without one.
- **`agent-chats.test.ts`:** run agents' records are made, updated and capped apart; a state change sends an `agentPatch`.
- **`status-hub.test.ts`:**
  - runs from the journal fold, linked to hook agents by id;
  - no agent shows twice;
  - a finished run is kept until `turn`, and dropped by a session switch or end;
  - the turn end's check ends a run whose task is gone, and one with no task id when no workflow task is listed;
  - an agent that starts again after its run ended is a bare row;
  - the activity counts running agents only.
- **`status-bar.test.ts`:** the segment's text with runs, with a kept run only, and with nothing; the new tooltip.
- **Remote:** `clampStatus` and the member's parser carry runs and `runId`, cap them, and drop a bad run without refusing
  the push; a mirrored call with a bad `workflow` field is kept without it.

### Integration (`tests/integration`)

- **The transcript feed with real files:**
  - the workflows folder, the journal tail, the run file, a Workflow result in the main transcript;
  - the task read from an agent transcript's first user line;
  - a run agent's edit reaches `onEditEvent` and its image `onImage`;
  - two runs with an agent file of the same name;
  - a run folder that is a junction or symlink pointing outside is not read;
  - on Windows, an 8.3 short path for the config folder.
- **The agent history of a workflow agent:** its path, the realpath checks (a `workflows` junction leading out is refused),
  the forward re-read of new lines without a reset.
- **`ChatHub.loadHistory`** with a run file, through the stand-in.

### End-to-end (`tests/e2e`)

- **Chat:**
  - a run shows live in the dock as a group: head, phases, the `attempt 2` chip;
  - the group folds when the run ends, and a click unfolds it;
  - a run agent's row opens its page: header, "The workflow asked", the second hint line, and new lines read while it runs.
- **Status bar:**
  - in a terminal tab (hook pipe messages plus files), ⚙ shows `<name> ×N`, and a click opens the card with the group;
  - Esc and a click outside close the card;
  - a finished run stays folded until a `turn` message.
- **Member:** a member device's ⚙ card shows the host's run.

## Left to the builder

- How `fillAgentsCard` is split between rows and groups, and the card's exact size.
- The interval of the page's re-read and of the run folder scan, within the existing backoff.
- Whether `task_updated` is used as well as `task_notification`.
