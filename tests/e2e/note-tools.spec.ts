import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { MAX_NOTE_LENGTH, type Note, type ProjectNote } from '../../src/shared/note'
import type { NoteOp } from '../../src/shared/note-items'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, gitRepo, launchClaudeTab } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const UNKNOWN_TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c99'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

const recordOps = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { noteOps: [string, NoteOp, number][] }
  w.noteOps = []
  window.ct.onNoteOp((id, op, generation) => { w.noteOps.push([id, op, generation]) })
})
const recordedOps = (page: Page) => page.evaluate(() => (window as unknown as { noteOps: [string, NoteOp, number][] }).noteOps)
const notesFile = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, 'session-notes.json'), 'utf8')) as Record<string, Note>
const projectNotesFile = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, 'project-notes.json'), 'utf8')) as Record<string, ProjectNote>
/** a round trip to main: what the page sent before has been handled when it answers */
const synced = (page: Page) => page.evaluate(() => window.ct.getStarredSessions())

const session = (pipeName: string, tabId: string, sessionId: string, source: 'startup' | 'resume' | 'clear' | 'compact') =>
  sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source, transcriptPath: null })
const readNotes = (pipeName: string, tabId: string) => sendPipeMessage(pipeName, { v: 1, type: 'note_read', tabId })
const readInfo = async (pipeName: string, tabId: string): Promise<string | undefined> => {
  const reply = await readNotes(pipeName, tabId)
  return reply.ok ? reply.info : undefined
}
const addNote = (pipeName: string, tabId: string, note: 'session' | 'project', text: string) =>
  sendPipeMessage(pipeName, { v: 1, type: 'note_add', tabId, note, text })
const checkItem = (pipeName: string, tabId: string, note: 'session' | 'project', item: string, checked: boolean) =>
  sendPipeMessage(pipeName, { v: 1, type: 'note_check', tabId, note, item, checked })

/** the project key of a placed tab, once main has placed it */
async function placedKey(page: Page, tabId: string): Promise<string> {
  await expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id) !== undefined, tabId)).toBe(true)
  return (await page.evaluate((id) => window.__ct!.placeOf!(id)?.project.key ?? null, tabId))!
}

test('note_add adds to the session note after a blank line; the window gets it as an op with the next number; the file keeps it', async () => {
  const { app, page, tabId, dataDir, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.setNoteText(id, 'Goal: payments', 0), tabId)
  await synced(page)
  await recordOps(page)
  expect(await addNote(pipeName, tabId, 'session', '- [ ] Write the tests')).toEqual({ ok: true, info: 'Added to the session note.' })
  await synced(page)
  expect(await recordedOps(page)).toEqual([[tabId, { kind: 'append', text: '- [ ] Write the tests' }, 1]])
  await closeWindow(app)
  expect(notesFile(dataDir)[SID_A]?.text).toBe('Goal: payments\n\n- [ ] Write the tests')
})

test("note_read answers both notes; a tab outside git has no project note, and says why", async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.setNoteText(id, 'Goal: payments', 0), tabId)
  await synced(page)
  await expect.poll(async () => (await readInfo(pipeName, tabId))?.endsWith("(none: this tab's folder is not in a git repository)")).toBe(true)
  expect(await readNotes(pipeName, tabId)).toEqual({
    ok: true,
    info: "## Session note\nGoal: payments\n\n## Project note\n(none: this tab's folder is not in a git repository)"
  })
  await app.close()
})

test('note_add and note_check on the project note of a git tab', async () => {
  const repo = gitRepo()
  const name = basename(repo)
  const { app, tabId, pipeName } = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  await expect.poll(async () => (await readInfo(pipeName, tabId))?.includes(`## Project note (${name})`)).toBe(true)
  expect(await addNote(pipeName, tabId, 'project', '- [ ] Tag the release\n- [ ] Write the changelog')).toEqual({ ok: true, info: `Added to the project note (${name}).` })
  expect(await checkItem(pipeName, tabId, 'project', 'Tag the release', true)).toEqual({ ok: true, info: `Ticked "Tag the release" in the project note (${name}).` })
  expect(await readInfo(pipeName, tabId)).toContain('- [x] Tag the release\n- [ ] Write the changelog')
  await app.close()
})

test('note_check with no match lists the items and changes nothing', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  await page.evaluate((id) => window.ct.setNoteText(id, '- [ ] Tag the release\n- [ ] Write the changelog', 0), tabId)
  await synced(page)
  expect(await checkItem(pipeName, tabId, 'session', 'Publish', true)).toEqual({
    ok: false,
    error: 'No item "Publish" in the session note. Its items:\n- [ ] Tag the release\n- [ ] Write the changelog'
  })
  expect(await readInfo(pipeName, tabId)).toMatch(/^## Session note\n- \[ \] Tag the release\n- \[ \] Write the changelog\n\n/)
  await app.close()
})

test('note_add refuses text that would pass the limit, and adds nothing', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  await page.evaluate(({ id, text }) => window.ct.setNoteText(id, text, 0), { id: tabId, text: 'x'.repeat(MAX_NOTE_LENGTH - 5) })
  await synced(page)
  expect(await addNote(pipeName, tabId, 'session', 'abcdef')).toEqual({
    ok: false,
    error: 'The text would make the session note longer than 100000 characters (it has 99995, the text adds 8). Nothing was added.'
  })
  await app.close()
})

test("a text typed before Claude's edit reached the window keeps Claude's edit", async () => {
  const repo = gitRepo()
  const name = basename(repo)
  const { app, page, tabId, dataDir, pipeName } = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  const key = await placedKey(page, tabId)
  await page.evaluate(({ id, key }) => window.ct.setProjectNoteText(id, key, 'Release', 1), { id: tabId, key })
  await synced(page)
  expect(await addNote(pipeName, tabId, 'project', '- [ ] Tag the release')).toEqual({ ok: true, info: `Added to the project note (${name}).` })
  await page.evaluate(({ id, key }) => window.ct.setProjectNoteText(id, key, 'Release checklist', 1), { id: tabId, key })
  await synced(page)
  expect(await readInfo(pipeName, tabId)).toBe(`## Session note\n(empty)\n\n## Project note (${name})\nRelease checklist\n\n- [ ] Tag the release`)
  await closeWindow(app)
  expect(projectNotesFile(dataDir)[key]?.text).toBe('Release checklist\n\n- [ ] Tag the release')
})

test("Claude's addition to a tab without a conversation is stored once the conversation starts", async () => {
  const { app, tabId, dataDir, pipeName } = await launchClaudeTab()
  expect(await addNote(pipeName, tabId, 'session', 'kept')).toEqual({ ok: true, info: 'Added to the session note.' })
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  await closeWindow(app)
  expect(notesFile(dataDir)).toEqual({ [SID_A]: { text: 'kept', shown: false, form: 'card' } })
})

test('an unknown tab is refused', async () => {
  const { app, pipeName } = await launchClaudeTab()
  expect(await readNotes(pipeName, UNKNOWN_TAB)).toEqual({ ok: false, error: 'read_notes works only in a ClaudeTerm Claude tab' })
  await app.close()
})
test('a note_add to an empty session note marks the tab as having a note', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  await synced(page)
  const mark = page.locator('#tabbar .tab .tab-note')
  await expect(mark).toHaveCount(0)
  expect(await addNote(pipeName, tabId, 'session', '- [ ] Write the tests')).toEqual({ ok: true, info: 'Added to the session note.' })
  await expect(mark).toHaveCount(1)
  await expect(mark).toHaveAttribute('title', 'Has a note')
  await app.close()
})
