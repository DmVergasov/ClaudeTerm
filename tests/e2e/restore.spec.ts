import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RESUME_PROMPT } from '../../src/main/auto-continue'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { DIM, promptBox } from './claude-screen'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, makeDataDir, TEST_SHELL, typeInTerminal } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

function snapshotFile(cwd: string): string {
  return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [{ kind: 'claude', profile: TEST_SHELL, cwd, title: 'mine', claudeSessionId: SID }] })
}

test('restores a claude tab with --resume and its title', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), snapshotFile(work))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const id = await page.evaluate(() => window.__ct!.activeTabId())
  await expect.poll(() => bufferText(page, id!), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await page.evaluate((i) => window.__ct!.tabTitle(i), id!)).toBe('mine')
  expect(await page.evaluate(() => window.__ct!.restoreVisible!())).toBe(false)
  expect(existsSync(join(dataDir, 'previous-session.json'))).toBe(false)
  await app.close()
})

test('a muted tab is restored muted, and the next snapshot keeps which tabs are muted', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const tab = (title: string, muted: boolean) => ({ kind: 'claude', profile: TEST_SHELL, cwd: work, title, claudeSessionId: SID, muted })
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [tab('quiet', true), tab('loud', false)] }))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expect(page.locator('.tab', { hasText: 'quiet' }).locator('.tab-muted')).toHaveCount(1)
  await expect(page.locator('.tab', { hasText: 'loud' }).locator('.tab-muted')).toHaveCount(0)
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: { title: string; muted: boolean }[] }
  expect(saved.tabs.map((t) => [t.title, t.muted])).toEqual([['quiet', true], ['loud', false]])
})

test('closing the window keeps open tabs in the snapshot', async () => {
  const { app, page, dataDir } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: unknown[] }
  expect(saved.tabs).toHaveLength(2)
})

test('a run that ends with no tabs does not wipe the previous session', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  writeFileSync(join(dataDir, 'previous-session.json'), snapshotFile('D:\\'))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  const closed = app.waitForEvent('close')
  // closing the last tab closes the window, which can fail the click itself before it returns; the close event is the check
  await page.locator('.tab .tab-close').click().catch(() => {})
  await closed
  expect(existsSync(join(dataDir, 'previous-session.json'))).toBe(true)
  const state = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: unknown[] }
  expect(state.tabs).toEqual([])
})

function twoTabSnapshot(cwd: string): string {
  const tab = (title: string) => ({ kind: 'claude', profile: TEST_SHELL, cwd, title, claudeSessionId: SID })
  return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [tab('one'), tab('two')] })
}

test('restore replaces the untouched auto tab and does not accumulate tabs across cycles', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), twoTabSnapshot(work))
  const first = await launchApp({ dataDir })
  await first.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => first.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await first.page.locator('.banner-restore').click()
  await first.page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  expect(await first.page.evaluate(() => window.__ct!.tabTitle(window.__ct!.activeTabId()!))).toBe('one')
  await closeWindow(first.app)

  const second = await launchApp({ dataDir })
  await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect.poll(() => second.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await second.page.locator('.banner-restore').click()
  await second.page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await second.page.waitForTimeout(500)
  expect(await second.page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
  await second.app.close()
})

test('restore keeps the auto tab when the user typed into it', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), twoTabSnapshot(work))
  const { app, page } = await launchApp({ dataDir })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await typeInTerminal(page, 'echo typed-by-user')
  await expect.poll(() => bufferText(page), { timeout: 15_000 }).toContain('typed-by-user')
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  await app.close()
})

/**
 * A stand-in claude that draws Claude Code's screen with an empty prompt, so a restored tab has a prompt to type into;
 * what main would type goes to the shell after it, which echoes it into the buffer
 */
function screenClaude(): string {
  const script = join(mkdtempSync(join(tmpdir(), 'ct-screen-')), 'claude.js')
  const screen = `\x1b[H\x1b[2J${promptBox(DIM('Try "fix lint errors"')).join('\n')}\n`
  writeFileSync(script, `process.stdout.write(${JSON.stringify(screen)})\n`)
  return `node "${script}"`
}

async function restoreBusyAndIdle(continueAfterRestore: boolean): Promise<{ app: ElectronApplication; page: Page; busy: string; idle: string }> {
  const settings = { ...FAKE_CLAUDE_SETTINGS, claude: { ...FAKE_CLAUDE_SETTINGS.claude, command: screenClaude(), continueAfterRestore } }
  const dataDir = makeDataDir(settings)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const tab = (title: string, working: boolean) => ({ kind: 'claude', profile: TEST_SHELL, cwd: work, title, claudeSessionId: SID, working })
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [tab('busy', true), tab('idle', false)] }))
  const { app, page, pipeName } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const [busy, idle] = await page.evaluate(() => window.__ct!.tabIds())
  for (const id of [busy, idle]) {
    await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain('Opus 5.5')
    // Claude Code's SessionStart hook for the resumed conversation
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: id, sessionId: SID, source: 'resume', transcriptPath: null })).toEqual({ ok: true })
  }
  return { app, page, busy, idle }
}

test('a tab Claude was working in when ClaudeTerm closed goes on by itself once restored; an idle one is left alone', async () => {
  const { app, page, busy, idle } = await restoreBusyAndIdle(true)
  await expect.poll(() => bufferText(page, busy), { timeout: 20_000 }).toContain(RESUME_PROMPT)
  expect(await bufferText(page, idle)).not.toContain(RESUME_PROMPT)
  await app.close()
})

test('with continueAfterRestore off a restored tab Claude was working in is left alone', async () => {
  const { app, page, busy } = await restoreBusyAndIdle(false)
  await page.waitForTimeout(7000)
  expect(await bufferText(page, busy)).not.toContain(RESUME_PROMPT)
  await app.close()
})

test('the snapshot keeps whether Claude is working: a prompt starts a turn, its end or Esc stops it', async () => {
  const { app, page, tabId, dataDir, pipeName } = await launchClaudeTab()
  const working = (): boolean | undefined => {
    if (!existsSync(join(dataDir, 'session-state.json'))) return undefined
    const saved = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: { working?: boolean }[] }
    return saved.tabs[0]?.working
  }
  const turn = { v: 1, type: 'turn', tabId, sessionId: SID, cwd: null } as const
  expect(await sendPipeMessage(pipeName, turn)).toEqual({ ok: true })
  await expect.poll(working).toBe(true)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
  await expect.poll(working).toBe(false)
  expect(await sendPipeMessage(pipeName, turn)).toEqual({ ok: true })
  await expect.poll(working).toBe(true)
  await page.evaluate((id) => window.ct.writePty(id, '\x1b'), tabId)
  await expect.poll(working).toBe(false)
  await app.close()
})
