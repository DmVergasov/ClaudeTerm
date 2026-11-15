# Project coordinator — design

## Why

The person often runs several Claude sessions on one project at once: a report, a crash triage, a UI fix, sometimes on
two computers (a paired device). Today they steer each one by hand: switch tabs, carry results from one to another, keep
in mind who is waiting for them. They want to steer them from one tab: tell one Claude, the coordinator, what is needed,
and it gives the sessions their work, follows them, and tells the person how it went.

Claude Code's **Projects** (claude.ai/code and the desktop app) do this with cloud threads: one conversation splits the
work into threads, each a separate session with its own context, that report back when they finish. Projects are not
available in the CLI, the IDEs or the SDK, run their threads in the cloud, and cannot take over a session that already
runs. ClaudeTerm's coordinator is the local counterpart: its sessions are ClaudeTerm tabs, on this computer or a paired
one; any running session can join or leave; sessions may share a folder and a branch.

What Projects documents is followed where it fits (code.claude.com/docs/en/claude-projects): a thread reports back when
it finishes; a permission prompt is answered by the person inside that thread, never by the coordinator; the overview
groups threads as Waiting on you, Working, Idle and Resolved.

## Goals

1. **A coordinator per project.** The person makes a Claude tab the coordinator of its project (its git repository,
   worktrees included). One coordinator per project on a device.
2. **Attach and detach any session.** A Claude session on this device or on a paired one joins a coordinator or leaves
   it: by the coordinator's MCP tools, by buttons in its Sessions panel, and by dragging a tab onto the coordinator in
   the tab list (and out of it to detach). Attaching never interrupts or restarts a session.
3. **New sessions.** The coordinator opens a new Claude tab with a task: in a folder it names, on this device or a
   paired one; in a new worktree when it asks for one.
4. **Tasks and reports.** The coordinator gives an attached session a task. When the session's turn on that task ends,
   ClaudeTerm sends the coordinator a report (the session's last answer) and wakes it; also when the task fails.
5. **The Sessions panel.** A side panel of the coordinator's tab shows its sessions grouped by state, and the project's
   sessions that are not attached.
6. **Across devices.** Everything above works for sessions on paired devices.

## Non-goals

- Pull requests, CI and reviews (Projects' Ready for review, Landing, auto-fix).
- Answering a session's permission prompt or question for the person.
- Cloud sessions: a session runs only while the ClaudeTerm that hosts it runs.
- A shared memory or file library like Projects': the project note exists for shared notes.
- A coordinator for a folder outside git ("No project").
- A coordinator that spans several projects. (It may attach a session of another project; see Behaviour.)
- Using a coordinator from another device's window. Its Sessions panel, its context menu items and drag-to-attach work
  in the window of the device it runs on; from a paired device its tab is a remote tab as today (its conversation
  works, nothing more). Kept for later: the state keyed by session ids and the mail records leave room for it.

## Anti-goals

- **The coordinator spends no usage on noise.** It is woken only by the end or the failure of a task it gave. The
  person's own messages in a session, a session waiting for a permission, a usage limit: shown in the panel, the button's
  count and the existing notifications, never a coordinator turn.
- **Nobody answers for the person.** A typed "yes" in the coordinator's conversation does not press Allow anywhere.
- **No session is taken over by surprise.** Attaching does not send the session anything; only a task does.
- **ClaudeTerm still never writes to the person's repository.** No `git worktree add` by ClaudeTerm (AGENTS.md: it only
  reads the repository).
- **A session belongs to at most one coordinator.** Two coordinators never give one session conflicting tasks.

## What the person sees (approved mockup, variant A)

The mockups were made on the real window (master build, tabs on the left, the Graphite theme) in the conversation of
2026-11-14. Variant A, a Sessions side panel, was chosen over B, a sessions block above the coordinator's message box.

**Tab list (left).** It stays as it is: projects as groups, other devices as their own sections. New:

- The coordinator's row shows a small **Coordinator** label (accent colour) after its title.
- The sessions attached to it from the same group come right after it, indented, with a thin guide line on their left.
- An attached session in another group of this device shows `↳ <coordinator's project>` at the end of its second
  line (e.g. `↳ Offroad`).
- An attached session on another device is shown in the coordinator's block only, after the attached rows of this
  device, with its device's chip (the colour bar and the device's name) at the end of its second line; its device's
  section no longer lists it. Detached, it is back in its device's section. (Decided on 2026-11-15 on a mockup, over
  showing it in both places.)
- A session that is not attached looks exactly as today.
- Row states are today's: the spinning icon while working, the attention style while it waits for the person.

**The coordinator's header.** After the branch: `Coordinator · 4 sessions` in muted text. A **Sessions** toggle (a
people icon) between Changes and Media, with the existing badge showing how many sessions wait for the person. Only a
coordinator tab has it.

**The Sessions panel.** A side panel like Changes, Media and Docs:

- A toolbar: **+ New session**, **Attach…**.
- Groups with a count, each folding on a click: **Waiting on you** (a permission or question pending, a usage limit, a
  failed task), **Working**, **Idle** (its task ended and nothing pends), **Resolved** (folded by default), **Not
  attached** (the project's sessions on any device that are not attached).
- A row: the state icon (an amber dot, the spinner, a check, a red dot for a failure or a limit), the session's name, a
  device chip (the device's colour bar and name) for a session on another device, the time of its last change; then
  `folder · branch`; then one status line: the pending permission or question ("Allow Bash: python tools/fetch_net.py
  --env prod"), "Usage limit · resets 22:00", the task list's progress ("3/7 · Grouping crashes by call stack" with a
  thin progress bar), "Finished · report ready".
- On hover: **Open** (brings the session's tab to the front), **Message**, **Detach**; in Not attached, **Attach**;
  in Idle, **Resolve**. A click on the row opens the session.

**The coordinator's conversation.** Its tool calls show as ordinary tool rows (`start_session`, `attach_session` …).
A report shows as a card in the look of the agents block: its head is `<session> · finished` (or `· failed: <why>`)
`· <time>`, the device's name for another device, and **Open session** / **Resolve**; its body is the report, as
Markdown, with its file links working. The mockup also showed "waits for your permission" and "usage limit" cards in the
coordinator's chat; the later decision (the anti-goal above) drops them: those states show in the panel only.

**An attached session's tab.** Its header shows `↳ Reports to <project> coordinator` and a **Detach** button. A task
arrives as a message from the coordinator. Its permission prompts are its own, answered there.

**Drag and drop in the tab list.** Today a drop onto a row reorders within its group (`tab-panel.ts`, `tab-groups.ts`);
there is no drop between rows. So:

- Dropping a Claude tab **onto the coordinator's row** attaches it (the row highlights as a drop target). Reordering
  onto the coordinator's row is lost, which costs nothing: the coordinator stays first in its block.
- Dropping a row onto another row reorders, as today; inside the coordinator's block it reorders the attached rows.
- Dropping an attached row **onto a row outside the coordinator's block** (or onto another group) detaches it and
  puts it there. Moving attached rows next to the coordinator is a real tab reorder (the panel writes its order back);
  after a detach the row stays where it was dropped.
- Dropping a tab onto the **Sessions panel** attaches it too.
- A tab of a paired device can be dropped onto the coordinator the same way. Dropped onto a row outside the
  coordinator's block, an attached tab of a paired device is detached and goes back to its device's section; inside the
  block it is not reordered (its device owns its order).
- **Tabs at the top** (the other tab layout): the coordinator's tab shows the Coordinator mark, a drop onto it attaches,
  and attached tabs move next to it; there is no indentation and no `↳` there. Detaching is by the panel or the tab's
  context menu. Tabs of paired devices stay where they are in this layout.

**The tab's context menu.** Besides drag and drop, a Claude tab's context menu attaches and detaches (decided on
2026-11-15 on a mockup): a tab that has a session, is no coordinator and is not attached has **Attach to the <project>
coordinator**, one item per coordinator of this device, the tab's own project's first (a local tab keeps **Make project
coordinator** under them); an attached tab has **Detach from the <project> coordinator**. A tab of a paired device has
the same items, and never Make or Stop: a coordinator is used from its own device's window.

## Behaviour

**Making a coordinator.** The tab's context menu has **Make project coordinator** (a Claude tab in a git project only)
and, on a coordinator, **Stop coordinating**. When the project already has a coordinator on this device, ClaudeTerm asks
whether this tab replaces it; the old one's sessions move to the new one, with their open tasks (a report then says the
task was given by the previous coordinator). Stopping detaches every session; the sessions go on working. Closing the
coordinator's tab stops it the same way, and drops its open tasks. Quitting and restoring ClaudeTerm keeps the role, the
attachments and the open tasks.

**A new session id in the same tab.** `/clear`, and in the chat view a new id after a clear or a compaction, give the
tab a new session id. The role, the attachments and the open tasks belong to the tab's conversation, not to an id: when
a coordinator's or an attached session's tab gets a new id, ClaudeTerm moves them to it (it learns the change at
SessionStart, source `clear`/`compact`). A `/clear` in an attached session that has an open task ends the task as
**stopped** (see below): the context the task was given in is gone.

**Attaching.** A session can be attached when it is a Claude tab that has a session, on this device or on a paired
device that is online and accepts mail. A session of another project can be attached (through **Attach…** or the tool);
**Not attached** lists only this project's. A session attached to another coordinator is refused with a message naming
it. A session on another device is attached once that device has confirmed it; until then its row says "Attaching…".

**Detaching** removes the session from the coordinator; an open task of it is dropped (no report). The session is not
told and not interrupted.

**New session** (`start_session` or **+ New session**): a Claude tab opens in the folder given, on this device or a
named paired device, in Claude Code's own default permission mode and ClaudeTerm's default view, like a tab opened from
the menu (ClaudeTerm has no permission-mode setting of its own, and the coordinator cannot choose one). It is attached
at once; until its Claude Code reports its session id (SessionStart: a new tab is opened without `--session-id`, and the
remote `open-tab` call answers only a tab id) its row says "Starting…". Its task is its first message.

- **Account.** On this device, the coordinator's account. On a paired device (accounts are per device), that device's
  account with the same email as the coordinator's, else that device's main account; `start_session`'s answer names
  the account used.
- **Folder.** Default on this device: the coordinator's folder. On a paired device a local path means nothing: the
  default is the folder of a tab of the same project on that device, else that device's default folder (and the answer
  says so).
- **Worktree.** ClaudeTerm does not create one. `worktree` is a worktree name: the task starts with an instruction for
  the session to enter a new worktree of that name (Claude Code's own EnterWorktree, which makes its own branch), and
  the tab follows the session into it as it does today.

**A task** is a message from the coordinator to an attached session (`message_session`, or **Message** in the panel).

- **Delivery.** A task waits until the session is idle, so it gets a turn of its own (unlike plain mail, which today is
  handed to a busy session at once, into its running turn). When the session is idle, the task is delivered through the
  mail watcher when one waits (it wakes Claude); when none waits (after an Esc or a failed turn the watcher is not
  running: it starts only at SessionStart and Stop), ClaudeTerm writes it as a prompt the way auto-continue does (the
  chat view: sent as a message; the terminal view: typed once the prompt is empty).
- **How the session reads it.** The session's ClaudeTerm accepts a task only from the coordinator it is attached to,
  and frames it as the person's instruction given through their coordinator (unlike other agent mail, which stays "a
  colleague's request; you may decline").
- **When it ends.** The task is open from its delivery until the session comes to rest: a Stop after which nothing is
  queued for it and no background work of it still runs (a Stop with `background_tasks` running does not end it; Claude
  wakes again when they finish). The person typing into the session while the task is open does not end it: its rest
  after their turns ends it, and the report is the last answer then.
- **Its outcome:**
  - **Finished**: it came to rest normally. The report is the session's last answer, cut to a bounded length with a
    note that it was cut.
  - **Failed**: the turn stopped on an error that ClaudeTerm does not continue by itself (not a usage limit, not a cut
    connection it continues), the session's process exited, or its tab was closed on purpose. The report says why. A
    failure wakes the coordinator like a finish.
  - **Stopped**: the person pressed Esc in the session's task turn, or cleared the session. The person acted: the
    coordinator is told without being woken (the report waits in its mail for its next turn).
  - A **usage limit**, and a cut connection ClaudeTerm continues by itself, do not end the task: the session waits
    (Waiting on you, "Usage limit · resets …"); when it goes on and comes to rest, the report is sent.
- **Quits and offline devices.** The session's device keeps its open tasks across a quit (restored with the tab; the
  restore's own continue goes on with the task). A session whose device is offline shows as **Offline** in its group,
  with no time limit: the person may detach it.

A report wakes the coordinator as mail does. The person's own turns in the session outside a task send nothing. Tasks
and reports show in the Agent messages panel like other mail; `attach` and `detach` records do not.

**States** (the panel's groups):

| Group | When |
|---|---|
| Waiting on you | a permission or question is pending; a usage limit stopped it; its last task failed (until the next task or Resolve) |
| Working | a turn runs |
| Idle | nothing of the above |
| Resolved | the person or the coordinator resolved it; a new task un-resolves it |
| (in its group, marked) Offline / Starting… / Attaching… | its device is offline; a new session has no session id yet; a remote attach is not confirmed yet |

Where each fact comes from, and what is new:

- **A pending prompt** is not today's attention (attention starts only when nobody looks at the tab and clears once
  someone does). It is "a permission or question dialog is open" on the session's own device (ReviewHub keeps the open
  dialogs). New: that state is kept per tab and published, also to paired devices. Its text: the chat view has the
  card's tool and input; for the terminal view the hook gives what it can (the Notification message, the tool name),
  else the line says "Waiting for your permission" / "Waiting for your answer".
- **A usage limit:** today recorded only when auto-continue after a limit is on and the reset time is known. New: a
  `StopFailure` with `rate_limit` marks the tab as stopped by a limit (with the reset time when known) until its next
  turn starts.
- **Working, exited:** `TabInfo.activity`, `TabInfo.exited`, the `RemoteTab` `working` field.
- **Task list progress:** `TaskListHub.status(tabId)` on the session's device.
- **For a session on a paired device** the panel needs fields `RemoteTab` does not carry today (its `status` is only
  "model · n% context", and plan and status updates go only to a device viewing that tab): the pending prompt, the limit
  stop with its reset time, the task list progress, the open task. New `RemoteTab` fields, published like the others.

**The coordinator's MCP tools** (in the bundled `claudeterm` server; they answer only in a coordinator tab, elsewhere
with an error saying the tab is not a coordinator):

| Tool | What it does |
|---|---|
| `list_sessions` | the attached sessions with state, current task, last report time, task list progress; then the project's sessions not attached |
| `start_session` | opens a new session: `task`, optional `name`, `folder`, `device`, `worktree` (a branch name); returns its ref |
| `attach_session` / `detach_session` | by the ref or name `list_sessions` and `list_agents` show |
| `message_session` | gives an attached session a task |
| `read_session` | one session in detail: state, its pending prompt if any, the open task, the last report in full, the task list |
| `resolve_session` | marks a session resolved |

The server's instructions are one fixed string for every Claude session, and the server cannot know its tab is (or
becomes) a coordinator. So the coordinator's guidance goes into these tools' descriptions and answers (above all
`list_sessions`): reports come by themselves, a pending permission is the person's to answer (say once where it waits),
a usage limit is not a failure, a stopped task was stopped by the person.

**Requirements.** Tasks and reports ride on agent mail, so they need what mail needs today: mail on in Settings and
Claude Code ≥ `MAIL_MIN_CLAUDE`. Without it, the Sessions panel says so, with a link to the setting; attaching is refused
with the same message.

## How it is built

The chosen approach: on top of agent mail and the bundled `claudeterm` MCP server.

- **Mail carries the work.** A mail record gets a kind: `message` (today), `task`, `report`, `attach`, `detach`. `task`
  wakes the session when it is idle (see Delivery). `report` wakes the coordinator, except a **stopped** report, which
  waits for its next turn. `attach` and `detach` wake nobody: they tell the session's device that the session is (no
  longer) attached, so its tab can show it, it accepts tasks only from that coordinator, and it refuses a second one.
  Records cross devices through `MailSync` as today. A record's text and fields are untrusted on arrival (another device,
  any local process on the pipe): validated, bounded; every record still has a non-empty text.
- **Older devices.** `mail-record.ts` keeps only known fields and `v: 1`: an older ClaudeTerm would strip `kind`, wake a
  session with an `attach` as a plain message, and never report a task. So a paired device takes part only when its
  hello says it knows coordinator records (a capability flag next to `mail`); a session on a device without it cannot
  be attached, and Attach says why.
- **Tasks have their own state** on the session's device. Today's mail turn count (`handOver`, `takeMailTurn`,
  `userTurn`) cannot carry a task: every prompt submit resets it, ClaudeTerm's own typed continues included. A task
  is a small state machine (queued → delivered → open → finished / failed / stopped), driven by the session's turn
  events (UserPromptSubmit, Stop with its background tasks, StopFailure, Esc, exit, clear), saved with the session's
  device's data so it survives a quit.
- **The report is made where the session runs.** The `Stop` hook passes Claude Code's `last_assistant_message`
  (bounded) with its `done` message, the same in the terminal and in the chat view; `StopFailure` gives the failure.
  Main writes the `report` record to the coordinator's address.
- **Delivery without a watcher.** The mail watcher runs only from SessionStart and Stop (`claude-tab-settings.ts`); after
  a failed or interrupted turn none waits. A task (on the session's side) and a report (on the coordinator's side, whose
  own turn may have failed) are then delivered as a prompt, as auto-continue writes one (`writeToClaude`, after the
  empty-prompt check in the terminal view).
- **State lives with session ids,** not tab ids (tab ids change on a restore): the coordinators of this device (session
  id → project key), each coordinator's attachments (device id, session id), the open tasks (id, coordinator, session,
  delivered at). A store of its own in the data folder, saved like the task lists.
- **The panel's states:** see States above (what exists, what is new).
- **A new session on a paired device** needs the remote `open-tab` call to carry a folder (today it opens in that
  device's default folder): validated on the host (absolute, an existing directory), else the default folder. Its
  answer is a tab id; the session id follows at SessionStart and reaches the coordinator through the remote tab list.
- **Matching a remote session to the project** for Not attached: project keys are local paths, which differ between
  machines, so a remote tab is matched by its place's project name (case-insensitive). See Left to the builder.
- **The renderer:** a `sessions` side panel (`SidePanel`), a toggle and badge in `SheetHeader`, the coordinator label,
  the attached rows and the drop targets in the tab panel, the report card in the chat, the header line of an attached
  session.

## Approaches considered

1. **Agent mail and the `claudeterm` MCP server (chosen).** Mail already wakes an idle Claude in the terminal and the
   chat view, waits for a busy one, crosses to paired devices, and shows in the Agent messages panel. The coordinator
   adds a role, kinds of records, tools and a panel on top.
2. **Claude Code's own agent teams** (teammates, SendMessage). The lead spawns its teammates; it cannot take in a session
   already running in another tab or on another device, which is what the person asked for. Rejected.
3. **In-process tools through the Agent SDK,** for coordinators in the chat view only. Simpler to wire, but a coordinator
   could not live in a terminal tab, and tasks and reports would need a delivery path of their own, across devices
   too: mail done again. Rejected.

## Decided by the person

- One coordinator per project; any session can be attached and detached through MCP; per-session folder and branch,
  worktrees only when needed, sessions may share a branch.
- Behaviour taken from Projects: reports when a thread finishes, permissions answered by the person in the session,
  the status groups.
- The coordinator is woken only by the end or the failure of a task it gave; everything else shows in the panel and
  notifications.
- It works across paired devices: sessions on paired devices are attached, given tasks and report. The coordinator
  itself is used in the window of its own device only, for now.
- Variant A: the Sessions side panel.
- Drag a tab onto the coordinator to attach it, and out to detach it.

## Calls made in this design (the person may override)

- The role is given from the tab's context menu; replacing a project's coordinator asks first and moves the open tasks
  too; closing its tab stops it.
- The role, attachments and open tasks follow the tab's conversation across a new session id (`/clear`, compaction).
- A new session takes the coordinator's account (on a paired device: the same email, else that device's main account),
  Claude Code's default permission mode and ClaudeTerm's default view; the coordinator cannot choose a mode. On a paired
  device its default folder is a tab of the same project there, else that device's default folder.
- ClaudeTerm never creates a worktree: `worktree` is a worktree name; the session enters it itself with EnterWorktree.
- A task waits for the session to be idle, so it has a turn of its own; the attached session takes it as the person's
  instruction through their coordinator, and only from its own coordinator.
- A task ends when the session comes to rest (nothing queued, no background work of it running); the person's turns in
  between do not end it.
- Outcomes: finished and failed wake the coordinator; stopped (the person's Esc or clear) is told at its next turn; a
  usage limit, or a cut connection ClaudeTerm continues, is not an outcome.
- The report is the session's last answer, bounded; no extra model call.
- An open task survives the session's ClaudeTerm quitting; an offline device's session shows Offline with no time limit.
- Not attached lists only the coordinator's project; other projects' sessions are attached through Attach… or the tool.
- A session on another device is attached once its device confirms it; a device whose ClaudeTerm does not know
  coordinator records cannot have its sessions attached.
- Drop onto the coordinator's row attaches; drop onto a row outside its block detaches. Tabs at the top: the mark and
  drop-to-attach only.
- Tasks and reports show in the Agent messages panel; attach and detach records do not.

## Left to the builder

- The exact bound of a report and of a task's text, and how a cut report says so.
- How the chat view tells a report wake from other mail to draw the card, and how the terminal view shows it (the mail
  text as today is enough there).
- Drop-target visuals and the exact boundaries of "out of the coordinator's block".
- The store's file name and format, and its migration story (a new file needs none).
- How `list_sessions` and `read_session` format their text answers.
- Matching remote sessions to a project by more than the name (e.g. the repository's remote URL) if the place data can
  carry it cheaply.
