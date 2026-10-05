import { expect, test } from '@playwright/test'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
// the mark is what these tests check; keep the desktop quiet while they run
const QUIET = { ...FAKE_CLAUDE_SETTINGS, attention: { sound: 'none', flash: false } }

test('Claude waiting in a background tab makes that tab pulse until it is opened', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)

  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/)
  expect(await claudeTab.evaluate((e) => getComputedStyle(e).animationName)).toBe('tab-attention')
  await expect(claudeTab.locator('.tab-bell')).toHaveCount(0)

  await claudeTab.click()
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('the pulse keeps its phase when the tab bar is redrawn', async () => {
  // a busy Claude in another tab retitles it about once a second, and every title change redraws the tab bar
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const other = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, other)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect(claudeTab).toHaveClass(/\battention\b/)
  // how far into the pulse the tab is; a recreated element restarts its CSS animation from 0 unless it keeps the phase
  const phase = () => page.evaluate(() => {
    const a = document.getAnimations().find((x) => (x as CSSAnimation).animationName === 'tab-attention')
    const t = a?.effect?.getComputedTiming()
    return t ? Number(t.localTime) - Number(t.delay) : -1
  })
  await page.waitForTimeout(700)
  const before = await phase()
  expect(before).toBeGreaterThan(0)
  await page.evaluate((id) => window.ct.renameTab(id, 'renamed'), other)
  await expect(page.locator(`[data-tab-id="${other}"]`)).toHaveAttribute('title', 'renamed')
  const after = await phase()
  // the pulse runs on one clock: the redraw carries on where it was (modulo a full 2.4 s cycle) instead of restarting
  expect((((after - before) % 2400) + 2400) % 2400).toBeLessThan(500)
  await app.close()
})

test('a terminal bell in a background tab only puts a dot on it', async () => {
  const { app, page, tabId: first, work } = await launchClaudeTab()
  const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)
  await expect.poll(() => bufferText(page, shell), { timeout: 20_000 }).toMatch(/PS .*>/)
  await page.evaluate((id) => window.ct.activateTab(id), first)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)

  await page.evaluate((id) => window.ct.writePty(id, 'Write-Host -NoNewline ([char]7)\r'), shell)
  const shellTab = page.locator(`[data-tab-id="${shell}"]`)
  await expect(shellTab.locator('.tab-bell')).toHaveCount(1)
  await expect(shellTab).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('attention for a shell tab is rejected', async () => {
  const { app, page, pipeName } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: false, error: `unknown claude tab: ${tabId}` })
  await app.close()
})
