import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

const QUIET = { ...FAKE_CLAUDE_SETTINGS, attention: { sound: 'none', flash: false } }

// e2e runs the DOM renderer, which puts the xterm font size on .xterm-rows
function renderedFontSize(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.terminal-host:not([style*="none"]) .xterm-rows')!).fontSize)
}

const readSettings = (dataDir: string): Record<string, any> => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))

/** Ctrl+, in the main window; returns the settings window once its page is up */
async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  await page.locator('.terminal-host:visible .xterm').click()
  const [win] = await Promise.all([app.waitForEvent('window'), page.keyboard.press('Control+Comma')])
  await win.waitForSelector('#settings .settings-heading')
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

test('Ctrl+, opens one settings window; Esc closes it', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const win = await openSettings(app, page)
  expect(await win.title()).toBe('ClaudeTerm Settings')
  await page.keyboard.press('Control+Comma')
  await page.waitForTimeout(500)
  expect(app.windows()).toHaveLength(2)
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
