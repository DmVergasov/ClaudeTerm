import { expect, test, type Page } from '@playwright/test'
import { DIM, PILL, promptBox, show } from './claude-screen'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchClaudeTab } from './helpers'

const OFF = { sound: false, flash: false, tab: true }
// the mark is what these tests check; keep the desktop quiet while they run
const QUIET = { ...FAKE_CLAUDE_SETTINGS, notifications: { permission: OFF, question: OFF, done: OFF, bell: OFF } }

async function activate(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
}


test('Mark as unread makes a background tab pulse, and the open tab once it is left; opening it clears the mark', async () => {
  const { app, page, tabId, work } = await launchClaudeTab(QUIET)
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await claudeTab.click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Mark as unread' }).click()
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await activate(page, tabId)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)

  await activate(page, shell)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await claudeTab.click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Mark as unread' }).click()
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await app.close()
})

test('a Claude tab left with an unsent prompt or a reply scrolled up pulses, unless autoUnread is off', async () => {
  const { app, page, tabId, work } = await launchClaudeTab(QUIET)
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude/)
  const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)

  // an empty prompt shows its placeholder dim: nothing is left
  await activate(page, tabId)
  await show(page, tabId, promptBox(DIM('Try "fix lint errors"')), 'step1')
  await activate(page, shell)
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)

  await activate(page, tabId)
  await show(page, tabId, promptBox('half a question'), 'step2')
  await activate(page, shell)
  await expect(claudeTab).toHaveClass(/\battention\b/)

  // the pill's words quoted in the conversation have no background: not the pill
  await activate(page, tabId)
  await show(page, tabId, ['● it shows Jump to bottom (ctrl+End) ↓ on screen', ...promptBox(DIM('Try "x"'))], 'step3')
  await activate(page, shell)
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)

  await activate(page, tabId)
  await show(page, tabId, [`● a long reply ${PILL(' Jump to bottom (ctrl+End) ↓ ')} goes on`, ...promptBox(DIM('Try "x"'))], 'step4')
  await activate(page, shell)
  await expect(claudeTab).toHaveClass(/\battention\b/)

  await activate(page, tabId)
  expect(await page.evaluate(() => window.ct.setSetting('notifications.autoUnread', false))).toEqual({ ok: true })
  await activate(page, shell)
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await app.close()
})
