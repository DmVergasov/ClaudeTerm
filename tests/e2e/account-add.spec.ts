import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CI_BOT, CI_TOKEN, hashTree, launchAccounts, loginEntry, MAIN_CREDENTIAL, MAIN_WHO, runs, settingsWindow, signedIn, STUDIO, tokenEntry, trust, WORK } from './account-helpers'
import { showSettingsTab } from './helpers'

// the stand-in's token in every .credentials.json it writes: FAKE_CREDENTIAL of tests/fixtures/fake-claude/install.ts (not imported: that module is ESM-only)
const FAKE_CREDENTIAL = 'fake-credential-never-shown-0001'
const MAIN_KEY = 'sk-main-secret'
const HEADER_KEY = 'sk-header-secret'
const SECRETS = [FAKE_CREDENTIAL, MAIN_CREDENTIAL, MAIN_KEY, HEADER_KEY, CI_TOKEN]
const LONG = { timeout: 15_000 }

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

/** a sign-in account Work, its folder signed in as the stand-in's work account and trusting the tests' work folder */
function workEntry(root: string): object[] {
  const folder = join(root, 'accounts', 'work')
  mkdirSync(folder, { recursive: true })
  signedIn(folder)
  trust(folder, join(root, 'work'))
  return [loginEntry(WORK, 'Work', folder)]
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
async function signInTab(page: Page, title: string = 'Sign in — Work'): Promise<string | undefined> {
  return page.evaluate((title) => window.__ct!.tabIds().find((id) => window.__ct!.tabTitle(id) === title), title)
}

/** the Settings window, on its Accounts page */
async function accountsWindow(app: ElectronApplication, page: Page): Promise<Page> {
  const win = await settingsWindow(app, page)
  await showSettingsTab(win, 'accounts')
  return win
}

/** the row of an extra account, by its name */
const row = (win: Page, name: string) => win.locator('.account-row[data-account]', { has: win.locator('.account-name', { hasText: new RegExp(`^${name}$`) }) })

/** the helper's box, while it is open */
const helper = (win: Page) => win.locator('.account-dialog')

/** starts an add with a name and an email from the Accounts page: Add account…, then Name and Email */
async function fillAdd(win: Page, name: string, email: string | null): Promise<void> {
  await win.getByRole('button', { name: '＋ Add account…' }).click()
  await expect(helper(win)).toContainText('Add a Claude account')
  await helper(win).getByLabel('Name', { exact: true }).fill(name)
  if (email !== null) await helper(win).getByLabel('Email (optional)').fill(email)
}

test('Add account… → name and ticks → Sign in…: the helper waits, then shows who signed in and one line per item, and the row', async () => {
  const { app, page, config, root, log } = await launchAccounts({
    script: { turns: {}, auth: { work: { gate: 'go' } } },
    main: mainSetup
  })
  const folder = join(root, 'accounts', 'work')
  const before = hashTree(config)
  const win = await accountsWindow(app, page)
  await fillAdd(win, 'Work', 'work@example.com')
  const dialog = helper(win)

  // the ticks count Main account's setup; the item it lacks is greyed and cannot be ticked
  await expect(dialog.locator('.account-tick', { hasText: 'Settings' })).toContainText('Model, permissions, environment, status line', LONG)
  await expect(dialog.locator('.account-tick', { hasText: 'MCP servers' })).toContainText('context7')
  await expect(dialog.locator('.account-tick', { hasText: 'Output styles' })).toContainText('None in Main account')
  await expect(dialog.locator('.account-tick', { hasText: 'Output styles' }).locator('input')).toBeDisabled()
  await expect(dialog).toContainText('Never carried: the sign-in of Main account, its conversations, Claude Code\'s caches.')

  await dialog.getByRole('button', { name: 'Sign in…', exact: true }).click()
  await expect(dialog).toContainText('Waiting for the sign-in in your browser…')
  await expect(dialog).toContainText('Your browser opened claude.ai. Sign in with the account for Work.')
  await expect.poll(() => runs(log).find((r) => r.argv[0] === 'auth' && r.argv[1] === 'login'), LONG).toMatchObject({ argv: ['auth', 'login', '--claudeai', '--email', 'work@example.com'], config: folder, oauthToken: false, apiKey: false })
  expect(hashTree(config)).toBe(before)

  // the person signs in in the browser: the helper says who, and one line per ticked item
  writeFileSync(join(folder, 'go'), '')
  await expect(dialog).toContainText('Signed in as work@example.com · Team plan', LONG)
  await expect(dialog.locator('.helper-line[data-state="done"]')).toHaveCount(7, LONG)
  for (const label of ['Settings', 'Hooks', 'MCP servers', 'Skills', 'Memory', 'Trusted folders', "ClaudeTerm's tools"]) {
    await expect(dialog.locator('.helper-line', { hasText: label })).toBeVisible()
  }
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(helper(win)).toHaveCount(0)
  await expect(row(win, 'Work')).toContainText('Signed in as work@example.com · Team plan', LONG)
  expect(hashTree(config)).toBe(before)
  await app.close()
})

test('Cancel while waiting leaves no account, no folder and no tab', async () => {
  const { app, page, root } = await launchAccounts({ script: { turns: {}, auth: { work: { gate: 'go' } } } })
  const folder = join(root, 'accounts', 'work')
  // the Settings window opened at the add-account section shows the helper at once
  const win = await settingsWindow(app, page, 'add-account')
  await expect(helper(win)).toContainText('Add a Claude account', LONG)
  await helper(win).getByLabel('Name', { exact: true }).fill('Work')
  await helper(win).getByRole('button', { name: 'Sign in…', exact: true }).click()
  await expect(helper(win)).toContainText('Waiting for the sign-in in your browser…')
  await expect.poll(() => signInTab(page), LONG).toBeDefined()
  await expect.poll(() => existsSync(folder)).toBe(true)

  await helper(win).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(helper(win)).toHaveCount(0)
  await expect.poll(() => flow(page), LONG).toBeNull()
  await expect.poll(() => signInTab(page), LONG).toBeUndefined()
  await expect.poll(() => existsSync(folder), LONG).toBe(false)
  expect((await accounts(page)).some((a) => a.name === 'Work')).toBe(false)
  await app.close()
})

test('a failed sign-in shows The sign-in did not finish with its last line, and Try again opens a new tab', async () => {
  const { app, page, root, log } = await launchAccounts({ script: { turns: {}, auth: { work: { fail: 'access denied' } } } })
  const folder = join(root, 'accounts', 'work')
  const win = await accountsWindow(app, page)
  await fillAdd(win, 'Work', null)
  await helper(win).getByRole('button', { name: 'Sign in…', exact: true }).click()

  const dialog = helper(win)
  await expect(dialog).toContainText('The sign-in did not finish', LONG)
  await expect(dialog.locator('.helper-mono')).toContainText('access denied')
  const first = (await signInTab(page))!
  expect(first).toBeDefined()

  await dialog.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect.poll(async () => (await signInTab(page)) !== undefined && (await signInTab(page)) !== first, LONG).toBe(true)
  await expect.poll(() => runs(log).filter((r) => r.argv[0] === 'auth' && r.argv[1] === 'login').length, LONG).toBe(2)
  await expect(dialog).toContainText('The sign-in did not finish', LONG)
  expect(existsSync(join(folder, '.credentials.json'))).toBe(false)
  // quitting undoes the waiting sign-in: its folder, which ClaudeTerm made, goes
  await app.close()
  expect(existsSync(folder)).toBe(false)
})

test('the same login as Main account shows the warning with both buttons; Keep it anyway saves', async () => {
  const { app, page, root } = await launchAccounts({
    script: { turns: {}, auth: { work: { gate: 'go', email: MAIN_WHO.emailAddress, orgUuid: MAIN_WHO.organizationUuid } } }
  })
  const win = await accountsWindow(app, page)
  await fillAdd(win, 'Work', null)
  await helper(win).getByRole('button', { name: 'Sign in…', exact: true }).click()
  await expect.poll(() => signInTab(page), LONG).toBeDefined()
  writeFileSync(join(root, 'accounts', 'work', 'go'), '')

  const dialog = helper(win)
  await expect(dialog.locator('.helper-title')).toHaveText('The same login as Main account', LONG)
  await expect(dialog).toContainText('This is the same login as Main account (main@example.com): tabs on Work would share its limits and connectors.')
  await expect(dialog.getByRole('button', { name: 'Sign in with another account', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Keep it anyway', exact: true }).click()
  await expect(dialog).toContainText('Signed in as', LONG)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await accounts(page)).find((a) => a.name === 'Work')).toMatchObject({ kind: 'login', state: 'ready' })
  await app.close()
})

test('closing Settings during the sign-in: the account is ready, toasted and listed', async () => {
  const { app, page, root } = await launchAccounts({ script: { turns: {}, auth: { work: { gate: 'go' } } } })
  await watchToasts(page)
  const win = await accountsWindow(app, page)
  await fillAdd(win, 'Work', 'work@example.com')
  await helper(win).getByRole('button', { name: 'Sign in…', exact: true }).click()
  await expect(helper(win)).toContainText('Waiting for the sign-in in your browser…')
  await win.close()

  writeFileSync(join(root, 'accounts', 'work', 'go'), '')
  await expect.poll(() => seenToasts(page), LONG).toEqual(expect.arrayContaining(['Account "Work" is ready: signed in as work@example.com']))
  // every line is done before Settings opens again: nothing is published to the new window, which must show the finished flow by itself
  await expect.poll(async () => (await flow(page))?.lines.every((l) => l.state === 'done'), LONG).toBe(true)
  // the finished flow is main's until its Done: the window that opens again shows it first, then the list
  const again = await settingsWindow(app, page)
  await expect(helper(again)).toContainText('Signed in as work@example.com', LONG)
  await helper(again).getByRole('button', { name: 'Done', exact: true }).click()
  await showSettingsTab(again, 'accounts')
  await expect(row(again, 'Work')).toContainText('Signed in as work@example.com', LONG)
  await app.close()
})

test('Use a folder I already have… with a signed-in folder: Add, and no sign-in tab', async () => {
  const { app, page, root, log, dataDir } = await launchAccounts({ script: { turns: {} } })
  const folder = join(root, '.claude-home')
  mkdirSync(folder, { recursive: true })
  signedIn(folder, { emailAddress: 'home@example.com' })
  await app.evaluate(({ dialog }, path: string) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog
  }, folder)
  const win = await accountsWindow(app, page)
  await win.getByRole('button', { name: '＋ Add account…' }).click()
  await helper(win).getByRole('button', { name: 'Use a folder I already have…' }).click()

  const dialog = helper(win)
  await expect(dialog).toContainText('.claude-home', LONG)
  await expect(dialog).toContainText('home@example.com')
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('home')
  // this folder has its own setup: nothing is ticked until the person ticks it
  await expect(dialog.locator('.account-tick input:checked')).toHaveCount(0)
  await expect(dialog).toContainText('This folder has its own setup: tick what to carry over anyway')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toContainText('Signed in as home@example.com', LONG)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  expect(runs(log).some((r) => r.argv[0] === 'auth' && r.argv[1] === 'login')).toBe(false)
  await expect.poll(async () => (await accounts(page)).some((a) => a.name === 'home'), LONG).toBe(true)
  const saved = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf8')) as { accounts: { name: string; folder: string; created: boolean }[] }
  expect(saved.accounts.find((a) => a.name === 'home')).toMatchObject({ folder, created: false })
  await app.close()
})

test('Carry over… on a row lists the items and carries the ticked ones', async () => {
  const { app, page, root } = await launchAccounts({ accounts: workEntry, main: mainSetup, script: { turns: {} } })
  const folder = join(root, 'accounts', 'work')
  const win = await accountsWindow(app, page)
  await row(win, 'Work').getByRole('button', { name: 'Carry over…' }).click()

  const dialog = helper(win)
  await expect(dialog.locator('.helper-title')).toHaveText('Carry over to Work')
  await expect(dialog.locator('.account-tick', { hasText: 'Skills' })).toContainText('Your skills for every project', LONG)
  await expect(dialog.locator('.account-tick', { hasText: 'Output styles' }).locator('input')).toBeDisabled()
  await dialog.locator('.account-tick', { hasText: 'Skills' }).locator('input').uncheck()
  await dialog.getByRole('button', { name: 'Carry over', exact: true }).click()

  await expect(dialog.locator('.helper-line[data-state="done"]').first()).toBeVisible(LONG)
  await expect(dialog.locator('.helper-line[data-state="running"]')).toHaveCount(0, LONG)
  // a carry-over has no steps: it is not a sign-in
  await expect(dialog.locator('.helper-steps')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const settings = JSON.parse(readFileSync(join(folder, 'settings.json'), 'utf8')) as { model?: string; env?: Record<string, string> }
  expect(settings.model).toBe('claude-test-model')
  expect(settings.env?.ANTHROPIC_API_KEY).toBeUndefined()
  expect(existsSync(join(folder, 'skills', 'review', 'SKILL.md'))).toBe(false)
  await app.close()
})

test('Sign in instead… on a token row keeps the account\'s id and its tab', async () => {
  const { app, page, root, dataDir, work } = await launchAccounts({
    accounts: [tokenEntry(CI_BOT, 'CI bot', CI_TOKEN)],
    script: { turns: {}, auth: { 'ci-bot': { gate: 'go' } } }
  })
  // a Claude tab runs on the token account while it signs in: the sign-in keeps the id, so the tab stays on the account
  await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd: work, account: CI_BOT })
  await expect.poll(async () => (await page.evaluate((id) => window.ct.accountRemoveInfo(id), CI_BOT))?.tabs, LONG).toBe(1)
  const win = await accountsWindow(app, page)
  await row(win, 'CI bot').getByRole('button', { name: 'Sign in instead…' }).click()

  const dialog = helper(win)
  await expect(dialog.locator('.helper-title')).toHaveText('Sign in instead of the token')
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('CI bot')
  await expect(dialog).toContainText('Its tabs keep running on the token until they restart. The token is deleted once you are signed in.')
  await dialog.getByRole('button', { name: 'Sign in…', exact: true }).click()
  await expect.poll(() => signInTab(page, 'Sign in — CI bot'), LONG).toBeDefined()
  writeFileSync(join(root, 'accounts', 'ci-bot', 'go'), '')
  await expect(dialog).toContainText('Signed in as', LONG)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  expect((await accounts(page)).find((a) => a.id === CI_BOT)).toMatchObject({ name: 'CI bot', kind: 'login', state: 'ready' })
  expect((await page.evaluate((id) => window.ct.accountRemoveInfo(id), CI_BOT))?.tabs).toBe(1)
  expect(readFileSync(join(dataDir, 'accounts.json'), 'utf8')).not.toContain(CI_TOKEN)
  await app.close()
})

test('Sign in again on a not-signed-in row opens the sign-in step', async () => {
  const { app, page, log } = await launchAccounts({
    accounts: (r) => {
      const folder = join(r, 'accounts', 'studio')
      mkdirSync(folder, { recursive: true })
      return [loginEntry(STUDIO, 'Studio', folder)]
    },
    script: { turns: {}, auth: { studio: { gate: 'go' } } }
  })
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Studio')).toContainText('Not signed in', LONG)
  await row(win, 'Studio').getByRole('button', { name: 'Sign in again' }).click()

  const dialog = helper(win)
  await expect(dialog.locator('.helper-title')).toHaveText('Sign in to Studio again')
  await expect(dialog).toContainText('Waiting for the sign-in in your browser…')
  await expect(dialog).toContainText('Your browser opened claude.ai. Sign in with the account for Studio.')
  await expect.poll(() => signInTab(page, 'Sign in — Studio'), LONG).toBeDefined()
  await expect.poll(() => runs(log).some((r) => r.argv[0] === 'auth' && r.argv[1] === 'login'), LONG).toBe(true)
  await app.close()
})

test('Esc closes the step 1 form and starts nothing; Tab stays inside the dialog', async () => {
  const { app, page } = await launchAccounts({ script: { turns: {} } })
  const win = await settingsWindow(app, page, 'add-account')
  const dialog = helper(win)
  await expect(dialog).toContainText('Add a Claude account', LONG)
  for (let i = 0; i < 30; i++) {
    await win.keyboard.press('Tab')
    expect(await dialog.evaluate((box) => box.contains(document.activeElement), undefined)).toBe(true)
  }
  await win.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(win.isClosed()).toBe(false)
  expect(await flow(page)).toBeNull()
  await app.close()
})

test('no secret in either window', async () => {
  const { app, page, root } = await launchAccounts({
    accounts: (r) => [...workEntry(r), tokenEntry(CI_BOT, 'CI bot', CI_TOKEN)],
    script: { turns: {}, auth: { home: { gate: 'go' } } },
    main: mainSetup
  })
  const win = await accountsWindow(app, page)
  await fillAdd(win, 'Home', 'home@example.com')
  await helper(win).getByRole('button', { name: 'Sign in…', exact: true }).click()
  await expect.poll(() => signInTab(page, 'Sign in — Home'), LONG).toBeDefined()
  writeFileSync(join(root, 'accounts', 'home', 'go'), '')
  await expect(helper(win)).toContainText('Signed in as home@example.com', LONG)
  // the carried lines finish before the windows are read: the secrets must be absent at the end, not midway
  await expect(helper(win).locator('.helper-line[data-state="running"]')).toHaveCount(0, LONG)

  const windows = [await win.content(), await page.content()]
  for (const secret of SECRETS) {
    for (const html of windows) expect(html).not.toContain(secret)
  }
  await app.close()
})

test('the primary button is off until the name is valid; a refused sign-in says why under the footer', async () => {
  const { app, page } = await launchAccounts({ script: { turns: {} } })
  const win = await accountsWindow(app, page)
  await win.getByRole('button', { name: '＋ Add account…' }).click()
  const dialog = helper(win)
  const primary = dialog.getByRole('button', { name: 'Sign in…', exact: true })
  await expect(primary).toBeDisabled()
  await dialog.getByLabel('Name', { exact: true }).fill('Main account')
  await expect(primary).toBeDisabled()
  await dialog.getByLabel('Name', { exact: true }).fill('Work')
  await expect(primary).toBeEnabled()
  await dialog.getByLabel('Email (optional)').fill('not an address')
  await primary.click()
  await expect(dialog.locator('.field-error')).toHaveText('Enter an email address, or leave it empty', LONG)
  expect(await flow(page)).toBeNull()
  await app.close()
})

test('Esc in the sign-in step leaves the sign-in running: Add account… shows it again, and ✕ leaves it too', async () => {
  const { app, page } = await launchAccounts({ script: { turns: {}, auth: { work: { gate: 'go' } } } })
  const win = await accountsWindow(app, page)
  await fillAdd(win, 'Work', null)
  await helper(win).getByRole('button', { name: 'Sign in…', exact: true }).click()
  await expect(helper(win)).toContainText('Waiting for the sign-in in your browser…', LONG)
  await win.keyboard.press('Escape')
  await expect(helper(win)).toHaveCount(0)
  expect((await flow(page))?.step).toBe('sign-in')
  expect(await signInTab(page)).toBeDefined()

  await win.getByRole('button', { name: '＋ Add account…' }).click()
  await expect(helper(win)).toContainText('Waiting for the sign-in in your browser…', LONG)
  await helper(win).locator('.helper-close').click()
  await expect(helper(win)).toHaveCount(0)
  expect((await flow(page))?.step).toBe('sign-in')
  await app.close()
})

test('a sign-in begun from the main window opens the helper in an open Settings window', async () => {
  const { app, page } = await launchAccounts({ script: { turns: {}, auth: { work: { gate: 'go' } } } })
  const win = await accountsWindow(app, page)
  expect(await page.evaluate(() => window.ct.beginAccountFlow({ mode: 'add', id: null, name: 'Work', email: null, source: null, items: [], adopt: false }))).toEqual({ ok: true })
  await expect(helper(win)).toContainText('Waiting for the sign-in in your browser…', LONG)
  await helper(win).getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect.poll(() => flow(page), LONG).toBeNull()
  await app.close()
})

test('a carried item that fails shows its line; Try again on it carries the item once the cause is gone', async () => {
  const { app, page, root } = await launchAccounts({
    accounts: workEntry,
    main: mainSetup,
    script: { turns: {}, cliFail: { 'mcp add-json': 'add-json refused' } }
  })
  const win = await accountsWindow(app, page)
  await row(win, 'Work').getByRole('button', { name: 'Carry over…' }).click()
  const dialog = helper(win)
  await dialog.getByRole('button', { name: 'Carry over', exact: true }).click()

  const mcp = dialog.locator('.helper-line', { hasText: 'MCP servers' })
  await expect(mcp).toHaveAttribute('data-state', 'failed', LONG)
  // the cause is gone: the stand-in reads its script again for each call
  writeFileSync(join(root, 'script.json'), JSON.stringify({ turns: {} }))
  await mcp.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(mcp).toHaveAttribute('data-state', 'done', LONG)
  await app.close()
})

test('Settings opened on the Accounts section checks the sign-ins when the page shows', async () => {
  const { app, page, log } = await launchAccounts({ accounts: workEntry, script: { turns: {} } })
  const statuses = (): number => runs(log).filter((r) => r.argv[0] === 'auth' && r.argv[1] === 'status').length
  const before = statuses()
  const win = await settingsWindow(app, page, 'accounts')
  await expect(win.locator('.settings-page[data-page="accounts"]')).toBeVisible(LONG)
  await expect.poll(statuses, LONG).toBeGreaterThan(before)
  await expect(row(win, 'Work')).toContainText('Signed in as work@example.com', LONG)
  await app.close()
})

test('in a Settings window of the smallest size the helper keeps its title and its buttons in view, and its body scrolls', async () => {
  const { app, page } = await launchAccounts({ script: { turns: {} }, main: mainSetup })
  const win = await accountsWindow(app, page)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'))!.setContentSize(560, 480)
  })
  await expect.poll(() => win.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(500)
  await fillAdd(win, 'Work', null)
  const dialog = helper(win)
  await expect(dialog.locator('.account-dialog-head')).toBeInViewport({ ratio: 1 })
  await expect(dialog.getByRole('button', { name: 'Sign in…', exact: true })).toBeInViewport({ ratio: 1 })
  // the ticks are more than the window holds: they scroll inside the box
  const body = dialog.locator('.account-dialog-body')
  expect(await body.evaluate((b) => b.scrollHeight > b.clientHeight)).toBe(true)
  await body.locator('.account-tick').last().scrollIntoViewIfNeeded()
  await expect(body.locator('.account-tick').last()).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'Sign in…', exact: true })).toBeInViewport({ ratio: 1 })
  await app.close()
})

test('long notes of the ticks fit the box: it never scrolls sideways, and every tick is whole inside it', async () => {
  // Main account with a dozen MCP servers: the note of MCP servers names them, longer than its column
  const manyServers = (config: string): void => {
    mainSetup(config)
    const doc = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8')) as Record<string, unknown>
    const names = ['asana', 'autopilot', 'claude-terminal', 'figma', 'linear', 'miro', 'notion', 'notion-work', 'sentry', 'slack', 'trello', 'youtrack']
    doc.mcpServers = Object.fromEntries(names.map((name) => [name, { type: 'http', url: `https://mcp.example.test/${name}` }]))
    writeFileSync(join(config, '.claude.json'), JSON.stringify(doc))
  }
  const { app, page } = await launchAccounts({ script: { turns: {} }, main: manyServers })
  const win = await accountsWindow(app, page)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'))!.setContentSize(760, 760)
  })
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(780)
  await fillAdd(win, 'Work', null)
  const dialog = helper(win)
  await expect(dialog.locator('.account-tick', { hasText: 'MCP servers' })).toContainText('asana', LONG)
  const body = dialog.locator('.account-dialog-body')
  expect(await body.evaluate((b) => b.scrollWidth - b.clientWidth)).toBe(0)
  const boxes = await body.evaluate((b) => {
    const frame = b.getBoundingClientRect()
    return [...b.querySelectorAll('.account-tick')].map((t) => {
      const r = t.getBoundingClientRect()
      return { left: r.left >= frame.left, right: r.right <= frame.right + 0.5 }
    })
  })
  expect(boxes.length).toBeGreaterThan(0)
  for (const box of boxes) expect(box).toEqual({ left: true, right: true })
  await app.close()
})

test('while the helper is open, Ctrl+F does not move the focus behind it', async () => {
  const { app, page } = await launchAccounts({ script: { turns: {} } })
  const win = await settingsWindow(app, page, 'add-account')
  await expect(helper(win)).toContainText('Add a Claude account', LONG)
  await win.keyboard.press('Control+F')
  await expect(win.locator('#settings-search')).not.toBeFocused()
  expect(await helper(win).evaluate((box) => box.contains(document.activeElement), undefined)).toBe(true)
  await app.close()
})
