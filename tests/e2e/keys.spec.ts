import { test } from '@playwright/test'
import { FAKE_CLAUDE_SETTINGS, launchApp } from './helpers'

test('Ctrl+Shift+T opens, Ctrl+Tab cycles, Ctrl+Shift+W closes', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const first = await page.evaluate(() => window.__ct!.activeTabId())
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyT')
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.waitForFunction((id) => window.__ct!.activeTabId() !== id, first)
  await page.keyboard.press('Control+Tab')
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
  await page.keyboard.press('Control+Shift+KeyW')
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await app.close()
})
