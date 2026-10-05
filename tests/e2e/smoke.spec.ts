import { expect, test } from '@playwright/test'
import { bufferText, launchApp, typeInTerminal } from './helpers'

test('default tab runs a shell command', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await typeInTerminal(page, "echo ('hel' + 'lo-ct')")
  await expect.poll(() => bufferText(page), { timeout: 15_000 }).toMatch(/^hello-ct$/m)
  await app.close()
})
