import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { bellCommand, bufferText, FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, KEYS, launchApp, makeDataDir, PROMPT, writeTranscript } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

const freshFolder = (): string => mkdtempSync(join(tmpdir(), 'ct-folder-'))

/** the settings of a test: the left panel, and a default folder outside git so the first tab is in No project */
const left = (defaultFolder: string): object => ({ ...FAKE_CLAUDE_SETTINGS, defaultFolder, tabs: { position: 'left' } })

const readSettings = (dataDir: string): Record<string, any> => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))

const currentBranch = (repo: string): string => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

/** opens a tab in the folder and waits until main has it; the new tab is the active one */
async function openTab(page: Page, kind: 'shell' | 'claude', cwd: string): Promise<string> {
  const count = await page.evaluate(() => window.__ct!.tabIds().length)
  await page.evaluate((o) => window.ct.openTab(o), { kind, cwd })
  await page.waitForFunction((n) => window.__ct!.tabIds().length === n, count + 1)
  return (await page.evaluate(() => window.__ct!.activeTabId()))!
}

const row = (page: Page, id: string): Locator => page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"]`)

/** the group that holds the tab's row */
const groupOf = (page: Page, id: string): Locator => page.locator('#tabpanel .tp-group').filter({ has: page.locator(`.tp-tab[data-tab-id="${id}"]`) })

const groupNamed = (page: Page, name: string): Locator => page.locator('#tabpanel .tp-group').filter({ has: page.locator('.tp-group-name', { hasText: new RegExp(`^${name}$`) }) })

/** every size a tab's terminal gave its process */
const ptySizes = (page: Page, id: string): Promise<string[]> => page.evaluate((tabId) => window.__ct!.ptySizes!(tabId), id)

/** the panel's width in px, measured as the layout draws it */
const panelWidth = (page: Page): Promise<number> => page.locator('#tabpanel').evaluate((el) => el.getBoundingClientRect().width)

/** a press on the handle's centre, a move by dx px, a release: what a user does with the mouse */
async function dragBy(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 8 })
  await page.mouse.up()
}

async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  await page.locator('.terminal-host:visible .xterm').click()
  const [win] = await Promise.all([app.waitForEvent('window'), page.keyboard.press(KEYS.settings)])
  await win.waitForSelector('#settings .settings-heading')
  return win
}

test('the position button and the Settings window put the tabs on the left and back', async () => {
  const { app, page, dataDir } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect(page.locator('#tabbar')).toBeVisible()
  await expect(page.locator('#tabpanel')).toBeHidden()

  await page.locator('#tabbar .tab-position').click()
  await expect(page.locator('#tabpanel')).toBeVisible()
  await expect(page.locator('#tabbar')).toBeHidden()
  await expect.poll(() => readSettings(dataDir).tabs?.position).toBe('left')

  await page.locator('#tabpanel .tab-position').click()
  await expect(page.locator('#tabbar')).toBeVisible()
  await expect(page.locator('#tabpanel')).toBeHidden()
  await expect.poll(() => readSettings(dataDir).tabs?.position).toBe('top')

  const win = await openSettings(app, page)
  await win.locator('[data-key="tabs.position"]').selectOption('left')
  await expect(page.locator('#tabpanel')).toBeVisible()
  await expect(page.locator('#tabbar')).toBeHidden()
  await app.close()
})

test('tabs are grouped by project, with No project last', async () => {
  const folder = freshFolder()
  const repoA = gitRepo()
  const repoB = gitRepo()
  const plain = freshFolder()
  const { app, page } = await launchApp({ settings: left(folder) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await openTab(page, 'shell', repoA)
  await openTab(page, 'shell', plain)
  await openTab(page, 'shell', repoB)
  await openTab(page, 'shell', repoA)

  const names = page.locator('#tabpanel .tp-group-name')
  await expect.poll(() => names.allTextContents().then((all) => all.map((n) => n.toLowerCase()))).toEqual([
    basename(repoA).toLowerCase(),
    basename(repoB).toLowerCase(),
    'no project'
  ])
  await expect(page.locator('#tabpanel .tp-group').nth(0).locator('.tp-tab')).toHaveCount(2)
  await app.close()
})

test('every tab in git shows its branch; a linked worktree\'s tab has a colored bar', async () => {
  const folder = freshFolder()
  const repo = gitRepo()
  const branch = currentBranch(repo)
  const worktree = gitWorktree(repo, 'feat/x')
  const { app, page } = await launchApp({ settings: left(folder) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await openTab(page, 'shell', repo)
  const wt = await openTab(page, 'shell', worktree)

  // the group of the repository holds both tabs; the folder outside git has no branch line
  await expect(page.locator('#tabpanel .tp-group').nth(0).locator('.tp-tab')).toHaveCount(2)
  await expect(page.locator('#tabpanel .tp-branch')).toHaveText([branch, 'feat/x'])
  await expect(groupNamed(page, 'No project').locator('.tp-branch')).toHaveCount(0)

  await expect(page.locator('#tabpanel .tp-wtbar')).toHaveCount(1)
  const bar = row(page, wt).locator('.tp-wtbar')
  await expect(bar).toHaveCount(1)
  const colors = await row(page, wt).evaluate((el) => {
    const bar = el.querySelector<HTMLElement>('.tp-wtbar')!
    const br = el.querySelector<HTMLElement>('.tp-branch')!
    return [getComputedStyle(bar).backgroundColor, getComputedStyle(br).color]
  })
  expect(colors[0]).toBe(colors[1])
  await app.close()
})

test('a folded group shows its count and a dot, and stays folded after a restart', async () => {
  const folder = freshFolder()
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page, dataDir, pipeName } = await launchApp({ settings: left(folder) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]
  const a1 = await openTab(page, 'shell', repoA)
  await expect.poll(() => bufferText(page, a1), { timeout: 20_000 }).toMatch(PROMPT)
  await openTab(page, 'shell', repoA)
  await page.evaluate((id) => window.ct.activateTab(id), home)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, home)
  // the bell in a1, rung while a1 is in the background
  await page.evaluate(([id, text]) => window.ct.writePty(id, text), [a1, bellCommand()] as const)
  await expect(row(page, a1).locator('.tab-bell')).toHaveCount(1)

  // Claude waits in a tab of group B, in the background
  const b1 = await openTab(page, 'claude', repoB)
  await page.evaluate((id) => window.ct.activateTab(id), home)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, home)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: b1, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(row(page, b1)).toHaveClass(/\battention\b/)

  const groupA = groupNamed(page, basename(repoA))
  const groupB = groupNamed(page, basename(repoB))
  // the groups by their projects: a tab is in No project until git has answered for its folder
  await expect(groupA).toHaveCount(1)
  await expect(groupB).toHaveCount(1)
  const keyA = (await groupOf(page, a1).getAttribute('data-group'))!
  const keyB = (await groupOf(page, b1).getAttribute('data-group'))!
  await groupA.locator('.tp-group-head').click()
  await expect(groupA).toHaveClass(/\bfolded\b/)
  await expect(groupA.locator('.tp-group-count')).toHaveText('2')
  await expect(groupA.locator('.tp-tab')).toHaveCount(0)
  await expect(groupA.locator('.tp-group-dot')).toBeVisible()
  await expect(groupA.locator('.tp-group-dot')).not.toHaveClass(/\bpulse\b/)

  await groupB.locator('.tp-group-head').click()
  await expect(groupB.locator('.tp-group-dot')).toHaveClass(/\bpulse\b/)

  await app.close()

  const again = await launchApp({ dataDir })
  await expect.poll(() => again.page.evaluate(() => window.ct.getTabLayout())).toMatchObject({ folded: expect.arrayContaining([keyA, keyB]) })
  await again.app.close()
})

test('the panel\'s width is dragged and kept', async () => {
  const { app, page, dataDir } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => panelWidth(page)).toBe(240)

  await dragBy(page, page.locator('#tabpanel .tp-resize'), 100)
  await expect.poll(() => panelWidth(page)).toBe(340)
  await dragBy(page, page.locator('#tabpanel .tp-resize'), -1000)
  await expect.poll(() => panelWidth(page)).toBe(160)
  await app.close()

  const again = await launchApp({ dataDir })
  await expect.poll(() => panelWidth(again.page)).toBe(160)
  await again.app.close()
})

test('the panel header\'s buttons work like the tab bar\'s', async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const media = page.locator('#image-panel')
  await expect(media).toHaveClass(/collapsed/)

  await page.locator('#tabpanel .tp-head .tab-images-toggle').click()
  await expect(media).not.toHaveClass(/collapsed/)
  await page.locator('#tabpanel .tp-head .tab-images-toggle').click()
  await expect(media).toHaveClass(/collapsed/)

  await page.locator('#tabpanel .tp-head .tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await app.close()
})

test('the terminal is not resized when nothing in the layout changes', async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const first = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const second = await openTab(page, 'shell', freshFolder())
  await openTab(page, 'shell', freshFolder())
  // the sizes the first terminal reported while it settled: its first fit is reported twice, in the tab bar's layout too
  await page.waitForTimeout(1000)
  const settled = await ptySizes(page, first)
  expect(settled.length).toBeGreaterThan(0)
  await page.locator(`#tabpanel .tp-tab[data-tab-id="${first}"]`).click()
  await page.locator(`#tabpanel .tp-tab[data-tab-id="${second}"]`).click()
  await page.locator(`#tabpanel .tp-tab[data-tab-id="${first}"]`).click()
  await page.waitForTimeout(1000)
  expect(await ptySizes(page, first)).toEqual(settled)
  await app.close()
})

test('a tab in a folded group unfolds its group when it becomes the active tab', async () => {
  const repo = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const a1 = await openTab(page, 'shell', repo)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]
  const group = groupNamed(page, basename(repo))
  await page.evaluate((id) => window.ct.activateTab(id), home)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, home)
  await group.locator('.tp-group-head').click()
  await expect(group).toHaveClass(/\bfolded\b/)

  await page.evaluate((id) => window.ct.activateTab(id), a1)
  await expect(group).not.toHaveClass(/\bfolded\b/)
  await expect(row(page, a1)).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.ct.getTabLayout())).toMatchObject({ folded: [] })
  await app.close()
})

test('with tabs on the left, a new tab unfolds its project group and leaves No project folded', async () => {
  const repo = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await openTab(page, 'shell', repo)
  const groupA = groupNamed(page, basename(repo))
  const noProject = groupNamed(page, 'No project')
  await expect(groupA).toHaveCount(1)
  await groupA.locator('.tp-group-head').click()
  await noProject.locator('.tp-group-head').click()
  await expect(groupA).toHaveClass(/\bfolded\b/)
  await expect(noProject).toHaveClass(/\bfolded\b/)

  // the new tab is in the project's folder: its place arrives after git answers, and only then its group is known
  const added = await openTab(page, 'shell', repo)
  await expect(groupA).not.toHaveClass(/\bfolded\b/)
  await expect(row(page, added)).toBeVisible()
  await expect(noProject).toHaveClass(/\bfolded\b/)
  expect(await page.evaluate(() => window.ct.getTabLayout())).toMatchObject({ folded: ['~none'] })
  await app.close()
})

test('with tabs on top, activating a tab leaves the saved fold state alone', async () => {
  const repo = gitRepo()
  const dataDir = makeDataDir({ ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() })
  writeFileSync(join(dataDir, 'tab-layout.json'), JSON.stringify({ width: 240, folded: ['~none'] }))
  const { app, page } = await launchApp({ dataDir })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]
  const a1 = await openTab(page, 'shell', repo)
  await page.evaluate((id) => window.ct.activateTab(id), home)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, home)
  await page.evaluate((id) => window.ct.activateTab(id), a1)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a1)
  expect(await page.evaluate(() => window.ct.getTabLayout())).toEqual({ width: 240, folded: ['~none'] })
  await app.close()
})

test('Ctrl+Tab and Ctrl+Alt+N follow the panel\'s order', async () => {
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const a1 = await openTab(page, 'shell', repoA)
  const b1 = await openTab(page, 'shell', repoB)
  const a2 = await openTab(page, 'shell', repoA)
  // the panel shows A1, A2, B1 (No project last), though the tabs were opened in another order
  await expect(groupNamed(page, basename(repoA))).toHaveCount(1)
  await page.evaluate((id) => window.ct.activateTab(id), a1)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a1)
  await page.locator('.terminal-host:visible .xterm').click()

  await page.keyboard.press(KEYS.nextTab)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a2)
  await page.keyboard.press(KEYS.nextTab)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, b1)

  await page.evaluate((id) => window.ct.activateTab(id), a1)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a1)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Digit2' : 'Control+Alt+Digit2')
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a2)
  await app.close()
})

test('a tab is dragged within its group, not into another', async () => {
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repoA)
  const b1 = await openTab(page, 'shell', repoB)
  const a2 = await openTab(page, 'shell', repoA)
  await expect(row(page, a2)).toBeVisible()

  await row(page, a2).dragTo(row(page, a1))
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a2, a1, b1, home])

  await row(page, a1).dragTo(row(page, b1))
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([a2, a1, b1, home])
  await app.close()
})

test('a group is dragged by its header', async () => {
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repoA)
  const a2 = await openTab(page, 'shell', repoA)
  const b1 = await openTab(page, 'shell', repoB)
  const groupA = groupNamed(page, basename(repoA))
  const groupB = groupNamed(page, basename(repoB))
  await expect(groupA).toHaveCount(1)
  await expect(groupB).toHaveCount(1)

  await groupB.locator('.tp-group-head').dragTo(groupA.locator('.tp-group-head'))
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([b1, a1, a2, home])
  await app.close()
})

test('a family moves together, and a fork stays in its family', async () => {
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const repo = gitRepo()
  const { app, page, pipeName } = await launchApp({ settings: left(freshFolder()), args: ['--claude', repo], env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const a = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: a, sessionId: SID, source: 'startup', transcriptPath: writeTranscript(config, repo, SID) })).toEqual({ ok: true })
  const b = await openTab(page, 'shell', repo)
  await page.evaluate((id) => window.ct.forkTab(id), a)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  const [, a1] = await page.evaluate(() => window.__ct!.tabIds())
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([a, a1, b])

  await row(page, a).dragTo(row(page, b))
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([b, a, a1])

  await row(page, a1!).dragTo(row(page, b))
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([b, a, a1])
  await app.close()
})
