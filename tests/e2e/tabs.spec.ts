import { expect, test, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, KEYS, launchApp, ROOT, testEnv, typeInTerminal } from './helpers'

const electronExe = createRequire(__filename)('electron') as unknown as string

/** The active tab runs in the folder: PowerShell's prompt shows it, bash prints it when asked (the stand-in claude prints it itself) */
async function expectFolder(page: Page, folder: string, ask: boolean): Promise<void> {
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  if (ask && !WIN) await typeInTerminal(page, 'pwd')
  // the folder's name: on macOS the shell reports /var/… as /private/var/…
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(basename(folder))
}

test('defaultFolder: the first tab and a new tab open in it, and a Claude tab opened from such a tab too', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ct-folder-'))
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: folder } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expectFolder(page, folder, true)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.newTab)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expectFolder(page, folder, true)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.newClaudeTab)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  await expectFolder(page, folder, false)
  await app.close()
})

test('defaultFolder that does not exist: the first tab and a new tab open in the home folder, and a notice says so', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ct-folder-'))
  rmSync(folder, { recursive: true })
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: folder } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect(page.locator('.toast', { hasText: `Folder not found: ${folder}` })).toBeVisible()
  await expectFolder(page, homedir(), true)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.newTab)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expectFolder(page, homedir(), true)
  await app.close()
})

test('second instance opens a claude tab in the running window', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page, dataDir, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--shell', work] })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await new Promise<void>((resolve) => {
    spawn(electronExe, [ROOT, '--claude', work], { env: testEnv(dataDir, pipeName) }).on('exit', () => resolve())
  })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = await page.evaluate(() => window.__ct!.activeTabId())
  await expect.poll(() => bufferText(page, id!), { timeout: 15_000 }).toMatch(/fake-claude --settings/)
  await app.close()
})

test('tabs can be renamed and closed', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.locator('.tab').first().dblclick()
  await page.locator('.tab-rename').fill('build')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tab').first().locator('.tab-title')).toHaveText('build')
  await page.locator('.tab').first().locator('.tab-close').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await app.close()
})

test('the window title names the folder of the tab in front, and a tab\'s tooltip shows its full path', async () => {
  const offroad = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'Offroad')
  const engine = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'Engine')
  mkdirSync(offroad)
  mkdirSync(engine)
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--shell', offroad] })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const first = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await page.evaluate((id) => window.ct.renameTab(id, 'build'), first)
  await expect(page).toHaveTitle('build — Offroad — ClaudeTerm')
  await expect(page.locator(`[data-tab-id="${first}"]`)).toHaveAttribute('title', `build\n${offroad}`)
  const second = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), engine))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, second)
  // a title that is the folder's name already does not repeat it
  await page.evaluate((id) => window.ct.renameTab(id, 'Engine'), second)
  await expect(page).toHaveTitle('Engine — ClaudeTerm')
  await page.locator(`[data-tab-id="${first}"]`).click()
  await expect(page).toHaveTitle('build — Offroad — ClaudeTerm')
  await app.close()
})
