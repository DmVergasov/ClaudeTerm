import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const ROOT = resolve(__dirname, '..', '..')

export const FAKE_CLAUDE_SETTINGS = { claude: { command: 'cmd /c echo fake-claude', shellProfile: 'Windows PowerShell' }, defaultProfile: 'Windows PowerShell' }

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

export async function launchApp(o: { dataDir?: string; settings?: object; args?: string[] } = {}): Promise<Launched> {
  const dataDir = o.dataDir ?? makeDataDir(o.settings)
  const pipeName = `\\\\.\\pipe\\claudeterm-e2e-${randomUUID()}`
  const app = await electron.launch({ args: [ROOT, ...(o.args ?? [])], env: testEnv(dataDir, pipeName) })
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

export async function launchClaudeTab(): Promise<Launched & { work: string; tabId: string }> {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work] })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, work, tabId }
}
