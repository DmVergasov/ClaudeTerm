import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectNote } from '../../src/shared/note'
import { FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, launchApp } from './helpers'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

const recordProjectNotes = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { projectNotes: [string, ProjectNote | null, number][] }
  w.projectNotes = []
  window.ct.onProjectNote((key, note, generation) => { w.projectNotes.push([key, note, generation]) })
})
const recordedProjectNotes = (page: Page) => page.evaluate(() => (window as unknown as { projectNotes: [string, ProjectNote | null, number][] }).projectNotes)
const projectNotesFile = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, 'project-notes.json'), 'utf8')) as Record<string, ProjectNote>
/** a round trip to main: what the page sent before has been handled when it answers */
const synced = (page: Page) => page.evaluate(() => window.ct.getStarredSessions())

/** opens a Claude tab in the folder; waits until main has placed it (its project, or null outside git) */
async function openClaudeTab(page: Page, cwd: string): Promise<string> {
  const tab = (await page.evaluate((dir) => window.ct.openTab({ kind: 'claude', cwd: dir }), cwd))!.id
  await expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id) !== undefined, tab)).toBe(true)
  return tab
}
/** the project key of a placed tab; null outside git */
const keyOf = (page: Page, tab: string) => page.evaluate((id) => window.__ct!.placeOf!(id)?.project.key ?? null, tab)

test('the first Claude tab of a project gets its project note with number 1; a tab outside git gets none', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await recordProjectNotes(page)
  const repo = gitRepo()
  const tab = await openClaudeTab(page, repo)
  const key = (await keyOf(page, tab))!
  expect(key).not.toBeNull()
  await expect.poll(() => recordedProjectNotes(page)).toEqual([[key, null, 1]])
  const plain = await openClaudeTab(page, mkdtempSync(join(tmpdir(), 'ct-work-')))
  expect(await keyOf(page, plain)).toBeNull()
  await synced(page)
  expect(await recordedProjectNotes(page)).toEqual([[key, null, 1]])
  await app.close()
})

test('a project note typed in one tab is stored under the project key, and a tab in a linked worktree writes the same note', async () => {
  const repo = gitRepo()
  const { app, page, dataDir } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tab1 = await openClaudeTab(page, repo)
  const tab2 = await openClaudeTab(page, gitWorktree(repo, 'feature'))
  const key = (await keyOf(page, tab1))!
  expect(await keyOf(page, tab2)).toBe(key)
  await page.evaluate(({ id, key }) => window.ct.setProjectNoteText(id, key, 'Release checklist', 1), { id: tab1, key })
  await page.evaluate(({ id, key }) => window.ct.setProjectNoteText(id, key, 'Release checklist\n- [ ] Tag', 1), { id: tab2, key })
  await synced(page)
  await closeWindow(app)
  expect(projectNotesFile(dataDir)).toEqual({ [key]: { text: 'Release checklist\n- [ ] Tag' } })
})

test("the project note's size is kept with it", async () => {
  const repo = gitRepo()
  const { app, page, dataDir } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tab = await openClaudeTab(page, repo)
  const key = (await keyOf(page, tab))!
  await page.evaluate(({ id, key }) => {
    window.ct.setProjectNoteText(id, key, 'Checklist', 1)
    window.ct.setProjectNoteSize(id, key, { width: 600, height: 400 })
  }, { id: tab, key })
  await synced(page)
  await closeWindow(app)
  expect(projectNotesFile(dataDir)).toEqual({ [key]: { text: 'Checklist', size: { width: 600, height: 400 } } })
})

test('a text sent for another key, or from a tab outside git, is not kept', async () => {
  const repo = gitRepo()
  const { app, page, dataDir } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const inGit = await openClaudeTab(page, repo)
  const outside = await openClaudeTab(page, mkdtempSync(join(tmpdir(), 'ct-work-')))
  const key = (await keyOf(page, inGit))!
  await page.evaluate(({ inGit, outside, key }) => {
    window.ct.setProjectNoteText(inGit, 'C:/invented/other-project', 'not for this project', 1)
    window.ct.setProjectNoteText(outside, key, 'from outside git', 1)
  }, { inGit, outside, key })
  await synced(page)
  await closeWindow(app)
  expect(existsSync(join(dataDir, 'project-notes.json'))).toBe(false)
})
