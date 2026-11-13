import { commandWord, type ChatAttachment, type ChatCommandInfo, type ChatModelInfo, type ChatPermissionMode, type ChatSend, type ChatState } from '../../shared/chat'
import type { McpSection } from '../../shared/mcp'
import type { ImageCard } from '../../shared/types'
import { icon } from '../icons'
import { imageUrl } from '../image-url'
import { FilePicker } from './file-picker'
import { findModel, ModelPicker } from './model-picker'
import { routeSlash, SlashMenu } from './slash-menu'
import { MAX_QUOTES, quoteMarkdown } from './chat-quote'

const IDLE_PLACEHOLDER = 'Message Claude…'
const QUEUE_PLACEHOLDER = 'Queue a follow-up…'
const WAITING_LINE = 'Claude is waiting for your answer'
/** the text area's smallest height: its padding and one line */
const MIN_INPUT_HEIGHT = 46
/** the text area grows with its text up to a third of the sheet's height, then scrolls */
const MAX_SHEET_SHARE = 3
/** a Shift+Tab press that no answer comes for (a refusal sends none) is over after this long: the next press starts from the mode shown */
const PENDING_MODE_MS = 2000

/** a mode's chip: its label and the colour of its dot */
const MODE_CHIPS: Record<ChatPermissionMode, { label: string; dot: string }> = {
  default: { label: 'Ask before edits', dot: 'var(--text-3)' },
  acceptEdits: { label: 'Accept edits', dot: 'var(--amber)' },
  plan: { label: 'Plan', dot: 'var(--blue)' },
  auto: { label: 'Auto', dot: 'var(--purple)' },
  bypassPermissions: { label: 'Bypass', dot: 'var(--red)' },
  dontAsk: { label: "Don't ask", dot: 'var(--text-3)' }
}

const NO_STATE: ChatState = { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false }
/** the most files one message carries: main refuses more */
const MAX_ATTACHMENTS = 20
const TOO_MANY = 'At most 20 files per message'
/** what a notice's line that is null (a dialog the chat cannot show) is called in the notices */
/** what a dialog's notice opens: the conversation, in the terminal, where the dialog is answered there (the note starts a sentence with it) */
const DIALOG = 'the conversation'

export interface ComposerOptions {
  platform: string
  /** the refusal, or null when the message was sent; a rejection is shown as its message */
  send(s: ChatSend): Promise<string | null>
  interrupt(): void
  attach(paths: string[]): Promise<ChatAttachment[]>
  pickFiles(): Promise<ChatAttachment[]>
  /** the path of the clipboard's image, saved; null when there is none */
  pasteImage(): Promise<string | null>
  setMode(mode: ChatPermissionMode): void
  modes(): Promise<ChatPermissionMode[]>
  models(): Promise<ChatModelInfo[]>
  /** the chat's commands: the slash menu lists them, and a text that is one of them is routed by it */
  commands(): Promise<ChatCommandInfo[]>
  /** the project's files whose path matches the query, for the @ picker */
  files(query: string): Promise<string[]>
  /** /model's Apply: the session takes the model and the effort (null: none) */
  setModel(model: string, effort: string | null): void
  /** /resume: the window of recent sessions, whose pick resumes the session in this chat; `refused` when the chat cannot take it */
  resume(refused: () => void): void
  /**
   * /mcp and /plugin: the MCP · Plugins panel opens on the section. null: nothing is sent and the draft is cleared; a string: the
   * text is sent to Claude Code as typed, and the composer's note shows the string (a member's tab: its host manages MCP)
   */
  openMcp(section: McpSection): string | null
  /** a command for the terminal: switched to it and typed there; false when the switch is refused. Null: the switch only */
  openInTerminal(line: string | null): Promise<boolean>
  /**
   * A switch of the view that would stop background tasks waits for the user's word in the sheet header: `go` runs on Switch,
   * `cancel` on Cancel or when the question is dropped; with no background tasks `go` runs at once
   */
  askSwitch(go: () => void, cancel: () => void): () => void
  /** this chat's earlier user messages, newest last */
  history(): string[]
  /** the names of the commands the chat answered "not available": they go to the terminal from now on */
  unavailable(): string[]
  imageCard(cardId: string): ImageCard | null
}

/** a command waiting for its turn to end, or for the answer to the question of a view switch: the text stays in the composer until it runs */
interface PendingRun {
  /** the draft's text; a notice's line has none of its own, and leaves the draft as it is */
  text: string
  /** a terminal command goes to the terminal with its line; /resume opens the sessions window */
  route: 'terminal' | 'resume'
  /** the line typed in the terminal; null for a switch only (a dialog the chat cannot show) */
  line: string | null
  /** the command's first word, as the notices name it: `/config`, `!npm` */
  what: string
  /** a notice's own line, run from its button: a refusal shows here, and a success keeps the draft */
  notice: boolean
  /** the switch is being made or asked about: a state that comes meanwhile does not make it again */
  busy: boolean
}

/**
 * The chat's composer: the field with the attachments above the text, and under it the attach, mention and slash buttons,
 * the mode and model chips and Send. Enter sends, Shift+Enter is a new line; while a turn runs, a message waits behind it.
 * A refusal from main shows under the field and keeps the draft. The draft stays here while the window lives.
 */
export class ChatComposer {
  readonly element: HTMLDivElement
  private readonly waiting: HTMLDivElement
  private readonly field: HTMLDivElement
  private readonly menu: HTMLDivElement
  private readonly attachButton: HTMLButtonElement
  private readonly chips: HTMLDivElement
  /** the quote bars above the field: one per quote the draft carries */
  private readonly quoteList: HTMLDivElement
  private readonly input: HTMLTextAreaElement
  private readonly modeChip: HTMLButtonElement
  private readonly modeDot: HTMLSpanElement
  private readonly modeLabel: HTMLSpanElement
  private readonly modelChip: HTMLButtonElement
  private readonly modelLabel: HTMLSpanElement
  private readonly modelEffort: HTMLSpanElement
  private readonly send: HTMLButtonElement
  /** while a turn runs and the field is empty, Stop holds Send's place: it interrupts the turn, as Esc does */
  private readonly stop: HTMLButtonElement
  private readonly refusal: HTMLDivElement
  private readonly note: HTMLDivElement
  private readonly slash: SlashMenu
  private readonly modelPicker: ModelPicker
  private readonly files: FilePicker
  /** the text area follows its sheet: when the composer is shown again, or the window changes size */
  private readonly sizes: ResizeObserver
  private sizing: number | null = null
  private state: ChatState = NO_STATE
  private attached: ChatAttachment[] = []
  private models: ChatModelInfo[] = []
  private commands: ChatCommandInfo[] = []
  private pendingRun: PendingRun | null = null
  /** the question of the switch the pending command asked: taken away with the command */
  private dismissAsk: (() => void) | null = null
  private modeList: ChatPermissionMode[] = []
  /** the mode a Shift+Tab asked for, until the chat reports it: a quick second press advances from it */
  private pendingMode: ChatPermissionMode | null = null
  /** the mode the first of the pending presses started from: a chat that has moved away from it has answered for the press */
  private pendingFrom: ChatPermissionMode = 'default'
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  /** the models and modes are asked for once the chat runs, and again after it stopped */
  private chatListsAsked = false
  /** attaches still in flight: a send waits for them, so the message goes with its files */
  private attaching = 0
  private sendAfterAttach = false
  /** bumped when the draft is cleared: an attach that lands after a clear is not put in the next draft */
  private draftGen = 0
  /** the modes list is asked for once at a time; Shift+Tab presses made before it came are applied when it does */
  private modesLoading = false
  private modePresses = 0
  /** a mode came that the list lacks while the list was being asked for: that answer may predate it, so it is asked for again */
  private modesStale = false
  /** while ↑ recalls earlier messages: the index of the one in the field; null while the draft is in it */
  private recall: number | null = null
  /** the draft a recall put aside, back in the field when ↓ passes the newest message */
  private draft = ''
  /** the quotes of the conversation the draft carries, in the order added: sent above the typed text as blockquotes */
  private quotes: string[] = []

  constructor(private readonly o: ComposerOptions) {
    this.element = make('div', 'chat-composer')
    this.waiting = make('div', 'chat-waiting', WAITING_LINE)
    this.waiting.hidden = true
    this.waiting.setAttribute('role', 'status')
    this.field = make('div', 'chat-field')
    this.menu = make('div', 'chat-menu')
    this.menu.hidden = true
    this.chips = make('div', 'chat-attached-list')
    this.chips.hidden = true
    this.quoteList = make('div', 'chat-quotes')
    this.quoteList.hidden = true
    this.input = make('textarea', 'chat-input')
    this.input.rows = 1
    this.input.placeholder = IDLE_PLACEHOLDER
    this.input.setAttribute('aria-label', 'Message to Claude')

    const row = make('div', 'chat-row')
    this.attachButton = iconButton('chat-tool', 'Attach a file or image', icon('paperclip', 15))
    const mention = make('button', 'chat-tool chat-at', '@')
    mention.type = 'button'
    mention.setAttribute('aria-label', 'Mention a file')
    const slash = make('button', 'chat-tool chat-slash', '/')
    slash.type = 'button'
    slash.setAttribute('aria-label', 'Slash commands')
    const spacer = make('span', 'chat-spacer')

    this.modeChip = make('button', 'chat-chip-btn chat-mode-chip')
    this.modeChip.type = 'button'
    this.modeChip.setAttribute('aria-label', 'Permission mode')
    this.modeDot = make('span', 'chat-dot')
    this.modeLabel = make('span')
    this.modeChip.append(this.modeDot, this.modeLabel, caret())

    this.modelChip = make('button', 'chat-chip-btn chat-model-chip')
    this.modelChip.type = 'button'
    this.modelChip.setAttribute('aria-label', 'Model')
    this.modelLabel = make('span')
    this.modelEffort = make('span', 'chat-effort')
    this.modelChip.append(this.modelLabel, this.modelEffort, caret())

    this.send = iconButton('chat-send', 'Send', icon('arrow-up', 16))
    this.stop = make('button', 'chat-stop')
    this.stop.type = 'button'
    this.stop.setAttribute('aria-label', 'Stop Claude')
    this.stop.title = 'Stop (Esc)'
    this.stop.hidden = true
    const core = make('span', 'chat-stop-core')
    core.append(make('span', 'chat-stop-square'))
    this.stop.append(make('span', 'chat-stop-arc'), core)
    row.append(this.attachButton, mention, slash, spacer, this.modeChip, this.modelChip, this.send, this.stop)

    const files = make('button', 'chat-menu-item', 'Files on this computer…')
    files.type = 'button'
    const paste = make('button', 'chat-menu-item', 'Paste an image')
    paste.type = 'button'
    paste.append(make('span', 'chat-kbd', o.platform === 'darwin' ? '⌘V' : 'Ctrl V'))
    this.menu.append(files, paste)

    this.refusal = make('div', 'chat-refusal')
    this.refusal.hidden = true
    this.refusal.setAttribute('role', 'alert')
    // a command that waits for the turn to end
    this.note = make('div', 'chat-note')
    this.note.hidden = true
    this.note.setAttribute('role', 'status')

    this.field.append(this.menu, this.chips, this.quoteList, this.input, row)
    this.element.append(this.waiting, this.field, this.note, this.refusal)

    // the menu and the routing of a submit share one list: the composer's, fetched when the menu opens
    this.slash = new SlashMenu(this.field, {
      commands: () => this.fetchCommands(),
      terminal: (name) => routeSlash(`/${name}`, this.commands, this.o.unavailable()).to === 'terminal',
      native: (name) => {
        const route = routeSlash(`/${name}`, this.commands, this.o.unavailable())
        return route.to === 'native' && (route.name === 'mcp' || route.name === 'plugin')
      },
      complete: (text) => this.setDraft(text),
      run: (name) => {
        this.setDraft(`/${name}`)
        this.submit()
      }
    })
    this.modelPicker = new ModelPicker({
      models: () => o.models(),
      current: () => ({ model: this.state.model, effort: this.state.effort }),
      apply: (model, effort) => o.setModel(model, effort),
      refocus: () => this.input.focus()
    })
    this.files = new FilePicker({
      files: (query) => o.files(query),
      pick: (path) => this.insertMention(path)
    })

    this.input.addEventListener('keydown', (e) => this.onKey(e))
    this.input.addEventListener('input', (e) => {
      this.recall = null
      // typing changes the draft: a command waiting for its turn is no longer the text in the field. A notice's line has no text of
      // its own in the field: it waits on, and only its Esc or its run ends it
      if (this.pendingRun?.notice !== true) {
        this.dropRun()
        this.hideNote()
      }
      this.showRefusal('')
      this.openFromTyping(e)
      this.syncPickers()
      this.autosize()
      this.refreshSend()
    })
    // an open model picker: Esc on its chip closes it, as Esc on its buttons does
    this.modelChip.addEventListener('keydown', (e) => {
      if (this.modelPicker.key(e)) e.preventDefault()
    })
    this.input.addEventListener('paste', (e) => this.onPaste(e))
    this.attachButton.addEventListener('click', () => { this.menu.hidden = !this.menu.hidden })
    // Esc closes the open menu, with the focus back on its button; the menu closes too when the focus leaves the field
    this.field.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.menu.hidden) return
      e.preventDefault()
      this.closeMenu()
      this.attachButton.focus()
    })
    this.field.addEventListener('focusout', (e) => {
      if (this.field.contains(e.relatedTarget as Node | null)) return
      // a redraw of the model picker takes its focused button away: the picker stays open, and the focus goes back to it
      if (this.modelPicker.redrawing) return
      this.closePickers()
    })
    files.addEventListener('click', () => { this.closeMenu(); this.pickFiles() })
    paste.addEventListener('click', () => { this.closeMenu(); this.pasteImage() })
    mention.addEventListener('click', () => this.mentionButton())
    slash.addEventListener('click', () => this.openSlashButton())
    this.modeChip.addEventListener('click', () => this.cycleMode())
    this.modelChip.addEventListener('click', () => (this.modelPicker.isOpen ? this.modelPicker.close() : this.modelPicker.open(this.modelChip)))
    this.send.addEventListener('click', () => { this.submit(); this.input.focus() })
    // Stop interrupts as Esc does, and gives the focus back to the field: the button hides when the turn ends
    this.stop.addEventListener('click', () => { this.o.interrupt(); this.input.focus() })

    // the text area's height is taken again when the composer is shown, and when the window changes size: a frame later,
    // so the change this makes does not trigger the observer again within the same frame
    this.sizes = new ResizeObserver(() => {
      if (this.sizing !== null) cancelAnimationFrame(this.sizing)
      this.sizing = requestAnimationFrame(() => {
        this.sizing = null
        this.autosize()
      })
    })
    this.sizes.observe(this.element)
    this.sizes.observe(document.documentElement)

    this.renderMode()
    this.renderModel()
    this.renderChips()
    this.autosize()
  }

  /** the composer's chat is closed: its size observer and its pending frame go with it */
  dispose(): void {
    this.sizes.disconnect()
    if (this.sizing !== null) cancelAnimationFrame(this.sizing)
    this.sizing = null
    this.clearPending()
    this.closePickers()
  }

  /** the attach menu and the pickers close: the chat is hidden or gone */
  closePickers(): void {
    this.closeMenu()
    this.slash.close()
    this.files.close()
    this.modelPicker.close()
  }

  /**
   * The chat's state as main has it: the placeholder, the chips, and the waiting line while Claude waits for an answer.
   * The models, commands and modes are asked for when the chat runs (and again after a stop); a list that came back empty is
   * asked for again on the next state, and a model not in the list is asked for again when it changes.
   */
  setState(s: ChatState): void {
    const was = this.state
    this.state = s
    // a pending Shift+Tab press is answered when the chat reports its mode, and is over once the chat has moved away from the mode it started from
    if (this.pendingMode !== null && (this.pendingMode === s.mode || s.mode !== this.pendingFrom)) this.clearPending()
    this.input.placeholder = s.turn === 'idle' ? IDLE_PLACEHOLDER : QUEUE_PLACEHOLDER
    this.renderMode()
    this.renderModel()
    this.refreshSend()
    this.pulse(s.turn === 'waiting')
    if (s.exited) this.chatListsAsked = false
    else if (!this.chatListsAsked) this.loadChatLists()
    else {
      if (this.models.length === 0) this.loadModels()
      else if (s.model !== null && s.model !== was.model && findModel(this.models, s.model) === undefined) this.loadModels()
      // the commands are asked for while there are none, and again when a turn ends: the terminal's come with the session's init,
      // which a first turn brings. One ask per state, whatever the models did
      if (this.commands.length === 0 || (was.turn !== 'idle' && s.turn === 'idle')) this.loadCommands()
      // Auto depends on what Claude Code reports and on the model the chat runs, and both come after the modes were first asked for:
      // the list is asked for again when the model changes, when a mode is not in it, and on each state while it lacks Auto (the
      // state that comes with the chat's start is the first one after the models are known)
      if (s.model !== was.model || !this.modeList.includes('auto') || (s.mode !== was.mode && !this.modeList.includes(s.mode))) this.loadModes()
    }
    // a terminal command waiting for the turn runs once the turn is over
    if (s.turn === 'idle') this.runPending()
  }

  focus(): void {
    this.input.focus()
  }

  /** whether the composer holds a draft, focused or not: text or attachments */
  hasDraft(): boolean {
    return this.input.value !== '' || this.attached.length > 0 || this.quotes.length > 0
  }

  /** inserts text at the caret, as the pickers do */
  insert(text: string): void {
    this.input.setRangeText(text, this.input.selectionStart, this.input.selectionEnd, 'end')
    this.recall = null
    this.autosize()
    this.refreshSend()
    this.focus()
  }

  /** a quote from the chat's Quote button: a bar above the field, and the caret goes to the end of the text */
  addQuote(text: string): void {
    if (this.quotes.length >= MAX_QUOTES) return
    this.quotes = [...this.quotes, text]
    this.renderQuotes()
    this.input.focus()
    this.input.setSelectionRange(this.input.value.length, this.input.value.length)
  }

  /** whether the chat's Quote button may quote one more: a message carries at most MAX_QUOTES */
  canQuote(): boolean {
    return this.quotes.length < MAX_QUOTES
  }

  /** the quote bars are drawn from the quotes, each in its order, with its ✕ */
  private renderQuotes(): void {
    this.quoteList.replaceChildren(...this.quotes.map((quote, index) => this.quoteBar(quote, index)))
    this.quoteList.hidden = this.quotes.length === 0
    this.autosize()
  }

  private quoteBar(text: string, index: number): HTMLDivElement {
    const bar = make('div', 'chat-quote')
    bar.title = text
    bar.append(make('span', 'chat-quote-text', text))
    const remove = iconButton('chat-quote-remove', 'Remove quote', icon('x', 12))
    remove.addEventListener('click', () => {
      this.quotes = this.quotes.filter((_, i) => i !== index)
      this.renderQuotes()
      this.input.focus()
    })
    bar.append(remove)
    return bar
  }

  addAttachments(list: ChatAttachment[]): void {
    // a file is one chip: the same path, dropped or attached twice, is not added again; a list that would pass the most adds none
    const next = uniqueByPath([...this.attached, ...list])
    if (next.length > MAX_ATTACHMENTS) {
      this.showRefusal(TOO_MANY)
      return
    }
    this.attached = next
    this.renderChips()
  }

  /** files the window was handed by their paths: attached as chips; a refusal is shown under the field */
  attachPaths(paths: string[]): void {
    if (paths.length === 0) return
    // a drop that would pass the most files is refused whole, before anything is attached
    const fresh = uniqueByPath(paths.map((path) => ({ path }))).filter((p) => !this.attached.some((a) => a.path === p.path))
    if (this.attached.length + fresh.length > MAX_ATTACHMENTS) {
      this.showRefusal(TOO_MANY)
      return
    }
    this.attachFrom(this.o.attach(paths))
  }

  /** an image's Media card came: a chip whose thumbnail was a file icon is drawn again */
  imagesChanged(): void {
    if (this.attached.length > 0) this.renderChips()
  }

  /** the line that says Claude waits for an answer, and the field's pulse while it does */
  pulse(on: boolean): void {
    this.waiting.hidden = !on
    this.field.classList.toggle('chat-field-pulse', on)
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing) return
    // an open picker takes its keys first: Esc closes it, not the draft; Enter picks or runs, not sends
    if (this.slash.key(e) || this.files.key(e) || this.modelPicker.key(e)) {
      e.preventDefault()
      return
    }
    // an open attach menu takes its Esc in the field's listener, which closes it: the draft and a running turn stay
    if (e.key === 'Escape' && !this.menu.hidden) return
    if (e.key === 'Escape') {
      // a held key repeats its keydown: only a fresh press acts, so one hold sends one interrupt and clears nothing
      if (e.repeat) {
        e.preventDefault()
        return
      }
      // a command waiting for its turn is dropped first, and its text stays in the field; the next Esc stops a running turn
      if (this.pendingRun !== null) {
        e.preventDefault()
        this.dropRun()
        this.hideNote()
        return
      }
      if (this.state.turn === 'working') {
        e.preventDefault()
        this.o.interrupt()
      } else if (this.hasDraft()) {
        // with nothing running, or a card waiting for an answer, Esc clears the draft
        e.preventDefault()
        this.reset()
      }
      return
    }
    if (e.key === 'Enter') {
      if (e.shiftKey) return
      e.preventDefault()
      this.submit()
      return
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      this.cycleMode()
      return
    }
    // ↑ and ↓ leave the text to the caret unless it is on the first or last line of the field
    const start = this.input.selectionStart
    const end = this.input.selectionEnd
    const onFirstLine = !this.input.value.slice(0, start).includes('\n')
    const onLastLine = !this.input.value.slice(end).includes('\n')
    if (e.key === 'ArrowUp' && onFirstLine && (this.recall !== null || this.input.value === '')) {
      e.preventDefault()
      this.recallStep(-1)
      return
    }
    if (e.key === 'ArrowDown' && onLastLine && this.recall !== null) {
      e.preventDefault()
      this.recallStep(1)
    }
  }

  /**
   * The menu and the picker open on the text typed, not on the key: a / as the first character opens the slash menu, and an @
   * that starts a word opens the file picker. Every keyboard layout types them so; a Ctrl, Alt or Meta chord types nothing.
   */
  private openFromTyping(e: Event): void {
    if (!(e instanceof InputEvent) || e.inputType !== 'insertText') return
    if (e.data === '/' && this.input.value === '/' && this.input.selectionStart === 1) this.slash.update('')
    else if (e.data === '@' && this.mentionStart() !== null) this.files.open(this.field, '')
  }

  /** the @ button: an @ is typed at the caret, after a space when the word before it is one, and the file picker opens */
  private mentionButton(): void {
    const before = this.input.value.slice(0, this.input.selectionStart)
    this.insert(before === '' || /\s$/.test(before) ? '@' : ' @')
    this.files.open(this.field, '')
  }

  /** the slash button: the menu over the draft; a draft that is not a command gets its slash in front */
  private openSlashButton(): void {
    const value = this.input.value
    if (value === '') this.slash.update('')
    else if (value.startsWith('/')) this.slash.update(value.slice(1))
    else {
      this.setDraft(`/${value}`)
      this.slash.update(value)
    }
    this.input.focus()
  }

  /** the pickers follow the draft as it is typed: the slash menu while the text is one command name, the file picker while the caret is in an @ word */
  private syncPickers(): void {
    const value = this.input.value
    if (this.slash.isOpen) {
      if (value.startsWith('/') && !/\s/.test(value)) this.slash.update(value.slice(1))
      else this.slash.close()
    }
    if (this.files.isOpen) {
      const at = this.mentionStart()
      if (at === null) this.files.close()
      else this.files.update(this.input.value.slice(at + 1, this.input.selectionStart))
    }
  }

  /** the index of the @ that starts the word the caret is in: an @ at the start or after a space, with no space between it and the caret; null otherwise */
  private mentionStart(): number | null {
    const before = this.input.value.slice(0, this.input.selectionStart)
    const at = before.lastIndexOf('@')
    if (at < 0) return null
    if (at > 0 && !/\s/.test(before[at - 1]!)) return null
    if (/\s/.test(before.slice(at))) return null
    return at
  }

  /** a file the picker picked: the @ word the caret is in becomes its mention, with a space after it */
  private insertMention(path: string): void {
    const mention = path.includes(' ') ? `@"${path}" ` : `@${path} `
    const at = this.mentionStart()
    const start = at ?? this.input.selectionStart
    this.input.setRangeText(mention, start, this.input.selectionStart, 'end')
    this.recall = null
    this.autosize()
    this.refreshSend()
    this.focus()
  }

  /** the draft replaced by a command or a completion: the caret goes to its end */
  private setDraft(text: string): void {
    this.input.value = text
    this.input.setSelectionRange(text.length, text.length)
    this.recall = null
    this.autosize()
    this.refreshSend()
    this.focus()
  }

  /** ↑ and ↓ walk the earlier messages, newest first; ↓ past the newest brings the draft back. Empty texts are not messages. */
  private recallStep(d: -1 | 1): void {
    const list = this.o.history().filter((text) => text !== '')
    if (this.recall === null) {
      if (d === 1 || list.length === 0) return
      this.draft = this.input.value
      this.recall = list.length
    }
    const next = this.recall + d
    if (next < 0) return
    if (next >= list.length) {
      this.recall = null
      this.input.value = this.draft
    } else {
      this.recall = next
      this.input.value = list[next]
    }
    this.autosize()
    this.refreshSend()
  }

  private onPaste(e: ClipboardEvent): void {
    const data = e.clipboardData
    // text is pasted as it is; an image with no text is attached
    if (data === null || data.getData('text/plain') !== '') return
    if (!Array.from(data.items).some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return
    e.preventDefault()
    this.pasteImage()
  }

  private pickFiles(): void {
    this.attachFrom(this.o.pickFiles())
  }

  private pasteImage(): void {
    void this.o.pasteImage().then(
      (path) => { if (path !== null) this.attachPaths([path]) },
      (e: unknown) => this.showRefusal(`Could not paste: ${errorText(e)}`)
    )
  }

  /**
   * An attach under way: a send waits for it, and the chips it brings come in when it lands. A refused attach cancels the
   * waiting send, and the draft stays with the refusal; a clear of the draft since the attach began drops what it brings.
   */
  private attachFrom(attach: Promise<ChatAttachment[]>): void {
    this.attaching++
    const draft = this.draftGen
    void attach.then(
      (list) => {
        if (draft === this.draftGen) this.addAttachments(list)
        this.attachDone()
      },
      (e: unknown) => {
        this.sendAfterAttach = false
        // a refusal of an attach that began before a clear belongs to the cleared draft: it is not shown under the empty field
        if (draft === this.draftGen) this.showRefusal(`Could not attach: ${errorText(e)}`)
        this.attachDone()
      }
    )
  }

  private attachDone(): void {
    this.attaching--
    if (this.attaching === 0 && this.sendAfterAttach) {
      this.sendAfterAttach = false
      this.submit()
    }
  }

  /** the next permission mode after the one a Shift+Tab asked for, or the one the chat has; the list is the chat's own */
  private cycleMode(): void {
    if (this.modeList.length === 0) {
      this.modePresses++
      this.loadModes()
      return
    }
    // a press starts from the mode the chat shows, unless an earlier press is still waiting for its answer
    if (this.pendingMode === null) this.pendingFrom = this.state.mode
    const base = this.pendingMode ?? this.state.mode
    const next = this.modeList[(this.modeList.indexOf(base) + 1) % this.modeList.length]
    this.pendingMode = next
    this.armPending()
    this.o.setMode(next)
  }

  /** the pending press lasts while its answer may come: each press starts the time again */
  private armPending(): void {
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer)
    // a press no answer came for is over, and a refused mode (no answer comes for it either) drops out of the list: the list is asked for again
    this.pendingTimer = setTimeout(() => {
      this.clearPending()
      this.loadModes()
    }, PENDING_MODE_MS)
  }

  private clearPending(): void {
    this.pendingMode = null
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer)
    this.pendingTimer = null
  }

  /** the message goes: the field is cleared at once, and a refusal or a failure brings the draft back */
  private submit(): void {
    // a command on its way to the terminal: the Enter that comes meanwhile does nothing, the hand-over is already asked for
    if (this.pendingRun?.busy) return
    // a file still being attached goes with the message: the send waits for it
    if (this.attaching > 0) {
      this.sendAfterAttach = true
      return
    }
    const text = this.input.value.trim()
    if (text === '' && this.attached.length === 0) return
    // the note a /mcp or /plugin leaves when its text is sent on (a member's tab): shown once the draft is cleared
    let sentNote: string | null = null
    // a command the app answers, or the terminal runs; with files attached the text is a message, a command included: the
    // files go with it, and a command the app would answer is then sent to Claude Code as the text it is
    // a message with quotes is text, not a command: the quotes come first in it
    if (this.attached.length === 0 && this.quotes.length === 0 && (text.startsWith('/') || text.startsWith('!'))) {
      // a notice's line waits for the turn: a second command would take its place, so it waits for that line's Esc first
      if (this.pendingRun?.notice === true) {
        this.showRefusal('A command waits for Claude to finish: Esc drops it first')
        return
      }
      const route = routeSlash(text, this.commands, this.o.unavailable())
      if (route.to === 'native' && route.name === 'model') {
        this.reset()
        this.modelPicker.open(this.modelChip)
        return
      }
      // /mcp and /plugin open the panel at once, a turn may run: nothing is sent when the app answers with null
      if (route.to === 'native' && (route.name === 'mcp' || route.name === 'plugin')) {
        const line = this.o.openMcp(route.name === 'mcp' ? 'servers' : 'plugins')
        if (line === null) {
          this.reset()
          return
        }
        sentNote = line
      } else if (route.to === 'native') {
        // /resume takes the sessions window: it opens once the turn is over, as the terminal commands run then
        this.pendingRun = { text, route: 'resume', line: text, what: '/resume', notice: false, busy: false }
        this.runPending()
        return
      }
      if (route.to === 'terminal') {
        this.pendingRun = { text, route: 'terminal', line: route.line, what: commandWord(text), notice: false, busy: false }
        this.runPending()
        return
      }
    }
    const quotes = this.quotes
    const sent: ChatSend = { text: quoteMarkdown(quotes, text), attachments: this.attached }
    this.reset()
    if (sentNote !== null) this.showNote(sentNote)
    void this.o.send(sent).then(
      (refusal) => { if (refusal !== null) this.giveBack(sent, text, quotes, refusal) },
      (e: unknown) => this.giveBack(sent, text, quotes, `Could not send: ${errorText(e)}`)
    )
  }

  /** the draft comes back unless the person has typed something new meanwhile: then the refused text goes in front of it */
  private giveBack(sent: ChatSend, typed: string, quotes: string[], reason: string): void {
    if (this.input.value === '') this.input.value = typed
    else if (typed !== '') this.input.value = `${typed}\n${this.input.value}`
    // the quotes go back in front of any added meanwhile, as many as a message carries
    this.quotes = [...quotes, ...this.quotes].slice(0, MAX_QUOTES)
    this.renderQuotes()
    // a file attached again meanwhile is one chip, as addAttachments keeps it
    this.attached = uniqueByPath([...sent.attachments, ...this.attached])
    this.renderChips()
    this.showRefusal(reason)
    this.autosize()
  }

  private reset(): void {
    // a menu over a cleared field would wait for a text that is gone: the pickers close with the draft
    this.slash.close()
    this.files.close()
    this.input.value = ''
    this.attached = []
    this.quotes = []
    this.renderQuotes()
    this.recall = null
    this.draftGen++
    this.sendAfterAttach = false
    // a notice's waiting line outlives the draft it was sent from: a send does not end it
    if (this.pendingRun?.notice !== true) {
      this.dropRun()
      this.hideNote()
    }
    this.showRefusal('')
    this.renderChips()
    this.autosize()
  }

  private showRefusal(text: string): void {
    this.refusal.textContent = text
    this.refusal.hidden = text === ''
  }

  private showNote(text: string): void {
    this.note.textContent = text
    this.note.hidden = false
  }

  private hideNote(): void {
    this.note.hidden = true
  }

  /**
   * A command runs once the turn is over: while Claude works the text stays and a notice says when it runs. A terminal command
   * then asks the sheet header first when background tasks would stop (the header's Switch runs it, its Cancel keeps the text),
   * switches to the terminal and types the line. /resume opens the sessions window at once: a session picked there asks in the
   * sheet header first when it would stop background tasks.
   */
  private runPending(): void {
    const p = this.pendingRun
    if (p === null || p.busy) return
    if (this.state.turn !== 'idle') {
      if (p.route === 'resume') this.showNote(`${p.what} opens once Claude finishes`)
      else this.showNote(`${p.line === null ? 'The conversation' : p.what} opens in the terminal once Claude finishes`)
      return
    }
    this.hideNote()
    p.busy = true
    if (p.route === 'resume') {
      this.dropRun()
      this.reset()
      this.o.resume(() => this.showRefusal('The session could not be resumed here: this chat runs on another device, or is not a local chat'))
      return
    }
    const cancel = (): void => {
      // the question was answered with Cancel, or dropped: the text stays, and nothing runs until the next Enter
      if (this.pendingRun !== p) return
      this.dropRun()
      this.hideNote()
    }
    // a refused switch keeps the text in the field, and does not ask again by itself: the next Enter does
    const failed = (): void => {
      if (this.pendingRun !== p) return
      this.dropRun()
      this.showRefusal(`Could not open ${p.line === null ? DIALOG : p.what} in the terminal`)
    }
    const go = (): void => {
      // the text may have changed while the question was up: then the command is no longer the one asked about
      if (this.pendingRun !== p) return
      void this.o.openInTerminal(p.line).then((ok) => {
        if (!ok) return failed()
        // the switch was made: a command's text is gone from the composer; a notice's line leaves the draft as it is
        if (this.pendingRun !== p) return
        if (p.notice) {
          this.dropRun()
          this.hideNote()
        } else this.reset()
      }, failed)
    }
    this.dismissAsk = this.o.askSwitch(go, cancel)
  }

  /**
   * A notice's Open in the terminal: its line runs the way a terminal command of the composer does, so it waits for the turn's
   * end and asks the sheet header first when background tasks would stop. A null line only switches the view.
   */
  openNoticeLine(line: string | null): void {
    this.dropRun()
    this.pendingRun = { text: '', route: 'terminal', line, what: line === null ? DIALOG : commandWord(line), notice: true, busy: false }
    this.runPending()
  }

  /** the pending command is dropped, with the question about its switch: nothing is run, and the question goes */
  private dropRun(): void {
    this.pendingRun = null
    const dismiss = this.dismissAsk
    this.dismissAsk = null
    dismiss?.()
  }

  private closeMenu(): void {
    this.menu.hidden = true
  }

  /** the models, the commands and the modes the chat offers: asked for when the chat runs */
  private loadChatLists(): void {
    this.chatListsAsked = true
    this.loadModels()
    this.loadCommands()
    this.loadModes()
  }

  /** an empty answer is no list: the list the chat has stays, and the next state asks again while there is none */
  private loadModels(): void {
    void this.o.models().then((list) => {
      if (list.length === 0) return
      this.models = list
      this.renderModel()
    }, () => undefined)
  }

  private loadCommands(): void {
    void this.fetchCommands()
  }

  /** the chat's commands as asked for: an empty or failed answer keeps the list the composer has */
  private fetchCommands(): Promise<ChatCommandInfo[]> {
    return this.o.commands().then(
      (list) => {
        if (list.length > 0) this.commands = list
        return this.commands
      },
      () => this.commands
    )
  }

  /** the modes the chat offers; the Shift+Tab presses that came before the list are applied once it is in */
  private loadModes(): void {
    if (this.modesLoading) {
      this.modesStale = true
      return
    }
    this.modesLoading = true
    void this.o.modes().then((list) => {
      this.modeList = list
      const presses = this.modePresses
      this.modePresses = 0
      for (let i = 0; i < presses; i++) this.cycleMode()
    }, () => {
      // a list that does not come takes its presses with it: they are not applied by a later load
      this.modePresses = 0
    }).finally(() => {
      this.modesLoading = false
      if (!this.modesStale) return
      this.modesStale = false
      this.loadModes()
    })
  }

  private renderMode(): void {
    const chip = MODE_CHIPS[this.state.mode]
    this.modeDot.style.background = chip.dot
    this.modeLabel.textContent = chip.label
  }

  /**
   * The model's display name when the list has it (the entry the chat's model is, see findModel), else its id; `Model` until the
   * first turn names one. The chat's effort follows it, dimmed, when the chat has one.
   */
  private renderModel(): void {
    const id = this.state.model
    const known = findModel(this.models, id)
    this.modelLabel.textContent = id === null ? 'Model' : (known?.displayName ?? id)
    const effort = this.state.effort
    this.modelEffort.textContent = effort === null ? '' : `· ${effort}`
    this.modelEffort.hidden = effort === null
  }

  private renderChips(): void {
    this.chips.replaceChildren(...this.attached.map((a) => this.chipOf(a)))
    this.chips.hidden = this.attached.length === 0
    this.refreshSend()
  }

  /** an attachment as a chip: its thumbnail when its Media card is known, else a file icon; its name, its size and a remove button */
  private chipOf(a: ChatAttachment): HTMLElement {
    const box = make('div', 'chat-attached')
    // a picture too big to scale goes to Claude as its path: the chip says so
    if (a.oversize === true) box.title = 'Too large to scale here: Claude reads it from its path'
    const card = a.kind === 'image' && a.cardId !== null ? this.o.imageCard(a.cardId) : null
    if (card !== null) {
      const thumb = make('img', 'chat-attached-thumb')
      thumb.src = imageUrl(card)
      thumb.alt = ''
      box.append(thumb)
    } else {
      const glyph = make('span', 'chat-attached-glyph')
      glyph.innerHTML = icon(a.kind === 'image' ? 'image' : 'file-text', 14)
      box.append(glyph)
    }
    const remove = iconButton('chat-attached-remove', `Remove ${a.name}`, icon('x', 12))
    remove.addEventListener('click', () => {
      this.attached = this.attached.filter((x) => x !== a)
      this.renderChips()
    })
    box.append(make('span', 'chat-attached-name', a.name), make('span', 'chat-attached-size', sizeText(a.size)), remove)
    return box
  }

  /** Send is enabled with text or an attachment to send; while a turn runs and there is nothing to send, the Stop button holds Send's place */
  private refreshSend(): void {
    const empty = this.input.value.trim() === ''
    const nothing = empty && this.attached.length === 0
    this.send.disabled = nothing
    const stop = this.state.turn === 'working' && nothing
    this.stop.hidden = !stop
    this.send.hidden = stop
  }

  /** the text area grows with its text up to a third of the sheet's height, then scrolls */
  private autosize(): void {
    // the composer keeps its outer height while the text area is measured: an 'auto' text area would shorten the chat above
    // it for an instant, and the browser would clamp the column's scroll to that shorter height
    this.element.style.height = `${this.element.offsetHeight}px`
    this.input.style.height = 'auto'
    const sheet = this.element.parentElement?.clientHeight ?? 0
    const max = Math.max(MIN_INPUT_HEIGHT, Math.floor(sheet / MAX_SHEET_SHARE))
    const wanted = Math.max(MIN_INPUT_HEIGHT, this.input.scrollHeight)
    this.input.style.height = `${Math.min(wanted, max)}px`
    this.input.style.overflowY = wanted > max ? 'auto' : 'hidden'
    this.element.style.height = ''
  }
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconButton(className: string, label: string, svg: string): HTMLButtonElement {
  const button = make('button', className)
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.innerHTML = svg
  return button
}

/** the small arrow that says a chip opens a menu */
function caret(): HTMLSpanElement {
  const span = make('span', 'chat-caret')
  span.innerHTML = icon('chevron-down', 12)
  return span
}

/** a file's size as the chips show it: `512 B`, `12 KB`, `1.2 MB` */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** the list with one entry per path: the first of each path is kept, in its place */
function uniqueByPath<T extends { path: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((a) => {
    if (seen.has(a.path)) return false
    seen.add(a.path)
    return true
  })
}
