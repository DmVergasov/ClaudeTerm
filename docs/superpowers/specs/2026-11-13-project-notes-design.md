# Project notes, a note editor, and notes for Claude — design

## Why

A Claude tab's Note holds what the person keeps beside one conversation: which feature it is, a short TODO list. Work on a
project outlives any one conversation: a release checklist, how to reach the test server, decisions to remember. Today
that has nowhere to live in ClaudeTerm. The person also wants the note to be a small editor instead of a bare text box: a
card they can make bigger, with real checkboxes for TODO items. And Claude should be able to read the notes and keep them
up to date (add an item it found, tick off what it finished), so the list is the shared state of the work.

## Goals

1. **Project notes.** One note per project, shared by every Claude tab of that project, its worktrees included. It sits
   beside the session note, in the same card.
2. **A small editor.** The card can be resized by dragging its corner, and the note can hold checkboxes, shown as real
   checkboxes, ticked with a click.
3. **Notes for Claude.** The bundled `claudeterm` MCP server lets Claude read both notes of its tab and add to them and
   tick items, without erasing or rewriting the person's text.

## Non-goals

- Rich text beyond checkboxes and bullet items: no headings, bold, links or tables.
- Syncing a project note to other devices (paired devices, remote tabs). A project's key is a local path, which differs
  between machines. Session notes keep syncing as today.
- A project note for a folder outside git: such a tab is in "No project" in the tab list, and has no project note.
- Telling which lines Claude wrote.

## Anti-goals

- Claude never loses or changes the person's text. Its edits only add text at the end or tick (and untick) items.
- An edit is never lost to another one: neither Claude's nor the person's, even when both come at the same moment.
- The note keeps being plain text a person can read anywhere: what is stored is Markdown, `- [ ] item`, `- [x] item`,
  `- item`.

## What the person sees (approved mockups, variant A)

The mockups are in the conversation of 2026-11-13; variant A was chosen over a side panel (B) and a note on the project's
group in the tab column (C).

- **One card, two notes.** The Note button in the tab's header and `Ctrl+Shift+N` / `⌘N` open the same card as today, over
  the top right of the terminal or the chat. Its header gets a switch, **Session | Project**. Each side shows its count
  when its note has checkboxes: ticked of all (`2/5` = 2 ticked of 5). The card opens on the side it was last on in this
  conversation.
- **The label.** Collapsed, the note is a one-line label as today. When the note in front has checkboxes, the label shows
  the count and the first unticked item; otherwise it shows the first line, as today.
- **The Project side when there is no project** (a folder outside git, or a remote tab): the switch's Project side is
  disabled, with a tooltip saying why.
- **Resizing.** The card hangs from the top right, so a grip in its bottom-left corner resizes it to the left and down.
  Each note keeps its own size (a long project checklist wants a bigger card than a short session note): the card takes
  the size of the note in front. A double click on the grip goes back to the default size. The card stays within the
  terminal's or the chat's area; it has a sensible minimum size.
- **Checkboxes.**
  - A **Checkbox** button in a small toolbar at the foot of the card turns the line under the caret (or each selected
    line) into a checkbox item, or back into plain text.
  - Typing `[ ] ` or `[] ` at the start of a line turns it into an item.
  - Enter at the end of an item starts a new item; Enter on an empty item ends the list (the line becomes plain text).
  - A click on the box ticks or unticks it; `Ctrl+Enter` ticks the item under the caret.
  - A ticked item is dimmed and struck through.
  - What is stored is the Markdown text; the editor shows a checkbox in place of `- [ ] ` / `- [x] `.
- **Bullets.** A **List** button does the same for bullet items (`- item`, shown with a bullet).
- **The editor stays a note.** Escape gives the keyboard back to the terminal or the chat, as today; undo and redo work
  across these edits; typing in any language (IME) works; copy and paste carry the Markdown text.

## Where things live

- **The session note** stays as it is: stored with its conversation, through `/clear`, a restart and Recent sessions, and
  synced to paired devices.
- **The project note** is stored per project in a file of its own in ClaudeTerm's data folder, keyed by the project's key
  (the `pathKey` of its main worktree, as the tab list groups tabs, `TabPlace.project.key`). Its entries are validated on
  read as the session notes' are, with the same length limit (`MAX_NOTE_LENGTH`). A tab learns its project when its place
  is known; until then, and outside a project, it has no project note. Every tab of the project shows the same note: an
  edit in one tab, or one Claude makes, reaches every other tab of that project at once. A repository that is moved or
  renamed leaves its note behind under the old key; that is accepted.
- **The card's state** (shown or not, label or card, which side is in front) stays the conversation's, as `shown` and
  `form` are today.
- **The card's size** is stored with each note: the session note's with the session note, the project note's with the
  project note. It is optional: a stored or synced note without a size is valid and has the default size.

## Notes for Claude: the MCP tools

Three tools on the bundled `claudeterm` server, reaching the app through the pipe like `set_task_list`. Each acts on the
notes of the tab Claude runs in, which the server knows from `CLAUDETERM_TAB_ID`; the server is registered for every
Claude Code ClaudeTerm starts, so terminal and chat tabs both have the tools. A note is named `session` or `project`.

- Claude runs on the device that owns its tab, so its edits are that device's own: an edit of the session note goes
  through the same store as the person's, and paired devices get it as they get any edit today.
- A tab that has no conversation id yet keeps its session note in the hub, as today; the tools edit that note, and the
  existing rules that join it to a stored note decide what happens to it next. The edit shows once.
- An item is a line `- [ ] text` or `- [x] text` (`[X]` counts as ticked), indented or not.

- **`read_notes`**: both notes as Markdown text, each under its name. It says when the tab has no project (and why) and
  when a note is empty.
- **`add_to_note`** `{ note, text }`: adds `text` at the end of the note, after one blank line if the note does not
  already end with one. `text` may hold items (`- [ ] …`) and bullets. Its length counts against the note's limit; text
  that would pass it is refused with a message, nothing cut.
- **`check_note_item`** `{ note, item, checked }`: ticks (`checked: true`) or unticks the checkbox item whose text is
  `item`. The match ignores spaces at the ends of the item's text and is otherwise exact. No match, or more than one, is
  refused with a message that lists the note's items, so Claude can quote one precisely.

There is no tool that removes or replaces text. The server's instructions tell Claude the notes exist, that they are the
person's, and when to use the tools: read them when the work needs context, add what the person should not lose, and
tick what Claude finished.

An edit Claude makes shows in the card at once if it is open, without moving the person's caret or losing what they are
typing. While the card shows the other note, or is collapsed, the label's count follows.

## Concurrent edits

The renderer sends the whole text as the person types (as today, with the number of the note it was typed against).
Claude's edits come from main. The two must merge:

- Main keeps each note's current text and applies Claude's operations (an append, a tick) to that text, never to an older
  one.
- The renderer applies a change from main as an edit of its editor (a minimal change of the text), so the caret,
  selection and undo history stay.
- A text from the renderer typed against a note that Claude has changed since must not wipe Claude's change. Rebasing the
  renderer's edit onto Claude's operations, or having the renderer always edit the current text after applying Claude's
  change first, both satisfy this; the builder picks one and proves it with a test where both edit at the same moment.

## Approaches considered

- **Where the project note goes:**
  - **A, one card with Session | Project** (chosen). No new place in the window, one shortcut for both. Its cost: only
    one note is in view at a time. The label's count makes up for it.
  - **B, a Notes side panel.** Room for long lists, but it takes the panel the person uses for Changes and Docs, and gives
    the two notes two different buttons.
  - **C, a note on the project's group in the tab column.** It shows whose the note is, but only with the tabs on the
    left, and it is far from the conversation.
- **What Claude may do:**
  - **Read, add, tick** (chosen): the person's text is safe, and the list stays theirs.
  - **Read and write freely:** more powerful, but one wrong rewrite loses what the person wrote.
- **How the editor is built:**
  - **CodeMirror 6** (chosen): an editor whose text is the stored Markdown, with checkboxes and bullets drawn as widgets
    over `- [ ] ` and `- `. It gives undo, IME input, selection and clipboard for free, and applying a change from main as
    a transaction keeps the caret. It adds `@codemirror/state`, `@codemirror/view` and `@codemirror/commands` to the
    renderer bundle. These are an editor component, not a UI framework, so the renderer keeps its no-framework rule.
  - **A hand-made `contenteditable` editor:** no dependency, but caret, IME and undo across structural changes (a line
    becoming an item) are a long tail of bugs.
  - **The current `<textarea>` with checkboxes laid over its lines:** breaks with wrapped lines and scrolling.

## Constraints

- AGENTS.md binds every change: tests for each behavior through its entry point (the pipe for the MCP tools, the window
  for the card), English UI strings, the main process never blocks, everything from the pipe is untrusted and validated,
  and tests never touch the real `~/.claude` or `%APPDATA%\ClaudeTerm`.
- The project note's file is written as the session notes' file is: debounced, atomically, and a damaged file is not lost
  silently.
- The README's Notes paragraph and the CHANGELOG's next section describe the change.

## Left to the builder

- The exact sizes: the default, the minimum and the largest size of the card.
- The look of the switch, the toolbar and the grip, within the mockups and the app's colors.
- How the merge of concurrent edits is done (see above), as long as its test holds.
- The wording of the tools' descriptions and messages, and of the server's instructions.
