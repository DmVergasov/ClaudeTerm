import type { StatusUpdate } from '../shared/ipc'
import type { ReviewCounter } from '../shared/review'
import type { AgentStatus, BackgroundTask, PlanStatus } from '../shared/types'
import { icon, type IconName } from './icons'

export type Level = 'normal' | 'warn' | 'crit'

export interface Segment {
  key: 'account' | 'model' | 'context' | 'agents' | 'background' | 'plan' | 'changes'
  text: string
  title: string
  level: Level
  /** the effort, drawn as a small pill after the text; none when the model has no effort */
  pill?: string
  /** 0..1, drawn as a thin bar after the text and the pill */
  fill?: number
  /** an icon before the text */
  icon?: IconName
  /** the Changes counter's parts, which the text shows in their own colors */
  diff?: { files: string; added: string; removed: string }
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n >= 999_500) return `${+(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}k`
}

export const levelFor = (pct: number): Level => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'normal')

export const FIVE_HOURS_MS = 5 * 3_600_000
export const SEVEN_DAYS_MS = 7 * 86_400_000
/** before this share of a window has gone by, its pace says too little: the fixed 70% and 90% apply */
const PACE_FROM = 0.08

export interface LimitPace {
  /** the share of the window gone by, 0 to 1 */
  elapsed: number
  /** when the limit is used up at the pace so far, in ms, when that comes before the reset; null otherwise */
  runsOutAt: number | null
  /** the % used by the reset at the pace so far, when the limit lasts until then; null otherwise */
  atReset: number | null
  level: Level
}

/**
 * How a usage limit is being spent: the pace so far, carried on to the reset. Normal when the limit lasts until the
 * reset; warn when it would run out in the second half of the time left, or 90% is used; crit when it would run out
 * sooner, or is used up. Early in the window, and once the reset time has passed, the fixed 70% and 90% apply.
 */
export function limitPace(usedPct: number, resetsAt: number, windowMs: number, now: number): LimitPace {
  const left = resetsAt * 1000 - now
  const gone = windowMs - left
  const elapsed = Math.min(1, Math.max(0, gone / windowMs))
  if (usedPct >= 100) return { elapsed, runsOutAt: null, atReset: null, level: 'crit' }
  if (left <= 0 || elapsed < PACE_FROM) return { elapsed, runsOutAt: null, atReset: null, level: levelFor(usedPct) }
  const atReset = (usedPct * windowMs) / gone
  if (atReset <= 100) return { elapsed, runsOutAt: null, atReset, level: usedPct >= 90 ? 'warn' : 'normal' }
  const runsOutIn = ((100 - usedPct) * gone) / usedPct
  return { elapsed, runsOutAt: now + runsOutIn, atReset: null, level: runsOutIn >= left / 2 ? 'warn' : 'crit' }
}

/** claude-opus-5-5 → opus; anything else as is */
export function modelFamily(id: string): string {
  return /^claude-([a-z]+)-/.exec(id)?.[1] ?? id
}

const groupDigits = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const pad2 = (n: number): string => String(n).padStart(2, '0')
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Fri 9 Oct, 14:00 — a month name, so the date reads the same everywhere */
export const dayAndTime = (d: Date): string => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
const agentKind = (a: AgentStatus): string => (a.model === null ? '…' : a.effort ? `${modelFamily(a.model)}·${a.effort}` : modelFamily(a.model))

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? '<1 min' : `${m} min`
}

/** 42 min, 1 h 20 min, 3 d 18 h */
export function duration(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 60) return minutes(ms)
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`
}

export const hoursAndMinutes = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

function agentGroups(agents: AgentStatus[]): string {
  const counts = new Map<string, number>()
  for (const a of agents) counts.set(agentKind(a), (counts.get(agentKind(a)) ?? 0) + 1)
  return [...counts]
    .sort((x, y) => y[1] - x[1])
    .map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind))
    .join(', ')
}

/** a background task in a few words: what Claude called it, else its command, else its kind */
const taskName = (t: BackgroundTask): string => t.description ?? t.command ?? t.type
const taskLine = (t: BackgroundTask): string => [t.type, t.description, t.command].filter((x) => x !== null).join(' · ')

const agentLine = (a: AgentStatus, now: number): string =>
  [a.type, agentKind(a), minutes(now - a.startedAt), ...(a.description ? [`"${a.description}"`] : [])].join(' · ')

/** the usage limits are not here: the title bar draws them as meters (limit-meters.ts) */
export function statusSegments(u: StatusUpdate, now: number): Segment[] {
  const main = u.main
  if (!main) return []
  const segments: Segment[] = [
    { key: 'model', text: main.model.displayName, ...(main.effort ? { pill: main.effort } : {}), title: main.model.id, level: 'normal' }
  ]
  if (main.context) {
    const c = main.context
    // a fill with no size (a chat whose answer gave no token counts) shows its share alone
    const counts = c.size > 0 ? ` · ${formatTokens(c.usedTokens)}/${formatTokens(c.size)}` : ''
    segments.push({
      key: 'context',
      text: `ctx ${Math.round(c.usedPct)}%${counts}`,
      title: c.size > 0 ? `${groupDigits(c.usedTokens)} of ${groupDigits(c.size)} tokens` : `${Math.round(c.usedPct)}% of the context window used`,
      level: levelFor(c.usedPct),
      fill: c.usedPct / 100
    })
  }
  if (u.agents.length > 0) {
    segments.push({ key: 'agents', text: `⚙ ${u.agents.length}: ${agentGroups(u.agents)}`, title: u.agents.map((a) => agentLine(a, now)).join('\n'), level: 'normal' })
  }
  if (u.background.length > 0) {
    segments.push({
      key: 'background',
      text: `${u.background.length} in background: ${u.background.map(taskName).join(', ')}`,
      title: ['Still running after the turn:', ...u.background.map(taskLine)].join('\n'),
      level: 'normal'
    })
  }
  return segments
}

/** the Changes counter: not part of Claude's status, so it shows before the first statusLine and after the session ends too */
export function changesSegment(c: ReviewCounter): Segment {
  const diff = { files: `${c.files} file${c.files === 1 ? '' : 's'}`, added: `+${c.additions}`, removed: `−${c.deletions}` }
  return { key: 'changes', text: `${diff.files} ${diff.added} ${diff.removed}`, title: c.title, level: 'normal', icon: 'file-diff', diff }
}

/** the superpowers plan being carried out: not part of Claude's status either, so it shows without a statusLine */
export function planSegment(p: PlanStatus): Segment {
  const current = p.tasks.find((t) => t.state === 'current')
  const count = p.finished ? `✓ ${p.total}/${p.total}` : `${p.done}/${p.total}`
  const text = p.finished || !current ? count : `${count} · ${current.title || `Task ${current.n}`}`
  return { key: 'plan', text, title: `${p.title} — ${p.done} of ${p.total} done. Click for the task list`, level: 'normal', fill: p.done / p.total }
}

/** the tab's account, once extra accounts exist: first, and there before Claude's first status too */
export function accountSegment(label: string): Segment {
  return { key: 'account', text: label, title: 'The account this tab runs on — click to switch', level: 'normal' }
}

/** a chat tab's side of the status bar: its Stop for a background task, and the tab those tasks belong to */
export interface ChatStatus {
  tab: string
  /** resolves true when main sent the stop: the task then leaves the status, and so the list */
  stopTask(taskId: string): Promise<boolean>
}

/** a row of the background tasks' list, kept for its task: an update changes the row, never replaces it */
interface TaskRow {
  row: HTMLElement
  name: HTMLElement
  stop: HTMLButtonElement
}

export class StatusBar {
  /** the chat of the tab in front, when its status is the chat's: null in the terminal view */
  private chat: ChatStatus | null = null
  /** the background tasks the status bar names, as the list shows them */
  private tasks: BackgroundTask[] = []
  /** the list of the background tasks, open from its segment in chat view */
  private readonly list = document.createElement('div')
  /** the tab the open list belongs to: a list does not stay open on another tab */
  private listTab: string | null = null
  private readonly rows = new Map<string, TaskRow>()
  /** the tasks whose ✕ was pressed and not refused: a second press on one of them does nothing */
  private readonly stopping = new Set<string>()
  private readonly onClick: (e: MouseEvent) => void

  constructor(private readonly el: HTMLElement, onChangesClick: () => void = () => {}, onAccountClick: (anchor: HTMLElement) => void = () => {}, onPlanClick: (anchor: HTMLElement) => void = () => {}) {
    this.list.className = 'status-tasks'
    this.list.hidden = true
    this.list.setAttribute('role', 'dialog')
    this.list.setAttribute('aria-label', 'Background tasks')
    document.body.append(this.list)
    this.onClick = (e) => {
      const target = e.target as HTMLElement
      if (target.closest('.status-changes')) onChangesClick()
      const account = target.closest<HTMLElement>('.status-account')
      if (account) onAccountClick(account)
      const planSeg = target.closest<HTMLElement>('.status-plan')
      if (planSeg) onPlanClick(planSeg)
      if (target.closest('.status-background') && this.chat) this.toggleTasks()
    }
    el.addEventListener('click', this.onClick)
    el.addEventListener('keydown', this.onSegmentKey)
  }

  /** `chat`: the tab shows its chat, so its model is the composer's and its background tasks can be stopped */
  render(u: StatusUpdate | null, changes: ReviewCounter | null = null, account: string | null = null, plan: PlanStatus | null = null, now = Date.now(), chat?: ChatStatus): void {
    this.chat = chat ?? null
    this.tasks = u && chat ? u.background : []
    this.el.classList.toggle('in-chat', chat !== undefined)
    const segments = [
      ...(account !== null ? [accountSegment(account)] : []),
      ...(u ? statusSegments(u, now).filter((s) => chat === undefined || s.key !== 'model') : []),
      ...(plan ? [planSegment(plan)] : []),
      ...(changes ? [changesSegment(changes)] : [])
    ]
    this.el.hidden = segments.length === 0
    // statusLine refreshes every few seconds: update the same spans in place, because replacing the span
    // under the mouse would close its tooltip (the subagent list)
    const spans = [...this.el.querySelectorAll<HTMLElement>('.status-seg')]
    if (spans.length !== segments.length || segments.some((s, i) => spans[i].dataset.key !== s.key)) {
      this.el.replaceChildren(
        ...segments.flatMap((s, i) => {
          const span = document.createElement('span')
          span.dataset.key = s.key
          fill(span, s)
          if (i === 0) return [span]
          const sep = document.createElement('span')
          sep.className = 'status-sep'
          return [sep, span]
        })
      )
    } else segments.forEach((s, i) => fill(spans[i], s))
    this.markSegment()
    this.refreshTasks()
  }

  /** the background segment of a chat is a button: it takes the focus, and says whether its list is open */
  private markSegment(): void {
    const seg = this.el.querySelector<HTMLElement>('.status-background')
    if (!seg) return
    if (this.chat === null) {
      seg.removeAttribute('role')
      seg.removeAttribute('tabindex')
      seg.removeAttribute('aria-expanded')
      return
    }
    seg.setAttribute('role', 'button')
    seg.tabIndex = 0
    seg.setAttribute('aria-expanded', String(!this.list.hidden))
  }

  /** Enter or Space on the segment opens its list, as a click does */
  private readonly onSegmentKey = (e: KeyboardEvent): void => {
    if ((e.key !== 'Enter' && e.key !== ' ') || this.chat === null) return
    if (!(e.target as Element).closest?.('.status-background')) return
    e.preventDefault()
    this.toggleTasks()
  }

  /** the list of the background tasks, opened from its segment; a press on the segment again closes it */
  private toggleTasks(): void {
    if (!this.list.hidden) {
      this.closeTasks()
      return
    }
    const background = this.el.querySelector<HTMLElement>('.status-background')
    if (this.chat === null || this.tasks.length === 0 || background === null) return
    this.listTab = this.chat.tab
    this.syncRows()
    this.list.hidden = false
    this.markSegment()
    this.place(background)
    // capture phase: Esc and the arrows are the list's, and Esc does not reach the composer, where it would interrupt the turn
    document.addEventListener('keydown', this.onListKey, true)
    document.addEventListener('mousedown', this.onMouseDown, true)
    window.addEventListener('resize', this.onResize)
    // the first Stop takes the focus, so the keys go to the list
    this.list.querySelector<HTMLButtonElement>('button')?.focus()
  }

  private closeTasks(): void {
    if (this.list.hidden) return
    const hadFocus = this.list.contains(document.activeElement)
    this.list.hidden = true
    this.list.replaceChildren()
    this.rows.clear()
    this.listTab = null
    document.removeEventListener('keydown', this.onListKey, true)
    document.removeEventListener('mousedown', this.onMouseDown, true)
    window.removeEventListener('resize', this.onResize)
    this.markSegment()
    // a list that closes with the focus in it hands the focus back to its segment
    if (hadFocus) this.el.querySelector<HTMLElement>('.status-background')?.focus()
  }

  /** Esc closes the list and returns the focus to its segment; the arrows move between the Stop buttons */
  private readonly onListKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // closeTasks hands the focus back to the segment when the list had it
      this.closeTasks()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const stops = [...this.list.querySelectorAll<HTMLButtonElement>('button')]
    const at = stops.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    e.stopPropagation()
    stops[e.key === 'ArrowDown' ? Math.min(stops.length - 1, at + 1) : Math.max(0, at - 1)]?.focus()
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    const t = e.target as Element | null
    // a press on the segment is left to its click, which toggles
    if (this.list.contains(t) || t?.closest?.('.status-background')) return
    this.closeTasks()
  }

  private readonly onResize = (): void => {
    const background = this.el.querySelector<HTMLElement>('.status-background')
    if (background) this.place(background)
  }

  /** the open list follows the tasks: it closes once none is left, its segment is gone, or the tab in front is another one */
  private refreshTasks(): void {
    if (this.list.hidden) return
    const background = this.el.querySelector<HTMLElement>('.status-background')
    if (this.chat === null || this.chat.tab !== this.listTab || this.tasks.length === 0 || background === null) {
      this.closeTasks()
      return
    }
    this.syncRows()
    this.place(background)
  }

  /**
   * The rows follow the tasks by id. A row that stays is updated in place (its name, when it changed), so the Stop under the
   * pointer or the focus is the same node after every update. A row of a task that ended goes; the focus moves to the next Stop.
   */
  private syncRows(): void {
    const ids = new Set(this.tasks.map((t) => t.id))
    // where the focused row was: the focus goes to the row that takes its place
    let lostAt = -1
    for (const [id, r] of this.rows) {
      if (ids.has(id)) continue
      if (r.row.contains(document.activeElement)) lostAt = Array.from(this.list.children).indexOf(r.row)
      r.row.remove()
      this.rows.delete(id)
      this.stopping.delete(id)
    }
    let before: Element | null = this.list.firstElementChild
    for (const t of this.tasks) {
      let r = this.rows.get(t.id)
      if (!r) {
        r = this.makeRow(t.id)
        this.rows.set(t.id, r)
      }
      const name = taskName(t)
      if (r.name.textContent !== name) r.name.textContent = name
      if (r.name.title !== name) r.name.title = name
      // a row in its place stays as it is; a new one goes before the row that follows it
      if (r.row === before) before = before.nextElementSibling
      else this.list.insertBefore(r.row, before)
    }
    if (lostAt >= 0) {
      const stops = this.list.querySelectorAll<HTMLButtonElement>('button')
      stops[Math.min(lostAt, stops.length - 1)]?.focus()
    }
  }

  /** a task's ✕: one stop per task while it is on its way; a stop main does not send leaves the task listed, to be stopped again */
  private stop(taskId: string): void {
    if (this.chat === null || this.stopping.has(taskId)) return
    this.stopping.add(taskId)
    const release = (): void => {
      this.stopping.delete(taskId)
    }
    this.chat.stopTask(taskId).then((sent) => {
      if (!sent) release()
    }, release)
  }

  /** one row per task, with its own Stop */
  private makeRow(taskId: string): TaskRow {
    const row = document.createElement('div')
    row.className = 'status-task'
    const name = document.createElement('span')
    name.className = 'status-task-name'
    const stop = document.createElement('button')
    stop.className = 'status-task-stop'
    stop.type = 'button'
    stop.title = 'Stop this task'
    stop.setAttribute('aria-label', 'Stop this task')
    stop.innerHTML = icon('x', 12)
    stop.addEventListener('click', () => this.stop(taskId))
    row.append(name, stop)
    this.list.append(row)
    return { row, name, stop }
  }

  /** bottom edge 4px above the status bar, left edge at the segment, kept inside the window */
  private place(anchor: HTMLElement): void {
    const a = anchor.getBoundingClientRect()
    const r = this.list.getBoundingClientRect()
    const bar = this.el.getBoundingClientRect()
    this.list.style.left = `${Math.max(0, Math.min(a.left, window.innerWidth - r.width - 4))}px`
    this.list.style.bottom = `${Math.max(0, window.innerHeight - bar.top + 4)}px`
  }
}

/** the parts of a segment, in the order they sit in its span */
const PARTS = ['status-icon', 'status-text', 'status-pill', 'status-bar']

/** the span's own part of the class: made when missing, placed before the parts that follow it */
function part(span: HTMLElement, cls: string): HTMLElement {
  const found = span.querySelector<HTMLElement>(`:scope > .${cls}`)
  if (found) return found
  const el = document.createElement('span')
  el.className = cls
  const next = PARTS.slice(PARTS.indexOf(cls) + 1).map((c) => span.querySelector(`:scope > .${c}`)).find((x) => x !== null)
  span.insertBefore(el, next ?? null)
  return el
}

/** the Changes counter's text: the files, then the added lines and the removed ones, each in a span of its own color */
function fillDiff(text: HTMLElement, d: NonNullable<Segment['diff']>): void {
  const keys = ['files', 'added', 'removed'] as const
  const parts = keys.map((k) => text.querySelector<HTMLElement>(`:scope > .status-${k}`))
  if (parts.some((p) => p === null)) {
    const spans = keys.map((k) => {
      const el = document.createElement('span')
      el.className = `status-${k}`
      el.textContent = d[k]
      return el
    })
    text.replaceChildren(spans[0], ' ', spans[1], ' ', spans[2])
    return
  }
  keys.forEach((k, i) => {
    if (parts[i]!.textContent !== d[k]) parts[i]!.textContent = d[k]
  })
}

/** the text, the pill and the bar are updated where they are, so a refresh keeps the nodes under the mouse */
function fill(span: HTMLElement, s: Segment): void {
  const className = `status-seg status-${s.key}${s.level === 'normal' ? '' : ` ${s.level}`}`
  if (span.className !== className) span.className = className
  if (span.title !== s.title) span.title = s.title
  if (s.icon !== undefined) {
    const ic = part(span, 'status-icon')
    if (ic.dataset.icon !== s.icon) {
      ic.dataset.icon = s.icon
      ic.innerHTML = icon(s.icon, 13)
    }
  } else span.querySelector(':scope > .status-icon')?.remove()
  const text = part(span, 'status-text')
  if (s.diff !== undefined) fillDiff(text, s.diff)
  else if (text.textContent !== s.text) text.textContent = s.text
  if (s.pill !== undefined) {
    const pill = part(span, 'status-pill')
    if (pill.textContent !== s.pill) pill.textContent = s.pill
  } else span.querySelector(':scope > .status-pill')?.remove()
  if (s.fill !== undefined) {
    const bar = part(span, 'status-bar')
    const width = `${Math.round(s.fill * 100)}%`
    if (bar.style.getPropertyValue('--fill') !== width) bar.style.setProperty('--fill', width)
  } else span.querySelector(':scope > .status-bar')?.remove()
}
