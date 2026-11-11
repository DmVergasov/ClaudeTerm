import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { StatusMessage } from '../../src/shared/protocol'
import { DEFAULT_TEST_PATTERNS } from '../../src/shared/test-files'
import { MAC, WIN } from '../fixtures/platform'
import { FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, TEST_SHELL, windowPlaces, KEYS } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

const QUIET = { ...FAKE_CLAUDE_SETTINGS, attention: { sound: 'none', flash: false } }

// e2e runs the DOM renderer, which puts the xterm font size on .xterm-rows
function renderedFontSize(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.terminal-host:not([style*="none"]) .xterm-rows')!).fontSize)
}

const readSettings = (dataDir: string): Record<string, any> => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))

/** the statusLine of the settings file Claude tabs start claude with */
const tabStatusLine = (dataDir: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(dataDir, 'claude-tab-settings.json'), 'utf8')) as { statusLine: Record<string, unknown> }).statusLine

/** Ctrl+, in the main window; returns the settings window once its page is up */
async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  await page.locator('.terminal-host:visible .xterm').click()
  const [win] = await Promise.all([app.waitForEvent('window'), page.keyboard.press(KEYS.settings)])
  await win.waitForSelector('#settings .section-title')
  return win
}

test('setSetting writes settings.json, keeps the other keys and applies at once', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { ...QUIET, myNote: 'keep' } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(await page.evaluate(() => window.ct.setSetting('font.size', 9))).toEqual({ ok: true })
  expect(readSettings(dataDir)).toMatchObject({ myNote: 'keep', font: { size: 9 }, attention: { sound: 'none' } })
  await expect.poll(() => renderedFontSize(page)).toBe('12px')
  const view = await page.evaluate(() => window.ct.getSettingsView())
  expect(view).toMatchObject({ path: join(dataDir, 'settings.json'), problems: [], locked: false })
  expect(view.settings.font.size).toBe(9)
  expect(view.profiles).toContain(TEST_SHELL)
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
  expect(file.notifications.permission).toEqual({ sound: false, flash: false, tab: true, front: false, banner: false })
  expect(file.notifications.done).toEqual({ sound: false, flash: false, tab: false, front: false, banner: false })
  await app.close()
})

test('zoom survives a change to another setting; a font change resets it', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.zoomIn)
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

test('Ctrl+, opens one settings window; Esc closes it', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  expect(await win.title()).toBe('ClaudeTerm Settings')
  await page.keyboard.press(KEYS.settings)
  await page.waitForTimeout(500)
  expect(app.windows()).toHaveLength(2)
  // a test run shows both windows off the screen (macOS keeps them on one), and bringing the open one forward does not
  // take the focus
  expect(await windowPlaces(app)).toEqual([{ onScreen: MAC, focused: false }, { onScreen: MAC, focused: false }])
  const closed = win.waitForEvent('close')
  // the window is gone before the key comes back up, which fails the press itself; the close event is the check
  await win.keyboard.press('Escape').catch(() => {})
  await closed
  expect(app.windows()).toHaveLength(1)
  await app.close()
})

test('the ▾ menu opens the settings window', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await page.locator('.tab-menu').click()
  const [win] = await Promise.all([app.waitForEvent('window'), page.locator('.menu-item', { hasText: 'Settings…' }).click()])
  await expect(win.locator('#settings-titlebar')).toHaveText('Settings')
  await app.close()
})

test('closing the main window with settings open ends the app', { tag: '@alone' }, async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await openSettings(app, page)
  const closed = app.waitForEvent('close')
  const started = Date.now()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)?.close() }).catch(() => {})
  await closed
  expect(Date.now() - started).toBeLessThan(5000)
})

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

test('the auto-continue checkbox saves to settings.json and a cut-off response then goes on without marking the tab', async () => {
  const { app, page, tabId, work, pipeName, dataDir } = await launchClaudeTab(QUIET)
  const win = await openSettings(app, page)
  const box = win.locator('[data-key="claude.autoContinue"]')
  await expect(box).not.toBeChecked()
  await box.check()
  await expect.poll(() => readSettings(dataDir).claude?.autoContinue).toBe(true)
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', error: 'server_error' })).toEqual({ ok: true })
  await page.waitForTimeout(300)
  await expect(page.locator(`[data-tab-id="${tabId}"]`)).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('the checkbox for going on after a restore is checked by default and saves to settings.json', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const box = win.locator('[data-key="claude.continueAfterRestore"]')
  await expect(box).toBeChecked()
  await box.uncheck()
  await expect.poll(() => readSettings(dataDir).claude?.continueAfterRestore).toBe(false)
  await app.close()
})

test('the limit pace checkbox is checked by default; cleared, the limits in the status bar lose their bar and their color by pace', async () => {
  const { app, page, tabId, pipeName, dataDir } = await launchClaudeTab(QUIET)
  const now = Math.floor(Date.now() / 1000)
  // half the 5h limit in its first hour: at this pace it runs out long before the reset
  const status: StatusMessage = {
    v: 1, type: 'status', tabId, sessionId: SID, model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null,
    fiveHour: { usedPct: 50, resetsAt: now + 4 * 3600 }, sevenDay: null
  }
  expect(await sendPipeMessage(pipeName, status)).toEqual({ ok: true })
  const limit = page.locator('#titlebar .meter-limit')
  /** the meter's bar: none when the title bar draws no bar */
  const bar = limit.locator('.meter-bar')
  await expect(limit.locator('.meter-pct')).toHaveText('50%')
  await expect(limit).toHaveClass(/\bcrit\b/)
  await expect(bar).toHaveCount(1)

  const win = await openSettings(app, page)
  const box = win.locator('[data-key="claude.limitPace"]')
  await expect(box).toBeChecked()
  await box.uncheck()
  await expect.poll(() => readSettings(dataDir).claude?.limitPace).toBe(false)
  await expect(limit).not.toHaveClass(/\b(warn|crit)\b/)
  await expect(bar).toHaveCount(0)
  // the reset alone, with no forecast after it
  await expect(limit).toHaveAttribute('title', /^resets at \d\d:\d\d, in [^\n]+$/)
  await app.close()
})

test('cleared, the background work checkbox leaves a turn that ends with background work unmarked; the turn after it is marked', async () => {
  const { app, page, tabId, work, pipeName, dataDir } = await launchClaudeTab(QUIET)
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)
  const win = await openSettings(app, page)
  const box = win.locator('[data-key="notifications.doneWithBackgroundWork"]')
  await expect(box).toBeChecked()
  await box.uncheck()
  await expect.poll(() => readSettings(dataDir).notifications?.doneWithBackgroundWork).toBe(false)
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', background: true })).toEqual({ ok: true })
  // the mark would arrive right after the pipe answer; give it time to show up if it were sent
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await app.close()
})

test('the Notifications table has a row for a turn another session started, after the finished answer, with every box off; its boxes save', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await expect(win.locator('table.notify tbody th')).toHaveText([
    'Claude asks for permission', 'Claude asks a question', 'Claude finished its answer',
    'Claude finished a turn another session started with a message', 'Terminal bell (BEL)'
  ])
  const tab = win.locator('[data-key="notifications.peer.tab"]')
  await expect(tab).not.toBeChecked()
  await tab.check()
  await expect.poll(() => readSettings(dataDir).notifications?.peer?.tab).toBe(true)
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

test('the Default folder field saves an absolute folder, refuses a relative one and, emptied, goes back to the home folder', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ct-folder-'))
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const field = win.locator('[data-key="defaultFolder"]')
  await field.fill(folder)
  await field.press('Enter')
  await expect.poll(() => readSettings(dataDir).defaultFolder).toBe(folder)
  await field.fill('project')
  await field.press('Enter')
  await expect(win.locator('.field-error', { hasText: 'Invalid value for defaultFolder' })).toBeVisible()
  expect(readSettings(dataDir).defaultFolder).toBe(folder)
  await field.fill('')
  await field.press('Enter')
  await expect.poll(() => readSettings(dataDir).defaultFolder).toBeNull()
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

test('the status bar refresh in the Claude Code section sets how often new Claude tabs refresh it, or turns the timer off', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(tabStatusLine(dataDir).refreshInterval).toBe(5)
  const win = await openSettings(app, page)
  const timer = win.locator('[data-key="claude.statusRefresh"]')
  const interval = win.locator('[data-key="claude.statusRefreshInterval"]')
  await expect(timer).toBeChecked()
  await expect(interval).toHaveValue('5')
  await interval.fill('30')
  await interval.press('Enter')
  await expect.poll(() => readSettings(dataDir).claude?.statusRefreshInterval).toBe(30)
  await expect.poll(() => tabStatusLine(dataDir).refreshInterval).toBe(30)
  await interval.fill('0')
  await interval.press('Enter')
  await expect(win.locator('.field-error', { hasText: 'A whole number between 1 and 300' })).toBeVisible()
  expect(readSettings(dataDir).claude.statusRefreshInterval).toBe(30)
  await timer.uncheck()
  await expect.poll(() => readSettings(dataDir).claude?.statusRefresh).toBe(false)
  await expect.poll(() => 'refreshInterval' in tabStatusLine(dataDir)).toBe(false)
  expect(tabStatusLine(dataDir).command).toEqual(expect.stringContaining('status'))
  await app.close()
})

test('a status bar refresh set in settings.json is in the settings file Claude tabs start with', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { ...QUIET, claude: { ...QUIET.claude, statusRefreshInterval: 60 } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(tabStatusLine(dataDir).refreshInterval).toBe(60)
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...QUIET, claude: { ...QUIET.claude, statusRefresh: false } }))
  await expect.poll(() => 'refreshInterval' in tabStatusLine(dataDir)).toBe(false)
  await app.close()
})

test('a custom theme, an unknown profile and invalid values in the file are shown as they are', async () => {
  const { app, page } = await launchApp({ settings: { ...QUIET, theme: { background: '#101010' }, claude: { ...QUIET.claude, shellProfile: 'Gone Shell' }, scrollback: -5 } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await expect(win.locator('[data-key="theme"] option:checked')).toHaveText('Custom (settings.json)')
  await expect(win.locator('[data-key="claude.shellProfile"] option:checked')).toHaveText('Gone Shell (not found)')
  await expect(win.locator('[data-key="defaultProfile"] option:checked')).toHaveText(TEST_SHELL)
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

test('a save from the app reloads once; the watcher does not reload the same file again, a hand edit after it still does', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await page.evaluate(() => {
    ;(window as unknown as { views: number }).views = 0
    window.ct.onSettingsView(() => { (window as unknown as { views: number }).views++ })
  })
  const views = (): Promise<number> => page.evaluate(() => (window as unknown as { views: number }).views)
  expect(await page.evaluate(() => window.ct.setSetting('autoUpdate', false))).toEqual({ ok: true })
  await page.waitForTimeout(1000)
  expect(await views()).toBe(1)
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...QUIET, scrollback: 777 }))
  await expect.poll(() => page.evaluate(() => window.ct.getSettingsView().then((v) => v.settings.scrollback))).toBe(777)
  expect(await views()).toBe(2)
  await app.close()
})

test('a save that cannot be written shows its error under the field, also when the field was left with Tab', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const file = join(dataDir, 'settings.json')
  chmodSync(file, 0o444)
  try {
    const font = win.locator('[data-key="font.family"]')
    await font.fill('Consolas')
    await font.press('Tab')
    await expect(win.locator('.field-error', { hasText: 'Cannot save settings.json' })).toBeVisible()
    await expect(font).toHaveClass(/\binvalid\b/)
  } finally {
    chmodSync(file, 0o666)
  }
  await app.close()
})

test('Hide test files and the Test files field save to settings.json; Restore defaults puts the default list back', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const hide = win.locator('[data-key="review.hideTests"]')
  const patterns = win.locator('[data-key="review.testPatterns"]')
  await expect(hide).not.toBeChecked()
  await expect(patterns).toHaveValue(DEFAULT_TEST_PATTERNS.join('\n'))
  await expect(win.locator('.hint', { hasText: 'One pattern per line, matched against the path inside the project: * and ? within a name, ** across folders; a pattern without / matches the file name in any folder. Case-sensitive.' })).toBeVisible()
  await hide.check()
  await expect.poll(() => readSettings(dataDir).review?.hideTests).toBe(true)
  await patterns.fill('**/mytests/**\n\n  *.check.*  \n')
  await patterns.blur()
  await expect.poll(() => readSettings(dataDir).review?.testPatterns).toEqual(['**/mytests/**', '*.check.*'])
  await win.locator('[data-restore="review.testPatterns"]').click()
  await expect.poll(() => readSettings(dataDir).review?.testPatterns).toEqual([...DEFAULT_TEST_PATTERNS])
  await expect(patterns).toHaveValue(DEFAULT_TEST_PATTERNS.join('\n'))
  // an empty field means no file counts as a test
  await patterns.fill('')
  await patterns.blur()
  await expect.poll(() => readSettings(dataDir).review?.testPatterns).toEqual([])
  await app.close()
})

test('Show Markdown files formatted is on by default and saves to settings.json', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const render = win.locator('[data-key="review.renderMarkdown"]')
  await expect(win.locator('label', { has: render })).toContainText('Show Markdown files formatted')
  await expect(render).toBeChecked()
  await render.uncheck()
  await expect.poll(() => readSettings(dataDir).review?.renderMarkdown).toBe(false)
  await app.close()
})

test('the Test files field refuses more than 200 patterns and keeps the saved list', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { ...QUIET, review: { testPatterns: ['keep/**'] } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const patterns = win.locator('[data-key="review.testPatterns"]')
  await expect(patterns).toHaveValue('keep/**')
  await patterns.fill(Array(201).fill('a').join('\n'))
  await patterns.blur()
  await expect(win.locator('.field-error', { hasText: 'At most 200 patterns' })).toBeVisible()
  expect(readSettings(dataDir).review?.testPatterns).toEqual(['keep/**'])
  await app.close()
})

test("on Windows the console host select shows the bundled ConPTY by default and saves Windows' own to settings.json; elsewhere it is not there", async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const select = win.locator('[data-key="conpty"]')
  if (!WIN) {
    await expect(select).toHaveCount(0)
    await app.close()
    return
  }
  await expect(select).toHaveValue('bundled')
  await select.selectOption('system')
  await expect.poll(() => readSettings(dataDir).conpty).toBe('system')
  await app.close()
})

test('the Agent messages section holds its two checkboxes, both on, and turning one off saves it', async () => {
  const { app, page, dataDir } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const titles = await win.locator('#settings .section-title').evaluateAll((hs) => hs.map((h) => h.childNodes[0].textContent))
  expect(titles.indexOf('Agent messages')).toBe(titles.indexOf('Devices') + 1)
  const enabled = win.locator('[data-key="agentMessages.enabled"]')
  const marks = win.locator('[data-key="agentMessages.marks"]')
  await expect(enabled).toBeChecked()
  await expect(marks).toBeChecked()
  await expect(win.getByText("Agents use SendMessage first. ClaudeTerm carries a message only to a tab SendMessage doesn't list: another device, another account.")).toBeVisible()
  await expect(win.getByText('An envelope on the tab and a counter; no sound, no pop-up.')).toBeVisible()
  await enabled.uncheck()
  await expect.poll(() => readSettings(dataDir).agentMessages?.enabled).toBe(false)
  await app.close()
})

test('the settings window has its own title bar that drags the window', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  const bar = win.locator('#settings-titlebar')
  await expect(bar).toHaveText('Settings')
  expect(await bar.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('drag')
  const box = (await bar.boundingBox())!
  expect(Math.round(box.height)).toBe(36)
  expect(box.y).toBe(0)
  expect(await win.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('"Inter Variable"')
  await app.close()
})

test('the settings title bar stays at the top while the page scrolls, and the page itself never scrolls', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  // the page scrolls inside #settings, below the bar: the window's buttons sit over the bar, not over the scrollbar
  await win.evaluate(() => { document.getElementById('settings')!.scrollTop = 1e6 })
  await expect.poll(() => win.evaluate(() => document.getElementById('settings')!.scrollTop)).toBeGreaterThan(0)
  const box = (await win.locator('#settings-titlebar').boundingBox())!
  expect(box.y).toBe(0)
  expect((await win.locator('#settings').boundingBox())!.y).toBeGreaterThanOrEqual(36)
  expect(await win.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)
  await app.close()
})

test('the Theme list starts with Graphite, the default', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  expect(await win.locator('[data-key="theme"] option').first().getAttribute('value')).toBe('Graphite')
  await app.close()
})

test('PageDown scrolls Settings without a click first', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  await win.keyboard.press('PageDown')
  await expect.poll(() => win.evaluate(() => document.getElementById('settings')!.scrollTop)).toBeGreaterThan(0)
  await app.close()
})
