import { expect as baseExpect, test } from '@playwright/test'
import { activate, refOf } from './agent-mail'
import { coord, coordApp, makeCoordinator } from './coordinator-helpers'
import { dragOnto, holdOver, LEFT, marksOf, moveOver, openSessions, panelRows, pill, restOver, rowKey, sessionRow, tabOrder, tpRow } from './coordinator-window'

const expect = baseExpect.configure({ timeout: 15_000 })

test('a Claude tab dropped onto the coordinator\'s row is attached and moves under it', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, tabs: [t0, t1, t2] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2])
    await expect(async () => {
      await dragOnto(page, tpRow(page, t2), tpRow(page, t0))
      await expect.poll(async () => (await marksOf(page))[t2], { timeout: 3000 }).toMatchObject({ role: 'attached', coordinatorTabId: t0 })
    }).toPass({ timeout: 30_000 })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t2, t1])
  } finally {
    await l.app.close()
  }
})

test('an attached row dropped onto a row outside its block is detached and stays where it was dropped', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, pipeName, tabs: [t0, t1, t2], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2])
    await expect(async () => {
      await dragOnto(page, tpRow(page, t1), tpRow(page, t2))
      await expect.poll(async () => (await marksOf(page))[t1], { timeout: 3000 }).toBeUndefined()
    }).toPass({ timeout: 30_000 })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t2, t1])
    await expect.poll(() => panelRows(page)).toEqual([
      { id: t0, attached: false, label: 'Coordinator', to: null },
      { id: t2, attached: false, label: null, to: null },
      { id: t1, attached: false, label: null, to: null }
    ])
  } finally {
    await l.app.close()
  }
})

test('an attached row dropped onto another attached row reorders the block; both stay attached', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, pipeName, tabs: [t0, t1, t2], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[2]) })).toMatchObject({ ok: true })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2])
    await expect(async () => {
      await dragOnto(page, tpRow(page, t2), tpRow(page, t1))
      await expect.poll(() => tabOrder(page), { timeout: 3000 }).toEqual([t0, t2, t1])
    }).toPass({ timeout: 30_000 })
    const marks = await marksOf(page)
    expect(marks[t1]).toMatchObject({ role: 'attached', coordinatorTabId: t0 })
    expect(marks[t2]).toMatchObject({ role: 'attached', coordinatorTabId: t0 })
  } finally {
    await l.app.close()
  }
})

test('a tab dropped onto the Sessions panel is attached', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, tabs: [t0, t1], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await activate(page, t0)
    await openSessions(page)
    await expect(async () => {
      await dragOnto(page, tpRow(page, t1), page.locator('#image-panel .panel-sessions'))
      await expect.poll(async () => (await marksOf(page))[t1], { timeout: 3000 }).toMatchObject({ role: 'attached', coordinatorTabId: t0 })
    }).toPass({ timeout: 30_000 })
    await expect(sessionRow(page, rowKey(sids[1]))).toBeVisible()
  } finally {
    await l.app.close()
  }
})

test('tabs at the top: a tab dropped onto the coordinator\'s tab is attached', async () => {
  const l = await coordApp(3)
  const { page, tabs: [t0, t1, t2] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect(async () => {
      await dragOnto(page, pill(page, t2), pill(page, t0))
      await expect.poll(async () => (await marksOf(page))[t2], { timeout: 3000 }).toMatchObject({ role: 'attached', coordinatorTabId: t0 })
    }).toPass({ timeout: 30_000 })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t2, t1])
  } finally {
    await l.app.close()
  }
})

test('a Claude tab held over the coordinator\'s row lights that row, and loses the light over another row', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, tabs: [t0, t1, t2] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2])
    await expect(async () => {
      await holdOver(page, tpRow(page, t2), tpRow(page, t0))
      await expect.poll(async () => { await restOver(page, tpRow(page, t0)); return tpRow(page, t0).getAttribute('class') }, { timeout: 3000 }).toMatch(/coord-drop/)
    }).toPass({ timeout: 30_000 })
    await moveOver(page, tpRow(page, t1))
    await expect(tpRow(page, t0)).not.toHaveClass(/coord-drop/)
    // released over the sheet's header, which takes no drop: nothing moves and no light is left
    await moveOver(page, page.locator('#sheet-header'))
    await page.mouse.up()
    await expect(page.locator('.coord-drop')).toHaveCount(0)
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2])
    expect((await marksOf(page))[t2]).toBeUndefined()
  } finally {
    await l.app.close()
  }
})

test('tabs at the top: a Claude tab held over the coordinator\'s tab lights that tab, and loses the light over another', async () => {
  const l = await coordApp(3)
  const { page, tabs: [t0, t1, t2] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect(async () => {
      await holdOver(page, pill(page, t2), pill(page, t0))
      await expect.poll(async () => { await restOver(page, pill(page, t0)); return pill(page, t0).getAttribute('class') }, { timeout: 3000 }).toMatch(/coord-drop/)
    }).toPass({ timeout: 30_000 })
    await moveOver(page, pill(page, t1))
    await expect(pill(page, t0)).not.toHaveClass(/coord-drop/)
    await moveOver(page, page.locator('#sheet-header'))
    await page.mouse.up()
    await expect(page.locator('.coord-drop')).toHaveCount(0)
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2])
    expect((await marksOf(page))[t2]).toBeUndefined()
  } finally {
    await l.app.close()
  }
})

test('a tab held over the Sessions panel lights the panel, and no light is left after the release', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, repo, tabs: [t0, , t2] } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    // a shell tab: its drop on the panel does nothing, so it must not light the panel
    const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), repo))!.id
    await expect.poll(() => tabOrder(page)).toContain(shell)
    await activate(page, t0)
    await openSessions(page)
    const body = page.locator('#image-panel .panel-sessions')
    await expect(async () => {
      await holdOver(page, tpRow(page, t2), body)
      await expect.poll(async () => { await restOver(page, body); return body.getAttribute('class') }, { timeout: 3000 }).toMatch(/coord-drop/)
    }).toPass({ timeout: 30_000 })
    await page.mouse.up()
    await expect(page.locator('.coord-drop')).toHaveCount(0)
    await expect.poll(async () => (await marksOf(page))[t2]).toMatchObject({ role: 'attached', coordinatorTabId: t0 })
    // the shell tab held over the panel: the drag's events reach the page (counted), and no light comes
    await page.evaluate(() => {
      const w = window as unknown as { __over: number }
      w.__over = 0
      document.addEventListener('dragover', () => { w.__over++ })
    })
    await holdOver(page, tpRow(page, shell), body)
    await expect.poll(() => page.evaluate(() => (window as unknown as { __over: number }).__over)).toBeGreaterThan(0)
    await restOver(page, body)
    await expect(body).not.toHaveClass(/coord-drop/)
    await page.mouse.up()
    await expect(page.locator('.coord-drop')).toHaveCount(0)
    expect((await marksOf(page))[shell]).toBeUndefined()
  } finally {
    await l.app.close()
  }
})
