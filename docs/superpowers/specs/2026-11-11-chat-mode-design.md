# Redesign, part 2: the chat mode — design

Date: 2026-11-11
Status: draft, for the user's review

## Why

Part 1 (`2026-11-10-redesign-look-design.md`, shipped to master as b28b5d5) gave ClaudeTerm its new look. In part 1,
a Claude tab still shows Claude Code's own terminal. The user wants more: a Claude tab should show the conversation as
ClaudeTerm's own chat ("a custom terminal instead of the default one, the default kept as an option"), and every Claude
Code feature must work there:

- "Весь функционал клода типа вопросов с выборами ответа и тд должен работать". Questions with answer choices,
  permissions and the like.
- "команды на слеш / тоже должны работать". Slash commands.
- "надо чтобы сохранилась возможность аттачить файлы". Attaching files and images.
- "приложение должно летать". Nothing may lag.

The user saw and approved the mockup: the canvas "ClaudeTerm redesign", https://claude.ai/artifact/XV8YQrc8PYax6fYCxfDkj1,
private to the user. Its boards for part 2 are these:

- **Main**: Claude asks a question.
- **Working**: Claude at work, with live motion.
- **Approve**: a permission request beside the Changes panel.
- **Slash**: the slash command menu and a native `/model` picker.
- **Tabs**: tabs on top, with files attached in the composer.

A copy of the boards' HTML sits in the plan's workspace for the builders. Each board has inline styles and comments
that name its parts. They are the visual reference for this document. Where a board and this text disagree, the text
wins, and the disagreement goes in the plan's ledger.

Part 3 comes later: attachments from other devices of the user's device group. The Tabs board's "From your devices"
section and the "from macbook" chips are part 3. Part 2 does not show them.

## Background: what exists today

- **The Claude tab.** It is a shell (pwsh, cmd, bash, zsh or fish) running
  `claude --settings <dataDir>/claude-tab-settings.json [--resume <id>] [--fork-session]` in a node-pty PTY.
  - The command line is built in `src/main/profiles.ts` (`buildClaudeCommandLine`, `buildLaunch`).
  - `resolveLaunch` (`src/main/index.ts`) adds the account's environment (`src/main/accounts.ts`).
  - The tab's environment also carries `CLAUDETERM_TAB_ID` and `CLAUDETERM_PIPE`.
  - The "Claude command" setting (`claude.command`, default `claude`) is run by the shell, so it may be a path, a
    shim or a command with arguments.
- **What ClaudeTerm learns about Claude.** Everything comes one way, from Claude Code to ClaudeTerm:
  - Hooks in the `--settings` file: SessionStart, SubagentStart/Stop, SessionEnd, PermissionRequest,
    UserPromptSubmit, Stop and StopFailure, PreToolUse for `AskUserQuestion` and for edit tools, and the mail
    watcher with `asyncRewake`.
  - The `statusLine` command: model, effort, context, and the 5-hour and weekly limits.
  - Tailing the transcript JSONL for images, edits, prompts, model and effort.
  
  The hook reports to ClaudeTerm over the pipe and never answers Claude Code. Nothing in `src` speaks stream-json
  today.
- **Input.** Every input reaches Claude as keystrokes into the PTY:
  - typing;
  - paste, including an image through Claude Code's own paste key;
  - dropped files, typed as quoted paths;
  - the Changes panel's Send;
  - auto-continue;
  - remote devices' keys.
  
  Main asks the renderer's terminal screen for the prompt state (`PromptQueries`) before it types.
- **Sessions.**
  - The SessionStart hook gives the tab its session id, whatever its source: startup, resume, clear, compact or
    fork.
  - Tabs are saved in `session-state.json` and restored with `--resume`.
  - Recent sessions (`src/main/session-history.ts`) lists the transcripts. It hides sessions whose `entrypoint` is
    not interactive, which includes SDK sessions.
- **Other devices.** A member device views and drives a tab over the device link (`src/main/sync/*`,
  `remote-wire.ts`):
  - terminal bytes (`out` / `in`) and an attach snapshot of the screen;
  - the tab directory;
  - per-tab hub data (`push`: status, plan, review, images);
  - RPC calls.
- **The renderer.**
  - One `TerminalView` (`div.terminal-host` in `#terminals`) per tab, shown and hidden by `activate()`.
  - `#sheet-header` (`src/renderer/sheet-header.ts`) has an empty `.sh-modes` slot that part 1 left for the
    Chat / Terminal switch.
  - The Docs panel already renders Markdown with `markdown-it`.

### The Claude Code interface the chat builds on

Facts below are from Claude Code 2.1.322 (`claude --help`) and the Agent SDK for TypeScript,
`@anthropic-ai/claude-agent-sdk` 0.3.322: its `sdk.d.ts` and its docs at https://code.claude.com/docs/en/agent-sdk/.

- **The process.**
  - `claude --output-format stream-json --verbose --input-format stream-json` is one long-lived process per
    conversation.
  - User messages go in as JSON lines on stdin. Messages typed during a turn queue up.
  - Assistant messages, tool calls and results, partial text (`--include-partial-messages`) and the turn's result
    come out as JSON lines.
  - Hooks run in this mode, `--bare` aside. The transcript is written to the same
    `~/.claude/projects/<project>/<session>.jsonl` as the terminal's.
  - The terminal can continue the session by id (`claude --resume <id>`), and the reverse works too.
  - Two processes must never hold one session at once: their messages interleave in the transcript.
- **The control protocol.** It runs over the same stdio, as `control_request` / `control_response`, and is
  documented only through the SDK packages.
  - From the host: `initialize`, `interrupt`, `set_permission_mode`, `set_model`, `mcp_status`,
    `get_context_usage` and more.
  - From the CLI: `can_use_tool` (with `--permission-prompt-tool=stdio`) and `request_user_dialog`.
  - **Permissions** come to the host as `can_use_tool` with the tool, its input and `permission_suggestions`.
  - **`AskUserQuestion`** comes to the host as `can_use_tool` too. The host answers `allow` with
    `updatedInput: { questions, answers: { "<question>": "<label>" | ["…"] } }`. A free-text answer is that text.
  - **`ExitPlanMode`** needs a permission host the same way.
- **Slash commands.**
  - The `system/init` message lists `slash_commands`, plus `terminal_slash_commands`: the subset bound to the
    terminal.
  - `initialize` / `supportedCommands()` gives names, descriptions and argument hints.
  - A command is sent as the text `/name args`. Built-ins that work this way include `/compact`, `/clear`,
    `/context`, `/usage`, `/model <name>`, `/effort <level>`, `/config key=value`, `/rename`, `/output-style`,
    `/mcp` (as a text summary) and `/code-review`. Custom commands, skills and plugin commands work too.
  - Local command output comes back as `system/local_command_output`.
  - A terminal-only command answers "… isn't available in this environment."
- **Other messages.** These include `rate_limit_event` (the subscription limits), `compact_boundary`,
  `api_retry`, task and background-task messages, `permission_denied` and `auth_status`.
  `getSessionMessages(sessionId, {limit, offset})` reads a session's history in SDK form, and
  `getSubagentMessages` reads a subagent's.
- **The binary.** The SDK can run a separately installed `claude`, through `pathToClaudeCodeExecutable` or its own
  spawn function `spawnClaudeCodeProcess`. By default it uses a native Claude Code binary from its optional
  platform packages.
- **Terms.** From https://code.claude.com/docs/en/legal-and-compliance:
  - The SDK is not open source. Its license reads "© Anthropic PBC. All rights reserved. Use is subject to the
    Legal Agreements".
  - "The Claude Code binary must not be modified." Preinstalling Claude Code in a product requires the Commercial
    Terms.
  - The terms do not prevent "an end user from signing in to the unmodified Claude Code binary with their own
    Claude subscription".
  - Third parties may not "offer Claude.ai login" or "collect, store, or intermediate Claude.ai credentials".

## Goals

1. A Claude tab can show its conversation as a chat, as drawn on the Main, Working and Approve boards. The chat
   shows:
   - the user's messages;
   - Claude's text, streamed as it is written;
   - Claude's thinking, folded;
   - tool calls, grouped per step;
   - subagents;
   - images Claude read, made or showed;
   - command output;
   - errors and retries;
   - compactions.
2. A composer, as drawn, sends messages:
   - Enter sends a message. Shift+Enter starts a new line.
   - While Claude works, a sent message queues.
   - ↑ in an empty composer recalls the last message.
   - Esc interrupts Claude.
   - Attachments: paste an image, drop files anywhere in the window, or pick files.
   - `@` mentions a file of the project.
   - The composer shows the permission mode and the model with its effort, and both can be changed from there.
3. Claude's questions (`AskUserQuestion`), permission requests and plan approvals (`ExitPlanMode`) are cards in
   the chat, answered with the mouse or the keyboard, as on the Main and Approve boards.
4. `/` opens a command menu, as on the Slash board. It lists:
   - Claude Code's commands, as the session reports them;
   - the project's commands;
   - the plugins' and skills' commands.
   
   Each entry has a description and its argument hint, and the menu filters as you type. Some commands are answered
   natively:
   - `/model` with a model and effort picker;
   - `/resume` with ClaudeTerm's Recent sessions;
   - the permission mode.
5. **Nothing stops working.** What the chat cannot show opens in the terminal of the same conversation:
   - a command bound to the terminal, such as `/config`, `/permissions`, `/agents`, `/login` or `/doctor`;
   - a `!` shell command;
   - a dialog kind the chat does not draw.
   
   The tab switches to Terminal, the command runs there, and the chat says so in a line.
6. Each Claude tab has a Chat / Terminal switch in its sheet header. Switching keeps the conversation, because the
   other view resumes the same session. A setting picks the view new Claude tabs open in. The default is Chat.
7. Everything built around Claude tabs keeps working in chat mode:
   - the Changes, Media, Docs and Agent messages panels and the note;
   - the status bar and the title bar's limits;
   - attention badges and sounds, and the working motion;
   - Review Send, auto-continue and agent mail;
   - accounts, forks, session restore and Recent sessions;
   - other devices' view of the tab.
8. The app flies. Chat tabs cost less than terminal tabs, and a long conversation opens and scrolls without a
   hitch (see Performance).

## Non-goals

- Part 3: files and screenshots from other devices in the attach menu, and the "from <device>" chips.
- Syntax highlighting in code blocks. Code is monospace on a dark well, with a Copy button.
- Native screens for rewind and checkpoints, message editing and branching, voice, and background sessions
  (`claude --bg`, `claude agents`). `/rewind` and the like open in the terminal (Goal 5).
- A chat for shell tabs, or for `setup-token` tabs, which stay terminal-only.
- Changing what Claude Code does. ClaudeTerm keeps not patching it.

## Anti-goals: it fails even if it looks right when

- A Claude Code feature silently does nothing in the chat, instead of working or opening in the terminal.
- A key the user typed into the composer answers a card. A permission is never granted by a stray Enter.
- Switching views loses a message, a turn, or the session. Two processes ever hold one session at once.
- The app starts slower, a busy chat tab makes typing in another tab lag, or a long conversation stutters.
- ClaudeTerm ships, modifies, or picks a Claude Code binary other than the user's own Claude command. It reads,
  stores or passes on credentials beyond what the accounts feature does today.
- Content from Claude (Markdown, links, file names, tool output) can run code or reach the system from the
  renderer.

## Constraints

- Everything in AGENTS.md:
  - the stream from Claude Code is untrusted;
  - main never blocks;
  - the renderer reaches the system only through the preload bridge, and images only through `ctimg://`;
  - main checks every IPC argument;
  - paths are compared with `pathKey`;
  - tests never start the real `claude`.
- The part 1 visual language, tokens, motion rules and performance rules apply. This includes the
  `prefers-reduced-motion` block, Inter for UI text and the monospace font for code.
- The chat runs the user's own Claude command (the `claude.command` setting), with the tab's account environment,
  the tab's `--settings` file and the tab's folder. These are the same things the terminal starts with today. The
  SDK's own platform binaries are never installed into the app or shipped.
- Chat mode needs a Claude Code version that the bundled SDK supports. The plan finds the floor from what the SDK
  passes. An older Claude, or one whose version the probe (`src/main/claude-version.ts`) cannot read, opens the tab
  in the terminal, with one line saying why and which version the chat needs.
- Every UI string is English.

## How it works

### The engine: the Agent SDK *(the user's decision, 2026-11-11)*

**The Agent SDK for TypeScript** (`@anthropic-ai/claude-agent-sdk`), pinned to one version and loaded in main only
when the first chat tab starts, so launch time does not change. `THIRD-PARTY-NOTICES.md` names it and the terms it
is used under.

- **How it starts Claude.** The SDK starts the user's Claude command through `spawnClaudeCodeProcess`, never its
  bundled binary.
- **The options it starts with:**
  - `settingSources` left at all sources, so the user's settings, CLAUDE.md files, hooks and permissions load as in
    the terminal;
  - the Claude Code system prompt preset, never the SDK's minimal prompt;
  - `includePartialMessages`;
  - `canUseTool` and `onUserDialog`;
  - the tab's `--settings` file;
  - `resume` with the session id for an existing session, and an explicit new session id for a new one.
- **How Claude Code is launched, per platform.** Without a PTY, but otherwise as the terminal's shell would find
  it:
  - Windows: the resolved executable is spawned directly, or through `cmd.exe` for a `.cmd` shim.
  - macOS and Linux: the user's login shell `exec`s it.
  
  A Claude command the chat cannot start this way, for example a PowerShell function, opens the tab in the terminal
  with a line saying so.

The user turned down the alternative, ClaudeTerm's own client of the stream-json and control protocol: the same wire,
written by hand, with no closed-source dependency, but more code, and every change to an undocumented protocol
ClaudeTerm's to track. The protocol had about forty message kinds in 0.3.322 and grows every few releases.

### One conversation, two views

- A Claude tab has a `view`: `chat` or `terminal`. It is saved with the tab and restored with it.
- In chat view, the tab runs the SDK process and has no PTY and no xterm. In terminal view, it runs the PTY exactly
  as today and has no SDK process.
- New Claude tabs open in the view the setting names: "Claude tabs open in": **Chat** (default) or **Terminal**.
- Tabs restored from before this version have no view. They open in Chat, following the user's "по дефолту всё
  новое". *(Claude's call.)*
- **Switching.**
  - The switch is in `#sheet-header`'s `.sh-modes` slot. It is the two-button "Chat | Terminal" group of the boards,
    with icons.
  - Switching is offered while no turn runs. While a turn runs, the switch is disabled, and its tooltip says
    "Claude is working — switch when it finishes, or press Esc to stop it". *(Claude's call: no dialog, no lost
    turn.)*
  - Switching ends the Claude process, and with it Claude's background work: background shells, monitors,
    background agents. When some is running, the switch asks in place, under the switch: "2 background tasks will
    stop. Switch anyway?", with **Switch** and **Cancel**. *(Claude's call, from the builder check.)*
  - To switch, ClaudeTerm ends the current process cleanly: the SDK by closing its input, the terminal by ending
    Claude in the PTY. If it has not exited after a few seconds, ClaudeTerm kills it.
  - Only after the exit does ClaudeTerm start the other view on the same session id.
  - The tab keeps its place, title, group, panels, note and badges.
- **Opening in the terminal (Goal 5).** This is the same switch, plus one step: once the terminal is at Claude's
  prompt, ClaudeTerm runs the command there. The chat gets one line, "Opened /config in the terminal", and Chat
  stays one click away. The switch's rules hold: while a turn runs, the command is not run, its text stays in the
  composer, and a notice says it opens in the terminal once Claude finishes. With background work running, the same
  question as the switch's comes first.
- **A folder Claude Code has not been told to trust** opens its Claude tab in the terminal, whatever the setting
  says, so that Claude Code's own trust dialog shows. Without a terminal, Claude Code skips that dialog, and a fresh
  clone's hooks and MCP servers must not run unasked.
  - Once the folder is trusted, Chat is one click away, and later tabs in it open in chat.
  - The plan finds how to tell a trusted folder: through the SDK if it says, otherwise from Claude Code's own record,
    read only. When it cannot tell, the tab opens in the terminal.
  - *(Claude's call, from the builder check: the terminal's safety, kept.)*
- **A session id that changes** with `/clear`, a compaction that starts a new session, or a fork arrives as today,
  through the SessionStart hook. The chat follows it and draws a divider, "New conversation" or "Conversation
  compacted".

### The chat's data

- **Main owns one chat model per tab.** It holds:
  - the list of items (message, thinking, tool step, subagent, image, command output, notice, card);
  - the turn state: idle, working, waiting for the user;
  - the cards waiting for an answer.
- It builds the model from the SDK's messages and keeps it while the tab lives, so a hidden tab costs no renderer
  work.
- The renderer gets the model when a tab becomes visible, then patches to it. The patches are batched to at most one
  per animation frame per tab, and only for the visible tab.
- **History.** When a chat tab opens an existing session, its history comes from `getSessionMessages`. The newest
  items load first, and older items load in pages as the user scrolls up.
- **Hooks and pipes.** Hooks still fire, so the pipe-driven features need no new source: SessionStart, attention,
  subagents, edits for the Changes panel, images for the Media panel, the task list, plans, notes and mail.
- **Recent sessions** must list sessions ClaudeTerm started in chat view, while it keeps hiding sessions that other
  programs start through the SDK. ClaudeTerm records its own chat session ids for this.
- **The status bar and the title bar.**
  - The statusLine may not run without the terminal, so in chat view the status comes from the stream: the model
    and the permission mode from `init` and the control replies, the context from `get_context_usage` (which measures
    against the auto-compact window, as the terminal view's status bar now does), the limits
    from `rate_limit_event` or `get_usage`.
  - The status bar in chat view drops the model pill, which the composer shows (as on the boards). Context,
    subagents, background tasks, plan and changes stay.
  - The plan must check whether the statusLine still runs in this mode. If it does, it can stay the source.

## What the user sees

All values are on the boards, and the plan copies them.

### The conversation

- **The column.**
  - The conversation is one column, at most 860 px wide, centered, with 36 px side padding. A 48 px fade sits at its
    top edge.
  - It sticks to the bottom while Claude writes, unless the user has scrolled up. A "↓ New messages" pill brings it
    back.
- **The user's messages** are right-aligned bubbles. Each has at most 72% of the width, `#1C1C22`, and radius
  14 14 4 14. Attached images show as small thumbnails in the bubble, and files as chips.
- **Claude's text** is Markdown:
  - paragraphs, lists, tables, quotes, inline code;
  - code blocks with a Copy button;
  - links that open in the system browser.
  
  Raw HTML is shown as text, never rendered. While text streams, the open paragraph grows in place, without
  flicker.
- **Thinking** is one folded row, "Thought for 6s", that unfolds to the summary when Claude Code sends one.
- **Tool calls** are grouped by the step that made them, as a card. The header is "Ran 3 tools · 6.1s" and folds
  the card. One row per call has:
  - a status icon: a spinner, a green ✓ or a red ✕;
  - the tool's name;
  - its subject, in monospace: the path, the command, the URL or the pattern;
  - a quiet detail on the right: lines read, duration, `+12 −3`, or the agents count.
  
  Some rows do more:
  - A Bash row shows the first lines of its output in a well, and unfolds to the whole output.
  - An edit row opens the Changes panel at that file.
  - A failed call shows its error.
  - A `Task` / agent row expands to its subagents, each with its description, type, state and time, as on the
    Working board.
- **Images** Claude read, created or showed (`show_image`) appear as 168 px cards under the step that produced
  them. A card opens the lightbox. The Media panel keeps working as today.
- **Command output** (`/usage`, `/context`, `/mcp` …) is a quiet block, headed by the command.
- **Notices** are one line each: a retry ("Retrying in 4s · attempt 2 of 10"), a limit reached with its reset time,
  an error with what to do, "Interrupted", "Opened /config in the terminal" and "Claude Code stopped" with
  **Restart**.
- **Working.**
  - The last line shows "✻ Working · 12s · Esc to interrupt", with the part 1 working motion.
  - The tab's working state, the header's spinning glyph, the waiting words (Question, Permission, Done) and the
    attention badges behave as they do for a terminal tab.
- **Find** (`Ctrl+Shift+F` / `⌘F`, the existing box) searches the conversation's text, highlights the matches and
  scrolls to them.
- Text in the conversation can be selected and copied.

### The cards

A card appears at the end of the conversation, with the part 1 pop-in, and takes the keyboard when it appears. If the
user is typing in the composer (it has focus and text), the card waits instead. A pulse in the composer says
"Claude is waiting for your answer", and Tab or a click moves to the card. Keys pressed in the composer never reach a
card.

- **A question** (`AskUserQuestion`) is drawn as on the Main board:
  - a header "Claude has a question", with one tab per question when there are several;
  - the question;
  - its options as a two-column grid, each with its description and number. Multi-select questions get checkboxes
    instead of radio buttons;
  - "Or type your own answer…";
  - the hint "1–4 to pick · Enter to confirm · Esc to dismiss", **Skip** and **Next**, with **Submit** on the last
    question.
  
  The answers go back as `answers`. Esc on the card dismisses it, and Claude is told the user declined.
- **A permission request** is drawn as on the Approve board. Its title says what Claude wants:
  - to edit a file, with a diff preview in the Changes panel's look;
  - to run a command, shown in monospace with its description;
  - to fetch a URL;
  - to use an MCP tool.
  
  The buttons are **Allow once**, one "for this session" or "always" button per suggestion Claude Code sends (worded
  from the suggestion, e.g. "Allow edits for this session"), **Deny** (Esc), and "Tell Claude what to do instead…",
  which denies with that message. Enter takes the focused button. The focus starts on **Allow once**, as in the
  terminal, except when Claude Code marks the request to default to no (`defaultToNo`): then it starts on **Deny**.
- **A plan approval** (`ExitPlanMode`) shows the plan as Markdown, in a card that scrolls when long. Its buttons
  match the terminal's choices: approve and accept edits, approve and ask before edits, keep planning. A box says
  what to change instead.
- **A dialog** (`request_user_dialog`):
  - The chat draws the dialog kinds the plan finds simple enough (a title, text, and a few choices), and declares
    only those to the CLI.
  - Any other kind is answered "cancelled", so Claude Code applies its default. The notice line offers to open the
    conversation in the terminal.
  - MCP elicitations are treated the same way.
- An answered card collapses to one line in the conversation, for example "You answered: PDF report" or "Allowed:
  edit src/charts/revenue.ts".

### The composer

- The composer is drawn as on the boards: a 12 px-radius field, the text area, then a row with:
  - Attach;
  - `@`;
  - `/`;
  - the permission-mode chip, with a colored dot;
  - the model chip, "Opus 5.5 · high";
  - Send.
  
  The field grows with its text up to a third of the sheet, then scrolls. A draft is kept per tab.
- **Keys.**
  - Enter sends. Shift+Enter starts a new line.
  - While Claude works, Enter queues the message. It shows as a bubble marked "Queued" until Claude takes it, and
    the placeholder says "Queue a follow-up…".
  - ↑ in an empty composer recalls earlier messages of this session.
  - Esc interrupts a running turn. Esc again, with nothing running, clears the composer.
  - As in the terminal, Esc stops the turn but not Claude's background tasks. The chat declares a stop control per
    task (the SDK's `perTaskStopAffordance`). Each background task in the status bar's list gets a ✕ that stops that
    task alone. *(Claude's call, from the builder check.)*
- **Attachments.**
  - The attach menu offers "Files on this computer…" and "Paste an image · Ctrl V" (the Tabs board without its
    part 3 section). Dropping files anywhere on the tab works too.
  - Images (PNG, JPEG, GIF, WebP) go to Claude as image content. Images over the API's limits are scaled down
    first.
  - Other files go as `@path` mentions, so Claude reads them itself.
  - Attachments show as chips above the text, each with a thumbnail or an icon, its name and its size. Each chip has
    ✕.
  - On a remote tab, dropped files go to the tab's device first, as they do today.
- **`@`** opens a file picker over the tab's folder that filters as you type and inserts `@path`. It takes Claude
  Code's own suggestions (`file_suggestions`) when the CLI offers them, otherwise git's file list.
- **The permission-mode chip** cycles or picks between Ask before edits, Accept edits, Plan, and Auto when the
  account offers it, through `set_permission_mode`. Shift+Tab in the composer cycles, as in the terminal.
- **The model chip** opens the `/model` picker. So does the `/model` command.

### The slash menu

- **Opening and keys.** Typing `/` at the start of the composer, or the `/` button, opens the menu above the
  composer, as on the Slash board:
  - The menu has a count line, "6 commands match "co"", and the hint "↑↓ move · Tab complete · Enter run".
  - Typed letters are highlighted.
  - Tab completes the name. Enter runs it, or completes it and waits when the command takes arguments.
- **Groups.**
  - **Claude Code**: the built-ins the session reports.
  - **This project**: `.claude/commands` and the project's skills.
  - **Plugins and skills**: each with its source.
  
  Each entry has its description and argument hint.
- **Commands answered natively:**
  - `/model`: the picker of the Slash board. It lists the session's models with their descriptions and an effort
    row (low … max, as the model allows), and applies through `set_model` and the effort setting.
  - `/resume`: Recent sessions, opening the chosen session in this tab.
  - `/clear`: sent as is. A divider follows.
- **Commands bound to the terminal** (`terminal_slash_commands`, plus any command answered "isn't available in this
  environment") are listed with a quiet "Opens in the terminal" tag, and they open there (Goal 5). The same goes for a
  message that starts with `!`.
- **Everything else** is sent as text, and its output appears as command output.

## Other devices

A member device shows a remote chat-view tab as a chat too. The host's main streams the tab's chat model to members
the way it streams terminal bytes today, over the device link:

- a snapshot of the model on attach;
- then its patches, in order.

The member's input goes back as calls:

- messages, with attachments copied to the host as files are today;
- answers to cards;
- interrupt;
- mode and model changes;
- the switch.

The host's process is the only one, and the member never starts Claude for a remote tab. If two devices answer the
same card, the first answer wins, and the other device's card closes. A member older than this version sees a
chat-view tab as an empty terminal. The release notes say every device needs the new version, as 0.17.0's did.
*(Claude's call: chat becomes the default, so without this every remote Claude tab would break.)*

## Performance

The part 1 rules hold: nothing in this part may make the app slower. Measured with `npm run perf`, extended for the
chat, on the same machine as part 1's numbers:

- **Launch to window and launch to prompt**: no worse than part 1 (599 ms and 762 ms medians). The SDK is not
  loaded until a chat tab starts, and a restored chat tab draws its history before its process is up.
- **A chat tab with a long conversation** (a fixture of 5,000 items) shows its last screen within 150 ms of
  becoming active. Scrolling through it has no task over 50 ms.
- **Streaming.**
  - Text arriving at 200 tokens/s costs at most 4 ms of renderer time per frame.
  - Typing into the composer of another tab stays within one frame while a chat streams.
  - A hidden chat tab does no DOM work.
- **Memory.** A chat tab holds less than a terminal tab, because it has no xterm and no scrollback buffer.
- **How the plan meets this** is its business. The expected means:
  - patches batched per frame;
  - only the newest items in the DOM, plus `content-visibility: auto`;
  - Markdown re-rendered only for the open block;
  - no layout reads in loops.

## Testing

- **A stand-in for Claude Code.** No test starts the real `claude`. The e2e and integration tests get a stand-in
  that speaks the stream-json and control protocol over stdio. It is scriptable per test:
  - streamed text;
  - tool calls and results;
  - a question, a permission, a plan approval, a dialog;
  - slash command output, terminal-only replies, retries and errors;
  - a crash;
  - session ids, and a transcript written where Claude Code would write it, under the test's `CLAUDE_CONFIG_DIR`.
  
  It joins the existing stand-in in `tests/e2e/helpers.ts`, so the terminal view keeps working in tests that switch
  views.
- **Protocol fixtures.** These are recorded once by hand from the real CLI. A few short Haiku turns on the user's
  account show the exact shapes: init, a streamed answer, a tool call, a permission, a question, a slash command, a
  compaction. The content is replaced with invented text before the fixtures are committed. Tests replay them;
  nothing records them during a test run. *(The user agreed, 2026-11-11.)* The recording runs in a throwaway folder,
  so its session lands in a project of its own under the user's `~/.claude/projects`; that project folder is deleted
  when the recording is done.
- **Unit:**
  - the chat model built from messages;
  - card answers into `updatedInput` and denials;
  - slash routing (native, text, terminal);
  - attachment encoding;
  - the Markdown renderer's escaping of HTML and links;
  - the history pager.
- **Integration:**
  - the SDK with the stand-in over real pipes;
  - spawning the user's command on each platform (an `.exe`, a `.cmd` shim, a login shell);
  - a view switch that never runs two processes on one session;
  - Recent sessions listing chat sessions.
- **End-to-end**, through the window:
  - send and stream;
  - fold a tool step;
  - answer a question with the keyboard;
  - allow and deny a permission;
  - approve a plan;
  - a stray Enter in the composer never answering a card;
  - the slash menu, `/model`, and a terminal-only command opening the terminal;
  - switching both ways keeping the conversation;
  - restore into chat;
  - paste and drop;
  - Find;
  - a remote chat tab driven from a member;
  - reduced motion.
- **The perf harness** gains the chat metrics above.
- **README.** The README's images and text describe the chat, and `npm run screenshots` gains chat shots built from
  invented sessions.

## Left to the builder

- The module layout. This includes how the tab's view abstraction splits terminal and chat, so that Send,
  auto-continue, mail and drop go through one "give this to Claude" path.
- The exact Claude Code version floor, and how the stand-in versions itself.
- Which dialog kinds to draw, as long as every other kind falls back as described.
- How queued messages are shown, and whether they can be withdrawn, as far as the protocol allows.
- The paging sizes and the DOM window size, within the performance budgets.

## The user's decisions

- **The engine** is Anthropic's Agent SDK package, closed source under Anthropic's terms, inside the MIT app, not
  ClaudeTerm's own client of the protocol (2026-11-11).
- **The protocol fixtures** are recorded once with a few short Haiku turns on the user's account, before the stand-in
  is built (2026-11-11).

## Claude's calls, for the user to check

- Chat is the default view for new tabs and for tabs restored from before this version.
- The switch is disabled while Claude works, rather than asking to stop the turn. With background work running, it
  asks first, because switching stops that work.
- A folder Claude Code does not trust yet opens in the terminal first, for Claude Code's trust dialog.
- Esc stops the turn but not the background tasks, as in the terminal. Each task gets its own ✕ in the status bar.
- Permission cards start with the focus on Allow once, as the terminal does, or on Deny when Claude Code asks for
  that. A card never takes keys typed into the composer.
- Terminal-only commands, `!` commands and unknown dialogs open in the terminal of the same conversation.
- In chat view the model is shown in the composer, not in the status bar.
- Other devices see chat tabs as chat in this part, not in part 3.
- No syntax highlighting in part 2.
