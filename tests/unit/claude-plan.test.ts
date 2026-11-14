import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeAccountFile, loginOf, planName, planOf } from '../../src/main/claude-plan'

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

describe('loginOf', () => {
  const login = (oauthAccount: unknown, more: object = {}): string => JSON.stringify({ numStartups: 3, ...more, oauthAccount })

  it('changes with the account or the organization of the login, and with nothing else the file holds', () => {
    const first = loginOf(login({ accountUuid: 'acc-1', organizationUuid: 'org-1', organizationType: 'claude_pro' }))
    expect(first).toEqual(expect.any(String))
    expect(loginOf(login({ accountUuid: 'acc-1', organizationUuid: 'org-1', organizationType: 'claude_pro' }, { numStartups: 4, tipsHistory: { a: 1 } }))).toBe(first)
    expect(loginOf(login({ accountUuid: 'acc-2', organizationUuid: 'org-1' }))).not.toBe(first)
    expect(loginOf(login({ accountUuid: 'acc-1', organizationUuid: 'org-2' }))).not.toBe(first)
  })

  it('is null for a file with no login, and undefined for text it cannot read as Claude Code settings', () => {
    expect(loginOf(JSON.stringify({ numStartups: 3 }))).toBeNull()
    expect(loginOf(login(null))).toBeNull()
    expect(loginOf(login({}))).toBeNull()
    expect(loginOf(login([1, 2]))).toBeNull()
    expect(loginOf('{ "numStartups": 3, "oauthAcc')).toBeUndefined()
    expect(loginOf(JSON.stringify([1, 2]))).toBeUndefined()
  })
})

describe('planOf', () => {
  it('names the plans of both spellings', () => {
    expect(planOf('claude_max')).toBe('Max plan')
    expect(planOf('max')).toBe('Max plan')
    expect(planOf('pro')).toBe('Pro plan')
    expect(planOf('claude_team')).toBe('Team plan')
    expect(planOf('enterprise')).toBe('Enterprise plan')
    expect(planOf('something_new')).toBeNull()
    expect(planOf(42)).toBeNull()
    expect(planOf(undefined)).toBeNull()
  })
})

describe('claudeAccountFile', () => {
  it('is .claude.json in the home folder, or in CLAUDE_CONFIG_DIR when that is set', () => {
    expect(claudeAccountFile({}, join('h', 'sam'))).toBe(join('h', 'sam', '.claude.json'))
    expect(claudeAccountFile({ CLAUDE_CONFIG_DIR: join('c', 'cfg') }, join('h', 'sam'))).toBe(join('c', 'cfg', '.claude.json'))
    expect(claudeAccountFile({ CLAUDE_CONFIG_DIR: '' }, join('h', 'sam'))).toBe(join('h', 'sam', '.claude.json'))
  })
})
