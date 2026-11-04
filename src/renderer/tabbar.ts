import type { TabKind, TabPlace } from '../shared/types'
import { TabHeader } from './tab-header'
import { beginRename, bindTab, pulseDelay, tabParts } from './tab-row'

export interface TabBarItem {
  id: string
  title: string
  /** the folder the tab was opened in */
  folder: string
  kind: TabKind
  /** the tab makes no notification sound */
  muted: boolean
  bell: boolean
  /** Claude in this tab is waiting for the user */
  attention: boolean
  images: number
  exited: boolean
  /** where the tab's folder is in git; null outside a repository (or before git has answered) */
  place: TabPlace | null
  /** the head of the tab's family when the tab is a fork; null for an ordinary tab */
  forkOf: string | null
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
  switchPosition(): void
}

export class TabBar {
  private editing: string | null = null
  private dragId: string | null = null
  private items: TabBarItem[] = []
  private activeId: string | null = null
  private readonly header: TabHeader
  private list = document.createElement('div')

  /** the buttons are built once: a re-render (a busy Claude retitles its tab every second) must not drop a click or a tooltip */
  constructor(private readonly root: HTMLElement, private readonly cb: TabBarCallbacks, private readonly platform: string) {
    this.list.className = 'tabs'
    this.header = new TabHeader(cb, platform, 'top')
  }

  /** the bar is in the page only while it is shown: a hidden one would still match the selectors of the shown one */
  show(visible: boolean): void {
    const h = this.header
    this.root.replaceChildren(...(visible ? [this.list, h.plus, h.more, h.changes, h.images, h.position] : []))
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
    this.header.setChanges(available, visible, unviewed)
  }

  setImages(visible: boolean, unseen: number): void {
    this.header.setImages(visible, unseen)
  }

  private renderTab(item: TabBarItem, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}${item.exited ? ' exited' : ''}${item.attention ? ' attention' : ''}`
    el.dataset.tabId = item.id
    if (item.attention) el.style.animationDelay = pulseDelay()
    el.draggable = true
    el.title = `${item.title}\n${item.folder}`
    const parts = tabParts(item, this.platform, this.cb)
    el.append(parts.icon, parts.label, ...parts.marks, parts.close)
    bindTab(el, item, this.cb, () => this.startRename(parts.label, item))
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

  private startRename(label: HTMLElement, item: TabBarItem): void {
    this.editing = item.id
    beginRename(label, item.title, (title) => this.cb.rename(item.id, title), () => {
      this.editing = null
      this.render(this.items, this.activeId)
    })
  }
}
