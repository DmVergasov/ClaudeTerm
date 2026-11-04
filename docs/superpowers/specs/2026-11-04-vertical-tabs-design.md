# Vertical tabs, grouped by project and worktree, with forks — design

Date: 2026-11-04
Status: approved by the user

## Goal

With many tabs across several projects and git worktrees, a single row of tabs on top stops telling the user what
is where. The user wants a choice: tabs on top as today, or a vertical list on the left that groups the tabs by
project, shows each tab's branch, marks the tabs that run in an extra git worktree, and keeps a conversation's forks
under the tab they were forked from. Forking a Claude conversation into a new tab becomes a context-menu action.

The prototypes the user chose are in `.superpowers/brainstorm/44627-1793710949/content/tabs-chosen.html` (git-ignored;
the variant "flat list under project headers, branch on every tab, colored bar for a worktree").

## Background

- A tab knows the folder it was opened in (`TabInfo.cwd`). Claude Code reports its current folder at every prompt
  (the `turn` pipe message carries `cwd`), but the user chose grouping by the folder a tab was opened in (below).
- Git runs only through `execGit` (`src/main/git-source.ts`): no shell, `--no-optional-locks`, read-only.
- A Claude tab opened with `--resume <id>` gets `claudeSessionId = <id>` at once (`TabManager.open`).
- **Forks in Claude Code 2.1.318** (checked against the docs and on the user's installed build):
  - `/fork` copies the conversation into a background session outside the terminal; `/branch` switches the running
    session to a copy in place. Neither gives ClaudeTerm a second tab or a parent id. **Not supported here**: the
    user agreed that sub-tabs are only for forks ClaudeTerm makes itself.
  - `claude --resume <id> --fork-session` starts a copy with a new session id; the original is untouched. Checked on
    2.1.318: the `SessionStart` hook reports the **new** id with `source: "fork"` and the copy's `transcript_path`
    (a bug in 2.1.84 reported the original id; it is not present in 2.1.318). The copy does not keep "allow for
    session" grants or plan mode (Claude Code's behavior; nothing for ClaudeTerm to do).

## What the user sees

### Tabs on top or on the left

- A setting **Tabs: Top / Left** (`tabs.position`, `"top" | "left"`, default `"top"`) in the Settings window, and a
  button that switches it: at the right end of the tab bar on top, at the right of the panel's header on the left.
  The choice is saved in `settings.json` and kept across restarts.
- **Top** is today's tab bar, unchanged, except for forks (below): no groups, no branch line.
- **Left**: a panel on the left of the window, the full height between the banners and the status bar. The tab bar
  on top goes away.

### The left panel

- **Header** (34 px, like today's tab bar): **+** and **▾** on the left; on the right the Changes and Media toggles
  (and Note, when session notes exist on the branch — see "Session notes" below), then the position button. The
  buttons behave exactly as in the tab bar on top.
- **Width**: 240 px to start; the user drags the panel's right edge to change it, and the width is kept across
  restarts. *(Claude's call: between 160 and 480 px.)*
- **Groups**, one per project, in this order: projects, then **No project** last.
  - A **project** is a git repository: every tab whose folder is inside the repository or inside any of its
    worktrees belongs to it. Its header shows the main worktree's folder name, small and uppercase, with a chevron.
    *(Claude's call: two projects whose folders have the same name show the parent folder too, `acme (work)`.)*
  - **No project**: tabs whose folder is not in a git repository.
  - A tab's group is decided by the folder it was **opened in**, for Claude and shell tabs alike; it never moves
    when Claude or the shell goes to another folder later. *(User's decision.)*
  - A click on a group's header folds or unfolds it. A folded group shows how many tabs it holds, and a dot: pulsing
    when Claude waits in one of its tabs, steady when one has a bell or activity mark. Which groups are folded is
    kept across restarts. *(User's decision.)*
  - When a tab in a folded group becomes the active one (Ctrl+Tab, Ctrl+Alt+N, Recent sessions, a new tab, Restore),
    its group unfolds, and that is kept like a click on the header. The active tab is always visible. *(User's
    decision.)*
  - **Submodules and bare repositories**: a submodule is a project of its own. For a bare repository with linked
    worktrees (`~/src/acme.git` and its worktrees), the project is named after the bare folder without `.git`
    (`acme`), and since it has no main worktree, every one of its worktrees has a colored bar. *(User's decision.)*
- **A tab's row**, two lines:
  1. the same things as a tab on top: the kind icon (✳ / >), the title, the muted icon, the bell dot, the unseen
     images count, × (shown on hover and on the active tab); the active tab is highlighted with the accent on its
     left edge; the attention pulse as today;
  2. the **branch** of the tab's folder with a branch icon, small and dimmed. *(User's decision: on every tab.)* A
     folder outside git has no second line. *(Claude's call: a detached HEAD shows the short commit id.)*
- **Worktrees**: a tab whose folder is in a linked worktree (not the repository's main worktree) has a **colored bar**
  at its left and its branch is written in the same color. The main worktree has no bar. The tooltip names the
  worktree's folder. Colors: each worktree takes the palette color its path hashes to; when another worktree of the
  same project already has that color, it takes the next free one (worktrees ordered by path). So a color stays the
  same from run to run and never repeats inside a project while the palette has free colors. *(User's decision.)*
- **Order and dragging**: tabs keep their order inside a group; a tab is dragged only within its own group, and a
  group is dragged by its header. A new tab goes to the end of its group. *(User's decisions.)*
- **Families when dragging**: dragging a family's head moves the whole family; a fork is dragged only within its
  family; no other tab can be dropped between a head and its forks. *(User's decision.)*
- Double-click renames, middle-click closes, right-click opens the tab menu — as on top.

### Keyboard

- With tabs on the left, **Ctrl+Tab / Ctrl+Shift+Tab** and **Ctrl+Alt+1…9** (⌘ equivalents on macOS) follow the
  order the panel shows: group by group, top to bottom, folded groups included. *(User's decision.)* On top they
  follow the tab bar as today.

### Forks

- The tab menu of a Claude tab gets **Fork session**. It is enabled when the tab's conversation can be resumed (it
  has a session id and Claude Code has written its transcript — the same check a restart uses), disabled otherwise.
- **Fork session** opens a new Claude tab in the parent's folder, on the parent's account, running
  `claude --resume <parent's session id> --fork-session`. The new tab is the **fork**; the tab it was made from is its
  parent.
- **A family** is a tab and every fork made from it or from its forks. The tab that is not a fork is the family's
  **head**; every fork in the family points to the head, not to the tab it was forked from. *(Follows from the user's
  decision that a family's forks stand at one level.)*
- The fork's title is the usual title with **` (fork)`** after it; a title the user set by renaming the fork is shown
  as it is. When the parent has a name the user gave it, the fork starts with that name and ` (fork)` after it, as
  its own name (e.g. `auth refactor (fork)`); renaming the fork replaces it. *(User's decisions; the renamed-fork case
  is Claude's call, not objected to.)*
- **Left**: forks stand right under the family's head, indented one level, in the order they were made. A fork of a
  fork joins the same family at the same level. *(User's decision.)*
- **Top**: a new fork is placed right after its family. *(User's decision.)*
- **Closing the head**: every fork of the family becomes an ordinary tab of the group, in the head's place; they
  keep ` (fork)`. Closing a fork leaves the rest of the family as it is. *(User's decision; keeping the suffix is
  Claude's call, not objected to.)*
- **Restart and Restore** keep the relation: restored forks stand under their restored head again. *(User's
  decision.)*
- **A fork with no conversation of its own yet** (Claude Code may not write the copy's transcript before its first
  message): Restore, Restart session and Continue as fork it again from the conversation it was forked from, so a
  fork always comes back as a fork of that conversation. A fork whose own conversation has a transcript resumes it as
  any tab does. *(User's decision.)* **Fork session** on a fork is enabled under the same rule as on any tab.

### Session notes

Session notes (PR #15) may land on `master` before or after this work. Where both exist: the Note button joins the
Changes and Media buttons in the left panel's header, and the note mark shows in the first line of a tab's row.
*(Claude's call.)*

## How it works

### Project, worktree and branch of a folder — main

- A new main-side module answers, for a folder: the project (the main worktree's path), whether the folder is in a
  linked worktree and that worktree's path, and the branch. From `execGit` in that folder:
  `rev-parse`, and `worktree list --porcelain` where the common dir alone cannot tell (submodules, bare
  repositories) — the exact calls are the builder's. A submodule is its own project; a bare repository's project is
  the bare folder (named without `.git`) and all its worktrees are linked; otherwise the project is the main
  worktree, and a folder is in a linked worktree when its git dir differs from the common dir. Paths compared with
  `pathKey`.
- Asked per distinct folder, cached, and refreshed when a tab opens, when a tab comes to the front, when the window
  gets the focus, and when a Claude turn ends (`attention` `done`). *(Claude's call.)* Never blocks the main process;
  a folder git cannot answer for is "No project".
- Main sends the renderer each tab's place: `{ project: { key, name } | null, worktree: { key, path } | null,
  branch: string | null }`.

### Tabs and forks — main

- `TabInfo` gets `forkOf: string | null` — the id of the family's head while it is open — `fork: boolean` (shows
  ` (fork)` after the head is gone), and `forkFrom: string | null` — the session id of the conversation the fork was
  made from, to fork it again (below).
- A fork is opened with a request that says so (e.g. `OpenTabRequest.forkOf` and the session to fork). The launch adds
  `--fork-session` after `--resume <id>` (`src/main/profiles.ts`). **The fork tab starts with `claudeSessionId =
  null`**, not the parent's id: it takes its own id from its `SessionStart` (`source: "fork"`). Otherwise Recent
  sessions, restore and the Changes panel would take the fork for the parent's conversation until the hook arrives.
- Closing a family's head sets `forkOf = null` on every fork of the family (and tells the renderer); closing a fork
  changes nothing else.
- **Restart, Continue as and Restore of a fork**: when the fork's own conversation can be resumed (it has a session
  id and a transcript), it is resumed as any tab is; otherwise the tab runs `--resume <forkFrom> --fork-session`
  again and takes its new id from `SessionStart`.
- **Restore**: `SessionSnapshotTab` gets `forkOf: number | null` — the index of the family's head in the snapshot's
  tab list (tab ids change on restore) — `fork: boolean` and `forkFrom: string | null`; a snapshot without them
  (older versions) restores plain tabs.
- Tab order: `TabManager.order` stays the one order main keeps. The renderer derives the left panel's order from it
  (groups, then families); a drag in the left panel and a new fork's place are written back as a new whole order
  (`tabs:reorder`), so the order on top and the snapshot follow.

### Layout state

- `tabs.position` is a setting (`settings.json`, Settings window, `SettingKey`).
- The panel's width and the folded groups (by project key) are kept by main in a small state file in the data folder
  (like `window-state.json`), not in `settings.json`. *(Claude's call: they are layout state the user does not edit
  by hand.)*

### Renderer

- A new module for the left panel (header, groups, rows, folding, dragging, resizing), next to `TabBar`; both get the
  same items and callbacks, and `main.ts` shows one or the other by `tabs.position`.
- `TabBarItem` gets the fields the rows need (project, worktree, branch, fork, family).
- The Changes / Media / Note toggles and the position button move between the tab bar and the panel header.
- The tab menu (`tabMenu` in `main.ts`) gets **Fork session**.

## Out of scope

- Following Claude's or the shell's current folder (the user chose the folder a tab was opened in).
- Showing forks made inside Claude Code (`/fork`, `/branch`) as sub-tabs.
- Groups or branch lines on the tab bar on top.
- Dragging a tab into another group.
- Showing the worktree of a shell tab's current folder (shells report no current folder; would need shell
  integration).

## Testing

Per AGENTS.md, every behavior through the entry point that uses it; tests use their own data folder, a stand-in
`claude`, and git repositories made in temp folders (with `git worktree add` for linked worktrees).

- **Unit**: the folder → project / worktree / branch answer from `git` output (main worktree, linked worktree,
  outside git, detached HEAD, paths with `/` and `\`, 8.3 short names); the left panel's order (groups, families,
  forks of forks, a closed parent); the snapshot's `forkOf` and `fork` (read, write, old snapshots); the launch line
  with `--fork-session`; stable worktree colors.
- **End-to-end**:
  - switching top / left with the button and in Settings; the choice kept after a restart;
  - tabs in two repositories, one with a linked worktree, and one outside git: the groups, their order, the branch
    line, the colored bar on the worktree tab only;
  - folding a group, its count and pulsing dot; folded groups kept after a restart;
  - dragging a tab within its group and a group by its header; the order on top follows;
  - the panel's width dragged and kept after a restart;
  - Ctrl+Tab and Ctrl+Alt+N following the panel's order;
  - **Fork session**: disabled for a tab without a conversation; the new tab runs
    `--resume <id> --fork-session` (the stand-in prints its arguments), stands under its parent, is titled
    `… (fork)`, has no session id until its `SessionStart` (`source: "fork"`) arrives and then has the new one;
  - a fork of a fork joins the family; on top, a new fork lands after its parent's family;
  - closing the parent: the forks become ordinary tabs in its place, still ` (fork)`;
  - restart and Restore: forks under their parents again.
- The terminal keeps its size when the layout does not change (the panel opens or closes only on a switch).

## Docs

- README: the tab position and the left panel under Features, Fork session in the tab menu's description, and the
  setting in the settings table. Regenerate the README images with `npm run screenshots` only for the ones that
  change, and add one of the left panel if the README shows it; invented projects and branches only.
- The CHANGELOG entry is written at release time.
