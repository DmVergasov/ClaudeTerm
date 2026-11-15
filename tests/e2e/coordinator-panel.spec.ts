import { expect as baseExpect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { HUB_TEXT } from '../../src/main/coordinator/coordinator-hub'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { TaskList } from '../../src/shared/task-list'
import { activate, refOf, setSetting, startSession, waitForMail } from './agent-mail'
import { coord, coordApp, done, makeCoordinator, stillWaiting, turnOf, within } from './coordinator-helpers'
import { act, marksOf, openSessions, rowKey, sessionGroup, sessionRow, sessionsToggle } from './coordinator-window'

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
    await expect(sessionRow(page, rowKey(sids[2])).locator('.coord-prog i')).toHaveAttribute('style', /width: 33%/)
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

test('a redraw that a row showing now left pending is dropped when the panel closes or the tab is not a coordinator', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  const pending = (): Promise<boolean | undefined> => page.evaluate(() => window.__ct!.sessionsRedrawPending!())
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    // the attached row changed a moment ago: its "now" turns into a clock time later, so a redraw is pending
    await expect.poll(pending).toBe(true)
    await sessionsToggle(page).click()
    await expect(page.locator('#image-panel')).toHaveClass(/collapsed/)
    await expect.poll(pending).toBe(false)
    await openSessions(page)
    await expect.poll(pending).toBe(true)
    await activate(page, t1)
    await expect.poll(pending).toBe(false)
  } finally { await l.app.close() }
})

test('Open and a click on a row bring the session\'s tab to the front', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Open')
    await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).toBe(t1)
    // the panel is shut when another tab is in front: it is opened again for the coordinator
    await activate(page, t0)
    await openSessions(page)
    await expect(sessionRow(page, rowKey(sids[1]))).toBeVisible()
    // the rows are rebuilt on every view: the click is tried again until the session's tab is in front
    await expect(async () => {
      if ((await page.evaluate(() => window.__ct!.activeTabId())) !== t1) await sessionRow(page, rowKey(sids[1])).locator('.coord-name').click({ timeout: 1000 })
      expect(await page.evaluate(() => window.__ct!.activeTabId())).toBe(t1)
    }).toPass({ timeout: 15_000 })
  } finally { await l.app.close() }
})

test('Message gives the session a task from the panel', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    const mail = waitForMail(pipeName, t1, sids[1]!)
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Message')
    const name = await sessionRow(page, rowKey(sids[1])).locator('.coord-name').textContent()
    await expect(page.locator('#image-panel .coord-compose-head')).toHaveText(`Task for ${name}`)
    await page.locator('#image-panel .coord-compose-field').fill('Fix the parser.')
    await page.keyboard.press('Enter')
    await expect(page.locator('#image-panel .coord-compose')).toBeHidden()
    const got = await within(mail, 10_000)
    expect(got.info).toMatch(/^Task from your coordinator, through ClaudeTerm:/)
    expect(got.info).toContain('> Fix the parser.')
    await expect(sessionGroup(page, 'working').locator(`.coord-row[data-key="${rowKey(sids[1])}"]`)).toHaveCount(1)
  } finally { await l.app.close() }
})

test('Resolve, Detach and Attach move the row between the groups', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Resolve')
    await expect(sessionGroup(page, 'resolved').locator('.coord-gh .n')).toHaveText('1')
    // the head toggles, so a retry clicks only while the group is still folded
    const resolved = sessionGroup(page, 'resolved')
    await expect(async () => {
      if (await resolved.evaluate((g) => g.classList.contains('folded'))) await resolved.locator('.coord-gh').click({ timeout: 1000 })
      await expect(resolved).not.toHaveClass(/folded/, { timeout: 1000 })
    }).toPass({ timeout: 15_000 })
    await act(page, rowKey(sids[1]), 'Detach')
    await expect(sessionGroup(page, 'not-attached').locator(`.coord-row[data-key="${rowKey(sids[1])}"]`)).toHaveCount(1)
    await act(page, rowKey(sids[1]), 'Attach')
    await expect(sessionGroup(page, 'idle').locator(`.coord-row[data-key="${rowKey(sids[1])}"]`)).toHaveCount(1)
    // the buttons act on the row and do not reach it: its tab is not brought to the front by them
    expect(await page.evaluate(() => window.__ct!.activeTabId())).toBe(t0)
  } finally { await l.app.close() }
})

test('a task the hub refuses shows why under the Message box', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await setSetting(page, 'agentMessages.enabled', false)
    await act(page, rowKey(sids[1]), 'Message')
    await page.locator('#image-panel .coord-compose-field').fill('x')
    await page.keyboard.press('Enter')
    await expect(page.locator('#image-panel .coord-compose-error')).toContainText('Coordinating sessions needs agent messages')
    await expect(page.locator('#image-panel .coord-compose')).toBeVisible()
  } finally { await l.app.close() }
})

test('the Message box keeps its draft and its focus while the rows change, and Esc closes it without reaching the tab', async () => {
  const l = await coordApp(3)
  const { page, pipeName, tabs: [t0, , t2], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    for (const s of [sids[1], sids[2]]) expect(await coord(pipeName, t0, { op: 'attach', session: refOf(s!) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Message')
    const field = page.locator('#image-panel .coord-compose-field')
    await field.pressSequentially('Fix th')
    const before = await page.evaluate((id) => window.__ct!.ptyInput!(id), t0)
    // the view changes: the other session's turn starts, and its row moves to Working
    await turnOf(pipeName, t2, sids[2]!)
    await expect(sessionGroup(page, 'working').locator(`.coord-row[data-key="${rowKey(sids[2]!)}"]`)).toHaveCount(1)
    await expect(field).toHaveValue('Fix th')
    await expect(field).toBeFocused()
    // a listener on the document hears every Escape that the box does not stop: the app's keys listen there
    await page.evaluate(() => document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') (window as unknown as { __escapes?: number }).__escapes = ((window as unknown as { __escapes?: number }).__escapes ?? 0) + 1
    }))
    await page.keyboard.press('Escape')
    await expect(page.locator('#image-panel .coord-compose')).toBeHidden()
    // the Escape stopped at the box: it reached no listener on the document, and the panel stays open
    expect(await page.evaluate(() => (window as unknown as { __escapes?: number }).__escapes)).toBeUndefined()
    await expect(sessionRow(page, rowKey(sids[1]!))).toBeVisible()
    await expect(sessionRow(page, rowKey(sids[1]!))).toBeVisible()
    // the same keys from the buttons: Cancel closes the box, and its Escape reaches no listener on the document
    await act(page, rowKey(sids[1]!), 'Message')
    await page.locator('#image-panel .coord-compose-actions .coord-btn', { hasText: 'Cancel' }).focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('#image-panel .coord-compose')).toBeHidden()
    expect(await page.evaluate(() => (window as unknown as { __escapes?: number }).__escapes)).toBeUndefined()
    // and Send, with a task in the box, closes it on Escape too, without sending
    await act(page, rowKey(sids[1]!), 'Message')
    await field.fill('Fix the parser.')
    await page.locator('#image-panel .coord-compose-actions .coord-btn', { hasText: 'Send' }).focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('#image-panel .coord-compose')).toBeHidden()
    expect(await page.evaluate(() => (window as unknown as { __escapes?: number }).__escapes)).toBeUndefined()
    expect(await page.evaluate((id) => window.__ct!.ptyInput!(id), t0)).toBe(before)
  } finally { await l.app.close() }
})

test('Shift+Enter in the Message box inserts a new line and does not send', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Message')
    const field = page.locator('#image-panel .coord-compose-field')
    await field.fill('Line one')
    await page.keyboard.press('Shift+Enter')
    await field.pressSequentially('Line two')
    await expect(field).toHaveValue('Line one\nLine two')
    await expect(page.locator('#image-panel .coord-compose')).toBeVisible()
  } finally { await l.app.close() }
})

test('Send stays disabled while the Message box is blank or holds only spaces', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Message')
    const send = page.locator('#image-panel .coord-compose-actions .coord-btn.acc', { hasText: 'Send' })
    const field = page.locator('#image-panel .coord-compose-field')
    await expect(send).toBeDisabled()
    await field.fill('   ')
    await expect(send).toBeDisabled()
    await field.fill('Fix the parser.')
    await expect(send).toBeEnabled()
  } finally { await l.app.close() }
})

test('Detach on a starting row cancels the start', async () => {
  const l = await coordApp(1)
  const { page, pipeName, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    const answer = coord(pipeName, t0, { op: 'start', task: 'Write the release notes.', name: 'Release notes', folder: null, device: null, worktree: null })
    await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)
    const newTab = (await page.evaluate(() => window.__ct!.tabIds())).find((id) => id !== t0)!
    await activate(page, t0)
    await openSessions(page)
    const key = `start:${newTab}`
    await expect(sessionRow(page, key)).toBeVisible()
    await act(page, key, 'Detach')
    await expect(sessionRow(page, key)).toHaveCount(0)
    expect(await answer).toMatchObject({ ok: false, error: HUB_TEXT.startCancelled })
    // the session starts after the cancel: its tab is not attached and its task is not given
    const sid = randomUUID()
    expect(await startSession(pipeName, newTab, sid)).toEqual({ ok: true })
    await expect.poll(async () => (await marksOf(page))[newTab], { timeout: 3_000 }).toBeUndefined()
    await stillWaiting(waitForMail(pipeName, newTab, sid), 3_000)
  } finally { await l.app.close() }
})

test('the Message box closes when another tab comes to the front', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Message')
    await page.locator('#image-panel .coord-compose-field').fill('Fix the parser.')
    await expect(page.locator('#image-panel .coord-compose')).toBeVisible()
    await activate(page, t1)
    await activate(page, t0)
    await openSessions(page)
    await expect(page.locator('#image-panel .coord-compose')).toBeHidden()
    await expect(sessionRow(page, rowKey(sids[1]))).toBeVisible()
  } finally { await l.app.close() }
})

test('the Message box closes when its row leaves the coordinator', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Message')
    await page.locator('#image-panel .coord-compose-field').fill('Fix the parser.')
    await expect(page.locator('#image-panel .coord-compose')).toBeVisible()
    expect(await page.evaluate(([t, k]) => window.ct.coordDetach(t, k), [t0, rowKey(sids[1])] as const)).toMatchObject({ ok: true })
    await expect(sessionGroup(page, 'not-attached').locator(`.coord-row[data-key="${rowKey(sids[1])}"]`)).toHaveCount(1)
    await expect(page.locator('#image-panel .coord-compose')).toBeHidden()
  } finally { await l.app.close() }
})

test('a task is sent once: an Enter while the first one is on its way sends nothing', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    const first = waitForMail(pipeName, t1, sids[1]!)
    await activate(page, t0)
    await openSessions(page)
    await act(page, rowKey(sids[1]), 'Message')
    const field = page.locator('#image-panel .coord-compose-field')
    await field.fill('Fix the parser.')
    // Enter, typing again and Enter, in one turn of the page: no answer can come in between
    await field.evaluate((el: HTMLTextAreaElement) => {
      const enter = (): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }
      enter()
      el.value = 'Fix the parser. Again.'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      enter()
    })
    const got = await within(first, 10_000)
    expect(got.info).toContain('> Fix the parser.')
    expect(got.info).not.toContain('Again.')
    await expect(page.locator('#image-panel .coord-compose')).toBeHidden()
    // the turn that the first task starts ends: a second task queued behind it would be given now
    const second = waitForMail(pipeName, t1, sids[1]!)
    await turnOf(pipeName, t1, sids[1]!)
    await done(pipeName, t1, sids[1]!)
    await stillWaiting(second, 3_000)
  } finally { await l.app.close() }
})
