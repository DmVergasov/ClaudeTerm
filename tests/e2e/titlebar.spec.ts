import { expect, test } from '@playwright/test'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { StatusMessage } from '../../src/shared/protocol'
import { FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, TEST_SHELL } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

const statusMsg = (tabId: string): StatusMessage => ({
  v: 1,
  type: 'status',
  tabId,
  sessionId: SID,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 },
  fiveHour: { usedPct: 23.5, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
  sevenDay: { usedPct: 41.2, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 }
})

test('the title bar drags the window and its controls do not', async () => {
  const { app, page } = await launchApp()
  const region = (sel: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).getPropertyValue('-webkit-app-region'), sel)
  expect(await region('#titlebar')).toBe('drag')
  // the search field and the limit meters sit in the bar, so they must opt out of the drag region to take the mouse
  expect(await region('#titlebar .tb-search')).toBe('no-drag')
  expect(await region('#titlebar .tb-meters')).toBe('no-drag')
  await expect(page.locator('#titlebar .tb-name')).toHaveText('ClaudeTerm')
  const box = (await page.locator('#titlebar').boundingBox())!
  expect(Math.round(box.height)).toBe(44)
  expect(box.y).toBe(0)
  await app.close()
})

test('full screen drops the traffic lights\' gap', async () => {
  test.skip(process.platform !== 'darwin', 'the traffic lights are macOS only')
  const { app, page } = await launchApp()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true))
  await expect(page.locator('body')).toHaveClass(/fullscreen/)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false))
  await expect(page.locator('body')).not.toHaveClass(/fullscreen/)
  await app.close()
})

test('the limits show for a Claude tab and hide for a shell tab', async () => {
  const { app, page, tabId, pipeName, work } = await launchClaudeTab()
  const meters = page.locator('#titlebar .tb-meters')
  await expect(meters).toBeHidden()
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  await expect(meters).toBeVisible()
  await expect(page.locator('#titlebar .meter-limit .meter-pct')).toHaveText('24%')

  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)
  await expect(meters).toBeHidden()

  await page.locator('.tab').first().click()
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
  await expect(meters).toBeVisible()
  await app.close()
})

test('closing the Claude tab in front takes its limits away from the title bar', async () => {
  const { app, page, tabId, pipeName, work } = await launchClaudeTab()
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  await expect(page.locator('#titlebar .meter-limit')).toHaveCount(1)
  // a shell tab beside it, so the app stays open when the Claude tab closes
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)
  await page.locator('.tab').first().click()
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
  await expect(page.locator('#titlebar .meter-limit')).toHaveCount(1)
  await page.evaluate((id) => window.ct.closeTab(id), tabId)
  await expect(page.locator('#titlebar .meter')).toHaveCount(0)
  await expect(page.locator('#titlebar .tb-meters')).toBeHidden()
  await app.close()
})

test('both limit meters are one line high and equally tall, whatever their reset reads', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const now = Math.floor(Date.now() / 1000)
  const endOfToday = new Date()
  endOfToday.setHours(23, 59, 0, 0)
  // the 5-hour limit resets today (half an hour on, or the end of the day near midnight); the weekly one resets on another day,
  // so its reset reads like "Thu 09:00"; 100% is the widest label
  const fiveReset = Math.min(now + 1800, Math.floor(endOfToday.getTime() / 1000))
  expect(await sendPipeMessage(pipeName, { ...statusMsg(tabId), fiveHour: { usedPct: 42, resetsAt: fiveReset }, sevenDay: { usedPct: 100, resetsAt: now + 3 * 86400 } })).toEqual({ ok: true })
  const meters = [page.locator('#titlebar .meter-limit'), page.locator('#titlebar .meter-week')]
  await expect(meters[1]!.locator('.meter-reset')).toHaveText(/^[A-Z][a-z]{2} \d\d:\d\d$/)
  await expect(meters[0]!.locator('.meter-reset')).toHaveText(/^\d\d:\d\d$/)
  const boxes = await Promise.all(meters.map((m) => m.boundingBox()))
  expect(Math.abs(boxes[0]!.height - boxes[1]!.height)).toBeLessThanOrEqual(0.5)
  for (const m of meters) {
    const head = m.locator('.meter-head')
    const lineHeight = await head.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
    expect(Number.isNaN(lineHeight)).toBe(false)
    expect((await head.boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 1.5)
    expect(await m.locator('.meter-reset').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  await app.close()
})

test('the search field opens Recent sessions', async () => {
  const { app, page } = await launchApp()
  const sessions = page.locator('#sessions')
  await expect(sessions).toBeHidden()
  await page.locator('#titlebar .tb-search').click()
  await expect(sessions).toBeVisible()
  await expect(page.locator('#titlebar .tb-search')).toHaveText(/Search past sessions/)
  await app.close()
})

test('the menus and the overlays opt out of the drag region, so a click on their top strip reaches them', async () => {
  const { app, page } = await launchApp()
  await page.locator('#tabbar .tab-menu').click()
  await expect(page.locator('.menu')).toBeVisible()
  // the overlays are checked whether they are open or not: the rule is static, and their top strip lies in the bar's drag strip
  for (const sel of ['.menu', '#lightbox', '#sessions', '#folder-dialog', '#plan-list', '#search', '#toasts']) {
    const region = await page.evaluate((s) => getComputedStyle(document.querySelector(s)!).getPropertyValue('-webkit-app-region'), sel)
    expect(region, sel).toBe('no-drag')
  }
  await app.close()
})

test('a menu taller than the window stays below the title bar, inside the window, and its rows scroll', async () => {
  // fourteen profiles make the ▾ menu taller than the room under the bar, whatever shells this machine has
  const profiles = Array.from({ length: 14 }, (_, i) => ({ name: `Profile ${i + 1}`, command: TEST_SHELL, args: [] }))
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, profiles } })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.setSize(800, 300))
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(400)
  await page.locator('#tabbar .tab-menu').click()
  const menu = page.locator('.menu')
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  const bar = (await page.locator('#titlebar').boundingBox())!
  const windowHeight = await page.evaluate(() => window.innerHeight)
  expect(box.y, 'the menu rises under the title bar').toBeGreaterThanOrEqual(bar.y + bar.height)
  expect(box.y + box.height, 'the menu ends inside the window').toBeLessThanOrEqual(windowHeight)
  // the menu scrolls: its last row can be brought into view and is then inside the window
  expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await menu.evaluate((el) => { el.scrollTop = el.scrollHeight })
  const last = (await page.locator('.menu-item').last().boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(windowHeight)
  await app.close()
})

test('at the minimum width the search field and the meters do not overlap, nor run under the window buttons', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  await expect(page.locator('#titlebar .tb-meters')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.setSize(480, 800))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(500)
  const search = (await page.locator('#titlebar .tb-search').boundingBox())!
  const meters = (await page.locator('#titlebar .tb-meters').boundingBox())!
  const bar = (await page.locator('#titlebar').boundingBox())!
  // the window buttons take the bar's right padding: the meters must end before it
  const padRight = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('titlebar')!).paddingRight))
  expect(search.x + search.width, 'the search field runs into the meters').toBeLessThanOrEqual(meters.x + 0.5)
  expect(meters.x + meters.width, 'the meters run under the window buttons').toBeLessThanOrEqual(bar.x + bar.width - padRight + 0.5)
  await app.close()
})

test('the title bar\'s search field is 30 px high, and the window\'s scrollbars are dark', async () => {
  const { app, page } = await launchApp()
  expect(Math.round((await page.locator('#titlebar .tb-search').boundingBox())!.height)).toBe(30)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
  await app.close()
})

test('wherever the app name shows, the search text is whole and nothing overlaps; at 900 px both are visible', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  await expect(page.locator('#titlebar .tb-meters')).toBeVisible()
  // a resized window's page is wider than its size by the frame Windows draws around it (16 px), and as wide on macOS and Linux
  const frame = process.platform === 'win32' ? 16 : 0
  const setWidth = async (width: number): Promise<void> => {
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows().find((x) => x.getParentWindow() === null)!.setSize(w, 800), width)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width + frame)
  }
  // the widths around the threshold: where the name shows, the full layout must fit
  for (const width of [820, 830, 839, 850]) {
    await setWidth(width)
    const name = await page.locator('#titlebar .tb-name').boundingBox()
    if (name === null) continue
    const search = (await page.locator('#titlebar .tb-search').boundingBox())!
    const meters = (await page.locator('#titlebar .tb-meters').boundingBox())!
    const bar = (await page.locator('#titlebar').boundingBox())!
    const padRight = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('titlebar')!).paddingRight))
    const text = await page.locator('#titlebar .tb-search-text').evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5)
    expect(text, `the search text is cut at ${width} px`).toBe(true)
    expect(name.x + name.width, `the name runs into the search field at ${width} px`).toBeLessThanOrEqual(search.x + 0.5)
    expect(search.x + search.width, `the search field runs into the meters at ${width} px`).toBeLessThanOrEqual(meters.x + 0.5)
    expect(meters.x + meters.width, `the meters run under the window buttons at ${width} px`).toBeLessThanOrEqual(bar.x + bar.width - padRight + 0.5)
  }
  // a comfortable width: the name and the search text are in the bar
  await setWidth(900)
  await expect(page.locator('#titlebar .tb-name')).toBeVisible()
  await expect(page.locator('#titlebar .tb-search-text')).toBeVisible()
  await expect(page.locator('#titlebar .tb-search-text')).toHaveText(/Search past sessions/)
  await app.close()
})
