import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { failedResultLine, toolUseLine } from '../fixtures/transcript'
import { launchChatTab, sendMessage } from './chat-helpers'
import { FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, launchApp, writeTranscript } from './helpers'

// the error Claude Code gives EnterWorktree when a WorktreeCreate hook prints no path (Claude Code 2.1.325)
const NO_PATH = 'WorktreeCreate hook failed: hook succeeded but returned no worktree path (command: echo the path to stdout; http/callback: return hookSpecificOutput.worktreePath)'
// another app's hook for every event, as a settings file holds it
const HOOK = 'node "C:/Tools/Other Terminal/resources/hooks/hook-handler.js"'
const HOOKED = { hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: HOOK }] }], WorktreeRemove: [{ hooks: [{ type: 'command', command: HOOK }] }] } }
const FAILS_UNTIL = 'EnterWorktree fails until that hook prints the worktree path or is removed'
const FAILED_ENTER = { tool: { name: 'EnterWorktree', input: { name: 'notes' }, result: NO_PATH, isError: true } }

/** from now on every toast the window adds is kept, also one that says what an earlier one said */
async function keepToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __toastLog: string[] }
    w.__toastLog = []
    new MutationObserver((records) => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) if (n instanceof HTMLElement && n.classList.contains('toast')) w.__toastLog.push(n.textContent ?? '')
    }).observe(document.getElementById('toasts')!, { childList: true })
  })
}

/** the toasts about a WorktreeCreate hook since keepToasts */
const hookWarnings = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __toastLog: string[] }).__toastLog.filter((t) => t.includes('WorktreeCreate')))

const turnIdle = (page: Page, tabId: string): Promise<void> =>
  expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')

test("a chat tab whose EnterWorktree a WorktreeCreate hook breaks gets one toast naming the hook and the account's settings file, however often Claude retries", async () => {
  const { app, page, tabId, pipeName, config, work } = await launchChatTab({
    turns: {
      hello: [{ text: 'Hi there' }],
      enter: [FAILED_ENTER, { text: 'EnterWorktree failed' }],
      again: [FAILED_ENTER, FAILED_ENTER, { text: 'It failed again' }]
    }
  }, { env: { CLAUDETERM_TEST_FEED_MAX_MS: '500' } })
  try {
    writeFileSync(join(config, 'settings.json'), JSON.stringify(HOOKED))
    await keepToasts(page)
    await sendMessage(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there', { timeout: 30_000 })
    await turnIdle(page, tabId)
    // the session's transcript is read too, as the SessionStart hook reports it: the failure it holds is the same one
    const sid = (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))!.state.sessionId!
    const transcript = join(config, 'projects', realpathSync.native(work).replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: sid, source: 'startup', transcriptPath: transcript })).toEqual({ ok: true })

    await sendMessage(page, 'enter')
    await expect(page.locator('.chat-column')).toContainText('EnterWorktree failed', { timeout: 30_000 })
    await expect.poll(() => hookWarnings(page), { timeout: 15_000 }).toHaveLength(1)
    const [warning] = await hookWarnings(page)
    expect(warning).toContain(join(config, 'settings.json'))
    expect(warning).toContain(HOOK)
    expect(warning).toContain(FAILS_UNTIL)

    await turnIdle(page, tabId)
    await sendMessage(page, 'again')
    await expect(page.locator('.chat-column')).toContainText('It failed again', { timeout: 30_000 })
    // the transcript's new lines are read meanwhile
    await page.waitForTimeout(2000)
    expect(await hookWarnings(page)).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test("a terminal Claude tab's transcript with an EnterWorktree the project's WorktreeCreate hook broke warns, naming the project's settings file; the same failure in its history does not", async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-wt-hook-'))
  const work = join(root, 'work')
  const config = join(root, 'config')
  mkdirSync(join(work, '.claude'), { recursive: true })
  mkdirSync(config, { recursive: true })
  writeFileSync(join(work, '.claude', 'settings.local.json'), JSON.stringify(HOOKED))
  const { app, page, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: { CLAUDE_CONFIG_DIR: config, CLAUDETERM_TEST_FEED_MAX_MS: '500' } })
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
    await keepToasts(page)
    const sid = '6e3b9a14-2f7c-4d58-9b01-c4a7e2d5f836'
    const transcript = writeTranscript(config, work, sid)
    // a resumed conversation: its EnterWorktree failed yesterday, before this run
    appendFileSync(transcript, [toolUseLine('old', 'EnterWorktree', { name: 'notes' }, '2026-01-05T10:00:00.000Z'), failedResultLine('old', NO_PATH, '2026-01-05T10:00:01.000Z')].join('\n') + '\n')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: sid, source: 'resume', transcriptPath: transcript })).toEqual({ ok: true })
    await page.waitForTimeout(2000)
    expect(await hookWarnings(page)).toEqual([])

    const now = new Date().toISOString()
    appendFileSync(transcript, [toolUseLine('w1', 'EnterWorktree', { name: 'notes' }, now), failedResultLine('w1', NO_PATH, now)].join('\n') + '\n')
    await expect.poll(() => hookWarnings(page), { timeout: 15_000 }).toHaveLength(1)
    const [warning] = await hookWarnings(page)
    expect(warning).toContain(join(realpathSync.native(work), '.claude', 'settings.local.json'))
    expect(warning).toContain(HOOK)
    expect(warning).toContain(FAILS_UNTIL)
  } finally {
    await app.close()
  }
})

test('an EnterWorktree that works with a WorktreeCreate hook set, or that fails for another reason, shows no warning', async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/hooked')
  const { app, page, tabId, config } = await launchChatTab({
    turns: {
      enter: [
        { tool: { name: 'EnterWorktree', input: { name: 'hooked' }, result: `Switched to worktree ${worktree}`, output: { worktreePath: worktree, worktreeBranch: 'feat/hooked', message: 'switched' } } },
        { text: 'entered' }
      ],
      other: [{ tool: { name: 'EnterWorktree', input: { name: 'more' }, result: 'Already in a worktree session', isError: true } }, { text: 'Not entered' }]
    }
  }, { work: repo })
  try {
    writeFileSync(join(config, 'settings.json'), JSON.stringify(HOOKED))
    await keepToasts(page)
    await sendMessage(page, 'enter')
    await expect(page.locator('.chat-column')).toContainText('entered', { timeout: 30_000 })
    await turnIdle(page, tabId)
    await sendMessage(page, 'other')
    await expect(page.locator('.chat-column')).toContainText('Not entered', { timeout: 30_000 })
    await page.waitForTimeout(1500)
    expect(await hookWarnings(page)).toEqual([])
  } finally {
    await app.close()
  }
})
