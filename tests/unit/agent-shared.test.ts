import { describe, expect, it } from 'vitest'
import { agentDuration, isAgentId } from '../../src/shared/chat'

describe('agent ids', () => {
  it("isAgentId takes Claude Code's ids and refuses paths and long ones", () => {
    for (const id of ['a1b2c3d4', 'task_fake_12', 'agent-X_9', 'x'.repeat(128)]) expect(isAgentId(id)).toBe(true)
    for (const id of ['', '../x', 'a\\b', 'a/b', 'a b', 'x'.repeat(129), 12, null]) expect(isAgentId(id)).toBe(false)
  })
})

describe('agentDuration', () => {
  it('shows a length as the agent header shows it, at least one second', () => {
    expect(agentDuration(400)).toBe('1s')
    expect(agentDuration(12_000)).toBe('12s')
    expect(agentDuration(72_000)).toBe('1m 12s')
    expect(agentDuration(3_605_000)).toBe('60m 05s')
  })
})
