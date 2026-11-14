import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { settingsWindow } from './account-helpers'
import { FAKE_CLAUDE_SETTINGS, KEYS, launchApp, launchClaudeTab, showSettingsTab } from './helpers'

// The theme colours the whole app: the window's frame, its panels, menus and dialogs, the Settings window and the windows' own
// chrome. One Half Light is the light theme the tests use; Graphite must look as it always has.

const LIGHT = 'One Half Light'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

/** the value a selector's first element computes to for a style property, named as getComputedStyle names it */
function computed(page: Page, selector: string, property: string): Promise<string> {
  return page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p as 'color'], property)
}

/** the background a part shows: its own, or that of the nearest ancestor that is not transparent */
function surface(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => {
    for (let at: Element | null = el; at !== null; at = at.parentElement) {
      const bg = getComputedStyle(at).backgroundColor
      if (bg !== 'rgba(0, 0, 0, 0)') return bg
    }
    return ''
  })
}

/** the relative luminance of a computed rgb() or rgba() colour, its alpha left out: 0 is black, 1 is white */
function luminance(css: string): number {
  const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** the theme set as the Settings window sets it */
async function setTheme(page: Page, theme: string): Promise<void> {
  await page.evaluate((t) => window.ct.setSetting('theme', t), theme)
}

/** Claude reports a status for the tab: the status bar shows */
async function showStatusBar(page: Page, pipeName: string, tabId: string): Promise<void> {
  const status = { v: 1 as const, type: 'status' as const, tabId, sessionId: SID, model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null, sevenDay: null }
  expect(await sendPipeMessage(pipeName, status)).toEqual({ ok: true })
  await expect(page.locator('#statusbar')).toBeVisible()
}

test('in a light theme the title bar, the tab bar, the sheet and the status bar are light, with dark text', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, theme: LIGHT })
  try {
    await showStatusBar(page, pipeName, tabId)
    await expect.poll(() => computed(page, '#titlebar', 'backgroundColor')).toBe('rgb(250, 250, 250)')
    expect(await computed(page, '#tabbar', 'backgroundColor')).toBe('rgb(250, 250, 250)')
    expect(await computed(page, '#sheet', 'backgroundColor')).toBe('rgb(247, 247, 247)')
    expect(await surface(page, '#statusbar')).toBe('rgb(247, 247, 247)')
    expect(await computed(page, '#statusbar', 'color')).toBe('rgb(125, 126, 131)')
    expect(await computed(page, '.tb-name', 'color')).toBe('rgb(56, 58, 66)')
    expect(await computed(page, 'html', 'colorScheme')).toBe('light')
  } finally {
    await app.close()
  }
})

test('Graphite keeps the colours the window has always had', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  try {
    await showStatusBar(page, pipeName, tabId)
    expect(await computed(page, '#titlebar', 'backgroundColor')).toBe('rgb(10, 10, 12)')
    expect(await computed(page, '#tabbar', 'backgroundColor')).toBe('rgb(10, 10, 12)')
    expect(await computed(page, '#sheet', 'backgroundColor')).toBe('rgb(17, 17, 20)')
    expect(await computed(page, '#statusbar', 'color')).toBe('rgb(140, 140, 150)')
    expect(await computed(page, '.tb-name', 'color')).toBe('rgb(237, 237, 240)')
    expect(await computed(page, '#tabbar .tab.active', 'boxShadow')).toContain('rgb(39, 39, 46)')
    expect(await computed(page, '#image-panel', 'backgroundColor')).toBe('rgb(15, 15, 18)')
    expect(await computed(page, 'html', 'colorScheme')).toBe('dark')
    await page.locator('#tabbar .tab-menu').click()
    await expect(page.locator('.menu')).toBeVisible()
    expect(await computed(page, '.menu', 'backgroundColor')).toBe('rgb(22, 22, 26)')
    await page.locator('.menu-item').first().hover()
    await expect.poll(() => computed(page, '.menu-item', 'backgroundColor')).toBe('rgb(34, 34, 42)')
  } finally {
    await app.close()
  }
})

test('a theme change reaches the whole window at once, without a restart', async () => {
  const { app, page, tabId } = await launchClaudeTab()
  try {
    await setTheme(page, LIGHT)
    await expect.poll(() => computed(page, '#titlebar', 'backgroundColor')).toBe('rgb(250, 250, 250)')
    expect(await computed(page, '#sheet', 'backgroundColor')).toBe('rgb(247, 247, 247)')
    expect(await computed(page, 'html', 'colorScheme')).toBe('light')
    expect(await page.evaluate(() => window.__ct!.activeTabId())).toBe(tabId)
    await setTheme(page, 'Graphite')
    await expect.poll(() => computed(page, '#titlebar', 'backgroundColor')).toBe('rgb(10, 10, 12)')
    expect(await computed(page, '#sheet', 'backgroundColor')).toBe('rgb(17, 17, 20)')
    expect(await computed(page, 'html', 'colorScheme')).toBe('dark')
  } finally {
    await app.close()
  }
})

test('in a light theme the tab bar and the menus are light: the active tab\'s edge, a menu item under the pointer', async () => {
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, theme: LIGHT } })
  try {
    await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
    await expect.poll(() => computed(page, '#tabbar .tab.active', 'boxShadow')).toContain('rgb(224, 224, 225)')
    await page.locator('#tabbar .tab-menu').click()
    await page.locator('.menu-item').first().hover()
    await expect.poll(() => computed(page, '.menu-item', 'backgroundColor')).toBe('rgb(229, 229, 230)')
  } finally {
    await app.close()
  }
})

test('in a light theme Recent sessions opens on a light scrim, with a light scheme', async () => {
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, theme: LIGHT } })
  try {
    await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
    await page.locator('.terminal-host:visible .xterm').click()
    await page.keyboard.press(KEYS.recentSessions)
    await expect(page.locator('#sessions')).toBeVisible()
    expect(luminance(await computed(page, '#sessions', 'backgroundColor'))).toBeGreaterThan(0.7)
    expect(await computed(page, '.sessions-box', 'colorScheme')).toBe('light')
  } finally {
    await app.close()
  }
})

/** the Settings window, opened as the window's own button opens it, once its page is up */
async function openSettingsWindow(app: ElectronApplication, page: Page): Promise<Page> {
  const win = await settingsWindow(app, page)
  await win.waitForSelector('#settings .section-title')
  return win
}

test('the Settings window takes the theme, and a hand edit of settings.json reaches both windows at once', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, theme: LIGHT } })
  try {
    await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
    const win = await openSettingsWindow(app, page)
    await expect.poll(() => computed(win, 'body', 'backgroundColor')).toBe('rgb(250, 250, 250)')
    expect(await computed(win, '#settings-titlebar', 'backgroundColor')).toBe('rgb(250, 250, 250)')
    expect(await computed(win, '.section-body', 'backgroundColor')).toBe('rgb(247, 247, 247)')
    expect(await computed(win, 'body', 'color')).toBe('rgb(56, 58, 66)')
    expect(await computed(win, 'body', 'colorScheme')).toBe('light')
    expect(await computed(win, 'select', 'colorScheme')).toBe('light')
    await showSettingsTab(win, 'appearance')
    await expect.poll(() => win.locator('#h-setting-theme').evaluate((h) => h.childNodes[0].textContent)).toBe('Theme')
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...FAKE_CLAUDE_SETTINGS, theme: 'Graphite' }))
    await expect.poll(() => computed(win, 'body', 'backgroundColor')).toBe('rgb(10, 10, 12)')
    expect(await computed(win, 'body', 'colorScheme')).toBe('dark')
    await expect.poll(() => computed(page, '#titlebar', 'backgroundColor')).toBe('rgb(10, 10, 12)')
  } finally {
    await app.close()
  }
})

test('in a light theme the side panel is light, with dark text', async () => {
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, theme: LIGHT } })
  try {
    await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
    await page.locator('#sheet-header .tab-images-toggle').click()
    await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
    expect(await computed(page, '#image-panel', 'backgroundColor')).toBe('rgb(249, 249, 249)')
    expect(await computed(page, '#image-panel .panel-title', 'color')).toBe('rgb(56, 58, 66)')
  } finally {
    await app.close()
  }
})
