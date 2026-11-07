# Device Sync, Part 2: Remote Tabs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every device of the group shows the tabs of every device it is linked with in one tab bar, grouped by device, and each of them is used from here like a local tab — terminal, typing, size, Media, Changes, note, status bar, attention — while it keeps running on its own device; tabs can be opened, closed, resumed and moved to another folder on any device.

**Architecture:** The part 1 link gets two lanes (interactive frames written at once; bulk messages cut into 64 KiB parts written one at a time, on the next turn of the event loop) and request/response calls. While a group is open, every tab of this device has a headless copy of its screen in a worker thread (`@xterm/headless` and its serialize addon); a copy that starts after its tab has printed is seeded once from this device's own window. A `TabHost` announces the tab directory to each linked member, answers `attach` with a snapshot of the copy, streams numbered output to the members attached to a tab, and answers calls through `remote-host.ts`, which uses the existing `TabManager` and hubs. On the viewing device `RemoteTabs` keeps each device's directory (also while that device is offline), attaches to a tab the first time the user switches to it (a snapshot, then the numbered stream), and `index.ts` turns all of it into the IPC events the renderer already handles, plus a few new ones (`evTabSize`, `evRemoteDevices`, `evAttentionClear`, `evScreenSeed`, …); every IPC handler that takes a tab id sends a remote tab to `RemoteActions`. A `RemoteHolder` (`src/main/remote-holder.ts`) owns all of it and lives exactly as long as the group.

**Tech Stack:** TypeScript (strict), Electron 44 main process (`protocol`, `powerSaveBlocker`, `clipboard`), Node `tls` / `worker_threads` / `fs/promises`, `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0 (new devDependencies, pinned exactly; bundled into the worker through electron-vite's `?modulePath` import, and the serialize addon also into the renderer), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-remote-tabs-design.md` — read it first; this plan argues from it. It builds on part 1: `docs/superpowers/specs/2026-11-04-device-sync-design.md` and `docs/superpowers/plans/2026-11-04-device-sync.md`.

## Global Constraints

- **No git commits.** Leave every change uncommitted; the user commits. Each task ends with "Leave the changes uncommitted (the user's rule)."
- **Part 1 is complete before this plan runs**, with the user's amendment: there is **no `devices.enabled` setting**; `DeviceGroup` opens at startup only when `device-identity.json` exists; "Show code" and "Join" in the Devices section create the identity and open the group; the Devices section is always shown; with no identity there is no port and no identity file, and the section shows only "Show code" and "Join". No task adds or removes such a setting. Part 1 names this plan uses: `startDevices()` / `stopDevices()` / `restartDevices()` in `src/main/index.ts` (they open and close the `DeviceGroup`, kept in `let group: DeviceGroup | null`), `DevicesView` (`enabled: false` while there is no group), `ActiveDevicesView`, `DeviceView`, `DEVICE_COPY`, `devicesSection()`, `StoreBridge`, `NoteHub.external`, `Settings.devices: { port: number }`, `CLAUDETERM_TEST_DEVICE_HOST` / `CLAUDETERM_TEST_DEVICE_PORT` (honored only with `CLAUDETERM_TEST=1`).
- **With no group (no device identity) ClaudeTerm behaves exactly as today**: no screen copies, no worker thread, no new messages, no new IPC events. While a group is open, every tab of this device has a screen copy, also while no other device is listed; the remote machinery (`remote: RemoteHolder | null` in `index.ts`, Task 11) is created when the group opens and disposed when it closes.
- A tab runs on the device that started it; the others show and control it. Tab ids are the tab device's UUIDs, used unchanged everywhere. All members are equal; there are no per-device permissions.
- Tabs show only from directly linked devices. The directory is not stored, not relayed, and ends with the link; a viewer keeps an offline device's last list in memory only, for the run.
- Lanes: interactive messages (input, output, sizes, the directory, attention, small calls) are written at once; bulk messages (snapshots, image bytes, review pushes, Recent sessions lists, file parts, part 1 records) go in frames of at most `BULK_CHUNK_BYTES` = 64 KiB, written one at a time while the socket holds less than 64 KiB. A bulk message joined from its parts is at most `MAX_FRAME_BYTES` (16 MiB). A bulk message may carry a key: a newer one with the same key replaces a queued one that has not started (Task 1), so a member has at most one queued snapshot per tab.
- A member whose link holds more than `DETACH_BACKLOG_BYTES` (4 MiB) unsent when a tab's output is due is detached from that tab: the output is dropped, not buffered; it attaches again later from a fresh snapshot.
- Calls carry an id and a time limit (`CALL_TIMEOUT_MS` 10 s; attach `ATTACH_TIMEOUT_MS` 15 s; menu and list calls `LIST_TIMEOUT_MS` 3 s) and are answered at most once; an unknown method, an unknown tab or malformed arguments are refused.
- **No device waits on another to show its own things**: the "+" menu and Recent sessions show this device's entries at once and each other device's from the last answer it gave (kept per device in memory, "Loading…" before its first answer), refresh in the background and redraw when fresh answers arrive.
- **A path that belongs to another device is never checked with this machine's path rules**: IPC about a remote tab takes such a path as a bounded string (`isPathText`, `isFolderInput`), and the tab's own device checks it with its own rules, exactly as it does for its local calls.
- Paste and drop into a remote tab: at most `MAX_TRANSFER_BYTES` = 50 MiB in all per paste or drop; written only into a new folder made with `mkdtemp` (mode 0o700 on POSIX) under `<os.tmpdir()>/ClaudeTerm/received/` of the tab's device, after checking that `ClaudeTerm` and `received` are real directories (not links; on POSIX owned by this user); every file is created with the flag `'wx'`; the folder is cleaned after 7 days like `ClaudeTerm/clipboard`; the paths are typed into the tab as `"<path>"`, as a local paste types them. An image pasted into a remote tab always goes this way, on every viewer system: never through Claude Code's image-paste key, which would make Claude read the other machine's clipboard.
- Keep awake: setting `devices.keepAwake`, default `true`, the checkbox "Keep this computer awake while another device uses it" in Settings → Devices. While on, the device holds an Electron `powerSaveBlocker` of type `prevent-app-suspension` while another device typed into one of its tabs in the last 30 minutes (`AWAKE_INPUT_MS`) or one of its Claude tabs that another device has attached is working; it releases it when the rule stops holding, the setting goes off or the last link ends. Under `CLAUDETERM_TEST=1` the real `powerSaveBlocker` is never used: a fake one records `start` / `stop` and appends each as a line to `CLAUDETERM_TEST_POWER_LOG` when that is set (as `CLAUDETERM_TEST_SOUND_LOG` does for sounds).
- Nothing from the network reaches the hook pipe or the MCP server, reaches a shell other than as input typed into a tab, reads a file other than a tab's image cards and Changes, lists anything but folder names, or writes anywhere but a new folder under `ClaudeTerm/received`. Everything from the network is untrusted: shapes are checked (Tasks 2 and 3) and what fails is dropped; nothing throws out of a socket handler.
- The main process never blocks: screen copies and snapshots run in a worker thread; file reads and writes are async.
- MCP: `device_status` (read only, never codes or keys) and `open_device_settings`; nothing that pairs, joins, removes, opens tabs or types.
- Every new UI string is English and comes from `REMOTE_COPY` (Task 2), used as written.
- **Tests never touch the machine**: only `127.0.0.1`, temp folders and the stand-in `claude`; every e2e app has a temp `CLAUDE_CONFIG_DIR`; a test that lists home folders also sets a temp `HOME` and `USERPROFILE`; no test starts the real `powerSaveBlocker`. Two-app e2e tests use `startApps()` / `pairApps()` / `pairedApps()` from `tests/e2e/device-pair.ts` (Task 13).
- **E2E timing, in every e2e test of this plan**: the test starts with `test.setTimeout(180_000)`; every wait for something another app or device does passes `SLOW` (`{ timeout: 45_000 }`, exported by `tests/e2e/device-pair.ts`) to `expect.poll`, `toBeVisible`, `toHaveClass`, `toHaveCount`, `toContainText` and `click`; no bare `expect.poll` across devices; no fixed sleep. A test that checks that something does *not* arrive sends a marker after it on the same link or path (one link keeps order) and waits for the marker. Unit and integration tests poll with `until(cond, ms = 5000)` from `tests/fixtures/sync.ts` (Task 1).
- **Baseline**: on this machine (Windows) five e2e tests fail before any change because the desktop clipboard reads back empty: in `clipboard.spec.ts` "a program copies text to the clipboard with OSC 52" and "OSC 52 cannot read the clipboard"; in `keys.spec.ts` "the copy key copies the terminal's selection, the paste key pastes text" and the two "on Windows where PowerShell … clipboard …" tests. New tests that read or write the desktop clipboard fail here the same way. Compare with that baseline, never change those tests to pass here; CI on Windows, macOS and Linux decides.
- Match the surrounding code: no UI framework, manual guards (no zod in main), paths compared with `pathKey` (also in tests, where a typed or echoed path meets a computed one; `FileReceiver` never realpaths). **Edit existing files with Edit, never rewrite them with Write**: many are CRLF (`index.ts`, `main.ts`, `ipc.ts`, `types.ts`, `preload/index.ts`, `tabbar.ts`, `terminal-view.ts`, `tab-manager.ts`, `settings*.ts`, README, CHANGELOG and the existing tests), and a rewrite flips the whole file. New files are LF.

## Review Focus

1. **Output cut inside a surrogate pair or an escape sequence** when the tab's device splits a burst into `out` pieces — no piece ends inside a pair, and the viewer's screen equals the device's. Tests: Task 6 ("a burst longer than MAX_OUT_CHARS…") and Task 7 ("the screen here equals the screen there after a burst").
2. **Scrollback at its maximum (1 000 000 lines) and a program in the alternate screen** (Claude Code, vim) — the snapshot stays under `MAX_SNAPSHOT_BYTES` and brings back the alternate screen and the modes. Tests: Task 4.
3. **Two devices typing into one tab in turn** — one resize each time the tab changes hands, none per keystroke. Test: Task 5.
4. **Folders as people type them** in Change folder — `~`, `~/src`, a trailing separator, `/` on Windows, a file, a relative path — normalized or refused with the dialog's message on the tab's device, and never refused here by this machine's rules. Tests: Task 20 (`listFolder`, `isFolderInput`).
5. **A member announcing a tab id that is already a local tab or another device's tab**, or more tabs than `MAX_REMOTE_TABS` — ignored; nothing here is replaced. Test: Task 7.
6. **The seed and the live output** — a copy seeded from this window's screen must show every chunk once: none lost between the serialized screen and the stream, none doubled. Tests: Task 4 (held output), Task 13 (a tab that printed before pairing).
7. **The received-files folder on a shared `/tmp`** — a planted link at `ClaudeTerm` or `received` is refused, files are created with `'wx'`, nothing is written outside the new folder. Test: Task 23.

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/remote.ts` (new) | Types and constants shared with the renderer: `RemoteTab`, `RemoteDeviceView`, `FolderResult`, `DeviceChoices`, `DeviceAnswer`, limits, `deviceColor`, `REMOTE_COPY` |
| `src/shared/screen-serialize.ts` (new) | `boundedSerialize`: a screen serialized within a size limit (worker and renderer) |
| `src/main/sync/wire.ts`, `peer-link.ts`, `device-group.ts` | Bulk parts, the two lanes, bulk keys, paced catch-up, `onPeer` |
| `src/main/sync/remote-wire.ts`, `calls.ts`, `remote-shapes.ts` (new) | Part 2 messages and their checks; request/response calls; checks of every call's arguments and reply, and of hub pushes |
| `src/main/sync/screen-mirror.ts`, `screen-worker.ts`, `mirror-port.ts` (new), `src/main/env.d.ts` (new) | Headless screen copies, seeds and snapshots (worker side); the port client and the worker's path (main side) |
| `src/main/sync/tab-sizes.ts`, `tab-directory.ts` (new) | The size rule; directory diffs, attention state, status summary |
| `src/main/sync/tab-host.ts`, `attached-view.ts`, `tab-viewer.ts`, `remote-link.ts` (new) | This device's tabs for linked members; other devices' tabs here |
| `src/main/sync/remote-actions.ts` (new) | Typed calls to other devices; cached menus and session lists; `remoteTabInfo`; the remote image cache |
| `src/main/sync/file-receiver.ts`, `file-sender.ts`, `keep-awake.ts`, `device-status.ts` (new) | Pasted and dropped files; the awake rule; the `device_status` text |
| `src/main/remote-host.ts`, `src/main/remote-holder.ts`, `src/main/folder-browse.ts` (new) | Answers other devices' calls with this device's `TabManager` and hubs; owns the remote machinery for the group's lifetime; folder names and checks |
| `src/main/tab-manager.ts`, `image-hub.ts`, `review-hub.ts`, `note-hub.ts`, `img-protocol.ts`, `settings-window.ts`, `settings.ts`, `pipe-server.ts`, `ipc-guards.ts` | Folder change, sizes, remote fronts, notes of remote tabs, remote images, a settings section, `devices.keepAwake`, MCP pipe messages, the new IPC guards |
| `src/main/index.ts`, `src/shared/ipc.ts`, `types.ts`, `review.ts`, `protocol.ts`, `settings-keys.ts`, `devices.ts`, `src/preload/index.ts` | Wiring, IPC, types |
| `src/renderer/tabbar.ts`, `terminal-view.ts`, `main.ts`, `menu.ts`, `keymap.ts`, `folder-dialog.ts` (new), `recent-sessions.ts`, `image-panel.ts`, `review-panel.ts`, `devices-section.ts`, `settings-page.ts`, `index.html`, `styles.css`, `env.d.ts` | UI |
| `src/mcp/device-tools.ts` (new), `src/mcp/show-image-server.ts` | `device_status`, `open_device_settings` |
| `electron-builder.yml` | The worker bundle in `asarUnpack` |
| `tests/fixtures/sync.ts`, `tests/fixtures/screen.ts` (new), `tests/e2e/device-pair.ts` (new) | `until`, `linkPair`; headless replay helpers; two paired app instances |
| `README.md`, `CHANGELOG.md` | The release text for parts 1 and 2 |

---

### Task 1: Two lanes on a link

**Files:**
- Modify: `src/main/sync/wire.ts`, `src/main/sync/peer-link.ts`, `src/main/sync/device-group.ts` (`BATCH_BYTES`, `sendRecords`), `tests/fixtures/sync.ts` (`until`)
- Test: `tests/unit/sync-wire.test.ts`, `tests/integration/sync-peer-link.int.test.ts`, `tests/integration/sync-device-group.int.test.ts`

**Interfaces:**
- Consumes: part 1's `encodeFrame`, `FrameDecoder`, `FrameError`, `PeerLink`, `DeviceGroup`.
- Produces:
  - `wire.ts`: `BULK_CHUNK_BYTES = 64 * 1024`; `encodeBulkFrames(m: Message, chunkBytes = BULK_CHUNK_BYTES): Buffer[]` — a message whose JSON body is at most `chunkBytes` is one ordinary frame (`encodeFrame(m)`); a longer one is cut into parts, each a frame whose body is one marker byte (`0x01`: more parts follow, `0x02`: the last part) followed by up to `chunkBytes` bytes of the message's UTF-8 JSON. `FrameDecoder.push` returns the bulk message when its last part arrives and returns ordinary frames that arrive between its parts at once; a joined message over `MAX_FRAME_BYTES` throws `FrameError('frame too large')`. (An ordinary body is the JSON of an object and never starts with `0x01` or `0x02`.)
  - `PeerLinkOptions.maxQueuedBulkBytes?: number` (default 128 MiB). `PeerLink.sendBulk(m: Message, key?: string): void` — queued; a no-op once closed. The queue is pumped on the next turn of the event loop (`setImmediate`) and on the socket's `'drain'`, writing parts `while (queue.length > 0 && socket.writableLength < BULK_CHUNK_BYTES)`; `send` stays a synchronous write (part 1's `closeWithNotice` relies on it). A message given a key replaces a queued message with the same key whose first part has not been written: the older one is dropped; one already started is finished whole, never cut. Queued bytes over `maxQueuedBulkBytes` close the link with `'slow peer'`; a `FrameError` closes it like `send`; `close()` empties the queue. `PeerLink.backlog(): number` (the socket's `writableLength`).
  - `DeviceGroup`: every `records` message goes through `sendBulk` (no key), in batches of at most `BATCH_BYTES = 64 * 1024` of JSON — this fixes part 1's deferred finding (a catch-up over the 32 MiB buffer limit closed the link as `'slow peer'`).
  - `tests/fixtures/sync.ts`: `until(cond: () => boolean, ms = 5000): Promise<void>` (polls every 20 ms, throws `until: timed out` after `ms`); `sync-device-group.int.test.ts` imports it in place of its local copy; its `openGroup(name, platform, opts)` gains `opts.link?: Partial<PeerLinkOptions>`, passed as `timing: { ...TIMING, link: opts.link }`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/sync-wire.test.ts` (`noteUpdate(text)`: a `notes` update with one sibling, as in the 100 000-character test):

```ts
it('a message longer than a chunk goes in parts; an ordinary frame between parts comes out first', () => {
  const big: Message = { t: 'records', updates: [noteUpdate('x'.repeat(200 * 1024))] }
  const parts = encodeBulkFrames(big)
  expect(parts).toHaveLength(4)
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(4 + 1 + BULK_CHUNK_BYTES)
  const d = new FrameDecoder()
  expect(d.push(parts[0])).toEqual([])
  expect(d.push(Buffer.concat([encodeFrame({ t: 'ping' }), parts[1]]))).toEqual([{ t: 'ping' }])
  expect(d.push(Buffer.concat(parts.slice(2)))).toEqual([big])
})
it('a message that fits one chunk is one ordinary frame', () => expect(encodeBulkFrames({ t: 'ping' })).toEqual([encodeFrame({ t: 'ping' })]))
it('parts that join to more than MAX_FRAME_BYTES throw FrameError', () => {
  const part = Buffer.alloc(4 + 1 + BULK_CHUNK_BYTES); part.writeUInt32BE(1 + BULK_CHUNK_BYTES, 0); part[4] = 0x01
  const d = new FrameDecoder()
  expect(() => { for (let i = 0; i <= MAX_FRAME_BYTES / BULK_CHUNK_BYTES; i++) d.push(part) }).toThrow(FrameError)
})
```

`tests/integration/sync-peer-link.int.test.ts` (`bigRecords(bytes)`: a `records` message of about that size; `recordsWith(text)`: one with one note of that text; `noteTexts(msgs)`: the texts of the notes in those `records` messages, in order; `got`: the messages the server link emits):

```ts
it('an interactive message sent after a large bulk one arrives first', async () => {
  client.sendBulk(bigRecords(4 * 1024 * 1024)); client.send({ t: 'sync', seen: {} })
  await until(() => got.length === 2); expect(got.map((m) => m.t)).toEqual(['sync', 'records'])
})
it('a bulk backlog larger than maxBufferedBytes does not close the link', async () => {
  // maxBufferedBytes 1 MiB on the client
  for (let i = 0; i < 8; i++) client.sendBulk(bigRecords(1024 * 1024))
  await until(() => got.length === 8, 15_000); expect(closed).toEqual([])
})
it('a bulk queue over maxQueuedBulkBytes closes the link as a slow peer', async () => {
  // serverSocket.pause(); maxQueuedBulkBytes 2 MiB
  for (let i = 0; i < 4; i++) client.sendBulk(bigRecords(1024 * 1024))
  await until(() => closed.length === 1); expect(closed).toEqual(['slow peer'])
})
it('a keyed bulk message replaces a queued one with the same key; one already started arrives whole', async () => {
  client.sendBulk(recordsWith('first'), 'k'); client.sendBulk(recordsWith('second'), 'k')   // same turn: 'first' never starts
  await until(() => got.length === 1); expect(noteTexts(got)).toEqual(['second'])
  serverSocket.pause(); client.sendBulk(bigRecords(4 * 1024 * 1024), 'k'); await new Promise((r) => setImmediate(r))
  client.sendBulk(recordsWith('third'), 'k'); serverSocket.resume()
  await until(() => got.length === 3); expect(got[1]).toEqual(bigRecords(4 * 1024 * 1024)); expect(noteTexts([got[2]])).toEqual(['third'])
})
it('backlog() counts what waits in the socket', async () => {
  serverSocket.pause(); client.send(bigRecords(2 * 1024 * 1024)); expect(client.backlog()).toBeGreaterThan(0)
})
```

`tests/integration/sync-device-group.int.test.ts`:

```ts
it("a catch-up larger than the link's buffer limit arrives whole, and the link stays up", async () => {
  // a and b opened with { link: { maxBufferedBytes: 256 * 1024 } }; paired; b closed; a writes 300 notes of 4000 characters; b reopened
  await until(() => b.keys('notes').length === 300, 15_000)
  expect(a.view().devices[0].state.kind).toBe('connected')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/unit/sync-wire.test.ts tests/integration/sync-peer-link.int.test.ts tests/integration/sync-device-group.int.test.ts`
Expected: FAIL — `encodeBulkFrames` and `until` are not exported; the catch-up test times out (the link closes as `'slow peer'`).

- [ ] **Step 3: Implement** the parts in `wire.ts`, the bulk queue (entries of `{ frames, key, started }` and a byte total) in `PeerLink`, the batches in `DeviceGroup`, and `until`.

- [ ] **Step 4: Run them to verify they pass** — the Step 2 command, three times in a row — PASS. Then `npm run typecheck` — no errors.

- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 2: Remote messages and calls

**Files:**
- Create: `src/shared/remote.ts`, `src/main/sync/remote-wire.ts`, `src/main/sync/calls.ts`
- Modify: `src/main/sync/wire.ts` (`Message` also includes `RemoteMessage`; `parseMessage`'s `default` returns `parseRemoteMessage(v)`)
- Test: `tests/unit/sync-remote-wire.test.ts`, `tests/unit/sync-calls.test.ts`

**Interfaces:**
- Consumes: `PeerLink` (`send`, `sendBulk`, `'message'`, `'close'`), `isUuid` (`src/shared/protocol.ts`), `isPlainObject` (`src/main/sync/views.ts`), `NOTIFICATION_CASES` (`src/shared/settings-keys.ts`), `isPtySize(cols, rows)` (`src/main/ipc-guards.ts`, 1..4000).
- Produces — `src/shared/remote.ts`:

```ts
export interface RemoteTab {
  id: string; kind: TabKind; profile: string; cwd: string; customTitle: string | null
  /** the title the program set (OSC), from the device's screen copy */
  title: string | null
  claudeSessionId: string | null
  /** the extra account's id and name on that device; null: its main account */
  account: string | null; accountName: string | null
  muted: boolean; exited: boolean; working: boolean
  /** what the tab waits with ('bell' too); null once it was opened on any device */
  attention: NotificationCase | null
  /** raised by every attention that starts */
  attentionSeq: number
  /** unseen Media cards */
  images: number
  note: boolean
  counter: ReviewCounter | null
  /** statusSummary (Task 5) of a Claude tab's status bar */
  status: string | null
  /** the PTY's size and the device it is sized for; by null: the tab device's own window */
  size: { cols: number; rows: number; by: string | null }
}
export interface RemoteDeviceView { id: string; name: string; platform: DevicePlatform | null; online: boolean }
export type PushKind = 'status' | 'plan' | 'review' | 'images'
export interface RemoteSnapshot { data: string; seq: number; cols: number; rows: number }
export interface FolderListing { device: string; path: string; sep: '/' | '\\'; parent: string | null; folders: string[]; recent: string[] }
export type FolderResult = { ok: true; listing: FolderListing } | { ok: false; error: string }
export interface DeviceChoices { profiles: string[]; accounts: { id: string; name: string }[] }
/** what a device last answered; value null: it has not answered yet (the UI shows REMOTE_COPY.loading) */
export interface DeviceAnswer<T> { device: string; name: string; value: T | null }
export const MAX_REMOTE_TABS = 256, MAX_OUT_CHARS = 256 * 1024, MAX_INPUT_CHARS = 1024 * 1024
export const CALL_TIMEOUT_MS = 10_000, ATTACH_TIMEOUT_MS = 15_000, LIST_TIMEOUT_MS = 3_000, REATTACH_MS = 1_000
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024  // the JSON-encoded size of a snapshot's text
export const DETACH_BACKLOG_BYTES = 4 * 1024 * 1024
export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024, MAX_TRANSFER_FILES = 100, TRANSFER_PART_BYTES = 1024 * 1024
export const IMAGE_PART_BYTES = 4 * 1024 * 1024, IMAGE_CACHE_BYTES = 64 * 1024 * 1024
export const AWAKE_INPUT_MS = 30 * 60 * 1000, COPY_TOAST_MS = 1_000
export const MAX_FOLDER_ENTRIES = 500, RECENT_FOLDER_COUNT = 10, MAX_PATH_TEXT = 4096
export const DEVICE_COLORS = ['#e8a33d', '#4fa3e0', '#9b7be8', '#4cbf8a', '#e86b6b', '#d97bc4', '#c9c14a', '#5fc4c4'] as const
/** the same colour for a device everywhere: DEVICE_COLORS[parseInt(first 8 hex digits of the id, 16) % 8]; DEVICE_COLORS[0] when they are not hex */
export function deviceColor(id: string): string
export const REMOTE_COPY = {
  offline: '· offline',
  tabTooltip: (title: string, device: string, folder: string) => `${title}\n${device}: ${folder}`,
  newClaudeTab: 'New Claude Code tab',
  newProfileTab: (profile: string) => `New ${profile} tab`,
  fold: 'Fold',
  unfold: 'Unfold',
  loading: 'Loading…',
  changeFolder: 'Change folder…',
  changeFolderTitle: 'Change folder',
  changeFolderOn: (device: string) => `Change folder on ${device}`,
  recentOn: (device: string) => `Recent on ${device}`,
  openHere: 'Open here',
  cancel: 'Cancel',
  folderMissing: 'This folder does not exist',
  folderUnreadable: 'This folder cannot be read',
  folderNotAbsolute: 'Enter the full path of a folder',
  copying: (device: string) => `Copying to ${device}…`,
  copyTooLarge: (device: string) => `Too large to copy to ${device}: at most 50 MB at a time`,
  copyFailed: (device: string, error: string) => `Could not copy to ${device}: ${error}`,
  deviceOffline: (device: string) => `${device} is not connected`,
  noAnswer: (device: string) => `${device} did not answer`,
  unknownTab: 'That tab is not open on this device',
  tabCount: (n: number) => (n === 0 ? 'No tabs open' : n === 1 ? '1 tab open' : `${n} tabs open`),
  keepAwake: 'Keep this computer awake while another device uses it'
} as const
```

- Produces — `remote-wire.ts` (imports only **types** from `wire.ts`: a runtime import back would be a cycle with `wire.ts`' `parseMessage`; `isPlainObject` comes from `views.ts`; its integer guards are its own):

```ts
export type RemoteMessage =
  | { t: 'call'; id: number; m: string; a: unknown }
  | { t: 'reply'; id: number; ok: true; v: unknown } | { t: 'reply'; id: number; ok: false; e: string }
  | { t: 'tabs'; tabs: RemoteTab[] } | { t: 'tab'; tab: RemoteTab } | { t: 'tab-closed'; id: string }
  | { t: 'out'; id: string; seq: number; d: string } | { t: 'reset'; id: string; seq: number } | { t: 'exit'; id: string; seq: number; code: number }
  | { t: 'detached'; id: string }
  | { t: 'push'; id: string; k: PushKind; v: unknown }
  | { t: 'in'; id: string; d: string } | { t: 'claim'; id: string; cols: number; rows: number } | { t: 'front'; id: string | null }
export function parseRemoteMessage(v: Record<string, unknown>): RemoteMessage | 'unknown' | null
export function parseRemoteTab(v: unknown): RemoteTab | null
```

  Limits: every `id` naming a tab is a UUID; `seq` and the call/reply `id` are positive safe integers; `m` matches `/^[a-z][a-z-]{0,31}$/`; `e` 1..1000 characters; `out.d` 0..`MAX_OUT_CHARS`, `in.d` 1..`MAX_INPUT_CHARS`; `code` a safe integer; `cols`/`rows` as `isPtySize`; `tabs` at most `MAX_REMOTE_TABS`; `k` a `PushKind`; `a`, `v` present and checked later by their users (Task 3). `RemoteTab`: profile 1..256, cwd 1..4096, customTitle/title null or ≤ 1000, claudeSessionId null or UUID, account null or 1..64, accountName null or ≤ 256, booleans, attention null or a `NOTIFICATION_CASES` member, attentionSeq and images non-negative safe integers, counter null or `{ files, additions, deletions }` non-negative integers with `title` ≤ 1000, status null or ≤ 200, size as `isPtySize` with `by` null or a UUID. Each parser returns a copy of the known fields only.
- Produces — `calls.ts`:

```ts
export class CallError extends Error {}   // name 'CallError'
/** run may return a promise; it throws CallError to refuse. bulk: the reply goes through sendBulk; key: the reply's bulk key, so a newer reply replaces a queued older one */
export interface CallEntry { run(args: unknown): unknown; bulk?: boolean; key?(args: unknown): string | null }
export type CallLink = Pick<PeerLink, 'send' | 'sendBulk' | 'on' | 'off'>
export class Calls {
  constructor(link: CallLink, handlers: Record<string, CallEntry>, opts?: { timeoutMs?: number; maxRunning?: number })  // CALL_TIMEOUT_MS, 64
  call(method: string, args: unknown, opts?: { timeoutMs?: number; bulk?: boolean }): Promise<unknown>
  close(): void
}
```

  Rules: an incoming `call` runs the entry named `m`; none → reply `{ ok: false, e: 'unknown call' }`; more than `maxRunning` running → `'busy'`; a `CallError` → its message (cut to 1000); any other throw → `'failed'`; a result → `{ ok: true, v }`, through `sendBulk(reply, key ? `${m}:${key}` : undefined)` for a `bulk` entry (a replaced reply is never sent: its caller times out). Outgoing ids count 1, 2, …; a reply for an id that is not waiting is ignored, so a call is answered once; past its time limit a call rejects with `CallError('timeout')` and its id is forgotten; the link's `'close'` or `close()` rejects every waiting call with `CallError('link closed')`, and later calls reject at once; `{ bulk: true }` sends the call itself through the bulk lane. Nothing is thrown out of the message listener.

- [ ] **Step 1: Write the failing tests**

`tests/unit/sync-remote-wire.test.ts` (`tab(over?)`: a valid `RemoteTab`; `T1`: a UUID):

```ts
it('accepts each part 2 message and refuses wrong shapes', () => {
  expect(parseMessage({ t: 'out', id: T1, seq: 1, d: 'hi' })).toEqual({ t: 'out', id: T1, seq: 1, d: 'hi' })
  for (const bad of [{ t: 'out', id: 'x', seq: 1, d: '' }, { t: 'out', id: T1, seq: 0, d: '' }, { t: 'in', id: T1, d: 'x'.repeat(MAX_INPUT_CHARS + 1) },
    { t: 'claim', id: T1, cols: 0, rows: 30 }, { t: 'call', id: 1, m: 'Bad Name', a: {} }, { t: 'push', id: T1, k: 'weather', v: 1 },
    { t: 'tabs', tabs: Array(MAX_REMOTE_TABS + 1).fill(tab()) }]) expect(parseMessage(bad)).toBeNull()
  expect(parseMessage({ t: 'front', id: null })).toEqual({ t: 'front', id: null })
  expect(parseMessage({ t: 'reply', id: 3, ok: false, e: 'no' })).toEqual({ t: 'reply', id: 3, ok: false, e: 'no' })
})
it('parseRemoteTab keeps a good entry and refuses a bad one', () => {
  expect(parseRemoteTab(tab())).toEqual(tab())
  for (const over of [{ kind: 'other' }, { cwd: 'x'.repeat(4097) }, { size: { cols: 0, rows: 30, by: null } }, { attention: 'nap' }, { attentionSeq: -1 }])
    expect(parseRemoteTab({ ...tab(), ...over })).toBeNull()
})
it('a message type a newer device sends is unknown, not malformed', () => expect(parseMessage({ t: 'tab-thumbnail', id: T1 })).toBe('unknown'))
it('deviceColor gives the same colour of the palette for a device every time', () => {
  expect(DEVICE_COLORS).toContain(deviceColor(T1)); expect(deviceColor(T1)).toBe(deviceColor(T1)); expect(deviceColor('not-hex')).toBe(DEVICE_COLORS[0])
})
```

`tests/unit/sync-calls.test.ts` (`fakePair(handlersA, handlersB)`: two fake links whose `send`/`sendBulk` deliver to the other's `'message'` listeners on the next microtask and record `[lane, key, message]` in `sent`; `a`, `b`: the `Calls` on each end):

```ts
it('a call is answered once with what the handler returns', async () => await expect(b.call('echo', { x: 1 })).resolves.toEqual({ x: 1 }))
it('a refusal comes back with its message; an unknown method is refused', async () => {
  await expect(b.call('refuse', {})).rejects.toThrow('no such tab'); await expect(b.call('nope', {})).rejects.toThrow('unknown call')
})
it('a call not answered in time rejects with timeout, and the late answer is ignored', async () => {
  // handler 'slow' resolves after the caller's 50 ms limit
  await expect(b.call('slow', {}, { timeoutMs: 50 })).rejects.toThrow('timeout'); await until(() => slowDone); expect(unhandled).toEqual([])
})
it('closing the link rejects every waiting call with link closed', async () => {
  const p = b.call('never', {}); linkB.emit('close', 'x'); await expect(p).rejects.toThrow('link closed'); await expect(b.call('echo', {})).rejects.toThrow('link closed')
})
it('a bulk handler answers through the bulk lane with its key; a bulk call goes through it too', async () => {
  await b.call('snap', { id: 'k1' }); expect(sent.find(([, , m]) => m.t === 'reply')).toMatchObject(['bulk', 'snap:k1'])
  await b.call('echo', {}, { bulk: true }); expect(sent.find(([, , m]) => m.t === 'call' && m.m === 'echo')![0]).toBe('bulk')
})
it('more calls at once than maxRunning are refused as busy', async () => {
  // a's maxRunning 2; three calls to 'never' then one to 'echo' → the third and the fourth reject 'busy'
})
it('a handler that throws something else answers failed, and nothing escapes the listener', async () => {
  await expect(b.call('throws', {})).rejects.toThrow('failed'); expect(unhandled).toEqual([])
})
```

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run tests/unit/sync-remote-wire.test.ts tests/unit/sync-calls.test.ts` — FAIL (modules missing).
- [ ] **Step 3: Implement** `remote.ts`, `remote-wire.ts` (in the style of `wire.ts`' parsers), `calls.ts`, and the `wire.ts` change.
- [ ] **Step 4: Run them to verify they pass** — the Step 2 command and `npx vitest run tests/unit/sync-wire.test.ts` — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 3: Shapes of call arguments, replies and pushes

**Files:**
- Create: `src/main/sync/remote-shapes.ts`
- Test: `tests/unit/sync-remote-shapes.test.ts`

**Interfaces:**
- Consumes: Task 2's types and limits; `StatusUpdate`, `PlanStatus`, `ImagesUpdate`, `ReviewUpdate`, `ReviewSendState`, `RecentSession`, `REVIEW_SCOPES`, `isAccountRef`, `isHash`, `MAX_IMAGE_BYTES`.
- Produces:

```ts
export type ReviewAction = { k: 'scope'; scope: ReviewScope } | { k: 'clear' } | { k: 'refresh' } | { k: 'viewed'; path: string; hash: string; viewed: boolean } | { k: 'show'; path: string }
export interface CallArgs { /* one entry per method of the table below */ }
export interface CallReplies { /* one entry per method of the table below */ }
export type CallMethod = keyof CallArgs
export const CALL_ARGS: { [M in CallMethod]: (a: unknown) => CallArgs[M] | null }
export const CALL_REPLIES: { [M in CallMethod]: (v: unknown) => CallReplies[M] | null }
export type PushValue = { k: 'status'; v: Omit<StatusUpdate, 'tabId'> } | { k: 'plan'; v: PlanStatus | null }
  | { k: 'images'; v: Omit<ImagesUpdate, 'tabId' | 'remote'> } | { k: 'review'; v: Omit<ReviewUpdate, 'tabId' | 'remote'> }
export function parsePush(k: PushKind, v: unknown, tabId: string): PushValue | null
```

| Method | Arguments (`id`: a tab's UUID) | Reply |
|---|---|---|
| `attach` | `{ id }` | `RemoteSnapshot` (data ≤ `MAX_SNAPSHOT_BYTES` characters, seq ≥ 0, cols/rows as `isPtySize`) |
| `open-tab` | `{ kind, profile: 1..256 \| null, account: isAccountRef, resume: UUID \| null }` (resume only for `claude`) | `{ id }` |
| `close`, `images-seen`, `can-send` | `{ id }` | `{}`; `can-send`: `ReviewSendState` (reason ≤ 500) |
| `restart` / `rename` / `mute` | `{ id, live: boolean }` / `{ id, title: ≤ 1000 \| null }` / `{ id, muted: boolean }` | `{}` |
| `switch-account` | `{ id, account: isAccountRef }` | `{ ok: boolean }` |
| `image-remove` | `{ id, card }` (`card` matches `/^[0-9a-f]{20}$/`) | `{}` |
| `image` | `{ id, card, offset: safe integer ≥ 0 }` | `{ version ≥ 1, size 0..MAX_IMAGE_BYTES, data: base64 of at most IMAGE_PART_BYTES }` |
| `review` | `{ id, action: ReviewAction }` (path: a string of 1..`MAX_PATH_TEXT` — not checked with any system's path rules here; hash as `isHash`) | `{}` |
| `profiles` / `accounts` | `{}` | `string[]` ≤ 64 of 1..256 / `{ id: 1..64, name: 1..256 }[]` ≤ 64 |
| `sessions` | `{}` | `RecentSession[]` ≤ 1000 (id UUID, cwd 1..4096, title/firstPrompt/lastPrompt null or ≤ 2000, modifiedAt ≥ 0, open, starred; any `device` dropped) |
| `open-session` | `{ session: UUID }` | `{ id }` |
| `folders` | `{ id, path: 0..MAX_PATH_TEXT \| null }` (a string as typed; the tab's device reads it) | `FolderResult` (device 1..64, path 1..4096, sep, parent, folders ≤ `MAX_FOLDER_ENTRIES` names 1..255 without `/` or `\`, recent ≤ `RECENT_FOLDER_COUNT`; error ≤ 500) |
| `change-folder` | `{ id, path: 1..MAX_PATH_TEXT }` | `{}` |
| `recv-begin` | `{ id, files: { name: 1..255, size ≥ 0 }[] }` (1..`MAX_TRANSFER_FILES`, sizes ≤ `MAX_TRANSFER_BYTES` in all) | `{ transfer: UUID }` |
| `recv-part` | `{ transfer: UUID, file: 0..99, offset ≥ 0, data: base64 of 1..TRANSFER_PART_BYTES }` | `{}` |
| `recv-end` | `{ transfer: UUID }` | `{ paths: string[] ≤ 100 of 1..4096 }` |

  Base64: `/^[A-Za-z0-9+/]*={0,2}$/`, a length that is a multiple of 4 and at most `4 * Math.ceil(n / 3)`. A `{}` reply accepts any object and returns `{}`. No string holds a NUL. Pushes: `status` `{ main: MainStatus | null, agents: AgentStatus[] ≤ 64 }` (strings ≤ 200, finite numbers); `plan` `PlanStatus | null` (title ≤ 500; ≤ 500 tasks, each with integer `n`, title ≤ 500 and state `done`/`current`/`left`; `done` and `total` non-negative integers; `finished` a boolean); `images` `{ cards ≤ 10 000, unseen ≥ 0, notice ≤ 500 | null }` where every card has `tabId === tabId`, a 20-hex id, path/relPath 1..4096, name 1..255, source and kind from their unions, caption ≤ 1000 or null, version ≥ 1, touchedAt ≥ 0; `review` every `ReviewUpdate` field but `tabId` (files ≤ 5000, hunks per file ≤ 10 000, lines per hunk ≤ 100 000, a line ≤ 100 000 characters, labels and paths ≤ 4096, samples ≤ 10, `send` a `ReviewSendState`, counter as in `RemoteTab`). Every parser returns a copy of the known fields, or null.

- [ ] **Step 1: Write the failing tests**

```ts
// GOOD_ARGS and BAD_ARGS each hold at least one case for every one of the 21 methods of the table
it.each(GOOD_ARGS)('the arguments of %s pass unchanged', (m, a) => expect(CALL_ARGS[m](a)).toEqual(a))
it.each(BAD_ARGS)('the arguments of %s are refused: %j', (m, a) => expect(CALL_ARGS[m](a)).toBeNull())
// BAD_ARGS has at least: attach { id: 'x' }; open-tab kind 'other' and a shell with resume; rename title of 1001; image offset -1;
// review scope 'all' and a path of 4097; recv-begin two files of 30 MiB and 101 files; recv-part data 'not base64!'; folders path of 4097
it('a review path or folder from another system passes: the tab device reads it', () => {
  expect(CALL_ARGS.review({ id: T1, action: { k: 'show', path: 'C:\\work\\a.ts' } })).not.toBeNull()
  expect(CALL_ARGS.folders({ id: T1, path: '~/src' })).not.toBeNull(); expect(CALL_ARGS.folders({ id: T1, path: '/Users/x' })).not.toBeNull()
})
it('replies are checked', () => {
  expect(CALL_REPLIES.attach({ data: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1), seq: 0, cols: 80, rows: 24 })).toBeNull()
  expect(CALL_REPLIES.sessions([{ ...session(), id: undefined }])).toBeNull()
  expect(CALL_REPLIES.folders({ ok: true, listing: { ...listing(), folders: ['a/b'] } })).toBeNull()
  expect(CALL_REPLIES.profiles(['Bash'])).toEqual(['Bash'])
})
it('an images push holding a card of another tab is refused', () => expect(parsePush('images', { cards: [card({ tabId: T2 })], unseen: 0, notice: null }, T1)).toBeNull())
it('a review push keeps the fields the panel reads and drops the rest', () => {
  const v = { ...reviewUpdateWithoutTabId(), extra: 1 }; expect(parsePush('review', v, T1)).toEqual({ k: 'review', v: reviewUpdateWithoutTabId() })
})
it('a status push with more than 64 agents is refused', () => expect(parsePush('status', { main: null, agents: Array(65).fill(agent()) }, T1)).toBeNull())
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-remote-shapes.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `remote-shapes.ts`, the parsers in the style of `wire.ts`.
- [ ] **Step 4: Run to verify they pass** — same command — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 4: The screen copy

**Files:**
- Modify: `package.json`, `package-lock.json` — `npm install -D --save-exact @xterm/headless@6.0.0 @xterm/addon-serialize@0.14.0` (checked: the repository's `@xterm/xterm` is 6.0.0; these two are the releases of the same 6.0 set as the installed `@xterm/addon-fit` 0.11 and `@xterm/addon-unicode11` 0.9)
- Create: `src/shared/screen-serialize.ts`, `src/main/sync/screen-mirror.ts`, `src/main/sync/screen-worker.ts`, `src/main/sync/mirror-port.ts`, `tests/fixtures/screen.ts`
- Test: `tests/unit/sync-screen-mirror.test.ts`

**Interfaces:**
- Consumes: `RemoteSnapshot` (Task 2, type only).
- Produces:

```ts
// src/shared/screen-serialize.ts — used by the worker and by the renderer (Task 12)
/** serialize(n) with n scrollback lines, n halving from `scrollback` while the JSON of the text is over maxBytes; 0 at last (the screen alone) */
export function boundedSerialize(serialize: (scrollback: number) => string, scrollback: number, maxBytes: number): string
// screen-mirror.ts (worker side; main imports only its types)
export interface MirrorOpen { /** the number of the last chunk already on the screen; 0 by default */ seq?: number; /** output is held until seed() or seedWaitMs */ awaitSeed?: boolean }
export interface ScreenMirrorsApi {
  open(tabId: string, cols: number, rows: number, scrollback: number, opts?: MirrorOpen): void
  /** seq: the chunk's number in the tab's stream; an empty chunk only moves the number on (an exit) */
  write(tabId: string, seq: number, data: string): void
  resize(tabId: string, cols: number, rows: number): void
  /** the process restarted: the copy starts clean (RIS) at this number */
  reset(tabId: string, seq: number): void
  close(tabId: string): void
  /** this window's screen of the tab, written before the held output; ignored for a copy that waits for no seed */
  seed(tabId: string, data: string): void
  /** taken after everything written so far is parsed (and the seed, or seedWaitMs); null for a tab it does not have */
  snapshot(tabId: string): Promise<RemoteSnapshot | null>
  onTitle(cb: (tabId: string, title: string) => void): void
  dispose(): void
}
export class ScreenMirrors implements ScreenMirrorsApi {
  constructor(opts: { maxSnapshotBytes: number; seedWaitMs?: number /* 5000 */; maxHeldChars?: number /* 4 * 1024 * 1024 */ })
}
// screen-worker.ts (the worker's entry; imports screen-mirror.ts, and only types from mirror-port.ts)
export function serveMirrors(port: PortLike, mirrors: ScreenMirrors): void
// at the end: if (parentPort && workerData?.screenWorker === true) serveMirrors(parentPort, new ScreenMirrors({ maxSnapshotBytes: workerData.maxSnapshotBytes }))
// mirror-port.ts (main side; imports nothing at run time from the worker's modules)
/** a worker_threads MessagePort or Worker; only a Worker emits 'error' and 'exit' and has terminate */
export interface PortLike { postMessage(m: unknown): void; on(event: 'message' | 'error' | 'exit', cb: (m: unknown) => void): unknown; terminate?(): unknown }
export type PortRequest = { op: 'open'; tabId: string; cols: number; rows: number; scrollback: number; opts: MirrorOpen } | { op: 'write'; tabId: string; seq: number; data: string }
  | { op: 'resize'; tabId: string; cols: number; rows: number } | { op: 'reset'; tabId: string; seq: number } | { op: 'close'; tabId: string }
  | { op: 'seed'; tabId: string; data: string } | { op: 'snapshot'; req: number; tabId: string }
export type PortEvent = { op: 'snapshot'; req: number; snap: RemoteSnapshot | null } | { op: 'title'; tabId: string; title: string }
export class PortMirrors implements ScreenMirrorsApi {
  constructor(port: PortLike)
  /** the worker exited or failed: waiting snapshots answer null, and so do later ones */
  onExit(cb: () => void): void
}
```

  The worker's modules (`screen-mirror.ts`, `screen-worker.ts`, `src/shared/screen-serialize.ts`, `@xterm/headless`, the addons) must not be imported at run time by anything in main (`tab-host.ts`, `mirror-port.ts` and the holder take `ScreenMirrorsApi` and `MirrorOpen` with `import type` only), and they import nothing main uses at run time (`MAX_SNAPSHOT_BYTES` comes in through `workerData`): the worker bundle then needs no shared chunk, which matters once it is unpacked from the asar (Task 11). The constants of `ScreenMirrors` (5000 ms, 4 Mi) are local to `screen-mirror.ts` for the same reason.

  A copy opened with `awaitSeed` holds its writes (with their numbers) until `seed(tabId, data)`: then it writes `data` and the held writes in order. With no seed after `seedWaitMs`, or more than `maxHeldChars` held, it writes the held output alone, and a later seed is ignored. A snapshot asked while it waits is answered once it stops waiting. The snapshot's `seq` is the number of the last chunk written into the copy (`opts.seq` before any).

- [ ] **Step 1: Write the failing tests** (`tests/fixtures/screen.ts`: `headless(cols, rows)`, `fed(cols, rows, data): Promise<Terminal>`, `replay(s: RemoteSnapshot): Promise<Terminal>` — a fresh headless terminal of the snapshot's size fed `s.data` — and `textOf(t): string[]`, its buffer lines trimmed at the right; `numbered(n)`: lines `line 0`..`line n-1`; `MessageChannel` from `node:worker_threads`)

```ts
it('a snapshot written into a fresh terminal gives the same screen and scrollback', async () => {
  m.open(T1, 40, 10, 1000); m.write(T1, 1, numbered(30)); m.write(T1, 2, '\x1b[31mred\x1b[0m')
  const s = (await m.snapshot(T1))!
  expect(s).toMatchObject({ seq: 2, cols: 40, rows: 10 })
  expect(textOf(await replay(s))).toEqual(textOf(await fed(40, 10, numbered(30) + '\x1b[31mred\x1b[0m')))
})
it('the snapshot brings back the alternate screen and the modes', async () => {
  m.open(T1, 40, 10, 1000); m.write(T1, 1, '\x1b[?1049h\x1b[?2004h\x1b[?1hTUI'); const t = await replay((await m.snapshot(T1))!)
  expect(t.buffer.active.type).toBe('alternate'); expect(t.modes.bracketedPasteMode).toBe(true)
  expect(t.modes.applicationCursorKeysMode).toBe(true); expect(textOf(t).join('\n')).toContain('TUI')
})
it('a scrollback of 1 000 000 lines is cut to fit maxSnapshotBytes, keeping the newest lines', async () => {
  const m = new ScreenMirrors({ maxSnapshotBytes: 64 * 1024 }); m.open(T1, 80, 24, 1_000_000); m.write(T1, 1, numbered(5000))
  const s = (await m.snapshot(T1))!
  expect(Buffer.byteLength(JSON.stringify(s.data))).toBeLessThanOrEqual(64 * 1024); expect(textOf(await replay(s)).join('\n')).toContain('line 4999')
})
it('a copy that waits for its seed holds the output, then shows the seed and the output after it, each once', async () => {
  m.open(T1, 40, 10, 1000, { seq: 7, awaitSeed: true }); m.write(T1, 8, 'after\r\n')
  const snap = m.snapshot(T1); m.seed(T1, 'before\r\n')
  const s = (await snap)!; expect(s.seq).toBe(8)
  expect(textOf(await replay(s)).filter((l) => l !== '')).toEqual(['before', 'after'])
})
it('without a seed in seedWaitMs the held output shows alone, and a late seed is ignored', async () => {
  const m = new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024, seedWaitMs: 50 }); m.open(T1, 40, 10, 100, { awaitSeed: true }); m.write(T1, 1, 'only')
  const s = (await m.snapshot(T1))!; m.seed(T1, 'late'); expect(textOf(await replay(s))[0]).toBe('only')
  expect(textOf(await replay((await m.snapshot(T1))!))[0]).toBe('only')
})
it('reset starts clean, resize changes the size, an empty write moves the number on, a title a program sets is reported', async () => {
  m.open(T1, 40, 10, 100); m.write(T1, 1, 'x\x1b]0;build\x07'); m.reset(T1, 2); m.resize(T1, 50, 12); m.write(T1, 3, '')
  const s = (await m.snapshot(T1))!; expect(s).toMatchObject({ seq: 3, cols: 50, rows: 12 }); expect(textOf(await replay(s))[0]).toBe(''); expect(titles).toContainEqual([T1, 'build'])
})
it('a snapshot of a tab it does not have is null', async () => expect(await m.snapshot(T9)).toBeNull())
it('boundedSerialize halves the scrollback until the text fits, down to the screen alone', () => {
  const asked: number[] = []; expect(boundedSerialize((n) => { asked.push(n); return 'x'.repeat(n) }, 1000, 300)).toHaveLength(250); expect(asked).toEqual([1000, 500, 250])
})
it('through a message port the copies answer the same', async () => {
  const { port1, port2 } = new MessageChannel(); serveMirrors(port2, new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 })); const p = new PortMirrors(port1)
  p.onTitle((id, t) => titles.push([id, t])); p.open(T1, 40, 10, 100); p.write(T1, 1, '\x1b]0;build\x07hello')
  expect((await p.snapshot(T1))!.seq).toBe(1); await until(() => titles.at(-1)?.[1] === 'build'); p.dispose(); port1.close()
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-screen-mirror.test.ts` — FAIL.
- [ ] **Step 3: Implement.** A headless `Terminal({ cols, rows, scrollback, allowProposedApi: true })` per tab with `SerializeAddon` and `Unicode11Addon` (`unicode.activeVersion = '11'`, as `terminal-view.ts`). `snapshot`: `term.write('', cb)`, then `boundedSerialize((n) => addon.serialize({ scrollback: n }), scrollback, maxSnapshotBytes)`. Both packages are CommonJS bundles: when Vitest reports a named export as not found, import the default export and take `Terminal` / `SerializeAddon` from it (the bundle accepts the same form). `PortMirrors` answers null to waiting snapshots on `dispose()` (which calls `terminate?.()`) and on the port's `'error'` or `'exit'`, then calls the `onExit` callbacks once.
- [ ] **Step 4: Run to verify they pass** — same command, three times — PASS; `npm run typecheck` — no errors. (The worker is built and checked in Task 11, where it is first imported.)
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 5: Sizes, attention and the directory

**Files:**
- Create: `src/main/sync/tab-sizes.ts`, `src/main/sync/tab-directory.ts`
- Test: `tests/unit/sync-tab-sizes.test.ts`, `tests/unit/sync-tab-directory.test.ts`

**Interfaces:**
- Consumes: `RemoteTab` (Task 2), `NotificationCase`, `MainStatus`.
- Produces:

```ts
// tab-sizes.ts — `by`: a device id; null: this device's own window
export interface AppliedSize { cols: number; rows: number; by: string | null }
export class TabSizes {
  /** this window's fitted size: applied while the window owns the tab (or nobody does yet), kept for later otherwise */
  fit(tabId: string, cols: number, rows: number): AppliedSize | null
  /** a device (null: this window) typed into the tab or switched to it and has it now; a device gives its size, the window uses its latest fit */
  claim(tabId: string, by: string | null, cols?: number, rows?: number): AppliedSize | null
  get(tabId: string): AppliedSize | null
  /** a device's link ended: the tabs it owned go back to this window, at its latest fit */
  dropViewer(by: string): Array<[string, AppliedSize]>
  drop(tabId: string): void
}
// tab-directory.ts
export class TabDirectory { diff(tabs: readonly RemoteTab[]): { changed: RemoteTab[]; closed: string[] }; all(): RemoteTab[] }
export class TabAttention {
  start(tabId: string, reason: NotificationCase): void   // reason set, seq + 1
  clear(tabId: string): boolean                          // true when it had a reason
  get(tabId: string): { reason: NotificationCase | null; seq: number }
  drop(tabId: string): void
}
/** "Opus 4.1 · 42% context" (model.displayName, context.usedPct rounded), "Opus 4.1" without a context, null without a status */
export function statusSummary(main: MainStatus | null): string | null
```

  `TabSizes` keeps per tab the applied size (cols, rows, owner) and the window's latest fit. `fit` records the fit and, while the owner is null or there is none yet, applies it. `claim(tab, by, c, r)` for a device applies `{ c, r, by }`. `claim(tab, null)` makes the window the owner at its latest fit, or, without a fit, at the applied size. Both return the new applied size when the owner or the size changed, else null (also when nothing is known about the tab).

- [ ] **Step 1: Write the failing tests**

```ts
it("with no other device the window's sizes apply, as today", () => {
  expect(s.fit(T1, 120, 30)).toEqual({ cols: 120, rows: 30, by: null }); expect(s.fit(T1, 120, 30)).toBeNull()
  expect(s.fit(T1, 100, 30)).toEqual({ cols: 100, rows: 30, by: null })
})
it("a device that claims the tab sizes it; the window's fits wait", () => {
  s.fit(T1, 120, 30); expect(s.claim(T1, B, 80, 24)).toEqual({ cols: 80, rows: 24, by: B })
  expect(s.fit(T1, 130, 40)).toBeNull(); expect(s.get(T1)).toEqual({ cols: 80, rows: 24, by: B })
})
it('the window takes the tab back at its latest fit', () => {
  s.fit(T1, 120, 30); s.claim(T1, B, 80, 24); s.fit(T1, 130, 40); expect(s.claim(T1, null)).toEqual({ cols: 130, rows: 40, by: null })
})
it('two devices typing in turn resize once per change of hands, never per keystroke', () => {
  // no fit of the window in this test: its claim keeps the applied size and changes only the owner
  expect(s.claim(T1, B, 80, 24)).not.toBeNull(); expect(s.claim(T1, B, 80, 24)).toBeNull()
  expect(s.claim(T1, null)).toEqual({ cols: 80, rows: 24, by: null }); expect(s.claim(T1, null)).toBeNull(); expect(s.claim(T1, B, 80, 24)).not.toBeNull()
})
it('the same size from another device changes only the owner', () => {
  s.claim(T1, B, 80, 24); expect(s.claim(T1, C, 80, 24)).toEqual({ cols: 80, rows: 24, by: C })
})
it('a device that goes gives its tabs back to the window', () => {
  s.fit(T1, 130, 40); s.claim(T1, B, 80, 24); expect(s.dropViewer(B)).toEqual([[T1, { cols: 130, rows: 40, by: null }]])
})
```

```ts
it('diff reports the new and the changed entries once, then nothing for the same list', () => {
  expect(d.diff([tab(T1)]).changed).toHaveLength(1); expect(d.diff([tab(T1, { muted: true })]).changed).toHaveLength(1); expect(d.diff([tab(T1, { muted: true })])).toEqual({ changed: [], closed: [] })
})
it('a tab gone from the list is reported closed once', () => { d.diff([tab(T1)]); expect(d.diff([]).closed).toEqual([T1]); expect(d.diff([]).closed).toEqual([]) })
it('each attention that starts raises the number; clear forgets the reason and says whether there was one', () => {
  a.start(T1, 'permission'); a.start(T1, 'done'); expect(a.get(T1)).toEqual({ reason: 'done', seq: 2 }); expect(a.clear(T1)).toBe(true); expect(a.clear(T1)).toBe(false); expect(a.get(T1)).toEqual({ reason: null, seq: 2 })
})
it('statusSummary', () => {
  expect(statusSummary(main('Opus 4.1', 41.6))).toBe('Opus 4.1 · 42% context'); expect(statusSummary(main('Opus 4.1', null))).toBe('Opus 4.1'); expect(statusSummary(null)).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-tab-sizes.test.ts tests/unit/sync-tab-directory.test.ts` — FAIL.
- [ ] **Step 3: Implement** both files (`diff` compares the JSON of each entry with the last one announced).
- [ ] **Step 4: Run to verify they pass** — same command — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 6: Serving this device's tabs: TabHost

**Files:**
- Create: `src/main/sync/tab-host.ts`
- Modify: `tests/fixtures/sync.ts` (move `linkPair` out of `sync-peer-link.int.test.ts`, keeping its signature `linkPair(opts?, serverOpts?)` and its return `{ client, server, clientSocket, serverSocket }`, and export it with `closeLinkPairs(): Promise<void>` for `afterEach`), `tests/integration/sync-peer-link.int.test.ts` (import it)
- Test: `tests/integration/sync-tab-host.int.test.ts`

**Interfaces:**
- Consumes: `PeerLink.send`/`sendBulk`/`backlog` (Task 1); `RemoteMessage`, `Calls`, `CallEntry`, `CallError`, `REMOTE_COPY.unknownTab`, `MAX_OUT_CHARS`, `DETACH_BACKLOG_BYTES` (Task 2); `CALL_ARGS.attach` (Task 3); `ScreenMirrorsApi` (Task 4, type); `TabDirectory` (Task 5).
- Produces:

```ts
export interface HostTabs {
  list(): RemoteTab[]
  has(tabId: string): boolean
  input(tabId: string, data: string, from: string): void
  claim(tabId: string, from: string, cols: number, rows: number): void
  /** the tab of this device in front on a member's window; null: none of them */
  front(from: string, tabId: string | null): void
  /** the tab's current hub updates, for a member that attaches */
  pushes(tabId: string): Array<{ k: PushKind; v: unknown }>
}
export interface TabHostDeps { tabs: HostTabs; mirrors: ScreenMirrorsApi; detachBacklogBytes?: number; onPeerGone?(device: string): void; onWatchers?(): void }
export class TabHost {
  constructor(deps: TabHostDeps)
  /** sends the whole directory, reads in / claim / front, and removes the member on the link's 'close' */
  addPeer(link: PeerLink, device: string): void
  removePeer(link: PeerLink): void
  /** the calls this side answers for that member: attach */
  handlers(device: string): Record<string, CallEntry>
  changed(): void
  /** a tab it does not have yet: its copy opens at number 0; one it has (a new worker): the copy opens again at the tab's current number. awaitSeed: see Task 4 */
  opened(tabId: string, cols: number, rows: number, scrollback: number, opts?: { awaitSeed?: boolean }): void
  seed(tabId: string, data: string): void
  closed(tabId: string): void
  resized(tabId: string, cols: number, rows: number): void
  output(tabId: string, data: string): void
  reset(tabId: string): void
  exit(tabId: string, code: number): void
  push(tabId: string, k: PushKind, v: unknown): void
  /** the members attached to the tab */
  watchers(tabId: string): string[]
  peers(): string[]
  dispose(): void
}
```

  Behavior: `opened` always calls `mirrors.open(tabId, cols, rows, scrollback, { seq: <the tab's current number>, awaitSeed: opts?.awaitSeed === true })` — both fields every time (the number is 0 for a tab it did not have yet), so Task 10's test can compare the options whole. `addPeer` runs `changed()` then sends `{ t: 'tabs', tabs: directory.all() }`; `changed()` sends `tab` / `tab-closed` for the diff to every member. `attach` (`bulk: true`, `key: (a) => CALL_ARGS.attach(a)?.id ?? null`, so a newer attach reply for the same tab replaces a queued older one): arguments by `CALL_ARGS.attach`, an unknown tab → `CallError(REMOTE_COPY.unknownTab)`; the member becomes a watcher first, gets `tabs.pushes(id)` (`review` through `sendBulk`, the others `send`), and the reply is `await mirrors.snapshot(id)`; a null snapshot → `CallError('no screen')`. `output`: pieces of at most `MAX_OUT_CHARS`, a cut that would fall between the two halves of a surrogate pair moved one unit earlier, each piece with `++seq` → `mirrors.write(id, seq, piece)` → to each watcher `{ t: 'out', … }`, unless its link's `backlog()` is over `detachBacklogBytes`: then it stops watching and gets `{ t: 'detached', id }`. `reset` → `++seq`, `mirrors.reset`, `{ t: 'reset' }`; `exit` → `++seq`, `mirrors.write(id, seq, '')`, `{ t: 'exit' }`. `push` goes to watchers (`review` through `sendBulk`). `in`/`claim`/`front` for a tab `tabs.has` does not know are dropped (`front` with `id: null` is passed on). `onWatchers` fires when watchers change; `onPeerGone(device)` when a member is removed.

- [ ] **Step 1: Write the failing tests** (a `linkPair()`; host side `TabHost` with a fake `HostTabs` (`fake.entries`, and `fake.inputs`, `fake.claims`, `fake.fronts` recording calls) and an in-process `ScreenMirrors`; member side a `Calls` on the other link with no handlers; `got`: every message the member's link emits; `outs()`: the `out` messages in `got`)

```ts
it('the directory goes to a member when the link comes up, and the changes follow', async () => {
  host.addPeer(hostLink, VIEWER); await until(() => got.some((m) => m.t === 'tabs'))
  fake.entries = [tab(T1, { muted: true }), tab(T2)]; host.changed()
  await until(() => got.filter((m) => m.t === 'tab').length === 2)
  fake.entries = [tab(T2)]; host.changed(); await until(() => got.some((m) => m.t === 'tab-closed' && m.id === T1))
})
it('attach answers a snapshot with its number, and later output follows numbered from it', async () => {
  host.opened(T1, 40, 10, 1000); host.output(T1, 'before\r\n')
  const snap = CALL_REPLIES.attach(await viewer.call('attach', { id: T1 }))!
  expect(snap.seq).toBe(1); host.output(T1, 'after')
  await until(() => outs().length === 1); expect(outs()[0]).toEqual({ t: 'out', id: T1, seq: 2, d: 'after' })
})
it('a burst longer than MAX_OUT_CHARS goes in numbered pieces that join to the same text, none ending inside a surrogate pair', async () => {
  // after host.opened, one earlier output (seq 1) and an attach; the leading 'a' puts every MAX_OUT_CHARS boundary inside a pair
  const text = 'a' + '😀'.repeat(MAX_OUT_CHARS) + '\x1b[31mend'; host.output(T1, text)
  await until(() => outs().map((o) => o.d).join('') === text); expect(outs().map((o) => o.seq)).toEqual([2, 3, 4])
  for (const o of outs()) expect(o.d).not.toMatch(/[\ud800-\udbff]$/)
})
it("the tab's hub updates come with the attach and after it", async () => {
  fake.pushList = [{ k: 'status', v: status() }]; await viewer.call('attach', { id: T1 }); host.push(T1, 'plan', null)
  await until(() => got.filter((m) => m.t === 'push').length === 2); expect(got.filter((m) => m.t === 'push').map((m) => m.k)).toEqual(['status', 'plan'])
})
it("input, claims and the tab in front reach the tab's device; for a tab it does not have, nothing", async () => {
  memberLink.send({ t: 'in', id: T9, d: 'x' }); memberLink.send({ t: 'claim', id: T9, cols: 80, rows: 24 }); memberLink.send({ t: 'in', id: T1, d: 'ls\r' })   // the last is the marker
  await until(() => fake.inputs.length === 1); expect(fake.inputs).toEqual([[T1, 'ls\r', VIEWER]]); expect(fake.claims).toEqual([])
  memberLink.send({ t: 'front', id: null }); await until(() => fake.fronts.length === 1); expect(fake.fronts).toEqual([[VIEWER, null]])
})
it('attach for a tab it does not have is refused', async () => await expect(viewer.call('attach', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab))
it('a copy with no screen (the worker is gone) refuses the attach', async () => {
  // mirrors: a fake whose snapshot() answers null
  await expect(viewer.call('attach', { id: T1 })).rejects.toThrow('no screen')
})
it('five attaches for one tab answered at once send one snapshot: a newer reply replaces a queued one', async () => {
  // mirrors: gatedMirrors() — snapshot() waits until gate.release(); the member's calls use timeoutMs 1000
  const calls = [1, 2, 3, 4, 5].map(() => viewer.call('attach', { id: T1 }, { timeoutMs: 1000 }).then(() => 'ok', (e: Error) => e.message))
  await until(() => gate.pending === 5); gate.release()
  expect(await Promise.all(calls)).toEqual(['timeout', 'timeout', 'timeout', 'timeout', 'ok'])
  expect(got.filter((m) => m.t === 'reply')).toHaveLength(1)
})
it('a member that cannot keep up is detached from the tab, not buffered', async () => {
  // mirrors: a no-op ScreenMirrorsApi fake (snapshot answers an empty snapshot), so 25 MiB is not parsed; detachBacklogBytes 64 KiB;
  // attached; the member's socket paused; 400 outputs of 64 KiB; then resumed
  await until(() => got.some((m) => m.t === 'detached')); expect(outs().length).toBeLessThan(400); expect(host.watchers(T1)).toEqual([])
})
it('seed reaches the copy of a tab opened to wait for it', async () => {
  host.opened(T2, 40, 10, 100, { awaitSeed: true }); host.seed(T2, 'seeded'); const snap = CALL_REPLIES.attach(await viewer.call('attach', { id: T2 }))!
  expect(textOf(await replay(snap))[0]).toBe('seeded')
})
it('the directory and the stream stop when the link ends', async () => {
  hostLink.close('test'); await until(() => gone.length === 1); expect(gone).toEqual([VIEWER])
  expect(() => { host.output(T1, 'x'); host.changed() }).not.toThrow(); expect(host.peers()).toEqual([])
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/sync-tab-host.int.test.ts tests/integration/sync-peer-link.int.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `TabHost`, and move `linkPair`.
- [ ] **Step 4: Run to verify they pass** — same command, three times — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 7: Viewing other devices' tabs: RemoteTabs

**Files:**
- Create: `src/main/sync/attached-view.ts`, `src/main/sync/tab-viewer.ts`, `src/main/sync/remote-link.ts`
- Test: `tests/unit/sync-attached-view.test.ts`, `tests/integration/sync-remote-tabs.int.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3 (`CALL_REPLIES.attach`, `parsePush`, `PushValue`), 6 (`TabHost`); `HelloMessage`, `DeviceView`.
- Produces:

```ts
// attached-view.ts
export type StreamItem = { t: 'out'; seq: number; d: string } | { t: 'reset'; seq: number } | { t: 'exit'; seq: number; code: number }
export type ViewStep = { kind: 'write'; data: string } | { kind: 'reset' } | { kind: 'exit'; code: number } | { kind: 'reattach' }
export const MAX_WAITING_CHARS = 4 * 1024 * 1024
export class AttachedView { get ready(): boolean; stream(m: StreamItem): ViewStep[]; snapshot(s: RemoteSnapshot): ViewStep[] }
// tab-viewer.ts
export interface ViewerEvents {
  opened(device: string, tab: RemoteTab): void
  updated(device: string, tab: RemoteTab, before: RemoteTab): void
  closed(tabId: string): void
  devices(list: RemoteDeviceView[]): void
  data(tabId: string, data: string): void
  reset(tabId: string): void
  exit(tabId: string, code: number): void
  /** null: the tab is sized for this window, which fits it; otherwise it keeps that size here */
  size(tabId: string, size: { cols: number; rows: number } | null): void
  /** fresh: an attention that just started; not fresh: one the tab already had when its device came */
  attention(tabId: string, reason: NotificationCase, fresh: boolean): void
  attentionCleared(tabId: string): void
  push(tabId: string, value: PushValue): void
}
export interface RemoteTabsDeps { selfId(): string; isLocal(tabId: string): boolean; events: ViewerEvents; reattachMs?: number }  // REATTACH_MS
export class RemoteTabs {
  constructor(deps: RemoteTabsDeps)
  addPeer(link: PeerLink, hello: HelloMessage, calls: Calls): void
  /** the device goes offline: its tabs stay, input to them is dropped */
  removePeer(link: PeerLink): void
  /** names from the group; a device no longer listed is forgotten with its tabs */
  members(devices: readonly DeviceView[]): void
  has(tabId: string): boolean
  deviceOf(tabId: string): string | null
  tab(tabId: string): RemoteTab | null
  tabsOf(device: string): RemoteTab[]
  /** every device seen this run, by name */
  devices(): RemoteDeviceView[]
  online(device: string): boolean
  callsOf(device: string): Calls | null
  /** the tab in front in this window: a remote one, a local one or none */
  activated(tabId: string | null): void
  /** this window's fitted size for a remote tab */
  fit(tabId: string, cols: number, rows: number): void
  input(tabId: string, data: string): void
  dispose(): void
}
// remote-link.ts
export function connectPeer(link: PeerLink, hello: HelloMessage, host: TabHost, viewer: RemoteTabs, handlers: Record<string, CallEntry>): Calls
```

  `AttachedView`: before the snapshot, stream items wait (more than `MAX_WAITING_CHARS` waiting → `[reattach]`); `snapshot(s)` gives `[reset, write(s.data)]` and then the waiting items after `s.seq` in order, or `[reattach]` when they do not start at `s.seq + 1`; once ready, each item must be the next number, else `[reattach]`.

  `RemoteTabs`: a `tabs` message replaces the device's list (new → `opened`, changed → `updated`, missing → `closed`); an entry whose id `isLocal` or belongs to another device is ignored, and so is a `tab` that would take the device past `MAX_REMOTE_TABS`. The first switch to a tab of an online device attaches: `calls.call('attach', { id }, { timeoutMs: ATTACH_TIMEOUT_MS })`, checked with `CALL_REPLIES.attach`; at most one attach per tab is in flight, and the answer of an attach that a newer one replaced is ignored. Then `events.size(id, { cols, rows })` of the snapshot before its steps, and `size(id, null)` after when `size.by` is this device. A failed attach (a timeout, a refusal, a bad reply) is treated like `detached`: `detached`, `reattach` and a failed attach all attach again after `reattachMs` when the tab is in front (and no attach is in flight), else at the next switch. When a device comes back, every tab that was attached is attached again (a fresh snapshot). `activated` sends `{ t: 'front', id }` to the tab's device and `{ t: 'front', id: null }` to the device that had the front before, and claims the tab with the window's latest fit for it; when no fit is known yet, the first `fit` for it while it is in front sends the claim. Fits for a tab that was never activated here are ignored (the renderer measures a hidden terminal at 80×24). `input` on a tab not sized for this device sends a `claim` with the latest fit first, then `in` (pieces of at most `MAX_INPUT_CHARS`); input to a tab of an offline device is dropped. A tab this device claimed counts as its own until the directory names another device, so `fit` changes on it are sent as claims. `size` follows every directory change of `size`; `attention`: fresh when `attentionSeq` grew with a reason, not fresh for a reason on the first list of a device; `attentionCleared` when the reason went to null. `connectPeer`: `new Calls(link, { ...handlers, ...host.handlers(hello.id) })`, `host.addPeer(link, hello.id)`, `viewer.addPeer(link, hello, calls)`; on the link's `'close'`: `calls.close()` and `viewer.removePeer(link)`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/sync-attached-view.test.ts` (`out(seq, d)`, `reset(seq)`, `exit(seq, code)`: stream items; `readyAt(n)`: a new `AttachedView` that has taken the snapshot `{ seq: n, data: '', cols: 80, rows: 24 }`, so it is ready and expects `n + 1` next):

```ts
it('stream items before the snapshot wait; those it covers are dropped', () => {
  const v = new AttachedView(); expect(v.stream(out(5, 'e'))).toEqual([]); expect(v.stream(out(6, 'f'))).toEqual([])
  expect(v.snapshot({ seq: 5, data: 'SNAP', cols: 80, rows: 24 })).toEqual([{ kind: 'reset' }, { kind: 'write', data: 'SNAP' }, { kind: 'write', data: 'f' }])
  expect(v.stream(out(7, 'g'))).toEqual([{ kind: 'write', data: 'g' }])
})
it('a gap asks for a fresh attach', () => { const v = readyAt(7); expect(v.stream(out(9, 'x'))).toEqual([{ kind: 'reattach' }]) })
it('a gap between the snapshot and what waited asks for a fresh attach', () => {
  const v = new AttachedView(); v.stream(out(8, 'x')); expect(v.snapshot({ seq: 5, data: '', cols: 80, rows: 24 })).toEqual([{ kind: 'reattach' }])
})
it('reset and exit in the stream', () => { const v = readyAt(7); expect(v.stream(reset(8))).toEqual([{ kind: 'reset' }]); expect(v.stream(exit(9, 0))).toEqual([{ kind: 'exit', code: 0 }]) })
it('too much waiting before the snapshot asks for a fresh attach', () => {
  const v = new AttachedView(); v.stream(out(1, 'x'.repeat(MAX_WAITING_CHARS))); expect(v.stream(out(2, 'x'))).toEqual([{ kind: 'reattach' }])
})
```

`tests/integration/sync-remote-tabs.int.test.ts` — each end of a `linkPair()` is a device with its own `TabHost` and `RemoteTabs` joined by `connectPeer`: device A's `TabHost` over a fake `HostTabs` (`fakeA`) and an in-process `ScreenMirrors`; device B's `TabHost` over an empty fake and a `RemoteTabs` with recording events. Helpers: `written(id)` (the `data` events for a tab, joined), `steps(id)` (the event names for a tab in order), `sizes(id)` (its `size` events), `sendAsA(m)` (a raw message from A's link):

```ts
it("the other device's directory shows as its tabs, and the changes follow", async () => {
  fakeA.entries = [tab(T1)]; hostA.changed(); await until(() => viewer.has(T1))
  fakeA.entries = [tab(T1, { customTitle: 'build' })]; hostA.changed(); await until(() => viewer.tab(T1)?.customTitle === 'build')
  fakeA.entries = []; hostA.changed(); await until(() => !viewer.has(T1)); expect(steps(T1)).toEqual(['opened', 'updated', 'closed'])
})
it('switching to a tab attaches: the screen and the scrollback come first, then the stream', async () => {
  hostA.opened(T1, 40, 10, 1000); hostA.output(T1, 'earlier\r\n'); viewer.activated(T1)
  await until(() => written(T1).includes('earlier')); hostA.output(T1, 'later'); await until(() => written(T1).endsWith('later'))
  expect(steps(T1)[1]).toBe('reset'); expect(sizes(T1)[0]).toEqual({ cols: 40, rows: 10 })
})
it('the screen here equals the screen there after a burst with emoji and an escape sequence across piece boundaries', async () => {
  const burst = 'a' + '😀'.repeat(MAX_OUT_CHARS) + '\x1b[1;31mred\x1b[0m\r\nend'; hostA.output(T1, burst)   // after an attach
  await until(() => written(T1).endsWith('end'))
  expect(textOf(await fed(40, 10, written(T1)))).toEqual(textOf(await replay((await mirrorsA.snapshot(T1))!)))
})
it("input reaches the tab on its device, after a claim at this window's size", async () => {
  viewer.activated(T1); viewer.fit(T1, 90, 20); viewer.input(T1, 'ls\r')
  await until(() => fakeA.inputs.length === 1); expect(fakeA.claims).toEqual([[T1, B_ID, 90, 20]]); expect(fakeA.inputs).toEqual([[T1, 'ls\r', B_ID]])
})
it('a device that goes leaves its tabs offline and drops input to them; when it comes back they come back from a fresh snapshot', async () => {
  // attached to T1; the link closed → viewer.online(A_ID) false, viewer.has(T1) true; viewer.input(T1, 'lost') → nothing (a new linkPair is the marker);
  // a new linkPair and connectPeer on both ends → a second 'reset' step for T1 and written(T1) holds the snapshot again; fakeA.inputs never holds 'lost'
})
it("a tab announced with the id of a local tab or of another device's tab is ignored", async () => {
  // isLocal(T_LOCAL) is true; a second device C (its own linkPair, connectPeer) already announced T_C
  sendAsA({ t: 'tabs', tabs: [tab(T_LOCAL), tab(T_C), tab(T1)] }); await until(() => viewer.has(T1))   // T1 is the marker
  expect(viewer.deviceOf(T_LOCAL)).toBeNull(); expect(viewer.deviceOf(T_C)).toBe(C_ID); expect(viewer.tabsOf(A_ID).map((t) => t.id)).toEqual([T1])
  sendAsA({ t: 'tab', tab: tab(T_C, { customTitle: 'stolen' }) }); sendAsA({ t: 'tab', tab: tab(T2) }); await until(() => viewer.has(T2))
  expect(viewer.tab(T_C)?.customTitle).not.toBe('stolen')
})
it('a device cannot announce more than MAX_REMOTE_TABS tabs', async () => {
  // A sends one 'tabs' with MAX_REMOTE_TABS entries, then single 'tab' messages for two more ids, then a 'tab-closed' of the first as the marker
  // → after the marker, viewer.tabsOf(A_ID).length === MAX_REMOTE_TABS - 1 and neither extra id is known
})
it('the tab in front is told to its device, and none once the window goes to a local tab', async () => {
  viewer.activated(T1); await until(() => fakeA.fronts.length === 1); viewer.activated(T_LOCAL)
  await until(() => fakeA.fronts.length === 2); expect(fakeA.fronts).toEqual([[B_ID, T1], [B_ID, null]])
})
it('a tab sized for this device fits; one sized for another keeps that size here', async () => {
  fakeA.entries = [tab(T1, { size: { cols: 80, rows: 24, by: B_ID } })]; hostA.changed(); await until(() => sizes(T1).length === 1); expect(sizes(T1).at(-1)).toBeNull()
  fakeA.entries = [tab(T1, { size: { cols: 100, rows: 30, by: C_ID } })]; hostA.changed(); await until(() => sizes(T1).length === 2); expect(sizes(T1).at(-1)).toEqual({ cols: 100, rows: 30 })
})
it('an attention that starts is fresh; one the tab had when its device came is not; a clear is reported', async () => {
  // first list holds T1 with attention 'permission', seq 1 → attention(T1, 'permission', false); then seq 2 'done' → attention(T1, 'done', true); then null → attentionCleared(T1)
})
it('a detached tab in front is attached again', async () => {
  viewer.activated(T1); await until(() => steps(T1).includes('reset')); sendAsA({ t: 'detached', id: T1 })
  await until(() => steps(T1).filter((s) => s === 'reset').length === 2)
})
it('a failed attach of the tab in front is tried again after reattachMs, without another switch', async () => {
  // reattachMs 50; mirrorsA in this test: a fake that counts its snapshot() calls in `snapshots`, answers null ('no screen') to the first and an empty snapshot after
  viewer.activated(T1); await until(() => steps(T1).includes('reset')); expect(mirrorsA.snapshots).toBe(2)
})
it('fits of a tab never activated here are not claims', async () => {
  viewer.fit(T1, 80, 24); viewer.activated(T2); await until(() => fakeA.fronts.length === 1); expect(fakeA.claims.filter(([id]) => id === T1)).toEqual([])
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-attached-view.test.ts tests/integration/sync-remote-tabs.int.test.ts` — FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run to verify they pass** — same command, three times — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 8: TabManager and the hubs

**Files:**
- Modify: `src/main/tab-manager.ts`, `src/main/image-hub.ts`, `src/main/review-hub.ts`, `src/main/note-hub.ts`
- Test: `tests/unit/tab-manager.test.ts`, `tests/unit/image-hub.test.ts`, `tests/unit/review-hub.test.ts`, `tests/unit/note-hub.test.ts`

**Interfaces:**
- Produces:
  - `TabManager.changeFolder(tabId: string, cwd: string): Promise<boolean>` — false for an unknown or restarting tab. Sets `info.cwd`, a Claude tab's `claudeSessionId` to null, emits `updated`, calls `deps.onTabFolderChanged?.(tab)` with the new info, re-resolves the launch (`{ kind: 'claude', cwd, resumeSessionId: null, account: info.account }` or `{ kind: 'shell', cwd, profile: info.profile }`), relaunches like `restart(id, { live: true })` and reports `changed()`. `TabManagerDeps.onTabFolderChanged?(tab: TabInfo): void`.
  - `TabManager.size(tabId: string): { cols: number; rows: number } | null`; `isWorking(tabId: string): boolean`; `deactivate(): void` (no tab of this device is in front — a remote one is; no event).
  - `ImageHub.resetTab(tabId: string, cwd: string): void` — cards, unseen, notice and temp folder go; later cards' `relPath` counts from `cwd`; `onChange(tabId)`; no-op for an unknown tab.
  - `ReviewHub.resetTab(tabId: string, cwd: string): void` — the tab starts again for `cwd` as a new tab with the same id and `claude` flag (session, ledger, scope, request, viewed marks, dialogs and `last` gone), and computes at once when it is in front. `ReviewHubDeps.remoteFront?(tabId: string): boolean` — `trigger` also computes a tab another device has in front.
  - `NoteHub.addTab(tabId: string, sessionId: string | null, opts?: { remote?: boolean })` — for a remote tab, `session()` only gives the stored note of the new conversation (or null, through `give(tabId, tab, null)`, the path `external` uses) and never writes the store; its edits are stored as a local tab's are.

- [ ] **Step 1: Write the failing tests**

```ts
// tab-manager.test.ts — setup() gains `launches` (every request resolveLaunch got) and `folderChanged` ([id, cwd] from onTabFolderChanged);
// FakePty never exits, so these tests pass restartWaitMs: 0
it('changeFolder restarts the tab in the new folder; a Claude tab starts a new conversation', async () => {
  const { tm, ptys, launches, folderChanged, log } = setup({ restartWaitMs: 0 })
  const t = tm.open({ kind: 'claude', cwd: '/a', resumeSessionId: SID_A })!; await tm.changeFolder(t.id, '/b')
  expect(ptys.at(-1)!.opts.cwd).toBe('/b'); expect(launches.at(-1)).toMatchObject({ kind: 'claude', cwd: '/b', resumeSessionId: null })
  expect(tm.get(t.id)).toMatchObject({ cwd: '/b', claudeSessionId: null }); expect(folderChanged).toEqual([[t.id, '/b']]); expect(log).toContain(`reset:${t.id}`)
})
it('changeFolder of a shell tab keeps its profile; of an unknown tab answers false', async () => {
  // a shell tab with profile 'Bash' → launches.at(-1) has profile 'Bash'; changeFolder('nope', '/b') → false
})
it('size, isWorking and deactivate', () => {
  // size(t.id) → { cols: 120, rows: 30 } after open, { 90, 20 } after resize; isWorking follows setWorking; deactivate() emits nothing and activeTabId() stays
})
// image-hub.test.ts
it('resetTab drops the cards and counts relPaths from the new folder', () => {
  // a card under /a; resetTab(T1, '/b') → list(T1) [], unseenCount 0, onChange(T1); a card added under /b/x.png has relPath 'x.png'
})
// review-hub.test.ts
it('resetTab starts the tab again in the new folder', async () => {
  // a viewed mark set; resetTab(T1, '/b') → the next update's folder is '/b' and no file is viewed
})
it('trigger computes a tab another device has in front', async () => {
  // remoteFront: (id) => id === T2; T1 active; trigger(T2) → an update for T2 is published
})
// note-hub.test.ts (setup() as in the file: { hub, published, sets }; const beta: Note = { text: 'beta', shown: true, form: 'card' })
it('a remote tab takes the stored note of its new conversation and writes nothing', () => {
  const { hub, published, sets } = setup({ [A]: alpha, [B]: beta })
  hub.addTab('t1', A, { remote: true }); hub.setText('t1', 'typed here', 1); hub.session('t1', B)
  expect(published.at(-1)).toEqual(['t1', beta, 2]); hub.session('t1', C); expect(published.at(-1)).toEqual(['t1', null, 3])
  expect(sets.map(([id]) => id)).toEqual([A])   // only the edit typed here; nothing moved to B or C
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/tab-manager.test.ts tests/unit/image-hub.test.ts tests/unit/review-hub.test.ts tests/unit/note-hub.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — same command — PASS (whole files).
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 9: Tab calls on both sides

**Files:**
- Create: `src/main/remote-host.ts`, `src/main/sync/remote-actions.ts`
- Modify: `src/shared/types.ts` (`TabRemote`, `TabInfo.remote?`)
- Test: `tests/unit/remote-host.test.ts`, `tests/integration/sync-remote-actions.int.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:

```ts
// types.ts — on a tab that runs on another device
export interface TabRemote { device: string; accountName: string | null; images: number; title: string | null }
// TabInfo gains: remote?: TabRemote
// remote-host.ts
export interface HostContext {
  tabs: Pick<TabManager, 'list' | 'get' | 'close' | 'rename' | 'setMuted' | 'restart' | 'switchAccount' | 'isWorking' | 'size'>
  images: Pick<ImageHub, 'list' | 'unseenCount' | 'notice'>
  status: Pick<StatusHub, 'get'>
  plan: Pick<PlanHub, 'get'>
  notes: Pick<NoteHub, 'get'>
  accounts: Pick<AccountStore, 'list' | 'nameOf'>
  sizes: TabSizes
  attention: TabAttention
  titles: ReadonlyMap<string, string>
  /** the last review update published for each tab */
  reviews: ReadonlyMap<string, ReviewUpdate>
  profiles(): string[]
  /** opens a tab in this device's default folder without bringing it to the front of this window */
  openTab(req: CallArgs['open-tab']): TabInfo | null
  writeInput(tabId: string, data: string, from: string | null): void
  claim(tabId: string, from: string, cols: number, rows: number): void
  front(from: string, tabId: string | null): void
}
export function hostTabs(ctx: HostContext): HostTabs
export function hostHandlers(ctx: HostContext): Record<string, CallEntry>   // later tasks add their methods here
// sync/remote-actions.ts
export class RemoteActions {
  constructor(tabs: RemoteTabs, toast: (m: string) => void)
  ask<M extends CallMethod>(device: string, m: M, a: CallArgs[M], opts?: { timeoutMs?: number; bulk?: boolean }): Promise<CallReplies[M]>
  askTab<M extends CallMethod>(tabId: string, m: M, a: CallArgs[M], opts?: { timeoutMs?: number; bulk?: boolean }): Promise<CallReplies[M]>
  close(tabId: string): void
  rename(tabId: string, title: string | null): void
  mute(tabId: string, muted: boolean): void
  restart(tabId: string, live: boolean): void
  switchAccount(tabId: string, account: string | null): Promise<boolean>
}
export function remoteTabInfo(device: string, tab: RemoteTab): TabInfo
```

  `hostTabs(ctx).list()` maps every tab: `title` from `titles`, `accountName` from `accounts.nameOf`, `working` from `isWorking`, `attention`/`attentionSeq` from `attention.get`, `images` from `unseenCount`, `note` = the note has text, `counter` = `reviews.get(id)?.counter ?? null`, `status` = `statusSummary(status.get(id).main)`, `size` = `sizes.get(id)` or the tab's own size with `by: null`. `pushes(id)`: `status` `{ main, agents }`, `plan` (the plan or null), `images` `{ cards, unseen, notice }`, and `review` (the last update without `tabId`) when there is one, in that order. `hostHandlers` here: `open-tab`, `close`, `restart`, `rename`, `mute`, `switch-account`, `profiles`, `accounts` (ids and names only). Each checks its arguments with `CALL_ARGS` (`CallError('bad arguments')`) and refuses a tab `ctx.tabs.get` does not know with `CallError(REMOTE_COPY.unknownTab)`. `ask`: an offline device rejects with `CallError(REMOTE_COPY.deviceOffline(name))`, a timeout with `REMOTE_COPY.noAnswer(name)`, a reply `CALL_REPLIES[m]` refuses with `'bad reply'`. The fire-and-forget methods toast a failure. `remoteTabInfo`: the `TabInfo` fields of the entry plus `remote: { device, accountName, images, title }`.

- [ ] **Step 1: Write the failing tests**

```ts
// remote-host.test.ts (a fake HostContext whose tabs record `renamed`, `muted`, `restarted` and `switched` as [id, value]; ACC_WORK: the id of its account 'Work'; run(m, a) = hostHandlers(ctx)[m].run(a))
it('the directory entry of a tab says what the other devices show', () => {
  expect(hostTabs(ctx).list()[0]).toMatchObject({ accountName: 'Work', size: { cols: 80, rows: 24, by: B_ID }, attention: 'permission', status: 'Opus 4.1 · 42% context', note: true, title: 'vim' })
})
it('pushes give status, plan, images and the last review, in that order', () => expect(hostTabs(ctx).pushes(T1).map((p) => p.k)).toEqual(['status', 'plan', 'images', 'review']))
it('a call about a tab this device does not have is refused', async () => await expect(run('close', { id: T9 })).rejects.toThrow(REMOTE_COPY.unknownTab))
it('open-tab opens in the default folder without bringing the tab to the front, and answers its id', async () => {
  expect(await run('open-tab', { kind: 'shell', profile: 'Bash', account: null, resume: null })).toEqual({ id: T3 }); expect(ctx.opened).toEqual([{ kind: 'shell', profile: 'Bash', account: null, resume: null }])
})
it('rename, mute, restart and switch-account reach the tab; profiles and accounts answer names and ids, never tokens', async () => {
  await run('rename', { id: T1, title: 'x' }); expect(ctx.renamed).toEqual([[T1, 'x']])
  await run('mute', { id: T1, muted: true }); expect(ctx.muted).toEqual([[T1, true]])
  await run('restart', { id: T1, live: true }); expect(ctx.restarted).toEqual([[T1, true]])
  await run('switch-account', { id: T1, account: ACC_WORK }); expect(ctx.switched).toEqual([[T1, ACC_WORK]])
  expect(JSON.stringify(await run('accounts', {}))).not.toContain('token')
})
// sync-remote-actions.int.test.ts (A answers with hostHandlers(fake ctx); B asks through RemoteActions; each end a device as in Task 7)
it('rename from B renames the tab on A', async () => { actions.rename(T1, 'build'); await until(() => ctx.renamed.length === 1); expect(ctx.renamed).toEqual([[T1, 'build']]) })
it('a list call answers what the other device has', async () => expect(await actions.ask(A_ID, 'profiles', {})).toEqual(['Bash', 'Zsh']))
it('a call to a device that is offline is refused with its name', async () => {
  pair.client.close('test'); await until(() => !viewer.online(A_ID)); await expect(actions.ask(A_ID, 'profiles', {})).rejects.toThrow(REMOTE_COPY.deviceOffline('Studio'))
})
it('a reply of the wrong shape is refused', async () => { ctx.profilesAnswer = 42; await expect(actions.ask(A_ID, 'profiles', {})).rejects.toThrow('bad reply') })
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/remote-host.test.ts tests/integration/sync-remote-actions.int.test.ts` — FAIL.
- [ ] **Step 3: Implement** both files and the type.
- [ ] **Step 4: Run to verify they pass** — same command — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 10: The remote holder

**Files:**
- Create: `src/main/remote-holder.ts`
- Modify: `src/main/sync/device-group.ts` (`onPeer`), `src/main/sync/mirror-port.ts` (`screenWorkerPath`)
- Test: `tests/integration/sync-device-group.int.test.ts`, `tests/integration/remote-holder.int.test.ts`, `tests/unit/sync-mirror-port.test.ts`

**Interfaces:**
- Consumes: Tasks 4–9.
- Produces:
  - `DeviceGroupDeps.onPeer?(link: PeerLink, hello: HelloMessage): void` — called in `linked()` for every kept member link right after its `sync` message; a throwing callback is caught.
  - `mirror-port.ts`: `screenWorkerPath(file: string): string` — the worker file's path with a `app.asar` folder (followed by `/` or `\`) changed to `app.asar.unpacked`; other paths unchanged.
  - `remote-holder.ts`:

```ts
export interface RemoteHolderDeps {
  tabs: Pick<TabManager, 'list' | 'size'>
  scrollback(): number
  hostTabs: HostTabs
  hostHandlers(): Record<string, CallEntry>
  viewerEvents: ViewerEvents
  isLocal(tabId: string): boolean
  selfId(): string
  toast(m: string): void
  /** starts a screen worker; tests give in-process copies */
  startMirrors(): ScreenMirrorsApi & { onExit(cb: () => void): void }
  /** asks this window for the screen of a tab; the answer comes back through seed() */
  requestSeed(tabId: string): void
  onTitle(tabId: string, title: string): void
  onPeerGone(device: string): void
  log(m: string): void
}
export class RemoteHolder {
  readonly host: TabHost
  readonly viewer: RemoteTabs
  readonly actions: RemoteActions
  /** opens a copy of every tab this device has, each waiting for its seed, and asks the window for each */
  constructor(deps: RemoteHolderDeps)
  /** a member link of the group came up: connectPeer (Task 7) with this holder's host, viewer and deps.hostHandlers() */
  connect(link: PeerLink, hello: HelloMessage): void
  seed(tabId: string, data: string): void
  /** every linked device gives its tabs back (onPeerGone), every remote tab closes here (viewerEvents.closed, then devices([])), and everything stops */
  dispose(): void
}
```

  The constructor builds `TabHost`, `RemoteTabs` and `RemoteActions(viewer, deps.toast)`, then for every tab of `deps.tabs.list()` calls `host.opened(id, size.cols, size.rows, deps.scrollback(), { awaitSeed: true })` and `deps.requestSeed(id)`. The holder gives `TabHost` a forwarding `ScreenMirrorsApi` over the current worker. When the worker exits the first time (`onExit`), it logs, starts a new one, opens every tab again the same way and asks a seed for each; after a second exit it starts none (attach then answers `'no screen'`). `dispose()` calls `deps.onPeerGone(device)` for each of `host.peers()` first, then `viewerEvents.closed(id)` for each remote tab and `viewerEvents.devices([])`, then disposes the host, the viewer and the mirrors.

- [ ] **Step 1: Write the failing tests**

`tests/integration/sync-device-group.int.test.ts`: `it("onPeer gets each kept member link with the member's hello")` — after `pair(a, b)`, a's `onPeer` was called once with `hello.name === 'Laptop'`, and that link is open.

`tests/unit/sync-mirror-port.test.ts`:

```ts
it('screenWorkerPath points a packaged worker at the unpacked folder and leaves a dev build alone', () => {
  expect(screenWorkerPath('C:\\Apps\\ClaudeTerm\\resources\\app.asar\\out\\main\\screen-worker-x.js')).toBe('C:\\Apps\\ClaudeTerm\\resources\\app.asar.unpacked\\out\\main\\screen-worker-x.js')
  expect(screenWorkerPath('/opt/ClaudeTerm/resources/app.asar/out/main/screen-worker-x.js')).toBe('/opt/ClaudeTerm/resources/app.asar.unpacked/out/main/screen-worker-x.js')
  expect(screenWorkerPath('/src/ct/out/main/screen-worker-x.js')).toBe('/src/ct/out/main/screen-worker-x.js')
})
```

`tests/integration/remote-holder.int.test.ts` (`fakeMirrors()`: a recording `ScreenMirrorsApi` whose `opens` holds `[tabId, opts]` per `open`, `seeds` holds `[tabId, data]`, with `onExit` and `exit()`; `startMirrors` returns a new one each time and keeps them in `started`; fake `tabs` with T1 and T2; `requested`: the ids `requestSeed` got):

```ts
it('every tab of this device gets a screen copy that waits for its seed, and the window is asked for each', () => {
  new RemoteHolder(deps); expect(started[0].opens).toEqual([[T1, { seq: 0, awaitSeed: true }], [T2, { seq: 0, awaitSeed: true }]]); expect(requested).toEqual([T1, T2])
})
it("a seed from the window reaches the tab's copy", () => { const h = new RemoteHolder(deps); h.seed(T1, 'SEED'); expect(started[0].seeds).toEqual([[T1, 'SEED']]) })
it('a worker that exits is started again once, and every tab is seeded again; a second exit starts none', () => {
  new RemoteHolder(deps); started[0].exit(); expect(started).toHaveLength(2); expect(requested).toEqual([T1, T2, T1, T2]); started[1].exit(); expect(started).toHaveLength(2)
})
it("closing the holder gives every linked device's tabs back and closes the other devices' tabs here", async () => {
  // holder A connected over a linkPair to a member B that announces T_B ({ t: 'tabs' }); until A's viewerEvents opened T_B
  holder.dispose(); expect(gone).toEqual([B_ID]); expect(closedEvents).toEqual([T_B]); expect(devicesEvents.at(-1)).toEqual([])
})
```

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run tests/integration/sync-device-group.int.test.ts tests/integration/remote-holder.int.test.ts tests/unit/sync-mirror-port.test.ts` — FAIL.
- [ ] **Step 3: Implement** `onPeer` in `DeviceGroup.linked`, `screenWorkerPath`, and `RemoteHolder`.
- [ ] **Step 4: Run them to verify they pass** — the Step 2 command, three times — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 11: Main wiring

**Files:**
- Create: `src/main/env.d.ts` (`/// <reference types="electron-vite/node" />`)
- Modify: `src/main/index.ts`, `src/shared/ipc.ts` (the `IPC` names main sends; `CtApi` comes in Task 12), `electron-builder.yml` (`asarUnpack`)
- Test: the build check and the e2e baseline below (the behavior across two apps is tested from Task 13 on)

**Interfaces:**
- Consumes: Tasks 4–10.
- Produces:
  - `IPC` (names only here): `evTabSize: 'ev:tab-size'`, `evRemoteDevices: 'ev:remote-devices'`, `evAttentionClear: 'ev:attention-clear'`, `evScreenSeed: 'ev:screen-seed'`, `remoteDevices: 'remote:devices'`, `screenSeed: 'screen:seed'`.
  - In `bootstrap()` of `index.ts`, the names later tasks use: `sizes: TabSizes`, `tabAttention: TabAttention`, `titles: Map<string, string>`, `lastReviews: Map<string, ReviewUpdate>`, `lastImages: Map<string, ImagesUpdate>` (remote tabs), `remoteFronts: Map<string, string>` (device → its tab of this device in front), `activeRemote: string | null`, `selfDeviceId: string` (from the last view: `DeviceGroup.view()` is not cheap), `remote: RemoteHolder | null`, `quitting: boolean`, `stopRemote()`, `ensureSomeTab()`, `hostCtx: HostContext`, `writeInput(tabId, data, from: string | null)`, `applySize(tabId, s: AppliedSize | null)`, `viewerEvents: ViewerEvents`, `pendingSeeds: Set<string>`. The existing `let rendererReady` (set in the `rendererReady` handler) is the ready flag: no second one. (Task 12 adds `activateRemote(tabId)`.)

- [ ] **Step 1: Run the check to verify it fails** — `npm run build`; then `out/main` holds no file whose name starts with `screen-worker` (nothing imports the worker yet) — FAIL.

- [ ] **Step 2: Wire `index.ts` region by region**

- After `const tabs = new TabManager(...)`: the state above. `selfDeviceId` is set from every view (`onView`, and `g.view()` in the open's `.then`).
- `startDevices()` (part 1): inside the `try` of its `.then((g) => …)`, before `group = g`: any holder left from an earlier open is disposed (`remote?.dispose()`), then `remote = new RemoteHolder({ …, startMirrors: () => new PortMirrors(new Worker(screenWorkerPath(screenWorkerFile), { workerData: { screenWorker: true, maxSnapshotBytes: MAX_SNAPSHOT_BYTES } })) })` (with `import screenWorkerFile from './sync/screen-worker?modulePath'` and `Worker` from `node:worker_threads`), then `remote.viewer.members(g.view().devices)`. The open's options gain `onPeer: (link, hello) => remote?.connect(link, hello)`; its `onView` keeps `broadcast(IPC.evDevices, view)` and also sets `selfDeviceId` and calls `remote?.viewer.members(view.devices)`. The `.then`'s existing `catch` (`cannot start device sync`, which leaves no group behind) also leaves no holder: `remote?.dispose(); remote = null`. `stopDevices()` calls `stopRemote()` right after its `if (opening) await opening` (so a holder built by an open still in flight is disposed too, and `restartDevices()` builds a new holder whose copies are seeded again).
- `stopRemote()`: `const hadRemoteFront = activeRemote !== null` first (the `closed` events below set `activeRemote` to null), then `remote?.dispose()` (its `onPeerGone` and `closed` events run the handlers below), `remote = null`, `titles.clear()`, `remoteFronts.clear()`, `lastImages.clear()`; unless `quitting`: when `hadRemoteFront`, the first local tab is activated, and `ensureSomeTab()`.
- `ensureSomeTab()`: unless `quitting`, when this device has no tab and `remote` lists no tab of another device, a new tab opens as at startup (`openTab({ kind: 'shell', cwd: defaultFolder() })`, as `openFromLaunch` does).
- `before-quit`: right after its `if (ptysExited) return`: `quitting = true; remote?.dispose(); remote = null` — before `tabs.disposeAll()`, and without `stopRemote()`: nothing is activated and no tab is opened while the app quits.
- Holder deps: `onTitle: (id, t) => { titles.set(id, t); remote?.host.changed() }`; `onPeerGone(device)`: `remoteFronts.delete(device)`, `applySize` for each of `sizes.dropViewer(device)`; `requestSeed(id)`: `rendererReady ? send(IPC.evScreenSeed, id) : pendingSeeds.add(id)` (Task 12 sends the pending ones on `rendererReady`); `tabs`, `scrollback: () => settings.scrollback`, `hostTabs: hostTabs(hostCtx)`, `hostHandlers: () => hostHandlers(hostCtx)`, `isLocal: (id) => tabs.get(id) !== null`, `selfId: () => selfDeviceId`, `toast`, `log: (m) => log.warn(m)`.
- `writeInput(tabId, data, from)`: the body of today's `IPC.ptyWrite` handler after its guards (`autoTabId`, `autoContinue.userInput`, `resumeAfterRestore`, `setWorking` on Esc and Ctrl+C, `tabs.write`), and for `from === null` first `applySize(tabId, sizes.claim(tabId, null))`; the `ptyWrite` handler calls it. `applySize(tabId, s)`: when `s`, `tabs.resize`, `remote?.host.resized`, `remote?.host.changed()`, and `send(IPC.evTabSize, tabId, s.by === null ? null : { cols: s.cols, rows: s.rows })` only when the owner changed or the owner is a device (a fit of this window's own tab sends nothing new, as today).
- `hostCtx`: the existing objects; `openTab: (r) => openTab({ kind: r.kind, cwd: defaultFolder(), profile: r.profile, account: r.account, resumeSessionId: r.resume }, false)`; `claim: (id, from, c, r) => applySize(id, sizes.claim(id, from, c, r))`; `front: (from, id)` → `remoteFronts` set or delete, and `review.activated(id)` for a Claude tab; `writeInput`.
- `TabManager` events: `data` → also `remote?.host.output(id, d)`; `reset` → `host.reset`; `exit` → `host.exit`; `opened` → `remote?.host.opened(t.id, size.cols, size.rows, settings.scrollback)` with `size = tabs.size(t.id)` (a new tab has printed nothing: no seed); `closed` → `host.closed`, `sizes.drop`, `tabAttention.drop`, `titles.delete`; `activated` → `activeRemote = null`, `applySize(id, sizes.claim(id, null))`, `remote?.viewer.activated(id)`. `onStateChanged` → also `remote?.host.changed()`. A local `ptyResize` goes through `applySize(id, sizes.fit(id, cols, rows))` in place of `tabs.resize`.
- Hub publishers: the status timer → `remote?.host.push(tabId, 'status', { main, agents })`; `planHub` → `push 'plan'`; `review.publish` → `lastReviews.set`, `push 'review'` (without `tabId`); the images timer → `push 'images'`; each also `host.changed()`; `ReviewHub` gets `remoteFront: (id) => [...remoteFronts.values()].includes(id)`; `notesSetText` / `notesSetView` → `host.changed()`.
- `viewerEvents`: `opened` → `send(IPC.evTabOpened, remoteTabInfo(device, tab))` and, for a Claude tab, `noteHub.addTab(tab.id, tab.claudeSessionId, { remote: true })`; `updated` → `evTabUpdated`, and `noteHub.session` when the session id changed; `closed` → `evTabClosed`, `noteHub.removeTab`, `lastImages.delete`, `activeRemote = null` when it was that tab (the renderer picks the next tab, Task 12), then `ensureSomeTab()` (the last tab of a device that went, on a device with no tab of its own, leaves no empty window); `devices` → `evRemoteDevices`; `data` / `reset` / `exit` → `evPtyData` / `evPtyReset` / `evPtyExit`; `size` → `evTabSize`; `attention` → fresh ? `attention.notify(id, reason)` : `send(IPC.evAttention, id, reason)`; `attentionCleared` → `evAttentionClear`; `push` → `evStatus { tabId, ...v }`, `evPlan { tabId, plan: v }`, `evImages { tabId, ...v }` (also kept in `lastImages`), `evReview { ...v, tabId }`.
- `Attention` deps: `activeTabId: () => activeRemote ?? tabs.activeTabId()`, `muted: (id) => (remote?.viewer.tab(id)?.muted ?? tabs.get(id)?.muted) === true`.
- `electron-builder.yml`: `asarUnpack` gains `out/main/**/screen-worker*.js` (a Worker cannot load its script from inside the asar). The packaged apps are checked at release (Task 28): this plan builds no installer.

- [ ] **Step 3: Run the checks to verify they pass** — `npm run typecheck` — no errors. `npm run build`, then: `out/main` holds a file whose name starts with `screen-worker`, it requires no other chunk (`grep -E 'require\("\./' out/main/**/screen-worker*.js` prints nothing), and `out/main/index.js` does not contain `SerializeAddon`. `npx vitest run` — PASS. Then `npx playwright test` — the whole e2e suite as before (without a group nothing changes; compare with the baseline of the Global Constraints).
- [ ] **Step 4: Leave the changes uncommitted (the user's rule).**

---

### Task 12: IPC, preload and the renderer's routing

**Files:**
- Modify: `src/shared/ipc.ts` (`CtApi`), `src/preload/index.ts`, `src/main/ipc-guards.ts`, `src/main/index.ts` (the IPC handlers), `src/renderer/terminal-view.ts` (`serialize`), `src/renderer/main.ts` (`onTabsOrder`, seeds, the tab activated when the tab in front closes)
- Test: `tests/unit/ipc-guards.test.ts`

**Interfaces:**
- Consumes: Task 11's names; `boundedSerialize` (Task 4); `MAX_SNAPSHOT_BYTES`.
- Produces:
  - `CtApi`: `getRemoteDevices(): Promise<RemoteDeviceView[]>`; `onTabSize(cb: (tabId: string, size: { cols: number; rows: number } | null) => void): Unsubscribe`; `onRemoteDevices(cb: (devices: RemoteDeviceView[]) => void): Unsubscribe`; `onAttentionClear(cb: (tabId: string) => void): Unsubscribe`; `onScreenSeed(cb: (tabId: string) => void): Unsubscribe`; `seedScreen(tabId: string, data: string): void`.
  - `ipc-guards.ts`: `isSeedText(v: unknown): v is string` — a string of at most `MAX_SNAPSHOT_BYTES` characters.
  - `TerminalView.serialize(maxBytes: number): string` — `boundedSerialize((n) => this.serializer.serialize({ scrollback: n }), scrollback, maxBytes)` with a `SerializeAddon` loaded on the terminal.
  - `index.ts` IPC handlers, a remote tab first (`remote?.viewer.has(id)`): `ptyWrite` → `remote.viewer.input`; `ptyResize` → `remote.viewer.fit`; `tabsActivate` → `activateRemote(id)` (`activeRemote = id; tabs.deactivate(); send(IPC.evTabActivated, id); remote.viewer.activated(id)`); `tabsClose` / `tabsRename` / `tabsMute` / `tabsRestart` / `tabsSwitchAccount` → `remote.actions`; `tabsClose` closes the window only when neither local nor remote tabs are left; `bell` of a remote tab is ignored (its device rings it); `imagesList` of a remote tab → `lastImages` or an empty update. `IPC.remoteDevices` → `remote?.viewer.devices() ?? []`. `IPC.screenSeed` (`isId`, `isSeedText`) → `remote?.seed(id, data)`. The existing `rendererReady` handler (which sets the existing `let rendererReady = true`; there is no second flag) also, only when `remote` exists (with no group it sends nothing new): every remote tab with `evTabOpened`, the devices with `evRemoteDevices`, and each of `pendingSeeds` with `evScreenSeed` (then `pendingSeeds.clear()`).
  - Renderer: `onTabsOrder`: `order = [...ids.filter((id) => tabs.has(id)), ...order.filter((id) => tabs.get(id)?.info.remote)]`. `ct.onScreenSeed((id) => { const t = tabs.get(id); if (!t) ct.seedScreen(id, ''); else t.view.term.write('', () => ct.seedScreen(id, t.view.serialize(MAX_SNAPSHOT_BYTES))) })` — the empty write's callback runs after the output that came before the request and before the output after it, so the seed and the copy's held output meet exactly. When the tab in front closes and main activates no other — the tab was a remote one (main never picks a tab then), or it was this device's last tab (`TabManager.close` activates a neighbor only among this device's tabs) — the renderer activates the first tab of `order` with `ct.activateTab` (Task 15 makes it the first of `visibleOrder()`), so the window never shows no terminal while a tab is left. A local tab closing while other local tabs are left changes nothing: main activates its neighbor, as today.

- [ ] **Step 1: Write the failing test** — `tests/unit/ipc-guards.test.ts`: `it('isSeedText takes a string up to MAX_SNAPSHOT_BYTES characters')` — `''` and `'x'.repeat(MAX_SNAPSHOT_BYTES)` true; `'x'.repeat(MAX_SNAPSHOT_BYTES + 1)`, `42`, `null` false.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/unit/ipc-guards.test.ts` — FAIL.
- [ ] **Step 3: Implement** the guard, `CtApi` and preload, the handlers, `serialize`, and the renderer changes.
- [ ] **Step 4: Run to verify it passes** — the Step 2 command — PASS; `npm run typecheck` — no errors; `npm run build; npx playwright test` — as before (compare with the baseline). The behavior across two apps is tested in Task 13.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 13: Two paired apps: the e2e helper and the first spec

**Files:**
- Create: `tests/e2e/device-pair.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Consumes: part 1's device calls (`startDevicePairing`, `joinDevice`, `renameThisDevice`, `getDevicesView`), `getRemoteDevices` (Task 12).
- Produces — `tests/e2e/device-pair.ts`:

```ts
export const SLOW = { timeout: 45_000 }
export interface AppOptions { settings?: object; args?: string[]; env?: Record<string, string> }
/** firstTab: the tab the app had in front right after launch (its own first tab) */
export interface Device extends Launched { id: string; name: string; config: string; work: string; env: Record<string, string>; args: string[]; firstTab: string }
/** A listens on a free port found before launch (so a relaunch listens on the same one), B on '0'; each its own CLAUDE_CONFIG_DIR and work folder;
 *  settings: FAKE_CLAUDE_SETTINGS unless given, and always `defaultFolder: <its work folder>` unless the given settings set a defaultFolder
 *  (so tabs another device opens here never start in the real home) */
export function startApps(o?: { a?: AppOptions; b?: AppOptions }): Promise<{ a: Device; b: Device }>
/** A shows a code, B joins it at 127.0.0.1:<A's port>; they are renamed Studio and Laptop; waits (SLOW) until each lists the other connected and B's getRemoteDevices() lists Studio online; fills in the ids */
export function pairApps(a: Device, b: Device): Promise<void>
export function pairedApps(o?: { a?: AppOptions; b?: AppOptions }): Promise<{ a: Device; b: Device }>
/** the same data folder, args and env */
export function relaunch(d: Device): Promise<Device>
/** a shell tab in d.work */
export function openShell(d: Device): Promise<TabInfo>
/** closes every app these helpers started; for test.afterEach */
export function closePaired(): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

```ts
test.afterEach(closePaired)

test("a tab opened on A appears in B's window; typing on B runs on A and shows on both; closing it from B closes it on A", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(); const tab = await openShell(a)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.tabIds()), SLOW).toContain(tab.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(PROMPT)
  await typeInTerminal(b.page, 'echo from-laptop')
  await expect.poll(() => bufferText(a.page, tab.id), SLOW).toMatch(/from-laptop[\s\S]*from-laptop/)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(/from-laptop[\s\S]*from-laptop/)
  await b.page.evaluate((id) => window.ct.closeTab(id), tab.id)
  await expect.poll(() => a.page.evaluate(() => window.__ct!.tabIds()), SLOW).not.toContain(tab.id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.tabIds()), SLOW).not.toContain(tab.id)
  // B closes its own last tab while A's tabs are there: B's window stays, and one of A's tabs comes to the front
  const other = await openShell(a); await expect.poll(() => b.page.evaluate(() => window.__ct!.tabIds()), SLOW).toContain(other.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), b.firstTab)
  await b.page.evaluate((id) => window.ct.closeTab(id), b.firstTab)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.tabIds()), SLOW).not.toContain(b.firstTab); expect(b.app.windows()).toHaveLength(1)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).not.toBeNull()
  expect([a.firstTab, other.id]).toContain(await b.page.evaluate(() => window.__ct!.activeTabId()))
})

test('a tab that printed before the devices paired shows that output on the other device', async () => {
  test.setTimeout(180_000)
  const { a, b } = await startApps(); const id = a.firstTab
  await expect.poll(() => bufferText(a.page, id), SLOW).toMatch(PROMPT)
  await typeInTerminal(a.page, 'echo before-pairing'); await expect.poll(() => bufferText(a.page, id), SLOW).toMatch(/before-pairing[\s\S]*before-pairing/)
  await pairApps(a, b)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.tabIds()), SLOW).toContain(id)
  await b.page.evaluate((tabId) => window.ct.activateTab(tabId), id)
  await expect.poll(() => bufferText(b.page, id), SLOW).toMatch(/before-pairing[\s\S]*before-pairing/)
})
```

- [ ] **Step 2: Run to verify they fail** — `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts` — FAIL (the helper is missing; once written, the tests fail if any of Tasks 10–12 is wrong).
- [ ] **Step 3: Implement** `device-pair.ts` (pairing the way part 1's `tests/e2e/devices-api.spec.ts` does; `freePort()` as there).
- [ ] **Step 4: Run to verify they pass** — the Step 2 command, three times — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 14: The terminal takes the size of the device last used

**Files:**
- Modify: `src/renderer/terminal-view.ts`, `src/renderer/main.ts` (`ct.onTabSize`; test hook `termSize`), `src/renderer/env.d.ts` (`termSize?(id?: string): { cols: number; rows: number } | null`), `src/renderer/styles.css` (`.terminal-host.fixed`), `tests/e2e/device-pair.ts` (`setWindowSize(d: Launched, width: number, height: number): Promise<void>` through `BrowserWindow.getAllWindows()[0].setSize` in `app.evaluate`; `termSize(page: Page, tabId: string): Promise<{ cols: number; rows: number } | null>` through the hook)
- Test: `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Consumes: `evTabSize` (Tasks 11–12).
- Produces: `TerminalView.setFixedSize(size: { cols: number; rows: number } | null): void` — fixed: the xterm is resized to `size`, also while hidden, and the host element has class `fixed` (`overflow: auto`: a larger terminal scrolls sideways, a smaller one shows margins); null: it fits its element again; null while not fixed does nothing (no refit, no report). `onResize(cols, rows)` now reports the size that fits the element (`FitAddon.proposeDimensions()`), also while fixed, once per change — it is this window's size for the tab, which main applies or keeps (Task 5).

- [ ] **Step 1: Write the failing test**

```ts
test('the terminal takes the size of the device last typed into; elsewhere it keeps that size', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(); await setWindowSize(a, 1300, 850); await setWindowSize(b, 900, 600)
  const tab = await openShell(a); await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(PROMPT)
  await typeInTerminal(b.page, 'echo from-laptop')
  await expect.poll(async () => JSON.stringify(await termSize(a.page, tab.id)), SLOW).toBe(JSON.stringify(await termSize(b.page, tab.id)))
  const bSize = (await termSize(b.page, tab.id))!
  await expect(a.page.locator('.terminal-host.fixed:visible')).toHaveCount(1, SLOW)
  await typeInTerminal(a.page, 'echo from-studio')
  await expect.poll(async () => (await termSize(b.page, tab.id))!.cols, SLOW).toBeGreaterThan(bSize.cols)
  expect(await termSize(b.page, tab.id)).toEqual(await termSize(a.page, tab.id))
  await expect(b.page.locator('.terminal-host.fixed:visible')).toHaveCount(1, SLOW)
})
```

- [ ] **Step 2: Run to verify it fails** — `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "size of the device"` — FAIL.
- [ ] **Step 3: Implement** `setFixedSize`, the `refit` that reports the proposal, `ct.onTabSize((id, size) => tabs.get(id)?.view.setFixedSize(size))`, the hook and the style.
- [ ] **Step 4: Run to verify it passes** — the Step 2 command — PASS; then `npx playwright test tests/e2e/layout.spec.ts tests/e2e/font.spec.ts tests/e2e/side-panel.spec.ts` — PASS (fitting is unchanged).
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 15: One tab bar, grouped by device

**Files:**
- Modify: `src/renderer/tabbar.ts`, `src/renderer/main.ts`, `src/renderer/styles.css`
- Test: `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Consumes: `TabInfo.remote` (Task 9), `getRemoteDevices` / `onRemoteDevices` (Task 12), `deviceColor`, `REMOTE_COPY` (Task 2).
- Produces:
  - `TabBarItem` gains `group: string | null` (the device id; null: this device), `deviceName: string | null`, `dim: boolean`. `interface TabBarGroup { id: string; name: string; color: string; online: boolean; folded: boolean; count: number; attention: boolean }`. `TabBar.render(items: TabBarItem[], activeId: string | null, groups: TabBarGroup[] = []): void`.
  - `TabBarCallbacks.reorder(ids: string[], group: string | null): void` (only the dragged group's ids; `dropOn` does nothing when the target is in another group); new `toggleGroup(id: string): void`, `groupMenu(id: string, at: { x: number; y: number }): void`.
  - DOM: this device's tabs first, then per group a chip `.tab-group-chip[data-device-id]` (the name, then ` ${REMOTE_COPY.offline}` and class `offline` — dashed — when offline; `--group-color`), folded: `.tab-group-count` (its number of tabs) and `.tab-group-attention` (a pulsing dot) when one of its tabs has `attention`; unfolded: its tabs with class `remote` (and `dim` when offline) and a thin underline of `--group-color`. A remote tab's tooltip is `REMOTE_COPY.tabTooltip(title, deviceName, folder)`.
  - `main.ts`: `remoteDevices: RemoteDeviceView[]`, `folded: Set<string>`, `remoteOrder: Map<string, string[]>` (arrival order, then drags; a remote group's `reorder` changes only this, a local one calls `ct.reorderTabs` as today); groups in the order of `remoteDevices` (by name); `visibleOrder()` (this device's tabs, then the unfolded groups' tabs) for next/previous/go-to-tab and for the tab the renderer activates when the tab in front closes and main activates no other (Task 12); `groupMenu` shows `REMOTE_COPY.fold` / `REMOTE_COPY.unfold` (Task 16 adds the new-tab items); `titleOf` uses `info.remote?.title` before the folder name; `handleInput` drops input to a tab whose device is offline before logging it.

- [ ] **Step 1: Write the failing tests**

```ts
test("another device's tabs show after this device's, under a chip with its name; a click folds them", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(); const tab = await openShell(a)
  const chip = b.page.locator('.tab-group-chip', { hasText: 'Studio' })
  await expect(b.page.locator(`.tab.remote[data-tab-id="${tab.id}"]`)).toBeVisible(SLOW)
  expect(await b.page.evaluate(() => [...document.querySelectorAll('#tabbar .tab, #tabbar .tab-group-chip')].findIndex((e) => e.classList.contains('tab-group-chip')))).toBe(1)
  expect(await b.page.locator(`[data-tab-id="${tab.id}"]`).getAttribute('title')).toContain(`\nStudio: ${a.work}`)   // REMOTE_COPY.tabTooltip
  await chip.click(); await expect(b.page.locator(`[data-tab-id="${tab.id}"]`)).toHaveCount(0); await expect(chip.locator('.tab-group-count')).toHaveText('2')
  await chip.click(); await expect(b.page.locator(`[data-tab-id="${tab.id}"]`)).toBeVisible()
})
test('a remote tab is dragged inside its group only', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(); const second = await openShell(a)
  const first = (await a.page.evaluate(() => window.__ct!.tabIds())).find((id) => id !== second.id)!
  await expect(b.page.locator('.tab.remote')).toHaveCount(2, SLOW)
  // HTML5 drag through dispatched events (deterministic on every system): dragstart on one tab, dragover and drop on the other
  const drag = (from: string, to: string) => b.page.evaluate(([f, t]) => {
    const el = (id: string) => document.querySelector(`[data-tab-id="${id}"]`)!
    el(f).dispatchEvent(new DragEvent('dragstart', { bubbles: true })); el(t).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))
    el(t).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true })); el(f).dispatchEvent(new DragEvent('dragend', { bubbles: true }))
  }, [from, to])
  const barOrder = () => b.page.evaluate(() => [...document.querySelectorAll('#tabbar .tab')].map((e) => (e as HTMLElement).dataset.tabId))
  expect(await barOrder()).toEqual([b.firstTab, first, second.id]); await drag(second.id, first); await expect.poll(barOrder).toEqual([b.firstTab, second.id, first])
  await drag(first, b.firstTab); await drag(b.firstTab, second.id)
  expect(await barOrder()).toEqual([b.firstTab, second.id, first])   // nothing moved across groups, either way
})
test('stopping A dims its group on B and B cannot type into it; starting A again brings it back', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(); const tab = await openShell(a)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${tab.id}"]`)).toBeVisible(SLOW)
  await a.app.close()
  await expect(b.page.locator('.tab-group-chip.offline', { hasText: 'Studio · offline' })).toBeVisible(SLOW)
  await expect(b.page.locator(`.tab.remote.dim[data-tab-id="${tab.id}"]`)).toBeVisible()
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id); await typeInTerminal(b.page, 'echo lost')
  expect(await b.page.evaluate((id) => window.__ct!.ptyInput!(id), tab.id)).not.toContain('lost')
  await relaunch(a)
  await expect(b.page.locator('.tab-group-chip.offline')).toHaveCount(0, SLOW)
  await expect(b.page.locator(`[data-tab-id="${tab.id}"]`)).toHaveCount(0, SLOW)   // that tab is gone on A: A started with a new one
  await expect(b.page.locator('.tab.remote')).toHaveCount(1, SLOW)
})
```

- [ ] **Step 2: Run to verify they fail** — `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "chip|dragged|dims"` — FAIL.
- [ ] **Step 3: Implement** the groups in `TabBar`, the state and rendering in `main.ts`, the styles.
- [ ] **Step 4: Run to verify they pass** — the Step 2 command — PASS; `npx playwright test tests/e2e/tabs.spec.ts tests/e2e/keys.spec.ts` — PASS apart from the baseline failures. CI runs the drag test on all three systems before the task counts as done.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 16: New tabs on another device

> If the first run of this task stalls, split it in two and run them in order: (a) the actions and IPC — `RemoteActions`, `onFresh`, the IPC names, the guard, preload and `index.ts`, with the integration and guard tests; (b) the menus and the e2e — `menu.ts`, `main.ts`, with the e2e tests.

**Files:**
- Modify: `src/main/sync/remote-actions.ts`, `src/main/remote-holder.ts` (`onFresh`), `src/main/index.ts`, `src/main/ipc-guards.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/menu.ts`, `src/renderer/main.ts` (`newTabMenu`, `runAction`, `groupMenu`, `continueItems`, `accountOf`, `renderTitle`)
- Test: `tests/integration/sync-remote-actions.int.test.ts`, `tests/unit/ipc-guards.test.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Consumes: the `open-tab`, `profiles`, `accounts` and `switch-account` handlers (Task 9).
- Produces:
  - `RemoteActions` constructor gains `onFresh?: (what: 'choices' | 'sessions') => void` (the holder passes `deps.onFresh`, a new `RemoteHolderDeps.onFresh`). `choicesNow(): DeviceAnswer<DeviceChoices>[]` — every online device in the order of `RemoteTabs.devices()`, with its last answer or null, at once. `refreshChoices(): void` — asks every online device `profiles` and `accounts` at once with `LIST_TIMEOUT_MS`, in the background; an answer that changes the kept one calls `onFresh('choices')`; a device that does not answer keeps its last answer. The holder refreshes on every `connect`. `openTab(device: string, req: CallArgs['open-tab']): Promise<string | null>` — the new tab's id; a failure toasts and gives null.
  - `menu.ts`: `showMenu` returns the menu element; `menuIsOpen(menu: HTMLElement): boolean`.
  - `IPC`: `devicesChoices: 'devices:choices'`, `evDeviceChoices: 'ev:device-choices'`, `remoteOpenTab: 'remote:open-tab'`. `CtApi`: `listDeviceChoices(): Promise<{ self: string; devices: DeviceAnswer<DeviceChoices>[] }>` (answers at once from `choicesNow()` and starts `refreshChoices()`; `self`: this device's name in the group); `onDeviceChoices(cb: (v: { self: string; devices: DeviceAnswer<DeviceChoices>[] }) => void): Unsubscribe` (sent on `onFresh('choices')`); `openRemoteTab(device: string, kind: TabKind, profile: string | null, account: string | null): Promise<string | null>`. Guard: a new `isOpenRemoteTabArgs(device: unknown, kind: unknown, profile: unknown, account: unknown): boolean` in `ipc-guards.ts` — `isDeviceId(device)`, kind `'claude' | 'shell'`, profile `null` or a string of 1..256, `isAccountRef(account)`. Main brings the new tab to the front here with `activateRemote`; when its directory entry has not arrived yet, as soon as it does (`pendingActivate`).
  - The "+" menu (spec "The + menu"): with an online device, a disabled heading with this device's name, today's entries, then per device a separator, a disabled heading with its name and, from its answer, its profiles, `Claude Code`, `Claude Code — <account>` per account — or one disabled `REMOTE_COPY.loading` item when it has not answered yet; then `Recent sessions…`, restore, `Settings…` and the version once, as today. Without online devices the menu is today's. When `onDeviceChoices` arrives while that menu is open (`menuIsOpen`), it is drawn again at the same place. The chip menu: `REMOTE_COPY.newClaudeTab`, `REMOTE_COPY.newProfileTab(p)` for each of its profiles (or `REMOTE_COPY.loading`), a separator, Fold/Unfold (only Fold/Unfold while offline). For a remote Claude tab, "Continue as …" lists that device's accounts and calls `switchAccount`; the status bar and the window title name `info.remote.accountName` (the main account's label when null).
  - This device's own Claude entries in the "+" menu and the `newClaudeTab` key (`runAction`, today `t?.info.cwd ?? defaultFolder()`) open in the active tab's folder only when that tab is this device's (`!info.remote`); with a remote tab in front they open in `defaultFolder()` — another device's path is never this machine's PTY folder (`TabManager` passes `cwd` on unchecked).

- [ ] **Step 1: Write the failing tests**

```ts
// sync-remote-actions.int.test.ts (two devices A and C answer; C's handlers hold their answer until released)
it('choicesNow answers at once: a device that has not answered yet has null, and its answer comes later with onFresh', async () => {
  expect(actions.choicesNow().map((d) => [d.name, d.value])).toEqual([['Cellar', null], ['Studio', null]])
  actions.refreshChoices(); await until(() => fresh.length === 1)
  expect(actions.choicesNow().find((d) => d.name === 'Studio')!.value).toEqual({ profiles: ['Bash', 'Zsh'], accounts: [{ id: 'w', name: 'Work' }] })
  expect(actions.choicesNow().find((d) => d.name === 'Cellar')!.value).toBeNull()
  releaseC(); actions.refreshChoices(); await until(() => actions.choicesNow().every((d) => d.value !== null))   // C now answers at once
})
it("a device that stops answering keeps its last answer", async () => { /* after an answer, C hangs; refreshChoices; past LIST_TIMEOUT_MS C still has its last value */ })
it("openTab answers the new tab's id", async () => expect(await actions.openTab(A_ID, { kind: 'shell', profile: 'Bash', account: null, resume: null })).toBe(T3))
// ipc-guards.test.ts: isOpenRemoteTabArgs — (A_ID, 'claude', null, null) and (A_ID, 'shell', 'Bash', 'w') true; 'x' as device, 'other' as kind, '' or 257 characters as profile, 42 as account false
// remote-tabs.spec.ts
test("B opens a Claude tab on A from the + menu: it runs on A in A's default folder and is in front on B", async () => {
  test.setTimeout(180_000)
  const home = mkdtempSync(join(tmpdir(), 'ct-a-home-'))
  const { a, b } = await pairedApps({ a: { settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: home } } })
  const before = await b.page.evaluate(() => window.__ct!.tabIds())
  await b.page.locator('.tab-menu').click()
  await b.page.locator('.menu-item', { hasText: /^Claude Code$/ }).nth(1).click(SLOW)          // the second one is Studio's
  const newIds = async () => (await b.page.evaluate(() => window.__ct!.tabIds())).filter((x) => !before.includes(x))
  await expect.poll(newIds, SLOW).toHaveLength(1)
  const id = (await newIds())[0]
  await expect.poll(() => a.page.evaluate(() => window.__ct!.tabIds()), SLOW).toContain(id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(id)
  await expect.poll(() => a.page.locator(`[data-tab-id="${id}"]`).getAttribute('title'), SLOW).toContain(home)
  await expect.poll(() => bufferText(b.page, id), SLOW).toContain('fake-claude')
})
test("the chip's menu opens a shell tab on that device", async () => {
  // as above, from right-clicking Studio's chip → REMOTE_COPY.newProfileTab(<A's first profile>) → a new id on both, a shell (A's tab kind 'shell')
})
test("with A's tab in front, B's own Claude Code entry opens a tab on B in B's default folder, and so does the key", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()   // startApps gives B defaultFolder: b.work
  const tab = await openShell(a); await expect.poll(() => b.page.evaluate(() => window.__ct!.tabIds()), SLOW).toContain(tab.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(tab.id)
  const ids = () => b.page.evaluate(() => window.__ct!.tabIds())
  const before = await ids()
  await b.page.locator('.tab-menu').click()
  await b.page.locator('.menu-item', { hasText: /^Claude Code$/ }).nth(0).click(SLOW)          // the first one is this device's
  const newIds = async () => (await ids()).filter((x) => !before.includes(x))
  await expect.poll(newIds, SLOW).toHaveLength(1)
  const id = (await newIds())[0]
  expect(await a.page.evaluate(() => window.__ct!.tabIds())).not.toContain(id)   // it runs on B
  await expect.poll(() => b.page.locator(`[data-tab-id="${id}"]`).getAttribute('title'), SLOW).toContain(b.work)
  await b.page.evaluate((x) => window.ct.activateTab(x), tab.id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(tab.id)
  const beforeKey = await ids(); await b.page.keyboard.press(KEYS.newClaudeTab)
  const keyIds = async () => (await ids()).filter((x) => !beforeKey.includes(x))
  await expect.poll(keyIds, SLOW).toHaveLength(1)
  await expect.poll(async () => b.page.locator(`[data-tab-id="${(await keyIds())[0]}"]`).getAttribute('title'), SLOW).toContain(b.work)
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/sync-remote-actions.int.test.ts tests/unit/ipc-guards.test.ts`; `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "opens"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — the Step 2 commands — PASS; `npx playwright test tests/e2e/accounts.spec.ts` — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 17: Media of a remote tab

**Files:**
- Modify: `src/main/img-protocol.ts`, `src/main/remote-host.ts`, `src/main/sync/remote-actions.ts`, `src/main/index.ts` (the images routing), `src/shared/ipc.ts` (`ImagesUpdate.remote?: boolean`), `src/renderer/image-panel.ts`, `src/renderer/main.ts` (badge)
- Test: `tests/unit/img-protocol.test.ts`, `tests/unit/remote-host.test.ts`, `tests/integration/sync-remote-actions.int.test.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Consumes: Tasks 3, 9, 11.
- Produces:
  - `remote-host.ts`: handlers `images-seen`, `image-remove`, `image` (`bulk: true`: image bytes never hold up input or output); `HostContext.images` becomes `Pick<ImageHub, 'list' | 'unseenCount' | 'notice' | 'markSeen' | 'remove' | 'get'>`, plus `HostContext.imageExtensions(): string[]`; and a module export `readImagePart(path: string, offset: number, max: number): Promise<{ size: number; data: Buffer }>` (async, `fs/promises`). `image` serves only a card of that tab (`card.tabId === id`), of kind `image`, that passes `checkImageFile` with `imageExtensions()` — else `CallError(REMOTE_COPY.unknownTab)`.
  - `img-protocol.ts`: `resolveImgRequest` stays as it is. New `parseImgUrl(url: string): { id: string; version: number } | null`; `imageResponse(url: string, hub: ImageHub, extensions: string[], remote?: (id: string, version: number) => Promise<{ data: Buffer; type: string } | null>): Promise<{ path: string } | { data: Buffer; type: string } | null>` — a card this device has goes through `resolveImgRequest` as today, else `remote`; `handleImgProtocol(hub: ImageHub, extensions: () => string[], remote?: …)` answers both. Types: png, jpg/jpeg, gif, webp, bmp → `image/<type>` (`image/jpeg`).
  - `remote-actions.ts`: `class RemoteImages { constructor(maxBytes = IMAGE_CACHE_BYTES); setCards(tabId: string, cards: ImageCard[]): void; card(cardId: string): ImageCard | null; cached(cardId: string, version: number): Buffer | null; store(cardId: string, version: number, data: Buffer): void; dropTab(tabId: string): void }` (least recently used out first; a buffer larger than `maxBytes` is not kept); `RemoteActions.imageBytes(tabId: string, cardId: string): Promise<{ version: number; data: Buffer } | null>` (`image` calls by `offset`, `IMAGE_PART_BYTES` each, until `size`; null when the version changes midway or a call fails); `markImagesSeen(tabId)`, `removeImage(tabId, cardId)`.
  - `index.ts`: images pushes → `remoteImages.setCards`, `evImages` with `remote: true`; for a remote tab: `imagesMarkSeen`, `imagesAction` (`copy-image`: the bytes through `imageBytes`, then the clipboard as for a local card; `copy-path`: the card's path, a path on the other device; `remove`; `open` and `reveal` ignored). Renderer: with `update.remote` the image card menu has no "Open in viewer" and "Show in Explorer" and a click on a media card does nothing; a remote tab's badge is `info.remote.images`.

- [ ] **Step 1: Write the failing tests**

```ts
// img-protocol.test.ts
it('parseImgUrl reads the card id and the version', () => { expect(parseImgUrl(`ctimg://${CARD}/?v=3`)).toEqual({ id: CARD, version: 3 }); expect(parseImgUrl('ctimg://x/?v=a')).toBeNull() })
it('a card this device does not have is fetched from its device', async () => {
  expect(await imageResponse(`ctimg://${CARD}/?v=1`, emptyHub, ['png'], async () => ({ data: PNG, type: 'image/png' }))).toEqual({ data: PNG, type: 'image/png' })
})
// remote-host.test.ts
it('the image reply goes on the bulk lane', async () => {
  // hostHandlers(ctx) behind a Calls on a recording fake link (as in sync-calls.test.ts); call 'image' for card C1 → the reply was sent with sendBulk
})
// sync-remote-actions.int.test.ts
it('image bytes come in parts and equal the file; a card of another tab is refused', async () => {
  // A's fake ImageHub: card C1 of T1 (a 9 MiB .png in a temp folder), C2 of T2
  expect((await actions.imageBytes(T1, C1))!.data.equals(readFileSync(file))).toBe(true)
  await expect(actions.askTab(T1, 'image', { id: T1, card: C2, offset: 0 })).rejects.toThrow(REMOTE_COPY.unknownTab)
})
// remote-tabs.spec.ts
test("an image card of A's Claude tab shows on B, served from A; B copies it", async () => {
  test.setTimeout(180_000)
  // A: args ['--claude', work]; a PNG_1x1 in work; show_image through A's pipe for the tab; B switches to the tab and opens Media (KEYS.images)
  await expect.poll(() => b.page.evaluate(() => (document.querySelector('#image-panel img') as HTMLImageElement | null)?.naturalWidth ?? 0), SLOW).toBe(1)
  await b.page.locator('#image-panel .card').click({ button: 'right' }); await expect(b.page.locator('.menu-item', { hasText: 'Show in Explorer' })).toHaveCount(0)
  // inside keepingClipboard(b.app): 'Copy image' → b.app's clipboard.readImage().getSize() is 1×1 (a clipboard read: on this machine it fails like the baseline)
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/img-protocol.test.ts tests/unit/remote-host.test.ts tests/integration/sync-remote-actions.int.test.ts`; `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "image card"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — the Step 2 commands — PASS (apart from the clipboard read on this machine); `npx playwright test tests/e2e/images.spec.ts` — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 18: Changes of a remote tab

**Files:**
- Modify: `src/main/remote-host.ts`, `src/main/sync/remote-actions.ts`, `src/main/ipc-guards.ts`, `src/main/index.ts` (the review handlers), `src/shared/review.ts` (`ReviewUpdate.remote?: boolean`), `src/renderer/review-panel.ts`
- Test: `tests/unit/ipc-guards.test.ts`, `tests/integration/sync-remote-actions.int.test.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Consumes: Tasks 3, 9, 11.
- Produces:
  - `remote-host.ts`: handlers `review` and `can-send`; new `HostContext.review: Pick<ReviewHub, 'setScope' | 'clearRequest' | 'refresh' | 'setViewed' | 'showFile' | 'canSend'>`. The tab's device checks a path exactly as its local IPC does today: `isAbsPath(path)` by its own rules and `isHash(hash)` for `viewed`, then the hub (which acts only on files of the tab's view); a path that fails is refused with `CallError('bad arguments')`.
  - `ipc-guards.ts`: `isPathText(v: unknown): v is string` — a string of 1..`MAX_PATH_TEXT` characters, nothing else checked.
  - `RemoteActions.review(tabId, action: ReviewAction): void` and `canSend(tabId): Promise<ReviewSendState>` (`{ ok: false, reason: NOT_RUNNING }` when there is no answer).
  - `index.ts`: review pushes → `evReview` with `remote: true`. The handlers route a remote tab before any path guard: `reviewSetViewed` (`isPathText(path)`, `isHash(hash)`, a boolean) / `reviewShowFile` (`isPathText`) / `reviewSetScope` / `reviewClearRequest` / `reviewRefresh` → `actions.review`; `reviewCanSend` → `actions.canSend`; `reviewOpenEditor` / `reviewReveal` ignored. A local tab keeps today's `isAbsPath` checks. "Send to Claude" needs nothing new: it pastes into the tab and sends Enter through `ptyWrite`, which routes a remote tab (Task 12).
  - Renderer: with `update.remote` the Changes panel has no "Open in editor", "Open in editor at line …" and "Show in Explorer".

- [ ] **Step 1: Write the failing tests**

```ts
// ipc-guards.test.ts
it('isPathText takes a path of any system as text, bounded', () => {
  for (const p of ['C:\\work\\a.ts', '/Users/x/a.ts', 'a.ts']) expect(isPathText(p)).toBe(true)
  expect(isPathText('')).toBe(false); expect(isPathText('x'.repeat(MAX_PATH_TEXT + 1))).toBe(false); expect(isPathText(1)).toBe(false)
})
// sync-remote-actions.int.test.ts
it("review actions and can-send reach the tab's device", async () => {
  actions.review(T1, { k: 'viewed', path: ABS_A, hash: H, viewed: true }); await until(() => ctx.viewed.length === 1); expect(ctx.viewed).toEqual([[T1, ABS_A, H, true]])
  expect(await actions.canSend(T1)).toEqual({ ok: true })
})
it("a path that is not absolute by the tab device's rules is refused there", async () => {
  actions.review(T1, { k: 'show', path: 'relative/a.ts' }); actions.review(T1, { k: 'refresh' })   // refresh is the marker
  await until(() => ctx.refreshed.length === 1); expect(ctx.shown).toEqual([])
})
// remote-tabs.spec.ts
test("the Changes panel of A's Claude tab works on B", async () => {
  test.setTimeout(180_000)
  // A: a Claude tab in gitRepo() with a.ts changed and a session, as reviewTab() in review.spec.ts; B switches to it and presses KEYS.changes
  await expect(b.page.locator('.review-file[data-path="a.ts"] .review-line.add .review-code')).toHaveText('TWO', SLOW)
  await b.page.locator('.review-file[data-path="a.ts"] .review-more').click(); await expect(b.page.locator('.menu-item', { hasText: 'Open in editor' })).toHaveCount(0)
  await b.page.keyboard.press('Escape'); await b.page.locator('.review-file[data-path="a.ts"] .review-viewed').click()   // the Viewed mark goes to A and comes back
  await expect(b.page.locator('.review-file.viewed[data-path="a.ts"]')).toHaveCount(1, SLOW)
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/ipc-guards.test.ts tests/integration/sync-remote-actions.int.test.ts`; `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "Changes panel"` — FAIL.
- [ ] **Step 3: Implement.** (The Viewed checkbox's class is whatever `review-panel.ts` gives it today; use that selector.)
- [ ] **Step 4: Run to verify they pass** — the Step 2 commands — PASS; `npx playwright test tests/e2e/review.spec.ts` — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 19: Attention on every device

**Files:**
- Modify: `src/main/index.ts` (the attention sources and clears), `src/renderer/main.ts` (`onAttentionClear`; a separate `unread` mark; the folded chip's dot; test hook `tabMarks`), `src/renderer/env.d.ts` (`tabMarks?(id: string): { attention: boolean; unread: boolean } | null`)
- Test: `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Consumes: `TabAttention` (Task 5), `evAttentionClear` and `viewerEvents.attention` (Tasks 11–12), `TabBarGroup.attention` (Task 15).
- Produces:
  - `index.ts`: `startAttention(tabId: string, reason: NotificationCase): void` (`tabAttention.start`, `remote?.host.changed()`), called by the pipe's `attention` handler before `attention.notify` (not for `done` with background work while `doneWithBackgroundWork` is off), by `AutoContinue`'s `notify` (`'done'`) and by `IPC.bell` (`'bell'`); `clearAttention(tabId: string): void` (when `tabAttention.clear` was true: `send(IPC.evAttentionClear, tabId)`, `remote?.host.changed()`), called by `TabManager`'s `activated`, by `hostCtx.front` for a tab id, and by `writeInput` (input from any device answers the tab: the user is at it, even when it was already in front there; AutoContinue writes through `tabs.write` and clears nothing).
  - Renderer `TabState.unread: boolean` — Mark as unread and leaving a tab unfinished set `unread` (no longer `attention`); a tab pulses when `attention || unread`; `activate` clears both and the bell; `ct.onAttentionClear((id) => …)` clears `attention` and `bell` only: the unread mark stays this device's own. The folded chip's dot (`TabBarGroup.attention`) lights when one of its tabs pulses (`attention || unread`). Test hook `window.__ct.tabMarks(id)`: `{ attention, unread }` of that tab's `TabState`, null for an unknown tab.

- [ ] **Step 1: Write the failing tests** (A: `args: ['--claude', work]` with every notification case quiet, as `quietNotifications()` in `attention.spec.ts`, then a second tab so the Claude tab is behind; `claude`: A's Claude tab id; `SID`: a session id)

```ts
test("Claude waiting on A makes its tab pulse on B with B's sound; opening it on B stops the pulse on A", async () => {
  test.setTimeout(180_000)
  // B with permission { sound: true, flash: false, tab: true } and env CLAUDETERM_TEST_SOUND_LOG: sounds; played() reads that file
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await expect.poll(played, SLOW).toBe('system\n')
  await b.page.locator('.tab-group-chip', { hasText: 'Studio' }).click(); await expect(b.page.locator('.tab-group-chip .tab-group-attention')).toHaveCount(1)
  await b.page.locator('.tab-group-chip', { hasText: 'Studio' }).click()
  await b.page.locator(`[data-tab-id="${claude}"]`).click()
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
})
test('an attention on the tab in front on A pulses on B; typing into it on A stops the pulse on B', async () => {
  test.setTimeout(180_000)
  // A's Claude tab in front on A; the pipe's permission attention → B's tab has the class attention (SLOW); typeInTerminal(a.page, 'y') → B's no longer (SLOW)
})
test('a tab marked unread on A keeps its pulse on A when B opens it; a tab not marked loses it', async () => {
  test.setTimeout(180_000)
  // round 1: a permission attention on A's background Claude tab → both pulse; on A right-click it → 'Mark as unread';
  // B clicks the tab → B's loses the class attention (SLOW). Then wait until A has handled the clear B's front sent:
  await expect.poll(() => a.page.evaluate((id) => window.__ct!.tabMarks!(id)?.attention, claude), SLOW).toBe(false)
  expect(await a.page.evaluate((id) => window.__ct!.tabMarks!(id)?.unread, claude)).toBe(true)
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/)   // still pulses on A: unread is A's own
  // round 2: A activates the Claude tab (clears both) and goes back to the other tab; a new attention → both pulse; B clicks → A's loses it (SLOW)
})
```

- [ ] **Step 2: Run to verify they fail** — `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "pulse"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — the Step 2 command — PASS; `npx playwright test tests/e2e/attention.spec.ts tests/e2e/unread.spec.ts tests/e2e/auto-continue.spec.ts` — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 20: Change folder: folder listing, calls and IPC

**Files:**
- Create: `src/main/folder-browse.ts`
- Modify: `src/main/remote-host.ts`, `src/main/sync/remote-actions.ts`, `src/main/ipc-guards.ts`, `src/main/index.ts` (`onTabFolderChanged`, `folders`, `changeFolder`, the IPC handlers), `src/shared/ipc.ts`, `src/preload/index.ts`
- Test: `tests/integration/folder-browse.int.test.ts`, `tests/unit/ipc-guards.test.ts`, `tests/integration/sync-remote-actions.int.test.ts`

**Interfaces:**
- Consumes: `TabManager.changeFolder`, `ImageHub.resetTab`, `ReviewHub.resetTab` (Task 8); `FolderResult`, `REMOTE_COPY`, `MAX_PATH_TEXT` (Task 2).
- Produces:
  - `folder-browse.ts`:

```ts
export interface FolderFs { stat(p: string): Promise<{ isDirectory(): boolean }>; readdir(p: string, o: { withFileTypes: true }): Promise<Dirent[]> }
export async function listFolder(input: string, o: { home: string; device: string; recent: string[]; fs?: FolderFs; path?: PlatformPath }): Promise<FolderResult>
export async function checkFolder(input: string, o: { home: string; fs?: FolderFs; path?: PlatformPath }): Promise<{ ok: true; path: string } | { ok: false; error: string }>
/** the folders of the latest sessions, newest first, each once by pathKey, at most RECENT_FOLDER_COUNT */
export function recentFolders(sessions: readonly SessionSummary[], path?: PlatformPath): string[]
```

    Rules (on the tab's device, by its own system): trimmed; `~` alone or followed by `/` or `\` is the home folder; not absolute → `REMOTE_COPY.folderNotAbsolute`; `path.resolve` (drops `..` and trailing separators, `/` → `\` on Windows); missing or not a folder → `folderMissing`; `readdir` failing → `folderUnreadable`; `folders`: the entries that are folders, or links whose `stat` is a folder, names only, sorted with `localeCompare(…, undefined, { sensitivity: 'base' })`, at most `MAX_FOLDER_ENTRIES`; `parent`: `dirname` unless it is the path itself; `sep`: `path.sep`.
  - `ipc-guards.ts`: `isFolderInput(v: unknown): v is string` — a string of at most `MAX_PATH_TEXT` characters; nothing else is checked here: `~`, trailing separators, relative paths and the other system's paths are read on the tab's device.
  - `index.ts`: `folders(tabId: string, path: string | null): Promise<FolderResult>` (`path` null: the tab's folder; `device`: this device's name in the group, else `os.hostname()`; `recent`: `recentFolders(await history.list(50))`); `changeFolder(tabId: string, path: string): Promise<DeviceResult>` (`checkFolder`, then `tabs.changeFolder`). `onTabFolderChanged(tab)`: the tab's transcript feed and temp watcher stop and its `sources` entry starts empty, `images.resetTab`, `review.resetTab`, `planHub.removeTab`, `stopTabStatus`, `autoContinue.forget`, `noteHub.removeTab` and, for a Claude tab, `noteHub.addTab(tab.id, null)`, `remote?.host.changed()`. `HostContext` gains `folders` and `changeFolder`; `hostHandlers` gains `folders` and `change-folder` (a refusal → `CallError(error)`); `RemoteActions.listFolders(tabId, path): Promise<FolderResult>` and `changeFolder(tabId, path): Promise<DeviceResult>`.
  - `IPC`: `foldersList: 'folders:list'`, `tabsChangeFolder: 'tabs:change-folder'`. `CtApi`: `listFolders(tabId: string, path: string | null): Promise<FolderResult>`; `changeFolder(tabId: string, path: string): Promise<DeviceResult>`. Guards: `isId(tabId)`; `path === null || isFolderInput(path)` for the listing, `isFolderInput(path)` for the change. A remote tab goes to its device.

- [ ] **Step 1: Write the failing tests**

`tests/integration/folder-browse.int.test.ts` (temp folders; `o = { home, device: 'Studio', recent: [] }`; `listing(r)`: `r.listing` or a thrown error; paths compared with `pathKey`):

```ts
it('lists the subfolders only, by name', async () => { /* src/, docs/, a.txt → listing(await listFolder(home, o)).folders is ['docs', 'src'] */ })
it('reads folders as people type them', async () => {
  for (const typed of ['~', ` ${home} `, `${home}${sep}`, ...(WIN ? [home.replace(/\\/g, '/')] : [])]) expect(pathKey(listing(await listFolder(typed, o)).path)).toBe(pathKey(home))
  expect(pathKey(listing(await listFolder('~/sub', o)).path)).toBe(pathKey(join(home, 'sub')))
})
it("a missing folder, a file and a relative path give the dialog's messages", async () => {
  expect(await listFolder(join(home, 'nope'), o)).toEqual({ ok: false, error: REMOTE_COPY.folderMissing })
  expect(await listFolder(join(home, 'a.txt'), o)).toEqual({ ok: false, error: REMOTE_COPY.folderMissing })
  expect(await listFolder('src', o)).toEqual({ ok: false, error: REMOTE_COPY.folderNotAbsolute })
})
it('a link to a folder (a junction on Windows) is listed as a folder', async () => { /* symlinkSync(target, join(home, 'linked'), 'junction') → folders contains 'linked' */ })
it('recentFolders gives each folder once, newest first, at most ten', () => { /* 12 sessions in 11 folders, two spellings of one → 10 entries, newest first, that folder once */ })
```

```ts
// ipc-guards.test.ts
it('isFolderInput takes any typed folder as text, bounded', () => {
  for (const p of ['', '~', '~/src', 'C:\\work\\', '/Users/x', 'relative']) expect(isFolderInput(p)).toBe(true)
  expect(isFolderInput('x'.repeat(MAX_PATH_TEXT + 1))).toBe(false); expect(isFolderInput(null)).toBe(false)
})
// sync-remote-actions.int.test.ts
it("the folders of another device's tab come from that device, and a change to a missing folder is refused with its message", async () => {
  expect(await actions.listFolders(T1, null)).toMatchObject({ ok: true, listing: { device: 'Studio' } })
  expect(await actions.changeFolder(T1, '/nope')).toEqual({ ok: false, error: REMOTE_COPY.folderMissing })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/folder-browse.int.test.ts tests/unit/ipc-guards.test.ts tests/integration/sync-remote-actions.int.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — the Step 2 command — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 21: Change folder: the dialog and the menu

**Files:**
- Create: `src/renderer/folder-dialog.ts`, `tests/e2e/change-folder.spec.ts`
- Modify: `src/renderer/main.ts` (the tab menu item), `src/renderer/index.html` (`<div id="folder-dialog" hidden></div>`), `src/renderer/styles.css`

**Interfaces:**
- Consumes: `listFolders` / `changeFolder` (Task 20); `openRemoteTab` (Task 16); `REMOTE_COPY`.
- Produces: `class FolderDialog { constructor(root: HTMLElement); open(title: string, tabId: string, cb: { list(path: string | null): Promise<FolderResult>; open(path: string): Promise<DeviceResult>; closed(): void }): void; get isOpen(): boolean }`. DOM: `.folder-dialog`, `.folder-title` (the title), the editable `.folder-path` (the listing's path), `.folder-recent-label` (`REMOTE_COPY.recentOn(listing.device)`), `.folder-recent .folder-item`, `.folder-list .folder-item` (`..` first when there is a parent), `.folder-error`, buttons `REMOTE_COPY.openHere` and `REMOTE_COPY.cancel`. Enter in the field lists it; a folder item lists `path` + `sep` (when the path does not end with one) + name; Escape closes without reaching the window; "Open here" closes on `{ ok: true }` and shows the error otherwise. The tab menu of every tab gets `REMOTE_COPY.changeFolder`; the title is `REMOTE_COPY.changeFolderTitle`, or `REMOTE_COPY.changeFolderOn(deviceName)` for a remote tab.

- [ ] **Step 1: Write the failing tests** — `tests/e2e/change-folder.spec.ts`. The single-app tests launch with a temp `CLAUDE_CONFIG_DIR` and a temp home: `env: { CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home }`, with `writeTranscript(config, join(home, 'proj'), SID)` so that "Recent on" has an entry; they never read the real `~/.claude` or home folder.

```ts
test('Change folder… restarts a shell tab in the folder picked in the dialog', async () => {
  test.setTimeout(180_000)
  // a shell tab in work with a subfolder 'sub'; right-click the tab → 'Change folder…' → '.folder-title' has text 'Change folder'
  // '.folder-recent-label' starts with 'Recent on'; '.folder-recent .folder-item' has the text of join(home, 'proj')
  // click the 'sub' item, then 'Open here' → the tab's title attribute ends with the sub folder (pathKey); bufferText shows a new prompt there
})
test('a folder that does not exist gives a message in the dialog', async () => {
  test.setTimeout(180_000)
  // type join(work, 'nope') into '.folder-path', Enter → '.folder-error' has REMOTE_COPY.folderMissing; the dialog stays open
})
test('B opens a Claude tab on A, then moves it to another folder: a new conversation starts there', async () => {
  test.setTimeout(180_000)
  // pairedApps({ a: { env: { HOME: homeA, USERPROFILE: homeA } } }) with a temp homeA: A's tab opens in a.work (startApps' defaultFolder), and the dialog
  // can reach no real home folder; id = await b.page.evaluate((d) => window.ct.openRemoteTab(d, 'claude', null, null), a.id); B opens the dialog on it
  // '.folder-title' 'Change folder on Studio' (SLOW), '.folder-recent-label' 'Recent on Studio'; types another folder of A, 'Open here'
  // A's tab title attribute holds the new folder (SLOW); A's buffer shows 'fake-claude' again, without '--resume'
})
```

- [ ] **Step 2: Run to verify they fail** — `npm run build; npx playwright test tests/e2e/change-folder.spec.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — the Step 2 command — PASS; `npx playwright test tests/e2e/images.spec.ts tests/e2e/notes.spec.ts` — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 22: Recent sessions of every device

**Files:**
- Modify: `src/shared/types.ts` (`RecentSession.device?: { id: string; name: string }`), `src/main/remote-host.ts`, `src/main/sync/remote-actions.ts`, `src/main/index.ts` (`IPC.sessionsOpen`, the new channels), `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/recent-sessions.ts`
- Test: `tests/unit/recent-sessions.test.ts`, `tests/integration/sync-remote-actions.int.test.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Produces:
  - `remote-host.ts`: `HostContext.sessions(): Promise<RecentSession[]>` (today's `sessionsList` answer: `history.list(100, starred.ids())` with `open` and `starred`, which it also keeps for `open-session`) and `HostContext.openSession(id: string): string` (the id of the tab already in that conversation, which is not brought forward here, or of a new Claude tab resuming it, opened with `activate` false; a session it did not list or whose folder is gone → `CallError` with today's toast text); handlers `sessions` (`bulk: true`) and `open-session`.
  - `RemoteActions.sessionsNow(): DeviceAnswer<RecentSession[]>[]` (at once, from the kept answers; each session with `device: { id, name }`) and `refreshSessions(): void` (every online device at once with `LIST_TIMEOUT_MS`, in the background; a changed answer calls `onFresh('sessions')`; a device that does not answer keeps its last answer); `openSession(device: string, id: string): Promise<string | null>`.
  - `IPC`: `remoteSessions: 'remote:sessions'`, `evRemoteSessions: 'ev:remote-sessions'`. `CtApi`: `listRemoteSessions(): Promise<DeviceAnswer<RecentSession[]>[]>` (answers at once from `sessionsNow()`, minus sessions whose id this device lists itself, and starts `refreshSessions()`); `onRemoteSessions(cb: (list: DeviceAnswer<RecentSession[]>[]) => void): Unsubscribe` (sent on `onFresh('sessions')`; the Recent sessions window passes it to `applyRemote`). `sessionsList` stays this device's own, as today. `sessionsOpen` of a remote session (`listedSessions` keeps the remote ones with their `device`) calls `openSession` and brings the tab forward as Task 16 does.
  - `recent-sessions.ts`: `interface SessionSection { device: { id: string; name: string } | null; loading: boolean; arranged: ArrangedSessions }`; `arrangeSections(local: RecentSession[], remote: DeviceAnswer<RecentSession[]>[], query: string): SessionSection[]` — this device's section first (no device, arranged as today by `arrangeSessions`), then one per device in the order given, each arranged the same way (its own starred block and divider, then its projects), with heading keys `groupKey(s)`; a device with `value: null` gives `loading: true` and an empty list. `groupKey(s: RecentSession): string` — `projectKey(s.cwd)` for this device's sessions, `${s.device.id}:${projectKey(s.cwd)}` for another device's; the window uses it everywhere it uses `projectKey` today for the unfolded projects (open, toggleStar). The window draws a `.sessions-device` row with the name before each remote section, and a `.sessions-loading` row with `REMOTE_COPY.loading` for a loading one. `RecentSessionsWindow.applyRemote(list: DeviceAnswer<RecentSession[]>[]): void` — while open, the remote sections are redrawn keeping the selection and the unfolded projects (as `applyStars`). Stars work on them unchanged (part 1 shares them).

- [ ] **Step 1: Write the failing tests**

```ts
// recent-sessions.test.ts
it("another device's sessions come after this device's, under its name, arranged the same way", () => {
  const r = arrangeSections([local(S1)], [{ device: STUDIO.id, name: 'Studio', value: [remote(S2, STUDIO), remote(S3, STUDIO, { starred: true })] }], '')
  expect(r.map((s) => s.device?.name ?? null)).toEqual([null, 'Studio']); expect(r[1].arranged.shown.map((s) => s.id)).toEqual([S3, S2]); expect(r[1].arranged.dividerAt).toBe(1)
})
it('the same folder on two devices is two projects', () => expect(groupKey(remote(S2, STUDIO))).not.toBe(groupKey(local(S1))))   // both in /work
it('a device that has not answered yet shows as loading', () => {
  expect(arrangeSections([], [{ device: STUDIO.id, name: 'Studio', value: null }], '')[1]).toMatchObject({ loading: true, arranged: { shown: [] } })
})
// sync-remote-actions.int.test.ts
it('sessionsNow answers at once; sessions come with the name of their device; one that does not answer keeps null', async () => {
  expect(actions.sessionsNow().map((d) => d.value)).toEqual([null, null]); actions.refreshSessions(); await until(() => fresh.includes('sessions'))
  expect(actions.sessionsNow().find((d) => d.name === 'Studio')!.value![0].device).toEqual({ id: A_ID, name: 'Studio' })
})
// remote-tabs.spec.ts
test("B's Recent sessions lists A's sessions under A's name and resumes one on A", async () => {
  test.setTimeout(180_000)
  // writeTranscript(a.config, a.work, SID); B presses KEYS.recentSessions
  await expect(b.page.locator('.sessions-device', { hasText: 'Studio' })).toBeVisible(SLOW)
  // the row of SID shows (SLOW: the window redraws when A's answer arrives); select it, press Enter → a new tab on A whose buffer shows `--resume ${SID}`; it is in front on B
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/recent-sessions.test.ts tests/integration/sync-remote-actions.int.test.ts`; `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "Recent sessions"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — the Step 2 commands — PASS; `npx playwright test tests/e2e/recent-sessions.spec.ts` — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 23: Receiving pasted and dropped files on the tab's device

**Files:**
- Create: `src/main/sync/file-receiver.ts`, `src/main/sync/file-sender.ts`
- Modify: `src/main/remote-host.ts` (`HostContext.receiver`, the `recv-*` handlers), `src/main/index.ts` (the receiver and its 7-day cleanup)
- Test: `tests/integration/sync-file-receiver.int.test.ts`, `tests/integration/sync-file-transfer.int.test.ts`

**Interfaces:**
- Consumes: the `recv-*` shapes (Task 3); `HostContext`, `hostHandlers`, `RemoteActions.askTab` (Task 9); `until` (Task 1).
- Produces:

```ts
// file-receiver.ts
export function plainName(name: string): string
export class FileReceiver {
  constructor(o: { root: string; idleMs?: number /* 60_000 */; maxBytes?: number /* MAX_TRANSFER_BYTES */ })
  /** a new folder <root>/<mkdtemp>/ for these files, each created there with 'wx' and kept open; refuses more than maxBytes in all; answers the transfer's UUID */
  begin(files: { name: string; size: number }[]): Promise<string>
  part(transfer: string, file: number, offset: number, data: Buffer): Promise<void>
  /** the saved paths, once every file is complete */
  end(transfer: string): Promise<string[]>
  /** removes the transfer folders older than maxAgeMs — only when ClaudeTerm and the root pass the same checks as begin (missing: nothing to do) */
  cleanup(maxAgeMs: number): Promise<void>
  dispose(): void
}
// file-sender.ts
export interface OutgoingFile { name: string; size: number; read(offset: number, length: number): Promise<Buffer> }
export async function sendFiles(actions: RemoteActions, tabId: string, files: OutgoingFile[]): Promise<string[]>
```

  `plainName`: the part after the last `/` or `\`; control characters and `< > : " | ? * $ \` ' ; & ! %` become `_`; leading and trailing dots and spaces go; empty, `.` or `..` → `file`; a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, any case, any extension) gets a leading `_`; cut to 100 characters, keeping an extension of up to 10. Two files of one transfer with the same name become `name (2).ext`. `begin`: `<root>`'s parent `ClaudeTerm` and `<root>` itself are created when missing (mode 0o700) and must then be real directories — `lstat` says directory, not a link (a junction counts as a link), and on POSIX owned by `process.getuid()`; anything else refuses the transfer with `CallError('unsafe folder')` and writes nothing. The transfer folder comes from `mkdtemp(join(root, 't-'))` (0o700 on POSIX); each file is opened with `'wx'` and written through its handle (no path is opened twice); nothing is realpath'd. `part` must come at the file's next offset and not pass its size; an unknown transfer, a wrong offset or an incomplete `end` → `CallError`; a transfer that hears nothing for `idleMs` is removed with its folder. `cleanup` never follows a planted link: it checks as `begin` does, then removes the old entries as `cleanupImageCache` does, with `fs/promises`. `sendFiles`: `recv-begin`, then each file's parts of `TRANSFER_PART_BYTES` as bulk `recv-part` calls one after another, then `recv-end`.

  `remote-host.ts`: `HostContext.receiver: Pick<FileReceiver, 'begin' | 'part' | 'end'>` and handlers `recv-begin`, `recv-part`, `recv-end` (arguments by `CALL_ARGS`; `recv-begin` refuses a tab `ctx.tabs.get` does not know). `index.ts`: `const receiver = new FileReceiver({ root: join(tmpdir(), 'ClaudeTerm', 'received') })` next to `clipboardImageRoot`, `void receiver.cleanup(7 * 24 * 60 * 60 * 1000)` at startup (as `cleanupImageCache(clipboardImageRoot, …)` runs today), `hostCtx.receiver = receiver`, `receiver.dispose()` at `before-quit`.

- [ ] **Step 1: Write the failing tests**

```ts
// sync-file-receiver.int.test.ts (base: a temp folder; root = join(base, 'ClaudeTerm', 'received'); r = new FileReceiver({ root }); real timers)
it('plainName makes a sent name a plain file name', () => {
  expect(plainName('../../evil.sh')).toBe('evil.sh'); expect(plainName('a\\b.png')).toBe('b.png'); expect(plainName('CON.txt')).toBe('_CON.txt')
  expect(plainName('..')).toBe('file'); expect(plainName('a"$b`.png')).toBe('a__b_.png'); expect(plainName('x'.repeat(300) + '.png')).toHaveLength(100)
})
it('a link planted at received (a junction on Windows) is refused and nothing is written through it', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'ct-elsewhere-')); mkdirSync(join(base, 'ClaudeTerm')); symlinkSync(elsewhere, root, 'junction')
  await expect(r.begin([{ name: 'a.png', size: 1 }])).rejects.toThrow('unsafe folder'); expect(readdirSync(elsewhere)).toEqual([])
})
it('a link planted at ClaudeTerm is refused the same way', async () => { /* symlinkSync(elsewhere, join(base, 'ClaudeTerm'), 'junction') → begin rejects 'unsafe folder'; elsewhere stays empty */ })
it('cleanup does not remove anything through a planted link', async () => {
  // elsewhere holds old.txt with an mtime 30 days back (utimesSync); a junction at root → elsewhere
  await r.cleanup(7 * 24 * 60 * 60 * 1000); expect(readdirSync(elsewhere)).toEqual(['old.txt'])
})
it('each transfer gets its own new folder, private on POSIX', async () => {
  await r.begin([{ name: 'a.png', size: 1 }]); await r.begin([{ name: 'a.png', size: 1 }])
  expect(readdirSync(root)).toHaveLength(2)   // on POSIX: statSync(each).mode & 0o777 === 0o700
})
it('a part at a wrong offset or for an unknown transfer is refused; an end before every byte is refused', async () => {
  const t = await r.begin([{ name: 'a.bin', size: 4 }])
  await expect(r.part(t, 0, 2, Buffer.from('xx'))).rejects.toThrow(); await expect(r.part(UNKNOWN, 0, 0, Buffer.from('x'))).rejects.toThrow()
  await r.part(t, 0, 0, Buffer.from('ab')); await expect(r.end(t)).rejects.toThrow(); await expect(r.part(t, 0, 2, Buffer.from('cde'))).rejects.toThrow()
})
it('a transfer left unfinished goes after idleMs, with its folder', async () => {
  const r50 = new FileReceiver({ root, idleMs: 50 })
  const t = await r50.begin([{ name: 'a.bin', size: 4 }]); await r50.part(t, 0, 0, Buffer.from('ab'))
  const folder = join(root, readdirSync(root)[0])
  await until(() => !existsSync(folder)); await expect(r50.part(t, 0, 2, Buffer.from('cd'))).rejects.toThrow()
})
// sync-file-transfer.int.test.ts (B sends with sendFiles through RemoteActions to A's FileReceiver in a temp root, each end a device as in Task 7)
it("a pasted image and dropped files land in a new folder under the receiving device's root, and the paths exist", async () => {
  const paths = await sendFiles(actions, T1, [file('shot.png', 1.5 * 1024 * 1024), file('notes.txt', 10)])
  expect(paths.map((p) => basename(p))).toEqual(['shot.png', 'notes.txt']); expect(pathKey(dirname(dirname(paths[0])))).toBe(pathKey(root))
  expect(readFileSync(paths[0]).equals(bytes('shot.png'))).toBe(true)
})
it('names with .., separators or reserved names arrive made plain; two of one name both arrive', async () => {
  const paths = await sendFiles(actions, T1, [file('../../up.txt', 3), file('dir/a.txt', 3), file('a.txt', 3), file('NUL', 3)])
  expect(paths.map((p) => basename(p))).toEqual(['up.txt', 'a.txt', 'a (2).txt', '_NUL']); for (const p of paths) expect(pathKey(dirname(dirname(p)))).toBe(pathKey(root))
})
it('more than 50 MB in all is refused and nothing is written', async () => {
  await expect(sendFiles(actions, T1, [file('a.bin', 30 * 1024 * 1024), file('b.bin', 30 * 1024 * 1024)])).rejects.toThrow(); expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
})
```

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run tests/integration/sync-file-receiver.int.test.ts tests/integration/sync-file-transfer.int.test.ts` — FAIL (modules missing).
- [ ] **Step 3: Implement** `file-receiver.ts`, `file-sender.ts`, the handlers and the `index.ts` lines.
- [ ] **Step 4: Run them to verify they pass** — the Step 2 command, three times — PASS; `npm run typecheck` — no errors.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 24: Pasting and dropping into a remote tab

**Files:**
- Modify: `src/main/ipc-guards.ts` (`isDropPaths`), `src/main/index.ts` (the two IPC handlers), `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/keymap.ts` (`imagePasteRoute`), `src/renderer/main.ts` (`pasteImage`, the drop handler)
- Test: `tests/unit/ipc-guards.test.ts`, `tests/unit/keymap.test.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Consumes: `sendFiles`, `OutgoingFile`, the receiver on the tab's device (Task 23); `RemoteActions` (Task 9); `REMOTE_COPY`, `MAX_TRANSFER_FILES`, `MAX_TRANSFER_BYTES`, `COPY_TOAST_MS` (Task 2).
- Produces:

```ts
// keymap.ts
/** how an image-only clipboard reaches a tab: 'remote' copies it to the tab's device and types the path there; 'file' types a local PNG file's path; 'key' sends Claude Code's image-paste key */
export function imagePasteRoute(o: { platform: string; remote: boolean; asFile: boolean }): 'remote' | 'file' | 'key'
```

  `imagePasteRoute`: `remote` → `'remote'` on every platform; else `'file'` on `win32` with `asFile`, `'key'` otherwise (today's rule).

  `IPC`: `remotePasteImage: 'remote:paste-image'`, `remoteDropFiles: 'remote:drop-files'`; `CtApi`: `pasteImageToRemote(tabId: string): Promise<string | null>` (the clipboard's PNG as `clipboard-<ms>.png`, an `OutgoingFile` over the buffer; the path on the tab's device), `dropFilesToRemote(tabId: string, paths: string[]): Promise<string[] | null>` (an `OutgoingFile` per path, read with `fs/promises`). Guards: `isId(tabId)` and a remote tab; a new `isDropPaths(v: unknown): v is string[]` in `ipc-guards.ts` — 1..`MAX_TRANSFER_FILES` entries, each `isAbsPath` (these are this device's own files); main then checks each is a regular file. Over `MAX_TRANSFER_BYTES` in all → toast `REMOTE_COPY.copyTooLarge(device)`, nothing copied, null; a copy still running after `COPY_TOAST_MS` → toast `REMOTE_COPY.copying(device)`; a failure → toast `REMOTE_COPY.copyFailed(device, message)`, null. Renderer: `pasteImage` takes `imagePasteRoute({ platform: ct.platform, remote: t.info.remote !== undefined, asFile })` first — `'remote'` → `pasteImageToRemote` and `term.paste(`"${path}"`)`, never the paste key (and `asFile` is asked only for a local tab on Windows); the drop handler of a remote tab calls `dropFilesToRemote` and types the quoted paths joined by spaces, as a local drop does.

- [ ] **Step 1: Write the failing tests**

```ts
// ipc-guards.test.ts
it('isDropPaths takes 1 to MAX_TRANSFER_FILES absolute paths of this device', () => {
  expect(isDropPaths([ABS])).toBe(true); expect(isDropPaths([])).toBe(false); expect(isDropPaths(Array(MAX_TRANSFER_FILES + 1).fill(ABS))).toBe(false); expect(isDropPaths(['relative'])).toBe(false)
})
// keymap.test.ts
it('an image pasted into a remote tab is always copied there, on every system', () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const asFile of [true, false]) expect(imagePasteRoute({ platform, remote: true, asFile })).toBe('remote')
  expect(imagePasteRoute({ platform: 'win32', remote: false, asFile: true })).toBe('file'); expect(imagePasteRoute({ platform: 'darwin', remote: false, asFile: false })).toBe('key')
})
// remote-tabs.spec.ts
test("an image pasted into A's tab on B is copied to A and its path typed there, never as the paste key", async () => {
  test.setTimeout(180_000)
  // B launched with env POWERSHELL_WORKS on Windows (where a local paste would send the key; as in keys.spec.ts); B is on A's shell tab
  // inside keepingClipboard(b.app): a PNG_1x1 on B's clipboard, click '.terminal-host:visible .xterm', press KEYS.paste
  // A's buffer shows a path under <tmp>/ClaudeTerm/received/ (SLOW); that file exists on A and equals PNG_1x1
  // B's ptyInput(tab.id) holds '"<that path>"' and neither '\x1bv' nor '\x16'
  // (it reads the desktop clipboard: on this machine it fails like the baseline tests; CI runs it on the three systems)
})
test("dropped files are copied to A's tab device; more than 50 MB is refused with a toast", async () => {
  test.setTimeout(180_000)
  // a 10-byte file on B's side: paths = await b.page.evaluate(([id, p]) => window.ct.dropFilesToRemote(id, [p]), [tab.id, f]) → one path under A's received folder, same bytes
  // a 51 MB sparse file (ftruncateSync): dropFilesToRemote → null, and '#toasts' contains REMOTE_COPY.copyTooLarge('Studio') (SLOW)
})
```

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run tests/unit/ipc-guards.test.ts tests/unit/keymap.test.ts`; `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "pasted|dropped"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass** — the Step 2 commands — PASS (the paste test apart from this machine's clipboard); `npx playwright test tests/e2e/keys.spec.ts tests/e2e/clipboard.spec.ts` — as the baseline.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 25: Keeping the device awake

**Files:**
- Create: `src/main/sync/keep-awake.ts`
- Modify: `src/shared/types.ts` (`Settings.devices.keepAwake: boolean`), `src/main/settings.ts` (default `true`, `isBool`; `applySettingEdit` takes it), `src/shared/settings-keys.ts` (`'devices.keepAwake'` in both the `SettingKey` union and `SETTING_KEYS`), `src/renderer/settings-page.ts` and `src/renderer/devices-section.ts` (the checkbox, shown in a group only), `src/main/remote-holder.ts` (`onLinks`, `onWatchers`), `src/main/index.ts`
- Test: `tests/unit/sync-keep-awake.test.ts`, `tests/unit/settings.test.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface PowerBlocker { start(): number; stop(id: number): void }
export interface KeepAwakeDeps { blocker: PowerBlocker; enabled(): boolean; now(): number; inputMs?: number /* AWAKE_INPUT_MS */; tickMs?: number /* 60_000 */ }
export class KeepAwake {
  constructor(deps: KeepAwakeDeps)
  /** a member typed into one of this device's tabs */
  input(): void
  /** linked: a member link is up; watchedWorking: a Claude tab another device has attached is working */
  update(state: { linked: boolean; watchedWorking: boolean }): void
  holding(): boolean
  dispose(): void
}
```

  Rule: hold ⇔ `enabled() && linked && (now − last input < inputMs || watchedWorking)`; re-checked on every call and every `tickMs` while holding; the blocker is started once and stopped once per hold. `devicesSection(extra: HTMLElement[] = [])` appends `extra` while the device is in a group; `settings-page.ts` passes `checkboxField('devices.keepAwake', REMOTE_COPY.keepAwake, (v) => v.settings.devices.keepAwake)`. `index.ts`: the blocker is `isTest ? testBlocker : { start: () => powerSaveBlocker.start('prevent-app-suspension'), stop: (id) => powerSaveBlocker.stop(id) }`, where `testBlocker` counts ids and appends `start` / `stop` lines to `CLAUDETERM_TEST_POWER_LOG` when set; `new KeepAwake({ blocker, enabled: () => settings.devices.keepAwake, now: Date.now })`; `writeInput` with a device → `keepAwake.input()`; `update({ linked: (remote?.host.peers().length ?? 0) > 0, watchedWorking: tabs.list().some((t) => t.kind === 'claude' && tabs.isWorking(t.id) && (remote?.host.watchers(t.id).length ?? 0) > 0) })` from `onStateChanged`, the holder's new deps `onWatchers` (passed to `TabHost`) and `onLinks` (a member link up or down), `reloadSettings` and `stopRemote`.

- [ ] **Step 1: Write the failing tests**

```ts
it('holds while a member typed in the last 30 minutes, and lets go after', () => {
  k.update({ linked: true, watchedWorking: false }); k.input(); expect(blocker.started).toBe(1)
  now += AWAKE_INPUT_MS + 1; vi.advanceTimersByTime(60_000); expect(blocker.stopped).toBe(1); expect(k.holding()).toBe(false)
})
it('holds while a Claude tab another device has attached is working', () => { k.update({ linked: true, watchedWorking: true }); expect(k.holding()).toBe(true) })
it('lets go when the setting goes off and when the last link ends', () => {
  k.update({ linked: true, watchedWorking: true }); enabled = false; k.update({ linked: true, watchedWorking: true }); expect(k.holding()).toBe(false)
  enabled = true; k.update({ linked: true, watchedWorking: true }); k.update({ linked: false, watchedWorking: true }); expect(k.holding()).toBe(false)
})
it('starts the blocker once and stops it once', () => { /* three updates that hold, then one that does not → started 1, stopped 1 */ })
// settings.test.ts: the 'devices settings' block's assertions toEqual({ port: 47821 }) and toEqual({ port }) become
// toEqual({ port: 47821, keepAwake: true }) and toEqual({ port, keepAwake: true }); new: devices.keepAwake defaults to true, false is kept,
// 'yes' falls back with 'settings.json: invalid value for "devices.keepAwake", using default'; applySettingEdit('{}', 'devices.keepAwake', 'yes') → the invalid value error
// remote-tabs.spec.ts
test('B typing into A keeps A awake; unticking the setting on A lets it sleep', async () => {
  test.setTimeout(180_000)
  // A launched with env CLAUDETERM_TEST_POWER_LOG: log; powerLines() reads it
  // B types into A's shell tab → powerLines() is ['start'] (SLOW)
  // A's Settings window (Promise.all([a.app.waitForEvent('window'), a.page.keyboard.press(KEYS.settings)])) shows
  //   'Keep this computer awake while another device uses it' checked; unticking it → powerLines() is ['start', 'stop'] (SLOW) and settings.json has devices.keepAwake false
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/sync-keep-awake.test.ts tests/unit/settings.test.ts`; `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "awake"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — the Step 2 commands — PASS; `npx playwright test tests/e2e/devices.spec.ts tests/e2e/settings.spec.ts` — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 26: device_status and open_device_settings

**Files:**
- Create: `src/mcp/device-tools.ts`, `src/main/sync/device-status.ts`
- Modify: `src/mcp/show-image-server.ts`, `src/shared/protocol.ts`, `src/main/pipe-server.ts`, `src/main/index.ts`
- Test: `tests/unit/protocol.test.ts`, `tests/unit/device-status.test.ts`, `tests/unit/device-tools.test.ts`, `tests/integration/mcp.int.test.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Produces:
  - `protocol.ts`: `DeviceStatusMessage { v: 1; type: 'device_status' }`, `OpenDeviceSettingsMessage { v: 1; type: 'open_device_settings' }` in `PipeMessage` and `parsePipeMessage`; `PipeHandlers.deviceStatus(msg): PipeResponse` (`info`: the text) and `openDeviceSettings(msg): PipeResponse`.
  - `device-status.ts`: `formatDeviceStatus(s: { view: ActiveDevicesView | null; selfTabs: RemoteTab[]; tabsOf(device: string): RemoteTab[] | null }): string` — no group: `Device sync is not set up: in Settings → Devices, show a code or join a device.`; otherwise this device (name, port or `not listening`, and `The other devices cannot connect to this one.` when `unreachableByOthers`), then each device on its line `<name> (<Windows|macOS|Linux>): <state as DEVICE_COPY words it>`, and the tabs of this device and of every connected device as `"<name>" (<Claude|shell>[, working][, waiting: <reason>]) in <folder>`, where `<name>` is `customTitle ?? title ?? <the folder's last part>` — the name the tab bar shows (`titleOf`, main.ts: the renamed title first, then the program's title, then the folder); `problem` and `removedBy` when set; `A pairing code is shown.` without the code. Never a code, a key or a fingerprint.
  - `device-tools.ts`: `handleDeviceStatus(deps: { pipeName: string; send(pipe: string, msg: DeviceStatusMessage): Promise<PipeResponse> }): Promise<ToolResult>` and `handleOpenDeviceSettings(deps: { pipeName: string; send(pipe: string, msg: OpenDeviceSettingsMessage): Promise<PipeResponse> }): Promise<ToolResult>` (answer text `Opened Settings → Devices in ClaudeTerm.`), in the style of `show-diff-tool.ts` (`PipeUnavailableError` → `ClaudeTerm is not running`). `show-image-server.ts` registers `device_status` ("Read-only status of ClaudeTerm's device sync: the devices of the group, whether each is connected, a port problem, whether the other devices can reach this one, and the tabs open on each device. Never shows pairing codes or keys.") and `open_device_settings` ("Open ClaudeTerm's Settings window at the Devices section, where the user pairs, joins and removes devices themselves."), both without arguments.
  - `index.ts`: `deviceStatus` → `{ ok: true, info: formatDeviceStatus({ view: group?.view() ?? null, selfTabs: hostTabs(hostCtx).list(), tabsOf: (id) => (remote?.viewer.online(id) ? remote.viewer.tabsOf(id) : null) }) }`; `openDeviceSettings` → `settingsWindow.open()`, `{ ok: true }` (Task 27 opens it at the Devices section).

- [ ] **Step 1: Write the failing tests**

```ts
// protocol.test.ts
it('the device messages parse, keeping only their fields', () => {
  expect(parsePipeMessage({ v: 1, type: 'device_status', code: 'x' })).toEqual({ v: 1, type: 'device_status' }); expect(parsePipeMessage({ v: 1, type: 'open_device_settings' })).toEqual({ v: 1, type: 'open_device_settings' })
})
// device-status.test.ts
it('names each device, its state and its tabs, and never a code', () => {
  const text = formatDeviceStatus({ view: view({ pairing: pairingWithCode('K7QM-2XPD-9TRA-W4BN') }), selfTabs: [tab('build', { working: true })], tabsOf: () => [tab('tests', { attention: 'permission' })] })
  expect(text).toContain('Laptop (macOS): Connected'); expect(text).toContain('"tests" (Claude, waiting: permission)'); expect(text).toContain('A pairing code is shown.'); expect(text).not.toContain('K7QM')
})
it("a tab's name is its renamed title, else the program's title, else its folder", () => {
  // tab(name, o): a RemoteTab with customTitle: name, then the fields of o. customTitle 'notes-tab' with title 'vim' → the text holds '"notes-tab"';
  // tab(null, { title: 'vim' }) → '"vim"'; tab(null, { title: null, cwd: '/src/proj' }) → '"proj"'
})
it('without a group it says how to set one up', () => expect(formatDeviceStatus({ view: null, selfTabs: [], tabsOf: () => null })).toMatch(/^Device sync is not set up/))
// device-tools.test.ts
it("the pipe's answer becomes the tool text; a pipe that is not there gives ClaudeTerm is not running", async () => {
  expect(await handleDeviceStatus({ pipeName: 'p', send: async () => ({ ok: true, info: 'status' }) })).toEqual({ text: 'status', isError: false })
  expect((await handleDeviceStatus({ pipeName: 'p', send: async () => { throw new PipeUnavailableError('p') } })).text).toMatch(/ClaudeTerm is not running/)
})
// mcp.int.test.ts: the tool list becomes ['device_status', 'open_device_settings', 'show_diff', 'show_image'];
// new: calling device_status sends { v: 1, type: 'device_status' } to the test's pipe (which answers { ok: true, info: 'status text' }) and returns that text;
// calling open_device_settings sends { v: 1, type: 'open_device_settings' }
// remote-tabs.spec.ts
test('device_status lists the devices and their tabs', async () => {
  test.setTimeout(180_000)
  // pairedApps; B opens a second tab (openShell) and renames it 'notes-tab'
  await expect.poll(async () => ((await sendPipeMessage(a.pipeName, { v: 1, type: 'device_status' })) as { info?: string }).info ?? '', SLOW).toMatch(/Laptop[\s\S]*Connected[\s\S]*notes-tab/)
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/protocol.test.ts tests/unit/device-status.test.ts tests/unit/device-tools.test.ts tests/integration/mcp.int.test.ts`; `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "device_status"` — FAIL.
- [ ] **Step 3: Implement.** (`mcp.int.test.ts` runs the built bundle `resources/mcp/*.js`: `npm run build` first.)
- [ ] **Step 4: Run to verify they pass** — the Step 2 commands — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 27: Settings opens at Devices; each device's tab count

**Files:**
- Modify: `src/main/settings-window.ts`, `src/main/index.ts`, `src/shared/ipc.ts` (`evSettingsSection: 'ev:settings-section'`), `src/preload/index.ts` (`onSettingsSection(cb: (section: string) => void): Unsubscribe`), `src/renderer/settings-page.ts`, `src/renderer/devices-section.ts`, `src/shared/devices.ts` (`DeviceView.tabs?: number`)
- Test: `tests/unit/settings-window.test.ts`, `tests/e2e/remote-tabs.spec.ts`

**Interfaces:**
- Produces:
  - `SettingsWindow.open(section?: 'devices'): void` — a new window loads with `#devices`; an open one is focused and sent `evSettingsSection`; `SettingsWindowDeps.load(win: BrowserWindow, section?: string)`. The Devices section's root has `id="devices"`; `settings-page.ts` scrolls it into view for `#devices` and on `onSettingsSection`.
  - `index.ts`: `openDeviceSettings` → `settingsWindow.open('devices')`. The view broadcast to the Settings window (`onView` and `devicesView()`) adds `tabs: remote.viewer.tabsOf(d.id).length` to every connected device, and is sent again when a device's tabs open or close (`viewerEvents.opened` / `closed`); `devices-section.ts` shows `REMOTE_COPY.tabCount(n)` on the device's line when `tabs` is set.

- [ ] **Step 1: Write the failing tests**

```ts
// settings-window.test.ts
it('open with a section loads a new window at it, and tells an open one', () => {
  sw.open('devices'); expect(loads.at(-1)).toEqual([win1, 'devices']); sw.open('devices'); expect(win1.focused).toBe(true); expect(win1.sent).toContainEqual([IPC.evSettingsSection, 'devices'])
})
// remote-tabs.spec.ts
test("open_device_settings opens the Devices section, where each device's line counts its tabs", async () => {
  test.setTimeout(180_000)
  // pairedApps; B opens a second tab (openShell): B has two tabs
  const [win] = await Promise.all([a.app.waitForEvent('window'), sendPipeMessage(a.pipeName, { v: 1, type: 'open_device_settings' })])
  await expect.poll(() => win.url(), SLOW).toMatch(/#devices$/); await expect(win.locator('#devices')).toContainText(REMOTE_COPY.tabCount(2), SLOW)
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/settings-window.test.ts`; `npm run build; npx playwright test tests/e2e/remote-tabs.spec.ts -g "open_device_settings"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — the Step 2 commands — PASS; `npx playwright test tests/e2e/devices.spec.ts tests/e2e/settings.spec.ts` — PASS.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**

---

### Task 28: README and CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (a new top section `## 0.13.0` with `### New`), `README.md` (a "Devices" part under Features, and the Settings → Devices line in the Settings part)

- [ ] **Step 1: Write the text** for the people who use the app, as the 0.12.0 section reads (bold lead, then what to click and what happens), never a list of commits: devices pair with a one-time code over a network the user set up (home network, Tailscale, a VPN) without any server; stars and notes are the same on every device; every device's tabs show in one tab bar under the device's chip, and can be typed into, resized, closed and opened from any device; Media, Changes, notes, the status bar, attention and sounds work for them; Change folder…; Recent sessions of every device; pasting and dropping files copies them to the tab's device; the device stays awake while used from another; Windows asks once for the firewall. Only invented names in examples (`Studio`, `Laptop`). The README images are not regenerated: their tab bar does not change. The version in `package.json` is set by the release, not here.
- [ ] **Step 2: Verify** — `node scripts/release-notes.mjs 0.13.0` prints the section starting with `### New`; `npx vitest run tests/integration/release-notes.int.test.ts` — PASS.
- [ ] **Step 3: Run everything** — `npm run typecheck; npx vitest run; npm run build; npx playwright test` — all PASS apart from the baseline failures of the Global Constraints.
- [ ] **Step 4: Note for the release (not run in this plan, which builds no installer):** before tagging, the release builds are checked by hand on each system once — the NSIS installer, the deb and the ad-hoc macOS build: two devices pair, and a remote tab shows its screen (this proves the unpacked screen worker loads in a packaged app); and on a Mac, typing from another device into a tab of a hidden or covered ClaudeTerm window does not lag (App Nap). Put these two checks in the summary for the user.
- [ ] **Step 5: Leave the changes uncommitted (the user's rule).**
