import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, makeDataDir, TEST_SHELL, type Launched } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const WORK = '0b6f3c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'
const BROKEN = '1c7a4d3f-5e6b-4f7a-9b8c-0d1e2f3a4b5c'
const WORK_TOKEN = 'e2e-token-work-0000000001'
const API_KEY = 'e2e-api-key-0001'

// "claude" prints the token and the API key it was given, then its arguments
const ACCOUNT_SETTINGS = {
  ...FAKE_CLAUDE_SETTINGS,
  claude: {
    ...FAKE_CLAUDE_SETTINGS.claude,
    command: WIN
      ? 'cmd /c echo fake-claude token=%CLAUDE_CODE_OAUTH_TOKEN% key=%ANTHROPIC_API_KEY%'
      : 'pwd; echo fake-claude token=$CLAUDE_CODE_OAUTH_TOKEN key=$ANTHROPIC_API_KEY'
  }
}

/** accounts.json with tokens kept as they are, which the store reads on every system */
function writeAccounts(dataDir: string, accounts: { id: string; name: string; token: string; encrypted?: boolean }[]): void {
  writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, addedAt: '2026-10-01T09:00:00.000Z', token: a.token, encrypted: a.encrypted ?? false }))
  }))
}

/** the app with the accounts Work and Broken (whose token cannot be decrypted), and a work folder */
async function launchWithAccounts(env: Record<string, string> = {}): Promise<Launched & { work: string }> {
  const dataDir = makeDataDir(ACCOUNT_SETTINGS)
  // bytes that no system decrypts, nor reads as a token
  writeAccounts(dataDir, [{ id: WORK, name: 'Work', token: WORK_TOKEN }, { id: BROKEN, name: 'Broken', token: 'AAECA/r7/P3+/w==', encrypted: true }])
  const launched = await launchApp({ dataDir, env })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  return { ...launched, work: mkdtempSync(join(tmpdir(), 'ct-work-')) }
}

async function openClaude(page: Page, cwd: string, account: string | null): Promise<string> {
  const tab = await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd, account })
  return tab!.id
}

test('a Claude tab on an extra account gets its token instead of the API key; the main account keeps the key', async () => {
  const { app, page, work } = await launchWithAccounts({ ANTHROPIC_API_KEY: API_KEY })
  const main = await openClaude(page, work, null)
  const onWork = await openClaude(page, work, WORK)
  await expect.poll(() => bufferText(page, onWork), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  expect(await bufferText(page, onWork)).not.toContain(`key=${API_KEY}`)
  await expect.poll(() => bufferText(page, main), { timeout: 15_000 }).toContain(`key=${API_KEY}`)
  expect(await bufferText(page, main)).not.toContain(WORK_TOKEN)
  await app.close()
})

test('a new Claude tab opened from a tab on an account runs on the same account', async () => {
  const { app, page, work } = await launchWithAccounts()
  await openClaude(page, work, WORK)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+L')
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  await app.close()
})

test('switching the account restarts the tab with --resume of its conversation on the new account', async () => {
  const { app, page, pipeName, work } = await launchWithAccounts()
  const id = await openClaude(page, work, null)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude token=/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: id, sessionId: SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: WORK })
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await bufferText(page, id)).toContain(`token=${WORK_TOKEN}`)
  await page.evaluate((id) => window.ct.switchAccount(id, null), id)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).not.toContain(WORK_TOKEN)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  await app.close()
})

test('switching to an account whose token cannot be read leaves the tab as it was and says so', async () => {
  const { app, page, work } = await launchWithAccounts()
  const id = await openClaude(page, work, WORK)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  expect(await page.evaluate(() => window.ct.listAccounts())).toMatchObject({ accounts: [{ name: 'Work', readable: true }, { name: 'Broken', readable: false }] })
  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: BROKEN })
  await expect(page.locator('.toast', { hasText: 'Account "Broken" is not available' })).toBeVisible()
  expect((await bufferText(page, id)).match(/fake-claude/g)).toHaveLength(1)
  expect(await bufferText(page, id)).toContain(`token=${WORK_TOKEN}`)
  await app.close()
})

test('restore reopens a Claude tab on its account; a tab on an account that is gone starts on the main account', async () => {
  const dataDir = makeDataDir(ACCOUNT_SETTINGS)
  writeAccounts(dataDir, [{ id: WORK, name: 'Work', token: WORK_TOKEN }])
  const cwd = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const tab = (title: string, account: string | null) => ({ kind: 'claude', profile: TEST_SHELL, cwd, title, claudeSessionId: SID, account })
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [tab('work', WORK), tab('gone', 'no-such-account')] }))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const [onWork, gone] = await page.evaluate(() => window.__ct!.tabIds())
  await expect.poll(() => bufferText(page, onWork), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  await expect.poll(() => bufferText(page, gone), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await bufferText(page, gone)).not.toContain(WORK_TOKEN)
  await expect(page.locator('.toast', { hasText: 'The account is not available; the tab started on the main account' })).toBeVisible()
  await app.close()
})

test('Get a token opens a tab that runs claude setup-token', async () => {
  const { app, page } = await launchWithAccounts()
  await page.evaluate(() => window.ct.getToken())
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude.*setup-token/)
  expect(await bufferText(page, id)).not.toContain('--settings')
  expect(await page.evaluate((i) => window.__ct!.tabTitle(i), id)).toBe('Get a token')
  await app.close()
})

test('an added account is listed without its token, and the token is encrypted on disk where the system can', async () => {
  const { app, page, dataDir } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const token = 'e2e-token-personal-0000001'
  expect(await page.evaluate((t) => window.ct.addAccount('Personal', t), token)).toEqual({ ok: true })
  expect(await page.evaluate((t) => window.ct.addAccount('personal', t), token)).toEqual({ ok: false, error: 'An account named "personal" already exists' })
  const view = await page.evaluate(() => window.ct.listAccounts())
  // the Linux tests run on the basic store, which encrypts nothing
  expect(view).toMatchObject({ keyring: WIN, accounts: [{ name: 'Personal', readable: true }] })
  expect(JSON.stringify(view)).not.toContain(token)
  expect(readFileSync(join(dataDir, 'accounts.json'), 'utf8').includes(token)).toBe(!WIN)
  await app.close()
})

test('the ▾ menu opens a Claude tab on a chosen account', async () => {
  const { app, page } = await launchWithAccounts()
  await page.locator('.tab-menu').click()
  await expect(page.locator('.menu-item.disabled', { hasText: 'Claude Code — Broken' })).toBeVisible()
  await page.locator('.menu-item', { hasText: 'Claude Code — Work' }).click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  await expect(page.locator('#statusbar .status-account')).toHaveText('Work')
  await app.close()
})

test('Continue as … in the tab menu resumes the conversation on another account', async () => {
  const { app, page, pipeName, work } = await launchWithAccounts()
  const id = await openClaude(page, work, null)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude token=/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: id, sessionId: SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-account')).toHaveText('Main account')
  await page.locator('.tab').nth(1).click({ button: 'right' })
  await expect(page.locator('.menu-item', { hasText: 'Continue as Main account' })).toHaveCount(0)
  await page.locator('.menu-item', { hasText: 'Continue as Work' }).click()
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await bufferText(page, id)).toContain(`token=${WORK_TOKEN}`)
  await expect(page.locator('#statusbar .status-account')).toHaveText('Work')
  await app.close()
})

test('a click on the account in the status bar switches it', async () => {
  const { app, page, work } = await launchWithAccounts()
  const id = await openClaude(page, work, WORK)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  await page.locator('#statusbar .status-account').click()
  await page.locator('.menu-item', { hasText: 'Continue as Main account' }).click()
  await expect(page.locator('#statusbar .status-account')).toHaveText('Main account')
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude token=/)
  expect(await bufferText(page, id)).not.toContain(WORK_TOKEN)
  await app.close()
})

test('the window title names the extra account of the active tab, and follows a rename and a switch', async () => {
  const { app, page, work } = await launchWithAccounts()
  const id = await openClaude(page, work, WORK)
  await expect(page).toHaveTitle(/ — Work — ClaudeTerm$/)
  expect(await page.evaluate((a) => window.ct.renameAccount(a, 'Office'), WORK)).toEqual({ ok: true })
  await expect(page).toHaveTitle(/ — Office — ClaudeTerm$/)
  // the shell tab has no account
  await page.locator('.tab').first().click()
  await expect(page).not.toHaveTitle(/Office/)
  await page.locator('.tab').nth(1).click()
  await expect(page).toHaveTitle(/ — Office — ClaudeTerm$/)
  // nor does a tab on the main account
  await page.evaluate((i) => window.ct.switchAccount(i, null), id)
  await expect(page).not.toHaveTitle(/Office/)
  await expect(page).toHaveTitle(/ — ClaudeTerm$/)
  await app.close()
})

test('without extra accounts there is no account in the status bar or the menus', async () => {
  const { app, page, tabId } = await launchClaudeTab(ACCOUNT_SETTINGS)
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude/)
  await expect(page.locator('#statusbar .status-account')).toHaveCount(0)
  await page.locator('.tab').first().click({ button: 'right' })
  await expect(page.locator('.menu-item', { hasText: 'Close tab' })).toBeVisible()
  await expect(page.locator('.menu-item', { hasText: 'Continue as' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('.tab-menu').click()
  await expect(page.locator('.menu-item', { hasText: 'Recent sessions' })).toBeVisible()
  await expect(page.locator('.menu-item', { hasText: 'Claude Code — ' })).toHaveCount(0)
  await app.close()
})

/** Ctrl+, in the main window; returns the settings window once its page is up */
async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  await page.locator('.terminal-host:visible .xterm').click()
  const [win] = await Promise.all([app.waitForEvent('window'), page.keyboard.press('Control+Comma')])
  await win.waitForSelector('#settings .settings-heading')
  return win
}

test('Settings → Accounts adds, renames, replaces and deletes an account without ever showing its token', async () => {
  const { app, page } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const win = await openSettings(app, page)
  const token = 'e2e-token-personal-0000001'
  await expect(win.locator('.account-list')).toHaveText('No extra accounts yet.')
  await win.locator('[data-account-field="name"]').fill('Personal')
  await win.locator('button', { hasText: 'Add account' }).click()
  await expect(win.locator('.account-add + .field-error')).toHaveText('Paste the token from claude setup-token')
  await win.locator('[data-account-field="token"]').fill(token)
  await win.locator('button', { hasText: 'Add account' }).click()
  await expect(win.locator('.account-row .account-name')).toHaveText('Personal')
  await expect(win.locator('.account-row')).toContainText('token valid until about')
  await expect(win.locator('[data-account-field="name"]')).toHaveValue('')
  await expect(win.locator('[data-account-field="token"]')).toHaveValue('')
  expect(await win.content()).not.toContain(token)
  // the main window knows the account at once
  await expect.poll(() => page.evaluate(async () => (await window.ct.listAccounts()).accounts.map((a) => a.name))).toEqual(['Personal'])

  await win.locator('.account-row button', { hasText: 'Rename' }).click()
  await win.locator('.account-row input').fill('Home')
  await win.locator('.account-row input').press('Enter')
  await expect(win.locator('.account-row .account-name')).toHaveText('Home')

  await win.locator('.account-row button', { hasText: 'Replace token' }).click()
  await win.locator('.account-row input').fill('e2e-token-replaced-0000001')
  await win.locator('.account-row button', { hasText: 'Save' }).click()
  await expect(win.locator('.account-row')).toContainText('token valid until about')

  await win.locator('.account-row button', { hasText: 'Delete' }).click()
  await win.locator('.account-row button', { hasText: 'Confirm delete' }).click()
  await expect(win.locator('.account-list')).toHaveText('No extra accounts yet.')
  await app.close()
})

test('Get a token in the settings window opens a setup-token tab in the main window', async () => {
  const { app, page } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const win = await openSettings(app, page)
  await win.locator('button', { hasText: 'Get a token' }).click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude.*setup-token/)
  await app.close()
})

test('the Accounts section says when the tokens are not encrypted', async () => {
  const { app, page } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  // with no account the keyring is not asked, so there is nothing to say yet
  expect(await page.evaluate(() => window.ct.addAccount('Personal', 'e2e-token-personal-0000001'))).toEqual({ ok: true })
  const win = await openSettings(app, page)
  // the Linux tests run on the basic store; Windows has DPAPI
  if (WIN) await expect(win.locator('.account-keyring')).toBeHidden()
  else await expect(win.locator('.account-keyring')).toHaveText('No system keyring: tokens are stored unencrypted, readable only by your user.')
  await app.close()
})

test('a tab on the last extra account, deleted, shows Removed account and can go back to the main account', async () => {
  const dataDir = makeDataDir(ACCOUNT_SETTINGS)
  writeAccounts(dataDir, [{ id: WORK, name: 'Work', token: WORK_TOKEN }])
  const { app, page } = await launchApp({ dataDir })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const id = await openClaude(page, mkdtempSync(join(tmpdir(), 'ct-work-')), WORK)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  expect(await page.evaluate((a) => window.ct.removeAccount(a), WORK)).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-account')).toHaveText('Removed account')
  await page.locator('.tab').nth(1).click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Continue as Main account' }).click()
  await expect(page.locator('#statusbar .status-account')).toHaveCount(0)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude token=/)
  expect(await bufferText(page, id)).not.toContain(WORK_TOKEN)
  await app.close()
})

test('Settings shows an account whose token cannot be read, and Replace token makes it usable again', async () => {
  const { app, page } = await launchWithAccounts()
  const win = await openSettings(app, page)
  const row = win.locator('.account-row', { hasText: 'Broken' })
  await expect(row.locator('.account-unreadable')).toHaveText('token cannot be read — replace it')
  await row.locator('button', { hasText: 'Replace token' }).click()
  await win.locator('.account-row input').fill('e2e-token-replaced-0000001')
  await win.locator('.account-row button', { hasText: 'Save' }).click()
  await expect(win.locator('.account-row', { hasText: 'Broken' })).toContainText('token valid until about')
  expect(await page.evaluate(() => window.ct.listAccounts())).toMatchObject({ accounts: [{ name: 'Work', readable: true }, { name: 'Broken', readable: true }] })
  await app.close()
})

test('the main window starts even when the accounts cannot be listed', async () => {
  const { app, page } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('accounts:list')
    ipcMain.handle('accounts:list', () => { throw new Error('the keyring went away') })
  })
  await page.reload()
  await page.waitForFunction(() => Boolean(window.__ct), undefined, { timeout: 15_000 })
  await expect(page.locator('.tab-new')).toBeVisible()
  await app.close()
})
