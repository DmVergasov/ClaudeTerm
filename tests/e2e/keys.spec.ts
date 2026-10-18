import { expect, test } from '@playwright/test'
import { MAC } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, keepingClipboard, launchApp, KEYS, PROMPT, typeInTerminal } from './helpers'

test('Ctrl+Shift+T opens, Ctrl+Tab cycles, Ctrl+Shift+W closes (⌘T, Ctrl+Tab, ⌘W on macOS)', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const first = await page.evaluate(() => window.__ct!.activeTabId())
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.newTab)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.waitForFunction((id) => window.__ct!.activeTabId() !== id, first)
  await page.keyboard.press(KEYS.nextTab)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
  await page.keyboard.press(KEYS.closeTab)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await app.close()
})

test('the copy key copies the terminal\'s selection, the paste key pastes text', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => bufferText(page)).toMatch(PROMPT)
  await keepingClipboard(app, async () => {
    await typeInTerminal(page, 'echo copy-me-42')
    await expect.poll(() => bufferText(page)).toMatch(/^copy-me-42$/m)
    // the output line: the command line above it holds the word too. The terminal redraws its rows all the time
    // (the blinking cursor), so the word is double-clicked where it is, not as an element
    const word = (await page.locator('.terminal-host:visible .xterm-rows span', { hasText: 'copy-me-42' }).last().boundingBox())!
    await page.mouse.dblclick(word.x + word.width / 2, word.y + word.height / 2)
    await page.keyboard.press(KEYS.copy)
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('copy-me-42')
    await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted-by-key'))
    await page.keyboard.press(KEYS.paste)
    // the paste reads the clipboard through main: an Enter pressed at once could come first
    await expect.poll(() => bufferText(page)).toMatch(/echo pasted-by-key\s*$/)
    await page.keyboard.press('Enter')
    await expect.poll(() => bufferText(page)).toMatch(/^pasted-by-key$/m)
  })
  await app.close()
})

test('on macOS Ctrl keys go to the terminal: Ctrl+C interrupts, Ctrl+V reaches Claude Code as its image paste', async () => {
  test.skip(!MAC, 'macOS keys')
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => bufferText(page)).toMatch(PROMPT)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+KeyV')
  await page.keyboard.press('Control+KeyC')
  await expect.poll(() => page.evaluate(() => window.__ct!.ptyInput!())).toContain('\x16')
  await expect.poll(() => page.evaluate(() => window.__ct!.ptyInput!())).toContain('\x03')
  await app.close()
})
