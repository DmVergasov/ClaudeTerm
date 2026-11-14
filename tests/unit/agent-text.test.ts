import { describe, expect, it } from 'vitest'
import { agentStateText, EMPTY_LOST, EMPTY_RUNNING, forwardMark, OFF_EXITED, OFF_MEMBER, rowAgent, STOPPED_HINT, WRITE_HINT } from '../../src/renderer/chat/agent-text'
import type { ChatAgentInfo, ChatSubagent, ChatToolCall } from '../../src/shared/chat'

const NOW = 1_700_000_000_000
const agent = (over: Partial<ChatAgentInfo>): ChatAgentInfo => ({ id: 'agent-1', type: 'Explore', description: 'Search the sales folder', state: 'running', startedAt: NOW - 42_000, ms: null, parentId: null, ...over })

describe('rowAgent', () => {
  const sub = (id: string): ChatSubagent => ({ id, description: 'Find it', type: 'Explore', state: 'running', ms: null })
  const call = (agents: ChatSubagent[]): ChatToolCall => ({ id: 'c1', name: 'Agent', subject: 'Find it', detail: null, state: 'running', output: null, error: null, editPath: null, agents, ms: null })

  it("a call's first agent opens when its id is a valid agent id", () => {
    expect(rowAgent(call([sub('task_a'), sub('task_b')]))).toBe('task_a')
    expect(rowAgent(call([sub('x'.repeat(128))]))).toBe('x'.repeat(128))
  })

  it('a call whose agent id is not a valid agent id opens nothing', () => {
    expect(rowAgent(call([sub('../x')]))).toBeNull()
    expect(rowAgent(call([sub('a\\b')]))).toBeNull()
    expect(rowAgent(call([sub('a/../b')]))).toBeNull()
    expect(rowAgent(call([sub('x'.repeat(129))]))).toBeNull()
  })

  it('a call with no agents opens nothing', () => {
    expect(rowAgent(call([]))).toBeNull()
  })
})

describe('agentStateText', () => {
  it('counts a running agent from its start', () => {
    expect(agentStateText(agent({ state: 'running', startedAt: NOW - 42_000 }), NOW)).toBe('Running · 42s')
  })

  it('shows a running agent without a count when its start is not known', () => {
    expect(agentStateText(agent({ state: 'running', startedAt: null }), NOW)).toBe('Running')
  })

  it('shows the length of a done agent', () => {
    expect(agentStateText(agent({ state: 'done', ms: 72_000 }), NOW)).toBe('Done · 1m 12s')
  })

  it('shows done without a length when it is not known', () => {
    expect(agentStateText(agent({ state: 'done', ms: null }), NOW)).toBe('Done')
  })

  it('shows the length of a failed agent', () => {
    expect(agentStateText(agent({ state: 'failed', ms: 12_000 }), NOW)).toBe('Failed · 12s')
  })

  it('shows failed without a length when it is not known', () => {
    expect(agentStateText(agent({ state: 'failed', ms: null }), NOW)).toBe('Failed')
  })

  it('says stopped, with no length', () => {
    expect(agentStateText(agent({ state: 'stopped', ms: 5_000 }), NOW)).toBe('Stopped')
  })

  it('has the empty texts of a page with no items', () => {
    expect(EMPTY_RUNNING).toBe('Nothing yet — the agent has just started')
    expect(EMPTY_LOST).toBe("This agent's conversation was not saved")
  })
})

describe('forwardMark', () => {
  it('says a forward is queued, sending or delivered', () => {
    expect(forwardMark('queued', null)).toBe('via Claude · Queued')
    expect(forwardMark('sending', null)).toBe('via Claude · Sending…')
    expect(forwardMark('delivered', null)).toBe('via Claude · Delivered')
  })

  it('says why a failed forward was not delivered', () => {
    expect(forwardMark('failed', 'agent was cancelled')).toBe('via Claude · Not delivered: agent was cancelled')
  })

  it('says why a skipped forward was not delivered', () => {
    expect(forwardMark('skipped', 'the agent is gone')).toBe('via Claude · Not delivered: the agent is gone')
  })

  it('says Claude did not forward a skipped forward that has no reason', () => {
    expect(forwardMark('skipped', null)).toBe('via Claude · Claude did not forward it')
  })

  it('has the composer texts the page shows', () => {
    expect(WRITE_HINT).toBe('Claude forwards it with SendMessage · uses a turn of the main conversation')
    expect(STOPPED_HINT).toBe('You stopped this agent: Claude may not be able to resume it')
    expect(OFF_EXITED).toBe('Claude Code is not running in this tab')
    expect(OFF_MEMBER).toBe('Read-only on this device')
  })
})
