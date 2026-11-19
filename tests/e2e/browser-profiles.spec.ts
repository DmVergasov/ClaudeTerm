import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserProfileAction, BrowserPanelState } from '../../src/shared/browser'
import { settingsWindow } from './account-helpers'
import { browserCmd, startSiteServer, type SiteServer } from './browser-helpers'
import { launchApp, launchClaudeTab, openTabInFront } from './helpers'

// The Browser's profiles: a profile is its own set of cookies and storage, the panel's profile menu picks one for a tab, and
// Settings › Browser adds, renames, defaults, deletes and clears them. A tab's pages come back after a restart.
// The sites are the site server's: 127.0.0.1 is a local page, so Claude works there without a card.

const PANEL = '.panel-browser'
const PROFILE = `${PANEL} .browser-profile`
const CLEAR = `${PANEL} .browser-clear`
const CARD = `${PANEL} .browser-card`
const CARD_TEXT = `${CARD} .browser-card-text`
const SHORTCUT = process.platform === 'darwin' ? 'Meta+KeyB' : 'Control+Shift+KeyB'
/** a session id for the saved tab, so that Restore brings the tab back (the tab's conversation is not part of this test) */
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

/** a profile action, as the Settings page sends it */
function profileAction(page: Page, a: BrowserProfileAction): Promise<unknown> {
  return page.evaluate((x) => window.ct.browserProfileAction(x), a)
}

/** the profile names in the order the profiles view has them */
async function profileNames(page: Page): Promise<string[]> {
  return (await page.evaluate(() => window.ct.browserProfiles())).profiles.map((p) => p.name)
}

/** the id of the profile with this name */
async function idOf(page: Page, name: string): Promise<string> {
  const found = (await page.evaluate(() => window.ct.browserProfiles())).profiles.find((p) => p.name === name)
  if (!found) throw new Error(`no profile named ${name}`)
  return found.id
}

/** the Browser panel is shown: the shortcut opens it when it is not */
async function showBrowserPanel(page: Page): Promise<void> {
  if (await page.locator(PANEL).isVisible()) return
  await page.keyboard.press(SHORTCUT)
  await expect(page.locator(PANEL)).toBeVisible()
}

/** the panel's profile menu, then the profile with this name, as the person chooses it */
async function chooseProfile(page: Page, name: string): Promise<void> {
  await showBrowserPanel(page)
  await page.locator(PROFILE).click()
  await page.locator('.menu .menu-item', { hasText: new RegExp(`^(✓ )?${name}$`) }).click()
}

/** the tab's browser state as the panel has it */
function stateOf(page: Page, tabId: string): Promise<BrowserPanelState | null> {
  return page.evaluate((id) => window.ct.browserState(id), tabId)
}

/** the first page of the tab is at this address, as main has it */
async function pageAt(page: Page, tabId: string, url: string): Promise<void> {
  await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.url).toBe(url)
}

/** the cookies the page's partition holds for the site's address */
function cookieCount(app: ElectronApplication, partition: string, url: string): Promise<number> {
  return app.evaluate(async ({ session }, args) => (await session.fromPartition(args.partition).cookies.get({ url: args.url })).length, { partition, url })
}

/** the text a page's #c shows, as the page's own script wrote it */
async function cookieSeen(pipeName: string, tabId: string, site: SiteServer): Promise<string> {
  await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/cookie') })
  const reply = await browserCmd(pipeName, tabId, { op: 'evaluate', function: '() => document.getElementById("c").textContent', ref: null })
  return reply.info ?? ''
}

/** the Settings profile row at this index: Default is the first */
const rowAt = (win: Page, index: number) => win.locator('.browser-profile-row').nth(index)

/** every window closes, Settings' too, and the app with them: the session is saved on the way out */
async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close() }).catch(() => {})
  await closed
}

/** the always-allowed sites of a profile, as the profiles file has them */
function allowedSitesOf(dataDir: string, id: string): string[] {
  const store = JSON.parse(readFileSync(join(dataDir, 'browser-profiles.json'), 'utf8')) as { profiles: { id: string; allowed: string[] }[] }
  return store.profiles.find((p) => p.id === id)?.allowed ?? []
}

test('profiles can be added, renamed and made default', async () => {
  const { app, page, work } = await launchClaudeTab()
  try {
    const win = await settingsWindow(app, page, 'browser')
    await win.locator('.browser-add-name').fill('Work')
    await win.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(rowAt(win, 1).locator('.browser-profile-name')).toHaveValue('Work')
    await rowAt(win, 1).locator('.browser-profile-name').fill('Work 2')
    await rowAt(win, 1).locator('.browser-profile-name').press('Enter')
    await expect.poll(() => profileNames(page)).toEqual(['Default', 'Work 2'])
    await expect(rowAt(win, 0).getByRole('radio')).toBeChecked()
    await rowAt(win, 1).getByRole('radio').check()
    await expect.poll(async () => (await page.evaluate(() => window.ct.browserProfiles())).defaultId).toBe(await idOf(page, 'Work 2'))
    // a new Claude tab starts on the default profile, and its panel says so
    await openTabInFront(page, 'claude', work)
    await showBrowserPanel(page)
    await expect(page.locator(PROFILE)).toHaveText('Work 2')
  } finally {
    await app.close()
  }
})

test('a profile added in the main window shows in an open Settings window, without a reload', async () => {
  // the list goes to every window: a change made in the main window reaches the Browser section that is already open
  const { app, page } = await launchClaudeTab()
  try {
    const win = await settingsWindow(app, page, 'browser')
    await expect(rowAt(win, 0)).toBeVisible()
    await profileAction(page, { type: 'add', name: 'Work' })
    await expect(win.locator('.browser-profile-name').last()).toHaveValue('Work')
  } finally {
    await app.close()
  }
})

test("a tab's profile switch keeps the URLs", async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await profileAction(page, { type: 'add', name: 'Work' })
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page') })
    await chooseProfile(page, 'Work')
    await expect(page.locator(PROFILE)).toHaveText('Work')
    await pageAt(page, tabId, site.url('/page'))
    expect(await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })).toMatchObject({ ok: true, info: expect.stringContaining(site.url('/page')) })
  } finally {
    await site.close()
    await app.close()
  }
})

test('cookies stay in their profile', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await profileAction(page, { type: 'add', name: 'Work' })
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await browserCmd(pipeName, tabId, { op: 'evaluate', function: "() => { document.cookie = 'k=default-1; path=/' }" })
    await chooseProfile(page, 'Work')
    await pageAt(page, tabId, site.url('/form'))
    expect(await cookieSeen(pipeName, tabId, site)).not.toContain('k=default-1')
    await chooseProfile(page, 'Default')
    await pageAt(page, tabId, site.url('/cookie'))
    expect(await cookieSeen(pipeName, tabId, site)).toContain('k=default-1')
  } finally {
    await site.close()
    await app.close()
  }
})

test('deleting a profile moves its tabs to Default', async () => {
  const { app, page, pipeName, tabId, dataDir } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await profileAction(page, { type: 'add', name: 'Work' })
    await chooseProfile(page, 'Work')
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page') })
    await expect(page.locator(PROFILE)).toHaveText('Work')
    const win = await settingsWindow(app, page, 'browser')
    await rowAt(win, 1).getByRole('button', { name: 'Delete', exact: true }).click()
    await win.locator('.account-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.locator(PROFILE)).toHaveText('Default')
    await pageAt(page, tabId, site.url('/page'))
    expect(await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })).toMatchObject({ ok: true, info: expect.stringContaining(site.url('/page')) })
    // the session no longer names the deleted profile, and the profiles file lists no Work
    await closeWindow(app)
    const saved = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: { browser?: { profile: string } }[] }
    expect(saved.tabs[0].browser?.profile).toBe('default')
    expect(readFileSync(join(dataDir, 'browser-profiles.json'), 'utf8')).not.toContain('"Work"')
  } finally {
    await site.close()
    await app.close().catch(() => undefined)
  }
})

test('pages come back after a restart', async () => {
  const { app, pipeName, tabId, dataDir } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await browserCmd(pipeName, tabId, { op: 'tabs', action: 'new', url: site.url('/page') })
    await closeWindow(app)
    // the saved tab names a conversation, as a Claude tab with a session does, so that Restore offers it
    const file = join(dataDir, 'session-state.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { tabs: { claudeSessionId: string | null }[] }
    saved.tabs[0].claudeSessionId = SID
    writeFileSync(file, JSON.stringify(saved))
    const again = await launchApp({ dataDir })
    const { page: back } = again
    try {
      await expect.poll(() => back.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
      await back.locator('.banner-restore').click()
      await back.waitForFunction(() => window.__ct!.tabIds().length === 1)
      const id = (await back.evaluate(() => window.__ct!.activeTabId()))!
      // the pages wait for the panel: none is loaded before the Browser panel shows the tab
      const loaded = await again.app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().map((w) => w.getURL()).filter((u) => u.startsWith(prefix)), `http://127.0.0.1:${site.port}`)
      expect(loaded).toEqual([])
      await showBrowserPanel(back)
      await expect(back.locator(`${PANEL} .browser-page-tab`)).toHaveCount(2)
      await expect(back.locator(`${PANEL} .browser-page-tab.current .browser-page`)).toHaveAttribute('title', site.url('/page'))
      await pageAt(back, id, site.url('/form'))
      const listed = await browserCmd(again.pipeName, id, { op: 'tabs', action: 'list' })
      expect(listed.info).toContain(site.url('/form'))
      expect(listed.info).toContain(site.url('/page'))
    } finally {
      await again.app.close().catch(() => undefined)
    }
  } finally {
    await site.close()
  }
})

// the always-allowed sites are listed in Settings and removed there; the next navigation to the site asks again
test('the always list can be edited', async () => {
  const { app, page, pipeName, tabId, dataDir } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    const first = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'site.test') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    await page.locator(`${CARD} button`, { hasText: 'Always allow' }).click()
    expect(await first).toMatchObject({ ok: true })
    const id = await idOf(page, 'Default')
    const win = await settingsWindow(app, page, 'browser')
    await expect(rowAt(win, 0).locator('.browser-allowed')).toContainText('site.test')
    await rowAt(win, 0).getByRole('button', { name: 'Remove site.test' }).click()
    await expect(rowAt(win, 0).locator('.browser-allowed')).toContainText('None')
    await expect.poll(() => allowedSitesOf(dataDir, id)).toEqual([])
    const second = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form', 'site.test') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    await page.locator(`${CARD} button`, { hasText: 'Deny' }).click()
    expect(await second).toEqual({ ok: false, error: 'The person did not allow site.test.' })
  } finally {
    await site.close()
    await app.close()
  }
})

/** the saved session names a conversation for its Claude tab, so that Restore offers the tab back */
function nameConversation(dataDir: string): void {
  const file = join(dataDir, 'session-state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { tabs: { claudeSessionId: string | null }[] }
  saved.tabs[0].claudeSessionId = SID
  writeFileSync(file, JSON.stringify(saved))
}

/** the restore banner brings the saved tab back */
async function restoreTab(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
}

test('a profile change closes the clear row of the tab', async () => {
  const { app, page } = await launchClaudeTab()
  try {
    await profileAction(page, { type: 'add', name: 'Work' })
    await showBrowserPanel(page)
    await page.locator(`${PANEL} .browser-more`).click()
    await page.locator('.menu .menu-item', { hasText: "Clear this profile's data…" }).click()
    await expect(page.locator(CLEAR)).toBeVisible()
    await chooseProfile(page, 'Work')
    await expect(page.locator(CLEAR)).toBeHidden()
  } finally {
    await app.close()
  }
})

test("the current profile's row in the profile menu closes the menu and changes nothing", async () => {
  const { app, page } = await launchClaudeTab()
  try {
    await showBrowserPanel(page)
    await page.locator(PROFILE).click()
    await page.locator('.menu .menu-item', { hasText: /^✓ Default$/ }).click()
    await expect(page.locator('.menu')).toHaveCount(0)
    await expect(page.locator(PROFILE)).toHaveText('Default')
  } finally {
    await app.close()
  }
})

test('pages survive two restarts when the panel is not shown in between', async () => {
  const { app, pipeName, tabId, dataDir } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await browserCmd(pipeName, tabId, { op: 'tabs', action: 'new', url: site.url('/page') })
    await closeWindow(app)
    nameConversation(dataDir)
    const first = await launchApp({ dataDir })
    await restoreTab(first.page)
    await closeWindow(first.app)
    nameConversation(dataDir)
    const second = await launchApp({ dataDir })
    try {
      await restoreTab(second.page)
      await showBrowserPanel(second.page)
      await expect(second.page.locator(`${PANEL} .browser-page-tab`)).toHaveCount(2)
    } finally {
      await second.app.close().catch(() => undefined)
    }
  } finally {
    await site.close()
  }
})

test("the panel clears its profile's data", async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await browserCmd(pipeName, tabId, { op: 'evaluate', function: "() => { document.cookie = 'k=default-1; path=/' }" })
    expect(await cookieSeen(pipeName, tabId, site)).toContain('k=default-1')
    await showBrowserPanel(page)
    await page.locator(`${PANEL} .browser-more`).click()
    await page.locator('.menu .menu-item', { hasText: "Clear this profile's data…" }).click()
    await expect(page.locator(CLEAR)).toContainText('Clear the cookies, storage and cache of Default? Sign-ins in it are lost.')
    await page.locator(CLEAR).getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(page.locator(CLEAR)).toBeHidden()
    await expect.poll(() => cookieCount(app, 'persist:browser-default', site.url('/'))).toBe(0)
    expect(await cookieSeen(pipeName, tabId, site)).not.toContain('k=default-1')
  } finally {
    await site.close()
    await app.close()
  }
})
