import { expect, it } from 'vitest'
import {
  endRun, foldJournal, isRunId, isWorkflowRun, parseWorkflowProgress, runEndState, runHead, runOfResult, sameRun, workflowTask,
  type WorkflowAgentRow, type WorkflowRun
} from '../../src/shared/workflow'

const agentRow = (over: object) => ({ type: 'workflow_agent', index: 0, label: 'triage-a', phaseIndex: 0, phaseTitle: 'Triage', agentId: 'a1b2', model: 'claude-haiku-5-5', state: 'progress', startedAt: 1000, queuedAt: 900, attempt: 1, promptPreview: 'Look at crash 1', ...over })
const agent = (over: Partial<WorkflowAgentRow> = {}): WorkflowAgentRow => ({ key: 'k', agentId: 'a', label: 'l', phase: 0, state: 'running', attempt: 1, model: null, effort: null, task: null, startedAt: null, ms: null, ...over })
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({ key: 'toolu_1', runId: 'wf_abcdef12', taskId: 'a1b2', name: 'fix', state: 'running', startedAt: 1000, ms: null, phases: [{ index: 0, title: 'Triage' }], agents: [], ...over })

it('turns stream rows into phases and agents', () => {
  const r = parseWorkflowProgress([{ type: 'workflow_phase', index: 0, title: 'Triage' }, agentRow({}), agentRow({ index: 1, agentId: 'c3d4', state: 'done', durationMs: 41_000, attempt: 2 })])
  expect(r).toEqual({
    phases: [{ index: 0, title: 'Triage' }],
    agents: [
      { key: '0', agentId: 'a1b2', label: 'triage-a', phase: 0, state: 'running', attempt: 1, model: 'claude-haiku-5-5', effort: null, task: 'Look at crash 1', startedAt: 1000, ms: null },
      { key: '1', agentId: 'c3d4', label: 'triage-a', phase: 0, state: 'done', attempt: 2, model: 'claude-haiku-5-5', effort: null, task: 'Look at crash 1', startedAt: 1000, ms: 41_000 },
    ],
  })
})
it('maps states: start and progress run, done is done, error failed, an unknown state runs', () => {
  const states = ['start', 'progress', 'done', 'error', 'weird'].map((state, i) => parseWorkflowProgress([agentRow({ index: i, state })])!.agents[0]!.state)
  expect(states).toEqual(['running', 'running', 'done', 'failed', 'running'])
})
it('skips unknown row types and the omitted count, and gives null for a non-array', () => {
  expect(parseWorkflowProgress([{ type: 'workflow_progress_omitted', count: 40 }])).toEqual({ phases: [], agents: [] })
  expect(parseWorkflowProgress('x')).toBeNull()
})
it('caps 200 agents, 20 phases, labels of 100 and tasks of 200 characters', () => {
  const agents = parseWorkflowProgress(Array.from({ length: 300 }, (_, i) => agentRow({ index: i, label: 'l'.repeat(300), promptPreview: 'p'.repeat(500) })))!
  expect(agents.agents).toHaveLength(200)
  expect(agents.agents[0]!.label).toHaveLength(100)
  expect(agents.agents[0]!.task).toHaveLength(200)
  const phases = parseWorkflowProgress(Array.from({ length: 30 }, (_, i) => ({ type: 'workflow_phase', index: i, title: `P${i}` })))!
  expect(phases.phases).toHaveLength(20)
})
it('drops a bad agent id and bad numbers, but keeps the row', () => {
  const r = parseWorkflowProgress([agentRow({ agentId: 'bad id!', startedAt: NaN, attempt: 0 })])!
  expect(r.agents).toHaveLength(1)
  expect(r.agents[0]).toMatchObject({ agentId: null, startedAt: null, attempt: 1 })
})
it('adds a phase an agent names when no phase row has it', () => {
  const r = parseWorkflowProgress([agentRow({ phaseIndex: 2, phaseTitle: 'Fix' })])!
  expect(r.phases).toEqual([{ index: 2, title: 'Fix' }])
  expect(r.agents[0]!.phase).toBe(2)
})
it('folds the journal: keys, attempts, results and failures', () => {
  const r = foldJournal([
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'a1', label: 'triage-a', phase: 'Triage' },
    { type: 'started', key: 'k2', agentId: 'a2', label: 'fix-b', phase: 'Fix' },
    { type: 'failed', key: 'k1', agentId: 'a1' },
    { type: 'started', key: 'k1', agentId: 'a3', label: 'triage-a', phase: 'Triage' },
    { type: 'result', key: 'k2', agentId: 'a2', result: 'ok' },
    'not an object', { type: 'started', key: 5 },
  ])
  expect(r.phases).toEqual([{ index: 0, title: 'Triage' }, { index: 1, title: 'Fix' }])
  expect(r.agents.map(a => [a.key, a.agentId, a.attempt, a.state, a.phase])).toEqual([['k1', 'a3', 2, 'running', 0], ['k2', 'a2', 1, 'done', 1]])
})
it('finds the runId and task id in a Workflow result, on any path form', () => {
  expect(runOfResult('Workflow launched.\nTask ID: w9ehhq53f\nTranscript dir: C:\\Users\\RUNNER~1\\.claude\\projects\\p\\s\\subagents\\workflows\\wf_55e3c3ec-b29')).toEqual({ runId: 'wf_55e3c3ec-b29', taskId: 'w9ehhq53f' })
  expect(runOfResult('Task ID: w1\nTranscript dir: /home/u/.claude/projects/p/s/subagents/workflows/wf_abcdef12/')).toEqual({ runId: 'wf_abcdef12', taskId: 'w1' })
  expect(runOfResult('Transcript dir: /x/wf_../etc')).toEqual({ runId: null, taskId: null })
})
it('checks a run id: wf_ and at least six of a-z, 0-9, dash, at most 64 characters', () => {
  expect(isRunId('wf_55e3c3ec-b29')).toBe(true)
  expect(isRunId('wf_ab')).toBe(false)
  expect(isRunId('WF_abcdef')).toBe(false)
  expect(isRunId(`wf_${'a'.repeat(70)}`)).toBe(false)
  expect(isRunId(5)).toBe(false)
})
it('reads a task without the harness framing', () => {
  expect(workflowTask('[Workflow harness — computed task]\n\n  Look at   crash 1\n')).toBe('Look at crash 1')
  expect(workflowTask('')).toBeNull()
  expect(workflowTask('x'.repeat(500))).toHaveLength(200)
})
it('isWorkflowRun keeps a good run, caps it, and refuses a bad one', () => {
  expect(isWorkflowRun(run({ agents: Array.from({ length: 250 }, (_, i) => agent({ key: String(i), agentId: `a${i}` })) }))?.agents).toHaveLength(200)
  expect(isWorkflowRun(run({ state: 'odd' as never }))).toBeNull()
  expect(isWorkflowRun(run({ key: '' }))).toBeNull()
  expect(isWorkflowRun(run({ runId: 'nope' }))?.runId).toBeNull()
})
it('endRun ends the running agents as failed; runHead counts and names the current phase', () => {
  const r = endRun(run({
    phases: [{ index: 0, title: 'Triage' }, { index: 1, title: 'Fix' }],
    agents: [agent({ key: '0', state: 'done', startedAt: 1000, phase: 0 }), agent({ key: '1', state: 'running', startedAt: 2000, phase: 1 }), agent({ key: '2', state: 'running', startedAt: 2000, phase: 0 })],
  }), 'stopped', 500)
  expect(r.state).toBe('stopped')
  expect(r.ms).toBe(500)
  expect(r.agents.map(a => a.state)).toEqual(['done', 'failed', 'failed'])
  expect(runHead(r)).toEqual({ phase: 'Triage', done: 1, total: 3 })
  expect(runHead(run({ phases: [], agents: [agent({ phase: null })] }))).toEqual({ phase: null, done: 0, total: 1 })
})
it('sameRun tells an unchanged run from a changed one, and a missing one', () => {
  expect(sameRun(run(), run())).toBe(true)
  expect(sameRun(run(), run({ ms: 5 }))).toBe(false)
  expect(sameRun(undefined, run())).toBe(false)
})
it('runEndState maps a task status to the run end', () => {
  expect(runEndState('completed')).toBe('done')
  expect(runEndState('failed')).toBe('failed')
  expect(runEndState('killed')).toBe('stopped')
  expect(runEndState('stopped')).toBe('stopped')
  expect(runEndState('running')).toBeNull()
})
