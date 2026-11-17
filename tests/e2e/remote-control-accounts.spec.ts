import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatReady } from './chat-helpers'
import { CI_BOT, CI_TOKEN, launchAccounts, loginEntry, runs, signedIn, tokenEntry, trust, WORK } from './account-helpers'
import { bridgeSeen, FAKE_BRIDGE, openRcTab, RC_CLEAN_ENV } from './remote-control-helpers'

/** the sign-in account Work: a folder under the accounts folder, signed in as Work, trusting the tests' work folder */
function workAccount(root: string): object[] {
  const folder = join(root, 'accounts', 'work')
  mkdirSync(folder, { recursive: true })
  signedIn(folder)
  trust(folder, join(root, 'work'))
  return [loginEntry(WORK, 'Work', folder)]
}

test('a chat tab on an extra sign-in account attaches with that account’s own credentials, not the main ones', async () => {
  const t = await launchAccounts({ view: 'chat', accounts: workAccount, env: { ...RC_CLEAN_ENV, CLAUDETERM_TEST_BRIDGE: FAKE_BRIDGE } })
  try {
    const tabId = await openRcTab(t.page, t.work, WORK)
    await chatReady(t.page)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), tabId)
    await expect.poll(async () => (await bridgeSeen(t.app)).calls[0], { timeout: 20_000 }).toMatchObject({ fn: 'create', token: 'fake-credential-never-shown-0001-work' })
  } finally {
    await t.app.close()
  }
})

test('a token account’s tab is unavailable with its reason, and its switch is disabled', async () => {
  const t = await launchAccounts({ view: 'terminal', accounts: [tokenEntry(CI_BOT, 'CI bot', CI_TOKEN)], env: RC_CLEAN_ENV })
  try {
    await openRcTab(t.page, t.work, CI_BOT)
    const seg = t.page.locator('#statusbar .status-remote')
    await expect(seg).toHaveAttribute('data-dot', 'unavailable')
    await expect(seg).toHaveAttribute('title', 'This account signs in with a token: Remote Control needs a claude.ai sign-in')
    await seg.click()
    await expect(t.page.locator('.remote-popover input.switch')).toBeDisabled()
    await expect(t.page.locator('.remote-popover .remote-account input')).toBeDisabled()
  } finally {
    await t.app.close()
  }
})

test('a sign-in from the environment makes the main account’s tab unavailable with the same reason', async () => {
  const t = await launchAccounts({ view: 'terminal', env: { ...RC_CLEAN_ENV, ANTHROPIC_API_KEY: 'e2e-fake-api-key-0001' } })
  try {
    await openRcTab(t.page, t.work)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'unavailable')
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('title', 'This account signs in with a token: Remote Control needs a claude.ai sign-in')
  } finally {
    await t.app.close()
  }
})

test('the checkbox on a sign-in account’s tab keeps its flag in accounts.json, and that account’s next tab starts with --rc', async () => {
  const t = await launchAccounts({ view: 'terminal', accounts: workAccount, env: RC_CLEAN_ENV })
  try {
    const tabId = await openRcTab(t.page, t.work, WORK)
    await t.page.evaluate((id) => window.ct.remoteControlAccount(id, true), tabId)
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'accounts.json'), 'utf8')).accounts[0].remoteControl).toBe(true)
    // the main account's flag stays off
    expect(JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).not.toBe(true)
    await openRcTab(t.page, t.work, WORK)
    await expect.poll(() => runs(t.log).filter((r) => r.config?.endsWith('work') && r.argv.includes('--rc')).length, { timeout: 20_000 }).toBe(1)
  } finally {
    await t.app.close()
  }
})
