# Task list tool: design

Date: 2026-11-06. Status: draft, for the user's approval.

## Why

ClaudeTerm shows the progress of a superpowers plan in the status bar (`3/8 · Task title`, a fill bar) and lists its
tasks in a box above the status bar when the segment is clicked. It learns the plan by itself, from the ledger
workspace the transcript reports. Work that does not run as a superpowers plan has no such display. The user wants
the agent to be able to put up and keep a task list the same way, through the bundled `claudeterm` MCP server, when
it sees fit or when the user asks — "so the agent has the option, in case it needs it". A superpowers plan keeps
being tracked automatically; the tool is not a replacement for it.

## Goals

- Two new tools in the bundled `claudeterm` MCP server (`src/mcp`): one sets the tab's task list, one reads it back.
- The list shows in the same status-bar segment and the same task box as a superpowers plan, with the same marks
  (✓ done, ● in progress, ○ pending), counts and fill.
- The list lives with the conversation, as a tab's note does: it survives compaction, a restart of ClaudeTerm
  (Restore), reopening the conversation from Recent sessions, and moves with the tab on `/clear`.
- The tools are always available. No setting turns them on or off, and nothing tells the agent to use them beyond
  the tools' own descriptions.

## Non-goals

- Showing Claude Code's own todo list (its built-in task tools) from the transcript. A possible separate feature.
- A list per subagent. A subagent's calls go to the same MCP server and change the tab's one list.
- Editing the list by hand (adding, ticking, reordering tasks) in the UI.
- Any change to how a superpowers plan is detected or shown.

## Anti-goals

- The agent is not nudged to use the tool on every task: no instructions injected into the conversation, no
  SessionStart text, no CLAUDE.md edits.
- A list the agent forgot must not hang in the status bar forever with no way to get rid of it.
- The tool must not fail the agent's work: with ClaudeTerm not running or the tab unknown, it answers with a clear
  text and the agent carries on.

## Constraints (from AGENTS.md)

- Everything that arrives over the pipe is untrusted: main validates the message again (types, lengths, counts),
  whatever the MCP side already checked.
- The list is stored in ClaudeTerm's own data folder, never in Claude Code's folders. Tests use their own data folder
  and pipe; no test touches the real `~/.claude` or `%APPDATA%\ClaudeTerm`.
- Tests at every level the change crosses: unit (the hub, the store's parsing, the MCP handler with a fake pipe),
  integration (the MCP handler over a real pipe, the store on disk), e2e (a pipe message puts the list in the status
  bar; the plan wins; the list survives Restore and moves on `/clear`; Clear removes it).
- Renderer text goes through `textContent`; the renderer gets nothing new from the system except over IPC.

## How it works (decided)

**The tools.**

- `set_task_list` — replaces the tab's whole list. Input: `title` (optional, short), `tasks`: an array of
  `{ title, status }`, `status` one of `pending`, `in_progress`, `completed`. An empty `tasks` removes the list.
  The answer repeats the count (`Task list updated: 3 of 8 done.`).
- `get_task_list` — no input; answers with the tab's list as text (title, then one line per task with its status),
  or "No task list." The agent uses it after compaction, or when it is not sure what the list holds.
- Descriptions, roughly: set — "Show a task list with progress in ClaudeTerm's status bar, for multi-step work, or
  when the user asks for one. Send the whole list each time. A superpowers plan is tracked by ClaudeTerm itself; do
  not mirror it here." Get — "Read the task list shown in ClaudeTerm for this conversation."
- Like the other tools: they work only in a ClaudeTerm Claude tab (`CLAUDETERM_TAB_ID`); outside one they answer an
  error text. With ClaudeTerm not running they answer that the list could not be shown, not an error.

**Permission (the user's decision).** ClaudeTerm allows both tools in advance in its own tabs: it adds
`mcp__claudeterm__set_task_list` and `mcp__claudeterm__get_task_list` to `permissions.allow` in the settings it passes
to Claude with `--settings` (`claude-tab-settings.ts`). This holds only in ClaudeTerm tabs; the user's own Claude
settings are not touched. Without it, unattended work (auto-continue, background work) would stop at the first call's
permission prompt. The other `claudeterm` tools stay as they are.

**The pipe.** A new message type (`task_list`, `v: 1`) carries the tab id and the list or null; a second one, or the
same with a flag, asks for the list back. Main answers the read in the pipe response's `info` text.

**Limits.** At most 100 tasks, a task title at most 200 characters, the list title at most 100. Longer titles are cut;
more tasks are refused with an error text. Titles are trimmed; an empty task title is refused.

**The status bar.** The task list uses `PlanStatus` as it is: tasks numbered from 1, `done` (`completed`) and `current`
(`in_progress`) and `left` (`pending`), counts, `finished` when every task is done. The list's title is the given one,
or `Tasks` when none was given. When the tab has both a superpowers plan and a list, one shows, in this order: a plan
in progress, then a list in progress; when both are finished, the one whose status changed last shows (main keeps,
per tab, which side changed last). A finished plan (which PlanHub keeps until the conversation changes) therefore gives
way to a list the agent sets after it, a finished list set after a finished plan shows over it, and a list hidden
while a plan ran shows again once the plan is finished. More than one task in progress is allowed; the segment names
the first.

**Clear.** The task box of an agent's list (not of a superpowers plan) has a Clear button. It removes the list, as
`set_task_list` with no tasks would.

**Where it lives.** A store like `SessionNotes`: `task-lists.json` in ClaudeTerm's data folder, keyed by Claude
session id, written with a debounce through a temp file and a rename, read with full validation (a bad entry is
dropped, a bad file is moved aside and never written over). A hub like `NoteHub` follows each tab's conversation:

- a tab that starts with a conversation id gets the list stored under it;
- on a session change (`/clear`, `/resume`, a first id): if the new conversation has a stored list, it shows; if not,
  the tab's list moves to the new conversation, except a finished one, which stays with the old;
- a fork starts with a copy of its head's list, the head keeps its own: the fork's conversation is a copy of the
  head's, `set_task_list` calls included, so its agent believes it has that list. This holds for a live Fork session
  and for a fork restored without a conversation of its own (its head is `fork.from`, not the fork's unsaved id that
  `NoteHub.adopt` is called with);
- closing the tab keeps the list stored under its last conversation;
- the store keeps the 200 most recently changed lists and drops older ones when it writes, so a file the agent
  writes often stays small; each entry records when it changed.

## Calls made without the user (check these)

- Two tools (set the whole list, read it) rather than add / update / remove calls: sending the whole list each time
  cannot leave ClaudeTerm and the agent out of step.
- The status names `pending` / `in_progress` / `completed`, as Claude Code's own todo list uses, so the agent needs no new
  vocabulary.
- A finished list stays shown (✓ 8/8) until the agent replaces or clears it, or the user clears it, and does not move
  to the new conversation on `/clear`.
- The Clear button in the task box, only for an agent's list.
- The limits: 100 tasks, 200 / 100 characters.
- The order when a plan and a list are both there (plan in progress, list in progress; then, both finished, the one that
  finished last), rather than "the plan always wins": a finished plan would otherwise hide every later list in the
  conversation.
- A fork gets a copy of its head's list.
- The store keeps the 200 most recently changed lists.

## Left to the builder

- Whether main combines the plan and the list into one `PlanUpdate` (with a field saying which it is, for the Clear
  button) or the renderer gets them separately and picks.
- The names of the hub, the store and the pipe message types, and whether reading the list is its own message type.
- The README wording: one paragraph next to the superpowers plan's, and the tools in the MCP tools list.
