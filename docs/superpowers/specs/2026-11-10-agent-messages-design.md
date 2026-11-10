# Agent messages across devices — design

Date: 2026-11-10. Status: draft for the user's review.
Code references are to `origin/master` at 05e185f (0.16.2).

## Why

The user works on a Windows PC and a Mac, paired as ClaudeTerm devices. Agents in Claude tabs normally talk to each
other with Claude Code's own `ListAgents` / `SendMessage`. Across machines that needs Remote Control in both sessions
and the same Claude account in both. In the user's project both sessions do run on the same Claude account, but it is
the main login on one machine and an extra ClaudeTerm account on the other. An extra account is a `claude setup-token`
token passed in `CLAUDE_CODE_OAUTH_TOKEN` (`src/main/accounts.ts:92`, design of 2026-10-14), and a token session cannot
use Remote Control. So the agent on the Mac cannot find the agent on the PC, and the user has to carry questions
between them by hand.

What the user wants: the agent on one machine writes to the agent on the other, gets answers, and they settle the
matter between themselves without the user.

## What the user decided

- **ClaudeTerm carries the messages over its own device links.** Claude accounts and Remote Control play no part.
- **Only as a fallback.** Agents use Claude Code's own `ListAgents` / `SendMessage` by default. ClaudeTerm's tools are
  for an agent those do not reach.
- **Messages are kept in a decentralized store shared by the devices** ("децентрализованное хранилище где одна сессия
  будет писать сообщение, другая смотреть его"): one session writes a message, the other reads it. *(That it is a
  store of its own beside the stars and notes, built the same way, is Claude's call; see "Messages in a shared store".)*
- **Addressing works like `ListAgents`:** a list of agents with a name as the address. Each row adds what ClaudeTerm
  knows and `ListAgents` does not show: the device, folder, branch, conversation title, and whether the tab is busy.
- **No Claude Code channels and no typing into the receiving tab's terminal.** A custom channel needs
  `--dangerously-load-development-channels`, which shows a full-screen warning at every start of Claude Code (checked in
  Claude Code 2.1.322: the answer is not remembered, and a channel cannot be added to a running session).
- **The user mostly does not care what the agents write**, but wants to be able to read the messages, with a quiet
  visual mark when something new arrives: no sound, no pop-up.
- **Layout: option A of the mockups.** A side panel like Changes and Media, opened by an envelope button with a counter;
  an envelope mark on tabs, in the top tab bar and in the left panel alike, and on a folded device chip.
- **Proposed by Claude and accepted by the user** ("делай" in reply to the playback): a message to a device that is
  off waits and is delivered when it connects; a message to a closed tab is refused at once; replies form a thread;
  messages are kept 30 days; a received message is marked as coming from another agent, not from the user; both
  settings are on by default; the AGENTS.md rule on the hook script is amended for the mail watcher.

## Background

### Claude Code

- **`asyncRewake` hooks** ([hooks reference](https://code.claude.com/docs/en/hooks.md), "Run hooks in the background"):
  a command hook with `"asyncRewake": true` runs in the background and "wakes the model on exit code 2". The hook's
  stderr (or stdout when stderr is empty) is shown to Claude as a system reminder. "An `asyncRewake` hook that exits
  with code 2 wakes Claude immediately even when the session is idle." Claude Code enforces `timeout` on such a hook
  (a positive number of seconds; no upper limit in the schema of 2.1.322).
- ClaudeTerm already gives every Claude tab its hooks through `--settings` (`src/main/claude-tab-settings.ts:56-101`,
  `profiles.ts:195-196`).
- `additionalContext` and similar hook text is capped at 10,000 characters before Claude Code moves it to a file.
- Claude Code's `ListAgents` names a session after its folder plus a number (`survivalkingdom-33`) or after its
  `/rename` title, with a short ref (`[3be5d1]`), its kind and `idle` / `busy`. It shows no folder, branch or task.

### ClaudeTerm

- **Shared data** (`src/main/sync/replica.ts`, `views.ts`, `device-group.ts`, `wire.ts`): collections `admitted`,
  `removed`, `members`, `stars`, `notes` (`replica.ts:6-8`). Every key is a UUID (`replica.ts:223`, `views.ts:77`,
  `wire.ts:259`). Each write carries a dot `[device, seq]` and a hybrid clock stamp. Concurrent writes stay as siblings
  until a later write that saw them replaces them; a view function picks the value to show (`views.ts`). A device that
  was off catches up with `sync` / `since(seen)` in bulk batches, and changes are relayed to the other links
  (`device-group.ts:411-478`). There is no delete and no pruning; a deletion is a written value (`views.ts:85-88`).
  Limits are listed in `wire.ts:11-28`.
- **Compatibility trap:** an older peer's `parseUpdate` returns null for an unknown collection, which makes the whole
  `records` message malformed and **closes the link** (`wire.ts:188-193, 240-262`). An unknown part-2 message type is
  dropped instead (`wire.ts:224`, `remote-wire.ts:129-130`).
- **Calls to one device:** `{t:'call'}` / `{t:'reply'}` over the peer link, with a 10 s timeout, a method name pattern
  and typed, checked arguments (`calls.ts:37-186`, `remote-shapes.ts`). An unknown method is refused as `unknown call`.
- **Remote tabs:** each device sends the others its tabs as `RemoteTab` (`src/shared/remote.ts:8-45`): `id`, `kind`,
  `cwd`, `folder`, `customTitle`, `title`, `claudeSessionId`, `account`, `exited`, `working`, `place.branch`, and more.
  A viewer keeps the tabs of connected devices only (`tab-viewer.ts:46-75, 213-244`). A device's name and online state
  come from `RemoteDeviceView` (`remote.ts:47-52`), its colour from `deviceColor(id)` (`remote.ts:133-137`).
- **Hook script** (`src/hook/main.ts`, `session-hook.ts`): Electron run as Node on `resources/hook/session-hook.js`.
  It talks to the app over the named pipe / Unix socket, one JSON line out and one line back (`pipe-client.ts:6-36`),
  with a 2 s timeout per message (`hook/main.ts:24-28`). It knows its tab from `CLAUDETERM_TAB_ID` / `CLAUDETERM_PIPE`
  (`tab-manager.ts:493`). It never prints and always exits 0, and **both command wrappers force `exit 0`**
  (`claude-tab-settings.ts:7-10, 41-44, 106-110`). Every hook has `timeout: 10`. Pipe messages are validated in
  `parsePipeMessage` (`protocol.ts:220-339`). Any local process can write to the pipe (AGENTS.md).
- **MCP server `claudeterm`** (`src/mcp/show-image-server.ts`): registered for the user with
  `claude mcp add --scope user` (`mcp-registrar.ts:106-118`), so tabs on extra accounts, which share the main
  configuration, have it too. Tools reach the app with `sendPipeMessage` and know their tab from `CLAUDETERM_TAB_ID`.
  It sets no `instructions`. `device_status` already lists the devices and their tabs (`sync/device-status.ts`).
  `permissions.allow` in the tab settings pre-approves `set_task_list` and `get_task_list`.
- **A `peer` attention case exists** for a turn started by another session's `SendMessage`, detected from the
  transcript's `origin.kind === 'peer'`; every channel (sound and the rest) is off for it by default
  (`transcript-edits.ts:118-128`, `turn-origins.ts`, `settings.ts:30`).
- **Renderer:** `SidePanel` shows one of `images`, `changes`, `docs` (`side-panel.ts:3-8`); `TabHeader` builds the
  panel buttons with their `.badge` (`tab-header.ts:27-117`, `badge.ts`); `tabParts` builds the note, muted, bell and
  images marks for the top bar and the left panel alike (`tab-row.ts:46-98`); the folded device chip shows a count,
  a spinner and an attention dot (`tabbar.ts:113-138`, `tab-panel.ts:213-224`). A boolean setting is a `SettingKey`
  with a default, a parser and a `checkboxField` (`settings-keys.ts`, `settings.ts`, `settings-page.ts`).
- **Tests:** `tests/e2e/device-pair.ts` starts and pairs two apps; `tests/integration/session-hook.int.test.ts` runs
  the built hook script against a real pipe server; `tests/integration/mcp.int.test.ts` drives the MCP server over
  stdio.

## Goals

1. An agent in a Claude tab can find the agents in Claude tabs on every connected device, this one included, and send
   one of them a message, whatever Claude account either tab runs on. On a device that was never paired it still works
   between the tabs of that device. *(Claude's call: a store of its own makes this free.)*
2. The receiving agent gets the message without anyone typing: while it works, and also while it sits idle waiting
   for the user.
3. The receiving agent can answer, and the answers reach the sender the same way, so the two can go back and forth.
4. The user can read every conversation in a side panel, and sees quietly which tabs have messages they have not read.

## Non-goals

- Replacing or changing Claude Code's `SendMessage`. Where it works, it stays the way agents talk.
- Claude Code channels, Remote Control, or anything that depends on the Claude account.
- The user writing to agents from the panel: the panel only shows messages. *(Claude's call.)*
- Messages to several agents at once, or to shell tabs.
- Devices that are not paired; the mobile app.

## Anti-goals (a failure even if it technically works)

- An agent's message reaching another agent as if the user had typed it.
- Noise: a sound, a toast, an OS notification or a pulsing tab because agents talked.
- A link to a device running an older ClaudeTerm closing because this one sends something it does not know.
- Agents using ClaudeTerm's tools when `SendMessage` would have reached the other agent.
- A receiving agent that stays asleep until the user comes back: that defeats the purpose.

## What the user sees

UI strings are English.

### The agents' side

The `claudeterm` MCP server gets two tools *(names: Claude's call)*:

- **`list_agents`** — the agents this tab can message: the Claude tabs (not exited, with a known Claude session) on
  this device and on every connected device that accepts agent messages, without the caller's own tab. One row each:

  ```
  api-server · Desktop [3be5d1] · idle · D:\Work\api-server · feat/revenue-units · "Add a unit field to /v2/revenue"
  acme-dashboard · MacBook [c5df49] · busy · /Users/sam/acme-dashboard · main · "Plot monthly revenue"
  ```

  The name is `<label> · <device>`: the label is the tab's own title when the user renamed it, else the folder's last
  part; two agents with the same name on one device get ` #2`, ` #3` in tab order. The ref is the first six hex
  digits of the tab's **Claude session id**, so it stays the same when either app restarts and restores the tab.
  Then `idle` / `busy`, the folder, the git branch when known, and the conversation title when known. A device that is
  connected but does not accept agent messages is listed in one line at the end
  (`MacBook: does not accept agent messages`), and so is a tab whose Claude Code is too old to be woken
  (`api-server · Desktop: Claude Code 2.1.200 can't receive messages; 2.1.287 or later can`), so the agent knows why
  someone is missing. *(Format: Claude's call.)*
- **`message_agent`** `{ to, text, reply_to? }` — `to` is a name or a ref from `list_agents`, or the sender of a
  message being answered. The reply is one line:
  - `Delivered to api-server · Desktop.` — the receiving device has the message and a tab runs that conversation; it
    reaches the agent at once if the agent is idle, else at its next step;
  - `Waiting: MacBook is not connected; the message goes out when it connects.`;
  - errors: `No agent named "…"; call list_agents.`, `api-server · Desktop is closed.`,
    `MacBook does not accept agent messages.`, `Agent messages are turned off in ClaudeTerm on this device.`,
    `A message is at most 8000 characters.`

The server's MCP `instructions` and both tool descriptions say *(wording: Claude's call)*: use Claude Code's
`ListAgents` / `SendMessage` first; use these tools only for an agent `ListAgents` does not show (another device or
another Claude account); answer a ClaudeTerm message with `message_agent`, passing its `reply_to`.

A received message reaches the agent as text like this *(Claude's call)*:

```
Message from another agent, not from the user, through ClaudeTerm:
from: acme-dashboard · MacBook [c5df49] (folder /Users/sam/acme-dashboard, branch main)
id: 1b0e…  (reply with mcp__claudeterm__message_agent, to: "c5df49", reply_to: "1b0e…")

Does /v2/revenue return cents or thousands? The chart looks 100× too big.
```

Several messages waiting at once come together, oldest first. The text says plainly that it is another agent's
request: the agent weighs it like a colleague's, acts within its own permissions and may decline.

### The panel (option A)

- **A Messages button** with an envelope icon joins the panel buttons of the tab bar (in the mockup it sits after
  Media). Its badge counts the unread messages in the active tab's conversations, like the Media and Changes badges
  (`formatBadge`: none at 0, `99+` above 99). The button is there while agent messages are on.
- **The Agent messages panel** is a side panel like Changes and Media, one of them shown at a time, with its own width.
  Its header has the title `Agent messages` and a switch `This tab | All`:
  - **This tab:** the conversations of the active tab, newest first;
  - **All:** every conversation this device knows of, newest first.
  - A conversation is the messages between two Claude conversations (two session ids), so it survives restarts and
    restores. It has a header `acme-dashboard · MacBook ⇄ api-server` (the active tab without its device), then the
    messages oldest first: the sender's name in its device's colour, the device, the time, and the text as plain text
    with its line breaks. Unread messages have an accent bar on the left and a faint accent tint. A message still
    waiting for delivery says `waiting` beside its time.
  - Empty: `No messages yet. Agents write here only when Claude Code's own messaging can't reach each other.`
- **Read:** a message counts as read once it has been shown in the open panel while the window has focus. The read
  mark is shared data, so reading on one device clears the mark on the others. *(Claude's call.)*
- **Marks:** a tab with unread messages carries an envelope mark after its title, among the note, muted, bell and
  images marks, in the top bar and in the left panel. A folded device chip in the top bar, and a device header in the
  left panel, carry the envelope when one of their tabs does.
- **No sound, no toast, no OS notification, no pulse** — ever, for messages. A turn that a message started ends like a
  turn started by `SendMessage`: it falls in the existing `peer` attention case, whose channels are off by default.

### Settings

A section **Agent messages** after Devices, on each device (settings are not shared):

- **Let agents message tabs that Claude Code's own messaging can't reach** (on by default). Help:
  `Agents use SendMessage first. ClaudeTerm carries a message only to a tab SendMessage doesn't list: another device,
  another account.` Off: the tools answer that messages are off, this device's tabs get no mail watcher at their next
  start, other devices see it as not accepting messages, and the Messages button is hidden.
- **Mark tabs that got messages you haven't read** (on by default). Help: `An envelope on the tab and a counter; no
  sound, no pop-up.` Off: no envelope marks and no badge; messages still flow and the panel still shows them.

## How it works

### Messages in a shared store

*(Claude's call, after the builder check: a store of its own, not a sixth collection in the stars-and-notes replica.)*
All collections of that replica share one sequence-number space, and a receiver takes on the sender's whole `seen`
vector (`device-group.ts`, `applyRecords` → `absorbSeen(m.done.seen)`). Holding `messages` records back from an older
peer would still mark them seen there, and once that peer upgraded, or passed its `seen` on to a third device, the
messages would never arrive. A store of its own avoids that and also works on a device that was never paired.

- **The store** *(Claude's call while planning: simpler than a copy of `replica.ts`, whose five collections are baked
  into its types, its validator and its file name)*: a grow-only set of messages in `agent-messages.json` in the data
  folder. A message never changes after it is written except for two flags, `delivered` and `read`, which only go from
  false to true; merging two copies keeps the first text and ORs the flags. So no sequence numbers, clocks or `seen`
  vectors are needed, and the trap above cannot happen. The store exists and works locally whether or not the device
  group runs, and leaving or re-pairing the group does not touch it.
- **Sync:** over the device links by new part-2 message types, which older peers drop without closing the link
  (`wire.ts:224`, `remote-wire.ts:129-130`): `mail-accept` (whether the device takes messages for its tabs now, and
  whether its Claude Code can be woken), `mail-have` (a digest: every shareable message id with its flags) and
  `mail-records` (the messages the other side lacks or holds with fewer flags, in bulk batches). On link up each side
  sends `mail-accept` and its digest and answers the other's digest; a message written or flagged later goes to every
  mail link at once, and a message that came from one link is relayed to the others. A device announces mail support
  with `mail: 1` in `hello`; `parseHello` keeps only the fields it knows, so an older peer ignores it. A device without
  it gets no mail traffic and is listed as not accepting agent messages.
- **A record:** `{ v: 1, id, from, to, replyTo, text, sentAt, delivered, read }`, where `id` is a message UUID, `from` /
  `to` are `{ device, session, name }` (device id, Claude session id, the name at sending time), `replyTo` a message
  UUID or null, `text` 1–8000 characters, `sentAt` the sender's clock in ms. On a device that was never paired there is
  no device id: its messages carry `device: null` and never leave it. Every field is checked; a record that fails is
  ignored.
- **Retention:** messages whose `sentAt` is older than 30 days are dropped from the local store at start and once a
  day, and a peer's copy that old is not taken in, so a dropped message does not come back. A message still waiting
  when it is dropped is simply gone.

### Addressing *(Claude's call, after the builder check)*

- An agent is a Claude conversation on a device: **device id + Claude session id**. Tab ids are not used as addresses,
  because every tab gets a new id at each launch (`tab-manager.ts:96`, `index.ts:1202-1206`).
- Delivery goes to whichever tab on that device runs that session. A conversation reopened in a tab (Restore previous
  session, Restart session, Continue as, Recent sessions) keeps its address. If Claude Code gives a resumed
  conversation a new session id, main maps the id it asked to resume to the one `SessionStart` reports, so the address
  still leads there.
- `/clear` and a fork start a new session id: the old address then leads nowhere, and the sender learns it when it
  next writes (`… is closed`) and calls `list_agents` again.

### Sending

1. `message_agent` sends a pipe message `agent_send` `{ tabId, to, text, replyTo }` (validated in `parsePipeMessage`).
2. Main checks the caller is a Claude tab and the feature is on, and resolves `to`: first against the current agent
   list (name or ref), then against the `from` / `to` of the caller's recent messages, so an agent can answer one on a
   device that has gone offline. *(Claude's call.)*
3. Target device connected (or this device) and a tab there runs that session, or the target device offline → main
   writes the record (`delivered: false`) and answers `Delivered` / `Waiting`. Target device connected but no tab runs
   that session → `… is closed`, nothing written. Target device not accepting → the error, nothing written.
4. The record replicates: at once to connected devices, at catch-up to the others.
5. A record that reaches its device by catch-up while no tab runs that session stays waiting: it is delivered if the
   user reopens that conversation, and otherwise goes with the 30-day retention. The panel shows it as `waiting`; the
   sender is not told.

### Receiving: the mail watcher

- The tab settings file gets one more hook entry for `SessionStart` and one for `Stop`:
  `{ "type": "command", "command": "<the hook command> --mail", "asyncRewake": true, "timeout": 86400 }`. The command
  wrappers for these entries must **not** force `exit 0`, or Claude Code never sees the code 2. *(The one-day timeout:
  Claude's call; see the checks by hand.)*
- The watcher reads the hook input (session id), opens the pipe and sends `mail_wait` `{ tabId, sessionId }`, then waits
  for the reply with no 2 s limit. Main holds the request:
  - mail for this tab not yet delivered → main answers with it; the watcher writes the text above to **stderr** and
    exits **2**; Claude Code wakes the model with it; main marks those records `delivered`;
  - a newer watcher for the same tab connects → the older one is answered `superseded` and exits 0 silently;
  - messages turned off, the tab closed, or the app quits → the watcher exits 0 silently, at once;
  - the pipe cannot be opened → exits 0 at once.
- The pipe server queues messages per socket, so a held `mail_wait` blocks only its own connection.
- **Only for a Claude Code that knows `asyncRewake`.** An older one would run the entry as an ordinary blocking hook,
  and `SessionStart` would hang for up to the timeout, or it might reject the settings file and lose every ClaudeTerm
  hook. So main finds the version of the Claude command (`<claude.command> --version`, once per command line, cached,
  with a time limit so the main process never blocks) and writes the mail entries only for 2.1.287 or later, the first
  version where the builder found `asyncRewake` (`claude-tab-settings.ts:39` already notes a minimum for the exec form).
  A version that cannot be read counts as too old. Such tabs are listed as unable to receive, as above. *(Claude's
  call.)* Tabs with different Claude commands may then need settings files of their own; that is the builder's.
- A watcher armed at `SessionStart` covers a fresh or resumed session; one armed at each `Stop` covers the next idle
  wait. Mail that arrives while no watcher is connected (between a wake and the next `Stop`) waits for the next one.
- Mail that arrives while the agent works is handed to the watcher armed at the last `Stop`; Claude Code is expected
  to show it at the next step. There is deliberately no `PostToolUse` hook: it would start a process for every tool
  call.
- When main hands mail to a watcher, it remembers that the tab's next turn is a mail turn, so that turn's end falls in
  the `peer` attention case (no sound by default), like a `SendMessage` turn.
- A Claude session started before this change has no watcher until it restarts. That is fine.

### The AGENTS.md rule

"The hook script never prints to stdout … always exits with code 0" becomes: it never prints to stdout and exits 0,
except the mail watcher, which, only when it hands mail to Claude Code, writes the mail to stderr and exits 2. The
existing tests that assert an empty stdout stay.

### MCP server

- `list_agents` and `message_agent` in `src/mcp`, with `instructions` on the server; both go to main over the pipe with
  `CLAUDETERM_TAB_ID`, like the other tools.
- `permissions.allow` in the tab settings gains `mcp__claudeterm__list_agents` and `mcp__claudeterm__message_agent`, so
  an agent is not stopped by a permission prompt while the user is away.

### Renderer and IPC

- `SidePanel` gets a `messages` panel; `TabHeader` a Messages button with a badge; `tabParts` an envelope mark from a
  new `TabBarItem` field; the chip and the left panel's device header get the mark from their tabs.
- Every device has all messages, so the marks of remote tabs are computed locally; `RemoteTab` does not change.
- IPC *(names: the builder's)*: list the conversations (of a tab, or all), mark messages read, and an event when the
  messages change. Main checks every argument (`ipc-guards.ts`).
- The two settings follow the boolean setting pattern.

### Security

- Only paired devices can send records (TLS links between known keys). On one device, any local process can write to
  the pipe, as for every hook message today: ClaudeTerm does not defend against a process already running as the user.
- Everything from the pipe and from other devices is validated; text is shown as text, never as HTML.
- The wake text names the sender and says it is not the user.

## Testing

No test starts the real `claude`; e2e tests stand in for the MCP server and the hook with pipe messages, as today.

- **Unit:** the agent list and its names (labels, ` #2`, refs from session ids, the lines for a device that does not
  accept and for a too old Claude Code); resolving `to` (name, ref, recent sender, unknown); the address of a resumed
  conversation, also when Claude Code reports a new session id; the record check and the sibling merge (`delivered`,
  `read`); pruning by age; the wake text; the watcher hub (hold, answer, supersede, off, no tab runs the session) with
  fake dependencies; the settings parse; the version parse and the minimum; the tab settings file holding the two
  `asyncRewake` entries with a timeout and without the forced `exit 0` for 2.1.287 and later, and none below.
- **Integration:**
  - the built hook script in `--mail` mode against a real pipe server: it waits; with mail it prints nothing to stdout,
    writes the text to stderr and exits 2; superseded or off → exits 0; no pipe → exits 0 quickly (Windows exec form
    and the Unix wrapper both);
  - the MCP server over stdio lists the two new tools and passes their calls and answers through;
  - two message stores over real device links: a message written on one reaches the other, also after the other was
    offline; a peer that does not announce support keeps its link and gets no mail traffic, and once it announces
    support it receives what was written meanwhile; a pruned record is not sent back; the stars and notes replica is
    untouched by mail.
- **End-to-end** (two paired apps, `device-pair.ts`):
  - a message from a tab on Studio to a tab on Laptop: `Delivered`; a waiting watcher on Laptop gets it; both panels
    show the conversation; the reply comes back the same way and threads;
  - the badge, the tab marks and the folded chip's mark appear; opening the panel on one app clears them on both;
  - marks off hides marks and badge but not the panel; messages off on Laptop → Studio gets `does not accept`, the
    button is hidden on Laptop;
  - a closed tab → `is closed`; Laptop not running → `Waiting`, delivered once it is relaunched and has restored the
    tab; the conversation and the marks are the same after both apps restart;
  - two tabs of one app that was never paired message each other;
  - a mail turn's end plays no sound and leaves no attention by default;
  - the stand-in `claude` answers `--version`: an old version gets no mail entries and its tab is listed as unable to
    receive.
- **By hand, on real Claude Code, before release** (Windows and macOS, a main-account tab and a token-account tab):
  an idle session wakes on a message; a busy session gets it at its next step; what the terminal shows for the wake;
  what Claude Code shows when the one-day timeout ends the watcher, and whether the next `Stop` arms a new one; a reply
  goes back without the user.

## Docs

- README: a short **Agent messages** part under Devices: what it is for (agents on another device or account), that
  `SendMessage` comes first, the panel and the settings.
- AGENTS.md: the hook rule above.
- CHANGELOG at release; a new feature bumps the middle number.

## Left to the builder

The tool and IPC names where marked, the record shape within the rules above, how support is announced to peers, the
button's exact place among the panel buttons, the icons, and the wording of help texts and tool descriptions.
