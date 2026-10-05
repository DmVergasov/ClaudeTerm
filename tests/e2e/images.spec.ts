import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { pastedLine, toolResultLine, toolUseLine } from '../fixtures/transcript'
import { FAKE_CLAUDE_SETTINGS, launchApp, PNG_1x1 } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const images = (page: Page): Promise<{ name: string; source: string; caption: string | null }[]> => page.evaluate(() => window.__ct!.images!())

async function claudeTab() {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work] })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, work, tabId }
}

test('a PNG created in the claude tab folder appears and is served via ctimg', async () => {
  const { app, page, work } = await claudeTab()
  await page.waitForTimeout(1500) // let the folder watcher become ready
  writeFileSync(join(work, 'plot.png'), PNG_1x1)
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'plot.png', source: 'created', caption: null }])
  await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.card img').first()).toHaveJSProperty('naturalWidth', 1)
  await app.close()
})

test('show_image over the pipe lands in the tab with its caption', async () => {
  const { app, page, work, tabId, pipeName } = await claudeTab()
  const file = join(work, 'chart.png')
  writeFileSync(file, PNG_1x1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: file, caption: 'Revenue' })).toEqual({ ok: true })
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'chart.png', source: 'shown', caption: 'Revenue' }])
  await app.close()
})

test('images from the session transcript appear, including lines appended later', async () => {
  const { app, page, tabId, pipeName } = await claudeTab()
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, [toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }), toolResultLine('toolu_s1'), ''].join('\n'))
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: expect.stringMatching(/\.png$/), source: 'tool', caption: 'claude-in-chrome · computer (screenshot)' }])
  appendFileSync(transcriptPath, pastedLine(Buffer.from('second image').toString('base64')) + '\n')
  await expect.poll(async () => (await images(page)).map((i) => i.source), { timeout: 10_000 }).toEqual(['pasted', 'tool'])
  await app.close()
})
