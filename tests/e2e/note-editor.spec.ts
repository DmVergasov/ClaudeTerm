import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Note } from '../../src/shared/note'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { keepingClipboard, launchClaudeTab, noteText } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

/** the note over the terminal: its card, the editor's text and the Note button */
function note(page: Page) {
  const card = page.locator('#note .note-card')
  return {
    card,
    text: card.locator('.note-text'),
    button: page.locator('#sheet-header .tab-note-toggle')
  }
}

test('Checkbox turns the line into an item shown as a box, a click ticks it, and a ticked item is dimmed and struck through', async () => {
  const { app, page } = await launchClaudeTab()
  const { card, text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('Write the tests')
  const plainColor = await card.locator('.cm-line').evaluate((el) => getComputedStyle(el).color)

  await card.locator('.note-tool[data-tool="checkbox"]').click()
  await expect.poll(() => noteText(page)).toBe('- [ ] Write the tests')
  await expect(card.locator('.note-check')).toHaveCount(1)
  await expect(card.locator('.cm-line')).toHaveText('Write the tests')

  await card.locator('.note-check').click()
  await expect.poll(() => noteText(page)).toBe('- [x] Write the tests')
  const done = card.locator('.cm-line.note-item-done')
  await expect(done).toHaveCSS('text-decoration-line', 'line-through')
  expect(await done.evaluate((el) => getComputedStyle(el).color)).not.toBe(plainColor)

  await card.locator('.note-tool[data-tool="checkbox"]').click()
  await expect.poll(() => noteText(page)).toBe('Write the tests')
  await app.close()
})

test('typing [ ] or [] at the start of a line makes an item; Enter goes on with the list, and Enter on an empty item ends it', async () => {
  const { app, page } = await launchClaudeTab()
  const { text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('[ ] one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('[] three')
  await expect.poll(() => noteText(page)).toBe('- [ ] one\n- [ ] two\n- [ ] three')
  await app.close()
})

test('Ctrl+Enter ticks the item under the caret; undo and redo work across it', async () => {
  const { app, page } = await launchClaudeTab()
  const { text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('[ ] one')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect.poll(() => noteText(page)).toBe('- [x] one')
  await page.keyboard.press('ControlOrMeta+KeyZ')
  await expect.poll(() => noteText(page)).toBe('- [ ] one')
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ')
  await expect.poll(() => noteText(page)).toBe('- [x] one')
  await app.close()
})

test('List makes bullets shown with a dot; List again turns them back', async () => {
  const { app, page } = await launchClaudeTab()
  const { card, text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('a')
  await card.locator('.note-tool[data-tool="list"]').click()
  await expect.poll(() => noteText(page)).toBe('- a')
  await expect(card.locator('.note-bullet')).toBeVisible()
  await card.locator('.note-tool[data-tool="list"]').click()
  await expect.poll(() => noteText(page)).toBe('a')
  await expect(card.locator('.note-bullet')).toHaveCount(0)
  await app.close()
})

test('several selected lines become items at once, and back', async () => {
  const { app, page } = await launchClaudeTab()
  const { card, text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await page.keyboard.press('ControlOrMeta+KeyA')
  await card.locator('.note-tool[data-tool="checkbox"]').click()
  await expect.poll(() => noteText(page)).toBe('- [ ] one\n- [ ] two')
  await card.locator('.note-tool[data-tool="checkbox"]').click()
  await expect.poll(() => noteText(page)).toBe('one\ntwo')
  await app.close()
})

test('text typed through an input method goes in as typed', async () => {
  const { app, page } = await launchClaudeTab()
  const { text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.insertText('メモ: テスト')
  await expect.poll(() => noteText(page)).toBe('メモ: テスト')
  await app.close()
})

test('copy carries the Markdown, and pasted Markdown shows its boxes', { tag: '@alone' }, async () => {
  const { app, page } = await launchClaudeTab()
  await keepingClipboard(app, async () => {
    const { card, text, button } = note(page)
    await button.click()
    await expect(text).toBeFocused()
    await page.keyboard.type('[ ] Write the tests')
    await page.keyboard.press('ControlOrMeta+KeyA')
    await page.keyboard.press('ControlOrMeta+KeyC')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('- [ ] Write the tests')

    await app.evaluate(({ clipboard }) => clipboard.writeText('- [x] Done'))
    // the line is an item: the first Enter continues the list, the second one (on the empty item) ends it
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('ControlOrMeta+KeyV')
    await expect.poll(() => noteText(page)).toBe('- [ ] Write the tests\n- [x] Done')
    await expect(card.locator('.note-check').nth(1)).toBeChecked()
  })
  await app.close()
})

test('what is typed is kept with the conversation as Markdown', async () => {
  const { app, page, tabId, pipeName, dataDir } = await launchClaudeTab()
  const sent = await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID_A, source: 'startup', transcriptPath: null })
  expect(sent).toEqual({ ok: true })
  const { card, text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('Write the tests')
  await card.locator('.note-tool[data-tool="checkbox"]').click()
  await expect.poll(() => noteText(page)).toBe('- [ ] Write the tests')
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-notes.json'), 'utf8')) as Record<string, Note>
  expect(saved[SID_A]?.text).toBe('- [ ] Write the tests')
})

/** opens a second Claude tab and waits until it is in front; resolves to its id */
async function openSecondTab(page: Page, work: string, first: string): Promise<string> {
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, first)
  return (await page.evaluate(() => window.__ct!.activeTabId()))!
}

async function activate(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
}

test('undo in one tab\'s note does not take back the typing of another tab\'s note with the same text', async () => {
  const { app, page, tabId, work } = await launchClaudeTab()
  const { text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('same')

  const second = await openSecondTab(page, work, tabId)
  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('same')
  await expect.poll(() => noteText(page)).toBe('same')

  // the first tab's note is the same text: switching to it must not keep the second tab's history
  await activate(page, tabId)
  await expect.poll(() => noteText(page)).toBe('same')
  await text.click()
  await page.keyboard.press('ControlOrMeta+KeyZ')
  await expect.poll(() => noteText(page)).toBe('same')

  await activate(page, second)
  await expect.poll(() => noteText(page)).toBe('same')
  await app.close()
})
