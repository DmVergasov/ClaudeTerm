import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, launchApp, PNG_1x1 } from './helpers'

test('image button toggles the panel and shows the unseen counter', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page, pipeName } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, imagePanel: { autoOpen: false } }, args: ['--claude', work] })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const button = page.locator('#tabbar .tab-images-toggle')
  const badge = button.locator('.badge')
  const panel = page.locator('#image-panel')
  const show = async (name: string): Promise<void> => {
    const file = join(work, name)
    writeFileSync(file, PNG_1x1)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: file, caption: null })).toEqual({ ok: true })
  }

  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('title', 'Images (Ctrl+Shift+I)')
  await expect(button).not.toHaveClass(/active/)
  await expect(badge).toBeHidden()

  await button.click()
  await expect(panel).not.toHaveClass(/collapsed/)
  await expect(button).toHaveClass(/active/)
  await button.click()
  await expect(panel).toHaveClass(/collapsed/)
  await expect(button).not.toHaveClass(/active/)

  await show('a.png') // panel hidden: image arrives silently, badge counts it
  await expect(badge).toHaveText('1')
  await expect(panel).toHaveClass(/collapsed/)

  await button.click()
  await expect(panel).not.toHaveClass(/collapsed/)
  await expect(badge).toBeHidden()
  await expect(page.locator('.terminal-host:visible .xterm-helper-textarea')).toBeFocused()

  await button.click() // hide again, then a second image must be counted too
  await show('b.png')
  await expect(badge).toHaveText('1')
  await page.keyboard.press('Control+Shift+KeyI')
  await expect(panel).not.toHaveClass(/collapsed/)
  await expect(badge).toBeHidden()
  await app.close()
})
