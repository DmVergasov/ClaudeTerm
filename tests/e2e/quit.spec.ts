import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_CLAUDE_SETTINGS, launchApp } from './helpers'

// Quitting while a just-killed ConPTY session was still being torn down kept the process alive for seconds
// (and indefinitely on CI runners) after the window was gone. A few cycles, because it was intermittent.
test('closing the window right after closing a tab ends the app promptly', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  for (let cycle = 0; cycle < 4; cycle++) {
    const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work] })
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const first = (await page.evaluate(() => window.__ct!.activeTabId()))!
    await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work)
    await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
    await page.evaluate((id) => window.ct.closeTab(id), first)
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const closed = app.waitForEvent('close')
    const started = Date.now()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
    await closed
    expect(Date.now() - started, `cycle ${cycle}`).toBeLessThan(1500)
  }
})
