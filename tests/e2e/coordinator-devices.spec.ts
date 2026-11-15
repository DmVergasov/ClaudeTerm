import { expect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_TEXT } from '../../src/main/coordinator/coordinator-hub'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { activate, refOf, startSession, waitForMail } from './agent-mail'
import { claudeTabIn, coord, coordDevices, coordViewOf, done, makeCoordinator, within } from './coordinator-helpers'
import { dragOnto, LEFT, marksOf, menuItem, openSessions, sessionGroup, sessionRow, tpRow } from './coordinator-window'
import { closePaired, type Device, relaunch, SLOW } from './device-pair'

test.afterEach(closePaired)

/** the left panel's rows in DOM order: the id, whether the row is attached, its device chip, and the device section it stands in (null: this device's own groups) */
const panelRowsOf = (page: Page): Promise<{ id: string; attached: boolean; chip: string | null; section: string | null }[]> =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#tabpanel .tp-tab')].map((row) => ({
    id: row.dataset.tabId!,
    attached: row.classList.contains('coord-attached'),
    chip: row.querySelector('.tp-coord-device')?.textContent ?? null,
    section: row.closest('.tp-section')?.querySelector('.tp-device-name')?.textContent ?? null
  })))

/** Laptop's section of Studio's left panel */
const laptopSection = (page: Page): Locator => page.locator('#tabpanel .tp-section', { has: page.locator('.tp-device-name', { hasText: 'Laptop' }) })

/** Laptop's session attached to Studio's coordinator: the answer is attached once Laptop confirms, or Attaching… when the wait ends first; both windows mark it once it has */
async function attachLaptopSession(a: Device, b: Device, coordTab: string, sessionTab: string, sessionSid: string): Promise<void> {
  expect([{ ok: true, info: HUB_TEXT.attached('acme · Laptop', refOf(sessionSid)) }, { ok: true, info: HUB_TEXT.attaching('acme · Laptop', refOf(sessionSid), 'Laptop') }])
    .toContainEqual(await coord(a.pipeName, coordTab, { op: 'attach', session: refOf(sessionSid) }))
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: null })
  await expect.poll(async () => (await marksOf(a.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: coordTab })
  await expect.poll(async () => (await coordViewOf(a, coordTab))?.sessions[0]?.marker, SLOW).toBeNull()
}

test('Studio\'s coordinator lists Laptop\'s session of the project as not attached, with Laptop as its device', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  expect((await coordViewOf(a, coordTab))!.notAttached).toContainEqual(expect.objectContaining({
    tabId: sessionTab, device: b.id, deviceName: 'Laptop', name: 'acme · Laptop', ref: refOf(sessionSid)
  }))
  const list = await coord(a.pipeName, coordTab, { op: 'list' })
  expect(list.info).toContain('Not attached (this project):')
  expect(list.info).toContain(`- acme · Laptop [${refOf(sessionSid)}] · Idle`)

  // the Sessions panel shows the row in its Not attached group, with Laptop's name on it
  await activate(a.page, coordTab)
  await openSessions(a.page)
  const key = `${b.id}:${sessionSid}`
  await expect(sessionGroup(a.page, 'not-attached').locator(`.coord-row[data-key="${key}"]`)).toBeVisible()
  await expect(sessionRow(a.page, key).locator('.coord-dev')).toHaveText('Laptop')
})

test('Laptop\'s task list and a pending permission show in Studio\'s row of the session', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  const row = async () => (await coordViewOf(a, coordTab))!.notAttached.find((r) => r.tabId === sessionTab)

  expect(await sendPipeMessage(b.pipeName, {
    v: 1, type: 'task_list', tabId: sessionTab,
    list: { title: 'Triage', tasks: [{ title: 'Read the logs', status: 'completed' }, { title: 'Group the crashes', status: 'in_progress' }, { title: 'Write the report', status: 'pending' }] }
  })).toMatchObject({ ok: true })
  await expect.poll(row, SLOW).toMatchObject({ line: '1/3 · Group the crashes', progress: { done: 1, total: 3 } })

  // the prompt changes no mark: the marks are read once the task list shows, and they must still be the same after the prompt
  const marks = await marksOf(a.page)
  await sendPipeMessage(b.pipeName, { v: 1, type: 'attention', tabId: sessionTab, sessionId: sessionSid, reason: 'permission', prompt: 'Allow Bash: npm test' })
  await expect.poll(row, SLOW).toMatchObject({ group: 'waiting', why: 'prompt', line: 'Allow Bash: npm test' })
  expect(await marksOf(a.page)).toEqual(marks)
})

test('@alone attaching Laptop\'s session: the answer is attached once Laptop confirms, and both windows mark it', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  expect(await coord(a.pipeName, coordTab, { op: 'attach', session: refOf(sessionSid) })).toEqual({ ok: true, info: HUB_TEXT.attached('acme · Laptop', refOf(sessionSid)) })
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: null })
  await expect.poll(async () => (await marksOf(a.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: coordTab })
})

test('a task given to Laptop\'s session reaches it as the user\'s instruction, and its report wakes Studio\'s coordinator', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, coordSid, sessionTab, sessionSid } = await coordDevices()
  await attachLaptopSession(a, b, coordTab, sessionTab, sessionSid)

  const task = waitForMail(b.pipeName, sessionTab, sessionSid)
  expect(await coord(a.pipeName, coordTab, { op: 'message', session: refOf(sessionSid), text: 'Fix the parser.' })).toMatchObject({ ok: true })
  const taken = await within(task, 30_000)
  expect(taken.info).toMatch(/^Task from your coordinator, through ClaudeTerm: the user's instruction, given through their acme coordinator\./)
  expect(taken.info).toContain('> Fix the parser.')

  const report = waitForMail(a.pipeName, coordTab, coordSid)
  await done(b.pipeName, sessionTab, sessionSid, { lastMessage: 'Parser fixed.' })
  const answer = await within(report, 30_000)
  expect(answer.info).toContain('Report from a session attached to you, through ClaudeTerm: its task finished.')
  expect(answer.info).toContain('> Parser fixed.')
})

test('a task of Studio\'s coordinator to Laptop\'s session shows its state change in Studio\'s row once Laptop takes it', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  await attachLaptopSession(a, b, coordTab, sessionTab, sessionSid)
  expect(await coord(a.pipeName, coordTab, { op: 'message', session: refOf(sessionSid), text: 'Fix the parser.' })).toMatchObject({ ok: true })
  await expect.poll(async () => (await coordViewOf(a, coordTab))?.sessions[0]?.task?.state ?? null, SLOW).toBe('queued')

  // Laptop's watcher takes the task: its state changes on Laptop, and Studio's row must show the change
  const taken = await within(waitForMail(b.pipeName, sessionTab, sessionSid), 30_000)
  expect(taken.info).toContain('> Fix the parser.')
  await expect.poll(async () => (await coordViewOf(a, coordTab))?.sessions[0]?.task?.state ?? null, SLOW).toMatch(/^(delivered|open)$/)
})

test('@alone a session attached to Laptop\'s own coordinator is refused with that coordinator\'s name', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionSid, repoB } = await coordDevices()
  const second = await claudeTabIn(b, repoB)
  expect(await makeCoordinator(b.page, second.tabId)).toMatchObject({ ok: true })
  expect(await coord(b.pipeName, second.tabId, { op: 'attach', session: refOf(sessionSid) })).toMatchObject({ ok: true })
  expect(await coord(a.pipeName, coordTab, { op: 'attach', session: refOf(sessionSid) })).toEqual({
    ok: false, error: 'acme · Laptop is attached to the acme coordinator (acme · Laptop #2); it must be detached there first.'
  })
})

test('a session on a device without coordinator support cannot be attached', async () => {
  test.setTimeout(180_000)
  const { a, coordTab, sessionSid } = await coordDevices({ b: { env: { CLAUDETERM_TEST_NO_COORD: '1' } } })
  expect(await coord(a.pipeName, coordTab, { op: 'attach', session: refOf(sessionSid) })).toEqual({ ok: false, error: HUB_TEXT.oldDevice('Laptop') })
})

test('Laptop offline: its row is Offline, a task waits, and it reaches the session after Laptop starts again', async () => {
  test.setTimeout(240_000)
  const { a, b, coordTab, sessionTab, sessionSid, repoB } = await coordDevices()
  await attachLaptopSession(a, b, coordTab, sessionTab, sessionSid)
  await b.app.close()

  await expect.poll(async () => (await coordViewOf(a, coordTab))?.sessions[0], SLOW).toMatchObject({ marker: 'offline', line: 'Offline' })
  const key = (await coordViewOf(a, coordTab))!.sessions[0]!.key
  await activate(a.page, coordTab)
  await openSessions(a.page)
  await expect(sessionRow(a.page, key)).toHaveClass(/marker-offline/)
  expect(await coord(a.pipeName, coordTab, { op: 'message', session: refOf(sessionSid), text: 'Fix the parser.' }))
    .toEqual({ ok: true, info: HUB_TEXT.queuedOffline('acme · Laptop', refOf(sessionSid), 'Laptop') })

  await relaunch(b)
  const tab = (await b.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), repoB))!.id
  expect(await startSession(b.pipeName, tab, sessionSid)).toEqual({ ok: true })
  expect((await within(waitForMail(b.pipeName, tab, sessionSid), 30_000)).info).toContain('> Fix the parser.')
})

test('the window attaches Laptop\'s tab by its id; Detach on Studio and Leave on Laptop each end the attachment on both', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  expect(await a.page.evaluate(([c, s]) => window.ct.coordAttach(c, s), [coordTab, sessionTab] as const))
    .toEqual({ ok: true, info: HUB_TEXT.attaching('acme · Laptop', refOf(sessionSid), 'Laptop') })
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toBeDefined()

  expect(await coord(a.pipeName, coordTab, { op: 'detach', session: refOf(sessionSid) })).toEqual({ ok: true, info: HUB_TEXT.detached('acme · Laptop', false) })
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toBeUndefined()

  expect(await coord(a.pipeName, coordTab, { op: 'attach', session: refOf(sessionSid) })).toMatchObject({ ok: true })
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toBeDefined()
  expect(await b.page.evaluate((t) => window.ct.coordLeave(t), sessionTab)).toEqual({ ok: true, info: 'Detached from the acme coordinator.' })
  await expect.poll(async () => (await coordViewOf(a, coordTab))?.sessions, SLOW).toEqual([])
})

test('Detach in the header of Laptop\'s attached session ends the attachment on both windows', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  await attachLaptopSession(a, b, coordTab, sessionTab, sessionSid)
  await activate(b.page, sessionTab)
  await expect(b.page.locator('#sheet-header .sh-reports')).toHaveText('↳ Reports to acme coordinator')
  await b.page.locator('#sheet-header .sh-detach').click()
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toBeUndefined()
  await expect.poll(async () => (await coordViewOf(a, coordTab))?.sessions, SLOW).toEqual([])
})

test('a Laptop row dragged onto Studio\'s coordinator row attaches it, and both windows mark it', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab } = await coordDevices({ a: { settings: LEFT } })
  // the rows are rebuilt on every render, so a drag that lands on a row being rebuilt does nothing: the drop is tried again (a drop on
  // a row already attached to this coordinator does nothing either)
  await expect(async () => {
    await dragOnto(a.page, tpRow(a.page, sessionTab), tpRow(a.page, coordTab))
    expect((await marksOf(a.page))[sessionTab]).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: coordTab })
  }).toPass({ timeout: 45_000 })
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: null })
})

test('a Laptop session attached to Studio\'s coordinator shows in its block with Laptop\'s chip, and goes back to the Laptop section when detached from its menu', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices({ a: { settings: LEFT } })
  await attachLaptopSession(a, b, coordTab, sessionTab, sessionSid)

  // in Studio's block: the row follows the coordinator's row, with Laptop's chip and no ↳ mark, and Laptop's section has no row of it
  await expect.poll(async () => {
    const rows = await panelRowsOf(a.page)
    return rows.findIndex((r) => r.id === sessionTab) === rows.findIndex((r) => r.id === coordTab) + 1
  }, SLOW).toBe(true)
  await expect(tpRow(a.page, sessionTab)).toHaveClass(/coord-attached/)
  await expect(tpRow(a.page, sessionTab).locator('.tp-coord-device')).toHaveText('Laptop')
  await expect(tpRow(a.page, sessionTab).locator('.tp-coord-to')).toHaveCount(0)
  expect((await panelRowsOf(a.page)).find((r) => r.id === sessionTab)).toEqual({ id: sessionTab, attached: true, chip: 'Laptop', section: null })
  await expect(laptopSection(a.page).locator(`.tp-tab[data-tab-id="${sessionTab}"]`)).toHaveCount(0)

  await menuItem(a.page, sessionTab, 'Detach from the acme coordinator')
  await expect.poll(async () => (await panelRowsOf(a.page)).find((r) => r.id === sessionTab), SLOW)
    .toEqual({ id: sessionTab, attached: false, chip: null, section: 'Laptop' })
  await expect(laptopSection(a.page).locator(`.tp-tab[data-tab-id="${sessionTab}"]`)).toHaveCount(1)
})

test('a Laptop tab is attached from its menu, and its row joins the coordinator\'s block', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab } = await coordDevices({ a: { settings: LEFT } })
  await menuItem(a.page, sessionTab, 'Attach to the acme coordinator')

  // the coordinator's view lists the row attached once Laptop confirms; both windows mark it
  await expect.poll(async () => (await coordViewOf(a, coordTab))?.sessions.find((r) => r.tabId === sessionTab)?.marker, SLOW).toBeNull()
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: null })
  await expect(tpRow(a.page, sessionTab)).toHaveClass(/coord-attached/)
  await expect(tpRow(a.page, sessionTab).locator('.tp-coord-device')).toHaveText('Laptop')
})

test('a clear in Laptop\'s session keeps it attached: Studio lists the new id, and its next task reaches it', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, sessionTab, sessionSid } = await coordDevices()
  await attachLaptopSession(a, b, coordTab, sessionTab, sessionSid)

  const newSid = randomUUID()
  expect(await sendPipeMessage(b.pipeName, { v: 1, type: 'session', tabId: sessionTab, sessionId: newSid, source: 'clear', transcriptPath: null })).toMatchObject({ ok: true })
  await expect.poll(async () => (await coord(a.pipeName, coordTab, { op: 'list' })).info, SLOW).toContain(`- acme · Laptop [${refOf(newSid)}]`)
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: null })
  await expect.poll(async () => (await marksOf(a.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: coordTab })

  const w = waitForMail(b.pipeName, sessionTab, newSid)
  expect(await coord(a.pipeName, coordTab, { op: 'message', session: refOf(newSid), text: 'Fix the parser.' })).toMatchObject({ ok: true })
  expect((await within(w, 30_000)).info).toContain('> Fix the parser.')
})

/** the tab a start opened on Laptop, titled as the start asked: polled until Laptop lists it */
async function startedTabOf(page: Page, title: string): Promise<string> {
  const tabOf = (): Promise<string | null> => page.evaluate((t) => window.__ct!.tabIds().find((id) => window.__ct!.tabTitle!(id) === t) ?? null, title)
  await expect.poll(tabOf, SLOW).not.toBeNull()
  return (await tabOf())!
}

test('start_session on Laptop opens a tab there in the folder of its acme tab, and sends the task once its session starts', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab, repoB } = await coordDevices()
  const answer = coord(a.pipeName, coordTab, { op: 'start', task: 'Write the release notes.', name: 'Release notes', folder: null, device: 'Laptop', worktree: null })
  const newTab = await startedTabOf(b.page, 'Release notes')
  const sid = randomUUID()
  expect(await startSession(b.pipeName, newTab, sid)).toEqual({ ok: true })
  expect(await answer).toEqual({
    ok: true,
    info: `Started Release notes · Laptop [${refOf(sid)}] on Laptop in ${repoB}, the folder of its acme tab, on Main account; it is attached to you once Laptop confirms. Its task is its first message; its report comes to you by itself when its task ends.`
  })
  expect((await within(waitForMail(b.pipeName, newTab, sid), 30_000)).info).toContain('> Write the release notes.')
})

test('a folder Laptop does not have: the session opens in Laptop\'s default folder and the answer says so', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab } = await coordDevices()
  const missing = join(tmpdir(), 'ct-no-such-folder')
  const answer = coord(a.pipeName, coordTab, { op: 'start', task: 'Write the release notes.', name: 'Release notes', folder: missing, device: 'Laptop', worktree: null })
  const newTab = await startedTabOf(b.page, 'Release notes')
  const sid = randomUUID()
  expect(await startSession(b.pipeName, newTab, sid)).toEqual({ ok: true })
  expect((await answer).info).toContain(`in ${b.work}, its default folder (${missing} is not a folder there)`)
})

test('New session on Laptop: Studio\'s dialog offers Laptop, the row shows Laptop\'s new tab until its session starts, and the task reaches the session', async () => {
  test.setTimeout(180_000)
  const { a, b, coordTab } = await coordDevices()
  await activate(a.page, coordTab)
  await openSessions(a.page)
  await a.page.locator('#image-panel .coord-bar button', { hasText: 'New session' }).click()
  const dialog = a.page.locator('.coord-dialog[data-dialog="new-session"]')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('select[name="device"] option')).toHaveText(['This device', 'Laptop'])
  await dialog.locator('textarea[name="task"]').fill('Write the release notes.')
  await dialog.locator('input[name="name"]').fill('Release notes')
  // the folder's placeholder is this device's folder until Laptop is chosen, then what an empty folder means on Laptop
  await expect(dialog.locator('input[name="folder"]')).not.toHaveAttribute('placeholder', 'Empty: the folder of a acme tab on Laptop, else its default folder')
  await dialog.locator('select[name="device"]').selectOption({ label: 'Laptop' })
  await expect(dialog.locator('input[name="folder"]')).toHaveAttribute('placeholder', 'Empty: the folder of a acme tab on Laptop, else its default folder')
  await dialog.getByRole('button', { name: 'Start', exact: true }).click()

  // Laptop opens the tab; Studio's view lists it on Laptop as Starting… until the session comes
  const newTab = await startedTabOf(b.page, 'Release notes')
  const laptopRow = async () => (await coordViewOf(a, coordTab))?.sessions.find((r) => r.deviceName === 'Laptop') ?? null
  await expect.poll(async () => (await laptopRow())?.key ?? null, SLOW).toBe(`start:${newTab}`)

  const sid = randomUUID()
  expect(await startSession(b.pipeName, newTab, sid)).toEqual({ ok: true })
  await expect.poll(async () => (await laptopRow())?.key ?? null, SLOW).toBe(`${b.id}:${sid}`)
  // attached: the row has no marker (a missing row reads 'missing', which is not null)
  await expect.poll(async () => { const r = await laptopRow(); return r === null ? 'missing' : r.marker }, SLOW).toBeNull()
  await expect(dialog).toHaveCount(0, { timeout: 45_000 })
  expect((await within(waitForMail(b.pipeName, newTab, sid), 30_000)).info).toContain('> Write the release notes.')
})
