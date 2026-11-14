import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CI_BOT, CI_TOKEN, hashTree, launchAccounts, loginEntry, MAIN_CREDENTIAL, MAIN_WHO, runs, signedIn, tokenEntry, trust, WORK } from './account-helpers'

// the stand-in's token in every .credentials.json it writes: FAKE_CREDENTIAL of tests/fixtures/fake-claude/install.ts (not imported: that module is ESM-only)
const FAKE_CREDENTIAL = 'fake-credential-never-shown-0001'
const SIGN_IN = 'Sign in — Work'
const LONG = { timeout: 15_000 }
const MAIN_KEY = 'sk-main-secret'
const HEADER_KEY = 'sk-header-secret'

/** the sign-in account Work's folder, signed in as Work and trusting the tests' work folder */
function workAccount(root: string): object[] {
  const folder = join(root, 'accounts', 'work')
  mkdirSync(folder, { recursive: true })
  signedIn(folder)
  trust(folder, join(root, 'work'))
  return [loginEntry(WORK, 'Work', folder)]
}

/** Main account's own setup: settings with a model and an env, a hook, an MCP server with a header, a skill and CLAUDE.md */
function mainSetup(config: string): void {
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ model: 'claude-test-model', env: { FOO: '1', ANTHROPIC_API_KEY: MAIN_KEY }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }))
  const doc = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8')) as Record<string, unknown>
  doc.mcpServers = { context7: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { 'X-Key': HEADER_KEY } } }
  writeFileSync(join(config, '.claude.json'), JSON.stringify(doc))
  mkdirSync(join(config, 'skills', 'review'), { recursive: true })
  writeFileSync(join(config, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Reviews a change\n---\nLook at the diff.\n')
  writeFileSync(join(config, 'CLAUDE.md'), 'Be brief.\n')
}

/** every text a toast showed since the watch began: the page keeps the ones it has seen */
async function watchToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __seenToasts: string[] }
    w.__seenToasts = []
    new MutationObserver(() => {
      for (const t of Array.from(document.querySelectorAll('.toast'))) {
        const text = t.textContent ?? ''
        if (!w.__seenToasts.includes(text)) w.__seenToasts.push(text)
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

async function seenToasts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __seenToasts: string[] }).__seenToasts ?? [])
}

async function flow(page: Page) {
  return page.evaluate(() => window.ct.accountFlow())
}

async function accounts(page: Page) {
  return (await page.evaluate(() => window.ct.listAccounts())).accounts
}

/** the sign-in tab's id, when one is open */
async function signInTab(page: Page, title: string = SIGN_IN): Promise<string | undefined> {
  return page.evaluate((title) => window.__ct!.tabIds().find((id) => window.__ct!.tabTitle(id) === title), title)
}

/** the text of the Settings window's files and the app's own answers: what must never hold a secret */
function everyLog(dataDir: string): string {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/^main(\.\d+)?\.log$/.test(entry.name)) out.push(readFileSync(path, 'utf8'))
    }
  }
  walk(dataDir)
  return out.join('\n')
}

const SECRETS = [FAKE_CREDENTIAL, MAIN_CREDENTIAL, MAIN_KEY, HEADER_KEY, CI_TOKEN]

test('begin add: a Sign in — Work tab runs auth login --claudeai with the new folder; released, the account is ready and its items carried', async () => {
  // the app itself has a key and a token: the sign-in must not get either
  const { app, page, work, config, root, log } = await launchAccounts({
    script: { turns: {}, auth: { work: { gate: 'go' } } },
    main: mainSetup,
    env: { ANTHROPIC_API_KEY: 'e2e-api-key-0002', CLAUDE_CODE_OAUTH_TOKEN: 'e2e-env-token-0002' }
  })
  const folder = join(root, 'accounts', 'work')
  const before = hashTree(config)
  await watchToasts(page)
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Work', email: 'work@example.com', source: null, items: ['settings', 'hooks', 'mcp', 'skills', 'memory', 'trust'], adopt: false }))).toEqual({ ok: true })

  // the sign-in tab runs in the background, and waits for the browser
  await expect.poll(() => signInTab(page), LONG).toBeDefined()
  const tab = (await signInTab(page))!
  expect(await page.evaluate(() => window.__ct!.activeTabId())).not.toBe(tab)
  await expect.poll(() => runs(log).find((r) => r.argv[0] === 'auth' && r.argv[1] === 'login'), LONG).toMatchObject({ argv: ['auth', 'login', '--claudeai', '--email', 'work@example.com'], config: folder, oauthToken: false, apiKey: false })
  expect((await flow(page))?.step).toBe('sign-in')

  // the person signs in: the tab ends, and the account is saved and its items carried
  writeFileSync(join(folder, 'go'), '')
  await expect.poll(async () => (await flow(page))?.step, LONG).toBe('done')
  await expect.poll(async () => (await flow(page))?.lines.every((l) => l.state === 'done'), LONG).toBe(true)
  expect((await flow(page))?.who).toEqual({ email: 'work@example.com', plan: 'Team plan' })
  expect((await flow(page))?.lines.map((l) => l.item)).toEqual(['settings', 'hooks', 'mcp', 'skills', 'memory', 'trust', 'claudeterm'])

  const list = await accounts(page)
  expect(list.find((a) => a.name === 'Work')).toMatchObject({ kind: 'login', state: 'ready' })
  const view = await page.evaluate(() => window.ct.listAccounts())
  expect(view.main.email).toBe(MAIN_WHO.emailAddress)

  const settings = JSON.parse(readFileSync(join(folder, 'settings.json'), 'utf8')) as { model?: string; env?: Record<string, string> }
  expect(settings.model).toBe('claude-test-model')
  expect(settings.env?.FOO).toBe('1')
  expect(settings.env?.ANTHROPIC_API_KEY).toBeUndefined()
  const claudeJson = JSON.parse(readFileSync(join(folder, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
  expect(claudeJson.mcpServers).toHaveProperty('context7')
  expect(claudeJson.mcpServers).toHaveProperty('claudeterm')
  expect(claudeJson.projects?.[realpathSync.native(work)]?.hasTrustDialogAccepted).toBe(true)
  expect(existsSync(join(folder, 'skills', 'review', 'SKILL.md'))).toBe(true)

  // Main account is read only
  expect(hashTree(config)).toBe(before)
  await expect.poll(() => signInTab(page)).toBeUndefined()
  await expect.poll(() => seenToasts(page), LONG).toEqual(expect.arrayContaining(['Account "Work" is ready: signed in as work@example.com']))
  await app.close()
})

test('Cancel during the sign-in leaves no account, no folder and no tab', async () => {
  const { app, page, root } = await launchAccounts({ script: { turns: {}, auth: { work: { gate: 'go' } } } })
  const folder = join(root, 'accounts', 'work')
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Work', email: null, source: null, items: [], adopt: false }))).toEqual({ ok: true })
  await expect.poll(() => signInTab(page), LONG).toBeDefined()
  await expect.poll(() => existsSync(folder)).toBe(true)

  await page.evaluate(() => window.ct.accountFlowAction({ kind: 'cancel' }))
  await expect.poll(() => flow(page), LONG).toBeNull()
  await expect.poll(() => signInTab(page), LONG).toBeUndefined()
  await expect.poll(() => existsSync(folder), LONG).toBe(false)
  expect((await accounts(page)).some((a) => a.name === 'Work')).toBe(false)
  await app.close()
})

test('a failed sign-in says The sign-in did not finish, and Try again opens a new tab', async () => {
  const { app, page, root, log } = await launchAccounts({ script: { turns: {}, auth: { work: { fail: 'access denied' } } } })
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Work', email: null, source: null, items: [], adopt: false }))).toEqual({ ok: true })
  await expect.poll(async () => (await flow(page))?.step, LONG).toBe('failed')
  const failed = (await flow(page))!
  expect(failed.error).toBe('The sign-in did not finish')
  expect(failed.lastLine).toContain('access denied')
  const first = (await signInTab(page))!

  await page.evaluate(() => window.ct.accountFlowAction({ kind: 'retry-sign-in' }))
  await expect.poll(async () => (await signInTab(page)) !== undefined && (await signInTab(page)) !== first, LONG).toBe(true)
  await expect.poll(() => runs(log).filter((r) => r.argv[0] === 'auth' && r.argv[1] === 'login').length, LONG).toBe(2)
  await expect.poll(async () => (await flow(page))?.step, LONG).toBe('failed')
  expect(existsSync(join(root, 'accounts', 'work', '.credentials.json'))).toBe(false)
  // quitting undoes the waiting sign-in: its folder, which ClaudeTerm made, goes
  await app.close()
  expect(existsSync(join(root, 'accounts', 'work'))).toBe(false)
})

test('closing the sign-in tab by hand ends the sign-in: auth status decides, and The sign-in did not finish shows', async () => {
  const { app, page, root } = await launchAccounts({ script: { turns: {}, auth: { work: { gate: 'go' } } } })
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Work', email: null, source: null, items: [], adopt: false }))).toEqual({ ok: true })
  await expect.poll(() => signInTab(page), LONG).toBeDefined()
  const tab = (await signInTab(page))!
  // the person closes the tab while the browser is still open: no process exit is reported for a closed tab
  await page.evaluate((id) => window.ct.closeTab(id), tab)
  await expect.poll(async () => (await flow(page))?.error, LONG).toBe('The sign-in did not finish')
  expect((await accounts(page)).some((a) => a.name === 'Work')).toBe(false)
  expect(existsSync(join(root, 'accounts', 'work', '.credentials.json'))).toBe(false)
  await app.close()
})

test('a folder ClaudeTerm made outside the accounts folder is never trashed: the account goes, the folder stays, and the problem says why', async () => {
  const { app, page, root } = await launchAccounts({
    accounts: (r) => {
      const folder = join(r, 'elsewhere', 'outside')
      mkdirSync(folder, { recursive: true })
      signedIn(folder)
      return [loginEntry(WORK, 'Work', folder)]
    },
    script: { turns: {} }
  })
  const folder = join(root, 'elsewhere', 'outside')
  expect(await page.evaluate((id) => window.ct.removeAccount(id, { signOut: false, deleteFolder: true }), WORK)).toEqual({
    ok: true,
    problems: [expect.stringContaining('Could not move the folder to the trash')]
  })
  expect((await accounts(page)).some((a) => a.id === WORK)).toBe(false)
  expect(existsSync(join(folder, '.credentials.json'))).toBe(true)
  await app.close()
})

test('an answer that cannot be read right after the sign-in is a failure: Could not confirm the sign-in, nothing saved', async () => {
  const { app, page, root, dataDir } = await launchAccounts({ script: { turns: {}, auth: { work: { gate: 'go', status: 'garbage' } } } })
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Work', email: null, source: null, items: [], adopt: false }))).toEqual({ ok: true })
  await expect.poll(() => signInTab(page), LONG).toBeDefined()
  writeFileSync(join(root, 'accounts', 'work', 'go'), '')
  await expect.poll(async () => (await flow(page))?.error, LONG).toBe('Could not confirm the sign-in')
  expect((await accounts(page)).some((a) => a.name === 'Work')).toBe(false)
  expect(readFileSync(join(dataDir, 'accounts.json'), 'utf8').includes('"Work"')).toBe(false)
  await app.close()
})

test('the same login as Main account asks, and Keep it anyway saves it', async () => {
  const { app, page, root } = await launchAccounts({
    script: { turns: {}, auth: { work: { gate: 'go', email: MAIN_WHO.emailAddress, orgUuid: MAIN_WHO.organizationUuid } } }
  })
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Work', email: null, source: null, items: [], adopt: false }))).toEqual({ ok: true })
  await expect.poll(() => signInTab(page), LONG).toBeDefined()
  writeFileSync(join(root, 'accounts', 'work', 'go'), '')
  await expect.poll(async () => (await flow(page))?.step, LONG).toBe('same-login')
  expect((await flow(page))?.sameAs).toEqual({ account: 'Main account', email: MAIN_WHO.emailAddress })

  await page.evaluate(() => window.ct.accountFlowAction({ kind: 'keep-login' }))
  await expect.poll(async () => (await flow(page))?.step, LONG).toBe('done')
  expect((await accounts(page)).find((a) => a.name === 'Work')).toMatchObject({ kind: 'login', state: 'ready' })
  await app.close()
})

test('a token account signed in instead keeps its id and loses its token', async () => {
  const { app, page, work, root, dataDir } = await launchAccounts({
    accounts: [tokenEntry(CI_BOT, 'CI Bot', CI_TOKEN)],
    script: { turns: {}, auth: { 'ci-bot': { gate: 'go' } } }
  })
  await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd: work, account: CI_BOT })
  await expect.poll(() => page.locator('#statusbar .status-account .status-text').textContent(), LONG).toBe('CI Bot')
  expect(await page.evaluate((id) => window.ct.beginAccountFlow({ mode: 'to-login', id, name: 'CI Bot', email: null, source: null, items: [], adopt: false }), CI_BOT)).toEqual({ ok: true })
  await expect.poll(() => signInTab(page, 'Sign in — CI Bot'), LONG).toBeDefined()
  writeFileSync(join(root, 'accounts', 'ci-bot', 'go'), '')
  await expect.poll(async () => (await flow(page))?.step, LONG).toBe('done')

  const list = await accounts(page)
  expect(list.find((a) => a.id === CI_BOT)).toMatchObject({ name: 'CI Bot', kind: 'login', state: 'ready' })
  const stored = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as { accounts: Record<string, unknown>[] }
  const entry = stored.accounts.find((a) => a.id === CI_BOT)
  expect(entry).toMatchObject({ kind: 'login', name: 'CI Bot' })
  expect(entry).not.toHaveProperty('token')
  expect(readFileSync(join(dataDir, 'accounts.json'), 'utf8')).not.toContain(CI_TOKEN)
  await expect(page.locator('#statusbar .status-account .status-text')).toHaveText('CI Bot')
  await app.close()
})

test('Use a folder I already have with a signed-in folder adds it without a sign-in tab', async () => {
  const { app, page, root, log, dataDir } = await launchAccounts({ script: { turns: {} } })
  const folder = join(root, 'adopted')
  mkdirSync(folder, { recursive: true })
  signedIn(folder, { emailAddress: 'home@example.com' })
  await app.evaluate(({ dialog }, path: string) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog
  }, folder)
  const picked = await page.evaluate(() => window.ct.pickAccountFolder())
  expect(picked).toMatchObject({ ok: true, path: folder, signedIn: true, email: 'home@example.com' })
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Home', email: null, source: null, items: [], adopt: true }))).toEqual({ ok: true })
  await expect.poll(async () => (await accounts(page)).some((a) => a.name === 'Home'), LONG).toBe(true)
  expect(runs(log).some((r) => r.argv[0] === 'auth' && r.argv[1] === 'login')).toBe(false)
  const saved = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as { accounts: { name: string; folder: string; created: boolean }[] }
  expect(saved.accounts.find((a) => a.name === 'Home')).toMatchObject({ folder, created: false })
  await app.close()
})

test('Remove with sign-out logs auth logout with the folder and deletes the folder', async () => {
  const { app, page, root, log } = await launchAccounts({ accounts: workAccount, script: { turns: {} } })
  const folder = join(root, 'accounts', 'work')
  const transcript = join(folder, 'projects', 'proj', '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8.jsonl')
  mkdirSync(join(folder, 'projects', 'proj'), { recursive: true })
  writeFileSync(transcript, '{}\n')
  expect(await page.evaluate((id) => window.ct.accountRemoveInfo(id), WORK)).toEqual({ kind: 'login', folder, created: true, conversations: 1, tabs: 0 })

  expect(await page.evaluate((id) => window.ct.removeAccount(id, { signOut: true, deleteFolder: true }), WORK)).toEqual({ ok: true, problems: [] })
  expect(runs(log).find((r) => r.argv[0] === 'auth' && r.argv[1] === 'logout')).toMatchObject({ config: folder })
  await expect.poll(() => existsSync(folder), LONG).toBe(false)
  expect((await accounts(page)).some((a) => a.id === WORK)).toBe(false)
  await app.close()
})

test('with a tab running on the account its folder is not removed', async () => {
  const { app, page, work, root } = await launchAccounts({ accounts: workAccount, script: { turns: {} } })
  const folder = join(root, 'accounts', 'work')
  await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd: work, account: WORK })
  await expect.poll(async () => (await page.evaluate((id) => window.ct.accountRemoveInfo(id), WORK))?.tabs, LONG).toBe(1)

  expect(await page.evaluate((id) => window.ct.removeAccount(id, { signOut: true, deleteFolder: true }), WORK)).toEqual({ ok: false, error: 'Close the 1 tab on Work to remove its folder too' })
  expect(existsSync(join(folder, '.credentials.json'))).toBe(true)
  expect((await accounts(page)).some((a) => a.id === WORK)).toBe(true)
  await app.close()
})

test('an adopted folder is never deleted', async () => {
  const { app, page, root } = await launchAccounts({ script: { turns: {} } })
  const folder = join(root, 'adopted')
  mkdirSync(folder, { recursive: true })
  signedIn(folder)
  await app.evaluate(({ dialog }, path: string) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog
  }, folder)
  await page.evaluate(() => window.ct.pickAccountFolder())
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Home', email: null, source: null, items: [], adopt: true }))).toEqual({ ok: true })
  await expect.poll(async () => (await accounts(page)).find((a) => a.name === 'Home')?.id ?? null, LONG).not.toBeNull()
  const id = (await accounts(page)).find((a) => a.name === 'Home')!.id
  await page.evaluate(() => window.ct.accountFlowAction({ kind: 'close' }))
  await expect.poll(() => flow(page), LONG).toBeNull()

  // the registration the adoption started in the folder runs on after Done: a removal waits for it (it is refused while it runs)
  await expect.poll(() => page.evaluate((a) => window.ct.removeAccount(a, { signOut: true, deleteFolder: true }), id), LONG).toEqual({ ok: true, problems: [] })
  expect((await accounts(page)).some((a) => a.id === id)).toBe(false)
  expect(existsSync(folder)).toBe(true)
  await app.close()
})

test('no secret in the log, the toasts or the accounts answers', async () => {
  const { app, page, work, root, dataDir } = await launchAccounts({
    accounts: (r) => [...workAccount(r), tokenEntry(CI_BOT, 'CI Bot', CI_TOKEN)],
    script: { turns: {}, auth: { home: { gate: 'go' } } },
    main: mainSetup
  })
  await watchToasts(page)
  const answers: string[] = []
  const keep = async (): Promise<void> => {
    answers.push(JSON.stringify(await page.evaluate(() => window.ct.listAccounts())), JSON.stringify(await flow(page)))
  }
  await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd: work, account: CI_BOT })
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Home', email: null, source: null, items: ['settings', 'hooks'], adopt: false }))).toEqual({ ok: true })
  await expect.poll(() => signInTab(page, 'Sign in — Home'), LONG).toBeDefined()
  writeFileSync(join(root, 'accounts', 'home', 'go'), '')
  await expect.poll(async () => (await flow(page))?.step, LONG).toBe('done')
  await keep()
  // Done, then the removal: a finished flow is closed first, as the Settings window's button does
  await page.evaluate(() => window.ct.accountFlowAction({ kind: 'close' }))
  await expect.poll(() => flow(page), LONG).toBeNull()
  const home = (await accounts(page)).find((a) => a.name === 'Home')!
  // the carry-over lines run on after Done: the removal waits for them (it is refused while they run)
  await expect.poll(() => page.evaluate((id) => window.ct.removeAccount(id, { signOut: true, deleteFolder: true }), home.id), LONG).toEqual({ ok: true, problems: [] })
  await keep()

  const logs = everyLog(dataDir)
  const texts = [...(await seenToasts(page)), ...answers, logs]
  for (const secret of SECRETS) {
    for (const text of texts) expect(text).not.toContain(secret)
  }
  await app.close()
})
