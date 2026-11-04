import { expect, test, type Page } from '@playwright/test'
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
async function startWithClaudeTab() {
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: { CLAUDE_CONFIG_DIR: config } })
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
