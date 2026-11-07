import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { StatusMessage } from '../../src/shared/protocol'
import { assistantLine } from '../fixtures/transcript'
import { launchApp, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

const statusMsg = (tabId: string): StatusMessage => ({
  v: 1,
  type: 'status',
  tabId,
  sessionId: SID,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 },
  fiveHour: { usedPct: 23.5, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
  sevenDay: { usedPct: 41.2, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 }
})

test('a claude tab shows model, context, the 5h and weekly limits and running subagents', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  const subagentDir = join(projectDir, SID, 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  writeFileSync(join(subagentDir, 'agent-a1.jsonl'), assistantLine('claude-opus-5-5', 'high') + '\n')
  writeFileSync(join(subagentDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find asar users' }))

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'subagent', tabId, sessionId: SID, event: 'start', agentId: 'a1', agentType: 'Explore' })).toEqual({ ok: true })

  const bar = page.locator('#statusbar')
  await expect(bar.locator('.status-model')).toHaveText('Opus 5.5 · xhigh')
  await expect(bar.locator('.status-context')).toHaveText('ctx 41% · 82k/200k')
  await expect(bar.locator('.status-limit')).toHaveText('5h 24%')
  await expect(bar.locator('.status-week')).toHaveText('7d 41%')
  await expect(bar.locator('.status-agents')).toHaveText('⚙ 1: opus·high', { timeout: 10_000 })
  await expect(bar.locator('.status-agents')).toHaveAttribute('title', 'Explore · opus·high · <1 min · "Find asar users"')

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'subagent', tabId, sessionId: SID, event: 'stop', agentId: 'a1', agentType: 'Explore' })).toEqual({ ok: true })
  await expect(bar.locator('.status-agents')).toHaveCount(0)

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session_end', tabId, sessionId: SID })).toEqual({ ok: true })
  await expect(bar).toBeHidden()
  await app.close()
})

test('the 5h limit takes its color from the pace it is spent at, says the forecast in its tooltip, and shows the time gone by on its bar', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const now = Math.floor(Date.now() / 1000)
  const limit = page.locator('#statusbar .status-limit')
  const bar = (): Promise<string[]> => limit.evaluate((el) => [el.style.getPropertyValue('--used'), el.style.getPropertyValue('--elapsed')])

  // half the limit in the first of the five hours: the rest goes in the next hour
  expect(await sendPipeMessage(pipeName, { ...statusMsg(tabId), fiveHour: { usedPct: 50, resetsAt: now + 4 * 3600 } })).toEqual({ ok: true })
  await expect(limit).toHaveText('5h 50%')
  await expect(limit).toHaveClass(/\bcrit\b/)
  await expect(limit).toHaveAttribute('title', /\nat this pace: runs out at \d\d:\d\d, /)
  await expect.poll(bar).toEqual(['50%', '20%'])

  // the same half four hours into the window lasts until the reset
  expect(await sendPipeMessage(pipeName, { ...statusMsg(tabId), fiveHour: { usedPct: 50, resetsAt: now + 3600 } })).toEqual({ ok: true })
  await expect(limit).toHaveAttribute('title', /\nat this pace: lasts until the reset, about 6\d% by then$/)
  await expect(limit).not.toHaveClass(/\b(warn|crit)\b/)
  await expect.poll(bar).toEqual(['50%', '80%'])
  await app.close()
})

test('the background work a turn ended with shows in the status bar until a later turn end, or the end of the session, says it is over', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  const segment = page.locator('#statusbar .status-background')
  await expect(page.locator('#statusbar .status-model')).toHaveText('Opus 5.5 · xhigh')
  await expect(segment).toHaveCount(0)

  const tasks = [{ id: 'b1', type: 'shell', description: 'Run the e2e suite', command: 'npx playwright test' }, { id: 'm1', type: 'monitor', description: null, command: 'tail -f server.log' }]
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', background: true, tasks })).toEqual({ ok: true })
  await expect(segment).toHaveText('2 in background: Run the e2e suite, tail -f server.log')
  await expect(segment).toHaveAttribute('title', 'Still running after the turn:\nshell · Run the e2e suite · npx playwright test\nmonitor · tail -f server.log')

  // the next turn ends with the monitor alone, the one after it with nothing in the background
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', background: true, tasks: [tasks[1]!] })).toEqual({ ok: true })
  await expect(segment).toHaveText('1 in background: tail -f server.log')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', tasks: [] })).toEqual({ ok: true })
  await expect(segment).toHaveCount(0)

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', background: true, tasks })).toEqual({ ok: true })
  await expect(segment).toHaveCount(1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session_end', tabId, sessionId: SID })).toEqual({ ok: true })
  await expect(segment).toHaveCount(0)
  await app.close()
})

test('long background work takes no more than about 40 characters of the status bar, and its tooltip says it all', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  const segment = page.locator('#statusbar .status-background')
  const description = 'Watch the invoice export queue and re-arm the watcher on every restart of the billing service'
  const tasks = [{ id: 'm1', type: 'monitor', description, command: 'node scripts/watch-queue.js --billing --retry 5' }]
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', background: true, tasks })).toEqual({ ok: true })
  await expect(segment).toHaveText(`1 in background: ${description}`)
  await expect(segment).toHaveAttribute('title', `Still running after the turn:\nmonitor · ${description} · node scripts/watch-queue.js --billing --retry 5`)

  // 40 characters of the status bar's font, measured beside the segment; the font's own measure of a character (CSS ch)
  // differs from it by a few pixels on macOS, hence "about"
  const forty = await page.locator('#statusbar').evaluate((bar) => {
    const probe = document.createElement('span')
    probe.textContent = '0'.repeat(40)
    bar.append(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    return width
  })
  const shown = await segment.evaluate((el) => ({ width: el.getBoundingClientRect().width, cut: el.scrollWidth > el.clientWidth }))
  expect(shown.width).toBeLessThanOrEqual(forty * 1.1)
  expect(shown.cut).toBe(true)
  await app.close()
})

test('a new status updates the segments in place, so an open tooltip is not dismissed', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  const model = page.locator('#statusbar .status-model')
  await expect(model).toHaveText('Opus 5.5 · xhigh')
  const handle = await model.elementHandle()
  expect(await sendPipeMessage(pipeName, { ...statusMsg(tabId), context: { usedTokens: 90_000, size: 200_000, usedPct: 45 } })).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-context')).toHaveText('ctx 45% · 90k/200k')
  expect(await handle!.evaluate((e) => e.isConnected)).toBe(true)
  await app.close()
})

test('a shell tab has no status bar and its status messages are rejected', async () => {
  const { app, page, pipeName } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: false, error: `unknown claude tab: ${tabId}` })
  await expect(page.locator('#statusbar')).toBeHidden()
  await app.close()
})
