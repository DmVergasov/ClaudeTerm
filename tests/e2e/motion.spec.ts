import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, KEYS, launchApp, launchClaudeTab, PNG_1x1 } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
// the animations are what these tests check; keep the desktop quiet while they run
const QUIET = { ...FAKE_CLAUDE_SETTINGS, attention: { sound: 'none', flash: false } }

/** what the hooks report: a prompt starts a turn, Stop ends it, a permission dialog waits for the user */
const turn = (pipeName: string, tabId: string): Promise<unknown> => sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId: SID })
const turnEnd = (pipeName: string, tabId: string): Promise<unknown> => sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })
const waiting = (pipeName: string, tabId: string): Promise<unknown> => sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'permission' })

/**
 * the animations running outside the terminal, each with its name and the element it runs on. The terminal's own cursor
 * blink is not the app's, so it is left out
 */
const runningAnimations = (page: Page): Promise<string[]> => page.evaluate(() => document.getAnimations()
  .filter((a) => a.playState === 'running' && !((a.effect as KeyframeEffect).target as Element | null)?.closest('.xterm'))
  .map((a) => {
    const effect = a.effect as KeyframeEffect
    const el = effect.target as Element | null
    const name = (a as CSSAnimation).animationName || a.id || 'unnamed'
    return `${name} on ${el?.tagName ?? 'nothing'}.${el?.getAttribute('class') ?? ''}${effect.pseudoElement ?? ''}`
  }))

/** the names of the running animations, without the elements they run on */
const runningNames = async (page: Page): Promise<string[]> => (await runningAnimations(page)).map((s) => s.split(' on ')[0])

test('an idle window runs no animation', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  // the start-up animations end whatever the machine's load: poll until none runs, rather than wait a fixed time
  await expect.poll(() => runningAnimations(page), { timeout: 5000 }).toEqual([])
  // and it stays that way: a second reading after 300 ms sees an animation that starts a moment later
  await page.waitForTimeout(300)
  expect(await runningAnimations(page)).toEqual([])
  await app.close()
})

test('a working Claude tab runs its glyph on the tab and in the header, nothing sweeps under the header, and nothing is left running after the turn', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const spins = (where: 'header' | 'tabs'): Promise<number> => page.evaluate((w) => document.getAnimations()
    .filter((a) => {
      const target = (a.effect as KeyframeEffect).target as Element | null
      return a.playState === 'running' && (a as CSSAnimation).animationName === 'tab-spin' && (w === 'header' ? target?.closest('#sheet-header') : !target?.closest('#sheet-header'))
    })
    .length, where)

  expect(await turn(pipeName, tabId)).toEqual({ ok: true })
  // the tab's own glyph and the one in the sheet's header both step while Claude works; no line sweeps under the header (it distracted)
  await expect.poll(() => spins('tabs')).toBeGreaterThan(0)
  await expect.poll(() => spins('header')).toBe(1)
  expect(await runningNames(page)).not.toContain('sheet-sweep')

  expect(await turnEnd(pipeName, tabId)).toEqual({ ok: true })
  await expect.poll(() => runningAnimations(page)).toEqual([])
  await app.close()
})

test('a count going up pops its badge once', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  // the panel does not open by itself, so the new image is counted as unseen on the Media button
  const { app, page, pipeName, tabId } = await launchClaudeTab({ ...QUIET, imagePanel: { autoOpen: false } }, work)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const badge = page.locator('#sheet-header .tab-images-toggle .badge')
  await expect(badge).toBeHidden()

  // every pop of the badge, from its start to its end, counted in the page
  const pops = page.evaluate(() => new Promise<{ starts: number; duration: number }>((resolve) => {
    let starts = 0
    let began = 0
    document.addEventListener('animationstart', (e) => {
      if (e.animationName === 'badge-pop') { starts++; began = performance.now() }
    })
    document.addEventListener('animationend', (e) => {
      if (e.animationName === 'badge-pop') resolve({ starts, duration: performance.now() - began })
    })
    setTimeout(() => resolve({ starts, duration: -1 }), 3000)
  }))

  const file = join(work, 'shot.png')
  writeFileSync(file, PNG_1x1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: file, caption: null })).toEqual({ ok: true })
  await expect(badge).toHaveText('1')

  const result = await pops
  expect(result.starts).toBe(1)
  // one pop, which ends: the bound is generous, as a loaded machine can take a while to paint the last frame
  expect(result.duration).toBeGreaterThan(0)
  expect(result.duration).toBeLessThan(2000)
  await app.close()
})

test('with reduced motion nothing runs, working and waiting alike', async () => {
  const { app, page, tabId: waitingTab, work, pipeName } = await launchClaudeTab(QUIET)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // a second Claude tab in front of the first: the first one waits, the second one works
  const working = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, working)

  expect(await turn(pipeName, working)).toEqual({ ok: true })
  expect(await waiting(pipeName, waitingTab)).toEqual({ ok: true })
  await expect(page.locator(`[data-tab-id="${waitingTab}"] .tab-attn`)).toHaveCount(1)
  await expect(page.locator(`[data-tab-id="${working}"] .spin`)).toHaveCount(1)
  expect(await runningAnimations(page)).toEqual([])
  await app.close()
})

test('switching to a tab whose badge shows more does not pop it', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  // the Media badge shows the active tab's count: the first tab has no image, the second one shows one
  const { app, page, tabId: first, pipeName } = await launchClaudeTab({ ...QUIET, imagePanel: { autoOpen: false } }, work)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // the number of pops so far, kept on the page: counted from the start, whatever the tabs do
  await page.evaluate(() => {
    document.documentElement.dataset.pops = '0'
    document.addEventListener('animationstart', (e) => {
      if (e.animationName === 'badge-pop') document.documentElement.dataset.pops = String(Number(document.documentElement.dataset.pops) + 1)
    })
  })
  const pops = (): Promise<number> => page.evaluate(() => Number(document.documentElement.dataset.pops))
  const badge = page.locator('#sheet-header .tab-images-toggle .badge')

  const second = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, second)
  const file = join(work, 'shot.png')
  writeFileSync(file, PNG_1x1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId: second, path: file, caption: null })).toEqual({ ok: true })
  await expect(badge).toHaveText('1')
  // the count of the second tab rose: that pop is right, and it is the only one so far
  await expect.poll(pops).toBe(1)
  await page.evaluate(() => { document.documentElement.dataset.pops = '0' })

  await page.evaluate((id) => window.ct.activateTab(id), first)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
  await expect(badge).toBeHidden()
  await page.evaluate((id) => window.ct.activateTab(id), second)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, second)
  await expect(badge).toHaveText('1')
  await page.waitForTimeout(400) // longer than the pop, so a pop that starts is counted
  expect(await pops()).toBe(0)
  await app.close()
})

test('the Recent sessions backdrop fades in with its box, and nothing animates under reduced motion', async () => {
  const { app, page } = await launchApp({ settings: QUIET })
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const animation = (sel: string): Promise<string> => page.locator(sel).evaluate((el) => getComputedStyle(el).animationName)

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.keyboard.press(KEYS.recentSessions)
  await expect(page.locator('#sessions')).toBeVisible()
  expect(await animation('#sessions')).toBe('fade-in')
  await page.keyboard.press('Escape')
  await expect(page.locator('#sessions')).toBeHidden()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.press(KEYS.recentSessions)
  await expect(page.locator('#sessions')).toBeVisible()
  expect(await animation('#sessions')).toBe('none')
  await app.close()
})
