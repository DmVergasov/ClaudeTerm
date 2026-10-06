import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_CLAUDE_SETTINGS, launchApp } from './helpers'

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
