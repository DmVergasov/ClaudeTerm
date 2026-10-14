import { describe, expect, it } from 'vitest'
import { accountChoices, accountLabel, switchChoices, validUntil } from '../../src/renderer/account-items'
import type { AccountView } from '../../src/shared/accounts'

const work: AccountView = { id: 'w', name: 'Work', addedAt: '2026-10-14T10:00:00.000Z', readable: true }
const broken: AccountView = { id: 'b', name: 'Broken', addedAt: '2026-10-14T10:00:00.000Z', readable: false }

describe('account items', () => {
  it('names a tab\'s account: the main one, an extra one, or one deleted while the tab ran', () => {
    expect(accountLabel(null, [work])).toBe('Main account')
    expect(accountLabel('w', [work])).toBe('Work')
    expect(accountLabel('gone', [work])).toBe('Removed account')
  })

  it('offers every account, the main one first, once an extra account exists; one that cannot be read is disabled', () => {
    expect(accountChoices([])).toEqual([])
    expect(accountChoices([work, broken])).toEqual([
      { label: 'Main account', account: null, disabled: false },
      { label: 'Work', account: 'w', disabled: false },
      { label: 'Broken', account: 'b', disabled: true }
    ])
  })

  it('a tab can continue on every account but its own', () => {
    expect(switchChoices('w', [work]).map((c) => c.label)).toEqual(['Main account'])
    expect(switchChoices(null, [work]).map((c) => c.label)).toEqual(['Work'])
    expect(switchChoices('gone', [work]).map((c) => c.label)).toEqual(['Main account', 'Work'])
    expect(switchChoices(null, [])).toEqual([])
  })

  it('a tab on an account deleted with no extra account left can still go back to the main account', () => {
    expect(switchChoices('gone', [])).toEqual([{ label: 'Main account', account: null, disabled: false }])
  })
})

describe('validUntil', () => {
  it('is a year after the token was saved', () => {
    expect(validUntil('2026-10-14T10:00:00.000Z')).toBe('14 Oct 2027')
    expect(validUntil('not a date')).toBe('unknown')
  })
})
