import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitRepo, gitWorktree } from './helpers'
import { launchChatTab, sendMessage } from './chat-helpers'

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
