# Extra accounts that sign in — design

Date: 2026-11-12
Status: draft, for the person's review
Replaces, for new accounts: `2026-10-14-account-switching-design.md` (token accounts stay, as the alternative kind)

## Why

The person, about extra accounts: "make it possible to add extra accounts not the way it is done now, but another way, so
that connectors, Remote Control and the rest can be used from the extra account. Make adding convenient."

Today an extra account is a name and a token from `claude setup-token`, given to its tabs as `CLAUDE_CODE_OAUTH_TOKEN`
(`src/main/accounts.ts` ~92–108). Claude Code's docs say such a token "can only make model requests, so it can't establish
Remote Control sessions or fetch claude.ai connectors". The way Claude Code documents for several logins is a
`CLAUDE_CONFIG_DIR` per account: "Each directory has its own settings, session history, and claude.ai login". This design
makes that the normal kind of extra account, and makes adding one a short guided flow.

The board: `.superpowers/accounts/boards/accounts.html` (git-ignored scratch; copy it into the plan's workspace for the
builders). Seven frames: (1) Settings → Accounts, (2) the helper: set up, (3) the helper: sign in, (4) the helper: done, and
its error states, (5) where accounts show in the main window, (6) Recent sessions across accounts, (7) remove, a token
account switching to sign-in, a folder the person already has. It is the visual reference; where it and this text
disagree, the text wins.

Research behind it: `.superpowers/sdd/2026-11-11-chat-mode-4-devices/research-accounts.md`.

## Goals

- **A sign-in account**: an extra account signs in with claude.ai like Claude Code does, into a config folder of its own.
  Its tabs get everything a normal login gets: claude.ai connectors, Remote Control, the usage limits, plugins synced
  from claude.ai.
- **Adding is one helper with three steps** (frames 2–4): a name and tick boxes for what to carry over from Main account;
  the sign-in, which runs by itself in a tab while the browser is open; then the result — who signed in, on what plan,
  and what was carried. Nothing to copy or paste in the normal case.
- **Tabs on the account run with its folder**, in the chat view and in the terminal view, and ClaudeTerm's own tools
  (images, diffs, the task list, agent messages) work there.
- **One Recent sessions list for all accounts.** Continue as, and a new Open as in Recent sessions, copy the
  conversation into the other account, where it goes on.
- **Each account's state is visible**: signed in as whom, on what plan; not signed in; its folder gone. Sign in again
  is one button.
- **Token accounts stay** as the alternative kind ("Add with a token…"), work as today, and can switch to sign-in in
  place, keeping their id, their tabs and their place in the menus.
- **Removal** can sign the account out and move its folder to the trash.

## Non-goals

- Live sharing between accounts (links to Main account's skills, settings…). A later change in Main account reaches an
  account only when the person runs **Carry over…** again.
- Plain shell tabs on an account. A Claude tab on the account (its terminal view for `/remote-control`, `/mcp`, `/login`
  and the rest) covers what the person asked for.
- Adding or signing in an account from another device of the device group; accounts inside WSL.
- Switching account by itself when a limit runs out (unchanged from before).
- Signing Main account in or out, or changing anything of it, from ClaudeTerm.
- Console (API billing) logins (`--console`): the helper signs in to a Claude subscription only.
- Carrying conversations (they are in the one list), MCP servers' sign-ins, plugin option values, project-scope
  settings (they live in the repositories).

## Anti-goals (a failure even if it works)

- A credential of any account — the sign-in Claude Code keeps (`.credentials.json`, the macOS Keychain entry), a token,
  an OAuth code, an API key or a token found in settings — copied into another account, shown, logged, put in a toast,
  sent to the renderer or to another device. ClaudeTerm never reads `.credentials.json` or the Keychain at all.
- Main account's setup or sign-in changed. The flows only read Main account's folder. The one thing ClaudeTerm writes
  there is a conversation's transcript under `projects/`, when a conversation continues on Main account (decision 2).
- A folder deleted that ClaudeTerm did not create; a folder deleted while tabs run on it; an account's folder deleted
  for good (it goes to the system trash).
- A half-added account: an account is saved only once its folder is signed in, as `claude auth status` confirms. A
  cancelled or failed sign-in leaves no account and no folder.
- A conversation silently cut short by Continue as: a copy never replaces a copy that went further.
- The main process or the helper freezing while a CLI command runs or a folder is copied.
- A test that runs the real `claude`, or writes to the real home folder, `~/.claude`, `%APPDATA%\ClaudeTerm` or the
  system trash.

## Constraints and facts

- **Verified on Claude Code 2.1.322, help output only:**
  - `claude auth login [--claudeai | --console] [--email <email>] [--sso]` — `--claudeai`: "Use Claude subscription
    (default)"; `--email`: "Pre-populate email address on the login page".
  - `claude auth status [--json (default) | --text]`; `claude auth logout`.
  - `claude setup-token` — "Set up a long-lived authentication token (requires Claude subscription)".
  - `claude mcp add-json [-s user] <name> <json>` (`--client-secret` / `MCP_CLIENT_SECRET` for an OAuth client secret).
  - `claude plugin list --json`, `claude plugin marketplace list --json`,
    `claude plugin marketplace add <source> [--scope user] [--json]`,
    `claude plugin install <plugin[@marketplace]> [--scope user] [--json] [-y] [--accept-command <sha256>]`
    (a plugin whose marketplace declares an install command needs that command confirmed: `-y`, or
    `--accept-command` with the hash a `--json` run reported), `claude plugin disable [-s user] <plugin>`.
- **From Claude Code's docs** (sources in the research file):
  - A `CLAUDE_CONFIG_DIR` per account is the documented multi-account method. The sign-in is kept per folder on all
    three systems: `.credentials.json` in the folder on Windows and Linux, a Keychain entry "keyed to that directory"
    on macOS. `.claude.json` (account details, trust, user-scope MCP servers) moves into the folder too.
  - `CLAUDE_CODE_OAUTH_TOKEN` ranks above a `/login` sign-in, and `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` above
    both: a sign-in account's tabs must not have them.
  - `claude auth status`: exit 0 signed in, 1 not; the JSON has `authMethod` (`claude.ai` for a subscription sign-in)
    and, since 2.1.268, `configDirectory`. Other fields (email, organization) are not documented.
- **From the code:**
  - One environment patch reaches both views: `tab-manager.ts` ~663 builds the process environment with the launch's
    `EnvPatch`, and the same env goes to the PTY and to `startChat` → `sdk-engine.ts` ~199 (`options.env`), which
    spawns the user's Claude command with it. So `CLAUDE_CONFIG_DIR` in the patch covers chat and terminal tabs alike.
  - Hooks and the status line come per run through `--settings` (`claude-tab-settings.ts`), so they work under any
    config folder; `src/hook/compact-window.ts` ~69 already follows `CLAUDE_CONFIG_DIR`.
  - The chat's trust check reads `<CLAUDE_CONFIG_DIR or home>/.claude.json` from the tab's env (`chat-support.ts` ~96):
    a fresh folder trusts nothing, so a chat there falls back to the terminal for the trust question.
  - These read only Main account's folder today and must follow the account: Recent sessions
    (`SessionHistory`, `index.ts` ~279, one root), restore's transcript check (`index.ts` ~1471), the plan at the foot of
    the tabs (`claude-plan.ts`, `index.ts` ~2683), and the `claudeterm` MCP server, registered once at user scope for
    Main account (`mcp-registrar.ts` ~106, `index.ts` ~1883, packaged builds only).
  - A Claude tab's shell stays open after Claude Code exits (`buildLaunch`, `profiles.ts` ~220: `-NoExit`, `/k`,
    `exec bash`), so a tab's exit does not say a command ended unless the launch is built to end with it.
  - Subagent transcripts live beside the conversation, in `<transcript dir>/<sessionId>/subagents/`
    (`2026-11-12-agent-chat-design.md`, which already points at this design for sign-in accounts).
  - The Agent SDK has no sign-in of its own (research: none found); the CLI is the way.
- **Not verified** (the stand-in follows what is assumed; the person checks once by hand, see the end):
  - the exact fields of `auth status --json` beyond `authMethod` and `configDirectory`;
  - what claude.ai does with `--email` when the browser is already signed in as someone else;
  - whether the first terminal start in a fresh folder shows Claude Code's onboarding (theme picker) after
    `auth login`.

## Decisions taken in the conversation

1. **Setting up an extra account**: a helper window where the person ticks what to carry over from the main account
   (settings, MCP servers, plugins, skills, agents, CLAUDE.md, hooks… — what a fresh config folder would lack).
2. **Sessions**: one shared Recent sessions list for all accounts (the recommended option). "Continue as <account>"
   copies the conversation's transcript into the other account, so it resumes there.
3. **Tokens are an alternative feature, it stays**: today's setup-token accounts (inference only — no connectors, no
   Remote Control) remain as an alternative kind.
4. New accounts are added "another way" than today: by signing in. The token way moves behind **Add with a token…**.

## My calls (for the person to check)

1. **Where the folder lives**: `~/.claude-accounts/<name>` in the home folder (`C:\Users\<you>\.claude-accounts\work`),
   next to `~/.claude`. It holds the account's conversations, so it is the person's data rather than the app's: it
   survives a reset of ClaudeTerm's data folder, stays out of the roaming part of a Windows profile, and works in any
   terminal (`CLAUDE_CONFIG_DIR=<it> claude`). The name comes from the account's name at creation and does not follow a
   rename.
2. **The helper is a dialog in the Settings window** (Accounts page). Every "Add account…" in the main window opens
   Settings there with the helper. Main owns the flow, so closing the window does not cancel a sign-in in progress;
   opening Settings again shows it. One add at a time.
3. **The sign-in runs in a terminal tab** of the main window (`Sign in — Work`, in the background), as Get a token does
   today: whatever Claude Code asks (a link to copy, a code to paste, SSO) the person sees and answers there. The
   helper shows the state, and **Show the sign-in tab**. The tab runs the command once, so its end is the end of the
   sign-in; it closes by itself on success.
4. **Everything in the tick list is ticked by default**; what Main account does not have is shown greyed and unticked.
   The source can be another signed-in account instead of Main account (a select, Main account first).
5. **An optional Email field** fills in the sign-in page (`--email`), against the most likely mistake: the browser
   already signed in to claude.ai as Main account.
6. **The same login twice is a warning, not a block**: when the new sign-in is the same email and organization as Main
   account or another account, the helper says so and offers **Sign in with another account** (focused) and
   **Keep it anyway**. Same email, other organization (a personal and a team plan) is a different account and passes.
7. **Plugins are installed again with Claude Code's own commands**, not copied (their records hold absolute paths).
   ClaudeTerm never confirms a marketplace command for the person: such a plugin is skipped and named.
8. **Trusted folders are carried by one direct write** into the new account's `.claude.json`: Claude Code has no command
   for trust, and without it every chat in a fresh account would first fall back to the terminal. It adds only
   `hasTrustDialogAccepted: true` per folder, and only while nothing runs on that account.
9. **Recent sessions shows an account chip only for sessions not on Main account**, as the window title leaves Main
   account out. The search matches the account's name too.
10. **Continue as refuses rather than overwrite**: when the target account's copy went further than the source's, the
    switch does not happen and a toast says where the conversation went on.
11. **Removing an account with its folder** signs it out first (`auth logout`, which also clears the macOS Keychain
    entry), then moves the folder to the system trash. Not while tabs run on it.
12. **Use a folder I already have…**: an existing config folder (`~/.claude-work`) can be added as an account; it is
    never deleted by ClaudeTerm, only signed out of if asked.
13. **A not-signed-in account is not startable**: its ▾ item reads `(sign in again)` and opens the helper's sign-in
    step instead of a tab; Continue as and Open as to it are disabled with the same words. No `auth status` runs before a
    tab starts (no delay).
14. **Token accounts get no nagging**: one line on their row says what they lack, and **Sign in instead…** is there.

## Answers for the builder

### Storage — `accounts.json` version 2

- `{ version: 2, accounts: [entry] }` where an entry is either
  `{ id, name, addedAt, kind: 'login', folder, created }` — `folder` absolute, `created` true when ClaudeTerm made it — or
  `{ id, name, addedAt, kind: 'token', token, encrypted }` as today.
- Version 1 is read as token entries; the file is written as version 2 at the next change. Written atomically with mode
  0600, a broken file kept aside, entries of a wrong shape skipped — as today. No email, plan or credential is stored.
- An older ClaudeTerm reads a version 2 file as broken and keeps it aside as `accounts.json.broken` (nothing is
  deleted). Accepted: updates only go forward.
- `id` stays a UUID and is what tabs, snapshots and other devices refer to. A token account that switches to sign-in
  keeps its id.

### The account's folder

- Root: `<home>/.claude-accounts`. Overridden by `CLAUDETERM_ACCOUNTS_ROOT`; with `CLAUDETERM_TEST=1` and no override it
  is `<dataDir>/claude-accounts`, so a test can never create anything in the real home folder.
- Name: the account's name, lowercased, non-ASCII dropped, every run of other characters → `-`, trimmed, at most 32
  characters; empty → `account`; taken (a folder exists, or another account has it) → `-2`, `-3`…
- Created at **Sign in…**, mode 0700 on Linux and macOS. Never inside Main account's folder or another account's
  (compared with `pathKey` after `realpath`, so junctions and short names count), and never derived from ClaudeTerm's own
  `CLAUDE_CONFIG_DIR`.
- Main account's folder is `process.env.CLAUDE_CONFIG_DIR || ~/.claude`, its user file
  `<CLAUDE_CONFIG_DIR or home>/.claude.json` (the existing helpers). In test mode with no `CLAUDE_CONFIG_DIR`, Main account
  is read as having nothing (as `index.ts` ~2683 already does for the plan).

### The add flow — main owns it, the helper shows it

Entry points: Settings → Accounts **Add account…**; **Add account…** at the end of the ▾ menu's account items and of the
status bar account menu (both shown once an extra account exists, as the account items are today). All open the Settings
window at Accounts with the helper (a new `add-account` section for the window's `#hash` / `showSection`).

**Step 1 — Set up** (frame 2). Title `Add a Claude account`; steps `Set up · Sign in · Done`.
- `Name` (focused, placeholder `Work, Personal…`), checked as today (`checkAccountName`); `Email (optional)` with the note
  `Fills in the sign-in page`, checked as an address (letters, digits and `. _ % + - @` only) before it goes on a command
  line.
- `Carry over from` — Main account, or another signed-in account. The tick list with a count per item (table below),
  read from the source in the background (`counting…` until then); `Select all` / `None`.
- The line `Never carried: the sign-in of Main account, its conversations, Claude Code's caches.`
- `Use a folder I already have…` (left), `Cancel`, **`Sign in…`** (primary; disabled until the name is valid).

**Step 2 — Sign in** (frame 3). On **Sign in…** main creates the folder, keeps the pending account in memory only, and
opens the sign-in tab:
- A shell tab on the Claude tabs' shell profile, in the home folder, titled `Sign in — <name>`, opened in the background
  (the main window is not brought forward). Command line `<claude.command> auth login --claudeai [--email <email>]`,
  built like the Get a token tab's (no `--settings`), but **run once**: the shell ends with the command (PowerShell
  without `-NoExit`, cmd `/c`, bash and zsh `-c` without the `exec`, fish `-c`).
- Its env patch: `set CLAUDE_CONFIG_DIR=<folder>`; `unset CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
  ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN`.
- It is not kept in the session snapshot and not restored.
- The helper: a spinner with `Waiting for the sign-in in your browser…`; `Your browser opened claude.ai. Sign in with the
  account for <name>.`; the hint `Signed in to claude.ai as someone else? Switch accounts on that page, or copy the link
  from the sign-in tab into a private window.`; buttons **Show the sign-in tab** (brings the main window forward on that
  tab) and `Cancel`. No time limit: the person cancels.
- When the tab's process ends — by itself, or because the person closed the tab — main runs `claude auth status --json`
  in the folder (the exit code of the tab alone never counts):
  - signed in with `authMethod` `claude.ai` → step 3;
  - otherwise the helper says `The sign-in did not finish` with the tab's last line of output when there is one, and
    offers `Try again` (closes the old tab, opens a new one) and `Cancel`. The exited tab stays until then, showing
    Claude Code's own message.
- **Who signed in**: email, organization name and uuid, and plan, from `auth status` where it has them, else from the
  folder's `.claude.json` `oauthAccount` (`emailAddress`, `organizationName`, `organizationUuid`, `organizationType` →
  plan as `claude-plan.ts` maps it). Both are untrusted and validated; a missing field shows nothing, not an error.
- **The same login** as Main account (from its `.claude.json`) or another account (call 6): `This is the same login as
  <account> (<email>): tabs on <name> would share its limits and connectors.` → **Sign in with another account** runs
  `auth logout` in the new folder, then a new sign-in tab; **Keep it anyway** goes on.
- **Cancel** (in step 2, or on a failure): closes the sign-in tab, deletes the folder ClaudeTerm just created (nothing
  else can be in it), forgets the pending account. Nothing is written to `accounts.json`.

**Step 3 — Done** (frame 4). The account is saved (kind `login`), `ev:accounts` goes out, then:
- the carry-over runs, one line per ticked item with its result: done with a count, skipped with the reason, or failed
  with Claude Code's message and `Try again` for that item. One item failing does not stop the others;
- the `claudeterm` MCP server is registered in the account (always; the line `ClaudeTerm's tools`);
- the head says `Signed in as <email> · <plan>`; the foot shows the folder, `Done`, and
  **`Open a Claude tab on <name>`** (primary).
- With the Settings window closed meanwhile, the same happens and the main window toasts
  `Account "<name>" is ready: signed in as <email>`.

**Use a folder I already have…** opens main's folder dialog (the renderer never sends a path). Main checks: a folder; not
Main account's or another account's (`pathKey` after `realpath`); then `auth status` there. The helper shows the path and
who is signed in; the ticks turn off with the note `This folder has its own setup: tick what to carry over anyway`;
the button reads `Add` when the folder is signed in (straight to step 3), `Sign in…` when not. Saved with
`created: false`.

**Carry over…** on a sign-in account's row reruns step 1 without the name and the sign-in (title
`Carry over to <name>`, button `Carry over`), then step 3's list.

### Carry over: what and how

Only what is listed here is ever carried. Every read of the source is read-only; nothing writes to the source.

| Item (label) | From the source | Into the account |
|---|---|---|
| Settings | `settings.json` without `hooks`, `enabledPlugins`, `extraKnownMarketplaces` and the credential keys below | the account's `settings.json`: the source's top-level keys replace the same keys, `env` merged per variable, other keys kept |
| Hooks | `settings.json` → `hooks` | the account's `settings.json` → `hooks`, replaced as a whole |
| MCP servers | user-scope `mcpServers` of the source's `.claude.json`, except `claudeterm` | `claude mcp remove --scope user <name>` then `claude mcp add-json --scope user <name> <json>`, per server |
| Plugins | user-scope installed plugins, their marketplaces, and on/off from `enabledPlugins` | `claude plugin marketplace add <source>`, `claude plugin install <plugin>@<marketplace> --scope user --json`, then `claude plugin disable … --scope user` for the ones that are off |
| Skills, Agents, Commands, Output styles | `skills/`, `agents/`, `commands/`, `output-styles/` | the same folders, copied |
| Memory | `CLAUDE.md` and `rules/` | copied |
| Keybindings | `keybindings.json` | copied |
| Trusted folders | `projects[<folder>].hasTrustDialogAccepted === true` in the source's `.claude.json` | the account's `.claude.json`: `projects[<folder>].hasTrustDialogAccepted = true`, the entry created with that key alone when absent, nothing else touched |

- **Never carried, whatever is ticked**: `.credentials.json` and the Keychain entry; everything else in `.claude.json`
  (`oauthAccount`, user ids, onboarding state, caches, MCP servers' OAuth tokens); `projects/`, `todos/`,
  `file-history/`, `shell-snapshots/`, `session-env/`, `plans/`, `plugins/` itself, and any other entry. From settings:
  `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `forceLoginMethod`, `forceLoginOrgUUID`; from its `env`:
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`,
  `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`.
- **Counts** in step 1: settings = top-level keys after the filter; hooks = hook entries; MCP servers = names (the first
  three shown); plugins = installed, with the number of marketplaces; folders = files; trusted folders = entries. Values
  are never shown: the helper names things, it does not show what is in them.
- **The CLI items run with the account's env** (as tabs get it) and the user's Claude command, one at a time, each with a
  time limit (60 s), never blocking main. A server's JSON (it can hold env values and headers) goes as an argument of a
  short-lived child with no shell — the exposure the MCP · Plugins design accepted — and is never logged: a failure logs
  the server's name and the exit code only.
- **Plugins**: a plugin whose install needs a marketplace command confirmed is skipped:
  `<plugin>: its marketplace runs a command to install it — install it from MCP · Plugins in a chat on <name>`. A
  marketplace that claude.ai hosts for the source account is skipped (the new account gets its own after signing in):
  `<marketplace>: hosted by claude.ai for <source>`. Plugin options are not carried; a plugin that needs them asks again.
  Already installed counts as done.
- **MCP servers** that sign in with OAuth come over without their sign-in; they show "needs sign-in" in the account's
  chats (MCP · Plugins panel).
- **Copies** go to a temporary name and are renamed into place; a same-named file in the account is replaced, nothing
  the account has alone is deleted. Folders are copied asynchronously.
- **Trusted folders** are written last, after the CLI items, by a fresh read of the account's `.claude.json` and an
  atomic replace. On a later Carry over… with tabs running on the account, this item is disabled:
  `Close the tabs on <name> to carry over trusted folders`.

### Starting tabs on an account

- `accountLaunch` gains the sign-in kind: env patch `set CLAUDE_CONFIG_DIR=<folder>`; `unset CLAUDE_CODE_OAUTH_TOKEN,
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN`. Token accounts and Main account: as today.
  The one patch reaches chat and terminal tabs (see facts), and the CLI runs the MCP · Plugins panel makes with the
  tab's env.
- Unavailable (not signed in, folder missing): the start falls back to Main account with today's toast, a switch is
  refused (`strict`) — as for an unreadable token today.
- Which account a new tab gets: as today (the active Claude tab's, else Main account), except a session opened from
  Recent sessions, which starts on the account that holds it.
- The `claudeterm` MCP server: `ensureMcpRegistered` takes the env and runs per sign-in account — at app start in the
  background (as for Main account, packaged builds only, skipped with `CLAUDETERM_SKIP_MCP_REGISTER=1`), after a sign-in,
  and after **Use a folder I already have…**. `runClaude` passes the env in both of its branches (today the `.cmd` branch
  drops it).

### The state of an account

- `AccountView` gains `kind`, `state` (`ready` | `signed-out` | `missing` | `unknown` for sign-in accounts; token accounts
  keep `readable`), and for sign-in accounts `email`, `plan`, `folder`. `readable` stays as "a tab can start on it":
  `ready` or `unknown`, or a token that can be read. `AccountsView` gains `main: { email, plan, folder }`.
- `auth status` runs per sign-in account at app start (in the background, after the window is up), when the Accounts page
  is shown (at most once a minute), after a sign-in, and after a chat on the account ends with an error. One at a time
  per account, 15 s limit. A timeout or an answer that cannot be parsed is `unknown` and blocks nothing.
- `email` and `plan` come from the account's `.claude.json` (cheap, read with each state check); never sent to another
  device.
- Rows (frame 1): `Signed in as <email> · <plan>` (green dot); `Not signed in` (amber) with **Sign in again**;
  `Its folder is gone: <path>` with **Remove**; `Checking…` while the first check runs.

### Recent sessions and Continue as

- `SessionHistory` reads several roots: Main account's `projects/` and each sign-in account's `<folder>/projects/` (token
  accounts share Main account's). `SessionSummary` gains `account: string | null`.
- The same session id under several roots (after a Continue as) is listed once: the copy whose transcript changed last,
  with its account. Starred sessions, notes and task lists stay keyed by the session id.
- A row (frame 6) shows a chip with the account's name when it is not Main account and an extra account exists. A row's
  context menu gets `Open as <account>` for every other startable account. The search matches the account's name.
- Opening a row starts it on its account (`openTab` with `account`), not the active tab's.
- **Copy rule A — an explicit move** (Continue as, Open as): ClaudeTerm copies the conversation from the account it is on
  to the target, then resumes it there. The source is the tab's transcript path as Claude Code reported it, else the
  listed copy. Copied: `<id>.jsonl` and, when present, the `<id>/` folder beside it (subagent transcripts, stored tool
  results), into the same project folder name under the target's `projects/` (the source's own folder name, never
  recomputed: Claude Code shortens long ones). When the target has no copy, or an older one (by modification time),
  it is replaced. When the target's copy is newer, nothing happens and the toast says
  `This conversation went further on <account>; open it from Recent sessions`. Between Main account and a token account
  nothing is copied (one folder), as today.
- **Copy rule B — any other resume** (restart, restore, a view switch, a fork, opening a row): it runs on the account's
  own copy; only when the account has none and another account has one is the newest copied in first, as in rule A.
  This also carries the conversations of a token account that switched to sign-in, and of a removed account whose
  folder was kept.
- **Order**: the copy runs after the old process has exited and before the new one starts (in `switchAccount` /
  `restart`'s relaunch). It is written under a temporary name in the target folder and renamed into place, so a
  half-written copy is never resumed. A failed copy (disk full, permissions): the tab starts again on its old account,
  and the toast says `Could not copy the conversation to <account>: <reason>. The tab goes on as <old account>.`
- A conversation without a transcript yet starts fresh, as today. The chat's restart divider reads
  `Continued as <account>`.
- Restore's transcript check (`index.ts` ~1471) and the resumable check look in the tab's account's folder, with rule B.

### Token accounts — the alternative, and switching them to sign-in

- **Add with a token…** (under the list) opens today's form in a dialog: name, token, **Get a token**. The row: a `Token`
  badge, `Token valid until about <date> · model requests only: no connectors, no Remote Control`, **Sign in instead…**,
  `Replace token`, and in `···` Rename and Delete. The keyring notice shows when a token account exists, as today.
- Nothing changes for existing token accounts on update: version 1 entries are token accounts.
- **Sign in instead…** opens the helper on that account: step 1 with its name (editable), the ticks, and the note
  `Its tabs keep running on the token until they restart. The token is deleted once you are signed in.`; then steps 2
  and 3 as for a new account. On success the entry becomes `kind: 'login'` with the same id, and the token is removed
  from `accounts.json` in the same write. Its tabs move to the sign-in at their next start; their conversations follow by
  rule B. Older conversations of a token account are in Main account's folder, so Recent sessions lists them as Main
  account's.

### Removal

- A sign-in account's `···` → `Remove…` (frame 7): `Remove <name>?` / `Tabs on <name> keep running until they close; then
  they start on Main account.` and a box, ticked when ClaudeTerm created the folder:
  `Sign out and move its folder to the trash` with `<folder> · <n> conversations · they leave Recent sessions`. For a
  folder ClaudeTerm did not create the box reads `Sign out of it` (the folder stays).
- With tabs running on the account, the box is disabled: `Close the <n> tabs on <name> to remove its folder too`.
- In order: `claude auth logout` with the account's env (when ticked), the entry removed from `accounts.json`,
  `ev:accounts`, then the folder moved to the system trash (`shell.trashItem`; under `CLAUDETERM_TEST=1` it is deleted
  instead, as the trash is the machine's). A failed logout or move is reported in the dialog and leaves the account
  removed and the folder where it is.
- Token accounts: Delete as today.

### Other devices

- Accounts stay on their device: folders, sign-ins, tokens and emails never leave it. A member sees, as today, the ids
  and names of the accounts a tab can start on (`accountEntries`, `remote-host.ts` ~849): signed-in or unknown sign-in
  accounts and readable tokens. It opens tabs and Continue as through the host, where the copy happens.
- A device's Recent sessions answer carries each session's account name (cut and cleaned like titles); remote rows show
  the chip; opening one opens it on the host, on its account.
- Agent messages to tabs on another account (`list_agents` / `message_agent`) work because each sign-in account has the
  `claudeterm` server.

### Where accounts show in the main window (frame 5)

- ▾ menu, once an extra account exists: `Claude Code — <account>` for each, Main account first; a not-signed-in one reads
  `Claude Code — <name> (sign in again)` and opens the helper's sign-in for it; a missing folder is disabled; a token one
  reads `Claude Code — <name> · token`. Then `Add account…`.
- The tab menu and the status bar's account segment: `Continue as <account>`; a not-signed-in one disabled with
  ` (sign in again)`. The segment's menu ends with `Sign in to <name> again…` for such accounts, and `Add account…`.
- The foot row of the left tab panel: the plan of a sign-in account (`Team plan`), `Token account` for a token one
  (today `Extra account`).
- The window title, the usage limits of the tab in front (per tab already) and the status bar segment: unchanged in
  behavior; the limits now show for sign-in accounts.

### IPC (names are suggestions; main checks every argument in `ipc-guards.ts`)

| Channel | Kind | Arguments |
|---|---|---|
| `accounts:list` | invoke | → `AccountsView` (with `main`, and per account `kind`, `state`, `email`, `plan`, `folder`) |
| `accounts:carry-preview` | invoke | `source: string \| null` → counts per item |
| `accounts:begin` | invoke | `{ mode: 'add' \| 'sign-in-again' \| 'to-login' \| 'carry', id?, name?, email?, source, items }` → `AccountResult` |
| `accounts:pick-folder` | invoke | opens main's folder dialog; main keeps the path → `{ ok, signedIn, email?, plan? }` |
| `accounts:flow` | event | the flow's state, to the Settings window: step, item lines, errors |
| `accounts:cancel`, `accounts:show-sign-in-tab`, `accounts:retry-item` | send | — / — / `item` |
| `accounts:remove` | invoke | `id`, `{ signOut, deleteFolder }` → `AccountResult` |
| `accounts:rename` | invoke | as today |
| `accounts:add`, `accounts:set-token`, `accounts:get-token` | as today | token accounts |
| `sessions:open-as` | send | `sessionId`, `account: string \| null` |

## Tests

No test runs the real `claude`, uses a real account, or touches the real home, `~/.claude` or the trash. Main account in
tests is a temp `CLAUDE_CONFIG_DIR`; the accounts root is under the run's temp folder (`CLAUDETERM_ACCOUNTS_ROOT`).

- **The stand-in** (`tests/fixtures/fake-claude`) learns, all against `CLAUDE_CONFIG_DIR`:
  - `auth login [--claudeai] [--email …]`: prints a line, waits for a gate file when scripted (so a test can look at
    step 2), writes a stand-in `.credentials.json` and `.claude.json` `oauthAccount` (an invented email, organization and
    type, scripted per folder name; default `<folder>@example.com`, Team plan), exits 0; or exits 1 without writing when
    scripted to fail;
  - `auth status [--json | --text]`: from those files, exit 0 / 1; `auth logout`: removes them;
  - `mcp get / remove / add / add-json`, `plugin list --json`, `plugin marketplace list --json`,
    `plugin marketplace add`, `plugin install` (one scripted plugin answers "needs a confirmed command"),
    `plugin disable`: they log their arguments and `CLAUDE_CONFIG_DIR` to `FAKE_CLAUDE_LOG`, and change the files the
    way the real ones are assumed to (shared with the MCP · Plugins work if it teaches them first);
  - every run logs whether `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` were set (not their values).
- **Unit**: `parseAccounts` v1 → v2 and v2; folder naming (slug, `-2`, empty, non-ASCII); the launch env of a sign-in, a
  token and Main account; the carry-over planner — the settings filter (each credential key and env variable dropped,
  `hooks` split off, `enabledPlugins` and `extraKnownMarketplaces` left to Plugins), the merge into existing settings,
  the trusted-folders write (adds only that key, keeps everything else, unchanged text when nothing to add); `auth
  status` and `.claude.json` parsing (good, garbage, missing fields → unknown); the same-login check (email + org);
  `SessionHistory` over several roots with one id in two (newest wins, its account); the copy decision of rules A and B
  (none, copy, replace older, refuse newer, same folder); `AccountView` states; the account items of the menus.
- **Integration** (real files in temp, the stand-in as the CLI): carry-over into a fresh folder copies the trees and
  never changes the source (the source folder hashed before and after, `projects/` included); a stand-in
  `.credentials.json` in the source is never in the account; the CLI items run with the account's `CLAUDE_CONFIG_DIR`
  and no token; `ensureMcpRegistered` with an env; the transcript copy (temp name then rename, the `<id>/` folder, the
  source's project folder name); `accounts.json` v2 written atomically, 0600 on Linux.
- **E2E**:
  - Settings → **Add account…** → name and ticks → **Sign in…**: a `Sign in — Work` tab runs `auth login --claudeai`
    with the new folder in `CLAUDE_CONFIG_DIR` (stand-in log); released, the helper shows `Signed in as …`, the carry-over
    lines, and the row; nothing of the source changed.
  - ▾ → `Claude Code — Work`, in the terminal view and in the chat view: the stand-in logs the account's folder, no
    OAuth token, no API key.
  - Cancel during step 2: no account, no folder, the tab gone. A failed sign-in: `The sign-in did not finish` and
    `Try again`. The same login as Main account: the warning and both buttons.
  - Closing the Settings window during step 2 and finishing the sign-in: the toast, and the account listed.
  - Recent sessions lists a Main and a Work session (the chip on Work's only); opening Work's starts on Work; the search
    finds `work`.
  - Continue as Work: the transcript appears in Work's `projects/` and the tab resumes it on Work; refused (toast,
    nothing changes) when Work's copy is newer; a restart of a tab whose conversation is only in Main account's folder
    copies it (rule B).
  - A token account's **Sign in instead…** keeps the id (an open tab on it keeps its account), and the token is gone
    from `accounts.json`.
  - Remove with sign-out: `auth logout` logged with the folder, the folder gone (test mode deletes); with a tab running,
    the box is disabled; an adopted folder is never deleted.
  - **Use a folder I already have…** with a signed-in folder: added without a sign-in tab (main's
    `dialog.showOpenDialog` stubbed through `app.evaluate`, as `chat-composer.spec.ts` ~1215 does).
  - No secret anywhere: the stand-in's credential value and a token never appear in the app log, a toast, the accounts
    IPC answers, or either window's DOM.
  - The existing `accounts.spec.ts` stays for token accounts (some names change: `Token account`, `Add with a token…`).

## Checks by hand with real accounts (after the build)

With a second Claude account of the person's, once:

- claude.ai connectors in a chat and in the terminal view on the sign-in account; `/remote-control` there.
- The fields of `claude auth status --json`; what `--email` does when the browser is signed in as Main account.
- The first terminal start on a fresh account: if Claude Code shows its onboarding (theme picker), the carry-over also
  sets `theme` (from the source) and `hasCompletedOnboarding: true` in the account's `.claude.json`, in the same write as
  the trusted folders; if it asks nothing, nothing is added.
- macOS: `auth logout` removes the Keychain entry of that folder.

## Answers for the builder (from the builder check)

- **Order (controller's call).** The features are built one after the other, each on the merged result of the one
  before: the current chat follow-ups → MCP · Plugins (`2026-11-12-mcp-plugins-design.md`; it teaches the stand-in the
  `claude mcp …` / `claude plugin …` commands and owns `fake-claude.ts` while it runs) → extra accounts (this document) →
  the agent chat. So this plan may assume the stand-in's `mcp` / `plugin` commands and the MCP · Plugins CLI runner exist
  (read the code as it is then); the `runClaude` env fix for the `.cmd` branch is this plan's, unless MCP · Plugins already
  made it.
- **Step 3 of the add flow: `unknown` right after a sign-in is a failure.** The account is saved only on exit 0 with
  `authMethod` `claude.ai`; a timeout or an answer that does not parse shows "Could not confirm the sign-in" with Try again,
  and nothing is saved. `unknown` blocks nothing only in the later, background checks. `email` and `plan` are read from
  `auth status` when present, else from the folder's `.claude.json` `oauthAccount`; when neither has them, the same-login
  warning is not shown (no guess).
- **Rule B on Main account: yes, intended.** A Main account tab whose conversation's newest copy is on a sign-in account
  gets that transcript copied under Main's `projects/` when it resumes there — that is "a conversation continuing on Main
  account". No guard against it; test it.

## Left to the builder

- The module split (for example `account-login.ts` for the sign-in launch and status parsing, `account-carry.ts` for the
  planner and its runner, `transcript-move.ts` for the copy rules, `account-helper.ts` in the renderer), as long as the
  pure parts are unit-tested.
- Whether the plugin list of the source is read from Claude Code's files or with `claude plugin list --json` and
  `marketplace list --json` under the source's env — as long as nothing writes to the source.
- How a symlink or junction inside a copied folder is carried: recreated to the same target where the system allows,
  else its content copied.
- How the "run once" launch is added to `buildLaunch`, and how the flow learns the sign-in tab's process ended.
- The helper's layout and motion within the board's look; the order of rows inside the Accounts card (Main account first,
  then by addition); showing paths with `~`.
- README: the Accounts section rewritten (sign-in accounts, carrying over, Continue as across accounts, token accounts as
  the limited alternative).

## Questions for the person

None. The calls above are mine; the ones with the most effect, if a glance is wanted: where the folders live (1), the
sign-in in a background tab (3), and the warning instead of a block for the same login (6).
