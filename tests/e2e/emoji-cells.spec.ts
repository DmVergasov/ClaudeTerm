import { expect, test } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, PROMPT, typeInTerminal } from './helpers'

// Claude Code redraws its screen by changing words where they stand, and counts ⚠️ (an emoji made so by U+FE0F) two
// cells wide, as ConPTY does on Windows: a terminal that counts it one cell puts every later change on its line one
// cell off, and the line keeps leftovers of the text before
test('a letter a program changes in place after ⚠️ changes where it stands, not one cell off', async () => {
  const script = join(mkdtempSync(join(tmpdir(), 'ct-emoji-')), 'redraw.js')
  writeFileSync(script, "process.stdout.write('\\u26a0\\ufe0f abcdef'); setTimeout(() => process.stdout.write('\\r\\x1b[6CD\\r\\nredrawn\\r\\n'), 300)\n")
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const [id] = await page.evaluate(() => window.__ct!.tabIds())
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(PROMPT)
  await typeInTerminal(page, `node '${script}'`)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain('redrawn')
  expect(await bufferText(page, id)).toContain('⚠️ abcDef')
  await app.close()
})
