import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assistantInfo, readAgentMeta } from '../../src/main/transcript-agent-info'
import { assistantLine, textLine, toolResultLine } from '../fixtures/transcript'

describe('assistantInfo', () => {
  it('returns model and effort of an assistant line', () => {
    expect(assistantInfo(assistantLine('claude-opus-5-5', 'xhigh'))).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
  })

  it('effort is null for models without it (Haiku)', () => {
    expect(assistantInfo(assistantLine('claude-haiku-4-5-20251001'))).toEqual({ model: 'claude-haiku-4-5-20251001', effort: null })
  })

  it('falls back to perTurnEffort', () => {
    const line = JSON.stringify({ type: 'assistant', perTurnEffort: 'high', message: { model: 'claude-sonnet-5-5' } })
    expect(assistantInfo(line)).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
  })

  it('ignores synthetic messages, lines without a model, other line types and bad JSON', () => {
    expect(assistantInfo(assistantLine('<synthetic>'))).toBe(null)
    expect(assistantInfo(textLine)).toBe(null)
    expect(assistantInfo(toolResultLine('toolu_1'))).toBe(null)
    expect(assistantInfo('{not json')).toBe(null)
  })
})

describe('readAgentMeta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-meta-'))

  it('reads description, toolUseId and background flag', () => {
    writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find asar users', toolUseId: 'toolu_1', requestShape: 'background' }))
    expect(readAgentMeta(dir, 'a1')).toEqual({ description: 'Find asar users', toolUseId: 'toolu_1', background: true })
  })

  it('truncates long descriptions and tolerates missing fields', () => {
    writeFileSync(join(dir, 'agent-a2.meta.json'), JSON.stringify({ description: 'd'.repeat(500) }))
    expect(readAgentMeta(dir, 'a2')).toEqual({ description: 'd'.repeat(200), toolUseId: null, background: false })
  })

  it('returns null for a missing or broken file', () => {
    expect(readAgentMeta(dir, 'nope')).toBe(null)
    writeFileSync(join(dir, 'agent-a3.meta.json'), '{oops')
    expect(readAgentMeta(dir, 'a3')).toBe(null)
  })
})
