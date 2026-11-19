import type { ChatSubagent } from '../shared/chat'
import type { StatusUpdate } from '../shared/ipc'
import type { AgentStatus } from '../shared/types'
import { type AgentCardRow, fillAgentsCard, tickAgentTimes } from './chat/chat-steps'
import { bareAgents } from './status-bar'

/** an ordinary subagent as the card draws it: it is running, as the status only lists running agents */
function subagentOf(a: AgentStatus): ChatSubagent {
  const agent: ChatSubagent = { id: a.agentId, description: a.description ?? '', type: a.type, state: 'running', ms: null, startedAt: a.startedAt }
  if (a.model !== null) agent.model = a.model
  if (a.effort !== null) agent.effort = a.effort
  return agent
}

/** the status's agents as the card lists them: the bare agents and the Workflow runs, by start time; a run's agents sit in its group */
export function statusRows(u: StatusUpdate): AgentCardRow[] {
  const rows: { at: number; row: AgentCardRow }[] = [
    ...bareAgents(u).map((a) => ({ at: a.startedAt, row: { kind: 'agent', agent: subagentOf(a) } as AgentCardRow })),
    ...(u.runs ?? []).map((run) => ({ at: run.startedAt ?? 0, row: { kind: 'run', run } as AgentCardRow }))
  ]
  return rows.sort((x, y) => x.at - y.at).map((x) => x.row)
}

/** The ⚙ card: the tab's agents and Workflow runs, opened from the agents segment. A box above the status bar, like the plan list. */
export class AgentsCard {
  private timer: ReturnType<typeof setInterval> | null = null

  /** onClosed gets `refocus`: false when a status update closed the card, so the focus stays where the person has it */
  constructor(private readonly el: HTMLElement, private readonly onClosed: (refocus: boolean) => void, private readonly open: (agentId: string) => void) {}

  get isOpen(): boolean {
    return !this.el.hidden
  }

  /** `chat`: the tab shows its chat, so an agent's row opens its page; a terminal tab's rows are not buttons */
  toggle(anchor: HTMLElement, u: StatusUpdate, chat: boolean): void {
    if (this.isOpen) {
      this.close()
      return
    }
    const rows = statusRows(u)
    if (rows.length === 0) return
    this.render(rows, chat)
    this.el.hidden = false
    this.place(anchor)
    // capture phase: Esc must not reach the terminal, where it would interrupt Claude's turn
    document.addEventListener('keydown', this.onKey, true)
    document.addEventListener('mousedown', this.onMouseDown, true)
    this.timer = setInterval(() => tickAgentTimes(this.el), 1000)
  }

  update(u: StatusUpdate | null, chat: boolean): void {
    if (!this.isOpen) return
    const rows = u ? statusRows(u) : []
    // a status update closes the card: the person did not, so the focus is not moved
    if (rows.length === 0) {
      this.close(false)
      return
    }
    this.render(rows, chat)
    this.place()
  }

  close(refocus = true): void {
    if (!this.isOpen) return
    this.el.hidden = true
    this.el.replaceChildren()
    document.removeEventListener('keydown', this.onKey, true)
    document.removeEventListener('mousedown', this.onMouseDown, true)
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.onClosed(refocus)
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    this.close()
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    const t = e.target as Element | null
    // a press on the segment is left to its click, which toggles
    if (this.el.contains(t) || t?.closest?.('.status-agents')) return
    this.close()
  }

  private render(rows: AgentCardRow[], chat: boolean): void {
    fillAgentsCard(this.el, rows, chat ? { open: (agentId) => this.open(agentId) } : {})
  }

  /** bottom edge 4px above the status bar, left edge at the segment, kept inside the window */
  private place(opened?: HTMLElement): void {
    // the status bar replaces its segments when the set of them changes, so the one the card opened from may be gone
    const seg = opened ?? document.querySelector<HTMLElement>('#statusbar .status-agents')
    if (!seg) {
      this.close(false)
      return
    }
    const a = seg.getBoundingClientRect()
    const r = this.el.getBoundingClientRect()
    const bar = seg.closest('#statusbar')?.getBoundingClientRect() ?? a
    this.el.style.left = `${Math.max(0, Math.min(a.left, window.innerWidth - r.width - 4))}px`
    this.el.style.bottom = `${Math.max(0, window.innerHeight - bar.top + 4)}px`
  }
}
