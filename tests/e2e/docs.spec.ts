import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAC } from '../fixtures/platform'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, KEYS, KEY_LABELS, PNG_1x1, launchClaudeTab, panelSettled } from './helpers'

const SID = '7a1f2e3d-4c5b-4a69-8d7e-f0a1b2c3d4e5'

/** a Claude tab in a fresh folder whose session ClaudeTerm knows, with an empty transcript (Send needs it in Task 10) */
async function claudeTab(settings: object = FAKE_CLAUDE_SETTINGS) {
  const work = mkdtempSync(join(tmpdir(), 'ct-docs-'))
  mkdirSync(join(work, 'notes'), { recursive: true })
  const launched = await launchClaudeTab(settings, work)
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  expect(await sendPipeMessage(launched.pipeName, { v: 1, type: 'session', tabId: launched.tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  return { ...launched, notes: join(work, 'notes') }
}

const show = (pipeName: string, tabId: string | null, path: string, title: string | null = null) =>
  sendPipeMessage(pipeName, { v: 1, type: 'show_document', tabId, path, title })

const panel = (page: Page) => page.locator('#image-panel')
const panelTitle = (page: Page) => page.locator('.panel-title')
const docsTab = (page: Page) => page.locator('#sheet-header .tab-docs-toggle')
const selector = (page: Page) => page.locator('.doc-select')
const more = (page: Page) => page.locator('.doc-more')
const heading = (page: Page, text: string) => page.locator('.doc-md h1', { hasText: text })

/** the stub of the shell calls the ⋯ menu makes: what Show in Explorer and Open in default app would have done */
type App = ElectronApplication
async function stubShell(app: App): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__shellCalls = calls
    shell.showItemInFolder = (p: string) => { calls.push('show ' + p) }
    shell.openPath = (p: string) => { calls.push('open ' + p); return Promise.resolve('') }
  })
}
const shellCalls = (app: App) => app.evaluate(() => (globalThis as Record<string, unknown>).__shellCalls as string[])

/** records the URLs main hands to shell.openExternal, instead of opening a browser */
async function stubExternal(app: App): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__externalCalls = calls
    shell.openExternal = (u: string) => { calls.push(u); return Promise.resolve() }
  })
}
const externalCalls = (app: App) => app.evaluate(() => (globalThis as Record<string, unknown>).__externalCalls as string[])

/** records the texts main writes to the clipboard, instead of writing them: the test leaves the clipboard of the machine alone */
async function stubClipboard(app: App): Promise<void> {
  await app.evaluate(({ clipboard }) => {
    const writes: string[] = []
    ;(globalThis as Record<string, unknown>).__clipboardWrites = writes
    clipboard.writeText = (t: string) => { writes.push(t); return Promise.resolve() }
  })
}
const clipboardWrites = (app: App) => app.evaluate(() => (globalThis as Record<string, unknown>).__clipboardWrites as string[])

/** a comment on block `block` of the formatted document, written the way a person does it */
async function commentBlock(page: Page, block: number, text: string): Promise<void> {
  const row = page.locator('.doc-md .md-seg').nth(block)
  await row.hover()
  await row.locator('.md-plus').click()
  await page.locator('.panel-docs .review-comment-input').fill(text)
  await page.locator('.panel-docs .review-btn.primary').click()
}

/** a one-page PDF with the text HELLO PDF; the xref offsets are the byte offsets of its objects */
function minimalPdf(): string {
  const stream = 'BT /F1 36 Tf 30 90 Td (HELLO PDF) Tj ET'
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

/** an HTML report: its script reports whether it can reach the window that shows it; page2 is what its own link opens */
const REPORT_INDEX = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="t">Report</h1><a id="next" href="page2.html">next</a> <a id="out" href="https://example.invalid/">out</a><script src="app.js"></script></body></html>\n'
const REPORT_APP = `let parentReach = 'open'
try { void window.parent.ct; parentReach = typeof window.parent.ct === 'undefined' ? 'hidden' : 'open' } catch { parentReach = 'blocked' }
document.getElementById('t').textContent = 'Report ready · parent ' + parentReach
`
const REPORT_PAGE2 = '<h1>Page 2</h1>\n'

/** Docs hidden, then shown again with the shortcut; the panel's title first takes the focus out of a frame */
async function hideAndShowDocs(page: Page): Promise<void> {
  await page.locator('.panel-title').click()
  await page.keyboard.press(KEYS.docs)
  await expect(panel(page)).toHaveClass(/collapsed/)
  await page.keyboard.press(KEYS.docs)
  await expect(panel(page)).not.toHaveClass(/collapsed/)
  await slidIn(page)
}

/**
 * the panel has slid in all the way: while it slides, its left part is still behind its edge, and a click there lands on the chat
 * beside it, though the document in its frame says the link is there
 */
async function slidIn(page: Page): Promise<void> {
  await expect(panel(page)).not.toHaveClass(/sliding/)
}

test('show_document opens Docs with the formatted document; the button and Ctrl+Shift+O toggle it', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  expect(await show(pipeName, tabId, spec)).toEqual({ ok: true, info: 'Opened notes/spec.md in the Docs panel. The user can comment on it; their comments come back to you as a message.' })
  await expect(panelTitle(page)).toHaveText('Docs')
  await expect(page.locator('.doc-md h1')).toHaveText('Spec')
  await expect(docsTab(page)).toHaveClass(/active/)
  await expect(docsTab(page)).toHaveAttribute('title', `Docs (${KEY_LABELS.docs})`)
  await page.keyboard.press(KEYS.docs)
  await expect(panel(page)).toHaveClass(/collapsed/)
  await docsTab(page).click()
  await expect(page.locator('.doc-md h1')).toHaveText('Spec')
  await app.close()
})

test('show_document refuses a file of another type', async () => {
  const { app, pipeName, tabId, notes } = await claudeTab()
  const txt = join(notes, 'notes.txt')
  writeFileSync(txt, 'plain\n')
  expect(await show(pipeName, tabId, txt)).toEqual({ ok: false, error: `not a supported document type (md, markdown, pdf, html, htm): ${txt}` })
  await app.close()
})

test('two documents switch in the selector; the menu acts on the one shown; Remove from list drops it', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  await stubShell(app)
  const a = join(notes, 'a.md')
  const b = join(notes, 'b.md')
  writeFileSync(a, '# Alpha\n\nFirst.\n')
  writeFileSync(b, '# Bravo\n\nSecond.\n')
  await show(pipeName, tabId, a)
  await show(pipeName, tabId, b, 'Bee')
  await expect(selector(page).locator('option')).toHaveText(['Bee', 'a.md'])
  await expect(heading(page, 'Bravo')).toBeVisible()
  const aId = await selector(page).locator('option').nth(1).getAttribute('value')
  await selector(page).selectOption(aId!)
  await expect(heading(page, 'Alpha')).toBeVisible()
  await more(page).click()
  await page.locator('.menu .menu-item', { hasText: 'Show in Explorer' }).click()
  await expect.poll(() => shellCalls(app)).toEqual(['show ' + a])
  await more(page).click()
  await page.locator('.menu .menu-item', { hasText: 'Open in default app' }).click()
  await expect.poll(() => shellCalls(app)).toEqual(['show ' + a, 'open ' + a])
  // Remove from list takes away the shown document: the newest one left is shown
  const bId = await selector(page).locator('option').nth(0).getAttribute('value')
  await selector(page).selectOption(bId!)
  await expect(heading(page, 'Bravo')).toBeVisible()
  await more(page).click()
  await page.locator('.menu .menu-item', { hasText: 'Remove from list' }).click()
  await expect(selector(page).locator('option')).toHaveText(['a.md'])
  await expect(heading(page, 'Alpha')).toBeVisible()
  // the last one removed: Docs is no longer offered and the panel falls back to Media
  await more(page).click()
  await page.locator('.menu .menu-item', { hasText: 'Remove from list' }).click()
  await expect(docsTab(page)).toBeHidden()
  await expect(panelTitle(page)).toHaveText('Media')
  await app.close()
})

test('a document shown in a tab behind shows when the tab comes to the front; a shell tab has no Docs button', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await page.keyboard.press(KEYS.newTab)
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
  await expect(page.evaluate(() => window.__ct!.activeTabId())).resolves.not.toBe(tabId)
  expect(await show(pipeName, tabId, spec)).toMatchObject({ ok: true })
  await expect(docsTab(page)).toBeHidden()
  await expect(panelTitle(page)).not.toHaveText('Docs')
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await expect(panelTitle(page)).toHaveText('Docs')
  await expect(heading(page, 'Spec')).toBeVisible()
  await app.close()
})

test('a link in a Markdown document: a web address opens in the browser, another link does nothing; raw HTML is text', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  await stubExternal(app)
  const doc = join(notes, 'links.md')
  writeFileSync(doc, '# Links\n\n[x](https://example.com/x) and [y](other.md)\n\n<img src=x onerror="document.title=\'pwned\'"> <script>document.title=\'pwned\'</script>\n')
  await show(pipeName, tabId, doc)
  await expect(heading(page, 'Links')).toBeVisible()
  const before = page.url()
  await page.locator('.doc-md a').nth(0).click()
  await expect.poll(() => externalCalls(app)).toEqual(['https://example.com/x'])
  await page.locator('.doc-md a').nth(1).click()
  await page.waitForTimeout(300)
  expect(await externalCalls(app)).toEqual(['https://example.com/x'])
  expect(page.url()).toBe(before)
  // raw HTML is shown as text, not run
  await expect(page.locator('.doc-md')).toContainText('<script>document.title=\'pwned\'</script>')
  await expect(page.locator('.doc-md')).toContainText('<img src=x')
  expect(await page.evaluate(() => document.title)).not.toBe('pwned')
  await app.close()
})

test('a document that cannot be read again shows its error in the panel', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const gone = join(notes, 'gone.md')
  const ok = join(notes, 'ok.md')
  writeFileSync(gone, '# Gone\n')
  writeFileSync(ok, '# Here\n')
  await show(pipeName, tabId, gone)
  await show(pipeName, tabId, ok)
  await expect(heading(page, 'Here')).toBeVisible()
  unlinkSync(gone)
  const goneId = await selector(page).locator('option').nth(1).getAttribute('value')
  await selector(page).selectOption(goneId!)
  await expect(page.locator('.panel-docs .panel-notice')).toBeVisible()
  await expect(page.locator('.panel-docs .panel-notice')).toHaveText(`File not found: ${gone}`)
  await app.close()
})

test('closing the Claude tab that shows a document leaves the panel on Media', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  // a shell tab stays open, so the Claude tab can close while Docs shows its document
  await page.keyboard.press(KEYS.newTab)
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
  await show(pipeName, tabId, spec)
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await expect(panelTitle(page)).toHaveText('Docs')
  await expect(heading(page, 'Spec')).toBeVisible()
  await page.evaluate((id) => window.ct.closeTab(id), tabId)
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  await expect(docsTab(page)).toBeHidden()
  await expect(panelTitle(page)).toHaveText('Media')
  await app.close()
})

test('a comment on a block is sent to Claude as one message followed by Enter', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  await commentBlock(page, 1, 'Clarify this')
  await expect(page.locator('.panel-docs .review-count')).toHaveText('1 comment')
  await page.locator('.panel-docs .review-send').click()
  await expect(page.locator('.panel-docs .review-count')).toHaveText('0 comments')
  // xterm's paste turns \n into \r, and wraps the text in bracketed-paste markers when the shell asked for them
  const sent = (await page.evaluate((id) => window.__ct!.ptyInput!(id), tabId)).replace(/\x1b\[20[01]~/g, '')
  expect(sent).toContain('Comments on notes/spec.md:\r\r1. notes/spec.md:3\r   > Body text.\r   Clarify this\r')
  await app.close()
})

test('right-click a block opens the document at its line, and copies path:line', async () => {
  // a stand-in editor writes the arguments it is started with: the test never starts the real editor
  const editorDir = mkdtempSync(join(tmpdir(), 'ct-editor-'))
  const script = join(editorDir, 'editor.js')
  const record = join(editorDir, 'args.txt')
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(record)}, process.argv.slice(2).join('\\n'))\n`)
  const { app, page, pipeName, tabId, notes } = await claudeTab({ ...FAKE_CLAUDE_SETTINGS, review: { editor: `node "${script}" {file} {line}` } })
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  const block = page.locator('.doc-md .md-seg').nth(1)
  await block.click({ button: 'right' })
  await expect(page.locator('.menu .menu-item')).toHaveText(['Comment', 'Open in editor at line 3', 'Copy path:line'])
  await page.locator('.menu .menu-item', { hasText: 'Open in editor at line 3' }).click()
  await expect.poll(() => (existsSync(record) ? readFileSync(record, 'utf8') : '')).toBe(`${spec}\n3`)
  await stubClipboard(app)
  await block.click({ button: 'right' })
  await page.locator('.menu .menu-item', { hasText: 'Copy path:line' }).click()
  await expect.poll(() => clipboardWrites(app)).toEqual(['notes/spec.md:3'])
  await app.close()
})

test('comments are kept per document; a document that leaves the list takes its comments with it', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const a = join(notes, 'a.md')
  const b = join(notes, 'b.md')
  writeFileSync(a, '# Alpha\n\nFirst.\n')
  writeFileSync(b, '# Bravo\n\nSecond.\n')
  await show(pipeName, tabId, a)
  await expect(heading(page, 'Alpha')).toBeVisible()
  await commentBlock(page, 1, 'On a')
  await expect(page.locator('.panel-docs .review-count')).toHaveText('1 comment')
  await show(pipeName, tabId, b)
  await expect(heading(page, 'Bravo')).toBeVisible()
  await expect(page.locator('.panel-docs .review-count')).toHaveText('0 comments')
  const aId = await selector(page).locator('option').nth(1).getAttribute('value')
  await selector(page).selectOption(aId!)
  await expect(heading(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.panel-docs .review-count')).toHaveText('1 comment')
  // Remove from list takes a's comments with it: shown again, a has none
  await more(page).click()
  await page.locator('.menu .menu-item', { hasText: 'Remove from list' }).click()
  await expect(selector(page).locator('option')).toHaveText(['b.md'])
  await show(pipeName, tabId, a)
  await expect(heading(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.panel-docs .review-count')).toHaveText('0 comments')
  await app.close()
})

test('a change of the Markdown file shows in the panel, and a comment follows its line', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  await commentBlock(page, 1, 'Clarify this')
  await expect(page.locator('.panel-docs .review-comment-meta')).toHaveText('notes/spec.md · Line 3')
  writeFileSync(spec, '# Spec v2\n\nIntro.\n\nBody text.\n')
  await expect(heading(page, 'Spec v2')).toBeVisible()
  await expect(page.locator('.panel-docs .review-comment-meta')).toHaveText('notes/spec.md · Line 5')
  await app.close()
})

test('a live redraw of a Markdown document keeps its scroll position', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  const body = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n')
  writeFileSync(spec, `# Spec\n\n${body}\n`)
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  const content = page.locator('.panel-docs .doc-content')
  await content.evaluate((e) => { e.scrollTop = 1000 })
  const before = await content.evaluate((e) => e.scrollTop)
  expect(before).toBeGreaterThan(0)
  writeFileSync(spec, `# Spec v2\n\n${body}\n`)
  await expect(heading(page, 'Spec v2')).toBeVisible()
  expect(await content.evaluate((e) => e.scrollTop)).toBe(before)
  await app.close()
})

test('Docs hidden and shown again keeps a Markdown document as it was, scroll position included', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  const body = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n')
  writeFileSync(spec, `# Spec\n\n${body}\n`)
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  const content = page.locator('.panel-docs .doc-content')
  await content.evaluate((e) => { e.scrollTop = 1000 })
  const before = await content.evaluate((e) => e.scrollTop)
  expect(before).toBeGreaterThan(0)
  await hideAndShowDocs(page)
  // a re-read would draw the document again from its top: give such a redraw time to happen
  await page.waitForTimeout(500)
  expect(await content.evaluate((e) => e.scrollTop)).toBe(before)
  await app.close()
})

test('a deleted document says so above its last content, and comes back', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  unlinkSync(spec)
  await expect(page.locator('.panel-docs .panel-notice')).toHaveText(`File not found: ${spec}`)
  await expect(heading(page, 'Spec')).toBeVisible()
  writeFileSync(spec, '# Spec\n\nBack again.\n')
  await expect(page.locator('.panel-docs .panel-notice')).toBeHidden()
  await expect(page.locator('.doc-md')).toContainText('Back again.')
  await app.close()
})

test('a relative image of a Markdown document loads, also when its name has a space and a non-ASCII letter', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  mkdirSync(join(notes, 'img'), { recursive: true })
  writeFileSync(join(notes, 'img', 'my shot ё.png'), PNG_1x1)
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '![shot](<img/my shot ё.png>)\n')
  await show(pipeName, tabId, spec)
  await expect.poll(() => page.locator('.doc-md img.md-img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0)
  await app.close()
})

test('a PDF document loads in the PDF viewer', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab()
  const pdf = join(work, 'sample.pdf')
  writeFileSync(pdf, minimalPdf())
  expect(await show(pipeName, tabId, pdf)).toEqual({ ok: true, info: 'Opened sample.pdf in the Docs panel.' })
  await expect(page.locator('iframe.doc-frame')).toHaveAttribute('src', /^ctdoc:\/\//)
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))).toBe(true)
  await app.close()
})

test('an HTML report runs its script in a sandboxed frame; its own links work, a link out goes nowhere', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab()
  const cov = join(work, 'cov')
  mkdirSync(cov)
  writeFileSync(join(cov, 'index.html'), REPORT_INDEX)
  writeFileSync(join(cov, 'app.js'), REPORT_APP)
  writeFileSync(join(cov, 'page2.html'), REPORT_PAGE2)
  expect(await show(pipeName, tabId, join(cov, 'index.html'))).toMatchObject({ ok: true })
  await expect(page.locator('iframe.doc-frame')).toHaveAttribute('sandbox', 'allow-scripts')
  const frame = page.frameLocator('iframe.doc-frame')
  await expect(frame.locator('#t')).toHaveText('Report ready · parent blocked')
  await slidIn(page)
  await frame.locator('#next').click()
  await expect(frame.locator('h1')).toHaveText('Page 2')
  // Docs hidden and shown again draws the report afresh
  await hideAndShowDocs(page)
  await expect(frame.locator('#t')).toHaveText('Report ready · parent blocked')
  // the window's CSP refuses the link out: no frame goes there
  await frame.locator('#out').click()
  await page.waitForTimeout(1000)
  expect(page.frames().map((f) => f.url()).filter((u) => u.startsWith('https://example.invalid'))).toEqual([])
  await hideAndShowDocs(page)
  await expect(frame.locator('#t')).toHaveText('Report ready · parent blocked')
  await app.close()
})

test('a change of an HTML report shows in its frame', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab()
  const cov = join(work, 'cov')
  mkdirSync(cov)
  writeFileSync(join(cov, 'index.html'), REPORT_INDEX)
  writeFileSync(join(cov, 'app.js'), REPORT_APP)
  await show(pipeName, tabId, join(cov, 'index.html'))
  const frame = page.frameLocator('iframe.doc-frame')
  await expect(frame.locator('#t')).toHaveText('Report ready · parent blocked')
  writeFileSync(join(cov, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="t">Report v2</h1></body></html>\n')
  await expect(frame.locator('#t')).toHaveText('Report v2')
  await app.close()
})

test('an HTML report with a module script and a fetch of its own data runs both', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab()
  const cov = join(work, 'cov')
  mkdirSync(cov)
  writeFileSync(join(cov, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="t">Report</h1><p id="v">waiting</p><script type="module" src="app.mjs"></script></body></html>\n')
  writeFileSync(join(cov, 'app.mjs'), "const r = await fetch('data.json')\nconst j = await r.json()\ndocument.getElementById('v').textContent = 'value ' + j.n\n")
  writeFileSync(join(cov, 'data.json'), '{"n": 42}\n')
  expect(await show(pipeName, tabId, join(cov, 'index.html'))).toMatchObject({ ok: true })
  const frame = page.frameLocator('iframe.doc-frame')
  await expect(frame.locator('#t')).toHaveText('Report')
  await expect(frame.locator('#v')).toHaveText('value 42')
  await app.close()
})

test('dragging the panel edge over a PDF frame keeps resizing; the release over the frame ends the drag', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab()
  const pdf = join(work, 'sample.pdf')
  writeFileSync(pdf, minimalPdf())
  await show(pipeName, tabId, pdf)
  await expect(page.locator('iframe.doc-frame')).toHaveAttribute('src', /^ctdoc:\/\//)
  // a panel that is still sliding in has its handle a few pixels off from where it comes to rest
  await panelSettled(page, true)
  const panelEl = page.locator('#image-panel')
  const start = (await panelEl.boundingBox())!.width
  const box = (await panelEl.boundingBox())!
  const handle = (await page.locator('.panel-resize').boundingBox())!
  const x0 = handle.x + handle.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x0, y)
  await page.mouse.down()
  // the cursor goes left-to-right over the frame: the panel narrows by the distance moved
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * 15, y)
  const during = (await panelEl.boundingBox())!.width
  await page.mouse.up()
  const afterUp = (await panelEl.boundingBox())!.width
  // the button is up: a move over the terminal must not resize the panel any more
  await page.mouse.move(x0 - 200, y)
  await page.waitForTimeout(200)
  const afterMove = (await panelEl.boundingBox())!.width
  expect(during).toBeLessThan(start - 100)
  expect(afterUp).toBe(during)
  expect(afterMove).toBe(afterUp)
  await app.close()
})

test('comment actions keep the scroll position of a long Markdown document: add, edit and delete', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'long.md')
  writeFileSync(spec, '# Long\n\n' + Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n') + '\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Long')).toBeVisible()
  // the panel is still sliding in: Playwright's own scroll-and-retry during the first actions moves the document, which is not what this test checks
  await panelSettled(page, true)
  const content = page.locator('.panel-docs .doc-content')
  const row = page.locator('.doc-md .md-seg', { hasText: 'Paragraph 100.' })
  await row.evaluate((r) => r.scrollIntoView({ block: 'center' }))
  const top = await content.evaluate((e) => e.scrollTop)
  expect(top).toBeGreaterThan(500)
  const expectKept = async () => expect(Math.abs((await content.evaluate((e) => e.scrollTop)) - top)).toBeLessThanOrEqual(2)
  await row.hover()
  await row.locator('.md-plus').click()
  await page.locator('.panel-docs .review-comment-input').fill('note')
  await page.locator('.panel-docs .review-btn.primary').click()
  await expect(page.locator('.panel-docs .review-count')).toHaveText('1 comment')
  await expectKept()
  await page.locator('.panel-docs .review-link', { hasText: 'Edit' }).click()
  await page.locator('.panel-docs .review-comment-input').fill('note, edited')
  await page.locator('.panel-docs .review-btn.primary').click()
  await expect(page.locator('.panel-docs .review-comment-text')).toHaveText('note, edited')
  await expectKept()
  await page.locator('.panel-docs .review-link', { hasText: 'Delete' }).click()
  await expect(page.locator('.panel-docs .review-count')).toHaveText('0 comments')
  await expectKept()
  await app.close()
})

test('a report cannot reach outside its folder: the window policy refuses its fetch, an image and another document', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab()
  const cov = join(work, 'cov')
  mkdirSync(cov)
  const other = '00000000-0000-4000-8000-000000000001'
  writeFileSync(join(cov, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="t">Report</h1><p id="csp">waiting</p><script src="app.js"></script></body></html>\n')
  writeFileSync(join(cov, 'app.js'), `const blocked = []
document.addEventListener('securitypolicyviolation', (e) => { blocked.push(e.blockedURI) })
fetch('https://example.invalid/x').catch(() => {})
fetch('ctdoc://${other}/x').catch(() => {})
const img = new Image()
img.src = 'ctimg://x'
document.body.append(img)
setTimeout(() => { document.getElementById('csp').textContent = 'blocked: ' + blocked.join(' | ') }, 500)
`)
  expect(await show(pipeName, tabId, join(cov, 'index.html'))).toMatchObject({ ok: true })
  const csp = page.frameLocator('iframe.doc-frame').locator('#csp')
  await expect(csp).toContainText('example.invalid')
  await expect(csp).toContainText('ctimg')
  // Chromium names a blocked cross-scheme request by its scheme only
  await expect(csp).toContainText('ctdoc')
  await app.close()
})

test('Ctrl+Enter saves a comment, and Escape cancels a draft', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  const row = page.locator('.doc-md .md-seg').nth(1)
  const input = page.locator('.panel-docs .review-comment-input')
  await row.hover()
  await row.locator('.md-plus').click()
  await input.fill('saved by the key')
  await input.press(MAC ? 'Meta+Enter' : 'Control+Enter')
  await expect(page.locator('.panel-docs .review-count')).toHaveText('1 comment')
  await expect(page.locator('.panel-docs .review-comment-text')).toHaveText('saved by the key')
  await row.hover()
  await row.locator('.md-plus').click()
  await input.fill('dropped')
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(page.locator('.panel-docs .review-count')).toHaveText('1 comment')
  await app.close()
})

test('a drag of the + over three blocks selects them, and the comment says the lines it covers', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nPara one.\n\nPara two.\n\nPara three.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  const rows = page.locator('.doc-md .md-seg')
  await rows.nth(1).hover()
  await rows.nth(1).locator('.md-plus').hover()
  await page.mouse.down()
  await rows.nth(2).hover()
  await rows.nth(3).hover()
  await expect(page.locator('.doc-md .md-seg.selected')).toHaveCount(3)
  await page.mouse.up()
  await expect(page.locator('.panel-docs .review-comment-meta')).toHaveText('Lines 3–7')
  await app.close()
})

test('Edit changes a comment, and Delete removes it', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  await commentBlock(page, 1, 'first')
  await page.locator('.panel-docs .review-link', { hasText: 'Edit' }).click()
  await page.locator('.panel-docs .review-comment-input').fill('second')
  await page.locator('.panel-docs .review-btn.primary').click()
  await expect(page.locator('.panel-docs .review-comment-text')).toHaveText('second')
  await expect(page.locator('.panel-docs .review-count')).toHaveText('1 comment')
  await page.locator('.panel-docs .review-link', { hasText: 'Delete' }).click()
  await expect(page.locator('.panel-docs .review-comment')).toHaveCount(0)
  await expect(page.locator('.panel-docs .review-count')).toHaveText('0 comments')
  await app.close()
})

test('a comment whose lines are removed from the file shows outdated, and is sent marked so', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  await commentBlock(page, 1, 'Clarify this')
  writeFileSync(spec, '# Spec\n\nOther text.\n')
  await expect(page.locator('.panel-docs .review-comment.outdated')).toBeVisible()
  await expect(page.locator('.panel-docs .review-outdated')).toHaveText('outdated')
  await page.locator('.panel-docs .review-send').click()
  await expect(page.locator('.panel-docs .review-count')).toHaveText('0 comments')
  const sent = (await page.evaluate((id) => window.__ct!.ptyInput!(id), tabId)).replace(/\x1b\[20[01]~/g, '')
  expect(sent).toContain('1. notes/spec.md:3 (outdated: the lines changed since)\r   > Body text.\r   Clarify this')
  await app.close()
})

test('⋯ → Copy path puts the document path on the clipboard', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n\nBody text.\n')
  await show(pipeName, tabId, spec)
  await expect(heading(page, 'Spec')).toBeVisible()
  await stubClipboard(app)
  await more(page).click()
  await page.locator('.menu .menu-item', { hasText: 'Copy path' }).click()
  await expect.poll(() => clipboardWrites(app)).toEqual([spec])
  await app.close()
})

test('the window sends WebRTC only through a proxy, so a report cannot send data over UDP', async () => {
  const { app } = await claudeTab()
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getWebRTCIPHandlingPolicy())).toBe('disable_non_proxied_udp')
  await app.close()
})

test('a failed stamp of an HTML report shows its error in the panel, not an empty frame', async () => {
  const { app, page, pipeName, tabId, work } = await claudeTab()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('docs:stamp')
    ipcMain.handle('docs:stamp', () => { throw new Error('stamp failed') })
  })
  const cov = join(work, 'cov')
  mkdirSync(cov)
  writeFileSync(join(cov, 'index.html'), '<!doctype html><html><body><h1 id="t">Report</h1></body></html>\n')
  await show(pipeName, tabId, join(cov, 'index.html'))
  await expect(page.locator('.panel-docs .panel-notice')).toContainText('stamp failed')
  await expect(page.locator('iframe.doc-frame')).toHaveCount(0)
  await app.close()
})

test('a Markdown document that cannot be read shows the error of the read, its first letter capitalized', async () => {
  const { app, page, pipeName, tabId, notes } = await claudeTab()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('docs:read')
    ipcMain.handle('docs:read', () => { throw new Error('read failed') })
  })
  const spec = join(notes, 'spec.md')
  writeFileSync(spec, '# Spec\n')
  await show(pipeName, tabId, spec)
  await expect(page.locator('.panel-docs .panel-notice')).toContainText('read failed')
  expect(await page.locator('.panel-docs .panel-notice').textContent()).toMatch(/^[A-Z]/)
  await app.close()
})

test('the Docs toggle looks like the Media toggle in the sheet\'s header, with the tabs on top or on the left, and its active state shows', async () => {
  for (const position of ['top', 'left'] as const) {
    const settings = position === 'top' ? FAKE_CLAUDE_SETTINGS : { ...FAKE_CLAUDE_SETTINGS, defaultFolder: mkdtempSync(join(tmpdir(), 'ct-folder-')), tabs: { position: 'left' } }
    const { app, page, pipeName, tabId, notes } = await claudeTab(settings)
    // the toggles sit in the sheet's header whichever position the tabs have
    const docs = page.locator('#sheet-header .tab-docs-toggle')
    const media = page.locator('#sheet-header .tab-images-toggle')
    const looks = (el: Locator) => el.evaluate((b) => {
      const s = getComputedStyle(b)
      return { background: s.backgroundColor, borderTop: s.borderTopWidth, paddingLeft: s.paddingLeft, shadow: s.boxShadow }
    })
    const resting = async (el: Locator) => { const { shadow, ...rest } = await looks(el); return rest }
    const spec = join(notes, 'spec.md')
    writeFileSync(spec, '# Spec\n\nBody text.\n')

    expect(await show(pipeName, tabId, spec)).toMatchObject({ ok: true })
    await expect(docs).toHaveClass(/active/)
    await docs.click()
    await expect(panel(page)).toHaveClass(/collapsed/)
    // the pointer rests on Docs after the click: move it off, so no hover tints one toggle while the two are compared
    await page.mouse.move(1, 1)
    expect(await resting(docs)).toEqual(await resting(media))

    await media.click()
    await expect(media).toHaveClass(/active/)
    const mediaOpen = await looks(media)
    // the active toggle is a lit pill (--raised-2), with no underline
    expect(mediaOpen.background).toBe('rgb(30, 30, 35)')
    expect(mediaOpen.shadow).toBe('none')
    expect(await show(pipeName, tabId, spec)).toMatchObject({ ok: true })
    await expect(docs).toHaveClass(/active/)
    expect(await looks(docs)).toEqual(mediaOpen)
    await app.close()
  }
})
