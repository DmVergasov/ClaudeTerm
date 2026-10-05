import { expect, test } from '@playwright/test'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { launchApp, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

test('Claude waiting in a background tab marks that tab until it is opened', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab()
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)

  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect(claudeTab.locator('.tab-bell')).toHaveCount(0)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(claudeTab.locator('.tab-bell')).toHaveCount(1)

  await claudeTab.click()
  await expect(claudeTab.locator('.tab-bell')).toHaveCount(0)
  await app.close()
})

test('attention for a shell tab is rejected', async () => {
  const { app, page, pipeName } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: false, error: `unknown claude tab: ${tabId}` })
  await app.close()
})
