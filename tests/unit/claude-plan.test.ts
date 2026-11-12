import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeAccountFile, planName } from '../../src/main/claude-plan'

const account = (organizationType: unknown): string => JSON.stringify({ numStartups: 3, oauthAccount: { organizationType, organizationName: 'Example Org' } })

describe('planName', () => {
  it('names the subscription of the login Claude Code keeps', () => {
    expect(planName(account('claude_max'))).toBe('Max plan')
    expect(planName(account('claude_pro'))).toBe('Pro plan')
    expect(planName(account('claude_team'))).toBe('Team plan')
    expect(planName(account('claude_enterprise'))).toBe('Enterprise plan')
  })

  it('names nothing it does not know, and survives a file that is not what it expects', () => {
    expect(planName(account('something_new'))).toBeNull()
    expect(planName(account(42))).toBeNull()
    expect(planName(JSON.stringify({ oauthAccount: null }))).toBeNull()
    expect(planName(JSON.stringify({}))).toBeNull()
    expect(planName(JSON.stringify([1, 2]))).toBeNull()
    expect(planName('{ not json')).toBeNull()
    expect(planName(null)).toBeNull()
  })
})

describe('claudeAccountFile', () => {
  it('is .claude.json in the home folder, or in CLAUDE_CONFIG_DIR when that is set', () => {
    expect(claudeAccountFile({}, join('h', 'sam'))).toBe(join('h', 'sam', '.claude.json'))
    expect(claudeAccountFile({ CLAUDE_CONFIG_DIR: join('c', 'cfg') }, join('h', 'sam'))).toBe(join('c', 'cfg', '.claude.json'))
    expect(claudeAccountFile({ CLAUDE_CONFIG_DIR: '' }, join('h', 'sam'))).toBe(join('h', 'sam', '.claude.json'))
  })
})
