import { expect, test } from '@playwright/test'
import { HUB_TEXT } from '../../src/main/coordinator/coordinator-hub'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { activate, refOf, startSession, waitForMail } from './agent-mail'
import { claudeTabIn, coord, coordDevices, coordViewOf, done, makeCoordinator, within } from './coordinator-helpers'
import { dragOnto, LEFT, marksOf, openSessions, sessionGroup, sessionRow, tpRow } from './coordinator-window'
import { closePaired, type Device, relaunch, SLOW } from './device-pair'

test.afterEach(closePaired)

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

test('a session attached to Laptop\'s own coordinator is refused with that coordinator\'s name', async () => {
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
  await dragOnto(a.page, tpRow(a.page, sessionTab), tpRow(a.page, coordTab))
  await expect.poll(async () => (await marksOf(a.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: coordTab })
  await expect.poll(async () => (await marksOf(b.page))[sessionTab], SLOW).toEqual({ role: 'attached', project: 'acme', coordinator: 'acme · Studio', coordinatorTabId: null })
})
