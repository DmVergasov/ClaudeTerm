# Remote Control in Claude Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every local Claude tab shows its Remote Control (RC) state in a `Remote` status-bar segment, turns RC on or off from a popover, and can start every new tab of an account with RC on; terminal tabs use Claude Code's own RC, chat tabs are hosted on claude.ai by ClaudeTerm through the Agent SDK's bridge.

**Architecture:**
- **One state per tab, owned by main.** `RemoteControlHub` (`src/main/remote-control/remote-control-hub.ts`) computes a `RemoteState` per local Claude tab from the account rules, the tab's choice (kept by `TabManager`, saved in the session store), the id Claude Code reports (kept by `StatusHub`) and, for chat tabs, the `BridgeHost`. `StatusUpdate.remote` carries it to the window.
- **Terminal tabs.** The hook adds `remote` (from `CLAUDE_CODE_BRIDGE_SESSION_ID`) to its messages; the switch types `/remote-control …` with the typing half of the terminal handoff; a tab whose choice is on starts with `--rc <name>`.
- **Chat tabs.** `BridgeHost` (`src/main/remote-control/bridge-host.ts`) reads the account's credentials read-only, creates or re-attaches the conversation's claude.ai session, writes the chat's SDK messages to it and takes messages, permission answers and interrupts back through taps in `ChatHub`.
- **The window.** A segment, a popover and a tab glyph, drawn from `StatusUpdate.remote`; two IPC calls (`remoteControlSet`, `remoteControlAccount`).

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), plain-DOM renderer, `@anthropic-ai/claude-agent-sdk` 0.3.322 and its alpha `./bridge` export, Vitest (unit, integration), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-16-remote-control-design.md` (approved; binding).

## Global Constraints

- **AGENTS.md applies.** Every behaviour is tested through its entry point (a pipe message, a hook run, an IPC call, a click). Tests write only under `tmpdir()`. Main checks every IPC argument (`ipc-guards.ts`). The main process never blocks: every file read, `security` run and network call is async with a time limit. All copy is English. No real personal data in tests.
- **Test isolation.** No test reaches the network, the real `~/.claude`, the real Keychain, real credentials or the real `claude`. Unit tests inject a fake bridge module. E2E tests load the stand-in bridge `tests/fixtures/fake-bridge/fake-bridge.mjs`, selected by `CLAUDETERM_TEST_BRIDGE=<path>` and only when `CLAUDETERM_TEST=1` (the pattern of `CLAUDETERM_TEST_POWERSHELL`, `src/main/index.ts:3702`). Under `CLAUDETERM_TEST=1` the macOS Keychain is never read (the `security` runner is `null`). E2E tests that start Claude tabs pass `RC_CLEAN_ENV` (Task 5), so a developer's `ANTHROPIC_API_KEY` or the like does not make the main account unavailable.
- **Never copy code from github.com/Sterll/claude-terminal** (GPL-3.0). Its approach is in the spec; that is all we take.
- **Out of scope:** paired devices' tabs (no segment, no glyph), `claude remote-control` server mode, shell tabs, a QR code, a mirror mode, `remoteControlAtStartup`, and model, thinking, permission-mode, rename or task requests from claude.ai (their bridge callbacks are left out).
- **Anti-goals (a failure even if all else works):** ClaudeTerm never writes, refreshes or deletes Claude Code's credentials; no token or device token in a log, error text, toast, settings file, fixture or the pipe; a chat's transcript goes to claude.ai only once the person turned RC on (the switch, or the account checkbox); RC never delays or fails a chat's start; no device enrolment of ClaudeTerm's own.
- **Do not commit.** The person's standing rule overrides the skill's commit steps. Each task ends by reporting the changed files and a suggested Conventional Commits message; the controller commits.
- **Execution.** Subagent-driven, Haiku implementers. Each step names its files, signatures and copy; write nothing the step does not ask for.
- **Commands** (from `D:/ct-scratch/rc-mockup`):
  - unit and integration: `npx vitest run <file>`; types: `npm run typecheck`;
  - e2e, always through the shared lock and always built first (`scripts/e2e.mjs` does not build):
    `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run build && node scripts/e2e.mjs <spec> --workers=1"`.
- **Line endings.** Existing source files are CRLF in this working copy (git stores LF). Keep each file's endings; a new file takes its neighbours' (CRLF under `src/` and `tests/`).
- **`src/main/index.ts` has no unit harness.** Its wiring is proved by the task's e2e tests; keep each wiring change to the lines the step names.
- **Base.** This plan runs only after the person's-words work is in master. Before Task 1 the controller rebases `feat/remote-control` onto `origin/master`. That master has `PersonInput` (`src/main/coordinator/person-input.ts`), the words card in `chat-items.ts`'s `userItem` and its `chat.css`, and more lines in `src/main/index.ts`. This plan's line numbers are from `cfe077a`: find each place by the name it gives.
- **Collisions.** A locked file, a running build or a shared file another agent holds: report it to your dispatcher; never edit, revert or kill the other side's work.
- **Known flakes** (fail on clean master too): `review.spec`, the `tab-panel.spec` fold race, `account-add.spec` "checks the sign-ins", the WMI and clipboard tests under load. Rerun a failure alone, and on clean master, before blaming a change.

**Copy fixed by the spec** (use each string exactly):
- Segment text `Remote`. Titles: off `Remote Control is off: click to turn it on`; connecting `Remote Control is connecting…`; on `Remote Control is on: this session is on claude.ai and in the Claude app`; unavailable and failed: the reason.
- Popover: heading `Remote Control`; lines: off `Off · turn it on to reach this session from your phone`, connecting `Connecting…`, on `Connected · continue this session in the Claude app or on claude.ai`; suffix while ClaudeTerm waits to type ` · waits for an empty prompt`; after an off click in a terminal tab `Choose Disconnect this session in the terminal`; buttons `Open on claude.ai`, `Copy link`.
- Chat note: `ClaudeTerm sends this chat to claude.ai while it is on: messages, tool results, file contents. Prompts and permission answers can come from there.`
- Checkbox `Connect every new session of this account`; its note `New Claude tabs of <account name> start with Remote Control on`.
- Tab glyph title `Remote Control is on`.
- Reasons: `This account signs in with a token: Remote Control needs a claude.ai sign-in` (token accounts and sign-ins from the environment); `Remote Control needs Anthropic's own service: this account uses ANTHROPIC_BASE_URL`; `No claude.ai sign-in found for this account`; `This ClaudeTerm cannot host Remote Control: the Agent SDK's bridge changed`; `Sign in to this account again (claude auth login)`; `Turn Remote Control on once in a terminal tab of this account: Claude Code registers this computer then`; `claude.ai refused Remote Control (<status>)`; `claude.ai could not be reached`.
- Waiting line and title for an expired token: `Waiting for Claude Code to renew this account's sign-in`.
- Toast: `Remote Control did not connect in <tab>: see the terminal`. The handoff's own give-up toast stays `Could not run /remote-control: Claude Code's prompt did not come up`.
- Chat mark under a message from claude.ai: `from claude.ai`.
- Lines typed: `/remote-control <name>` (on) and `/remote-control` (off). Launch flag: `--rc <name>`, quoted with `quoteForShell`.

**Copy this plan decides** (the spec names none): a card answered on claude.ai reads `Allowed from claude.ai` or `Denied from claude.ai` (permission cards) and `Answered from claude.ai` (question and plan cards).

**Values:** id rule `^[A-Za-z0-9_-]{1,128}$`; link `https://claude.ai/code/<id>`; name at most 60 characters; prompt wait 30 s (the handoff's); connect timeout 30 s; `createCodeSession` and `fetchRemoteCredentials` 20 s each; flush 2 s before `close()`; credential re-read 60 s while waiting; sequence number stored every 60 s while on; backoff 2 s, 5 s, 15 s, 60 s; remote-session entries kept 30 days after last use; `security` 5 s; API base `https://api.anthropic.com`; Keychain service `Claude Code-credentials` (default folder) or `Claude Code-credentials-<first 8 hex of sha256(NFC(folder))>`.

**Where the code contradicts the spec, or the spec leaves a point open, this plan decides:**
1. **`RemoteState` gains optional fields** the spec's own popover needs: `{ kind: 'connecting'; note?: string; waits?: true }` and `{ kind: 'on'; url: string; leaving?: true; waits?: true }`. `note` replaces the connecting line and title (the renew wait); `leaving` is the terminal off-request (line `Choose Disconnect…`, switch unchecked); `waits` appends ` · waits for an empty prompt`. The spec puts that suffix on "Off", but also says the state is connecting from the click; the plan appends it to whatever line shows while ClaudeTerm waits to type.
2. **`StatusUpdate.remote` is optional** (`remote?: RemoteState | null`): absent and null both mean no segment. Paired devices' pushes and the existing test literals stay valid.
3. **Name clashes:** `TabInfo.remote` and `ChatHubDeps.remote` already exist for paired devices. The tab's choice is `remoteControl` (on the tab record and the snapshot, not on `TabInfo`); the chat tap is `ChatHubDeps.remoteControl`.
4. **The credentials reader returns a `state`** besides the spec's `{ accessToken, deviceToken }`: `none` → unavailable (`No claude.ai sign-in…`), `expired` → the renew wait, `unusable` (a record with no usable token, or a file that is not JSON) → failed (`Sign in to this account again…`).
5. **The bridge is imported like `loadSdk`:** a plain lazy `import('@anthropic-ai/claude-agent-sdk/bridge')`. `loadSdk` has no `app.asar.unpacked` step (the SDK is not unpacked), so neither does the loader.
6. **The 30 s connect timeout starts when the line is typed** (or when a tab starts with `--rc`), not at the click, so it never doubles the handoff's own 30 s prompt wait. A timeout clears the choice (the switch shows off); a later id sets it again.
7. **An off click whose `Disconnect` the person does not choose:** 30 s after `/remote-control` is typed, an id still reported means the person kept RC; the choice is set again and `leaving` goes.
8. **The account rules read the tab's launch environment** (ClaudeTerm's environment with the account's own variables applied), names matched ignoring case.
9. **`.claude.json` of an account** is `~/.claude.json` for the default folder and `<folder>/.claude.json` for any other (`claudeAccountFile`, `src/main/claude-plan.ts:16`).
10. **Forwarded messages:** every SDK message except partial `stream_event` frames; a turn's `result` is also written, then `sendResult()`. **History** for a new remote session: the session's transcript through the chat's existing `history` function, `user` and `assistant` entries only.
11. **Open, to be confirmed by the controller before release** (no implementer can check them): the chat-tab link form (the plan uses `https://claude.ai/code/<cse id>`; `remoteLink` is the one place to change), the Keychain suffix for non-default folders on a real Mac, whether `accountInfo()` renews a token, and where Claude Code keeps `trustedDeviceToken` in its credential record (the plan reads the record's top level).
12. **Test levels:** the credentials reader, the remote-session store and the git context touch the disk or git, so their tests are integration tests (AGENTS.md), not unit tests.
13. **Task order:** the renderer (Task 7) comes after the main-side switch (Task 5) and account flag (Task 6), whose IPC calls its controls use.

## Review Focus

- **ClaudeTerm is started from a Claude Code session that has RC on** (a developer runs it from Claude Code): `CLAUDE_CODE_BRIDGE_SESSION_ID` would reach every tab, and each tab would show that other session as connected. Expected: no tab inherits it. Pinned by Task 2's `child-env.test.ts` test and the integration test's scrubbed environment.
- **A tab started with `--rc` reports no id at first** (its SessionStart and first statusLine come before the 2 s connect; the old process's id is still stored). Expected: connecting, then on; the choice kept. Pinned by Task 5's hub test "a tab started with its choice on connects…".
- **RC is turned on in a chat mid-turn.** Expected: the turn's end reaches claude.ai (its spinner stops), and no message shows twice. Pinned by Task 10's host test "messages that come while attaching…".
- **A paired device watches a chat tab whose RC is on, and a message comes from claude.ai.** The member's mirror refuses a user item whose origin it does not know. Expected: the member shows it as a plain message. Pinned by Task 12's `chat-mirror.test.ts` test.
- **A chat tab with RC on switches account.** The stored claude.ai session belongs to the old login. Expected: a new claude.ai session under the new account, not a refusal. Pinned by Task 9's store test and Task 10's host test "a stored session of another account is not used".

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/remote-control.ts` (new) | `RemoteState`, the id rule, the link, the name, the reasons and toasts |
| `src/main/remote-control/account-rules.ts` (new) | which accounts and environments can use RC |
| `src/main/remote-control/remote-control-hub.ts` (new) | the per-tab state; terminal reports, the switch, the connect timer; the chat side |
| `src/main/remote-control/claude-credentials.ts` (new) | reads Claude Code's credentials, read-only |
| `src/main/remote-control/bridge-loader.ts` (new) | imports and checks the SDK bridge once |
| `src/main/remote-control/remote-sessions.ts` (new) | `{ remoteId, sequenceNum }` per Claude session, 30 days |
| `src/main/remote-control/git-context.ts` (new) | the repository's remote, branch and default branch for a new claude.ai session |
| `src/main/remote-control/bridge-host.ts` (new) | hosts a chat tab's RC session |
| `src/renderer/remote-popover.ts` (new) | the popover and the segment's copy |
| `tests/fixtures/fake-bridge/fake-bridge.mjs` (new) | the e2e stand-in bridge |
| `tests/e2e/remote-control-helpers.ts` (new) | e2e helpers shared by the three RC specs |
| existing | `protocol.ts`, `session-hook.ts`, `child-env.ts`, `status-hub.ts`, `tab-manager.ts`, `session-store.ts`, `profiles.ts`, `terminal-handoff.ts`, `accounts.ts`, `settings.ts`, `settings-keys.ts`, `chat-hub.ts`, `chat-engine.ts`, `sdk-engine.ts`, `chat-cards.ts`, `chat-mirror.ts`, `shared/chat.ts`, `shared/ipc.ts`, `preload/index.ts`, `status-bar.ts`, `tab-row.ts`, `tabbar.ts`, `icons.ts`, `renderer/main.ts`, `styles.css`, `chat-items.ts`, `chat.css`, `index.ts`, `README.md` |

---

### Task 1: Shared RC types, copy and the account rules

**Files:**
- Create: `src/shared/remote-control.ts`
- Create: `src/main/remote-control/account-rules.ts`
- Test: `tests/unit/remote-control-rules.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/shared/remote-control.ts
  export type RemoteState =
    | { kind: 'off' }
    | { kind: 'connecting'; note?: string; waits?: true }
    | { kind: 'on'; url: string; leaving?: true; waits?: true }
    | { kind: 'unavailable'; reason: string }
    | { kind: 'failed'; reason: string }
  export const isBridgeId: (v: unknown) => v is string        // ^[A-Za-z0-9_-]{1,128}$
  export function remoteLink(id: string): string               // `https://claude.ai/code/${id}`
  export const REMOTE_NAME_MAX = 60
  export function remoteName(title: string): string
  export const REMOTE_REASONS: { token: string; baseUrl: string; noSignIn: string; bridgeChanged: string; relogin: string; untrustedDevice: string; unreachable: string }
  export function refusedReason(status: number): string       // `claude.ai refused Remote Control (${status})`
  export const RENEW_WAIT_NOTE: string                         // "Waiting for Claude Code to renew this account's sign-in"
  export function connectTimeoutToast(tab: string): string     // `Remote Control did not connect in ${tab}: see the terminal`
  // src/main/remote-control/account-rules.ts
  export type RemoteAccountKind = 'main' | 'login' | 'token'
  export function remoteUnavailable(kind: RemoteAccountKind, env: Readonly<Record<string, string | undefined>>): string | null
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/remote-control-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { remoteUnavailable } from '../../src/main/remote-control/account-rules'
import { connectTimeoutToast, isBridgeId, REMOTE_REASONS, refusedReason, remoteLink, remoteName, RENEW_WAIT_NOTE } from '../../src/shared/remote-control'

const TOKEN = 'This account signs in with a token: Remote Control needs a claude.ai sign-in'
const BASE = "Remote Control needs Anthropic's own service: this account uses ANTHROPIC_BASE_URL"

describe('remoteName', () => {
  it('is the tab title without control characters, cut to 60 characters', () => {
    expect(remoteName('Fix the\tparser\n')).toBe('Fix theparser')
    expect(remoteName('x'.repeat(70))).toBe('x'.repeat(60))
    expect(Array.from(remoteName('😀'.repeat(70)))).toHaveLength(60)
  })
  it("drops the spinner Claude Code puts before its title, and leading dashes, so --rc never reads the name as an option", () => {
    expect(remoteName('✳ Fix the parser')).toBe('Fix the parser')
    expect(remoteName('--force push')).toBe('force push')
  })
  it('is ClaudeTerm when nothing is left: /remote-control without a name would disconnect instead', () => {
    expect(remoteName('')).toBe('ClaudeTerm')
    expect(remoteName(' \u0007 ')).toBe('ClaudeTerm')
  })
})

describe('the id, the link and the copy', () => {
  it('an id is 1 to 128 letters, digits, _ and -', () => {
    for (const ok of ['session_011edtAbC', 'cse_01Hk-x', 'x'.repeat(128)]) expect(isBridgeId(ok)).toBe(true)
    for (const bad of ['', 'a b', 'x'.repeat(129), 'a/b', 42, null, undefined]) expect(isBridgeId(bad)).toBe(false)
  })
  it('the link, the reasons and the toast are the spec’s words', () => {
    expect(remoteLink('cse_1')).toBe('https://claude.ai/code/cse_1')
    expect(refusedReason(403)).toBe('claude.ai refused Remote Control (403)')
    expect(connectTimeoutToast('work')).toBe('Remote Control did not connect in work: see the terminal')
    expect(RENEW_WAIT_NOTE).toBe("Waiting for Claude Code to renew this account's sign-in")
    expect(REMOTE_REASONS).toEqual({
      token: TOKEN,
      baseUrl: BASE,
      noSignIn: 'No claude.ai sign-in found for this account',
      bridgeChanged: "This ClaudeTerm cannot host Remote Control: the Agent SDK's bridge changed",
      relogin: 'Sign in to this account again (claude auth login)',
      untrustedDevice: 'Turn Remote Control on once in a terminal tab of this account: Claude Code registers this computer then',
      unreachable: 'claude.ai could not be reached'
    })
  })
})

describe('remoteUnavailable', () => {
  it('a token account is unavailable with the token reason', () => {
    expect(remoteUnavailable('token', {})).toBe(TOKEN)
  })
  it('a sign-in from the environment makes the main account and a sign-in account unavailable with the same reason', () => {
    const signIns: [string, string][] = [['CLAUDE_CODE_OAUTH_TOKEN', 't'], ['ANTHROPIC_API_KEY', 'k'], ['ANTHROPIC_AUTH_TOKEN', 'a'], ['CLAUDE_CODE_USE_BEDROCK', '1'], ['CLAUDE_CODE_USE_VERTEX', 'true'], ['CLAUDE_CODE_USE_FOUNDRY', 'yes']]
    for (const [name, value] of signIns) {
      expect(remoteUnavailable('main', { [name]: value })).toBe(TOKEN)
      expect(remoteUnavailable('login', { [name]: value })).toBe(TOKEN)
    }
  })
  it('an empty variable, or a provider switch that is off, is no sign-in', () => {
    expect(remoteUnavailable('main', { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'false' })).toBeNull()
  })
  it('a non-default ANTHROPIC_BASE_URL is unavailable; the default, with or without its slash, and an empty one are not', () => {
    expect(remoteUnavailable('main', { ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe(BASE)
    expect(remoteUnavailable('login', { ANTHROPIC_BASE_URL: 'http://localhost:8080/' })).toBe(BASE)
    for (const fine of ['https://api.anthropic.com', 'https://api.anthropic.com/', 'HTTPS://API.ANTHROPIC.COM', '']) expect(remoteUnavailable('main', { ANTHROPIC_BASE_URL: fine })).toBeNull()
  })
  it('the sign-in rule comes before the base URL rule', () => {
    expect(remoteUnavailable('main', { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe(TOKEN)
  })
  it('names are matched ignoring case, as Windows reads them', () => {
    expect(remoteUnavailable('main', { anthropic_api_key: 'k' })).toBe(TOKEN)
    expect(remoteUnavailable('main', { Anthropic_Base_Url: 'https://proxy.example.com' })).toBe(BASE)
  })
  it('the main account and a sign-in account with a plain environment can use RC', () => {
    expect(remoteUnavailable('main', { PATH: '/usr/bin' })).toBeNull()
    expect(remoteUnavailable('login', { CLAUDE_CONFIG_DIR: '/accounts/work' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/remote-control-rules.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement `src/shared/remote-control.ts`**

- The type, `isBridgeId`, `remoteLink`, `refusedReason`, `connectTimeoutToast`, `RENEW_WAIT_NOTE` and `REMOTE_REASONS` as the Interfaces block and the tests give them.
- `remoteName(title)`, in this order: remove a leading `/^[✳◐◑] (?=\S)/` (the spinner, as `claudeTitle` in `src/renderer/util.ts:2` does); remove every `\p{Cc}` character; trim; remove leading `-` characters and trim again; keep the first 60 code points (`Array.from`) and trim the end; an empty result is `'ClaudeTerm'`.

- [ ] **Step 4: Implement `remoteUnavailable` in `src/main/remote-control/account-rules.ts`**

- Look up a name ignoring case: the first entry of `env` whose name `.toUpperCase()` equals the wanted one.
- A sign-in from the environment: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` with a non-empty value; or `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` whose trimmed, lowercased value is `1`, `true`, `yes` or `on`.
- Order: `kind === 'token'` or a sign-in from the environment → `REMOTE_REASONS.token`; else an `ANTHROPIC_BASE_URL` that is not empty and, trimmed, lowercased and without trailing `/`, is not `https://api.anthropic.com` → `REMOTE_REASONS.baseUrl`; else `null`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/remote-control-rules.test.ts`, then `npm run typecheck`.
Expected: PASS, no type errors.

- [ ] **Step 6: Leave the work uncommitted**

Report the changed files. Suggested message: `feat: the Remote Control state, its copy and the account rules`.

---

### Task 2: The hook reports the RC id

**Files:**
- Modify: `src/shared/protocol.ts` (`SessionMessage` :48, `StatusMessage` :59, `AttentionMessage` :88, `TurnMessage` :109; `parsePipeMessage`: the `session` branch :354-364, `turn` :366-369, `attention` :450-460, `status` :466-473)
- Modify: `src/hook/session-hook.ts` (`bridgeId` new; `runSessionHook` :151-159; `runStatusLine` :161-167)
- Modify: `src/main/child-env.ts:1` (`STRIPPED`)
- Test: `tests/unit/protocol.test.ts`, `tests/unit/session-hook.test.ts`, `tests/unit/child-env.test.ts`, `tests/integration/session-hook.int.test.ts`

**Interfaces:**
- Consumes: `isBridgeId` (Task 1).
- Produces:
  - `SessionMessage`, `StatusMessage`, `TurnMessage` and `AttentionMessage` gain `remote?: string | null`, doc comment: `the Remote Control session id (CLAUDE_CODE_BRIDGE_SESSION_ID) while the session is connected, null while it is not; absent from a sender that does not say (an older hook, a chat tab's status)`.
  - `parsePipeMessage` keeps a valid id, keeps `null`, and leaves the field out for any other value or when absent.
  - `export function bridgeId(env: NodeJS.ProcessEnv): string | null` in `session-hook.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/protocol.test.ts`, a new `describe`:

```ts
describe('parsePipeMessage: the Remote Control id', () => {
  const ID = 'session_011edtAbC-9_x'
  const messages = [
    { v: 1, type: 'status', tabId: TAB, sessionId: SID, model: { id: 'claude-opus-5-5' } },
    { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'startup' },
    { v: 1, type: 'turn', tabId: TAB, sessionId: SID },
    { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done' }
  ]
  const parsed = (m: object): Record<string, unknown> => {
    const r = parsePipeMessage(JSON.stringify(m))
    if (!r.ok) throw new Error(r.error)
    return r.message as unknown as Record<string, unknown>
  }
  it('keeps a valid id, and a null, on status, session, turn and attention messages', () => {
    for (const m of messages) {
      expect(parsed({ ...m, remote: ID }).remote).toBe(ID)
      expect(parsed({ ...m, remote: null }).remote).toBeNull()
    }
  })
  it('drops a value that is no id: the message is taken without the field', () => {
    for (const m of messages) for (const bad of ['', 'has space', 'x'.repeat(129), 42, { id: ID }]) expect('remote' in parsed({ ...m, remote: bad })).toBe(false)
  })
  it('a message without the field has none', () => {
    for (const m of messages) expect('remote' in parsed(m)).toBe(false)
  })
})
```

`tests/unit/session-hook.test.ts`, a new `describe` (send records what the hook sends, as the file's other `runSessionHook` tests do):

```ts
describe('the Remote Control id', () => {
  const ID = 'session_011edtAbC'
  const sentBy = async (input: object, env: Record<string, string>, statusLine = false): Promise<PipeMessage[]> => {
    const sent: PipeMessage[] = []
    const send = async (_pipe: string, msg: PipeMessage): Promise<PipeResponse> => { sent.push(msg); return { ok: true } }
    const full = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: 'p', ...env }
    if (statusLine) await runStatusLine(JSON.stringify(input), full, send)
    else await runSessionHook(JSON.stringify(input), full, send)
    return sent
  }
  const events = [
    { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' },
    { session_id: SID, hook_event_name: 'UserPromptSubmit' },
    { session_id: SID, hook_event_name: 'Stop' },
    { session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }
  ]
  it('SessionStart, UserPromptSubmit, Stop and a permission request carry CLAUDE_CODE_BRIDGE_SESSION_ID as remote', async () => {
    for (const e of events) expect((await sentBy(e, { CLAUDE_CODE_BRIDGE_SESSION_ID: ID }))[0]).toMatchObject({ remote: ID })
  })
  it('without the variable, or with a value that is no id, they carry null', async () => {
    for (const e of events) {
      expect((await sentBy(e, {}))[0]).toMatchObject({ remote: null })
      expect((await sentBy(e, { CLAUDE_CODE_BRIDGE_SESSION_ID: 'not an id' }))[0]).toMatchObject({ remote: null })
    }
  })
  it('a subagent start, a session end and an edit carry no remote field', async () => {
    const file = WIN ? 'C:\\w\\a.ts' : '/w/a.ts'
    for (const e of [
      { session_id: SID, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      { session_id: SID, hook_event_name: 'SessionEnd' },
      { session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_1', tool_input: { file_path: file } }
    ]) expect('remote' in (await sentBy(e, { CLAUDE_CODE_BRIDGE_SESSION_ID: ID }))[0]).toBe(false)
  })
  it('the statusLine carries it too', async () => {
    const input = { session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } }
    expect((await sentBy(input, { CLAUDE_CODE_BRIDGE_SESSION_ID: ID }, true))[0]).toMatchObject({ type: 'status', remote: ID })
    expect((await sentBy(input, {}, true))[0]).toMatchObject({ type: 'status', remote: null })
  })
})
```

(Import `WIN` from `../fixtures/platform` and the `PipeMessage`, `PipeResponse` types if the file lacks them.)

`tests/unit/child-env.test.ts`, in `describe('buildChildEnv')`:

```ts
  it('a tab never inherits the Remote Control id of the Claude Code that started ClaudeTerm', () => {
    expect(buildChildEnv({ PATH: 'C:\\Windows', CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01abc' })).toEqual({ PATH: 'C:\\Windows', TERM_PROGRAM: 'ClaudeTerm', COLORTERM: 'truecolor' })
  })
```

`tests/integration/session-hook.int.test.ts`:
- In `runAll`, build the child's environment from `process.env` without `CLAUDE_CODE_BRIDGE_SESSION_ID` (copy, then `delete`), so a run from an RC-connected Claude Code session gets no id.
- Add `remote: null` to every exact expectation of a `session`, `status`, `turn` or `attention` message in the file: the `expected` and `expectedStatus` constants and any inline object. Run the file after the code step to find any you missed.
- Add, in `describe('session hook end to end')` (run the status line the way the file's statusLine tests run it):

```ts
  it('node bundle: with CLAUDE_CODE_BRIDGE_SESSION_ID the statusLine and the hooks send it as remote', async () => {
    const { pipe, got } = await listen()
    const env = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe, CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01IntTest' }
    expect(await run(process.execPath, [bundle, 'status'], env, STATUS_INPUT)).toEqual({ code: 0, stdout: '' })
    expect(await run(process.execPath, [bundle], env)).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([{ ...expectedStatus, remote: 'session_01IntTest' }, { ...expected, remote: 'session_01IntTest' }])
  })
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/protocol.test.ts tests/unit/session-hook.test.ts tests/unit/child-env.test.ts tests/integration/session-hook.int.test.ts`
Expected: FAIL on the new tests (no `remote` field; the variable is inherited).

- [ ] **Step 3: Implement**

1. `src/shared/protocol.ts`: add the field to the four interfaces. Add a helper `remoteField(v: unknown): { remote?: string | null }` (`null` → `{ remote: null }`, `isBridgeId(v)` → `{ remote: v }`, anything else → `{}`) and spread it into the `session`, `turn`, `attention` and `status` results.
2. `src/hook/session-hook.ts`: `bridgeId(env)` returns `env.CLAUDE_CODE_BRIDGE_SESSION_ID` when `isBridgeId`, else `null`. `runSessionHook` sends `{ ...msg, remote: bridgeId(env) }` when `msg.type` is `session`, `turn` or `attention`; `runStatusLine` sends `{ ...msg, remote: bridgeId(env) }`. `hookMessage` and `statusFromStatusLine` do not change.
3. `src/main/child-env.ts`: add `'CLAUDE_CODE_BRIDGE_SESSION_ID'` to `STRIPPED`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS, no type errors.

- [ ] **Step 5: Leave the work uncommitted**

Suggested message: `feat: the hook reports the Remote Control id of the session`.

---

### Task 3: The tab's choice is kept with the tab, and `--rc` at launch

**Files:**
- Modify: `src/shared/types.ts` (`OpenTabRequest` :59, `SessionSnapshotTab` :95)
- Modify: `src/main/session-store.ts` (`parseSnapshot` :21-41)
- Modify: `src/main/profiles.ts` (`ClaudeLaunch` :193-200, `buildClaudeCommandLine` :202-213)
- Modify: `src/main/tab-manager.ts` (`LaunchRequest` :36, `TabManagerDeps` :86, `TabRecord` :132, `open` :171, `restart` :340, `changeFolder` :370, `switchAccount` :402, `switchView` :462, `resumeSession` :508, `snapshot` :615, `start` :793)
- Modify: `src/main/index.ts` (`resolveLaunch` :960-986, the restore's `openTab` :2043, a new `tabTitleOf` beside `sessionTitles` :1347, the TabManager deps)
- Test: `tests/unit/profiles.test.ts`, `tests/unit/tab-manager.test.ts`, `tests/unit/session-store.test.ts`, `tests/unit/ipc-guards.test.ts`, `tests/e2e/restore.spec.ts`

**Interfaces:**
- Consumes: `remoteName` (Task 1), `remoteUnavailable` and `RemoteAccountKind` (Task 1).
- Produces:
  - `OpenTabRequest.remoteControl?: boolean`; `SessionSnapshotTab.remoteControl?: true` (written only when on).
  - `ClaudeLaunch.rc?: string | null`: the RC session name; `buildClaudeCommandLine` appends ` --rc <quoted>` after `--fork-session`.
  - `LaunchRequest.rc?: string | null`.
  - `TabManagerDeps.remoteName?(tab: { id: string; customTitle: string | null; folder: string; view: TabView | null }, account: string | null): string | null` — the `--rc` name for a tab whose choice is on, starting on that account; `null` when RC is not available there (the tab then starts without `--rc` and keeps its choice).
  - `TabManagerDeps.onProcessStarted?(tab: TabInfo): void` — every process start of a Claude tab (open, restart, view switch, account switch, resume, fallback), before the process spawns.
  - `TabManager.remoteControl(tabId: string): boolean` and `TabManager.setRemoteControl(tabId: string, on: boolean): void` (Claude tabs only; a change saves the snapshot).
  - `index.ts`: `const tabTitleOf = (tab: { id: string; customTitle: string | null; folder: string; view: TabView | null }): string` — `customTitle`, else (chat view) `sessionTitles.get(id) ?? titles.get(id)` or (terminal) `titles.get(id) ?? sessionTitles.get(id)`, else `basename(folder)`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/profiles.test.ts`:

```ts
describe('buildClaudeCommandLine: --rc', () => {
  const c: ClaudeLaunch = { command: 'claude', settingsPath: null, resumeSessionId: null, forkSession: false, rc: `it's a "tab" 100%` }
  it('adds --rc with the name quoted for each shell family, after the resume', () => {
    expect(buildClaudeCommandLine('powershell', c)).toBe(`claude --rc 'it''s a "tab" 100%'`)
    expect(buildClaudeCommandLine('bash', c)).toBe(`claude --rc 'it'\\''s a "tab" 100%'`)
    expect(buildClaudeCommandLine('zsh', c)).toBe(`claude --rc 'it'\\''s a "tab" 100%'`)
    expect(buildClaudeCommandLine('fish', c)).toBe(`claude --rc 'it\\'s a "tab" 100%'`)
    // cmd.exe has no escape for " and % inside double quotes: they are left out
    expect(buildClaudeCommandLine('cmd', c)).toBe(`claude --rc "it's a tab 100"`)
    expect(buildClaudeCommandLine('powershell', { ...c, resumeSessionId: SID })).toBe(`claude --resume ${SID} --rc 'it''s a "tab" 100%'`)
  })
  it('no name, no --rc', () => {
    expect(buildClaudeCommandLine('bash', { ...c, rc: null })).toBe('claude')
    expect(buildClaudeCommandLine('bash', { command: 'claude', settingsPath: null, resumeSessionId: null, forkSession: false })).toBe('claude')
  })
})
```

`tests/unit/tab-manager.test.ts`, a new `describe('TabManager: Remote Control')` using the file's `setup()` (its `launches` records every `LaunchRequest`):

```ts
  it('a tab opened with remoteControl starts with --rc and keeps the choice in the snapshot; a tab without has neither', () => {
    const asked: string[] = []
    const { tm, launches } = setup({ remoteName: (tab, account) => { asked.push(`${tab.customTitle}:${account}`); return 'mine' } })
    const on = tm.open({ kind: 'claude', cwd: 'C:\\w', title: 'mine', remoteControl: true })
    const off = tm.open({ kind: 'claude', cwd: 'C:\\w', title: 'other' })
    expect(launches.map((l) => l.rc ?? null)).toEqual(['mine', null])
    expect(asked).toEqual(['mine:null'])
    expect([tm.remoteControl(on.id), tm.remoteControl(off.id)]).toEqual([true, false])
    expect(tm.snapshot().map((t) => t.remoteControl)).toEqual([true, undefined])
  })

  it('every new process of a tab whose choice is on starts with --rc: a restart, a resume, an account switch', async () => {
    const seen: LaunchRequest[] = []
    const { tm, ptys } = setup({ remoteName: () => 'mine', restartWaitMs: 0, resolveLaunch: (req) => { seen.push(req); return accountLaunch(req) } }, { exitOnKill: true })
    const tab = tm.open({ kind: 'claude', cwd: 'C:\\w', title: 'mine', remoteControl: true })
    ptys[0].emitExit(0)
    await tm.restart(tab.id)
    expect(await tm.resumeSession(tab.id, '7f4e3d9c-0a6b-4c5d-b3e4-f5a6b7c8d9e0')).toBe(true)
    expect(await tm.switchAccount(tab.id, 'acc-1')).toBe(true)
    expect(seen.length).toBeGreaterThanOrEqual(4)
    expect(seen.map((l) => l.rc)).toEqual(seen.map(() => 'mine'))
  })

  it('setRemoteControl changes the choice and saves the snapshot; a shell tab or an unknown id has none', () => {
    const { tm, onStateChanged } = setup()
    const claude = tm.open({ kind: 'claude', cwd: 'C:\\w' })
    const shell = tm.open({ kind: 'shell', cwd: 'C:\\w' })
    onStateChanged.mockClear()
    tm.setRemoteControl(claude.id, true)
    expect(tm.remoteControl(claude.id)).toBe(true)
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    tm.setRemoteControl(claude.id, true)
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    tm.setRemoteControl(shell.id, true)
    tm.setRemoteControl('nope', true)
    expect([tm.remoteControl(shell.id), tm.remoteControl('nope')]).toEqual([false, false])
  })

  it('remoteName answering null starts the tab without --rc and keeps its choice', () => {
    const { tm, launches } = setup({ remoteName: () => null })
    const tab = tm.open({ kind: 'claude', cwd: 'C:\\w', remoteControl: true })
    expect(launches[0].rc ?? null).toBeNull()
    expect(tm.remoteControl(tab.id)).toBe(true)
  })

  it('onProcessStarted hears of each start of a Claude tab before it spawns, and not of a shell tab', async () => {
    const order: string[] = []
    const spawned = trackedSpawn(order)
    const { tm } = setup({ restartWaitMs: 0, onProcessStarted: (tab) => order.push(`started:${tab.id}`), spawn: spawned.spawn })
    const tab = tm.open({ kind: 'claude', cwd: 'C:\\w' })
    tm.open({ kind: 'shell', cwd: 'C:\\w' })
    expect(order).toEqual([`started:${tab.id}`, 'spawn', 'spawn'])
    spawned.ptys[0].emitExit(0)
    await tm.restart(tab.id)
    expect(order.slice(3)).toEqual([`started:${tab.id}`, 'spawn'])
  })
```

(`accountLaunch` and `trackedSpawn` are the file's helpers, :72 and :90. The view switch takes the same path through `resolveLaunch` and `start`; Task 12's e2e proves it end to end.)

`tests/unit/session-store.test.ts`:

```ts
  it('a Claude tab saved with remoteControl true comes back with it; any other value, and a shell tab, have none', () => {
    const tab = (x: object) => ({ kind: 'claude', profile: 'p', cwd: 'C:\\w', ...x })
    const snap = parseSnapshot(JSON.stringify({ version: 1, savedAt: 'x', tabs: [tab({ remoteControl: true }), tab({ remoteControl: 'yes' }), tab({}), { kind: 'shell', profile: 'p', cwd: 'C:\\w', remoteControl: true }] }))!
    expect(snap.tabs.map((t) => t.remoteControl)).toEqual([true, undefined, undefined, undefined])
  })
```

`tests/unit/ipc-guards.test.ts`:

```ts
  it('the window cannot open a tab with Remote Control on: openTabRequestFields leaves remoteControl out', () => {
    const req = { kind: 'claude' as const, cwd: ABS, remoteControl: true }
    expect(isOpenTabRequest(req)).toBe(true)
    expect(openTabRequestFields(req)).not.toHaveProperty('remoteControl')
  })
```

(`ABS`: an absolute path for the platform, as the file's other tests use.)

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/profiles.test.ts tests/unit/tab-manager.test.ts tests/unit/session-store.test.ts tests/unit/ipc-guards.test.ts`
Expected: FAIL (no `rc`, no `remoteControl`, no `onProcessStarted`).

- [ ] **Step 3: Implement**

1. `types.ts`, `session-store.ts`: the two optional fields; `parseSnapshot` adds `...(x.kind === 'claude' && x.remoteControl === true ? { remoteControl: true as const } : {})`.
2. `profiles.ts`: `rc?: string | null` on `ClaudeLaunch`; when `c.rc` is a non-empty string, `line += \` --rc ${quoteForShell(family, family === 'cmd' ? c.rc.replace(/["%]/g, '') : c.rc)}\``.
3. `tab-manager.ts`:
   - `TabRecord.remoteControl: boolean`; `open()` generates the tab id before `resolveLaunch` and sets `remoteControl = req.kind === 'claude' && req.remoteControl === true`.
   - A private `rcOf(rec or the open() inputs, account): string | null` = `remoteControl ? this.deps.remoteName?.({ id, customTitle, folder, view }, account) ?? null : null`. Every Claude `resolveLaunch` call (`open`, `restart`, `changeFolder`, `switchAccount` both calls, `switchView`, `resumeSession`) passes `rc` for the account it resolves for.
   - `start(rec)`: for a Claude tab, call `this.deps.onProcessStarted?.({ ...rec.info })` first.
   - `fallBack` keeps the launch resolved at the chat's start, which already carries the choice.
   - `snapshot()`: `...(rec.remoteControl ? { remoteControl: true as const } : {})`.
   - `remoteControl(tabId)`, `setRemoteControl(tabId, on)` (no change, a shell tab or an unknown id: nothing; a change: `this.changed()`).
4. `index.ts`:
   - `resolveLaunch`: the `claude` object gets `rc: req.rc ?? null`.
   - The restore's `openTab(...)` request gets `...(t.remoteControl ? { remoteControl: true } : {})`.
   - `tabTitleOf` beside `sessionTitles` (see Interfaces).
   - TabManager deps: `remoteName: (tab, account) => remoteUnavailable(accountKindOf(account), launchEnvOf(account)) === null ? remoteName(tabTitleOf(tab)) : null`, with two small helpers next to `accountLabel` (:355): `accountKindOf(account: string | null): RemoteAccountKind` (`null` → `'main'`, `accounts.kindOf(id) === 'token'` → `'token'`, else `'login'`) and `launchEnvOf(account: string | null): Record<string, string>` (`applyEnvPatch(childEnv(), folder === null ? undefined : loginEnv(folder))`, `folder = account === null ? null : accounts.folderOf(account)`).

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Write the failing e2e test**

Create `tests/e2e/remote-control-helpers.ts` with `RC_CLEAN_ENV` (its contents are in Task 5, Step 5; create the file now with that constant only). Then, in `tests/e2e/restore.spec.ts`:

```ts
test('a restored tab keeps its Remote Control choice: it starts with --rc, and the next snapshot keeps it', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [{ kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'mine', claudeSessionId: SID, remoteControl: true }] }))
  const { app, page } = await launchApp({ dataDir, env: RC_CLEAN_ENV })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain('--rc mine')
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: { remoteControl?: boolean }[] }
  expect(saved.tabs[0].remoteControl).toBe(true)
})
```

- [ ] **Step 6: Run the e2e test and watch it pass**

Run: `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run build && node scripts/e2e.mjs tests/e2e/restore.spec.ts --workers=1"`
Expected: every test of `restore.spec.ts` passes. (Before Step 3 the new one fails: no `--rc` in the buffer.)

- [ ] **Step 7: Leave the work uncommitted**

Suggested message: `feat: a Claude tab keeps its Remote Control choice and starts with --rc`.

---

### Task 4: StatusHub keeps the id; `RemoteControlHub` computes the state; the status carries it

**Files:**
- Modify: `src/main/status-hub.ts` (`StatusHubDeps` :7, `TabState` :18, `status` :75, `sessionEnd` :124, `resetTab` :136, `get` :164, `tab` :171)
- Modify: `src/shared/ipc.ts` (`StatusUpdate` :263)
- Create: `src/main/remote-control/remote-control-hub.ts`
- Modify: `src/main/index.ts` (the status coalescer :626-645; the hub after `const tabs` :853; the pipe handlers `session` :2487, `turn` :2593, `attention` :2544; `onTabClosed` :908; TabManager `onProcessStarted`)
- Test: `tests/unit/status-hub.test.ts`, `tests/unit/remote-control-hub.test.ts`

**Interfaces:**
- Consumes: `RemoteState`, `remoteLink` (Task 1); `remoteUnavailable`, `RemoteAccountKind` (Task 1); `TabManager.remoteControl/setRemoteControl`, `onProcessStarted` (Task 3); `StatusMessage.remote` etc. (Task 2).
- Produces:
  - `StatusUpdate.remote?: RemoteState | null` — the tab's RC state; absent or null: no segment.
  - `StatusHubDeps.remoteChanged?(tabId: string, id: string | null, previous: string | null): void` and `StatusHubDeps.remoteState?(tabId: string): RemoteState | null`.
  - `StatusHub.remote(tabId: string, sessionId: string, id: string | null): void`, `StatusHub.remoteId(tabId: string): string | null`, `StatusHub.forgetRemote(tabId: string): void` (silent).
  - ```ts
    export interface RemoteTab { view: TabView; account: string | null; exited: boolean }
    export interface RemoteControlDeps {
      /** a local Claude tab as main knows it; null for a shell tab, another device's tab, or an unknown id */
      tab(tabId: string): RemoteTab | null
      accountKind(account: string | null): RemoteAccountKind
      /** the environment the tab's Claude Code starts with */
      env(tabId: string): Record<string, string>
      choice(tabId: string): boolean
      setChoice(tabId: string, on: boolean): void
      /** the last id the tab's Claude Code reported (StatusHub.remoteId) */
      reportedId(tabId: string): string | null
      forgetReported(tabId: string): void
      onChange(tabId: string): void
    }
    export class RemoteControlHub {
      constructor(d: RemoteControlDeps)
      state(tabId: string): RemoteState | null
      reported(tabId: string, id: string | null, previous: string | null): void
      processStarted(tabId: string): void
      removeTab(tabId: string): void
    }
    ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/status-hub.test.ts` (the file's `TAB`, `SID`, `SID2` and `status(over)`):

```ts
/** a hub whose remoteChanged records [tabId, id, previous] and whose remoteState answers `state` */
function rcHub() {
  const told: [string, string | null, string | null][] = []
  const changes: string[] = []
  const box: { state: RemoteState | null } = { state: { kind: 'off' } }
  const hub = new StatusHub({ now: () => 1000, readMeta: () => null, onChange: (t) => changes.push(t), remoteChanged: (t, id, prev) => told.push([t, id, prev]), remoteState: () => box.state })
  return { hub, told, changes, box }
}

describe('StatusHub: the Remote Control id', () => {
  it('a status and the hooks’ reports keep the last id; only a change is told, and the window hears of it', () => {
    const { hub, told, changes } = rcHub()
    hub.status(status({ remote: 'session_a' }))
    hub.remote(TAB, SID, 'session_a')
    changes.length = 0
    hub.remote(TAB, SID, null)
    expect(told).toEqual([[TAB, 'session_a', null], [TAB, null, 'session_a']])
    expect(hub.remoteId(TAB)).toBeNull()
    expect(changes).toEqual([TAB])
  })
  it('a status without the field (a chat tab, an older hook) leaves the id as it was', () => {
    const { hub } = rcHub()
    hub.remote(TAB, SID, 'session_a')
    hub.status(status())
    expect(hub.remoteId(TAB)).toBe('session_a')
  })
  it('a report of a retired session is dropped', () => {
    const { hub } = rcHub()
    hub.session(TAB, SID, 'startup')
    hub.session(TAB, SID2, 'clear')
    hub.remote(TAB, SID, 'session_old')
    expect(hub.remoteId(TAB)).toBeNull()
  })
  it('a new session in the same process keeps the id; the end of the session, a reset and forgetRemote clear it without telling', () => {
    const { hub, told } = rcHub()
    hub.session(TAB, SID, 'startup')
    hub.remote(TAB, SID, 'session_a')
    hub.session(TAB, SID2, 'clear')
    expect(hub.remoteId(TAB)).toBe('session_a')
    hub.sessionEnd(TAB, SID2)
    expect(hub.remoteId(TAB)).toBeNull()
    hub.session(TAB, SID2, 'resume')
    hub.remote(TAB, SID2, 'session_b')
    hub.resetTab(TAB)
    expect(hub.remoteId(TAB)).toBeNull()
    hub.remote(TAB, SID2, 'session_c')
    hub.forgetRemote(TAB)
    expect(hub.remoteId(TAB)).toBeNull()
    expect(told.map((c) => c[1])).toEqual(['session_a', 'session_b', 'session_c'])
  })
  it('get carries the state remoteState gives, and nothing when it gives null', () => {
    const { hub, box } = rcHub()
    expect(hub.get(TAB).remote).toEqual({ kind: 'off' })
    box.state = null
    expect('remote' in hub.get(TAB)).toBe(false)
  })
})
```

(If `sessionEnd` retires `SID2` so that the `resume` report is needed to take it back, as `session()` does at :40, the test already sends it; if `resetTab` forgets the session, send `hub.session(TAB, SID2, 'resume')` again before `session_c`.)

`tests/unit/remote-control-hub.test.ts` (new):

```ts
import { describe, expect, it } from 'vitest'
import type { RemoteAccountKind } from '../../src/main/remote-control/account-rules'
import { RemoteControlHub, type RemoteControlDeps, type RemoteTab } from '../../src/main/remote-control/remote-control-hub'

const TAB = 'tab-1'
const ID = 'session_01abc'

/** the hub with fake dependencies; `report` does what StatusHub does: keeps the id and tells the hub of a change */
function world(o: { view?: 'terminal' | 'chat'; kind?: RemoteAccountKind; env?: Record<string, string>; choice?: boolean } = {}) {
  const w = {
    tab: { view: o.view ?? 'terminal', account: null, exited: false } as RemoteTab | null,
    kind: o.kind ?? ('main' as RemoteAccountKind),
    env: o.env ?? {},
    choice: o.choice ?? false,
    reported: null as string | null,
    changes: 0
  }
  const deps: RemoteControlDeps = {
    tab: (id) => (id === TAB ? w.tab : null),
    accountKind: () => w.kind,
    env: () => w.env,
    choice: () => w.choice,
    setChoice: (_id, on) => { w.choice = on },
    reportedId: () => w.reported,
    forgetReported: () => { w.reported = null },
    onChange: () => { w.changes++ }
  }
  const hub = new RemoteControlHub(deps)
  const report = (id: string | null): void => {
    const previous = w.reported
    w.reported = id
    if (previous !== id) hub.reported(TAB, id, previous)
  }
  return { hub, w, report }
}

describe('RemoteControlHub: terminal reports', () => {
  it('a terminal tab is on with its link while its Claude Code reports an id, and off without one', () => {
    const { hub, report } = world()
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    report(ID)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}` })
    report(null)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
  })
  it('an id the person brought up by typing /remote-control sets the choice; the id going away clears it', () => {
    const { w, report } = world()
    report(ID)
    expect(w.choice).toBe(true)
    report(null)
    expect(w.choice).toBe(false)
  })
  it('a token account, or a sign-in from the environment, is unavailable with its reason whatever is reported', () => {
    const token = world({ kind: 'token' })
    token.report(ID)
    expect(token.hub.state(TAB)).toEqual({ kind: 'unavailable', reason: 'This account signs in with a token: Remote Control needs a claude.ai sign-in' })
    expect(world({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } }).hub.state(TAB)).toEqual({ kind: 'unavailable', reason: "Remote Control needs Anthropic's own service: this account uses ANTHROPIC_BASE_URL" })
  })
  it('a chat-view tab ignores the terminal reports', () => {
    const { hub, w, report } = world({ view: 'chat' })
    report(ID)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
  })
  it('an exited tab is off; Claude Code ending keeps the choice for the next start', () => {
    const { hub, w, report } = world()
    report(ID)
    w.tab = { ...w.tab!, exited: true }
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(true)
  })
  it('a shell tab, another device’s tab and an unknown id have no state', () => {
    const { hub, w } = world()
    w.tab = null
    expect(hub.state(TAB)).toBeNull()
    expect(hub.state('other')).toBeNull()
  })
  it('a new process forgets what the old one reported, and the window hears of it', () => {
    const { hub, w, report } = world()
    report(ID)
    const before = w.changes
    hub.processStarted(TAB)
    expect(w.reported).toBeNull()
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.changes).toBeGreaterThan(before)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/status-hub.test.ts tests/unit/remote-control-hub.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `StatusHub` and `StatusUpdate`**

- `TabState.remoteId: string | null` (initially null). A private `setRemote(t, tabId, id)`: no change → nothing; else store it, call `deps.remoteChanged?.(tabId, id, previous)` and `deps.onChange(tabId)`.
- `status(m)`: after the existing lines, `if (m.remote !== undefined) this.setRemote(...)`.
- `remote(tabId, sessionId, id)`: the session checks of `background()` (:66-73), then `setRemote`.
- `clear()` and `switchTo()` leave `remoteId` alone (RC lives through `/clear`). `sessionEnd` (for the current session) and `resetTab` set it to null silently; `forgetRemote` too. `removeTab` drops it with the tab.
- `get()`: `...(state ? { remote: state } : {})` where `state = this.deps.remoteState?.(tabId) ?? null`.
- `ipc.ts`: `remote?: RemoteState | null` on `StatusUpdate`, doc comment `the tab's Remote Control state; absent or null for a tab without the segment (a shell tab, another device's tab)`.

- [ ] **Step 4: Implement `RemoteControlHub` (terminal part)**

- `state(tabId)`: `tab` null → `null`; `remoteUnavailable(accountKind(account), env(tabId))` → `{ kind: 'unavailable', reason }`; exited → off; chat view → off (Task 12 gives chat tabs their state); terminal: `reportedId` → `{ kind: 'on', url: remoteLink(id) }`, else off.
- `reported(tabId, id, previous)`: terminal view only. `id !== null && previous === null` → `setChoice(true)`; `id === null && previous !== null` → `setChoice(false)`. Then `onChange(tabId)`.
- `processStarted(tabId)`: `forgetReported(tabId)`, `onChange(tabId)`.
- `removeTab(tabId)`: drops anything kept for the tab (nothing yet; Task 5 adds timers).

- [ ] **Step 5: Wire it in `index.ts`**

1. Move the inline `onChange` coalescer of `new StatusHub` (:633-644) into `const statusSoon = (tabId: string): void => { … }` declared right before `statusHub`, and pass `onChange: statusSoon`.
2. StatusHub deps: `remoteChanged: (tabId, id, previous) => remoteControl.reported(tabId, id, previous)`, `remoteState: (tabId) => remoteControl.state(tabId)`.
3. Right after `const tabs = new TabManager(...)`: `const remoteControl = new RemoteControlHub({ tab: (id) => { const t = tabs.get(id); return t?.kind === 'claude' ? { view: t.view ?? 'terminal', account: t.account, exited: t.exited } : null }, accountKind: accountKindOf, env: (id) => tabs.claudeEnv(id) ?? {}, choice: (id) => tabs.remoteControl(id), setChoice: (id, on) => tabs.setRemoteControl(id, on), reportedId: (id) => statusHub.remoteId(id), forgetReported: (id) => statusHub.forgetRemote(id), onChange: statusSoon })`.
4. TabManager deps: `onProcessStarted: (tab) => remoteControl.processStarted(tab.id)`. `onTabClosed`: add `remoteControl.removeTab(tabId)`.
5. Pipe handlers: in `session`, right after `statusHub.session(...)`, and at the start of `turn` and `attention` (after the `isClaudeTab` check): `if (msg.remote !== undefined) statusHub.remote(msg.tabId, msg.sessionId, msg.remote)`. `status` needs nothing more (`statusHub.status` takes it).

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run tests/unit/status-hub.test.ts tests/unit/remote-control-hub.test.ts tests/unit/sync-remote-shapes.test.ts`, then `npm run typecheck`.
Expected: PASS. (The segment is drawn in Task 7, whose e2e covers this wiring.)

- [ ] **Step 7: Leave the work uncommitted**

Suggested message: `feat: main keeps each Claude tab's Remote Control state and sends it with the status`.

---

### Task 5: The switch in a terminal tab

**Files:**
- Modify: `src/main/chat/terminal-handoff.ts` (split `openInTerminal` :27-62)
- Modify: `src/main/remote-control/remote-control-hub.ts`
- Modify: `src/shared/ipc.ts` (`IPC`, `CtApi`), `src/preload/index.ts`
- Modify: `src/main/index.ts` (hub deps; the IPC handler beside the tab handlers after `isLocalClaudeTab` :3085)
- Test: `tests/unit/terminal-handoff.test.ts`, `tests/unit/remote-control-hub.test.ts`, `tests/e2e/remote-control.spec.ts` (new), `tests/e2e/remote-control-helpers.ts`

**Interfaces:**
- Consumes: Task 4's hub and deps; `connectTimeoutToast`, `remoteName` (Task 1); `tabTitleOf` (Task 3).
- Produces:
  - ```ts
    export type TypeDeps = Omit<HandoffDeps, 'setView'>
    /** waits for Claude Code's empty prompt (every 300 ms, up to 30 s) and types the line and Enter, without switching the view; true once typed.
     *  False for a line that is no handoff line, a tab that already waits for a line, a tab that went away, or a prompt that never came up (with the handoff's note and toast).
     *  onWait(true) when it first finds the prompt not empty, onWait(false) when that wait ends. */
    export function typeIntoPrompt(tabId: string, line: string, what: string, d: TypeDeps, onWait?: (waiting: boolean) => void): Promise<boolean>
    ```
  - `RemoteControlDeps` gains `type(tabId: string, line: string, onWait: (waiting: boolean) => void): Promise<boolean>`, `name(tabId: string): string`, `title(tabId: string): string`, `toast(text: string): void`, `later(ms: number, run: () => void): () => void` (the answer cancels the timer).
  - `RemoteControlHub.set(tabId: string, on: boolean): void`; `export const CONNECT_WAIT_MS = 30_000`.
  - `IPC.remoteControlSet = 'remote-control:set'`; `CtApi.remoteControlSet(tabId: string, on: boolean): void` (`ipcRenderer.send`).
  - `tests/e2e/remote-control-helpers.ts`: `RC_CLEAN_ENV`, `RC_SID`, `RC_TITLE`, `rcStatus(tabId, remote)`, `typedLines(log)`, `openRcTab(page, cwd, account?)`.

- [ ] **Step 1: Write the failing handoff tests**

`tests/unit/terminal-handoff.test.ts` (the file's `fakeDeps` works: `typeIntoPrompt` ignores `setView`):

```ts
describe('typeIntoPrompt', () => {
  it('types once the prompt is empty, without switching the view, and notes nothing', async () => {
    const { deps, calls, notes, views } = fakeDeps(['draft', 'empty'])
    const waits: boolean[] = []
    expect(await typeIntoPrompt(TAB, '/remote-control work', '/remote-control', deps, (w) => waits.push(w))).toBe(true)
    expect(views).toEqual([])
    expect(writes(calls)).toEqual(['write:/remote-control work', 'write:\r'])
    expect(notes).toEqual([])
    expect(waits).toEqual([true, false])
  })
  it('a prompt that never comes up: false after 30 s, with the handoff’s note and toast', async () => {
    const { deps, notes, toasts } = fakeDeps(['none'])
    expect(await typeIntoPrompt(TAB, '/remote-control', '/remote-control', deps)).toBe(false)
    expect(notes).toEqual(["Could not run /remote-control: Claude Code's prompt did not come up"])
    expect(toasts).toEqual(["Could not run /remote-control: Claude Code's prompt did not come up"])
  })
  it('one line at a time per tab, whichever function types it', async () => {
    const slow = fakeDeps(['draft', 'draft', 'empty'])
    const first = openInTerminal(TAB, '/config', '/config', slow.deps)
    expect(await typeIntoPrompt(TAB, '/remote-control', '/remote-control', fakeDeps(['empty']).deps)).toBe(false)
    await first
  })
})
```

- [ ] **Step 2: Write the failing hub tests**

Extend `world()` in `tests/unit/remote-control-hub.test.ts`:

```ts
  // added to w:
  typed: [] as string[], toasts: [] as string[],
  timers: [] as { ms: number; run: () => void; on: boolean }[],
  typing: null as null | { wait: (waiting: boolean) => void; done: (ok: boolean) => void },
  // added to deps:
  type: (_id, line, onWait) => new Promise<boolean>((done) => { w.typed.push(line); w.typing = { wait: onWait, done } }),
  name: () => 'work',
  title: () => 'work',
  toast: (text) => { w.toasts.push(text) },
  later: (ms, run) => { const t = { ms, run, on: true }; w.timers.push(t); return () => { t.on = false } },
  // returned with hub, w, report:
  typedOk: async (ok = true) => { w.typing!.done(ok); for (let i = 0; i < 5; i++) await Promise.resolve() },
  fire: () => { for (const t of w.timers.splice(0)) if (t.on) t.run() }
```

Tests (`describe('RemoteControlHub: the terminal switch')`):

```ts
  it('on types /remote-control with the name and connects until the id comes', async () => {
    const { hub, w, report, typedOk, fire } = world()
    hub.set(TAB, true)
    expect(w.typed).toEqual(['/remote-control work'])
    expect(w.choice).toBe(true)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    await typedOk()
    report(ID)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}` })
    fire()
    expect(w.toasts).toEqual([])
  })
  it('while the prompt holds a draft, the state says it waits for an empty prompt', () => {
    const { hub, w } = world()
    hub.set(TAB, true)
    w.typing!.wait(true)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting', waits: true })
    w.typing!.wait(false)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
  })
  it('30 s after the line is typed without an id: off, the toast, and the choice cleared', async () => {
    const { hub, w, typedOk, fire } = world()
    hub.set(TAB, true)
    await typedOk()
    expect(w.timers.map((t) => t.ms)).toEqual([30_000])
    fire()
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
    expect(w.toasts).toEqual(['Remote Control did not connect in work: see the terminal'])
  })
  it('an id that comes after the timeout turns the tab on and sets the choice again', async () => {
    const { hub, w, report, typedOk, fire } = world()
    hub.set(TAB, true)
    await typedOk()
    fire()
    report(ID)
    expect(hub.state(TAB)).toMatchObject({ kind: 'on' })
    expect(w.choice).toBe(true)
  })
  it('a prompt that never came up: off and the choice cleared, with no toast of the hub’s own', async () => {
    const { hub, w, typedOk } = world()
    hub.set(TAB, true)
    await typedOk(false)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
    expect(w.toasts).toEqual([])
  })
  it('a second on while one waits types nothing more', () => {
    const { hub, w } = world()
    hub.set(TAB, true)
    hub.set(TAB, true)
    expect(w.typed).toEqual(['/remote-control work'])
  })
  it('off on a connected tab types /remote-control and stays on, leaving, until the report without an id', async () => {
    const { hub, w, report, typedOk } = world()
    report(ID)
    hub.set(TAB, false)
    expect(w.typed).toEqual(['/remote-control'])
    expect(w.choice).toBe(false)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}`, leaving: true })
    await typedOk()
    report(null)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
  })
  it('30 s after the off line, an id still there means the person kept Remote Control: the choice is set again', async () => {
    const { hub, w, report, typedOk, fire } = world()
    report(ID)
    hub.set(TAB, false)
    await typedOk()
    fire()
    expect(w.choice).toBe(true)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}` })
  })
  it('off while connecting types nothing and stops connecting', () => {
    const { hub, w } = world()
    hub.set(TAB, true)
    hub.set(TAB, false)
    expect(w.typed).toEqual(['/remote-control work'])
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
  })
  it('a tab started with its choice on connects: a report without an id meanwhile keeps it connecting and keeps the choice', () => {
    const { hub, w, report } = world({ choice: true })
    w.reported = 'session_old' // what the old process reported
    hub.processStarted(TAB)
    expect(w.reported).toBeNull()
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    expect(w.timers.map((t) => t.ms)).toEqual([30_000])
    hub.reported(TAB, null, 'session_old') // a late report of the old id going away
    report(null)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    expect(w.choice).toBe(true)
    report(ID)
    expect(hub.state(TAB)).toMatchObject({ kind: 'on' })
  })
  it('a launch that does not connect in 30 s: off, the toast, the choice cleared', () => {
    const { hub, w, fire } = world({ choice: true })
    hub.processStarted(TAB)
    fire()
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
    expect(w.toasts).toEqual(['Remote Control did not connect in work: see the terminal'])
  })
  it('on in a chat-view tab, or in an unavailable one, types nothing', () => {
    const chat = world({ view: 'chat' })
    chat.hub.set(TAB, true)
    expect(chat.w.typed).toEqual([])
    expect(chat.w.choice).toBe(true)
    const token = world({ kind: 'token' })
    token.hub.set(TAB, true)
    expect([token.w.typed, token.w.choice]).toEqual([[], false])
  })
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run tests/unit/terminal-handoff.test.ts tests/unit/remote-control-hub.test.ts`
Expected: FAIL.

- [ ] **Step 4: Split the handoff**

In `terminal-handoff.ts`, move the polling loop of `hand()` (:43-61) into a private `typeLine(tabId, line, what, d, onWait): Promise<'typed' | 'gone' | 'gave-up'>` that does not note a success; the give-up path keeps its note and toast. `openInTerminal` keeps its contract: take the `waiting` slot, `setView`, `null` line → true, then `typeLine`; `'typed'` → the note `Opened ${what} in the terminal`, true; `'gave-up'` → true; `'gone'` → false. `typeIntoPrompt` checks `isHandoffLine`, takes the same `waiting` slot, runs `typeLine` and answers `=== 'typed'`. The existing `openInTerminal` tests pass unchanged.

- [ ] **Step 5: Implement the switch in the hub**

Keep one ask per tab: `{ dir: 'on' | 'off'; waits: boolean; cancel: (() => void) | null }`; every async callback first checks that the tab's ask is still the same object.
- `set(tabId, on)`: no tab, exited, or unavailable → nothing. Chat view → `setChoice(on)`, `onChange` (Task 12 attaches). Terminal:
  - on, an id is reported → `setChoice(true)` only; on, an `on` ask exists → nothing; else `setChoice(true)`, ask `on`, type `/remote-control ${name(tabId)}`; typed → `cancel = later(CONNECT_WAIT_MS, timeout)`; not typed → drop the ask, `setChoice(false)`.
  - off, no id reported → drop the ask (cancel its timer), `setChoice(false)`; off, an id → `setChoice(false)`, ask `off`, type `/remote-control`; typed → `later(CONNECT_WAIT_MS, kept)`; not typed → drop the ask, `setChoice(true)`.
  - `timeout`: no id reported → drop the ask, `setChoice(false)`, `toast(connectTimeoutToast(title(tabId)))`. `kept`: an id still reported → drop the ask, `setChoice(true)`.
  - `onWait(w)` sets `ask.waits`; every change ends with `onChange(tabId)`.
- `reported()` (terminal): an id → an `on` ask is done (cancel, drop), else `previous === null` → `setChoice(true)`. No id and `previous !== null` → an `on` ask: nothing (still connecting); an `off` ask: done; no ask: `setChoice(false)`.
- `processStarted()`: drop the ask, `forgetReported`; terminal view, choice on, available, not exited → an `on` ask with `cancel = later(CONNECT_WAIT_MS, timeout)`.
- `state()` (terminal): an id → `on` with `leaving: true` while an `off` ask is open and `waits: true` while it waits; no id and an `on` ask → `connecting` (with `waits: true` while it waits); else off.
- `removeTab()`: drop the ask.

- [ ] **Step 6: Wire the IPC and the deps**

- `IPC.remoteControlSet: 'remote-control:set'`, `CtApi.remoteControlSet(tabId: string, on: boolean): void`, preload `remoteControlSet: (tabId, on) => ipcRenderer.send(IPC.remoteControlSet, tabId, on)`.
- `index.ts` hub deps: `type: (id, line, onWait) => typeIntoPrompt(id, line, commandWord(line), handoffDeps, onWait)`, `name: (id) => remoteName(tabTitleOf(tabs.get(id)!))`, `title: (id) => tabTitleOf(tabs.get(id)!)`, `toast`, `later: (ms, run) => { const t = setTimeout(run, ms); return () => clearTimeout(t) }`.
- Handler: `ipcMain.on(IPC.remoteControlSet, (_e, tabId: unknown, on: unknown) => { if (isLocalClaudeTab(tabId) && isFlag(on)) remoteControl.set(tabId, on) })`.

- [ ] **Step 7: Run the unit tests and watch them pass**

Run: `npx vitest run tests/unit/terminal-handoff.test.ts tests/unit/remote-control-hub.test.ts`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 8: Write the e2e helpers and the failing e2e test**

`tests/e2e/remote-control-helpers.ts`:

```ts
import type { Page } from '@playwright/test'
import type { StatusMessage } from '../../src/shared/protocol'

/** the tabs' own title: a terminal tab's title otherwise follows the shell's, which differs between machines */
export const RC_TITLE = 'Fix the parser'
/** opens a Claude tab titled RC_TITLE in the folder, on the account (null: the main one), and waits until it is in front; its id */
export async function openRcTab(page: Page, cwd: string, account: string | null = null): Promise<string> {
  const tab = await page.evaluate(({ cwd, account, title }) => window.ct.openTab({ kind: 'claude', cwd, account, title }), { cwd, account, title: RC_TITLE })
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tab!.id)
  return tab!.id
}
export const RC_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
/** the sign-in variables a developer's or a runner's environment may hold, emptied: an empty one is no sign-in */
export const RC_CLEAN_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '', ANTHROPIC_BASE_URL: '', CLAUDE_TRUSTED_DEVICE_TOKEN: ''
}
/** a statusLine report of the tab, with the RC id Claude Code would send (null: not connected) */
export const rcStatus = (tabId: string, remote: string | null): StatusMessage => ({
  v: 1, type: 'status', tabId, sessionId: RC_SID, model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: null, context: null, fiveHour: null, sevenDay: null, remote
})
/** the lines the stand-in Claude Code read in its terminal, in order */
export const typedLines = (log: () => Record<string, unknown>[]): string[] => log().flatMap((e) => (typeof e.in === 'string' ? [e.in] : []))
```

`tests/e2e/remote-control.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { launchAccounts } from './account-helpers'
import { openRcTab, RC_CLEAN_ENV, rcStatus, typedLines } from './remote-control-helpers'

const LONG = { timeout: 20_000 }

test('the switch types /remote-control with the tab’s title into Claude Code’s prompt, and off types /remote-control', async () => {
  const t = await launchAccounts({ view: 'terminal', env: RC_CLEAN_ENV })
  try {
    const tabId = await openRcTab(t.page, t.work)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), tabId)
    await expect.poll(() => typedLines(t.log), LONG).toEqual(['/remote-control Fix the parser'])
    // Claude Code connects: its next statusLine carries the id
    expect(await sendPipeMessage(t.pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, false), tabId)
    await expect.poll(() => typedLines(t.log), LONG).toEqual(['/remote-control Fix the parser', '/remote-control'])
  } finally {
    await t.app.close()
  }
})
```

- [ ] **Step 9: Run the e2e test**

Run: `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run build && node scripts/e2e.mjs tests/e2e/remote-control.spec.ts --workers=1"`
Expected: PASS (before Steps 4-6 it fails: nothing is typed).

- [ ] **Step 10: Leave the work uncommitted**

Suggested message: `feat: the Remote Control switch types /remote-control in a terminal tab`.

---

### Task 6: The account's flag

**Files:**
- Modify: `src/shared/types.ts` (`Settings.claude` :168), `src/main/settings.ts` (:12, :130-141), `src/shared/settings-keys.ts` (:20-38)
- Modify: `src/main/accounts.ts` (`StoredAccount` :33, `AccountEntry` :40, `parseAccounts` :81, `list` :155, new `setRemoteControl`, `remoteControlOf`), `src/shared/accounts.ts` (`AccountView` :25)
- Modify: `src/main/tab-manager.ts` (`TabManagerDeps.remoteDefault`, `open`)
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts` (`accountsView` :416, the `settingsSet` handler :3641, the new handler, TabManager deps)
- Test: `tests/unit/settings.test.ts`, `tests/unit/settings-keys.test.ts`, `tests/unit/accounts.test.ts`, `tests/unit/tab-manager.test.ts`, `tests/e2e/remote-control.spec.ts`

**Interfaces:**
- Consumes: Task 3's `remoteControl` on the tab; Task 5's helpers.
- Produces:
  - `Settings.claude.remoteControl: boolean` (default `false`), setting key `'claude.remoteControl'` (no row in the Settings window).
  - Login `StoredAccount` and `AccountEntry` gain `remoteControl?: true`; `AccountView.remoteControl?: boolean`.
  - `AccountStore.setRemoteControl(id: unknown, on: boolean): AccountResult` (a sign-in account only; else `No such account`) and `AccountStore.remoteControlOf(id: string): boolean`.
  - `TabManagerDeps.remoteDefault?(account: string | null): boolean` — the account's flag; a new Claude tab's choice is `req.remoteControl === true || remoteDefault(account) === true`.
  - `IPC.remoteControlAccount = 'remote-control:account'`; `CtApi.remoteControlAccount(tabId: string, on: boolean): void`.
  - `index.ts`: `editSetting(key: SettingKey, value: SettingValue): SetSettingResult` (the body of the `settingsSet` handler).

- [ ] **Step 1: Write the failing unit tests**

- `tests/unit/settings.test.ts`: `it('claude.remoteControl is off by default, read as a boolean, and a bad value is an error', …)` — `parseSettings('{}').settings.claude.remoteControl === false`; `{"claude":{"remoteControl":true}}` → `true`; `{"claude":{"remoteControl":"yes"}}` → `false` and an error naming `"claude.remoteControl"`. Update any test that writes out the whole `claude` object.
- `tests/unit/settings-keys.test.ts`: length 64, `toContain('claude.remoteControl')`.
- `tests/unit/accounts.test.ts`:

```ts
  it('a sign-in account keeps its Remote Control flag in accounts.json; a token account has none', () => {
    // a store over a fake file with one login account `work` and one token account `ci`, as the file's other tests build it
    expect(store.setRemoteControl('work', true)).toEqual({ ok: true })
    expect(store.remoteControlOf('work')).toBe(true)
    expect(JSON.parse(file.text!).accounts.find((a: { id: string }) => a.id === 'work').remoteControl).toBe(true)
    expect(store.setRemoteControl('ci', true)).toEqual({ ok: false, error: 'No such account' })
    expect(store.remoteControlOf('ci')).toBe(false)
    expect(store.rename('work', 'Office')).toEqual({ ok: true })
    expect(store.remoteControlOf('work')).toBe(true)
    expect(store.setRemoteControl('work', false)).toEqual({ ok: true })
    expect(JSON.parse(file.text!).accounts.find((a: { id: string }) => a.id === 'work')).not.toHaveProperty('remoteControl')
  })
  it('parseAccounts keeps remoteControl only when it is true, on a sign-in account', () => {
    // version 2 text with three login entries (remoteControl: true, remoteControl: 'yes', none) and a token entry with remoteControl: true
    // → list() gives remoteControl true for the first only; the token entry has no such field
  })
```

- `tests/unit/tab-manager.test.ts`:

```ts
  it('a new Claude tab takes its account’s flag; a restored tab is on when it was saved on or its account’s flag is on', () => {
    const { tm } = setup({ remoteDefault: (account) => account === 'acc-1', resolveLaunch: accountLaunch })
    expect(tm.remoteControl(tm.open({ kind: 'claude', cwd: 'C:\\w', account: 'acc-1' }).id)).toBe(true)
    expect(tm.remoteControl(tm.open({ kind: 'claude', cwd: 'C:\\w', account: null }).id)).toBe(false)
    expect(tm.remoteControl(tm.open({ kind: 'claude', cwd: 'C:\\w', account: null, remoteControl: true }).id)).toBe(true)
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/settings.test.ts tests/unit/settings-keys.test.ts tests/unit/accounts.test.ts tests/unit/tab-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. Settings: the field with doc `remoteControl: new Claude tabs of the main account start with Remote Control on (the popover's checkbox)`; default `false`; `take('claude.remoteControl', claude.remoteControl, isBool, d.claude.remoteControl)`; the key in `SettingKey` and `SETTING_KEYS`.
2. Accounts: `parseAccounts` adds `...(x.remoteControl === true ? { remoteControl: true as const } : {})` to a login entry; `list()` passes it on; `setRemoteControl` saves the login record with the field set or removed; `remoteControlOf`. `accountsView()` in `index.ts` adds `...(a.remoteControl ? { remoteControl: true } : {})` to a login view.
3. `TabManager.open`: the choice rule above, with the account from `accountFor(req)`.
4. `index.ts`: extract `editSetting` from the `settingsSet` handler (the handler then checks its arguments and calls it). Add `const setRemoteAccountFlag = (account: string | null, on: boolean): void` — `null` → `editSetting('claude.remoteControl', on)` (an error is toasted); otherwise `accounts.setRemoteControl(account, on)` and, when ok, `broadcast(IPC.evAccounts, accountsView())`. TabManager deps: `remoteDefault: (account) => (account === null ? settings.claude.remoteControl : accounts.remoteControlOf(account))`.
5. IPC: `remoteControlAccount: 'remote-control:account'`, the `CtApi` method, the preload line, and `ipcMain.on(IPC.remoteControlAccount, (_e, tabId: unknown, on: unknown) => { if (isLocalClaudeTab(tabId) && isFlag(on)) setRemoteAccountFlag(tabs.get(tabId)!.account, on) })` after `editSetting`.

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Write the failing e2e test**

In `tests/e2e/remote-control.spec.ts` (import `runs` from `./account-helpers`, `readFileSync` and `join`):

```ts
/** the stand-in's Claude runs, not its auth checks */
const claudeRuns = (log: () => Record<string, unknown>[]) => runs(log).filter((r) => r.argv[0] !== 'auth' && r.argv[0] !== '--version')
const rcArg = (argv: string[]): string | null => (argv.includes('--rc') ? argv[argv.indexOf('--rc') + 1] ?? null : null)

test('the account flag starts the next Claude tab of the account with --rc and its title, through the real shell; the tabs already open keep theirs', async () => {
  const t = await launchAccounts({ view: 'terminal', env: RC_CLEAN_ENV })
  try {
    const first = await openRcTab(t.page, t.work)
    await t.page.evaluate((id) => window.ct.remoteControlAccount(id, true), first)
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).toBe(true)
    await openRcTab(t.page, t.work)
    await expect.poll(() => claudeRuns(t.log).length, LONG).toBe(2)
    // the shell took the quoted name as one argument
    expect(claudeRuns(t.log).map((r) => rcArg(r.argv))).toEqual([null, 'Fix the parser'])
    await t.page.evaluate((id) => window.ct.remoteControlAccount(id, false), first)
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).toBe(false)
    await openRcTab(t.page, t.work)
    await expect.poll(() => claudeRuns(t.log).length, LONG).toBe(3)
    expect(rcArg(claudeRuns(t.log)[2].argv)).toBeNull()
  } finally {
    await t.app.close()
  }
})
```

- [ ] **Step 6: Run the e2e spec**

Run: `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run build && node scripts/e2e.mjs tests/e2e/remote-control.spec.ts --workers=1"`
Expected: PASS.

- [ ] **Step 7: Leave the work uncommitted**

Suggested message: `feat: an account's Remote Control flag starts its new Claude tabs with --rc`.

---

### Task 7: The segment, the popover and the tab glyph

**Files:**
- Modify: `src/renderer/icons.ts` (`radio`)
- Modify: `src/renderer/status-bar.ts` (`Segment` :11, `zoneOf` :195, the constructor :223, `render` :252, `PARTS` :484, `fill` :517)
- Create: `src/renderer/remote-popover.ts`
- Modify: `src/renderer/tabbar.ts` (`TabBarItem` :11), `src/renderer/tab-row.ts` (after the images mark :140)
- Modify: `src/renderer/main.ts` (`tabBarItem` :235, `renderStatus` :476, `activate` :1105, the `StatusBar` :1703, `ct.onStatus` :1740, `ct.onAccounts` :1726, `applySettings` :1452)
- Modify: `src/renderer/styles.css` (next to `.status-tasks` :630 and `.tab-mail` :117)
- Modify: `tests/e2e/status.spec.ts:59`
- Test: `tests/unit/icons.test.ts`, `tests/unit/status-bar.test.ts`, `tests/unit/remote-popover.test.ts`, `tests/e2e/remote-control.spec.ts`

**Interfaces:**
- Consumes: `StatusUpdate.remote` (Task 4); `ct.remoteControlSet` (Task 5); `ct.remoteControlAccount`, `settings.claude.remoteControl`, `AccountView.remoteControl` (Task 6); the existing `ct.openExternal`, `ct.writeClipboardText`.
- Produces:
  - `ICON_NAMES` gains `'radio'`: `'<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>'` (Lucide `radio`, ISC, as the file's header says).
  - `Segment.key` gains `'remote'`; `Segment.dot?: RemoteState['kind']`; `export function remoteSegment(s: RemoteState): Segment` = `{ key: 'remote', text: 'Remote', title: remoteTitle(s), level: 'normal', icon: 'radio', dot: s.kind }`; `zoneOf('remote') === 'start'`; `StatusBar` takes a sixth constructor argument `onRemoteClick: (anchor: HTMLElement) => void = () => {}`.
  - `remote-popover.ts`:
    ```ts
    export function remoteTitle(s: RemoteState): string
    export function remoteLine(s: RemoteState): string
    export function remoteSwitch(s: RemoteState): { checked: boolean; disabled: boolean }
    export function accountNote(name: string): string
    export interface RemotePopoverView { tabId: string; state: RemoteState; chat: boolean; accountName: string; accountFlag: boolean }
    export interface RemotePopoverActions { set(tabId: string, on: boolean): void; setAccount(tabId: string, on: boolean): void; open(url: string): void; copy(url: string): void }
    export class RemotePopover {
      constructor(actions: RemotePopoverActions, onClosed: () => void)
      get isOpen(): boolean
      toggle(anchor: HTMLElement, v: RemotePopoverView): void
      /** redraws an open popover; null, or a view of another tab, closes it */
      update(v: RemotePopoverView | null): void
      close(): void
    }
    ```
  - `TabBarItem.rc?: boolean` (connected).
  - DOM the e2e tests use: segment `#statusbar .status-remote` with `data-dot="<kind>"`; `.remote-popover[role=dialog]` holding `.remote-heading`, `input.switch`, `.remote-line`, `.remote-open`, `.remote-copy`, `.remote-chat-note`, `.remote-account` (a `label` with its `input[type=checkbox]`) and `.remote-account-note`; tab glyph `.tab-rc`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/remote-popover.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { accountNote, remoteLine, remoteSwitch, remoteTitle } from '../../src/renderer/remote-popover'

const URL = 'https://claude.ai/code/session_01abc'

describe('the segment’s and the popover’s words', () => {
  it('titles', () => {
    expect(remoteTitle({ kind: 'off' })).toBe('Remote Control is off: click to turn it on')
    expect(remoteTitle({ kind: 'connecting' })).toBe('Remote Control is connecting…')
    expect(remoteTitle({ kind: 'connecting', note: "Waiting for Claude Code to renew this account's sign-in" })).toBe("Waiting for Claude Code to renew this account's sign-in")
    expect(remoteTitle({ kind: 'on', url: URL })).toBe('Remote Control is on: this session is on claude.ai and in the Claude app')
    expect(remoteTitle({ kind: 'unavailable', reason: 'R1' })).toBe('R1')
    expect(remoteTitle({ kind: 'failed', reason: 'R2' })).toBe('R2')
  })
  it('status lines, with the wait for an empty prompt after any of them', () => {
    expect(remoteLine({ kind: 'off' })).toBe('Off · turn it on to reach this session from your phone')
    expect(remoteLine({ kind: 'connecting' })).toBe('Connecting…')
    expect(remoteLine({ kind: 'connecting', waits: true })).toBe('Connecting… · waits for an empty prompt')
    expect(remoteLine({ kind: 'connecting', note: 'N' })).toBe('N')
    expect(remoteLine({ kind: 'on', url: URL })).toBe('Connected · continue this session in the Claude app or on claude.ai')
    expect(remoteLine({ kind: 'on', url: URL, leaving: true, waits: true })).toBe('Choose Disconnect this session in the terminal · waits for an empty prompt')
    expect(remoteLine({ kind: 'failed', reason: 'R2' })).toBe('R2')
  })
  it('the switch: on while connecting or connected, off once the person asked off, disabled only when unavailable', () => {
    expect(remoteSwitch({ kind: 'off' })).toEqual({ checked: false, disabled: false })
    expect(remoteSwitch({ kind: 'connecting' })).toEqual({ checked: true, disabled: false })
    expect(remoteSwitch({ kind: 'on', url: URL })).toEqual({ checked: true, disabled: false })
    expect(remoteSwitch({ kind: 'on', url: URL, leaving: true })).toEqual({ checked: false, disabled: false })
    expect(remoteSwitch({ kind: 'unavailable', reason: 'R1' })).toEqual({ checked: false, disabled: true })
    expect(remoteSwitch({ kind: 'failed', reason: 'R2' })).toEqual({ checked: false, disabled: false })
  })
  it('the account note names the account', () => {
    expect(accountNote('Work')).toBe('New Claude tabs of Work start with Remote Control on')
  })
})
```

`tests/unit/status-bar.test.ts`: `it('remoteSegment: Remote with the radio icon, its state as the dot, and its title', …)` — `remoteSegment({ kind: 'on', url: URL })` equals `{ key: 'remote', text: 'Remote', title: 'Remote Control is on: this session is on claude.ai and in the Claude app', level: 'normal', icon: 'radio', dot: 'on' }`. `tests/unit/icons.test.ts`: `expect(ICON_NAMES).toContain('radio')`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/remote-popover.test.ts tests/unit/status-bar.test.ts tests/unit/icons.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the segment, the popover and the glyph**

1. `icons.ts`: the `radio` shape. `status-bar.ts`: `PARTS` becomes `['status-icon', 'status-dot', 'status-text', 'status-pill', 'status-bar']`; `fill()` sets `span.dataset.dot` and an empty `status-dot` part when `s.dot` is set (removes both otherwise); `render()` puts `remoteSegment(u.remote)` right after the account segment when `u?.remote` is set; the click handler calls `onRemoteClick(seg)` for `.status-remote`.
2. `remote-popover.ts`: the pure functions as tested. The class copies `PlanList`'s shape (`src/renderer/plan-list.ts`): it makes its own `div.remote-popover` (`role="dialog"`, `aria-label="Remote Control"`) appended to `document.body`; `toggle` opens or closes; Esc in the capture phase and a mousedown outside it (not on `.status-remote`) close it; placed with `position: fixed`, its bottom 4 px above `#statusbar`, its left at the segment's left, kept inside the window (as `StatusBar.place`, `status-bar.ts:474`). Rows: the head (`.remote-heading` `Remote Control` and `input.switch` `type=checkbox`, `aria-label="Remote Control"`, checked and disabled from `remoteSwitch`); `.remote-line` from `remoteLine`; while `kind === 'on'`, `.remote-actions` with `button.remote-open` `Open on claude.ai` → `actions.open(url)` and `button.remote-copy` `Copy link` → `actions.copy(url)`; in a chat, `.remote-chat-note` with the chat note; a separator; `label.remote-account` (`dim` class when unavailable) with a checkbox (checked from `accountFlag`, disabled when unavailable) and the text `Connect every new session of this account`; `.remote-account-note` from `accountNote`. A change of the switch calls `actions.set(tabId, switch.checked)`; of the checkbox, `actions.setAccount(tabId, box.checked)`. The switch takes the focus on open.
3. `tab-row.ts`: after the images mark, when `item.rc`, a `span.tab-rc` with `title="Remote Control is on"` and `icon('radio', 12)`.
4. `renderer/main.ts`:
   - `const remotePopover = new RemotePopover({ set: (id, on) => ct.remoteControlSet(id, on), setAccount: (id, on) => ct.remoteControlAccount(id, on), open: (url) => ct.openExternal(url), copy: (url) => ct.writeClipboardText(url) }, () => { if (activeId) focusTab(activeId) })`.
   - `remoteViewOf(tabId): RemotePopoverView | null` — `null` for a remote tab or no `remote` in its status; `chat: isChatView(t)`, `accountName: accountLabel(t.info.account, accounts)`, `accountFlag`: main → `settings.claude.remoteControl`, else `accounts.find((a) => a.id === t.info.account)?.remoteControl === true`.
   - The `StatusBar`'s sixth argument: `(anchor) => { const v = activeId ? remoteViewOf(activeId) : null; if (v) remotePopover.toggle(anchor, v) }`.
   - `renderStatus`, `applySettings` and `ct.onAccounts` end with `remotePopover.update(activeId ? remoteViewOf(activeId) : null)`; `activate` closes it beside `planList.close()`.
   - `tabBarItem`: `rc: statusUpdates.get(id)?.remote?.kind === 'on'`. `ct.onStatus`: read whether the tab was on before storing the update; when that changes, `renderTabs()`.
5. `styles.css`:
   ```css
   #statusbar .status-remote { cursor: pointer; }
   #statusbar .status-remote:hover { color: var(--fg); }
   #statusbar .status-remote .status-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; box-sizing: border-box; }
   #statusbar .status-remote[data-dot="off"] .status-dot { border: 1.5px solid var(--text-3); }
   #statusbar .status-remote[data-dot="off"] .status-text { opacity: 0.7; }
   #statusbar .status-remote[data-dot="connecting"] .status-dot { background: var(--amber); }
   #statusbar .status-remote[data-dot="on"] .status-dot { background: var(--green); }
   #statusbar .status-remote[data-dot="unavailable"] { color: var(--text-4); }
   #statusbar .status-remote[data-dot="unavailable"] .status-dot { border: 1.5px solid var(--text-4); background: linear-gradient(135deg, transparent 42%, var(--text-4) 42% 58%, transparent 58%); }
   #statusbar .status-remote[data-dot="failed"] .status-dot { background: var(--red); }
   .tab-rc { display: flex; color: var(--green); }
   ```
   `.remote-popover` takes the box of `.status-tasks` (:630: raised background, 1 px `--line-2` border, 12 px radius, the shadow, `width: 340px`, `z-index: 50`, no drag) with `padding: 12px`; `.remote-popover input.switch` copies the `input.switch` rules of `settings.css:86-92`; `.remote-account.dim { opacity: 0.5; }`.

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Write the failing e2e tests**

Add to `tests/e2e/remote-control-helpers.ts`:

```ts
import { type ElectronApplication } from '@playwright/test'   // merge with the file's Page import
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_CLAUDE_SETTINGS, launchApp, type Launched } from './helpers'

/** the app with one Claude tab of the echo stand-in in a temp folder, with no sign-in in its environment */
export async function launchRcTerminal(): Promise<Launched & { tabId: string; work: string }> {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: RC_CLEAN_ENV })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  return { ...launched, work, tabId: (await launched.page.evaluate(() => window.__ct!.activeTabId()))! }
}
/** records the URLs main hands to shell.openExternal, instead of opening a browser (as chat-cards.spec.ts:29 does) */
export async function stubExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__externalCalls = calls
    shell.openExternal = (u: string) => { calls.push(u); return Promise.resolve() }
  })
}
export const externalCalls = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as Record<string, unknown>).__externalCalls as string[])
```

Tests in `tests/e2e/remote-control.spec.ts`:

```ts
test('the Remote segment is off on a new Claude tab; an id in the status makes it green and marks the tab, and none turns both off', async () => {
  const { app, page, pipeName, tabId } = await launchRcTerminal()
  try {
    const seg = page.locator('#statusbar .status-remote')
    await expect(seg).toHaveAttribute('data-dot', 'off')
    await expect(seg.locator('.status-text')).toHaveText('Remote')
    await expect(seg).toHaveAttribute('title', 'Remote Control is off: click to turn it on')
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await expect(seg).toHaveAttribute('data-dot', 'on')
    await expect(seg).toHaveAttribute('title', 'Remote Control is on: this session is on claude.ai and in the Claude app')
    // the tab bar and the side tab panel each draw the tab's row
    const mark = page.locator('.tab-rc')
    await expect(mark.first()).toBeVisible()
    await expect(mark.first()).toHaveAttribute('title', 'Remote Control is on')
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, null))).toEqual({ ok: true })
    await expect(seg).toHaveAttribute('data-dot', 'off')
    await expect(mark).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a click on the segment opens the popover 4 px above the bar; Esc closes it, and so does a click outside', async () => {
  const { app, page, pipeName, tabId } = await launchRcTerminal()
  try {
    const seg = page.locator('#statusbar .status-remote')
    const pop = page.locator('.remote-popover')
    await seg.click()
    await expect(pop).toBeVisible()
    await expect(pop.locator('.remote-heading')).toHaveText('Remote Control')
    await expect(pop.locator('.remote-line')).toHaveText('Off · turn it on to reach this session from your phone')
    await expect(pop.locator('input.switch')).not.toBeChecked()
    await expect(pop.locator('.remote-account')).toContainText('Connect every new session of this account')
    await expect(pop.locator('.remote-account-note')).toHaveText('New Claude tabs of Main account start with Remote Control on')
    await expect(pop.locator('.remote-chat-note')).toHaveCount(0)
    const [box, bar] = [await pop.boundingBox(), await page.locator('#statusbar').boundingBox()]
    expect(Math.round(bar!.y - (box!.y + box!.height))).toBe(4)
    expect(Math.round(box!.width)).toBe(340)
    await page.keyboard.press('Escape')
    await expect(pop).toBeHidden()
    await seg.click()
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await expect(pop.locator('.remote-line')).toHaveText('Connected · continue this session in the Claude app or on claude.ai')
    await expect(pop.locator('.remote-open')).toHaveText('Open on claude.ai')
    await page.locator('.terminal-host:visible').click()
    await expect(pop).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a click on the switch types /remote-control with the title; the checkbox sets the account’s flag', async () => {
  const t = await launchAccounts({ view: 'terminal', env: RC_CLEAN_ENV })
  try {
    await openRcTab(t.page, t.work)
    await t.page.locator('#statusbar .status-remote').click()
    await t.page.locator('.remote-popover input.switch').click()
    await expect.poll(() => typedLines(t.log), LONG).toEqual(['/remote-control Fix the parser'])
    await t.page.locator('.remote-popover .remote-account input').click()
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).toBe(true)
    await expect(t.page.locator('.remote-popover .remote-account input')).toBeChecked()
  } finally {
    await t.app.close()
  }
})

test('Open on claude.ai opens the session’s link', async () => {
  const { app, page, pipeName, tabId } = await launchRcTerminal()
  try {
    await stubExternal(app)
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await page.locator('#statusbar .status-remote').click()
    await page.locator('.remote-popover .remote-open').click()
    await expect.poll(() => externalCalls(app)).toEqual(['https://claude.ai/code/session_01E2eTest'])
  } finally {
    await app.close()
  }
})

test('Copy link copies the session’s link @alone', async () => {
  const { app, page, pipeName, tabId } = await launchRcTerminal()
  try {
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await page.locator('#statusbar .status-remote').click()
    await page.locator('.remote-popover .remote-copy').click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('https://claude.ai/code/session_01E2eTest')
  } finally {
    await app.close()
  }
})

test('a shell tab has no Remote segment', async () => {
  const { app, page } = await launchApp({ env: RC_CLEAN_ENV })
  try {
    await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
    await expect(page.locator('#statusbar .status-remote')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
```

`tests/e2e/status.spec.ts:59`: the bar now keeps the Remote segment after the session ends. Replace `await expect(bar).toBeHidden()` with `await expect(bar.locator('.status-seg')).toHaveCount(1)` and `await expect(bar.locator('.status-remote')).toBeVisible()`.

- [ ] **Step 6: Run the e2e specs the segment touches**

Run: `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run build && node scripts/e2e.mjs tests/e2e/remote-control.spec.ts tests/e2e/status.spec.ts tests/e2e/layout.spec.ts tests/e2e/chat-status.spec.ts tests/e2e/chat-activity.spec.ts tests/e2e/mcp-panel.spec.ts tests/e2e/accounts.spec.ts tests/e2e/accounts-launch.spec.ts tests/e2e/plan.spec.ts --workers=1"`
Expected: PASS. Every Claude tab now shows the status bar from its start; a test that assumed a hidden bar for a Claude tab is updated the way `status.spec.ts:59` is, and the change is reported.

- [ ] **Step 7: Leave the work uncommitted**

Suggested message: `feat: the Remote segment, its popover and the tab's Remote Control glyph`.

---

### Task 8: Reading Claude Code's credentials

**Files:**
- Create: `src/main/remote-control/claude-credentials.ts`
- Test: `tests/integration/claude-credentials.int.test.ts`

**Interfaces:**
- Consumes: `pathKey` (`src/main/path-key.ts`).
- Produces:
  ```ts
  export interface ClaudeCredentials {
    /** the stored claude.ai access token while it is fresh */
    accessToken: string | null
    deviceToken: string | null
    /** fresh: accessToken is set; expired: a claude.ai sign-in whose token has expired; none: no claude.ai sign-in stored; unusable: a stored record with no usable token */
    state: 'fresh' | 'expired' | 'none' | 'unusable'
  }
  export interface CredentialSources {
    platform: NodeJS.Platform
    home: string
    username: string
    now(): number
    /** runs `security` with these arguments (no shell, 5 s limit): its stdout, or null when it failed; null on a test run, where the Keychain is never read */
    security: ((args: string[]) => Promise<string | null>) | null
  }
  export function keychainService(folder: string, home: string): string
  export function readClaudeCredentials(folder: string, env: Readonly<Record<string, string | undefined>>, s: CredentialSources): Promise<ClaudeCredentials>
  export function securityRunner(file?: string): (args: string[]) => Promise<string | null>   // file defaults to 'security'
  ```

- [ ] **Step 1: Write the failing tests**

`tests/integration/claude-credentials.int.test.ts`, each test with its own temp home (`mkdtempSync(join(tmpdir(), 'ct-creds-'))`), its default folder `<home>/.claude` and another folder `<home>/accounts/work`:

```ts
const NOW = 1_763_300_000_000
const TOKEN = 'fake-access-token-0001'
const sources = (home: string, over: Partial<CredentialSources> = {}): CredentialSources => ({ platform: 'linux', home, username: 'tester', now: () => NOW, security: null, ...over })
const store = (folder: string, record: object): void => { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, '.credentials.json'), JSON.stringify(record)) }

it('a fresh token in .credentials.json, with no device token anywhere', async () => {
  store(work, { claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 60_000 } })
  expect(await readClaudeCredentials(work, {}, sources(home))).toEqual({ accessToken: TOKEN, deviceToken: null, state: 'fresh' })
})
it('an expiresAt in the past is expired: no token, and the state says so', async () => {
  store(work, { claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW - 1 } })
  expect(await readClaudeCredentials(work, {}, sources(home))).toEqual({ accessToken: null, deviceToken: null, state: 'expired' })
})
it('no file, or a file without claudeAiOauth, is no sign-in', async () => {
  expect((await readClaudeCredentials(work, {}, sources(home))).state).toBe('none')
  store(work, { mcpOAuth: {} })
  expect((await readClaudeCredentials(work, {}, sources(home))).state).toBe('none')
})
it('an accessToken that is no token, or a file that is not JSON, is unusable', async () => {
  store(work, { claudeAiOauth: { accessToken: 'has space' } })
  expect((await readClaudeCredentials(work, {}, sources(home))).state).toBe('unusable')
  writeFileSync(join(work, '.credentials.json'), '{not json')
  expect((await readClaudeCredentials(work, {}, sources(home))).state).toBe('unusable')
})
it('the device token comes from the environment first, then the record, then the account’s .claude.json', async () => {
  store(work, { claudeAiOauth: { accessToken: TOKEN }, trustedDeviceToken: 'dev-record' })
  writeFileSync(join(work, '.claude.json'), JSON.stringify({ trustedDeviceToken: 'dev-json' }))
  expect((await readClaudeCredentials(work, { CLAUDE_TRUSTED_DEVICE_TOKEN: 'dev-env' }, sources(home))).deviceToken).toBe('dev-env')
  expect((await readClaudeCredentials(work, {}, sources(home))).deviceToken).toBe('dev-record')
  store(work, { claudeAiOauth: { accessToken: TOKEN } })
  expect((await readClaudeCredentials(work, {}, sources(home))).deviceToken).toBe('dev-json')
})
it('the default folder’s .claude.json is beside it, in the home folder', async () => {
  store(defaultFolder, { claudeAiOauth: { accessToken: TOKEN } })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ trustedDeviceToken: 'dev-home' }))
  expect((await readClaudeCredentials(defaultFolder, {}, sources(home))).deviceToken).toBe('dev-home')
})
it('macOS reads the Keychain with the folder’s service and the user, and falls back to the file when that fails', async () => {
  const asked: string[][] = []
  const keychain = async (args: string[]) => { asked.push(args); return JSON.stringify({ claudeAiOauth: { accessToken: 'from-keychain-0001' } }) }
  expect((await readClaudeCredentials(defaultFolder, {}, sources(home, { platform: 'darwin', security: keychain }))).accessToken).toBe('from-keychain-0001')
  expect(asked).toEqual([['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'tester', '-w']])
  store(work, { claudeAiOauth: { accessToken: TOKEN } })
  expect((await readClaudeCredentials(work, {}, sources(home, { platform: 'darwin', security: async () => null }))).accessToken).toBe(TOKEN)
})
it('another folder’s Keychain service ends with the first 8 hex of the sha256 of its NFC path', () => {
  const hex = createHash('sha256').update(work.normalize('NFC')).digest('hex').slice(0, 8)
  expect(keychainService(work, home)).toBe(`Claude Code-credentials-${hex}`)
  expect(keychainService(join(home, '.claude'), home)).toBe('Claude Code-credentials')
})
it('no runner (a test run): macOS reads the file', async () => {
  store(work, { claudeAiOauth: { accessToken: TOKEN } })
  expect((await readClaudeCredentials(work, {}, sources(home, { platform: 'darwin' }))).accessToken).toBe(TOKEN)
})
it('the security runner answers a program’s output, and null for one that fails', async () => {
  expect(await securityRunner(process.execPath)(['-e', 'process.stdout.write("out")'])).toBe('out')
  expect(await securityRunner(process.execPath)(['-e', 'process.exit(3)'])).toBeNull()
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/integration/claude-credentials.int.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- A token text: a string of 1 to 8192 characters `\x21`-`\x7e` (anything else is no token). Every read uses `fs/promises`; a missing file is "none", never an exception.
- The default folder is `pathKey(folder) === pathKey(join(home, '.claude'))`.
- The record: on `darwin` with a runner, `security(['find-generic-password', '-s', keychainService(folder, home), '-a', username, '-w'])` trimmed and parsed; a null answer or one that is not a JSON object → the file `<folder>/.credentials.json`. `claudeAiOauth` missing → none; its `accessToken` no token → unusable; a numeric `expiresAt <= now()` → expired; else fresh.
- The device token, the first token text of: `env.CLAUDE_TRUSTED_DEVICE_TOKEN`; the record's top-level `trustedDeviceToken`; `trustedDeviceToken` of `.claude.json` (`<home>/.claude.json` for the default folder, else `<folder>/.claude.json`).
- `securityRunner`: `execFile(file, args, { timeout: 5000, windowsHide: true, encoding: 'utf8' })`; stdout on success, null on any error.
- Never write, never log a value read.

- [ ] **Step 4: Run them and watch them pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Leave the work uncommitted**

Suggested message: `feat: read Claude Code's claude.ai sign-in of an account, read-only`.

---

### Task 9: The bridge loader, the remote-session store and the git context

**Files:**
- Create: `src/main/remote-control/bridge-loader.ts`, `src/main/remote-control/remote-sessions.ts`, `src/main/remote-control/git-context.ts`
- Test: `tests/unit/bridge-loader.test.ts`, `tests/integration/remote-sessions.int.test.ts`, `tests/integration/git-context.int.test.ts`

**Interfaces:**
- Consumes: `execGit`'s type `GitRun` (`src/main/git-source.ts:14`); `isBridgeId` (Task 1).
- Produces:
  ```ts
  // bridge-loader.ts
  export const BRIDGE_EXPORTS = ['createCodeSession', 'fetchRemoteCredentials', 'attachBridgeSession', 'isCredentialsFailure', 'isCredentialsRejection', 'isCreateSessionFailure'] as const
  export type BridgeModule = Pick<typeof import('@anthropic-ai/claude-agent-sdk/bridge'), (typeof BRIDGE_EXPORTS)[number]>
  export type BridgeLoad = { ok: true; bridge: BridgeModule } | { ok: false }
  /** the bridge, imported once on first use; a failed import or a missing export answers { ok: false } every time, logged once */
  export function bridgeLoader(load: () => Promise<unknown>, log: { warn(m: string): void }): () => Promise<BridgeLoad>
  export const importBridge = (): Promise<unknown> => import('@anthropic-ai/claude-agent-sdk/bridge')
  // remote-sessions.ts
  export interface RemoteSessionEntry { remoteId: string; sequenceNum: number }
  export const REMOTE_SESSION_KEEP_MS = 30 * 24 * 3_600_000
  export class RemoteSessionStore {
    constructor(file: string, now: () => number, log: { warn(m: string): void })
    /** the conversation's claude.ai session, when it was made under this account (the pathKey of its config folder) */
    get(sessionId: string, account: string): Promise<RemoteSessionEntry | null>
    put(sessionId: string, account: string, entry: RemoteSessionEntry): Promise<void>
    forget(sessionId: string): Promise<void>
  }
  // git-context.ts
  export interface GitContext { gitRepoUrl: string; branch: string; defaultBranch?: string }
  export function gitContextOf(cwd: string, git: GitRun): Promise<GitContext | null>
  ```
  File `remote-sessions.json` (in the app's data folder): `{ "version": 1, "sessions": { "<Claude session id>": { "remoteId", "sequenceNum", "account", "usedAt" } } }`. No token.

- [ ] **Step 1: Write the failing tests**

`tests/unit/bridge-loader.test.ts`:

```ts
const fn = (): void => {}
const full = Object.fromEntries(BRIDGE_EXPORTS.map((n) => [n, fn]))
it('imports once, and hands the six functions on', async () => {
  let imports = 0
  const load = bridgeLoader(async () => { imports++; return full }, { warn: () => {} })
  const [a, b] = await Promise.all([load(), load()])
  expect(a).toEqual({ ok: true, bridge: expect.objectContaining({ createCodeSession: fn }) })
  expect(b.ok).toBe(true)
  expect(imports).toBe(1)
})
it('a missing export: not ok, and the log names every missing one, once', async () => {
  const warns: string[] = []
  const load = bridgeLoader(async () => ({ ...full, attachBridgeSession: undefined, isCreateSessionFailure: 1 }), { warn: (m) => warns.push(m) })
  expect(await load()).toEqual({ ok: false })
  expect(await load()).toEqual({ ok: false })
  expect(warns).toHaveLength(1)
  expect(warns[0]).toContain('attachBridgeSession')
  expect(warns[0]).toContain('isCreateSessionFailure')
})
it('an import that throws: not ok, logged once, never tried again', async () => {
  let imports = 0
  const warns: string[] = []
  const load = bridgeLoader(async () => { imports++; throw new Error('Cannot find module') }, { warn: (m) => warns.push(m) })
  expect(await load()).toEqual({ ok: false })
  expect(await load()).toEqual({ ok: false })
  expect(imports).toBe(1)
  expect(warns).toEqual(["the Agent SDK's bridge cannot be imported: Cannot find module"])
})
```

`tests/integration/remote-sessions.int.test.ts`:

```ts
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_2 = '6e3d2c8b-9f5a-4b4c-a2d3-e4f5a6b7c8d9'
const SID_3 = '7f4e3d9c-0a6b-4c5d-b3e4-f5a6b7c8d9e0'
const DAY = 24 * 3_600_000
const log = { warn: () => {} }
let t = 0
let file = ''
let store: RemoteSessionStore
beforeEach(() => {
  t = 1_763_300_000_000
  file = join(mkdtempSync(join(tmpdir(), 'ct-rs-')), 'remote-sessions.json')
  store = new RemoteSessionStore(file, () => t, log)
})

it('an entry put is got back for its session and account, also by a new store over the same file', async () => {
  await store.put(SID, 'c:\\cfg', { remoteId: 'cse_1', sequenceNum: 4 })
  expect(await store.get(SID, 'c:\\cfg')).toEqual({ remoteId: 'cse_1', sequenceNum: 4 })
  expect(await new RemoteSessionStore(file, () => t, log).get(SID, 'c:\\cfg')).toEqual({ remoteId: 'cse_1', sequenceNum: 4 })
})
it('an entry made under another account is none', async () => {
  await store.put(SID, 'c:\\cfg', { remoteId: 'cse_1', sequenceNum: 4 })
  expect(await store.get(SID, 'c:\\accounts\\work')).toBeNull()
})
it('an entry unused for 30 days is gone; a get keeps an entry in use', async () => {
  await store.put(SID, 'a', { remoteId: 'cse_1', sequenceNum: 1 })
  await store.put(SID_2, 'a', { remoteId: 'cse_2', sequenceNum: 1 })
  t += 20 * DAY
  await store.get(SID, 'a')
  t += 11 * DAY
  expect(await store.get(SID_2, 'a')).toBeNull()
  expect(await store.get(SID, 'a')).toEqual({ remoteId: 'cse_1', sequenceNum: 1 })
  await store.put(SID_3, 'a', { remoteId: 'cse_3', sequenceNum: 0 })
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sessions).sort()).toEqual([SID, SID_3].sort())
})
it('a file that is not JSON, and entries of the wrong shape, are left out; the store goes on', async () => {
  writeFileSync(file, '{oops')
  expect(await store.get(SID, 'a')).toBeNull()
  writeFileSync(file, JSON.stringify({ version: 1, sessions: { [SID]: { remoteId: 'bad id', sequenceNum: 1, account: 'a', usedAt: t }, [SID_2]: { remoteId: 'cse_2', sequenceNum: -1, account: 'a', usedAt: t } } }))
  const fresh = new RemoteSessionStore(file, () => t, log)
  expect([await fresh.get(SID, 'a'), await fresh.get(SID_2, 'a')]).toEqual([null, null])
})
it('puts made at once all land; forget removes one', async () => {
  await Promise.all([1, 2, 3].map((n) => store.put(`${SID.slice(0, -1)}${n}`, 'a', { remoteId: `cse_${n}`, sequenceNum: n })))
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sessions)).toHaveLength(3)
  await store.forget(`${SID.slice(0, -1)}1`)
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sessions)).toHaveLength(2)
})
```

`tests/integration/git-context.int.test.ts` (a temp repository with real `git`, as `tests/integration/git-source.int.test.ts` makes one, and `execGit`):

```ts
it('a repository: its origin, its branch and its default branch', async () => {
  // a bare origin with branch main pushed and origin/HEAD set (git remote set-head origin main); a checkout on branch fix
  expect(await gitContextOf(checkout, execGit)).toEqual({ gitRepoUrl: origin, branch: 'fix', defaultBranch: 'main' })
})
it('credentials in the remote URL never leave: user and password are dropped', async () => {
  // git remote set-url origin https://bot:fake-secret-0001@git.example.invalid/acme/app.git
  expect((await gitContextOf(checkout, execGit))!.gitRepoUrl).toBe('https://git.example.invalid/acme/app.git')
})
it('no default branch known: none is passed', async () => {
  // the same checkout after git remote set-head origin -d
  expect(await gitContextOf(checkout, execGit)).toEqual({ gitRepoUrl: origin, branch: 'fix' })
})
it('not a repository, or no origin: null', async () => {
  expect(await gitContextOf(mkdtempSync(join(tmpdir(), 'ct-norepo-')), execGit)).toBeNull()
  // a repository made with git init and one commit, without a remote
  expect(await gitContextOf(gitRepoWithoutRemote, execGit)).toBeNull()
})
```

(Build the repositories with `execFileSync('git', …)` in a temp folder, as the file `tests/integration/git-source.int.test.ts` does, with a local `user.name` and `user.email`.)

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/bridge-loader.test.ts tests/integration/remote-sessions.int.test.ts tests/integration/git-context.int.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. `bridgeLoader`: one shared promise; checks that each of `BRIDGE_EXPORTS` is a function; the warn line is `the Agent SDK's bridge cannot be used: missing <names joined by ", ">` or `the Agent SDK's bridge cannot be imported: <the error's message, at most 200 characters>`.
2. `RemoteSessionStore`: loads the file lazily once (async); keeps entries whose `remoteId` passes `isBridgeId`, `sequenceNum` is a non-negative safe integer, `account` a string and `usedAt` a finite number, and drops those older than `REMOTE_SESSION_KEEP_MS`. `get` of a matching entry refreshes its `usedAt` and saves. Saves run one after another (a promise chain): write `<file>.tmp`, then `rename`. A failed read or write is logged, never thrown.
3. `gitContextOf`: `git remote get-url origin`, `git rev-parse --abbrev-ref HEAD`, `git symbolic-ref --short refs/remotes/origin/HEAD` (strip the leading `origin/`); a failed first or second call → null; a failed third → no `defaultBranch`. A URL that parses with `new URL` loses `username` and `password`; an scp-like URL (`git@host:path`) is kept as it is. Outputs are trimmed.

- [ ] **Step 4: Run them and watch them pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Leave the work uncommitted**

Suggested message: `feat: load the SDK's bridge, keep each conversation's claude.ai session, read the git context`.

---

### Task 10: The bridge host: attach, outbound, inbound, permissions

**Files:**
- Create: `src/main/remote-control/bridge-host.ts`
- Modify: `src/main/chat/chat-cards.ts` (`PermissionAsk` :16: `toolUseId?: string`)
- Test: `tests/unit/bridge-host.test.ts`

**Interfaces:**
- Consumes: `ClaudeCredentials` (Task 8); `BridgeLoad`, `BridgeModule`, `RemoteSessionStore`, `GitContext` (Task 9); `RemoteState`, `remoteLink`, `REMOTE_REASONS` (Task 1); `ChatSendOrigin` (`src/shared/chat.ts:17`; Task 12 adds `'remote'`); `PermissionAsk`, `SdkPermissionResult` (`chat-cards.ts`); `pathKey`.
- Produces:
  ```ts
  export const API_BASE = 'https://api.anthropic.com'
  export const CALL_TIMEOUT_MS = 20_000
  export interface BridgeChat {
    /** a message typed on claude.ai, into the chat as the person's (ChatHub.send, from 'remote'); null: sent, else why not */
    send(tabId: string, text: string): Promise<string | null>
    /** settles an open card with claude.ai's answer (ChatHub.answerRemote); false: no such card, or the answer does not fit */
    answer(tabId: string, cardId: string, result: SdkPermissionResult): boolean
    interrupt(tabId: string): void
    /** the conversation so far, as the SDK's getSessionMessages gives it */
    history(tabId: string, sessionId: string): Promise<unknown[]>
    /** one call that makes the chat's Claude Code check its sign-in (accountInfo) */
    checkSignIn(tabId: string): Promise<void>
  }
  export interface BridgeTarget {
    tabId: string; sessionId: string
    /** the account's config folder; null: none known (the main account of a test run without CLAUDE_CONFIG_DIR) */
    folder: string | null
    env: Record<string, string>; title: string; cwd: string; model: string | null
  }
  export interface BridgeHostDeps {
    bridge(): Promise<BridgeLoad>
    credentials(folder: string, env: Record<string, string>): Promise<ClaudeCredentials>
    sessions: Pick<RemoteSessionStore, 'get' | 'put' | 'forget'>
    git(cwd: string): Promise<GitContext | null>
    chat: BridgeChat
    claudeVersion(): string | null
    later(ms: number, run: () => void): () => void
    onChange(tabId: string): void
    log: { info(m: string): void; warn(m: string): void }
  }
  export class BridgeHost {
    constructor(d: BridgeHostDeps)
    attach(t: BridgeTarget): void
    detach(tabId: string): Promise<void>
    /** null: no bridge for the tab (off) */
    state(tabId: string): RemoteState | null
    message(tabId: string, msg: unknown): void
    userSent(tabId: string, uuid: string, text: string, from: ChatSendOrigin | null): void
    cardOpened(tabId: string, cardId: string, ask: PermissionAsk): void
    cardClosed(tabId: string, cardId: string, by: 'window' | 'remote' | 'cancelled'): void
  }
  ```

- [ ] **Step 1: Write the test harness**

`tests/unit/bridge-host.test.ts` (imports: `vitest`; `WIN` from `../fixtures/platform`; `pathKey`; the host's exports; the types `AttachBridgeSessionOptions` from `@anthropic-ai/claude-agent-sdk/bridge`, `BridgeModule`, `RemoteSessionEntry`, `ClaudeCredentials`, `SdkPermissionResult`):

```ts
const TAB = 'tab-1'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const TOKEN = 'fake-access-token-0001'
const DEVICE = 'fake-device-token-0001'
const JWT = 'fake-worker-jwt-0001'
const CREDS = { worker_jwt: JWT, api_base_url: 'https://worker.example.invalid', expires_in: 3600, worker_epoch: 3 }
const FOLDER = WIN ? 'C:\\cfg' : '/cfg'
const CWD = WIN ? 'C:\\work' : '/work'
const GIT = { gitRepoUrl: 'https://git.example.invalid/acme/app.git', branch: 'fix', defaultBranch: 'main' }

/** a bridge handle that records what the host does with it */
class FakeHandle {
  writes: Record<string, unknown>[] = []; results = 0; states: string[] = []; requests: Record<string, any>[] = []; cancels: string[] = []
  closes = 0; flushes = 0; flushHangs = false; reconnects: Record<string, unknown>[] = []; seq = 7
  constructor(readonly opts: AttachBridgeSessionOptions) {}
  get sessionId(): string { return this.opts.sessionId }
  getSequenceNum(): number { return this.seq }
  getEpoch(): number | undefined { return this.opts.epoch }
  isConnected(): boolean { return true }
  write(m: unknown): void { this.writes.push(m as Record<string, unknown>) }
  sendResult(): void { this.results++ }
  sendControlRequest(r: unknown): void { this.requests.push(r as Record<string, any>) }
  sendControlResponse(): void {}
  sendControlCancelRequest(id: string): void { this.cancels.push(id) }
  async reconnectTransport(o: Record<string, unknown>): Promise<void> { this.reconnects.push(o) }
  reportState(s: string): void { this.states.push(s) }
  reportMetadata(): void {}
  reportDelivery(): void {}
  flush(): Promise<void> { this.flushes++; return this.flushHangs ? new Promise<void>(() => {}) : Promise.resolve() }
  close(): void { this.closes++ }
}

/** the host with a fake bridge (answers given in order), a fake store, chat and clock */
function host() {
  const calls: unknown[][] = []
  const answers = { create: ['cse_1'] as unknown[], creds: [CREDS] as unknown[], attachThrows: null as Error | null, attachGate: null as Promise<void> | null }
  const handles: FakeHandle[] = []
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  const bridge = {
    createCodeSession: async (...a: unknown[]) => { calls.push(['create', ...a]); return answers.create.length > 0 ? answers.create.shift() : 'cse_x' },
    fetchRemoteCredentials: async (...a: unknown[]) => { calls.push(['credentials', ...a]); return answers.creds.length > 0 ? answers.creds.shift() : CREDS },
    attachBridgeSession: async (opts: AttachBridgeSessionOptions) => {
      calls.push(['attach', opts])
      if (answers.attachGate) await answers.attachGate
      if (answers.attachThrows) throw answers.attachThrows
      const h = new FakeHandle(opts); handles.push(h); return h
    },
    isCredentialsFailure: (r: unknown) => isObj(r) && r.terminal === true,
    isCredentialsRejection: (r: unknown) => isObj(r) && r.terminal === false,
    isCreateSessionFailure: (r: unknown) => isObj(r) && r.terminal === true
  } as unknown as BridgeModule
  const stored = new Map<string, { entry: RemoteSessionEntry; account: string }>()
  const w = {
    creds: { accessToken: TOKEN, deviceToken: DEVICE, state: 'fresh' } as ClaudeCredentials,
    /** read in order before `creds`, one per read */
    credsQueue: [] as ClaudeCredentials[],
    bridgeOk: true, sent: [] as string[], answered: [] as [string, SdkPermissionResult][], answerOk: true, interrupts: 0,
    history: [] as unknown[], checks: 0, logs: [] as string[], timers: [] as { ms: number; run: () => void; on: boolean }[], changes: 0
  }
  const d: BridgeHostDeps = {
    bridge: async () => (w.bridgeOk ? { ok: true, bridge } : { ok: false }),
    credentials: async () => w.credsQueue.shift() ?? w.creds,
    sessions: {
      get: async (sid, account) => { const s = stored.get(sid); return s && s.account === account ? s.entry : null },
      put: async (sid, account, entry) => { stored.set(sid, { entry, account }) },
      forget: async (sid) => { stored.delete(sid) }
    },
    git: async () => GIT,
    chat: {
      send: async (_t, text) => { w.sent.push(text); return null },
      answer: (_t, id, r) => { w.answered.push([id, r]); return w.answerOk },
      interrupt: () => { w.interrupts++ },
      history: async () => w.history,
      checkSignIn: async () => { w.checks++ }
    },
    claudeVersion: () => '2.1.323',
    later: (ms, run) => { const t = { ms, run, on: true }; w.timers.push(t); return () => { t.on = false } },
    onChange: () => { w.changes++ },
    log: { info: (m) => w.logs.push(m), warn: (m) => w.logs.push(m) }
  }
  /** runs the pending timers of that delay */
  const fire = (ms: number): void => { for (const t of w.timers.filter((x) => x.on && x.ms === ms)) { t.on = false; t.run() } }
  return { h: new BridgeHost(d), calls, answers, handles, stored, w, fire }
}
const target = (over: Partial<BridgeTarget> = {}): BridgeTarget => ({ tabId: TAB, sessionId: SID, folder: FOLDER, env: {}, title: 'Fix the parser', cwd: CWD, model: 'claude-opus-5-5', ...over })
/** lets the attach's awaits run */
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const userLine = (uuid: string, text: string) => ({ type: 'user', uuid, session_id: SID, message: { role: 'user', content: text }, parent_tool_use_id: null })
const assistantLine = (uuid: string, text: string) => ({ type: 'assistant', uuid, session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null })
```

- [ ] **Step 2: Write the failing tests**

```ts
describe('BridgeHost: attach', () => {
  it('a new conversation: a new remote session, its worker token, attach; the id is stored, the history goes first, and the tab is on with its link', async () => {
    const { h, calls, handles, stored, w } = host()
    w.history = [userLine('u1', 'Fix the parser'), { type: 'system', subtype: 'init' }, assistantLine('a1', 'Done.')]
    h.attach(target())
    expect(h.state(TAB)).toEqual({ kind: 'connecting' })
    await settle()
    expect(calls.map((c) => c[0])).toEqual(['create', 'credentials', 'attach'])
    expect(calls[0]).toEqual(['create', 'https://api.anthropic.com', TOKEN, 'Fix the parser', 20_000, undefined, GIT, CWD, 'claude-opus-5-5'])
    expect(calls[1]).toEqual(['credentials', 'cse_1', 'https://api.anthropic.com', TOKEN, 20_000, DEVICE])
    const opts = calls[2][1] as AttachBridgeSessionOptions
    expect(opts).toMatchObject({ sessionId: 'cse_1', ingressToken: JWT, apiBaseUrl: CREDS.api_base_url, epoch: 3, claudeCodeVersion: '2.1.323' })
    expect(opts.initialSequenceNum).toBeUndefined()
    expect([opts.onSetModel, opts.onSetPermissionMode, opts.onRenameSession, opts.onStopTask, opts.onSetMaxThinkingTokens, opts.onBackgroundTasks]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
    expect(stored.get(SID)).toEqual({ entry: { remoteId: 'cse_1', sequenceNum: 0 }, account: pathKey(FOLDER) })
    expect(handles[0].writes.map((m) => m.uuid)).toEqual(['u1', 'a1'])
    expect(h.state(TAB)).toEqual({ kind: 'on', url: 'https://claude.ai/code/cse_1' })
  })
  it('a conversation with a stored remote session re-attaches with its sequence number and writes no history', async () => {
    const { h, calls, handles, stored, w } = host()
    stored.set(SID, { entry: { remoteId: 'cse_9', sequenceNum: 42 }, account: pathKey(FOLDER) })
    w.history = [userLine('u1', 'old')]
    h.attach(target())
    await settle()
    expect(calls.map((c) => c[0])).toEqual(['credentials', 'attach'])
    expect((calls[1][1] as AttachBridgeSessionOptions)).toMatchObject({ sessionId: 'cse_9', initialSequenceNum: 42 })
    expect(handles[0].writes).toEqual([])
  })
  it('a stored session that is gone (invalid_session_id, or a 404) is forgotten and a new one is made', async () => {
    for (const gone of [{ terminal: true, reason: 'invalid_session_id' }, { terminal: true, reason: 'request_rejected', status: 404 }]) {
      const { h, calls, answers, stored } = host()
      stored.set(SID, { entry: { remoteId: 'cse_9', sequenceNum: 42 }, account: pathKey(FOLDER) })
      answers.creds = [gone, CREDS]
      h.attach(target())
      await settle()
      expect(calls.map((c) => c[0])).toEqual(['credentials', 'create', 'credentials', 'attach'])
      expect(stored.get(SID)!.entry).toEqual({ remoteId: 'cse_1', sequenceNum: 0 })
    }
  })
  it('a stored session of another account is not used: a new one is made', async () => {
    const { h, calls, stored } = host()
    stored.set(SID, { entry: { remoteId: 'cse_9', sequenceNum: 42 }, account: 'another-folder' })
    h.attach(target())
    await settle()
    expect(calls[0][0]).toBe('create')
  })
  it('no sign-in: unavailable; an unusable record: failed; the bridge missing: unavailable; nothing is called', async () => {
    const none = host(); none.w.creds = { accessToken: null, deviceToken: null, state: 'none' }
    none.h.attach(target()); await settle()
    expect(none.h.state(TAB)).toEqual({ kind: 'unavailable', reason: 'No claude.ai sign-in found for this account' })
    const folderless = host(); folderless.h.attach(target({ folder: null })); await settle()
    expect(folderless.h.state(TAB)).toEqual({ kind: 'unavailable', reason: 'No claude.ai sign-in found for this account' })
    const bad = host(); bad.w.creds = { accessToken: null, deviceToken: null, state: 'unusable' }
    bad.h.attach(target()); await settle()
    expect(bad.h.state(TAB)).toEqual({ kind: 'failed', reason: 'Sign in to this account again (claude auth login)' })
    const old = host(); old.w.bridgeOk = false
    old.h.attach(target()); await settle()
    expect(old.h.state(TAB)).toEqual({ kind: 'unavailable', reason: "This ClaudeTerm cannot host Remote Control: the Agent SDK's bridge changed" })
    for (const x of [none, folderless, bad, old]) expect(x.calls).toEqual([])
  })
})

describe('BridgeHost: while it is on', () => {
  it('live messages are written, partial frames are not; a turn’s start reports running, its result writes, calls sendResult and reports idle', async () => {
    const { h, handles } = host()
    h.attach(target()); await settle()
    h.message(TAB, { type: 'system', subtype: 'init', session_id: SID })
    h.message(TAB, { type: 'stream_event', event: {} })
    h.message(TAB, assistantLine('a2', 'Working.'))
    h.message(TAB, { type: 'result', subtype: 'success', session_id: SID })
    expect(handles[0].writes.map((m) => m.type)).toEqual(['system', 'assistant', 'result'])
    expect(handles[0].results).toBe(1)
    // idle once attached, then the turn
    expect(handles[0].states).toEqual(['idle', 'running', 'idle'])
  })
  it('a message typed in the window is written as the user’s; one from claude.ai is not written back', async () => {
    const { h, handles } = host()
    h.attach(target()); await settle()
    h.userSent(TAB, 'u2', 'hello', null)
    h.userSent(TAB, 'u3', 'from the phone', 'remote')
    expect(handles[0].writes).toEqual([{ type: 'user', uuid: 'u2', session_id: '', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null }])
  })
  it('messages that come while attaching are written after the history, without those the history holds; a result among them still calls sendResult', async () => {
    const { h, handles, w } = host()
    w.history = [userLine('u1', 'Fix the parser')]
    h.attach(target())
    h.message(TAB, userLine('u1', 'Fix the parser'))
    h.message(TAB, assistantLine('a1', 'Done.'))
    h.message(TAB, { type: 'result', subtype: 'success', uuid: 'r1', session_id: SID })
    await settle()
    expect(handles[0].writes.map((m) => m.uuid)).toEqual(['u1', 'a1', 'r1'])
    expect(handles[0].results).toBe(1)
  })
  it('a message typed on claude.ai goes into the chat; one without text does not', async () => {
    const { h, handles, w } = host()
    h.attach(target()); await settle()
    await handles[0].opts.onInboundMessage!({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'from the phone' }] }, parent_tool_use_id: null, session_id: '' } as never)
    await handles[0].opts.onInboundMessage!({ type: 'user', message: { role: 'user', content: [] }, parent_tool_use_id: null, session_id: '' } as never)
    expect(w.sent).toEqual(['from the phone'])
  })
  it('an open card goes to claude.ai as can_use_tool with its id and requires action; claude.ai’s answer settles it; an answer to no open card, or a malformed one, is refused', async () => {
    const { h, handles, w } = host()
    h.attach(target()); await settle()
    h.cardOpened(TAB, 'card-1', { toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_1', folder: CWD })
    expect(handles[0].requests).toEqual([{ type: 'control_request', request_id: 'card-1', request: expect.objectContaining({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' }) }])
    expect(handles[0].states.at(-1)).toBe('requires_action')
    const answer = (requestId: string, response: unknown) => handles[0].opts.onPermissionResponse!({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } } as never)
    expect(answer('card-9', { behavior: 'allow' })).toBe(false)
    expect(answer('card-1', { behavior: 'maybe' })).toBe(false)
    expect(answer('card-1', { behavior: 'allow' })).not.toBe(false)
    expect(w.answered).toEqual([['card-1', { behavior: 'allow', updatedInput: { command: 'ls' } }]])
    h.cardClosed(TAB, 'card-1', 'remote')
    expect(handles[0].cancels).toEqual([])
  })
  it('a card answered in the window, or cancelled, is cancelled on claude.ai', async () => {
    const { h, handles } = host()
    h.attach(target()); await settle()
    h.cardOpened(TAB, 'card-1', { toolName: 'Bash', input: {}, folder: CWD })
    h.cardOpened(TAB, 'card-2', { toolName: 'Bash', input: {}, folder: CWD })
    h.cardClosed(TAB, 'card-1', 'window')
    h.cardClosed(TAB, 'card-2', 'cancelled')
    expect(handles[0].cancels).toEqual(['card-1', 'card-2'])
  })
  it('an interrupt from claude.ai interrupts the chat', async () => {
    const { h, handles, w } = host()
    h.attach(target()); await settle()
    handles[0].opts.onInterrupt!()
    expect(w.interrupts).toBe(1)
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run tests/unit/bridge-host.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement attach, outbound, inbound and permissions**

Per tab: `{ gen, target, state, handle | null, remoteId, queue, openCards: Map<cardId, ask>, historyUuids }`. Every await is followed by a check that the tab's `gen` is unchanged; a stale attach closes any handle it got and stops. `attach` on a tab whose bridge is connecting or on for the same session does nothing.

The attach, in order:
1. State `connecting`; `onChange`.
2. `bridge()` not ok → `unavailable` `REMOTE_REASONS.bridgeChanged`.
3. `folder` null → `unavailable` `noSignIn`. `credentials(folder, env)`: `none` → `unavailable` `noSignIn`; `unusable` → `failed` `relogin`; `expired` → the renew wait (Task 11; until then `failed` `relogin`); `fresh` → go on.
4. `account = pathKey(folder)`; `entry = sessions.get(sessionId, account)`. With an entry: its `remoteId`. Without: `createCodeSession(API_BASE, token, title, CALL_TIMEOUT_MS, undefined, (await git(cwd)) ?? undefined, cwd, model ?? undefined)`; a string → `put(sessionId, account, { remoteId, sequenceNum: 0 })`, `isNew = true`; any other answer → Task 11's error handling (until then `failed` `unreachable`).
5. `fetchRemoteCredentials(remoteId, API_BASE, token, CALL_TIMEOUT_MS, deviceToken ?? undefined)`. With a reused entry, a failure with reason `invalid_session_id` or `session_security_tier_below_org_policy`, or `request_rejected` with status 404 → `forget(sessionId)` and go back to step 4 once, creating. Other failures → Task 11 (until then `failed` `unreachable`).
6. `attachBridgeSession({ sessionId: remoteId, ingressToken: worker_jwt, apiBaseUrl: api_base_url, epoch: worker_epoch, ...(entry ? { initialSequenceNum: entry.sequenceNum } : {}), ...(version ? { claudeCodeVersion: version } : {}), onInboundMessage, onPermissionResponse, onInterrupt, onClose })`. No other callbacks.
7. New session only: `chat.history(tabId, sessionId)`; write each `user` or `assistant` entry; remember their `uuid`s.
8. Write the queue in order, skipping messages whose `uuid` the history holds, with the same `result` handling as live messages. State `on` with `remoteLink(remoteId)`; `reportState('idle')`; `onChange`.

While connecting, `message` and `userSent` queue what they would write (at most 1000; the oldest go first). Outbound:
- `message`: skip `type === 'stream_event'`; write; `system`/`init` → `reportState('running')`; `result` → `sendResult()` and `reportState('idle')`.
- `userSent`: `from === 'remote'` → nothing; else write `{ type: 'user', uuid, session_id: '', message: { role: 'user', content: text }, parent_tool_use_id: null }` and `reportState('running')`.
- `cardOpened`: keep the ask; `sendControlRequest({ type: 'control_request', request_id: cardId, request: { subtype: 'can_use_tool', tool_name, input, tool_use_id: ask.toolUseId ?? cardId, ...title, display_name, description, permission_suggestions when the ask has them } })`; `reportState('requires_action')`.
- `cardClosed`: drop the card; `window` or `cancelled` → `sendControlCancelRequest(cardId)`; no card left → `reportState('running')`.

Inbound:
- `onInboundMessage(msg)`: a `user` message; its text is the string `message.content`, or its `text` blocks joined with `\n`; trimmed empty → nothing; else `chat.send(tabId, text)`; a refusal (non-null answer) is logged as `a message from claude.ai was not sent: <reason>`.
- `onPermissionResponse(res)`: `false` unless `res.response.subtype === 'success'`, `request_id` names an open card and the payload is `{ behavior: 'allow', updatedInput?: object }` or `{ behavior: 'deny', message?: string }`. Allow → `{ behavior: 'allow', updatedInput: payload.updatedInput ?? ask.input }`; deny → `{ behavior: 'deny', message: payload.message (at most 1000 characters) ?? 'Denied on claude.ai' }`. `chat.answer(...)` false → `false`; else accepted (return nothing).
- `onInterrupt` → `chat.interrupt(tabId)`.

`chat-cards.ts`: `PermissionAsk` gains `toolUseId?: string` (Task 12 fills it).

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run tests/unit/bridge-host.test.ts`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 6: Leave the work uncommitted**

Suggested message: `feat: host a chat tab's Remote Control session through the SDK's bridge`.

---

### Task 11: The bridge host: off, closes, reconnects, waits and refusals

**Files:**
- Modify: `src/main/remote-control/bridge-host.ts`
- Test: `tests/unit/bridge-host.test.ts`

**Interfaces:**
- Consumes: Task 10.
- Produces: `export const FLUSH_MS = 2_000`, `RENEW_EVERY_MS = 60_000`, `SEQUENCE_EVERY_MS = 60_000`, `BACKOFF_MS = [2_000, 5_000, 15_000, 60_000] as const`; `export function refusalReason(r: { reason: string; status?: number }): string`. During a reconnect the state is `connecting`.

- [ ] **Step 1: Write the failing tests**

(`fire`, `settle` and the harness are Task 10's.)

```ts
describe('BridgeHost: off and closes', () => {
  it('off flushes with a 2 s limit, then closes, stores the sequence number and goes off', async () => {
    const { h, handles, stored, w, fire } = host()
    h.attach(target()); await settle()
    handles[0].flushHangs = true
    handles[0].seq = 19
    const off = h.detach(TAB)
    await settle()
    fire(2_000)
    await off
    expect([handles[0].flushes, handles[0].closes]).toEqual([1, 1])
    expect(stored.get(SID)!.entry).toEqual({ remoteId: 'cse_1', sequenceNum: 19 })
    expect(h.state(TAB)).toBeNull()
  })
  it('the sequence number is stored every minute while on', async () => {
    const { h, handles, stored, fire } = host()
    h.attach(target()); await settle()
    handles[0].seq = 11
    fire(60_000); await settle()
    expect(stored.get(SID)!.entry.sequenceNum).toBe(11)
  })
  it('a 401 or a 4094 close reads the credentials again and reconnects with a fresh worker token, the same epoch', async () => {
    for (const code of [401, 4094]) {
      const { h, handles, calls } = host()
      h.attach(target()); await settle()
      handles[0].opts.onClose!(code)
      expect(h.state(TAB)).toEqual({ kind: 'connecting' })
      await settle()
      expect(calls.filter((c) => c[0] === 'credentials')).toHaveLength(2)
      expect(handles[0].reconnects).toEqual([{ ingressToken: JWT, apiBaseUrl: CREDS.api_base_url }])
      expect(h.state(TAB)).toEqual({ kind: 'on', url: 'https://claude.ai/code/cse_1' })
    }
  })
  it('a 4090 close reconnects with the new epoch', async () => {
    const { h, handles, answers } = host()
    h.attach(target()); await settle()
    answers.creds = [{ ...CREDS, worker_epoch: 4 }]
    handles[0].opts.onClose!(4090); await settle()
    expect(handles[0].reconnects).toEqual([{ ingressToken: JWT, apiBaseUrl: CREDS.api_base_url, epoch: 4 }])
  })
  it('a 403 or a 404 close fails with the refused reason, and nothing is retried', async () => {
    for (const code of [403, 404]) {
      const { h, handles, calls, w } = host()
      h.attach(target()); await settle()
      handles[0].opts.onClose!(code); await settle()
      expect(h.state(TAB)).toEqual({ kind: 'failed', reason: `claude.ai refused Remote Control (${code})` })
      expect(calls.filter((c) => c[0] === 'credentials')).toHaveLength(1)
      expect(w.timers.filter((t) => t.on)).toEqual([])
    }
  })
  it('another close retries after 2, 5, 15 and 60 s, then fails as unreachable', async () => {
    const { h, handles, answers, calls, w, fire } = host()
    h.attach(target()); await settle()
    answers.creds = [null, null, null, null, null]
    handles[0].opts.onClose!(4093); await settle()
    for (const ms of [2_000, 5_000, 15_000, 60_000]) {
      expect(h.state(TAB)).toEqual({ kind: 'connecting' })
      expect(w.timers.filter((t) => t.on).map((t) => t.ms)).toEqual([ms])
      fire(ms); await settle()
    }
    expect(h.state(TAB)).toEqual({ kind: 'failed', reason: 'claude.ai could not be reached' })
    expect(calls.filter((c) => c[0] === 'credentials')).toHaveLength(6)
    expect(w.timers.filter((t) => t.on)).toEqual([])
  })
  it('a transient answer (null) at attach retries after 2 s from the step that failed: the new session keeps its history', async () => {
    const { h, answers, calls, handles, w, fire } = host()
    w.history = [userLine('u1', 'Fix the parser')]
    answers.creds = [null, CREDS]
    h.attach(target()); await settle()
    expect(h.state(TAB)).toEqual({ kind: 'connecting' })
    fire(2_000); await settle()
    expect(calls.map((c) => c[0])).toEqual(['create', 'credentials', 'credentials', 'attach'])
    expect(handles[0].writes.map((m) => m.uuid)).toEqual(['u1'])
    expect(h.state(TAB)).toMatchObject({ kind: 'on' })
  })
  it('detaching while attaching closes the handle that comes, and writes nothing to it', async () => {
    const { h, answers, calls, handles } = host()
    let open!: () => void
    answers.attachGate = new Promise<void>((r) => { open = r })
    h.attach(target()); await settle()
    expect(calls.at(-1)![0]).toBe('attach')
    const off = h.detach(TAB)
    open(); await settle(); await off
    expect(handles).toHaveLength(1)
    expect(handles[0].closes).toBe(1)
    expect(handles[0].writes).toEqual([])
    expect(h.state(TAB)).toBeNull()
  })
})

describe('BridgeHost: refusals and the sign-in', () => {
  it('refusals map to their reasons', () => {
    expect(refusalReason({ reason: 'untrusted_device' })).toBe('Turn Remote Control on once in a terminal tab of this account: Claude Code registers this computer then')
    expect(refusalReason({ reason: 'session_stale_relogin' })).toBe('Sign in to this account again (claude auth login)')
    expect(refusalReason({ reason: 'oauth_rejected' })).toBe('Sign in to this account again (claude auth login)')
    expect(refusalReason({ reason: 'request_rejected', status: 403 })).toBe('claude.ai refused Remote Control (403)')
    expect(refusalReason({ reason: 'malformed_response', status: 502 })).toBe('claude.ai refused Remote Control (502)')
    expect(refusalReason({ reason: 'grouping_rejected', status: 400 })).toBe('claude.ai refused Remote Control (400)')
  })
  it('an untrusted device at attach fails with its reason; nothing is retried', async () => {
    const { h, answers, w } = host()
    answers.creds = [{ terminal: true, reason: 'untrusted_device' }]
    h.attach(target()); await settle()
    expect(h.state(TAB)).toEqual({ kind: 'failed', reason: 'Turn Remote Control on once in a terminal tab of this account: Claude Code registers this computer then' })
    expect(w.timers.filter((t) => t.on)).toEqual([])
  })
  it('an expired stored token waits: connecting with the renew note, one sign-in check, a read every 60 s, and the attach goes on once it is fresh', async () => {
    const { h, w, calls, fire } = host()
    w.creds = { accessToken: null, deviceToken: null, state: 'expired' }
    h.attach(target()); await settle()
    expect(h.state(TAB)).toEqual({ kind: 'connecting', note: "Waiting for Claude Code to renew this account's sign-in" })
    expect(w.checks).toBe(1)
    fire(60_000); await settle()
    expect(calls).toEqual([])
    w.creds = { accessToken: TOKEN, deviceToken: null, state: 'fresh' }
    fire(60_000); await settle()
    expect(h.state(TAB)).toMatchObject({ kind: 'on' })
    expect(w.checks).toBe(1)
  })
  it('an oauth rejection waits when the stored token has expired meanwhile, and fails as a relogin when it reads the same', async () => {
    const renewed = host()
    renewed.answers.creds = [{ terminal: false, reason: 'oauth_rejected' }]
    renewed.w.credsQueue = [renewed.w.creds, { accessToken: null, deviceToken: null, state: 'expired' }]
    renewed.h.attach(target()); await settle()
    expect(renewed.h.state(TAB)).toEqual({ kind: 'connecting', note: "Waiting for Claude Code to renew this account's sign-in" })
    const same = host()
    same.answers.creds = [{ terminal: false, reason: 'oauth_rejected' }]
    same.h.attach(target()); await settle()
    expect(same.h.state(TAB)).toEqual({ kind: 'failed', reason: 'Sign in to this account again (claude auth login)' })
  })
  it('no token in any log line or state: the access, device and worker tokens never appear in what the logger got', async () => {
    const { h, answers, w, fire } = host()
    answers.attachThrows = new Error(`attach failed for ${JWT} with ${TOKEN} and ${DEVICE}`)
    h.attach(target()); await settle()
    answers.attachThrows = null
    fire(2_000); await settle()
    expect(h.state(TAB)).toMatchObject({ kind: 'on' })
    expect(w.logs.some((m) => m.includes('attach failed for [token] with [token] and [token]'))).toBe(true)
    const seen = [...w.logs, JSON.stringify(h.state(TAB))].join('\n')
    for (const secret of [TOKEN, DEVICE, JWT]) expect(seen).not.toContain(secret)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/bridge-host.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

- `detach(tabId)`: `gen++`; cancel the tab's timers; with a handle: `await Promise.race([handle.flush(), a later(FLUSH_MS) promise])`, store `getSequenceNum()` (`put`), `handle.close()`; forget the tab (state null); `onChange`. A handle that an attach gets after its tab's `gen` changed is closed at once, nothing written to it.
- While on: `later(SEQUENCE_EVERY_MS, store-and-rearm)`; it is cancelled whenever the state leaves `on`, so a tab has at most one pending timer of its own.
- `onClose(code)` (ignored after a detach): store the sequence number; cancel the sequence timer; state `connecting`.
- A retry, a reconnect and the end of the renew wait go on from the step that failed, with the remote id and `isNew` the attach already has: a new session made before a transient failure still gets its history.
  - 401, 4094: read the credentials again, `fetchRemoteCredentials` for the same remote id, `reconnectTransport({ ingressToken, apiBaseUrl })`.
  - 4090: the same with `epoch: worker_epoch`.
  - 403, 404: `failed` `refusedReason(code)`.
  - any other code, and a reconnect that throws or gets `null`: retry with `BACKOFF_MS` in order; a success resets the count; after the 60 s step fails: `failed` `unreachable`.
- At attach, a `null` (transient) answer of `createCodeSession` or `fetchRemoteCredentials`, or `attachBridgeSession` throwing, retries the attach with the same backoff, then `failed` `unreachable`.
- Refusals: `isCreateSessionFailure` / `isCredentialsFailure` (terminal) → `failed` `refusalReason(r)` (the gone cases of Task 10 step 5 excepted). `isCredentialsRejection` (`oauth_rejected`): read the credentials again; expired → the renew wait; fresh with another token → retry once at once; else `failed` `relogin`.
- `refusalReason`: `untrusted_device` → `untrustedDevice`; `session_stale_relogin`, `oauth_rejected` → `relogin`; any other reason with a status → `refusedReason(status)`; without one → `unreachable`.
- The renew wait: state `{ kind: 'connecting', note: RENEW_WAIT_NOTE }`; `chat.checkSignIn(tabId)` once per attach (a rejection is ignored); read the credentials every `RENEW_EVERY_MS` until fresh, then go on from the step that needed the token; it ends with a detach.
- Logs: fixed texts only (`remote control: <what> for tab <tabId>`), with an error's message only through `scrub(text, secrets)`, which replaces every token the attach has read or received (access, device, worker) with `[token]`. A reason is always one of the fixed reasons.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/unit/bridge-host.test.ts`, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Leave the work uncommitted**

Suggested message: `feat: a chat's Remote Control reconnects, waits for a renewed sign-in and says why it fails`.

---

### Task 12: Chat tabs: the taps, messages from claude.ai, the hub's chat side, the stand-in bridge

**Files:**
- Modify: `src/shared/chat.ts:17` (`ChatSendOrigin`)
- Modify: `src/main/chat/chat-hub.ts` (`ChatHubDeps` :69, `Live.waiting` :133, `deliver` :422, `answer` :461, `sessionChanged` :638, `remove` :699, `begin` :732, `becomeReady` :771, `finish` :814, `apply` :880, `openCard` :994, `settle` :1011, `stopped` :1025; new `answerRemote`, `sessionIdOf`, `modelOf`, `checkSignIn`)
- Modify: `src/main/chat/chat-engine.ts:35` (`ChatEngine.accountInfo?`), `src/main/chat/sdk-engine.ts` (`canUseTool` :271-295: `toolUseId: opts.toolUseID`; `accountInfo`)
- Modify: `src/main/chat/chat-mirror.ts:341` (`itemForMembers`)
- Modify: `src/renderer/chat/chat-items.ts` (`userRow` :171-177 only), `src/renderer/chat/chat.css` (one rule)
- Modify: `src/main/remote-control/remote-control-hub.ts`
- Modify: `src/main/index.ts` (the chat's `history` lambda :1161 becomes `chatHistory`; `BridgeHost` and the stand-in; ChatHub deps; hub deps)
- Create: `tests/fixtures/fake-bridge/fake-bridge.mjs`
- Test: `tests/unit/chat-hub.test.ts`, `tests/unit/chat-mirror.test.ts`, `tests/unit/chat-guards.test.ts` (or the file that tests `isChatSend`), `tests/unit/remote-control-hub.test.ts`, `tests/e2e/remote-control-chat.spec.ts`

**Interfaces:**
- Consumes: `BridgeHost`, `BridgeTarget` (Tasks 10, 11); Task 5's hub; Tasks 8-9.
- Produces:
  - `ChatSendOrigin = 'auto' | 'review' | 'agent' | 'remote'`; `isChatOrigin` (the window's) stays `'auto' | 'review'`.
  - ```ts
    export interface RemoteControlTap {
      ready(tabId: string, sessionId: string | null): void
      message(tabId: string, msg: unknown): void
      userSent(tabId: string, uuid: string, text: string, from: ChatSendOrigin | null): void
      cardOpened(tabId: string, cardId: string, ask: PermissionAsk): void
      cardClosed(tabId: string, cardId: string, by: 'window' | 'remote' | 'cancelled'): void
      sessionChanged(tabId: string, sessionId: string): void
      ended(tabId: string): void
    }
    ```
    `ChatHubDeps.remoteControl?: RemoteControlTap`; `ChatHub.answerRemote(tabId: string, cardId: string, result: SdkPermissionResult): boolean`; `ChatHub.sessionIdOf(tabId: string): string | null`; `ChatHub.modelOf(tabId: string): string | null`; `ChatHub.checkSignIn(tabId: string): Promise<void>`; `ChatEngine.accountInfo?(): Promise<void>`.
  - `RemoteControlDeps` gains `host: Pick<BridgeHost, 'attach' | 'detach' | 'state'>` and `target(tabId: string, sessionId: string): BridgeTarget | null`; `RemoteControlHub` gains `chatReady(tabId: string, sessionId: string | null): void`, `chatSessionChanged(tabId: string, sessionId: string): void`, `chatEnded(tabId: string): void`.
  - The stand-in bridge (`tests/fixtures/fake-bridge/fake-bridge.mjs`, plain ESM JavaScript, CRLF): exports the six `BRIDGE_EXPORTS`; `createCodeSession` answers `cse_test1`, `cse_test2`, …; `fetchRemoteCredentials` answers `{ worker_jwt: 'fake-worker-jwt-0001', api_base_url: 'https://bridge.example.invalid', expires_in: 3600, worker_epoch: 1 }`; `attachBridgeSession` waits, checking every 50 ms, while `globalThis.ctTestBridgeHold === true` (a global the test sets with `app.evaluate` before the module is loaded: the loader imports it only at the first attach). It keeps `globalThis.ctTestBridge = { calls, handles, inbound(text), answer(requestId, behavior), snapshot() }`: `calls` are `{ fn: 'create', token, title, cwd }`, `{ fn: 'credentials', sessionId, token, device }`, `{ fn: 'attach', sessionId, initialSequenceNum }`; each handle records `{ sessionId, writes, results, requests, cancels, states, closes }` and its sequence number is `writes.length`; `inbound` calls the last open handle's `onInboundMessage` with a user message of that text; `answer` calls its `onPermissionResponse` with a `success` response (`{ behavior: 'allow' }` or `{ behavior: 'deny', message: 'No' }`) and returns what it returned; `snapshot()` returns `calls` and the handles without their callbacks (JSON-safe, for `app.evaluate`).

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/chat-hub.test.ts` — add `'remoteControl'` to `harness()`'s `over` Pick and pass it into `deps` as `sessionReady` is passed. A recording tap:

```ts
/** a tap that records each call as [name, ...args]; `throws`: every call throws after recording */
function recordingTap(throws = false): { tap: RemoteControlTap; heard: unknown[][] } {
  const heard: unknown[][] = []
  const rec = (name: string) => (...args: unknown[]): void => { heard.push([name, ...args]); if (throws) throw new Error('tap broke') }
  return { heard, tap: { ready: rec('ready'), message: rec('message'), userSent: rec('userSent'), cardOpened: rec('cardOpened'), cardClosed: rec('cardClosed'), sessionChanged: rec('sessionChanged'), ended: rec('ended') } }
}

describe('ChatHub: the Remote Control tap', () => {
  it('hears the chat ready, its session id once the init names it, each live message, each message sent with its origin, and each card with how it closed', async () => {
    const { tap, heard } = recordingTap()
    const { hub, engines } = harness({ remoteControl: tap })
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    // a new conversation has no session id until its init
    expect(heard.filter((c) => c[0] === 'ready')).toEqual([['ready', TAB, null]])
    engines[0].h.message(init())
    expect(heard.filter((c) => c[0] === 'sessionChanged')).toEqual([['sessionChanged', TAB, SID]])
    expect(heard.some((c) => c[0] === 'message' && (c[2] as { type: string }).type === 'system')).toBe(true)
    await hub.send(TAB, { text: 'hello', attachments: [] })
    expect(heard.filter((c) => c[0] === 'userSent').map((c) => [c[3], c[4]])).toEqual([['hello', null]])
    const ctl = new AbortController()
    void engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, ctl.signal)
    const card = last(hub.snapshot(TAB)!.items)
    expect(heard.filter((c) => c[0] === 'cardOpened').map((c) => [c[2], (c[3] as PermissionAsk).toolName])).toEqual([[card.id, 'Bash']])
    hub.answer(TAB, card.id, { type: 'permission', choice: 'once', suggestion: null, message: null })
    expect(heard.filter((c) => c[0] === 'cardClosed')).toEqual([['cardClosed', TAB, card.id, 'window']])
  })
  it('hears a new conversation in the tab, and the end of the chat', async () => {
    // start, ready and init() as above; then hub.sessionChanged(TAB, OTHER, 'clear') → heard holds ['sessionChanged', TAB, OTHER];
    // a resume start (startReq(SID)) is heard ready with SID; hub.remove(TAB) → heard holds ['ended', TAB]
  })
  it('answerRemote settles an open card with claude.ai’s result and says so on the card; an unknown card is refused', async () => {
    const { tap, heard } = recordingTap()
    const { hub, engines } = harness({ remoteControl: tap })
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    const ctl = new AbortController()
    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, ctl.signal)
    const card = last(hub.snapshot(TAB)!.items)
    expect(hub.answerRemote(TAB, 'nope', { behavior: 'allow', updatedInput: {} })).toBe(false)
    expect(hub.answerRemote(TAB, card.id, { behavior: 'allow', updatedInput: { command: 'ls -a' } })).toBe(true)
    await expect(decided).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls -a' } })
    expect(last(hub.snapshot(TAB)!.items)).toMatchObject({ kind: 'card', answered: 'Allowed from claude.ai' })
    expect(heard.filter((c) => c[0] === 'cardClosed')).toEqual([['cardClosed', TAB, card.id, 'remote']])
    expect(hub.answerRemote(TAB, card.id, { behavior: 'deny', message: 'No' })).toBe(false)
  })
  it('a denial from claude.ai reads Denied from claude.ai', async () => {
    // as above with { behavior: 'deny', message: 'No' } → resolves { behavior: 'deny', message: 'No' }, answered 'Denied from claude.ai'
  })
  it('a message from claude.ai shows as the person’s, marked as from remote, and reaches Claude Code', async () => {
    const { tap, heard } = recordingTap()
    const { hub, engines } = harness({ remoteControl: tap })
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    expect(await hub.send(TAB, { text: 'from the phone', attachments: [], from: 'remote' })).toBeNull()
    expect(hub.snapshot(TAB)!.items.find((i) => i.kind === 'user')).toMatchObject({ text: 'from the phone', from: 'remote' })
    expect(engines[0].sent).toEqual(['from the phone'])
    expect(heard.filter((c) => c[0] === 'userSent').map((c) => [c[3], c[4]])).toEqual([['from the phone', 'remote']])
  })
  it('a tap that throws leaves the chat as it is', async () => {
    const { tap } = recordingTap(true)
    const { hub, engines } = harness({ remoteControl: tap })
    hub.start(startReq().req)
    await settle()
    engines[0].h.ready({ permissionMode: 'default' })
    engines[0].h.message(init())
    expect(await hub.send(TAB, { text: 'hello', attachments: [] })).toBeNull()
    expect(engines[0].sent).toEqual(['hello'])
    const decided = engines[0].h.ask({ toolName: 'Bash', input: { command: 'ls' } }, new AbortController().signal)
    const card = last(hub.snapshot(TAB)!.items)
    expect(hub.answer(TAB, card.id, { type: 'permission', choice: 'once', suggestion: null, message: null })).toBe(true)
    await expect(decided).resolves.toMatchObject({ behavior: 'allow' })
  })
})
```

(Write the two bodies given as comments in the shape of the tests beside them. `SID` is the session `init()` reports and `OTHER` another, both the file's. A question or plan card answered through `answerRemote` reads `Answered from claude.ai`; cover it in the denial test with the file's question ask.)

`tests/unit/chat-guards.test.ts` (or the file that tests `isChatSend`): `expect(isChatSend({ text: 'x', attachments: [], from: 'remote' })).toBe(false)` — the window cannot send as claude.ai.

`tests/unit/chat-mirror.test.ts` (the file's `userItem(from)` and `snapshot(items)` helpers, :20-29):

```ts
  it('a message from claude.ai reaches the members as a plain message: its origin is left out, so their check takes it', () => {
    const item = userItem('remote')
    // a member refuses an origin it does not know
    expect(parseChatPush(snapshot([item]))).toBeNull()
    const shown = itemForMembers(item)
    expect(shown).not.toHaveProperty('from')
    expect(shown).toMatchObject({ kind: 'user', text: (item as { text: string }).text })
    expect(parseChatPush(snapshot([shown]))).not.toBeNull()
  })
```

`tests/unit/remote-control-hub.test.ts`, extend `world()`:

```ts
  // added to w:
  attached: [] as BridgeTarget[], detached: [] as string[], hostState: null as RemoteState | null,
  // added to deps:
  host: {
    attach: (t) => { w.attached.push(t) },
    detach: async (id) => { w.detached.push(id) },
    state: () => w.hostState
  },
  target: (id, sid) => ({ tabId: id, sessionId: sid, folder: '/cfg', env: {}, title: 'work', cwd: '/w', model: null }),
```

```ts
describe('RemoteControlHub: chat tabs', () => {
  const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
  const SID_2 = '6e3d2c8b-9f5a-4b4c-a2d3-e4f5a6b7c8d9'
  it('a chat whose choice is off never attaches: not when ready, not on a new session', () => {
    const { hub, w } = world({ view: 'chat' })
    hub.processStarted(TAB)
    hub.chatReady(TAB, SID)
    hub.chatSessionChanged(TAB, SID_2)
    expect(w.attached).toEqual([])
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
  })
  it('a chat whose choice is on shows connecting from its start, and attaches when its session is ready', () => {
    const { hub, w } = world({ view: 'chat', choice: true })
    hub.processStarted(TAB)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    expect(w.attached).toEqual([])
    hub.chatReady(TAB, SID)
    expect(w.attached.map((t) => t.sessionId)).toEqual([SID])
  })
  it('the switch attaches a ready chat and detaches it', async () => {
    const { hub, w } = world({ view: 'chat' })
    hub.processStarted(TAB)
    hub.chatReady(TAB, SID)
    hub.set(TAB, true)
    expect([w.choice, w.attached.map((t) => t.sessionId)]).toEqual([true, [SID]])
    hub.set(TAB, false)
    await Promise.resolve()
    expect([w.choice, w.detached]).toEqual([false, [TAB]])
  })
  it('a new conversation in the tab (/clear) detaches, then attaches for the new session', async () => {
    const { hub, w } = world({ view: 'chat', choice: true })
    hub.processStarted(TAB)
    hub.chatReady(TAB, SID)
    hub.chatSessionChanged(TAB, SID_2)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(w.detached).toEqual([TAB])
    expect(w.attached.map((t) => t.sessionId)).toEqual([SID, SID_2])
  })
  it('the host’s state is the tab’s state while it has one; the chat ending detaches and keeps the choice', async () => {
    const { hub, w } = world({ view: 'chat', choice: true })
    hub.processStarted(TAB)
    hub.chatReady(TAB, SID)
    w.hostState = { kind: 'on', url: 'https://claude.ai/code/cse_1' }
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: 'https://claude.ai/code/cse_1' })
    hub.chatEnded(TAB)
    w.hostState = null
    expect(w.detached).toEqual([TAB])
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(true)
  })
  it('a chat that goes to the terminal detaches; a token account never attaches', () => {
    const moved = world({ view: 'chat', choice: true })
    moved.hub.processStarted(TAB)
    moved.hub.chatReady(TAB, SID)
    moved.w.tab = { ...moved.w.tab!, view: 'terminal' }
    moved.hub.processStarted(TAB)
    expect(moved.w.detached).toEqual([TAB])
    const token = world({ view: 'chat', choice: true, kind: 'token' })
    token.hub.processStarted(TAB)
    token.hub.chatReady(TAB, SID)
    expect(token.w.attached).toEqual([])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/unit/chat-hub.test.ts tests/unit/chat-mirror.test.ts tests/unit/chat-guards.test.ts tests/unit/remote-control-hub.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the chat side**

1. `shared/chat.ts`: add `'remote'` to `ChatSendOrigin`, and to its doc comment `remote: typed on claude.ai, through Remote Control`.
2. `chat-hub.ts`: a private `tap(run: (t: RemoteControlTap) => void)` that calls it inside `try`/`catch` (a throw is logged with `log.warn`). Calls: `ready(tabId, live.model.state().sessionId)` at the end of `becomeReady`; `message(tabId, msg)` at the end of `apply` (live messages only; the history goes through `loadHistory`); `userSent(tabId, id, prepared.text, s.from ?? null)` right after each `engine.send` (in `deliver`, and in `begin` for the waiting messages, whose entries now keep `from`); `cardOpened(tabId, id, full)` in `openCard`; `cardClosed(tabId, cardId, by)` in `settle`, which takes a new `by` argument (`answer` → `'window'`, `answerRemote` → `'remote'`, the cancellations → `'cancelled'`); `sessionChanged(tabId, sessionId)` whenever `live.model.state().sessionId` changes to another id (compare it before and after the patches of `apply` and of `sessionChanged`): the first init of a new conversation, a clear, a resume; `ended(tabId)` in `finish`, `stopped` and `remove`. `answerRemote` settles with the line `Allowed from claude.ai` / `Denied from claude.ai` for a permission card and `Answered from claude.ai` for any other card. `sessionIdOf` → `live.model.state().sessionId`; `modelOf` → `live.model.status().model`; `checkSignIn` → `engine.accountInfo?.()` (no engine: resolves).
3. `chat-engine.ts`: `accountInfo?(): Promise<void>`. `sdk-engine.ts`: `async accountInfo() { await (await query).accountInfo() }`; `canUseTool` passes `toolUseId: opts.toolUseID`.
4. `chat-mirror.ts`: `itemForMembers` returns a `user` item with `from: 'remote'` without its `from`.
5. `chat-items.ts`, in `userRow` only: `if (item.from === 'remote') row.append(el('div', 'chat-quiet chat-from-remote', 'from claude.ai'))` after the bubble. `chat.css`: `.chat-from-remote { align-self: flex-end; }` (match the `Queued` mark's placement).
6. The hub: per chat tab `{ live, ready, sessionId }`. `processStarted` in chat view → `live = true, ready = false`; in terminal view → `void host.detach(tabId)` before Task 5's work. `state` in chat view: unavailable rule → unavailable; exited → off; `host.state(tabId)` when not null; else choice on and `live` → `connecting`; else off. `chatReady` → `ready = true`, keep the session id, attach when the choice is on, the account available and a session id is known. `chatSessionChanged` → a new id: keep it; attached or attaching → `await host.detach(tabId)`, then attach for the new session if the choice is still on; not attached, ready and the choice on → attach (a new conversation is ready before its init names its id). `chatEnded` → `live = false, ready = false`, `void host.detach(tabId)`. `set()` in chat view: `setChoice(on)`; on → attach when ready (else the ready attaches); off → `void host.detach(tabId)`. `removeTab` → `void host.detach(tabId)`. Attach = `const t = target(tabId, sessionId); if (t) host.attach(t)`.
7. `index.ts`:
   - `const chatHistory = async (sessionId, folder, account) => …` (the body of the ChatHub `history` dep, unchanged); ChatHub's `history: chatHistory`.
   - `const bridgeHost = new BridgeHost({ bridge: bridgeLoader(testBridge ? () => import(/* @vite-ignore */ pathToFileURL(testBridge).href) : importBridge, log), credentials: (folder, env) => readClaudeCredentials(folder, env, { platform: process.platform, home: homedir(), username: userInfo().username, now: Date.now, security: process.platform === 'darwin' && !isTest ? securityRunner() : null }), sessions: new RemoteSessionStore(join(dataDir, 'remote-sessions.json'), Date.now, log), git: (cwd) => gitContextOf(cwd, execGit), chat: { send: async (id, text) => { const at = Date.now(); const refused = await chatHub.send(id, { text, attachments: [], from: 'remote' }); if (refused === null) personInput.sent(id, text, at); return refused }, answer: (id, card, r) => chatHub.answerRemote(id, card, r), interrupt: (id) => chatHub.interrupt(id), history: (id, sid) => { const t = tabs.get(id); return t ? chatHistory(sid, t.cwd, t.account) : Promise.resolve([]) }, checkSignIn: (id) => chatHub.checkSignIn(id) }, claudeVersion: localVersion, later, onChange: statusSoon, log })`, where `const testBridge = isTest ? process.env.CLAUDETERM_TEST_BRIDGE : undefined`.
   - The `personInput.sent` call in `chat.send` carries the spec's last call: a message typed on claude.ai counts as the person's words, like a paired device's Send (`chat.send` of the sync deps in `index.ts` makes the same call, the same way: the time read before the send, the record written only when the chat took the message). Comment it so: `// a message typed on claude.ai is the person's, as a paired device's Send is`. ChatHub's own `from` check is not the place: `from: 'remote'` keeps the "from claude.ai" mark, and `IPC.chatSend` records only a Send whose `from` is undefined.
   - Hub deps: `host: bridgeHost`, `target: (id, sid) => { const t = tabs.get(id); return t ? { tabId: id, sessionId: sid, folder: t.account === null ? mainConfigDir : accounts.folderOf(t.account), env: tabs.claudeEnv(id) ?? {}, title: remoteName(tabTitleOf(t)), cwd: t.cwd, model: chatHub.modelOf(id) } : null }`.
   - ChatHub deps: `remoteControl: { ready: (id, sid) => remoteControl.chatReady(id, sid), sessionChanged: (id, sid) => remoteControl.chatSessionChanged(id, sid), ended: (id) => remoteControl.chatEnded(id), message: (id, m) => bridgeHost.message(id, m), userSent: (id, u, t, f) => bridgeHost.userSent(id, u, t, f), cardOpened: (id, c, a) => bridgeHost.cardOpened(id, c, a), cardClosed: (id, c, b) => bridgeHost.cardClosed(id, c, b) }`.
   - Declaration order: `bridgeHost` and `remoteControl` are read only inside callbacks; declare `bridgeHost` before `remoteControl`, both before the first tab opens.

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Write the stand-in bridge and the failing e2e tests**

Write `tests/fixtures/fake-bridge/fake-bridge.mjs` as the Interfaces block says. Add to `tests/e2e/remote-control-helpers.ts`:

```ts
export const FAKE_BRIDGE = resolve(__dirname, '..', 'fixtures', 'fake-bridge', 'fake-bridge.mjs')
export const RC_TOKEN = 'fake-rc-access-token-0001'
/** what the stand-in bridge recorded */
export const bridgeSeen = (app: ElectronApplication): Promise<{ calls: Record<string, unknown>[]; handles: Record<string, any>[] }> =>
  app.evaluate(() => (globalThis as { ctTestBridge?: { snapshot(): any } }).ctTestBridge?.snapshot() ?? { calls: [], handles: [] })
/** a chat tab on the stand-in, with the stand-in bridge and a fresh claude.ai sign-in in its config folder */
export async function launchRcChat(script: FakeScript, o: { work?: string } = {}) {
  const t = await launchChatTab(script, { ...o, env: { ...RC_CLEAN_ENV, CLAUDETERM_TEST_BRIDGE: FAKE_BRIDGE } })
  writeFileSync(join(t.config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: RC_TOKEN, expiresAt: Date.now() + 3_600_000 } }))
  await chatReady(t.page)
  return t
}
```

`tests/e2e/remote-control-chat.spec.ts`:

```ts
test('switching RC on in a chat shows connecting, then connected with its link; off closes the bridge; no token reaches the log', async () => {
  const t = await launchRcChat({ turns: {} })
  try {
    const seg = t.page.locator('#statusbar .status-remote')
    await t.app.evaluate(() => { (globalThis as any).ctTestBridgeHold = true })
    await seg.click()
    await expect(t.page.locator('.remote-popover .remote-chat-note')).toHaveText('ClaudeTerm sends this chat to claude.ai while it is on: messages, tool results, file contents. Prompts and permission answers can come from there.')
    await t.page.locator('.remote-popover input.switch').click()
    await expect(seg).toHaveAttribute('data-dot', 'connecting')
    await t.app.evaluate(() => { (globalThis as any).ctTestBridgeHold = false })
    await expect(seg).toHaveAttribute('data-dot', 'on')
    expect((await bridgeSeen(t.app)).calls.map((c) => c.fn)).toEqual(['create', 'credentials', 'attach'])
    expect((await bridgeSeen(t.app)).calls[0]).toMatchObject({ token: RC_TOKEN })
    await t.page.locator('.remote-popover input.switch').click()
    await expect(seg).toHaveAttribute('data-dot', 'off')
    expect((await bridgeSeen(t.app)).handles[0].closes).toBe(1)
    expect(readFileSync(join(t.dataDir, 'logs', 'main.log'), 'utf8')).not.toContain(RC_TOKEN)
  } finally {
    await t.app.close()
  }
})

test('a message sent in the window reaches claude.ai, with the end of its turn', async () => {
  const t = await launchRcChat({ turns: { hello: [{ text: 'Hi there.' }] } })
  try {
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await sendMessage(t.page, 'hello')
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0].writes.some((m: any) => m.type === 'user' && m.message.content === 'hello')).toBe(true)
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0].results).toBeGreaterThanOrEqual(1)
  } finally {
    await t.app.close()
  }
})

test('a message from claude.ai shows in the chat as from claude.ai and reaches Claude Code', async () => {
  const t = await launchRcChat({ turns: { 'from the phone': [{ text: 'Got it.' }] } })
  try {
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await t.app.evaluate(() => (globalThis as any).ctTestBridge.inbound('from the phone'))
    const row = t.page.locator('.chat-host:visible .chat-user-row', { hasText: 'from the phone' })
    await expect(row.locator('.chat-from-remote')).toHaveText('from claude.ai')
    await expect.poll(() => userMessages(t.log)).toContain('from the phone')
  } finally {
    await t.app.close()
  }
})

test("a message from claude.ai is the person's words in the coordinator's tab, as a paired device's Send is", async () => {
  test.setTimeout(120_000)
  const work = gitRepo()
  const t = await launchRcChat({ turns: { 'Should we ship?': [{ text: 'Shall I merge feat/x into master?' }] }, fallback: [{ text: 'OK.' }] }, { work })
  const idle = (id: string) => expect.poll(async () => (await chatState(t.page, id))?.turn ?? null, { timeout: 30_000 }).toBe('idle')
  try {
    const a = t.tabId
    const b = (await t.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work))!.id
    await activate(t.page, b)
    await sendMessage(t.page, 'hello')
    await idle(b)
    // tab a has RC on; the coordinator asks in the window, the person answers on claude.ai
    await activate(t.page, a)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), a)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await sendMessage(t.page, 'Should we ship?')
    await idle(a)
    await t.app.evaluate(() => (globalThis as any).ctTestBridge.inbound('Yes, merge it.'))
    await expect.poll(() => userMessages(t.log)).toContain('Yes, merge it.')
    await idle(a)
    const sidA = (await chatState(t.page, a))!.sessionId!
    const sidB = (await chatState(t.page, b))!.sessionId!
    // the coordinator's transcript, as the stand-in wrote it: the session start reports it, as the hook does
    const transcript = join(t.config, 'projects', realpathSync.native(work).replace(/[^a-zA-Z0-9]/g, '-'), `${sidA}.jsonl`)
    expect(await sendPipeMessage(t.pipeName, { v: 1, type: 'session', tabId: a, sessionId: sidA, source: 'startup', transcriptPath: transcript })).toEqual({ ok: true })
    expect(await makeCoordinator(t.page, a)).toMatchObject({ ok: true })
    expect(await coord(t.pipeName, a, { op: 'attach', session: refOf(sidB) })).toMatchObject({ ok: true })
    expect(await coord(t.pipeName, a, { op: 'message', session: refOf(sidB), text: 'Merge feat/x into master and push.', words: 'Yes, merge it.' })).toMatchObject({ ok: true })
  } finally {
    await t.app.close()
  }
})

test('a permission card answered from claude.ai closes in the window', async () => {
  const t = await launchRcChat({ turns: { run: [{ ask: { tool: 'Bash', input: { command: 'ls' } }, allowed: [{ text: 'Listed.' }], denied: [{ text: 'Not listed.' }] }] } })
  try {
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await sendMessage(t.page, 'run')
    await expect(t.page.locator('.chat-host:visible .chat-card-permission')).toHaveCount(1)
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0].requests.length).toBe(1)
    const requestId = (await bridgeSeen(t.app)).handles[0].requests[0].request_id as string
    await t.app.evaluate((id) => (globalThis as any).ctTestBridge.answer(id, 'allow'), requestId)
    await expect(t.page.locator('.chat-host:visible .chat-card.answered')).toContainText('Allowed from claude.ai')
    await expect.poll(() => controlResponses(t.log).map((r) => r.behavior)).toEqual(['allow'])
  } finally {
    await t.app.close()
  }
})

test('the choice goes with the tab: chat → terminal starts Claude Code with --rc, and back in the chat the bridge re-attaches to the same claude.ai session', async () => {
  const t = await launchRcChat({ turns: {} })
  try {
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    expect(await t.page.evaluate((id) => window.ct.setTabView(id, 'terminal'), t.tabId)).toBe(true)
    await expect.poll(() => runs(t.log).some((r) => r.argv.includes('--rc')), { timeout: 20_000 }).toBe(true)
    // Claude Code connects in the terminal: its statusLine says so (no hook runs in the e2e tests)
    expect(await sendPipeMessage(t.pipeName, rcStatus(t.tabId, 'session_01Term'))).toEqual({ ok: true })
    expect(await t.page.evaluate((id) => window.ct.setTabView(id, 'chat'), t.tabId)).toBe(true)
    await expect.poll(async () => (await bridgeSeen(t.app)).calls.filter((c) => c.fn === 'attach').map((c) => c.sessionId), { timeout: 20_000 }).toEqual(['cse_test1', 'cse_test1'])
    expect((await bridgeSeen(t.app)).calls.filter((c) => c.fn === 'create')).toHaveLength(1)
  } finally {
    await t.app.close()
  }
})
```

(`runs` comes from `./account-helpers`; `sendMessage`, `userMessages`, `controlResponses` and `chatReady` from `./chat-helpers`; `chatState`, `coord` and `makeCoordinator` from `./coordinator-helpers`; `activate` and `refOf` from `./agent-mail`; `gitRepo` from `./helpers`; `sendPipeMessage` from `../../src/shared/pipe-client`. The person's-words test copies the setup of `coordinator-words.spec.ts`'s chat-view test; it must fail with the `personInput.sent` call of Step 3 removed, since the coordinator's `message` is then refused. Check that once, then restore the call.)

- [ ] **Step 6: Run the e2e specs**

Run: `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run build && node scripts/e2e.mjs tests/e2e/remote-control-chat.spec.ts tests/e2e/chat-cards.spec.ts tests/e2e/chat-slash.spec.ts tests/e2e/chat-devices.spec.ts tests/e2e/coordinator-words.spec.ts --workers=1"`
Expected: PASS. Also check that `out/main/index.js` keeps `import("@anthropic-ai/claude-agent-sdk/bridge")` as an import (not bundled): `npx --no -- node -e "process.exit(require('fs').readFileSync('out/main/index.js','utf8').includes('claude-agent-sdk/bridge')?0:1)"` exits 0.

- [ ] **Step 7: Leave the work uncommitted**

Suggested message: `feat: chat tabs reach claude.ai through Remote Control, hosted by ClaudeTerm`.

---

### Task 13: Accounts end to end

**Files:**
- Test: `tests/e2e/remote-control-accounts.spec.ts` (new)

**Interfaces:**
- Consumes: everything above; `launchAccounts`, `loginEntry`, `tokenEntry`, `signedIn`, `trust`, `runs`, `WORK`, `CI_BOT`, `CI_TOKEN` (`tests/e2e/account-helpers.ts`, `tests/fixtures/accounts.ts`); the RC helpers.
- Produces: nothing new.

- [ ] **Step 1: Write the tests**

(`workAccount(root)`: the folder `<root>/accounts/work`, `signedIn(folder)`, `trust(folder, join(root, 'work'))`, `[loginEntry(WORK, 'Work', folder)]`, as in `accounts-launch.spec.ts:17`. The stand-in's token in a folder is `fake-credential-never-shown-0001-<folder name>`.)

```ts
test('a chat tab on an extra sign-in account attaches with that account’s own credentials, not the main ones', async () => {
  const t = await launchAccounts({ view: 'chat', accounts: workAccount, env: { ...RC_CLEAN_ENV, CLAUDETERM_TEST_BRIDGE: FAKE_BRIDGE } })
  try {
    const tabId = await openRcTab(t.page, t.work, WORK)
    await chatReady(t.page)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), tabId)
    await expect.poll(async () => (await bridgeSeen(t.app)).calls[0], { timeout: 20_000 }).toMatchObject({ fn: 'create', token: 'fake-credential-never-shown-0001-work' })
  } finally {
    await t.app.close()
  }
})

test('a token account’s tab is unavailable with its reason, and its switch is disabled', async () => {
  const t = await launchAccounts({ view: 'terminal', accounts: [tokenEntry(CI_BOT, 'CI bot', CI_TOKEN)], env: RC_CLEAN_ENV })
  try {
    await openRcTab(t.page, t.work, CI_BOT)
    const seg = t.page.locator('#statusbar .status-remote')
    await expect(seg).toHaveAttribute('data-dot', 'unavailable')
    await expect(seg).toHaveAttribute('title', 'This account signs in with a token: Remote Control needs a claude.ai sign-in')
    await seg.click()
    await expect(t.page.locator('.remote-popover input.switch')).toBeDisabled()
    await expect(t.page.locator('.remote-popover .remote-account input')).toBeDisabled()
  } finally {
    await t.app.close()
  }
})

test('a sign-in from the environment makes the main account’s tab unavailable with the same reason', async () => {
  const t = await launchAccounts({ view: 'terminal', env: { ...RC_CLEAN_ENV, ANTHROPIC_API_KEY: 'e2e-fake-api-key-0001' } })
  try {
    await openRcTab(t.page, t.work)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'unavailable')
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('title', 'This account signs in with a token: Remote Control needs a claude.ai sign-in')
  } finally {
    await t.app.close()
  }
})

test('the checkbox on a sign-in account’s tab keeps its flag in accounts.json, and that account’s next tab starts with --rc', async () => {
  const t = await launchAccounts({ view: 'terminal', accounts: workAccount, env: RC_CLEAN_ENV })
  try {
    const tabId = await openRcTab(t.page, t.work, WORK)
    await t.page.evaluate((id) => window.ct.remoteControlAccount(id, true), tabId)
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'accounts.json'), 'utf8')).accounts[0].remoteControl).toBe(true)
    // the main account's flag stays off
    expect(JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).not.toBe(true)
    await openRcTab(t.page, t.work, WORK)
    await expect.poll(() => runs(t.log).filter((r) => r.config?.endsWith('work') && r.argv.includes('--rc')).length, { timeout: 20_000 }).toBe(1)
  } finally {
    await t.app.close()
  }
})
```

(`WORK` and `CI_BOT` are the account ids of `tests/fixtures/accounts.ts`; `workAccount` is a copy of the one in `accounts-launch.spec.ts:17`, which is local to that file.)

- [ ] **Step 2: Run them**

Run: `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run build && node scripts/e2e.mjs tests/e2e/remote-control-accounts.spec.ts --workers=1"`
Expected: PASS. A failure is a bug in Tasks 3-12: fix it there, with a test at the level that missed it.

- [ ] **Step 3: Leave the work uncommitted**

Suggested message: `test: Remote Control on extra accounts, token accounts and sign-ins from the environment`.

---

### Task 14: README

**Files:**
- Modify: `README.md` (CRLF): the status bar section (:60-76) and "Good to know" (:334-339)
- Maybe: `docs/images/*.png` (only images that changed)

**Interfaces:**
- Consumes: the feature as built.
- Produces: nothing for code.

- [ ] **Step 1: Add the feature line**

In `### 📊 A status bar that answers "how much is left?"`, after the first paragraph:

> **Remote** at the start of the status bar says whether you can continue the tab's session from your phone or claude.ai/code (Claude Code's Remote Control), and is green, with a radio mark on the tab, while it is connected. Click it to turn Remote Control on or off for the tab, open the session on claude.ai or copy its link, and tick **Connect every new session of this account** to start every new Claude tab of that account with it.

- [ ] **Step 2: Add the note**

In `### Good to know`, a bullet:

> - **Remote Control** needs a claude.ai sign-in: a token account, an API key, Bedrock, Vertex, Foundry or a custom `ANTHROPIC_BASE_URL` cannot use it, and the Remote segment says why. In a terminal tab it is Claude Code's own: ClaudeTerm types `/remote-control` for you, and starts the account's new tabs with `--rc`. In a chat tab ClaudeTerm connects the session to claude.ai itself, with that account's Claude Code sign-in, which it only reads: while Remote Control is on, the chat — your messages, Claude's answers, tool results and file contents — goes to claude.ai, and prompts and permission answers can come from there.

- [ ] **Step 3: Regenerate the README images**

The segment now shows on every Claude tab's status bar, so `status-bar.png` and the chat images change. Run `node D:/Workspace/ClaudeTerm/.claude/worktrees/feat-redesign-look/.superpowers/shared-lock.cjs "npm run screenshots"`. Keep only the images whose change comes from the Remote segment (`git status docs/images`, then look at each); restore any other changed image with `git checkout -- <file>`. Do not run `npm run gifs` (it needs ffmpeg); report that the README GIFs will show the segment once regenerated.

- [ ] **Step 4: Check**

Run: `npm run typecheck` and `npx vitest run`.
Expected: PASS (nothing in the README is code; this is the whole suite once before the branch review).

- [ ] **Step 5: Leave the work uncommitted**

Suggested message: `docs: Remote Control in the README`.
