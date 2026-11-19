import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { settingsWindow } from './account-helpers'
import { browserCmd, startSiteServer, type SiteServer } from './browser-helpers'
import { FAKE_CLAUDE_SETTINGS, launchApp, ROOT } from './helpers'

// Cookie import: Settings › Browser › Import cookies… copies the cookies of another browser's profile into a ClaudeTerm profile.
// Every browser here is invented: the folders live under a temp root of the test, and the stand-ins read and write only that root.
// The sites are the site server's (127.0.0.1), so a Claude tab reads the imported cookies with its own `navigate /cookie`.

const STAND_IN_BROWSER = resolve(ROOT, 'tests', 'fixtures', 'stand-in-browser.mjs')
const STAND_IN_DEVTOOLS = resolve(ROOT, 'tests', 'fixtures', 'stand-in-devtools.mjs')
const PANEL = '.panel-browser'
const PROFILE = `${PANEL} .browser-profile`
const SHORTCUT = process.platform === 'darwin' ? 'Meta+KeyB' : 'Control+Shift+KeyB'
const DAY_S = 86400

/** the environment of a test run that reads a browser root of its own: the platform is Windows, so every browser's folders are the Windows ones */
function rootEnv(root: string): Record<string, string> {
  return {
    CLAUDETERM_TEST_BROWSER_PLATFORM: 'win32',
    CLAUDETERM_TEST_BROWSER_ROOT: root,
    CLAUDETERM_TEST_BROWSER_STANDIN: STAND_IN_BROWSER,
    CLAUDETERM_TEST_BROWSER_DEVTOOLS: STAND_IN_DEVTOOLS,
  }
}

/** a temp root of the test: it is deleted when the test ends */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ct-import-root-'))
}

/** the app with a Claude tab in front, whose profile is Default until the test changes it */
async function launchWithTab(root: string | null, dataDir?: string): Promise<{ app: ElectronApplication; page: Page; pipeName: string; dataDir: string; tabId: string }> {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const env = root ? rootEnv(root) : {}
  const launched = await launchApp({ dataDir, settings: dataDir ? undefined : FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, tabId }
}

/** the Chromium folder of a test root: Local State lists two profiles, and only the second has cookies (copied by the stand-in) */
function chromiumBrowser(root: string): string {
  const udd = join(root, 'localappdata', 'Chromium', 'User Data')
  mkdirSync(join(udd, 'Default'), { recursive: true })
  mkdirSync(join(udd, 'Profile 1', 'Network'), { recursive: true })
  writeFileSync(join(udd, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Test Profile' } } } }))
  // an invented cookie for 127.0.0.1, in the JSON the copy stand-in answers with
  const expires = Math.floor(Date.now() / 1000) + 30 * DAY_S
  writeFileSync(join(udd, 'Profile 1', 'Network', 'Cookies'), JSON.stringify([{ name: 'copy', value: 'copy-value-1', domain: '127.0.0.1', path: '/', expires, httpOnly: false, secure: false, session: false }]))
  return udd
}

/** the Google Chrome folder of a test root, running: two profiles on disk, and the stand-in's open pages and cookies */
function liveChrome(root: string): string {
  const udd = join(root, 'localappdata', 'Google', 'Chrome', 'User Data')
  mkdirSync(join(udd, 'Default'), { recursive: true })
  mkdirSync(join(udd, 'Profile 1'), { recursive: true })
  writeFileSync(join(udd, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } } }))
  const contexts = [
    { contextId: 'c1', pages: [{ targetId: 't1', title: 'Inbox notes', url: 'https://example.test/inbox' }], cookies: [] },
    {
      contextId: 'c2',
      pages: [
        { targetId: 't2', title: 'Project board', url: 'https://example.test/board' },
        { targetId: 't3', title: 'Team chat', url: 'https://example.test/chat' },
      ],
      cookies: [{ name: 'live', value: 'live-value-1', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, session: true }],
    },
  ]
  writeFileSync(join(udd, 'stand-in-contexts.json'), JSON.stringify(contexts))
  return udd
}

interface FirefoxRow {
  name: string
  value: string
  expiry: number
}

/**
 * A Firefox profile of a test root, named Personal: its cookies are in a WAL database, as a running Firefox keeps them. The
 * connection stays open while the test runs, so the rows are in the -wal file; the caller closes it.
 */
function firefoxProfile(root: string, rows: FirefoxRow[]): DatabaseSync {
  const iniDir = join(root, 'appdata', 'Mozilla', 'Firefox')
  const dir = join(iniDir, 'Profiles', 'abc.default-release')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(iniDir, 'profiles.ini'), '[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=Personal\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n')
  const db = new DatabaseSync(join(dir, 'cookies.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  db.exec(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT,
    expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
    sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0, isPartitionedAttributeSet INTEGER DEFAULT 0)`)
  const insert = db.prepare('INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, 0, 0, 0)')
  for (const r of rows) insert.run(r.name, r.value, '127.0.0.1', '/', r.expiry)
  return db
}

/** a profile added from Settings' own field, as the person adds one: the row is then in the list */
async function addProfileInSettings(win: Page, name: string): Promise<void> {
  await win.locator('.browser-add-name').fill(name)
  await win.getByRole('button', { name: 'Add', exact: true }).click()
  // a new profile is the last row (the input's value is its name)
  await expect(win.locator('.browser-profile-name').last()).toHaveValue(name)
}

/** a profile added through the main window's action, for a test that has no Settings window open */
function addProfileOnPage(page: Page, name: string): Promise<unknown> {
  return page.evaluate((n) => window.ct.browserProfileAction({ type: 'add', name: n }), name)
}

/** the Settings profile row at this index: Default is the first */
const rowAt = (win: Page, index: number) => win.locator('.browser-profile-row').nth(index)

/** the import sheet of Settings, once it is open */
const sheetOf = (win: Page): Locator => win.locator('.account-dialog')

/** the sheet's status text, as the person reads it */
const statusOf = (win: Page): Locator => sheetOf(win).locator('.browser-import-status')

/** opens the import sheet of the profile row at this index, and waits for it */
async function openImport(win: Page, row: number): Promise<Locator> {
  await rowAt(win, row).getByRole('button', { name: 'Import cookies…', exact: true }).click()
  await expect(sheetOf(win)).toBeVisible()
  return sheetOf(win)
}

/** the sheet's Import button: the one that starts the import */
const importButton = (win: Page): Locator => sheetOf(win).getByRole('button', { name: 'Import', exact: true })

/** the Browser panel is shown: the shortcut opens it when it is not */
async function showBrowserPanel(page: Page): Promise<void> {
  if (await page.locator(PANEL).isVisible()) return
  await page.keyboard.press(SHORTCUT)
  await expect(page.locator(PANEL)).toBeVisible()
}

/** the panel's profile menu, then the profile with this name */
async function chooseProfile(page: Page, name: string): Promise<void> {
  await showBrowserPanel(page)
  await page.locator(PROFILE).click()
  await page.locator('.menu .menu-item', { hasText: new RegExp(`^(✓ )?${name}$`) }).click()
  await expect(page.locator(PROFILE)).toHaveText(name)
}

/** the text a page's #c shows, after the Claude tab navigates to /cookie */
async function cookieSeen(pipeName: string, tabId: string, site: SiteServer): Promise<string> {
  await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/cookie') })
  const reply = await browserCmd(pipeName, tabId, { op: 'evaluate', function: '() => document.getElementById("c").textContent', ref: null })
  return reply.info ?? ''
}

test('imports from a running Chrome (live)', async () => {
  const root = makeRoot()
  const udd = liveChrome(root)
  const { app, page, pipeName, tabId } = await launchWithTab(root)
  const site = await startSiteServer()
  try {
    const win = await settingsWindow(app, page, 'browser')
    await addProfileInSettings(win, 'Work')
    await openImport(win, 1)
    await sheetOf(win).getByLabel('From').selectOption({ label: 'Chrome · open profiles' })
    await importButton(win).click()
    // the browser has no remote debugging yet: the setup page opens, and the import waits for the browser to offer a connection
    await expect(statusOf(win)).toContainText('Chrome opened its remote debugging page. Turn on remote debugging there; the import goes on by itself.')
    // two profiles are open: the person picks the second
    const choices = sheetOf(win).locator('.browser-import-choice')
    await expect(choices).toHaveText(['1 tab: Inbox notes', '2 tabs: Project board, Team chat'])
    await choices.nth(1).click()
    await expect(statusOf(win)).toContainText('Imported 1 cookie for 1 site.')
    await expect(statusOf(win)).toContainText('You can turn remote debugging off again on the same page.')
    // the stand-in was asked to open the setup page, and the import never closed the browser
    expect(readFileSync(join(udd, 'stand-in-opened.log'), 'utf8')).toContain('chrome://inspect/#remote-debugging')
    expect(readFileSync(join(udd, 'stand-in-methods.log'), 'utf8')).not.toContain('Browser.close')
    // the tab on Work reads the cookie
    await chooseProfile(page, 'Work')
    expect(await cookieSeen(pipeName, tabId, site)).toContain('live=live-value-1')
  } finally {
    await site.close()
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('imports from Firefox into a profile', async () => {
  const root = makeRoot()
  const db = firefoxProfile(root, [{ name: 'ff', value: 'ff-value-1', expiry: Math.floor(Date.now() / 1000) + 365 * DAY_S }])
  const { app, page, pipeName, tabId } = await launchWithTab(root)
  const site = await startSiteServer()
  try {
    const win = await settingsWindow(app, page, 'browser')
    await openImport(win, 0)
    await sheetOf(win).getByLabel('From').selectOption({ label: 'Firefox · Personal' })
    await importButton(win).click()
    await expect(statusOf(win)).toContainText('Imported 1 cookie for 1 site.')
    await expect(statusOf(win)).toContainText('Sites that keep their sign-in outside cookies need you to sign in again here.')
    expect(await cookieSeen(pipeName, tabId, site)).toContain('ff=ff-value-1')
  } finally {
    db.close()
    await site.close()
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('imports from a Chromium browser into another profile', async () => {
  const root = makeRoot()
  chromiumBrowser(root)
  const { app, page, pipeName, tabId } = await launchWithTab(root)
  const site = await startSiteServer()
  try {
    const win = await settingsWindow(app, page, 'browser')
    await addProfileInSettings(win, 'Work')
    const dialog = await openImport(win, 1)
    // the profile without cookies is listed, disabled; the one with cookies is the choice
    // (Playwright reads disabled on form controls, so the option's property is what is checked)
    await expect(dialog.getByLabel('From').locator('option', { hasText: 'Chromium · Personal' })).toHaveJSProperty('disabled', true)
    await dialog.getByLabel('From').selectOption({ label: 'Chromium · Test Profile' })
    await importButton(win).click()
    await expect(statusOf(win)).toContainText('Imported 1 cookie for 1 site.')
    await expect(statusOf(win)).toContainText('Google sign-ins are not carried over: Chromium ties them to this computer.')
    // the cookie is in Work, and not in Default
    expect(await cookieSeen(pipeName, tabId, site)).not.toContain('copy=copy-value-1')
    await chooseProfile(page, 'Work')
    expect(await cookieSeen(pipeName, tabId, site)).toContain('copy=copy-value-1')
    await chooseProfile(page, 'Default')
    expect(await cookieSeen(pipeName, tabId, site)).not.toContain('copy=copy-value-1')
  } finally {
    await site.close()
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('no sources outside test roots', async () => {
  // an empty root, given explicitly: a test run reads no browser of the machine, whatever the shell sets
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDETERM_TEST_BROWSER_ROOT: '' } })
  try {
    const win = await settingsWindow(app, page, 'browser')
    const dialog = await openImport(win, 0)
    await expect(statusOf(win)).toHaveText('No browsers found.')
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

/** closes the Settings window (the app's other windows stay): its page is closed with it */
async function closeSettings(app: ElectronApplication, win: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('settings')) w.close()
  })
  await expect.poll(() => win.isClosed()).toBe(true)
}

test('closing the Settings window cancels a running import, and the next import starts', async () => {
  const root = makeRoot()
  liveChrome(root)
  const { app, page } = await launchWithTab(root)
  try {
    let win = await settingsWindow(app, page, 'browser')
    await openImport(win, 0)
    await sheetOf(win).getByLabel('From').selectOption({ label: 'Chrome · open profiles' })
    await importButton(win).click()
    await expect(statusOf(win)).toContainText('Which Chrome profile?')
    await closeSettings(app, win)
    // the closed window's import is cancelled, so the flow is free: the next import asks again
    win = await settingsWindow(app, page, 'browser')
    await openImport(win, 0)
    await sheetOf(win).getByLabel('From').selectOption({ label: 'Chrome · open profiles' })
    await importButton(win).click()
    await expect(statusOf(win)).toContainText('Which Chrome profile?')
    await sheetOf(win).locator('.browser-import-choice').nth(1).click()
    await expect(statusOf(win)).toContainText('Imported 1 cookie for 1 site.')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('one import sheet at a time: the panel opens its profile’s sheet in place of the one open', async () => {
  const { app, page } = await launchWithTab(null)
  try {
    const win = await settingsWindow(app, page, 'browser')
    await addProfileInSettings(win, 'Work')
    await openImport(win, 1)
    await expect(win.locator('.account-dialog-head')).toHaveText('Import cookies into "Work"')
    // the Default tab's panel asks for its import: the Work sheet gives way, and exactly one sheet is open
    await showBrowserPanel(page)
    await page.locator(PROFILE).click()
    await page.locator('.menu .menu-item', { hasText: 'Import cookies…' }).click()
    await expect(win.locator('[role="dialog"]')).toHaveCount(1)
    await expect(win.locator('.account-dialog-head')).toHaveText('Import cookies into "Default"')
  } finally {
    await app.close()
  }
})

test('a sheet opened during an import keeps the import that runs', async () => {
  const root = makeRoot()
  liveChrome(root)
  const { app, page } = await launchWithTab(root)
  try {
    const win = await settingsWindow(app, page, 'browser')
    await addProfileInSettings(win, 'Work')
    await openImport(win, 1)
    await sheetOf(win).getByLabel('From').selectOption({ label: 'Chrome · open profiles' })
    await importButton(win).click()
    await expect(statusOf(win)).toContainText('Which Chrome profile?')
    await showBrowserPanel(page)
    await page.locator(PROFILE).click()
    await page.locator('.menu .menu-item', { hasText: 'Import cookies…' }).click()
    // the running import's sheet stays: one sheet, still asking which profile
    await expect(win.locator('[role="dialog"]')).toHaveCount(1)
    await expect(win.locator('.account-dialog-head')).toHaveText('Import cookies into "Work"')
    await expect(statusOf(win)).toContainText('Which Chrome profile?')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a sheet whose profile is removed closes', async () => {
  const { app, page } = await launchWithTab(null)
  try {
    const win = await settingsWindow(app, page, 'browser')
    await addProfileInSettings(win, 'Work')
    await openImport(win, 1)
    const id = (await page.evaluate(() => window.ct.browserProfiles())).profiles.find((p) => p.name === 'Work')!.id
    // the profile goes from the main window: the Settings window's sheet for it closes
    await page.evaluate((profileId) => window.ct.browserProfileAction({ type: 'remove', id: profileId }), id)
    await expect(win.locator('[role="dialog"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test("the panel's Import cookies… opens the sheet for the tab's profile", async () => {
  const { app, page } = await launchWithTab(null)
  try {
    await addProfileOnPage(page, 'Work')
    await chooseProfile(page, 'Work')
    await page.locator(PROFILE).click()
    const [win] = await Promise.all([app.waitForEvent('window'), page.locator('.menu .menu-item', { hasText: 'Import cookies…' }).click()])
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.account-dialog-head')).toHaveText('Import cookies into "Work"')
  } finally {
    await app.close()
  }
})

test('imported cookies survive a restart', async () => {
  const root = makeRoot()
  const expiry = Math.floor(Date.now() / 1000) + 365 * DAY_S
  const db = firefoxProfile(root, [
    { name: 'ff', value: 'ff-value-1', expiry },
    // a session cookie: no expiry in Firefox, so it is kept for 30 days
    { name: 'sess', value: 'sess-value-1', expiry: 0 },
  ])
  const first = await launchWithTab(root)
  const site = await startSiteServer()
  try {
    const win = await settingsWindow(first.app, first.page, 'browser')
    await openImport(win, 0)
    await sheetOf(win).getByLabel('From').selectOption({ label: 'Firefox · Personal' })
    await importButton(win).click()
    await expect(statusOf(win)).toContainText('Imported 2 cookies for 1 site.')
    // every window closes, and the app with them: the session is saved and the cookies are written to disk on the way out
    const closed = first.app.waitForEvent('close')
    await first.app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close() }).catch(() => undefined)
    await closed
    const again = await launchApp({ dataDir: first.dataDir, args: ['--claude', mkdtempSync(join(tmpdir(), 'ct-work-'))] })
    try {
      await again.page.waitForFunction(() => window.__ct!.tabIds().length >= 1)
      const tabId = (await again.page.evaluate(() => window.__ct!.activeTabId()))!
      const seen = await cookieSeen(again.pipeName, tabId, site)
      expect(seen).toContain('ff=ff-value-1')
      expect(seen).toContain('sess=sess-value-1')
      // the session cookie lives 30 days from the import
      const url = site.url('/cookie')
      const sess = await again.app.evaluate(async ({ session }, args) => {
        const found = await session.fromPartition(args.partition).cookies.get({ url: args.url, name: 'sess' })
        return found[0]?.expirationDate ?? null
      }, { partition: 'persist:browser-default', url })
      const now = Date.now() / 1000
      expect(sess).not.toBeNull()
      expect(sess!).toBeGreaterThan(now + 29 * DAY_S)
      expect(sess!).toBeLessThan(now + 31 * DAY_S)
    } finally {
      await again.app.close()
    }
  } finally {
    await site.close()
    await first.app.close().catch(() => undefined)
    // the database is closed before its folder goes: a file open in it cannot be deleted on Windows
    try {
      db.close()
    } catch {
      // closed already
    }
    rmSync(root, { recursive: true, force: true })
  }
})
