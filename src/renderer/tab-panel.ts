import { clampTabPanelWidth, MAX_FOLDED_GROUPS, WORKTREE_COLORS, type TabLayout } from '../shared/types'
import { REMOTE_COPY } from '../shared/remote'
import { deviceGroups, groupLabels, moveGroup, moveTab, panelGroups, panelOrder, type PanelGroup, type PanelRow } from './tab-groups'
import { TabHeader } from './tab-header'
import { beginRename, bindTab, mailMark, pulseDelay, shownActivity, spinner, tabParts } from './tab-row'
import { dragCarries, TAB_DRAG, type TabBarCallbacks, type TabBarGroup, type TabBarItem } from './tabbar'

/** the drag's data type that names the group dragged by its header */
const GROUP_DRAG = 'application/x-claudeterm-group'

const BRANCH_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<circle cx="5" cy="3.5" r="1.6"/><circle cx="5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5" r="1.6"/><path d="M5 5.1v5.8M11.5 6.6c0 3-6.5 2.2-6.5 4.3"/></svg>'

/** a part of the panel: this device's own groups (device null), or another device's section with its groups */
interface Section {
  device: TabBarGroup | null
  groups: PanelGroup[]
}

/**
 * The left tab panel: the header buttons, then this device's tabs as groups by project, each group with its tabs in rows
 * of two lines (the title, and the branch of the tab's folder). Then one section per other device that has tabs or is
 * online: its header, and its tabs grouped the same way. Groups fold on a click on their header, a device on a click on its header;
 * the panel's right edge is dragged to change its width. Its items and callbacks are the tab bar's: main shows one or the other.
 */
export class TabPanel {
  private readonly header: TabHeader
  private readonly head = document.createElement('div')
  private readonly list = document.createElement('div')
  private readonly handle = document.createElement('div')
  private items: TabBarItem[] = []
  /** the other devices, as the tab bar's chips show them: their sections come in this order */
  private devices: TabBarGroup[] = []
  private activeId: string | null = null
  /** the groups the user folded or unfolded while this tab was the active one: its place arriving later keeps their fold */
  private toggled: { tab: string | null; keys: Set<string> } = { tab: null, keys: new Set() }
  private editing: string | null = null
  private readonly folded: Set<string>
  private width: number
  /** the active tab whose row was last brought into view */
  private revealed: string | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: TabBarCallbacks,
    private readonly platform: string,
    layout: TabLayout,
    private readonly saveLayout: (change: Partial<TabLayout>) => void
  ) {
    this.folded = new Set(layout.folded)
    this.header = new TabHeader(cb, platform, 'left')
    this.head.className = 'tp-head'
    const spacer = document.createElement('div')
    spacer.className = 'tp-spacer'
    const h = this.header
    this.head.replaceChildren(h.plus, h.more, spacer, h.changes, h.docs, h.images, h.messages, h.note, h.position)
    this.list.className = 'tp-list'
    this.handle.className = 'tp-resize'
    this.width = clampTabPanelWidth(layout.width)
    root.style.width = `${this.width}px`
    this.wireResize(this.handle)
  }

  /** the panel is in the page only while it is shown: a hidden one would still match the selectors of the shown tab bar */
  show(visible: boolean): void {
    this.root.replaceChildren(...(visible ? [this.head, this.list, this.handle] : []))
    // the list's scroll is lost while the panel is out of the page: the active row is brought back into view
    if (visible) this.revealActive()
  }

  /** this device's tab ids in the order the panel shows them: group by group, folded groups included; no other device's */
  get visualOrder(): string[] {
    return panelOrder(this.sections()[0].groups)
  }

  /** the tab ids of the device sections not folded, in the order the panel shows them: the keyboard walks them after this device's */
  deviceOrder(folded: ReadonlySet<string>): string[] {
    return this.sections().flatMap((s) => (s.device === null || folded.has(s.device.id) ? [] : panelOrder(s.groups)))
  }

  render(items: TabBarItem[], activeId: string | null, groups: TabBarGroup[] = []): void {
    this.items = items
    this.activeId = activeId
    this.devices = groups
    this.draw()
  }

  /** the panel as the items and the devices say now; the scroll, the folds and an edit in progress are kept */
  private draw(): void {
    if (this.editing) return
    const byId = new Map(this.items.map((item) => [item.id, item]))
    this.list.replaceChildren(...this.sections().flatMap((section) => this.renderSection(section, byId)))
    // a tab that became the active one is brought into view once its row is in the list (a folded group has none yet)
    if (this.activeId !== this.revealed && this.list.querySelector('.tp-tab.active')) {
      this.revealed = this.activeId
      this.revealActive()
    }
  }

  private revealActive(): void {
    this.list.querySelector<HTMLElement>('.tp-tab.active')?.scrollIntoView({ block: 'nearest' })
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

  /**
   * a tab that becomes the active one shows: its group unfolds, and that is kept; a folded device stays folded. With
   * `keepUserFold` (its place has just arrived) a group the user folded since the tab became the active one stays folded.
   */
  unfoldFor(tabId: string, keepUserFold = false): void {
    for (const section of this.sections()) {
      const group = section.groups.find((g) => g.rows.some((r) => r.id === tabId))
      if (!group) continue
      if (!this.folded.has(group.key) || section.device?.folded) return
      if (keepUserFold && this.toggled.tab === tabId && this.toggled.keys.has(group.key)) return
      this.folded.delete(group.key)
      this.saveFolded()
      this.draw()
      return
    }
  }

  /** the folded groups are saved, at most MAX_FOLDED_GROUPS of them: the ones folded longest ago give way */
  private saveFolded(): void {
    const keys = [...this.folded]
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_FOLDED_GROUPS))) this.folded.delete(key)
    this.saveLayout({ folded: [...this.folded] })
  }

  /**
   * The panel's parts in the order it shows them: this device's groups, then a section for each other device that has
   * tabs or is online. An online device with no tab keeps its header, the place to open a tab there from.
   */
  private sections(): Section[] {
    const own = this.items.filter((item) => item.group === null)
    return [
      { device: null, groups: panelGroups(own) },
      ...this.devices.flatMap((device) => {
        const tabs = this.items.filter((item) => item.group === device.id)
        return tabs.length === 0 && !device.online ? [] : [{ device, groups: deviceGroups(device.id, tabs) }]
      })
    ]
  }

  private renderSection(section: Section, byId: Map<string, TabBarItem>): HTMLElement[] {
    const device = section.device
    if (device === null) return this.renderGroups(section, byId)
    const empty = section.groups.length === 0
    // a device with no tab has nothing to fold: it is shown unfolded, whatever its fold says
    const folded = device.folded && !empty
    const el = document.createElement('div')
    el.className = `tp-section${device.online ? '' : ' offline'}${folded ? ' folded' : ''}${empty ? ' empty' : ''}`
    el.style.setProperty('--dc', device.color)
    el.append(this.renderDeviceHead(device, folded, empty))
    // a folded device shows its header only: its count and its attention dot, as its chip does
    if (!folded) el.append(...this.renderGroups(section, byId))
    return [el]
  }

  /**
   * Another device's header: its colour bar, its name (with the offline note), and folded, its count and attention dot.
   * Online, it has a + that opens the device's menu of new tabs; with no tab, a click anywhere on it does the same.
   */
  private renderDeviceHead(device: TabBarGroup, folded: boolean, empty: boolean): HTMLElement {
    const head = document.createElement('div')
    head.className = 'tp-device'
    head.dataset.deviceId = device.id
    const menuUnder = (el: HTMLElement): void => {
      const r = el.getBoundingClientRect()
      this.cb.groupMenu(device.id, { x: r.left, y: r.bottom })
    }
    head.addEventListener('click', () => {
      if (empty) menuUnder(head)
      else this.cb.toggleGroup(device.id)
    })
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.cb.groupMenu(device.id, { x: e.clientX, y: e.clientY })
    })
    const chevron = document.createElement('span')
    chevron.className = 'tp-chevron'
    chevron.textContent = '▼'
    const bar = document.createElement('span')
    bar.className = 'tp-device-bar'
    const name = document.createElement('span')
    name.className = 'tp-device-name'
    name.textContent = device.online ? device.name : `${device.name} ${REMOTE_COPY.offline}`
    head.append(chevron, bar, name)
    if (device.mail) head.append(mailMark())
    if (device.online) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'tp-device-new'
      add.textContent = '+'
      add.title = REMOTE_COPY.newTabOn(device.name)
      add.addEventListener('click', (e) => {
        // the + opens the menu; the header's own click would fold the device
        e.stopPropagation()
        menuUnder(add)
      })
      head.append(add)
    }
    if (folded) {
      const count = document.createElement('span')
      count.className = 'tp-device-count'
      count.textContent = String(device.count)
      head.append(count)
      if (device.working) head.append(spinner('tp-group-spin'))
      if (device.attention) {
        const dot = document.createElement('span')
        dot.className = 'tp-group-dot pulse'
        head.append(dot)
      }
    }
    return head
  }

  private renderGroups(section: Section, byId: Map<string, TabBarItem>): HTMLElement[] {
    const labels = groupLabels(section.groups)
    return section.groups.map((group) => this.renderGroup(section, group, labels.get(group.key) ?? '', byId))
  }

  private renderGroup(section: Section, group: PanelGroup, label: string, byId: Map<string, TabBarItem>): HTMLElement {
    const folded = this.folded.has(group.key)
    const el = document.createElement('div')
    el.className = `tp-group${folded ? ' folded' : ''}`
    el.dataset.group = group.key

    const head = document.createElement('div')
    head.className = 'tp-group-head'
    head.addEventListener('click', () => this.toggleFold(group.key))
    head.draggable = true
    head.addEventListener('dragstart', (e) => { e.dataTransfer?.setData(GROUP_DRAG, group.key) })
    head.addEventListener('dragover', (e) => { if (dragCarries(e, GROUP_DRAG)) e.preventDefault() })
    head.addEventListener('drop', (e) => {
      e.preventDefault()
      this.dropGroup(section, group.key, e.dataTransfer?.getData(GROUP_DRAG) ?? '')
    })
    const chevron = document.createElement('span')
    chevron.className = 'tp-chevron'
    chevron.textContent = '▼'
    const name = document.createElement('span')
    name.className = 'tp-group-name'
    name.textContent = label
    head.append(chevron, name)
    el.append(head)

    if (folded) {
      // a folded group shows how many tabs it holds, and a dot: pulsing when Claude waits in one of them, steady for a bell
      const members = group.rows.flatMap((r) => byId.get(r.id) ?? [])
      const count = document.createElement('span')
      count.className = 'tp-group-count'
      count.textContent = String(members.length)
      head.append(count)
      // and the spinning icon while Claude works in one of them
      if (members.some(shownActivity)) head.append(spinner('tp-group-spin'))
      const attention = members.some((m) => m.attention)
      if (attention || members.some((m) => m.bell)) {
        const dot = document.createElement('span')
        dot.className = `tp-group-dot${attention ? ' pulse' : ''}`
        head.append(dot)
      }
    } else {
      for (const row of group.rows) {
        const item = byId.get(row.id)
        if (item) el.append(this.renderRow(section, item, row, item.id === this.activeId))
      }
    }
    return el
  }

  private renderRow(section: Section, item: TabBarItem, row: PanelRow, active: boolean): HTMLElement {
    const place = item.place
    const el = document.createElement('div')
    const remote = item.group !== null
    el.className = `tp-tab${active ? ' active' : ''}${item.exited ? ' exited' : ''}${item.attention ? ' attention' : ''}${row.fork ? ' fork' : ''}${remote ? ' remote' : ''}${item.dim ? ' dim' : ''}`
    el.dataset.tabId = item.id
    if (item.attention) el.style.animationDelay = pulseDelay()
    el.draggable = true
    el.addEventListener('dragstart', (e) => { e.dataTransfer?.setData(TAB_DRAG, item.id) })
    el.addEventListener('dragover', (e) => { if (dragCarries(e, TAB_DRAG)) e.preventDefault() })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      this.dropTab(section, item.id, e.dataTransfer?.getData(TAB_DRAG) ?? '')
    })
    const tooltip = remote && item.deviceName !== null ? [REMOTE_COPY.tabTooltip(item.title, item.deviceName, item.folder)] : [item.title, item.folder]
    if (place) tooltip.push(`branch: ${place.branch}`)
    if (place?.worktree) tooltip.push(`worktree: ${place.worktree.path}`)
    el.title = tooltip.join('\n')

    if (place?.worktree) {
      const bar = document.createElement('span')
      bar.className = 'tp-wtbar'
      bar.style.background = WORKTREE_COLORS[place.worktree.color]
      el.append(bar)
    }

    const parts = tabParts(item, this.platform, this.cb)
    const line = document.createElement('div')
    line.className = 'tp-l1'
    if (row.fork) {
      const mark = document.createElement('span')
      mark.className = 'tp-fork'
      mark.textContent = '↳'
      line.append(mark)
    }
    line.append(parts.icon, parts.label, ...parts.marks, parts.close)
    el.append(line)

    if (place) {
      const branch = document.createElement('div')
      branch.className = 'tp-branch'
      branch.innerHTML = BRANCH_ICON
      const text = document.createElement('span')
      text.textContent = place.branch
      branch.append(text)
      if (place.worktree) branch.style.color = WORKTREE_COLORS[place.worktree.color]
      el.append(branch)
    }

    bindTab(el, item, this.cb, () => this.startRename(parts.label, item))
    return el
  }

  /** a row dropped on another row of its section: the tab order the drop answers, when it is allowed, goes to main for that device; `from` is the drag's own tab id */
  private dropTab(section: Section, targetId: string, from: string): void {
    if (!from) return
    const order = moveTab(section.groups, from, targetId)
    if (order) this.cb.reorder(order, section.device?.id ?? null)
  }

  /** a group header dropped on another header of its section: the groups move, the tab order goes to main for that device */
  private dropGroup(section: Section, targetKey: string, from: string): void {
    if (!from) return
    const order = moveGroup(section.groups, from, targetKey)
    if (order) this.cb.reorder(order, section.device?.id ?? null)
  }

  private toggleFold(key: string): void {
    if (this.toggled.tab !== this.activeId) this.toggled = { tab: this.activeId, keys: new Set() }
    this.toggled.keys.add(key)
    if (this.folded.has(key)) this.folded.delete(key)
    else this.folded.add(key)
    this.saveFolded()
    this.draw()
  }

  private startRename(label: HTMLElement, item: TabBarItem): void {
    this.editing = item.id
    beginRename(label, item.title, (title) => this.cb.rename(item.id, title), () => {
      this.editing = null
      this.draw()
    })
  }

  /** dragging the right edge sets the width; it is saved when the mouse is released */
  private wireResize(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = this.width
      const move = (ev: MouseEvent): void => this.setWidth(startWidth + ev.clientX - startX)
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        this.saveLayout({ width: this.width })
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
  }

  private setWidth(px: number): void {
    this.width = clampTabPanelWidth(px)
    this.root.style.width = `${this.width}px`
  }
}
