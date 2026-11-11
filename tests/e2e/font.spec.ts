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

test('the interface is set in the bundled Inter and a new install\'s terminal uses Graphite', async () => {
  const { app, page } = await launchApp()
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"Inter Variable"/)
  // load() resolves with the faces that match; an empty list means no bundled face was declared
  expect(await page.evaluate(async () => {
    const faces = await document.fonts.load('13px "Inter Variable"')
    return faces.length > 0 && faces.every((f) => f.status === 'loaded')
  })).toBe(true)
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(await page.evaluate(() => window.__ct!.themeBackground!())).toBe('#0E0E10')
  await app.close()
})

test('an install that was on Campbell starts on Graphite', async () => {
  const { app, page } = await launchApp({ settings: { theme: 'Campbell' } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(await page.evaluate(() => window.__ct!.themeBackground!())).toBe('#0E0E10')
  await app.close()
})

test('a font.size from settings.json is converted from points to pixels', async () => {
  const { app, page } = await launchApp({ settings: { font: { size: 9 } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  expect(await renderedFontSize(page)).toBe('12px')
  await app.close()
})

test('every Inter face is loaded once the window is up, so a tab title in another script does not swap its font later', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  // Inter is split by script (Latin, Cyrillic, Greek, Vietnamese, each with its extension): a face that is still unloaded
  // would be fetched the first time a tab's text needs it, and the text would be drawn in the fallback font until then
  const pending = await page.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Inter Variable' && f.status !== 'loaded').length)
  expect(pending).toBe(0)
  await app.close()
})
