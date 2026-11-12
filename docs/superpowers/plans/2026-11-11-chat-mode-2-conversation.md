# Chat mode, plan 2 of 4: the conversation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chat column draws the conversation as the Main, Working and Approve boards do — Markdown, folded thinking, tool steps with subagents, images, command output, notices and the working line — sticks to the bottom, pages older history in, keeps a small DOM, and is searchable with Find.

**Architecture:** Plan 1 left a `ChatView` with a plain `renderItem`. This plan replaces each kind's drawing (`chat-items.ts`, `chat-steps.ts`, `chat-markdown.ts`), adds a DOM window over the view's item list with scroll anchoring (`chat-view.ts`), a Find target the existing search bar drives (`chat-find.ts`, `search.ts`), and in main the matching of image paths to Media cards (`ChatHub.imagesChanged`).

**Tech Stack:** TypeScript, plain DOM, `markdown-it` (already a dependency, raw HTML off), the CSS Custom Highlight API for Find, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-11-chat-mode-design.md`, sections "The conversation" and "Performance". Plan 1 (`2026-11-11-chat-mode-1-engine.md`) must be done first. Board copies: the controller copies the boards' HTML into `.superpowers/sdd/2026-11-11-chat-mode-2/boards/` before Task 1 (Slash.dc.html read from the canvas artifact); the values below are taken from them, and where a board and the spec disagree the spec wins (the boards show a 900 px column and a token count on the working line; the spec says 860 px and no tokens).

## Global Constraints

- Every Global Constraint of plan 1 holds (worktree, no commits, the Settings plan running alongside and the files it owns, the lock for build and e2e, untrusted input, no real `claude`, `pathKey`, the terminal view unchanged, English, palette, motion, `chat.css`). The controller copies them into this plan's `global-constraints.md`.
- Item drawing never uses `innerHTML` with anything but `markdown-it`'s output (raw HTML off) or fixed markup of our own; every string from Claude goes in through `textContent`.
- Links in Claude's text open only through `window.ct.openExternal` and only for `http:` / `https:` URLs; a click on any other link does nothing.
- Board values (exact): conversation text `#DADADF`, line-height 1.6, 16 px gap between items; user bubble max 72 % wide, `#1C1C22`, padding 9 px 14 px, radius `14px 14px 4px 14px`; inline code padding 1 px 5 px, radius 4 px, `#1E1E24`, 12 px monospace, `#EDEDF0`; cards (steps, agents, images) border `1px solid #202026`, radius 10 px, background `#131317`, rows padding 7 px 12 px, font 12.5 px, separators `1px solid #1C1C21`; tool name 44 px wide, weight 600; subject 12 px monospace `#B5B5BE`; detail 12 px monospace, `+n` `#63C08F`, `−n` `#F2867E`, other details `#8C8C96` tabular-nums; running ring 11 px, `2px solid #2E2E36` with the top in the accent; Bash well margin-left 77 px, padding 8 px 10 px, height 108 px, `#0C0C0E`, border `#1C1C21`, radius 6 px, font 11.5 px/1.6 monospace, `#A3A3AC`; agents card header 12 px `#8C8C96`, rows a grid `16px 104px minmax(0,1fr) 120px` with column gap 10 px; image cards 168 px wide, thumbnail 84 px high on `#0F0F12`; a folded step is a pill: border `1px solid #202026`, radius 8 px, `#8C8C96`, 12 px; top fade 48 px `linear-gradient(#111114, #11111400)`; working line: the glyph 16 px wide, 15 px, accent; the verb weight 600; the rest 12 px `#8C8C96`.

## Review Focus

1. **Hostile Markdown** (`<img onerror>`, `<script>`, `[x](javascript:alert(1))`, a 2 MB code block, a 10 000-row table): shown as text or inert, no script runs, the column stays responsive. Test: Task 1 unit tests and Task 3 e2e `'raw HTML is text'`.
2. **Streaming while the user reads above**: the column never jumps; the "↓ New messages" pill appears and brings it back. Test: Task 5.
3. **A tool output of 200 000 characters**: the well shows its last lines; unfolding shows at most the 64 KiB main kept, in one `pre`, without freezing. Test: Task 4.
4. **An image whose Media card arrives later than the step** (the watcher is slower than the stream): no broken image; the card appears when main resolves it. Test: Task 2 unit test and Task 4 e2e.
5. **A hidden chat tab while its Claude streams**: no DOM work in it; it shows the current state when brought to the front. Test: Task 5 `'a hidden chat tab is not touched'`.

---

### Task 1: Markdown for the chat

**Files:**
- Create: `src/renderer/chat/chat-markdown.ts`
- Test: `tests/unit/chat-markdown.test.ts`

**Interfaces:**
- Produces:

```ts
/** markdown-it's HTML for Claude's text: raw HTML off, linkify on, code fences with a Copy button */
export function chatMarkdownHtml(text: string): string
/** the text up to the last block boundary outside a code fence, and the rest: only the rest is drawn again while it streams */
export function splitStable(text: string): { stable: string; tail: string }
/** a link Claude wrote may be opened outside: http(s) only */
export function openableLink(href: string): boolean
```

Rules:
- `markdownit({ html: false, linkify: true, breaks: false })`; links render as `<a href="…" class="chat-link">` (markdown-it's own `validateLink` already drops `javascript:`, `vbscript:`, `file:`, `data:`); images in Claude's Markdown render as their alt text in a link, never as `<img>` (the renderer loads images only through `ctimg://`).
- A fence renders as `<div class="chat-code"><div class="chat-code-head"><span class="chat-code-lang">LANG</span><button class="chat-copy" type="button">Copy</button></div><pre><code>ESCAPED</code></pre></div>` (`LANG` escaped, empty when none).
- Tables keep markdown-it's markup inside `<div class="chat-table">` (it scrolls sideways).
- `splitStable`: the boundary is the last `\n\n` not inside an open fence (count of ```` ``` ```` lines before it is even); no boundary → `stable: ''`.

- [ ] **Step 1: Write the failing tests:** `'raw HTML is escaped'` (`<img src=x onerror=alert(1)>` → output contains `&lt;img` and no `<img`); `'javascript links are not links'` (`[x](javascript:alert(1))` → no `href="javascript`); `'a fence gets a Copy button and escapes its code'` (```` ```html\n<b>x</b>\n``` ```` → contains `class="chat-copy"` and `&lt;b&gt;`); `'a Markdown image is not an img'`; `'splitStable keeps an open fence in the tail'` (`'a\n\n```\nb\n\nc'` → `stable: 'a\n\n'`); `'openableLink'` true for `https://x.dev`, false for `file:///c`, `mailto:a@b`, `vscode://x`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-markdown.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted (the controller snapshots the tree).

### Task 2: images of the conversation find their Media cards

**Files:**
- Modify: `src/main/chat/chat-hub.ts`, `src/main/index.ts` (call it where image updates go to the window)
- Test: `tests/unit/chat-hub.test.ts`

**Interfaces:**
- Produces: `ChatHub.imagesChanged(tabId: string, cards: ImageCard[]): void`

Rules: for each `images` item of the tab whose entries have `cardId: null`, an entry whose `path` equals a card's `path` by `pathKey` (not deleted) gets that card's id; each changed item goes out as one `set` patch. `index.ts` calls it with `images.list(tabId)` wherever it sends the window an images update for a tab, and once after a chat tab's history loaded.

- [ ] **Step 1: Write the failing tests:** `'an images item gets its card when the card comes later'` (item first, `imagesChanged` with a card of the same path in another case and with `\` → one `set` with `cardId`); `'a deleted card is not taken'`; `'nothing changes, nothing is sent'`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/chat-hub.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 3: the items as drawn — messages, text, thinking, commands, notices, the working line

**Files:**
- Modify: `src/renderer/chat/chat-items.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`, `src/renderer/main.ts` (the new `ChatViewOptions` callbacks)
- Test: `tests/e2e/chat-conversation.spec.ts`

**Interfaces:**
- Consumes: `chatMarkdownHtml`, `splitStable`, `openableLink` (Task 1); `spinner` from `src/renderer/tab-row.ts` for the working glyph.
- Produces, added to `ChatViewOptions` (plan 1) and passed by `main.ts`:

```ts
imageCard(cardId: string): ImageCard | null      // from the tab's last images update
openImages(cards: ImageCard[], index: number): void   // the lightbox
revealChange(path: string): void                // opens Changes at the file (reviewPanel.reveal + sidePanel.open('changes'))
openExternal(url: string): void
copy(text: string): void                        // ct.writeClipboardText
```

Rules:
- `user` (`.chat-user`): the bubble of the board; attachments under the text: images as 56 px thumbnails (`imageCard(cardId)` → `imageUrl(card)`; no card → a file chip), files as chips (icon, name).
- `text` (`.chat-text`): `chatMarkdownHtml`. While `streaming`, the stable part is drawn once into its own element and only the tail is drawn again on each `append`, at most once per animation frame; when the item settles the whole text is drawn once. A click on `.chat-link` calls `openExternal(href)` when `openableLink(href)`, and always `preventDefault()`. `.chat-copy` copies its block's code text and shows `Copied` for 1.5 s.
- `thinking` (`.chat-thinking`): one folded row, `Thought for <s>s` (`ms` rounded to whole seconds, at least 1) or `Thought` when `ms` is null; it unfolds to the summary as text, or `No summary` in `#8C8C96`.
- `command` (`.chat-command`): a quiet block — head `/context` in 12 px monospace `#8C8C96`, the output as preformatted text (12 px monospace, `#B5B5BE`), at most 240 px high, scrolling.
- `notice` (`.chat-notice`): one line, 12.5 px, `#8C8C96` for `info`, `#F2867E` for `error`, with its action button (`Restart`, `Open in the terminal`).
- `divider` (`.chat-divider`): a centred 11 px uppercase label between two hairlines.
- The working line (`.chat-working`, last in the column while `state.turn !== 'idle'`): the spinning glyph, `Working` (`Waiting for you` while `waiting`), `· <elapsed>` from `turnStartedAt` (`12s`, `1m 05s`), `· Esc to interrupt` (left out while waiting). The elapsed time ticks once a second only while the view is shown.
- New items pop in with part 1's `pop-in` (opacity and transform, 140 ms); none under reduced motion. Patches are queued and applied together once per animation frame.

- [ ] **Step 1: Write the failing e2e tests** (`launchChatTab` of plan 1; the stand-in's scripts give each case):
  - `'Claude's Markdown is drawn, a code block can be copied'`: text with a heading, a list, inline code and a fence → `.chat-text h2`, `li`, `code`, `.chat-code`; clicking `.chat-copy` puts the code on the clipboard (tag `@alone`, `keepingClipboard`).
  - `'raw HTML is text'`: text `<img src=x onerror="document.title='x'">` → no `img` in `.chat-text`, the page title unchanged (Review Focus 1).
  - `'a link opens in the browser, a file link does not'`: `shell.openExternal` recorded as in `docs.spec.ts`; `https://example.com` is recorded, `file:///etc/passwd` is not.
  - `'thinking is folded and unfolds to its summary'` (a scripted `thinking` step: add `{ thinking: string; ms: number }` to the stand-in's `FakeStep` — the one stand-in change of this plan, in `tests/fixtures/fake-claude/fake-claude.ts` and `install.ts`'s type).
  - `'/context output is a quiet block'`; `'a retry is one line'`; `'the working line counts while Claude works and goes when it ends'`.
- [ ] **Step 2: Run** `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/chat-conversation.spec.ts --reporter=line --workers=2"`. Expected: FAIL.
- [ ] **Step 3: Implement** the drawing and the callbacks.
- [ ] **Step 4: Run** it, and the same for `tests/e2e/chat.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 4: tool steps, subagents and images

**Files:**
- Create: `src/renderer/chat/chat-steps.ts`
- Modify: `src/renderer/chat/chat-items.ts`, `src/renderer/chat/chat.css`
- Test: `tests/e2e/chat-conversation.spec.ts`

**Interfaces:**
- Produces: `export function renderSteps(item: Extract<ChatItem, { kind: 'tools' }>, cb: StepCallbacks, open: boolean | null): HTMLElement` and `export function renderImages(item: Extract<ChatItem, { kind: 'images' }>, cb: StepCallbacks): HTMLElement`, with `StepCallbacks = Pick<ChatViewOptions, 'revealChange' | 'imageCard' | 'openImages'>`; `open: null` follows the step's own state.

Rules:
- A step is a card while any call runs, and folds itself to the pill `Ran <n> tool<s> · <s>s` (`ms` with one decimal) once every call is done; a click on the header or the pill toggles it, and the user's choice is kept for that item (by id) while the view lives.
- One row per call: the ring while `running`, a green ✓ when `done`, a red ✕ when `failed`; the name; the subject; the detail on the right (`+n` green and `−n` red split as on the board).
- A `Bash` call: under its row the well with the last 5 lines of `output`; a click unfolds it to the whole output in a `pre` (max-height 400 px, scrolls). A failed call shows its `error` under the row in `#F2867E`.
- A row with `editPath` is a button: a click calls `revealChange(editPath)`.
- A `Task` / `Agent` call with `agents`: under the step, the agents card of the board: header `<n> agents · <k> done`, one grid row per subagent — state icon (ring / ✓ / ✕), `type`, `description`, `done · 14s` / `running · 14s` / `failed`.
- `images`: a row of 168 px cards, one per image with a `cardId` that `imageCard` finds; the thumbnail is `imageUrl(card)` (`object-fit: cover`), under it the file name; a click opens the lightbox with the item's found cards at that index. An image without a card is not drawn.

- [ ] **Step 1: Write the failing e2e tests:** `'a running step is open, a done step folds to its pill'`; `'the pill unfolds the step'`; `'a Bash well shows the last lines and unfolds'` with a 200 000-character output (Review Focus 3: unfolded `pre` text length ≤ 65 536 + 1); `'an edit row opens Changes at its file'` (a git repo work folder, an `Edit` tool step on `a.ts` → the Changes panel is open with `a.ts` shown); `'a failed call shows its error'`; `'subagents of a Task call are listed with their state'`; `'an image Claude read shows as a card and opens the lightbox'` (a `Read` of a PNG written into the work folder; Review Focus 4: the card shows once the Media panel has it).
- [ ] **Step 2: Run** the chat-conversation spec through the lock. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 5: the column — bottom stick, New messages, older pages, a small DOM

**Files:**
- Modify: `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`
- Test: `tests/e2e/chat-conversation.spec.ts`

Rules:
- The view keeps every item it was given (`load`, `older`, patches) in an array, and holds in the DOM a window of at most 120 consecutive items; every item element has `content-visibility: auto` and `contain-intrinsic-size: auto 120px`.
- Bottom stick: when the scroll is within 24 px of the bottom before a change, it is at the bottom after it; otherwise the scroll position holds (anchored to the first visible item) and the pill `↓ New messages` shows at the bottom centre; a click on it scrolls to the bottom and hides it.
- Scrolling within 400 px of the top: when the window does not start at the first held item, 60 earlier items are added above and as many dropped below when the window exceeds 120, the position anchored; when it does and `hasOlder`, `older(firstId)` is called once (not again until its patch came).
- `load` of a snapshot draws the last 120 items with the scroll at the bottom, synchronously, in one pass with no layout read inside the loop.
- A hidden view applies no patch to the DOM: patches while hidden only update the array; showing it draws the window from the array.
- The 48 px fade sits over the top of the scroll area (`pointer-events: none`).

- [ ] **Step 1: Write the failing e2e tests:**
  - `'a long conversation shows its end and holds a small DOM'`: a restored chat tab whose transcript has 5 000 user/assistant pairs (written by the test under the test's `CLAUDE_CONFIG_DIR`) → the last message is visible; `.chat-column > *` count ≤ 121.
  - `'scrolling up brings older items'`: scroll to the top repeatedly → the first message of the conversation appears; the DOM count stays ≤ 121.
  - `'while you read above, new text does not move the column and the pill brings you down'` (Review Focus 2): scroll up, the stand-in streams for 2 s → the first visible item's `top` changes by ≤ 1 px; the pill is visible; clicking it ends at the bottom.
  - `'a hidden chat tab is not touched'` (Review Focus 5): two chat tabs, the second in front, a `MutationObserver` on the first's column counts 0 mutations while its Claude streams; activating it shows the streamed text.
- [ ] **Step 2: Run** the spec through the lock. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, and `tests/e2e/chat.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.

### Task 6: Find in the conversation

**Files:**
- Create: `src/renderer/chat/chat-find.ts`
- Modify: `src/renderer/search.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/main.ts` (the search bar's target)
- Test: `tests/e2e/chat-conversation.spec.ts`

**Interfaces:**
- Produces:

```ts
// search.ts: the search bar drives either a terminal's SearchAddon or a chat
export interface FindTarget {
  findNext(term: string, opts?: { caseSensitive?: boolean; incremental?: boolean }): boolean
  findPrevious(term: string, opts?: { caseSensitive?: boolean }): boolean
  clearDecorations(): void
}
// constructor(root, target: () => FindTarget | null, onClose) — SearchAddon satisfies FindTarget
// chat-find.ts
export class ChatFind implements FindTarget { constructor(view: ChatView) }
```

Rules: matches are searched in the view's item array (the text an item shows: message text, Markdown source, subjects, outputs, notices), case-insensitive unless asked; the current match's item is brought into the DOM window and scrolled to the middle; every visible match is highlighted with `CSS.highlights` (`chat-find` and `chat-find-current`, colors `#E5B56755` and `#E5B567AA`); `clearDecorations` removes both highlights. `main.ts` gives the search bar the active tab's `ChatFind` in chat view, the `SearchAddon` otherwise. `KEYS.find` (`Ctrl+Shift+F` / `⌘F`) opens it as today.

- [ ] **Step 1: Write the failing e2e tests:** `'Find highlights matches and walks them'` (three messages with `limiter`, press `KEYS.find`, type `limiter`, Enter twice → the third match's item is in view and `CSS.highlights.get('chat-find-current').size === 1`); `'Find reaches an item outside the DOM window'` (5 000-pair conversation, a unique word in the first message → after Find it is visible); `'closing Find clears the highlights'`; `'text in the conversation can be selected and copied'` (`@alone`, `keepingClipboard`, select a message's text with the mouse and `KEYS.copy`).
- [ ] **Step 2: Run** the spec through the lock. Expected: FAIL.
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run** it, then `node .superpowers/sdd/locked.cjs "npm run build && npx playwright test tests/e2e/keys.spec.ts tests/e2e/chat.spec.ts --reporter=line --workers=2"` (the terminal's Find unchanged), `npm run typecheck`, `npm test`. Expected: PASS.
- [ ] **Step 5:** Leave the changes uncommitted.
