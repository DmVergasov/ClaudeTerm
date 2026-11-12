# Chat mode, plan 4 of 4: other devices, performance, README — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member device shows and drives another device's chat-view tab as a chat; the perf harness proves the chat's budgets; the README and its images describe the chat; and, once the Settings redesign has landed, its Claude Code page gets the "Claude tabs open in" choice.

**Architecture:** The host streams a tab's chat over the device link the way it streams hub data today: a `chat` push with a capped snapshot on attach, then `chat-patch` pushes in order; a member keeps a mirror (`chat-mirror.ts`) and feeds its window exactly as a local `ChatHub` does. The member's actions go back as calls (`chat-send`, `chat-answer`, …) that the host checks and hands to its `ChatHub`; the host's process stays the only one.

**Tech Stack:** TypeScript, the device link (`src/main/sync/*`, `src/main/remote-host.ts`), Playwright (two apps, `tests/e2e/device-pair.ts`), the perf harness (`playwright.perf.config.ts`).

**Spec:** `docs/superpowers/specs/2026-11-11-chat-mode-design.md`, sections "Other devices", "Performance", "Testing" (README). Plans 1–3 must be done first.

## Global Constraints

- Every Global Constraint of plan 1 holds (worktree, no commits, the Settings plan alongside and the files it owns, the lock for build and e2e, untrusted input, no real `claude`, `pathKey`, the terminal view unchanged, English, palette, motion, `chat.css`).
- Everything a member sends is untrusted: each call's arguments are checked (`CALL_ARGS` style in `src/main/remote-host.ts`); a call for a tab that is not a local chat-view Claude tab of this device fails with `CallError('not a chat tab')`. An attachment a member sends must be a file the member copied to this device first (inside the member's received-files folder, by `pathKey` / `isWithin`).
- A device older than this version must keep working with one that has it: new push kinds are dropped by old devices (`PUSH_KINDS` check), `RemoteTab.view` is optional on the wire, a member never starts Claude for a remote tab.
- A chat push is at most 2 MiB as JSON: a snapshot keeps its newest items that fit (`hasOlder: true` when some were left out); a patch batch over the cap is replaced by a fresh snapshot push.
- No real personal data in screenshots or the README: invented projects, paths, names and sessions only (the stand-in's scripted conversations).

## Review Focus

1. **Host and member answer the same card**: the first answer wins; the other device's card closes as answered; no error toast. Test: Task 3.
2. **A member that drops off mid-stream and comes back**: it gets a fresh snapshot on attach and continues from there, no duplicated or missing items. Test: Task 3.
3. **A 5 000-item conversation attached from a member**: the push stays under 2 MiB, the member shows the end, older pages come through `chat-older`. Test: Task 2 unit, Task 3 e2e.
4. **A member sends a malformed call** (wrong types, a path outside its received files, an unknown card id): refused, the host's tab unaffected. Test: Task 2.
5. **The SDK stays unloaded** while no chat tab has started (launch time unchanged). Test: Task 4.

---

### Task 1: the wire — the tab's view, chat pushes, chat calls

**Files:**
- Create: `src/main/chat/chat-mirror.ts`
- Modify: `src/shared/remote.ts`, `src/main/sync/remote-wire.ts`, `src/main/remote-host.ts` (`clampPush`, `CALL_ARGS`), `src/main/sync/remote-actions.ts` (`remoteTabInfo`)
- Test: `tests/unit/remote-wire.test.ts`, `tests/unit/chat-mirror.test.ts` (find the existing wire test file by name; add to it)

**Interfaces:**
- Produces:

```ts
// shared/remote.ts
RemoteTab.view?: TabView | null                       // optional: an older device leaves it out
PushKind gains 'chat' | 'chat-patch'; PUSH_KINDS lists them
export const MAX_CHAT_PUSH_BYTES = 2 * 1024 * 1024
// chat-mirror.ts — a chat as a member holds it, from the host's pushes
export class ChatMirror {
  load(s: ChatSnapshot): void
  /** false: the patches do not follow; the member asks for a fresh snapshot */
  apply(fromRev: number, toRev: number, patches: ChatPatch[]): boolean
  snapshot(): ChatSnapshot | null
}
export function capSnapshot(s: ChatSnapshot, maxBytes: number): ChatSnapshot     // newest items that fit, hasOlder set
export function parseChatPush(v: unknown): { snapshot: ChatSnapshot } | { fromRev: number; toRev: number; patches: ChatPatch[] } | null
```

Rules: `parseRemoteTab` reads `view` with `isTabView`, `null` otherwise; `remoteTabInfo` sets `view: tab.kind === 'claude' ? tab.view ?? 'terminal' : null`. `parseChatPush` validates every item and patch shape (kinds, string caps of plan 1's Global Constraints, at most 2 000 items per snapshot and 500 patches per batch); anything invalid → `null` (dropped). `CALL_ARGS` gains `chat-send` `{ id, text, attachments }`, `chat-answer` `{ id, cardId, answer }` (`isChatAnswer`), `chat-interrupt` `{ id }`, `chat-mode` `{ id, mode }`, `chat-model` `{ id, model, effort }`, `chat-stop-task` `{ id, taskId }`, `chat-older` `{ id, beforeId }`, `chat-view` `{ id, view }`, `chat-commands` `{ id }`, `chat-models` `{ id }`, `chat-files` `{ id, query }`, `chat-terminal` `{ id, line }`.

- [ ] **Step 1: Write the failing tests:** a `RemoteTab` with and without `view` parses; `capSnapshot` of 5 000 notice items under 2 MiB keeps the newest and sets `hasOlder` (Review Focus 3); `parseChatPush` drops a patch with an unknown `op`, an item with a 2 MiB text, a snapshot of 2 001 items; `ChatMirror.apply` refuses a gap; each `CALL_ARGS` chat entry refuses wrong types (Review Focus 4).
- [ ] **Step 2: Run** `npx vitest run tests/unit/remote-wire.test.ts tests/unit/chat-mirror.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (the controller snapshots the tree).

### Task 2: the host serves its chat tabs; the member mirrors them

**Files:**
- Modify: `src/main/chat/chat-hub.ts`, `src/main/remote-host.ts` (`hostTabs` pushes, `hostHandlers` chat calls), `src/main/sync/remote-actions.ts` (member calls), `src/main/sync/tab-viewer.ts` (mirrors per remote tab), `src/main/index.ts` (the chat IPC handlers route a remote tab id to its device)
- Test: `tests/unit/chat-hub.test.ts`, `tests/integration/remote-chat.int.test.ts` (two `TabHost` / `RemoteTabs` over the in-memory links of `tests/fixtures/sync.ts`)

**Interfaces:**
- Produces: `ChatHubDeps.remote(tabId: string, fromRev: number, toRev: number, patches: ChatPatch[]): void` and `ChatHubDeps.watched(tabId: string): boolean` (patches of a watched tab gather and go out every 50 ms, whatever tab the window shows); `ChatHub.remoteSnapshot(tabId: string): ChatSnapshot | null` (capped by `capSnapshot`).

Rules:
- Host: `HostTabs.pushes(tabId)` includes `{ k: 'chat', v: { snapshot } }` for a chat-view tab; `remote` sends `{ k: 'chat-patch', v: { fromRev, toRev, patches } }` to the members attached to the tab (over the cap → a `chat` snapshot instead). The chat calls run on the tab's `ChatHub` methods (`chat-terminal` runs plan 3's `openInTerminal`); `chat-send` attachments must lie within the member's received-files folder, else `CallError('not a file sent to this device')`; `chat-answer` returns `{ ok: boolean }` (false: the card was answered already).
- Member: the viewer keeps a `ChatMirror` per attached remote chat tab and forwards each accepted push to the window as `evChatPatch` (a snapshot as a `reset`); `apply` false → it re-attaches the tab (fresh snapshot). `ct.chatSnapshot(remoteId)` answers from the mirror; the other chat IPC calls on a remote tab id become the device's calls (attachments: plan 1's remote drop path copies the files first and passes the host paths).

- [ ] **Step 1: Write the failing tests:** unit: a watched tab's patches reach `remote` though another tab is in front. Integration: attach → the member's mirror equals the host's snapshot; a streamed turn arrives in order; detach and re-attach mid-stream → the mirror equals the host's model again (Review Focus 2); `chat-answer` twice → `{ ok: true }` then `{ ok: false }`; `chat-send` with a path outside the received folder is refused; a call for a shell tab is refused.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-hub.test.ts tests/integration/remote-chat.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 3: a member drives a chat tab (end to end)

**Files:**
- Modify: `src/renderer/main.ts` (a `ChatView` for a remote tab whose `info.view === 'chat'`; the switch shown for it too, calling the device; plan 1 Task 13's rule "a tab in chat view has no xterm" — `makeTerminal` / `ensureTerminal` — now covers these remote tabs too)
- Test: `tests/e2e/chat-devices.spec.ts`

- [ ] **Step 1: Write the failing e2e tests** (`pairedApps` from `device-pair.ts`; device A runs a chat tab on the stand-in with `launchChatTab`'s settings and env, device B is the member):
  - `'a member sees a chat tab as a chat and its answer streaming'`;
  - `'a member's message, interrupt and mode change reach the host's Claude Code'` (the stand-in log on A);
  - `'host and member answer the same card: the first wins, both cards close'` (Review Focus 1);
  - `'a member that reconnects mid-stream catches up'` (B's link dropped and back while A streams → B's column ends like A's);
  - `'a member attaching a 5 000-item conversation shows its end and pages older items'` (Review Focus 3);
  - `'the member switches the host's tab to the terminal'` (A's tab shows its terminal; B shows a terminal copy).
- [ ] **Step 2: Run** `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/chat-devices.spec.ts --reporter=line --workers=2"`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, then `tests/e2e/remote-tabs.spec.ts` through the lock (the terminal tabs of other devices unchanged). Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 4: the perf harness measures the chat

**Files:**
- Create: `tests/perf/chat.perf.ts`
- Modify: `src/main/chat/sdk-engine.ts` (in a test run, `loadSdk` sets `globalThis.ctChatSdkLoaded = true`), `src/renderer/chat/chat-view.ts` (`performance.mark` / `measure` named `chat-frame` around each frame's patch work), `tests/fixtures/fake-claude/fake-claude.ts` (step `{ text, rate: <tokens per second> }`: words emitted evenly at that rate)
- Test: `tests/e2e/chat.spec.ts` (Review Focus 5), the harness itself

Rules (budgets from the spec; the harness fails a run over budget and prints one JSON line of medians of five runs, as `timing.perf.ts` does):
- `chatActivate`: a restored chat tab with 5 000 pairs, from `activateTab` to its last message visible: ≤ 150 ms.
- `chatScrollLongTask`: scrolling that tab from bottom to top in 40 wheel steps, the longest `longtask` (`PerformanceObserver`): ≤ 50 ms.
- `chatFrameMs`: a chat streaming at 200 tokens/s for 5 s, the largest `chat-frame` measure: ≤ 4 ms.
- `typingLatency`: while that chat streams in a hidden tab, typing 40 characters into another chat tab's composer, from `keydown` to the next animation frame: the median ≤ 16.7 ms.
- `chatMemoryMB` and `terminalMemoryMB`: the renderer's `performance.memory.usedJSHeapSize` growth for 20 chat tabs and for 20 terminal Claude tabs, printed (reported, not a budget).
- The existing `timing.perf.ts` launch numbers stay within part 1's (599 ms window, 762 ms prompt medians) on the same machine — the controller compares.

- [ ] **Step 1: Write the failing e2e test** `'the Agent SDK is not loaded until a chat tab starts'` in `chat.spec.ts`: launch with a shell tab only → `app.evaluate(() => (globalThis as { ctChatSdkLoaded?: boolean }).ctChatSdkLoaded)` is not `true`; open a chat tab → it is `true`.
- [ ] **Step 2: Run** it through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** the flag, the marks, the rate step and `chat.perf.ts`.
- [ ] **Step 4: Run** the e2e test through the lock, then `node .superpowers/sdd/locked.cjs "npm run perf"`. Expected: PASS, every budget met; the printed line goes into the controller's ledger.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 5: README and screenshots

**Files:**
- Modify: `README.md`, `tests/screenshots/*` (the existing screenshot specs, find them by `playwright.screenshots.config.ts`)
- Create: `docs/images/chat.png`, `docs/images/chat-question.png` (generated)

Rules: a README section **Chat** after the part that describes Claude tabs: what the chat shows, the Chat | Terminal switch and the "Claude tabs open in" setting, the composer (attachments, `@`, mode and model chips, Esc), the cards, the `/` menu with `/model` and `/resume`, what opens in the terminal and why, other devices, the Agent SDK it runs on (with a link to THIRD-PARTY-NOTICES.md) and that it needs Claude Code 2.1.322 or later (the floor of plan 1 Task 9). The screenshots come from invented conversations scripted on the stand-in (a revenue dashboard project at `~/work/acme-dashboard`-like invented paths): one at work with a tool step and agents, one with a question card. `npm run screenshots` regenerates them; only the images that changed are kept.

- [ ] **Step 1:** Add the two screenshot cases to the screenshot specs.
- [ ] **Step 2: Run** `node .superpowers/sdd/locked.cjs "npm run screenshots"`. Expected: `docs/images/chat.png` and `docs/images/chat-question.png` written.
- [ ] **Step 3:** Write the README section; check that every image shows only invented data.
- [ ] **Step 4: Run** `npx vitest run tests/unit/third-party-notices.test.ts` (the README still links the notices). Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

## Integration with the Settings redesign

Runs after both this plan set and `2026-11-11-settings-window.md` are done (the controller does it, or dispatches it as one task with these exact values). The Settings plan leaves `<div class="settings-slot" data-slot="claude-view" hidden></div>` at the top of the Claude Code page and exports `cardSection` from `src/renderer/settings-controls.ts`.

- **Claude tabs open in** — `cardSection({ title: 'Claude tabs open in', key: 'claude.view', searchText: 'chat terminal view default open', choices: () => [{ value: 'chat', title: 'Chat', note: 'The conversation as a chat, with cards for Claude\'s questions and permissions', art: <icon message-square> }, { value: 'terminal', title: 'Terminal', note: 'Claude Code\'s own screen, as before', art: <icon terminal> }], selected: (v) => v.settings.claude.view, pick: (value, error) => save('claude.view', value, error) })`, placed into the slot, the slot un-hidden. Applies to Claude tabs opened after a change; each tab keeps its own view and its switch.
- A test in `tests/e2e/settings.spec.ts` (owned by the Settings plan until it is done; edited only at integration): `'Claude tabs open in: Terminal makes new Claude tabs open in the terminal'` — pick Terminal in Settings → `settings.json` has `claude.view: 'terminal'`; a new Claude tab opens with its terminal shown and the switch on Terminal.
- No other chat setting exists in part 2.
