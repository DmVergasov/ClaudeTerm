import { REMOTE_COPY, type DeviceAnswer } from '../shared/remote'
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

/** a device's sessions as the window arranges them: this device's (no device) comes first, then each other device's under its name */
export interface SessionSection {
  device: { id: string; name: string } | null
  /** the device has not answered yet: its section shows a loading line and no session */
  loading: boolean
  arranged: ArrangedSessions
}

/** the key a project is folded by: its folder for this device, the device and its folder for another device */
export function groupKey(s: RecentSession): string {
  return s.device ? `${s.device.id}:${projectKey(s.cwd)}` : projectKey(s.cwd)
}

/** The sections of the window: this device's sessions, then one per other device in the order given, each arranged as arrangeSessions does. */
export function arrangeSections(local: RecentSession[], remote: DeviceAnswer<RecentSession[]>[], query: string): SessionSection[] {
  const sections: SessionSection[] = [{ device: null, loading: false, arranged: arrangeSessions(local, query) }]
  for (const d of remote) {
    const arranged = arrangeSessions(d.value ?? [], query)
    // the heading keys of another device are its own: the same folder on two devices is two projects
    const headings = arranged.headings.map((h) => ({ ...h, key: `${d.device}:${h.key}` }))
    sections.push({ device: { id: d.device, name: d.name }, loading: d.value === null, arranged: { ...arranged, headings } })
  }
  return sections
}

/** a row drawn between the items: a device's name, a line that a device is loading, or the divider between the starred and the rest */
export type Lead = { device: string } | { loading: true } | { divider: true }

/** the Enter after a search takes this: the first match of this device, else of the first other device that has answered (a loading device has none) */
export function firstMatch(sections: SessionSection[]): RecentSession | undefined {
  return sections.find((s) => !s.loading && s.arranged.shown.length > 0)?.arranged.shown[0]
}

/** what the window draws: its items, and the rows drawn before item i (at items.length: after the last item) */
export interface Layout {
  items: Item[]
  leads: Map<number, Lead[]>
}

/** The items and the rows between them for the sections. A folded project shows its heading only, unless the query searches. */
export function layoutSections(sections: SessionSection[], searching: boolean, unfolded: ReadonlySet<string>): Layout {
  const items: Item[] = []
  const leads = new Map<number, Lead[]>()
  const lead = (at: number, l: Lead): void => {
    leads.set(at, [...(leads.get(at) ?? []), l])
  }
  for (const section of sections) {
    const { arranged } = section
    if (section.device) {
      // the name goes before the device's rows, a loading line included; a device with nothing matching has no section
      if (section.loading) {
        lead(items.length, { device: section.device.name })
        lead(items.length, { loading: true })
        continue
      }
      if (arranged.shown.length === 0) continue
      lead(items.length, { device: section.device.name })
    }
    arranged.shown.forEach((s, i) => {
      const heading = arranged.headings.find((h) => h.at === i)
      if (heading) {
        // the divider sits right after the starred block, which is the last thing before the first heading
        if (heading.at === arranged.dividerAt) lead(items.length, { divider: true })
        items.push({ heading })
      }
      const group = arranged.headings.filter((h) => h.at <= i).pop()
      if (group && !searching && !unfolded.has(group.key)) return
      items.push({ session: s })
    })
  }
  return { items, leads }
}

export interface RecentSessionsCallbacks {
  load(): Promise<RecentSession[]>
  /** the other devices' sessions as their last answers give them; the devices are asked again in the background */
  loadRemote(): Promise<DeviceAnswer<RecentSession[]>[]>
  /** device: the device of the section the session was picked in; none for this device's own sessions */
  open(id: string, device?: string): void
  /** the window is about to show: a context menu left open would stay above it */
  opening(): void
  /** the star was toggled; the window shows the new state right away */
  setStarred(id: string, starred: boolean): void
  /** the window closed without opening anything, or before opening: give the keyboard back */
  closed(): void
}

/** A row the keyboard can stand on: a project's heading (Enter folds it) or a session (Enter continues it). */
export type Item = { heading: ProjectHeading } | { session: RecentSession }

/** A modal list of recent sessions with a search field; Enter continues the selected one. */
export class RecentSessionsWindow {
  private sessions: RecentSession[] = []
  /** the other devices' sessions, each device's last answer (value null: not answered yet) */
  private remote: DeviceAnswer<RecentSession[]>[] = []
  private items: Item[] = []
  /** the projects the user unfolded; every project is folded when the window opens, except the newest one */
  private readonly unfolded = new Set<string>()
  private selected = 0
  private loading = false
  private loadId = 0
  /** the window was opened to pick a session for a chat: the pick takes it instead of opening a tab */
  private picking: ((session: RecentSession) => void) | null = null
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
      this.render(firstMatch(arrangeSections(this.sessions, this.remote, this.input.value))?.id)
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

  /** `pick`: a session picked calls it instead of opening a tab (the /resume of a chat) */
  async open(pick?: (session: RecentSession) => void): Promise<void> {
    const id = ++this.loadId
    this.cb.opening()
    this.picking = pick ?? null
    this.root.hidden = false
    this.input.value = ''
    this.selected = 0
    this.unfolded.clear()
    this.sessions = []
    this.remote = []
    this.loading = true
    this.render()
    this.input.focus()
    const list = await this.cb.load().catch(() => [] as RecentSession[])
    // a newer open() or a close() came first: this result is stale
    if (id !== this.loadId) return
    this.sessions = list
    // after this device's list: the main process leaves out of the other devices' answers the sessions this device lists
    // a session picked for a chat is resumed here: the other devices' sessions are not offered for it
    const remote = this.picking !== null ? [] : await this.cb.loadRemote().catch(() => [] as DeviceAnswer<RecentSession[]>[])
    if (id !== this.loadId) return
    this.remote = remote
    this.loading = false
    // Enter right away resumes the latest conversation, as it did before stars: it may sit below the divider
    const latest = this.input.value === '' ? list.reduce<RecentSession | undefined>((a, b) => (!a || b.modifiedAt > a.modifiedAt ? b : a), undefined) : undefined
    if (latest) this.unfolded.add(groupKey(latest))
    // a search typed while the list loaded selects its best match, as typing it after the load does: Enter continues that
    // session, not the project heading above it; a row the arrows already chose stays
    const [kept, keptHeading] = this.current()
    const best = kept ?? (keptHeading === undefined ? firstMatch(arrangeSections(this.sessions, this.remote, this.input.value))?.id : undefined)
    this.render(latest?.id ?? best, keptHeading)
  }

  close(): void {
    if (this.root.hidden) return
    this.loadId++
    this.picking = null
    this.root.hidden = true
    this.cb.closed()
  }

  /** another device changed the stars: an open window shows them at once, keeping the selection and the unfolded projects */
  applyStars(ids: ReadonlySet<string>): void {
    if (!this.isOpen) return
    const [id, heading] = this.current()
    this.mapSessions((s) => (s.starred === ids.has(s.id) ? s : { ...s, starred: ids.has(s.id) }))
    this.render(id, heading)
  }

  /** the other devices' sessions changed: an open window draws them again, keeping the selection and the unfolded projects */
  applyRemote(list: DeviceAnswer<RecentSession[]>[]): void {
    if (!this.isOpen) return
    const [id, heading] = this.current()
    this.remote = list
    this.render(id, heading)
  }

  /** a change to every session the window holds, this device's and the other devices' */
  private mapSessions(f: (s: RecentSession) => RecentSession): void {
    this.sessions = this.sessions.map(f)
    this.remote = this.remote.map((d) => ({ ...d, value: d.value?.map(f) ?? null }))
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
    if (s.starred) this.unfolded.add(groupKey(s))
    this.mapSessions((x) => (x.id === s.id ? { ...x, starred: !x.starred } : x))
    this.cb.setStarred(s.id, !s.starred)
    this.render(id, heading)
  }

  private choose(s: RecentSession | undefined): void {
    if (!s) return
    const pick = this.picking
    this.close()
    if (pick) pick(s)
    else this.cb.open(s.id, s.device?.id)
  }

  private render(keepSelected?: string, keepHeading?: string): void {
    // a search shows every match: a folded project would hide what it found
    const searching = this.input.value.trim() !== ''
    const { items, leads } = layoutSections(arrangeSections(this.sessions, this.remote, this.input.value), searching, this.unfolded)
    this.items = items
    const keptSession = items.findIndex((x) => 'session' in x && x.session.id === keepSelected)
    const kept = keptSession >= 0 ? keptSession : items.findIndex((x) => 'heading' in x && x.heading.key === keepHeading)
    if (kept >= 0) this.selected = kept
    this.selected = Math.min(this.selected, Math.max(items.length - 1, 0))
    if (items.length === 0 && leads.size === 0) {
      const empty = document.createElement('div')
      empty.className = 'sessions-empty'
      const anyRemote = this.remote.some((d) => (d.value ?? []).length > 0)
      empty.textContent = this.loading ? 'Loading…' : this.sessions.length === 0 && !anyRemote ? 'No Claude Code sessions yet' : 'Nothing matches'
      this.rows.replaceChildren(empty)
      return
    }
    const now = Date.now()
    const rows: HTMLElement[] = []
    items.forEach((item, i) => {
      rows.push(...(leads.get(i) ?? []).map((l) => this.leadRow(l)))
      if ('heading' in item) rows.push(this.groupRow(item.heading, i === this.selected, searching || this.unfolded.has(item.heading.key), now))
      else rows.push(this.row(item.session, i === this.selected, now))
    })
    rows.push(...(leads.get(items.length) ?? []).map((l) => this.leadRow(l)))
    this.rows.replaceChildren(...rows)
    this.rows.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }

  /** a row between the items: a device's name, a loading line (REMOTE_COPY.loading), or the divider */
  private leadRow(l: Lead): HTMLElement {
    const el = document.createElement('div')
    if ('device' in l) {
      el.className = 'sessions-device'
      el.textContent = l.device
    } else if ('loading' in l) {
      el.className = 'sessions-loading'
      el.textContent = REMOTE_COPY.loading
    } else {
      el.className = 'sessions-divider'
    }
    return el
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
