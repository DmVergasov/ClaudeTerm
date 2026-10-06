import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WIN } from '../fixtures/platform'
import { bufferText, launchApp, typeInTerminal } from './helpers'

// the typed line never holds the answer itself, so seeing the answer shows the shell ran it
const HELLO = WIN ? "echo ('hel' + 'lo-ct')" : "echo hel''lo-ct"

test('default tab runs a shell command', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await typeInTerminal(page, HELLO)
  await expect.poll(() => bufferText(page), { timeout: 15_000 }).toMatch(/^hello-ct$/m)
  await app.close()
})

test('its socket path taken by something else: ClaudeTerm leaves it alone and says why Claude tabs cannot reach it', async () => {
  test.skip(WIN, 'a named pipe has no file that something else could take')
  const taken = join(mkdtempSync(join(tmpdir(), 'ct-sock-')), 'x.sock')
  writeFileSync(taken, 'mine')
  const { app, page } = await launchApp({ env: { CLAUDETERM_PIPE_NAME: taken } })
  await expect(page.locator('.toast', { hasText: 'is not a socket' })).toBeVisible()
  expect(readFileSync(taken, 'utf8')).toBe('mine')
  await app.close()
})
