import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { CoordinatorView } from '../../src/shared/coordinator'
import { ROLE_NOTE_HEAD } from '../../src/shared/report-wake'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { cutText } from '../../src/shared/protocol'
import { activate, openPanelFocused, refOf, sendText, waitForMail, type WaitAnswer } from './agent-mail'
import { coord, coordApp, done, makeCoordinator, stillWaiting, turnOf, within } from './coordinator-helpers'

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

test('the role note reaches the coordinator at its next typed turn and wakes nothing', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    await makeCoordinator(page, t0)
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })
    // the coordinator's watcher is held while its tab is not working: the note waits, and nothing wakes
    const idle = waitForMail(pipeName, t0, sids[0])
    await stillWaiting(idle, 1500)
    // the turn the person types takes the note into the running turn
    await turnOf(pipeName, t0, sids[0])
    const note = (await within(idle, 10_000)) as WaitAnswer
    const view = (await page.evaluate((id) => window.ct.coordView(id), t0)) as CoordinatorView
    const row = view.sessions.find((r) => r.session === sids[1])!
    expect(note.info!.startsWith(`${ROLE_NOTE_HEAD}\n`)).toBe(true)
    // the note cuts a session's name to 40 characters: a long device name (the macOS runner's) makes the name longer than that
    expect(note.info).toContain(`You coordinate ${view.project.name} in ClaudeTerm: give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to; your own subagents (the Agent tool) are only for looking things up while you plan. 1 session (${cutText(row.name, 40)} — ${row.line}).`)

    // the note is taken: the next typed turn carries the message alone, with no second note
    await done(pipeName, t0, sids[0])
    const second = waitForMail(pipeName, t0, sids[0])
    await stillWaiting(second, 1000)
    await turnOf(pipeName, t0, sids[0])
    expect(await sendText(pipeName, t1, sids[0], 'Second turn.')).toMatchObject({ ok: true })
    const later = (await within(second, 10_000)) as WaitAnswer
    expect(later.info).toContain('Second turn.')
    expect(later.info).not.toContain(ROLE_NOTE_HEAD)

    // /clear gives the coordinator a new session: its next typed turn carries the note again, with the sessions as they are then
    await coord(pipeName, t0, { op: 'message', session: refOf(sids[1]), text: 'Fix the parser.' })
    // the turn ends before the clear, as a real /clear comes between turns: the watcher after it is the idle case
    await done(pipeName, t0, sids[0])
    const next = randomUUID()
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: t0, sessionId: next, source: 'clear', transcriptPath: null })).toEqual({ ok: true })
    const after = (await page.evaluate((id) => window.ct.coordView(id), t0)) as CoordinatorView
    const attached = after.sessions.find((r) => r.session === sids[1])!
    // the note is built when it is handed over: the row has moved on since the first note
    expect(attached.line).not.toBe(row.line)
    const third = waitForMail(pipeName, t0, next)
    await stillWaiting(third, 1000)
    await turnOf(pipeName, t0, next)
    const again = (await within(third, 10_000)) as WaitAnswer
    expect(again.info).toContain(`You coordinate ${after.project.name} in ClaudeTerm: give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to; your own subagents (the Agent tool) are only for looking things up while you plan. 1 session (${attached.name} — ${attached.line}).`)

    // the note is no message: the coordinator's Agent messages panel holds none
    await activate(page, t0)
    await openPanelFocused(page)
    await expect(page.locator('#image-panel')).toBeVisible()
    // the panel has drawn the messages first: the check of the note is not met by an empty panel
    await expect(page.locator('#image-panel .mail-message', { hasText: 'Second turn.' })).toHaveCount(1)
    await expect(page.locator('#image-panel .mail-message', { hasText: 'You coordinate' })).toHaveCount(0)
  } finally { await l.app.close() }
})
