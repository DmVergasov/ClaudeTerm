import { expect, test, type Locator, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, KEYS, launchApp, makeDataDir, ROOT, TEST_SHELL, testEnv, typeInTerminal } from './helpers'

const electronExe = createRequire(__filename)('electron') as unknown as string

/** The active tab runs in the folder: PowerShell's prompt shows it, bash prints it when asked (the stand-in claude prints it itself) */
async function expectFolder(page: Page, folder: string, ask: boolean): Promise<void> {
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  if (ask && !WIN) await typeInTerminal(page, 'pwd')
  // the folder's name: on macOS the shell reports /var/… as /private/var/…
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(basename(folder))
}

test('defaultFolder: the first tab and a new tab open in it, and a Claude tab opened from such a tab too', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ct-folder-'))
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: folder } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expectFolder(page, folder, true)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.newTab)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expectFolder(page, folder, true)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.newClaudeTab)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  await expectFolder(page, folder, false)
  await app.close()
})

test('defaultFolder that does not exist: the first tab and a new tab open in the home folder, and a notice says so', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'ct-folder-'))
  rmSync(folder, { recursive: true })
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: folder } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect(page.locator('.toast', { hasText: `Folder not found: ${folder}` })).toBeVisible()
  await expectFolder(page, homedir(), true)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.newTab)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expectFolder(page, homedir(), true)
  await app.close()
})

test('second instance opens a claude tab in the running window', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page, dataDir, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--shell', work] })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await new Promise<void>((resolve) => {
    spawn(electronExe, [ROOT, '--claude', work], { env: testEnv(dataDir, pipeName) }).on('exit', () => resolve())
  })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = await page.evaluate(() => window.__ct!.activeTabId())
  await expect.poll(() => bufferText(page, id!), { timeout: 15_000 }).toMatch(/fake-claude --settings/)
  await app.close()
})

test('tabs can be renamed and closed', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.locator('.tab').first().dblclick()
  await page.locator('.tab-rename').fill('build')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tab').first().locator('.tab-title')).toHaveText('build')
  await page.locator('.tab').first().locator('.tab-close').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await app.close()
})

test('the × of a background tab closes it and the active tab stays in front', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const first = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const second = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await page.locator(`[data-tab-id="${first}"] .tab-close`).click()
  expect(await page.evaluate(() => window.__ct!.activeTabId())).toBe(second)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await app.close()
})

test('the window title names the folder of the tab in front, and a tab\'s tooltip shows its full path', async () => {
  const offroad = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'Offroad')
  const engine = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'Engine')
  mkdirSync(offroad)
  mkdirSync(engine)
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--shell', offroad] })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const first = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await page.evaluate((id) => window.ct.renameTab(id, 'build'), first)
  await expect(page).toHaveTitle('build — Offroad — ClaudeTerm')
  await expect(page.locator(`[data-tab-id="${first}"]`)).toHaveAttribute('title', `build\n${offroad}`)
  const second = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), engine))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, second)
  // a title that is the folder's name already does not repeat it
  await page.evaluate((id) => window.ct.renameTab(id, 'Engine'), second)
  await expect(page).toHaveTitle('Engine — ClaudeTerm')
  await page.locator(`[data-tab-id="${first}"]`).click()
  await expect(page).toHaveTitle('build — Offroad — ClaudeTerm')
  await app.close()
})

/** the centre of a tab, measured in the page: a tab bar drawn again in between does not make it null, as boundingBox can */
const centre = (tab: Locator): Promise<{ x: number, y: number }> => tab.evaluate((el) => {
  const b = el.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
})

test('a click on a tab activates it even when the tab bar is drawn again between the press and the release', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const firstId = (await page.evaluate(() => window.__ct!.tabIds()))[0]
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const secondId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect(page.locator('#tabbar .tab')).toHaveCount(2)

  const first = page.locator('#tabbar .tab').first()
  const c = await centre(first)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await first.evaluate((el) => { (window as any).__pressed = el })
  // a busy Claude retitles its tab: the tab bar is built again while the button is down
  await page.evaluate((id) => window.ct.renameTab(id, 'redrawn'), secondId)
  await expect.poll(() => page.evaluate(() => (window as any).__pressed.isConnected)).toBe(false)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(firstId)

  // a press on one tab released on another activates neither
  await page.locator('#tabbar .tab').nth(1).click()
  await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(secondId)
  const from = await centre(page.locator('#tabbar .tab').first())
  const to = await centre(page.locator('#tabbar .tab').nth(1))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(secondId)
  await app.close()
})

/** a fresh folder outside git: the first tab of an app opened with it is in No project */
const freshFolder = (): string => mkdtempSync(join(tmpdir(), 'ct-folder-'))

/** opens a shell tab in the folder and waits until main has it; the new tab is the active one */
async function openShell(page: Page, cwd: string): Promise<string> {
  const count = await page.evaluate(() => window.__ct!.tabIds().length)
  await page.evaluate((o) => window.ct.openTab(o), { kind: 'shell' as const, cwd })
  await page.waitForFunction((n) => window.__ct!.tabIds().length === n, count + 1)
  return (await page.evaluate(() => window.__ct!.activeTabId()))!
}

/** the tab ids the tab bar shows, in their order on screen */
const shownTabIds = (page: Page): Promise<string[]> => page.locator('#tabbar .tab').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tabId!))

test('tabs on top are grouped by project, each group after its label', async () => {
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openShell(page, repoA)
  const b1 = await openShell(page, repoB)
  const a2 = await openShell(page, repoA)

  const names = page.locator('#tabbar .tb-group-label')
  await expect.poll(() => names.allTextContents().then((all) => all.map((n) => n.toLowerCase()))).toEqual([
    basename(repoA).toLowerCase(),
    basename(repoB).toLowerCase(),
    'no project'
  ])
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, b1, home])
  await expect.poll(() => shownTabIds(page)).toEqual([a1, a2, b1, home])
  await app.close()
})

test('one project shows no label', async () => {
  const repo = gitRepo()
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: repo } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await openShell(page, repo)
  await expect(page.locator('#tabbar .tab')).toHaveCount(2)
  await expect(page.locator('#tabbar .tb-group-label')).toHaveCount(0)
  await app.close()
})

test('a tab is dragged within its group, not into another', async () => {
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openShell(page, repoA)
  const b1 = await openShell(page, repoB)
  const a2 = await openShell(page, repoA)
  const tab = (id: string): Locator => page.locator(`#tabbar .tab[data-tab-id="${id}"]`)

  // the drag waits for the settled order: a tab in No project until its place arrives cannot be dropped in its group
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, b1, home])
  await tab(a2).dragTo(tab(a1))
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a2, a1, b1, home])

  await tab(a1).dragTo(tab(b1))
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([a2, a1, b1, home])
  await app.close()
})

test('order waits for places: no temporary order reaches main while a tab\'s project is unknown', async () => {
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  await page.evaluate(() => {
    const w = window as unknown as { orders: string[][] }
    w.orders = []
    window.ct.onTabsOrder((ids) => w.orders.push(ids))
  })
  const a1 = await openShell(page, repoA)
  const b1 = await openShell(page, repoB)
  const a2 = await openShell(page, repoA)
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, b1, home])

  const orders = await page.evaluate(() => (window as unknown as { orders: string[][] }).orders)
  const settled = orders.filter((ids) => [a1, a2, b1].every((id) => ids.includes(id)))
  expect(settled.length).toBeGreaterThan(0)
  for (const ids of settled) expect(ids).toEqual([a1, a2, b1, home])
  await app.close()
})

test('the tab bar scrolls: the active tab is in view whether it is the first or the last', async () => {
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const folder = freshFolder()
  let first = ''
  let last = ''
  for (let i = 0; i < 14; i++) {
    last = await openShell(page, folder)
    if (i === 0) first = last
  }
  await expect(page.locator('#tabbar .tab')).toHaveCount(15)
  expect(await page.evaluate(() => { const l = document.querySelector<HTMLElement>('#tabbar .tabs')!; return l.scrollWidth > l.clientWidth })).toBe(true)

  const inView = (id: string): Promise<boolean> => page.evaluate((tabId) => {
    const box = document.querySelector<HTMLElement>(`#tabbar .tab[data-tab-id="${tabId}"]`)!.getBoundingClientRect()
    const list = document.querySelector<HTMLElement>('#tabbar .tabs')!.getBoundingClientRect()
    return box.left >= list.left - 1 && box.right <= list.right + 1
  }, id)
  await page.evaluate((id) => window.ct.activateTab(id), last)
  await expect.poll(() => inView(last)).toBe(true)
  await page.evaluate((id) => window.ct.activateTab(id), first)
  await expect.poll(() => inView(first)).toBe(true)

  // a tab bar drawn again (a tab renamed) keeps its scroll: the first tab stays in view
  await page.evaluate((id) => window.ct.renameTab(id, 'redrawn'), last)
  await expect(page.locator(`#tabbar .tab[data-tab-id="${last}"] .tab-title`)).toHaveText('redrawn')
  await expect.poll(() => inView(first)).toBe(true)
  await app.close()
})

test('a linked worktree\'s tab on top has a line in its colour', async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/y')
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const wt = await openShell(page, worktree)
  const tab = page.locator(`#tabbar .tab[data-tab-id="${wt}"]`)
  await expect(tab.locator('.tab-wtline')).toHaveCount(1)
  await expect(page.locator('#tabbar .tab-wtline')).toHaveCount(1)
  const color = await tab.locator('.tab-wtline').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(color).not.toBe('rgba(0, 0, 0, 0)')
  await app.close()
})

test('a fork on top can be dragged to the end of its group', async () => {
  const repo = gitRepo()
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
  const shell = (title: string) => ({ kind: 'shell', profile: TEST_SHELL, cwd: repo, title })
  // the fork (index 0) stands before its head (index 1, a Claude tab with a session), as a restored order may keep it
  const tabs = [
    { kind: 'claude', profile: TEST_SHELL, cwd: repo, title: 'fork', claudeSessionId: null, fork: { of: 1, from: SID } },
    { kind: 'claude', profile: TEST_SHELL, cwd: repo, title: 'head', claudeSessionId: SID },
    shell('last')
  ]
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs }))
  const { app, page } = await launchApp({ dataDir, env: { CLAUDE_CONFIG_DIR: config } })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  const [fork, head, last] = await page.evaluate(() => window.__ct!.tabIds())
  const tab = (id: string): Locator => page.locator(`#tabbar .tab[data-tab-id="${id}"]`)
  await expect.poll(() => shownTabIds(page)).toEqual([fork, head, last])

  await tab(fork!).dragTo(tab(last!))
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([head, last, fork])
  await expect.poll(() => shownTabIds(page)).toEqual([head, last, fork])
  await app.close()
})

test('an exited tab is dimmed as well as struck through', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  // the shell ends itself: the tab stays open, showing that its process exited
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tab.exited')).toHaveCount(1)
  expect(await page.locator('.tab.exited .tab-title').evaluate((el) => getComputedStyle(el).opacity)).toBe('0.55')
  await app.close()
})
