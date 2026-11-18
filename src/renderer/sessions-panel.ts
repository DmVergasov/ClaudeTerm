import { COORD_TASK_MAX, type CoordinatorView, type CoordSessionRow } from '../shared/coordinator'
import { deviceColor } from '../shared/remote'
import { icon } from './icons'
import { ACTION_LABELS, DEFAULT_FOLDED, nextRedrawAt, rowActions, rowIcon, rowTime, sessionSections, type RowAction, type RowIcon, type SectionKey, type SessionSection } from './sessions-model'
import type { SidePanel } from './side-panel'
import { spinner } from './tab-row'
import { dragCarries, draggingTab, TAB_DRAG } from './tabbar'
import { labelOf } from './util'

export interface SessionsPanelCallbacks {
  openSettings(): void
  open(tabId: string): void
  attach(coordinatorTabId: string, sessionTabId: string): void
  detach(coordinatorTabId: string, key: string): void
  resolve(coordinatorTabId: string, key: string): void
  /** the New session dialog of a coordinator */
  newSession(coordinatorTabId: string): void
  /** the Attach… dialog of a coordinator */
  attachOther(coordinatorTabId: string): void
  /** a tab dropped on the panel of a coordinator's tab: it is attached to that coordinator */
  dropTab(coordinatorTabId: string, tabId: string): void
  /** whether a tab dragged over the panel attaches to that coordinator: only then does the panel light and take the drop */
  canAttach(coordinatorTabId: string, tabId: string): boolean
  /** the tab in front takes the keyboard back: the Message box gave it up when the person closed it */
  focus(): void
  /** null: the task was given; else why not */
  message(coordinatorTabId: string, key: string, text: string): Promise<string | null>
}

const SEND_FAILED = 'The task could not be sent.'

const EMPTY = 'No sessions yet. Start one with New session, attach one with Attach…, or drop a tab here.'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * The Sessions panel of a coordinator's tab: its attached sessions by state, then the project's other sessions. A group
 * folds, and its folds are kept while the panel lives. A notice says what is missing and links to Settings.
 */
export class SessionsPanel {
  private view: CoordinatorView | null = null
  private readonly folded = new Set<SectionKey>(DEFAULT_FOLDED)
  private readonly notice = el('div', 'panel-notice coord-problem')
  // the toolbar: New session and Attach…, built once above the rows
  private readonly bar = el('div', 'coord-bar')
  private readonly problemText = el('span', '')
  private readonly list = el('div', 'coord-list')
  private timer: ReturnType<typeof setTimeout> | null = null
  // the Message box: the coordinator's tab and the row it is for, while it is open
  private compose: { tabId: string; key: string } | null = null
  private readonly composeBox = el('div', 'coord-compose')
  private readonly composeHead = el('div', 'coord-compose-head')
  private readonly field = document.createElement('textarea')
  private readonly composeError = el('div', 'coord-compose-error')
  private readonly send = el('button', 'coord-btn acc', 'Send')
  // a task is on its way to the hub: no other is sent until its answer comes
  private sending = false

  constructor(body: HTMLElement, private readonly panel: SidePanel, private readonly cb: SessionsPanelCallbacks) {
    const link = el('button', 'coord-link', 'Open Settings')
    link.type = 'button'
    link.addEventListener('click', () => this.cb.openSettings())
    this.notice.append(this.problemText, link)
    this.notice.hidden = true
    this.buildCompose()
    this.buildBar()
    body.replaceChildren(this.notice, this.bar, this.list, this.composeBox)
    // a tab that a drop attaches, dragged over the panel of a coordinator's tab, lights the panel; a drop there attaches it to the coordinator
    body.addEventListener('dragover', (e) => {
      const from = draggingTab()
      if (this.view === null || !dragCarries(e, TAB_DRAG) || from === null || !this.cb.canAttach(this.view.tabId, from)) return
      e.preventDefault()
      body.classList.add('coord-drop')
    })
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget as Node | null)) body.classList.remove('coord-drop')
    })
    body.addEventListener('drop', (e) => {
      e.preventDefault()
      body.classList.remove('coord-drop')
      const from = e.dataTransfer?.getData(TAB_DRAG) ?? ''
      if (from && this.view !== null) this.cb.dropTab(this.view.tabId, from)
    })
  }

  /** the tab in front and its view: null for a tab that is no coordinator, or a view not loaded yet */
  show(tabId: string | null, view: CoordinatorView | null): void {
    this.view = tabId === null ? null : view
    // no coordinator in front: nothing is to be drawn again
    if (tabId === null) this.clearTimer()
    // the Message box closes for another tab, and when its row is no longer in the view
    const c = this.compose
    if (c !== null && (tabId !== c.tabId || (view !== null && !view.sessions.some((r) => r.key === c.key)))) this.closeCompose()
    this.refresh()
  }

  /** draws again while the panel shows Sessions */
  refresh(): void {
    // a redraw left pending by a panel that is no longer shown is dropped: it would draw nothing
    this.clearTimer()
    if (!this.panel.isShowing('sessions')) return
    this.draw()
  }

  /** whether a redraw is pending for a row that shows "now" (test runs read it) */
  redrawPending(): boolean {
    return this.timer !== null
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private draw(): void {
    this.clearTimer()
    const view = this.view
    const problem = view?.problem ?? null
    this.notice.hidden = problem === null
    this.problemText.textContent = problem ?? ''
    if (view === null) {
      this.list.replaceChildren()
      return
    }
    const now = Date.now()
    const sections = sessionSections(view, this.folded).map((s) => this.section(s, now))
    const none = view.sessions.length === 0 && view.notAttached.length === 0
    this.list.replaceChildren(...sections, ...(none ? [el('div', 'panel-empty', EMPTY)] : []))
    // a row that shows "now" turns into a clock time while the panel is in view: it is drawn again then
    const next = nextRedrawAt(view.sessions, now)
    if (next !== null) this.timer = setTimeout(() => this.refresh(), next - now)
  }

  private section(s: SessionSection, now: number): HTMLElement {
    const box = el('section', s.folded ? 'coord-group folded' : 'coord-group')
    box.dataset.group = s.key
    const head = el('button', 'coord-gh')
    head.type = 'button'
    const chevron = el('span', 'tp-chevron')
    chevron.innerHTML = icon('chevron-down', 12)
    head.append(chevron, el('span', '', s.label), el('span', 'n', String(s.rows.length)))
    head.addEventListener('click', () => {
      if (this.folded.has(s.key)) this.folded.delete(s.key)
      else this.folded.add(s.key)
      this.draw()
    })
    box.append(head)
    if (!s.folded) box.append(...s.rows.map((r) => this.row(r, s.key, now)))
    return box
  }

  private row(r: CoordSessionRow, section: SectionKey, now: number): HTMLElement {
    const attached = section !== 'not-attached'
    const row = el('div', r.marker === null ? 'coord-row' : `coord-row marker-${r.marker}`)
    row.dataset.key = r.key
    if (r.tabId !== null) row.dataset.tabId = r.tabId
    // a click on the row opens its session's tab; the row's buttons act on the row and do not reach this
    const tabId = r.tabId
    if (tabId !== null) {
      row.addEventListener('click', () => this.cb.open(tabId))
      // a focused row opens its tab on Enter, as a click does; a button in the row keeps its own Enter
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) this.cb.open(tabId) })
    }
    // a row takes the keyboard: its buttons show while it has the focus
    row.tabIndex = 0
    const l1 = el('div', 'coord-l1')
    const name = el('span', 'coord-name', labelOf(r.name))
    name.title = r.name
    l1.append(this.icon(rowIcon(r, section)), name)
    if (r.deviceName !== null) l1.append(this.device(r))
    l1.append(el('span', 'coord-time', attached ? rowTime(r.changedAt, now) : ''))
    row.append(l1)
    const place = r.folder !== null && r.branch !== null ? `${r.folder} · ${r.branch}` : (r.folder ?? r.branch)
    if (place !== null) {
      const line = el('div', 'coord-l2', place)
      // a long folder path is cut at its end on screen: the line's title is its full text
      line.title = place
      row.append(line)
    }
    if (attached) {
      const tone = r.why === 'prompt' || r.why === 'question' ? ' warn' : r.why === 'limit' || r.why === 'failed' ? ' err' : ''
      row.append(el('div', `coord-l3${tone}`, r.line))
    } else if (r.attachedTo !== null) {
      row.append(el('div', 'coord-l3', `Attached to ${r.attachedTo}`))
    }
    if (attached && r.progress !== null && r.progress.total > 0) {
      const prog = el('div', 'coord-prog')
      const bar = document.createElement('i')
      bar.style.width = `${Math.round((r.progress.done / r.progress.total) * 100)}%`
      prog.append(bar)
      row.append(prog)
    }
    const actions = rowActions(r, section)
    if (actions.length > 0) row.append(this.actions(r, actions))
    return row
  }

  private actions(r: CoordSessionRow, actions: RowAction[]): HTMLElement {
    const box = el('div', 'coord-acts')
    for (const action of actions) {
      const btn = el('button', action === 'open' ? 'coord-btn acc' : 'coord-btn ghost', ACTION_LABELS[action])
      btn.type = 'button'
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.act(action, r)
      })
      box.append(btn)
    }
    return box
  }

  private act(action: RowAction, r: CoordSessionRow): void {
    const view = this.view
    if (view === null) return
    switch (action) {
      case 'open':
        if (r.tabId !== null) this.cb.open(r.tabId)
        break
      case 'attach':
        if (r.tabId !== null) this.cb.attach(view.tabId, r.tabId)
        break
      case 'message':
        this.openCompose(r)
        break
      case 'detach':
        this.cb.detach(view.tabId, r.key)
        break
      case 'resolve':
        this.cb.resolve(view.tabId, r.key)
        break
    }
  }

  /** the toolbar's buttons are built once: a redraw of the rows never takes them; each acts for the coordinator in front */
  private buildBar(): void {
    const start = el('button', 'coord-btn acc')
    start.type = 'button'
    const plus = el('span', '')
    plus.innerHTML = icon('plus', 13)
    start.append(plus, 'New session')
    start.addEventListener('click', () => this.toolbar((id) => this.cb.newSession(id)))
    const attach = el('button', 'coord-btn ghost', 'Attach…')
    attach.type = 'button'
    attach.addEventListener('click', () => this.toolbar((id) => this.cb.attachOther(id)))
    this.bar.append(start, attach)
  }

  private toolbar(act: (tabId: string) => void): void {
    if (this.view !== null) act(this.view.tabId)
  }

  /** the Message box is built once, at the foot of the panel: a redraw of the rows never takes its draft or its focus */
  private buildCompose(): void {
    this.composeBox.hidden = true
    this.field.className = 'coord-compose-field'
    this.field.placeholder = 'What should this session do?'
    this.field.maxLength = COORD_TASK_MAX
    this.field.addEventListener('input', () => {
      this.composeError.textContent = ''
      this.syncSend()
    })
    // Enter sends, Shift+Enter is a new line
    this.field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        void this.sendCompose()
      }
    })
    // the box keeps its keys, whichever of its controls has the focus: an Escape closes the box and does not reach the panel or the tab behind it
    this.composeBox.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') this.dismissCompose()
    })
    const cancel = el('button', 'coord-btn ghost', 'Cancel')
    cancel.type = 'button'
    cancel.addEventListener('click', () => this.dismissCompose())
    this.send.type = 'button'
    this.send.disabled = true
    this.send.addEventListener('click', () => void this.sendCompose())
    const actions = el('div', 'coord-compose-actions')
    actions.append(cancel, this.send)
    this.composeBox.append(this.composeHead, this.field, this.composeError, actions)
  }

  /** Send is off while the text is blank and while a task is on its way */
  private syncSend(): void {
    this.send.disabled = this.sending || this.field.value.trim() === ''
  }

  private openCompose(r: CoordSessionRow): void {
    if (this.view === null) return
    this.compose = { tabId: this.view.tabId, key: r.key }
    this.composeHead.textContent = `Task for ${labelOf(r.name)}`
    this.field.value = ''
    this.composeError.textContent = ''
    this.syncSend()
    this.composeBox.hidden = false
    this.field.focus()
  }

  private closeCompose(): void {
    this.compose = null
    this.field.value = ''
    this.composeError.textContent = ''
    this.syncSend()
    this.composeBox.hidden = true
  }

  /** the person closed the box (Send, Cancel or Esc): the tab in front takes the keyboard back, as a closed dialog gives it back */
  private dismissCompose(): void {
    this.closeCompose()
    this.cb.focus()
  }

  private async sendCompose(): Promise<void> {
    const c = this.compose
    const text = this.field.value
    // a second Enter while the task is on its way sends nothing
    if (c === null || this.sending || text.trim() === '') return
    this.sending = true
    this.syncSend()
    let why: string | null
    try {
      why = await this.cb.message(c.tabId, c.key, text)
    } catch {
      why = SEND_FAILED
    }
    this.sending = false
    this.syncSend()
    // the box was closed, or opened for another row, while the answer came
    if (this.compose !== c) return
    if (why === null) {
      this.dismissCompose()
      return
    }
    this.composeError.textContent = why
  }

  private icon(kind: RowIcon): HTMLElement {
    if (kind === 'spin') return spinner('tab-icon')
    if (kind === 'check') {
      const ico = el('span', 'coord-ico')
      ico.innerHTML = icon('check', 12)
      return ico
    }
    return el('span', kind === 'grey' ? 'coord-dot' : `coord-dot ${kind}`)
  }

  private device(r: CoordSessionRow): HTMLElement {
    const chip = el('span', 'coord-dev')
    const bar = document.createElement('i')
    bar.style.background = deviceColor(r.device ?? '')
    chip.append(bar, r.deviceName ?? '')
    return chip
  }
}
