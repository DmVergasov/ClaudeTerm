# MCP servers and plugins, managed from the chat — design

Date: 2026-11-12
Status: draft, for the user's review

## Why

In a chat tab, `/mcp` prints one line ("16 MCP server(s): 13 connected, 3 not connected, 0 disabled. Use `/mcp` in the
terminal for details.") and sends the person to the terminal. The same goes for `/plugin`. The person wants to do in the
chat everything the terminal's `/mcp` and `/plugin` screens do: "connect a new MCP or plugin, or re-auth, or any other
action available there", and the session should then reload by itself "so that everything gets picked up".

What they said about where servers and plugins come from: MCP servers come "in different ways, by hand and by asking the
agent: add such-and-such MCP"; plugins "from the marketplace, from GitHub, and at the agent's request". About the look:
"make the design prettier, show it on a mockup first". They saw the board and approved it ("everything is there").

The board: `.superpowers/mcp-plugins/boards/mcp-plugins.html` (git-ignored scratch; copy it into the plan's workspace for
the builders). It has four frames: (1) the MCP servers panel, (2) Add a server, (3) Plugins, (4) Claude adds a server and
the chat restarts. It is the visual reference; where it and this text disagree, the text wins.

## Goals

- `/mcp` and `/plugin` typed in a chat open a panel beside the conversation (frame 1/3) instead of a terminal hint. The
  chat header gets a button for the same panel ("MCP · Plugins").
- **MCP servers**, as the running session sees them, live: status (connected, needs sign-in, failed, pending, pending
  approval, disabled), where each comes from (User, Project, Local, Plugin <name>, claude.ai, managed), its tools, its
  error text, its version. Grouped: Needs attention, Connected, Off. A filter field over servers and tools.
- **Every action the terminal offers, without the terminal**: sign in (and sign out), reconnect / retry, enable and
  disable, remove, approve or reject a project (`.mcp.json`) server waiting for approval, show the tools, copy the config,
  open the config file. Add a server (frame 2).
- **Add a server**: one field accepts whatever the person has — a `claude mcp add …` command (from a README), a server URL,
  or a JSON config (one server, or an `mcpServers` object with several). ClaudeTerm recognises it, shows what it will add
  (name, type, address or command, headers and env with secrets masked), lets the name be edited, and asks only where it
  works: **All my projects** (user scope), **This project, shared** (project scope, `.mcp.json`), **This project, only me**
  (local scope). "Add and restart".
- **Plugins**: Installed (on/off, update when a newer version is there, uninstall, details), Discover (the plugins of the
  added marketplaces, with Install), Marketplaces (add from a GitHub repo, a URL or a folder; update; remove). A pasted
  GitHub link is recognised: a marketplace is added and its plugins shown; a plugin that declares options asks for them in
  the panel before the restart.
- **The session reloads by itself**, however the change came: by hand in the panel, or by Claude (a `claude mcp add` run
  through Bash, an edit of `.mcp.json`, `claude plugin install`…). ClaudeTerm notices that the set of MCP servers or
  enabled plugins this tab's Claude Code would load has changed, shows a card ("New MCP server: context7 — the session
  restarts to load it", with Not now), and restarts the session — the same conversation, resumed — when the current answer
  has ended (at once when Claude is idle). Several changes close together make one restart. After it, the divider says what
  came up ("Session restarted · context7 connected · 2 tools"); a server that failed shows its error and a button to the
  panel. A sign-in does not need a restart: the server is reconnected in the running session.

## Non-goals

- The terminal view of a Claude tab keeps Claude Code's own `/mcp` and `/plugin`; the panel is for chat tabs.
- No editing of a server's config in a form after it is added (remove and add again; "open the config file" covers the rest).
- No ratings or download counts unless the marketplace data has them.
- Writing plugins, plugin evals, `claude mcp serve`, Claude Desktop import.

## Anti-goals (a failure even if it works)

- A running answer cut off by a restart. The restart always waits for the answer to end.
- A secret (API key, header token, env value) shown in clear, logged, put in a toast, sent to another device, or written
  anywhere other than where Claude Code itself keeps it.
- The panel or the main process freezing while a CLI command runs (`claude mcp list` health-checks every server and can
  take seconds).
- Restarting chats the person did not touch without saying so (see "Other tabs" below).

## Constraints and facts

- **The running session** (Agent SDK, `src/main/chat/sdk-engine.ts`): `mcpServerStatus()` (name, status
  `connected | failed | needs-auth | pending | disabled`, `serverInfo`, `error`, `config`, `scope`, `source`, `tools`),
  `reconnectMcpServer(name)`, `toggleMcpServer(name, enabled)`, `reloadPlugins()`. These act on the session only.
- **The configuration** goes through Claude Code's own CLI, run by ClaudeTerm with the tab's command
  (`settings.claude.command`), the tab's environment (its account: the same config dir and token the tab's Claude Code
  uses) and the tab's folder (for project and local scope). Verified on Claude Code 2.1.322:
  - `claude mcp add [--transport http|sse|stdio] [--scope user|project|local] [--header …] [-e K=V] <name> <url|-- cmd args>`,
    `claude mcp add-json <name> <json>`, `claude mcp remove <name> [--scope]`, `claude mcp get <name>`, `claude mcp list`,
    `claude mcp login <name>` (opens the browser; `--no-browser` prints the URL), `claude mcp logout <name>`,
    `claude mcp reset-project-choices`.
  - `claude plugin install|uninstall|enable|disable|update <plugin[@marketplace]>`, `claude plugin list --json [--available]`,
    `claude plugin details <name>`, `claude plugin configure <plugin> [--values-stdin]`,
    `claude plugin marketplace add <source> | remove <name> | update [name] | list`.
  - Run without a shell, with a time limit, never blocking the main process; `--json` where the command has it; output is
    untrusted and validated (AGENTS.md: everything from Claude Code's files and output is untrusted).
- **Where the configuration lives** (to notice changes): the user config file of the tab's config dir (user-scope
  `mcpServers` and the per-folder `projects[<folder>].mcpServers` of local scope), `<folder>/.mcp.json` (project scope),
  the settings files that enable plugins (user, project, project-local), and the installed-plugins record in the config
  dir. Paths are compared with `pathKey`.
- Side panels: the panel is one more kind beside Media and Changes (`src/renderer/side-panel.ts`), per tab, with its width
  saved, keyboard reachable, and the smooth open/close the side panels are getting now.
- Remote tabs (a chat run on another device of the device group): the panel's actions must run on the device that runs
  the tab. **Builder's call, mine:** v1 shows the panel for local tabs only; a remote tab's `/mcp` keeps today's line plus
  "Manage MCP on <device>".
- Tests never run the real `claude`: the stand-in (`tests/fixtures/fake-claude`) learns these subcommands and the SDK's
  MCP control requests, with recorded or scripted answers.

## Decisions taken in the conversation

- The panel beside the conversation, as on the board (not a separate window).
- `/mcp` and `/plugin` in the chat open it.
- One paste field for a new server; three scopes in plain words.
- The session restarts by itself after any add/install/remove/enable/disable, by hand or by Claude, after the answer.

## My calls (for the person to check)

- **Other tabs.** A change in user scope (all projects) also changes what other open chats would load. Only the tab where
  the change was made (or where Claude made it) restarts by itself; other open chats affected by it get the same card with
  a **Restart** button instead of an automatic restart.
- **Not now** on the card keeps the card (with Restart) until the next restart of that tab, which then loads the change.
- A removal or a disable also restarts (the session must drop the server); a sign-in only reconnects.
- A failed CLI command shows its message in the panel, next to the action, not as a toast.

## Answers for the builder

- **The tab's environment.** The CLI runs with the environment the tab's chat was started with (the `env` of the chat's start
  request in `ChatHub.start`, built by `resolveLaunch` in `src/main/index.ts` with `accountLaunch` from `src/main/accounts.ts`),
  in the tab's folder, with the same command the tab's Claude Code is started with. The user config file is
  `<CLAUDE_CONFIG_DIR or the home folder>/.claude.json` (helper: `chat-support.ts` ~95; the same rule in `claude-plan.ts`);
  plugins and settings are under `<CLAUDE_CONFIG_DIR or ~/.claude>`. Tabs on different config dirs are independent.
- **The restart** is the existing one: `tabs.restart(tabId, { live: true })` (`src/main/tab-manager.ts` ~292) resumes the same
  conversation; the "Restarting Claude Code" line and the "Session restarted" divider come from the compaction/restart
  indication being built now (`followup-activity-brief.md`). The coordinator waits until the chat's turn is idle: an answer
  running, a card waiting for the person (permission, question) or messages still queued all keep it waiting; nothing is cut.
- **What counts as a change (my call).** Compared with what the running session loaded: a snapshot of the relevant
  configuration taken when the session starts, compared again on a file change and at the end of each turn. A change is: an
  MCP server added, removed, or with a different config (command, args, env, URL, headers, transport) in a scope that applies
  to the tab's folder; a plugin installed, uninstalled, updated, enabled or disabled; a project server approved. A project
  server still waiting for approval is not a change (it would not load). Anything else in those files (other folders'
  entries, unrelated settings) is not.
- **Which tabs are affected.** User scope and plugins: every chat tab on the same config dir. Project and local scope: the
  chat tabs whose folder is that folder (`pathKey`), on the same config dir.
- **Secrets when adding (my call).** What the paste field holds goes to main once, in the add call; the renderer shows
  secrets masked and main never logs the command line or the values. The values reach Claude Code as the arguments of a
  short-lived child process with no shell — the same exposure as running the README's command in a terminal — because
  `claude mcp add` / `add-json` take them only so; ClaudeTerm never writes Claude Code's config files itself. An OAuth client
  secret goes through `MCP_CLIENT_SECRET` in the child's environment, not the arguments. Plugin options with secrets go
  through `claude plugin configure <plugin> --values-stdin` (stdin), never arguments.
- **A chat with no running session** (starting, exited, restored but not started): the panel lists the configured servers
  from the configuration, without live status, under "Claude Code is not running in this tab: statuses show once it runs";
  configuration actions still work; session actions (reconnect, sign-in's reconnect) are disabled.
- **Pending approval** of a project (`.mcp.json`) server is read from the configuration (`enableAllProjectMcpServers`,
  `enabledMcpjsonServers`, `disabledMcpjsonServers` in the user config's entry for the folder and in the settings files).
  Approve / reject (my call, v1): Claude Code has no command for it, and ClaudeTerm does not write the user's repository, so
  the button opens that step in the terminal view of the tab (the existing "open in terminal" path), and the change is then
  noticed like any other.
- **Plugins.** Installed and Discover come from `claude plugin list --json` and `claude plugin list --json --available`; a
  pasted GitHub link or URL or folder goes to `claude plugin marketplace add <source>`, then its plugins are listed with
  Install (a repo without a marketplace manifest shows the CLI's error). A plugin's options come from
  `claude plugin configure <plugin> --json` after the install; unset required ones are asked for in the panel before the
  restart, and saved with `--values-stdin`.
- **Sign-in**: main runs `claude mcp login <name>` (it opens the browser and takes the OAuth callback itself); the row shows
  "Waiting for the browser…" with Cancel (ends the process; a time limit of 5 minutes); on success the server is reconnected
  in the running session (`reconnectMcpServer`). Sign out: `claude mcp logout <name>`, then reconnect. The stand-in scripts
  both.
- **Remote tabs**: plain text, "Manage MCP on <device>"; no action.
- **No setting** turns the automatic restart off (the card's Not now covers a moment when it is not wanted).

## Left to the builder

- How changes are noticed (file watching of the paths above vs. comparing after each turn), as long as a change made by
  Claude is noticed by the end of the answer that made it, and the app never polls `claude mcp list` in a loop.
- How the paste field parses a `claude mcp add` command line (quoting, `--` for stdio) and JSON shapes, as long as what it
  shows before adding is exactly what is added.
- The plugin detail view, the order inside groups, icons (initials on a colour, as on the board).
