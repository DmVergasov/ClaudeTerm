# Recent sessions — design

Date: 2026-10-06. Status: approved in chat; the user delegated the spec, plan, review and release ("делай").

## Goal

Get back to a recent Claude Code conversation from any project in two keystrokes and continue it in a ClaudeTerm tab. The list covers every interactive Claude Code session on the machine, not only ones started in ClaudeTerm, because Claude Code keeps all of them in one place.

## What the user sees

1. **Ctrl+Shift+H**, or the ▾ menu item **Recent sessions…** (right after **Claude Code**), opens a window over the terminal: a search field and a list.
2. The list holds the 100 most recently active interactive sessions, newest first. Each row:
   - **title** — the name given with `/rename`, else the title Claude Code generated, else the first message, else `(untitled)`;
   - **folder name and age** — `Offroad · 5 min ago`; hovering the folder shows the full path;
   - **last message**, dimmed, one line;
   - **● open** at the right when a ClaudeTerm tab is in that conversation.
3. Typing filters the list: every word typed must appear (case-insensitive) in the title, the folder path, the first message or the last message.
4. ↑/↓ move the selection (the first row is selected on open and after each filter change), Enter or a click opens the selected row, Esc or a click outside the window closes it. The window keeps the keyboard while open.
5. Opening a row:
   - a tab already in that conversation → that tab is activated;
   - otherwise a new Claude tab opens in the session's folder and runs `claude --resume <id>`;
   - the folder no longer exists → a toast `The folder of this session no longer exists: <path>`, nothing opens (Claude Code finds a conversation by its folder, so resuming elsewhere fails).
6. Empty states: `No Claude Code sessions yet` when nothing was found, `Nothing matches` when the filter hides everything.
7. Age format: `just now` (under a minute), `N min ago`, `N h ago`, `yesterday`, `N days ago` (under 7 days), then `5 Oct`, or `5 Oct 2025` for another year.

## Where the data comes from

Claude Code writes every conversation to `<config>/projects/<encoded folder>/<session id>.jsonl`, where `<config>` is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. One JSON object per line. The entries this feature reads (checked against Claude Code's binary and the user's 267 transcripts):

| entry | fields used |
|---|---|
| `user`, `attachment`, `system` entries | `cwd`, `entrypoint` (`cli` = interactive, `sdk-cli` = `claude -p`/SDK), `isSidechain` |
| `{"type":"user", …}` | also `isMeta`, `message.content` (a string, or blocks with `{type:"text",text}`) |
| `{"type":"custom-title","customTitle":…}` | the `/rename` name |
| `{"type":"ai-title","aiTitle":…}` | the generated title |
| `{"type":"last-prompt","lastPrompt":…}` | the last message the user typed |

Claude Code appends `custom-title`, `ai-title` and `last-prompt` again as the conversation goes on, so the **last** occurrence is the current value and it sits near the end of the file.

A file is a session for this list when:
- its name is `<uuid>.jsonl` directly inside a project folder (subagent transcripts live deeper and are not listed);
- the first entry in it that carries a `cwd` is not a sidechain and has `entrypoint` absent or `cli` (`sdk-cli` runs are scripted, not conversations to continue);
- it holds a conversation: a non-sidechain `user` entry in the head window or a `last-prompt` in the tail window.

The first `user` entry is not always near the start: some files open with several large `attachment` entries, so the first message can sit beyond the head window. That is why `cwd` comes from the first entry carrying one, and a `last-prompt` also proves a conversation. Checked on the user's 267 transcripts: 227 qualify, 38 are `sdk-cli`, 2 have no `cwd` (empty or bridge-only files); every qualifying file has a title or a last message in its tail.

Field meanings:
- **id** — the file name without `.jsonl` (equals `sessionId`).
- **cwd** — `cwd` of the first entry carrying one.
- **first message** — text of the first non-meta `user` entry in the head window whose content is text (a string or text blocks; tool results don't count); `null` when there is none there. Text starting with `<` (command and caveat wrappers like `<command-name>`) is skipped.
- **title / last message** — the last `custom-title` / `ai-title` / `last-prompt` in the file.
- **active at** — the file's modification time.

Titles and messages are collapsed to one line (whitespace runs → one space) and cut to 200 characters.

### Reading cost

Transcripts are large: median 1.6 MB, 90th percentile 7 MB, up to 100 MB; 1.2 GB in total on the user's machine. So:
- List `<config>/projects/*/*.jsonl` with `stat`, sort by modification time, newest first.
- Walk that order and read files until 100 sessions are collected.
- Per file read at most the **first 64 KB** (cwd, entrypoint, first message) and the **last 256 KB** (titles, last message). When the tail has no `ai-title`/`custom-title`/`last-prompt` and the file is larger, read the last 2 MB once more. Lines cut at a window edge are skipped; a line that does not parse is skipped.
- Keep the result per file in memory keyed by path, size and modification time; reopening the window re-reads only files that changed.
- A file that cannot be read is skipped. A missing `projects` folder gives an empty list.

## Components

- `src/main/session-history.ts`
  - `parseSessionHead(text)` / `parseSessionTail(text)` — pure parsers of the two windows.
  - `SessionHistory` — lists, reads (through an injected file system for tests), caches; `list(limit)` returns `SessionSummary[]`.
- `src/shared/types.ts` — `SessionSummary { id, cwd, title, firstPrompt, lastPrompt, modifiedAt }` (title `null` when only the first message is known; the renderer picks what to show).
- IPC:
  - `sessions:list` (invoke) → `RecentSession[]` = `SessionSummary & { open: boolean }`; main sets `open` from the tabs' current Claude session ids.
  - `sessions:open(id)` (send) → main looks the id up in the last listing, then activates the tab or checks the folder and opens a Claude tab with `resumeSessionId`, or toasts.
- `src/renderer/recent-sessions.ts` — the window: rendering, filter, keyboard, and the pure helpers `filterSessions(list, query)` and `formatAge(ms, now)`.
- `src/renderer/keymap.ts` — `Ctrl+Shift+H` → `{ type: 'recentSessions' }`.
- `src/renderer/main.ts` — the ▾ menu item and the action.
- README — a short section and the shortcut table row.

## Out of scope

Deleting, renaming or pinning sessions; a preview of the conversation; listing `claude -p` runs or subagent transcripts; sessions from WSL's own `~/.claude`; resuming a conversation in a different folder.

## Testing

- Unit: `parseSessionHead`/`parseSessionTail` (title priority, `sdk-cli` and sidechain skipped, `cwd` from a leading `attachment`, a conversation proven only by `last-prompt`, a file without one skipped, meta and `<command…>` first messages skipped, block content, broken and cut lines, whitespace collapse and the 200-char cut), `SessionHistory` with an in-memory file system (ordering, the 100 limit counts only qualifying sessions, the 2 MB second tail read, cache reuse and invalidation on size/mtime change, unreadable files, missing folder), `filterSessions`, `formatAge`, the new key.
- E2E with a temporary `CLAUDE_CONFIG_DIR` holding two sessions in two folders: the window opens from the menu and with Ctrl+Shift+H, lists both newest first with their titles, filters by a word, Enter opens a Claude tab whose fake `claude` shows `--resume <id>` in that folder, a session already open in a tab is marked `● open` and activates that tab instead of opening another, a session whose folder is gone shows the toast, Esc closes.
