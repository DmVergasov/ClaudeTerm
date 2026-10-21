# Changelog

What changed in each ClaudeTerm release. The GitHub release of a version shows its section from this file.

## 0.8.2

### Changes

- **The Changes panel shows three times as much at once.** A view now reads up to 15 MB of text before it says there are too many changes to show, instead of 5 MB.

### Fixes

- **Code files show their changes next to many binary files.** In a project with a lot of binary files, such as the `.uasset` assets of an Unreal project, the Changes panel used up what it reads on those files and listed every code file after them as "not shown" with +0 −0, under "Too many changes to show at once". Binary files no longer count toward that limit, so your code shows its changes again. The status bar's line count now also counts the lines of new files that come after binary ones.

## 0.8.1

### Fixes

- **The plan's progress counts the finished tasks.** When Claude wrote the plan's progress as a list, in bold or as headings (`- Task 3: complete`), the status bar showed 0 tasks done for the whole plan. It now reads those lines too.

## 0.8.0

### New

- **See how far Claude has got with a plan.** While Claude carries out a plan with the superpowers plugin (`subagent-driven-development` or `executing-plans`), the status bar under its tab shows how many tasks are done and which one it is on: `3/7 · Save dialog and file writing`. Click it for the whole list — done tasks ticked, the current one highlighted, the rest still to come; Esc or a click elsewhere closes it. It follows the plan's progress as Claude works, ends with ✓ when the plan is finished, and a restored session shows its plan's progress again.

## 0.7.0

### New

- **Mute a tab.** Right-click a tab → **Mute sound**, and Claude waiting for you, asking a question or finishing its answer in that tab — or a bell in its terminal — makes no sound any more. The tab is still highlighted and the taskbar still flashes, so you don't miss it; a crossed-out speaker on the tab shows that it is muted. **Unmute sound** brings the sound back. Restart and **Restore previous session** keep the mute.

## 0.6.1

### Fixes

- **A tab closed right after it opened closes at once on macOS.** While the shell of a new tab was still running your shell profile, for example `brew shellenv`, nvm or conda, closing the tab or quitting ClaudeTerm waited until the profile's current command finished. The tab now ends that command together with the shell.

## 0.6.0

### New

- **ClaudeTerm for macOS.** A disk image for Apple Silicon and Intel Macs, macOS 12 or later. It is not signed with an Apple Developer ID, so macOS blocks its first start: after dragging ClaudeTerm to Applications, run `xattr -dr com.apple.quarantine /Applications/ClaudeTerm.app` once, or click **Open Anyway** in **System Settings → Privacy & Security**. The shortcuts use ⌘ where Windows and Linux use Ctrl+Shift — ⌘T, ⌘W, ⌘C, ⌘V, ⌘F, ⌘⇧H, ⌘1…9 — and Ctrl keys go to Claude Code, so Ctrl+C interrupts and Ctrl+V pastes an image. The README has the full table.
- **ClaudeTerm updates itself on macOS too.** It downloads a new version, checks it and puts it in place of the old one when you click **Restart**. Where it cannot replace itself, for example when started from the disk image instead of Applications, the update banner's **Download** opens the release page.
- **Drag the file tree's edge in the Changes panel** to make the tree wider or narrower. `review.treeWidth` in settings.json sets the width it starts with.

## 0.5.0

### New

- **More than one Claude subscription.** Add your other accounts in **Settings → Accounts** and move a Claude tab between them in one click: **Continue as …** in the tab's right-click menu, or a click on the account in the status bar, restarts Claude Code on the other account and continues the same conversation. Handy when one subscription runs into its limit, or to keep work and personal tabs apart, side by side. The **▾** menu opens a new Claude tab on any of your accounts, a new Claude tab takes the account of the tab you are in, and the window title names the extra account of the tab in front. Restart and **Restore previous session** keep each tab's account.
- Your normal Claude Code login stays the **Main account**. An extra account is a token from `claude setup-token`, valid for a year: **Get a token** runs it in a tab — sign in to claude.ai with that account in the browser first, then paste the token it prints. The tokens are encrypted by the system (DPAPI on Windows, the keyring on Linux). Claude Code lets a token make model requests only, so a tab on an extra account has no claude.ai connectors and no Remote Control.

## 0.4.0

### New

- **Images and Changes open beside the terminal, not in its place.** The window widens by the panel's width, so the terminal and Claude Code's screen keep their size, and closing the panel gives the width back. A maximized window, or one with no room left on the screen, shows the panel over the right of the terminal; **Settings → Appearance → Panels without room** can have it narrow the terminal instead.
- **A file tree in the Changes panel.** The changed files by folder, on the left of the diff: click a file to jump to it, type in **Filter files** to show only the files whose path holds the text, and fold or unfold every file at once with ⊟ and ⊞. ☰ hides the tree.
- **What's new in the update banner.** From the next update on, the banner that offers to restart into a new version lists what changed in every version since yours.

### Changes

- **The window title shows the tab's folder**, so the taskbar and Alt+Tab tell your projects apart. A tab's tooltip shows its full folder too.

### Fixes

- **`show_diff` shows a file git ignores when you name it.** Asking Claude for the diff of, say, a plan in an ignored `docs` folder answered that there was nothing to show; such a file now opens as a new file.
- **Copying a selection in Claude Code's fullscreen mode reaches the clipboard.** Claude Code copies its own mouse selection with an OSC 52 sequence, which ClaudeTerm ignored, so where Claude Code's fallback through PowerShell fails (for example when a group policy restricts PowerShell) the copied text never arrived.

## 0.3.1

### Fixes

- **The Changes panel stays on your project when Claude looks into another repository.** When Claude ran a command with `cd` into another git repository, for example the engine next to your game project, **Uncommitted** and the changes counter in the status bar switched to that repository's changes from the next prompt on. They now always show the repository of the folder the tab was opened in.

## 0.3.0

### New

- **Find in the Changes panel.** Click into the diff and press `Ctrl+F`, or use the find button in the panel's header: every match in the code and the file names is highlighted, `Enter` and `Shift+Enter` step through them, and a folded file opens when a match is inside it. `Ctrl+F` in a terminal still goes to the terminal.
- **Hide test files.** Tick **Hide tests** in the Changes panel to leave test files out of every view; the panel says how many it hid. Which files count as tests is yours to set in **Settings → Review → Test files**, one pattern per line. The defaults cover folders like `test/`, `tests/` and `__tests__/` and names like `*.test.*`, `*.spec.*` and `*Test.*`.
- **Star your important sessions.** In **Recent sessions** (`Ctrl+Shift+H`), click ☆ or press `Ctrl+D` to star a conversation: starred ones stay at the top of the list, however old they are. A Claude tab's right-click menu has **Star session** too. `Ctrl+Shift+H` and then `Enter` still continues your latest conversation.
- **Show in Explorer** in a changed file's ⋯ menu opens its folder with the file selected.

## 0.2.0

### New

- **Review Claude's changes next to the conversation.** Press `Ctrl+Shift+D`, or click the new **Changes** button in the tab bar or the changes counter in the status bar, to open the Changes panel beside a Claude tab. **Uncommitted** shows everything not committed yet, untracked files included. **Last turn** shows what Claude changed in its latest turn with edits, and **Session** shows everything it changed in this conversation. Last turn and Session work without git too, and show only the files inside the tab's folder: Claude's own memory, other projects and temporary files stay out.
- **Comment on lines and send the comments to Claude.** Hover a line and click **+**, or drag along the margin for several lines. **Send to Claude** writes all your comments as one message, with the file, the line and the quoted code, and the diff updates while Claude works on them. **Viewed** folds the files you are done with; a file Claude changes again unfolds.
- **Claude can open a diff for you** with the new `show_diff` tool: ask for "the diff of the last three commits, only src/main" and it appears in the panel.
- Right-click a line to open the file at that line in your editor: VS Code by default, or your own command in **Settings → Review → Editor**, for example `rider64 --line {line} {file}` for Rider.
- **A changes counter in the status bar** shows how many files and lines changed: uncommitted changes in a git repository, this session's edits outside one. **Settings → Review** can hide it.
- **Hide files git ignores** (on by default, in **Settings → Review**): Last turn and Session leave out build output and other ignored files, and the panel says how many it left out.
- To show a file as it was before Claude's edit, ClaudeTerm keeps a copy of it in `%APPDATA%\ClaudeTerm\review` (`~/.config/ClaudeTerm/review` on Linux). Copies of a conversation untouched for a week are deleted.

## 0.1.9

### Fixes

- **Restart session resumes the conversation even after Claude moved to another folder.** When Claude changed its working folder during a session, Restart session started a new conversation instead, and the conversation's images did not reach the image panel.
- After an update, your tabs come back by themselves even when the system clock was adjusted during the restart, as happens under WSL or with network time sync. Before, ClaudeTerm only offered to restore them.

## 0.1.8

### New

- **ClaudeTerm runs on Linux.** Download `ClaudeTerm-0.1.8.deb` from the release and install it with `sudo apt install ./ClaudeTerm-0.1.8.deb` (x64; Ubuntu 22.04 or later, Debian 12 or later, and their derivatives). Shell tabs open your login shell, bash, zsh or fish; Claude tabs, the status bar, notifications, the image panel, session restore and updates work as on Windows. Installing an update asks for your password. To paste images into Claude, install `xclip` (X11) or `wl-clipboard` (Wayland).

## 0.1.7

### Changes

- **The image panel follows the conversation, like the Claude mobile app.** It shows the images of the conversation (tool and MCP screenshots, images Claude opens with `Read`, images you paste, and those of subagents), images Claude shows with `show_image`, and new images in the session's scratchpad, the temp folder Claude Code gives each session. ClaudeTerm no longer watches the project folder, so images that another Claude session, a dev server or a test run writes there stay out of your panel. An image Claude saves in the project appears once Claude opens it or shows it.
- The setting **Watch Claude tab folders for new images** is now **Show new images from the session scratchpad**.

### Fixes

- **No more lag or freezes caused by watching for images.** When a watched folder was deleted and created again (build output, test results, a script that clears its output), ClaudeTerm could keep a CPU core or more busy until it was restarted: the window lagged when dragged, and the app could stop responding.
- Claude tabs in large projects open without a pause: ClaudeTerm no longer scans the project's folder tree first (a big Unreal project took about 13 seconds).
- A burst of images written at once, such as dozens of screenshots, now shows up in full.

## 0.1.6

### New

- **Settings window**: press `Ctrl+,` or choose **▾ → Settings…**. It covers notifications, font and size, theme, scrollback, the default shell, the command and shell for Claude Code, image watching and updates. Changes apply at once, and `settings.json` can still be edited by hand.
- **Notifications per case.** For each case (Claude asks for permission, asks a question, finishes its answer, or a program rings the terminal bell) you choose the sound, the taskbar flash and the tab highlight separately. The sound can be your own `.wav`, with a button to play it.
- A terminal bell from any program can now flash the taskbar and mark its tab.

### Fixes

- Changing a setting no longer resets the terminal zoom (`Ctrl+=`).
- A problem in `settings.json` is shown once, not again on every reload.

## 0.1.5

### New

- **Recent sessions**: press `Ctrl+Shift+H` or choose **▾ → Recent sessions…**. It lists your latest Claude Code conversations from every project, including ones started outside ClaudeTerm, in VS Code or in the Claude desktop app, with their titles, folders and last messages. Type to filter, and press Enter to continue one: it opens in a Claude tab in its folder, or ClaudeTerm switches to the tab that already has it.

## 0.1.4

### New

- **Restart session** in a tab's right-click menu restarts Claude Code in the same tab and resumes the conversation. It is handy after adding an MCP server, a plugin or a setting that Claude Code reads only at startup. Shell tabs get **Restart shell**.
- The status bar shows the **weekly limit** next to the 5-hour one; hover over it to see when it resets.

## 0.1.3

### New

- **Automatic updates.** ClaudeTerm checks GitHub for new versions in the background, downloads them and offers to restart into them, and your tabs and Claude conversations come back after the restart. **▾ → ClaudeTerm <version> — check for updates** checks right away, and `"autoUpdate": false` in `settings.json` turns it off.
- The whole interface is in English: menus, banners, notices and tooltips.

### Note

- Versions 0.1.2 and earlier can't update themselves: install 0.1.3 once by hand, and later versions arrive on their own.

## 0.1.2

### New

- A tab where Claude is waiting for you pulses until you open it.

### Fixes

- A custom notification sound that can't be played falls back to the Windows sound and tells you why.

## 0.1.1

### New

- **Know when Claude is waiting for you.** When Claude asks for a permission, asks you a question or finishes its turn in a tab you're not looking at, ClaudeTerm plays the Windows sound, flashes its taskbar button and marks the tab.

## 0.1.0

The first release: a Windows terminal built for Claude Code.

- **Tabs for every shell**: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash and every WSL distribution are found automatically. Claude tabs run `claude` inside your shell of choice.
- **Image panel**: every image of the conversation sits next to its tab. That covers screenshots from tools and MCP servers, images Claude reads, images you paste, subagents' images, and new images in the project folder. The bundled `show_image` MCP tool lets Claude show you any image. A button in the tab bar opens the panel and counts unseen images.
- **Status bar**: the model and effort, how full the context is, the 5-hour limit and the subagents running right now.
- **Open Claude Code here** in the Explorer right-click menu.
- **Sessions come back after a reboot**: the same tabs reopen, and each Claude tab resumes its own conversation.
- Font sizes in points, the same as Windows Terminal.
