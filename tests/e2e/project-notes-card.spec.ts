import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { WIN } from '../fixtures/platform'
import { basename } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, KEYS, launchApp, launchClaudeTab, noteText, openTabInFront } from './helpers'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

const addNote = (pipeName: string, tabId: string, note: 'session' | 'project', text: string) =>
  sendPipeMessage(pipeName, { v: 1, type: 'note_add', tabId, note, text })
const checkItem = (pipeName: string, tabId: string, note: 'session' | 'project', item: string, checked: boolean) =>
  sendPipeMessage(pipeName, { v: 1, type: 'note_check', tabId, note, item, checked })
/** a round trip to main: what the page sent before has been handled when it answers */
const synced = (page: Page) => page.evaluate(() => window.ct.getStarredSessions())

/** the note over the terminal, the Note button and the switch of the card */
function note(page: Page) {
  return {
    card: page.locator('#note .note-card'),
    label: page.locator('#note .note-label'),
    button: page.locator('#sheet-header .tab-note-toggle'),
    side: (name: 'session' | 'project') => page.locator(`#note .note-side[data-side="${name}"]`)
  }
}

/** the project key of a placed tab, once main has placed it */
async function placedKey(page: Page, tabId: string): Promise<string> {
  await expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id) !== undefined, tabId)).toBe(true)
  return (await page.evaluate((id) => window.__ct!.placeOf!(id)?.project.key ?? null, tabId))!
}

/** types the first item of a project note: a line made into a checkbox item, then a second, unticked one */
async function typeTwoItems(page: Page, card: ReturnType<typeof note>['card']): Promise<void> {
  await page.keyboard.type('Tag the release')
  await card.locator('.note-tool[data-tool="checkbox"]').click()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Write the changelog')
  await expect.poll(() => noteText(page)).toBe('- [ ] Tag the release\n- [ ] Write the changelog')
}

test('the switch shows Session and Project with their counts, and the card opens on the side it was last on', async () => {
  const repo = gitRepo()
  const { app, page, tabId } = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  await placedKey(page, tabId)
  const { card, button, side } = note(page)

  await button.click()
  await side('project').click()
  await expect(side('project')).toHaveClass(/active/)
  await typeTwoItems(page, card)
  await card.locator('.note-check').first().click()

  await expect(side('project').locator('.note-side-count')).toHaveText('1/2')
  await expect(side('session').locator('.note-side-count')).toBeHidden()
  await card.locator('.note-hide').click()
  await button.click()
  await expect(side('project')).toHaveAttribute('aria-pressed', 'true')
  await expect(side('project')).toHaveClass(/active/)
  expect(await noteText(page)).toBe('- [x] Tag the release\n- [ ] Write the changelog')
  await app.close()
})

test('two tabs of one project, one in a linked worktree, share the project note', async () => {
  const repo = gitRepo()
  const { app, page, tabId, pipeName } = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  const key = await placedKey(page, tabId)
  const { card, button, side } = note(page)

  await button.click()
  await side('project').click()
  await page.keyboard.type('Release checklist')
  await expect.poll(() => noteText(page)).toBe('Release checklist')

  const second = await openTabInFront(page, 'claude', gitWorktree(repo, 'feature'))
  expect(await placedKey(page, second)).toBe(key)
  await button.click()
  await side('project').click()
  await expect.poll(() => noteText(page)).toBe('Release checklist')
  await page.keyboard.type(' (two tabs)')
  await expect.poll(() => noteText(page)).toBe('Release checklist (two tabs)')
  await synced(page)

  await page.locator(`#tabbar .tab[data-tab-id="${tabId}"]`).click()
  await expect(side('project')).toHaveClass(/active/)
  await expect.poll(() => noteText(page)).toBe('Release checklist (two tabs)')
  expect(await addNote(pipeName, second, 'project', '- [ ] Tag')).toEqual({ ok: true, info: `Added to the project note (${basename(repo)}).` })
  await expect.poll(() => noteText(page)).toBe('Release checklist (two tabs)\n\n- [ ] Tag')
  await expect(card).toBeVisible()
  await app.close()
})

test('the project note comes back after a restart', async () => {
  const repo = gitRepo()
  const { app, page, tabId, dataDir } = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  await placedKey(page, tabId)
  await note(page).button.click()
  await note(page).side('project').click()
  await page.keyboard.type('Kept across restarts')
  await synced(page)
  await closeWindow(app)

  const again = await launchApp({ dataDir, settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', repo] })
  await again.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tab = (await again.page.evaluate(() => window.__ct!.activeTabId()))!
  await placedKey(again.page, tab)
  await note(again.page).button.click()
  await note(again.page).side('project').click()
  await expect.poll(() => noteText(again.page)).toBe('Kept across restarts')
  await again.app.close()
})

test('a tab outside git has the Project side disabled, with the reason as its tooltip', async () => {
  const { app, page, tabId } = await launchClaudeTab()
  await expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id) !== undefined, tabId)).toBe(true)
  const { button, side } = note(page)
  await button.click()

  await expect(side('project')).toHaveAttribute('aria-disabled', 'true')
  await expect(side('project')).toHaveAttribute('title', 'No project note: this folder is not in a git repository')
  // a disabled side is not clickable for Playwright: the click is forced, to show that it does nothing
  await side('project').click({ force: true })
  await expect(side('session')).toHaveClass(/active/)
  await app.close()
})

test('collapsed, the label shows the count and the first unticked item of the note in front', async () => {
  const repo = gitRepo()
  const { app, page, tabId } = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  await placedKey(page, tabId)
  const { card, button, label, side } = note(page)

  await button.click()
  await side('project').click()
  await typeTwoItems(page, card)
  await card.locator('.note-check').first().click()
  await card.locator('.note-collapse').click()

  await expect(label.locator('.note-label-count')).toHaveText('1/2')
  await expect(label.locator('.note-label-text')).toHaveText('Write the changelog')
  await app.close()
})

test("Claude's edit shows in the open card at once; the caret stays and what is typed next goes where it was", async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const { card, button } = note(page)

  await button.click()
  await expect(card).toBeVisible()
  await page.keyboard.type('abc')
  await expect.poll(() => noteText(page)).toBe('abc')
  expect(await addNote(pipeName, tabId, 'session', '- [ ] from Claude')).toEqual({ ok: true, info: 'Added to the session note.' })
  await expect.poll(() => noteText(page)).toBe('abc\n\n- [ ] from Claude')
  await page.keyboard.type('def')
  await expect.poll(() => noteText(page)).toBe('abcdef\n\n- [ ] from Claude')
  await app.close()
})

test("while the card shows the other note, or is collapsed, Claude's tick moves the count", async () => {
  const repo = gitRepo()
  const { app, page, tabId, pipeName } = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  await placedKey(page, tabId)
  const { card, button, label, side } = note(page)

  await button.click()
  await side('project').click()
  await typeTwoItems(page, card)
  await synced(page)

  await side('session').click()
  await expect(side('session')).toHaveClass(/active/)
  expect(await checkItem(pipeName, tabId, 'project', 'Tag the release', true)).toEqual({ ok: true, info: `Ticked "Tag the release" in the project note (${basename(repo)}).` })
  await expect(side('project').locator('.note-side-count')).toHaveText('1/2')

  await side('project').click()
  await card.locator('.note-collapse').click()
  expect(await checkItem(pipeName, tabId, 'project', 'Write the changelog', true)).toEqual({ ok: true, info: `Ticked "Write the changelog" in the project note (${basename(repo)}).` })
  await expect(label.locator('.note-label-count')).toHaveText('2/2')
  await app.close()
})
test('a tab moved into a git repository enables the Project side of its note', async () => {
  const { app, page, tabId } = await launchClaudeTab()
  await expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id) !== undefined, tabId)).toBe(true)
  const { button, side } = note(page)
  await button.click()
  await expect(side('project')).toHaveAttribute('aria-disabled', 'true')

  // the move closes the card and gives the tab a note of its own; the Project side follows the tab's place, which comes later
  expect(await page.evaluate(([id, dir]) => window.ct.changeFolder(id, dir), [tabId, gitRepo()] as [string, string])).toEqual({ ok: true })
  await expect(side('project')).toHaveAttribute('aria-disabled', 'false', { timeout: 15_000 })
  await app.close()
})

test("the new folder's note is empty: the undo steps of the old folder's note do not come back into it", async () => {
  const { app, page, tabId } = await launchClaudeTab()
  const { card, button } = note(page)
  await button.click()
  await expect(page.locator('#note .note-text')).toBeFocused()
  await page.keyboard.type('x')
  // CodeMirror joins changes made within 500 ms into one undo step: the delete waits so that it is a step of its own
  await page.waitForTimeout(700)
  await page.keyboard.press('Backspace')
  await expect.poll(() => noteText(page)).toBe('')

  expect(await page.evaluate(([id, dir]) => window.ct.changeFolder(id, dir), [tabId, gitRepo()] as [string, string])).toEqual({ ok: true })
  await expect(card).toBeHidden()
  await button.click()
  await expect(card).toBeVisible()
  await page.keyboard.press('ControlOrMeta+KeyZ')
  expect(await noteText(page)).toBe('')
  await app.close()
})

test("a card as wide as the room stays in the terminal's area when a side panel opens over the terminal", async () => {
  test.skip(!WIN && !process.env.XDG_CURRENT_DESKTOP, 'no desktop (xvfb): there is no window manager to maximize the window')
  const { app, page } = await launchClaudeTab({ ...FAKE_CLAUDE_SETTINGS, sidePanel: { noRoom: 'overlay' }, imagePanel: { autoOpen: false } })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.maximize())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getParentWindow() === null)!.isMaximized())).toBe(true)
  const { card, button } = note(page)
  const left = async (): Promise<number> => (await card.boundingBox())!.x
  await button.click()
  await expect(card).toBeVisible()

  // the grip dragged left, past the room's left edge: the card takes all the room the terminal's area has
  const area = (await page.locator('#terminals').boundingBox())!
  const grip = (await page.locator('#note .note-grip').boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(area.x - 100, grip.y + grip.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(left).toBeLessThanOrEqual(area.x + 12)

  await page.locator('.terminal-host:visible .xterm-helper-textarea').focus()
  await page.keyboard.press(KEYS.images)
  await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
  // the panel must lie over the terminal for this test to mean anything: the overlay class, and a cover the card is drawn left of
  await expect(page.locator('#image-panel')).toHaveClass(/overlay/)
  await expect.poll(left).toBeGreaterThanOrEqual(area.x + 9.5)
  await app.close()
})

test("the grip does not cover the Checkbox button of the card's foot", async () => {
  const { app, page } = await launchClaudeTab()
  await note(page).button.click()
  await expect(note(page).card).toBeVisible()
  const grip = (await page.locator('#note .note-grip').boundingBox())!
  const checkbox = (await page.locator('#note .note-tool[data-tool="checkbox"]').boundingBox())!
  expect(checkbox.x, 'the grip covers the Checkbox button').toBeGreaterThanOrEqual(grip.x + grip.width)
  await app.close()
})
