import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { HUB_TEXT, worktreeInstruction } from '../../src/main/coordinator/coordinator-hub'
import { coordinatorProblem, type CoordMarks } from '../../src/shared/coordinator'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { PipeResponse } from '../../src/shared/protocol'
import { gitRepo, launchApp, type Launched } from './helpers'
import { coordApp, claudeTabIn, coord, done, makeCoordinator, stillWaiting, turnOf, within } from './coordinator-helpers'
import { refOf, setSetting, startSession, waitForMail } from './agent-mail'

const marksOf = (page: Page): Promise<CoordMarks> => page.evaluate(() => window.ct.coordMarks())
const viewOf = (page: Page, tabId: string) => page.evaluate((id) => window.ct.coordView(id), tabId)
const attachIn = (page: Page, tabId: string, sessionTabId: string) => page.evaluate(([a, b]) => window.ct.coordAttach(a, b), [tabId, sessionTabId] as const)

test('list_sessions in a tab that is not a coordinator says it is not one', async () => {
  const { app, pipeName, tabs } = await coordApp(1)
  try {
    expect(await coord(pipeName, tabs[0]!, { op: 'list' })).toEqual({ ok: false, error: HUB_TEXT.notCoordinator })
  } finally {
    await app.close()
  }
})

test('a tab made coordinator through the window lists the project\'s other sessions as not attached', async () => {
  const { app, page, pipeName, tabs, sids, repo } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toEqual({ ok: true, info: `This tab is now the coordinator of ${basename(repo)}.` })
    // the other tab's place arrives on its own schedule: the row shows once it has
    await expect.poll(async () => (await coord(pipeName, tabs[0]!, { op: 'list' })).info, { timeout: 15_000 }).toContain(`[${refOf(sids[1]!)}]`)
    const list = await coord(pipeName, tabs[0]!, { op: 'list' })
    expect(list.info).toContain('Not attached (this project):')
    expect(list.info).toContain('No sessions are attached.')
  } finally {
    await app.close()
  }
})

test('a second coordinator of the project is refused with the first one\'s name; replacing moves its sessions', async () => {
  const { app, page, pipeName, tabs, sids, repo } = await coordApp(3)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await attachIn(page, tabs[0]!, tabs[1]!)).toMatchObject({ ok: true })
    expect(await attachIn(page, tabs[0]!, tabs[2]!)).toMatchObject({ ok: true })

    const refused = await makeCoordinator(page, tabs[1]!)
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining(`The ${basename(repo)} project already has a coordinator:`) })
    const first = (refused as { replaces?: string }).replaces
    expect(first).toEqual(expect.any(String))

    // the replacing tab takes the other attached session with it; its own session leaves the first coordinator
    expect(await makeCoordinator(page, tabs[1]!, true)).toEqual({ ok: true, info: `This tab is now the coordinator of ${basename(repo)}; 1 session moved from ${first}.` })
    const marks = await marksOf(page)
    expect(marks[tabs[1]!]).toMatchObject({ role: 'coordinator' })
    expect(marks[tabs[2]!]).toMatchObject({ role: 'attached', coordinatorTabId: tabs[1]! })
    expect(await coord(pipeName, tabs[1]!, { op: 'list' })).toMatchObject({ ok: true, info: expect.stringContaining(`[${refOf(sids[2]!)}]`) })
  } finally {
    await app.close()
  }
})

test('attach_session and detach_session change the marks; attaching sends the session nothing', async () => {
  const { app, page, pipeName, tabs, sids, repo } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    // the watcher of the session to attach is held: an attach must not hand it anything
    const held = waitForMail(pipeName, tabs[1]!, sids[1]!)
    expect(await coord(pipeName, tabs[0]!, { op: 'attach', session: refOf(sids[1]!) })).toMatchObject({ ok: true })

    const marks = await marksOf(page)
    expect(marks[tabs[1]!]).toEqual({ role: 'attached', project: basename(repo), coordinator: expect.any(String), coordinatorTabId: tabs[0]! })
    expect(marks[tabs[0]!]).toMatchObject({ role: 'coordinator' })
    await stillWaiting(held, 1500)

    expect(await coord(pipeName, tabs[0]!, { op: 'detach', session: refOf(sids[1]!) })).toMatchObject({ ok: true })
    expect((await marksOf(page))[tabs[1]!]).toBeUndefined()
  } finally {
    await app.close()
  }
})

test('a session attached to another project\'s coordinator is refused with its coordinator\'s name', async () => {
  const l = await coordApp(2)
  const { app, page, pipeName, tabs, sids } = l
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    // a coordinator of another project, in a tab of its own
    const otherRepo = gitRepo()
    const other = await claudeTabIn(l, otherRepo)
    expect(await makeCoordinator(page, other.tabId)).toMatchObject({ ok: true })
    expect(await coord(pipeName, other.tabId, { op: 'attach', session: refOf(sids[1]!) })).toMatchObject({ ok: true })

    const refusal = await coord(pipeName, tabs[0]!, { op: 'attach', session: refOf(sids[1]!) })
    expect(refusal).toMatchObject({ ok: false, error: expect.stringContaining(basename(otherRepo)) })
  } finally {
    await app.close()
  }
})

test('with agent messages off, attaching is refused with the requirement message, which the view shows too', async () => {
  const { app, page, pipeName, tabs, sids } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await setSetting(page, 'agentMessages.enabled', false)).toEqual({ ok: true })
    const text = coordinatorProblem(false, true, '2.1.400')
    expect(await coord(pipeName, tabs[0]!, { op: 'attach', session: refOf(sids[1]!) })).toEqual({ ok: false, error: text })
    expect((await viewOf(page, tabs[0]!))?.problem).toBe(text)
  } finally {
    await app.close()
  }
})

test('a task waits while its session works, also past the Stop race, and then reaches it as the user\'s instruction', async () => {
  const { app, page, pipeName, tabs, sids } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await coord(pipeName, tabs[0]!, { op: 'attach', session: refOf(sids[1]!) })).toMatchObject({ ok: true })

    // the watcher of the last Stop, held while the next turn runs
    const w1 = waitForMail(pipeName, tabs[1]!, sids[1]!)
    await turnOf(pipeName, tabs[1]!, sids[1]!)
    expect(await coord(pipeName, tabs[0]!, { op: 'message', session: refOf(sids[1]!), text: 'Fix the parser.' })).toMatchObject({ ok: true })
    // not into the running turn
    await stillWaiting(w1, 1500)
    // the Stop's own watcher, before its done reaches main
    const w2 = waitForMail(pipeName, tabs[1]!, sids[1]!)
    // replaced, without mail
    expect(await within(w1, 5000)).toEqual({ ok: true })
    // not into the turn that ends now
    await stillWaiting(w2, 1000)

    await done(pipeName, tabs[1]!, sids[1]!)
    const got = await within(w2, 10_000)
    expect(got.info).toMatch(/^Task from your coordinator, through ClaudeTerm: the user's instruction, given through their .+ coordinator\./)
    expect(got.info).toContain('> Fix the parser.')
  } finally {
    await app.close()
  }
})

test('a coordinator tab\'s turn over the pipe answers with ClaudeTerm\'s instruction, and after Stop coordinating it does not', async () => {
  const { app, page, pipeName, tabs, sids, repo } = await coordApp(2)
  const turn = (tabId: string, sessionId: string): Promise<PipeResponse> => sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId }) as Promise<PipeResponse>
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await turn(tabs[0]!, sids[0]!)).toEqual({ ok: true, info: expect.stringContaining(`you are the coordinator of ${basename(repo)}: give the work to its sessions`) })
    expect(await turn(tabs[1]!, sids[1]!)).toEqual({ ok: true })

    expect(await page.evaluate((id) => window.ct.coordStop(id), tabs[0]!)).toMatchObject({ ok: true })
    expect(await turn(tabs[0]!, sids[0]!)).toEqual({ ok: true })
  } finally {
    await app.close()
  }
})

test('closing the coordinator\'s tab stops it: its session is no longer attached', async () => {
  const { app, page, pipeName, tabs, sids } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await coord(pipeName, tabs[0]!, { op: 'attach', session: refOf(sids[1]!) })).toMatchObject({ ok: true })
    expect((await marksOf(page))[tabs[1]!]).toMatchObject({ role: 'attached' })

    await page.evaluate((id) => window.ct.closeTab(id), tabs[0]!)
    await expect.poll(async () => (await marksOf(page))[tabs[1]!]).toBeUndefined()
  } finally {
    await app.close()
  }
})

test('the window\'s Message, Resolve and Detach act on a row of the view', async () => {
  const { app, page, tabs } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await attachIn(page, tabs[0]!, tabs[1]!)).toMatchObject({ ok: true })
    const key = (await viewOf(page, tabs[0]!))!.sessions[0]!.key

    expect(await page.evaluate(([a, k]) => window.ct.coordResolve(a, k), [tabs[0]!, key] as const)).toMatchObject({ ok: true })
    await expect.poll(async () => (await viewOf(page, tabs[0]!))!.sessions[0]!.group).toBe('resolved')

    expect(await page.evaluate(([a, k, t]) => window.ct.coordMessage(a, k, t), [tabs[0]!, key, 'Write the notes.'] as const)).toMatchObject({ ok: true })
    const after = (await viewOf(page, tabs[0]!))!.sessions[0]!
    expect(after.group).toBe('working')
    expect(after.task?.state).toBe('queued')

    expect(await page.evaluate(([a, k]) => window.ct.coordDetach(a, k), [tabs[0]!, key] as const)).toMatchObject({ ok: true })
    expect((await viewOf(page, tabs[0]!))!.sessions).toEqual([])
  } finally {
    await app.close()
  }
})

test('the role and the attachments survive a quit and a restore', async () => {
  const first = await coordApp(2)
  let second: Launched | null = null
  try {
    expect(await makeCoordinator(first.page, first.tabs[0]!)).toMatchObject({ ok: true })
    expect(await coord(first.pipeName, first.tabs[0]!, { op: 'attach', session: refOf(first.sids[1]!) })).toMatchObject({ ok: true })

    // the window closes and keeps its tabs in the session snapshot of the data folder, then a second window restores them
    const closed = first.app.waitForEvent('close')
    await first.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
    await closed

    second = await launchApp({ dataDir: first.dataDir })
    await expect.poll(() => second!.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
    await second.page.locator('.banner-restore').click()
    await expect.poll(async () => Object.values(await marksOf(second!.page)).map((m) => m.role).sort()).toEqual(['attached', 'coordinator'])

    const marks = await marksOf(second.page)
    const coordinatorTab = Object.keys(marks).find((id) => marks[id]!.role === 'coordinator')!
    expect(await coord(second.pipeName, coordinatorTab, { op: 'list' })).toMatchObject({ ok: true, info: expect.stringContaining(`[${refOf(first.sids[1]!)}]`) })
  } finally {
    await second?.app.close()
    await first.app.close().catch(() => {})
  }
})

test('a clear in the coordinator\'s tab keeps its role under the new session id', async () => {
  const { app, page, pipeName, tabs, sids } = await coordApp(2)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    expect(await coord(pipeName, tabs[0]!, { op: 'attach', session: refOf(sids[1]!) })).toMatchObject({ ok: true })

    const cleared = randomUUID()
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: tabs[0]!, sessionId: cleared, source: 'clear', transcriptPath: null })).toEqual({ ok: true })
    expect(await coord(pipeName, tabs[0]!, { op: 'list' })).toMatchObject({ ok: true, info: expect.stringContaining(`[${refOf(sids[1]!)}]`) })
    expect((await marksOf(page))[tabs[0]!]).toMatchObject({ role: 'coordinator' })
  } finally {
    await app.close()
  }
})

test('start_session opens an attached tab, and its first task carries the worktree instruction', async () => {
  const { app, page, pipeName, tabs } = await coordApp(1)
  try {
    expect(await makeCoordinator(page, tabs[0]!)).toMatchObject({ ok: true })
    const answer = coord(pipeName, tabs[0]!, { op: 'start', task: 'Write the release notes.', name: 'Release notes', folder: null, device: null, worktree: 'notes' })

    await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
    const newTab = (await page.evaluate(() => window.__ct!.tabIds())).find((id) => id !== tabs[0])!
    await expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle(id), newTab)).toBe('Release notes')

    const sid = randomUUID()
    expect(await startSession(pipeName, newTab, sid)).toEqual({ ok: true })
    const started = await answer
    expect(started).toMatchObject({ ok: true, info: expect.stringMatching(/^Started Release notes · /) })
    expect((started as { info: string }).info).toContain(`[${refOf(sid)}]`)

    const got = await waitForMail(pipeName, newTab, sid)
    expect(got.info).toContain(worktreeInstruction('notes').trim())
    expect(got.info).toContain('> Write the release notes.')
  } finally {
    await app.close()
  }
})
