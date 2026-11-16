import type { RemoteState } from '../shared/remote-control'

/** the segment's tooltip: the state in words, or the reason it cannot be used */
export function remoteTitle(s: RemoteState): string {
  switch (s.kind) {
    case 'off': return 'Remote Control is off: click to turn it on'
    case 'connecting': return s.note ?? 'Remote Control is connecting…'
    case 'on': return 'Remote Control is on: this session is on claude.ai and in the Claude app'
    case 'unavailable':
    case 'failed': return s.reason
  }
}

const WAITS_FOR_PROMPT = ' · waits for an empty prompt'

/** the popover's status line; the wait for an empty prompt follows whichever line shows while ClaudeTerm waits to type */
export function remoteLine(s: RemoteState): string {
  switch (s.kind) {
    case 'off': return 'Off · turn it on to reach this session from your phone'
    case 'connecting': return (s.note ?? 'Connecting…') + (s.waits ? WAITS_FOR_PROMPT : '')
    case 'on': return (s.leaving ? 'Choose Disconnect this session in the terminal' : 'Connected · continue this session in the Claude app or on claude.ai') + (s.waits ? WAITS_FOR_PROMPT : '')
    case 'unavailable':
    case 'failed': return s.reason
  }
}

/** the switch is on while Remote Control connects or is connected, and off once the person asked it off; disabled when the account cannot use it */
export function remoteSwitch(s: RemoteState): { checked: boolean; disabled: boolean } {
  return { checked: s.kind === 'connecting' || (s.kind === 'on' && !s.leaving), disabled: s.kind === 'unavailable' }
}

/** the note under the account's checkbox */
export function accountNote(name: string): string {
  return `New Claude tabs of ${name} start with Remote Control on`
}

const CHAT_NOTE = 'ClaudeTerm sends this chat to claude.ai while it is on: messages, tool results, file contents. Prompts and permission answers can come from there.'

/** what the popover shows of a tab: its state, whether it is a chat, and its account's name and flag */
export interface RemotePopoverView {
  tabId: string
  state: RemoteState
  chat: boolean
  accountName: string
  accountFlag: boolean
}

/** what the popover's controls do: they reach main through the window's bridge */
export interface RemotePopoverActions {
  set(tabId: string, on: boolean): void
  setAccount(tabId: string, on: boolean): void
  open(url: string): void
  copy(url: string): void
}

/** The box above the status bar that holds a Claude tab's Remote Control: its switch, its state, its link and its account's flag. */
export class RemotePopover {
  private readonly el = document.createElement('div')
  private readonly toggleSwitch = document.createElement('input')
  private readonly line = document.createElement('div')
  private readonly actionRow = document.createElement('div')
  private readonly chatNote = document.createElement('div')
  private readonly account = document.createElement('label')
  private readonly accountBox = document.createElement('input')
  private readonly accountNote = document.createElement('div')
  /** the view drawn now; null while the popover is closed */
  private view: RemotePopoverView | null = null

  constructor(private readonly actions: RemotePopoverActions, private readonly onClosed: () => void) {
    this.el.className = 'remote-popover'
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-label', 'Remote Control')
    this.el.hidden = true

    const head = document.createElement('div')
    head.className = 'remote-head'
    const heading = document.createElement('span')
    heading.className = 'remote-heading'
    heading.textContent = 'Remote Control'
    this.toggleSwitch.type = 'checkbox'
    this.toggleSwitch.className = 'switch'
    this.toggleSwitch.setAttribute('aria-label', 'Remote Control')
    this.toggleSwitch.addEventListener('change', () => {
      if (this.view) this.actions.set(this.view.tabId, this.toggleSwitch.checked)
    })
    head.append(heading, this.toggleSwitch)

    this.line.className = 'remote-line'

    const openButton = document.createElement('button')
    openButton.className = 'remote-open'
    openButton.textContent = 'Open on claude.ai'
    openButton.addEventListener('click', () => {
      if (this.view?.state.kind === 'on') this.actions.open(this.view.state.url)
    })
    const copyButton = document.createElement('button')
    copyButton.className = 'remote-copy'
    copyButton.textContent = 'Copy link'
    copyButton.addEventListener('click', () => {
      if (this.view?.state.kind === 'on') this.actions.copy(this.view.state.url)
    })
    this.actionRow.className = 'remote-actions'
    this.actionRow.append(openButton, copyButton)

    this.chatNote.className = 'remote-chat-note'
    this.chatNote.textContent = CHAT_NOTE

    this.accountBox.type = 'checkbox'
    this.accountBox.addEventListener('change', () => {
      if (this.view) this.actions.setAccount(this.view.tabId, this.accountBox.checked)
    })
    const accountText = document.createElement('span')
    accountText.textContent = 'Connect every new session of this account'
    this.account.className = 'remote-account'
    this.account.append(this.accountBox, accountText)
    this.accountNote.className = 'remote-account-note'

    this.el.append(head, this.line, this.actionRow, this.chatNote, this.account, this.accountNote)
    document.body.append(this.el)
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  toggle(anchor: HTMLElement, v: RemotePopoverView): void {
    if (this.isOpen) {
      this.close()
      return
    }
    this.render(v)
    this.el.hidden = false
    this.place(anchor)
    // capture phase: Esc must not reach the terminal, where it would interrupt Claude's turn
    document.addEventListener('keydown', this.onKey, true)
    document.addEventListener('mousedown', this.onMouseDown, true)
    this.toggleSwitch.focus()
  }

  /** redraws an open popover; null, or a view of another tab, closes it */
  update(v: RemotePopoverView | null): void {
    if (!this.isOpen) return
    if (!v || v.tabId !== this.view?.tabId) {
      this.close()
      return
    }
    this.render(v)
    this.place()
  }

  close(): void {
    if (!this.isOpen) return
    this.el.hidden = true
    this.view = null
    document.removeEventListener('keydown', this.onKey, true)
    document.removeEventListener('mousedown', this.onMouseDown, true)
    this.onClosed()
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    this.close()
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    const t = e.target as Element | null
    // a press on the segment is left to its click, which toggles
    if (this.el.contains(t) || t?.closest?.('.status-remote')) return
    this.close()
  }

  /** the controls are kept and only changed, so the switch under the pointer or the focus stays the same node */
  private render(v: RemotePopoverView): void {
    this.view = v
    const sw = remoteSwitch(v.state)
    this.toggleSwitch.checked = sw.checked
    this.toggleSwitch.disabled = sw.disabled
    this.line.textContent = remoteLine(v.state)
    this.actionRow.hidden = v.state.kind !== 'on'
    // the chat's note is in the popover only for a chat
    this.chatNote.remove()
    if (v.chat) this.actionRow.after(this.chatNote)
    const unavailable = v.state.kind === 'unavailable'
    this.accountBox.checked = v.accountFlag
    this.accountBox.disabled = unavailable
    this.account.classList.toggle('dim', unavailable)
    this.accountNote.textContent = accountNote(v.accountName)
  }

  /** bottom edge 4px above the status bar, left edge at the segment, kept inside the window */
  private place(anchor?: HTMLElement): void {
    // the status bar replaces its segments when the set of them changes, so the one the popover opened from may be gone
    const seg = anchor ?? document.querySelector<HTMLElement>('#statusbar .status-remote')
    if (!seg) {
      this.close()
      return
    }
    const a = seg.getBoundingClientRect()
    const r = this.el.getBoundingClientRect()
    const bar = seg.closest('#statusbar')?.getBoundingClientRect() ?? a
    this.el.style.left = `${Math.max(0, Math.min(a.left, window.innerWidth - r.width - 4))}px`
    this.el.style.bottom = `${Math.max(0, window.innerHeight - bar.top + 4)}px`
  }
}
