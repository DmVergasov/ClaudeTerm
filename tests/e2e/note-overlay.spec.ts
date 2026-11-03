import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Note } from '../../src/shared/note'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, KEY_LABELS, KEYS, launchApp, launchClaudeTab, makeDataDir, TEST_SHELL } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

/** the note over the terminal, the Note button and the mark on the tabs */
function note(page: Page) {
  const card = page.locator('#note .note-card')
  return {
    card,
    label: page.locator('#note .note-label'),
    text: card.locator('.note-text'),
    button: page.locator('#tabbar .tab-note-toggle'),
    mark: page.locator('#tabbar .tab .tab-note')
  }
}

/** the input of the terminal in front */
const terminalInput = (page: Page) => page.locator('.terminal-host:visible .xterm-helper-textarea')

/** opens a second Claude tab and waits until it is in front; resolves to its id */
async function openSecondTab(page: Page, work: string, first: string): Promise<string> {
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, first)
  return (await page.evaluate(() => window.__ct!.activeTabId()))!
}

async function activate(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
}

test('the Note button opens an empty card to write in, and typing marks the tab', async () => {
  const { app, page } = await launchClaudeTab()
  const { card, text, button, mark } = note(page)
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('title', `Note (${KEY_LABELS.note})`)
  await expect(button).not.toHaveClass(/active/)

  await button.click()
  await expect(card).toBeVisible()
  await expect(text).toBeFocused()
  await expect(text).toHaveAttribute('placeholder', 'Write a note for this session…')
  await expect(button).toHaveClass(/active/)
  await expect(mark).toHaveCount(0)

  await page.keyboard.type('Goal: payments\nTODO: tests\n— no export.py')
  await expect(text).toHaveValue('Goal: payments\nTODO: tests\n— no export.py')
  await expect(mark).toHaveCount(1)
  await expect(mark).toHaveAttribute('title', 'Has a note')
  await app.close()
})

test('– collapses the note to a label with its first line, a click opens it, × hides it, and the button brings back the last form', async () => {
  const { app, page } = await launchClaudeTab()
  const { card, label, text, button } = note(page)
  const collapse = card.locator('.note-collapse')
  const hide = card.locator('.note-hide')

  await button.click()
  await expect(card).toBeVisible()
  await expect(card.locator('.note-title')).toHaveText('Note')
  await expect(collapse).toHaveAttribute('title', 'Collapse to a label')
  await expect(hide).toHaveAttribute('title', 'Hide the note')
  await collapse.click() // an empty note has no label to collapse to
  await expect(card).toBeHidden()
  await expect(label).toBeHidden()

  await button.click()
  await expect(text).toBeFocused()
  await page.keyboard.type('\n  Goal: payments\nTODO')
  await collapse.click()
  await expect(label).toBeVisible()
  await expect(label).toHaveAttribute('title', 'Show the note')
  await expect(label.locator('.note-label-text')).toHaveText('Goal: payments')
  await expect(card).toBeHidden()
  await expect(terminalInput(page)).toBeFocused()

  await label.click()
  await expect(card).toBeVisible()
  await expect(text).toBeFocused()
  await hide.click()
  await expect(card).toBeHidden()
  await expect(label).toBeHidden()
  await expect(button).not.toHaveClass(/active/)
  await expect(terminalInput(page)).toBeFocused()

  await button.click() // a note with text: the keyboard goes back to the terminal, as after Media and Changes
  await expect(card).toBeVisible()
  await expect(button).toHaveClass(/active/)
  await expect(terminalInput(page)).toBeFocused()
  await collapse.click()
  await expect(label).toBeVisible()
  await button.click()
  await expect(label).toBeHidden()
  await expect(card).toBeHidden()
  await button.click()
  await expect(label).toBeVisible()
  await expect(card).toBeHidden()
  await app.close()
})

test('the shortcut does what the button does; Esc in the note gives the keyboard back to the terminal', async () => {
  const { app, page } = await launchClaudeTab()
  const { card, text } = note(page)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.note)
  await expect(card).toBeVisible()
  await expect(text).toBeFocused()
  await page.keyboard.type('x')

  await page.keyboard.press('Escape')
  await expect(card).toBeVisible()
  await expect(text).not.toBeFocused()
  await expect(terminalInput(page)).toBeFocused()

  await page.keyboard.press(KEYS.note)
  await expect(card).toBeHidden()
  await page.keyboard.press(KEYS.note)
  await expect(card).toBeVisible()
  await text.click()
  await page.keyboard.press(KEYS.note)
  await expect(card).toBeHidden()
  await expect(terminalInput(page)).toBeFocused()
  await app.close()
})

test('the window coming back to the front leaves the keyboard in the note', async () => {
  const { app, page } = await launchClaudeTab()
  const { text, button } = note(page)
  await button.click()
  await expect(text).toBeFocused()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(text).toBeFocused()
  await app.close()
})

test('a shell tab has no Note button, and the shortcut does nothing there', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const { button } = note(page)
  await expect(page.locator('#tabbar .tab-images-toggle')).toBeVisible()
  await expect(button).toBeHidden()
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.note)
  await expect(page.locator('#note > *').filter({ visible: true })).toHaveCount(0)
  await app.close()
})

test('erasing the text removes the mark; the empty card goes once the tab is left', async () => {
  const { app, page, tabId, work } = await launchClaudeTab()
  const { card, text, button, mark } = note(page)
  await button.click()
  await page.keyboard.type('x')
  await expect(mark).toHaveCount(1)
  await text.fill('')
  await expect(mark).toHaveCount(0)
  await expect(card).toBeVisible()

  await openSecondTab(page, work, tabId)
  await activate(page, tabId)
  await expect(card).toBeHidden()
  await app.close()
})

test('each Claude tab shows its own note', async () => {
  const { app, page, tabId, work } = await launchClaudeTab()
  const { card, text, button } = note(page)
  await button.click()
  await page.keyboard.type('one')

  const second = await openSecondTab(page, work, tabId)
  await expect(card).toBeHidden()
  await button.click()
  await expect(card).toBeVisible()
  await expect(text).toHaveValue('')
  await page.keyboard.type('two')

  await activate(page, tabId)
  await expect(text).toHaveValue('one')
  await activate(page, second)
  await expect(text).toHaveValue('two')
  await app.close()
})

test('showing, collapsing and hiding the note leaves the terminal its size', async () => {
  const { app, page, tabId } = await launchClaudeTab()
  const { card, label, button } = note(page)
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toContain('fake-claude')
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  const sizes = await page.evaluate((id) => window.__ct!.ptySizes!(id), tabId)

  await button.click()
  await page.keyboard.type('Goal: payments')
  await card.locator('.note-collapse').click()
  await expect(label).toBeVisible()
  await label.click()
  await expect(card).toBeVisible()
  await card.locator('.note-hide').click()
  await expect(card).toBeHidden()
  await page.waitForTimeout(500)
  expect(await page.evaluate((id) => window.__ct!.ptySizes!(id), tabId)).toEqual(sizes)
  await app.close()
})

test('a restored tab shows its note as it was left', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [{ kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'mine', claudeSessionId: SID_A }] }))
  writeFileSync(join(dataDir, 'session-notes.json'), JSON.stringify({ [SID_A]: { text: 'Goal: payments\nTODO', shown: true, form: 'label' } }))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  const { label, button, mark } = note(page)
  await expect(label).toBeVisible()
  await expect(label.locator('.note-label-text')).toHaveText('Goal: payments')
  await expect(mark).toHaveCount(1)
  await expect(button).toHaveClass(/active/)
  await app.close()
})

test('/resume into a conversation with a note while typing in the card: the card shows that note, the typed text stays with the conversation left, and what is typed next goes to the note shown', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  writeFileSync(join(dataDir, 'session-notes.json'), JSON.stringify({ [SID_A]: { text: 'alpha', shown: true, form: 'card' } }))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page, pipeName } = await launchApp({ dataDir, args: ['--claude', work] })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const session = (sessionId: string, source: 'startup' | 'resume') =>
    sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source, transcriptPath: null })
  const { text, button } = note(page)
  expect(await session(SID_B, 'startup')).toEqual({ ok: true })
  await button.click()
  await page.keyboard.type('beta')
  await expect(text).toBeFocused()

  // what was typed may still be on its way to main: it stays with the conversation left either way
  expect(await session(SID_A, 'resume')).toEqual({ ok: true })
  await expect(text).toHaveValue('alpha')
  await expect(text).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.type(' too')
  await expect(text).toHaveValue('alpha too')
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-notes.json'), 'utf8')) as Record<string, Note>
  expect(saved[SID_A]?.text).toBe('alpha too')
  expect(saved[SID_B]?.text).toBe('beta')
})

test('with the side panel lying over the terminal, the note sits left of it', async () => {
  test.skip(!WIN && !process.env.XDG_CURRENT_DESKTOP, 'no desktop (xvfb): there is no window manager to maximize the window')
  const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, sidePanel: { noRoom: 'overlay' }, imagePanel: { autoOpen: false } })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.maximize())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.isMaximized())).toBe(true)
  const { card, button } = note(page)
  const panel = page.locator('#image-panel')
  await button.click()
  await page.keyboard.type('x')
  // the keyboard back in the terminal: in the note, the keys are the note's
  await page.keyboard.press('Escape')
  await page.keyboard.press(KEYS.images)
  await expect(panel).not.toHaveClass(/collapsed/)
  await expect.poll(async () => {
    const c = await card.boundingBox()
    const p = await panel.boundingBox()
    return c !== null && p !== null && c.x + c.width <= p.x
  }).toBe(true)
  await app.close()
})
