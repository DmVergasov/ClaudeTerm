import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchChatTab, sendMessage } from './chat-helpers'

/** the writes main makes to the system clipboard, recorded in place of the real clipboard (no test takes it) */
async function recordClipboard(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ clipboard }) => {
    const writes: string[] = []
    ;(globalThis as Record<string, unknown>).__clipboardWrites = writes
    clipboard.writeText = (text: string) => { writes.push(text); return Promise.resolve() }
  })
}
const clipboardWrites = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => [...((globalThis as Record<string, unknown>).__clipboardWrites as string[])])

/** empties the record of the clipboard writes */
const clearClipboardWrites = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => { ((globalThis as Record<string, unknown>).__clipboardWrites as string[]).length = 0 })

/** the page point at the middle of the first `word` in the element holding `text`, and the word's edges, as a Range measures them */
async function wordBox(page: Page, selector: string, text: string, word: string): Promise<{ x: number; y: number; left: number; right: number }> {
  return page.evaluate(({ selector, text, word }) => {
    const element = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length > 0 && el.textContent?.includes(text))
    if (!element) throw new Error(`no visible ${selector} holds ${text}`)
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(word) ?? -1
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + word.length)
      const box = range.getBoundingClientRect()
      // the last letter's centre: a drag to it selects the word and not the space after it
      const last = document.createRange()
      last.setStart(node, index + word.length - 1)
      last.setEnd(node, index + word.length)
      const lastBox = last.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, left: box.left, right: lastBox.left + lastBox.width / 2 }
    }
    throw new Error(`no ${word} in ${selector}`)
  }, { selector, text, word })
}

test('a word selected with the mouse in the conversation goes to the clipboard at once', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { 'copy this': [{ text: 'Copied text from Claude.' }] } })
  try {
    await recordClipboard(app)
    await sendMessage(page, 'copy this')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Copied text' })).toBeVisible()
    const word = await wordBox(page, '.chat-text', 'Copied text', 'Copied')
    await page.mouse.move(word.left - 1, word.y)
    await page.mouse.down()
    await page.mouse.move(word.right, word.y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => clipboardWrites(app)).toEqual(['Copied'])
  } finally {
    await app.close()
  }
})

test('a plain click in the conversation leaves the clipboard alone', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { 'click here': [{ text: 'Clicked text from Claude.' }] } })
  try {
    await recordClipboard(app)
    await sendMessage(page, 'click here')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Clicked text' })).toBeVisible()
    const word = await wordBox(page, '.chat-text', 'Clicked text', 'Clicked')
    await page.mouse.click(word.x, word.y)
    // a click in the empty column after the answer: no text under the pointer, so no selection
    const column = await page.locator('.chat-host:visible .chat-scroll').boundingBox()
    await page.mouse.click(column!.x + column!.width / 2, column!.y + column!.height - 4)
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true)
    expect(await clipboardWrites(app)).toEqual([])
  } finally {
    await app.close()
  }
})

test('text selected with the mouse in the composer does not go to the clipboard', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await recordClipboard(app)
    await page.locator('.chat-host:visible .chat-input').click()
    await page.keyboard.type('draft words to select')
    const start = await page.locator('.chat-host:visible .chat-input').boundingBox()
    await page.mouse.move(start!.x + 4, start!.y + start!.height / 2)
    await page.mouse.down()
    await page.mouse.move(start!.x + start!.width - 4, start!.y + start!.height / 2, { steps: 5 })
    await page.mouse.up()
    // the selection is in the composer's field, which is not part of the page's selection text
    expect(await page.evaluate(() => { const f = document.activeElement as HTMLTextAreaElement; return f.selectionEnd - f.selectionStart })).toBeGreaterThan(0)
    expect(await clipboardWrites(app)).toEqual([])
  } finally {
    await app.close()
  }
})

/** a drag over `word` in the answer that holds `text`: from its left edge to its last letter */
async function dragWord(page: Page, text: string, word: string): Promise<void> {
  const box = await wordBox(page, '.chat-text', text, word)
  await page.mouse.move(box.left - 1, box.y)
  await page.mouse.down()
  await page.mouse.move(box.right, box.y, { steps: 5 })
  await page.mouse.up()
}

test('chat.copyOnSelect off: a selection copies nothing, and on again the next selection copies at once', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { 'setting': [{ text: 'Setting text from Claude.' }] } })
  try {
    await recordClipboard(app)
    await sendMessage(page, 'setting')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Setting text' })).toBeVisible()
    // the setting is saved and applied before the call returns: the next drag runs with it
    expect(await page.evaluate(() => window.ct.setSetting('chat.copyOnSelect', false))).toEqual({ ok: true })
    await dragWord(page, 'Setting text', 'Setting')
    // the setting is on again. The first drag's copy, had it happened, was sent before this call, so main handled it before
    // the call's answer: the record is empty only if the setting kept the first selection from copying
    expect(await page.evaluate(() => window.ct.setSetting('chat.copyOnSelect', true))).toEqual({ ok: true })
    expect(await clipboardWrites(app)).toEqual([])
    // the first drag left the word selected: clear it, so the next drag over the same word changes the selection
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await dragWord(page, 'Setting text', 'Setting')
    // exactly one write, the second selection's text
    await expect.poll(() => clipboardWrites(app)).toEqual(['Setting'])
  } finally {
    await app.close()
  }
})

test('a selection that stays while another control is clicked is not copied again', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { 'stay here': [{ text: 'Kept text from Claude.' }] } })
  try {
    await recordClipboard(app)
    await sendMessage(page, 'stay here')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Kept text' })).toBeVisible()
    const word = await wordBox(page, '.chat-text', 'Kept text', 'Kept')
    await page.mouse.move(word.left - 1, word.y)
    await page.mouse.down()
    await page.mouse.move(word.right, word.y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => clipboardWrites(app)).toEqual(['Kept'])
    await clearClipboardWrites(app)
    // a click on the tab bar keeps the chat's selection in place: its release copies nothing
    const bar = await page.locator('#tabbar').boundingBox()
    await page.mouse.click(bar!.x + bar!.width / 2, bar!.y + bar!.height / 2)
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Kept')
    expect(await clipboardWrites(app)).toEqual([])
  } finally {
    await app.close()
  }
})

test('a drag from the conversation out to the status bar copies nothing', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { 'drag out': [{ text: 'Dragged text from Claude.' }] } })
  try {
    await recordClipboard(app)
    await sendMessage(page, 'drag out')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Dragged text' })).toBeVisible()
    const word = await wordBox(page, '.chat-text', 'Dragged text', 'Dragged')
    const bar = await page.locator('.status-bar').boundingBox()
    await page.mouse.move(word.left - 1, word.y)
    await page.mouse.down()
    await page.mouse.move(bar!.x + bar!.width / 2, bar!.y + bar!.height / 2, { steps: 10 })
    await page.mouse.up()
    // the drag ended outside the chat: its selection reaches the status bar, and nothing goes to the clipboard
    const focusInConversation = await page.evaluate(() => document.querySelector('.chat-host .chat-body')?.contains(window.getSelection()?.focusNode ?? null) ?? false)
    expect(focusInConversation).toBe(false)
    expect(await clipboardWrites(app)).toEqual([])
  } finally {
    await app.close()
  }
})
