import type { CoordMark } from '../shared/coordinator'
import { REMOTE_COPY } from '../shared/remote'
import { WORKTREE_COLORS, type TabActivity, type TabKind, type TabPlace } from '../shared/types'
import { arrangeCoordinators, dropAttaches, groupLabels, moveInGroup, panelOrder, showsGroupLabels, storedGroups, type DropRow, type PanelGroup } from './tab-groups'
import { TabHeader } from './tab-header'
import { beginRename, bindTab, mailMark, pulseDelay, shownActivity, spinner, tabParts } from './tab-row'

/** what Claude waits for in a tab: a question, a permission, or the user to read the turn it finished */
export type TabWaiting = 'question' | 'permission' | 'done'

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
  /** what it waits for, named on its row in the left panel; null: nothing, or the tab is only marked unread */
  waiting: TabWaiting | null
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
  /** the tab's part in a coordinator of this device; null: none */
  coord: CoordMark | null
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
  /** the left panel's foot: the Recent sessions window and the Settings window */
  openRecent(): void
  openSettings(): void
  /** the Settings window at its Notifications section */
  openNotifications(): void
  openMenu(anchor: HTMLElement): void
  tabMenu(id: string, at: { x: number; y: number }): void
  toggleGroup(id: string): void
  groupMenu(id: string, at: { x: number; y: number }): void
  toggleImages(): void
  toggleChanges(): void
  toggleDocs(): void
  toggleMessages(): void
  toggleSessions(): void
  /** Detach of an attached session, from its header */
  detachTab(id: string): void
  /** a tab dropped on a coordinator's tab or row: the coordinator takes it as an attached session */
  attachTab(coordinatorId: string, tabId: string): void
  /** + Coordinator on a project group's header in the left panel: a tab of this device in the group */
  startCoordinator(tabId: string): void
  toggleNote(): void
  switchPosition(): void
}

/** the drag's data type that names the tab dragged: a drag without it (a file from the OS, say) is no tab drag */
export const TAB_DRAG = 'application/x-claudeterm-tab'

/** whether a drag carries the data type: only then does a row take it */
export const dragCarries = (e: DragEvent, type: string): boolean => e.dataTransfer?.types.includes(type) ?? false

/** the tab a drag of the bar or the panel carries: its data cannot be read during the drag, so dragover reads this to light a drop target */
let dragging: string | null = null
export const draggingTab = (): string | null => dragging
export function setDragging(id: string | null): void {
  dragging = id
}

/** a drag is over: it lost its tab, and no drop target keeps its light */
function endDrag(): void {
  setDragging(null)
  for (const el of document.querySelectorAll('.coord-drop')) el.classList.remove('coord-drop')
}
// a drag ends with a drop or a dragend anywhere; one that leaves the window (no element entered) ends too
document.addEventListener('dragend', endDrag, true)
document.addEventListener('drop', endDrag, true)
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) endDrag() })

/** a tab as the coordinator drop rules read it: this device's Claude tab, its mark, and the block it stands in */
export const dropRowOf = (item: TabBarItem, block: string | null): DropRow => ({ id: item.id, claude: item.kind === 'claude', local: item.group === null, coord: item.coord, block })

/** the line between two groups of the bar, and before the first device chip */
const groupSeparator = (): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'tb-group-sep'
  return el
}

export class TabBar {
  private editing: string | null = null
  private items: TabBarItem[] = []
  private groups: TabBarGroup[] = []
  private activeId: string | null = null
  private readonly header: TabHeader
  private list = document.createElement('div')
  private readonly spacer = document.createElement('div')
  /** the active tab whose pill was last brought into view, and its place among the pills then */
  private revealed: { id: string; at: number } | null = null

  /** the buttons are built once: a re-render (a busy Claude retitles its tab every second) must not drop a click or a tooltip */
  constructor(private readonly root: HTMLElement, private readonly cb: TabBarCallbacks, private readonly platform: string) {
    this.list.className = 'tabs'
    this.spacer.className = 'tb-spacer'
    this.header = new TabHeader(cb, platform, 'top')
  }

  /** the bar is in the page only while it is shown: a hidden one would still match the selectors of the shown one */
  show(visible: boolean): void {
    const h = this.header
    this.root.replaceChildren(...(visible ? [this.list, h.plus, h.more, this.spacer, h.position] : []))
    if (visible) this.revealActive()
  }

  /** this device's tab ids in the order the bar shows them: group by group, as the left panel groups them; no other device's */
  get visualOrder(): string[] {
    return panelOrder(this.ownGroups(this.items))
  }

  /** this device's groups as the bar shows them: each group's tabs in their order, a coordinator's attached tabs right after it */
  private ownGroups(items: TabBarItem[]): PanelGroup[] {
    const coordOf = (id: string): CoordMark | null => items.find((i) => i.id === id)?.coord ?? null
    return arrangeCoordinators(storedGroups(items.filter((i) => i.group === null)), coordOf, false)
  }

  /**
   * this device's tabs first, grouped by project (each group after its label when there are several), then each group's
   * chip with its tabs (none when folded); a group without tabs has no chip
   */
  render(items: TabBarItem[], activeId: string | null, groups: TabBarGroup[] = []): void {
    this.items = items
    this.activeId = activeId
    this.groups = groups
    if (this.editing) return
    const list = document.createElement('div')
    list.className = 'tabs'
    const byId = new Map(items.map((item) => [item.id, item]))
    const own = this.ownGroups(items)
    const labelled = showsGroupLabels(own)
    const labels = groupLabels(own)
    own.forEach((group, n) => {
      if (n > 0) list.append(groupSeparator())
      if (labelled) list.append(this.renderGroupLabel(group, labels.get(group.key) ?? '', byId))
      for (const row of group.rows) {
        const item = byId.get(row.id)
        if (item) list.append(this.renderTab(item, item.id === activeId))
      }
    })
    let first = true
    for (const g of groups) {
      const tabs = items.filter((i) => i.group === g.id)
      if (tabs.length === 0) continue
      if (first && own.length > 0) list.append(groupSeparator())
      first = false
      list.append(this.renderChip(g))
      if (!g.folded) for (const item of tabs) list.append(this.renderTab(item, item.id === activeId))
    }
    // a re-render keeps the scroll; a tab that became the active one is brought into view, and so is the active tab when it
    // moved (its project became known, or the order changed)
    const scrolled = this.list.scrollLeft
    // the active tab was in view: it stays so when its pill grows (a title that arrives late widens it past the edge)
    const wasInView = this.activeInView()
    this.list.replaceWith(list)
    this.list = list
    list.scrollLeft = scrolled
    const at = [...list.querySelectorAll('.tab')].findIndex((pill) => pill.classList.contains('active'))
    if (activeId !== null && at >= 0 && (this.revealed?.id !== activeId || this.revealed.at !== at)) {
      this.revealed = { id: activeId, at }
      this.revealActive()
    } else if (wasInView && !this.activeInView()) {
      this.revealActive()
    }
  }

  /** the active pill lies within the list's visible width (a bar not in the page, or without an active pill, counts as in view) */
  private activeInView(): boolean {
    const pill = this.list.querySelector<HTMLElement>('.tab.active')
    if (!pill || !this.list.isConnected) return true
    const box = pill.getBoundingClientRect()
    const view = this.list.getBoundingClientRect()
    return box.left >= view.left - 1 && box.right <= view.right + 1
  }

  private revealActive(): void {
    this.list.querySelector<HTMLElement>('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }

  /** an own group's name, and a pulsing dot while one of its tabs is working */
  private renderGroupLabel(group: PanelGroup, label: string, byId: Map<string, TabBarItem>): HTMLElement {
    const el = document.createElement('div')
    el.className = 'tb-group-label'
    el.dataset.group = group.key
    el.textContent = label
    const members = group.rows.flatMap((r) => byId.get(r.id) ?? [])
    if (members.some((m) => shownActivity(m))) {
      const dot = document.createElement('span')
      dot.className = 'tb-group-dot pulse'
      el.append(dot)
    }
    return el
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
        // the same breathing badge as a tab's, in the same phase
        const dot = document.createElement('span')
        dot.className = 'tab-group-attention'
        dot.style.setProperty('--pulse-delay', pulseDelay())
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

  private renderTab(item: TabBarItem, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}${item.exited ? ' exited' : ''}${item.attention ? ' attention' : ''}${item.waiting === 'done' ? ' attn-done' : ''}${item.group !== null ? ' remote' : ''}${item.dim ? ' dim' : ''}`
    el.dataset.tabId = item.id
    // the tab's soft pulse runs on the badge's clock, so a redraw carries it on in step with the badge
    if (item.attention) el.style.setProperty('--pulse-delay', pulseDelay())
    if (item.group !== null) el.style.setProperty('--group-color', this.groupColor(item.group))
    el.draggable = true
    el.title = item.group === null || item.deviceName === null ? `${item.title}\n${item.folder}` : REMOTE_COPY.tabTooltip(item.title, item.deviceName, item.folder)
    const parts = tabParts(item, this.platform, this.cb)
    el.append(parts.icon, parts.label, ...(parts.coord ? [parts.coord] : []), ...parts.marks, parts.close)
    // a linked worktree's tab carries its worktree's colour along the bottom
    if (item.place?.worktree) {
      const line = document.createElement('span')
      line.className = 'tab-wtline'
      line.style.background = WORKTREE_COLORS[item.place.worktree.color]
      el.append(line)
    }
    bindTab(el, item, this.cb, () => this.startRename(parts.label, item))
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(TAB_DRAG, item.id)
      setDragging(item.id)
    })
    el.addEventListener('dragover', (e) => {
      if (!dragCarries(e, TAB_DRAG)) return
      e.preventDefault()
      el.classList.toggle('coord-drop', this.attaches(item))
    })
    el.addEventListener('dragleave', () => el.classList.remove('coord-drop'))
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      el.classList.remove('coord-drop')
      this.dropOn(item.id, e.dataTransfer?.getData(TAB_DRAG) ?? '')
    })
    return el
  }

  /** whether the tab dragged over `target` attaches to it as its coordinator */
  private attaches(target: TabBarItem): boolean {
    const from = draggingTab()
    const dragged = this.items.find((i) => i.id === from)
    return dragged !== undefined && dropAttaches(dropRowOf(dragged, null), dropRowOf(target, null))
  }

  private groupColor(id: string): string {
    return this.groups.find((g) => g.id === id)?.color ?? ''
  }

  /** `from` is the tab named in the drop's own data: a drop that names none moves nothing; a tab moves within its own group only */
  private dropOn(targetId: string, from: string): void {
    if (!from || from === targetId) return
    const dragged = this.items.find((i) => i.id === from)
    const target = this.items.find((i) => i.id === targetId)
    if (!dragged || !target) return
    // a coordinator's tab takes the tab dropped on it as an attached session
    if (dropAttaches(dropRowOf(dragged, null), dropRowOf(target, null))) {
      this.cb.attachTab(targetId, from)
      return
    }
    if (dragged.group !== target.group) return
    // this device's tabs move within their project group, in the order the bar shows them
    if (target.group === null) {
      const order = moveInGroup(this.ownGroups(this.items), from, targetId)
      if (order) this.cb.reorder(order, null)
      return
    }
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
