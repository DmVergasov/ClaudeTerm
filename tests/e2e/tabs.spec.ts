import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
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
