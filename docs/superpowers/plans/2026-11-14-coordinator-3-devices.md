# Project coordinator, part 3 of 3: sessions on paired devices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A coordinator on one device attaches, tasks, follows, starts and detaches Claude sessions that run on a paired device: the session's device confirms or refuses an attach, runs part 1's task machine for its session and sends the report back; the coordinator's rows show the session's prompt, usage limit, task list and task from new `RemoteTab` fields, `Offline` while its device is away and `Attaching…` until it confirms.

**Architecture:** Everything rides on what parts 1 and 2 built. A peer's hello gets `coord: 1`; `MailSync` sends records with a `kind` only to such peers. Attach and detach records cross devices as signals the receiving `CoordinatorHub` acts on (`delivered` = accepted, a `detach` with `replyTo` = refused); tasks and reports already travel as mail and part 1's hub on the session's device runs the task. A Claude tab's directory entry carries `RemoteCoordFacts` (built by the hub on its device) so the coordinator's rows need no new calls. The remote `open-tab` call gains a folder, an email and a title. New ids (`/clear`) and replaced coordinators travel as `attach` records with `was` / `replaces`.

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), the device links (`PeerLink`, `MailSync`, `RemoteTabs`, `TabHost`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-project-coordinator-design.md` — read it before any task. Part 1's plan, `docs/superpowers/plans/2026-11-14-coordinator-1-core.md`, defines every name this plan builds on (`CoordinatorHub`, `HUB_TEXT`, `CoordinatorStore`, `rowState`, `world()`, `coordApp`, …); read its Tasks 4–8 and 11 and its "Interfaces for parts 2 and 3". Rules every change is held to: `AGENTS.md`.

## Global Constraints

- Everything in AGENTS.md and in part 1's Global Constraints applies: English texts, untrusted input validated and bounded, `pathKey` for paths, main never blocks, tests under `tmpdir()` with invented names, each file's line endings kept.
- Commit steps run only when the controller allows commits; until then leave the work in the working tree.
- The coordinator is used only in the window of its own device (spec, Non-goals): nothing here shows another device's coordinator, its panel or its marks. A session's own device shows only that its session is attached (part 1's `attached` mark, `coordinatorTabId: null`).
- Older devices: a record with a `kind` (`task`, `report`, `attach`, `detach`) never goes to a peer whose hello lacks `coord: 1`, and none is taken from one. Such a device's sessions cannot be attached or started there: `HUB_TEXT.oldDevice`.
- Signals across devices are written `delivered: false, read: false`. The receiving device marks an `attach` `delivered` (and `read`) when it accepts it, only `read` when it refuses (and answers with a `detach` whose `replyTo` is the attach's id and whose text is the reason); it marks a `detach` or a rename notice `delivered` and `read` once it acted. Signals still wake nobody and never show in the Agent messages panel (part 1).
- Bounds of what another device sends: `RemoteCoordFacts` — a prompt line ≤ `PROMPT_TEXT_MAX` (200), a task title and a coordinator name ≤ `COORD_FACT_TEXT_MAX` (200), all without control characters; times non-negative safe integers. `open-tab` — `cwd` 1–`MAX_PATH_TEXT` without NUL, `email` 3–320 characters with an `@` and no control character, `title` 1–`COORD_NAME_MAX` (100) without control characters. A folder another device sends is used only when it is absolute on the host and an existing directory (async check), else the host's default folder.
- No time limit for an offline device: its sessions stay attached (`Offline`), and records for it wait in the store until it connects.
- Names compared without case: device names (`start_session`'s `device`), project names (Not attached on other devices, the start folder), emails (trimmed too).
- `REMOTE_ATTACH_WAIT_MS = 8000`: how long `attach_session` waits for the other device's answer; its pipe wait is `COORD_ATTACH_TIMEOUT_MS = 15_000`.
- Unit tests of two devices run two hubs on two stores and carry records between them with `sync()` (Task 3's fixture); e2e tests pair two real apps with `pairedApps` through `coordDevices()` (Task 5), named Studio (the coordinator's) and Laptop, `test.setTimeout(180_000)`, `test.afterEach(closePaired)`.

## Review Focus

1. **A device that drops off while an attach or a task is in flight:** the record waits; the row stays `Attaching…` (or the task queued) with no time limit, and the answer comes when the device is back — Task 6 (`an attach whose device goes offline …`), Task 6 e2e (offline task).
2. **A newer and an older device in one group:** the older one never gets a `task` or an `attach` (it would strip the kind and wake its session with a plain message) — Task 1 (gating both ways), Task 6 e2e (`CLAUDETERM_TEST_NO_COORD`).
3. **A new session id while the other side is offline** (`/clear` in the coordinator or in the session, a replacing coordinator): records written to the old id still land — Task 7 (forwarding, `former` ids), Task 7 e2e.
4. **A tab of the other device dragged onto the coordinator, or attached by the panel:** its id is a remote tab id, which part 1's IPC guard and `attachTab` refused — Task 6 (`attachTab` with a remote tab, the guard), Task 6 e2e.
5. **A folder or an account that means nothing on the other device** (a Windows path sent to a Mac, a coordinator on a token account with no email): the host opens in its default folder and the answer says so; the main account is used — Task 4 (`relative` folder), Task 8 (no email).

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/sync/wire.ts`, `src/main/sync/device-group.ts` (modify) | the hello's `coord: 1` |
| `src/main/mail/mail-sync.ts` (modify) | records with a kind only to and from peers that know them; `knowsCoordinator` |
| `src/shared/mail.ts`, `src/main/mail/mail-record.ts` (modify) | `was`, `replaces` on an `attach` |
| `src/main/coordinator/coordinator-store.ts` (modify) | `pending`, `former`, `coordinatorBy`, `hostedBy` |
| `src/shared/remote.ts`, `src/main/sync/remote-wire.ts`, `src/main/remote-host.ts` (modify) | `RemoteCoordFacts` in the directory; `open-tab` with folder, email, title |
| `src/main/sync/remote-shapes.ts` (modify) | `open-tab` arguments and reply |
| `src/main/coordinator/remote-start.ts` (create) | `accountForEmail`, `remoteFolderText` |
| `src/main/coordinator/session-state.ts`, `session-text.ts` (modify) | `Attaching…` / `Offline` lines; their notes |
| `src/main/coordinator/coordinator-hub.ts` (modify) | facts, rows of other devices, remote attach / detach / leave / tasks, renames, remote start |
| `src/shared/protocol.ts`, `src/mcp/coordinator-tools.ts` (modify) | `start`'s folder on another device; `attach_session`'s wait; descriptions |
| `src/main/index.ts`, `src/shared/ipc.ts`, `src/preload/index.ts` (modify) | wiring; `coordLeave` |
| `tests/fixtures/coordinator-world.ts` (create) | part 1's `world()` moved here, with one-device and two-device options |
| `tests/e2e/coordinator-helpers.ts` (modify), `tests/e2e/coordinator-devices.spec.ts` (create) | two paired apps with a coordinator |

---

### Task 1: The capability flag, and coordinator records only between devices that know them

**Files:**
- Modify: `src/main/sync/wire.ts:33-46` (`HelloMessage`), `:233-247` (`parseHello`)
- Modify: `src/main/sync/device-group.ts:33-57` (deps), `:339-347` (hello)
- Modify: `src/main/mail/mail-sync.ts` (`MailLink`, `attach`, `onMessage`, `onHave`, `relay`)
- Modify: `src/main/index.ts:2444-2453` (`DeviceGroup.open` deps)
- Test: `tests/unit/mail-wire.test.ts`, `tests/integration/sync-device-group.int.test.ts`, `tests/integration/mail-sync.int.test.ts`

**Interfaces:**
- Consumes: part 1 Task 1 (`MailRecord.kind`, `kindOf`).
- Produces:
  ```ts
  // wire.ts, HelloMessage gets:
  /** 1 when the device knows the coordinator's mail records (task, report, attach, detach); absent from a device that does not */
  coord?: 1
  // device-group.ts, DeviceGroupDeps gets:
  /** false: the hello leaves coord out (a test stands in for an older device); left out: true */
  knowsCoordinator?: boolean
  // mail-sync.ts, MailSync gets:
  /** true while the device is linked and its hello says it knows coordinator records */
  knowsCoordinator(device: string): boolean
  ```
- `parseHello` keeps `coord` only when it is `1`, as it does `mail`. `MailLink` gets `coord: boolean` (`hello.coord === 1`). On a link whose peer lacks it: `relay` and the answer to its digest (`missingFor`) leave out every record whose `kindOf(r) !== 'message'`; an incoming `mail-records` keeps only the records with no `kind` before `store.merge`.
- `index.ts`: `knowsCoordinator: !(isTest && process.env.CLAUDETERM_TEST_NO_COORD === '1')`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mail-wire.test.ts`:
```ts
it('a hello with coord: 1 keeps it; a hello without it, or with coord: 2, has no coord field', () => {
  expect(parseMessage({ ...hello, coord: 1 })).toMatchObject({ t: 'hello', coord: 1 })
  expect(parseMessage(hello)).not.toHaveProperty('coord')
  expect(parseMessage({ ...hello, coord: 2 })).not.toHaveProperty('coord')
})
```
`tests/integration/sync-device-group.int.test.ts` (`OpenOptions` gets `knowsCoordinator?: boolean`, passed to the deps):
- `the hello says the device knows coordinator records` — as the existing onPeer test, `peers[0][1].coord` is `1`.
- `a device opened with knowsCoordinator false leaves coord out of its hello` — `b` opened with `{ knowsCoordinator: false }`: `expect(peers[0][1]).not.toHaveProperty('coord')`.

`tests/integration/mail-sync.int.test.ts` (`helloOf(id, mail = true, coord = true)` adds `coord: 1` when `coord`; new `describe('coordinator records between devices')`):
```ts
it('a record with a kind goes only to a peer whose hello knows coordinator records; a message goes to every peer', async () => {
  // a is linked to b (knows them) and to c (does not): a.attach(ab.client, helloOf(DEV_B)); a.attach(ac.client, helloOf(DEV_C, true, false)); b and c attach their ends with helloOf(DEV_A)
  const task = record({ kind: 'task', project: 'acme' })
  const attach = record({ kind: 'attach', project: 'acme', to: { device: DEV_C, session: SES_C, name: 'Tester' } })
  const message = record({ to: { device: DEV_C, session: SES_C, name: 'Tester' } })
  sa.add(task); sa.add(attach); sa.add(message)
  await until(() => sb.get(task.id) !== undefined && sc.get(message.id) !== undefined)
  await settle()
  expect(sc.get(attach.id)).toBeUndefined()
  expect(sc.get(task.id)).toBeUndefined()
})
it('the answer to a digest leaves out the records with a kind for a peer that does not know them', ...)   // records added to sa before the link: sb (no coord) gets the message, not the task
it('records with a kind from a peer that does not know them are dropped; its messages are kept', ...)      // a sees b without coord, b sees a with it; sb.add(task to A), sb.add(message to A): sa has the message, not the task
it('knowsCoordinator is true for a linked peer with coord, false for one without, and false once the link closes', ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/mail-wire.test.ts tests/integration/sync-device-group.int.test.ts tests/integration/mail-sync.int.test.ts`
Expected: FAIL (`coord` is dropped; the task reaches c; `knowsCoordinator` is not a function).

- [ ] **Step 3: Implement** the Interfaces block.

- [ ] **Step 4: Run the tests and the type check**

Run: the command of Step 2, then `npm run typecheck`
Expected: PASS, the existing tests of these files included.

- [ ] **Step 5: Commit**
```bash
git add src/main/sync/wire.ts src/main/sync/device-group.ts src/main/mail/mail-sync.ts src/main/index.ts tests/unit/mail-wire.test.ts tests/integration/sync-device-group.int.test.ts tests/integration/mail-sync.int.test.ts
git commit -m "feat: devices say they know coordinator records, and such records go only between them"
```

---

### Task 2: Rename fields on attach records, and the store's pending and former ids

**Files:**
- Modify: `src/shared/mail.ts` (`MailRecord`), `src/main/mail/mail-record.ts` (`checkMailRecord`)
- Modify: `src/main/coordinator/coordinator-store.ts`
- Modify: `src/main/coordinator/coordinator-hub.ts` (every place it builds a `StoredAttachment`, `StoredCoordinator` or `StoredHosted`)
- Test: `tests/unit/mail-record.test.ts`, `tests/unit/coordinator-store.test.ts`, `tests/unit/coordinator-hub.test.ts` (literals only)

**Interfaces:**
- Consumes: part 1 Task 1 (`checkMailRecord` kinds), Task 4 (the store).
- Produces (`src/shared/mail.ts`, `MailRecord` gets):
  ```ts
  /** attach: the sender's end took a new session id (a clear, a compaction); was is the id it had. The receiver re-keys what it holds of that end, the tasks it gave included */
  was?: string
  /** attach: the coordinator session the sender replaces on its device. The session moves to the sender; its tasks keep their giver */
  replaces?: string
  ```
  `checkMailRecord`: an `attach` keeps `was` and `replaces` when each is a UUID; a present one that is not → `null`; every other kind drops both.
- Produces (`coordinator-store.ts`):
  ```ts
  export const MAX_FORMER = 8
  // StoredAttachment gets:
  /** the id of the attach record its device has not confirmed yet; null once confirmed, and always for this device's sessions */
  pending: string | null
  // StoredCoordinator gets:
  /** the coordinator's earlier session ids and those of the coordinators it replaced, newest first, at most MAX_FORMER */
  former: string[]
  // StoredHosted gets:
  /** the session's earlier ids, newest first, at most MAX_FORMER */
  former: string[]
  // CoordinatorStore gets:
  /** the coordinator whose session, or one of whose former ids, is this one */
  coordinatorBy(session: string): StoredCoordinator | null
  /** the hosted entry whose session, or one of whose former ids, is this one */
  hostedBy(session: string): StoredHosted | null
  ```
  Load: a missing `pending` is `null`, a missing `former` `[]`; a `pending` that is neither `null` nor a UUID skips its attachment; `former` keeps its UUID entries, cut to `MAX_FORMER`. `renameSession(from, to)` also puts `from` first in the `former` of the coordinator and of the hosted entry it renames (without `to`, cut to `MAX_FORMER`).
- Part 1's hub builds every new attachment with `pending: null` and every new coordinator and hosted entry with `former: []`; `npm run typecheck` lists the places, in the hub and in part 1's tests.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mail-record.test.ts` (`OLD` and `PREV` new UUID constants):
```ts
it('an attach keeps was and replaces when they are session ids; other kinds drop them', () => {
  const a = { ...base, kind: 'attach', project: 'acme', was: OLD, replaces: PREV }
  expect(checkMailRecord(a)).toEqual(a)
  expect(checkMailRecord({ ...a, was: 'not-an-id' })).toBeNull()
  expect(checkMailRecord({ ...base, kind: 'task', project: 'acme', was: OLD })).toEqual({ ...base, kind: 'task', project: 'acme' })
})
```
`tests/unit/coordinator-store.test.ts`:
- `an attachment keeps its pending attach id; a file of part 1 without pending or former loads them as null and []` — write `coordinators.json` by hand with an attachment that has no `pending` and a coordinator and a hosted entry with no `former`; `store.coordinator(A)!.attachments[0].pending` is `null`, `.former` is `[]`, `store.hosted(S)!.former` is `[]`; an attachment `{ ...att, pending: 'x' }` is skipped.
- `renameSession keeps the old id first in former, at most 8` — `renameSession(A, A2)`: `coordinator(A2)!.former` is `[A]`; `renameSession(S, S2)`: `hosted(S2)!.former` is `[S]`; nine more renames of the coordinator leave `former` of length 8 with the newest old id first.
- `coordinatorBy and hostedBy find an entry by its id or a former one` — after the renames above, `coordinatorBy(A)!.session` is the current id and `hostedBy(S)!.session` is `S2`; an unknown id gives `null`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/mail-record.test.ts tests/unit/coordinator-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block, and add `pending: null` / `former: []` where `npm run typecheck` asks for them.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/mail-record.test.ts tests/unit/coordinator-store.test.ts tests/unit/coordinator-hub.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/shared/mail.ts src/main/mail/mail-record.ts src/main/coordinator/coordinator-store.ts src/main/coordinator/coordinator-hub.ts tests/unit/mail-record.test.ts tests/unit/coordinator-store.test.ts tests/unit/coordinator-hub.test.ts
git commit -m "feat: attach records can carry a session's former id, and the store keeps pending attaches and former ids"
```

---

### Task 3: A Claude tab's coordinator facts in the directory

**Files:**
- Modify: `src/shared/remote.ts` (`RemoteTab` :9-48)
- Modify: `src/main/sync/remote-wire.ts` (`parseRemoteTab` :174-226)
- Modify: `src/main/remote-host.ts` (`HostContext` :100-151, `remoteTabOf` :708-751)
- Modify: `src/main/coordinator/coordinator-hub.ts`
- Modify: `src/main/index.ts` (`hostCtx` :1522-1611; the coordinator publish of part 1 Task 11)
- Create: `tests/fixtures/coordinator-world.ts`
- Test: `tests/unit/sync-remote-wire.test.ts`, `tests/unit/remote-host.test.ts`, `tests/unit/coordinator-hub.test.ts`

**Interfaces:**
- Consumes: part 1 Task 3 (`TabWaitsState`, `oneLineText`), Task 4 (`TaskState`, `currentTask`, `nextTask`), Task 6 (the hub).
- Produces (`src/shared/remote.ts`):
  ```ts
  import type { TaskState } from './coordinator'
  /** the longest task title and coordinator name RemoteCoordFacts carries */
  export const COORD_FACT_TEXT_MAX = 200
  /** what a coordinator on another device reads of a Claude tab with a session */
  export interface RemoteCoordFacts {
    /** an open permission or question dialog, its line */
    prompt: { kind: 'permission' | 'question'; text: string | null; since: number } | null
    /** a usage limit stopped its turn; resetsAt null: not known */
    limit: { resetsAt: number | null; since: number } | null
    /** its task list while it keeps one; current: the title of its first current task, else its first left one */
    progress: { done: number; total: number; finished: boolean; current: string | null } | null
    /** the coordinator task it holds: the delivered or open one, else the oldest queued */
    task: { id: string; state: TaskState; since: number } | null
    /** the name of the coordinator it is attached to; null: none */
    attachedTo: string | null
    /** it is a coordinator on its device */
    coordinator: boolean
  }
  // RemoteTab gets:
  /** a Claude tab's coordinator facts; null without a session; an older device leaves it out */
  coord?: RemoteCoordFacts | null
  ```
- Produces (`remote-wire.ts`): `export function parseCoordFacts(v: unknown): RemoteCoordFacts | null` — every field present and of its shape: `prompt` null or `{ kind, text: null | 1–PROMPT_TEXT_MAX without \p{Cc}, since }`; `limit` null or `{ resetsAt: null | n, since }`; `progress` null or `{ done ≤ total, finished: boolean, current: null | 1–COORD_FACT_TEXT_MAX without \p{Cc} }`; `task` null or `{ id: UUID, state ∈ ['queued', 'delivered', 'open'], since }`; `attachedTo` null or 1–`COORD_FACT_TEXT_MAX` without `\p{Cc}`; `coordinator` boolean; every number a non-negative safe integer; anything else → `null`. `parseRemoteTab`: `coord: null` is kept as `null`; an object that `parseCoordFacts` accepts is kept; anything else, or none, leaves `coord` out.
- Produces (`remote-host.ts`): `HostContext.coordFacts?(tabId: string): RemoteCoordFacts | null`; `remoteTabOf` adds `coord: ctx.coordFacts(id)` to a Claude tab when `ctx.coordFacts` is given.
- Produces (`CoordinatorHub`):
  ```ts
  /** the facts of a Claude tab of this device for the coordinators of other devices; null when it has no session */
  facts(tabId: string): RemoteCoordFacts | null
  ```
  `prompt` and `limit` from `waits(tabId)`; `progress` from `progress(tabId)` with `current` through `oneLineText(title, COORD_FACT_TEXT_MAX)`; `task` from the session's hosted entry (`currentTask ?? nextTask`, `since: deliveredAt ?? queuedAt`); `attachedTo` its hosted coordinator's name; `coordinator: store.coordinator(session) !== null`.
- Produces (`tests/fixtures/coordinator-world.ts`): part 1's `NOW`, `ACME`, `BETA`, `S`, `TITLES`, `tab`, `world`, `fire`, `records` moved out of `tests/unit/coordinator-hub.test.ts` and exported, with `export type World = ReturnType<typeof world>` and
  ```ts
  export interface WorldOptions { problem?: string | null; self?: string | null; selfName?: string; tabs?: HubTab[] }
  ```
  `self` (default `null`) is the hub's `self()` and the `device` of this world's agents; `selfName` (default `'Desktop'`) its `selfName()` and their `deviceName`; `tabs` replaces the four default tabs. `world` also gets `agentsOf(): Agent[]` (what its `agents` dep returns). `coordinator-hub.test.ts` imports them back.
- `index.ts`: declare `let coordFactsOf: (tabId: string) => RemoteCoordFacts | null = () => null` before `hostCtx`, give `hostCtx` `coordFacts: (id) => coordFactsOf(id)`, and set `coordFactsOf = (id) => projectCoordinators.facts(id)` right after `projectCoordinators` is built (the directory can be read before the hub exists). The coordinator publish (part 1's `coordSoon` function) ends with `remote?.host.changed()`, so facts reach the other devices whenever a view, a wait or a task list changes.

- [ ] **Step 1: Write the failing tests**

`tests/unit/sync-remote-wire.test.ts` (`TASK_ID` a new UUID constant):
```ts
const FACTS: RemoteCoordFacts = {
  prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: 5 }, limit: { resetsAt: null, since: 6 },
  progress: { done: 3, total: 7, finished: false, current: 'Grouping crashes by call stack' },
  task: { id: TASK_ID, state: 'open', since: 7 }, attachedTo: 'coord · Studio', coordinator: false
}
it('a tab keeps its coordinator facts when they fit; null stays null; a tab of an older device has none', () => {
  expect(parseRemoteTab(tab({ coord: FACTS }))!.coord).toEqual(FACTS)
  expect(parseRemoteTab(tab({ coord: null }))!.coord).toBeNull()
  expect(parseRemoteTab(tab())).not.toHaveProperty('coord')
})
it('facts that do not fit are left out and the tab is kept', () => {
  for (const bad of [
    { ...FACTS, prompt: { ...FACTS.prompt!, text: 'x'.repeat(201) } }, { ...FACTS, task: { ...FACTS.task!, state: 'done' } },
    { ...FACTS, progress: { ...FACTS.progress!, done: 8 } }, { ...FACTS, attachedTo: 'a\nb' }, { ...FACTS, coordinator: 'no' }, 'facts'
  ]) expect(parseRemoteTab(tab({ coord: bad }))).not.toHaveProperty('coord')
})
```
`tests/unit/remote-host.test.ts`:
- `a Claude tab carries the facts coordFacts gives; a shell tab and a host without coordFacts carry none` — `f.ctx.coordFacts = (id) => (id === T1 ? FACTS : null)`: the entry of `T1` has `coord: FACTS`, the shell tab `T2` has no `coord` property; without `coordFacts` `T1` has none.

`tests/unit/coordinator-hub.test.ts` (`describe('facts for other devices')`):
```ts
it('facts give a tab\'s open dialog, its limit, its task list, the task it holds and its coordinator', () => {
  const w = world(); w.hub.make('tab-c', false); w.hub.attach('tab-c', 'a10000'); w.hub.message('tab-c', 'a10000', 'Fix the parser.')
  const [t] = records(w, 'task')
  w.waits['tab-1'] = { prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: NOW }, limit: { resetsAt: null, since: NOW } }
  w.progress['tab-1'] = { title: 'Triage', done: 3, total: 7, finished: false, tasks: [{ n: 3, title: 'Read the logs', state: 'done' }, { n: 4, title: 'Grouping crashes by call stack', state: 'current' }] }
  expect(w.hub.facts('tab-1')).toEqual({
    prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: NOW }, limit: { resetsAt: null, since: NOW },
    progress: { done: 3, total: 7, finished: false, current: 'Grouping crashes by call stack' },
    task: { id: t.id, state: 'queued', since: NOW }, attachedTo: 'coord · Desktop', coordinator: false
  })
  expect(w.hub.facts('tab-c')).toMatchObject({ coordinator: true, task: null, attachedTo: null })
  expect(w.hub.facts('no-such-tab')).toBeNull()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/sync-remote-wire.test.ts tests/unit/remote-host.test.ts tests/unit/coordinator-hub.test.ts`
Expected: FAIL (`coord` is dropped; `facts` is not a function).

- [ ] **Step 3: Implement** the Interfaces block; move the world first and check part 1's hub tests still pass before adding `facts`.

- [ ] **Step 4: Run the tests**

Run: the command of Step 2, then `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/shared/remote.ts src/main/sync/remote-wire.ts src/main/remote-host.ts src/main/coordinator/coordinator-hub.ts src/main/index.ts tests/fixtures/coordinator-world.ts tests/unit/sync-remote-wire.test.ts tests/unit/remote-host.test.ts tests/unit/coordinator-hub.test.ts
git commit -m "feat: a Claude tab's directory entry carries what a coordinator on another device needs of it"
```

---

### Task 4: The remote `open-tab` call takes a folder, an email and a title

**Files:**
- Modify: `src/main/sync/remote-shapes.ts` (`CallArgs` :108, `CallReplies` :153, `CALL_REPLIES` :473, `openTabArgs` :664-672)
- Modify: `src/main/remote-host.ts` (`HostContext.openTab` :131-132, `hostHandlers['open-tab']` :210-218)
- Create: `src/main/coordinator/remote-start.ts`
- Modify: `src/main/index.ts` (`hostCtx.openTab` :1588; `IPC.remoteOpenTab` :3042-3052)
- Modify: `tests/fixtures/host-context.ts` (:121, :352-355)
- Test: `tests/unit/sync-remote-shapes.test.ts`, `tests/unit/remote-host.test.ts:239-243, 263-267`, `tests/unit/remote-start.test.ts` (create)

**Interfaces:**
- Produces (`remote-shapes.ts`):
  ```ts
  CallArgs['open-tab']: { kind: TabKind; profile: string | null; account: string | null; resume: string | null; cwd: string | null; email: string | null; title: string | null }
  /** cwd: the folder it opened in; accountName: the account it runs on (MAIN_ACCOUNT for the main one); defaulted: the folder asked for could not be used, and the default folder was. An older device answers the id only */
  CallReplies['open-tab']: { id: string; cwd?: string; accountName?: string; defaulted?: boolean }
  ```
  `openTabArgs`: `cwd`, `email`, `title` absent or `null` → `null`; `cwd` 1–`MAX_PATH_TEXT` without NUL; `email` 3–320 characters containing `@`, without `\p{Cc}`; `title` 1–`COORD_NAME_MAX` without `\p{Cc}`; a present one that fails → the arguments are `null`. The reply's check (`openTabReplyOf`): `id` a UUID or the reply is `null`; `cwd` (1–`MAX_PATH_TEXT`, no NUL), `accountName` (1–`MAX_ACCOUNT_NAME`, no NUL), `defaulted` (boolean) each kept when it fits and left out when it does not.
- Produces (`remote-host.ts`):
  ```ts
  /** a tab a member asks this device to open, its folder checked here */
  export interface HostOpenTab { kind: TabKind; profile: string | null; account: string | null; resume: string | null; cwd: string; title: string | null }
  // HostContext: openTab(req: HostOpenTab): TabInfo | null   (was CallArgs['open-tab'])
  // HostContext gets:
  defaultFolder(): string
  isDirectory(path: string): Promise<boolean>
  /** the account a tab opens on for a coordinator with this email: see accountForEmail */
  accountByEmail(email: string): string | null
  ```
  The `open-tab` handler (now async): `cwd` = `req.cwd` when it is `isAbsolute` here and `await ctx.isDirectory(req.cwd)`, else `ctx.defaultFolder()`; `defaulted = req.cwd !== null && cwd !== req.cwd`; account = `req.email !== null ? ctx.accountByEmail(req.email) : req.account`; `ctx.openTab({ kind, profile, account, resume, cwd, title })`; `null` → `CallError(REMOTE_COPY.openTabFailed)` as today; the reply `{ id, cwd: tab.cwd, accountName: tab.account === null ? MAIN_ACCOUNT : ctx.accounts.nameOf(tab.account) ?? MAIN_ACCOUNT, defaulted }`.
- Produces (`src/main/coordinator/remote-start.ts`):
  ```ts
  /** the account a tab opened for a coordinator runs on: Main account (null) when its email is this one, else the first readable extra account with it, else Main account; emails compared trimmed and without case */
  export function accountForEmail(email: string, view: { main: { email: string | null }; accounts: { id: string; email: string | null; readable: boolean }[] }): string | null
  ```
- `index.ts`: `hostCtx.openTab: (r) => openTab({ kind: r.kind, cwd: r.cwd, profile: r.profile, account: r.account, resumeSessionId: r.resume, title: r.title }, false)`, `defaultFolder`, `isDirectory: isDirAsync`, `accountByEmail: (e) => accountForEmail(e, accountsView())`; the window's `IPC.remoteOpenTab` passes `cwd: null, email: null, title: null`.
- `tests/fixtures/host-context.ts`: `opened: HostOpenTab[]`; new fields `dirs: Set<string>` (default `new Set(['/work/acme'])`), `defaultFolder: string` (default `'/home/demo'`), `byEmail: Record<string, string>` (default `{}`) behind `defaultFolder`, `isDirectory` (async), `accountByEmail` (`h.byEmail[e] ?? null`); `openTab` returns `tabInfo(T3, { kind: req.kind, profile: req.profile ?? 'Bash', cwd: req.cwd, folder: req.cwd, account: req.account })`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/sync-remote-shapes.test.ts`:
```ts
it('open-tab takes a folder, an email and a title, each optional', () => {
  const base = { kind: 'claude', profile: null, account: null, resume: null }
  expect(CALL_ARGS['open-tab'](base)).toEqual({ ...base, cwd: null, email: null, title: null })
  const full = { ...base, cwd: '/home/sam/acme', email: 'sam@example.com', title: 'Release notes' }
  expect(CALL_ARGS['open-tab'](full)).toEqual(full)
  for (const bad of [{ cwd: 'a\u0000b' }, { email: 'sam' }, { title: 'x'.repeat(101) }, { title: 'a\nb' }]) expect(CALL_ARGS['open-tab']({ ...full, ...bad })).toBeNull()
})
it('the open-tab reply keeps its folder, its account and defaulted, and leaves out a field that does not fit', () => {
  expect(CALL_REPLIES['open-tab']({ id: T, cwd: '/home/sam', accountName: 'Main account', defaulted: true })).toEqual({ id: T, cwd: '/home/sam', accountName: 'Main account', defaulted: true })
  expect(CALL_REPLIES['open-tab']({ id: T })).toEqual({ id: T })
  expect(CALL_REPLIES['open-tab']({ id: T, cwd: 5, defaulted: 'yes' })).toEqual({ id: T })
  expect(CALL_REPLIES['open-tab']({ id: 'x' })).toBeNull()
})
```
`tests/unit/remote-host.test.ts` (the two existing open-tab tests become the first and last below):
```ts
it('open-tab with no folder opens in the default folder without bringing the tab to the front, and answers its id, folder and account', async () => {
  const f = fakeHost()
  expect(await run(f, 'open-tab', { kind: 'shell', profile: 'Bash', account: null, resume: null })).toEqual({ id: T3, cwd: '/home/demo', accountName: 'Main account', defaulted: false })
  expect(f.opened).toEqual([{ kind: 'shell', profile: 'Bash', account: null, resume: null, cwd: '/home/demo', title: null }])
})
it('open-tab opens in the folder asked for when it is a directory here, with its title', async () => {
  const f = fakeHost()
  expect(await run(f, 'open-tab', { kind: 'claude', profile: null, account: null, resume: null, cwd: '/work/acme', email: null, title: 'Release notes' }))
    .toEqual({ id: T3, cwd: '/work/acme', accountName: 'Main account', defaulted: false })
  expect(f.opened[0]).toMatchObject({ cwd: '/work/acme', title: 'Release notes' })
})
it('a folder that is no directory here, or not absolute here, opens in the default folder and says so', async () => {
  const f = fakeHost()
  for (const cwd of ['/no/such/folder', 'relative/acme']) expect(await run(f, 'open-tab', { kind: 'claude', profile: null, account: null, resume: null, cwd, email: null, title: null })).toMatchObject({ cwd: '/home/demo', defaulted: true })
})
it('an email opens the tab on the account accountByEmail picks, and the answer names it', async () => {
  const f = fakeHost(); f.byEmail = { 'sam@example.com': ACC_WORK }
  expect(await run(f, 'open-tab', { kind: 'claude', profile: null, account: null, resume: null, cwd: null, email: 'sam@example.com', title: null })).toMatchObject({ accountName: 'Work' })
  expect(f.opened[0]).toMatchObject({ account: ACC_WORK })
})
it('an open-tab that fails is refused with the window\'s sentence', ...)   // unchanged but for the arguments
```
`tests/unit/remote-start.test.ts`:
```ts
it('accountForEmail picks Main account for its own email, else a readable extra account with it, else Main account', () => {
  const view = { main: { email: 'Sam@Example.com' }, accounts: [{ id: 'locked', email: 'kim@example.com', readable: false }, { id: 'work', email: 'kim@example.com', readable: true }, { id: 'token', email: null, readable: true }] }
  expect(accountForEmail(' sam@example.com ', view)).toBeNull()
  expect(accountForEmail('KIM@example.com', view)).toBe('work')
  expect(accountForEmail('lee@example.com', view)).toBeNull()
  expect(accountForEmail('kim@example.com', { ...view, main: { email: null } })).toBe('work')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/sync-remote-shapes.test.ts tests/unit/remote-host.test.ts tests/unit/remote-start.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces block; every builder of `CallArgs['open-tab']` passes the three new fields (`npm run typecheck` lists them).

- [ ] **Step 4: Run the tests**

Run: the command of Step 2, then `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/sync/remote-shapes.ts src/main/remote-host.ts src/main/coordinator/remote-start.ts src/main/index.ts tests/fixtures/host-context.ts tests/unit/sync-remote-shapes.test.ts tests/unit/remote-host.test.ts tests/unit/remote-start.test.ts
git commit -m "feat: a tab opened from another device can name its folder, its title and its account's email"
```

---

### Task 5: Rows of other devices' sessions

**Files:**
- Modify: `src/main/coordinator/coordinator-hub.ts` (deps, `view`, `marks`, `read`)
- Modify: `src/main/coordinator/session-state.ts` (`rowState`), `src/main/coordinator/session-text.ts` (`listText`)
- Modify: `src/shared/coordinator.ts` (the doc of `CoordSessionRow.key`)
- Modify: `src/main/index.ts` (the hub's deps; `viewerEvents` :1419-1489; `mailSync`'s `onPeers` :2215-2219)
- Modify: `tests/fixtures/coordinator-world.ts`, `tests/e2e/coordinator-helpers.ts`
- Create: `tests/unit/coordinator-devices.test.ts`, `tests/e2e/coordinator-devices.spec.ts`
- Test: also `tests/unit/coordinator-rows.test.ts`, `tests/unit/coordinator-text.test.ts`

**Interfaces:**
- Consumes: Task 1 (`MailSync.knowsCoordinator`), Task 2 (`pending`), Task 3 (`RemoteCoordFacts`, `facts`, the fixture).
- Produces (`coordinator-hub.ts`):
  ```ts
  /** a paired device as the coordinator needs it */
  export interface HubPeer {
    id: string
    name: string
    online: boolean   // linked now
    listed: boolean   // its tab list has come on the current link
    coord: boolean    // its hello says it knows coordinator records
    mail: boolean     // it takes agent mail and its mail watcher wakes a session
  }
  /** a tab of a paired device, as this window knows it (an offline device's last list included) */
  export interface HubRemoteTab {
    device: string; tabId: string; claude: boolean
    session: string | null; name: string | null   // name: its agent name, as list_agents shows it; null without a session
    folder: string; branch: string | null; project: string | null   // project: its place's project name
    working: boolean; exited: boolean
    coord: RemoteCoordFacts | null
  }
  // CoordinatorHubDeps gets:
  peers(): HubPeer[]
  remoteTabs(): HubRemoteTab[]
  // CoordinatorHub gets:
  /** the paired devices or their tabs changed */
  remoteChanged(): void
  ```
- `rowState` line rule 1 becomes: `starting` → `Starting…`; `attaching` → `Attaching…`; `offline` → `Offline` (the group stays what the facts give).
- `view()` adds, for each attachment with a `device` (part 1 rows keep theirs): key `` `${device}:${session}` ``; `rt` = the remote tab of that device with that session; `peer` = the peer of that device; `marker`: `pending !== null` → `'attaching'`, else `peer?.online !== true` → `'offline'`, else `null`; `tabId: rt?.tabId ?? null`; `deviceName: peer?.name ?? 'another device'`; `name: rt?.name ?? <stored name>`; `folder`, `branch` from `rt` (else `null`); facts: `closed` = the peer is online and listed and no `rt`; `exited`, `working` from `rt`; `prompt`, `limit` from `rt.coord`; `progress` from `rt.coord.progress` as a `PlanStatus` (`{ title: '', done, total, finished, tasks: current ? [{ n: done + 1, title: current, state: 'current' }] : [] }`); `task` = `rt.coord.task` else the oldest `task` record from the coordinator to that device and session that is not delivered and has no `report` with its id as `replyTo` (`{ id, state: 'queued', since: sentAt }`); `resolved`, `failed`, `lastReport` from the attachment.
- `notAttached` adds each remote tab with `claude`, a `session`, not `exited`, whose peer is online, whose `project` equals the coordinator's project name (trimmed, without case), whose `coord?.coordinator` is not true, and which is no attachment of this coordinator: key `` `${device}:${session}` ``, `device`, `deviceName: peer.name`, `name`, `folder`, `branch`, `rowState` of its facts (`task: null`, `marker: null`), `attachedTo: rt.coord?.attachedTo ?? <the name of a coordinator of this device it is attached to> ?? null`.
- `marks()` adds, for each attachment with a `device`, `pending === null` and a known `rt`: `marks[rt.tabId] = { role: 'attached', project: <coordinator's project name>, coordinator: <coordinator's name>, coordinatorTabId: <coordinator's tab> }`.
- `read` takes a row of another device's prompt from `rt.coord.prompt`, and its task list as `null`.
- `remoteChanged()` calls `d.changed()` (Task 8 adds pending starts).
- `listText` notes: when an attached row has `marker === 'offline'`, `- A session marked Offline is on a device that is not connected: a task given to it goes out when the device connects; detach_session works meanwhile.`; when one has `'attaching'`, `- A session marked Attaching… waits for its device to confirm it; it takes tasks once it does.`
- `CoordSessionRow.key` doc: `'local:<session>'; '<device>:<session>' for a session of another device; 'start:<tabId>' while Starting…`.
- `index.ts`:
  - `peers: () => (group?.view().devices ?? []).map((d) => ({ id: d.id, name: d.name, online: remote?.viewer.online(d.id) ?? false, listed: remote?.viewer.listedOf(d.id) ?? false, coord: mailSync.knowsCoordinator(d.id), mail: mailSync.acceptOf(d.id)?.on === true && mailSync.acceptOf(d.id)?.wakes === true }))`.
  - `remoteTabs`: for each `remote.viewer.devices()` and each of its `tabsOf` (none without `remote`): the fields above from the `RemoteTab` (`claude: kind === 'claude'`, `session: claudeSessionId`, `branch: place?.branch ?? null`, `project: place?.project.name ?? null`, `coord: coord ?? null`); `name` through `nameAgents` over that device's Claude tabs that are not exited and have a session, in list order — as `agentsNow` names them.
  - `viewerEvents.opened`, `updated`, `closed`, `devices` and `mailSync`'s `onPeers` also call `projectCoordinators.remoteChanged()`.
- `tests/fixtures/coordinator-world.ts` gets, for this task and the next ones:
  ```ts
  export const DEV_C = 'c1000000-0000-4000-8000-0000000000c1'   // Studio
  export const DEV_S = '5a000000-0000-4000-8000-0000000000a1'   // Laptop
  export const ACME_L = { key: '/home/sam/acme', name: 'acme' }
  export const L = { one: 'e1000000-0000-4000-8000-000000000011', two: 'e2000000-0000-4000-8000-000000000012', lead: 'e3000000-0000-4000-8000-000000000013', fresh: 'e4000000-0000-4000-8000-000000000014' }
  export const NEW = { coord: 'f1000000-0000-4000-8000-000000000021', one: 'f2000000-0000-4000-8000-000000000022' }
  export const NO_FACTS: RemoteCoordFacts = { prompt: null, limit: null, progress: null, task: null, attachedTo: null, coordinator: false }
  export const peerOf = (id: string, name: string, over: Partial<HubPeer> = {}): HubPeer => ({ id, name, online: true, listed: true, coord: true, mail: true, ...over })
  export const remoteTab = (over: Partial<HubRemoteTab> = {}): HubRemoteTab =>
    ({ device: DEV_S, tabId: 'tab-l1', claude: true, session: L.one, name: 'parser · Laptop', folder: '/home/sam/acme', branch: 'main', project: 'acme', working: false, exited: false, coord: NO_FACTS, ...over })
  /** an attachment of Laptop's parser to the coordinator S.coord, written straight into the store */
  export function attachDirect(w: World, pending: string | null = null): void
  /** a world's tabs as the other device lists them, with their agent names and their facts */
  export function listedTabs(w: World, device: string): HubRemoteTab[]
  /** Studio (c, part 1's four tabs) and Laptop (s: tab-l1 parser, tab-l2 docs, tab-lc lead, in ACME_L, folder /home/sam/acme), linked:
   *  c.peers = [peerOf(DEV_S, 'Laptop')], s.peers = [peerOf(DEV_C, 'Studio')], and each one's remoteTabs the other's listedTabs */
  export function deviceWorlds(): { c: World; s: World }
  /** what MailSync and the tab lists carry between the two: the shareable records each way, three rounds (an answer goes back), then each side's tabs listed to the other, and remoteChanged on both */
  export function sync(c: World, s: World): void
  ```
  `world()` gets `peers: HubPeer[]` and `remoteTabs: HubRemoteTab[]` (both `[]`) behind the new deps; `TITLES` gets `'tab-l1': 'parser', 'tab-l2': 'docs', 'tab-lc': 'lead'`. `sync` merges with `s.mail.merge(c.mail.all().filter(isShareable), { link: 'c' })` and back. Names: on Studio `coord · Studio` [`c00000`], `parser · Studio` [`a10000`]; on Laptop `parser · Laptop` [`e10000`], `docs · Laptop` [`e20000`], `lead · Laptop` [`e30000`].
- `tests/e2e/coordinator-helpers.ts` gets:
  ```ts
  /** a git repository with one commit whose own folder is named `name` (its project's name), in a new temp folder */
  export function repoNamed(name: string): string
  /** Studio and Laptop paired, the stand-in Claude Code 2.1.400 and its mail watcher on both; on each a Claude tab with a session in a repository named acme.
   *  Studio's is made the coordinator, and returns once its view lists Laptop's session as not attached. */
  export async function coordDevices(o: { b?: AppOptions } = {}): Promise<{ a: Device; b: Device; coordTab: string; coordSid: string; sessionTab: string; sessionSid: string; repoA: string; repoB: string }>
  export const coordViewOf = (d: Device, tabId: string): Promise<CoordinatorView | null>   // window.ct.coordView
  export const marksOf = (d: Device): Promise<CoordMarks>                                   // window.ct.coordMarks
  ```
  `coordDevices` uses `pairedApps({ a: { settings: VERSION_SETTINGS }, b: { settings: VERSION_SETTINGS, ...o.b } })`, opens each tab with `window.ct.openTab({ kind: 'claude', cwd })`, reports a session with `startSession` (a `randomUUID()`), waits for `hasMailWatcher` on both data folders, then `makeCoordinator(a.page, coordTab)` and `expect.poll(…, SLOW)` on the view's `notAttached`. The tab names are then `acme · Studio` and `acme · Laptop`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/coordinator-rows.test.ts`:
```ts
it('Attaching… and Offline are their own lines; the group stays what the facts give', () => {
  expect(rowState({ ...idle, marker: 'attaching' }, clock)).toEqual({ group: 'idle', why: null, line: 'Attaching…', progress: null })
  expect(rowState({ ...idle, marker: 'offline', working: true }, clock)).toMatchObject({ group: 'working', line: 'Offline' })
  expect(rowState({ ...idle, marker: 'offline', prompt: { kind: 'question', text: null, since: 0 } }, clock)).toMatchObject({ group: 'waiting', why: 'prompt', line: 'Offline' })
})
```
`tests/unit/coordinator-text.test.ts`: `listText notes an Offline row and an Attaching… row` — a view with one attached row of each marker: the text contains both note lines above, exactly.

`tests/unit/coordinator-devices.test.ts`, `describe('rows of other devices')`, each from `const c = world({ self: DEV_C, selfName: 'Studio' }); c.peers = [peerOf(DEV_S, 'Laptop')]; c.hub.make('tab-c', false)`:
```ts
it('Not attached lists the project\'s sessions of an online paired device, by project name without case, with the device', () => {
  c.remoteTabs = [remoteTab({ project: 'ACME' }), remoteTab({ tabId: 'tab-l2', session: L.two, name: 'docs · Laptop', project: 'beta' })]
  const v = c.hub.view('tab-c')!
  expect(v.notAttached).toContainEqual(expect.objectContaining({ key: `${DEV_S}:${L.one}`, tabId: 'tab-l1', device: DEV_S, deviceName: 'Laptop', session: L.one, ref: 'e10000', name: 'parser · Laptop', folder: '/home/sam/acme', branch: 'main', group: 'idle', line: 'Idle', marker: null, attachedTo: null }))
  expect(v.notAttached.map((r) => r.key)).not.toContain(`${DEV_S}:${L.two}`)
})
it('Not attached leaves out an offline device\'s session, an exited one, a coordinator and a tab without a session', ...)
// c.peers = [peerOf(DEV_S, 'Laptop', { online: false })] → none; then online with remoteTab({ exited: true }), remoteTab({ coord: { ...NO_FACTS, coordinator: true } }), remoteTab({ session: null, name: null }) → none
it('a remote session attached to a coordinator elsewhere names it', ...)        // coord: { ...NO_FACTS, attachedTo: 'lead · Laptop' } → row.attachedTo 'lead · Laptop'
it('an attached remote row takes its task list, task and prompt from the tab\'s facts', () => {
  attachDirect(c)
  c.remoteTabs = [remoteTab({ working: true, coord: { ...NO_FACTS, progress: { done: 3, total: 7, finished: false, current: 'Grouping crashes by call stack' }, task: { id: TASK, state: 'open', since: NOW } } })]
  expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ key: `${DEV_S}:${L.one}`, device: DEV_S, deviceName: 'Laptop', tabId: 'tab-l1', marker: null, group: 'working', line: '3/7 · Grouping crashes by call stack', progress: { done: 3, total: 7 }, task: { id: TASK, state: 'open', since: NOW } })
  c.remoteTabs = [remoteTab({ coord: { ...NO_FACTS, prompt: { kind: 'permission', text: 'Allow Bash: npm test', since: NOW } } })]
  expect(c.hub.view('tab-c')!).toMatchObject({ sessions: [expect.objectContaining({ group: 'waiting', why: 'prompt', line: 'Allow Bash: npm test' })], waiting: 1 })
  expect(c.hub.read('tab-c', 'e10000')).toMatchObject({ ok: true, info: expect.stringContaining('Waiting for the user: Allow Bash: npm test.') })
})
it('a remote attachment not confirmed is Attaching…, one on an offline device Offline, and one its listed device no longer has Tab closed', ...)
// attachDirect(c, ATTACH_ID) → marker 'attaching', line 'Attaching…'; attachDirect(c) with peer online: false → 'offline', 'Offline'; online, listed, c.remoteTabs = [] → line 'Tab closed'
it('a task written to a remote session is queued in its row until its device lists it', ...)
// attachDirect(c); c.remoteTabs = [remoteTab()]; c.mail.add(checkMailRecord({ v: 1, id: TASK, from: { device: DEV_C, session: S.coord, name: 'coord · Studio' }, to: { device: DEV_S, session: L.one, name: 'parser · Laptop' }, replyTo: null, text: 'Fix the parser.', sentAt: NOW, delivered: false, read: false, kind: 'task', project: 'acme' })!)
// → row.task { id: TASK, state: 'queued', since: NOW }, line 'Task waiting until the session is idle'
it('a confirmed remote attachment marks the other device\'s tab in this window; a pending one does not', () => {
  attachDirect(c); c.remoteTabs = [remoteTab()]
  expect(c.hub.marks()['tab-l1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId: 'tab-c' })
  attachDirect(c, ATTACH_ID)                                     // writes the coordinator's attachments again, now pending
  expect(c.hub.marks()['tab-l1']).toBeUndefined()
})
```
(`TASK` and `ATTACH_ID` are new UUID constants of the file.)

`tests/e2e/coordinator-devices.spec.ts` (`test.afterEach(closePaired)`, each test `test.setTimeout(180_000)`):
```ts
test('Studio\'s coordinator lists Laptop\'s session of the project as not attached, with Laptop as its device', async () => {
  const { a, coordTab, sessionTab, sessionSid } = await coordDevices()
  expect((await coordViewOf(a, coordTab))!.notAttached).toContainEqual(expect.objectContaining({ tabId: sessionTab, device: expect.any(String), deviceName: 'Laptop', name: 'acme · Laptop', ref: refOf(sessionSid) }))
  const list = await coord(a.pipeName, coordTab, { op: 'list' })
  expect(list.info).toContain('Not attached (this project):')
  expect(list.info).toContain(`- acme · Laptop [${refOf(sessionSid)}] · Idle`)
})
test('Laptop\'s task list and a pending permission show in Studio\'s row of the session', async () => {
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  const row = async () => (await coordViewOf(a, coordTab))!.notAttached.find((r) => r.tabId === sessionTab)
  expect(await sendPipeMessage(b.pipeName, { v: 1, type: 'task_list', tabId: sessionTab, list: { title: 'Triage', tasks: [{ title: 'Read the logs', status: 'completed' }, { title: 'Group the crashes', status: 'in_progress' }, { title: 'Write the report', status: 'pending' }] } })).toMatchObject({ ok: true })
  await expect.poll(row, SLOW).toMatchObject({ line: '1/3 · Group the crashes', progress: { done: 1, total: 3 } })
  await sendPipeMessage(b.pipeName, { v: 1, type: 'attention', tabId: sessionTab, sessionId: sessionSid, reason: 'permission', prompt: 'Allow Bash: npm test' })
  await expect.poll(row, SLOW).toMatchObject({ group: 'waiting', why: 'prompt', line: 'Allow Bash: npm test' })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/coordinator-rows.test.ts tests/unit/coordinator-text.test.ts tests/unit/coordinator-devices.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator-devices.spec.ts`
Expected: FAIL (no line for the markers; no remote rows).

- [ ] **Step 3: Implement** the Interfaces block.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm test && npm run build && node scripts/e2e.mjs coordinator-devices.spec.ts coordinator.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/coordinator-hub.ts src/main/coordinator/session-state.ts src/main/coordinator/session-text.ts src/shared/coordinator.ts src/main/index.ts tests/fixtures/coordinator-world.ts tests/e2e/coordinator-helpers.ts tests/unit/coordinator-devices.test.ts tests/unit/coordinator-rows.test.ts tests/unit/coordinator-text.test.ts tests/e2e/coordinator-devices.spec.ts
git commit -m "feat: a coordinator's rows show sessions of paired devices, their facts and their device"
```

---

### Task 6: Attach, detach, leave and tasks across devices

**Files:**
- Modify: `src/main/coordinator/coordinator-hub.ts` (`HUB_TEXT`, `attach`, `attachTab`, `detach`, `message`, `accepts`, `tool`, `make`, the mail listener)
- Modify: `src/mcp/coordinator-tools.ts` (the attach wait; the `attach_session` description)
- Modify: `src/main/index.ts` (the `coordAttach` guard; `IPC.coordLeave`), `src/shared/ipc.ts`, `src/preload/index.ts`
- Modify: the renderer call of part 2's header Detach (Step 3)
- Test: `tests/unit/coordinator-devices.test.ts`, `tests/unit/coordinator-hub.test.ts` (part 1's remote refusal case), `tests/unit/coordinator-tools.test.ts`, `tests/e2e/coordinator-devices.spec.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5; part 1 Tasks 6, 7, 11.
- Produces:
  ```ts
  // coordinator-hub.ts
  export const REMOTE_ATTACH_WAIT_MS = 8000
  // CoordinatorHub gets:
  /** the tab's session leaves its coordinator, on this device or another */
  leave(tabId: string): CoordResult
  // HUB_TEXT loses remote; gets (exact):
  deviceOffline: (device: string) => `${device} is not connected; its sessions can be attached or started while it is.`,
  oldDevice: (device: string) => `${device} runs a ClaudeTerm that does not know coordinators; update ClaudeTerm there to coordinate its sessions.`,
  noMail: (device: string) => `${device} does not take agent messages now, which coordinating its sessions needs: they are turned off there, or its Claude Code is older than ${MAIL_MIN_CLAUDE}.`,
  attaching: (name: string, ref: string, device: string) => `Attaching ${name} [${ref}]: ${device} has not confirmed it yet, and list_sessions shows it as Attaching… until it does. It is not told and goes on as it is.`,
  notConfirmed: (name: string) => `${name} is not attached yet: its device has not confirmed it.`,
  queuedOffline: (name: string, ref: string, device: string) => `Task given to ${name} [${ref}]. ${device} is not connected: the task goes out when it connects and reaches the session when it is idle; its report comes to you by itself.`,
  detachedPending: (name: string) => `${name} was detached before its device confirmed it.`,
  closedThere: (name: string) => `${name} is no longer open on its device.`,
  problemThere: (device: string, problem: string) => `${device} cannot take coordinated sessions now: ${problem}`,
  noProjectGiven: 'The attach request named no project.',
  notAttached: 'This tab is not attached to a coordinator.'
  // coordinator-tools.ts
  /** how long attach_session waits for its answer: a session on a paired device is attached once that device confirms */
  export const COORD_ATTACH_TIMEOUT_MS = 15_000
  // ipc.ts: IPC.coordLeave = 'coord:leave'; CtApi gets coordLeave(tabId: string): Promise<CoordResult>
  ```
- **The coordinator's side.** `attach(tabId, target)`: after part 1's coordinator and problem checks, `target` resolves (`resolveAgent(target, candidates, [])`) among this device's agents and the remote tabs of online peers that have a session and are not exited (as agents: `device`, `deviceName: peer.name`, `name: rt.name`, `wakes: true`). A local target goes as in part 1. A remote one is refused, in this order: a coordinator on its device (`rt.coord?.coordinator`) → `isCoordinator(name)`; `!peer.coord` → `oldDevice(peer.name)`; `!peer.mail` → `noMail(peer.name)`; an attachment of this coordinator → pending: `{ ok: true, info: attaching(…) }` (nothing written), confirmed: `{ ok: true, info: alreadyAttached(name) }`; attached to another coordinator of this device → `elsewhere(name, <its project>, <its name>)`. Then: the attachment `{ device, session, name, attachedAt: now, resolved: false, failed: false, lastReport: null, pending: <record id> }` and an `attach` record from the coordinator's address to `{ device, session, name }` with `project`, text `attachText(project)`, `delivered: false, read: false` → `{ ok: true, info: attaching(name, ref, peer.name) }`. `attachTab(tabId, sessionTabId)` with the id of a remote tab does the same for its device and session; a peer that is offline → `deviceOffline(peer.name)`.
- `tool(tabId, { op: 'attach' })`: for a remote target that is now pending it answers when the attachment is confirmed (`attached(name, ref)`), refused (`{ ok: false, error: <the refusal's text> }`) or detached (`{ ok: false, error: detachedPending(name) }`), or after `REMOTE_ATTACH_WAIT_MS` (a `later` timer) with the `attaching` answer. `attach` and `attachTab` (the window's) answer at once.
- The mail listener, for records to this device:
  - an `attach` that becomes `delivered` and is the `pending` of an attachment → `pending: null`; the waiting answer gets `attached(name, ref)`; `changed()`.
  - a `detach` not delivered from another device to a coordinator here (`coordinatorBy(to.session)`): when its `replyTo` is the `pending` of that coordinator's attachment of `from` (device, session) → the attachment goes, the waiting answer gets `{ ok: false, error: r.text }`; otherwise that attachment, if any, goes (the session left). Either way the record is marked `delivered` and `read`; `changed()`.
- **The session's side.** An `attach` with neither `was` nor `replaces`, not `delivered` and not `read`, from another device to a session of this device: `name` = the session's agent name here, else `r.to.name`. Refused, in this order: no `project` → `noProjectGiven`; `problem()` → `problemThere(selfName(), problem)`; no open Claude tab runs the session → `closedThere(name)`; the session is a coordinator here → `isCoordinator(name)`; `hostedBy(session)` names another coordinator (`norm(device)` or session differ from `r.from`) → `elsewhere(name, hosted.project, hosted.coordinator.name)`. A refusal writes a `detach` from `address(null, session)` to `r.from` with `replyTo: r.id`, the reason as text, `delivered: false, read: false`, and marks the attach `read`. Else: unless hosted by `r.from` already, `putHosted({ session, coordinator: r.from, project: r.project, tasks: [], former: [] })`; the attach is marked `delivered` and `read`; `changed()`.
  - A `detach` not delivered from another device to a session hosted here (`hostedBy(to.session)`) whose hosted coordinator is `r.from` → the hosted entry goes (its tasks dropped, no report). Marked `delivered` and `read` in any case; `changed()`.
- `detach` of a remote row: the attachment goes; a pending one's waiting answer gets `detachedPending(name)`; a `detach` record from the coordinator to `{ device, session, name }`, `delivered: false, read: false` → `detached(name, row.task !== null)`. `stop` and `tabClosed` detach remote rows the same way (part 1 detaches every row as `detach` does).
- `leave(tabId)`: the tab's session is hosted (`hostedBy`), else `{ ok: false, error: notAttached }`. A coordinator of this device → part 1's `detach` of it from that coordinator's side; another device's → the hosted entry goes and a `detach` from `address(null, session)` to `hosted.coordinator`, `delivered: false, read: false`. Both answer `{ ok: true, info: detachText(hosted.project) }`. Part 1's `make`, for a tab attached elsewhere, detaches it through `leave`.
- `message` to a remote row: `marker === 'attaching'` → `notConfirmed(name)`; `MAX_TASKS_PER_SESSION` task records from the coordinator to that device and session (sent since its `attachedAt`) without a report replying to them → `tooMany(name)`; then the `task` record to `{ device, session, name }` as part 1 writes it → online: `queued(name, ref)`; offline: `queuedOffline(name, ref, deviceName)`.
- `accepts`: a `report` is taken only when its `to` session is a coordinator here and its `from` (`norm(from.device)`, session) is an attachment of it (a stopped one only into a running turn, as in part 1). The listener marks a `report` not delivered and not read, to a session of this device, that fails this rule `delivered` and `read`: it wakes nobody.
- `coordinator-tools.ts`: `attach_session` waits `COORD_ATTACH_TIMEOUT_MS` for the pipe; its description becomes `Coordinator only: attach a running Claude session, by a ref or a name from list_sessions or list_agents; a session on a paired device is attached once that device confirms. Attaching sends the session nothing and does not interrupt it; give it work with message_session. A session attached to another coordinator is refused.`
- `index.ts`: `IPC.coordLeave` → `projectCoordinators.leave(tabId)` after `isLocalClaudeTab(tabId)`, else `{ ok: false, error: 'Invalid request' }`; the `coordAttach` guard takes as `sessionTabId` a local Claude tab or `isId(id) && remote?.viewer.tab(id)?.kind === 'claude'`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/coordinator-hub.test.ts`: in part 1's `attach refuses …` test, the case of another device's session (`w.remote.push(…)`, `HUB_TEXT.remote`) is removed; its cases are below.

`tests/unit/coordinator-devices.test.ts`, `describe('attach, detach and tasks across devices')`, each from `const { c, s } = deviceWorlds(); c.hub.make('tab-c', false)`; `att = () => records(c, 'attach')[0]`:
```ts
it('attaching a Laptop session writes an attach record and waits: Attaching… until Laptop confirms; then both mark it', () => {
  expect(c.hub.attach('tab-c', 'parser · Laptop')).toEqual({ ok: true, info: HUB_TEXT.attaching('parser · Laptop', 'e10000', 'Laptop') })
  expect(att()).toMatchObject({ from: { device: DEV_C, session: S.coord }, to: { device: DEV_S, session: L.one }, project: 'acme', delivered: false })
  expect(c.hub.view('tab-c')!.sessions[0]).toMatchObject({ marker: 'attaching', line: 'Attaching…' })
  sync(c, s)
  expect(s.store.hosted(L.one)).toMatchObject({ coordinator: { device: DEV_C, session: S.coord, name: 'coord · Studio' }, project: 'acme', tasks: [] })
  expect(c.store.coordinator(S.coord)!.attachments[0].pending).toBeNull()
  expect(c.hub.view('tab-c')!.sessions[0].marker).toBeNull()
  expect(s.hub.marks()['tab-l1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId: null })
  expect(c.hub.marks()['tab-l1']).toEqual({ role: 'attached', project: 'acme', coordinator: 'coord · Studio', coordinatorTabId: 'tab-c' })
})
it('the tool\'s attach answers once Laptop confirms, or with Attaching… after 8 s', async () => {
  const answer = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
  await new Promise((r) => setImmediate(r)); sync(c, s)
  expect(await answer).toEqual({ ok: true, info: HUB_TEXT.attached('parser · Laptop', 'e10000') })
  const late = c.hub.tool('tab-c', { op: 'attach', session: 'e20000' })
  await new Promise((r) => setImmediate(r))
  expect(c.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toContain(8000)
  fire(c)
  expect(await late).toEqual({ ok: true, info: HUB_TEXT.attaching('docs · Laptop', 'e20000', 'Laptop') })
})
it('Laptop refuses a session attached to its own coordinator, naming it; the attachment goes and the answer says why', async () => {
  s.hub.make('tab-lc', false); s.hub.attach('tab-lc', 'e10000')
  const answer = c.hub.tool('tab-c', { op: 'attach', session: 'e10000' })
  await new Promise((r) => setImmediate(r)); sync(c, s)
  expect(await answer).toEqual({ ok: false, error: 'parser · Laptop is attached to the acme coordinator (lead · Laptop); it must be detached there first.' })
  expect(c.hub.view('tab-c')!.sessions).toEqual([])
  expect(records(s, 'detach')).toEqual([expect.objectContaining({ replyTo: expect.any(String), to: expect.objectContaining({ device: DEV_C, session: S.coord }) })])
})
it('Laptop refuses with its problem when it cannot coordinate, and a closed session as closed', ...)
// s.problem = coordinatorProblem(false, true, '2.1.400') → error HUB_TEXT.problemThere('Laptop', s.problem); s.tabs without tab-l1 (c.remoteTabs still lists it) → HUB_TEXT.closedThere('parser · Laptop')
it('a session on a device without coordinator records, or without mail, is refused and nothing is written', () => {
  c.peers = [peerOf(DEV_S, 'Laptop', { coord: false })]
  expect(c.hub.attach('tab-c', 'e10000')).toEqual({ ok: false, error: HUB_TEXT.oldDevice('Laptop') })
  c.peers = [peerOf(DEV_S, 'Laptop', { mail: false })]
  expect(c.hub.attach('tab-c', 'e10000')).toEqual({ ok: false, error: HUB_TEXT.noMail('Laptop') })
  expect(records(c, 'attach')).toEqual([])
})
it('the window attaches a remote tab by its id; one of an offline device is refused', ...)
// c.hub.attachTab('tab-c', 'tab-l1') → { ok: true, info: HUB_TEXT.attaching('parser · Laptop', 'e10000', 'Laptop') };
// const { c: c2 } = deviceWorlds(); c2.hub.make('tab-c', false); c2.peers = [peerOf(DEV_S, 'Laptop', { online: false })]; c2.hub.attachTab('tab-c', 'tab-l1') → { ok: false, error: HUB_TEXT.deviceOffline('Laptop') }
it('an attach whose device goes offline before it hears stays Attaching… with no time limit, and is confirmed once the device is back', ...)
// attach; c.peers[0] = { ...c.peers[0], online: false }; c.hub.remoteChanged() → marker 'attaching'; no timer of c is armed; c.peers[0].online = true; sync → marker null
it('a task to a Laptop session is held there as queued, and its report comes back to the coordinator', () => {
  c.hub.attach('tab-c', 'e10000'); sync(c, s)
  expect(c.hub.message('tab-c', 'e10000', 'Fix the parser.')).toEqual({ ok: true, info: expect.stringMatching(/^Task given to parser · Laptop \[e10000\]\./) })
  sync(c, s)
  expect(s.store.hosted(L.one)!.tasks).toEqual([expect.objectContaining({ state: 'queued', from: expect.objectContaining({ device: DEV_C, session: S.coord }) })])
  const [task] = records(s, 'task')
  s.hub.handedOver('tab-l1', [task], 'idle'); s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' }); fire(s); sync(c, s)
  expect(records(c, 'report')).toEqual([expect.objectContaining({ from: expect.objectContaining({ device: DEV_S, session: L.one }), to: expect.objectContaining({ device: DEV_C, session: S.coord }), outcome: 'finished', text: 'Parser fixed.' })])
  expect(c.store.coordinator(S.coord)!.attachments[0].lastReport).toMatchObject({ outcome: 'finished' })
  expect(c.hub.resolve('tab-c', 'e10000')).toEqual({ ok: true, info: HUB_TEXT.resolved('parser · Laptop') })
  expect(c.hub.view('tab-c')!.sessions[0].group).toBe('resolved')
})
it('a task to an Attaching… session is refused; one to an offline device\'s session waits and says so', ...)
// before sync: message → { ok: false, error: HUB_TEXT.notConfirmed('parser · Laptop') }; after sync, c.peers = [peerOf(DEV_S, 'Laptop', { online: false })] → { ok: true, info: HUB_TEXT.queuedOffline('parser · Laptop', 'e10000', 'Laptop') }
it('the 21st task to a Laptop session that sent no report is refused', ...)   // 20 messages ok, the 21st { ok: false, error: HUB_TEXT.tooMany('parser · Laptop') }
it('detaching a Laptop session tells Laptop, which drops its tasks without a report; stop does the same', ...)
// attach, sync, message, sync; detach → { ok: true, info: HUB_TEXT.detached('parser · Laptop', true) }; sync → s.store.hosted(L.one) null, records(s, 'report') []
// a fresh pair: attach, sync, c.hub.stop('tab-c'), sync → s.store.hosted(L.one) null
it('leave on Laptop detaches its session from Studio\'s coordinator; a tab attached nowhere is told so', () => {
  c.hub.attach('tab-c', 'e10000'); sync(c, s)
  expect(s.hub.leave('tab-l1')).toEqual({ ok: true, info: 'Detached from the acme coordinator.' })
  sync(c, s)
  expect(c.hub.view('tab-c')!.sessions).toEqual([])
  expect(s.hub.marks()['tab-l1']).toBeUndefined()
  expect(s.hub.leave('tab-l2')).toEqual({ ok: false, error: HUB_TEXT.notAttached })
})
it('a report from a session no longer attached wakes nobody', () => {
  c.hub.attach('tab-c', 'e10000'); sync(c, s); c.hub.message('tab-c', 'e10000', 'Fix the parser.'); sync(c, s)
  s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
  c.hub.detach('tab-c', 'e10000')                             // Laptop hears of it at the next sync only
  s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' }); fire(s); sync(c, s)
  const [report] = records(c, 'report')
  expect(report).toMatchObject({ delivered: true, read: true })
  expect(c.hub.accepts(report, 'tab-c', 'idle')).toBe(false)
})
```
`tests/unit/coordinator-tools.test.ts`: `attach_session waits 15 s for its answer` — the recorded timeout is `15000`.

`tests/e2e/coordinator-devices.spec.ts`:
```ts
test('attaching Laptop\'s session waits for Laptop to confirm; both windows mark it', async () => {
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  expect(await coord(a.pipeName, coordTab, { op: 'attach', session: refOf(sessionSid) })).toEqual({ ok: true, info: HUB_TEXT.attached('acme · Laptop', refOf(sessionSid)) })
  await expect.poll(async () => (await marksOf(b))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: null })
  await expect.poll(async () => (await marksOf(a))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: coordTab })
})
test('a task given to Laptop\'s session reaches it as the user\'s instruction, and its report wakes Studio\'s coordinator', async () => {
  // attach as above; const w = waitForMail(b.pipeName, sessionTab, sessionSid); message 'Fix the parser.' → ok;
  // (await within(w, 30_000)).info matches /^Task from your coordinator, through ClaudeTerm: the user's instruction, given through their acme coordinator\./ and contains '> Fix the parser.';
  // const c = waitForMail(a.pipeName, coordTab, coordSid); await done(b.pipeName, sessionTab, sessionSid, { lastMessage: 'Parser fixed.' });
  // (await within(c, 30_000)).info contains 'Report from a session attached to you, through ClaudeTerm: its task finished.' and '> Parser fixed.'
})
test('a session attached to Laptop\'s own coordinator is refused with that coordinator\'s name', async () => {
  // second = a Claude tab in repoB on Laptop with a session; makeCoordinator(b.page, second); coord(b.pipeName, second, attach refOf(sessionSid)) → ok;
  // coord(a.pipeName, coordTab, attach refOf(sessionSid)) → { ok: false, error: 'acme · Laptop is attached to the acme coordinator (acme · Laptop #2); it must be detached there first.' }
})
test('a session on a device without coordinator support cannot be attached', async () => {
  const { a, coordTab, sessionSid } = await coordDevices({ b: { env: { CLAUDETERM_TEST_NO_COORD: '1' } } })
  expect(await coord(a.pipeName, coordTab, { op: 'attach', session: refOf(sessionSid) })).toEqual({ ok: false, error: HUB_TEXT.oldDevice('Laptop') })
})
test('Laptop offline: its row is Offline, a task waits, and it reaches the session after Laptop starts again', async () => {
  // attach; await b.app.close(); poll (await coordViewOf(a, coordTab))!.sessions[0] toMatchObject { marker: 'offline', line: 'Offline' };
  // message 'Fix the parser.' → { ok: true, info: HUB_TEXT.queuedOffline('acme · Laptop', refOf(sessionSid), 'Laptop') };
  // await relaunch(b); tab = window.ct.openTab({ kind: 'claude', cwd: repoB }) on b; startSession(b.pipeName, tab, sessionSid);
  // (await within(waitForMail(b.pipeName, tab, sessionSid), 30_000)).info contains '> Fix the parser.'
})
test('the window attaches Laptop\'s tab by its id; Detach on Studio and Leave on Laptop each end the attachment on both', async () => {
  // a.page: window.ct.coordAttach(coordTab, sessionTab) → { ok: true, info: HUB_TEXT.attaching('acme · Laptop', refOf(sessionSid), 'Laptop') }; poll marksOf(b)[sessionTab] defined;
  // coord(a.pipeName, coordTab, detach refOf(sessionSid)) → { ok: true, info: HUB_TEXT.detached('acme · Laptop', false) }; poll marksOf(b)[sessionTab] undefined;
  // attach again (tool) → ok; b.page: window.ct.coordLeave(sessionTab) → { ok: true, info: 'Detached from the acme coordinator.' }; poll coordViewOf(a, coordTab).sessions toEqual []
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/coordinator-devices.test.ts tests/unit/coordinator-hub.test.ts tests/unit/coordinator-tools.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator-devices.spec.ts`
Expected: FAIL (another device's session is refused with part 1's text; `leave` is not a function).

- [ ] **Step 3: Implement** the Interfaces block. Then the header's Detach of an attached tab (part 2): run `grep -rn "coordDetach(" src/renderer`; where the call passes a mark's `coordinatorTabId`, replace it with `window.ct.coordLeave(<the attached tab's id>)` (it works for a coordinator on this device too, and `coordinatorTabId` is `null` for one on another device). If no such call exists, change nothing.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm test && npm run build && node scripts/e2e.mjs coordinator-devices.spec.ts coordinator.spec.ts coordinator-tasks.spec.ts agent-messages-devices.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/coordinator-hub.ts src/mcp/coordinator-tools.ts src/main/index.ts src/shared/ipc.ts src/preload/index.ts src/renderer tests/unit/coordinator-devices.test.ts tests/unit/coordinator-hub.test.ts tests/unit/coordinator-tools.test.ts tests/e2e/coordinator-devices.spec.ts
git commit -m "feat: sessions on paired devices are attached once their device confirms, take tasks and report back"
```

---

### Task 7: New session ids and replaced coordinators across devices

**Files:**
- Modify: `src/main/coordinator/coordinator-hub.ts` (`sessionStarted`, `make`, the mail listener)
- Test: `tests/unit/coordinator-devices.test.ts`, `tests/e2e/coordinator-devices.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`was`, `replaces`, `former`, `coordinatorBy`, `hostedBy`), Task 6.
- Behaviour:
  - **A new id tells the other side.** `sessionStarted` (part 1), right after `store.renameSession(old, new)` and before a clear's stopped report: for a renamed coordinator, an `attach` from `address(null, new)` to each attachment with a `device` (pending ones included) with `was: old` and `project`; for a renamed hosted session whose coordinator is on another device, an `attach` from `address(null, new)` to `hosted.coordinator` with `was: old` and `project`. Text `attachText(project)`, `delivered: false, read: false`.
  - **A replacing coordinator tells the other side.** `make(tabId, true)`: the new coordinator's `former` is `[old.session, ...old.former]` cut to `MAX_FORMER`; to each moved attachment with a `device`, an `attach` from the new coordinator with `replaces: old.session` and `project` (the attachment keeps its `pending`).
  - **The listener, `attach` with `was`** (not delivered, from another device): to a coordinator here (`coordinatorBy(to.session)`) → its attachment of (`from.device`, `was`) takes `session: from.session`, `name: from.name`; to a session hosted here (`hostedBy(to.session)`) whose coordinator is (`from.device`, `was`) → `coordinator: r.from`, and each task whose `from` is (`from.device`, `was`) gets `from: r.from`. Marked `delivered` and `read` either way; `changed()`.
  - **`attach` with `replaces`** to a session hosted here whose coordinator is (`from.device`, `replaces`) → `coordinator: r.from`, `project: r.project ?? hosted.project`, tasks unchanged; marked `delivered` and `read`. Otherwise it is a plain attach (Task 6).
  - **Forwarding.** A `report` not delivered and not read to a former id of a coordinator here (`coordinatorBy(to.session)` whose `session` differs), and a `task` not delivered and not read to a former id of a session hosted here, is written again with a new id to the current address (`to` with the current session and name; `from`, `replyTo`, `text`, `project`, `outcome`, `reason` kept; `sentAt: now()`, `delivered: false, read: false`), and the original is marked `delivered` and `read`. The copy then goes as any report or task does. The listener forwards before Task 6's rule that drops a report to a session that is no coordinator here.

- [ ] **Step 1: Write the failing tests** (`describe('new ids across devices')`, each from `deviceWorlds()`, `c.hub.make('tab-c', false)`, `c.hub.attach('tab-c', 'e10000')`, `sync(c, s)`; `clear = (w, tabId, from, to) => { w.hub.tabSession(tabId, to); w.hub.sessionStarted(tabId, from, to, 'clear') }`):
```ts
it('a clear in the coordinator tells Laptop: the session\'s tasks then come from the new id and are taken', () => {
  clear(c, 'tab-c', S.coord, NEW.coord)
  expect(records(c, 'attach').at(-1)).toMatchObject({ was: S.coord, from: { device: DEV_C, session: NEW.coord }, to: { device: DEV_S, session: L.one } })
  sync(c, s)
  expect(s.store.hosted(L.one)!.coordinator.session).toBe(NEW.coord)
  c.hub.message('tab-c', 'e10000', 'Fix the parser.'); sync(c, s)
  expect(s.store.hosted(L.one)!.tasks).toEqual([expect.objectContaining({ from: expect.objectContaining({ session: NEW.coord }) })])
})
it('a clear in Laptop\'s session tells Studio: the attachment follows it, and the clear\'s stopped report reaches the coordinator', () => {
  c.hub.message('tab-c', 'e10000', 'Fix the parser.'); sync(c, s); s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
  clear(s, 'tab-l1', L.one, NEW.one)
  expect(s.mail.all().filter((r) => r.from.device === DEV_S && (r.kind === 'attach' || r.kind === 'report')).map((r) => r.kind)).toEqual(['attach', 'report'])
  sync(c, s)
  expect(c.store.coordinator(S.coord)!.attachments[0]).toMatchObject({ session: NEW.one, lastReport: { outcome: 'stopped' } })
})
it('a task Studio sent to Laptop\'s old id is forwarded to the new one and taken there', () => {
  c.hub.message('tab-c', 'e10000', 'Fix the parser.')           // Laptop clears before it hears of the task
  clear(s, 'tab-l1', L.one, NEW.one); sync(c, s)
  expect(s.store.hosted(NEW.one)!.tasks).toHaveLength(1)
  expect(records(s, 'task').find((r) => r.to.session === L.one)).toMatchObject({ delivered: true, read: true })
})
it('a report Laptop sent to the coordinator\'s old id is forwarded to its new one, which takes it', () => {
  c.hub.message('tab-c', 'e10000', 'Fix the parser.'); sync(c, s); s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
  clear(c, 'tab-c', S.coord, NEW.coord)                          // Laptop finishes before it hears of the clear
  s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' }); fire(s); sync(c, s)
  const reports = records(c, 'report')
  expect(reports.find((r) => r.to.session === S.coord)).toMatchObject({ delivered: true, read: true })
  const copy = reports.find((r) => r.to.session === NEW.coord)!
  expect(copy).toMatchObject({ delivered: false, text: 'Parser fixed.', from: expect.objectContaining({ session: L.one }) })
  expect(c.store.coordinator(NEW.coord)!.attachments[0].lastReport!.id).toBe(copy.id)
})
it('a replacing coordinator takes Laptop\'s session with its task; the report goes to it with the previous coordinator\'s note', () => {
  c.hub.message('tab-c', 'e10000', 'Fix the parser.'); sync(c, s); s.hub.handedOver('tab-l1', records(s, 'task'), 'idle')
  c.hub.make('tab-2', true)
  expect(records(c, 'attach').at(-1)).toMatchObject({ replaces: S.coord, from: { session: S.two }, to: { session: L.one } })
  sync(c, s)
  expect(s.store.hosted(L.one)).toMatchObject({ coordinator: { session: S.two }, tasks: [{ from: { session: S.coord } }] })
  s.hub.turnEnded('tab-l1', { background: false, lastMessage: 'Parser fixed.' }); fire(s); sync(c, s)
  expect(records(c, 'report').at(-1)).toMatchObject({ to: { session: S.two }, text: expect.stringMatching(/^\(This task was given by the previous coordinator, coord · Studio\.\)/) })
})
```
`tests/e2e/coordinator-devices.spec.ts`:
```ts
test('a clear in Laptop\'s session keeps it attached: Studio lists the new id, and its next task reaches it', async () => {
  // attach refOf(sessionSid) → ok; newSid = randomUUID();
  // sendPipeMessage(b.pipeName, { v: 1, type: 'session', tabId: sessionTab, sessionId: newSid, source: 'clear', transcriptPath: null }) → { ok: true };
  // poll (await coord(a.pipeName, coordTab, { op: 'list' })).info toContain `- acme · Laptop [${refOf(newSid)}]`;
  // const w = waitForMail(b.pipeName, sessionTab, newSid); message refOf(newSid) 'Fix the parser.' → ok; (await within(w, 30_000)).info contains '> Fix the parser.'
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/coordinator-devices.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator-devices.spec.ts`
Expected: FAIL (no `was` / `replaces` record; Laptop's next task is refused as not from its coordinator).

- [ ] **Step 3: Implement** the Behaviour list.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm test && npm run build && node scripts/e2e.mjs coordinator-devices.spec.ts coordinator.spec.ts coordinator-tasks.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/coordinator-hub.ts tests/unit/coordinator-devices.test.ts tests/e2e/coordinator-devices.spec.ts
git commit -m "feat: a new session id or a replacing coordinator follows to the other device, and records in flight are forwarded"
```

---

### Task 8: `start_session` on a paired device

**Files:**
- Modify: `src/main/coordinator/coordinator-hub.ts` (`start`, `remoteChanged`, deps, `HUB_TEXT`)
- Modify: `src/main/coordinator/remote-start.ts`
- Modify: `src/shared/protocol.ts` (the `coord` parse of part 1 Task 10), `src/mcp/coordinator-tools.ts`
- Modify: `src/main/index.ts` (the hub's deps)
- Modify: `tests/fixtures/coordinator-world.ts`
- Test: `tests/unit/coordinator-devices.test.ts`, `tests/unit/coordinator-hub.test.ts` (part 1's other-device case), `tests/unit/remote-start.test.ts`, `tests/unit/protocol.test.ts`, `tests/unit/coordinator-tools.test.ts`, `tests/e2e/coordinator-devices.spec.ts`

**Interfaces:**
- Consumes: Task 4 (`open-tab` reply), Tasks 5–6; part 1 Task 8 (`start`, `START_WAIT_MS`, `worktreeInstruction`, `closedEarly`).
- Produces:
  ```ts
  // CoordinatorHubDeps gets:
  openRemoteTab(device: string, req: { cwd: string | null; email: string | null; title: string | null }):
    Promise<{ ok: true; tabId: string; cwd: string; accountName: string; defaulted: boolean } | { ok: false; error: string }>
  /** the email of an account of this device (null: Main account); null when it is not known */
  accountEmail(account: string | null): string | null
  // HUB_TEXT loses otherDevice; gets (exact):
  noDevice: (device: string) => `No paired device named "${device}".`,
  startedThere: (name: string, ref: string, device: string, place: string, account: string) => `Started ${name} [${ref}] on ${device} ${place}, on ${account}; it is attached to you once ${device} confirms. Its task is its first message; its report comes to you by itself when the task ends.`,
  openingThere: (name: string, device: string, place: string, account: string) => `Opening ${name} on ${device} ${place}, on ${account}. It shows as Starting… until its session starts; its task is sent then.`
  // remote-start.ts:
  /** where a session opened on another device: `asked` is the folder sent (the one asked for, or that of a project's tab when fromTab) */
  export function remoteFolderText(o: { cwd: string; asked: string | null; fromTab: boolean; defaulted: boolean; project: string }): string
  ```
  `remoteFolderText`, the first that applies: `defaulted` → `` `in ${cwd}, its default folder (${asked} is not a folder there)` ``; `fromTab` → `` `in ${cwd}, the folder of its ${project} tab` ``; `asked !== null` → `` `in ${cwd}` ``; else `` `in ${cwd}, its default folder (no ${project} tab is open there)` ``.
- `start(tabId, req)` after part 1's coordinator, problem and text checks: `device` null, or this device's `selfName()` without case → part 1's start. Else the peer of that name (trimmed, without case): none → `noDevice(device)`; offline → `deviceOffline(peer.name)`; `!coord` → `oldDevice(peer.name)`; `!mail` → `noMail(peer.name)`. Folder: `req.folder` (`fromTab: false`); else the folder of the first tab of that device, not exited, whose `project` equals the coordinator's project name without case (`fromTab: true`); else `null`. `openRemoteTab(peer.id, { cwd: folder, email: accountEmail(<the coordinator tab's account>), title: req.name })`; `{ ok: false, error }` → that answer. A pending start keeps `{ tabId, device, coordinator, text: (worktree ? worktreeInstruction(worktree) : '') + task, startedAt, place: remoteFolderText(…), account: reply.accountName }` in memory and shows as part 1's Starting… row with `device`, `deviceName: peer.name`, name `req.name ?? <the last part of reply.cwd>`.
- `remoteChanged()` also settles pending remote starts: the remote tab with that id has a session → the session is attached as Task 6's remote attach does (pending attachment and `attach` record, `name: rt.name`) and the task record is written to it (no `notConfirmed` refusal: Laptop takes the attach before the task, in store order) → the answer `startedThere(rt.name, refOf(session), peer.name, place, account)`; the device is listed and has no such tab → dropped, `closedEarly`; `START_WAIT_MS` first → `openingThere(name, peer.name, place, account)` and the start goes on.
- `protocol.ts`: in a `coord` `start`, `folder` must be absolute here only when `device` is null; with a `device` it is 1–`MAX_FOLDER` characters without `\0` (that device checks it).
- `coordinator-tools.ts`: `start` resolves a relative `folder` against `cwd` only when `device` is not given. The `start_session` description becomes: `Coordinator only: open a new Claude session in ClaudeTerm and give it a task as its first message. It opens on this device unless device names a paired device. On this device: in this coordinator's folder unless folder is given, on this coordinator's account. On a paired device: in folder (a path on that device) when given, else in the folder of a tab of the same project there, else that device's default folder; on its account with this coordinator's email, else its main account. Always in Claude Code's default permission mode. With worktree, the session first enters a new git worktree of that name with EnterWorktree; ClaudeTerm itself creates none. It is attached to you at once, and its report comes to you by itself when its task ends.`
- `index.ts`: `openRemoteTab` → `remote.actions.ask(device, 'open-tab', { kind: 'claude', profile: null, account: null, resume: null, ...req })` mapped to `{ ok: true, tabId: r.id, cwd: r.cwd ?? '', accountName: r.accountName ?? MAIN_ACCOUNT, defaulted: r.defaulted ?? false }`; a rejection → `{ ok: false, error: <its message> }`; no `remote` → `{ ok: false, error: REMOTE_COPY.deviceOffline(<name>) }`. `accountEmail: (a) => a === null ? accountsView().main.email : accountsView().accounts.find((x) => x.id === a)?.email ?? null`.
- The fixture's `world()` gets `openedRemote: { device: string; req: { cwd: string | null; email: string | null; title: string | null } }[]`, `remoteAnswer` (default `null`: answer `{ ok: true, tabId: 'rt-new', cwd: req.cwd ?? '/home/sam', accountName: 'Main account', defaulted: false }`), `mainEmail: string | null` (default `null`) and `emails: Record<string, string>` behind the two deps.

- [ ] **Step 1: Write the failing tests**

`tests/unit/coordinator-hub.test.ts`: part 1's `a folder that is not a directory and another device are refused` expects `HUB_TEXT.noDevice('Laptop')` for `device: 'Laptop'` (its world has no peers).

`tests/unit/remote-start.test.ts`:
```ts
it('remoteFolderText says where the session opened and why', () => {
  expect(remoteFolderText({ cwd: '/home/sam', asked: '/nope', fromTab: false, defaulted: true, project: 'acme' })).toBe('in /home/sam, its default folder (/nope is not a folder there)')
  expect(remoteFolderText({ cwd: '/home/sam/acme', asked: '/home/sam/acme', fromTab: true, defaulted: false, project: 'acme' })).toBe('in /home/sam/acme, the folder of its acme tab')
  expect(remoteFolderText({ cwd: '/w', asked: '/w', fromTab: false, defaulted: false, project: 'acme' })).toBe('in /w')
  expect(remoteFolderText({ cwd: '/home/sam', asked: null, fromTab: false, defaulted: false, project: 'acme' })).toBe('in /home/sam, its default folder (no acme tab is open there)')
})
```

`tests/unit/coordinator-devices.test.ts`, `describe('start on another device')`, each from `const c = world({ self: DEV_C, selfName: 'Studio' }); c.peers = [peerOf(DEV_S, 'Laptop')]; c.hub.make('tab-c', false)`:
```ts
it('start on Laptop opens a tab there in the folder of its acme tab with the coordinator\'s email, and is Starting… until the session comes', async () => {
  c.tabs[0] = { ...c.tabs[0], account: 'acc-1' }; c.emails = { 'acc-1': 'sam@example.com' }
  c.remoteTabs = [remoteTab({ tabId: 'tab-l2', session: L.two, name: 'docs · Laptop' })]
  const answer = c.hub.start('tab-c', { task: 'Write the release notes.', name: 'Release notes', folder: null, device: 'laptop', worktree: null })
  await new Promise((r) => setImmediate(r))
  expect(c.openedRemote).toEqual([{ device: DEV_S, req: { cwd: '/home/sam/acme', email: 'sam@example.com', title: 'Release notes' } }])
  expect(c.hub.view('tab-c')!.sessions).toEqual([expect.objectContaining({ key: 'start:rt-new', marker: 'starting', line: 'Starting…', device: DEV_S, deviceName: 'Laptop' })])
  c.remoteTabs.push(remoteTab({ tabId: 'rt-new', session: L.fresh, name: 'Release notes · Laptop' })); c.hub.remoteChanged()
  expect(await answer).toEqual({ ok: true, info: HUB_TEXT.startedThere('Release notes · Laptop', 'e40000', 'Laptop', 'in /home/sam/acme, the folder of its acme tab', 'Main account') })
  expect(records(c, 'attach')).toEqual([expect.objectContaining({ to: expect.objectContaining({ device: DEV_S, session: L.fresh }) })])
  expect(records(c, 'task')).toEqual([expect.objectContaining({ to: expect.objectContaining({ session: L.fresh }), text: 'Write the release notes.' })])
})
it('a coordinator without a known email starts the session on Laptop\'s main account; a folder Laptop refuses is named', async () => {
  // no emails: openedRemote[0].req.email is null; c.remoteAnswer = { ok: true, tabId: 'rt-new', cwd: '/home/sam', accountName: 'Main account', defaulted: true }, folder '/nope';
  // after the session: info contains 'in /home/sam, its default folder (/nope is not a folder there), on Main account'
})
it('with no acme tab on Laptop it asks for no folder, and the answer says it opened in the default folder', ...)   // openedRemote[0].req.cwd null; info contains 'its default folder (no acme tab is open there)'
it('an unknown device, an offline one, one without coordinator records and one without mail are refused, and nothing opens', ...)
// device 'Tablet' → noDevice('Tablet'); peers online: false → deviceOffline('Laptop'); coord: false → oldDevice('Laptop'); mail: false → noMail('Laptop'); c.openedRemote stays []
it('Laptop\'s refusal to open is the answer', ...)   // c.remoteAnswer = { ok: false, error: 'The tab could not be opened' } → { ok: false, error: 'The tab could not be opened' }
it('device naming this device starts the session here, as part 1 does', ...)   // device 'studio' → c.opened has one request, c.openedRemote []
it('a remote tab that closes before its session starts drops the start', ...)  // remoteTab rt-new without a session, then c.remoteTabs = [] and remoteChanged → { ok: false, error: HUB_TEXT.closedEarly }; sessions []
```
`tests/unit/protocol.test.ts`: `coord start with a device keeps a folder that is not absolute here; without one it is refused` — `{ v: 1, type: 'coord', tabId: TAB, op: 'start', task: 'x', device: 'Laptop', folder: 'relative/acme' }` parses with that folder; without `device` it is refused.

`tests/unit/coordinator-tools.test.ts`: `start_session with a device passes the folder as it is` — `sent[0].folder` is `'relative/acme'`.

`tests/e2e/coordinator-devices.spec.ts`:
```ts
test('start_session on Laptop opens a tab there in the folder of its acme tab, and sends the task once its session starts', async () => {
  const { a, b, coordTab, repoB } = await coordDevices()
  const answer = coord(a.pipeName, coordTab, { op: 'start', task: 'Write the release notes.', name: 'Release notes', folder: null, device: 'Laptop', worktree: null })
  let newTab: string | null = null
  await expect.poll(async () => (newTab = await b.page.evaluate(() => window.__ct!.tabIds().find((id) => window.__ct!.tabTitle(id) === 'Release notes') ?? null)), SLOW).not.toBeNull()
  const sid = randomUUID()
  expect(await startSession(b.pipeName, newTab!, sid)).toEqual({ ok: true })
  expect(await answer).toEqual({ ok: true, info: HUB_TEXT.startedThere('Release notes · Laptop', refOf(sid), 'Laptop', `in ${repoB}, the folder of its acme tab`, 'Main account') })
  expect((await within(waitForMail(b.pipeName, newTab!, sid), 30_000)).info).toContain('> Write the release notes.')
})
test('a folder Laptop does not have: the session opens in Laptop\'s default folder and the answer says so', async () => {
  // missing = join(tmpdir(), 'ct-no-such-folder'); start with folder: missing, device 'Laptop'; find the new tab as above, startSession it;
  // (await answer).info contains `in ${b.work}, its default folder (${missing} is not a folder there)`
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/coordinator-devices.test.ts tests/unit/coordinator-hub.test.ts tests/unit/remote-start.test.ts tests/unit/protocol.test.ts tests/unit/coordinator-tools.test.ts`, then `npm run build && node scripts/e2e.mjs coordinator-devices.spec.ts`
Expected: FAIL (`otherDevice` answers; `openRemoteTab` is never called).

- [ ] **Step 3: Implement** the Interfaces block.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm test && npm run build && node scripts/e2e.mjs coordinator-devices.spec.ts coordinator.spec.ts coordinator-tasks.spec.ts remote-tabs.spec.ts`
Expected: PASS (`remote-tabs.spec.ts` still opens tabs on another device from the window as before).

- [ ] **Step 5: Commit**
```bash
git add src/main/coordinator/coordinator-hub.ts src/main/coordinator/remote-start.ts src/shared/protocol.ts src/mcp/coordinator-tools.ts src/main/index.ts tests/fixtures/coordinator-world.ts tests/unit/coordinator-devices.test.ts tests/unit/coordinator-hub.test.ts tests/unit/remote-start.test.ts tests/unit/protocol.test.ts tests/unit/coordinator-tools.test.ts tests/e2e/coordinator-devices.spec.ts
git commit -m "feat: a coordinator starts a session on a paired device with its task"
```

---

## What part 2 reads from part 3

- `CoordSessionRow.device` / `deviceName` on a row of another device: the device chip, its colour `deviceColor(row.device)` (`src/shared/remote.ts`); no colour field is added.
- `marker` `'attaching'` and `'offline'` (part 1 named them; their lines `Attaching…` and `Offline` come from `rowState`).
- `CoordMarks` keyed by a remote tab's id in the coordinator's window: the tab list shows `↳ <project>` on that device's row as on any attached row in another group.
- On the session's device, `CoordMark` `attached` with `coordinatorTabId: null`: the header line `↳ Reports to <project> coordinator`; its **Detach** calls `CtApi.coordLeave(tabId)`.
- `CtApi.coordAttach(coordinatorTabId, remoteTabId)` now takes a tab of another device: drag-and-drop and the panel's Attach use it as they do for a local tab.
