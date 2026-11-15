import { expect, test } from '@playwright/test'
import { activate, openPanelFocused, refOf, waitForMail } from './agent-mail'
import { coord, coordApp, done, makeCoordinator, within } from './coordinator-helpers'

test('the Agent messages panel shows a task and its report with their kinds, and no attach record', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    await makeCoordinator(page, t0)
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })
    const task = waitForMail(pipeName, t1, sids[1])
    await coord(pipeName, t0, { op: 'message', session: refOf(sids[1]), text: 'Fix the parser.' })
    await within(task, 10_000)
    await activate(page, t1)
    await openPanelFocused(page)
    const given = page.locator('#image-panel .mail-message', { hasText: 'Fix the parser.' })
    await expect(given.locator('.mail-kind')).toHaveText('Task')
    // the attach is no message: the tab's conversation holds the task alone
    await expect(page.locator('#image-panel .mail-message')).toHaveCount(1)
    const wake = waitForMail(pipeName, t0, sids[0])
    await done(pipeName, t1, sids[1], { lastMessage: 'Parser fixed.' })
    await within(wake, 15_000)
    await activate(page, t0)
    const report = page.locator('#image-panel .mail-message', { hasText: 'Parser fixed.' }).locator('.mail-kind')
    await expect(report).toHaveText('Report · finished')
    await expect(report).toHaveClass('mail-kind')
    await expect(report).not.toHaveClass(/failed/)
  } finally { await l.app.close() }
})

test('a report of a task that failed names the failure, and its kind is marked failed', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    await makeCoordinator(page, t0)
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })
    const task = waitForMail(pipeName, t1, sids[1])
    await coord(pipeName, t0, { op: 'message', session: refOf(sids[1]), text: 'Fix the parser.' })
    await within(task, 10_000)
    const wake = waitForMail(pipeName, t0, sids[0])
    // an API error that ClaudeTerm does not continue fails the task, as coordinator-tasks.spec.ts makes it
    await done(pipeName, t1, sids[1], { error: 'invalid_request' })
    await within(wake, 15_000)
    await activate(page, t0)
    await openPanelFocused(page)
    const failed = page.locator('#image-panel .mail-message', { hasText: 'Claude Code stopped the turn on an error' }).locator('.mail-kind')
    await expect(failed).toHaveText('Report · failed: Claude Code stopped the turn on an error (invalid_request)')
    await expect(failed).toHaveClass('mail-kind failed')
  } finally { await l.app.close() }
})
