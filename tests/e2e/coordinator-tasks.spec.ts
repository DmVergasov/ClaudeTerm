import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoordMarks } from '../../src/shared/coordinator'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { bufferText, gitRepo, launchApp, makeDataDir, type Launched } from './helpers'
import { activate, envelopeOf, refOf, sendText, startSession, VERSION_SETTINGS, waitForMail } from './agent-mail'
import { launchChatTab, sendMessage, userMessages } from './chat-helpers'
import { chatState, coord, coordApp, done, logHas, makeCoordinator, stillWaiting, terminalPair, turnOf, within } from './coordinator-helpers'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const ask = (pipeName: string, tabId: string, sessionId: string, prompt: string): Promise<unknown> =>
  sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'permission', prompt })
const listOf = async (pipeName: string, tabId: string): Promise<string> => (await coord(pipeName, tabId, { op: 'list' })).info ?? ''
const marksOf = (page: Page): Promise<CoordMarks> => page.evaluate(() => window.ct.coordMarks())

/**
 * The app with a coordinator in tab 1 that has attached the session of tab 2 and given it a task, 'Fix the parser.'. The task
 * is open: the watcher of tab 2 took it. `c` is the coordinator's watcher, held for the report.
 */
async function openTask(o: { count?: number; transcripts?: boolean; env?: Record<string, string>; dataDir?: string } = {}) {
  const l = await coordApp(o.count ?? 2, { transcripts: o.transcripts, env: o.env, dataDir: o.dataDir })
  const { pipeName, page } = l
  const [tab1, tab2] = [l.tabs[0]!, l.tabs[1]!]
  const [sid1, sid2] = [l.sids[0]!, l.sids[1]!]
  expect(await makeCoordinator(page, tab1)).toMatchObject({ ok: true })
  expect(await coord(pipeName, tab1, { op: 'attach', session: refOf(sid2) })).toMatchObject({ ok: true })
  const c = waitForMail(pipeName, tab1, sid1)
  // a watcher no test awaits ends with its app: the closed pipe is not an error of the test
  c.catch(() => {})
  const w = waitForMail(pipeName, tab2, sid2)
  expect(await coord(pipeName, tab1, { op: 'message', session: refOf(sid2), text: 'Fix the parser.' })).toMatchObject({ ok: true })
  expect(await w).toMatchObject({ ok: true })
  return { ...l, tab1, tab2, sid1, sid2, c }
}

test('the end of a task wakes the coordinator with the session\'s last answer as a finished report', async () => {
  const t = await openTask()
  try {
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'Parser fixed; 12 tests pass.' })
    const report = await within(t.c, 15_000)
    expect(report.info).toContain('Report from a session attached to you, through ClaudeTerm: its task finished.')
    expect(report.info).toContain('> Parser fixed; 12 tests pass.')
  } finally {
    await t.app.close()
  }
})

test('the person\'s turn right after the Stop keeps the task open: the report is the answer after it', async () => {
  const t = await openTask()
  try {
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'first' })
    await turnOf(t.pipeName, t.tab2, t.sid2)
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'second' })
    const report = await within(t.c, 15_000)
    expect(report.info).toContain('> second')
    expect(report.info).not.toContain('first')
  } finally {
    await t.app.close()
  }
})

test('background work still running at the Stop keeps the task open', async () => {
  const t = await openTask()
  try {
    await done(t.pipeName, t.tab2, t.sid2, { background: true, tasks: [{ id: 'b1', type: 'shell', description: 'npm run watch', command: 'npm run watch' }] })
    await stillWaiting(t.c, 3500)
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'Watcher done.' })
    expect((await within(t.c, 15_000)).info).toContain('> Watcher done.')
  } finally {
    await t.app.close()
  }
})

test('a Stop with background work still running sends the coordinator the answer at once as a progress note; the report comes when the work ends', async () => {
  const t = await openTask()
  try {
    await done(t.pipeName, t.tab2, t.sid2, {
      background: true,
      tasks: [{ id: 'b1', type: 'shell', description: 'npm run test:e2e', command: 'npm run test:e2e' }],
      lastMessage: "The full test run is going in the background. I wait for the person's go to push."
    })
    const note = await within(t.c, 10_000)
    expect(note.info).toContain('Progress from a session attached to you, through ClaudeTerm: its task is still open, background work is running.')
    expect(note.info).toContain("> The full test run is going in the background. I wait for the person's go to push.")
    // the coordinator's list shows the session's latest word while its work runs
    expect(await listOf(t.pipeName, t.tab1)).toContain("· Background work · The full test run is going in the background. I wait for the person's go to push.")

    // the coordinator answers the person and rests; its next watcher gets the report when the work ends
    await done(t.pipeName, t.tab1, t.sid1, { lastMessage: 'The tests run; I will tell you.' })
    const c2 = waitForMail(t.pipeName, t.tab1, t.sid1)
    c2.catch(() => {})
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'Tests pass; pushed.' })
    const report = await within(c2, 15_000)
    expect(report.info).toContain('Report from a session attached to you, through ClaudeTerm: its task finished.')
    expect(report.info).toContain('> Tests pass; pushed.')
  } finally {
    await t.app.close()
  }
})

test('an error ClaudeTerm does not continue fails the task', async () => {
  const t = await openTask()
  try {
    await done(t.pipeName, t.tab2, t.sid2, { error: 'invalid_request' })
    expect((await within(t.c, 15_000)).info).toContain('its task failed: Claude Code stopped the turn on an error (invalid_request).')
  } finally {
    await t.app.close()
  }
})

test('a usage limit is no outcome: list_sessions shows it until the next turn', async () => {
  const t = await openTask()
  try {
    await done(t.pipeName, t.tab2, t.sid2, { error: 'rate_limit' })
    await stillWaiting(t.c, 3000)
    expect(await listOf(t.pipeName, t.tab1)).toContain('Usage limit')
    await turnOf(t.pipeName, t.tab2, t.sid2)
    expect(await listOf(t.pipeName, t.tab1)).not.toContain('Usage limit')
  } finally {
    await t.app.close()
  }
})

test('a permission prompt shows in list_sessions until the turn ends', async () => {
  const t = await openTask()
  try {
    expect(await ask(t.pipeName, t.tab2, t.sid2, 'Allow Bash: npm test')).toEqual({ ok: true })
    const shown = await listOf(t.pipeName, t.tab1)
    expect(shown).toMatch(new RegExp(`^- .+ \\[${refOf(t.sid2)}\\] · Allow Bash: npm test`, 'm'))
    expect(shown).toContain('A permission prompt or question waits for the user in')

    await done(t.pipeName, t.tab2, t.sid2)
    expect(await listOf(t.pipeName, t.tab1)).not.toContain('Allow Bash: npm test')
  } finally {
    await t.app.close()
  }
})

test('Esc in the task\'s turn stops it: the coordinator is told at its next turn, not woken', async () => {
  const t = await openTask()
  try {
    await turnOf(t.pipeName, t.tab2, t.sid2)
    await t.page.evaluate((id) => window.ct.writePty(id, '\x1b'), t.tab2)
    await stillWaiting(t.c, 2500)
    await turnOf(t.pipeName, t.tab1, t.sid1)
    expect((await within(t.c, 10_000)).info).toContain('its task was stopped by the user: its turn was interrupted.')
  } finally {
    await t.app.close()
  }
})

test('a Stop in the chat ends a task\'s turn like Esc does', async () => {
  const t = await openTask()
  try {
    await turnOf(t.pipeName, t.tab2, t.sid2)
    await t.page.evaluate((id) => window.ct.chatInterrupt(id), t.tab2)
    await stillWaiting(t.c, 2500)
    await turnOf(t.pipeName, t.tab1, t.sid1)
    expect((await within(t.c, 10_000)).info).toContain('its task was stopped by the user: its turn was interrupted.')
  } finally {
    await t.app.close()
  }
})

test('a permission prompt the person denies in the task\'s turn stops the task: the transcript says the turn was interrupted', async () => {
  const t = await openTask({ transcripts: true, env: { CLAUDETERM_TEST_FEED_MAX_MS: '200' } })
  try {
    await turnOf(t.pipeName, t.tab2, t.sid2)
    // the line Claude Code writes when the person denies a tool's permission: the feed reads it as an interrupt of the main conversation
    appendFileSync(t.transcripts[1]!, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, timestamp: new Date().toISOString() }) + '\n')
    await stillWaiting(t.c, 2500)
    await turnOf(t.pipeName, t.tab1, t.sid1)
    expect((await within(t.c, 10_000)).info).toContain('its task was stopped by the user: its turn was interrupted.')
  } finally {
    await t.app.close()
  }
})

test('an answer the person gives in the middle of a turn closes the dialog: the coordinator stops waiting for it', async () => {
  const t = await openTask({ transcripts: true, env: { CLAUDETERM_TEST_FEED_MAX_MS: '200' } })
  try {
    await turnOf(t.pipeName, t.tab2, t.sid2)
    expect(await ask(t.pipeName, t.tab2, t.sid2, 'Allow Bash: npm test')).toEqual({ ok: true })
    expect(await listOf(t.pipeName, t.tab1)).toContain('Allow Bash: npm test')
    // the answer is the next assistant entry of the transcript: no Stop follows it; written a second on, so the clock's tick does not decide it
    appendFileSync(t.transcripts[1]!, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the tests.' }] }, timestamp: new Date(Date.now() + 1000).toISOString() }) + '\n')
    await expect.poll(async () => (await listOf(t.pipeName, t.tab1)).includes('Allow Bash: npm test'), { timeout: 15_000 }).toBe(false)
  } finally {
    await t.app.close()
  }
})

test('the process exiting fails the open task', async () => {
  const t = await openTask()
  try {
    await t.page.evaluate((id) => window.ct.writePty(id, 'exit\r'), t.tab2)
    expect((await within(t.c, 15_000)).info).toContain('its task failed: Claude Code exited.')
  } finally {
    await t.app.close()
  }
})

test('closing the session\'s tab fails its task', async () => {
  const t = await openTask()
  try {
    await t.page.evaluate((id) => window.ct.closeTab(id), t.tab2)
    expect((await within(t.c, 15_000)).info).toContain('its task failed: its tab was closed.')
  } finally {
    await t.app.close()
  }
})

test('an open task survives a quit; the restored session\'s rest reports it', async () => {
  const first = await openTask()
  let second: Launched | null = null
  try {
    // the window closes and keeps its tabs in the session snapshot of the data folder, then a second window restores them
    const closed = first.app.waitForEvent('close')
    await first.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
    await closed

    second = await launchApp({ dataDir: first.dataDir })
    await expect.poll(() => second!.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
    await second.page.locator('.banner-restore').click()
    await expect.poll(async () => Object.values(await marksOf(second!.page)).map((m) => m.role).sort()).toEqual(['attached', 'coordinator'])

    const marks = await marksOf(second.page)
    const restoredCoordinator = Object.keys(marks).find((id) => marks[id]!.role === 'coordinator')!
    const restoredSession = Object.keys(marks).find((id) => marks[id]!.role === 'attached')!
    const report = waitForMail(second.pipeName, restoredCoordinator, first.sid1)
    await done(second.pipeName, restoredSession, first.sid2, { lastMessage: 'Parser fixed after the restore.' })
    expect((await within(report, 15_000)).info).toContain('> Parser fixed after the restore.')
  } finally {
    await second?.app.close()
    await first.app.close().catch(() => {})
  }
})

/** the restarted Claude Code of a tab runs: the stand-in prints its arguments, and a restart resumes the tab's conversation */
const restarted = (page: Page, tabId: string, sessionId: string): Promise<void> =>
  expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toContain(`--resume ${sessionId}`)

test('a restart of the session\'s tab ends the turn it was in: a task queued in that turn goes to the next watcher', async () => {
  const l = await coordApp(2)
  const [tab1, tab2] = [l.tabs[0]!, l.tabs[1]!]
  const sid2 = l.sids[1]!
  try {
    expect(await makeCoordinator(l.page, tab1)).toMatchObject({ ok: true })
    expect(await coord(l.pipeName, tab1, { op: 'attach', session: refOf(sid2) })).toMatchObject({ ok: true })
    // the task is queued while the person's own turn runs in the session: it waits for the turn to end
    await turnOf(l.pipeName, tab2, sid2)
    expect(await coord(l.pipeName, tab1, { op: 'message', session: refOf(sid2), text: 'Fix the parser.' })).toMatchObject({ ok: true })
    await l.page.evaluate((id) => window.ct.restartTab(id, true), tab2)
    // the restarted Claude Code says it starts, as its SessionStart hook does, and its new watcher takes the queued task
    await restarted(l.page, tab2, sid2)
    expect(await startSession(l.pipeName, tab2, sid2)).toEqual({ ok: true })
    const next = waitForMail(l.pipeName, tab2, sid2)
    expect((await within(next, 15_000)).info).toContain('> Fix the parser.')
  } finally {
    await l.app.close()
  }
})

test('an account switch in the middle of the task\'s turn keeps the task open: the report is the answer the session goes on to give', async () => {
  // the account the session's tab moves to
  const work = '0b6f3c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'
  const dataDir = makeDataDir(VERSION_SETTINGS)
  writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{ id: work, name: 'Work', addedAt: '2026-10-01T09:00:00.000Z', token: 'e2e-token-work-0000000001', encrypted: false }]
  }))
  const t = await openTask({ dataDir })
  try {
    await turnOf(t.pipeName, t.tab2, t.sid2)
    await t.page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id: t.tab2, account: work })
    // the tab restarts on the other account and resumes the conversation; the person tells it to go on, and its turn ends
    await restarted(t.page, t.tab2, t.sid2)
    expect(await sendPipeMessage(t.pipeName, { v: 1, type: 'session', tabId: t.tab2, sessionId: t.sid2, source: 'resume', transcriptPath: null })).toEqual({ ok: true })
    await turnOf(t.pipeName, t.tab2, t.sid2)
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'Parser fixed after the switch.' })
    // ClaudeTerm's restart cut the turn, not the person: the coordinator hears that the task finished, with the answer
    const report = await within(t.c, 15_000)
    expect(report.info).toContain('its task finished.')
    expect(report.info).toContain('> Parser fixed after the switch.')
    expect(report.info).not.toContain('stopped')
  } finally {
    await t.app.close()
  }
})

test('a report made while the coordinator\'s Claude Code restarts waits for the new one: the watcher of the old one is let go without it', async () => {
  const t = await openTask()
  try {
    await t.page.evaluate((id) => window.ct.restartTab(id, true), t.tab1)
    // the session ends its task while the coordinator's Claude Code restarts
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'Parser fixed during the restart.' })
    // the old process's watcher gets no mail: the wake of a Claude Code that is going is lost, and the report would read as delivered
    expect((await within(t.c, 15_000)).info).toBeUndefined()
    await restarted(t.page, t.tab1, t.sid1)
    expect(await startSession(t.pipeName, t.tab1, t.sid1)).toEqual({ ok: true })
    const report = waitForMail(t.pipeName, t.tab1, t.sid1)
    expect((await within(report, 15_000)).info).toContain('> Parser fixed during the restart.')
  } finally {
    await t.app.close()
  }
})

test('the report of a task the previous coordinator gave goes to the new one with a note', async () => {
  const t = await openTask({ count: 3 })
  try {
    // a third tab replaces the coordinator: the session moves to it, and so does the report of the task it gave
    const tab3 = t.tabs[2]!
    const sid3 = t.sids[2]!
    expect(await makeCoordinator(t.page, tab3, true)).toMatchObject({ ok: true })
    const got = waitForMail(t.pipeName, tab3, sid3)
    await done(t.pipeName, t.tab2, t.sid2, { lastMessage: 'Parser fixed.' })
    expect((await within(got, 15_000)).info).toContain('> (This task was given by the previous coordinator, ')
  } finally {
    await t.app.close()
  }
})

test('a task given in the Stop race of a turn a watcher woke waits for the next turn: the old turn\'s answer is no report of it', async () => {
  const { app, page, pipeName, tabs, sids } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await coord(pipeName, tabs[0]!, { op: 'attach', session: refOf(sids[1]!) })).toMatchObject({ ok: true })
    // a plain message wakes the session's watcher: a turn Claude Code starts with no UserPromptSubmit, so the tab does not read as working
    const w1 = waitForMail(pipeName, tabs[1]!, sids[1]!)
    expect(await sendText(pipeName, tabs[0]!, sids[1]!, 'a plain note')).toMatchObject({ ok: true })
    expect(await within(w1, 15_000)).toMatchObject({ ok: true, info: expect.stringContaining('a plain note') })

    // the task comes while that turn runs: its watcher comes in the turn, so it waits for the turn's end
    expect(await coord(pipeName, tabs[0]!, { op: 'message', session: refOf(sids[1]!), text: 'Fix the parser.' })).toMatchObject({ ok: true })
    const w2 = waitForMail(pipeName, tabs[1]!, sids[1]!)
    await stillWaiting(w2, 1000)

    const c = waitForMail(pipeName, tabs[0]!, sids[0]!)
    c.catch(() => {})
    // the wake turn ends with its answer: the task starts in the next turn, and that answer is no report of the task
    await done(pipeName, tabs[1]!, sids[1]!, { lastMessage: 'note answered' })
    expect(await within(w2, 15_000)).toMatchObject({ ok: true, info: expect.stringContaining('> Fix the parser.') })
    await stillWaiting(c, 3500)
  } finally {
    await app.close()
  }
})

test('chat view: with no watcher the task goes as a message, and the report as a message to the coordinator', async () => {
  const work = gitRepo()
  const l = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] }, fallback: [{ text: 'Parser fixed.' }] }, { work, env: { CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' } })
  const { page, pipeName } = l
  try {
    const a = l.tabId
    const b = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work))!.id
    for (const id of [a, b]) {
      await activate(page, id)
      await sendMessage(page, 'hello')
      await expect.poll(async () => (await chatState(page, id))?.turn ?? null, { timeout: 30_000 }).toBe('idle')
    }
    const sidB = (await chatState(page, b))!.sessionId!

    expect(await makeCoordinator(page, a)).toMatchObject({ ok: true })
    expect(await coord(pipeName, a, { op: 'attach', session: refOf(sidB) })).toMatchObject({ ok: true })
    expect(await coord(pipeName, a, { op: 'message', session: refOf(sidB), text: 'Fix the parser.' })).toMatchObject({ ok: true })
    await expect.poll(() => userMessages(l.log).some((m) => m.startsWith('Task from your coordinator, through ClaudeTerm:') && m.includes('> Fix the parser.'))).toBe(true)

    // the answer to the task ends its turn; the stand-in runs no hooks, so the turn's events are sent here
    await expect.poll(async () => {
      const s = await chatState(page, b)
      return s !== null && s.turn === 'idle' && JSON.stringify(s.items).includes('Parser fixed.')
    }, { timeout: 30_000 }).toBe(true)
    await turnOf(pipeName, b, sidB)
    await done(pipeName, b, sidB, { lastMessage: 'Parser fixed.' })
    await expect.poll(() => userMessages(l.log).some((m) => m.startsWith('Report from a session attached to you, through ClaudeTerm: its task finished.') && m.includes('> Parser fixed.')), { timeout: 15_000 }).toBe(true)
  } finally {
    await l.app.close()
  }
})

test('terminal view: with no watcher the task is typed into Claude Code\'s empty prompt', async () => {
  const p = await terminalPair()
  try {
    expect(await makeCoordinator(p.page, p.tab1)).toMatchObject({ ok: true })
    expect(await coord(p.pipeName, p.tab1, { op: 'attach', session: refOf(p.sid2) })).toMatchObject({ ok: true })
    expect(await coord(p.pipeName, p.tab1, { op: 'message', session: refOf(p.sid2), text: 'Fix the parser.' })).toMatchObject({ ok: true })
    await expect.poll(() => logHas(p.standIn.log, '> Fix the parser.'), { timeout: 15_000 }).toBe(true)
  } finally {
    await p.app.close()
  }
})

test('a clear keeps a queued task: it goes to the session under its new id', async () => {
  const { app, page, pipeName, tabs, sids } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await coord(pipeName, tabs[0]!, { op: 'attach', session: refOf(sids[1]!) })).toMatchObject({ ok: true })
    // the session works: the task is queued while its turn runs
    await turnOf(pipeName, tabs[1]!, sids[1]!)
    expect(await coord(pipeName, tabs[0]!, { op: 'message', session: refOf(sids[1]!), text: 'Fix the parser.' })).toMatchObject({ ok: true })

    const cleared = randomUUID()
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: tabs[1]!, sessionId: cleared, source: 'clear', transcriptPath: null })).toEqual({ ok: true })
    const got = waitForMail(pipeName, tabs[1]!, cleared)
    await done(pipeName, tabs[1]!, cleared)
    expect((await within(got, 15_000)).info).toContain('> Fix the parser.')
  } finally {
    await app.close()
  }
})

test('plain mail is never typed: a task is, a note is left unread', async () => {
  const p = await terminalPair()
  try {
    expect(await sendText(p.pipeName, p.tab1, p.sid2, 'plain note')).toMatchObject({ ok: true })
    // the turn's end pokes the tab's delivery: a note is still not typed
    await turnOf(p.pipeName, p.tab2, p.sid2)
    await done(p.pipeName, p.tab2, p.sid2)
    await pause(2000)
    expect(logHas(p.standIn.log, 'plain note')).toBe(false)
    await expect(envelopeOf(p.page, p.tab2)).toHaveAttribute('title', 'Unread agent messages')

    // a task of the coordinator is typed into the same empty prompt, and the note stays out of it
    expect(await makeCoordinator(p.page, p.tab1)).toMatchObject({ ok: true })
    expect(await coord(p.pipeName, p.tab1, { op: 'attach', session: refOf(p.sid2) })).toMatchObject({ ok: true })
    expect(await coord(p.pipeName, p.tab1, { op: 'message', session: refOf(p.sid2), text: 'Fix the parser.' })).toMatchObject({ ok: true })
    await expect.poll(() => logHas(p.standIn.log, '> Fix the parser.'), { timeout: 15_000 }).toBe(true)
    expect(logHas(p.standIn.log, 'plain note')).toBe(false)
  } finally {
    await p.app.close()
  }
})
