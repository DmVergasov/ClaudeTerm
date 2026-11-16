# Remote Control in Claude tabs: design

Date: 2026-11-16. Status: written for approval.

## Intent

The person wants to continue a Claude session from the phone or from claude.ai/code, and to see, per session, whether
that is possible right now. Claude Code calls this Remote Control (RC). Today ClaudeTerm shows nothing about it, and
turning it on means knowing the `/remote-control` command. RC is not available at all in a chat-view tab, which is the
default view.

The feature does three things. A status-bar segment shows the RC state of the tab in front. A switch turns RC on or off
for that tab. An account-wide checkbox starts every new Claude tab of that account with RC on. It must work the same in
terminal tabs and in chat tabs, on the main account and on the extra accounts.

The person approved the look (the mockup of 2026-11-16, described under "What the person sees") and the approach (both
tab kinds; ClaudeTerm itself hosts RC for chat tabs).

## Goals

- A `Remote` segment in the status bar of every local Claude tab, terminal or chat, with five states: off,
  connecting, connected, unavailable, failed.
- Clicking the segment opens a popover with:
  - the switch;
  - a status line;
  - "Open on claude.ai" and "Copy link" while connected;
  - the checkbox "Connect every new session of this account".
- A small green RC glyph after the title of every connected tab, in the tab bar and in the side tab panel.
- Terminal tabs use Claude Code's own RC.
- Chat tabs get RC through ClaudeTerm. ClaudeTerm becomes the RC host for the chat session, as the Claude desktop app
  does.
- Extra accounts work like the main one. A tab uses its own account's sign-in. An account that cannot use RC shows
  "unavailable" with the reason.

## Non-goals

- Tabs of a paired device, shown in this window: no segment, no glyph (v1). Their device shows its own.
- `claude remote-control` server mode, and RC for shell tabs.
- A QR code. Claude Code's own panel shows one in a terminal tab. claude.ai and the phone app list the session anyway.
- A view-only mirror mode. RC here means full control, as `claude --rc` gives.
- Setting `remoteControlAtStartup` in Claude Code's settings files. ClaudeTerm starts its tabs with `--rc` instead, so
  sessions outside ClaudeTerm are not affected.
- Changing the model, the permission mode or the session's title from claude.ai in a chat tab (v1). The bridge then
  answers those requests with "not supported".

## Anti-goals (a failure even if everything else works)

- **ClaudeTerm writes, refreshes or deletes Claude Code's credentials.** Refreshing a token rotates it and signs Claude
  Code out. ClaudeTerm only reads.
- **A token or a device token appears in a log, an error text, a toast, a settings file, a crash report, a test
  fixture or the pipe.**
- **A chat session's transcript goes to claude.ai without the person turning RC on.** That means the switch for the
  tab, or the account checkbox they ticked.
- **A chat session starts slower, or fails, because RC could not connect.** RC failing leaves the chat exactly as it is
  with RC off.
- **ClaudeTerm patches Claude Code, or impersonates it.** No device enrolment of its own, and no private endpoints
  beyond what the Agent SDK's bridge module calls.

## Facts this design rests on (checked on 2026-11-16 with Claude Code 2.1.323 and the Agent SDK 0.3.322)

- **The bridge session id reaches the hook and the statusLine.** While a terminal session is connected, Claude Code
  sets `CLAUDE_CODE_BRIDGE_SESSION_ID` (e.g. `session_011edt…`) in the environment of hooks and of the statusLine
  command.
  - After a disconnect, the next statusLine run lacks it, and Claude Code runs the statusLine at once on a disconnect.
  - On a connect the statusLine is not re-run, so the id shows at the next run: a message, or ClaudeTerm's
    `refreshInterval`, 5 s by default.
- **The session's link is `https://claude.ai/code/<that id>`.** The same URL is in the transcript's
  `remote_session_change` attachment.
- **`/remote-control <name>` connects in about 2 s.**
  - On an account's first use, Claude Code first shows a one-time "Enable Remote Control / Never mind" dialog in the
    terminal.
  - Typed again, `/remote-control` opens a panel with the menu "Disconnect this session / Show QR code / Continue",
    with the cursor on Continue.
- **`claude --rc <name>` starts a session connected** within about 2 s.
- **In an Agent SDK session, RC is refused.**
  - `/remote-control` answers "/remote-control isn't available in this environment."; the CLI refuses it for headless
    hosts.
  - The `--rc` flag is ignored.
- **The SDK ships `@anthropic-ai/claude-agent-sdk/bridge` (alpha).**
  - The calls are `createCodeSession` (POST /v1/code/sessions), `fetchRemoteCredentials` (a worker JWT, and the
    `X-Trusted-Device-Token` header) and `attachBridgeSession`. The handle has `write`, `sendResult`,
    `sendControlRequest`, `sendControlResponse`, `sendControlCancelRequest`, `reportState`, `reconnectTransport`,
    `flush` and `close`. Its callbacks are `onInboundMessage`, `onPermissionResponse`, `onInterrupt` and `onClose`,
    among others.
  - Its typings say breaking changes do not bump the major version.
- **The Claude desktop app hosts RC for its SDK sessions with this module.** It uses its own claude.ai login and enrols
  itself as a trusted device.
- **claude-terminal (github.com/Sterll/claude-terminal) does the same for its chat tabs.** Its approach:
  - it reads Claude Code's stored OAuth access token, read-only and never refreshed, unused once expired;
  - it reads the trusted-device token that Claude Code stores when it first runs RC itself;
  - it feature-detects the bridge exports.

  Its code is GPL-3.0. ClaudeTerm is MIT, so we take the approach only, never its code.
- **The server refuses RC for some sign-ins.** It needs a claude.ai subscription sign-in. A `claude setup-token` token
  (`CLAUDE_CODE_OAUTH_TOKEN`), an API key, Bedrock, Vertex, Foundry and a non-default `ANTHROPIC_BASE_URL` are not
  supported.
- **Bridge sessions are of an elevated security tier.** When the organisation enforces it, the server answers
  `untrusted_device` without a device token.

## Approaches considered

1. **Chosen.**
   - Terminal tabs use Claude Code's RC. State comes from the env var, through the hook and the statusLine. ClaudeTerm
     types `/remote-control …` to turn RC on, and `--rc` starts new tabs connected.
   - Chat tabs are hosted by ClaudeTerm through the SDK bridge, reading Claude Code's own credentials for the tab's
     account.
   - It costs a sizeable bridge host for chat tabs, and an alpha dependency.
2. **Terminal tabs only.** A chat tab's switch moves the tab to terminal view and turns RC on there. It is much
   smaller, but RC never works in the default view. The person rejected it once claude-terminal showed chat tabs can
   have it.
3. **Read "/rc active" off the terminal screen.** It is immediate, but it breaks with any UI change. It also goes
   against ClaudeTerm's rule of learning only from hooks, the statusLine and transcripts. Dropped.

Turning RC off in a terminal tab was settled with the person: the switch opens Claude Code's own panel, and the person
picks "Disconnect this session" there. ClaudeTerm does not drive the menu by keys.

## What the person sees

### The segment

- **Place.** It sits in the status bar's start zone, right after the account segment, with a separator between them.
  It shows the radio glyph (13 px, the icons' 24-grid, 1.75 stroke, round caps), a 7 px dot, and the word "Remote", in
  the 12 px text of the other segments.
- **The five states:**

  | State | Dot | Text | Title (tooltip) |
  |---|---|---|---|
  | off | hollow grey ring (text-3), text at 0.7 opacity | Remote | Remote Control is off: click to turn it on |
  | connecting | amber | Remote | Remote Control is connecting… |
  | connected | green | Remote | Remote Control is on: this session is on claude.ai and in the Claude app |
  | unavailable | slashed ring, text-4 | Remote | the reason, e.g. "This account signs in with a token: Remote Control needs a claude.ai sign-in" |
  | failed | red | Remote | the reason, e.g. "Remote Control did not connect: sign in to this account again" |

- **Where it shows.** On every local Claude tab, terminal or chat. It is hidden for shell tabs and for a paired
  device's tabs.

### The popover (click on the segment)

- **Look.** It copies the tasks popover: raised background, 1 px line-2 border, 12 px radius, the menu shadow, 340 px
  wide. It opens 4 px above the bar, left-aligned to the segment. Esc and a click outside close it, as the tasks
  popover does.
- **The first row.** "Remote Control" in bold, with the switch (the settings window's `input.switch`) on the right.
- **The status line under it.**
  - **Off:** "Off · turn it on to reach this session from your phone".
  - **Connecting:** "Connecting…".
  - **Connected:** "Connected · continue this session in the Claude app or on claude.ai", followed by two buttons:
    "Open on claude.ai" (opens the link in the browser) and "Copy link".
  - **Unavailable:** the reason, with the switch disabled.
  - **Failed:** the reason, with the switch off and enabled (on retries).
  - **Off in a terminal tab whose prompt is not empty:** the line adds "· waits for an empty prompt" while ClaudeTerm
    waits to type.
- **A chat tab adds a note under the status line:** "ClaudeTerm sends this chat to claude.ai while it is on: messages,
  tool results, file contents. Prompts and permission answers can come from there."
- **Below a separator:** the checkbox "Connect every new session of this account", with the note "New Claude tabs of
  <account name> start with Remote Control on". It is disabled and dimmed when RC is unavailable for the account.

### The tab glyph

A connected tab shows the radio glyph in green after its title, and only then. It goes after the images mark and
before the attention mark, which must stay last; that is the rule in `tab-row.ts`. Its title is "Remote Control is on".

## How it works

### One state per tab, owned by main

Main keeps one RC state per local Claude tab and sends it to the window with the tab's status:

```
type RemoteState =
  | { kind: 'off' }
  | { kind: 'connecting' }
  | { kind: 'on'; url: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }
```

- **Where it lives.** `StatusUpdate` gains `remote: RemoteState | null`, which is null for a tab without the segment.
  The renderer draws the segment, the popover and the glyph from it.
- **The window's IPC.** The window asks main to turn RC on or off for a tab, and to set the account flag. Each call
  goes through `ipc-guards.ts`.
- **Shared code.** A new folder, `src/main/remote-control/`, holds the parts that both tab kinds share: the state, the
  account rules and the link.

### Which accounts can use RC

The tab's account decides, in this order:

1. **Token accounts are unavailable.** For an extra account of kind `token` (a pasted `claude setup-token`), the reason
   is "This account signs in with a token: Remote Control needs a claude.ai sign-in".
   The same holds, for both tab kinds, for an account whose sign-in comes from the tab's environment rather than a
   claude.ai login: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, or
   `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY`. This applies to the main account too.
   Otherwise a chat on one sign-in could be hosted under another claude.ai login found in the folder's credentials.
2. **A non-default `ANTHROPIC_BASE_URL` makes RC unavailable**, whether it is in the tab's environment or in the
   account's. The reason is "Remote Control needs Anthropic's own service: this account uses ANTHROPIC_BASE_URL".
3. **Chat tabs only.** If no claude.ai sign-in is found in the account's credential store (next section), RC is
   unavailable: "No claude.ai sign-in found for this account". A terminal tab leaves that check to Claude Code, which
   shows its own failure. ClaudeTerm then falls back to off when no id comes (see "Terminal tabs").
4. **Otherwise RC is available.** That covers the main account (the default folder or `CLAUDE_CONFIG_DIR`) and every
   extra account of kind `login` (its own `CLAUDE_CONFIG_DIR` folder).

### The tab's choice outlives its process

A tab's Claude Code process is replaced often:
- the person switches the view, or the view setting changes for every open tab (`ViewFollow`);
- the terminal handoff moves a chat to its terminal (`/config` and the like);
- a chat that cannot start falls back to the terminal;
- the tab switches account, is restarted, or is restored when ClaudeTerm starts.

RC is therefore a choice of the tab, kept by main, and not a fact read only from the running process.

- **Main keeps a `remote: boolean` per tab.**
  - It is set by the switch, and by the account flag when the tab starts.
  - It is cleared by the switch, and by a terminal tab's report that RC went off while ClaudeTerm had not asked for
    it (the person chose Disconnect, or typed `/remote-control` themselves).
  - A terminal tab that reports an RC id without ClaudeTerm asking also sets it: the person typed `/remote-control`.
- **It is saved with the tab** in the session store, so a restored tab comes back with it.
- **When the tab's process is replaced, main applies the choice to the new one:**
  - in a terminal tab, through `--rc <name>` at launch;
  - in a chat tab, by attaching the bridge when the session is ready.
- **What the switch is for.** The person turned RC on for the tab, not for one process. RC sends the conversation to
  claude.ai in both views, so the consent holds across a view switch.
- **An account switch keeps the choice.** It applies under the new account when RC is available there, and shows
  "unavailable" otherwise.
- **The link changes when the process does.** Claude Code's own RC session (`session_…`) and ClaudeTerm's chat-tab
  session (`cse_…`) are different sessions on claude.ai. The phone shows the new one, and the old one ends.

### Terminal tabs

**State, from Claude Code.**
- The hook script adds `remote: string | null` to its `status`, `session`, `turn` and `attention` messages. The value
  is `process.env.CLAUDE_CODE_BRIDGE_SESSION_ID` when it matches `^[A-Za-z0-9_-]{1,128}$`, and null otherwise.
- `parsePipeMessage` validates the field again, since the pipe is untrusted.
- StatusHub keeps the last value per tab: the statusLine's when it runs, a hook's otherwise.
- The tab is `on` with `url = https://claude.ai/code/<id>` while the value is an id, and `off` when it is null.
  ClaudeTerm's statusLine refresh (5 s by default) bounds how long a connect takes to show.

**Turning it on.**
- Main types `/remote-control <name>` with the typing half of the existing terminal handoff (`openInTerminal`). It
  waits up to 30 s for an empty prompt, then types the line and Enter as keys.
- `openInTerminal` itself stops when the tab is already in terminal view (`setView` answers false for an unchanged
  view). The builder splits out the part that waits and types, and both callers use it.
- `<name>` is the tab's title, cut to 60 characters, with control characters removed.
- The state is `connecting` from the click until an id arrives. Two things end it early:
  - after 30 s, the state goes back to `off` with a toast: "Remote Control did not connect in <tab>: see the terminal".
    The person may still be answering Claude Code's one-time confirmation there.
  - if the handoff gives up on the prompt, its own toast says so.

**Turning it off.**
- Main types `/remote-control` with the same handoff. Claude Code opens its panel, and the person chooses "Disconnect
  this session".
- The state stays `on` until a report without an id. The popover says "Choose Disconnect this session in the
  terminal".

**New tabs.**
- When the tab's account flag is on, `buildClaudeCommandLine` adds `--rc <name>` (quoted with `quoteForShell`).
- This applies to every Claude tab ClaudeTerm starts for that account in terminal view: new, restored or resumed.
- The flag of the main account is `Settings.claude.remoteControl` (default false). An extra login account keeps a
  `remoteControl` flag in its `accounts.json` record (default false). A token account has none.

### Chat tabs: ClaudeTerm hosts RC

ClaudeTerm becomes the RC host of the chat session, through the SDK's bridge module. This is how the desktop app hosts
RC for its own SDK sessions.

**Loading the bridge.**
- Main imports `@anthropic-ai/claude-agent-sdk/bridge` lazily, once, and checks that `createCodeSession`,
  `fetchRemoteCredentials`, `attachBridgeSession`, `isCredentialsFailure`, `isCredentialsRejection` and
  `isCreateSessionFailure` are functions.
- If any is missing or the import fails, chat tabs are unavailable: "This ClaudeTerm cannot host Remote Control: the
  Agent SDK's bridge changed". The missing names go to the log.
- The module path is resolved the way `loadSdk` resolves the SDK, including the packaged app's `app.asar.unpacked`.

**Turning it on.**
The click, or a session start when the account flag is on, runs these steps:
1. Read the account's credentials (next section). With no usable access token, the state is `failed`: "Sign in to
   this account again (claude auth login)".
2. **One claude.ai session per conversation, as the desktop app keeps it.** In its code, Desktop stores the remote id
   of each local session and probes it before creating a new one (`getOutboundCCRRemoteId`, `probeRemoteSession`).
   ClaudeTerm keeps `{ remoteId, sequenceNum }` per Claude session id, in a small store of its own under the app's
   data folder. It is not part of the settings, and it holds no token. An entry is kept for 30 days after its last
   use.
   - **There is an entry:** go on with step 3 using its `remoteId`, and pass `initialSequenceNum` in step 4, so the
     server resumes the stream instead of repeating it.
   - **There is none, or step 3 answers that the session is gone (404 or `invalid_session_id`):** call
     `createCodeSession(apiBase, accessToken, title, 20 s, …, cwd, model)`. This gives a `cse_*` id, which is then
     stored.
     - `apiBase` is the API base Claude Code uses, `https://api.anthropic.com` unless overridden.
     - Pass the git context when the tab's folder is a repository: the remote URL, the branch and the default branch,
       read through `execGit`.
3. Call `fetchRemoteCredentials(id, apiBase, accessToken, 20 s, trustedDeviceToken)`. This gives the worker JWT, the
   API base and the epoch.
4. Call `attachBridgeSession({ sessionId, ingressToken, apiBaseUrl, epoch, initialSequenceNum, claudeCodeVersion,
   onInboundMessage, onPermissionResponse, onInterrupt, onClose })`. Store `getSequenceNum()` again when the bridge
   closes, and every minute while it is on.
5. **A new remote session only:** write the conversation so far to the handle as SDK messages, so claude.ai shows it
   from the start, as the CLI's `/remote-control` carries the history over. The source is the builder's choice: the
   chat model's messages or the session's transcript. A re-attached session already has its history and gets only
   what came after.
6. The state goes from `connecting` to `on`. The link is the one claude.ai uses for this session; the builder confirms
   whether that is the `cse_` id or a `session_` form of it, from the desktop app's behaviour or a live test.

**While it is on.**
- **Outbound.** Every SDK message the chat's `query()` yields is written to the handle. This happens at
  `sdk-engine.ts`'s message loop or `ChatHub.apply`, the builder's choice. Each turn's result also calls `sendResult()`.
  `reportState` is `running` at a turn's start, `requires_action` while a permission card is open, and `idle` at a
  turn's end.
- **Inbound messages.** A message typed on claude.ai (`onInboundMessage`) is sent into the chat with `ChatHub.send`,
  with a new origin `'remote'`. The chat shows it as the person's message, with a small "from claude.ai" mark.
- **Permissions.**
  - When the chat opens a permission card, the same request goes out with `sendControlRequest` (`can_use_tool`, with
    the card's request id).
  - The first answer wins, from the window or from claude.ai (`onPermissionResponse`). A response that does not match
    an open card is rejected (return `false`).
  - An answer given in the window, or a card closed by an interrupt, calls `sendControlCancelRequest`, so the phone
    drops its prompt.
- **Interrupts.** `onInterrupt` runs `ChatHub.interrupt`.
- **Requests v1 does not take.** Model, thinking, permission-mode, rename and task requests are not handled. Their
  callbacks are left out, so the bridge answers "not supported".

**Turning it off, and the process going away.**
- **Off.** The switch runs `flush()` with a 2 s limit, then `close()`, and the state goes to `off`.
- **The tab closes, or its chat process is replaced** (a view switch, a restart, an account switch): the same flush
  and close. The tab's choice stays as "The tab's choice outlives its process" says, and the new process takes it up.
- **The conversation changes inside the tab** (`/clear`, a resume; the session id changes): close the bridge and
  attach for the new conversation, re-attaching to its remote session when it has one.

**Errors.**
- **The transport closes on 401 or 4094** (the worker JWT expired, about every 4 h). Read the credentials again, call
  `fetchRemoteCredentials` again, then `reconnectTransport`.
- **The stored access token has expired.** An idle Claude Code may not renew its token, since it renews it when it
  calls the API. So an expired token is not a failure.
  - The state shows `connecting`, with the title and the popover line "Waiting for Claude Code to renew this account's
    sign-in".
  - ClaudeTerm reads the store again every 60 s, for as long as the tab is open and its choice is on, and goes on
    once the token is fresh.
  - The builder looks for a call on the running `Query` that makes Claude Code check its sign-in, and so renew it, such
    as `accountInfo()`. If one exists, it is made once before waiting.
  - A message the person sends in the window renews the token too, through Claude Code's own API call.
- **Other closes:**
  - On 4090, use a fresh `/bridge` epoch.
  - On 403 or 404, go to `failed` with a reason.
- **Retries.** Retry with backoff (2 s, 5 s, 15 s, 60 s), then go to `failed`.
- **Refusals map to reasons:**

  | Refusal | Reason shown |
  |---|---|
  | `untrusted_device` | "Turn Remote Control on once in a terminal tab of this account: Claude Code registers this computer then" |
  | `session_stale_relogin` | "Sign in to this account again (claude auth login)" |
  | `oauth_rejected` | the same as `session_stale_relogin` |
  | `request_rejected` | "claude.ai refused Remote Control (<status>)" |
  | network and timeouts | "claude.ai could not be reached" |

  The handoff's message must never contain a token.

**The main process must not block.** Every call is async with its time limit, and the reads of the credential store
are async.

### Reading Claude Code's credentials

Claude Code's credentials are read only, at attach and at reconnect, into memory, and dropped after use. They are never
cached across attaches and never written. A small module, `claude-credentials.ts`, takes the account's config folder
and returns `{ accessToken: string | null; deviceToken: string | null }`:

**Where the access token comes from.**
- **Windows and Linux:** `<folder>/.credentials.json`, `claudeAiOauth.accessToken`. An `expiresAt` in the past means
  null. ClaudeTerm never refreshes it: the chat session's own Claude Code process refreshes it as it runs.
- **macOS:** the login Keychain, through `security find-generic-password -s <service> -a <user> -w`, run with
  `execFile` (no shell, a 5 s limit).
  - The service is `Claude Code-credentials` for the default folder.
  - For any other folder, Claude Code adds a suffix derived from the folder (claude-terminal reports
    `-<first 8 hex of sha256(NFC(folder))>`). The builder checks this against the real Claude Code before relying on
    it.
  - If the Keychain read fails, fall back to `<folder>/.credentials.json`.

**Where the device token comes from.** In this order:
1. `CLAUDE_TRUSTED_DEVICE_TOKEN` in the tab's environment;
2. `trustedDeviceToken` in the same credential record;
3. `trustedDeviceToken` in the account's `.claude.json`. For the default folder that is `~/.claude.json`; for a
   `CLAUDE_CONFIG_DIR` folder, the builder checks where Claude Code keeps it.

No device token is normal. The header is then left out, and only a server that enforces the tier refuses
(`untrusted_device`).

**Which folder.**
- The main account uses `CLAUDE_CONFIG_DIR` from ClaudeTerm's own environment, or `~/.claude`.
- A login account uses its folder.
- Folders are compared with `pathKey`.

### The account checkbox

- **What it changes.** The popover's checkbox sets the flag of the tab's account. That is `Settings.claude.remoteControl`
  for the main account, or `remoteControl` on the login account's record.
- **What it affects.** It changes nothing in Claude Code's own settings. It affects tabs started afterwards: terminal
  tabs through `--rc`, and chat tabs, which attach when their session is ready.
- **Tabs already open** keep their state.

## Tests

The tests follow AGENTS.md:
- no test reaches the network, the real `~/.claude`, the real Keychain or real credentials;
- every behaviour is tested through its entry point.

- **Unit tests:**
  - The RC state rules, the account rules, building the link, and cutting the name.
  - The credentials reader against temp folders: a fresh token, an expired one, a missing file, a device token in
    each of the three places. The macOS Keychain path goes through an injected `security` runner.
  - `buildClaudeCommandLine` with `--rc` for each shell family, quoting a title with quotes and spaces.
  - `parsePipeMessage` keeping a valid `remote` and dropping a bad one.
- **The hook.** The bundled hook script run with `CLAUDE_CODE_BRIDGE_SESSION_ID` in its environment sends `remote` in
  both its statusLine and hook messages. This goes in `session-hook.int.test.ts` and the unit tests of
  `status-line` and `session-hook`.
- **The bridge host**, with a fake bridge module injected as a dependency:
  - creation, credentials and attach, in order;
  - the history written first;
  - live messages written;
  - `sendResult` at each turn's end;
  - an inbound message reaching `ChatHub.send` with origin `'remote'`;
  - a permission answered remotely settling the card, and a local answer cancelling the remote one;
  - an interrupt;
  - a 401 close leading to a reconnect with fresh credentials;
  - a second attach for the same conversation re-attaching to the stored remote id with its sequence number, and a
    gone one (404) leading to a new session;
  - an expired stored token showing the waiting state, and going on once the store holds a fresh one;
  - the tab's choice taken up by a new process: chat → terminal launches with `--rc`, and terminal → chat attaches
    when ready;
  - each refusal mapping to its reason;
  - no token in any log line or reason; the test scans everything the fake logger got.
- **e2e, terminal tab:**
  - a `status` pipe message with `remote` makes the segment green and shows the tab glyph; one without it turns both
    off;
  - clicking the switch types `/remote-control <title>` into the stand-in (its log); switching it off types
    `/remote-control`;
  - the checkbox starts the next tab of the account with `--rc <title>` (the stand-in logs its args).
- **e2e, chat tab.** These use a stand-in bridge module that records calls and can inject inbound messages and
  permission answers. It is selected only under `CLAUDETERM_TEST`, like the other test stand-ins.
  - switching RC on shows connecting, then connected, and the link;
  - a message sent in the window reaches the stand-in bridge;
  - an inbound message shows in the chat and reaches the stand-in claude;
  - a permission card answered from the stand-in bridge closes in the window;
  - switching off closes the bridge.
- **e2e, accounts:**
  - a tab on an extra login account reads the stand-in credentials from that account's folder, not the main one;
  - a token account's tab shows "unavailable" with its reason, and its switch is disabled.

## Left to the builder

- Which SDK messages to forward: every message, or every message except partial `stream_event` frames. Check what the
  CLI's own bridge sends, and what claude.ai needs to draw a turn.
- How the history is built at attach: from the chat model or from the transcript.
- The exact link of a chat-tab RC session.
- The Keychain service suffix for non-default folders on macOS, and where a `CLAUDE_CONFIG_DIR` account keeps its
  `.claude.json`.
- File names and splits inside `src/main/remote-control/`, matching the surrounding code.
- The glyph's SVG, from the mockup's description.

## Calls I made (the person may change them)

- RC means full control, never a mirror. That is parity with `claude --rc`.
- The account flag also applies to restored and resumed terminal tabs, not only new ones.
- RC is the tab's choice. It outlives a view switch, a restart, an account switch and a restore.
- A chat tab keeps one claude.ai session per conversation and re-attaches to it, as the desktop app does. `/clear`
  moves RC to the new conversation's own session.
- An expired stored token waits for Claude Code to renew it, rather than failing.
- A sign-in from the environment (`CLAUDE_CODE_OAUTH_TOKEN`, an API key, Bedrock, Vertex, Foundry) makes RC
  unavailable, for the main account too.
- The popover is the only place to set the account flag (no extra row in Settings) in v1.
- Paired devices' tabs show no RC state in v1.
- A message from claude.ai in a chat tab is shown as the person's own, marked "from claude.ai". Once the coordinator's
  person's-words check is in master, it counts like a paired device's Send.
