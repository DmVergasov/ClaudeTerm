import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, KEYS, launchApp, launchClaudeTab, openTabInFront } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
// the icon and the line under the header are what these tests check; keep the desktop quiet while they run
const QUIET = { ...FAKE_CLAUDE_SETTINGS, attention: { sound: 'none', flash: false } }

const freshFolder = (): string => mkdtempSync(join(tmpdir(), 'ct-folder-'))

/** what the hooks report when a prompt starts a turn */
const turn = (pipeName: string, tabId: string): Promise<unknown> => sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID })

/** opens a tab in the folder and waits until main has it; the new tab is the active one */
async function openTab(page: Page, kind: 'shell' | 'claude', cwd: string): Promise<string> {
  return openTabInFront(page, kind, cwd)
}

/** the main window's size: the window clamps it to its minimum width */
const setWindowSize = (app: ElectronApplication, width: number, height: number): Promise<void> => app.evaluate(({ BrowserWindow }, size) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.getParentWindow() === null)!
  w.setSize(size.width, size.height)
}, { width, height })

const box = (loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})

for (const position of ['top', 'left'] as const) {
  test(`the panel toggles sit in the sheet's header, with the tabs on ${position}, and open their panels`, async () => {
    const { app, page } = await launchApp({ settings: { tabs: { position }, agentMessages: { enabled: true, marks: true } } })
    await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
    const header = page.locator('#sheet-header')
    await expect(header.locator('.tab-images-toggle')).toBeVisible()
    await expect(header.locator('.tab-messages-toggle')).toBeVisible()
    await expect(page.locator('#tabbar .tab-images-toggle')).toHaveCount(0)
    await expect(page.locator('#tabpanel .tab-images-toggle')).toHaveCount(0)
    await expect(page.locator('#tabpanel .tab-messages-toggle')).toHaveCount(0)

    await header.locator('.tab-images-toggle').click()
    await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
    await expect(header.locator('.tab-images-toggle')).toHaveClass(/active/)
    await app.close()
  })
}

test('the header names the active tab and its branch, in the worktree\'s color', async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/x')
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder(), tabs: { position: 'left' } } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const wt = await openTab(page, 'shell', worktree)
  const header = page.locator('#sheet-header')
  await expect(header.locator('.sh-title')).toHaveText(await page.evaluate((id) => window.__ct!.tabTitle(id)!, wt))
  await expect(header.locator('.sh-branch')).toHaveText('feat/x')
  // the branch follows the title's text, one gap after it, not out in the middle of the header
  const gap = await header.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el.querySelector('.sh-title')!)
    return el.querySelector('.sh-branch')!.getBoundingClientRect().left - range.getBoundingClientRect().right
  })
  expect(gap).toBeLessThanOrEqual(9)
  // the left panel's row of the same tab shows the same worktree color
  await expect.poll(() => header.locator('.sh-branch').evaluate((el) => getComputedStyle(el).color)).toBe(
    await page.locator(`#tabpanel [data-tab-id="${wt}"] .tp-branch`).evaluate((el) => getComputedStyle(el).color)
  )
  await app.close()
})

test('double-clicking the header\'s title renames the tab', async () => {
  const { app, page, tabId } = await launchClaudeTab(QUIET)
  await page.locator('#sheet-header .sh-title').dblclick()
  await page.keyboard.type('report')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle(id), tabId)).toBe('report')
  await expect(page.locator('#sheet-header .sh-title')).toHaveText('report')
  await app.close()
})

test('no line runs under the header while Claude works in the tab: the tab\'s own glyph says it works', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab(QUIET)
  const header = page.locator('#sheet-header')
  expect(await turn(pipeName, tabId)).toEqual({ ok: true })
  await expect(page.locator(`[data-tab-id="${tabId}"] .spin`).first()).toBeVisible()
  // nothing in the header is drawn wider than a button and as thin as a line (the old sweep was 2 px high)
  const lines = await header.evaluate((h) => [...h.querySelectorAll<HTMLElement>('*')].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.height > 0 && r.height <= 3 && r.width > 40
  }).length)
  expect(lines).toBe(0)
  await expect(header.locator('.sh-sweep')).toHaveCount(0)
  await app.close()
})

test('the header names the folder only when the title is not the folder\'s name', async () => {
  const { app, page, tabId, work } = await launchClaudeTab(QUIET)
  const folder = page.locator('#sheet-header .sh-folder')
  // a fresh tab is named after its folder: the folder's name is not shown twice
  await expect(page.locator('#sheet-header .sh-title')).toHaveText(basename(work))
  await expect(folder).toBeHidden()
  // a tab renamed to anything else names its folder again
  await page.locator('#sheet-header .sh-title').dblclick()
  await page.keyboard.type('report')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle(id), tabId)).toBe('report')
  await expect(folder).toBeVisible()
  await expect(folder).toHaveText(basename(work))
  await app.close()
})

test('the header\'s title element survives a redraw that changes nothing', async () => {
  const { app, page, tabId } = await launchClaudeTab(QUIET)
  const title = page.locator('#sheet-header .sh-title')
  await expect(title).toHaveText(await page.evaluate((id) => window.__ct!.tabTitle(id)!, tabId))
  // the tab's project is known: its answer redraws the header, and a slow git answers after the title shows
  await expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id) !== undefined, tabId)).toBe(true)
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).probe = document.querySelector('#sheet-header .sh-title') })
  // a note with text redraws the tabs; the header's own part (its title, branch and folder) does not change
  await page.locator('#sheet-header .tab-note-toggle').click()
  await page.keyboard.type('kept')
  await expect(page.locator(`[data-tab-id="${tabId}"] .tab-note`)).toBeVisible()
  const same = await page.evaluate(() => {
    const probe = (window as unknown as Record<string, unknown>).probe as Element
    return probe.isConnected && probe === document.querySelector('#sheet-header .sh-title')
  })
  expect(same).toBe(true)
  await app.close()
})

test('the terminal sits on the theme\'s own background in a light theme', async () => {
  const { app, page } = await launchApp({ settings: { theme: 'One Half Light' } })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await expect.poll(() => page.locator('#terminals').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(250, 250, 250)')
  await app.close()
})

test('a long title and a narrow window keep every toggle inside the header', async () => {
  const { app, page, tabId } = await launchClaudeTab({ ...QUIET, agentMessages: { enabled: true, marks: true } })
  const long = 'x'.repeat(200)
  await page.evaluate(([id, t]) => window.ct.renameTab(id, t), [tabId, long] as const)
  await expect.poll(() => page.locator('#sheet-header .sh-title').textContent()).toBe(long)
  // the window clamps the request to its minimum width
  await setWindowSize(app, 200, 500)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(600)

  const header = await box(page.locator('#sheet-header'))
  const toggles = page.locator('#sheet-header .tab-changes-toggle:visible, #sheet-header .tab-images-toggle:visible, #sheet-header .tab-messages-toggle:visible, #sheet-header .tab-note-toggle:visible')
  expect(await toggles.count()).toBeGreaterThan(0)
  for (let i = 0; i < (await toggles.count()); i++) {
    const b = await box(toggles.nth(i))
    expect(b.x).toBeGreaterThanOrEqual(header.x)
    expect(b.x + b.width).toBeLessThanOrEqual(header.x + header.width + 0.5)
  }
  const title = page.locator('#sheet-header .sh-title')
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await app.close()
})

test('in a narrow window the header\'s buttons show their icons only, so the title keeps room to be read; each button keeps its name as a tooltip', async () => {
  const { app, page, tabId } = await launchClaudeTab({ ...QUIET, agentMessages: { enabled: true, marks: true } })
  const long = 'x'.repeat(200)
  await page.evaluate(([id, t]) => window.ct.renameTab(id, t), [tabId, long] as const)
  await expect.poll(() => page.locator('#sheet-header .sh-title').textContent()).toBe(long)
  const buttons = page.locator('#sheet-header .sh-mode:visible, #sheet-header .tab-changes-toggle:visible, #sheet-header .tab-images-toggle:visible')
  // a wide window: the buttons have their labels
  await setWindowSize(app, 1200, 600)
  await expect(page.locator('#sheet-header .tab-changes-toggle .sh-label')).toBeVisible()
  // the narrowest window: the labels give way, and the title is still there to read
  await setWindowSize(app, 200, 500)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(600)
  await expect(page.locator('#sheet-header .sh-label:visible')).toHaveCount(0)
  expect((await box(page.locator('#sheet-header .sh-title'))).width).toBeGreaterThanOrEqual(100)
  expect(await buttons.count()).toBeGreaterThan(0)
  for (const title of await buttons.evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))) expect(title).not.toBe('')
  await app.close()
})

type Box = { x: number, y: number, width: number, height: number }
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const contains = (outer: Box, a: Box): boolean => a.x >= outer.x && a.y >= outer.y && a.x + a.width <= outer.x + outer.width && a.y + a.height <= outer.y + outer.height

// the terminal's find box opens in the terminal's corner, under the title bar, the tab bar and the sheet's header
for (const position of ['top', 'left'] as const) {
  test(`the find box opens at the top right of the terminal, clear of the title bar and the header, with the tabs on ${position}`, async () => {
    const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, tabs: { position } })
    await page.locator('.terminal-host:visible .xterm').click({ position: { x: 20, y: 20 } })
    await page.keyboard.press(KEYS.find)
    await expect(page.locator('#search')).toBeVisible()
    const find = (await page.locator('#search').boundingBox())!
    for (const sel of ['#titlebar', '#tabbar', '#tabpanel', '#sheet-header']) {
      const other = await page.locator(sel).boundingBox()
      if (other) expect(overlaps(find, other), `the find box overlaps ${sel}`).toBe(false)
    }
    expect(contains((await page.locator('#workspace').boundingBox())!, find)).toBe(true)
    expect(contains((await page.locator('#sheet').boundingBox())!, find)).toBe(true)
    await app.close()
  })
}
