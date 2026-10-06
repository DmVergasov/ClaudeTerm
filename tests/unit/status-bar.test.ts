import { describe, expect, it } from 'vitest'
import { formatTokens, levelFor, modelFamily, statusSegments } from '../../src/renderer/status-bar'
import type { AgentStatus, MainStatus } from '../../src/shared/types'

const main: MainStatus = {
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 },
  fiveHour: { usedPct: 23.5, resetsAt: new Date(2026, 9, 5, 21, 40).getTime() / 1000 },
  sevenDay: { usedPct: 41.2, resetsAt: new Date(2026, 9, 9, 14, 0).getTime() / 1000 }
}
const agent = (over: Partial<AgentStatus>): AgentStatus => ({ agentId: 'a', type: 'Explore', description: null, model: 'claude-opus-5-5', effort: 'high', startedAt: 0, ...over })

describe('statusSegments', () => {
  it('formats all five segments', () => {
    const agents = [agent({ type: 'code-reviewer', description: 'Review font fix' })]
    expect(statusSegments({ tabId: 't', main, agents }, 3 * 60_000 + 5_000)).toEqual([
      { key: 'model', text: 'Opus 5.5 · xhigh', title: 'claude-opus-5-5', level: 'normal' },
      { key: 'context', text: 'ctx 41% · 82k/200k', title: '82,314 of 200,000 tokens', level: 'normal' },
      { key: 'limit', text: '5h 24%', title: 'resets at 21:40', level: 'normal' },
      { key: 'week', text: '7d 41%', title: 'resets Fri 9 Oct, 14:00', level: 'normal' },
      { key: 'agents', text: '⚙ 1: opus·high', title: 'code-reviewer · opus·high · 3 min · "Review font fix"', level: 'normal' }
    ])
  })

  it('shows only the model early in a session', () => {
    const early: MainStatus = { model: { id: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' }, effort: null, context: null, fiveHour: null, sevenDay: null }
    expect(statusSegments({ tabId: 't', main: early, agents: [] }, 0)).toEqual([{ key: 'model', text: 'Haiku 4.5', title: 'claude-haiku-4-5-20251001', level: 'normal' }])
  })

  it('returns nothing without the main status', () => {
    expect(statusSegments({ tabId: 't', main: null, agents: [agent({})] }, 0)).toEqual([])
  })

  it('marks context and the limits warn from 70% and crit from 90%', () => {
    const s = statusSegments({ tabId: 't', main: { ...main, context: { usedTokens: 1, size: 2, usedPct: 91 }, fiveHour: { usedPct: 70, resetsAt: 0 }, sevenDay: { usedPct: 90, resetsAt: 0 } }, agents: [] }, 0)
    expect(s.map((x) => x.level)).toEqual(['normal', 'crit', 'warn', 'crit'])
  })

  it('groups many agents by model·effort, most frequent first; unknown model shows …', () => {
    const agents = [
      agent({ agentId: '1', effort: 'xhigh' }),
      ...['2', '3', '4', '5', '6', '7'].map((id) => agent({ agentId: id, model: 'claude-sonnet-5-5', effort: 'medium' })),
      agent({ agentId: '8', effort: 'xhigh' }),
      agent({ agentId: '9', model: 'claude-haiku-4-5-20251001', effort: null }),
      agent({ agentId: '10', model: null, effort: null })
    ]
    expect(statusSegments({ tabId: 't', main, agents }, 0).at(-1)?.text).toBe('⚙ 10: sonnet·medium ×6, opus·xhigh ×2, haiku, …')
  })

  it('agent tooltip: under a minute, no description', () => {
    expect(statusSegments({ tabId: 't', main, agents: [agent({ startedAt: 1000 })] }, 30_000).at(-1)?.title).toBe('Explore · opus·high · <1 min')
  })
})

describe('helpers', () => {
  it('levelFor', () => {
    expect([69.9, 70, 89.9, 90].map(levelFor)).toEqual(['normal', 'warn', 'warn', 'crit'])
  })

  it('formatTokens', () => {
    expect([999, 1000, 82_314, 200_000, 999_499, 999_500, 1_000_000, 1_500_000].map(formatTokens)).toEqual(['999', '1k', '82k', '200k', '999k', '1M', '1M', '1.5M'])
  })

  it('modelFamily', () => {
    expect(['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'gpt-x'].map(modelFamily)).toEqual(['opus', 'haiku', 'gpt-x'])
  })
})
