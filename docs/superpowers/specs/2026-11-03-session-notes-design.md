# Session notes — design

Date: 2026-11-03
Status: agreed in chat, waiting for the user to review this document

## Goal

A Claude tab gets a note: plain text the user writes for themselves — which feature they are building in this tab,
their TODO list for it, and general notes. They read it when they come back to the tab: after a break, the next
day, after a restart, or when many tabs are open and they no longer remember which is which. The note is the user's
own; Claude never sees it.

The note is shown over the terminal, in its top right corner, as a small translucent label that opens into a card,
and is restored together with the session.

## Background: how a tab knows its conversation

- A Claude tab's conversation is `TabInfo.claudeSessionId`. A tab opened with `--resume <id>` (restore, Recent
  sessions) has it from the start; a new tab gets it when Claude Code's `SessionStart` hook reports it, a moment
  after start. `/clear` (and `/resume` inside Claude Code) starts another conversation in the same tab: the hook
  reports a new id and `TabManager.setClaudeSession` replaces the old one.
- Session restore (`src/main/session-store.ts`) saves the tabs — kind, folder, title, `claudeSessionId`, account,
  muted — and the Restore banner reopens them with `--resume`.
- The Recent sessions window opens a conversation by its id in a new tab (or activates the tab already in it).
- ClaudeTerm keeps its own per-conversation data in its data folder: `starred-sessions.json`
  (`src/main/starred-sessions.ts`) is the pattern to follow.

## What the user sees

### The Note button

- A new button **Note** in the tab bar, after Media, with a sticky-note icon (the one in the prototypes). Tooltip
  `Note (Ctrl+Shift+N)`, `Note (⌘N)` on macOS.
- It exists only for Claude tabs: for a shell tab it is hidden, the way the Changes button is.
- It shows the active tab's note, or hides it. It is highlighted (like Media and Changes when their panel is open)
  while the note is shown.
- The same shortcut does the same: **Ctrl+Shift+N** on Windows and Linux, **⌘N** on macOS. *(Claude's call: the
  user asked for a shortcut and left the key to Claude; N is free in both keymaps and in the macOS menu.)*

### Three states of a note

Each Claude tab's note is in one of three states, and each tab remembers its own:

1. **Hidden** — nothing over the terminal.
2. **Label** — a small translucent pill in the top right corner of the terminal: the note icon and the note's first
   non-empty line, cut with an ellipsis. A click on it opens the card.
3. **Card** — a translucent card in the same corner: a header with the note icon, `Note`, a **–** button that
   collapses it to the label and a **×** button that hides it; below, the whole text, editable in place.

Showing a hidden note (the button, the shortcut) brings back the state it had before it was hidden: the label or the
card. A note that is empty opens as the card with the cursor in its text, ready to type. *(Claude's call, as the
prototype behaved.)*

### Looks

- The label and the card are translucent (about 75–80% opaque, with a light blur of what is behind), so the terminal
  text under them stays readable; on hover, and while the card has the keyboard, they turn fully opaque.
- They use the app's colors and fonts (`--chrome-2` background, `--border` border, the UI font, not the terminal's).
- *(Claude's call)* The card is about 300 px wide; it grows with the text up to about 40% of the terminal's height,
  then scrolls. The label is at most about 280 px wide.
- They sit at the top right of the part of the terminal that is visible: when the side panel lies over the terminal
  (overlay mode), they sit left of it; the expanded side panel lies over the whole window and covers them. The find
  box (Ctrl+Shift+F) draws over them. *(Claude's call.)*
- The terminal keeps its size when a note is shown, hidden, collapsed or opened: Claude Code does not redraw.

### Writing

- Plain text, any number of lines. No formatting, no Markdown rendering.
- A click in the card's text starts editing; there is no save button — the text is kept as it is typed.
- **Esc** in the card gives the keyboard back to the terminal; the card stays open. *(Claude's call.)*
- Erasing the whole text removes the note: its label and its mark on the tab go away. The card stays open (empty)
  until the user hides it or switches tabs; a tab with no note shows nothing over the terminal.
- An empty note has no label to collapse to: **–** on an empty card hides it, like **×**. *(Claude's call.)*
- After a click on the Note button, **–** or **×**, the keyboard goes back to the terminal unless the note took it (an
  empty note opens with the cursor in its text), as after the Media and Changes buttons. *(The user's decision.)*
- When the tab moves into a conversation that has a note of its own while the user is typing in the card, the card
  shows the arrived note at once; the text being typed stays with the conversation the tab left. *(The user's
  decision.)*

### The mark on the tab

A tab whose note has text shows a small note icon in its title, after the title text — in the tab bar on top, and in
the vertical tab list when that comes (a separate design).

### Restart, closing and reopening

The user chose: **the note lives in the tab, and when the tab is closed it stays with the tab's last conversation.**

- **`/clear`** (or anything else that moves the tab to a conversation without a note): the note stays in the tab,
  with its state. From then on it belongs to the new conversation; the old conversation no longer has it.
- **`/resume` inside Claude Code into a conversation that has a note of its own** (its tab was closed earlier): the
  user chose that the tab takes that conversation's note, with its state, and the tab's own note stays with the
  conversation it left — opening that one again brings it back. No note is ever lost.
- **Restart and Restore**: every restored Claude tab comes back with its note and the note's state.
- **Closing the tab**: the note is kept with the tab's last conversation. Opening that conversation later from
  Recent sessions brings the note back, with its state.
- A tab closed before its first conversation was known (it never got a session id) has nowhere to keep its note:
  the note is gone with it.
- Shell tabs have no notes.

## How it works

### Storage — `src/main/session-notes.ts`

- A file in ClaudeTerm's data folder, `session-notes.json`, never anything in Claude Code's folders:

  ```json
  { "6f1c…-uuid": { "text": "Goal: revenue charts on the new palette\n— …", "shown": true, "form": "label" } }
  ```

  `shown` says whether the note is over the terminal; `form` (`"label" | "card"`) is the form it is shown in, kept
  while it is hidden so that showing it brings that form back, after a restart too. *(Claude's call.)* Written the way `StarredSessions` writes: to a `.tmp` file, then renamed
  over the old one; read errors and corrupt files are logged, never fatal.
- The file is untrusted on read: keys must be session ids (`isUuid`), `text` a string of at most 100 000
  characters *(Claude's call)*, `shown` a boolean, `form` one of the two values; anything else is dropped.
- An entry with empty text is not stored.
- Saving while the user types is debounced (like `SessionStore.scheduleSave`), and flushed when the app quits.

### The tab's note

- Main holds each Claude tab's note (text and state). A tab opened with a session id (restore, Recent sessions, any
  `--resume`) takes the stored note of that id, if there is one.
- A new tab's note, written before its session id is known, is held in the tab and stored once the id arrives. If
  that first id already has a stored note, the user chose to keep both: the tab's text is appended to the stored
  note's text after an empty line, the merged note keeps the stored note's state, and the tab shows it.
- When `setClaudeSession` gives the tab a new id:
  - the new id has no stored note → the tab's note moves: stored under the new id, removed from the old one;
  - the new id has a stored note → the tab's note stays stored under the old id, and the tab shows the new id's
    note, in that note's state (a tab without an old id merges instead, as above).
  The rule depends only on whether the new id has a stored note, not on the hook's `source`.
- Closing the tab leaves the stored entry under its last id as it is.
- Two tabs in one conversation is not a state the app sets up (Recent sessions activates the open tab instead); if
  it happens anyway, the last edit wins. *(Claude's call.)*

### IPC

New channels in `src/shared/ipc.ts`, each argument checked in main with `ipc-guards.ts`: read a tab's note, set its
text, set its state, and an event telling the renderer that a tab's note changed (for the card and the mark on the
tab). The exact shape is the builder's.

### Renderer

- A new module for the label and the card over the terminal area (`#terminals`), shown for the active tab only.
- `TabBar`: the Note button (built once, like the Media and Changes buttons) and the mark in a tab's title.
- `keymap.ts`: a `toggleNote` action on Ctrl+Shift+N and ⌘N, with its label in `LABELS` for the tooltip.

## Out of scope

- Notes for shell tabs.
- Showing or searching notes in the Recent sessions window.
- Formatting, Markdown, checkboxes, links.
- More than one note per tab; moving the note to another corner or dragging it.
- Giving the note to Claude (in the prompt, through the MCP server or a hook).
- Cleaning up notes of conversations whose transcripts were deleted.

## Testing

Per AGENTS.md, every behavior here gets a test through the entry point that uses it.

- **Unit** — `session-notes.ts`: reading a valid file, dropping bad entries (non-uuid keys, wrong types, too long
  text, unknown state), not storing empty text, moving a note to a new session id without a note, and taking the
  stored note of a new session id that has one while the tab's own note stays under the old id. `keymap.ts`: Ctrl+Shift+N and
  ⌘N map to `toggleNote`, and nothing else moved.
- **End-to-end** (`tests/e2e`, the stand-in `claude`, the app's own data folder):
  - a Claude tab: the Note button opens an empty card; typing shows the mark on the tab; **–** gives the label with
    the first line; a click on the label opens the card; **×** hides it; the button brings back the last state;
  - the shortcut does the same as the button;
  - a shell tab has no Note button, and the shortcut does nothing there;
  - erasing the text removes the mark;
  - restart and Restore: the note and its state come back;
  - closing the tab, then opening its conversation from Recent sessions: the note comes back;
  - the tab moves to a new conversation (the stand-in reports a new session id, as `/clear` does): the note stays
    in the tab, and after a restart and Restore it is still there;
  - the tab moves into a conversation that has a stored note (the stand-in reports the id of a conversation whose
    tab was closed with a note, as `/resume` does): the tab shows that note; opening the conversation it left from
    Recent sessions brings the tab's previous note back;
  - showing, collapsing and hiding the note does not change the terminal's size.

## Docs

- README: a short line on notes under **Features** (next to the tabs or the sessions it belongs with), and
  Ctrl+Shift+N / ⌘N in **Keyboard shortcuts**. Any note shown in a regenerated image is invented.
- The CHANGELOG entry is written at release time.
