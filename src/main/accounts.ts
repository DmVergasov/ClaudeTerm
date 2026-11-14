import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { accountNameError, type AccountKind, type AccountResult } from '../shared/accounts'
import type { EnvPatch } from './child-env'

const MIN_TOKEN = 20
const MAX_TOKEN = 500
const MAX_ID = 64
/** a name, folder or addedAt read from accounts.json: longer ones are left out */
const MAX_STORED_NAME = 200
const MAX_FOLDER = 4096

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

/** an entry of accounts.json: a token account, or a sign-in account whose Claude Code config folder is its own */
export type StoredAccount =
  | { kind: 'token'; id: string; name: string; addedAt: string; token: string; encrypted: boolean }
  | { kind: 'login'; id: string; name: string; addedAt: string; folder: string; created: boolean }

type TokenAccount = Extract<StoredAccount, { kind: 'token' }>

/** an extra account as the windows and the remote side see it; `folder` and `created` are for sign-in accounts */
export interface AccountEntry {
  id: string
  name: string
  addedAt: string
  kind: AccountKind
  folder: string | null
  created: boolean
  /** token: its token decrypts here; login: always true */
  readable: boolean
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const NO_ACCOUNT: AccountResult = { ok: false, error: 'No such account' }

/** a name for a new or renamed account: trimmed, 1–40 characters, not "Main account" and not one of `taken`, ignoring case */
export function checkAccountName(raw: unknown, taken: readonly string[]): Checked<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a name' }
  const error = accountNameError(raw, taken)
  return error === null ? { ok: true, value: raw.trim() } : { ok: false, error }
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

/** a folder an account keeps its Claude Code config in: absolute and of a sane length */
function isFolder(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_FOLDER && !v.includes('\u0000') && isAbsolute(v)
}

/** accounts.json; null when it is not one. Entries of the wrong shape and repeated ids are left out. Version 1 holds token accounts only. */
export function parseAccounts(text: string): StoredAccount[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if ((r.version !== 1 && r.version !== 2) || !Array.isArray(r.accounts)) return null
  const accounts: StoredAccount[] = []
  for (const a of r.accounts as unknown[]) {
    if (typeof a !== 'object' || a === null) continue
    const x = a as Record<string, unknown>
    const kind: unknown = r.version === 1 ? 'token' : x.kind
    if (typeof x.id !== 'string' || x.id.length === 0 || x.id.length > MAX_ID || accounts.some((o) => o.id === x.id)) continue
    if (typeof x.name !== 'string' || x.name.length > MAX_STORED_NAME || typeof x.addedAt !== 'string') continue
    if (kind === 'token') {
      if (typeof x.token !== 'string' || typeof x.encrypted !== 'boolean') continue
      accounts.push({ kind, id: x.id, name: x.name, addedAt: x.addedAt, token: x.token, encrypted: x.encrypted })
    } else if (kind === 'login') {
      if (!isFolder(x.folder) || typeof x.created !== 'boolean') continue
      accounts.push({ kind, id: x.id, name: x.name, addedAt: x.addedAt, folder: x.folder, created: x.created })
    }
  }
  return accounts
}

/** what a tab on an extra account gets: the token, and no API key, which Claude Code would use before the token */
export function tokenEnv(token: string): EnvPatch {
  return { set: { CLAUDE_CODE_OAUTH_TOKEN: token }, unset: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] }
}

/** what a tab on a sign-in account gets: its own config folder, and no token or key Claude Code would use before the login */
export function loginEnv(folder: string): EnvPatch {
  return {
    set: { CLAUDE_CONFIG_DIR: folder },
    unset: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
  }
}

export interface AccountLaunch {
  /** the account the tab runs on: null for the main account */
  account: string | null
  env?: EnvPatch
  /** the account asked for cannot be used (removed, its token cannot be read, or its sign-in cannot start): the main account instead */
  unavailable: boolean
}

/** an account as a tab's launch sees it: a token that may be unreadable, or a sign-in folder that may not start */
export type LaunchAccount = { kind: 'token'; token: string | null } | { kind: 'login'; folder: string; startable: boolean }

export function accountLaunch(id: string | null, find: (id: string) => LaunchAccount | null): AccountLaunch {
  if (id === null) return { account: null, unavailable: false }
  const a = find(id)
  if (a === null) return { account: null, unavailable: true }
  if (a.kind === 'token') return a.token === null ? { account: null, unavailable: true } : { account: id, env: tokenEnv(a.token), unavailable: false }
  return a.startable ? { account: id, env: loginEnv(a.folder), unavailable: false } : { account: null, unavailable: true }
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

  list(): AccountEntry[] {
    return this.accounts.map((a) =>
      a.kind === 'login'
        ? { id: a.id, name: a.name, addedAt: a.addedAt, kind: a.kind, folder: a.folder, created: a.created, readable: true }
        : { id: a.id, name: a.name, addedAt: a.addedAt, kind: a.kind, folder: null, created: false, readable: this.reveal(a) !== null }
    )
  }

  /**
   * Whether the stored tokens are encrypted. With no token account there is nothing to tell, and the system keyring is
   * not asked: on Linux that could mean an unlock prompt at every start, for people who never use token accounts.
   */
  keyring(): boolean {
    return !this.accounts.some((a) => a.kind === 'token') || this.vault.available()
  }

  nameOf(id: string): string | null {
    return this.find(id)?.name ?? null
  }

  kindOf(id: string): AccountKind | null {
    return this.find(id)?.kind ?? null
  }

  /** a sign-in account's config folder; null for a token account or no such account */
  folderOf(id: string): string | null {
    const a = this.find(id)
    return a?.kind === 'login' ? a.folder : null
  }

  /** the account's token, for a tab's launch; null for a sign-in account, no such account, or a token that cannot be read */
  token(id: string): string | null {
    const a = this.findToken(id)
    return a ? this.reveal(a) : null
  }

  add(name: unknown, token: unknown): AccountResult {
    const n = checkAccountName(name, this.accounts.map((a) => a.name))
    if (!n.ok) return n
    const sealed = this.seal(token)
    if (!sealed.ok) return sealed
    const account: TokenAccount = { kind: 'token', id: this.opts.newId?.() ?? randomUUID(), name: n.value, addedAt: this.now(), ...sealed.value }
    return this.save([...this.accounts, account])
  }

  /** a sign-in account: its folder is kept as it is; nothing about the login (no email, no plan) is stored */
  addLogin(a: { id: string; name: unknown; folder: string; created: boolean }): AccountResult {
    if (this.find(a.id)) return { ok: false, error: 'The account already exists' }
    const n = checkAccountName(a.name, this.accounts.map((x) => x.name))
    if (!n.ok) return n
    if (!isFolder(a.folder)) return { ok: false, error: 'The folder is not an absolute path' }
    const account: StoredAccount = { kind: 'login', id: a.id, name: n.value, addedAt: this.now(), folder: a.folder, created: a.created }
    return this.save([...this.accounts, account])
  }

  /** a token account becomes a sign-in one: same id, the token gone, one write */
  toLogin(id: unknown, name: unknown, folder: string, created: boolean): AccountResult {
    const a = this.find(id)
    if (!a) return NO_ACCOUNT
    const n = checkAccountName(name, this.accounts.filter((x) => x !== a).map((x) => x.name))
    if (!n.ok) return n
    if (!isFolder(folder)) return { ok: false, error: 'The folder is not an absolute path' }
    const login: StoredAccount = { kind: 'login', id: a.id, name: n.value, addedAt: this.now(), folder, created }
    return this.save(this.accounts.map((x) => (x === a ? login : x)))
  }

  rename(id: unknown, name: unknown): AccountResult {
    const a = this.find(id)
    if (!a) return NO_ACCOUNT
    const n = checkAccountName(name, this.accounts.filter((x) => x !== a).map((x) => x.name))
    if (!n.ok) return n
    return this.save(this.accounts.map((x) => (x === a ? { ...x, name: n.value } : x)))
  }

  /** a token account's new token; a sign-in account has none to replace */
  setToken(id: unknown, token: unknown): AccountResult {
    const a = this.findToken(id)
    if (!a) return NO_ACCOUNT
    const sealed = this.seal(token)
    if (!sealed.ok) return sealed
    return this.save(this.accounts.map((x) => (x === a ? { ...a, addedAt: this.now(), ...sealed.value } : x)))
  }

  remove(id: unknown): AccountResult {
    const a = this.find(id)
    if (!a) return NO_ACCOUNT
    return this.save(this.accounts.filter((x) => x !== a))
  }

  private find(id: unknown): StoredAccount | undefined {
    return typeof id === 'string' ? this.accounts.find((a) => a.id === id) : undefined
  }

  private findToken(id: unknown): TokenAccount | undefined {
    const a = this.find(id)
    return a?.kind === 'token' ? a : undefined
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString()
  }

  /** the plain token; null when it cannot be decrypted, or decrypts to something that is no token (Linux's basic store hands back data it cannot read) */
  private reveal(a: TokenAccount): string | null {
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
      this.file.write(`${JSON.stringify({ version: 2, accounts: next }, null, 2)}\n`)
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
