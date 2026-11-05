import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { SessionSnapshotTab } from '../../src/shared/types'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir, TEST_SHELL, writeTranscript } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'

/** the tabs of the snapshot saved next to the data, [] until it is saved */
function snapshotTabs(dataDir: string): SessionSnapshotTab[] {
  const file = join(dataDir, 'session-state.json')
  if (!existsSync(file)) return []
  return (JSON.parse(readFileSync(file, 'utf8')) as { tabs: SessionSnapshotTab[] }).tabs
}

/** a Claude tab in a fresh folder, with the config folder the app reads its conversations from */
async function startWithClaudeTab(settings: object = FAKE_CLAUDE_SETTINGS) {
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings, args: ['--claude', work], env: { CLAUDE_CONFIG_DIR: config } })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, config, work, tabId }
}

/** Claude Code's SessionStart for a tab: the conversation it runs, and its transcript when one was written */
async function sessionStarts(pipeName: string, tabId: string, sessionId: string, source: string, transcriptPath: string | null): Promise<void> {
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source, transcriptPath })).toEqual({ ok: true })
}

async function openShellTab(page: Page, cwd: string): Promise<void> {
  const count = await page.evaluate(() => window.__ct!.tabIds().length)
  await page.evaluate((folder) => window.ct.openTab({ kind: 'shell', cwd: folder }), cwd)
  await page.waitForFunction((n) => window.__ct!.tabIds().length === n, count + 1)
}

test('a Claude tab without a conversation cannot be forked', async () => {
  const { app, page, tabId } = await startWithClaudeTab()
  expect(await page.evaluate((id) => window.ct.canForkTab(id), tabId)).toBe(false)
  await app.close()
})

test('Fork session opens a tab that forks the conversation, after its family, without a session of its own', async () => {
  const { app, page, dataDir, pipeName, config, work, tabId: a } = await startWithClaudeTab()
  await sessionStarts(pipeName, a, SID_A, 'startup', writeTranscript(config, work, SID_A))
  expect(await page.evaluate((id) => window.ct.canForkTab(id), a)).toBe(true)
  await openShellTab(page, work)
  const b = (await page.evaluate(() => window.__ct!.tabIds()))[1]!

  await page.evaluate((id) => window.ct.forkTab(id), a)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  const [first, f, last] = await page.evaluate(() => window.__ct!.tabIds())
  expect([first, last]).toEqual([a, b])
  await expect.poll(() => bufferText(page, f!), { timeout: 15_000 }).toContain(`--resume ${SID_A} --fork-session`)
  await expect.poll(() => snapshotTabs(dataDir).map((t) => [t.kind, t.claudeSessionId, t.fork])).toEqual([
    ['claude', SID_A, null],
    ['claude', null, { of: 0, from: SID_A }],
    ['shell', null, null]
  ])

  // the fork's own SessionStart: from now on it is an ordinary resumable conversation of its own
  await sessionStarts(pipeName, f!, SID_B, 'fork', null)
  await expect.poll(() => snapshotTabs(dataDir)[1]?.claudeSessionId).toBe(SID_B)
  await app.close()
})

test('a fork of a fork joins the family', async () => {
  const { app, page, dataDir, pipeName, config, work, tabId: a } = await startWithClaudeTab()
  await sessionStarts(pipeName, a, SID_A, 'startup', writeTranscript(config, work, SID_A))
  await openShellTab(page, work)
  const b = (await page.evaluate(() => window.__ct!.tabIds()))[1]!
  await page.evaluate((id) => window.ct.forkTab(id), a)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  const f = (await page.evaluate(() => window.__ct!.tabIds()))[1]!
  await sessionStarts(pipeName, f, SID_B, 'fork', writeTranscript(config, work, SID_B))
  expect(await page.evaluate((id) => window.ct.canForkTab(id), f)).toBe(true)

  await page.evaluate((id) => window.ct.forkTab(id), f)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 4)
  expect(await page.evaluate(() => window.__ct!.tabIds())).toEqual([a, f, expect.any(String), b])
  const f2 = (await page.evaluate(() => window.__ct!.tabIds()))[2]!
  await expect.poll(() => bufferText(page, f2), { timeout: 15_000 }).toContain(`--resume ${SID_B} --fork-session`)
  await expect.poll(() => snapshotTabs(dataDir)[2]?.fork).toEqual({ of: 0, from: SID_B })
  await app.close()
})

test('closing the head turns the forks into ordinary tabs', async () => {
  const { app, page, dataDir, pipeName, config, work, tabId: a } = await startWithClaudeTab()
  await sessionStarts(pipeName, a, SID_A, 'startup', writeTranscript(config, work, SID_A))
  await page.evaluate((id) => window.ct.forkTab(id), a)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expect.poll(() => snapshotTabs(dataDir)[1]?.fork).toEqual({ of: 0, from: SID_A })

  await page.evaluate((id) => window.ct.closeTab(id), a)
  await page.waitForFunction((id) => !window.__ct!.tabIds().includes(id), a)
  await expect.poll(() => snapshotTabs(dataDir).map((t) => t.fork)).toEqual([{ of: null, from: SID_A }])
  await app.close()
})

test('Restore keeps forks under their head, and forks again a fork that had no conversation of its own', async () => {
  for (const withTranscript of [false, true]) {
    const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
    const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
    const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
    const head = { kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'head', claudeSessionId: SID_A }
    const fork = { kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'fork', claudeSessionId: SID_B, fork: { of: 0, from: SID_A } }
    writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [head, fork] }))
    if (withTranscript) writeTranscript(config, work, SID_B)
    const { app, page } = await launchApp({ dataDir, env: { CLAUDE_CONFIG_DIR: config } })
    await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
    await page.locator('.banner-restore').click()
    await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
    const [h, f] = await page.evaluate(() => window.__ct!.tabIds())
    // the restored fork stays under its head: the head is the first tab, and the saved snapshot says so
    expect(await page.evaluate(() => window.__ct!.tabIds().map((id) => window.__ct!.tabTitle(id)))).toEqual(['head', 'fork'])
    await expect.poll(() => snapshotTabs(dataDir)[1]?.fork).toEqual({ of: 0, from: SID_A })
    await expect.poll(() => bufferText(page, h!), { timeout: 15_000 }).toContain(`--resume ${SID_A}`)
    if (withTranscript) {
      await expect.poll(() => bufferText(page, f!), { timeout: 15_000 }).toContain(`--resume ${SID_B}`)
      expect(await bufferText(page, f!)).not.toContain('--fork-session')
    } else {
      await expect.poll(() => bufferText(page, f!), { timeout: 15_000 }).toContain(`--resume ${SID_A} --fork-session`)
    }
    await app.close()
  }
})

test('Restore forks again a fork without a conversation of its own, and its note goes with the conversation it gets', async () => {
  const SID_C = 'a3c2cf68-2929-4166-9a00-000000000001'
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const head = { kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'head', claudeSessionId: SID_A }
  const fork = { kind: 'claude', profile: TEST_SHELL, cwd: work, title: 'fork', claudeSessionId: SID_B, fork: { of: 0, from: SID_A } }
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [head, fork] }))
  writeFileSync(join(dataDir, 'session-notes.json'), JSON.stringify({ [SID_B]: { text: 'fork note', shown: true, form: 'card' } }))
  const { app, page, pipeName } = await launchApp({ dataDir, env: { CLAUDE_CONFIG_DIR: config } })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const f = (await page.evaluate(() => window.__ct!.tabIds()))[1]!
  await expect.poll(() => bufferText(page, f), { timeout: 15_000 }).toContain(`--resume ${SID_A} --fork-session`)

  // the fork is forked again from its head: the note it had comes with it
  await page.evaluate((id) => window.ct.activateTab(id), f)
  await expect(page.locator('#note .note-card .note-text')).toHaveValue('fork note')

  // the fork's own SessionStart: the note is stored under the new conversation, and the old entry is gone
  await sessionStarts(pipeName, f, SID_C, 'fork', null)
  await app.close()
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-notes.json'), 'utf8')) as Record<string, { text: string }>
  expect(saved[SID_C]?.text).toBe('fork note')
  expect(saved).not.toHaveProperty(SID_B)
})

/** the settings of the left panel, with a default folder outside git so the tabs of the test are in No project */
const leftSettings = (): object => ({ ...FAKE_CLAUDE_SETTINGS, defaultFolder: mkdtempSync(join(tmpdir(), 'ct-folder-')), tabs: { position: 'left' } })

const panelRow = (page: Page, id: string): Locator => page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"]`)

/** right-clicks the tab's row and picks its Fork session item */
async function forkFromMenu(page: Page, row: Locator): Promise<void> {
  await row.click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Fork session' }).click()
}

test('the tab menu forks a Claude tab, and the fork shows as one', async () => {
  const { app, page, pipeName, config, work, tabId: a } = await startWithClaudeTab(leftSettings())
  await panelRow(page, a).click({ button: 'right' })
  await expect(page.locator('.menu-item', { hasText: 'Fork session' })).toHaveClass(/disabled/)
  await page.keyboard.press('Escape')
  await page.mouse.click(300, 300)

  await sessionStarts(pipeName, a, SID_A, 'startup', writeTranscript(config, work, SID_A))
  await expect.poll(() => page.evaluate((id) => window.ct.canForkTab(id), a)).toBe(true)
  const parentTitle = (await page.evaluate((id) => window.__ct!.tabTitle(id), a))!
  await forkFromMenu(page, panelRow(page, a))
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const f = (await page.evaluate(() => window.__ct!.tabIds()))[1]!
  // the fork's title is the folder's until its shell has set one of its own
  await expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle(id), f)).toBe(`${parentTitle} (fork)`)

  await expect(panelRow(page, f)).toBeVisible()
  expect(await page.locator('#tabpanel .tp-tab').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tabId))).toEqual([a, f])
  expect(await panelRow(page, f).evaluate((el) => el.classList.contains('fork'))).toBe(true)
  await app.close()
})

test("a renamed tab's fork starts with its name", async () => {
  const { app, page, pipeName, config, work, tabId: a } = await startWithClaudeTab(leftSettings())
  await sessionStarts(pipeName, a, SID_A, 'startup', writeTranscript(config, work, SID_A))
  await expect.poll(() => page.evaluate((id) => window.ct.canForkTab(id), a)).toBe(true)
  await panelRow(page, a).dblclick()
  await page.locator('.tab-rename').fill('auth refactor')
  await page.keyboard.press('Enter')
  await expect(panelRow(page, a).locator('.tab-title')).toHaveText('auth refactor')

  await forkFromMenu(page, panelRow(page, a))
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const f = (await page.evaluate(() => window.__ct!.tabIds()))[1]!
  expect(await page.evaluate((id) => window.__ct!.tabTitle(id), f)).toBe('auth refactor (fork)')
  await app.close()
})

test('closing the head leaves its forks as ordinary rows that keep (fork)', async () => {
  const { app, page, pipeName, config, work, tabId: a } = await startWithClaudeTab(leftSettings())
  await sessionStarts(pipeName, a, SID_A, 'startup', writeTranscript(config, work, SID_A))
  await expect.poll(() => page.evaluate((id) => window.ct.canForkTab(id), a)).toBe(true)
  const parentTitle = (await page.evaluate((id) => window.__ct!.tabTitle(id), a))!
  await forkFromMenu(page, panelRow(page, a))
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const f = (await page.evaluate(() => window.__ct!.tabIds()))[1]!
  await expect(panelRow(page, f)).toHaveClass(/fork/)

  await panelRow(page, a).hover()
  await panelRow(page, a).locator('.tab-close').click()
  await page.waitForFunction((id) => !window.__ct!.tabIds().includes(id), a)
  await expect(panelRow(page, f)).toBeVisible()
  expect(await panelRow(page, f).evaluate((el) => el.classList.contains('fork'))).toBe(false)
  await expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle(id), f)).toBe(`${parentTitle} (fork)`)
  await app.close()
})

test('on top, a new fork stands after its family', async () => {
  const { app, page, pipeName, config, work, tabId: a } = await startWithClaudeTab()
  await sessionStarts(pipeName, a, SID_A, 'startup', writeTranscript(config, work, SID_A))
  await openShellTab(page, work)
  const b = (await page.evaluate(() => window.__ct!.tabIds()))[1]!

  await page.evaluate((id) => window.ct.forkTab(id), a)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  await page.evaluate((id) => window.ct.forkTab(id), a)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 4)
  const [head, f1, f2, last] = await page.evaluate(() => window.__ct!.tabIds())
  expect([head, last]).toEqual([a, b])
  expect(await page.locator('#tabbar .tab').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tabId))).toEqual([a, f1, f2, b])
  // a fork's title is its own shell's title or the folder's, with the suffix: the shell's title may arrive later
  for (const f of [f1!, f2!]) expect(await page.evaluate((id) => window.__ct!.tabTitle(id), f)).toMatch(/ \(fork\)$/)
  await app.close()
})

test('a request to open a tab cannot make it a fork: only Fork session does', async () => {
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tab = await page.evaluate(([cwd, from]) => window.ct.openTab({ kind: 'claude', cwd, fork: { of: null, from } }), [work, SID_A] as const)
  const id = tab!.id
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain('fake-claude')
  expect(await bufferText(page, id)).not.toContain('--fork-session')
  await app.close()
})
