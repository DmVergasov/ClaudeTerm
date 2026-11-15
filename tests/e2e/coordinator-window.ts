import { expect, type Locator, type Page } from '@playwright/test'
import type { CoordMarks } from '../../src/shared/coordinator'
import { VERSION_SETTINGS } from './agent-mail'
import { panelSettled } from './helpers'

/** coordApp's settings with the tabs in the left panel */
export const LEFT = { ...VERSION_SETTINGS, tabs: { position: 'left' } }

export const marksOf = (page: Page): Promise<CoordMarks> => page.evaluate(() => window.ct.coordMarks())
export const tabOrder = (page: Page): Promise<string[]> => page.evaluate(() => window.__ct!.tabIds())
export const pill = (page: Page, id: string): Locator => page.locator(`#tabbar .tab[data-tab-id="${id}"]`)
export const tpRow = (page: Page, id: string): Locator => page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"]`)
export const sessionsToggle = (page: Page): Locator => page.locator('#sheet-header .tab-sessions-toggle')
export const sessionRow = (page: Page, key: string): Locator => page.locator(`#image-panel .panel-sessions .coord-row[data-key="${key}"]`)
export const sessionGroup = (page: Page, group: string): Locator => page.locator(`#image-panel .panel-sessions .coord-group[data-group="${group}"]`)
export const rowKey = (sid: string): string => `local:${sid}`

/** clicks a row's action button with that label: the rows are rebuilt on every view, so the hover and the click are tried again */
export async function act(page: Page, key: string, label: string): Promise<void> {
  const row = sessionRow(page, key)
  await expect(async () => {
    await row.hover()
    await row.locator('.coord-acts button', { hasText: label }).click({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
}

/** opens the Sessions panel with its toggle and waits until it has slid in */
export async function openSessions(page: Page): Promise<void> {
  await sessionsToggle(page).click()
  await panelSettled(page, true)
}

export interface PanelRowSeen { id: string; attached: boolean; label: string | null; to: string | null }

/** the left panel's rows in one read (the panel rebuilds them on every render): indented, the Coordinator label, the ↳ mark */
export function panelRows(page: Page): Promise<PanelRowSeen[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#tabpanel .tp-tab')].map((row) => ({
    id: row.dataset.tabId!,
    attached: row.classList.contains('coord-attached'),
    label: row.querySelector('.tab-coord')?.textContent ?? null,
    to: row.querySelector('.tp-coord-to')?.textContent ?? null
  })))
}

/** right-clicks the tab (a pill on top, a row on the left) until its menu offers the item enabled, then clicks it */
export async function menuItem(page: Page, tabId: string, label: string): Promise<void> {
  const tab = page.locator(`#tabbar .tab[data-tab-id="${tabId}"]:visible, #tabpanel .tp-tab[data-tab-id="${tabId}"]:visible`).first()
  const item = page.locator('.menu .menu-item:not(.disabled)', { hasText: label })
  // the menu is asked for before it is drawn: a right-click that lands while the answers are on their way is tried again
  await expect(async () => {
    await tab.click({ button: 'right' })
    await expect(item).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
  await item.click()
}

/** the centres of the elements, all measured in one evaluate: the rows are built again on every render, so they are read when needed */
async function centres(page: Page, ...locs: Locator[]): Promise<{ x: number; y: number }[]> {
  const handles = await Promise.all(locs.map((loc) => loc.elementHandle()))
  return page.evaluate((els) => els.map((el) => {
    const box = el.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }), handles)
}

/** a mouse drag from the centre of one element to the centre of another, each measured in one evaluate */
export async function dragOnto(page: Page, from: Locator, to: Locator): Promise<void> {
  const [start, end] = await centres(page, from, to)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await page.mouse.up()
}

/** presses on the centre of `from` and moves over the centre of `to`, the button still down: the caller releases it */
export async function holdOver(page: Page, from: Locator, to: Locator): Promise<void> {
  const [start, end] = await centres(page, from, to)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
}

/** moves the held button over the centre of `to` */
export async function moveOver(page: Page, to: Locator): Promise<void> {
  const [end] = await centres(page, to)
  await page.mouse.move(end.x, end.y, { steps: 8 })
}

/**
 * the held pointer moves a pixel within `on`. A held drag fires dragover again on each pointer event, and a light is set by
 * dragover, so a poll of the light moves the pointer again: a row rebuilt under the pointer takes its dragover on the next move
 */
export async function restOver(page: Page, on: Locator): Promise<void> {
  const [end] = await centres(page, on)
  await page.mouse.move(end.x + 1, end.y + 1)
}
