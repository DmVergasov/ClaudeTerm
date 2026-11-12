# MCP servers and plugins, managed from the chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a chat tab, `/mcp`, `/plugin` and a header button open an **MCP · Plugins** panel beside the conversation that does everything Claude Code's own `/mcp` and `/plugin` screens do, and the chat's session restarts by itself (after the answer) whenever the set of MCP servers or plugins it would load changes — by the panel or by Claude.

**Architecture:** Main gets a `src/main/mcp/` folder: a runner for Claude Code's own CLI with the tab's command, environment and folder (`claude-cli.ts`), a reader of the configuration files and their diff (`mcp-config.ts`), the panel's backend (`mcp-hub.ts`, `plugin-cli.ts`), a file watch (`config-watch.ts`) and the restart coordinator (`restart-coordinator.ts`) that compares what each chat loaded with what it would load now and restarts through the existing `tabs.restart(tabId, { live: true })`. The running session is reached through new `ChatEngine` / `ChatHub` calls (`mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer`). The renderer gets a `src/renderer/mcp/` folder: the panel as one more side-panel kind, its servers list, the add dialog, the plugins views; the chat draws a new `reload` card and says what came up after a restart.

**Tech Stack:** Electron 44, TypeScript (strict), `@anthropic-ai/claude-agent-sdk` 0.3.322 (already pinned), plain DOM, Vitest, Playwright, the stand-in Claude Code (`tests/fixtures/fake-claude`).

**Spec:** `docs/superpowers/specs/2026-11-12-mcp-plugins-design.md` (approved by the person; read it whole, with "My calls" and "Answers for the builder"). Visual reference: the board `.superpowers/mcp-plugins/boards/mcp-plugins.html` (frames 1 servers panel, 2 add a server, 3 plugins, 4 Claude adds a server); where the board and the spec disagree the spec wins. The values below are taken from the board.

**Execution:** subagent-driven, implementers on Haiku (the person's standing rule; fix rounds 4-5 escalate as the skill says). Two streams after the shared tasks — see "Streams".

## Global Constraints

- Work in `D:\Workspace\ClaudeTerm\.claude\worktrees\feat-redesign-look`, branch `feat/chat-mode`. Never `cd` to the main checkout; never touch another worktree.
- **Never commit, stash, push, reset or create branches.** Leave every change uncommitted (the person's rule; the controller snapshots the tree).
- **Build and e2e only through the lock:** `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/<file> --reporter=line --workers=2"` (`--workers=1` on a busy machine). Unit and integration: `npx vitest run <files>`. No `npm install` in any task.
- **No test starts the real `claude`, calls the API, or reads or writes the real `~/.claude`, `~/.claude.json` or `%APPDATA%\ClaudeTerm`.** Tests run the stand-in with `CLAUDE_CONFIG_DIR` in a temp folder. Never run the SDK's own `claude.exe` (node_modules/@anthropic-ai/claude-agent-sdk-*).
- **ClaudeTerm never writes Claude Code's configuration files or the user's repository.** Every configuration change is a Claude Code CLI command (`claude mcp …`, `claude plugin …`) or a call on the running session; ClaudeTerm only reads the files.
- **Every CLI call goes through `runClaudeCli` (Task 4):** the tab's command resolved by `resolveChatLaunch(settings.claude.command, …)` and started by `spawnChatProcess` (no shell other than the launch's own rule: a `.cmd` shim through cmd.exe with `cmdShimLine` quoting, a bare POSIX command through the login shell with `quoteForLoginShell`), the tab's environment (`TabManager.claudeEnv`, Task 8) plus `NO_COLOR=1`, the tab's folder as cwd, options first, then `--`, then the positional arguments; a time limit (60 s; `claude mcp login` 300 s); never `claude mcp list` or `claude mcp get` (they health-check every server).
- **Secrets** (header values, env values, an OAuth client secret, plugin option values): never logged (no CLI argument list is ever logged: a log line names only `claude <first two args>` and the exit code), never in a toast, never in an IPC answer, never in the DOM once recognised, never sent to another device, never on the clipboard in clear. They reach Claude Code only as the `add-json` argument of a short-lived child process, the OAuth client secret only as `MCP_CLIENT_SECRET` in its environment, plugin options only on the stdin of `claude plugin configure --values-stdin`. Mask text is exactly `••••••••` (`MASK`, Task 2).
- **Untrusted input:** everything from the CLI's output, the configuration files and the SDK's status is checked field by field and capped: a name 200 chars, an error 2 000, a tool name 200 and at most 500 tools, a description 2 000, CLI stdout 4 MiB, stderr 64 KiB, a configuration file 16 MiB (bigger: not read, configures nothing). Nothing here throws on bad input.
- **Main never blocks:** CLI calls are child processes awaited asynchronously; configuration files are read with `fs.promises` and parsed once per file version (`jsonFileCache`, Task 5); the app never polls the CLI; it asks the running session (`mcp_status`) only while the panel shows a connecting server (every 2 s) or while a restart's report waits (every 500 ms, at most 20 s).
- **Paths are compared with `pathKey`**, with `win32` rules for a Windows-looking path on any OS (as `isTrustedIn` in `src/main/chat/chat-support.ts` does), and the tab's folder is always `await canonicalFolder(tab.cwd)` (`src/main/chat/chat-files.ts`) before it is compared with a key Claude Code wrote (8.3 names on the CI runner).
- **The terminal view is unchanged**: its Claude Code keeps its own `/mcp` and `/plugin`. Every existing test keeps passing.
- **UI strings are exact** as the tasks give them (English). Comments, logs and strings in English; match the surrounding code's naming and comment density; no UI framework; keep line endings (new files in `src/` and `tests/` CRLF, like their neighbours). Motion animates only `transform` and `opacity`; `prefers-reduced-motion: reduce` turns it off. Colours are the variables of `src/renderer/colors.css` (`--ground --sheet --term --raised --raised-2 --line --line-2 --text --text-2 --text-3 --accent --green --amber --red --blue --purple`).
- Some e2e specs flake under load (`review.spec`, a fold test in `tab-panel.spec`): rerun a failing test alone through the lock before blaming the change. Close every app a test starts; temp files only under `tmpdir()`.
- A failure in a file your task does not list is someone else's work in progress: never edit it; rerun after a few minutes; report it if it persists. A main-process piece a renderer task needs and does not find is reported to the controller, never built in the renderer task.
- Done for a task = `npm run typecheck`, its `npx vitest run …` files, and its e2e specs through the lock, green.

## Streams

| Phase | Tasks | Owns (only these files are edited) |
|---|---|---|
| Shared, first, in order | 1, 2 | `src/shared/mcp.ts`, `src/shared/mcp-add.ts`, `src/shared/chat.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/chat/chat-mirror.ts`, `src/renderer/chat/chat-find.ts`, `src/renderer/chat/chat-items.ts` (one placeholder case), their tests |
| **M** (main), in order | 3 → 13 | `src/main/**`, `tests/fixtures/fake-claude/*`, `tests/fixtures/chat/README.md`, `tests/e2e/mcp-helpers.ts` (until Task 8 is done; then it is R's), `tests/e2e/mcp-main.spec.ts`, `tests/e2e/mcp-restart.spec.ts` (until Task 13 is done), the unit and integration tests named in M's tasks |
| **R** (renderer), in order | 14 → 19 | `src/renderer/**`, `tests/e2e/mcp-panel.spec.ts`, `tests/e2e/mcp-add.spec.ts`, `tests/e2e/mcp-plugins.spec.ts`, one test in `tests/e2e/chat-devices.spec.ts`, `tests/e2e/mcp-restart.spec.ts` (from Task 19), `tests/unit/mcp-view-model.test.ts`, `tests/unit/slash-route.test.ts` |
| Final | 20 | `README.md`, fixes the final review asks for |

R's tasks start when the M task they need is done: **14 after 2; 15, 16, 17 after 8; 18 after 10; 19 after 13.** The interfaces between the streams are Task 1's types and IPC (the only contract), Task 2's parser, and the stand-in's script options (Task 3). The controller copies the board to `.superpowers/sdd/2026-11-12-mcp-plugins/boards/mcp-plugins.html` before Task 1 and gives its path to every R implementer; it also checks that the work this plan builds on has landed (side panels opening smoothly in `side-panel.ts`, the `restarting` activity with the "Restarting Claude Code" line and the "Session restarted" divider, the agents dock, the chat theme, quoting) — `npm run typecheck` and `npm test` green — before Task 1.

## Rulings on the spec (unbuildable or contradictory points; the plan follows these)

1. **Server on/off needs no restart.** "My calls" says a disable restarts "(the session must drop the server)". `toggleMcpServer` drops or brings up the server in the running session at once, and Claude Code itself records it (`disabledMcpServers` in the folder's entry of `.claude.json`, checked in Claude Code 2.1.322). So the panel's switch is a session call, `disabledMcpServers` is not a change, and no restart follows. A **plugin** disable is a configuration change and restarts, as does a server removal. The switch needs a running session (hidden without one).
2. **"Update when a newer version is there":** `claude plugin list --json --available` leaves installed plugins out of `available`, so it never names a newer version. The newer version is read from the marketplace's catalog on disk (`<installLocation>/.claude-plugin/marketplace.json`, `installLocation` from `claude plugin marketplace list --json`); a catalog version different from the installed one (not `unknown`) shows Update.
3. **"Copy the config"** would put secrets on the clipboard (an anti-goal). The copy is the server's JSON with every header and env value as `••••••••`.
4. **The masked paste field.** A text area cannot show `••••••••` while it holds the key. Once the text is recognised and holds a secret (on paste, and on blur), the field turns into a read-only masked view with **Clear**; the raw text stays only in the dialog's memory until Add sends it to main once.
5. **"Its width saved":** no side panel saves a dragged width today (widths come from settings; a drag lasts the run). The new panel does the same, starting at 420 px; no new setting.
6. **The board's `/mcp` bubble and "The MCP servers opened on the right."**: the text wins. `/mcp` and `/plugin` open the panel and add nothing to the conversation, as `/model` does.
7. **"Run without a shell":** the CLI runs exactly as the tab's own Claude Code starts (`spawnChatProcess`): through cmd.exe for a `.cmd` shim and through the login shell for a bare POSIX command, with their quoting; nothing else is interpreted.
8. **Members' devices** reject an item kind they do not know. A `reload` card, a divider's highlighted part and the `open-mcp` notice action are mapped to plain items for members (Task 1); remote tabs get no panel (the spec's v1).
9. **A project server added through the panel in "This project, shared"** may still wait for approval in this folder (Claude Code decides); it is then not a change (the spec's rule): no restart, and the panel shows it under Needs attention with Approve in the terminal. A rejected project server shows the same way (the terminal's `/mcp` changes either).
10. **ClaudeTerm's own registration of `claudeterm`** at first start or after an update is a change from outside any chat: chats on that config folder show the card with Restart; none restarts by itself.

## Review Focus

1. **A secret in Add a server** (a header token, an env value): after recognition it is in no input's value and no text of the page, not in `main.log`, not in an error the panel shows (a CLI error that echoes the JSON is masked), not in Copy config. Tests: Task 2 `maskText`, Task 7 `'a failed add … every secret masked'`, Task 17 `'the key never shows once recognised, nor in the log'`.
2. **Claude Code rewriting its own `.claude.json`** all the time (start counts, tips, other folders' entries, `disabledMcpServers`), or a large one: no card, no restart, one parse per file version. Tests: Task 5 `'other keys … are no change'`, `'jsonFileCache parses a file once per version'`, Task 11 `'a file change with nothing relevant …'`, Task 13 e2e `'Claude Code rewriting its own .claude.json shows no card'`.
3. **A restart while the chat is busy in another way** — a permission card waiting, messages queued, a compaction, a start not ready: the restart waits, nothing is cut. Tests: Task 6 `'idle is false while …'`, Task 11 `'a waiting card, queued messages or a compaction keep the restart waiting'`, Task 13 e2e `'the answer is not cut'`.
4. **A CLI command that hangs or floods** (an install waiting for a confirmation a non-TTY cannot give, a sign-in nobody finishes, megabytes of JSON): killed at its limit, its message next to the action, the window responsive. Tests: Task 4 `'a command that never ends is killed at its time limit'`, `'stdout past the cap ends the command'`, Task 16 e2e `'Cancel ends a sign-in'`.
5. **Folder spellings**: the `projects` key in `.claude.json`, a plugin install's `projectPath` and the tab's folder differ in case, slash direction, a trailing separator or an 8.3 name — the same folder. Tests: Task 5 `'the folder entry matches … (Windows rules)'`, `'plugins of another folder are left out'`; the e2e specs run with work folders under the CI runner's short-name `TEMP`.

---

### Task 1: the shared contract — types, IPC, the chat's new items, members' mapping

**Files:**
- Create: `src/shared/mcp.ts`
- Modify: `src/shared/chat.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/chat/chat-mirror.ts`, `src/renderer/chat/chat-find.ts`, `src/renderer/chat/chat-items.ts` (one placeholder case)
- Test: `tests/unit/mcp-shared.test.ts` (new), `tests/unit/chat-mirror.test.ts`

**Interfaces — Produces** (every later task uses these names; nobody changes them):

```ts
// src/shared/mcp.ts — MCP servers and plugins as the MCP · Plugins panel shows them
export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'pending-approval' | 'disabled' | 'configured' // configured: known from the files only, no running session
export type McpScope = 'user' | 'project' | 'local' | 'plugin' | 'claudeai' | 'managed' | 'other'
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws' | 'other'
export interface McpServerView {
  name: string; status: McpStatus; scope: McpScope; plugin: string | null   // plugin: the plugin's name for scope 'plugin'
  transport: McpTransport; target: string   // the URL (secret query values masked) or the command line; '' unknown
  tools: string[]; error: string | null; version: string | null
}
export interface McpServersView { live: boolean; servers: McpServerView[] }   // live false: no running session in the tab
export type McpEditScope = 'user' | 'project' | 'local'
export const MCP_EDIT_SCOPES: readonly McpEditScope[] = ['user', 'project', 'local']
export type McpSection = 'servers' | 'plugins'
export type McpAction =
  | { kind: 'reconnect'; name: string } | { kind: 'toggle'; name: string; enabled: boolean }
  | { kind: 'remove'; name: string; scope: McpEditScope }
  | { kind: 'login'; name: string } | { kind: 'cancel-login'; name: string } | { kind: 'logout'; name: string }
  | { kind: 'copy-config'; name: string; scope: McpEditScope } | { kind: 'open-config'; scope: McpEditScope }
export interface McpAddRequest { text: string; names: string[]; scope: McpEditScope; clientSecret: string | null }
export interface PluginView { id: string; name: string; marketplace: string; version: string; scope: string; enabled: boolean; update: string | null; description: string; mcpServers: number; errors: string[] }
export interface PluginOffer { id: string; name: string; marketplace: string; description: string; version: string | null; installs: number | null }
export interface MarketplaceView { name: string; source: string }
export interface PluginsView { installed: PluginView[]; available: PluginOffer[]; marketplaces: MarketplaceView[] }
export interface PluginOption { key: string; title: string; description: string; sensitive: boolean }
export type PluginAction =
  | { kind: 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'configure-later'; id: string }
  | { kind: 'configure'; id: string; values: Record<string, string> }
  | { kind: 'marketplace-add'; source: string } | { kind: 'marketplace-remove' | 'marketplace-update'; name: string }
/** options: required plugin options still unset after an install; marketplace: the name a marketplace-add added */
export type McpResult = { ok: true; options?: PluginOption[]; marketplace?: string } | { ok: false; error: string }
export type ReloadAction = 'not-now' | 'restart'
/** a marketplace source as `claude plugin marketplace add` takes it: a GitHub repository link (https://github.com/o/r, with .git, /tree/…, or without the scheme) becomes `o/r`; anything else trimmed as typed; null for empty, multi-line, a control character or a leading '-' */
export function marketplaceSource(text: string): string | null
```

`src/shared/chat.ts`: `ChatItem` gains `| { kind: 'reload'; id: string; title: string; text: string; action: ReloadAction | null }`; the `divider` item gains `good?: string` (a part of its text drawn in green); `ChatNoticeAction` becomes `'restart' | 'open-terminal' | 'open-mcp'`.

`src/shared/ipc.ts` `IPC`: `mcpServers: 'mcp:servers'`, `mcpAction: 'mcp:action'`, `mcpAdd: 'mcp:add'`, `mcpPlugins: 'mcp:plugins'`, `mcpPluginAction: 'mcp:plugin-action'`, `mcpReload: 'mcp:reload'`, `evMcpChanged: 'ev:mcp-changed'`. `CtApi` (and `src/preload/index.ts`, `invoke` / `on` like their neighbours):

```ts
mcpServers(tabId: string): Promise<McpServersView | null>          // null: not a local Claude tab
mcpAction(tabId: string, a: McpAction): Promise<McpResult>
mcpAdd(tabId: string, req: McpAddRequest): Promise<McpResult>
mcpPlugins(tabId: string): Promise<PluginsView | { error: string } | null>
mcpPluginAction(tabId: string, a: PluginAction): Promise<McpResult>
mcpReload(tabId: string, action: ReloadAction): Promise<boolean>   // the reload card's button; false: no card
onMcpChanged(cb: (tabId: string) => void): Unsubscribe              // the tab's servers, plugins or card changed
```

`src/main/chat/chat-mirror.ts`: `export function itemForMembers(item: ChatItem): ChatItem` — a `reload` becomes `{ kind: 'notice', id, tone: 'info', text: `${title} — ${text}`, action: null }`; a divider loses `good`; a notice with `open-mcp` gets `action: null`; anything else is returned as it is. `export function patchForMembers(p: ChatPatch): ChatPatch` maps the items of `add`, `set` and `reset`. (`isItem` stays as it is: members never receive the new shapes.) `NOTICE_ACTIONS` is not widened.

Renderer, to keep the build whole: `chat-find.ts` `searchText` gains `case 'reload': return `${item.title}\n${item.text}``; `chat-items.ts` `renderItem` gains `case 'reload': return el('div', 'chat-reload', item.title)` (Task 19 replaces it) and `noticeItem`'s `action` parameter type follows `ChatNoticeAction`.

- [ ] **Step 1: Write the failing tests.** `tests/unit/mcp-shared.test.ts`: `'marketplaceSource turns a GitHub link into owner/repo and keeps any other source'` — `https://github.com/acme/tools` → `acme/tools`; `https://github.com/acme/tools.git` → `acme/tools`; `github.com/acme/tools/tree/main` → `acme/tools`; `acme/tools` → `acme/tools`; `  ./plugins  ` → `./plugins`; `C:\\market` → `C:\\market`; `https://example.com/m.json` → same; `''`, `'a\nb'`, `'-x'` → `null`. `tests/unit/chat-mirror.test.ts`: `'a reload card reaches the members as a plain notice'` (`itemForMembers({ kind: 'reload', id: 'r', title: 'New MCP server: context7', text: 'Restart the session to load it — the conversation goes on', action: 'restart' })` → `{ kind: 'notice', id: 'r', tone: 'info', text: 'New MCP server: context7 — Restart the session to load it — the conversation goes on', action: null }`); `'the members get no divider highlight and no open-mcp action'`; `'patchForMembers maps the items of add, set and reset and leaves other patches'`; and `parseChatPush` of a snapshot built from `patchForMembers` output passes.
- [ ] **Step 2: Run** `npx vitest run tests/unit/mcp-shared.test.ts tests/unit/chat-mirror.test.ts`. Expected: FAIL (module / functions missing).
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** them and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 2: reading what the person pastes — `src/shared/mcp-add.ts`

**Files:**
- Create: `src/shared/mcp-add.ts`
- Test: `tests/unit/mcp-add.test.ts`

**Interfaces — Produces:**

```ts
export type McpConfig =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string>; oauth?: McpOauth }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string>; oauth?: McpOauth }
export interface McpOauth { clientId?: string; callbackPort?: number }
export interface ParsedServer { name: string; config: McpConfig }
export type AddParse =
  | { kind: 'servers'; servers: ParsedServer[]; scope: McpEditScope | null; needsClientSecret: boolean }  // scope: named by the command (-s / --scope)
  | { kind: 'github'; source: string }                       // a GitHub repository link: a plugin marketplace, not a server
  | { kind: 'none'; reason: string }
export const MASK = '••••••••'
export function parseAddInput(text: string): AddParse
export function splitCommandLine(line: string): string[] | null       // null: a quote is not closed
export function isServerName(name: string): boolean                   // /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export function maskUrl(url: string): string                           // query values whose name matches /key|token|secret|password|auth/i → MASK
export function secretsOf(config: McpConfig): string[]                 // every header and env value, non-empty
export function maskText(text: string, secrets: string[]): string      // each secret replaced by MASK, longest first
export function targetOf(config: McpConfig): string                    // maskUrl(url), or command and args joined by spaces (an arg with a space in double quotes)
export function maskedConfig(config: McpConfig): McpConfig             // header and env values → MASK, url → maskUrl
export function previewRows(s: ParsedServer): { label: string; value: string }[]
```

Rules (what is shown before adding is exactly what is added — main re-parses the same text with the same function):
- The text is trimmed; over 65 536 chars → none `'The text is too long'`; empty → none `'Paste a command, a server URL or a JSON config'`.
- Starts with `{` → JSON: `{ mcpServers: {…} }`, `{ servers: {…} }`, `{ <name>: <config>, … }` (every value an object with `command` or `url`), or one bare config (named from its host or command, below). A config: `type` `stdio` | `http` | `sse` (default `stdio` with `command`, `http` with `url`), `command` string, `args` string[], `env` / `headers` string records, `oauth` `{ clientId?, callbackPort? }`; other keys dropped. Parse error → none `The JSON does not parse: <message, ≤ 200 chars>`.
- A line (lines ending in `\` are joined; a leading `$ ` or `> ` is dropped) split by `splitCommandLine` (POSIX rules: `'…'` literal, `"…"` with `\"` and `\\`, `\` escapes outside quotes):
  - first word `claude` (or a path ending in `claude`, `claude.exe`, `claude.cmd`), then `mcp add-json <name> <json>` → that config; `mcp add [options] <name> <commandOrUrl> [args…]`: `-s/--scope <v>`, `-t/--transport <v>`, `-e/--env` (then every following `KEY=value` word), `-H/--header` (then every following word containing `:`), `--client-id <v>`, `--client-secret` (a flag: `needsClientSecret`), `--callback-port <n>`; after `--` the rest is the command and its args. No `--transport` and an `http(s)://` target → `http`.
  - `https://github.com/<owner>/<repo>…` → `{ kind: 'github', source: 'owner/repo' }`.
  - one `http(s)://` URL → an `http` server; name: the host without a leading `mcp.`, `api.`, `www.`, its first label (`mcp.context7.com` → `context7`).
  - any other line → a stdio server (command = first word, args = the rest); name: the first argument that is not an option and not one of `npx uvx bunx node python python3 docker deno`, without an `@scope/` prefix and an `@version` suffix, lowercased (`npx -y @upstash/context7-mcp` → `context7-mcp`); none found → `server`.
- A name that is not `isServerName` becomes its valid characters (cut to 64) or `server`. More than 20 servers → none `'At most 20 servers at once'`. A URL that is not `http:`/`https:` → none `'Only http and https addresses'`. Anything unrecognised → none `'Not a claude mcp add command, a URL or a JSON config'`; an unclosed quote → none `'A quote is not closed'`.
- `previewRows` (labels exact): `Type` (`HTTP` / `SSE` / `stdio`), `Address` (http/sse: `maskUrl(url)`) or `Command` (stdio: `targetOf`), one `Header` per header (`Name: ••••••••`), one `Env` per variable (`KEY=••••••••`), `OAuth client` (`clientId`) when set. The name is not a row (the dialog edits it).

- [ ] **Step 1: Write the failing tests** (each assertion with these exact values):
  - `'a claude mcp add command for an HTTP server with a header'`: `claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: sk-test-123"` → one server `{ name: 'context7', config: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'sk-test-123' } } }`, scope `null`.
  - `'a stdio server with env after the name and its command after --'`: `claude mcp add my-server -e API_KEY=xxx -- npx my-mcp-server` → `{ type: 'stdio', command: 'npx', args: ['my-mcp-server'], env: { API_KEY: 'xxx' } }`.
  - `'the scope the command names is kept'` (`-s project` → `'project'`); `'add-json takes its JSON'`; `'an mcpServers object, a servers object, named configs and a bare config'`; `'a bare URL is an HTTP server named after its host'`; `'a GitHub repository link is a marketplace'` (`https://github.com/acme/tools/tree/main` → `acme/tools`); `'a command line that is not claude is a stdio server named after its package'`; `'quotes, escaped quotes, a line continuation and a $ prompt'`; `'--client-secret asks for the secret, --client-id and --callback-port go in oauth'`; `'text that is none of these says why'` (each reason above).
  - `'previewRows masks every header and env value and a URL's secret query values'`: `https://x.dev/mcp?api_key=abc&mode=1` → Address `https://x.dev/mcp?api_key=••••••••&mode=1`.
  - `'maskText gives the board's masked command'`: the first command's text with `secretsOf` → `claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: ••••••••"`.
  - `'isServerName'`: `context7`, `my_server.v2` true; `-x`, `a b`, 65 chars, `''` false.
- [ ] **Step 2: Run** `npx vitest run tests/unit/mcp-add.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/shared/mcp-add.ts` (no Node imports: the renderer bundles it).
- [ ] **Step 4: Run** it and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

---

## Stream M (main process)

### Task 3: the stand-in learns `claude mcp …`, `claude plugin …` and the session's MCP requests

**Files:**
- Modify: `tests/fixtures/fake-claude/fake-claude.ts`, `tests/fixtures/fake-claude/install.ts` (add only: new script options and one step kind; never change existing behaviour), `tests/fixtures/chat/README.md` (a section "MCP and plugins: scripted, not recorded")
- Create: `tests/e2e/mcp-helpers.ts`
- Test: `tests/integration/fake-claude.int.test.ts`

**Interfaces — Produces** (`install.ts`):

```ts
// FakeScript gains
mcp?: Record<string, { status?: 'connected' | 'failed' | 'needs-auth'; error?: string; tools?: string[]; version?: string; pendingMs?: number }>
  // the session's mcp_status: every server it loaded is connected with the tool `ping` unless named here; pendingMs: 'pending' that long after the start
mcpLogin?: Record<string, { gate?: string; fail?: string }>   // claude mcp login <name>: waits for <config>/<gate>; fail: that message on stderr, exit 1
marketplaces?: FakeMarketplace[]                              // what `claude plugin marketplace add <source>` can add, by its exact source
cliFail?: Record<string, string>                              // a CLI call whose arguments (joined by spaces, `--` left out) start with the key fails with that message, exit 1
export interface FakeMarketplace { name: string; source: string; plugins: FakePlugin[] }
export interface FakePlugin { name: string; description: string; version: string; installVersion?: string; installs?: number; mcpServers?: string[]
  options?: { key: string; title: string; description?: string; required: boolean; sensitive: boolean }[] }
// FakeStep gains
| { cli: string[] }   // Claude runs `claude <args>` with Bash: a Bash tool_use (input.command = 'claude ' + args joined by spaces), then the stand-in's own CLI runs in-process, then the tool_result with its stdout
```

`tests/e2e/mcp-helpers.ts`: `chatStarts(log: () => Record<string, unknown>[], sessionId?: string): number` (log `argv` entries holding `stream-json`, and `sessionId` among them when given); `cliCalls(log): { argv: string[]; secretEnv: boolean; stdinKeys: string[] | null }[]`; `readJsonFile(file: string): any` (null when missing); `runStandIn(config: string, cwd: string, args: string[]): { code: number; stdout: string; stderr: string }` (spawnSync of `process.execPath --experimental-strip-types --no-warnings <fake-claude.ts> …args` with `CLAUDE_CONFIG_DIR=config` and the `script.json` / `fake-claude.log` beside `config`, as `launchChatTab` lays them out).

Rules (what the stand-in does is what Claude Code 2.1.322 does, as the spec and the CLI's own code say):
- CLI mode when `argv[0]` is `mcp` or `plugin`. It logs `{ cli: argv, secretEnv: MCP_CLIENT_SECRET set, stdinKeys }` (the keys only, never values), then exits. `cliFail` is checked first. Options come before `--`, positionals after it (a call without `--` also works, as commander takes it).
- Files, exactly where Claude Code keeps them: `<config>/.claude.json` (user `mcpServers`; local `projects[<folder key>].mcpServers`, the folder key being an existing key equal to the cwd's real path by a case-insensitive, slash-insensitive compare, else `realpathSync.native(cwd)`), `<cwd>/.mcp.json` (project), `<config>/settings.json` `enabledPlugins`, `<config>/plugins/installed_plugins.json` (`{ version: 2, plugins: { "<name>@<market>": [{ scope, installPath, version, installedAt, lastUpdated, projectPath? }] } }`), `<config>/plugins/known_marketplaces.json`, `<config>/plugins/marketplaces/<name>/.claude-plugin/marketplace.json` (`{ name, plugins: [{ name, description, version }] }`). Every write keeps the file's other keys.
- `mcp add-json [--scope s] [--client-secret] -- <name> <json>`: default scope `local`; bad JSON → stderr `Invalid JSON`, exit 1; a name already in that scope → stderr `MCP server <name> already exists in <scope> config`, exit 1; stdout `Added <type> MCP server <name> to <scope> config`. `mcp remove [--scope s] -- <name>`: from that scope, or the first of local, project, user holding it; none → stderr `No MCP server found with name: <name>`, exit 1. `mcp login -- <name>`: per `mcpLogin`; success writes `<config>/fake-mcp-auth.json` `{ <name>: true }`, stdout `Authentication successful`. `mcp logout -- <name>`: drops it, stdout `Logged out`.
- `plugin list --json` → the array of installed entries `{ id, version, scope, enabled, installPath, installedAt, lastUpdated, projectPath, mcpServers: { <server>: {} } }`; with `--available` → `{ installed: [...], available: [{ pluginId, name, description, marketplaceName, version, source: 'fake', installCount }] }` (the added marketplaces' plugins not installed). `plugin install [--scope s] -- <id|name>` (version `installVersion ?? version`, `enabledPlugins[id] = true`; unknown → stderr `Plugin "<id>" not found in any marketplace`, exit 1), `uninstall`, `enable`, `disable`, `update` (to the catalog's `version`), `configure -- <id> --json` → `{ pluginId, displayName, schema: { <key>: { type: 'string', title, description, required, sensitive } }, configured: [...], unconfigured: [...] }` (set keys kept in `<config>/plugins/fake-options.json`), `configure --values-stdin -- <id>` (reads a JSON object of strings from stdin; stores the keys). `plugin marketplace add -- <source>` (a script marketplace whose `source` equals it; else stderr `Failed to add marketplace: no marketplace manifest found at <source>`, exit 1), `remove -- <name>`, `update [-- <name>]`, `list --json` → `[{ name, source: 'github', repo: <source>, installLocation }]`.
- Session (stream-json mode): at start it reads what it loads — user and local servers, `.mcp.json` servers approved for the folder (`enableAllProjectMcpServers` or `enabledMcpjsonServers` in its `projects` entry or a settings file, and not in `disabledMcpjsonServers`), the servers of installed enabled plugins as `plugin:<plugin>:<server>` (source `plugin`); `disabledMcpServers` of the folder entry → `disabled`. `mcp_status` → `{ mcpServers: [{ name, status, serverInfo: { name, version }, error, config: { type, url } | { type: 'stdio', command, args }, scope, source, tools: [{ name }] }] }` (the config's headers and env are copied too, as Claude Code sends them, so the engine's dropping of them is tested). `mcp_reconnect { serverName }` → reply `{}`, and a `needs-auth` server whose name is in `fake-mcp-auth.json` becomes `connected`; unknown name → an error response `Server not found: <name>`. `mcp_toggle { serverName, enabled }` → `disabled` / back, writes `disabledMcpServers` of the folder entry, reply `{}`. Every control request is already logged (`{ in }`).

- [ ] **Step 1: Write the failing tests** in `fake-claude.int.test.ts` (follow its spawn helper): `'claude mcp add-json writes the server where Claude Code keeps it, per scope'` (three calls, three files); `'claude mcp remove takes it out, and an unknown name fails with its message'`; `'claude mcp login waits for its gate; a scripted failure exits 1 with the message'`; `'plugin marketplace add, install, list --json and configure answer as Claude Code does'` (the shapes above; `--values-stdin` logs the keys and no value); `'cliFail fails a matching call with its message'`; `'mcp_status lists what the session loaded with the scripted statuses; mcp_reconnect and mcp_toggle change them'`; `'a cli step is a Bash call whose result is the CLI's output'`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/fake-claude.int.test.ts`. Expected: the new tests FAIL, the old ones PASS.
- [ ] **Step 3: Implement** it, `mcp-helpers.ts`, and the README section (one line per script option; "scripted from the SDK's `McpServerStatus` type and the CLI's code, version 2.1.322; nothing recorded").
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 4: running Claude Code's CLI for a tab — `src/main/mcp/claude-cli.ts`

**Files:**
- Create: `src/main/mcp/claude-cli.ts`
- Test: `tests/unit/claude-cli.test.ts`, `tests/integration/claude-cli.int.test.ts`

**Interfaces — Produces:**

```ts
export const CLI_TIMEOUT_MS = 60_000
export const LOGIN_TIMEOUT_MS = 300_000
export interface CliRun { code: number; stdout: string; stderr: string }
export interface CliOptions { cwd: string; env: Record<string, string>; timeoutMs?: number; stdin?: string; signal?: AbortSignal; maxStdout?: number /* 4 MiB */ }
export class CliError extends Error { constructor(readonly reason: 'timeout' | 'cancelled' | 'failed' | 'too-large', message: string) }
/** runs `claude <args>` as the tab's Claude Code is started (spawnChatProcess), with NO_COLOR=1; resolves with any exit code; rejects only with CliError */
export function runClaudeCli(launch: Exclude<ChatLaunch, { how: 'none' }>, args: string[], o: CliOptions): Promise<CliRun>
/** what a failed command says: the last 3 non-empty lines of stderr, else of stdout; ANSI codes stripped; at most 500 chars */
export function cliMessage(r: CliRun): string
/** the command's JSON: the whole trimmed stdout when it parses, else the last line that starts with { or [ and parses (a login shell's banner comes first); undefined when none */
export function jsonOutput(stdout: string): unknown
```

Rules: stdin is written (or ended empty at once: a prompt gets end-of-input). On the time limit or an abort the process tree is killed (Windows `taskkill /pid <pid> /T /F`; elsewhere `process.kill(-pid, 'SIGKILL')`, the process leads its group as `spawnChatProcess` starts it) and the promise rejects with `CliError('timeout', 'Claude Code did not answer in <s> s')` / `CliError('cancelled', 'Cancelled')`. stdout past `maxStdout` → kill, `CliError('too-large', 'Claude Code's answer is too large')`. stderr keeps its first 64 KiB. A spawn error → `CliError('failed', <message>)`. Nothing is logged here.

- [ ] **Step 1: Write the failing tests.** Unit: `'jsonOutput takes the last JSON line after a banner'` (`'Welcome!\n[{"id":"a@b"}]\n'` → array), `'jsonOutput is undefined for text'`; `'cliMessage keeps the last lines of stderr without colours, at most 500 chars'`. Integration (the stand-in through `installFakeClaude` + `resolveChatLaunch`, as `sdk-engine.int.test.ts` resolves it — on Windows this is the `.cmd` shim path): `'runs the command with its arguments, folder and environment'` (an add-json writes `<config>/.claude.json`); `'a JSON argument with quotes, %, ^, &, spaces and a backslash reaches Claude Code intact'` (the logged `argv` equals what was passed); `'stdin carries the values'`; `'a command that never ends is killed at its time limit'` (login with a gate never written, `timeoutMs: 1500` → rejects `timeout` within 5 s, the stand-in's pid from the log not alive); `'an abort ends the command'` (`cancelled`); `'stdout past the cap ends the command'` (launch `{ how: 'direct', file: process.execPath }`, args `['-e', 'process.stdout.write("x".repeat(5e6))']`, `maxStdout: 1 << 20` → `too-large`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/claude-cli.test.ts tests/integration/claude-cli.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 5: what a tab's Claude Code would load — `src/main/mcp/mcp-config.ts`

**Files:**
- Create: `src/main/mcp/mcp-config.ts`
- Test: `tests/unit/mcp-config.test.ts`

**Interfaces — Produces:**

```ts
export const MAX_CONFIG_BYTES = 16 * 1024 * 1024
export interface ConfigPaths { userConfig: string; userSettings: string; installedPlugins: string; projectMcp: string; projectSettings: string; localSettings: string }
/** userConfig: <CLAUDE_CONFIG_DIR || home>/.claude.json; the others under <CLAUDE_CONFIG_DIR || home/.claude>: settings.json, plugins/installed_plugins.json; in the folder: .mcp.json, .claude/settings.json, .claude/settings.local.json */
export function configPaths(env: Record<string, string | undefined>, home: string, folder: string): ConfigPaths
export type ConfigFiles = Record<keyof ConfigPaths, unknown>   // each file parsed, null when missing or unreadable
export interface ConfiguredServer { name: string; scope: McpEditScope; config: Record<string, unknown>
  approval: 'approved' | 'pending' | 'rejected' | null   // project servers only
  disabled: boolean }                                      // in the folder entry's disabledMcpServers: the session's switch, never a change
export interface InstalledPlugin { id: string; version: string; enabled: boolean }   // installed for this folder
export interface TabConfig { servers: ConfiguredServer[]; plugins: InstalledPlugin[] }
export type ConfigChangeKind = 'server-added' | 'server-removed' | 'server-changed' | 'server-approved' | 'plugin-installed' | 'plugin-removed' | 'plugin-updated' | 'plugin-enabled' | 'plugin-disabled'
export interface ConfigChange { kind: ConfigChangeKind; name: string }   // a plugin's name is its id before '@'
export function tabConfig(files: ConfigFiles, folder: string): TabConfig
export function readTabConfig(paths: ConfigPaths, folder: string, readJson: (file: string) => Promise<unknown>): Promise<TabConfig>
/** a reader that stats the file each call and reads and parses it again only when its mtime or size changed; null for missing, unreadable, over MAX_CONFIG_BYTES or not JSON */
export function jsonFileCache(fs: { stat(f: string): Promise<{ mtimeMs: number; size: number } | null>; read(f: string): Promise<string | null> }): (file: string) => Promise<unknown>
export function configKey(config: Record<string, unknown>): string     // JSON with keys sorted at every level
export function diffConfig(loaded: TabConfig, now: TabConfig): ConfigChange[]
/** a tool call that may change what Claude Code loads: Bash or PowerShell whose command runs `claude mcp` / `claude plugin` (claude, claude.exe or claude.cmd) or names .mcp.json, .claude.json, settings.json, settings.local.json, installed_plugins.json or known_marketplaces.json; Edit, Write, MultiEdit or NotebookEdit of a file with one of those names */
export function touchesConfig(name: string, input: unknown): boolean
```

Rules:
- The folder entry of `.claude.json` `projects` is the key equal to the folder by `pathKey` (win32 rules for a Windows-looking folder, as `isTrustedIn`); local servers are its `mcpServers`.
- A `.mcp.json` server's approval: `rejected` when in `disabledMcpjsonServers`, else `approved` when `enableAllProjectMcpServers` is true or the name is in `enabledMcpjsonServers`, else `pending` — each list read from the folder entry and from the three settings files.
- Plugins: an install entry applies when its scope is `user` (or `managed`), or `project` / `local` with `projectPath` equal to the folder by `pathKey`; `enabled` is the last of user settings, project settings, local settings that names the id in `enabledPlugins`; absent everywhere → false.
- `diffConfig` compares the loadable servers by name — user, then approved project, then local, the later scope winning a name — by `configKey`; a name now loadable that was a pending or rejected project server before is `server-approved`. Plugins by id: enabled now and not installed before → `plugin-installed`; installed before and disabled, now enabled → `plugin-enabled`; enabled before and gone → `plugin-removed`; enabled before, now disabled → `plugin-disabled`; enabled both, version differs → `plugin-updated`. Changes of disabled plugins only, `disabledMcpServers`, pending project servers and anything else in the files are no change. Order: servers by name, then plugins by name.

- [ ] **Step 1: Write the failing tests:** `'configPaths follows CLAUDE_CONFIG_DIR, else the home folder'`; `'user, project and local servers apply to the folder, local over project over user'`; `'the folder entry matches in another case, with \\ or / and a trailing separator (Windows rules)'` (key `C:/Work/Acme/`, folder `c:\\work\\acme`, on every OS) — Review Focus 5; `'a project server is pending until approved, from the folder entry or any settings file; disabledMcpjsonServers rejects it'`; `'plugins of another folder are left out; local settings over project over user'` (Review Focus 5); `'diffConfig names each kind of change'` (one case per kind, exact `{ kind, name }`); `'other keys of .claude.json, other folders' entries, disabledMcpServers and a pending project server are no change'` (Review Focus 2); `'malformed files, wrong types and nulls configure nothing and never throw'`; `'jsonFileCache parses a file once per version'` (two calls, same stat → one read; changed mtime → a second read; a size over the cap → null without a read) — Review Focus 2; `'touchesConfig'` (true: Bash `cd x && claude mcp add-json …` on its second line, PowerShell `claude.exe plugin install a@b`, Edit of `/w/.mcp.json`, Write of `C:\\u\\.claude\\settings.local.json`; false: Bash `npm test`, Read of `.mcp.json`, Edit of `src/settings.ts`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/mcp-config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 6: the running session's MCP servers, the chat's idle state, the reload card

**Files:**
- Modify: `src/main/chat/chat-engine.ts`, `src/main/chat/sdk-engine.ts`, `src/main/chat/chat-hub.ts`, `src/main/chat/chat-model.ts`
- Test: `tests/integration/sdk-engine.int.test.ts`, `tests/unit/chat-hub.test.ts`

**Interfaces — Consumes:** `touchesConfig` (Task 5), `patchForMembers` / `itemForMembers` (Task 1), the stand-in (Task 3). **Produces:**

```ts
// chat-engine.ts
export interface McpLiveServer { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; error: string | null; version: string | null
  scope: string | null; source: string | null; transport: string | null; target: string | null; tools: string[] }
// ChatEngine gains
mcpStatus(): Promise<McpLiveServer[]>
reconnectMcp(name: string): Promise<void>
toggleMcp(name: string, enabled: boolean): Promise<void>
// ChatHubDeps gains
sessionReady?(tabId: string): void          // Claude Code answered initialize (after the restart's divider is drawn); not Live.ready, not the engine handler
// ChatHub gains
mcpStatus(tabId: string): Promise<McpLiveServer[] | null>      // null: no running, ready engine
reconnectMcp(tabId: string, name: string): Promise<void>        // throws Error('Claude Code is not running in this tab') with none
toggleMcp(tabId: string, name: string, enabled: boolean): Promise<void>
idle(tabId: string): boolean
configTouchedAt(tabId: string): number | null
reloadCard(tabId: string, card: { title: string; text: string; action: ReloadAction | null } | null): void
restartReport(tabId: string, divider: { text: string; good: string | null }, notices: { text: string; tone: 'info' | 'error' }[]): void
// ChatModel gains
put(item: ChatItem): ChatPatch[]            // add, or set when an item with its id exists
drop(id: string): ChatPatch[]               // remove; the index of the items after it follows
divider(text: string, good?: string): ChatPatch[]
```

Rules:
- `sdk-engine.ts`: `mcpStatus` maps `query.mcpServerStatus()`, each entry checked: `name` non-empty ≤ 200; an unknown `status` drops the entry; `serverInfo.version` ≤ 100; `error` ≤ 2 000; `scope`, `source` ≤ 50; from `config` **only** `type`, `url` (≤ 2 000), `command` (≤ 1 000) and `args` (≤ 50 strings ≤ 500): `target` = the URL, or command and args joined by spaces; headers and env are never read; `tools` = up to 500 names ≤ 200. A non-array answer → `[]`. `reconnectMcp` / `toggleMcp` call `reconnectMcpServer` / `toggleMcpServer`.
- `idle(tabId)`: a running engine, `ready`, history loaded, `turn === 'idle'`, no `activity`, no message waiting for the engine, no open card, no send in `sendChain`.
- `configTouchedAt`: in `apply`, each `tool_use` block of an `assistant` message (`message.content[]`, `{ type: 'tool_use', name, input }`) with `touchesConfig(name, input)` records `d.now()` for the tab; kept across the tab's restarts, dropped with the tab.
- `reloadCard`: the tab's one `reload` item (its id kept on the live chat): `put` it, or `drop` it for `null`; a chat that is not running keeps nothing.
- `restartEnded` remembers the id of the `Session restarted` divider on the live chat; `restartReport` `put`s that divider with the new text and `good` (no divider: only the notices), then adds each notice with action `open-mcp`.
- `becomeReady` calls `d.sessionReady?.(tabId)` after its patches are published. The divider item gets `good` only when it is a string (null: no `good` key).
- Members: `emitToMembers` sends `patchForMembers(p)` of each patch, and `remoteSnapshot` maps its items with `itemForMembers`, so no member gets a `reload` item, a divider's `good` or `open-mcp`.

- [ ] **Step 1: Write the failing tests.** Integration (`sdk-engine.int.test.ts`, the stand-in with a user server whose headers hold `Authorization: Bearer s3cret`): `'mcpStatus lists the servers Claude Code reports, without their headers or env'` (target is the URL; `JSON.stringify(list)` lacks `s3cret`); `'reconnectMcp and toggleMcp reach Claude Code'` (the log holds `mcp_reconnect` with `serverName` and `mcp_toggle` with `enabled: false`). Unit (`chat-hub.test.ts`, give `FakeEngine` the three methods): `'MCP calls reach the running engine; with none mcpStatus is null and the others throw'`; `'idle is false while a turn runs, a card waits, a message waits, a compaction runs or before ready; true after the result'` (Review Focus 3); `'a Bash call running claude mcp add marks the tab; a Read does not'`; `'reloadCard adds one item, updates it in place, and removes it'` (exactly one `reload` item; patches `add`, `set`, `remove`); `'restartReport rewrites the restart divider and adds notices with the MCP button'`; `'a watched tab's members get the reload card as a plain notice'`; `'sessionReady is told after initialize'`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/sdk-engine.int.test.ts tests/unit/chat-hub.test.ts tests/unit/chat-model.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 7: the panel's backend for servers — `src/main/mcp/mcp-hub.ts`

**Files:**
- Create: `src/main/mcp/mcp-hub.ts`
- Test: `tests/unit/mcp-hub.test.ts`

**Interfaces — Consumes:** Tasks 1, 2, 4, 5, 6. **Produces:**

```ts
export interface McpHubDeps {
  launch(): Promise<ChatLaunch>                                   // resolveChatLaunch(settings.claude.command, …)
  tab(tabId: string): Promise<{ env: Record<string, string>; folder: string } | null>   // a local Claude tab: claudeEnv and its canonical folder
  home: string
  readJson(file: string): Promise<unknown>                        // the shared jsonFileCache
  run: typeof runClaudeCli
  session: Pick<ChatHub, 'mcpStatus' | 'reconnectMcp' | 'toggleMcp'>
  changed(tabId: string, madeHere: boolean): void                 // the panel reloads; madeHere: this tab changed the configuration
  hold(tabId: string): void; release(tabId: string): void         // used by Task 10
  openPath(file: string): Promise<string>                         // shell.openPath: '' or its error
  copy(text: string): void
  log: { warn(m: string): void }
}
export class McpHub {
  constructor(d: McpHubDeps)
  servers(tabId: string): Promise<McpServersView | null>
  action(tabId: string, a: McpAction): Promise<McpResult>
  add(tabId: string, req: McpAddRequest): Promise<McpResult>
  removeTab(tabId: string): void                                  // its sign-ins are cancelled
}
```

Rules:
- `servers`: `live` = `session.mcpStatus(tabId) !== null`. Live: one view per live server — scope from `source === 'plugin'` → `plugin` (plugin name: the part between the first and second `:` of a `plugin:<p>:<s>` name, else null), `scope` user/project/local as is, `claudeai` → `claudeai`, `managed`/`enterprise` → `managed`, else `other`; `transport` from the live `transport` (`stdio`, `http`, `sse`, `ws`, else `other`); `target` through `maskUrl` when it is a URL. Then each project server of `readTabConfig` that is `pending` or `rejected` and not listed → `pending-approval`. Not live: every configured server — `disabled` when disabled, `pending-approval` for pending or rejected project servers, else `configured`; `target` = `targetOf` of the config; tools `[]`.
- Actions: `reconnect` → `session.reconnectMcp`; `toggle` → `session.toggleMcp` (no `changed(…, true)`: ruling 1); with no session both answer `{ ok: false, error: 'Claude Code is not running in this tab' }`. `remove` → `['mcp', 'remove', '--scope', scope, '--', name]`. `login` → `['mcp', 'login', '--', name]` with `LOGIN_TIMEOUT_MS` and an AbortController kept per tab and name; success → `session.reconnectMcp` when a session runs; `cancel-login` aborts it → that login answers `{ ok: false, error: 'Cancelled' }` with no reconnect. `logout` → `['mcp', 'logout', '--', name]`, then reconnect when a session runs. `copy-config` → `copy(JSON.stringify({ [name]: maskedConfig(config) }, null, 2))` of the configured server of that scope (none → error `No such server in this scope`). `open-config` → `openPath` of `userConfig` (user, local) or `projectMcp` (project); a non-empty answer is the error.
- `add`: `parseAddInput(req.text)` again; not `servers` → error `Nothing to add: <reason>` (github: `This is a GitHub repository: add it as a plugin marketplace`); `names` must match the servers' count, each `isServerName`, no two the same (`Two servers have the same name`). For each server in order: `['mcp', 'add-json', '--scope', scope, ...(clientSecret ? ['--client-secret'] : []), '--', name, JSON.stringify(config)]`, env with `MCP_CLIENT_SECRET` only when `clientSecret` is given. The first failure stops: `Could not add <name>: <cliMessage>` (with `Added a, b. ` before it when some were added).
- Every error text from the CLI is passed through `maskText(text, secrets)` of the request's secrets (`secretsOf` of every server, plus the client secret) before it is returned. Nothing logs arguments: a failure logs `claude <args[0]> <args[1]> failed (<code>)`.
- Configuration commands of one config folder run one after another (a queue keyed by `pathKey(CLAUDE_CONFIG_DIR || home)`); `login` runs beside the queue. After a successful `remove`, `add`, or a failed `add` that added some: `changed(tabId, true)`; after reconnect, toggle, login, logout: `changed(tabId, false)`.
- `tab()` null → every call answers `null` / `{ ok: false, error: 'Not a Claude tab of this computer' }`; `launch()` with `how: 'none'` → its reason; a `CliError` → its message.

- [ ] **Step 1: Write the failing tests** (fakes for every dep; `run` records `{ args, o }`): `'servers merges the session's statuses with the pending project servers of the configuration'`; `'with no running session the configured servers are listed: disabled off, pending waiting for approval, others configured'`; `'reconnect and toggle go to the session; with none they say Claude Code is not running'`; `'remove runs claude mcp remove with the scope after --, then marks the tab as the maker'`; `'login runs for 5 minutes at most then reconnects; cancel-login ends it with Cancelled and no reconnect'`; `'logout runs, then reconnects'`; `'add re-reads the text, takes the edited names and adds each server with add-json in the scope'` (exact args); `'a client secret goes in MCP_CLIENT_SECRET with --client-secret, never in the arguments'`; `'a failed add stops at that server, and its message has every secret masked, nothing logged with it'` (stderr echoes the JSON with `sk-test-123` → the error holds `••••••••`, not the key; no `log.warn` text holds the key or `add-json`'s JSON) — Review Focus 1; `'commands of one config folder run one after the other'`; `'copy-config copies the JSON with header and env values masked'`; `'open-config opens .claude.json for user and local, .mcp.json for project'`; `'a tab that is not a local Claude tab gets null and an error'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/mcp-hub.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 8: wiring the servers backend — tab environment, guards, IPC

**Files:**
- Modify: `src/main/tab-manager.ts`, `src/main/ipc-guards.ts`, `src/main/index.ts`
- Test: `tests/unit/tab-manager.test.ts`, `tests/unit/ipc-guards.test.ts`, `tests/e2e/mcp-main.spec.ts` (new)

**Interfaces — Produces:**

```ts
// TabManager
claudeEnv(tabId: string): Record<string, string> | null   // the environment the tab's Claude Code starts with now (start() uses it too); null for a shell tab or an unknown id
// ipc-guards.ts
export const isMcpName: (v: unknown) => v is string          // 1-200 chars, no control character, not starting with '-'
export const isMcpAction: (v: unknown) => v is McpAction
export const isMcpAddRequest: (v: unknown) => v is McpAddRequest   // text ≤ 65 536; names ≤ 20, each isServerName; scope in MCP_EDIT_SCOPES; clientSecret null or 1-4096 chars, one line
export const isPluginAction: (v: unknown) => v is PluginAction     // ids /^[A-Za-z0-9][\w.-]*(@[A-Za-z0-9][\w.-]*)?$/ ≤ 200; marketplace names the same without '@'; source: marketplaceSource(v) !== null and ≤ 2000; values ≤ 50 entries, keys /^[\w.-]{1,100}$/, values ≤ 4096 one line
export const isReloadAction: (v: unknown) => v is ReloadAction
```

`index.ts`: one `jsonFileCache` over `fsPromises` (shared with Task 13); `const mcpHub = new McpHub({ launch: () => resolveChatLaunch(settings.claude.command, chatLaunchDeps), tab: async (id) => { const env = tabs.claudeEnv(id); const t = tabs.get(id); return env && t ? { env, folder: await canonicalFolder(t.cwd) } : null }, home: homedir(), readJson, run: runClaudeCli, session: chatHub, changed: (id) => send(IPC.evMcpChanged, id), hold: () => {}, release: () => {}, openPath: (f) => shell.openPath(f), copy: (t) => clipboard.writeText(t), log })`; handlers `IPC.mcpServers`, `IPC.mcpAction`, `IPC.mcpAdd`: `isLocalClaudeTab(tabId)` and the guard, else `null` / `{ ok: false, error: 'Not a Claude tab of this computer' }` (a remote tab included); `onTabClosed` → `mcpHub.removeTab`.

- [ ] **Step 1: Write the failing tests.** Unit: `'claudeEnv is the environment the tab starts with, its account's config folder included; null for a shell tab'`; `'the MCP guards take their shapes and refuse a name starting with -, a control character, an unknown kind or scope, a multi-line secret'`. E2E `tests/e2e/mcp-main.spec.ts` (`launchChatTab`, `mcp-helpers.ts`, calls through `page.evaluate(() => window.ct…)`):
  - `'the servers of a chat tab come from its running session and its configuration'`: `.claude.json` with user `github` (script `mcp.github: { tools: ['a','b','c'], version: '1.4.2' }`), `.mcp.json` with `postgres` not approved → `live: true`, github `connected`, tools 3, version `1.4.2`, scope `user`; postgres `pending-approval`, scope `project`.
  - `'ct.mcpAdd adds through Claude Code in the scope asked'`: user scope → `.claude.json` `mcpServers.context7` equals the parsed config; the last `cliCalls` argv is `['mcp','add-json','--scope','user','--','context7', <json>]`, `secretEnv` false.
  - `'an OAuth client secret goes in the environment, never in the arguments'`: `clientSecret: 'cs-123'` → `secretEnv` true and no argv entry holds `cs-123`.
  - `'a sign-in reconnects the server in the running session and does not restart it'`: `mcpLogin.sentry.gate`; the login call is pending until the test writes the gate; then `{ ok: true }`, the log holds `mcp_reconnect` `sentry`, `chatStarts` is 1.
  - `'with no running session a session action says so'` (script `beforeInit: [{ crash: 1 }]`): `mcpServers` has `live: false`; reconnect answers `Claude Code is not running in this tab`.
  - `'an unknown tab gets null'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/tab-manager.test.ts tests/unit/ipc-guards.test.ts` and `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/mcp-main.spec.ts --reporter=line --workers=2"`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, and `tests/e2e/chat.spec.ts tests/e2e/restart.spec.ts` through the lock. Expected: PASS. (R's Tasks 15-17 may start now.)
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 9: reading the plugin commands — `src/main/mcp/plugin-cli.ts`

**Files:**
- Create: `src/main/mcp/plugin-cli.ts`
- Test: `tests/unit/plugin-cli.test.ts`

**Interfaces — Produces:**

```ts
export interface InstalledEntry { id: string; name: string; marketplace: string; version: string; scope: string; enabled: boolean; projectPath: string | null; mcpServers: number; errors: string[] }
export function parseInstalled(v: unknown): InstalledEntry[]          // `plugin list --json` (an array) or the `installed` of `--available`
export function parseAvailable(v: unknown): PluginOffer[]             // the `available` of `--available`: { pluginId, name, description, marketplaceName, version, installCount }
export interface MarketplaceEntry { name: string; source: string; installLocation: string | null }
export function parseMarketplaces(v: unknown): MarketplaceEntry[]     // github → repo; git, url → url; directory, file → path
export function parseCatalog(v: unknown): Map<string, { version: string | null; description: string }>   // a marketplace.json's plugins by name
export function parseConfigure(v: unknown): PluginOption[]            // `configure --json`: schema keys with required true not in `configured`
export function pluginsView(installed: InstalledEntry[], available: PluginOffer[], marketplaces: MarketplaceEntry[], catalogs: Map<string, Map<string, { version: string | null; description: string }>>, folder: string): PluginsView
```

Rules: `id` splits at the last `@` into name and marketplace; a `version` missing → `unknown`; `errors` are strings ≤ 2 000 (at most 20). `pluginsView` keeps the entries that apply to the folder (user scope, or project/local with `projectPath` equal by `pathKey`), sorted by name; `update` = the catalog version when it differs from the installed one and the installed one is not `unknown` (ruling 2); `description` from the catalog (`''` when none). `available` sorted by marketplace then name; `marketplaces` as `{ name, source }` sorted by name. Every field checked and capped; anything malformed is skipped; nothing throws.

- [ ] **Step 1: Write the failing tests:** `'parseInstalled reads list --json and the installed part of --available'`; `'parseAvailable keeps the install counts'`; `'parseMarketplaces names each source as the person knows it'`; `'parseConfigure gives the required options not set yet'`; `'an installed plugin whose catalog names another version has an update; unknown has none'`; `'plugins installed for another folder are left out'`; `'malformed output gives empty lists'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/plugin-cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 10: the panel's backend for plugins

**Files:**
- Modify: `src/main/mcp/mcp-hub.ts`, `src/main/index.ts` (two handlers)
- Test: `tests/unit/mcp-hub.test.ts`, `tests/e2e/mcp-main.spec.ts`

**Interfaces — Produces:** `McpHub.plugins(tabId: string): Promise<PluginsView | { error: string } | null>`, `McpHub.pluginAction(tabId: string, a: PluginAction): Promise<McpResult>`; handlers `IPC.mcpPlugins`, `IPC.mcpPluginAction` (guards as Task 8).

Rules:
- `plugins`: `['plugin', 'list', '--json', '--available']` and `['plugin', 'marketplace', 'list', '--json']` (both through the config folder's queue), each `jsonOutput`; the catalogs: `readJson(<installLocation>/.claude-plugin/marketplace.json)`. Kept 30 s per config folder; any plugin action drops it. A failed or unparsable list → `{ error: cliMessage }`.
- `install` → `['plugin', 'install', '--scope', 'user', '--', id]`; on success `['plugin', 'configure', '--json', '--', id]` → `parseConfigure`; options left → `hold(tabId)` first, then `changed(tabId, true)`, answer `{ ok: true, options }`. `configure` → `['plugin', 'configure', '--values-stdin', '--', id]` with `stdin: JSON.stringify(values)` (values never in args or logs), then `release(tabId)`, `changed(tabId, true)`; its error masks the values (`maskText`). `configure-later` → `release(tabId)`. `uninstall`, `enable`, `disable`, `update` → `['plugin', <kind>, '--', id]`, then `changed(tabId, true)`. `marketplace-add` → `['plugin', 'marketplace', 'add', '--', marketplaceSource(source)]`; the new name = the one in the list after that was not in the list before → `{ ok: true, marketplace }`. `marketplace-remove` / `marketplace-update` → `['plugin', 'marketplace', 'remove' | 'update', '--', name]`. A failure → `{ ok: false, error: cliMessage }`.

- [ ] **Step 1: Write the failing tests.** Unit: `'plugins runs the two lists once in the tab's folder and environment and keeps them 30 s; an action drops them'`; `'install reads the plugin's options and holds the restart while required ones are unset'` (`hold` before `changed`); `'configure sends the values on stdin, never as arguments, then releases'`; `'marketplace-add takes a GitHub link as owner/repo and names the marketplace it added'`; `'enable, disable, update, uninstall and the marketplace commands run and mark the tab as the maker'`; `'a failed command answers its message'`. E2E (`mcp-main.spec.ts`, script `marketplaces: [{ name: 'acme-tools', source: 'acme/tools', plugins: [{ name: 'ci-watch', description: 'Follows CI runs and explains what failed.', version: '1.0.0', installs: 812, options: [{ key: 'token', title: 'API token', required: true, sensitive: true }] }] }]`): `'ct.mcpPluginAction adds a marketplace from a GitHub link and ct.mcpPlugins lists its plugins'` (`https://github.com/acme/tools` → `marketplace: 'acme-tools'`, available `ci-watch@acme-tools` with installs 812); `'an install with a required option returns it, and configure sends the value through stdin'` (options `[{ key: 'token', … }]`; after configure the last `cliCalls` has `stdinKeys: ['token']` and no argv holds the value).
- [ ] **Step 2: Run** the unit file and the e2e spec through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them. Expected: PASS. (R's Task 18 may start now.)
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 11: the restart coordinator — `src/main/mcp/restart-coordinator.ts`

**Files:**
- Create: `src/main/mcp/restart-coordinator.ts`
- Test: `tests/unit/restart-coordinator.test.ts`

**Interfaces — Consumes:** `TabConfig`, `diffConfig`, `ConfigChange` (Task 5); `McpLiveServer` (Task 6). **Produces:**

```ts
export const SETTLE_MS = 1500, RECHECK_MS = 1000, REPORT_POLL_MS = 500, REPORT_LIMIT_MS = 20_000
export type ReloadMode = 'auto-now' | 'auto-later' | 'manual' | 'restarting'
export interface ReloadCardView { title: string; text: string; action: ReloadAction | null }
export function reloadView(changes: ConfigChange[], mode: ReloadMode): ReloadCardView
export function reportOf(changes: ConfigChange[], servers: McpLiveServer[], final: boolean): { divider: { text: string; good: string | null }; notices: { text: string; tone: 'info' | 'error' }[] } | null   // null: a reported server is still pending and !final
export interface CoordinatorDeps {
  read(tabId: string): Promise<TabConfig | null>
  idle(tabId: string): boolean
  touchedAt(tabId: string): number | null
  restart(tabId: string): void
  card(tabId: string, card: ReloadCardView | null): void
  status(tabId: string): Promise<McpLiveServer[] | null>
  report(tabId: string, divider: { text: string; good: string | null }, notices: { text: string; tone: 'info' | 'error' }[]): void
  changed(tabId: string): void
  now(): number
}
export class RestartCoordinator {
  constructor(d: CoordinatorDeps)
  started(tabId: string): void       // a chat starts: what it loads is read now (loadedAt = now()); the changes pending before it are what its report covers
  ready(tabId: string): void         // the report of what came up starts
  compareAll(): Promise<void>        // a watched file changed: every tracked tab
  turnEnded(tabId: string): void     // compare this tab, then a due restart may run
  madeHere(tabId: string): void      // a panel action of this tab changed the configuration: compare every tab now, this one the maker
  notNow(tabId: string): boolean; restartNow(tabId: string): boolean   // false: no card
  hold(tabId: string): void; release(tabId: string): void
  tracked(): string[]
  removeTab(tabId: string): void
}
```

Rules:
- Comparing a tab: `read` (a sequence number per tab: an answer older than the latest is dropped) → `diffConfig(loaded, now)`. Empty → the card goes (`card(tab, null)`), nothing pending. Not empty → pending = the changes; the tab is **auto** when it is the maker of this comparison (`madeHere`), or `touchedAt(tab) >= loadedAt`, or it was auto already — unless Not now was pressed; otherwise **manual**. `card(tab, reloadView(changes, mode))` and `changed(tab)` when the card changes.
- An auto tab with changes, no hold and not restarting: a timer of `SETTLE_MS` from the last change, then: idle → `card(…, 'restarting')`, `restart(tab)`; not idle → the card says `auto-later` and it tries again every `RECHECK_MS` (and at `turnEnded`). Several changes within the settle time make one restart. Nothing is restarted while a comparison of the tab is in flight.
- `notNow` → manual for good (until the next start); `restartNow` → restarts at once when idle, else as auto-later. `hold` / `release` count; a held tab restarts only at zero.
- `started`: the tab's state starts again (no card, nothing pending, Not now forgotten); `report` is due for the changes that were pending (or the restart's own). `ready` with changes to report: `status` every `REPORT_POLL_MS` until `reportOf(…, false)` is not null, or `REPORT_LIMIT_MS` passed (`reportOf(…, true)`), then `report(…)` and `changed(tab)`; a tab removed or started again meanwhile stops the polling.
- `reloadView` (exact copy): titles for one change — `New MCP server: <n>`, `MCP server removed: <n>`, `MCP server changed: <n>`, `MCP server approved: <n>`, `New plugin: <n>`, `Plugin removed: <n>`, `Plugin updated: <n>`, `Plugin turned on: <n>`, `Plugin turned off: <n>`; several — `<count> changes: <first three names, ", ">` plus ` +<rest>` when more. `it` / `them` by count; the verb is `drop` when every change is a removal or a turn-off, else `load`. Texts: auto-now and restarting `The session restarts now to load it — the conversation goes on`; auto-later `The session restarts to load it when Claude finishes — the conversation goes on`; manual `Restart the session to load it — the conversation goes on` (verb and pronoun substituted). Actions: auto-* `not-now`, manual `restart`, restarting `null`.
- `reportOf`: for each `server-added` / `server-changed` / `server-approved` name: `connected` → divider parts `<n> connected` and `<k> tool(s)`; `failed` → notice error `<n> failed to start: <error>` (`<n> failed to start` without an error); `needs-auth` → notice info `<n> needs sign-in`; `pending` → not final: null, final: notice info `<n> is still connecting`; absent → notice error `<n> did not load`; each `plugin-installed` / `plugin-enabled` / `plugin-updated` → part `<n> plugin on`. Divider text: `Session restarted` and the parts, joined by ` · ` (`Session restarted · context7 connected · 2 tools`); `good` = the first `… connected` part.

- [ ] **Step 1: Write the failing tests** (fake deps, `vi.useFakeTimers()`): `'a change made in this tab while it is idle restarts it once after the settle time'`; `'a change made by Claude during a turn waits for the turn, then restarts'` (touchedAt after loadedAt, idle false → card `auto-later`; `turnEnded` + idle → one restart); `'several changes close together make one restart'`; `'a waiting card, queued messages or a compaction keep the restart waiting'` (idle false for 10 s → no restart; idle → restart) — Review Focus 3; `'another tab affected by the change gets the card with Restart and is not restarted'`; `'a change undone before the restart takes the card away'`; `'Not now keeps the card with Restart; restartNow restarts'`; `'a hold keeps the restart until it is released'`; `'after a restart the divider names what came up and failed servers get notices'` (status `pending` twice then `connected` with 2 tools → report `Session restarted · context7 connected · 2 tools`, good `context7 connected`); `'a server still pending after 20 s is still connecting'`; `'a file change with nothing relevant shows nothing and restarts nothing'` — Review Focus 2; `'an older read that answers last is ignored'`; `'reloadView words each kind'` (every title; drop/load; it/them).
- [ ] **Step 2: Run** `npx vitest run tests/unit/restart-coordinator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 12: watching the configuration files — `src/main/mcp/config-watch.ts`

**Files:**
- Create: `src/main/mcp/config-watch.ts`
- Test: `tests/integration/config-watch.int.test.ts`

**Interfaces — Produces:** `export class ConfigWatch { constructor(onChange: () => void, o?: { debounceMs?: number /* 300 */ }); setFiles(files: string[]): void; close(): void }`.

Rules: one non-recursive `fs.watch` per folder holding a file (a folder that does not exist is skipped, tried again at the next `setFiles`); an event whose file name equals a watched name of that folder (by `pathKey`; an event with no name counts) arms one debounced `onChange`; folders no longer named are unwatched; a watch error closes that watch quietly. The turn-end comparison covers anything the watch misses.

- [ ] **Step 1: Write the failing tests** (temp folders): `'a write to a watched file calls back once after the debounce; another file of the folder does not'`; `'a file replaced by a rename (an atomic write) is seen'`; `'a missing folder is skipped and watched once setFiles names it again after it exists'`; `'close stops the callbacks'`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/config-watch.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 13: wiring the restart — coordinator, watch, card button

**Files:**
- Modify: `src/main/index.ts`
- Test: `tests/e2e/mcp-restart.spec.ts` (new)

Wiring in `index.ts`:
- `const coordinator = new RestartCoordinator({ read, idle: (id) => chatHub.idle(id), touchedAt: (id) => chatHub.configTouchedAt(id), restart: (id) => { tabs.restart(id, { live: true }).catch((e: Error) => log.warn(`cannot restart tab: ${e.message}`)) }, card: (id, c) => chatHub.reloadCard(id, c), status: (id) => chatHub.mcpStatus(id), report: (id, d, n) => chatHub.restartReport(id, d, n), changed: (id) => send(IPC.evMcpChanged, id), now: () => Date.now() })`, where `read(id)` = `readTabConfig(configPaths(env, homedir(), folder), folder, readJson)` with `claudeEnv` and `await canonicalFolder(cwd)`, null for a tab that is not a local chat-view Claude tab.
- `const configWatch = new ConfigWatch(() => void coordinator.compareAll())`; after each `started` and `removeTab`, `configWatch.setFiles` gets every `configPaths` value of `coordinator.tracked()`.
- `startChat` → `coordinator.started(req.tab.id)`; `ChatHubDeps.sessionReady` → `coordinator.ready(id)` and `send(IPC.evMcpChanged, id)`; `setWorking(id, false)` → `coordinator.turnEnded(id)`; `onTabClosed` and an `updated` tab whose view is not `chat` → `coordinator.removeTab(id)`; `McpHub` deps: `changed: (id, madeHere) => { if (madeHere) coordinator.madeHere(id); send(IPC.evMcpChanged, id) }`, `hold` / `release` → the coordinator's; `app` quit → `configWatch.close()`.
- `IPC.mcpReload`: `isLocalClaudeTab` and `isReloadAction` → `notNow` / `restartNow`; else false.

- [ ] **Step 1: Write the failing e2e tests** (`launchChatTab`, `mcp-helpers.ts`; read the chat through `ct.chatSnapshot`; the script below unless a test says otherwise: `mcp: { context7: { tools: ['resolve-library-id', 'get-library-docs'] } }`, turn `add context7` = `[{ cli: ['mcp','add-json','--scope','user','--','context7','{"type":"http","url":"https://mcp.context7.com/mcp"}'] }, { gate: 'answer-done' }, { text: 'context7 is added for all your projects.' }]`):
  - `'Claude adds a server: the chat restarts after the answer and says what came up'`: send `add context7`; poll for a `reload` item titled `New MCP server: context7` with action `not-now` and text `The session restarts to load it when Claude finishes — the conversation goes on`; `chatStarts` is 1 while the gate holds (**the answer is not cut** — Review Focus 3); write the gate; poll `chatStarts` 2 with `--resume <session id>`; poll a divider `Session restarted · context7 connected · 2 tools`; the text `context7 is added for all your projects.` is in the snapshot.
  - `'several changes close together make one restart'` (two `cli` steps, two servers; `chatStarts` is 2 and still 2 three seconds later).
  - `'Not now keeps the card with Restart, and Restart restarts'` (`ct.mcpReload(tabId, 'not-now')` while the gate holds → action `restart`; after the gate `chatStarts` stays 1 for 3 s; `ct.mcpReload(tabId, 'restart')` → 2).
  - `'another chat on the same config folder gets the card with Restart and is not restarted'` (a second Claude tab in another temp folder, same `CLAUDE_CONFIG_DIR`; its session's starts stay 1).
  - `'a local-scope change of another folder leaves this chat alone'` (`runStandIn` in another folder with `--scope local`; after 3 s no `reload` item).
  - `'a change from outside the chats shows the card with Restart in an idle chat'` (`runStandIn` in the work folder, user scope).
  - `'Claude Code rewriting its own .claude.json shows no card'` (the test writes `.claude.json` with `numStartups: 7` and another folder's `projects` entry; after 3 s no `reload` item) — Review Focus 2.
  - `'a server that fails after the restart says why with a button to the panel'` (`mcp.broken: { status: 'failed', error: 'spawn uvx ENOENT' }`, a `cli` add of `broken` → a notice `broken failed to start: spawn uvx ENOENT`, tone `error`, action `open-mcp`).
  - `'removing a server through the panel restarts the chat'` (`ct.mcpAction(tabId, { kind: 'remove', name: 'github', scope: 'user' })` → `chatStarts` 2).
- [ ] **Step 2: Run** it through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** it, plus `tests/e2e/mcp-main.spec.ts tests/e2e/chat-activity.spec.ts tests/e2e/restart.spec.ts` through the lock, `npm run typecheck`, `npm test`. Expected: PASS. (R's Task 19 may start now.)
- [ ] **Step 5:** Leave the changes uncommitted.

---

## Stream R (renderer)

Board values for every R task: panel 420 px, `--sheet`, left hairline `--line`; its top padding 14 px 16 px 0. Segmented control: `--raised`, border `1px solid --line-2`, radius 10 px, padding 3 px, gap 2 px; segments padding 6 px 0, radius 7 px, 500 12.5 px `--text-3`; the chosen one `--raised-2`, `--text`, `box-shadow: 0 1px 0 #ffffff08 inset`; the count after it 400 `--text-3`, margin-left 4 px. Stat boxes (three, gap 8 px, margin 14 px 0 12 px): border `1px solid --line-2`, radius 10 px, padding 8 px 10 px, `--raised`; number 600 17 px tabular-nums (`--green`, `--amber`, `--red`); label 11 px `--text-3`. Filter: border `--line-2`, radius 9 px, padding 7 px 10 px, `--term`. Group head: 600 10.5 px, letter-spacing .08em, uppercase, `--text-3`, padding 12 px 8 px 6 px, a 1 px `--line` rule filling the rest. Row: gap 10 px, padding 8 px, radius 9 px, hover `--raised`; status dot 8 px (`--green` connected, `--amber` needs sign-in and waiting for approval, `--red` failed, `#55555E` off, `--text-3` connecting and configured); icon 28 px, radius 8 px, 600 11 px monospace initials on a colour (off: `#3A3A43` with `--text-2`); name 500, ellipsis (off: `--text-3`); second line 11.5 px `--text-3` with the badge (10.5 px, padding 1 px 6 px, radius 5 px, border `--line-2`, `--text-2`). Buttons: padding 5 px 10 px, radius 8 px, border `--line-2`, `--raised-2`, `--text`, 12 px; primary `--accent` with `#1A1A1A` 600; ghost transparent `--text-3`; warn border `#E5B56755`, `--amber`, background `#E5B5670F`. Error box: margin 2 px 8 px 6 px 46 px, 11.5 px/1.5 monospace, `--red` on `#F2867E0D`, border `#F2867E33`, radius 8 px, padding 6 px 9 px. Tool chips: margin 0 8 px 6 px 46 px, gap 5 px; 11 px monospace `--text-2` on `--raised`, border `--line-2`, radius 6 px, padding 2 px 7 px. Switch: 30 × 18, radius 999 px; on `--green` with a 14 px white knob at the right; off `--line-2` with a `#9A9AA3` knob at the left; a `button` with `role="switch"` and `aria-checked`. Footer: padding 12 px 16 px 14 px, top hairline `--line`, hint 11.5 px `--text-3` at the right. Styles go in `src/renderer/mcp/mcp.css`, imported by `mcp-panel.ts`.

### Task 14: the panel's view logic — `src/renderer/mcp/mcp-view-model.ts`

**Files:**
- Create: `src/renderer/mcp/mcp-view-model.ts`
- Test: `tests/unit/mcp-view-model.test.ts`

**Interfaces — Produces** (pure: no DOM at import):

```ts
export interface ServerGroup { label: 'Needs attention' | 'Connected' | 'Configured' | 'Off'; servers: McpServerView[] }
export function serverGroups(view: McpServersView, filter: string): ServerGroup[]   // empty groups left out
export function serverStats(view: McpServersView): { connected: number; needSignIn: number; failed: number }
export function matchedTools(s: McpServerView, filter: string): string[] | null    // null: no filter, or the name matched
export function badgeOf(s: McpServerView): string | null
export function detailOf(s: McpServerView): string
export type RowMenuItem = 'reconnect' | 'sign-out' | 'tools' | 'copy-config' | 'open-config' | 'remove'
export function rowActions(s: McpServerView, live: boolean): { primary: 'sign-in' | 'retry' | 'approve' | null; reconnect: boolean; toggle: boolean | null; menu: RowMenuItem[] }
export function initials(name: string): string
export function iconColor(name: string): string
export function countLabel(n: number): string
export function pluginLine(p: PluginView): string
export function editScope(s: McpServerView): McpEditScope | null
```

Rules: groups — Needs attention: `needs-auth`, `failed`, `pending-approval`; Connected (live) or Configured (not live): `connected`, `pending`, `configured`; Off: `disabled`; each sorted by name, case-insensitive. Filter: case-insensitive substring of the name or of any tool. `badgeOf`: `User`, `Project`, `Local`, `Plugin · <plugin>`, `claude.ai`, `Managed`, null for other. `detailOf`: connected `<n> tool(s)` plus ` · v<version>` when known; needs-auth `Needs sign-in`; failed `Failed to start`; pending `Connecting…`; pending-approval `Waiting for approval`; disabled `Disabled`; configured its `target`. `rowActions`: needs-auth → primary `sign-in`; failed → `retry`; pending-approval → `approve`; `reconnect` (the ↻ ghost) for connected when live; `toggle`: `true` for connected/pending/needs-auth/failed and `false` for disabled when live, else `null`; menu: `reconnect` when live and not connected-ghosted, `sign-out` for http/sse or claudeai servers that are connected or need sign-in, `tools` when it has tools, then `copy-config`, `open-config`, `remove` when `editScope` is not null (user, project, local). `initials`: the first letter upper case and the first letter after a `-`, `_` or `.` (else the second character) lower case (`context7` → `Co`, `code-review-kit` → `Cr`). `iconColor`: one of `#5E6AD2 #8D7BD8 #336791 #63C08F #2EAD33 #D97757 #7FA7F5 #E5B567` by a sum of the name's char codes. `countLabel`: `812`, `2.4k`, `12k`, `1.2M`. `pluginLine`: `<marketplace> · <version>` plus ` · <n> MCP server(s)` when n > 0; disabled `<marketplace> · disabled`.

- [ ] **Step 1: Write the failing tests:** one per function with the values above (the board's frame 1 list as the fixture: linear claude.ai needs-auth, sentry user needs-auth, postgres project failed, github user connected 41 tools v1.4.2, context7 2 tools, playwright project 21 tools, claudeterm plugin 6 tools, memory disabled → groups and order as on the board, stats 4 connected / 2 need sign-in / 1 failed); `'the filter finds a server by a tool and lists only those tools'`; `'not live: Configured, no switch, no reconnect'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/mcp-view-model.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 15: the panel, its servers list, the header button, `/mcp` and `/plugin`

**Files:**
- Create: `src/renderer/mcp/mcp-panel.ts`, `src/renderer/mcp/mcp-servers.ts`, `src/renderer/mcp/mcp.css`
- Modify: `src/renderer/side-panel.ts`, `src/renderer/sheet-header.ts`, `src/renderer/icons.ts` (add `plug`: `<path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"></path>`), `src/renderer/main.ts`, `src/renderer/chat/slash-menu.ts`, `src/renderer/chat/chat-composer.ts`, `src/renderer/chat/chat-view.ts`
- Test: `tests/unit/slash-route.test.ts`, `tests/e2e/mcp-panel.spec.ts` (new), `tests/e2e/chat-devices.spec.ts` (one test)

**Interfaces — Consumes:** Task 1's API, Task 14. **Produces:**

```ts
// side-panel.ts: PanelTab gains 'mcp' (label 'MCP · Plugins', MAX_SHARE 0.7, unavailable by default); main.ts passes width 420
// sheet-header.ts: a toggle 'tab-mcp-toggle', label 'MCP · Plugins', title 'MCP servers and plugins', icon 'plug', no badge
setMcp(available: boolean, visible: boolean): void          // SheetHeaderCallbacks gains toggleMcp(): void
// slash-menu.ts: SlashRoute's native names gain 'mcp' | 'plugin'
// chat-view.ts: ChatViewOptions gains
openMcp(section: McpSection): string | null                 // null: the panel opened; a string: the line the composer shows, and the text goes to Claude Code as typed
// mcp-panel.ts
export interface McpPanelCallbacks {
  servers(tabId: string): Promise<McpServersView | null>; action(tabId: string, a: McpAction): Promise<McpResult>
  add(tabId: string, req: McpAddRequest): Promise<McpResult>
  plugins(tabId: string): Promise<PluginsView | { error: string } | null>; pluginAction(tabId: string, a: PluginAction): Promise<McpResult>
  approve(tabId: string): void                              // Task 16
}
export class McpPanel {
  constructor(body: HTMLElement, panel: SidePanel, cb: McpPanelCallbacks)
  show(tabId: string | null): void; open(section: McpSection): void; refresh(): void; focusFilter(): void
}
```

Rules:
- `routeSlash`: `/mcp` → native `mcp`; `/plugin`, `/plugins` → native `plugin`; with arguments they are sent as today. The composer runs a native mcp/plugin at once (a turn may run): `openMcp(section)`; null → the draft is cleared; a string → the text is sent as typed and the composer's note line shows the string.
- `main.ts`: `openMcp` for a local tab → `mcpPanel.show(tabId)`, `mcpPanel.open(section)`, `sidePanel.open('mcp')`, `mcpPanel.focusFilter()`, null; for a remote tab → `Manage MCP on <device name>`. `sidePanel.setAvailable('mcp', <the active tab is a local Claude tab in its chat view>)` on activation, on a view switch and on a tab update; the header button shows only then and toggles `sidePanel.toggle('mcp')`; `refreshPanelButtons` calls `setMcp`. `sidePanel.onChange` → `mcpPanel.refresh()`; `ct.onMcpChanged(id)` → `refresh()` when `id` is the tab in front; `activate` → `mcpPanel.show(tabId)`.
- Panel top: the segmented control `MCP servers <n>` | `Plugins <n>` (counts once known), then for servers: the three stats (`connected`, `need sign-in`, `failed`) when live, else the note `Claude Code is not running in this tab: statuses show once it runs`; the filter (placeholder `Filter servers and tools`, Esc clears it). The list (`mcp-servers.ts`): groups of `serverGroups`, rows as the board (dot, icon, name, badge and `detailOf`, the action area of Task 16), a failed server's `error` in the error box under its row, the tools of an unfolded row (a click on the name area unfolds it; `matchedTools` under a filter unfolds it) as chips, at most 200 then `+<rest>`. Footer: `＋ Add server` (primary; Task 17 opens the dialog) and the hint `Changes restart the session`; on Plugins the hint `Installs and changes restart the session` (Task 18 fills the section; here it shows `Loading plugins…` then nothing). Loading state `Loading…`; `servers()` null → the panel shows nothing but the note `Not a Claude tab of this computer`. While shown, a `pending` server asks again every 2 s. All controls are buttons or inputs in DOM order (keyboard reachable); every string from main is set with `textContent`.

- [ ] **Step 1: Write the failing tests.** Unit `slash-route.test.ts`: `/mcp` → `{ to: 'native', name: 'mcp' }`; `/plugin` and `/plugins` → `plugin`; `/mcp enable x` → send. E2E `mcp-panel.spec.ts`:
  - `'the header button opens MCP · Plugins beside the chat and closes it'` (`.tab-mcp-toggle` → `.panel-mcp` visible, the panel title `MCP · Plugins`, width 420; again → hidden).
  - `'/mcp opens the servers and sends nothing to Claude Code'` (`userMessages(log)` lacks `/mcp`; the composer is empty; the filter has the focus).
  - `'/plugin opens the panel on Plugins'`.
  - `'servers are grouped by what they need, with their source, tools and error'` (user `github` connected 3 tools v1.4.2, user `sentry` needs-auth, project `postgres` approved and failed `spawn uvx ENOENT`, user `memory` disabled via `disabledMcpServers` → group heads `NEEDS ATTENTION`, `CONNECTED`, `OFF` in order; sentry and postgres under the first; `github` row `User` and `3 tools · v1.4.2`; the error box text; stats 1 / 1 / 1).
  - `'the filter finds a server by one of its tools'`.
  - `'with no running session the panel lists the configured servers'` (`beforeInit: [{ crash: 1 }]` → the note, group `CONFIGURED`, no switch).
  - `'a terminal-view tab has no MCP button'` (switch the tab to the terminal → `.tab-mcp-toggle` hidden).
  - `chat-devices.spec.ts`: `"a member's /mcp goes to the host's Claude Code and says where to manage MCP"` (the member's composer note `Manage MCP on <host name>`; the stand-in's `userMessages` hold `/mcp`; the member has no MCP button).
- [ ] **Step 2: Run** `npx vitest run tests/unit/slash-route.test.ts`, then `mcp-panel.spec.ts` and `chat-devices.spec.ts` through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, plus `tests/e2e/side-panel.spec.ts tests/e2e/sheet.spec.ts tests/e2e/chat-slash.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 16: what a server row does

**Files:**
- Modify: `src/renderer/mcp/mcp-servers.ts`, `src/renderer/mcp/mcp.css`, `src/renderer/chat/chat-view.ts` (`runInTerminal`), `src/renderer/main.ts` (the `approve` callback)
- Test: `tests/e2e/mcp-panel.spec.ts`

**Interfaces — Produces:** `ChatView.runInTerminal(line: string): void` — the line goes to the terminal as a notice's line does (`composer.openNoticeLine`: it waits for the turn, and asks first when background tasks would stop). `approve(tabId)` in `main.ts` → that chat's `runInTerminal('/mcp')`.

Rules (from `rowActions`):
- `Sign in` (warn): `login`; while it runs the row shows `Waiting for the browser…` and `Cancel` (`cancel-login`); the state is kept per tab and server across reloads. `↻ Retry` (failed) and the ↻ ghost: `reconnect`. The switch: `toggle` with the new state, `aria-label` `Turn <name> off` / `Turn <name> on`. `Approve in the terminal`: `approve`. The `···` menu (ghost button, `aria-label` `More for <name>`, a list of buttons, Esc and a click outside close it): `Reconnect`, `Sign out` (`logout`), `Show tools` / `Hide tools`, `Copy config`, `Open config file`, `Remove`. `Remove` asks in the row: `Remove <name>?` with `Remove` (red text) and `Cancel`.
- While an action runs, the row's buttons are disabled. A failed action shows its error under the row in the error box until the row's next action — never a toast. Success reloads the list.

- [ ] **Step 1: Write the failing e2e tests** (in `mcp-panel.spec.ts`): `'Sign in waits for the browser, then reconnects the server in the running session'` (`mcpLogin.sentry.gate`; the row shows `Waiting for the browser…`; the gate → the row shows `sentry` connected, the log holds `mcp_reconnect`; `chatStarts` 1); `'Cancel ends a sign-in'` (back to `Sign in`; no `mcp_reconnect`) — Review Focus 4; `'Retry reconnects a failed server'`; `'the switch turns a server off in the running session without a restart'` (`mcp_toggle` `enabled: false`; the row under `OFF`; `chatStarts` 1); `'Remove asks, then takes the server out and the session restarts'`; `'a failed command shows its message next to the action'` (`cliFail: { 'mcp remove': 'Permission denied: .mcp.json' }` → the error box under the row; no `.toast`); `'Approve in the terminal opens the terminal with /mcp'` (a pending project server → the terminal shows `you said: /mcp`); `'Copy config copies the JSON with the secrets hidden'` (`@alone`, `keepingClipboard`; a server with header `Authorization: Bearer s3cret` → the clipboard holds `"Authorization": "••••••••"` and not `s3cret`); `'Open config file opens the scope's file'` (`shell.openPath` recorded as in `docs.spec.ts` → `<config>/.claude.json`).
- [ ] **Step 2: Run** the spec through the lock. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 17: Add a server

**Files:**
- Create: `src/renderer/mcp/mcp-add-dialog.ts`
- Modify: `src/renderer/mcp/mcp-panel.ts` (the footer button), `src/renderer/mcp/mcp.css`
- Test: `tests/e2e/mcp-add.spec.ts` (new)

**Interfaces — Consumes:** Task 2 (`parseAddInput`, `previewRows`, `secretsOf`, `maskText`, `isServerName`, `MASK`), `ct.mcpAdd`, `ct.mcpPluginAction`. **Produces:** `export function openAddDialog(o: { tabId: string; add(req: McpAddRequest): Promise<McpResult>; addMarketplace(source: string): void; done(): void }): void`.

Rules (board frame 2): a scrim over the window (`#05050690`, `backdrop-filter: blur(2px)`), the dialog 600 px (narrower windows `calc(100% - 24px)`), radius 16 px, `--sheet`, border `--line-2`, shadow `0 40px 100px #000c`; head padding 18 px 20 px 4 px, title 15 px 600 `Add an MCP server`, a ✕ ghost button; body padding 10 px 20 px 18 px, gap 14 px; labels 11.5 px `--text-3`. The field (label `Paste a command, a server URL or a JSON config`): a text area, border `--accent` with `box-shadow: 0 0 0 3px #D9775722` when focused, radius 10 px, `--term`, padding 10 px 12 px, 12 px/1.6 monospace, min-height 64 px; it has the focus on open. On each input the text is parsed. **Masking (ruling 4):** on paste and on blur, a recognised text with secrets moves into the dialog's memory, the text area is emptied and hidden, and a read-only view shows `maskText(text, secrets)` with a `Clear` button (back to an empty field); the view never reveals the text.
- Recognised: the found box (border `#63C08F44`, `#63C08F0D`, radius 10 px, padding 10 px 12 px) headed `✓ Recognized` (`--green`, 600 12 px), per server a `Name` input (prefilled, checked with `isServerName`: `Use letters, digits, -, _ or . (up to 64)`; two the same: `Two servers have the same name`) and the `previewRows` in a grid `90px 1fr` (gap 6 px 10 px; keys `--text-3`; values 11.5 px monospace `--text-2`); `OAuth client secret` (a password input) when `needsClientSecret`. GitHub: `This is a GitHub repository: <owner/repo>` and `Add as a plugin marketplace` (→ `addMarketplace(source)`, the dialog closes). Not recognised (and not empty): the reason in `--red`, 12 px.
- `Where it works` (label): three options in a 3-column grid (gap 8 px; border `--line-2`, radius 10 px, padding 9 px 11 px, `--raised`; title 500 12.5 px; line 11 px `--text-3`; chosen: border `--accent`, background `#D977570F`; a radio group with arrow keys): `All my projects` / `Only on this computer, in every folder` (user), `This project, shared` / `Saved in .mcp.json, for everyone on the repo` (project), `This project, only me` / `This folder, on this computer` (local). Preselected: the command's scope, else `All my projects`.
- Footer (padding 14 px 20 px, top hairline): note `↻ The session restarts and the conversation goes on`, `Cancel` (ghost), `Add and restart` (primary; `Add <n> servers and restart` for several) — enabled only with valid names and, when asked, a client secret. Add → `Adding…`, disabled; ok → closes, `done()`; an error → its text under the footer in `--red`, the dialog stays. Esc and ✕ close; Tab stays inside the dialog.

- [ ] **Step 1: Write the failing e2e tests:**
  - `'a pasted command is recognised with its header masked, and added for all projects'` (paste `claude mcp add --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: sk-test-123"` with `page.keyboard` paste from a `keepingClipboard` clipboard or `dispatchEvent` paste → rows `Type HTTP`, `Address https://mcp.context7.com/mcp`, `Header CONTEXT7_API_KEY: ••••••••`; `Add and restart` → `.claude.json` `mcpServers.context7.headers.CONTEXT7_API_KEY === 'sk-test-123'`; the chat restarts and its divider reads `Session restarted · context7 connected · 2 tools`).
  - `'the key never shows once recognised, nor in the log'` (after the paste no input's or text area's value and not `document.body.innerText` holds `sk-test-123`; after adding no `*.log` file under the data folder holds it) — Review Focus 1.
  - `'a JSON with two servers adds both to .mcp.json'` (`This project, shared`).
  - `'the name can be edited and the server added for this project only'` (`.claude.json` `projects[<work>].mcpServers['docs-search']`).
  - `'text that is not a server says why and Add stays disabled'`.
  - `'a GitHub link offers to add a plugin marketplace'` (the button → the Plugins section's Marketplaces lists it; needs Task 18 only for the drawing: assert through `ct.mcpPlugins` here).
  - `'a client secret is asked for and goes to Claude Code in its environment'` (`--client-id abc --client-secret` → the field; `cliCalls` `secretEnv` true, no argv holds it).
- [ ] **Step 2: Run** the spec through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 18: Plugins

**Files:**
- Create: `src/renderer/mcp/mcp-plugins.ts`
- Modify: `src/renderer/mcp/mcp-panel.ts`, `src/renderer/mcp/mcp.css`
- Test: `tests/e2e/mcp-plugins.spec.ts` (new)

Rules (board frame 3): under the segments, three sub-tabs `Installed`, `Discover`, `Marketplaces <n>` (padding 5 px 12 px, the chosen one as a chosen segment). `Loading plugins…` while `plugins()` runs; `{ error }` → its text in the error box.
- Installed: rows (padding 9 px 8 px, radius 9 px): icon, name 500, `<version> available` (10.5 px `--blue`, border `#7FA7F555`, radius 5 px, padding 1 px 6 px, `#7FA7F50F`) when `update`, `pluginLine` under it; `Update` (small button, padding 3 px 9 px) when `update`; the switch (`enable` / `disable`). A click on the name unfolds the details: description, `Scope: <scope>`, errors in the error box, `Uninstall` (asks in the row like Remove). Empty: `No plugins installed`.
- Discover: a 2-column grid (gap 8 px, padding 4 px 8 px) of cards (border `--line-2`, radius 11 px, `--raised`, padding 10 px 11 px, gap 6 px): 22 px icon and name 500 12.5 px; the description 11.5 px `--text-3`; the foot 11 px `--text-3` `<marketplace>` and ` · <countLabel(installs)>` when known, `Install` (primary, small) at the right. After a marketplace add, only that marketplace's plugins with a chip `<name> ✕` that clears the filter. Empty: `No plugins to discover: add a marketplace first`.
- Marketplaces: rows `<name>` and `<source>` (11.5 px `--text-3`), `Update` and `Remove` (asks); at the bottom the dashed box (border `1px dashed --line-2`, radius 10 px, padding 10 px 12 px, 12 px `--text-3`) `＋ Add a marketplace: a GitHub link, a URL or a folder`; a click turns it into an input and `Add`. A successful add switches to Discover filtered to `result.marketplace`. Empty list: `No marketplaces added`. The dialog's `addMarketplace(source)` (Task 17) lands here the same way.
- Install with `options` in the result: a form above the list `<name> needs a few settings`, one input per option (its title as label, description under it, `type="password"` when sensitive), `Save` (`configure` with the values; the form goes on success; an error under it) and `Later` (`configure-later`). The values live only in the inputs and the one call.
- Errors of any action under its row or card, never a toast. Footer hint `Installs and changes restart the session`.

- [ ] **Step 1: Write the failing e2e tests** (the script's marketplaces as Task 10's, plus an installed `code-review-kit` with `installVersion: '1.2.0'` and catalog `version: '1.3.0'`): `'Installed lists the plugins with their switches and an update from the marketplace'` (`1.3.0 available`, `Update` → the row shows `1.3.0`); `'a GitHub link adds a marketplace and shows its plugins'`; `'Discover installs a plugin and the session restarts'` (`chatStarts` 2); `'a plugin with a required option asks for it before the restart, and it goes through stdin'` (`chatStarts` stays 1 while the form shows; `Save` → `stdinKeys: ['token']`, no argv holds the value, then `chatStarts` 2); `'turning a plugin off restarts the session'`; `'Marketplaces updates and removes one'`; `'a failed install shows its message on its card'` (`cliFail: { 'plugin install': 'Plugin "x" not found in any marketplace' }`).
- [ ] **Step 2: Run** the spec through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 19: the chat says it will restart, and what came up

**Files:**
- Modify: `src/renderer/chat/chat-items.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css` (a new section after the divider rules), `src/renderer/main.ts`
- Test: `tests/e2e/mcp-restart.spec.ts`

**Interfaces — Produces:** `ItemCallbacks` (and `ChatViewOptions`) gain `openMcp(): void` (the notice's button: the servers section) and `reload: ((action: ReloadAction) => void) | null` (`main.ts`: `ct.mcpReload(tabId, action)` for a local tab, `null` for a remote one).

Rules (board frame 4):
- `reload` item (`.chat-reload`): a row (gap 10 px), border `1px solid --line-2`, `--raised`, radius 11 px, padding 9 px 12 px, 12.5 px; a 24 px icon box (radius 7 px, `#A78BFA22`, `--purple`, 700 12 px) holding `⚡`; the title 500 and under it the text (`--text-3`); at the right `Not now` (ghost) or `Restart` (button) by `action`, none when null or when `reload` is null. Text from main with `textContent`.
- The divider's `good` (`.chat-divider-good`): its first occurrence in the text drawn in `--green`, weight 500; the rest as today.
- A notice with `open-mcp`: the button `MCP servers` → `openMcp()` (`main.ts`: as `/mcp` does).

- [ ] **Step 1: Write the failing e2e tests** (add to `mcp-restart.spec.ts`): `'the card shows its title, its text and Not now; Not now turns it into Restart'` (`.chat-reload` text `New MCP server: context7`; click `Not now` → the button reads `Restart`); `'the divider names what came up, the connected part in green'` (`.chat-divider-good` text `context7 connected`, computed colour equals `--green`'s); `'the notice of a failed server opens the MCP servers'` (`MCP servers` → `.panel-mcp` visible with the `broken` row); `'Restart on another chat's card restarts that chat'`.
- [ ] **Step 2: Run** the spec through the lock. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, plus `tests/e2e/chat-conversation.spec.ts tests/e2e/chat-activity.spec.ts tests/e2e/chat-theme.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

---

### Task 20 (after both streams): the README and the whole run

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** In `README.md` "💬 Chat", after the paragraph on `/model` and `/resume`, one paragraph (no new screenshot): `**/mcp** and **/plugin** (or the **MCP · Plugins** button in the tab's header) open a panel beside the chat with the session's MCP servers — their state, tools and errors; sign in, reconnect, turn off, remove, or add one by pasting a command, a URL or a JSON config — and your plugins and marketplaces. When the servers or plugins a chat would load change, whether from the panel or because Claude ran \`claude mcp add\`, the chat restarts its session once the answer has ended and goes on with the same conversation; other chats the change applies to offer **Restart**.` In "Restart session" (the line about restarting after adding an MCP server) add: `A chat tab restarts by itself after such a change.`
- [ ] **Step 2: Run** `npm run typecheck`, `npm test`, then through the lock `npx playwright test tests/e2e/mcp-main.spec.ts tests/e2e/mcp-restart.spec.ts tests/e2e/mcp-panel.spec.ts tests/e2e/mcp-add.spec.ts tests/e2e/mcp-plugins.spec.ts tests/e2e/chat.spec.ts tests/e2e/chat-slash.spec.ts tests/e2e/chat-devices.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/sheet.spec.ts tests/e2e/restart.spec.ts --reporter=line --workers=2` (after `npm run build`). Expected: PASS.
- [ ] **Step 3:** The controller runs the whole-branch review the skill prescribes; its fixes are tasks of their own.
- [ ] **Step 4:** Delete what the run made outside the repository (scratch logs and folders); leave the changes uncommitted and tell the person what is ready to commit.
