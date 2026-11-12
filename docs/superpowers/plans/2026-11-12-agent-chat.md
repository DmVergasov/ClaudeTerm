# A chat with a subagent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a chat tab, a click or Enter on a subagent opens that agent's page in place of the main conversation: its conversation live and from its transcript, a header with its state, Esc back to the same place, on this device and read-only on a member. Then, only if the hand check with the person's account passes, a composer on the page sends the person's message to the agent through Claude's `SendMessage` and shows whether it arrived.

**Architecture:** Main: the SDK forwards subagent text (`forwardSubagentText`). `ChatHub` routes every subagent frame and task event to a per-chat `AgentChats` (`src/main/chat/agent-chats.ts`). Its `AgentModel`s fold frames with the main model's own folding, moved out to `ChatFold` (`chat-fold.ts`). History and older items come from `<transcript dir>/<session>/subagents/agent-<id>.jsonl`, read backward in pages (`agent-history.ts`). The window and the members get patches only for the agent page they show. Renderer: an `AgentPage` (`agent-page.ts`) with its own column (`agent-column.ts`), drawn by the chat's item renderers, takes the place of the main column and composer inside `ChatView`. The dock rows and the Agent call rows become buttons. Part B (writing): `agent-forward.ts` builds and parses the forward template. `ChatModel` draws a forward as a note and follows its delivery. `ChatHub.sendToAgent` sends it through the normal send path.

**Tech Stack:** Electron 44, TypeScript (strict), `@anthropic-ai/claude-agent-sdk` 0.3.322 (pinned), plain DOM, Vitest, Playwright, the stand-in Claude Code (`tests/fixtures/fake-claude`).

**Spec:** `docs/superpowers/specs/2026-11-12-agent-chat-design.md` (approved; read it whole). "Answers for the builder" in it binds this plan's order. Research: `.superpowers/sdd/2026-11-11-chat-mode-4-devices/research-agent-chat.md`.

**Execution:** subagent-driven. Implementers run on Haiku (the person's standing rule; fix rounds 4–5 escalate as the skill says). **Task 13 is the controller's own.** No implementer runs it.

**Builds on.** This plan runs last, on the merged result of the work below. Before Task 1 the controller checks that it has landed and that `npm run typecheck` and `npm test` are green:
1. **The chat follow-ups now in the tree:**
   - the agents dock (`ChatView.syncDock`, `fillAgentsCard(box, agents)` in `src/renderer/chat/chat-steps.ts`, `.chat-agents-dock`, rows `.chat-agent[data-agent]`, the 4 s linger, at most 5 rows);
   - the activity line (`ChatActivity` compacting / restarting) and the restart divider;
   - quoting (`src/renderer/chat/chat-quote.ts`);
   - the chat theme (`chatPalette` in `src/renderer/themes.ts`, the `--chat-*` variables in `chat.css`).
2. **MCP · Plugins** (`docs/superpowers/plans/2026-11-12-mcp-plugins.md`):
   - `itemForMembers` / `patchForMembers` in `src/main/chat/chat-mirror.ts`;
   - the `reload` item kind;
   - `TabManager.claudeEnv(tabId)` (its Task 8).
3. **Extra accounts** (`docs/superpowers/specs/2026-11-12-extra-accounts-design.md`): a sign-in account's tab runs with its own `CLAUDE_CONFIG_DIR` in that environment, and keeps its transcripts under that folder.

A name above may differ in the merged tree. Then the controller corrects this plan's references before it dispatches the task that uses the name. An implementer that does not find a name reports it; it never invents one.

## Global Constraints

- **Workspace:** work in `D:\Workspace\ClaudeTerm\.claude\worktrees\feat-redesign-look`, branch `feat/chat-mode`. Never `cd` to the main checkout. Never touch another worktree.
- **No git writes:** never commit, stash, push, reset or create branches. Leave every change uncommitted (the person's rule; the controller snapshots the tree).
- **Owned files:** edit only the files your task lists. A typecheck error or a failing test in a file your task does not list belongs to other work: never edit that file. Rerun after a few minutes, and report it if it persists. A main-process piece a renderer task needs and does not find goes to the controller. It is never built inside the renderer task.
- **Build and e2e only through the lock:** `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/<file> --reporter=line --workers=2"` (`--workers=1` on a busy machine). Unit and integration: `npx vitest run <files>`. No `npm install`.
- **No real Claude Code, outside Task 13:** no test starts the real `claude`, calls the Anthropic API, or reads or writes the real `~/.claude`, `~/.claude.json` or `%APPDATA%\ClaudeTerm`. Tests run the stand-in with `CLAUDE_CONFIG_DIR` in a temp folder. Never run the SDK's own `claude.exe`.
- **Untrusted input** — frames, task events, transcript lines, member calls and pushes:
  - every field is type-checked and capped: text 1 MiB, tool output 64 KiB, subject 500, names and ids 500;
  - unknown kinds give nothing, and nothing throws;
  - **an agent id must pass `isAgentId` (`^[A-Za-z0-9_-]{1,128}$`) before it is a map key, a path part, an IPC argument or a call argument.** A frame with a bad id is dropped, never shown in the main conversation.
- **Paths:** a transcript path is joined only from a checked agent id and a uuid session id. It is read only when its native `realpath` lies inside the real `subagents` folder, and that folder inside the real project folder, compared with `isWithin` / `pathKey`. Expect 8.3 short names, junctions and symlinks.
- **Main never blocks:**
  - transcripts are read with `fs/promises`, backward, in pages;
  - routing a frame is O(1) by map;
  - nothing scans a whole conversation per frame;
  - the window gets the patches of the agent page it shows, and nothing for other agents.
- **The rest of the chat is unchanged:** the terminal view, the main conversation and the dock's look and timing stay as they are. Only the dock rows become buttons. Every existing test keeps passing.
- **UI strings are exact** as the tasks give them (English). Comments and logs are English too.
- **Style:** match the neighbours' naming and comment density. No UI framework. Keep each file's line endings; a new file takes its neighbours' (LF in today's tree).
- **CSS:** chat styles go in `src/renderer/chat/chat.css`, in a new section "agent page". Colours are the chat theme's variables, used as the neighbours use them. The only literal colours are the dock's `AGENT_COLORS`. Motion animates only `transform` and `opacity`, and `prefers-reduced-motion: reduce` turns it off.
- **Flaky specs:** some e2e specs flake under load (`review.spec`, a fold test in `tab-panel.spec`). Rerun a failing test alone through the lock before blaming the change. Close every app a test starts; temp files go only under `tmpdir()`.
- **Done for a task** = `npm run typecheck`, its `npx vitest run …` files, and its e2e specs through the lock, all green.

## Streams

| Phase | Tasks | Owns (only these files are edited) |
|---|---|---|
| Shared, first | 1 | `src/shared/chat.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, one placeholder case each in `src/renderer/chat/chat-items.ts` and `chat-find.ts`, `tests/unit/agent-shared.test.ts` |
| **M** (main), in order | 2 → 3 → 4 → 5 → 6 → 7 → 8 | `src/main/**`, `src/shared/remote.ts`, `tests/fixtures/fake-claude/*`, `tests/fixtures/chat/README.md`, the unit and integration tests named in M's tasks |
| **R** (renderer), in order | 9 → 10 → 11 | `src/renderer/**`, `tests/unit/agent-text.test.ts`, `tests/e2e/chat-agent-page.spec.ts`, one test in `tests/e2e/chat-devices.spec.ts` |
| After both | 12 | `tests/perf/chat.perf.ts`, the stand-in's `pace` option |
| **Gate** (controller) | 13 | scratch files outside the repository; `tests/fixtures/chat/README.md` (findings) |
| Part B, only if 13 passes | 14, then M: 15 → 16 → 17 → 18; R: 19 | as each task lists |
| Last | 20 | `README.md`, fixes the final review asks for |

**When R starts:** 9 after 6, 10 after 9, and 11 after 7 and 8. In Part B, 19 starts after 17, and 18 runs beside 19.

**The contract between the streams** has four parts:
1. Task 1's types and IPC.
2. Task 14's types and IPC.
3. The stand-in's script options (Tasks 2 and 15).
4. The DOM classes Task 9 names.

**Part A** (Tasks 1–12) is the watch half: routing, history, the page, back, members' read-only page. It ships on its own; the controller tells the person when it is green.

## Rulings on the spec (unbuildable or open points; the plan follows these)

1. **When the hand check fails** (Task 13 says what passing is), Part B is dropped. Tasks 14–19 do not run. The page has no composer; there is no `forward` item kind, no `chat:agent-send` and no app version in the hello. The person is told, and Task 20's README describes the read-only page. The app version in the hello exists only because a `forward` item reaches the main conversation, and no other new kind does.
2. **Older members.** No device before this plan sends an app version. So a member whose hello carries `app` knows agent pages, and a member without it is older and gets the new kinds as `notice` items (Task 18). A comparison against a release number would make a development build of this branch count as older.
3. **The template, word for word.** It is used exactly as the spec's code block has it, line breaks and the three-space indent included (Task 14 pins it).
4. **A forward Claude declined** — `skipped`, with Claude's last line `Not forwarded: X` — shows `via Claude · Not delivered: X`. `X` is the text after the prefix. A `skipped` forward without that line shows `via Claude · Claude did not forward it`.
5. **"Not sent: plan mode"** is the send's own refusal. The spec says both "the forward is refused like any tool" and "the page says Not sent". Those two disagree: a tool refused inside Claude's turn would have been sent and would cost a turn. So the refusal comes before anything goes to Claude, and it shows under the page's composer with the draft kept. Outside plan mode, `SendMessage` goes through the normal `canUseTool` path, with no special allow.
6. **Members never write.** There is no `chat-agent-send` call, and every member snapshot says `writable: false`. Writing from a member is the spec's "builder's call"; it is left out.
7. **The transcript-polling fallback** (the spec's "Failure modes", first point) is built only when Task 13 finds that no subagent text arrives live. Task 13 then gives the spec of Task 13b.
8. **Where history comes from.** The SessionStart hook may not have reported the tab's transcript (a stand-in, a hook that did not run). Then the path is `<the tab's CLAUDE_CONFIG_DIR, or ~/.claude>/projects/<the tab's folder with every non-alphanumeric character as '-'>/<session>.jsonl`. It goes through the existing `findTranscript` (`src/main/transcript-feed.ts`), which scans the projects folder when that name is absent.
9. **"Plus the empty state"** (the spec's "The transcript is missing or unreadable"): the page shows what came live, or the empty state when nothing did. The empty state never shows under items.
10. **The column is a class of its own.** The page's column (`AgentColumn`) follows the main column's rules but is not `ChatView`'s column reused. That column carries the cards, the working line and the composer's focus rules. The main column keeps its model while the page shows, draws nothing, and is redrawn on return.
11. **"Claude asked … folded after six lines"** means more than 6 lines, or more than 600 characters. Both are counted on the source text, so the rule holds without a layout pass.
12. **"Resumed" and the end dividers come from live task events only.** A transcript has none, so a page rebuilt from history has no such dividers.
13. **One `AgentChats` per chat process.** Its revisions go on from the last process's highest, so a page never sees a revision go back.
14. **A nested agent's page:** Esc and the back arrow return to the main conversation, not to the parent's page.

## Review Focus

1. **Odd or hostile agent ids**: `../x`, `a\b`, 129 characters, a number. They can come in a frame's `agent_id`, a `task_started`, an `agentId:` result line, a file name, an IPC call or a member call. Such an id is never routed, never a path, never an argument, and the frame never shows in the main conversation. Tests:
   - Task 1 `'isAgentId …'`;
   - Task 4 `'an agentId line with a bad id gives the call no agent'`;
   - Task 5 `'a frame whose agent_id fails the pattern is dropped'`;
   - Task 6 `'agent calls with a bad id are refused'`;
   - Task 7 `'an id that fails the pattern builds no path'`;
   - Task 8 `CALL_ARGS` refusals.
2. **The conversation moves under an open page**: a `/clear` (a new session id), a restart, an exit, a switch to the terminal. The page reads its agent's own session folder. It reloads after a restart while the agent is known, keeps its last state after an exit, and closes on the terminal. Tests:
   - Task 7 `'an agent keeps the session it started in'`;
   - Task 9 `'switching to the terminal closes the page'`;
   - Task 11 `'a restart keeps the page open while its agent is known'`.
3. **Ten busy agents with one page shown, or none.** No window patch goes out for the agents not shown. Each agent holds at most 1,000 items, a tab at most 50 models, and typing in the main composer stays within a frame. Tests:
   - Task 5, the caps and the eviction;
   - Task 6 `'only the watched agent's patches are sent'`;
   - Task 12 `agentsTypingMs`.
4. **Transcripts being written, or written badly**: a half-written last line, a broken line, a 10 MB line, a file that grows during the read, a link out of the folder. Each is skipped or left for later; nothing crashes or hangs. Tests: Task 7's integration tests.
5. **Frames in an unexpected order**: an agent's frame before its `task_started`, a tool result in a newer page than its call, a resume's `task_started` naming another `tool_use_id`. Tests:
   - Task 5 `'frames before task_started wait in the buffer …'`;
   - Task 7 `'a tool result in a newer page settles its call in an older page'`;
   - Task 4 `'a task_started for an agent the chat knows sets it running again'`.

---

# Part A — watching an agent

### Task 1: the shared contract of the agent page

**Files:**
- Modify: `src/shared/chat.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/chat/chat-items.ts` (one placeholder case), `src/renderer/chat/chat-find.ts` (one case)
- Test: `tests/unit/agent-shared.test.ts` (new)

**Interfaces — Produces** (every later task uses these names; nobody renames them):

```ts
// src/shared/chat.ts
/** an agent id as Claude Code gives it (task_id, agent_id, agent-<id>.jsonl): checked before it is a key, a path part or an argument */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
export const isAgentId = (v: unknown): v is string => typeof v === 'string' && AGENT_ID_PATTERN.test(v)
// ChatSubagent gains   stopped?: boolean   — a failed agent that was stopped (task_notification 'stopped'); absent otherwise
// ChatItem gains       | { kind: 'prompt'; id: string; text: string; first: boolean }   — agent pages only: Claude's prompt (first) or a later message from Claude
export type ChatAgentState = 'running' | 'done' | 'failed' | 'stopped'
export interface ChatAgentInfo {
  id: string; type: string; description: string; state: ChatAgentState
  startedAt: number | null   // the current or last run's start, main's Date.now()
  ms: number | null          // the last run's length, once it ended
  parentId: string | null    // the agent that started it; null for the main conversation's agents
}
export type AgentPatch = Exclude<ChatPatch, { op: 'state' }> | { op: 'agent'; agent: ChatAgentInfo }
export interface AgentSnapshot { tabId: string; agentId: string; rev: number; items: ChatItem[]; hasOlder: boolean; agent: ChatAgentInfo; writable: boolean }
/** a length as an agent's header and its end divider show it: `elapsedText`'s format (src/renderer/chat/chat-steps.ts), but at least 1 s — `12s`, `1m 12s`, `1m 05s` */
export function agentDuration(ms: number): string
```

`src/shared/ipc.ts` `IPC`: `chatAgentSnapshot: 'chat:agent-snapshot'`, `chatAgentOlder: 'chat:agent-older'`, `chatAgentWatch: 'chat:agent-watch'`, `evChatAgentPatch: 'ev:chat-agent-patch'`, `evChatAgentReload: 'ev:chat-agent-reload'`. `CtApi` gains the methods below; `src/preload/index.ts` bridges them with `invoke` / `send` / `on`, like their chat neighbours:

```ts
chatAgentSnapshot(tabId: string, agentId: string): Promise<AgentSnapshot | null>
chatAgentOlder(tabId: string, agentId: string, beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
/** the agent page the window shows for the tab in front; null: none (ipcRenderer.send) */
chatAgentWatch(tabId: string, agentId: string | null): void
onChatAgentPatch(cb: (tabId: string, agentId: string, fromRev: number, toRev: number, patches: AgentPatch[]) => void): Unsubscribe
/** a member's agent snapshot arrived: the page asks for its snapshot again */
onChatAgentReload(cb: (tabId: string, agentId: string) => void): Unsubscribe
```

To keep the build whole:
- `chat-items.ts` `renderItem` gains `case 'prompt': return el('div', 'chat-prompt', item.text)` (Task 10 replaces it);
- `chat-find.ts` `searchText` gains `case 'prompt': return item.text`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/agent-shared.test.ts`:
  - `'isAgentId takes Claude Code's ids and refuses paths and long ones'`:
    - true for `'a1b2c3d4'`, `'task_fake_12'`, `'agent-X_9'`, `'x'.repeat(128)`;
    - false for `''`, `'../x'`, `'a\\b'`, `'a/b'`, `'a b'`, `'x'.repeat(129)`, `12`, `null`.
  - `'agentDuration'`: `400` → `'1s'`, `12_000` → `'12s'`, `72_000` → `'1m 12s'`, `3_605_000` → `'60m 05s'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/agent-shared.test.ts`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement** the contract above.
- [ ] **Step 4: Run** it and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (the controller snapshots the tree).

### Task 2: the stand-in runs subagents

**Files:**
- Modify: `tests/fixtures/fake-claude/fake-claude.ts`, `tests/fixtures/fake-claude/install.ts`. Add only: no existing step changes its output, except the Agent result's last line below.
- Modify: `tests/fixtures/chat/README.md`, adding a section "Subagents: scripted, not recorded" that lists the shapes below and says Task 13 confirms or corrects them.
- Test: `tests/integration/fake-claude.int.test.ts`

**Interfaces — Produces** (`install.ts`; the `task` step takes `FakeTask`):

```ts
export type FakeAgentFrame =
  | { text: string }
  | { thinking: string }
  | { tool: { name: string; input: Record<string, unknown>; result: string; isError?: boolean } }
  | { task: FakeTask }                        // a nested agent: its Agent call is a frame of this agent
export interface FakeAgent {
  type: string; description: string; ms: number; failed?: boolean
  prompt?: string             // the prompt Claude gives it; its description when not given
  frames?: FakeAgentFrame[]   // its conversation; with frames given, its prompt is its first user frame
  pace?: number               // ms between two frames (default 50; 0: one tick)
  end?: 'stopped'             // it ends stopped
  background?: boolean        // the Agent call's result comes at once and the turn goes on; the agent runs on
  gate?: string               // with background: it ends once <config folder>/<gate> exists (else at ms)
  early?: boolean             // its first frame comes before its task_started
  transcript?: false          // no transcript file is written for it
}
export interface FakeTask { description: string; result: string; agents: FakeAgent[] }
```

**Rules** (`fake-claude.ts`):
1. **The flag.** The initialize request's `forwardSubagentText === true` turns on text forwarding for the process.
2. **The calls and `task_started`.** Each agent's Agent `tool_use` input is `{ description, prompt, subagent_type: type }`, plus `run_in_background: true` for a background agent. Its `task_started` is sent as today, with `run_id: 'run_fake_<n>'` added.
3. **One routine per agent.** The agents of a step run at the same time. A foreground step waits for all of them, then sends each call's result. The ends keep today's `ms` order and notifications.
4. **Frames.** Every frame has `parent_tool_use_id` = the agent's Agent call id, `agent_id` = its task id, a fresh `uuid` and `session_id`. They come one every `pace` ms from the agent's start; the end comes at `max(ms, the last frame)`. The shapes:
   - the prompt: a user frame `{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }`;
   - text and thinking: an assistant frame whose `message` has `id: msg_fake_<n>` and one block;
   - a tool: an assistant `tool_use` frame `toolu_fake_<n>`, then a user `tool_result` frame;
   - a nested `task`: its Agent `tool_use` is a frame of this agent. The nested agent gets its own `task_started` (`tool_use_id` = that call), its own frames (`agent_id` = the nested task id, `parent_tool_use_id` = the nested call) and its own transcript. Its `task_notification` follows, then this agent's `tool_result` frame for the call.
5. **What the flag gates.** The prompt, text and thinking frames are sent only with the flag on, and the prompt only when `frames` is given. Tool frames are always sent, as the real CLI sends them.
6. **The transcript.** Unless `transcript: false`, every frame (flag or not, the prompt always first) is appended to `<projectDir>/<session>/subagents/agent-<task id>.jsonl` with the frame's `uuid`, as `{ parentUuid, isSidechain: true, agentId: <task id>, sessionId, cwd, version, type, message, uuid, timestamp }`.
7. **The Agent result** ends with `\n\nagentId: <task id>`:
   - a foreground agent: `${result}\n\nagentId: <id>`, or `The agent failed.\n\nagentId: <id>` (is_error) for a failed or stopped one;
   - a background agent: at once, `Async agent launched successfully.\n\nagentId: <id>`.
8. **Options.**
   - `early`: the first frame (the prompt, when it is sent; else the first frame sent) comes before `task_started`.
   - `end: 'stopped'`: the notification status is `stopped`.
   - `stop_task {task_id}` of a running agent ends it `stopped` at once, and is answered `{}`.

- [ ] **Step 1: Write the failing tests** in `fake-claude.int.test.ts` (use its spawn helper; the initialize request carries the flag as a field):
  - `'an agent's frames carry parent_tool_use_id, agent_id and a uuid; text and thinking come only with forwardSubagentText'` (two runs: one with the flag, one without);
  - `'the agent's transcript holds its prompt and frames with the frames' uuids, and the Agent result ends with agentId'`;
  - `'early sends one frame before task_started, and end stopped reports stopped'`;
  - `'a background agent: the turn ends, its frames go on, and it ends when its gate exists'`;
  - `'stop_task stops a running agent'`;
  - `'a nested agent has its own task, frames and transcript, and its call is a frame of its parent'`;
  - `'transcript: false writes no transcript'`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/fake-claude.int.test.ts`. Expected: the new tests FAIL, the old ones PASS.
- [ ] **Step 3: Implement** it, and write the README section.
- [ ] **Step 4: Run** it, and `npx vitest run tests/integration/sdk-engine.int.test.ts`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 3: one folding for both conversations — `src/main/chat/chat-fold.ts`

A pure move. It changes no behaviour, and the existing suites prove it.

**Files:**
- Create: `src/main/chat/chat-fold.ts`
- Modify: `src/main/chat/chat-model.ts`

**Interfaces — Produces:**

```ts
// chat-fold.ts — moved from chat-model.ts as they are
export interface ChatFoldOptions { now(): number; newId(): string; folder(): string }
export const TEXT_CAP, OUTPUT_CAP, SUBJECT_CAP, NAME_CAP, PATH_CAP; export const PAGE = 200
export function cap(s: string, max: number): string
export function toolSubject(name: string, input: unknown, folder: string): string
/** the folding both conversations share: an assistant message's blocks, tool results, the subagents of Agent calls, the list of items */
export class ChatFold {
  constructor(o: ChatFoldOptions)
  // protected state: o, list, at, open, calls, stepStart, step, tasks, stepImages, imageItems
  protected assistantBlocks(content: unknown[], synthetic: boolean): ChatPatch[]   // the forEach over message.content in ChatModel.assistant
  protected toolResults(content: unknown[]): ChatPatch[]
  protected taskStarted(msg: Record<string, unknown>): ChatPatch[]
  protected taskNotification(msg: Record<string, unknown>): ChatPatch[]
  protected failRunning(reason: string): ChatPatch[]
  /** a text block's hook: the main chat turns a command's "not available" answer into a notice; null: a plain text */
  protected notAvailable(text: string, synthetic: boolean, entry: OpenBlock | undefined): ChatPatch[] | null   // returns null
  // protected, as they are: settleText, thinking, toolUse, showImage, takeOpen, get, put, add, addText, set, callPatch
  attachCards(cards: readonly Pick<ImageCard, 'id' | 'path' | 'deleted'>[]): ChatPatch[]
  page(count?: number): { items: ChatItem[]; hasOlder: boolean }
  older(beforeId: string, count?: number): { items: ChatItem[]; hasOlder: boolean }
  items(): readonly ChatItem[]
}
```

**What moves and what stays:**
- `chat-model.ts` keeps `export class ChatModel extends ChatFold`, with everything else as it is: the stream events, the sends and queue, the cards, init, status, compaction, results, rate limits, command items and `user()`.
- Its `unavailableNotice` becomes the override of `notAvailable`.
- It re-exports `cap`, `toolSubject` and `PAGE` from `./chat-fold`, and `ChatModelOptions` becomes `type ChatModelOptions = ChatFoldOptions`, so `chat-cards.ts`, `chat-mirror.ts` and the tests keep their imports.

- [ ] **Step 1: Run the baseline:** `npx vitest run tests/unit/chat-model.test.ts tests/unit/chat-history.test.ts tests/unit/chat-contract.test.ts tests/unit/chat-cards.test.ts tests/unit/chat-hub.test.ts tests/unit/chat-mirror.test.ts`. Expected: PASS; note the test count.
- [ ] **Step 2: Move** the code as above, with no edit to any test file.
- [ ] **Step 3: Run** the same command and `npm run typecheck`. Expected: PASS, the same count.
- [ ] **Step 4:** Leave the changes uncommitted.

### Task 4: the main conversation's agents — resumed, stopped, found again in history

**Files:**
- Modify: `src/main/chat/chat-fold.ts`, `src/main/chat/chat-model.ts`
- Test: `tests/unit/chat-model.test.ts`

**Interfaces — Produces:**
- `ChatFold.agents(): ChatSubagent[]` — every agent of every tools item, in order.
- `export function resultAgentId(text: string, structured: unknown): string | null` (`chat-fold.ts`).

**Rules:**
1. **Subagent frames stay out.** `ChatModel.apply` drops a message whose `agent_id` is a non-empty string, as it drops one with a `parent_tool_use_id`.
2. **The Agent call's type.** `toolUse` keeps, per `Task` / `Agent` call, its input's `subagent_type` (capped to `NAME_CAP`; `'agent'` when absent) in a private map.
3. **The agent of each call.** A private `agentCalls: Map<taskId, { itemId, callId }>` survives `task_notification`, unlike `tasks`.
4. **A resume.** A `task_started` whose task id is already listed on a call sets that agent back to `running` (`ms: null`, no `stopped` key) and sets `tasks` again with a new start. It returns that call's patch, even when its `tool_use_id` names another call or none.
5. **A stop.** `task_notification` status `stopped` gives `{ state: 'failed', stopped: true }`; `failed` gives `{ state: 'failed' }` with no `stopped` key.
6. **Agents found in history.** A `Task` / `Agent` call whose result comes while it lists no agent takes one when `resultAgentId(resultText, frame.tool_use_result ?? frame.toolUseResult)` finds an id. `user()` passes the frame's field down to `toolResults`. The agent is `{ id, description: call.subject, type: <the kept subagent_type>, state: failed ? 'failed' : 'done', ms: null }`, and it is recorded in `agentCalls`.
7. **`resultAgentId`:** the structured object's `agentId` when it passes `isAgentId`; else the last match of `/(?:^|\n)\s*agentId:\s*([^\s(]+)/g` in the text that passes it; else `null`.
8. **`toolSubject('SendMessage', input)`** is `to <input.to>` when `to` is a string, else `''`.

- [ ] **Step 1: Write the failing tests:**
  - `'a frame with an agent_id never adds a main item'`;
  - `'a task_started for an agent the chat knows sets it running again'` (done first; the resume's `tool_use_id` is absent);
  - `'a stopped agent stays apart from a failed one'`;
  - `'in history, the agent id comes from the agentId line'`: an Agent call `{ subagent_type: 'Explore', description: 'Find the chart code' }` with the result `'Found it.\n\nagentId: a1b2c3 (use SendMessage to continue)'` → `agents` equals `[{ id: 'a1b2c3', type: 'Explore', description: 'Find the chart code', state: 'done', ms: null }]`;
  - `'the structured result's agentId wins over the text'`;
  - `'an agentId line with a bad id gives the call no agent'` (`agentId: ../x` → `agents: []`);
  - `'a call that has its agent takes no second one from its result'`;
  - `'SendMessage's subject is the agent it writes to'` (`toolSubject('SendMessage', { to: 'a1b2c3', message: 'x' }, '/w')` → `'to a1b2c3'`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-model.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** the Task 3 command. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 5: the agents of a chat — `src/main/chat/agent-chats.ts` (live)

**Files:**
- Create: `src/main/chat/agent-chats.ts`
- Test: `tests/unit/agent-chats.test.ts` (new)

**Interfaces — Produces:**

```ts
export const MAX_AGENT_ITEMS = 1000, MAX_AGENT_MODELS = 50, MAX_EARLY_FRAMES = 200, AGENT_PAGE = 200
export interface AgentChange { agentId: string; fromRev: number; toRev: number; patches: AgentPatch[] }
export interface AgentChatsOptions extends ChatFoldOptions { firstRev: number }   // every agent's count starts there
/** a subagent's frame: type assistant | user | stream_event, with a non-empty agent_id or parent_tool_use_id */
export function isSubagentFrame(msg: unknown): boolean
/** the keys a frame is known by (see Task 7): 'uuid:<uuid>', 'tool:<tool_use id>', 'result:<tool_use_id>', 'block:<message.id>:<index>:<type>' */
export function frameKeys(msg: unknown): string[]
export class AgentModel extends ChatFold { /* one agent's conversation */ }
export class AgentChats {
  constructor(o: AgentChatsOptions)
  /** a stream message: a subagent's frame, a task_started or a task_notification; [] for anything else */
  apply(msg: unknown, sessionId: string | null): AgentChange[]
  info(agentId: string): ChatAgentInfo | null
  /** the session the agent started in: its transcript is in that session's folder */
  sessionOf(agentId: string): string | null
  /** the newest AGENT_PAGE items, and whether older ones exist */
  page(agentId: string): { rev: number; items: ChatItem[]; hasOlder: boolean } | null
  /** a viewer opens (true) or leaves (false) the agent's page: a count */
  watch(agentId: string, on: boolean): void
  maxRev(): number
}
```

**Rules:**
1. **What a model folds.** `AgentModel.apply(frame)` takes:
   - an `assistant` with array `message.content` → `assistantBlocks(content, false)`;
   - a `user` with `tool_result` blocks → `toolResults` (passing its structured field, as Task 4 does);
   - a `user` with plain text: the agent's first one → `{ kind: 'prompt', first: true }`, each later one → `first: false`;
   - `system` `task_started` / `task_notification` of a nested agent → the fold's own methods, so the call lists it.

   A `stream_event` gives nothing.
2. **Routing a frame:**
   - by `agent_id`; a non-string or one that fails `isAgentId` → the frame is dropped;
   - else by `parent_tool_use_id`, through the map that `task_started` fills (`tool_use_id` → task id);
   - else the frame waits in the buffer, keyed by its `parent_tool_use_id`. The buffer holds at most `MAX_EARLY_FRAMES` frames per `AgentChats`; past that the oldest is dropped. A `task_started` naming that `tool_use_id` folds its frames, in order.
3. **The record.** A frame for an unknown valid id makes the record at once: type `'agent'`, description `''`, running, `startedAt: now`, no parent. Its `task_started` fills them in later.
4. **`task_started`** (its `task_id` must pass `isAgentId`):
   - a new id: a record with type = `subagent_type ?? task_type ?? 'agent'`, the description (both capped at 500) and `parentId` = the agent whose model holds the call `tool_use_id` names (or `null`). It remembers `sessionId`. The parent's model folds the message too.
   - an ended record: a resume — `running`, `startedAt: now`, `ms: null`, a divider `Resumed`, and an `{ op: 'agent' }` patch.
5. **`task_notification`:**
   - the state: `completed` → `done`, `failed` → `failed`, `stopped` → `stopped`;
   - the length: `usage.duration_ms` (≥ 0), else `now - startedAt`;
   - a divider: `Agent finished · ${agentDuration(ms)}`, `Agent failed` or `Agent stopped`;
   - an `{ op: 'agent' }` patch;
   - the parent's model folds it too.
6. **Revisions.** Each change carries the agent's revision before and after; one patch is one revision. The count starts at `firstRev`.
7. **Caps.**
   - Items: past `MAX_AGENT_ITEMS`, the oldest items go. The index map is rebuilt, `hasOlder` turns true, and no patch is sent for the drop: a page keeps what it drew.
   - Models: when a model is made and `MAX_AGENT_MODELS` already hold items, the ended, unwatched one touched least recently loses its items. Its record (and `info`) stays, and it is marked as needing history (Task 7). A running or watched model is never evicted.

- [ ] **Step 1: Write the failing tests:**
  - `'a frame reaches its agent by agent_id'`;
  - `'a frame without agent_id reaches its agent through parent_tool_use_id'`;
  - `'frames before task_started wait in the buffer and arrive when it names them'`;
  - `'the buffer keeps at most 200 frames'` (205 text frames → 200 text items, the first 5 gone);
  - `'a frame with agent_id before task_started makes its agent at once, and task_started names it'`;
  - `'a frame whose agent_id fails the pattern is dropped'`;
  - `'the first user text is Claude asked, later ones From Claude'` (kinds and `first`);
  - `'a resume adds Resumed and sets the agent running'`;
  - `'an end adds its divider: Agent finished · 1m 12s, Agent failed, Agent stopped'` (`duration_ms: 72000`);
  - `'an agent started by an agent has its own model, its parent, and a row in the parent's step'`;
  - `'an agent holds at most 1,000 items, and says it has older ones'`;
  - `'text over 1 MiB and outputs over 64 KiB are capped'`;
  - `'past 50 models the ended unwatched agent touched least recently is evicted, never a running or a watched one'`;
  - `'every agent counts its revisions from firstRev'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/agent-chats.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 6: ChatHub routes and serves the agents

**Files:**
- Modify: `src/main/chat/sdk-engine.ts`, `src/main/chat/chat-hub.ts`, `src/main/index.ts`
- Test: `tests/unit/chat-hub.test.ts`, `tests/integration/sdk-engine.int.test.ts`, `tests/integration/agent-chat.int.test.ts` (new)

**Interfaces:**
- Consumes: `AgentChats`, `isSubagentFrame` (Task 5); `ChatFold.agents()` (Task 4); the Task 1 types.
- Produces:

```ts
export const WINDOW_VIEWER = 'window'
// ChatHubDeps gains
agentWindow(tabId: string, agentId: string, fromRev: number, toRev: number, patches: AgentPatch[]): void
agentRemote(tabId: string, agentId: string, devices: string[], fromRev: number, toRev: number, patches: AgentPatch[]): void
// ChatHub gains
agentSnapshot(tabId: string, agentId: string): Promise<AgentSnapshot | null>
agentOlder(tabId: string, agentId: string, beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
/** viewer: WINDOW_VIEWER or a member's device id; one page per viewer; null: it shows none */
watchAgent(tabId: string, viewer: string, agentId: string | null): void
forgetViewer(viewer: string): void
/** for members: the snapshot cut like capSnapshot (MAX_CHAT_PUSH_BYTES), writable false */
remoteAgentSnapshot(tabId: string, agentId: string): Promise<AgentSnapshot | null>
```

**Rules:**
1. **The flag.** `sdk-engine.ts` passes `forwardSubagentText: true` beside `perTaskStopAffordance`.
2. **One `AgentChats` per `Live`,** made with `firstRev` = the tab's last agent revision, kept in a `Map` like `revs` and set from `maxRev()` in `remove`.
3. **`apply`.** `live.agents.apply(msg, sessionId)` comes first, and its changes are emitted. A message for which `isSubagentFrame` is true stops there; any other goes on to the main model as today.
4. **Batches.**
   - The window: the agent the window watches, only while its tab is in front, batched 16 ms like the main chat; `activated` clears the others.
   - Members: the devices watching that agent, batched 50 ms, through `agentRemote`.
   - Nothing goes out for an agent nobody watches.
5. **`watchAgent`.** It keeps `AgentChats.watch` counts. A viewer that moves to another page leaves the old one.
6. **`agentSnapshot`.** `null` for a tab with no chat, an id that fails `isAgentId`, or an unknown agent. Otherwise `{ tabId, agentId, ...page, agent: info, writable: false }` (Task 17 turns `writable` on).
7. **IPC** (`index.ts`, handlers next to the chat ones):
   - `chatAgentSnapshot` / `chatAgentOlder`: a local Claude tab and ids passing `isId` / `isAgentId` / `isChatRef`, else `null`;
   - `chatAgentWatch` → `watchAgent(tabId, WINDOW_VIEWER, agentId)`;
   - `agentWindow` sends `IPC.evChatAgentPatch`.

- [ ] **Step 1: Write the failing tests.**
  - Unit (`chat-hub.test.ts`; `FakeEngine` emits the frames):
    - `'a subagent frame goes to its agent, never to the main conversation'`;
    - `'only the watched agent's patches are sent, batched, while its tab is in front'`;
    - `'an agent a member watches gets its patches whatever tab the window shows'`;
    - `'agentSnapshot gives the newest items, the header and writable false'`;
    - `'agent calls with a bad id are refused'`;
    - `'a restarted chat counts its agents' revisions on from the last one'`.
  - Integration:
    - `sdk-engine.int.test.ts` `'the initialize request asks for subagent text'` (the stand-in log has `in` `control_request` `initialize` with `forwardSubagentText: true`);
    - new `agent-chat.int.test.ts`, a `ChatHub` whose engine is `startSdkEngine` on the stand-in (launch resolved as `sdk-engine.int.test.ts` does), with `'an agent's frames reach its page, not the main conversation'` (a task whose agent has text, thinking and a Glob frame → `agentSnapshot` holds them; `snapshot(tab)` has none of the text).
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-hub.test.ts tests/integration/sdk-engine.int.test.ts tests/integration/agent-chat.int.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them and `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 7: an agent's history from its transcript — `src/main/chat/agent-history.ts`

**Files:**
- Create: `src/main/chat/agent-history.ts`
- Modify: `src/main/chat/agent-chats.ts`, `src/main/chat/chat-hub.ts`, `src/main/index.ts`
- Test: `tests/integration/agent-history.int.test.ts` (new), `tests/unit/agent-chats.test.ts`, `tests/unit/chat-hub.test.ts`

**Interfaces — Produces:**

```ts
// agent-history.ts
export const LINE_CAP = 4 * 1024 * 1024, CHUNK = 256 * 1024, PAGE_LINES = 2000, PAGE_BYTES = 8 * 1024 * 1024
export interface TranscriptPage { lines: Record<string, unknown>[]; start: number }   // oldest first; start: where the next older page ends (0: none)
/** <dirname(transcript)>/<sessionId>/subagents/agent-<agentId>.jsonl; null when the id fails isAgentId or the session is not a uuid */
export function agentTranscriptPath(transcript: string, sessionId: string, agentId: string): string | null
/** its real path, when it lies inside the real subagents folder and that folder inside the real project folder; else, or missing, null */
export function resolveAgentTranscript(file: string): Promise<string | null>
/** up to PAGE_LINES whole lines (and PAGE_BYTES) that end before byte `end` (null: the size now) */
export function readAgentPage(file: string, end: number | null): Promise<TranscriptPage>
// AgentChats gains
needsHistory(agentId: string): boolean
/** the newest page read: merged before the live items; one change with a reset patch (the newest AGENT_PAGE items) */
history(agentId: string, page: TranscriptPage | null): AgentChange[]
/** what older() needs from its caller: items held before beforeId, or the cursor of the transcript page to read */
older(agentId: string, beforeId: string): { items: ChatItem[]; hasOlder: boolean } | { cursor: number } | null
olderPage(agentId: string, page: TranscriptPage): { items: ChatItem[]; hasOlder: boolean }
/** an agent the main conversation's history names: known, ended, read from its transcript when opened */
known(agent: ChatSubagent, sessionId: string | null): void
// ChatHubDeps gains
/** the tab's transcript of that session: the hook's path, else ruling 8's; null when none is found */
transcript(tabId: string, sessionId: string): Promise<string | null>
```

**Rules:**
1. **Reading a page.** Read backward from `end` in `CHUNK` reads; `end` is the size taken once at the start of the read.
   - The first page's last line counts only when it ends in `\n`; a half-written line is left for later.
   - A line over `LINE_CAP` is skipped, and its bytes are not kept while the reader looks for its start.
   - A line that is not a JSON object is skipped.
   - A page stops at `PAGE_LINES` lines or `PAGE_BYTES` bytes, with at least one line.
2. **Keys.** `frameKeys(msg)`:
   - `uuid:<uuid>` for a non-empty string `uuid` ≤ 200;
   - per content block: `tool:<id>` for `tool_use`, `result:<tool_use_id>` for `tool_result`;
   - `block:<message.id>:<index>:<type>` for text and thinking, when `message.id` is a string.

   A model remembers the keys of the frames whose items it holds, and forgets them with the items.
3. **Merging.** `history()` folds the page's lines in order, in a fold of its own. A line with any key the model holds is skipped. The result is the agent's head: transcript items first, then the live ones. A page whose lines are all held adds nothing. The first user text of the head is the prompt (`first: true`); the live model's prompt becomes `first: false` only when the head already has one.
4. **Older pages.** `older()` gives the held items (head then live) before `beforeId`. When `beforeId` is the first item held and the transcript cursor is past 0, it gives `{ cursor }` instead, and `olderPage()` folds that page and puts it before the head.
   - A `tool_result` whose call is not in its page is kept by its `tool_use_id`. A call found in an older page settles with it.
   - An id the model does not hold gives the newest `AGENT_PAGE` items of the head.
5. **Viewers and memory.** The head is kept only while someone watches the agent. At no viewer it is dropped, and the next open reads the transcript again.
6. **ChatHub.**
   - `agentSnapshot` reads first when `needsHistory`: `deps.transcript(tabId, sessionOf(agentId) ?? current session)` → `agentTranscriptPath` → `resolveAgentTranscript` → `readAgentPage(file, null)`. A failure at any step logs a warning and reads nothing, and live items still show.
   - `agentOlder` follows the `{ cursor }` answer.
   - After `loadHistory`, `known()` is called for every `live.model.agents()`.
7. **`index.ts` `transcript`:** the hook's path from `sources.get(tabId)` when its file name is `<sessionId>.jsonl`, else ruling 8's path (the tab's environment from `TabManager.claudeEnv`, the folder from the tab), passed through `findTranscript(path, sessionId)`.

- [ ] **Step 1: Write the failing tests.**
  - Integration (`agent-history.int.test.ts`; transcripts under a temp `CLAUDE_CONFIG_DIR`):
    - `'reads a transcript in pages, newest first'` (2,500 lines → the first page is the newest 2,000 with `start > 0`; the next page is the rest, `start === 0`);
    - `'a broken line is skipped, and so is a line over 4 MiB'`;
    - `'a half-written last line is left for later'`;
    - `'a line written while the page is read is not cut'`;
    - `'an id that fails the pattern builds no path'` (`../x`, `a\\b`, 129 chars);
    - `'a subagents folder that is a junction or symlink to outside is not read'`;
    - `'an agent file that is a symlink to outside is not read'` (skipped when the platform refuses the link, `EPERM`);
    - `'on Windows, a config folder named by its 8.3 short name is read'` (`it.runIf(process.platform === 'win32')`; the short name from `cmd /d /c for %I in ("<dir>") do @echo %~sI`; a volume without short names gives the long name and the test still runs).
  - Unit (`agent-chats.test.ts`):
    - `'a transcript line held live is not added again: by uuid, by tool_use id, by message id and block index'`;
    - `'transcript items come before the live ones'`;
    - `'older pages come from the held items, then from the transcript before the cursor'`;
    - `'a tool result in a newer page settles its call in an older page'`;
    - `'the transcript items go when nobody watches the agent'`.
  - Unit (`chat-hub.test.ts`, with a fake `transcript` dep and temp files):
    - `'an agent of a resumed chat opens with its transcript'`;
    - `'an agent keeps the session it started in'` (a `/clear` changes the session; the agent's file is still read from its own session's folder).
- [ ] **Step 2: Run** `npx vitest run tests/integration/agent-history.int.test.ts tests/unit/agent-chats.test.ts tests/unit/chat-hub.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 8: a member opens an agent page, read-only

**Files:**
- Modify:
  - `src/shared/remote.ts` (`PushKind` and `PUSH_KINDS` gain `'chat-agent' | 'chat-agent-patch'`);
  - `src/main/sync/remote-shapes.ts`, `src/main/chat/chat-mirror.ts`;
  - `src/main/remote-host.ts` (`HostChat`, handlers);
  - `src/main/sync/tab-host.ts`, `src/main/sync/tab-viewer.ts`, `src/main/sync/remote-actions.ts`, `src/main/index.ts`.
- Test: `tests/unit/sync-remote-shapes.test.ts`, `tests/unit/chat-mirror.test.ts`, `tests/integration/remote-chat.int.test.ts`

**Interfaces — Produces:**

```ts
// remote-shapes.ts CallArgs / CallReplies
'chat-agent': { id: string; agentId: string }                         → AgentSnapshot
'chat-agent-older': { id: string; agentId: string; beforeId: string } → { items: ChatItem[]; hasOlder: boolean }   (bulk, capItems like chat-older)
'chat-agent-watch': { id: string; agentId: string | null }            → Empty
// chat-mirror.ts
export type AgentPush = { snapshot: AgentSnapshot } | { agentId: string; fromRev: number; toRev: number; patches: AgentPatch[] }
export function parseAgentSnapshot(v: unknown): AgentSnapshot | null
export function parseAgentPush(v: unknown): AgentPush | null
// tab-host.ts
pushToDevice(device: string, tabId: string, k: PushKind, v: unknown): void    // only to a member that watches the tab
// tab-viewer.ts: events chatAgent?(tabId, agentId, fromRev, toRev, patches); chatAgentReload?(tabId, agentId); takeAgentSnapshot(tabId, agentId): AgentSnapshot | null (once)
// remote-actions.ts
chatAgent(tabId: string, agentId: string): Promise<AgentSnapshot | null>      // the kept snapshot once, else the host's call
chatAgentOlder(tabId: string, agentId: string, beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
chatAgentWatch(tabId: string, agentId: string | null): void                   // fire and forget
```

**Rules:**
1. **What a member accepts.** `isItem` accepts `prompt` (text ≤ 1 MiB, `first` boolean). An `AgentSnapshot` is checked like a chat snapshot plus its agent info (`id` passes `isAgentId`; type and description ≤ 500; a known state; times and `ms` finite or `null`; `parentId` an id or `null`) and `writable: boolean`. Patches are the chat's ops except `state`, plus `agent`, at most `MAX_CHAT_PATCHES` per batch.
2. **The host.**
   - The calls run on the tab's `ChatHub`: `chat-agent` → `remoteAgentSnapshot`, `chat-agent-watch` → `watchAgent(tabId, device, agentId)`.
   - `index.ts` `agentRemote` pushes `chat-agent-patch` `{ agentId, fromRev, toRev, patches }` with `pushToDevice`. A batch over `MAX_CHAT_PUSH_BYTES` or `MAX_CHAT_PATCHES` goes as a `chat-agent` snapshot (`remoteAgentSnapshot`) instead.
   - `onPeerGone` calls `chatHub.forgetViewer(device)`.
3. **The member.**
   - A `chat-agent-patch` reaches the window as `evChatAgentPatch`.
   - A `chat-agent` snapshot is kept for its tab and reaches the window as `evChatAgentReload`.
   - The window's `chatAgentSnapshot` / `chatAgentOlder` / `chatAgentWatch` on a remote tab id become the device's calls (`index.ts` routes as for `chatOlder`).

- [ ] **Step 1: Write the failing tests.**
  - Unit:
    - each new `CALL_ARGS` entry refuses wrong types, `agentId: '../x'` and 129 characters;
    - `CALL_REPLIES['chat-agent']` refuses a snapshot with an unknown item kind or a bad agent state;
    - `parseAgentPush` takes a snapshot and a batch, and refuses a batch with a `state` op;
    - `PUSH_KINDS` lists both kinds.
  - Integration (`remote-chat.int.test.ts`):
    - `'a member opens an agent page: the host's snapshot, then the patches of that agent only'`;
    - `'an agent page of a member is read-only'` (`writable: false`);
    - `'a member that leaves the page gets no more agent patches'`;
    - `'a batch over the cap reaches the member as a reload'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/sync-remote-shapes.test.ts tests/unit/chat-mirror.test.ts tests/integration/remote-chat.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them and `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 9: the page, the way in and the way back

**Files:**
- Create: `src/renderer/chat/agent-text.ts`, `src/renderer/chat/agent-column.ts`, `src/renderer/chat/agent-page.ts`
- Modify:
  - `src/renderer/chat/chat-view.ts`;
  - `src/renderer/chat/chat-steps.ts` (dock rows);
  - `src/renderer/chat/chat-items.ts` (`ItemCallbacks.openAgent`);
  - `src/renderer/icons.ts` (add `'arrow-left': '<path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path>'` to the name list and the map, as the neighbours are);
  - `src/renderer/chat/chat.css`, `src/renderer/main.ts`.
- Test: `tests/unit/agent-text.test.ts`, `tests/e2e/chat-agent-page.spec.ts` (new)

**Interfaces:**
- Consumes: the Task 1 types and `ct` calls; `renderItem`, `streamText`, `updateSteps`, `stepKeep`.
- Produces:

```ts
// agent-text.ts (pure)
export function agentStateText(a: ChatAgentInfo, now: number): string   // 'Running · 42s' | 'Done · 1m 12s' | 'Failed · 12s' | 'Stopped'; 'Done' / 'Failed' with ms null
export const EMPTY_RUNNING = 'Nothing yet — the agent has just started'
export const EMPTY_LOST = "This agent's conversation was not saved"
// chat-steps.ts
export function agentColor(index: number): string     // AGENT_COLORS[index % 6]
export function fillAgentsCard(box: HTMLElement, agents: ChatSubagent[], o?: { open?(agentId: string): void; current?: string | null }): void
// chat-items.ts: ItemCallbacks gains  openAgent(agentId: string): void   (StepCallbacks picks it too)
// agent-page.ts
export interface AgentPageOptions {
  agentId: string; cb: ItemCallbacks; color: string
  back(): void
  older(beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
}
export class AgentPage {
  readonly agentId: string
  readonly element: HTMLElement   // .agent-page: the header and the column, in place of .chat-body
  readonly footer: HTMLElement    // .agent-footer: in place of the composer (empty in Part A)
  constructor(o: AgentPageOptions)
  load(s: AgentSnapshot): void                                              // always replaces what it holds
  patch(fromRev: number, toRev: number, patches: AgentPatch[]): boolean     // acceptPatches; false on a gap
  show(visible: boolean): void
  focus(): void
  dispose(): void
}
// chat-view.ts: ChatViewOptions gains
agentSnapshot(agentId: string): Promise<AgentSnapshot | null>
agentOlder(agentId: string, beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
watchAgent(agentId: string | null): void
// ChatView gains
openAgent(agentId: string): Promise<void>; closeAgent(): void; shownAgent(): string | null
agentPatch(agentId: string, fromRev: number, toRev: number, patches: AgentPatch[]): boolean
reloadAgent(): void
```

**The page and its DOM.** `.agent-page` holds `.agent-head` and `.agent-body`. `.agent-body` holds the `AgentColumn` (`.agent-scroll` > `.agent-column` > items with `data-item`) and the `.agent-fade`.

The header is one line, 40 px high, padded `0 16px`, with a bottom hairline:
- `button.agent-back`, with the `arrow-left` icon and `aria-label` and title `Back to the conversation`;
- `.agent-type`, a quiet chip (11.5 px, radius 4 px);
- `.agent-desc`, which ellipsizes;
- on the right, `.agent-state`: a `.chat-ring` coloured `--agent: <color>` while running, a check while done, a cross while failed or stopped, then `agentStateText`. The text ticks once a second while the page shows and the agent runs.

**The column, as it is in this task.** `AgentColumn` is drawn like the main column:
- items through `renderItem(item, cb, keep, settled)`; a step is settled when an item follows it or the agent is not running;
- a streaming text grows through `streamText`, and a tools patch updates its step through `updateSteps`;
- drawing waits for an animation frame, with the 100 ms timer fallback;
- it sticks to the bottom while the reader is within 24 px of it;
- a hidden column draws nothing and redraws when shown.

Task 10 adds the window, the pill, the paging and Find.

**ChatView.**
1. **`openAgent(id)`** awaits `agentSnapshot(id)`. On `null` nothing changes; the last call wins. Then it:
   - keeps the main anchor (`null` when stuck, else `topItem()`);
   - inserts `page.element` before the dock and `page.footer` before the composer, and hides `.chat-body` and the composer;
   - stops main drawing: every place that tests `this.visible` before drawing tests `this.visible && this.page === null`, and `isShown()` follows it too;
   - turns the quote off;
   - marks the open row in the dock;
   - calls `o.watchAgent(id)`, loads the page and focuses it (`tabindex="-1"`).
2. **`closeAgent()`** disposes the page, shows the body and the composer, and calls `o.watchAgent(null)`. A stuck column goes to its tail and settles. Otherwise it moves its window around the anchor, redraws, and puts the anchor back at its offset (`keepAt`). Then it shows the state, settles the cards, and focuses the composer.
3. **Esc on the page** (not repeated, not composing): `preventDefault`, `stopPropagation`, `closeAgent()`. It never interrupts.
4. **Shown and reloaded.**
   - `show(true)` with a page shows the page, calls `o.watchAgent(page.agentId)`, and reloads its snapshot.
   - `show(false)` hides it and keeps it.
   - `load()` and `replaceAll()` with a page call `reloadAgent()`, which closes the page when the snapshot is `null`.
5. **The cb.** The page's `cb` is the view's own, with `openAgent` that opens another page.
6. **Dock rows** are `role="button"`, `tabindex="0"`, with the title `Open this agent` and `aria-current="true"` on the open one. A click, Enter or Space opens the row's agent; Space does not scroll.
7. **The colour** is `agentColor(<the agent's index among the dock's agents>)`, or `agentColor(0)` for a nested agent.

**`main.ts`.**
- It passes the three options.
- `ct.onChatAgentPatch` goes to the chat in front: `if (!t.chat.agentPatch(...)) t.chat.reloadAgent()`.
- `ct.onChatAgentReload` → `reloadAgent()` when that agent shows.
- `applyView` to `terminal` calls `t.chat?.closeAgent()`.

**CSS.** A new section "agent page" in `chat.css`. The page's column takes the main column's width, padding and fade: add `.agent-scroll`, `.agent-column` and `.agent-fade` to the selector lists of `.chat-scroll`, `.chat-column` and `.chat-fade` (add only). Under reduced motion, `.agent-state .chat-ring` stands still.

- [ ] **Step 1: Write the failing tests.**
  - Unit `agent-text.test.ts`: each state's text (running at +42 s → `'Running · 42s'`; done with `ms: 72000` → `'Done · 1m 12s'`; failed with `12000` → `'Failed · 12s'`; stopped → `'Stopped'`).
  - E2E `chat-agent-page.spec.ts` (`launchChatTab`; a background agent with a gate keeps the dock open; its frames are a thinking, a text `'Looking at the sales folder'` and a Glob):
    - `'a click on a dock row opens the page: header, running ring, live text, thinking and tool steps'`;
    - `'Enter and Space on a dock row open the page'`;
    - `'the back arrow and Esc return to the main conversation at the same top item, and Esc interrupts nothing'` (the top item's `data-item` and its offset within 1 px; the stand-in log has no interrupt);
    - `'keys typed on the page reach neither the main composer nor a waiting card'`;
    - `'the header reaches Done, Failed and Stopped'`;
    - `'with reduced motion the header's ring stands still'` (computed `animation-name` is `none`);
    - `'switching tabs keeps the page'`;
    - `'switching to the terminal closes the page'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/agent-text.test.ts` and `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/chat-agent-page.spec.ts --reporter=line --workers=2"`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** both, and `tests/e2e/chat-conversation.spec.ts` through the lock (the dock tests unchanged). Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 10: the page's column — window, pill, older pages, Find, Claude asked, empty states

**Files:**
- Modify: `src/renderer/chat/agent-column.ts`, `src/renderer/chat/agent-page.ts`, `src/renderer/chat/chat-items.ts`, `src/renderer/chat/chat-find.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`, `src/renderer/main.ts`
- Test: `tests/e2e/chat-agent-page.spec.ts`

**Interfaces — Produces:**

```ts
// chat-find.ts: ChatFind takes any view that gives these (ChatView already does)
export interface FindView {
  itemCount(): number; itemAt(i: number): ChatItem | undefined; indexOfItem(id: string): number
  drawnNode(id: string): HTMLElement | null; drawnNodes(): HTMLElement[]; reveal(id: string): boolean
  isShown(): boolean; hasOlderItems(): boolean; loadOlder(): Promise<boolean>; hasCard(cardId: string | null): boolean
}
// AgentColumn implements FindView (hasCard: false); AgentPage.findView(): FindView; ChatView.agentFindView(): FindView | null
```

**Rules:**
1. **The window.** `AgentColumn` takes the main column's numbers:
   - it holds every item it gets and draws at most 120 in a row;
   - it moves by 60 within 400 px of either end;
   - every item has `content-visibility: auto; contain-intrinsic-size: auto 120px`.
2. **The pill.** While the reader is not at the bottom, new items do not move the column (anchored to the first visible item), and `button.agent-pill` `↓ New messages` shows; a click goes to the end.
3. **Older pages.** At the first held item with `hasOlder`, `older(firstId)` is asked once, until its answer.
4. **`prompt` items** (`chat-items.ts`): `.chat-prompt`, a quiet block.
   - Its head is `Claude asked` (first) or `From Claude`; its body is `chatMarkdownHtml`.
   - Folded to six lines (`max-height: calc(6 * 1.6em)`, overflow hidden) when the text has more than 6 lines or 600 characters, with `button.chat-prompt-more` `Show all`, which unfolds it and goes.
5. **Empty states.** With no item, `.agent-empty` shows `EMPTY_RUNNING` while the agent runs and `EMPTY_LOST` once it ended.
6. **Find.** `main.ts` `findTarget()` gives the page's `FindView` find while a page shows; `chatFinds` is keyed by `FindView`.

- [ ] **Step 1: Write the failing e2e tests:**
  - `'a long agent conversation shows its end, holds a small DOM and pages older items'` (600 text frames, `pace: 0` → the last visible, `.agent-column > [data-item]` ≤ 120; scrolling to the top brings the first frame);
  - `'while you read above, new frames do not move the column and the pill brings you down'`;
  - `'Claude asked is folded after six lines and Show all unfolds it'`;
  - `'a later message from Claude is a From Claude block'`;
  - `'Find searches the agent page that shows'` (`KEYS.find`, a word only the agent wrote → highlighted in `.agent-column`);
  - `'an agent that has said nothing yet says so'`;
  - `'an ended agent with nothing live and no transcript says it was not saved'` (`transcript: false`, no `frames`).
- [ ] **Step 2: Run** the spec through the lock. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, and `tests/e2e/chat-conversation.spec.ts` through the lock (the main Find unchanged). Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 11: the other ways in, the waiting bar, restarts and members

**Files:**
- Modify: `src/renderer/chat/chat-steps.ts`, `src/renderer/chat/agent-page.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`, `src/renderer/main.ts`
- Test: `tests/e2e/chat-agent-page.spec.ts`, `tests/e2e/chat-devices.spec.ts` (one test)

**Interfaces — Produces:** `AgentPage.setWaiting(waiting: boolean): void`.

**Rules:**
1. **An Agent call's row.** A row of a `Task` / `Agent` call with `agents[0]` (`fillCall` in `chat-steps.ts`) is `role="button"`, `tabindex="0"`, with the class `agent`, the title `Open this agent`, and `data-agent` = `agents[0].id`. A click, Enter or Space calls `cb.openAgent(agents[0].id)`. A `span.chat-step-open` `›` shows on hover and focus. A call with no agent stays plain, and `editPath` keeps its own behaviour.
2. **Nested agents.** The same rows on an agent page open the nested agent's page.
3. **The waiting bar.** `button.agent-wait` sits under the header: `Claude is waiting for your answer · ` then a bold `Back to the conversation`.
   - It shows while the main conversation has an unanswered card. ChatView calls `setWaiting(cardOrder().active !== null)` after every main patch and load, also while the page shows.
   - It takes the focus when it appears while the focus is on the page.
   - A click or Enter closes the page and focuses the active card (`settleCards(true)`).
4. **Restarts and resets** keep the page while its agent is known (Task 9's `reloadAgent`).

- [ ] **Step 1: Write the failing tests:**
  - `'an Agent call's row opens its page after the dock has closed'`;
  - `'a call with no known agent is not a button'`;
  - `'an agent started by an agent has its own page, opened from its row on the parent's page'`;
  - `'a card waiting in the main conversation shows the bar, and Enter returns with the card focused'`;
  - `'after a restart, a step's agent opens with its history from the transcript'` (the restore pattern of `restoredChat` in `chat-helpers.ts`);
  - `'a restart keeps the page open while its agent is known'`;
  - in `chat-devices.spec.ts`, `'a member opens a host's agent page read-only, and its live frames arrive'`.
- [ ] **Step 2: Run** both specs through the lock. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, and `tests/e2e/chat-conversation.spec.ts` and `tests/e2e/remote-tabs.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 12: the perf harness measures agent pages

**Files:**
- Modify: `tests/perf/chat.perf.ts`

The stand-in's `pace` is Task 2's.

**Rules.** Two new budgets join `BUDGET`, printed and checked like the others:
- **`agentOpenMs` ≤ 150.** A background agent with 1,000 text frames (`pace: 0`, gated). Measured from the click on its dock row to its last frame visible in `.agent-scroll`. Five runs, the median.
- **`agentsTypingMs` ≤ 16.7.** Ten background agents, each sending text frames every 20 ms while 40 characters are typed into the main composer. Measured from `keydown` to the next animation frame, the median, as `typingLatency` does.

- [ ] **Step 1:** Add both measures.
- [ ] **Step 2: Run** `node .superpowers/sdd/locked.cjs "npm run perf"`. Expected: every budget met. The printed line goes to the controller's ledger.
- [ ] **Step 3:** Leave the changes uncommitted. Part A is done: the controller runs the whole suite (`npm run typecheck`, `npm test`, `node scripts/e2e.mjs` through the lock) and tells the person.

### Task 13 (controller-only — the main session runs it, not a Haiku implementer): the hand check with the person's account

This answers the spec's open questions 1 and 2. It runs a few short Haiku turns on the person's own account, which the spec agreed to. Nothing personal goes into the repository.

- [ ] **Step 1: The scratch.** Write a scratch folder outside the repository (`<TEMP>/ct-agent-check/`) holding a script that calls `query()` with:
  - the worktree's `node_modules/@anthropic-ai/claude-agent-sdk` and the person's own `claude` (started as `scripts/record-chat-fixtures.mjs` starts it);
  - `cwd`: a temp work folder;
  - `model: 'haiku'`, `settingSources: []`;
  - `forwardSubagentText: true`, `includePartialMessages: true`, `perTaskStopAffordance: true`;
  - `canUseTool` that allows and logs.

  Every stdout line is teed to `<scratch>/raw-<scenario>.jsonl`. The forwards are built by `forwardText` (Task 14's template, typed in the script if Task 14 is not written yet).
- [ ] **Step 2: Run the scenarios** (prompts exactly):
  - A. `Use the Agent tool once, with subagent_type "general-purpose", description "Count to three" and prompt "Reply with exactly: 1 2 3". When it is done, reply with one line: Started.`
  - B. Three forwards to A's agent, one after another, each waiting for its turn: `Now reply with exactly: 4 5 6`, `Now reply with exactly: 7 8 9`, and a text that contains the line `----- end of message -----`.
  - C. `Use the Agent tool once with run_in_background true, subagent_type "general-purpose", description "Wait and count" and prompt "Run the Bash command: sleep 20. Then reply with exactly: done". Then reply with one line: Started.` Then at once a forward: `When you are done, also reply with exactly: extra`.
  - D. `stopTask(<C's agent>)` while it runs, then a forward to it.
  - E. An `Explore` agent (`description "List files"`, `prompt "List the files in this folder"`), then a forward to it.
- [ ] **Step 3: Read the raw logs and the agent transcripts** (`<CLAUDE_CONFIG_DIR>/projects/<munged>/<session>/subagents/`). Write down:
  - (a) whether `agent_id` equals `task_id` and the file name's id;
  - (b) whether the frames' `uuid`s equal the transcript lines';
  - (c) whether text and thinking frames arrive, and the prompt as a frame;
  - (d) the Agent result's `agentId:` line;
  - (e) for each forward: the tools called, `SendMessage`'s input fields, its result, Claude's last line;
  - (f) whether the agent resumed (`task_started` again with the same id, a new `run_id`), and how the message appears in its conversation and transcript;
  - (g) whether `SendMessage` asked for permission;
  - (h) D's refusal text, and E's outcome;
  - (i) each forward turn's duration and `total_cost_usd`, for the spec's question 3.
- [ ] **Step 4: Rule.**
  - **The check passes** when all three of these hold:
    - P1: in each of B's three forwards, Claude makes exactly one tool call, `SendMessage`, with `to` = the agent id and the message equal to the text, and its last line is `Forwarded.`;
    - P2: A's finished agent resumes and answers;
    - P3: C's running agent gets the message before it ends, or resumes with it after.
  - **When it passes:** update Tasks 15 and 17 to the observed shapes before dispatching them. These are `SendMessage`'s message field name, its result text, and how the message lands in the agent's conversation (the join rule of Task 17).
  - **When it fails:** Part B is dropped (ruling 1). Tell the person what failed, with the evidence, and go to Task 20.
  - **Findings that contradict Part A.** If (a) fails, stop and ask the person (history then needs another key). If (b) fails, nothing changes (Task 7's fallback keys cover it). If (c) shows no text frames, write Task 13b (below) and run it before Part B. If (d) fails, rows of finished agents stay openable only within a run; tell the person.
- [ ] **Step 5: Write the findings.** Add a section "Agent chat hand check" to `tests/fixtures/chat/README.md` with findings (a)–(h) in invented terms: no ids, paths or texts from the run. Give the person (i) and the outcome.
- [ ] **Step 6: Clean up.** Delete the scratch folder and the temp work folder. Delete `~/.claude/projects/<munged temp work path>` and, for each session id of the run, `~/.claude/file-history/<id>`, `~/.claude/todos/<id>*` and `~/.claude/session-env/<id>`. Leave `~/.claude.json` alone, and tell the person Claude Code added an entry for the deleted temp folder there.

**Task 13b (only if (c) shows no text frames): the transcript poll.** While an agent's page shows and the agent runs, `ChatHub` reads its transcript's newest page every 2 s. It merges through `AgentChats.history`, whose keys drop what is held, and sends the new items as `add` patches at the end. The poll stops when the page closes or the agent ends.
- Files: `src/main/chat/chat-hub.ts`, `src/main/chat/agent-chats.ts`.
- Test: `'a running agent's page takes new transcript lines every 2 s when no text comes live'` (`chat-hub.test.ts`, fake timers).

---

# Part B — writing to an agent (only if Task 13 passed)

### Task 14: the forward's contract — template, item, IPC

**Files:**
- Create: `src/main/chat/agent-forward.ts`
- Modify:
  - `src/shared/chat.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`;
  - `src/main/chat/chat-guards.ts`, `src/main/chat/chat-mirror.ts` (`isItem`);
  - `src/renderer/chat/chat-items.ts` (placeholder), `src/renderer/chat/chat-find.ts` (one case).
- Test: `tests/unit/agent-forward.test.ts` (new), `tests/unit/chat-cards.test.ts` (the guards' tests live there), `tests/unit/chat-mirror.test.ts`

**Interfaces — Produces:**

```ts
// src/shared/chat.ts
export type ForwardState = 'queued' | 'sending' | 'delivered' | 'failed' | 'skipped'
// ChatItem gains | { kind: 'forward'; id: string; agentId: string; label: string; text: string; state: ForwardState; reason: string | null }
// ChatSendOrigin gains 'agent' — main's own: isChatOrigin still refuses it from the window and from members
// IPC: chatAgentSend: 'chat:agent-send'; CtApi: chatAgentSend(tabId: string, agentId: string, text: string): Promise<string | null>
// agent-forward.ts
export const FORWARD_MARK = '----- message -----', FORWARD_END = '----- end of message -----'
export function forwardHeader(agentId: string): string             // `[ClaudeTerm: forward to agent ${agentId}]`
export function cleanLabel(s: string, max: number): string           // newlines → space; drops " ' ` “ ” ‘ ’ [ ] ( ) { } < >; spaces collapsed; trimmed; capped
export function forwardText(f: { agentId: string; type: string; description: string; text: string }): string | null   // null: a bad id
export function parseForward(text: string): { agentId: string; type: string; description: string; text: string } | null
export function forwardLabel(type: string, description: string): string   // 'Explore agent · Find the chart code'; 'Agent' for no type; no ' · ' part for no description
export function notForwardedReason(text: string): string | null           // the last non-empty line starting 'Not forwarded:', its rest trimmed, ≤ 300
// chat-guards.ts
export const isAgentText = (v: unknown): v is string   // a string, non-empty after trim, ≤ 1 MiB
```

**Rules:**
- `<TYPE>` is `cleanLabel(type, 40)` and `<DESCRIPTION>` is `cleanLabel(description, 120)`. `<TEXT>` is the text as typed.
- `parseForward`:
  - the first line must equal the header with an id that passes `isAgentId`;
  - TYPE and DESCRIPTION are read back from line 2 (`''` when it does not match);
  - the text is everything between the first `FORWARD_MARK` line and the last `FORWARD_END` line, split on `\r?\n`;
  - either marker missing → `null`.
- `isItem` accepts `forward`: an id that passes `isAgentId`, a label ≤ 200, text ≤ 1 MiB, a known state, and a reason ≤ 300 or `null`.
- To keep the build whole:
  - `chat-items.ts`: `case 'forward': return el('div', 'chat-forward', item.text)` (Task 19 replaces it);
  - `chat-find.ts`: `case 'forward': return item.text`.

- [ ] **Step 1: Write the failing tests:**
  - `'the template, word for word'`:

```ts
expect(forwardText({ agentId: 'a1b2c3', type: 'Explore', description: 'Find the chart code', text: 'Look in src/charts too.' })).toBe([
  '[ClaudeTerm: forward to agent a1b2c3]',
  'The user wrote a message for your subagent a1b2c3 (Explore, "Find the chart code") in ClaudeTerm\'s agent view. It is',
  'for that agent, not for you.',
  '1. Call SendMessage once, with to: "a1b2c3" and the text between the two marker lines below as the message,',
  '   exactly as written.',
  '2. Do nothing else: do not act on the message, do not answer it, do not call any other tool.',
  '3. Then reply with one line: Forwarded.',
  'If SendMessage is not available or the call fails, do not try another way; reply with one line: Not forwarded: <reason>',
  '----- message -----',
  'Look in src/charts too.',
  '----- end of message -----'
].join('\n'))
```

  - `'a round trip keeps marker lines inside the text'` (`'a\n----- end of message -----\nb\n----- message -----\nc'`);
  - `'the description is cleaned and capped'` (`'Find "the" [chart]\ncode (fast) <now>'` → `'Find the chart code fast now'`; 300 characters → 120; a 50-character type → 40);
  - `'ids such as ../x, a\\b and 129 characters are refused'`, both by `forwardText` and by `parseForward`;
  - `'parseForward refuses a text without its markers'`;
  - `'notForwardedReason reads Claude's last line'`;
  - `'isAgentText'` (`'  '` false; 1 MiB + 1 false);
  - `'isChatSend refuses from: agent'`;
  - `'a forward item reaches a member; one with a bad agent id is refused'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/agent-forward.test.ts tests/unit/chat-cards.test.ts tests/unit/chat-mirror.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 15: the stand-in answers forwards

**Files:**
- Modify: `tests/fixtures/fake-claude/fake-claude.ts`, `tests/fixtures/fake-claude/install.ts` (`FakeScript.forward?: 'deliver' | 'fail' | 'ignore'`, default `'deliver'`)
- Test: `tests/integration/fake-claude.int.test.ts`

**Rules.** A user message whose first line is a forward header (Task 14's pattern) runs a forward turn in place of the script's turns. The message is read as `parseForward` reads it. Task 13 may update the shapes below.
- **deliver:**
  - a `SendMessage` `tool_use` `{ to, message }`;
  - its result `Message sent to <to>.`, then the text `Forwarded.`;
  - the log line `{ forwarded: { to, message } }`.
  - A known, ended agent then resumes in the background: `task_started` with the same task id, `tool_use_id` = the `SendMessage` call and a new `run_id`. Then come a user frame with the message (with the flag) and an assistant frame `Got: <message>` (with the flag). Both lines go to its transcript. After 300 ms comes `task_notification` `completed`.
  - A running agent gets the two frames at once, with no new `task_started`.
  - An agent that `stop_task` stopped, or an unknown id, gets `fail`'s answer instead.
- **fail:** the `SendMessage` call, an error result `agent was cancelled`, then the text `Not forwarded: agent was cancelled`.
- **ignore:** only the text `I will leave that to the agent.`

- [ ] **Step 1: Write the failing tests:**
  - `'a forward is delivered: SendMessage to the agent, Forwarded., the log line, and a finished agent runs again'`;
  - `'a running agent gets a forward without a new run'`;
  - `'a forward to a stopped agent fails: agent was cancelled'`;
  - `'forward fail and ignore answer as scripted'`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/fake-claude.int.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 16: a forward in the main conversation, and its delivery

**Files:**
- Modify: `src/main/chat/chat-model.ts`
- Test: `tests/unit/chat-model.test.ts`

**Interfaces — Produces:**

```ts
ChatModel.endForwards(reason: string): ChatPatch[]       // every queued or sending forward → failed with the reason
ChatModel.lastTurnWasForward(): boolean                  // the turn that began last carried only forwards
ChatModel.forwards(): Extract<ChatItem, { kind: 'forward' }>[]
```

**Rules.**
1. **The forward item.** `userSent` with `from: 'agent'` adds `{ kind: 'forward', agentId, label: forwardLabel(type, description), text, state, reason: null }` from `parseForward`, not a `user` item. Its state is `queued` when the send waits, else `sending`. A text the parser refuses is a plain `user` item. The echo is matched as any send's.
2. **When its turn begins.** Each place that unqueues a `user` item (`taken`, `turnBegins`, `result`) also turns a queued forward to `sending`.
3. **One tracked forward.** The forward whose turn began is tracked (`{ itemId, agentId, callId, lastText }`), and `lastTurnWasForward` is true. A turn that takes any `user` item makes it false.
4. **Delivery.**
   - A `SendMessage` `tool_use` whose `input.to` equals the agent id records the call.
   - That call's result settles it: `delivered`, or `failed` with the result's first line (≤ 300; `'Not delivered'` when the result is empty).
   - The turn's `result`, when the forward is still open: interrupted → `failed` `Interrupted`; a call without a result → `failed` `Interrupted`; no call → `skipped` with `notForwardedReason(lastText)`.
   - The next user message, `historyLoaded` and `endForwards` also end an open forward, by the same rules.
5. **History.** A `user` text whose first line is a forward header becomes the same item, tracked. Its turn's frames settle it.

- [ ] **Step 1: Write the failing tests:**
  - `'a sent forward is a forward item, not a bubble, and its echo adds nothing'`;
  - `'a forward queued behind a turn is queued, then sending when its turn begins'`;
  - `'SendMessage to the agent and its result: delivered'`;
  - `'an error result: failed with its first line'` (`'agent was cancelled\nmore'` → `'agent was cancelled'`; a 400-character line → 300);
  - `'no SendMessage in the turn: skipped, with the Not forwarded: line as the reason'`;
  - `'a SendMessage to another agent does not count'`;
  - `'an interrupted forward turn: failed, Interrupted'`;
  - `'endForwards fails the forwards still waiting'`;
  - `'a forward from history is a forward item, settled by its turn'`;
  - `'lastTurnWasForward is true after a forward's turn and false after a typed one'`;
  - `'recall with ↑ leaves forwards out'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-model.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it with the Task 3 command. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 17: sending to an agent — the hub, the page's bubble, the quiet turn

**Files:**
- Modify: `src/main/chat/chat-hub.ts`, `src/main/chat/agent-chats.ts`, `src/main/index.ts`
- Test: `tests/unit/chat-hub.test.ts`, `tests/unit/agent-chats.test.ts`, `tests/integration/agent-chat.int.test.ts`

**Interfaces — Produces:**

```ts
ChatHub.sendToAgent(tabId: string, agentId: string, text: string): Promise<string | null>   // null: sent or queued; else why not
ChatHub.quietTurn(tabId: string): boolean
AgentChats.forward(item: Extract<ChatItem, { kind: 'forward' }>): AgentChange[]
```

**Rules:**
1. **`sendToAgent`.**
   - Refusals: an id that fails `isAgentId` or an unknown agent → `'Unknown agent'`; no running chat → `'Claude Code is not running in this tab'`; the chat's mode is `plan` → `'Not sent: plan mode'`.
   - Otherwise it calls `send(tabId, { text: forwardText(…info…), attachments: [], from: 'agent' })`, so it queues behind a running turn like any message.
2. **The bubble.** Every `add` / `set` patch of a `forward` item also goes to `live.agents.forward(item)`, which adds or sets the bubble (the same id) at the end of that agent's items.
3. **The join rule** (with Task 13's shape). In an agent's model, a later user text that contains the text of a forward the agent holds draws no `From Claude` block. Folded from a transcript, such a line becomes that forward's bubble in place, unless the bubble is already held.
4. **After a history.** `ChatHub` passes `live.model.forwards()` to `forward()` before it calls `known()`.
5. **The end of a chat.** `drawEnd` and `finish` call `endForwards('Claude Code stopped')`.
6. **Writable.** `agentSnapshot` is `writable: live.ready && !live.ended` for the window, and `false` in `remoteAgentSnapshot`.
7. **`quietTurn`** = `live.model.lastTurnWasForward()`.
8. **`index.ts`.**
   - `IPC.chatAgentSend` checks `isId`, `isAgentId` and `isAgentText`, and calls a local Claude tab's `sendToAgent`. A remote tab gets `'Read-only on this device'`.
   - The pipe `attention` handler's `share` is false for `reason === 'done' && chatHub.quietTurn(tabId)`: no notification, no mark, no badge. The rest of the handler runs as before.

- [ ] **Step 1: Write the failing tests.**
  - Unit `chat-hub.test.ts`:
    - `'sendToAgent sends the template through the send path'`;
    - `'sendToAgent refuses: not running, unknown agent, plan mode'`;
    - `'the forward's bubble is on the agent's page with the same state'`;
    - `'quietTurn is true while the last turn is a forward's'`;
    - `'a chat that ends fails its waiting forwards: Claude Code stopped'`;
    - `'agentSnapshot is writable for the window while the chat runs, never for members'`.
  - Unit `agent-chats.test.ts`:
    - `'a frame that holds a forward's text joins its bubble; other text is From Claude'`;
    - `'after a history, a forward's text in the transcript is its bubble in place'`.
  - Integration `agent-chat.int.test.ts`: `'a forward round trip: the stand-in logs forwarded to the agent, the forward is delivered, and the agent runs again'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-hub.test.ts tests/unit/agent-chats.test.ts tests/integration/agent-chat.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them and `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 18: older members see a forward as a notice

**Files:**
- Modify:
  - `src/main/sync/wire.ts`, `src/main/sync/device-group.ts` (the hello and its deps), `src/main/sync/remote-link.ts`, `src/main/sync/tab-host.ts`;
  - `src/main/chat/chat-mirror.ts`, `src/main/remote-host.ts` (`chat-older`), `src/main/index.ts`.
- Test: `tests/unit/sync-wire.test.ts`, `tests/unit/chat-mirror.test.ts`, `tests/integration/sync-tab-host.int.test.ts`

**Interfaces — Produces:**

```ts
HelloMessage.app?: string                       // this app's version (app.getVersion()); a hello without it is an older device's
DeviceGroupDeps.appVersion: string
TabHost.addPeer(link: PeerLink, device: string, app?: string | null): void
TabHost.appOf(device: string): string | null    // null: an older member, or none
TabHostDeps.forOlder?(k: PushKind, v: unknown): unknown   // applied in pushTo for members whose app is null: attach pushes and live pushes alike
HostContext.memberApp?(device: string): string | null
export function itemForOlder(item: ChatItem): ChatItem    // chat-mirror.ts
export function olderChatPush(k: PushKind, v: unknown): unknown   // 'chat': its items mapped; 'chat-patch': add / set / reset mapped; else v
```

**Rules:**
- `parseHello` keeps `app` when it is a string of 1–32 characters matching `^[0-9A-Za-z.+-]+$`, and drops anything else.
- `itemForOlder`:
  - `forward` → `{ kind: 'notice', id, tone: state === 'failed' ? 'error' : 'info', text: `↗ To ${label}: ${first line of text}`, action: null }`;
  - `prompt` → `{ kind: 'notice', id, tone: 'info', text, action: null }`;
  - anything else as it is.
- The `chat-older` handler maps its items with `itemForOlder` for a device whose `memberApp` is `null`.

- [ ] **Step 1: Write the failing tests:**
  - `'a hello carries the app version, and a hello without one parses'` (`'0.18.0'` kept; `5` and 33 characters dropped);
  - `'itemForOlder turns a forward into a notice'`;
  - `'an older member gets forwards as notices, a newer one as forwards'` (two members on one `TabHost`, one with `app: null`);
  - `'chat-older answers an older member with notices'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/sync-wire.test.ts tests/unit/chat-mirror.test.ts tests/integration/sync-tab-host.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them and `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 19: the composer on the page, the bubbles and the note

**Files:**
- Modify: `src/renderer/chat/agent-page.ts`, `src/renderer/chat/agent-text.ts`, `src/renderer/chat/chat-items.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`, `src/renderer/main.ts`
- Test: `tests/unit/agent-text.test.ts`, `tests/e2e/chat-agent-page.spec.ts`, `tests/e2e/chat-devices.spec.ts`

**Interfaces — Produces:**

```ts
// agent-text.ts
export function forwardMark(state: ForwardState, reason: string | null): string
export const WRITE_HINT = 'Claude forwards it with SendMessage · uses a turn of the main conversation'
export const STOPPED_HINT = 'You stopped this agent: Claude may not be able to resume it'
export const OFF_EXITED = 'Claude Code is not running in this tab'
export const OFF_MEMBER = 'Read-only on this device'
// ChatViewOptions gains  sendToAgent(agentId: string, text: string): Promise<string | null>; readOnly: boolean   (main.ts: info.remote !== undefined)
```

**Rules:**
1. **The marks** (`forwardMark`):
   - `queued` → `via Claude · Queued`;
   - `sending` → `via Claude · Sending…`;
   - `delivered` → `via Claude · Delivered`;
   - `failed` → `via Claude · Not delivered: <reason>`;
   - `skipped` → `via Claude · Not delivered: <reason>` when there is a reason, else `via Claude · Claude did not forward it`.
2. **The composer** (`.agent-footer`):
   - `textarea.agent-input` with the placeholder `Message the <type> agent…` and the hint `.agent-hint` `WRITE_HINT`; the hint is `STOPPED_HINT` for a stopped agent;
   - no attachments, no `@`, no `/` menu, no chips;
   - Enter sends, Shift+Enter starts a new line;
   - a refusal shows in `.agent-refusal` and the draft stays; a send clears it;
   - Esc returns with the draft kept;
   - drafts are kept per agent in `ChatView` while the tab lives.
3. **When writing is off,** the footer is one line, `.agent-off`: `OFF_MEMBER` when `readOnly`; else `OFF_EXITED` when the chat state is `exited` or the snapshot is not writable.
4. **The bubbles.** A `forward` item on the page is `.chat-user-row.forward`: the bubble, then `.agent-mark` `forwardMark(…)`, with an error tone for `failed`.
5. **The note in the main conversation.** It is `.chat-forward`, one quiet line, `↗ To <label>: <first line of text>`, followed by its mark. A click opens the agent's page.
6. **`main.ts`.** In the `keydown` handler, `agent-input` counts as the composer for app chords, as `chat-input` does.

- [ ] **Step 1: Write the failing tests:**
  - unit: each mark;
  - e2e `chat-agent-page.spec.ts`:
    - `'a message to a finished agent: Delivered on the page, a note and no bubble in the main conversation, the stand-in forwards it, and the agent runs again'`;
    - `'a forward Claude fails says Not delivered: agent was cancelled'` (`forward: 'fail'`);
    - `'a forward Claude ignores says Claude did not forward it'` (`forward: 'ignore'`);
    - `'a click on the note opens the agent's page'`;
    - `'in plan mode the page says Not sent: plan mode and keeps the draft'`;
    - `'a stopped agent's composer warns that it may not resume'`;
    - `'a chat that has exited says Claude Code is not running in this tab'`;
    - `'a draft is kept per agent, and Esc keeps it'`;
    - `'the forward turn is quiet: no done sound and no mark'` (`CLAUDETERM_TEST_SOUND_LOG`; a shell tab in front; the pipe `attention` `done` after the forward's turn → nothing played, no `.attention`; after a typed turn → the sound plays);
  - `chat-devices.spec.ts`: `'a member's agent page says Read-only on this device'`.
- [ ] **Step 2: Run** the unit test and both specs through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, and `tests/e2e/chat-composer.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 20 (after everything that ran): README and the whole run

**Files:**
- Modify: `README.md` (the Chat section)

**Rules.**
- **The README.** Add a short paragraph on agent pages: a click on an agent in the dock or in a step opens its conversation; Esc goes back; a member device can read it. With Part B, add: writing goes through Claude's `SendMessage` and costs a turn of the main conversation. Screenshots stay as they are unless the README text points at one; if it does, run `npm run screenshots` with invented data only, and keep only the changed images.
- **The whole run.** `npm run typecheck`, `npm test`, `node .superpowers/sdd/locked.cjs "node scripts/e2e.mjs"` and `node .superpowers/sdd/locked.cjs "npm run perf"`.
- **Clean up.** Delete what the tasks left in scratch folders.

- [ ] **Step 1:** Write the README text.
- [ ] **Step 2: Run** the whole run. Expected: green. A flaky spec is rerun alone before anything else.
- [ ] **Step 3:** Leave the changes uncommitted, and tell the person what is ready to commit.
