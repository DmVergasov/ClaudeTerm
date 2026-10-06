# Settings Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `ClaudeTerm Settings` window (Ctrl+, and the ▾ menu) that edits the everyday settings in `settings.json` and applies them at once, with a sound / taskbar flash / tab highlight choice for each case that needs the user: permission, question, finished answer, terminal bell.

**Architecture:** `settings.json` stays the single source of truth. A new `notifications` section (migrated from `attention`) drives a per-case `Attention`, which now also handles the terminal bell in the main process. The main process edits the file through a pure `applySettingEdit(text, key, value)` that sets one whitelisted key and re-checks it with the same parser, then reloads and broadcasts a `SettingsView`. The window is a second `BrowserWindow` (owned by the main window, one instance) loading a second renderer page, `settings.html`, that renders the view and saves each control on change.

**Tech Stack:** Electron 44 (main/preload/renderer), electron-vite 5 (multi-page renderer), TypeScript, Vitest (unit), Playwright Electron (e2e).

**Spec:** `docs/superpowers/specs/2026-10-06-settings-window-design.md`

## Global Constraints

- UI strings are English, exactly: window title `ClaudeTerm Settings`; menu item `Settings…`; section headings `Notifications`, `Appearance`, `Shells`, `Claude Code`, `Images`, `Updates`; notifications subtitle `when a tab you are not looking at needs you`; rows `Claude asks for permission`, `Claude asks a question`, `Claude finished its answer`, `Terminal bell (BEL)`; columns `Sound`, `Taskbar flash`, `Tab highlight`; `Windows default`, `Custom .wav`, `Browse…`, `▶ Play`; labels `Font`, `Size`, `Theme`, `Scrollback lines`, `Default shell`, `Command`, `Shell for Claude tabs`, `Watch Claude tab folders for new images`, `Open the image panel when a new image arrives`, `Check for updates automatically`; `Automatic`, `(PowerShell 7 if installed, else Windows PowerShell)`, `Custom (settings.json)`, `<name> (not found)`, `applies to new tabs`; footer `Profiles, image types, ignored folders, a custom theme and the image panel size are set in settings.json` with button `Open settings.json`.
- Messages, exactly: `Between 6 and 72`, `A whole number between 0 and 1000000`, `Cannot be empty`, `settings.json can't be used: <reason>`, `Invalid value for <key>`, `Cannot read settings.json: <message>`, `Cannot save settings.json: <message>`.
- `notifications` defaults are today's behaviour: `sound: "system"`; `permission`, `question`, `done` = `{ sound: true, flash: true, tab: true }`; `bell` = `{ sound: false, flash: true, tab: true }`.
- `notifications.sound` accepts `"system"` or an absolute path ending in `.wav` (any case), not `"none"`.
- One sound per tab per 2 seconds (`ATTENTION_REPEAT_MS = 2000`); the limit applies to the sound only.
- Window: 640×720 default, min 520×400, owned by the main window, not minimizable or maximizable, no menu, one instance, Esc closes, centred on the main window inside the work area.
- The window writes `JSON.stringify(raw, null, 2) + '\n'`; unknown keys and key order are kept.
- No new dependencies.
- Commits: the plan's commit steps only; the user delegated them for this feature. If the harness refuses a commit, stop and ask the user.

## Review Focus

1. The view arrives while the user is typing in a text field (another control saved, or the file changed by hand) — the field keeps what is being typed. → Task 4 e2e "a hand edit updates the window but not the field being typed in".
2. Ctrl+= zoom is reset by an unrelated change saved from the window (a notification checkbox) — the zoom stays; only a font change resets it. → Task 2 e2e "zoom survives a change to another setting".
3. A pre-existing invalid value or a missing profile toasts again on every save from the window — each notice toasts once until it goes away and comes back. → Task 2 e2e "a notice is toasted once, not on every save".
4. Several checkboxes clicked quickly — every change reaches the file, none is lost to a read-modify-write race. → Task 4 e2e "quick clicks all reach the file".
5. The settings window is open when the main window is closed — the app still quits promptly. → Task 3 e2e "closing the main window with settings open ends the app".

---

## File Structure

- Create `src/shared/settings-keys.ts` — notification cases/channels, number limits, the editable keys and their guards.
- Modify `src/shared/types.ts` — `NotificationCase`, `NotificationChannels`, `NotificationSettings`; `Settings.notifications` replaces `Settings.attention`.
- Modify `src/main/settings.ts` — `notifications` parsing and migration, `broken` flag, `applySettingEdit`.
- Modify `src/main/attention.ts` — per-case channels, sound-only repeat limit.
- Create `src/main/settings-window.ts` — `settingsWindowBounds`, `SettingsWindow`.
- Modify `src/main/index.ts` — attention wiring, bell through main, `reloadSettings`, settings IPC, the window.
- Modify `src/shared/ipc.ts`, `src/preload/index.ts` — channels, `SettingsView`, `SetSettingResult`, API methods.
- Modify `electron.vite.config.ts` — two renderer pages.
- Create `src/renderer/settings.html`, `src/renderer/settings-page.ts`, `src/renderer/settings-form.ts`, `src/renderer/settings.css`, `src/renderer/colors.css`.
- Modify `src/renderer/styles.css` (colours moved to `colors.css`), `src/renderer/main.ts` (bell, attention reason, applySettings, menu, Ctrl+,), `src/renderer/env.d.ts` (test hook).
- Tests: modify `tests/unit/settings.test.ts`, `tests/unit/attention.test.ts`, `tests/e2e/attention.spec.ts`; create `tests/unit/settings-keys.test.ts`, `tests/unit/settings-window.test.ts`, `tests/unit/settings-form.test.ts`, `tests/e2e/settings.spec.ts`.
- Modify `README.md`, `tests/screenshots/readme.shots.ts`; new image `docs/images/settings.png`.

---

### Task 1: Per-case notifications

**Files:**
- Create: `src/shared/settings-keys.ts`
- Modify: `src/shared/types.ts`, `src/main/settings.ts`, `src/main/attention.ts`, `src/main/index.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/main.ts`
- Test: `tests/unit/settings.test.ts`, `tests/unit/attention.test.ts`, `tests/e2e/attention.spec.ts`

**Interfaces:**
- Produces:
  - `type NotificationCase = 'permission' | 'question' | 'done' | 'bell'`, `interface NotificationChannels { sound: boolean; flash: boolean; tab: boolean }`, `type NotificationSettings = { sound: string } & Record<NotificationCase, NotificationChannels>` in `src/shared/types.ts`; `Settings.notifications: NotificationSettings` (no `attention`).
  - `NOTIFICATION_CASES: readonly NotificationCase[]`, `NOTIFICATION_CHANNELS: readonly (keyof NotificationChannels)[]` in `src/shared/settings-keys.ts`.
  - `Attention.notify(tabId: string, reason: NotificationCase): boolean`; `AttentionDeps.settings(): NotificationSettings`; `AttentionDeps.markTab(tabId: string, reason: NotificationCase): void`.
  - `CtApi.bell(tabId: string): void`; `CtApi.onAttention(cb: (tabId: string, reason: NotificationCase) => void)`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/settings.test.ts` replace the two `attention:` tests with:

```ts
  it('notifications: defaults are the old behaviour, the bell rings no sound', () => {
    expect(DEFAULT_SETTINGS.notifications).toEqual({
      sound: 'system',
      permission: { sound: true, flash: true, tab: true },
      question: { sound: true, flash: true, tab: true },
      done: { sound: true, flash: true, tab: true },
      bell: { sound: false, flash: true, tab: true }
    })
    expect(parseSettings('{}').settings.notifications).toEqual(DEFAULT_SETTINGS.notifications)
  })

  it('notifications: each field is read on its own and an invalid one falls back with a notice naming it', () => {
    const r = parseSettings(JSON.stringify({ notifications: { sound: 'D:\\sounds\\Ding.WAV', done: { sound: false, tab: 'no' }, bell: { sound: true } } }))
    expect(r.settings.notifications.sound).toBe('D:\\sounds\\Ding.WAV')
    expect(r.settings.notifications.done).toEqual({ sound: false, flash: true, tab: true })
    expect(r.settings.notifications.bell).toEqual({ sound: true, flash: true, tab: true })
    expect(r.settings.notifications.permission).toEqual({ sound: true, flash: true, tab: true })
    expect(r.errors).toEqual(['settings.json: invalid value for "notifications.done.tab", using default'])
  })

  it('notifications.sound: "system" or an absolute .wav only', () => {
    for (const sound of ['none', 'ding.wav', 'D:\\sounds\\ding.mp3', 'loud', true]) {
      const r = parseSettings(JSON.stringify({ notifications: { sound } }))
      expect(r.settings.notifications.sound).toBe('system')
      expect(r.errors.join('\n')).toContain('"notifications.sound"')
    }
  })

  it('attention (old files): "none" turns the Claude sounds off, a .wav becomes the sound, flash: false stops Claude flashing', () => {
    const off = parseSettings(JSON.stringify({ attention: { sound: 'none', flash: false } }))
    expect(off.errors).toEqual([])
    expect(off.settings.notifications).toEqual({
      sound: 'system',
      permission: { sound: false, flash: false, tab: true },
      question: { sound: false, flash: false, tab: true },
      done: { sound: false, flash: false, tab: true },
      bell: { sound: false, flash: true, tab: true }
    })
    const wav = parseSettings(JSON.stringify({ attention: { sound: 'D:\\s\\ding.wav' } })).settings.notifications
    expect(wav.sound).toBe('D:\\s\\ding.wav')
    expect(wav.done).toEqual({ sound: true, flash: true, tab: true })
  })

  it('attention (old files): invalid values fall back with a notice naming them', () => {
    const r = parseSettings(JSON.stringify({ attention: { sound: 'loud', flash: 'yes' } }))
    expect(r.settings.notifications).toEqual(DEFAULT_SETTINGS.notifications)
    expect(r.errors.join('\n')).toContain('"attention.sound"')
    expect(r.errors.join('\n')).toContain('"attention.flash"')
  })

  it('notifications wins over attention', () => {
    const r = parseSettings(JSON.stringify({ attention: { sound: 'none' }, notifications: { done: { flash: false } } }))
    expect(r.settings.notifications.permission.sound).toBe(true)
    expect(r.settings.notifications.done).toEqual({ sound: true, flash: false, tab: true })
    expect(r.errors).toEqual([])
  })
```

Replace `tests/unit/attention.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { Attention, ATTENTION_REPEAT_MS } from '../../src/main/attention'
import { DEFAULT_SETTINGS } from '../../src/main/settings'
import type { NotificationSettings } from '../../src/shared/types'

function setup(o: { focused?: boolean; active?: string | null } = {}) {
  const state = { focused: o.focused ?? false, active: o.active === undefined ? 't1' : o.active, n: structuredClone(DEFAULT_SETTINGS.notifications) as NotificationSettings, t: 1000 }
  const calls: string[] = []
  const a = new Attention({
    windowFocused: () => state.focused,
    activeTabId: () => state.active,
    settings: () => state.n,
    flash: () => calls.push('flash'),
    play: (sound) => calls.push(`play:${sound}`),
    markTab: (id, reason) => calls.push(`mark:${id}:${reason}`),
    now: () => state.t
  })
  return { a, calls, state }
}

describe('Attention', () => {
  it('does nothing while the user looks at that tab', () => {
    const { a, calls } = setup({ focused: true, active: 't1' })
    expect(a.notify('t1', 'permission')).toBe(false)
    expect(a.notify('t1', 'bell')).toBe(false)
    expect(calls).toEqual([])
  })

  it('window in the background: plays the sound and flashes the taskbar', () => {
    const { a, calls } = setup({ focused: false, active: 't1' })
    expect(a.notify('t1', 'permission')).toBe(true)
    expect(calls).toEqual(['flash', 'play:system'])
  })

  it('another tab is open in the focused window: marks the tab with the reason and plays the sound, no flashing', () => {
    const { a, calls } = setup({ focused: true, active: 't2' })
    expect(a.notify('t1', 'question')).toBe(true)
    expect(calls).toEqual(['mark:t1:question', 'play:system'])
  })

  it('window in the background with another tab open: marks, flashes and plays', () => {
    const { a, calls } = setup({ focused: false, active: 't2' })
    a.notify('t1', 'done')
    expect(calls).toEqual(['mark:t1:done', 'flash', 'play:system'])
  })

  it('each case gives only the signals switched on for it', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.done = { sound: false, flash: true, tab: false }
    state.n.question = { sound: true, flash: false, tab: true }
    a.notify('t1', 'done')
    expect(calls).toEqual(['flash'])
    calls.length = 0
    a.notify('t3', 'question')
    expect(calls).toEqual(['mark:t3:question', 'play:system'])
  })

  it('a case with every signal off gives none and reports it', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.permission = { sound: false, flash: false, tab: false }
    expect(a.notify('t1', 'permission')).toBe(false)
    expect(calls).toEqual([])
  })

  it('plays the chosen .wav', () => {
    const { a, calls, state } = setup({ focused: false })
    state.n.sound = 'D:\\s\\ding.wav'
    a.notify('t1', 'done')
    expect(calls).toEqual(['flash', 'play:D:\\s\\ding.wav'])
  })

  it('the terminal bell: by default a dot and a flash, no sound', () => {
    const { a, calls } = setup({ focused: false, active: 't2' })
    expect(a.notify('t1', 'bell')).toBe(true)
    expect(calls).toEqual(['mark:t1:bell', 'flash'])
  })

  it('one sound per tab per repeat window; marking and flashing still happen; other tabs keep their own window', () => {
    const { a, calls, state } = setup({ focused: false, active: 't9' })
    a.notify('t1', 'question')
    state.t += ATTENTION_REPEAT_MS - 1
    calls.length = 0
    expect(a.notify('t1', 'permission')).toBe(true)
    expect(calls).toEqual(['mark:t1:permission', 'flash'])
    calls.length = 0
    a.notify('t2', 'permission')
    expect(calls).toContain('play:system')
    state.t += 1
    calls.length = 0
    a.notify('t1', 'done')
    expect(calls).toContain('play:system')
  })

  it('a case with its sound off does not use up the sound window', () => {
    const { a, calls, state } = setup({ focused: false })
    state.n.question.sound = false
    a.notify('t1', 'question')
    state.t += 100
    a.notify('t1', 'permission')
    expect(calls.filter((c) => c === 'play:system')).toHaveLength(1)
  })

  it('a bell sound obeys the same per-tab window', () => {
    const { a, calls, state } = setup({ focused: false })
    state.n.bell.sound = true
    a.notify('t1', 'bell')
    state.t += 10
    a.notify('t1', 'bell')
    expect(calls.filter((c) => c === 'play:system')).toHaveLength(1)
  })

  it('a suppressed notification while looking does not start the repeat window', () => {
    const { a, calls, state } = setup({ focused: true, active: 't1' })
    a.notify('t1', 'done')
    state.focused = false
    a.notify('t1', 'done')
    expect(calls).toContain('play:system')
  })

  it('removeTab forgets the repeat window', () => {
    const { a, calls } = setup({ focused: false })
    a.notify('t1', 'done')
    a.removeTab('t1')
    calls.length = 0
    a.notify('t1', 'done')
    expect(calls).toContain('play:system')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/settings.test.ts tests/unit/attention.test.ts`
Expected: FAIL — `DEFAULT_SETTINGS.notifications` is undefined; `markTab` gets no reason.

- [ ] **Step 3: Implement the settings model**

`src/shared/types.ts` — add before `interface Settings`, and replace the `attention` field:

```ts
export type NotificationCase = 'permission' | 'question' | 'done' | 'bell'

export interface NotificationChannels {
  sound: boolean
  /** flash the taskbar button when the window is not focused */
  flash: boolean
  /** mark the tab when it is not the active one */
  tab: boolean
}

/** sound: 'system' or an absolute path to a .wav file; then the signals each case gives */
export type NotificationSettings = { sound: string } & Record<NotificationCase, NotificationChannels>
```

```ts
  imagePanel: { autoOpen: boolean; width: number; maxItems: number }
  notifications: NotificationSettings
  /** check GitHub for new versions in the background */
  autoUpdate: boolean
```

`src/shared/settings-keys.ts`:

```ts
import type { NotificationCase, NotificationChannels } from './types'

// The settings vocabulary shared by the main process (parsing, editing) and the settings window.

export const NOTIFICATION_CASES: readonly NotificationCase[] = ['permission', 'question', 'done', 'bell']
export const NOTIFICATION_CHANNELS: readonly (keyof NotificationChannels)[] = ['sound', 'flash', 'tab']
```

`src/main/settings.ts`:
- import `NOTIFICATION_CASES, NOTIFICATION_CHANNELS` from `../shared/settings-keys` and `NotificationSettings` from `../shared/types`;
- in `DEFAULT_SETTINGS` replace `attention: { sound: 'system', flash: true },` with

```ts
  notifications: {
    sound: 'system',
    permission: { sound: true, flash: true, tab: true },
    question: { sound: true, flash: true, tab: true },
    done: { sound: true, flash: true, tab: true },
    bell: { sound: false, flash: true, tab: true }
  },
```

- replace `isSound` with

```ts
const isSoundFile: Guard<string> = (v): v is string => v === 'system' || (isStr(v) && win32.isAbsolute(v) && /\.wav$/i.test(v))
/** the old attention.sound also took "none" */
const isLegacySound: Guard<string> = (v): v is string => v === 'none' || isSoundFile(v)
const CLAUDE_CASES = ['permission', 'question', 'done'] as const
```

- drop `const at = obj(raw.attention)`; before `const settings: Settings = {` add

```ts
  const notifications: NotificationSettings = structuredClone(d.notifications)
  if (raw.notifications === undefined && raw.attention !== undefined) {
    // a file from before per-case notifications
    const at = obj(raw.attention)
    const sound = take('attention.sound', at.sound, isLegacySound, 'system')
    const flash = take('attention.flash', at.flash, isBool, true)
    if (sound !== 'none') notifications.sound = sound
    for (const c of CLAUDE_CASES) notifications[c] = { sound: sound !== 'none', flash, tab: true }
  } else {
    const nt = obj(raw.notifications)
    notifications.sound = take('notifications.sound', nt.sound, isSoundFile, notifications.sound)
    for (const c of NOTIFICATION_CASES) {
      const cv = obj(nt[c])
      for (const ch of NOTIFICATION_CHANNELS) notifications[c][ch] = take(`notifications.${c}.${ch}`, cv[ch], isBool, notifications[c][ch])
    }
  }
```

- in the `settings` object replace the `attention: {…}` entry with `notifications,`.

`src/main/attention.ts` — replace the file:

```ts
import type { NotificationCase, NotificationSettings } from '../shared/types'

/** A tab makes at most one sound this often (a question right before a permission prompt makes one). */
export const ATTENTION_REPEAT_MS = 2000

export interface AttentionDeps {
  windowFocused(): boolean
  activeTabId(): string | null
  settings(): NotificationSettings
  flash(): void
  /** 'system' or an absolute path to a .wav file */
  play(sound: string): void
  markTab(tabId: string, reason: NotificationCase): void
  now?(): number
}

/** Tells the user that a tab needs them, unless they are already looking at it, with the signals set for the case. */
export class Attention {
  private readonly lastSound = new Map<string, number>()

  constructor(private readonly d: AttentionDeps) {}

  /** Returns true when any signal was given. */
  notify(tabId: string, reason: NotificationCase): boolean {
    const focused = this.d.windowFocused()
    const active = this.d.activeTabId() === tabId
    if (focused && active) return false
    const s = this.d.settings()
    const c = s[reason]
    let signalled = false
    if (c.tab && !active) {
      this.d.markTab(tabId, reason)
      signalled = true
    }
    if (c.flash && !focused) {
      this.d.flash()
      signalled = true
    }
    if (c.sound) {
      const now = this.d.now?.() ?? Date.now()
      const prev = this.lastSound.get(tabId)
      if (prev === undefined || now - prev >= ATTENTION_REPEAT_MS) {
        this.lastSound.set(tabId, now)
        this.d.play(s.sound)
        signalled = true
      }
    }
    return signalled
  }

  removeTab(tabId: string): void {
    this.lastSound.delete(tabId)
  }
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run tests/unit/settings.test.ts tests/unit/attention.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing e2e tests**

In `tests/e2e/attention.spec.ts` add after `QUIET`:

```ts
const OFF = { sound: false, flash: false, tab: true }
/** per-case settings with the desktop kept quiet */
const quietNotifications = (over: object = {}): object => ({
  ...FAKE_CLAUDE_SETTINGS,
  notifications: { permission: OFF, question: OFF, done: OFF, bell: { sound: false, flash: false, tab: true }, ...over }
})
```

and append:

```ts
test('each case follows its own settings: a finished answer without tab highlight leaves the tab alone, a permission prompt marks it', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(quietNotifications({ done: { sound: false, flash: false, tab: false } }))
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  // the mark would arrive right after the pipe answer; give it time to show up if it were sent
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await app.close()
})

test('with the bell tab highlight off, a terminal bell in a background tab leaves no dot', async () => {
  const { app, page, tabId: first, work } = await launchClaudeTab(quietNotifications({ bell: { sound: false, flash: false, tab: false } }))
  const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)
  await expect.poll(() => bufferText(page, shell), { timeout: 20_000 }).toMatch(/PS .*>/)
  await page.evaluate((id) => window.ct.activateTab(id), first)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
  await page.evaluate((id) => window.ct.writePty(id, "Write-Host -NoNewline ([char]7); 'after-bell'\r"), shell)
  await expect.poll(() => bufferText(page, shell), { timeout: 10_000 }).toContain('after-bell')
  // the bell goes renderer → main → renderer; give that round trip time before checking it left no dot
  await page.waitForTimeout(500)
  await expect(page.locator(`[data-tab-id="${shell}"] .tab-bell`)).toHaveCount(0)
  await app.close()
})
```

- [ ] **Step 6: Wire the bell and the reason through main and the renderer**

`src/shared/ipc.ts`: import `NotificationCase` from `./types`; change `bell(): void` to `bell(tabId: string): void` with the doc comment `/** the terminal in that tab rang its bell (BEL) */`; change `onAttention(cb: (tabId: string) => void)` to `onAttention(cb: (tabId: string, reason: NotificationCase) => void)` with the doc comment `/** mark that tab: the bell dot for 'bell', the pulse for the Claude cases */`.

`src/preload/index.ts`: `bell: (tabId) => ipcRenderer.send(IPC.bell, tabId),`.

`src/main/index.ts`:
- the `Attention` deps: `settings: () => settings.notifications,` and `markTab: (tabId, reason) => send(IPC.evAttention, tabId, reason)`;
- the pipe `attention` handler: `const signalled = attention.notify(msg.tabId, msg.reason)`;
- replace `ipcMain.on(IPC.bell, () => { if (win && !win.isFocused()) win.flashFrame(true) })` with

```ts
  ipcMain.on(IPC.bell, (_e, tabId: unknown) => { if (isId(tabId) && tabs.get(tabId)) attention.notify(tabId, 'bell') })
```

`src/renderer/main.ts`:
- `onBell: () => ct.bell(info.id),`
- the attention listener:

```ts
  ct.onAttention((tabId, reason) => {
    const t = tabs.get(tabId)
    if (!t || tabId === activeId) return
    if (reason === 'bell') t.bell = true
    else t.attention = true
    renderTabs()
  })
```

- [ ] **Step 7: Typecheck, unit tests, build and the attention e2e**

Run: `npm run typecheck; npx vitest run; npm run build; npx playwright test tests/e2e/attention.spec.ts`
Expected: no type errors; all unit tests pass; all 6 attention e2e tests pass (the old `QUIET` with `attention` still works through the migration).

- [ ] **Step 8: Commit**

```bash
git add src/shared/settings-keys.ts src/shared/types.ts src/main/settings.ts src/main/attention.ts src/main/index.ts src/shared/ipc.ts src/preload/index.ts src/renderer/main.ts tests/unit/settings.test.ts tests/unit/attention.test.ts tests/e2e/attention.spec.ts
git commit -m "feat: per-case notification settings, the terminal bell included"
```

---

### Task 2: Editing settings.json from the app

**Files:**
- Modify: `src/shared/settings-keys.ts`, `src/main/settings.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/main.ts`
- Create test: `tests/unit/settings-keys.test.ts`, `tests/e2e/settings.spec.ts`
- Test: `tests/unit/settings.test.ts`

**Interfaces:**
- Consumes: `NOTIFICATION_CASES`, `NOTIFICATION_CHANNELS`, `Settings.notifications` (Task 1).
- Produces:
  - in `src/shared/settings-keys.ts`: `NUMBER_LIMITS: { 'font.size': { min: 6; max: 72 }; scrollback: { min: 0; max: 1000000 } }`, `type SettingKey`, `SETTING_KEYS: readonly SettingKey[]`, `type SettingValue = string | number | boolean | null`, `isSettingKey(v: unknown): v is SettingKey`, `isSettingValue(v: unknown): v is SettingValue`.
  - in `src/main/settings.ts`: `ParsedSettings.broken?: boolean`; `type EditResult = { ok: true; text: string } | { ok: false; error: string }`; `applySettingEdit(text: string | null, key: SettingKey, value: SettingValue): EditResult`.
  - in `src/shared/ipc.ts`: `IPC.settingsView = 'settings:view'`, `IPC.settingsSet = 'settings:set'`, `IPC.settingsPickSound = 'settings:pick-sound'`, `IPC.settingsPlaySound = 'settings:play-sound'`, `IPC.evSettingsView = 'ev:settings-view'`; `interface SettingsView { settings: Settings; profiles: string[]; path: string; problems: string[]; locked: boolean }`; `type SetSettingResult = { ok: true } | { ok: false; error: string }`; `CtApi.getSettingsView(): Promise<SettingsView>`, `CtApi.setSetting(key: SettingKey, value: SettingValue): Promise<SetSettingResult>`, `CtApi.pickSound(): Promise<string | null>`, `CtApi.playSound(): void`, `CtApi.onSettingsView(cb: (view: SettingsView) => void): Unsubscribe`.
  - `ev:settings-view` goes to every window.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/settings-keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isSettingKey, isSettingValue, SETTING_KEYS } from '../../src/shared/settings-keys'

describe('settings keys', () => {
  it('lists the 12 notification cells, the sound and the ten plain settings', () => {
    expect(SETTING_KEYS).toHaveLength(23)
    expect(SETTING_KEYS).toContain('notifications.bell.tab')
    expect(SETTING_KEYS).toContain('notifications.sound')
    expect(SETTING_KEYS).toContain('claude.shellProfile')
  })

  it('isSettingKey accepts listed keys only', () => {
    expect(isSettingKey('font.size')).toBe(true)
    expect(isSettingKey('profiles')).toBe(false)
    expect(isSettingKey('__proto__')).toBe(false)
    expect(isSettingKey(1)).toBe(false)
  })

  it('isSettingValue accepts strings, finite numbers, booleans and null', () => {
    for (const v of ['x', 12, 0, true, false, null]) expect(isSettingValue(v)).toBe(true)
    for (const v of [undefined, NaN, Infinity, {}, [], () => 1]) expect(isSettingValue(v)).toBe(false)
  })
})
```

In `tests/unit/settings.test.ts` add `applySettingEdit` to the import and append:

```ts
describe('parseSettings: broken files', () => {
  it('marks invalid JSON and a non-object root as broken', () => {
    expect(parseSettings('{ "font": ').broken).toBe(true)
    expect(parseSettings('[1]').broken).toBe(true)
    expect(parseSettings('{}').broken).toBeUndefined()
  })
})

describe('applySettingEdit', () => {
  const edit = (text: string | null, key: Parameters<typeof applySettingEdit>[1], value: Parameters<typeof applySettingEdit>[2]) => {
    const r = applySettingEdit(text, key, value)
    if (!r.ok) throw new Error(r.error)
    return r.text
  }

  it('sets a nested key, keeps unknown keys and their order, writes two-space JSON', () => {
    const text = edit('{"myNote":"keep","font":{"family":"Consolas","size":12},"scrollback":5}', 'font.size', 14)
    expect(text).toBe('{\n  "myNote": "keep",\n  "font": {\n    "family": "Consolas",\n    "size": 14\n  },\n  "scrollback": 5\n}\n')
  })

  it('creates missing objects and replaces a non-object on the way', () => {
    expect(JSON.parse(edit('{}', 'claude.command', 'claude-beta'))).toEqual({ claude: { command: 'claude-beta' } })
    expect(JSON.parse(edit('{"claude":"x"}', 'claude.shellProfile', null))).toEqual({ claude: { shellProfile: null } })
  })

  it('treats a missing file as empty and strips a BOM', () => {
    expect(JSON.parse(edit(null, 'autoUpdate', false))).toEqual({ autoUpdate: false })
    expect(JSON.parse(edit('\uFEFF{"scrollback":5}', 'autoUpdate', false))).toEqual({ scrollback: 5, autoUpdate: false })
  })

  it('refuses a value the app would not accept, naming the key', () => {
    expect(applySettingEdit('{}', 'font.size', 100)).toEqual({ ok: false, error: 'Invalid value for font.size' })
    expect(applySettingEdit('{}', 'font.family', '')).toEqual({ ok: false, error: 'Invalid value for font.family' })
    expect(applySettingEdit('{}', 'notifications.sound', 'none')).toEqual({ ok: false, error: 'Invalid value for notifications.sound' })
    expect(applySettingEdit('{}', 'imageWatch.enabled', 'yes')).toEqual({ ok: false, error: 'Invalid value for imageWatch.enabled' })
  })

  it('refuses a file that is not a JSON object', () => {
    const bad = applySettingEdit('{ "font": ', 'font.size', 14)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/^settings\.json can't be used: /)
    expect(applySettingEdit('[1]', 'font.size', 14)).toEqual({ ok: false, error: "settings.json can't be used: the root must be an object" })
  })

  it('an invalid value of another key does not block the edit', () => {
    expect(JSON.parse(edit('{"scrollback":-5}', 'font.size', 14))).toEqual({ scrollback: -5, font: { size: 14 } })
  })

  it('a notifications edit writes notifications from attention and drops attention', () => {
    const out = JSON.parse(edit('{"attention":{"sound":"none","flash":false},"scrollback":5}', 'notifications.done.tab', false))
    expect(out.attention).toBeUndefined()
    expect(out.scrollback).toBe(5)
    expect(out.notifications).toEqual({
      sound: 'system',
      permission: { sound: false, flash: false, tab: true },
      question: { sound: false, flash: false, tab: true },
      done: { sound: false, flash: false, tab: false },
      bell: { sound: false, flash: true, tab: true }
    })
  })

  it('a notifications edit keeps an existing notifications object and still drops attention', () => {
    const out = JSON.parse(edit('{"attention":{"sound":"none"},"notifications":{"done":{"tab":false}}}', 'notifications.bell.sound', true))
    expect(out).toEqual({ notifications: { done: { tab: false }, bell: { sound: true } } })
  })

  it('other edits leave attention alone', () => {
    expect(JSON.parse(edit('{"attention":{"sound":"none"}}', 'autoUpdate', false))).toEqual({ attention: { sound: 'none' }, autoUpdate: false })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/settings-keys.test.ts tests/unit/settings.test.ts`
Expected: FAIL — `SETTING_KEYS` and `applySettingEdit` are not exported; `broken` is undefined.

- [ ] **Step 3: Implement the keys and the edit**

Append to `src/shared/settings-keys.ts`:

```ts
/** number ranges the parser and the settings window both check */
export const NUMBER_LIMITS = {
  'font.size': { min: 6, max: 72 },
  scrollback: { min: 0, max: 1_000_000 }
} as const

/** the settings the settings window edits */
export type SettingKey =
  | `notifications.${NotificationCase}.${keyof NotificationChannels}`
  | 'notifications.sound'
  | 'font.family' | 'font.size' | 'theme' | 'scrollback'
  | 'defaultProfile' | 'claude.command' | 'claude.shellProfile'
  | 'imageWatch.enabled' | 'imagePanel.autoOpen' | 'autoUpdate'

export type SettingValue = string | number | boolean | null

export const SETTING_KEYS: readonly SettingKey[] = [
  ...NOTIFICATION_CASES.flatMap((c) => NOTIFICATION_CHANNELS.map((ch) => `notifications.${c}.${ch}` as const)),
  'notifications.sound',
  'font.family', 'font.size', 'theme', 'scrollback',
  'defaultProfile', 'claude.command', 'claude.shellProfile',
  'imageWatch.enabled', 'imagePanel.autoOpen', 'autoUpdate'
]

export const isSettingKey = (v: unknown): v is SettingKey => typeof v === 'string' && (SETTING_KEYS as readonly string[]).includes(v)

export const isSettingValue = (v: unknown): v is SettingValue =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
```

`src/main/settings.ts`:
- import `NUMBER_LIMITS, type SettingKey, type SettingValue` from `../shared/settings-keys`;
- `ParsedSettings` gains

```ts
  /** the text is not a JSON object (settings are then the defaults); the settings window does not edit such a file */
  broken?: boolean
```

- the two early returns become `return { settings: d, errors: [`settings.json: ${(e as Error).message}`], broken: true }` and `return { settings: d, errors: ['settings.json: root must be an object'], broken: true }`;
- `size: take('font.size', font.size, numIn(NUMBER_LIMITS['font.size'].min, NUMBER_LIMITS['font.size'].max), d.font.size),` and `scrollback: take('scrollback', raw.scrollback, numIn(NUMBER_LIMITS.scrollback.min, NUMBER_LIMITS.scrollback.max), d.scrollback),`;
- append:

```ts
export type EditResult = { ok: true; text: string } | { ok: false; error: string }

/** settings.json with one setting changed, checked the way the app reads it. Keys it does not know and the key order are kept. */
export function applySettingEdit(text: string | null, key: SettingKey, value: SettingValue): EditResult {
  const body = (text ?? '').replace(/^\uFEFF/, '')
  let raw: unknown = {}
  if (body.trim() !== '') {
    try {
      raw = JSON.parse(body)
    } catch (e) {
      return { ok: false, error: `settings.json can't be used: ${(e as Error).message}` }
    }
  }
  if (!isPlainObj(raw)) return { ok: false, error: "settings.json can't be used: the root must be an object" }
  if (key.startsWith('notifications.')) {
    // one source of truth: the old attention section turns into notifications on the first notifications edit
    if (raw.notifications === undefined) raw.notifications = parseSettings(body).settings.notifications
    delete raw.attention
  }
  const path = key.split('.')
  let node = raw
  for (const part of path.slice(0, -1)) {
    const next = node[part]
    if (!isPlainObj(next)) node[part] = {}
    node = node[part] as Record<string, unknown>
  }
  node[path[path.length - 1]!] = value
  const out = JSON.stringify(raw, null, 2) + '\n'
  if (parseSettings(out).errors.some((e) => e.includes(`"${key}"`))) return { ok: false, error: `Invalid value for ${key}` }
  return { ok: true, text: out }
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run tests/unit/settings-keys.test.ts tests/unit/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing e2e tests**

`tests/e2e/settings.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_CLAUDE_SETTINGS, launchApp } from './helpers'

const QUIET = { ...FAKE_CLAUDE_SETTINGS, attention: { sound: 'none', flash: false } }

// e2e runs the DOM renderer, which puts the xterm font size on .xterm-rows
function renderedFontSize(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.terminal-host:not([style*="none"]) .xterm-rows')!).fontSize)
}

const readSettings = (dataDir: string): Record<string, any> => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))

test('setSetting writes settings.json, keeps the other keys and applies at once', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { ...QUIET, myNote: 'keep' } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(await page.evaluate(() => window.ct.setSetting('font.size', 9))).toEqual({ ok: true })
  expect(readSettings(dataDir)).toMatchObject({ myNote: 'keep', font: { size: 9 }, attention: { sound: 'none' } })
  await expect.poll(() => renderedFontSize(page)).toBe('12px')
  const view = await page.evaluate(() => window.ct.getSettingsView())
  expect(view).toMatchObject({ path: join(dataDir, 'settings.json'), problems: [], locked: false })
  expect(view.settings.font.size).toBe(9)
  expect(view.profiles).toContain('Windows PowerShell')
  await app.close()
})

test('an invalid value is refused and the file is left as it was', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const before = readFileSync(join(dataDir, 'settings.json'), 'utf8')
  expect(await page.evaluate(() => window.ct.setSetting('font.size', 100))).toEqual({ ok: false, error: 'Invalid value for font.size' })
  expect(await page.evaluate(() => window.ct.setSetting('profiles' as never, 1))).toEqual({ ok: false, error: 'Not a setting' })
  expect(readFileSync(join(dataDir, 'settings.json'), 'utf8')).toBe(before)
  await app.close()
})

test('a notifications edit turns the old attention section into notifications', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(await page.evaluate(() => window.ct.setSetting('notifications.done.tab', false))).toEqual({ ok: true })
  const file = readSettings(dataDir)
  expect(file.attention).toBeUndefined()
  expect(file.notifications.permission).toEqual({ sound: false, flash: false, tab: true })
  expect(file.notifications.done).toEqual({ sound: false, flash: false, tab: false })
  await app.close()
})

test('zoom survives a change to another setting; a font change resets it', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Equal')
  await expect.poll(() => renderedFontSize(page)).not.toBe('16px')
  const zoomed = await renderedFontSize(page)
  expect(await page.evaluate(() => window.ct.setSetting('notifications.done.sound', false))).toEqual({ ok: true })
  // the file watcher reloads the same file a moment later; wait it out too
  await page.waitForTimeout(800)
  expect(await renderedFontSize(page)).toBe(zoomed)
  expect(await page.evaluate(() => window.ct.setSetting('font.size', 9))).toEqual({ ok: true })
  await expect.poll(() => renderedFontSize(page)).toBe('12px')
  await app.close()
})

test('a notice is toasted once, not on every save', async () => {
  const { app, page } = await launchApp({ settings: { ...QUIET, scrollback: -5 } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const notice = page.locator('.toast', { hasText: 'invalid value for "scrollback"' })
  await expect(notice).toHaveCount(1)
  await page.evaluate(() => window.ct.setSetting('autoUpdate', false))
  await page.evaluate(() => window.ct.setSetting('autoUpdate', true))
  await page.waitForTimeout(800)
  await expect(notice).toHaveCount(1)
  const view = await page.evaluate(() => window.ct.getSettingsView())
  expect(view.problems).toEqual(['settings.json: invalid value for "scrollback", using default'])
  await app.close()
})

test('the view reports a broken file as locked and every window hears about it', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await page.evaluate(() => {
    ;(window as unknown as { views: unknown[] }).views = []
    window.ct.onSettingsView((v) => (window as unknown as { views: unknown[] }).views.push(v))
  })
  writeFileSync(join(dataDir, 'settings.json'), '{ broken')
  await expect.poll(() => page.evaluate(() => window.ct.getSettingsView().then((v) => v.locked))).toBe(true)
  expect((await page.evaluate(() => window.ct.getSettingsView())).problems[0]).toMatch(/^settings\.json: /)
  expect(await page.evaluate(() => window.ct.setSetting('font.size', 14))).toMatchObject({ ok: false, error: expect.stringMatching(/^settings\.json can't be used: /) })
  await expect.poll(() => page.evaluate(() => (window as unknown as { views: { locked: boolean }[] }).views.some((v) => v.locked))).toBe(true)
  writeFileSync(join(dataDir, 'settings.json'), '{}')
  await expect.poll(() => page.evaluate(() => window.ct.getSettingsView().then((v) => v.locked))).toBe(false)
  await app.close()
})
```

- [ ] **Step 6: Implement the IPC, the reload and the renderer side**

`src/shared/ipc.ts`:
- import `SettingKey, SettingValue` (types) from `./settings-keys`;
- add to `IPC`: `settingsView: 'settings:view',`, `settingsSet: 'settings:set',`, `settingsPickSound: 'settings:pick-sound',`, `settingsPlaySound: 'settings:play-sound',` (after `settingsOpen`) and `evSettingsView: 'ev:settings-view',` (after `evSettings`);
- add the types:

```ts
/** what the settings window shows */
export interface SettingsView {
  settings: Settings
  /** profile names, in the order of the new tab menu */
  profiles: string[]
  /** settings.json */
  path: string
  /** notices from the last load of settings.json */
  problems: string[]
  /** settings.json cannot be read or is not a JSON object: the window does not edit it */
  locked: boolean
}

export type SetSettingResult = { ok: true } | { ok: false; error: string }
```

- add to `CtApi` after `openSettingsFile(): void`:

```ts
  getSettingsView(): Promise<SettingsView>
  /** writes one setting to settings.json and applies it */
  setSetting(key: SettingKey, value: SettingValue): Promise<SetSettingResult>
  /** asks for a .wav file; saves nothing */
  pickSound(): Promise<string | null>
  /** plays the notification sound now in use */
  playSound(): void
```

and after `onSettings(...)`: `onSettingsView(cb: (view: SettingsView) => void): Unsubscribe`.

`src/preload/index.ts`:

```ts
  getSettingsView: () => ipcRenderer.invoke(IPC.settingsView),
  setSetting: (key, value) => ipcRenderer.invoke(IPC.settingsSet, key, value),
  pickSound: () => ipcRenderer.invoke(IPC.settingsPickSound),
  playSound: () => ipcRenderer.send(IPC.settingsPlaySound),
```

and `onSettingsView: (cb) => on(IPC.evSettingsView, cb),`.

`src/main/index.ts`:
- imports: `BrowserWindow`, `dialog` from `electron` (alongside the existing ones), `readFileSync`, `writeFileSync` from `node:fs` if not imported, `applySettingEdit, type ParsedSettings` from `./settings`, `isSettingKey, isSettingValue` from `../shared/settings-keys`, `SetSettingResult, SettingsView` from `../shared/ipc`;
- after `send`, add

```ts
  const broadcast = (channel: string, ...args: unknown[]): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
```

- `computeProfiles` returns its notices instead of toasting them:

```ts
  const computeProfiles = (s: Settings): { profiles: ProfileDef[]; notices: string[] } => {
    const { available, missing } = filterAvailable(s.profiles, existsSync)
    return {
      profiles: mergeProfiles(detectProfiles(systemDetectDeps()), available),
      notices: missing.map((p) => `Profile "${p.name}" not found: ${p.command}`)
    }
  }
```

- the startup load:

```ts
  const loaded = loadSettingsSafe(settingsPath)
  let settings: Settings = loaded.settings
  let lastLoad: ParsedSettings = loaded
  if (loaded.failed) log.error(loaded.errors[0])
  const startProfiles = computeProfiles(settings)
  let profiles = startProfiles.profiles
  // notices toast when they appear, not again on every reload that still has them
  let lastNotices = [...loaded.errors, ...startProfiles.notices]
  startupNotices.push(...lastNotices)
```

- replace the watcher's timer body with a function placed before the watcher:

```ts
  const settingsView = (): SettingsView => ({
    settings,
    profiles: profiles.map((p) => p.name),
    path: settingsPath,
    problems: lastLoad.errors,
    locked: Boolean(lastLoad.failed || lastLoad.broken)
  })
  const reloadSettings = (): void => {
    const next = loadSettingsSafe(settingsPath)
    lastLoad = next
    let notices = next.errors
    // a file that cannot be read keeps the current settings
    if (!next.failed) {
      settings = next.settings
      const computed = computeProfiles(settings)
      profiles = computed.profiles
      notices = [...notices, ...computed.notices]
      send(IPC.evSettings, settings)
    }
    for (const n of notices) if (!lastNotices.includes(n)) toast(n)
    lastNotices = notices
    broadcast(IPC.evSettingsView, settingsView())
  }
```

and in the watcher: `reloadTimer = setTimeout(reloadSettings, 300)`;
- the handlers, after `ipcMain.on(IPC.settingsOpen, …)`:

```ts
  ipcMain.handle(IPC.settingsView, () => settingsView())
  ipcMain.handle(IPC.settingsSet, (_e, key: unknown, value: unknown): SetSettingResult => {
    if (!isSettingKey(key) || !isSettingValue(value)) return { ok: false, error: 'Not a setting' }
    let text: string | null = null
    try {
      text = readFileSync(settingsPath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: `Cannot read settings.json: ${(e as Error).message}` }
    }
    const edited = applySettingEdit(text, key, value)
    if (!edited.ok) return edited
    try {
      writeFileSync(settingsPath, edited.text, 'utf8')
    } catch (e) {
      return { ok: false, error: `Cannot save settings.json: ${(e as Error).message}` }
    }
    // apply now; the watcher reloads the same file a moment later and changes nothing
    reloadSettings()
    return { ok: true }
  })
  ipcMain.handle(IPC.settingsPickSound, async (e): Promise<string | null> => {
    if (isTest && process.env.CLAUDETERM_TEST_PICK_SOUND) return process.env.CLAUDETERM_TEST_PICK_SOUND
    const owner = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = { title: 'Choose a sound', filters: [{ name: 'Sounds', extensions: ['wav'] }], properties: ['openFile'] }
    const r = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : r.filePaths[0] ?? null
  })
  ipcMain.on(IPC.settingsPlaySound, () => playSound(settings.notifications.sound))
```

`src/renderer/main.ts` — `applySettings` touches the font only when the font changed (keeps the Ctrl+= zoom otherwise) and the theme only when it changed:

```ts
function applySettings(s: Settings): void {
  const prev = settings
  settings = s
  if (s.font.family !== prev.font.family || s.font.size !== prev.font.size) {
    fontSize = s.font.size
    for (const t of tabs.values()) t.view.setFont(s.font.family, fontSize)
  }
  if (JSON.stringify(s.theme) !== JSON.stringify(prev.theme)) {
    const theme = resolveTheme(s.theme)
    for (const t of tabs.values()) t.view.setTheme(theme)
  }
}
```

- [ ] **Step 7: Typecheck, unit tests, build and the e2e**

Run: `npm run typecheck; npx vitest run; npm run build; npx playwright test tests/e2e/settings.spec.ts tests/e2e/attention.spec.ts tests/e2e/font.spec.ts`
Expected: no type errors; all unit tests pass; the 6 new settings e2e tests and the attention and font e2e tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/shared/settings-keys.ts src/main/settings.ts src/shared/ipc.ts src/preload/index.ts src/main/index.ts src/renderer/main.ts tests/unit/settings-keys.test.ts tests/unit/settings.test.ts tests/e2e/settings.spec.ts
git commit -m "feat: edit settings.json from the app, one checked setting at a time"
```

---

### Task 3: The settings window

**Files:**
- Create: `src/main/settings-window.ts`, `src/renderer/settings.html`, `src/renderer/settings-page.ts`, `src/renderer/settings.css`, `src/renderer/colors.css`
- Modify: `electron.vite.config.ts`, `src/renderer/styles.css`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/main.ts`
- Test: `tests/unit/settings-window.test.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `CtApi.getSettingsView`, `CtApi.onSettingsView` (Task 2).
- Produces:
  - `interface Rect { x: number; y: number; width: number; height: number }`, `SETTINGS_SIZE`, `SETTINGS_MIN`, `settingsWindowBounds(parent: Rect, work: Rect): Rect`, `class SettingsWindow { constructor(d: SettingsWindowDeps); open(): void }` with `interface SettingsWindowDeps { parent(): BrowserWindow | null; preload: string; load(win: BrowserWindow): void }` in `src/main/settings-window.ts`.
  - `IPC.settingsOpenWindow = 'settings:open-window'`; `CtApi.openSettingsWindow(): void`.
  - `src/renderer/settings-page.ts` exports nothing; it renders into `#settings` and Task 4 grows it. In Task 3 it shows the heading `Settings` and closes on Esc.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/settings-window.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { settingsWindowBounds } from '../../src/main/settings-window'

const WORK = { x: 0, y: 0, width: 1920, height: 1040 }

describe('settingsWindowBounds', () => {
  it('centres the 640×720 window on the main window', () => {
    expect(settingsWindowBounds({ x: 100, y: 50, width: 1200, height: 900 }, WORK)).toEqual({ x: 380, y: 140, width: 640, height: 720 })
  })

  it('keeps it inside the work area when the main window is near an edge', () => {
    expect(settingsWindowBounds({ x: 1700, y: 900, width: 600, height: 400 }, WORK)).toEqual({ x: 1280, y: 320, width: 640, height: 720 })
    expect(settingsWindowBounds({ x: -500, y: -300, width: 600, height: 400 }, WORK)).toEqual({ x: 0, y: 0, width: 640, height: 720 })
  })

  it('shrinks to a small work area, on a second monitor too', () => {
    expect(settingsWindowBounds({ x: 2000, y: 0, width: 800, height: 600 }, { x: 1920, y: 0, width: 1024, height: 600 })).toEqual({ x: 2000, y: 0, width: 640, height: 600 })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/unit/settings-window.test.ts`
Expected: FAIL — cannot resolve `../../src/main/settings-window`.

- [ ] **Step 3: Implement the window in main**

`src/main/settings-window.ts`:

```ts
import { BrowserWindow, screen, shell } from 'electron'

export interface Rect { x: number; y: number; width: number; height: number }

export const SETTINGS_SIZE = { width: 640, height: 720 }
export const SETTINGS_MIN = { width: 520, height: 400 }

/** Centred on the main window, shrunk to and kept inside the work area of its display. */
export function settingsWindowBounds(parent: Rect, work: Rect): Rect {
  const width = Math.min(SETTINGS_SIZE.width, work.width)
  const height = Math.min(SETTINGS_SIZE.height, work.height)
  const x = Math.round(parent.x + (parent.width - width) / 2)
  const y = Math.round(parent.y + (parent.height - height) / 2)
  return {
    x: Math.min(Math.max(x, work.x), work.x + work.width - width),
    y: Math.min(Math.max(y, work.y), work.y + work.height - height),
    width,
    height
  }
}

export interface SettingsWindowDeps {
  parent(): BrowserWindow | null
  preload: string
  load(win: BrowserWindow): void
}

/** The one settings window: owned by the main window, brought forward when it is already open. */
export class SettingsWindow {
  private win: BrowserWindow | null = null

  constructor(private readonly d: SettingsWindowDeps) {}

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus()
      return
    }
    const parent = this.d.parent()
    const around = parent && !parent.isDestroyed() ? parent.getBounds() : screen.getPrimaryDisplay().workArea
    const work = screen.getDisplayMatching(around).workArea
    const win = new BrowserWindow({
      ...settingsWindowBounds(around, work),
      minWidth: SETTINGS_MIN.width,
      minHeight: SETTINGS_MIN.height,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      show: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'ClaudeTerm Settings',
      backgroundColor: '#1b1b1f',
      webPreferences: { preload: this.d.preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    win.setMenu(null)
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => { if (this.win === win) this.win = null })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    this.win = win
    this.d.load(win)
  }
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run tests/unit/settings-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing e2e tests**

In `tests/e2e/settings.spec.ts` change the first import line to `import { expect, test, type ElectronApplication, type Page } from '@playwright/test'` and add after `readSettings`:

```ts
/** Ctrl+, in the main window; returns the settings window once its page is up */
async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  await page.locator('.terminal-host:visible .xterm').click()
  const [win] = await Promise.all([app.waitForEvent('window'), page.keyboard.press('Control+Comma')])
  await win.waitForSelector('#settings .settings-heading')
  return win
}
```

and append:

```ts
test('Ctrl+, opens one settings window; Esc closes it', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  expect(await win.title()).toBe('ClaudeTerm Settings')
  await page.keyboard.press('Control+Comma')
  await page.waitForTimeout(500)
  expect(app.windows()).toHaveLength(2)
  const closed = win.waitForEvent('close')
  await win.keyboard.press('Escape')
  await closed
  expect(app.windows()).toHaveLength(1)
  await app.close()
})

test('the ▾ menu opens the settings window', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await page.locator('.tab-menu').click()
  const [win] = await Promise.all([app.waitForEvent('window'), page.locator('.menu-item', { hasText: 'Settings…' }).click()])
  await expect(win.locator('#settings .settings-heading')).toHaveText('Settings')
  await app.close()
})

test('closing the main window with settings open ends the app', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await openSettings(app, page)
  const closed = app.waitForEvent('close')
  const started = Date.now()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)?.close() }).catch(() => {})
  await closed
  expect(Date.now() - started).toBeLessThan(5000)
})
```

- [ ] **Step 6: Add the page, the build input and the wiring**

`electron.vite.config.ts`:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        // the terminal window and the settings window
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    }
  }
})
```

`src/renderer/colors.css` — the `:root { … }` block moved from `styles.css` as it is:

```css
:root {
  --bg: #0c0c0c;
  --chrome: #1b1b1f;
  --chrome-2: #26262c;
  --fg: #d6d6d6;
  --muted: #8a8a93;
  --accent: #d97757;
  --border: #33333a;
}
```

`src/renderer/styles.css` — replace that block with `@import './colors.css';` as the first line.

`src/renderer/settings.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" />
    <title>ClaudeTerm Settings</title>
  </head>
  <body>
    <div id="settings"></div>
    <script type="module" src="./settings-page.ts"></script>
  </body>
</html>
```

`src/renderer/settings.css`:

```css
@import './colors.css';

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; min-height: 100%; background: var(--chrome); color: var(--fg); font: 13px "Segoe UI", system-ui, sans-serif; color-scheme: dark; }
#settings { padding: 16px 20px 20px; }
.settings-heading { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
```

`src/renderer/settings-page.ts`:

```ts
import './settings.css'

const root = document.getElementById('settings')!
const heading = document.createElement('h1')
heading.className = 'settings-heading'
heading.textContent = 'Settings'
root.append(heading)

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close()
})
```

`src/shared/ipc.ts`: `settingsOpenWindow: 'settings:open-window',` in `IPC`; in `CtApi` after `openSettingsFile(): void`: `/** opens the settings window, or brings it forward */ openSettingsWindow(): void`.

`src/preload/index.ts`: `openSettingsWindow: () => ipcRenderer.send(IPC.settingsOpenWindow),`.

`src/main/index.ts`:
- `import { SettingsWindow } from './settings-window'`;
- after the settings IPC handlers:

```ts
  const settingsWindow = new SettingsWindow({
    parent: () => win,
    preload: join(__dirname, '../preload/index.js'),
    load: (w) => {
      if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings.html`)
      else void w.loadFile(join(__dirname, '../renderer/settings.html'))
    }
  })
  ipcMain.on(IPC.settingsOpenWindow, () => settingsWindow.open())
```

`src/renderer/main.ts`:
- `case 'openSettings': ct.openSettingsWindow(); break`
- in `newTabMenu`, between the separator and the version item: `{ label: 'Settings…', action: () => ct.openSettingsWindow() },`.

- [ ] **Step 7: Typecheck, unit tests, build and the e2e**

Run: `npm run typecheck; npx vitest run; npm run build; npx playwright test tests/e2e/settings.spec.ts tests/e2e/keys.spec.ts tests/e2e/smoke.spec.ts`
Expected: no type errors; all unit tests pass; `out/renderer/settings.html` exists; the 9 settings e2e tests and the keys and smoke e2e tests pass.

- [ ] **Step 8: Commit**

```bash
git add electron.vite.config.ts src/main/settings-window.ts src/main/index.ts src/shared/ipc.ts src/preload/index.ts src/renderer/settings.html src/renderer/settings-page.ts src/renderer/settings.css src/renderer/colors.css src/renderer/styles.css src/renderer/main.ts tests/unit/settings-window.test.ts tests/e2e/settings.spec.ts
git commit -m "feat: a settings window, opened with Ctrl+, or from the menu"
```

---

### Task 4: The settings form

**Files:**
- Create: `src/renderer/settings-form.ts`
- Modify: `src/renderer/settings-page.ts`, `src/renderer/settings.css`, `src/renderer/main.ts`, `src/renderer/env.d.ts`
- Test: `tests/unit/settings-form.test.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `SettingsView`, `CtApi.getSettingsView/setSetting/pickSound/playSound/onSettingsView/openSettingsFile` (Task 2), `NUMBER_LIMITS`, `NOTIFICATION_CASES`, `NOTIFICATION_CHANNELS`, `SettingKey`, `SettingValue` (Tasks 1–2), `THEMES` from `src/renderer/themes.ts`.
- Produces:
  - in `src/renderer/settings-form.ts`: `interface Option { value: string; label: string }`, `type Checked<T> = { ok: true; value: T } | { ok: false; error: string }`, `AUTOMATIC = ''`, `CUSTOM_THEME = '\u0000custom'`, `checkNumber(key: keyof typeof NUMBER_LIMITS, text: string): Checked<number>`, `checkText(text: string): Checked<string>`, `themeOptions(theme: Settings['theme']): { options: Option[]; selected: string }`, `profileOptions(names: string[], current: string | null): { options: Option[]; selected: string }`, `profileValue(v: string): string | null`, `soundChoice(sound: string): { custom: boolean; path: string }`.
  - every input in the window carries `data-key="<setting key>"`; the custom-sound radio carries `data-key="notifications.sound"` and `value="custom"`, the default one `value="system"`.
  - `CtTestHook.themeBackground(): string | null` — the active terminal's theme background.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/settings-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AUTOMATIC, checkNumber, checkText, CUSTOM_THEME, profileOptions, profileValue, soundChoice, themeOptions } from '../../src/renderer/settings-form'

describe('settings form', () => {
  it('checkNumber: font size 6–72, fractions allowed', () => {
    expect(checkNumber('font.size', '12')).toEqual({ ok: true, value: 12 })
    expect(checkNumber('font.size', ' 10.5 ')).toEqual({ ok: true, value: 10.5 })
    for (const t of ['', '5', '73', 'big', 'Infinity']) expect(checkNumber('font.size', t)).toEqual({ ok: false, error: 'Between 6 and 72' })
  })

  it('checkNumber: scrollback is a whole number 0–1000000', () => {
    expect(checkNumber('scrollback', '0')).toEqual({ ok: true, value: 0 })
    expect(checkNumber('scrollback', '1000000')).toEqual({ ok: true, value: 1_000_000 })
    for (const t of ['-1', '1000001', '10.5', '']) expect(checkNumber('scrollback', t)).toEqual({ ok: false, error: 'A whole number between 0 and 1000000' })
  })

  it('checkText: trims and refuses empty text', () => {
    expect(checkText('  Consolas ')).toEqual({ ok: true, value: 'Consolas' })
    expect(checkText('   ')).toEqual({ ok: false, error: 'Cannot be empty' })
  })

  it('themeOptions: the built-in themes; a custom object or an unknown name gets an extra selected item', () => {
    expect(themeOptions('One Half Dark')).toEqual({
      options: [{ value: 'Campbell', label: 'Campbell' }, { value: 'One Half Dark', label: 'One Half Dark' }, { value: 'One Half Light', label: 'One Half Light' }],
      selected: 'One Half Dark'
    })
    const custom = themeOptions({ background: '#000000' })
    expect(custom.options.at(-1)).toEqual({ value: CUSTOM_THEME, label: 'Custom (settings.json)' })
    expect(custom.selected).toBe(CUSTOM_THEME)
    const unknown = themeOptions('Dracula')
    expect(unknown.options.at(-1)).toEqual({ value: 'Dracula', label: 'Dracula (not found)' })
    expect(unknown.selected).toBe('Dracula')
  })

  it('profileOptions: Automatic first, then the profiles; a missing current one is shown as not found', () => {
    expect(profileOptions(['PowerShell 7', 'cmd'], null)).toEqual({
      options: [{ value: AUTOMATIC, label: 'Automatic' }, { value: 'PowerShell 7', label: 'PowerShell 7' }, { value: 'cmd', label: 'cmd' }],
      selected: AUTOMATIC
    })
    const gone = profileOptions(['cmd'], 'Git Bash')
    expect(gone.options.at(-1)).toEqual({ value: 'Git Bash', label: 'Git Bash (not found)' })
    expect(gone.selected).toBe('Git Bash')
    expect(profileValue(AUTOMATIC)).toBeNull()
    expect(profileValue('cmd')).toBe('cmd')
  })

  it('soundChoice', () => {
    expect(soundChoice('system')).toEqual({ custom: false, path: '' })
    expect(soundChoice('D:\\s\\ding.wav')).toEqual({ custom: true, path: 'D:\\s\\ding.wav' })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/unit/settings-form.test.ts`
Expected: FAIL — cannot resolve `../../src/renderer/settings-form`.

- [ ] **Step 3: Implement the form helpers**

`src/renderer/settings-form.ts`:

```ts
import { NUMBER_LIMITS } from '../shared/settings-keys'
import type { Settings } from '../shared/types'
import { THEMES } from './themes'

// What the settings window shows and accepts, kept apart from the DOM.

export interface Option { value: string; label: string }
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** the select value for a null profile (profile names are never empty) */
export const AUTOMATIC = ''
/** the select value for a theme object from settings.json */
export const CUSTOM_THEME = '\u0000custom'

export function checkNumber(key: keyof typeof NUMBER_LIMITS, text: string): Checked<number> {
  const { min, max } = NUMBER_LIMITS[key]
  const whole = key === 'scrollback'
  const n = Number(text.trim())
  const ok = text.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!whole || Number.isInteger(n))
  if (ok) return { ok: true, value: n }
  return { ok: false, error: whole ? `A whole number between ${min} and ${max}` : `Between ${min} and ${max}` }
}

export function checkText(text: string): Checked<string> {
  const v = text.trim()
  return v === '' ? { ok: false, error: 'Cannot be empty' } : { ok: true, value: v }
}

const plain = (names: string[]): Option[] => names.map((n) => ({ value: n, label: n }))

export function themeOptions(theme: Settings['theme']): { options: Option[]; selected: string } {
  const names = Object.keys(THEMES)
  if (typeof theme !== 'string') return { options: [...plain(names), { value: CUSTOM_THEME, label: 'Custom (settings.json)' }], selected: CUSTOM_THEME }
  const extra = names.includes(theme) ? [] : [{ value: theme, label: `${theme} (not found)` }]
  return { options: [...plain(names), ...extra], selected: theme }
}

export function profileOptions(names: string[], current: string | null): { options: Option[]; selected: string } {
  const extra = current !== null && !names.includes(current) ? [{ value: current, label: `${current} (not found)` }] : []
  return { options: [{ value: AUTOMATIC, label: 'Automatic' }, ...plain(names), ...extra], selected: current ?? AUTOMATIC }
}

export const profileValue = (v: string): string | null => (v === AUTOMATIC ? null : v)

export function soundChoice(sound: string): { custom: boolean; path: string } {
  return sound === 'system' ? { custom: false, path: '' } : { custom: true, path: sound }
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run tests/unit/settings-form.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing e2e tests**

In `tests/e2e/settings.spec.ts` add `import { sendPipeMessage } from '../../src/shared/pipe-client'`, add `launchClaudeTab` to the helpers import, `const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'` after the imports, and append:

```ts
test('a notification checkbox saves to settings.json and the case follows it', async () => {
  const { app, page, tabId, work, pipeName, dataDir } = await launchClaudeTab(QUIET)
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)
  const win = await openSettings(app, page)
  const box = win.locator('[data-key="notifications.done.tab"]')
  await expect(box).toBeChecked()
  await box.uncheck()
  await expect.poll(() => readSettings(dataDir).notifications?.done?.tab).toBe(false)
  expect(readSettings(dataDir).attention).toBeUndefined()
  await expect(win.locator('[data-key="notifications.permission.sound"]')).not.toBeChecked()
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await app.close()
})

test('quick clicks all reach the file', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  for (const c of ['permission', 'question', 'done', 'bell']) await win.locator(`[data-key="notifications.${c}.flash"]`).click({ delay: 0 })
  await expect.poll(() => {
    const n = readSettings(dataDir).notifications
    return n ? [n.permission.flash, n.question.flash, n.done.flash, n.bell.flash] : null
  }).toEqual([true, true, true, false])
  await app.close()
})

test('size and theme apply to the terminal at once', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await win.locator('[data-key="font.size"]').fill('9')
  await win.locator('[data-key="font.size"]').press('Enter')
  await expect.poll(() => renderedFontSize(page)).toBe('12px')
  await win.locator('[data-key="theme"]').selectOption('One Half Light')
  await expect.poll(() => page.evaluate(() => window.__ct!.themeBackground!())).toBe('#FAFAFA')
  expect(readSettings(dataDir)).toMatchObject({ font: { size: 9 }, theme: 'One Half Light' })
  await app.close()
})

test('an out-of-range size shows the error and is not saved', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const size = win.locator('[data-key="font.size"]')
  await size.fill('100')
  await size.press('Enter')
  await expect(size).toHaveClass(/\binvalid\b/)
  await expect(win.locator('.field-error', { hasText: 'Between 6 and 72' })).toBeVisible()
  expect(readSettings(dataDir).font).toBeUndefined()
  await size.fill('14')
  await size.press('Enter')
  await expect(win.locator('.field-error', { hasText: 'Between 6 and 72' })).toBeHidden()
  await expect.poll(() => readSettings(dataDir).font?.size).toBe(14)
  await app.close()
})

test('a hand edit updates the window but not the field being typed in; a broken file locks it until fixed', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const file = join(dataDir, 'settings.json')
  const font = win.locator('[data-key="font.family"]')
  await font.fill('Typing in progress')
  writeFileSync(file, JSON.stringify({ ...QUIET, scrollback: 777, font: { family: 'Consolas' } }))
  await expect(win.locator('[data-key="scrollback"]')).toHaveValue('777')
  await expect(font).toHaveValue('Typing in progress')
  writeFileSync(file, '{ broken')
  await expect(win.locator('.settings-banner')).toContainText("settings.json can't be used:")
  await expect(win.locator('[data-key="font.size"]')).toBeDisabled()
  await expect(win.locator('[data-key="notifications.done.tab"]')).toBeDisabled()
  writeFileSync(file, JSON.stringify(QUIET))
  await expect(win.locator('.settings-banner')).toBeHidden()
  await expect(win.locator('[data-key="font.size"]')).toBeEnabled()
  await app.close()
})

test('a custom theme, an unknown profile and invalid values in the file are shown as they are', async () => {
  const { app, page } = await launchApp({ settings: { ...QUIET, theme: { background: '#101010' }, claude: { ...QUIET.claude, shellProfile: 'Gone Shell' }, scrollback: -5 } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await expect(win.locator('[data-key="theme"] option:checked')).toHaveText('Custom (settings.json)')
  await expect(win.locator('[data-key="claude.shellProfile"] option:checked')).toHaveText('Gone Shell (not found)')
  await expect(win.locator('[data-key="defaultProfile"] option:checked')).toHaveText('Windows PowerShell')
  await expect(win.locator('.settings-notice')).toContainText('invalid value for "scrollback"')
  await app.close()
})

test('Browse saves the picked .wav; Windows default goes back to the system sound', async () => {
  const wav = 'C:\\sounds\\ding.wav'
  const { app, page, dataDir } = await launchApp({ settings: QUIET, env: { CLAUDETERM_TEST_PICK_SOUND: wav } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await expect(win.locator('[data-key="notifications.sound"][value="system"]')).toBeChecked()
  await win.locator('button', { hasText: 'Browse…' }).click()
  await expect.poll(() => readSettings(dataDir).notifications?.sound).toBe(wav)
  await expect(win.locator('.sound-path')).toHaveValue(wav)
  await expect(win.locator('[data-key="notifications.sound"][value="custom"]')).toBeChecked()
  await win.locator('[data-key="notifications.sound"][value="system"]').check()
  await expect.poll(() => readSettings(dataDir).notifications?.sound).toBe('system')
  await expect(win.locator('.sound-path')).toHaveValue('')
  await app.close()
})
```

- [ ] **Step 6: Build the form**

`src/renderer/env.d.ts` — add to `CtTestHook`: `themeBackground?(): string | null`.

`src/renderer/main.ts` — in the `window.__ct = { … }` test hook add:

```ts
      themeBackground: () => (activeId ? tabs.get(activeId)?.view.term.options.theme?.background ?? null : null),
```

`src/renderer/settings-page.ts` — replace the file:

```ts
import './settings.css'
import type { SettingsView } from '../shared/ipc'
import { NOTIFICATION_CASES, NOTIFICATION_CHANNELS, type SettingKey, type SettingValue } from '../shared/settings-keys'
import type { NotificationCase, NotificationChannels } from '../shared/types'
import { checkNumber, checkText, CUSTOM_THEME, profileOptions, profileValue, soundChoice, themeOptions, type Checked, type Option } from './settings-form'

const ct = window.ct

const CASE_LABELS: Record<NotificationCase, string> = {
  permission: 'Claude asks for permission',
  question: 'Claude asks a question',
  done: 'Claude finished its answer',
  bell: 'Terminal bell (BEL)'
}
const CHANNEL_LABELS: Record<keyof NotificationChannels, string> = { sound: 'Sound', flash: 'Taskbar flash', tab: 'Tab highlight' }

/** one control: shows its part of the view; its inputs are disabled while settings.json is locked */
interface Control {
  inputs: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[]
  show(view: SettingsView): void
}

type ShowError = (message: string | null) => void

const controls: Control[] = []
let view: SettingsView

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

const showAll = (): void => { for (const c of controls) c.show(view) }

/** saves one setting; on failure the message goes under the field and the controls go back to the saved values */
async function save(key: SettingKey, value: SettingValue, error: ShowError): Promise<boolean> {
  const r = await ct.setSetting(key, value)
  error(r.ok ? null : r.error)
  if (!r.ok) showAll()
  return r.ok
}

/** a labelled row with an error line under it */
function field(label: string, ...content: (Node | string)[]): { row: HTMLElement; error: ShowError } {
  const message = el('div', { className: 'field-error', hidden: true })
  const row = el('div', { className: 'field' }, el('span', { className: 'field-label', textContent: label }), el('div', { className: 'field-input' }, ...content), message)
  return {
    row,
    error: (m) => {
      message.hidden = m === null
      message.textContent = m ?? ''
    }
  }
}

function textField(label: string, key: SettingKey, type: 'text' | 'number', get: (v: SettingsView) => string | number, check: (text: string) => Checked<SettingValue>, hint?: string): HTMLElement {
  const input = el('input', { type, spellcheck: false, className: 'text-input' })
  input.dataset.key = key
  const f = field(label, input, ...(hint ? [el('span', { className: 'hint', textContent: hint })] : []))
  const error: ShowError = (m) => {
    f.error(m)
    input.classList.toggle('invalid', m !== null)
  }
  // change fires on Enter and when the field loses focus
  input.addEventListener('change', () => {
    const c = check(input.value)
    if (c.ok) void save(key, c.value, error)
    else error(c.error)
  })
  controls.push({
    inputs: [input],
    show: (v) => {
      // the field being typed in keeps what is typed
      if (document.activeElement === input) return
      input.value = String(get(v))
      error(null)
    }
  })
  return f.row
}

function selectField(label: string, key: SettingKey, options: (v: SettingsView) => { options: Option[]; selected: string }, toValue: (s: string) => SettingValue | undefined, hint?: string): HTMLElement {
  const select = el('select')
  select.dataset.key = key
  const f = field(label, select, ...(hint ? [el('span', { className: 'hint', textContent: hint })] : []))
  select.addEventListener('change', () => {
    const value = toValue(select.value)
    if (value !== undefined) void save(key, value, f.error)
  })
  controls.push({
    inputs: [select],
    show: (v) => {
      const o = options(v)
      select.replaceChildren(...o.options.map((x) => el('option', { value: x.value, textContent: x.label })))
      select.value = o.selected
    }
  })
  return f.row
}

function checkbox(key: SettingKey, get: (v: SettingsView) => boolean, error: ShowError, label: string): HTMLInputElement {
  const box = el('input', { type: 'checkbox', title: label })
  box.dataset.key = key
  box.setAttribute('aria-label', label)
  box.addEventListener('change', () => void save(key, box.checked, error))
  controls.push({ inputs: [box], show: (v) => { box.checked = get(v) } })
  return box
}

function checkboxField(key: SettingKey, label: string, get: (v: SettingsView) => boolean): HTMLElement {
  const message = el('div', { className: 'field-error', hidden: true })
  const error: ShowError = (m) => {
    message.hidden = m === null
    message.textContent = m ?? ''
  }
  return el('div', { className: 'check-field' }, el('label', { className: 'check' }, checkbox(key, get, error, label), ` ${label}`), message)
}

function notificationTable(): HTMLElement {
  const message = el('div', { className: 'field-error', hidden: true })
  const error: ShowError = (m) => {
    message.hidden = m === null
    message.textContent = m ?? ''
  }
  const head = el('tr', {}, el('th'), ...NOTIFICATION_CHANNELS.map((ch) => el('th', { textContent: CHANNEL_LABELS[ch] })))
  const rows = NOTIFICATION_CASES.map((c) =>
    el('tr', {},
      el('th', { scope: 'row', textContent: CASE_LABELS[c] }),
      ...NOTIFICATION_CHANNELS.map((ch) => el('td', {}, checkbox(`notifications.${c}.${ch}`, (v) => v.settings.notifications[c][ch], error, `${CASE_LABELS[c]}: ${CHANNEL_LABELS[ch]}`)))
    )
  )
  return el('div', {}, el('table', { className: 'notify' }, el('thead', {}, head), el('tbody', {}, ...rows)), message)
}

function soundField(): HTMLElement {
  const system = el('input', { type: 'radio', name: 'sound', value: 'system' })
  const custom = el('input', { type: 'radio', name: 'sound', value: 'custom' })
  system.dataset.key = 'notifications.sound'
  custom.dataset.key = 'notifications.sound'
  const path = el('input', { type: 'text', readOnly: true, className: 'text-input sound-path', tabIndex: -1 })
  const browse = el('button', { type: 'button', textContent: 'Browse…' })
  const play = el('button', { type: 'button', textContent: '▶ Play' })
  const f = field('Sound', el('label', {}, system, ' Windows default'), el('label', {}, custom, ' Custom .wav'), path, browse, play)
  const pick = async (): Promise<void> => {
    const file = await ct.pickSound()
    if (file) await save('notifications.sound', file, f.error)
    // cancelled: the radio buttons go back to the sound in use
    else showAll()
  }
  system.addEventListener('change', () => void save('notifications.sound', 'system', f.error))
  custom.addEventListener('change', () => void pick())
  browse.addEventListener('click', () => void pick())
  play.addEventListener('click', () => ct.playSound())
  controls.push({
    inputs: [system, custom, browse, play],
    show: (v) => {
      const s = soundChoice(v.settings.notifications.sound)
      system.checked = !s.custom
      custom.checked = s.custom
      path.value = s.path
    }
  })
  return f.row
}

function section(title: string, note: string | null, ...content: HTMLElement[]): HTMLElement {
  const h = el('h2', { className: 'section-title' }, title, ...(note ? [el('span', { className: 'section-note', textContent: note })] : []))
  return el('section', {}, h, ...content)
}

const openFile = (): HTMLButtonElement => {
  const b = el('button', { type: 'button', textContent: 'Open settings.json' })
  b.addEventListener('click', () => ct.openSettingsFile())
  return b
}

const bannerText = el('span')
const banner = el('div', { className: 'settings-banner', hidden: true }, bannerText, openFile())
const notice = el('div', { className: 'settings-notice', hidden: true })

const automaticHint = '(PowerShell 7 if installed, else Windows PowerShell)'
const root = document.getElementById('settings')!
root.append(
  el('h1', { className: 'settings-heading', textContent: 'Settings' }),
  banner,
  notice,
  section('Notifications', 'when a tab you are not looking at needs you', notificationTable(), soundField()),
  section('Appearance', null,
    textField('Font', 'font.family', 'text', (v) => v.settings.font.family, checkText),
    textField('Size', 'font.size', 'number', (v) => v.settings.font.size, (t) => checkNumber('font.size', t)),
    selectField('Theme', 'theme', (v) => themeOptions(v.settings.theme), (s) => (s === CUSTOM_THEME ? undefined : s)),
    textField('Scrollback lines', 'scrollback', 'number', (v) => v.settings.scrollback, (t) => checkNumber('scrollback', t), 'applies to new tabs')),
  section('Shells', null,
    selectField('Default shell', 'defaultProfile', (v) => profileOptions(v.profiles, v.settings.defaultProfile), profileValue, automaticHint)),
  section('Claude Code', 'applies to new tabs',
    textField('Command', 'claude.command', 'text', (v) => v.settings.claude.command, checkText),
    selectField('Shell for Claude tabs', 'claude.shellProfile', (v) => profileOptions(v.profiles, v.settings.claude.shellProfile), profileValue)),
  section('Images', 'applies to new tabs',
    checkboxField('imageWatch.enabled', 'Watch Claude tab folders for new images', (v) => v.settings.imageWatch.enabled),
    checkboxField('imagePanel.autoOpen', 'Open the image panel when a new image arrives', (v) => v.settings.imagePanel.autoOpen)),
  section('Updates', null,
    checkboxField('autoUpdate', 'Check for updates automatically', (v) => v.settings.autoUpdate)),
  el('footer', { className: 'settings-footer' }, el('span', { textContent: 'Profiles, image types, ignored folders, a custom theme and the image panel size are set in settings.json' }), openFile())
)

function render(v: SettingsView): void {
  view = v
  banner.hidden = !v.locked
  bannerText.textContent = `settings.json can't be used: ${v.problems.map((p) => p.replace(/^settings\.json: /, '')).join(' ')}`
  notice.hidden = v.locked || v.problems.length === 0
  notice.replaceChildren(...v.problems.map((p) => el('div', { textContent: p })))
  for (const c of controls) for (const i of c.inputs) i.disabled = v.locked
  showAll()
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close()
})

ct.onSettingsView(render)
void ct.getSettingsView().then(render)
```

Append to `src/renderer/settings.css`:

```css
.settings-banner { display: flex; align-items: center; gap: 10px; margin: 8px 0; padding: 8px 12px; background: #2a211d; border: 1px solid var(--accent); border-radius: 6px; }
.settings-banner span { flex: 1; }
.settings-notice { margin: 8px 0; padding: 8px 12px; color: #e5c07b; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
section { margin-top: 18px; }
.section-title { margin: 0 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.section-note { margin-left: 10px; font-weight: 400; text-transform: none; letter-spacing: 0; }
.field { display: grid; grid-template-columns: 170px 1fr; align-items: center; gap: 4px 12px; margin: 6px 0; }
.field-label { color: var(--fg); }
.field-input { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.field-error { grid-column: 2; color: #e06c75; font-size: 12px; }
.check-field { margin: 6px 0; }
.check-field .field-error { margin-left: 24px; }
.hint { color: var(--muted); font-size: 12px; }
.text-input, select { min-width: 0; padding: 4px 6px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font: inherit; outline: none; }
.text-input:focus, select:focus { border-color: var(--accent); }
.text-input.invalid { border-color: #e06c75; }
input[type="text"].text-input { width: 300px; }
input[type="number"].text-input { width: 100px; }
.sound-path { flex: 1; color: var(--muted); }
button { padding: 4px 12px; background: var(--chrome-2); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font: inherit; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }
.notify { border-collapse: collapse; margin: 4px 0 8px; }
.notify th, .notify td { padding: 4px 10px; }
.notify thead th { color: var(--muted); font-weight: 400; font-size: 12px; }
.notify tbody th { text-align: left; font-weight: 400; padding-left: 0; }
.notify td { text-align: center; }
.settings-footer { display: flex; align-items: center; gap: 12px; margin-top: 22px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.settings-footer span { flex: 1; }
```

- [ ] **Step 7: Typecheck, unit tests, build and the e2e**

Run: `npm run typecheck; npx vitest run; npm run build; npx playwright test tests/e2e/settings.spec.ts`
Expected: no type errors; all unit tests pass; all 16 settings e2e tests pass.

- [ ] **Step 8: Look at the window**

Run `npm run build`, then a scratch Playwright script (in the session scratchpad, not the repo) that launches the app with a temporary data folder, opens the window and saves a screenshot; read the screenshot. Expected: the layout of the spec's sketch, dark native controls, nothing cut off at 640×720, the notifications table aligned.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/settings-form.ts src/renderer/settings-page.ts src/renderer/settings.css src/renderer/main.ts src/renderer/env.d.ts tests/unit/settings-form.test.ts tests/e2e/settings.spec.ts
git commit -m "feat: the settings form: notifications per case, appearance, shells, Claude Code, images, updates"
```

---

### Task 5: README and the screenshot

**Files:**
- Modify: `README.md`, `tests/screenshots/readme.shots.ts`
- Create: `docs/images/settings.png` (generated)

**Interfaces:**
- Consumes: the settings window (Tasks 3–4), `CtApi.openSettingsWindow` (Task 3).

- [ ] **Step 1: The screenshot test**

Append to `tests/screenshots/readme.shots.ts`:

```ts
test('settings window screenshot', async () => {
  // default settings in a fresh data folder: nothing from this machine's own settings
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const [win] = await Promise.all([app.waitForEvent('window'), page.evaluate(() => window.ct.openSettingsWindow())])
  await win.waitForSelector('#settings [data-key="font.size"]')
  const cdp = await win.context().newCDPSession(win)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 2, mobile: false })
  await expect(win.locator('[data-key="font.family"]')).toHaveValue('Cascadia Mono, Consolas, monospace')
  await win.mouse.move(630, 710)
  await win.screenshot({ path: join(OUT, 'settings.png') })
  await app.close()
})
```

- [ ] **Step 2: Generate and look at it**

Run: `npm run screenshots`
Expected: both screenshot tests pass; `docs/images/settings.png` exists; reading it shows the whole form with default values and no path from this machine; `new-tab-menu.png` now shows `Settings…`.

- [ ] **Step 3: The README**

In `README.md`:
- the notifications paragraph (starts `When Claude asks for a permission`) becomes:

```markdown
When Claude asks for a permission, asks you a question or finishes its turn while you are looking elsewhere, ClaudeTerm plays the Windows default sound, flashes its taskbar button and marks the tab. Nothing happens while that tab is in front of you. In **Settings** each of these cases — and a terminal bell from any program — has its own sound, taskbar flash and tab highlight switches, and the sound can be your own `.wav`.
```

- the `## Settings` section's first paragraph becomes:

```markdown
Press `Ctrl+,` (or **▾ → Settings…**) to open the settings window: notifications, font, theme, shells, Claude Code, images and updates. Changes apply at once.

![Settings window](docs/images/settings.png)

Everything is stored in `%APPDATA%\ClaudeTerm\settings.json`. Profiles, image types, ignored folders, a custom theme and the image panel size are set only there — the window's **Open settings.json** button opens it, and changes to the file apply as soon as you save it. When the window saves a change, it rewrites the file as plain JSON with two-space indentation.
```

- in the JSON block replace the `attention` entry with:

```jsonc
  "notifications": {               // when a tab you are not looking at needs you
    "sound": "system",             // "system" or the full path to a .wav file
    "permission": { "sound": true,  "flash": true, "tab": true },   // Claude asks for a permission
    "question":   { "sound": true,  "flash": true, "tab": true },   // Claude asks a question
    "done":       { "sound": true,  "flash": true, "tab": true },   // Claude finished its turn
    "bell":       { "sound": false, "flash": true, "tab": true }    // a terminal bell (BEL) from any program
  },                               // flash: the taskbar button; tab: highlight the tab (a dot for the bell)
```

- [ ] **Step 4: Check the README renders sensibly**

Run: `git diff --stat README.md docs/images` and read the changed README section.
Expected: the paragraph, the image link and the JSON block as above; the old `attention` keys are gone from the README.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/screenshots/readme.shots.ts docs/images
git commit -m "docs: settings window in the README, with a screenshot from default settings"
```
