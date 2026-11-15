import { expect, test } from '@playwright/test'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { activate, refOf } from './agent-mail'
import { coord, coordDevices, coordViewOf } from './coordinator-helpers'
import { marksOf, openSessions, sessionGroup, sessionRow } from './coordinator-window'
import { closePaired, SLOW } from './device-pair'

test.afterEach(closePaired)

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
