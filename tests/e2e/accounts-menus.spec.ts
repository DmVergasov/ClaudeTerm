import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CI_BOT, CI_TOKEN, launchAccounts, loginEntry, runs, signedIn, STUDIO, tokenEntry, trust, WORK } from './account-helpers'

const GONE = '4f2a9c1e-7b3d-4e5f-8a6b-9c0d1e2f3a4b'
const LONG = { timeout: 15_000 }

/** the sign-in account Work: a folder signed in as the stand-in's work account, trusting the tests' work folder */
function workAccount(root: string): object[] {
  const folder = join(root, 'accounts', 'work')
  mkdirSync(folder, { recursive: true })
  signedIn(folder, { organizationType: 'claude_max' })
  trust(folder, join(root, 'work'))
  return [loginEntry(WORK, 'Work', folder)]
}

/** the sign-in account Studio: a folder with no sign-in */
function studioAccount(root: string): object[] {
  const folder = join(root, 'accounts', 'studio')
  mkdirSync(folder, { recursive: true })
  return [loginEntry(STUDIO, 'Studio', folder)]
}

/** the account list of the app, as the windows see it */
async function stateOf(page: Page, name: string): Promise<string | undefined> {
  const view = await page.evaluate(() => window.ct.listAccounts())
  return view.accounts.find((a) => a.name === name)?.state ?? undefined
}

/** the Settings window a menu item opens: its page, once it has loaded */
async function openedSettings(app: ElectronApplication, click: () => Promise<void>): Promise<Page> {
  const [win] = await Promise.all([app.waitForEvent('window'), click()])
  await win.waitForLoadState('domcontentloaded')
  return win
}

async function openClaude(page: Page, cwd: string, account: string | null): Promise<string> {
  const tab = await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd, account })
  return tab!.id
}

test('▾ lists each account by its state, and Add account… opens Settings at the helper', async () => {
  const { app, page } = await launchAccounts({
    accounts: (root) => [
      ...workAccount(root),
      ...studioAccount(root),
      tokenEntry(CI_BOT, 'CI bot', CI_TOKEN),
      loginEntry(GONE, 'Gone', join(root, 'accounts', 'gone'))
    ]
  })
  await expect.poll(() => stateOf(page, 'Gone'), LONG).toBe('missing')
  await expect.poll(() => stateOf(page, 'Studio'), LONG).toBe('signed-out')

  await page.locator('.tab-menu').click()
  await expect(page.locator('.menu-item', { hasText: 'Claude Code — Work' })).not.toHaveClass(/disabled/)
  await expect(page.locator('.menu-item', { hasText: 'Claude Code — Studio (sign in again)' })).not.toHaveClass(/disabled/)
  await expect(page.locator('.menu-item', { hasText: 'Claude Code — CI bot · token' })).toBeVisible()
  await expect(page.locator('.menu-item.disabled', { hasText: 'Claude Code — Gone' })).toBeVisible()

  const win = await openedSettings(app, () => page.locator('.menu-item', { hasText: 'Add account…' }).click())
  await expect(win.locator('.account-dialog')).toContainText('Add a Claude account', LONG)
  await app.close()
})

test('▾ → Claude Code — Work opens a tab on Work in the terminal and in the chat', async () => {
  for (const view of ['terminal', 'chat'] as const) {
    const { app, page, root, log } = await launchAccounts({ accounts: workAccount, view })
    const account = join(root, 'accounts', 'work')
    await expect.poll(() => stateOf(page, 'Work'), LONG).toBe('ready')
    await page.locator('.tab-menu').click()
    await page.locator('.menu-item', { hasText: 'Claude Code — Work' }).click()
    await expect.poll(() => runs(log).find((r) => r.config === account && r.argv[0] !== 'auth'), LONG).toMatchObject({ oauthToken: false, apiKey: false })
    await expect(page.locator('#statusbar .status-account .status-text')).toHaveText('Work')
    await app.close()
  }
})

test("(sign in again) opens the helper's sign-in instead of a tab", async () => {
  const { app, page, log } = await launchAccounts({
    accounts: studioAccount,
    script: { turns: {}, auth: { studio: { gate: 'go' } } }
  })
  await expect.poll(() => stateOf(page, 'Studio'), LONG).toBe('signed-out')
  await page.locator('.tab-menu').click()
  const win = await openedSettings(app, () => page.locator('.menu-item', { hasText: 'Claude Code — Studio (sign in again)' }).click())

  const dialog = win.locator('.account-dialog')
  await expect(dialog.locator('.helper-title')).toHaveText('Sign in to Studio again', LONG)
  await expect(dialog).toContainText('Waiting for the sign-in in your browser…')
  await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().map((id) => window.__ct!.tabTitle(id))), LONG).toContain('Sign in — Studio')
  // no Claude tab starts: the first tab and the sign-in tab are all there is, and no conversation run starts
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
  expect(runs(log).filter((r) => r.argv[0] !== 'auth' && r.argv[0] !== '--version')).toEqual([])
  await app.close()
})

test("the status bar's account menu: Continue as, a disabled (sign in again), Sign in to Studio again…, Add account…", async () => {
  const { app, page, work } = await launchAccounts({
    accounts: (root) => [...workAccount(root), ...studioAccount(root)],
    script: { turns: {}, auth: { studio: { gate: 'go' } } }
  })
  await expect.poll(() => stateOf(page, 'Studio'), LONG).toBe('signed-out')
  await openClaude(page, work, null)
  await page.locator('#statusbar .status-account').click()

  const menu = page.locator('.menu')
  await expect(menu.locator('.menu-item').first()).toBeVisible()
  expect(await menu.locator('.menu-item').allTextContents()).toEqual([
    'Continue as Work',
    'Continue as Studio (sign in again)',
    'Sign in to Studio again…',
    'Add account…'
  ])
  await expect(menu.locator('.menu-item.disabled')).toHaveText('Continue as Studio (sign in again)')
  await expect(menu.locator('.menu-sep')).toHaveCount(1)

  const win = await openedSettings(app, () => menu.locator('.menu-item', { hasText: 'Sign in to Studio again…' }).click())
  await expect(win.locator('.account-dialog .helper-title')).toHaveText('Sign in to Studio again', LONG)
  await app.close()
})

test('the foot names the plan of a sign-in account and Token account for a token one', async () => {
  const { app, page, work } = await launchAccounts({ accounts: (root) => [...workAccount(root), tokenEntry(CI_BOT, 'CI bot', CI_TOKEN)] })
  // the foot is the left panel's: the tabs move there first
  await page.evaluate(() => window.ct.setSetting('tabs.position', 'left'))
  const account = page.locator('#tabpanel .tp-account')
  await expect.poll(() => stateOf(page, 'Work'), LONG).toBe('ready')

  await openClaude(page, work, WORK)
  await expect(account.locator('.tp-account-name')).toHaveText('Work')
  await expect(account.locator('.tp-account-plan')).toHaveText('Max plan', LONG)

  await openClaude(page, work, CI_BOT)
  await expect(account.locator('.tp-account-name')).toHaveText('CI bot')
  await expect(account.locator('.tp-account-plan')).toHaveText('Token account')
  await app.close()
})
