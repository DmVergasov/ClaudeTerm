# Chat mode, plan 3 of 4: composer, cards, slash commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the user does in a chat tab works as drawn and as in the terminal: the composer with attachments, `@` files, the mode and model chips; question, permission and plan cards answered with mouse or keyboard and never by a stray key; the `/` menu with native `/model` and `/resume`; terminal-only commands, `!` commands and unknown dialogs opening in the terminal of the same conversation; the status bar, auto-continue and Send in chat view.

**Architecture:** Main gains attachment preparation (`chat-attachments.ts`), the project's file list for `@` (`chat-files.ts`), the hand-over to the terminal (`terminal-handoff.ts`), `TabManager.resumeSession`, and one `writeToClaude` path that auto-continue uses. The renderer replaces plan 1's plain composer and cards (`chat-composer.ts`, `chat-cards.ts`) and adds the menus (`slash-menu.ts`, `model-picker.ts`, `file-picker.ts`).

**Tech Stack:** TypeScript, plain DOM, Electron `nativeImage` and `dialog` in main, `execGit` for the file list, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-11-chat-mode-design.md`, sections "The cards", "The composer", "The slash menu", "One conversation, two views" (opening in the terminal), "The status bar and the title bar". Plans 1 and 2 must be done first. Board copies in `.superpowers/sdd/2026-11-11-chat-mode-2/boards/` (Main, Approve, Tabs, Slash).

## Global Constraints

- Every Global Constraint of plan 1 holds (worktree, no commits, the Settings plan alongside and the files it owns, the lock for build and e2e, untrusted input, no real `claude`, `pathKey`, the terminal view unchanged, English, palette, motion, `chat.css`) and plan 2's drawing rules (`textContent` for Claude's strings).
- **A key typed into the composer never reaches a card, and a card is never answered by a key that was not pressed while the card had the focus.** Enter on a card takes its focused button; nothing answers a card on its own.
- Main reads an attached file only when the message is sent, only files the user attached through the window (paths it handed out in `chatAttach` / `chatPickFiles` results for that tab, compared with `pathKey`), at most 20 per message and 30 MB each.
- Images go to Claude as image content after scaling: long edge ≤ 1568 px, encoded ≤ 3.75 MB (PNG kept when it fits, else JPEG quality 85); PNG, JPEG, GIF, WebP only. Other files go as `@path` mentions (quoted `@"…"` when the path has a space).
- Board values (exact): composer field border `1px solid #26262D`, radius 12 px, background `#16161A`, `box-shadow: 0 1px 0 #ffffff08 inset`, text area padding 12 px 14 px 4 px; icon buttons 30 px, radius 7 px, `#8C8C96` (`/` in 500 14 px monospace); chips 28 px high, padding 0 9 px, border `1px solid #26262D`, radius 7 px, `#B5B5BE`, 12 px, a 6 px dot before the mode; mode dots: Ask before edits `#8C8C96`, Accept edits `#E5B567`, Plan `#7FA7F5`, Auto `#A78BFA`, Bypass `#F2867E`; the model chip `Opus 5.5` then `· high` in `#8C8C96`. Question card header background the accent at 14 %, `border-bottom: 1px solid #222228`, title accent, 600, 12.5 px; option buttons label 600, description 12 px `#9D9DA7`, number 11 px `#8C8C96` on the right; own-answer input 36 px, `#0E0E11`, border `#26262D`, radius 8 px. Card buttons 34 px, radius 8 px, padding 0 14 px; the primary one accent with `#141414` 600 text; others border `1px solid #2A2A31`, `#B5B5BE`, 500; key badges padding 0 5 px, radius 4 px, 11 px (`#00000022` on the primary, `#26262D` / `#8C8C96` on the others). Menu items 34 px, radius 7 px.
- UI strings (exact, the spec wins over the boards): composer placeholder `Message Claude…`, while Claude works `Queue a follow-up…`; queued bubble tag `Queued`; waiting pulse `Claude is waiting for your answer`; question header `Claude has a question`; `Or type your own answer…`; hint `1–4 to pick · Enter to confirm · Esc to dismiss` (the number is the option count); `Skip`, `Next`, `Submit`; `Allow once`, `Deny`, `Tell Claude what to do instead…`; plan buttons `Approve and accept edits`, `Approve and ask before edits`, `Keep planning`, box `Tell Claude what to change…`; attach menu `Files on this computer…`, `Paste an image` with `Ctrl V` (`⌘V` on macOS); slash count `${n} commands match "${q}"` (`1 command match…` singular), hint `↑↓ move · Tab complete · Enter run`, groups `Claude Code`, `This project`, `Plugins and skills`, tag `Opens in the terminal`; notices `Opened ${what} in the terminal`, `${what} opens in the terminal once Claude finishes`.

## Review Focus

1. **Two cards at once** (parallel tool calls that both need permission): they wait in order; only the first takes the keyboard; answering it brings the next. Test: Task 4.
2. **A card while the user types** (composer focused, text in it): the card waits, the composer pulses, Enter still sends the composer's text (queued), Tab moves to the card. Test: Task 4 `'a stray Enter in the composer never answers a card'`.
3. **An attachment that is too big or of an odd kind** (a 40 MB PNG, a 10 000 × 10 000 image, a `.exe`): the 40 MB one is refused with a notice, the big image is scaled, the `.exe` goes as an `@path`. Test: Task 1.
4. **A terminal-only command while Claude works**: not run; the text stays; it opens in the terminal when the turn ends. Test: Task 5.
5. **`/resume` of a session from another folder**: it opens in a new tab in that folder, not in this one. Test: Task 2 (main) and Task 5 (e2e).

---

### Task 1: attachments and the project's files (main)

**Files:**
- Create: `src/main/chat/chat-attachments.ts`, `src/main/chat/chat-files.ts`
- Modify: `src/main/chat/chat-hub.ts` (`send` with attachments), `src/main/chat/chat-engine.ts` / `sdk-engine.ts` (image blocks already in `send`), `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`
- Test: `tests/unit/chat-attachments.test.ts`, `tests/integration/chat-files.int.test.ts`, `tests/unit/chat-hub.test.ts` (plan 1's `send` tests, made async)

**Interfaces:**
- Produces:

```ts
// chat-attachments.ts
export const IMAGE_TYPES: Record<string, string>   // '.png' → 'image/png', '.jpg'/'.jpeg' → 'image/jpeg', '.gif', '.webp'
export interface AttachDeps { stat(p: string): Promise<{ size: number; isFile: boolean } | null>; read(p: string): Promise<Buffer>; scale(data: Buffer, mediaType: string): Promise<{ data: Buffer; mediaType: string }> }
export function attachmentOf(path: string, size: number): ChatAttachment          // kind by IMAGE_TYPES, cardId null
/** the text Claude gets (the user's text, then the files' @mentions) and the image blocks; or why it cannot go */
export function prepareMessage(s: ChatSend, allowed: (path: string) => boolean, d: AttachDeps): Promise<{ text: string; images: { mediaType: string; data: string }[] } | { refused: string }>
export function mention(path: string, folder: string): string                      // @rel/path, @"rel/with space", absolute outside the folder
// chat-files.ts
export function projectFiles(folder: string, run: GitRunner): Promise<string[]>   // ≤ 20 000 paths with '/', cached 30 s per folder
export function matchFiles(files: string[], query: string, limit?: number): string[]   // subsequence match, best first, default 50
```

IPC (added to `IPC` / `CtApi`): `chatAttach(tabId: string, paths: string[]): Promise<ChatAttachment[]>` (stats each, registers images with the image hub as `'pasted'` cards and returns their `cardId`, remembers the paths as allowed for the tab), `chatPickFiles(tabId: string): Promise<ChatAttachment[]>` (`dialog.showOpenDialog` with `openFile`, `multiSelections`, then as `chatAttach`), `chatFiles(tabId: string, query: string): Promise<string[]>`.

Rules: `prepareMessage` refuses a path not allowed (`Cannot attach ${name}: it was not attached in this window`), a missing file (`${name} is gone`), a file over 30 MB (`${name} is over 30 MB`); images are read and scaled by `d.scale` (in `index.ts` with `nativeImage`: `resize` to a long edge ≤ 1568, `toPNG()` when ≤ 3.75 MB else `toJPEG(85)`); others become mentions appended to the text, one per line after a blank line. `projectFiles`: `execGit(folder, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])`; outside git, a breadth-first walk to depth 6, at most 5 000 files, skipping `.git` and `node_modules`. `matchFiles`: case-insensitive subsequence of the query in the path; ranking: name hit before path hit, then shorter path.

- [ ] **Step 1: Write the failing tests:** `prepareMessage` with a fake scaler: an image becomes one block with its media type; a `.exe` becomes `@tools/run.exe`; a path with a space becomes `@"my notes.txt"`; a 40 MB file is refused (Review Focus 3); a path never attached is refused; `mention` outside the folder is absolute. `projectFiles` in a real temp git repo lists tracked and untracked-not-ignored files and leaves out ignored ones; outside git it skips `node_modules`. `matchFiles('rvts', ['src/revenue.ts', 'docs/rv.md'])` puts `src/revenue.ts` first.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-attachments.test.ts tests/integration/chat-files.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the two files, the IPC, and `ChatHub.send`, which becomes `send(tabId: string, s: ChatSend): Promise<string | null>`: `prepareMessage` then `engine.send(text, images)`; a refusal becomes the result of `chatSend` and no message goes. Update plan 1's `send` tests in `tests/unit/chat-hub.test.ts` to `await` it, and the `chatSend` handler in `index.ts` to return the awaited result.
- [ ] **Step 4: Run** them, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (the controller snapshots the tree).

### Task 2: models, effort, modes, commands, resume, and the hand-over to the terminal (main)

**Files:**
- Create: `src/main/chat/terminal-handoff.ts`
- Modify: `src/main/chat/chat-engine.ts`, `src/main/chat/sdk-engine.ts`, `src/main/chat/chat-hub.ts`, `src/main/tab-manager.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`
- Test: `tests/unit/terminal-handoff.test.ts`, `tests/unit/tab-manager.test.ts`, `tests/unit/chat-hub.test.ts`

**Interfaces:**
- Produces:

```ts
// ChatEngine gains
setEffort(level: string | null): Promise<void>        // applyFlagSettings({ effortLevel: level })
// ChatHub: plan 1's setModel(tabId, model, effort) now calls engine.setModel(model), then engine.setEffort(effort), and sets state model / effort
// ChatHub gains
modes(tabId: string): ChatPermissionMode[]            // ['default', 'acceptEdits', 'plan'] + 'auto' once Claude Code reported mode 'auto' in this tab
noteForChat(tabId: string, text: string): void        // a notice the chat shows now, or after its next start's history
// commands(): a command found as .claude/commands/<name>.md or .claude/skills/<name>/ in the tab's folder is group 'project'
// TabManager gains
resumeSession(tabId: string, sessionId: string): Promise<boolean>   // a local Claude tab, not working: its conversation becomes sessionId (fork cleared), restarted live
// terminal-handoff.ts
export interface HandoffDeps { setView(tabId: string, view: TabView): Promise<boolean>; promptState(tabId: string): Promise<PromptState>; write(tabId: string, data: string): void; note(tabId: string, text: string): void; sleep(ms: number): Promise<void> }
/** switches the tab to the terminal, waits for Claude Code's empty prompt (every 300 ms, up to 30 s), types the line and Enter */
export function openInTerminal(tabId: string, line: string | null, what: string, d: HandoffDeps): Promise<boolean>
```

IPC: `chatOpenInTerminal(tabId: string, line: string | null): Promise<boolean>` (`line` null: only switch, for an unknown dialog), `chatResume(tabId: string, sessionId: string, cwd: string): Promise<'here' | 'new-tab' | null>`, `chatModes(tabId: string): Promise<ChatPermissionMode[]>`.

Rules:
- `openInTerminal`: false when `setView` refuses; after `promptState` answers `'empty'`, `write(line)` then `write('\r')`; `note(tabId, 'Opened ' + what + ' in the terminal')`; a prompt that never empties in 30 s writes nothing and notes `Could not run ${what}: Claude Code's prompt did not come up`.
- `chatResume`: the session's `cwd` equal to the tab's folder by `pathKey` → `resumeSession` → `'here'`; otherwise the existing open-session path opens it in a new tab → `'new-tab'` (Review Focus 5).
- `writeToClaude(tabId, data)` in `index.ts`: a chat-view tab gets `chatHub.send(tabId, { text: data without its trailing '\r', attachments: [] })`, a terminal tab `tabs.write(tabId, data)`. `AutoContinue`'s `write` uses it (so cut-off answers and restored turns continue in chat view too).

- [ ] **Step 1: Write the failing tests:** handoff: switches, waits through `'none'`, `'draft'`, then `'empty'`, writes the line and Enter, notes `Opened /config in the terminal`; refused switch writes nothing; 30 s timeout notes the failure. TabManager: `resumeSession` restarts the tab with `--resume <new id>` in its launch and is refused while working. ChatHub: `noteForChat` before a restart shows after the next start's history `reset`; `modes` gains `'auto'` after a `system/status` with `permissionMode: 'auto'`; a command with `.claude/commands/deploy.md` in the folder is `project`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/terminal-handoff.test.ts tests/unit/tab-manager.test.ts tests/unit/chat-hub.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 3: the composer

**Files:**
- Modify: `src/renderer/chat/chat-composer.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`, `src/renderer/main.ts`, `src/renderer/icons.ts` (add only: `paperclip`, `at-sign`, `arrow-up` if missing)
- Test: `tests/e2e/chat-composer.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface ComposerOptions {
  tabId: string; platform: string
  send(s: ChatSend): Promise<string | null>; interrupt(): void
  attach(paths: string[]): Promise<ChatAttachment[]>; pickFiles(): Promise<ChatAttachment[]>; pasteImage(): Promise<string | null>
  setMode(mode: ChatPermissionMode): void; modes(): Promise<ChatPermissionMode[]>
  openModelPicker(anchor: HTMLElement): void; openSlashMenu(): void; openFilePicker(): void
  history(): string[]            // this session's earlier user messages, newest last
  imageCard(cardId: string): ImageCard | null
}
export class ChatComposer {
  constructor(o: ComposerOptions)
  readonly element: HTMLDivElement
  setState(s: ChatState): void
  focus(): void
  hasDraft(): boolean            // focused or not, text or attachments in it
  insert(text: string): void     // at the caret (the pickers use it)
  addAttachments(a: ChatAttachment[]): void
  pulse(on: boolean): void       // 'Claude is waiting for your answer'
}
```

Rules:
- Layout as the board: the field; chips of attachments above the text (thumbnail via `imageCard` or a file icon, name, size as `1.2 MB`, ✕); the text area growing with its text up to a third of the sheet's height, then scrolling; the row: Attach (opens the attach menu), `@`, `/`, a spacer, the mode chip (dot + label + chevron), the model chip (`displayName` from `state.model` — the model's display name when the models list has it, else the id — then `· <effort>`), Send (accent arrow button; disabled with nothing to send).
- Keys in the text area: Enter sends (text or attachments), Shift+Enter a newline; while `turn !== 'idle'` Enter queues (the placeholder says so, the bubble shows `Queued`); ↑ in an empty composer puts the newest earlier message in, ↑ again the one before, ↓ back; Esc while a turn runs interrupts, Esc with nothing running clears the composer; Shift+Tab cycles `modes()` in order; `/` typed as the first character opens the slash menu; `@` typed after a space or at the start opens the file picker. A draft (text and attachments) is kept per tab while the window lives.
- Attachments: the attach menu's two items; paste of an image (`Ctrl V` / `⌘V` with an image on the clipboard) → `pasteImage()` (`ct.saveClipboardImage`) → `attach([path])`; dropping files anywhere on the tab's sheet → `attach(paths)` (a remote tab keeps its plan-4 path). A `send` refusal shows under the field in `#F2867E` and keeps the draft.
- `main.ts`: the renderer's answer to a prompt query for a chat-view tab comes from `composer.hasDraft()` (`'draft'` / `'empty'`).

- [ ] **Step 1: Write the failing e2e tests:** `'Enter sends, Shift+Enter is a new line'`; `'a message sent while Claude works is queued until its turn'` (the bubble shows `Queued`, then not); `'↑ recalls earlier messages'`; `'Esc stops the turn, Esc again clears'`; `'Shift+Tab cycles the mode and Claude Code hears it'` (stand-in log has `set_permission_mode` `acceptEdits`); `'a pasted image is attached, scaled and sent as an image'` (`@alone`, `keepingClipboard`, a 4000 × 3000 PNG on the clipboard → the stand-in's logged user message has an image block whose decoded size, read with `app.evaluate` and `nativeImage`, has a long edge ≤ 1568); `'dropped files become chips and go as mentions'`; `'a refused attachment says why and keeps the draft'`; `'the draft stays with its tab'`.
- [ ] **Step 2: Run** `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/chat-composer.spec.ts --reporter=line --workers=2"`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it and `tests/e2e/chat.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 4: the cards

**Files:**
- Create: `src/renderer/chat/chat-cards.ts`
- Modify: `src/renderer/chat/chat-items.ts` (`card` drawn by `chat-cards.ts`), `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`, `tests/fixtures/fake-claude/fake-claude.ts` and `install.ts` (step `{ asks: { tool: string; input: Record<string, unknown> }[] }`: every `can_use_tool` request at once, then waits for all answers)
- Test: `tests/e2e/chat-cards.spec.ts`

**Interfaces:**
- Produces: `export function renderCard(item: Extract<ChatItem, { kind: 'card' }>, cb: { answer(cardId: string, a: ChatAnswer): void; revealChange(path: string): void }): HTMLElement` and in `ChatView` the card focus rules below.

Rules:
- Only the oldest unanswered card is active; later ones show folded under it as `1 more question waiting` and become active in turn (Review Focus 1).
- When a card becomes active: if the composer is focused and has a draft, the card does not take the focus: the composer pulses (`pulse(true)`) and Tab from the composer moves the focus to the card; otherwise the card's first control takes the focus. Key events are handled by the element that has the focus only; the composer's handlers never call a card, and a card ignores key events whose target is outside it.
- Question card (the Main board): header `Claude has a question` with one tab per question when several; the question; the options in a two-column grid, each a button with its label, description and number; multi-select questions have checkboxes; `Or type your own answer…` input; the hint; `Skip` (moves on without an answer for that question), `Next`, `Submit` on the last. Digits 1–n pick, Enter confirms the picked or typed answer, Esc dismisses the card → `{ type: 'question', answers: null }`. The answers go as `{ [question]: label | labels[] | typed text }`.
- Permission card (the Approve board): the title; for an edit, a diff preview of `diff` drawn as the Changes panel's lines (removed `#F2867E` on its red tint, added `#63C08F` on its green tint, monospace, at most 300 px high, scrolls) with the path as a button calling `revealChange`; for a command, the command in monospace with its description; `Allow once` (badge `1`), one button per suggestion (badges `2`, `3`…), `Deny` (badge `Esc`); the `Tell Claude what to do instead…` input: Enter in it denies with its text. Focus starts on `Allow once`, or on `Deny` when `defaultToNo` (and the digit shortcuts are off then). Enter takes the focused button.
- Plan card: the plan as Markdown (`chatMarkdownHtml`), at most 50 % of the column's height, scrolling; the three buttons; the box: Enter in it keeps planning with its text.
- Dialog card: none in part 2 — plan 1's Task 11 turns every dialog into a notice with **Open in the terminal**, and `renderCard` keeps plan 1's one quiet line for a `dialog` card.
- An answered card collapses to its `answered` line.

- [ ] **Step 1: Write the failing e2e tests:** `'a question is answered with the keyboard'` (press `2`, Enter → stand-in log holds the `can_use_tool` response with `answers` `{ <question>: <option 2 label> }`); `'a multi-select question sends every picked label'`; `'Esc dismisses a question'`; `'Allow once allows; a suggestion allows for the session'` (log holds `updatedPermissions`); `'Deny with a message tells Claude what to do instead'`; `'a defaultToNo request starts on Deny and ignores 1'`; `'approve a plan and accept edits'`; `'a stray Enter in the composer never answers a card'` (Review Focus 2: type `hello`, the card arrives, press Enter → the log has the user message `hello` queued and no `can_use_tool` response; the composer pulses; Tab focuses the card); `'two asks wait in order'`; `'an answered card is one line'`.
- [ ] **Step 2: Run** the spec through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, and `tests/e2e/chat.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 5: the slash menu, `/model`, `/resume`, `@`, and opening in the terminal

**Files:**
- Create: `src/renderer/chat/slash-menu.ts`, `src/renderer/chat/model-picker.ts`, `src/renderer/chat/file-picker.ts`
- Modify: `src/renderer/chat/chat-composer.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`, `src/renderer/main.ts`, `src/renderer/recent-sessions.ts` (an optional pick callback), `tests/fixtures/fake-claude/fake-claude.ts` and `install.ts` (script options `commands?: { name: string; description: string; argumentHint: string; builtin?: boolean }[]`, `terminalCommands?: string[]`, `models?: { value: string; displayName: string; description: string; supportedEffortLevels?: string[] }[]` — used in `init`, `supportedCommands` and `supportedModels` answers instead of the recorded lists)
- Test: `tests/e2e/chat-slash.spec.ts`, `tests/unit/slash-route.test.ts`

**Interfaces:**
- Produces:

```ts
export type SlashRoute = { to: 'native'; name: 'model' | 'resume' } | { to: 'terminal'; line: string } | { to: 'send'; text: string }
/** where a composer text that starts with / or ! goes */
export function routeSlash(text: string, commands: ChatCommandInfo[]): SlashRoute     // pure, exported for a unit test
export class SlashMenu { constructor(anchor: HTMLElement, o: { commands(): Promise<ChatCommandInfo[]>; complete(text: string): void; run(name: string): void }); update(query: string): void; key(e: KeyboardEvent): boolean; close(): void }
export class ModelPicker { constructor(o: { models(): Promise<ChatModelInfo[]>; current(): { model: string | null; effort: string | null }; apply(model: string, effort: string | null): void }); open(anchor: HTMLElement): void; close(): void }
export class FilePicker { constructor(o: { files(query: string): Promise<string[]>; pick(path: string): void }); open(anchor: HTMLElement, query: string): void; update(query: string): void; key(e: KeyboardEvent): boolean; close(): void }
// RecentSessionsWindow.open(pick?: (session: RecentSession) => void): with pick, choosing a session calls it instead of opening a tab
```

Rules:
- `routeSlash`: `/model` (no arguments) → native model; `/resume` → native resume; a name `terminal: true` in the commands, or one of `config`, `permissions`, `agents`, `login`, `logout`, `doctor`, `rewind`, `terminal-setup`, `ide`, `vim`, `statusline`, `exit`, or a text starting with `!` → terminal with the whole text as the line; everything else → send. A command answered with `… isn't available in this environment.` (the notice the model draws from a `command` / error result, its exact text in `tests/fixtures/chat/README.md` finding (f)) offers `Open in the terminal` on that notice, which runs `chatOpenInTerminal(tabId, '/<name> <args>')`.
- Slash menu (the Slash board): above the composer; the count line and the hint; groups in the order Claude Code, This project, Plugins and skills (a plugin entry shows its `source` on the right); each row: `/name`, its argument hint in `#8C8C96`, its description, the tag for terminal commands; the typed letters highlighted (`<mark>` on the matching subsequence, built with DOM nodes); ↑↓ move, Tab completes `/name ` into the composer, Enter runs the selected command (or completes it and waits when it has an argument hint), Esc closes.
- `/model` picker: the session's models with descriptions, the current one checked; an effort row (the model's `efforts`; hidden when empty); Apply → `chatSetModel(tabId, model, effort)`.
- `/resume`: `RecentSessionsWindow.open(pick)`; pick → `ct.chatResume(tabId, s.id, s.cwd)`.
- Terminal routes: when `state.turn !== 'idle'` the text stays in the composer and the notice `<what> opens in the terminal once Claude finishes` shows; when the turn ends it runs. When the status lists background tasks, the switch's question of plan 1 comes first. Running → `ct.chatOpenInTerminal(tabId, line)`; `what` = the command's first word (`/config`, `!npm test` → `!npm`).
- `@` picker: under the caret, `ct.chatFiles(tabId, query)` as the user types after `@`, ↑↓ Enter / Tab to insert `@path ` (quoted when it has a space), Esc closes.

- [ ] **Step 1: Write the failing tests:** unit `tests/unit/slash-route.test.ts` for `routeSlash` (each rule row); e2e: `'/ opens the menu, filters, and Enter runs /context'` (count line `2 commands match "co"` for a stand-in command list of `/context`, `/compact`, `/config` — `/config` tagged; the stand-in log holds the user message `/context`); `'Tab completes a command with arguments and waits'`; `'/model picks a model and effort'` (log holds `set_model` and the effort flag settings); `'/config opens in the terminal and runs there'` (the terminal shows `you said: /config`; the chat shows `Opened /config in the terminal` after switching back); `'a terminal command while Claude works waits for the turn'` (Review Focus 4); `'! commands run in the terminal'`; `'/resume opens a session of this folder here, another folder's in a new tab'` (Review Focus 5); `'@ inserts a project file'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/slash-route.test.ts` and the e2e spec through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** them, plus `tests/e2e/recent-sessions.spec.ts` through the lock. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 6: the status bar, Send and auto-continue in chat view

**Files:**
- Modify: `src/renderer/status-bar.ts`, `src/renderer/main.ts`, `tests/fixtures/fake-claude/fake-claude.ts` and `install.ts` (script option `contextPct?: number` for the `get_context_usage` answer, step `{ rateLimit: { type: 'five_hour' | 'seven_day'; utilization: number; resetsAt: number; status?: 'allowed' | 'rejected' } }` emitting a `rate_limit_event` shaped as recorded)
- Test: `tests/e2e/chat-status.spec.ts`; `tests/e2e/chat-wiring.spec.ts` (plan 1's `'a chat tab reports the model Claude Code started with'` now expects `#statusbar .status-model` count 0 in chat view: rename it `'a chat tab's status bar leaves the model to the composer'`). Send from a panel in chat view is plan 1's test (`chat.spec.ts`).

**Interfaces:**
- Produces: `StatusBar.render(u, changes, account, plan, now, chat?: { stopTask(taskId: string): void })` — with `chat`, the model segment is left out and the background segment opens a list on click: one row per task (its name as the bar names it) with a ✕ button titled `Stop this task` calling `stopTask(id)`.

Rules: `renderStatus` passes `chat` for a chat-view tab (`ct.chatStopTask`); the title bar's limit meters come from the same `StatusUpdate` as before (plan 1 fed it from the stream).

- [ ] **Step 1: Write the failing e2e tests:** `'in chat view the status bar has no model pill and shows the context'` (the stand-in answers `get_context_usage` with 42 % → the context segment shows `42%`); `'a background task can be stopped from the status bar'` (a pipe `background` report with one task → ✕ → the stand-in log holds `stop_task` with its id; Esc during a turn does not send `stop_task`); `'the title bar shows the limits the stream reported'` (a scripted `rate_limit_event`); `'a cut-off answer is continued in chat view'` (`claude.autoContinue: true`, a pipe `turn` end with the dropped-connection error → after the continue delay the stand-in log holds the user message `CONTINUE_PROMPT`).
- [ ] **Step 2: Run** the spec through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, and `tests/e2e/status.spec.ts tests/e2e/auto-continue.spec.ts tests/e2e/review.spec.ts` through the lock (the terminal view unchanged), `npm run typecheck`, `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.
