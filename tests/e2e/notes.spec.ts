import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Note } from '../../src/shared/note'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, makeDataDir, TEST_SHELL, writeTranscript } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

const record = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { notes: [string, Note | null][] }
  w.notes = []
  window.ct.onNote((id, n) => { w.notes.push([id, n]) })
})
const recorded = (page: Page) => page.evaluate(() => (window as unknown as { notes: [string, Note | null][] }).notes)
const notesFile = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, 'session-notes.json'), 'utf8')) as Record<string, Note>
/** a round trip to main: what the page sent before has been handled when it answers */
const synced = (page: Page) => page.evaluate(() => window.ct.getStarredSessions())

const session = (pipeName: string, tabId: string, sessionId: string, source: 'startup' | 'resume' | 'clear' | 'compact') =>
  sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source, transcriptPath: null })

const alpha: Note = { text: 'alpha', shown: true, form: 'card' }

test('a note written in a Claude tab is kept with its conversation, even when the window closes right after', async () => {
  const { app, page, tabId, dataDir, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  await page.evaluate((id) => {
    window.ct.setNoteText(id, 'Goal: payments')
    window.ct.setNoteView(id, true, 'label')
  }, tabId)
  await closeWindow(app)
  expect(notesFile(dataDir)).toEqual({ [SID_A]: { text: 'Goal: payments', shown: true, form: 'label' } })
})

test('Restore gives a restored tab the note of its conversation', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [{ kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'mine', claudeSessionId: SID_A }] }))
  writeFileSync(join(dataDir, 'session-notes.json'), JSON.stringify({ [SID_A]: alpha }))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await record(page)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const restored = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => recorded(page)).toEqual([[restored, alpha]])
  await app.close()
})

test("a closed tab's note comes back when Recent sessions reopens its conversation", async () => {
  const config = mkdtempSync(join(tmpdir(), 'ct-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeTranscript(config, work, SID_A)
  const { app, page, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.setNoteText(id, 'kept'), tabId)
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.evaluate((id) => window.ct.closeTab(id), tabId)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.evaluate(() => window.ct.listSessions())
  await record(page)
  await page.evaluate((id) => window.ct.openSession(id), SID_A)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expect.poll(async () => (await recorded(page)).map(([id, n]) => [id !== tabId, n?.text])).toEqual([[true, 'kept']])
  await app.close()
})

test('/clear: the tab keeps its note, now under the new conversation', async () => {
  const { app, page, tabId, dataDir, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.setNoteText(id, 'mine'), tabId)
  await synced(page)
  await record(page)
  expect(await session(pipeName, tabId, SID_B, 'clear')).toEqual({ ok: true })
  await synced(page)
  expect(await recorded(page)).toEqual([])
  await closeWindow(app)
  expect(notesFile(dataDir)).toEqual({ [SID_B]: { text: 'mine', shown: false, form: 'card' } })
})

test('/resume into a conversation with a note: the tab shows that note, the one it left keeps the tab\'s own', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  writeFileSync(join(dataDir, 'session-notes.json'), JSON.stringify({ [SID_A]: alpha }))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page, pipeName } = await launchApp({ dataDir, args: ['--claude', work] })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await session(pipeName, tabId, SID_B, 'startup')).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.setNoteText(id, 'beta'), tabId)
  await synced(page)
  await record(page)
  expect(await session(pipeName, tabId, SID_A, 'resume')).toEqual({ ok: true })
  await expect.poll(() => recorded(page)).toEqual([[tabId, alpha]])
  await closeWindow(app)
  const saved = notesFile(dataDir)
  expect(saved[SID_A]).toEqual(alpha)
  expect(saved[SID_B]?.text).toBe('beta')
})

test('what is sent for a shell tab is not kept', async () => {
  const { app, page, dataDir } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await page.evaluate((id) => window.ct.setNoteText(id, 'x'), tabId)
  await synced(page)
  await closeWindow(app)
  expect(existsSync(join(dataDir, 'session-notes.json'))).toBe(false)
})
