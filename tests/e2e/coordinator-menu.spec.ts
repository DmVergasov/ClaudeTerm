import { expect as baseExpect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { openTabInFront } from './helpers'
import { claudeTabIn, coord, coordApp, makeCoordinator } from './coordinator-helpers'
import { refOf } from './agent-mail'
import { marksOf, menuItem, pill } from './coordinator-window'

const expect = baseExpect.configure({ timeout: 15_000 })

test('Make project coordinator makes a Claude tab of a git project its coordinator; Stop coordinating ends it', async () => {
  const l = await coordApp(2)
  const { page, tabs: [t0] } = l
  try {
    await menuItem(page, t0, 'Make project coordinator')
    await expect(pill(page, t0).locator('.tab-coord')).toHaveText('Coordinator')
    expect((await marksOf(page))[t0]).toMatchObject({ role: 'coordinator' })
    await menuItem(page, t0, 'Stop coordinating')
    await expect(pill(page, t0).locator('.tab-coord')).toHaveCount(0)
    expect((await marksOf(page))[t0]).toBeUndefined()
  } finally { await l.app.close() }
})

test('a second tab of the project asks before it replaces the coordinator: Cancel keeps it, Replace moves its sessions', async () => {
  const l = await coordApp(3)
  const { page, pipeName, tabs: [t0, t1, t2], sids, repo } = l
  try {
    await makeCoordinator(page, t0)
    await expect(pill(page, t0).locator('.tab-coord')).toHaveText('Coordinator')
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[2]) })
    const dialog = page.locator('.coord-dialog[data-dialog="replace"]')
    await menuItem(page, t1, 'Make project coordinator')
    await expect(dialog.locator('.mcp-add-title')).toHaveText(`Replace the coordinator of ${basename(repo)}?`)
    const box = await dialog.boundingBox()
    expect(Math.abs(box!.width - 460)).toBeLessThan(2)
    await dialog.locator('button', { hasText: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    // the menu that asked is gone: the terminal of the tab in front has the focus again
    await expect(page.locator('.terminal-host:visible .xterm-helper-textarea')).toBeFocused()
    expect((await marksOf(page))[t0]).toMatchObject({ role: 'coordinator' })
    await menuItem(page, t1, 'Make project coordinator')
    await dialog.locator('button', { hasText: 'Replace' }).click()
    await expect.poll(async () => (await marksOf(page))[t1]?.role).toBe('coordinator')
    const marks = await marksOf(page)
    expect(marks[t0]).toBeUndefined()
    expect(marks[t2]).toMatchObject({ role: 'attached', coordinatorTabId: t1 })
  } finally { await l.app.close() }
})

test('Esc closes the replace question and types nothing into the tab', async () => {
  const l = await coordApp(3)
  const { page, pipeName, tabs: [t0, t1], sids, repo } = l
  try {
    await makeCoordinator(page, t0)
    await expect(pill(page, t0).locator('.tab-coord')).toHaveText('Coordinator')
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[2]) })
    const dialog = page.locator('.coord-dialog[data-dialog="replace"]')
    await menuItem(page, t1, 'Make project coordinator')
    await expect(dialog.locator('.mcp-add-title')).toHaveText(`Replace the coordinator of ${basename(repo)}?`)
    const before = await page.evaluate((id) => window.__ct!.ptyInput!(id), t1)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate((id) => window.__ct!.ptyInput!(id), t1)).toBe(before)
    expect((await marksOf(page))[t0]).toMatchObject({ role: 'coordinator' })
  } finally { await l.app.close() }
})

test('an attached tab\'s menu detaches it from its coordinator', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids, repo } = l
  try {
    await makeCoordinator(page, t0)
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })
    await expect.poll(async () => (await marksOf(page))[t1]?.role).toBe('attached')
    await menuItem(page, t1, `Detach from the ${basename(repo)} coordinator`)
    await expect.poll(async () => (await marksOf(page))[t1]).toBeUndefined()
  } finally { await l.app.close() }
})

test('a local tab is attached from its menu, and Make project coordinator stays under it', async () => {
  const l = await coordApp(2)
  const { page, tabs: [t0, t1], repo } = l
  try {
    await makeCoordinator(page, t0)
    await expect(pill(page, t0).locator('.tab-coord')).toHaveText('Coordinator')
    // a right-click that lands while the menu's answers are on their way is tried again
    await expect(async () => {
      await pill(page, t1).click({ button: 'right' })
      await expect(page.locator('.menu .menu-item', { hasText: 'Make project coordinator' })).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 15_000 })
    const coordinatorItems = (await page.locator('.menu .menu-item').allTextContents()).filter((text) => text.includes('coordinator'))
    expect(coordinatorItems).toEqual([`Attach to the ${basename(repo)} coordinator`, 'Make project coordinator'])

    await page.locator('.menu .menu-item', { hasText: `Attach to the ${basename(repo)} coordinator` }).click()
    await expect.poll(async () => (await marksOf(page))[t1], { timeout: 15_000 }).toMatchObject({ role: 'attached', project: basename(repo), coordinatorTabId: t0 })
    await expect.poll(async () => (await page.evaluate((id) => window.ct.coordView(id), t0))?.sessions.some((r) => r.tabId === t1), { timeout: 15_000 }).toBe(true)
  } finally { await l.app.close() }
})

test('a shell tab and a Claude tab outside git have no coordinator item', async () => {
  const l = await coordApp(1)
  const { page, repo } = l
  try {
    const shell = await openTabInFront(page, 'shell', repo)
    const plain = await claudeTabIn(l, mkdtempSync(join(tmpdir(), 'ct-plain-')))
    await expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id) === null, plain.tabId)).toBe(true)
    for (const id of [shell, plain.tabId]) {
      // a right-click that lands while the menu's answers are on their way is tried again: Close tab is in every tab's menu
      await expect(async () => {
        await pill(page, id).click({ button: 'right' })
        await expect(page.locator('.menu .menu-item', { hasText: 'Close tab' })).toBeVisible({ timeout: 1000 })
      }).toPass({ timeout: 15_000 })
      expect(await page.locator('.menu .menu-item').allTextContents()).not.toContain('Make project coordinator')
    }
  } finally { await l.app.close() }
})

test('the ✕ and a press on the scrim close the replace question, and neither replaces the coordinator', async () => {
  const l = await coordApp(2)
  const { page, tabs: [t0, t1] } = l
  try {
    await makeCoordinator(page, t0)
    await expect(pill(page, t0).locator('.tab-coord')).toHaveText('Coordinator')
    const dialog = page.locator('.coord-dialog[data-dialog="replace"]')
    await menuItem(page, t1, 'Make project coordinator')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)
    await menuItem(page, t1, 'Make project coordinator')
    await expect(dialog).toBeVisible()
    await page.mouse.click(4, 4)
    await expect(dialog).toHaveCount(0)
    const marks = await marksOf(page)
    expect(marks[t0]).toMatchObject({ role: 'coordinator' })
    expect(marks[t1]).toBeUndefined()
  } finally { await l.app.close() }
})
