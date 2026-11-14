import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeAccount, type RemoveDeps } from '../../src/main/account-remove'
import type { AccountEntry } from '../../src/main/accounts'

const MAIN = join(tmpdir(), 'main-config')
const FOLDER = join(tmpdir(), 'claude-accounts', 'work')

function login(over: Partial<AccountEntry> = {}): AccountEntry {
  return { id: 'acc-1', name: 'Work', addedAt: '2026-11-01T00:00:00.000Z', kind: 'login', folder: FOLDER, created: true, readable: true, ...over }
}

function setup(over: Partial<RemoveDeps> & { found?: AccountEntry | null } = {}) {
  const calls: string[] = []
  const { found: entry, ...rest } = over
  const found = entry === undefined ? login() : entry
  const deps: RemoveDeps = {
    entry: () => found,
    tabsOn: () => 0,
    busy: () => false,
    logout: async (folder) => {
      calls.push(`logout ${folder}`)
      return null
    },
    remove: (id) => {
      calls.push(`remove ${id}`)
      return { ok: true }
    },
    changed: () => {
      calls.push('changed')
    },
    trash: async (folder) => {
      calls.push(`trash ${folder}`)
    },
    others: async () => [MAIN],
    canonical: async (p) => p,
    ...rest
  }
  return { deps, calls }
}

describe('removeAccount', () => {
  it('a sign-in account with sign-out and its folder: logout, removal, then the trash, in that order', async () => {
    const { deps, calls } = setup()
    const result = await removeAccount('acc-1', { signOut: true, deleteFolder: true }, deps)
    expect(result).toEqual({ ok: true, problems: [] })
    expect(calls).toEqual([`logout ${FOLDER}`, 'remove acc-1', 'changed', `trash ${FOLDER}`])
  })

  it('with tabs on it the folder and the sign-out are refused', async () => {
    const { deps, calls } = setup({ tabsOn: () => 2 })
    const result = await removeAccount('acc-1', { signOut: true, deleteFolder: true }, deps)
    expect(result).toEqual({ ok: false, error: 'Close the 2 tabs on Work to remove its folder too' })
    expect(calls).toEqual([])
  })

  it('one tab on the account is named in the singular', async () => {
    const { deps, calls } = setup({ tabsOn: () => 1 })
    expect(await removeAccount('acc-1', { signOut: true, deleteFolder: true }, deps)).toEqual({ ok: false, error: 'Close the 1 tab on Work to remove its folder too' })
    expect(calls).toEqual([])
  })

  it('a removal while a carry-over or a registration runs in the folder is refused, and nothing is signed out, removed or trashed', async () => {
    const { deps, calls } = setup({ busy: () => true })
    const result = await removeAccount('acc-1', { signOut: true, deleteFolder: true }, deps)
    expect(result).toEqual({ ok: false, error: 'Finish or cancel what runs for Work first' })
    expect(calls).toEqual([])
  })

  it('a folder ClaudeTerm did not make is never deleted', async () => {
    const own = setup({ found: login({ created: false }) })
    expect(await removeAccount('acc-1', { signOut: false, deleteFolder: true }, own.deps)).toEqual({ ok: true, problems: [] })
    expect(own.calls).toEqual(['remove acc-1', 'changed'])

    const clash = setup({ others: async () => [join(FOLDER, 'nested')] })
    expect(await removeAccount('acc-1', { signOut: false, deleteFolder: true }, clash.deps)).toEqual({ ok: true, problems: [] })
    expect(clash.calls.some((c) => c.startsWith('trash'))).toBe(false)

    const main = setup({ others: async () => [join(tmpdir(), 'claude-accounts')] })
    await removeAccount('acc-1', { signOut: false, deleteFolder: true }, main.deps)
    expect(main.calls.some((c) => c.startsWith('trash'))).toBe(false)
  })

  it('a failed logout or move is reported and the account is still removed', async () => {
    const { deps, calls } = setup({
      logout: async () => 'the sign-out was refused',
      trash: async () => {
        throw new Error('the folder is in use')
      }
    })
    const result = await removeAccount('acc-1', { signOut: true, deleteFolder: true }, deps)
    expect(result).toEqual({
      ok: true,
      problems: ['Could not sign out: the sign-out was refused', 'Could not move the folder to the trash: the folder is in use']
    })
    expect(calls).toContain('remove acc-1')
    expect(calls).toContain('changed')
  })

  it('a token account is removed as before', async () => {
    const { deps, calls } = setup({ found: login({ id: 'tok-1', kind: 'token', folder: null, created: false }) })
    expect(await removeAccount('tok-1', { signOut: true, deleteFolder: true }, deps)).toEqual({ ok: true, problems: [] })
    expect(calls).toEqual(['remove tok-1', 'changed'])
  })

  it('an unknown id is no such account', async () => {
    const { deps, calls } = setup({ found: null })
    expect(await removeAccount('nope', { signOut: true, deleteFolder: true }, deps)).toEqual({ ok: false, error: 'No such account' })
    expect(calls).toEqual([])
  })
})
