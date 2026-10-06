import { describe, expect, it } from 'vitest'
import { StatusHub } from '../../src/main/status-hub'
import type { AgentMeta } from '../../src/main/transcript-agent-info'
import type { StatusMessage, SubagentMessage } from '../../src/shared/protocol'

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

describe('StatusHub', () => {
  it('status sets the main part and notifies', () => {
    const { hub, changes } = makeHub()
    hub.status(status())
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: { model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null, sevenDay: null }, agents: [] })
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
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [] })
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
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [] })
  })

  it('tabs are independent; removeTab forgets a tab', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.status(status({ tabId: TAB2, sessionId: SID2, effort: 'low' }))
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB2)).toMatchObject({ main: { effort: 'low' }, agents: [] })
    hub.removeTab(TAB)
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [] })
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

  it('a throwing readMeta leaves the description empty', () => {
    const hub = new StatusHub({ now: () => 0, readMeta: () => { throw new Error('io') }, onChange: () => {} })
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents[0].description).toBe(null)
  })
})
