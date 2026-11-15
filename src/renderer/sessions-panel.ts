import type { CoordinatorView, CoordSessionRow } from '../shared/coordinator'
import { deviceColor } from '../shared/remote'
import { icon } from './icons'
import { DEFAULT_FOLDED, nextRedrawAt, rowIcon, rowTime, sessionSections, type RowIcon, type SectionKey, type SessionSection } from './sessions-model'
import type { SidePanel } from './side-panel'
import { spinner } from './tab-row'
import { labelOf } from './util'

export interface SessionsPanelCallbacks {
  openSettings(): void
}

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
  private readonly problemText = el('span', '')
  private readonly list = el('div', 'coord-list')
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(body: HTMLElement, private readonly panel: SidePanel, private readonly cb: SessionsPanelCallbacks) {
    const link = el('button', 'coord-link', 'Open Settings')
    link.type = 'button'
    link.addEventListener('click', () => this.cb.openSettings())
    this.notice.append(this.problemText, link)
    this.notice.hidden = true
    body.replaceChildren(this.notice, this.list)
  }

  /** the tab in front and its view: null for a tab that is no coordinator, or a view not loaded yet */
  show(tabId: string | null, view: CoordinatorView | null): void {
    this.view = tabId === null ? null : view
    this.refresh()
  }

  /** draws again while the panel shows Sessions */
  refresh(): void {
    if (!this.panel.isShowing('sessions')) return
    this.draw()
  }

  private draw(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
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
    const l1 = el('div', 'coord-l1')
    const name = el('span', 'coord-name', labelOf(r.name))
    name.title = r.name
    l1.append(this.icon(rowIcon(r, section)), name)
    if (r.deviceName !== null) l1.append(this.device(r))
    l1.append(el('span', 'coord-time', attached ? rowTime(r.changedAt, now) : ''))
    row.append(l1)
    const place = r.folder !== null && r.branch !== null ? `${r.folder} · ${r.branch}` : (r.folder ?? r.branch)
    if (place !== null) row.append(el('div', 'coord-l2', place))
    if (attached) {
      const tone = r.why === 'prompt' ? ' warn' : r.why === 'limit' || r.why === 'failed' ? ' err' : ''
      row.append(el('div', `coord-l3${tone}`, r.line))
    } else if (r.attachedTo !== null) {
      row.append(el('div', 'coord-l3', `Attached to ${r.attachedTo}`))
    }
    if (attached && r.progress !== null) {
      const prog = el('div', 'coord-prog')
      const bar = document.createElement('i')
      bar.style.width = `${Math.round((r.progress.done / r.progress.total) * 100)}%`
      prog.append(bar)
      row.append(prog)
    }
    return row
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
