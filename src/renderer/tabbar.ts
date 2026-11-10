import { REMOTE_COPY } from '../shared/remote'
import type { TabActivity, TabKind, TabPlace } from '../shared/types'
import { TabHeader } from './tab-header'
import { beginRename, bindTab, mailMark, pulseDelay, spinner, tabParts } from './tab-row'

export interface TabBarItem {
  id: string
  title: string
  /** the folder the tab works in: the one it was opened in, or the one Claude moved to */
  folder: string
  kind: TabKind
  /** the tab makes no notification sound */
  muted: boolean
  bell: boolean
  /** the tab has unread agent messages: an envelope shows on it, and on its device's chip when folded */
  mail: boolean
  /** Claude in this tab is waiting for the user */
  attention: boolean
  /** what Claude is doing in the tab; the icon spins for it unless Claude waits for the user */
  activity: TabActivity
  images: number
  exited: boolean
  /** the tab's note has text */
  note: boolean
  /** where the tab's folder is in git; null outside a repository (or before git has answered) */
  place: TabPlace | null
  /** the head of the tab's family when the tab is a fork; null for an ordinary tab */
  forkOf: string | null
  /** the id of the device the tab runs on; null: this device's own tab */
  group: string | null
  /** the name of the device a remote tab runs on */
  deviceName: string | null
  /** the tab's device is offline: the tab is dimmed */
  dim: boolean
}

/** a device whose tabs this device shows in the tab bar, as a chip before them */
export interface TabBarGroup {
  id: string
  name: string
  color: string
  online: boolean
  folded: boolean
  /** its number of tabs, shown on the chip when folded */
  count: number
  /** one of its tabs has attention: shown on the chip when folded */
  attention: boolean
  /** one of its tabs has unread agent messages: the envelope shows on the chip when folded, and on the device header in the left panel */
  mail: boolean
  /** one of its tabs is working (the spinner shows on the chip when folded) */
  working: boolean
}

export interface TabBarCallbacks {
  activate(id: string): void
  close(id: string): void
  rename(id: string, title: string | null): void
  /** the ids of one group (null: this device's own tabs), in their new order */
  reorder(ids: string[], group: string | null): void
  newTab(): void
  openMenu(anchor: HTMLElement): void
  tabMenu(id: string, at: { x: number; y: number }): void
  toggleGroup(id: string): void
  groupMenu(id: string, at: { x: number; y: number }): void
  toggleImages(): void
  toggleChanges(): void
  toggleDocs(): void
  toggleMessages(): void
  toggleNote(): void
  switchPosition(): void
}

/** the drag's data type that names the tab dragged: a drag without it (a file from the OS, say) is no tab drag */
export const TAB_DRAG = 'application/x-claudeterm-tab'

/** whether a drag carries the data type: only then does a row take it */
export const dragCarries = (e: DragEvent, type: string): boolean => e.dataTransfer?.types.includes(type) ?? false

export class TabBar {
  private editing: string | null = null
  private items: TabBarItem[] = []
  private groups: TabBarGroup[] = []
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
    this.root.replaceChildren(...(visible ? [this.list, h.plus, h.more, h.changes, h.docs, h.images, h.messages, h.note, h.position] : []))
  }

  /** this device's tabs first, then each group's chip with its tabs (none when folded); a group without tabs has no chip */
  render(items: TabBarItem[], activeId: string | null, groups: TabBarGroup[] = []): void {
    this.items = items
    this.activeId = activeId
    this.groups = groups
    if (this.editing) return
    const list = document.createElement('div')
    list.className = 'tabs'
    for (const item of items.filter((i) => i.group === null)) list.append(this.renderTab(item, item.id === activeId))
    for (const g of groups) {
      const tabs = items.filter((i) => i.group === g.id)
      if (tabs.length === 0) continue
      list.append(this.renderChip(g))
      if (!g.folded) for (const item of tabs) list.append(this.renderTab(item, item.id === activeId))
    }
    this.list.replaceWith(list)
    this.list = list
  }

  private renderChip(g: TabBarGroup): HTMLElement {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = `tab-group-chip${g.online ? '' : ' offline'}`
    chip.dataset.deviceId = g.id
    chip.style.setProperty('--group-color', g.color)
    chip.textContent = g.online ? g.name : `${g.name} ${REMOTE_COPY.offline}`
    if (g.folded) {
      const count = document.createElement('span')
      count.className = 'tab-group-count'
      count.textContent = String(g.count)
      chip.append(count)
      if (g.mail) chip.append(mailMark())
      if (g.working) chip.append(spinner('tab-group-spin'))
      if (g.attention) {
        const dot = document.createElement('span')
        dot.className = 'tab-group-attention'
        chip.append(dot)
      }
    }
    chip.addEventListener('click', () => this.cb.toggleGroup(g.id))
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.cb.groupMenu(g.id, { x: e.clientX, y: e.clientY })
    })
    return chip
  }

  /** the Changes button exists only for Claude tabs; it shows the files not yet viewed */
  setChanges(available: boolean, visible: boolean, unviewed: number): void {
    this.header.setChanges(available, visible, unviewed)
  }

  /** the Docs button is hidden while the tab has no document to show; it is lit while the Docs panel is shown */
  setDocs(available: boolean, visible: boolean): void {
    this.header.setDocs(available, visible)
  }

  setImages(visible: boolean, unseen: number): void {
    this.header.setImages(visible, unseen)
  }

  /** the Messages button exists while agent messages are on; it counts the unread messages of the active tab */
  setMessages(available: boolean, visible: boolean, unread: number): void {
    this.header.setMessages(available, visible, unread)
  }

  /** the Note button exists only for Claude tabs; it is lit while the note is shown */
  setNote(available: boolean, visible: boolean): void {
    this.header.setNote(available, visible)
  }

  private renderTab(item: TabBarItem, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}${item.exited ? ' exited' : ''}${item.attention ? ' attention' : ''}${item.group !== null ? ' remote' : ''}${item.dim ? ' dim' : ''}`
    el.dataset.tabId = item.id
    if (item.group !== null) el.style.setProperty('--group-color', this.groupColor(item.group))
    if (item.attention) el.style.animationDelay = pulseDelay()
    el.draggable = true
    el.title = item.group === null || item.deviceName === null ? `${item.title}\n${item.folder}` : REMOTE_COPY.tabTooltip(item.title, item.deviceName, item.folder)
    const parts = tabParts(item, this.platform, this.cb)
    el.append(parts.icon, parts.label, ...parts.marks, parts.close)
    bindTab(el, item, this.cb, () => this.startRename(parts.label, item))
    el.addEventListener('dragstart', (e) => { e.dataTransfer?.setData(TAB_DRAG, item.id) })
    el.addEventListener('dragover', (e) => { if (dragCarries(e, TAB_DRAG)) e.preventDefault() })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      this.dropOn(item.id, e.dataTransfer?.getData(TAB_DRAG) ?? '')
    })
    return el
  }

  private groupColor(id: string): string {
    return this.groups.find((g) => g.id === id)?.color ?? ''
  }

  /** `from` is the tab named in the drop's own data: a drop that names none moves nothing; a tab moves within its own group only */
  private dropOn(targetId: string, from: string): void {
    if (!from || from === targetId) return
    const dragged = this.items.find((i) => i.id === from)
    const target = this.items.find((i) => i.id === targetId)
    if (!dragged || !target || dragged.group !== target.group) return
    const all = this.items.filter((i) => i.group === target.group).map((i) => i.id)
    const fromIdx = all.indexOf(from)
    const toIdx = all.indexOf(targetId)
    const ids = all.filter((id) => id !== from)
    const t = ids.indexOf(targetId)
    ids.splice(fromIdx < toIdx ? t + 1 : t, 0, from)
    this.cb.reorder(ids, target.group)
  }

  private startRename(label: HTMLElement, item: TabBarItem): void {
    this.editing = item.id
    beginRename(label, item.title, (title) => this.cb.rename(item.id, title), () => {
      this.editing = null
      this.render(this.items, this.activeId)
    })
  }
}
