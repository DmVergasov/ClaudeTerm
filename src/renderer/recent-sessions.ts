import type { RecentSession, SessionSummary } from '../shared/types'
import { folderName } from './util'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** When a session was last active, as the list shows it. */
export function formatAge(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS)
  if (days <= 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const d = new Date(at)
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date} ${d.getFullYear()}`
}

export const displayTitle = (s: SessionSummary): string => s.title ?? s.firstPrompt ?? '(untitled)'

/** Sessions where every typed word appears in the title, the folder or a message, ignoring case. */
export function filterSessions(list: RecentSession[], query: string): RecentSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return list
  return list.filter((s) => {
    const text = [s.title, s.cwd, s.firstPrompt, s.lastPrompt].filter((x) => x !== null).join('\n').toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

export interface ArrangedSessions {
  /** starred sessions first, then the others; newest first in each group */
  shown: RecentSession[]
  /** where the divider goes (the number of starred ones), null when one of the groups is empty */
  dividerAt: number | null
}

/** The filtered sessions in the order the window shows them. */
export function arrangeSessions(list: RecentSession[], query: string): ArrangedSessions {
  const newestFirst = (a: RecentSession, b: RecentSession): number => b.modifiedAt - a.modifiedAt
  const matching = filterSessions(list, query)
  const starred = matching.filter((s) => s.starred).sort(newestFirst)
  const others = matching.filter((s) => !s.starred).sort(newestFirst)
  return { shown: [...starred, ...others], dividerAt: starred.length > 0 && others.length > 0 ? starred.length : null }
}

export interface RecentSessionsCallbacks {
  load(): Promise<RecentSession[]>
  open(id: string): void
  /** the window is about to show: a context menu left open would stay above it */
  opening(): void
  /** the star was toggled; the window shows the new state right away */
  setStarred(id: string, starred: boolean): void
  /** the window closed without opening anything, or before opening: give the keyboard back */
  closed(): void
}

/** A modal list of recent sessions with a search field; Enter continues the selected one. */
export class RecentSessionsWindow {
  private sessions: RecentSession[] = []
  private shown: RecentSession[] = []
  private dividerAt: number | null = null
  private selected = 0
  private loading = false
  private loadId = 0
  private readonly input: HTMLInputElement
  private readonly rows: HTMLElement

  constructor(private readonly root: HTMLElement, private readonly cb: RecentSessionsCallbacks) {
    const box = document.createElement('div')
    box.className = 'sessions-box'
    const heading = document.createElement('div')
    heading.className = 'sessions-heading'
    heading.textContent = 'Recent sessions'
    this.input = document.createElement('input')
    this.input.className = 'sessions-search'
    this.input.placeholder = 'Search by title, folder or message'
    this.input.spellcheck = false
    this.rows = document.createElement('div')
    this.rows.className = 'sessions-list'
    box.append(heading, this.input, this.rows)
    root.replaceChildren(box)
    root.addEventListener('mousedown', (e) => { if (e.target === root) this.close() })
    this.input.addEventListener('input', () => {
      this.selected = 0
      this.render()
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyD') this.toggleStar(this.shown[this.selected])
      else if (e.key === 'ArrowDown') this.move(1)
      else if (e.key === 'ArrowUp') this.move(-1)
      else if (e.key === 'Enter') this.choose(this.shown[this.selected])
      else if (e.key === 'Escape') this.close()
      else if (e.key !== 'Tab') return
      e.preventDefault()
    })
    // the terminal behind the window must not get the keyboard while it is open (a click on the heading,
    // a Tab): typing would go to Claude's prompt
    this.input.addEventListener('blur', () => { if (this.isOpen) this.input.focus() })
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  async open(): Promise<void> {
    const id = ++this.loadId
    this.cb.opening()
    this.root.hidden = false
    this.input.value = ''
    this.selected = 0
    this.sessions = []
    this.loading = true
    this.render()
    this.input.focus()
    const list = await this.cb.load().catch(() => [] as RecentSession[])
    // a newer open() or a close() came first: this result is stale
    if (id !== this.loadId) return
    this.sessions = list
    this.loading = false
    // Enter right away resumes the latest conversation, as it did before stars: it may sit below the divider
    const latest = this.input.value === '' ? list.reduce<RecentSession | undefined>((a, b) => (!a || b.modifiedAt > a.modifiedAt ? b : a), undefined) : undefined
    this.render(latest?.id)
  }

  close(): void {
    if (this.root.hidden) return
    this.loadId++
    this.root.hidden = true
    this.cb.closed()
  }

  private move(delta: number): void {
    if (this.shown.length === 0) return
    this.selected = Math.min(Math.max(this.selected + delta, 0), this.shown.length - 1)
    this.render()
  }

  /** the row stays selected where it moves to */
  private toggleStar(s: RecentSession | undefined): void {
    if (!s) return
    const keep = this.shown[this.selected]?.id
    this.sessions = this.sessions.map((x) => (x.id === s.id ? { ...x, starred: !x.starred } : x))
    this.cb.setStarred(s.id, !s.starred)
    this.render(keep)
  }

  private choose(s: RecentSession | undefined): void {
    if (!s) return
    this.close()
    this.cb.open(s.id)
  }

  private render(keepSelected?: string): void {
    const arranged = arrangeSessions(this.sessions, this.input.value)
    this.shown = arranged.shown
    this.dividerAt = arranged.dividerAt
    const kept = keepSelected === undefined ? -1 : this.shown.findIndex((x) => x.id === keepSelected)
    if (kept >= 0) this.selected = kept
    if (this.shown.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sessions-empty'
      empty.textContent = this.loading ? 'Loading…' : this.sessions.length === 0 ? 'No Claude Code sessions yet' : 'Nothing matches'
      this.rows.replaceChildren(empty)
      return
    }
    const now = Date.now()
    const rows = this.shown.map((s, i) => this.row(s, i === this.selected, now))
    if (this.dividerAt !== null) {
      const divider = document.createElement('div')
      divider.className = 'sessions-divider'
      rows.splice(this.dividerAt, 0, divider)
    }
    this.rows.replaceChildren(...rows)
    this.rows.querySelector('.session-row.selected')?.scrollIntoView({ block: 'nearest' })
  }

  private row(s: RecentSession, selected: boolean, now: number): HTMLElement {
    const row = document.createElement('div')
    row.className = `session-row${selected ? ' selected' : ''}`
    row.dataset.id = s.id
    const top = document.createElement('div')
    top.className = 'session-top'
    const title = document.createElement('span')
    title.className = 'session-title'
    title.textContent = displayTitle(s)
    top.append(title)
    if (s.open) {
      const open = document.createElement('span')
      open.className = 'session-open'
      open.textContent = '● open'
      top.append(open)
    }
    const star = document.createElement('span')
    star.className = `session-star${s.starred ? ' starred' : ''}`
    star.textContent = s.starred ? '★' : '☆'
    star.title = s.starred ? 'Unstar (Ctrl+D)' : 'Star (Ctrl+D)'
    star.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleStar(s)
    })
    top.append(star)
    const meta = document.createElement('div')
    meta.className = 'session-meta'
    const folder = document.createElement('span')
    folder.textContent = folderName(s.cwd)
    folder.title = s.cwd
    meta.append(folder, ` · ${formatAge(s.modifiedAt, now)}`)
    row.append(top, meta)
    if (s.lastPrompt && s.lastPrompt !== displayTitle(s)) {
      const last = document.createElement('div')
      last.className = 'session-last'
      last.textContent = s.lastPrompt
      row.append(last)
    }
    // the second click of a double-click can land on another row, which moved under the pointer
    row.addEventListener('click', (e) => { if (e.detail <= 1) this.choose(s) })
    return row
  }
}
