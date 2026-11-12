import type { PanelMode } from '../shared/types'
import { icon } from './icons'

export type PanelTab = 'images' | 'changes' | 'docs' | 'messages'

const TABS: readonly PanelTab[] = ['images', 'changes', 'docs', 'messages']
const LABELS: Record<PanelTab, string> = { images: 'Media', changes: 'Changes', docs: 'Docs', messages: 'Agent messages' }
/** how wide a drag may make each tab, as a share of the workspace (the window less the left tab panel) */
const MAX_SHARE: Record<PanelTab, number> = { images: 0.7, changes: 0.85, docs: 0.85, messages: 0.85 }
const MIN_WIDTH = 180
/** how long a panel takes to slide in or out, and its content to fade out */
const MOTION_MS = 180
/** how long the terminal waits for the window to take the size main gave it: the renderer hears of the new size after main, and a busy machine can take a while */
const SETTLE_MS = 1000

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
  private readonly available: Record<PanelTab, boolean> = { images: true, changes: false, docs: false, messages: false }
  private mode: PanelMode = 'beside'
  /** the width main was last asked to make room for */
  private asked = 0
  /** the changes of the panel run one after another: each starts from the width drawn when its turn comes */
  private chain: Promise<void> = Promise.resolve()
  /** the changes queued or running */
  private queued = 0
  /** a change is queued or running: it owns the panel's and the main area's geometry until the last one ends */
  private moving = false
  /** the animations of the running slide */
  private anims: Animation[] = []

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
    this.tools = { images: group(), changes: group(), docs: group(), messages: group() }
    this.toolsBox.append(this.tools.images, this.tools.changes, this.tools.docs, this.tools.messages)
    const hide = document.createElement('button')
    hide.className = 'panel-hide'
    hide.innerHTML = icon('x', 14)
    hide.title = 'Hide'
    hide.addEventListener('click', () => this.hide())
    header.append(this.title, this.toolsBox, hide)
    const body = (tab: PanelTab): HTMLElement => {
      const el = document.createElement('div')
      el.className = `panel-body panel-${tab}`
      return el
    }
    this.bodies = { images: body('images'), changes: body('changes'), docs: body('docs'), messages: body('messages') }
    root.replaceChildren(handle, header, this.bodies.images, this.bodies.changes, this.bodies.docs, this.bodies.messages)
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
    const switching = this.shownTab !== null
    this.currentTab = tab
    this.shownTab = tab
    if (tab !== 'changes' && tab !== 'docs') this.isExpanded = false
    this.changed()
    // a panel switched to fades its content in, while the panel's width changes from one to the other
    if (switching && this.motionMs() > 0) this.bodies[tab].animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MS, easing: 'ease-out' })
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
    this.apply()
  }

  private changed(): void {
    this.sync()
    this.apply()
    this.onChange()
  }

  /** the panel's width changed (opened, closed, switched): main widens or narrows the window for it, after the slide before it has ended */
  private sync(): void {
    const want = this.shownTab === null ? 0 : this.widths[this.currentTab]
    if (want === this.asked) return
    this.asked = want
    this.queued++
    this.moving = true
    this.chain = this.chain.then(() => this.slideTo(want)).catch(() => undefined).then(() => this.idle())
  }

  /** the last queued change has ended: the panel's state is applied */
  private idle(): void {
    if (--this.queued > 0) return
    this.moving = false
    this.anims = []
    this.unpin()
    this.unhold()
    this.apply()
  }

  /**
   * One change: the panel slides from the width it is drawn at to `want` (0: closed), and the room for it changes with it:
   * - beside the window, a grown window is made before the panel slides in, and a shrunk one given back after it has slid
   *   out; the terminal's box is pinned at its width meanwhile, so it neither moves nor refits;
   * - with the room of the main area (narrow), the margin takes the panel's width slide for slide; the terminal's size is
   *   held while the box moves, and the terminal refits once, when the slide ends;
   * - over the terminal (overlay), only the panel slides.
   */
  private async slideTo(want: number): Promise<void> {
    const from = this.drawn()
    const ms = this.motionMs()
    const box = this.terminals.getBoundingClientRect().width
    const marginFrom = parseFloat(getComputedStyle(this.terminals).marginRight) || 0
    let mode = this.mode
    if (want > from) {
      // the window grows first: the room exists before the panel takes it
      this.pin(box)
      mode = await this.room(want)
      this.mode = mode
    }
    if (mode === 'beside') {
      this.pin(box)
      this.unhold()
      if (want > from) {
        await this.settled(box + want)
        this.terminals.style.marginRight = `${want}px`
        await this.slide(from, want, ms)
      } else {
        this.terminals.style.marginRight = `${want}px`
        await this.slide(from, want, ms)
        this.mode = await this.room(want)
        await this.settled(box + want)
      }
    } else {
      this.unpin()
      if (mode === 'narrow') this.hold()
      else this.unhold()
      const target = mode === 'narrow' ? want : 0
      this.terminals.style.marginRight = `${target}px`
      const margin = ms > 0 && marginFrom !== target
        ? this.terminals.animate([{ marginRight: `${marginFrom}px` }, { marginRight: `${target}px` }], { duration: ms, easing: 'ease-out' })
        : null
      if (margin) this.anims.push(margin)
      await Promise.all([this.slide(from, want, ms), margin?.finished.catch(() => undefined)])
      if (want <= from) this.mode = await this.room(want)
    }
  }

  /** the width the panel is drawn at now: 0 while closed, and mid-slide the width it has reached */
  private drawn(): number {
    if (this.root.classList.contains('collapsed')) return 0
    if (this.root.classList.contains('expanded')) return this.widths[this.currentTab]
    return this.root.getBoundingClientRect().width
  }

  /** a slide takes MOTION_MS; with no motion (reduced, or the panel expanded) the panel's width is set at once */
  private motionMs(): number {
    return this.isExpanded || this.root.classList.contains('expanded') || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : MOTION_MS
  }

  /** the panel's width goes from `from` to `to`; the panel is shown from its first px and hidden at its last */
  private slide(from: number, to: number, ms: number): Promise<void> {
    if (to > 0) this.root.classList.remove('collapsed')
    this.root.style.width = `${to}px`
    if (ms === 0 || from === to) return Promise.resolve()
    // the content keeps the wider of the two widths while the panel's edge moves: it is clipped, not laid out again, so a document keeps its scroll position
    this.root.style.setProperty('--slide-w', `${Math.max(from, to)}px`)
    this.root.classList.add('sliding')
    const timing: KeyframeAnimationOptions = { duration: ms, easing: 'ease-out' }
    const width = this.root.animate([{ width: `${from}px` }, { width: `${to}px` }], timing)
    this.anims.push(width)
    // the content fades out as the panel closes; as it opens, the stylesheet's panel-in fades it in
    const fade = to < from ? this.root.animate([{ opacity: 1 }, { opacity: 0 }], timing) : null
    if (fade) this.anims.push(fade)
    return Promise.all([width.finished, fade?.finished]).then(() => undefined, () => undefined).then(() => {
      this.root.classList.remove('sliding')
      this.root.style.removeProperty('--slide-w')
    })
  }

  /** asks main for the room of a panel `width` wide */
  private async room(width: number): Promise<PanelMode> {
    try {
      return await this.makeRoom(width, true)
    } catch {
      return 'narrow'
    }
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

  /** the terminal's box keeps its width while a slide runs beside the window: the room is the window's */
  private pin(width: number): void {
    this.terminals.style.flex = `0 0 ${width}px`
  }

  private unpin(): void {
    this.terminals.style.flex = ''
  }

  /** the terminal keeps the size its element has while the main area's margin moves: it refits once, when the slide ends */
  private hold(): void {
    if (this.terminals.classList.contains('holding')) return
    const host = Array.from(this.terminals.querySelectorAll<HTMLElement>('.terminal-host')).find((h) => h.offsetParent !== null)
    if (!host) return
    this.terminals.style.setProperty('--held-host', `${host.getBoundingClientRect().width}px`)
    this.terminals.classList.add('holding')
  }

  private unhold(): void {
    this.terminals.classList.remove('holding')
    this.terminals.style.removeProperty('--held-host')
  }

  private apply(): void {
    const shown = this.shownTab !== null
    // a queued or running change owns the panel's shown state and geometry: it applies them when the last one ends
    if (!this.moving) this.root.classList.toggle('collapsed', !shown)
    this.root.classList.toggle('expanded', this.isExpanded)
    this.root.classList.toggle('overlay', shown && (this.isExpanded || this.mode === 'overlay'))
    for (const t of TABS) this.bodies[t].hidden = this.currentTab !== t
    this.title.textContent = LABELS[this.currentTab]
    this.toolsBox.hidden = this.currentTab === 'images'
    for (const t of TABS) this.tools[t].hidden = this.currentTab !== t
    const width = this.widths[this.currentTab]
    // what the panel covers of the terminal's right, for the note to sit left of it; the expanded panel covers the note too
    this.terminals.style.setProperty('--panel-cover', `${shown && this.mode === 'overlay' && !this.isExpanded ? width : 0}px`)
    if (this.moving) {
      // expanded in the middle of a slide: the panel takes the whole sheet at once, the slide's width animation ends
      if (this.isExpanded) {
        for (const a of this.anims) a.cancel()
        this.root.style.width = ''
      }
      return
    }
    // the expanded panel lies over the sheet: the title bar and the tabs stay in view; the terminal keeps the room it gave the panel.
    // Its width comes from the stylesheet, so it follows the sheet when the tabs move
    this.root.style.width = this.isExpanded ? '' : `${width}px`
    this.terminals.style.marginRight = `${shown && this.mode !== 'overlay' ? width : 0}px`
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
        this.widths[tab] = Math.min(Math.max(startW + (startX - ev.clientX), MIN_WIDTH), Math.round(this.root.parentElement!.clientWidth * MAX_SHARE[tab]))
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
