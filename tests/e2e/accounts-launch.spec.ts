import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { chatReady, sendMessage } from './chat-helpers'
import { launchAccounts, loginEntry, runs, signedIn, SID, STUDIO, tokenEntry, trust, WORK } from './account-helpers'

const KEY = 'e2e-api-key-0001'
const ENV_TOKEN = 'e2e-env-token-0001'
const TOKEN_ID = '2f9d1e7c-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const TOKEN = 'e2e-token-token-0000001'

/** the conversation runs of the stand-in: not the auth checks, nor the --version probe a new Claude tab starts */
const claudeRuns = (log: () => Record<string, unknown>[]) => runs(log).filter((r) => r.argv[0] !== 'auth' && r.argv[0] !== '--version')

/** the sign-in account Work: a folder under the accounts folder, signed in as Work, trusting the tests' work folder */
function workAccount(root: string): object[] {
  const folder = join(root, 'accounts', 'work')
  mkdirSync(folder, { recursive: true })
  signedIn(folder)
  trust(folder, join(root, 'work'))
  return [loginEntry(WORK, 'Work', folder)]
}

/** the sign-in account Studio: a folder with no sign-in */
function studioAccount(root: string): object[] {
  const folder = join(root, 'accounts', 'studio')
  mkdirSync(folder, { recursive: true })
  return [loginEntry(STUDIO, 'Studio', folder)]
}

/** the name Claude Code keeps a folder's conversations under: its real path, every character but letters and digits as - */
function projectOf(folder: string): string {
  return realpathSync.native(folder).replace(/[^A-Za-z0-9]/g, '-')
}

/** the arguments resume the conversation: --resume with its id, as one argument (`--resume=<id>`) or two */
function resumes(argv: string[], sid: string): boolean {
  const line = argv.join(' ')
  return line.includes('--resume') && line.includes(sid)
}

/** a wait for what a tab's process or a toast brings: the first start of a stand-in on a busy machine can take a while */
const LONG = { timeout: 15_000 }

/** the last run that is Claude's (not an auth check) is on the config folder and, with `sid`, resumes that conversation */
function lastOn(log: () => Record<string, unknown>[], config: string, sid: string): boolean {
  const last = runs(log).filter((r) => r.argv[0] !== 'auth').at(-1)
  return last !== undefined && last.config === config && resumes(last.argv, sid)
}

/** a conversation's transcript under a config folder, as the stand-in writes it; returns its path */
function transcriptIn(config: string, folder: string, id: string = SID): string {
  const dir = join(config, 'projects', projectOf(folder))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ type: 'user', cwd: realpathSync.native(folder), sessionId: id, message: { role: 'user', content: 'hello' } }) + '\n')
  return file
}

function copyPathIn(config: string, folder: string, id: string = SID): string {
  return join(config, 'projects', projectOf(folder), `${id}.jsonl`)
}

async function openClaude(page: Page, cwd: string, account: string | null): Promise<string> {
  const tab = await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd, account })
  return tab!.id
}

async function toasts(page: Page): Promise<string[]> {
  return page.locator('.toast').allTextContents()
}

async function snapshotOf(page: Page, id: string) {
  return page.evaluate((id) => window.ct.chatSnapshot(id), id)
}

async function stateOf(page: Page, name: string): Promise<string | undefined> {
  const view = await page.evaluate(() => window.ct.listAccounts())
  return view.accounts.find((a) => a.name === name)?.state ?? undefined
}

test('a Claude tab on a sign-in account runs with its folder, no token and no API key, in the terminal and in the chat', async () => {
  for (const view of ['terminal', 'chat'] as const) {
    const { app, page, work, config, root, log } = await launchAccounts({
      accounts: workAccount,
      view,
      env: { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: ENV_TOKEN }
    })
    const account = join(root, 'accounts', 'work')
    await openClaude(page, work, WORK)
    await expect.poll(() => runs(log).find((r) => r.config === account && r.argv[0] !== 'auth')).toMatchObject({ oauthToken: false, apiKey: false })
    await openClaude(page, work, null)
    await expect.poll(() => runs(log).find((r) => r.config === config && r.argv[0] !== 'auth')).toMatchObject({ apiKey: true })
    await app.close()
  }
})

test('a sign-in account that is not signed in starts its tab on Main account with a toast, and a switch to it is refused', async () => {
  const { app, page, work, config, log } = await launchAccounts({ accounts: studioAccount })
  await expect.poll(() => stateOf(page, 'Studio'), LONG).toBe('signed-out')
  await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd: work, account: STUDIO })
  await expect.poll(() => toasts(page), LONG).toContain('Account "Studio" is not available; the tab started on the main account')
  // the tab runs on Main account: its run has Main's config folder
  await expect.poll(() => claudeRuns(log).at(-1), LONG).toMatchObject({ config })
  await expect(page.locator('#statusbar .status-account .status-text')).toHaveText('Main account')
  const main = await openClaude(page, work, null)
  await expect.poll(() => claudeRuns(log).length, LONG).toBe(2)
  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id: main, account: STUDIO })
  await expect.poll(() => toasts(page), LONG).toContain('Account "Studio" is not available')
  // the refused switch starts no run
  await page.waitForTimeout(2000)
  expect(claudeRuns(log).length).toBe(2)
  await app.close()
})

test('a sign-in account whose folder is gone starts its tab on Main account with the same toast', async () => {
  const { app, page, work, config, log } = await launchAccounts({ accounts: (root) => [loginEntry(STUDIO, 'Studio', join(root, 'accounts', 'studio'))] })
  await expect.poll(() => stateOf(page, 'Studio'), LONG).toBe('missing')
  await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd: work, account: STUDIO })
  await expect.poll(() => toasts(page), LONG).toContain('Account "Studio" is not available; the tab started on the main account')
  await expect.poll(() => claudeRuns(log).at(-1), LONG).toMatchObject({ config })
  await app.close()
})

test("a token tab's conversation that went further on Work is refused, not copied over Main's", async () => {
  const { app, page, work, config, root, log } = await launchAccounts({
    accounts: (root) => [...workAccount(root), tokenEntry(TOKEN_ID, 'Token', TOKEN)],
    view: 'chat',
    script: { turns: { hello: [{ text: 'Hi there' }] } }
  })
  const account = join(root, 'accounts', 'work')
  const id = await openClaude(page, work, TOKEN_ID)
  await chatReady(page)
  await sendMessage(page, 'hello')
  await expect.poll(async () => (await snapshotOf(page, id))?.state.sessionId ?? null).not.toBeNull()
  const sessionId = (await snapshotOf(page, id))!.state.sessionId!
  const mainCopy = copyPathIn(config, work, sessionId)
  await expect.poll(() => existsSync(mainCopy)).toBe(true)
  // Work's copy went on an hour later than the copy in Main account's folder, where the token tab's conversation lives
  const workCopy = copyPathIn(account, work, sessionId)
  mkdirSync(join(account, 'projects', projectOf(work)), { recursive: true })
  writeFileSync(workCopy, readFileSync(mainCopy))
  const later = Date.now() / 1000 + 3600
  utimesSync(workCopy, later, later)

  const before = claudeRuns(log).length
  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: WORK })
  await expect.poll(() => toasts(page), LONG).toContain('This conversation went further on Work; open it from Recent sessions')
  await page.waitForTimeout(2000)
  expect(claudeRuns(log).length).toBe(before)
  await app.close()
})

test('a chat whose copy fails says Session restarted in its divider, and goes on as the old account', async () => {
  const { app, page, work, config, root, log } = await launchAccounts({
    accounts: workAccount,
    view: 'chat',
    script: { turns: { hello: [{ text: 'Hi there' }] } }
  })
  const account = join(root, 'accounts', 'work')
  // the target's project folder is a file: the copy cannot be made
  mkdirSync(join(account, 'projects'), { recursive: true })
  writeFileSync(join(account, 'projects', projectOf(work)), 'not a folder')
  const id = await openClaude(page, work, null)
  await chatReady(page)
  await sendMessage(page, 'hello')
  await expect.poll(async () => (await snapshotOf(page, id))?.state.sessionId ?? null).not.toBeNull()
  const sessionId = (await snapshotOf(page, id))!.state.sessionId!
  await expect.poll(() => existsSync(copyPathIn(config, work, sessionId))).toBe(true)

  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: WORK })
  await expect.poll(async () => (await toasts(page)).some((t) => /^Could not copy the conversation to Work: .+\. The tab goes on as Main account\.$/.test(t)), LONG).toBe(true)
  await expect.poll(async () => (await snapshotOf(page, id))?.items.some((i) => i.kind === 'divider' && i.text === 'Session restarted'), LONG).toBe(true)
  expect((await snapshotOf(page, id))!.items.some((i) => i.kind === 'divider' && i.text === 'Continued as Work')).toBe(false)
  await expect.poll(() => lastOn(log, config, sessionId), LONG).toBe(true)
  await app.close()
})

test("Continue as Work copies the conversation into Work's folder and resumes it there", async () => {
  const { app, page, work, config, root, log } = await launchAccounts({
    accounts: workAccount,
    view: 'chat',
    script: { turns: { hello: [{ text: 'Hi there' }] } }
  })
  const account = join(root, 'accounts', 'work')
  const id = await openClaude(page, work, null)
  await chatReady(page)
  await sendMessage(page, 'hello')
  await expect.poll(async () => (await snapshotOf(page, id))?.state.sessionId ?? null).not.toBeNull()
  const sessionId = (await snapshotOf(page, id))!.state.sessionId!
  const mainCopy = copyPathIn(config, work, sessionId)
  await expect.poll(() => existsSync(mainCopy)).toBe(true)

  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: WORK })
  await expect.poll(async () => (await snapshotOf(page, id))?.items.some((i) => i.kind === 'divider' && i.text === 'Continued as Work')).toBe(true)
  await expect.poll(() => lastOn(log, account, sessionId), LONG).toBe(true)
  expect(readFileSync(copyPathIn(account, work, sessionId)).equals(readFileSync(mainCopy))).toBe(true)
  await app.close()
})

test("Continue as is refused when Work's copy went further, and nothing changes", async () => {
  const { app, page, work, config, root, log } = await launchAccounts({
    accounts: workAccount,
    view: 'chat',
    script: { turns: { hello: [{ text: 'Hi there' }] } }
  })
  const account = join(root, 'accounts', 'work')
  const id = await openClaude(page, work, null)
  await chatReady(page)
  await sendMessage(page, 'hello')
  await expect.poll(async () => (await snapshotOf(page, id))?.state.sessionId ?? null).not.toBeNull()
  const sessionId = (await snapshotOf(page, id))!.state.sessionId!
  const mainCopy = copyPathIn(config, work, sessionId)
  await expect.poll(() => existsSync(mainCopy)).toBe(true)
  // Work's copy went on an hour later than Main's
  const workCopy = copyPathIn(account, work, sessionId)
  mkdirSync(join(account, 'projects', projectOf(work)), { recursive: true })
  writeFileSync(workCopy, readFileSync(mainCopy))
  const later = Date.now() / 1000 + 3600
  utimesSync(workCopy, later, later)

  const before = runs(log).filter((r) => r.argv[0] !== 'auth').length
  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: WORK })
  await expect.poll(() => toasts(page), LONG).toContain('This conversation went further on Work; open it from Recent sessions')
  await expect(page.locator('#statusbar .status-account .status-text')).toHaveText('Main account')
  await page.waitForTimeout(2000)
  expect(runs(log).filter((r) => r.argv[0] !== 'auth').length).toBe(before)
  await app.close()
})

test('moving back to Main account without new messages resumes there', async () => {
  const { app, page, work, config, root, log } = await launchAccounts({
    accounts: workAccount,
    view: 'chat',
    script: { turns: { hello: [{ text: 'Hi there' }] } }
  })
  const account = join(root, 'accounts', 'work')
  const id = await openClaude(page, work, null)
  await chatReady(page)
  await sendMessage(page, 'hello')
  await expect.poll(async () => (await snapshotOf(page, id))?.state.sessionId ?? null).not.toBeNull()
  const sessionId = (await snapshotOf(page, id))!.state.sessionId!
  await expect.poll(() => existsSync(copyPathIn(config, work, sessionId))).toBe(true)

  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: WORK })
  await expect.poll(() => lastOn(log, account, sessionId), LONG).toBe(true)
  await page.evaluate((id) => window.ct.switchAccount(id, null), id)
  await expect.poll(() => lastOn(log, config, sessionId), LONG).toBe(true)
  const shown = await toasts(page)
  expect(shown.some((t) => t.includes('went further') || t.includes('Could not copy'))).toBe(false)
  await expect(page.locator('#statusbar .status-account .status-text')).toHaveText('Main account')
  await app.close()
})

test("a restart of a Work tab whose conversation is only in Main's folder copies it first", async () => {
  const { app, page, pipeName, work, config, root, log } = await launchAccounts({ accounts: workAccount })
  const account = join(root, 'accounts', 'work')
  const id = await openClaude(page, work, WORK)
  await expect.poll(() => runs(log).filter((r) => r.argv[0] !== 'auth').length, LONG).toBeGreaterThan(0)
  const mainFile = transcriptIn(config, work)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: id, sessionId: SID, source: 'startup', transcriptPath: mainFile })).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.restartTab(id, true), id)
  await expect.poll(() => existsSync(copyPathIn(account, work))).toBe(true)
  expect(readFileSync(copyPathIn(account, work)).equals(readFileSync(mainFile))).toBe(true)
  await expect.poll(() => lastOn(log, account, SID), LONG).toBe(true)
  await app.close()
})

test("a Main account tab whose newest copy is on Work gets it under Main's projects when it resumes", async () => {
  const { app, page, pipeName, work, config, root, log } = await launchAccounts({ accounts: workAccount })
  const account = join(root, 'accounts', 'work')
  const workFile = transcriptIn(account, work)
  const id = await openClaude(page, work, null)
  await expect.poll(() => runs(log).filter((r) => r.argv[0] !== 'auth').length, LONG).toBeGreaterThan(0)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: id, sessionId: SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  await page.evaluate((id) => window.ct.restartTab(id, true), id)
  await expect.poll(() => existsSync(copyPathIn(config, work))).toBe(true)
  expect(readFileSync(copyPathIn(config, work)).equals(readFileSync(workFile))).toBe(true)
  await expect.poll(() => lastOn(log, config, SID), LONG).toBe(true)
  await app.close()
})

test('a copy that fails goes on as the old account and says why', async () => {
  const { app, page, pipeName, work, config, root, log } = await launchAccounts({ accounts: workAccount })
  const account = join(root, 'accounts', 'work')
  const mainFile = transcriptIn(config, work)
  // the target's project folder is a file: the copy cannot be made
  mkdirSync(join(account, 'projects'), { recursive: true })
  writeFileSync(join(account, 'projects', projectOf(work)), 'not a folder')
  const id = await openClaude(page, work, null)
  await expect.poll(() => runs(log).filter((r) => r.argv[0] !== 'auth').length, LONG).toBeGreaterThan(0)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: id, sessionId: SID, source: 'startup', transcriptPath: mainFile })).toEqual({ ok: true })
  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: WORK })
  await expect.poll(async () => (await toasts(page)).some((t) => /^Could not copy the conversation to Work: .+\. The tab goes on as Main account\.$/.test(t)), LONG).toBe(true)
  await expect.poll(() => lastOn(log, config, SID), LONG).toBe(true)
  await app.close()
})

test('a chat on an account that ends with an error checks its sign-in again', async () => {
  const { app, page, work, root } = await launchAccounts({
    accounts: workAccount,
    view: 'chat',
    script: { turns: {}, beforeInit: [{ crash: 1 }] }
  })
  const account = join(root, 'accounts', 'work')
  await expect.poll(() => stateOf(page, 'Work'), LONG).toBe('ready')
  rmSync(join(account, '.credentials.json'))
  await openClaude(page, work, WORK)
  await expect.poll(() => stateOf(page, 'Work'), LONG).toBe('signed-out')
  await app.close()
})
