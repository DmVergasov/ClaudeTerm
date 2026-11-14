# Ask Claude on a Heads up card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Heads up card has a message field and an **Ask Claude** button that send the person's words, with the card quoted, to the chat's main conversation, then close the card.

**Architecture:** Main builds the message from its own card (`HeadsUp.ask`) and sends it through the chat's normal send path; the window passes only the card id and the text over a new IPC call. The card view keeps one field across its rebuilds.

**Tech Stack:** Electron 44, TypeScript (strict), plain DOM renderer, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-heads-up-ask-claude-design.md`

## Global Constraints

- Comments, logs and UI strings in English; match the surrounding code's naming and comment density; keep each file's line endings.
- UI copy, verbatim: placeholder `Ask Claude about this…`, button `Ask Claude`, field aria-label `Ask Claude about this card`.
- Main checks every IPC argument: local Claude tab (`isLocalClaudeTab`), card id (`isChatRef`), text not blank and at most `SEND_TEXT_CAP` (1 MiB) characters.
- The message goes through `chatHub.send(tabId, { text, attachments: [] })` with no `from`: the words are the person's.
- Do not commit generated files; do not create git commits unless the controller says so.

## Review Focus

- A card that changes (Explain more) while the person types: the typed text stays in the field.
- A new card (another id) after one was sent or closed: the field starts empty.
- A send that fails (the chat ended): the card stays and the error shows under the field; nothing else is lost.
- Shift+Enter, and Enter while an IME composes: no send.
- Double click on Ask Claude: one message only.

---

### Task 1: `HeadsUp.ask` in main, its IPC call and guard

**Files:**
- Modify: `src/main/chat/heads-up.ts` (deps, `askMessage`, `ask`)
- Modify: `src/main/chat/chat-guards.ts` (text guard)
- Modify: `src/shared/ipc.ts` (channel `chatHeadsUpAsk: 'chat:heads-up-ask'`, `CtApi.chatHeadsUpAsk`)
- Modify: `src/preload/index.ts` (`chatHeadsUpAsk` → `ipcRenderer.invoke`)
- Modify: `src/main/index.ts` (the `HeadsUp` deps near `new HeadsUp({`, the handler beside `IPC.chatHeadsUpAction`)
- Test: `tests/unit/heads-up.test.ts`

**Interfaces:**
- Produces: `CtApi.chatHeadsUpAsk(tabId: string, cardId: string, text: string): Promise<string | null>` — null when sent, else an error text to show.
- Produces: `HeadsUpDeps.send(tabId: string, text: string): Promise<string | null>` (the chat's send result).
- Produces: `askMessage(card: HeadsUpCard, text: string): string` and `HeadsUp.ask(tabId: string, cardId: string, text: string): Promise<string | null>`, exported from `src/main/chat/heads-up.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/heads-up.test.ts`. Extend `setup()` with a `send` dep that records `{ tabId, text }` into a returned `sent` array and resolves to `o.sendError ?? null` (add `sendError?: string` to `setup`'s options). Then, in `describe('HeadsUp')`:

```ts
const QUOTED = '> Heads up: The tests run against production\n>\n> The `.env` the tests read points at the **production** database.\n>\n> - Point `DATABASE_URL` at a test database before the next run.'

it('Ask Claude sends the words with the card quoted to the conversation, and closes the card', async () => {
  const { h, asked, shown, sent, settle } = setup()
  h.message('t', init)
  h.message('t', toolUse(HEADS_UP_EVERY))
  asked[0]!.resolve(FINDING)
  await settle()
  expect(await h.ask('t', 'card-1', '  Fix it now  ')).toBeNull()
  expect(sent).toEqual([{ tabId: 't', text: `Fix it now\n\n${QUOTED}` }])
  expect(shown.at(-1)).toBeNull()
  expect(h.card('t')).toBeNull()
})

it('the message quotes the longer explanation too once Explain more brought it', async () => {
  // as above, then h.act('t', 'card-1', 'explain'); asked[1]!.resolve('Your `.env` holds the production URL.'); await settle()
  // expect(sent[0]!.text).toBe(`Why?\n\n${QUOTED}\n>\n> Your \`.env\` holds the production URL.`)
})

it('Ask Claude on a card the tab does not show sends nothing, and a failed send keeps the card', async () => {
  // no card: expect(await h.ask('t', 'card-9', 'x')).toBe('The card is gone.'); expect(sent).toEqual([])
  // setup({ sendError: 'The chat has ended.' }) with a card: expect(await h.ask('t', 'card-1', 'x')).toBe('The chat has ended.');
  // expect(h.card('t')).not.toBeNull(); expect(shown.at(-1)).not.toBeNull()
})
```

The `You should know` tag quotes as `> You should know: <title>`; cover it with one `askMessage` call on a `should-know` card in the first test or its own.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/heads-up.test.ts`
Expected: FAIL — `h.ask` is not a function / `send` unknown.

- [ ] **Step 3: Implement in `src/main/chat/heads-up.ts`**
  - `askMessage(card, text)`: `text.trim()`, a blank line, then `> <Heads up | You should know>: <title>`, `>`, the card's text with every line prefixed `> ` (a blank line becomes `>`), and when `card.more !== null` another `>` and the explanation quoted the same way.
  - `ask(tabId, cardId, text)`: when the tab's card is not `cardId`, resolve `'The card is gone.'`. Else send `askMessage(card, text)` with `this.d.send`; on an error text, resolve it and keep the card; on null, close the card (as `act` does for `got-it`, only when the tab still shows that card) and resolve null.
- Then the guard in `src/main/chat/chat-guards.ts`: `isHeadsUpAskText(v: unknown): v is string` — the same rule as `isAgentText` (not blank, at most `SEND_TEXT_CAP`).
- Then the channel, the `CtApi` member with a doc comment, the preload call, and in `src/main/index.ts`: `send: (tabId, text) => chatHub.send(tabId, { text, attachments: [] })` in the `HeadsUp` deps, and `ipcMain.handle(IPC.chatHeadsUpAsk, ...)` resolving `headsUp.ask(...)` when `isLocalClaudeTab(tabId) && isChatRef(cardId) && isHeadsUpAskText(text)`, else `'The card is gone.'`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/unit/heads-up.test.ts tests/unit/chat-guards.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Report** (no commit: the controller commits)

### Task 2: The card's field and Ask Claude button

**Files:**
- Modify: `src/renderer/chat/heads-up-card.ts` (`HeadsUpViewOptions.ask`, the field row)
- Modify: `src/renderer/chat/chat-view.ts` (option `headsUpAsk`, passed to `HeadsUpView`)
- Modify: `src/renderer/main.ts` (beside `headsUp: (cardId, action) => ct.chatHeadsUpAction(...)`: `headsUpAsk: (cardId, text) => ct.chatHeadsUpAsk(tabId, cardId, text)`)
- Modify: `src/renderer/chat/chat.css` (beside the `.chat-heads-up-*` rules)
- Test: `tests/e2e/chat-heads-up.spec.ts`

**Interfaces:**
- Consumes: `CtApi.chatHeadsUpAsk(tabId, cardId, text): Promise<string | null>` (Task 1).
- Produces: `HeadsUpViewOptions.ask(cardId: string, text: string): Promise<string | null>`; `ChatViewOptions.headsUpAsk(cardId: string, text: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/chat-heads-up.spec.ts` (reuse `launchChatTab`, `sendMessage`, `userMessages`, `work`, `FINDING`, `MORE`, `CARD`; the stand-in answers a message it has no turn for with `ok`):

```ts
test('Ask Claude sends your words with the card to the conversation, and the card closes', async () => {
  // turns: { 'clean up': work(HEADS_UP_EVERY) }, headsUp: { check: FINDING }
  // after the card shows: card.getByRole('textbox', { name: 'Ask Claude about this card' }).fill('Stop and use the test database')
  // expect(card.getByRole('button', { name: 'Ask Claude' })).toBeEnabled(); click it
  // await expect(card).toBeHidden()
  // await expect.poll(() => userMessages(log).find((m) => m.startsWith('Stop and use the test database'))).toBe(
  //   'Stop and use the test database\n\n> Heads up: The cleanup runs on production\n>\n> The `.env` the script reads points at the **production** database.')
  // the chat shows it as your message: page.locator('.chat-host:visible .chat-user', { hasText: 'Stop and use the test database' }) has count 1
})

test("text typed in the card's field stays when Explain more brings the explanation, and Enter sends it", async () => {
  // headsUp: { check: FINDING, explain: MORE }; with the card shown: the button is disabled while the field is blank
  // fill 'Why production?'; click Explain more; await the .chat-heads-up-more text; the field still holds 'Why production?'
  // Shift+Enter adds a new line and sends nothing; then press Enter: the card hides, and the message received ends with
  // '\n>\n> Set `DATABASE_URL` to a test database before you run the cleanup again.'
})
```

- [ ] **Step 2: Build and run them to see them fail**

Run: `node .superpowers/shared-lock.cjs "npm run build"` then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 tests/e2e/chat-heads-up.spec.ts"`
Expected: the two new tests FAIL (no textbox), the others PASS.

- [ ] **Step 3: Implement**
  - In `HeadsUpView`: a row `.chat-heads-up-ask` with a `textarea.chat-heads-up-input` (placeholder and aria-label as in Global Constraints, `rows = 1`, growing with its text up to about 5 lines) and a `button.chat-heads-up-btn` `data-action="ask"` labelled `Ask Claude`. The row and its field are created once in the constructor and appended to every rebuild of `show`; `show` clears the field only when the card's id differs from the last card's. The row goes after the text (and the explanation), before the existing actions row.
  - The button is disabled while the trimmed field is blank or a send is under way. Enter without Shift and outside an IME composition (`e.isComposing`) sends; Shift+Enter is a new line.
  - Send: `await o.ask(card.id, text)`; null — nothing more (main closes the card); an error text — show it in a `.chat-heads-up-error` under the field, keep the text.
  - `ChatView` passes `ask: (cardId, text) => o.headsUpAsk(cardId, text)` to `HeadsUpView`; `main.ts` wires `headsUpAsk` to `ct.chatHeadsUpAsk(tabId, cardId, text)`.
  - CSS: the row is a flex line, the field takes the width (`flex: 1`), styled like the card's buttons' edge and the chat's message field (use existing `--chat-*` / `--line` tokens, no new hex colors), focus ring as `.chat-heads-up-btn:focus-visible`.

- [ ] **Step 4: Build and run the Heads up e2e spec and the typecheck**

Run: `npm run typecheck`, `node .superpowers/shared-lock.cjs "npm run build"`, `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 tests/e2e/chat-heads-up.spec.ts"`
Expected: all PASS.

- [ ] **Step 5: Report** (no commit: the controller commits)
