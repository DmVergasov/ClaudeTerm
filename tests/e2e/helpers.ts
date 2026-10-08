import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { testPipeName, WIN } from '../fixtures/platform'

export const ROOT = resolve(__dirname, '..', '..')

/** the shell the tests type into: Windows PowerShell, or bash without startup files (prompt "bash-5.2$ ") */
export const TEST_SHELL = WIN ? 'Windows PowerShell' : 'Test Bash'
const TEST_PROFILES = [{ name: 'Test Bash', command: '/bin/bash', args: ['--norc', '--noprofile', '-i'] }]
/** the test shell's prompt, once it waits for input (the buffer text has no trailing spaces) */
export const PROMPT = WIN ? /PS .*>/ : /bash-[\d.]+\$/

// "claude" prints its arguments instead of starting (on Linux also the folder it runs in, as PowerShell's prompt shows it)
export const FAKE_CLAUDE_SETTINGS = WIN
  ? { claude: { command: 'cmd /c echo fake-claude', shellProfile: TEST_SHELL }, defaultProfile: TEST_SHELL }
  : { claude: { command: 'pwd; echo fake-claude', shellProfile: TEST_SHELL }, defaultProfile: TEST_SHELL, profiles: TEST_PROFILES }

/** what to type for a terminal bell, then optionally a word that shows the line ran */
export function bellCommand(after?: string): string {
  if (WIN) return `Write-Host -NoNewline ([char]7)${after ? `; '${after}'` : ''}\r`
  return `printf '\\a'${after ? `; echo ${after}` : ''}\r`
}

/** whether a node process whose command line holds the marker is running */
export function processAlive(marker: string): boolean {
  if (WIN) {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`], { encoding: 'utf8' }).trim() !== '0'
  }
  try {
    execFileSync('pgrep', ['-f', marker], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export function makeDataDir(settings?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-e2e-'))
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
  return dir
}

export function testEnv(dataDir: string, pipeName: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    CLAUDETERM_TEST: '1',
    CLAUDETERM_DATA_DIR: dataDir,
    CLAUDETERM_PIPE_NAME: pipeName,
    CLAUDETERM_SKIP_MCP_REGISTER: '1'
  }
}

export interface Launched { app: ElectronApplication; page: Page; dataDir: string; pipeName: string }

export async function launchApp(o: { dataDir?: string; settings?: object; args?: string[]; env?: Record<string, string> } = {}): Promise<Launched> {
  const dataDir = o.dataDir ?? makeDataDir(o.settings)
  const pipeName = testPipeName('e2e')
  const app = await electron.launch({ args: [ROOT, ...(o.args ?? [])], env: { ...testEnv(dataDir, pipeName), ...o.env } })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.__ct))
  return { app, page, dataDir, pipeName }
}

export async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

export function bufferText(page: Page, tabId?: string): Promise<string> {
  return page.evaluate((id) => window.__ct!.bufferText(id ?? undefined), tabId ?? null)
}

export async function launchClaudeTab(settings: object = FAKE_CLAUDE_SETTINGS, work: string = mkdtempSync(join(tmpdir(), 'ct-work-'))): Promise<Launched & { work: string; tabId: string }> {
  const launched = await launchApp({ settings, args: ['--claude', work] })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, work, tabId }
}

/** a git repository with one commit: a.ts = "one\ntwo\nthree\n" */
export function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-repo-'))
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n')
  git('add', '-A')
  git('commit', '-qm', 'one')
  return dir
}
