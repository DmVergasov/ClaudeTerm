# Agent messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents in Claude tabs on paired devices (and on one device) find each other and exchange messages through ClaudeTerm when Claude Code's own `SendMessage` cannot reach them; an idle receiver is woken by an `asyncRewake` hook; the user reads the conversations in a side panel with quiet envelope marks.

**Architecture:** A mail store of its own (`agent-messages.json`, a grow-only set of immutable messages whose `delivered`/`read` flags only go from false to true) synced over the existing device links with three new part-2 message types; a directory of agents built from local and remote tabs, addressed by device + Claude session id; a `MailHub` in main that sends, holds the hook's `mail_wait` requests and hands mail over; a hook mode `mail` that exits 2 with the mail on stderr; two MCP tools; a side panel and marks in the renderer.

**Tech Stack:** Electron 44, TypeScript (strict), node-pty, xterm.js, `@modelcontextprotocol/sdk` + zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-agent-messages-design.md` — read it before any task. Where this plan and the spec differ, this plan wins: the store is a grow-only set synced by digests (see Task 1), not a copy of `replica.ts`.

## Global Constraints

- **Never commit.** Leave every change in the working tree; do not run `git commit`, `git stash` or anything that rewrites history. Tell the controller what is ready instead.
- If a build, a lock, a file or a DLL is held by another agent or session, stop and report it to the controller; never edit, revert or kill another agent's work.
- Everything in AGENTS.md applies: English comments/logs/UI strings; match surrounding code; strict TS with `noUnusedLocals`; keep each file's line endings (most files here are CRLF in the checkout — edit with tools that keep them); paths compared with `pathKey`; main never blocks; renderer reaches the system only through the preload bridge; every IPC argument checked in `ipc-guards.ts`.
- Everything from the pipe and from other devices is untrusted: validate, cap sizes, degrade gracefully.
- Tests never start the real `claude`, never call the Anthropic API, never touch the real `~/.claude` or `%APPDATA%\ClaudeTerm`; they create files under `tmpdir()` only.
- A message text is 1–8000 characters (`MAIL_TEXT_MAX = 8000`). Messages are kept 30 days (`MAIL_KEEP_MS = 30 * 24 * 60 * 60 * 1000`).
- The mail watcher is written only for Claude Code `2.1.287` or later (`MAIL_MIN_CLAUDE = '2.1.287'`); its hook entries have `"asyncRewake": true, "timeout": 86400` and no forced `exit 0`.
- Settings keys: `agentMessages.enabled` (default `true`), `agentMessages.marks` (default `true`).
- UI strings, tool texts and error texts are the spec's (section "What the user sees"); copy them verbatim.
- Run commands from the worktree root `D:\Workspace\ClaudeTerm\.claude\worktrees\feat-agent-messages`. `npm run typecheck` and `npm test` must stay green after every task.

## Review Focus

1. **A message to a session that is not running on a connected device**: `message_agent` answers `… is closed.` and writes nothing; a record that arrives later by catch-up for such a session stays `waiting` and is delivered when a tab resumes it — Task 5 tests both.
2. **A watcher killed by Claude Code (timeout, session end) while main holds its request**: main must not mark mail delivered into a closed socket — Task 5 (`closed` signal) and Task 6 (pipe server aborts on socket close) test it.
3. **Several watchers of one tab** (every `Stop` arms a new one): only the newest receives mail, older ones exit 0 at once — Task 5.
4. **A peer running an older ClaudeTerm** (no `mail` in hello): no mail traffic is sent to it, its link stays up, and its device is listed as not accepting — Task 2 and Task 4.
5. **Oversized or malformed input**: a text over 8000 characters, a `to` that matches two refs, a record with a bad field from a peer, a `mail-have` list longer than the cap — each refused or dropped without throwing — Tasks 1, 2, 4, 5.

---

### Task 1: Mail records and the mail store

**Files:**
- Create: `src/shared/mail.ts`
- Create: `src/main/mail/mail-record.ts`
- Create: `src/main/mail/mail-store.ts`
- Test: `tests/unit/mail-record.test.ts`, `tests/integration/mail-store.int.test.ts`

**Interfaces:**
- Produces (`src/shared/mail.ts`):
  ```ts
  export const MAIL_TEXT_MAX = 8000
  export const MAIL_KEEP_MS = 30 * 24 * 60 * 60 * 1000
  export const MAIL_MIN_CLAUDE = '2.1.287'
  /** one end of a conversation: device null is this device on a device never paired (such records never leave it) */
  export interface MailAddress { device: string | null; session: string; name: string }
  export interface MailRecord { v: 1; id: string; from: MailAddress; to: MailAddress; replyTo: string | null; text: string; sentAt: number; delivered: boolean; read: boolean }
  /** unread messages per tab id, for the marks */
  export type MailUnread = Record<string, number>
  export interface MailEndView { name: string; device: string | null; deviceName: string }
  export interface MailMessageView { id: string; from: MailEndView; sentAt: number; text: string; delivered: boolean; read: boolean }
  export interface MailConversationView { key: string; a: MailEndView; b: MailEndView; lastAt: number; messages: MailMessageView[] }
  ```
- Produces (`src/main/mail/mail-record.ts`): `checkMailRecord(v: unknown): MailRecord | null`; `mergeMail(mine: MailRecord, theirs: MailRecord): MailRecord`; `mailFlags(r: MailRecord): number` (1 = delivered, 2 = read).
- Produces (`src/main/mail/mail-store.ts`):
  ```ts
  export interface MailStoreDeps { dir: string; now?(): number; debounceMs?: number; onError?(message: string): void }
  export type MailOrigin = 'local' | { link: unknown }
  export class MailStore {
    static open(deps: MailStoreDeps): MailStore
    all(): MailRecord[]                      // newest sentAt last
    get(id: string): MailRecord | undefined
    add(r: MailRecord): void                 // a message written here
    merge(records: MailRecord[], origin: MailOrigin): MailRecord[]   // returns the records that changed here
    mark(ids: string[], flag: 'delivered' | 'read'): MailRecord[]   // returns the records that changed
    digest(): [id: string, flags: number][]  // shareable records only (no null device)
    missingFor(peer: [string, number][]): MailRecord[]  // shareable records the peer lacks or holds with fewer flags
    prune(): void
    onChange(cb: (changed: MailRecord[], origin: MailOrigin) => void): void
    flush(): void
  }
  ```

- [ ] **Step 1: Write the failing unit tests** in `tests/unit/mail-record.test.ts`:
  - `checkMailRecord accepts a well-formed record and returns a copy without extra fields`
  - `checkMailRecord rejects a bad id, a non-UUID session, a text of 0 or 8001 characters, a non-boolean flag, a wrong v` — each returns `null`.
  - `checkMailRecord accepts device null in from and to` .
  - `mergeMail keeps the first text and ORs the flags` — `mergeMail({...r, read:false, delivered:true}, {...r, text:'other', read:true, delivered:false})` → `{...r, delivered:true, read:true}` with `r.text`.
  - `mailFlags is 0, 1, 2 or 3`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/mail-record.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/shared/mail.ts` (types and constants above) and `src/main/mail/mail-record.ts`. `id` and `session` must be UUIDs (`isUuid` from `src/shared/protocol.ts`), `device` a device id string (`isDeviceId` rules in `ipc-guards.ts`) or null, `name` 1–200 characters without control characters, `replyTo` UUID or null, `sentAt` a finite non-negative number.
- [ ] **Step 4: Run** the unit test — Expected: PASS.
- [ ] **Step 5: Write the failing integration tests** in `tests/integration/mail-store.int.test.ts` (each in its own `mkdtempSync(join(tmpdir(), 'ct-mail-'))`):
  - `a message added is on disk in agent-messages.json after flush and comes back on open`.
  - `merge adds new records and raises flags; it returns only what changed` — merging the same record twice returns `[]` the second time.
  - `merge drops records older than 30 days, and prune removes them from disk`.
  - `digest leaves out records with a null device; missingFor returns what the peer lacks or holds with fewer flags`.
  - `a corrupt file is moved aside and the store opens empty` — the folder then holds a file starting with `agent-messages.json.corrupt-`.
  - `onChange reports local adds with origin 'local' and merges with the origin passed`.
- [ ] **Step 6: Run** `npx vitest run tests/integration/mail-store.int.test.ts` — Expected: FAIL.
- [ ] **Step 7: Implement** `MailStore`: file `{ "version": 1, "records": MailRecord[] }`; written debounced (`debounceMs ?? 500`) to `.tmp` then renamed, mode 0600, like `ReplicaFile.flush` in `src/main/sync/replica-file.ts:108`; records failing `checkMailRecord` are skipped on load; `open` prunes.
- [ ] **Step 8: Run** both test files, `npm run typecheck` — Expected: PASS.

### Task 2: Mail over the device links

**Files:**
- Create: `src/main/mail/mail-sync.ts`
- Modify: `src/main/sync/wire.ts` (`HelloMessage` :32, `parseHello` :228), `src/main/sync/remote-wire.ts` (`RemoteMessage` :13-28, `parseRemoteMessage` :50), `src/main/sync/device-group.ts` (hello built in `createNet()` :337-343), `src/main/sync/device-net.ts:31` (the `hello()` dep type)
- Test: `tests/unit/mail-wire.test.ts`, `tests/integration/mail-sync.int.test.ts`

**Interfaces:**
- Consumes: Task 1 (`MailStore`, `checkMailRecord`).
- Produces:
  - `HelloMessage` gets `mail?: 1`; `parseHello` keeps `mail` only when it is exactly `1`; `DeviceGroup` always sends `mail: 1`.
  - New part-2 messages in `RemoteMessage`: `{ t: 'mail-have'; have: [string, number][] }` (at most 20 000 entries), `{ t: 'mail-records'; records: MailRecord[] }` (at most 500 records, each checked with `checkMailRecord`; invalid ones dropped), `{ t: 'mail-accept'; on: boolean; wakes: boolean; claude: string | null }`.
  - ```ts
    export interface MailAccept { on: boolean; wakes: boolean; claude: string | null }
    export interface MailSyncDeps { store: MailStore; accept(): MailAccept; onPeers?(): void }
    export class MailSync {
      constructor(deps: MailSyncDeps)
      attach(link: PeerLink, hello: HelloMessage): void   // ignores a hello without mail: 1
      acceptOf(device: string): MailAccept | null         // null: not connected, or no mail support
      announce(): void                                    // sends mail-accept to every mail link
      close(): void
    }
    ```
- [ ] **Step 1: Write the failing unit tests** in `tests/unit/mail-wire.test.ts` (through `parseMessage` of `wire.ts`):
  - `a hello with mail: 1 keeps it; a hello without it, or with mail: 2, has no mail field`.
  - `mail-have, mail-records and mail-accept parse; a malformed one is 'unknown', never a closed link` — `parseMessage({ t: 'mail-have', have: 'x' })` is `'unknown'`.
  - `mail-records drops an invalid record and keeps the valid ones`.
  - `a mail-have over 20000 entries and mail-records over 500 records are 'unknown'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/mail-wire.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the wire changes (field-by-field copies, like the existing cases).
- [ ] **Step 4: Run** the unit test — Expected: PASS.
- [ ] **Step 5: Write the failing integration tests** in `tests/integration/mail-sync.int.test.ts`, with two real `PeerLink`s set up the way `tests/integration/sync-peer-link.int.test.ts` does, each side with its own `MailStore` in a temp folder:
  - `on attach both sides send mail-accept and their digest, and each gets what it lacked` — A holds r1, B holds r2 before linking; afterwards both hold r1 and r2.
  - `a record added or marked after linking reaches the other side at once`.
  - `a record that came from one link is relayed to the other links, not back` — three stores A–B–C in a line.
  - `records with a null device are never sent`.
  - `a peer whose hello has no mail gets no mail message, and its link stays open` — count the frames B receives.
  - `acceptOf reports the peer's last mail-accept and null after its link closes; announce sends the new accept`.
- [ ] **Step 6: Run** the integration test — Expected: FAIL.
- [ ] **Step 7: Implement** `MailSync`: on `attach` (only `hello.mail === 1`) listen to `link.on('message')` for the three types and `link.on('close')`; send `mail-accept` then `mail-have` with `store.digest()`; answer a `mail-have` with `store.missingFor(have)` in `mail-records` batches below `BULK_CHUNK_BYTES - 1024` bytes via `link.sendBulk`; `merge` incoming records with `{ link }` as origin; on `store.onChange` send the changed shareable records to every mail link except the origin link.
- [ ] **Step 8: Run** both files and `npm test` — Expected: PASS (the existing `sync-*` tests too).

### Task 3: The agent directory

**Files:**
- Create: `src/main/mail/agent-directory.ts`
- Test: `tests/unit/agent-directory.test.ts`

**Interfaces:**
- Consumes: Task 1 (`MailAddress`), Task 2 (`MailAccept`).
- Produces:
  ```ts
  export interface AgentTab {
    device: string | null; deviceName: string; tabId: string; session: string
    customTitle: string | null; folder: string; branch: string | null; title: string | null
    busy: boolean; wakes: boolean; claude: string | null
  }
  export interface Agent extends AgentTab { name: string; ref: string }
  export function nameAgents(tabs: AgentTab[]): Agent[]
  export function formatAgentList(agents: Agent[], notAccepting: string[]): string
  export type Resolved = { ok: true; to: MailAddress; agent: Agent | null } | { ok: false; error: string }
  export function resolveAgent(to: string, agents: Agent[], recent: MailAddress[]): Resolved
  ```
- [ ] **Step 1: Write the failing tests**:
  - `the name is the custom title, else the folder's last part, then " · " and the device name` — `{ customTitle: null, folder: 'D:\\Work\\api-server', deviceName: 'Desktop' }` → `api-server · Desktop`.
  - `two agents with one name on one device get " #2", " #3" in tab order`.
  - `the ref is the first six characters of the session id`.
  - `formatAgentList writes one row per agent as the spec shows` — `api-server · Desktop [3be5d1] · idle · D:\Work\api-server · feat/revenue-units · "Add a unit field to /v2/revenue"` (branch and title left out when null).
  - `an agent that cannot be woken is listed as "<name>: Claude Code <v> can't receive messages; 2.1.287 or later can"` (`<v>` is `of unknown version` when `claude` is null) and not as a row.
  - `devices that do not accept come last as "<device>: does not accept agent messages"`.
  - `formatAgentList with nothing gives "No other agents. Agents on paired devices show here while their device is connected."`.
  - `resolveAgent finds a name, a ref, and a recent address by its name; an unknown one is an error "No agent named \"x\"; call list_agents."`.
  - `resolveAgent with a ref two agents share is an error naming both`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/agent-directory.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the four functions. Labels use the last path part for both `\` and `/`.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 4: The Claude Code version

**Files:**
- Create: `src/main/claude-version.ts`
- Test: `tests/unit/claude-version.test.ts`, `tests/integration/claude-version.int.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function parseClaudeVersion(output: string): string | null          // first \d+\.\d+\.\d+
  export function versionAtLeast(v: string, min: string): boolean
  export interface VersionProbe { command: string; version: string | null }
  export function readVersionCache(dataDir: string): VersionProbe | null     // claude-version.json
  export function probeClaudeVersion(dataDir: string, command: string, platform?: NodeJS.Platform): Promise<string | null>
  ```
  `probeClaudeVersion` runs `<command> --version` through `cmd.exe /d /s /c` on Windows and `/bin/sh -c` elsewhere with `runOffThread` (`src/main/off-thread-spawn.ts:131`), `timeoutMs: 15000`, writes the cache, and resolves `null` on any failure.
- [ ] **Step 1: Write the failing tests**:
  - unit: `parseClaudeVersion reads "2.1.322 (Claude Code)"`, `returns null for "fake-claude"`; `versionAtLeast("2.1.287","2.1.287")`, `("2.1.300","2.1.287")` true, `("2.1.99","2.1.287")` false, `("2.2.0","2.1.287")` true.
  - integration: `probeClaudeVersion runs the command with --version and caches the result` — command `node -e "console.log('2.1.400 (Claude Code)')"` then `readVersionCache` gives `{ command, version: '2.1.400' }`; `a command that fails gives null and caches null`.
- [ ] **Step 2: Run** both — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.

### Task 5: The mail hub

**Files:**
- Create: `src/main/mail/mail-hub.ts`, `src/main/mail/wake-text.ts`
- Test: `tests/unit/mail-hub.test.ts`, `tests/unit/wake-text.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3.
- Produces:
  ```ts
  export function wakeText(records: MailRecord[], senders: (a: MailAddress) => { folder: string | null; branch: string | null }): string
  export interface CallerTab { tabId: string; device: string | null; session: string; name: string }
  export interface MailHubDeps {
    store: MailStore
    enabled(): boolean
    caller(tabId: string): CallerTab | null              // a Claude tab on this device with a known session
    agents(): Agent[]                                     // every listable agent, this device's included
    notAccepting(): string[]                              // names of connected devices without mail or with it off
    deviceOnline(device: string | null): boolean          // null: this device, always true
    deviceAccepts(device: string | null): boolean
    localTab(session: string): string | null              // the tab on this device running that session
    sender(a: MailAddress): { folder: string | null; branch: string | null }
    onUnread?(): void                                     // marks or panel may need a redraw
    now?(): number; newId?(): string
  }
  export class MailHub {
    constructor(deps: MailHubDeps)
    list(tabId: string): PipeResponse
    send(tabId: string, to: string, text: string, replyTo: string | null): PipeResponse
    wait(tabId: string, sessionId: string, closed: AbortSignal): Promise<PipeResponse>
    tabsChanged(): void                                   // hand waiting mail to watchers now able to take it
    alias(oldSession: string, newSession: string): void   // a resumed conversation got a new session id
    takeMailTurn(tabId: string): boolean                  // true once after mail was handed to the tab
    userTurn(tabId: string): void                         // a prompt the user typed: the next turn end is not a mail turn
    unreadByTab(tabs: { tabId: string; device: string | null; session: string | null }[]): MailUnread
    conversations(of: { device: string | null; session: string } | null): MailConversationView[]
    markRead(ids: string[]): void
  }
  ```
- [ ] **Step 1: Write the failing tests** for `wakeText` (`tests/unit/wake-text.test.ts`): `one message gives the spec's text` (the block in the spec, "What the user sees", with `from: acme-dashboard · MacBook [c5df49] (folder …, branch main)` and the `id:` line naming `to: "c5df49", reply_to: "<id>"`); `several messages come oldest first, separated by a blank line`; `folder and branch are left out when unknown`.
- [ ] **Step 2: Write the failing tests** for `MailHub` (`tests/unit/mail-hub.test.ts`) with a real `MailStore` in a temp folder and fake deps:
  - `send answers "Delivered to <name>." and writes the record when the target device is online and a tab runs the session`.
  - `send answers "Waiting: <device> is not connected; the message goes out when it connects." for an offline device, and writes the record`.
  - `send to an online device where no tab runs that session answers "<name> is closed." and writes nothing`.
  - `send to a device that does not accept answers "<device> does not accept agent messages."`; `with messages off: "Agent messages are turned off in ClaudeTerm on this device."`; `a text over 8000 characters: "A message is at most 8000 characters."`; `an empty text is refused`.
  - `a reply_to that names an unknown message is refused; a known one is stored as replyTo`.
  - `wait resolves with the wake text as info when mail for that session is waiting, and marks it delivered`.
  - `wait holds until mail arrives (store merge from a link), then resolves`.
  - `a second wait of the same tab answers the first one { ok: true } without info at once` (superseded).
  - `wait answers { ok: true } at once when messages are off`.
  - `a wait whose signal aborts is dropped: later mail is not marked delivered and waits for the next watcher`.
  - `mail for a session no tab runs stays undelivered; after alias(old, new) and tabsChanged it goes to the tab running new`.
  - `takeMailTurn is true once after mail was handed over, and false after userTurn`.
  - `unreadByTab counts unread messages addressed to or from each tab's session`; `markRead clears them`.
  - `conversations groups messages by the pair of addresses, newest conversation first, messages oldest first`.
- [ ] **Step 3: Run** both files — Expected: FAIL.
- [ ] **Step 4: Implement.** A message is unread for the marks while `read` is false. Addresses compare `device` (null and the self device id count as this device) and `session` (through the alias map).
- [ ] **Step 5: Run** — Expected: PASS.

### Task 6: Pipe messages, the mail watcher and the tab settings

**Files:**
- Modify: `src/shared/protocol.ts` (`PipeMessage` :158, `parsePipeMessage` :220), `src/main/pipe-server.ts` (`PipeHandlers` :4-20, `handleLine` :28-53, socket handling :57-99), `src/shared/pipe-client.ts:6`, `src/hook/main.ts`, `src/main/claude-tab-settings.ts` (:7, :41, :56, :99), `AGENTS.md:77-78`
- Create: `src/hook/mail-watch.ts`
- Test: `tests/unit/protocol.test.ts`, `tests/integration/pipe.test.ts`, `tests/unit/claude-tab-settings.test.ts`, `tests/integration/session-hook.int.test.ts`, `tests/unit/mail-watch.test.ts`

**Interfaces:**
- Consumes: Task 5 (`MailHub.list/send/wait` answer these messages in Task 8).
- Produces:
  - Pipe messages: `{ v: 1; type: 'agent_list'; tabId: string }`, `{ v: 1; type: 'agent_send'; tabId: string; to: string; text: string; replyTo: string | null }` (`to` 1–300 characters, `text` 1–8000), `{ v: 1; type: 'mail_wait'; tabId: string; sessionId: string }`.
  - `PipeHandlers` gains `agentList(msg): PipeResponse`, `agentSend(msg): PipeResponse`, `mailWait(msg, closed: AbortSignal): Promise<PipeResponse>`; the server aborts `closed` when that socket closes.
  - `sendPipeMessage(pipeName, msg, timeoutMs: number | null = 2000)`: `null` arms no timer.
  - `runMailWatch(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<{ code: 0 | 2; stderr: string }>`.
  - `claudeTabSettingsJson(hookRun, statusCommand, refreshInterval, mailRun: HookRun | null)` and `writeClaudeTabFiles(dataDir, execPath, hookScriptPath, refreshInterval, mail: boolean, platform?, env?)`; `permissions.allow` gains `mcp__claudeterm__list_agents` and `mcp__claudeterm__message_agent`.
- [ ] **Step 1: Write the failing tests**:
  - `protocol.test.ts`: `agent_list, agent_send and mail_wait parse for UUIDs`; `agent_send refuses an empty text, a text over 8000 characters, a to over 300 characters, a replyTo that is not a UUID`.
  - `pipe.test.ts`: `a held mailWait does not delay another socket's message`; `closing the client socket aborts the signal the handler got`.
  - `mail-watch.test.ts`: `with mail it returns code 2 and the info as stderr`; `an answer without info, an error, or no pipe give code 0 and no stderr`; `it sends mail_wait with the tab id and the session id of the hook input`; `a hook input without a session id sends nothing and gives 0`.
  - `claude-tab-settings.test.ts`: `with mail the SessionStart and Stop hooks hold a second entry with asyncRewake true and timeout 86400`; `without mail they hold only the normal entry`; `the mail entry's command does not end in exit 0` (Windows exec form args without `'&', 'exit', '0'`; the Unix command `ELECTRON_RUN_AS_NODE=1 '<exe>' '<script>' mail` with no `exit 0`); `permissions allow the four claudeterm tools`.
  - `session-hook.int.test.ts`: `node bundle in mail mode exits 2 with the mail on stderr and nothing on stdout`; `in mail mode a superseded answer exits 0 silently`; `in mail mode with no pipe it exits 0 within 3 seconds`; and on Windows `the mail entry of the settings file runs in exec form and keeps exit code 2`.
- [ ] **Step 2: Run** those files — Expected: FAIL.
- [ ] **Step 3: Implement.** `src/hook/main.ts`: mode `mail` (argv contains `mail`) → `readStdin(3000)` → `runMailWatch(..., (pipe, msg) => sendPipeMessage(pipe, msg, null))` → write `stderr` with `process.stderr.write`, then `process.exit(code)`; any throw exits 0. `pipe-server.ts`: an `AbortController` per socket, aborted on `close`, passed to `mailWait`.
- [ ] **Step 4: Amend AGENTS.md** "The hook script never prints to stdout …" to: it never prints to stdout and exits 0 quickly, except the mail watcher, which waits for mail and, only when it hands mail to Claude Code, writes the mail to stderr and exits 2 (`asyncRewake`).
- [ ] **Step 5: Run** the files, `npm run typecheck`, `npm test` — Expected: PASS.

### Task 7: The MCP tools

**Files:**
- Create: `src/mcp/agent-tools.ts`
- Modify: `src/mcp/show-image-server.ts` (:13 server constructor, tool registration area :142-175)
- Test: `tests/integration/mcp.int.test.ts`, `tests/unit/agent-tools.test.ts`

**Interfaces:**
- Consumes: Task 6 (pipe messages `agent_list`, `agent_send`).
- Produces: tools `list_agents` (no input) and `message_agent` (`to: z.string()`, `text: z.string()`, `reply_to: z.string().optional()`); server `instructions` (`new McpServer({ name: 'claudeterm', version: '0.1.0' }, { instructions })`).
  ```ts
  export const AGENT_INSTRUCTIONS: string
  export async function listAgents(o: ToolCtx): Promise<ToolResult>
  export async function messageAgent(input: { to: string; text: string; reply_to?: string }, o: ToolCtx): Promise<ToolResult>
  ```
  with `ToolCtx` / `ToolResult` as `device-tools.ts` uses them.
- [ ] **Step 1: Write the failing tests**: unit `listAgents sends agent_list with the tab id and returns the info as text`; `messageAgent sends agent_send and returns the reply line; an error reply is isError`; `without a ClaudeTerm tab id both say they work only in a ClaudeTerm Claude tab`; `when ClaudeTerm is not running both say so`. Integration (`mcp.int.test.ts`): the tool list now holds `list_agents` and `message_agent`, and the server's instructions name `ListAgents`, `SendMessage`, `list_agents` and `message_agent`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Tool descriptions and `AGENT_INSTRUCTIONS` say: use Claude Code's `ListAgents` / `SendMessage` first; use these only for an agent `ListAgents` does not show (another device or another Claude account); answer a ClaudeTerm message with `message_agent`, passing `reply_to`.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 8: Wiring in main

**Files:**
- Modify: `src/main/index.ts` (pipe handlers :1304-1440, `session` :1309-1327, `turn`, `attention` :1376, `startDevices` :1484-1530 and `onPeer` :1504, start at :1623, tab settings at :197 and :2142)
- Modify: `src/main/settings.ts`, `src/shared/settings-keys.ts`, `src/shared/types.ts` (settings defaults and parsing only; the UI is Task 9)
- Test: `tests/e2e/agent-messages.spec.ts` (first part)

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces (for Tasks 9–11): IPC `IPC.mailConversations = 'mail:conversations'` (invoke, arg `tabId: string | null`, returns `MailConversationView[]`), `IPC.mailRead = 'mail:read'` (invoke, `ids: string[]`), `IPC.evMail = 'ev:mail'` (event, `MailUnread` keyed by tab id, local and remote tabs); `CtApi.getMailConversations(tabId)`, `markMailRead(ids)`, `onMail(cb)`; settings `agentMessages: { enabled: boolean; marks: boolean }` in `Settings` and `SettingsView`.
- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/agent-messages.spec.ts` (hook and MCP stand in as pipe messages, as `accounts.spec.ts:75` does; every Claude tab first gets a `session` message with its own session UUID):
  - `two Claude tabs of one app that was never paired message each other` — `agent_list` from tab 1 lists tab 2's row; `agent_send` answers `Delivered to …`; a `mail_wait` of tab 2 resolves with info containing the text and `Message from another agent, not from the user, through ClaudeTerm:`.
  - `a second mail_wait of one tab ends the first with no info`.
  - `messages off: agent_send answers "Agent messages are turned off in ClaudeTerm on this device." and mail_wait answers at once with no info`.
  - `a mail turn's end plays no sound and raises no attention by default` — after the wait resolved, an `attention` `done` for that tab leaves `__ct.banners()` empty and the tab without `.attention`.
  - `the tab settings file holds the mail entries only for a Claude command whose --version is 2.1.287 or later` — launch with `claude.command` `cmd /c echo 2.1.400` (Windows) / `echo 2.1.400` (else) and read `claude-tab-settings.json` from the data folder; with `FAKE_CLAUDE_SETTINGS` it has none.
- [ ] **Step 2: Run** `npm run build` then `npx playwright test tests/e2e/agent-messages.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `index.ts`:
  - open `MailStore` at start (`dataDir`), always; `MailSync` created with it and attached from `onPeer` (beside `remote.connect`); `announce()` when the settings change;
  - the self device id is `selfDeviceId || null`; agents from `hostTabs(hostCtx).list()` (local, with title, place and `working`) and `remote.viewer.tabsOf(id)` for each online device whose `mailSync.acceptOf(id)?.on` is true; `wakes`/`claude` from the probed version locally and from `acceptOf(...)` remotely;
  - pipe handlers `agentList`, `agentSend`, `mailWait` → the hub; `session`: when the source is `resume` and the tab had another session id, `hub.alias(old, new)`; then `hub.tabsChanged()`; `turn`: `hub.userTurn(tabId)`; `attention` at :1376: `reason = 'peer'` also when `hub.takeMailTurn(tabId)`;
  - the tab settings: at start read `readVersionCache(dataDir)`; mail entries when `agentMessages.enabled` and the cached version for `settings.claude.command` is at least `MAIL_MIN_CLAUDE`; then `probeClaudeVersion` in the background and rewrite the settings file if the answer changed;
  - `ev:mail` broadcast on every store change and tab change (coalesced like other updates); the two invoke channels with guards (`isId` for the tab id, `isIdList` for ids);
  - `store.prune()` once a day (an unref'd interval), `store.flush()` on quit.
  - settings: `agentMessages.enabled` / `agentMessages.marks` keys, defaults `true`, parsed with `take(...)` like `devices.keepAwake`.
- [ ] **Step 4: Run** the e2e file, `npm run typecheck`, `npm test` — Expected: PASS.

### Task 9: The Agent messages settings section

**Files:**
- Modify: `src/renderer/settings-page.ts` (sections :214-266)
- Test: `tests/e2e/settings.spec.ts`

**Interfaces:** Consumes Task 8's settings keys.

- [ ] **Step 1: Write the failing test** `the Agent messages section holds its two checkboxes, both on, and turning one off saves it` — after Devices; labels and help texts verbatim from the spec ("Settings").
- [ ] **Step 2: Run** `npm run build` then `npx playwright test tests/e2e/settings.spec.ts -g "Agent messages"` — Expected: FAIL.
- [ ] **Step 3: Implement** with `section(...)` and `checkboxField(...)`, the help texts as the fields' notes.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 10: The Agent messages panel

**Files:**
- Create: `src/renderer/mail-panel.ts`
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/side-panel.ts` (`PanelTab` :3, `TABS`/`LABELS` :5-8, `available` :31, tools/bodies :54-68), `src/renderer/tab-header.ts` (buttons, `setMessages`), `src/renderer/tabbar.ts:91` and `src/renderer/tab-panel.ts:54` (button order: after `images`), `src/renderer/main.ts` (`refreshPanelButtons` :242-253, side panel construction :976-1050, callbacks :852-863), `src/renderer/styles.css`
- Test: `tests/e2e/agent-messages.spec.ts` (panel part)

**Interfaces:**
- Consumes: Task 8 IPC.
- Produces: `PanelTab` gains `'messages'`; `TabHeader.setMessages(available: boolean, visible: boolean, unread: number)`; callback `toggleMessages()`.
- [ ] **Step 1: Write the failing e2e tests**:
  - `the Messages button shows the active tab's unread count and opens the Agent messages panel` — after one message from tab 1 to tab 2, with tab 2 active, `.tab-messages-toggle .badge` reads `1`; a click shows the panel titled `Agent messages` with `This tab` active, a conversation header `<tab 1 name> ⇄ <tab 2 label>` and the message text.
  - `a message shown in the open panel while the window has focus counts as read` — the badge empties.
  - `All lists the conversations of every tab, newest first`.
  - `an empty panel says "No messages yet. Agents write here only when Claude Code's own messaging can't reach each other."`.
  - `a waiting message says waiting beside its time`.
  - `with messages off the Messages button is hidden`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `MailPanel` (`constructor(body: HTMLElement, tools: HTMLElement)`; `show(tabId: string | null)`; `refresh()`; renders with `textContent` only), the button with an envelope SVG icon, panel width from `settings.review.width` like Docs. Read marks: when the panel is shown and `document.hasFocus()`, call `markMailRead` with the shown unread ids.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 11: The envelope marks

**Files:**
- Modify: `src/renderer/tabbar.ts` (`TabBarItem` :6-33, `TabBarGroup` :36-48, `renderChip` :113-138), `src/renderer/tab-row.ts` (`tabParts` marks :67-92), `src/renderer/tab-panel.ts` (`renderDeviceHead` :175-226), `src/renderer/main.ts` (`tabBarItem` :137-160, `renderTabs` :162-197), `src/renderer/styles.css`
- Test: `tests/e2e/agent-messages.spec.ts` (marks part)

**Interfaces:** `TabBarItem.mail: boolean`; `TabBarGroup.mail: boolean`.

- [ ] **Step 1: Write the failing e2e tests**:
  - `a tab with unread messages carries the envelope mark after its title, in the top bar and in the left panel` — `.tab-mail` inside the tab.
  - `reading the messages clears the mark`.
  - `with marks off there is no envelope and no badge, and the panel still shows the messages`.
  - (in Task 12's two-app spec) the folded chip and the left panel's device header carry the mark.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the mark in `tabParts` after `bell` (class `tab-mail`, title `Unread agent messages`, the envelope SVG at 12 px); `mail` of a group is true when any of its tabs has it; nothing when `agentMessages.marks` is off.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 12: Two devices, docs

**Files:**
- Create: `tests/e2e/agent-messages-devices.spec.ts`
- Modify: `README.md` (a short **Agent messages** part under Devices)

- [ ] **Step 1: Write the failing e2e tests** with `pairedApps` (`tests/e2e/device-pair.ts:113`), each app with a Claude tab that got a `session` message:
  - `a message from Studio's tab reaches Laptop's waiting watcher, and the reply comes back to Studio's` — `agent_list` on Studio lists Laptop's tab; `Delivered to …`; Laptop's `mail_wait` gets it; a reply with `replyTo` reaches Studio's `mail_wait`; both apps' panels show one conversation of two messages.
  - `reading on one app clears the marks on both`.
  - `a closed tab on Laptop: "… is closed."`.
  - `Laptop not running: "Waiting: Laptop is not connected; …"; after relaunch and its tab's session again, Laptop's watcher gets it`.
  - `messages off on Laptop: Studio's agent_list says "Laptop: does not accept agent messages" and agent_send answers "Laptop does not accept agent messages."`.
  - `the folded device chip and the left panel's device header carry the envelope when a tab of that device has unread messages`.
- [ ] **Step 2: Run** `npm run build` then the spec — Expected: FAIL only where Tasks 8–11 left gaps; fix them in the owning code.
- [ ] **Step 3: Write the README part**: what it is for (agents on another device or another account), that `SendMessage` comes first, the panel, the marks and the two settings.
- [ ] **Step 4: Run** `npm run typecheck`, `npm test`, `npm run test:e2e` — Expected: PASS (on Windows, `review.spec.ts` is known to fail under load; rerun it alone and compare with clean master before blaming the change).
