import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'

test('after restarting into an update the tabs come back without asking', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    tabs: [
      { kind: 'claude', profile: 'Windows PowerShell', cwd: work, title: 'one', claudeSessionId: SID },
      { kind: 'claude', profile: 'Windows PowerShell', cwd: work, title: 'two', claudeSessionId: SID2 }
    ]
  }))
  writeFileSync(join(dataDir, 'update-restart.json'), JSON.stringify({ at: Date.now() }))
  const { app, page } = await launchApp({ dataDir })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const [a, b] = await page.evaluate(() => window.__ct!.tabIds())
  await expect.poll(() => bufferText(page, a), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  await expect.poll(() => bufferText(page, b), { timeout: 15_000 }).toContain(`--resume ${SID2}`)
  expect(await page.evaluate(() => window.__ct!.restoreVisible!())).toBe(false)
  expect(existsSync(join(dataDir, 'update-restart.json'))).toBe(false)
  await app.close()
})
