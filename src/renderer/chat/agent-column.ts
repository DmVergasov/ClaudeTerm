import type { AgentPatch, ChatItem } from '../../shared/chat'
import { unpaint, type FindView } from './chat-find'
import { forwardBubble, renderItem, type ItemCallbacks } from './chat-items'
import { setSettled, type StepKeep } from './chat-steps'
import { EMPTY_LOST, EMPTY_RUNNING } from './agent-text'
import { BOTTOM_SLACK, drawCallInPlace, drawInPlace, drawSafely, EDGE_ZONE, FrameQueue, joinSnapshot, keepAtNode, keepFold, OlderPages, pageDownWin, pageUpInView, pageUpWin, revealWin, scrollToMiddle, settledAfter, stepBefore, tailWin, topItemOf, windowAt, type OlderPage, type Win } from './column-draw'

// The column of an agent page: the agent's conversation, drawn like the main column (ChatView): it holds every item it is given, and
// draws a window of at most WINDOW of them, which moves as the reader scrolls to either end. The model takes a patch at once; the
// drawing is queued and done once per animation frame. A hidden column draws nothing, and is drawn again when it is shown.

type ItemPatch = Exclude<AgentPatch, { op: 'agent' }>

export class AgentColumn implements FindView {
  /** the scrolling area: the column in it, with the agent's items as its children */
  readonly element = document.createElement('div')
  /** the button that shows while items the reader has not seen are below the view: a click goes to the end */
  readonly pill = document.createElement('button')
  private readonly column = document.createElement('div')
  /** the empty state: the column's last child, shown while it holds no item */
  private readonly empty = document.createElement('div')
  private items: ChatItem[] = []
  /** the window: items[from] to items[to - 1] are drawn, the others are held only */
  private from = 0
  private to = 0
  /** the agent runs: a step is settled only when an item follows it, or the agent has ended */
  private running = false
  /** the node of each drawn item, by id */
  private drawn = new Map<string, HTMLElement>()
  /** what each drawn node was made from: the item and whether it is settled, by id */
  private drawnAs = new Map<string, string>()
  /** the choices the user made in the steps and thinking blocks, by the item's id: kept while the node is out of the column */
  private folds = new Map<string, StepKeep>()
  /** the prompts the reader unfolded with Show all, by the item's id: kept while the node is out of the column */
  private readonly unfolded = new Set<string>()
  private visible = false
  /** the column follows new items while the reader is at its bottom */
  private stick = true
  /** items came in while the reader was not at the bottom: the pill shows until the reader is */
  private unseen = false
  /** the scroll position when the column was hidden: kept for its showing */
  private top = 0
  /** the item at the top of the view when the column was hidden, and its offset: the items that come in while it is hidden keep it there */
  private hiddenTop: { id: string; offset: number } | null = null
  /** the older pages before the window, asked for one at a time (column-draw.ts) */
  private readonly pages = new OlderPages({
    ask: (beforeId) => this.older(beforeId),
    first: () => this.items[0],
    take: (items) => {
      this.items = [...items, ...this.items]
      this.from += items.length
      this.to += items.length
    },
    ready: () => this.visible,
    nearTop: () => this.element.scrollTop < EDGE_ZONE,
    grow: () => this.growUp()
  })
  /** the drawings waiting for the next animation frame: an item is drawn once per frame, however many patches changed it */
  private readonly frames = new FrameQueue({
    ready: () => this.visible,
    label: 'agent page',
    begin: () => undefined,
    end: () => {
      this.reconcile()
      this.settle()
      this.updatePill()
    }
  })
  private readonly resize = new ResizeObserver(() => this.settle())

  constructor(private readonly cb: ItemCallbacks, private readonly older: (beforeId: string) => Promise<OlderPage | null>) {
    this.element.className = 'agent-scroll'
    this.column.className = 'agent-column'
    this.empty.className = 'agent-empty'
    this.column.append(this.empty)
    this.element.append(this.column)
    this.pill.className = 'agent-pill'
    this.pill.type = 'button'
    this.pill.textContent = '↓ New messages'
    this.pill.hidden = true
    this.pill.addEventListener('click', () => this.toEnd())
    this.element.addEventListener('scroll', () => this.onScroll())
    this.resize.observe(this.element)
    this.resize.observe(this.column)
  }

  /** the column is shown or hidden: a shown column is drawn again, at its bottom while the reader is there, else where it was */
  show(visible: boolean): void {
    const was = this.visible
    if (!visible && was) {
      this.top = this.element.scrollTop
      this.hiddenTop = this.stick ? null : this.topItem()
    }
    this.visible = visible
    if (!visible) {
      this.frames.drop()
      return
    }
    if (was) return
    this.redraw()
    if (this.stick) this.settle()
    else this.restoreTop()
    this.hiddenTop = null
    this.updatePill()
  }

  /**
   * The agent's whole conversation: the column is drawn again from it. The older items held stay before the snapshot's first item
   * (joinSnapshot). A column stuck to its end sticks to the new end; one the reader is up in keeps the item at its top where it was,
   * and its window is set around that item.
   */
  setItems(items: ChatItem[], running: boolean, hasOlder: boolean): void {
    // a hidden column's nodes are not measured: it keeps the item it had at its top when it was hidden
    const anchor = this.stick ? null : this.visible ? this.topItem() : this.hiddenTop
    const joined = joinSnapshot(this.items, items)
    this.items = joined.items
    // the older pages held stay, and their hasOlder with them; a snapshot that starts the conversation tells whether there are more
    if (joined.at <= 0) this.pages.hasOlder = hasOlder
    this.running = running
    const kept = joined.at < 0 || anchor === null || this.indexOf(anchor.id) < 0 ? null : anchor
    if (kept === null) {
      this.stick = true
      this.unseen = false
      this.setWin(tailWin(this.items.length))
    } else {
      this.setWin(windowAt(this.items.length, this.indexOf(kept.id)))
    }
    this.redraw()
    this.syncEmpty()
    const node = kept === null ? undefined : this.drawn.get(kept.id)
    if (kept !== null && node !== undefined && this.visible) keepAtNode(this.element, node, kept)
    this.settle()
    this.updatePill()
  }

  /** the agent started or ended: the steps are settled again, as the agent's state says */
  setRunning(running: boolean): void {
    if (running === this.running) return
    this.running = running
    this.redraw()
    this.syncEmpty()
    this.settle()
  }

  /** a patch of the agent's conversation: the model takes it now, and the drawing it needs is queued */
  apply(p: ItemPatch): void {
    switch (p.op) {
      case 'add':
        this.items.push(p.item)
        if (this.stick) this.setWin(tailWin(this.items.length))
        else this.unseen = true
        this.resettleBefore(this.items.length - 1)
        this.frames.add(`item:${p.item.id}`, () => this.drawItem(p.item.id))
        break
      case 'set': {
        const i = this.indexOf(p.item.id)
        if (i < 0) break
        this.items[i] = p.item
        this.frames.add(`item:${p.item.id}`, () => this.drawItem(p.item.id))
        break
      }
      case 'append': {
        const i = this.indexOf(p.id)
        if (i < 0) break
        const item = this.items[i]!
        if (item.kind !== 'text') break
        this.items[i] = { ...item, markdown: item.markdown + p.text }
        if (!this.stick) this.unseen = true
        this.frames.add(`item:${p.id}`, () => this.drawItem(p.id))
        break
      }
      case 'remove': {
        const i = this.indexOf(p.id)
        if (i < 0) break
        this.items.splice(i, 1)
        if (i < this.from) this.from--
        if (i < this.to) this.to--
        this.unmount(p.id)
        this.folds.delete(p.id)
        this.unfolded.delete(p.id)
        this.syncEmpty()
        this.frames.request()
        break
      }
      case 'call': {
        const i = this.indexOf(p.id)
        if (i < 0) break
        const item = this.items[i]!
        if (item.kind !== 'tools') break
        const calls = item.calls.some((c) => c.id === p.call.id)
          ? item.calls.map((c) => (c.id === p.call.id ? p.call : c))
          : [...item.calls, p.call]
        this.items[i] = { ...item, calls }
        this.frames.add(`call:${p.id}:${p.call.id}`, () => this.drawCall(p.id, p.call.id))
        break
      }
      case 'reset':
        // the conversation starts again: every node is made new
        this.items = [...p.items]
        this.pages.hasOlder = p.hasOlder
        this.followEnd()
        this.redraw()
        this.syncEmpty()
        this.settle()
        break
    }
  }

  dispose(): void {
    this.visible = false
    this.resize.disconnect()
    this.frames.drop()
    // a closed page's Find highlights go with it
    unpaint(this)
  }

  // Find's view of the column: its items, the nodes drawn, the window moved to an item, and the older pages

  itemCount(): number {
    return this.items.length
  }

  itemAt(i: number): ChatItem | undefined {
    return this.items[i]
  }

  indexOfItem(id: string): number {
    return this.indexOf(id)
  }

  drawnNode(id: string): HTMLElement | null {
    return this.drawn.get(id) ?? null
  }

  drawnNodes(): HTMLElement[] {
    return [...this.drawn.values()]
  }

  /** an agent's page draws no image thumbnails: no picture is a Media card's here */
  hasCard(): boolean {
    return false
  }

  isShown(): boolean {
    return this.visible
  }

  hasOlderItems(): boolean {
    return this.pages.hasOlder
  }

  loadOlder(): Promise<boolean> {
    return this.pages.load()
  }

  /** brings an item into the window and scrolls the column to its middle: Find's current match */
  reveal(id: string): boolean {
    const i = this.indexOf(id)
    if (i < 0 || !this.visible) return false
    this.setWin(revealWin(this.items.length, i))
    this.reconcile()
    const node = this.drawn.get(id)
    if (node === undefined) return false
    scrollToMiddle(this.element, node)
    this.stick = this.to === this.items.length && this.distanceToBottom() <= BOTTOM_SLACK
    this.updatePill()
    return true
  }

  private indexOf(id: string): number {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i]!.id === id) return i
    return -1
  }

  private setWin(w: Win): void {
    this.from = w.from
    this.to = w.to
  }

  /** the window is the column's end while the reader is at the bottom; else it stays where it is, within the items */
  private followEnd(): void {
    if (this.stick) this.setWin(tailWin(this.items.length))
    else this.setWin({ from: Math.min(this.from, this.items.length), to: Math.min(this.to, this.items.length) })
  }

  /** a shown column the reader is up in goes back to the item it had at its top when it was hidden, at the same offset; else to its scroll position */
  private restoreTop(): void {
    const anchor = this.hiddenTop
    const node = anchor === null ? undefined : this.drawn.get(anchor.id)
    if (anchor !== null && node !== undefined) keepAtNode(this.element, node, anchor)
    else this.element.scrollTop = this.top
  }

  private topItem(): { id: string; offset: number } | null {
    return topItemOf(this.element, this.column)
  }

  /** the window's nodes made as the items are now: the nodes of the items out of the window go, and each item in it that has no node is drawn, before the item after it */
  private reconcile(): void {
    this.syncEmpty()
    const wanted = new Set<string>()
    for (let i = this.from; i < this.to; i++) wanted.add(this.items[i]!.id)
    for (const id of [...this.drawn.keys()]) if (!wanted.has(id)) this.unmount(id)
    let before: HTMLElement = this.empty
    for (let i = this.to - 1; i >= this.from; i--) {
      const item = this.items[i]!
      let node = this.drawn.get(item.id)
      if (node === undefined) {
        node = drawSafely(item, (it) => this.draw(it), 'agent page')
        this.drawn.set(item.id, node)
        this.drawnAs.set(item.id, this.stateOf(item))
        this.column.insertBefore(node, before)
      }
      before = node
    }
  }

  /** the empty state says what the page holds when it holds no item: the agent has just started, or its conversation was not saved */
  private syncEmpty(): void {
    this.empty.hidden = this.items.length > 0
    const text = this.running ? EMPTY_RUNNING : EMPTY_LOST
    if (this.empty.textContent !== text) this.empty.textContent = text
  }

  /** the column drawn again from its window: every node made new, the steps' and thinking blocks' choices kept */
  private redraw(): void {
    if (!this.visible) return
    this.frames.drop()
    for (const id of [...this.drawn.keys()]) if (!this.isCurrent(id)) this.unmount(id)
    this.reconcile()
  }

  /** a drawn node is current when it is in the window and was made from the item as it is now */
  private isCurrent(id: string): boolean {
    const i = this.indexOf(id)
    if (i < this.from || i >= this.to) return false
    return this.drawnAs.get(id) === this.stateOf(this.items[i]!)
  }

  private stateOf(item: ChatItem): string {
    return `${this.settledAt(item.id)}|${JSON.stringify(item)}`
  }

  private unmount(id: string): void {
    const node = this.drawn.get(id)
    if (node === undefined) return
    keepFold(this.folds, id, node)
    node.remove()
    this.drawn.delete(id)
    this.drawnAs.delete(id)
  }

  private draw(item: ChatItem): HTMLElement {
    const keep = item.kind === 'tools' || item.kind === 'thinking' ? this.folds.get(item.id) ?? null : null
    const prompt = { unfolded: this.unfolded.has(item.id), unfold: () => { this.unfolded.add(item.id) } }
    // a forward is a bubble on the page (the main conversation draws it as a note, renderItem)
    const node = item.kind === 'forward' ? forwardBubble(item) : renderItem(item, this.cb, keep, this.settledAt(item.id), prompt)
    // the item's id on its node: a reader of the DOM follows the same item across redraws
    node.dataset.item = item.id
    return node
  }

  private drawItem(id: string): void {
    const item = this.get(id)
    const node = this.drawn.get(id)
    // an item out of the window has no node: the window draws it when it comes in
    if (!item || !node) return
    drawInPlace(item, node, this.cb, () => this.paint(item, node))
  }

  private drawCall(id: string, callId: string): void {
    const item = this.get(id)
    const node = this.drawn.get(id)
    if (!item || !node) return
    drawCallInPlace(item, node, callId, this.cb, () => this.drawItem(id))
  }

  private get(id: string): ChatItem | undefined {
    const i = this.indexOf(id)
    return i < 0 ? undefined : this.items[i]
  }

  private paint(item: ChatItem, old: HTMLElement): void {
    keepFold(this.folds, item.id, old)
    const node = this.draw(item)
    this.drawn.set(item.id, node)
    this.drawnAs.set(item.id, this.stateOf(item))
    old.replaceWith(node)
  }

  private settledAt(id: string): boolean {
    return settledAfter(this.items, id, !this.running)
  }

  /** the step before an item that comes in is settled again when that item is new: it is drawn again at the next frame */
  private resettleBefore(end: number): void {
    const item = stepBefore(this.items, end)
    if (item === null) return
    this.frames.add(`settle:${item.id}`, () => {
      const node = this.drawn.get(item.id)
      if (node?.classList.contains('chat-steps')) setSettled(node, this.settledAt(item.id))
    })
  }

  /** the window moves up by a page; at the first item held, the page before it is asked for, once */
  private growUp(): void {
    if (this.from === 0) {
      this.pages.askFirst()
      return
    }
    pageUpInView(this.element, this.column, () => {
      this.setWin(pageUpWin(this.win()))
      this.reconcile()
    })
  }

  /** the window moves down by a page, toward the newest items */
  private growDown(): void {
    this.setWin(pageDownWin(this.win(), this.items.length))
    this.reconcile()
  }

  private win(): Win {
    return { from: this.from, to: this.to }
  }

  private settle(): void {
    if (!this.visible || !this.stick) return
    this.element.scrollTop = this.element.scrollHeight
  }

  private onScroll(): void {
    if (!this.visible) return
    if (this.element.scrollTop < EDGE_ZONE) this.growUp()
    if (this.distanceToBottom() < EDGE_ZONE && this.to < this.items.length) this.growDown()
    this.stick = this.to === this.items.length && this.distanceToBottom() <= BOTTOM_SLACK
    if (this.stick) this.unseen = false
    this.updatePill()
  }

  /** the pill shows while items the reader has not seen are below the view */
  private updatePill(): void {
    this.pill.hidden = this.stick || !this.unseen
  }

  /** the pill's click: the window moves to the newest items, and the column goes to its bottom */
  private toEnd(): void {
    this.setWin(tailWin(this.items.length))
    this.unseen = false
    this.stick = true
    this.reconcile()
    this.settle()
    this.updatePill()
  }

  private distanceToBottom(): number {
    return this.element.scrollHeight - this.element.scrollTop - this.element.clientHeight
  }
}
