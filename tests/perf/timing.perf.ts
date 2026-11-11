// Timing harness: `npm run perf` measures how the app starts, how fast a tab switch, the Media panel and typing under load
// take, and prints one JSON line with the median of five runs of each. Not part of the test suite (playwright.perf.config.ts).
import { expect, test, type Page } from '@playwright/test'
import { tmpdir } from 'node:os'
import { WIN } from '../fixtures/platform'
import { FAKE_CLAUDE_SETTINGS, KEYS, PROMPT, launchApp } from '../e2e/helpers'

const RUNS = 5

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length / 2)]! * 10) / 10
}

/** resolves after two animation frames: the page has painted what the step before it changed */
const twoFrames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

/** a shell tab's prompt is in its buffer */
const promptShown = async (page: Page, tabId: string): Promise<void> => {
  await page.waitForFunction(({ id, prompt }) => new RegExp(prompt).test(window.__ct!.bufferText(id)), { id: tabId, prompt: PROMPT.source })
}

/** makes the tab the active one and waits until its terminal is the one on screen, then two frames */
async function switchTo(page: Page, tabId: string): Promise<number> {
  const t0 = performance.now()
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await page.waitForFunction((id) => {
    if (window.__ct!.activeTabId() !== id) return false
    return [...document.querySelectorAll<HTMLElement>('.terminal-host')].filter((h) => h.style.display === 'block').length === 1
  }, tabId)
  await twoFrames(page)
  return performance.now() - t0
}

/** the Media panel is open, or closed, by its class */
const panelOpen = (page: Page): Promise<boolean> =>
  page.evaluate(() => !document.getElementById('image-panel')!.classList.contains('collapsed'))

async function launchTimes(): Promise<{ window: number; prompt: number }> {
  const t0 = performance.now()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await twoFrames(page)
  const painted = performance.now() - t0
  await page.waitForFunction(() => window.__ct!.tabIds().length >= 1)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await promptShown(page, tabId)
  const prompted = performance.now() - t0
  await app.close()
  return { window: painted, prompt: prompted }
}

test('timing', async () => {
  test.setTimeout(30 * 60_000)
  const launch = { window: [] as number[], prompt: [] as number[] }
  for (let i = 0; i < RUNS; i++) {
    const t = await launchTimes()
    launch.window.push(t.window)
    launch.prompt.push(t.prompt)
  }

  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  const first = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await page.waitForFunction(() => window.__ct!.tabIds().length >= 1)
  await promptShown(page, first)
  const second = await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd, title: 'Second' }), tmpdir())
  expect(second).not.toBeNull()
  const other = second!.id
  await page.waitForFunction((id) => window.__ct!.tabIds().includes(id), other)
  await promptShown(page, other)
  await page.evaluate((id) => window.ct.activateTab(id), first)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)

  // tab switch: alternate between the two tabs
  const tabSwitch: number[] = []
  for (let i = 0; i < RUNS; i++) tabSwitch.push(await switchTo(page, i % 2 === 0 ? other : first))
  await switchTo(page, first)

  // Media panel: open and close by its shortcut, timed until its class settles
  await page.locator('.terminal-host:visible .xterm').click()
  if (await panelOpen(page)) await page.keyboard.press(KEYS.images)
  await page.waitForFunction(() => document.getElementById('image-panel')!.classList.contains('collapsed'))
  const panelOpenMs: number[] = []
  const panelCloseMs: number[] = []
  for (let i = 0; i < RUNS; i++) {
    let t0 = performance.now()
    await page.keyboard.press(KEYS.images)
    await page.waitForFunction(() => !document.getElementById('image-panel')!.classList.contains('collapsed'))
    await twoFrames(page)
    panelOpenMs.push(performance.now() - t0)
    t0 = performance.now()
    await page.keyboard.press(KEYS.images)
    await page.waitForFunction(() => document.getElementById('image-panel')!.classList.contains('collapsed'))
    await twoFrames(page)
    panelCloseMs.push(performance.now() - t0)
  }
  expect(await panelOpen(page)).toBe(false)

  // echo under load: the first tab prints lines in a loop, and the second tab shows a typed x
  const loop = WIN ? "while ($true) { 'line' }" : 'while true; do echo line; done'
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.type(loop)
  await page.keyboard.press('Enter')
  // the command itself holds the word, so wait for many printed lines
  await page.waitForFunction((id) => (window.__ct!.bufferText(id).match(/line/g) ?? []).length > 20, first)
  await switchTo(page, other)
  await page.locator('.terminal-host:visible .xterm').click()
  const echo: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    await page.keyboard.type('x')
    await page.waitForFunction((id) => window.__ct!.bufferText(id).trimEnd().endsWith('x'), other)
    echo.push(performance.now() - t0)
    await page.keyboard.press('Backspace')
    await page.waitForFunction((id) => !window.__ct!.bufferText(id).trimEnd().endsWith('x'), other)
  }
  await app.close()

  const result = {
    launchToWindowMs: median(launch.window),
    launchToPromptMs: median(launch.prompt),
    tabSwitchMs: median(tabSwitch),
    panelOpenMs: median(panelOpenMs),
    panelCloseMs: median(panelCloseMs),
    echoUnderLoadMs: median(echo)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
})
