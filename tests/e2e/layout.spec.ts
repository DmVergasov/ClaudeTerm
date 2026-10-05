import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './helpers'

interface TermLayout {
  innerHeight: number
  innerWidth: number
  rows: number
  screenHeight: number // rows × cell height
  screenWidth: number // cols × cell width
  screenBottom: number
  screenRight: number
  hostContentHeight: number
  hostContentWidth: number
  hostContentBottom: number
  scrollbarLeft: number
}

// Measured after two animation frames so the ResizeObserver -> fit -> render chain has run.
function termLayout(page: Page): Promise<TermLayout> {
  return page.evaluate(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const host = [...document.querySelectorAll<HTMLElement>('.terminal-host')].find((e) => e.style.display !== 'none')!
    const cs = getComputedStyle(host)
    const px = (v: string): number => parseFloat(v) || 0
    const h = host.getBoundingClientRect()
    const s = host.querySelector('.xterm-screen')!.getBoundingClientRect()
    const hostContentRight = h.right - px(cs.paddingRight) - px(cs.borderRightWidth)
    // xterm 6 lays out its vertical scrollbar (opacity 0 until hovered) over the right edge of the terminal
    const bar = host.querySelector('.xterm-scrollable-element > .scrollbar.vertical')
    return {
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      rows: host.querySelector('.xterm-rows')!.childElementCount,
      screenHeight: s.height,
      screenWidth: s.width,
      screenBottom: s.bottom,
      screenRight: s.right,
      hostContentHeight: host.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
      hostContentWidth: host.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
      hostContentBottom: h.bottom - px(cs.paddingBottom) - px(cs.borderBottomWidth),
      scrollbarLeft: bar ? bar.getBoundingClientRect().left : hostContentRight
    }
  })
}

// Every way the fitted grid can spill out of its box; empty when it fits.
function overflows(l: TermLayout): string[] {
  const checks: [string, number][] = [
    ['rows×cellHeight past host content height', l.screenHeight - l.hostContentHeight],
    ['last row past host bottom', l.screenBottom - l.hostContentBottom],
    ['last row past window bottom', l.screenBottom - l.innerHeight],
    ['cols×cellWidth past host content width', l.screenWidth - l.hostContentWidth],
    ['last column under the scrollbar', l.screenRight - l.scrollbarLeft],
    ['last column past window right', l.screenRight - l.innerWidth]
  ]
  return checks.filter(([, over]) => over > 0.5).map(([what, over]) => `${what} by ${over.toFixed(1)}px (${l.rows} rows)`)
}

function contentSize(app: ElectronApplication): Promise<{ width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const { width, height } = BrowserWindow.getAllWindows()[0].getContentBounds()
    return { width, height }
  })
}

async function waitForViewport(app: ElectronApplication, page: Page): Promise<void> {
  const want = await contentSize(app)
  await expect
    .poll(async () => {
      const got = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      return Math.max(Math.abs(got.width - want.width), Math.abs(got.height - want.height))
    })
    .toBeLessThanOrEqual(1)
}

async function setContentSize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height])
  await waitForViewport(app, page)
}

test('maximized window: the last terminal row and column are not cut off', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true)
  await waitForViewport(app, page)
  const l = await termLayout(page)
  expect(overflows(l), JSON.stringify(l)).toEqual([])
  await app.close()
})

// The overflow depends on (host size mod cell size), so sweeping one full cell period in each direction
// catches it on any display, whatever size "maximized" happens to be there.
test('terminal grid fits the host at every window size', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const first = await termLayout(page)
  const cellHeight = first.screenHeight / first.rows
  expect(cellHeight).toBeGreaterThan(0)
  const failures: string[] = []
  const check = async (w: number, h: number): Promise<void> => {
    await setContentSize(app, page, w, h)
    for (const f of overflows(await termLayout(page))) failures.push(`${w}x${h}: ${f}`)
  }
  for (let h = 600; h <= 600 + Math.ceil(cellHeight) + 1; h++) await check(1000, h)
  // 20 consecutive widths cover a full period for any cell width up to 20px
  for (let w = 1000; w < 1020; w++) await check(w, 600)
  expect(failures).toEqual([])
  await app.close()
})
