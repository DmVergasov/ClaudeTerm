import { acceptPatches, commandWord, typedMessages, type ChatAnswer, type ChatAttachment, type ChatCommandInfo, type ChatItem, type ChatModelInfo, type ChatPatch, type ChatPermissionMode, type ChatSend, type ChatSnapshot, type ChatState, type ChatSubagent } from '../../shared/chat'
import type { ImageCard } from '../../shared/types'
import { spinner } from '../tab-row'
import { ChatComposer } from './chat-composer'
import { QuoteButton, splitQuotes } from './chat-quote'
import { renderItem, streamText, type ItemCallbacks } from './chat-items'
import { focusCard, renderCard, waitingCard } from './chat-cards'
import { elapsedText, fillAgentsCard, setSettled, stepKeep, updateSteps, type StepKeep } from './chat-steps'
import { chatPalette } from '../themes'
import './chat.css'
import type { ITheme } from '@xterm/xterm'

export interface ChatViewOptions {
  tabId: string
  container: HTMLElement
  platform: string
  /** the refusal, or null when the message was sent (the composer keeps a refused draft) */
  send(s: ChatSend): Promise<string | null>
  interrupt(): void
  attach(paths: string[]): Promise<ChatAttachment[]>
  pickFiles(): Promise<ChatAttachment[]>
  /** the path of the clipboard's image, saved; null when there is none */
  pasteImage(): Promise<string | null>
  pathForFile(file: File): string
  setMode(mode: ChatPermissionMode): void
  modes(): Promise<ChatPermissionMode[]>
  models(): Promise<ChatModelInfo[]>
  commands(): Promise<ChatCommandInfo[]>
  files(query: string): Promise<string[]>
  setModel(model: string, effort: string | null): void
  resume(refused: () => void): void
  /** a notice's line, or null for a dialog the chat cannot show (the terminal is switched to only) */
  openInTerminal(line: string | null): Promise<boolean>
  askSwitch(go: () => void, cancel: () => void): () => void
  answer(cardId: string, a: ChatAnswer): void | Promise<boolean>
  restart(): void
  /** the page of items before `beforeId`; null when the chat is gone */
  older(beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
  imageCard(cardId: string): ImageCard | null
  openImages(cards: ImageCard[], index: number): void
  revealChange(path: string): void
  openExternal(url: string): void
  copy(text: string): void
}

const NO_STATE: ChatState = { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false }

/** the id of a list's last item, null for an empty list */
const lastId = (items: readonly ChatItem[]): string | null => (items.length === 0 ? null : items[items.length - 1]!.id)

/** the dock keeps its rows this long after its last running agent ends, then closes */
const DOCK_LINGER_MS = 4000

type CardItem = Extract<ChatItem, { kind: 'card' }>

/** a pixel of slack when deciding the column is at its bottom */
const BOTTOM_SLACK = 24
/** closer than this to either end of the view, the items beyond that end are drawn (the window moves) */
const EDGE_ZONE = 400
/** the most items the column holds in the DOM at once */
const WINDOW = 120
/** the items the window moves by, at a time */
const PAGE_STEP = 60
/** a queued drawing that no animation frame has taken by then is drawn by a timer */
const FRAME_FALLBACK_MS = 100

/**
 * The chat of a Claude tab in its chat view: the conversation as a column of items, and the composer under it. It holds
 * every item it was given in an array, and draws only a window of them: at most WINDOW consecutive items, which moves as the
 * user scrolls to either end. The model of the column is updated at once; its drawing is queued and done once per animation
 * frame, together. A hidden view draws nothing: it draws its window again when it is shown.
 */
export class ChatView {
  readonly element: HTMLDivElement
  private readonly body = document.createElement('div')
  private readonly scroll = document.createElement('div')
  private readonly column = document.createElement('div')
  private readonly fade = document.createElement('div')
  private readonly pill = document.createElement('button')
  private readonly working = document.createElement('div')
  private readonly glyph = spinner('chat-glyph')
  private readonly verb = document.createElement('span')
  private readonly elapsedSep = document.createElement('span')
  private readonly elapsed = document.createElement('span')
  private readonly hintSep = document.createElement('span')
  private readonly hint = document.createElement('span')
  /** the thin bar under the line while the chat compacts or restarts: a segment sweeps along it */
  private readonly activityBar = document.createElement('div')
  private readonly activitySweep = document.createElement('span')
  private readonly composer: ChatComposer
  /** the Quote button over a selection in the column: its quote goes into the composer */
  private readonly quote: QuoteButton
  private readonly cb: ItemCallbacks
  private items: ChatItem[] = []
  /** the dock above the composer: the subagents of the Agent calls that run, outside the scrolling column */
  private readonly dock = document.createElement('div')
  /** the dock is open: a running agent opened it, and it stays open until its linger ends */
  private dockOpen = false
  /** the rows the dock draws while it is open: an agent that ends keeps its row through the linger, even when it began in an earlier turn */
  private dockRows: ChatSubagent[] = []
  private dockTimer: ReturnType<typeof setTimeout> | null = null
  /** the window: items[from] to items[to - 1] are drawn, the others are held only */
  private from = 0
  private to = 0
  /** the node of each drawn item, by id */
  private drawn = new Map<string, HTMLElement>()
  /** the choices the user made in the tool steps, by the step's id: kept while the step is out of the DOM */
  private folds = new Map<string, StepKeep>()
  /** the items that came in while the view was shown: each pops in once when it is drawn */
  private fresh = new Set<string>()
  /** the revision of the snapshot the view holds; -1 until a snapshot is loaded */
  private rev = -1
  private hasOlder = false
  /** a page of older items is being asked for: one request at a time, until its answer comes */
  private olderAsked: Promise<{ count: number } | null> | null = null
  private state: ChatState = NO_STATE
  private visible = false
  /** the column follows new items while the user is at its bottom; scrolling up stops it */
  private stick = true
  /** where settle() last put the column: while stuck, only a scroll above it is the user's */
  private settledTop = 0
  /** items came in while the user was not at the bottom: the pill shows until the user is */
  private unseen = false
  /** the scroll position when the view was hidden: kept for its showing */
  private top = 0
  /** the drawing waiting for the next animation frame, by what it draws: an item is drawn once per frame, however many patches changed it */
  private queued = new Map<string, () => void>()
  /** a card was added, changed or removed: the flush puts the cards in their order again */
  private cardsDirty = false
  /** the card that was made active last: it takes the keyboard when it changes */
  private activeCard: string | null = null
  /** the pending flush: its animation frame, and the timer that stands in for it */
  private frame: { raf: number; timer: ReturnType<typeof setTimeout> } | null = null
  /** the elapsed time of the working line ticks while it shows */
  private clock: ReturnType<typeof setInterval> | null = null
  /** the column stays at its bottom while the scroll area or the column changes size: the composer grows, the window resizes */
  private readonly resize = new ResizeObserver(() => {
    // a plan card is at most half the conversation's height
    this.element.style.setProperty('--chat-plan-max', `${Math.floor(this.scroll.clientHeight / 2)}px`)
    this.settle()
    this.updatePill()
  })

  constructor(private readonly o: ChatViewOptions) {
    this.element = document.createElement('div')
    this.element.className = 'chat-host'
    this.body.className = 'chat-body'
    this.scroll.className = 'chat-scroll'
    this.column.className = 'chat-column'
    this.fade.className = 'chat-fade'
    this.pill.className = 'chat-pill'
    this.pill.type = 'button'
    this.pill.textContent = '↓ New messages'
    this.pill.hidden = true
    this.pill.addEventListener('click', () => this.toEnd())
    this.working.className = 'chat-working'
    this.working.hidden = true
    this.verb.className = 'chat-verb'
    this.elapsedSep.className = 'chat-sep'
    this.elapsedSep.textContent = '·'
    this.elapsed.className = 'chat-elapsed'
    this.hintSep.className = 'chat-sep'
    this.hintSep.textContent = '·'
    this.hint.className = 'chat-hint'
    this.hint.textContent = 'Esc to interrupt'
    this.activityBar.className = 'chat-activity-bar'
    this.activityBar.hidden = true
    this.activitySweep.className = 'chat-activity-sweep'
    this.activityBar.append(this.activitySweep)
    this.working.append(this.glyph, this.verb, this.elapsedSep, this.elapsed, this.hintSep, this.hint, this.activityBar)
    this.column.append(this.working)
    this.scroll.append(this.column)
    this.scroll.addEventListener('scroll', () => this.onScroll())
    this.resize.observe(this.scroll)
    this.resize.observe(this.column)
    this.cb = {
      answer: (cardId, a) => o.answer(cardId, a),
      restart: () => o.restart(),
      // a notice's button runs its line as the composer runs a command: it waits for the turn, and asks the header first
      openInTerminal: (line) => this.composer.openNoticeLine(line),
      imageCard: (cardId) => o.imageCard(cardId),
      openImages: (cards, index) => o.openImages(cards, index),
      revealChange: (path) => o.revealChange(path),
      openExternal: (url) => o.openExternal(url),
      copy: (text) => o.copy(text)
    }
    this.composer = new ChatComposer({
      platform: o.platform,
      // the user's own message brings the column to its end, where the message is drawn
      send: (s) => { this.toEnd(); return o.send(s) },
      interrupt: () => o.interrupt(),
      attach: (paths) => o.attach(paths),
      pickFiles: () => o.pickFiles(),
      pasteImage: () => o.pasteImage(),
      setMode: (mode) => o.setMode(mode),
      modes: () => o.modes(),
      models: () => o.models(),
      commands: () => o.commands(),
      files: (query) => o.files(query),
      setModel: (model, effort) => o.setModel(model, effort),
      resume: (refused) => o.resume(refused),
      openInTerminal: (line) => o.openInTerminal(line),
      askSwitch: (go, cancel) => o.askSwitch(go, cancel),
      // ↑ recalls the typed text of a message; its quotes stay out of the field, as they are shown in their bars, and a message of quotes alone has none
      history: () => typedMessages(this.items).map((text) => splitQuotes(text).rest).filter((text) => text !== ''),
      unavailable: () => this.unavailableCommands(),
      imageCard: (cardId) => o.imageCard(cardId)
    })
    this.quote = new QuoteButton({
      host: this.element,
      column: this.column,
      scroll: this.scroll,
      canQuote: () => this.composer.canQuote(),
      quote: (text) => this.composer.addQuote(text)
    })
    // Tab in the composer's text moves the focus to the card that waits, when there is one; the other controls keep their Tab order
    this.composer.element.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.shiftKey || e.defaultPrevented) return
      if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('chat-input')) return
      const id = this.cardOrder().active
      const node = id === null ? undefined : this.drawn.get(id)
      if (node === undefined) return
      e.preventDefault()
      focusCard(node)
    })
    // files dropped anywhere on the sheet are attached to the composer
    this.element.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    })
    this.element.addEventListener('drop', (e) => {
      e.preventDefault()
      this.dropFiles(Array.from(e.dataTransfer?.files ?? []))
    })
    this.body.append(this.scroll, this.fade, this.pill)
    // the dock is the conversation's last element, after the column: it takes its own room, and sticks to the bottom of the scroll area
    this.dock.className = 'chat-agents-dock'
    this.scroll.append(this.dock)
    this.resize.observe(this.dock)
    this.element.append(this.body, this.composer.element)
    o.container.append(this.element)
    this.show(false)
  }

  show(visible: boolean, focus = true): void {
    const was = this.visible
    if (!visible && was) this.top = this.scroll.scrollTop
    this.visible = visible
    this.quote.setActive(visible)
    this.element.style.display = visible ? 'flex' : 'none'
    this.syncClock()
    if (!visible) {
      // a hidden chat has no menu or picker open: they close, and do not come back with the chat
      this.composer.closePickers()
      this.dropQueued()
      return
    }
    // the column is drawn from its window: what came in while the view was hidden is in it
    if (!was) {
      this.redraw()
      // a view stuck to the bottom goes to its new bottom: a saved top from before the new items would unstick it
      if (this.stick) this.settle()
      else this.scroll.scrollTop = this.top
      // a card takes the keyboard where the person types nothing else: mayTakeFocus says so, from the focus as it is
      this.settleCards(!this.hasDraft())
    }
    this.showState()
    this.updatePill()
    // a card that holds the keyboard keeps it; the composer takes the focus otherwise
    if (focus && !(this.activeCard !== null && !this.hasDraft())) this.focus()
  }

  /**
   * The snapshot of the chat. A view that holds it already is not touched. Otherwise, when the snapshot's first item is held, the
   * older items held before it stay (the pages the user read up to), and the snapshot's items come after them: a view stuck to
   * the bottom goes to its end, and one that was not keeps the item at its top where it was. A snapshot whose first item is not
   * held (a reset, another conversation) replaces the items.
   */
  load(s: ChatSnapshot): void {
    if (s.rev === this.rev && lastId(this.items) === lastId(s.items)) return
    const first = s.items[0]
    const at = first === undefined || this.items.length === 0 ? -1 : this.indexOf(first.id)
    if (at < 0) {
      this.replaceAll(s)
      return
    }
    this.dropQueued()
    for (const [id, node] of this.drawn) this.keepFold(id, node)
    // the item at the top of the view, and its offset from the top: kept while the user reads up
    const anchor = this.stick || !this.visible ? null : this.topItem()
    const lastChanged = lastId(this.items) !== lastId(s.items)
    this.items = [...this.items.slice(0, at), ...s.items]
    this.syncDock()
    // the older pages held stay, and their hasOlder with them; a snapshot that starts the chat tells whether there are more
    if (at === 0) this.hasOlder = s.hasOlder
    this.rev = s.rev
    this.state = s.state
    this.composer.setState(s.state)
    this.pruneFolds()
    const kept = anchor !== null && this.indexOf(anchor.id) >= 0 ? anchor : null
    if (kept === null) {
      this.stick = true
      this.unseen = false
      this.toTail()
    } else {
      this.unseen = this.unseen || lastChanged
      this.windowAround(kept.id)
    }
    if (!this.visible) return
    this.redraw()
    this.settleCards()
    if (kept !== null) this.keepAt(kept)
    this.showState()
    this.updatePill()
  }

  /** the view takes the snapshot as the whole chat: its window is the newest items, and it sticks to the bottom */
  private replaceAll(s: ChatSnapshot): void {
    this.dropQueued()
    for (const [id, node] of this.drawn) this.keepFold(id, node)
    this.rev = s.rev
    this.hasOlder = s.hasOlder
    this.items = [...s.items]
    // a chat drawn again from its snapshot starts with the dock as its agents run now, and a dock that was open is closed first
    this.stopDockTimer()
    this.closeDock()
    this.syncDock()
    this.pruneFolds()
    this.state = s.state
    this.composer.setState(s.state)
    this.stick = true
    this.unseen = false
    this.toTail()
    if (!this.visible) return
    this.redraw()
    this.settleCards()
    this.showState()
    this.updatePill()
  }

  /**
   * The patches from fromRev to toRev, taken by the shared rule (acceptPatches): a batch the view already has is ignored,
   * one that straddles its revision is applied from the patch it lacks. A gap is refused, and the caller asks for a
   * snapshot. The revision moves at once; the drawing follows at the next frame.
   */
  patch(fromRev: number, toRev: number, patches: ChatPatch[]): boolean {
    const accept = acceptPatches(this.rev, fromRev, toRev, patches.length)
    if (accept.kind === 'gap') return false
    if (accept.kind === 'ignore') return true
    for (const p of patches.slice(accept.skip)) this.apply(p)
    this.rev = toRev
    return true
  }

  /**
   * The tab's images changed: a bubble or an images item whose card has come, or gone, is drawn again. Only the window is looked
   * at, and a hidden view does nothing: the window is drawn again when it is shown.
   */
  imagesChanged(): void {
    this.composer.imagesChanged()
    if (!this.visible) return
    for (let i = this.from; i < this.to; i++) {
      const item = this.items[i]!
      if (item.kind === 'images') {
        // the images item shows the cards it has: one drawn for each card that is known now
        const found = item.images.filter((image) => this.hasCard(image.cardId)).length
        const shown = this.drawn.get(item.id)?.querySelectorAll('.chat-image-card').length ?? 0
        if (found !== shown) this.queue(`item:${item.id}`, () => this.drawItem(item.id))
      } else if (item.kind === 'user') {
        // a bubble's pictures with a card are thumbnails: the bubble is drawn again when their number changed
        const known = item.attachments.filter((a) => a.kind === 'image' && this.hasCard(a.cardId)).length
        const thumbs = this.drawn.get(item.id)?.querySelectorAll('.chat-thumb').length ?? 0
        if (known !== thumbs) this.queue(`item:${item.id}`, () => this.drawItem(item.id))
      }
    }
  }

  /** the items held: the window is a part of them */
  itemCount(): number {
    return this.items.length
  }

  /** whether the chat is shown: a hidden chat is not searched for older pages */
  isShown(): boolean {
    return this.visible
  }

  /** whether a chat image's Media card is known: its picture shows as a thumbnail */
  hasCard(cardId: string | null): boolean {
    return cardId !== null && this.o.imageCard(cardId) !== null
  }

  itemAt(i: number): ChatItem | undefined {
    return this.items[i]
  }

  indexOfItem(id: string): number {
    return this.indexOf(id)
  }

  /** the node of an item in the window; null for an item out of it */
  drawnNode(id: string): HTMLElement | null {
    return this.drawn.get(id) ?? null
  }

  drawnNodes(): HTMLElement[] {
    return [...this.drawn.values()]
  }

  /** whether items older than the ones held are on the chat's side */
  hasOlderItems(): boolean {
    return this.hasOlder
  }

  /** asks for the page of items before the first one held: resolves to whether items came in above the window */
  loadOlder(): Promise<boolean> {
    const counted = (a: { count: number } | null): boolean => a !== null && a.count > 0
    if (this.olderAsked !== null) return this.olderAsked.then(counted, () => false)
    const first = this.items[0]
    if (!this.hasOlder || first === undefined) return Promise.resolve(false)
    return this.older(first.id).then(counted, () => false)
  }

  /**
   * Brings an item into the window and scrolls the column to its middle: Find's current match. The window is the items around
   * it; the bottom stick and the pill follow from where the column lands.
   */
  reveal(id: string): boolean {
    const i = this.indexOf(id)
    if (i < 0 || !this.visible) return false
    const len = this.items.length
    this.from = Math.max(0, Math.min(i - WINDOW / 2, len - WINDOW))
    this.to = Math.min(len, this.from + WINDOW)
    this.reconcile()
    const node = this.drawn.get(id)
    if (node === undefined) return false
    const frame = this.scroll.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    this.scroll.scrollTop += box.top + box.height / 2 - (frame.top + this.scroll.clientHeight / 2)
    this.stick = this.to === len && this.distanceToBottom() <= BOTTOM_SLACK
    this.updatePill()
    return true
  }

  /** the chat's colours follow the terminal theme: the host takes the theme's chat tokens, and the window's own stay as they are */
  setTheme(theme: ITheme): void {
    for (const [name, value] of Object.entries(chatPalette(theme))) this.element.style.setProperty(name, value)
  }

  /** the setting: the conversation and the message box take the chat's whole width, not a reading column */
  setFullWidth(on: boolean): void {
    this.element.classList.toggle('chat-wide', on)
  }

  focus(): void {
    this.composer.focus()
  }

  /** whether the composer holds a draft, text or attachments: a draft holds back AutoContinue's "continue" */
  hasDraft(): boolean {
    return this.composer.hasDraft()
  }

  /** files dropped on the sheet, or on its header, are attached to the composer */
  dropFiles(files: File[]): void {
    const paths = files.map((f) => this.o.pathForFile(f)).filter((p) => p.length > 0)
    this.composer.attachPaths(paths)
  }

  /** the commands the chat answered "not available": the names of its notices that carry a line, as the composer routes them */
  private unavailableCommands(): string[] {
    return this.items.flatMap((item) => (item.kind === 'notice' && item.action === 'open-terminal' && item.line ? [commandWord(item.line).replace(/^\//, '')] : []))
  }

  dispose(): void {
    this.visible = false
    this.resize.disconnect()
    this.composer.dispose()
    this.quote.dispose()
    this.dropQueued()
    this.stopClock()
    this.stopDockTimer()
    this.element.remove()
  }

  /** the model takes the patch now; the drawing it needs is queued */
  private apply(p: ChatPatch): void {
    switch (p.op) {
      case 'add':
        this.items.push(p.item)
        if (p.item.kind === 'card') this.cardsDirty = true
        this.resettleBefore(this.items.length - 1)
        if (this.stick) this.toTail()
        else this.unseen = true
        if (this.visible) this.fresh.add(p.item.id)
        this.queue(`item:${p.item.id}`, () => this.drawItem(p.item.id))
        break
      case 'set': {
        const i = this.indexOf(p.item.id)
        if (i < 0) break
        this.items[i] = p.item
        if (p.item.kind === 'card') this.cardsDirty = true
        this.queue(`item:${p.item.id}`, () => this.drawItem(p.item.id))
        break
      }
      case 'append': {
        const i = this.indexOf(p.id)
        if (i < 0) break
        const item = this.items[i]
        if (item.kind !== 'text') break
        this.items[i] = { ...item, markdown: item.markdown + p.text }
        if (!this.stick) this.unseen = true
        this.queue(`item:${p.id}`, () => this.drawItem(p.id))
        break
      }
      case 'remove': {
        const i = this.indexOf(p.id)
        if (i < 0) break
        this.items.splice(i, 1)
        this.cardsDirty = true
        if (i < this.from) this.from--
        if (i < this.to) this.to--
        this.folds.delete(p.id)
        this.schedule()
        break
      }
      case 'call': {
        const i = this.indexOf(p.id)
        if (i < 0) break
        const item = this.items[i]
        if (item.kind !== 'tools') break
        const calls = item.calls.some(c => c.id === p.call.id)
          ? item.calls.map(c => (c.id === p.call.id ? p.call : c))
          : [...item.calls, p.call]
        this.items[i] = { ...item, calls }
        this.queue(`call:${p.id}:${p.call.id}`, () => this.drawCall(p.id, p.call.id))
        break
      }
      case 'state':
        this.state = p.state
        this.composer.setState(p.state)
        this.resettleBefore(this.items.length)
        this.queue('state', () => this.showState())
        break
      case 'reset':
        this.replaceAll({ tabId: this.o.tabId, rev: this.rev, items: p.items, hasOlder: p.hasOlder, state: this.state })
        break
    }
    // a streamed text does not change an agent: the dock is looked at for the other patches
    if (p.op !== 'append') this.syncDock()
  }

  /**
   * The dock draws the subagents of the conversation's Agent calls, in the order they started: it opens when one runs, keeps the
   * rows of the done ones while others run, and closes DOCK_LINGER_MS after the last one ends. A chat drawn again starts closed
   * unless an agent runs. The dock shows the agents of the current turn only: those of the Agent calls since the person's last message.
   */
  private syncDock(): void {
    const agents = this.turnAgents()
    if (agents.some((agent) => agent.state === 'running')) {
      this.stopDockTimer()
      this.dockOpen = true
      this.dockRows = agents
      fillAgentsCard(this.dock, agents)
      this.dock.classList.add('shown')
      return
    }
    if (!this.dockOpen) return
    this.dockRows = this.dockRows.map((row) => this.agentNow(row.id) ?? row)
    fillAgentsCard(this.dock, this.dockRows)
    if (this.dockTimer === null) this.dockTimer = setTimeout(() => this.closeDock(), DOCK_LINGER_MS)
  }

  /** the subagents of the Agent calls from the person's last message on, in the order they started; an agent of an earlier turn stays while it runs, as a background one outlives its turn */
  private turnAgents(): ChatSubagent[] {
    let from = 0
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!
      if (item.kind === 'user' && item.from === undefined) {
        from = i + 1
        break
      }
    }
    const agentsOf = (items: ChatItem[]): ChatSubagent[] => items.flatMap((item) => (item.kind === 'tools' ? item.calls.flatMap((call) => call.agents) : []))
    const running = agentsOf(this.items.slice(0, from)).filter((agent) => agent.state === 'running')
    return [...running, ...agentsOf(this.items.slice(from))]
  }

  /** the latest state of an agent, whichever turn its Agent call is in */
  private agentNow(id: string): ChatSubagent | undefined {
    for (const item of this.items) {
      if (item.kind !== 'tools') continue
      for (const call of item.calls) {
        const agent = call.agents.find((a) => a.id === id)
        if (agent !== undefined) return agent
      }
    }
    return undefined
  }

  private closeDock(): void {
    this.dockTimer = null
    this.dockOpen = false
    this.dockRows = []
    this.dock.classList.remove('shown')
  }

  private stopDockTimer(): void {
    if (this.dockTimer !== null) clearTimeout(this.dockTimer)
    this.dockTimer = null
  }

  /** the newest items are the ones that change, so the scan starts from the end */
  private indexOf(id: string): number {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].id === id) return i
    return -1
  }

  private get(id: string): ChatItem | undefined {
    const i = this.indexOf(id)
    return i < 0 ? undefined : this.items[i]
  }

  /** the window is the last items: the column's end */
  private toTail(): void {
    this.to = this.items.length
    this.from = Math.max(0, this.to - WINDOW)
  }

  /** queues a drawing for the next animation frame; a drawing queued under the same key again is done once, in its first place */
  private queue(key: string, op: () => void): void {
    if (!this.visible) return
    this.queued.set(key, op)
    this.schedule()
  }

  /** the flush comes at the next animation frame, or from a timer when no frame does */
  private schedule(): void {
    if (!this.visible || this.frame !== null) return
    this.frame = {
      raf: requestAnimationFrame(() => this.flush()),
      // Chromium pauses animation frames in an occluded window, and a chat behind another window must stay current:
      // when no frame has come by then, the timer draws the queue
      timer: setTimeout(() => this.flush(), FRAME_FALLBACK_MS)
    }
  }

  private flush(): void {
    performance.mark('chat-frame:start')
    this.cancelFrame()
    const ops = [...this.queued.entries()]
    this.queued.clear()
    for (const [key, op] of ops) {
      // one drawing that throws does not lose the rest of the batch
      try {
        op()
      } catch (e) {
        console.error(`chat: drawing ${key} failed`, e)
      }
    }
    this.reconcile()
    if (this.cardsDirty) this.cardsDirty = !this.refreshCards()
    this.fresh.clear()
    this.settle()
    this.syncClock()
    this.updatePill()
    // the frame's work, measured for the perf harness (tests/perf/chat.perf.ts), which observes the measures; the buffer
    // is cleared so a long chat does not keep every frame's entries. The measure ends with the flush, so it holds settle's
    // forced layout but not the frame's own style, layout and paint after it: if a later change stops settle forcing the
    // layout, the number drops it silently
    performance.measure('chat-frame', 'chat-frame:start')
    performance.clearMarks('chat-frame:start')
    performance.clearMeasures('chat-frame')
  }

  /** the drawing queued before a snapshot is drawn by the snapshot instead */
  private dropQueued(): void {
    this.cancelFrame()
    this.queued.clear()
  }

  private cancelFrame(): void {
    if (this.frame === null) return
    cancelAnimationFrame(this.frame.raf)
    clearTimeout(this.frame.timer)
    this.frame = null
  }

  /**
   * The window's nodes made as the items are now: the nodes of the items out of the window go, and each item in it that has
   * no node is drawn, before the item after it. A new item pops in; the rest are drawn as they are. The browser keeps the item
   * in front of the user in place (scroll anchoring); the column only sticks to its bottom (settle).
   */
  private reconcile(): void {
    const wanted = new Set<string>()
    for (let i = this.from; i < this.to; i++) wanted.add(this.items[i].id)
    for (const id of [...this.drawn.keys()]) if (!wanted.has(id)) this.unmount(id)
    let before: HTMLElement = this.working
    for (let i = this.to - 1; i >= this.from; i--) {
      const item = this.items[i]
      let node = this.drawn.get(item.id)
      if (node === undefined) {
        node = this.drawSafely(item)
        if (this.fresh.has(item.id)) node.classList.add('chat-new')
        this.drawn.set(item.id, node)
        this.column.insertBefore(node, before)
      }
      before = node
    }
  }

  /** an item drawn on its own: one that throws leaves an empty node in its place, so the rest of the column is still drawn */
  private drawSafely(item: ChatItem): HTMLElement {
    try {
      return this.draw(item)
    } catch (e) {
      console.error(`chat: drawing ${item.id} failed`, e)
      const node = document.createElement('div')
      node.dataset.item = item.id
      return node
    }
  }

  /** the column drawn again from its window, every node made new: the steps' choices and the thinking blocks' are kept */
  private redraw(): void {
    this.dropQueued()
    this.fresh.clear()
    for (const id of [...this.drawn.keys()]) this.unmount(id)
    this.reconcile()
  }

  private unmount(id: string): void {
    const node = this.drawn.get(id)
    if (node === undefined) return
    this.keepFold(id, node)
    node.remove()
    this.drawn.delete(id)
  }

  /** a tool step's choices, or a thinking block's unfolding, as its node shows them, are kept by the item's id when the node goes */
  private keepFold(id: string, node: HTMLElement): void {
    if (node.classList.contains('chat-thinking')) {
      // open is a thinking block's default: only the user's fold is kept
      if (node.querySelector('.chat-thinking-head[aria-expanded="false"]') !== null) this.folds.set(id, { open: false, wells: [] })
      else this.folds.delete(id)
      return
    }
    if (!node.classList.contains('chat-steps')) return
    const keep = stepKeep(node)
    if (keep.open !== null || keep.wells.length > 0) this.folds.set(id, keep)
    else this.folds.delete(id)
  }

  /**
   * An item as the model has it now, drawn in place when it is in the window: a streaming text grows in place (only its tail
   * is drawn again); a tool step is updated where it is; anything else is drawn whole, and its node is replaced.
   */
  private drawItem(id: string): void {
    const item = this.get(id)
    const node = this.drawn.get(id)
    // an item out of the window has no node: the window draws it when it comes in
    if (!item || !node) return
    if (item.kind === 'text' && item.streaming && node.classList.contains('streaming')) {
      streamText(node, item.markdown)
      return
    }
    // a tool step is updated where it is: its rows, and the well the user unfolded, stay as they are
    if (item.kind === 'tools' && node.classList.contains('chat-steps')) {
      updateSteps(node, item, this.cb)
      return
    }
    this.paint(item, node)
  }

  /** a call's patch: its row is filled where it is, and the rest of the step is left as it is */
  private drawCall(id: string, callId: string): void {
    const item = this.get(id)
    const node = this.drawn.get(id)
    if (!item || !node) return
    if (item.kind === 'tools' && node.classList.contains('chat-steps')) updateSteps(node, item, this.cb, callId)
    else this.drawItem(id)
  }

  private paint(item: ChatItem, old: HTMLElement): void {
    // the fold choices of the node it replaces are kept for the new one
    this.keepFold(item.id, old)
    const node = this.draw(item)
    this.drawn.set(item.id, node)
    old.replaceWith(node)
  }

  /**
   * A step is settled once an item follows it, or its turn is over: until then its card stays open, between its calls too. The
   * images items that follow a step do not count: a step that shows a picture stays open until an item that is not one comes.
   */
  private settledAt(id: string): boolean {
    const i = this.indexOf(id)
    if (i < 0 || this.state.turn === 'idle') return true
    let j = i + 1
    while (j < this.items.length && this.items[j]!.kind === 'images') j++
    return j < this.items.length
  }

  /**
   * A drawn step is settled again only when its item can change: the step before the item at `end` (exclusive), when that item
   * is new or the turn changes. The images items between them do not settle a step, so the step before them is the one.
   */
  private resettleBefore(end: number): void {
    let i = end - 1
    while (i >= 0 && this.items[i]!.kind === 'images') i--
    const item = this.items[i]
    if (item?.kind !== 'tools') return
    // queued like the drawing: a hidden view changes nothing, and the step is settled when it is drawn again
    this.queue(`settle:${item.id}`, () => {
      const node = this.drawn.get(item.id)
      if (node?.classList.contains('chat-steps')) setSettled(node, this.settledAt(item.id))
    })
  }

  private draw(item: ChatItem): HTMLElement {
    const node = item.kind === 'card' ? this.drawCard(item) : renderItem(item, this.cb, item.kind === 'tools' || item.kind === 'thinking' ? this.folds.get(item.id) ?? null : null, this.settledAt(item.id))
    // the item's id on its node: a test, or a reader of the DOM, follows the same item across redraws
    node.dataset.item = item.id
    return node
  }

  /** the open cards, oldest first: the first is active, the second waits folded under it, and more is how many wait behind the active one */
  private cardOrder(): { active: string | null; next: string | null; more: number } {
    const open = this.items.flatMap((item) => (item.kind === 'card' && item.answered === null ? [item.id] : []))
    return { active: open[0] ?? null, next: open[1] ?? null, more: Math.max(0, open.length - 1) }
  }

  /** how a card is drawn now: answered and active ones in full, the next one as the waiting line, any other hidden */
  private cardMode(item: CardItem, order: { active: string | null; next: string | null; more: number }): string {
    if (item.answered !== null) return 'answered'
    if (item.id === order.active) return 'active'
    if (item.id === order.next) return `waiting:${order.more}`
    return 'hidden'
  }

  private drawCard(item: CardItem): HTMLElement {
    const order = this.cardOrder()
    const mode = this.cardMode(item, order)
    const node = mode.startsWith('waiting') ? waitingCard(order.more) : mode === 'hidden' ? document.createElement('div') : renderCard(item, this.cb)
    if (mode === 'hidden') node.hidden = true
    // the mode the node was drawn in: a change of it draws the card again
    node.dataset.card = mode
    return node
  }

  /**
   * The cards are drawn in their order: a card whose mode changed is drawn again, and the active one takes the keyboard when it
   * becomes active, unless the composer has the focus and a draft (then the composer pulses and Tab moves to it). True when the
   * cards are settled; false while the active card is out of the window, so the next flush comes back to it.
   */
  private refreshCards(takeFocus = true): boolean {
    const order = this.cardOrder()
    for (let i = this.from; i < this.to; i++) {
      const item = this.items[i]
      if (item.kind !== 'card') continue
      const node = this.drawn.get(item.id)
      if (node && node.dataset.card !== this.cardMode(item, order)) this.paint(item, node)
    }
    if (order.active === this.activeCard) return true
    if (order.active !== null && !this.drawn.has(order.active)) {
      // the active card is out of the window: the window moves to it, once
      this.windowAround(order.active)
      this.reconcile()
      if (!this.drawn.has(order.active)) return false
    }
    this.activeCard = order.active
    if (order.active === null) {
      // the answered card held the keyboard: it goes back to the composer
      if (document.activeElement === null || document.activeElement === document.body) this.composer.focus()
      this.composer.pulse(false)
      return true
    }
    this.composer.pulse(true)
    if (takeFocus && this.mayTakeFocus()) focusCard(this.drawn.get(order.active)!)
    return true
  }

  /**
   * Whether a card may take the keyboard now: only where the user types nothing else. That is the page, the chat, or the
   * composer with no draft. Find, the Note, a rename, a settings field, or a composer with a draft keep the focus, and the card
   * waits for Tab or a click.
   */
  private mayTakeFocus(): boolean {
    const at = document.activeElement
    if (at === null || at === document.body) return true
    if (this.body.contains(at)) return true
    if (this.composer.element.contains(at)) return !this.composer.hasDraft()
    return false
  }

  /** the cards drawn again with the view: the active one takes the keyboard again, its node being made new */
  private settleCards(takeFocus = true): void {
    this.activeCard = null
    this.cardsDirty = !this.refreshCards(takeFocus)
  }

  /** the window moves up by a page; at the first item held, the page before it is asked for, once */
  private growUp(): void {
    if (this.from === 0) {
      const first = this.items[0]
      if (this.hasOlder && this.olderAsked === null && first !== undefined) this.askOlder(first.id)
      return
    }
    // the browser keeps the item in view in place, except at the very top: there it does not anchor, so the first item is
    // held here, or the view would stay at the top with nothing left to scroll to
    const atTop = this.scroll.scrollTop === 0 ? this.column.firstElementChild : null
    const before = atTop?.getBoundingClientRect().top
    this.from = Math.max(0, this.from - PAGE_STEP)
    this.to = Math.min(this.to, this.from + WINDOW)
    this.reconcile()
    if (atTop !== null && before !== undefined && atTop.isConnected) {
      this.scroll.scrollTop += atTop.getBoundingClientRect().top - before
    }
  }

  /** the window moves down by a page, toward the newest items */
  private growDown(): void {
    this.to = Math.min(this.items.length, this.to + PAGE_STEP)
    this.from = Math.max(this.from, this.to - WINDOW)
    this.reconcile()
  }

  /**
   * asks for the page before the first item; its answer is taken only while that item is still the first. A dropped or empty
   * answer is asked for once more while the view is still held at the top; a refusal is not asked again by itself
   */
  private askOlder(beforeId: string, again = true): void {
    this.older(beforeId).then(
      taken => {
        if (!this.visible || !this.nearTop()) return
        if (taken !== null && taken.count > 0) this.growUp()
        else if (again && this.hasOlder && this.items[0] !== undefined) this.askOlder(this.items[0].id, false)
      },
      // a refused request is not asked again by itself
      () => undefined,
    )
  }

  /**
   * The page before `beforeId`, asked for once at a time. Its answer is taken only while that item is still the first: the
   * result is the count taken, or null when nothing was taken. A refusal rejects.
   */
  private older(beforeId: string): Promise<{ count: number } | null> {
    const asked = this.o.older(beforeId).then(
      page => {
        this.olderAsked = null
        if (page === null || this.items[0]?.id !== beforeId) return null
        this.hasOlder = page.hasOlder
        // the page goes in above the window; the window moves up into it as the user reads up
        if (page.items.length > 0) {
          this.items = [...page.items, ...this.items]
          this.from += page.items.length
          this.to += page.items.length
        }
        return { count: page.items.length }
      },
      (e: unknown) => {
        this.olderAsked = null
        throw e
      },
    )
    this.olderAsked = asked
    return asked
  }

  /** the composer and the working line show the turn as the state has it, and what the chat does between its turns */
  private showState(): void {
    if (!this.visible) return
    const turn = this.state.turn
    const activity = this.state.activity
    this.working.hidden = turn === 'idle' && activity === undefined
    this.verb.textContent = activity?.kind === 'compacting' ? 'Compacting conversation'
      : activity?.kind === 'restarting' ? 'Restarting Claude Code'
        : turn === 'waiting' ? 'Waiting for you' : 'Working'
    this.verb.classList.toggle('chat-shimmer', activity !== undefined)
    this.activityBar.hidden = activity === undefined
    // Esc interrupts a running turn only: not while Claude waits for the user, nor during an idle compaction
    this.hintSep.hidden = turn !== 'working'
    this.hint.hidden = turn !== 'working'
    this.tickElapsed()
    this.syncClock()
    this.settle()
  }

  /** the elapsed time of the line: from the start of its activity, else of the turn; shown only while there is one that started */
  private tickElapsed(): void {
    const started = this.state.activity?.since ?? (this.state.turn === 'idle' ? null : this.state.turnStartedAt)
    const shown = started !== null
    this.elapsedSep.hidden = !shown
    this.elapsed.hidden = !shown
    if (shown) this.elapsed.textContent = elapsedText(Date.now() - started)
  }

  /** the elapsed time ticks once a second while the chat is shown and a turn runs */
  private syncClock(): void {
    const run = this.visible && (this.state.turn !== 'idle' || this.state.activity !== undefined)
    if (run && this.clock === null) this.clock = setInterval(() => this.tickElapsed(), 1000)
    if (!run) this.stopClock()
  }

  private stopClock(): void {
    if (this.clock !== null) clearInterval(this.clock)
    this.clock = null
  }

  /** the first item drawn that is at least partly in view, and its top's offset from the top of the view */
  private topItem(): { id: string; offset: number } | null {
    const top = this.scroll.getBoundingClientRect().top
    for (const node of Array.from(this.column.children)) {
      if (!(node instanceof HTMLElement) || node.dataset.item === undefined) continue
      const box = node.getBoundingClientRect()
      if (box.bottom > top) return { id: node.dataset.item, offset: box.top - top }
    }
    return null
  }

  /** the item the reader was on stays at the same offset from the top of the view */
  private keepAt(anchor: { id: string; offset: number }): void {
    const node = this.drawn.get(anchor.id)
    if (node === undefined) return
    const top = this.scroll.getBoundingClientRect().top
    this.scroll.scrollTop += node.getBoundingClientRect().top - top - anchor.offset
  }

  /** the window is the items around one of them: a page above it, and the rest below */
  private windowAround(id: string): void {
    this.from = Math.max(0, this.indexOf(id) - PAGE_STEP)
    this.to = Math.min(this.items.length, this.from + WINDOW)
  }

  /** the folds of the items that are gone are forgotten */
  private pruneFolds(): void {
    const ids = new Set(this.items.map((item) => item.id))
    for (const id of [...this.folds.keys()]) if (!ids.has(id)) this.folds.delete(id)
  }

  private settle(): void {
    if (!this.visible || !this.stick) return
    this.scroll.scrollTop = this.scroll.scrollHeight
    this.settledTop = this.scroll.scrollTop
  }

  /** the pill shows while items the user has not seen are below the view */
  private updatePill(): void {
    this.pill.hidden = this.stick || !this.unseen
  }

  /** the pill's click: the window moves to the newest items, and the column goes to its bottom */
  private toEnd(): void {
    this.toTail()
    this.unseen = false
    this.stick = true
    this.reconcile()
    this.settle()
    this.updatePill()
  }

  private nearTop(): boolean {
    return this.scroll.scrollTop < EDGE_ZONE
  }

  private distanceToBottom(): number {
    return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight
  }

  private onScroll(): void {
    if (!this.visible) return
    if (this.nearTop()) this.growUp()
    if (this.distanceToBottom() < EDGE_ZONE && this.to < this.items.length) this.growDown()
    const atEnd = this.distanceToBottom() <= BOTTOM_SLACK
    // a stuck column leaves its end only when the user scrolls up from where settle() put it: a scroll event that finds the end
    // farther away while the column did not move up (the area shrank before the resize observer ran, as when the tab's status bar
    // shows) goes to the end again
    const stick = this.to === this.items.length && (atEnd || (this.stick && this.scroll.scrollTop >= this.settledTop))
    this.stick = stick
    if (stick) {
      this.unseen = false
      if (atEnd) this.settledTop = this.scroll.scrollTop
      else this.settle()
    }
    this.updatePill()
  }
}
