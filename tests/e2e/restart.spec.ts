import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, processAlive, PROMPT, typeInTerminal } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

test('Restart session in the tab menu restarts Claude Code in the same tab, resuming its conversation', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude --settings/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  await page.locator('.tab').first().click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Restart session' }).click()
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  // the terminal started clean: the first run's output is gone
  expect((await bufferText(page, tabId)).match(/fake-claude/g)).toHaveLength(1)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([tabId])
  await app.close()
})

test('a shell tab restarts its shell from the tab menu', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const [id] = await page.evaluate(() => window.__ct!.tabIds())
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(PROMPT)
  await typeInTerminal(page, 'echo before-restart')
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/^before-restart$/m)
  await page.locator('.tab').first().click({ button: 'right' })
  await expect(page.locator('.menu-item', { hasText: 'Close tab' })).toBeVisible()
  await page.locator('.menu-item', { hasText: 'Restart shell' }).click()
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).not.toContain('before-restart')
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(PROMPT)
  await typeInTerminal(page, 'echo after-restart')
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/^after-restart$/m)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([id])
  await app.close()
})

test('a restart before the first message starts a new conversation instead of resuming a missing one', async () => {
  const { app, page, pipeName, tabId, work } = await launchClaudeTab()
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude --settings/)
  // Claude Code reports the transcript path at startup but writes the file only with the first message
  const transcriptPath = join(work, 'not-written-yet.jsonl')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  await page.locator('.tab').first().click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Restart session' }).click()
  await expect.poll(async () => (await bufferText(page, tabId)).match(/fake-claude --settings/g)?.length ?? 0, { timeout: 15_000 }).toBe(1)
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude --settings/)
  expect(await bufferText(page, tabId)).not.toContain('--resume')
  await app.close()
})

test('output still waiting to be drawn does not come back after a restart clears the terminal', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const [id] = await page.evaluate(() => window.__ct!.tabIds())
  await app.evaluate(({ BrowserWindow }, tabId) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    // output arrives in many small chunks, and xterm parses them over several frames
    for (let i = 0; i < 2000; i++) wc.send('ev:pty-data', tabId, 'stale-line\r\n'.repeat(100))
    wc.send('ev:pty-reset', tabId)
  }, id)
  await page.waitForTimeout(3000)
  expect(await bufferText(page, id)).not.toContain('stale-line')
  await app.close()
})

// Windows ends the console's programs at once; on Linux ClaudeTerm waits up to 2 s for them, so the probe quits within that
const PROBE_QUIT_MS = WIN ? 8000 : 1000

test('a restart ends a program that takes its time to quit before the new process starts', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const [id] = await page.evaluate(() => window.__ct!.tabIds())
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(PROMPT)
  const marker = `ct-restart-probe-${Date.now()}`
  // like claude.exe, the probe shuts down slowly when its console closes (CTRL_CLOSE_EVENT arrives as SIGHUP)
  await typeInTerminal(page, `node -e "process.on('SIGHUP',()=>setTimeout(()=>process.exit(),${PROBE_QUIT_MS}));setInterval(()=>{},1000)" ${marker}`)
  await expect.poll(() => processAlive(marker), { timeout: 15_000 }).toBe(true)
  await page.locator('.tab').first().click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Restart shell' }).click()
  // the new shell starts on a clean terminal: until then the old prompt is still there
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).not.toContain(marker)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(PROMPT)
  expect(processAlive(marker)).toBe(false)
  await app.close()
})
