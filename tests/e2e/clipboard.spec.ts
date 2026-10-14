import { type ElectronApplication, expect, test } from '@playwright/test'
import { WIN } from '../fixtures/platform'
import { FAKE_CLAUDE_SETTINGS, launchApp, PROMPT, bufferText, typeInTerminal } from './helpers'

type SavedClipboard = { savedClipboard?: Record<string, Blob | Electron.ClipboardBookmark>[] }

/** Runs the steps, then gives the system clipboard back what it held: the tests must not change the machine they run on */
async function keepingClipboard(app: ElectronApplication, steps: () => Promise<void>): Promise<void> {
  // the items clipboard.read() returns read the clipboard lazily and cannot be written back: keep their data
  await app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const savedClipboard = await Promise.all(items.map(async (item) =>
      Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)] as const)))))
    Object.assign(globalThis, { savedClipboard } satisfies SavedClipboard)
  })
  try {
    await steps()
  } finally {
    await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const saved = (globalThis as SavedClipboard).savedClipboard ?? []
      if (saved.length) await clipboard.write(saved.map((data) => new ClipboardItem(data)))
      else clipboard.clear()
    })
  }
}

// Claude Code in its fullscreen mode copies its own mouse selection with OSC 52
test('a program copies text to the clipboard with OSC 52', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => bufferText(page)).toMatch(PROMPT)
  await keepingClipboard(app, async () => {
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('before'))
    const b64 = Buffer.from('copied by osc 52 — ✓', 'utf8').toString('base64')
    await typeInTerminal(page, WIN ? `Write-Host -NoNewline "$([char]27)]52;c;${b64}$([char]7)"; 'osc-sent'` : `printf '\\033]52;c;${b64}\\a'; echo osc-sent`)
    await expect.poll(() => bufferText(page)).toMatch(/^osc-sent$/m)
    await expect.poll(() => app.evaluate(async ({ clipboard }) => clipboard.readText())).toBe('copied by osc 52 — ✓')
  })
  await app.close()
})

test('OSC 52 cannot read the clipboard', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => bufferText(page)).toMatch(PROMPT)
  await keepingClipboard(app, async () => {
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('secret'))
    await typeInTerminal(page, WIN ? `Write-Host -NoNewline "$([char]27)]52;c;?$([char]7)"; 'osc-sent'` : `printf '\\033]52;c;?\\a'; echo osc-sent`)
    await expect.poll(() => bufferText(page)).toMatch(/^osc-sent$/m)
    expect(await page.evaluate(() => window.__ct!.ptyInput!())).not.toContain('\x1b]52')
    expect(await app.evaluate(async ({ clipboard }) => clipboard.readText())).toBe('secret')
  })
  await app.close()
})
