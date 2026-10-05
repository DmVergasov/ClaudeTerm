import type { StatusUpdate } from '../shared/ipc'
import type { StatusMessage, SubagentMessage } from '../shared/protocol'
import type { AgentStatus, MainStatus } from '../shared/types'
import type { AgentMeta, AgentModelInfo } from './transcript-agent-info'

export interface StatusHubDeps {
  now(): number
  /** meta of a subagent of the tab's current session; null when it cannot be read (yet) */
  readMeta(tabId: string, agentId: string): AgentMeta | null
  onChange(tabId: string): void
}

interface TrackedAgent extends AgentStatus {
  meta: AgentMeta | null
}

interface TabState {
  sessionId: string | null
  main: MainStatus | null
  agents: Map<string, TrackedAgent>
  /** model·effort seen in a subagent transcript before its SubagentStart hook */
  early: Map<string, AgentModelInfo>
  /** sessions this tab left (replaced or ended); their late statusLine/hook messages are dropped until they start again */
  retired: Set<string>
}

export class StatusHub {
  private readonly tabs = new Map<string, TabState>()

  constructor(private readonly deps: StatusHubDeps) {}

  /** SessionStart; source is its `source` field (startup, resume, clear, compact) */
  session(tabId: string, sessionId: string, source: string): void {
    const t = this.tab(tabId)
    t.retired.delete(sessionId)
    if (t.sessionId !== sessionId) {
      this.switchTo(t, sessionId)
      this.deps.onChange(tabId)
      return
    }
    // a new claude process (restart after a crash) resuming the same session: agents of the old process
    // never got SubagentStop. Compaction keeps them — background agents run through it.
    if ((source === 'startup' || source === 'resume') && (t.agents.size > 0 || t.early.size > 0)) {
      t.agents.clear()
      t.early.clear()
      this.deps.onChange(tabId)
    }
  }

  status(m: StatusMessage): void {
    const t = this.tab(m.tabId)
    if (t.retired.has(m.sessionId)) return
    if (t.sessionId !== m.sessionId) this.switchTo(t, m.sessionId)
    t.main = { model: m.model, effort: m.effort, context: m.context, fiveHour: m.fiveHour }
    this.deps.onChange(m.tabId)
  }

  subagent(m: SubagentMessage): void {
    const t = this.tab(m.tabId)
    if (t.retired.has(m.sessionId)) return
    if (t.sessionId === null) t.sessionId = m.sessionId
    else if (t.sessionId !== m.sessionId) return // a late hook of a previous session
    if (m.event === 'stop') {
      t.early.delete(m.agentId)
      if (t.agents.delete(m.agentId)) this.deps.onChange(m.tabId)
      return
    }
    if (t.agents.has(m.agentId)) return
    const info = t.early.get(m.agentId)
    t.early.delete(m.agentId)
    const a: TrackedAgent = {
      agentId: m.agentId,
      type: m.agentType,
      description: null,
      model: info?.model ?? null,
      effort: info?.effort ?? null,
      startedAt: this.deps.now(),
      meta: null
    }
    this.loadMeta(m.tabId, a)
    t.agents.set(m.agentId, a)
    this.deps.onChange(m.tabId)
  }

  subagentInfo(tabId: string, agentId: string, info: AgentModelInfo): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    const a = t.agents.get(agentId)
    if (!a) {
      t.early.set(agentId, info)
      return
    }
    a.model = info.model
    a.effort = info.effort
    this.loadMeta(tabId, a)
    this.deps.onChange(tabId)
  }

  sessionEnd(tabId: string, sessionId: string): void {
    const t = this.tab(tabId)
    t.retired.add(sessionId)
    if (t.sessionId !== sessionId) return
    this.clear(t, null)
    this.deps.onChange(tabId)
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  get(tabId: string): StatusUpdate {
    const t = this.tabs.get(tabId)
    const agents = t ? [...t.agents.values()].map(({ agentId, type, description, model, effort, startedAt }) => ({ agentId, type, description, model, effort, startedAt })) : []
    return { tabId, main: t?.main ?? null, agents }
  }

  private tab(tabId: string): TabState {
    let t = this.tabs.get(tabId)
    if (!t) {
      t = { sessionId: null, main: null, agents: new Map(), early: new Map(), retired: new Set() }
      this.tabs.set(tabId, t)
    }
    return t
  }

  private switchTo(t: TabState, sessionId: string): void {
    if (t.sessionId !== null) t.retired.add(t.sessionId)
    this.clear(t, sessionId)
  }

  private clear(t: TabState, sessionId: string | null): void {
    t.sessionId = sessionId
    t.main = null
    t.agents.clear()
    t.early.clear()
  }

  private loadMeta(tabId: string, a: TrackedAgent): void {
    if (a.meta) return
    try {
      a.meta = this.deps.readMeta(tabId, a.agentId)
    } catch {
      a.meta = null
    }
    a.description = a.meta?.description ?? null
  }
}
