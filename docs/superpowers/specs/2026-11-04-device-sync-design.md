# Device sync, part 1: a group of devices with shared stars and notes — design

Date: 2026-11-04
Status: approved by the user

## Why

The user works on several computers — Windows and macOS today, Linux possibly — and wants ClaudeTerm on all of them
to be one workspace: a tab opened on one computer appears on the others and can be used from there, and the user's
own data (starred sessions, session notes, later more) is the same everywhere, changed from any of them. A mobile app
is planned later; it is not part of this work.

This is split in two:

1. **Part 1 (this document): the group of devices.** Devices pair with each other, keep a connection, and keep a
   shared copy of the user's data — the starred sessions and the session notes — merged both ways.
2. **Part 2 (a later design): remote tabs.** Every device sees the tabs of every other device in one list and can
   type into them, read their output, open new ones on any device. Part 2 runs over the connection part 1 builds.

The user decided:

- **No server, no relay, nothing to pay for.** Devices connect directly over a network the user set up themselves: a
  home or office network, Tailscale, ZeroTier, a VPN. ClaudeTerm only needs the other device's address. Asking the user
  to set up that network is acceptable.
- **No mobile app for now.**
- **Two-way, between two or more devices.** Any device can change anything; the changes reach every other device.
- **A tab runs on one device only** (part 2): the others show it and control it. A conversation never moves between
  machines in this work; Claude Code's transcripts stay where they are.

What the user approved as the shape of part 1 (with "do it as you recommend"):

- ClaudeTerm's own encrypted connection on its own port, not SSH. *(Claude's recommendation: SSH would need an SSH
  server on every device that is connected to, which on Windows is the OpenSSH Server feature installed with
  administrator rights; without it there is no two-way connection with a Windows machine.)*
- Pairing once with a one-time code; after that the devices know each other's keys and accept only each other.
- A device paired with one member of the group becomes known to all members, so no pair has to be paired by hand.
- Every device keeps a full copy of the shared data; a change goes to every connected device at once; a device that
  was off catches up when it connects.
- Each record carries the time it changed; a deletion is kept as a mark; the latest change wins.
- Stars and notes first; which settings are shared is decided later.
- Addresses are typed in by hand (a Tailscale name like `macbook`, or an IP address); finding devices on the local
  network by themselves may come later.

## Background: what exists today

- Stars: `src/main/starred-sessions.ts` — a set of Claude session ids in `starred-sessions.json` in the data folder.
  `IPC.sessionsStar` / `IPC.sessionsStarred` in `src/main/index.ts`; the Recent sessions window
  (`src/renderer/recent-sessions.ts`) asks for the list when it opens and toggles a star with `setSessionStarred`.
- Notes: `src/main/session-notes.ts` — `session-notes.json`, session id → `Note` (`text`, `shown`, `form`;
  `src/shared/note.ts`), saved with a 500 ms debounce; a file that cannot be read is moved aside, never written over.
  `src/main/note-hub.ts` gives each Claude tab the note of its conversation and numbers the notes it gives
  (`generation`), so text typed against an older note goes where that note lives.
- Secrets: `src/main/accounts.ts` keeps account tokens with `electronVault` (Electron's `safeStorage`: DPAPI, Keychain,
  keyring; on Linux without a keyring, unencrypted in a file only the user can read, and the UI says so).
- Settings: `settings.json`, the Settings window (`src/renderer/settings-page.ts`); the Accounts section
  (`src/renderer/accounts-section.ts`) is a list with an add form and is the pattern for a list section.
- Tests: e2e tests start the app with their own data folder and pipe name (`tests/e2e/helpers.ts`, `launchApp`).

## Goals

- In **Settings → Devices** the user pairs this device with another one in under a minute: one device shows a code,
  the other is given the address and the code.
- Two, three or more devices form one group. Any member can add a device; it becomes known to all.
- Starring or unstarring a session, and changing a session's note, on one device shows on every connected device
  within about a second. A device that was off or unreachable gets every change it missed when it connects to any
  member.
- Any combination of Windows, macOS and Linux.
- No account, no server, no cost.
- With no other device paired, ClaudeTerm behaves exactly as today and opens no network port.

## Non-goals

- Remote tabs, remote Recent sessions, remote panels — part 2.
- The mobile app.
- Moving or copying conversations (transcripts) between machines.
- Shared settings — later, once it is decided which settings make sense on every machine (shell profiles, for one,
  differ between Windows and macOS).
- Reaching a device across the internet without a network the user set up: no NAT traversal, no relay, no discovery
  service.
- Finding devices on the local network by themselves (later, maybe).

## Anti-goals — it fails even if it works when

- **Anyone but a paired device gets in.** The port is the first network-facing surface of ClaudeTerm, and in part 2
  the same connection will type into terminals. A process on the network that is not a paired member must not read
  anything, change anything, or join the group, and someone who watches or sits in the middle of the pairing must not
  be able to pair instead of the user's device.
- **A deleted thing comes back.** An unstarred session, a removed note or a removed device must not reappear because
  an older copy arrives from a device that was off.
- **Two devices end up showing different data** after they have exchanged everything.
- **The window or the hook pipe stalls** because a device is slow, unreachable or sends a lot.
- **The single-machine app changes**: existing stars and notes are kept on upgrade, and a user who never pairs a
  device sees no difference.

## Constraints

From `AGENTS.md`: strict TypeScript, no renderer framework, the renderer reaches the system only through `window.ct`
and every IPC argument is checked in main (`ipc-guards.ts`); every UI string is English; everything that comes from the
network is untrusted — validate it and degrade gracefully; the main process must not block; every behavior has tests at
the right level, e2e tests never touch the real machine; CI must pass on Windows, macOS and Linux. Nothing is written
into Claude Code's folders.

## What the user sees

### Settings → Devices

A new section **Devices**, after Accounts.

- **This device**: its name (the computer's host name until the user changes it; the name is how the other devices
  show it) and the addresses other devices can reach it at (its network interfaces' addresses, the Tailscale one among
  them when Tailscale runs).
- **The list of devices in the group**, one row each: name, system (Windows / macOS / Linux), state —
  `Connected`, `Not reachable at <address>` (tried and failed), or `Offline since <time>` (was connected and went away)
  — who added it and when (`Added by <name>, <date>`), the address this device uses for it (editable: a machine's
  address can change) and **Remove**.
- **Add a device** shows a code and this device's addresses, with how long the code stays valid, and **Cancel**. The
  code is 16 characters in four groups, e.g. `K7QM-2XPD-9TRA-W4BN`, valid for 5 minutes, good for one pairing. The
  section says to enter it on the other device together with one of the addresses.
- **Join a device**: an address field (`macbook`, `192.168.1.20`, optionally with `:port`), a code field and
  **Join**. Errors show under the form: the address does not answer; the code is wrong or has expired; the other device
  is not showing a code.
- When pairing succeeds, the other device appears in the list on both, and then the rest of the group appears too.

*(Claude's call)* Joining while this device is already in a group with other devices merges the two groups: every
member of each becomes known to every member of the other. A group is simply "every device I trust".

**Remove** asks for confirmation, then removes the device from the group on every member: they disconnect from it
and no longer accept it. Removal is final for that device: nothing it or anyone else writes later brings it back. To
bring the machine back, pair it again; it then gets a new device id and a new key. *(Claude's call, from the review.)*

What Remove protects against *(the user's decision)*: both retiring a computer and cutting off a lost or stolen
one. A removed device is cut off as soon as the members hear of the removal. Anything it did before that stays — a
device it added remains a member — and the user finds such a device by its `Added by` line and removes it too. There
is no signing of individual records and no automatic removal of what a removed device added: a member is trusted as
a whole while it is a member, the way an SSH key on a laptop is.

A removed device learns it: the member that refuses its connection first sends it a "you were removed" message, and
the removed device then shows `Removed from the group by <name>` and forgets that group's members — so it does not
keep retrying them, and they do not come along if it later joins another device. It keeps its own copy of the stars
and notes. *(Claude's call.)*

**Leave the group** (on this device's own row) needs at least one member connected, so that the others hear of it;
otherwise the button is disabled and says why — and says that a computer that is gone for good is removed from
another device instead. *(Claude's call.)*

### Stars and notes

Nothing new to learn: the star in the Recent sessions window and the note on a Claude tab work as today, and their
changes appear on the other devices.

- An open Recent sessions window updates its stars when a change arrives from another device, without being reopened.
- A Claude tab showing a session whose note changes on another device shows the new note: its text, and whether it is
  hidden, a label or a card. *(Claude's call: the note is one thing — text and how it is shown travel together, as the
  user wants everything synced.)* Text the user typed in this tab in the moment before the change arrived is not lost;
  how that is achieved is the builder's, using the note numbering `NoteHub` already has.
- A star or note for a session that does not exist on this machine (a conversation that lives on the Mac) is kept and
  passed on, invisible here. *(This is where part 1 alone shows little: the Recent sessions window lists only this
  machine's conversations, and Claude conversations are per machine. Stars and notes of another machine's sessions
  become visible with part 2.)*

## How it works

### Device identity

Each installation creates, once, a device id (a UUID) and a key pair with a self-signed certificate. The device's
identity for the others is the fingerprint (SHA-256) of its public key. The private key is stored like account
tokens: with `electronVault`, and on Linux without a keyring in a file only the user can read, with the same notice in
the Devices section as Accounts shows.

### The connection

- The device listens on a fixed default port (the builder picks one that is not commonly used), changeable in
  `settings.json`, on all interfaces — so that both the local network and Tailscale reach it.
- It listens **only while it has at least one other member or a pairing code is shown**. Otherwise no port is open.
- All traffic is TLS 1.3 from Node's `tls` module with **both sides presenting their certificates**; each side checks
  the other's fingerprint against the members it knows and closes the connection otherwise. The only exception is
  pairing (below), which is allowed only while a code is shown. *(Correction to what was said in the chat: Node's
  `tls` has no way to create a certificate, so a small, maintained library for creating the self-signed certificate is
  expected — the builder's choice. No home-made cryptography.)*
- Each pair of online members keeps one connection, opened by whichever side reaches the other first; both sides
  try. So a connection between two devices works as long as **one of them** can accept connections. When both
  happen to connect at once, one connection is kept by a fixed rule (e.g. the one opened by the lower device id).
- **Accepting connections needs the system's permission once.** On Windows, the first time ClaudeTerm listens,
  Windows Defender Firewall asks to allow it, and allowing needs an administrator (the installer is per user and
  cannot add a firewall rule). On macOS, with the firewall on, the system asks to allow incoming connections, and
  since the app has only an ad-hoc signature it may ask again after an update; macOS 15 and later may also ask for
  Local Network access. *(Claude's call: one administrator approval is acceptable — installing Tailscale on Windows
  needs one too — and a device that cannot accept still connects out.)* The Devices section says when this device
  cannot be reached by the others (how it finds out is the builder's: e.g. a member reports that it failed to reach
  this device's addresses), and that pairing works by showing the code on the other device.
- A member that cannot be reached is retried with a growing pause (seconds at first, about a minute at most), and at
  once when the computer wakes up (`powerMonitor`) or its network changes.
- A connection that stops answering is noticed within a minute (pings) and closed.
- Messages are framed, typed JSON with a size limit; the first message is a hello with the protocol version. A
  malformed or oversized message closes the connection; an unknown message type is ignored (a newer device may send
  more). Nothing from the network reaches a shell or the hook pipe in part 1.
- **Room for part 2**: the framing must let part 2 add request/response calls and continuous streams (terminal output)
  on the same connection without small messages waiting behind large ones. Part 1 does not build them.
- Network work never blocks the main process; a slow peer is limited by buffers and timeouts, not waited for.

### Pairing

Device A shows the code; device B is given A's address and the code. Either device can be A, so when one of them
cannot accept connections, the user shows the code on the other one.

1. B connects to A over TLS. During pairing neither side knows the other's certificate yet, so both accept it for now
   and read its fingerprint.
2. Each side proves it knows the code, bound to both fingerprints: it sends `HMAC-SHA256(key = code, role ‖ fpA ‖ fpB)`
   and checks the other's. A man in the middle presents its own certificate, so the fingerprints the two sides see do
   not match the ones it would need, and it cannot compute a proof without the code. The code has 80 bits (16
   Crockford base32 characters, case and dashes ignored), so recording the exchange and guessing the code afterwards is
   out of reach, and the code is good for one pairing and five minutes only. After five wrong proofs the code is
   cancelled. *(Claude's call; the builder may use an established PAKE such as SPAKE2 or CPace from a maintained
   library instead, which would allow a shorter code — but not a home-made scheme.)*
3. Both sides store each other as members: id, name, system, fingerprint, the addresses the device reports for itself
   plus the address B used.
4. A then tells B the whole group and B tells A its group (the membership records below), and every member learns of
   the new device through the normal exchange.

### The shared data

The shared data is a set of records in collections:

| Collection | Key | Value |
|---|---|---|
| `members` | device id | name, system, fingerprint, addresses, port, added by (device id) and when — or removed |
| `stars` | Claude session id | starred or not |
| `notes` | Claude session id | the `Note` — or removed |

Every record carries:

- **when** it was last written: a hybrid logical clock (wall time, raised to the largest time seen from other devices,
  plus a counter), so that a change made after seeing another device's change always wins even if the clocks differ;
- **who** wrote it (device id) and that write's sequence number on its device.

**Merge rule:** the record with the later clock wins; equal clocks are settled by the device id. A deletion is a
record like any other (an unstar is "starred: false", a removed note is "removed") and is kept, so it wins over older
copies. Every device ends in the same state once it has seen the same writes, in whatever order they arrived.

A device whose clock runs far ahead does not make later changes lose: once its record is seen, every device's clock
moves past it, so a change made after that still wins.

**Members are the exception to latest-wins:** a removed member stays removed whatever arrives later (see Remove), and
a device's fingerprint never changes once it is a member.

**Exchange:** each device remembers, for every device that ever wrote, the highest sequence number it has applied
from that device. When two devices connect they swap these numbers and each sends the records the other has not seen
— including records it got from third devices, so a device that only ever reaches one member still gets everything.
While connected, a local change is sent to every connected member at once, and a change received from one member is
passed on to the others that do not have it yet. Stars and notes a device wrote before it was removed are kept and
passed on like any other data, so every member ends with the same data.

**Concurrent edits of one note** *(the user's decision: both texts are kept)*. Notes do not use plain latest-wins:

- Each note write records which version of the note it was made on.
- A write made on the version a device has replaces it (one edit after another).
- Two writes made on the same earlier version, neither knowing the other (two devices changed the note while apart),
  are **joined**: the later write's text, an empty line, then the other write's text — the way `NoteHub` already joins
  a note typed before the tab had a conversation. Whether it is shown, and as a label or a card, comes from the later
  write. When one of the texts is empty, or both are the same, the result is just the other text.
- Every device ends with the same joined note, whatever order the writes arrive in, and seeing the same writes again
  does not join them again.
- Text typed in a tab a moment before another device's change arrived is a concurrent edit too and is joined by the
  same rule — one rule for both cases.

How versions are recorded (for example a version vector per note) is the builder's. Removal of a note is a write like
the others: a removal concurrent with an edit keeps the edited text. *(Claude's call: a lost text is worse than a note
the user has to delete again.)*

**Storage:** the records and the exchange bookkeeping live in ClaudeTerm's data folder, written atomically the way the
notes file is, with the same rule that a file that cannot be read is moved aside and never written over. On the first
start of the new version, the existing `starred-sessions.json` and `session-notes.json` become records written by this
device. The file layout is the builder's.

**Inside the app:** `StarredSessions` and `SessionNotes` keep their roles towards the rest of main (`ids()`, `set`,
`get`), and gain a way to tell their users that a record changed from outside — the Recent sessions window and
`NoteHub` listen to it.

## Testing

- **Unit** (`tests/unit`): the merge rule — later wins, equal clocks, deletions win over older copies, a device whose
  clock is an hour ahead or behind, same final state for every order of arrival; the exchange bookkeeping — what is sent
  after which numbers, catch-up through a third device; membership — adding, merging two groups, removal and records
  from a removed device, a removed device staying removed whatever arrives later, `added by`; the joining of
  concurrent note writes — one after another replaces, concurrent ones are joined in the same way on every device in
  every order, a repeated write does not join twice, an empty or equal text, a removal concurrent with an edit; the
  pairing proof — a right code, a wrong code, an expired or used code, a proof bound to other fingerprints; message
  checks — malformed, oversized, unknown type, wrong protocol version.
- **Integration** (`tests/integration`): two and three device instances in one test, each with its own temp data folder,
  over real TLS on `127.0.0.1` with ports the system picks: pairing and its failures; a connection from a certificate
  that is not a member is closed; a star and a note change arrive live; a device that was stopped catches up when
  started; a change reaches C through B when C cannot reach A; removal, and the removed device being told and
  forgetting the group; a note changed on two stopped devices and joined when they connect; reconnect after the other
  side restarts; migration of existing `starred-sessions.json` and `session-notes.json`; no port is open without
  members or a code, nor while the setting is off.
- **End-to-end** (`tests/e2e`): two app instances, each with its own data folder, pipe name and `CLAUDE_CONFIG_DIR`,
  bound to `127.0.0.1` only (a test-only setting, so no firewall prompt and nothing leaves the machine): pair them
  through the Settings window of each; star a session in the Recent sessions window of one (a transcript with the same
  session id is written into both config folders) and see it starred in the other's open window; change the note of a
  Claude tab in one and see it in the other's tab on the same session; remove a device and see it disappear on the
  other, and the removed one show that it was removed; with the setting off, the Devices section is not there.

No test uses the real network beyond the loopback address, the real data folder or a real `claude`.

## Left to the builder

- The library that creates the self-signed certificate, and the exact TLS options.
- The default port, the framing, the message names, the protocol version scheme.
- Retry and ping timings, buffer limits, the duplicate-connection rule.
- The file layout of the records and the bookkeeping, and the migration details.
- How `NoteHub` keeps text typed against a note that was just replaced from another device.
- The exact layout and wording of the Devices section and its error messages.

## Release

*(The user's decision: everything goes out together.)* Part 1 is merged into `master` but stays off: a setting in
`settings.json` (e.g. `devices.enabled`, default `false`, not shown in the Settings window) turns it on. While it is
off, the Devices section is hidden, no port is opened and the stored data files are the ones of today. The tests turn it
on. It is not in `CHANGELOG.md` and not in the README until part 2 ships with it; then the setting is removed or turned
on by default, as part 2's design decides.

Until that release the record format and the protocol may change freely: nothing needs to stay compatible with a
pre-release build.

## Notes for part 2

- **MCP tools for devices** *(the user agreed, 2026-11-04: with part 2, not now)*. Read only: `device_status` (devices,
  their states, the port problem, whether the others can reach this device — never codes or keys) so that Claude can
  diagnose a connection, and `open_device_settings` to bring up the Devices section. **No pairing, joining or removing
  through MCP:** text injected into a conversation could make Claude join a stranger's group, the pipe the MCP server
  uses accepts any local process, and the code would pass through the conversation. In part 2 `device_status` also
  covers the remote tabs.

## Decided after the review

1. Remove protects against both a retired and a lost or stolen computer, as described under Remove: final removal,
   `Added by` in the list, no per-record signatures.
2. The same note changed on two devices while apart keeps both texts, joined.
3. Part 1 is released together with part 2, hidden behind a setting until then.
