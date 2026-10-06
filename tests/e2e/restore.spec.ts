import { expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir, TEST_SHELL, typeInTerminal } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

function snapshotFile(cwd: string): string {
  return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [{ kind: 'claude', profile: TEST_SHELL, cwd, title: 'mine', claudeSessionId: SID }] })
}

test('restores a claude tab with --resume and its title', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), snapshotFile(work))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const id = await page.evaluate(() => window.__ct!.activeTabId())
  await expect.poll(() => bufferText(page, id!), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await page.evaluate((i) => window.__ct!.tabTitle(i), id!)).toBe('mine')
  expect(await page.evaluate(() => window.__ct!.restoreVisible!())).toBe(false)
  expect(existsSync(join(dataDir, 'previous-session.json'))).toBe(false)
  await app.close()
})

test('closing the window keeps open tabs in the snapshot', async () => {
  const { app, page, dataDir } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: unknown[] }
  expect(saved.tabs).toHaveLength(2)
})

test('a run that ends with no tabs does not wipe the previous session', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  writeFileSync(join(dataDir, 'previous-session.json'), snapshotFile('D:\\'))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  const closed = app.waitForEvent('close')
  await page.locator('.tab .tab-close').click()
  await closed
  expect(existsSync(join(dataDir, 'previous-session.json'))).toBe(true)
  const state = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: unknown[] }
  expect(state.tabs).toEqual([])
})

function twoTabSnapshot(cwd: string): string {
  const tab = (title: string) => ({ kind: 'claude', profile: TEST_SHELL, cwd, title, claudeSessionId: SID })
  return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [tab('one'), tab('two')] })
}

test('restore replaces the untouched auto tab and does not accumulate tabs across cycles', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), twoTabSnapshot(work))
  const first = await launchApp({ dataDir })
  await first.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => first.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await first.page.locator('.banner-restore').click()
  await first.page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  expect(await first.page.evaluate(() => window.__ct!.tabTitle(window.__ct!.activeTabId()!))).toBe('one')
  await closeWindow(first.app)

  const second = await launchApp({ dataDir })
  await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => second.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await second.page.locator('.banner-restore').click()
  await second.page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await second.page.waitForTimeout(500)
  expect(await second.page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
  await second.app.close()
})

test('restore keeps the auto tab when the user typed into it', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), twoTabSnapshot(work))
  const { app, page } = await launchApp({ dataDir })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await typeInTerminal(page, 'echo typed-by-user')
  await expect.poll(() => bufferText(page), { timeout: 15_000 }).toContain('typed-by-user')
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  await app.close()
})
