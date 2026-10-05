# Auto-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installed ClaudeTerm downloads new versions from GitHub Releases in the background and, on one click, restarts into the new version with the same tabs and Claude conversations.

**Architecture:** A pure `Updater` (src/main/updater.ts) owns scheduling, the in-flight guard, user messages and the ready state, around an injected backend; `index.ts` builds the backend from electron-updater only in packaged, non-test builds. A restart marker file (src/main/update-marker.ts) makes the next start run the existing session restore by itself. The renderer shows a banner (src/renderer/update-banner.ts) and a version line in the ▾ menu.

**Tech Stack:** Electron 44, electron-updater 6.8.x (GitHub provider; generic provider for local testing), electron-builder 26 (already writes `latest.yml` and `app-update.yml`), TypeScript, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-10-05-auto-update-design.md

## Global Constraints

- First background check 15 s after start, then every 4 h; background checks only when `settings.autoUpdate` is true (default true).
- Updates only in packaged, non-test builds (`app.isPackaged && !isTest`); otherwise a manual check says `Обновления работают только в установленной версии`.
- UI strings (Russian, exactly): banner `Доступна новая версия ClaudeTerm <v>.`, button `Перезапустить`, close `×` titled `Скрыть`; menu line `ClaudeTerm <current> — проверить обновления`; toasts `Установлена последняя версия (<current>)`, `Загружается ClaudeTerm <v>…`, `Не удалось проверить обновления: <reason>`, `ClaudeTerm <v> уже загружена — нажмите «Перезапустить»`.
- Background check errors are logged only, never shown.
- Restart marker `update-restart.json` (`{ "at": <ms> }`) in the data dir; honoured only if written within the last 10 minutes; always deleted on startup.
- `quitAndInstall(true, true)` (silent, run after). A feed overridden by `CLAUDETERM_UPDATE_URL` (generic provider, for testing) never installs on quit.
- Every release uploads `latest.yml` and the installer's `.blockmap` next to the installer.
- Do not commit until the task's tests pass; commit messages end with the attribution lines from the session.

## Review Focus

1. Several Claude tabs open when the user clicks «Перезапустить» → all of them come back and resume their conversations without a click (Task 2 e2e).
2. The user clicks the menu check repeatedly, or while a background check runs → one check, no duplicate toasts (Task 1 unit: in-flight guard).
3. The user checks manually after an update is already downloaded → told to restart, no new check (Task 1 unit).
4. Offline at startup or GitHub rate limit → no toast, only a log line (Task 1 unit).
5. The user dismissed the banner for one version and a newer one downloads later → the banner shows again (Task 3 e2e).

---

### Task 1: `Updater` core

**Files:**
- Create: `src/main/updater.ts`
- Modify: `src/shared/types.ts` (add `UpdateState`)
- Test: `tests/unit/updater.test.ts`

**Interfaces:**
- Produces: `type UpdateState = { status: 'idle' } | { status: 'ready'; version: string }` (shared/types.ts); `interface UpdaterBackend { check(): Promise<string | null>; onDownloaded(cb: (version: string) => void): void; onError(cb: (message: string) => void): void; quitAndInstall(): void }`; `interface UpdaterDeps { backend: UpdaterBackend | null; currentVersion: string; enabled(): boolean; publish(state: UpdateState): void; notify(message: string): void; beforeInstall(): void; log(message: string): void; setTimer?(fn: () => void, ms: number): unknown; clearTimer?(t: unknown): void }`; `class Updater { constructor(d: UpdaterDeps); readonly current: UpdateState; start(): void; check(manual: boolean): Promise<void>; install(): void; stop(): void }`; constants `FIRST_CHECK_MS = 15_000`, `CHECK_EVERY_MS = 4 * 60 * 60 * 1000`.

- [ ] **Step 1: Write the failing tests** (`tests/unit/updater.test.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { CHECK_EVERY_MS, FIRST_CHECK_MS, Updater, type UpdaterBackend } from '../../src/main/updater'
import type { UpdateState } from '../../src/shared/types'

function fakeBackend() {
  const h: { downloaded?: (v: string) => void; error?: (m: string) => void } = {}
  const b = {
    result: null as string | null,
    fail: null as string | null,
    checks: 0,
    installs: 0,
    pending: null as null | (() => void),
    hold: false,
    check(): Promise<string | null> {
      b.checks++
      if (b.hold) return new Promise((res) => { b.pending = () => res(b.result) })
      return b.fail ? Promise.reject(new Error(b.fail)) : Promise.resolve(b.result)
    },
    onDownloaded: (cb: (v: string) => void) => { h.downloaded = cb },
    onError: (cb: (m: string) => void) => { h.error = cb },
    quitAndInstall: () => { b.installs++ }
  }
  return { b: b as typeof b & UpdaterBackend, h }
}

function setup(o: { backend?: boolean; enabled?: boolean } = {}) {
  const { b, h } = fakeBackend()
  const timers: { fn: () => void; ms: number }[] = []
  const out: string[] = []
  const states: UpdateState[] = []
  const flags = { enabled: o.enabled ?? true }
  const u = new Updater({
    backend: o.backend === false ? null : b,
    currentVersion: '0.1.3',
    enabled: () => flags.enabled,
    publish: (s) => states.push(s),
    notify: (m) => out.push(`toast:${m}`),
    beforeInstall: () => out.push('beforeInstall'),
    log: (m) => out.push(`log:${m}`),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => { timers.length = 0 }
  })
  return { u, b, h, timers, out, states, flags }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Updater', () => {
  it('checks 15 s after start and then every 4 hours, only while enabled', async () => {
    const { u, b, timers, flags } = setup()
    u.start()
    expect(timers.map((t) => t.ms)).toEqual([FIRST_CHECK_MS])
    timers.shift()!.fn()
    await flush()
    expect(b.checks).toBe(1)
    expect(timers.map((t) => t.ms)).toEqual([CHECK_EVERY_MS])
    flags.enabled = false
    timers.shift()!.fn()
    await flush()
    expect(b.checks).toBe(1)
    expect(timers.map((t) => t.ms)).toEqual([CHECK_EVERY_MS])
  })

  it('a manual check reports the result', async () => {
    const { u, b, out } = setup()
    await u.check(true)
    b.result = '0.1.4'
    await u.check(true)
    expect(out).toEqual(['toast:Установлена последняя версия (0.1.3)', 'toast:Загружается ClaudeTerm 0.1.4…'])
  })

  it('background errors are only logged; manual errors are shown', async () => {
    const { u, b, out } = setup()
    b.fail = 'net::ERR_INTERNET_DISCONNECTED'
    await u.check(false)
    await u.check(true)
    expect(out).toEqual(['log:update check failed: net::ERR_INTERNET_DISCONNECTED', 'toast:Не удалось проверить обновления: net::ERR_INTERNET_DISCONNECTED'])
  })

  it('a check while another is running is ignored', async () => {
    const { u, b, out } = setup()
    b.hold = true
    const first = u.check(false)
    await u.check(true)
    b.pending!()
    await first
    expect(b.checks).toBe(1)
    expect(out).toEqual([])
  })

  it('a downloaded update becomes the ready state; a manual check then asks for a restart instead of checking', async () => {
    const { u, b, h, out, states } = setup()
    h.downloaded!('0.1.4')
    expect(states).toEqual([{ status: 'ready', version: '0.1.4' }])
    expect(u.current).toEqual({ status: 'ready', version: '0.1.4' })
    await u.check(true)
    expect(b.checks).toBe(0)
    expect(out).toEqual(['toast:ClaudeTerm 0.1.4 уже загружена — нажмите «Перезапустить»'])
  })

  it('install saves the session before quitting into the installer, and only when ready', () => {
    const { u, b, h, out } = setup()
    u.install()
    expect(b.installs).toBe(0)
    h.downloaded!('0.1.4')
    u.install()
    expect(out).toEqual(['beforeInstall'])
    expect(b.installs).toBe(1)
  })

  it('backend errors (e.g. a failed download) are logged', () => {
    const { h, out } = setup()
    h.error!('sha512 checksum mismatch')
    expect(out).toEqual(['log:update error: sha512 checksum mismatch'])
  })

  it('without a backend: manual check explains, background does nothing, start schedules nothing', async () => {
    const { u, out, timers } = setup({ backend: false })
    u.start()
    await u.check(false)
    await u.check(true)
    expect(timers).toEqual([])
    expect(out).toEqual(['toast:Обновления работают только в установленной версии'])
  })

  it('stop cancels the schedule', () => {
    const { u, timers } = setup()
    u.start()
    u.stop()
    expect(timers).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/updater.test.ts` → FAIL, cannot find module `../../src/main/updater`.

- [ ] **Step 3: Implement**

`src/shared/types.ts` (append):

```ts
export type UpdateState = { status: 'idle' } | { status: 'ready'; version: string }
```

`src/main/updater.ts`:

```ts
import type { UpdateState } from '../shared/types'

export const FIRST_CHECK_MS = 15_000
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

export interface UpdaterBackend {
  /** resolves the newer version that is being downloaded, or null when this build is the latest */
  check(): Promise<string | null>
  onDownloaded(cb: (version: string) => void): void
  onError(cb: (message: string) => void): void
  quitAndInstall(): void
}

export interface UpdaterDeps {
  /** null: this build cannot update itself (dev, test) */
  backend: UpdaterBackend | null
  currentVersion: string
  /** background checks; read on every tick so a settings change applies without a restart */
  enabled(): boolean
  publish(state: UpdateState): void
  notify(message: string): void
  beforeInstall(): void
  log(message: string): void
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(t: unknown): void
}

/** Background update checks, the messages of a manual check, and the restart into a downloaded update. */
export class Updater {
  private state: UpdateState = { status: 'idle' }
  private checking = false
  private timer: unknown = null

  constructor(private readonly d: UpdaterDeps) {
    d.backend?.onDownloaded((version) => {
      this.state = { status: 'ready', version }
      d.publish(this.state)
    })
    d.backend?.onError((m) => d.log(`update error: ${m}`))
  }

  get current(): UpdateState {
    return this.state
  }

  start(): void {
    if (!this.d.backend) return
    this.schedule(FIRST_CHECK_MS)
  }

  async check(manual: boolean): Promise<void> {
    const b = this.d.backend
    if (!b) {
      if (manual) this.d.notify('Обновления работают только в установленной версии')
      return
    }
    if (this.state.status === 'ready') {
      if (manual) this.d.notify(`ClaudeTerm ${this.state.version} уже загружена — нажмите «Перезапустить»`)
      return
    }
    if (this.checking) return
    this.checking = true
    try {
      const version = await b.check()
      if (manual) this.d.notify(version ? `Загружается ClaudeTerm ${version}…` : `Установлена последняя версия (${this.d.currentVersion})`)
      else if (version) this.d.log(`update ${version} found, downloading`)
    } catch (e) {
      const m = (e as Error).message
      if (manual) this.d.notify(`Не удалось проверить обновления: ${m}`)
      else this.d.log(`update check failed: ${m}`)
    } finally {
      this.checking = false
    }
  }

  install(): void {
    if (this.state.status !== 'ready' || !this.d.backend) return
    this.d.beforeInstall()
    this.d.backend.quitAndInstall()
  }

  stop(): void {
    if (this.timer !== null) (this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    const set = this.d.setTimer ?? ((fn, delay) => setTimeout(fn, delay))
    this.timer = set(() => {
      if (this.d.enabled()) void this.check(false)
      this.schedule(CHECK_EVERY_MS)
    }, ms)
  }
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/unit/updater.test.ts` → PASS (9 tests). `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/main/updater.ts src/shared/types.ts tests/unit/updater.test.ts` and commit `feat: Updater — background update checks, manual check messages and restart into a downloaded update`.

### Task 2: Restart marker and main-process wiring

**Files:**
- Create: `src/main/update-marker.ts`
- Modify: `package.json` (dependency `electron-updater`), `src/main/settings.ts`, `src/shared/types.ts` (`Settings.autoUpdate`), `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`
- Test: `tests/unit/update-marker.test.ts`, `tests/unit/settings.test.ts`, `tests/e2e/update.spec.ts`

**Interfaces:**
- Consumes: `Updater`, `UpdaterBackend`, `UpdateState` (Task 1).
- Produces: `UPDATE_MARKER = 'update-restart.json'`, `MARKER_MAX_AGE_MS = 10 * 60 * 1000`, `writeUpdateMarker(dir: string, now: number): boolean`, `consumeUpdateMarker(dir: string, now: number): boolean`; IPC `updateCheck: 'update:check'`, `updateInstall: 'update:install'`, `updateGet: 'update:get'`, `evUpdate: 'ev:update'`; `CtApi.checkForUpdates(): void`, `CtApi.installUpdate(): void`, `CtApi.getUpdateState(): Promise<UpdateState>`, `CtApi.onUpdate(cb: (s: UpdateState) => void): Unsubscribe`; `AppInfo.version: string`; `Settings.autoUpdate: boolean`.

- [ ] **Step 1: Failing unit tests**

`tests/unit/update-marker.test.ts`:

```ts
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { consumeUpdateMarker, MARKER_MAX_AGE_MS, UPDATE_MARKER, writeUpdateMarker } from '../../src/main/update-marker'

const dir = () => mkdtempSync(join(tmpdir(), 'ct-marker-'))

describe('update marker', () => {
  it('a fresh marker restores once and is deleted', () => {
    const d = dir()
    expect(writeUpdateMarker(d, 1000)).toBe(true)
    expect(consumeUpdateMarker(d, 1000 + 60_000)).toBe(true)
    expect(existsSync(join(d, UPDATE_MARKER))).toBe(false)
    expect(consumeUpdateMarker(d, 1000 + 60_000)).toBe(false)
  })

  it('a stale marker is ignored and deleted', () => {
    const d = dir()
    writeUpdateMarker(d, 1000)
    expect(consumeUpdateMarker(d, 1000 + MARKER_MAX_AGE_MS + 1)).toBe(false)
    expect(existsSync(join(d, UPDATE_MARKER))).toBe(false)
  })

  it('no marker, a broken one, or one from the future means no restore', () => {
    const d = dir()
    expect(consumeUpdateMarker(d, 1000)).toBe(false)
    writeFileSync(join(d, UPDATE_MARKER), '{not json')
    expect(consumeUpdateMarker(d, 1000)).toBe(false)
    expect(existsSync(join(d, UPDATE_MARKER))).toBe(false)
    writeUpdateMarker(d, 5000)
    expect(consumeUpdateMarker(d, 1000)).toBe(false)
  })

  it('writing into a missing folder fails softly', () => {
    expect(writeUpdateMarker(join(dir(), 'missing', 'deeper'), 1000)).toBe(false)
  })
})
```

Add to `tests/unit/settings.test.ts` (before `it('normalizes profiles without args'`):

```ts
  it('autoUpdate: on by default, false turns it off, other values fall back', () => {
    expect(DEFAULT_SETTINGS.autoUpdate).toBe(true)
    expect(parseSettings(JSON.stringify({ autoUpdate: false })).settings.autoUpdate).toBe(false)
    const r = parseSettings(JSON.stringify({ autoUpdate: 'no' }))
    expect(r.settings.autoUpdate).toBe(true)
    expect(r.errors.join('\n')).toContain('"autoUpdate"')
  })
```

- [ ] **Step 2: Run** — `npx vitest run tests/unit/update-marker.test.ts tests/unit/settings.test.ts` → FAIL (module missing; `autoUpdate` undefined).

- [ ] **Step 3: Implement marker and setting**

`src/main/update-marker.ts`:

```ts
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Written right before restarting into an update, so the next start reopens the tabs by itself. */
export const UPDATE_MARKER = 'update-restart.json'
export const MARKER_MAX_AGE_MS = 10 * 60 * 1000

export function writeUpdateMarker(dir: string, now: number): boolean {
  try {
    writeFileSync(join(dir, UPDATE_MARKER), JSON.stringify({ at: now }))
    return true
  } catch {
    return false
  }
}

/** True when the previous run restarted into an update a moment ago. The marker is removed either way. */
export function consumeUpdateMarker(dir: string, now: number): boolean {
  const path = join(dir, UPDATE_MARKER)
  let at: unknown = null
  try {
    at = (JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown }).at
  } catch {
    // no marker, or an unreadable one
  }
  try {
    rmSync(path, { force: true })
  } catch {
    // a marker we cannot delete is ignored next time by its age
  }
  return typeof at === 'number' && now >= at && now - at <= MARKER_MAX_AGE_MS
}
```

`src/shared/types.ts` — in `Settings` add `autoUpdate: boolean` (after `attention`).
`src/main/settings.ts` — default `autoUpdate: true` (after `attention`), parse `autoUpdate: take('autoUpdate', raw.autoUpdate, isBool, d.autoUpdate)` (after the `attention` block).

- [ ] **Step 4: Run** — same command → PASS.

- [ ] **Step 5: Dependency, IPC and preload**

Run `npm install electron-updater@^6.8.9` (adds it to `dependencies`, so electron-builder packs it and electron-vite keeps it external).

`src/shared/ipc.ts`: add to `IPC` `updateCheck: 'update:check'`, `updateInstall: 'update:install'`, `updateGet: 'update:get'`, `evUpdate: 'ev:update'`; add `version: string` to `AppInfo`; add to `CtApi`:

```ts
  checkForUpdates(): void
  installUpdate(): void
  getUpdateState(): Promise<UpdateState>
  onUpdate(cb: (state: UpdateState) => void): Unsubscribe
```

(import `UpdateState` from `./types`).

`src/preload/index.ts`: add `checkForUpdates: () => ipcRenderer.send(IPC.updateCheck)`, `installUpdate: () => ipcRenderer.send(IPC.updateInstall)`, `getUpdateState: () => ipcRenderer.invoke(IPC.updateGet)`, `onUpdate: (cb) => on(IPC.evUpdate, cb)`.

- [ ] **Step 6: Failing e2e for the restart** (`tests/e2e/update.spec.ts`)

```ts
import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'

test('after restarting into an update the tabs come back without asking', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    tabs: [
      { kind: 'claude', profile: 'Windows PowerShell', cwd: work, title: 'one', claudeSessionId: SID },
      { kind: 'claude', profile: 'Windows PowerShell', cwd: work, title: 'two', claudeSessionId: SID2 }
    ]
  }))
  writeFileSync(join(dataDir, 'update-restart.json'), JSON.stringify({ at: Date.now() }))
  const { app, page } = await launchApp({ dataDir })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const [a, b] = await page.evaluate(() => window.__ct!.tabIds())
  await expect.poll(() => bufferText(page, a), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  await expect.poll(() => bufferText(page, b), { timeout: 15_000 }).toContain(`--resume ${SID2}`)
  expect(await page.evaluate(() => window.__ct!.restoreVisible!())).toBe(false)
  expect(existsSync(join(dataDir, 'update-restart.json'))).toBe(false)
  await app.close()
})
```

Run `npm run build && npx playwright test tests/e2e/update.spec.ts` → FAIL (one auto tab, restore banner visible).

- [ ] **Step 7: Wire `index.ts`**

Imports: `import { autoUpdater } from 'electron-updater'`, `import { Updater, type UpdaterBackend } from './updater'`, `import { consumeUpdateMarker, writeUpdateMarker } from './update-marker'`.

Right after `let previous = sessions.rotateOnStartup()`:

```ts
  // the previous run restarted into an update: reopen its tabs without asking
  const restoreAfterUpdate = consumeUpdateMarker(dataDir, Date.now())
```

Before `startPipeServer(`:

```ts
  const createUpdateBackend = (): UpdaterBackend => {
    const testFeed = process.env.CLAUDETERM_UPDATE_URL
    if (testFeed) autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })
    autoUpdater.autoDownload = true
    // a test feed must never install over the real installation when the app quits
    autoUpdater.autoInstallOnAppQuit = !testFeed
    autoUpdater.logger = { info: (m: unknown) => log.info(`updater: ${String(m)}`), warn: (m: unknown) => log.warn(`updater: ${String(m)}`), error: (m: unknown) => log.error(`updater: ${String(m)}`), debug: () => {} }
    return {
      check: async () => {
        const r = await autoUpdater.checkForUpdates()
        return r?.isUpdateAvailable ? r.updateInfo.version : null
      },
      onDownloaded: (cb) => { autoUpdater.on('update-downloaded', (info) => cb(info.version)) },
      onError: (cb) => { autoUpdater.on('error', (e) => cb(e.message)) },
      quitAndInstall: () => autoUpdater.quitAndInstall(true, true)
    }
  }
  const updater = new Updater({
    backend: app.isPackaged && !isTest ? createUpdateBackend() : null,
    currentVersion: app.getVersion(),
    enabled: () => settings.autoUpdate,
    publish: (s) => send(IPC.evUpdate, s),
    notify: (m) => { if (rendererReady) send(IPC.evToast, m) },
    beforeInstall: () => {
      sessions.flush()
      if (!writeUpdateMarker(dataDir, Date.now())) log.warn('cannot write the update restart marker')
    },
    log: (m) => log.info(m)
  })
  updater.start()
```

In the `IPC.rendererReady` handler, after the `pendingLaunches` loop: `if (restoreAfterUpdate) runRestore()`.

Next to the other handlers:

```ts
  ipcMain.on(IPC.updateCheck, () => { void updater.check(true) })
  ipcMain.on(IPC.updateInstall, () => updater.install())
  ipcMain.handle(IPC.updateGet, () => updater.current)
```

`IPC.appInfo` handler: add `version: app.getVersion()`. In `before-quit`, before `sessions.flush()`: `updater.stop()`.

If `r.isUpdateAvailable` does not exist in the installed electron-updater typings, use `r && r.updateInfo.version !== app.getVersion() ? r.updateInfo.version : null` and note it.

- [ ] **Step 8: Run** — `npm run typecheck`, `npm test`, `npm run build && npx playwright test tests/e2e/update.spec.ts tests/e2e/restore.spec.ts` → all PASS.

- [ ] **Step 9: Commit** — package.json, package-lock.json, the source files and tests: `feat: download updates from GitHub Releases and reopen the tabs after restarting into one`.

### Task 3: Update banner and the menu line

**Files:**
- Create: `src/renderer/update-banner.ts`
- Modify: `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/main.ts`
- Test: `tests/e2e/update.spec.ts`

**Interfaces:**
- Consumes: `CtApi.checkForUpdates/installUpdate/getUpdateState/onUpdate`, `AppInfo.version`, `UpdateState` (Task 2).
- Produces: `class UpdateBanner { constructor(root: HTMLElement, onInstall: () => void); update(state: UpdateState): void }`; element `#update-banner.banner` with `.banner-restart` and `.banner-close` buttons.

- [ ] **Step 1: Failing e2e** — append to `tests/e2e/update.spec.ts`:

```ts
const ready = (version: string) => ({ status: 'ready', version })

test('a downloaded update shows a banner whose button asks to restart into it', async () => {
  const { app, page } = await launchApp()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeAllListeners('update:install')
    ipcMain.on('update:install', () => { (globalThis as Record<string, unknown>).__installAsked = true })
  })
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('ev:update', s), ready('9.9.9'))
  const banner = page.locator('#update-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Доступна новая версия ClaudeTerm 9.9.9.')
  await banner.locator('.banner-restart').click()
  await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__installAsked === true)).toBe(true)
  await app.close()
})

test('a dismissed banner stays hidden for that version but returns for a newer one', async () => {
  const { app, page } = await launchApp()
  const push = (v: string) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('ev:update', s), ready(v))
  await push('9.9.9')
  const banner = page.locator('#update-banner')
  await banner.locator('.banner-close').click()
  await expect(banner).toBeHidden()
  await push('9.9.9')
  await page.waitForTimeout(200)
  await expect(banner).toBeHidden()
  await push('9.9.10')
  await expect(banner).toContainText('9.9.10')
  await app.close()
})

test('the menu shows the version, and a check in a build that cannot update says so', async () => {
  const { app, page } = await launchApp()
  const version = await app.evaluate(({ app: a }) => a.getVersion())
  await page.locator('.tab-menu').click()
  const item = page.locator('.menu-item', { hasText: `ClaudeTerm ${version} — проверить обновления` })
  await expect(item).toBeVisible()
  await item.click()
  await expect(page.locator('.toast', { hasText: 'Обновления работают только в установленной версии' })).toBeVisible()
  await app.close()
})
```

Run `npm run build && npx playwright test tests/e2e/update.spec.ts` → the three new tests FAIL (no `#update-banner`, no menu line).

- [ ] **Step 2: Implement**

`src/renderer/update-banner.ts`:

```ts
import type { UpdateState } from '../shared/types'

/** "A new version is ready" under the tab bar; × hides it for that version only. */
export class UpdateBanner {
  private dismissed: string | null = null

  constructor(private readonly root: HTMLElement, private readonly onInstall: () => void) {}

  update(state: UpdateState): void {
    if (state.status !== 'ready' || state.version === this.dismissed) {
      this.root.hidden = true
      this.root.replaceChildren()
      return
    }
    const version = state.version
    const text = document.createElement('span')
    text.textContent = `Доступна новая версия ClaudeTerm ${version}.`
    const go = document.createElement('button')
    go.className = 'banner-restart'
    go.textContent = 'Перезапустить'
    go.addEventListener('click', () => this.onInstall())
    const close = document.createElement('button')
    close.className = 'banner-close'
    close.textContent = '×'
    close.title = 'Скрыть'
    close.addEventListener('click', () => {
      this.dismissed = version
      this.update({ status: 'idle' })
    })
    this.root.replaceChildren(text, go, close)
    this.root.hidden = false
  }
}
```

`src/renderer/index.html`: `<div id="banner" hidden></div>` → `<div id="banner" class="banner" hidden></div>` and add `<div id="update-banner" class="banner" hidden></div>` right after it.

`src/renderer/styles.css`: the four `#banner` rules become `.banner` rules (`.banner`, `.banner span`, `.banner button`, `.banner .banner-close`), unchanged otherwise.

`src/renderer/main.ts`: import `UpdateBanner`; module variable `let updateBanner: UpdateBanner`; in boot next to the status bar setup:

```ts
  updateBanner = new UpdateBanner(document.getElementById('update-banner')!, () => ct.installUpdate())
  ct.onUpdate((s) => updateBanner.update(s))
  void ct.getUpdateState().then((s) => updateBanner.update(s))
```

In `newTabMenu`, after the restore item:

```ts
      { label: '', separator: true },
      { label: `ClaudeTerm ${appInfo.version} — проверить обновления`, action: () => ct.checkForUpdates() }
```

- [ ] **Step 3: Run** — `npm run typecheck`; `npm run build && npx playwright test` (whole e2e suite, the restore tests use `#banner` classes) → PASS.

- [ ] **Step 4: Commit** — `feat: update banner with a restart button and a version line in the menu`.

### Task 4: Release pipeline, docs and a live check

**Files:**
- Modify: `.github/workflows/release.yml`, `README.md`

- [ ] **Step 1: Release uploads the update feed** — in `release.yml` the publish step becomes:

```yaml
        run: >
          gh release create "$GITHUB_REF_NAME"
          dist/ClaudeTerm-Setup-*.exe dist/ClaudeTerm-Setup-*.exe.blockmap dist/latest.yml
          --title "ClaudeTerm ${GITHUB_REF_NAME#v}"
          --generate-notes
```

- [ ] **Step 2: README** — in "Install", after the SmartScreen note: `ClaudeTerm updates itself from version 0.1.3 on: it downloads a new release in the background and offers to restart into it, reopening your tabs and Claude conversations. Earlier versions need a one-time manual install.` In the settings block add `"autoUpdate": true            // check GitHub for new versions in the background` and in the shortcuts paragraph nothing. Mention in "Good to know": `▾ → ClaudeTerm <version> — проверить обновления checks right away.`

- [ ] **Step 3: Live check against a local feed** (throwaway script in the scratchpad, nothing committed):
  1. `npm run dist -- --config.directories.output=<scratch>/feed-new --config.extraMetadata.version=<next>-test` (a higher version) and `npm run dist -- --config.directories.output=<scratch>/app-old` (current version).
  2. Serve `<scratch>/feed-new` (`latest.yml`, the installer, the blockmap) with a small Node `http` static server on 127.0.0.1.
  3. Launch `<scratch>/app-old/win-unpacked/ClaudeTerm.exe` through Playwright `_electron.launch({ executablePath })` with `CLAUDETERM_UPDATE_URL=http://127.0.0.1:<port>/`, a temp `CLAUDETERM_DATA_DIR`, a unique `CLAUDETERM_PIPE_NAME` and `CLAUDETERM_SKIP_MCP_REGISTER=1` (not `CLAUDETERM_TEST`).
  4. Use ▾ → check: expect the toast `Загружается ClaudeTerm <next>-test…`, then the banner `Доступна новая версия ClaudeTerm <next>-test.`; the data-dir log shows the download and sha512 check.
  5. Do **not** click «Перезапустить». Kill the process (`app.process().kill()`), then delete `%LOCALAPPDATA%\claudeterm-updater` and the scratch folders.

- [ ] **Step 4: Full verification** — `npm run typecheck`, `npm test`, `npm run build && npx playwright test` → all PASS.

- [ ] **Step 5: Commit** — `.github/workflows/release.yml README.md`: `docs, ci: releases carry the update feed; README covers updates`.
