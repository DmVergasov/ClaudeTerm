import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, gitRepo, launchApp, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const AGENT = 'a3f1c2d4e5b60718'
// the icon is what these tests check; keep the desktop quiet while they run
const QUIET = { ...FAKE_CLAUDE_SETTINGS, attention: { sound: 'none', flash: false } }

/** the kind icon of a tab, on the tab bar or in the left panel */
const icon = (page: Page, tabId: string): Locator => page.locator(`[data-tab-id="${tabId}"] .tab-icon`)

/** the animation of the icon's glyph, found and read in one go: a redraw of the tabs replaces the element */
const glyph = (page: Page, tabId: string): Promise<{ animation: string; content: string }> => page.evaluate((id) => {
  const s = getComputedStyle(document.querySelector(`[data-tab-id="${id}"] .tab-icon`)!, '::before')
  return { animation: s.animationName, content: s.content }
}, tabId)

/** how a spinning icon looks: its color and the animation of its glyph, with the speed */
const spinLook = (spin: Locator): Promise<{ color: string; animation: string; duration: string }> => spin.evaluate((el) => {
  const s = getComputedStyle(el, '::before')
  return { color: getComputedStyle(el).color, animation: s.animationName, duration: s.animationDuration }
})

/**
 * waits until the window has drawn everything main said of its tabs so far: a rename of the tab sent after it comes
 * after it, and shows in the tab's tooltip
 */
async function settled(page: Page, tabId: string, title: string): Promise<void> {
  await page.evaluate(([id, t]) => window.ct.renameTab(id, t), [tabId, title] as const)
  await expect(page.locator(`[data-tab-id="${tabId}"]`)).toHaveAttribute('title', new RegExp(`^${title}\\n`))
}

/** what the hooks report: a prompt starts a turn, Stop ends it, an agent starts and stops */
const turn = (pipeName: string, tabId: string): Promise<unknown> => sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID, cwd: null })
const turnEnd = (pipeName: string, tabId: string): Promise<unknown> => sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })
const agent = (pipeName: string, tabId: string, event: 'start' | 'stop'): Promise<unknown> =>
  sendPipeMessage(pipeName, { v: 1, type: 'subagent', tabId, sessionId: SID, event, agentId: AGENT, agentType: 'general-purpose' })

/**
 * what to type in the test shell so that it titles its terminal with the mark and the text, as Claude Code does. A
 * system's prompt may set the title too (Ubuntu's does): the shell then waits in `read` until Enter, with no prompt
 */
function titleCommand(mark: string, text: string): string {
  if (WIN) return `$Host.UI.RawUI.WindowTitle = [char]0x${mark.codePointAt(0)!.toString(16)} + ' ${text}'\r`
  const bytes = [...Buffer.from(mark)].map((b) => `\\${b.toString(8)}`).join('')
  return `printf '\\033]0;${bytes} ${text}\\007'; read x\r`
}

/** the fake claude has run in the Claude tab, and the shell waits at its prompt, whichever prompt the system gives it */
const CLAUDE_TAB_READY = /fake-claude[\s\S]*[$#%>]\s*$/

/** opens a tab in the folder and waits until main has it; the new tab is the active one */
async function openTab(page: Page, kind: 'shell' | 'claude', cwd: string): Promise<string> {
  const count = await page.evaluate(() => window.__ct!.tabIds().length)
  await page.evaluate((o) => window.ct.openTab(o), { kind, cwd })
  await page.waitForFunction((n) => window.__ct!.tabIds().length === n, count + 1)
  return (await page.evaluate(() => window.__ct!.activeTabId()))!
}

async function activate(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
}

test('a Claude tab spins its icon through a turn; the end of the turn and Esc stop it', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(icon(page, tabId)).toHaveText('✳')
  await expect(icon(page, tabId)).not.toHaveClass(/\bspin\b/)

  expect(await turn(pipeName, tabId)).toEqual({ ok: true })
  await expect(icon(page, tabId)).toHaveClass(/\bspin\b/)
  await expect(icon(page, tabId)).not.toHaveClass(/\bbg\b/)
  expect((await glyph(page, tabId)).animation).toBe('tab-spin')

  expect(await turnEnd(pipeName, tabId)).toEqual({ ok: true })
  await expect(icon(page, tabId)).not.toHaveClass(/\bspin\b/)
  await expect(icon(page, tabId)).toHaveText('✳')

  await turn(pipeName, tabId)
  await expect(icon(page, tabId)).toHaveClass(/\bspin\b/)
  await page.evaluate((id) => window.ct.writePty(id, '\x1b'), tabId)
  await expect(icon(page, tabId)).not.toHaveClass(/\bspin\b/)
  await app.close()
})

test('an agent Claude left running after its turn keeps the icon spinning as in the turn until the agent stops', async () => {
  // Claude Code waits for the agents it left and goes on when they report: the work is not over
  const { app, page, tabId, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await turn(pipeName, tabId)
  expect(await agent(pipeName, tabId, 'start')).toEqual({ ok: true })
  await expect(icon(page, tabId)).toHaveClass(/\bspin\b/)
  const working = await spinLook(icon(page, tabId))
  expect(working.animation).toBe('tab-spin')

  await turnEnd(pipeName, tabId)
  await settled(page, tabId, 'after the turn')
  await expect(icon(page, tabId)).toHaveClass(/\bspin\b/)
  expect(await spinLook(icon(page, tabId))).toEqual(working)

  expect(await agent(pipeName, tabId, 'stop')).toEqual({ ok: true })
  await expect(icon(page, tabId)).not.toHaveClass(/\bspin\b/)
  await expect(icon(page, tabId)).toHaveText('✳')
  await app.close()
})

test('Claude waiting in a background tab in the middle of a turn pulses with its icon still; opened, the tab spins again', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openTab(page, 'shell', work)
  await turn(pipeName, tabId)
  await expect(icon(page, tabId)).toHaveClass(/\bspin\b/)

  // a permission dialog of the turn: the tab pulses, and the icon does not spin over it
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await expect(icon(page, tabId)).not.toHaveClass(/\bspin\b/)
  await expect(icon(page, tabId)).toHaveText('✳')

  await claudeTab.click()
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await expect(icon(page, tabId)).toHaveClass(/\bspin\b/)
  await app.close()
})

test('with reduced motion a working tab shows a still ✻', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await turn(pipeName, tabId)
  await expect(icon(page, tabId)).toHaveClass(/\bspin\b/)
  expect(await glyph(page, tabId)).toEqual({ animation: 'none', content: '"✻"' })
  await app.close()
})

test('the spin keeps its phase when the tab bar is redrawn', async () => {
  // Claude Code retitles a working tab about once a second, and every title change redraws the tab bar
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const other = await openTab(page, 'shell', work)
  await turn(pipeName, tabId)
  await expect(icon(page, tabId)).toHaveClass(/\bspin\b/)
  // how far into the spin the icon is; a recreated element restarts its CSS animation from 0 unless it keeps the phase
  const phase = (): Promise<number> => page.evaluate(() => {
    const a = document.getAnimations().find((x) => (x as CSSAnimation).animationName === 'tab-spin')
    const t = a?.effect?.getComputedTiming()
    return t ? Number(t.localTime) - Number(t.delay) : -1
  })
  await page.waitForTimeout(700)
  const before = await phase()
  expect(before).toBeGreaterThan(0)
  await page.evaluate((id) => window.ct.renameTab(id, 'renamed'), other)
  await expect(page.locator(`[data-tab-id="${other}"]`)).toHaveAttribute('title', `renamed\n${work}`)
  const after = await phase()
  // one clock for every spin: the redraw carries on where it was (modulo a full 1.2 s cycle), measured both ways round
  const drift = (((after - before) % 1200) + 1200) % 1200
  expect(Math.min(drift, 1200 - drift)).toBeLessThan(300)
  await app.close()
})

test('a Claude tab shows its title without the mark Claude Code puts before it', async () => {
  const { app, page, tabId } = await launchClaudeTab(QUIET)
  await expect.poll(() => bufferText(page, tabId), { timeout: 20_000 }).toMatch(CLAUDE_TAB_READY)
  const title = page.locator(`[data-tab-id="${tabId}"] .tab-title`)

  await page.evaluate(([id, text]) => window.ct.writePty(id, text), [tabId, titleCommand('◐', 'Revenue CSV export')] as const)
  await expect(title).toHaveText('Revenue CSV export')
  // Enter ends the wait in `read`
  await page.evaluate((id) => window.ct.writePty(id, '\r'), tabId)
  await page.evaluate(([id, text]) => window.ct.writePty(id, text), [tabId, titleCommand('✳', 'Invoice PDF layout')] as const)
  await expect(title).toHaveText('Invoice PDF layout')
  await app.close()
})

test('a folded group spins while Claude works in one of its tabs, the agents it left running included, and not while Claude waits', async () => {
  const repo = gitRepo()
  // the end of a turn leaves the tab unmarked, so the spin of the agent it left shows
  const off = { sound: false, flash: false, tab: false, front: false, banner: false }
  const notifications = { permission: { ...off, tab: true }, question: off, done: off, bell: off }
  const { app, page, pipeName } = await launchApp({ settings: { ...FAKE_CLAUDE_SETTINGS, notifications, defaultFolder: mkdtempSync(join(tmpdir(), 'ct-folder-')), tabs: { position: 'left' } } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const home = (await page.evaluate(() => window.__ct!.tabIds()))[0]
  const claude = await openTab(page, 'claude', repo)
  await activate(page, home)
  const group = page.locator('#tabpanel .tp-group').filter({ has: page.locator('.tp-group-name', { hasText: new RegExp(`^${basename(repo)}$`) }) })
  await expect(group).toHaveCount(1)
  await group.locator('.tp-group-head').click()
  await expect(group).toHaveClass(/\bfolded\b/)
  const spin = group.locator('.tp-group-spin')
  await expect(spin).toHaveCount(0)

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await turn(pipeName, claude)
  await expect(spin).toHaveCount(1)
  const working = await spinLook(spin)
  await agent(pipeName, claude, 'start')
  await turnEnd(pipeName, claude)
  // the Claude tab is in the folded group: the home tab, drawn with it, says when the window has caught up
  await settled(page, home, 'after the turn')
  await expect(spin).toHaveCount(1)
  expect(await spinLook(spin)).toEqual(working)
  await agent(pipeName, claude, 'stop')
  await expect(spin).toHaveCount(0)

  // Claude asks in the middle of a turn: the group's dot pulses, and the spin gives way to it
  await turn(pipeName, claude)
  await expect(spin).toHaveCount(1)
  await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: SID, reason: 'permission' })
  await expect(group.locator('.tp-group-dot')).toHaveClass(/\bpulse\b/)
  await expect(spin).toHaveCount(0)
  await app.close()
})
