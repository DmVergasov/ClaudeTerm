import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { isWithin } from '../../src/main/path-key'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { IPC } from '../../src/shared/ipc'
import type { TaskList } from '../../src/shared/task-list'
import { PEER_ORIGIN, turnPromptLine } from '../fixtures/transcript'
import { LIST_TIMEOUT_MS, MAX_TRANSFER_BYTES, MAX_TRANSFER_FILES, REMOTE_COPY } from '../../src/shared/remote'
import { LINUX, MAC, WIN } from '../fixtures/platform'
import { bellCommand, bufferText, FAKE_CLAUDE_SETTINGS, gitRepo, gitWorktree, KEYS, keepingClipboard, PNG_1x1, processAlive, PROMPT, TEST_SHELL, typeInTerminal, writeTranscript } from './helpers'
import { closePaired, type Device, openShell, pairApps, pairedApps, relaunch, setWindowSize, SLOW, startApps, termSize } from './device-pair'

test.afterEach(closePaired)

const tabIdsOf = (d: Device) => d.page.evaluate(() => window.__ct!.tabIds())
/** how many times the window has asked the devices for their lists (the account menu and the new-tab menu ask) */
const listAsks = (d: Device) => d.page.evaluate(() => window.__ct!.choiceAsks!())

/** records the tabs this window opens from now on: a tab of this device's own has no remote part */
const recordOpened = (d: Device) => d.page.evaluate(() => {
  const w = window as unknown as { opened: { id: string; remote: boolean }[] }
  w.opened = []
  window.ct.onTabOpened((t) => { w.opened.push({ id: t.id, remote: t.remote !== undefined }) })
})
/** the ids of the tabs of this device's own that the window opened since recordOpened */
const ownTabsOpened = (d: Device) => d.page.evaluate(() => (window as unknown as { opened: { id: string; remote: boolean }[] }).opened.filter((t) => !t.remote).map((t) => t.id))

/** the numbers a tab's output printed (L<n> lines): the echoed command line does not match, each output line does */
const printedNumbers = async (d: Device, id: string): Promise<number[]> => {
  const lines = (await bufferText(d.page, id)).split('\n').map((line) => line.trimEnd())
  return lines.flatMap((line) => {
    const m = /^L(\d+)$/.exec(line)
    return m ? [Number(m[1])] : []
  })
}
/** the highest number printed so far, 0 for none */
const lastPrinted = async (d: Device, id: string): Promise<number> => Math.max(0, ...(await printedNumbers(d, id)))

/** B's settings with the tabs on the left, for pairedApps */
const LEFT_SETTINGS = { ...FAKE_CLAUDE_SETTINGS, tabs: { position: 'left' } }
const LEFT_B = { b: { settings: LEFT_SETTINGS } }

/** a git repository in a folder called `name`, on branch main: the panel names a project by its folder */
function namedRepo(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ct-named-')), name)
  renameSync(gitRepo(), dir)
  execFileSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  return dir
}

/** opens a shell tab in a folder on d: its id */
async function openIn(d: Device, cwd: string): Promise<string> {
  const tab = await d.page.evaluate((folder) => window.ct.openTab({ kind: 'shell', cwd: folder }), cwd)
  if (!tab) throw new Error('the shell tab did not open')
  return tab.id
}

const front = (d: Device) => d.page.evaluate(() => window.__ct!.activeTabId())
/** a tab's row in B's left panel: in its own group, or in a device section */
const rowIn = (d: Device, id: string): Locator => d.page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"]`)
/** the header of another device's section in B's left panel */
const deviceHead = (d: Device, of: Device): Locator => d.page.locator(`#tabpanel .tp-device[data-device-id="${of.id}"]`)
/** another device's whole section in B's left panel: its header and what is under it */
const sectionOfDevice = (d: Device, of: Device): Locator => d.page.locator('#tabpanel .tp-section', { has: d.page.locator(`.tp-device[data-device-id="${of.id}"]`) })
/** the project group of a section with that name */
const groupNamedIn = (d: Device, section: Locator, name: string): Locator => section.locator('.tp-group').filter({ has: d.page.locator('.tp-group-name', { hasText: new RegExp(`^${name}$`, 'i') }) })
/** the ids of the rows in a section, in the order the panel shows them */
const rowIdsIn = (section: Locator): Promise<string[]> => section.locator('.tp-tab').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tabId!))

/** the tab orders this window sends to main from now on (test runs): a listener in main keeps them */
async function recordReorders(d: Device): Promise<void> {
  await d.app.evaluate(({ ipcMain }) => {
    const sent: string[][] = []
    ;(globalThis as { reorders?: string[][] }).reorders = sent
    ipcMain.on('tabs:reorder', (_e, ids: string[]) => { sent.push(ids) })
  })
}
const reorderSent = (d: Device): Promise<string[][]> => d.app.evaluate(() => (globalThis as { reorders?: string[][] }).reorders ?? [])

/** a press on the panel's right edge, a move far to the left, a release: the panel takes its narrowest width */
async function narrowPanel(page: Page): Promise<void> {
  const box = (await page.locator('#tabpanel .tp-resize').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 1000, y, { steps: 8 })
  await page.mouse.up()
}

test('a tab opened on A appears in B\'s window; typing on B runs on A and shows on both; closing it from B closes it on A', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  await recordOpened(b)
  const tab = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(tab.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(PROMPT)
  await typeInTerminal(b.page, 'echo from-laptop')
  await expect.poll(() => bufferText(a.page, tab.id), SLOW).toMatch(/from-laptop[\s\S]*from-laptop/)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(/from-laptop[\s\S]*from-laptop/)
  await b.page.evaluate((id) => window.ct.closeTab(id), tab.id)
  await expect.poll(() => tabIdsOf(a), SLOW).not.toContain(tab.id)
  await expect.poll(() => tabIdsOf(b), SLOW).not.toContain(tab.id)

  // B closes its own last tab while A's tabs are there: B's window stays, and one of A's tabs comes to the front
  const other = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(other.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), b.firstTab)
  await b.page.evaluate((id) => window.ct.closeTab(id), b.firstTab)
  await expect.poll(() => tabIdsOf(b), SLOW).not.toContain(b.firstTab)
  expect(b.app.windows()).toHaveLength(1)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).not.toBeNull()
  expect([a.firstTab, other.id]).toContain(await b.page.evaluate(() => window.__ct!.activeTabId()))
  expect(b.app.windows()).toHaveLength(1)

  // A quits and starts again with its restored tabs; B lists them again, and opens no tab of its own meanwhile.
  // A lists B's own tabs too, so "every tab of B is one of A's" would not see one: B's own tabs are the ones without a remote part
  await relaunch(a)
  await expect.poll(async () => {
    const mine = await tabIdsOf(a)
    const seen = await tabIdsOf(b)
    return mine.length > 0 && mine.every((id) => seen.includes(id))
  }, SLOW).toBe(true)
  expect(await ownTabsOpened(b)).toEqual([])
})

test('a tab that printed before the devices paired shows that output on the other device', async () => {
  test.setTimeout(180_000)
  const { a, b } = await startApps()
  const id = a.firstTab
  await expect.poll(() => bufferText(a.page, id), SLOW).toMatch(PROMPT)
  await typeInTerminal(a.page, 'echo before-pairing')
  await expect.poll(() => bufferText(a.page, id), SLOW).toMatch(/before-pairing[\s\S]*before-pairing/)
  await pairApps(a, b)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(id)
  await b.page.evaluate((tabId) => window.ct.activateTab(tabId), id)
  await expect.poll(() => bufferText(b.page, id), SLOW).toMatch(/before-pairing[\s\S]*before-pairing/)
})

test('the terminal takes the size of the device last typed into; elsewhere it keeps that size', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  await setWindowSize(a, 1300, 850)
  await setWindowSize(b, 900, 600)
  const tab = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(tab.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(PROMPT)
  await typeInTerminal(b.page, 'echo from-laptop')
  await expect.poll(async () => JSON.stringify(await termSize(a.page, tab.id)), SLOW).toBe(JSON.stringify(await termSize(b.page, tab.id)))
  const bSize = (await termSize(b.page, tab.id))!
  await expect(a.page.locator('.terminal-host.fixed:visible')).toHaveCount(1, SLOW)
  await typeInTerminal(a.page, 'echo from-studio')
  await expect.poll(async () => (await termSize(b.page, tab.id))!.cols, SLOW).toBeGreaterThan(bSize.cols)
  expect(await termSize(b.page, tab.id)).toEqual(await termSize(a.page, tab.id))
  await expect(b.page.locator('.terminal-host.fixed:visible')).toHaveCount(1, SLOW)
})

test('output printed while the devices pair is neither lost nor doubled', async () => {
  test.setTimeout(240_000)
  const { a, b } = await startApps()
  const id = a.firstTab
  const count = 1500
  const expected = Array.from({ length: count }, (_, i) => i + 1)
  await expect.poll(() => bufferText(a.page, id), SLOW).toMatch(PROMPT)
  await typeInTerminal(a.page, WIN
    ? `1..${count} | % { "L$_"; Start-Sleep -Milliseconds 20 }`
    : `for i in $(seq 1 ${count}); do echo L$i; if [ $((i % 10)) -eq 0 ]; then sleep 0.2; fi; done`)
  // the loop runs before the pairing starts, and is still running after B has attached and shown the tab
  await expect.poll(() => lastPrinted(a, id), SLOW).toBeGreaterThan(0)
  await pairApps(a, b)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(id)
  await b.page.evaluate((tabId) => window.ct.activateTab(tabId), id)
  expect(await lastPrinted(a, id)).toBeLessThan(count)

  await expect.poll(async () => {
    const [onA, onB] = await Promise.all([printedNumbers(a, id), printedNumbers(b, id)])
    return `${onA.at(-1)}/${onB.at(-1)}`
  }, { timeout: 120_000 }).toBe(`${count}/${count}`)
  const onA = await printedNumbers(a, id)
  const onB = await printedNumbers(b, id)
  expect(onA).toEqual(expected)
  expect(onB).toEqual(onA)
})

test("another device's tabs show after this device's, under a chip with its name; a click folds them", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(); const tab = await openShell(a)
  const chip = b.page.locator('.tab-group-chip', { hasText: 'Studio' })
  await expect(b.page.locator(`.tab.remote[data-tab-id="${tab.id}"]`)).toBeVisible(SLOW)
  expect(await b.page.evaluate(() => [...document.querySelectorAll('#tabbar .tab, #tabbar .tab-group-chip')].findIndex((e) => e.classList.contains('tab-group-chip')))).toBe(1)
  expect(await b.page.locator(`[data-tab-id="${tab.id}"]`).getAttribute('title')).toContain(`\nStudio: ${a.work}`)   // REMOTE_COPY.tabTooltip
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(PROMPT)
  await chip.click(); await expect(b.page.locator(`[data-tab-id="${tab.id}"]`)).toHaveCount(0); await expect(chip.locator('.tab-group-count')).toHaveText('2')
  // R4: the tab in front was in the folded group, so this device's first tab comes to the front
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(b.firstTab)
  await chip.click(); await expect(b.page.locator(`[data-tab-id="${tab.id}"]`)).toBeVisible()
})
test("B opens a Claude tab on A from the + menu: it runs on A in A's default folder and is in front on B", async () => {
  test.setTimeout(180_000)
  const home = mkdtempSync(join(tmpdir(), 'ct-a-home-'))
  const { a, b } = await pairedApps({ a: { settings: { ...FAKE_CLAUDE_SETTINGS, defaultFolder: home } } })
  const before = await tabIdsOf(b)
  await b.page.locator('.tab-menu').click()
  // the device's own Claude Code entry: the first one after the device's name, which the menu draws disabled above its entries
  await b.page.locator('.menu-item.disabled', { hasText: /^Studio$/ })
    .locator('xpath=following::div[contains(concat(" ", normalize-space(@class), " "), " menu-item ") and normalize-space(.)="Claude Code"][1]')
    .click(SLOW)
  const newIds = async () => (await tabIdsOf(b)).filter((x) => !before.includes(x))
  await expect.poll(newIds, SLOW).toHaveLength(1)
  const id = (await newIds())[0]
  await expect.poll(() => tabIdsOf(a), SLOW).toContain(id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(id)
  await expect.poll(() => a.page.locator(`[data-tab-id="${id}"]`).getAttribute('title'), SLOW).toContain(home)
  await expect.poll(() => bufferText(b.page, id), SLOW).toContain('fake-claude')
})

test("the chip's menu opens a shell tab on that device", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const chip = b.page.locator('.tab-group-chip', { hasText: 'Studio' })
  await expect(chip).toBeVisible(SLOW)
  // the profiles of Studio, as its answer to the lists gives them
  const studioProfile = async () => (await b.page.evaluate(() => window.ct.listDeviceChoices())).devices.find((d) => d.name === 'Studio')?.value?.profiles[0] ?? null
  await expect.poll(studioProfile, SLOW).not.toBeNull()
  const profile = (await studioProfile())!
  const before = await tabIdsOf(b)
  await chip.click({ button: 'right' })
  await b.page.locator('.menu-item', { hasText: REMOTE_COPY.newProfileTab(profile) }).click(SLOW)
  const newIds = async () => (await tabIdsOf(b)).filter((x) => !before.includes(x))
  await expect.poll(newIds, SLOW).toHaveLength(1)
  const id = (await newIds())[0]
  await expect.poll(() => tabIdsOf(a), SLOW).toContain(id)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${id}"] .tab-icon`)).toHaveText('>', SLOW) // a shell tab
})

test("with A's tab in front, B's own Claude Code entry opens a tab on B in B's default folder, and so does the key", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const tab = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(tab.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(tab.id)
  const before = await tabIdsOf(b)
  await b.page.locator('.tab-menu').click()
  await b.page.locator('.menu-item', { hasText: /^Claude Code$/ }).nth(0).click(SLOW) // the first one is this device's
  const newIds = async (prior: string[]) => (await tabIdsOf(b)).filter((x) => !prior.includes(x))
  await expect.poll(() => newIds(before), SLOW).toHaveLength(1)
  const id = (await newIds(before))[0]
  // a tab of this device, not a remote one: it runs on B, in B's default folder
  await expect(b.page.locator(`.tab:not(.remote)[data-tab-id="${id}"]`)).toHaveCount(1)
  await expect.poll(() => b.page.locator(`[data-tab-id="${id}"]`).getAttribute('title'), SLOW).toContain(b.work)
  await b.page.evaluate((x) => window.ct.activateTab(x), tab.id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(tab.id)
  const beforeKey = await tabIdsOf(b)
  await b.page.keyboard.press(KEYS.newClaudeTab)
  const keyIds = async () => (await tabIdsOf(b)).filter((x) => !beforeKey.includes(x))
  await expect.poll(keyIds, SLOW).toHaveLength(1)
  const keyId = (await keyIds())[0]
  await expect.poll(() => b.page.locator(`[data-tab-id="${keyId}"]`).getAttribute('title'), SLOW).toContain(b.work)
})

test('a tab picked while a new tab on another device is being opened stays in front', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  // the request and the pick go out together: the pick reaches this device first, the answer to the request comes after
  const id = await b.page.evaluate(([device, first]) => {
    const opened = window.ct.openRemoteTab(device, 'shell', null, null)
    window.ct.activateTab(first)
    return opened
  }, [a.id, b.firstTab] as [string, string])
  expect(id).not.toBeNull()
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(id!)
  // the answer has arrived: the window still shows the tab that was picked
  expect(await b.page.evaluate(() => window.__ct!.activeTabId())).toBe(b.firstTab)
})

test('an open + menu gains a device\'s new account in the same place when the answers change', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  await b.page.locator('.tab-menu').click()
  const menu = b.page.locator('.menu')
  // the device's own Claude Code entry: the first one after the device's name, as the other + menu tests find it
  await expect(menu.locator('.menu-item.disabled', { hasText: /^Studio$/ })
    .locator('xpath=following::div[contains(concat(" ", normalize-space(@class), " "), " menu-item ") and normalize-space(.)="Claude Code"][1]')).toBeVisible(SLOW)
  const before = await menu.boundingBox()
  expect(await a.page.evaluate(() => window.ct.addAccount('Work', 'e2e-token-work-0000000001'))).toEqual({ ok: true })
  // asking for the lists refreshes Studio's answer while the menu stays open; the answer draws the new entry in the menu on screen
  await b.page.evaluate(() => window.ct.listDeviceChoices())
  await expect(menu.locator('.menu-item', { hasText: 'Claude Code — Work' })).toBeVisible(SLOW)
  const after = await menu.boundingBox()
  expect(after!.x).toBe(before!.x)
  expect(after!.y).toBe(before!.y)
})

test("a remote Claude tab's Continue as lists its device's accounts; its status bar and title name the account as its device does", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const id = (await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), a.work))!.id
  await expect(b.page.locator(`.tab.remote[data-tab-id="${id}"]`)).toBeVisible(SLOW)
  await b.page.evaluate((x) => window.ct.activateTab(x), id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(id)
  // Studio has no extra account: its tab names none, in the status bar and the title
  await expect(b.page.locator('#statusbar .status-account')).toHaveCount(0)
  await expect(b.page).not.toHaveTitle(/Main account/)
  // Studio gets an extra account: the tab's device names its main account
  expect(await a.page.evaluate(() => window.ct.addAccount('Work', 'e2e-token-work-0000000001'))).toEqual({ ok: true })
  await expect.poll(async () => ((await b.page.evaluate(() => window.ct.listDeviceChoices())).devices.find((d) => d.name === 'Studio')?.value?.accounts ?? []).map((x) => x.name), SLOW).toContain('Work')
  await expect(b.page.locator('#statusbar .status-account')).toHaveText('Main account', SLOW)
  // the title leaves the main account out, as the device's own title does, even while its device has extra accounts
  await expect(b.page).not.toHaveTitle(/Main account/)
  // Continue as Work switches the tab on Studio, and both windows then name Work
  await b.page.locator(`.tab.remote[data-tab-id="${id}"]`).click({ button: 'right' })
  await b.page.locator('.menu-item', { hasText: 'Continue as Work' }).click(SLOW)
  await expect(b.page.locator('#statusbar .status-account')).toHaveText('Work', SLOW)
  await expect(b.page).toHaveTitle(/ — Work — ClaudeTerm$/)
  await a.page.evaluate((x) => window.ct.activateTab(x), id)
  await expect(a.page.locator('#statusbar .status-account')).toHaveText('Work', SLOW)
})

test("a local tab's account menu asks no device for its lists; a remote tab's account menu asks its device", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const id = (await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), a.work))!.id
  await expect(b.page.locator(`.tab.remote[data-tab-id="${id}"]`)).toBeVisible(SLOW)
  expect(await a.page.evaluate(() => window.ct.addAccount('Work', 'e2e-token-work-0000000001'))).toEqual({ ok: true })
  await a.page.evaluate((x) => window.ct.activateTab(x), id)
  await expect(a.page.locator('#statusbar .status-account')).toHaveText('Main account', SLOW)
  // this machine's own accounts need no answer from another device
  const asksOnA = await listAsks(a)
  await a.page.locator('#statusbar .status-account').click()
  await expect(a.page.locator('.menu-item', { hasText: 'Continue as Work' })).toBeVisible(SLOW)
  expect(await listAsks(a)).toBe(asksOnA)
  // a remote tab's accounts are its device's: the window asks it first
  await b.page.evaluate((x) => window.ct.activateTab(x), id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(id)
  await expect.poll(async () => ((await b.page.evaluate(() => window.ct.listDeviceChoices())).devices.find((d) => d.name === 'Studio')?.value?.accounts ?? []).map((x) => x.name), SLOW).toContain('Work')
  await expect(b.page.locator('#statusbar .status-account')).toHaveText('Main account', SLOW)
  const asksOnB = await listAsks(b)
  await b.page.locator('#statusbar .status-account').click()
  await expect(b.page.locator('.menu-item', { hasText: 'Continue as Work' })).toBeVisible(SLOW)
  expect(await listAsks(b)).toBeGreaterThan(asksOnB)
})

test('the chip menu of an offline device shows only Fold', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  await a.app.close()
  const chip = b.page.locator('.tab-group-chip.offline', { hasText: 'Studio' })
  await expect(chip).toBeVisible(SLOW)
  await chip.click({ button: 'right' })
  await expect(b.page.locator('.menu .menu-item')).toHaveText([REMOTE_COPY.fold], SLOW)
})

test('a remote tab is dragged inside its group only', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(); const second = await openShell(a)
  await recordReorders(b)
  const first = (await a.page.evaluate(() => window.__ct!.tabIds())).find((id) => id !== second.id)!
  await expect(b.page.locator('.tab.remote')).toHaveCount(2, SLOW)
  // HTML5 drag through dispatched events (deterministic on every system): dragstart on one tab, dragover and drop on the other
  const drag = (from: string, to: string) => b.page.evaluate(([f, t]) => {
    const el = (id: string) => document.querySelector(`[data-tab-id="${id}"]`)!
    const data = new DataTransfer()
    el(f).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data })); el(t).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    el(t).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); el(f).dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
  }, [from, to])
  const barOrder = () => b.page.evaluate(() => [...document.querySelectorAll('#tabbar .tab')].map((e) => (e as HTMLElement).dataset.tabId))
  expect(await barOrder()).toEqual([b.firstTab, first, second.id]); await drag(second.id, first); await expect.poll(barOrder).toEqual([b.firstTab, second.id, first])
  await drag(first, b.firstTab); await drag(b.firstTab, second.id)
  expect(await barOrder()).toEqual([b.firstTab, second.id, first])   // nothing moved across groups, either way
  // no remote id reaches main's tab order: this device's order is the only one main keeps
  expect((await reorderSent(b)).flat().filter((id) => id === first || id === second.id)).toEqual([])
})
test('stopping A dims its group on B and B cannot type into it; starting A again brings it back', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(); const tab = await openShell(a)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${tab.id}"]`)).toBeVisible(SLOW)
  await a.app.close()
  await expect(b.page.locator('.tab-group-chip.offline', { hasText: 'Studio · offline' })).toBeVisible(SLOW)
  await expect(b.page.locator(`.tab.remote.dim[data-tab-id="${tab.id}"]`)).toBeVisible()
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id); await typeInTerminal(b.page, 'echo lost')
  expect(await b.page.evaluate((id) => window.__ct!.ptyInput!(id), tab.id)).not.toContain('lost')
  await relaunch(a)
  await expect(b.page.locator('.tab-group-chip.offline')).toHaveCount(0, SLOW)
  await expect(b.page.locator(`[data-tab-id="${tab.id}"]`)).toHaveCount(0, SLOW)   // that tab is gone on A: A started with a new one
  await expect(b.page.locator('.tab.remote')).toHaveCount(1, SLOW)
})
test("B closes its own last tab while A's tab is in front there; A relaunches and one of B's tabs comes to the front", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const first = await openShell(a); await openShell(a)
  // A's own first tab, which pairing showed on B, and the two opened here
  await expect(b.page.locator('.tab.remote')).toHaveCount(3, SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), first.id)
  await b.page.evaluate((id) => window.ct.closeTab(id), b.firstTab)
  await expect(b.page.locator(`[data-tab-id="${b.firstTab}"]`)).toHaveCount(0, SLOW)
  // R8: A's two old tabs close on B in one batch, and its new tab arrives
  await relaunch(a)
  await expect.poll(async () => {
    const active = await b.page.evaluate(() => window.__ct!.activeTabId())
    return active !== null && (await tabIdsOf(b)).includes(active)
  }, SLOW).toBe(true)
  await expect(b.page.locator('.terminal-host:visible')).toHaveCount(1, SLOW)
})

test('a Send into a tab on an offline device writes nothing and says why', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const claude = await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), a.work)
  if (!claude) throw new Error('the Claude tab did not open')
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude.id}"]`)).toBeVisible(SLOW)
  await a.app.close()
  await expect(b.page.locator('.tab-group-chip.offline')).toBeVisible(SLOW)
  // Send (the Changes panel and the note use it) goes through the same guard as typing: nothing is logged or written
  const sendText = (id: string, text: string) => b.page.evaluate(([i, t]) => window.__ct!.sendText!(i, t), [id, text] as [string, string])
  expect(await sendText(claude.id, 'lost')).toBe(REMOTE_COPY.deviceOffline('Studio'))
  expect(await b.page.evaluate((id) => window.__ct!.ptyInput!(id), claude.id)).toBe('')
})

test("opening Changes on an offline device's tab says nothing; the ⟳ button still says the device is offline", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps({ a: { args: ['--claude', gitRepo()] } })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => front(b), SLOW).toBe(claude)
  await a.app.close()
  await expect(b.page.locator('.tab-group-chip.offline')).toBeVisible(SLOW)

  // opening Changes refreshes in the background: an offline device is not asked, so nothing is toasted
  await b.page.keyboard.press(KEYS.changes)
  await expect(b.page.locator('.review-refresh')).toBeVisible(SLOW)
  // the marker: the button asks, and its toast comes after any toast the open would have made (calls are FIFO)
  await b.page.locator('.review-refresh').click()
  await expect(b.page.locator('.toast', { hasText: REMOTE_COPY.deviceOffline('Studio') })).toHaveCount(1, SLOW)
  await expect(b.page.locator('.toast')).toHaveCount(1)
})

test('⟳ on the tab of a device that went offline before any review came says the device is offline', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps({ a: { args: ['--claude', gitRepo()] } })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  // B does not activate the tab before A closes: it never attaches, so no review is pushed to B
  await a.app.close()
  await expect(b.page.locator('.tab-group-chip.offline')).toBeVisible(SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => front(b), SLOW).toBe(claude)

  await b.page.keyboard.press(KEYS.changes)
  await expect(b.page.locator('.review-refresh')).toBeVisible(SLOW)
  // the panel has no review for the tab, so it lists no file
  await expect(b.page.locator('.review-files .review-file')).toHaveCount(0)
  await b.page.locator('.review-refresh').click()
  await expect(b.page.locator('.toast', { hasText: REMOTE_COPY.deviceOffline('Studio') })).toHaveCount(1, SLOW)
  await expect(b.page.locator('.toast')).toHaveCount(1)
})

test('next, previous and go-to-tab walk this device\'s tabs and the unfolded groups, not a folded one', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const second = await openShell(a)
  const first = (await a.page.evaluate(() => window.__ct!.tabIds())).find((id) => id !== second.id)!
  await expect(b.page.locator('.tab.remote')).toHaveCount(2, SLOW)
  const front = () => b.page.evaluate(() => window.__ct!.activeTabId())
  const press = (key: string) => b.page.keyboard.press(key)
  const chip = b.page.locator('.tab-group-chip', { hasText: 'Studio' })
  await b.page.evaluate((id) => window.ct.activateTab(id), b.firstTab)
  await expect.poll(front, SLOW).toBe(b.firstTab)

  const goTo = (n: number) => press(MAC ? `Meta+Digit${n}` : `Control+Alt+Digit${n}`)

  // folded: this device's tab is the only one shown, so Next and go to tab 3 keep it in front. The check comes after
  // the unfold, so a key press that moved the front onto a folded tab shows up as a wrong front
  await chip.click(); await expect(b.page.locator('.tab.remote')).toHaveCount(0)
  await press(KEYS.nextTab)
  await goTo(3)
  await chip.click(); await expect(b.page.locator('.tab.remote')).toHaveCount(2)
  await expect.poll(front, SLOW).toBe(b.firstTab)

  // unfolded: Next walks into the group in the bar's order, then goes on to its second tab; Previous comes back
  await press(KEYS.nextTab)
  await expect.poll(front, SLOW).toBe(first)
  await press(KEYS.nextTab)
  await expect.poll(front, SLOW).toBe(second.id)
  await press(MAC ? 'Meta+Shift+BracketLeft' : 'Control+Shift+Tab')
  await expect.poll(front, SLOW).toBe(first)

  // go to tab 1 is this device's own tab, go to tab 2 the group's first tab; a folded group is not counted
  await goTo(1)
  await expect.poll(front, SLOW).toBe(b.firstTab)
  await chip.click(); await expect(b.page.locator('.tab.remote')).toHaveCount(0)
  await goTo(2)
  await chip.click(); await expect(b.page.locator('.tab.remote')).toHaveCount(2)
  await expect.poll(front, SLOW).toBe(b.firstTab)
  await goTo(2)
  await expect.poll(front, SLOW).toBe(first)
})

test("an image card of A's Claude tab shows on B, served from A; B copies it and removes it, and the local-only actions are hidden", { tag: '@alone' }, async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] } })
  // A's Claude tab must not be in front on A: its window marks the images of the tab in front as seen at once, and B would show no badge
  const shell = await openShell(a)
  await expect.poll(() => a.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(shell.id)
  const file = join(work, 'shot.png')
  writeFileSync(file, PNG_1x1)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'show_image', tabId: a.firstTab, path: file, caption: null })).toEqual({ ok: true })

  // the badge of the tab on B counts the unseen card before B opens the tab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${a.firstTab}"] .tab-images`)).toHaveText('🖼1', SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), a.firstTab)
  await expect.poll(() => b.page.evaluate(() => (document.querySelector('#image-panel img') as HTMLImageElement | null)?.naturalWidth ?? 0), SLOW).toBe(1)
  // a new image opens the panel by itself; Media is opened by its key only when it is still closed
  if (await b.page.locator('#image-panel').evaluate((el) => el.classList.contains('collapsed'))) await b.page.keyboard.press(KEYS.images)
  await expect(b.page.locator('#image-panel')).not.toHaveClass(/collapsed/)
  const card = b.page.locator('#image-panel .card')
  await expect(card).toHaveCount(1)

  // only the actions the other device can do: no Open in viewer, no Show in Explorer
  await card.click({ button: 'right' })
  await expect(b.page.locator('.menu-item', { hasText: 'Show in Explorer' })).toHaveCount(0)
  await expect(b.page.locator('.menu-item', { hasText: 'Open in viewer' })).toHaveCount(0)
  await expect(b.page.locator('.menu-item', { hasText: 'Copy path' })).toBeVisible()

  // Copy image puts the card's picture on the clipboard of B's machine
  await keepingClipboard(b.app, async () => {
    await b.page.locator('.menu-item', { hasText: 'Copy image' }).click()
    // the PNG's size is in its IHDR chunk: width at byte 16, height at byte 20
    await expect.poll(() => b.app.evaluate(async ({ clipboard }) => {
      const png = (await clipboard.read()).find((item) => item.types.includes('image/png'))
      if (!png) return null
      const bytes = Buffer.from(await (await png.getType('image/png')).arrayBuffer())
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    }), SLOW).toEqual({ width: 1, height: 1 })
  })

  // Remove from panel removes the card on A too: A's window holds no image, and B's panel is empty
  await card.click({ button: 'right' })
  await b.page.locator('.menu-item', { hasText: 'Remove from panel' }).click()
  await expect(b.page.locator('#image-panel .card')).toHaveCount(0, SLOW)
  await expect.poll(() => a.page.evaluate(() => window.__ct!.images!().length), SLOW).toBe(0)
})

test("an image pasted into A's tab on B is copied to A and its path typed there, never as the paste key", { tag: '@alone' }, async () => {
  test.setTimeout(180_000)
  // on Windows B's PowerShell works, so a local paste there would send Claude Code's paste key (as in keys.spec.ts)
  const { a, b } = await pairedApps({ b: { env: WIN ? { CLAUDETERM_TEST_POWERSHELL: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe') } : {} } })
  const tab = await openShell(a)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${tab.id}"]`)).toHaveCount(1, SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(tab.id)
  // the PNG goes on B's desktop clipboard, which keepingClipboard gives back afterwards
  await keepingClipboard(b.app, async () => {
    await b.app.evaluate(async ({ clipboard, ClipboardItem }, png) => {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    }, [...PNG_1x1])
    await b.page.locator('.terminal-host:visible .xterm').click()
    await b.page.keyboard.press(KEYS.paste)
    // what B typed, without the bracketed-paste markers a bash with bracketed paste wraps a paste in (Ubuntu's bash 5.2)
    const typed = () => b.page.evaluate((id) => window.__ct!.ptyInput!(id).replace(/\x1b\[(?:20[01]~|[IO])/g, ''), tab.id)
    // B's shell quotes the path with single quotes (PowerShell and bash both do), as A's tab's shell is told to
    await expect.poll(typed, SLOW).toMatch(/'[^']+'/)
    const sent = await typed()
    const path = /'([^']+)'/.exec(sent)![1]
    expect(sent).toContain(`'${path}'`)
    expect(sent).not.toContain('\x1bv')
    expect(sent).not.toContain('\x16')
    // the copy is a PNG file under A's received folder, as big as the image (its IHDR), and A's shell shows its path
    expect(isWithin(a.received, path)).toBe(true)
    const png = readFileSync(path)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1, 1])
    await expect.poll(() => bufferText(a.page, tab.id), SLOW).toContain(basename(path))
  })
})

// Claude Code's own image-paste key: Ctrl+V on macOS, Alt+V on Windows (Ctrl+V is smart paste on Linux already)
const CLAUDE_IMAGE_KEY = MAC ? 'Control+KeyV' : 'Alt+KeyV'
const CLAUDE_IMAGE_INPUT = MAC ? '\x16' : '\x1bv'

test("Claude Code's image-paste key in another device's Claude tab copies B's clipboard image to A and types its path there", { tag: '@alone' }, async () => {
  test.skip(LINUX, 'Ctrl+V is smart paste on Linux')
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] } })
  await expect(b.page.locator(`.tab.remote[data-tab-id="${a.firstTab}"]`)).toHaveCount(1, SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), a.firstTab)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(a.firstTab)
  await keepingClipboard(b.app, async () => {
    await b.app.evaluate(async ({ clipboard, ClipboardItem }, png) => {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    }, [...PNG_1x1])
    await b.page.locator('.terminal-host:visible .xterm').click()
    await b.page.keyboard.press(CLAUDE_IMAGE_KEY)
    // what B typed into A's tab, without the bracketed-paste markers
    const typed = () => b.page.evaluate((id) => window.__ct!.ptyInput!(id).replace(/\x1b\[(?:20[01]~|[IO])/g, ''), a.firstTab)
    // a Claude tab takes the path in double quotes, as the prompt of Claude Code reads them (a shell tab gets its shell's quotes)
    await expect.poll(typed, SLOW).toMatch(/"[^"]+"/)
    const sent = await typed()
    const path = /"([^"]+)"/.exec(sent)![1]
    expect(sent).toContain(`"${path}"`)
    // the key itself is not sent: A's Claude Code would read A's clipboard, not this device's image
    expect(sent).not.toContain('\x16')
    expect(sent).not.toContain('\x1bv')
    expect(isWithin(a.received, path)).toBe(true)
    const png = readFileSync(path)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1, 1])
  })
})

test("with text only on B's clipboard, Claude Code's image-paste key reaches A's Claude tab as that key", { tag: '@alone' }, async () => {
  test.skip(LINUX, 'Ctrl+V is smart paste on Linux')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] } })
  await expect(b.page.locator(`.tab.remote[data-tab-id="${a.firstTab}"]`)).toHaveCount(1, SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), a.firstTab)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(a.firstTab)
  await keepingClipboard(b.app, async () => {
    await b.app.evaluate(({ clipboard }) => clipboard.writeText('plain text'))
    await b.page.locator('.terminal-host:visible .xterm').click()
    await b.page.keyboard.press(CLAUDE_IMAGE_KEY)
    await expect.poll(() => b.page.evaluate((id) => window.__ct!.ptyInput!(id), a.firstTab), SLOW).toContain(CLAUDE_IMAGE_INPUT)
  })
})

test("dropped files are copied to A's tab device; a folder, too many files, more than 50 MB in all, or a second copy while one runs is refused with a toast", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const tab = await openShell(a)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${tab.id}"]`)).toHaveCount(1, SLOW)
  const dir = mkdtempSync(join(tmpdir(), 'ct-drop-'))
  const file = join(dir, 'notes.txt')
  writeFileSync(file, '0123456789')
  const drop = (paths: string[]) => b.page.evaluate(([id, list]) => window.ct.dropFilesToRemote(id, list), [tab.id, paths] as [string, string[]])

  // one file of 10 bytes: one path under A's received folder, with the same bytes
  // the text typed is the path, quoted for the tab's shell (single quotes)
  const typed = await drop([file])
  const copied = /^'([^']+)'$/.exec(typed ?? '')?.[1] ?? ''
  expect(copied).not.toBe('')
  expect(isWithin(a.received, copied)).toBe(true)
  expect(readFileSync(copied).equals(Buffer.from('0123456789'))).toBe(true)

  // a folder is not a file: refused with the copy's words, and nothing is sent
  const folder = join(dir, 'sub')
  mkdirSync(folder)
  expect(await drop([folder])).toBeNull()
  await expect(b.page.locator('#toasts')).toContainText(REMOTE_COPY.copyFailed('Studio', REMOTE_COPY.copyReadFailed))

  // more than 100 files: refused with the limit's words
  expect(await drop(Array.from({ length: MAX_TRANSFER_FILES + 1 }, (_, i) => join(dir, `f${i}.txt`)))).toBeNull()
  await expect(b.page.locator('#toasts')).toContainText(REMOTE_COPY.copyFailed('Studio', REMOTE_COPY.copyTooManyFiles))

  // more than 50 MB in all: a sparse file of 51 MB, refused before any byte is sent
  const big = join(dir, 'big.bin')
  writeFileSync(big, '')
  truncateSync(big, MAX_TRANSFER_BYTES + 1)
  expect(await drop([file, big])).toBeNull()
  await expect(b.page.locator('#toasts')).toContainText(REMOTE_COPY.copyTooLarge('Studio'))

  // one copy per tab at a time: a drop while the tab's copy of 20 MB runs is refused
  const bulk = join(dir, 'bulk.bin')
  writeFileSync(bulk, Buffer.alloc(20 * 1024 * 1024, 1))
  const { running, refused } = await b.page.evaluate(async ([id, p, q]) => {
    const first = window.ct.dropFilesToRemote(id, [p])
    const second = await window.ct.dropFilesToRemote(id, [q])
    return { running: await first, refused: second }
  }, [tab.id, bulk, file] as [string, string, string])
  expect(running).toMatch(/^'[^']+'$/)
  expect(refused).toBeNull()
  await expect(b.page.locator('#toasts')).toContainText(REMOTE_COPY.copying('Studio'))
})

test("a file dropped on a remote tab's terminal is copied to A, and its path is typed there", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const tab = await openShell(a)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${tab.id}"]`)).toHaveCount(1, SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(tab.id)
  // a real file, handed to the page through a hidden file input: its File has a path, as a dropped file has
  const file = join(mkdtempSync(join(tmpdir(), 'ct-drop-')), 'dropped.txt')
  writeFileSync(file, '0123456789')
  await b.page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'drop-source'
    input.hidden = true
    document.body.append(input)
  })
  await b.page.locator('#drop-source').setInputFiles(file)
  // the drop goes to the visible terminal, which is the element the window's drop listener is on
  await b.page.locator('.terminal-host:visible').evaluate((host) => {
    const input = document.getElementById('drop-source') as HTMLInputElement
    const data = new DataTransfer()
    data.items.add(input.files![0])
    host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  // without the focus reports xterm sends when the test moves focus (ESC [ I, ESC [ O)
  const typed = () => b.page.evaluate((id) => window.__ct!.ptyInput!(id).replace(/\x1b\[(?:20[01]~|[IO])/g, ''), tab.id)
  await expect.poll(typed, SLOW).toMatch(/'[^']+'/)
  const sent = await typed()
  const path = /'([^']+)'/.exec(sent)![1]
  // exactly the path quoted for the tab's shell, under A's received folder, with the file's bytes
  expect(sent).toBe(`'${path}'`)
  expect(isWithin(a.received, path)).toBe(true)
  expect(readFileSync(path).equals(Buffer.from('0123456789'))).toBe(true)
})

test("a drop with a folder among its files sends nothing; a link to a folder is refused with the copy's words", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const tab = await openShell(a)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${tab.id}"]`)).toHaveCount(1, SLOW)
  const dir = mkdtempSync(join(tmpdir(), 'ct-drop-'))
  const file = join(dir, 'notes.txt')
  writeFileSync(file, '0123456789')
  const folder = join(dir, 'sub')
  mkdirSync(folder)
  const drop = (paths: string[]) => b.page.evaluate(([id, list]) => window.ct.dropFilesToRemote(id, list), [tab.id, paths] as [string, string[]])
  // the transfer folders A's receiver made: a refused copy leaves none behind
  const transfers = () => (existsSync(a.received) ? readdirSync(a.received).filter((e) => e.startsWith('t-')) : [])
  const before = transfers()
  expect(await drop([file, folder])).toBeNull()
  await expect(b.page.locator('#toasts')).toContainText(REMOTE_COPY.copyFailed('Studio', REMOTE_COPY.copyReadFailed))
  expect(transfers()).toEqual(before)

  // a link to a folder is not a file: a junction on Windows, a symlink elsewhere. Its refusal is a toast of its own: the
  // earlier one has to be gone first, so that the check below sees the link's toast
  await expect(b.page.locator('#toasts .toast')).toHaveCount(0, SLOW)
  const link = join(dir, 'folder-link')
  symlinkSync(folder, link, WIN ? 'junction' : 'dir')
  expect(await drop([link])).toBeNull()
  await expect(b.page.locator('#toasts')).toContainText(REMOTE_COPY.copyFailed('Studio', REMOTE_COPY.copyReadFailed))
  expect(transfers()).toEqual(before)
})

test("a refusal of A's receiver reaches the person as the copy's failure: two transfers from B fill it, a third is refused", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const tabs = [await openShell(a), await openShell(a), await openShell(a)]
  for (const t of tabs) await expect(b.page.locator(`.tab.remote[data-tab-id="${t.id}"]`)).toHaveCount(1, SLOW)
  const bulk = join(mkdtempSync(join(tmpdir(), 'ct-drop-')), 'bulk.bin')
  writeFileSync(bulk, Buffer.alloc(20 * 1024 * 1024, 1))
  // three copies to three tabs of A at once: the receiver takes two transfers from one device at a time
  const results = await b.page.evaluate(([ids, p]) => Promise.all(ids.map((id) => window.ct.dropFilesToRemote(id, [p]))), [tabs.map((t) => t.id), bulk] as [string[], string])
  expect(results.filter((r) => r === null)).toHaveLength(1)
  expect(results.filter((r) => r !== null)).toHaveLength(2)
  await expect(b.page.locator('#toasts')).toContainText(REMOTE_COPY.copyFailed('Studio', REMOTE_COPY.receiveBusy))
})

test("the Changes panel of A's Claude tab works on B: its review shows here, its Viewed mark goes to A, and the local-only actions are hidden", async () => {
  test.setTimeout(180_000)
  // a git repository of the test's own with a.ts changed, and a session for A's Claude tab, as the hook reports it
  const repo = gitRepo()
  writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\n')
  const { a, b } = await pairedApps({ a: { args: ['--claude', repo] } })
  const sid = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c9'
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${sid}.jsonl`)
  writeFileSync(transcriptPath, '')
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: a.firstTab, sessionId: sid, source: 'startup', transcriptPath })).toEqual({ ok: true })

  // B fronts A's tab: the review A computes for it shows in B's Changes panel
  await expect(b.page.locator(`.tab.remote[data-tab-id="${a.firstTab}"]`)).toBeVisible(SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), a.firstTab)
  // the key goes to the remote tab only once B's active tab is A's: a key that arrives first would land in B's own shell
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(a.firstTab)
  await b.page.keyboard.press(KEYS.changes)
  await expect(b.page.locator('.review-file[data-path="a.ts"] .review-line.add .review-code')).toHaveText('TWO', SLOW)

  // the file's menu has no local-only action (Open in editor, Show in Explorer); Copy path stays
  await b.page.locator('.review-file[data-path="a.ts"] .review-more').click()
  await expect(b.page.locator('.menu-item', { hasText: 'Copy path' })).toBeVisible()
  await expect(b.page.locator('.menu-item', { hasText: 'Open in editor' })).toHaveCount(0)
  await expect(b.page.locator('.menu-item', { hasText: 'Show in Explorer' })).toHaveCount(0)
  await b.page.keyboard.press('Escape')

  // a line's menu has no Open in editor at line either; Comment stays
  await b.page.locator('.review-file[data-path="a.ts"] .review-line.add', { hasText: 'TWO' }).click({ button: 'right' })
  await expect(b.page.locator('.menu-item', { hasText: 'Comment' })).toBeVisible()
  await expect(b.page.locator('.menu-item', { hasText: 'Open in editor at line' })).toHaveCount(0)
  await b.page.keyboard.press('Escape')

  // the Viewed mark goes to A, which checks the path with its own rules, and comes back in A's review
  await b.page.locator('.review-file[data-path="a.ts"] .review-viewed').click()
  await expect(b.page.locator('.review-file.viewed[data-path="a.ts"]')).toHaveCount(1, SLOW)
})

// ---- attention on every device

const ATTENTION_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7d1'
const OFF = { sound: false, flash: false, tab: true }
/** per-case settings with the desktop kept quiet (the same as attention.spec.ts has them) */
const quietNotifications = (over: object = {}): object => ({
  ...FAKE_CLAUDE_SETTINGS,
  notifications: { permission: OFF, question: OFF, done: OFF, bell: { sound: false, flash: false, tab: true }, ...over }
})
/** the attention and unread marks of a tab in a device's window */
const marksOf = (d: Device, id: string) => d.page.evaluate((tabId) => window.__ct!.tabMarks!(tabId), id)

test("Claude waiting on A makes its tab pulse on B with B's sound; opening it on B stops the pulse on A", async () => {
  test.setTimeout(180_000)
  // B writes the sounds it would play to this file instead
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work] },
    b: { settings: quietNotifications({ permission: { sound: true, flash: false, tab: true } }), env: { CLAUDETERM_TEST_SOUND_LOG: sounds } }
  })
  const claude = a.firstTab
  // a second tab on A, so the Claude tab is behind
  await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await a.page.waitForFunction((id) => window.__ct!.activeTabId() !== id, claude)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await expect.poll(played, SLOW).toBe('system\n')

  // the folded chip's dot lights for a pulsing tab of its device
  await b.page.locator('.tab-group-chip', { hasText: 'Studio' }).click()
  await expect(b.page.locator('.tab-group-chip .tab-group-attention')).toHaveCount(1)
  await b.page.locator('.tab-group-chip', { hasText: 'Studio' }).click()

  await b.page.locator(`[data-tab-id="${claude}"]`).click()
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
  expect(played()).toBe('system\n')
})

test("a turn that ends while A is in the background reaches B's sound", async () => {
  test.setTimeout(180_000)
  // B writes the sounds it would play to this file: its sound log is the measure
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work] },
    b: { settings: quietNotifications({ done: { sound: true, flash: false, tab: false, banner: false, front: false } }), env: { CLAUDETERM_TEST_SOUND_LOG: sounds } }
  })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  // a test run never takes the focus, so A's window is in the background
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'done' })).toEqual({ ok: true })
  await expect.poll(played, SLOW).toBe('system\n')
})

test('an attention on the tab in front on A pulses on B; typing into it on A stops the pulse on B', async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  // the tab is in front on A, where nothing pulses; the typing answers it for every device
  await a.page.evaluate(() => {
    const w = window as unknown as { clears: number }
    w.clears = 0
    window.ct.onAttentionClear(() => { w.clears++ })
  })
  await typeInTerminal(a.page, 'y')
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
  const clears = () => a.page.evaluate(() => (window as unknown as { clears: number }).clears)
  await expect.poll(clears).toBe(1)
  // with no pulse left, more typing on A changes nothing on B, and sends no clear
  await typeInTerminal(a.page, 'z')
  await a.page.waitForTimeout(300)
  expect(await clears()).toBe(1)
  expect(await marksOf(b, claude)).toEqual({ attention: false, unread: false })
})

test('an attention on A while A is present with its tab in front reaches no other device: B neither pulses nor sounds', async () => {
  test.setTimeout(180_000)
  // A's presence is a file: 'present' while the test says so; B writes the sounds it would play to a file
  const presentA = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(presentA, 'present')
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work], env: { CLAUDETERM_TEST_PRESENCE: presentA } },
    b: { settings: quietNotifications({ permission: { sound: true, flash: false, tab: true } }), env: { CLAUDETERM_TEST_SOUND_LOG: sounds } }
  })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  await a.page.waitForTimeout(2000)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/)
  expect(played()).toBe('')
  expect(await marksOf(a, claude)).toEqual({ attention: false, unread: false })
})

test("A becoming present with its Claude tab in front clears the attention B shows, and A's own mark", async () => {
  test.setTimeout(180_000)
  // A is not present at first: its file says so, and the test sets it present later
  const presentA = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(presentA, 'absent')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work], env: { CLAUDETERM_TEST_PRESENCE: presentA } },
    b: { settings: quietNotifications() }
  })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)

  // the person sits down at A, with its Claude tab in front: the tab is seen there, so B stops pulsing; A shows no mark for its own front tab
  writeFileSync(presentA, 'present')
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
  expect(await marksOf(a, claude)).toEqual({ attention: false, unread: false })
})

test("B becoming present with A's Claude tab in front on B clears the attention on A", async () => {
  test.setTimeout(180_000)
  // B is not present at first: its file says so, and the test sets it present later
  const presentB = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(presentB, 'absent')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work] },
    b: { settings: quietNotifications(), env: { CLAUDETERM_TEST_PRESENCE: presentB } }
  })
  const claude = a.firstTab
  await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await a.page.waitForFunction((id) => window.__ct!.activeTabId() !== id, claude)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  // A's Claude tab is in front on B, which is not present yet; the front reaches A before the attention does
  await b.page.locator(`[data-tab-id="${claude}"]`).click()
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await b.page.waitForTimeout(1500)

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  // A's tab is behind its shell, so A marks it; B shows no pulse for the tab in front on it
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(true)

  // B's person sits down: the tab in front on B is seen, so A's mark goes
  writeFileSync(presentB, 'present')
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(false)
})

test("B locking its screen while A's Claude tab is in front there makes B away: an attention on A starts on A", async () => {
  test.setTimeout(180_000)
  // B is present: its file says so, and the lock is what makes it away
  const presentB = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(presentB, 'present')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work] },
    b: { settings: quietNotifications(), env: { CLAUDETERM_TEST_PRESENCE: presentB } }
  })
  const claude = a.firstTab
  await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await a.page.waitForFunction((id) => window.__ct!.activeTabId() !== id, claude)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  // A's Claude tab is in front on B, which is present
  await b.page.locator(`[data-tab-id="${claude}"]`).click()
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await b.page.waitForTimeout(1500)

  // B's screen locks: B counts as away at once, and A's host learns it
  await b.app.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen') })
  await b.page.waitForTimeout(1500)

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  // A's tab is behind its shell, so A marks it: a present B would ring instead, and A would keep no mark
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(true)
})

/** ends the node process of a tab's command by its marker, from the test: nothing is typed into the tab */
function killByMarker(marker: string): void {
  if (WIN) {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`])
    return
  }
  // anchored to node: the tab's own bash -c holds the same marker in its command line
  for (const pid of execFileSync('pgrep', ['-f', `^node .*${marker}`], { encoding: 'utf8' }).trim().split('\n')) execFileSync('kill', [pid])
}

test('a Claude tab whose process exits on its own while it waits clears its mark on every device', async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  // the tab's command is a node process with a marker, then the shell's exit: when the process ends, the tab's shell ends too
  const marker = `ct-exit-probe-${Date.now()}`
  const command = `node -e 'setTimeout(()=>{},1e9)' ${marker}; exit #`
  const { a, b } = await pairedApps({
    a: { settings: { ...quietNotifications(), claude: { command, shellProfile: TEST_SHELL } }, args: ['--claude', work] },
    b: { settings: quietNotifications() }
  })
  const claude = a.firstTab
  await expect.poll(() => processAlive(marker), { timeout: 15_000 }).toBe(true)
  await waitingBehindShell(a, b, claude, work)
  // nothing is typed: the process is killed from outside, and the shell's own exit ends the tab
  killByMarker(marker)
  await expect.poll(() => processAlive(marker), { timeout: 15_000 }).toBe(false)
  await expect(a.page.locator(`.tab[data-tab-id="${claude}"]`)).toHaveClass(/\bexited\b/, SLOW)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(false)
})

/** the transcript poll that answers a turn's end waits this long: the person's answer lands in that gap */
const DONE_DELAY = { CLAUDETERM_TEST_DONE_DELAY_MS: '1500' }

/**
 * A's Claude tab, behind a shell tab of A's, with a session whose transcript holds a turn: the turn's end is sent now and
 * its poll waits for DONE_DELAY, so the tests answer it in that gap.
 */
async function endTurnBehindShellOnA(a: Device, b: Device, claude: string, work: string): Promise<void> {
  await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await a.page.waitForFunction((id) => window.__ct!.activeTabId() !== id, claude)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${ATTENTION_SID}.jsonl`)
  writeFileSync(transcriptPath, turnPromptLine('the build is green', { turnIndex: 0 }) + '\n')
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: claude, sessionId: ATTENTION_SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'done' })).toEqual({ ok: true })
}

/** after the poll's delay the answered turn's end starts nothing: B does not pulse and A keeps no mark */
async function expectAnsweredNoMark(a: Device, b: Device, claude: string): Promise<void> {
  await b.page.waitForTimeout(2500)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/)
  expect(await marksOf(a, claude)).toEqual({ attention: false, unread: false })
}

test('a prompt typed on A while the end of its turn is being read leaves no mark on any device', async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work], env: DONE_DELAY }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await endTurnBehindShellOnA(a, b, claude, work)
  await a.page.evaluate(([id, text]) => window.ct.writePty(id, text), [claude, 'x'] as const)
  await expectAnsweredNoMark(a, b, claude)
  // the window was long enough: a turn's end nobody answers pulses on B and marks A's tab
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'done' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(true)
})

test("A activating its Claude tab while the end of its turn is being read leaves no pulse on B and no mark on A", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work], env: DONE_DELAY }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await endTurnBehindShellOnA(a, b, claude, work)
  await a.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => a.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await expectAnsweredNoMark(a, b, claude)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'done' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
})

test("B activating A's Claude tab while the end of its turn is being read leaves no mark on A", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work], env: DONE_DELAY }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await endTurnBehindShellOnA(a, b, claude, work)
  await b.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await b.page.waitForTimeout(2500)
  expect(await marksOf(a, claude)).toEqual({ attention: false, unread: false })
  // the window was long enough: with B's tab in front nobody answers, A marks its tab
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'done' })).toEqual({ ok: true })
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(true)
})

/**
 * A's Claude tab, behind a shell tab of A's, waits with a permission attention that B shows pulsing: the set-up of the
 * tests below. A is not present, so the attention starts and every device hears it.
 */
async function waitingBehindShell(a: Device, b: Device, claude: string, work: string): Promise<void> {
  await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await a.page.waitForFunction((id) => window.__ct!.activeTabId() !== id, claude)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(true)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
}

/**
 * B opens the waiting tab: its front, sent with B's presence, reaches A, which clears the tab's mark there. A's mark going
 * is the proof that the front arrived, so the attention that follows is one B is present for.
 */
async function openWaitingOnB(a: Device, b: Device, claude: string): Promise<void> {
  await b.page.locator(`[data-tab-id="${claude}"]`).click()
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(false)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
}

test("an attention on A while B is present with A's tab in front rings B and leaves no mark on A", async () => {
  test.setTimeout(180_000)
  // A is not present (its presence file says so); B is present, and the test sets its file
  const absentA = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(absentA, 'absent')
  const presentB = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(presentB, 'present')
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work], env: { CLAUDETERM_TEST_PRESENCE: absentA } },
    b: {
      settings: quietNotifications({ permission: { sound: true, flash: false, tab: true } }),
      env: { CLAUDETERM_TEST_PRESENCE: presentB, CLAUDETERM_TEST_SOUND_LOG: sounds }
    }
  })
  const claude = a.firstTab
  await waitingBehindShell(a, b, claude, work)
  await expect.poll(played, SLOW).toBe('system\n')
  await openWaitingOnB(a, b, claude)
  // the sound of the wait has its own repeat window: the ring that follows is past it
  await b.page.waitForTimeout(2500)
  const before = played()

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  await b.page.waitForTimeout(2000)
  // the case has no Even in front: B's sound stays silent, and A keeps no mark of its own
  expect(played()).toBe(before)
  expect((await marksOf(a, claude))?.attention).toBe(false)
})

test('an attention on A while B is present with its tab in front sounds on B for a case set to Even in front', async () => {
  test.setTimeout(180_000)
  const absentA = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(absentA, 'absent')
  const presentB = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(presentB, 'present')
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work], env: { CLAUDETERM_TEST_PRESENCE: absentA } },
    b: {
      settings: quietNotifications({ permission: { sound: true, flash: false, tab: true, front: true } }),
      env: { CLAUDETERM_TEST_PRESENCE: presentB, CLAUDETERM_TEST_SOUND_LOG: sounds }
    }
  })
  const claude = a.firstTab
  await waitingBehindShell(a, b, claude, work)
  await expect.poll(played, SLOW).toBe('system\n')
  await openWaitingOnB(a, b, claude)
  await b.page.waitForTimeout(2500)
  const before = played()

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  // one more sound on B, the ring's; the tab is not pulsed there
  await expect.poll(played, SLOW).toBe(`${before}system\n`)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/)
  expect((await marksOf(a, claude))?.attention).toBe(false)
})

test('a turn that ends with background work while doneWithBackgroundWork is off rings no device present with its tab in front', async () => {
  test.setTimeout(180_000)
  const absentA = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(absentA, 'absent')
  const presentB = join(mkdtempSync(join(tmpdir(), 'ct-present-')), 'present.txt')
  writeFileSync(presentB, 'present')
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications({ doneWithBackgroundWork: false }), args: ['--claude', work], env: { CLAUDETERM_TEST_PRESENCE: absentA } },
    // B would sound this turn's done in front, were it rung
    b: {
      settings: quietNotifications({ done: { sound: true, flash: false, tab: false, banner: false, front: true } }),
      env: { CLAUDETERM_TEST_PRESENCE: presentB, CLAUDETERM_TEST_SOUND_LOG: sounds }
    }
  })
  const claude = a.firstTab
  await waitingBehindShell(a, b, claude, work)
  await openWaitingOnB(a, b, claude)
  await b.page.waitForTimeout(2500)
  const before = played()

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'done', background: true })).toEqual({ ok: true })
  await b.page.waitForTimeout(2000)
  expect(played()).toBe(before)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/)
})

test('a tab marked unread on A keeps its pulse on A when B opens it; a tab not marked loses it', async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  const shell = (await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await a.page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  const attend = async (): Promise<void> => {
    expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  }

  // round 1: both pulse; A marks the tab unread, and B opens it
  await attend()
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await a.page.locator(`[data-tab-id="${claude}"]`).click({ button: 'right' })
  await a.page.locator('.menu-item', { hasText: 'Mark as unread' }).click()
  await b.page.locator(`[data-tab-id="${claude}"]`).click()
  await expect.poll(async () => (await marksOf(a, claude))?.attention, SLOW).toBe(false)
  expect(await marksOf(a, claude)).toEqual({ attention: false, unread: true })
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)

  // round 2: A shows the tab (both marks go) and goes back to its shell; B goes to its own tab, so the tab is behind there
  await a.page.locator(`[data-tab-id="${claude}"]`).click()
  await a.page.locator(`[data-tab-id="${shell}"]`).click()
  expect(await marksOf(a, claude)).toEqual({ attention: false, unread: false })
  // B's window ignores an attention for the tab in front there, and B's front is still the Claude tab: B brings its own tab
  // to the front first, so the tab is behind on B and pulses
  await b.page.locator(`[data-tab-id="${b.firstTab}"]`).click()
  await attend()
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await b.page.locator(`[data-tab-id="${claude}"]`).click()
  await expect(a.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
})

test('a terminal report, a mouse wheel or PgUp into A\'s tab leaves B pulsing; typed text stops it', async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)

  // a focus report and a device attributes answer, as xterm.js sends them: they are not the user at the tab
  await a.page.evaluate(([id, text]) => window.ct.writePty(id, text), [claude, '\x1b[I\x1b[?1;2c'] as const)
  // a mouse wheel turn and PgUp read the reply: they put nothing in the prompt either
  await a.page.evaluate(([id, text]) => window.ct.writePty(id, text), [claude, '\x1b[<64;1;1M'] as const)
  await a.page.evaluate(([id, text]) => window.ct.writePty(id, text), [claude, '\x1b[5~'] as const)
  await b.page.waitForTimeout(700)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/)
  await typeInTerminal(a.page, 'y')
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
})

test("a bell in A's background shell tab marks it on B; opening it there clears the mark on both", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  const shell = (await openShell(a)).id
  await expect.poll(() => bufferText(a.page, shell), SLOW).toMatch(PROMPT)
  await a.page.evaluate((id) => window.ct.activateTab(id), claude)
  await a.page.waitForFunction((id) => window.__ct!.activeTabId() === id, claude)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${shell}"]`)).toBeVisible(SLOW)

  await a.page.evaluate(([id, text]) => window.ct.writePty(id, text), [shell, bellCommand()] as const)
  await expect(a.page.locator(`[data-tab-id="${shell}"] .tab-bell`)).toHaveCount(1, SLOW)
  await expect(b.page.locator(`[data-tab-id="${shell}"] .tab-bell`)).toHaveCount(1, SLOW)
  await expect(b.page.locator(`[data-tab-id="${shell}"]`)).not.toHaveClass(/\battention\b/)

  await b.page.locator(`[data-tab-id="${shell}"]`).click()
  await expect(b.page.locator(`[data-tab-id="${shell}"] .tab-bell`)).toHaveCount(0, SLOW)
  await expect(a.page.locator(`[data-tab-id="${shell}"] .tab-bell`)).toHaveCount(0, SLOW)
})

test("a turn that ends with background work gives B no pulse while doneWithBackgroundWork is off; a plain done does", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications({ doneWithBackgroundWork: false, done: { sound: false, flash: false, tab: true } }), args: ['--claude', work] },
    b: { settings: quietNotifications() }
  })
  const claude = a.firstTab
  const shell = (await openShell(a)).id
  await a.page.evaluate((id) => window.ct.activateTab(id), shell)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'done', background: true })).toEqual({ ok: true })
  await b.page.waitForTimeout(700)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/)

  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'done' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
})

test('restarting a waiting Claude tab on A stops its pulse on B and clears its unread mark on A', async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work)
  await a.page.waitForFunction((id) => window.__ct!.activeTabId() !== id, claude)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
  await a.page.locator(`[data-tab-id="${claude}"]`).click({ button: 'right' })
  await a.page.locator('.menu-item', { hasText: 'Mark as unread' }).click()
  await expect.poll(async () => (await marksOf(a, claude))?.unread, SLOW).toBe(true)

  await a.page.evaluate((id) => window.ct.restartTab(id, true), claude)
  await expect.poll(() => marksOf(a, claude), SLOW).toEqual({ attention: false, unread: false })
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/, SLOW)
})

type MainTestState = { ctFocusRequests?: number; ctBadgeCount?: number }

/** A's Claude tab on B, with B's window in the background and only its banners for permission on */
async function bannerOfA() {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications({ permission: { ...OFF, banner: false } }), args: ['--claude', work] },
    b: { settings: quietNotifications({ permission: { ...OFF, banner: true } }) }
  })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  return { a, b, claude }
}

test("Claude waiting on A shows a system notification on B, titled as the tab, and none on A; the app icon on B counts it until A answers", async () => {
  test.setTimeout(180_000)
  const { a, b, claude } = await bannerOfA()
  const banners = () => b.page.evaluate(() => window.__ct!.banners!())
  const badge = () => b.app.evaluate(() => (globalThis as MainTestState).ctBadgeCount ?? 0)
  await expect.poll(banners, SLOW).toEqual([{ tabId: claude, title: expect.any(String), body: 'Claude is waiting for your permission' }])
  expect(await b.page.evaluate((id) => window.__ct!.tabTitle(id), claude)).toBe((await banners())[0]!.title)
  expect(await a.page.evaluate(() => window.__ct!.banners!())).toEqual([])
  // the app icon counts the tab; Ctrl+Shift+J from B's own tab brings it to the front, and opening it takes the count away
  await expect.poll(badge, SLOW).toBe(1)
  expect(await b.page.evaluate(() => window.__ct!.activeTabId())).not.toBe(claude)
  await b.page.keyboard.press(KEYS.nextWaiting)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await expect.poll(badge, SLOW).toBe(0)
})

test("a click on B's notification of A's tab brings that tab to the front on B, and takes the notification away", async () => {
  test.setTimeout(180_000)
  const { b, claude } = await bannerOfA()
  const banners = () => b.page.evaluate(() => window.__ct!.banners!())
  await expect.poll(banners, SLOW).toHaveLength(1)
  const focusRequests = () => b.app.evaluate(() => (globalThis as MainTestState).ctFocusRequests ?? 0)
  const before = await focusRequests()

  await b.page.evaluate((id) => window.__ct!.clickBanner!(id), claude)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  expect(await focusRequests()).toBe(before + 1)
  await expect.poll(banners).toEqual([])
})

/** B's record of a tab of A: every update of its entry, and every place A published for it */
const recordEntries = (b: Device, id: string) => b.page.evaluate((tabId) => {
  const w = window as unknown as { entries: { cwd: string; folder: string }[]; places: ({ branch: string; worktree: { path: string } | null } | null)[] }
  w.entries = []
  w.places = []
  window.ct.onTabUpdated((tab) => { if (tab.id === tabId) w.entries.push(tab) })
  window.ct.onTabPlace((placeTabId, place) => { if (placeTabId === tabId) w.places.push(place) })
}, id)
const recorded = (b: Device) => b.page.evaluate(() => {
  const w = window as unknown as { entries: { cwd: string; folder: string }[]; places: ({ branch: string; worktree: { path: string } | null } | null)[] }
  return { entries: w.entries, places: w.places }
})

/** what A's statusLine hook reports: the session's folder (workspace.project_dir), which /cd and a worktree change */
const folderStatus = (tabId: string, sessionId: string, projectDir: string) => ({
  v: 1 as const, type: 'status' as const, tabId, sessionId,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: null, context: null, fiveHour: null, sevenDay: null, projectDir
})

test("a Claude tab that moves into a linked worktree on A reaches B: its place, its folder, and its cwd kept", async () => {
  test.setTimeout(180_000)
  const repo = gitRepo()
  const worktree = gitWorktree(repo, 'feat/moved')
  const { a, b } = await pairedApps({ a: { settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', repo] } })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  await recordEntries(b, claude)

  // the session entered a worktree: the status line names it as the session's folder
  expect(await sendPipeMessage(a.pipeName, folderStatus(claude, ATTENTION_SID, worktree))).toEqual({ ok: true })
  await expect.poll(async () => (await recorded(b)).places.some((p) => p?.branch === 'feat/moved' && p.worktree?.path !== undefined), SLOW).toBe(true)
  await expect.poll(async () => (await recorded(b)).entries.some((e) => e.folder === worktree), SLOW).toBe(true)
  // the entries keep the folder the tab was opened in
  for (const entry of (await recorded(b)).entries) expect(entry.cwd).toBe(repo)
})

test("a move to a subfolder of the same place reaches B's entry as its folder alone, with no new place", async () => {
  test.setTimeout(180_000)
  const repo = gitRepo()
  const sub = join(repo, 'src')
  mkdirSync(sub)
  const { a, b } = await pairedApps({ a: { settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', repo] } })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  await recordEntries(b, claude)

  expect(await sendPipeMessage(a.pipeName, folderStatus(claude, ATTENTION_SID, sub))).toEqual({ ok: true })
  // only the folder changes here: the entry is republished by the folder change itself
  await expect.poll(async () => (await recorded(b)).entries.some((e) => e.folder === sub), SLOW).toBe(true)
  // the repository's own first place may come late (git answers A after the view): it is the main worktree's, and no new place
  for (const place of (await recorded(b)).places) expect(place === null ? null : place.worktree).toBeNull()
  for (const entry of (await recorded(b)).entries) expect(entry.cwd).toBe(repo)
})

/** A's Claude tab waits for permission while B has folded A's group: the banner shows on B; `bring` brings the tab to the front */
async function foldedWaitingTab(bring: (b: Device, claude: string) => Promise<void>): Promise<void> {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications({ permission: { ...OFF, banner: false } }), args: ['--claude', work] },
    b: { settings: quietNotifications({ permission: { ...OFF, banner: true } }) }
  })
  const claude = a.firstTab
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  // B folds the group: its chip shows the count
  await b.page.locator('.tab-group-chip', { hasText: 'Studio' }).click()
  await expect(b.page.locator('.tab-group-chip .tab-group-count')).toHaveCount(1)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  const banners = () => b.page.evaluate(() => window.__ct!.banners!())
  await expect.poll(banners, SLOW).toHaveLength(1)

  await bring(b, claude)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await expect(b.page.locator('.tab-group-chip .tab-group-count')).toHaveCount(0)
}

test("a banner click on B fronts A's tab even when B folded A's group, and unfolds the group", async () => {
  await foldedWaitingTab(async (b, claude) => {
    await b.page.evaluate((id) => window.__ct!.clickBanner!(id), claude)
  })
})

test("Ctrl+Shift+J from B's own tab fronts A's tab even when B folded A's group, and unfolds the group", async () => {
  await foldedWaitingTab(async (b) => {
    // the key is pressed in B's own tab: B's front is not A's tab, so the jump is the one that brings it
    expect(await b.page.evaluate(() => window.__ct!.activeTabId())).toBe(b.firstTab)
    await b.page.keyboard.press(KEYS.nextWaiting)
  })
})

test("A opening the tab takes B's banner for it away", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications({ permission: { ...OFF, banner: false } }), args: ['--claude', work] },
    b: { settings: quietNotifications({ permission: { ...OFF, banner: true } }) }
  })
  const claude = a.firstTab
  const shell = (await openShell(a)).id
  await a.page.evaluate((id) => window.ct.activateTab(id), shell)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: ATTENTION_SID, reason: 'permission' })).toEqual({ ok: true })
  const banners = () => b.page.evaluate(() => window.__ct!.banners!())
  await expect.poll(banners, SLOW).toHaveLength(1)

  await a.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(banners, SLOW).toEqual([])
})

const STATUS_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7e1'
const statusOf = (tabId: string, usedPct: number) => ({
  v: 1 as const,
  type: 'status' as const,
  tabId,
  sessionId: STATUS_SID,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct },
  fiveHour: null,
  sevenDay: null
})

test("a status change on A shows on B after B attached, background tasks included", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  // the done at the end is a turn end with background work: quiet, as the other attention tests are
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await b.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)

  const bar = b.page.locator('#statusbar')
  expect(await sendPipeMessage(a.pipeName, statusOf(claude, 41.2))).toEqual({ ok: true })
  await expect(bar.locator('.status-model')).toHaveText('Opus 5.5 · xhigh', SLOW)
  // a change after B has the tab's status: it comes as a live push
  expect(await sendPipeMessage(a.pipeName, statusOf(claude, 45))).toEqual({ ok: true })
  await expect(bar.locator('.status-context')).toHaveText('ctx 45% · 82k/200k', SLOW)
  const tasks = [{ id: 'b1', type: 'shell', description: 'Run the e2e suite', command: 'npx playwright test' }]
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: STATUS_SID, reason: 'done', background: true, tasks })).toEqual({ ok: true })
  await expect(bar.locator('.status-background')).toHaveText('1 in background: Run the e2e suite', SLOW)
})

test("a Changes view of a remote tab has no expand buttons; A's own view of the same file has them", async () => {
  test.setTimeout(180_000)
  // a 40-line file committed, then one line changed in the middle: the lines above and below the hunk are hidden
  const repo = gitRepo()
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }) }
  writeFileSync(join(repo, 'a.ts'), `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')}\n`)
  git('add', '-A')
  git('commit', '-qm', 'forty lines')
  writeFileSync(join(repo, 'a.ts'), `${Array.from({ length: 40 }, (_, i) => (i === 19 ? 'CHANGED' : `line ${i + 1}`)).join('\n')}\n`)
  const { a, b } = await pairedApps({ a: { args: ['--claude', repo] } })
  await a.page.keyboard.press(KEYS.changes)
  await expect(a.page.locator('.review-file[data-path="a.ts"] .review-gap-btns button').first()).toBeVisible(SLOW)

  await b.page.evaluate((id) => window.ct.activateTab(id), a.firstTab)
  await expect(b.page.locator(`.tab.remote[data-tab-id="${a.firstTab}"]`)).toBeVisible(SLOW)
  await b.page.keyboard.press(KEYS.changes)
  await expect(b.page.locator('.review-file[data-path="a.ts"] .review-line.add .review-code')).toHaveText('CHANGED', SLOW)
  await expect(b.page.locator('.review-file[data-path="a.ts"] .review-gap-btns button')).toHaveCount(0)
})

/** the TabInfo of each of this window's tabs as the window last heard it (the open and update events) */
const recordTabInfos = (d: Device) => d.page.evaluate(() => {
  const infos = new Map<string, unknown>()
  ;(window as unknown as { infos: Map<string, unknown> }).infos = infos
  window.ct.onTabOpened((t) => { infos.set(t.id, t) })
  window.ct.onTabUpdated((t) => { infos.set(t.id, t) })
})
const infoOf = (d: Device, id: string) => d.page.evaluate((tabId) => (window as unknown as { infos: Map<string, unknown> }).infos.get(tabId) ?? null, id)
const placeOf = (d: Device, id: string) => d.page.evaluate((tabId) => window.__ct!.placeOf!(tabId) ?? null, id)
/** every place event B's window got for a tab, in order: none when no event came, a null place is kept */
const placeEventsOf = (d: Device, id: string) => d.page.evaluate((tabId) => window.__ct!.placeEvents!(tabId), id)

test("a branch switched in A's repository reaches B when B fronts a shell tab there: B's place names the new branch", async () => {
  test.setTimeout(180_000)
  const repo = gitRepo()
  const { a, b } = await pairedApps()
  const shell = (await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), repo))!
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(shell.id)
  await expect.poll(() => placeOf(b, shell.id), SLOW).not.toBeNull()
  expect((await placeOf(b, shell.id))?.branch).not.toBe('feat-moved')
  execFileSync('git', ['checkout', '-q', '-b', 'feat-moved'], { cwd: repo, stdio: 'ignore' })
  // B brings the tab to the front on A: A asks git for the tab's place again
  await b.page.evaluate((id) => window.ct.activateTab(id), shell.id)
  await expect.poll(async () => (await placeOf(b, shell.id))?.branch, SLOW).toBe('feat-moved')
})

test("a tab A opens in a git folder reaches B with a place in its first place event", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const tab = (await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), gitRepo()))!
  await expect.poll(() => placeEventsOf(b, tab.id), SLOW).not.toHaveLength(0)
  expect((await placeEventsOf(b, tab.id))[0]).not.toBeNull()
})

test("a tab A opens outside git gets exactly one place event on B, and it is null", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const tab = (await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), mkdtempSync(join(tmpdir(), 'ct-plain-'))))!
  await expect.poll(() => placeEventsOf(b, tab.id), SLOW).not.toHaveLength(0)
  // a second event would come with the directory's next change: give it time to arrive
  await b.page.waitForTimeout(2_000)
  expect(await placeEventsOf(b, tab.id)).toEqual([null])
})

test("a fork of A's Claude tab that has no conversation is refused on B: the window says so once, and no tab opens", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps({ a: { args: ['--claude', mkdtempSync(join(tmpdir(), 'ct-work-'))] } })
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(a.firstTab)
  const before = await tabIdsOf(b)
  await b.page.evaluate((id) => window.ct.forkTab(id), a.firstTab)
  await expect(b.page.locator('.toast', { hasText: REMOTE_COPY.forkFailed })).toHaveCount(1, SLOW)
  // a late duplicate toast would arrive by the next round trip to A: count again after one
  await b.page.evaluate((id) => window.ct.canForkTab(id), a.firstTab)
  await expect(b.page.locator('.toast', { hasText: REMOTE_COPY.forkFailed })).toHaveCount(1)
  expect(await tabIdsOf(b)).toEqual(before)
})

test('with A stopped, canForkTab on the tab of A answers false at once, well under the time limit for a device', { tag: '@alone' }, async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] } })
  // a tab with a saved conversation: while A is online, B may fork it
  const sid = '3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b'
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: a.firstTab, sessionId: sid, source: 'startup', transcriptPath: writeTranscript(a.config, work, sid) })).toEqual({ ok: true })
  await expect.poll(() => b.page.evaluate((id) => window.ct.canForkTab(id), a.firstTab), SLOW).toBe(true)
  await a.app.close()
  await expect(b.page.locator('.tab-group-chip.offline', { hasText: 'Studio · offline' })).toBeVisible(SLOW)
  const started = Date.now()
  expect(await b.page.evaluate((id) => window.ct.canForkTab(id), a.firstTab)).toBe(false)
  expect(Date.now() - started).toBeLessThan(LIST_TIMEOUT_MS / 2)
})

test("a head closed on A leaves its fork on B a fork with no head, still titled (fork)", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps({ a: { args: ['--claude', mkdtempSync(join(tmpdir(), 'ct-work-'))] } })
  await recordTabInfos(b)
  const work = a.work
  const head = (await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd, title: 'auth' }), work))!
  const sid = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: head.id, sessionId: sid, source: 'startup', transcriptPath: writeTranscript(a.config, work, sid) })).toEqual({ ok: true })
  const before = await tabIdsOf(a)
  await a.page.evaluate((id) => window.ct.forkTab(id), head.id)
  await expect.poll(async () => (await tabIdsOf(a)).length, SLOW).toBe(before.length + 1)
  const forkId = (await tabIdsOf(a)).find((id) => !before.includes(id))!
  await expect.poll(() => infoOf(b, forkId), SLOW).toMatchObject({ fork: { of: head.id } })
  await a.page.evaluate((id) => window.ct.closeTab(id), head.id)
  await expect.poll(() => infoOf(b, forkId), SLOW).toMatchObject({ fork: { of: null, from: null }, customTitle: 'auth (fork)' })
})

test("B forks A's tab and A's tab in front stays where it is", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps({ a: { args: ['--claude', mkdtempSync(join(tmpdir(), 'ct-work-'))] } })
  const sid = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: a.firstTab, sessionId: sid, source: 'startup', transcriptPath: writeTranscript(a.config, a.work, sid) })).toEqual({ ok: true })
  const shell = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(shell.id)
  const frontOnA = await a.page.evaluate(() => window.__ct!.activeTabId())
  expect(frontOnA).toBe(shell.id)
  const before = await tabIdsOf(a)
  await b.page.evaluate((id) => window.ct.forkTab(id), a.firstTab)
  await expect.poll(async () => (await tabIdsOf(a)).length, SLOW).toBe(before.length + 1)
  expect(await a.page.evaluate(() => window.__ct!.activeTabId())).toBe(frontOnA)
})

test("a new session folder of A's Claude tab makes its folder on B the new one; the cwd B has stays the one the tab opened in", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] } })
  // the listener starts after the tab was listed: the report's own update carries both the folder and the cwd
  await recordTabInfos(b)
  const moved = mkdtempSync(join(tmpdir(), 'ct-moved-'))
  expect(await sendPipeMessage(a.pipeName, folderStatus(a.firstTab, '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8', moved))).toEqual({ ok: true })
  await expect.poll(() => infoOf(b, a.firstTab), SLOW).toMatchObject({ folder: moved, cwd: work })
})

// the left panel's device sections. A's tabs: one in the repository acme, one in its linked worktree, and its first tab,
// outside git. B has its own first tab, outside git; every test here puts B's tabs on the left

test("B's own groups come first, then one section per device with tabs: A's projects, branch lines and worktree bars", async () => {
  test.setTimeout(180_000)
  const repo = namedRepo('acme')
  const worktree = gitWorktree(repo, 'feature')
  const { a, b } = await pairedApps(LEFT_B)
  const inRepo = await openIn(a, repo)
  const inWorktree = await openIn(a, worktree)
  await expect(rowIn(b, inWorktree)).toBeVisible(SLOW)

  // this device's own group comes first, then the device's section; B's own tab is not in the section
  const order = await b.page.evaluate(() => [...document.querySelector('#tabpanel .tp-list')!.children].map((c) => (c.classList.contains('tp-section') ? 'device' : c.querySelector('.tp-group-name')?.textContent ?? '')))
  expect(order).toEqual(['No project', 'device'])
  const section = sectionOfDevice(b, a)
  await expect(deviceHead(b, a)).toContainText('Studio')
  await expect(section.locator(`[data-tab-id="${b.firstTab}"]`)).toHaveCount(0)

  // the section's groups: acme, then No project; its rows in the panel's order. A tab sits in No project until git has
  // answered for its folder, so the names are waited for
  await expect(section.locator('.tp-group-name')).toHaveText(['acme', 'No project'], SLOW)
  await expect.poll(() => rowIdsIn(section), SLOW).toEqual([inRepo, inWorktree, a.firstTab])
  await expect(rowIn(b, inRepo).locator('.tp-branch span')).toHaveText('main')
  await expect(rowIn(b, inWorktree).locator('.tp-branch span')).toHaveText('feature')
  await expect(rowIn(b, inRepo).locator('.tp-wtbar')).toHaveCount(0)
  await expect(rowIn(b, inWorktree).locator('.tp-wtbar')).toHaveCount(1)
  await expect(section.locator('.tp-wtbar')).toHaveCount(1)
  // a remote row's tooltip names its device and folder, as the tab bar's does
  expect(await rowIn(b, inRepo).getAttribute('title')).toContain(`\nStudio: ${repo}`)
})

test("a click on a device header folds its section, and the tab in front moves to B's own; a folded project group stays folded after a relaunch", async () => {
  test.setTimeout(240_000)
  const repo = namedRepo('acme')
  const worktree = gitWorktree(repo, 'feature')
  const { a, b } = await pairedApps(LEFT_B)
  const inRepo = await openIn(a, repo)
  const inWorktree = await openIn(a, worktree)
  await expect(rowIn(b, inWorktree)).toBeVisible(SLOW)
  const section = sectionOfDevice(b, a)
  const head = deviceHead(b, a)
  await expect(groupNamedIn(b, section, 'acme')).toBeVisible(SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), inRepo)
  await expect.poll(() => front(b), SLOW).toBe(inRepo)

  // folding the device of the tab in front: this device's first tab comes to the front
  await head.click()
  await expect(section.locator('.tp-tab')).toHaveCount(0)
  await expect(head.locator('.tp-device-count')).toHaveText('3')
  await expect.poll(() => front(b), SLOW).toBe(b.firstTab)

  // the same device is folded in the top bar as well
  await b.page.locator('#tabpanel .tab-position').click()
  await expect(b.page.locator(`.tab-group-chip[data-device-id="${a.id}"] .tab-group-count`)).toHaveText('3')
  await b.page.locator('#tabbar .tab-position').click()
  await expect(section).toBeVisible()
  await head.click()
  await expect(rowIn(b, inRepo)).toBeVisible()

  // a project group folds on its own: its rows go, the other group stays
  const acme = groupNamedIn(b, section, 'acme')
  await acme.locator('.tp-group-head').click()
  await expect(rowIn(b, inRepo)).toHaveCount(0)
  await expect(rowIn(b, inWorktree)).toHaveCount(0)
  await expect(rowIn(b, a.firstTab)).toBeVisible()
  await expect(acme).toHaveClass(/folded/)

  // a tab of a folded group that comes to the front unfolds its group
  await b.page.evaluate((id) => window.ct.activateTab(id), inWorktree)
  await expect(rowIn(b, inWorktree)).toBeVisible(SLOW)
  await expect(acme).not.toHaveClass(/folded/)
  await b.page.evaluate((id) => window.ct.activateTab(id), b.firstTab)
  await expect.poll(() => front(b), SLOW).toBe(b.firstTab)
  await acme.locator('.tp-group-head').click()
  await expect(rowIn(b, inRepo)).toHaveCount(0)

  // the fold is kept in tab-layout.json, under the device's key: a relaunch of B reads it back. (A's tabs themselves do not
  // come back on B's relaunch in this build: that is main's, and the section is not waited for)
  await relaunch(b)
  await expect.poll(() => b.page.evaluate(async () => (await window.ct.getTabLayout()).folded), SLOW).toHaveLength(1)
  expect((await b.page.evaluate(async () => (await window.ct.getTabLayout()).folded))[0]!.startsWith(`${a.id}\n`)).toBe(true)

  // A's tabs come back to B after its restart: its section is there, its ACME group is still folded (no rows), and its
  // No project group is not folded
  await expect(deviceHead(b, a)).toBeVisible(SLOW)
  const restored = sectionOfDevice(b, a)
  await expect(groupNamedIn(b, restored, 'acme')).toHaveClass(/folded/, SLOW)
  await expect(restored.locator(`[data-tab-id="${inRepo}"]`)).toHaveCount(0)
  await expect(restored.locator(`[data-tab-id="${inWorktree}"]`)).toHaveCount(0)
  await expect(groupNamedIn(b, restored, 'No project')).not.toHaveClass(/folded/)
  await expect(restored.locator(`[data-tab-id="${a.firstTab}"]`)).toBeVisible()
})

test("Ctrl+Tab walks B's tabs, then A's tabs in the panel's order, and comes back; with A folded, from B's last tab it goes to B's first", async () => {
  test.setTimeout(240_000)
  const repo = namedRepo('acme')
  const worktree = gitWorktree(repo, 'feature')
  const { a, b } = await pairedApps(LEFT_B)
  const inRepo = await openIn(a, repo)
  const inWorktree = await openIn(a, worktree)
  await expect(rowIn(b, inWorktree)).toBeVisible(SLOW)
  await expect(groupNamedIn(b, sectionOfDevice(b, a), 'acme')).toBeVisible(SLOW)
  // a second tab of B's own: this device's last tab, so Ctrl+Tab from it goes round to this device's first tab
  const own = await openIn(b, b.work)
  await expect(rowIn(b, own)).toBeVisible(SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), b.firstTab)
  await expect.poll(() => front(b), SLOW).toBe(b.firstTab)

  // this device's tabs, then the section: its acme group (inRepo, inWorktree), then its No project group (A's first tab)
  // each press goes to the terminal in front: a click on it gives it the keys, as a user's would
  for (const next of [own, inRepo, inWorktree, a.firstTab, b.firstTab]) {
    await b.page.locator('.terminal-host:visible .xterm').click()
    await b.page.keyboard.press(KEYS.nextTab)
    await expect.poll(() => front(b), SLOW).toBe(next)
  }

  // a folded device is skipped: from this device's last tab, Ctrl+Tab goes to its first tab, not into A's tabs
  await b.page.evaluate((id) => window.ct.activateTab(id), own)
  await expect.poll(() => front(b), SLOW).toBe(own)
  await deviceHead(b, a).click()
  await expect(rowIn(b, inRepo)).toHaveCount(0)
  await b.page.locator('.terminal-host:visible .xterm').click()
  await b.page.keyboard.press(KEYS.nextTab)
  await expect.poll(() => front(b), SLOW).toBe(b.firstTab)
})

test("Fork session on a remote Claude tab, from B's panel: it is enabled; a click opens a fork on A that comes to the front on B, under its head", async () => {
  test.setTimeout(240_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] }, b: { settings: LEFT_SETTINGS } })
  const sid = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: a.firstTab, sessionId: sid, source: 'startup', transcriptPath: writeTranscript(a.config, work, sid) })).toEqual({ ok: true })
  await expect(rowIn(b, a.firstTab)).toBeVisible(SLOW)

  await rowIn(b, a.firstTab).click({ button: 'right' })
  const fork = b.page.locator('.menu-item', { hasText: /^Fork session$/ })
  await expect(fork).toBeVisible(SLOW)
  await expect(fork).not.toHaveClass(/disabled/)
  const before = await tabIdsOf(a)
  await fork.click()
  await expect.poll(async () => (await tabIdsOf(a)).length, SLOW).toBe(before.length + 1)
  const forkId = (await tabIdsOf(a)).find((id) => !before.includes(id))!
  await expect.poll(() => bufferText(a.page, forkId), SLOW).toContain(`--resume ${sid} --fork-session`)

  // the fork comes to the front on B, under its head in A's section, titled as a fork
  await expect.poll(() => front(b), SLOW).toBe(forkId)
  await expect(b.page.locator(`#tabpanel .tp-tab.fork[data-tab-id="${forkId}"]`)).toContainText('(fork)')
  expect(await b.page.evaluate(([head, f]) => document.querySelector(`[data-tab-id="${head}"]`)!.nextElementSibling?.getAttribute('data-tab-id') === f, [a.firstTab, forkId])).toBe(true)
  await expect(sectionOfDevice(b, a).locator(`[data-tab-id="${forkId}"]`)).toHaveCount(1)
})

// the two Fork session tests above and below are one check: the item is enabled exactly when the conversation can be
// forked. The disabled check fails on an enabled item and on a missing one, so it needs the enabled test beside it
test('Fork session of a remote Claude tab without a saved conversation is disabled on B', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps({ a: { args: ['--claude', mkdtempSync(join(tmpdir(), 'ct-work-'))] }, b: { settings: LEFT_SETTINGS } })
  await expect(rowIn(b, a.firstTab)).toBeVisible(SLOW)
  await rowIn(b, a.firstTab).click({ button: 'right' })
  await expect(b.page.locator('.menu-item', { hasText: /^Fork session$/ })).toHaveClass(/disabled/, SLOW)
  await b.page.keyboard.press('Escape')
})

test("a fork made on A from B stands right after its head on B's tab bar, not after the tabs A opened later", async () => {
  test.setTimeout(240_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] } })
  const sid = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7d9'
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: a.firstTab, sessionId: sid, source: 'startup', transcriptPath: writeTranscript(a.config, work, sid) })).toEqual({ ok: true })
  const later = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(later.id)
  const barOrder = () => b.page.evaluate(() => [...document.querySelectorAll('#tabbar .tab')].map((e) => (e as HTMLElement).dataset.tabId))
  const before = await tabIdsOf(a)
  await b.page.evaluate((id) => window.ct.forkTab(id), a.firstTab)
  await expect.poll(async () => (await tabIdsOf(a)).length, SLOW).toBe(before.length + 1)
  const forkId = (await tabIdsOf(a)).find((id) => !before.includes(id))!
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(forkId)
  await expect.poll(barOrder, SLOW).toEqual([b.firstTab, a.firstTab, forkId, later.id])
})

test("a fork that B makes after B dragged A's tabs into a new order stands right after its head on B's tab bar", async () => {
  test.setTimeout(240_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] } })
  const sid = '3c5e7a9b-2d4f-4e6a-8b0c-1d3f5a7b9c2e'
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: a.firstTab, sessionId: sid, source: 'startup', transcriptPath: writeTranscript(a.config, work, sid) })).toEqual({ ok: true })
  // arrival on B: the head, then x, then y
  const x = await openShell(a)
  const y = await openShell(a)
  const barA = async () => (await b.page.evaluate(() => [...document.querySelectorAll('#tabbar .tab')].map((e) => (e as HTMLElement).dataset.tabId))).filter((id) => id !== b.firstTab)
  await expect.poll(barA, SLOW).toEqual([a.firstTab, x.id, y.id])
  // B drags y onto x: this window's order is head, y, x. The drag is the tab bar's own drag events, the ones a person's
  // drag fires: on the off-screen windows of a busy Windows runner the system's drag sometimes never starts for a whole
  // test, and this test is about the fork's place (the drag has tests of its own)
  await b.page.evaluate(([from, to]) => {
    const tab = (id: string): Element => document.querySelector(`#tabbar .tab[data-tab-id="${id}"]`)!
    const data = new DataTransfer()
    tab(from).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    tab(to).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    tab(to).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    tab(from).dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
  }, [y.id, x.id] as [string, string])
  await expect.poll(barA, SLOW).toEqual([a.firstTab, y.id, x.id])
  // B forks the head from its tab bar: the fork stands right after the head, before the tabs dragged after it
  const before = await tabIdsOf(a)
  await b.page.locator(`#tabbar .tab[data-tab-id="${a.firstTab}"]`).click({ button: 'right' })
  const fork = b.page.locator('.menu-item', { hasText: /^Fork session$/ })
  await expect(fork).toBeVisible(SLOW)
  await expect(fork).not.toHaveClass(/disabled/)
  await fork.click()
  await expect.poll(async () => (await tabIdsOf(a)).length, SLOW).toBe(before.length + 1)
  const forkId = (await tabIdsOf(a)).find((id) => !before.includes(id))!
  await expect.poll(barA, SLOW).toEqual([a.firstTab, forkId, y.id, x.id])
})

test('stopping A dims its section on B: its header reads offline and its rows are dimmed; starting A again brings the rows back', async () => {
  test.setTimeout(180_000)
  const repo = namedRepo('acme')
  const { a, b } = await pairedApps(LEFT_B)
  const tab = await openIn(a, repo)
  await expect(rowIn(b, tab)).toBeVisible(SLOW)
  await a.app.close()
  await expect(deviceHead(b, a)).toContainText(REMOTE_COPY.offline, SLOW)
  await expect(sectionOfDevice(b, a)).toHaveClass(/offline/)
  await expect(rowIn(b, tab)).toHaveClass(/dim/)
  await relaunch(a)
  await expect(sectionOfDevice(b, a)).not.toHaveClass(/offline/, SLOW)
  await expect(b.page.locator('#tabpanel .tp-tab.dim')).toHaveCount(0)
})

test("an online device with no tab keeps its header on the left: a click on it opens a tab there, its + does too, and an offline one with no tab has no header", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(LEFT_B)
  await expect(rowIn(b, a.firstTab)).toBeVisible(SLOW)
  // A closes its only tab: B's tab, listed on A, keeps A's window open with no tab of its own
  await expect(a.page.locator(`.tab.remote[data-tab-id="${b.firstTab}"]`)).toBeVisible(SLOW)
  await a.page.evaluate((id) => window.ct.closeTab(id), a.firstTab)
  await expect(rowIn(b, a.firstTab)).toHaveCount(0, SLOW)
  await expect(deviceHead(b, a)).toBeVisible()
  await expect(sectionOfDevice(b, a)).toHaveClass(/empty/)

  // a click on the header opens A's menu: a new tab there, and nothing to fold
  await deviceHead(b, a).click()
  const items = b.page.locator('.menu .menu-item')
  await expect(items.first()).toHaveText(REMOTE_COPY.newClaudeTab, SLOW)
  await expect(items.filter({ hasText: new RegExp(`^${REMOTE_COPY.fold}$`) })).toHaveCount(0)
  const before = await tabIdsOf(b)
  await items.first().click()
  const newIds = async () => (await tabIdsOf(b)).filter((x) => !before.includes(x))
  await expect.poll(newIds, SLOW).toHaveLength(1)
  const id = (await newIds())[0]
  await expect.poll(() => tabIdsOf(a), SLOW).toContain(id)
  await expect(rowIn(b, id)).toBeVisible(SLOW)
  await expect(sectionOfDevice(b, a)).not.toHaveClass(/empty/)

  // with a tab, the header folds on a click as before, and its + opens the same menu without folding
  await deviceHead(b, a).locator('.tp-device-new').click()
  await expect(items.first()).toHaveText(REMOTE_COPY.newClaudeTab, SLOW)
  await expect(sectionOfDevice(b, a)).not.toHaveClass(/folded/)
  await b.page.keyboard.press('Escape')

  // A closes that tab too and goes offline: a device that is offline and has no tab shows no header
  await a.page.evaluate((x) => window.ct.closeTab(x), id)
  await expect(sectionOfDevice(b, a)).toHaveClass(/empty/, SLOW)
  await a.app.close()
  await expect(deviceHead(b, a)).toHaveCount(0, SLOW)
})

test('at the narrowest width a device with a 64-character name keeps its header inside the panel: the name is cut, with an ellipsis', async () => {
  test.setTimeout(180_000)
  const repo = namedRepo('acme')
  const { a, b } = await pairedApps(LEFT_B)
  const tab = await openIn(a, repo)
  await expect(rowIn(b, tab)).toBeVisible(SLOW)
  // the longest name a device can have (MAX_DEVICE_NAME), with no space to break it
  const longName = 'Workshop-'.padEnd(64, 'x')
  expect(await a.page.evaluate((name) => window.ct.renameThisDevice(name), longName)).toEqual({ ok: true })
  await expect(deviceHead(b, a)).toContainText(longName, SLOW)
  await narrowPanel(b.page)
  const panel = b.page.locator('#tabpanel')
  expect(await panel.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(110)
  // the header is measured once it is drawn: a re-render in between leaves it out for a moment
  await expect.poll(async () => {
    const h = await deviceHead(b, a).boundingBox()
    const p = await panel.boundingBox()
    return h !== null && p !== null && h.x + h.width <= p.x + p.width
  }, SLOW).toBe(true)
  // the header's content fits its box: a name that did not shrink would overflow it
  expect(await deviceHead(b, a).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  // the name is cut inside the panel, with an ellipsis
  const name = deviceHead(b, a).locator('.tp-device-name')
  expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis')
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  const nameBox = (await name.boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
  await expect(name).toBeVisible()
  await expect(groupNamedIn(b, sectionOfDevice(b, a), 'acme')).toBeVisible()
  await expect(rowIn(b, tab)).toBeVisible()
  // the header's own buttons of the narrow form are still there
  await expect(panel.locator('.tab-position')).toBeVisible()
})

test("a drag in a device section moves that device's tabs only, and no remote id reaches the order main keeps", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(LEFT_B)
  const second = await openShell(a)
  const first = a.firstTab
  await recordReorders(b)
  const section = sectionOfDevice(b, a)
  await expect(rowIn(b, second.id)).toBeVisible(SLOW)
  expect(await rowIdsIn(section)).toEqual([first, second.id])
  await rowIn(b, second.id).dragTo(rowIn(b, first))
  await expect.poll(() => rowIdsIn(section), SLOW).toEqual([second.id, first])
  await b.page.waitForTimeout(300)
  const sent = (await reorderSent(b)).flat()
  expect(sent.filter((id) => id === first || id === second.id)).toEqual([])
})

test('a remote tab that comes to the front from the + menu has its row active in its section, and its × closes it on that device', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps(LEFT_B)
  const before = await tabIdsOf(b)
  await b.page.locator('.tab-menu').click()
  // the device's own Claude Code entry: the first one after the device's name, which the menu draws disabled above its entries
  await b.page.locator('.menu-item.disabled', { hasText: /^Studio$/ })
    .locator('xpath=following::div[contains(concat(" ", normalize-space(@class), " "), " menu-item ") and normalize-space(.)="Claude Code"][1]')
    .click(SLOW)
  const newIds = async () => (await tabIdsOf(b)).filter((x) => !before.includes(x))
  await expect.poll(newIds, SLOW).toHaveLength(1)
  const id = (await newIds())[0]!
  await expect.poll(() => front(b), SLOW).toBe(id)
  await expect(rowIn(b, id)).toHaveClass(/active/)
  await expect(sectionOfDevice(b, a).locator(`[data-tab-id="${id}"]`)).toHaveCount(1)
  await rowIn(b, id).locator('.tab-close').click()
  await expect.poll(() => tabIdsOf(a), SLOW).not.toContain(id)
  await expect(rowIn(b, id)).toHaveCount(0, SLOW)
})

test("Change folder on another device empties the card that device shows for A's tab (the reset reaches the viewers)", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const other = mkdtempSync(join(tmpdir(), 'ct-other-'))
  const { a, b } = await pairedApps({ a: { args: ['--claude', work] } })
  // A's Claude tab must not be in front on A, so B's badge counts its card
  const shell = await openShell(a)
  await expect.poll(() => a.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(shell.id)
  const file = join(work, 'shot.png')
  writeFileSync(file, PNG_1x1)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'show_image', tabId: a.firstTab, path: file, caption: null })).toEqual({ ok: true })

  await expect(b.page.locator(`.tab.remote[data-tab-id="${a.firstTab}"] .tab-images`)).toHaveText('🖼1', SLOW)
  await b.page.evaluate((id) => window.ct.activateTab(id), a.firstTab)
  if (await b.page.locator('#image-panel').evaluate((el) => el.classList.contains('collapsed'))) await b.page.keyboard.press(KEYS.images)
  const card = b.page.locator('#image-panel .card')
  await expect(card).toHaveCount(1, SLOW)

  // a conversation with a model and a note on A's tab: B shows both, and the change of folder empties them on B
  const sid = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: a.firstTab, sessionId: sid, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'status', tabId: a.firstTab, sessionId: sid, model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null, sevenDay: null })).toEqual({ ok: true })
  await a.page.evaluate((id) => {
    window.ct.setNoteText(id, 'Goal: payments', 0)
    window.ct.setNoteView(id, true, 'card', 0)
  }, a.firstTab)
  await expect(b.page.locator('#statusbar .status-model')).toHaveText('Opus 5.5 · xhigh', SLOW)
  await expect(b.page.locator('#note .note-text')).toHaveValue('Goal: payments', SLOW)

  expect(await b.page.evaluate(([id, dir]) => window.ct.changeFolder(id, dir), [a.firstTab, other] as [string, string])).toEqual({ ok: true })
  await expect(card).toHaveCount(0, SLOW)
  // the status of the old conversation is gone on B, and the note B shows for the tab opens empty
  await expect(b.page.locator('#statusbar .status-model')).toBeHidden(SLOW)
  await b.page.locator('#tabbar .tab-note-toggle').click()
  await expect(b.page.locator('#note .note-text')).toHaveValue('', SLOW)
})

const RECENT_SID = '3c8a6f2e-1d7b-4e5a-8f9c-0b1a2c3d4e5f'
test("B's Recent sessions lists A's sessions under A's name, and resumes one on A, which is in front on B", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  writeTranscript(a.config, a.work, RECENT_SID)
  const before = await tabIdsOf(a)
  await b.page.keyboard.press(KEYS.recentSessions)
  await expect(b.page.locator('.sessions-device', { hasText: 'Studio' })).toBeVisible(SLOW)
  // A's folder is folded on B until it is opened: the session is the row under its heading
  await b.page.locator('.sessions-group', { hasText: basename(a.work) }).click(SLOW)
  await expect(b.page.locator(`.session-row[data-id="${RECENT_SID}"]`)).toBeVisible(SLOW)
  await b.page.keyboard.press('ArrowDown')
  await b.page.keyboard.press('Enter')
  await expect.poll(async () => (await tabIdsOf(a)).length, SLOW).toBe(before.length + 1)
  const id = (await tabIdsOf(a)).find((x) => !before.includes(x))!
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(id)
  await expect.poll(() => bufferText(b.page, id), SLOW).toContain(`--resume ${RECENT_SID}`)
  await expect(b.page.locator('#sessions')).toBeHidden(SLOW)
})

/** B's Recent sessions: the window opens, the search finds the session by a word of it, and Enter picks it */
async function pickRecent(b: Device, word: string, sid: string): Promise<void> {
  await b.page.keyboard.press(KEYS.recentSessions)
  await expect(b.page.locator('.sessions-device', { hasText: 'Studio' })).toBeVisible(SLOW)
  await b.page.locator('.sessions-search').fill(word)
  await expect(b.page.locator(`.session-row[data-id="${sid}"]`)).toBeVisible(SLOW)
  await b.page.keyboard.press('Enter')
}

test("on B, a search finds A's session by a word of it, and Enter resumes it on A", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  writeTranscript(a.config, a.work, RECENT_SID)
  const before = await tabIdsOf(a)
  await pickRecent(b, 'hello', RECENT_SID)
  await expect.poll(async () => (await tabIdsOf(a)).length, SLOW).toBe(before.length + 1)
  const id = (await tabIdsOf(a)).find((x) => !before.includes(x))!
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(id)
  await expect.poll(() => bufferText(b.page, id), SLOW).toContain(`--resume ${RECENT_SID}`)
})

test("a session already open on A is not opened again: B fronts the tab in that conversation, and A's tabs and front stay as they are", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  writeTranscript(a.config, a.work, RECENT_SID)
  const before = await tabIdsOf(a)
  await pickRecent(b, 'hello', RECENT_SID)
  await expect.poll(async () => (await tabIdsOf(a)).length, SLOW).toBe(before.length + 1)
  const id = (await tabIdsOf(a)).find((x) => !before.includes(x))!
  // A reports the conversation as open before B asks again
  await expect.poll(() => a.page.evaluate((sid) => window.ct.listSessions().then((l) => l.find((s) => s.id === sid)?.open ?? false), RECENT_SID), SLOW).toBe(true)
  await b.page.evaluate((tab) => window.ct.activateTab(tab), b.firstTab)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(b.firstTab)
  const aTabs = await tabIdsOf(a)
  const aFront = await a.page.evaluate(() => window.__ct!.activeTabId())
  await pickRecent(b, 'hello', RECENT_SID)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(id)
  expect(await tabIdsOf(a)).toEqual(aTabs)
  expect(await a.page.evaluate(() => window.__ct!.activeTabId())).toBe(aFront)
})

test('a session whose folder is gone on A is refused on B with the folder sentence, and no tab opens', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const gone = mkdtempSync(join(tmpdir(), 'ct-gone-'))
  const GONE_SID = '7f4e3d2c-1b0a-4c9d-8e7f-6a5b4c3d2e1f'
  writeTranscript(a.config, gone, GONE_SID)
  rmSync(gone, { recursive: true, force: true })
  const before = await tabIdsOf(a)
  await pickRecent(b, basename(gone), GONE_SID)
  await expect(b.page.locator('.toast', { hasText: 'The folder of this session no longer exists' })).toBeVisible(SLOW)
  expect(await tabIdsOf(a)).toEqual(before)
})

test("B's star on A's session shows starred when B's Recent sessions opens again", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  writeTranscript(a.config, a.work, RECENT_SID)
  await b.page.keyboard.press(KEYS.recentSessions)
  await expect(b.page.locator('.sessions-device', { hasText: 'Studio' })).toBeVisible(SLOW)
  await b.page.locator('.sessions-search').fill('hello')
  const row = b.page.locator(`.session-row[data-id="${RECENT_SID}"]`)
  await expect(row).toBeVisible(SLOW)
  await row.locator('.session-star').click()
  await expect(row.locator('.session-star.starred')).toHaveCount(1)
  // the kept answer carries the star at once, without a poll: listRemoteSessions answers from it, and only then refreshes
  expect(await b.page.evaluate((sid) => window.ct.listRemoteSessions().then((l) => l.flatMap((d) => d.value ?? []).find((s) => s.id === sid)?.starred), RECENT_SID)).toBe(true)
  await b.page.keyboard.press('Escape')
  await expect(b.page.locator('#sessions')).toBeHidden(SLOW)
  await b.page.keyboard.press(KEYS.recentSessions)
  await expect(b.page.locator(`.session-row[data-id="${RECENT_SID}"] .session-star.starred`)).toHaveCount(1, SLOW)
})

test("a session both devices list shows once, in this device's own section", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const OTHER_SID = '1d2c3b4a-5f60-4e7d-8c9b-0a1f2e3d4c5b'
  writeTranscript(a.config, a.work, RECENT_SID)
  writeTranscript(b.config, b.work, RECENT_SID)
  writeTranscript(a.config, a.work, OTHER_SID)
  await b.page.keyboard.press(KEYS.recentSessions)
  await expect(b.page.locator('.sessions-device', { hasText: 'Studio' })).toBeVisible(SLOW)
  await b.page.locator('.sessions-search').fill('hello')
  await expect(b.page.locator(`.session-row[data-id="${OTHER_SID}"]`)).toBeVisible(SLOW)
  await expect(b.page.locator(`.session-row[data-id="${RECENT_SID}"]`)).toHaveCount(1)
  const order = await b.page.evaluate((sid) => {
    const rows = [...document.querySelectorAll('#sessions .sessions-list > *')] as HTMLElement[]
    return { row: rows.findIndex((r) => r.dataset.id === sid), device: rows.findIndex((r) => r.classList.contains('sessions-device')) }
  }, RECENT_SID)
  expect(order.row).toBeGreaterThanOrEqual(0)
  expect(order.row).toBeLessThan(order.device)
})

test('a device that goes offline leaves the Recent sessions window at once: its section is gone', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  writeTranscript(a.config, a.work, RECENT_SID)
  await b.page.keyboard.press(KEYS.recentSessions)
  await expect(b.page.locator('.sessions-device', { hasText: 'Studio' })).toBeVisible(SLOW)
  await a.app.close()
  await expect(b.page.locator('.sessions-device', { hasText: 'Studio' })).toHaveCount(0, SLOW)
  // a pick of one of its sessions now, with the section gone, says the device is not connected
  await b.page.evaluate((sid) => window.ct.openSession(sid), RECENT_SID)
  await expect(b.page.locator('.toast', { hasText: REMOTE_COPY.deviceOffline('Studio') })).toBeVisible(SLOW)
})

test('B typing into A keeps A awake; unticking the setting on A lets it sleep', async () => {
  test.setTimeout(180_000)
  // A's power blocker writes each start and stop to this log: a test never keeps the machine awake
  const log = join(mkdtempSync(join(tmpdir(), 'ct-power-')), 'power.txt')
  const powerLines = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [])
  const { a, b } = await startApps({ a: { env: { CLAUDETERM_TEST_POWER_LOG: log } } })

  // before the pairing this device is in no group: the checkbox is not offered
  await a.page.locator('.terminal-host:visible .xterm').click()
  const [settings] = await Promise.all([a.app.waitForEvent('window'), a.page.keyboard.press(KEYS.settings)])
  await settings.waitForSelector('#settings .settings-heading')
  const keep = settings.getByRole('checkbox', { name: 'Keep this computer awake while another device uses it' })
  await expect(keep).toBeHidden()

  await pairApps(a, b)
  await expect(keep).toBeVisible(SLOW)
  await expect(keep).toBeChecked()

  const tab = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(tab.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(PROMPT)
  // nobody typed yet: A holds nothing
  expect(powerLines()).toEqual([])

  await typeInTerminal(b.page, 'echo keep-awake')
  await expect.poll(powerLines, SLOW).toEqual(['start'])

  await keep.uncheck()
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop'])
  expect(JSON.parse(readFileSync(join(a.dataDir, 'settings.json'), 'utf8')).devices.keepAwake).toBe(false)

  // the setting back on holds again, since B typed a moment ago; A leaving the group ends the hold
  await keep.check()
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop', 'start'])
  await settings.getByRole('button', { name: 'Leave the group', exact: true }).click()
  await settings.getByRole('button', { name: 'Leave', exact: true }).click()
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop', 'start', 'stop'])
})

test("a Claude tab that B watches keeps A awake while it works; its turn's end or its exit lets A sleep", async () => {
  test.setTimeout(180_000)
  const log = join(mkdtempSync(join(tmpdir(), 'ct-power-')), 'power.txt')
  const powerLines = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [])
  // both devices keep their sounds quiet; a sound either would play is written to this file instead
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), env: { CLAUDETERM_TEST_POWER_LOG: log, CLAUDETERM_TEST_SOUND_LOG: sounds } },
    b: { settings: quietNotifications(), env: { CLAUDETERM_TEST_SOUND_LOG: sounds } }
  })
  const claude = (await a.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), a.work))!
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(claude.id)

  // a turn that nobody watches holds nothing
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'turn', tabId: claude.id, sessionId: ATTENTION_SID })).toEqual({ ok: true })
  expect(powerLines()).toEqual([])

  // B watches the tab while it works: A holds, and nothing was typed
  await b.page.evaluate((id) => window.ct.activateTab(id), claude.id)
  await expect.poll(powerLines, SLOW).toEqual(['start'])

  // the turn ends: A lets go
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude.id, sessionId: ATTENTION_SID, reason: 'done' })).toEqual({ ok: true })
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop'])

  // an agent running keeps A awake, as it keeps the spinner going on B; A counts the agent a moment later (its status is
  // debounced), so B's spinner, with no turn going, shows that A has it
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'subagent', tabId: claude.id, sessionId: ATTENTION_SID, event: 'start', agentId: 'a3f1c2d4e5b60718', agentType: 'general-purpose' })).toEqual({ ok: true })
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop', 'start'])
  await expect(barIcon(b, claude.id)).toHaveClass(/\bspin\b/, SLOW)
  // a turn that ends while the agent still runs does not let A go
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'turn', tabId: claude.id, sessionId: ATTENTION_SID })).toEqual({ ok: true })
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude.id, sessionId: ATTENTION_SID, reason: 'done' })).toEqual({ ok: true })
  // the answer comes once the turn has ended on A: the hold is still there, as the agent runs
  expect(powerLines()).toEqual(['start', 'stop', 'start'])
  // the agent's end lets A go
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'subagent', tabId: claude.id, sessionId: ATTENTION_SID, event: 'stop', agentId: 'a3f1c2d4e5b60718', agentType: 'general-purpose' })).toEqual({ ok: true })
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop', 'start', 'stop'])

  // a second turn holds again; the tab's process ending in the middle of it lets A go
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'turn', tabId: claude.id, sessionId: ATTENTION_SID })).toEqual({ ok: true })
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop', 'start', 'stop', 'start'])
  await a.page.evaluate((id) => window.ct.activateTab(id), claude.id)
  await typeInTerminal(a.page, 'exit')
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop', 'start', 'stop', 'start', 'stop'])
  // the turn's end and the exit played no sound on either device
  expect(existsSync(sounds)).toBe(false)
})

test('B typing into A keeps A awake, and B\'s link going, with A\'s tab that B watched closed, lets A sleep', async () => {
  test.setTimeout(180_000)
  const log = join(mkdtempSync(join(tmpdir(), 'ct-power-')), 'power.txt')
  const powerLines = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [])
  const { a, b } = await pairedApps({ a: { env: { CLAUDETERM_TEST_POWER_LOG: log } } })
  const tab = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(tab.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(PROMPT)
  await typeInTerminal(b.page, 'echo keep-awake')
  await expect.poll(powerLines, SLOW).toEqual(['start'])

  // A closes the tab B typed into: B watches nothing now, but the typing still holds A
  await a.page.evaluate((id) => window.ct.closeTab(id), tab.id)
  await expect.poll(() => tabIdsOf(a), SLOW).not.toContain(tab.id)
  expect(powerLines()).toEqual(['start'])

  // B's app goes away: its link ends, and that ends A's hold
  await b.app.close()
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop'])
})

test("a connected device whose tabs are not listed yet shows no count, and a section name the Settings window does not know is ignored", async () => {
  test.setTimeout(180_000)
  const { a, b } = await startApps()
  await a.page.locator('.terminal-host:visible .xterm').click()
  const [settings] = await Promise.all([a.app.waitForEvent('window'), a.page.keyboard.press(KEYS.settings)])
  await settings.waitForSelector('#settings .settings-heading')
  // a device that is connected before its tab list has come is not counted as having no tabs: the text is never 'No tabs open'
  await settings.evaluate(() => {
    document.body.dataset.noTabs = 'never'
    new MutationObserver(() => {
      if ([...document.querySelectorAll('#devices *')].some((e) => e.textContent === 'No tabs open')) document.body.dataset.noTabs = 'seen'
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await pairApps(a, b)
  await expect(settings.locator('#devices')).toContainText('1 tab open', SLOW)
  expect(await settings.evaluate(() => document.body.dataset.noTabs)).toBe('never')

  // a section the window does not know is ignored: after the Devices section is shown, the page's own root is not scrolled to
  const sendSection = (name: string) =>
    a.app.evaluate(({ BrowserWindow }, [channel, section]) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'))?.webContents.send(channel, section)
    }, [IPC.evSettingsSection, name] as [string, string])
  const devicesTop = () => settings.evaluate(() => document.getElementById('devices')!.getBoundingClientRect().top)
  await sendSection('devices')
  await expect.poll(devicesTop, SLOW).toBeLessThan(100)
  const shown = await devicesTop()
  await sendSection('settings')
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(await devicesTop()).toBe(shown)
})

test("B's Settings shows A's tab count again once A's link comes back", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  await b.page.locator('.terminal-host:visible .xterm').click()
  const [settings] = await Promise.all([b.app.waitForEvent('window'), b.page.keyboard.press(KEYS.settings)])
  await settings.waitForSelector('#settings .settings-heading')
  await expect(settings.locator('#devices')).toContainText(REMOTE_COPY.tabCount(1), SLOW)
  // A goes: its count goes with its link; when it comes back its first list shows the count again
  await a.app.close()
  await expect(settings.locator('#devices')).not.toContainText(REMOTE_COPY.tabCount(1), SLOW)
  await relaunch(a)
  await expect(settings.locator('#devices')).toContainText(REMOTE_COPY.tabCount(1), SLOW)
})

test("no devices view reaches B's window once its Settings window has closed, even with a view pending; A's count is four", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  // B's main window counts the devices views it is sent: broadcast sends them to every window, Settings included
  await b.page.evaluate(() => {
    document.body.dataset.views = '0'
    window.ct.onDevices(() => {
      document.body.dataset.views = String(Number(document.body.dataset.views) + 1)
    })
  })
  const views = () => b.page.evaluate(() => Number(document.body.dataset.views))
  await b.page.locator('.terminal-host:visible .xterm').click()
  const [settings] = await Promise.all([b.app.waitForEvent('window'), b.page.keyboard.press(KEYS.settings)])
  await settings.waitForSelector('#settings .settings-heading')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const listed = (await tabIdsOf(b)).length
  // two tabs opened on A without waiting for each: the first one B lists starts a coalesced view that is still pending
  const burst = Promise.all([openShell(a), openShell(a)])
  await expect.poll(async () => (await tabIdsOf(b)).length, { timeout: SLOW.timeout, intervals: [5] }).toBeGreaterThan(listed)
  // Settings is destroyed at once, so the pending view is due after its window has gone
  await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'))?.destroy())
  const atClose = await views()
  await burst
  // a third tab on A, after the close: B lists it, and no view is sent for it
  const third = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(third.id)
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(await views()).toBe(atClose)
  // A's own tabs are four: its first, the two of the burst and the third. tabIdsOf(a) would count B's first tab too, which A
  // shows as a remote tab, so it is not the count here
  const view = await b.page.evaluate(() => window.ct.getDevicesView())
  const studio = view.enabled ? view.devices.find((d) => d.name === 'Studio') : undefined
  expect(studio?.tabs).toBe(4)
})

test('quitting A while it keeps itself awake for B ends the hold', async () => {
  test.setTimeout(180_000)
  const log = join(mkdtempSync(join(tmpdir(), 'ct-power-')), 'power.txt')
  const powerLines = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [])
  const { a, b } = await pairedApps({ a: { env: { CLAUDETERM_TEST_POWER_LOG: log } } })
  const tab = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(tab.id)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(PROMPT)
  await typeInTerminal(b.page, 'echo keep-awake')
  await expect.poll(powerLines, SLOW).toEqual(['start'])

  await a.app.close()
  await expect.poll(powerLines, SLOW).toEqual(['start', 'stop'])
})

test('device_status lists the devices and their tabs', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  const tab = await openShell(b)
  await expect.poll(() => tabIdsOf(a), SLOW).toContain(tab.id)
  await b.page.evaluate(([id, title]) => window.ct.renameTab(id, title), [tab.id, 'notes-tab'] as [string, string])
  await expect.poll(async () => ((await sendPipeMessage(a.pipeName, { v: 1, type: 'device_status' })) as { info?: string }).info ?? '', SLOW).toMatch(/Laptop[\s\S]*Connected[\s\S]*notes-tab/)
  // A shows a pairing code: the status says so, and never carries the code itself
  const shown = await a.page.evaluate(() => window.ct.startDevicePairing())
  if (!shown.enabled || !shown.pairing) throw new Error('no pairing code')
  const code = shown.pairing.code
  await expect.poll(async () => ((await sendPipeMessage(a.pipeName, { v: 1, type: 'device_status' })) as { info?: string }).info ?? '', SLOW).toContain('A pairing code is shown.')
  const status = (await sendPipeMessage(a.pipeName, { v: 1, type: 'device_status' })) as { info?: string }
  expect(status.info).not.toContain(code)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'open_device_settings' })).toEqual({ ok: true })
})

/** the Settings window that open_device_settings brings up on a device */
async function openDeviceSettings(a: Device): Promise<Page> {
  const [win] = await Promise.all([a.app.waitForEvent('window'), sendPipeMessage(a.pipeName, { v: 1, type: 'open_device_settings' })])
  return win
}

test("open_device_settings opens the Devices section, where each device's line counts its tabs", async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  // B has two tabs: the one it had at launch and this one
  const tab = await openShell(b)
  await expect.poll(() => tabIdsOf(a), SLOW).toEqual(expect.arrayContaining([b.firstTab, tab.id]))
  const win = await openDeviceSettings(a)
  await expect.poll(() => win.url(), SLOW).toMatch(/#devices$/)
  await expect(win.locator('#devices')).toContainText(REMOTE_COPY.tabCount(2), SLOW)
  // the section is brought to the top of the window: it is not left below the fold, where the window opens without the section
  await expect.poll(() => win.locator('#devices').evaluate((e) => e.getBoundingClientRect().top), SLOW).toBeLessThan(40)
})

test('open_device_settings brings a Settings window that is open to the Devices section, scrolled away from it', async () => {
  test.setTimeout(180_000)
  const { a } = await pairedApps()
  const win = await openDeviceSettings(a)
  await expect.poll(() => win.url(), SLOW).toMatch(/#devices$/)
  const top = (): Promise<number> => win.locator('#devices').evaluate((e) => e.getBoundingClientRect().top)
  // the page is built (its tab count is listed); the person then scrolls the window back to its top, where the Devices section is below the fold
  await expect(win.locator('#devices')).toContainText(REMOTE_COPY.tabCount(1), SLOW)
  await win.evaluate(() => window.scrollTo(0, 0))
  await expect.poll(top, SLOW).toBeGreaterThan(40)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'open_device_settings' })).toEqual({ ok: true })
  await expect.poll(top, SLOW).toBeLessThan(40)
})

test('the Devices count follows the tabs B opens and closes while the window shows them, and goes when B is gone', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairedApps()
  await expect.poll(() => tabIdsOf(a), SLOW).toContain(b.firstTab)
  const win = await openDeviceSettings(a)
  await expect(win.locator('#devices')).toContainText(REMOTE_COPY.tabCount(1), SLOW)
  const tab = await openShell(b)
  await expect(win.locator('#devices')).toContainText(REMOTE_COPY.tabCount(2), SLOW)
  await b.page.evaluate((id) => window.ct.closeTab(id), tab.id)
  await expect(win.locator('#devices')).toContainText(REMOTE_COPY.tabCount(1), SLOW)
  await b.app.close()
  await expect(win.locator('#devices')).toContainText(/Offline since/, SLOW)
  await expect(win.locator('#devices')).not.toContainText(/tabs? open/)
})

// ---- the task list, the spinner and the peer case on another device's tab

const TASK_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7e1'
const SPIN_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7e2'
const PEER_SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7e3'
const RELEASE: TaskList = {
  title: 'Release prep',
  tasks: [
    { title: 'Tag the release', status: 'completed' },
    { title: 'Write the changelog', status: 'in_progress' },
    { title: 'Publish the installers', status: 'pending' }
  ]
}
/** the spinner of a tab's row in B's tab bar, or in its left panel */
const barIcon = (d: Device, id: string) => d.page.locator(`#tabbar .tab[data-tab-id="${id}"] .tab-icon`)
const panelIcon = (d: Device, id: string) => d.page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"] .tab-icon`)
/** what the hooks of A report for its tab: a turn starts, its end, an agent starts and stops */
const turnOn = (d: Device, id: string, sid: string) => sendPipeMessage(d.pipeName, { v: 1, type: 'turn', tabId: id, sessionId: sid })
const turnEndOn = (d: Device, id: string, sid: string) => sendPipeMessage(d.pipeName, { v: 1, type: 'attention', tabId: id, sessionId: sid, reason: 'done' })
const agentOn = (d: Device, id: string, sid: string, event: 'start' | 'stop') =>
  sendPipeMessage(d.pipeName, { v: 1, type: 'subagent', tabId: id, sessionId: sid, event, agentId: 'a3f1c2d4e5b60718', agentType: 'general-purpose' })

test("a task list Claude keeps on A shows in B's status bar; Clear on B removes it on A and on B", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: claude, sessionId: TASK_SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  // the list exists before B opens the tab: the first pushes of the tab carry it
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'task_list', tabId: claude, list: RELEASE })).toEqual({ ok: true, info: 'Task list updated: 1 of 3 done.' })
  await b.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  const seg = b.page.locator('#statusbar .status-plan')
  await expect(seg).toHaveText('1/3 · Write the changelog', SLOW)
  await expect(seg).toHaveAttribute('title', 'Release prep — 1 of 3 done. Click for the task list')

  // a list sent while B has the tab shows on B too
  const SECOND: TaskList = { title: 'Release prep', tasks: [...RELEASE.tasks.slice(0, 2).map((t) => ({ ...t, status: 'completed' as const })), { title: 'Publish the installers', status: 'in_progress' }] }
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'task_list', tabId: claude, list: SECOND })).toEqual({ ok: true, info: 'Task list updated: 2 of 3 done.' })
  await expect(seg).toHaveText('2/3 · Publish the installers', SLOW)
  await expect(seg).toHaveAttribute('title', 'Release prep — 2 of 3 done. Click for the task list')
  await seg.click()
  const box = b.page.locator('#plan-list')
  await expect(box.locator('.plan-task-title')).toHaveText(['Tag the release', 'Write the changelog', 'Publish the installers'])
  await expect(box.locator('.plan-clear')).toHaveText('Clear')
  await box.locator('.plan-clear').click()
  await expect(box).toBeHidden(SLOW)
  await expect(seg).toHaveCount(0, SLOW)
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'task_list_get', tabId: claude })).toEqual({ ok: true, info: 'No task list.' })
})

test("a Claude tab of A spins on B's tab bar and in its left panel through a turn, and shows its mark again when the turn ends", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await b.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await b.page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await turnOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  await expect(barIcon(b, claude)).toHaveClass(/\bspin\b/, SLOW)
  expect(await turnEndOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  await expect(barIcon(b, claude)).not.toHaveClass(/\bspin\b/, SLOW)
  await expect(barIcon(b, claude)).toHaveText('✳')
})

test("an agent A's Claude left running keeps B's left-panel row spinning after the turn ends, as it keeps A's; its stop shows the mark", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: { ...quietNotifications(), tabs: { position: 'left' } } } })
  const claude = a.firstTab
  await b.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await b.page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await turnOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  expect(await agentOn(a, claude, SPIN_SID, 'start')).toEqual({ ok: true })
  await expect(panelIcon(b, claude)).toHaveClass(/\bspin\b/, SLOW)
  expect(await turnEndOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  // the turn is over on A, but its agent still runs: A's row keeps spinning, and so does B's once B has the end of the turn
  await expect(barIcon(a, claude)).toHaveClass(/\bspin\b/)
  await b.page.waitForTimeout(300)
  await expect(panelIcon(b, claude)).toHaveClass(/\bspin\b/)
  expect(await agentOn(a, claude, SPIN_SID, 'stop')).toEqual({ ok: true })
  await expect(barIcon(a, claude)).not.toHaveClass(/\bspin\b/)
  await expect(panelIcon(b, claude)).not.toHaveClass(/\bspin\b/, SLOW)
  await expect(panelIcon(b, claude)).toHaveText('✳')
})

test("a folded device section on B spins while one of A's tabs works, and stops when the turn ends", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: { ...quietNotifications(), tabs: { position: 'left' } } } })
  const claude = a.firstTab
  await expect(deviceHead(b, a)).toBeVisible(SLOW)
  await deviceHead(b, a).click()
  await expect(b.page.locator(`#tabpanel .tp-device[data-device-id="${a.id}"] .tp-group-spin`)).toHaveCount(0)
  await b.page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await turnOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  await expect(deviceHead(b, a).locator('.tp-group-spin')).toHaveCount(1, SLOW)
  expect(await turnEndOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  await expect(deviceHead(b, a).locator('.tp-group-spin')).toHaveCount(0, SLOW)
})

test("a folded device chip on B spins while one of A's tabs works, in the tab bar", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  const chip = b.page.locator(`.tab-group-chip[data-device-id="${a.id}"]`)
  await chip.click()
  // folded: the chip shows the count of A's tabs
  await expect(chip.locator('.tab-group-count')).toHaveText('1', SLOW)
  await expect(b.page.locator(`.tab-group-chip[data-device-id="${a.id}"] .tab-group-spin`)).toHaveCount(0)
  expect(await turnOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  await expect(b.page.locator(`.tab-group-chip[data-device-id="${a.id}"] .tab-group-spin`)).toHaveCount(1, SLOW)
  expect(await turnEndOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  await expect(b.page.locator(`.tab-group-chip[data-device-id="${a.id}"] .tab-group-spin`)).toHaveCount(0, SLOW)
})

test("a Claude tab of A that exits in the middle of a turn stops spinning on B", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({ a: { settings: quietNotifications(), args: ['--claude', work] }, b: { settings: quietNotifications() } })
  const claude = a.firstTab
  await b.page.evaluate((id) => window.ct.activateTab(id), claude)
  await expect.poll(() => b.page.evaluate(() => window.__ct!.activeTabId()), SLOW).toBe(claude)
  await b.page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await turnOn(a, claude, SPIN_SID)).toEqual({ ok: true })
  await expect(barIcon(b, claude)).toHaveClass(/\bspin\b/, SLOW)
  await a.page.evaluate((id) => window.ct.activateTab(id), claude)
  await typeInTerminal(a.page, 'exit')
  await expect(barIcon(a, claude)).not.toHaveClass(/\bspin\b/, SLOW)
  await expect(barIcon(b, claude)).not.toHaveClass(/\bspin\b/, SLOW)
})

/** A's Claude tab, its session's transcript holding one turn another session started; A's signal for the turn's end follows */
async function peerTurnOnA(a: Device, claude: string): Promise<void> {
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${PEER_SID}.jsonl`)
  writeFileSync(transcriptPath, turnPromptLine('the build is green', { turnIndex: 0, origin: PEER_ORIGIN }) + '\n')
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'session', tabId: claude, sessionId: PEER_SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  expect(await sendPipeMessage(a.pipeName, { v: 1, type: 'attention', tabId: claude, sessionId: PEER_SID, reason: 'done' })).toEqual({ ok: true })
}

test("a turn another session started on A is marked on B by B's own peer setting: on when B's peer tab channel is on", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work] },
    b: { settings: quietNotifications({ done: { sound: false, flash: false, tab: false }, peer: { sound: false, flash: false, tab: true } }) }
  })
  const claude = a.firstTab
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  await peerTurnOnA(a, claude)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toHaveClass(/\battention\b/, SLOW)
})

test("with the defaults, B gives no mark to a turn another session started on A", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { a, b } = await pairedApps({
    a: { settings: quietNotifications(), args: ['--claude', work] },
    b: { settings: quietNotifications({ done: { sound: false, flash: false, tab: false } }) }
  })
  const claude = a.firstTab
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).toBeVisible(SLOW)
  await peerTurnOnA(a, claude)
  // the mark would arrive right after A's signal; give it time to show up if it were sent
  await b.page.waitForTimeout(300)
  await expect(b.page.locator(`[data-tab-id="${claude}"]`)).not.toHaveClass(/\battention\b/)
})
