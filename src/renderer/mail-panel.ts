import type { MailConversationView, MailMessageView } from '../shared/mail'
import { deviceColor } from '../shared/remote'
import type { SidePanel } from './side-panel'

export interface MailPanelCallbacks {
  /** the conversations of a tab, or of every tab for null */
  conversations(tabId: string | null): Promise<MailConversationView[]>
  markRead(ids: string[]): Promise<void>
}

/** what the panel shows: the active tab's conversations, or every conversation this device knows */
type Scope = 'tab' | 'all'

const EMPTY = 'No messages yet. What agents write to each other shows here.'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/** a conversation's name for a tab: the tab's own name without its device, which is the part after the last " · " */
const labelOf = (name: string): string => {
  const at = name.lastIndexOf(' · ')
  return at >= 0 ? name.slice(0, at) : name
}

/** the header of a conversation: the other end's name and this tab's label, or both names when every conversation is shown */
export function headerOf(view: MailConversationView): string {
  if (view.mine === null) return `${view.a.name} ⇄ ${view.b.name}`
  const mine = view.mine === 'a' ? view.a : view.b
  const other = view.mine === 'a' ? view.b : view.a
  return `${other.name} ⇄ ${labelOf(mine.name)}`
}

/** a message's time: the clock time when it was sent today, else the date and the time; waiting while it is not delivered */
function timeOf(sentAt: number, delivered: boolean): string {
  const sent = new Date(sentAt)
  const today = sent.toDateString() === new Date().toDateString()
  const when = today
    ? sent.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : sent.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return delivered ? when : `${when} · waiting`
}

/**
 * The Agent messages panel: the conversations between Claude sessions, for this tab or for all of them. A message
 * counts as read once it is shown while the panel is shown and the window has the focus.
 */
export class MailPanel {
  private tabId: string | null = null
  private scope: Scope = 'tab'
  /** the latest load: an answer to an older one that comes later is dropped */
  private seq = 0
  private readonly thisTab: HTMLButtonElement
  private readonly all: HTMLButtonElement

  constructor(private readonly body: HTMLElement, tools: HTMLElement, private readonly panel: SidePanel, private readonly cb: MailPanelCallbacks) {
    this.thisTab = this.scopeButton('This tab', 'tab')
    this.all = this.scopeButton('All', 'all')
    tools.append(this.thisTab, this.all)
    this.paintScope()
    window.addEventListener('focus', () => this.refresh())
  }

  /** the tab in front: its conversations are the ones "This tab" shows */
  show(tabId: string | null): void {
    this.tabId = tabId
    this.refresh()
  }

  /** draws the conversations again while the panel shows them: after a change of the mail, a tab switch or the panel's opening */
  refresh(): void {
    if (!this.panel.isShowing('messages')) return
    void this.load()
  }

  private async load(): Promise<void> {
    const seq = ++this.seq
    if (this.scope === 'tab' && this.tabId === null) {
      this.draw([])
      return
    }
    const views = await this.cb.conversations(this.scope === 'all' ? null : this.tabId)
    if (seq === this.seq) this.draw(views)
  }

  private draw(views: MailConversationView[]): void {
    const unread: string[] = []
    if (views.length === 0) {
      this.body.replaceChildren(el('div', 'panel-empty', EMPTY))
    } else {
      this.body.replaceChildren(...views.map((view) => this.conversation(view, unread)))
    }
    // the messages drawn are read when the panel is in view and the window has the focus
    if (unread.length > 0 && this.panel.isShowing('messages') && document.hasFocus()) void this.cb.markRead(unread)
  }

  private conversation(view: MailConversationView, unread: string[]): HTMLElement {
    const box = el('section', 'mail-conversation')
    box.append(el('div', 'mail-head', headerOf(view)))
    for (const m of view.messages) {
      box.append(this.message(m))
      if (!m.read) unread.push(m.id)
    }
    return box
  }

  private message(m: MailMessageView): HTMLElement {
    const row = el('div', m.read ? 'mail-message' : 'mail-message unread')
    const who = el('span', 'mail-from', m.from.name)
    if (m.from.device !== null) who.style.color = deviceColor(m.from.device)
    const meta = el('div', 'mail-meta')
    meta.append(who, el('span', 'mail-device', m.from.deviceName), el('span', 'mail-time', timeOf(m.sentAt, m.delivered)))
    row.append(meta, el('div', 'mail-text', m.text))
    return row
  }

  private scopeButton(label: string, scope: Scope): HTMLButtonElement {
    const b = el('button', 'mail-scope', label)
    b.type = 'button'
    b.addEventListener('click', () => {
      this.scope = scope
      this.paintScope()
      this.refresh()
    })
    return b
  }

  private paintScope(): void {
    this.thisTab.classList.toggle('active', this.scope === 'tab')
    this.all.classList.toggle('active', this.scope === 'all')
  }
}
