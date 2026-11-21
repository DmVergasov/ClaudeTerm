import { expect as baseExpect, test, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { COORD_REFUSED } from '../../src/shared/coordinator'
import { startSession } from './agent-mail'
import { claudeTabIn, coordApp, coordDevices, makeCoordinator } from './coordinator-helpers'
import { dragOnto, LEFT, marksOf, panelRows, tabOrder, tpRow } from './coordinator-window'
import { closePaired, SLOW } from './device-pair'
import { gitRepo, gitWorktree, launchApp, openTabInFront, panelSettled, typeInTerminal } from './helpers'

// The coordinator chip on a project's header in the left panel (docs/superpowers/specs/2026-11-15-coordinator-chip-design.md)

const expect = baseExpect.configure({ timeout: 15_000 })

test.afterEach(closePaired)

/** this device's group of the project named `name` (a paired device's section is left out) */
const groupNamed = (page: Page, name: string): Locator =>
  page.locator('#tabpanel .tp-list > .tp-group').filter({ has: page.locator('.tp-group-name', { hasText: new RegExp(`^${name}$`) }) })
const chipOf = (page: Page, name: string): Locator => groupNamed(page, name).locator('.tp-coord-chip')
const activeTab = (page: Page): Promise<string | null> => page.evaluate(() => window.__ct!.activeTabId())
const placeOf = (page: Page, id: string) => page.evaluate((tabId) => window.__ct!.placeOf!(tabId) ?? null, id)
/** a refusal of the chip's start: every coordinator refusal names a coordinator */
const refusal = (page: Page): Locator => page.locator('.toast', { hasText: /coordinat/i })

/** the tab the window lists that was not in `before`: the tab a + Coordinator click opened */
async function openedSince(page: Page, before: string[]): Promise<string> {
  const added = await page.waitForFunction((old) => window.__ct!.tabIds().find((id) => !old.includes(id)) ?? false, before)
  return (await added.jsonValue()) as string
}

test('a project group shows + Coordinator between its name and its count, ● Coordinator once it has a coordinator, folded too; No project has none, the chip has no tooltip, and main refuses a tab outside a project', async () => {
  const l = await coordApp(1, { settings: LEFT })
  const { page, tabs: [t0], repo } = l
  try {
    const plain = await openTabInFront(page, 'shell', homedir())
    const group = groupNamed(page, basename(repo))
    const chip = chipOf(page, basename(repo))
    await expect(chip).toHaveClass(/\bstart\b/)
    await expect(chip.locator('.tp-coord-chip-word')).toHaveText('Coordinator')
    await expect(chip.locator('.tp-coord-chip-mark')).toBeVisible()
    expect(await chip.getAttribute('title')).toBeNull()
    expect(await group.locator('.tp-group-head').evaluate((h) => ({
      before: h.querySelector('.tp-coord-chip')!.previousElementSibling!.className,
      last: h.lastElementChild!.className
    }))).toEqual({ before: 'tp-group-name', last: 'tp-group-count' })
    await expect(groupNamed(page, 'No project')).toHaveCount(1)
    await expect(groupNamed(page, 'No project').locator('.tp-coord-chip')).toHaveCount(0)
    expect(await page.evaluate(() => window.ct.coordStartCoordinator('no-such-tab'))).toEqual({ ok: false, error: COORD_REFUSED })
    expect(await page.evaluate((id) => window.ct.coordStartCoordinator(id), plain)).toEqual({ ok: false, error: COORD_REFUSED })

    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect(chip).toHaveClass(/\brunning\b/)
    await expect(chip.locator('.tp-coord-chip-word')).toHaveText('Coordinator')
    await group.locator('.tp-group-name').click()
    await expect(group).toHaveClass(/\bfolded\b/)
    await expect(chip).toHaveClass(/\brunning\b/)
    // ● on a folded group: the coordinator's tab comes to the front, and the tab in front is never under a folded group
    await chip.click()
    await expect.poll(() => activeTab(page)).toBe(t0)
    await expect(group).not.toHaveClass(/\bfolded\b/)
  } finally {
    await l.app.close()
  }
})

test("● Coordinator brings the coordinator's tab to the front; a chip's click never folds its group, and a drag from a chip moves no group and opens no tab", async () => {
  const l = await coordApp(2, { settings: LEFT })
  const { page, tabs: [t0, t1], repo } = l
  try {
    const otherRepo = gitRepo()
    await claudeTabIn(l, otherRepo)
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    const group = groupNamed(page, basename(repo))
    await expect(chipOf(page, basename(repo))).toHaveClass(/\brunning\b/)
    await page.evaluate((id) => window.ct.activateTab(id), t1)
    await expect.poll(() => activeTab(page)).toBe(t1)

    // the tab that comes to the front would unfold a group the click had folded: an observer sees any fold on the way
    const key = (await group.getAttribute('data-group'))!
    await page.evaluate((k) => {
      const w = window as unknown as { sawFolded: boolean }
      w.sawFolded = false
      new MutationObserver(() => {
        if ([...document.querySelectorAll<HTMLElement>('#tabpanel .tp-group.folded')].some((g) => g.dataset.group === k)) w.sawFolded = true
      }).observe(document.getElementById('tabpanel')!, { subtree: true, childList: true, attributes: true })
    }, key)
    await chipOf(page, basename(repo)).click()
    await expect.poll(() => activeTab(page)).toBe(t0)
    await expect(group).not.toHaveClass(/\bfolded\b/)
    expect(await page.evaluate(() => (window as unknown as { sawFolded: boolean }).sawFolded)).toBe(false)
    await expect(group.locator('.tp-tab')).toHaveCount(2)

    await expect(chipOf(page, basename(otherRepo))).toHaveClass(/\bstart\b/)
    const order = await tabOrder(page)
    await dragOnto(page, chipOf(page, basename(otherRepo)), group.locator('.tp-group-head'))
    await page.waitForTimeout(500)
    expect(await tabOrder(page)).toEqual(order)
    expect(await page.locator('#tabpanel .tp-list > .tp-group .tp-group-name').allTextContents()).toEqual([basename(repo), basename(otherRepo)])
    await expect(groupNamed(page, basename(otherRepo))).not.toHaveClass(/\bfolded\b/)
  } finally {
    await l.app.close()
  }
})

test("+ Coordinator opens a Claude tab in the project's main folder, first in its group and in front, which becomes the coordinator once its session starts; a second click meanwhile brings that tab to the front and opens no other", async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/chip')
  const l = await coordApp(2, { settings: LEFT, repo: worktree })
  const { page, pipeName, tabs: [t0, t1] } = l
  const name = basename(repo)
  try {
    const chip = chipOf(page, name)
    await expect(chip).toHaveClass(/\bstart\b/)
    const before = await tabOrder(page)
    await chip.click()
    const tab = await openedSince(page, before)
    await expect.poll(() => activeTab(page)).toBe(tab)
    // the main worktree: the project of the group's tabs, not their linked worktree
    const project = (await placeOf(page, t0))!.project.key
    await expect.poll(async () => {
      const p = await placeOf(page, tab)
      return p ? { key: p.project.key, worktree: p.worktree } : null
    }).toEqual({ key: project, worktree: null })
    await expect.poll(() => tabOrder(page)).toEqual([tab, t0, t1])
    await expect.poll(async () => (await panelRows(page))[0]?.id).toBe(tab)
    await expect(groupNamed(page, name)).not.toHaveClass(/\bfolded\b/)
    expect((await marksOf(page))[tab]).toBeUndefined()
    await expect(chip).toHaveClass(/\bstart\b/)
    expect(await chip.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0)

    await page.evaluate((id) => window.ct.activateTab(id), t1)
    await expect.poll(() => activeTab(page)).toBe(t1)
    await chip.click()
    await expect.poll(() => activeTab(page)).toBe(tab)
    await page.waitForTimeout(500)
    expect(await tabOrder(page)).toHaveLength(3)

    expect(await startSession(pipeName, tab, randomUUID())).toEqual({ ok: true })
    await expect.poll(async () => (await marksOf(page))[tab]?.role).toBe('coordinator')
    await expect(chip).toHaveClass(/\brunning\b/)
    await expect.poll(async () => (await panelRows(page))[0]).toEqual({ id: tab, attached: false, label: 'Coordinator', to: null })
    expect(await chip.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0)
    await expect(refusal(page)).toHaveCount(0)
  } finally {
    await l.app.close()
  }
})

test('a tab closed before its session starts leaves no coordinator and no toast, and the next + Coordinator opens a new tab', async () => {
  const l = await coordApp(1, { settings: LEFT })
  const { page, pipeName, repo } = l
  try {
    const chip = chipOf(page, basename(repo))
    const before = await tabOrder(page)
    await chip.click()
    const first = await openedSince(page, before)
    await page.evaluate((id) => window.ct.closeTab(id), first)
    await expect.poll(() => tabOrder(page)).toEqual(before)
    expect(Object.values(await marksOf(page)).filter((m) => m.role === 'coordinator')).toEqual([])
    await expect(chip).toHaveClass(/\bstart\b/)
    await expect(refusal(page)).toHaveCount(0)

    await chip.click()
    const second = await openedSince(page, before)
    expect(second).not.toBe(first)
    expect(await startSession(pipeName, second, randomUUID())).toEqual({ ok: true })
    await expect.poll(async () => (await marksOf(page))[second]?.role).toBe('coordinator')
  } finally {
    await l.app.close()
  }
})

test('a coordinator made meanwhile refuses the new tab: it stays an ordinary tab, and the refusal shows as a toast', async () => {
  const l = await coordApp(1, { settings: LEFT })
  const { page, pipeName, tabs: [t0], repo } = l
  try {
    const before = await tabOrder(page)
    await chipOf(page, basename(repo)).click()
    const tab = await openedSince(page, before)
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await startSession(pipeName, tab, randomUUID())).toEqual({ ok: true })
    await expect(page.locator('.toast', { hasText: `The ${basename(repo)} project already has a coordinator:` })).toBeVisible()
    const marks = await marksOf(page)
    expect(marks[tab]).toBeUndefined()
    expect(marks[t0]).toMatchObject({ role: 'coordinator' })
    expect(await tabOrder(page)).toContain(tab)
    await expect(chipOf(page, basename(repo))).toHaveClass(/\brunning\b/)
  } finally {
    await l.app.close()
  }
})

test('a project of shell tabs only gets its coordinator the same way', async () => {
  const l = await coordApp(1, { settings: LEFT })
  const { page, pipeName, tabs: [t0] } = l
  try {
    const shellRepo = gitRepo()
    const shell = await openTabInFront(page, 'shell', shellRepo)
    const chip = chipOf(page, basename(shellRepo))
    await expect(chip).toHaveClass(/\bstart\b/)
    const before = await tabOrder(page)
    await chip.click()
    const tab = await openedSince(page, before)
    await expect.poll(async () => (await placeOf(page, tab))?.project.key).toBe((await placeOf(page, shell))!.project.key)
    // the project's first tab is the shell, behind another project's tab: the new tab stands before the shell, not first overall
    await expect.poll(() => tabOrder(page)).toEqual([t0, tab, shell])
    expect(await startSession(pipeName, tab, randomUUID())).toEqual({ ok: true })
    await expect.poll(async () => (await marksOf(page))[tab]?.role).toBe('coordinator')
    await expect(chip).toHaveClass(/\brunning\b/)
  } finally {
    await l.app.close()
  }
})

test('a session that starts before git has named the new tab\'s project still makes the tab the coordinator', async () => {
  const repo = gitRepo()
  // the tab is in a linked worktree: the main folder has no tab, so git has yet to answer for the new tab when its session comes
  const worktree = gitWorktree(repo, 'feat/early')
  const l = await coordApp(1, { settings: LEFT, repo: worktree })
  const { page, pipeName } = l
  try {
    const before = await tabOrder(page)
    await chipOf(page, basename(repo)).click()
    const tab = await openedSince(page, before)
    expect(await startSession(pipeName, tab, randomUUID())).toEqual({ ok: true })
    await expect.poll(async () => (await marksOf(page))[tab]?.role).toBe('coordinator')
    await expect(chipOf(page, basename(repo))).toHaveClass(/\brunning\b/)
  } finally {
    await l.app.close()
  }
})

test("+ Coordinator from a group whose first tab's folder is gone is refused, and no dead tab opens", async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/gone')
  const { app, page } = await launchApp({ settings: LEFT })
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    // the group's first tab: a shell in the linked worktree, which exits so that its folder can be removed
    const first = await openTabInFront(page, 'shell', worktree)
    await typeInTerminal(page, 'exit')
    await expect(tpRow(page, first)).toHaveClass(/\bexited\b/)
    await expect.poll(() => placeOf(page, first)).not.toBeNull()
    rmSync(worktree, { recursive: true, force: true })
    const before = await tabOrder(page)
    expect(await page.evaluate((id) => window.ct.coordStartCoordinator(id), first)).toEqual({ ok: false, error: `${basename(repo)}'s folder is gone, so no coordinator can start there.` })
    await page.waitForTimeout(500)
    expect(await tabOrder(page)).toEqual(before)
  } finally {
    await app.close()
  }
})

test("+ Coordinator from a group whose first tab's folder is gone opens in the project's main folder, when another of its tabs is open there", async () => {
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/gone-main')
  const { app, page } = await launchApp({ settings: LEFT })
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const first = await openTabInFront(page, 'shell', worktree)
    await typeInTerminal(page, 'exit')
    await expect(tpRow(page, first)).toHaveClass(/\bexited\b/)
    const main = await openTabInFront(page, 'shell', repo)
    // both tabs' places are known before the folder goes: the start looks for the project's folders the places name
    await expect.poll(() => placeOf(page, main)).not.toBeNull()
    await expect.poll(() => placeOf(page, first)).not.toBeNull()
    rmSync(worktree, { recursive: true, force: true })
    const before = await tabOrder(page)
    // the start waits for the new tab's session, so its answer is not awaited here
    void page.evaluate((id) => window.ct.coordStartCoordinator(id), first).catch(() => undefined)
    const tab = await openedSince(page, before)
    await expect.poll(async () => (await placeOf(page, tab))?.project.key).toBe((await placeOf(page, main))!.project.key)
    expect(await placeOf(page, tab)).toMatchObject({ worktree: null })
    await expect.poll(() => tabOrder(page)).toHaveLength(before.length + 1)
  } finally {
    await app.close()
  }
})

test("a narrow panel: the chip keeps its dot or its + without the word, and the project's name gives way first", async () => {
  const repo = gitRepo('acme-dashboard-reports')
  const l = await coordApp(1, { settings: LEFT, repo })
  const { page, tabs: [t0] } = l
  try {
    const otherRepo = gitRepo()
    await claudeTabIn(l, otherRepo)
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    const running = chipOf(page, basename(repo))
    const start = chipOf(page, basename(otherRepo))
    await expect(running).toHaveClass(/\brunning\b/)
    const head = groupNamed(page, basename(repo)).locator('.tp-group-head')
    /** whether the name is cut, and whether the chip and the count lie whole inside the header */
    const fit = (): Promise<{ cut: boolean; chip: boolean; count: boolean }> => head.evaluate((h) => {
      const name = h.querySelector<HTMLElement>('.tp-group-name')!
      const box = h.getBoundingClientRect()
      const inside = (el: Element): boolean => { const b = el.getBoundingClientRect(); return b.left >= box.left && b.right <= box.right }
      return { cut: name.scrollWidth > name.clientWidth, chip: inside(h.querySelector('.tp-coord-chip')!), count: inside(h.querySelector('.tp-group-count')!) }
    })
    // as wide as it starts: the name is cut already, and both chips keep their word
    await expect(running.locator('.tp-coord-chip-word')).toBeVisible()
    await expect(start.locator('.tp-coord-chip-word')).toBeVisible()
    expect(await fit()).toEqual({ cut: true, chip: true, count: true })

    await panelSettled(page)
    const handle = (await page.locator('#tabpanel .tp-resize').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 1000, handle.y + handle.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => page.locator('#tabpanel').evaluate((el) => el.getBoundingClientRect().width)).toBe(110)
    for (const chip of [running, start]) {
      await expect(chip.locator('.tp-coord-chip-word')).toBeHidden()
      await expect(chip.locator('.tp-coord-chip-mark')).toBeVisible()
    }
    // the word is gone, so the chip is named for what it does: its label, not a tooltip
    await expect(running).toHaveAccessibleName('Coordinator')
    await expect(start).toHaveAccessibleName('Start a coordinator')
    expect(await running.getAttribute('title')).toBeNull()
    expect(await start.getAttribute('title')).toBeNull()
    expect(await fit()).toEqual({ cut: true, chip: true, count: true })
  } finally {
    await l.app.close()
  }
})

test("with the tabs at the top there is no chip: the coordinator's tab keeps its mark", async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    await claudeTabIn(l, gitRepo())
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    await expect(page.locator('#tabbar .tb-group-label')).toHaveCount(2)
    await expect(page.locator(`#tabbar .tab[data-tab-id="${t0}"] .tab-coord`)).toHaveText('Coordinator')
    await expect(page.locator('.tp-coord-chip')).toHaveCount(0)
  } finally {
    await l.app.close()
  }
})

test("a paired device's groups have no chip; this device's project has its own", async () => {
  test.setTimeout(180_000)
  const { a, coordTab } = await coordDevices({ a: { settings: LEFT } })
  const section = a.page.locator('#tabpanel .tp-section')
  await expect(section.locator('.tp-group')).not.toHaveCount(0, SLOW)
  await expect(a.page.locator('#tabpanel .tp-list > .tp-group .tp-coord-chip.running')).toHaveCount(1)
  await expect(section.locator('.tp-coord-chip')).toHaveCount(0)
  expect((await marksOf(a.page))[coordTab]).toMatchObject({ role: 'coordinator' })
})
