import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeMessage, type PipeMessage } from '../../src/shared/protocol'
import { browserCmd, startSiteServer, type SiteServer } from './browser-helpers'
import { FAKE_CLAUDE_SETTINGS, launchApp, openTabInFront } from './helpers'

// The permission cards of the Browser: a card asks before Claude opens another site, a held navigation waits for the
// answer, Stop takes control, and Hand back gives it back. The sites are the site server's: `site.test` and `other.test`
// resolve to it in test runs, and the tests answer the cards through the Browser panel the way the person does.

const PANEL = '.panel-browser'
const ADDRESS = `${PANEL} .browser-address`
const CONTROL = `${PANEL} .browser-control`
const CARD = `${PANEL} .browser-card`
const CARD_TEXT = `${CARD} .browser-card-text`
const TITLE = '#image-panel .panel-title'
const SHORTCUT = process.platform === 'darwin' ? 'Meta+KeyB' : 'Control+Shift+KeyB'

/** a Claude tab in front of an app started with `env` and `settings` (the answer time of a test, the tab bar's place) */
async function claudeTab(env: Record<string, string> = {}, settings: object = FAKE_CLAUDE_SETTINGS) {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings, args: ['--claude', work], env })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, tabId, work }
}

/** the card's button, as the person clicks it in the Browser panel */
function cardButton(page: Page, label: string) {
  return page.locator(`${CARD} button`, { hasText: label })
}

/** the tab's browser state as the panel has it: its card and its control */
function stateOf(page: Page, tabId: string) {
  return page.evaluate((id) => window.ct.browserState(id), tabId)
}

/** the addresses of the site's pages as main has them: the pages on the test site's server */
function pageUrls(app: ElectronApplication, site: SiteServer): Promise<string[]> {
  return app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().map((w) => w.getURL()).filter((u) => u.startsWith(prefix)), `http://127.0.0.1:${site.port}`)
}

/** whether the promise settles within `ms` */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), new Promise<boolean>((done) => setTimeout(() => done(false), ms))])
}

/** the ref of the first snapshot line that matches the pattern */
function refOf(info: string | undefined, line: RegExp): string {
  const found = line.exec(info ?? '')
  if (!found) throw new Error(`no line matches ${line} in:\n${info}`)
  return found[1]
}

/** the always-allowed sites of the default profile, as the profiles file has them */
function allowedSites(dataDir: string): string[] {
  try {
    const store = JSON.parse(readFileSync(join(dataDir, 'browser-profiles.json'), 'utf8')) as { defaultId: string; profiles: { id: string; allowed: string[] }[] }
    return store.profiles.find((p) => p.id === store.defaultId)?.allowed ?? []
  } catch {
    return []
  }
}

test('asks before opening another site', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'site.test') })
    // the Browser panel opens by itself, with the card
    await expect(page.locator(TITLE)).toHaveText('Browser')
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    expect(await settlesWithin(pending, 1_000)).toBe(false)
    await cardButton(page, 'Allow in this tab').click()
    expect(await pending).toMatchObject({ ok: true, info: expect.stringContaining('- Title: Other page') })
    // the site is allowed in this tab now: a second page of it needs no card
    expect(await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form', 'site.test') })).toMatchObject({ ok: true })
    await expect(page.locator(CARD)).toBeHidden()
  } finally {
    await site?.close()
    await app.close()
  }
})

test('always allow is kept in the profile', async () => {
  const { app, page, pipeName, tabId, dataDir } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'site.test') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    await cardButton(page, 'Always allow').click()
    expect(await pending).toMatchObject({ ok: true })
    await expect.poll(() => allowedSites(dataDir)).toContain('site.test')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('deny refuses, and the page stays where it was', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'site.test') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    await cardButton(page, 'Deny').click()
    expect(await pending).toEqual({ ok: false, error: 'The person did not allow site.test.' })
    expect(await pageUrls(app, site)).toEqual([site.url('/form')])
  } finally {
    await site?.close()
    await app.close()
  }
})

test('no answer times out, and the card is gone', async () => {
  const { app, page, pipeName, tabId } = await claudeTab({ CLAUDETERM_TEST_SITE_ANSWER_MS: '3000' })
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'site.test') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/^The person did not answer about site\.test\./) })
    expect((await stateOf(page, tabId))?.card ?? null).toBeNull()
  } finally {
    await site?.close()
    await app.close()
  }
})

test('holds a click that leaves the site until the person answers', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/link') })
    const ref = refOf((await browserCmd(pipeName, tabId, { op: 'snapshot' })).info, /link "Other"[^\n]*\[ref=(e\d+)\]/)
    const click = browserCmd(pipeName, tabId, { op: 'click', ref, element: 'Other' })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open other.test')
    expect(await pageUrls(app, site)).toEqual([site.url('/link')])
    await cardButton(page, 'Deny').click()
    expect(await click).toEqual({ ok: false, error: 'The person did not allow other.test.' })
    expect(await pageUrls(app, site)).toEqual([site.url('/link')])
  } finally {
    await site?.close()
    await app.close()
  }
})

test('holds a redirect chain once: one card, and allowing it lets the chain finish', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/away') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open other.test')
    await cardButton(page, 'Allow in this tab').click()
    expect(await pending).toMatchObject({ ok: true, info: expect.stringContaining('- Title: Other page') })
    // the second hop of the chain is on the same site: no second card comes
    await new Promise((done) => setTimeout(done, 2_000))
    expect((await stateOf(page, tabId))?.card ?? null).toBeNull()
  } finally {
    await site?.close()
    await app.close()
  }
})

test('a denied redirect chain leaves the page where it was, with the denial', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/away') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open other.test')
    await cardButton(page, 'Deny').click()
    expect(await pending).toEqual({ ok: false, error: 'The person did not allow other.test.' })
    expect(await pageUrls(app, site)).toEqual([site.url('/form')])
  } finally {
    await site?.close()
    await app.close()
  }
})

test('a page the person opened asks on use', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    // the person opens the page in the panel: no card, the person's own address is not asked about
    await page.keyboard.press(SHORTCUT)
    await page.locator(ADDRESS).fill(site.url('/page', 'site.test'))
    await page.locator(ADDRESS).press('Enter')
    await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.url).toBe(site.url('/page', 'site.test'))
    expect((await stateOf(page, tabId))?.card ?? null).toBeNull()
    // Claude's snapshot of that page asks
    const snap = browserCmd(pipeName, tabId, { op: 'snapshot' })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to use site.test')
    await cardButton(page, 'Deny').click()
    expect(await snap).toEqual({ ok: false, error: 'The person did not allow site.test.' })
  } finally {
    await site?.close()
    await app.close()
  }
})

test('back and forward ask before they go to a site the tab may not use, and a denial leaves the page', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    // the person opens a page of another site, then goes back to the local page: the history holds both
    await page.keyboard.press(SHORTCUT)
    await page.locator(ADDRESS).fill(site.url('/page', 'other.test'))
    await page.locator(ADDRESS).press('Enter')
    await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.url).toBe(site.url('/page', 'other.test'))
    await expect(page.locator(ADDRESS)).toBeHidden()
    await page.keyboard.press(SHORTCUT)
    await page.locator(ADDRESS).fill(site.url('/form'))
    await page.locator(ADDRESS).press('Enter')
    await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.url).toBe(site.url('/form'))
    // Claude's back goes to other.test: the card asks, and the denial fails the command with the gate's text
    const back = browserCmd(pipeName, tabId, { op: 'back' })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open other.test')
    expect(await settlesWithin(back, 1_000)).toBe(false)
    await cardButton(page, 'Deny').click()
    expect(await back).toEqual({ ok: false, error: 'The person did not allow other.test.' })
    expect(await pageUrls(app, site)).toEqual([site.url('/form')])
    await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.url).toBe(site.url('/form'))
  } finally {
    await site?.close()
    await app.close()
  }
})

test('forward asks before it goes to a site the tab may not use, and a denial leaves the page', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    // the person opens another site, then goes back with the panel's Back: the other site is the forward entry
    await page.keyboard.press(SHORTCUT)
    await page.locator(ADDRESS).fill(site.url('/page', 'other.test'))
    await page.locator(ADDRESS).press('Enter')
    await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.url).toBe(site.url('/page', 'other.test'))
    await expect(page.locator(ADDRESS)).toBeHidden()
    await page.keyboard.press(SHORTCUT)
    await page.locator(`${PANEL} .browser-back`).click()
    await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.url).toBe(site.url('/form'))
    const forward = browserCmd(pipeName, tabId, { op: 'forward' })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open other.test')
    await cardButton(page, 'Deny').click()
    expect(await forward).toEqual({ ok: false, error: 'The person did not allow other.test.' })
    expect(await pageUrls(app, site)).toEqual([site.url('/form')])
  } finally {
    await site?.close()
    await app.close()
  }
})

test('a response body is not shown on any hop of a redirect to a site the tab may not use', async () => {
  const { app, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/fetch') })
    // the page's own no-cors fetch: its first hop is local, and the last hop of its redirect is on other.test
    await browserCmd(pipeName, tabId, { op: 'evaluate', function: '() => { void fetch("/redirect", { mode: "no-cors" }); return 0 }' })
    let hop = ''
    await expect.poll(async () => {
      const listed = (await browserCmd(pipeName, tabId, { op: 'network' })).info ?? ''
      hop = /^(r\d+) GET \S*\/redirect\b/m.exec(listed)?.[1] ?? ''
      return hop
    }, { timeout: 15_000 }).not.toBe('')
    const shown = await browserCmd(pipeName, tabId, { op: 'network_request', id: hop })
    expect(shown.info).toContain('(not shown: other.test is not allowed in this tab)')
    expect(shown.info).not.toContain('Another page of the site')
  } finally {
    await site?.close()
    await app.close()
  }
})

test('a file URL padded with a space is still a file: Claude\'s navigate to one outside the folder asks', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  const outside = mkdtempSync(join(tmpdir(), 'ct-outside-'))
  try {
    const elsewhere = join(outside, 'padded.html')
    writeFileSync(elsewhere, '<title>Padded</title><p>padded</p>')
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: ` ${pathToFileURL(elsewhere).href}` })
    await expect(page.locator(CARD_TEXT)).toHaveText(`Claude wants to open ${elsewhere}`)
    await cardButton(page, 'Deny').click()
    expect(await pending).toEqual({ ok: false, error: `The person did not allow ${elsewhere}.` })
  } finally {
    rmSync(outside, { recursive: true, force: true })
    await app.close()
  }
})

test('a local file opens freely in the tab folder; one elsewhere asks with its path, offers no Always allow, and a denial fails', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab()
  const outside = mkdtempSync(join(tmpdir(), 'ct-outside-'))
  try {
    const inside = join(work, 'inside.html')
    writeFileSync(inside, '<title>Inside</title><p>in the project</p>')
    expect(await browserCmd(pipeName, tabId, { op: 'navigate', url: pathToFileURL(inside).href })).toMatchObject({ ok: true, info: expect.stringContaining('- Title: Inside') })
    expect((await stateOf(page, tabId))?.card ?? null).toBeNull()
    const elsewhere = join(outside, 'elsewhere.html')
    writeFileSync(elsewhere, '<title>Elsewhere</title><p>not in the project</p>')
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: pathToFileURL(elsewhere).href })
    await expect(page.locator(CARD_TEXT)).toHaveText(`Claude wants to open ${elsewhere}`)
    await expect(cardButton(page, 'Always allow')).toHaveCount(0)
    await cardButton(page, 'Deny').click()
    expect(await pending).toEqual({ ok: false, error: `The person did not allow ${elsewhere}.` })
  } finally {
    rmSync(outside, { recursive: true, force: true })
    await app.close()
  }
})

test('stop takes control: the command stops, the line says so, and Hand back gives it back', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    // the navigation's control line lingers for a few seconds: the wait starts once the line is gone
    await expect.poll(async () => (await stateOf(page, tabId))?.control, { timeout: 15_000 }).toBe('idle')
    const waiting = browserCmd(pipeName, tabId, { op: 'wait_for', time: 20 })
    await expect.poll(async () => (await stateOf(page, tabId))?.control, { timeout: 15_000 }).toBe('claude')
    await page.locator(`${CONTROL} button`, { hasText: 'Stop' }).click()
    // Stop takes effect at once: the command answers and the line says so within 2 s of the click
    const answered = await Promise.race([waiting, new Promise((done) => setTimeout(() => done('no answer within 2 s'), 2_000))])
    expect(answered).toEqual({ ok: false, error: 'Stopped by the person.' })
    await expect(page.locator(CONTROL)).toContainText('You have control', { timeout: 2_000 })
    expect(await browserCmd(pipeName, tabId, { op: 'snapshot' })).toEqual({ ok: false, error: 'The person took control of the browser. Ask them before using it again.' })
    await page.locator(`${CONTROL} button`, { hasText: 'Hand back to Claude' }).click()
    expect(await browserCmd(pipeName, tabId, { op: 'snapshot' })).toMatchObject({ ok: true })
  } finally {
    await site?.close()
    await app.close()
  }
})

test('Stop while a card waits drops the card', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'site.test') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    await page.locator(`${CONTROL} button`, { hasText: 'Stop' }).click()
    expect(await pending).toEqual({ ok: false, error: 'Stopped by the person.' })
    await expect(page.locator(CARD)).toBeHidden()
  } finally {
    await site?.close()
    await app.close()
  }
})

// a time limit is measured here (the window of the held navigation), so the test runs with the machine to itself
test('a held navigation after the command waits for the next command @alone', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/link') })
    // a timer the page sets fires 1.5 s after the command ends, inside the three seconds the navigation is held
    await browserCmd(pipeName, tabId, { op: 'evaluate', function: `() => { setTimeout(() => { location.href = '${site.url('/page', 'other.test')}' }, 1500) }` })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open other.test')
    // the next command does not answer until the card does
    const snap = browserCmd(pipeName, tabId, { op: 'snapshot' })
    expect(await settlesWithin(snap, 1_000)).toBe(false)
    await cardButton(page, 'Deny').click()
    expect(await snap).toMatchObject({ ok: true })
    expect(await pageUrls(app, site)).toEqual([site.url('/link')])
  } finally {
    await site?.close()
    await app.close()
  }
})

test("the person's own address is not held while a command's window is open", async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    // Claude's wait keeps the window open while the person types the address
    const waiting = browserCmd(pipeName, tabId, { op: 'wait_for', time: 4 })
    // a failing check below must not be hidden by the wait's reply, which the app's close ends
    waiting.catch(() => undefined)
    await expect.poll(async () => (await stateOf(page, tabId))?.control, { timeout: 15_000 }).toBe('claude')
    await page.locator(ADDRESS).fill(site.url('/away'))
    await page.locator(ADDRESS).press('Enter')
    await new Promise((done) => setTimeout(done, 2_000))
    expect((await stateOf(page, tabId))?.card ?? null).toBeNull()
    await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.title, { timeout: 10_000 }).toBe('Other page')
    expect(await waiting).toMatchObject({ ok: true })
  } finally {
    await site?.close()
    await app.close()
  }
})

test('a held form post is not sent again: the person allows the site, and Claude submits the form again', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/post') })
    const send = refOf((await browserCmd(pipeName, tabId, { op: 'snapshot' })).info, /button "Send"[^\n]*\[ref=(e\d+)\]/)
    const posting = browserCmd(pipeName, tabId, { op: 'click', ref: send, element: 'Send' })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open other.test')
    await cardButton(page, 'Allow in this tab').click()
    expect(await posting).toEqual({ ok: false, error: 'The person allowed other.test; the form was not sent. Submit it again.' })
    expect(await pageUrls(app, site)).toEqual([site.url('/post')])
    const again = refOf((await browserCmd(pipeName, tabId, { op: 'snapshot' })).info, /button "Send"[^\n]*\[ref=(e\d+)\]/)
    expect(await browserCmd(pipeName, tabId, { op: 'click', ref: again, element: 'Send' })).toMatchObject({ ok: true, info: expect.stringContaining('- Title: Other page') })
    expect((await stateOf(page, tabId))?.card ?? null).toBeNull()
  } finally {
    await site?.close()
    await app.close()
  }
})

test('a closed pipe drops the card, and the tab goes on', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    // a command sent on a raw socket, which closes before the answer
    const socket = connect(pipeName)
    await new Promise<void>((done) => socket.once('connect', () => done()))
    socket.write(encodeMessage({ v: 1, type: 'browser', tabId, command: { op: 'navigate', url: site.url('/page', 'site.test') } } as unknown as PipeMessage))
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    socket.destroy()
    await expect.poll(async () => (await stateOf(page, tabId))?.card ?? null, { timeout: 2_000 }).toBeNull()
    expect(await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })).toMatchObject({ ok: true })
  } finally {
    await site?.close()
    await app.close()
  }
})

test('the card asks for attention here, in a Claude tab that is not in front', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab({}, { ...FAKE_CLAUDE_SETTINGS, tabs: { position: 'left' } })
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    const row = page.locator(`#tabpanel .tp-tab[data-tab-id="${tabId}"]`)
    await openTabInFront(page, 'shell', work)
    await page.waitForFunction((id) => window.__ct!.activeTabId() !== id, tabId)
    const pending = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'site.test') })
    await expect(row).toHaveClass(/\battention\b/)
    await expect(row.locator('.tab-status')).toHaveText('Permission')
    // the person comes back to the tab and answers the card in the panel
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
    await page.keyboard.press(SHORTCUT)
    await cardButton(page, 'Deny').click()
    expect(await pending).toEqual({ ok: false, error: 'The person did not allow site.test.' })
  } finally {
    await site?.close()
    await app.close()
  }
})

test('with Always allow all sites on, Claude opens and reads other sites without a card', async () => {
  const { app, page, pipeName, tabId } = await claudeTab()
  const outside = mkdtempSync(join(tmpdir(), 'ct-outside-'))
  let site: SiteServer | null = null
  try {
    site = await startSiteServer()
    await page.evaluate(() => window.ct.browserProfileAction({ type: 'allowAll', id: 'default', on: true }))
    // Claude opens another site, and reads it, with no card
    expect(await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'other.test') })).toMatchObject({ ok: true, info: expect.stringContaining('- Title: Other page') })
    expect((await stateOf(page, tabId))?.card ?? null).toBeNull()
    await expect(page.locator(CARD)).toBeHidden()
    // the person opens a page of a second other site: Claude lists its full address
    await page.keyboard.press(SHORTCUT)
    await page.locator(ADDRESS).fill(site.url('/form', 'site.test'))
    await page.locator(ADDRESS).press('Enter')
    await expect.poll(async () => (await stateOf(page, tabId))?.pages[0]?.url).toBe(site.url('/form', 'site.test'))
    expect(await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })).toMatchObject({ ok: true, info: expect.stringContaining(site.url('/form', 'site.test')) })
    // a file outside the tab's folder still asks, with its own card
    const elsewhere = join(outside, 'elsewhere.html')
    writeFileSync(elsewhere, '<title>Elsewhere</title><p>not in the project</p>')
    const file = browserCmd(pipeName, tabId, { op: 'navigate', url: pathToFileURL(elsewhere).href })
    await expect(page.locator(CARD_TEXT)).toHaveText(`Claude wants to open ${elsewhere}`)
    await cardButton(page, 'Deny').click()
    expect(await file).toEqual({ ok: false, error: `The person did not allow ${elsewhere}.` })
    // with the switch off, a new site asks again
    await page.evaluate(() => window.ct.browserProfileAction({ type: 'allowAll', id: 'default', on: false }))
    // the page the person opened on site.test is masked again in the list
    const masked = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })
    expect(masked.info).toContain('a page on site.test')
    expect(masked.info).not.toContain(site.url('/form', 'site.test'))
    const asked = browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page', 'site.test') })
    await expect(page.locator(CARD_TEXT)).toHaveText('Claude wants to open site.test')
    await cardButton(page, 'Deny').click()
    expect(await asked).toEqual({ ok: false, error: 'The person did not allow site.test.' })
  } finally {
    rmSync(outside, { recursive: true, force: true })
    await site?.close()
    await app.close()
  }
})
