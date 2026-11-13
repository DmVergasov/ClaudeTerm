# Changelog

What changed in each ClaudeTerm release. The GitHub release of a version shows its section from this file.

## 0.20.0

### New

- **The Agent messages panel shows what agents write to each other with Claude Code's own `SendMessage`** too, not only the messages ClaudeTerm carries. A message between two of your tabs shows once, in their conversation; a session outside ClaudeTerm shows under the name Claude Code gives it. A new message marks its tabs as unread; what a session's transcript already held when the tab opened comes in read.

## 0.19.0

### New

- **Claude goes on after a usage limit.** When the 5-hour or the weekly limit stops Claude in the middle of its work, that limit's meter at the top of the window counts down to its reset, and a minute after it Claude goes on by itself, in a chat and in the terminal. Text you left in the message box holds it back, and the tab calls you instead. **Settings → Claude Code → Go on after a usage limit** turns it off.
- **Heads up in the chat.** While Claude works, a side agent reads the conversation now and then and, when it finds something you would likely miss — a decision Claude made in passing, a result that may be off, a concept the work depends on — shows it as a card above the message box, in the language you write in. **Explain more** brings a longer explanation, **Not relevant** keeps the topic from coming back, **Got it** closes it. It runs on Sonnet and uses your plan; **Settings → Claude Code → Heads up** turns it off.
- **What each agent runs on, and for how long.** The agents at the end of the conversation show the model each one runs on, the effort its call asks for, how many tokens its context holds, and how long it has been running; the full model name and count are in the tooltip.

### Changes

- The model picker lists the newest model of each family. The older ones are under **More models**, and one you picked from there stays in view.

### Fixes

- The model picker of a new chat, opened before its first message, has the model the chat runs checked and shows its effort levels.
- A Media or Changes panel you close goes at once: it no longer shows again for a moment, half closed.
- The first Media or Changes panel you open after starting ClaudeTerm opens at once, not a second later (Windows).
- A chat whose conversation works in a git worktree shows that worktree's branch in the tab list again after a restart or a resume, not the branch of the folder the tab was opened in.
- When Claude enters a git worktree, the Changes panel shows the worktree's changes, not those of the folder the tab was opened in.
- With a side panel open, the changed files counter stands at the right end of the status bar again, under the panel, while the session's part stays under the message box.
- The progress of a plan Claude carries out no longer disappears from the status bar while a task runs: an old plan a subagent once looked at, or a plan file kept beside the plans' working folders, no longer takes its place.
## 0.18.0

### New

- **Claude tabs as a chat.** A Claude tab can show a conversation instead of the terminal: Claude's answers as text with code, tables and images, each tool call as a step you can unfold, permission requests and questions as cards you answer with a click, and a message box with attachments, `@` files, `/` commands, the model and effort picker and the permission mode (Shift+Tab, Auto included when the model supports it). The terminal is one click away on the tab's header, and **Settings → Claude Code → Claude tabs open in** picks the view new tabs start in.
- **A new look.** The Graphite theme, a title bar with your usage limits, tabs on a sheet, and restyled panels, dialogs and settings. The chat takes the colours of the terminal theme you choose, light themes included.
- **A new settings window,** with a search box and a page for each part of the app.
- **Quote Claude's words.** Select text in an answer and click **Quote**: it goes above the message box as a quote, up to five of them, and your message carries them.
- **The agents Claude runs, at the end of the conversation.** A card lists them with their progress while they work, as the conversation's last message, above the "Working" line: it never covers Claude's text, and it stays in view while the answer comes in. Agents that outlive their turn, and agents resumed with `SendMessage`, stay on it until they end.
- **Compaction and restarts show what happens.** "Compacting conversation" while it runs, then how many tokens were left; "Restarting Claude Code" and "Session restarted" when you restart a session, with the conversation kept on screen.
- **Messages Claude Code puts in the conversation look like what they are.** The end of a background task, a message from another session or a scheduled prompt is a short row you can unfold, not a message bubble of yours full of tags.
- **Settings → Claude Code → Chat:** **Full-width chat** lets the conversation and the message box use the whole width of the window; **Copy selected chat text** (on by default) copies what you select with the mouse, as a terminal does.

### Changes

- **The model button shows the effort** Claude works at, for example "Opus · xhigh".
- **Claude's thinking is open from the start.** Click its "Thought for…" row to fold it; a block you fold stays folded.
- **The status bar keeps the session in the middle:** the account on the left, the context, agents, background tasks and plan in the centre, under the message box even while a side panel is open, the changed files on the right.
- **A chat shows its context fill while Claude works,** from the start of the turn and refreshed as it goes, not only once the turn has ended.
- **In a narrow window the tab's header buttons show their icons only,** so the tab's title stays readable; their names are in their tooltips.
- **Side panels slide** in and out instead of jumping.
- **`Ctrl+F` finds text in a chat** (as well as `Ctrl+Shift+F`).

### Fixes

- **"Working" no longer stays on after Claude has finished.** A message you sent while Claude worked, which Claude Code took into the running turn, left the chat waiting for a turn that never came (and marked your next message as queued). Answering a background agent's permission request after the turn had ended did the same.
- **A chat tab follows its session into a worktree,** and back out, as a terminal tab does.
- **A file you attach is mentioned by its short path** (`@notes.txt`) when the project folder is opened through a junction or a symbolic link, instead of by its full path.
- **The tab bar keeps the tab in front in view** when its title changes and makes it wider (Windows).

## 0.17.0

### New

- **Agents on your other devices and accounts can message each other.** Claude Code's own `SendMessage` reaches only the agents it lists itself, so a Claude tab on your other computer, or on another Claude account (where Remote Control does not work), was out of reach. ClaudeTerm now carries those messages over the device link: Claude finds such an agent with the `list_agents` tool and writes to it with `message_agent`, and the answer comes back the same way. An idle agent wakes up for a message (Claude Code 2.1.287 or later, in Claude tabs started after the update), and a message to a device that is offline goes out when it connects. Agents still use `SendMessage` first; ClaudeTerm only carries what it cannot.
- **See what the agents write to each other.** The envelope button beside Media opens the **Agent messages** panel: the conversations of the tab in front, or all of them. A tab with messages you have not read carries an envelope, and so does its device's chip; there is no sound and no pop-up. **Settings → Agent messages** turns the messages, or only the marks, off. Every device needs 0.17.0 for messages between devices.

### Fixes

- **A Claude tab keeps its folder when Claude only looks elsewhere.** A `cd` Claude ran into another folder moved the tab there, with that folder's project group and branch. The tab now moves only when the session does: `/cd`, or entering or leaving a worktree.
- **A tab group you fold right after a tab opens stays folded.** With the tabs on the left, a group folded in the first moments after a tab opened could unfold again on its own once ClaudeTerm learned the tab's branch.

## 0.16.2

### Fixes

- **Claude Code's screen no longer keeps bits of old text.** Emoji such as ⚠️, ✔️, 1️⃣, 👨‍💻 and flags take two cells in Windows' console and in Claude Code, and ClaudeTerm counted them as one. Every redraw after such an emoji landed a cell off, so the status rows below Claude's answer showed letters of earlier text mixed into the new one until the window was resized.
- **The Changes panel works in large projects that use Git LFS.** In an Unreal project with hundreds of changed assets the panel could show "git diff took longer than 10 s" and lose the diff, because git ran git-lfs for every changed asset, several times per refresh. ClaudeTerm now compares those files without git-lfs: the panel loads in a couple of seconds, and git-lfs no longer stores a copy of each changed asset in `.git/lfs` every time. A changed asset shows as a binary file instead of the text of its LFS pointer.

## 0.16.1

### Fixes

- **Switching tabs and typing no longer stall while Claude works.** With several busy Claude tabs, a switch to another tab could take a second or two, and typed keys showed up late. ClaudeTerm started git (for the Changes panel and the tab groups) and the notification sound in the same place that handles the window, and on a busy machine Windows sometimes takes a second to start a program. They start in the background now.

### Changes

- **Tabs run in Windows Terminal's console host (Windows).** It comes with ClaudeTerm and takes the place of the one built into Windows, which on Windows 11 24H2 could leave lines of Claude Code's screen behind or show them twice until the window was resized. **Settings → Shells → Console host** switches new tabs back to Windows' own.

## 0.16.0

### New

- **Open a tab on a device that has none open.** With the tabs on the left, a connected device keeps its header in the panel even when none of its tabs is open. Click the header to open a tab there: **New Claude Code tab**, or a new tab for one of its shell profiles. A device that is offline and has no tab is not shown, as before.
- **A + on each device's header.** With the tabs on the left, the header of each connected device has a **+** that opens the same menu, so you no longer need the right-click to open a tab on another device.

## 0.15.1

### Changes

- **Your other devices stay quiet for a tab you are watching.** When you are at one of your devices and watching a tab, the other devices no longer ring, flash or pop a notification for it; you count as at a device when its ClaudeTerm window is focused and you used its keyboard or mouse in the last 30 seconds, and as away once its screen is locked or it sleeps. Coming back to a device that shows a waiting tab clears that tab's mark on every device. A case set to **Even in front** still sounds on the device you are at, and when you are away from all of them, every device signals as before. Every device needs 0.15.1 for this.

### Fixes

- **A tab click always switches.** A click on a tab sometimes did nothing while Claude was busy in another tab. Now it always switches.
- **File paths are quoted for their shell.** A file dropped into a shell tab, or pasted or dropped into a shell tab of another device, is typed with that shell's own quoting (PowerShell, cmd, bash, zsh, fish), so a `$`, `!` or quote in its path reaches the shell as it is. Claude tabs keep double quotes.
- **Image paste in another device's Claude tab.** In another device's Claude tab, Claude Code's own image-paste key (Ctrl+V on macOS, Alt+V on Windows) pastes the image from this device's clipboard, not that device's.
- **Recent sessions opens the device you picked.** When two devices list the same session in **Recent sessions**, choosing it opens it on the device whose section you picked it from, or says that device is not connected.
- **⟳ says when a device is offline.** ⟳ in the Changes panel of a device that went offline now always says that it is not connected, even before any of its changes arrived.
- **A large set of changes from another device no longer stalls.** A very large set of changes from another device no longer makes ClaudeTerm stall while it arrives. One file with an enormous diff shows on the other device with its lines not shown, as files past the limit already did. A device still on 0.15.0 does not show a set of changes over 2 MB from an updated one, so update every device.
- **Answering at once leaves no waiting mark elsewhere.** Answering a finished turn at once (typing, or bringing the tab to the front, right as it ends) no longer leaves a waiting mark on your other devices.
- **Copying files to a shared Linux computer works.** Files copied to a Linux device no longer fail when another user of that computer uses ClaudeTerm too. Two files of one copy whose names differ only in how an accented letter is encoded no longer fail either.

## 0.15.0

### New

- **Devices: your other computers in one window.** Pair ClaudeTerm on two computers once. In Settings → **Devices** on the first one, click **Add a device**: it shows a code of sixteen characters and the addresses of that computer, valid for five minutes. On the other computer, type one of the addresses and the code into **Join a device**. The devices connect to each other directly, over a network you set up yourself: a home network, Tailscale or a VPN. Five wrong codes cancel the code that is shown. The first time ClaudeTerm accepts connections, Windows asks to allow it through the firewall, which needs an administrator; on macOS the system may ask to allow incoming connections. A device that the others cannot reach still connects to them, and Settings → **Devices** says **The other devices cannot connect to this one; to pair, show the code on the other device**.
- **Stars and notes are the same on every device.** Star a session, or write a note on a Claude tab, on one computer, and it shows the same on every computer in the group.
- **Another device's tabs under its chip.** Each device of the group has a chip with its name in the tab bar, before its own tabs. A dimmed chip means that device is offline. Click a chip to fold or unfold its tabs: a folded chip shows the number of tabs and a dot when one of them needs you. Right-click a chip for **New Claude Code tab**, a new tab for each shell profile of that device, and **Fold**. With the tabs on the left, a device's tabs stand under its name, grouped by project with their branch.
- **Work in another device's tab as in your own.** Click one of its tabs to see its screen and type into it. The terminal takes the size of the device you used last. Right-click the tab for **Fork session**, **Star session** and **Change folder…**; Change folder opens that device's folders, with its recent ones under **Recent on** and the device's name, and **Open here** makes the folder the tab's folder. This device's own tabs have **Change folder…** too.
- **Media, Changes, status bar and attention for another device's tabs.** A Claude tab on another device shows its status bar as its own tabs do: the model and effort, the context, the 5-hour and weekly limits, the agents running and the background tasks, the plan's progress and the changes counter. It also shows its Media panel and its Changes panel. Its files are on that device, so **Open in editor**, **Show in Explorer** and **Open in viewer** are left out for it. A tab there that needs you gets the same tab mark, sound and system notification as one of your own tabs.
- **Pasting and dropping files copies them to the tab's device.** Paste an image, or drop files, into a tab of another device, and they are copied to that device; the path that goes into the prompt is the one they are saved at there. A copy is limited to 50 MB and 100 files at a time, and a larger one is refused with a message.
- **Recent sessions of every device.** **Recent sessions** (`Ctrl+Shift+H`, `⌘⇧H` on macOS) lists the conversations of every connected device in a section of its own, headed with the device's name. Pick one to open it on its own device.
- **Keep a computer awake while another device uses it.** Settings → **Devices** → **Keep this computer awake while another device uses it** is on by default. The computer stays awake for 30 minutes after another device typed into one of its tabs, and for as long as a Claude tab another device is showing is working, while the devices are connected.
- **Claude can see your devices.** The bundled `device_status` tool tells Claude which devices are connected and what tabs they have open, read-only and with no codes or keys. The `open_device_settings` tool opens Settings → **Devices**, where you pair devices and remove them yourself.
- **Settings → Devices shows the group.** It lists this device's name and addresses, each device with its state, and for each connected device its number of open tabs (for example **3 tabs open**), and an address field for each device. **Remove** and **Leave the group** ask first.

## 0.14.0

### New

- **System notifications, and a jump to the tab that needs you.** When Claude in a tab you are not looking at asks for a permission, asks you a question or finishes its turn while ClaudeTerm is in the background, a system notification names the tab; a click on it brings the window forward with that tab open. The app icon counts the tabs that need you — a number on the Dock icon (macOS) and the launcher (Linux), a dot on the taskbar button (Windows) — and `Ctrl+Shift+J` (`⌘J` on macOS) opens the next of them. Settings → Notifications has a new **Notification** column to switch it per case.
- **See when Claude is working in a tab.** While Claude works, from your prompt to the end of its turn, the tab's ✳ spins through Claude Code's own spinner glyphs, on the tab bar and in the left panel, where a folded group spins too. It spins slower and in grey while an agent Claude left running after its turn still works, and a tab where Claude waits for you pulses instead. The ✳, ◐ or ◑ Claude Code puts before its title is left out of the tab's name. With reduced motion turned on in the system, the icon stays still.
- **A task list Claude can keep for you.** Claude can now put up a task list of its own with the bundled `set_task_list` tool — for longer work, or when you ask it to track the steps. It shows like a superpowers plan: `2/5 · Wire the export button` in the status bar, and a click lists every task. A superpowers plan in progress comes first. The list stays with the conversation through `/clear`, a restart with Restore, Recent sessions and Fork session, and **Clear** in the list removes one Claude forgot. ClaudeTerm allows the two task-list tools in its own tabs, so they never stop unattended work with a permission prompt.
- **How fast you are spending your limits.** Each usage limit in the status bar has a small bar: it fills with what is spent, and a mark shows how much of the limit's window has gone by. Grey means the limit lasts until it resets, yellow that it would run out in the second half of the time left, red sooner; hover for when it runs out at this pace, or how much will be spent by the reset.
- **Background work in the status bar.** When Claude ends a turn with work still running in the background — a dev server, a watcher, an agent — the status bar says how many and what: `2 in background: build, tail -f server.log`. Hover for each one's command.
- **More lines around a change, as on GitHub.** In the Changes panel, ↑ over a hunk and ↓ under it show 20 more lines of the file, and ↕ the rest of a short gap; two hunks with every line between them shown become one. These lines take comments too.

### Changes

- **The left tab panel narrows to half its width.** Drag it down to 110 px; below 220 px its header buttons take two rows.
- **Lighter on the CPU with many sessions.** ClaudeTerm read every transcript of every tab twice a second, including those of agents long finished, which slowed the window with ten or so busy sessions. Transcripts that bring nothing new are now read less and less often, and are read again at once when Claude starts a turn, ends one, starts or stops an agent or edits a file.

### Fixes

- **A tab follows Claude into another folder.** When Claude Code moved into another folder — a worktree it entered, a `cd` — the tab kept showing the folder it was opened in: in its title, its group and branch in the left panel and the window title. It now shows where Claude works.
- **A restored tab goes on with work Claude left in the background.** When ClaudeTerm closed after Claude had ended its turn but while agents or commands it started still ran, that work stopped with ClaudeTerm, and the restored conversation waited for it forever. With **Go on with the work Claude was doing when ClaudeTerm closed** on, such a tab now asks Claude to check what finished and start again what did not.
- **A superpowers plan shows even when its start went unseen.** The status bar learned of a plan only from the moment Claude set up the plan's workspace, and showed nothing if ClaudeTerm missed it. It now also recognises the plan from Claude's later steps of the same run.

## 0.13.0

### New

- **Documents Claude shows you, in a Docs panel.** Ask Claude to show you the spec, the plan or a report, and it opens the file in a **Docs** panel beside the terminal instead of printing it, with the bundled `show_document` tool. A Markdown file is shown formatted — headings, lists, tables and code — and you comment on it as in the Changes panel: hover a block, click **+**, and **Send to Claude** writes all your comments as one message. A PDF opens in the built-in viewer, with its own zoom, pages and find. An HTML report — coverage, test results, a generated page — runs in a sandboxed frame that cannot load anything from outside the report's folder or navigate away; since its scripts can read the files in that folder, a report in your home folder or at a drive root is not shown. When the file changes, the panel shows the new version. Open or close the panel with the **Docs** button, which shows once a Claude tab has a document, or `Ctrl+Shift+O` (`⌘O` on macOS).
- **Tabs on the left, grouped by project.** Settings → Appearance → **Tabs** → **On the left**, or the new button at the right end of the tab bar, moves the tabs into a panel on the left of the window. The tabs are grouped by project — the git repository of the folder each tab was opened in, its worktrees included — with **No project** last for folders outside git. Every tab in git shows its branch on a second line, and a tab in a linked worktree has a colored bar, in a color that worktree keeps. Click a group's header to fold it: a folded group shows how many tabs it holds, and a dot that pulses when Claude waits in one of them. Drag tabs within their group, and groups by their header; `Ctrl+Tab` and `Ctrl+Alt+1` … `9` (`⌘` on macOS) follow the panel's order. Drag the panel's edge to make it wider or narrower; the width and the folded groups are kept. The Changes, Docs, Media and Note buttons move to the panel's header.
- **Fork session.** Right-click a Claude tab → **Fork session** opens a new tab that continues a copy of the tab's conversation from where it is, in the same folder and on the same account; the original conversation stays as it was. The item is available once Claude Code has saved the conversation, after its first message. The fork is titled like its tab with **(fork)** after it. On the left it stands under its tab, indented; on top it lands right after the tab and its other forks. Closing the tab turns its forks into ordinary tabs. Restart and Restore keep each fork with its tab, and a fork you had not written in yet comes back as a fresh fork of the same conversation, with its note.

## 0.12.0

### New

- **A note on each Claude tab.** Click the **Note** button in the tab bar, or press `Ctrl+Shift+N` (`⌘N` on macOS), to write a note of your own on a Claude tab: which feature it is building, what is left to do, anything you want to find again tomorrow. The note lies over the top right of the terminal, translucent until you point at it: a one-line label with its first line, which a click opens into a card to edit; **–** folds it back into the label, **×** hides it, and the button brings it back as it was. A tab with a note shows a small note icon in its title, and the terminal keeps its size, so Claude Code does not redraw. The note stays with the conversation: through `/clear`, a restart with Restore, and when Recent sessions reopens the conversation after you closed its tab. `/resume` into a conversation that has a note of its own shows that note, and the tab's note stays with the conversation it left. Claude never sees your notes; they are kept in ClaudeTerm's own data folder.

## 0.11.1

### Fixes

- **Cut-off responses are continued on Windows.** In a Claude tab on Windows, Claude Code draws its prompt with `>` instead of `❯`, and ClaudeTerm did not see it there: **Continue a response a dropped connection cut off** gave up on every cut-off response and called you instead, a restored tab did not go on with Claude's work, and a tab you left with an unsent prompt was not highlighted even with that highlight turned on. ClaudeTerm now reads the prompt either way.
- **The plan's progress counts a task written as done at the end of a line.** When Claude recorded a task as done at the end of a longer line of the plan's progress (`… build green. Task 1: complete`), the status bar kept showing 0 tasks done. It now counts those lines too.

## 0.11.0

### New

- **Markdown files show formatted in the Changes panel.** A `.md` file — a spec or a plan Claude wrote, a README it changed — shows as the document it is: headings, lists, task lists, tables, quotes and code blocks. New and changed blocks have a green bar, a removed block stays where it was in red and struck through, and a changed paragraph shows its old version above the new one. Hover a block and click **+** to comment on it, or drag the **+** over several blocks; **Send to Claude** quotes the lines as before. Untick **Render Markdown** in the panel, or Settings → Review → **Show Markdown files formatted**, to see Markdown files as plain diffs.

### Changes

- **The expanded Changes panel fills the window.** ⤢ now spreads the panel over the whole window instead of leaving a strip of the terminal on its left.

## 0.10.1

### Changes

- **A Claude tab you leave unfinished no longer pulses by itself.** Highlighting a Claude tab you leave with a reply not read to its end or an unsent prompt is now off by default; turn it on in Settings → Notifications → **Highlight a Claude tab you leave with a reply not read to its end or an unsent prompt**. Right-click → **Mark as unread** works as before.

## 0.10.0

### New

- **Audio and video in the Media panel.** The image panel is now called Media. An audio or video file (`mp4`, `mov`, `webm`, `mkv`, `mp3`, `wav`, `m4a`, `ogg`) that Claude creates in its scratchpad, or shows you with `show_image`, gets a card with its name: a click opens it in your system's player, and right-click shows it in its folder.
- **A restored tab goes on with Claude's work.** When ClaudeTerm closed while Claude was still working in a tab — a reboot, an update, the window closed — that tab, once reopened, asks Claude to resume where it stopped a few seconds after the conversation is back. It does not if you type in the tab first, or for a turn you stopped yourself with Esc or Ctrl+C. Settings → Claude Code → **Go on with the work Claude was doing when ClaudeTerm closed** is on by default.
- **Continue a response a dropped connection cut off.** With Settings → Claude Code → **Continue a response a dropped connection cut off** on, a response that stopped arriving mid-stream is continued by itself: a few seconds later ClaudeTerm types Claude Code's own "resume where it stops" nudge into the tab instead of calling you. Up to 3 times in a row, and never over text of yours in Claude Code's prompt. Off by default.
- **Mark as unread.** Right-click a tab → **Mark as unread** gives it the pulse of a tab Claude waits in, until you open it. A Claude tab you leave with a reply not read to its end (scrolled up, or Claude Code's "N new messages") or with an unsent prompt now pulses the same way; Settings → Notifications → **Highlight a Claude tab you leave with a reply not read to its end or an unsent prompt** turns that off.
- **A sound for the tab in front, too.** Each case in Settings → Notifications has a new **Even in front** switch: its sound also plays while the tab is in front of you, for when your eyes are on another screen.
- **One signal while Claude waits on background work.** Claude often ends a turn while agents or commands it started still run, and starts another one when each of them ends. Clear Settings → Notifications → **Signal a finished answer also while background work Claude started (agents, shell commands, monitors) still runs** to be signalled only for the turn after which nothing runs in the background. A command that never ends, such as a dev server, then keeps every turn silent.
- **Choose how often Claude tabs refresh the status bar.** Settings → Claude Code → **Refresh every** (5 seconds, as before, up to 300), or clear **Refresh the status bar of new tabs on a timer** to stop the timer. Each refresh starts a few short processes per Claude tab, which could pile up on a machine short of memory.

### Changes

- **Recent sessions groups the conversations by project.** Each project folder is one line with how many conversations it has and when the latest one was; a click, or Enter on it, unfolds it. The project you worked in last opens unfolded, so Enter right away still resumes your latest conversation. Starred conversations stay on top, and a search shows every match.

### Fixes

- **A turn that ends in an API error tells you.** A connection lost mid-response, a stream that stopped arriving or a rate limit ended Claude's turn without a sign: no tab highlight, sound or taskbar flash. It now gives the signals of a finished answer.

## 0.9.0

### New

- **A default folder for new tabs.** Settings → Shells → **Default folder** (`defaultFolder` in settings.json) names the folder new tabs open in: the first tab at start, and every new shell tab from Ctrl+Shift+T (⌘T on macOS), the **+** button or a profile in the ▾ menu. A Claude tab still opens in the folder of the tab you open it from, and in the default folder when there is no such tab. Left empty, tabs open in your home folder as before. If the folder no longer exists, the tab opens in your home folder and says "Folder not found".

### Fixes

- **Claude tabs report to ClaudeTerm where a policy blocks batch files.** On Windows machines where AppLocker allows scripts only from Program Files and Windows, as on many company machines, every hook of a Claude tab was refused with "This program is blocked by group policy". There was no tab highlight, sound or taskbar flash when Claude finished or asked something, no status bar, no **Last turn** / **Session** in the Changes panel and no session restore. The hooks now start without a batch file. On Windows this needs Claude Code 2.1.139 or later.
- **Ctrl+V pastes an image into Claude where PowerShell is locked down.** On Windows machines whose policy keeps PowerShell in Constrained Language mode, Claude Code cannot read an image from the clipboard, and pasting one did nothing. ClaudeTerm now notices this at the first image paste and hands Claude the image as a PNG file instead, which Claude shows as `[Image #1]` as usual.
- **Git Bash no longer breaks for good while Claude tabs run.** On Windows, Git Bash could get stuck: every `bash`, git hook, ssh and HTTPS pull or push waited 15 seconds and failed with `add_item (...) failed, errno 1`, until every Git Bash process was ended or Windows restarted. Claude tabs run Git Bash every few seconds for their status line, which made this likely and kept it from clearing. Once a Claude tab has started, ClaudeTerm now keeps one hidden, idle `sleep.exe` from your Git install running until it quits, and Git Bash no longer gets stuck. A Git for Windows installer run while ClaudeTerm is open may list it as a program to close.

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
