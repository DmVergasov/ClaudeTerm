import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { MAC, WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, keepingClipboard, launchApp, KEYS, PNG_1x1, PROMPT, typeInTerminal } from './helpers'

/* What stands in for the PowerShell check of Claude Code's own image paste: a program that cannot start (as PowerShell
 * failing to load System.Windows.Forms in Constrained Language mode), and one that exits 0 (as it loading it) */
const POWERSHELL_FAILS = { CLAUDETERM_TEST_POWERSHELL: join(__dirname, 'no-such-powershell.exe') }
const POWERSHELL_WORKS = { CLAUDETERM_TEST_POWERSHELL: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe') }

/** puts a 1×1 PNG on the clipboard and presses the paste key in the active tab */
async function pasteImage(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(async ({ clipboard, ClipboardItem }, png) => {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
  }, [...PNG_1x1])
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.paste)
}

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
    // (the blinking cursor), so the word is double-clicked where it is, not as an element, again if a redraw took it
    await expect(async () => {
      const word = await page.locator('.terminal-host:visible .xterm-rows span', { hasText: 'copy-me-42' }).last().boundingBox()
      expect(word).not.toBeNull()
      await page.mouse.dblclick(word!.x + word!.width / 2, word!.y + word!.height / 2)
      await page.keyboard.press(KEYS.copy)
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 1000 }).toBe('copy-me-42')
    }).toPass({ timeout: 10_000 })
    await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted-by-key'))
    await page.keyboard.press(KEYS.paste)
    // the paste reads the clipboard through main: an Enter pressed at once could come first
    await expect.poll(() => bufferText(page)).toMatch(/echo pasted-by-key\s*$/)
    await page.keyboard.press('Enter')
    await expect.poll(() => bufferText(page)).toMatch(/^pasted-by-key$/m)
  })
  await app.close()
})

test('on Windows where PowerShell cannot read the clipboard for Claude Code, the paste key hands a clipboard image to Claude as the pasted path of a PNG file holding it', async () => {
  test.skip(!WIN, 'Windows paste')
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: POWERSHELL_FAILS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => bufferText(page)).toMatch(PROMPT)
  let file = ''
  await keepingClipboard(app, async () => {
    await pasteImage(app, page)
    // Claude Code attaches a pasted line that is the path of an image file as the image itself
    await expect.poll(() => page.evaluate(() => window.__ct!.ptyInput!())).toMatch(/"[^"]+\.png"/)
    const input = await page.evaluate(() => window.__ct!.ptyInput!())
    expect(input).not.toContain('\x1bv')
    file = /"([^"]+\.png)"/.exec(input)![1]
  })
  expect(await app.evaluate(({ nativeImage }, f) => nativeImage.createFromPath(f).getSize(), file)).toEqual({ width: 1, height: 1 })
  rmSync(file)
  await app.close()
})

test('on Windows where PowerShell can read the clipboard for Claude Code, the paste key leaves a clipboard image to Claude Code\'s image-paste key', async () => {
  test.skip(!WIN, 'Windows paste')
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: POWERSHELL_WORKS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => bufferText(page)).toMatch(PROMPT)
  await keepingClipboard(app, async () => {
    await pasteImage(app, page)
    await expect.poll(() => page.evaluate(() => window.__ct!.ptyInput!())).toContain('\x1bv')
    // the second paste of the session goes the same way, without a new check
    await page.keyboard.press(KEYS.paste)
    await expect.poll(() => page.evaluate(() => window.__ct!.ptyInput!().split('\x1bv').length - 1)).toBe(2)
    expect(await page.evaluate(() => window.__ct!.ptyInput!())).not.toMatch(/\.png"/)
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
