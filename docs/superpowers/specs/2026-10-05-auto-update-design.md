# Auto-update — design

Date: 2026-10-05. Status: approved by delegation (the user asked for the result and left the spec, plan and process to Claude).

## Goal

Installed ClaudeTerm keeps itself up to date from GitHub Releases. A user never has to visit the releases page again after installing a version that has the updater (0.1.3 or later). Updating must not cost the user their open tabs or Claude conversations.

Users of 0.1.0–0.1.2 have no updater; they install 0.1.3 by hand once.

## What the user sees

1. ClaudeTerm checks for a new version in the background, 15 s after start and then every 4 hours. Nothing is shown while checking or downloading.
2. When a new version has been downloaded, a banner appears under the tab bar:
   `Доступна новая версия ClaudeTerm 0.1.4.  [Перезапустить]  ×`
3. **Перезапустить**: ClaudeTerm saves the session, closes, the installer runs silently, and the new version starts and **reopens the same tabs on its own**: each Claude tab resumes its conversation (`claude --resume`), exactly like the existing session restore, but without the restore banner click.
4. **×** hides the banner. The update is then installed silently the next time the user quits ClaudeTerm; the next start is the new version and offers the usual restore banner.
5. The new-tab menu (▾) ends with a line `ClaudeTerm 0.1.3 — проверить обновления`. A manual check reports its result in a toast:
   - `Установлена последняя версия (0.1.3)`
   - `Загружается ClaudeTerm 0.1.4…` (the banner follows when it is ready)
   - `Не удалось проверить обновления: <reason>`
   - in a build that cannot update (dev, test, portable): `Обновления работают только в установленной версии`
6. Background check errors (offline, GitHub rate limit) are only logged, never shown.
7. Setting `"autoUpdate": false` in settings.json turns background checks off (the manual check still works). Hot-reloaded like other settings.

UI strings are Russian, like the rest of the current UI.

## Components

### `src/main/updater.ts` — `Updater` (pure, unit-tested)

Wraps an injected backend so the logic is testable without electron-updater:

```ts
interface UpdaterBackend {
  check(): Promise<string | null>                  // the newer version being downloaded, or null when up to date
  onDownloaded(cb: (version: string) => void): void
  onError(cb: (message: string) => void): void
  quitAndInstall(): void
}
interface UpdaterDeps {
  backend: UpdaterBackend | null          // null: this build cannot update
  currentVersion: string
  enabled(): boolean                      // settings.autoUpdate, read on every tick
  publish(state: UpdateState): void       // to the renderer
  notify(message: string): void           // toast (manual checks only)
  beforeInstall(): void                   // flush the session and write the restart marker
  log(message: string): void
  setTimer / clearTimer (injected for tests)
}
type UpdateState = { status: 'idle' } | { status: 'ready'; version: string }
```

- `start()`: first check after 15 s, then every 4 h; each tick checks only if `enabled()`.
- `check(manual)`: no backend → manual: notify "only in the installed version"; background: nothing. While a check is in flight, a second one is ignored. Result: manual → toast as above; errors → manual: toast, background: log.
- `onDownloaded(version)` → state `ready` (published to the renderer; the renderer also gets the current state on request at startup so a reload does not lose the banner).
- `install()`: only in `ready`: `beforeInstall()`, then `backend.quitAndInstall()`.
- `stop()` clears the timer (app quit).

### Backend from electron-updater (in `index.ts`)

Created only when `app.isPackaged && !isTest`. `autoUpdater.autoDownload = true`, `autoInstallOnAppQuit = true`, logger → our log. `quitAndInstall(true, true)` (silent, run after). Feed: the `app-update.yml` electron-builder already writes into the package (GitHub provider from `repository`). For testing, `CLAUDETERM_UPDATE_URL` overrides the feed with a generic provider (`autoUpdater.setFeedURL({ provider: 'generic', url })`).

### Restart marker: tabs come back by themselves

`beforeInstall` flushes the session store and writes `update-restart.json` (`{ at }`) into the data dir. On startup, `consumeUpdateMarker(dataDir, now)` deletes the marker and returns true if it was written within the last 10 minutes. When true and there is a previous session, `runRestore()` runs as soon as the renderer is ready, instead of offering the banner. Pure helper in `src/main/update-marker.ts`, unit-tested.

### Renderer

- `src/renderer/update-banner.ts` — `UpdateBanner` on a new `#update-banner` element (same look as the restore banner; the shared styles move from `#banner` to a `.banner` class). Shows on `ready`, hides on ×; the button calls `ct.installUpdate()`.
- The ▾ menu gets the version line (`appInfo.version`) calling `ct.checkForUpdates()`.

### IPC

`update:check` (renderer → main, manual), `update:install` (renderer → main), `update:state` (handle, current state), `ev:update` (main → renderer, state). `AppInfo` gains `version`.

### Settings

`autoUpdate: boolean`, default `true`, validated like the other booleans.

### Release pipeline

`release.yml` uploads `dist/latest.yml` and `dist/ClaudeTerm-Setup-*.exe.blockmap` next to the installer. electron-updater reads `latest.yml` from the latest GitHub release, so every release from now on must carry it. README: "Install" says updates are automatic since 0.1.3; settings block documents `autoUpdate`.

## Error handling

- No network / GitHub down: background → log; manual → toast with the reason.
- A release without `latest.yml` (should not happen after the workflow change): same as an error.
- Download corrupted: electron-updater verifies sha512 from `latest.yml` and reports an error; nothing is installed.
- The installer is not code-signed; electron-updater skips signature verification when `publisherName` is not configured, so unsigned updates install.
- Quit during download: the partial download is discarded by electron-updater; the next check restarts it.

## Testing

- Unit: `Updater` (schedule, enabled flag, in-flight guard, manual vs background messages, ready state, install order: beforeInstall before quitAndInstall, no backend); `consumeUpdateMarker` (fresh, stale, missing, unreadable); settings `autoUpdate`.
- e2e: the banner appears on an `ev:update` ready state and its button sends `update:install`; × hides it; the ▾ menu shows the version line and a manual check in a test build shows the "only in the installed version" toast; a marker plus a previous session restores tabs without the banner.
- Live: a packaged build with `CLAUDETERM_UPDATE_URL` pointing at a local HTTP server that serves `latest.yml` and the installer of a higher version → the banner appears (check + download + sha512 verified). The final install step is standard electron-builder NSIS and is not run locally, because it would replace the user's real installation; it gets verified on the next real release (0.1.3 → 0.1.4).

## Out of scope

Release notes in the banner, download progress, beta channels, code signing, a settings UI.
