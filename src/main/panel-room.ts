import type { NoRoomMode, PanelAnswer, PanelMode } from '../shared/types'

export interface Rect { x: number; y: number; width: number; height: number }

/** The window `extra` px wider: to the right, or moved left as far as it must to stay in the work area; null when it would not fit. */
export function grownBounds(win: Rect, area: Rect, extra: number): Rect | null {
  const width = win.width + extra
  if (width > area.width) return null
  const right = area.x + area.width
  return { ...win, x: win.x + width <= right ? win.x : right - width, width }
}

export interface PanelWindow {
  bounds(): Rect
  /** resolves once the window has its new size, or when it is not going to get it */
  setBounds(r: Rect): Promise<void>
  /** the work area of the display the window is on */
  workArea(): Rect
  /** maximized or full screen: the window's size is not the app's to change */
  pinned(): boolean
  readonly minWidth: number
}

/**
 * Makes room for the side panel the way Telegram does: opening the panel widens the window by the panel's width, so the
 * terminal keeps its size, and closing it gives that width back. A window that cannot grow (maximized, full screen, at the
 * edge of the work area, or held by its window manager) leaves the panel to `noRoom`: over the terminal or narrowing it.
 */
export class PanelRoom {
  /** how much wider the window is than it would be without the panel */
  private extra = 0
  /** the panel's width; 0 while it is closed */
  private width = 0
  private shown: PanelMode = 'beside'
  private queue: Promise<unknown> = Promise.resolve()
  /** the size the last fit asked of a window that had not taken it yet when it looked: it may take it later */
  private late: { from: number; to: number } | null = null

  constructor(private readonly win: PanelWindow, private readonly noRoom: () => NoRoomMode) {}

  /** the width the window was given for the panel: the window's own size leaves it out */
  get added(): number {
    return this.reconciled()
  }

  get mode(): PanelMode {
    return this.shown
  }

  /**
   * The panel opened at `width`, was closed (0) or switched to a panel of another width. `resize` false: the person dragged
   * the panel's edge, the terminal gave way and the window stays as it is.
   */
  set(width: number, resize: boolean): Promise<PanelMode> {
    return this.request(width, resize).then((a) => a.mode)
  }

  /** `set`, with the answer for the renderer: whether the window changed its size */
  request(width: number, resize: boolean): Promise<PanelAnswer> {
    return this.run(async () => {
      this.width = width
      if (resize) return this.fit()
      this.reconcile()
      if (this.shown === 'beside' && width > 0) this.extra = width
      return { mode: this.shown, grew: false }
    })
  }

  /** the window was maximized, restored, or entered or left full screen, or sidePanel.noRoom changed */
  refit(): Promise<PanelMode> {
    return this.run(() => this.fit()).then((a) => a.mode)
  }

  private run(job: () => Promise<PanelAnswer>): Promise<PanelAnswer> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async fit(): Promise<PanelAnswer> {
    this.reconcile()
    if (this.win.pinned()) return this.answer(this.show(this.width > 0 ? this.noRoom() : 'beside'))
    const delta = this.width - this.extra
    if (delta === 0) return this.answer(this.show('beside'))
    const before = this.win.bounds()
    const next = delta > 0 ? grownBounds(before, this.win.workArea(), delta) : { ...before, width: Math.max(this.win.minWidth, before.width + delta) }
    if (!next) return this.answer(this.show(this.noRoom()))
    if (next.width !== before.width || next.x !== before.x) await this.win.setBounds(next)
    const after = this.win.bounds()
    const grew = after.width !== before.width || after.x !== before.x
    // what the window really is, not what was asked: a shrink it did not make stays on the books until it does
    this.extra = Math.max(0, this.extra + after.width - before.width)
    // closed and as narrow as asked (or the minimum width cut the shrink short, or a pixel of slack): nothing of the panel's width is left
    if (this.width === 0 && after.width <= next.width + 1) this.extra = 0
    // a window that has not taken the size yet may take it later: reconcile counts it then
    this.late = grew || next.width === before.width ? null : { from: before.width, to: next.width }
    // a window manager may keep the window from growing
    return this.answer(this.show(this.width === 0 || after.width >= next.width - 1 ? 'beside' : this.noRoom()), grew)
  }

  /**
   * A window that applied the size of the last fit after the fit had read it (its bounds were still the old ones then) is
   * now as wide as was asked: its width change was not counted, so count it. Any other width is the person's own resize or
   * a window that kept its size: `extra` stays as it is.
   */
  private reconcile(): void {
    this.extra = this.reconciled()
    this.late = null
  }

  private reconciled(): number {
    const late = this.late
    return late && Math.abs(this.win.bounds().width - late.to) <= 1 ? Math.max(0, this.extra + late.to - late.from) : this.extra
  }

  private answer(mode: PanelMode, grew = false): PanelAnswer {
    return { mode, grew }
  }

  private show(mode: PanelMode): PanelMode {
    this.shown = mode
    return mode
  }
}
