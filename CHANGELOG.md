# Changelog

What changed in each ClaudeTerm release. The GitHub release of a version shows its section from this file.

## Next

### New

- **ClaudeTerm runs on Linux.** Download `ClaudeTerm-<version>.deb` from the release and install it with `sudo apt install ./ClaudeTerm-<version>.deb` (x64; Ubuntu 22.04 or later, Debian 12 or later, and their derivatives). Shell tabs open your login shell, bash, zsh or fish; Claude tabs, the status bar, notifications, the image panel, session restore and updates work as on Windows. Installing an update asks for your password. To paste images into Claude, install `xclip` (X11) or `wl-clipboard` (Wayland).

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
