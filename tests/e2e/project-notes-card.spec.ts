import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { basename } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, launchApp, launchClaudeTab, noteText, openTabInFront } from './helpers'

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
