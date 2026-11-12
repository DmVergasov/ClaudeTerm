import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { TaskList } from '../../src/shared/task-list'
import { bashResultLine, toolUseLine } from '../fixtures/transcript'
import { FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, makeDataDir, TEST_SHELL, writeTranscript } from './helpers'

const SID_A = '3f1e2d4c-5b6a-4789-8abc-0d1e2f3a4b5c'
const SID_B = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d'
const SID_C = 'c0ffee00-1234-4abc-9def-0123456789ab'
const PLAN_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const PLAN_REL = 'docs/superpowers/plans/2026-10-20-csv-export.md'

const release: TaskList = {
  title: 'Release prep',
  tasks: [
    { title: 'Tag the release', status: 'completed' },
    { title: 'Write the changelog', status: 'in_progress' },
    { title: 'Publish the installers', status: 'pending' }
  ]
}
const almostDone: TaskList = { title: 'Release prep', tasks: [{ title: 'Tag the release', status: 'completed' }, { title: 'Write the changelog', status: 'in_progress' }] }
const allDone: TaskList = { title: 'Release prep', tasks: [{ title: 'Tag the release', status: 'completed' }, { title: 'Write the changelog', status: 'completed' }] }

const session = (pipeName: string, tabId: string, sessionId: string, source: 'startup' | 'resume' | 'clear' | 'fork', transcriptPath: string | null = null) =>
  sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source, transcriptPath })
const setList = (pipeName: string, tabId: string, list: TaskList | null) => sendPipeMessage(pipeName, { v: 1, type: 'task_list', tabId, list })
/** the lists in task-lists.json by session id, [] until the file is written */
function storedLists(dataDir: string): Record<string, TaskList> {
  const file = join(dataDir, 'task-lists.json')
  if (!existsSync(file)) return {}
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { list: TaskList }>
  return Object.fromEntries(Object.entries(raw).map(([id, v]) => [id, v.list]))
}
const segment = (page: Page) => page.locator('#statusbar .status-plan')

/** an invented plan run in a temp folder: two tasks, the first one complete in the ledger */
function planRun(): string {
  const repo = join(mkdtempSync(join(tmpdir(), 'ct-plan-')), 'repo')
  const ws = join(repo, '.superpowers', 'sdd', '2026-10-20-csv-export')
  const ledger = join(ws, 'progress.md')
  mkdirSync(join(repo, 'docs', 'superpowers', 'plans'), { recursive: true })
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(repo, PLAN_REL), ['# CSV Export Implementation Plan', '', '### Task 1: Report rows to CSV lines', '', '- [ ] **Step 1: Write the failing test**', '', '### Task 2: Escape quotes and separators', '', '- [ ] **Step 1: Write the failing test**', ''].join('\n'))
  writeFileSync(join(ws, 'plan-path'), PLAN_REL)
  writeFileSync(ledger, '# Progress\n\nTask 1: complete (commits a1b2c3d..d4e5f6a, review clean)\n')
  return ws
}

/** a session whose transcript shows Claude starting the ledger workspace of a plan run */
async function startPlan(pipeName: string, tabId: string, ws: string): Promise<void> {
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${PLAN_SID}.jsonl`)
  writeFileSync(transcriptPath, [
    toolUseLine('toolu_1', 'Bash', { command: `bash /p/sdd-workspace ${PLAN_REL}` }),
    bashResultLine('toolu_1', ws + '\n')
  ].join('\n') + '\n')
  expect(await session(pipeName, tabId, PLAN_SID, 'startup', transcriptPath)).toEqual({ ok: true })
}

test('set_task_list shows the list in the status bar and the task box, and task_list_get answers with it; null removes it', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  expect(await setList(pipeName, tabId, release)).toEqual({ ok: true, info: 'Task list updated: 1 of 3 done.' })
  const seg = segment(page)
  await expect(seg.locator('.status-text')).toHaveText('1/3 · Write the changelog')
  await expect(seg).toHaveAttribute('title', 'Release prep — 1 of 3 done. Click for the task list')
  await seg.click()
  const box = page.locator('#plan-list')
  await expect(box.locator('.plan-task-title')).toHaveText(['Tag the release', 'Write the changelog', 'Publish the installers'])
  await expect(box.locator('.plan-mark')).toHaveText(['✓', '●', '○'])
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'task_list_get', tabId })).toEqual({
    ok: true,
    info: 'Release prep: 1 of 3 done\n1. [completed] Tag the release\n2. [in_progress] Write the changelog\n3. [pending] Publish the installers'
  })
  expect(await setList(pipeName, tabId, null)).toEqual({ ok: true, info: 'Task list removed.' })
  await expect(seg).toHaveCount(0)
  await expect(box).toBeHidden()
  await app.close()
})

test('a list with no task in progress shows its count alone, not a check mark', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  const waiting: TaskList = { title: 'Release prep', tasks: [{ title: 'Tag the release', status: 'completed' }, { title: 'Write the changelog', status: 'pending' }, { title: 'Publish the installers', status: 'pending' }] }
  expect(await setList(pipeName, tabId, waiting)).toEqual({ ok: true, info: 'Task list updated: 1 of 3 done.' })
  await expect(segment(page).locator('.status-text')).toHaveText('1/3')
  await app.close()
})

test('an unfinished list shows in place of a superpowers plan in progress; once the list is removed, the plan shows again', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const run = planRun()
  await startPlan(pipeName, tabId, run)
  const seg = segment(page)
  await expect(seg.locator('.status-text')).toHaveText('1/2 · Escape quotes and separators')
  // the agent set its own list on purpose (work across several plans): it shows, not the plan
  expect(await setList(pipeName, tabId, almostDone)).toEqual({ ok: true, info: 'Task list updated: 1 of 2 done.' })
  await expect(seg.locator('.status-text')).toHaveText('1/2 · Write the changelog')
  await expect(seg).toHaveAttribute('title', 'Release prep — 1 of 2 done. Click for the task list')
  expect(await setList(pipeName, tabId, null)).toEqual({ ok: true, info: 'Task list removed.' })
  await expect(seg.locator('.status-text')).toHaveText('1/2 · Escape quotes and separators')
  await expect(seg).toHaveAttribute('title', 'CSV Export — 1 of 2 done. Click for the task list')
  rmSync(run, { recursive: true, force: true })
  await app.close()
})

test('/clear keeps an unfinished list on screen under the new conversation only; a finished list stays with the old one', async () => {
  const { app, page, tabId, dataDir, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  expect(await setList(pipeName, tabId, almostDone)).toEqual({ ok: true, info: 'Task list updated: 1 of 2 done.' })
  expect(await session(pipeName, tabId, SID_B, 'clear')).toEqual({ ok: true })
  const seg = segment(page)
  await expect(seg.locator('.status-text')).toHaveText('1/2 · Write the changelog')
  await expect.poll(() => storedLists(dataDir)).toEqual({ [SID_B]: almostDone })

  expect(await setList(pipeName, tabId, allDone)).toEqual({ ok: true, info: 'Task list updated: 2 of 2 done.' })
  expect(await session(pipeName, tabId, SID_C, 'clear')).toEqual({ ok: true })
  await expect(seg).toHaveCount(0)
  await expect.poll(() => storedLists(dataDir)).toEqual({ [SID_B]: allDone })
  await app.close()
})

test('Restore shows the restored tab the list of its conversation once its session starts', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [{ kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'mine', claudeSessionId: SID_A }] }))
  writeFileSync(join(dataDir, 'task-lists.json'), JSON.stringify({ [SID_A]: { list: almostDone, changedAt: Date.now() } }))
  const { app, page, pipeName } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await session(pipeName, tabId, SID_A, 'resume')).toEqual({ ok: true })
  await expect(segment(page).locator('.status-text')).toHaveText('1/2 · Write the changelog')
  await app.close()
})

test('Restore forks again a fork without a conversation of its own, and it shows its head list; the file holds it under both conversations', async () => {
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const head = { kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'head', claudeSessionId: SID_A }
  const fork = { kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'fork', claudeSessionId: SID_B, fork: { of: 0, from: SID_A } }
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [head, fork] }))
  writeFileSync(join(dataDir, 'task-lists.json'), JSON.stringify({ [SID_A]: { list: almostDone, changedAt: Date.now() } }))
  const { app, page, pipeName } = await launchApp({ dataDir, env: { CLAUDE_CONFIG_DIR: config } })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const f = (await page.evaluate(() => window.__ct!.tabIds()))[1]!
  await page.evaluate((id) => window.ct.activateTab(id), f)
  // the fork has no conversation of its own, so it starts a new one forked from the head's
  expect(await session(pipeName, f, SID_C, 'fork')).toEqual({ ok: true })
  await expect(segment(page).locator('.status-text')).toHaveText('1/2 · Write the changelog')
  await expect.poll(() => storedLists(dataDir)).toEqual({ [SID_A]: almostDone, [SID_C]: almostDone })
  await app.close()
})

test('a fork shows the list of the conversation it forked, and the file holds it under both conversations', async () => {
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page, dataDir, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const head = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await session(pipeName, head, SID_A, 'startup', writeTranscript(config, work, SID_A))).toEqual({ ok: true })
  expect(await setList(pipeName, head, almostDone)).toEqual({ ok: true, info: 'Task list updated: 1 of 2 done.' })

  await page.evaluate((id) => window.ct.forkTab(id), head)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const fork = (await page.evaluate(() => window.__ct!.tabIds())).find((id) => id !== head)!
  expect(await session(pipeName, fork, SID_B, 'fork')).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.activateTab(id), fork)
  await expect(page.locator('#statusbar .status-plan .status-text')).toHaveText('1/2 · Write the changelog')
  await expect.poll(() => storedLists(dataDir)).toEqual({ [SID_A]: almostDone, [SID_B]: almostDone })
  await app.close()
})

test('session_end hides the list; a session message for the same conversation brings it back', async () => {
  const { app, page, tabId, dataDir, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  expect(await setList(pipeName, tabId, almostDone)).toEqual({ ok: true, info: 'Task list updated: 1 of 2 done.' })
  await expect(segment(page)).toHaveCount(1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session_end', tabId, sessionId: SID_A })).toEqual({ ok: true })
  await expect(segment(page)).toHaveCount(0)
  expect(await session(pipeName, tabId, SID_A, 'resume')).toEqual({ ok: true })
  await expect(segment(page).locator('.status-text')).toHaveText('1/2 · Write the changelog')
  await expect.poll(() => storedLists(dataDir)).toEqual({ [SID_A]: almostDone })
  await app.close()
})

test('Clear in the task box removes an agent list from the status bar, the file and task_list_get', async () => {
  const { app, page, tabId, dataDir, pipeName } = await launchClaudeTab()
  expect(await session(pipeName, tabId, SID_A, 'startup')).toEqual({ ok: true })
  expect(await setList(pipeName, tabId, almostDone)).toEqual({ ok: true, info: 'Task list updated: 1 of 2 done.' })
  const seg = segment(page)
  await seg.click()
  const box = page.locator('#plan-list')
  await expect(box.locator('.plan-clear')).toHaveText('Clear')
  await box.locator('.plan-clear').click()
  await expect(box).toBeHidden()
  await expect(seg).toHaveCount(0)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'task_list_get', tabId })).toEqual({ ok: true, info: 'No task list.' })
  await expect.poll(() => storedLists(dataDir)).toEqual({})
  await app.close()
})

test('the task box of a superpowers plan has no Clear button, even with a finished agent list kept behind it', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const run = planRun()
  await startPlan(pipeName, tabId, run)
  expect(await setList(pipeName, tabId, allDone)).toEqual({ ok: true, info: 'Task list updated: 2 of 2 done.' })
  const seg = segment(page)
  await expect(seg.locator('.status-text')).toHaveText('1/2 · Escape quotes and separators')
  await seg.click()
  const box = page.locator('#plan-list')
  await expect(box.locator('.plan-title')).toHaveText('CSV Export')
  await expect(box.locator('.plan-clear')).toHaveCount(0)
  rmSync(run, { recursive: true, force: true })
  await app.close()
})

test('of a finished plan and a finished list, the one that finished last shows', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const run = planRun()
  await startPlan(pipeName, tabId, run)
  // the list finishes while the plan is still in progress: the plan shows
  expect(await setList(pipeName, tabId, allDone)).toEqual({ ok: true, info: 'Task list updated: 2 of 2 done.' })
  const seg = segment(page)
  await expect(seg).toHaveAttribute('title', 'CSV Export — 1 of 2 done. Click for the task list')
  // the plan finishes after the list: the plan shows
  appendFileSync(join(run, 'progress.md'), 'Task 2: complete (commits d4e5f6a..b7c8d9e, review clean)\n')
  await expect(seg).toHaveAttribute('title', 'CSV Export — 2 of 2 done. Click for the task list')
  // the agent's list finishes last, as a new list: it shows over the finished plan
  const ship: TaskList = { title: 'Ship notes', tasks: [{ title: 'Write the notes', status: 'completed' }] }
  expect(await setList(pipeName, tabId, ship)).toEqual({ ok: true, info: 'Task list updated: 1 of 1 done.' })
  await expect(seg).toHaveAttribute('title', 'Ship notes — 1 of 1 done. Click for the task list')
  rmSync(run, { recursive: true, force: true })
  await app.close()
})

test('set_task_list and get_task_list work only in a Claude tab', async () => {
  const { app, page, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await setList(pipeName, tabId, almostDone)).toEqual({ ok: false, error: 'set_task_list works only in a ClaudeTerm Claude tab' })
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'task_list_get', tabId })).toEqual({ ok: false, error: 'get_task_list works only in a ClaudeTerm Claude tab' })
  await app.close()
})
