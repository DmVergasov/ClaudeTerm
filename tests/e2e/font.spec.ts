import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './helpers'

// e2e runs the DOM renderer, which puts the xterm font size on .xterm-rows
function renderedFontSize(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.terminal-host:not([style*="none"]) .xterm-rows')!).fontSize)
}

test('font.size is in points like Windows Terminal: the default 12pt renders at 16px', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(await renderedFontSize(page)).toBe('16px')
  await app.close()
})

test('a font.size from settings.json is converted from points to pixels', async () => {
  const { app, page } = await launchApp({ settings: { font: { size: 9 } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(await renderedFontSize(page)).toBe('12px')
  await app.close()
})
