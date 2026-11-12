import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_INPUT, chatReady, launchChatTab, sendMessage } from './chat-helpers'

// the chat in front: its working line, the bar under it, the column
const WORKING = '.chat-host:visible .chat-working'
const VERB = '.chat-host:visible .chat-verb'
const BAR = '.chat-host:visible .chat-activity-bar'
const SWEEP = '.chat-host:visible .chat-activity-sweep'
const COLUMN = '.chat-host:visible .chat-column'

/** /compact typed as a person types it: Enter completes the command (it takes arguments, so it waits), and the next Enter sends it */
async function sendCompact(page: Page): Promise<void> {
  await chatReady(page)
  await page.locator(CHAT_INPUT).click()
  await page.keyboard.type('/compact')
  await page.keyboard.press('Enter')
  await expect(page.locator(CHAT_INPUT)).toHaveValue('/compact ')
  await page.keyboard.press('Enter')
}

/** the animation a node runs, as the page computes it */
const animationOf = (page: Page, selector: string): Promise<string> => page.locator(selector).evaluate((el) => getComputedStyle(el).animationName)

test('a compaction shows Compacting conversation with a moving bar, and its divider says what it did', async () => {
  // the compaction waits for the file 'release': the line shows while it runs
  const { app, page, config } = await launchChatTab({
    turns: { '/compact': [{ compact: { gate: 'release', preTokens: 27050, postTokens: 3874, durationMs: 9992 } }] },
  })
  try {
    await sendCompact(page)
    await expect(page.locator(VERB)).toHaveText('Compacting conversation')
    await expect(page.locator(BAR)).toBeVisible()
    await expect.poll(() => animationOf(page, SWEEP)).not.toBe('none')
    await expect.poll(() => animationOf(page, VERB)).not.toBe('none')
    writeFileSync(join(config, 'release'), '')
    await expect(page.locator(WORKING)).toBeHidden()
    await expect(page.locator(COLUMN)).toContainText('Conversation compacted · 27k → 3.9k tokens · 10 s')
  } finally {
    await app.close()
  }
})

test('under reduced motion the compaction line has no sweep and no shimmer: the bar stands still', async () => {
  const { app, page, config } = await launchChatTab({ turns: { '/compact': [{ compact: { gate: 'release' } }] } })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await sendCompact(page)
    await expect(page.locator(VERB)).toHaveText('Compacting conversation')
    await expect(page.locator(BAR)).toBeVisible()
    expect(await animationOf(page, SWEEP)).toBe('none')
    expect(await animationOf(page, VERB)).toBe('none')
    expect(await page.locator(BAR).evaluate((el) => getComputedStyle(el).opacity)).toBe('0.4')
    writeFileSync(join(config, 'release'), '')
    await expect(page.locator(WORKING)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a compaction that fails says why in a notice, and its line goes', async () => {
  const { app, page } = await launchChatTab({ turns: { '/compact': [{ compact: { fail: 'Prompt is too long' } }] } })
  try {
    await sendCompact(page)
    await expect(page.locator(COLUMN)).toContainText('Compaction failed: Prompt is too long')
    await expect(page.locator(WORKING)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('Restart session shows Restarting Claude Code at once, keeps the conversation in the column, then says it restarted', async () => {
  // the old process lingers after its input ends, so the restart's line stays up long enough to be seen
  const { app, page } = await launchChatTab({ turns: { hello: [{ lingerMs: 1500 }, { text: 'Hi there' }] } })
  try {
    await sendMessage(page, 'hello')
    await expect(page.locator(COLUMN)).toContainText('Hi there')
    await chatReady(page)
    await page.locator('.tab').first().click({ button: 'right' })
    await page.locator('.menu-item', { hasText: 'Restart session' }).click()
    await expect(page.locator(VERB)).toHaveText('Restarting Claude Code')
    expect(await page.locator(COLUMN).innerText()).toContain('Hi there')
    await expect(page.locator(COLUMN)).toContainText('Session restarted')
    await expect(page.locator(WORKING)).toBeHidden()
    expect(await page.locator(COLUMN).innerText()).toContain('Hi there')
  } finally {
    await app.close()
  }
})
