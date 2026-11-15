# Coordinator chip on the project header — design

## Why

The project coordinator (0.22.0) is made from a Claude tab's context menu, **Make project coordinator**. Nothing in the
window says that a project can have a coordinator, or whether it has one now. The person wants to see at a glance
whether a project's coordinator runs, and to start one with a single click.

## What the person sees (approved mockup: variant B, without the tooltip)

The mockups (variant B in three frames, and the three variants side by side) were made on the captured window, tabs on
the left, in the Graphite theme, in the conversation of 2026-11-15. They show the person's real projects, so they are kept
outside the repository.

- **A chip on each project group's header in the left panel**, between the project's name and its tab count. It shows
  on a folded group too.
- **`● Coordinator`** (accent text, accent dot, a thin accent outline): the project has a coordinator on this device. A
  click brings the coordinator's tab to the front.
- **`+ Coordinator`** (muted text, a dashed outline): the project has no coordinator on this device. A click opens a new
  Claude tab in the project's folder. That tab becomes the project's coordinator at once, stands first in its group with
  the Coordinator label, and is the active tab. The chip then reads `● Coordinator`.
- **No tooltip or explanation popover.** The chip's text says what it is. (The person struck the explanation block from
  the mockup.)
- **A narrow panel**: the chip keeps its dot or its `+`, without the word. The project's name gives way first and ends
  in an ellipsis, as in the mockup.
- **No chip**: on the "No project" group, and on the groups in a paired device's section. A coordinator is used from its
  own device's window (a non-goal of the coordinator design).

## Goals

1. Make it visible which projects have a coordinator running on this device.
2. Make the coordinator easy to find: every git project shows a way to start one.
3. Start a coordinator in one click, with no dialog.

## Non-goals

- The tabs-at-top layout. It keeps today's way: the tab's context menu. (Calls made, below.)
- Attaching the project's open sessions to the new coordinator. The person attaches them by dragging, by **Attach…** or
  through the coordinator, as today.
- Replacing a running coordinator from the chip. `●` only goes to it; the context menu keeps **Make project coordinator**
  with its replace question.
- A coordinator for a paired device's project from this window.

## Anti-goals

- **No click opens two coordinators.** A second click while the new tab is still becoming the coordinator brings that
  tab to the front. It does not open another tab.
- **No noise.** The chip does not pulse or spin, and the coordinator gets no message from it. The coordinator's own row
  keeps today's working and attention states.
- **The chip never hides the group.** A click on the chip does not fold or unfold the group, and does not start a drag
  of the group.

## Approaches considered

- **A. An icon on the project header** (the Sessions panel's people icon: accent when a coordinator runs, grey when
  none). The most compact, but a grey icon is easy to miss.
- **B. A chip with a word on the project header** (`● Coordinator` / `+ Coordinator`). Readable at once, at the cost of
  the project's name in a narrow panel. **Picked by the person.**
- **C. A dashed "+ Start a coordinator" row at the top of every project without one.** The most visible, but it adds a
  row to every such project.

## Behaviour

- **Which projects.** A group with a `project` (a git project) in this device's part of the panel.
- **`●` or `+`.** `●` when one of the group's tabs is this device's coordinator, by the coordinator marks the renderer
  already has. Otherwise `+`.
- **Starting.**
  - A new Claude tab opens in the project's main folder: the main worktree's path. For a bare repository, which has no
    main worktree, it opens in the folder of one of the group's tabs.
  - It is a tab like a **+ New tab** Claude tab opened there: this device's default account, Claude Code's default
    permission mode, ClaudeTerm's default view.
  - It gets no first message. The coordinator learns its role at its first turn, as a coordinator made from the menu
    does today.
  - A tab can be made a coordinator only once it has a session. So main keeps the new tab as "to be made coordinator"
    until its session starts (the SessionStart hook), and then makes it one, as **Make project coordinator** would.
- **When the start fails.**
  - If the tab exits or is closed before its session starts, nothing is made.
  - If making it the coordinator is refused (another coordinator of the project appeared meanwhile, the coordinator
    limit), the tab stays an ordinary Claude tab and the refusal shows as a toast, as for the menu item.

## Calls made in this design (the person may override)

- No chip in the tabs-at-top layout.
- The open sessions are not attached to the new coordinator.
- The new tab opens in the main worktree's folder, not in the folder of the active tab or of a worktree.
- A `+` click while the new tab is still starting brings that tab to the front.
- The work goes on `feat/project-coordinator` before the 0.22.0 release, after the `feat/coordinator-delegate` merge.

## Left to the builder

- The chip's exact sizes and colours, within the mockup and the theme's variables.
- The width at which the chip drops its word.
- How main keeps the "to be made coordinator" tabs (the coordinator hub's pending starts are the nearest pattern), and
  the IPC call that opens such a tab.
