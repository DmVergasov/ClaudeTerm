import { expect as baseExpect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gitRepo } from './helpers'
import { claudeTabIn, coord, coordApp, makeCoordinator } from './coordinator-helpers'
import { refOf } from './agent-mail'
import { LEFT, panelRows, pill, tabOrder, tpRow } from './coordinator-window'

const expect = baseExpect.configure({ timeout: 15_000 })

test('the coordinator\'s row is labelled, its attached sessions of the project follow it indented, and one of another project shows where it reports', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, pipeName, tabs: [t0, t1, t2], sids, repo } = l
  try {
    const other = await claudeTabIn(l, gitRepo())
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t1, t2, other.tabId])
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[2]) })).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(other.sid) })).toMatchObject({ ok: true })
    // the block is the real tab order: the window wrote it back
    await expect.poll(() => tabOrder(page)).toEqual([t0, t2, t1, other.tabId])
    await expect.poll(() => panelRows(page)).toEqual([
      { id: t0, attached: false, label: 'Coordinator', to: null },
      { id: t2, attached: true, label: null, to: null },
      { id: t1, attached: false, label: null, to: null },
      { id: other.tabId, attached: false, label: null, to: `↳ ${basename(repo)}` }
    ])
    await expect(tpRow(page, t0).locator('.tab-coord')).toHaveAttribute('title', `Coordinator of ${basename(repo)}`)
  } finally {
    await l.app.close()
  }
})

test('an attached session of another project whose row has no place still shows where it reports, on a line of its own', async () => {
  const l = await coordApp(2, { settings: LEFT })
  const { page, pipeName, tabs: [t0, t1], repo } = l
  try {
    // a folder outside git: its row has no branch line
    const outside = await claudeTabIn(l, mkdtempSync(join(tmpdir(), 'ct-plain-')))
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(outside.sid) })).toMatchObject({ ok: true })
    await expect.poll(() => panelRows(page)).toEqual([
      { id: t0, attached: false, label: 'Coordinator', to: null },
      { id: t1, attached: false, label: null, to: null },
      { id: outside.tabId, attached: false, label: null, to: `↳ ${basename(repo)}` }
    ])
    // the row's only line is the mark: no branch icon in it
    const line = tpRow(page, outside.tabId).locator('.tp-branch')
    await expect(line).toHaveText(`↳ ${basename(repo)}`)
    await expect(line.locator('svg')).toHaveCount(0)
  } finally {
    await l.app.close()
  }
})

test('a detached row is an ordinary row again, where it stands', async () => {
  const l = await coordApp(3, { settings: LEFT })
  const { page, pipeName, tabs: [t0, t1, t2], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[2]) })).toMatchObject({ ok: true })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t2, t1])
    await expect.poll(() => panelRows(page)).toEqual([
      { id: t0, attached: false, label: 'Coordinator', to: null },
      { id: t2, attached: true, label: null, to: null },
      { id: t1, attached: false, label: null, to: null }
    ])

    expect(await coord(pipeName, t0, { op: 'detach', session: refOf(sids[2]) })).toMatchObject({ ok: true })
    await expect.poll(() => panelRows(page)).toEqual([
      { id: t0, attached: false, label: 'Coordinator', to: null },
      { id: t2, attached: false, label: null, to: null },
      { id: t1, attached: false, label: null, to: null }
    ])
    expect(await tabOrder(page)).toEqual([t0, t2, t1])
  } finally {
    await l.app.close()
  }
})

test('tabs at the top: the coordinator\'s tab carries the mark, its attached tab moves next to it, nothing is indented or marked ↳', async () => {
  const l = await coordApp(3)
  const { page, pipeName, tabs: [t0, t1, t2], sids } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[2]) })).toMatchObject({ ok: true })
    await expect.poll(() => tabOrder(page)).toEqual([t0, t2, t1])
    await expect(pill(page, t0).locator('.tab-coord')).toHaveText('Coordinator')
    await expect(page.locator('#tabbar .tp-coord-to')).toHaveCount(0)
    await expect(page.locator('#tabbar .coord-attached')).toHaveCount(0)
  } finally {
    await l.app.close()
  }
})
