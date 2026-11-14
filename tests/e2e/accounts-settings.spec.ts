import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CI_BOT, CI_TOKEN, launchAccounts, loginEntry, runs, settingsWindow, signedIn, STUDIO, tokenEntry, WORK } from './account-helpers'
import type { ElectronApplication } from '@playwright/test'
import { showSettingsTab } from './helpers'

const GONE = '2f8e5d4c-6b7a-4c8d-8e9f-1a2b3c4d5e6f'
const LONG = { timeout: 15_000 }

/** the row of an extra account, by its name */
const row = (win: Page, name: string) => win.locator('.account-row[data-account]', { has: win.locator('.account-name', { hasText: new RegExp(`^${name}$`) }) })

/** the Settings window, on its Accounts page */
async function accountsWindow(app: ElectronApplication, page: Page): Promise<Page> {
  const win = await settingsWindow(app, page)
  await showSettingsTab(win, 'accounts')
  return win
}

/** a sign-in account's folder, signed in as the stand-in's work account */
function signedInFolder(root: string, name: string): string {
  const folder = join(root, 'accounts', name)
  mkdirSync(folder, { recursive: true })
  signedIn(folder)
  return folder
}

/** the ··· menu of an extra account, then one of its items */
async function menuItem(win: Page, name: string, item: string): Promise<void> {
  await win.getByRole('button', { name: `More for ${name}` }).click()
  await win.locator('.account-menu').getByRole('button', { name: item, exact: true }).click()
}

test('the Accounts page shows Main account and each account by its state', async () => {
  const { app, page } = await launchAccounts({
    accounts: (root) => {
      mkdirSync(join(root, 'accounts', 'studio'), { recursive: true })
      return [
        loginEntry(WORK, 'Work', signedInFolder(root, 'work')),
        loginEntry(STUDIO, 'Studio', join(root, 'accounts', 'studio')),
        loginEntry(GONE, 'Gone', join(root, 'accounts', 'gone')),
        tokenEntry(CI_BOT, 'CI bot', CI_TOKEN)
      ]
    }
  })
  const win = await accountsWindow(app, page)
  await expect(win.locator('.settings-page[data-page="accounts"] .section-title')).toContainText('Accounts')
  await expect(win.getByText('the Claude logins your tabs run on')).toBeVisible()
  const main = win.locator('.account-row.account-main')
  await expect(main).toContainText('Your Claude Code login')
  await expect(main).toContainText('Signed in as main@example.com · Max plan')
  await expect(main.getByRole('button', { name: 'Show folder' })).toBeVisible()

  await expect(row(win, 'Work')).toContainText('Signed in as work@example.com · Team plan', LONG)
  await expect(row(win, 'Work').getByRole('button', { name: 'New tab' })).toBeVisible()
  await expect(row(win, 'Work').getByRole('button', { name: 'Carry over…' })).toBeVisible()

  await expect(row(win, 'Studio')).toContainText('Not signed in', LONG)
  await expect(row(win, 'Studio').getByRole('button', { name: 'Sign in again' })).toBeVisible()

  await expect(row(win, 'Gone')).toContainText('Its folder is gone:', LONG)
  await expect(row(win, 'Gone').getByRole('button', { name: 'Remove', exact: true })).toBeVisible()

  await expect(row(win, 'CI bot')).toContainText('Token')
  await expect(row(win, 'CI bot')).toContainText('model requests only: no connectors, no Remote Control')
  await expect(row(win, 'CI bot').getByRole('button', { name: 'Sign in instead…' })).toBeVisible()
  await expect(row(win, 'CI bot').getByRole('button', { name: 'Replace token' })).toBeVisible()
  await app.close()
})

test('a row says Checking… until its first check answers', async () => {
  const { app, page } = await launchAccounts({
    accounts: (root) => [loginEntry(WORK, 'Work', signedInFolder(root, 'work'))],
    script: { turns: {}, auth: { work: { status: 'hang' } } }
  })
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Work')).toContainText('Checking…', LONG)
  await expect(row(win, 'Work')).not.toContainText('Signed in as')
  // the check gives up after 15 s and says so: the hung command is ended then, so the app can close
  await expect(row(win, 'Work')).not.toContainText('Checking…', { timeout: 30_000 })
  await expect(row(win, 'Work')).toContainText('Could not check the sign-in')
  await app.close()
})

test('Add with a token… adds a token account in a dialog without ever showing the token', async () => {
  const { app, page } = await launchAccounts()
  const win = await accountsWindow(app, page)
  const token = 'e2e-token-personal-0000001'
  await win.getByRole('button', { name: 'Add with a token…' }).click()
  const dialog = win.locator('.account-dialog')
  await expect(dialog.getByRole('button', { name: 'Get a token' })).toBeVisible()
  await dialog.locator('[data-account-field="name"]').fill('Personal')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog.locator('.field-error')).toHaveText('Paste the token from claude setup-token')
  await dialog.locator('[data-account-field="token"]').fill(token)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(win.locator('.account-dialog')).toHaveCount(0)
  await expect(row(win, 'Personal')).toContainText('Token valid until about')
  expect(await win.content()).not.toContain(token)
  await expect.poll(() => page.evaluate(async () => (await window.ct.listAccounts()).accounts.map((a) => a.name))).toEqual(['Personal'])
  await app.close()
})

test('Remove… of a sign-in account signs out and removes its folder', async () => {
  const { app, page, root, log } = await launchAccounts({ accounts: (r) => [loginEntry(WORK, 'Work', signedInFolder(r, 'work'))] })
  const folder = join(root, 'accounts', 'work')
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Work')).toContainText('Signed in as', LONG)
  await menuItem(win, 'Work', 'Remove…')
  const dialog = win.locator('.account-dialog')
  await expect(dialog).toContainText('Remove Work?')
  await expect(dialog).toContainText('Tabs on Work keep running until they close; then they start on Main account.')
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await expect(dialog).toContainText('Sign out and move its folder to the trash')
  await expect(dialog).toContainText('they leave Recent sessions')
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(win.locator('.account-dialog')).toHaveCount(0)
  await expect(row(win, 'Work')).toHaveCount(0)
  expect(existsSync(folder)).toBe(false)
  await expect.poll(() => runs(log).some((r) => r.argv[0] === 'auth' && r.argv[1] === 'logout'), LONG).toBe(true)
  await app.close()
})

test('with a tab on the account the folder box is off and says why', async () => {
  const { app, page, root, work } = await launchAccounts({ accounts: (r) => [loginEntry(WORK, 'Work', signedInFolder(r, 'work'))] })
  await page.evaluate(({ cwd, a }) => window.ct.openTab({ kind: 'claude', cwd, account: a }), { cwd: work, a: WORK })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Work')).toContainText('Signed in as', LONG)
  await menuItem(win, 'Work', 'Remove…')
  const dialog = win.locator('.account-dialog')
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await expect(dialog.getByRole('checkbox')).toBeDisabled()
  await expect(dialog).toContainText('Close the 1 tab on Work to remove its folder too')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(win.locator('.account-dialog')).toHaveCount(0)
  expect(existsSync(join(root, 'accounts', 'work'))).toBe(true)
  await app.close()
})

test('an adopted folder offers only Sign out of it', async () => {
  const { app, page, root } = await launchAccounts({
    accounts: (r) => {
      const folder = join(r, 'elsewhere', 'studio')
      mkdirSync(folder, { recursive: true })
      signedIn(folder)
      return [loginEntry(STUDIO, 'Studio', folder, false)]
    }
  })
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Studio')).toContainText('Signed in as', LONG)
  await menuItem(win, 'Studio', 'Remove…')
  const dialog = win.locator('.account-dialog')
  await expect(dialog).toContainText('Remove Studio?')
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await expect(dialog.getByRole('checkbox')).toBeEnabled()
  await expect(dialog).toContainText('Sign out of it')
  await expect(dialog).not.toContainText('trash')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(existsSync(join(root, 'elsewhere', 'studio'))).toBe(true)
  await app.close()
})

test('an adopted folder with a tab on the account has its box off too, and says why', async () => {
  const { app, page, work } = await launchAccounts({
    accounts: (r) => {
      const folder = join(r, 'elsewhere', 'studio')
      mkdirSync(folder, { recursive: true })
      signedIn(folder)
      return [loginEntry(STUDIO, 'Studio', folder, false)]
    }
  })
  await page.evaluate(({ cwd, a }) => window.ct.openTab({ kind: 'claude', cwd, account: a }), { cwd: work, a: STUDIO })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Studio')).toContainText('Signed in as', LONG)
  await menuItem(win, 'Studio', 'Remove…')
  const dialog = win.locator('.account-dialog')
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await expect(dialog.getByRole('checkbox')).toBeDisabled()
  await expect(dialog).toContainText('Close the 1 tab on Studio to remove its folder too')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await app.close()
})

test("Show folder opens the account's folder, and Main account's", async () => {
  const { app, page, root, config } = await launchAccounts({ accounts: (r) => [loginEntry(WORK, 'Work', signedInFolder(r, 'work'))] })
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    Object.assign(shell, { openPath: async (p: string) => { g.__opened.push(p); return '' } })
  })
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Work')).toContainText('Signed in as', LONG)
  await menuItem(win, 'Work', 'Show folder')
  await win.locator('.account-row.account-main').getByRole('button', { name: 'Show folder' }).click()
  const opened = join(root, 'accounts', 'work')
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([opened, config])
  await app.close()
})

test('the ··· menu closes on Escape and on a click outside it, and Escape does not close the window', async () => {
  const { app, page } = await launchAccounts({ accounts: (r) => [loginEntry(WORK, 'Work', signedInFolder(r, 'work'))] })
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Work')).toContainText('Signed in as', LONG)
  await win.getByRole('button', { name: 'More for Work' }).click()
  await expect(win.locator('.account-menu')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.locator('.account-menu')).toBeHidden()
  expect(win.isClosed()).toBe(false)
  await win.getByRole('button', { name: 'More for Work' }).click()
  await expect(win.locator('.account-menu')).toBeVisible()
  await win.locator('.account-intro').click()
  await expect(win.locator('.account-menu')).toBeHidden()
  await app.close()
})

test('Sign in again starts the sign-in of a signed-out account', async () => {
  const { app, page, log } = await launchAccounts({
    accounts: (r) => {
      mkdirSync(join(r, 'accounts', 'studio'), { recursive: true })
      return [loginEntry(STUDIO, 'Studio', join(r, 'accounts', 'studio'))]
    },
    script: { turns: {}, auth: { studio: { gate: 'go' } } }
  })
  const win = await accountsWindow(app, page)
  await expect(row(win, 'Studio')).toContainText('Not signed in', LONG)
  await row(win, 'Studio').getByRole('button', { name: 'Sign in again' }).click()
  await expect.poll(() => page.evaluate(() => window.ct.accountFlow()), LONG).not.toBeNull()
  await expect.poll(() => runs(log).some((r) => r.argv[0] === 'auth' && r.argv[1] === 'login'), LONG).toBe(true)
  await app.close()
})
