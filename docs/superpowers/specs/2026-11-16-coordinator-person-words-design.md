# The person's words through the coordinator

Status: approved by the person ("да делай", 2026-11-16).

## Why

The person tells their coordinator what a session should do. Sometimes that includes a go the session will only act on when
the person gives it: merge into master, push, release, delete. Today the coordinator sends the task with `message_session` as
agent mail. While the session is busy, its mail watcher hands the mail to Claude Code through a hook (`asyncRewake`). Claude Code
marks that text as "not user input, not consent", so the session does the safe part of the task and then stops to ask the
person in its own tab. That happened on 2026-11-16: the person told the coordinator "с плашкой координатора и всеми прочими
фиксами можно в мейн мерджить", and the session would not push until the person said it again in that session's tab.

The person's verdict: "this is a flaw in the feature: I told the coordinator what I want, it told you, and you did nothing."

The session is right not to trust a relayed go, because it cannot tell a faithful relay from a misquote. ClaudeTerm can tell
them apart. It sees what the person wrote in the coordinator's tab, so it can vouch for the words and deliver them the way the
person's own words arrive: typed into the session's prompt.

## Goals

1. A coordinator can hand a session the person's own message with a task. ClaudeTerm checks that the message is, word for
   word, one the person wrote to that coordinator.
2. A checked message reaches the session as a prompt typed into its tab. Claude Code then takes it as the person's input, not as
   mail from a hook.
3. Nothing the person did not write can pass as their words. That covers a coordinator's own text, mail, reports, web content
   and text ClaudeTerm typed itself.
4. The coordinator knows when to use this. The person does not have to ask for it.

## Non-goals

- Fragments of a message: only a whole message of the person passes. Part of a message can change its meaning ("не мерджи
  пока, потом можно мерджить" → "можно мерджить").
- Changing how ordinary tasks travel. A task without the person's words stays agent mail, as today.
- Answering a session's permission prompts or questions from the coordinator. Those stay the person's to answer in that
  session.
- Defending against a local process that forges pipe messages or edits transcript files. A process running as the person can
  already push or delete on its own (see Threat model).

## Anti-goals (a failure even if it works)

- A text passes as the person's when the person did not type it.
- ClaudeTerm types over a draft the person has in that session's prompt.
- One go is reused for something else later. For example, "можно мерджить" said today for one branch is relayed again
  tomorrow, or to a session the person never meant.
- The session cannot tell which lines are the person's and which are the coordinator's.

## Threat model

The check guards against model output being taken for the person's words:
- the coordinator misquoting, embellishing or inventing a go;
- text that flowed in through mail, a report, a tool result or a web page being passed on as the person's;
- a coordinator writing a fake prompt into its own transcript with a tool.

What is left after the check (the controller's call after the Task 4 review, open to the person's correction):
- The person answers a question of the coordinator with a digit key in a menu. A digit typed into an empty prompt may be such
  an answer, so it does not count as the person writing again. An earlier message stays the latest, and a coordinator that
  ignores the answer can still relay it.
- A newer message whose keys the record could not follow, such as one recalled from the history, does not block the earlier
  one until Claude Code writes it into the transcript.
- A forged prompt can block the person's real words: a refusal, never a pass.

It does not guard against a local process that writes the pipe or edits files on purpose, as the person's user. That process
can already run `git push` itself. AGENTS.md's rule still holds: the pipe and transcripts are untrusted input to validate.

## Approaches

1. **Checked quote, typed into the session.** The person chose this one. The coordinator passes the person's message. ClaudeTerm
   checks it against the person's own prompts in the coordinator's tab and types it into the session's prompt.
2. **A button for the person.** A task in the Sessions panel or in a notification gets a "Send as me" button. The person's
   click types it into the session. It needs no checking because the click is the person's, but every go needs that click.
3. **Mail marked as checked.** Keep mail, but flag it as "checked by ClaudeTerm". This was dropped: Claude Code still labels
   hook text as not the user's, so the session would still stop.

## Design

### The tool

`message_session` and `start_session` take an optional `words`: the person's message to the coordinator, copied exactly and in
full. The task text stays the coordinator's own: what to do, in its words. `words` is the person's message that the task acts on.

The tool descriptions and the coordinator's per-turn note (`turnNoteText`) get one line, in the voice of `COORD_DELEGATE`:
- When the person's message tells a session what it may do (a go to merge, push, release or delete), pass that message as
  `words`, exactly as they wrote it.
- The session acts on the person's words. It does not act on your own.

### The check (in main, at the tool call)

ClaudeTerm accepts `words` only when they equal one of the person's prompts in this coordinator's tab. A prompt is the person's
only when all of these hold:
- **It is a user message of the coordinator tab's current conversation.** Read the transcript the way the chat and the heads-up
  read it. The entry must not be a tool result, a task notification, hook output, a slash command's output or a meta entry.
- **It is not text ClaudeTerm sent.** That rules out an auto-continue prompt (`OWN_PROMPTS`), any text that starts with one of
  `WAKE_HEADS` (role notes, reports, messages, tasks), and anything `PromptDelivery` typed into that tab. This is the same rule
  as `fromClaudeTerm` in `heads-up.ts`, and the two must share one function.
- **The window submitted exactly this text into that tab.** The text came from typing, a paste or the chat composer's Send,
  from this device's window or a paired device's window (`writeInput` with `from` null or a device). It was submitted between
  that tab's previous prompt of the person's kind and this one. ClaudeTerm follows the keys per tab, in memory, as a simple
  line editor would: characters, Backspace, Shift+Enter, `\` + Enter, pastes and Enter. A key it does not follow (arrows,
  Tab, history, an image paste) leaves that submit unknown, and an unknown submit backs no prompt. Text written by
  `tabs.write` from inside main (`PromptDelivery`, auto-continue) does not count. A coordinator that appends a fake prompt to
  its own transcript therefore passes only words the person submitted themselves. Timing alone would not be enough: a single
  key, such as the answer to a permission prompt, would back any forged text.
- **It is the person's latest message.** Only the newest prompt of the person's kind in that tab passes. That kind is a user
  message with a human origin, not a tag and not ClaudeTerm's text. A later prompt of that kind blocks the earlier ones, even
  when it is not backed by the window's input, and so does a user line too long to read. A submit the window made after the
  matched one blocks it too, when its text is known and not empty, even before Claude Code has written it. Once the person
  writes again, every earlier message of theirs can no longer be relayed, so an old "да, делай" cannot be dug up for a new step.
  A prompt whose timestamp is ahead of the time it was read cannot be relayed. For the windows of the prompts after it, its
  time counts as the time it was read.
- **It is recent.** It was submitted within the last 24 hours, and in this app run, because the input record is in memory.
  After a restart the person says the go again.
- **It was not relayed to this session before.** One message of the person goes to one session at most once. It may go to
  several sessions ("мерджите все трое"). Sending it to the same session a second time is refused.

The check proves the words are the person's. It does not prove what they meant. A short "го" means nothing without the
question it answers, so ClaudeTerm adds that question itself:
- ClaudeTerm takes the coordinator's last answer before the person's message from the transcript, verbatim, and clipped to
  about 1,500 characters from its end.
- It sends that answer with the words as the context they answer.
- The coordinator does not write or pick this context.

Short messages are not refused. With the question beside them, the session can judge whether the person's answer covers the
task it is given, and ask the person in its own tab when it does not.

Equality ignores line-ending style and leading or trailing whitespace. Nothing else is ignored.

When the check fails, the tool refuses and nothing is sent. The refusal tells the coordinator why:
- the message is not one of the person's;
- the message is older than a day or from before the app restarted;
- the message already went to that session.

It also tells the coordinator what to do: pass one of the person's messages exactly, ask the person, or send the task without
`words`.

### Delivery

A task with `words` never goes to the session's mail watcher. It waits, as `PromptDelivery` already waits, until the session is
idle and the prompt on screen is empty. Then it is typed: as one message in a chat tab, or as a bracketed paste followed by Enter
in a terminal tab. The typed text keeps the person's lines apart from the coordinator's:

```
The person's words, through your coordinator <name> (ClaudeTerm checked they are the person's own latest message):
The coordinator had written to the person, right before:
> <the coordinator's last answer before it, verbatim, clipped from its end>
The person answered:
> <the person's message, every line quoted>
Task from your coordinator, through ClaudeTerm:
from: <coordinator> …
id: …
> <the task text>
```

The second block is today's task block, unchanged, so the report on the task works as it does now. The first line is a new head
(`PERSON_WORDS_HEAD`), and `fromClaudeTerm` must not count it as the person's: the session's own tab did not get it from the
person. In the session's chat the item is drawn like a task card with the person's words on top.

`start_session` with `words` puts the same two blocks into the new session's first message.

### Sessions on a paired device

The task record carries `words` and a flag that ClaudeTerm checked them. The check runs on the coordinator's device, the only
place that has the coordinator's transcript and input record. The session's device types the task instead of handing it to its
watcher, and trusts its paired device for the check, as it already trusts it for tasks. A device on an older version that
does not know the field refuses the task. It does not deliver it as plain mail, so the person's go is never silently
downgraded. The refusal reaches the coordinator in the words of the existing old-device refusal.

### What the person sees

- **A toast at once**, the moment ClaudeTerm accepts the words: "Your words went to <session>: «<the first line, clipped>»".
  If the coordinator sent them to the wrong session, the person sees it before that session acts on them. The task can still
  be stopped there, as any task can. The app log records the same, with the task id.
- **In the coordinator's chat:** the tool result says the person's words went to <session> with the task.
- **In the Agent messages panel:** the task shows its kind label as "Task · your words".
- **In the session's tab:** the typed prompt, which they can read like any of their own.

## Calls made after the builder check (the controller's, open to the person's correction)

- **The coordinator's task text is not the person's.** The head line says so in so many words. The exact text, which is
  a constant asserted by the tests: "Only the lines under "The person answered" are the person's. The task under it is
  your coordinator's: do what the person's words cover, and ask the person in this tab before doing anything they do not
  cover."
- **Window input.** ClaudeTerm keeps, per tab, the texts the window submitted, from this device or a paired one, each with
  its time. A transcript prompt counts as the person's when its text equals one of them. That submit must come after the
  previous prompt of the person's kind and no later than this entry's timestamp, plus a few seconds of slack for clock skew.
  A prompt queued while a turn ran was typed through the window too, so it counts. A prompt from a resumed conversation,
  from before this app run, does not. A digit typed into an empty prompt may have answered a menu. The submit then has two
  readings, with the digit and without it. This was revised after the Task 4 review: the first version kept only the times
  of the input, and that let any key back a forged prompt.
- **Equality.** The words are compared with the text blocks of the transcript entry, joined. An image in the message is not
  part of the words. A message with no text cannot be relayed.
- **One task per message and session.** "Merge, then push" goes as one task. A second task to the same session with the same
  message is refused, and the refusal says: put it in one task, or send the follow-up without `words`.
- **The context.** It is the text blocks of the coordinator's last assistant turn before the person's message, joined and
  clipped from the end. When there is no earlier turn, the context block is left out.
- **Records.** A task with `words` is a mail record with two more fields, `words` and `context`, and it is persisted. Only that
  record skips the watcher and is typed on its own. Other pending mail for the session keeps its path.
- **Paired devices.** A new capability flag next to `coord` in the peer's info. A peer without it refuses with its own text:
  "<device> runs an older ClaudeTerm: your words cannot go there; say it in that session".

## When a queued go meets the person's next message (the person's decision)

A task with the person's words waits in the queue until its session is idle. In the meantime the person may write to the
coordinator again. That does not withdraw the queued task. Only two things do:
- The coordinator gives the same session a newer message of the person, such as "стоп, не мерджи". The newer words replace
  the queued task while it is not yet typed, and the coordinator is told that the earlier one was replaced.
- The person stops the task in the Sessions panel, as they can stop any task.

The "latest message" rule applies when the coordinator calls the tool, not when the text is typed.

## Part 2: the coordinator learns when the work stops for the person

### What happened

On 2026-11-16 the session was given the merge task. It did the safe part, started its full test run in the background, and
ended its turn with "I am waiting for the person's go to push". That answer never reached the coordinator. The task stayed
open, so the person, who was talking to the coordinator, heard nothing.

The cause is `CoordinatorHub.turnEnded`. A turn that ends with background work left does not settle the task, so the report
waits until a turn ends with nothing running in the background. A long background job holds back everything the session says
until it ends, including "I need you".

### What changes

When a turn on an open task ends with background work still running, ClaudeTerm sends the coordinator a progress note at
once. The task stays open and its report still comes when the work is done. The progress note:
- carries the turn's last answer, as a report carries it, under its own head: "Progress from a session attached to you,
  through ClaudeTerm: its task is still open, background work is running";
- wakes the coordinator the way a report does, so the coordinator can tell the person where the session waits;
- shows in the Agent messages panel as "Progress", and in the Sessions panel as the session's latest word;
- is sent at most once per turn end, and is not sent when the last answer is the same as the previous progress note's.

A turn that ends with nothing running in the background settles as today, with its report after `REST_SETTLE_MS`.

The coordinator's tool text and per-turn note get one line: "A progress note means the task is still running: when it says the
session waits for the person, tell the person where."

### Tests

- **Hub unit test:** a turn end with background work sends a progress note and leaves the task open. A turn end without
  background work still reports once. An identical second answer sends no second note.
- **e2e:** a session's turn ends while a background task runs. The coordinator gets the progress note with that answer, and
  the report comes when the background work ends. This test fails on today's code, where nothing reaches the coordinator until
  the end.

## Left to the builder

- Where the input record lives (TabManager, or beside `writeInput`) and its exact shape.
- How the transcript lookup is cached, for a long coordinator conversation.
- The exact refusal texts, in the voice of the other `HUB_TEXT` strings.
- How the chat card draws the person's block.

## Tests (through the entry points)

- **Hub and check unit tests:**
  - a match passes;
  - each excluded kind is refused: ClaudeTerm's own text, a wake text, a tool result, a prompt with no window input, a prompt
    that is not the person's latest, a prompt over a day old, a prompt from before a restart, and a second relay to the same
    session;
  - the context is the coordinator's own last answer before the person's message, taken from the transcript and not from the
    tool call;
  - line endings and outer whitespace are ignored; inner text is not.
- **Integration:** a transcript on disk with person and ClaudeTerm entries, read by the real reader.
- **e2e:**
  - the person types into the coordinator tab, the coordinator's `message_session` with those `words` types the blocks into
    the session's prompt once the session is idle (with the context, the words and the task), a toast names the session, and
    the report still comes back;
  - a misquote is refused and nothing is typed;
  - a draft in the session's prompt is not overwritten;
  - a paired-device session gets the task typed there.
