import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, ROOT, testEnv } from './helpers'

const electronExe = createRequire(__filename)('electron') as unknown as string

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
