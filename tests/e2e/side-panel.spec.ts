import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WIN } from '../fixtures/platform'
import { FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, KEYS, showSettingsTab } from './helpers'
import { setSetting } from './agent-mail'

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
// `inner` is the workspace's right edge, where a panel at the right lies: the sheet's margin and border are outside it
function layout(page: Page): Promise<Layout> {
  return page.evaluate(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const t = document.getElementById('terminals')!.getBoundingClientRect()
    const p = document.getElementById('image-panel')!.getBoundingClientRect()
    return { termWidth: t.width, termRight: t.right, panelLeft: p.left, panelWidth: p.width, inner: document.getElementById('workspace')!.getBoundingClientRect().right }
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

  await page.keyboard.press(KEYS.images)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect.poll(async () => (await place(app)).bounds).toEqual({ ...start, width: start.width + 300 })
  await expect.poll(async () => {
    const l = await layout(page)
    return { termWidth: l.termWidth, panelWidth: l.panelWidth, besideIt: l.panelLeft >= l.termRight - 0.5 }
  }).toEqual({ termWidth: before.termWidth, panelWidth: 300, besideIt: true })
  expect(await ptySizes(page)).toEqual(sizes)

  await page.keyboard.press(KEYS.images)
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

  await page.keyboard.press(KEYS.changes)
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 400)
  await page.keyboard.press(KEYS.images)
  await expect(page.locator('.panel-title')).toHaveText('Media')
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)
  await expect.poll(async () => (await layout(page)).termWidth).toBe(before.termWidth)
  await page.keyboard.press(KEYS.images)
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

  await page.keyboard.press(KEYS.images)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await expect.poll(async () => {
    const l = await layout(page)
    return { termWidth: l.termWidth, panelWidth: l.panelWidth, panelLeft: l.panelLeft }
  }).toEqual({ termWidth: before.termWidth, panelWidth: 300, panelLeft: before.inner - 300 })
  expect((await place(app)).bounds).toEqual(start)
  expect(await ptySizes(page)).toEqual(sizes)
  await page.keyboard.press(KEYS.images)
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

  await page.keyboard.press(KEYS.images)
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
  await page.keyboard.press(KEYS.images)
  await expect.poll(async () => (await layout(page)).panelLeft).toBe(before.inner - 300)
  expect((await layout(page)).termWidth).toBe(before.termWidth)

  await page.locator('.terminal-host:visible .xterm').click({ position: { x: 20, y: 20 } })
  const [win] = await Promise.all([app.waitForEvent('window'), page.keyboard.press(KEYS.settings)])
  await win.waitForSelector('#settings .section-title')
  await showSettingsTab(win, 'appearance')
  await expect(win.locator('[data-key="sidePanel.noRoom"][data-value="overlay"]')).toHaveAttribute('aria-checked', 'true')
  await win.locator('[data-key="sidePanel.noRoom"][data-value="narrow"]').click()
  await expect.poll(async () => (await layout(page)).termWidth).toBe(before.termWidth - 300)
  expect((JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { sidePanel?: { noRoom?: string } }).sidePanel?.noRoom).toBe('narrow')
  await app.close()
})

test('the expanded Changes panel covers the sheet, not the title bar or the tabs, and the terminal keeps its size', async () => {
  const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, imagePanel: { autoOpen: false }, review: { width: 300 } })
  await setWidth(app, page, roomyWidth(await place(app), 300))
  const start = (await place(app)).bounds
  const before = await layout(page)
  const sizes = await ptySizes(page)
  await page.keyboard.press(KEYS.changes)
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)
  await expect.poll(async () => (await layout(page)).termWidth).toBe(before.termWidth)
  const grown = (await place(app)).bounds

  await page.locator('.review-expand').click()
  await expect(panel(page)).toHaveClass(/expanded/)
  await expect.poll(async () => (await layout(page)).termWidth).toBe(before.termWidth)
  // the panel covers the sheet below its header: left, right and bottom match the sheet's box (its own border lies outside the panel),
  // its top is the header's bottom, and it lies below the title bar
  const edges = await page.evaluate(() => {
    const box = (sel: string): DOMRect => document.querySelector(sel)!.getBoundingClientRect()
    const p = box('#image-panel')
    const s = box('#sheet')
    return { left: p.left - s.left, right: s.right - p.right, bottom: s.bottom - p.bottom, top: p.top - box('#sheet-header').bottom, belowTitleBar: p.top - box('#titlebar').bottom }
  })
  for (const side of ['left', 'right', 'bottom'] as const) expect(Math.abs(edges[side] - 1)).toBeLessThanOrEqual(1)
  expect(Math.abs(edges.top)).toBeLessThanOrEqual(1)
  expect(edges.belowTitleBar).toBeGreaterThanOrEqual(0)
  expect((await place(app)).bounds).toEqual(grown)
  expect(await ptySizes(page)).toEqual(sizes)
  // the header's toggles stay clickable while the panel is expanded: Media takes the panel
  await page.locator('#sheet-header .tab-images-toggle').click()
  await expect(page.locator('.panel-title')).toHaveText('Media')
  await app.close()
})

test('the saved window size leaves out the width added for the panel', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await setWidth(app, page, roomyWidth(await place(app), 300))
  const start = (await place(app)).bounds
  await page.keyboard.press(KEYS.images)
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
  await page.keyboard.press(KEYS.images)
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.maximize())
  await expect.poll(async () => (await place(app)).maximized).toBe(true)
  // maximized: the panel lies over the right of the terminal
  await expect.poll(async () => {
    const l = await layout(page)
    return Math.round(l.termRight) === l.inner && l.panelLeft === l.inner - 300
  }).toBe(true)
  await page.keyboard.press(KEYS.images)
  await expect(panel(page)).toHaveClass(/collapsed/)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.unmaximize())
  // x and y are not compared: the test windows start parked off screen, and a restored frameless window is put back on a display
  await expect.poll(async () => { const b = (await place(app)).bounds; return { width: b.width, height: b.height } }).toEqual({ width: start.width, height: start.height })
  expect((await place(app)).maximized).toBe(false)
  await app.close()
})

test('the panel slides in when it opens, and does not when the user asks for reduced motion', async () => {
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  // the panel-in animations that start, counted as they start: a slide that waits for the window may be over by the time it is looked at
  await page.evaluate(() => {
    const w = window as unknown as { slides: number }
    w.slides = 0
    document.getElementById('image-panel')!.addEventListener('animationstart', (e) => { if (e.animationName === 'panel-in') w.slides++ })
  })
  const slides = (): Promise<number> => page.evaluate(() => {
    const w = window as unknown as { slides: number }
    const n = w.slides
    w.slides = 0
    return n
  })

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.locator('#sheet-header .tab-images-toggle').click()
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  expect(await slides()).toBe(1)
  await page.locator('#sheet-header .tab-images-toggle').click()
  await expect(panel(page)).toHaveClass(/collapsed/)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('#sheet-header .tab-images-toggle').click()
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  expect(await slides()).toBe(0)
  await app.close()
})

test('three quick clicks on the Media toggle, open, close, open, leave the panel shown and no resize trailing behind', async () => {
  test.skip(!WIN && !process.env.XDG_CURRENT_DESKTOP, 'no desktop (xvfb): there is no window manager to maximize the window')
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false }, sidePanel: { noRoom: 'narrow' } } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.maximize())
  await expect.poll(async () => (await place(app)).maximized).toBe(true)
  const full = (await layout(page)).termWidth
  const before = await ptySizes(page)

  // the three clicks land within one task, far inside 100 ms; the count of sizes is then sampled on every frame for 400 ms
  const samples = await page.evaluate(() => new Promise<number[]>((resolve) => {
    const b = document.querySelector<HTMLButtonElement>('#sheet-header .tab-images-toggle')!
    b.click()
    b.click()
    b.click()
    const counts: number[] = []
    const t0 = performance.now()
    const frame = (): void => {
      counts.push(window.__ct!.ptySizes!().length)
      if (performance.now() - t0 < 400) requestAnimationFrame(frame)
      else resolve(counts)
    }
    requestAnimationFrame(frame)
  }))
  // a refit per frame would add a size every frame; one resize for the final state is allowed
  expect(Math.max(...samples) - samples[0]!).toBeLessThanOrEqual(1)
  // the changes run one after another: the last open ends its slide, and then the terminal takes its narrow width once
  await expect.poll(async () => (await layout(page)).termWidth).toBe(full - 300)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  const settled = await ptySizes(page)
  expect(settled.length - before.length).toBeLessThanOrEqual(1)
  await page.waitForTimeout(1000)
  expect(await ptySizes(page)).toEqual(settled)
  await app.close()
})

test('an expanded panel keeps the sheet\'s width when the tabs move from the top to the left and back', async () => {
  const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, imagePanel: { autoOpen: false }, review: { width: 300 } })
  await page.keyboard.press(KEYS.changes)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await page.locator('.review-expand').click()
  await expect(panel(page)).toHaveClass(/expanded/)
  // the panel's left and right edges sit on the sheet's inner edges (inside its 1 px border)
  const aligned = async (): Promise<boolean> => {
    const e = await page.evaluate(() => {
      const s = document.querySelector<HTMLElement>('#sheet')!
      const p = document.querySelector('#image-panel')!.getBoundingClientRect()
      const left = s.getBoundingClientRect().left + s.clientLeft
      return { left: p.left - left, right: left + s.clientWidth - p.right }
    })
    return Math.abs(e.left) <= 1 && Math.abs(e.right) <= 1
  }
  await expect.poll(aligned).toBe(true)
  expect(await setSetting(page, 'tabs.position', 'left')).toEqual({ ok: true })
  await expect.poll(aligned).toBe(true)
  expect(await setSetting(page, 'tabs.position', 'top')).toEqual({ ok: true })
  await expect.poll(aligned).toBe(true)
  await app.close()
})

test('the Find shortcut does nothing while an expanded panel covers the terminal, and works again once the panel is back', async () => {
  const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, imagePanel: { autoOpen: false } })
  const findKey = KEYS.find
  await page.keyboard.press(KEYS.changes)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await page.locator('.review-expand').click()
  await expect(panel(page)).toHaveClass(/expanded/)
  await page.keyboard.press(findKey)
  // the find box would sit under the panel and take keys nobody sees: the shortcut is ignored instead
  await expect(page.locator('#search')).toBeHidden()

  await page.locator('.review-expand').click()
  await expect(panel(page)).not.toHaveClass(/expanded/)
  await page.locator('.terminal-host:visible .xterm').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press(findKey)
  await expect(page.locator('#search')).toBeVisible()
  await app.close()
})

interface Frame { at: number; term: number; panel: number; sizes: number }

/** the main area's width, the panel's and the count of terminal sizes on every frame for `ms` after the element at `sel` is clicked */
function framesAfterClick(page: Page, sel: string, ms: number): Promise<Frame[]> {
  return page.evaluate(({ sel, ms }) => new Promise<Frame[]>((resolve) => {
    const out: Frame[] = []
    const t0 = performance.now()
    document.querySelector<HTMLElement>(sel)!.click()
    const frame = (): void => {
      const at = performance.now() - t0
      out.push({
        at,
        term: document.getElementById('terminals')!.getBoundingClientRect().width,
        panel: document.getElementById('image-panel')!.getBoundingClientRect().width,
        sizes: window.__ct!.ptySizes!().length
      })
      if (at < ms) requestAnimationFrame(frame)
      else resolve(out)
    }
    requestAnimationFrame(frame)
  }), { sel, ms })
}

/** the frames as a short text for a failure message: time, main area, panel and sizes */
const timeline = (frames: Frame[]): string => frames.map((f) => `${Math.round(f.at)}ms term=${Math.round(f.term)} panel=${Math.round(f.panel)} sizes=${f.sizes}`).join('\n')

test('a panel closed beside the terminal slides away while the terminal keeps its width, and the window gives the width back after the slide', async () => {
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false } } })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await setWidth(app, page, roomyWidth(await place(app), 300))
  const start = (await place(app)).bounds
  await page.keyboard.press(KEYS.images)
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)
  await expect.poll(async () => (await layout(page)).panelWidth).toBe(300)
  const before = await layout(page)
  const sizes = (await ptySizes(page)).length

  const frames = await framesAfterClick(page, '#sheet-header .tab-images-toggle', 400)
  const log = timeline(frames)
  // the panel passes through the widths between its own and 0: it slides, it does not vanish
  expect(frames.some((f) => f.panel > 0 && f.panel < 300), log).toBe(true)
  // the terminal keeps its width through the slide, and the window takes its width back after it
  expect(frames.every((f) => Math.abs(f.term - before.termWidth) <= 1), log).toBe(true)
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width)
  await expect(panel(page)).toHaveClass(/collapsed/)
  expect(Math.max(...frames.map((f) => f.sizes)) - sizes, log).toBe(0)
  await app.close()
})

test('a panel closed in a window that cannot widen slides away while the terminal widens with it, and the terminal refits once at the end', async () => {
  test.skip(!WIN && !process.env.XDG_CURRENT_DESKTOP, 'no desktop (xvfb): there is no window manager to maximize the window')
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false }, sidePanel: { noRoom: 'narrow' } } })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.maximize())
  await expect.poll(async () => (await place(app)).maximized).toBe(true)
  const full = (await layout(page)).termWidth
  await page.keyboard.press(KEYS.images)
  await expect.poll(async () => (await layout(page)).termWidth).toBe(full - 300)
  const sizes = (await ptySizes(page)).length

  const frames = await framesAfterClick(page, '#sheet-header .tab-images-toggle', 400)
  const log = timeline(frames)
  // the panel passes through its widths, and the terminal through the widths between the narrow one and the full one
  expect(frames.some((f) => f.panel > 0 && f.panel < 300), log).toBe(true)
  expect(frames.some((f) => f.term > full - 300 + 1 && f.term < full - 1), log).toBe(true)
  // the full width is back within 250 ms of the close: the terminal does not wait for a window that cannot widen
  const back = frames.find((f) => f.term >= full - 1)
  expect(back && back.at <= 250, log).toBe(true)
  // one refit, for the final size, and no size on the way
  expect(Math.max(...frames.map((f) => f.sizes)) - sizes, log).toBeLessThanOrEqual(1)
  await expect(panel(page)).toHaveClass(/collapsed/)
  await app.close()
})

test('under reduced motion a panel closed in a window that cannot widen is gone and the terminal full at once', async () => {
  test.skip(!WIN && !process.env.XDG_CURRENT_DESKTOP, 'no desktop (xvfb): there is no window manager to maximize the window')
  const { app, page } = await launchApp({ settings: { imagePanel: { width: 300, autoOpen: false }, sidePanel: { noRoom: 'narrow' } } })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.maximize())
  await expect.poll(async () => (await place(app)).maximized).toBe(true)
  const full = (await layout(page)).termWidth
  await page.keyboard.press(KEYS.images)
  await expect.poll(async () => (await layout(page)).termWidth).toBe(full - 300)

  const frames = await framesAfterClick(page, '#sheet-header .tab-images-toggle', 400)
  const log = timeline(frames)
  // no slide: the panel is never part of a frame between its width and 0
  expect(frames.every((f) => f.panel === 0 || f.panel === 300), log).toBe(true)
  const back = frames.find((f) => f.term >= full - 1)
  expect(back && back.at <= 250, log).toBe(true)
  await expect(panel(page)).toHaveClass(/collapsed/)
  await app.close()
})

test('switching from Media to Changes keeps the terminal at its width through the change', async () => {
  const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, imagePanel: { width: 300, autoOpen: false }, review: { width: 400 } })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await setWidth(app, page, roomyWidth(await place(app), 400))
  const start = (await place(app)).bounds
  await page.keyboard.press(KEYS.images)
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 300)
  await expect.poll(async () => (await layout(page)).panelWidth).toBe(300)
  const before = await layout(page)
  const sizes = (await ptySizes(page)).length

  const frames = await framesAfterClick(page, '#sheet-header .tab-changes-toggle', 400)
  const log = timeline(frames)
  expect(frames.every((f) => Math.abs(f.term - before.termWidth) <= 1), log).toBe(true)
  await expect.poll(async () => (await place(app)).bounds.width).toBe(start.width + 400)
  await expect(page.locator('.panel-title')).toHaveText('Changes')
  expect(Math.max(...frames.map((f) => f.sizes)) - sizes, log).toBe(0)
  await app.close()
})
