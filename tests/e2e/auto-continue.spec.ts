import { expect, test, type Page } from '@playwright/test'
import { CONTINUE_PROMPT } from '../../src/main/auto-continue'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { PipeMessage } from '../../src/shared/protocol'
import { DIM, promptBox, show } from './claude-screen'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const OFF = { sound: false, flash: false, tab: true }
// the mark is what these tests check; keep the desktop quiet while they run, and leave unread marks out of it
const settings = (autoContinue: boolean): object => ({
  ...FAKE_CLAUDE_SETTINGS,
  claude: { ...FAKE_CLAUDE_SETTINGS.claude, autoContinue },
  notifications: { autoUnread: false, permission: OFF, question: OFF, done: OFF, bell: OFF }
})
/** what the StopFailure hook sends for a response cut off mid-stream */
const cutOff = (tabId: string): PipeMessage => ({ v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done', error: 'server_error' })
const turn = (tabId: string): PipeMessage => ({ v: 1, type: 'turn', tabId, sessionId: SID, cwd: null })
const EMPTY_PROMPT = promptBox(DIM('Try "fix lint errors"'))

/** the Claude tab goes to the background behind a shell tab */
async function openShellTab(page: Page, claudeTab: string, cwd: string): Promise<void> {
  await page.evaluate((dir) => window.ct.openTab({ kind: 'shell', cwd: dir }), cwd)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, claudeTab)
}

/**
 * The fake claude's output on a line of its own, then the shell's prompt: the echo of the command already holds the word,
 * and a long line typed before the shell reads it is cut (macOS keeps 1024 bytes of a line until then)
 */
async function shellReady(page: Page, tabId: string): Promise<void> {
  // the prompt is the user's own in a Claude tab (runner@host:…$ on the Linux runner), so any text on a later line
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/(^|\n)fake-claude[^\n]*\n[^\n]*\S/)
}

async function launched(autoContinue: boolean) {
  const l = await launchClaudeTab(settings(autoContinue))
  await shellReady(l.page, l.tabId)
  return { ...l, claudeTab: l.page.locator(`[data-tab-id="${l.tabId}"]`) }
}

test('with Claude Code\'s prompt empty, a cut-off response is continued in its tab, which does not call the user', async () => {
  const { app, page, tabId, work, pipeName, claudeTab } = await launched(true)
  await show(page, tabId, EMPTY_PROMPT, 'step1')
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect.poll(() => bufferText(page, tabId), { timeout: 20_000 }).toContain(CONTINUE_PROMPT)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('with auto-continue off, a cut-off response marks its tab as the end of a turn does', async () => {
  const { app, page, tabId, work, pipeName, claudeTab } = await launched(false)
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await app.close()
})

test('keys pressed in the tab during the turn, as answers to Claude\'s questions are, do not stop the continue', async () => {
  const { app, page, tabId, work, pipeName, claudeTab } = await launched(true)
  expect(await sendPipeMessage(pipeName, turn(tabId))).toEqual({ ok: true })
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('2')
  await page.keyboard.press('Enter')
  await show(page, tabId, EMPTY_PROMPT, 'step1')
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect.poll(() => bufferText(page, tabId), { timeout: 20_000 }).toContain(CONTINUE_PROMPT)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('the user\'s text in Claude Code\'s prompt is left alone: nothing is typed, and the tab calls the user', async () => {
  const { app, page, tabId, work, pipeName, claudeTab } = await launched(true)
  await show(page, tabId, promptBox('half a question'), 'step1')
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/, { timeout: 20_000 })
  expect(await bufferText(page, tabId)).not.toContain(CONTINUE_PROMPT)
  await app.close()
})

test('without Claude Code\'s prompt on screen nothing is typed, and the tab calls the user', async () => {
  const { app, page, tabId, work, pipeName, claudeTab } = await launched(true)
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/, { timeout: 20_000 })
  expect(await bufferText(page, tabId)).not.toContain(CONTINUE_PROMPT)
  await app.close()
})

test('the mouse wheel and PgUp during the pause, reading the reply, do not cancel the continue', async () => {
  const { app, page, tabId, work, pipeName, claudeTab } = await launched(true)
  await show(page, tabId, EMPTY_PROMPT, 'step1')
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  // what xterm.js sends to an app that tracks the mouse (Claude Code's fullscreen mode), as the keys and the wheel do
  for (const scroll of ['\x1b[<64;40;12M', '\x1b[<65;40;12M', '\x1b[5~', '\x1b[1;5F']) {
    await page.evaluate(([id, data]) => window.ct.writePty(id, data), [tabId, scroll] as const)
  }
  await expect.poll(() => bufferText(page, tabId), { timeout: 20_000 }).toContain(CONTINUE_PROMPT)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('a continue armed when the tab is restarted is dropped: nothing is typed into the new session, and it calls nobody', async () => {
  const { app, page, tabId, work, pipeName, claudeTab } = await launched(true)
  await show(page, tabId, EMPTY_PROMPT, 'step1')
  await openShellTab(page, tabId, work)
  expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.restartTab(id, true), tabId)
  // the restart clears the terminal, so a continue still armed would find no prompt, give up and mark the tab
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).not.toContain('step1')
  await shellReady(page, tabId)
  await page.waitForTimeout(6000)
  expect(await bufferText(page, tabId)).not.toContain(CONTINUE_PROMPT)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await app.close()
})
