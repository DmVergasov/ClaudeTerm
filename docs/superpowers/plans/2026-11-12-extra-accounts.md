# Extra accounts that sign in — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An extra account signs in with claude.ai into a Claude Code config folder of its own (`~/.claude-accounts/<name>`), added through a three-step helper in Settings that carries over what Main account has; its chat and terminal tabs run with that folder; Recent sessions lists every account's conversations and Continue as / Open as copy a conversation to the account it goes on; token accounts stay as the limited alternative and can switch to sign-in in place.

**Architecture:** Main owns everything. `accounts.ts` keeps `accounts.json` version 2 (`login` and `token` entries) and gives a sign-in account's launch `CLAUDE_CONFIG_DIR=<folder>` with every token and key unset; the one env patch reaches the PTY, the chat process and the MCP · Plugins CLI. New modules: `account-login.ts` (folder names, the sign-in command, `auth status` and `.claude.json` parsing — pure), `account-checks.ts` (per-account `auth status`), `account-flow.ts` + `account-remove.ts` (the add flow as a state machine, removal), `account-carry.ts` (the carry-over planner — pure) and `account-carry-run.ts` (its copies and CLI items), `transcript-move.ts` (copy rules A and B). `TabManager` gets a run-once sign-in tab left out of the snapshot and a `moveConversation` hook between a process's exit and the next start. `SessionHistory` reads one root per account. The renderer gets the rewritten Accounts card, the helper dialog (`account-helper.ts`), account-aware menus, and the Recent sessions chip and `Open as`.

**Tech Stack:** Electron 44, TypeScript (strict), node-pty, `@anthropic-ai/claude-agent-sdk` (as pinned), plain DOM, Vitest, Playwright, the stand-in Claude Code (`tests/fixtures/fake-claude`).

**Spec:** `docs/superpowers/specs/2026-11-12-extra-accounts-design.md` (approved; read it whole, with "Answers for the builder" — both sections — which are binding). Visual reference: the board, copied by the controller to `.superpowers/sdd/2026-11-12-extra-accounts/boards/accounts.html` (frames 1 Settings → Accounts, 2–4 the helper, 5 the main window, 6 Recent sessions, 7 remove / sign in instead / a folder you have); where board and spec disagree the spec wins. Research: `.superpowers/sdd/2026-11-11-chat-mode-4-devices/research-accounts.md`.

**Builds on (must exist before Task 1; from `docs/superpowers/plans/2026-11-12-mcp-plugins.md`, merged):**
- `src/main/mcp/claude-cli.ts`: `runClaudeCli(launch, args, o: CliOptions): Promise<CliRun>` (the user's command as the tab's Claude Code starts it — cmd.exe for a `.cmd`, the login shell for a bare POSIX command — `NO_COLOR=1`, a time limit, rejects only with `CliError`), `CliRun { code; stdout; stderr }`, `CliError` (`reason: 'timeout' | 'cancelled' | 'failed' | 'too-large'`), `CLI_TIMEOUT_MS` (60 000), `cliMessage(r)`, `jsonOutput(stdout)`.
- `src/main/mcp/plugin-cli.ts`: `parseInstalled(v)`, `parseMarketplaces(v)`. `src/main/mcp/mcp-config.ts`: `MAX_CONFIG_BYTES`. `src/shared/mcp-add.ts`: `isServerName(name)`, `maskText(text, secrets)`, `MASK`.
- `TabManager.claudeEnv(tabId)` (the env a tab's Claude Code starts with; the MCP panel's CLI uses it).
- The stand-in's CLI mode for `claude mcp …` / `claude plugin …` (`add-json`, `remove`, `login`, `logout`; `plugin list --json`, `marketplace add/list --json`, `install`, `disable`, …), its script options `marketplaces` and `cliFail`, and `tests/e2e/mcp-helpers.ts` (`cliCalls`, `readJsonFile`, `runStandIn`).
- **The `runClaude` env fix is this plan's (Task 6):** MCP · Plugins runs its CLI through its own `runClaudeCli` and leaves `src/main/mcp-registrar.ts` alone. At setup the controller confirms `runClaude`'s `.cmd` branch still calls `run(…, { verbatim: true })` without `env`; if MCP · Plugins fixed it after all, Task 6 keeps its new parts and its proving test stays as the regression test.

**Execution:** subagent-driven, implementers on Haiku (the person's standing rule; fix rounds 4–5 escalate as the skill says). Streams — see "Streams". The spec's "Checks by hand with real accounts" are Task 22, the controller's, not implementer work.

## Global Constraints

- Work in `D:\Workspace\ClaudeTerm\.claude\worktrees\feat-redesign-look`, branch `feat/chat-mode`. Never `cd` to the main checkout; never touch another worktree.
- **Never commit, stash, push, reset or create branches.** Leave every change uncommitted (the person's rule; the controller snapshots the tree). No subagents of your own. A conflict with another agent's work goes to the controller.
- **Build and e2e only through the lock:** `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/<file> --reporter=line --workers=2"` (`--workers=1` on a busy machine). Unit and integration: `npx vitest run <files>`. No `npm install`.
- **No test runs the real `claude`, uses a real account, or reads or writes the real home folder, `~/.claude`, `~/.claude.json`, `%APPDATA%\ClaudeTerm` or the system trash.** Main account in tests is a temp `CLAUDE_CONFIG_DIR`; the accounts root is `CLAUDETERM_ACCOUNTS_ROOT` under the run's temp folder.
- **Credentials:** ClaudeTerm never reads `.credentials.json` or the Keychain. No credential, token, OAuth code, API key or settings secret is copied into another account, shown, logged, toasted, sent to the renderer or to another device. A carried MCP server's JSON goes only as the `add-json` argument of a short-lived child; a failure logs `claude mcp add-json failed for <name> (<code>)` and nothing else.
- **Main account is read only.** The one write into its folder is a conversation's transcript under `projects/` (copy rule B). In test mode (`CLAUDETERM_TEST=1`) with no `CLAUDE_CONFIG_DIR`, Main account's folder is unknown (`null`): it has nothing to carry, no identity, no Recent sessions root, and no transcript is copied into or out of it.
- **Deleting:** only a folder ClaudeTerm created (`created: true`), never Main account's or another account's, never while tabs run on the account; removal moves it to the system trash (`shell.trashItem`), under `CLAUDETERM_TEST=1` it is deleted instead.
- **Sign-in accounts' env patch** (tabs, the sign-in tab, every CLI run for the account): `set CLAUDE_CONFIG_DIR=<folder>`; `unset CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_REFRESH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN` (`loginEnv`, Task 3). Every CLI run for an account goes through `runClaudeCli` with `resolveChatLaunch(settings.claude.command, chatLaunchDeps)`, cwd the home folder, env `applyEnvPatch(childEnv(), loginEnv(folder))`; limits: 60 s (`CLI_TIMEOUT_MS`), `auth status` 15 s (`STATUS_TIMEOUT_MS`). One `auth status` at a time per account; the Accounts page asks at most once a minute.
- **Untrusted input:** `auth status` output, `.claude.json`, `settings.json`, the plugin files, transcripts and `accounts.json` are checked field by field; an email ≤ 254 chars, a name ≤ 200, a file over `MAX_CONFIG_BYTES` (16 MiB) is not read. Nothing throws on bad input; a missing field shows nothing.
- **Main never blocks:** `fs.promises` for every read, copy and delete of these flows; CLI calls are awaited child processes. `resolveLaunch` stays synchronous and runs no `auth status` (a tab starts at once).
- **Paths are compared with `pathKey` after `canonicalFolder`** (`src/main/chat/chat-files.ts`: realpath, native on Windows), so junctions, symlinks, case and 8.3 names (`C:\Users\RUNNER~1` on CI) count.
- **UI strings exact** as the tasks give them (English). Match the surrounding code's naming and comment density; no UI framework; keep each file's line endings (new files like their neighbours — LF here). Motion only `transform`/`opacity`, off under `prefers-reduced-motion: reduce`. Colours are the variables of `src/renderer/colors.css`.
- Flaky specs under load (`review.spec`, a fold test in `tab-panel.spec`): rerun a failing test alone through the lock before blaming the change. Close every app a test starts; temp files only under `tmpdir()`.
- A failure in a file your task does not list is someone else's work in progress: never edit it; rerun later; report it if it persists. A main piece a renderer task needs and does not find is reported to the controller, never built in the renderer task.
- Done for a task = `npm run typecheck`, its `npx vitest run …` files, and its e2e specs through the lock, green. Bug fixes (Task 6) show their proving test failing before the fix in the report.

## Streams

| Phase | Tasks | Owns (only these files are edited) |
|---|---|---|
| Shared, first | 1 | `src/shared/accounts.ts`, `src/shared/ipc.ts`, `src/shared/types.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts`, the two compile fills of Task 1 in `src/main/accounts.ts` and `src/main/index.ts`, `tests/unit/ipc-guards.test.ts` |
| **A** (accounts), in order | 2 → 8 | `tests/fixtures/fake-claude/*`, `tests/fixtures/chat/README.md`, `tests/fixtures/accounts.ts`, `tests/e2e/account-helpers.ts`, `src/main/accounts.ts`, `src/main/account-login.ts`, `src/main/claude-plan.ts`, `src/main/profiles.ts`, `src/main/tab-manager.ts`, `src/main/chat/chat-hub.ts`, `src/main/mcp-registrar.ts`, `src/main/account-checks.ts`, `src/main/account-flow.ts`, `src/main/account-remove.ts`, the `accountLaunch` call of `src/main/index.ts` (Task 3), the tests named in A's tasks |
| **B** (conversations, carry-over), in order | 9 → 12 | `src/main/transcript-move.ts`, `src/main/session-history.ts`, `src/main/account-carry.ts`, `src/main/account-carry-run.ts`, the `new SessionHistory(…)` line of `src/main/index.ts` (Task 10), the tests named in B's tasks |
| **W** (wiring), after A and B, in order | 13 → 15 | `src/main/index.ts`, `src/main/settings-window.ts`, `src/main/remote-host.ts`, `src/main/sync/remote-shapes.ts`, `tests/e2e/accounts-launch.spec.ts`, `tests/e2e/accounts-flow.spec.ts`, `tests/e2e/accounts-history.spec.ts`, the tests named in W's tasks |
| **R** (renderer) | 16, then 17 → 20 | `src/renderer/**`, `tests/unit/account-items.test.ts`, `tests/unit/account-view.test.ts`, `tests/unit/recent-sessions.test.ts`, `tests/e2e/accounts-settings.spec.ts`, `tests/e2e/account-add.spec.ts`, `tests/e2e/accounts-menus.spec.ts`, `tests/e2e/accounts-recent.spec.ts`, `tests/e2e/accounts.spec.ts`, one line of `tests/e2e/tab-panel.spec.ts` |
| Final | 21, 22 | `README.md`; fixes the review asks for; the hand checks |

A, B and Task 16 run side by side after Task 1. **Task 12 starts after Task 2** (it runs the stand-in). W starts when A and B are done. **R: 16 after 1; 17, 18, 19 after 14; 20 after 15.** The interfaces between streams are Task 1's types and IPC (the only contract), the stand-in's script options (Task 2), and the Interfaces blocks below. Before Task 1 the controller copies the board to `.superpowers/sdd/2026-11-12-extra-accounts/boards/accounts.html` (gives its path to every R implementer), checks that MCP · Plugins has landed ("Builds on" above; `npm run typecheck` and `npm test` green) and the `runClaude` point above.

## Rulings on the spec (unbuildable or contradictory points; the plan follows these)

1. **ClaudeTerm's tools after a sign-in or an adopted folder** are registered with the user's Claude command through `runClaudeCli` (`ensureMcpRegistered`'s new `exec`), not with `resolveClaude` (`where.exe claude`): that is the command the account's tabs run, and in tests it is the stand-in, never the real `claude`. `CLAUDETERM_SKIP_MCP_REGISTER=1` skips only the start-up pass (as today); the start-up pass per sign-in account uses `ensureMcpRegistered` with `env` (packaged builds only).
2. **The source is read from its files, never with the CLI under the source's env**: a Claude Code subcommand may write the `.claude.json` of its folder, and nothing may write to the source. Plugins come from `<source>/plugins/installed_plugins.json` (`{ version: 2, plugins: { "<name>@<market>": [{ scope, … }] } }`) and `<source>/plugins/known_marketplaces.json` (read as `{ "<name>": { source: { source: 'github', repo } | { source: 'git' | 'url', url } | { source: 'directory' | 'file', path }, installLocation } }`); the account's own state is read with `claude plugin list --json` and `claude plugin marketplace list --json` under the account's env. If the MCP · Plugins stand-in writes `known_marketplaces.json` in another shape, Task 2 aligns it to this one (its tests kept green).
3. **Unverified answers are assumed and checked by hand (Task 22):** a marketplace whose source gives no argument for `claude plugin marketplace add` (no `repo`, `url` or `path`) is the one claude.ai hosts for the source — skipped as the spec says; an install that needs a confirmed marketplace command answers (with `--json`) `{ "needsConfirmation": true, "command": "<text>", "sha256": "<hex>" }` and exit 1 — ClaudeTerm also takes any failed install whose message names `--accept-command` as one; `auth status --json` holds `email`, `orgName`, `orgId`, `subscriptionType` (each also read under `emailAddress`, `organizationName`, `organizationUuid`/`organizationId`, `organizationType`).
4. **A copied transcript keeps its source's modification time** (`fs.utimes`), and equal times mean the same conversation (no copy, no refusal). Otherwise moving an unchanged conversation back would be refused as "went further" by the copy's own time. In Recent sessions a tie goes to the later root (the extra account the copy was made for).
5. **Rule B failures** (restart, view switch, `/resume`, fork, restore, opening a row whose account cannot start): the start goes on as today and the toast says `Could not copy the conversation to <account>: <reason>`. The spec defines the failure only for explicit moves, whose toast stays as written.
6. **`Open as` is offered on this device's rows only.** A remote row's account lives on its device and there is no call to open a session there on another account; `Continue as` on the opened remote tab already does it through the host, where the copy happens.
7. **IPC beyond the spec's suggestions:** the flow is read with `accounts:flow` (invoke) and followed with `ev:account-flow`; its buttons go through one `accounts:flow-action`; `accounts:check` (the Accounts page is shown), `accounts:remove-info` (the Remove dialog's counts), `accounts:show-folder` and `accounts:open-tab` (row buttons) are added. `accounts:carry-preview` also takes the target (`Carry over…` needs its running tabs for the trusted-folders lock).
8. **Copy the spec leaves open:** the step between the sign-in tab's end and `auth status`'s answer shows `Checking the sign-in…`; a row whose last check could not tell reads `Could not check the sign-in`; the confirm failure's text is `Claude Code did not say who is signed in. Try again, or cancel.`
9. **The folder name**: a Windows device name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`) gets `-account` appended on every system — the spec's rule would give a folder Windows cannot create. The email may not start with `-` (it would read as an option); it is quoted for the shell.
10. **Never overwrite what cannot be read:** an account `settings.json` or `.claude.json` that is not a JSON object fails its item (Claude Code's message is not involved) and is left as it is.
11. **A quit during a pending add** deletes the folder ClaudeTerm made for it (no half-added account across runs; the account was never saved).
12. **Board vs text:** the chat divider reads `Continued as <account>` (not the board's longer line); step 3 has one line per ticked item (the board groups the folders in one line).
13. **`HostContext.openSession` becomes async** (rule B before a session whose account cannot start opens on Main account).
14. **Onboarding (theme picker) after `auth login`** is a hand check; if it shows, Task 22 dispatches the follow-up it describes. Nothing is built for it before.

## Review Focus

1. **A sign-in left behind** — the person closes the sign-in tab, closes Settings, or quits ClaudeTerm while the browser is open: no account is saved, the folder ClaudeTerm made is gone (after a quit too), Try again works, nothing hangs. Tests: Task 8 `'a closed sign-in tab is a sign-in that did not finish'`, `'quit removes the folder of an add still waiting'`; Task 14 e2e `'Cancel during the sign-in leaves no account, no folder and no tab'`.
2. **A conversation moved back and forth** without new messages, or continued on two accounts: never refused for being "newer" by the copy's own time, never overwritten when it went further. Tests: Task 9 `'equal times are the same conversation'`, `'the copy keeps the source's modification time'`; Task 13 e2e `'moving back to Main account without new messages resumes there'`.
3. **Secrets in what is carried** — an API key in settings `env`, header tokens echoed by a failing `add-json`, `.credentials.json` beside the files: none in the account (except the server's JSON, by design), the log, a helper line or either window's DOM. Tests: Task 11 `'the settings filter drops …'`; Task 12 `'a failed add-json … masked'`, `'the source's .credentials.json is never in the account'`; Task 18 e2e `'no secret in either window'`.
4. **Odd names and folder spellings** — a name of only non-ASCII letters, `CON`, two names with the same slug, a folder that already exists, a root reached through a junction or an 8.3 name: a folder that can be made, never inside Main account's or another account's. Tests: Task 4 `'folderSlug …'`, `'accountFolder …'`, integration `'a folder inside another through a junction or a symlink clashes'`.
5. **An account that cannot start** (signed out elsewhere, its folder deleted by hand) between checks: a new tab starts on Main account with the toast, Continue as / Open as are refused, the row says so, nothing waits for `auth status`. Tests: Task 3 `'accountLaunch …'`, Task 7 `'a folder that is gone is missing …'`, Task 13 e2e `'a sign-in account that is not signed in …'`.

---

### Task 1: the shared contract — types, IPC, guards

**Files:**
- Modify: `src/shared/accounts.ts`, `src/shared/ipc.ts`, `src/shared/types.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts`; to keep the build whole: `src/main/accounts.ts` (`list()`'s declared return type becomes `Pick<AccountView, 'id' | 'name' | 'addedAt' | 'readable'>[]`), `src/main/index.ts` (`accountsView` maps each entry to a full `AccountView` with `kind: 'token', state: null, checking: false, email: null, plan: null, folder: null` and adds `main: { email: null, plan: null, folder: null }`)
- Test: `tests/unit/ipc-guards.test.ts`

**Interfaces — Produces** (every later task uses these names; nobody changes them):

```ts
// src/shared/accounts.ts (MAIN_ACCOUNT, AccountResult stay)
export type AccountKind = 'login' | 'token'
export type AccountState = 'ready' | 'signed-out' | 'missing' | 'unknown'
export interface AccountView {
  id: string; name: string; addedAt: string; kind: AccountKind
  /** a tab can start on it: a sign-in account that is ready or unknown, a token that can be read here */
  readable: boolean
  state: AccountState | null          // sign-in accounts; null for a token account
  checking: boolean                    // a sign-in account whose first check of this run has not answered
  email: string | null; plan: string | null; folder: string | null   // sign-in accounts only
}
export interface MainAccountView { email: string | null; plan: string | null; folder: string | null }
export interface AccountsView { accounts: AccountView[]; keyring: boolean; main: MainAccountView }
export const CARRY_ITEMS = ['settings', 'hooks', 'mcp', 'plugins', 'skills', 'agents', 'commands', 'memory', 'trust', 'keybindings', 'output-styles'] as const
export type CarryItem = (typeof CARRY_ITEMS)[number]
export type CarryLineItem = CarryItem | 'claudeterm'
export const CARRY_LABELS: Record<CarryLineItem, string>   // Settings, Hooks, MCP servers, Plugins, Skills, Agents, Commands, Memory, Trusted folders, Keybindings, Output styles, ClaudeTerm's tools
export interface CarryCount { item: CarryItem; count: number; names: string[] /* mcp: the first three */; marketplaces: number /* plugins */ }
export interface CarryPreview { source: string | null; sourceName: string; sourceEmail: string | null; sourceFolder: string | null; items: CarryCount[]; targetTabs: number }
export type FlowMode = 'add' | 'sign-in-again' | 'to-login' | 'carry'
export const FLOW_MODES: readonly FlowMode[]
export interface AccountBegin { mode: FlowMode; id: string | null; name: string | null; email: string | null; source: string | null; items: CarryItem[]; adopt: boolean }
export type FlowStep = 'sign-in' | 'confirming' | 'failed' | 'same-login' | 'done'
export type LineState = 'running' | 'done' | 'skipped' | 'failed'
export interface CarryLine { item: CarryLineItem; state: LineState; text: string; subs: string[] }
export interface AccountFlowView {
  mode: FlowMode; id: string; name: string; step: FlowStep
  error: string | null; lastLine: string | null              // failed: the title, and the sign-in tab's last line
  sameAs: { account: string; email: string } | null          // same-login
  who: { email: string | null; plan: string | null }; folder: string; lines: CarryLine[]
}
export type FlowAction =
  | { kind: 'cancel' | 'show-tab' | 'retry-sign-in' | 'another-login' | 'keep-login' | 'open-tab' | 'close' }
  | { kind: 'retry-item'; item: CarryLineItem }
export type PickedFolder = { ok: true; path: string; signedIn: boolean; email: string | null; plan: string | null } | { ok: false; error: string }
export interface RemoveOptions { signOut: boolean; deleteFolder: boolean }
export interface RemoveInfo { kind: AccountKind; folder: string | null; created: boolean; conversations: number; tabs: number }
export type RemoveResult = { ok: true; problems: string[] } | { ok: false; error: string }
```

`src/shared/types.ts`: `SessionSummary.account?: string | null` (the account whose folder holds the listed copy; absent or null: Main account); `RecentSession.accountName?: string | null` (the chip; null for Main account).

`src/shared/ipc.ts` `IPC`: `accountsCheck: 'accounts:check'`, `accountsCarryPreview: 'accounts:carry-preview'`, `accountsBegin: 'accounts:begin'`, `accountsFlow: 'accounts:flow'`, `accountsFlowAction: 'accounts:flow-action'`, `accountsPickFolder: 'accounts:pick-folder'`, `accountsRemoveInfo: 'accounts:remove-info'`, `accountsShowFolder: 'accounts:show-folder'`, `accountsOpenTab: 'accounts:open-tab'`, `sessionsOpenAs: 'sessions:open-as'`, `evAccountFlow: 'ev:account-flow'`. `SettingsSection` gains `'accounts' | 'add-account'` (and `isSettingsSection`). `CtApi` (preload: `invoke` / `send` / `on` like their neighbours):

```ts
checkAccounts(): void
carryPreview(source: string | null, target: string | null): Promise<CarryPreview | null>   // null: no such source
beginAccountFlow(req: AccountBegin): Promise<AccountResult>
accountFlow(): Promise<AccountFlowView | null>
accountFlowAction(a: FlowAction): void
onAccountFlow(cb: (view: AccountFlowView | null) => void): Unsubscribe
pickAccountFolder(): Promise<PickedFolder | null>            // null: the dialog was cancelled
accountRemoveInfo(id: string): Promise<RemoveInfo | null>
removeAccount(id: string, opts?: RemoveOptions): Promise<RemoveResult>   // was Promise<AccountResult>
showAccountFolder(id: string | null): void                   // null: Main account's
openAccountTab(id: string | null): void                      // a Claude tab in the default folder, the main window brought forward
openSessionAs(sessionId: string, account: string | null): void
```

`src/main/ipc-guards.ts`: `isCarryItem`, `isCarryLineItem`, `isAccountBegin` (mode in `FLOW_MODES`; `id` null or 1–64 chars; `name` null or ≤ 200; `email` null or ≤ 254; `source` null or 1–64; `items` an array of distinct `isCarryItem`; `adopt` boolean), `isFlowAction`, `isRemoveOptions` (undefined, or both flags boolean).

- [ ] **Step 1: Write the failing tests** in `ipc-guards.test.ts`: `'isAccountBegin takes each mode's request and refuses a wrong mode, a repeated or unknown item, a name over 200 characters and an email over 254'`; `'isFlowAction takes each action and a retry of a carry line, and refuses an unknown kind or item'`; `'isRemoveOptions takes both flags or nothing'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/ipc-guards.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** it, `npm run typecheck`, `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

---

## Stream A (accounts)

### Task 2: the stand-in learns `auth`, `mcp get` / `mcp add`, a confirmed install, and logs its environment

**Files:**
- Modify: `tests/fixtures/fake-claude/fake-claude.ts`, `tests/fixtures/fake-claude/install.ts` (add only; existing behaviour unchanged), `tests/fixtures/chat/README.md` (a section "Accounts: scripted, not recorded" — one line per option, "assumed from Claude Code 2.1.322's help output; nothing recorded")
- Create: `tests/fixtures/accounts.ts` (no Playwright import: the integration tests use it too), `tests/e2e/account-helpers.ts` (re-exports it)
- Test: `tests/integration/fake-claude.int.test.ts`

**Interfaces — Produces** (`install.ts`):

```ts
export const FAKE_CREDENTIAL = 'fake-credential-never-shown-0001'   // inside every .credentials.json the stand-in writes
// FakeScript gains
auth?: Record<string, FakeAuth>        // by the folder's name: basename(CLAUDE_CONFIG_DIR)
export interface FakeAuth {
  email?: string; org?: string; orgUuid?: string; type?: string   // defaults: `<folder name>@example.com`, 'Example Team', a UUID made from the name, 'claude_team'
  gate?: string           // auth login waits until <CLAUDE_CONFIG_DIR>/<gate> exists
  fail?: string           // auth login: stderr `Login failed: <fail>`, exit 1, nothing written
  status?: 'garbage' | 'hang'   // auth status: `Welcome to Claude Code` and exit 0, or never answers
}
// FakePlugin gains
installCommand?: string   // its marketplace runs this to install it
```

Rules (what Claude Code 2.1.322 is assumed to do; ruling 3):
- Every run's first log line becomes `{ argv, pid, env: { config: CLAUDE_CONFIG_DIR ?? null, oauthToken: boolean, refreshToken: boolean, apiKey: boolean, authToken: boolean } }` (whether `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` are set — never their values).
- `auth login [--claudeai] [--email <e>]`: stdout `Opening the browser to sign in…` and `If it did not open, use this link: https://claude.ai/oauth/authorize?fake=1`; the gate; then `<config>/.credentials.json` = `{ "claudeAiOauth": { "accessToken": "<FAKE_CREDENTIAL>-<folder name>" } }` (mode 0600) and `.claude.json` `oauthAccount: { emailAddress, organizationName, organizationUuid, organizationType }` (other keys kept); stdout `Login successful.`; exit 0.
- `auth status [--json | --text]`: signed in (both files) → `{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "configDirectory": <config>, "email", "orgId", "orgName", "subscriptionType" }` (`claude_team` → `team`, `claude_max` → `max`, `claude_pro` → `pro`, `claude_enterprise` → `enterprise`), exit 0; else `{ "loggedIn": false, "authMethod": "none", "configDirectory": <config> }`, exit 1; `--text`: `Logged in as <email>` / `Not logged in`. `auth logout`: removes `.credentials.json` and `oauthAccount`, stdout `Successfully logged out`, exit 0.
- `mcp get <name>`: a user-scope server of `<config>/.claude.json` → stdout `<name>:` then `  Scope: User config`, `  Type: <type>`, `  Command: <command>`, `  Args: <args joined by spaces>` (http: `  URL: <url>`), exit 0; none → stderr `No MCP server found with name: <name>`, exit 1. `mcp add [-s|--scope s] [-t|--transport t] [-e|--env K=V]… [-H|--header 'K: V']… <name> <commandOrUrl> [args…]` (options before `--` in any order, every word after `--` positional) → stdio `{ type: 'stdio', command, args, env }` or http `{ type: 'http', url, headers }` in the scope (default `local`), stdout `Added <type> MCP server <name> to <scope> config`.
- `plugin install` of a plugin with `installCommand`, without `-y` or `--accept-command <sha>`: with `--json` stdout `{"needsConfirmation":true,"command":"<installCommand>","sha256":"<sha256 of it>"}`; stderr `This plugin's marketplace runs a command to install it: confirm with -y or --accept-command <sha256>`; exit 1. With `-y` it installs as any plugin.
- `known_marketplaces.json` as ruling 2 says (align the MCP · Plugins stand-in if it differs).

`tests/fixtures/accounts.ts` holds the constants, `signedIn`, `trust`, `readLog(file): Record<string, unknown>[]`, `runs` and `hashTree`; `tests/e2e/account-helpers.ts` re-exports them and adds the rest (invented data only):

```ts
export const WORK = '0b6f3c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b', STUDIO = '7e1d2c3b-4a5f-4e6d-9c8b-7a6f5e4d3c2b', CI_BOT = '1c7a4d3f-5e6b-4f7a-9b8c-0d1e2f3a4b5c'
export const CI_TOKEN = 'e2e-token-ci-000000000001', SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8', MAIN_CREDENTIAL = 'main-credential-never-copied-0001'
export const MAIN_WHO = { emailAddress: 'main@example.com', organizationName: 'Example', organizationUuid: '00000000-0000-4000-8000-000000000001', organizationType: 'claude_max' }
export interface AccountsApp extends Launched { work: string; config: string; root: string; log(): Record<string, unknown>[] }
/** the app on the stand-in: Main account at <root>/main (CLAUDE_CONFIG_DIR, MAIN_WHO, `work` trusted, a .credentials.json holding MAIN_CREDENTIAL),
 *  accounts under <root>/accounts (CLAUDETERM_ACCOUNTS_ROOT), accounts.json version 2 of `accounts`, script.json and fake-claude.log in <root> */
export function launchAccounts(o?: { accounts?: object[]; script?: FakeScript; view?: 'terminal' | 'chat'; env?: Record<string, string>; main?: (config: string) => void }): Promise<AccountsApp>
export function loginEntry(id: string, name: string, folder: string, created?: boolean): object   // created default true
export function tokenEntry(id: string, name: string, token: string): object
export function signedIn(folder: string, who?: Partial<typeof MAIN_WHO>): void   // what auth login writes (default Work's defaults)
export function trust(config: string, folder: string): void                       // projects[realpath(folder)].hasTrustDialogAccepted = true
export function runs(log: () => Record<string, unknown>[]): { argv: string[]; config: string | null; oauthToken: boolean; apiKey: boolean }[]
export function hashTree(dir: string): string                                      // sha256 over every file's relative path and bytes, sorted
export function settingsWindow(app: ElectronApplication, page: Page, section?: string): Promise<Page>   // ct.openSettingsWindow(section), its page
```

- [ ] **Step 1: Write the failing tests** (`fake-claude.int.test.ts`, its spawn helper): `'auth login writes a sign-in into CLAUDE_CONFIG_DIR, auth status reads it, logout removes it'` (folder `work`: status first exit 1 `loggedIn: false`; login exit 0, `.credentials.json` holds `FAKE_CREDENTIAL`, `.claude.json` `oauthAccount.emailAddress === 'work@example.com'`, `organizationType === 'claude_team'`; status exit 0 with `authMethod: 'claude.ai'`, `email: 'work@example.com'`, `subscriptionType: 'team'`, `configDirectory` the folder; `--text` → `Logged in as work@example.com`; logout → status exit 1, `.credentials.json` gone, the other `.claude.json` keys kept); `'auth login waits for its gate; a scripted failure exits 1 and writes nothing'`; `'auth status can answer garbage, or never'` (hang: still running after 2 s, then killed); `'mcp add writes the server where Claude Code keeps it and mcp get names it'` (`mcp add --scope user claudeterm -e ELECTRON_RUN_AS_NODE=1 -- /x/electron /x/server.js` → `mcpServers.claudeterm` `{ type: 'stdio', command: '/x/electron', args: ['/x/server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }`; `mcp get claudeterm` stdout holds `/x/electron` and `/x/server.js`; `mcp get nope` exit 1 with its message); `'a plugin whose marketplace runs a command is installed only with -y'`; `'every run logs its config folder and whether a token or a key was set, never their values'` (the log text lacks the values).
- [ ] **Step 2: Run** `npx vitest run tests/integration/fake-claude.int.test.ts`. Expected: the new tests FAIL, the old ones PASS.
- [ ] **Step 3: Implement** it, `account-helpers.ts`, the README section.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 3: `accounts.json` version 2 and the sign-in launch — `src/main/accounts.ts`

**Files:**
- Modify: `src/main/accounts.ts`
- Test: `tests/unit/accounts.test.ts`, `tests/integration/accounts.int.test.ts`

**Interfaces — Produces:**

```ts
export type StoredAccount =
  | { kind: 'token'; id: string; name: string; addedAt: string; token: string; encrypted: boolean }
  | { kind: 'login'; id: string; name: string; addedAt: string; folder: string; created: boolean }
export interface AccountEntry { id: string; name: string; addedAt: string; kind: AccountKind; folder: string | null; created: boolean; readable: boolean /* token: decrypts here; login: true */ }
export function parseAccounts(text: string): StoredAccount[] | null
export function loginEnv(folder: string): EnvPatch
export type LaunchAccount = { kind: 'token'; token: string | null } | { kind: 'login'; folder: string; startable: boolean }
export function accountLaunch(id: string | null, find: (id: string) => LaunchAccount | null): AccountLaunch
// AccountStore
list(): AccountEntry[]
folderOf(id: string): string | null
kindOf(id: string): AccountKind | null
addLogin(a: { id: string; name: unknown; folder: string; created: boolean }): AccountResult
toLogin(id: unknown, name: unknown, folder: string, created: boolean): AccountResult   // a token account becomes a sign-in one: same id, the token gone, one write
```

Rules: version 1 → every entry `kind: 'token'`; version 2 → `kind` `login` (`folder` absolute, ≤ 4 096 chars, no NUL; `created` boolean) or `token` (as today); any other kind, shape or a repeated id is skipped; another version → not an accounts file (kept aside as today). Every save writes `{ version: 2, accounts }`; no email, plan or credential is stored. `loginEnv(folder)` = `{ set: { CLAUDE_CONFIG_DIR: folder }, unset: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] }`. `accountLaunch`: null id → Main; `find` null, a token that cannot be read or a login that is not `startable` → `{ account: null, unavailable: true }`; a token → `tokenEnv`; a login → `loginEnv(folder)`. `token(id)` is null for a sign-in account; `keyring()` asks the vault only while a token account exists.

- [ ] **Step 1: Write the failing tests:** `'parseAccounts reads version 1 as token accounts'`; `'parseAccounts reads both kinds of version 2 and skips the entries of a wrong shape'` (a login without a folder, with a relative folder, with `created: 'yes'`, a kind `sso`, a repeated id); `'a version other than 1 or 2 is not an accounts file'`; `'the first change writes version 2 and keeps the version 1 tokens'`; `'addLogin saves a sign-in account with its folder and nothing else'` (the written text has no `token`, no `@`); `'toLogin keeps the id and drops the token in the same write'` (one `write` call; the entry `kind: 'login'`); `'loginEnv sets the folder and removes every token and key Claude Code would use first'` (exact patch); `'accountLaunch: a sign-in account gets its folder, one that cannot start falls back to Main account'` — Review Focus 5; `'the keyring is asked only while a token account exists'`. Integration: `'accounts.json version 2 is replaced in one step and readable only by the user'` (mode 0600 off Windows).
- [ ] **Step 2: Run** `npx vitest run tests/unit/accounts.test.ts tests/integration/accounts.int.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it (callers in `index.ts` keep compiling: `accountLaunch`'s `find` there is `(id) => accounts.kindOf(id) === 'token' ? { kind: 'token', token: accounts.token(id) } : null` until Task 13).
- [ ] **Step 4: Run** them and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 4: folders, the sign-in command, who is signed in — `src/main/account-login.ts`

**Files:**
- Create: `src/main/account-login.ts`
- Modify: `src/main/claude-plan.ts` (export `planOf`; `planName` uses it)
- Test: `tests/unit/account-login.test.ts`, `tests/integration/account-login.int.test.ts`, `tests/unit/claude-plan.test.ts`

**Interfaces — Produces:**

```ts
export const ACCOUNTS_ROOT_ENV = 'CLAUDETERM_ACCOUNTS_ROOT'
/** the override when set; with CLAUDETERM_TEST=1 and none, <dataDir>/claude-accounts; else <home>/.claude-accounts (never from CLAUDE_CONFIG_DIR) */
export function accountsRoot(env: NodeJS.ProcessEnv, home: string, dataDir: string): string
export function folderSlug(name: string): string
export function accountFolder(root: string, name: string, taken: (path: string) => boolean): string   // root/slug, else slug-2, slug-3…
export function checkEmail(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string }
export function signInCommand(command: string, family: ShellFamily, email: string | null): string
export interface Identity { email: string | null; orgName: string | null; orgUuid: string | null; plan: string | null }
export const NO_IDENTITY: Identity
export type AuthStatus = { state: 'signed-in'; identity: Identity } | { state: 'signed-out' } | { state: 'unknown'; reason: string }
export function parseAuthStatus(run: { code: number; stdout: string }): AuthStatus
export function identityOf(claudeJson: string | null): Identity              // oauthAccount
export function mergeIdentity(first: Identity, then: Identity): Identity     // first's fields, then's where first has none
export function sameLogin(a: Identity, b: Identity): boolean
/** async: the real path (canonicalFolder), or for a path that does not exist yet its parent's real path joined with its name */
export function canonical(path: string): Promise<string>
/** candidate and others canonical: whether the candidate is one of them, inside one, or holds one */
export function clashes(candidate: string, others: string[]): boolean
// claude-plan.ts
export function planOf(type: unknown): string | null   // claude_max | max → 'Max plan', pro, team, enterprise likewise; else null
```

Rules: `folderSlug` — lowercase, non-ASCII dropped, every run of other characters than `a-z0-9` → `-`, `-` trimmed at both ends, cut to 32 then trimmed again; empty → `account`; a Windows device name → `<name>-account` (ruling 9). `checkEmail` — trimmed; empty → `null`; else ≤ 254 chars, only letters, digits and `. _ % + - @`, exactly one `@` with text on both sides, not starting with `-`; error `Enter an email address, or leave it empty`. `signInCommand` — `<command> auth login --claudeai`, plus ` --email <quoteForShell(family, email)>`. `parseAuthStatus` — exit 0 with a JSON object (`jsonOutput`) whose `authMethod` is `claude.ai` → signed-in (identity from `email`/`emailAddress`, `orgName`/`organizationName`, `orgId`/`organizationUuid`/`organizationId`, plan `planOf(subscriptionType ?? organizationType)`); exit 0 with another `authMethod`, or exit 1 → signed-out; anything else (no JSON, another code) → unknown. Every field checked: strings without control characters, email ≤ 254 and holding `@`, the others ≤ 200; else null. `sameLogin` — both emails known and equal ignoring case, and: both org uuids known → equal; else both org names known → equal; else true.

- [ ] **Step 1: Write the failing tests:** `'accountsRoot: the override, the test folder, the home folder'`; `'folderSlug'` — Review Focus 4 (`Work` → `work`; `My  Work!` → `my-work`; `Café Ü` → `caf`; `Работа` → `account`; `--x--` → `x`; 40 letters → 32; `CON` → `con-account`; `Com1` → `com1-account`); `'accountFolder takes the next free name'` (`work` taken → `work-2`; `work-2` too → `work-3`); `'checkEmail'` (`''` → null; `work@example.com` ok; `a b@x`, `-a@x`, `a@`, `a@b@c`, 255 chars → the error); `'signInCommand quotes the email for each shell'` (`claude auth login --claudeai --email 'w@example.com'` for powershell and bash, `"w@example.com"` for cmd; no email → `claude auth login --claudeai`); `'parseAuthStatus: signed in, signed out, another method, garbage, missing and wrong fields'` (the stand-in's JSON → `{ email: 'work@example.com', orgName: 'Example Team', orgUuid: <its id>, plan: 'Team plan' }`; `email: 42` → null); `'identityOf reads oauthAccount and nothing else'`; `'sameLogin: same email and organization; another organization is another login; no organization known compares the emails'`. Integration: `'a folder inside another through a junction or a symlink clashes'` — Review Focus 4 (`symlinkSync(target, link, 'junction')`; `clashes(await canonical(join(link, 'work')), [await canonical(target)])` is true; a sibling is false); `'canonical of a folder that does not exist yet uses its parent's real path'`. `claude-plan.test.ts`: `'planOf names the plans of both spellings'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/account-login.test.ts tests/integration/account-login.int.test.ts tests/unit/claude-plan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 5: the run-once sign-in tab, the conversation's move between processes, `Continued as`

**Files:**
- Modify: `src/main/profiles.ts`, `src/main/tab-manager.ts`, `src/main/chat/chat-hub.ts`
- Test: `tests/unit/profiles.test.ts`, `tests/unit/tab-manager.test.ts`, `tests/unit/chat-hub.test.ts`

**Interfaces — Produces:**

```ts
// profiles.ts
export function buildLaunch(profile: ProfileDef, kind: TabKind, claude: ClaudeLaunch | null, opts?: { once?: boolean }): LaunchSpec
// tab-manager.ts
export interface SignInLaunch { folder: string; email: string | null }
// LaunchRequest gains:  signIn?: SignInLaunch
// open(req, opts: { activate?: boolean; setupToken?: boolean; signIn?: SignInLaunch })
export interface ConversationMove { tabId: string; sessionId: string; from: string | null; to: string | null; explicit: boolean; stage: 'check' | 'copy' }
// TabManagerDeps gains
moveConversation?(m: ConversationMove): Promise<boolean>
onTabRestarting?(tabId: string, continuedAs?: { account: string | null }): void
// chat-hub.ts
restarting(tabId: string, divider?: string): void   // the divider the restart ends with; 'Session restarted' when none is given
```

Rules:
- `once`: powershell `['-NoLogo', '-Command', line]`; cmd `/c <line>`; bash `['--login', '-i', '-c', line]`; zsh `['-l', '-i', '-c', line]`; fish `['-l', '-c', line]` — the shell ends with the command.
- A sign-in tab: `resolveLaunch` gets `signIn`; the tab is `kind: 'shell'`, `view: null`, opened without activating when `activate: false`; `snapshot()` leaves it out (a `transient` flag on its record).
- `switchAccount` with a conversation to resume: after the strict launch resolves, `moveConversation({ …, from: <tab's account>, to: account, explicit: true, stage: 'check' })` — false → return false, nothing changed. Then `onTabRestarting(tabId, { account })`, the old process ends, and before the start `moveConversation({ …, stage: 'copy' })` — false → the launch is resolved again for the old account (not strict, same resume) and the tab starts on it; `switchAccount` answers false. While the copy runs the tab counts as restarting.
- Rule B, `explicit: false, from === to === <tab's account>, stage: 'copy'`, after the old process has exited and before the start: `restart`, `setView`, `resumeSession` (its new session id); `fork` before it opens the new tab (the head's tab id, the fork's `from`). Its answer is not looked at.
- `ChatHub.restarting(tabId, divider)` keeps the text per tab; the restart's end draws it instead of `Session restarted`.

- [ ] **Step 1: Write the failing tests.** `profiles.test.ts`: `'a run-once launch ends with its command in every shell'` (exact args above). `tab-manager.test.ts` (its fakes; record events in one array): `'a sign-in tab runs its launch in the background and is left out of the snapshot'`; `'a switch of account checks the move before ending the process; refused, nothing changes'` (no kill, no spawn, account unchanged, false); `'the copy of a switch runs after the old process has exited and before the new one starts'` (order `kill`, `move copy`, `spawn`); `'a failed copy starts the tab again on the account it was on'` (the last `resolveLaunch` has the old account, `info.account` old, false); `'a restart, a view switch and another conversation bring it by rule B before the start'`; `'a fork brings its head's conversation before it opens'`; `'a switch of account tells the restart whom it continues as'`. `chat-hub.test.ts`: `'a restart begun with a divider ends with it'` (`restarting(id, 'Continued as Work')` → the divider `Continued as Work`; a later plain restart → `Session restarted`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/profiles.test.ts tests/unit/tab-manager.test.ts tests/unit/chat-hub.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 6 (bug fix): `runClaude` drops the environment of a `.cmd` shim; `ensureMcpRegistered` per account

**Files:**
- Modify: `src/main/mcp-registrar.ts`
- Test: `tests/unit/mcp-registrar.test.ts`, `tests/integration/mcp-registrar.int.test.ts` (new)

**Interfaces — Produces:**

```ts
export function runClaude(run: Runner, cli: ClaudeCli, args: string[], patch?: EnvPatch): Promise<RunResult>
export function ensureMcpRegistered(o: { run: Runner; execPath: string; serverScript: string; log(message: string): void
  resolve?: () => Promise<ClaudeCli | null>; env?: EnvPatch
  exec?: (args: string[]) => Promise<RunResult> }): Promise<RegisterResult>   // exec: every command through it, claude never looked up
```

Rules: the environment of a run is `applyEnvPatch(cli.env ?? process.env (as strings), patch)` when a patch is given, else `cli.env` as today; both branches pass it (the `.cmd` branch as `{ verbatim: true, env }`).

- [ ] **Step 1: Write the failing proving test** `'a .cmd shim gets the account's environment too'`: `runClaude(fakeRun, { file: 'C:\\x\\claude.cmd', viaCmd: true }, ['mcp', 'get', 'claudeterm'], loginEnv('C:\\acc\\work'))` with `process.env.CLAUDE_CODE_OAUTH_TOKEN` set for the test → the recorded options have `verbatim: true`, `env.CLAUDE_CONFIG_DIR === 'C:\\acc\\work'` and no `CLAUDE_CODE_OAUTH_TOKEN`. Also `'a native exe and a Linux claude get the patch over their environment'` (cli.env's `PATH` kept), `'ensureMcpRegistered with exec runs every command through it and never looks claude up'`. Integration: `'ensureMcpRegistered registers claudeterm in an account's folder through the stand-in'` (`resolve` → `{ file: installFakeClaude(bin), viaCmd: WIN }`, `run: execRunner`, `env: loginEnv(acc)` → `registered`, `<acc>/.claude.json` `mcpServers.claudeterm.command === execPath`; a second run → `already`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/mcp-registrar.test.ts tests/integration/mcp-registrar.int.test.ts`. Expected: FAIL — `'a .cmd shim …'` fails with `env` undefined (copy this output into the report: it is the PR's proof).
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 7: the state of each sign-in account — `src/main/account-checks.ts`

**Files:**
- Create: `src/main/account-checks.ts`
- Test: `tests/unit/account-checks.test.ts`

**Interfaces — Consumes:** Task 4. **Produces:**

```ts
export const STATUS_TIMEOUT_MS = 15_000
export const RECHECK_MS = 60_000
export interface AccountCheck { state: AccountState; checking: boolean; identity: Identity; at: number | null }
export interface AccountChecksDeps {
  status(folder: string): Promise<AuthStatus>      // auth status --json with the account's env, 15 s; unknown on a timeout or a CliError
  identity(folder: string): Promise<Identity>      // the folder's .claude.json
  isDir(folder: string): Promise<boolean>
  now(): number
  changed(): void
}
export class AccountChecks {
  constructor(d: AccountChecksDeps)
  get(id: string): AccountCheck                     // before any answer: unknown, checking true
  check(id: string, folder: string): Promise<AccountCheck>   // one at a time per account: an ask while one runs gets its answer
  checkStale(list: { id: string; folder: string }[]): void   // those not checked within RECHECK_MS
  confirmed(id: string, identity: Identity): void   // a sign-in just confirmed: ready, no CLI run
  forget(id: string): void
}
```

Rules: a folder that is not a directory → `missing`, no CLI; signed-in → `ready` with `mergeIdentity(status, .claude.json)`; signed-out → `signed-out`; unknown → `unknown` with the `.claude.json` identity. `changed()` after an answer that changes the state, `checking` or the identity.

- [ ] **Step 1: Write the failing tests** (fake deps): `'a folder that is gone is missing, without running Claude Code'` — Review Focus 5; `'signed in is ready with who and the plan, from .claude.json where auth status has none'`; `'exit 1 is signed out'`; `'a timeout or an answer that cannot be read is unknown'`; `'an account is unknown and checking until its first answer'`; `'one check at a time per account: a second ask gets the running one's answer'` (status called once); `'checkStale checks only the accounts not checked within a minute'`; `'changed is told when something changed, not when nothing did'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/account-checks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 8: the add flow and removal — `src/main/account-flow.ts`, `src/main/account-remove.ts`

**Files:**
- Create: `src/main/account-flow.ts`, `src/main/account-remove.ts`
- Test: `tests/unit/account-flow.test.ts`, `tests/unit/account-remove.test.ts`

**Interfaces — Consumes:** Tasks 1, 3, 4. **Produces:**

```ts
export interface FlowTarget { id: string; name: string; folder: string }
export interface AccountFlowDeps {
  store: Pick<AccountStore, 'list' | 'addLogin' | 'toLogin'>
  root(): string; mainFolder: string | null
  canonical(path: string): Promise<string>; isDir(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>                 // recursive; mode 0700 off Windows
  removeCreated(path: string): Promise<void>         // a folder this flow made
  openSignInTab(name: string, folder: string, email: string | null): string | null   // its tab id
  closeTab(tabId: string): void; showTab(tabId: string): void
  status(folder: string): Promise<AuthStatus>; identity(folder: string): Promise<Identity>
  logout(folder: string): Promise<boolean>
  others(except: string | null): Promise<{ label: string; identity: Identity }[]>   // Main account first, then the other sign-in accounts
  carry(item: CarryItem, target: FlowTarget, source: string | null): Promise<CarryLine>
  register(folder: string): Promise<CarryLine>        // ClaudeTerm's tools
  tabsOn(id: string): number
  settingsOpen(): boolean; toast(message: string): void
  publish(view: AccountFlowView | null): void; accountsChanged(): void
  confirmed(id: string, identity: Identity): void     // AccountChecks.confirmed
  openClaudeTab(id: string): void; newId(): string
}
export class AccountFlow {
  constructor(d: AccountFlowDeps)
  view(): AccountFlowView | null
  begin(req: AccountBegin): Promise<AccountResult>
  pick(path: string): Promise<PickedFolder>           // the folder main's dialog returned; kept for begin({ adopt: true })
  action(a: FlowAction): Promise<void>
  tabOutput(tabId: string, data: string): void        // keeps the last non-empty line: control sequences stripped, ≤ 200 chars
  tabEnded(tabId: string): Promise<void>              // its process ended, or the tab was closed
  quit(): Promise<void>
}
// account-remove.ts
export interface RemoveDeps { entry(id: string): AccountEntry | null; tabsOn(id: string): number; logout(folder: string): Promise<string | null /* its error */>
  remove(id: string): AccountResult; changed(): void; trash(folder: string): Promise<void>; others(id: string): Promise<string[]> /* Main's and the other accounts' canonical folders */ }
export function removeAccount(id: string, o: RemoveOptions, d: RemoveDeps): Promise<RemoveResult>
```

Rules (spec "The add flow"; exact copy):
- `begin` — one flow at a time: `An account is being added: finish or cancel it first`. `add`: `checkAccountName(name, all names)`, `checkEmail`; the folder `accountFolder(root, name, taken)` (taken: it exists, or an account has it by `pathKey`); `clashes` with Main account's folder or another account's → `ClaudeTerm cannot make a folder for the account inside another account's folder: <path>`; `mkdir` (error `Cannot make the folder <path>: <message>`); the pending account (a `newId()`) is kept in memory only; `openSignInTab(name, folder, email)` (null → the folder removed, `Cannot open the sign-in tab`); step `sign-in`, with no time limit (the person cancels). `to-login`: a token account's id; its name (editable) checked against the others; a new folder as for `add`. `sign-in-again`: a sign-in account's own folder (not created; a folder that is gone → `Its folder is gone: <path>`). `carry`: a sign-in account; no sign-in, straight to `done` with its lines as after a sign-in. `adopt: true`: the folder `pick` kept (`Pick the folder first` without one), `created: false`; signed in → saved at once, then `done`; not → the sign-in tab in it. A wrong id or kind → `No such account`.
- `pick(path)`: not a directory → `Not a folder`; Main account's (same canonical path) → `This is Main account's folder`; an account's → `This folder is already the account "<name>"`; else `status` → `{ ok: true, path, signedIn, email, plan }`.
- `tabEnded` of the flow's tab in `sign-in` → step `confirming`, `status(folder)`: signed-in → the tab closed, identity `mergeIdentity(status, identity(folder))`; unknown → step `failed`, error `Could not confirm the sign-in`, nothing saved (binding); signed-out → step `failed`, error `The sign-in did not finish`, `lastLine` kept, the exited tab left open.
- Same login: `sameLogin` with each of `others(id)` whose email is known (no email on either side: no question) → step `same-login`, `sameAs: { account: <label>, email }`. `another-login` → `logout(folder)`, a new sign-in tab, step `sign-in`; `keep-login` → saved.
- Saved: `add` → `addLogin`; `to-login` → `toLogin` (same id, token gone, one write); `sign-in-again` saves nothing; then `accountsChanged()`, `confirmed(id, identity)`, step `done` with `who`, a `running` line per ticked item in `CARRY_ITEMS` order then `claudeterm`; the items run one after another in this order: settings, hooks, skills, agents, commands, output-styles, memory, keybindings, mcp, plugins, then `register` (claudeterm), then trust; each line replaced by its answer; one failing does not stop the others. Saved while `settingsOpen()` is false → `toast('Account "<name>" is ready: signed in as <email>')` (no email: `Account "<name>" is ready`).
- `trust` while `tabsOn(id) > 0` in `carry` mode is not run: line state `skipped`, text `Close the tabs on <name> to carry over trusted folders` (main checks again what the helper showed).
- Actions: `cancel` in `sign-in` / `confirming` / `failed` / `same-login` — closes the tab, `removeCreated(folder)` when the flow made it (`add`, `to-login`, never `sign-in-again` or an adopted folder), forgets the pending account (nothing saved), publishes null; in `done` it only forgets the flow. `retry-sign-in` closes the old tab and opens a new one; `show-tab` → `showTab`; `retry-item` reruns that item; `open-tab` → `openClaudeTab(id)` and forgets the flow; `close` forgets it. A tab the flow closes itself is not a sign-in that ended.
- `quit()` — a pending add whose folder the flow made: `removeCreated(folder)` (ruling 11).
- `removeAccount` — token: `remove` as today. Sign-in: `signOut` or `deleteFolder` with `tabsOn(id) > 0` → `{ ok: false, error: 'Close the <n> tabs on <name> to remove its folder too' }`; `deleteFolder` only when `created` and the folder clashes with none of `others(id)`; in order: `logout` (when `signOut`; its error → `Could not sign out: <message>` in `problems`), `remove`, `changed()`, `trash` (its error → `Could not move the folder to the trash: <message>`); the account is removed whatever `problems` holds.

- [ ] **Step 1: Write the failing tests** (`account-flow.test.ts`, a fake for every dep; the views published in order): `'begin add makes the folder, keeps the account pending and opens the sign-in tab in the background'` (folder `<root>/work`; `store.addLogin` not called; step `sign-in`); `'a second begin while one runs is refused'`; `'a name or an email that is not valid is refused before any folder is made'`; `'signed in: the tab closes, the account is saved, the items run in order, ClaudeTerm's tools, trusted folders last'` (the order of `carry` / `register` calls); `'a tab that ends without a sign-in did not finish: its last line, the tab left open; Try again opens a new one'`; `'a closed sign-in tab is a sign-in that did not finish'` — Review Focus 1; `'unknown right after the sign-in is a failure and saves nothing'`; `'the same login as Main account asks; Sign in with another account signs out and opens a new tab; Keep it anyway saves'`; `'no email known asks nothing'`; `'Cancel closes the tab, deletes the folder it made and saves nothing'`; `'Cancel of a sign-in again or of an adopted folder deletes nothing'`; `'with the Settings window closed the ready account is toasted'`; `'to-login keeps the id and drops the token in one write'`; `'pick refuses Main account's folder, an account's folder and a file; a signed-in folder is added at once with created false'`; `'carry runs only the ticked items'`; `'retry-item runs that item again'`; `'quit removes the folder of an add still waiting'` — Review Focus 1. `account-remove.test.ts`: `'a sign-in account with sign-out and its folder: logout, removal, then the trash, in that order'`; `'with tabs on it the folder and the sign-out are refused'`; `'a folder ClaudeTerm did not make is never deleted'`; `'a failed logout or move is reported and the account is still removed'`; `'a token account is removed as before'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/account-flow.test.ts tests/unit/account-remove.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** them.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

---

## Stream B (conversations, carry-over)

### Task 9: copy rules A and B — `src/main/transcript-move.ts`

**Files:**
- Create: `src/main/transcript-move.ts`
- Test: `tests/unit/transcript-move.test.ts`, `tests/integration/transcript-move.int.test.ts`

**Interfaces — Produces:**

```ts
export interface TranscriptRoot { account: string | null; projects: string }        // <config>/projects; Main account and token accounts: null
export interface TranscriptCopy { account: string | null; projects: string; project: string; path: string; mtimeMs: number }
export type MoveDecision = { kind: 'none' } | { kind: 'copy'; from: TranscriptCopy } | { kind: 'refuse'; newer: TranscriptCopy }
export function decideMove(o: { explicit: boolean; target: string /* projects folder */; source: TranscriptCopy | null; copies: TranscriptCopy[] }): MoveDecision
export function findCopies(roots: TranscriptRoot[], sessionId: string): Promise<TranscriptCopy[]>   // <root>/<project>/<id>.jsonl of every project folder
export function copyAt(path: string | null | undefined, copies: TranscriptCopy[]): TranscriptCopy | null   // the copy a reported transcript path is (pathKey)
export function copyTranscript(from: TranscriptCopy, targetProjects: string): Promise<void>     // throws an Error with the system's message
```

Rules: rule A (`explicit`) — the source is `source`, else the newest copy; none → `none`; the source's `projects` equals `target` by `pathKey` → `none` (Main ↔ token); the target's copy (newest under `target`): none or older → `copy`; newer → `refuse`; equal → `none` (ruling 4). Rule B — the target has a copy → `none`; else the newest copy → `copy`; none → `none`. `copyTranscript` — into `<targetProjects>/<from.project>/` (the source's own folder name, never recomputed): first the `<id>/` folder when present (copied to `.<id>.ct-<random>`, the old one renamed aside, the new one renamed in, the old one removed), then `<id>.jsonl` to `.<id>.jsonl.ct-<random>`, `utimes` to the source's times, renamed into place (the commit point); a failure removes its temporary names and leaves the target as it was.

- [ ] **Step 1: Write the failing tests.** Unit: `'rule A: no copy there is copied, an older one replaced, a newer one refused'`; `'rule A: the same folder copies nothing'`; `'equal times are the same conversation'` — Review Focus 2; `'rule A without a reported path takes the newest copy'`; `'rule B: the account's own copy is used; with none the newest is copied; with none anywhere nothing'`; `'copyAt finds the copy of a path in another spelling'`. Integration (temp folders): `'the transcript and its folder go under the source's project folder name'` (a project folder name that is not the munged cwd is kept); `'the copy keeps the source's modification time'` — Review Focus 2; `'an older copy and its folder are replaced'`; `'a failed copy leaves no temporary file and the target as it was'` (the target project path is a file); `'findCopies finds every account's copy and skips a missing root'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/transcript-move.test.ts tests/integration/transcript-move.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 10: Recent sessions over every account — `src/main/session-history.ts`

**Files:**
- Modify: `src/main/session-history.ts`
- Test: `tests/unit/session-history.test.ts`

**Interfaces — Consumes:** `TranscriptRoot` (Task 9). **Produces:** `new SessionHistory(roots: () => TranscriptRoot[], fs?: HistoryFs, alsoInteractive?: (id: string) => boolean)`; every listed summary has `account` (null for Main account). `claudeProjectsDir` stays.

Rules: the transcripts of every root, read as today; one session id under several roots → the copy with the latest `mtimeMs` (a tie: the later root — ruling 4), with its root's account; the limit and the starred rule apply after that. The cache stays keyed by path.

- [ ] **Step 1: Write the failing tests** (the file's fake fs): `'lists the sessions of every root with their account'`; `'one id under two roots is listed once: the newest copy, with its account'`; `'a tie goes to the later root'`; `'a missing root lists nothing and the others still list'`. Update the existing expectations for the new `account: null`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/session-history.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it (`index.ts` passes `() => [{ account: null, projects: claudeProjectsDir(process.env, homedir()) }]` until Task 13; that one line of `index.ts` is this task's).
- [ ] **Step 4: Run** it and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 11: the carry-over planner — `src/main/account-carry.ts` (pure)

**Files:**
- Create: `src/main/account-carry.ts`
- Test: `tests/unit/account-carry.test.ts`

**Interfaces — Produces:**

```ts
export const SETTINGS_DROPPED = ['hooks', 'enabledPlugins', 'extraKnownMarketplaces', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod', 'forceLoginOrgUUID'] as const
export const ENV_DROPPED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const
export type FolderItem = 'skills' | 'agents' | 'commands' | 'output-styles' | 'memory' | 'keybindings'
export const ITEM_PATHS: Record<FolderItem, string[]>   // skills/, agents/, commands/, output-styles/; memory: CLAUDE.md, rules/; keybindings: keybindings.json
export function carriedSettings(settings: unknown): Record<string, unknown>
export function hooksOf(settings: unknown): Record<string, unknown> | null
export function countHooks(hooks: unknown): number                // every entry of each event's hooks arrays (an entry without one counts 1)
export function mergeSettings(account: Record<string, unknown>, carried: Record<string, unknown>): Record<string, unknown>
export function withHooks(account: Record<string, unknown>, hooks: Record<string, unknown>): Record<string, unknown>
export function userServers(claudeJson: unknown): { name: string; config: Record<string, unknown> }[]   // user scope, sorted, without claudeterm, isServerName names
export function serverSecrets(config: Record<string, unknown>): string[]   // the non-empty string values of env and headers
export interface PluginPlan { plugins: { id: string; name: string; marketplace: string; enabled: boolean }[]; marketplaces: { name: string; source: string | null /* null: hosted by claude.ai */ }[] }
export function pluginPlan(installed: unknown, known: unknown, settings: unknown): PluginPlan   // user-scope installs; enabled: enabledPlugins[id] === true
export function addTrust(text: string | null, folders: string[]): string | null   // the new .claude.json text, null when nothing to add; throws on text that is not a JSON object
export function previewCounts(read: { settings: unknown; claudeJson: unknown; installed: unknown; known: unknown }, files: Record<FolderItem, number>): CarryCount[]
```

Rules: `carriedSettings` — a JSON object only (else `{}`): `SETTINGS_DROPPED` removed, `env` without `ENV_DROPPED` (names compared ignoring case; an `env` left empty is dropped). `mergeSettings` — the carried top-level keys replace the account's, `env` merged per variable, the account's other keys kept. `pluginPlan` — a marketplace's source: `repo` for github, `url` for git / url, `path` for directory / file, else null (ruling 3). `addTrust` — `projects[<folder>].hasTrustDialogAccepted = true` for each folder: an existing entry with an equal key by `pathKey` (win32 rules for a Windows-looking key, as `isTrustedIn`) gets the flag, else an entry with that key alone; nothing else touched; null when every folder already has it. `previewCounts`, in `CARRY_ITEMS` order: settings = keys of `carriedSettings`; hooks = `countHooks`; mcp = servers, `names` the first three; plugins = installs, `marketplaces` distinct; folders = `files`; trust = `trustedFolders` entries.

- [ ] **Step 1: Write the failing tests:** `'the settings filter drops hooks, plugins, marketplaces, each credential key and each credential variable of env'` — Review Focus 3 (one input with all of them and `model`, `env.FOO` → exactly `{ model, env: { FOO } }`); `'mergeSettings replaces the source's keys, merges env per variable and keeps the rest'`; `'countHooks counts every hook command'`; `'userServers leaves claudeterm out and lists the user-scope servers by name'`; `'serverSecrets are the env and header values'`; `'pluginPlan: user-scope plugins with marketplace and on/off; a marketplace with nothing to add from is claude.ai's'`; `'addTrust adds only the flag, makes an entry with that key alone, keeps everything else, finds a key in another spelling'`; `'addTrust answers null when nothing is to add and throws on text that is not an object'`; `'previewCounts gives the counts the helper shows'`; `'malformed files carry nothing and never throw'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/account-carry.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 12: the carry-over runner — `src/main/account-carry-run.ts` (after Task 2)

**Files:**
- Create: `src/main/account-carry-run.ts`
- Test: `tests/integration/account-carry.int.test.ts`

**Interfaces — Consumes:** Task 11; `runClaudeCli`, `cliMessage`, `jsonOutput`, `parseInstalled`, `parseMarketplaces`, `maskText`. **Produces:**

```ts
export interface SourceFolder { configDir: string; claudeJson: string }   // Main account: CLAUDE_CONFIG_DIR || ~/.claude and <CLAUDE_CONFIG_DIR || home>/.claude.json; a sign-in account: its folder twice
export function readSource(s: SourceFolder): Promise<{ settings: unknown; claudeJson: unknown; installed: unknown; known: unknown; files: Record<FolderItem, number> }>   // reads only; a file over MAX_CONFIG_BYTES is null
export function copyTree(src: string, dst: string): Promise<number>   // files copied
export interface CarryDeps { source: SourceFolder; sourceName: string; target: { id: string; name: string; folder: string }; cli(args: string[]): Promise<CliRun>; log: { warn(m: string): void } }
export function carryItem(item: CarryItem, d: CarryDeps): Promise<CarryLine>
```

Rules (exact line texts; counts singular for 1: `1 setting`, `1 hook`, `1 file`, `1 folder`):
- `settings`: `<folder>/settings.json` (missing → `{}`; not an object → failed `settings.json of <name> cannot be read: left as it was`) merged with `carriedSettings`, written to a temporary name and renamed → `<n> settings`. `hooks`: `withHooks`, the same write → `<n> hooks`.
- Folder items: `copyTree` of each path of `ITEM_PATHS` (merge: each file through a temporary name renamed into place, a same-named file replaced, nothing of the account deleted; a symlink recreated to the same target, else its content copied; `fs.promises` only) → `<n> files`.
- `mcp`: per server `['mcp', 'remove', '--scope', 'user', '--', name]` (its result ignored), then `['mcp', 'add-json', '--scope', 'user', '--', name, JSON.stringify(config)]` → `<n> added`; failures go on with the next server: failed `<k> of <n> · <name>: <maskText(cliMessage(r), serverSecrets(config))>` (the first failure), `log.warn('claude mcp add-json failed for <name> (<code>)')`.
- `plugins`: the account's `['plugin', 'marketplace', 'list', '--json']` and `['plugin', 'list', '--json']` first; a marketplace with source null → each of its plugins skipped, sub `<marketplace>: hosted by claude.ai for <sourceName>`; one not known to the account → `['plugin', 'marketplace', 'add', '--', source]`; each plugin not installed yet → `['plugin', 'install', '--scope', 'user', '--json', '--', id]` (already installed counts as done); one that needs a confirmed command (ruling 3) → skipped, sub `<name>: its marketplace runs a command to install it — install it from MCP · Plugins in a chat on <target name>`; then `['plugin', 'disable', '--scope', 'user', '--', id]` for each that is off in the source. Line: `<n> installed`; with skips state `skipped`, `<k> of <n> installed · <s> skipped`; a failure → failed `<k> of <n> · <id>: <cliMessage>`.
- `trust`: a fresh read of `<folder>/.claude.json`, `addTrust`, an atomic replace (null → nothing written) → `<n> folders`; not an object → failed `.claude.json of <name> cannot be read: left as it was`.
- A `CliError` → that item failed with its message. Nothing of the source is ever written.

- [ ] **Step 1: Write the failing tests** (real temp folders; `hashTree`, `runs`, `readLog`, `MAIN_CREDENTIAL` from `tests/fixtures/accounts.ts`; `cli` = `runClaudeCli` of the stand-in through `installFakeClaude` + `resolveChatLaunch`, env `applyEnvPatch(process.env, loginEnv(target))` with `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` set in the base; the source has settings with secrets, hooks, a server with header `X-Key: sk-header-secret`, plugins, skills, `CLAUDE.md`, `rules/`, `keybindings.json`, trusted folders, `projects/` and a `.credentials.json` holding `MAIN_CREDENTIAL`): `'carry-over into a fresh folder copies the trees and never changes the source'` (`hashTree(source)` equal before and after, `projects/` included; the lines' texts); `'the source's .credentials.json is never in the account'` — Review Focus 3 (no file under the target holds `MAIN_CREDENTIAL`); `'settings carry without hooks, plugins or credentials; hooks replace the account's hooks'`; `'a same-named file is replaced and what only the account has stays'`; `'MCP servers are added with add-json in the account's folder, without a token or a key'` (`runs(log)` of the `mcp` calls: `config` the target, `oauthToken` and `apiKey` false); `'a failed add-json says Claude Code's message with the server's secrets masked and logs only its name and code'` — Review Focus 3 (`cliFail: { 'mcp add-json': 'Invalid JSON: {"headers":{"X-Key":"sk-header-secret"}}' }`); `'plugins: the marketplace added, the plugin installed and turned off as in the source; one needing a confirmed command and a claude.ai marketplace skipped and named'`; `'an already installed plugin counts as done'`; `'trusted folders add only the flag after the other items'`; `'an account settings.json that is not JSON fails the item and stays as it was'`; `'a symlink in a copied folder is recreated or its content copied'`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/account-carry.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

---

## Stream W (wiring `src/main/index.ts`)

Shared helpers in `index.ts` (Task 13 makes them, 14 and 15 use them): `mainConfigDir: string | null` (`CLAUDE_CONFIG_DIR || ~/.claude`; null in test mode without `CLAUDE_CONFIG_DIR`); `accountsRootDir = accountsRoot(process.env, homedir(), dataDir)`; `accountEnv(folder)` = `applyEnvPatch(childEnv(), loginEnv(folder))`; `accountCli(folder, args, timeoutMs = CLI_TIMEOUT_MS)` = `resolveChatLaunch(settings.claude.command, chatLaunchDeps)` (`how: 'none'` → `CliError('failed', reason)`) then `runClaudeCli(launch, args, { cwd: homedir(), env: accountEnv(folder), timeoutMs })`; `checks = new AccountChecks({ status: (f) => accountCli(f, ['auth', 'status', '--json'], STATUS_TIMEOUT_MS).then(parseAuthStatus, (e) => ({ state: 'unknown', reason: e.message })), identity: (f) => readTrustFile(join(f, '.claude.json')).then(identityOf), isDir: (f) => fsPromises.stat(f).then((s) => s.isDirectory(), () => false), now: Date.now, changed: () => broadcast(IPC.evAccounts, accountsView()) })`; `startable(id)` (login: state `ready` or `unknown` and `isDirectory(folder)`; token: readable); `accountLabel(id)` (`Main account` or the name); `transcriptRoots()` (Main's `projects` when `mainConfigDir`, then each sign-in account's `<folder>/projects`); `projectsOf(account)` (a sign-in account's, else Main's; null when unknown).

### Task 13: tabs on an account, and the conversation follows

**Files:**
- Modify: `src/main/index.ts`
- Test: `tests/e2e/accounts-launch.spec.ts` (new)

Wiring:
- `resolveLaunch`: `accountLaunch(account, find)` with `find` = a sign-in account → `{ kind: 'login', folder, startable: startable(id) }`, a token one → `{ kind: 'token', token: accounts.token(id) }`; `req.signIn` (the profile of Claude tabs, `pickClaudeProfile`, as for the Get a token tab; account null) → `{ profileName, spec: buildLaunch(profile, 'claude', { command: signInCommand(settings.claude.command, shellFamily(profile), email), settingsPath: null, resumeSessionId: null, forkSession: false }, { once: true }), env: loginEnv(folder) }`. The switch IPC toasts `<accountName> is not available` when `!startable(account)`.
- `moveConversation` (TabManagerDeps): `findCopies(transcriptRoots(), sessionId)`; source for an explicit move `copyAt(sources.get(tabId)?.transcriptPath, copies)`; `decideMove` with target `projectsOf(to)` (null → true); refuse → `toast('This conversation went further on <accountLabel(newer.account)>; open it from Recent sessions')`, false; `check` → true; copy failure → explicit: `toast('Could not copy the conversation to <to label>: <reason>. The tab goes on as <from label>.')`, `chatHub.restarting(tabId)` (the divider back to `Session restarted`), false; rule B: the toast of ruling 5, true.
- `onTabRestarting(tabId, continuedAs)` → `chatHub.restarting(tabId, continuedAs ? 'Continued as ' + accountLabel(continuedAs.account) : undefined)`.
- `resumable`: the reported transcript, else any copy in `transcriptRoots()`. `runRestore`: "unsaved" = no copy anywhere; each Claude tab with a conversation gets rule B to `projectsOf(startable(t.account) ? t.account : null)` before the tabs open.
- `new SessionHistory(transcriptRoots, …)`.
- Checks: `checks.checkStale(<sign-in accounts>)` once the main window has loaded (`did-finish-load`); a Claude tab on a sign-in account that exits with a code other than 0 → `checks.check(id, folder)`.
- Packaged and not `CLAUDETERM_SKIP_MCP_REGISTER=1`: after Main account's registration, `ensureMcpRegistered({ …, env: loginEnv(folder) })` per sign-in account, one after another.

- [ ] **Step 1: Write the failing e2e tests** (`launchAccounts`; Work at `<root>/accounts/work` with `signedIn` and `trust`):
  - `'a Claude tab on a sign-in account runs with its folder, no token and no API key, in the terminal and in the chat'` (env `ANTHROPIC_API_KEY: 'e2e-api-key-0001'`, `CLAUDE_CODE_OAUTH_TOKEN: 'e2e-env-token-0001'`; one app with `launchAccounts({ view: 'terminal' })`, then one with `view: 'chat'` — the request carries no view, the setting does; in each `ct.openTab({ kind: 'claude', cwd: work, account: WORK })` → a run with `config` the Work folder, `oauthToken` and `apiKey` false; a Main tab's run has Main's config and `apiKey` true).
  - `'a sign-in account that is not signed in starts its tab on Main account with a toast, and a switch to it is refused'` — Review Focus 5 (Studio: a folder, no sign-in; poll `listAccounts` state `signed-out`; the toasts `Account "Studio" is not available; the tab started on the main account` and `Account "Studio" is not available`).
  - `'Continue as Work copies the conversation into Work's folder and resumes it there'` (chat view on Main, script turn `hello`; send it; `ct.switchAccount(tab, WORK)` → `<work>/projects/<P>/<sid>.jsonl` equals Main's; the last run has `--resume <sid>` and Work's config; the chat snapshot holds a divider `Continued as Work`).
  - `'Continue as is refused when Work's copy went further, and nothing changes'` (Work's copy with a modification time an hour later → the toast `This conversation went further on Work; open it from Recent sessions`; `info.account` null; no new run for 2 s).
  - `'moving back to Main account without new messages resumes there'` — Review Focus 2 (after the first move, `switchAccount(tab, null)` → no toast, a run with Main's config).
  - `'a restart of a Work tab whose conversation is only in Main's folder copies it first'` (pipe `session` message SID with Main's transcript path; `ct.restartTab(id, true)`).
  - `'a Main account tab whose newest copy is on Work gets it under Main's projects when it resumes'` (binding: rule B on Main account).
  - `'a copy that fails goes on as the old account and says why'` (`<work>/projects/<P>` is a file → the toast starting `Could not copy the conversation to Work:` and ending `The tab goes on as Main account.`; a run with Main's config).
  - `'a chat on an account that ends with an error checks its sign-in again'` (Work's `.credentials.json` removed after start; `beforeInit: [{ crash: 1 }]` → state `signed-out`).
  - `'the MCP · Plugins panel of a chat on Work changes Work's configuration, not Main account's'` (`ct.mcpAdd(tab, { text: 'https://mcp.context7.com/mcp', names: ['context7'], scope: 'user', clientSecret: null })` → Work's `.claude.json` has `mcpServers.context7`, Main's has none).
- [ ] **Step 2: Run** it through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** it, plus `tests/e2e/accounts.spec.ts tests/e2e/restart.spec.ts tests/e2e/restore.spec.ts tests/e2e/forks.spec.ts tests/e2e/chat.spec.ts` through the lock, and `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 14: the add flow, the state of accounts, removal — IPC

**Files:**
- Modify: `src/main/index.ts`, `src/main/settings-window.ts` (nothing but what `SettingsSection` needs, if anything)
- Test: `tests/e2e/accounts-flow.spec.ts` (new)

Wiring:
- `accountsView()`: each `AccountEntry` as an `AccountView` (token: `state: null`, `checking: false`, email / plan / folder null; sign-in: `checks.get(id)`, `readable = startable(id)`), `keyring`, `main` (`identityOf` of Main account's `.claude.json` read again when its mtime changed; folder `mainConfigDir`). `HostContext.accounts` becomes `{ list: () => accountsView().accounts, nameOf }` (members get startable accounts only).
- `flow = new AccountFlow({ … })`: `openSignInTab` → `tabs.open({ kind: 'shell', cwd: homedir(), title: 'Sign in — ' + name }, { activate: false, signIn: { folder, email } })`; `showTab` → `tabs.activate` + `focusWindow()`; `logout` → `accountCli(folder, ['auth', 'logout'], STATUS_TIMEOUT_MS)`; `others(except)` → `{ label: 'Main account', identity }` of Main account's `.claude.json` (when `mainConfigDir`), then each other sign-in account `{ label: <name>, identity: identityOf(<folder>/.claude.json) }`; `carry` → `carryItem` with the source `SourceFolder`, `cli: (args) => accountCli(target.folder, args)`; `register` → `ensureMcpRegistered({ run: execRunner, execPath: process.execPath, serverScript: resourcePath('mcp/show-image-server.js'), log, exec: (args) => accountCli(folder, args) })` → done `images, diffs, the task list, agent messages`, failed `Could not add ClaudeTerm's server` / `Claude Code was not found` (ruling 1); `removeCreated` → `fs.promises.rm(path, { recursive: true, force: true, maxRetries: 5 })` only inside `accountsRootDir`; `settingsOpen` → `settingsWindow.isOpen()`; `publish` → `broadcast(IPC.evAccountFlow, view)`; `openClaudeTab(id)` as `accounts:open-tab`. TabEvents `data` → `flow.tabOutput`, `exit` and `onTabClosed` → `flow.tabEnded`; app quit → `await flow.quit()`.
- Handlers (each argument through its guard): `accountsList`; `accountsCheck` → `checks.checkStale`; `accountsCarryPreview(source, target)` → `readSource` + `previewCounts` (`null` source = Main account; unknown → null; `targetTabs` = running tabs on `target`); `accountsBegin` → `flow.begin`; `accountsFlow` → `flow.view()`; `accountsFlowAction` → `flow.action`; `accountsPickFolder` → `dialog.showOpenDialog(owner, { title: 'Use a folder I already have', properties: ['openDirectory'] })`, cancelled → null, else `flow.pick(path)`; `accountsRemoveInfo` (conversations = `<id>.jsonl` files under `<folder>/projects/*/`; tabs = running local tabs with that account); `accountsRemove(id, opts)` → `removeAccount` (`trash`: `shell.trashItem`, test mode `fs.promises.rm` recursive) then `checks.forget`; `accountsShowFolder(id)` → `shell.openPath`; `accountsOpenTab(id)` → a Claude tab in `defaultFolder()` on it, `focusWindow()`. `accountsRename` / `Add` / `SetToken` / `GetToken` as today. Every change broadcasts `ev:accounts`.

- [ ] **Step 1: Write the failing e2e tests** (through `window.ct`; the Settings window is not opened; Main account has settings with `model` and `env` `{ FOO: '1', ANTHROPIC_API_KEY: 'sk-main-secret' }`, a hook, server `context7` with header `X-Key: sk-header-secret`, `skills/review/SKILL.md`, `CLAUDE.md`, `work` trusted):
  - `'begin add: a Sign in — Work tab runs auth login --claudeai with the new folder; released, the account is ready and its items carried'` (`auth.work.gate`; a run with argv `['auth', 'login', '--claudeai', '--email', 'work@example.com']`, config `<root>/accounts/work`, no token or key; the tab titled `Sign in — Work` is not in front; the gate → `accountFlow()` step `done`, `who` `{ email: 'work@example.com', plan: 'Team plan' }`, every line `done`; `listAccounts()` has Work `kind: 'login'`, `state: 'ready'`; Work's `settings.json` has `model` and `env.FOO` and no `ANTHROPIC_API_KEY`; Work's `.claude.json` has `mcpServers.context7`, `mcpServers.claudeterm` and the trusted folder; `hashTree(main)` unchanged; the sign-in tab gone; the toast `Account "Work" is ready: signed in as work@example.com`).
  - `'Cancel during the sign-in leaves no account, no folder and no tab'` — Review Focus 1.
  - `'a failed sign-in says The sign-in did not finish, and Try again opens a new tab'` (`auth.work.fail: 'access denied'`).
  - `'an answer that cannot be read right after the sign-in is a failure: Could not confirm the sign-in, nothing saved'` (`auth.work.status: 'garbage'`).
  - `'the same login as Main account asks, and Keep it anyway saves it'` (`auth.work` with Main's email and organization uuid → `sameAs: { account: 'Main account', email: 'main@example.com' }`).
  - `'a token account signed in instead keeps its id and loses its token'` (a tab open on `CI_BOT` keeps `info.account`; `accounts.json` has the entry `kind: 'login'` with that id and no `token` key, and the text lacks `CI_TOKEN`).
  - `'Use a folder I already have with a signed-in folder adds it without a sign-in tab'` (`dialog.showOpenDialog` stubbed through `app.evaluate` as `chat-composer.spec.ts` ~1215 does; no `auth login` run; `created: false` in `accounts.json`).
  - `'Remove with sign-out logs auth logout with the folder and deletes the folder'`; `'with a tab running on the account its folder is not removed'`; `'an adopted folder is never deleted'`.
  - `'no secret in the log, the toasts or the accounts answers'` (after the add and a removal: every `main*.log` under the data folder, the `.toast` texts and the JSON of `listAccounts()` / `accountFlow()` hold neither `FAKE_CREDENTIAL`, `MAIN_CREDENTIAL`, `sk-main-secret`, `sk-header-secret` nor `CI_TOKEN`).
- [ ] **Step 2: Run** it through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** it, plus `tests/e2e/accounts.spec.ts tests/e2e/accounts-launch.spec.ts tests/e2e/devices.spec.ts` through the lock, and `npm test`. Expected: PASS. (R's Tasks 17, 18, 19 may start now.)
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 15: Recent sessions across accounts, and other devices

**Files:**
- Modify: `src/main/index.ts`, `src/main/remote-host.ts`, `src/main/sync/remote-shapes.ts`
- Test: `tests/e2e/accounts-history.spec.ts` (new), `tests/unit/remote-host.test.ts`, `tests/unit/sync-remote-shapes.test.ts`

Rules:
- `listSessions`: each session's `accountName` = `null` for Main account, else the account's name. Opening a row (`sessionsOpen`, a member's `openSession`, a chat's new-tab pick) opens it on `s.account` (`openTab({ …, account: s.account ?? null })`); `openListedSession` becomes async: rule B to `projectsOf(startable(account) ? account : null)` first.
- `sessionsOpenAs(sessionId, account)` (guards: `isSessionId`, `isAccountRef`): only a listed session; `!startable(account)` → `toast('<accountName> is not available')`; a tab already in it → `tabs.switchAccount(tab, account)` and activated; else rule A from the copy on `s.account` to `projectsOf(account)` — refuse → the toast of Task 13; failure → `Could not copy the conversation to <account>: <reason>`; then `openTab({ kind: 'claude', cwd: s.cwd, resumeSessionId: s.id, account })`.
- Members: `clampSession` adds `accountName` (cut and cleaned as titles, `stripC0`, `MAX_ACCOUNT_NAME`) and never an id (`account: null`); `sessionEntry` reads an optional `accountName` (a string ≤ `MAX_ACCOUNT_NAME`, else null; absent from an older device → null). `HostContext.openSession(id): Promise<string>`, `'open-session'` awaits it (ruling 13).

- [ ] **Step 1: Write the failing tests.** E2E (`writeTranscript` into Main's and Work's folders): `'Recent sessions lists the sessions of Main account and of Work, naming Work's'`; `'a conversation on both accounts is listed once, on the account it went on last'`; `'opening a Work session starts it on Work'` (`ct.openSession(id)` → `info.account === WORK`; the run's config is Work's); `'Open as Work copies the conversation and resumes it there; refused when Work's copy went further'`; `'Open as for a conversation open in a tab continues that tab on the other account'`. Unit: `remote-host.test.ts` `'a session's account name goes to the members cut and cleaned, never its id'`; `sync-remote-shapes.test.ts` `'a session list with or without account names parses; a bad name becomes none'`.
- [ ] **Step 2: Run** the unit files and the e2e spec through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, plus `tests/e2e/recent-sessions.spec.ts tests/e2e/devices.spec.ts tests/e2e/chat-slash.spec.ts` through the lock, `npm test`. Expected: PASS. (R's Task 20 may start now.)
- [ ] **Step 5:** Leave the changes uncommitted.

---

## Stream R (renderer)

Board values for R (frame numbers as in the board): dialogs on a scrim `#05050690` with `backdrop-filter: blur(2px)`; dialog radius 16 px, `--sheet`, border `--line-2`, shadow `0 40px 100px #000c`, width 700 px (step 1), 640 px (step 3), 600 px (others), narrower windows `calc(100% - 24px)`; head padding 18 px 20 px 4 px, title 600 15 px; body padding 10 px 20 px 18 px, gap 14 px; footer padding 14 px 20 px, top hairline `--line`, a note at the left (11.5 px `--text-3`; the adopt link in `--blue`). Steps: gap 8 px, 12 px `--text-3`; circle 18 px, border `--line-2`, 600 10 px monospace; current `--accent` with `#1A1A1A`; done `#63C08F1A`, border `#63C08F66`, `--green` `✓`; joins 18 × 1 px `--line-2`. Fields: two columns gap 12 px; field 32 px high, padding 0 10 px, border `--line-2`, radius 8 px, `--term`; focus border `--accent`, `box-shadow: 0 0 0 3px #D9775722`; label 11.5 px `--text-3` (margin-bottom 6 px); note 11 px `--text-3`. Ticks: two columns gap 6 px; a tick padding 8 px 10 px, border `--line-2`, radius 10 px, `--raised`; title 500 12.5 px; note 11 px `--text-3`, one line with ellipsis; count 11 px monospace `--text-2`; off `opacity: .45`; box 16 px radius 4 px, ticked `--accent` with `✓` 700 11 px `#1A1A1A`, unticked border `#3A3A43`. Lock line: dashed `--line-2`, radius 9 px, padding 8 px 10 px, 11.5 px `--text-3`, a 13 px lock icon. Spinner 14 px, border 2 px `#D9775744`, top `--accent`, 0.9 s linear (none under reduced motion). Info box: border `#7FA7F544`, `#7FA7F50D`, radius 10 px, padding 9 px 12 px, 12 px `--text-2`, `i` in `--blue`; warning variant border `#E5B56755`, `#E5B5670D`, `!` in `--amber`. Found box: border `#63C08F44`, `#63C08F0D`, radius 10 px, padding 10 px 12 px, `✓ Signed in` 600 12 px `--green`. Lines: border `--line-2`, radius 10 px, `--raised`; a line padding 7 px 12 px, 12.5 px, separators `--line-2`; icon 16 px 700 (`✓` `--green`, `!` `--amber`, `×` `--red`, a spinner while running); result at the right 11.5 px `--text-3`; sub-lines padding 0 12 px 8 px 38 px, 11.5 px `--text-3`, names `--text-2` 500. Error dialogs: icon box 22 px radius 7 px (`#E5B56722`/`--amber`, `#F2867E22`/`--red`). Accounts card: `--sheet`, border `--line`, radius 12 px; a row grid `32px minmax(0,1fr) auto`, gap 12 px, padding 12 px 16 px, rows split by `--line`; avatar 30 px radius 9 px, 600 11 px monospace `#111` on its colour; name 500; badge 10.5 px, padding 1 px 6 px, radius 5 px, border `--line-2`, `--text-2`; second line 11.5 px `--text-3`, paths 11 px monospace. Buttons as the MCP · Plugins board: 5 px 10 px, radius 8 px, border `--line-2`, `--raised-2`, 12 px; primary `--accent` with `#1A1A1A` 600; ghost transparent `--text-3`; warn border `#E5B56755`, `--amber`, `#E5B5670F`; danger `--red` with `#1A1A1A` 600. Menus: `--raised`, border `--line-2`, radius 10 px, shadow `0 16px 40px #000a`, padding 5 px, 12.5 px; items padding 6 px 10 px radius 6 px, hover `--raised-2`, disabled `--text-3`, red `--red`. Recent sessions chip: 18 px high, border `--line-2`, radius 999 px, padding 0 7 px 0 2 px, 10.5 px `--text-2`, a 14 px round avatar. Settings styles go in `src/renderer/settings.css`, main-window styles in `src/renderer/styles.css`.

### Task 16: account items and the views' wording (pure)

**Files:**
- Modify: `src/renderer/account-items.ts`
- Create: `src/renderer/account-view.ts`
- Test: `tests/unit/account-items.test.ts`, `tests/unit/account-view.test.ts` (new)

**Interfaces — Produces:**

```ts
// account-items.ts
export interface ChoiceAccount { id: string; name: string; readable: boolean; kind?: AccountKind; state?: AccountState | null }   // another device's accounts: { id, name, readable: true }
export interface AccountChoice { label: string; account: string | null; disabled: boolean; signInAgain: boolean }
export function accountChoices(accounts: readonly ChoiceAccount[]): AccountChoice[]     // ▾
export function switchChoices(current: string | null, accounts: readonly ChoiceAccount[]): AccountChoice[]   // Continue as, Open as
export function signInAgainChoices(accounts: readonly ChoiceAccount[]): { label: string; account: string }[]
export function footDetail(a: AccountView | undefined): string
// account-view.ts
export function initials(name: string): string                 // first two characters, the first upper case: Ma, Wo, St, CI
export function avatarColor(a: AccountView | null, index: number): { background: string; color: string }   // Main --accent; sign-in --blue, --purple, --green, --amber by index; token #3A3A43 / #B5B5BE
export function shortPath(path: string, home: string): string  // home → ~ (case-insensitive for a Windows path)
export function rowLine(a: AccountView, home: string): { tone: 'ok' | 'warn' | 'none'; text: string }
export function mainLine(m: MainAccountView, home: string): string
export interface TickRow { item: CarryItem; label: string; note: string; count: string; ticked: boolean; disabled: boolean }
export function tickRows(p: CarryPreview, o: { adopt: boolean; mode: FlowMode; targetName: string }): TickRow[]
export function helperTitle(mode: FlowMode, name: string): string
export function primaryLabel(mode: FlowMode, adopt: { signedIn: boolean } | null): string
```

Rules (exact): `accountChoices` — none while no extra account exists; Main account first; a sign-in account `<name>`, not signed in `<name> (sign in again)` with `signInAgain` (enabled: it opens the sign-in), missing disabled; a token `<name> · token`, unreadable disabled. `switchChoices` — the current account left out; not signed in disabled `<name> (sign in again)`; missing or unreadable disabled; a token by its name. `signInAgainChoices` — `Sign in to <name> again…`. `footDetail` — sign-in: its plan, else `Claude Code login`; token: `Token account`. `rowLine` — checking `Checking…`; ready `Signed in as <email> · <plan> · <path>` (parts left out when unknown; tone ok); signed-out `Not signed in — the sign-in expired or was revoked · <path>` (warn); missing `Its folder is gone: <path>`; unknown `Could not check the sign-in · <path>`; token `Token valid until about <validUntil> · model requests only: no connectors, no Remote Control`, unreadable `Token cannot be read — replace it`. `mainLine` — `Signed in as <email> · <plan> · <path>`. `tickRows` in `CARRY_ITEMS` order, labels `CARRY_LABELS`, notes: Settings `Model, permissions, environment, status line`; Hooks `Commands Claude Code runs on its events`; MCP servers `<first three names, ", "> +<rest> · sign-ins are asked again`; Plugins `Installed again from their <m> marketplaces` (`1 marketplace`); Skills `Your skills for every project`; Agents `Your subagents`; Commands `Your slash commands`; Memory `CLAUDE.md and rules`; Trusted folders `Chats open in them without the trust question`; Keybindings `keybindings.json`; Output styles `Your output styles`; count: the number (Memory `<n> files` / `1 file`, Keybindings `1 file`); count 0 → disabled, unticked, note `None in <sourceName>`; `adopt` → all unticked; `carry` mode with `targetTabs > 0` → Trusted folders disabled, note `Close the tabs on <targetName> to carry over trusted folders`; else ticked. `helperTitle` — `Add a Claude account`, `Sign in to <name> again`, `Sign in instead of the token`, `Carry over to <name>`. `primaryLabel` — `Sign in…`; adopt signed in `Add`; `carry` `Carry over`.

- [ ] **Step 1: Write the failing tests** (one per function with the values above; adapt the existing `account-items` tests to the new choice shape).
- [ ] **Step 2: Run** `npx vitest run tests/unit/account-items.test.ts tests/unit/account-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 17: Settings → Accounts (frame 1; remove and the token dialog of frame 7)

**Files:**
- Modify: `src/renderer/accounts-section.ts` (rewritten), `src/renderer/settings.css`, `tests/e2e/accounts.spec.ts` (the Settings tests follow the new UI; `Add with a token…`)
- Test: `tests/e2e/accounts-settings.spec.ts` (new)

Rules: section title `Accounts` with `the Claude logins your tabs run on`; intro `Each account signs in for itself and keeps its own settings and plugins, so its tabs get claude.ai connectors and Remote Control. The conversations of every account are in one Recent sessions list.`; the card: Main account first (badge `Your Claude Code login`, `mainLine`, ghost `Show folder` when it has a folder), then the accounts by addition. Rows (`rowLine`; `.account-row` with `data-account` = the id): ready — `New tab` (`ct.openAccountTab(id)`), `Carry over…` (opens the helper in `carry` mode — Task 18's `openHelper`), `···`; signed-out — warn `Sign in again` (`beginAccountFlow({ mode: 'sign-in-again', id, … })`, then the helper shows the flow), `···`; missing — `Remove`; token — badge `Token`, `Sign in instead…` (helper, `to-login`), `Replace token` (the field in the row as today), `···`. `···` menu (`aria-label` `More for <name>`; Esc and a click outside close it): sign-in accounts `Rename`, `Sign in again`, `Show folder`, a separator, `Remove…` (red); tokens `Rename`, `Delete` (asks as today). Under the card: primary `＋ Add account…` (helper, `add`), `Add with a token…` (a dialog: Name, Token (password), `Get a token`, `Cancel`, `Add`; errors under it), hint `A token makes model requests only, and shares Main account's setup and history`. The buttons that open the helper (`＋ Add account…`, `Carry over…`, `Sign in instead…`, `Sign in again`) are drawn here and wired in Task 18 (until then they do nothing). The keyring notice when a token account exists. `Remove…` (frame 7): title `Remove <name>?`, `Tabs on <name> keep running until they close; then they start on Main account.`, a box from `accountRemoveInfo` — created: `Sign out and move its folder to the trash` with `<path> · <n> conversations · they leave Recent sessions`, ticked; adopted: `Sign out of it`, unticked; tabs > 0: disabled with `Close the <n> tabs on <name> to remove its folder too`; `Cancel`, danger `Remove` → `removeAccount(id, { signOut: ticked, deleteFolder: ticked && created })`; `problems` shown in the dialog with `Close`. Showing the page calls `ct.checkAccounts()`. Strings from main with `textContent`.

- [ ] **Step 1: Write the failing e2e tests:** `'the Accounts page shows Main account and each account by its state'` (Work signed in, Studio not signed in, Gone with no folder, CI bot token → `Signed in as main@example.com · Max plan`, `Signed in as work@example.com · Team plan`, `Not signed in` with `Sign in again`, `Its folder is gone:` with `Remove`, `Token` with `model requests only: no connectors, no Remote Control` and `Sign in instead…`); `'a row says Checking… until its first check answers'` (`auth.work.status: 'hang'`); `'Add with a token… adds a token account in a dialog without ever showing the token'`; `'Remove… of a sign-in account signs out and removes its folder'`; `'with a tab on the account the folder box is off and says why'`; `'an adopted folder offers only Sign out of it'`; `'Show folder opens the account's folder'` (`shell.openPath` stubbed through `app.evaluate`, the path recorded). Update `accounts.spec.ts`'s Settings tests to the dialog and the new row texts.
- [ ] **Step 2: Run** the specs through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, plus `tests/e2e/settings.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 18: the helper (frames 2, 3, 4; sign in instead and a folder you have of frame 7)

**Files:**
- Create: `src/renderer/account-helper.ts`
- Modify: `src/renderer/settings-page.ts` (`SECTIONS` gains `accounts` and `add-account` → the Accounts tab; `add-account` opens the helper), `src/renderer/accounts-section.ts` (its buttons call `openHelper`), `src/renderer/settings.css`
- Test: `tests/e2e/account-add.spec.ts` (new)

**Interfaces — Produces:** `export function openHelper(o: { mode: FlowMode; account: AccountView | null; accounts: AccountsView }): void` — shows the running flow instead when `ct.accountFlow()` has one; the helper follows `ct.onAccountFlow` (a flow begun from the main window opens it).

Rules:
- Step 1 (`add`, `to-login`, `carry`): title `helperTitle`, the steps `Set up · Sign in · Done` (not for `carry`). `Name` (focused, placeholder `Work, Personal…`; `to-login` prefilled) and `Email (optional)` with `Fills in the sign-in page` (not for `carry`); `Carry over from` — a select: Main account first, then the ready sign-in accounts other than the target, with `<email> · <shortPath>` beside it; `Select all` · `None`; the ticks (`tickRows`, `counting…` until `carryPreview` answers; again when the source changes); `Never carried: the sign-in of Main account, its conversations, Claude Code's caches.`; `to-login` adds the info `Its tabs keep running on the token until they restart. The token is deleted once you are signed in.`. Footer: `Use a folder I already have…` (`add` only) — `pickAccountFolder()`: an error under the footer; ok → a `Folder` row with the path and `Change…`, the found box `✓ Signed in` with `<email> · <plan>` or `Not signed in` (amber), every tick off, the note `This folder has its own setup: tick what to carry over anyway`, an empty Name prefilled with the folder's name without leading dots and `claude-`; `Cancel`; primary `primaryLabel` — disabled until the name is valid; → `beginAccountFlow`, its error under the footer.
- Step 2 (`sign-in`, `confirming`): the spinner with `Waiting for the sign-in in your browser…` (`confirming`: `Checking the sign-in…`), `Your browser opened claude.ai. Sign in with the account for <name>.`, the warning box `Signed in to claude.ai as someone else? Switch accounts on that page, or copy the link from the sign-in tab into a private window.`; footer note `The sign-in runs in the tab “Sign in — <name>”`, `Show the sign-in tab`, ghost `Cancel`.
- `failed`: the error dialog `The sign-in did not finish` with the last line (monospace) when there is one, else `The sign-in tab ended before you were signed in.`; `Could not confirm the sign-in` with `Claude Code did not say who is signed in. Try again, or cancel.`; ghost `Cancel`, primary `Try again` (`retry-sign-in`). `same-login`: title `The same login as <account>`, `This is the same login as <account> (<email>): tabs on <name> would share its limits and connectors.`, ghost `Keep it anyway`, primary (focused) `Sign in with another account`.
- Step 3 (`done`): the found box `✓ Signed in` and `Signed in as <email> · <plan>`; the lines (`CARRY_LABELS`, `text` at the right, `subs` under it, `Try again` on a failed line → `retry-item`); footer: the folder (`shortPath`, monospace), `Done` (`close`), primary `Open a Claude tab on <name>` (`open-tab`).
- Esc or ✕ in step 1 closes; in step 2 they leave the flow running (the window may close: main keeps it). Tab stays inside the dialog.

- [ ] **Step 1: Write the failing e2e tests** (the Settings window through `settingsWindow`):
  - `'Add account… → name and ticks → Sign in…: the helper waits, then shows who signed in and one line per item, and the row'` (the ticks show `Settings`, the server count, `None in Main account` for Output styles; the run of `auth login --claudeai --email work@example.com` in Work's folder; the gate → `Signed in as work@example.com · Team plan`, the lines, the row in the card; `hashTree(main)` unchanged).
  - `'Cancel while waiting leaves no account, no folder and no tab'`.
  - `'a failed sign-in shows The sign-in did not finish with its last line, and Try again opens a new tab'`.
  - `'the same login as Main account shows the warning with both buttons; Keep it anyway saves'`.
  - `'closing Settings during the sign-in: the account is ready, toasted and listed'` (the main window's toast `Account "Work" is ready: signed in as work@example.com`; reopening Settings lists Work).
  - `'Use a folder I already have… with a signed-in folder: Add, and no sign-in tab'`.
  - `'Carry over… on a row lists the items and carries the ticked ones'`.
  - `'Sign in instead… on a token row keeps the account's id and its tab'`.
  - `'Sign in again on a not-signed-in row opens the sign-in step'`.
  - `'no secret in either window'` — Review Focus 3 (after an add: neither window's `content()` holds `FAKE_CREDENTIAL`, `MAIN_CREDENTIAL`, `sk-main-secret`, `sk-header-secret`, `CI_TOKEN`).
- [ ] **Step 2: Run** it through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, plus `tests/e2e/accounts-settings.spec.ts tests/e2e/settings.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 19: the main window — ▾, Continue as, the status bar's account, the foot (frame 5)

**Files:**
- Modify: `src/renderer/main.ts`, `src/renderer/styles.css` (if needed), `tests/e2e/tab-panel.spec.ts` (line ~151: `Extra account` → `Token account`)
- Test: `tests/e2e/accounts-menus.spec.ts` (new)

Rules: ▾ (`newTabItems`): `Claude Code — <label>` per `accountChoices`; a `signInAgain` choice → `beginAccountFlow({ mode: 'sign-in-again', id, name: null, email: null, source: null, items: [], adopt: false })` then `openSettingsWindow('add-account')` (no tab); then, once an extra account exists, a separator and `Add account…` → `openSettingsWindow('add-account')`. The tab menu's `Continue as <label>` from `switchChoices`. The status bar account menu of a local tab: those, then — when there are any — a separator, `signInAgainChoices` (as the ▾ item does), and `Add account…`. The foot: `footDetail` for a tab on an account (Main account as today). Other devices' accounts unchanged.

- [ ] **Step 1: Write the failing e2e tests:** `'▾ lists each account by its state, and Add account… opens Settings at the helper'` (`Claude Code — Work`, `Claude Code — Studio (sign in again)`, `Claude Code — CI bot · token`, a disabled gone account); `'▾ → Claude Code — Work opens a tab on Work in the terminal and in the chat'` (one app with `launchAccounts({ view: 'terminal' })`, one with `'chat'`; `runs(log)` config Work's, no token or key); `'(sign in again) opens the helper's sign-in instead of a tab'` (no new Claude tab; a `Sign in — Studio` tab; the Settings window shows the waiting step); `'the status bar's account menu: Continue as, a disabled (sign in again), Sign in to Studio again…, Add account…'`; `'the foot names the plan of a sign-in account and Token account for a token one'`.
- [ ] **Step 2: Run** it through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, plus `tests/e2e/accounts.spec.ts tests/e2e/tab-panel.spec.ts tests/e2e/status.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 20: Recent sessions — the chip, the search, Open as (frame 6)

**Files:**
- Modify: `src/renderer/recent-sessions.ts`, `src/renderer/main.ts`, `src/renderer/styles.css`
- Test: `tests/unit/recent-sessions.test.ts`, `tests/e2e/accounts-recent.spec.ts` (new)

**Interfaces — Produces:** `RecentSessionsCallbacks` gains `openAs(id: string, account: string | null): void` and `accounts(): readonly ChoiceAccount[]` (`main.ts`: `ct.openSessionAs`, the window's `accounts`).

Rules: the search placeholder `Search by title, folder, message or account`; `filterSessions` matches `accountName` too; a row with `accountName` shows the chip (`.session-account`, `initials` avatar, the name) after the age. A right-click on a session row (`contextmenu`) opens a menu: `Open`; for this device's rows outside a chat's pick, `Open as <label>` per `switchChoices(s.account ?? null, accounts())` (disabled ones as given); a separator; `Star` / `Unstar`.

- [ ] **Step 1: Write the failing tests.** Unit: `'filterSessions matches the account name'`. E2E: `'Work's sessions carry its chip, Main account's none, and the search finds work'`; `'opening a Work session starts it on Work'`; `'Open as Work in a row's menu moves the conversation and resumes it there'`; `'Open as a not-signed-in account is disabled with (sign in again)'`.
- [ ] **Step 2: Run** them (e2e through the lock). Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, plus `tests/e2e/recent-sessions.spec.ts tests/e2e/chat-slash.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

---

### Task 21 (after every stream): the README and the whole run

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Rewrite "👥 More than one Claude subscription" (no new screenshot): an extra account **signs in with claude.ai** into a Claude Code folder of its own (`~/.claude-accounts/<name>`), so its tabs — chat and terminal — get claude.ai connectors, Remote Control, the usage limits and plugins synced from claude.ai; **Settings → Accounts → Add account…** asks for a name (and optionally the email), lets you tick what to **carry over** from Main account (settings, hooks, MCP servers, plugins, skills, agents, commands, memory, trusted folders, keybindings, output styles — never its sign-in or conversations), and runs Claude Code's own sign-in in a background tab while your browser is open; **Carry over…** repeats it later; **Use a folder I already have…** adds an existing config folder. **Recent sessions** lists every account's conversations (a chip names the account); **Continue as …** and **Open as …** copy the conversation to the other account and go on there — never over a copy that went further. A **token** from `claude setup-token` stays as the limited alternative (**Add with a token…**: model requests only, no connectors, no Remote Control), and **Sign in instead…** turns it into a sign-in account in place. Removing an account can sign it out and move its folder to the trash. Update the "Good to know" line on `accounts.json` (sign-in accounts store only their name and folder; a sign-in account's tabs get `CLAUDE_CONFIG_DIR`, and no token or API key of your environment).
- [ ] **Step 2: Run** `npm run typecheck`, `npm test`, then through the lock `npx playwright test tests/e2e/accounts-launch.spec.ts tests/e2e/accounts-flow.spec.ts tests/e2e/accounts-history.spec.ts tests/e2e/accounts-settings.spec.ts tests/e2e/account-add.spec.ts tests/e2e/accounts-menus.spec.ts tests/e2e/accounts-recent.spec.ts tests/e2e/accounts.spec.ts tests/e2e/recent-sessions.spec.ts tests/e2e/restart.spec.ts tests/e2e/restore.spec.ts tests/e2e/forks.spec.ts tests/e2e/chat.spec.ts tests/e2e/mcp-main.spec.ts tests/e2e/devices.spec.ts tests/e2e/settings.spec.ts --reporter=line --workers=2` (after `npm run build`). Expected: PASS.
- [ ] **Step 3:** The controller runs the whole-branch review the skill prescribes; its fixes are tasks of their own.
- [ ] **Step 4:** Delete what the run made outside the repository (scratch logs and folders); leave the changes uncommitted and tell the person what is ready to commit.

### Task 22 (controller, with the person — not implementer work): checks by hand with a real second account

With a second Claude account of the person's, once, on a build of this branch (the person's own data folder; nothing here goes into tests or the README):
- claude.ai connectors in a chat and in the terminal view on the sign-in account; `/remote-control` there.
- `claude auth status --json` of the new folder: its fields against `parseAuthStatus` and the stand-in (ruling 3). A mismatch → a fix task for `account-login.ts` and the stand-in, with the real field names.
- What `--email` does when the browser is signed in as Main account (a note for the README if it surprises).
- The first terminal start on a fresh account: if Claude Code shows its onboarding (theme picker), dispatch the follow-up: Task 12's `trust` item (and its `addTrust`) also sets `theme` (from the source's `.claude.json`) and `hasCompletedOnboarding: true` in the account's `.claude.json`, in the same write, keys absent only; a test `'the trusted-folders write also completes the onboarding'`. If it asks nothing, nothing is added.
- macOS: `auth logout` removes the Keychain entry of that folder.
- A plugin whose marketplace declares an install command, and a claude.ai-synced marketplace in Main account: their real `--json` answer and `known_marketplaces.json` entry against ruling 3; a mismatch → a fix task for `account-carry*.ts` and the stand-in.
