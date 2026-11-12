import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchChatTab, sendMessage, userMessages, CHAT_INPUT } from './chat-helpers'

// the chat in front: its Quote button, its quote bars and their parts, its column and scroll area
const QUOTE = '.chat-host:visible .chat-quote-button'
const BAR = '.chat-host:visible .chat-quote'
const BAR_TEXT = '.chat-host:visible .chat-quote-text'
const BAR_REMOVE = '.chat-host:visible .chat-quote-remove'
const BUBBLE_QUOTE = '.chat-host:visible .chat-user .chat-quote-block'
const SEND = '.chat-host:visible .chat-send'
const COLUMN = '.chat-host:visible .chat-column'
const SCROLL = '.chat-host:visible .chat-scroll'

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

/** a word of Claude's answer selected with the mouse; returns the word's position */
async function selectWord(page: Page, text: string, word: string): Promise<{ x: number; y: number; left: number; right: number }> {
  const at = await wordBox(page, '.chat-text', text, word)
  // the press is inside the word's first letter and the release inside its last: a press on the gap just before the word, close
  // to where the last drag ended, starts no selection in Chromium (with or without a Quote click between the two drags)
  await page.mouse.move(at.left + 1, at.y)
  await page.mouse.down()
  await page.mouse.move(at.right + 2, at.y, { steps: 5 })
  await page.mouse.up()
  return at
}

/** Claude's answer is in the column: the turn is over and the text is drawn */
async function answer(page: Page, tabId: string, text: string): Promise<void> {
  await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
  await expect(page.locator('.chat-host:visible .chat-text', { hasText: text })).toBeVisible()
}

test('a word selected in Claude\'s answer gets a Quote button, and the quote goes into the next message', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { ask: [{ text: 'Quotable words from Claude.' }] } })
  try {
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'Quotable words')
    // the typed text comes first, so the caret of the quote has a place to go
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('my text')
    const word = await selectWord(page, 'Quotable words', 'Quotable')
    const button = page.locator(QUOTE)
    await expect(button).toBeVisible()
    // the button sits above the end of the selection, near it
    const box = (await button.boundingBox())!
    expect(Math.abs(box.x + box.width / 2 - word.right)).toBeLessThan(60)
    expect(box.y + box.height).toBeLessThan(word.y)
    await button.click()
    await expect(button).toBeHidden()
    await expect(page.locator(BAR_TEXT)).toHaveText('Quotable')
    await expect(page.locator(BAR).first()).toHaveAttribute('title', 'Quotable')
    // the quote alone does not enable Send
    await expect(page.locator(SEND)).toBeEnabled()
    // the focus is in the field, with the caret at its end
    expect(await page.evaluate(() => {
      const field = document.activeElement as HTMLTextAreaElement
      return field.classList.contains('chat-input') && field.selectionStart === field.value.length
    })).toBe(true)
    await page.keyboard.type(' end')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toContain('> Quotable\n\nmy text end')
    // the sent message shows its quote as a block above the text, and the bars are gone with the field
    await expect(page.locator(BUBBLE_QUOTE)).toHaveText('Quotable')
    await expect(page.locator('.chat-host:visible .chat-user').last()).toContainText('my text end')
    await expect(page.locator(BAR)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Send stays disabled while the only thing in the composer is a quote', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { ask: [{ text: 'Quotable words from Claude.' }] } })
  try {
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'Quotable words')
    await selectWord(page, 'Quotable words', 'Quotable')
    await page.locator(QUOTE).click()
    await expect(page.locator(BAR_TEXT)).toHaveText('Quotable')
    await expect(page.locator(SEND)).toBeDisabled()
  } finally {
    await app.close()
  }
})

test('two quotes go to the message in the order they were added', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { ask: [{ text: 'Alpha and Beta from Claude.' }] } })
  try {
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'Alpha and Beta')
    await selectWord(page, 'Alpha and Beta', 'Alpha')
    await page.locator(QUOTE).click()
    await selectWord(page, 'Alpha and Beta', 'Beta')
    await page.locator(QUOTE).click()
    await expect(page.locator(BAR_TEXT)).toHaveText(['Alpha', 'Beta'])
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('mine')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toContain('> Alpha\n\n> Beta\n\nmine')
  } finally {
    await app.close()
  }
})

test('the remove button of a quote bar takes that quote out, and it is not sent', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { ask: [{ text: 'Alpha and Beta from Claude.' }] } })
  try {
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'Alpha and Beta')
    await selectWord(page, 'Alpha and Beta', 'Alpha')
    await page.locator(QUOTE).click()
    await selectWord(page, 'Alpha and Beta', 'Beta')
    await page.locator(QUOTE).click()
    await page.locator(BAR_REMOVE).first().click()
    await expect(page.locator(BAR_TEXT)).toHaveText(['Beta'])
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('mine')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toContain('> Beta\n\nmine')
  } finally {
    await app.close()
  }
})

test('the Quote button hides when the selection collapses, on Esc, and when the column scrolls', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { ask: [{ text: 'Quotable words from Claude.' }] } })
  try {
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'Quotable words')
    await selectWord(page, 'Quotable words', 'Quotable')
    await expect(page.locator(QUOTE)).toBeVisible()
    // a click in the empty column after the answer collapses the selection
    const column = await page.locator(COLUMN).boundingBox()
    await page.mouse.click(column!.x + column!.width / 2, column!.y + column!.height - 4)
    await expect(page.locator(QUOTE)).toBeHidden()
    await selectWord(page, 'Quotable words', 'Quotable')
    await expect(page.locator(QUOTE)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator(QUOTE)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('the Quote button hides when the column scrolls under it', async () => {
  const filler = 'Filler paragraph.\n\n'.repeat(40)
  const { app, page, tabId } = await launchChatTab({ turns: { ask: [{ text: `${filler}Last words here.` }] } })
  try {
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'Last words here.')
    await selectWord(page, 'Last words here.', 'words')
    await expect(page.locator(QUOTE)).toBeVisible()
    await page.locator(SCROLL).evaluate((el) => { el.scrollTop = 0 })
    await expect(page.locator(QUOTE)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a click on Quote writes nothing new to the clipboard', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { ask: [{ text: 'Quotable words from Claude.' }] } })
  try {
    await recordClipboard(app)
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'Quotable words')
    await selectWord(page, 'Quotable words', 'Quotable')
    // the selection copies on its release: the record starts after that
    await expect.poll(() => clipboardWrites(app)).toEqual(['Quotable'])
    await clearClipboardWrites(app)
    await page.locator(QUOTE).click()
    await expect(page.locator(BAR_TEXT)).toHaveText('Quotable')
    expect(await clipboardWrites(app)).toEqual([])
  } finally {
    await app.close()
  }
})

test('Esc in the field clears the quotes with the draft, and nothing is sent', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { ask: [{ text: 'Quotable words from Claude.' }] } })
  try {
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'Quotable words')
    await selectWord(page, 'Quotable words', 'Quotable')
    await page.locator(QUOTE).click()
    await expect(page.locator(BAR_TEXT)).toHaveText('Quotable')
    await page.keyboard.press('Escape')
    await expect(page.locator(BAR)).toHaveCount(0)
    expect(userMessages(log).filter((m) => m.includes('Quotable'))).toEqual([])
  } finally {
    await app.close()
  }
})

test('at five quotes the Quote button does not show', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { ask: [{ text: 'One Two Three Four Five Six from Claude.' }] } })
  try {
    await sendMessage(page, 'ask')
    await answer(page, tabId, 'One Two Three')
    for (const word of ['One', 'Two', 'Three', 'Four', 'Five']) {
      await selectWord(page, 'One Two Three Four Five Six', word)
      await page.locator(QUOTE).click()
    }
    await expect(page.locator(BAR)).toHaveCount(5)
    await selectWord(page, 'One Two Three Four Five Six', 'Six')
    await expect(page.locator(QUOTE)).toBeHidden()
  } finally {
    await app.close()
  }
})
