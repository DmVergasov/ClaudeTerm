import { expect, test, type Locator } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const SID_C = '6e3d2c8b-9f50-4b4c-a2d3-e4f5a6b7c8d9'

const user = (cwd: string, text: string, entrypoint = 'cli'): object => ({ type: 'user', cwd, entrypoint, isSidechain: false, message: { role: 'user', content: text } })

function writeSession(config: string, cwd: string, id: string, entries: object[], minutesAgo: number): void {
  const dir = join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const at = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(file, at, at)
}

/** two interactive sessions (B newer) and a newer `claude -p` run that must not be listed */
function makeConfig(): { config: string; workA: string; workB: string } {
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const workA = mkdtempSync(join(tmpdir(), 'ct-work-a-'))
  const workB = mkdtempSync(join(tmpdir(), 'ct-work-b-'))
  writeSession(config, workA, SID_A, [user(workA, 'why does login fail'), { type: 'ai-title', aiTitle: 'Fix the login bug' }, { type: 'last-prompt', lastPrompt: 'why does login fail' }], 120)
  writeSession(config, workB, SID_B, [user(workB, 'add yookassa'), { type: 'ai-title', aiTitle: 'Something else' }, { type: 'custom-title', customTitle: 'Payments' }, { type: 'last-prompt', lastPrompt: 'add yookassa' }], 5)
  writeSession(config, workA, SID_C, [user(workA, 'scripted', 'sdk-cli')], 1)
  return { config, workA, workB }
}

test('the main process lists sessions newest first and opens one in a Claude tab, or goes to its tab', async () => {
  const { config, workA } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const list = await page.evaluate(() => window.ct.listSessions())
  expect(list.map((s) => [s.id, s.title, s.open])).toEqual([[SID_B, 'Payments', false], [SID_A, 'Fix the login bug', false]])
  expect(list[1]).toMatchObject({ cwd: workA, firstPrompt: 'why does login fail', lastPrompt: 'why does login fail' })

  await page.evaluate((id) => window.ct.openSession(id), SID_A)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const tabA = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, tabA), { timeout: 15_000 }).toContain(`--resume ${SID_A}`)
  // the prompt shows the folder; compare its name, since TEMP can be an 8.3 short path (C:\Users\RUNNER~1\…)
  // while PowerShell prints the long one
  await expect.poll(() => bufferText(page, tabA), { timeout: 15_000 }).toContain(basename(workA))
  expect((await page.evaluate(() => window.ct.listSessions())).find((s) => s.id === SID_A)?.open).toBe(true)

  // a second tab in the same folder, then back to the conversation's own tab
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), workA)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  await page.evaluate((id) => window.ct.openSession(id), SID_A)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabA)
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(3)
  await app.close()
})

test('a session whose folder is gone is not opened', async () => {
  const { config, workB } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.evaluate(() => window.ct.listSessions())
  rmSync(workB, { recursive: true, force: true })
  await page.evaluate((id) => window.ct.openSession(id), SID_B)
  await expect(page.locator('.toast', { hasText: 'The folder of this session no longer exists' })).toBeVisible()
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  await app.close()
})

test('Ctrl+Shift+H opens the window: newest first, filter as you type, Enter continues the session', async () => {
  const { config, workB } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  const win = page.locator('#sessions')
  await expect(win).toBeVisible()
  await expect(win.locator('.session-title')).toHaveText(['Payments', 'Fix the login bug'])
  const first = win.locator('.session-row').first()
  await expect(first).toHaveClass(/selected/)
  await expect(first.locator('.session-meta')).toContainText('5 min ago')
  await expect(first.locator('.session-meta span')).toHaveAttribute('title', workB)
  await expect(win.locator('.session-last').last()).toHaveText('why does login fail')
  await page.keyboard.type('login')
  await expect(win.locator('.session-title')).toHaveText(['Fix the login bug'])
  await page.keyboard.press('Enter')
  await expect(win).toBeHidden()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID_A}`)
  await app.close()
})

test('the ▾ menu opens the window; an open session is marked and goes to its tab; Esc closes', async () => {
  const { config } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.evaluate(() => window.ct.listSessions())
  await page.evaluate((sid) => window.ct.openSession(sid), SID_A)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const tabA = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const [shellTab] = await page.evaluate(() => window.__ct!.tabIds())
  await page.evaluate((id) => window.ct.activateTab(id), shellTab)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shellTab)

  await page.locator('.tab-menu').click()
  await page.locator('.menu-item', { hasText: 'Recent sessions…' }).click()
  const win = page.locator('#sessions')
  await expect(win.locator('.session-row', { hasText: 'Fix the login bug' }).locator('.session-open')).toHaveText('● open')
  await page.keyboard.press('ArrowDown')
  await expect(win.locator('.session-row').nth(1)).toHaveClass(/selected/)
  await page.keyboard.press('Enter')
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabA)
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)

  await page.keyboard.press('Control+Shift+KeyH')
  await expect(win).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(win).toBeHidden()
  await app.close()
})

test('empty states', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: empty } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  await expect(page.locator('#sessions .sessions-empty')).toHaveText('No Claude Code sessions yet')
  await app.close()

  const { config } = makeConfig()
  const second = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await second.page.locator('.terminal-host:visible .xterm').click()
  await second.page.keyboard.press('Control+Shift+KeyH')
  await expect(second.page.locator('#sessions .session-row')).toHaveCount(2)
  await second.page.keyboard.type('zzz')
  await expect(second.page.locator('#sessions .sessions-empty')).toHaveText('Nothing matches')
  await second.app.close()
})

test('the window keeps the keyboard: Tab and clicks inside it leave typing in the search field', async () => {
  const { config } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const [id] = await page.evaluate(() => window.__ct!.tabIds())
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  const win = page.locator('#sessions')
  await expect(win.locator('.session-row')).toHaveCount(2)
  await page.keyboard.press('Tab')
  await page.keyboard.type('login')
  await expect(win.locator('.session-title')).toHaveText(['Fix the login bug'])
  await win.locator('.sessions-heading').click()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Escape')
  await expect(win).toBeHidden()
  expect(await bufferText(page, id)).not.toContain('login')
  await app.close()
})

const stars = (win: Locator): Promise<string[][]> =>
  win.locator('.session-row').evaluateAll((rows) => rows.map((r) => [r.querySelector('.session-title')!.textContent!, r.querySelector('.session-star')!.textContent!]))

test('the star puts a session on top of the list under a divider, without opening it, and survives closing the window and a restart', async () => {
  const { config } = makeConfig()
  const first = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  const { app, page, dataDir } = first
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  const win = page.locator('#sessions')
  await expect(win.locator('.session-row')).toHaveCount(2)
  expect(await stars(win)).toEqual([['Payments', '☆'], ['Fix the login bug', '☆']])
  await expect(win.locator('.sessions-divider')).toHaveCount(0)
  await expect(win.locator('.session-star').first()).toHaveAttribute('title', 'Star (Ctrl+D)')

  const older = win.locator('.session-row', { hasText: 'Fix the login bug' })
  await older.locator('.session-star').click()
  expect(await stars(win)).toEqual([['Fix the login bug', '★'], ['Payments', '☆']])
  await expect(older.locator('.session-star')).toHaveClass(/starred/)
  await expect(older.locator('.session-star')).toHaveAttribute('title', 'Unstar (Ctrl+D)')
  await expect(win.locator('.sessions-divider')).toHaveCount(1)
  // the divider sits between the starred row and the rest
  expect(await win.locator('.sessions-list').evaluate((l) => [...l.children].map((c) => c.className.split(' ')[0]))).toEqual(['session-row', 'sessions-divider', 'session-row'])
  // the click toggled the star only: no tab was opened, the window is still there
  await expect(win).toBeVisible()
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  expect((await page.evaluate(() => window.ct.listSessions())).map((s) => [s.id, s.starred])).toEqual([[SID_B, false], [SID_A, true]])

  await page.keyboard.press('Escape')
  await expect(win).toBeHidden()
  await page.keyboard.press('Control+Shift+KeyH')
  await expect(win.locator('.session-row')).toHaveCount(2)
  expect(await stars(win)).toEqual([['Fix the login bug', '★'], ['Payments', '☆']])
  await app.close()

  const second = await launchApp({ dataDir, settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await second.page.locator('.terminal-host:visible .xterm').click()
  await second.page.keyboard.press('Control+Shift+KeyH')
  const win2 = second.page.locator('#sessions')
  await expect(win2.locator('.session-row')).toHaveCount(2)
  expect(await stars(win2)).toEqual([['Fix the login bug', '★'], ['Payments', '☆']])
  // a click on the star again takes it off
  await win2.locator('.session-row').first().locator('.session-star').click()
  expect(await stars(win2)).toEqual([['Payments', '☆'], ['Fix the login bug', '☆']])
  await expect(win2.locator('.sessions-divider')).toHaveCount(0)
  await second.app.close()
})

test('Ctrl+D stars the selected row while typing in the search; the selection stays on that session; the filter keeps starred on top', async () => {
  const { config } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  const win = page.locator('#sessions')
  await expect(win.locator('.session-row')).toHaveCount(2)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Control+KeyD')
  // the older row moved to the top and is still the selected one
  expect(await stars(win)).toEqual([['Fix the login bug', '★'], ['Payments', '☆']])
  await expect(win.locator('.session-row.selected .session-title')).toHaveText('Fix the login bug')
  await expect(win.locator('.sessions-search')).toHaveValue('')
  // typing goes on in the field
  await page.keyboard.type('login')
  expect(await stars(win)).toEqual([['Fix the login bug', '★']])
  await page.keyboard.press('Control+KeyD')
  expect(await stars(win)).toEqual([['Fix the login bug', '☆']])
  await expect(win.locator('.sessions-divider')).toHaveCount(0)
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  await app.close()
})

test('a starred session older than the latest 100 is still listed', async () => {
  const { config, workA } = makeConfig()
  for (let i = 0; i < 100; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    writeSession(config, workA, id, [user(workA, `filler ${i}`)], 10 + i)
  }
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  expect((await page.evaluate(() => window.ct.listSessions())).map((s) => s.id)).not.toContain(SID_A)
  await page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_A)
  const list = await page.evaluate(() => window.ct.listSessions())
  expect(list).toHaveLength(101)
  expect(list.find((s) => s.id === SID_A)?.starred).toBe(true)
  await app.close()
})

test('the tab menu stars the session of a Claude tab; a shell tab has no such item; the window shows the change', async () => {
  const { config } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.tab').first().click({ button: 'right' })
  await expect(page.locator('.menu-item', { hasText: 'Restart shell' })).toBeVisible()
  await expect(page.locator('.menu-item', { hasText: /star session/i })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.mouse.click(300, 300)

  await page.evaluate(() => window.ct.listSessions())
  await page.evaluate((id) => window.ct.openSession(id), SID_A)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.locator('.tab').nth(1).click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Star session' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.ct.listSessions())).find((s) => s.id === SID_A)?.starred).toBe(true)

  await page.keyboard.press('Control+Shift+KeyH')
  const win = page.locator('#sessions')
  await expect(win.locator('.session-row')).toHaveCount(2)
  expect(await stars(win)).toEqual([['Fix the login bug', '★'], ['Payments', '☆']])

  await page.keyboard.press('Escape')
  await page.locator('.tab').nth(1).click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Unstar session' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.ct.listSessions())).find((s) => s.id === SID_A)?.starred).toBe(false)
  await app.close()
})

test('a double-click on a star does not open a session', async () => {
  const { config } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  const win = page.locator('#sessions')
  await expect(win.locator('.session-row')).toHaveCount(2)
  // the first click moves the row, so the second lands on another one
  await win.locator('.session-row', { hasText: 'Fix the login bug' }).locator('.session-star').dblclick()
  await expect(win).toBeVisible()
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  // the second click of a double-click can land on the body of another row: that never opens it
  await win.locator('.session-row').last().evaluate((row) => row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })))
  await page.waitForTimeout(500)
  await expect(win).toBeVisible()
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  await app.close()
})

test('Enter right after opening the window resumes the latest session, even when an older one is starred', async () => {
  const { config } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_A)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  const win = page.locator('#sessions')
  await expect(win.locator('.session-row')).toHaveCount(2)
  expect(await stars(win)).toEqual([['Fix the login bug', '★'], ['Payments', '☆']])
  await expect(win.locator('.session-row.selected .session-title')).toHaveText('Payments')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID_B}`)
  await app.close()
})

test('a menu left open does not stay above the window; bad star requests are ignored', async () => {
  const { config } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.evaluate(() => window.ct.listSessions())
  await page.evaluate((id) => window.ct.openSession(id), SID_A)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.locator('.tab').nth(1).click({ button: 'right' })
  await expect(page.locator('.menu-item', { hasText: 'Star session' })).toBeVisible()
  await page.keyboard.press('Control+Shift+KeyH')
  await expect(page.locator('#sessions')).toBeVisible()
  await expect(page.locator('.menu')).toHaveCount(0)

  await page.evaluate(() => window.ct.setSessionStarred('not-a-session', true))
  await page.evaluate((id) => window.ct.setSessionStarred(id, 'yes' as unknown as boolean), SID_A)
  expect(await page.evaluate(() => window.ct.getStarredSessions())).toEqual([])
  await app.close()
})

test('a star that cannot be saved says so', async () => {
  const { config } = makeConfig()
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  // a folder where the file should be: reading and renaming over it both fail
  mkdirSync(join(dataDir, 'starred-sessions.json'))
  const { app, page } = await launchApp({ dataDir, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_A)
  await expect(page.locator('.toast', { hasText: 'cannot save' })).toBeVisible()
  await app.close()
})
