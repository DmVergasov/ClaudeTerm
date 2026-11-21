# Folder groups for tabs outside git — design

## Intent

The left panel and the tab bar group tabs by git project; every tab outside a git repository lands in one **No project**
group. A Claude session in a project folder that is not a git repository (an Unreal project such as `D:\Workspace\SpaceGame`)
is then shown as having no project, though the sheet header names its folder. The person wants such tabs grouped by their
folder, with a git repository still taking priority.

## Goals

- A tab whose folder git has confirmed to be outside any repository is grouped by that folder: the group is named by the
  folder's name (with its parent folder when another group has the same name, as git groups are).
- A folder inside a git repository is grouped by the repository, exactly as today.
- Tabs of the same folder share one group; this device's tabs and each paired device's tabs (in that device's section) follow
  the same rule.
- A folder group can be dragged and folded like any project group.

## Non-goals

- No project note, no **+ Coordinator** chip, no branch line for a folder group: they all need git.
- No change to what main computes (`TabPlace`, `TabPlaces`) or to the device sync format.
- Subfolders are not merged into a parent folder's group: `SpaceGame\Source` is a group of its own.

## Anti-goals

- A tab must not jump between groups while git has not answered yet: until its place is known, a tab stays in No project, as
  today, and the tab order is not written back meanwhile.
- A shell opened in the home folder or at a drive root is not a project: it stays in No project.

## Approaches

1. **Group in the window (chosen).** The renderer's grouping (`src/renderer/tab-groups.ts`) keys a tab whose place is known
   to be null by its folder. Small, pure and unit-testable; main, notes, coordinators and sync are untouched.
2. **Folder places in main.** `TabPlaces` would publish a folder "project" for folders outside git, so project notes and the
   coordinator would work for them too. More than was asked, changes the shape other devices validate, and the coordinator
   relies on git.

The person approved approach 1.

## Design

- The window knows a place is known when `places.has(id)`; a known place of `null` means outside git (for paired devices'
  tabs too: their place reaches the window only once their device has published it).
- A pure helper in `tab-groups.ts` turns such a folder into a folder group `{ key, name, parent }`, or null for the home
  folder (this device's `appInfo.homeDir`; for a paired device's tab, the usual home locations: `X:\Users\<name>`,
  `/Users/<name>`, `/home/<name>`, `/root`) and for a drive or file-system root. The key is the folder with its separators
  made `/`, its trailing separator dropped and, for a Windows path, lower-cased, prefixed so it can never equal a git project
  key.
- `panelGroups` keys a tab by its git project, else by its folder group, else No project. A folder group carries the folder
  as its project (name, parent) and a flag that it is a folder: `groupChip` gives it no chip; labels, group drags and folds
  treat it as a project group.

## Left to the builder

- The e2e tests whose tabs sat in No project only because their temp folders are outside git: keep each test's intent, either
  by expecting the folder group or by opening its tabs where they share a group.
