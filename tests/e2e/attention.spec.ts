import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { bellCommand, bufferText, FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, PROMPT } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
// the mark is what these tests check; keep the desktop quiet while they run
const QUIET = { ...FAKE_CLAUDE_SETTINGS, attention: { sound: 'none', flash: false } }
const OFF = { sound: false, flash: false, tab: true }
/** per-case settings with the desktop kept quiet */
const quietNotifications = (over: object = {}): object => ({
  ...FAKE_CLAUDE_SETTINGS,
  notifications: { permission: OFF, question: OFF, done: OFF, bell: { sound: false, flash: false, tab: true }, ...over }
})

test('Claude waiting in a background tab makes that tab pulse until it is opened', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)

  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/)
  // found and read in one go: a redraw of the tab bar replaces its elements, and a replaced one has no style left
  expect(await page.evaluate((id) => getComputedStyle(document.querySelector(`[data-tab-id="${id}"]`)!).animationName, tabId)).toBe('tab-attention')
  await expect(claudeTab.locator('.tab-bell')).toHaveCount(0)

  await claudeTab.click()
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('the pulse keeps its phase when the tab bar is redrawn', async () => {
  // a busy Claude in another tab retitles it about once a second, and every title change redraws the tab bar
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const other = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, other)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect(claudeTab).toHaveClass(/\battention\b/)
  // how far into the pulse the tab is; a recreated element restarts its CSS animation from 0 unless it keeps the phase
  const phase = () => page.evaluate(() => {
    const a = document.getAnimations().find((x) => (x as CSSAnimation).animationName === 'tab-attention')
    const t = a?.effect?.getComputedTiming()
    return t ? Number(t.localTime) - Number(t.delay) : -1
  })
  await page.waitForTimeout(700)
  const before = await phase()
  expect(before).toBeGreaterThan(0)
  await page.evaluate((id) => window.ct.renameTab(id, 'renamed'), other)
  await expect(page.locator(`[data-tab-id="${other}"]`)).toHaveAttribute('title', `renamed\n${work}`)
  const after = await phase()
  // the pulse runs on one clock: the redraw carries on where it was (modulo a full 2.4 s cycle) instead of restarting;
  // measured both ways round the cycle, since the two readings can come out a fraction of a millisecond apart either way
  const drift = (((after - before) % 2400) + 2400) % 2400
  expect(Math.min(drift, 2400 - drift)).toBeLessThan(500)
  await app.close()
})

test('a terminal bell in a background tab only puts a dot on it', async () => {
  const { app, page, tabId: first, work } = await launchClaudeTab()
  const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)
  await expect.poll(() => bufferText(page, shell), { timeout: 20_000 }).toMatch(PROMPT)
  await page.evaluate((id) => window.ct.activateTab(id), first)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)

  await page.evaluate(([id, text]) => window.ct.writePty(id, text), [shell, bellCommand()] as const)
  const shellTab = page.locator(`[data-tab-id="${shell}"]`)
  await expect(shellTab.locator('.tab-bell')).toHaveCount(1)
  await expect(shellTab).not.toHaveClass(/\battention\b/)
  await app.close()
})

test('attention for a shell tab is rejected', async () => {
  const { app, page, pipeName } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: false, error: `unknown claude tab: ${tabId}` })
  await app.close()
})

test('each case follows its own settings: a finished answer without tab highlight leaves the tab alone, a permission prompt marks it', async () => {
  const { app, page, tabId, work, pipeName } = await launchClaudeTab(quietNotifications({ done: { sound: false, flash: false, tab: false } }))
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  // the mark would arrive right after the pipe answer; give it time to show up if it were sent
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await app.close()
})

test('Mute sound in the tab menu silences that tab, which is still marked; Unmute sound brings the sound back', async () => {
  // the app writes each sound it would play to this file instead
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const loud = { sound: true, flash: false, tab: true }
  const { app, page, pipeName } = await launchApp({ settings: quietNotifications({ permission: loud, done: loud }), args: ['--claude', work], env: { CLAUDETERM_TEST_SOUND_LOG: sounds } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await page.waitForFunction((id) => window.__ct!.tabIds().length === 2 && window.__ct!.activeTabId() !== id, tabId)
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect(claudeTab.locator('.tab-muted')).toHaveCount(0)

  await claudeTab.click({ button: 'right' })
  await page.locator('.menu-item', { hasText: /^Mute sound$/ }).click()
  await expect(claudeTab.locator('.tab-muted')).toHaveCount(1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(claudeTab).toHaveClass(/\battention\b/)
  // the sound is written before the pipe answers
  expect(played()).toBe('')

  await claudeTab.click({ button: 'right' })
  await page.locator('.menu-item', { hasText: /^Unmute sound$/ }).click()
  await expect(claudeTab.locator('.tab-muted')).toHaveCount(0)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  expect(played()).toBe('system\n')
  await app.close()
})

test('with the bell tab highlight off, a terminal bell in a background tab leaves no dot', async () => {
  const { app, page, tabId: first, work } = await launchClaudeTab(quietNotifications({ bell: { sound: false, flash: false, tab: false } }))
  const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)
  await expect.poll(() => bufferText(page, shell), { timeout: 20_000 }).toMatch(PROMPT)
  await page.evaluate((id) => window.ct.activateTab(id), first)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
  await page.evaluate(([id, text]) => window.ct.writePty(id, text), [shell, bellCommand('after-bell')] as const)
  await expect.poll(() => bufferText(page, shell), { timeout: 10_000 }).toContain('after-bell')
  // the bell goes renderer → main → renderer; give that round trip time before checking it left no dot
  await page.waitForTimeout(500)
  await expect(page.locator(`[data-tab-id="${shell}"] .tab-bell`)).toHaveCount(0)
  await app.close()
})
