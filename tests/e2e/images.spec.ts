import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeTempRoot } from '../../src/main/image-watcher'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { WIN } from '../fixtures/platform'
import { pastedLine, toolResultLine, toolUseLine } from '../fixtures/transcript'
import { FAKE_CLAUDE_SETTINGS, launchApp, PNG_1x1 } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const images = (page: Page): Promise<{ name: string; source: string; caption: string | null }[]> => page.evaluate(() => window.__ct!.images!())

async function claudeTab(env?: Record<string, string>) {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, work, tabId }
}

test('a PNG created in the session temp folder appears and is served via ctimg; the project folder is not watched', async () => {
  // the app's temp folder; Claude Code keeps each session's scratchpad in <its temp root>/<project>/<session id>
  const temp = mkdtempSync(join(tmpdir(), 'ct-temp-'))
  const { app, page, work, tabId, pipeName } = await claudeTab(WIN ? { TEMP: temp, TMP: temp } : { CLAUDE_CODE_TMPDIR: temp })
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  const root = claudeTempRoot({ platform: process.platform, env: WIN ? {} : { CLAUDE_CODE_TMPDIR: temp }, tmpdir: temp, uid: process.getuid?.() ?? -1 })
  const scratchpad = join(root, 'D--e2e', SID)
  await expect.poll(() => existsSync(scratchpad), { timeout: 10_000 }).toBe(true)
  // Claude Code refuses a temp root others can enter: one made by ClaudeTerm first is private too
  if (!WIN) expect(statSync(root).mode & 0o077).toBe(0)
  await page.waitForTimeout(500) // let the watcher start
  writeFileSync(join(work, 'project.png'), PNG_1x1)
  writeFileSync(join(scratchpad, 'plot.png'), PNG_1x1)
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'plot.png', source: 'created', caption: null }])
  await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.card img').first()).toHaveJSProperty('naturalWidth', 1)
  await page.waitForTimeout(1500)
  expect((await images(page)).map((i) => i.name)).toEqual(['plot.png'])
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
