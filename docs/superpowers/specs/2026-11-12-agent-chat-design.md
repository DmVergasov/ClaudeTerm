# A chat with a subagent — design

Date: 2026-11-12
Status: draft, for the person's review
Builds on: `2026-11-11-chat-mode-design.md` (the chat) and the agents dock (`.superpowers/sdd/2026-11-11-chat-mode-4-devices/followup-dock-brief.md`).
Research: `.superpowers/sdd/2026-11-11-chat-mode-4-devices/research-agent-chat.md`.

## Why

The person's words: "a click on an agent opens a chat with it, as the default terminal does". Claude Code's own terminal
lists running subagents under its prompt; Enter on a row opens that subagent's transcript, and typing there resumes it.
ClaudeTerm's chat shows the same subagents in the dock above the composer, but a row does nothing yet.

*The person's decision:* the agent's page lets them both **watch** the agent and **write** to it.

"Agent" here is a subagent of the tab's own conversation (an `Agent` / `Task` call), not a peer of the Agent messages
panel (`2026-11-10-agent-messages-design.md`).

## Background: what exists

- `src/main/chat/sdk-engine.ts` starts the SDK with `includePartialMessages` and `perTaskStopAffordance`, not
  `forwardSubagentText`. So Claude Code already sends the subagents' `tool_use` / `tool_result` frames (with
  `parent_tool_use_id` set), and `ChatModel.apply` (`src/main/chat/chat-model.ts`, first lines of `apply`) drops them.
- `ChatSubagent.id` is the `task_id` of `task_started` / `task_notification`. Failed and stopped both become `failed`.
- The dock (`ChatView.syncDock`, `fillAgentsCard` in `src/renderer/chat/chat-steps.ts`) draws the running agents, one
  row per agent with `data-agent=<id>`, and closes 4 s after the last one ends. The tool step keeps one row per Agent
  call ("✓ Agent  description").
- `src/main/transcript-feed.ts` already finds `<transcript dir>/<sessionId>/subagents/agent-<id>.jsonl`.
- From the SDK 0.3.322 types and docs (research §2):
  - `forwardSubagentText: true` forwards the subagents' text and thinking as whole blocks (no partial deltas), with
    `parent_tool_use_id` and `agent_id` set. `agent_id` equals the `task_id`, and stays the same when the agent resumes
    (a new `run_id` then).
  - A host has **no way to write into a subagent**. Only the model's `SendMessage` tool (`to: <agent id>`) does that.
    It reaches a running agent at its next step and resumes a finished one. An agent the person stopped refuses it.
  - `getSubagentMessages` reads only the app's own config folder, never a tab's `CLAUDE_CONFIG_DIR`.

## Goals

1. A click or Enter on an agent opens its page in the same chat tab, in place of the main conversation. This works
   from a dock row, from an Agent call's row in a tool step, and from a forwarded-message note (below).
2. The page shows the agent's conversation live, drawn by the main chat's own item renderers: text, thinking and tool
   steps. It also shows the agent's history after a restart, or once the agent has finished.
3. The person writes to the agent from the page. The message goes through Claude's `SendMessage`, and the page says
   whether it arrived.
4. Esc or the back arrow returns to the main conversation at the scroll position it had.
5. A member device can open the agent page of a host's chat tab, read-only.

## Non-goals

- Writing straight into a subagent, without Claude: the host has no such path (see Future work).
- Stopping or interrupting one agent from its page. The status bar's ✕ per background task stays the way to stop one.
  A stop also makes the agent refuse Claude's `SendMessage` later.
- Cards on the agent page. A subagent's permission request stays a card in the main conversation.
- Agent teams and named teammates, which Claude Code does not spawn in SDK sessions.
- Restoring an open agent page after the app restarts: the tab opens on its main conversation.

## Anti-goals: it fails even if it looks right when

- A subagent's frame shows up in the main conversation, or the main conversation's scroll position is lost on return.
- A key typed on the agent page answers a card, interrupts the main turn, or reaches the main composer.
- The page says "Delivered" when the agent did not get the message, or the main conversation shows the forward
  template instead of a short note.
- An agent id from the stream or from a file builds a path outside the session's `subagents` folder.
- Many agents make typing lag, or a hidden agent page costs renderer work.

## Decisions

- *The person's:* the agent page shows the agent's conversation and has a composer.
- *Controller's calls, from the research:*
  - The entry points and the header as in Goals.
  - Live data comes from `forwardSubagentText`, keyed by `agent_id`. History comes from `agent-<id>.jsonl`.
  - Writing goes as a main-conversation message that asks Claude to forward it with `SendMessage`. It is shown as a
    note in the main conversation and as a sent message ("via Claude") on the agent page.
  - The hook route (research §2c.2) is future work.
  - Members read only.
- *Controller's calls in this document* are marked where they are made.

## What the person sees

### Opening

- **Dock rows** become buttons: `role="button"`, `tabindex="0"`, and the tooltip "Open this agent". A click, Enter or
  Space opens the agent. The dock closes 4 s after the last agent ends, so the steps are the lasting entry:
- **An Agent / Task call's row** in a tool step opens its agent the same way, with a quiet "›" on hover and focus. A
  call whose agent is not known (no `task_id`, and no `agentId:` in its result) is not a button. A call with several
  agents opens the first one. *(Builder's call; Claude Code makes one agent per call today.)*
- **A forward note** in the main conversation (below) opens its agent.

### The page

- **It replaces the main column and the main composer** inside the same tab. The tab bar, the sheet header and the side
  panels do not change.
- **The dock stays** above the page's composer, with the open agent's row marked (`aria-current`), so the person can
  move from one agent to another. *(Controller's call.)*
- **The header**, one line:
  - a back arrow button, tooltip and `aria-label` "Back to the conversation";
  - the agent's type (`Explore`, `general-purpose`) as a quiet chip;
  - its description;
  - on the right, its state:
    - running: the dock's ring in the agent's colour and "Running · 42s";
    - done: ✓ and "Done · 1m 12s";
    - failed: ✕ and "Failed · 12s";
    - stopped: ✕ and "Stopped".
- **The conversation**: one column with the main chat's width, padding and fade, drawn by `renderItem` and
  `renderSteps`.
  - First comes the prompt Claude gave the agent: a quiet block headed "Claude asked", Markdown, folded after six lines
    with "Show all".
  - Then the agent's text, thinking and tool steps. Later messages from Claude to the agent are blocks headed
    "From Claude".
  - Each resumed run starts with a divider "Resumed". An ended run ends with "Agent finished · 1m 12s", "Agent failed"
    or "Agent stopped".
  - The column sticks to the bottom while the agent writes, with the same "↓ New messages" pill. Older items load as the
    person scrolls up. Find (`Ctrl+Shift+F` / `⌘F`) searches the page that shows.
- **Empty states:**
  - "Nothing yet — the agent has just started", while it runs and has said nothing;
  - "This agent's conversation was not saved", when it has ended, has no transcript, and nothing came live.
- **A card waiting in the main conversation**: a bar under the header says "Claude is waiting for your answer" with
  **Back to the conversation**. Enter on the bar, or a click, returns and focuses the card. *(Controller's call.)*

### Writing to the agent

- **The composer** is text only: no attachments, no `@`, no `/` menu, no mode or model chips. The placeholder is
  "Message the Explore agent…", and the hint under it is "Claude forwards it with SendMessage · uses a turn of the main
  conversation". Enter sends, Shift+Enter starts a new line. A draft is kept per agent while the tab lives.
- **On the page**, a sent message shows as a right-aligned bubble with a mark under it:
  - "via Claude · Queued", while the main conversation is busy;
  - "via Claude · Sending…";
  - "via Claude · Delivered";
  - "via Claude · Not delivered: <reason>" (error tone);
  - "via Claude · Claude did not forward it".
- **Resuming**: when a finished agent is resumed, the header goes back to Running, and the dock opens again.
- **When writing is off**, the composer is replaced by one line:
  - "Claude Code is not running in this tab", when the chat has exited;
  - "Read-only on this device", on a member device.
- **A stopped agent** keeps the composer, with the hint "You stopped this agent: Claude may not be able to resume it".

### In the main conversation

- **A forward is a compact note, not a bubble.** It is one quiet line: "↗ To Explore agent · Find the chart code: <first
  line of the message>". It carries the same delivery mark, and a click opens the agent page.
- The turn's own `SendMessage` step and Claude's one-line reply are drawn as usual. `toolSubject` gives `SendMessage`
  the subject "to <agent id>".

### Keys

- **Esc on the page** returns to the main conversation. It never interrupts a turn. A draft stays in the composer.
- **Keys on the page** never reach a card or the main composer.
- **Leaving and coming back:**
  - Switching tabs keeps each tab's page open.
  - A snapshot reload (`reset`) keeps the page open while the agent is still known.
  - A switch to the terminal view closes it.

## How it works

### Main: routing the frames (`src/main/chat/chat-model.ts`, new `src/main/chat/agent-chats.ts`)

- **`forwardSubagentText: true`** is set in `sdk-engine.ts`.
- **Where a frame goes.** In `ChatModel.apply`, a message with a non-empty `parent_tool_use_id`, or with an `agent_id`,
  still adds nothing to the main list. It goes to the tab's `AgentChats`:
  - the key is `agent_id`;
  - without one, its `parent_tool_use_id` is mapped to a task through `task_started.tool_use_id`;
  - a frame that names neither waits in a buffer per `parent_tool_use_id` until `task_started` names it. The buffer
    keeps at most 200 frames per tab.
- **One model per agent.** It has its items, its own revision, its header (type, description, state, start, end and
  how it ended) and its forwards.
  - The folding is the main model's own code, reused, not forked. The builder extracts the assistant / user /
    tool-result folding so that both use it.
  - The agent's first user message becomes the "Claude asked" item. Later user text becomes "From Claude".
- **Changes in `ChatModel`:**
  - `task_started` for a `task_id` it knows (a resume) sets that agent back to running and adds the "Resumed" divider.
  - `ChatSubagent` keeps whether a failed agent failed or was stopped, as a new field.
  - In history, an Agent call's result that ends with `agentId: <id>` gives the call its agent when no `task_started`
    was saved. So rows stay openable after a restart.
- **Memory caps** *(controller's starting values; the builder may tune them):*
  - text and output as in the main chat (1 MB per text item, 64 KB per output);
  - at most 1,000 items per agent in memory. Older ones are dropped and paged back from the transcript;
  - at most 50 agent models per tab. The finished agent updated least recently goes first, and it is rebuilt from
    its transcript when opened.

### Main: history (new `src/main/chat/agent-history.ts`)

- **When it is read.** On the first open of an agent, and whenever its model was evicted or predates this process.
- **Where it is read from.** The folder comes from the tab's transcript path (from the SessionStart hook):
  `<dir of transcript>/<sessionId>/subagents/agent-<agentId>.jsonl`. *(Controller's call.)*
  - This uses the tab's own config folder, which matters for sign-in accounts (`2026-11-12-extra-accounts-design.md`).
    `getSubagentMessages` reads only the app's folder.
  - The agent id must match `^[A-Za-z0-9_-]{1,128}$` before it is joined into a path.
  - The resolved file must lie inside that `subagents` folder (`pathKey`, after `realpath`).
- **Reading.** Lines are read from the end in pages, as `SessionHistory` reads windows, and a page never blocks main.
  Each line is validated like a live frame. A broken line is skipped.
- **Merging with live items.**
  - Transcript items come first, then the live ones.
  - A frame is dropped when its `uuid` is already in. The fallbacks are `message.id` plus the block index, and
    `tool_use_id` for results.

### Writing: the forward (new `src/main/chat/agent-forward.ts`, pure)

- **The path.** `ChatHub.sendToAgent(tabId, agentId, text)` sends one main-conversation message through the existing
  send path. It queues behind a running turn like any message.
- **The template** (controller's call; the builder keeps it word for word):

```
[ClaudeTerm: forward to agent <AGENT_ID>]
The user wrote a message for your subagent <AGENT_ID> (<TYPE>, "<DESCRIPTION>") in ClaudeTerm's agent view. It is
for that agent, not for you.
1. Call SendMessage once, with to: "<AGENT_ID>" and the text between the two marker lines below as the message,
   exactly as written.
2. Do nothing else: do not act on the message, do not answer it, do not call any other tool.
3. Then reply with one line: Forwarded.
If SendMessage is not available or the call fails, do not try another way; reply with one line: Not forwarded: <reason>
----- message -----
<TEXT>
----- end of message -----
```

- **What goes into the template.**
  - `<TYPE>` and `<DESCRIPTION>` lose their newlines, quotes and brackets, and are capped at 40 and 120 characters.
  - `<TEXT>` is the person's text as typed. The parser takes everything between the first `----- message -----` line
    and the final `----- end of message -----` line, so the person's text may contain the marker lines.
- **The sent text.** `ChatModel.userSent` takes it with the origin `agent`. Its echo is matched like any send, and the
  item drawn is a `forward` item `{ agentId, label, text, state, reason }`, not a `user` bubble.
- **History.** A user message whose first line is the template's header becomes the same `forward` item.
- **Delivery.** The model follows the forward's turn:
  - a `SendMessage` `tool_use` with `input.to` equal to the agent id makes it `sending`;
  - that call's result makes it `delivered`, or `failed` with the result's first line (≤ 300 characters);
  - a turn result with no such call makes it `skipped`. When Claude's last line starts with "Not forwarded:", that line
    is the reason;
  - an interrupted turn makes it `failed` with "Interrupted".
- **On the agent page**, the same item is the bubble with its mark. When `SendMessage` lands in the agent's own
  conversation as a user message containing the text, that message joins the bubble instead of a "From Claude" block.

### IPC, preload and renderer

- **Types** in `src/shared/chat.ts`:
  - `AgentSnapshot { tabId, agentId, rev, items, hasOlder, agent, writable }`;
  - the `forward` and `prompt` item kinds;
  - the origin `agent`;
  - the field for how an agent ended.
- **Channels** in `src/shared/ipc.ts`, bridged in `src/preload/index.ts` and handled in `src/main/index.ts`:
  - `chat:agent-snapshot (tabId, agentId) → AgentSnapshot | null`;
  - `chat:agent-older (tabId, agentId, beforeId)`;
  - `chat:agent-watch (tabId, agentId | null)`: the window names the agent page it shows;
  - `chat:agent-send (tabId, agentId, text) → string | null`;
  - the event `ev:chat-agent-patch (tabId, agentId, fromRev, toRev, patches)`.
- **Checks.** Main checks every argument in `chat-guards.ts`: the agent id pattern above, and text that is non-empty
  after trimming and within the send cap.
- **Batches.** `ChatHub` sends the patches of the watched agent only, batched like the main chat (16 ms, and only for
  the tab in front).
- **Renderer:**
  - the new `src/renderer/chat/agent-page.ts`: the header, the column, the composer and the waiting bar;
  - `chat-view.ts`: open and close the page, and keep the main column's scroll anchor (`topItem` / `keepAt`). When the
    person was at the bottom, they come back at the bottom;
  - `chat-steps.ts`: the rows become buttons;
  - `chat-items.ts`: the `prompt`, `forward` and "From Claude" items;
  - `chat.css`.
- **While the page shows**, the main column keeps its model. Whether its DOM is updated meanwhile or redrawn on return
  is the builder's call, within the performance budget.

## Untrusted input

Everything here comes from Claude Code or from files Claude Code wrote, so:

- every field is type-checked and capped, as in `ChatModel`;
- unknown kinds give nothing;
- agent ids follow the pattern, and paths stay in the `subagents` folder;
- the template's parser never trusts a header for anything but drawing.

Markdown on the page goes through the chat's renderer: HTML is shown as text, and links open in the system browser.

## Failure modes

- **No live text** arrives from an older Claude Code, or with the flag ignored: the page shows the tool steps, and it
  re-reads the transcript every 2 s while it is open and the agent runs. *(Builder's call whether this is still needed
  after the hand check.)*
- **Frames come before `task_started`:** they are buffered, as above.
- **The transcript is missing or unreadable:** the page shows what came live, plus the empty state.
- **`SendMessage` is denied by the person's permission rules, or asks for permission:**
  - asking gives the usual card in the main conversation, and the page shows the waiting bar;
  - a denial gives "Not delivered: <reason>".
- **Claude paraphrases or does something else:** the page shows "Claude did not forward it" when no `SendMessage` to
  that id ran. Text that Claude did forward is not compared.
- **The chat exits, or the tab switches to the terminal,** while a forward waits: the forward ends as "Not delivered:
  Claude Code stopped".

## Other devices

- **What a member already has.** The host's chat snapshot already carries the agents, through the tools items, so a
  member's dock and step rows work.
- **Opening a page.** The member calls `chat-agent` `{ id, agentId }`, which returns the snapshot cut by `capSnapshot`,
  and `chat-agent-older`. It names the open page with `chat-agent-watch`. The host then pushes the kinds `chat-agent`
  and `chat-agent-patch` for that agent only. An older device drops kinds it does not know.
- **Older members.** For them, the host turns the new item kinds into `notice` items, because `chat-mirror.ts`'s
  `isItem` rejects a whole push that holds an unknown kind. *(Builder's call how the host tells the member's version.)*
- **Writing from a member** is the builder's call. If it is one call, `chat-agent-send`, into the same hub method, it is
  in; otherwise it is future work.

## Performance

The chat's budgets hold (`2026-11-11-chat-mode-design.md`, Performance):

- no renderer work for an agent whose page does not show;
- an agent with 1,000 items shows its last screen within 150 ms of opening;
- with ten agents running, typing in the main composer stays within one frame.

`npm run perf` gains the open-agent metric.

## Tests

No test starts the real `claude`. Everything goes through the stand-in, under `tmpdir()`.

### Stand-in changes (`tests/fixtures/fake-claude/fake-claude.ts`, `install.ts`)

- **The flag.** It reads `forwardSubagentText` from the initialize request.
- **Agent frames.** A `task` step's agent takes `frames?: FakeStep[]` (text, thinking, tool). These are emitted as
  assistant / user messages with `parent_tool_use_id` set to the Agent call's id, `agent_id` set to the task id, and a
  `uuid`. Text and thinking come only with the flag on; tool frames come always, as from the real CLI.
- **Transcripts.** It writes `<projectDir>/<session>/subagents/agent-<task id>.jsonl` with the same uuids. The Agent
  result ends with `agentId: <task id>`.
- **New agent options:**
  - `background: true`: the turn ends while the agent runs, and a `gate` step holds it;
  - `end: 'stopped'`;
  - `early: true`: one frame before its `task_started`.
- **Forwards.** A user message whose first line is the forward header is answered per script (`forward: 'deliver' |
  'fail' | 'ignore'`, default `'deliver'`):
  - deliver: a `SendMessage` tool_use `{ to, message }` and its result, then "Forwarded.", and the log line
    `{ forwarded: { to, message } }` to `FAKE_CLAUDE_LOG`. A finished agent then resumes: `task_started` comes again
    with the same task id and a new `run_id`, then a frame "Got: <message>", then `task_notification`;
  - fail: an error result, "agent was cancelled", then "Not forwarded: agent was cancelled";
  - ignore: text only.

### Unit (`tests/unit`)

- **`chat-model.test.ts`:**
  - a subagent frame never adds a main item and reaches its agent by `agent_id`, or through `parent_tool_use_id`;
  - early frames are buffered;
  - a resume sets the agent running, and "stopped" stays apart from "failed";
  - in history, the agent id comes from the `agentId:` line;
  - a forward echo, and a forward from history, become a `forward` item;
  - the delivery states: delivered, failed, skipped and interrupted.
- **`agent-forward.test.ts`:**
  - the template, word for word;
  - a build-and-parse round trip, with marker lines inside the text;
  - the description is cleaned and capped;
  - ids such as `../x`, `a\b` and 129 characters are refused.
- **`agent-chats.test.ts`:**
  - each cap;
  - de-duplication by uuid and by its fallbacks;
  - history comes before live items;
  - older pages;
  - the eviction order.
- **`chat-guards` and `chat-mirror`:** the new arguments, and the new item kinds, down-converted for old members.

### Integration (`tests/integration`)

- **`agent-history.int.test.ts`:**
  - a transcript under a temp `CLAUDE_CONFIG_DIR`, read in pages;
  - broken and huge lines are skipped or capped;
  - a `subagents` entry that is a symlink or junction pointing outside is not read;
  - on Windows, an 8.3 short path for the config folder.
- **`ChatHub` with the stand-in over real pipes:**
  - the initialize request carries the flag;
  - frames are routed to their agent;
  - a forward round trip shows in the stand-in's log.

### End-to-end (new `tests/e2e/chat-agent-page.spec.ts`; `chat-devices.spec.ts`)

- **Opening and returning:**
  - a click and Enter on a dock row open the page, with its header, its running ring, and live text, thinking and tool
    steps;
  - an Agent call's row in a step opens the page after the dock has closed;
  - the back arrow and Esc return to the same top item. Esc never interrupts: the stand-in logs no interrupt;
  - the header reaches "Done · …", "Failed · …" and "Stopped".
- **Writing:**
  - a sent message: the page shows "via Claude · Delivered", the main conversation shows the note and no bubble, the
    stand-in logs `forwarded` to that id, and a finished agent shows Running again;
  - "Not delivered: agent was cancelled", and "Claude did not forward it".
- **Other cases:**
  - a card in the main conversation shows the bar, and Enter returns with the card focused;
  - after a restart, a step's agent opens with its history from the transcript;
  - a member opens a host's agent page read-only, and its live frames arrive;
  - with reduced motion, the ring stands still.

## Answers for the builder (from the builder check)

- **Base.** The plan builds on the tree after the current chat follow-ups land (the agents dock above the composer with
  `syncDock`, the compaction/restart line, quoting, the chat theme); its execution starts after they are done, so those
  files are not shared with other work at that time. Read the current code, not HEAD.
- **Order and the writing half (controller's call).** The plan does the watch half first (routing, history, the page,
  back, members' read-only page) as a complete, shippable result. Its next task is the hand check of open question 1 with
  the person's real account, done by the controller (a few short messages in a scratch folder). The writing half follows
  only if the check passes; if it fails, the writing tasks are dropped and the page has no composer, and the person is told.
  `canUseTool`: a `SendMessage` whose `to` is the forwarded agent goes through the normal permission path (no special
  allow); in plan mode the forward is refused like any tool and the page says "Not sent: plan mode".
- **Nested agents (controller's call).** An agent started by an agent gets its own page, routed by its own `agent_id`;
  on its parent's page it is an Agent step row like on the main page (a button to its page). The dock lists only the main
  conversation's agents.
- **The forward turn is quiet (controller's call).** A main turn that only carries a forward does not send the "Claude
  finished" notification or the unread badge, and does not change the tab's attention state; it counts in usage like
  any turn.
- **Members' versions.** Devices of different `PROTOCOL_VERSION`s do not connect at all (`src/main/sync/wire.ts`). Within a
  version, a member running an older app rejects a push with an unknown item kind: the host learns the member's app
  version from its hello (add the app version to the hello if it is not there — a field older devices ignore) and turns
  the new kinds into `notice` items for members older than the release that adds agent pages.
- **Writing from a member**: out of scope (read-only, `writable: false`).
- **Eviction**: past the 50-model cap, an ended agent whose transcript cannot be read shows "This conversation was not
  saved" — accepted.

## Left to the builder

- How the folding is shared between the main model and the agent models.
- How the hidden main column is kept or redrawn.
- The page sizes.
- The transcript-polling fallback.
- Writing from a member.

## Future work

- **(b) Live, without Claude in the middle.** A host `PreToolUse` / `PostToolUse` hook that queues the person's text
  per `agent_id` and returns it as `additionalContext` on that agent's next tool call (research §2c.2). It is
  deterministic and costs no main turn, but it reaches the agent only at a tool boundary, and as context rather than a
  user turn. It falls back to the forward when the agent has ended.
- A Stop button on the page, and cards that name the agent that asks.

## Open questions for a hand check with a real account

1. In an SDK (stream-json) session, does `SendMessage({to: <agent id>})` reach a running subagent and resume a finished
   one? Does Claude follow the template exactly, with no paraphrase and no extra tools? And how does the message
   appear in the agent's own transcript?
2. With `forwardSubagentText`, is `agent_id` on the frames the same as the `task_id` and as the `agent-<id>.jsonl`
   name? Are the frames' `uuid`s those of the transcript lines? Does the transcript keep the Agent result's `agentId:`
   line, so rows work after a restart? Are Explore / Plan agents resumable at all?
3. *For the person:* is one main turn per message acceptable, in cost and in delay? While Claude works, the message
   waits for the turn to end, unless `priority: 'next'` folds it in (to be checked). Or should the hook route (b) come
   first?
