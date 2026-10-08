export type PanelTab = 'images' | 'changes'

const TABS: readonly PanelTab[] = ['images', 'changes']
const LABELS: Record<PanelTab, string> = { images: 'Images', changes: 'Changes' }
/** how wide a drag may make each tab, as a share of the window */
const MAX_SHARE: Record<PanelTab, number> = { images: 0.7, changes: 0.85 }
const EXPANDED_SHARE = 0.85
const MIN_WIDTH = 180

/** The right-hand panel: Images and Changes, one shown at a time, each with its own width. */
export class SidePanel {
  readonly bodies: Record<PanelTab, HTMLElement>
  /** Changes puts its buttons here */
  readonly tools: HTMLElement
  /** shown, hidden, switched or expanded */
  onChange: () => void = () => {}
  private shownTab: PanelTab | null = null
  private currentTab: PanelTab = 'images'
  private isExpanded = false
  private readonly title: HTMLElement
  private readonly available: Record<PanelTab, boolean> = { images: true, changes: false }

  constructor(private readonly root: HTMLElement, private readonly widths: Record<PanelTab, number>) {
    const handle = document.createElement('div')
    handle.className = 'panel-resize'
    const header = document.createElement('div')
    header.className = 'panel-header'
    this.title = document.createElement('span')
    this.title.className = 'panel-title'
    this.tools = document.createElement('div')
    this.tools.className = 'panel-tools'
    const hide = document.createElement('button')
    hide.className = 'panel-hide'
    hide.textContent = '–'
    hide.title = 'Hide'
    hide.addEventListener('click', () => this.hide())
    header.append(this.title, this.tools, hide)
    const body = (tab: PanelTab): HTMLElement => {
      const el = document.createElement('div')
      el.className = `panel-body panel-${tab}`
      return el
    }
    this.bodies = { images: body('images'), changes: body('changes') }
    root.replaceChildren(handle, header, this.bodies.images, this.bodies.changes)
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
    if (tab !== 'changes') this.isExpanded = false
    this.apply()
    this.onChange()
  }

  hide(): void {
    if (this.shownTab === null) return
    this.shownTab = null
    this.isExpanded = false
    this.apply()
    this.onChange()
  }

  toggle(tab: PanelTab): void {
    if (this.shownTab === tab) this.hide()
    else this.open(tab)
  }

  /** Changes exists only for Claude tabs: a shell tab shows Images in its place */
  setAvailable(tab: PanelTab, available: boolean): void {
    if (this.available[tab] === available) return
    this.available[tab] = available
    if (available || this.currentTab !== tab) return
    this.currentTab = tab === 'changes' ? 'images' : 'changes'
    if (this.shownTab !== null) this.shownTab = this.currentTab
    this.isExpanded = false
    this.apply()
    this.onChange()
  }

  setExpanded(on: boolean): void {
    const next = on && this.shownTab === 'changes'
    if (next === this.isExpanded) return
    this.isExpanded = next
    this.apply()
    this.onChange()
  }

  private apply(): void {
    this.root.classList.toggle('collapsed', this.shownTab === null)
    this.root.classList.toggle('expanded', this.isExpanded)
    for (const t of TABS) this.bodies[t].hidden = this.currentTab !== t
    this.title.textContent = LABELS[this.currentTab]
    this.tools.hidden = this.currentTab !== 'changes'
    const width = this.isExpanded ? Math.round(window.innerWidth * EXPANDED_SHARE) : this.widths[this.currentTab]
    this.root.style.width = `${width}px`
  }

  private setupResize(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const tab = this.currentTab
      const startX = e.clientX
      const startW = this.root.getBoundingClientRect().width
      this.isExpanded = false
      this.root.classList.remove('expanded')
      const move = (ev: MouseEvent): void => {
        this.widths[tab] = Math.min(Math.max(startW + (startX - ev.clientX), MIN_WIDTH), Math.round(window.innerWidth * MAX_SHARE[tab]))
        this.root.style.width = `${this.widths[tab]}px`
      }
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        this.onChange()
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
  }
}
