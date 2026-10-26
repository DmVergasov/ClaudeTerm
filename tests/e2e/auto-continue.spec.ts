import { expect, test, type Page } from '@playwright/test'
import { CONTINUE_PROMPT } from '../../src/main/auto-continue'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { PipeMessage } from '../../src/shared/protocol'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const OFF = { sound: false, flash: false, tab: true }
// the mark is what these tests check; keep the desktop quiet while they run
const settings = (autoContinue: boolean): object => ({
  ...FAKE_CLAUDE_SETTINGS,
  claude: { ...FAKE_CLAUDE_SETTINGS.claude, autoContinue },
  notifications: { permission: OFF, question: OFF, done: OFF, bell: OFF }
})
/** what the StopFailure hook sends for a response cut off mid-stream */
const cutOff = (tabId: string): PipeMessage => ({ v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', error: 'server_error' })

/** the Claude tab goes to the background behind a shell tab */
async function openShellTab(page: Page, claudeTab: string, cwd: string): Promise<void> {
  await page.evaluate((dir) => window.ct.openTab({ kind: 'shell', cwd: dir }), cwd)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, claudeTab)
}

test('a response a dropped connection cut off is continued in its tab, and the tab does not call the user', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(settings(true))
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude/)
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect.poll(() => bufferText(page, tabId), { timeout: 20_000 }).toContain(CONTINUE_PROMPT)
  await expect(page.locator(`[data-tab-id="${tabId}"]`)).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('with auto-continue off, a cut-off response marks its tab as the end of a turn does', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(settings(false))
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect(page.locator(`[data-tab-id="${tabId}"]`)).toHaveClass(/\battention\b/)
  await app.close()
})

test('a cut-off response is left to the user who typed into the tab during the turn', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(settings(true))
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd: null })).toEqual({ ok: true })
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.type('draft')
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toContain('draft')
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect(page.locator(`[data-tab-id="${tabId}"]`)).toHaveClass(/\battention\b/)
  await app.close()
})

test('scrolling through the reply with the mouse wheel or PgUp during the turn still lets a cut-off response go on', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(settings(true))
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd: null })).toEqual({ ok: true })
  // what xterm.js sends to an app that tracks the mouse (Claude Code's fullscreen mode), as the keys and the wheel do
  for (const scroll of ['\x1b[<64;40;12M', '\x1b[<65;40;12M', '\x1b[5~', '\x1b[1;5F']) {
    await page.evaluate(([id, data]) => window.ct.writePty(id, data), [tabId, scroll] as const)
  }
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect.poll(() => bufferText(page, tabId), { timeout: 20_000 }).toContain(CONTINUE_PROMPT)
  await expect(page.locator(`[data-tab-id="${tabId}"]`)).not.toHaveClass(/\battention\b/)
  await app.close()
})
