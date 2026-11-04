import type { TabPosition } from '../shared/types'
import { formatBadge } from './badge'
import { shortcutLabel } from './keymap'
import { button } from './tab-row'
import type { TabBarCallbacks } from './tabbar'

type HeaderCallbacks = Pick<TabBarCallbacks, 'newTab' | 'openMenu' | 'toggleImages' | 'toggleChanges' | 'switchPosition'>

const ICON_IMAGES = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><circle cx="5.3" cy="6.2" r="1.1"/><path d="M2 12l3.7-3.7 2.6 2.6 2-2L14 12.5"/></svg>'
const ICON_CHANGES = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3.65 1.65h6.2l2.5 2.5v10.2h-8.7z"/><path d="M5.5 6.5h4M7.5 4.5v4"/><path d="M5.5 11.5h4"/></svg>'
/** the tabs are on top: the icon shows a split into a panel on the left */
const ICON_TO_LEFT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><path d="M5.65 2.65v10.7"/></svg>'
/** the tabs are on the left: the icon shows a split into a bar on top */
const ICON_TO_TOP = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><path d="M1.65 5.65h12.7"/></svg>'

/**
 * The header buttons of a tab bar on top or of the left panel: + and ▾, Changes and Media, and the position button. Each
 * bar has its own set, built once, so a re-render of the tabs never drops a click or a tooltip.
 */
export class TabHeader {
  readonly plus: HTMLButtonElement
  readonly more: HTMLButtonElement
  readonly changes: HTMLButtonElement
  readonly images: HTMLButtonElement
  readonly position: HTMLButtonElement
  private changesAvailable = false
  private changesVisible = false
  private changesUnviewed = 0
  private imagesVisible = false
  private imagesUnseen = 0

  constructor(cb: HeaderCallbacks, platform: string, where: TabPosition) {
    this.plus = button('+', 'tab-new', `New tab (${shortcutLabel('newTab', platform)})`, () => cb.newTab())
    this.more = button('▾', 'tab-menu', 'Profiles', (e) => cb.openMenu(e.currentTarget as HTMLElement))
    this.images = this.createToggle('tab-images-toggle', `Media (${shortcutLabel('toggleImages', platform)})`, () => cb.toggleImages(), ICON_IMAGES)
    this.changes = this.createToggle('tab-changes-toggle', `Changes (${shortcutLabel('toggleChanges', platform)})`, () => cb.toggleChanges(), ICON_CHANGES)
    this.position = document.createElement('button')
    this.position.className = 'tab-position'
    this.position.title = where === 'top' ? 'Tabs on the left' : 'Tabs on top'
    this.position.innerHTML = where === 'top' ? ICON_TO_LEFT : ICON_TO_TOP
    this.position.addEventListener('click', () => cb.switchPosition())
    this.updateImagesButton()
    this.updateChangesButton()
  }

  /** the Changes button exists only for Claude tabs; it shows the files not yet viewed */
  setChanges(available: boolean, visible: boolean, unviewed: number): void {
    this.changesAvailable = available
    this.changesVisible = visible
    this.changesUnviewed = unviewed
    this.updateChangesButton()
  }

  setImages(visible: boolean, unseen: number): void {
    this.imagesVisible = visible
    this.imagesUnseen = unseen
    this.updateImagesButton()
  }

  private createToggle(cls: string, title: string, onClick: () => void, icon: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = cls
    b.title = title
    b.innerHTML = icon
    const badge = document.createElement('span')
    badge.className = 'badge'
    b.append(badge)
    b.addEventListener('click', onClick)
    return b
  }

  private updateChangesButton(): void {
    const b = this.changes
    b.hidden = !this.changesAvailable
    b.classList.toggle('active', this.changesVisible)
    this.setBadge(b, this.changesUnviewed)
  }

  private updateImagesButton(): void {
    const b = this.images
    b.classList.toggle('active', this.imagesVisible)
    this.setBadge(b, this.imagesUnseen)
  }

  private setBadge(b: HTMLElement, n: number): void {
    const badge = b.querySelector<HTMLElement>('.badge')!
    const text = formatBadge(n)
    badge.textContent = text
    badge.hidden = text === ''
  }
}
