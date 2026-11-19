import { describe, expect, it } from 'vitest'
import { StatusHub } from '../../src/main/status-hub'
import type { AgentMeta } from '../../src/main/transcript-agent-info'
import type { StatusMessage, SubagentMessage } from '../../src/shared/protocol'
import type { RemoteState } from '../../src/shared/remote-control'
import type { BackgroundTask } from '../../src/shared/types'
import type { RunFile } from '../../src/main/workflow-files'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const TAB2 = '1c9f9d2f-4a8b-4d52-8e1b-3c7a2b8f0d22'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '6e3d2c8b-9f5a-4b4c-a2d3-e4f5a6b7c8d9'

const status = (over: Partial<StatusMessage> = {}): StatusMessage => ({
  v: 1, type: 'status', tabId: TAB, sessionId: SID,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null, sevenDay: null,
  ...over
})
const sub = (event: 'start' | 'stop', agentId: string, over: Partial<SubagentMessage> = {}): SubagentMessage => ({
  v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event, agentId, agentType: 'Explore', ...over
})

function makeHub(meta: Record<string, AgentMeta> = {}) {
  let now = 1000
  const changes: string[] = []
  const hub = new StatusHub({ now: () => now, readMeta: (_tab, id) => meta[id] ?? null, onChange: (t) => changes.push(t) })
  return { hub, changes, meta, tick: (ms: number) => { now += ms } }
}
const meta = (description: string): AgentMeta => ({ description, toolUseId: null, background: false })

const task = (id: string, description: string | null = 'build'): BackgroundTask => ({ id, type: 'shell', description, command: 'make' })
/** background work of a kind, as Claude Code names it in a Stop's background_tasks */
const work = (id: string, type: string): BackgroundTask => ({ id, type, description: null, command: null })

/** a hub whose remoteChanged records [tabId, id, previous] and whose remoteState answers `state` */
function rcHub() {
  const told: [string, string | null, string | null][] = []
  const changes: string[] = []
  const box: { state: RemoteState | null } = { state: { kind: 'off' } }
  const hub = new StatusHub({ now: () => 1000, readMeta: () => null, onChange: (t) => changes.push(t), remoteChanged: (t, id, prev) => told.push([t, id, prev]), remoteState: () => box.state })
  return { hub, told, changes, box }
}

describe('StatusHub: the Remote Control id', () => {
  it('a status and the hooks’ reports keep the last id; only a change is told, and the window hears of it', () => {
    const { hub, told, changes } = rcHub()
    hub.status(status({ remote: 'session_a' }))
    hub.remote(TAB, SID, 'session_a')
    changes.length = 0
    hub.remote(TAB, SID, null)
    expect(told).toEqual([[TAB, 'session_a', null], [TAB, null, 'session_a']])
    expect(hub.remoteId(TAB)).toBeNull()
    expect(changes).toEqual([TAB])
  })
  it('a status without the field (a chat tab, an older hook) leaves the id as it was', () => {
    const { hub } = rcHub()
    hub.remote(TAB, SID, 'session_a')
    hub.status(status())
    expect(hub.remoteId(TAB)).toBe('session_a')
  })
  it('a report of a retired session is dropped', () => {
    const { hub } = rcHub()
    hub.session(TAB, SID, 'startup')
    hub.session(TAB, SID2, 'clear')
    hub.remote(TAB, SID, 'session_old')
    expect(hub.remoteId(TAB)).toBeNull()
  })
  it('a new session in the same process keeps the id; the end of the session, a reset and forgetRemote clear it without telling', () => {
    const { hub, told } = rcHub()
    hub.session(TAB, SID, 'startup')
    hub.remote(TAB, SID, 'session_a')
    hub.session(TAB, SID2, 'clear')
    expect(hub.remoteId(TAB)).toBe('session_a')
    hub.sessionEnd(TAB, SID2)
    expect(hub.remoteId(TAB)).toBeNull()
    hub.session(TAB, SID2, 'resume')
    hub.remote(TAB, SID2, 'session_b')
    hub.resetTab(TAB)
    expect(hub.remoteId(TAB)).toBeNull()
    hub.session(TAB, SID2, 'resume')
    hub.remote(TAB, SID2, 'session_c')
    hub.forgetRemote(TAB)
    expect(hub.remoteId(TAB)).toBeNull()
    expect(told.map((c) => c[1])).toEqual(['session_a', 'session_b', 'session_c'])
  })
  it('get carries the state remoteState gives, and nothing when it gives null', () => {
    const { hub, box } = rcHub()
    expect(hub.get(TAB).remote).toEqual({ kind: 'off' })
    box.state = null
    expect('remote' in hub.get(TAB)).toBe(false)
  })
})

describe('StatusHub', () => {
  it('forgetting the limits of a tab clears both and keeps the rest of its status; a tab without limits hears of nothing', () => {
    const { hub, changes } = makeHub()
    hub.status(status({ fiveHour: { usedPct: 81, resetsAt: 1_895_000_000 }, sevenDay: { usedPct: 1, resetsAt: 1_895_176_000 } }))
    changes.length = 0
    hub.forgetLimits(TAB)
    expect(changes).toEqual([TAB])
    expect(hub.get(TAB).main).toEqual({ model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null, sevenDay: null })
    hub.forgetLimits(TAB)
    hub.forgetLimits(TAB2)
    expect(changes).toEqual([TAB])
    expect(hub.get(TAB2).main).toBeNull()
  })

  it('a task dropped after its stop is gone for good: a later status brings no trace of it', () => {
    const { hub, changes } = makeHub()
    hub.background(TAB, SID, [task('a'), task('b')])
    changes.length = 0
    hub.dropBackground(TAB, 'a')
    expect(changes).toEqual([TAB])
    expect(hub.get(TAB).background).toEqual([task('b')])
    hub.status(status())
    expect(hub.get(TAB).background).toEqual([task('b')])
  })

  it('status sets the main part and notifies', () => {
    const { hub, changes } = makeHub()
    hub.status(status())
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: { model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null, sevenDay: null }, agents: [], background: [] })
    expect(changes).toEqual([TAB])
  })

  it('start adds an agent with its description, stop removes it', () => {
    const { hub, changes } = makeHub({ a1: meta('Find asar users') })
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents).toEqual([{ agentId: 'a1', type: 'Explore', description: 'Find asar users', model: null, effort: null, startedAt: 1000 }])
    hub.subagent(sub('stop', 'a1'))
    expect(hub.get(TAB).agents).toEqual([])
    expect(changes).toEqual([TAB, TAB, TAB])
  })

  it('model·effort seen before the start hook is applied on start', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.subagentInfo(TAB, 'a1', { model: 'claude-sonnet-5-5', effort: 'medium' })
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  it('model·effort after start updates the agent and retries a description that was not there yet', () => {
    const { hub, meta: m } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents[0].description).toBe(null)
    m.a1 = meta('Review font fix')
    hub.subagentInfo(TAB, 'a1', { model: 'claude-opus-5-5', effort: 'high' })
    expect(hub.get(TAB).agents[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', description: 'Review font fix' })
  })

  it('a new session via status or SessionStart drops the previous main part and agents', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    hub.status(status({ sessionId: SID2 }))
    expect(hub.get(TAB).agents).toEqual([])
    hub.subagent(sub('start', 'a2', { sessionId: SID2 }))
    hub.session(TAB, SID, 'startup')
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [], background: [] })
  })

  it('late hooks of a previous session leave the new session alone', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    hub.sessionEnd(TAB, SID)
    hub.session(TAB, SID2, 'startup')
    hub.status(status({ sessionId: SID2, effort: 'low' }))
    hub.subagent(sub('start', 'a2', { sessionId: SID2 }))
    hub.subagent(sub('stop', 'a1'))
    hub.status(status())
    expect(hub.get(TAB).main?.effort).toBe('low')
    expect(hub.get(TAB).agents.map((a) => a.agentId)).toEqual(['a2'])
  })

  it('a late status of the replaced session does not take the tab back (SessionStart before SessionEnd)', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.status(status())
    hub.session(TAB, SID2, 'startup')
    hub.status(status({ sessionId: SID2, effort: 'low' }))
    hub.status(status()) // a stale statusLine run of the old session
    hub.subagent(sub('start', 'n1', { sessionId: SID2 }))
    expect(hub.get(TAB).main?.effort).toBe('low')
    expect(hub.get(TAB).agents.map((a) => a.agentId)).toEqual(['n1'])
  })

  it('a restarted claude resuming the same session drops agents of the crashed process; compaction keeps them', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    hub.session(TAB, SID, 'compact')
    expect(hub.get(TAB).agents.map((a) => a.agentId)).toEqual(['a1'])
    hub.session(TAB, SID, 'resume')
    expect(hub.get(TAB).agents).toEqual([])
    expect(hub.get(TAB).main).not.toBe(null)
  })

  it('an ended session is accepted again after it starts again (resume)', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.sessionEnd(TAB, SID)
    expect(hub.get(TAB).main).toBe(null)
    hub.session(TAB, SID, 'startup')
    hub.status(status())
    expect(hub.get(TAB).main).not.toBe(null)
  })

  it('SessionEnd clears the tab only for its current session', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.sessionEnd(TAB, SID2)
    expect(hub.get(TAB).main).not.toBe(null)
    hub.sessionEnd(TAB, SID)
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [], background: [] })
  })

  it('tabs are independent; removeTab forgets a tab', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.status(status({ tabId: TAB2, sessionId: SID2, effort: 'low' }))
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB2)).toMatchObject({ main: { effort: 'low' }, agents: [] })
    hub.removeTab(TAB)
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [], background: [] })
    expect(hub.get(TAB2).main?.effort).toBe('low')
  })

  it('stop of an unknown agent and a repeated start do not notify', () => {
    const { hub, changes } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    changes.length = 0
    hub.subagent(sub('stop', 'zz'))
    hub.subagent(sub('start', 'a1'))
    expect(changes).toEqual([])
  })

  it('keeps the background tasks a turn ended with until a later turn end lists others', () => {
    const { hub, changes } = makeHub()
    hub.status(status())
    expect(hub.get(TAB).background).toEqual([])
    hub.background(TAB, SID, [task('b1'), task('m1', null)])
    expect(hub.get(TAB).background).toEqual([task('b1'), task('m1', null)])
    hub.background(TAB, SID, [task('m1', null)])
    expect(hub.get(TAB).background).toEqual([task('m1', null)])
    hub.background(TAB, SID, [])
    expect(hub.get(TAB).background).toEqual([])
    expect(changes).toEqual([TAB, TAB, TAB, TAB])
  })

  // a subagent's SubagentStop may never come (Claude Code sends StopFailure instead for one an API error stopped): past the end
  // of a turn only background work runs agents, so a turn end that lists none that can says none runs any more
  it('a turn end whose background work runs no agent drops the agents still shown, those whose SubagentStop never came too', () => {
    const { hub, changes } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'a1', { agentType: 'workflow-subagent' }))
    hub.subagent(sub('start', 'a2'))
    changes.length = 0
    hub.background(TAB, SID, [task('b1'), work('m1', 'monitor'), work('x1', 'MCP task')])
    expect(hub.get(TAB).agents).toEqual([])
    expect(changes).toEqual([TAB])
    hub.subagent(sub('start', 'a3'))
    hub.background(TAB, SID, [])
    expect(hub.get(TAB).agents).toEqual([])
  })

  it('a turn end that lists a running workflow, a background subagent or work of another kind keeps every agent', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'a1', { agentType: 'workflow-subagent' }))
    hub.subagent(sub('start', 'a2', { agentType: 'general-purpose' }))
    for (const tasks of [[work('w9ehhq53f', 'workflow')], [task('b1'), work('a2', 'subagent')], [work('t1', 'teammate')], [work('k1', 'a kind Claude Code adds later')]]) {
      hub.background(TAB, SID, tasks)
      expect(hub.get(TAB).agents.map((a) => a.agentId)).toEqual(['a1', 'a2'])
    }
  })

  it('a new claude process, another session or the end of the session drops the background tasks; a late report of an ended session is ignored', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.background(TAB, SID, [task('b1')])
    // background shells end with the process that started them
    hub.session(TAB, SID, 'resume')
    expect(hub.get(TAB).background).toEqual([])
    hub.background(TAB, SID, [task('b1')])
    hub.session(TAB, SID, 'compact')
    expect(hub.get(TAB).background).toEqual([task('b1')])
    hub.session(TAB, SID2, 'clear')
    expect(hub.get(TAB).background).toEqual([])
    hub.background(TAB, SID, [task('late')])
    expect(hub.get(TAB).background).toEqual([])
    hub.background(TAB, SID2, [task('b2')])
    hub.sessionEnd(TAB, SID2)
    expect(hub.get(TAB).background).toEqual([])
  })

  it('a throwing readMeta leaves the description empty', () => {
    const hub = new StatusHub({ now: () => 0, readMeta: () => { throw new Error('io') }, onChange: () => {} })
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents[0].description).toBe(null)
  })
})

describe('StatusHub.resetTab (fix 1, I3)', () => {
  it("a reset clears the state and sends it; the old session's late statusLine is refused, the new session's is taken", () => {
    const { hub, changes } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.status(status())
    hub.background(TAB, SID, [task('b1')])
    changes.length = 0
    hub.resetTab(TAB)
    expect(changes).toEqual([TAB])
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [], background: [] })
    hub.status(status({ sessionId: SID, model: { id: 'old', displayName: 'Old' } }))
    expect(hub.get(TAB).main).toBeNull()
    hub.status(status({ sessionId: SID2, model: { id: 'new', displayName: 'New' } }))
    expect(hub.get(TAB).main?.model.displayName).toBe('New')
  })
})

describe('StatusHub.continuesAt', () => {
  it('a tab waiting to go on after a usage limit says the reset and when Claude goes on, and stops saying it when the wait ends; each change is sent once', () => {
    const { hub, changes } = makeHub()
    const wait = { resetsAt: 1_800_000_000_000, goesOnAt: 1_800_000_060_000 }
    hub.continuesAt(TAB, wait)
    hub.continuesAt(TAB, { ...wait })
    expect(hub.get(TAB)).toMatchObject({ continuesAt: wait.resetsAt, goesOnAt: wait.goesOnAt })
    hub.continuesAt(TAB, null)
    expect(hub.get(TAB).continuesAt).toBeUndefined()
    expect(hub.get(TAB).goesOnAt).toBeUndefined()
    expect(changes).toEqual([TAB, TAB])
  })
})

describe('StatusHub: the runs of a tab', () => {
  const RUN = 'wf_55e3c3ec-b29'
  const RUN2 = 'wf_9a8b7c6d-e0f'
  const started = (key: string, agentId: string, phase = 'Triage') => ({ type: 'started', key, agentId, label: `agent ${key}`, phase })
  const runFile = (over: Partial<RunFile> = {}): RunFile => ({ taskId: null, name: null, state: 'done', startedAt: null, ms: null, rows: null, ...over })

  it('a run built from the journal groups its hook agents, which show once', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1'), started('k2', 'a2')])
    expect(hub.get(TAB).runs?.[0]).toMatchObject({ key: RUN, runId: RUN, name: 'workflow', state: 'running' })
    hub.workflowRun(TAB, SID, { runId: RUN, name: 'crash-triage', taskId: 'w9ehhq53f' })
    hub.subagent(sub('start', 'a1'))
    hub.subagent(sub('start', 'a2'))
    const update = hub.get(TAB)
    expect(update.runs).toHaveLength(1)
    expect(update.runs?.[0]).toMatchObject({ key: RUN, runId: RUN, name: 'crash-triage', phases: [{ index: 0, title: 'Triage' }] })
    expect(update.runs?.[0].agents.map((a) => [a.agentId, a.state])).toEqual([['a1', 'running'], ['a2', 'running']])
    expect(update.agents.map((a) => [a.agentId, a.runId])).toEqual([['a1', RUN], ['a2', RUN]])
  })

  it('a run agent the hook stopped is done unless the journal says failed', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1'), started('k2', 'a2'), { type: 'failed', key: 'k2' }])
    hub.subagent(sub('start', 'a1'))
    hub.subagent(sub('start', 'a2'))
    hub.subagent(sub('stop', 'a1'))
    hub.subagent(sub('stop', 'a2'))
    expect(hub.get(TAB).runs?.[0].agents.map((a) => [a.key, a.state])).toEqual([['k1', 'done'], ['k2', 'failed']])
    expect(hub.get(TAB).agents).toEqual([])
  })

  it("the task becomes the row's task", () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    hub.workflowTask(TAB, SID, RUN, 'a1', 'Look at crash 1')
    expect(hub.get(TAB).runs?.[0].agents[0]).toMatchObject({ agentId: 'a1', task: 'Look at crash 1' })
  })

  it('subagentInfo gives a run row its model, also after its stop', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1'), started('k2', 'a2')])
    hub.subagent(sub('start', 'a1'))
    hub.subagentInfo(TAB, 'a1', { model: 'claude-haiku-5-5', effort: 'low' })
    hub.subagentInfo(TAB, 'a2', { model: 'claude-sonnet-5-5', effort: null })
    const rows = () => hub.get(TAB).runs?.[0].agents ?? []
    expect(rows()[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low', state: 'running' })
    expect(rows()[1]).toMatchObject({ model: 'claude-sonnet-5-5', state: 'running' })
    hub.subagent(sub('stop', 'a1'))
    expect(rows()[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low', state: 'done' })
  })

  it('a finished run is kept until the next prompt, and goes with a session switch, end, restart or reset', () => {
    const ended = (): StatusHub => {
      const { hub } = makeHub()
      hub.session(TAB, SID, 'startup')
      hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
      hub.workflowEnd(TAB, SID, RUN, runFile({ state: 'done' }))
      return hub
    }
    const hub = ended()
    expect(hub.get(TAB).runs?.[0].state).toBe('done')
    expect(hub.get(TAB).agents).toEqual([])
    const ways: [string, (h: StatusHub) => void][] = [
      ['a prompt', (h) => h.turn(TAB, SID)],
      ['another session', (h) => h.session(TAB, SID2, 'startup')],
      ['a restart', (h) => h.session(TAB, SID, 'resume')],
      ['the end', (h) => h.sessionEnd(TAB, SID)],
      ['a reset', (h) => h.resetTab(TAB)]
    ]
    for (const [name, leave] of ways) {
      const h = ended()
      leave(h)
      expect(h.get(TAB).runs, name).toBeUndefined()
    }
  })

  it('a turn end ends a run whose task it no longer lists, and one with no task id when no workflow task is listed', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowRun(TAB, SID, { runId: RUN, name: 'crash-triage', taskId: 'w9ehhq53f' })
    hub.background(TAB, SID, [work('w9ehhq53f', 'workflow')])
    expect(hub.get(TAB).runs?.[0].state).toBe('running')
    hub.background(TAB, SID, [])
    expect(hub.get(TAB).runs?.[0].state).toBe('stopped')

    const noTask = makeHub().hub
    noTask.session(TAB, SID, 'startup')
    noTask.workflowJournal(TAB, SID, RUN2, [started('k1', 'a1')])
    noTask.background(TAB, SID, [work('w1', 'workflow')])
    expect(noTask.get(TAB).runs?.[0].state).toBe('running')
    noTask.background(TAB, SID, [task('b1')])
    expect(noTask.get(TAB).runs?.[0].state).toBe('stopped')
  })

  it('an agent that starts again after its run ended is a bare row', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    hub.subagent(sub('start', 'a1'))
    hub.workflowEnd(TAB, SID, RUN, runFile())
    hub.subagent(sub('stop', 'a1'))
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents).toHaveLength(1)
    expect(hub.get(TAB).agents[0]).not.toHaveProperty('runId')
  })

  it('with no journal, the agents stay bare rows and the run shows its head only', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowRun(TAB, SID, { runId: RUN, name: 'crash-triage', taskId: 'w9ehhq53f' })
    hub.subagent(sub('start', 'a1'))
    const update = hub.get(TAB)
    expect(update.runs?.[0]).toMatchObject({ name: 'crash-triage', state: 'running', agents: [] })
    expect(update.agents[0]).not.toHaveProperty('runId')
  })

  it('get() has no runs field while the tab has none', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.status(status())
    expect('runs' in hub.get(TAB)).toBe(false)
    hub.workflowRun(TAB, SID, { runId: RUN, name: 'crash-triage', taskId: 'w9ehhq53f' })
    expect('runs' in hub.get(TAB)).toBe(true)
  })

  it('a run call of a retired session or of a previous one is dropped', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.session(TAB, SID2, 'clear')
    hub.workflowRun(TAB, SID, { runId: RUN, name: 'old', taskId: 'w9ehhq53f' })
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    expect(hub.get(TAB).runs).toBeUndefined()
    hub.workflowRun(TAB, SID2, { runId: RUN, name: 'new', taskId: 'w9ehhq53f' })
    expect(hub.get(TAB).runs?.[0].name).toBe('new')
  })

  it("a run agent's meta is read from its run folder, a bare agent's from the session's", () => {
    const seen: [string, string | null][] = []
    const hub = new StatusHub({ now: () => 1000, readMeta: (_t, id, runId) => { seen.push([id, runId]); return null }, onChange: () => {} })
    hub.session(TAB, SID, 'startup')
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    hub.subagent(sub('start', 'a1'))
    hub.subagent(sub('start', 'a9'))
    expect(seen).toEqual([['a1', RUN], ['a9', null]])
  })

  it('at most 8 runs per tab: the oldest ended one goes first', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    const id = (i: number) => `wf_run${i}0000`
    for (let i = 0; i < 8; i++) hub.workflowRun(TAB, SID, { runId: id(i), name: `r${i}`, taskId: `t${i}` })
    hub.workflowEnd(TAB, SID, id(1), runFile())
    hub.workflowRun(TAB, SID, { runId: id(8), name: 'r8', taskId: 't8' })
    expect(hub.get(TAB).runs?.map((r) => r.key)).toEqual([0, 2, 3, 4, 5, 6, 7, 8].map(id))
    hub.workflowRun(TAB, SID, { runId: id(9), name: 'r9', taskId: 't9' })
    expect(hub.get(TAB).runs?.map((r) => r.key)).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map(id))
  })

  it('a run that ends takes its tracked agents with it: their hooks came, the run says they are over, so no bare running row is left', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1'), started('k2', 'a2')])
    hub.subagent(sub('start', 'a1'))
    hub.subagent(sub('start', 'a2'))
    hub.workflowEnd(TAB, SID, RUN, runFile())
    expect(hub.get(TAB).agents).toEqual([])
    expect(hub.get(TAB).runs?.[0].agents.map((a) => [a.agentId, a.state])).toEqual([['a1', 'done'], ['a2', 'done']])
  })

  it('a turn end that stops a run takes its tracked agents with it, though the turn end keeps agents of other work', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowRun(TAB, SID, { runId: RUN, name: 'crash-triage', taskId: 'w9ehhq53f' })
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1'), started('k2', 'a2')])
    hub.subagent(sub('start', 'a1'))
    hub.subagent(sub('start', 'a2'))
    // a background subagent is listed, so the agents are kept; the workflow is not, so the run is stopped
    hub.background(TAB, SID, [work('b9', 'subagent')])
    expect(hub.get(TAB).runs?.[0].state).toBe('stopped')
    expect(hub.get(TAB).agents).toEqual([])
    expect(hub.get(TAB).runs?.[0].agents.map((a) => [a.agentId, a.state])).toEqual([['a1', 'done'], ['a2', 'done']])
  })

  it('a run the next prompt dropped is not brought back by a late run file or journal of it', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    hub.workflowEnd(TAB, SID, RUN, runFile())
    hub.turn(TAB, SID)
    expect(hub.get(TAB).runs).toBeUndefined()
    // the run file is read late, and a journal line of the run comes after it
    hub.workflowEnd(TAB, SID, RUN, runFile())
    expect(hub.get(TAB).runs).toBeUndefined()
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    expect(hub.get(TAB).runs).toBeUndefined()
  })
})

describe('StatusHub: the runs, whatever order the hooks and the transcript come in', () => {
  const RUN = 'wf_55e3c3ec-b29'
  const started = (key: string, agentId: string) => ({ type: 'started', key, agentId, label: `agent ${key}`, phase: 'Triage' })

  it('a SubagentStart before the journal names the agent links it once the journal does', () => {
    const { hub, tick } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.subagent(sub('start', 'a1'))
    tick(500)
    hub.workflowRun(TAB, SID, { runId: RUN, name: 'crash-triage', taskId: 'w9ehhq53f' })
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    const update = hub.get(TAB)
    expect(update.agents.map((a) => [a.agentId, a.runId])).toEqual([['a1', RUN]])
    expect(update.runs?.[0].agents.map((a) => [a.agentId, a.state])).toEqual([['a1', 'running']])
  })

  it('a SubagentStop before the journal names the agent leaves its row done', () => {
    const { hub, tick } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.subagent(sub('start', 'a1'))
    hub.subagent(sub('stop', 'a1'))
    tick(500)
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    expect(hub.get(TAB).agents).toEqual([])
    expect(hub.get(TAB).runs?.[0].agents.map((a) => [a.agentId, a.state])).toEqual([['a1', 'done']])
  })

  it('agents the turn end dropped stay done in their run, and the run ends stopped when its task is no longer listed', () => {
    const { hub, tick } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowRun(TAB, SID, { runId: RUN, name: 'crash-triage', taskId: 'w9ehhq53f' })
    hub.workflowJournal(TAB, SID, RUN, [started('k1', 'a1')])
    hub.subagent(sub('start', 'a1'))
    tick(500)
    hub.background(TAB, SID, [task('b1')])
    expect(hub.get(TAB).agents).toEqual([])
    expect(hub.get(TAB).runs?.[0]).toMatchObject({ state: 'stopped' })
    expect(hub.get(TAB).runs?.[0].agents.map((a) => a.state)).toEqual(['done'])
  })

  it('a run call with a run id that is not a run id is dropped', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID, 'startup')
    hub.workflowRun(TAB, SID, { runId: '../evil', name: 'x', taskId: 'w9ehhq53f' })
    hub.workflowJournal(TAB, SID, '../evil', [started('k1', 'a1')])
    expect(hub.get(TAB).runs).toBeUndefined()
  })
})
