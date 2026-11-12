import { expect, test, type Page } from '@playwright/test'
import { launchChatTab, sendMessage } from './chat-helpers'

/** the numbers of a computed rgb() colour */
function channels(css: string): number[] {
  return (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
}

/** the relative luminance of a computed colour: 0 is black, 1 is white */
function luminance(css: string): number {
  const [r = 0, g = 0, b = 0] = channels(css).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** the colour a selector computes to in the window */
function computed(page: Page, selector: string, property: string): Promise<string> {
  return page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p as 'color'], property)
}

const CHAT = '.chat-host:visible'

/** the theme set as the Settings window sets it: the same setting path the terminals use */
async function setTheme(page: Page, name: string): Promise<void> {
  await page.evaluate((theme) => window.ct.setSetting('theme', theme), name)
}

test("a light theme makes the chat light, with dark text in Claude's answer", async () => {
  const { app, page } = await launchChatTab({ turns: { write: [{ text: 'A plain answer.' }] } })
  try {
    await sendMessage(page, 'write')
    await expect(page.locator('.chat-text', { hasText: 'A plain answer.' })).toHaveCount(1)
    await setTheme(page, 'One Half Light')
    await expect.poll(() => computed(page, CHAT, 'backgroundColor')).toBe('rgb(250, 250, 250)')
    expect(luminance(await computed(page, '.chat-text', 'color'))).toBeLessThan(0.3)
  } finally {
    await app.close()
  }
})

test('Graphite keeps the chat colours it has always had', async () => {
  const { app, page } = await launchChatTab({ turns: { write: [{ text: 'A plain answer.' }] } })
  try {
    await sendMessage(page, 'write')
    await expect(page.locator('.chat-text', { hasText: 'A plain answer.' })).toHaveCount(1)
    expect(await computed(page, CHAT, 'backgroundColor')).toBe('rgb(14, 14, 16)')
    expect(await computed(page, '.chat-text', 'color')).toBe('rgb(218, 218, 223)')
  } finally {
    await app.close()
  }
})

test('a theme change reaches the open chat at once, without reopening its tab', async () => {
  const { app, page } = await launchChatTab({ turns: { write: [{ text: 'A plain answer.' }] } })
  try {
    await sendMessage(page, 'write')
    await expect(page.locator('.chat-text', { hasText: 'A plain answer.' })).toHaveCount(1)
    const tab = await page.evaluate(() => window.__ct!.activeTabId())
    await setTheme(page, 'One Half Light')
    await expect.poll(() => computed(page, CHAT, 'backgroundColor')).toBe('rgb(250, 250, 250)')
    expect(await page.evaluate(() => window.__ct!.activeTabId())).toBe(tab)
    await setTheme(page, 'Graphite')
    await expect.poll(() => computed(page, CHAT, 'backgroundColor')).toBe('rgb(14, 14, 16)')
  } finally {
    await app.close()
  }
})

test('the native scrollbars follow the theme: the chat and the model picker are light in a light theme, dark in Graphite', async () => {
  const { app, page } = await launchChatTab({ turns: { write: [{ text: 'A plain answer.' }] } })
  try {
    await sendMessage(page, 'write')
    await expect(page.locator('.chat-text', { hasText: 'A plain answer.' })).toHaveCount(1)
    await setTheme(page, 'One Half Light')
    await expect.poll(() => computed(page, CHAT, 'colorScheme')).toBe('light')
    await page.locator('.chat-host:visible .chat-model-chip').click()
    await expect(page.locator('.chat-host:visible .chat-model-picker')).toBeVisible()
    expect(await computed(page, '.chat-host:visible .chat-model-picker', 'colorScheme')).toBe('light')
    await page.keyboard.press('Escape')
    await setTheme(page, 'Graphite')
    await expect.poll(() => computed(page, CHAT, 'colorScheme')).toBe('dark')
    await page.locator('.chat-host:visible .chat-model-chip').click()
    await expect(page.locator('.chat-host:visible .chat-model-picker')).toBeVisible()
    expect(await computed(page, '.chat-host:visible .chat-model-picker', 'colorScheme')).toBe('dark')
  } finally {
    await app.close()
  }
})

test('the window frame keeps its colour when the chat changes theme', async () => {
  const { app, page } = await launchChatTab({ turns: { write: [{ text: 'A plain answer.' }] } })
  try {
    await sendMessage(page, 'write')
    await expect(page.locator('.chat-text', { hasText: 'A plain answer.' })).toHaveCount(1)
    const frame = await computed(page, '#titlebar', 'backgroundColor')
    await setTheme(page, 'One Half Light')
    await expect.poll(() => computed(page, CHAT, 'backgroundColor')).toBe('rgb(250, 250, 250)')
    expect(await computed(page, '#titlebar', 'backgroundColor')).toBe(frame)
  } finally {
    await app.close()
  }
})
