# Settings window — design

Date: 2026-10-06. Status: approved in chat in three parts; the user delegated the spec, plan, review and release, commits included ("ок").

## Goal

Change ClaudeTerm's everyday settings without editing JSON, and choose for each case that needs the user — Claude asks for permission, asks a question, finishes its answer, a program rings the terminal bell — which signals it gives: a sound, a taskbar flash, a tab highlight. Settings stay per Windows user in `%APPDATA%\ClaudeTerm\settings.json`; the window edits that file and every change applies at once.

## What the user sees

### Opening and closing

- **Ctrl+,** or the ▾ menu item **Settings…** (just above the `ClaudeTerm <version> — check for updates` line) opens the settings window. When it is already open, it is brought to the front; there is never a second one.
- A separate Windows window titled `ClaudeTerm Settings`, owned by the main window: it stays above it and closes with it. The terminal keeps working while it is open. It opens centred on the main window (moved inside the screen's work area when that would put it off screen), 640×720 by default, resizable down to 520×400, scrolls when its content does not fit, no menu bar, dark like the rest of the app, English.
- **Esc** or the window's close button closes it.

### Content

```
 NOTIFICATIONS   when a tab you are not looking at needs you
                              Sound   Taskbar flash   Tab highlight
   Claude asks for permission  [x]        [x]             [x]
   Claude asks a question      [x]        [x]             [x]
   Claude finished its answer  [x]        [x]             [x]
   Terminal bell (BEL)         [ ]        [x]             [x]
   Sound  (•) Windows default  ( ) Custom .wav [C:\…\ding.wav] [Browse…]  [▶ Play]

 APPEARANCE
   Font        [Cascadia Mono, Consolas, monospace]   Size [12]
   Theme       [Campbell ▾]          Scrollback lines [10000]

 SHELLS
   Default shell            [Automatic ▾]   (PowerShell 7 if installed, else Windows PowerShell)

 CLAUDE CODE                                   applies to new tabs
   Command                  [claude]
   Shell for Claude tabs    [Automatic ▾]

 IMAGES                                        applies to new tabs
   [x] Watch Claude tab folders for new images
   [x] Open the image panel when a new image arrives

 UPDATES
   [x] Check for updates automatically

 Profiles, image types, ignored folders, a custom theme and the
 image panel size are set in settings.json        [Open settings.json]
```

Controls and the settings they edit:

| Control | Setting | Values |
|---|---|---|
| Notification table cell | `notifications.<case>.<channel>` | checkbox; cases `permission`, `question`, `done`, `bell`; channels `sound`, `flash`, `tab` |
| Sound | `notifications.sound` | `Windows default` = `"system"`; `Custom .wav` = an absolute path ending in `.wav` |
| Font | `font.family` | non-empty text |
| Size | `font.size` | number 6–72 |
| Theme | `theme` | `Campbell`, `One Half Dark`, `One Half Light` |
| Scrollback lines | `scrollback` | whole number 0–1,000,000 |
| Default shell | `defaultProfile` | `Automatic` = `null`, or a profile name |
| Command | `claude.command` | non-empty text |
| Shell for Claude tabs | `claude.shellProfile` | `Automatic` = `null`, or a profile name |
| Watch Claude tab folders… | `imageWatch.enabled` | checkbox |
| Open the image panel… | `imagePanel.autoOpen` | checkbox |
| Check for updates automatically | `autoUpdate` | checkbox |

The profile lists hold `Automatic` and the names of the available profiles (detected ones plus `profiles` from the file), in the ▾ menu's order.

### Saving

There is no Save button: every change is written to `settings.json` and applied at once.
- Checkboxes, radio buttons and lists save on change.
- Text and number fields save when they lose focus or on Enter.
- A value that fails its check (empty font or command, a size outside 6–72, scrollback outside 0–1,000,000 or not a whole number) is not saved: the field gets a red border and a line under it says what is allowed (`Between 6 and 72`, `A whole number between 0 and 1000000`, `Cannot be empty`). The message goes away once the field holds a valid value again.
- When saving fails (the file is locked, read-only, or became unreadable), the field shows the error the same way and the file is not touched.

**What applies when.** Notifications, font, size, theme and automatic updates apply at once. Shells, the Claude Code command, the image options and scrollback apply to tabs opened afterwards; the Claude Code and Images sections say `applies to new tabs`, and so does a note under Scrollback lines.

**Sound.** Choosing `Windows default` saves `"system"`. Choosing `Custom .wav` while the sound is `Windows default`, or pressing **Browse…** (always enabled), opens a file dialog filtered to `.wav`; a chosen file is saved as the sound, cancelling leaves the sound as it was (the radio buttons go back to it). The path field is read-only and shows the custom file, empty for `Windows default`. **Play** plays the sound now in use.

### Unusual file contents

- **A custom theme object** in the file: the Theme list shows an extra item `Custom (settings.json)`, selected. Choosing a built-in theme replaces the object.
- **A theme or profile name the app does not know** (`"theme": "Dracula"`, a profile that is no longer installed): the list shows it as an extra item `<name> (not found)`, selected.
- **The file is changed by hand while the window is open:** the window updates every control to the new values, except the one being edited (it keeps what the user is typing).
- **Invalid values in the file** (they fall back to their defaults, as today): a notice at the top of the window lists the messages, e.g. `settings.json: invalid value for "font.size", using default`.
- **The file cannot be read or is not a JSON object:** a banner at the top says `settings.json can't be used: <error>` with an **Open settings.json** button, and every control is disabled until the file is fixed, so the window never overwrites the user's file.
- When the window writes the file, it rewrites it as plain JSON with two-space indentation: keys the window does not know and the order of keys are kept, the user's own formatting is not.

## Notifications

### The rules

For every case the same rules hold:

1. The user is looking at that tab (the main window is focused and the tab is active): nothing happens — as today.
2. Otherwise, only the channels switched on for that case act:
   - **Sound** plays the chosen sound;
   - **Taskbar flash** flashes the taskbar button when the main window is not focused;
   - **Tab highlight** marks the tab when it is not the active one: the pulse for the Claude cases, the dot for the bell — as today.
3. A tab makes at most one sound per 2 seconds (a question right before a permission prompt makes one sound). The 2-second limit applies to the sound only: flashing and marking repeat harmlessly. A case whose sound is off does not take the tab's 2-second slot, so a question with its sound off cannot silence the permission prompt that follows it.
4. The terminal bell goes through the same rules in the main process. New for it: an optional sound, and its sound obeys the same per-tab 2-second limit, so a program that rings continuously does not ring continuously.

When the settings window has the focus, the main window does not, so signals for the active tab act as for an unfocused window.

### settings.json

`notifications` replaces `attention`:

```jsonc
"notifications": {
  "sound": "system",          // "system" or the full path to a .wav file
  "permission": { "sound": true,  "flash": true, "tab": true },
  "question":   { "sound": true,  "flash": true, "tab": true },
  "done":       { "sound": true,  "flash": true, "tab": true },
  "bell":       { "sound": false, "flash": true, "tab": true }
}
```

- The defaults are today's behaviour.
- Each field is checked on its own; an invalid one falls back to its default with the usual `settings.json: invalid value for "notifications.done.sound", using default` notice. `notifications.sound` accepts `"system"` or an absolute path ending in `.wav` (any case); `"none"` is not accepted there (the per-case checkboxes turn sound off).
- **Migration.** `attention` is read only when the file has no `notifications` key:
  - `attention.sound: "none"` → `sound: false` for `permission`, `question`, `done`; the sound file stays `"system"`;
  - `attention.sound: "<path>.wav"` → `notifications.sound` is that path;
  - `attention.flash: false` → `flash: false` for `permission`, `question`, `done`; the bell keeps flashing, as it does today regardless of this flag;
  - invalid `attention` values fall back with a notice naming `attention.sound` / `attention.flash`, as today.
  When the file has `notifications`, `attention` is ignored.
- The first change made in the window to any `notifications.*` setting writes the whole `notifications` object (built from the current values) and removes `attention`, so there is one source of truth. A file nobody touches keeps working as it is.
- New installs get `notifications` in the generated file.

## Architecture

### Components

- `src/shared/settings-keys.ts` (new) — the vocabulary both processes share:
  - `NOTIFICATION_CASES = ['permission', 'question', 'done', 'bell']`, `NOTIFICATION_CHANNELS = ['sound', 'flash', 'tab']`;
  - `NUMBER_LIMITS` for `font.size` (6–72) and `scrollback` (0–1,000,000); the parser and the form both use the ranges, and the form also requires a whole number for scrollback (the parser keeps accepting a fractional one, as today);
  - `SETTING_KEYS` — the keys the window may edit (the table above, all 12 notification cells and `notifications.sound` included), `SettingKey`, `SettingValue = string | number | boolean | null`, `isSettingKey(v)`, `isSettingValue(v)`.
- `src/shared/types.ts` — `NotificationCase`, `NotificationChannels { sound; flash; tab }`, `NotificationSettings { sound: string } & Record<NotificationCase, NotificationChannels>`; `Settings.notifications` replaces `Settings.attention`.
- `src/main/settings.ts`
  - `parseSettings` reads `notifications` with the migration above; `ParsedSettings` gains `broken?: true` when the text is not a JSON object (invalid JSON, or a root that is not an object). Behaviour of the hot reload for a broken file does not change (defaults with a toast, as today).
  - `applySettingEdit(text: string | null, key: SettingKey, value: SettingValue): { ok: true; text: string } | { ok: false; error: string }` — pure. Strips a BOM; `null` text means an empty object. Refuses a text that is not a JSON object (`settings.json can't be used: <reason>`). For a `notifications.*` key, when the file has no `notifications`, first writes the current effective `notifications` (from `parseSettings`) into it; for any `notifications.*` key it removes `attention`. Sets the value at the dotted path, creating objects (and replacing non-object values) on the way. Parses the result: when an error names the key (`"<key>"`), refuses with `Invalid value for <key>`; errors about other keys don't block. Returns `JSON.stringify(raw, null, 2) + '\n'`.
- `src/main/attention.ts` — `notify(tabId, reason: NotificationCase): boolean` with the rules above; `AttentionDeps.settings()` returns `NotificationSettings`; `markTab(tabId, reason)`. Returns true when any channel acted.
- `src/main/settings-window.ts` (new) — `SettingsWindow`: `open()` creates the window or brings the open one forward. It takes the parent window, the preload path and how to load the page; it computes the bounds from the parent's bounds and the display work area through a pure `settingsWindowBounds(parent, workArea)`. The window: `parent` = main window, `minimizable: false`, `maximizable: false`, `backgroundColor` = the chrome colour, `setMenu(null)`, same `webPreferences` as the main window, external links and navigation blocked like the main window.
- `src/main/index.ts`
  - The settings reload (today inside the watcher) becomes `reloadSettings()`: load, apply, toast notices, send `ev:settings` to the main window and `ev:settings-view` to every window — the view goes out on every reload, also when the file is broken.
  - A reload toasts only the notices (invalid values, missing profiles) that the previous load did not have, so saving from the window does not repeat a notice about some other value on every change.
  - IPC handlers listed below. `settings:set` reads the file, calls `applySettingEdit`, writes the file, calls `reloadSettings()` and returns; the watcher's reload of the same file afterwards changes nothing. Edits run one at a time because the handler is synchronous.
  - The terminal bell goes through `attention.notify(tabId, 'bell')`.
- `electron.vite.config.ts` — two renderer inputs: `index.html` and `settings.html`.
- `src/renderer/settings.html`, `src/renderer/settings-page.ts` (new) — the window: builds the controls, renders a `SettingsView`, saves on change, shows field errors, the notice and the broken-file banner, closes on Esc.
- `src/renderer/settings-form.ts` (new) — pure helpers the page uses: `checkNumber(key, text)`, `checkText(text)`, `themeOptions(theme)`, `profileOptions(names, current)`, `soundChoice(sound)`.
- `src/renderer/colors.css` (new) — the `:root` colour variables, imported by `styles.css` and the new `settings.css`.
- `src/renderer/main.ts` — `openSettings` opens the window; the ▾ menu item; the bell asks the main process; `onAttention(tabId, reason)` sets the dot for `bell` and the pulse otherwise. Applying new settings resets the Ctrl+= zoom only when the font itself changed, and touches the theme only when it changed (today every reload resets the zoom, which a notification checkbox would now trigger).
- README — the Settings section, the notifications paragraph, the JSON block, a screenshot of the window.

### IPC

| Channel | Kind | Payload → result |
|---|---|---|
| `settings:open-window` | send | — (Ctrl+, and the menu item) |
| `settings:view` | invoke | → `SettingsView { settings, profiles: string[], path, problems: string[], locked: boolean }` |
| `settings:set` | invoke | `(key, value)` → `{ ok: true } \| { ok: false, error }` |
| `settings:pick-sound` | invoke | → a `.wav` path or `null`; saves nothing |
| `settings:play-sound` | send | plays `notifications.sound` |
| `ev:settings-view` | event to every window | `SettingsView` after every reload |
| `app:bell` | send | now `(tabId)` |
| `ev:attention` | event to the main window | now `(tabId, reason: NotificationCase)` |

`problems` are the parse errors of the last load; `locked` is true when the last load failed to read the file or found it `broken`. `settings:set` and `settings:pick-sound` check their arguments (`isSettingKey`, `isSettingValue`) like the other handlers. In test runs (`CLAUDETERM_TEST=1`) `settings:pick-sound` returns `CLAUDETERM_TEST_PICK_SOUND` instead of showing the dialog, when that variable is set.

## Out of scope

Editing profiles, image extensions or ignored folders, a custom theme or the image panel size in the window; Windows toast notifications; per-case sound files; remembering the window's position; settings shared between users or machines.

## Testing

- Unit:
  - `parseSettings`: `notifications` defaults; each field falls back on its own with a notice naming it; `notifications.sound` accepts `"system"` and an absolute `.wav`, refuses `"none"`, relative paths and other files; migration from `attention` (`"none"`, a `.wav`, `flash: false`, invalid values); `notifications` wins over `attention`; `broken` for invalid JSON and a non-object root.
  - `applySettingEdit`: sets a nested key and keeps unknown keys and key order; creates a missing object; refuses an invalid value naming the key; refuses broken JSON and a non-object root; accepts a file with another invalid value; writes `notifications` from `attention` and drops `attention` on a notifications edit; leaves `attention` alone on other edits; strips a BOM; `null` text.
  - `Attention`: nothing while looking; each channel per case; flash only when unfocused, mark only when not active; the 2-second limit only on the sound, per tab; a case with its sound off does not take the slot; the bell case; `removeTab`.
  - `settingsWindowBounds`: centred on the parent, kept inside the work area.
  - `settings-form` helpers; `isSettingKey`/`isSettingValue`.
- E2E (a second Playwright page for the window):
  - Ctrl+, opens the window, a second Ctrl+, opens no second window; the ▾ menu item opens it; Esc closes it.
  - Unticking `Claude finished its answer → Tab highlight` writes `notifications.done.tab: false` to the file (and drops a seeded `attention`); then a `done` signal does not mark a background tab while a `permission` signal does.
  - Changing the size changes the terminal's font size at once; choosing a theme changes the terminal's background.
  - An out-of-range size shows the field error and leaves the file unchanged.
  - Editing the file by hand while the window is open updates the control.
  - A broken file shows the banner with disabled controls; fixing it enables them.
  - The custom sound: with `CLAUDETERM_TEST_PICK_SOUND`, Browse saves that path and the field shows it.
  - A terminal bell in a background tab still puts a dot on it (the existing test, now through the main process); with `notifications.bell.tab: false` it does not.
- README screenshot `docs/images/settings.png` of the window with default settings in a temporary data folder — no personal data.
