import { expect as baseExpect, test } from '@playwright/test'
import { basename } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { TaskList } from '../../src/shared/task-list'
import { activate, refOf, setSetting } from './agent-mail'
import { coord, coordApp, done, makeCoordinator, turnOf } from './coordinator-helpers'
import { openSessions, rowKey, sessionGroup, sessionRow, sessionsToggle } from './coordinator-window'

const expect = baseExpect.configure({ timeout: 15_000 })

const LIST: TaskList = { title: 'Triage', tasks: [{ title: 'Collect crashes', status: 'completed' }, { title: 'Grouping crashes by call stack', status: 'in_progress' }, { title: 'Write the report', status: 'pending' }] }

test('the Sessions panel groups the attached sessions by state and lists the project\'s others as not attached', async () => {
  const l = await coordApp(4)
  const { page, pipeName, tabs: [t0, t1, t2], sids, repo } = l
  try {
    await makeCoordinator(page, t0)
    for (const s of [sids[1], sids[2]]) expect(await coord(pipeName, t0, { op: 'attach', session: refOf(s) })).toMatchObject({ ok: true })
    await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: t1, sessionId: sids[1], reason: 'permission', prompt: 'Allow Bash: npm test' })
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'task_list', tabId: t2, list: LIST })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const waiting = sessionGroup(page, 'waiting')
    await expect(waiting.locator('.coord-gh .n')).toHaveText('1')
    await expect(waiting.locator(`.coord-row[data-key="${rowKey(sids[1])}"] .coord-l3.warn`)).toHaveText('Allow Bash: npm test')
    await expect(waiting.locator('.coord-dot.amber')).toHaveCount(1)
    // a row carries its session's tab, and a row that just changed says so
    await expect(sessionRow(page, rowKey(sids[1]))).toHaveAttribute('data-tab-id', t1)
    await expect(waiting.locator(`.coord-row[data-key="${rowKey(sids[1])}"] .coord-time`)).toHaveText('now')
    await expect(sessionRow(page, rowKey(sids[2])).locator('.coord-l3')).toHaveText('1/3 · Grouping crashes by call stack')
    await expect(sessionRow(page, rowKey(sids[2])).locator('.coord-prog')).toHaveCount(1)
    await expect(sessionGroup(page, 'not-attached').locator(`.coord-row[data-key="${rowKey(sids[3])}"] .coord-l2`)).toContainText(basename(repo))
  } finally { await l.app.close() }
})

test('Resolved is folded and opens on a click', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const key = rowKey(sids[1])
    expect(await page.evaluate(([t, k]) => window.ct.coordResolve(t, k), [t0, key] as const)).toMatchObject({ ok: true })
    const resolved = sessionGroup(page, 'resolved')
    await expect(resolved).toHaveClass(/folded/)
    await expect(resolved.locator('.coord-gh .n')).toHaveText('1')
    await expect(resolved.locator('.coord-row')).toHaveCount(0)
    await resolved.locator('.coord-gh').click()
    await expect(resolved).not.toHaveClass(/folded/)
    await expect(sessionRow(page, key)).toBeVisible()
  } finally { await l.app.close() }
})

test('with agent messages off the panel says what is missing, and its link opens Settings at Agent messages', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await setSetting(page, 'agentMessages.enabled', false)
    await expect(page.locator('#image-panel .coord-problem')).toContainText('Coordinating sessions needs agent messages')
    const [win] = await Promise.all([l.app.waitForEvent('window'), page.locator('#image-panel .coord-problem .coord-link').click()])
    await expect(win.locator('#agent-messages')).toBeVisible()
  } finally { await l.app.close() }
})

test('a session name with markup in it shows as text', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    const name = '<img src=x onerror="window.__hit=1">'
    await page.evaluate(([id, n]) => window.ct.renameTab(id, n), [t1, name] as const)
    // main has the name before the attach builds the view
    await expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle!(id), t1)).toBe(name)
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await expect(sessionRow(page, rowKey(sids[1])).locator('.coord-name')).toHaveText(name)
    await expect(page.locator('#image-panel img')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __hit?: number }).__hit)).toBeUndefined()
  } finally { await l.app.close() }
})

test('stopping the coordinator takes the Sessions panel away', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    expect(await page.evaluate((id) => window.ct.coordStop(id), t0)).toMatchObject({ ok: true })
    await expect(sessionsToggle(page)).toBeHidden()
    await expect(page.locator('#image-panel .panel-sessions')).toBeHidden()
  } finally { await l.app.close() }
})

test('an empty coordinator says how to get sessions', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const empty = page.locator('#image-panel .panel-sessions .coord-list .panel-empty')
    await expect(empty).toHaveText('No sessions yet. Start one with New session, attach one with Attach…, or drop a tab here.')
    await expect(empty).toBeVisible()
    // the text sits at the top of the panel, not under its middle
    const body = await page.locator('#image-panel .panel-sessions').boundingBox()
    const box = await empty.boundingBox()
    expect(body).not.toBeNull()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(body!.y)
    expect(box!.y).toBeLessThan(body!.y + body!.height / 2)
  } finally { await l.app.close() }
})

test('a usage limit shows in red on its row', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await turnOf(pipeName, t1, sids[1])
    await done(pipeName, t1, sids[1], { error: 'rate_limit' })
    await activate(page, t0)
    await openSessions(page)
    const line = sessionRow(page, rowKey(sids[1])).locator('.coord-l3.err')
    await expect(line).toBeVisible()
    await expect(line).toContainText('Usage limit')
  } finally { await l.app.close() }
})

test('a folded section stays folded when the view changes', async () => {
  const l = await coordApp(3)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    for (const s of [sids[1], sids[2]]) expect(await coord(pipeName, t0, { op: 'attach', session: refOf(s) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await expect(sessionGroup(page, 'idle').locator('.coord-row')).toHaveCount(2)
    await sessionGroup(page, 'idle').locator('.coord-gh').click()
    await expect(sessionGroup(page, 'idle')).toHaveClass(/folded/)
    // a turn moves one row out of Idle: the view changes and the panel draws again
    await turnOf(pipeName, t1, sids[1])
    await expect(sessionGroup(page, 'working').locator(`.coord-row[data-key="${rowKey(sids[1])}"]`)).toBeVisible()
    await expect(sessionGroup(page, 'idle')).toHaveClass(/folded/)
    await expect(sessionGroup(page, 'idle').locator('.coord-row')).toHaveCount(0)
  } finally { await l.app.close() }
})
