import { describe, expect, it } from 'vitest'
import { statusFromStatusLine } from '../../src/hook/status-line'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

// shape from code.claude.com/docs/en/statusline
const full = {
  session_id: SID,
  transcript_path: 'C:\\Users\\me\\.claude\\projects\\D--x\\s.jsonl',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'xhigh' },
  context_window: {
    total_input_tokens: 90000,
    total_output_tokens: 4000,
    context_window_size: 200000,
    used_percentage: 41.2,
    remaining_percentage: 58.8,
    current_usage: { input_tokens: 14, output_tokens: 500, cache_creation_input_tokens: 2300, cache_read_input_tokens: 80000 }
  },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1790000000 }, seven_day: { used_percentage: 41.2, resets_at: 1790500000 } }
}

describe('statusFromStatusLine', () => {
  it('maps the documented fields; context counts input tokens only', () => {
    expect(statusFromStatusLine(full, TAB)).toEqual({
      v: 1,
      type: 'status',
      tabId: TAB,
      sessionId: SID,
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      effort: 'xhigh',
      context: { usedTokens: 82314, size: 200000, usedPct: 41.2 },
      fiveHour: { usedPct: 23.5, resetsAt: 1790000000 },
      sevenDay: { usedPct: 41.2, resetsAt: 1790500000 }
    })
  })

  it('early in a session: no effort, no usage, no rate limits', () => {
    const input = { session_id: SID, model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' }, context_window: { context_window_size: 200000, used_percentage: null, current_usage: null } }
    expect(statusFromStatusLine(input, TAB)).toEqual({
      v: 1, type: 'status', tabId: TAB, sessionId: SID,
      model: { id: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
      effort: null, context: null, fiveHour: null, sevenDay: null
    })
  })

  it('computes the percentage when used_percentage is null', () => {
    const input = { ...full, context_window: { context_window_size: 200000, used_percentage: null, current_usage: { input_tokens: 50000 } } }
    expect(statusFromStatusLine(input, TAB)?.context).toEqual({ usedTokens: 50000, size: 200000, usedPct: 25 })
  })

  it('drops a limit window without resets_at and defaults displayName to the id', () => {
    const input = { ...full, model: { id: 'claude-opus-5-5' }, rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } } }
    const s = statusFromStatusLine(input, TAB)
    expect(s?.fiveHour).toBe(null)
    expect(s?.sevenDay).toBe(null)
    expect(s?.model).toEqual({ id: 'claude-opus-5-5', displayName: 'claude-opus-5-5' })
  })

  it('returns null without a session id or a model id, or for non-objects', () => {
    expect(statusFromStatusLine({ ...full, session_id: 'x' }, TAB)).toBe(null)
    expect(statusFromStatusLine({ ...full, model: {} }, TAB)).toBe(null)
    expect(statusFromStatusLine([1], TAB)).toBe(null)
    expect(statusFromStatusLine(null, TAB)).toBe(null)
  })
})
