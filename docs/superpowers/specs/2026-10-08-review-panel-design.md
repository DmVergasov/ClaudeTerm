# Review panel — design

Date: 2026-10-08. Status: approved in chat section by section; waiting for the user's review of this spec. The feature is released only when the user says so (no version bump, CHANGELOG release section, tag or Release run before that).

## Goal

Review the code Claude changed without leaving ClaudeTerm. The diff sits next to the conversation. You comment on lines and send all the comments to Claude in one message, then watch it fix them while the diff updates. You can also ask for a diff in words ("show me the diff of the last three commits, only src/main"): Claude opens it through a new `show_diff` MCP tool.

## What the user sees

### The Changes panel

1. The right-hand panel of a Claude tab gets two tabs, **Images** and **Changes**, and shows one of them at a time. Changes keeps its own width: it opens at `review.width` (default 640 px), and dragging the edge changes it, like the image panel.
2. Ways to open Changes:
   - **Ctrl+Shift+D** toggles it;
   - a click on the status-bar counter (below);
   - Claude calling `show_diff`.

   **Ctrl+Shift+I** still toggles Images. The panel follows the active tab, like the image panel. Shell tabs have no Changes tab.
3. Header: `Images (n)`, `Changes (n)`, then ⟳ (refresh), ⤢ (expand) and – (hide). The badge on Changes is the number of files in the current view that are not marked viewed. Expanding makes the panel 85% of the window width until ⤢ or Esc.
4. Scope bar:
   - a segmented control: **Uncommitted** | **Last turn** | **Session**;
   - on the right, a summary like `3 files · +40 −12`.

   After `show_diff`, the segmented control is replaced by a chip with the request: its `title`, else e.g. `HEAD~3 → working tree · src/main`. The chip's ✕ goes back to the scope chosen before. Each tab remembers its scope. In a git repository the default is Uncommitted. Outside one it is Session, and Uncommitted is disabled with a tooltip (`Not a git repository` / `git was not found`).
5. Files are sorted by path. Each file has a header with:
   - a **Viewed** checkbox;
   - ▸/▾;
   - the folder (dimmed) and the name;
   - its status: `A`, `M` or `D`;
   - `+n −n`;
   - a ⋯ menu with **Open in editor** and **Copy path**.

   A click on the header folds or unfolds the file. Unviewed files start unfolded. A file with more than 1000 changed lines starts folded, with its counts on the header.
6. Rows a file shows instead of hunks:
   - `binary`;
   - `too large — show anyway` (either side over 1 MB; the link builds the diff for that file);
   - `line endings changed only`;
   - `no baseline — use Uncommitted` (see the transcript fallback);
   - `can't be read` (the file on disk cannot be read right now, e.g. another process locks it);
   - `not shown` (the view has too many changes, see the limits below).
7. Hunks are unified only:
   - a dimmed `@@ -a,b +c,d @@` line;
   - 3 lines of context;
   - one gutter: the new line number, or the old one for a deleted line;
   - added and deleted lines tinted green and red.

   There is no syntax highlighting.

### Comments

1. Hovering a line shows a **+** in the gutter. A click comments on that line. Dragging along the gutter selects a range within one hunk.
2. Right-clicking a line opens a menu: **Comment**, **Open in editor at line N**, **Copy path:line**.
3. The comment box opens under the range. Ctrl+Enter adds the comment, Esc cancels. A saved comment shows inline with edit and delete.
4. The footer shows `N comments` and **Send to Claude** (disabled at 0).
5. Comments belong to the tab, not to the scope. Comments outside the current view are listed in a `Comments outside this view (n)` row at the top. **Send** sends all of them.
6. Closing the tab drops its comments. They are not kept across app restarts.
7. A comment is anchored to its file, its line range and the text of those lines. When the file changes under it, it looks for the same lines within 50 lines of the old place and moves there. If they are not found, the comment is marked **outdated**, stays listed and is still sent with its quote.
8. After a successful Send the comments are removed from the panel; the conversation has them now.

### Viewed

The checkbox folds and dims the file. It is keyed by the path and a hash of the file's current content, so it clears by itself when the file changes again. It lives in memory only.

### Status bar counter

The segment `± 3 files +40 −12` shows for the active Claude tab:
- the Uncommitted view in a git repository, else the Session view;
- its tooltip names the source: `Uncommitted changes in <repo root>` or `Claude's edits in this session`.

It is hidden when there are no changes or when `review.statusBar` is false. A click opens Changes.

### The message Send writes

Send uses the same path as pasting text with Ctrl+V (`term.paste`, which brackets the paste when Claude Code asked for it), then presses Enter separately after 50 ms:

```
Review comments on the changes (uncommitted):

1. src/main/image-hub.ts:40-41
   > if (seen.has(key)) return
   > seen.add(key)
   What if p is empty? pathKey('') returns '.' here.

2. tests/unit/image-hub.test.ts:12 (removed line, was: expect(hub.size).toBe(1))
   Why was this check dropped?
```

- The first line names the view: `(uncommitted)`, `(last turn)`, `(session)`, or the `show_diff` chip text.
- Quotes hold at most 6 lines of the commented range; longer ranges end with `> …`.
- Line numbers are those of the file now. A deleted line gives its old number and its old text.
- An outdated comment gets ` (outdated: the lines changed since)` after its location.
- The template is English; the comment text is sent as written.

**When Send is blocked.** Right before writing, the renderer asks main whether Send is allowed now. It is refused, with the button disabled and a tooltip, in two cases:
- **Claude is waiting on a dialog** (`Answer Claude's prompt in the terminal first`). This state starts with an `attention` message for `permission` or `question`. It ends with a `Stop`, the end of the session, or the next `assistant` entry in the transcript of the agent that raised the dialog. The attention message carries the hook input's `agent_id` when the dialog came from a subagent; without one, that is the main transcript. While a dialog is open, its agent cannot write a new assistant message, so a pending dialog never gets an Enter. That holds even when a background subagent asks and the main conversation keeps going.
- **Claude is not running in the tab** (`Claude is not running in this tab`), after `session_end`.

### `show_diff`

A second tool on the `claudeterm` MCP server, next to `show_image`:

```ts
show_diff({
  scope?: 'uncommitted' | 'last_turn' | 'session',  // default 'uncommitted'; ignored when `from` is given
  from?: string,     // a git ref or commit: "HEAD~3", "master", a sha
  to?: string,       // a git ref or commit; default: the working tree
  paths?: string[],  // files or folders, relative to Claude's working folder
  title?: string     // the chip text, at most 100 characters
})
```

- Tool description, for Claude: it opens the diff in ClaudeTerm's Changes panel so the user can review it and comment on lines. Use it when the user asks to see a diff or changes. For a branch reviewed like a pull request, pass `git merge-base <base> HEAD` as `from`.
- The server resolves `paths` against its own working folder (where Claude runs) and sends absolute paths.
- Replies Claude gets:
  - `Opened 3 files (+40 −12) in the Changes panel.`
  - `No changes in this view.` (the panel still opens, showing it is empty)
  - errors: `not a git repository: <folder>`, `unknown revision: mastr`, `show_diff works only in a ClaudeTerm Claude tab`, `nothing in the view for paths: …`.
- `from` and `to` must not start with `-`, and each must pass `git rev-parse --verify --quiet --end-of-options <ref>^{commit}`.
- `PipeResponse` gets an optional `info` string for the reply text.

## Where the data comes from

Every view reduces to a list of `{ path, before: string | null, after: string | null }`. `null` means the file does not exist on that side. One diff builder turns the list into hunks.

### Claude's edits: the edit ledger (Last turn, Session)

The generated `claude-tab-settings.json` gets two more hooks. They print nothing, like the others, so they don't change what Claude does; UserPromptSubmit stdout would become context, which is why it must stay empty.

```jsonc
"UserPromptSubmit": hook,
"PreToolUse": [
  { "matcher": "AskUserQuestion", "hooks": [run] },
  { "matcher": "Edit|MultiEdit|Write|NotebookEdit", "hooks": [run] }
]
```

`session-hook.ts` maps them to two new pipe messages:
- UserPromptSubmit → `{ v: 1, type: 'turn', tabId, sessionId }`.
- PreToolUse of an edit tool → `{ v: 1, type: 'edit_before', tabId, sessionId, toolUseId, path }`. `path` is `tool_input.file_path` (`notebook_path` for NotebookEdit), resolved against the hook input's `cwd` when relative.

Claude Code runs the tool only after the hook returns, and the hook waits for main's reply. So main reads the file **before** replying, and what it reads is the content before the edit. The pipe line limit (64 KB) never holds file content: only the path travels. A missing file is recorded as `absent` (Claude is creating it). A file over 1 MB or with a NUL byte is recorded by hash only, as `too large` / `binary`.

`edit-ledger.ts` keeps, per session:
- the turn counter, advanced by `turn`;
- for each file, the first snapshot in the session and the first snapshot in each turn;
- the tool use ids it saw;
- the last turn that has edits. **Last turn** is that turn, so a turn without edits (a question) does not empty the view. After Send, the new turn shows exactly Claude's fixes.

Subagents run the same hooks, so their edits count in the turn of the main conversation. `/clear` starts a new session id and with it a new ledger. A hook that fires for an edit the user then denies leaves a snapshot equal to the file; files whose two sides are equal are not shown.

Snapshots are stored content-addressed in `<dataDir>/review/<sessionId>/blobs/<sha1>`, with `ledger.json` next to them. A tab that resumes the same session (restore, Restart session, Recent sessions) loads it back. Session folders untouched for 7 days are deleted at startup, like the image cache.

Each edit now starts the hook process once more (ClaudeTerm's executable in Node mode, about 0.1 s).

### Claude's edits: the transcript fallback

Edits made before ClaudeTerm watched the session have no snapshots. Example: a conversation started outside ClaudeTerm and resumed from Recent sessions. For those, `transcript-edits.ts` reads the session's transcripts, main and subagents, which `TranscriptFeed` already tails from the start on `--resume`:
- **Turn starts:** main-transcript `user` entries with text content (a string or text blocks) that are not `isMeta`, `isCompactSummary` or `isSidechain` and are not tool results.
- **Edits:** `user` entries whose `toolUseResult` has `filePath` and `structuredPatch` (Edit and Write; Write's `type: 'create'` means a new file). The parser also keeps the tool use id, and `originalFile` when it is a string.

Checked on the user's last 60 transcripts:
- `structuredPatch` is always there;
- `originalFile` is empty in 993 of 1582 Edit results and in most Write updates.

That is why it cannot be the main source.

Two sources cover the history:
- **The ledger** has every edit whose tool use id it recorded.
- **The transcript** has the edits the ledger did not see. They all come before the ledger's first record for that session, so no edit is counted twice.

The baseline of a file whose earliest edit in the view is history is found in this order:
1. That edit's `originalFile` when it is present; `absent` for a `create`.
2. Otherwise, take the ledger's earliest snapshot of that file, or the file on disk when the ledger has none. Apply the history edits' `structuredPatch` hunks to it in reverse, newest first.
3. A hunk that does not apply (Bash or the user changed the file in between) gives the `no baseline — use Uncommitted` row.

When the ledger has no turn with edits, Last turn falls back to the transcript's last turn with edits.

### Git (Uncommitted, `from`/`to`)

`git-source.ts` runs `git` with `execFile` in the tab's folder: no shell, `-c core.quotepath=off`, a 10 s timeout. It does five jobs:

| job | how |
|---|---|
| repository root | `git rev-parse --show-toplevel` |
| check a ref | `git rev-parse --verify --quiet --end-of-options <ref>^{commit}` |
| changed files against the working tree | `git diff --name-status -z --no-renames <from> -- <paths>`, plus untracked files from `git ls-files --others --exclude-standard -z -- <paths>` |
| changed files between two refs | `git diff --name-status -z --no-renames <from> <to> -- <paths>` |
| content at a ref | `git show <ref>:<path>`; the working-tree side is read from disk |

- **Uncommitted** is `from = HEAD`. In a repository without commits it compares against the empty tree.
- **Submodules** show a `submodule` row without a diff.
- **Renames** show as a deletion and an addition.

### Building the diff

- Both sides get `\r\n` → `\n` before comparing. With `core.autocrlf=true` the stored side has LF and the disk side CRLF; without this every line would differ. A file left with no hunks after that, though git listed it, gets the `line endings changed only` row.
- Hunks come from jsdiff `structuredPatch` with 3 lines of context. The `diff` package is bundled into main like the other dev dependencies.
- **Binary:** a NUL byte in the first 8000 bytes of either side.
- **Too large:** either side over 1 MB. "Show anyway" builds the diff for that one file with a 10 MB limit.
- **Too many changes:** over 500 files or 5 MB of text in total. The files are listed without hunks, under the notice `Too many changes to show at once — narrow the view with a smaller scope or paths`.

### When views are recomputed

Only the active tab is computed. Recomputation is debounced by 300 ms and runs on:
- an Edit/Write result appearing in the transcript feed (new `onEdit` callback);
- `Stop`, which catches files Claude changed through Bash;
- the window gaining focus, which catches the user's own edits in an editor;
- the tab becoming active, the panel opening, a scope change, `show_diff` or ⟳.

ClaudeTerm still does not watch the project folder.

## Opening the editor

`review.editor` is a command template with `{file}` and `{line}`, e.g.:
- `code --goto {file}:{line}`
- `"C:\Program Files\JetBrains\Rider\bin\rider64.exe" --line {line} {file}`

Rules:
- The template is split into arguments, respecting double quotes. The placeholders are replaced inside each argument, and the command runs detached without a shell.
- On Windows, a `.cmd` or `.bat` command (`code.cmd`) runs through `cmd.exe /d /s /c` with every argument escaped for cmd.
- `null` (the default) means `code --goto {file}:{line}` when `code` is on `PATH`, else the system's default app for the file, without a line.
- A command that fails to start shows a toast with the error.

## Settings

```jsonc
"review": {
  "editor": null,      // command template with {file} and {line}; null = VS Code when `code` is on PATH, else the default app
  "statusBar": true,   // the changes counter in the status bar
  "width": 640         // width of the Changes panel, in px
}
```

The settings window gets a **Review** section with the editor field and the status bar switch. `width` is set only in settings.json, like `imagePanel.width`: it is the width the panel opens with, and dragging changes the width until the app restarts.

## Components

- `src/main/claude-tab-settings.ts` — the two hook entries.
- `src/hook/session-hook.ts` — `turn` and `edit_before` messages; `agentId` on `attention`.
- `src/shared/protocol.ts` — the `turn`, `edit_before` and `show_diff` messages, the optional `agentId` of `attention`, and `PipeResponse.info`.
- `src/mcp/show-diff-tool.ts` + registration in `show-image-server.ts` — input validation and the pipe call, following `show-image-tool.ts`.
- `src/main/edit-ledger.ts` — snapshots per session and turn, the blob store and its persistence.
- `src/main/transcript-edits.ts` — pure parser of turn starts and edit results.
- `src/main/baselines.ts` — pure: the history baseline (originalFile, or reverse-applied patches).
- `src/main/git-source.ts` — the git commands above, with an injectable runner for tests.
- `src/main/review-diff.ts` — pure: line-ending normalization, binary and size checks, hunks.
- `src/main/review-hub.ts` — per tab: the view, the triggers, viewed state, the dialog guard, stats for the status bar. It sends `ReviewUpdate` to the renderer.
- `src/main/transcript-feed.ts` — the `onEdit` callback, and assistant-entry notices for the dialog guard.
- `src/main/editor-launch.ts` — template parsing and launching.
- IPC (`src/shared/ipc.ts`, preload):
  - `review:update` (main → renderer);
  - `review:setView`, `review:refresh`, `review:setViewed`, `review:showFile`, `review:openEditor`;
  - `review:canSend` (invoke).
- `src/renderer/review-panel.ts` — the Changes tab: files, hunks, comments, viewed and footer.
- `src/renderer/review-comments.ts` — pure: re-anchoring and the Send message.
- `src/renderer/image-panel.ts` — the shared panel shell with two tabs.
- `src/renderer/status-bar.ts` — the counter segment.
- `src/renderer/keymap.ts` — `Ctrl+Shift+D` → `{ type: 'toggleChanges' }`.
- `src/renderer/settings-form.ts` — the Review section.
- `src/shared/types.ts`, `src/main/settings.ts` — `review` settings with defaults and validation.
- README:
  - a feature section;
  - the shortcut row;
  - the `review` block in the settings example;
  - the two new hooks in "Good to know";
  - a screenshot made from invented sessions and code.

## Error handling

- **git missing or failing, or a ref that does not resolve:** shown in the panel notice (and in the `show_diff` reply), never a crash. The Last turn and Session views keep working.
- **A snapshot that cannot be read** (permissions, a file locked by another process): recorded as `unreadable`. The file then shows the `no baseline` row.
- **Ledger files that cannot be written:** logged once per session. The ledger keeps working in memory.
- **A transcript line that does not parse:** skipped, as everywhere else in the transcript feed.
- **A Send that is refused at the last moment:** the comments stay and the button shows why.

## Testing

**Unit (vitest):**
- `transcript-edits`: Edit, Write create and update, a user prompt, a tool result, a meta entry, a compact summary, a sidechain entry, a broken line.
- `edit-ledger`: turn counting; first snapshot per turn and per session; last turn with edits that survives a turn without edits; save and load; age cleanup.
- `baselines`: from `originalFile`; reverse patches in order; a patch that does not apply gives no baseline.
- `review-diff`: CRLF against LF, line endings only, binary, too large, added, deleted, equal sides hidden.
- `review-comments`: the message format (ranges, removed lines, quote cut at 6 lines, outdated); re-anchoring (moved, not found).
- `show_diff` input: refs starting with `-`, paths resolved against the cwd, title cut.
- `session-hook`: `turn` and `edit_before` from hook inputs; a relative path is resolved.
- keymap: `Ctrl+Shift+D`.
- `editor-launch`: quotes, placeholders, the `.cmd` escaping.
- settings: `review` defaults and validation.

**Integration:**
- `git-source` on a temp repository: modified, added, untracked and deleted files; `from`/`to`; an unborn HEAD; `core.autocrlf=true`; a bad ref.
- `show_diff` over the pipe, like `mcp.int.test.ts`.
- The `edit_before` round trip: the hook replies only after main has read the file.

**E2E (Playwright):**
- A fixture session with edits: open Changes, switch scopes, mark a file viewed, then change it and see the mark clear.
- Add a comment and Send: the PTY receives the message, then Enter.
- Send is blocked after a `permission` attention and unblocked by the next assistant entry of the same agent; an assistant entry of another agent leaves it blocked.
- The status-bar counter opens the panel.

## Out of scope

- Syntax highlighting and side-by-side diffs.
- Expanding context around hunks.
- Rename detection.
- Revert, stage or other git actions from the panel.
- Viewed marks and unsent comments surviving an app restart.
- Changes for shell tabs, or for `claude` started by hand in one.
- Watching the project folder for changes.
