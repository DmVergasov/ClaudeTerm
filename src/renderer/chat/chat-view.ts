import { acceptPatches, commandWord, typedMessages, type AgentPatch, type AgentSnapshot, type ChatAnswer, type ChatAttachment, type ChatCommandInfo, type ChatItem, type ChatModelInfo, type ChatPatch, type ChatPermissionMode, type ChatSend, type ChatSnapshot, type ChatState, type ChatSubagent, type HeadsUpAction, type HeadsUpCard } from '../../shared/chat'
import type { McpSection, ReloadAction } from '../../shared/mcp'
import type { ImageCard } from '../../shared/types'
import { spinner } from '../tab-row'
import { ChatComposer } from './chat-composer'
import { QuoteButton, splitQuotes } from './chat-quote'
import { HeadsUpView } from './heads-up-card'
import { renderItem, type ItemCallbacks } from './chat-items'
import { focusCard, renderCard, waitingCard } from './chat-cards'
import { agentColor, elapsedText, fillAgentsCard, setSettled, tickAgentTimes, type StepKeep } from './chat-steps'
import { AgentPage } from './agent-page'
import { BOTTOM_SLACK, drawCallInPlace, drawInPlace, drawSafely, EDGE_ZONE, FrameQueue, joinSnapshot, keepAtNode, keepFold, OlderPages, pageDownWin, pageUpInView, pageUpWin, revealWin, scrollToMiddle, settledAfter, stepBefore, tailWin, topItemOf, windowAt } from './column-draw'
import type { FindView } from './chat-find'
import { chatPalette } from '../themes'
import { countdown, resetClock } from '../limit-meters'
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
  /** /mcp and /plugin: the MCP · Plugins panel opens on the section; null: nothing is sent, a string: the line the composer shows and the text goes as typed */
  openMcp(section: McpSection): string | null
  /** a notice's line, or null for a dialog the chat cannot show (the terminal is switched to only) */
  openInTerminal(line: string | null): Promise<boolean>
  askSwitch(go: () => void, cancel: () => void): () => void
  answer(cardId: string, a: ChatAnswer): void | Promise<boolean>
  restart(): void
  /** the reload card's buttons: Not now or Restart for this chat; null for a remote chat, whose card has none */
  reload: ((action: ReloadAction) => void) | null
  /** the page of items before `beforeId`; null when the chat is gone */
  older(beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
  imageCard(cardId: string): ImageCard | null
  openImages(cards: ImageCard[], index: number): void
  revealChange(path: string): void
  openExternal(url: string): void
  copy(text: string): void
  /** the person's answer to the chat's Heads up card */
  headsUp(cardId: string, action: HeadsUpAction): void
  /** an agent's snapshot, for its page; null when the agent is gone */
  agentSnapshot(agentId: string): Promise<AgentSnapshot | null>
  /** the page of an agent's items before `beforeId`; null when the agent is gone */
  agentOlder(agentId: string, beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
  /** the agent whose page is shown is watched (its patches come); null: no page is shown any more */
  watchAgent(agentId: string | null): void
  /** a message to an agent of this chat, through the main conversation as a forward: the refusal, or null when it went */
  sendToAgent(agentId: string, text: string): Promise<string | null>
  /** a member's device: the host's agents are read here, not written */
  readOnly: boolean
}

const NO_STATE: ChatState = { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false }

/** the id of a list's last item, null for an empty list */
const lastId = (items: readonly ChatItem[]): string | null => (items.length === 0 ? null : items[items.length - 1]!.id)

/** the dock keeps its rows this long after its last running agent ends, then closes */
const DOCK_LINGER_MS = 4000

type CardItem = Extract<ChatItem, { kind: 'card' }>

/** an agent's patches that came while its page was opening, as they came */
interface PendingBatch { fromRev: number; toRev: number; patches: AgentPatch[] }

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
  /** the Heads up card, above the message box */
  private readonly headsUpView: HeadsUpView
  private readonly cb: ItemCallbacks
  private items: ChatItem[] = []
  /** the dock: the subagents of the Agent calls that run, the column's last message, right before the working line */
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
  /** the older pages of the conversation, asked for one at a time (column-draw.ts) */
  private readonly pages = new OlderPages({
    ask: (beforeId) => this.o.older(beforeId),
    first: () => this.items[0],
    take: (items) => {
      this.items = [...items, ...this.items]
      this.from += items.length
      this.to += items.length
    },
    ready: () => this.drawing(),
    nearTop: () => this.nearTop(),
    grow: () => this.growUp()
  })
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
  /** the drawings waiting for the next animation frame: an item is drawn once per frame, however many patches changed it */
  private readonly frames = new FrameQueue({
    ready: () => this.drawing(),
    label: 'chat',
    begin: () => {
      performance.mark('chat-frame:start')
      this.catchScroll()
    },
    end: () => this.flushed()
  })
  /** a card was added, changed or removed: the flush puts the cards in their order again */
  private cardsDirty = false
  /** the card that was made active last: it takes the keyboard when it changes */
  private activeCard: string | null = null
  /** the elapsed time of the working line ticks while it shows */
  private clock: ReturnType<typeof setInterval> | null = null
  /** a turn the usage limit stopped: when (ms) Claude goes on by itself after the reset; null when the chat does not wait */
  private limitWait: number | null = null
  /** the working line says when Claude goes on after the usage limit */
  private waitShown = false
  /** an agent's page, in place of the conversation and its composer, while one is open */
  private page: AgentPage | null = null
  /** the message box's draft of each agent, kept while the tab lives: a page opened again starts with it */
  private readonly drafts = new Map<string, string>()
  /** the top item of the column when the page opened (null when the column was stuck to its end): the column goes back to it */
  private pageAnchor: { id: string; offset: number } | null = null
  /** the last agent asked for: an answer that comes after a later request is not drawn */
  private agentAsk = 0
  /** the page being opened: its agent is watched while its snapshot is taken, and the patches that come meanwhile wait here */
  private agentOpening: { ask: number; agentId: string; batches: PendingBatch[] } | null = null
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
    // the dock is the conversation's last message, in the column's flow: it takes its own room after the items, so no line is
    // ever under it, and it moves with the conversation when the column scrolls
    this.dock.className = 'chat-agents-dock'
    this.column.append(this.dock, this.working)
    this.scroll.append(this.column)
    this.scroll.addEventListener('scroll', () => this.onScroll())
    this.resize.observe(this.scroll)
    this.resize.observe(this.column)
    this.cb = {
      answer: (cardId, a) => o.answer(cardId, a),
      restart: () => o.restart(),
      // a notice's button runs its line as the composer runs a command: it waits for the turn, and asks the header first
      openInTerminal: (line) => this.composer.openNoticeLine(line),
      // a notice's button opens the servers, as /mcp does
      openMcp: () => { o.openMcp('servers') },
      reload: o.reload,
      imageCard: (cardId) => o.imageCard(cardId),
      openImages: (cards, index) => o.openImages(cards, index),
      openAgent: (agentId) => {
        void this.openAgent(agentId)
      },
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
      openMcp: (section) => o.openMcp(section),
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
    // Esc on the agent page goes back to the conversation; it never interrupts a turn, and it stops here, not in the window's keys
    this.element.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.repeat || e.isComposing || this.page === null) return
      if (!(e.target instanceof Node) || !this.page.owns(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      this.closeAgent()
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
    this.resize.observe(this.dock)
    this.headsUpView = new HeadsUpView({ act: (cardId, action) => o.headsUp(cardId, action), openExternal: (url) => o.openExternal(url), copy: (text) => o.copy(text) })
    this.composer.element.prepend(this.headsUpView.element)
    this.element.append(this.body, this.composer.element)
    o.container.append(this.element)
    this.show(false)
  }

  show(visible: boolean, focus = true): void {
    const was = this.visible
    if (!visible && was) this.top = this.scroll.scrollTop
    // the page's column keeps its reading place: it is told before the view is hidden, while its scroll position can still be read
    if (!visible) this.page?.show(false)
    this.visible = visible
    this.quote.setActive(visible && this.page === null)
    this.element.style.display = visible ? 'flex' : 'none'
    this.syncClock()
    if (!visible) {
      // a hidden chat has no menu or picker open: they close, and do not come back with the chat
      this.composer.closePickers()
      this.frames.drop()
      return
    }
    if (this.page !== null) {
      // the page is shown again: its agent is watched again and its snapshot taken again, as the conversation's is
      this.page.show(true)
      this.syncWaiting()
      this.reloadAgent()
      if (focus) this.page.focus()
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
    const { items, at } = joinSnapshot(this.items, s.items)
    if (at < 0) {
      this.replaceAll(s)
      return
    }
    // an agent page open is reloaded with the conversation: the agent may have ended, or gone
    if (this.page !== null) this.reloadAgent()
    this.frames.drop()
    for (const [id, node] of this.drawn) keepFold(this.folds, id, node)
    // the item at the top of the view, and its offset from the top: kept while the user reads up
    const anchor = this.stick || !this.drawing() ? null : this.topItem()
    const lastChanged = lastId(this.items) !== lastId(s.items)
    this.items = items
    this.syncWaiting()
    this.syncDock()
    // the older pages held stay, and their hasOlder with them; a snapshot that starts the chat tells whether there are more
    if (at === 0) this.pages.hasOlder = s.hasOlder
    this.rev = s.rev
    this.state = s.state
    this.page?.setChatExited(s.state.exited)
    this.composer.setState(s.state)
    this.pruneFolds()
    const kept = anchor !== null && this.indexOf(anchor.id) >= 0 ? anchor : null
    if (this.page !== null) {
      // an agent page is in place of the conversation: the reading place and the window wait for its close (closeAgent)
      if (this.stick) this.toTail()
      else this.unseen = this.unseen || lastChanged
    } else if (kept === null) {
      this.stick = true
      this.unseen = false
      this.toTail()
    } else {
      this.unseen = this.unseen || lastChanged
      this.windowAround(kept.id)
    }
    if (!this.drawing()) return
    this.redraw()
    this.settleCards()
    if (kept !== null) this.keepAt(kept)
    this.showState()
    this.updatePill()
  }

  /** the view takes the snapshot as the whole chat: its window is the newest items, and it sticks to the bottom */
  private replaceAll(s: ChatSnapshot): void {
    if (this.page !== null) this.reloadAgent()
    this.frames.drop()
    for (const [id, node] of this.drawn) keepFold(this.folds, id, node)
    this.rev = s.rev
    this.pages.hasOlder = s.hasOlder
    this.items = [...s.items]
    this.syncWaiting()
    // a chat drawn again from its snapshot starts with the dock as its agents run now, and a dock that was open is closed first
    this.stopDockTimer()
    this.closeDock()
    this.syncDock()
    this.pruneFolds()
    this.state = s.state
    this.page?.setChatExited(s.state.exited)
    this.composer.setState(s.state)
    // with an agent page in place, the reading place waits for its close: a stuck column keeps its end, another keeps its window
    if (this.page === null || this.stick) {
      this.stick = true
      this.unseen = false
      this.toTail()
    }
    if (!this.drawing()) return
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
    this.catchScroll()
    for (const p of patches.slice(accept.skip)) this.apply(p)
    this.rev = toRev
    this.syncWaiting()
    return true
  }

  /**
   * Opens an agent's page in place of the conversation and its composer. The snapshot is taken first; the last call wins. The
   * column keeps its place: the top item when the page opens (null when the column is stuck to its end), so closing goes back to it.
   */
  async openAgent(agentId: string): Promise<void> {
    const ask = ++this.agentAsk
    // the agent is watched before its snapshot is taken: a patch made in between is held, and applied once the snapshot is in
    const opening = { ask, agentId, batches: [] as PendingBatch[] }
    this.agentOpening = opening
    this.watch(agentId)
    // a snapshot that fails opens no page, as a gone agent does: the watch and the held patches are let go below
    const s = await this.o.agentSnapshot(agentId).catch(() => null)
    // a later call, or a close, owns the watch now
    if (ask !== this.agentAsk) return
    this.agentOpening = null
    if (s === null) {
      // the agent is gone, or its snapshot failed: the page shown (if any) is watched again
      this.watch(this.page?.agentId ?? null)
      return
    }
    const shown = this.page
    const anchor = shown !== null ? this.pageAnchor : this.drawing() && !this.stick ? this.topItem() : null
    shown?.dispose()
    this.pageAnchor = anchor
    const index = this.dockRows.findIndex((row) => row.id === agentId)
    const page = new AgentPage({
      agentId,
      cb: this.cb,
      color: agentColor(Math.max(0, index)),
      back: () => this.closeAgent(),
      backToCard: () => this.closeAgent(true),
      older: (beforeId) => this.o.agentOlder(agentId, beforeId),
      send: (text) => this.o.sendToAgent(agentId, text),
      draft: this.drafts.get(agentId) ?? '',
      keepDraft: (text) => this.keepDraft(agentId, text),
      sent: (draft) => this.draftSent(agentId, draft),
      readOnly: this.o.readOnly
    })
    this.page = page
    this.element.insertBefore(page.element, this.body)
    this.element.insertBefore(page.footer, this.composer.element)
    this.placeDock()
    this.body.style.display = 'none'
    this.composer.element.style.display = 'none'
    this.quote.setActive(false)
    page.load(s)
    page.setChatExited(this.state.exited)
    page.show(this.visible)
    this.syncWaiting()
    for (const batch of opening.batches) {
      if (!page.patch(batch.fromRev, batch.toRev, batch.patches)) {
        this.reloadAgent()
        break
      }
    }
    this.syncDock()
    this.syncClock()
    if (this.visible) page.focus()
  }

  /** the dock sits between the page and its footer while a page is open, so the open row is in sight; else in the column, before the working line */
  private placeDock(): void {
    if (this.page !== null) this.element.insertBefore(this.dock, this.page.footer)
    else this.column.insertBefore(this.dock, this.working)
  }

  /** the agent is watched by the window only while this chat is the one in front: a hidden chat's page does not take the watch from the front one */
  private watch(agentId: string | null): void {
    if (this.visible) this.o.watchAgent(agentId)
  }

  /** the main conversation's waiting card, if any, is the page's bar: shown while a card waits, and not on a page that is not open */
  private syncWaiting(): void {
    this.page?.setWaiting(this.cardOrder().active !== null)
  }

  /**
   * Closes the agent page: the conversation and its composer come back, and the column goes to where it was when the page opened, to
   * its end when it was stuck there, else to the same top item at the same offset. The agent is no longer watched. `takeCard` (the
   * waiting bar's click) gives the keyboard to the card that waits, as the conversation's own cards do.
   */
  closeAgent(takeCard = false): void {
    // a page that is still opening is cancelled: its snapshot, when it comes, is not drawn
    const pending = this.agentOpening !== null
    this.agentAsk++
    this.agentOpening = null
    const page = this.page
    if (page === null) {
      if (pending) this.watch(null)
      return
    }
    this.page = null
    page.dispose()
    this.body.style.display = ''
    this.composer.element.style.display = ''
    this.quote.setActive(this.visible)
    this.placeDock()
    this.watch(null)
    const anchor = this.pageAnchor
    this.pageAnchor = null
    this.syncDock()
    this.syncClock()
    if (!this.visible) return
    if (anchor === null || this.indexOf(anchor.id) < 0) {
      this.stick = true
      this.unseen = false
      this.toTail()
      this.redraw()
      this.settle()
    } else {
      this.windowAround(anchor.id)
      this.redraw()
      this.keepAt(anchor)
    }
    this.showState()
    this.settleCards(takeCard)
    this.updatePill()
    // the card that took the keyboard keeps it; else the composer (or the view's own focus) takes it
    if (!takeCard || this.activeCard === null) this.focus()
  }

  /** an agent's draft in its message box: kept for the page opened again, and dropped when it is empty */
  private keepDraft(agentId: string, text: string): void {
    if (text === '') this.drafts.delete(agentId)
    else this.drafts.set(agentId, text)
  }

  /** a message went from an agent's draft: the draft is dropped when it is still that text, and the page that shows it empties; a draft edited since stays */
  private draftSent(agentId: string, draft: string): void {
    if (this.drafts.get(agentId) !== draft) return
    this.drafts.delete(agentId)
    if (this.page?.agentId === agentId) this.page.clearSent(draft)
  }

  /** the agent whose page is shown; null when no page is open */
  shownAgent(): string | null {
    return this.page?.agentId ?? null
  }

  /**
   * An agent's patches. Only the page shown takes them: another agent's are not its page's and are ignored (true). False only on a gap
   * of the page shown; the caller then asks for its snapshot again (reloadAgent).
   */
  agentPatch(agentId: string, fromRev: number, toRev: number, patches: AgentPatch[]): boolean {
    // a page that is opening holds its agent's patches until its snapshot is in
    if (this.agentOpening !== null && this.agentOpening.agentId === agentId) {
      this.agentOpening.batches.push({ fromRev, toRev, patches })
      return true
    }
    if (this.page === null || this.page.agentId !== agentId) return true
    return this.page.patch(fromRev, toRev, patches)
  }

  /**
   * The page shown takes its agent's snapshot again: its agent is watched again first, as the hub drops the watches of a chat that
   * ends or restarts. A snapshot that is gone closes the page.
   */
  reloadAgent(): void {
    const page = this.page
    if (page === null) return
    this.watch(page.agentId)
    this.o.agentSnapshot(page.agentId).then(
      (s) => {
        if (this.page !== page) return
        if (s === null) this.closeAgent()
        else page.load(s)
      },
      () => undefined
    )
  }

  /**
   * The tab's images changed: a bubble or an images item whose card has come, or gone, is drawn again. Only the window is looked
   * at, and a hidden view does nothing: the window is drawn again when it is shown.
   */
  imagesChanged(): void {
    this.composer.imagesChanged()
    if (!this.drawing()) return
    for (let i = this.from; i < this.to; i++) {
      const item = this.items[i]!
      if (item.kind === 'images') {
        // the images item shows the cards it has: one drawn for each card that is known now
        const found = item.images.filter((image) => this.hasCard(image.cardId)).length
        const shown = this.drawn.get(item.id)?.querySelectorAll('.chat-image-card').length ?? 0
        if (found !== shown) this.frames.add(`item:${item.id}`, () => this.drawItem(item.id))
      } else if (item.kind === 'user') {
        // a bubble's pictures with a card are thumbnails: the bubble is drawn again when their number changed
        const known = item.attachments.filter((a) => a.kind === 'image' && this.hasCard(a.cardId)).length
        const thumbs = this.drawn.get(item.id)?.querySelectorAll('.chat-thumb').length ?? 0
        if (known !== thumbs) this.frames.add(`item:${item.id}`, () => this.drawItem(item.id))
      }
    }
  }

  /** the items held: the window is a part of them */
  itemCount(): number {
    return this.items.length
  }

  /** whether the conversation is shown: a hidden chat, or one with an agent page in its place, is not searched for older pages */
  isShown(): boolean {
    return this.drawing()
  }

  /** whether the conversation is drawn: the chat is shown, and no agent page is in its place */
  private drawing(): boolean {
    return this.visible && this.page === null
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
    return this.pages.hasOlder
  }

  /** asks for the page of items before the first one held: resolves to whether items came in above the window */
  loadOlder(): Promise<boolean> {
    return this.pages.load()
  }

  /** the agent page in place of the conversation, as a find's view; null while the conversation is shown */
  agentFindView(): FindView | null {
    return this.page?.findView() ?? null
  }

  /**
   * Brings an item into the window and scrolls the column to its middle: Find's current match. The window is the items around
   * it; the bottom stick and the pill follow from where the column lands.
   */
  reveal(id: string): boolean {
    const i = this.indexOf(id)
    if (i < 0 || !this.drawing()) return false
    const len = this.items.length
    const w = revealWin(len, i)
    this.from = w.from
    this.to = w.to
    this.reconcile()
    const node = this.drawn.get(id)
    if (node === undefined) return false
    scrollToMiddle(this.scroll, node)
    this.stick = this.to === len && this.distanceToBottom() <= BOTTOM_SLACK
    this.updatePill()
    return true
  }

  /** the chat's colours follow the terminal theme: the host takes the theme's chat tokens, and the window's own stay as they are */
  setTheme(theme: ITheme): void {
    for (const [name, value] of Object.entries(chatPalette(theme))) this.element.style.setProperty(name, value)
  }

  /** the setting: the conversation and the message box take the chat's whole width, not a reading column */
  /** the chat's Heads up card, above the message box; null takes it away */
  showHeadsUp(card: HeadsUpCard | null): void {
    this.headsUpView.show(card)
  }

  setFullWidth(on: boolean): void {
    this.element.classList.toggle('chat-wide', on)
  }

  /** the chat's keyboard: the agent page while one is open (its composer is hidden), else the composer */
  focus(): void {
    if (this.page !== null) this.page.focus()
    else this.composer.focus()
  }

  /** a line goes to the terminal as a notice's line does: it waits for the turn, and asks first when background tasks would stop */
  runInTerminal(line: string): void {
    this.composer.openNoticeLine(line)
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
    // a page still opening is cancelled, as closeAgent does
    if (this.agentOpening !== null) this.watch(null)
    this.agentAsk++
    this.agentOpening = null
    if (this.page !== null) {
      this.page.dispose()
      this.page = null
      this.watch(null)
    }
    this.visible = false
    this.resize.disconnect()
    this.composer.dispose()
    this.quote.dispose()
    this.frames.drop()
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
        if (this.drawing()) this.fresh.add(p.item.id)
        this.frames.add(`item:${p.item.id}`, () => this.drawItem(p.item.id))
        break
      case 'set': {
        const i = this.indexOf(p.item.id)
        if (i < 0) break
        this.items[i] = p.item
        if (p.item.kind === 'card') this.cardsDirty = true
        this.frames.add(`item:${p.item.id}`, () => this.drawItem(p.item.id))
        break
      }
      case 'append': {
        const i = this.indexOf(p.id)
        if (i < 0) break
        const item = this.items[i]
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
        this.cardsDirty = true
        if (i < this.from) this.from--
        if (i < this.to) this.to--
        this.folds.delete(p.id)
        this.frames.request()
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
        this.frames.add(`call:${p.id}:${p.call.id}`, () => this.drawCall(p.id, p.call.id))
        break
      }
      case 'state':
        this.state = p.state
        this.page?.setChatExited(p.state.exited)
        this.composer.setState(p.state)
        this.resettleBefore(this.items.length)
        this.frames.add('state', () => this.showState())
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
      this.fillDock(agents)
      this.dock.classList.add('shown')
      this.syncClock()
      return
    }
    if (!this.dockOpen) return
    this.dockRows = this.dockRows.map((row) => this.agentNow(row.id) ?? row)
    this.fillDock(this.dockRows)
    this.syncClock()
    if (this.dockTimer === null) this.dockTimer = setTimeout(() => this.closeDock(), DOCK_LINGER_MS)
  }

  /** the dock's card: its rows open the agents' pages, and the row of the open page is marked */
  private fillDock(agents: ChatSubagent[]): void {
    fillAgentsCard(this.dock, agents, { open: (agentId) => this.cb.openAgent(agentId), current: this.page?.agentId ?? null })
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
    this.syncClock()
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
    const w = tailWin(this.items.length)
    this.from = w.from
    this.to = w.to
  }

  /**
   * What a frame does after its queued drawings: the window is drawn, the cards are put in order, and the column settles. The
   * measure is the frame's work, for the perf harness (tests/perf/chat.perf.ts), which observes the measures; the buffer is cleared
   * so a long chat does not keep every frame's entries. The measure ends with the flush, so it holds settle's forced layout but not
   * the frame's own style, layout and paint after it: if a later change stops settle forcing the layout, the number drops it silently
   */
  private flushed(): void {
    this.reconcile()
    if (this.cardsDirty) this.cardsDirty = !this.refreshCards()
    this.fresh.clear()
    this.settle()
    this.syncClock()
    this.updatePill()
    performance.measure('chat-frame', 'chat-frame:start')
    performance.clearMarks('chat-frame:start')
    performance.clearMeasures('chat-frame')
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
    let before: HTMLElement = this.dock
    for (let i = this.to - 1; i >= this.from; i--) {
      const item = this.items[i]
      let node = this.drawn.get(item.id)
      if (node === undefined) {
        node = drawSafely(item, (it) => this.draw(it), 'chat')
        if (this.fresh.has(item.id)) node.classList.add('chat-new')
        this.drawn.set(item.id, node)
        this.column.insertBefore(node, before)
      }
      before = node
    }
  }

  /** the column drawn again from its window, every node made new: the steps' choices and the thinking blocks' are kept */
  private redraw(): void {
    this.frames.drop()
    this.fresh.clear()
    for (const id of [...this.drawn.keys()]) this.unmount(id)
    this.reconcile()
  }

  private unmount(id: string): void {
    const node = this.drawn.get(id)
    if (node === undefined) return
    keepFold(this.folds, id, node)
    node.remove()
    this.drawn.delete(id)
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
    drawInPlace(item, node, this.cb, () => this.paint(item, node))
  }

  /** a call's patch: its row is filled where it is, and the rest of the step is left as it is */
  private drawCall(id: string, callId: string): void {
    const item = this.get(id)
    const node = this.drawn.get(id)
    if (!item || !node) return
    drawCallInPlace(item, node, callId, this.cb, () => this.drawItem(id))
  }

  private paint(item: ChatItem, old: HTMLElement): void {
    // the fold choices of the node it replaces are kept for the new one
    keepFold(this.folds, item.id, old)
    const node = this.draw(item)
    this.drawn.set(item.id, node)
    old.replaceWith(node)
  }

  /**
   * A step is settled once an item follows it, or its turn is over: until then its card stays open, between its calls too. The
   * images items that follow a step do not count: a step that shows a picture stays open until an item that is not one comes.
   */
  private settledAt(id: string): boolean {
    return settledAfter(this.items, id, this.state.turn === 'idle')
  }

  /**
   * A drawn step is settled again only when its item can change: the step before the item at `end` (exclusive), when that item
   * is new or the turn changes. The images items between them do not settle a step, so the step before them is the one.
   */
  private resettleBefore(end: number): void {
    const item = stepBefore(this.items, end)
    if (item === null) return
    // queued like the drawing: a hidden view changes nothing, and the step is settled when it is drawn again
    this.frames.add(`settle:${item.id}`, () => {
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
      this.pages.askFirst()
      return
    }
    pageUpInView(this.scroll, this.column, () => {
      const w = pageUpWin({ from: this.from, to: this.to })
      this.from = w.from
      this.to = w.to
      this.reconcile()
    })
  }

  /** the window moves down by a page, toward the newest items */
  private growDown(): void {
    const w = pageDownWin({ from: this.from, to: this.to }, this.items.length)
    this.from = w.from
    this.to = w.to
    this.reconcile()
  }

  /** the composer and the working line show the turn as the state has it, and what the chat does between its turns */
  private showState(): void {
    if (!this.drawing()) return
    const turn = this.state.turn
    const activity = this.state.activity
    this.waitShown = this.waitsForLimit()
    this.working.hidden = turn === 'idle' && activity === undefined && !this.waitShown
    this.verb.textContent = activity?.kind === 'compacting' ? 'Compacting conversation'
      : activity?.kind === 'restarting' ? 'Restarting Claude Code'
        : this.waitShown ? `Claude goes on by itself at ${resetClock(this.limitWait!, Date.now())}`
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

  /**
   * A turn the usage limit stopped (`goesOnAt`, ms: when Claude goes on by itself after the reset), or no wait (null): while
   * the chat is idle, its working line says when Claude goes on and counts down to it
   */
  setLimitWait(goesOnAt: number | null): void {
    if (goesOnAt === this.limitWait) return
    this.limitWait = goesOnAt
    this.showState()
  }

  /** the chat is idle and waits for Claude to go on by itself after the usage limit */
  private waitsForLimit(): boolean {
    return this.limitWait !== null && this.limitWait > Date.now() && this.state.turn === 'idle' && this.state.activity === undefined
  }

  /** the elapsed time of the line: from the start of its activity, else of the turn; shown only while there is one that started */
  private tickElapsed(): void {
    if (this.waitShown) {
      this.elapsedSep.hidden = false
      this.elapsed.hidden = false
      this.elapsed.textContent = `in ${countdown(this.limitWait! - Date.now())}`
      return
    }
    const started = this.state.activity?.since ?? (this.state.turn === 'idle' ? null : this.state.turnStartedAt)
    const shown = started !== null
    this.elapsedSep.hidden = !shown
    this.elapsed.hidden = !shown
    if (shown) this.elapsed.textContent = elapsedText(Date.now() - started)
  }

  /** the elapsed time ticks once a second while the chat is shown and a turn runs, and so do the times of the agents running in the dock, which outlive their turn */
  private syncClock(): void {
    // the dock's times count while it shows, on an agent page too; the working line's only while the conversation is drawn
    const agents = this.visible && this.dockOpen && this.dockRows.some((agent) => agent.state === 'running')
    const run = agents || (this.drawing() && (this.state.turn !== 'idle' || this.state.activity !== undefined || this.waitShown))
    if (run && this.clock === null) {
      // a chat shown again catches up at once
      tickAgentTimes(this.dock)
      this.clock = setInterval(() => {
        if (this.drawing()) {
          // the moment Claude was to go on has come: the line goes, unless Claude Code's own news came first
          if (this.waitShown && !this.waitsForLimit()) this.showState()
          else this.tickElapsed()
        }
        tickAgentTimes(this.dock)
      }, 1000)
    }
    if (!run) this.stopClock()
  }

  private stopClock(): void {
    if (this.clock !== null) clearInterval(this.clock)
    this.clock = null
  }

  /** the first item drawn that is at least partly in view, and its top's offset from the top of the view */
  private topItem(): { id: string; offset: number } | null {
    return topItemOf(this.scroll, this.column)
  }

  /** the item the reader was on stays at the same offset from the top of the view */
  private keepAt(anchor: { id: string; offset: number }): void {
    const node = this.drawn.get(anchor.id)
    if (node === undefined) return
    keepAtNode(this.scroll, node, anchor)
  }

  /** the window is the items around one of them: a page above it, and the rest below */
  private windowAround(id: string): void {
    const w = windowAt(this.items.length, this.indexOf(id))
    this.from = w.from
    this.to = w.to
  }

  /** the folds of the items that are gone are forgotten */
  private pruneFolds(): void {
    const ids = new Set(this.items.map((item) => item.id))
    for (const id of [...this.folds.keys()]) if (!ids.has(id)) this.folds.delete(id)
  }

  private settle(): void {
    if (!this.drawing() || !this.stick) return
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

  /**
   * A scroll up the view has not heard of yet is taken before new items move the column: the scroll event comes with the next
   * frame, and a window that draws no frame (one behind another window) draws its queue from the timer before it, so a column
   * still stuck to its bottom would take the reader back to the end
   */
  private catchScroll(): void {
    if (this.drawing() && this.stick && this.scroll.scrollTop < this.settledTop) this.onScroll()
  }

  private onScroll(): void {
    if (!this.drawing()) return
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
