import { describe, expect, it } from 'vitest'
import { accountLaunch, AccountStore, checkAccountName, checkToken, electronVault, parseAccounts, tokenEnv, type AccountFile, type Vault } from '../../src/main/accounts'

const TOKEN = 'test-token-personal-0000001'
const TOKEN2 = 'test-token-replaced-0000002'

/** "encrypts" by reversing, so a failure still shows what was stored; `garbage` decrypts to bytes that are no token */
function fakeVault(available = true): Vault & { broken: boolean; garbage: boolean } {
  const v = {
    broken: false,
    garbage: false,
    available: () => available,
    encrypt: (t: string) => `enc:${[...t].reverse().join('')}`,
    decrypt: (d: string) => {
      if (v.broken || !d.startsWith('enc:')) throw new Error('cannot decrypt')
      return v.garbage ? '\u0000\u0001' : [...d.slice(4)].reverse().join('')
    }
  }
  return v
}

function memFile(text: string | null = null): AccountFile & { text: string | null; aside: string | null; fail: boolean } {
  const f = {
    text,
    aside: null as string | null,
    fail: false,
    read: () => f.text,
    write: (t: string) => {
      if (f.fail) throw new Error('disk full')
      f.text = t
    },
    moveAside: () => {
      f.aside = f.text
      f.text = null
    }
  }
  return f
}

let ids = 0
const newStore = (file = memFile(), vault: Vault = fakeVault()): AccountStore =>
  new AccountStore(file, vault, { now: () => new Date('2026-10-14T10:00:00.000Z'), newId: () => `id-${++ids}` })

describe('checkAccountName', () => {
  it('trims and accepts a name of 1 to 40 characters', () => {
    expect(checkAccountName('  Personal ', [])).toEqual({ ok: true, value: 'Personal' })
    expect(checkAccountName('x'.repeat(40), [])).toEqual({ ok: true, value: 'x'.repeat(40) })
  })

  it('refuses an empty, long, reserved, taken or control-character name', () => {
    expect(checkAccountName('   ', [])).toEqual({ ok: false, error: 'Enter a name' })
    expect(checkAccountName(5, [])).toEqual({ ok: false, error: 'Enter a name' })
    expect(checkAccountName('x'.repeat(41), [])).toEqual({ ok: false, error: 'A name is at most 40 characters' })
    expect(checkAccountName('main ACCOUNT', [])).toEqual({ ok: false, error: '"Main account" is your normal Claude Code login; choose another name' })
    expect(checkAccountName('work', ['Work'])).toEqual({ ok: false, error: 'An account named "work" already exists' })
    expect(checkAccountName('a\u0007b', [])).toEqual({ ok: false, error: 'A name cannot hold control characters' })
  })
})

describe('checkToken', () => {
  it('drops whitespace, so a token copied across a wrapped line still works', () => {
    expect(checkToken(`  test-token-personal-\r\n  0000001 `)).toEqual({ ok: true, value: TOKEN })
  })

  it('refuses what is not a token, without repeating it', () => {
    expect(checkToken('')).toEqual({ ok: false, error: 'Paste the token from claude setup-token' })
    expect(checkToken(null)).toEqual({ ok: false, error: 'Paste the token from claude setup-token' })
    expect(checkToken('short')).toEqual({ ok: false, error: 'This is not a whole token' })
    expect(checkToken('x'.repeat(501))).toEqual({ ok: false, error: 'This is not a whole token' })
    expect(checkToken('токен-токен-токен-токен')).toEqual({ ok: false, error: 'This is not a token: it holds characters a token does not have' })
  })
})

describe('parseAccounts', () => {
  it('reads the accounts and leaves out entries of the wrong shape and repeated ids', () => {
    const text = JSON.stringify({
      version: 1,
      accounts: [
        { id: 'a', name: 'Work', addedAt: '2026-10-01T00:00:00.000Z', token: TOKEN, encrypted: false },
        { id: 'a', name: 'Again', addedAt: '2026-10-01T00:00:00.000Z', token: TOKEN, encrypted: false },
        { id: 'b', name: 'No token', addedAt: '2026-10-01T00:00:00.000Z', encrypted: false },
        { id: '', name: 'No id', addedAt: '2026-10-01T00:00:00.000Z', token: TOKEN, encrypted: false },
        'junk'
      ]
    })
    expect(parseAccounts(text)).toEqual([{ id: 'a', name: 'Work', addedAt: '2026-10-01T00:00:00.000Z', token: TOKEN, encrypted: false }])
  })

  it('is null for a file that is not an accounts file', () => {
    expect(parseAccounts('{')).toBeNull()
    expect(parseAccounts(JSON.stringify({ version: 2, accounts: [] }))).toBeNull()
    expect(parseAccounts(JSON.stringify([]))).toBeNull()
  })
})

describe('AccountStore', () => {
  it('keeps an added account encrypted and lists it without its token', () => {
    const file = memFile()
    const store = newStore(file)
    expect(store.add('Personal', TOKEN)).toEqual({ ok: true })
    const [a] = store.list()
    expect(a).toEqual({ id: expect.any(String), name: 'Personal', addedAt: '2026-10-14T10:00:00.000Z', readable: true })
    expect(JSON.stringify(store.list())).not.toContain(TOKEN)
    expect(file.text).not.toContain(TOKEN)
    expect(JSON.parse(file.text!).accounts[0]).toMatchObject({ name: 'Personal', encrypted: true })
    expect(store.token(a.id)).toBe(TOKEN)
    expect(store.nameOf(a.id)).toBe('Personal')
    // a new start reads it back
    expect(newStore(file).token(a.id)).toBe(TOKEN)
  })

  it('saves a pasted token without the line breaks it was copied with', () => {
    const store = newStore()
    expect(store.add('Personal', 'test-token-personal-\n0000001')).toEqual({ ok: true })
    expect(store.token(store.list()[0].id)).toBe(TOKEN)
  })

  it('stores the token as it is when the system has no keyring', () => {
    const file = memFile()
    const store = newStore(file, fakeVault(false))
    store.add('Personal', TOKEN)
    expect(store.keyring()).toBe(false)
    expect(JSON.parse(file.text!).accounts[0]).toMatchObject({ token: TOKEN, encrypted: false })
    expect(store.token(store.list()[0].id)).toBe(TOKEN)
  })

  it('renames an account, refusing a name another account has', () => {
    const store = newStore()
    store.add('Work', TOKEN)
    store.add('Home', TOKEN2)
    const [work] = store.list()
    expect(store.rename(work.id, 'home')).toEqual({ ok: false, error: 'An account named "home" already exists' })
    expect(store.rename(work.id, 'WORK')).toEqual({ ok: true })
    expect(store.list().map((a) => a.name)).toEqual(['WORK', 'Home'])
    expect(store.rename('nope', 'Other')).toEqual({ ok: false, error: 'No such account' })
    expect(store.rename(7, 'Other')).toEqual({ ok: false, error: 'No such account' })
  })

  it('replaces a token and its date, and removes an account', () => {
    let now = new Date('2026-10-14T10:00:00.000Z')
    const store = new AccountStore(memFile(), fakeVault(), { now: () => now, newId: () => 'one' })
    store.add('Work', TOKEN)
    now = new Date('2027-01-02T10:00:00.000Z')
    expect(store.setToken('one', TOKEN2)).toEqual({ ok: true })
    expect(store.token('one')).toBe(TOKEN2)
    expect(store.list()[0].addedAt).toBe('2027-01-02T10:00:00.000Z')
    expect(store.setToken('one', 'short')).toEqual({ ok: false, error: 'This is not a whole token' })
    expect(store.remove('one')).toEqual({ ok: true })
    expect(store.list()).toEqual([])
    expect(store.token('one')).toBeNull()
    expect(store.remove('one')).toEqual({ ok: false, error: 'No such account' })
  })

  it('marks a token that cannot be decrypted, or that decrypts to something else, as unreadable', () => {
    const file = memFile()
    newStore(file).add('Work', TOKEN)
    const broken = fakeVault()
    broken.broken = true
    const a = newStore(file, broken)
    expect(a.list()[0].readable).toBe(false)
    expect(a.token(a.list()[0].id)).toBeNull()
    const garbage = fakeVault()
    garbage.garbage = true
    const b = newStore(file, garbage)
    expect(b.list()[0].readable).toBe(false)
    expect(b.token(b.list()[0].id)).toBeNull()
  })

  it('starts empty from a broken file and keeps it aside on the first change', () => {
    const file = memFile('not json')
    const errors: string[] = []
    const store = new AccountStore(file, fakeVault(), { onError: (m) => errors.push(m) })
    expect(store.list()).toEqual([])
    expect(errors).toEqual(['ignoring accounts.json: not an accounts file'])
    expect(store.add('Work', TOKEN)).toEqual({ ok: true })
    expect(file.aside).toBe('not json')
    expect(JSON.parse(file.text!).accounts).toHaveLength(1)
  })

  it('a failed save changes nothing and does not repeat the token', () => {
    const file = memFile()
    const store = newStore(file)
    file.fail = true
    const r = store.add('Work', TOKEN)
    expect(r).toEqual({ ok: false, error: 'Cannot save accounts.json: disk full' })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(store.list()).toEqual([])
  })
})

describe('accountLaunch', () => {
  it('gives a tab on an extra account its token and takes the API keys away', () => {
    expect(tokenEnv(TOKEN)).toEqual({ set: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, unset: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] })
    expect(accountLaunch('a', () => TOKEN)).toEqual({ account: 'a', env: tokenEnv(TOKEN), unavailable: false })
  })

  it('the main account changes nothing; an account that cannot be used falls back to it', () => {
    expect(accountLaunch(null, () => TOKEN)).toEqual({ account: null, unavailable: false })
    expect(accountLaunch('gone', () => null)).toEqual({ account: null, unavailable: true })
  })
})

describe('electronVault', () => {
  const storage = (available: boolean, backend?: string) => ({
    isEncryptionAvailable: () => available,
    encryptString: (t: string) => Buffer.from(`sealed:${t}`),
    decryptString: (b: Buffer) => b.toString().replace(/^sealed:/, ''),
    ...(backend ? { getSelectedStorageBackend: () => backend } : {})
  })

  it('encrypts through safeStorage as base64 and back', () => {
    const v = electronVault(storage(true), 'win32')
    expect(v.available()).toBe(true)
    const sealed = v.encrypt(TOKEN)
    expect(sealed).toBe(Buffer.from(`sealed:${TOKEN}`).toString('base64'))
    expect(v.decrypt(sealed)).toBe(TOKEN)
  })

  it('is not available without encryption, nor with the basic store on Linux, whose key is the same everywhere', () => {
    expect(electronVault(storage(false), 'win32').available()).toBe(false)
    expect(electronVault(storage(true, 'basic_text'), 'linux').available()).toBe(false)
    expect(electronVault(storage(true, 'gnome_libsecret'), 'linux').available()).toBe(true)
  })
})

describe('AccountStore without accounts', () => {
  it('never asks the system keyring: on Linux that could mean an unlock prompt at every start', () => {
    let asked = 0
    const vault: Vault = { available: () => { asked++; return false }, encrypt: (t) => t, decrypt: (d) => d }
    const store = new AccountStore(memFile(), vault)
    expect(store.list()).toEqual([])
    expect(store.keyring()).toBe(true)
    expect(asked).toBe(0)
    store.add('Work', TOKEN)
    expect(store.keyring()).toBe(false)
  })
})
