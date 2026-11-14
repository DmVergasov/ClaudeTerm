import { type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SettingsSection } from '../../src/shared/ipc'
import type { FakeScript } from '../fixtures/fake-claude/install'
import { FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir, type Launched } from './helpers'
import { MAIN_CREDENTIAL, MAIN_WHO, readLog, trust } from '../fixtures/accounts'

export * from '../fixtures/accounts'

// The stand-in Claude Code as the command of the app (chat-helpers.ts does the same for its tabs)
const STAND_IN = resolve(__dirname, '..', 'fixtures', 'fake-claude', 'fake-claude.ts')
const ADDED = '2026-10-01T09:00:00.000Z'

function installCommand(dir: string): string {
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    const file = join(dir, 'claude.cmd')
    writeFileSync(file, `@"${process.execPath}" --experimental-strip-types --no-warnings "${STAND_IN}" %*\r\n`)
    return file
  }
  const file = join(dir, 'claude')
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${STAND_IN}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

export interface AccountsApp extends Launched {
  /** the working folder of the tests: trusted in Main account */
  work: string
  /** Main account's config folder (CLAUDE_CONFIG_DIR) */
  config: string
  /** the temp folder of the run: accounts (CLAUDETERM_ACCOUNTS_ROOT) sit under it */
  root: string
  log(): Record<string, unknown>[]
}

/** an accounts.json version 2 entry: a sign-in account, its folder made by ClaudeTerm unless `created` is false */
export function loginEntry(id: string, name: string, folder: string, created = true): object {
  return { kind: 'login', id, name, addedAt: ADDED, folder, created }
}

/** an accounts.json version 2 entry: a token account */
export function tokenEntry(id: string, name: string, token: string): object {
  return { kind: 'token', id, name, addedAt: ADDED, token, encrypted: false }
}

/**
 * The app with the accounts' layout: Main account at <root>/main (CLAUDE_CONFIG_DIR: MAIN_WHO as its oauthAccount, the
 * work folder trusted, a .credentials.json holding MAIN_CREDENTIAL), the accounts under <root>/accounts
 * (CLAUDETERM_ACCOUNTS_ROOT), accounts.json version 2 of `accounts`, and the stand-in's script.json and fake-claude.log
 * in <root>. The Claude tabs use the stand-in, in the terminal or the chat as `view` says.
 */
export async function launchAccounts(
  o: { accounts?: object[] | ((root: string) => object[]); script?: FakeScript; view?: 'terminal' | 'chat'; env?: Record<string, string>; main?: (config: string) => void } = {}
): Promise<AccountsApp> {
  const root = mkdtempSync(join(tmpdir(), 'ct-accounts-'))
  const work = join(root, 'work')
  const config = join(root, 'main')
  const accounts = join(root, 'accounts')
  mkdirSync(work, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(accounts, { recursive: true })
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ oauthAccount: MAIN_WHO }))
  writeFileSync(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: MAIN_CREDENTIAL } }))
  trust(config, work)
  o.main?.(config)

  const scriptFile = join(root, 'script.json')
  writeFileSync(scriptFile, JSON.stringify(o.script ?? { turns: {} }))
  const logFile = join(root, 'fake-claude.log')
  const command = installCommand(join(root, 'bin'))
  // Heads up asks a second Claude Code process now and then: off here, so the tests start only their own
  const settings = {
    ...FAKE_CLAUDE_SETTINGS,
    claude: { ...FAKE_CLAUDE_SETTINGS.claude, command, view: o.view ?? 'terminal', autoContinue: false, headsUp: false }
  }
  const dataDir = makeDataDir(settings)
  const accountList = typeof o.accounts === 'function' ? o.accounts(root) : (o.accounts ?? [])
  writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({ version: 2, accounts: accountList }))
  const launched = await launchApp({
    dataDir,
    env: {
      CLAUDE_CONFIG_DIR: config,
      CLAUDETERM_ACCOUNTS_ROOT: accounts,
      FAKE_CLAUDE_SCRIPT: scriptFile,
      FAKE_CLAUDE_LOG: logFile,
      ...o.env
    }
  })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  return { ...launched, work, config, root, log: () => readLog(logFile) }
}

/** the Settings window, opened at `section` by the main window: its page, once it has loaded */
export async function settingsWindow(app: ElectronApplication, page: Page, section?: SettingsSection): Promise<Page> {
  const [win] = await Promise.all([app.waitForEvent('window'), page.evaluate((s) => window.ct.openSettingsWindow(s), section)])
  await win.waitForLoadState('domcontentloaded')
  return win
}
