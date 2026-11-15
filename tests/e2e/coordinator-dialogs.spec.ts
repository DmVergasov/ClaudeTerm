import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_TEXT, worktreeInstruction } from '../../src/main/coordinator/coordinator-hub'
import { pathKey } from '../../src/main/path-key'
import { activate, startSession, waitForMail } from './agent-mail'
import { claudeTabIn, coordApp, makeCoordinator, within } from './coordinator-helpers'
import { act, marksOf, openSessions, rowKey, sessionRow, tabOrder } from './coordinator-window'
import { gitRepo } from './helpers'

const expect = baseExpect.configure({ timeout: 15_000 })

/** a button of the Sessions panel's toolbar, by its label */
const bar = (page: Page, label: string): Locator => page.locator('#image-panel .coord-bar button', { hasText: label })
const dialogOf = (page: Page, id: string): Locator => page.locator(`.coord-dialog[data-dialog="${id}"]`)
const startButton = (dialog: Locator): Locator => dialog.getByRole('button', { name: 'Start', exact: true })
/** the tab a start has just opened: the one that was not there before */
const newTab = async (page: Page, known: string[]): Promise<string> => (await tabOrder(page)).find((id) => !known.includes(id))!
/** a dialog's aria-labelledby, and the text of the element it names inside the dialog, read in one evaluate */
const titleOf = (page: Page, id: string): Promise<{ id: string | null; text: string | null }> => page.evaluate((d) => {
  const dialog = document.querySelector<HTMLElement>(`.coord-dialog[data-dialog="${d}"]`)
  const labelled = dialog?.getAttribute('aria-labelledby') ?? null
  return { id: labelled, text: labelled === null ? null : dialog?.querySelector(`[id="${labelled}"]`)?.textContent ?? null }
}, id)

test('New session opens an attached Claude tab named as asked, Starting… until its session starts, with its task as its first message', async () => {
  const l = await coordApp(1)
  const { page, pipeName, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const before = await tabOrder(page)
    await bar(page, 'New session').click()
    const dialog = dialogOf(page, 'new-session')
    await expect(dialog).toBeVisible()
    await dialog.locator('textarea[name="task"]').fill('Write the release notes.')
    await dialog.locator('input[name="name"]').fill('Release notes')
    await startButton(dialog).click()
    await expect.poll(async () => (await tabOrder(page)).length).toBe(before.length + 1)
    const fresh = await newTab(page, before)
    await expect.poll(() => page.evaluate((id) => window.__ct!.tabTitle!(id), fresh)).toBe('Release notes')
    await expect(sessionRow(page, `start:${fresh}`).locator('.coord-l3')).toHaveText('Starting…')
    // while the start is pending the action reads Starting… and is off; Cancel stays on
    await expect(dialog.getByRole('button', { name: 'Starting…', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
    const sid = randomUUID()
    expect(await startSession(pipeName, fresh, sid)).toEqual({ ok: true })
    await expect(dialog).toHaveCount(0)
    expect((await within(waitForMail(pipeName, fresh, sid), 10_000)).info).toContain('> Write the release notes.')
    await expect(sessionRow(page, rowKey(sid))).toHaveCount(1)
  } finally { await l.app.close() }
})

test('New session checks its fields before it asks, and shows main\'s refusal', async () => {
  const l = await coordApp(1)
  const { page, repo, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const before = await tabOrder(page)
    await bar(page, 'New session').click()
    const dialog = dialogOf(page, 'new-session')
    // Start is off while the task is empty; the folder's placeholder is the coordinator's folder
    await expect(startButton(dialog)).toBeDisabled()
    await expect(dialog.locator('input[name="folder"]')).toHaveAttribute('placeholder', repo)
    const error = dialog.locator('.mcp-add-error')
    await dialog.locator('textarea[name="task"]').fill('x')
    await expect(startButton(dialog)).toBeEnabled()
    // a folder that is not a full path is refused here, before main is asked
    await dialog.locator('input[name="folder"]').fill('relative/dir')
    await startButton(dialog).click()
    await expect(error).toHaveText('The folder must be a full path.')
    await dialog.locator('input[name="folder"]').fill('')
    await dialog.locator('input[name="worktree"]').fill('a b')
    await startButton(dialog).click()
    await expect(error).toHaveText('A worktree name is letters, digits, ".", "_" and "-", starts with a letter or digit, and is at most 64 long.')
    // a folder that does not exist is main's refusal, and the dialog stays open with it
    await dialog.locator('input[name="worktree"]').fill('')
    const missing = join(tmpdir(), 'ct-no-such-folder')
    await dialog.locator('input[name="folder"]').fill(missing)
    await startButton(dialog).click()
    await expect(error).toHaveText(`No folder ${missing} on this device.`)
    await expect(dialog).toBeVisible()
    expect(await tabOrder(page)).toHaveLength(before.length)
  } finally { await l.app.close() }
})

test('Attach… lists the other Claude sessions of this device, of another project too, and attaches the one picked', async () => {
  const l = await coordApp(2)
  const { page, tabs: [t0, t1] } = l
  try {
    const other = await claudeTabIn(l, gitRepo())
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await bar(page, 'Attach…').click()
    const dialog = dialogOf(page, 'attach')
    await expect(dialog.locator('.coord-dialog-text')).toHaveText('Pick a Claude session of this device. It is not told and goes on as it is.')
    const picks = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.coord-dialog[data-dialog="attach"] .coord-pick')].map((b) => b.dataset.tabId))
    expect(picks).toEqual([t1, other.tabId])
    await dialog.locator(`.coord-pick[data-tab-id="${other.tabId}"]`).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await marksOf(page))[other.tabId]).toMatchObject({ role: 'attached', coordinatorTabId: t0 })
  } finally { await l.app.close() }
})

test('Attach… with no other session says so', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await bar(page, 'Attach…').click()
    const dialog = dialogOf(page, 'attach')
    await expect(dialog.locator('.coord-picks-empty')).toHaveText('No other Claude session runs on this device.')
    await expect(dialog.locator('.coord-pick')).toHaveCount(0)
  } finally { await l.app.close() }
})

test('keys typed in a dialog stay in it, and Esc closes it', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await bar(page, 'New session').click()
    const dialog = dialogOf(page, 'new-session')
    // the baseline is taken with the dialog's focus in place: the terminal reports that its focus went away when the click left it
    await expect(dialog.locator('textarea[name="task"]')).toBeFocused()
    const before = await page.evaluate((id) => window.__ct!.ptyInput!(id), t0)
    // a listener on the document counts every key that the dialog does not stop: the app's keys listen there
    await page.evaluate(() => {
      const w = window as unknown as { __keys?: number }
      w.__keys = 0
      document.addEventListener('keydown', () => { w.__keys = (w.__keys ?? 0) + 1 })
    })
    const task = dialog.locator('textarea[name="task"]')
    await task.pressSequentially('abc')
    await expect(task).toHaveValue('abc')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __keys?: number }).__keys ?? 0)).toBe(0)
    expect(await page.evaluate((id) => window.__ct!.ptyInput!(id), t0)).toBe(before)
  } finally { await l.app.close() }
})

test('a dialog of a coordinator that stopped shows main\'s refusal', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await bar(page, 'New session').click()
    const dialog = dialogOf(page, 'new-session')
    await dialog.locator('textarea[name="task"]').fill('Write the notes.')
    expect(await page.evaluate((id) => window.ct.coordStop(id), t0)).toMatchObject({ ok: true })
    await startButton(dialog).click()
    await expect(dialog.locator('.mcp-add-error')).toContainText('This tab is not a coordinator.')
  } finally { await l.app.close() }
})

test('a start the dialog is cancelled from while it is Starting… tells its refusal as a toast when main answers it', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const before = await tabOrder(page)
    await bar(page, 'New session').click()
    const dialog = dialogOf(page, 'new-session')
    await dialog.locator('textarea[name="task"]').fill('Write the notes.')
    await startButton(dialog).click()
    await expect.poll(async () => (await tabOrder(page)).length).toBe(before.length + 1)
    const fresh = await newTab(page, before)
    await expect(dialog.getByRole('button', { name: 'Starting…', exact: true })).toBeVisible()
    // Cancel closes the dialog while the start is pending; the start goes on until its row is detached
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await act(page, `start:${fresh}`, 'Detach')
    await expect(page.locator('.toast', { hasText: HUB_TEXT.startCancelled })).toBeVisible()
  } finally { await l.app.close() }
})

test('New session in another folder, in the worktree it names, opens its tab there, and its first message asks for the worktree', async () => {
  const l = await coordApp(1)
  const { page, pipeName, tabs: [t0] } = l
  const folder = gitRepo()
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const before = await tabOrder(page)
    await bar(page, 'New session').click()
    const dialog = dialogOf(page, 'new-session')
    await dialog.locator('textarea[name="task"]').fill('Write the release notes.')
    await dialog.locator('input[name="folder"]').fill(folder)
    await dialog.locator('input[name="worktree"]').fill('notes-1')
    await startButton(dialog).click()
    await expect.poll(async () => (await tabOrder(page)).length).toBe(before.length + 1)
    const fresh = await newTab(page, before)
    // a tab's title attribute ends with its folder: the new tab works in the folder typed
    await expect.poll(async () => pathKey(await page.evaluate((id) => document.querySelector(`#tabbar .tab[data-tab-id="${id}"]`)?.getAttribute('title')?.split('\n').pop() ?? '', fresh))).toBe(pathKey(folder))
    const sid = randomUUID()
    expect(await startSession(pipeName, fresh, sid)).toEqual({ ok: true })
    const got = await within(waitForMail(pipeName, fresh, sid), 10_000)
    expect(got.info).toContain(worktreeInstruction('notes-1').trim())
    expect(got.info).toContain('> Write the release notes.')
  } finally { await l.app.close() }
})

test('each dialog has a title of its own, and its aria-labelledby names it', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await bar(page, 'New session').click()
    const first = await titleOf(page, 'new-session')
    expect(first).toEqual({ id: expect.stringMatching(/^coord-dialog-title-\d+$/), text: 'New session' })
    await page.keyboard.press('Escape')
    await expect(dialogOf(page, 'new-session')).toHaveCount(0)
    await bar(page, 'Attach…').click()
    const second = await titleOf(page, 'attach')
    expect(second).toEqual({ id: expect.stringMatching(/^coord-dialog-title-\d+$/), text: 'Attach a session' })
    expect(second.id).not.toBe(first.id)
  } finally { await l.app.close() }
})

test('Ctrl+Enter in the task and Enter in the name submit, Enter in the task is a new line, and Start is off while the task is blank', async () => {
  const l = await coordApp(1)
  const { page, pipeName, tabs: [t0] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    const before = await tabOrder(page)
    await bar(page, 'New session').click()
    const dialog = dialogOf(page, 'new-session')
    const task = dialog.locator('textarea[name="task"]')
    await task.fill('   ')
    await expect(startButton(dialog)).toBeDisabled()
    await task.fill('Line one')
    await task.press('Enter')
    await task.pressSequentially('Line two')
    await expect(task).toHaveValue('Line one\nLine two')
    await expect(dialog).toBeVisible()
    expect(await tabOrder(page)).toHaveLength(before.length)
    await task.press('ControlOrMeta+Enter')
    await expect.poll(async () => (await tabOrder(page)).length).toBe(before.length + 1)
    const first = await newTab(page, before)
    expect(await startSession(pipeName, first, randomUUID())).toEqual({ ok: true })
    await expect(dialog).toHaveCount(0)
    // Enter in the Name input submits as well
    const known = await tabOrder(page)
    await bar(page, 'New session').click()
    await dialog.locator('textarea[name="task"]').fill('Second task.')
    await dialog.locator('input[name="name"]').fill('Second')
    await dialog.locator('input[name="name"]').press('Enter')
    await expect.poll(async () => (await tabOrder(page)).length).toBe(known.length + 1)
    const second = await newTab(page, known)
    await expect(page.evaluate((id) => window.__ct!.tabTitle!(id), second)).resolves.toBe('Second')
    expect(await startSession(pipeName, second, randomUUID())).toEqual({ ok: true })
    await expect(dialog).toHaveCount(0)
  } finally { await l.app.close() }
})

test('Attach… that main refuses shows its error, enables the picks again, and Esc closes the dialog with no key reaching the document', async () => {
  const l = await coordApp(2)
  const { page, tabs: [t0, t1] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await bar(page, 'Attach…').click()
    const dialog = dialogOf(page, 'attach')
    const pick = dialog.locator(`.coord-pick[data-tab-id="${t1}"]`)
    await expect(pick).toBeVisible()
    // the coordinator stops while the dialog is open: main refuses the attach
    expect(await page.evaluate((id) => window.ct.coordStop(id), t0)).toMatchObject({ ok: true })
    await pick.click()
    await expect(dialog.locator('.mcp-add-error')).toHaveText(HUB_TEXT.notCoordinator)
    // the picks are enabled again, and the keyboard is in the dialog again
    await expect(pick).toBeEnabled()
    expect(await page.evaluate(() => !!document.activeElement?.closest('.coord-dialog[data-dialog="attach"]'))).toBe(true)
    await page.evaluate(() => {
      const w = window as unknown as { __keys?: number }
      w.__keys = 0
      document.addEventListener('keydown', () => { w.__keys = (w.__keys ?? 0) + 1 })
    })
    await page.keyboard.press('x')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __keys?: number }).__keys ?? 0)).toBe(0)
  } finally { await l.app.close() }
})

