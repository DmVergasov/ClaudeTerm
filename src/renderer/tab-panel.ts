import { TAB_PANEL_WIDTH, type TabLayout } from '../shared/types'
import { groupLabels, panelGroups, panelOrder, type PanelGroup, type PanelRow } from './tab-groups'
import { TabHeader } from './tab-header'
import { beginRename, bindTab, pulseDelay, tabParts } from './tab-row'
import type { TabBarCallbacks, TabBarItem } from './tabbar'

/** a linked worktree's color: TabPlace.worktree.color is an index into this list */
export const WORKTREE_COLORS = ['#61afef', '#c678dd', '#56b6c2', '#98c379', '#e5c07b', '#be5046']

const BRANCH_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<circle cx="5" cy="3.5" r="1.6"/><circle cx="5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5" r="1.6"/><path d="M5 5.1v5.8M11.5 6.6c0 3-6.5 2.2-6.5 4.3"/></svg>'

const clampWidth = (px: number): number => Math.min(TAB_PANEL_WIDTH.max, Math.max(TAB_PANEL_WIDTH.min, Math.round(px)))

/**
 * The left tab panel: the header buttons, then the tabs as groups by project, each group with its tabs in rows of two
 * lines (the title, and the branch of the tab's folder). Groups fold on a click on their header; the panel's right edge
 * is dragged to change its width. Its items and callbacks are the tab bar's: main shows one or the other.
 */
export class TabPanel {
  private readonly header: TabHeader
  private readonly head = document.createElement('div')
  private readonly list = document.createElement('div')
  private readonly handle = document.createElement('div')
  private items: TabBarItem[] = []
  private activeId: string | null = null
  private editing: string | null = null
  private readonly folded: Set<string>
  private width: number

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
    this.head.replaceChildren(h.plus, h.more, spacer, h.changes, h.images, h.position)
    this.list.className = 'tp-list'
    this.handle.className = 'tp-resize'
    this.width = clampWidth(layout.width)
    root.style.width = `${this.width}px`
    this.wireResize(this.handle)
  }

  /** the panel is in the page only while it is shown: a hidden one would still match the selectors of the shown tab bar */
  show(visible: boolean): void {
    this.root.replaceChildren(...(visible ? [this.head, this.list, this.handle] : []))
  }

  /** the tab ids in the order the panel shows them: group by group, folded groups included */
  get visualOrder(): string[] {
    return panelOrder(panelGroups(this.items))
  }

  render(items: TabBarItem[], activeId: string | null): void {
    this.items = items
    this.activeId = activeId
    if (this.editing) return
    const byId = new Map(items.map((item) => [item.id, item]))
    const groups = panelGroups(items)
    const labels = groupLabels(groups)
    this.list.replaceChildren(...groups.map((group) => this.renderGroup(group, labels.get(group.key) ?? '', byId)))
  }

  /** the Changes button exists only for Claude tabs; it shows the files not yet viewed */
  setChanges(available: boolean, visible: boolean, unviewed: number): void {
    this.header.setChanges(available, visible, unviewed)
  }

  setImages(visible: boolean, unseen: number): void {
    this.header.setImages(visible, unseen)
  }

  /** a tab that becomes the active one shows: its group unfolds, and that is kept */
  unfoldFor(tabId: string): void {
    const group = panelGroups(this.items).find((g) => g.rows.some((r) => r.id === tabId))
    if (!group || !this.folded.has(group.key)) return
    this.folded.delete(group.key)
    this.saveLayout({ folded: [...this.folded] })
    this.render(this.items, this.activeId)
  }

  private renderGroup(group: PanelGroup, label: string, byId: Map<string, TabBarItem>): HTMLElement {
    const folded = this.folded.has(group.key)
    const el = document.createElement('div')
    el.className = `tp-group${folded ? ' folded' : ''}`
    el.dataset.group = group.key

    const head = document.createElement('div')
    head.className = 'tp-group-head'
    head.addEventListener('click', () => this.toggleFold(group.key))
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
      const attention = members.some((m) => m.attention)
      if (attention || members.some((m) => m.bell)) {
        const dot = document.createElement('span')
        dot.className = `tp-group-dot${attention ? ' pulse' : ''}`
        head.append(dot)
      }
    } else {
      for (const row of group.rows) {
        const item = byId.get(row.id)
        if (item) el.append(this.renderRow(item, row, item.id === this.activeId))
      }
    }
    return el
  }

  private renderRow(item: TabBarItem, row: PanelRow, active: boolean): HTMLElement {
    const place = item.place
    const el = document.createElement('div')
    el.className = `tp-tab${active ? ' active' : ''}${item.exited ? ' exited' : ''}${item.attention ? ' attention' : ''}${row.fork ? ' fork' : ''}`
    el.dataset.tabId = item.id
    if (item.attention) el.style.animationDelay = pulseDelay()
    const tooltip = [item.title, item.folder]
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

  private toggleFold(key: string): void {
    if (this.folded.has(key)) this.folded.delete(key)
    else this.folded.add(key)
    this.saveLayout({ folded: [...this.folded] })
    this.render(this.items, this.activeId)
  }

  private startRename(label: HTMLElement, item: TabBarItem): void {
    this.editing = item.id
    beginRename(label, item.title, (title) => this.cb.rename(item.id, title), () => {
      this.editing = null
      this.render(this.items, this.activeId)
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
    this.width = clampWidth(px)
    this.root.style.width = `${this.width}px`
  }
}
