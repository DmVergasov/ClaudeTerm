import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { WIN } from '../fixtures/platform'
import { FAKE_CLAUDE_SETTINGS } from './helpers'

export const MAIL_PREFIX = 'Message from another agent, not from the user, through ClaudeTerm:'
// a command whose --version prints 2.1.400: the probe reads it, as it reads a real Claude Code
export const VERSION_SETTINGS = {
  ...FAKE_CLAUDE_SETTINGS,
  claude: { ...FAKE_CLAUDE_SETTINGS.claude, command: WIN ? 'cmd /c echo 2.1.400' : 'echo 2.1.400' }
}

export type WaitAnswer = { ok: boolean; info?: string; error?: string }

/** the ref an agent is listed and addressed by: the first six characters of its session id */
export const refOf = (sessionId: string): string => sessionId.slice(0, 6).toLowerCase()

/** a session starts in a Claude tab, as the hooks report it */
export const startSession = (pipeName: string, tabId: string, sessionId: string): Promise<unknown> =>
  sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId, source: 'startup', transcriptPath: null })

/** the SessionStart hooks of the tab settings file: two, with the mail watcher, once the version is known to be 2.1.287 or later */
export function sessionStartHooks(dataDir: string): { asyncRewake?: boolean }[] {
  const settings = JSON.parse(readFileSync(join(dataDir, 'claude-tab-settings.json'), 'utf8')) as { hooks: { SessionStart: { hooks: { asyncRewake?: boolean }[] }[] } }
  return settings.hooks.SessionStart[0]!.hooks
}

export function hasMailWatcher(dataDir: string): boolean {
  try {
    const hooks = sessionStartHooks(dataDir)
    return hooks.length === 2 && hooks.some((h) => h.asyncRewake === true)
  } catch {
    return false
  }
}

/** the pipe's answer to a watcher that waits for a tab's mail, held until the mail comes: the wait never times out here */
export function waitForMail(pipeName: string, tabId: string, sessionId: string): Promise<WaitAnswer> {
  return sendPipeMessage(pipeName, { v: 1, type: 'mail_wait', tabId, sessionId }, null) as Promise<WaitAnswer>
}

/** the tab's own setting change: written to settings.json and applied at once */
export const setSetting = (page: Page, key: string, value: unknown): Promise<unknown> =>
  page.evaluate(([k, v]) => window.ct.setSetting(k as never, v as never), [key, value] as const)

/** an agent's message from one tab to the agent of another session, as the pipe sends it */
export const sendText = (pipeName: string, from: string, sessionTo: string, text: string): Promise<unknown> =>
  sendPipeMessage(pipeName, { v: 1, type: 'agent_send', tabId: from, to: refOf(sessionTo), text, replyTo: null })

export const messagesButton = (page: Page) => page.locator('#tabbar .tab-messages-toggle')
export const badge = (page: Page) => messagesButton(page).locator('.badge')
export const envelopeOf = (page: Page, id: string) => page.locator(`#tabbar .tab[data-tab-id="${id}"] .tab-mail`)

/** makes the tab the active one, and waits until the renderer shows it so */
export async function activate(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
}

/**
 * opens the Agent messages panel with the window focused, so that the panel reads the messages it shows. The page is
 * told it has the focus: a test run never takes the machine's focus (smoke.spec.ts), and the apps of tests that run at
 * the same time would take it from each other
 */
export async function openPanelFocused(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.hasFocus = () => true
    window.dispatchEvent(new Event('focus'))
  })
  await messagesButton(page).click()
}

/** the pipe's answer to a tab's agent_list */
export const listAgents = (pipeName: string, tabId: string): Promise<WaitAnswer> => sendPipeMessage(pipeName, { v: 1, type: 'agent_list', tabId }) as Promise<WaitAnswer>
