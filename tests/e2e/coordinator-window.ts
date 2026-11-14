import type { Locator, Page } from '@playwright/test'
import type { CoordMarks } from '../../src/shared/coordinator'
import { VERSION_SETTINGS } from './agent-mail'

/** coordApp's settings with the tabs in the left panel */
export const LEFT = { ...VERSION_SETTINGS, tabs: { position: 'left' } }

export const marksOf = (page: Page): Promise<CoordMarks> => page.evaluate(() => window.ct.coordMarks())
export const tabOrder = (page: Page): Promise<string[]> => page.evaluate(() => window.__ct!.tabIds())
export const pill = (page: Page, id: string): Locator => page.locator(`#tabbar .tab[data-tab-id="${id}"]`)
export const tpRow = (page: Page, id: string): Locator => page.locator(`#tabpanel .tp-tab[data-tab-id="${id}"]`)

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
