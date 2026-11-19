import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserCmd, leavePromptsToClaudeTerm, startSiteServer, type Reply } from './browser-helpers'
import { KEYS, launchClaudeTab, openTabInFront } from './helpers'

/** the ref of the first snapshot line that matches the pattern, e.g. `textbox "Name"` */
function refOf(info: string | undefined, line: RegExp): string {
  const found = line.exec(info ?? '')
  if (!found) throw new Error(`no line matches ${line} in:\n${info}`)
  return found[1]
}

test('navigates and snapshots a local page', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    const nav = await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    expect(nav.ok).toBe(true)
    expect(nav.info).toContain(`- URL: ${site.url('/form')}`)
    expect(nav.info).toContain('- Title: Form')
    const snap = await browserCmd(pipeName, tabId, { op: 'snapshot' })
    expect(snap.ok).toBe(true)
    expect(snap.info).toMatch(/textbox "Name" \[ref=e\d+\]/)
    expect(snap.info).toMatch(/button "Save" \[ref=e\d+\]/)
  } finally {
    await site.close()
    await app.close()
  }
})

test('clicks and types through refs', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    const snap = await browserCmd(pipeName, tabId, { op: 'snapshot' })
    const field = refOf(snap.info, /textbox "Name"[^\n]*\[ref=(e\d+)\]/)
    const save = refOf(snap.info, /button "Save"[^\n]*\[ref=(e\d+)\]/)
    expect(await browserCmd(pipeName, tabId, { op: 'type', ref: field, element: 'Name', text: 'Ada' })).toMatchObject({ ok: true })
    expect(await browserCmd(pipeName, tabId, { op: 'click', ref: save, element: 'Save' })).toMatchObject({ ok: true })
    expect(await browserCmd(pipeName, tabId, { op: 'wait_for', text: 'saved:Ada' })).toMatchObject({ ok: true })
  } finally {
    await site.close()
    await app.close()
  }
})

test('returns a screenshot image', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    const shot: Reply = await browserCmd(pipeName, tabId, { op: 'screenshot' })
    expect(shot.ok).toBe(true)
    expect(shot.image?.mimeType).toBe('image/png')
    expect(shot.image?.data.length).toBeGreaterThan(1000)
  } finally {
    await site.close()
    await app.close()
  }
})

test('reports console errors', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/console') })
    const logs = await browserCmd(pipeName, tabId, { op: 'console', onlyErrors: true })
    expect(logs.ok).toBe(true)
    expect(logs.info).toContain('boom')
  } finally {
    await site.close()
    await app.close()
  }
})

test('two Claude tabs keep their own pages', async () => {
  const { app, page, pipeName, tabId: first, work } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, first, { op: 'navigate', url: site.url('/form') })
    const second = await openTabInFront(page, 'claude', work)
    await browserCmd(pipeName, second, { op: 'navigate', url: site.url('/page') })
    const firstPages = await browserCmd(pipeName, first, { op: 'tabs', action: 'list' })
    expect(firstPages.info).toContain('Form')
    expect(firstPages.info).not.toContain('Other page')
    const secondPages = await browserCmd(pipeName, second, { op: 'tabs', action: 'list' })
    expect(secondPages.info).toContain('Other page')
    expect(secondPages.info).not.toContain('Form')
  } finally {
    await site.close()
    await app.close()
  }
})

test('closing the tab ends its pending command', async () => {
  const { app, page, pipeName, tabId, work } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    // another tab stays open, so the app does not quit with the tab under test
    await openTabInFront(page, 'shell', work)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
    await page.evaluate(() => {
      const w = window as unknown as { __stateTabs: string[] }
      w.__stateTabs = []
      window.ct.onBrowserState((s) => w.__stateTabs.push(s.tabId))
    })
    const pagesBefore = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
    // the navigation's control line lingers for a few seconds: the wait starts once the panel says the browser is idle
    await expect.poll(async () => (await page.evaluate((id) => window.ct.browserState(id), tabId))?.control, { timeout: 15_000 }).toBe('idle')
    const pending = browserCmd(pipeName, tabId, { op: 'wait_for', time: 30 }, 40_000)
    // the command has started once the panel's state says Claude is using the browser
    await expect.poll(async () => (await page.evaluate((id) => window.ct.browserState(id), tabId))?.control, { timeout: 15_000 }).toBe('claude')
    await page.locator('.terminal-host:visible .xterm').click()
    const closedAt = Date.now()
    await page.keyboard.press(KEYS.closeTab)
    const reply = await pending
    expect(reply).toEqual({ ok: false, error: 'Stopped by the person.' })
    expect(Date.now() - closedAt).toBeLessThan(5_000)
    await page.waitForFunction((id) => !window.__ct!.tabIds().includes(id), tabId)
    // the tab's page is destroyed with it
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)).toBe(pagesBefore - 1)
    // and no state event names the tab once it has closed
    await page.evaluate(() => { (window as unknown as { __stateTabs: string[] }).__stateTabs = [] })
    await new Promise((done) => setTimeout(done, 500))
    expect(await page.evaluate(() => (window as unknown as { __stateTabs: string[] }).__stateTabs)).not.toContain(tabId)
  } finally {
    await site.close()
    await app.close()
  }
})

test('a script navigation to the same site answers at once', { tag: '@alone' }, async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    const started = Date.now()
    const asked = await browserCmd(pipeName, tabId, { op: 'evaluate', function: "() => { location.href = '/page' }" })
    const took = Date.now() - started
    expect(asked).toMatchObject({ ok: true })
    // a navigation the page starts in the command is seen before the command answers: no 5 s wait for it
    expect(took).toBeLessThan(3_000)
  } finally {
    await site.close()
    await app.close()
  }
})

test('a download is reported', async () => {
  const { app, pipeName, tabId, dataDir } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await browserCmd(pipeName, tabId, { op: 'evaluate', function: "() => { location.href = '/download' }" })
    await expect.poll(async () => (await browserCmd(pipeName, tabId, { op: 'snapshot' })).info ?? '', { timeout: 15_000 }).toMatch(/^- Downloaded: a\.txt$/m)
    // the footer comes when the download starts; the file is complete a moment later
    const saved = join(dataDir, 'downloads', 'a.txt')
    await expect.poll(() => (existsSync(saved) ? readFileSync(saved, 'utf8') : ''), { timeout: 15_000 }).toBe('downloaded text')
  } finally {
    await site.close()
    await app.close()
  }
})

test('a navigation on an open page that turns into a download reports it in its own reply', async () => {
  const { app, pipeName, tabId, dataDir } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    const nav = await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/download') })
    expect(nav.ok).toBe(true)
    expect(nav.info).toMatch(/^- Downloaded: a\.txt$/m)
    expect(readFileSync(join(dataDir, 'downloads', 'a.txt'), 'utf8')).toBe('downloaded text')
  } finally {
    await site.close()
    await app.close()
  }
})

test('navigating straight to a download answers at once, with the file in the footer', async () => {
  const { app, pipeName, tabId, dataDir } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    const started = Date.now()
    const nav = await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/download') })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(nav.ok).toBe(true)
    expect(nav.info).toMatch(/^- Downloaded: a\.txt$/m)
    expect(readFileSync(join(dataDir, 'downloads', 'a.txt'), 'utf8')).toBe('downloaded text')
  } finally {
    await site.close()
    await app.close()
  }
})

test('a page that fails to load says so, with the error text and no address', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  const address = site.url('/form')
  // a port nothing listens on: the connection is refused
  await site.close()
  try {
    const nav = await browserCmd(pipeName, tabId, { op: 'navigate', url: address })
    expect(nav.ok).toBe(true)
    expect(nav.info?.split('\n')[0]).toBe('Navigated, but the page did not load: ERR_CONNECTION_REFUSED.')
  } finally {
    await app.close()
  }
})

test('a page the main process destroys leaves the strip, and the tab goes on', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await browserCmd(pipeName, tabId, { op: 'tabs', action: 'new', url: site.url('/closer') })
    // the page's own contents are closed from the main process, as when a page goes away
    await app.evaluate(({ webContents }, suffix) => {
      webContents.getAllWebContents().find((w) => w.getURL().endsWith(suffix))?.close()
    }, '/closer')
    const list = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })
    expect(list.ok).toBe(true)
    expect(list.info).toMatch(/^\* 0: Form/m)
    expect(list.info).not.toContain('Closer')
    expect(await browserCmd(pipeName, tabId, { op: 'snapshot' })).toMatchObject({ ok: true })
  } finally {
    await site.close()
    await app.close()
  }
})

test('a window a page opens by itself, with no command running, joins the strip without a card', async () => {
  const { app, page, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/popup') })
    // no command of Claude's runs: the control line says idle once its few seconds have passed
    await expect.poll(async () => (await page.evaluate((id) => window.ct.browserState(id), tabId))?.control, { timeout: 15_000 }).toBe('idle')
    // a script run with the user's gesture, as a click of the person's would be
    await app.evaluate(({ webContents }, popup) => {
      const host = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/popup'))
      void host?.executeJavaScript(`window.open(${JSON.stringify(popup)})`, true)
    }, site.url('/page', 'other.test'))
    await expect.poll(async () => (await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })).info ?? '', { timeout: 15_000 }).toContain('a page on other.test')
    expect((await page.evaluate((id) => window.ct.browserState(id), tabId))?.card).toBeNull()
    // the page the person opened is never allowed for Claude: the footer of every reply shows its site only, not its address or title
    const selected = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'select', index: 1 })
    expect(selected.info).toContain('- URL: a page on other.test')
    expect(selected.info).not.toContain('Other page')
    expect(selected.info).not.toContain('/page')
    const list = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })
    expect(list.info).toContain('- URL: a page on other.test')
    expect(list.info).not.toContain('Other page')
    expect(list.info).not.toContain('/page')
  } finally {
    await site.close()
    await app.close()
  }
})

test('an overlay covers the page with a still; the still goes when the panel shows another tab', async () => {
  const { app, page, pipeName, tabId: first, work } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, first, { op: 'navigate', url: site.url('/form') })
    const second = await openTabInFront(page, 'claude', work)
    await page.evaluate(() => {
      const w = window as unknown as { __stills: [string, string | null][] }
      w.__stills = []
      window.ct.onBrowserStill((id, url) => { w.__stills.push([id, url]) })
    })
    await page.evaluate((id) => window.ct.browserBounds(id, { x: 0, y: 0, width: 400, height: 300 }), first)
    await page.evaluate(() => window.ct.browserCovered(true))
    await expect.poll(() => page.evaluate((id) => (window as unknown as { __stills: [string, string | null][] }).__stills.some(([t, u]) => t === id && u?.startsWith('data:image/png') === true), first), { timeout: 15_000 }).toBe(true)
    await page.evaluate((id) => window.ct.browserBounds(id, { x: 0, y: 0, width: 400, height: 300 }), second)
    await expect.poll(() => page.evaluate((id) => (window as unknown as { __stills: [string, string | null][] }).__stills.some(([t, u]) => t === id && u === null), first), { timeout: 15_000 }).toBe(true)
  } finally {
    await site.close()
    await app.close()
  }
})

test('selects an option', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/select') })
    const snap = await browserCmd(pipeName, tabId, { op: 'snapshot' })
    const color = refOf(snap.info, /combobox "Color"[^\n]*\[ref=(e\d+)\]/)
    expect(await browserCmd(pipeName, tabId, { op: 'select_option', ref: color, element: 'Color', values: ['green'] })).toMatchObject({ ok: true })
    const shown = await browserCmd(pipeName, tabId, { op: 'evaluate', function: "() => document.getElementById('out').textContent" })
    expect(shown.info).toContain('"green"')
  } finally {
    await site.close()
    await app.close()
  }
})

test('answers page dialogs', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/dialog') })
    const ask = refOf((await browserCmd(pipeName, tabId, { op: 'snapshot' })).info, /button "Ask"[^\n]*\[ref=(e\d+)\]/)
    const declined = await browserCmd(pipeName, tabId, { op: 'click', ref: ask, element: 'Ask' })
    expect(declined.info).toContain('- Dialog: confirm "Sure?" → Cancel')
    expect(declined.info).toContain('- Title: false')
    expect(await browserCmd(pipeName, tabId, { op: 'handle_dialog', accept: true, promptText: null })).toMatchObject({ ok: true })
    const accepted = await browserCmd(pipeName, tabId, { op: 'click', ref: ask, element: 'Ask' })
    expect(accepted.info).toContain('→ OK')
    expect(accepted.info).toContain('- Title: true')
  } finally {
    await site.close()
    await app.close()
  }
})

test('a page that guards its unload is left', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  leavePromptsToClaudeTerm(app)
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/guard') })
    const arm = refOf((await browserCmd(pipeName, tabId, { op: 'snapshot' })).info, /button "Arm"[^\n]*\[ref=(e\d+)\]/)
    expect(await browserCmd(pipeName, tabId, { op: 'click', ref: arm, element: 'Arm' })).toMatchObject({ ok: true })
    // the page asks "Leave site?" before it goes: nobody answers that, so the unload goes ahead and the navigation happens
    const left = await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/page') })
    expect(left.ok).toBe(true)
    expect(left.info).toContain(`- URL: ${site.url('/page')}`)
    expect(left.info).toContain('- Title: Other page')
    expect(left.info).toContain('- Dialog: beforeunload "Leave site?" → OK')
    expect(left.info).not.toContain('beforeunload ""')
  } finally {
    await site.close()
    await app.close()
  }
})

test('manages its pages', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  const site = await startSiteServer()
  try {
    await browserCmd(pipeName, tabId, { op: 'navigate', url: site.url('/form') })
    await browserCmd(pipeName, tabId, { op: 'tabs', action: 'new', url: site.url('/page') })
    const two = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })
    expect(two.info).toMatch(/^\* 1: Other page/m)
    expect(two.info).toMatch(/^ {2}0: Form/m)
    await browserCmd(pipeName, tabId, { op: 'tabs', action: 'select', index: 0 })
    const first = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })
    expect(first.info).toMatch(/^\* 0: Form/m)
    expect(first.info).toMatch(/^ {2}1: Other page/m)
    await browserCmd(pipeName, tabId, { op: 'tabs', action: 'close', index: 1 })
    const one = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })
    expect(one.info).toMatch(/^\* 0: Form/m)
    expect(one.info).not.toContain('Other page')
    // a new page without an address is a blank page, and it finishes loading
    expect(await browserCmd(pipeName, tabId, { op: 'tabs', action: 'new' })).toMatchObject({ ok: true })
    const blank = await browserCmd(pipeName, tabId, { op: 'tabs', action: 'list' })
    expect(blank.info).toMatch(/^\* 1: .* — about:blank/m)
  } finally {
    await site.close()
    await app.close()
  }
})

test('refuses a non-web address', async () => {
  const { app, pipeName, tabId } = await launchClaudeTab()
  try {
    const reply = await browserCmd(pipeName, tabId, { op: 'navigate', url: 'javascript:alert(1)' })
    expect(reply).toMatchObject({ ok: false, error: 'The ClaudeTerm browser opens only http, https and file addresses.' })
  } finally {
    await app.close()
  }
})

test('works only in a Claude tab', async () => {
  const { app, page, pipeName, work } = await launchClaudeTab()
  try {
    const shell = await openTabInFront(page, 'shell', work)
    const reply = await browserCmd(pipeName, shell, { op: 'snapshot' })
    expect(reply).toMatchObject({ ok: false, error: 'The browser works only in a ClaudeTerm Claude tab.' })
  } finally {
    await app.close()
  }
})
