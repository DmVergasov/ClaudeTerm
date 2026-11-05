import type { PanelMode } from '../shared/types'

export type PanelTab = 'images' | 'changes' | 'docs'

const TABS: readonly PanelTab[] = ['images', 'changes', 'docs']
const LABELS: Record<PanelTab, string> = { images: 'Media', changes: 'Changes', docs: 'Docs' }
/** how wide a drag may make each tab, as a share of the window */
const MAX_SHARE: Record<PanelTab, number> = { images: 0.7, changes: 0.85, docs: 0.85 }
const MIN_WIDTH = 180
/** how long the terminal waits for the window to take the size main gave it */
const SETTLE_MS = 300

/** asks main to make room for the panel: its width, 0 when it closed; `resize` false after a drag of its edge */
export type MakeRoom = (width: number, resize: boolean) => Promise<PanelMode>

/**
 * The right-hand panel: Images and Changes, one shown at a time, each with its own width. It lies over the right of the
 * workspace; the terminal gives it room with a margin, except when the panel is shown over it (no room, or expanded).
 */
export class SidePanel {
  readonly bodies: Record<PanelTab, HTMLElement>
  /** each tab puts its buttons in its own group; only the current tab's group shows */
  readonly tools: Record<PanelTab, HTMLElement>
  /** shown, hidden, switched or expanded */
  onChange: () => void = () => {}
  private shownTab: PanelTab | null = null
  private currentTab: PanelTab = 'images'
  private isExpanded = false
  private readonly title: HTMLElement
  private readonly toolsBox: HTMLElement
  private readonly available: Record<PanelTab, boolean> = { images: true, changes: false, docs: false }
  private mode: PanelMode = 'beside'
  /** the width main was last asked to make room for */
  private asked = 0
  /** the latest change of room; an older one that ends later leaves the terminal alone */
  private moves = 0
  /** the terminal's width, kept while the window takes its new size */
  private held: number | null = null

  constructor(private readonly root: HTMLElement, private readonly terminals: HTMLElement, private readonly widths: Record<PanelTab, number>, private readonly makeRoom: MakeRoom) {
    const handle = document.createElement('div')
    handle.className = 'panel-resize'
    const header = document.createElement('div')
    header.className = 'panel-header'
    this.title = document.createElement('span')
    this.title.className = 'panel-title'
    this.toolsBox = document.createElement('div')
    this.toolsBox.className = 'panel-tools'
    const group = (): HTMLElement => {
      const el = document.createElement('span')
      el.className = 'panel-tool-group'
      return el
    }
    this.tools = { images: group(), changes: group(), docs: group() }
    this.toolsBox.append(this.tools.images, this.tools.changes, this.tools.docs)
    const hide = document.createElement('button')
    hide.className = 'panel-hide'
    hide.textContent = '–'
    hide.title = 'Hide'
    hide.addEventListener('click', () => this.hide())
    header.append(this.title, this.toolsBox, hide)
    const body = (tab: PanelTab): HTMLElement => {
      const el = document.createElement('div')
      el.className = `panel-body panel-${tab}`
      return el
    }
    this.bodies = { images: body('images'), changes: body('changes'), docs: body('docs') }
    root.replaceChildren(handle, header, this.bodies.images, this.bodies.changes, this.bodies.docs)
    this.setupResize(handle)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isExpanded && !e.defaultPrevented) this.setExpanded(false)
    })
    window.addEventListener('resize', () => this.apply())
    this.apply()
  }

  get visible(): boolean {
    return this.shownTab !== null
  }

  get tab(): PanelTab {
    return this.currentTab
  }

  get expanded(): boolean {
    return this.isExpanded
  }

  isShowing(tab: PanelTab): boolean {
    return this.shownTab === tab
  }

  open(tab: PanelTab): void {
    if (!this.available[tab] || this.shownTab === tab) return
    this.currentTab = tab
    this.shownTab = tab
    if (tab !== 'changes' && tab !== 'docs') this.isExpanded = false
    this.changed()
  }

  hide(): void {
    if (this.shownTab === null) return
    this.shownTab = null
    this.isExpanded = false
    this.changed()
  }

  toggle(tab: PanelTab): void {
    if (this.shownTab === tab) this.hide()
    else this.open(tab)
  }

  /** Changes exists only for Claude tabs: a shell tab shows Images in its place; a tab that becomes unavailable falls back to the first available one */
  setAvailable(tab: PanelTab, available: boolean): void {
    if (this.available[tab] === available) return
    this.available[tab] = available
    if (available || this.currentTab !== tab) return
    this.currentTab = TABS.find((t) => t !== tab && this.available[t])!
    if (this.shownTab !== null) this.shownTab = this.currentTab
    this.isExpanded = false
    this.changed()
  }

  setExpanded(on: boolean): void {
    const next = on && (this.shownTab === 'changes' || this.shownTab === 'docs')
    if (next === this.isExpanded) return
    this.isExpanded = next
    this.apply()
    this.onChange()
  }

  /** main changed how the panel is shown: the window was maximized or restored, or sidePanel.noRoom changed */
  setMode(mode: PanelMode): void {
    this.mode = mode
    if (this.held === null) this.apply()
  }

  private changed(): void {
    this.sync()
    this.apply()
    this.onChange()
  }

  /** the panel's width changed (opened, closed, switched): main widens or narrows the window for it */
  private sync(): void {
    const want = this.shownTab === null ? 0 : this.widths[this.currentTab]
    if (want === this.asked) return
    this.asked = want
    void this.move(want)
  }

  private async move(want: number): Promise<void> {
    const n = ++this.moves
    // the terminal keeps its width until the window has its new one: its process gets one resize, or none
    if (this.held === null) {
      this.held = this.terminals.getBoundingClientRect().width
      this.terminals.style.flex = `0 0 ${this.held}px`
    }
    let mode: PanelMode
    try {
      mode = await this.makeRoom(want, true)
    } catch {
      mode = 'narrow'
    }
    if (n !== this.moves) return
    if (mode === 'beside') await this.settled(this.held + want)
    if (n !== this.moves) return
    this.mode = mode
    this.held = null
    this.terminals.style.flex = ''
    this.apply()
  }

  /** resolves once the workspace is `width` px wide, or after SETTLE_MS when the window did not get that size */
  private settled(width: number): Promise<void> {
    const workspace = this.root.parentElement!
    const fits = (): boolean => Math.abs(workspace.clientWidth - width) <= 1
    if (fits()) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        window.removeEventListener('resize', check)
        resolve()
      }
      const check = (): void => { if (fits()) done() }
      const timer = setTimeout(done, SETTLE_MS)
      window.addEventListener('resize', check)
    })
  }

  private apply(): void {
    const shown = this.shownTab !== null
    this.root.classList.toggle('collapsed', !shown)
    this.root.classList.toggle('expanded', this.isExpanded)
    this.root.classList.toggle('overlay', shown && (this.isExpanded || this.mode === 'overlay'))
    for (const t of TABS) this.bodies[t].hidden = this.currentTab !== t
    this.title.textContent = LABELS[this.currentTab]
    this.toolsBox.hidden = this.currentTab === 'images'
    for (const t of TABS) this.tools[t].hidden = this.currentTab !== t
    const width = this.widths[this.currentTab]
    this.root.style.width = `${this.isExpanded ? window.innerWidth : width}px`
    // the expanded panel lies over the whole window, terminal and all; the terminal keeps the room it gave the panel
    this.terminals.style.marginRight = `${shown && this.mode !== 'overlay' ? width : 0}px`
    // what the panel covers of the terminal's right, for the note to sit left of it; the expanded panel covers the note too
    this.terminals.style.setProperty('--panel-cover', `${shown && this.mode === 'overlay' && !this.isExpanded ? width : 0}px`)
  }

  private setupResize(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const tab = this.currentTab
      const startX = e.clientX
      const startW = this.root.getBoundingClientRect().width
      this.isExpanded = false
      this.root.classList.add('resizing')
      const move = (ev: MouseEvent): void => {
        this.widths[tab] = Math.min(Math.max(startW + (startX - ev.clientX), MIN_WIDTH), Math.round(window.innerWidth * MAX_SHARE[tab]))
        this.apply()
      }
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        this.root.classList.remove('resizing')
        this.apply()
        // the terminal gave way: the window keeps its size and now holds the panel at this width
        this.asked = this.widths[tab]
        void this.makeRoom(this.asked, false).catch(() => undefined)
        this.onChange()
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
  }
}
