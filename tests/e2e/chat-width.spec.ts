import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchChatTab, sendMessage } from './chat-helpers'

/** the window's content is 1600 px wide (or the given width): the chat's width is what the window gives it */
async function resizeWindow(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 900), width)
}

/** the box of an element of the chat in front (a selector under its host, or the host itself), in pixels */
async function boxOf(page: Page, part = ''): Promise<{ x: number; width: number }> {
  const box = await page.locator(`.chat-host:visible${part === '' ? '' : ` ${part}`}`).boundingBox()
  if (box === null) throw new Error(`${part || 'the chat'} is not drawn`)
  return { x: box.x, width: box.width }
}

test('with the setting off, the conversation is a reading column of at most 900 px in a 1600 px window', async () => {
  const { app, page } = await launchChatTab({ turns: { write: [{ text: 'A long answer. '.repeat(30) }] } })
  try {
    await resizeWindow(app, 1600)
    await sendMessage(page, 'write')
    await expect(page.locator('.chat-host:visible .chat-text')).toHaveCount(1)
    expect((await boxOf(page, '.chat-column')).width).toBeLessThanOrEqual(900)
  } finally {
    await app.close()
  }
})

test('turned on through the settings, the conversation and the message box take at least 1400 px, without reopening the tab', async () => {
  const { app, page } = await launchChatTab({ turns: { write: [{ text: 'ok' }] } })
  try {
    await resizeWindow(app, 1600)
    await sendMessage(page, 'write')
    await expect(page.locator('.chat-host:visible .chat-text')).toHaveCount(1)
    // a mark on the chat's own element: a reopened tab would have a new one
    await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>('.chat-host')].find((h) => h.offsetParent !== null)!.dataset.mark = 'kept' })
    expect(await page.evaluate(() => window.ct.setSetting('chat.fullWidth', true))).toEqual({ ok: true })
    await expect.poll(async () => (await boxOf(page, '.chat-column')).width).toBeGreaterThanOrEqual(1400)
    await expect.poll(async () => (await boxOf(page, '.chat-field')).width).toBeGreaterThanOrEqual(1400)
    expect(await page.locator('.chat-host[data-mark="kept"]').count()).toBe(1)
  } finally {
    await app.close()
  }
})

test('full width takes the agents dock at the end of the conversation along: its card lines up with the message box', async () => {
  const { app, page } = await launchChatTab({
    turns: { team: [{ task: { description: 'Check the totals', result: 'Checked.', agents: [{ type: 'Explore', description: 'Search the sales folder', ms: 20000 }] } }, { text: 'Done.' }] }
  })
  try {
    expect(await page.evaluate(() => window.ct.setSetting('chat.fullWidth', true))).toEqual({ ok: true })
    await resizeWindow(app, 1600)
    await sendMessage(page, 'team')
    await expect(page.locator('.chat-host:visible .chat-agents-dock .chat-agents')).toBeVisible()
    const card = await boxOf(page, '.chat-agents-dock .chat-agents')
    const field = await boxOf(page, '.chat-field')
    expect(field.width).toBeGreaterThanOrEqual(1400)
    expect(Math.abs(card.x - field.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(card.x + card.width - (field.x + field.width))).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
  }
})

test('full width keeps a gutter of 24 px, and 16 px in a window under 600 px wide', async () => {
  const { app, page } = await launchChatTab({ turns: { write: [{ text: 'ok' }] } })
  try {
    expect(await page.evaluate(() => window.ct.setSetting('chat.fullWidth', true))).toEqual({ ok: true })
    await resizeWindow(app, 1600)
    await sendMessage(page, 'write')
    await expect(page.locator('.chat-host:visible .chat-text')).toHaveCount(1)
    const gutter = async (): Promise<number> => Math.round((await boxOf(page, '.chat-field')).x - (await boxOf(page)).x)
    expect(await gutter()).toBe(24)
    await resizeWindow(app, 500)
    await expect.poll(gutter).toBe(16)
  } finally {
    await app.close()
  }
})
