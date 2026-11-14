import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitRepo, gitWorktree } from './helpers'
import { launchChatTab, sendMessage } from './chat-helpers'
import { sendPipeMessage } from '../../src/shared/pipe-client'

const row = (page: Page, id: string): Locator => page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"]`)

test("a chat tab follows its session into a worktree Claude entered, and back out: its row shows that folder's branch", async () => {
  const repo = gitRepo()
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const worktree = gitWorktree(repo, 'feat/entered')
  const { app, page, tabId } = await launchChatTab({
    turns: {
      enter: [
        { tool: { name: 'EnterWorktree', input: { path: worktree }, result: `Switched to worktree ${worktree}`, output: { worktreePath: worktree, worktreeBranch: 'feat/entered', message: 'switched' } } },
        { text: 'entered' },
      ],
      leave: [
        { tool: { name: 'ExitWorktree', input: { action: 'keep' }, result: 'Left the worktree', output: { action: 'keep', originalCwd: repo, worktreePath: worktree, message: 'left' } } },
        { text: 'left' },
      ],
    },
  }, { work: repo, tabs: { position: 'left' } })
  try {
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText(branch, { timeout: 15_000 })

    await sendMessage(page, 'enter')
    await expect(page.locator('.chat-column')).toContainText('entered', { timeout: 30_000 })
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText('feat/entered', { timeout: 15_000 })

    await sendMessage(page, 'leave')
    await expect(page.locator('.chat-column')).toContainText('left', { timeout: 30_000 })
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText(branch, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test("the Changes panel of a chat tab that followed its session into a worktree shows the worktree's changes, not the main checkout's", async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/entered')
  writeFileSync(join(repo, 'a.ts'), 'one\nMAIN\nthree\n')
  writeFileSync(join(worktree, 'a.ts'), 'one\nWORKTREE\nthree\n')
  // the panel stands beside the chat even where the window cannot grow for it (a small screen), so the message box stays in reach
  const { app, page, tabId } = await launchChatTab({
    turns: {
      enter: [
        { tool: { name: 'EnterWorktree', input: { path: worktree }, result: `Switched to worktree ${worktree}`, output: { worktreePath: worktree, worktreeBranch: 'feat/entered', message: 'switched' } } },
        { text: 'entered' },
      ],
    },
  }, { work: repo, tabs: { position: 'left' }, sidePanel: { noRoom: 'narrow' } })
  try {
    const added = page.locator('.review-file[data-path="a.ts"] .review-line.add .review-code')
    await page.locator('#sheet-header .tab-changes-toggle').click()
    await expect(added).toHaveText('MAIN', { timeout: 15_000 })
    await sendMessage(page, 'enter')
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText('feat/entered', { timeout: 30_000 })
    await expect(added).toHaveText('WORKTREE', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test("a chat tab whose Claude Code starts in the session's worktree (a session resumed there) shows the worktree's branch from its first turn", async () => {
  const repo = gitRepo()
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const worktree = gitWorktree(repo, 'feat/resumed')
  // the tab opens in the main checkout, as a restored tab does; Claude Code goes back into the worktree the session had entered
  const { app, page, tabId } = await launchChatTab({ cwd: worktree, turns: { hi: [{ text: 'hello' }] } }, { work: repo, tabs: { position: 'left' } })
  try {
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText(branch, { timeout: 15_000 })
    await sendMessage(page, 'hi')
    await expect(page.locator('.chat-column')).toContainText('hello', { timeout: 30_000 })
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText('feat/resumed', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

const RESUMED = '7c1f2e90-5b3a-4d6e-8a41-9e0d2c7b6a15'

test("a restored chat tab follows the folder its session's SessionStart names (Claude Code is back in the worktree) before any message is sent", async () => {
  const repo = gitRepo()
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const worktree = gitWorktree(repo, 'feat/resumed')
  const { app, page, tabId, pipeName } = await launchChatTab({ cwd: worktree, turns: {} }, { work: repo, tabs: { position: 'left' } })
  try {
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText(branch, { timeout: 15_000 })
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: RESUMED, source: 'resume', transcriptPath: null, cwd: worktree })).toEqual({ ok: true })
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText('feat/resumed', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test("a path in the chat that is a file only in the session's worktree becomes a link when the SessionStart moves the tab there, with no new turn", async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/resumed')
  mkdirSync(join(worktree, 'docs'))
  writeFileSync(join(worktree, 'docs', 'wt-only.md'), '# Only here\n')
  const { app, page, tabId, pipeName } = await launchChatTab({ turns: { hi: [{ text: 'See docs/wt-only.md for it.' }] } }, { work: repo, tabs: { position: 'left' } })
  try {
    await sendMessage(page, 'hi')
    await expect(page.locator('.chat-text')).toContainText('docs/wt-only.md', { timeout: 30_000 })
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    const sessionId = (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))!.state.sessionId!
    // in the main checkout the name is no file: it stays text
    await page.waitForTimeout(500)
    await expect(page.locator('.chat-text .chat-file-link')).toHaveCount(0)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source: 'resume', transcriptPath: null, cwd: worktree })).toEqual({ ok: true })
    await expect(page.locator('.chat-text .chat-file-link')).toHaveText('docs/wt-only.md', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test("a SessionStart of a compaction or a clear moves no chat tab: its folder is where a Bash cd looked around, not the session's", async () => {
  const repo = gitRepo()
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const worktree = gitWorktree(repo, 'feat/resumed')
  const { app, page, tabId, pipeName } = await launchChatTab({ turns: {} }, { work: repo, tabs: { position: 'left' } })
  try {
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText(branch, { timeout: 15_000 })
    for (const [source, sessionId] of [['compact', RESUMED], ['clear', '2b9d4f61-0c7e-4a85-b3d2-6f18e5a90c47']] as const) {
      expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source, transcriptPath: null, cwd: worktree })).toEqual({ ok: true })
      await expect.poll(() => page.evaluate((id) => window.ct.chatSnapshot(id).then((s) => s?.state.sessionId ?? null), tabId)).toBe(sessionId)
    }
    await page.waitForTimeout(500)
    await expect(row(page, tabId).locator('.tp-branch')).toHaveText(branch)
  } finally {
    await app.close()
  }
})
