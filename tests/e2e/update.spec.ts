import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir, TEST_SHELL } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'

test('after restarting into an update the tabs come back without asking', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    tabs: [
      { kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'one', claudeSessionId: SID },
      { kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'two', claudeSessionId: SID2 }
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

test('after restarting into an update a session of shell tabs comes back too', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    tabs: [
      { kind: 'shell', profile: TEST_SHELL, cwd: work, title: 'build', claudeSessionId: null },
      { kind: 'shell', profile: TEST_SHELL, cwd: work, title: 'logs', claudeSessionId: null }
    ]
  }))
  writeFileSync(join(dataDir, 'update-restart.json'), JSON.stringify({ at: Date.now() }))
  const { app, page } = await launchApp({ dataDir })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expect(page.locator('.tab', { hasText: 'build' })).toBeVisible()
  await expect(page.locator('.tab', { hasText: 'logs' })).toBeVisible()
  expect(await page.evaluate(() => window.__ct!.restoreVisible!())).toBe(false)
  await app.close()
})

const ready = (version: string, notes: { version: string; items: { title: string; text: string }[] }[] = []) => ({ status: 'ready', version, notes })
const NOTES = [
  { version: '9.9.9', items: [{ title: 'Find in the Changes panel', text: 'Find in the Changes panel. Click into the diff and press Ctrl+F.' }] },
  {
    version: '9.9.8',
    items: [
      { title: 'Hide test files', text: 'Hide test files. Tick Hide tests in the Changes panel.' },
      { title: 'Star your important sessions', text: 'Star your important sessions. Starred ones stay at the top.' }
    ]
  }
]

test('What\'s new in the update banner lists what changed by version; Esc, the button again or a click elsewhere closes it', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('ev:update', s), ready('9.9.9', NOTES))
  const button = page.locator('#update-banner .banner-notes')
  const list = page.locator('#update-banner .update-notes')
  await expect(button).toHaveText("What's new ▾")
  await expect(list).toBeHidden()
  await button.click()
  await expect(list.locator('.update-notes-version')).toHaveText(['9.9.9', '9.9.8'])
  await expect(list.locator('li')).toHaveText(['Find in the Changes panel', 'Hide test files', 'Star your important sessions'])
  await expect(list.locator('li').first()).toHaveAttribute('title', 'Find in the Changes panel. Click into the diff and press Ctrl+F.')
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await button.click()
  await expect(list).toBeVisible()
  await button.click()
  await expect(list).toBeHidden()
  await button.click()
  await page.locator('.terminal-host:visible .xterm').click()
  await expect(list).toBeHidden()
  await app.close()
})

test('the Esc that closes What\'s new does not reach the terminal, where it would interrupt Claude', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('ev:update', s), ready('9.9.9', NOTES))
  await page.locator('.terminal-host:visible .xterm').click()
  const keys: string[] = []
  await page.exposeFunction('__keySeen', (k: string) => { keys.push(k) })
  // the terminal's own input: a key that reaches it goes to the shell. xterm listens in the capture phase and stops the
  // event there, so a listener of the bubble phase would never hear it
  await page.locator('.terminal-host:visible .xterm textarea').evaluate((el) => el.addEventListener('keydown', (e) => (window as unknown as { __keySeen(k: string): void }).__keySeen((e as KeyboardEvent).key), true))
  await page.locator('#update-banner .banner-notes').click()
  await page.locator('.terminal-host:visible .xterm textarea').focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('#update-banner .update-notes')).toBeHidden()
  expect(keys).toEqual([])
  await app.close()
})

test('notes of one version need no version heading; a banner without notes has no What\'s new', async () => {
  const { app, page } = await launchApp()
  const push = (s: object) => app.evaluate(({ BrowserWindow }, st) => BrowserWindow.getAllWindows()[0].webContents.send('ev:update', st), s)
  await push(ready('9.9.9', NOTES.slice(0, 1)))
  await page.locator('#update-banner .banner-notes').click()
  await expect(page.locator('#update-banner .update-notes li')).toHaveText(['Find in the Changes panel'])
  await expect(page.locator('#update-banner .update-notes-version')).toHaveCount(0)
  await push(ready('9.9.10'))
  await expect(page.locator('#update-banner')).toContainText('ClaudeTerm 9.9.10 is ready to install.')
  await expect(page.locator('#update-banner .banner-notes')).toHaveCount(0)
  await app.close()
})

test('a downloaded update shows a banner whose button asks to restart into it', async () => {
  const { app, page } = await launchApp()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeAllListeners('update:install')
    ipcMain.on('update:install', () => { (globalThis as Record<string, unknown>).__installAsked = true })
  })
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('ev:update', s), ready('9.9.9'))
  const banner = page.locator('#update-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('ClaudeTerm 9.9.9 is ready to install.')
  await banner.locator('.banner-restart').click()
  await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__installAsked === true)).toBe(true)
  await app.close()
})

test('a version this copy cannot install itself (macOS) shows a banner whose Download button asks for its release page', async () => {
  const { app, page } = await launchApp()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeAllListeners('update:install')
    ipcMain.on('update:install', () => { (globalThis as Record<string, unknown>).__installAsked = true })
  })
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('ev:update', s), { status: 'available', version: '9.9.9', notes: NOTES.slice(0, 1) })
  const banner = page.locator('#update-banner')
  await expect(banner).toContainText('ClaudeTerm 9.9.9 is available.')
  await expect(banner.locator('.banner-restart')).toHaveCount(0)
  await expect(banner.locator('.banner-notes')).toHaveText("What's new ▾")
  await banner.locator('.banner-download').click()
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
  const item = page.locator('.menu-item', { hasText: `ClaudeTerm ${version} — check for updates` })
  await expect(item).toBeVisible()
  await item.click()
  await expect(page.locator('.toast', { hasText: 'Updates only work in the installed app' })).toBeVisible()
  await app.close()
})

test('checking for updates after dismissing the banner brings its Restart button back', async () => {
  const { app, page } = await launchApp()
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('ev:update', s), ready('9.9.9'))
  const banner = page.locator('#update-banner')
  await banner.locator('.banner-close').click()
  await expect(banner).toBeHidden()
  await page.locator('.tab-menu').click()
  await page.locator('.menu-item', { hasText: 'check for updates' }).click()
  await expect(banner.locator('.banner-restart')).toBeVisible()
  await app.close()
})
