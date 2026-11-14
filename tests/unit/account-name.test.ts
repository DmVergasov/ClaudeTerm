import { describe, expect, it } from 'vitest'
import { accountNameError, MAX_ACCOUNT_NAME } from '../../src/shared/accounts'

describe('accountNameError: the rule main and the helper share', () => {
  it('accepts a name that is free', () => {
    expect(accountNameError('  Work  ', ['Studio'])).toBeNull()
  })

  it('asks for a name when it is empty or only spaces', () => {
    expect(accountNameError('   ', [])).toBe('Enter a name')
  })

  it('allows at most 40 characters', () => {
    expect(accountNameError('a'.repeat(MAX_ACCOUNT_NAME), [])).toBeNull()
    expect(accountNameError('a'.repeat(MAX_ACCOUNT_NAME + 1), [])).toBe(`A name is at most ${MAX_ACCOUNT_NAME} characters`)
  })

  it('refuses control characters', () => {
    expect(accountNameError('Wo\u0007rk', [])).toBe('A name cannot hold control characters')
  })

  it('refuses the name of Main account, in any case', () => {
    expect(accountNameError('main ACCOUNT', [])).toBe('"Main account" is your normal Claude Code login; choose another name')
  })

  it('refuses a name another account has, in any case', () => {
    expect(accountNameError('work', ['Work'])).toBe('An account named "work" already exists')
  })
})
