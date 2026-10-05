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
  fiveHour: { usedPct: 23.5, resetsAt: Math.floor(Date.now() / 1000) + 3600 }
})

test('a claude tab shows model, context, the 5h limit and running subagents', async () => {
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
  await expect(bar.locator('.status-agents')).toHaveText('⚙ 1: opus·high', { timeout: 10_000 })
  await expect(bar.locator('.status-agents')).toHaveAttribute('title', 'Explore · opus·high · <1 мин · «Find asar users»')

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'subagent', tabId, sessionId: SID, event: 'stop', agentId: 'a1', agentType: 'Explore' })).toEqual({ ok: true })
  await expect(bar.locator('.status-agents')).toHaveCount(0)

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session_end', tabId, sessionId: SID })).toEqual({ ok: true })
  await expect(bar).toBeHidden()
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
