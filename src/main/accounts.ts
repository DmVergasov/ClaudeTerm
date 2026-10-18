import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { MAIN_ACCOUNT, type AccountResult, type AccountView } from '../shared/accounts'
import type { EnvPatch } from './child-env'

const MAX_NAME = 40
const MIN_TOKEN = 20
const MAX_TOKEN = 500
const MAX_ID = 64
const CONTROL = /[\u0000-\u001f\u007f]/

/** Encrypts tokens at rest: Electron's safeStorage in the app, a fake in the tests. */
export interface Vault {
  /** false: tokens are stored as they are (Linux without a keyring) */
  available(): boolean
  encrypt(token: string): string
  /** throws when the data cannot be decrypted here */
  decrypt(data: string): string
}

/** accounts.json */
export interface AccountFile {
  /** null: there is no file yet */
  read(): string | null
  write(text: string): void
  /** keeps a file that could not be used as accounts.json.broken */
  moveAside(): void
}

interface StoredAccount {
  id: string
  name: string
  addedAt: string
  /** the token, or with `encrypted` its encrypted form */
  token: string
  encrypted: boolean
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const NO_ACCOUNT: AccountResult = { ok: false, error: 'No such account' }

/** a name for a new or renamed account: trimmed, 1–40 characters, not "Main account" and not one of `taken`, ignoring case */
export function checkAccountName(raw: unknown, taken: readonly string[]): Checked<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a name' }
  const name = raw.trim()
  if (name.length === 0) return { ok: false, error: 'Enter a name' }
  if (name.length > MAX_NAME) return { ok: false, error: `A name is at most ${MAX_NAME} characters` }
  if (CONTROL.test(name)) return { ok: false, error: 'A name cannot hold control characters' }
  const key = name.toLowerCase()
  if (key === MAIN_ACCOUNT.toLowerCase()) return { ok: false, error: `"${MAIN_ACCOUNT}" is your normal Claude Code login; choose another name` }
  if (taken.some((t) => t.toLowerCase() === key)) return { ok: false, error: `An account named "${name}" already exists` }
  return { ok: true, value: name }
}

/**
 * A token pasted from `claude setup-token`. Whitespace is dropped: a token has none, and one copied from a terminal
 * keeps the line breaks its output was wrapped at. The format is not documented, so only the characters and the length
 * are checked. The errors never repeat what was pasted.
 */
export function checkToken(raw: unknown): Checked<string> {
  const token = typeof raw === 'string' ? raw.replace(/\s+/g, '') : ''
  if (token.length === 0) return { ok: false, error: 'Paste the token from claude setup-token' }
  if (!/^[\x21-\x7e]+$/.test(token)) return { ok: false, error: 'This is not a token: it holds characters a token does not have' }
  if (token.length < MIN_TOKEN || token.length > MAX_TOKEN) return { ok: false, error: 'This is not a whole token' }
  return { ok: true, value: token }
}

/** accounts.json; null when it is not one. Entries of the wrong shape and repeated ids are left out. */
export function parseAccounts(text: string): StoredAccount[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || !Array.isArray(r.accounts)) return null
  const accounts: StoredAccount[] = []
  for (const a of r.accounts as unknown[]) {
    if (typeof a !== 'object' || a === null) continue
    const x = a as Record<string, unknown>
    if (typeof x.id !== 'string' || x.id.length === 0 || x.id.length > MAX_ID || accounts.some((o) => o.id === x.id)) continue
    if (typeof x.name !== 'string' || typeof x.addedAt !== 'string' || typeof x.token !== 'string' || typeof x.encrypted !== 'boolean') continue
    accounts.push({ id: x.id, name: x.name, addedAt: x.addedAt, token: x.token, encrypted: x.encrypted })
  }
  return accounts
}

/** what a tab on an extra account gets: the token, and no API key, which Claude Code would use before the token */
export function tokenEnv(token: string): EnvPatch {
  return { set: { CLAUDE_CODE_OAUTH_TOKEN: token }, unset: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] }
}

export interface AccountLaunch {
  /** the account the tab runs on: null for the main account */
  account: string | null
  env?: EnvPatch
  /** the account asked for cannot be used (removed, or its token cannot be read): the main account instead */
  unavailable: boolean
}

export function accountLaunch(id: string | null, token: (id: string) => string | null): AccountLaunch {
  if (id === null) return { account: null, unavailable: false }
  const t = token(id)
  return t === null ? { account: null, unavailable: true } : { account: id, env: tokenEnv(t), unavailable: false }
}

export interface AccountStoreOptions {
  now?(): Date
  newId?(): string
  onError?(message: string): void
}

/** The extra accounts, kept in accounts.json. A token leaves the store only through `token()`, for a tab's launch. */
export class AccountStore {
  private accounts: StoredAccount[] = []
  /** accounts.json could not be used: the first save keeps it aside instead of overwriting it */
  private broken = false

  constructor(private readonly file: AccountFile, private readonly vault: Vault, private readonly opts: AccountStoreOptions = {}) {
    let text: string | null
    try {
      text = file.read()
    } catch (e) {
      opts.onError?.(`cannot read accounts.json: ${(e as Error).message}`)
      this.broken = true
      return
    }
    if (text === null) return
    const parsed = parseAccounts(text)
    if (parsed) this.accounts = parsed
    else {
      opts.onError?.('ignoring accounts.json: not an accounts file')
      this.broken = true
    }
  }

  list(): AccountView[] {
    return this.accounts.map((a) => ({ id: a.id, name: a.name, addedAt: a.addedAt, readable: this.reveal(a) !== null }))
  }

  /**
   * Whether the stored tokens are encrypted. With no account there is nothing to tell, and the system keyring is not
   * asked: on Linux that could mean an unlock prompt at every start, for people who never use accounts.
   */
  keyring(): boolean {
    return this.accounts.length === 0 || this.vault.available()
  }

  nameOf(id: string): string | null {
    return this.find(id)?.name ?? null
  }

  /** the account's token, for a tab's launch; null when there is no such account or its token cannot be read */
  token(id: string): string | null {
    const a = this.find(id)
    return a ? this.reveal(a) : null
  }

  add(name: unknown, token: unknown): AccountResult {
    const n = checkAccountName(name, this.accounts.map((a) => a.name))
    if (!n.ok) return n
    const sealed = this.seal(token)
    if (!sealed.ok) return sealed
    const account: StoredAccount = { id: this.opts.newId?.() ?? randomUUID(), name: n.value, addedAt: this.now(), ...sealed.value }
    return this.save([...this.accounts, account])
  }

  rename(id: unknown, name: unknown): AccountResult {
    const a = this.find(id)
    if (!a) return NO_ACCOUNT
    const n = checkAccountName(name, this.accounts.filter((x) => x !== a).map((x) => x.name))
    if (!n.ok) return n
    return this.save(this.accounts.map((x) => (x === a ? { ...x, name: n.value } : x)))
  }

  setToken(id: unknown, token: unknown): AccountResult {
    const a = this.find(id)
    if (!a) return NO_ACCOUNT
    const sealed = this.seal(token)
    if (!sealed.ok) return sealed
    return this.save(this.accounts.map((x) => (x === a ? { ...x, addedAt: this.now(), ...sealed.value } : x)))
  }

  remove(id: unknown): AccountResult {
    const a = this.find(id)
    if (!a) return NO_ACCOUNT
    return this.save(this.accounts.filter((x) => x !== a))
  }

  private find(id: unknown): StoredAccount | undefined {
    return typeof id === 'string' ? this.accounts.find((a) => a.id === id) : undefined
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString()
  }

  /** the plain token; null when it cannot be decrypted, or decrypts to something that is no token (Linux's basic store hands back data it cannot read) */
  private reveal(a: StoredAccount): string | null {
    if (!a.encrypted) return a.token
    try {
      const token = this.vault.decrypt(a.token)
      return checkToken(token).ok ? token : null
    } catch {
      return null
    }
  }

  private seal(raw: unknown): Checked<{ token: string; encrypted: boolean }> {
    const t = checkToken(raw)
    if (!t.ok) return t
    if (!this.vault.available()) return { ok: true, value: { token: t.value, encrypted: false } }
    try {
      return { ok: true, value: { token: this.vault.encrypt(t.value), encrypted: true } }
    } catch (e) {
      return { ok: false, error: `Cannot encrypt the token: ${(e as Error).message}` }
    }
  }

  private save(next: StoredAccount[]): AccountResult {
    try {
      if (this.broken) {
        this.file.moveAside()
        this.broken = false
      }
      this.file.write(`${JSON.stringify({ version: 1, accounts: next }, null, 2)}\n`)
    } catch (e) {
      return { ok: false, error: `Cannot save accounts.json: ${(e as Error).message}` }
    }
    this.accounts = next
    return { ok: true }
  }
}

/** accounts.json on disk: replaced in one step, readable only by the user (like Claude Code's own .credentials.json) */
export function nodeAccountFile(path: string): AccountFile {
  return {
    read: () => {
      try {
        return readFileSync(path, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    write: (text) => {
      const tmp = `${path}.tmp`
      // a temporary file left by a crash may have other permissions: the mode applies only to a new file
      rmSync(tmp, { force: true })
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, path)
    },
    moveAside: () => {
      try {
        renameSync(path, `${path}.broken`)
      } catch {
        // nothing to keep
      }
    }
  }
}

/** the parts of Electron's safeStorage the vault uses */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
  getSelectedStorageBackend?(): string
}

/**
 * Electron's safeStorage: DPAPI on Windows, the Keychain on macOS, the keyring on Linux. Linux without a keyring has
 * only the "basic_text" store, whose key is the same on every machine — no protection at all, so the tokens are then
 * kept as they are.
 */
export function electronVault(s: SafeStorageLike, platform: string): Vault {
  return {
    available: () => s.isEncryptionAvailable() && !(platform === 'linux' && s.getSelectedStorageBackend?.() === 'basic_text'),
    encrypt: (token) => s.encryptString(token).toString('base64'),
    decrypt: (data) => s.decryptString(Buffer.from(data, 'base64'))
  }
}
