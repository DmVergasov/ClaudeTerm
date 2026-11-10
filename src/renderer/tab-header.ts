import type { TabPosition } from '../shared/types'
import { formatBadge } from './badge'
import { shortcutLabel } from './keymap'
import { noteIcon } from './note-overlay'
import { button } from './tab-row'
import type { TabBarCallbacks } from './tabbar'

type HeaderCallbacks = Pick<TabBarCallbacks, 'newTab' | 'openMenu' | 'toggleImages' | 'toggleChanges' | 'toggleDocs' | 'toggleMessages' | 'toggleNote' | 'switchPosition'>

const ICON_IMAGES = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><circle cx="5.3" cy="6.2" r="1.1"/><path d="M2 12l3.7-3.7 2.6 2.6 2-2L14 12.5"/></svg>'
const ICON_CHANGES = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3.65 1.65h6.2l2.5 2.5v10.2h-8.7z"/><path d="M5.5 6.5h4M7.5 4.5v4"/><path d="M5.5 11.5h4"/></svg>'
const ICON_DOCS = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3.65 1.65h6.2l2.5 2.5v10.2h-8.7z"/><path d="M5.5 7.5h5M5.5 9.75h5M5.5 12h3"/></svg>'
const ICON_MESSAGES = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="3.15" width="12.7" height="9.7" rx="1.5"/><path d="M2 4.4l6 4.6 6-4.6"/></svg>'
/** the tabs are on top: the icon shows a split into a panel on the left */
const ICON_TO_LEFT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><path d="M5.65 2.65v10.7"/></svg>'
/** the tabs are on the left: the icon shows a split into a bar on top */
const ICON_TO_TOP = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><path d="M1.65 5.65h12.7"/></svg>'

/**
 * The header buttons of a tab bar on top or of the left panel: + and ▾, Changes, Docs, Media, Messages and Note, and the position
 * button. Each bar has its own set, built once, so a re-render of the tabs never drops a click or a tooltip.
 */
export class TabHeader {
  readonly plus: HTMLButtonElement
  readonly more: HTMLButtonElement
  readonly changes: HTMLButtonElement
  readonly docs: HTMLButtonElement
  readonly images: HTMLButtonElement
  readonly messages: HTMLButtonElement
  readonly note: HTMLButtonElement
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
    this.docs = this.createToggle('tab-docs-toggle', `Docs (${shortcutLabel('toggleDocs', platform)})`, () => cb.toggleDocs(), ICON_DOCS, false)
    this.messages = this.createToggle('tab-messages-toggle', 'Agent messages', () => cb.toggleMessages(), ICON_MESSAGES)
    this.note = this.createToggle('tab-note-toggle', `Note (${shortcutLabel('toggleNote', platform)})`, () => cb.toggleNote(), noteIcon(16), false)
    this.position = document.createElement('button')
    this.position.className = 'tab-position'
    this.position.title = where === 'top' ? 'Tabs on the left' : 'Tabs on top'
    this.position.innerHTML = where === 'top' ? ICON_TO_LEFT : ICON_TO_TOP
    this.position.addEventListener('click', () => cb.switchPosition())
    this.updateImagesButton()
    this.updateChangesButton()
    this.setDocs(false, false)
    this.setMessages(false, false, 0)
    this.setNote(false, false)
  }

  /** the Changes button exists only for Claude tabs; it shows the files not yet viewed */
  setChanges(available: boolean, visible: boolean, unviewed: number): void {
    this.changesAvailable = available
    this.changesVisible = visible
    this.changesUnviewed = unviewed
    this.updateChangesButton()
  }

  /** the Docs button is hidden while the tab has no document to show; it is lit while the Docs panel is shown */
  setDocs(available: boolean, visible: boolean): void {
    this.docs.hidden = !available
    this.docs.classList.toggle('active', visible)
  }

  setImages(visible: boolean, unseen: number): void {
    this.imagesVisible = visible
    this.imagesUnseen = unseen
    this.updateImagesButton()
  }

  /** the Messages button exists while agent messages are on; it is lit while the Agent messages panel is shown, and counts the unread messages of the tab */
  setMessages(available: boolean, visible: boolean, unread: number): void {
    this.messages.hidden = !available
    this.messages.classList.toggle('active', visible)
    this.setBadge(this.messages, unread)
  }

  /** the Note button exists only for Claude tabs; it is lit while the note is shown */
  setNote(available: boolean, visible: boolean): void {
    this.note.hidden = !available
    this.note.classList.toggle('active', visible)
  }

  private createToggle(cls: string, title: string, onClick: () => void, icon: string, badge = true): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = cls
    b.title = title
    b.innerHTML = icon
    if (badge) {
      const span = document.createElement('span')
      span.className = 'badge'
      b.append(span)
    }
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
