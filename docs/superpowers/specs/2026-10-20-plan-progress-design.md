# Plan progress in the status bar — design

Date: 2026-10-20
Status: agreed in chat, waiting for the user to review this document

## Goal

While Claude carries out a superpowers plan in a Claude tab, the user wants to see how far it has got without
scrolling the terminal back: a short status at a glance, and on a click the full list of what is done and what is
left. The point is transparency — knowing where the work stands when they choose to look, not being told.

## Background: where the progress is written

Two superpowers skills carry out a plan: `superpowers:subagent-driven-development` (Claude hands each task to
subagents) and `superpowers:executing-plans` (Claude does the tasks itself). Both keep the same record on disk, and
a plan can switch from one to the other mid-way:

- **The plan file**, usually `docs/superpowers/plans/YYYY-MM-DD-<name>.md`. Its first line is the title
  (`# <Feature> Implementation Plan`; older or non-English plans may differ, e.g. `# … — план реализации`). Each
  task is a heading `### Task <N>: <title>`, sometimes with a note before the colon
  (`### Task 9 (условная): …` — a conditional task). Headings inside code fences are examples, not tasks. The
  `- [ ]` checkboxes under the tasks are *not* ticked as work proceeds, so they say nothing about progress.
- **The plan's workspace**: `<root>/.superpowers/sdd/<plan-basename>/`, git-ignored, created by the skills'
  `sdd-workspace PLAN_FILE` script, which prints its absolute path. `<root>` is the repository the plan runs in —
  often a git worktree the skills created, which is not the tab's folder. A basename collision gets a suffixed
  directory name, so the directory name is not a reliable key; the `plan-path` file inside it is.
  - `plan-path`: the plan file's path, repo-relative or absolute. On Windows it can be an MSYS path written by Git
    Bash (`/d/Work/acme-shop/docs/superpowers/plans/…` for `D:\Work\acme-shop\…`).
  - `progress.md`, the ledger. First line `# SDD ledger — plan: <plan file path>`. A task is done when the ledger
    has a line starting `Task <N>: complete` (`Task 3: complete (commits a1b2c3d..d4e5f6a, review clean)`). The
    ledger has many other lines — `Task <N>: fix round …`, `Task <N>: parked …`, `Task <N>: Ruling: …`,
    pre-flight notes — that must not count as done.
  - `task-<N>-brief.md` appears when a task starts (both skills write one in the current superpowers 7.0.0).
  - At the end of a clean final review both skills delete the whole workspace (`rm -rf <workspace>`); the
    user's history shows this in every run where commits were allowed. Only runs that could not commit keep it.
    `git clean -fdx` mid-run also deletes it; the skills then rebuild the ledger from `git log`.
- **Not every task gets a `complete` line.** In this repository's status-bar plan, Task 1 and Task 10 were manual
  checks done with the user and Task 9 was a conditional task the run declined: none of them has a `complete`
  line, while Tasks 2–8 do. **The user's rule: a task the run went past counts as done** — every task before
  the furthest one with a `complete` line is shown and counted as done, whether it has its own line or not.
  Older superpowers versions wrote free-form ledgers with no `Task <N>:` lines at all; only the current format is
  supported.
- **The final review is often recorded**: lines starting `Final` (`Final review: …`, `Final: Ruling: …`) come after
  the last task — in 57 of 127 ledgers in another of the user's projects, and in both current-format ledgers here.
- In the subagent-driven skill's "cheaper orchestration" mode the whole loop runs inside one orchestrator subagent,
  so the skill call and every file operation are in that subagent's transcript, not the main one.

A real ledger from this repository's account-switching plan (7 tasks) was checked against its plan: the headings
and the `Task <N>: complete` lines match one to one.

**Claude Code's own todo list is not a source.** In the user's Claude Code (2.1.304) Claude never calls a todo
tool — none of their transcripts holds a `TodoWrite`/`TaskCreate`/`TaskUpdate` call — so there is nothing to read
for work outside a plan. See Out of scope.

## What the user sees

Mockup A, chosen in the brainstorm (`.superpowers/brainstorm/…/layout.html`, option A).

### The segment

A new segment in the Claude tab's status bar, shown only while the tab has a plan:

- in progress: a small progress bar, `3/7` and the title of the current task —
  `▰▰▰▱▱▱▱ 3/7 · Save dialog and file writing`;
- all tasks done: `✓ 7/7` (with the bar full or dropped — builder's call).

The current task is the first task without a `complete` line after the furthest task in plan order that has one
(Task 1 when none has); every task before it is done. A long task title is cut with an
ellipsis so the segment never pushes the others off the bar. The segment's tooltip names the plan and says
"click for the task list". It sits right before the Changes counter. Like the Changes counter (and unlike model,
context and limits), it does not come from Claude's `statusLine`, so it shows before the first status message and
after a restart too.

### The task list

A click on the segment opens a list in a box above the status bar, over the terminal; it takes no space in the
layout. A second click on the segment, a click anywhere else or Esc closes it. It shows:

- a header: the plan title (the first heading without a trailing ` Implementation Plan`) and `3 of 7 done`;
- every task in plan order: done ones with ✓ in muted text, the current one highlighted with ●, the rest with ○.

While it is open it updates as tasks complete. It lists tasks only — not the steps inside a task. All text in it
that is not taken from the plan is English, like the rest of the UI.

### When the segment comes and goes

- **Each tab its own plan.** A tab shows the plan that the Claude conversation *in that tab* is carrying out. Two
  tabs in the same repository running different plans show different segments. Old workspaces of finished or
  abandoned plans under `.superpowers/sdd/` never make a segment appear.
- **Appears** as soon as the conversation starts carrying out a plan — through either executor skill, in the main
  conversation or in an orchestrator subagent — and the plan file and workspace can be read.
- **After the last task** it stays as `✓ 7/7`, so the user can see the plan finished. The plan is finished when
  the last task has a `complete` line, when the ledger records the final review (a line starting `Final`), or when
  the workspace is deleted (that is how a clean run ends). A finished plan counts all its tasks as done
  (`✓ 10/10`, even when the last tasks were manual checks without a `complete` line), and after a deletion the
  segment keeps that state for the rest of the session. If the workspace comes back (rebuilt after a
  `git clean`), the segment follows it again.
- **A failed read changes nothing**: a file that is briefly unreadable or half-written keeps the last good state
  on screen instead of making the segment blink away.
- **Goes away** when the conversation starts another plan (the new one replaces it), when the conversation ends or
  is replaced (`/clear` starts a new session, which has no plan yet), when Claude exits to the shell, or when the
  tab closes. Compaction keeps the same session and keeps the segment.
- **Restart and restore.** A session restored after a restart, or resumed from Recent sessions, shows its plan's
  progress again while the workspace is still on disk: the transcript still holds the conversation's earlier calls.
  A plan whose workspace was deleted before the restart is over, and shows nothing.
- **Several plans in one session** happen (one session here ran three in a row): the latest one is shown.

### What it does not do

No sound, no taskbar flash, no tab highlight when a task completes or the plan finishes — the existing "Claude is
waiting for you" signals already cover that. The segment is there for when the user wants to look.

## How it works

Decided:

- **Sources: the transcript and the plan's files, read-only.** The tab learns *that* it carries out a plan, and
  *which one*, from its transcripts (main and subagents), which `TranscriptFeed` already tails for every Claude
  tab. Progress itself comes from the plan file and the workspace's `plan-path` and `progress.md`. ClaudeTerm never
  writes to the workspace, the plan or the repository. No new hooks and no changes to Claude Code.
- **Signals available in the transcript** (the builder picks the combination; it must work in every case listed
  under "Appears", including a plan in a worktree outside the tab's folder and a skill call without arguments):
  - a `Skill` tool call with `skill` `superpowers:subagent-driven-development` or `superpowers:executing-plans`;
    its `args` often hold the plan path, sometimes followed by free text, and sometimes nothing;
  - a `Bash` tool call running `sdd-workspace <plan>`, whose result is the workspace's absolute path (an MSYS
    path on Windows);
  - tool calls whose paths point into `<root>/.superpowers/sdd/<dir>/` (`progress.md`, the task briefs) — ledger
    writes are often Bash heredocs with relative paths rather than Write/Edit calls.
- **A new status source per tab in main**, next to `StatusHub` and `ReviewHub`, with fake dependencies in unit
  tests. It sends its state to the renderer over a new IPC channel (or as part of the status update — builder's
  call), and the renderer draws the segment and the list. The state the renderer gets is plain data: plan title,
  tasks with number, title and done/current/left, counts.
- **Main stays responsive**: files are read asynchronously, with a size cap (a plan of several thousand lines is
  normal — the account-switching plan here is over 2,000 lines), and re-read when they change, so a completed task shows
  within about a second or two. Polling or watching is the builder's call; nothing may block the event loop.
- **Untrusted input.** Transcript lines, the plan, `plan-path` and the ledger are all untrusted: validate, ignore
  what does not parse, cap sizes, and degrade to no segment rather than a wrong one. A plan file that cannot be read,
  or has no `Task <N>:` headings, means no segment. Ledger lines for task numbers the plan does not have are
  ignored. If the plan file changes mid-run (tasks added or renamed), the list follows it.
- **Paths** are compared with `pathKey`; expect `/` and `\`, MSYS paths in `plan-path`, 8.3 short names,
  junctions and symlinks. A repo-relative `plan-path` or `args` resolves against the workspace's `<root>`.
- **Lenient parsing**: task headings at levels 2–4 (`## Task 3:` as well as `### Task 3:`), an optional note
  between the number and the colon, any text after the colon as the title, headings inside code fences skipped,
  CRLF or LF.
- **Renderer**: a `plan` segment in `status-bar.ts` following the existing segment pattern (spans updated in
  place, so a tooltip or an open list is not torn down by every status refresh), and the list box in plain
  TypeScript, styled with the app's colours. Shell tabs never get the segment.

Left to the builder: the exact detection logic within the rules above, the IPC shape, polling vs watching, the
box's styling details and its keyboard focus handling, and how the segment looks when all tasks are done.

## Out of scope

- **Todo lists outside superpowers plans.** Claude Code does not write one here (see Background). A possible later
  feature: a tool in ClaudeTerm's MCP server, next to `show_image` and `show_diff`, through which Claude reports its
  own steps for any task.
- The steps inside a task (`- [ ]` lines) — the checkboxes are never ticked, so they cannot show progress.
- Notifications of any kind when a task or the plan finishes.
- Clicking a task to open the plan file or the task's brief.
- A setting to turn the segment off.
- `claude` started by hand in a shell tab (it has no transcript feed in ClaudeTerm today).

## Testing

Per AGENTS.md, each behaviour through the entry point that uses it, written first and seen failing:

- **Unit** (`tests/unit/`): parsing a plan (title, task headings at levels 2–4, CRLF, non-English titles, no tasks),
  parsing a ledger (only `Task <N>: complete` counts; fix rounds, parked, rulings and pre-flight lines do not;
  tasks before the furthest complete one count as done; a `Final` line finishes the plan),
  `plan-path` resolution (relative, absolute, MSYS on Windows), the per-tab state machine with fake
  dependencies (appears, updates, `✓` at the end, replaced by a second plan, cleared on session end and on a new
  session, kept across compaction), and the segment's text (`3/7 · …`, ellipsis, `✓ 7/7`).
- **Integration** (`tests/integration/`): a transcript on disk with a skill call (with and without `args`, in the
  main transcript and in a subagent transcript) plus a plan and a workspace in a temp folder outside the tab's folder
  → the source reports the right tasks; appending `Task <N>: complete` to the ledger → the report updates;
  a resumed session's transcript replayed from the start → the plan is found again.
- **End-to-end** (`tests/e2e/`): with the stand-in `claude` writing such a transcript and workspace, the segment
  appears in the Claude tab's status bar; a click opens the list with the right ✓/●/○ marks; Esc and an outside click
  close it; a ledger update changes the segment and the open list; a shell tab has no segment.

All of it with invented plans and paths in temp folders; nothing reads the real `~/.claude` or a real repository.

## Docs

The README's status bar section gets a short paragraph on the plan segment and its list. If the README's status
bar image is regenerated to show it (`npm run screenshots`), the plan in it is invented. The CHANGELOG entry is
written at release time.
