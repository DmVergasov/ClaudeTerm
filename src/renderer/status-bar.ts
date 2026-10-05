import type { StatusUpdate } from '../shared/ipc'
import type { AgentStatus } from '../shared/types'

export type Level = 'normal' | 'warn' | 'crit'

export interface Segment {
  key: 'model' | 'context' | 'limit' | 'agents'
  text: string
  title: string
  level: Level
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n >= 999_500) return `${+(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}k`
}

export const levelFor = (pct: number): Level => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'normal')

/** claude-opus-5-5 → opus; anything else as is */
export function modelFamily(id: string): string {
  return /^claude-([a-z]+)-/.exec(id)?.[1] ?? id
}

const groupDigits = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const pad2 = (n: number): string => String(n).padStart(2, '0')
const agentKind = (a: AgentStatus): string => (a.model === null ? '…' : a.effort ? `${modelFamily(a.model)}·${a.effort}` : modelFamily(a.model))

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? '<1 min' : `${m} min`
}

function agentGroups(agents: AgentStatus[]): string {
  const counts = new Map<string, number>()
  for (const a of agents) counts.set(agentKind(a), (counts.get(agentKind(a)) ?? 0) + 1)
  return [...counts]
    .sort((x, y) => y[1] - x[1])
    .map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind))
    .join(', ')
}

const agentLine = (a: AgentStatus, now: number): string =>
  [a.type, agentKind(a), minutes(now - a.startedAt), ...(a.description ? [`"${a.description}"`] : [])].join(' · ')

export function statusSegments(u: StatusUpdate, now: number): Segment[] {
  const main = u.main
  if (!main) return []
  const segments: Segment[] = [
    { key: 'model', text: main.effort ? `${main.model.displayName} · ${main.effort}` : main.model.displayName, title: main.model.id, level: 'normal' }
  ]
  if (main.context) {
    const c = main.context
    segments.push({
      key: 'context',
      text: `ctx ${Math.round(c.usedPct)}% · ${formatTokens(c.usedTokens)}/${formatTokens(c.size)}`,
      title: `${groupDigits(c.usedTokens)} of ${groupDigits(c.size)} tokens`,
      level: levelFor(c.usedPct)
    })
  }
  if (main.fiveHour) {
    const f = main.fiveHour
    const reset = new Date(f.resetsAt * 1000)
    segments.push({ key: 'limit', text: `5h ${Math.round(f.usedPct)}%`, title: `resets at ${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`, level: levelFor(f.usedPct) })
  }
  if (u.agents.length > 0) {
    segments.push({ key: 'agents', text: `⚙ ${u.agents.length}: ${agentGroups(u.agents)}`, title: u.agents.map((a) => agentLine(a, now)).join('\n'), level: 'normal' })
  }
  return segments
}

export class StatusBar {
  constructor(private readonly el: HTMLElement) {}

  render(u: StatusUpdate | null, now = Date.now()): void {
    const segments = u ? statusSegments(u, now) : []
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
          sep.textContent = '│'
          return [sep, span]
        })
      )
      return
    }
    segments.forEach((s, i) => fill(spans[i], s))
  }
}

function fill(span: HTMLElement, s: Segment): void {
  const className = `status-seg status-${s.key}${s.level === 'normal' ? '' : ` ${s.level}`}`
  if (span.className !== className) span.className = className
  if (span.textContent !== s.text) span.textContent = s.text
  if (span.title !== s.title) span.title = s.title
}
