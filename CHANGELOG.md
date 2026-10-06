# Changelog

What changed in each ClaudeTerm release. The GitHub release of a version shows its section from this file.

## 0.1.7

### Fixes

- **No more lag or freezes caused by watching for images.** When a folder inside a project was deleted and created again (build output, test results, a script that clears its output), ClaudeTerm could keep a CPU core or more busy until it was restarted: the window lagged when dragged, and the app could stop responding.
- **Images stay in the tab that made them.** With several Claude tabs in the same folder, a new image there goes to the tab whose Claude (or one of its subagents) was running a tool when the file was written. If none was, for example when a dev server wrote it, it still shows in all of them.

### Improvements

- Claude tabs in large projects open without a pause: ClaudeTerm no longer scans the whole folder tree first (a big Unreal project took about 13 seconds), and watches it with a single handle.
- A burst of images written at once, such as dozens of screenshots from a test run, now shows up in full.
- Image watching survives the project folder itself being deleted and created again.

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
