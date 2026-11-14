import { describe, expect, it } from 'vitest'
import { accountChoices, accountLabel, footDetail, signInAgainChoices, switchChoices, validUntil, type ChoiceAccount } from '../../src/renderer/account-items'
import type { AccountView } from '../../src/shared/accounts'

const work: AccountView = { id: 'w', name: 'Work', addedAt: '2026-10-14T10:00:00.000Z', kind: 'token', readable: true, state: null, checking: false, email: null, plan: null, folder: null }
const broken: AccountView = { id: 'b', name: 'Broken', addedAt: '2026-10-14T10:00:00.000Z', kind: 'token', readable: false, state: null, checking: false, email: null, plan: null, folder: null }
const studio: AccountView = { id: 's', name: 'Studio', addedAt: '2026-10-14T10:00:00.000Z', kind: 'login', readable: false, state: 'signed-out', checking: false, email: 'studio@example.com', plan: 'Team plan', folder: 'C:\\Users\\rim28\\accounts\\studio' }
const gone: AccountView = { id: 'g', name: 'Gone', addedAt: '2026-10-14T10:00:00.000Z', kind: 'login', readable: false, state: 'missing', checking: false, email: null, plan: null, folder: 'C:\\Users\\rim28\\accounts\\gone' }
const ready: AccountView = { id: 'r', name: 'Home', addedAt: '2026-10-14T10:00:00.000Z', kind: 'login', readable: true, state: 'ready', checking: false, email: 'home@example.com', plan: null, folder: 'C:\\Users\\rim28\\accounts\\home' }

describe('account items', () => {
  it('names a tab\'s account: the main one, an extra one, or one deleted while the tab ran', () => {
    expect(accountLabel(null, [work])).toBe('Main account')
    expect(accountLabel('w', [work])).toBe('Work')
    expect(accountLabel('gone', [work])).toBe('Removed account')
  })

  it('offers every account, the main one first, once an extra account exists; a token is named with · token and one that cannot be read is disabled', () => {
    expect(accountChoices([])).toEqual([])
    expect(accountChoices([work, broken])).toEqual([
      { label: 'Main account', account: null, disabled: false, signInAgain: false },
      { label: 'Work · token', account: 'w', disabled: false, signInAgain: false },
      { label: 'Broken · token', account: 'b', disabled: true, signInAgain: false }
    ])
  })

  it('a signed-out sign-in account offers to sign in again; a missing one is disabled; a ready one is plain', () => {
    expect(accountChoices([ready, studio, gone]).slice(1)).toEqual([
      { label: 'Home', account: 'r', disabled: false, signInAgain: false },
      { label: 'Studio (sign in again)', account: 's', disabled: false, signInAgain: true },
      { label: 'Gone', account: 'g', disabled: true, signInAgain: false }
    ])
  })

  it('a device\'s account is named as it is and enabled when it is readable', () => {
    const remote: ChoiceAccount = { id: 'd1', name: 'Desk', readable: true }
    expect(accountChoices([remote]).slice(1)).toEqual([{ label: 'Desk', account: 'd1', disabled: false, signInAgain: false }])
  })

  it('a tab can continue on every account but its own, named by its name; a signed-out one is disabled', () => {
    expect(switchChoices('w', [work]).map((c) => c.label)).toEqual(['Main account'])
    expect(switchChoices(null, [work]).map((c) => c.label)).toEqual(['Work'])
    expect(switchChoices('gone', [work]).map((c) => c.label)).toEqual(['Main account', 'Work'])
    expect(switchChoices(null, [])).toEqual([])
    expect(switchChoices(null, [ready, studio, gone, broken])).toEqual([
      { label: 'Home', account: 'r', disabled: false, signInAgain: false },
      { label: 'Studio (sign in again)', account: 's', disabled: true, signInAgain: false },
      { label: 'Gone', account: 'g', disabled: true, signInAgain: false },
      { label: 'Broken', account: 'b', disabled: true, signInAgain: false }
    ])
  })

  it('a tab on an account deleted with no extra account left can still go back to the main account', () => {
    expect(switchChoices('gone', [])).toEqual([{ label: 'Main account', account: null, disabled: false, signInAgain: false }])
  })

  it('offers to sign in again to each signed-out account', () => {
    expect(signInAgainChoices([work, ready, studio, gone])).toEqual([{ label: 'Sign in to Studio again…', account: 's' }])
    expect(signInAgainChoices([])).toEqual([])
  })

  it('a sign-in account shows its plan under its name, else the Claude Code login; a token shows Token account', () => {
    expect(footDetail(studio)).toBe('Team plan')
    expect(footDetail(ready)).toBe('Claude Code login')
    expect(footDetail(work)).toBe('Token account')
    expect(footDetail(undefined)).toBe('Claude Code login')
  })
})

describe('validUntil', () => {
  it('is a year after the token was saved', () => {
    expect(validUntil('2026-10-14T10:00:00.000Z')).toBe('14 Oct 2027')
    expect(validUntil('not a date')).toBe('unknown')
  })
})
