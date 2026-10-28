import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

/** starts a Claude session in the tab and returns its scratchpad: the session temp folder the watcher follows */
async function startSession(tab: { pipeName: string; tabId: string }, temp: string): Promise<{ root: string; scratchpad: string }> {
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  expect(await sendPipeMessage(tab.pipeName, { v: 1, type: 'session', tabId: tab.tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  const root = claudeTempRoot({ platform: process.platform, env: WIN ? {} : { CLAUDE_CODE_TMPDIR: temp }, tmpdir: temp, uid: process.getuid?.() ?? -1 })
  const scratchpad = join(root, 'D--e2e', SID)
  await expect.poll(() => existsSync(scratchpad), { timeout: 10_000 }).toBe(true)
  return { root, scratchpad }
}

test('a PNG created in the session temp folder appears and is served via ctimg; the project folder is not watched', async () => {
  // the app's temp folder; Claude Code keeps each session's scratchpad in <its temp root>/<project>/<session id>
  const temp = mkdtempSync(join(tmpdir(), 'ct-temp-'))
  const { app, page, work, tabId, pipeName } = await claudeTab(WIN ? { TEMP: temp, TMP: temp } : { CLAUDE_CODE_TMPDIR: temp })
  const { root, scratchpad } = await startSession({ pipeName, tabId }, temp)
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

test('an image Claude reads from the scratchpad by its real path is the same card as the file the folder watch saw', async () => {
  test.skip(WIN, 'a temp root behind a link: /tmp is /private/tmp on macOS')
  const temp = mkdtempSync(join(tmpdir(), 'ct-temp-'))
  const link = `${temp}-link`
  symlinkSync(temp, link)
  const { app, page, tabId, pipeName } = await claudeTab({ CLAUDE_CODE_TMPDIR: link })
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  // Claude Code names the scratchpad by its real path, and Claude reads it by that path
  const scratchpad = join(realpathSync(temp), `claude-${process.getuid!()}`, 'D--e2e', SID)
  await expect.poll(() => existsSync(scratchpad), { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(500) // let the watcher start
  const plot = join(scratchpad, 'plot.png')
  writeFileSync(plot, PNG_1x1)
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'plot.png', source: 'created', caption: null }])
  appendFileSync(transcriptPath, [toolUseLine('toolu_r1', 'Read', { file_path: plot }), toolResultLine('toolu_r1'), ''].join('\n'))
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'plot.png', source: 'read', caption: null }])
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

test('show_image over the pipe accepts a video with its caption', async () => {
  const { app, page, work, tabId, pipeName } = await claudeTab()
  const file = join(work, 'clip.mp4')
  writeFileSync(file, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: file, caption: 'Render' })).toEqual({ ok: true })
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'clip.mp4', source: 'shown', caption: 'Render' }])
  await app.close()
})

test('an audio file created in the session scratchpad appears; an audio file in the project folder never does', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ct-temp-'))
  const { app, page, work, tabId, pipeName } = await claudeTab(WIN ? { TEMP: temp, TMP: temp } : { CLAUDE_CODE_TMPDIR: temp })
  const { scratchpad } = await startSession({ pipeName, tabId }, temp)
  await page.waitForTimeout(500) // let the watcher start
  writeFileSync(join(work, 'song.mp3'), Buffer.from([1, 2, 3]))
  writeFileSync(join(scratchpad, 'rec.wav'), Buffer.from([1, 2, 3]))
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'rec.wav', source: 'created', caption: null }])
  await page.waitForTimeout(1500)
  expect(await images(page)).toEqual([{ name: 'rec.wav', source: 'created', caption: null }])
  await app.close()
})

// the shell is stubbed in the main process: no media player opens in a test
async function stubShell(app: Awaited<ReturnType<typeof launchApp>>['app']): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__shellCalls = calls
    shell.showItemInFolder = (p: string) => { calls.push('show ' + p) }
    shell.openPath = (p: string) => { calls.push('open ' + p); return Promise.resolve('') }
  })
}
const shellCalls = (app: Awaited<ReturnType<typeof launchApp>>['app']) => app.evaluate(() => (globalThis as Record<string, unknown>).__shellCalls as string[])

test('a video shown over the pipe is an icon card with no picture; a click opens it in the system player, and an image still opens the lightbox', async () => {
  const { app, page, work, tabId, pipeName } = await claudeTab()
  await stubShell(app)
  const video = join(work, 'clip.mp4')
  const picture = join(work, 'chart.png')
  writeFileSync(video, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))
  writeFileSync(picture, PNG_1x1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: video, caption: null })).toEqual({ ok: true })
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: picture, caption: null })).toEqual({ ok: true })
  await expect.poll(() => images(page), { timeout: 10_000 }).toHaveLength(2)
  await expect(page.locator('.card')).toHaveCount(2)
  await expect(page.locator('.card-icon')).toHaveCount(1)
  await expect(page.locator('.card img')).toHaveCount(1)
  const mediaCard = page.locator('.card', { has: page.locator('.card-icon') })
  await expect(mediaCard.locator('img')).toHaveCount(0)
  await expect(mediaCard.locator('.card-icon')).toHaveText('🎬')
  // the context menu of a media card has no Copy image
  await mediaCard.click({ button: 'right' })
  await expect(page.locator('.menu .menu-item')).toHaveText(['Open in viewer', 'Show in Explorer', 'Copy path', 'Insert path into terminal', 'Remove from panel'])
  await page.locator('.menu .menu-item', { hasText: 'Open in viewer' }).click()
  await expect.poll(() => shellCalls(app)).toEqual(['open ' + video])
  // a click on the media card opens it in the system player
  await mediaCard.click()
  await expect.poll(() => shellCalls(app)).toEqual(['open ' + video, 'open ' + video])
  await expect(page.locator('#lightbox')).toBeHidden()
  // a click on the picture still opens the lightbox
  await page.locator('.card', { has: page.locator('img') }).click()
  await expect(page.locator('#lightbox')).toBeVisible()
  await expect(page.locator('.lightbox-caption')).toHaveText('chart.png  (1/1)')
  expect(await shellCalls(app)).toHaveLength(2)
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
