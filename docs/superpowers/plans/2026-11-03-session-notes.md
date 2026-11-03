# Session Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude tab gets a plain-text note shown over the terminal as a translucent label or card, kept with the tab's conversation across `/clear`, `/resume`, restart, Restore and Recent sessions.

**Architecture:** Main keeps the notes: `SessionNotes` stores them by Claude session id in `session-notes.json`, `NoteHub` holds each Claude tab's note and applies the rules when a tab's conversation changes. The renderer draws the note (`NoteOverlay`, a layer inside `#terminals`), sends every edit and view change to main, and gets a tab's note from main only when it comes with a conversation (`ev:note`).

**Tech Stack:** Electron 44, TypeScript (strict), plain DOM renderer, Vitest (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-03-session-notes-design.md`

## Global Constraints

- Notes exist only for Claude tabs; shell tabs get no Note button and no note.
- Stored only in ClaudeTerm's data folder, `session-notes.json`, keyed by Claude session id; nothing is written to Claude Code's folders.
- `MAX_NOTE_LENGTH = 100_000` characters. A note whose text is empty or only whitespace is no note: not stored, no label, no mark.
- The file and every IPC argument are untrusted: validated, bad entries dropped, never fatal.
- Showing, collapsing, opening or hiding a note never changes the terminal's size.
- UI strings, exactly: button tooltip `Note (Ctrl+Shift+N)` / `Note (⌘N)`; card header `Note`; placeholder `Write a note for this session…`; label tooltip `Show the note`; `–` tooltip `Collapse to a label`; `×` tooltip `Hide the note`; tab mark tooltip `Has a note`.
- Shortcut: Ctrl+Shift+N on Windows and Linux, ⌘N on macOS, matched by `KeyboardEvent.code` (`KeyN`).
- AGENTS.md applies: strict TS with `noUnusedLocals`, English comments, match the surrounding code, keep line endings, tests never touch the real `~/.claude` or `%APPDATA%\ClaudeTerm`, Conventional Commits. Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Typing a multi-line note quickly: the textarea must hold exactly what was typed. Main never echoes the renderer's own edits back, so nothing rewrites the textarea under the caret (test in Task 4).
- Closing the window right after typing: the debounced save is flushed on window close, before quit and before an update install (test in Task 3).
- A corrupt or hand-edited `session-notes.json`: the app starts, keeps the valid entries and drops the rest (test in Task 1).
- Switching between two Claude tabs with different notes: the card shows the active tab's text, never the previous tab's (test in Task 4).
- The side panel lying over the terminal (overlay mode, a maximized window): the note moves left of the panel instead of hiding under it (test in Task 4).

---

### Task 1: The note type and its file

**Files:**
- Create: `src/shared/note.ts`
- Create: `src/main/session-notes.ts`
- Test: `tests/unit/session-notes.test.ts`

**Interfaces:**
- Produces, in `src/shared/note.ts`:
  - `export type NoteForm = 'label' | 'card'`
  - `export interface Note { text: string; shown: boolean; form: NoteForm }` — `form` is kept while the note is hidden
  - `export const NOTE_FORMS: readonly NoteForm[] = ['label', 'card']`
  - `export const MAX_NOTE_LENGTH = 100_000`
  - `export const hasText = (note: Note | null | undefined): boolean` — true when the text has a non-whitespace character
- Produces, in `src/main/session-notes.ts`:
  - `export function parseNotes(text: string): Map<string, Note> | null` — null when the text is not JSON or not a JSON object (an array is not an object)
  - `export class SessionNotes { readonly path: string; constructor(dir: string, opts?: { debounceMs?: number; onError?(message: string): void }); get(sessionId: string): Note | null; set(sessionId: string, note: Note | null): void; flush(): void }`

- [ ] **Step 1: Write the failing tests** in `tests/unit/session-notes.test.ts` (temp dirs with `mkdtempSync`, session ids are UUIDs as in `session-store.test.ts`):

```ts
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const note = (text: string, shown = true, form: NoteForm = 'card'): Note => ({ text, shown, form })

it('parseNotes reads valid entries and drops the rest', () => {
  const raw = {
    [SID]: note('Goal: payments', false, 'label'),
    'not-a-uuid': note('x'),
    [SID2]: { text: 5, shown: true, form: 'card' },
    'a3c2cf68-2929-4166-9a00-000000000001': { text: 'x', shown: 'yes', form: 'card' },
    'a3c2cf68-2929-4166-9a00-000000000002': { text: 'x', shown: true, form: 'big' },
    'a3c2cf68-2929-4166-9a00-000000000003': note('x'.repeat(MAX_NOTE_LENGTH + 1)),
    'a3c2cf68-2929-4166-9a00-000000000004': note('   \n ')
  }
  expect(parseNotes(JSON.stringify(raw))).toEqual(new Map([[SID, note('Goal: payments', false, 'label')]]))
})
it('parseNotes answers null for text that is not a JSON object', () => {
  expect(parseNotes('{')).toBeNull()
  expect(parseNotes('[]')).toBeNull()
  expect(parseNotes('null')).toBeNull()
})
it('set and flush write the file; a new store reads it back', () => {
  const dir = newDir()
  const a = new SessionNotes(dir)
  a.set(SID, note('one\ntwo', true, 'label'))
  a.flush()
  expect(new SessionNotes(dir).get(SID)).toEqual(note('one\ntwo', true, 'label'))
})
it('a note without text is removed, not stored', () => {
  const dir = newDir()
  const a = new SessionNotes(dir)
  a.set(SID, note('x'))
  a.set(SID, note('  '))
  a.set(SID2, note('y'))
  a.set(SID2, null)
  a.flush()
  expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual({})
})
it('saves once after the debounce, and flush writes at once', () => {
  vi.useFakeTimers()
  const a = new SessionNotes(newDir(), { debounceMs: 500 })
  a.set(SID, note('x'))
  expect(existsSync(a.path)).toBe(false)
  vi.advanceTimersByTime(500)
  expect(existsSync(a.path)).toBe(true)
})
it('a corrupt file is reported and ignored; a missing file is not reported', () => {
  const dir = newDir()
  const errors: string[] = []
  new SessionNotes(dir, { onError: (m) => errors.push(m) })
  expect(errors).toEqual([])
  writeFileSync(join(dir, 'session-notes.json'), '{oops')
  const b = new SessionNotes(dir, { onError: (m) => errors.push(m) })
  expect(errors).toEqual([`ignoring corrupt ${b.path}`])
  expect(b.get(SID)).toBeNull()
})
it('get answers a copy', () => {
  const a = new SessionNotes(newDir())
  a.set(SID, note('x'))
  a.get(SID)!.text = 'changed'
  expect(a.get(SID)!.text).toBe('x')
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/session-notes.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write `src/shared/note.ts` and `src/main/session-notes.ts`**

`SessionNotes` follows `StarredSessions` (`src/main/starred-sessions.ts`) for loading (ENOENT silent, other read errors `cannot read <path>: <message>`, corrupt `ignoring corrupt <path>`) and saving (write `<path>.tmp`, rename over `<path>`, errors `cannot save <path>: <message>` to `onError`), and `SessionStore.scheduleSave`/`flush` for the debounce (default 500 ms). `path` is `join(dir, 'session-notes.json')`. Entries are validated with `isUuid` from `src/shared/protocol`, `hasText` and `MAX_NOTE_LENGTH`.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/unit/session-notes.test.ts` — Expected: PASS. Then `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/note.ts src/main/session-notes.ts tests/unit/session-notes.test.ts
git commit -m "feat: a file keeps session notes by conversation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Each Claude tab's note, and what happens when its conversation changes

**Files:**
- Create: `src/main/note-hub.ts`
- Test: `tests/unit/note-hub.test.ts`

**Interfaces:**
- Consumes: `Note`, `NoteForm`, `hasText` from `src/shared/note.ts`; `SessionNotes.get/set` (Task 1).
- Produces, in `src/main/note-hub.ts`:
  - `export interface NoteHubDeps { store: Pick<SessionNotes, 'get' | 'set'>; publish(tabId: string, note: Note | null): void }` — `publish` tells the renderer a tab's note that came from main (a stored one), never an echo of the renderer's own edits
  - `export class NoteHub { constructor(deps: NoteHubDeps); addTab(tabId: string, sessionId: string | null): void; removeTab(tabId: string): void; session(tabId: string, sessionId: string): void; get(tabId: string): Note | null; setText(tabId: string, text: string): void; setView(tabId: string, shown: boolean, form: NoteForm): void }`

Rules (the spec's "The tab's note"):
- `addTab` with a session id that has a stored note: the tab takes it and `publish` is called with it. Otherwise the tab starts with no note and nothing is published.
- `setText` / `setView` on a tab the hub does not know (a shell tab, a closed tab) do nothing. On a tab without a note they start from `{ text: '', shown: false, form: 'card' }`. A tab with a session id writes its note to the store on every change (`store.set(id, note)`, which drops a note without text); a tab without one keeps it in memory.
- `session(tabId, newId)`: same id → nothing. The new id has a stored note → the tab takes it and it is published; the tab's own note stays stored under the old id. Otherwise → the tab's note (if any) is stored under the new id and removed from the old one. The tab's id becomes `newId` either way.
- `removeTab` forgets the tab; the stored entry under its last id stays as it is.

- [ ] **Step 1: Write the failing tests** in `tests/unit/note-hub.test.ts`, with a fake store and a recorded publish:

```ts
const A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
function setup(stored: Record<string, Note> = {}) {
  const store = new Map(Object.entries(stored))
  const published: [string, Note | null][] = []
  const hub = new NoteHub({
    store: { get: (id) => store.get(id) ?? null, set: (id, n) => { if (n && hasText(n)) store.set(id, { ...n }); else store.delete(id) } },
    publish: (tabId, n) => published.push([tabId, n])
  })
  return { hub, store, published }
}
const alpha: Note = { text: 'alpha', shown: true, form: 'label' }

it('a tab opened in a conversation with a note takes it and tells the renderer', () => {
  const { hub, published } = setup({ [A]: alpha })
  hub.addTab('t1', A)
  expect(hub.get('t1')).toEqual(alpha)
  expect(published).toEqual([['t1', alpha]])
})
it('a tab without a note publishes nothing', () => {
  const { hub, published } = setup()
  hub.addTab('t1', A)
  hub.addTab('t2', null)
  expect(published).toEqual([])
  expect(hub.get('t1')).toBeNull()
})
it('text and view are stored under the conversation; erasing the text removes the entry', () => {
  const { hub, store, published } = setup()
  hub.addTab('t1', A)
  hub.setView('t1', true, 'card')
  expect(store.has(A)).toBe(false)
  hub.setText('t1', 'Goal')
  expect(store.get(A)).toEqual({ text: 'Goal', shown: true, form: 'card' })
  hub.setView('t1', true, 'label')
  expect(store.get(A)?.form).toBe('label')
  hub.setText('t1', '  ')
  expect(store.has(A)).toBe(false)
  expect(published).toEqual([])
})
it('a note written before the conversation is known is stored once it is', () => {
  const { hub, store } = setup()
  hub.addTab('t1', null)
  hub.setText('t1', 'early')
  expect(store.size).toBe(0)
  hub.session('t1', A)
  expect(store.get(A)?.text).toBe('early')
})
it('a tab closed before its conversation was known takes its note with it', () => {
  const { hub, store } = setup()
  hub.addTab('t1', null)
  hub.setText('t1', 'lost')
  hub.removeTab('t1')
  expect(store.size).toBe(0)
})
it('/clear: the note moves to the new conversation and leaves the old one', () => {
  const { hub, store, published } = setup()
  hub.addTab('t1', A)
  hub.setText('t1', 'mine')
  hub.session('t1', B)
  expect(store.has(A)).toBe(false)
  expect(store.get(B)?.text).toBe('mine')
  expect(hub.get('t1')?.text).toBe('mine')
  expect(published).toEqual([])
})
it('/resume into a conversation with a note: the tab takes it, the one it left keeps the tab\'s own', () => {
  const { hub, store, published } = setup({ [A]: alpha })
  hub.addTab('t1', B)
  hub.setText('t1', 'beta')
  hub.session('t1', A)
  expect(hub.get('t1')).toEqual(alpha)
  expect(published).toEqual([['t1', alpha]])
  expect(store.get(B)?.text).toBe('beta')
  expect(store.get(A)).toEqual(alpha)
})
it('the same conversation again changes nothing', () => {
  const { hub, store, published } = setup()
  hub.addTab('t1', A)
  hub.setText('t1', 'x')
  hub.session('t1', A)
  expect(store.get(A)?.text).toBe('x')
  expect(published).toEqual([])
})
it('closing a tab keeps its note with the conversation; unknown tabs are ignored', () => {
  const { hub, store } = setup()
  hub.addTab('t1', A)
  hub.setText('t1', 'kept')
  hub.removeTab('t1')
  expect(hub.get('t1')).toBeNull()
  expect(store.get(A)?.text).toBe('kept')
  hub.setText('shell', 'x')
  hub.setView('shell', true, 'card')
  expect(store.size).toBe(1)
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/note-hub.test.ts` — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write `src/main/note-hub.ts`** to the rules above. The hub keeps `Map<tabId, { sessionId: string | null; note: Note | null }>` and hands out copies.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run tests/unit/note-hub.test.ts` — Expected: PASS. `npm run typecheck` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/note-hub.ts tests/unit/note-hub.test.ts
git commit -m "feat: a Claude tab's note follows it across /clear and /resume" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Main keeps the notes: wiring, IPC, preload

**Files:**
- Modify: `src/shared/ipc.ts` (channels and `CtApi`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc-guards.ts`
- Modify: `src/main/index.ts`
- Modify: `tests/e2e/helpers.ts` (a transcript writer)
- Test: `tests/unit/ipc-guards.test.ts`, `tests/e2e/notes.spec.ts`

**Interfaces:**
- Consumes: `SessionNotes` (Task 1), `NoteHub` (Task 2), `Note`, `NoteForm`, `NOTE_FORMS`, `MAX_NOTE_LENGTH`.
- Produces:
  - `IPC.notesSetText = 'notes:set-text'`, `IPC.notesSetView = 'notes:set-view'`, `IPC.evNote = 'ev:note'`
  - `CtApi.setNoteText(tabId: string, text: string): void`
  - `CtApi.setNoteView(tabId: string, shown: boolean, form: NoteForm): void`
  - `CtApi.onNote(cb: (tabId: string, note: Note | null) => void): Unsubscribe`
  - `isNoteText(v: unknown): v is string` (a string of at most `MAX_NOTE_LENGTH`), `isNoteForm(v: unknown): v is NoteForm` in `ipc-guards.ts`
  - `writeTranscript(config: string, cwd: string, id: string): void` in `tests/e2e/helpers.ts` — writes `<config>/projects/<cwd with every non-alphanumeric char as ->/<id>.jsonl` holding one interactive user entry (`{ type: 'user', cwd, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: 'hello' } }`), so Recent sessions lists it

- [ ] **Step 1: Write the failing tests**

In `tests/unit/ipc-guards.test.ts`:

```ts
it('isNoteText accepts strings up to MAX_NOTE_LENGTH', () => {
  expect(isNoteText('')).toBe(true)
  expect(isNoteText('x'.repeat(MAX_NOTE_LENGTH))).toBe(true)
  expect(isNoteText('x'.repeat(MAX_NOTE_LENGTH + 1))).toBe(false)
  expect(isNoteText(5)).toBe(false)
})
it('isNoteForm accepts label and card only', () => {
  expect(isNoteForm('label')).toBe(true)
  expect(isNoteForm('card')).toBe(true)
  expect(isNoteForm('hidden')).toBe(false)
  expect(isNoteForm(null)).toBe(false)
})
```

`tests/e2e/notes.spec.ts` drives main through `window.ct` and the pipe, the way `restore.spec.ts` does (`sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source, transcriptPath: null })`; a local `closeWindow(app)` as in `restore.spec.ts`). Notes main sends are recorded in the page before the step that sends them:

```ts
const record = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { notes: [string, Note | null][] }
  w.notes = []
  window.ct.onNote((id, n) => { w.notes.push([id, n]) })
})
const recorded = (page: Page) => page.evaluate(() => (window as unknown as { notes: [string, Note | null][] }).notes)
const notesFile = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, 'session-notes.json'), 'utf8'))
```

Tests (SID_A, SID_B are fixed UUIDs):
1. `a note written in a Claude tab is kept with its conversation, even when the window closes right after` — `launchClaudeTab()`; session `SID_A` (`startup`); `ct.setNoteText(tabId, 'Goal: payments')`, `ct.setNoteView(tabId, true, 'label')`; `closeWindow` at once; `notesFile(dataDir)` equals `{ [SID_A]: { text: 'Goal: payments', shown: true, form: 'label' } }`.
2. `Restore gives a restored tab the note of its conversation` — a data dir with `session-state.json` holding one Claude tab in `SID_A` (as `snapshotFile` in `restore.spec.ts`) and `session-notes.json` `{ [SID_A]: { text: 'alpha', shown: true, form: 'card' } }`; `record`; click `.banner-restore`; `expect.poll(recorded)` equals `[[restoredTabId, { text: 'alpha', shown: true, form: 'card' }]]`.
3. `a closed tab's note comes back when Recent sessions reopens its conversation` — `writeTranscript(config, work, SID_A)`; `launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: { CLAUDE_CONFIG_DIR: config } })`; session `SID_A`; `setNoteText(tabId, 'kept')`; open a shell tab (so the window stays); `ct.closeTab(tabId)`; `await ct.listSessions()`; `record`; `ct.openSession(SID_A)`; the new tab's recorded note has text `kept`.
4. `/clear: the tab keeps its note, now under the new conversation` — session `SID_A`, note `mine`; `record`; session `SID_B` with source `clear`; `recorded` is `[]`; `closeWindow`; `notesFile` equals `{ [SID_B]: { text: 'mine', shown: false, form: 'card' } }`.
5. `/resume into a conversation with a note: the tab shows that note, the one it left keeps the tab's own` — data dir with `session-notes.json` `{ [SID_A]: alpha }`; `launchApp({ dataDir, args: ['--claude', work] })`; session `SID_B`; note `beta`; `record`; session `SID_A` with source `resume`; `recorded` equals `[[tabId, alpha]]`; `closeWindow`; `notesFile` has `SID_A` → alpha and `SID_B` → text `beta`.
6. `what is sent for a shell tab is not kept` — `launchApp({ settings: FAKE_CLAUDE_SETTINGS })` (a shell tab); `setNoteText(shellTabId, 'x')`; `closeWindow`; `session-notes.json` does not exist.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/ipc-guards.test.ts` — FAIL (guards missing). `npm run build && npx playwright test tests/e2e/notes.spec.ts` — FAIL (`window.ct.setNoteText` is not a function).

- [ ] **Step 3: Add the channels, `CtApi` members (with doc comments), preload entries and guards**

Preload: `setNoteText: (id, text) => ipcRenderer.send(IPC.notesSetText, id, text)`, `setNoteView: (id, shown, form) => ipcRenderer.send(IPC.notesSetView, id, shown, form)`, `onNote: (cb) => on(IPC.evNote, cb)`.

- [ ] **Step 4: Wire main in `src/main/index.ts`**
- Next to `starred`: `const notes = new SessionNotes(dataDir, { onError: (m) => log.warn(m) })` and `const noteHub = new NoteHub({ store: notes, publish: (tabId, note) => send(IPC.evNote, tabId, note) })`.
- `onTabStarted`: also `noteHub.addTab(tab.id, tab.claudeSessionId)` for a Claude tab (`events.opened` has already reached the renderer then).
- `onTabClosed`: also `noteHub.removeTab(tabId)`.
- The pipe's `session` handler, after `setClaudeSession` succeeds: `noteHub.session(msg.tabId, msg.sessionId)`.
- `ipcMain.on(IPC.notesSetText, (_e, id: unknown, text: unknown) => { if (isId(id) && isNoteText(text)) noteHub.setText(id, text) })` and the same for `notesSetView` with `isFlag(shown) && isNoteForm(form)`.
- `notes.flush()` wherever `sessions.flush()` runs: `win.on('close')`, `before-quit`, and the updater's `beforeInstall`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `npx vitest run tests/unit/ipc-guards.test.ts` — PASS. `npm run build && npx playwright test tests/e2e/notes.spec.ts` — PASS. `npm run typecheck` — no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/ipc-guards.ts src/main/index.ts tests/unit/ipc-guards.test.ts tests/e2e/helpers.ts tests/e2e/notes.spec.ts
git commit -m "feat: main keeps each Claude tab's note with its conversation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The note over the terminal, the Note button and the shortcut

**Files:**
- Create: `src/renderer/note-overlay.ts`
- Modify: `src/renderer/keymap.ts`, `src/renderer/tabbar.ts`, `src/renderer/side-panel.ts:183-195` (`apply`), `src/renderer/main.ts`, `src/renderer/index.html`, `src/renderer/styles.css`
- Modify: `tests/e2e/helpers.ts` (`KEYS.note`, `KEY_LABELS.note`)
- Modify: `README.md`
- Test: `tests/unit/keymap.test.ts`, `tests/e2e/note-overlay.spec.ts`

**Interfaces:**
- Consumes: `CtApi.setNoteText`, `setNoteView`, `onNote` (Task 3); `Note`, `NoteForm`, `hasText`, `MAX_NOTE_LENGTH` (Task 1).
- Produces:
  - `KeyAction` gains `{ type: 'toggleNote' }`; `LABELS.toggleNote = ['Ctrl+Shift+N', '⌘N']`
  - `export function noteIcon(size: number): string` in `note-overlay.ts` — the sticky-note SVG, exactly: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M2.65 2.65h10.7v7.2l-3.5 3.5h-7.2z"/><path d="M9.85 13.35v-3.5h3.5"/><path d="M5 6h6M5 8.5h3.5"/></svg>`
  - `export interface NoteOverlayCallbacks { setText(tabId: string, text: string): void; setView(tabId: string, shown: boolean, form: NoteForm): void; focusTerminal(): void; changed(): void }` — `changed`: a note got or lost its text, or was shown or hidden
  - `export class NoteOverlay { constructor(root: HTMLElement, cb: NoteOverlayCallbacks, platform: string); set(tabId: string, note: Note | null): void; show(tabId: string | null, claude: boolean): void; toggle(): void; hasText(tabId: string): boolean; isShown(): boolean; dropTab(tabId: string): void }`
  - `TabBarItem.note: boolean`; `TabBarCallbacks.toggleNote(): void`; `TabBar.setNote(available: boolean, visible: boolean): void`
  - DOM, for the tests: `#note` (inside `#terminals`), `.note-label` with `.note-label-text`, `.note-card` with `.note-collapse`, `.note-hide`, `textarea.note-text`; the button `#tabbar .tab-note-toggle` (class `active` while the note is shown); the mark `.tab .tab-note`

Behavior of `NoteOverlay` (the spec's "What the user sees"):
- It keeps a `Note` per tab (from `set`, and from the user's edits), draws only the active Claude tab's, and sends every change with `setText` / `setView`.
- `toggle()`: hidden → shown in its kept form; a note without text shows as the card with the keyboard in its text. Shown → hidden; if the keyboard was in the note it goes back to the terminal.
- A click on the label → the card, keyboard in the text at its end. `–` → the label, or hidden when there is no text. `×` → hidden.
- Typing → `setText` on every input; the label's text is the first non-empty line, trimmed. `changed()` whenever `hasText` flips or the note is shown or hidden.
- In the textarea, Esc gives the keyboard to the terminal (the card stays), and the note shortcut (`mapKey(e, platform)?.type === 'toggleNote'`) hides the note; other keys stay in the textarea.
- `show(tabId, claude)`: the tab being left, if its note has no text and is shown, becomes hidden (and `setView` is sent). A shell tab or no tab draws nothing.
- `set` for the active tab redraws; it never rewrites the textarea while the user is typing in it for that same tab (main does not echo, so `set` arrives only with a conversation).

Styles (`styles.css`, after the side panel rules): `#note` is `position: absolute; top: 10px; right: calc(14px + var(--panel-cover, 0px)); z-index: 5`. The label and the card: `background: color-mix(in srgb, var(--chrome-2) 85%, transparent)`, `backdrop-filter: blur(3px)`, `border: 1px solid var(--border)`, `opacity: 0.8`; `opacity: 1` and a 97% background on `:hover` and `:focus-within`; the UI font. Card `width: 300px`, the whole card at most `40%` of `#terminals`' height with the textarea growing to its content and scrolling past that; label `max-width: 280px`, one line with an ellipsis. `.tab-note` like `.tab-muted`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/keymap.test.ts`, in the Windows/Linux `describe.each`: `expect(map(k('KeyN', cs, 'Т'))).toEqual({ type: 'toggleNote' })`; in the macOS block: `expect(mapKey(k('KeyN', cmd), 'darwin')).toEqual({ type: 'toggleNote' })`; and `expect(shortcutLabel('toggleNote', 'win32')).toBe('Ctrl+Shift+N')`, `expect(shortcutLabel('toggleNote', 'darwin')).toBe('⌘N')`.

`tests/e2e/helpers.ts`: `KEYS.note` = `'Meta+KeyN'` on macOS, `'Control+Shift+KeyN'` elsewhere; `KEY_LABELS.note` = `'⌘N'` / `'Ctrl+Shift+N'`.

`tests/e2e/note-overlay.spec.ts` (`launchClaudeTab()` unless said otherwise; `card = page.locator('#note .note-card')`, `label = page.locator('#note .note-label')`, `text = card.locator('.note-text')`, `button = page.locator('#tabbar .tab-note-toggle')`, `mark = page.locator('#tabbar .tab .tab-note')`):
1. `the Note button opens an empty card to write in, and typing marks the tab` — `button` has title `` `Note (${KEY_LABELS.note})` `` and no class `active`; click it → `card` visible, `text` focused, placeholder `Write a note for this session…`, `button` has class `active`; `page.keyboard.type('Goal: payments\nTODO: tests\n— no export.py')` → `text` has value `'Goal: payments\nTODO: tests\n— no export.py'` exactly; `mark` count 1 with title `Has a note`.
2. `– collapses the note to a label with its first line, a click opens it, × hides it, and the button brings back the last form` — open the empty card and click `.note-collapse` → hidden (no text, no label); open it again and type `'\n  Goal: payments\nTODO'`: click `.note-collapse` → `label` visible with `.note-label-text` text `Goal: payments`, `card` hidden; click `label` → `card` visible, `text` focused; click `.note-hide` → neither visible, `button` not `active`; click `button` → `card` (its last form); click `.note-collapse`, then `button` → hidden; click `button` → `label` (its last form).
3. `the shortcut does what the button does; Esc in the note gives the keyboard back to the terminal` — click the terminal, press `KEYS.note` → `card` visible and `text` focused; type `x`; press `Escape` → `card` still visible, `text` not focused, the focused element is inside `.xterm`; press `KEYS.note` → hidden; press `KEYS.note` → `card`; click `text`, press `KEYS.note` → hidden.
4. `a shell tab has no Note button, and the shortcut does nothing there` — `launchApp({ settings: FAKE_CLAUDE_SETTINGS })`; `button` hidden; click the terminal, press `KEYS.note` → `#note` has no visible child.
5. `erasing the text removes the mark; the empty card goes once the tab is left` — type `x`, mark count 1; `text.fill('')` → mark count 0, `card` still visible; open a second Claude tab (`ct.openTab({ kind: 'claude', cwd: work })`), activate the first again (`ct.activateTab`) → `card` hidden.
6. `each Claude tab shows its own note` — tab 1 note `one`, open Claude tab 2, its card (via `button`) is empty, type `two`; activate tab 1 → `text` value `one`; activate tab 2 → `two`.
7. `showing, collapsing and hiding the note leaves the terminal its size` — read `window.__ct!.ptySizes!(tabId)` after the tab settled; open, type, collapse, open, hide; wait 500 ms; `ptySizes` unchanged.
8. `a restored tab shows its note as it was left` — data dir with `session-state.json` (a Claude tab in `SID_A`) and `session-notes.json` `{ [SID_A]: { text: 'Goal: payments\nTODO', shown: true, form: 'label' } }`; click `.banner-restore` → `label` visible with text `Goal: payments`, `mark` count 1, `button` has class `active`.
9. `with the side panel lying over the terminal, the note sits left of it` — skip like `side-panel.spec.ts` does when there is no window manager; settings `{ ...FAKE_CLAUDE_SETTINGS, sidePanel: { noRoom: 'overlay' }, imagePanel: { autoOpen: false } }`; maximize the window as `side-panel.spec.ts` does; open the note and type `x`; press `KEYS.images`; poll until the card's bounding box `x + width` is at most `#image-panel`'s `x`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/keymap.test.ts` — FAIL. `npm run build && npx playwright test tests/e2e/note-overlay.spec.ts` — FAIL (no `.tab-note-toggle`).

- [ ] **Step 3: `keymap.ts`** — `toggleNote` on `KeyN` with Ctrl+Shift (Windows, Linux) and ⌘ alone (macOS), and its label.

- [ ] **Step 4: `tabbar.ts`** — the Note button built once in the constructor like the Media and Changes buttons (`createToggle('tab-note-toggle', `Note (${shortcutLabel('toggleNote', platform)})`, …, noteIcon(16))`, no badge), placed after the Media button; `setNote(available, visible)` hides it for a shell tab and sets `active`; `renderTab` adds `<span class="tab-note" title="Has a note">` with `noteIcon(12)` right after the title when `item.note`.

- [ ] **Step 5: `note-overlay.ts`** — `NoteOverlay` and `noteIcon` to the behavior above. The textarea has `maxlength` `MAX_NOTE_LENGTH` and `spellcheck=false`.

- [ ] **Step 6: `side-panel.ts`** — in `apply()`, set `--panel-cover` on `this.terminals`: the panel's width when it is shown, in overlay mode and not expanded; `0px` otherwise.

- [ ] **Step 7: `index.html`, `main.ts`, `styles.css`**
- `index.html`: `<div id="terminals"><div id="note"></div></div>`.
- `main.ts`: create `noteOverlay` in `boot()` right after `tabBar`, with `setText`/`setView` → `ct.setNoteText`/`ct.setNoteView`, `focusTerminal` → the active terminal's `term.focus()`, `changed` → `renderTabs()`. `renderTabs` passes `note: noteOverlay.hasText(id)`. `refreshPanelButtons` calls `tabBar.setNote(claude, claude && noteOverlay.isShown())`. `runAction`: `case 'toggleNote': if (t?.info.kind === 'claude') noteOverlay.toggle(); break`. The tab bar's `toggleNote` callback runs that action. `activate` calls `noteOverlay.show(tabId, claude)`. `ct.onNote((id, note) => { noteOverlay.set(id, note); renderTabs() })`. `onTabClosed` calls `noteOverlay.dropTab(id)`. The window `focus` handler leaves the keyboard where it is when it is inside `#note` (as it does for `#image-panel`).
- `styles.css`: the rules above.

- [ ] **Step 8: Run the tests and see them pass**

Run: `npx vitest run tests/unit/keymap.test.ts` — PASS. `npm run build && npx playwright test tests/e2e/note-overlay.spec.ts tests/e2e/notes.spec.ts tests/e2e/tabs.spec.ts tests/e2e/image-button.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/keys.spec.ts` — PASS. Then the whole suite, as CI runs it: `npm run typecheck` — no errors; `npm test` — all pass; `npm run test:e2e` — all pass.

- [ ] **Step 9: README** — under **Features**, in "A real terminal, with tabs", a bullet: **Notes** — a note of your own on each Claude tab (which feature it is, your TODO list), shown over the terminal as a small label you open into a card; it stays with the conversation through `/clear`, a restart and Recent sessions. Under **Keyboard shortcuts**, a row for the note with Ctrl+Shift+N / ⌘N in the table's existing format.

- [ ] **Step 10: Commit**

```bash
git add src/renderer tests/unit/keymap.test.ts tests/e2e/helpers.ts tests/e2e/note-overlay.spec.ts README.md
git commit -m "feat: notes on Claude tabs, shown over the terminal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
