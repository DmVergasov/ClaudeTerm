# Coordinator Questions and the Person's Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session on a coordinator's task asks the person only through its coordinator. ClaudeTerm intercepts its AskUserQuestion, the coordinator asks the person with its own form, and `answer_session` types the person's checked answers back into the session. The coordinator and its sessions write in the person's language.

**Architecture:**
- **The hook.** The `PreToolUse` hook for AskUserQuestion sends the whole `questions` with its `attention`. When main's answer carries `info`, the hook prints a `deny` decision with that reason.
- **The session's device.** `CoordinatorHub.ask` decides whether a question goes to the coordinator. If it does, the hub writes a `question` mail record and marks the hosted task as waiting (`StoredTask.question`). While the task waits, its turn end neither settles it nor sends a progress note. A turn the person starts, or a new task, closes the wait. An `answer` record for the waiting question is typed into the prompt through the existing `canTakeWords`/`takeWords` path of `PromptDelivery`.
- **The coordinator's device.** A `question` record wakes the coordinator like a progress note. The session's row shows `Asks you: …`. `answer_session` checks the coordinator's form results, which `WordsLog` now keeps from the transcript feed, writes the `answer` record and toasts.
- **Paired devices.** A `withdraw` signal closes a question across devices. A new hello flag, `questions: 1`, keeps the three new kinds off links to older devices.
- **The language.** One sentence, `COORD_LANGUAGE`, goes into the coordinator's texts. The task's id line and a new per-turn note for sessions tell a session to write in its task's language and to ask only with AskUserQuestion.

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), plain-DOM renderer, Vitest (unit, integration), Playwright (e2e), zod (MCP tool schemas).

**Spec:** `docs/superpowers/specs/2026-11-17-coordinator-questions-design.md`. It builds on `docs/superpowers/specs/2026-11-16-coordinator-person-words-design.md` (the person's words, `WordsLog`, `PromptDelivery`) and `docs/superpowers/specs/2026-11-14-project-coordinator-design.md`.

## Global Constraints

- **AGENTS.md applies.**
  - Every behaviour is tested through its entry point: a pipe message, a hook run, an IPC call, the MCP server, a click.
  - Tests write only under `tmpdir()`.
  - The main process never blocks: read the transcript with the feed's async `pollMain()`.
  - All copy is English, and no real personal data goes into tests.
- **Do not commit.** The user's standing rule overrides the skill's commit steps. Leave each task's work uncommitted. Report the changed files, with a suggested Conventional Commits message.
- **Untrusted input.** Everything from the pipe, from transcript files and from paired devices is untrusted.
  - Questions and answers go through `parseQuestions` and `parsePassedAnswers`, and records through `checkMailRecord`.
  - A transcript line that does not parse, or has an unexpected shape, gives nothing.
  - Nothing is cut to fit: a question out of bounds is not routed.
- **Line endings.** Source files, `README.md` and `AGENTS.md` are CRLF in this checkout (`core.autocrlf=true`, git stores LF). Keep each file's line endings, and give a new file its neighbours'.
- **Collisions.** Other sessions work in their own worktrees: "Built-in browser", "Mail panel freeze", "Account links" and feat-artillery. Work only in this worktree. If a file, the build or an e2e run collides with another agent's work (a locked file, a running app, a held DLL), report it to your dispatcher. Never edit, revert or kill the other side's work.
- **Bounds** (`src/shared/questions.ts`):
  - 1 to 4 questions; each question 1 to 2000 characters, `header` at most 50, `multiSelect` a boolean.
  - 2 to 4 options per question; each `label` 1 to 200 characters, `description` at most 500.
  - A question as the coordinator asked it: 1 to 2000 characters. An answer: 1 to 2000.
  - Question texts within one call are unique.
  - The question's text for the coordinator must fit `MAIL_TEXT_MAX` (8000), and so must the answer's.
  - The hook's deny reason is 1 to 2000 characters.
- **Times.**
  - A form result counts for a question when its transcript time is at least the question's `sentAt` minus `FORM_SLACK_MS` (120 000 ms, the slack for a paired device's clock).
  - `WordsLog` keeps the latest `FORMS_KEPT` (20) transcript form results per tab. Main keeps the same number of card answers and of form dialogs per tab, in memory.
  - A transcript form result is backed by a dialog answer of the window: a `PersonInput` submit with `texts === null` into the same tab, with `dialog.at <= submit.at <= result.at + INPUT_SLACK_MS` (5000 ms).
- **Where an answer comes from** (the person's choice, spec "Where the person's answer comes from"). A form result counts only in one of two cases:
  - a card answer main saw: `ChatHub.answer` from the window, or `answerRemote` from claude.ai;
  - a transcript result whose question texts equal those of a form the same tab's own hook reported, at or before the result, and that a dialog answer of the window backs.

  A forged transcript line with neither behind it never counts.
- **Copy fixed by this plan.** Use each string exactly as written; `${…}` marks a value.
  - Deny reason (`ASK_REASON`): `ClaudeTerm sent these questions to your coordinator, which asks the person in its own question form. Do not ask them again, with a form or in text. End your turn now with one short line saying that you wait for the person's answer. The answer comes as your next message, and your task goes on then.`
  - `COORD_LANGUAGE`: `Write to the person in the language of their own messages, even when reports, notes and tool results are in English, and write the tasks you give sessions in it too: the person reads them in the sessions' tabs.`
  - `COORD_QUESTIONS`: `A session's permission prompts are the person's to answer in that session: never answer one. A session's questions come to you as question notes: ask the person them with AskUserQuestion, then pass the answers with answer_session. When a report or a progress note ends with a question to the person, ask it with AskUserQuestion and give the answer with message_session.`
  - `COORD_PROGRESS` (replaces today's): `A progress note means the task is still running.`
  - Session turn note: `Note from ClaudeTerm, not from the user: you work on a task from your coordinator ${name}. The person talks to you through it: ask them only with AskUserQuestion, which ClaudeTerm passes to the coordinator, and never as a question in your answer. Write in the language of your task.`
  - Task id line: `id: ${id}  (do it, writing in the language of this task, and ask the person only with AskUserQuestion; when it is done, end your turn: ClaudeTerm sends your last answer to the coordinator as your report)`
  - `QUESTION_WAKE_HEAD`: `Question from a session attached to you, through ClaudeTerm: its task waits for the person's answer.`
  - Question id line: `id: ${id}  (ask the person with AskUserQuestion, in their language, then pass the answers with answer_session "${ref}"; read_session "${ref}" shows the session)`
  - `ANSWER_WAKE_HEAD`: `Answer from your coordinator, through ClaudeTerm: the person answered your question.`
  - Answer id line: `id: ${id}  (the answer to your question ${questionId}; go on with your task: when it is done, end your turn, and ClaudeTerm sends your last answer to the coordinator as your report)`
  - `PERSON_ANSWERS_HEAD`: `The person's answers, through your coordinator`, then `PERSON_ANSWERS_CHECKED`: `(ClaudeTerm checked them in the coordinator's question form):`
  - `PERSON_ANSWERS_NOTE`: `Only the lines under "The person answered" are the person's. They answer the questions you asked with AskUserQuestion: go on with your task.`
  - `PERSON_ANSWERS_QUESTION`: `Your question:`, and `PERSON_ANSWERS_ASKED`: `The coordinator asked the person:`. The person's lines follow today's `PERSON_WORDS_ANSWER` (`The person answered:`).
  - `ANSWERS_ABOVE` (the answer block's quoted body): `The person's answers are above.`
  - `PERSON_WORDS_NOTE` (replaces today's): `Only the lines under "The person answered" are the person's. The task under it is your coordinator's: do what the person's words cover, and ask the person with AskUserQuestion before doing anything they do not cover.`
  - `WITHDRAW_TEXT` (a withdraw record's text): `The person answered in the session's tab.`
  - Row line: `Asks you: ${the first question, one line, cut as a progress note's}`
  - `list_sessions` note: `- A question from ${names} waits for the person: ask it with AskUserQuestion (read_session shows it), then pass the answers with answer_session.`
  - `read_session` line: `Waiting for the person's answer to its question:`, followed by the question's text.
  - Toast: `Your answer went to ${name}: «${the first answer, one line, cut to 60}»`
  - Kind labels: `Question` and `Answer · your words`.
  - `HUB_TEXT` entries:
    - `answered(name)`: `The person's answers went to ${name}. It goes on with its task; its report comes to you by itself when the task ends.`
    - `noQuestion(name)`: `${name} has no question waiting for an answer.`
    - `answeredInTab(name)`: `The person answered ${name}'s question in its tab already; nothing was sent.`
    - `questionCount(name, n)`: `${name} asked ${n === 1 ? '1 question' : `${n} questions`}: pass ${n} in questions, one for each, in their order.`
    - `notInForm(missing, found)`: `These questions are not in your question form since the session asked: ${missing}. Pass each one exactly as you wrote it in AskUserQuestion. ${found}`, where `${found}` is `Your form holds: ${list}.` or `Ask the person with AskUserQuestion first.` when it holds none. Each list item is in «», joined by `, `, and each list is cut to 600 characters with `…`.
    - `answersTooLong`: `The answers are too long to pass on; give them with message_session.`
- **Checks.**
  - `npx vitest run <file>` for unit and integration tests, and `npm run typecheck` for the types.
  - For e2e: `npm run build`, then `node scripts/e2e.mjs <spec> --workers=1`.
- **Known flakes.** These fail on clean master too: `review.spec` and the git submodule tests under load, the `tab-panel.spec` fold race, and `account-add.spec` "checks the sign-ins". Rerun a failure alone, and on clean master, before blaming a change.

## File Structure

| File | Change |
|---|---|
| `src/shared/questions.ts` (new) | The question and answer shapes, their bounds, `parseQuestions`, `parsePassedAnswers` |
| `src/shared/mail.ts` | Kinds `question`, `answer`, `withdraw`; record fields `questions`, `answers`; `withdraw` is a signal |
| `src/main/mail/mail-record.ts` | `checkMailRecord` for the three kinds |
| `src/shared/protocol.ts` | `AttentionMessage.questions`; the `answer` coord op |
| `src/shared/coordinator.ts` | `CoordWhy` `question`; `CoordOp` `answer`; `COORD_LANGUAGE`, `COORD_QUESTIONS`, new `COORD_PROGRESS` |
| `src/hook/session-hook.ts` | `questions` in the hook's attention; `askDecisionLine`; the printed decision |
| `src/main/coordinator/form-answers.ts` (new) | `FormResult`, `FormDialog`, `FormRecord` (card answers and reported forms per tab), `countedForms`, `matchForm` |
| `src/main/coordinator/person-words.ts` | Transcript form results: `WordsLine` kind `form`, `WordsLog.forms()` |
| `src/main/chat/chat-hub.ts` | A dep that tells main the person answered a question card (window or claude.ai) |
| `src/main/transcript-feed.ts` | Nothing: form lines go through the existing `reportWords` → `wordsLine` |
| `src/shared/report-wake.ts` | The new heads, `WAKE_HEADS`, the new `PERSON_WORDS_NOTE` |
| `src/main/coordinator/question-text.ts` (new) | `questionsBody`, `answersBody`: the text of a question record and of an answer record |
| `src/main/mail/wake-text.ts` | The question's and the answer's blocks, the new task id line, `answersText` |
| `src/main/coordinator/session-text.ts` | `ASK_REASON`, `sessionTurnNoteText`, the coordinator's notes, `listText`, `readText` |
| `src/mcp/coordinator-tools.ts`, `src/mcp/show-image-server.ts` | `answer_session`; descriptions with the new sentences |
| `src/main/claude-tab-settings.ts` | `mcp__claudeterm__answer_session` allowed |
| `src/main/sync/wire.ts`, `src/main/sync/device-group.ts`, `src/main/mail/mail-sync.ts` | Hello flag `questions: 1`, `knowsQuestions`, the link filter |
| `src/main/coordinator/coordinator-store.ts` | `StoredTask.question` |
| `src/main/coordinator/session-state.ts` | `RowFacts.question`; reason `question`; `Asks you: …` |
| `src/main/coordinator/coordinator-hub.ts` | `ask`, the waiting task, the question's wake and row, `answer`, delivery and closing |
| `src/main/index.ts` | The attention handler asks the hub; `forms` and `questions` deps |
| `src/renderer/sessions-model.ts`, `src/renderer/sessions-panel.ts`, `src/renderer/mail-panel.ts` | Amber tone for `question`; the two kind labels |
| `AGENTS.md`, `README.md` | The hook's printed answers; the questions through the coordinator |
| `tests/fixtures/coordinator-world.ts`, `tests/fixtures/transcript.ts` | `forms` dep, `formed()`, `peerOf` `questions`; `formResultLine` |
| `tests/e2e/coordinator-questions.spec.ts` (new) | One device, terminal and chat; paired devices |

## Review Focus

- **The coordinator's copy of its own question differs in whitespace only.** A trailing space, CRLF, or a question copied without its outer blank lines must still match. One changed letter must not. Pinned by:
  - Task 3: "matchForm: equal after outer whitespace and line endings, nothing else".
- **The person types into the session's tab while the answer waits to be typed.** The answer must not be typed after the person's turn has started. Their turn closes the question, and the due answer is dropped. Pinned by:
  - Task 10: "a turn of the person while the answer waits to be typed: the answer is dropped, never typed".
- **One coordinator form asks two sessions' questions.** Each `answer_session` takes its own questions' answers from the same form result. Pinned by:
  - Task 3: "matchForm: one form holds the questions of two sessions";
  - Task 9: "two sessions answered from one form".
- **ClaudeTerm restarts while a question waits.** The task still waits, its turn end does not report, and the answer is still typed. Pinned by:
  - Task 7: "the waiting question is kept across a restart";
  - Task 10: "a hub on the same store types the answer after a restart".
- **On paired devices, an answer crosses a withdraw.** The session's device drops the answer and logs it, and never types it. Pinned by:
  - Task 11: "an answer that arrives after the person's turn closed the question is dropped there".

---

### Task 1: The shapes: questions, answers, the three record kinds, the attention's questions and the answer op

**Files:**
- Create: `src/shared/questions.ts`
- Modify: `src/shared/mail.ts`, `src/main/mail/mail-record.ts`, `src/shared/protocol.ts` (`AttentionMessage`, the attention parser, `parseCoordOp`), `src/shared/coordinator.ts` (`CoordWhy`, `CoordOp`)
- Test: `tests/unit/questions.test.ts` (new), `tests/unit/mail-record.test.ts`, `tests/unit/protocol.test.ts`

**Interfaces:**
- Produces (`src/shared/questions.ts`):
  - `QUESTIONS_MAX = 4`, `QUESTION_TEXT_MAX = 2000`, `QUESTION_HEADER_MAX = 50`, `OPTIONS_MIN = 2`, `OPTIONS_MAX = 4`, `OPTION_LABEL_MAX = 200`, `OPTION_DESCRIPTION_MAX = 500`, `FORM_QUESTION_MAX = 2000`, `FORM_ANSWER_MAX = 2000`
  - `interface AskedOption { label: string; description: string }`
  - `interface AskedQuestion { question: string; header: string; multiSelect: boolean; options: AskedOption[] }`
  - `interface PassedAnswer { question: string; asked: string; answer: string }`: the session's question, the question as the coordinator asked it, and the person's answer
  - `parseQuestions(v: unknown): AskedQuestion[] | null`
  - `parsePassedAnswers(v: unknown): PassedAnswer[] | null`
- Produces elsewhere:
  - `MailKind` and `MailRecord.kind` gain `'question' | 'answer' | 'withdraw'`.
  - `MailRecord.questions?: AskedQuestion[]` is set on a question only. `MailRecord.answers?: PassedAnswer[]` is set on an answer only.
  - `isSignal` is true for `withdraw` too.
  - `AttentionMessage.questions?: AskedQuestion[]` is set for reason `question` only.
  - `TurnMessage.prompt?: string` is the head of the prompt that started the turn, at most `TURN_PROMPT_MAX = 300` characters (in `protocol.ts`). The parser cuts a longer one with `cutText` and drops a non-string one.
  - `CoordWhy` gains `'question'`.
  - `CoordOp` gains `{ op: 'answer'; session: string; questions: string[] }`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/questions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parsePassedAnswers, parseQuestions } from '../../src/shared/questions'

const q = (over: Record<string, unknown> = {}) => ({ question: 'Where should the browser live?', header: 'Place', multiSelect: false, options: [{ label: 'Side panel', description: 'Next to Changes.' }, { label: 'Own tab', description: '' }], ...over })

describe('parseQuestions', () => {
  it('keeps the fields of 1 to 4 questions; a missing header or description is empty, a missing multiSelect false; other fields go', () => {
    expect(parseQuestions([{ question: 'Q?', options: [{ label: 'A' }, { label: 'B', extra: 1 }], extra: true }])).toEqual([
      { question: 'Q?', header: '', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }
    ])
    expect(parseQuestions([q(), q({ question: 'Two?', multiSelect: true })])).toHaveLength(2)
  })

  it('refuses anything out of bounds rather than cutting it', () => {
    for (const bad of [
      [], [q(), q({ question: '2' }), q({ question: '3' }), q({ question: '4' }), q({ question: '5' })], 'x', null, [null],
      [q({ question: '' })], [q({ question: '   ' })], [q({ question: 'x'.repeat(2001) })], [q({ header: 'h'.repeat(51) })], [q({ header: 3 })],
      [q({ multiSelect: 'yes' })], [q({ options: [{ label: 'only' }] })], [q({ options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })) })],
      [q({ options: [{ label: '' }, { label: 'B' }] })], [q({ options: [{ label: 'l'.repeat(201) }, { label: 'B' }] })],
      [q({ options: [{ label: 'A', description: 'd'.repeat(501) }, { label: 'B' }] })], [q(), q()]
    ]) expect(parseQuestions(bad)).toBeNull()
    expect(parseQuestions([q({ question: 'x'.repeat(2000), header: 'h'.repeat(50) })])).not.toBeNull()
  })
})

describe('parsePassedAnswers', () => {
  it('keeps 1 to 4 answers of three strings each, within their bounds', () => {
    const a = { question: 'Where?', asked: 'docs: Where?', answer: 'Side panel' }
    expect(parsePassedAnswers([{ ...a, extra: 1 }])).toEqual([a])
    for (const bad of [[], [a, a, a, a, a], [{ ...a, asked: '' }], [{ ...a, answer: 'x'.repeat(2001) }], [{ ...a, asked: 'x'.repeat(2001) }], [{ ...a, question: 'x'.repeat(2001) }], [{ question: 'Where?' }], 'x'])
      expect(parsePassedAnswers(bad)).toBeNull()
  })
})
```

In `tests/unit/mail-record.test.ts`, add (use the file's own record builder):
- "a question keeps its replyTo and its questions; one without a UUID replyTo or with questions out of bounds is refused";
- "an answer keeps its replyTo and its answers; one without them is refused";
- "a withdraw needs a UUID replyTo";
- "questions on another kind, or answers on another kind, are dropped from the checked copy". The field is not carried: `toEqual` without it.

In `tests/unit/protocol.test.ts`, add:
- "an attention of reason question carries its questions when they parse, and none when they do not; other reasons never carry them". The attention itself still parses in all three cases.
- "the answer op: a session and 1 to 4 questions of 1 to 2000 characters". Refused with `questions must be 1 to 4 texts of 1 to 2000 characters` otherwise.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run tests/unit/questions.test.ts tests/unit/mail-record.test.ts tests/unit/protocol.test.ts`
Expected: FAIL. `questions.ts` does not exist, and the new kinds and fields are refused or dropped.

- [ ] **Step 3: Implement**

- `parseQuestions` returns null for a list out of 1..4, any field out of the bounds above, a non-boolean `multiSelect`, a question text that is only whitespace, or two equal question texts. It returns copies with only the four fields.
- `checkKind` in `mail-record.ts`:
  - `question` needs `isUuid(replyTo)` and `parseQuestions(v.questions)`.
  - `answer` needs `isUuid(replyTo)` and `parsePassedAnswers(v.answers)`.
  - `withdraw` needs `isUuid(replyTo)`.
- Extend `KindFields` with `questions` and `answers`.
- In the attention parser: `const questions = m.reason === 'question' ? parseQuestions(m.questions) : null`, spread when not null.
- In `parseCoordOp`, the `answer` op checks `sized(m.session, MAIL_TO_MAX)`, then that `questions` is an array of 1..`QUESTIONS_MAX` strings, each `sized(s, FORM_QUESTION_MAX)`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/unit/questions.test.ts tests/unit/mail-record.test.ts tests/unit/protocol.test.ts` and `npm run typecheck`
Expected: PASS. Typecheck may flag exhaustive switches over `MailKind` (`mail-panel.ts` `kindLabel`). Give them a placeholder that returns the kind's name, and Task 8 sets the labels.

- [ ] **Step 5: Leave uncommitted**; suggested message `feat: the shapes of a session's questions, the person's answers and their records`.

### Task 2: The hook sends the questions and prints the decision main gives

**Files:**
- Modify: `src/hook/session-hook.ts`, `AGENTS.md` (the hook rule), `README.md` (the hooks paragraph, "These hooks never print anything…")
- Test: `tests/unit/session-hook.test.ts`, `tests/integration/session-hook.int.test.ts`

**Interfaces:**
- Consumes: `parseQuestions` (Task 1).
- Produces:
  - `ASK_REASON_MAX = 2000`
  - `askDecisionLine(answer: PipeResponse | null): string` returns `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: info } })}\n`. It does so when the answer is `ok` with a string `info` of 1..2000 characters, and returns `''` otherwise.
  - `hookMessage` for `PreToolUse` of AskUserQuestion adds `questions` when `parseQuestions(tool_input.questions)` is not null.
  - `runSessionHook` returns `askDecisionLine(answer)` for that event, and `''` for every other event but `UserPromptSubmit`.
  - `hookMessage` for `UserPromptSubmit` adds `prompt: cutText(input.prompt, TURN_PROMPT_MAX)` when `input.prompt` is a non-empty string.

- [ ] **Step 1: Write the failing tests**

Unit (`session-hook.test.ts`), a `describe('askDecisionLine and the AskUserQuestion decision')`:
- "the question's attention carries the whole questions, and the first question's line as its prompt". `hookMessage` of a PreToolUse with two questions equals `{ …attention('question'), prompt: 'Where should the browser live?', questions: [ …both, parsed ] }`.
- "questions out of bounds are left out; the attention still goes with its prompt".
- "askDecisionLine: an answer with info is the deny line; none, an error, an empty info or one of 2001 characters is ''".
- "runSessionHook prints the decision for AskUserQuestion's PreToolUse when main's answer has info, and nothing for a Stop whose answer has info".
- "the turn of a UserPromptSubmit carries the head of its prompt, cut to 300 characters; none when the prompt is missing or empty". Update the existing `turn` expectations in this file and in `session-hook.int.test.ts` (`{ v: 1, type: 'turn', …, remote: null }`): their inputs have `prompt: 'go on'`, so they now carry `prompt: 'go on'`.

Integration (`session-hook.int.test.ts`), a `describe('a session's question through its coordinator')`. Use `listen({ ok: true }, { attention: { ok: true, info: REASON } })` and a `PreToolUse` input with `tool_name: 'AskUserQuestion'`:
- "node bundle: the answer's reason is printed as the one deny line, and the attention carries the questions". Expect `r` to equal `{ code: 0, stdout: denyLine(REASON) }`, and `got[0]` to match `{ type: 'attention', reason: 'question', questions: [...] }`.
- "node bundle: an answer without info prints nothing".
- "exits 0 silently when ClaudeTerm is not running". Run with a pipe name nobody listens on: `{ code: 0, stdout: '' }`, within the existing timeout.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/unit/session-hook.test.ts` and `npx vitest run tests/integration/session-hook.int.test.ts`
Expected: FAIL. `askDecisionLine` is missing, and the bundle prints nothing.

- [ ] **Step 3: Implement** `askDecisionLine` next to `turnContextLine`, the `questions` field in `hookMessage`, and the branch in `runSessionHook`. Then update the docs:
  - **AGENTS.md:** the hook rule becomes: "**The hook script prints to stdout only the answers main gives it for Claude Code**: a coordinator's turn context (`UserPromptSubmit`) and the decision on a session's AskUserQuestion (`PreToolUse`). It prints nothing else (Claude Code puts `SessionStart` output into the conversation and shows `statusLine` output in its UI), and always exits with code 0, quickly, even when ClaudeTerm is not running."
  - **README.md:** in the hooks paragraph, replace "These hooks never print anything, so they don't change what Claude does." with: "These hooks print nothing, so they don't change what Claude does, with two exceptions: a coordinator's turn starts with ClaudeTerm's note, and a session working on a coordinator's task asks its questions through the coordinator instead of in its own tab."

- [ ] **Step 4: Run the tests again**, the same two commands, and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave uncommitted**; suggested message `feat: the hook sends a session's whole questions and prints main's decision on them`.

### Task 3: The coordinator's form results, and which of them count

**Files:**
- Create: `src/main/coordinator/form-answers.ts`
- Modify: `src/main/coordinator/person-words.ts`, `src/main/chat/chat-hub.ts` (`ChatHubDeps`, `answer`, `answerRemote`), `tests/fixtures/transcript.ts`
- Test: `tests/unit/form-answers.test.ts` (new), `tests/unit/person-words.test.ts`, `tests/unit/chat-hub.test.ts`, `tests/integration/transcript-feed.int.test.ts`

**Interfaces:**
- Consumes: `FORM_QUESTION_MAX`, `FORM_ANSWER_MAX`, `QUESTIONS_MAX` (Task 1); `Submit` (`person-input.ts`); `INPUT_SLACK_MS`, `normWords` (`person-words.ts`).
- Produces (`form-answers.ts`):
  - `FORMS_KEPT = 20`, `FORM_SLACK_MS = 120_000`
  - `interface FormEntry { question: string; answer: string }`
  - `interface FormResult { id: string; at: number; answers: FormEntry[] }`
  - `interface FormDialog { at: number; questions: string[] }`
  - `class FormRecord` keeps, per tab, the card answers main saw and the forms the tab's hook reported. Both are kept newest last, at most `FORMS_KEPT`:
    - `cardAnswered(tabId: string, answers: Record<string, unknown>, at: number): void` keeps only 1..`QUESTIONS_MAX` entries whose key and string value are within the bounds. Otherwise it keeps nothing. The id is `card:<n>`.
    - `dialogOpened(tabId: string, questions: readonly string[], at: number): void`
    - `cards(tabId): readonly FormResult[]`, `dialogs(tabId): readonly FormDialog[]` and `drop(tabId): void`
  - `countedForms(o: { cards: readonly FormResult[]; transcript: readonly FormResult[]; dialogs: readonly FormDialog[]; submits: readonly Submit[] }): FormResult[]` returns every card result, then the transcript results that a dialog backs. A dialog backs a result when its question texts equal the result's (as sets, by `normWords`) and `dialog.at <= result.at`, and a submit with `texts === null` has `dialog.at <= submit.at <= result.at + INPUT_SLACK_MS`.
  - `matchForm(o: { asked: readonly string[]; forms: readonly FormResult[]; since: number }): { ok: true; answers: FormEntry[] } | { ok: false; missing: string[]; found: string[] }` looks at the forms with `at >= since`, newest first. Each asked text takes the first entry whose `normWords(question)` equals `normWords(asked)`. `found` holds the distinct question texts of those forms, newest first.
- Produces (`person-words.ts`):
  - `WordsLine` gains `{ kind: 'form'; id: string; at: number; answers: FormEntry[] }`, and `WordsLog.forms(): readonly FormResult[]` keeps the latest `FORMS_KEPT`, once each by id.
  - `export const TAG_TEXT = /^<[A-Za-z][\w-]*[\s>/]/` is the tag rule `promptOf` uses today.
  - `export function isPersonPrompt(text: string): boolean` is `!isClaudeTermText(t) && !TAG_TEXT.test(t)`, where `t` is the text trimmed.
- Produces (`chat-hub.ts`): `ChatHubDeps.questionAnswered?(tabId: string, answers: Record<string, string>): void`. It is called from `answer` and from `answerRemote` when the card is a question and the result allows it with `updatedInput.answers` an object.
- Produces (`tests/fixtures/transcript.ts`): `formResultLine(answers: Record<string, string>, o?: { timestamp?: string; uuid?: string; isSidechain?: boolean }): string`. It builds a user line as Claude Code writes an AskUserQuestion result:
  - a `tool_result` content block;
  - `toolUseResult: { questions, answers }`, with a question per key (`header: 'Q'`, two options, the answer's label first);
  - `uuid` and `timestamp`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/form-answers.test.ts`, with `const r = (at: number, answers: [string, string][]): FormResult => ({ id: `t${at}`, at, answers: answers.map(([question, answer]) => ({ question, answer })) })`:

```ts
it('matchForm: equal after outer whitespace and line endings, nothing else', () => {
  const forms = [r(100, [['docs: Where?\nPick one.', 'Side panel']])]
  expect(matchForm({ asked: ['  docs: Where?\r\nPick one.\n'], forms, since: 0 })).toEqual({ ok: true, answers: [{ question: 'docs: Where?\nPick one.', answer: 'Side panel' }] })
  expect(matchForm({ asked: ['docs: Where!\nPick one.'], forms, since: 0 })).toEqual({ ok: false, missing: ['docs: Where!\nPick one.'], found: ['docs: Where?\nPick one.'] })
  expect(matchForm({ asked: ['docs:  Where?\nPick one.'], forms, since: 0 }).ok).toBe(false)
})
it('matchForm: the newest result first, none older than since', () => {
  const forms = [r(100, [['Q', 'A']]), r(200, [['Q', 'B']])]
  expect(matchForm({ asked: ['Q'], forms, since: 0 })).toMatchObject({ ok: true, answers: [{ answer: 'B' }] })
  expect(matchForm({ asked: ['Q'], forms: [forms[0]!], since: 150 })).toEqual({ ok: false, missing: ['Q'], found: [] })
})
it('matchForm: one form holds the questions of two sessions', () => {
  const forms = [r(100, [['docs: Q1', 'A1'], ['api: Q2', 'A2']])]
  expect(matchForm({ asked: ['api: Q2'], forms, since: 0 })).toEqual({ ok: true, answers: [{ question: 'api: Q2', answer: 'A2' }] })
})
it('countedForms: a card answer counts as it is', () => {
  const card = r(100, [['Q', 'A']])
  expect(countedForms({ cards: [card], transcript: [], dialogs: [], submits: [] })).toEqual([card])
})
it("countedForms: a transcript result counts with the tab's own form of the same questions and a dialog answer of the window after it", () => {
  const result = r(1000, [['Q1', 'A'], ['Q2', 'B']])
  const dialog = { at: 900, questions: ['Q2', 'Q1'] }
  const answer = { at: 950, texts: null, wrote: true }
  expect(countedForms({ cards: [], transcript: [result], dialogs: [dialog], submits: [answer] })).toEqual([result])
  expect(countedForms({ cards: [], transcript: [result], dialogs: [dialog], submits: [{ ...answer, at: 1000 + 5000 }] })).toEqual([result])
  for (const submits of [[], [{ ...answer, at: 899 }], [{ ...answer, at: 1000 + 5001 }], [{ ...answer, texts: ['Q1'] }]])
    expect(countedForms({ cards: [], transcript: [result], dialogs: [dialog], submits })).toEqual([])
  expect(countedForms({ cards: [], transcript: [result], dialogs: [{ at: 900, questions: ['Q1'] }], submits: [answer] })).toEqual([])
  expect(countedForms({ cards: [], transcript: [result], dialogs: [{ ...dialog, at: 1001 }], submits: [answer] })).toEqual([])
})
it('FormRecord keeps the latest 20 per tab, only answers within bounds, and drop forgets the tab', () => {
  const f = new FormRecord()
  for (let n = 1; n <= 21; n++) f.cardAnswered('t', { [`Q${n}`]: 'A' }, n)
  expect(f.cards('t').map((c) => c.at)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2))
  f.cardAnswered('u', { Q: 3 }, 1)
  f.cardAnswered('u', { ['x'.repeat(2001)]: 'A' }, 2)
  f.cardAnswered('u', {}, 3)
  expect(f.cards('u')).toEqual([])
  f.dialogOpened('t', ['Q1'], 5)
  f.drop('t')
  expect([f.cards('t'), f.dialogs('t')]).toEqual([[], []])
})
```

In `tests/unit/person-words.test.ts`:
- "wordsLine reads an AskUserQuestion result as a form, with its answers and its time". Use `formResultLine({ 'docs: Where?': 'Side panel' }, { uuid: 'u-1', timestamp: '2026-11-17T10:00:00.000Z' })`.
- "a sidechain result, one whose answers are not strings or are out of bounds, and a user prompt give no form". The prompt is still a prompt.
- "WordsLog keeps the latest 20 forms, each once, and a form leaves the prompts and their context as they were".
- "isPersonPrompt: the person's text is; a wake block, an auto-continue prompt and a task notification are not".

In `tests/unit/chat-hub.test.ts`, using the file's own fake engine and card setup:
- "a question card answered in the window, or from claude.ai, tells questionAnswered its answers". The answers are as the SDK takes them, and a multi-select is joined with ", ".
- "a permission card, a declined question and a refused answer tell it nothing".

In `tests/integration/transcript-feed.int.test.ts`, next to the existing words lines test: "a transcript on disk with an AskUserQuestion result gives onWords a form line".

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/unit/form-answers.test.ts tests/unit/person-words.test.ts tests/unit/chat-hub.test.ts tests/integration/transcript-feed.int.test.ts`
Expected: FAIL. The module, the `form` kind and the dep are missing.

- [ ] **Step 3: Implement**
  - In `wordsLine`, a line that holds both `"toolUseResult"` and `"answers"` is read as a form before the existing `maybe` test. It must be a `user` line that is not a sidechain, and `toolUseResult.answers` must be an object of 1..4 entries within the bounds. Its time is `Date.parse(timestamp)`, else 0, and its id is its `uuid`, else `at:<time>`.
  - `WordsLog.add` takes a form line with the prompts' rule for a time ahead of the read. It keeps it in its own list, and never touches `answer` or the prompts.
  - `promptOf` uses `TAG_TEXT`.

- [ ] **Step 4: Run the tests again**, the same command, and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Leave uncommitted**; suggested message `feat: the coordinator's form results, from its cards and its transcript, and the window input that backs them`.

### Task 4: The wake texts of a question and of the person's answers

**Files:**
- Create: `src/main/coordinator/question-text.ts`
- Modify: `src/shared/report-wake.ts`, `src/main/mail/wake-text.ts`
- Test: `tests/unit/wake-text.test.ts`, `tests/unit/report-wake.test.ts`, `tests/unit/claudeterm-text.test.ts`

**Interfaces:**
- Consumes: `AskedQuestion`, `PassedAnswer` (Task 1). The test file's own record builder and `senders` (`rec`, `COORD` named `coord`, and `PARSER` named `parser` are the names used below; use the file's own).
- Produces:
  - In `report-wake.ts`: `QUESTION_WAKE_HEAD`, `ANSWER_WAKE_HEAD`, `PERSON_ANSWERS_HEAD`, `PERSON_ANSWERS_CHECKED`, `PERSON_ANSWERS_NOTE`, `PERSON_ANSWERS_QUESTION`, `PERSON_ANSWERS_ASKED` and `ANSWERS_ABOVE`, with the Global Constraints' copy, plus the new `PERSON_WORDS_NOTE`. `WAKE_HEADS` gains `QUESTION_WAKE_HEAD`, `ANSWER_WAKE_HEAD` and `PERSON_ANSWERS_HEAD`.
  - `questionsBody(qs: readonly AskedQuestion[]): string`. For each question, numbered from 1, there is a head line `${n}. ${header ? `[${header}] ` : ''}${question}  (${multiSelect ? 'several answers' : 'one answer'})`. One line per option follows: `   - ${label}${description ? `: ${description}` : ''}`. All the lines are joined with `\n`.
  - `answersBody(answers: readonly PassedAnswer[]): string`. Each answer is `${n}. ${question}\n   The person answered: ${answer}`, and they are joined with `\n`.
  - In `wake-text.ts`:
    - `headerOf` handles `question` (head and id line from the Global Constraints, ref of the sender) and `answer` (head and id line, `questionId` = `r.replyTo`).
    - The `task` id line becomes the new copy.
    - `block()` quotes `ANSWERS_ABOVE` instead of `r.text` for an answer.
    - `answersText(r: MailRecord, senders): string` is three things joined by a blank line. First, the line `${PERSON_ANSWERS_HEAD} ${coordinator name} ${PERSON_ANSWERS_CHECKED}`, then `PERSON_ANSWERS_NOTE`. Second, for each answer: `PERSON_ANSWERS_QUESTION`, its question quoted, `PERSON_ANSWERS_ASKED`, `asked` quoted, `PERSON_WORDS_ANSWER`, the answer quoted. Last, the answer's block.

- [ ] **Step 1: Write the failing tests**

In `wake-text.test.ts`:

```ts
it("a question's block: its head, the sender, the id line that says what to do, and the questions quoted", () => {
  const r = rec({ kind: 'question', replyTo: TASK, questions: QS, text: questionsBody(QS) })
  expect(wakeText([r], senders)).toBe([
    "Question from a session attached to you, through ClaudeTerm: its task waits for the person's answer.",
    `from: parser [${refOf(r.from.session)}]`,
    `id: ${r.id}  (ask the person with AskUserQuestion, in their language, then pass the answers with answer_session "${refOf(r.from.session)}"; read_session "${refOf(r.from.session)}" shows the session)`,
    '',
    '> 1. [Place] Where should the browser live?  (one answer)',
    '>    - Side panel: Next to Changes.',
    '>    - Own tab',
    '> 2. Which parts?  (several answers)',
    '>    - Browser',
    '>    - Cookies'
  ].join('\n'))
})
it("the person's answers typed for a session: the person's lines under their heads, then the answer's block", () => {
  const answers = [{ question: 'Where should the browser live?', asked: 'parser: Where should the browser live?', answer: 'Side panel' }]
  const r = rec({ kind: 'answer', from: COORD, to: PARSER, replyTo: QUESTION_ID, answers, text: answersBody(answers) })
  expect(answersText(r, senders)).toBe([
    "The person's answers, through your coordinator coord (ClaudeTerm checked them in the coordinator's question form):",
    'Only the lines under "The person answered" are the person\'s. They answer the questions you asked with AskUserQuestion: go on with your task.',
    'Your question:',
    '> Where should the browser live?',
    'The coordinator asked the person:',
    '> parser: Where should the browser live?',
    'The person answered:',
    '> Side panel',
    '',
    'Answer from your coordinator, through ClaudeTerm: the person answered your question.',
    `from: coord [${refOf(COORD.session)}]`,
    `id: ${r.id}  (the answer to your question ${QUESTION_ID}; go on with your task: when it is done, end your turn, and ClaudeTerm sends your last answer to the coordinator as your report)`,
    '',
    "> The person's answers are above."
  ].join('\n'))
})
it('the task id line asks for the language of the task and AskUserQuestion', () => {
  // today's expectation of the task block (line 99) becomes:
  expect(lines[2]).toBe(`id: ${ID_1}  (do it, writing in the language of this task, and ask the person only with AskUserQuestion; when it is done, end your turn: ClaudeTerm sends your last answer to the coordinator as your report)`)
})
```

In `report-wake.test.ts`: "the new heads are wake heads, and splitWake keeps a question block in rest".
In `claudeterm-text.test.ts`: "the typed answers, a question block and an answer block are ClaudeTerm's text".

- [ ] **Step 2: Run them to make sure they fail**: `npx vitest run tests/unit/wake-text.test.ts tests/unit/report-wake.test.ts tests/unit/claudeterm-text.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**, as the Interfaces say.

- [ ] **Step 4: Run the tests again**, and `npm run typecheck`. Expected: PASS. Existing tests that import `PERSON_WORDS_NOTE` follow the new copy by themselves. Change any test that spells out the old note or the old task id line to the new copy; do not delete it.

- [ ] **Step 5: Leave uncommitted**; suggested message `feat: the wake texts of a session's question and of the person's answers`.

### Task 5: The coordinator's and the sessions' notes: questions and the person's language

**Files:**
- Modify: `src/shared/coordinator.ts`, `src/main/coordinator/session-text.ts`, `src/mcp/coordinator-tools.ts`, `src/main/coordinator/coordinator-hub.ts` (only its `readText` call passes `question: null`, until Task 8)
- Test: `tests/unit/coordinator-text.test.ts`, `tests/unit/coordinator-tools.test.ts`

**Interfaces:**
- Produces:
  - In `src/shared/coordinator.ts`: `COORD_LANGUAGE` and `COORD_QUESTIONS`, and the new `COORD_PROGRESS`.
  - In `session-text.ts`:
    - `ASK_REASON`.
    - `sessionTurnNoteText(coordinatorName: string): string`, whose name is cut to 40 and made one line, like `turnNoteText`'s.
    - `turnNoteText(project)` becomes `Note from ClaudeTerm, not from the user: you are the coordinator of ${name}: ${COORD_DELEGATE} Reports come by themselves when a task ends. ${COORD_PROGRESS} ${COORD_WORDS} ${COORD_QUESTIONS} ${COORD_LANGUAGE}`.
    - `roleNoteText`'s head becomes `You coordinate ${name} in ClaudeTerm: ${COORD_DELEGATE} ${COORD_LANGUAGE}`.
    - `listText` adds the question note for rows whose `why` is `question`.
    - `readText(row, d: { prompt; report; taskList; question: readonly AskedQuestion[] | null }, clock)` adds `Waiting for the person's answer to its question:` and `questionsBody(question)` after the state lines, when `question` is not null.
  - In `coordinator-tools.ts`:
    - `list_sessions`'s second sentence becomes `A permission prompt waiting in a session is the user's to answer there: tell the user once where it waits, never answer it. ${COORD_QUESTIONS}`.
    - `start_session` and `message_session` end with ` ${COORD_LANGUAGE}`.
    - `read_session` says `its state, a permission prompt or question waiting for the user, a question waiting for the person's answer through you, its open task, its last report in full and its task list.`

- [ ] **Step 1: Write the failing tests** in `coordinator-text.test.ts`:
  - "the turn note gives the questions' rule and the person's language, and no longer sends the person to the session". It contains `COORD_QUESTIONS` and `COORD_LANGUAGE`, and not `A session's permission prompts and questions are the person's to answer, in that session`. It is at most `TURN_CONTEXT_MAX`, with a 100-character project name.
  - "a session's turn note names its coordinator, one line, cut". Expect `sessionTurnNoteText('coord · Desktop')` to equal the Global Constraints' copy with `coord · Desktop`.
  - "the role note carries the language, cut at ROLE_NOTE_MAX as before".
  - "list_sessions notes a waiting question, and read_session shows it in full with its options".

  In `coordinator-tools.test.ts`: "the descriptions carry the questions' rule (list_sessions) and the language (start_session, message_session)".

  Existing assertions on the old `COORD_PROGRESS`, turn note or descriptions change to the new copy.
- [ ] **Step 2: Run them to make sure they fail**: `npx vitest run tests/unit/coordinator-text.test.ts tests/unit/coordinator-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again**, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Leave uncommitted**; suggested message `feat: the coordinator asks the person a session's questions with its form, and writes in the person's language`.

### Task 6: The `questions` capability between paired devices

**Files:**
- Modify: `src/main/sync/wire.ts` (`HelloMessage.questions?: 1`, its parse), `src/main/sync/device-group.ts` (`knowsQuestions?: boolean`, the hello), `src/main/mail/mail-sync.ts` (`MailLink.questions`, `knowsQuestions(device)`, `forLink`), `src/main/index.ts` (the device group's `knowsQuestions: !(isTest && process.env.CLAUDETERM_TEST_NO_QUESTIONS === '1')`)
- Test: `tests/unit/mail-wire.test.ts`, `tests/integration/sync-device-group.int.test.ts`, `tests/integration/mail-sync.int.test.ts`

**Interfaces:**
- Produces:
  - `MailSync.knowsQuestions(device: string): boolean` is true while the device is linked and its hello has `questions: 1`.
  - A link whose peer lacks the flag gets no record of kind `question`, `answer` or `withdraw`. This filter comes on top of today's.

- [ ] **Step 1: Write the failing tests**, mirroring today's words tests:
  - In `mail-wire.test.ts`: "a hello with questions: 1 keeps it; without it or with another value it has none".
  - In `sync-device-group.int.test.ts`: "a device opened with knowsQuestions false leaves questions out of its hello".
  - In `mail-sync.int.test.ts`, with `helloOf` given a `questions` flag:
    - "a peer whose hello has no questions gets no question, answer or withdraw; its tasks and reports still go";
    - "knowsQuestions is true for a linked peer with the flag, false without it and once the link closes".
- [ ] **Step 2: Run them to make sure they fail**: `npx vitest run tests/unit/mail-wire.test.ts tests/integration/sync-device-group.int.test.ts tests/integration/mail-sync.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again**, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Leave uncommitted**; suggested message `feat: devices say whether they know a session's questions, and the mail sync keeps them from those that do not`.

### Task 7: The session's device sends a question to the coordinator and keeps the task waiting

**Files:**
- Modify:
  - `src/main/coordinator/coordinator-store.ts`: `StoredTask.question`.
  - `src/main/coordinator/coordinator-hub.ts`: `HubPeer.questions`, `ask`, `turnEnded`, `turnNote`.
  - `src/main/index.ts`: the `attention` handler, and `questions` in the peers the hub gets.
  - `tests/fixtures/coordinator-world.ts`: `peerOf` gives `questions: true`.
- Test: `tests/unit/coordinator-store.test.ts`, `tests/unit/coordinator-hub.test.ts`

**Interfaces:**
- Consumes:
  - `AskedQuestion` (Task 1);
  - `questionsBody` (Task 4);
  - `ASK_REASON` and `sessionTurnNoteText` (Task 5);
  - `MailSync.knowsQuestions` (Task 6).
- Produces:
  - `StoredTask.question: string | null`: the id of the question record the task waits on. A stored task without the field, or with a value that is no UUID, loads as `null`.
  - `HubPeer.questions: boolean`: its hello says it knows questions.
  - `CoordinatorHub.ask(tabId: string, questions: AskedQuestion[] | null): string | null`. It returns `ASK_REASON` when the question went to the coordinator, else null.
  - `CoordinatorHub.turnNote(tabId)` gives `sessionTurnNoteText(h.coordinator.name)` for a tab whose session holds a delivered or open task. The coordinator still gets its own note.
  - Private:
    - `canAsk(coordinator: MailAddress): boolean`;
    - `setQuestion(session: string, taskId: string, question: string | null): void`;
    - `withdraw(h: StoredHosted, question: string): void`, which writes a `withdraw` record with `WITHDRAW_TEXT`.

`ask` routes only when all of these hold:
- `questions` is not null, and the tab is no coordinator;
- the tab's current task is `open`;
- `questionsBody(questions).length <= MAIL_TEXT_MAX`;
- `canAsk(h.coordinator)`. On this device that means `problem() === null`, a stored coordinator of that session, and a tab of it that has not exited. On a paired device it means the peer is `online && coord && questions && mail`.

It then:
- withdraws a question the task already waits on;
- writes `{ kind: 'question', from: this.address(null, h.session), to: this.address(h.coordinator.device, h.coordinator.session), replyTo: task.id, text: questionsBody(questions), questions }`;
- stores its id in `task.question`, and calls `changed()`.

A record the mail check refuses leaves the task as it was and returns null. `turnEnded` arms no settle timer, and sends no progress note, while the current task's `question` is not null.

In `index.ts`'s `attention` handler, right after `wakeFeed(msg.tabId)`:

```ts
if (msg.reason === 'question' && msg.agentId === undefined) {
  const reason = projectCoordinators.ask(msg.tabId, msg.questions ?? null)
  // the question went to the session's coordinator: no dialog opens in the tab, and the tab gives no signal for it
  if (reason !== null) return { ok: true, info: reason }
}
```

- [ ] **Step 1: Write the failing tests**

In `coordinator-store.test.ts`: "a task's waiting question is kept across a restart, and a task stored before the field loads with none". Put the entry, `flush()`, and load a new `CoordinatorStore` on the same folder.

In `coordinator-hub.test.ts`, a `describe('a session asks its coordinator')` with a helper. It makes tab-c the coordinator, attaches `a10000` and gives it a task. Then it hands the task to tab-1 as a prompt and starts its turn (`handedOver('tab-1', [task], 'prompt')`, `turnStarted('tab-1')`), and returns the task's id. Use two questions `QS` of the shape in Task 4's test.

```ts
it('a session on an open task asks: a question goes to its coordinator, the task waits on it, and the hook gets ASK_REASON', () => {
  const w = world()
  const taskId = onTask(w)
  expect(w.hub.ask('tab-1', QS)).toBe(ASK_REASON)
  const [q] = records(w, 'question')
  expect(q).toMatchObject({ from: { session: S.one }, to: { session: S.coord }, replyTo: taskId, questions: QS, text: questionsBody(QS), delivered: false })
  expect(w.store.hosted(S.one)!.tasks[0]).toMatchObject({ id: taskId, state: 'open', question: q!.id })
})
it('no question goes out, and null comes back, for the coordinator, a session without a task or with a queued one, questions that did not parse or do not fit a record, a coordinator whose tab is gone, or agent messages off', () => { … one world per case, each expecting null and records(w, 'question') empty … })
it("while its question waits, the task's turn end arms no settle and sends no progress note", () => {
  const w = world()
  onTask(w)
  w.hub.ask('tab-1', QS)
  w.hub.turnEnded('tab-1', { background: false, lastMessage: 'I wait for the answer.' })
  expect(w.timers).toEqual([])
  w.hub.turnEnded('tab-1', { background: true, lastMessage: 'I wait for the answer.' })
  expect(records(w, 'progress')).toEqual([])
  expect(records(w, 'report')).toEqual([])
})
it('a second question on the same task withdraws the first and waits on the second', () => { … records(w, 'withdraw') has one, replyTo the first; task.question is the second … })
it("a hub on a store that holds a waiting task does not settle its turn end", () => { … w.store.putHosted with question set, turnEnded, w.timers empty … })
it("a session's turn on its task gets the session's turn note; a session without a task gets none; the coordinator its own", () => {
  const w = world()
  onTask(w)
  expect(w.hub.turnNote('tab-1')).toBe(sessionTurnNoteText('coord · Desktop'))
  expect(w.hub.turnNote('tab-2')).toBeNull()
  expect(w.hub.turnNote('tab-c')).toBe(turnNoteText('acme'))
})
```

- [ ] **Step 2: Run them to make sure they fail**: `npx vitest run tests/unit/coordinator-store.test.ts tests/unit/coordinator-hub.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, as the Interfaces say. Every `StoredTask` the hub creates gets `question: null`.
- [ ] **Step 4: Run them again**, and `npm run typecheck`. Expected: PASS. Tests that `toEqual` a stored task get `question: null`.
- [ ] **Step 5: Leave uncommitted**; suggested message `feat: a session's question on a coordinator's task goes to the coordinator, and the task waits for its answer`.

### Task 8: The coordinator is woken by a question and sees it on the session's row

**Files:**
- Modify:
  - `src/main/coordinator/coordinator-hub.ts`: `accepts`, `mailChanged`, `forwardArrived`, `forwardFormer`, `unroutedReport`'s callers, the rows, `read`.
  - `src/main/coordinator/session-state.ts`.
  - The renderer: `src/renderer/sessions-model.ts`, `src/renderer/sessions-panel.ts`, `src/renderer/mail-panel.ts`.
- Test: `tests/unit/coordinator-rows.test.ts`, `tests/unit/coordinator-hub.test.ts`, `tests/unit/sessions-model.test.ts`, `tests/unit/mail-panel.test.ts`

**Interfaces:**
- Produces:
  - `RowFacts.question?: string | null`: the first question's text of the session's waiting question. The order of `why` becomes prompt, then question, then limit, then failed. A question gives group `waiting`, why `question` and the line `Asks you: ${noteLine(question)}`.
  - `private questionState(c: StoredCoordinator, a: { device: string | null; session: string }, all: readonly MailRecord[]): { record: MailRecord; open: boolean; withdrawn: boolean } | null` finds the newest question from that session to `c`, under its id now or a former one. It is not open when one of these exists:
    - an `answer` or a `withdraw` whose `replyTo` is it;
    - a `report` from the session whose `replyTo` is its task;
    - a `task` the coordinator wrote (`wroteAs`) to the session after it.

    `withdrawn` is true when a `withdraw` replies to it. The view computes it once for every attachment and passes the open ones' first questions to `rowOf` and `attachedRemoteRow`.
  - `accepts` handles a `question` as it does a `progress` note. From another device it needs `takesReport`, and as a prompt it needs a coordinator tab. It never accepts an `answer`.
  - `mailChanged`:
    - a `question` is handled like a progress note: an unrouted one is marked delivered and read, and one to a coordinator here pokes its tab;
    - a `withdraw` to this device marks its question delivered and read when it was not delivered, and calls `changed()`.
  - `forwardArrived` also forwards a `question` (to a coordinator's former id) and an `answer` (to a hosted session's former id). It copies `questions` and `answers`. `forwardFormer` takes questions too.
  - `read` passes the open question's `questions` to `readText`.
  - `kindLabel` gives `question` → `Question` and `answer` → `Answer · your words`.
  - The row's tone for why `question` is the prompt's: `'amber'` in `sessions-model.ts`, and ` warn` in `sessions-panel.ts`.

- [ ] **Step 1: Write the failing tests**

In `coordinator-rows.test.ts`: "a waiting question puts the row in Waiting on you, why question, with Asks you and its first line, cut as a note; a prompt in the tab comes first; a question comes before a limit".

In `coordinator-hub.test.ts`, a `describe("the coordinator's side of a question")`:
- "a question pokes the coordinator's tab, and the session's row and the marks show it waiting". Expect `w.pokes` to contain `tab-c`, `view('tab-c')` to show `S.one`'s row as `{ group: 'waiting', why: 'question', line: 'Asks you: Where should the browser live?' }`, and `marks()` to give `waiting: 1`.
- "the coordinator's tab takes a question as a prompt or from its watcher; a session's tab does not, and no tab takes an answer".
- "read_session shows the question in full, and list_sessions says to ask it and pass it with answer_session".
- "a withdraw marks a question the coordinator has not taken delivered and read, and the row leaves Waiting on you".
- "a report on the task, a new task of the coordinator, or a newer question closes the question on the coordinator's side".
- "a question to a former id of the coordinator is forwarded to its current one".

Also in `sessions-model.test.ts`: the amber tone. In `mail-panel.test.ts`: the two labels.
- [ ] **Step 2: Run them to make sure they fail**: `npx vitest run tests/unit/coordinator-rows.test.ts tests/unit/coordinator-hub.test.ts tests/unit/sessions-model.test.ts tests/unit/mail-panel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again**, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Leave uncommitted**; suggested message `feat: a session's question wakes its coordinator and shows on its row`.

### Task 9: `answer_session`

**Files:**
- Modify:
  - `src/main/coordinator/coordinator-hub.ts`: `HUB_TEXT`, the `forms` dep, `answer`, and `tool` dispatching `answer`.
  - `src/main/index.ts`:
    - one `FormRecord`;
    - the `forms` dep;
    - `formRecord.dialogOpened` for every `attention` of reason `question` that carries `questions`, before `ask`;
    - `ChatHubDeps.questionAnswered` → `formRecord.cardAnswered`;
    - `formRecord.drop` where `personInput.drop` is called.
  - `src/mcp/coordinator-tools.ts`, `src/mcp/show-image-server.ts`, `src/main/claude-tab-settings.ts`.
  - `tests/fixtures/coordinator-world.ts`: `forms: {} as Record<string, FormResult[]>`, the `forms` dep, and `formed(w, answers: [string, string][], o?: { tabId?: string; at?: number }): FormResult`.
- Test: `tests/unit/coordinator-hub.test.ts`, `tests/unit/coordinator-tools.test.ts`, `tests/unit/claude-tab-settings.test.ts`

**Interfaces:**
- Consumes:
  - `matchForm`, `countedForms`, `FormRecord`, `FORM_SLACK_MS` (Task 3);
  - `answersBody` (Task 4);
  - `questionState` (Task 8).
- Produces:
  - `CoordinatorHubDeps.forms(tabId: string): Promise<readonly FormResult[]>`. In `index.ts` it polls the transcript like `prompts`, then returns `countedForms({ cards: formRecord.cards(id), transcript: wordsLogs.get(id)?.log.forms() ?? [], dialogs: formRecord.dialogs(id), submits: personInput.submits(id) })`.
  - `HUB_TEXT.answered`, `noQuestion`, `answeredInTab`, `questionCount`, `notInForm`, `answersTooLong`, and `answerToast(name, line)`, with the Global Constraints' copy.
  - `private async answer(tabId: string, target: string, asked: string[]): Promise<PipeResponse>` checks in this order:
    1. The tab is a coordinator.
    2. `attachedFind`.
    3. The attachment, not a start.
    4. `questionState` is open: refused with `answeredInTab` when it was withdrawn, else with `noQuestion`.
    5. The count is right.
    6. `await this.d.forms(tabId)`. Then check `questionState` again: it may have closed during the await.
    7. `matchForm({ asked, forms, since: q.sentAt - FORM_SLACK_MS })`.
    8. `answersBody` fits `MAIL_TEXT_MAX`.

    It then writes `{ kind: 'answer', from: this.address(null, c.session), to: this.address(att.device, att.session), replyTo: q.id, text: answersBody(answers), answers }`. Each answer is `{ question: <the session's question i>, asked: <the form's question text>, answer }`. It then:
    - toasts `answerToast(name, oneLineText(answers[0].answer, 60))`;
    - logs one info line;
    - pokes the session's tab when it is on this device;
    - calls `changed()`;
    - returns `{ ok: true, info: HUB_TEXT.answered(name) }`.

    A record the mail check refuses gives `notSaved`.
  - The MCP tool `answer_session`, with inputs `session` (a ref or a name from list_sessions) and `questions` (an array of 1 to 4 strings). It sends `{ op: 'answer', session, questions }` with `WORDS_WAIT_MS`. Its description is: `Coordinator only: pass the person's answers to a session's question. First ask the person the session's questions with AskUserQuestion, one form question for each of the session's questions (you may add the session's name, context or a translation). Then call this with questions: the questions exactly as you wrote them in AskUserQuestion, in the order of the session's questions. ClaudeTerm takes the person's answers from your question form, checks that the person gave them, and types them into the session as the person's words; the session goes on with its task.`
  - `mcp__claudeterm__answer_session` joins the tab settings' `allow` list.

- [ ] **Step 1: Write the failing tests**

In `coordinator-hub.test.ts`, a `describe('answer_session')`, built on Task 7's `onTask` and `ask`:

```ts
it("passes the person's answers from the coordinator's form: an answer record to the session, a toast, a poke, and the info", async () => {
  const w = world()
  onTask(w)
  w.hub.ask('tab-1', QS)
  const [q] = records(w, 'question')
  formed(w, [['parser: Where should the browser live?', 'Side panel'], ['parser: Which parts?', 'Browser, Cookies']])
  expect(await w.hub.tool('tab-c', { op: 'answer', session: 'a10000', questions: ['parser: Where should the browser live?', 'parser: Which parts?'] }))
    .toEqual({ ok: true, info: HUB_TEXT.answered('parser · Desktop') })
  expect(records(w, 'answer')).toMatchObject([{ from: { session: S.coord }, to: { session: S.one }, replyTo: q!.id, answers: [
    { question: 'Where should the browser live?', asked: 'parser: Where should the browser live?', answer: 'Side panel' },
    { question: 'Which parts?', asked: 'parser: Which parts?', answer: 'Browser, Cookies' }
  ] }])
  expect(w.toasts).toEqual(['Your answer went to parser · Desktop: «Side panel»'])
  expect(w.pokes).toContain('tab-1')
})
it('refuses, and writes nothing, when no question waits, the person answered in the tab, the count is wrong, a question is not in the form, the form is older than the question, or the answers are too long', async () => { … each refusal's exact HUB_TEXT, records(w, 'answer') empty … })
it('two sessions answered from one form', async () => { … tab-1 and tab-2 each on a task and asking one question; one formed() with both; each answer_session gets its own answer … })
```

In `coordinator-tools.test.ts`: "answer_session sends the answer op and waits as long as words do". In `claude-tab-settings.test.ts`: the allow list holds `mcp__claudeterm__answer_session`.
- [ ] **Step 2: Run them to make sure they fail**: `npx vitest run tests/unit/coordinator-hub.test.ts tests/unit/coordinator-tools.test.ts tests/unit/claude-tab-settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, including the `index.ts` wiring and the MCP registration, with zod: `questions: z.array(z.string()).min(1).max(4)`.
- [ ] **Step 4: Run them again**, `npm run typecheck`, and `npm run build` (the MCP server bundles). Expected: PASS.
- [ ] **Step 5: Leave uncommitted**; suggested message `feat: answer_session passes the person's answers from the coordinator's form to the session`.

### Task 10: The answer is typed into the session, and the other ways a wait ends

**Files:**
- Modify:
  - `src/main/coordinator/coordinator-hub.ts`: `canTakeWords`, `takeWords`, `mailChanged`, `turnStarted`.
  - `src/main/index.ts`: the `turn` handler passes `msg.prompt ?? null`.
  - `tests/fixtures/coordinator-world.ts`: `WorldOptions.dir?: string` opens the world on a folder that already holds a store and mail. Only the world that made the folder deletes it.
- Test: `tests/unit/coordinator-hub.test.ts`

**Interfaces:**
- Consumes: `answersText` (Task 4); `isPersonPrompt` (Task 3).
- Produces:
  - `turnStarted(tabId: string, prompt: string | null = null): void`. A turn whose `prompt` passes `isPersonPrompt` is the person's. When the current task waits on a question, a person's turn:
    - withdraws it;
    - sets `task.question` to null;
    - marks an answer to it that was not typed yet as delivered and read, and logs `coordinator: the answer to ${question} came after the person took over in ${session}'s tab; it is dropped`.

    Any other turn leaves the question waiting.
  - `canTakeWords` and `takeWords` take an answer first. An answer is due when all of these hold:
    - `problem() === null`;
    - the tab is in no turn;
    - its session's current task waits on a question;
    - an undelivered `answer` to this device's session replies to that question.

    `takeWords` marks the answer delivered, sets `task.question` to null, and returns `{ info: answersText(r, sender) }`.
  - `mailChanged`: an `answer` for a hosted session here pokes its tab when its task waits on that question. Otherwise it is marked delivered and read, and logged as `coordinator: an answer to ${replyTo} came for no waiting question of ${session}; it is dropped`.
  - `mailChanged`: a `task` that arrives while the session's current task waits on a question drops that task without a report. It is removed from the hosted entry, and the new task is queued as usual.

- [ ] **Step 1: Write the failing tests**, a `describe('the answer reaches the session, and the wait ends')`:
  - "the answer is typed into the idle session: canTakeWords, then takeWords gives answersText, the question closes, and the next turn's end reports". Give the answer as in Task 9, then:
    - `canTakeWords('tab-1', S.one)` is true;
    - `takeWords` returns `{ info: answersText(answer, sender) }`;
    - `task.question` is null;
    - `turnStarted('tab-1', info)` writes no `withdraw`;
    - `turnEnded` arms a settle, and `fire(w)` writes a finished report.
  - "a turn of the person closes the question: a withdraw goes, and answer_session is refused as answered in its tab". Use `turnStarted('tab-1', 'Use the side panel.')`.
  - "a turn of the person while the answer waits to be typed: the answer is dropped, never typed". Give the answer, then `turnStarted('tab-1', 'my own words')`. Then `canTakeWords` is false, the answer is delivered and read, and the info log says it was dropped.
  - "turns that are not the person's leave the question waiting: a wake block, an auto-continue prompt, a task notification, no prompt at all". Use the `TASK_WAKE_HEAD` block, `CONTINUE_PROMPT`, `<task-notification>…` and `null`.
  - "a task given while a question waits ends the wait: the open task goes without a report, and the new task is next".
  - "an answer for no waiting question is dropped and logged".
  - "a hub on the same store types the answer after a restart". Flush `w.store` and `w.mail`, then `world({ dir: w.dir })`. Its `canTakeWords('tab-1', S.one)` is true, and `takeWords` types the answer.
- [ ] **Step 2: Run them to make sure they fail**: `npx vitest run tests/unit/coordinator-hub.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `PromptDelivery` does not change: an answer goes through `canTakeWords`/`takeWords` like the person's words.
- [ ] **Step 4: Run them again**, plus `npx vitest run tests/unit/prompt-delivery.test.ts`, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Leave uncommitted**; suggested message `feat: the person's answers are typed into the session, and the person's own turn or a new task ends the wait`.

### Task 11: A question and its answer across paired devices

**Files:**
- Modify: `src/main/coordinator/coordinator-hub.ts`, if a rule needs it
- Test: `tests/unit/coordinator-devices.test.ts`

**Interfaces:**
- Consumes: everything above. `deviceWorlds()` and `sync()` from the fixture. Studio (`c`) coordinates; Laptop's (`s`) `tab-l1` is attached and on a task.

- [ ] **Step 1: Write the failing tests**:
  - "a session's question crosses to the coordinator's device; the answer comes back and is typed there". The steps:
    - `s.hub.ask('tab-l1', QS)` gives `ASK_REASON`;
    - after `sync`, Studio's row shows `Asks you`, and `tab-c` is poked;
    - `formed(c, …)` and `c.hub.tool('tab-c', { op: 'answer', … })` give ok;
    - after `sync`, `s.hub.canTakeWords('tab-l1', L.one)` is true, and `takeWords` gives `answersText`.
  - "a coordinator's device that is offline, or whose hello lacks questions, keeps the form in the session's tab". `s.peers = [peerOf(DEV_C, 'Studio', { questions: false })]`, or `{ online: false }`, and `ask` gives null.
  - "the person's turn on Laptop withdraws the question on Studio": after `sync`, Studio refuses `answer_session` with `answeredInTab`.
  - "an answer that arrives after the person's turn closed the question is dropped there". Studio answers, Laptop's person's turn starts, then `sync`. Laptop marks the answer delivered and read and logs it, and `canTakeWords` is false.
  - "a question to the coordinator's former id after its clear is forwarded to its new id".
- [ ] **Step 2: Run them to make sure they fail**: `npx vitest run tests/unit/coordinator-devices.test.ts`. Expected: FAIL where a rule is missing. A test that passes at once still stays, as the record of the rule.
- [ ] **Step 3: Fix what fails.**
- [ ] **Step 4: Run them again**, and the whole unit suite: `npm test`. Expected: PASS.
- [ ] **Step 5: Leave uncommitted**; suggested message `test: a session's question and the person's answer across paired devices`.

### Task 12: End to end on one device

**Files:**
- Create: `tests/e2e/coordinator-questions.spec.ts`
- Modify: `tests/e2e/coordinator-helpers.ts`. Add `askedBy(pipeName, tabId, sessionId, questions): Promise<PipeResponse>`: the hook's attention of reason `question`, with `prompt` set to the first question and `questions`.
- Test: the new spec

**Interfaces:**
- Consumes:
  - `terminalStandInApp`, `coordinatorTranscript`, `makeCoordinator`, `coord`, `turnOf`, `done`, `typedHas`, `waitForMail`, `stillWaiting` and `within`;
  - `formResultLine` (Task 3);
  - `launchChatTab`, `sendMessage`, `userMessages` and `chatState`. For a question card, follow how `chat-cards.spec.ts` scripts and answers one.

- [ ] **Step 1: Write the tests.** Use `questionsApp()`, like `wordsApp()`. Tab 1 is the coordinator, with a transcript. Tab 2's session is attached and given a task that the stand-in shows typed. Then `turnOf(tab2)`.
  - **"a session's question goes to its coordinator, not to its tab; the person's answer in the coordinator's form is typed into the session, and its report follows".** The steps:
    1. `askedBy(tab2)` gives `{ ok: true, info: ASK_REASON }`. The coordinator view's row for tab 2 has why `question` and line `Asks you: Where should the browser live?`. `window.__ct` shows no attention mark on tab 2.
    2. `done(tab2)`. No report comes within 3 s, but the coordinator's mail wait gets the question block (`QUESTION_WAKE_HEAD`, `> 1. [Place] Where should the browser live?  (one answer)`).
    3. The coordinator's own form, as a terminal-view coordinator gives it:
       - `askedBy(tab1, sid1, [the form's question])`, as its hook would;
       - the window answers it with `window.ct.writePty(tab1, '1\r')`;
       - then `formResultLine({ 'parser: Where should the browser live?': 'Side panel' })` is appended to tab 1's transcript.
    4. `coord(tab1, { op: 'answer', session: refOf(sid2), questions: ['parser: Where should the browser live?'] })` is ok. The stand-in's lines for tab 2 show, in order:
       - `PERSON_ANSWERS_HEAD`;
       - `> Where should the browser live?`;
       - `> parser: Where should the browser live?`;
       - `> Side panel`;
       - `ANSWER_WAKE_HEAD`.

       The toast `Your answer went to … «Side panel»` shows.
    5. `turnOf(tab2)` and `done(tab2, { lastMessage: 'Built.' })`. The coordinator gets the report with `> Built.`.
  - **"a line appended to the coordinator's transcript with no dialog answer behind it is refused".** Do the same up to step 2, then append the form line with no `askedBy(tab1)` and no keys. `answer` is refused with `notInForm`, ending `Ask the person with AskUserQuestion first.`, and nothing is typed into tab 2.
  - **"the person writes in the session's tab first: the coordinator's answer is refused".** After step 2, send a `turn` for tab 2 with `prompt: 'Use the side panel.'`. Then `answer` is refused with `answeredInTab`.
  - **"a session without a task asks in its own tab, as before".** `askedBy(tab2)` with no task gives `{ ok: true }` with no `info`, and the row's why is `prompt`.
  - **"the turn notes: the coordinator's carries the person's language; the session's, on its task, the session note".** `turnOf(tab1)`'s info contains `COORD_LANGUAGE`. `turnOf(tab2)` on a task gives `sessionTurnNoteText(<coordinator name>)`.
  - **"chat view: the person's click on the coordinator's question card is the answer passed on".** Two chat tabs, made coordinator and session as in `coordinator-words.spec.ts`. Then:
    - `askedBy(b)` on b's task;
    - the coordinator's turn `ask` is scripted to open an AskUserQuestion card with the form's question;
    - the person presses `1` and Enter;
    - `answer` is ok;
    - `userMessages(l.log)` gets a message that starts with `PERSON_ANSWERS_HEAD` and contains the person's choice.
- [ ] **Step 2: Run them**: `npm run build`, then `node scripts/e2e.mjs tests/e2e/coordinator-questions.spec.ts --workers=1`. Expected: PASS. Then remove the `ask` call from `index.ts`'s attention handler. The first test must fail. Put it back.
- [ ] **Step 3: Run the coordinator e2e suites it touches**: `node scripts/e2e.mjs tests/e2e/coordinator-words.spec.ts tests/e2e/coordinator-tasks.spec.ts tests/e2e/coordinator-report.spec.ts --workers=1`. Expected: PASS.
- [ ] **Step 4: Leave uncommitted**; suggested message `test: a session's question through its coordinator, end to end, in the terminal and the chat view`.

### Task 13: End to end on paired devices, and the README

**Files:**
- Modify: `tests/e2e/coordinator-questions.spec.ts`, `README.md` (the coordinator section)
- Test: the spec

- [ ] **Step 1: Write the tests** with `coordDevices()`. Studio coordinates, and Laptop's session is attached and on a task. Give Studio's coordinator tab a transcript with `coordinatorTranscript`.
  - "a question on Laptop reaches Studio's coordinator, and the person's answer is typed on Laptop". Ask on Laptop's pipe. Studio's mail wait gets the question. Studio's form goes as in Task 12, step 3. `answer` is ok on Studio, and Laptop's stand-in gets the typed answers.
  - "Laptop keeps the form in its tab when Studio does not know questions". Start Studio with `CLAUDETERM_TEST_NO_QUESTIONS=1`. Asking on Laptop gives `{ ok: true }` with no `info`.
- [ ] **Step 2: Run them**: `npm run build`, then `node scripts/e2e.mjs tests/e2e/coordinator-questions.spec.ts --workers=1`. Expected: PASS.
- [ ] **Step 3: Update `README.md`'s coordinator section**:
  - In the paragraph on reports and progress notes, "so the coordinator can tell you where the session waits for you; the report follows when the work is done" becomes "the report follows when the work is done". "Apart from progress notes, nothing else wakes it" becomes "Apart from progress notes and questions, nothing else wakes it".
  - After the paragraph on the person's words, add: "A session working on a coordinator's task never asks you itself. When it asks a question, ClaudeTerm does not open the form in its tab. The question goes to the coordinator, with its options, and the coordinator asks you in its own form and passes your answers back with `answer_session`. ClaudeTerm checks that you gave them: the card you clicked in a chat-view coordinator, or, in the terminal view, a form with those questions that you answered in the coordinator's tab. It then types them into the session as your words, and the session goes on with its task. If you answer in the session's tab first, the coordinator's question is withdrawn. Permission prompts stay in the session's tab. The coordinator writes to you, and the tasks it gives its sessions, in the language you write in, and the sessions answer in it too. A session on your other computer asks through the coordinator once ClaudeTerm there knows questions; until then its form opens in its own tab."
  - In the tools sentence, add `answer_session` after `message_session`.
- [ ] **Step 4: Run the whole suite once**: `npm run typecheck`, `npm test`, `npm run build`, then `npm run test:e2e`. Expected: PASS, apart from the known flakes. Rerun those alone.
- [ ] **Step 5: Leave uncommitted**; suggested message `docs: a session's questions go to the person through the coordinator, in the person's language`.
