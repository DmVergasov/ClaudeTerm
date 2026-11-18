# A session's questions go to the person through its coordinator, in the person's language

Status: the choices are the person's, given through their coordinator on 2026-11-17: the question path, the go through the
form, the language, and, after the builder check, where the person's answer comes from. The calls under "Calls made" were
agreed by the coordinator and still wait for the person's reading of this document.

## Why

On 2026-11-17 the person worked with a coordinator and four sessions. Two things went wrong.

**Questions.** The session "Built-in browser" ended a turn with a question to the person, written as text. ClaudeTerm showed it
as "Finished · report ready", not as waiting for the person. The coordinator did what its role tells it
(`session-text.ts:22`: "A session's permission prompts and questions are the person's to answer, in that session";
`COORD_PROGRESS`: "tell the person where"): it retold the question in prose and wrote "answer in its tab". The person asked why
the question was not asked with a form, and called it a flaw of the coordinator. Asked again, a session then used AskUserQuestion
in its own tab, and the person called that a bug too: "ты запустил сессию, вопросы должен писать ты а не эта сессия мне". The
person talks to the coordinator, not to the sessions. A form open in a session also blocks the coordinator: messages reach a
session only when it is idle, so the coordinator had to ask the person to close the form by hand.

Today ClaudeTerm already sees a session's AskUserQuestion (the `PreToolUse` hook reports it as an `attention` of reason
`question`), but it passes only the first question's text, as one line, to the session's row. Nothing wakes the coordinator.

**Language.** The coordinator switched to English mid-conversation ("ты в моменте начал на английском писать"). Its transcript
shows the switch at its 2026-11-17 14:07 UTC answer. It came after a run of English context: ClaudeTerm's notes and tool results,
an English failure report from a session, and the coordinator's own English tasks to sessions. It stayed English for four answers,
even after Russian reports, until the person wrote again. Its tasks to sessions, which the person reads in the sessions' tabs,
were English until the person complained. Nothing in the role note, the per-turn note or the tool texts says which language to
use.

## Goals

1. A session working on a coordinator's task never asks the person itself, by form or by text. Its question, with its options,
   goes to the coordinator, the coordinator asks the person with its own form, and the answer comes back to the session, which
   goes on with the same task.
2. Permission prompts stay in the session's tab. The coordinator never answers one: this is a security boundary.
3. An answer the person chose in the coordinator's form reaches the session as the person's own words, checked by ClaudeTerm, so
   the session may act on a go (merge, push, release, delete) given that way.
4. One question is answered once: an answer that came another way closes the question, and a late answer is refused.
5. The coordinator writes to the person, and the tasks it gives sessions, in the person's language. Sessions write in the
   language of their task.

## Non-goals

- Sessions that have no coordinator, or are not working on a coordinator's task: their AskUserQuestion works as today.
- The coordinator's own questions: its AskUserQuestion is never intercepted.
- Plan approval (ExitPlanMode) and permission prompts: they stay in the session's tab.
- A language setting. The language comes from the person's own messages.
- Parsing questions out of a session's prose.

## Anti-goals (a failure even if it works)

- A question that is lost: neither asked in the session's tab nor delivered to a coordinator who can ask it.
- A coordinator able to pass its own words as the person's answer.
- An answer typed into a session that has moved on: the person answered in the tab, the task ended, or a newer question replaced it.
- A session left waiting forever with no way out: the person can always type into the session's tab.
- A coordinator that ends up answering permission prompts.

## Approaches

The person chose the first one.

1. **Intercept AskUserQuestion (chosen).** The session calls its usual AskUserQuestion. ClaudeTerm's `PreToolUse` hook denies the
   call and passes the questions to the coordinator. The session is told to end its turn. The answer comes as its next message.
   This catches every way a session asks with a form, including skills that tell it to (brainstorming does). Cost: the hook
   answers Claude Code with a decision for this one tool, a second exception to "the hook never prints to stdout", next to the
   coordinator's `UserPromptSubmit` context.
2. **A new tool `ask_coordinator`.** Gives a clear contract, but sessions and skills keep calling AskUserQuestion out of habit,
   so the form would still open in tabs unless it were also intercepted.
3. **A question marked in the report's text.** No new mechanics, but ClaudeTerm would have to parse prose, and the options and
   multi-select lose their shape.

Keeping the form open in the tab while the coordinator gets a copy was ruled out by the person ("вопросы должен писать ты"),
and it would leave the session blocked behind the form.

## Design

### Which questions go to the coordinator

ClaudeTerm routes a session's AskUserQuestion to its coordinator when all of these hold:

- the tab is no coordinator, and the call comes from the main conversation (no `agent_id`);
- the tab's session is hosted (attached to a coordinator) and has a current task that is open;
- the questions parse within the bounds below, and their text for the coordinator fits a mail record (`MAIL_TEXT_MAX`);
- the coordinator can take a question now. On this device, its tab is open and `coordinatorProblem` is null. On a paired device,
  that device is linked now and its hello says it knows questions (`questions: 1`).

Otherwise nothing changes: the form opens in the session's tab, as today. That includes ClaudeTerm not running: the hook gets no
answer and prints nothing.

Bounds, so the hook's pipe line stays below the pipe's 64 KB and the question survives the mail sync: 1 to 4 questions; each
question 1 to 2000 characters (a coordinator's own form questions carry context, and its hook reports them too), `header` at most 50, `multiSelect` a boolean; 2 to 4 options per question, each `label` 1 to 200
characters and `description` at most 500. A question that does not fit is not cut: it opens in the tab.

### The hook

The `PreToolUse` hook for AskUserQuestion sends the `attention` (reason `question`) as today, with the first question's line in
`prompt`, and adds the whole `questions` (question, header, multiSelect, options with label and description). The pipe parser
checks them against the bounds and drops a `questions` that does not fit, so the attention itself still counts.

Main answers at once. When it routes the question, its answer carries `info`: the reason the session's Claude reads. The hook then
prints one line and exits 0:

```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<info>"}}
```

With no `info`, an error or no answer, it prints nothing. The reason tells the session that ClaudeTerm sent the questions to its
coordinator, who asks the person, that it must not ask them again (by form or by text), that it should end its turn now with one
short line saying it waits for the person's answer, and that the answer comes as its next message and its task goes on then.

The `UserPromptSubmit` hook's `turn` message gains `prompt`, the head of the prompt cut to 300 characters, so that main can tell
a turn of the person from ClaudeTerm's own (see "Other ways the wait ends").

When main routes a question, the session's tab gets no dialog and no "question" attention: no notification, no mark, and the
tab's waits stay empty. The coordinator's tab is the one that gets the person's attention, when its own form opens.

### The question note

Routing writes a mail record of a new kind, `question`, from the session to its coordinator. `replyTo` is the open task. It
carries the structured `questions` and a `text` written from them. It wakes the coordinator the way a progress note does: handed
to its watcher, or typed as a prompt. Its block:

```
Question from a session attached to you, through ClaudeTerm: its task waits for the person's answer.
from: Built-in browser [382524] (folder …, branch …)
id: <id>  (ask the person with AskUserQuestion, then pass the answers with answer_session "382524"; read_session "382524" shows the session)

> 1. [Где браузер] Где в ClaudeTerm должен жить браузер Claude-вкладки?  (one answer)
>    - Боковая панель (Recommended): Панель справа, как Changes и Docs. …
>    - Отдельная вкладка: …
> 2. [Фазы] …  (several answers)
>    - …
```

The hosted task records the open question (its record id and time), and the store keeps it across a restart. While it waits:

- the turn's end does not settle the task: no report, and no progress note even with background work running;
- the session's row is in "Waiting on you", with a new reason `question`, an amber tone like a prompt's, and the line
  `Asks you: <the first question, one line>`;
- `read_session` shows the questions in full, with their options;
- the coordinator's notes and `list_sessions` say what to do with it (see "Texts").

A second AskUserQuestion on the same task replaces the waiting question: the older one is withdrawn (below), and the newer one
is sent.

### answer_session

A new coordinator tool: `answer_session(session, questions)`. `questions` holds the questions the coordinator asked the person,
as it wrote them in its AskUserQuestion, one for each of the session's questions and in their order. The coordinator may phrase
them its own way: add the session's name, context, or a translation.

In main, at the call:

1. The session is attached to this coordinator and has a waiting question addressed to it. Otherwise the call is refused and
   says why: no question waits, the person answered it in the session's tab, or it was replaced or ended with its task.
2. `questions` has as many entries as the session's question.
3. ClaudeTerm takes the coordinator's form results that came after the question was sent, minus a slack of two minutes for a
   paired device's clock. A result is the questions as the coordinator asked them and the person's answers. It counts only as
   "Where the person's answer comes from" below says: a card answer ClaudeTerm saw, or a transcript result backed by the window.
4. Each given question, compared with surrounding whitespace removed and line endings made LF, must be a question of those
   results, the newest one first. Its answer is the person's: an option's label, several labels joined by ", ", or the text they
   typed. A question that is not found refuses the call and lists, cut short, the questions the form results do hold.
5. ClaudeTerm writes a record of a new kind, `answer`, to the session. `replyTo` is the question. For each of the session's
   questions it carries the question as the coordinator asked it and the person's answer. The waiting question closes.

The tool's answer says the person's answers went to the session. The person gets a toast like the words' one: "Your answer went
to <session>: «<the first answer, clipped>»".

The answer is never handed to the session's watcher. It is typed into the session's prompt by `PromptDelivery` once the tab is
idle and its prompt empty, the way the person's words are, so Claude Code takes it as the person's input. The session is idle
already: it ended its turn after the denied call. The typed text keeps the person's lines apart:

```
The person's answers, through your coordinator <name> (ClaudeTerm checked them in the coordinator's question form):
<a note: only the lines under "The person answered" are the person's; they answer the questions you asked; go on with your task>
Your question:
> <the session's question 1>
The coordinator asked the person:
> <question 1 as the coordinator asked it>
The person answered:
> <answer 1>
… (the same three parts for each question)
Answer from your coordinator, through ClaudeTerm: the person answered your question.
from: <coordinator> [<ref>] (folder …, branch …)
id: <id>  (the answer to your question <question id>; go on with your task: when it is done, end your turn, and ClaudeTerm sends your last answer to the coordinator as your report)

> <one short line, e.g. "The person's answers are above.">
```

The turn this starts goes on with the same task. At its end the task settles and reports as any task does, unless it asks again.

### Other ways the wait ends

- **The person writes in the session's tab.** Only a turn the person starts closes the question. A turn is the person's when
  its prompt is not ClaudeTerm's own text (a wake block, an auto-continue prompt, a forwarded message: `isClaudeTermText`) and not
  a tag such as a task notification (the tag rule `person-words.ts` uses). To tell, the `turn` message carries the head of the
  prompt: `UserPromptSubmit`'s `prompt`, cut to 300 characters. That covers the person's typing in this window or a paired
  device's, and a prompt they send through Remote Control. These turns do not close it:
  - mail handed to the session's watcher, which starts no `UserPromptSubmit`;
  - mail and the answer typed by ClaudeTerm, which start with a wake head;
  - background work that wakes the session;
  - an auto-continue prompt.

  When a turn of the person closes the question, the session's device sends a signal of a new kind, `withdraw` (`replyTo`: the
  question). Like attach and detach, it tells a device, not a model: it is never handed over, counted or listed. On the
  coordinator's device, a question not yet handed to the coordinator is marked delivered and read, so it never wakes it. A later
  `answer_session` is refused: "the person answered <session>'s question in its tab". An answer that `answer_session` already
  sent but ClaudeTerm has not typed yet is dropped and logged. The person took over in the tab, and they saw both.
- **The coordinator gives the session a task (`message_session`) instead.** For instance, the person answered in a message, not
  the form. The new task ends the wait: the open task closes without a report (its last answer only said it waits), the question
  closes, and the new task is delivered as usual, with the person's words when they are passed. Its report comes when it ends.
- **The task ends otherwise:** stopped, failed, cleared, Claude Code exits, the tab closes, or the session is detached. The
  question closes with it. The report that ends the task closes it on the coordinator's side, or the detach does.
- **An answer that arrives after the question closed** (on a paired device, an answer can cross a withdraw) is dropped and
  logged, never typed.

### Where the person's answer comes from (the person's choice: the window first, weaker in a terminal)

The person first chose "checked against the coordinator's form result in its transcript". The builder check found a flaw in the
reason this document first gave, that "Claude Code writes these lines, not the coordinator's Claude". The coordinator's Claude can
append a line to its own transcript file with a tool. The person's-words design treats exactly that as a threat ("a coordinator
writing a fake prompt into its own transcript with a tool"), and guards against it with the window's own input. Asked again
with that in view, the person chose "Окно; в терминале слабее" (2026-11-17).

A form result counts for `answer_session` when it is one of these two:

- **A card answer ClaudeTerm saw (a chat-view coordinator).** When the person answers a question card in the coordinator's tab,
  the answer goes through main: `ChatHub.answer` from the window (this device's or a paired device's), or `answerRemote` from
  claude.ai. Main keeps the latest 20 such answers per tab, in memory, each with its time and its questions and answers, as
  `updatedInput.answers` holds them. ClaudeTerm knows the exact choice, and nothing written to a file can change it. On
  2026-11-17 the person's coordinator ran in the chat view: every line of its transcript has `entrypoint: sdk-ts`.
- **A transcript result backed by the window (a terminal-view coordinator).** The form is Claude Code's own dialog, and ClaudeTerm
  cannot see which option the keys chose. A transcript result counts only when all of these hold:
  - the coordinator tab's own `PreToolUse` attention reported a form whose question texts are the result's;
  - the attention came no later than the result's time;
  - the window then gave that tab a dialog answer (a `PersonInput` submit with no text) after the form opened and at most
    `INPUT_SLACK_MS` after the result's time.

  Main keeps the latest 20 forms each tab's hook reported.

Card answers keep only to this app run, like the person's words. After a restart the coordinator asks again.

**What is left (written down at the person's request).**
- **The terminal view.** A coordinator's Claude that deliberately rewrites its own transcript can swap the option the person
  chose, but only for a form the person really answered, with these questions, in that tab. It cannot invent an answer to a
  form that never opened or that the person never answered.
- **The chat view.** Nothing in a file changes the answer. As everywhere in ClaudeTerm, a local process that writes the pipe on
  purpose, as the person's user, is out of scope.

### Questions in text, and older sessions

A session that still ends its turn with a question in its text finishes its task as today. ClaudeTerm does not parse the text.
The coordinator's role says what to do: when a report or a progress note ends with a question to the person, ask the person
with AskUserQuestion and give the answer to the session with `message_session`.

Sessions learn the rule three ways:

- the task's id line says to ask the person only with AskUserQuestion and to write in the task's language;
- a new per-turn note for a session on an open coordinator task, given as the `UserPromptSubmit` context the way the
  coordinator's turn note is: "you work on a task from your coordinator; the person talks to you through it; ask them only with
  AskUserQuestion, which ClaudeTerm passes to the coordinator, never as a question in your answer; write in the language of your
  task";
- the deny reason, when the session asks.

### Sessions on a paired device

The hello gets a `questions: 1` flag, sent by a device that knows the three new kinds. The mail sync sends `question`, `answer`
and `withdraw` only to a device that says it knows them, as it does for progress notes and words. A received record is checked
like any other, with its `questions` or answers within the bounds above.

The check of the answers runs on the coordinator's device, the only one with the coordinator's transcript. The session's device
trusts an `answer` from its paired device as checked, as it trusts a task's words today. A session whose coordinator's device is
offline, or does not know questions, keeps the form in its tab.

When the coordinator gets a new session id (a clear, a compaction, a replacement), its waiting questions follow it like reports
and progress notes do.

### What the person sees

- **In the session's tab:** no form opens. Claude's AskUserQuestion call shows ClaudeTerm's reason, and Claude ends its turn
  with a line that it waits for the answer. When the answer comes, it is typed in and the session goes on.
- **In the coordinators' panel:** the session's row moves to "Waiting on you", amber, `Asks you: <question>`.
- **In the coordinator's tab:** the coordinator is woken with the question and asks it in its own form, in the person's
  language. Once the answer is passed on, a toast says where it went.
- **In the Agent messages panel:** the question and the answer show with the kind labels "Question" and "Answer · your words".
  A withdraw is not shown.

### Part 2: the language

One sentence, `COORD_LANGUAGE`, goes into the coordinator's per-turn note, its role note, and the `start_session` and
`message_session` descriptions: write to the person in the language of their own messages, even when reports, notes and tool
results are in English, and write the tasks you give sessions in that language too, because the person reads them in the
sessions' tabs. A session is told to write in the language of its task, in the task's id line and in its per-turn note. The
question note asks the coordinator to ask the person in their language.

ClaudeTerm's own notes stay English, as AGENTS.md requires for every string it writes.

### Texts that change

- `turnNoteText` (`session-text.ts:22`): permission prompts stay the person's, in the session; a session's questions come as
  question notes, to be asked with AskUserQuestion and answered with `answer_session`; a question at the end of a report or a
  progress note is asked with AskUserQuestion and answered with `message_session`; and `COORD_LANGUAGE`.
- `COORD_PROGRESS`: a progress note means the task is still running. When it asks the person something, ask them with
  AskUserQuestion. "Tell the person where" goes.
- `list_sessions` and `read_session` descriptions and `listText`'s notes: a permission prompt is the person's, in the session; a
  waiting question is to be asked and answered with `answer_session`.
- `PERSON_WORDS_NOTE`: "ask the person in this tab before doing anything they do not cover" becomes "ask the person with
  AskUserQuestion before …".
- The task's id line, the role note (`roleNoteText`) and the tool descriptions: `COORD_LANGUAGE` and the question rule as above.
- New heads (the question's block, the answer's block, the person's answers) join `WAKE_HEADS`. Then `isClaudeTermText` never
  takes them for the person's text, and the chat can draw them.
- `mcp__claudeterm__answer_session` joins the tab settings' allowed tools, next to the other coordinator tools.

## Calls made (agreed by the coordinator, open to the person's correction)

- **Dedup:** an answer that came another way (in the tab, or a new task) closes the question, and a late `answer_session` is
  refused with the reason.
- **The whole question:** up to four questions with options, descriptions, headers and multi-select, asked one-to-one.
  Multi-select answers are joined with ", ", as Claude Code does.
- **The fallback:** the form stays in the session's tab whenever the coordinator cannot take a question right now.
- **Text questions:** the role rule; ClaudeTerm does not parse text.
- **The check:** the coordinator names the form questions it asked, so it may phrase them its own way. The answer always comes
  from the form result, never from the coordinator's call. Where that result comes from is the open question above. The session
  sees both its own question and the question as asked, so a misleading rephrasing is in plain view.
- **A task instead of an answer** ends the wait and closes the open task without a report.
- **A toast** for an answer passed on, as for the person's words.
- **Only the person's turn closes a waiting question** (after the builder check). Mail, background work, auto-continue and
  the answer's own delivery do not. An answer already sent but not yet typed when the person takes over is dropped and logged.

## Left to the builder

- The exact wording of the deny reason, the notes and the tool texts, within what this document says they must say.
- The name of the store field for a waiting question and its record checks.
- How the coordinator's form results are kept from the transcript feed: next to the person's prompts in `WordsLog`, or beside
  it. Keep a bounded number of the latest. Results the transcript had before the app started are read too, but no window
  input of this run backs them, so they never count.
- Whether a remote `answer` that arrives for a closed question needs anything beyond a log line.

## Tests (through the entry points)

Each one fails without the change.

- **Unit.**
  - The hook's message carries `questions` within the bounds.
  - The hook's printed decision: printed when main's answer has `info`, nothing otherwise.
  - The pipe parser keeps or drops `questions`.
  - The hub routes or falls back for each condition above.
  - A turn's end with a waiting question neither settles nor sends a progress note.
  - `answer_session`'s checks, each refusal included.
  - The answer's typed text and its heads.
  - The question closes on a person's turn, a new task, a second question or the task's end.
  - The row's group, reason, tone and line.
  - The question's wake block.
  - The form-result reading of a transcript line.
  - Which results count: a card answer the window or claude.ai gave counts; a transcript result counts only with the tab's own
    form and a dialog answer of the window; a forged line with neither is refused.
  - The language sentence in the turn note, role note, task id line and session turn note.
  - The mail sync's filter by `questions`, and the hello flag.
- **Integration.**
  - The real hook script with a pipe server that answers with `info` prints the decision line and exits 0.
  - With an answer without `info`, with no server, or with a slow one, it prints nothing and exits 0 quickly.
  - A transcript on disk with an AskUserQuestion result is read by the feed into the form results `answer_session` checks.
- **End to end, the answer's source.** In a chat-view coordinator, the person's click on the question card is what
  `answer_session` passes. A line appended to the coordinator's transcript with no card or dialog answer behind it is refused.
- **End to end**, on the terminal stand-in and in a chat tab:
  - A session on a task asks (its hook's attention with questions). No dialog wait or notification shows in its tab.
  - The coordinator gets the question block typed or handed to its watcher, and the row shows `Asks you: …`.
  - The coordinator's transcript gets a form result, and `answer_session` passes it. The session's prompt gets the person's
    answers typed, and the toast shows. The session's next turn end reports to the coordinator.
  - Typing into the session's tab first makes `answer_session` refuse.
  - A session whose coordinator cannot take questions keeps today's dialog wait.
  - The coordinator's turn note carries the language sentence.
  - On two paired devices: the question and the answer cross. A device without the `questions` flag keeps the form in the tab.
