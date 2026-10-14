import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WIN } from '../fixtures/platform'
import { FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab } from './helpers'

const panel = (page: Page) => page.locator('#image-panel')

interface Place { bounds: { x: number; y: number; width: number; height: number }; area: { x: number; width: number }; maximized: boolean }

/** the main window's bounds and the work area of its display */
function place(app: ElectronApplication): Promise<Place> {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getParentWindow() === null)!
    const b = w.getBounds()
    return { bounds: b, area: screen.getDisplayMatching(b).workArea, maximized: w.isMaximized() }
  })
}

interface Layout { termWidth: number; termRight: number; panelLeft: number; panelWidth: number; inner: number }

// measured after two animation frames, once the ResizeObserver -> fit chain has run
function layout(page: Page): Promise<Layout> {
  return page.evaluate(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const t = document.getElementById('terminals')!.getBoundingClientRect()
    const p = document.getElementById('image-panel')!.getBoundingClientRect()
    return { termWidth: t.width, termRight: t.right, panelLeft: p.left, panelWidth: p.width, inner: window.innerWidth }
  })
}

/** every size the active terminal sent to its process */
const ptySizes = (page: Page): Promise<string[]> => page.evaluate(() => window.__ct!.ptySizes!())

/** gives the main window that width and waits until its page and terminal have taken it */
async function setWidth(app: ElectronApplication, page: Page, width: number): Promise<void> {
  const content = await app.evaluate(({ BrowserWindow }, width) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getParentWindow() === null)!
    w.setBounds({ ...w.getBounds(), width })
    return w.getContentBounds().width
  }, width)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(content)
  await layout(page)
}

/** a window narrow enough that its display has room for a panel of `panel` px beside it */
const roomyWidth = (p: Place, panel: number): number => Math.min(800, p.area.width - panel - 40)

test('opening a side panel widens the window by its width: the terminal keeps its size, and closing gives the width back', async () => {
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await setWidth(app, page, roomyWidth(await place(app), 300))
  const start = (await place(app)).bounds
  const before = await layout(page)
  const sizes = await ptySizes(page)

  await page.keyboard.press('Control+Shift+KeyI')
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect.poll(async () => (await place(app)).bounds).toEqual({ ...start, width: start.width + 300 })
  await expect.poll(async () => {
    const l = await layout(page)
    return { termWidth: l.termWidth, panelWidth: l.panelWidth, besideIt: l.panelLeft >= l.termRight - 0.5 }
  }).toEqual({ termWidth: before.termWidth, panelWidth: 300, besideIt: true })
  expect(await ptySizes(page)).toEqual(sizes)

  await page.keyboard.press('Control+Shift+KeyI')
  await expect(panel(page)).toHaveClass(/collapsed/)
  await expect.poll(async () => (await place(app)).bounds).toEqual(start)
  expect((await layout(page)).termWidth).toBe(before.termWidth)
  expect(await ptySizes(page)).toEqual(sizes)
  await app.close()
})

test('switching to a panel of another width changes the window by the difference', async () => {
  const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, imagePanel: { width: 300, autoOpen: false }, review: { width: 400 } })
  await setWidth(app, page, roomyWidth(await place(app), 400))
  const start = (await place(app)).bounds
  const before = await layout(page)
  const sizes = await ptySizes(page)

  await page.keyboard.press('Control+Shift+KeyD')
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 400)
  await page.keyboard.press('Control+Shift+KeyI')
  await expect(page.locator('.panel-title')).toHaveText('Images')
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)
  await expect.poll(async () => (await layout(page)).termWidth).toBe(before.termWidth)
  await page.keyboard.press('Control+Shift+KeyI')
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width)
  expect(await ptySizes(page)).toEqual(sizes)
  await app.close()
})

test('a window with no room to widen shows the panel over the terminal, which keeps its size', async () => {
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await setWidth(app, page, (await place(app)).area.width)
  const start = (await place(app)).bounds
  const before = await layout(page)
  const sizes = await ptySizes(page)

  await page.keyboard.press('Control+Shift+KeyI')
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect.poll(async () => {
    const l = await layout(page)
    return { termWidth: l.termWidth, panelWidth: l.panelWidth, panelLeft: l.panelLeft }
  }).toEqual({ termWidth: before.termWidth, panelWidth: 300, panelLeft: before.inner - 300 })
  expect((await place(app)).bounds).toEqual(start)
  expect(await ptySizes(page)).toEqual(sizes)
  await page.keyboard.press('Control+Shift+KeyI')
  await expect(panel(page)).toHaveClass(/collapsed/)
  expect((await place(app)).bounds).toEqual(start)
  await app.close()
})

test('sidePanel.noRoom "narrow": a window with no room to widen narrows the terminal for the panel', async () => {
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false }, sidePanel: { noRoom: 'narrow' } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await setWidth(app, page, (await place(app)).area.width)
  const start = (await place(app)).bounds
  const before = await layout(page)
  const sizes = await ptySizes(page)

  await page.keyboard.press('Control+Shift+KeyI')
  await expect.poll(async () => {
    const l = await layout(page)
    return { termWidth: l.termWidth, besideIt: l.panelLeft >= l.termRight - 0.5 }
  }).toEqual({ termWidth: before.termWidth - 300, besideIt: true })
  await expect.poll(async () => (await ptySizes(page)).length).toBeGreaterThan(sizes.length)
  expect((await place(app)).bounds).toEqual(start)
  await app.close()
})

test('choosing "Narrow the terminal" in the settings window moves a panel shown over the terminal beside it', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await setWidth(app, page, (await place(app)).area.width)
  const before = await layout(page)
  await page.keyboard.press('Control+Shift+KeyI')
  await expect.poll(async () => (await layout(page)).panelLeft).toBe(before.inner - 300)
  expect((await layout(page)).termWidth).toBe(before.termWidth)

  await page.locator('.terminal-host:visible .xterm').click({ position: { x: 20, y: 20 } })
  const [win] = await Promise.all([app.waitForEvent('window'), page.keyboard.press('Control+Comma')])
  await win.waitForSelector('#settings .settings-heading')
  const select = win.locator('[data-key="sidePanel.noRoom"]')
  await expect(select.locator('option:checked')).toHaveText('Over the terminal')
  await select.selectOption('Narrow the terminal')
  await expect.poll(async () => (await layout(page)).termWidth).toBe(before.termWidth - 300)
  expect((JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { sidePanel?: { noRoom?: string } }).sidePanel?.noRoom).toBe('narrow')
  await app.close()
})

test('the expanded Changes panel lies over the terminal, which keeps its size', async () => {
  const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, imagePanel: { autoOpen: false }, review: { width: 300 } })
  await setWidth(app, page, roomyWidth(await place(app), 300))
  const start = (await place(app)).bounds
  const before = await layout(page)
  const sizes = await ptySizes(page)
  await page.keyboard.press('Control+Shift+KeyD')
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)
  await expect.poll(async () => (await layout(page)).termWidth).toBe(before.termWidth)
  const grown = (await place(app)).bounds

  await page.locator('.review-expand').click()
  await expect(panel(page)).toHaveClass(/expanded/)
  await expect.poll(async () => {
    const l = await layout(page)
    return { termWidth: l.termWidth, panelWidth: l.panelWidth }
  }).toEqual({ termWidth: before.termWidth, panelWidth: Math.round((await layout(page)).inner * 0.85) })
  expect((await place(app)).bounds).toEqual(grown)
  expect(await ptySizes(page)).toEqual(sizes)
  await app.close()
})

test('the saved window size leaves out the width added for the panel', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await setWidth(app, page, roomyWidth(await place(app), 300))
  const start = (await place(app)).bounds
  await page.keyboard.press('Control+Shift+KeyI')
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)
  // a move saves the window state again
  await app.evaluate(({ BrowserWindow }, x) => {
    const w = BrowserWindow.getAllWindows().find((v) => v.getParentWindow() === null)!
    w.setPosition(x, w.getBounds().y)
  }, start.x + 7)
  const saved = (): { x?: number; width: number } => JSON.parse(readFileSync(join(dataDir, 'window-state.json'), 'utf8')).bounds
  await expect.poll(() => { try { return saved().x } catch { return null } }).toBe(start.x + 7)
  expect(saved().width).toBe(start.width)
  await app.close()
})

test('a panel closed while the window was maximized gives its width back when the window is restored', async () => {
  test.skip(!WIN && !process.env.XDG_CURRENT_DESKTOP, 'no desktop (xvfb): there is no window manager to maximize the window')
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await setWidth(app, page, roomyWidth(await place(app), 300))
  const start = (await place(app)).bounds
  await page.keyboard.press('Control+Shift+KeyI')
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.maximize())
  await expect.poll(async () => (await place(app)).maximized).toBe(true)
  // maximized: the panel lies over the right of the terminal
  await expect.poll(async () => {
    const l = await layout(page)
    return Math.round(l.termRight) === l.inner && l.panelLeft === l.inner - 300
  }).toBe(true)
  await page.keyboard.press('Control+Shift+KeyI')
  await expect(panel(page)).toHaveClass(/collapsed/)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.unmaximize())
  await expect.poll(async () => (await place(app)).bounds).toEqual(start)
  await app.close()
})
