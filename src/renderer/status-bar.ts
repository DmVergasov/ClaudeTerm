import type { StatusUpdate } from '../shared/ipc'
import type { ReviewCounter } from '../shared/review'
import type { AgentStatus, BackgroundTask, PlanStatus } from '../shared/types'

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
    segments.push({
      key: 'context',
      text: `ctx ${Math.round(c.usedPct)}% · ${formatTokens(c.usedTokens)}/${formatTokens(c.size)}`,
      title: `${groupDigits(c.usedTokens)} of ${groupDigits(c.size)} tokens`,
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
  return { key: 'changes', text: `± ${c.files} file${c.files === 1 ? '' : 's'} +${c.additions} −${c.deletions}`, title: c.title, level: 'normal' }
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

export class StatusBar {
  constructor(private readonly el: HTMLElement, onChangesClick: () => void = () => {}, onAccountClick: (anchor: HTMLElement) => void = () => {}, onPlanClick: (anchor: HTMLElement) => void = () => {}) {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('.status-changes')) onChangesClick()
      const account = target.closest<HTMLElement>('.status-account')
      if (account) onAccountClick(account)
      const planSeg = target.closest<HTMLElement>('.status-plan')
      if (planSeg) onPlanClick(planSeg)
    })
  }

  render(u: StatusUpdate | null, changes: ReviewCounter | null = null, account: string | null = null, plan: PlanStatus | null = null, now = Date.now()): void {
    const segments = [
      ...(account !== null ? [accountSegment(account)] : []),
      ...(u ? statusSegments(u, now) : []),
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
      return
    }
    segments.forEach((s, i) => fill(spans[i], s))
  }
}

/** the parts of a segment, in the order they sit in its span */
const PARTS = ['status-text', 'status-pill', 'status-bar']

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

/** the text, the pill and the bar are updated where they are, so a refresh keeps the nodes under the mouse */
function fill(span: HTMLElement, s: Segment): void {
  const className = `status-seg status-${s.key}${s.level === 'normal' ? '' : ` ${s.level}`}`
  if (span.className !== className) span.className = className
  if (span.title !== s.title) span.title = s.title
  const text = part(span, 'status-text')
  if (text.textContent !== s.text) text.textContent = s.text
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
