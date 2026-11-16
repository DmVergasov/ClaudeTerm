import type { Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatusMessage } from '../../src/shared/protocol'
import { FAKE_CLAUDE_SETTINGS, launchApp, type Launched } from './helpers'

/** the tabs' own title: a terminal tab's title otherwise follows the shell's, which differs between machines */
export const RC_TITLE = 'Fix the parser'
/** opens a Claude tab titled RC_TITLE in the folder, on the account (null: the main one), and waits until it is in front; its id */
export async function openRcTab(page: Page, cwd: string, account: string | null = null): Promise<string> {
  const tab = await page.evaluate(({ cwd, account, title }) => window.ct.openTab({ kind: 'claude', cwd, account, title }), { cwd, account, title: RC_TITLE })
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tab!.id)
  return tab!.id
}
export const RC_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
/** the sign-in variables a developer's or a runner's environment may hold, emptied: an empty one is no sign-in */
export const RC_CLEAN_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '', ANTHROPIC_BASE_URL: '', CLAUDE_TRUSTED_DEVICE_TOKEN: ''
}
/** a statusLine report of the tab, with the RC id Claude Code would send (null: not connected) */
export const rcStatus = (tabId: string, remote: string | null): StatusMessage => ({
  v: 1, type: 'status', tabId, sessionId: RC_SID, model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: null, context: null, fiveHour: null, sevenDay: null, remote
})
/** the app with one Claude tab of the echo stand-in in a temp folder, with no sign-in in its environment */
export async function launchRcTerminal(): Promise<Launched & { tabId: string; work: string }> {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work], env: RC_CLEAN_ENV })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  return { ...launched, work, tabId: (await launched.page.evaluate(() => window.__ct!.activeTabId()))! }
}
/** the lines the stand-in Claude Code read in its terminal, in order */
export const typedLines = (log: () => Record<string, unknown>[]): string[] => log().flatMap((e) => (typeof e.in === 'string' ? [e.in] : []))
