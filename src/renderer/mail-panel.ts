import type { MailConversationView, MailEndView, MailMessageView } from '../shared/mail'
import { deviceColor } from '../shared/remote'
import { outcomeText } from '../shared/report-wake'
import { chatMarkdownHtml, markdownClick, openableLink } from './chat/chat-markdown'
import { icon } from './icons'
import { initialOf, RELAY_NOTE, speakerName, withoutRelayNote } from './mail-text'
import type { SidePanel } from './side-panel'

export interface MailPanelCallbacks {
  /** the conversations of a tab, or of every tab for null */
  conversations(tabId: string | null): Promise<MailConversationView[]>
  markRead(ids: string[]): Promise<void>
  /** a web link in a message's text was clicked: it opens in the browser */
  openLink(url: string): void
  /** the Copy of a code block in a message's text */
  copyText(text: string): void
}

/** what the panel shows: the active tab's conversations, or every conversation this device knows */
type Scope = 'tab' | 'all'

const EMPTY = 'No messages yet. What agents write to each other shows here.'
/** a message's text is cut to this many lines, with Show more, when it is longer than these and two more */
const CLAMP_LINES = 10

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

// the formats of the times, made once: a few hundred messages are drawn at once
const CLOCK = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' })
const DAY_CLOCK = new Intl.DateTimeFormat([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const FULL = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'medium' })

/** a message's time: the clock time when it was sent today, else the date and the time */
function timeOf(sentAt: number): string {
  const sent = new Date(sentAt)
  return sent.toDateString() === new Date().toDateString() ? CLOCK.format(sent) : DAY_CLOCK.format(sent)
}

/** the colour of an end's device, as its tabs show it; this device, which has none, is drawn in a quiet grey */
const colorOf = (end: MailEndView): string => (end.device === null ? 'var(--text-3)' : deviceColor(end.device))

/** what a message is, when it is not a plain message: "Task", "Progress", or "Report · <outcomeText>" */
export function kindLabel(m: Pick<MailMessageView, 'kind' | 'outcome' | 'reason'>): string | null {
  if (m.kind === 'task') return 'Task'
  if (m.kind === 'progress') return 'Progress'
  if (m.kind !== 'report') return null
  return m.outcome === null ? 'Report' : `Report · ${outcomeText(m.outcome, m.reason)}`
}

// the elements and attributes of the chat's Markdown that a message's text may hold: markdown-it shows raw HTML as text, so
// nothing else comes out of it; the check holds even if that ever changed
const TAGS = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DIV', 'SPAN', 'BUTTON'])
const ATTRS = new Set(['class', 'href', 'data-path', 'start', 'type'])

/**
 * keeps only the allowed elements (any other one becomes its text) and attributes, and only openable links. A link names its
 * address on hover: its text may say another one, and any process can write a message
 */
function clean(parent: Element): void {
  for (const child of [...parent.children]) {
    if (!TAGS.has(child.tagName)) {
      child.replaceWith(child.textContent ?? '')
      continue
    }
    for (const { name, value } of [...child.attributes]) {
      if (!ATTRS.has(name) || (name === 'href' && !openableLink(value))) child.removeAttribute(name)
    }
    const href = child.tagName === 'A' ? child.getAttribute('href') : null
    if (href !== null) child.setAttribute('title', href)
    clean(child)
  }
}

/**
 * The texts of messages as the chat draws Claude's Markdown, paths in a monospace face: parsed together, in a document that
 * runs nothing and loads nothing. Each text is a box of its own, which its HTML (whole elements only) cannot leave.
 */
function markdownOf(texts: string[]): HTMLElement[] {
  if (texts.length === 0) return []
  const parse = (html: string): HTMLElement => {
    const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
    clean(parsed)
    return parsed
  }
  const htmls = texts.map((t) => chatMarkdownHtml(t, { paths: true }))
  let boxes = [...parse(htmls.map((h) => `<div>${h}</div>`).join('')).children] as HTMLElement[]
  // the boxes never come out other than one for each text; if they did, each text is parsed alone
  if (boxes.length !== texts.length) {
    boxes = htmls.map((h) => {
      const box = document.createElement('div')
      box.append(...parse(h).childNodes)
      return box
    })
  }
  return boxes.map((box) => {
    const body = document.adoptNode(box)
    body.className = 'mail-text chat-text'
    return body
  })
}

/** a message drawn in the panel, kept while the panel shows it: a redraw changes its state in place */
interface Row {
  el: HTMLElement
  /** the message's text, drawn once */
  body: HTMLElement
  clip: HTMLElement
  more: HTMLButtonElement
  /** the text carried Claude Code's relayed-content block */
  relayed: boolean
  /** the text is taller than its cut and two lines, at the panel's width */
  long: boolean
  /** what the row was drawn from that does not change in place: its sender and its kind */
  key: string
  time: HTMLElement
  when: HTMLElement
  waiting: HTMLElement | null
  dot: HTMLElement | null
}

/** a conversation's card, kept while the panel shows it; `key` is what its header was drawn from */
interface Card {
  box: HTMLElement
  head: HTMLElement
  key: string
}

const rowKeyOf = (m: MailMessageView): string => JSON.stringify([m.from, m.kind, m.outcome, m.reason, m.sentAt])

/**
 * The Agent messages panel: the conversations between Claude sessions, for this tab or for all of them, a card each. A message
 * counts as read once it is shown while the panel is shown and the window has the focus. The panel draws again on every change
 * of the mail, tab switch and focus, so what it shows is kept and changed in place: a known message is never drawn again.
 */
export class MailPanel {
  private tabId: string | null = null
  private scope: Scope = 'tab'
  /** the latest load: an answer to an older one that comes later is dropped */
  private seq = 0
  private readonly thisTab: HTMLButtonElement
  private readonly all: HTMLButtonElement
  /** the messages shown, by id */
  private readonly rows = new Map<string, Row>()
  /** the conversations shown, by key */
  private readonly cards = new Map<string, Card>()
  /** the long messages opened with Show more: they stay open over the redraws */
  private readonly opened = new Set<string>()
  /** every message the panel has shown: only one it has not comes in */
  private readonly seen = new Set<string>()
  /** what the panel shows now: the same answer again changes nothing */
  private shownKey: string | null = null
  /** the height of each message's text: a text that is long at the panel's width is cut */
  private readonly sizes = new ResizeObserver((entries) => this.measured(entries))

  constructor(private readonly body: HTMLElement, tools: HTMLElement, private readonly panel: SidePanel, private readonly cb: MailPanelCallbacks) {
    this.thisTab = this.scopeButton('This tab', 'tab')
    this.all = this.scopeButton('All', 'all')
    const scopes = el('div', 'mail-switch')
    scopes.setAttribute('role', 'group')
    scopes.setAttribute('aria-label', 'Show the messages of')
    scopes.append(this.thisTab, this.all)
    tools.append(scopes)
    this.paintScope()
    body.addEventListener('click', (e) => this.click(e))
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
    const unread = views.flatMap((v) => v.messages.filter((m) => !m.read).map((m) => m.id))
    // an answer that changes nothing the panel shows leaves it as it is. A message's text never changes: its id stands for it
    const key = JSON.stringify(views.map((v) => [v.key, v.mine, v.a, v.b, v.lastAt, v.messages.map((m) => [m.id, m.read, m.delivered, rowKeyOf(m)])]))
    if (key !== this.shownKey) {
      this.render(views)
      // known only once drawn: a draw that failed is tried again by the next answer
      this.shownKey = key
    }
    // the messages drawn are read when the panel is in view and the window has the focus
    if (unread.length > 0 && this.panel.isShowing('messages') && document.hasFocus()) void this.cb.markRead(unread)
  }

  private render(views: MailConversationView[]): void {
    // the messages not shown yet, their texts drawn at once
    const fresh = views.flatMap((v) => v.messages).filter((m) => !this.rows.has(m.id))
    const texts = fresh.map((m) => withoutRelayNote(m.text))
    const bodies = markdownOf(texts.map((t) => t.text))
    fresh.forEach((m, i) => this.rows.set(m.id, this.newRow(m, bodies[i]!, texts[i]!.relayed)))

    if (views.length === 0) {
      this.body.replaceChildren(this.empty())
    } else {
      // the cards in order, newest first: only a card that is not where it belongs moves
      views.forEach((view, i) => {
        const box = this.card(view)
        if (this.body.children[i] !== box) this.body.insertBefore(box, this.body.children[i] ?? null)
      })
      while (this.body.children.length > views.length) this.body.lastElementChild!.remove()
    }

    // what is not shown any more is let go
    const keys = new Set(views.map((v) => v.key))
    for (const k of this.cards.keys()) if (!keys.has(k)) this.cards.delete(k)
    const shown = new Set(views.flatMap((v) => v.messages.map((m) => m.id)))
    for (const [id, row] of this.rows) {
      if (shown.has(id)) continue
      this.sizes.unobserve(row.body)
      this.rows.delete(id)
    }
    for (const id of shown) this.seen.add(id)
  }

  private empty(): HTMLElement {
    const box = el('div', 'panel-empty mail-empty')
    const art = el('span', 'mail-empty-icon')
    art.innerHTML = icon('mail', 22)
    box.append(art, el('span', 'mail-empty-text', EMPTY))
    return box
  }

  /** a conversation's card, with its messages in order after its header */
  private card(view: MailConversationView): HTMLElement {
    let card = this.cards.get(view.key)
    if (!card) {
      const box = el('section', 'mail-conversation')
      const head = el('div', 'mail-head')
      box.append(head)
      card = { box, head, key: '' }
      this.cards.set(view.key, card)
    }
    // the tab's own end comes second; with every conversation shown, b does. Its messages are the raised ones
    const raised = view.mine ?? 'b'
    const headKey = JSON.stringify([raised, view.a, view.b, view.lastAt])
    if (card.key !== headKey) {
      card.key = headKey
      const first = raised === 'a' ? view.b : view.a
      const second = raised === 'a' ? view.a : view.b
      const arrow = el('span', 'mail-arrow')
      arrow.innerHTML = icon('move-horizontal', 13)
      card.head.replaceChildren(this.end(first), arrow, this.end(second), el('span', 'mail-head-time', timeOf(view.lastAt)))
    }
    let prev: Element = card.head
    for (const m of view.messages) {
      const row = this.rowOf(m, m.side === raised)
      if (prev.nextElementSibling !== row) prev.after(row)
      prev = row
    }
    while (prev.nextElementSibling) prev.nextElementSibling.remove()
    return card.box
  }

  /** one end of a conversation in its header: a chip with its device's colour and its name without the device */
  private end(end: MailEndView): HTMLElement {
    const chip = el('span', 'mail-end')
    chip.title = end.name
    chip.style.setProperty('--dev', colorOf(end))
    chip.append(el('span', 'mail-end-dot'), el('span', 'mail-end-name', speakerName(end.name, end.deviceName)))
    return chip
  }

  /** a message's row, its state as the answer has it: raised, unread, waiting */
  private rowOf(m: MailMessageView, raised: boolean): HTMLElement {
    let row = this.rows.get(m.id)!
    // a sender's device renamed: the row is drawn again, with the text it has
    if (row.key !== rowKeyOf(m)) {
      const again = this.newRow(m, row.body, row.relayed)
      again.long = row.long
      row.el.remove()
      this.rows.set(m.id, again)
      this.paintClamp(again)
      row = again
    }
    row.el.classList.toggle('raised', raised)
    row.el.classList.toggle('unread', !m.read)
    if (!m.delivered && !row.waiting) {
      row.waiting = el('span', 'mail-waiting', 'waiting')
      row.when.prepend(row.waiting)
    } else if (m.delivered && row.waiting) {
      row.waiting.remove()
      row.waiting = null
    }
    if (!m.read && !row.dot) {
      row.dot = el('span', 'mail-dot')
      row.time.before(row.dot)
    } else if (m.read && row.dot) {
      row.dot.remove()
      row.dot = null
    }
    return row.el
  }

  private newRow(m: MailMessageView, body: HTMLElement, relayed: boolean): Row {
    const row = el('div', 'mail-message')
    row.dataset.id = m.id
    body.dataset.id = m.id
    // a message the panel has not shown before comes in, once
    if (!this.seen.has(m.id)) {
      row.classList.add('mail-new')
      row.addEventListener('animationend', () => row.classList.remove('mail-new'), { once: true })
    }

    // the sender line: avatar, name, device, what the message is, and on the right its state and time
    const name = speakerName(m.from.name, m.from.deviceName)
    const meta = el('div', 'mail-meta')
    const avatar = el('span', 'mail-avatar', initialOf(name))
    avatar.style.setProperty('--dev', colorOf(m.from))
    avatar.setAttribute('aria-hidden', 'true')
    const who = el('span', 'mail-from', name)
    who.title = m.from.name
    meta.append(avatar, who)
    if (m.from.deviceName !== '') meta.append(el('span', 'mail-device', m.from.deviceName))
    const kind = kindLabel(m)
    if (kind !== null) meta.append(el('span', m.outcome === 'failed' ? 'mail-kind failed' : 'mail-kind', kind))
    if (relayed) {
      const badge = el('span', 'mail-relayed', 'Relayed content')
      badge.title = RELAY_NOTE
      meta.append(badge)
    }
    const when = el('span', 'mail-when')
    const time = el('span', 'mail-time', timeOf(m.sentAt))
    time.title = FULL.format(m.sentAt)
    when.append(time)
    meta.append(when)

    const clip = el('div', 'mail-clip')
    clip.append(body)
    const more = el('button', 'mail-more')
    more.type = 'button'
    more.hidden = true
    row.append(meta, clip, more)
    this.sizes.observe(body)
    return { el: row, body, clip, more, relayed, long: false, key: rowKeyOf(m), time, when, waiting: null, dot: null }
  }

  /** the heights of texts the panel laid out: one taller than its cut and two lines is long. Runs after the layout, before the paint */
  private measured(entries: ResizeObserverEntry[]): void {
    let line = 0
    for (const entry of entries) {
      const body = entry.target as HTMLElement
      const row = this.rows.get(body.dataset.id ?? '')
      // a text not laid out (let go, off screen, or the panel hidden) has no height to go by
      if (!row || row.body !== body || entry.contentRect.height === 0) continue
      if (line === 0) line = parseFloat(getComputedStyle(body).lineHeight) || 20
      const long = entry.contentRect.height > line * (CLAMP_LINES + 2)
      if (long === row.long) continue
      row.long = long
      this.paintClamp(row)
    }
  }

  /** a long text is cut, with Show more under it, unless it was opened; Show less closes it again */
  private paintClamp(row: Row): void {
    const open = this.opened.has(row.el.dataset.id ?? '')
    row.clip.classList.toggle('clamped', row.long && !open)
    row.more.hidden = !row.long
    row.more.textContent = open ? 'Show less' : 'Show more'
    row.more.setAttribute('aria-expanded', String(open))
  }

  private click(e: MouseEvent): void {
    const id = (e.target as Element | null)?.closest('.mail-more')?.closest<HTMLElement>('.mail-message')?.dataset.id
    const row = id === undefined ? undefined : this.rows.get(id)
    if (id !== undefined && row) {
      if (!this.opened.delete(id)) this.opened.add(id)
      this.paintClamp(row)
      return
    }
    markdownClick(e, { openExternal: (url) => this.cb.openLink(url), copy: (text) => this.cb.copyText(text) })
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
    for (const [b, scope] of [[this.thisTab, 'tab'], [this.all, 'all']] as const) {
      b.classList.toggle('active', this.scope === scope)
      b.setAttribute('aria-pressed', String(this.scope === scope))
    }
  }
}
