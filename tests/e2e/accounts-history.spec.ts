import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { chatReady } from './chat-helpers'
import { launchAccounts, loginEntry, runs, signedIn, trust, WORK } from './account-helpers'

// Invented session ids: the conversations of Main account, of Work, and of both
const MAIN_ONLY = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const WORK_ONLY = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const BOTH = '6e3d2c8b-9f50-4b4c-a2d3-e4f5a6b7c8d9'
const REFUSED = '2b3c4d5e-6f70-4a81-9b92-a3b4c5d6e7f8'
const IN_TAB = '3c4d5e6f-7081-4b92-8c03-b4c5d6e7f8a9'

/** a wait for what a tab's process or a toast brings: the first start of a stand-in on a busy machine can take a while */
const LONG = { timeout: 15_000 }

/** the sign-in account Work: a folder under the accounts folder, signed in as Work, trusting the tests' work folder */
function workAccount(root: string): object[] {
  const folder = workFolder(root)
  mkdirSync(folder, { recursive: true })
  signedIn(folder)
  trust(folder, join(root, 'work'))
  return [loginEntry(WORK, 'Work', folder)]
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
  ageFile(file, minutesAgo)
  return file
}

function ageFile(file: string, minutesAgo: number): void {
  const at = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(file, at, at)
}

/** the Recent sessions entries of one conversation: its id and the account name the list gives it (null: Main account) */
async function listed(page: Page, id: string): Promise<[string, string | null][]> {
  const list = await page.evaluate(() => window.ct.listSessions())
  return list.filter((s) => s.id === id).map((s): [string, string | null] => [s.id, s.accountName ?? null])
}

/** the last run that is Claude's (not an auth check nor a version probe) is on the config folder and resumes the conversation */
function lastOn(log: () => Record<string, unknown>[], config: string, sid: string): boolean {
  const last = runs(log).filter((r) => r.argv[0] !== 'auth' && r.argv[0] !== '--version').at(-1)
  return last !== undefined && last.config === config && last.argv.join(' ').includes('--resume') && last.argv.join(' ').includes(sid)
}

async function toasts(page: Page): Promise<string[]> {
  return page.locator('.toast').allTextContents()
}

test("Recent sessions lists the sessions of Main account and of Work, naming Work's", async () => {
  const { app, page, work, config, root } = await launchAccounts({ accounts: workAccount })
  writeConversation(config, work, MAIN_ONLY, 10)
  writeConversation(workFolder(root), work, WORK_ONLY, 5)
  await expect.poll(async () => {
    const list = await page.evaluate(() => window.ct.listSessions())
    return list.map((s) => [s.id, s.accountName ?? null])
  }, LONG).toEqual([
    [WORK_ONLY, 'Work'],
    [MAIN_ONLY, null]
  ])
  await app.close()
})

test('a conversation on both accounts is listed once, on the account it went on last', async () => {
  const { app, page, work, config, root } = await launchAccounts({ accounts: workAccount })
  const mainCopy = writeConversation(config, work, BOTH, 60)
  writeConversation(workFolder(root), work, BOTH, 1)
  await expect.poll(() => listed(page, BOTH), LONG).toEqual([[BOTH, 'Work']])
  // Main account's copy goes on later: the newest copy is then the one listed
  ageFile(mainCopy, 0)
  await expect.poll(() => listed(page, BOTH), LONG).toEqual([[BOTH, null]])
  await app.close()
})

test('opening a Work session starts it on Work', async () => {
  const { app, page, work, root, log } = await launchAccounts({ accounts: workAccount })
  const account = workFolder(root)
  writeConversation(account, work, WORK_ONLY, 5)
  await expect.poll(() => listed(page, WORK_ONLY), LONG).toEqual([[WORK_ONLY, 'Work']])
  await page.evaluate((id) => window.ct.openSession(id), WORK_ONLY)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expect.poll(() => lastOn(log, account, WORK_ONLY), LONG).toBe(true)
  await app.close()
})

test("a chat resumed on Work shows the conversation's messages from Work's own folder", async () => {
  const { app, page, work, root, log } = await launchAccounts({ accounts: workAccount, view: 'chat' })
  const account = workFolder(root)
  // the conversation's only transcript is in Work's folder: Main account's folder holds none
  const dir = join(account, 'projects', realpathSync.native(work).replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const ask = { type: 'user', uuid: '11111111-1111-4111-8111-111111111111', parentUuid: null, sessionId: WORK_ONLY, cwd: realpathSync.native(work), timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'Where is the Work log?' } }
  const answer = { type: 'assistant', uuid: '22222222-2222-4222-8222-222222222222', parentUuid: ask.uuid, sessionId: WORK_ONLY, cwd: realpathSync.native(work), timestamp: '2026-11-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'In the Work logs folder.' }] } }
  writeFileSync(join(dir, `${WORK_ONLY}.jsonl`), [ask, answer].map((l) => JSON.stringify(l)).join('\n') + '\n')
  await expect.poll(() => listed(page, WORK_ONLY), LONG).toEqual([[WORK_ONLY, 'Work']])
  await page.evaluate((id) => window.ct.openSession(id), WORK_ONLY)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await expect.poll(() => lastOn(log, account, WORK_ONLY), LONG).toBe(true)
  await chatReady(page)
  await expect(page.locator('.chat-column')).toContainText('In the Work logs folder.', LONG)
  await app.close()
})

test("Open as Work copies the conversation and resumes it there; refused when Work's copy went further", async () => {
  const { app, page, work, config, root, log } = await launchAccounts({ accounts: workAccount })
  const account = workFolder(root)
  const mainCopy = writeConversation(config, work, MAIN_ONLY, 5)
  await expect.poll(() => listed(page, MAIN_ONLY), LONG).toEqual([[MAIN_ONLY, null]])
  await page.evaluate(({ id, account }) => window.ct.openSessionAs(id, account), { id: MAIN_ONLY, account: WORK })
  await expect.poll(() => lastOn(log, account, MAIN_ONLY), LONG).toBe(true)
  expect(existsSync(join(account, 'projects', basename(dirname(mainCopy)), `${MAIN_ONLY}.jsonl`))).toBe(true)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)

  // Work's copy goes on after the list was made: newer than Main account's, so the move is refused
  writeConversation(config, work, REFUSED, 5)
  await expect.poll(() => listed(page, REFUSED), LONG).toEqual([[REFUSED, null]])
  writeConversation(account, work, REFUSED, 1)
  await page.evaluate(({ id, account }) => window.ct.openSessionAs(id, account), { id: REFUSED, account: WORK })
  await expect.poll(() => toasts(page), LONG).toContain('This conversation went further on Work; open it from Recent sessions')
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
  expect(runs(log).some((r) => r.argv.join(' ').includes(REFUSED) && r.config === account)).toBe(false)
  await app.close()
})

test('Open as for a conversation open in a tab continues that tab on the other account', async () => {
  const { app, page, work, config, root, log } = await launchAccounts({ accounts: workAccount })
  const account = workFolder(root)
  writeConversation(config, work, IN_TAB, 5)
  await expect.poll(() => listed(page, IN_TAB), LONG).toEqual([[IN_TAB, null]])
  await page.evaluate((id) => window.ct.openSession(id), IN_TAB)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const tab = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => lastOn(log, config, IN_TAB), LONG).toBe(true)

  await page.evaluate(({ id, account }) => window.ct.openSessionAs(id, account), { id: IN_TAB, account: WORK })
  await expect.poll(() => lastOn(log, account, IN_TAB), LONG).toBe(true)
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
  expect(await page.evaluate(() => window.__ct!.activeTabId())).toBe(tab)
  await app.close()
})
