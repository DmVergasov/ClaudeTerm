import { expect as baseExpect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { AttentionReason } from '../../src/shared/protocol'
import { bellCommand, bufferText, FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, KEY_LABELS, KEYS, launchApp, launchClaudeTab, makeDataDir, panelSettled, PROMPT, showSettingsTab, writeTranscript, openTabInFront } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
// a tab finds its project group once git answers for its folder, late on a busy machine, as when other tests run at the
// same time: the waits get 15 s
const expect = baseExpect.configure({ timeout: 15_000 })

const freshFolder = (): string => mkdtempSync(join(tmpdir(), 'ct-folder-'))

/** the settings of a test: the left panel, and a default folder outside git so the first tab is in No project */
const left = (defaultFolder: string): object => ({ ...FAKE_CLAUDE_SETTINGS, defaultFolder, tabs: { position: 'left' } })

const readSettings = (dataDir: string): Record<string, any> => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))

const currentBranch = (repo: string): string => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

/** opens a tab in the folder and waits until main has it; the new tab is the active one */
async function openTab(page: Page, kind: 'shell' | 'claude', cwd: string): Promise<string> {
  return openTabInFront(page, kind, cwd)
}

const row = (page: Page, id: string): Locator => page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"]`)

/** the group that holds the tab's row */
const groupOf = (page: Page, id: string): Locator => page.locator('#tabpanel .tp-group').filter({ has: page.locator(`.tp-tab[data-tab-id="${id}"]`) })

const groupNamed = (page: Page, name: string): Locator => page.locator('#tabpanel .tp-group').filter({ has: page.locator('.tp-group-name', { hasText: new RegExp(`^${name}$`) }) })

/** every size a tab's terminal gave its process */
const ptySizes = (page: Page, id: string): Promise<string[]> => page.evaluate((tabId) => window.__ct!.ptySizes!(tabId), id)

/** the panel's width in px, measured as the layout draws it */
const panelWidth = (page: Page): Promise<number> => page.locator('#tabpanel').evaluate((el) => el.getBoundingClientRect().width)

/** the centre of a row, measured in the page: a panel drawn again in between does not make it null, as boundingBox can */
const centre = (tab: Locator): Promise<{ x: number, y: number }> => tab.evaluate((el) => {
  const b = el.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
})

/** a press on the handle's centre, a move by dx px, a release: what a user does with the mouse */
async function dragBy(page: Page, handle: Locator, dx: number): Promise<void> {
  // a panel that is still sliding in has its handle a few pixels off from where it comes to rest
  await panelSettled(page)
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
  await win.waitForSelector('#settings .section-title')
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
  await showSettingsTab(win, 'appearance')
  await win.locator('[data-key="tabs.position"][data-value="left"]').click()
  await expect(page.locator('#tabpanel')).toBeVisible()
  await expect(page.locator('#tabbar')).toBeHidden()
  await app.close()
})

test('the column\'s New tab button opens a tab of the default profile', async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const button = page.locator('#tabpanel .tp-new')
  await expect(button).toHaveText(/^New tab/)
  await button.click()
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
  await app.close()
})

test('the column\'s footer opens Recent sessions and Settings', async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  // Settings first: the Recent sessions window covers the panel while it is open
  await page.locator('#tabpanel .tp-settings').click()
  await expect.poll(() => app.windows().length).toBe(2)
  await page.locator('#tabpanel .tp-recent').click()
  await expect(page.locator('#sessions')).toBeVisible()
  await app.close()
})

test('the ▾ beside New tab is a drawn chevron in a square box like New tab\'s, and on top a drawn chevron too', async () => {
  const folder = freshFolder()
  const { app, page } = await launchApp({ settings: left(folder) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const menu = page.locator('#tabpanel .tab-menu')
  const plus = page.locator('#tabpanel .tp-new')
  await expect(menu.locator('svg')).toHaveCount(1)
  await expect(menu).toHaveText('')
  const [m, p] = [(await menu.boundingBox())!, (await plus.boundingBox())!]
  expect(Math.abs(m.width - m.height)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(m.height - p.height)).toBeLessThanOrEqual(0.5)
  const look = (sel: string) => page.locator(sel).evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, border: s.borderTopWidth, radius: s.borderTopLeftRadius } })
  expect(await look('#tabpanel .tab-menu')).toEqual(await look('#tabpanel .tp-new'))
  // on top the button keeps no box, but its chevron is drawn the same way
  await page.evaluate(() => window.ct.setSetting('tabs.position', 'top'))
  await expect(page.locator('#tabbar .tab-menu svg')).toHaveCount(1)
  await expect(page.locator('#tabbar .tab-menu')).toHaveText('')
  await app.close()
})

test('the foot names the account of the tab in front with its plan, and its bell opens Settings at the notifications', async () => {
  // Claude Code's login, in a config folder of the test's own: a Max plan
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'claude_max' } }))
  const folder = freshFolder()
  const dataDir = makeDataDir(left(folder))
  const work = '0b6f3c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'
  writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: work, name: 'Work', addedAt: '2026-10-01T09:00:00.000Z', token: 'e2e-token-work-0000000001', encrypted: false }] }))
  const { app, page } = await launchApp({ dataDir, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const account = page.locator('#tabpanel .tp-account')
  // the first tab is a shell tab, on the main account: the plan is the login's
  await expect(account.locator('.tp-account-name')).toHaveText('Main account')
  await expect(account.locator('.tp-account-plan')).toHaveText('Max plan')
  await expect(account.locator('.tp-avatar')).toHaveText('MA')
  // a Claude tab on an extra account names that account
  await page.evaluate(({ cwd, id }) => window.ct.openTab({ kind: 'claude', cwd, account: id }), { cwd: folder, id: work })
  await expect(account.locator('.tp-account-name')).toHaveText('Work')
  await expect(account.locator('.tp-account-plan')).toHaveText('Extra account')
  await expect(account.locator('.tp-avatar')).toHaveText('WO')

  await account.locator('.tp-notify').click()
  await expect.poll(() => app.windows().length).toBe(2)
  const settings = app.windows().find((w) => w !== page)!
  await expect.poll(() => settings.url()).toMatch(/#notifications$/)
  await app.close()
})

test('without a plan Claude Code names, the foot names the login', async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect(page.locator('#tabpanel .tp-account-name')).toHaveText('Main account')
  await expect(page.locator('#tabpanel .tp-account-plan')).toHaveText('Claude Code login')
  await app.close()
})

test('the active row is raised, not barred', async () => {
  const { app, page, tabId, work } = await launchClaudeTab(left(freshFolder()))
  const other = await openTab(page, 'shell', work)
  const style = (id: string): Promise<{ shadow: string, bg: string }> => row(page, id).evaluate((el) => {
    const s = getComputedStyle(el)
    return { shadow: s.boxShadow, bg: s.backgroundColor }
  })
  const active = await style(other)
  const idle = await style(tabId)
  // an inset edge of the border colour, not the accent bar of the old rows; the raised background of the active row
  expect(active.shadow).toContain('inset')
  expect(active.shadow).not.toContain('217, 119, 87')
  expect(active.bg).toBe('rgb(30, 30, 35)')
  expect(idle.bg).not.toBe(active.bg)
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

/** what the statusLine hook reports: the session's folder is workspace.project_dir, which /cd and a worktree change */
const statusIn = (tabId: string, projectDir: string) =>
  ({ v: 1 as const, type: 'status' as const, tabId, sessionId: SID, model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: null, context: null, fiveHour: null, sevenDay: null, projectDir })

test('a Claude tab follows its session into another folder (/cd, a worktree): its row shows that folder\'s branch, and the tooltip and window title the folder', async () => {
  const repo = gitRepo()
  const branch = currentBranch(repo)
  const worktree = gitWorktree(repo, 'feat/moved')
  const { app, page, pipeName, tabId } = await launchClaudeTab(left(freshFolder()), repo)
  await expect(row(page, tabId).locator('.tp-branch')).toHaveText(branch)
  await expect(row(page, tabId).locator('.tp-wtbar')).toHaveCount(0)

  // the session entered a worktree: the status line names it as the session's folder
  expect(await sendPipeMessage(pipeName, statusIn(tabId, worktree))).toMatchObject({ ok: true })
  await expect(row(page, tabId).locator('.tp-branch')).toHaveText('feat/moved')
  await expect(row(page, tabId).locator('.tp-wtbar')).toHaveCount(1)
  // the tooltip's second line is the tab's folder
  await expect.poll(async () => (await row(page, tabId).getAttribute('title'))?.split('\n')[1]).toBe(worktree)
  await expect.poll(() => page.title()).toContain(basename(worktree))

  // and left it again
  expect(await sendPipeMessage(pipeName, statusIn(tabId, repo))).toMatchObject({ ok: true })
  await expect(row(page, tabId).locator('.tp-branch')).toHaveText(branch)
  await expect.poll(async () => (await row(page, tabId).getAttribute('title'))?.split('\n')[1]).toBe(repo)
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
  await expect.poll(() => panelWidth(page)).toBe(110)
  await app.close()

  const again = await launchApp({ dataDir })
  await expect.poll(() => panelWidth(again.page)).toBe(110)
  await again.app.close()
})

test('the panel header\'s buttons work like the tab bar\'s', async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const media = page.locator('#image-panel')
  await expect(media).toHaveClass(/collapsed/)

  await page.locator('#sheet-header .tab-images-toggle').click()
  await expect(media).not.toHaveClass(/collapsed/)
  await page.locator('#sheet-header .tab-images-toggle').click()
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
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repo)
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, home])
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

test('a fold is kept however many groups were folded before: the ones folded longest ago give way', async () => {
  const dataDir = makeDataDir(left(freshFolder()))
  // projects folded over a long time, most of them gone since
  const old = Array.from({ length: 200 }, (_, i) => `gone-project-${i}`)
  writeFileSync(join(dataDir, 'tab-layout.json'), JSON.stringify({ width: 240, folded: old }))
  const { app, page } = await launchApp({ dataDir })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const noProject = groupNamed(page, 'No project')
  await noProject.locator('.tp-group-head').click()
  await expect(noProject).toHaveClass(/\bfolded\b/)
  await expect.poll(async () => (await page.evaluate(() => window.ct.getTabLayout())).folded).toEqual([...old.slice(1), '~none'])
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
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repoA)
  const b1 = await openTab(page, 'shell', repoB)
  const a2 = await openTab(page, 'shell', repoA)
  // the panel shows A1, A2, B1 (No project last), though the tabs were opened in another order
  await expect(groupNamed(page, basename(repoA))).toHaveCount(1)
  // the keys go by the settled order: a tab still in No project until its place arrives would be the next one
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, b1, home])
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

test('with the tabs on top, Ctrl+Tab and Ctrl+Alt+N walk the grouped order the bar shows', async () => {
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder(), tabs: { position: 'top' } } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repoA)
  const b1 = await openTab(page, 'shell', repoB)
  const a2 = await openTab(page, 'shell', repoA)
  // the bar shows A1, A2, B1 (No project last), though the tabs were opened in another order; the keys follow that order
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#tabbar .tab')].map((t) => t.dataset.tabId))).toEqual([a1, a2, b1, home])
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, b1, home])
  await page.evaluate((id) => window.ct.activateTab(id), a1)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a1)
  await page.locator('.terminal-host:visible .xterm').click()

  await page.keyboard.press(KEYS.nextTab)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a2)
  await page.keyboard.press(KEYS.nextTab)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, b1)

  await page.evaluate((id) => window.ct.activateTab(id), a1)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a1)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Digit3' : 'Control+Alt+Digit3')
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, b1)
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

  // the drag waits for the settled order: a tab in No project until its place arrives cannot be dropped in its group
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, b1, home])
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

  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, b1, home])
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
  const a1 = (await page.evaluate(() => window.__ct!.tabIds())).find((id) => id !== a && id !== b)!

  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a, a1, b])
  // a shell that starts draws the panel again: a drag whose source went before it started is dragged again
  await expect(async () => {
    await row(page, a).dragTo(row(page, b))
    await expect.poll(() => page.evaluate(() => window.__ct!.tabIds()), { timeout: 5000 }).toEqual([b, a, a1])
  }).toPass({ timeout: 45_000 })

  await row(page, a1!).dragTo(row(page, b))
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([b, a, a1])
  await app.close()
})

test("tabs on the left keep the order the panel shows: a project's tabs stay together, and closing the active one goes to the next", async () => {
  const repoA = gitRepo()
  const repoB = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repoA)
  const b1 = await openTab(page, 'shell', repoB)
  const a2 = await openTab(page, 'shell', repoA)
  // the panel shows A1, A2, B1 and No project last: main keeps that order too
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, b1, home])

  await page.evaluate((id) => window.ct.activateTab(id), a1)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a1)
  await page.evaluate((id) => window.ct.closeTab(id), a1)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a2)
  await app.close()
})

/** opens shell tabs in one folder outside git, until the panel holds `count` tabs with the home tab */
async function openMany(page: Page, count: number): Promise<void> {
  const folder = freshFolder()
  while ((await page.evaluate(() => window.__ct!.tabIds().length)) < count) await openTab(page, 'shell', folder)
}

/** whether a row lies within the panel's list as drawn */
const inList = (page: Page, id: string): Promise<boolean> => page.evaluate((tabId) => {
  const list = document.querySelector('#tabpanel .tp-list')!.getBoundingClientRect()
  const r = document.querySelector(`#tabpanel .tp-tab[data-tab-id="${tabId}"]`)!.getBoundingClientRect()
  return r.top >= list.top && r.bottom <= list.bottom
}, id)

test("the active tab's row is in view, however far down the list it is", async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const first = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  await openMany(page, 30)
  const list = page.locator('#tabpanel .tp-list')
  await expect.poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const last = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => inList(page, last)).toBe(true)
  await expect.poll(() => inList(page, first)).toBe(false)

  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.nextTab)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
  await expect.poll(() => inList(page, first)).toBe(true)
  await app.close()
})

test('a setting other than the tabs position keeps the scroll of the panel', async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await openMany(page, 30)
  const list = page.locator('#tabpanel .tp-list')
  // the panel scrolled down to its end: a list that is not scrolled would show nothing
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const before = await list.evaluate((el) => el.scrollTop)

  const hide = (await page.evaluate(() => window.ct.getSettings())).review.hideTests
  await page.evaluate((on) => window.ct.setSetting('review.hideTests', on), !hide)
  await expect.poll(() => page.evaluate(() => window.ct.getSettings()).then((s) => s.review.hideTests)).toBe(!hide)
  await page.waitForTimeout(300)
  expect(await list.evaluate((el) => el.scrollTop)).toBe(before)
  await app.close()
})

test('switching the tabs to the left unfolds the group of the active tab', async () => {
  const repo = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repo)
  const group = groupNamed(page, basename(repo))
  await expect(group).toHaveCount(1)
  await group.locator('.tp-group-head').click()
  await expect(group).toHaveClass(/\bfolded\b/)

  await page.locator('#tabpanel .tab-position').click()
  await expect(page.locator('#tabbar')).toBeVisible()
  await page.evaluate((id) => window.ct.activateTab(id), home)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, home)
  await page.evaluate((id) => window.ct.activateTab(id), a1)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, a1)

  await page.locator('#tabbar .tab-position').click()
  await expect(page.locator('#tabpanel')).toBeVisible()
  await expect(group).not.toHaveClass(/\bfolded\b/)
  await expect(row(page, a1)).toBeVisible()
  await app.close()
})

test('switching the tabs from the top to the left shows the active row', async () => {
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await openMany(page, 30)
  const last = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const list = page.locator('#tabpanel .tp-list')

  await page.locator('#tabbar .tab-position').click()
  await expect(page.locator('#tabpanel')).toBeVisible()
  await expect.poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect.poll(() => inList(page, last)).toBe(true)
  await app.close()
})

test("a drag that never ended leaves no tab to move: a file dragged over a row is not a tab drop", async () => {
  const repo = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repo)
  const a2 = await openTab(page, 'shell', repo)
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, home])

  // a drag of the second row whose end never reaches the page
  await page.evaluate((id) => {
    document.querySelector(`#tabpanel .tp-tab[data-tab-id="${id}"]`)!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }))
  }, a2)
  // later a file from the OS is dragged over the first row and dropped there: no tab moves
  await page.evaluate((id) => {
    const files = new DataTransfer()
    files.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }))
    const row = document.querySelector(`#tabpanel .tp-tab[data-tab-id="${id}"]`)!
    row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: files }))
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files }))
  }, a1)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, home])
  await app.close()
})

test("a file dragged over a tab of the top bar is not a tab drop", async () => {
  const repo = gitRepo()
  const { app, page } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: freshFolder() } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repo)
  const a2 = await openTab(page, 'shell', repo)
  // the tab bar groups by project, No project last: the repository's tabs come first once the home tab's place is known
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, home])

  await page.evaluate((id) => {
    document.querySelector(`#tabbar .tab[data-tab-id="${id}"]`)!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }))
  }, a2)
  await page.evaluate((id) => {
    const files = new DataTransfer()
    files.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }))
    const tab = document.querySelector(`#tabbar .tab[data-tab-id="${id}"]`)!
    tab.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: files }))
    tab.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files }))
  }, a1)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, home])
  await app.close()
})

test('a drag that ends off the rows leaves no tab to move, so a later drop reorders nothing', async () => {
  const repo = gitRepo()
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const a1 = await openTab(page, 'shell', repo)
  const a2 = await openTab(page, 'shell', repo)
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, home])

  // a drag of the second row whose end never reaches it (its row was rebuilt meanwhile): the end is on the document
  await page.evaluate((id) => {
    document.querySelector(`#tabpanel .tp-tab[data-tab-id="${id}"]`)!.dispatchEvent(new DragEvent('dragstart', { bubbles: true }))
    document.dispatchEvent(new DragEvent('dragend'))
  }, a2)
  // later, a drop on the first row (a file dragged from outside, say) moves nothing
  await page.evaluate((id) => {
    document.querySelector(`#tabpanel .tp-tab[data-tab-id="${id}"]`)!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }))
  }, a1)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([a1, a2, home])
  await app.close()
})

test("the panel header's Note button shows and hides a Claude tab's note; a shell tab has no Note button", async () => {
  const { app, page } = await launchClaudeTab(left(freshFolder()))
  const button = page.locator('#sheet-header .tab-note-toggle')
  const card = page.locator('#note .note-card')
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('title', `Note (${KEY_LABELS.note})`)
  await expect(button).not.toHaveClass(/active/)

  await button.click()
  await expect(card).toBeVisible()
  await expect(card.locator('.note-text')).toBeFocused()
  await expect(button).toHaveClass(/active/)
  await page.keyboard.type('Goal: payments')
  await button.click()
  await expect(card).toBeHidden()
  await expect(button).not.toHaveClass(/active/)
  await button.click()
  await expect(card).toBeVisible()
  await expect(card.locator('.note-text')).toHaveValue('Goal: payments')

  await openTab(page, 'shell', freshFolder())
  await expect(button).toBeHidden()
  await expect(card).toBeHidden()
  await app.close()
})

test('a tab whose note has text shows the note mark in the first line of its row', async () => {
  const { app, page, tabId, work } = await launchClaudeTab(left(freshFolder()))
  const second = await openTab(page, 'claude', work)
  const mark = (id: string): Locator => row(page, id).locator('.tp-l1 .tab-note')
  await expect(row(page, second)).toBeVisible()
  await expect(mark(second)).toHaveCount(0)

  // the shortcut, not the panel's button: this test is about the mark
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.note)
  await expect(page.locator('#note .note-text')).toBeFocused()
  await page.keyboard.type('TODO: tests')
  await expect(mark(second)).toHaveCount(1)
  await expect(mark(second)).toHaveAttribute('title', 'Has a note')
  await expect(mark(tabId)).toHaveCount(0)
  await app.close()
})

test("the panel header's Docs button shows once a Claude tab has a document, and opens and hides the Docs panel", async () => {
  const { app, page, pipeName, tabId, work } = await launchClaudeTab(left(freshFolder()))
  const button = page.locator('#sheet-header .tab-docs-toggle')
  const panel = page.locator('#image-panel')
  await expect(page.locator('#sheet-header .tab-changes-toggle')).toBeVisible()
  await expect(button).toBeHidden()

  const spec = join(work, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_document', tabId, path: spec, title: null })).toMatchObject({ ok: true })
  await expect(page.locator('.panel-title')).toHaveText('Docs')
  await expect(button).toBeVisible()
  await expect(button).toHaveClass(/active/)
  await expect(button).toHaveAttribute('title', `Docs (${KEY_LABELS.docs})`)
  // the panel's header holds + and ▾ and the position button: the side-panel toggles are in the sheet's header
  const shown = await page.locator('#tabpanel .tp-head button').evaluateAll((els) => els.filter((el) => !(el as HTMLElement).hidden).map((el) => el.classList[0]))
  expect(shown).toEqual(['tab-new', 'tab-menu'])
  const foot = await page.locator('#tabpanel .tp-foot button').evaluateAll((els) => els.filter((el) => !(el as HTMLElement).hidden).map((el) => el.classList[0]))
  expect(foot).toEqual(['tp-recent', 'tp-notify', 'tp-settings', 'tab-position'])

  await button.click()
  await expect(panel).toHaveClass(/collapsed/)
  await expect(button).not.toHaveClass(/active/)
  await button.click()
  await expect(panel).not.toHaveClass(/collapsed/)
  await expect(page.locator('.doc-md h1')).toHaveText('Spec')
  await app.close()
})

/** the column's buttons by their first class, each with its box, and the box of the part that holds them (its inner box) */
const columnBoxes = (page: Page, holder: string): Promise<{ box: { left: number, top: number, right: number, bottom: number }, buttons: { name: string, left: number, top: number, right: number, bottom: number }[] }> =>
  page.locator(holder).evaluate((el) => {
    const box = el.getBoundingClientRect()
    return {
      box: { left: box.left, top: box.top, right: box.left + el.clientWidth, bottom: box.top + el.clientHeight },
      buttons: [...el.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => {
        const r = b.getBoundingClientRect()
        return { name: b.classList[0], left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      })
    }
  })

test('at its narrowest, half its first width, the column keeps every button inside it: New tab and ▾ in the head, Recent sessions on its row and the account row\'s buttons on theirs in the foot', async () => {
  const { app, page, pipeName, tabId, work } = await launchClaudeTab(left(freshFolder()))
  const spec = join(work, 'spec.md')
  writeFileSync(spec, '# Spec\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_document', tabId, path: spec, title: null })).toMatchObject({ ok: true })
  await expect(page.locator('#sheet-header .tab-docs-toggle')).toBeVisible()
  await expect(page.locator('#sheet-header .tab-note-toggle')).toBeVisible()
  // as wide as it starts, the head is one row, the foot's Recent sessions has its own row, and the labels show
  const wideHead = await columnBoxes(page, '#tabpanel .tp-head')
  expect(new Set(wideHead.buttons.map((b) => b.top)).size).toBe(1)
  await expect(page.locator('#tabpanel .tp-new .tp-label')).toBeVisible()
  await expect(page.locator('#tabpanel .tp-recent .tp-label')).toBeVisible()

  await dragBy(page, page.locator('#tabpanel .tp-resize'), -1000)
  await expect.poll(() => panelWidth(page)).toBe(110)
  const head = await columnBoxes(page, '#tabpanel .tp-head')
  const foot = await columnBoxes(page, '#tabpanel .tp-foot')
  expect(head.buttons.map((b) => b.name).sort()).toEqual(['tab-menu', 'tab-new'])
  expect(foot.buttons.map((b) => b.name).sort()).toEqual(['tab-position', 'tp-notify', 'tp-recent', 'tp-settings'])
  // each row stays on one line: the head, and the account row's buttons under Recent sessions
  expect(new Set(head.buttons.map((b) => b.top)).size).toBe(1)
  const accountRow = foot.buttons.filter((b) => b.name !== 'tp-recent')
  expect(new Set(accountRow.map((b) => b.top)).size).toBe(1)
  expect(accountRow[0]!.top).toBeGreaterThan(foot.buttons.find((b) => b.name === 'tp-recent')!.top)
  // the narrow column drops the words, and the account's avatar and names: New tab keeps its icon, and so do the footer's buttons
  await expect(page.locator('#tabpanel .tp-account-text')).toBeHidden()
  await expect(page.locator('#tabpanel .tp-avatar')).toBeHidden()
  await expect(page.locator('#tabpanel .tp-label').first()).toBeHidden()
  await expect(page.locator('#tabpanel .tp-new svg')).toBeVisible()
  await expect(page.locator('#tabpanel .tp-settings svg')).toBeVisible()
  // every button lies inside the column: one past its right edge would lie under the terminal
  const all = [...head.buttons, ...foot.buttons]
  const column = (await columnBoxes(page, '#tabpanel')).box
  for (const b of all) {
    expect(b.left).toBeGreaterThanOrEqual(column.left)
    expect(b.right).toBeLessThanOrEqual(column.right)
    expect(b.top).toBeGreaterThanOrEqual(column.top)
    expect(b.bottom).toBeLessThanOrEqual(column.bottom)
  }
  // no button covers another
  for (const a of all) {
    for (const b of all) {
      if (a !== b) expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)
    }
  }
  // the side-panel toggles are in the sheet's header, out of the panel's way
  await expect(page.locator('#sheet-header .tab-images-toggle')).toBeVisible()

  // the toggles work there as anywhere
  await page.locator('#sheet-header .tab-images-toggle').click()
  await expect(page.locator('.panel-title')).toHaveText('Media')
  await app.close()
})

test('with the tabs on the left, a side panel dragged wider stops at 70% of the workspace, so the terminal keeps its width', async () => {
  const { app, page } = await launchClaudeTab(left(freshFolder()))
  await page.locator('#sheet-header .tab-images-toggle').click()
  await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)

  await dragBy(page, page.locator('#image-panel .panel-resize'), -1000)
  const sizes = await page.evaluate(() => ({
    panel: document.getElementById('image-panel')!.getBoundingClientRect().width,
    workspace: document.getElementById('workspace')!.getBoundingClientRect().width,
    terminal: document.getElementById('terminals')!.getBoundingClientRect().width
  }))
  // whole pixels: the panel is laid out in fractions, and 900.00006 px is the 70% share
  expect(Math.round(sizes.panel)).toBeLessThanOrEqual(Math.round(sizes.workspace * 0.7))
  expect(sizes.panel).toBeGreaterThan(sizes.workspace * 0.6)
  expect(sizes.terminal).toBeGreaterThan(0)
  await app.close()
})

test('a click on a tab in the left panel activates it even when the panel is drawn again between the press and the release', async () => {
  const { app, page } = await launchApp({ settings: left(freshFolder()) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const firstId = (await page.evaluate(() => window.__ct!.tabIds()))[0]
  const secondId = await openTab(page, 'shell', freshFolder())
  await expect(row(page, secondId)).toBeVisible()
  // the panel settles first: the new tab is in front and both tabs' places are known, so no later redraw moves the rows
  await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(secondId)
  await expect.poll(() => page.evaluate((ids) => ids.every((id) => window.__ct!.placeEvents!(id).length > 0), [firstId, secondId])).toBe(true)

  // what lies at a point: a row's tab id, or what is there instead, so a failure says it
  const under = (p: { x: number, y: number }): Promise<string> => page.evaluate((q) => {
    const el = document.elementFromPoint(q.x, q.y)
    const id = (el?.closest('.tp-tab') as HTMLElement | null)?.dataset.tabId
    return id ?? `${el?.tagName ?? 'nothing'}.${el?.className ?? ''} at ${q.x},${q.y} in ${innerWidth}x${innerHeight}`
  }, p)
  // the press lands on the first tab's row: measured and checked together, again while a starting shell still redraws
  // the panel, since a row drawn anew between the two leaves a stale point
  let c = { x: 0, y: 0 }
  await expect.poll(async () => {
    c = await centre(row(page, firstId))
    return under(c)
  }).toBe(firstId)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await row(page, firstId).evaluate((el) => { (window as any).__pressed = el })
  // a busy Claude retitles its tab: the panel is built again while the button is down
  await page.evaluate((id) => window.ct.renameTab(id, 'redrawn'), secondId)
  await expect.poll(() => page.evaluate(() => (window as any).__pressed.isConnected)).toBe(false)
  await expect.poll(() => under(c)).toBe(firstId)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(firstId)

  // a press on one tab released on another activates neither
  await row(page, secondId).click()
  await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(secondId)
  const from = await centre(row(page, firstId))
  const to = await centre(row(page, secondId))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(secondId)
  await app.close()
})

/** a Claude tab in a background row of the left panel, and a way to make Claude wait in it */
async function waitingRow(): Promise<{ app: ElectronApplication, page: Page, claude: string, wait: (reason: AttentionReason) => Promise<unknown> }> {
  const folder = freshFolder()
  const { app, page, pipeName } = await launchApp({ settings: left(folder) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const claude = await openTab(page, 'claude', folder)
  await page.evaluate((id) => window.ct.activateTab(id), home)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, home)
  const wait = (reason: AttentionReason): Promise<unknown> => sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: SID, reason })
  return { app, page, claude, wait }
}

test('a waiting row names what Claude waits for in a word that breathes, a finished turn reads Done in green, and opening the tab clears it', async () => {
  const { app, page, claude, wait } = await waitingRow()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const status = row(page, claude).locator('.tab-status')
  // found and read in one go: a redraw of the panel replaces the word
  const look = (): Promise<{ animation: string, color: string }> => page.evaluate((id) => {
    const s = getComputedStyle(document.querySelector(`#tabpanel [data-tab-id="${id}"] .tab-status`)!)
    return { animation: s.animationName, color: s.color }
  }, claude)
  expect(await wait('question')).toEqual({ ok: true })
  await expect(status).toHaveText('Question')
  // the word takes the badge's place
  await expect(row(page, claude).locator('.tab-attn')).toHaveCount(0)
  const asks = await look()
  expect(asks.animation).toBe('tab-status-breathe')
  expect(await wait('permission')).toEqual({ ok: true })
  await expect(status).toHaveText('Permission')
  expect(await wait('done')).toEqual({ ok: true })
  await expect(status).toHaveText('Done')
  await expect(row(page, claude).locator('.tab-icon.done')).toHaveCount(1)
  // Done breathes too, in the app's green (#63C08F), not in the accent
  expect(await look()).toEqual({ animation: 'tab-status-breathe', color: 'rgb(99, 192, 143)' })
  expect(asks.color).not.toBe('rgb(99, 192, 143)')

  await page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect(status).toHaveCount(0)
  await expect(row(page, claude).locator('.tab-icon.done')).toHaveCount(0)
  await app.close()
})

test('a waiting row pulses softly under its word, in step with it: in the accent while Claude asks, in green once it has answered, still under reduced motion', async () => {
  const { app, page, claude, wait } = await waitingRow()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // the pulse is a layer under the row's content, its ::before; read beside the colours the same 10% mix gives in the
  // accent and in the green. Found and read in one go: a redraw of the panel replaces the row
  const look = (): Promise<{ animation: string, bg: string, accent: string, green: string }> => page.evaluate((id) => {
    const s = getComputedStyle(document.querySelector(`#tabpanel [data-tab-id="${id}"]`)!, '::before')
    const mix = (v: string): string => {
      const p = document.createElement('div')
      p.style.background = `color-mix(in srgb, var(${v}) 10%, transparent)`
      document.body.append(p)
      const c = getComputedStyle(p).backgroundColor
      p.remove()
      return c
    }
    return { animation: s.animationName, bg: s.backgroundColor, accent: mix('--accent'), green: mix('--green') }
  }, claude)
  // how far into its 2 s cycle an animation is; the row's pulse and its word's breath run on one clock
  const phase = (name: string): Promise<number> => page.evaluate((n) => {
    const t = document.getAnimations().find((a) => (a as CSSAnimation).animationName === n)?.effect?.getComputedTiming()
    return t ? (((Number(t.localTime) - Number(t.delay)) % 2000) + 2000) % 2000 : -1
  }, name)

  expect(await wait('question')).toEqual({ ok: true })
  await expect(row(page, claude).locator('.tab-status')).toHaveText('Question')
  const asks = await look()
  expect(asks.animation).toBe('tab-row-pulse')
  expect(asks.bg).toBe(asks.accent)
  const drift = Math.abs((await phase('tab-row-pulse')) - (await phase('tab-status-breathe')))
  expect(Math.min(drift, 2000 - drift)).toBeLessThan(100)

  expect(await wait('done')).toEqual({ ok: true })
  await expect(row(page, claude).locator('.tab-status')).toHaveText('Done')
  const done = await look()
  expect(done.animation).toBe('tab-row-pulse')
  expect(done.bg).toBe(done.green)
  expect(done.green).not.toBe(done.accent)

  // under reduced motion the tint stays, still
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await look()).toMatchObject({ animation: 'none', bg: done.green })

  // the tab in front never pulses
  await page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect(row(page, claude)).toHaveClass(/\bactive\b/)
  await expect(row(page, claude)).not.toHaveClass(/\battention\b/)
  expect((await look()).animation).toBe('none')
  await app.close()
})

test('a waiting row\'s word stands at the row\'s right end whatever marks come before it, and the row\'s own background stays a row\'s', async () => {
  const folder = freshFolder()
  const { app, page, pipeName } = await launchApp({ settings: left(folder) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const plain = await openTab(page, 'claude', folder)
  const muted = await openTab(page, 'claude', folder)
  const idle = await openTab(page, 'claude', folder)
  await page.evaluate((id) => window.ct.muteTab(id, true), muted)
  await page.evaluate((id) => window.ct.activateTab(id), home)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, home)
  for (const id of [plain, muted]) {
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: id, sessionId: SID, reason: 'question' })).toEqual({ ok: true })
    await expect(row(page, id).locator('.tab-status')).toHaveText('Question')
  }
  await expect(row(page, muted).locator('.tab-muted')).toHaveCount(1)
  // the pointer is off the rows: a row pointed at shows its × in its word's place (where the runner's cursor lies is not the test's)
  await page.mouse.move(1, 1)
  for (const id of [plain, muted]) await expect(row(page, id).locator('.tab-status')).toBeVisible()
  const right = (id: string): Promise<number> => row(page, id).locator('.tab-status').evaluate((el) => el.getBoundingClientRect().right)
  expect(Math.abs((await right(plain)) - (await right(muted)))).toBeLessThanOrEqual(0.5)
  // the pulse is a layer under the row's content: the row's own background is a row's like any other, so a hover still shows
  const background = (id: string): Promise<string> => row(page, id).evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(await background(plain)).toBe(await background(idle))
  expect(await background(muted)).toBe(await background(idle))
  await app.close()
})

test('pointing at a row with a word shows the row\'s × in the word\'s place', async () => {
  const { app, page, claude, wait } = await waitingRow()
  const status = row(page, claude).locator('.tab-status')
  const close = row(page, claude).locator('.tab-close')
  expect(await wait('question')).toEqual({ ok: true })
  await expect(status).toBeVisible()
  await expect(close).toBeHidden()
  await row(page, claude).hover()
  await expect(status).toBeHidden()
  await expect(close).toBeVisible()
  await page.locator('#titlebar').hover()
  await expect(status).toBeVisible()
  await app.close()
})

test('an open group shows its count, a pulsing dot while one of its tabs waits, and a drawn chevron', async () => {
  const folder = freshFolder()
  const repo = gitRepo()
  const { app, page, pipeName } = await launchApp({ settings: left(folder) })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]!
  const claude = await openTab(page, 'claude', repo)
  await openTab(page, 'shell', repo)
  const group = groupNamed(page, basename(repo))
  await expect(group).toHaveCount(1)
  await expect(group).not.toHaveClass(/\bfolded\b/)
  await expect(group.locator('.tp-group-count')).toHaveText('2')
  await expect(group.locator('.tp-group-dot')).toHaveCount(0)
  await expect(group.locator('.tp-chevron svg')).toHaveCount(1)

  await page.evaluate((id) => window.ct.activateTab(id), home)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, home)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: SID, reason: 'question' })).toEqual({ ok: true })
  await expect(group.locator('.tp-group-dot')).toHaveClass(/\bpulse\b/)
  await expect(group.locator('.tp-tab')).toHaveCount(2)
  await app.close()
})
