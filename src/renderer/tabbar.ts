import type { TabKind } from '../shared/types'
import { formatBadge } from './badge'

/** one full fade in and out of the attention pulse: 2 × the 1.2 s alternate animation in styles.css */
const PULSE_CYCLE_MS = 2400

export interface TabBarItem {
  id: string
  title: string
  kind: TabKind
  bell: boolean
  /** Claude in this tab is waiting for the user */
  attention: boolean
  images: number
  exited: boolean
}

export interface TabBarCallbacks {
  activate(id: string): void
  close(id: string): void
  rename(id: string, title: string | null): void
  reorder(ids: string[]): void
  newTab(): void
  openMenu(anchor: HTMLElement): void
  tabMenu(id: string, at: { x: number; y: number }): void
  toggleImages(): void
  toggleChanges(): void
}

function button(text: string, cls: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.textContent = text
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

export class TabBar {
  private editing: string | null = null
  private dragId: string | null = null
  private items: TabBarItem[] = []
  private activeId: string | null = null
  private imagesVisible = false
  private imagesUnseen = 0
  private readonly imagesButton: HTMLButtonElement
  private changesAvailable = false
  private changesVisible = false
  private changesUnviewed = 0
  private readonly changesButton: HTMLButtonElement
  private list = document.createElement('div')

  /** the buttons are built once: a re-render (a busy Claude retitles its tab every second) must not drop a click or a tooltip */
  constructor(root: HTMLElement, private readonly cb: TabBarCallbacks) {
    this.list.className = 'tabs'
    const plus = button('+', 'tab-new', 'New tab (Ctrl+Shift+T)', () => this.cb.newTab())
    const more = button('▾', 'tab-menu', 'Profiles', (e) => this.cb.openMenu(e.currentTarget as HTMLElement))
    this.imagesButton = this.createImagesButton()
    this.changesButton = this.createChangesButton()
    this.updateImagesButton()
    this.updateChangesButton()
    root.replaceChildren(this.list, plus, more, this.changesButton, this.imagesButton)
  }

  render(items: TabBarItem[], activeId: string | null): void {
    this.items = items
    this.activeId = activeId
    if (this.editing) return
    const list = document.createElement('div')
    list.className = 'tabs'
    for (const item of items) list.append(this.renderTab(item, item.id === activeId))
    this.list.replaceWith(list)
    this.list = list
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

  private createImagesButton(): HTMLButtonElement {
    return this.createToggle('tab-images-toggle', 'Images (Ctrl+Shift+I)', () => this.cb.toggleImages(),
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><circle cx="5.3" cy="6.2" r="1.1"/><path d="M2 12l3.7-3.7 2.6 2.6 2-2L14 12.5"/></svg>')
  }

  private createChangesButton(): HTMLButtonElement {
    return this.createToggle('tab-changes-toggle', 'Changes (Ctrl+Shift+D)', () => this.cb.toggleChanges(),
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3.65 1.65h6.2l2.5 2.5v10.2h-8.7z"/><path d="M5.5 6.5h4M7.5 4.5v4"/><path d="M5.5 11.5h4"/></svg>')
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
    const b = this.changesButton
    b.hidden = !this.changesAvailable
    b.classList.toggle('active', this.changesVisible)
    this.setBadge(b, this.changesUnviewed)
  }

  private setBadge(b: HTMLElement, n: number): void {
    const badge = b.querySelector<HTMLElement>('.badge')!
    const text = formatBadge(n)
    badge.textContent = text
    badge.hidden = text === ''
  }

  private updateImagesButton(): void {
    const b = this.imagesButton
    b.classList.toggle('active', this.imagesVisible)
    this.setBadge(b, this.imagesUnseen)
  }

  private renderTab(item: TabBarItem, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}${item.exited ? ' exited' : ''}${item.attention ? ' attention' : ''}`
    el.dataset.tabId = item.id
    // render() rebuilds every tab, which would restart the pulse each time (a busy Claude retitles its tab every
    // second); a negative delay from one shared clock makes a rebuilt tab carry on in the same phase
    if (item.attention) el.style.animationDelay = `${-(performance.now() % PULSE_CYCLE_MS)}ms`
    el.draggable = true
    el.title = item.title
    const icon = document.createElement('span')
    icon.className = 'tab-icon'
    icon.textContent = item.kind === 'claude' ? '✳' : '>'
    const label = document.createElement('span')
    label.className = 'tab-title'
    label.textContent = item.title
    el.append(icon, label)
    if (item.bell) {
      const b = document.createElement('span')
      b.className = 'tab-bell'
      b.textContent = '●'
      el.append(b)
    }
    if (item.images > 0) {
      const b = document.createElement('span')
      b.className = 'tab-images'
      b.textContent = `🖼${item.images}`
      el.append(b)
    }
    el.append(button('×', 'tab-close', 'Close (Ctrl+Shift+W)', (e) => {
      e.stopPropagation()
      this.cb.close(item.id)
    }))
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        this.cb.close(item.id)
      }
    })
    el.addEventListener('click', () => this.cb.activate(item.id))
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.cb.tabMenu(item.id, { x: e.clientX, y: e.clientY })
    })
    el.addEventListener('dblclick', () => this.beginRename(label, item))
    el.addEventListener('dragstart', () => { this.dragId = item.id })
    el.addEventListener('dragover', (e) => { if (this.dragId) e.preventDefault() })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      this.dropOn(item.id)
    })
    el.addEventListener('dragend', () => { this.dragId = null })
    return el
  }

  private dropOn(targetId: string): void {
    const from = this.dragId
    this.dragId = null
    if (!from || from === targetId) return
    const all = this.items.map((i) => i.id)
    const fromIdx = all.indexOf(from)
    const toIdx = all.indexOf(targetId)
    const ids = all.filter((id) => id !== from)
    const t = ids.indexOf(targetId)
    ids.splice(fromIdx < toIdx ? t + 1 : t, 0, from)
    this.cb.reorder(ids)
  }

  private beginRename(label: HTMLElement, item: TabBarItem): void {
    this.editing = item.id
    const input = document.createElement('input')
    input.className = 'tab-rename'
    input.value = item.title
    label.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      this.editing = null
      const value = input.value.trim()
      if (commit && value !== item.title) this.cb.rename(item.id, value === '' ? null : value)
      this.render(this.items, this.activeId)
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }
}
