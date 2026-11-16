import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { AttentionMessage, TurnMessage } from '../../src/shared/protocol'
import { claudeRuns, launchAccounts } from './account-helpers'
import { externalCalls, keepingClipboard, launchApp, stubExternal } from './helpers'
import { launchRcTerminal, openRcTab, RC_CLEAN_ENV, RC_SID, rcStatus, typedLines } from './remote-control-helpers'

const LONG = { timeout: 20_000 }

/** the --rc argument of a run: the name after it, null when there is none */
const rcArg = (argv: string[]): string | null => (argv.includes('--rc') ? argv[argv.indexOf('--rc') + 1] ?? null : null)

test('the switch types /remote-control with the tab’s title into Claude Code’s prompt, and off types /remote-control', async () => {
  const t = await launchAccounts({ view: 'terminal', env: RC_CLEAN_ENV })
  try {
    const tabId = await openRcTab(t.page, t.work)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), tabId)
    await expect.poll(() => typedLines(t.log), LONG).toEqual(['/remote-control Fix the parser'])
    // Claude Code connects: its next statusLine carries the id
    expect(await sendPipeMessage(t.pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, false), tabId)
    await expect.poll(() => typedLines(t.log), LONG).toEqual(['/remote-control Fix the parser', '/remote-control'])
  } finally {
    await t.app.close()
  }
})

test('the account flag starts the next Claude tab of the account with --rc and its title, through the real shell; the tabs already open keep theirs', async () => {
  const t = await launchAccounts({ view: 'terminal', env: RC_CLEAN_ENV })
  try {
    const first = await openRcTab(t.page, t.work)
    await t.page.evaluate((id) => window.ct.remoteControlAccount(id, true), first)
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).toBe(true)
    await openRcTab(t.page, t.work)
    await expect.poll(() => claudeRuns(t.log).length, LONG).toBe(2)
    // the shell took the quoted name as one argument
    expect(claudeRuns(t.log).map((r) => rcArg(r.argv))).toEqual([null, 'Fix the parser'])
    await t.page.evaluate((id) => window.ct.remoteControlAccount(id, false), first)
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).toBe(false)
    await openRcTab(t.page, t.work)
    await expect.poll(() => claudeRuns(t.log).length, LONG).toBe(3)
    expect(rcArg(claudeRuns(t.log)[2].argv)).toBeNull()
  } finally {
    await t.app.close()
  }
})

test('the Remote segment is off on a new Claude tab; an id in the status makes it green and marks the tab, and none turns both off', async () => {
  const { app, page, pipeName, tabId } = await launchRcTerminal()
  try {
    const seg = page.locator('#statusbar .status-remote')
    await expect(seg).toHaveAttribute('data-dot', 'off')
    await expect(seg.locator('.status-text')).toHaveText('Remote')
    await expect(seg).toHaveAttribute('title', 'Remote Control is off: click to turn it on')
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await expect(seg).toHaveAttribute('data-dot', 'on')
    await expect(seg).toHaveAttribute('title', 'Remote Control is on: this session is on claude.ai and in the Claude app')
    // the tab bar and the side tab panel each draw the tab's row
    const mark = page.locator('.tab-rc')
    await expect(mark.first()).toBeVisible()
    await expect(mark.first()).toHaveAttribute('title', 'Remote Control is on')
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, null))).toEqual({ ok: true })
    await expect(seg).toHaveAttribute('data-dot', 'off')
    await expect(mark).toHaveCount(0)
    // the attention and the turn messages carry the id too
    const attention: AttentionMessage = { v: 1, type: 'attention', tabId, sessionId: RC_SID, reason: 'done', remote: 'session_01E2eTest' }
    expect(await sendPipeMessage(pipeName, attention)).toEqual({ ok: true })
    await expect(seg).toHaveAttribute('data-dot', 'on')
    const turn: TurnMessage = { v: 1, type: 'turn', tabId, sessionId: RC_SID, remote: null }
    expect(await sendPipeMessage(pipeName, turn)).toEqual({ ok: true })
    await expect(seg).toHaveAttribute('data-dot', 'off')
  } finally {
    await app.close()
  }
})

test('a click on the segment opens the popover 4 px above the bar; Esc closes it, and so does a click outside', async () => {
  const { app, page, pipeName, tabId } = await launchRcTerminal()
  try {
    const seg = page.locator('#statusbar .status-remote')
    const pop = page.locator('.remote-popover')
    await seg.click()
    await expect(pop).toBeVisible()
    await expect(pop.locator('.remote-heading')).toHaveText('Remote Control')
    await expect(pop.locator('.remote-line')).toHaveText('Off · turn it on to reach this session from your phone')
    await expect(pop.locator('input.switch')).not.toBeChecked()
    await expect(pop.locator('.remote-account')).toContainText('Connect every new session of this account')
    await expect(pop.locator('.remote-account-note')).toHaveText('New Claude tabs of Main account start with Remote Control on')
    await expect(pop.locator('.remote-chat-note')).toHaveCount(0)
    const [box, bar] = [await pop.boundingBox(), await page.locator('#statusbar').boundingBox()]
    expect(Math.round(bar!.y - (box!.y + box!.height))).toBe(4)
    expect(Math.round(box!.width)).toBe(340)
    await page.keyboard.press('Escape')
    await expect(pop).toBeHidden()
    await seg.click()
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await expect(pop.locator('.remote-line')).toHaveText('Connected · continue this session in the Claude app or on claude.ai')
    await expect(pop.locator('.remote-open')).toHaveText('Open on claude.ai')
    await page.locator('.terminal-host:visible').click()
    await expect(pop).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a click on the switch types /remote-control with the title; the checkbox sets the account’s flag', async () => {
  const t = await launchAccounts({ view: 'terminal', env: RC_CLEAN_ENV })
  try {
    await openRcTab(t.page, t.work)
    await t.page.locator('#statusbar .status-remote').click()
    await t.page.locator('.remote-popover input.switch').click()
    await expect.poll(() => typedLines(t.log), LONG).toEqual(['/remote-control Fix the parser'])
    await t.page.locator('.remote-popover .remote-account input').click()
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).toBe(true)
    await expect(t.page.locator('.remote-popover .remote-account input')).toBeChecked()
  } finally {
    await t.app.close()
  }
})

test('Open on claude.ai opens the session’s link', async () => {
  const { app, page, pipeName, tabId } = await launchRcTerminal()
  try {
    await stubExternal(app)
    expect(await sendPipeMessage(pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await page.locator('#statusbar .status-remote').click()
    await page.locator('.remote-popover .remote-open').click()
    await expect.poll(() => externalCalls(app)).toEqual(['https://claude.ai/code/session_01E2eTest'])
  } finally {
    await app.close()
  }
})

test('Copy link copies the session’s link @alone', { tag: '@alone' }, async () => {
  const { app, page, pipeName, tabId } = await launchRcTerminal()
  try {
    await keepingClipboard(app, async () => {
      expect(await sendPipeMessage(pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
      await page.locator('#statusbar .status-remote').click()
      await page.locator('.remote-popover .remote-copy').click()
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('https://claude.ai/code/session_01E2eTest')
    })
  } finally {
    await app.close()
  }
})

test('a shell tab has no Remote segment', async () => {
  const { app, page } = await launchApp({ env: RC_CLEAN_ENV })
  try {
    await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
    await expect(page.locator('#statusbar .status-remote')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
