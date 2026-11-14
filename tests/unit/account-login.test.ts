import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNTS_ROOT_ENV,
  NO_IDENTITY,
  accountFolder,
  accountsRoot,
  checkEmail,
  clashes,
  folderSlug,
  identityOf,
  mergeIdentity,
  parseAuthStatus,
  sameLogin,
  signInCommand
} from '../../src/main/account-login'

const ORG = '0b6f3c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'

// the JSON of `claude auth status --json` when a claude.ai login is signed in (the stand-in's answer, invented values)
const SIGNED_IN = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  configDirectory: join('h', 'work'),
  email: 'work@example.com',
  orgId: ORG,
  orgName: 'Example Team',
  subscriptionType: 'team'
}

describe('accountsRoot', () => {
  const home = join('h', 'sam')
  const data = join('d', 'ClaudeTerm')

  it('is the override when one is set, else the test folder under the data folder, else the home folder', () => {
    expect(accountsRoot({ [ACCOUNTS_ROOT_ENV]: join('o', 'acc') }, home, data)).toBe(join('o', 'acc'))
    expect(accountsRoot({ [ACCOUNTS_ROOT_ENV]: '', CLAUDETERM_TEST: '1' }, home, data)).toBe(join(data, 'claude-accounts'))
    expect(accountsRoot({ CLAUDETERM_TEST: '1' }, home, data)).toBe(join(data, 'claude-accounts'))
    expect(accountsRoot({}, home, data)).toBe(join(home, '.claude-accounts'))
  })

  it('never takes its folder from CLAUDE_CONFIG_DIR', () => {
    expect(accountsRoot({ CLAUDE_CONFIG_DIR: join('c', 'cfg') }, home, data)).toBe(join(home, '.claude-accounts'))
  })
})

describe('folderSlug', () => {
  it('makes a lowercase name of a-z, 0-9 and dashes', () => {
    expect(folderSlug('Work')).toBe('work')
    expect(folderSlug('My  Work!')).toBe('my-work')
    expect(folderSlug('Café Ü')).toBe('caf')
    expect(folderSlug('--x--')).toBe('x')
  })

  it('is at most 32 characters and says "account" when nothing is left', () => {
    expect(folderSlug('a'.repeat(40))).toBe('a'.repeat(32))
    expect(folderSlug('Работа')).toBe('account')
  })

  it('adds "-account" to a Windows device name', () => {
    expect(folderSlug('CON')).toBe('con-account')
    expect(folderSlug('Com1')).toBe('com1-account')
  })
})

describe('accountFolder', () => {
  const root = join('r', 'accounts')

  it('takes the next free name', () => {
    expect(accountFolder(root, 'Work', () => false)).toBe(join(root, 'work'))
    expect(accountFolder(root, 'Work', p => p === join(root, 'work'))).toBe(join(root, 'work-2'))
    const taken = [join(root, 'work'), join(root, 'work-2')]
    expect(accountFolder(root, 'Work', p => taken.includes(p))).toBe(join(root, 'work-3'))
  })
})

describe('checkEmail', () => {
  it('reads an empty address as none', () => {
    expect(checkEmail('')).toEqual({ ok: true, value: null })
    expect(checkEmail('   ')).toEqual({ ok: true, value: null })
  })

  it('accepts an address and trims it', () => {
    expect(checkEmail('  work@example.com ')).toEqual({ ok: true, value: 'work@example.com' })
  })

  it('refuses what is not an address, with the one message', () => {
    const error = { ok: false, error: 'Enter an email address, or leave it empty' }
    for (const bad of ['a b@x', '-a@x', 'a@', '@x', 'a@b@c', 42, 'a'.repeat(255 - 12) + '@example.com']) {
      expect(checkEmail(bad)).toEqual(error)
    }
  })

  it('accepts an address of 254 characters', () => {
    expect(checkEmail('a'.repeat(254 - 12) + '@example.com').ok).toBe(true)
  })
})

describe('signInCommand', () => {
  it('quotes the email for each shell', () => {
    expect(signInCommand('claude', 'powershell', 'w@example.com')).toBe("claude auth login --claudeai --email 'w@example.com'")
    expect(signInCommand('claude', 'bash', 'w@example.com')).toBe("claude auth login --claudeai --email 'w@example.com'")
    expect(signInCommand('claude', 'cmd', 'w@example.com')).toBe('claude auth login --claudeai --email "w@example.com"')
  })

  it('has no email when none is given', () => {
    expect(signInCommand('claude', 'bash', null)).toBe('claude auth login --claudeai')
  })
})

describe('parseAuthStatus: signed in, signed out, another method, garbage, missing and wrong fields', () => {
  const signedIn = {
    state: 'signed-in',
    identity: { email: 'work@example.com', orgName: 'Example Team', orgUuid: ORG, plan: 'Team plan' }
  }

  it('reads a claude.ai login as signed in, with its identity', () => {
    expect(parseAuthStatus({ code: 0, stdout: JSON.stringify(SIGNED_IN) })).toEqual(signedIn)
  })

  it('reads a login that is not there, or another method, as signed out', () => {
    expect(parseAuthStatus({ code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) })).toEqual({ state: 'signed-out' })
    expect(parseAuthStatus({ code: 1, stdout: 'Not logged in' })).toEqual({ state: 'signed-out' })
    expect(parseAuthStatus({ code: 0, stdout: JSON.stringify({ authMethod: 'api-key' }) })).toEqual({ state: 'signed-out' })
  })

  it('says unknown for output it does not understand', () => {
    expect(parseAuthStatus({ code: 0, stdout: 'Welcome to Claude Code' }).state).toBe('unknown')
    expect(parseAuthStatus({ code: 2, stdout: JSON.stringify(SIGNED_IN) }).state).toBe('unknown')
    expect(parseAuthStatus({ code: 0, stdout: '[1, 2]' }).state).toBe('unknown')
    expect(parseAuthStatus({ code: 0, stdout: JSON.stringify({ email: 'work@example.com' }) }).state).toBe('unknown')
  })

  it('leaves out a field that is missing or of the wrong shape, and keeps the rest', () => {
    const r = parseAuthStatus({ code: 0, stdout: JSON.stringify({ ...SIGNED_IN, email: 42 }) })
    expect(r).toEqual({ state: 'signed-in', identity: { ...signedIn.identity, email: null } })
    const bare = parseAuthStatus({ code: 0, stdout: JSON.stringify({ authMethod: 'claude.ai' }) })
    expect(bare).toEqual({ state: 'signed-in', identity: NO_IDENTITY })
  })

  it('leaves out an email with no @ or too long, a name with control characters or too long', () => {
    const r = parseAuthStatus({
      code: 0,
      stdout: JSON.stringify({ ...SIGNED_IN, email: 'nobody', orgName: 'Example\u0007Team', orgId: 'x'.repeat(201) })
    })
    expect(r).toEqual({ state: 'signed-in', identity: { email: null, orgName: null, orgUuid: null, plan: 'Team plan' } })
  })

  it('reads the plan from the subscription, then from the organization type, and names no unknown one', () => {
    const plan = (fields: object): unknown => {
      const r = parseAuthStatus({ code: 0, stdout: JSON.stringify({ authMethod: 'claude.ai', ...fields }) })
      return r.state === 'signed-in' ? r.identity.plan : undefined
    }
    expect(plan({ subscriptionType: 'max' })).toBe('Max plan')
    expect(plan({ organizationType: 'claude_pro' })).toBe('Pro plan')
    expect(plan({ subscriptionType: 'something_new' })).toBeNull()
  })
})

describe('identityOf', () => {
  it('reads oauthAccount of the account file', () => {
    const text = JSON.stringify({
      numStartups: 3,
      oauthAccount: { emailAddress: 'work@example.com', organizationName: 'Example Team', organizationUuid: ORG, organizationType: 'claude_team' }
    })
    expect(identityOf(text)).toEqual({ email: 'work@example.com', orgName: 'Example Team', orgUuid: ORG, plan: 'Team plan' })
  })

  it('reads nothing but oauthAccount', () => {
    expect(identityOf(JSON.stringify({ emailAddress: 'work@example.com', oauthAccount: null }))).toEqual(NO_IDENTITY)
    expect(identityOf(null)).toEqual(NO_IDENTITY)
    expect(identityOf('{ not json')).toEqual(NO_IDENTITY)
  })
})

describe('mergeIdentity', () => {
  it("keeps the first's fields and takes the other's where the first has none", () => {
    const first = { email: 'work@example.com', orgName: null, orgUuid: null, plan: null }
    const then = { email: 'other@example.com', orgName: 'Example Team', orgUuid: ORG, plan: 'Team plan' }
    expect(mergeIdentity(first, then)).toEqual({ email: 'work@example.com', orgName: 'Example Team', orgUuid: ORG, plan: 'Team plan' })
  })
})

describe('sameLogin', () => {
  const work = { email: 'work@example.com', orgName: 'Example Team', orgUuid: ORG, plan: null }

  it('is the same login for the same email and organization', () => {
    expect(sameLogin(work, { ...work, email: 'WORK@example.com' })).toBe(true)
  })

  it('is another login when the organization is another one', () => {
    expect(sameLogin(work, { ...work, orgUuid: '7e1d2c3b-4a5f-4e6d-9c8b-7a6f5e4d3c2b' })).toBe(false)
    expect(sameLogin(work, { ...work, orgUuid: null, orgName: 'Studio' })).toBe(false)
  })

  it('compares the emails when no organization is known', () => {
    expect(sameLogin({ ...work, orgUuid: null, orgName: null }, { ...work, orgUuid: null, orgName: null })).toBe(true)
    expect(sameLogin({ ...work, orgUuid: null, orgName: null }, { ...work, email: 'other@example.com', orgUuid: null, orgName: null })).toBe(false)
    expect(sameLogin({ ...work, email: null }, { ...work, email: null })).toBe(false)
  })
})

describe('clashes', () => {
  const a = join('h', 'a')

  it('is true for the same folder, one inside another, and one holding another', () => {
    expect(clashes(a, [a])).toBe(true)
    expect(clashes(join(a, 'b'), [a])).toBe(true)
    expect(clashes(a, [join(a, 'b')])).toBe(true)
  })

  it('is false for a folder whose name only starts the same', () => {
    expect(clashes(join('h', 'ab'), [a])).toBe(false)
  })
})
