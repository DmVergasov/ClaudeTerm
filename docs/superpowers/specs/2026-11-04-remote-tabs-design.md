# Device sync, part 2: remote tabs — design

Date: 2026-11-04
Status: approved by the user

## Why

Part 1 (`docs/superpowers/specs/2026-11-04-device-sync-design.md`) builds the group of devices: pairing, the encrypted
connection between members, and shared stars and notes. Part 2 is the reason the user wanted the group.

The user's case, in their words: they start ClaudeTerm on the MacBook and everything is there, synced; then they go on
with all of the work on the Windows computer. Every device shows the tabs of every device. Each tab can be used from any
device: reading it, typing into it, everything around it. Ideally, a session can also be started on another device
from this one, and its folder changed afterwards. A session started remotely may land in that device's default folder,
and the user then wants to move it.

The user decided:

- **One tab bar, with the tabs grouped by device, as Chrome's tab groups do** (mockup option A). This device's tabs
  come first without a label. Each other device follows with a coloured chip with its name and then its tabs. A click
  on the chip folds the group.
- **A tab runs on the device that started it** (decided in part 1). The others show it and control it. A conversation
  never moves between machines.
- **All devices in the group are equal.** Any member may open tabs on any other member, type into them and close them.
  There are no per-device permissions.
- **Everything around a tab works as for a local tab**, coming from the tab's own device. That covers the terminal,
  the image panel, the Changes panel, the note, the status bar, attention and sound.
- **The terminal takes the size of the device where the user last typed into the tab or switched to it.** Elsewhere it
  is shown at that size: cut or with margins.
- **Attention on every device.** When Claude on the MacBook waits for the user, the tab blinks on Windows too. The
  sound or notification comes on every device where ClaudeTerm is open, under each device's own rules.
- **Closing a remote tab closes it on its device.** The process ends, as when the tab is closed locally.
- **Shared and per-device state.** A tab's name is shared. The order of the tabs inside a group, and whether a group
  is folded, are each device's own.
- **Recent sessions** lists the sessions of every device, grouped by device. Opening another device's session resumes
  it there, as a remote tab here.
- **After a restart**, each device restores its own tabs as today. Another device's tabs appear when that device is
  connected.
- **Starting tabs on another device.** The "+" menu lists the same entries as today, once for each device: that
  device's shell profiles and Claude accounts. A new tab starts in that device's default folder.
- **"Change folder…"** on a tab opens a folder browser of the device the tab runs on, with that device's recent
  folders first. A Claude tab restarts in the new folder with a new conversation; the old one stays in Recent
  sessions.
- **The hidden `devices.enabled` setting of part 1 goes away.** The Devices section is always in Settings, and nothing
  happens until the user shows a code or enters one. Both parts ship together in one release, in the changelog and
  the README.
- **MCP:**
  - `device_status` is read-only. It covers the devices, their states, the port problem, whether the others can reach
    this device, and now each device's tabs.
  - `open_device_settings` opens the Devices section.
  - Nothing that pairs, joins, removes, opens tabs or types goes through MCP.
- **No mobile app now.** The protocol must leave room for a device that only views and controls, without tabs of its
  own.
- **Pasting and dropping into a remote tab copy to the tab's device** (decided after the builder check). Two cases are
  copied to the tab's own device and then typed as paths that exist there:
  - a pasted clipboard image;
  - dropped files.

  Pasting screenshots into Claude works as for a local tab.
- **The device stays awake while it is used from another device** (decided after the builder check). This is a
  checkbox in Settings → Devices, on by default.

## Background: what exists today

The full map is in the part 1 branch. These are the facts this design leans on.

**Tabs.**
- `TabManager` (`src/main/tab-manager.ts`) owns every PTY (node-pty, ConPTY on Windows). Output is coalesced for 5 ms
  and sent to the one main window as `evPtyData`. Input comes back as `ptyWrite`, the size as `ptyResize` (one size
  per tab, the last one wins).
- `TabInfo` is `{id, kind, profile, cwd, customTitle, claudeSessionId, account, muted, exited}`. The id is a UUID,
  also given to the child as `CLAUDETERM_TAB_ID`, which hooks and the MCP server use to name their tab.
- `cwd` is fixed when the tab opens. Nothing changes it.

**Where a tab's state lives.**
- Main keeps no copy of a tab's output. Only the renderer's xterm holds the screen and the scrollback.
- The window title a program sets (OSC), bell detection, `promptText` and the unread logic read the renderer's xterm.

**The hubs.** Per tab:
- `ImageHub`: cards. Images are served as `ctimg://<cardId>` from a local path.
- `ReviewHub`: the whole `ReviewUpdate` pushed as `evReview`.
- `StatusHub` and `PlanHub`: `evStatus`, `evPlan`.
- `NoteHub`: `evNote`, keyed by the Claude session id. Notes are already shared by part 1.
- `Attention`: `evAttention`, the flash and the sound, judged by this window's focus and active tab.

**Recent sessions.** `SessionHistory` reads Claude Code's transcripts on this machine. Opening a session runs
`claude --resume <id>` in its folder. Stars are shared by part 1.

**Restore.** Restore lives in `session-state.json` and the "Restore previous session" banner.

**Profiles and accounts** are per device:
- `profilesList` gives names.
- Accounts keep their tokens in the system keyring and never leave the device.

**Part 1.**
- Members keep authenticated TLS 1.3 links (`DeviceNet`, `PeerLink`). Messages are length-prefixed JSON frames of at
  most 16 MiB, with ping/pong and a closed link on anything malformed.
- `DeviceGroup` runs the record exchange.
- Part 1 promised room for part 2: request/response calls and continuous streams on the same connection, without small
  messages waiting behind large ones.

## Goals

- Every connected device's tabs show in this device's tab bar, grouped by device, within about a second of the
  connection, and stay current.
- **A remote tab is used as a local one.**
  - Typing in it echoes no later than one network round trip plus about 10 ms on top of what the program itself takes.
  - Its output, title, bell, attention, images, Changes, note and status bar match its own device.
- **Switching to a remote tab** for the first time shows its screen and its scrollback, up to the scrollback setting
  of its own device, in under a second on a home network or over Tailscale.
- From any device the user can do the following on any connected device:
  - open a shell or Claude tab, with that device's profiles and accounts;
  - close or restart a tab, rename or mute it, star its session;
  - switch its account;
  - change its folder;
  - resume one of its sessions from Recent sessions.
- A device that sleeps or drops off leaves its tabs in place, dimmed. When it comes back, they come back with what
  they printed meanwhile, without a click.
- With no other device in the group, ClaudeTerm behaves exactly as today.
- "Change folder…" works for local tabs too.

## Non-goals

- Relaying a tab through a third device.
  - Tabs are shown only from devices this one has a direct link with.
  - Stars and notes still relay, as in part 1.
- Moving or copying a conversation, a transcript or a tab to another device.
- Opening another device's files in an editor, revealing them in its file manager, or browsing its files beyond
  choosing a folder.
- Sharing settings, shell profiles or accounts between devices.
- Per-device permissions or read-only members.
- Two people working on one tab at the same time. One user, many devices.
- The mobile app.

## Anti-goals — it fails even if it works when

- **Anyone but a paired member reads or types into a tab.** This is part 1's anti-goal, now with a shell behind it.
- **A slow, sleeping or far device makes this one slow.**
  - Local tabs, the window and the hook pipe must never wait on the network.
  - A viewer that cannot keep up must not make its own device buffer output without limit.
- **Typing into a remote tab feels laggy on a normal network.** Input is never queued behind images, diffs or catch-up
  data.
- **A remote tab shows a wrong or garbled screen after a reconnect.** The viewer starts again from a fresh snapshot,
  never from a guess.
- **Something from the network reaches a shell other than as the bytes a member typed into one of its tabs**, or
  reaches the hook pipe or the MCP server. A member may type anything into a tab, and that is the design. It may not,
  for example:
  - make a device read files other than the images and diffs of a tab;
  - list anything but folder names when choosing a folder;
  - write files anywhere but a new folder under the device's ClaudeTerm temp folder;
  - run a command in any other way.

## Constraints

- Everything from part 1 holds:
  - TLS 1.3 with pinned keys;
  - everything from the network is untrusted;
  - validate shapes and values, and drop what fails;
  - never throw out of a socket handler;
  - the main process never blocks on the network;
  - English UI copy;
  - tests never touch the real machine and use only `127.0.0.1`.
- The renderer stays sandboxed. Remote images reach it through `ctimg://` like local ones. The main process fetches
  the bytes from the tab's device.
- Hooks, `statusLine` and the MCP server stay local to the device where Claude runs. Nothing from the network is
  written to the pipe.
- Match the existing code. No UI framework.
- Windows, macOS and Linux, in any combination.

## What the user sees

**Tab bar (option A of the mockup).**
- This device's tabs come first, as today. Then, for each connected or recently seen device in a stable order (by
  name), a chip with the device's name in its colour, followed by its tabs.
  - The colour is picked from a small fixed palette by the device id, so a device has the same colour everywhere.
  - The tabs of a group have a thin line of the group's colour under them.
- Clicking a chip folds or unfolds the group. A folded group shows only the chip and the number of its tabs.
  - A pulsing dot on a folded chip means one of its tabs wants attention.
- The chip's context menu: "New Claude Code tab", "New <profile> tab" for each of the device's profiles,
  "Fold"/"Unfold".
- **A device that is not connected:**
  - its chip is dashed with "· offline", and its tabs are dimmed;
  - its tabs can be switched to, and show the last screen they had, but take no input;
  - they wake up on their own when the device is back;
  - a tab that no longer exists there disappears then.
- **Drag.** Tabs can be dragged inside their group. A tab never moves to another group.

**The "+" menu (▾).** Today's entries come first, under this device's name. Then come the same entries for each
connected device: its profiles, "Claude Code", and one entry per account. "Recent sessions…", restore and settings stay
at the end, once.

**A remote tab** looks and works like a local one. Its tooltip names the device and the folder. The differences:
- Its terminal follows the size rule above. When the size comes from another device, the terminal keeps that size
  here: smaller is shown with margins, larger can be scrolled sideways.
- In the image panel, "Open" and "Reveal in folder" are not offered. "Copy image" and "Copy path" are; the path is a
  path on the other device.
- In the Changes panel, "Open in editor" and "Reveal" are not offered. Viewing, scope, marks, refresh and "Send to
  Claude" work.
- Its tab menu has the same items as a local tab, plus "Change folder…".

**Change folder…** (local and remote tabs). A small dialog titled "Change folder", with "on <device>" when the tab is
remote, shows:
- the current folder in an editable path field;
- "Recent on <device>": the folders of that device's latest sessions;
- the subfolders of the folder in the field, which can be opened one level at a time.

"Open here" closes the dialog:
- a Claude tab starts a new Claude Code conversation in that folder in the same tab;
- a shell tab starts its shell again there. Typing `cd` into a shell that may be running a program is not safe, so the
  shell is restarted instead.

A folder that does not exist or cannot be read gives a message in the dialog.

**Pasting and dropping into a remote tab.**
- Pasting a clipboard image works as it does in a local tab, from the user's point of view. ClaudeTerm sends the
  image to the tab's device, which saves it in its own ClaudeTerm temp folder. The path there is typed into the tab,
  quoted for that device's shell, as ClaudeTerm already does for a pasted image file locally.
- Dropping files does the same for every dropped file.

A paste or drop above the size limit is refused with a toast, and nothing is copied. *(Claude's call: 50 MB in all per
paste or drop.)* While the copy runs, the tab shows nothing new. A toast appears only when it takes longer than a
moment or fails.

**Keeping a device awake.** Settings → Devices has a checkbox: "Keep this computer awake while another device uses it",
on by default. While it is on, the device does not go to sleep on its own while either of these holds:
- another device has typed into one of its tabs in the last 30 minutes;
- one of its Claude tabs that another device has open is working.

The display may still turn off. A closed laptop lid still puts it to sleep, because the system decides that.

**Recent sessions.** This device's sessions come first, as today. Then each connected device's, under its name, with
their stars and notes, which part 1 already shares. Opening one of them resumes it on its own device. If it is already
open there, its tab is activated.

**Settings → Devices.** The section is always there:
- With no group, it shows only "Show code" and "Join".
- In a group, it is part 1's list of devices. Each device line also says how many tabs it has open.

**Attention.** A remote tab's attention (permission, question, done, bell) behaves on this device exactly as a local
tab's does: by this window's focus and active tab, this device's notification settings and the tab's mute. A tab muted
on any device is muted everywhere.

*(Claude's call: attention is one state of the tab, shared by every device.)*
- It stops pulsing everywhere as soon as the tab is opened on any device.
- A device that connects while a tab is waiting shows that tab pulsing.
- The sound and the flash still come only once, when the attention starts, under each device's own rules.
- The renderer's own "unread on leave" mark stays per device, as today.

## How it works

### The tab directory

Each device tells each directly linked member about its own tabs:
- the full list when the link comes up;
- every change after that: opened, updated, closed;
- each tab's id, kind, profile, folder, name, title, session id, account name, muted, exited, working, attention,
  bell, the number of unseen images, whether it has a note, the Changes counter, the status summary and the size.

These are small messages, sent at once.

The list is not a part 1 record:
- it is not stored;
- it does not relay through other members;
- it ends when the link ends.

The viewer keeps the last list it had for an offline device, in memory, to show the dimmed tabs.

### The tab's own device keeps a copy of the screen

The tab's own device runs a headless terminal emulator per tab in the main process, fed with the same output. One
candidate is `@xterm/headless` with the serialize addon; the builder picks it. It does this only while the device is
in a group. The copy gives:
- **A snapshot** for a viewer that starts showing the tab: the screen, the scrollback (up to that device's scrollback
  setting) and the modes, serialized.
- **The title a program sets (OSC) and the bell**, now known in main for the directory.

The local window keeps working as today. The headless copy is only for other devices.

### Viewing and typing

A viewer **attaches** to a remote tab the first time the user switches to it, and stays attached while the link
lasts.
- Attaching asks for a snapshot. The device answers with the snapshot and a sequence number, then streams every later
  output chunk numbered in order.
- The viewer writes the snapshot into its own xterm, then the chunks. A gap or a missing chunk means it attaches again
  for a fresh snapshot.

**Input** from a viewer is written to the PTY exactly as local input is, after the same checks. **Size:** when a
viewer types into a tab or switches to it, it sends its size. The tab's device resizes the PTY and tells every viewer
the new size. The device's own window counts as a viewer for this rule.

### The connection carries two lanes

The same part 1 link carries everything. Messages are queued in two lanes:
- an **interactive** lane (input, output, sizes, the directory, attention, small calls), always sent first;
- a **bulk** lane (snapshots, images, diffs, Recent sessions lists, part 1 catch-up), sent in chunks of at most about
  64 KiB between interactive messages.

Calls are requests with an id and a time limit, answered once.

A viewer whose link holds too much unsent output for a tab is detached from that tab. Its output is dropped, not
buffered. The viewer attaches again later and gets a fresh snapshot. The limit is the builder's choice, a few MiB. A
newer device may send message types this one does not know, and they are ignored, as in part 1. A device with no tabs
of its own (a future phone) is just a member that never announces tabs.

### Everything around the tab

For an attached tab, the tab's device pushes the per-tab updates its hubs already make (status and plan, review,
images, attention), as the window gets them today. The viewer's main process turns them into the same IPC events its
renderer already handles. The viewer's renderer then learns only that a tab is remote and which device it is on.

- **Images.** A viewer's `ctimg://` request for a remote card is answered by fetching the bytes from the tab's device.
  That device serves only images that are cards of that tab, with the same checks as its local protocol. The viewer
  caches them by card id and version.
- **Changes.** Every review action is forwarded to the tab's device: scope, viewed marks, refresh, show file, clear,
  can-send. "Send to Claude" types into the tab like any input.
- **Notes and stars.** These are keyed by the Claude session id and already shared by part 1. The viewer's NoteHub
  serves a remote Claude tab's note from the shared store by that session id.
- **Attention.** The tab's device keeps each tab's attention state in main, a new field. The state comes from today's
  sources (hook attention, bell, AutoContinue giving up), and the tab directory carries it.
  - When any device activates the tab, the attention is cleared on the tab's device. The directory then tells
    everyone.
  - Each device decides on its own, from the start of an attention, about the flash and the sound.

### Calls a member answers

Each call is validated and refused when the tab is unknown or the arguments are malformed:
- **Tabs:** open a tab (kind, profile name, account id, folder or the default folder; Claude tabs may carry a session
  id to resume), close, restart, rename, mute, switch account, change folder.
- **Lists:** the profile names; the accounts as names and ids without tokens; the Recent sessions list as today's
  `RecentSession` items.
- **Choosing a folder:** the recent folders; the subfolders of a folder, as names only, without files or anything
  else; whether a folder exists.
- **Receiving pasted or dropped content:** a pasted image or dropped files are written into a new folder under the
  device's own ClaudeTerm temp folder, never anywhere else.
  - The file names come from the sender but are reduced to a plain base name. Path separators, `..`, device names and
    reserved names are refused or replaced.
  - The size is limited in all.
  - The answer gives the saved paths. The viewer then types them into the tab as input.
  - The temp folder is cleaned like today's pasted-image folder.

### Keeping the device awake

While the setting is on and the rule above holds, the device holds an Electron `powerSaveBlocker` of type
`prevent-app-suspension`. It releases the blocker when the rule stops holding, when the setting is turned off, or when
the last link ends. The last remote input time and the "working" state are already known to the tab's device.

### Changing a folder

`TabManager` gains a folder change:
- the tab's `cwd` changes;
- the tab is restarted in the new folder, with no `--resume` for a Claude tab;
- the hubs that are keyed by the tab's folder (images, review, notes) drop the tab's old state and take it up again
  for the new folder, as for a new tab with the same id.

### Turning it on

*(Claude's call: part 1's plan is still being carried out. Its last two tasks, the settings/IPC wiring and the Devices
section, are changed now so that the setting is never built, instead of being built and then removed.)*

Part 1's `devices.enabled` setting is removed:
- `DeviceGroup` opens at startup when `device-identity.json` exists.
- Without it, the Devices section's "Show code" or "Join" creates the identity and opens the group.
- A device with no group creates no identity, opens no port and asks nothing of the system keyring.

## Testing

**Unit:**
- the tab directory's diffing;
- the two-lane queue's ordering and chunking;
- the snapshot-and-sequence logic of an attached view, including a gap leading to a fresh attach;
- the size rule;
- argument checks of every call;
- folder-change state in the hubs.

**Integration** (real TLS on `127.0.0.1`, two devices, fake PTYs or a real shell in a temp folder):
- the directory on link up and on changes;
- attach gives a snapshot then a stream;
- input reaches the PTY;
- a slow viewer is detached, not buffered;
- a pasted image and dropped files land in a new folder under the tab device's temp folder, and the paths typed there
  exist;
- a file name with `..`, separators or a reserved name is refused or made plain;
- a paste over the size limit is refused;
- the awake rule takes and releases the power blocker (with a fake blocker);
- an image of another tab is refused;
- the folder listing returns names only;
- a call for an unknown tab is refused;
- the directory and streams stop when the link ends;
- a reconnect gives a fresh snapshot.

**End-to-end** (two app instances with their own data folders and stand-in `claude`, as in part 1). Pair them, then
check that:
- a tab opened on A shows in B's bar under A's chip;
- typing on B runs on A and shows on both;
- the size follows the last device used;
- closing from B closes it on A;
- attention on A blinks the tab on B;
- an image card of A's tab shows on B;
- the Changes panel of A's tab works on B;
- B opens a Claude tab on A, then changes its folder;
- B's Recent sessions lists A's sessions and resumes one on A;
- stopping A dims its group on B, and starting A brings it back;
- `device_status` lists the devices and their tabs.

## Left to the builder

- Message names and shapes, and the lane chunk size.
- The headless emulator and how snapshots are bounded and built without blocking the main process.
- The colour palette.
- How the renderer draws a terminal of another size.
- The detach limit.
- The folder dialog's layout within the mockup's shape.
- Splitting the work into tasks.
- Whether the device's own window is attached through the same path.

## Release

Parts 1 and 2 ship together in one release, which bumps the middle number (a new feature). The release has its section
in `CHANGELOG.md` and the README gains a short "Devices" part. The README images are regenerated only if the tab bar
in them changes.
