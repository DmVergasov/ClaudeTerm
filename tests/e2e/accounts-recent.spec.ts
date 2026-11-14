import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { KEYS } from './helpers'
import { launchAccounts, loginEntry, runs, signedIn, STUDIO, trust, WORK } from './account-helpers'

// Invented session ids: the conversations of Main account and of Work
const MAIN_ONLY = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const WORK_ONLY = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'

/** a wait for what a tab's process or the account list brings: a busy machine can take a while */
const LONG = { timeout: 15_000 }

/** the sign-in account Work: a folder under the accounts folder, signed in as Work, trusting the tests' work folder */
function workAccount(root: string): object[] {
  const folder = workFolder(root)
  mkdirSync(folder, { recursive: true })
  signedIn(folder)
  trust(folder, join(root, 'work'))
  return [loginEntry(WORK, 'Work', folder)]
}

/** the sign-in account Studio: a folder with no sign-in, so it is signed out */
function studioAccount(root: string): object[] {
  const folder = join(root, 'accounts', 'studio')
  mkdirSync(folder, { recursive: true })
  return [loginEntry(STUDIO, 'Studio', folder)]
}

function workFolder(root: string): string {
  return join(root, 'accounts', 'work')
}

/** a conversation's transcript under a config folder's projects, last changed `minutesAgo` minutes ago; returns its path */
function writeConversation(config: string, cwd: string, id: string, minutesAgo: number): string {
  const real = realpathSync.native(cwd)
  const dir = join(config, 'projects', real.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ type: 'user', cwd: real, entrypoint: 'cli', isSidechain: false, sessionId: id, message: { role: 'user', content: 'hello' } }) + '\n')
  const at = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(file, at, at)
  return file
}

/** the last run that is Claude's (not an auth check nor a version probe) is on the config folder and resumes the conversation */
function lastOn(log: () => Record<string, unknown>[], config: string, sid: string): boolean {
  const last = runs(log).filter((r) => r.argv[0] !== 'auth' && r.argv[0] !== '--version').at(-1)
  return last !== undefined && last.config === config && last.argv.join(' ').includes('--resume') && last.argv.join(' ').includes(sid)
}

/** Recent sessions open, from the terminal's keyboard shortcut */
async function openRecent(page: Page): Promise<void> {
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press(KEYS.recentSessions)
  await expect(page.locator('#sessions')).toBeVisible()
}

function row(page: Page, id: string) {
  return page.locator(`#sessions .session-row[data-id="${id}"]`)
}

test("Work's sessions carry its chip, Main account's none, and the search finds work", async () => {
  const { app, page, config, root } = await launchAccounts({ accounts: workAccount })
  // both in an invented folder that does not contain the word "work", so the search can only match the account
  const notes = join(root, 'notes')
  mkdirSync(notes, { recursive: true })
  writeConversation(config, notes, MAIN_ONLY, 10)
  writeConversation(workFolder(root), notes, WORK_ONLY, 5)
  await openRecent(page)
  await expect(page.locator('#sessions .session-row')).toHaveCount(2, LONG)
  await expect(page.locator('#sessions .sessions-search')).toHaveAttribute('placeholder', 'Search by title, folder, message or account')
  await expect(row(page, WORK_ONLY).locator('.session-account-name')).toHaveText('Work')
  await expect(row(page, MAIN_ONLY).locator('.session-account')).toHaveCount(0)

  await page.locator('#sessions .sessions-search').fill('work')
  await expect(page.locator('#sessions .session-row')).toHaveCount(1)
  await expect(row(page, WORK_ONLY)).toBeVisible()
  await app.close()
})

test('opening a Work session starts it on Work', async () => {
  const { app, page, work, root, log } = await launchAccounts({ accounts: workAccount })
  const account = workFolder(root)
  writeConversation(account, work, WORK_ONLY, 5)
  await openRecent(page)
  await row(page, WORK_ONLY).click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expect.poll(() => lastOn(log, account, WORK_ONLY), LONG).toBe(true)
  await app.close()
})

test("Open as Work in a row's menu moves the conversation and resumes it there", async () => {
  const { app, page, work, config, root, log } = await launchAccounts({ accounts: workAccount })
  const account = workFolder(root)
  const mainCopy = writeConversation(config, work, MAIN_ONLY, 5)
  await openRecent(page)
  await row(page, MAIN_ONLY).click({ button: 'right' })
  await page.locator('.menu .menu-item', { hasText: 'Open as Work' }).click()
  await expect.poll(() => lastOn(log, account, MAIN_ONLY), LONG).toBe(true)
  expect(existsSync(join(account, 'projects', basename(dirname(mainCopy)), `${MAIN_ONLY}.jsonl`))).toBe(true)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await app.close()
})

test('Open as a not-signed-in account is disabled with (sign in again)', async () => {
  const { app, page, work, config } = await launchAccounts({ accounts: (r) => [...workAccount(r), ...studioAccount(r)] })
  writeConversation(config, work, MAIN_ONLY, 5)
  await expect.poll(async () => (await page.evaluate(() => window.ct.listAccounts())).accounts.find((a) => a.name === 'Studio')?.state, LONG).toBe('signed-out')
  await openRecent(page)
  await row(page, MAIN_ONLY).click({ button: 'right' })
  const studio = page.locator('.menu .menu-item', { hasText: 'Open as Studio (sign in again)' })
  await expect(studio).toHaveClass(/disabled/)
  await studio.click()
  // a disabled item does nothing: the menu stays open and no tab starts
  await expect(page.locator('.menu')).toBeVisible()
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  await app.close()
})

test('Escape closes the row menu and keeps Recent sessions open', async () => {
  const { app, page, work, config } = await launchAccounts({ accounts: workAccount })
  writeConversation(config, work, MAIN_ONLY, 5)
  await openRecent(page)
  await row(page, MAIN_ONLY).click({ button: 'right' })
  await expect(page.locator('.menu .menu-item', { hasText: 'Star' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.menu')).toHaveCount(0)
  await expect(page.locator('#sessions')).toBeVisible()
  await app.close()
})
