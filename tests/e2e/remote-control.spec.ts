import { expect, test } from '@playwright/test'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { launchAccounts } from './account-helpers'
import { openRcTab, RC_CLEAN_ENV, rcStatus, typedLines } from './remote-control-helpers'

const LONG = { timeout: 20_000 }

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
