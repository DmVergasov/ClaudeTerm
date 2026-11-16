import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { claudeRuns, launchAccounts } from './account-helpers'
import { openRcTab, RC_CLEAN_ENV, rcStatus, typedLines } from './remote-control-helpers'

const LONG = { timeout: 20_000 }

/** the --rc argument of a run: the name after it, null when there is none */
const rcArg = (argv: string[]): string | null => (argv.includes('--rc') ? argv[argv.indexOf('--rc') + 1] ?? null : null)

test('the switch types /remote-control with the tab’s title into Claude Code’s prompt, and off types /remote-control', async () => {
  const t = await launchAccounts({ view: 'terminal', env: RC_CLEAN_ENV })
  try {
    const tabId = await openRcTab(t.page, t.work)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), tabId)
    await expect.poll(() => typedLines(t.log), LONG).toEqual(['/remote-control Fix the parser'])
    // Claude Code connects: its next statusLine carries the id
    expect(await sendPipeMessage(t.pipeName, rcStatus(tabId, 'session_01E2eTest'))).toEqual({ ok: true })
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, false), tabId)
    await expect.poll(() => typedLines(t.log), LONG).toEqual(['/remote-control Fix the parser', '/remote-control'])
  } finally {
    await t.app.close()
  }
})

test('the account flag starts the next Claude tab of the account with --rc and its title, through the real shell; the tabs already open keep theirs', async () => {
  const t = await launchAccounts({ view: 'terminal', env: RC_CLEAN_ENV })
  try {
    const first = await openRcTab(t.page, t.work)
    await t.page.evaluate((id) => window.ct.remoteControlAccount(id, true), first)
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).toBe(true)
    await openRcTab(t.page, t.work)
    await expect.poll(() => claudeRuns(t.log).length, LONG).toBe(2)
    // the shell took the quoted name as one argument
    expect(claudeRuns(t.log).map((r) => rcArg(r.argv))).toEqual([null, 'Fix the parser'])
    await t.page.evaluate((id) => window.ct.remoteControlAccount(id, false), first)
    await expect.poll(() => JSON.parse(readFileSync(join(t.dataDir, 'settings.json'), 'utf8')).claude?.remoteControl).toBe(false)
    await openRcTab(t.page, t.work)
    await expect.poll(() => claudeRuns(t.log).length, LONG).toBe(3)
    expect(rcArg(claudeRuns(t.log)[2].argv)).toBeNull()
  } finally {
    await t.app.close()
  }
})
