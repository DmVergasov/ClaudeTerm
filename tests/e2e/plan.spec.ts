import { expect, test } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { bashResultLine, toolUseLine } from '../fixtures/transcript'
import { KEYS, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const PLAN_REL = 'docs/superpowers/plans/2026-10-20-csv-export.md'

/** an invented plan run in a temp folder: four tasks, the first one complete in the ledger */
function planRun(tasks = ['Report rows to CSV lines', 'Escape quotes and separators', 'Export button in the toolbar', 'Save dialog and file writing']): { root: string; ws: string; ledger: string; planFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'ct-plan-'))
  const repo = join(root, 'repo')
  const planFile = join(repo, PLAN_REL)
  const ws = join(repo, '.superpowers', 'sdd', '2026-10-20-csv-export')
  const ledger = join(ws, 'progress.md')
  mkdirSync(join(repo, 'docs', 'superpowers', 'plans'), { recursive: true })
  mkdirSync(ws, { recursive: true })
  writeFileSync(planFile, [
    '# CSV Export Implementation Plan', '',
    ...tasks.flatMap((t, i) => [`### Task ${i + 1}: ${t}`, '', '- [ ] **Step 1: Write the failing test**', ''])
  ].join('\n'))
  writeFileSync(join(ws, 'plan-path'), PLAN_REL)
  writeFileSync(ledger, '# Progress\n\nTask 1: complete (commits a1b2c3d..d4e5f6a, review clean)\n')
  return { root, ws, ledger, planFile }
}

/** a session whose transcript shows Claude starting the ledger workspace of a plan run */
async function startPlan(pipeName: string, tabId: string, ws: string): Promise<void> {
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, [
    toolUseLine('toolu_1', 'Bash', { command: `bash /p/sdd-workspace ${PLAN_REL}` }),
    bashResultLine('toolu_1', ws + '\n')
  ].join('\n') + '\n')
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
}

test('a plan run shows its progress, follows the ledger and ends with ✓ when its workspace is deleted', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const run = planRun()
  await startPlan(pipeName, tabId, run.ws)
  const seg = page.locator('#statusbar .status-plan')
  await expect(seg).toHaveText('1/4 · Escape quotes and separators')
  await expect(seg).toHaveAttribute('title', 'CSV Export — 1 of 4 done. Click for the task list')
  appendFileSync(run.ledger, 'Task 2: complete (commits d4e5f6a..b7c8d9e, review clean)\n')
  await expect(seg).toHaveText('2/4 · Export button in the toolbar')
  rmSync(run.ws, { recursive: true, force: true })
  await expect(seg).toHaveText('✓ 4/4')
  await app.close()
})

test('the plan segment goes when the session ends', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  await startPlan(pipeName, tabId, planRun().ws)
  await expect(page.locator('#statusbar .status-plan')).toHaveCount(1)
  await page.locator('#statusbar .status-plan').click()
  await expect(page.locator('#plan-list')).toBeVisible()
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session_end', tabId, sessionId: SID })).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-plan')).toHaveCount(0)
  await expect(page.locator('#plan-list')).toBeHidden()
  await app.close()
})

test('a click on the segment lists the tasks, and the open list follows the ledger', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const run = planRun()
  await startPlan(pipeName, tabId, run.ws)
  await page.locator('#statusbar .status-plan').click()
  const list = page.locator('#plan-list')
  await expect(list).toBeVisible()
  await expect(list.locator('.plan-title')).toHaveText('CSV Export')
  await expect(list.locator('.plan-count')).toHaveText('1 of 4 done')
  await expect(list.locator('.plan-task-title')).toHaveText(['Report rows to CSV lines', 'Escape quotes and separators', 'Export button in the toolbar', 'Save dialog and file writing'])
  await expect(list.locator('.plan-mark')).toHaveText(['✓', '●', '○', '○'])
  await expect(list.locator('.plan-task').nth(1)).toHaveClass(/current/)
  appendFileSync(run.ledger, 'Task 2: complete\n')
  await expect(list.locator('.plan-count')).toHaveText('2 of 4 done')
  await expect(list.locator('.plan-mark')).toHaveText(['✓', '✓', '●', '○'])
  await app.close()
})

test('Esc closes the list without reaching Claude and gives the terminal the focus; a second click, a click outside and a tab switch close it too', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  await startPlan(pipeName, tabId, planRun().ws)
  const seg = page.locator('#statusbar .status-plan')
  const list = page.locator('#plan-list')
  await seg.click()
  await page.locator('.terminal-host:visible .xterm-helper-textarea').focus()
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  // the shell may report the focus (ESC [ I, ESC [ O) when the terminal takes it; a lone ESC would be the Esc key
  const sent = await page.evaluate((id) => window.__ct!.ptyInput!(id), tabId)
  expect(sent.replace(/\x1b\[[IO]/g, '')).not.toContain('\x1b')
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.xterm')))).toBe(true)
  await seg.click()
  await expect(list).toBeVisible()
  await seg.click()
  await expect(list).toBeHidden()
  await seg.click()
  await page.locator('.terminal-host:visible').click()
  await expect(list).toBeHidden()
  await seg.click()
  await page.keyboard.press(KEYS.newTab)
  await expect(list).toBeHidden()
  // the new tab is a shell tab: a shell has no plan segment
  await expect(page.locator('#statusbar .status-plan')).toHaveCount(0)
  await app.close()
})

test('an open list stays above the status bar when the status bar rebuilds its segments', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const run = planRun()
  await startPlan(pipeName, tabId, run.ws)
  await page.locator('#statusbar .status-plan').click()
  const list = page.locator('#plan-list')
  await expect(list).toBeVisible()
  // new segments make the status bar replace the segment the list was opened from
  expect(await sendPipeMessage(pipeName, {
    v: 1, type: 'status', tabId, sessionId: SID,
    model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh',
    context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 }, fiveHour: null, sevenDay: null
  })).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-model')).toHaveText('Opus 5.5 · xhigh')
  appendFileSync(run.ledger, 'Task 2: complete\n')
  await expect(list.locator('.plan-count')).toHaveText('2 of 4 done')
  const box = (await list.boundingBox())!
  const bar = (await page.locator('#statusbar').boundingBox())!
  const win = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(win.width)
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y)
  await app.close()
})

test('a very long task title is cut with an ellipsis inside the status bar', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const long = 'Rework the whole export pipeline so rows, quotes, separators, encodings and the save dialog all share one streaming writer'
  await startPlan(pipeName, tabId, planRun(['First task', long]).ws)
  const seg = page.locator('#statusbar .status-plan')
  await expect(seg).toContainText('1/2 · Rework the whole export')
  const m = await page.evaluate(() => {
    const s = document.querySelector('#statusbar .status-plan')!.getBoundingClientRect()
    const el = document.querySelector('#statusbar .status-plan') as HTMLElement
    return { scroll: el.scrollWidth, client: el.clientWidth, right: s.right, barRight: document.querySelector('#statusbar')!.getBoundingClientRect().right }
  })
  expect(m.scroll).toBeGreaterThan(m.client)
  expect(m.right).toBeLessThanOrEqual(m.barRight)
  await app.close()
})
