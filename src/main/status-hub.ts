import type { StatusUpdate } from '../shared/ipc'
import type { StatusMessage, SubagentMessage } from '../shared/protocol'
import type { RemoteState } from '../shared/remote-control'
import type { AgentStatus, BackgroundTask, MainStatus } from '../shared/types'
import { endRun, foldJournal, isRunId, MAX_RUN_AGENTS, type RunEnd, type RunRows, type WorkflowAgentRow, type WorkflowRun } from '../shared/workflow'
import type { LimitWait } from './auto-continue'
import type { RunFile } from './workflow-files'
import type { AgentMeta, AgentModelInfo } from './transcript-agent-info'

export interface StatusHubDeps {
  now(): number
  /** meta of a subagent of the tab's current session, in its run's folder when runId is set; null when it cannot be read (yet) */
  readMeta(tabId: string, agentId: string, runId: string | null): AgentMeta | null
  onChange(tabId: string): void
  /** the tab's Remote Control id changed (a report of its session, or a status): `previous` is what it was */
  remoteChanged?(tabId: string, id: string | null, previous: string | null): void
  /** the tab's Remote Control state, which the status carries; null for a tab without the segment */
  remoteState?(tabId: string): RemoteState | null
}

/** the kinds of background work, as Claude Code names them, that run no subagent; a kind not named here may run one */
const AGENTLESS_TASKS = new Set(['shell', 'monitor', 'MCP task'])
/** the Workflow runs a tab keeps: when one more comes, the oldest ended one goes first */
const MAX_RUNS = 8
/** the runs a tab keeps the ids of after a prompt dropped them */
const MAX_RUNS_DROPPED = 200
/** the journal lines a run keeps: the last ones */
const MAX_JOURNAL_LINES = 2000

interface TrackedAgent extends AgentStatus {
  meta: AgentMeta | null
}

/** a Workflow run the tab's status keeps: the run as shown, the journal behind its rows, and what the hooks and the feed said of its agents */
interface TrackedRun {
  runId: string
  /** key is the runId; its rows are not in here: they come from the journal and the tracked agents when the status is read */
  run: WorkflowRun
  journal: unknown[]
  rows: RunRows
  /** the run file's rows, used when the journal gave none */
  fileRows: RunRows | null
  /** the task text of each agent, by agent id */
  tasks: Map<string, string>
  /** model·effort of each agent, by agent id, kept after the agent is gone */
  infos: Map<string, AgentModelInfo>
}

interface TabState {
  sessionId: string | null
  main: MainStatus | null
  agents: Map<string, TrackedAgent>
  /** model·effort seen in a subagent transcript before its SubagentStart hook */
  early: Map<string, AgentModelInfo>
  /** sessions this tab left (replaced or ended); their late statusLine/hook messages are dropped until they start again */
  retired: Set<string>
  /** the background work still running when the last turn ended */
  background: BackgroundTask[]
  /** the usage limit the tab's turn stopped on, while Claude waits to go on after its reset */
  wait: LimitWait | null
  /** the Remote Control id the tab's Claude Code last reported; it lives through /clear and goes with the session's end */
  remoteId: string | null
  /** the tab's Workflow runs, in start order */
  runs: TrackedRun[]
  /** the agents whose stop came (SubagentStop, a StopFailure, or a turn end's drop), the last ones: a run row they name is done */
  stopped: Set<string>
  /** the runs a prompt dropped, the last ones: a late report of one of them does not bring it back */
  dropped: Set<string>
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
    // Its background shells and monitors ended with the old process too, and so did its workflow runs.
    if ((source === 'startup' || source === 'resume') && (t.agents.size > 0 || t.early.size > 0 || t.background.length > 0 || t.runs.length > 0 || t.stopped.size > 0)) {
      t.agents.clear()
      t.early.clear()
      t.background = []
      t.runs = []
      t.stopped.clear()
      t.dropped.clear()
      this.deps.onChange(tabId)
    }
  }

  /** a background task stopped from the window: it leaves the tab's list, and no later status brings it back */
  dropBackground(tabId: string, taskId: string): void {
    const t = this.tab(tabId)
    if (!t.background.some((task) => task.id === taskId)) return
    t.background = t.background.filter((task) => task.id !== taskId)
    this.deps.onChange(tabId)
  }

  /** a turn ended (Stop): the background work Claude started that still runs; each turn end says it anew */
  background(tabId: string, sessionId: string, tasks: BackgroundTask[]): void {
    const t = this.tab(tabId)
    if (t.retired.has(sessionId)) return
    if (t.sessionId === null) t.sessionId = sessionId
    else if (t.sessionId !== sessionId) return // a late hook of a previous session
    t.background = tasks
    // past the end of a turn no subagent runs in the foreground, and in the background only under work that can run one (a
    // subagent, a workflow, a teammate): with none listed, the agents still shown have ended, also one whose SubagentStop never came
    if (tasks.every((task) => AGENTLESS_TASKS.has(task.type))) {
      for (const id of t.agents.keys()) this.rememberStop(t, id)
      t.agents.clear()
    }
    // a run still running ends with its background task: stopped when Claude no longer lists that task, or, without a task id, when no workflow is listed
    for (const r of t.runs) {
      if (r.run.state !== 'running') continue
      const gone = r.run.taskId !== null ? !tasks.some((task) => task.id === r.run.taskId) : !tasks.some((task) => task.type === 'workflow')
      if (!gone) continue
      this.finish(r, 'stopped', null)
      this.endAgents(t, r)
    }
    this.deps.onChange(tabId)
  }

  /** a prompt of the user (UserPromptSubmit): the runs that ended are no longer kept; the running ones stay */
  turn(tabId: string, sessionId: string): void {
    const t = this.runTab(tabId, sessionId)
    if (!t) return
    const kept = t.runs.filter((r) => r.run.state === 'running')
    if (kept.length === t.runs.length) return
    for (const r of t.runs) {
      if (r.run.state !== 'running') this.rememberDropped(t, r.runId)
    }
    t.runs = kept
    this.deps.onChange(tabId)
  }

  /** a Workflow run the transcript shows started, with its name and task id */
  workflowRun(tabId: string, sessionId: string, run: { runId: string; name: string; taskId: string }): void {
    if (!isRunId(run.runId)) return
    const t = this.runTab(tabId, sessionId)
    if (!t || t.dropped.has(run.runId)) return
    const r = this.runOf(t, run.runId)
    r.run.name = run.name
    r.run.taskId = run.taskId
    this.deps.onChange(tabId)
  }

  /** new lines of a run's journal, in order: the run's rows, and the agents they name that already run join it */
  workflowJournal(tabId: string, sessionId: string, runId: string, lines: unknown[]): void {
    if (!isRunId(runId)) return
    const t = this.runTab(tabId, sessionId)
    if (!t || t.dropped.has(runId)) return
    const r = this.runOf(t, runId)
    r.journal = [...r.journal, ...lines].slice(-MAX_JOURNAL_LINES)
    r.rows = foldJournal(r.journal)
    for (const a of t.agents.values()) {
      if (this.link(t, a)) this.loadMeta(tabId, a)
    }
    this.deps.onChange(tabId)
  }

  /** a run agent's task: the text of its first prompt */
  workflowTask(tabId: string, sessionId: string, runId: string, agentId: string, task: string): void {
    if (!isRunId(runId)) return
    const t = this.runTab(tabId, sessionId)
    if (!t || t.dropped.has(runId)) return
    const r = this.runOf(t, runId)
    if (r.tasks.size < MAX_RUN_AGENTS || r.tasks.has(agentId)) r.tasks.set(agentId, task)
    this.deps.onChange(tabId)
  }

  /** a run's run file was read once the run ended: its state, its time and, when the journal gave none, its rows */
  workflowEnd(tabId: string, sessionId: string, runId: string, file: RunFile): void {
    if (!isRunId(runId)) return
    const t = this.runTab(tabId, sessionId)
    if (!t || t.dropped.has(runId)) return
    const r = this.runOf(t, runId)
    if (r.run.taskId === null) r.run.taskId = file.taskId
    if (r.run.name === 'workflow' && file.name !== null) r.run.name = file.name
    r.fileRows = file.rows
    this.finish(r, file.state, file)
    this.endAgents(t, r)
    this.deps.onChange(tabId)
  }

  status(m: StatusMessage): void {
    const t = this.tab(m.tabId)
    if (t.retired.has(m.sessionId)) return
    if (t.sessionId !== m.sessionId) this.switchTo(t, m.sessionId)
    t.main = { model: m.model, effort: m.effort, context: m.context, fiveHour: m.fiveHour, sevenDay: m.sevenDay }
    if (m.remote !== undefined) this.setRemote(t, m.tabId, m.remote)
    this.deps.onChange(m.tabId)
  }

  /** a Remote Control id from a hook (`remote`): null when the session has none; a report of a retired session is dropped */
  remote(tabId: string, sessionId: string, id: string | null): void {
    const t = this.tab(tabId)
    if (t.retired.has(sessionId)) return
    if (t.sessionId === null) t.sessionId = sessionId
    else if (t.sessionId !== sessionId) return // a late hook of a previous session
    this.setRemote(t, tabId, id)
  }

  remoteId(tabId: string): string | null {
    return this.tabs.get(tabId)?.remoteId ?? null
  }

  /** the tab's Remote Control id is no longer known: its process is gone (silent, its owner has the state) */
  forgetRemote(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (t) t.remoteId = null
  }

  subagent(m: SubagentMessage): void {
    const t = this.tab(m.tabId)
    if (t.retired.has(m.sessionId)) return
    if (t.sessionId === null) t.sessionId = m.sessionId
    else if (t.sessionId !== m.sessionId) return // a late hook of a previous session
    if (m.event === 'stop') {
      t.early.delete(m.agentId)
      // a run row the journal names, now or later, reads done from this: the stop may come before the journal's line
      const fresh = !t.stopped.has(m.agentId)
      this.rememberStop(t, m.agentId)
      const named = fresh && t.runs.some((r) => r.run.state === 'running' && r.rows.agents.some((row) => row.agentId === m.agentId))
      if (t.agents.delete(m.agentId) || named) this.deps.onChange(m.tabId)
      return
    }
    if (t.agents.has(m.agentId)) return
    const info = t.early.get(m.agentId)
    t.early.delete(m.agentId)
    t.stopped.delete(m.agentId)
    const a: TrackedAgent = {
      agentId: m.agentId,
      type: m.agentType,
      description: null,
      model: info?.model ?? null,
      effort: info?.effort ?? null,
      startedAt: this.deps.now(),
      meta: null
    }
    this.link(t, a)
    this.loadMeta(m.tabId, a)
    t.agents.set(m.agentId, a)
    this.deps.onChange(m.tabId)
  }

  subagentInfo(tabId: string, agentId: string, info: AgentModelInfo): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    // a run agent's model·effort is kept with its run, so its row keeps it after its stop
    let inRun = false
    for (const r of t.runs) {
      if (!r.rows.agents.some((row) => row.agentId === agentId)) continue
      r.infos.set(agentId, info)
      inRun = true
    }
    const a = t.agents.get(agentId)
    if (!a) {
      t.early.set(agentId, info)
      if (inRun) this.deps.onChange(tabId)
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
    t.remoteId = null
    this.clear(t, null)
    this.deps.onChange(tabId)
  }

  /**
   * The tab starts again in another folder: its current session is retired, so a late statusLine or hook of the old
   * process is refused, and the state it showed goes, which the window hears of.
   */
  resetTab(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    if (t.sessionId !== null) t.retired.add(t.sessionId)
    t.remoteId = null
    this.clear(t, null)
    this.deps.onChange(tabId)
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  /** the login the tab's usage limits were read under is gone (a /login to another account): they go until the new one's come */
  forgetLimits(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t?.main || (t.main.fiveHour === null && t.main.sevenDay === null)) return
    t.main = { ...t.main, fiveHour: null, sevenDay: null }
    this.deps.onChange(tabId)
  }

  /** the tab's turn stopped on a usage limit, and Claude goes on after its reset (`wait`); null: it no longer waits */
  continuesAt(tabId: string, wait: LimitWait | null): void {
    const t = this.tab(tabId)
    if (t.wait?.resetsAt === wait?.resetsAt && t.wait?.goesOnAt === wait?.goesOnAt) return
    t.wait = wait
    this.deps.onChange(tabId)
  }

  get(tabId: string): StatusUpdate {
    const t = this.tabs.get(tabId)
    const agents = t ? [...t.agents.values()].map(({ agentId, type, description, model, effort, startedAt, runId }) => ({
      agentId, type, description, model, effort, startedAt, ...(runId !== undefined && this.isRunning(t, runId) ? { runId } : {})
    })) : []
    const waits = t?.wait ? { continuesAt: t.wait.resetsAt, goesOnAt: t.wait.goesOnAt } : {}
    const state = this.deps.remoteState?.(tabId) ?? null
    const runs = t && t.runs.length > 0 ? t.runs.map((r) => this.runView(t, r)) : null
    return { tabId, main: t?.main ?? null, agents, background: t ? [...t.background] : [], ...waits, ...(runs ? { runs } : {}), ...(state ? { remote: state } : {}) }
  }

  private tab(tabId: string): TabState {
    let t = this.tabs.get(tabId)
    if (!t) {
      t = { sessionId: null, main: null, agents: new Map(), early: new Map(), retired: new Set(), background: [], wait: null, remoteId: null, runs: [], stopped: new Set(), dropped: new Set() }
      this.tabs.set(tabId, t)
    }
    return t
  }

  /** the tab of a run's call: null when the session is retired or the call is a late one of a previous session */
  private runTab(tabId: string, sessionId: string): TabState | null {
    const t = this.tab(tabId)
    if (t.retired.has(sessionId)) return null
    if (t.sessionId === null) t.sessionId = sessionId
    else if (t.sessionId !== sessionId) return null
    return t
  }

  /** the tab's run with this id, made when it is new (the oldest ended run goes first when the tab is full) */
  private runOf(t: TabState, runId: string): TrackedRun {
    const known = t.runs.find((r) => r.runId === runId)
    if (known) return known
    if (t.runs.length >= MAX_RUNS) {
      const ended = t.runs.findIndex((r) => r.run.state !== 'running')
      t.runs.splice(ended === -1 ? 0 : ended, 1)
    }
    const r: TrackedRun = {
      runId,
      run: { key: runId, runId, taskId: null, name: 'workflow', state: 'running', startedAt: this.deps.now(), ms: null, phases: [], agents: [] },
      journal: [],
      rows: { phases: [], agents: [] },
      fileRows: null,
      tasks: new Map(),
      infos: new Map()
    }
    t.runs.push(r)
    return r
  }

  /** a run ends: its state, and its time from the run file when it has one, else from the clock since it started */
  private finish(r: TrackedRun, state: RunEnd, file: RunFile | null): void {
    r.run.state = state
    r.run.ms = file?.ms ?? this.deps.now() - (r.run.startedAt ?? this.deps.now())
  }

  /** a run ends: its tracked agents are over, the run says so, so they leave the tab's agents and their rows read done */
  private endAgents(t: TabState, r: TrackedRun): void {
    for (const a of [...t.agents.values()]) {
      if (a.runId !== r.runId) continue
      t.agents.delete(a.agentId)
      this.rememberStop(t, a.agentId)
    }
  }

  /** whether a run with this id is still running in the tab */
  private isRunning(t: TabState, runId: string): boolean {
    return t.runs.some((r) => r.runId === runId && r.run.state === 'running')
  }

  /**
   * A tracked agent that a running run's journal names (any try, whenever the hook came) is the run's agent: its
   * `runId` is set and its model·effort is kept with the run. True when it was linked now.
   */
  private link(t: TabState, a: TrackedAgent): boolean {
    if (a.runId !== undefined) return false
    const r = t.runs.find((run) => run.run.state === 'running' && run.rows.agents.some((row) => row.agentId === a.agentId))
    if (!r) return false
    a.runId = r.runId
    if (a.model !== null) r.infos.set(a.agentId, { model: a.model, effort: a.effort })
    return true
  }

  /** a run as the status shows it: its rows, and when the run has ended, its rows pass through endRun */
  private runView(t: TabState, r: TrackedRun): WorkflowRun {
    const rows = r.rows.agents.length === 0 && r.fileRows ? r.fileRows : r.rows
    const run: WorkflowRun = { ...r.run, phases: [...rows.phases], agents: rows.agents.map((row) => this.rowView(t, r, row)) }
    if (run.state === 'running') return run
    return endRun(run, run.state, run.ms)
  }

  /** a journal row with the hub's view: a tracked agent is running with its own model·effort, a stopped one is done */
  private rowView(t: TabState, r: TrackedRun, row: WorkflowAgentRow): WorkflowAgentRow {
    const id = row.agentId
    const a = id === null ? undefined : t.agents.get(id)
    const info = a ? { model: a.model, effort: a.effort } : id === null ? undefined : r.infos.get(id)
    let state = row.state
    if (a) state = 'running'
    else if (state === 'running' && id !== null && t.stopped.has(id)) state = 'done'
    return {
      ...row,
      state,
      startedAt: a ? a.startedAt : row.startedAt,
      model: info?.model ?? row.model,
      effort: info ? info.effort : row.effort,
      task: (id === null ? undefined : r.tasks.get(id)) ?? row.task
    }
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
    t.background = []
    t.runs = []
    t.stopped.clear()
    t.dropped.clear()
  }

  /** an agent's stop came: the id is kept, the last ones, so a run row the journal names later reads done */
  private rememberStop(t: TabState, agentId: string): void {
    t.stopped.delete(agentId)
    t.stopped.add(agentId)
    if (t.stopped.size > MAX_JOURNAL_LINES) t.stopped.delete(t.stopped.values().next().value as string)
  }

  /** a run a prompt dropped is kept by id, the last ones, so a late report of it is none of the status bar's */
  private rememberDropped(t: TabState, runId: string): void {
    t.dropped.delete(runId)
    t.dropped.add(runId)
    if (t.dropped.size > MAX_RUNS_DROPPED) t.dropped.delete(t.dropped.values().next().value as string)
  }

  private setRemote(t: TabState, tabId: string, id: string | null): void {
    if (t.remoteId === id) return
    const previous = t.remoteId
    t.remoteId = id
    this.deps.remoteChanged?.(tabId, id, previous)
    this.deps.onChange(tabId)
  }

  private loadMeta(tabId: string, a: TrackedAgent): void {
    if (a.meta) return
    try {
      a.meta = this.deps.readMeta(tabId, a.agentId, a.runId ?? null)
    } catch {
      a.meta = null
    }
    a.description = a.meta?.description ?? null
  }
}
