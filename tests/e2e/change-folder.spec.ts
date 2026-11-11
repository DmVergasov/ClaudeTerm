import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathKey } from '../../src/main/path-key'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { StatusMessage } from '../../src/shared/protocol'
import { REMOTE_COPY } from '../../src/shared/remote'
import type { TaskList } from '../../src/shared/task-list'
import { bashResultLine, toolUseLine } from '../fixtures/transcript'
import { bufferText, FAKE_CLAUDE_SETTINGS, gitRepo, KEYS, launchApp, type Launched, PNG_1x1, PROMPT, typeInTerminal, writeTranscript } from './helpers'
import { closePaired, pairedApps } from './device-pair'

test.afterEach(closePaired)

// Change folder, end to end: the tab's card, Changes, status, note and Docs of the old folder are gone after the move, and
// the new folder works (its image shows, and the stand-in starts there without a --resume).

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
/** how long the window takes to show the reset: the afterEach limit is generous, the poll waits longer than a frame */
const SLOW = { timeout: 45_000 }
const PLAN_REL = 'docs/superpowers/plans/2026-10-20-csv-export.md'

/** an invented plan run in a temp folder (as plan.spec makes one): two tasks, the first complete in the ledger; returns its workspace */
function planRun(): string {
  const root = mkdtempSync(join(tmpdir(), 'ct-plan-'))
  const repo = join(root, 'repo')
  const ws = join(repo, '.superpowers', 'sdd', '2026-10-20-csv-export')
  mkdirSync(join(repo, 'docs', 'superpowers', 'plans'), { recursive: true })
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(repo, PLAN_REL), ['# CSV Export Implementation Plan', '', '### Task 1: Report rows to CSV lines', '', '### Task 2: Escape quotes and separators', ''].join('\n'))
  writeFileSync(join(ws, 'plan-path'), PLAN_REL)
  writeFileSync(join(ws, 'progress.md'), '# Progress\n\nTask 1: complete (commits a1b2c3d..d4e5f6a, review clean)\n')
  return ws
}

/** a transcript in which Claude starts the plan's ledger workspace: the transcript feed reports it, and the status bar shows the plan */
function planTranscript(ws: string, file: string): string {
  writeFileSync(file, [toolUseLine('toolu_1', 'Bash', { command: `bash /p/sdd-workspace ${PLAN_REL}` }), bashResultLine('toolu_1', ws + '\n')].join('\n') + '\n')
  return file
}

const statusMsg = (tabId: string): StatusMessage => ({
  v: 1,
  type: 'status',
  tabId,
  sessionId: SID,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: null,
  fiveHour: null,
  sevenDay: null
})

test('Change folder empties the card, Changes, status, note and Docs of the old folder; the new folder shows its own', async () => {
  test.setTimeout(180_000)
  // a clean home and Claude configuration: the test never reads or writes the machine's own
  const home = mkdtempSync(join(tmpdir(), 'ct-home-'))
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }
  const repo = gitRepo()
  writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\n')
  const other = mkdtempSync(join(tmpdir(), 'ct-other-'))
  // the panels narrow the terminal rather than lie over it, so the clicks of this test reach it in a small window too
  const { app, page, pipeName } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, sidePanel: { noRoom: 'narrow' } }, args: ['--claude', repo], env })
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!

    // a conversation with a transcript, a status with a model, a card, a document and a note, all of the old folder
    const transcript = planTranscript(planRun(), join(home, 'plan-transcript.jsonl'))
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath: transcript })).toEqual({ ok: true })
    expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
    const shot = join(repo, 'shot.png')
    writeFileSync(shot, PNG_1x1)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: shot, caption: null })).toEqual({ ok: true })
    const doc = join(repo, 'spec.md')
    writeFileSync(doc, '# Spec\n\nBody text.\n')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_document', tabId, path: doc, title: null })).toMatchObject({ ok: true })
    // the note is typed in the window, as a person does: the window's text is its own, and main keeps it with the conversation
    await page.locator('#sheet-header .tab-note-toggle').click()
    await expect(page.locator('#note .note-text')).toBeFocused()
    await page.keyboard.type('Goal: payments')

    const bar = page.locator('#statusbar')
    await expect(bar.locator('.status-model .status-text')).toHaveText('Opus 5.5')
    await expect(bar.locator('.status-model .status-pill')).toHaveText('xhigh')
    await expect(page.locator('#image-panel .card')).toHaveCount(1)
    await expect(page.locator('#note .note-text')).toHaveValue('Goal: payments')
    await expect(page.locator('.doc-md h1')).toHaveText('Spec')
    // Changes lists the edited file of the old folder
    // the shortcut goes to the terminal, not to the note's text in focus: the terminal's input takes the focus without a
    // click, as the Docs panel can lie over the terminal in a small window
    await page.locator('.terminal-host:visible .xterm-helper-textarea').focus()
    await expect(page.locator('.terminal-host:visible .xterm-helper-textarea')).toBeFocused()
    await page.keyboard.press(KEYS.changes)
    await page.locator('.review-seg-btn[data-scope="uncommitted"]').click()
    await expect(page.locator('.review-file')).not.toHaveCount(0, SLOW)

    // the plan of the stand-in's run shows in the status bar, and the stand-in has printed its line once
    await expect(page.locator('#statusbar .status-plan')).toHaveCount(1, SLOW)
    const printed = async () => (await bufferText(page, tabId)).split('\n').filter((l) => /^fake-claude\b/.test(l.trim())).length
    await expect.poll(printed, SLOW).toBe(1)
    // a marker typed into the tab's terminal: a restart clears the terminal, so the marker is gone after the move
    await typeInTerminal(page, 'echo before-move')
    await expect.poll(() => bufferText(page, tabId), SLOW).toContain('before-move')

    expect(await page.evaluate(([id, dir]) => window.ct.changeFolder(id, dir), [tabId, other] as [string, string])).toEqual({ ok: true })

    // the old folder's state is gone on the window
    await expect(page.locator('#image-panel .card')).toHaveCount(0, SLOW)
    await expect(page.locator('.review-file')).toHaveCount(0, SLOW)
    await expect(page.locator('#statusbar .status-plan')).toHaveCount(0, SLOW)
    await expect(bar.locator('.status-model')).toBeHidden(SLOW)
    await expect(page.locator('#note .note-card')).toBeHidden(SLOW)
    // the Docs panel has no document left, so it is not offered any more
    await expect(page.locator('#sheet-header .tab-docs-toggle')).toBeHidden(SLOW)
    // the stand-in starts again in the new folder, with no conversation to resume: the restart clears the terminal, so the
    // new folder shows its one line, and that line has no --resume
    await expect.poll(() => bufferText(page, tabId), SLOW).not.toContain('before-move')
    await expect.poll(printed, SLOW).toBe(1)
    expect(await bufferText(page, tabId)).not.toContain('--resume')
    // the note of the old folder is gone: the note opens empty
    await page.locator('#sheet-header .tab-note-toggle').click()
    await expect(page.locator('#note .note-text')).toHaveValue('', SLOW)

    // a picture shown in the new folder shows there
    const shot2 = join(other, 'shot.png')
    writeFileSync(shot2, PNG_1x1)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: shot2, caption: null })).toEqual({ ok: true })
    await expect(page.locator('#image-panel .card')).toHaveCount(1, SLOW)
  } finally {
    await app.close()
  }
})

test('Change folder takes the task list of the old folder off the status bar; a new conversation in the new folder shows none of it', async () => {
  test.setTimeout(180_000)
  const home = mkdtempSync(join(tmpdir(), 'ct-home-'))
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }
  const repo = gitRepo()
  const other = mkdtempSync(join(tmpdir(), 'ct-other-'))
  const { app, page, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', repo], env })
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
    const list: TaskList = { title: 'Release prep', tasks: [{ title: 'Tag the release', status: 'completed' }, { title: 'Write the changelog', status: 'in_progress' }] }
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'task_list', tabId, list })).toEqual({ ok: true, info: 'Task list updated: 1 of 2 done.' })
    const seg = page.locator('#statusbar .status-plan')
    await expect(seg.locator('.status-text')).toHaveText('1/2 · Write the changelog')

    expect(await page.evaluate(([id, dir]) => window.ct.changeFolder(id, dir), [tabId, other] as [string, string])).toEqual({ ok: true })
    await expect(seg).toHaveCount(0, SLOW)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'task_list_get', tabId })).toEqual({ ok: true, info: 'No task list.' })

    // the moved tab starts a conversation: the list of the old folder moves with nothing
    const NEXT_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7d9'
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: NEXT_SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
    await expect(seg).toHaveCount(0)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'task_list_get', tabId })).toEqual({ ok: true, info: 'No task list.' })
  } finally {
    await app.close()
  }
})

// the dialog: a tab's menu opens it, the folders are the tab device's own, and the window shows what the device answered

/** the tab's folder as its title attribute ends with it (the window's own tab shows `title\nfolder`), by pathKey */
const folderOf = (page: Page, id: string) => page.evaluate((tab) => {
  const title = document.querySelector(`[data-tab-id="${tab}"]`)?.getAttribute('title') ?? ''
  return title.split('\n').pop() ?? ''
}, id).then((folder) => pathKey(folder))

/** an app with a shell tab in a fresh work folder (with a subfolder 'sub'), and a temp home holding one conversation in 'proj' */
async function shellApp(): Promise<Launched & { home: string; config: string; work: string; tabId: string }> {
  const home = mkdtempSync(join(tmpdir(), 'ct-home-'))
  const config = join(home, '.claude')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  mkdirSync(join(work, 'sub'))
  mkdirSync(join(home, 'proj'))
  writeTranscript(config, join(home, 'proj'), SID)
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config } })
  const tab = await launched.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  if (!tab) throw new Error('the shell tab did not open')
  return { ...launched, home, config, work, tabId: tab.id }
}

/** right-clicks a tab and picks Change folder…: the dialog is open */
async function openDialog(page: Page, tabId: string): Promise<void> {
  await page.locator(`[data-tab-id="${tabId}"]`).click({ button: 'right' })
  await page.locator('.menu-item', { hasText: REMOTE_COPY.changeFolder }).click()
  await expect(page.locator('.folder-dialog')).toBeVisible()
}

test('Change folder… restarts a shell tab in the folder picked in the dialog', async () => {
  test.setTimeout(180_000)
  const { app, page, home, work, tabId } = await shellApp()
  try {
    await typeInTerminal(page, 'echo before-move')
    await expect.poll(() => bufferText(page, tabId), SLOW).toContain('before-move')

    await openDialog(page, tabId)
    await expect(page.locator('.folder-title')).toHaveText(REMOTE_COPY.changeFolderTitle)
    await expect(page.locator('.folder-recent-label')).toHaveText(/^Recent on /)
    await expect(page.locator('.folder-recent .folder-item')).toHaveText(join(home, 'proj'))
    await page.locator('.folder-list .folder-item', { hasText: /^sub$/ }).click()
    await expect(page.locator('.folder-path')).toHaveValue(join(work, 'sub'))
    await page.locator('.folder-open').click()
    await expect(page.locator('.folder-dialog')).toBeHidden(SLOW)

    // the tab shows the picked folder, and its terminal is a new process's: the old output is gone, a new prompt shows
    expect(await folderOf(page, tabId)).toBe(pathKey(join(work, 'sub')))
    await expect.poll(() => bufferText(page, tabId), SLOW).not.toContain('before-move')
    await expect.poll(() => bufferText(page, tabId), SLOW).toMatch(PROMPT)
  } finally {
    await app.close()
  }
})

test('a folder that does not exist gives a message in the dialog', async () => {
  test.setTimeout(180_000)
  const { app, page, work, tabId } = await shellApp()
  try {
    await openDialog(page, tabId)
    await page.locator('.folder-path').fill(join(work, 'nope'))
    await page.keyboard.press('Enter')
    await expect(page.locator('.folder-error')).toHaveText(REMOTE_COPY.folderMissing, SLOW)
    await expect(page.locator('.folder-dialog')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('Escape closes the dialog, the tab keeps its folder, and the keyboard goes back to the terminal', async () => {
  test.setTimeout(180_000)
  const { app, page, work, tabId } = await shellApp()
  try {
    await openDialog(page, tabId)
    await expect(page.locator('.folder-path')).toBeFocused()
    await page.locator('.folder-path').press('Escape')
    await expect(page.locator('#folder-dialog')).toBeHidden()
    await expect(page.locator('.terminal-host:visible .xterm-helper-textarea')).toBeFocused()
    expect(await folderOf(page, tabId)).toBe(pathKey(work))
  } finally {
    await app.close()
  }
})

test('the dialog lists the folders of a folder, up with .., and keeps the recent folders while it is open', async () => {
  test.setTimeout(180_000)
  const { app, page, home, work, tabId } = await shellApp()
  try {
    const sub = join(work, 'sub')
    mkdirSync(join(sub, 'deeper'))
    await openDialog(page, tabId)
    await page.locator('.folder-list .folder-item', { hasText: /^sub$/ }).click()
    await expect(page.locator('.folder-path')).toHaveValue(sub)
    await expect(page.locator('.folder-list .folder-item')).toHaveText(['..', 'deeper'])
    await expect(page.locator('.folder-recent .folder-item')).toHaveText(join(home, 'proj'))

    await page.locator('.folder-list .folder-item', { hasText: /^\.\.$/ }).click()
    await expect(page.locator('.folder-path')).toHaveValue(work)
    await page.locator('.folder-recent .folder-item').click()
    await expect(page.locator('.folder-path')).toHaveValue(join(home, 'proj'))

    await page.locator('.folder-cancel').click()
    await expect(page.locator('#folder-dialog')).toBeHidden()
    expect(await folderOf(page, tabId)).toBe(pathKey(work))
  } finally {
    await app.close()
  }
})

test('B opens a Claude tab on A, then moves it to another folder: a new conversation starts there', async () => {
  test.setTimeout(180_000)
  // A's home holds one conversation in 'proj', so the dialog on B has a recent folder of A
  const homeA = mkdtempSync(join(tmpdir(), 'ct-home-a-'))
  const { a, b } = await pairedApps({ a: { env: { HOME: homeA, USERPROFILE: homeA } } })
  mkdirSync(join(homeA, 'proj'))
  writeTranscript(a.config, join(homeA, 'proj'), SID)
  const other = join(a.work, 'other')
  mkdirSync(other)

  const id = await b.page.evaluate((d) => window.ct.openRemoteTab(d, 'claude', null, null), a.id)
  if (id === null) throw new Error('the remote tab did not open')
  await expect.poll(() => a.page.evaluate((tab) => window.__ct!.tabIds().includes(tab), id), SLOW).toBe(true)
  await expect.poll(async () => (await bufferText(a.page, id!)).split('fake-claude').length, SLOW).toBeGreaterThan(1)

  await b.page.locator(`[data-tab-id="${id}"]`).click({ button: 'right' })
  await b.page.locator('.menu-item', { hasText: REMOTE_COPY.changeFolder }).click()
  await expect(b.page.locator('.folder-title')).toHaveText(REMOTE_COPY.changeFolderOn('Studio'), SLOW)
  await expect(b.page.locator('.folder-recent-label')).toHaveText(REMOTE_COPY.recentOn('Studio'), SLOW)

  // a blank folder is the device's own message; then a typed folder of A is listed and opened
  await b.page.locator('.folder-path').fill('')
  await b.page.keyboard.press('Enter')
  await expect(b.page.locator('.folder-error')).toHaveText(REMOTE_COPY.folderNotAbsolute, SLOW)
  await b.page.locator('.folder-path').fill(other)
  await b.page.keyboard.press('Enter')
  await expect(b.page.locator('.folder-path')).toHaveValue(other, SLOW)
  await b.page.locator('.folder-open').click()
  await expect(b.page.locator('.folder-dialog')).toBeHidden(SLOW)

  // A's tab, and B's view of it, hold the new folder; A's tab started its Claude Code again, with no conversation to resume
  await expect.poll(() => folderOf(a.page, id!), SLOW).toBe(pathKey(other))
  await expect.poll(() => b.page.locator(`[data-tab-id="${id}"]`).getAttribute('title'), SLOW).toContain(other)
  await expect.poll(async () => (await bufferText(a.page, id!)).split('fake-claude').length, SLOW).toBeGreaterThan(1)
  expect(await bufferText(a.page, id!)).not.toContain('--resume')
})

test('after a click on a folder the dialog keeps the keyboard: Tab stays in it, and Escape closes it to the terminal', async () => {
  test.setTimeout(180_000)
  const { app, page, work, tabId } = await shellApp()
  try {
    await openDialog(page, tabId)
    await page.locator('.folder-list .folder-item', { hasText: /^sub$/ }).click()
    await expect(page.locator('.folder-path')).toHaveValue(join(work, 'sub'))
    // the click on a row must not take the keyboard out of the field
    await expect(page.locator('.folder-path')).toBeFocused()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('.folder-dialog'))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.locator('#folder-dialog')).toBeHidden()
    await expect(page.locator('.terminal-host:visible .xterm-helper-textarea')).toBeFocused()
    expect(await folderOf(page, tabId)).toBe(pathKey(work))
  } finally {
    await app.close()
  }
})

test('after a click on a folder, a window shortcut does nothing behind the dialog', async () => {
  test.setTimeout(180_000)
  const { app, page, work, tabId } = await shellApp()
  try {
    await openDialog(page, tabId)
    await page.locator('.folder-list .folder-item', { hasText: /^sub$/ }).click()
    await expect(page.locator('.folder-path')).toHaveValue(join(work, 'sub'))
    // the image panel is hidden at first: the shortcut that shows it must not show it behind the dialog
    await page.keyboard.press(KEYS.images)
    await expect(page.locator('#image-panel')).toHaveClass(/collapsed/)
    await page.keyboard.press('Escape')
    await expect(page.locator('#folder-dialog')).toBeHidden()
    // the same shortcut shows the panel once the dialog is closed
    await page.keyboard.press(KEYS.images)
    await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
  } finally {
    await app.close()
  }
})

test('coming back to the window while the dialog is open leaves the keyboard in the dialog', async () => {
  test.setTimeout(180_000)
  const { app, page, tabId } = await shellApp()
  try {
    await openDialog(page, tabId)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.keyboard.type('xyz')
    await expect(page.locator('.folder-path')).toHaveValue(/xyz$/)
    expect(await bufferText(page, tabId)).not.toContain('xyz')
  } finally {
    await app.close()
  }
})

test('Enter on a missing folder at once, before the first listing answers, still gives the message', async () => {
  test.setTimeout(180_000)
  const { app, page, work, tabId } = await shellApp()
  try {
    await openDialog(page, tabId)
    await page.keyboard.type(join(work, 'nope'))
    await page.keyboard.press('Enter')
    await expect(page.locator('.folder-error')).toHaveText(REMOTE_COPY.folderMissing, SLOW)
    await expect(page.locator('.folder-dialog')).toBeVisible()
  } finally {
    await app.close()
  }
})
