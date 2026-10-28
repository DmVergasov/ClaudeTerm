import type { RecentSession, SessionSummary } from '../shared/types'
import { isPrimaryKey, shortcutLabel } from './keymap'
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

export interface ProjectHeading {
  /** the index in `shown` of the project's first session: the heading goes right before it */
  at: number
  /** the folder of the project, as its newest session wrote it */
  cwd: string
  /** the same for every spelling of the folder: what the window remembers a collapsed project by */
  key: string
  /** how many sessions the project has among the matching ones */
  count: number
  /** when its newest session was last active */
  modifiedAt: number
}

export interface ArrangedSessions {
  /** starred sessions first, then the others by project; newest first inside each block */
  shown: RecentSession[]
  /** where the divider goes (the number of starred ones), null when one of the blocks is empty */
  dividerAt: number | null
  /** one heading per project among the unstarred sessions, in the order of `shown` */
  headings: ProjectHeading[]
}

/** The same folder written with another case, slash or trailing separator is one project (the renderer has no node:path). */
export function projectKey(cwd: string): string {
  const n = cwd.replace(/[\\/]+$/, '').replace(/\//g, '\\')
  return /^[A-Za-z]:|^\\\\/.test(n) ? n.toLowerCase() : cwd.replace(/\/+$/, '')
}

/** The filtered sessions in the order the window shows them. */
export function arrangeSessions(list: RecentSession[], query: string): ArrangedSessions {
  const newestFirst = (a: RecentSession, b: RecentSession): number => b.modifiedAt - a.modifiedAt
  const matching = filterSessions(list, query)
  const starred = matching.filter((s) => s.starred).sort(newestFirst)
  const projects = new Map<string, RecentSession[]>()
  for (const s of matching.filter((x) => !x.starred).sort(newestFirst)) {
    const key = projectKey(s.cwd)
    projects.set(key, [...(projects.get(key) ?? []), s])
  }
  // each project's sessions are already newest first, so its head is its newest session
  const groups = [...projects.values()].sort((a, b) => b[0].modifiedAt - a[0].modifiedAt)
  const headings = groups.map((g, i) => ({
    at: starred.length + groups.slice(0, i).reduce((n, x) => n + x.length, 0),
    cwd: g[0].cwd,
    key: projectKey(g[0].cwd),
    count: g.length,
    modifiedAt: g[0].modifiedAt
  }))
  const shown = [...starred, ...groups.flat()]
  return { shown, dividerAt: starred.length > 0 && groups.length > 0 ? starred.length : null, headings }
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

/** A row the keyboard can stand on: a project's heading (Enter folds it) or a session (Enter continues it). */
type Item = { heading: ProjectHeading } | { session: RecentSession }

/** A modal list of recent sessions with a search field; Enter continues the selected one. */
export class RecentSessionsWindow {
  private sessions: RecentSession[] = []
  private items: Item[] = []
  /** the projects the user unfolded; every project is folded when the window opens, except the newest one */
  private readonly unfolded = new Set<string>()
  private selected = 0
  private loading = false
  private loadId = 0
  private readonly input: HTMLInputElement
  private readonly rows: HTMLElement

  constructor(private readonly root: HTMLElement, private readonly cb: RecentSessionsCallbacks, private readonly platform: string) {
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
      // the best match is the first session, not the heading above it: Enter continues it
      this.selected = 0
      this.render(arrangeSessions(this.sessions, this.input.value).shown[0]?.id)
    })
    this.input.addEventListener('keydown', (e) => {
      const item = this.items[this.selected]
      if (isPrimaryKey(e, this.platform) && e.code === 'KeyD') this.toggleStar(item && 'session' in item ? item.session : undefined)
      else if (e.key === 'ArrowDown') this.move(1)
      else if (e.key === 'ArrowUp') this.move(-1)
      else if (e.key === 'Enter') { if (item && 'heading' in item) this.toggleProject(item.heading.key); else this.choose(item?.session) }
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
    this.unfolded.clear()
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
    if (latest) this.unfolded.add(projectKey(latest.cwd))
    this.render(latest?.id)
  }

  close(): void {
    if (this.root.hidden) return
    this.loadId++
    this.root.hidden = true
    this.cb.closed()
  }

  private move(delta: number): void {
    if (this.items.length === 0) return
    this.selected = Math.min(Math.max(this.selected + delta, 0), this.items.length - 1)
    this.render()
  }

  /** what is selected now: the session's id or the heading's key, to find it again after the list changes */
  private current(): [string | undefined, string | undefined] {
    const at = this.items[this.selected]
    if (at === undefined) return [undefined, undefined]
    return 'session' in at ? [at.session.id, undefined] : [undefined, at.heading.key]
  }

  /** a project folds and unfolds; the selection stays where it was, or goes to the heading when folding hid it */
  private toggleProject(key: string): void {
    const [id, heading] = this.current()
    if (!this.unfolded.delete(key)) this.unfolded.add(key)
    this.render(id, heading ?? key)
  }

  /** the row stays selected where it moves to; an unstarred session goes back to its project, which unfolds to show it */
  private toggleStar(s: RecentSession | undefined): void {
    if (!s) return
    const [id, heading] = this.current()
    if (s.starred) this.unfolded.add(projectKey(s.cwd))
    this.sessions = this.sessions.map((x) => (x.id === s.id ? { ...x, starred: !x.starred } : x))
    this.cb.setStarred(s.id, !s.starred)
    this.render(id, heading)
  }

  private choose(s: RecentSession | undefined): void {
    if (!s) return
    this.close()
    this.cb.open(s.id)
  }

  private render(keepSelected?: string, keepHeading?: string): void {
    const arranged = arrangeSessions(this.sessions, this.input.value)
    // a search shows every match: a folded project would hide what it found
    const searching = this.input.value.trim() !== ''
    const items: Item[] = []
    arranged.shown.forEach((s, i) => {
      const heading = arranged.headings.find((h) => h.at === i)
      if (heading) items.push({ heading })
      const group = arranged.headings.filter((h) => h.at <= i).pop()
      if (group && !searching && !this.unfolded.has(group.key)) return
      items.push({ session: s })
    })
    this.items = items
    const keptSession = items.findIndex((x) => 'session' in x && x.session.id === keepSelected)
    const kept = keptSession >= 0 ? keptSession : items.findIndex((x) => 'heading' in x && x.heading.key === keepHeading)
    if (kept >= 0) this.selected = kept
    this.selected = Math.min(this.selected, Math.max(items.length - 1, 0))
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sessions-empty'
      empty.textContent = this.loading ? 'Loading…' : this.sessions.length === 0 ? 'No Claude Code sessions yet' : 'Nothing matches'
      this.rows.replaceChildren(empty)
      return
    }
    const now = Date.now()
    const rows: HTMLElement[] = []
    items.forEach((item, i) => {
      if ('heading' in item) {
        // the divider sits right after the starred block, which is the last thing before the first heading
        if (item.heading.at === arranged.dividerAt) {
          const divider = document.createElement('div')
          divider.className = 'sessions-divider'
          rows.push(divider)
        }
        rows.push(this.groupRow(item.heading, i === this.selected, searching || this.unfolded.has(item.heading.key), now))
      } else {
        rows.push(this.row(item.session, i === this.selected, now))
      }
    })
    this.rows.replaceChildren(...rows)
    this.rows.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }

  private groupRow(h: ProjectHeading, selected: boolean, open: boolean, now: number): HTMLElement {
    const group = document.createElement('div')
    group.className = `sessions-group${selected ? ' selected' : ''}`
    group.title = h.cwd
    const arrow = document.createElement('span')
    arrow.className = 'group-arrow'
    arrow.textContent = open ? '▾' : '▸'
    const name = document.createElement('span')
    name.className = 'group-name'
    name.textContent = folderName(h.cwd)
    const meta = document.createElement('span')
    meta.className = 'group-meta'
    meta.textContent = `${h.count} ${h.count === 1 ? 'session' : 'sessions'} · ${formatAge(h.modifiedAt, now)}`
    group.append(arrow, name, meta)
    group.addEventListener('click', () => this.toggleProject(h.key))
    return group
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
    star.title = `${s.starred ? 'Unstar' : 'Star'} (${shortcutLabel('star', this.platform)})`
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
