import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { pastedLine, toolResultLine, toolUseLine } from '../fixtures/transcript'
import { FAKE_CLAUDE_SETTINGS, launchApp } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const sources = async (page: Page): Promise<string[]> => (await page.evaluate(() => window.__ct!.images!())).map((i) => i.source)

// an idle transcript waits up to a minute between reads here: a line that shows within seconds was read because the hook woke the feed
test('a prompt has a transcript that went idle read again at once', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: { CLAUDETERM_TEST_FEED_MAX_MS: '60000' } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, [toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }), toolResultLine('toolu_s1'), ''].join('\n'))
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  await expect.poll(() => sources(page), { timeout: 10_000 }).toEqual(['tool'])
  // read at once, then 0.5, 1, 2, 4 and 8 s apart while nothing comes: the read after the one at 7.5 s is at 15.5 s
  await page.waitForTimeout(8000)
  appendFileSync(transcriptPath, pastedLine(Buffer.from('second image').toString('base64')) + '\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID })).toEqual({ ok: true })
  await expect.poll(() => sources(page), { timeout: 3000 }).toEqual(['pasted', 'tool'])
  await app.close()
})
