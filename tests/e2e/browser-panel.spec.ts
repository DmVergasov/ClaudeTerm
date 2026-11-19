import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { browserCmd, leavePromptsToClaudeTerm, startSiteServer, type SiteServer } from './browser-helpers'
import { launchClaudeTab, openTabInFront, panelSettled, seenToasts, watchToasts } from './helpers'

// The Browser panel: the side panel's Browser tab of a local Claude tab, its page strip, its navigation row, the control line
// and the shortcut. The pages are local ones of the site server; the panel's view is the native page main lays over its body.

const PANEL = '.panel-browser'
const ADDRESS = `${PANEL} .browser-address`
const PAGE = `${PANEL} .browser-page`
const STAGE = `${PANEL} .browser-stage`
const CONTROL = `${PANEL} .browser-control`
const STILL = `${PANEL} .browser-still`
const EMPTY = `${PANEL} .browser-empty`
const RELOAD = `${PANEL} .browser-reload`
const TITLE = '#image-panel .panel-title'
const TOGGLE = '#sheet-header .tab-browser-toggle'
const SHORTCUT = process.platform === 'darwin' ? 'Meta+KeyB' : 'Control+Shift+KeyB'

interface Box { x: number; y: number; width: number; height: number }

/** the body's rect the page is laid over, in CSS pixels */
function stageBox(page: Page): Promise<Box> {
  return page.evaluate((selector) => {
    const r = document.querySelector(selector)!.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, STAGE)
}

/** the bounds main gave the shown page's view, in window pixels; null when no view shows the URL */
function shownPageBounds(app: ElectronApplication, url: string): Promise<Box | null> {
  return app.evaluate(({ BrowserWindow }, target) => {
    const win = BrowserWindow.getAllWindows()[0]
    const view = win.contentView.children.find((v) => (v as { webContents?: { getURL(): string } }).webContents?.getURL() === target)
    return view ? view.getBounds() : null
  }, url)
}

/** whether the shown view sits on the stage: the stage's CSS rect times the zoom, edges rounded as main rounds them */
async function viewMatchesStage(app: ElectronApplication, page: Page, url: string, zoom: number): Promise<boolean> {
  const r = await stageBox(page)
  const b = await shownPageBounds(app, url)
  if (b === null) return false
  const x = Math.round(r.x * zoom)
  const y = Math.round(r.y * zoom)
  return b.x === x && b.y === y && b.width === Math.round((r.x + r.width) * zoom) - x && b.height === Math.round((r.y + r.height) * zoom) - y
}

function stillSource(page: Page): Promise<string> {
  return page.evaluate((selector) => document.querySelector<HTMLImageElement>(selector)?.getAttribute('src') ?? '', STILL)
}

test('the panel shows the page', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(TITLE)).toHaveText('Browser')
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/form'))
    await expect(page.locator(PAGE)).toHaveCount(1)
    await expect(page.locator(PAGE)).toHaveText('Form')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the person types an address', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/form'))
    await page.locator(ADDRESS).fill(`127.0.0.1:${site.port}/page`)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })).info ?? '').toContain('Other page')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the person\'s address leaves a page that guards its unload', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  leavePromptsToClaudeTerm(app)
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/guard') })
    // the Arm button is clicked through the page's debugger, as the person's click is: the page then asks before it unloads
    const arm = /button "Arm"[^\n]*\[ref=(e\d+)\]/.exec((await browserCmd(pipeName, tabId, { op: 'snapshot' })).info ?? '')
    expect(arm).not.toBeNull()
    expect(await browserCmd(pipeName, tabId, { op: 'click', ref: arm![1], element: 'Arm' })).toMatchObject({ ok: true })
    await page.locator(ADDRESS).fill(site.url('/page'))
    await page.keyboard.press('Enter')
    // the dialog line goes with the first reply that takes it: every reply's text is kept
    const footers: string[] = []
    await expect.poll(async () => {
      const info = (await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })).info ?? ''
      footers.push(info)
      return info
    }).toContain('Other page')
    expect(footers.join('\n')).toContain('- Dialog: beforeunload "Leave site?" → OK')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('an address that is no address sends nothing: the field shakes and keeps the text', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(PAGE)).toHaveCount(1)
    // records whether the field ever got the shaking class, since the class goes once the shake ends
    await page.evaluate((selector) => {
      const field = document.querySelector(selector)!
      const w = window as unknown as { __shook: boolean }
      w.__shook = false
      new MutationObserver(() => { if (field.classList.contains('shaking')) w.__shook = true }).observe(field, { attributes: true, attributeFilter: ['class'] })
    }, ADDRESS)
    await page.locator(ADDRESS).fill('   ')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shook: boolean }).__shook)).toBe(true)
    await expect(page.locator(ADDRESS)).toHaveValue('   ')
    // the list answers after the pipe has handled the Enter: no second page was made
    const list = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })
    expect(list.info ?? '').not.toMatch(/(^|\s)1: /)
    await expect(page.locator(PAGE)).toHaveCount(1)
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the address field keeps what the person is typing while it has the focus', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/form'))
    await page.locator(ADDRESS).click()
    await page.locator(ADDRESS).fill('half a typed address')
    // the page changes under the field while it has the focus: the typed text stays
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page') })
    await expect(page.locator(PAGE)).toHaveText('Other page')
    await expect(page.locator(ADDRESS)).toHaveValue('half a typed address')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the person manages pages', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(PAGE)).toHaveCount(1)
    // + adds a blank page, which is then in front, and its field is empty
    await page.locator(`${PANEL} .browser-new-page`).click()
    await expect(page.locator(PAGE)).toHaveCount(2)
    await expect(page.locator(ADDRESS)).toHaveValue('')
    // a click on the first page shows it
    await page.locator(PAGE).first().click()
    await expect.poll(async () => (await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })).info ?? '').toMatch(/^\* 0: Form/m)
    // × closes the second page
    await page.locator(`${PANEL} .browser-page-close`).nth(1).click()
    await expect(page.locator(PAGE)).toHaveCount(1)
  } finally {
    await site?.close()
    await app.close()
  }
})

test('back, forward and reload move between the pages of the history', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page') })
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/page'))
    await page.locator(`${PANEL} .browser-back`).click()
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/form'))
    await page.locator(`${PANEL} .browser-forward`).click()
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/page'))
    await page.locator(`${PANEL} .browser-reload`).click()
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/page'))
    await expect(page.locator(PAGE)).toHaveText('Other page')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('reload loads the page again', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/count') })
    await expect(page.locator(PAGE)).toHaveText('Load 1')
    await page.locator(RELOAD).click()
    await expect(page.locator(PAGE)).toHaveText('Load 2')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('stop loading ends a slow page', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(PAGE)).toHaveCount(1)
    // the person types the slow page's address: its body is held for 20 s, so the page stays loading
    await page.locator(ADDRESS).fill(site.url('/slow'))
    await page.keyboard.press('Enter')
    await expect(page.locator(RELOAD)).toHaveAttribute('title', 'Stop loading', { timeout: 15_000 })
    await page.locator(RELOAD).click()
    await expect(page.locator(RELOAD)).toHaveAttribute('title', 'Reload', { timeout: 5_000 })
  } finally {
    await site?.close()
    await app.close()
  }
})

test('a covering menu shows a still image of the page; the still goes when the menu closes', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(PAGE)).toHaveCount(1)
    await page.locator(`${PANEL} .browser-more`).click()
    await expect(page.locator('.menu')).toBeVisible()
    // the menu lies over the page: the still of the page fills the stage
    await expect.poll(async () => stillSource(page), { timeout: 15_000 }).toMatch(/^data:image\/png;base64,/)
    expect((await stillSource(page)).length).toBeGreaterThan(1000)
    const still = await page.locator(STILL).boundingBox()
    const stage = await stageBox(page)
    expect(still?.width).toBeCloseTo(stage.width, 0)
    expect(still?.height).toBeCloseTo(stage.height, 0)
    // the still is a picture of the page, not one colour: two or more colours in its pixels
    const colours = await page.evaluate(async (selector) => {
      const img = document.querySelector<HTMLImageElement>(selector)!
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      const seen = new Set<number>()
      for (let i = 0; i < data.length; i += 4 * 97) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
      return seen.size
    }, STILL)
    expect(colours).toBeGreaterThan(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.menu')).toHaveCount(0)
    await expect(page.locator(STILL)).toHaveCount(0)
  } finally {
    await site?.close()
    await app.close()
  }
})

test('bounds follow the zoom', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(PANEL)).toBeVisible()
    // the view's bounds are window pixels: the body's CSS rect times the zoom factor, edges rounded
    await expect.poll(() => viewMatchesStage(app, page, site!.url('/form'), 1), { timeout: 15_000 }).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
    await expect.poll(() => viewMatchesStage(app, page, site!.url('/form'), 1.25), { timeout: 15_000 }).toBe(true)
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the panel expands over the terminal and collapses back', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const url = site.url('/form')
    await browserCmd(pipeName, tabId, { op: 'navigate', url })
    await expect(page.locator(PANEL)).toBeVisible()
    await expect.poll(() => viewMatchesStage(app, page, url, 1), { timeout: 15_000 }).toBe(true)
    const narrow = await shownPageBounds(app, url)
    const expandButton = page.locator(`${PANEL} .browser-expand`)
    await expect(expandButton).toHaveAttribute('title', 'Expand')
    await expect(expandButton).not.toHaveClass(/active/)
    await expandButton.click()
    await expect(page.locator('#image-panel')).toHaveClass(/expanded/)
    // lit, and it now says what the next click does
    await expect(expandButton).toHaveClass(/active/)
    await expect(expandButton).toHaveAttribute('title', 'Collapse')
    await expect.poll(() => viewMatchesStage(app, page, url, 1), { timeout: 15_000 }).toBe(true)
    const wide = await shownPageBounds(app, url)
    expect(wide!.width).toBeGreaterThan(narrow!.width)
    await expandButton.click()
    await expect(page.locator('#image-panel')).not.toHaveClass(/expanded/)
    await expect(expandButton).not.toHaveClass(/active/)
    await expect(expandButton).toHaveAttribute('title', 'Expand')
    // the window gives its room back in whole device pixels: the width is back to the first one, within a pixel
    await expect.poll(async () => Math.abs(((await shownPageBounds(app, url))?.width ?? 0) - narrow!.width), { timeout: 15_000 }).toBeLessThanOrEqual(1)
    await expect.poll(() => viewMatchesStage(app, page, url, 1), { timeout: 15_000 }).toBe(true)
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the panel switcher has a Browser button', async () => {
  const { app, page, work } = await launchClaudeTab()
  try {
    const button = page.locator(TOGGLE)
    await expect(button).toBeVisible()
    // drawn like the other toggles: no default button frame, and the same background as the Media toggle
    const looks = (selector: string): Promise<{ background: string; border: string; color: string }> => page.locator(selector).evaluate((el) => {
      const s = getComputedStyle(el)
      return { background: s.backgroundColor, border: s.borderTopWidth, color: s.color }
    })
    const media = await looks('#sheet-header .tab-images-toggle')
    const idle = await looks(TOGGLE)
    expect(idle.background).toBe(media.background)
    expect(idle.border).toBe(media.border)
    await button.click()
    // lit while the panel shows: its colour changes
    await expect(button).toHaveClass(/active/)
    expect((await looks(TOGGLE)).color).not.toBe(idle.color)
    await expect(page.locator(PANEL)).toBeVisible()
    await expect(button).toHaveClass(/active/)
    await button.click()
    await expect(page.locator('#image-panel')).toHaveClass(/collapsed/)
    await expect(button).not.toHaveClass(/active/)
    await openTabInFront(page, 'shell', work)
    await expect(button).toBeHidden()
  } finally {
    await app.close()
  }
})

test('the ⋯ menu offers Clear this profile\'s data always, and DevTools only while there is a page', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator(TITLE)).toHaveText('Browser')
    await expect(page.locator(`${PANEL} .browser-more`)).toBeEnabled()
    await page.locator(`${PANEL} .browser-more`).click()
    await expect(page.locator('.menu .menu-item')).toHaveText(['Clear this profile\'s data…'])
    await page.keyboard.press('Escape')
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await page.locator(`${PANEL} .browser-more`).click()
    await expect(page.locator('.menu .menu-item')).toHaveText(['Open DevTools', 'Clear this profile\'s data…'])
    await page.keyboard.press('Escape')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the empty state shows in a fresh Claude tab when the panel is opened', async () => {
  const { app, page } = await launchClaudeTab()
  try {
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator(TITLE)).toHaveText('Browser')
    await expect(page.locator(EMPTY)).toHaveText('Claude can open pages here, or type an address above.')
    await expect(page.locator(PAGE)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('the shortcut toggles the panel', async () => {
  const { app, page } = await launchClaudeTab()
  try {
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator(TITLE)).toHaveText('Browser')
    await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('#image-panel')).toHaveClass(/collapsed/)
  } finally {
    await app.close()
  }
})

test('a hidden panel leaves no trace on the body: the class and the width variable go with it', async () => {
  const { app, page } = await launchClaudeTab()
  try {
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator(TITLE)).toHaveText('Browser')
    await expect(page.locator('body')).toHaveClass(/browser-shown/)
    expect(await page.evaluate(() => document.body.style.getPropertyValue('--browser-panel-width'))).not.toBe('')
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('#image-panel')).toHaveClass(/collapsed/)
    await expect(page.locator('body')).not.toHaveClass(/browser-shown/)
    expect(await page.evaluate(() => document.body.style.getPropertyValue('--browser-panel-width'))).toBe('')
  } finally {
    await app.close()
  }
})

test('a navigation does not reopen the panel the person closed', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(TITLE)).toHaveText('Browser')
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('body')).not.toHaveClass(/browser-shown/)
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page') })
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/page'))
    await expect(page.locator('body')).not.toHaveClass(/browser-shown/)
  } finally {
    await site?.close()
    await app.close()
  }
})

test('a background tab does not open or change the panel', async () => {
  const { app, page, pipeName, tabId: first, work } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    // the second tab is in front, its panel closed
    await openTabInFront(page, 'claude', work)
    await expect(page.locator('body')).not.toHaveClass(/browser-shown/)
    await browserCmd(pipeName, first, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator('body')).not.toHaveClass(/browser-shown/)
    // the second tab's panel shows its own empty state; the first tab's navigation changes nothing in it
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator(EMPTY)).toBeVisible()
    await browserCmd(pipeName, first, { op: 'navigate', url: site.url('/form') })
    await expect.poll(async () => (await browserCmd(pipeName, first, { op: 'tabs', action: 'list' })).info ?? '').toContain('Form')
    await expect(page.locator(EMPTY)).toBeVisible()
    await expect(page.locator(PAGE)).toHaveCount(0)
    // the first tab in front again: its strip shows its page
    await page.evaluate((id) => window.ct.activateTab(id), first)
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
    await expect(page.locator(PAGE)).toHaveText(['Form'])
  } finally {
    await site?.close()
    await app.close()
  }
})

/** a toast raised by a shell tab that asks for a profile which does not exist; the Claude tab is then brought back in front (a toast lasts 6 s) */
async function raiseToast(page: Page, tabId: string, work: string): Promise<void> {
  await watchToasts(page)
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd, profile: 'No such profile' }), work)
  await expect.poll(() => seenToasts(page), { timeout: 15_000 }).not.toEqual([])
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
}

test('toasts stay left of the panel while it shows', async () => {
  const { app, page, tabId, work } = await launchClaudeTab()
  try {
    await raiseToast(page, tabId, work)
    // the panel comes back in front of the toast, then settles; the toast's right edge is left of the panel's left edge
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('body')).toHaveClass(/browser-shown/)
    await panelSettled(page)
    await expect.poll(() => page.evaluate(() => {
      const toast = document.querySelector('.toast')?.getBoundingClientRect()
      const panel = document.getElementById('image-panel')!.getBoundingClientRect()
      return toast !== undefined && toast.width > 0 && toast.right <= panel.left
    }), { timeout: 5_000 }).toBe(true)
  } finally {
    await app.close()
  }
})

test('a toast over an expanded panel covers the page with its still; the still goes with the toast', async () => {
  const { app, page, pipeName, tabId, work } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(PAGE)).toHaveCount(1)
    await raiseToast(page, tabId, work)
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('body')).toHaveClass(/browser-shown/)
    // expanded, the panel covers the sheet: the toast lies over the page, so the page is shown as its still while the toast is up
    await page.locator(`${PANEL} .browser-expand`).click()
    await expect(page.locator('#image-panel')).toHaveClass(/expanded/)
    await expect.poll(() => stillSource(page), { timeout: 5_000 }).toMatch(/^data:image\/png;base64,/)
    // an expanded panel does not push the toast left: it keeps its 12 px from the window's right edge
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('.toast')?.getBoundingClientRect().right ?? -1)), { timeout: 5_000 }).toBe(await page.evaluate(() => window.innerWidth - 12))
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator(STILL)).toHaveCount(0)
  } finally {
    await site?.close()
    await app.close()
  }
})

/** the bounds the renderer sends (the browser:bounds channel, which main's ipcMain.on receives): each send is recorded as its arguments */
async function recordBounds(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __bounds: unknown[][] }
    g.__bounds = []
    const channel = 'browser:bounds'
    const handlers = ipcMain.listeners(channel)
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      g.__bounds.push(args)
      for (const handler of handlers) (handler as (...a: unknown[]) => void)(event, ...args)
    })
  })
}

function boundsSent(app: ElectronApplication): Promise<unknown[][]> {
  return app.evaluate(() => (globalThis as unknown as { __bounds: unknown[][] }).__bounds)
}

/** an invoke round trip: main answers in the order it got the messages, so the sends before it have been handled */
async function barrier(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.ct.browserState(id), tabId)
}

/** two animation frames: a resize observer's callback of the frame just drawn has run */
async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

test('a panel never shown sends nothing; a shown one sends its place once, and one null when it hides', async () => {
  const { app, page, tabId, work } = await launchClaudeTab()
  try {
    await recordBounds(app)
    const views = (): Promise<number> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length)
    const viewsBefore = await views()
    // never shown: a resize and a tab switch send nothing and add no view to the window
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await openTabInFront(page, 'shell', work)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
    await barrier(page, tabId)
    expect(await boundsSent(app)).toEqual([])
    expect(await views()).toBe(viewsBefore)

    // shown: the place is sent; a resize with nothing moved sends nothing more
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('body')).toHaveClass(/browser-shown/)
    await panelSettled(page)
    await frames(page)
    await barrier(page, tabId)
    const shown = await boundsSent(app)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown[shown.length - 1]).toEqual([tabId, expect.objectContaining({ width: expect.any(Number) })])
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await frames(page)
    await barrier(page, tabId)
    expect(await boundsSent(app)).toHaveLength(shown.length)

    // hidden: exactly one (null, null), then nothing on a further resize
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('body')).not.toHaveClass(/browser-shown/)
    await panelSettled(page)
    await frames(page)
    await barrier(page, tabId)
    expect((await boundsSent(app)).slice(shown.length)).toEqual([[null, null]])
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await frames(page)
    await barrier(page, tabId)
    expect((await boundsSent(app)).slice(shown.length)).toEqual([[null, null]])
  } finally {
    await app.close()
  }
})

test('the address follows a tab switch even while the field has the focus', async () => {
  const { app, page, pipeName, tabId: first, work } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, first, { op: 'navigate', url: site.url('/form') })
    const second = await openTabInFront(page, 'claude', work)
    await browserCmd(pipeName, second, { op: 'navigate', url: site.url('/page') })
    await page.evaluate((id) => window.ct.activateTab(id), first)
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/form'))
    // the person clicks into the field, then the other tab is brought in front
    await page.locator(ADDRESS).click()
    await expect(page.locator(ADDRESS)).toBeFocused()
    await page.evaluate((id) => window.ct.activateTab(id), second)
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, second)
    await expect(page.locator(ADDRESS)).toHaveValue(site.url('/page'))
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the control line follows Claude: Stop while a command runs, hidden a few seconds after it', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(PANEL)).toBeVisible()
    // the navigation's line lingers for a few seconds: the wait starts once the line is empty
    await expect(page.locator(CONTROL)).toHaveText('', { timeout: 15_000 })
    await expect(page.locator(CONTROL)).toBeHidden()
    const pending = browserCmd(pipeName, tabId, { op: 'wait_for', time: 3 })
    await expect(page.locator(CONTROL)).toContainText('Claude is using the browser')
    await expect(page.locator(`${CONTROL} button`, { hasText: 'Stop' })).toBeVisible()
    await pending
    // the line stays for a few seconds after the command, then it is hidden
    await expect(page.locator(CONTROL)).toBeHidden({ timeout: 15_000 })
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the panel is not offered for a shell tab', async () => {
  const { app, page, tabId, work } = await launchClaudeTab()
  try {
    await openTabInFront(page, 'shell', work)
    // the shortcut in the shell tab shows no Browser panel: body.browser-shown flips with the panel, at once
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('body')).not.toHaveClass(/browser-shown/)
    // the same shortcut in the Claude tab opens it; in the shell tab it stays shut
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator('body')).toHaveClass(/browser-shown/)
    await expect(page.locator(TITLE)).toHaveText('Browser')
  } finally {
    await app.close()
  }
})

test('a new Claude tab has no pages of the one before in its panel', async () => {
  const { app, page, pipeName, tabId, work } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await expect(page.locator(PAGE)).toHaveCount(1)
    await openTabInFront(page, 'claude', work)
    await page.keyboard.press(SHORTCUT)
    await expect(page.locator(EMPTY)).toBeVisible()
    await expect(page.locator(PAGE)).toHaveCount(0)
  } finally {
    await site?.close()
    await app.close()
  }
})

type PageKey = { type: 'keyDown' | 'char' | 'keyUp'; keyCode: string; modifiers?: string[] }
type WebContentsLike = { executeJavaScript(script: string): Promise<unknown>; sendInputEvent(e: PageKey): void }

// the shortcut's modifiers as sendInputEvent takes them: ⌘ on macOS, Ctrl+Shift elsewhere
const SHORTCUT_MODIFIERS = process.platform === 'darwin' ? ['meta'] : ['control', 'shift']

/**
 * The page with this address: its own web contents runs the script, then gets the keys, as the keyboard gives them to a page.
 * Nothing here focuses a window: the keys go to the page's web contents directly.
 */
function pageDo(app: ElectronApplication, url: string, script: string, keys: PageKey[] = []): Promise<unknown> {
  return app.evaluate(async ({ BrowserWindow }, { target, script, keys }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const view = win.contentView.children.find((v) => (v as { webContents?: { getURL(): string } }).webContents?.getURL() === target)
    const wc = (view as { webContents?: WebContentsLike } | undefined)?.webContents
    if (!wc) throw new Error(`no page shows ${target}`)
    const result = await wc.executeJavaScript(script)
    for (const k of keys) wc.sendInputEvent(k)
    return result
  }, { target: url, script, keys })
}

/** the keydown codes the page's document saw, from the moment this runs: a recorder in the page, on the capture phase */
const RECORD_KEYS = "window.__keys = []; document.addEventListener('keydown', (e) => window.__keys.push(e.code), true)"

/** how many times main gave a page's key to the window's keyboard (the test run counts it; the window is never focused in a test) */
function keyboardReturns(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as { ctKeyboardReturns?: number }).ctKeyboardReturns ?? 0)
}

test('app shortcuts work while a page has the keyboard', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const form = site.url('/form')
    await browserCmd(pipeName, tabId, { op: 'navigate', url: form })
    await expect(page.locator(TITLE)).toHaveText('Browser')
    // the person clicked into the page: its field has the focus, and a plain key goes to the page
    await pageDo(app, form, "document.getElementById('name').focus()")
    await pageDo(app, form, RECORD_KEYS)
    await pageDo(app, form, 'undefined', [{ type: 'keyDown', keyCode: 'a' }, { type: 'char', keyCode: 'a' }, { type: 'keyUp', keyCode: 'a' }])
    expect(await pageDo(app, form, "document.getElementById('name').value")).toBe('a')
    expect(await pageDo(app, form, 'window.__keys')).toContain('KeyA')
    // the shortcut that shows and hides the panel goes to the window, not to the page: the panel hides, the page keeps its text
    const returns = await keyboardReturns(app)
    await pageDo(app, form, 'undefined', [{ type: 'keyDown', keyCode: 'B', modifiers: SHORTCUT_MODIFIERS }])
    await expect(page.locator('#image-panel')).toHaveClass(/collapsed/)
    expect(await pageDo(app, form, "document.getElementById('name').value")).toBe('a')
    // the page never saw the chord, and the keyboard went back to the window
    expect(await pageDo(app, form, 'window.__keys')).not.toContain('KeyB')
    expect(await keyboardReturns(app)).toBeGreaterThanOrEqual(returns + 1)
  } finally {
    await site?.close()
    await app.close()
  }
})

test("a key Claude presses with press_key never runs an app shortcut", async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const form = site.url('/form')
    await browserCmd(pipeName, tabId, { op: 'navigate', url: form })
    await expect(page.locator(TITLE)).toHaveText('Browser')
    await pageDo(app, form, RECORD_KEYS)
    const returns = await keyboardReturns(app)
    // Claude's own press goes to the page's document as its key: the page sees it, and the panel stays shown.
    // Electron raises before-input-event only for the person's input, never for CDP Input.dispatchKeyEvent, which press_key
    // uses; this test pins that, so a press of Claude's never runs an app shortcut
    const reply = await browserCmd(pipeName, tabId, { op: 'press_key', key: process.platform === 'darwin' ? 'Meta+B' : 'Control+Shift+B' })
    expect(reply.ok).toBe(true)
    expect(await pageDo(app, form, 'window.__keys')).toContain('KeyB')
    await expect(page.locator('body')).toHaveClass(/browser-shown/)
    expect(await keyboardReturns(app)).toBe(returns)
  } finally {
    await site?.close()
    await app.close()
  }
})
