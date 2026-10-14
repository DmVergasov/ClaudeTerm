# Account Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Claude tab run on one of several Claude subscription accounts and switch a tab to another account in one click, continuing its conversation.

**Architecture:** The user's normal login stays the main account. An extra account is a name plus a token from `claude setup-token`, kept by a new `AccountStore` in `<dataDir>/accounts.json`, encrypted with Electron `safeStorage`. A Claude tab on an extra account gets `CLAUDE_CODE_OAUTH_TOKEN` in its environment (and loses `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`), so the Claude Code configuration stays shared and `--resume` works across accounts. `TabManager` keeps each tab's account, inherits it for new Claude tabs, and switches it with a restart.

**Tech Stack:** Electron 44 (`safeStorage`), TypeScript (strict), node-pty, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-account-switching-design.md`

## Global Constraints

- **No commits.** The user's global rule: never create a git commit unless they ask in the conversation. Every task ends with its changes left uncommitted. Subagents must not commit either.
- No test runs the real `claude`, uses a real token, or reads or writes the real `~/.claude` or `%APPDATA%\ClaudeTerm` (AGENTS.md). Test tokens are invented strings such as `e2e-token-work-0000000001`.
- A token never reaches the renderer, a log line, a toast or an error message. Windows see `AccountView` (`id`, `name`, `addedAt`, `readable`) only.
- UI strings, comments and logs are English. Exact strings: `Main account`, `Removed account`, `Continue as <name>`, `Claude Code — <name>`, `Get a token`, `Add account`, `Rename`, `Replace token`, `Delete`, `Confirm delete`, `token valid until about <date>`, `token cannot be read — replace it`, `No extra accounts yet.`, `No system keyring: tokens are stored unencrypted, readable only by your user.`, `Account "<name>" is not available; the tab started on the main account`, `The account is not available; the tab started on the main account`, `Account "<name>" is not available`.
- A name is 1–40 characters after trimming, unique ignoring case, not `Main account`, no control characters. A token is 20–500 printable ASCII characters after all whitespace is removed.
- `accounts.json` is `{ version: 1, accounts: [{ id, name, addedAt, token, encrypted }] }`, written atomically with mode 0600.
- Match the surrounding code: naming, comment density, idioms; TypeScript strict with `noUnusedLocals`; no UI framework in the renderer; keep LF line endings.
- Linux e2e runs start Electron with `--password-store=basic`.
- CI runs on Windows and Ubuntu: every test must pass on both.

## Review Focus

1. **A token pasted with a line break in the middle** (Claude Code's `setup-token` output is wrapped by its UI, and a copy keeps the break) must be saved without the whitespace and work. Pinned in Task 1 (`checkToken` and `AccountStore.add`).
2. **An account deleted while a tab runs on it, then Restart session**: the tab must start on the main account and say so, and its status bar shows `Removed account` until then. Pinned in Task 4 (restart fallback) and Task 6 (`accountLabel`).
3. **A data folder copied from another machine or user** (the token cannot be decrypted, or decrypts to garbage on Linux's basic store): the account must show as unreadable, its menu items disabled, and a switch to it refused with a toast. Pinned in Task 1 (garbage decrypt), Task 5 (e2e) and Task 6 (disabled choice).
4. **An API key variable written in another case on Windows** (`Anthropic_Api_Key`) would survive the patch and make Claude Code use the API key instead of the token. Pinned in Task 3.
5. **A double click on Continue as …** (a second switch while one restart runs) must not start two Claude Code processes on one conversation. Pinned in Task 4.

---

### Task 1: Account rules and the store

**Files:**
- Create: `src/shared/accounts.ts`
- Create: `src/main/accounts.ts`
- Modify: `src/main/child-env.ts` (only the `EnvPatch` type, which `tokenEnv` returns)
- Test: `tests/unit/accounts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/shared/accounts.ts`: `MAIN_ACCOUNT = 'Main account'`; `interface AccountView { id: string; name: string; addedAt: string; readable: boolean }`; `interface AccountsView { accounts: AccountView[]; keyring: boolean }`; `type AccountResult = { ok: true } | { ok: false; error: string }`.
  - `src/main/child-env.ts`: `interface EnvPatch { set: Record<string, string>; unset: string[] }`.
  - `src/main/accounts.ts`: `interface Vault { available(): boolean; encrypt(token: string): string; decrypt(data: string): string }`; `interface AccountFile { read(): string | null; write(text: string): void; moveAside(): void }`; `checkAccountName(raw: unknown, taken: readonly string[])`; `checkToken(raw: unknown)`; `parseAccounts(text: string)`; `tokenEnv(token: string): EnvPatch`; `interface AccountLaunch { account: string | null; env?: EnvPatch; unavailable: boolean }`; `accountLaunch(id: string | null, token: (id: string) => string | null): AccountLaunch`; `class AccountStore` with `list(): AccountView[]`, `keyring(): boolean`, `nameOf(id: string): string | null`, `token(id: string): string | null`, `add(name: unknown, token: unknown): AccountResult`, `rename(id: unknown, name: unknown): AccountResult`, `setToken(id: unknown, token: unknown): AccountResult`, `remove(id: unknown): AccountResult`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/accounts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { accountLaunch, AccountStore, checkAccountName, checkToken, parseAccounts, tokenEnv, type AccountFile, type Vault } from '../../src/main/accounts'

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
    expect(store.keyring()).toBe(false)
    store.add('Personal', TOKEN)
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/accounts.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/main/accounts"`.

- [ ] **Step 3: Write the shared types**

Create `src/shared/accounts.ts`:

```ts
/** The user's normal Claude Code login: Claude tabs run on it unless they are given an extra account. */
export const MAIN_ACCOUNT = 'Main account'

/** An extra account as the windows see it; its token never leaves the main process. */
export interface AccountView {
  id: string
  name: string
  /** ISO date the token was saved: a token from `claude setup-token` lasts a year */
  addedAt: string
  /** false: the token cannot be decrypted here (the data folder came from another machine or user) */
  readable: boolean
}

export interface AccountsView {
  accounts: AccountView[]
  /** whether the system keyring encrypts the tokens; false on Linux without one */
  keyring: boolean
}

export type AccountResult = { ok: true } | { ok: false; error: string }
```

Add to the end of `src/main/child-env.ts`:

```ts
/** variables a tab's launch removes from the environment, then sets */
export interface EnvPatch {
  set: Record<string, string>
  unset: string[]
}
```

- [ ] **Step 4: Write the store**

Create `src/main/accounts.ts`:

```ts
import { randomUUID } from 'node:crypto'
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

  keyring(): boolean {
    return this.vault.available()
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
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/unit/accounts.test.ts`
Expected: PASS, every test.

- [ ] **Step 6: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Checkpoint**

Leave the changes uncommitted (Global Constraints). Files ready: `src/shared/accounts.ts`, `src/main/accounts.ts`, `src/main/child-env.ts`, `tests/unit/accounts.test.ts`.

---

### Task 2: accounts.json on disk and the system's encryption

**Files:**
- Modify: `src/main/accounts.ts` (add `nodeAccountFile`, `SafeStorageLike`, `electronVault`)
- Test: `tests/integration/accounts.int.test.ts`, `tests/unit/accounts.test.ts`

**Interfaces:**
- Consumes: `AccountFile`, `Vault`, `AccountStore` from Task 1.
- Produces: `nodeAccountFile(path: string): AccountFile`; `interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string; getSelectedStorageBackend?(): string }`; `electronVault(s: SafeStorageLike, platform: string): Vault`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/accounts.int.test.ts`:

```ts
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountStore, nodeAccountFile, type Vault } from '../../src/main/accounts'

const plain: Vault = { available: () => false, encrypt: (t) => t, decrypt: (d) => d }
const newPath = (): string => join(mkdtempSync(join(tmpdir(), 'ct-accounts-')), 'accounts.json')

describe('nodeAccountFile', () => {
  it('reads null before the file exists, then what was written; the write leaves no temporary file', () => {
    const path = newPath()
    const file = nodeAccountFile(path)
    expect(file.read()).toBeNull()
    file.write('{"version":1,"accounts":[]}\n')
    file.write('{"version":1,"accounts":[{}]}\n')
    expect(file.read()).toBe('{"version":1,"accounts":[{}]}\n')
    expect(readdirSync(join(path, '..'))).toEqual(['accounts.json'])
  })

  it.skipIf(process.platform === 'win32')('is readable only by the user', () => {
    const path = newPath()
    nodeAccountFile(path).write('{}')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('moves a broken file aside, and does not mind when there is none', () => {
    const path = newPath()
    const file = nodeAccountFile(path)
    file.moveAside()
    writeFileSync(path, 'not json')
    file.moveAside()
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(`${path}.broken`, 'utf8')).toBe('not json')
  })

  it('a store on a broken file keeps it as accounts.json.broken when the first account is added', () => {
    const path = newPath()
    writeFileSync(path, 'not json')
    const store = new AccountStore(nodeAccountFile(path), plain)
    expect(store.add('Work', 'test-token-work-0000000001')).toEqual({ ok: true })
    expect(readFileSync(`${path}.broken`, 'utf8')).toBe('not json')
    expect(JSON.parse(readFileSync(path, 'utf8')).accounts[0]).toMatchObject({ name: 'Work', encrypted: false })
  })
})
```

Add to `tests/unit/accounts.test.ts` (extend the import with `electronVault`):

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/integration/accounts.int.test.ts tests/unit/accounts.test.ts`
Expected: FAIL, `nodeAccountFile is not a function` / `electronVault is not a function`.

- [ ] **Step 3: Implement**

In `src/main/accounts.ts`, change the first import line block to:

```ts
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
```

Add at the end of `src/main/accounts.ts`:

```ts
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
 * Electron's safeStorage: DPAPI on Windows, the keyring on Linux. Linux without a keyring has only the "basic_text"
 * store, whose key is the same on every machine — no protection at all, so the tokens are then kept as they are.
 */
export function electronVault(s: SafeStorageLike, platform: string): Vault {
  return {
    available: () => s.isEncryptionAvailable() && !(platform === 'linux' && s.getSelectedStorageBackend?.() === 'basic_text'),
    encrypt: (token) => s.encryptString(token).toString('base64'),
    decrypt: (data) => s.decryptString(Buffer.from(data, 'base64'))
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/integration/accounts.int.test.ts tests/unit/accounts.test.ts`
Expected: PASS (the mode test is skipped on Windows).

- [ ] **Step 5: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Checkpoint**

Leave the changes uncommitted.

---

### Task 3: The tab's environment and the setup-token command line

**Files:**
- Modify: `src/main/child-env.ts` (add `applyEnvPatch`)
- Modify: `src/main/profiles.ts:184-197` (`ClaudeLaunch.settingsPath` may be null)
- Test: `tests/unit/child-env.test.ts`, `tests/unit/profiles.test.ts`

**Interfaces:**
- Consumes: `EnvPatch` from Task 1.
- Produces: `applyEnvPatch(env: Record<string, string>, patch: EnvPatch | undefined): Record<string, string>`; `ClaudeLaunch.settingsPath: string | null` (null: no `--settings`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/child-env.test.ts` (extend the import with `applyEnvPatch`):

```ts
describe('applyEnvPatch', () => {
  it('removes, then sets; no patch leaves the environment as it is', () => {
    const env = { PATH: 'C:\\Windows', ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: 'auth' }
    const patch = { set: { CLAUDE_CODE_OAUTH_TOKEN: 'token' }, unset: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] }
    expect(applyEnvPatch(env, patch)).toEqual({ PATH: 'C:\\Windows', CLAUDE_CODE_OAUTH_TOKEN: 'token' })
    expect(applyEnvPatch(env, undefined)).toBe(env)
  })

  it('matches names ignoring case, as Windows does, so no other spelling of a variable survives', () => {
    const env = { Path: 'C:\\Windows', Anthropic_Api_Key: 'key', claude_code_oauth_token: 'old' }
    const patch = { set: { CLAUDE_CODE_OAUTH_TOKEN: 'token' }, unset: ['ANTHROPIC_API_KEY'] }
    expect(applyEnvPatch(env, patch)).toEqual({ Path: 'C:\\Windows', CLAUDE_CODE_OAUTH_TOKEN: 'token' })
  })
})
```

Add to the `describe` holding `buildLaunch` in `tests/unit/profiles.test.ts`:

```ts
  it('a command line without a settings file has no --settings: the Get a token tab', () => {
    const setup = { command: 'claude setup-token', settingsPath: null, resumeSessionId: null }
    expect(buildClaudeCommandLine('powershell', setup)).toBe('claude setup-token')
    expect(buildLaunch(PS, 'claude', setup)).toEqual({ file: PS.command, args: ['-NoLogo', '-NoExit', '-Command', 'claude setup-token'] })
  })
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/child-env.test.ts tests/unit/profiles.test.ts`
Expected: FAIL, `applyEnvPatch is not a function`, and a type error / `--settings 'null'` for the profiles test.

- [ ] **Step 3: Implement**

Add to `src/main/child-env.ts`, after the `EnvPatch` interface:

```ts
/**
 * The environment with the patch applied. Names are matched ignoring case: Windows treats them so, and another
 * spelling of a removed variable must not survive (Claude Code would still find it).
 */
export function applyEnvPatch(env: Record<string, string>, patch: EnvPatch | undefined): Record<string, string> {
  if (!patch) return env
  const drop = new Set([...patch.unset, ...Object.keys(patch.set)].map((k) => k.toUpperCase()))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!drop.has(k.toUpperCase())) out[k] = v
  return { ...out, ...patch.set }
}
```

In `src/main/profiles.ts`, change `ClaudeLaunch` and `buildClaudeCommandLine`:

```ts
export interface ClaudeLaunch {
  command: string
  /** null: no --settings (the Get a token tab runs `claude setup-token`) */
  settingsPath: string | null
  resumeSessionId: string | null
}

export function buildClaudeCommandLine(family: ShellFamily, c: ClaudeLaunch): string {
  let line = c.settingsPath === null ? c.command : `${c.command} --settings ${quoteForShell(family, c.settingsPath)}`
  if (c.resumeSessionId !== null) {
    if (!isUuid(c.resumeSessionId)) throw new Error(`invalid session id: ${c.resumeSessionId}`)
    line += ` --resume ${c.resumeSessionId}`
  }
  return line
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/unit/child-env.test.ts tests/unit/profiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Checkpoint**

Leave the changes uncommitted.

---

### Task 4: Each tab's account in TabManager and the session snapshot

**Files:**
- Modify: `src/shared/types.ts:10-26, 44-50` (`TabInfo.account`, `OpenTabRequest.account`, `SessionSnapshotTab.account`)
- Modify: `src/main/tab-manager.ts` (`LaunchRequest`, `ResolvedLaunch.account/env`, `open`, `restart`, `switchAccount`, `snapshot`, `start`)
- Modify: `src/main/session-store.ts:20-27` (`parseSnapshot` reads `account`)
- Modify: `src/main/index.ts:400-402` (restore passes the account, so the build keeps type-checking)
- Test: `tests/unit/tab-manager.test.ts`, `tests/unit/session-store.test.ts`

**Interfaces:**
- Consumes: `EnvPatch`, `applyEnvPatch` from Tasks 1 and 3.
- Produces:
  - `TabInfo.account: string | null`, `OpenTabRequest.account?: string | null` (left out: inherit), `SessionSnapshotTab.account: string | null`.
  - `interface LaunchRequest extends OpenTabRequest { account: string | null; strict?: boolean; setupToken?: boolean }`.
  - `ResolvedLaunch { profileName; spec; account?: string | null; env?: EnvPatch }`.
  - `TabManagerDeps.resolveLaunch(req: LaunchRequest): ResolvedLaunch`.
  - `TabManager.open(req: OpenTabRequest, opts?: { activate?: boolean; setupToken?: boolean }): TabInfo`.
  - `TabManager.switchAccount(tabId: string, account: string | null): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/tab-manager.test.ts`, change the import to:

```ts
import { TabManager, type LaunchRequest, type ResolvedLaunch, type TabEvents, type TabManagerDeps } from '../../src/main/tab-manager'
```

In the test `session ids are tracked per tab, even for two claude tabs in the same folder`, add `account: null` to each of the three expected snapshot entries.

Add a new `describe` at the end of the file:

```ts
describe('TabManager accounts', () => {
  const SPEC = { file: 'powershell.exe', args: ['-NoLogo'] }
  /** knows the accounts "work" and "home" (unless gone); any other one falls back to the main account, or throws when strict */
  function accountLaunches(gone: Set<string> = new Set()) {
    return vi.fn((req: LaunchRequest): ResolvedLaunch => {
      const usable = req.account !== null && ['work', 'home'].includes(req.account) && !gone.has(req.account)
      if (req.account !== null && !usable && req.strict) throw new Error('account not available')
      const account = usable ? req.account : null
      return { profileName: 'Windows PowerShell', spec: SPEC, account, env: account ? { set: { CLAUDE_CODE_OAUTH_TOKEN: `token-${account}` }, unset: ['ANTHROPIC_API_KEY'] } : undefined }
    })
  }

  it('a claude tab on an account gets its token instead of the API key; the main account keeps the environment', () => {
    const { tm, ptys } = setup({ resolveLaunch: accountLaunches(), baseEnv: () => ({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: 'key' }) })
    const main = tm.open({ kind: 'claude', cwd: 'D:\\x', account: null })
    const work = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'work' })
    expect(main.account).toBeNull()
    expect(ptys[0].opts.env).toEqual({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: 'key', CLAUDETERM_TAB_ID: main.id, CLAUDETERM_PIPE: '\\\\.\\pipe\\test' })
    expect(work.account).toBe('work')
    expect(ptys[1].opts.env).toEqual({ PATH: 'C:\\Windows', CLAUDE_CODE_OAUTH_TOKEN: 'token-work', CLAUDETERM_TAB_ID: work.id, CLAUDETERM_PIPE: '\\\\.\\pipe\\test' })
  })

  it('a new claude tab takes the account of the active claude tab unless one is asked for', () => {
    const resolveLaunch = accountLaunches()
    const { tm } = setup({ resolveLaunch })
    const work = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'work' })
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x' }).account).toBe('work')
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x', account: null }).account).toBeNull()
    tm.activate(work.id)
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'home' }).account).toBe('home')
    // a shell tab in front: the main account
    tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x' }).account).toBeNull()
    expect(resolveLaunch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'shell', account: null }))
  })

  it('an account that cannot be used starts the tab on the main account', () => {
    const { tm, ptys } = setup({ resolveLaunch: accountLaunches() })
    const t = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'gone' })
    expect(t.account).toBeNull()
    expect(ptys[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('switchAccount restarts the tab on the new account and resumes the current conversation', async () => {
    const resolveLaunch = accountLaunches()
    const { tm, ptys, log } = setup({ resolveLaunch })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A, account: null })
    tm.setClaudeSession(tab.id, SID_B)
    const done = tm.switchAccount(tab.id, 'work')
    expect(ptys[0].killed).toBe(true)
    expect(log).toContain(`reset:${tab.id}`)
    ptys[0].emitExit(0)
    expect(await done).toBe(true)
    expect(ptys).toHaveLength(2)
    expect(ptys[1].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-work')
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_B, account: 'work', strict: true }))
    expect(tm.get(tab.id)?.account).toBe('work')
    expect(tm.snapshot()[0]).toMatchObject({ account: 'work', claudeSessionId: SID_B })
  })

  it('switchAccount to an account that cannot be used leaves the tab running as it was', async () => {
    const { tm, ptys, onStateChanged } = setup({ resolveLaunch: accountLaunches() })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'work' })
    onStateChanged.mockClear()
    expect(await tm.switchAccount(tab.id, 'gone')).toBe(false)
    expect(ptys).toHaveLength(1)
    expect(ptys[0].killed).toBe(false)
    expect(tm.get(tab.id)?.account).toBe('work')
    expect(onStateChanged).not.toHaveBeenCalled()
  })

  it('switchAccount of an exited tab starts it on the new account; a shell tab has no account to switch', async () => {
    const { tm, ptys } = setup({ resolveLaunch: accountLaunches() })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', account: null })
    ptys[0].emitExit(0)
    expect(await tm.switchAccount(tab.id, 'home')).toBe(true)
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)).toMatchObject({ account: 'home', exited: false })
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(await tm.switchAccount(shell.id, 'work')).toBe(false)
    expect(ptys).toHaveLength(3)
  })

  it('a second switch while one is under way does nothing', async () => {
    const { tm, ptys } = setup({ resolveLaunch: accountLaunches() })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', account: null })
    const first = tm.switchAccount(tab.id, 'work')
    const second = tm.switchAccount(tab.id, 'home')
    ptys[0].emitExit(0)
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)?.account).toBe('work')
  })

  it('restart keeps the account; an account gone meanwhile restarts the tab on the main one', async () => {
    const gone = new Set<string>()
    const { tm, ptys, log } = setup({ resolveLaunch: accountLaunches(gone) })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'work' })
    const first = tm.restart(tab.id, { live: true })
    ptys[0].emitExit(0)
    await first
    expect(ptys[1].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-work')
    gone.add('work')
    log.length = 0
    const second = tm.restart(tab.id, { live: true })
    ptys[1].emitExit(0)
    await second
    expect(ptys[2].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(tm.get(tab.id)?.account).toBeNull()
    expect(log).toContain(`updated:${tab.id}:false`)
  })

  it('the Get a token tab is asked for in the launch request', () => {
    const resolveLaunch = accountLaunches()
    const { tm } = setup({ resolveLaunch })
    const t = tm.open({ kind: 'shell', cwd: 'D:\\x', title: 'Get a token' }, { setupToken: true })
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'shell', setupToken: true, account: null }))
    expect(t).toMatchObject({ kind: 'shell', customTitle: 'Get a token', account: null })
  })
})
```

In `tests/unit/session-store.test.ts`, add `account: null` to the `claudeTab` and `shellTab` literals, and add to `describe('parseSnapshot')`:

```ts
  it('reads the account of a claude tab; a snapshot from before accounts restores on the main account', () => {
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, account: 'acc-1' }])))?.tabs[0].account).toBe('acc-1')
    const old = { version: 1, savedAt: 'x', tabs: [{ kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\x', title: null, claudeSessionId: SID }] }
    expect(parseSnapshot(JSON.stringify(old))?.tabs[0].account).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, account: 5 as unknown as string }])))?.tabs[0].account).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, account: 'x'.repeat(65) }])))?.tabs[0].account).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap([{ ...shellTab, account: 'acc-1' }])))?.tabs[0].account).toBeNull()
  })
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/tab-manager.test.ts tests/unit/session-store.test.ts`
Expected: FAIL — `tm.switchAccount is not a function`, `account` missing from tabs and snapshots, `CLAUDE_CODE_OAUTH_TOKEN` not in the env.

- [ ] **Step 3: Add the account to the shared types**

In `src/shared/types.ts`:

```ts
export interface TabInfo {
  id: string
  kind: TabKind
  profile: string
  cwd: string
  customTitle: string | null
  claudeSessionId: string | null
  /** the extra account a Claude tab runs on; null: the main account (and every shell tab) */
  account: string | null
  exited: boolean
}

export interface OpenTabRequest {
  kind: TabKind
  cwd: string
  profile?: string | null
  title?: string | null
  resumeSessionId?: string | null
  /** a Claude tab's account, null the main one; left out: the account of the active Claude tab */
  account?: string | null
}
```

```ts
export interface SessionSnapshotTab {
  kind: TabKind
  profile: string
  cwd: string
  title: string | null
  claudeSessionId: string | null
  account: string | null
}
```

- [ ] **Step 4: Read the account in parseSnapshot**

In `src/main/session-store.ts`, in `parseSnapshot`, change the pushed object to:

```ts
    tabs.push({
      kind: x.kind,
      profile: x.profile,
      cwd: x.cwd,
      title: typeof x.title === 'string' ? x.title : null,
      claudeSessionId: isUuid(x.claudeSessionId) ? x.claudeSessionId : null,
      // written before accounts existed, or by hand: the main account
      account: x.kind === 'claude' && typeof x.account === 'string' && x.account.length > 0 && x.account.length <= 64 ? x.account : null
    })
```

- [ ] **Step 5: Keep the account in TabManager**

In `src/main/tab-manager.ts`:

Imports and launch types:

```ts
import { randomUUID } from 'node:crypto'
import type { OpenTabRequest, SessionSnapshotTab, TabInfo } from '../shared/types'
import { applyEnvPatch, type EnvPatch } from './child-env'
import type { LaunchSpec } from './profiles'
import type { PtyHandle, SpawnPty } from './pty-host'

export interface ResolvedLaunch {
  profileName: string
  spec: LaunchSpec
  /** the account the tab runs on, once one that cannot be used fell back to the main account (null) */
  account?: string | null
  /** changes to the tab's environment, for an extra account */
  env?: EnvPatch
}

/** what a launch is resolved from: the request with its account settled */
export interface LaunchRequest extends OpenTabRequest {
  account: string | null
  /** an account that cannot be used throws instead of falling back to the main account */
  strict?: boolean
  /** the Get a token tab: a shell tab running `claude setup-token` */
  setupToken?: boolean
}
```

In `TabManagerDeps`, change `resolveLaunch(req: OpenTabRequest): ResolvedLaunch` to `resolveLaunch(req: LaunchRequest): ResolvedLaunch`.

Replace `open`:

```ts
  open(req: OpenTabRequest, opts: { activate?: boolean; setupToken?: boolean } = {}): TabInfo {
    const launch = this.deps.resolveLaunch({ ...req, account: this.accountFor(req), ...(opts.setupToken ? { setupToken: true } : {}) })
    const info: TabInfo = {
      id: randomUUID(),
      kind: req.kind,
      profile: launch.profileName,
      cwd: req.cwd,
      customTitle: req.title ?? null,
      claudeSessionId: req.kind === 'claude' ? req.resumeSessionId ?? null : null,
      account: req.kind === 'claude' ? launch.account ?? null : null,
      exited: false
    }
```

(the rest of `open` stays as it is).

Replace `restart` and add `switchAccount` after it:

```ts
  /**
   * Starts the tab's process again in the same tab. With `live`, a running process is stopped first (e.g. so
   * Claude Code picks up a newly added MCP server); otherwise only an exited tab restarts. A Claude tab resumes
   * its current conversation, on its account.
   */
  async restart(tabId: string, opts: { live?: boolean } = {}): Promise<void> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.restarting || (!rec.info.exited && !opts.live)) return
    if (rec.info.kind === 'claude') {
      try {
        this.setLaunch(rec, this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId: this.resumeId(rec), account: rec.info.account }))
      } catch {
        // keep the previous launch
      }
    }
    await this.relaunch(rec)
  }

  /**
   * Restarts a Claude tab on another account, resuming its conversation. When the launch cannot use that account the
   * tab is left as it is and the answer is false: silently going on under another account would be worse.
   */
  async switchAccount(tabId: string, account: string | null): Promise<boolean> {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude' || rec.restarting) return false
    let launch: ResolvedLaunch
    try {
      launch = this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId: this.resumeId(rec), account, strict: true })
    } catch {
      return false
    }
    this.setLaunch(rec, launch)
    await this.relaunch(rec)
    return true
  }
```

Change `snapshot`:

```ts
  snapshot(): SessionSnapshotTab[] {
    return this.order.map((id) => {
      const i = this.tabs.get(id)!.info
      return { kind: i.kind, profile: i.profile, cwd: i.cwd, title: i.customTitle, claudeSessionId: i.claudeSessionId, account: i.account }
    })
  }
```

Add these private methods before `private start(`:

```ts
  /** a new Claude tab's account: the one asked for, else the active Claude tab's */
  private accountFor(req: OpenTabRequest): string | null {
    if (req.kind !== 'claude') return null
    if (req.account !== undefined) return req.account
    const active = this.activeId ? this.tabs.get(this.activeId)?.info : undefined
    return active?.kind === 'claude' ? active.account : null
  }

  /** the conversation a restart continues: the CURRENT one (it may have changed since open, /clear), once it was saved */
  private resumeId(rec: TabRecord): string | null {
    const id = rec.info.claudeSessionId
    return id !== null && (this.deps.resumable?.(rec.info.id, id) ?? true) ? id : null
  }

  private setLaunch(rec: TabRecord, launch: ResolvedLaunch): void {
    rec.launch = launch
    const account = launch.account ?? null
    if (rec.info.account === account) return
    rec.info.account = account
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  /** an exited tab starts again; a running one is stopped first, and the new process waits for the old one */
  private async relaunch(rec: TabRecord): Promise<void> {
    if (rec.info.exited) {
      rec.info.exited = false
      this.deps.events.updated({ ...rec.info })
      this.start(rec)
      return
    }
    rec.restarting = true
    rec.gen++
    if (rec.timer) clearTimeout(rec.timer)
    rec.timer = null
    rec.buffer = ''
    const stopped = rec.stopped
    rec.pty?.kill()
    rec.pty = null
    this.deps.events.reset(rec.info.id)
    // let the old process go first, so two Claude Code processes never share one conversation
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([stopped, new Promise<void>((r) => { timer = setTimeout(r, this.deps.restartWaitMs ?? 3000) })])
    clearTimeout(timer)
    rec.restarting = false
    if (this.isLive(rec) && !this.disposed) this.start(rec)
  }
```

In `start`, apply the launch's environment:

```ts
    const env = applyEnvPatch({ ...this.deps.baseEnv(), CLAUDETERM_TAB_ID: rec.info.id, CLAUDETERM_PIPE: this.deps.pipeName }, rec.launch.env)
```

- [ ] **Step 6: Pass the account on restore**

In `src/main/index.ts`, in `runRestore`, change the `openTab` call to:

```ts
      const opened = openTab(
        { kind: t.kind, cwd, profile: t.kind === 'shell' ? t.profile : null, title: t.title, resumeSessionId: t.kind === 'claude' ? t.claudeSessionId : null, account: t.kind === 'claude' ? t.account : null },
        false
      )
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run tests/unit/tab-manager.test.ts tests/unit/session-store.test.ts`
Expected: PASS, the new tests and every existing one.

- [ ] **Step 8: Type-check and run all unit tests**

Run: `npm run typecheck` then `npm test`
Expected: no type errors; all tests pass.

- [ ] **Step 9: Checkpoint**

Leave the changes uncommitted.

---

### Task 5: Main process wiring, IPC and the preload bridge

**Files:**
- Modify: `src/shared/ipc.ts` (channels, `CtApi`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc-guards.ts` (`isAccountRef`)
- Modify: `src/main/index.ts` (store, `resolveLaunch`, `openTab`, handlers)
- Modify: `tests/e2e/helpers.ts` (`--password-store=basic` on Linux)
- Test: `tests/unit/ipc-guards.test.ts`, `tests/e2e/accounts.spec.ts` (new)

**Interfaces:**
- Consumes: `AccountStore`, `accountLaunch`, `nodeAccountFile`, `electronVault` (Tasks 1–2); `ClaudeLaunch.settingsPath: null` (Task 3); `LaunchRequest`, `TabManager.open(req, { activate, setupToken })`, `TabManager.switchAccount` (Task 4).
- Produces:
  - IPC channels `accounts:list`, `accounts:add`, `accounts:rename`, `accounts:set-token`, `accounts:remove`, `accounts:get-token`, `tabs:switch-account`, `ev:accounts`.
  - `CtApi`: `listAccounts(): Promise<AccountsView>`, `addAccount(name: string, token: string): Promise<AccountResult>`, `renameAccount(id: string, name: string): Promise<AccountResult>`, `setAccountToken(id: string, token: string): Promise<AccountResult>`, `removeAccount(id: string): Promise<AccountResult>`, `getToken(): void`, `switchAccount(tabId: string, account: string | null): void`, `onAccounts(cb: (view: AccountsView) => void): Unsubscribe`.
  - `isAccountRef(v: unknown): v is string | null`.

- [ ] **Step 1: Write the failing guard test**

In `tests/unit/ipc-guards.test.ts`, add `isAccountRef` to the import and add:

```ts
  it('isAccountRef accepts null and a short non-empty id', () => {
    for (const v of [null, 'acc', 'x'.repeat(64)]) expect(isAccountRef(v)).toBe(true)
    for (const v of [undefined, '', 'x'.repeat(65), 1, {}]) expect(isAccountRef(v)).toBe(false)
  })
```

- [ ] **Step 2: Write the failing e2e tests**

In `tests/e2e/helpers.ts`, start Electron with the basic password store on Linux. Add after the `PROMPT` constant:

```ts
/** Linux: safeStorage would look for a keyring, and may wait for one under xvfb; the tests use the basic store */
const PLATFORM_ARGS = WIN ? [] : ['--password-store=basic']
```

and in `launchApp` change the launch line to:

```ts
  const app = await electron.launch({ args: [ROOT, ...PLATFORM_ARGS, ...(o.args ?? [])], env: { ...testEnv(dataDir, pipeName), ...o.env } })
```

Create `tests/e2e/accounts.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir, TEST_SHELL, type Launched } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const WORK = '0b6f3c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'
const BROKEN = '1c7a4d3f-5e6b-4f7a-9b8c-0d1e2f3a4b5c'
const WORK_TOKEN = 'e2e-token-work-0000000001'
const API_KEY = 'e2e-api-key-0001'

// "claude" prints the token and the API key it was given, then its arguments
const ACCOUNT_SETTINGS = {
  ...FAKE_CLAUDE_SETTINGS,
  claude: {
    ...FAKE_CLAUDE_SETTINGS.claude,
    command: WIN
      ? 'cmd /c echo fake-claude token=%CLAUDE_CODE_OAUTH_TOKEN% key=%ANTHROPIC_API_KEY%'
      : 'pwd; echo fake-claude token=$CLAUDE_CODE_OAUTH_TOKEN key=$ANTHROPIC_API_KEY'
  }
}

/** accounts.json with tokens kept as they are, which the store reads on every system */
function writeAccounts(dataDir: string, accounts: { id: string; name: string; token: string; encrypted?: boolean }[]): void {
  writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, addedAt: '2026-10-01T09:00:00.000Z', token: a.token, encrypted: a.encrypted ?? false }))
  }))
}

/** the app with the accounts Work and Broken (whose token cannot be decrypted), and a work folder */
async function launchWithAccounts(env: Record<string, string> = {}): Promise<Launched & { work: string }> {
  const dataDir = makeDataDir(ACCOUNT_SETTINGS)
  // bytes that no system decrypts, nor reads as a token
  writeAccounts(dataDir, [{ id: WORK, name: 'Work', token: WORK_TOKEN }, { id: BROKEN, name: 'Broken', token: 'AAECA/r7/P3+/w==', encrypted: true }])
  const launched = await launchApp({ dataDir, env })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  return { ...launched, work: mkdtempSync(join(tmpdir(), 'ct-work-')) }
}

async function openClaude(page: Page, cwd: string, account: string | null): Promise<string> {
  const tab = await page.evaluate(({ cwd, account }) => window.ct.openTab({ kind: 'claude', cwd, account }), { cwd, account })
  return tab!.id
}

test('a Claude tab on an extra account gets its token instead of the API key; the main account keeps the key', async () => {
  const { app, page, work } = await launchWithAccounts({ ANTHROPIC_API_KEY: API_KEY })
  const main = await openClaude(page, work, null)
  const onWork = await openClaude(page, work, WORK)
  await expect.poll(() => bufferText(page, onWork), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  expect(await bufferText(page, onWork)).not.toContain(`key=${API_KEY}`)
  await expect.poll(() => bufferText(page, main), { timeout: 15_000 }).toContain(`key=${API_KEY}`)
  expect(await bufferText(page, main)).not.toContain(WORK_TOKEN)
  await app.close()
})

test('a new Claude tab opened from a tab on an account runs on the same account', async () => {
  const { app, page, work } = await launchWithAccounts()
  await openClaude(page, work, WORK)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+L')
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  await app.close()
})

test('switching the account restarts the tab with --resume of its conversation on the new account', async () => {
  const { app, page, pipeName, work } = await launchWithAccounts()
  const id = await openClaude(page, work, null)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude token=/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: id, sessionId: SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: WORK })
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await bufferText(page, id)).toContain(`token=${WORK_TOKEN}`)
  await page.evaluate((id) => window.ct.switchAccount(id, null), id)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).not.toContain(WORK_TOKEN)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  await app.close()
})

test('switching to an account whose token cannot be read leaves the tab as it was and says so', async () => {
  const { app, page, work } = await launchWithAccounts()
  const id = await openClaude(page, work, WORK)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  expect(await page.evaluate(() => window.ct.listAccounts())).toMatchObject({ accounts: [{ name: 'Work', readable: true }, { name: 'Broken', readable: false }] })
  await page.evaluate(({ id, account }) => window.ct.switchAccount(id, account), { id, account: BROKEN })
  await expect(page.locator('.toast', { hasText: 'Account "Broken" is not available' })).toBeVisible()
  expect((await bufferText(page, id)).match(/fake-claude/g)).toHaveLength(1)
  expect(await bufferText(page, id)).toContain(`token=${WORK_TOKEN}`)
  await app.close()
})

test('restore reopens a Claude tab on its account; a tab on an account that is gone starts on the main account', async () => {
  const dataDir = makeDataDir(ACCOUNT_SETTINGS)
  writeAccounts(dataDir, [{ id: WORK, name: 'Work', token: WORK_TOKEN }])
  const cwd = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const tab = (title: string, account: string | null) => ({ kind: 'claude', profile: TEST_SHELL, cwd, title, claudeSessionId: SID, account })
  writeFileSync(join(dataDir, 'session-state.json'), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [tab('work', WORK), tab('gone', 'no-such-account')] }))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const [onWork, gone] = await page.evaluate(() => window.__ct!.tabIds())
  await expect.poll(() => bufferText(page, onWork), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  await expect.poll(() => bufferText(page, gone), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await bufferText(page, gone)).not.toContain(WORK_TOKEN)
  await expect(page.locator('.toast', { hasText: 'The account is not available; the tab started on the main account' })).toBeVisible()
  await app.close()
})

test('Get a token opens a tab that runs claude setup-token', async () => {
  const { app, page } = await launchWithAccounts()
  await page.evaluate(() => window.ct.getToken())
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude.*setup-token/)
  expect(await bufferText(page, id)).not.toContain('--settings')
  expect(await page.evaluate((i) => window.__ct!.tabTitle(i), id)).toBe('Get a token')
  await app.close()
})

test('an added account is listed without its token, and the token is encrypted on disk where the system can', async () => {
  const { app, page, dataDir } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const token = 'e2e-token-personal-0000001'
  expect(await page.evaluate((t) => window.ct.addAccount('Personal', t), token)).toEqual({ ok: true })
  expect(await page.evaluate((t) => window.ct.addAccount('personal', t), token)).toEqual({ ok: false, error: 'An account named "personal" already exists' })
  const view = await page.evaluate(() => window.ct.listAccounts())
  // the Linux tests run on the basic store, which encrypts nothing
  expect(view).toMatchObject({ keyring: WIN, accounts: [{ name: 'Personal', readable: true }] })
  expect(JSON.stringify(view)).not.toContain(token)
  expect(readFileSync(join(dataDir, 'accounts.json'), 'utf8').includes(token)).toBe(!WIN)
  await app.close()
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/unit/ipc-guards.test.ts`
Expected: FAIL, `isAccountRef is not a function`.

Run: `npm run test:e2e -- accounts.spec.ts`
Expected: FAIL — the build fails on `window.ct.listAccounts` / `account` types, or the tests fail with `window.ct.addAccount is not a function` and no `token=` in the terminal.

- [ ] **Step 4: Add the guard**

In `src/main/ipc-guards.ts`:

```ts
/** an extra account's id, or null for the main account */
export const isAccountRef = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 64)
```

- [ ] **Step 5: Add the channels and the bridge**

In `src/shared/ipc.ts`, add to `IPC` after `tabsRestart`:

```ts
  tabsSwitchAccount: 'tabs:switch-account',
```

after `panelSet`:

```ts
  accountsList: 'accounts:list',
  accountsAdd: 'accounts:add',
  accountsRename: 'accounts:rename',
  accountsSetToken: 'accounts:set-token',
  accountsRemove: 'accounts:remove',
  accountsGetToken: 'accounts:get-token',
```

and after `evPanelMode`:

```ts
  evAccounts: 'ev:accounts'
```

(with a comma after `evPanelMode: 'ev:panel-mode'`). Add `import type { AccountResult, AccountsView } from './accounts'` at the top. Add to `CtApi`, after `restartTab`:

```ts
  /** restarts a Claude tab on another account (null: the main one), resuming its conversation */
  switchAccount(tabId: string, account: string | null): void
```

and after `setPanel`:

```ts
  /** the extra accounts, without their tokens */
  listAccounts(): Promise<AccountsView>
  addAccount(name: string, token: string): Promise<AccountResult>
  renameAccount(id: string, name: string): Promise<AccountResult>
  /** tabs on the account use the new token from their next start */
  setAccountToken(id: string, token: string): Promise<AccountResult>
  /** tabs on the account keep running, and start on the main account next time */
  removeAccount(id: string): Promise<AccountResult>
  /** opens a tab running `claude setup-token` in the main window */
  getToken(): void
```

and after `onPanelMode`:

```ts
  /** the extra accounts changed: every window gets the new list */
  onAccounts(cb: (view: AccountsView) => void): Unsubscribe
```

In `src/preload/index.ts`, add after `restartTab`:

```ts
  switchAccount: (id, account) => ipcRenderer.send(IPC.tabsSwitchAccount, id, account),
```

after `setPanel`:

```ts
  listAccounts: () => ipcRenderer.invoke(IPC.accountsList),
  addAccount: (name, token) => ipcRenderer.invoke(IPC.accountsAdd, name, token),
  renameAccount: (id, name) => ipcRenderer.invoke(IPC.accountsRename, id, name),
  setAccountToken: (id, token) => ipcRenderer.invoke(IPC.accountsSetToken, id, token),
  removeAccount: (id) => ipcRenderer.invoke(IPC.accountsRemove, id),
  getToken: () => ipcRenderer.send(IPC.accountsGetToken),
```

and after `onPanelMode`:

```ts
  onAccounts: (cb) => on(IPC.evAccounts, cb)
```

(with a comma after the `onPanelMode` line).

- [ ] **Step 6: Wire the main process**

In `src/main/index.ts`:

1. Add `safeStorage` to the `electron` import, `import type { AccountResult, AccountsView } from '../shared/accounts'`, `import { AccountStore, accountLaunch, electronVault, nodeAccountFile } from './accounts'`, and `isAccountRef` to the `./ipc-guards` import.

2. After `const starred = new StarredSessions(dataDir, toast)`:

```ts
  const accounts = new AccountStore(nodeAccountFile(join(dataDir, 'accounts.json')), electronVault(safeStorage, process.platform), { onError: (m) => log.warn(m) })
  /** how a message names an account */
  const accountName = (id: string): string => {
    const name = accounts.nameOf(id)
    return name ? `Account "${name}"` : 'The account'
  }
```

3. Replace the `claude` branch of `resolveLaunch`:

```ts
    resolveLaunch: (req) => {
      if (req.kind === 'claude' || req.setupToken) {
        const acc = accountLaunch(req.kind === 'claude' ? req.account : null, (id) => accounts.token(id))
        // a switch to an account that cannot be used changes nothing; a start goes on with the main account
        if (acc.unavailable && req.strict) throw new Error(`${accountName(req.account!)} is not available`)
        if (claudeCli === null && settings.claude.command === 'claude') toast('claude not found in PATH — install Claude Code: https://claude.com/claude-code')
        const { profile, warning } = pickClaudeProfile(profiles, settings.claude.shellProfile)
        if (warning) toast(warning)
        if (req.setupToken) {
          return { profileName: profile.name, spec: buildLaunch(profile, 'claude', { command: `${settings.claude.command} setup-token`, settingsPath: null, resumeSessionId: null }) }
        }
        if (acc.unavailable) toast(`${accountName(req.account!)} is not available; the tab started on the main account`)
        const claude = { command: settings.claude.command, settingsPath: claudeFiles.settingsPath, resumeSessionId: req.resumeSessionId ?? null }
        return { profileName: profile.name, spec: buildLaunch(profile, 'claude', claude), account: acc.account, env: acc.env }
      }
```

(the shell branch after it stays as it is).

4. Let `openTab` open the Get a token tab:

```ts
  const openTab = (req: OpenTabRequest, activate = true, setupToken = false): TabInfo | null => {
    try {
      return tabs.open(req, { activate, setupToken })
    } catch (e) {
      toast(`Cannot open tab: ${(e as Error).message}`)
      return null
    }
  }
```

5. Check the account of `tabs:open`:

```ts
  ipcMain.handle(IPC.tabsOpen, (_e, req: OpenTabRequest) => (req?.account === undefined || isAccountRef(req.account) ? openTab(req) : null))
```

6. After the `IPC.tabsRestart` handler:

```ts
  ipcMain.on(IPC.tabsSwitchAccount, (_e, id: unknown, account: unknown) => {
    if (!isId(id) || !isAccountRef(account)) return
    tabs.switchAccount(id, account)
      .then((ok) => { if (!ok && account !== null && accounts.token(account) === null) toast(`${accountName(account)} is not available`) })
      .catch((e: Error) => log.warn(`cannot switch the account: ${e.message}`))
  })
```

7. After the `IPC.panelSet` handler:

```ts
  const accountsView = (): AccountsView => ({ accounts: accounts.list(), keyring: accounts.keyring() })
  /** both windows show the accounts: the settings window lists them, the main window's menus and status bar name them */
  const accountsChanged = (r: AccountResult): AccountResult => {
    if (r.ok) broadcast(IPC.evAccounts, accountsView())
    return r
  }
  // the store checks the names, tokens and ids it is given
  ipcMain.handle(IPC.accountsList, () => accountsView())
  ipcMain.handle(IPC.accountsAdd, (_e, name: unknown, token: unknown) => accountsChanged(accounts.add(name, token)))
  ipcMain.handle(IPC.accountsRename, (_e, id: unknown, name: unknown) => accountsChanged(accounts.rename(id, name)))
  ipcMain.handle(IPC.accountsSetToken, (_e, id: unknown, token: unknown) => accountsChanged(accounts.setToken(id, token)))
  ipcMain.handle(IPC.accountsRemove, (_e, id: unknown) => accountsChanged(accounts.remove(id)))
  ipcMain.on(IPC.accountsGetToken, () => {
    if (openTab({ kind: 'shell', cwd: homedir(), title: 'Get a token' }, true, true)) focusWindow()
  })
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run tests/unit/ipc-guards.test.ts`
Expected: PASS.

Run: `npm run test:e2e -- accounts.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Type-check and run the neighbouring e2e suites**

Run: `npm run typecheck`, then `npx playwright test restart.spec.ts restore.spec.ts settings.spec.ts` (the build from Step 7 is current).
Expected: no type errors; all pass.

- [ ] **Step 9: Checkpoint**

Leave the changes uncommitted.

---

### Task 6: The main window: status bar segment and menus

**Files:**
- Create: `src/renderer/account-items.ts`
- Modify: `src/renderer/status-bar.ts` (`account` segment, click)
- Modify: `src/renderer/styles.css:186-187`
- Modify: `src/renderer/main.ts` (accounts state, `renderStatus`, `tabMenu`, `newTabMenu`, boot)
- Test: `tests/unit/account-items.test.ts`, `tests/unit/status-bar.test.ts`, `tests/e2e/accounts.spec.ts`

**Interfaces:**
- Consumes: `AccountView`, `MAIN_ACCOUNT` (Task 1); `ct.listAccounts`, `ct.onAccounts`, `ct.switchAccount`, `OpenTabRequest.account` (Tasks 4–5).
- Produces:
  - `src/renderer/account-items.ts`: `REMOVED_ACCOUNT = 'Removed account'`; `interface AccountChoice { label: string; account: string | null; disabled: boolean }`; `accountLabel(id: string | null, accounts: readonly AccountView[]): string`; `accountChoices(accounts: readonly AccountView[]): AccountChoice[]`; `switchChoices(current: string | null, accounts: readonly AccountView[]): AccountChoice[]`.
  - `status-bar.ts`: `accountSegment(label: string): Segment`; `StatusBar(el, onChangesClick?, onAccountClick?: (anchor: HTMLElement) => void)`; `render(u, changes = null, account: string | null = null, now = Date.now())`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/account-items.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { accountChoices, accountLabel, switchChoices } from '../../src/renderer/account-items'
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
})
```

Add to `tests/unit/status-bar.test.ts` (extend the import with `accountSegment`):

```ts
describe('accountSegment', () => {
  it('names the tab\'s account and says a click switches it', () => {
    expect(accountSegment('Work')).toEqual({ key: 'account', text: 'Work', title: 'The account this tab runs on — click to switch', level: 'normal' })
  })
})
```

- [ ] **Step 2: Write the failing e2e tests**

Append to `tests/e2e/accounts.spec.ts` (add `launchClaudeTab` to the `./helpers` import):

```ts
test('the ▾ menu opens a Claude tab on a chosen account', async () => {
  const { app, page } = await launchWithAccounts()
  await page.locator('.tab-menu').click()
  await expect(page.locator('.menu-item.disabled', { hasText: 'Claude Code — Broken' })).toBeVisible()
  await page.locator('.menu-item', { hasText: 'Claude Code — Work' }).click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  await expect(page.locator('#statusbar .status-account')).toHaveText('Work')
  await app.close()
})

test('Continue as … in the tab menu resumes the conversation on another account', async () => {
  const { app, page, pipeName, work } = await launchWithAccounts()
  const id = await openClaude(page, work, null)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude token=/)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: id, sessionId: SID, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-account')).toHaveText('Main account')
  await page.locator('.tab').nth(1).click({ button: 'right' })
  await expect(page.locator('.menu-item', { hasText: 'Continue as Main account' })).toHaveCount(0)
  await page.locator('.menu-item', { hasText: 'Continue as Work' }).click()
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await bufferText(page, id)).toContain(`token=${WORK_TOKEN}`)
  await expect(page.locator('#statusbar .status-account')).toHaveText('Work')
  await app.close()
})

test('a click on the account in the status bar switches it', async () => {
  const { app, page, work } = await launchWithAccounts()
  const id = await openClaude(page, work, WORK)
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`token=${WORK_TOKEN}`)
  await page.locator('#statusbar .status-account').click()
  await page.locator('.menu-item', { hasText: 'Continue as Main account' }).click()
  await expect(page.locator('#statusbar .status-account')).toHaveText('Main account')
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude token=/)
  expect(await bufferText(page, id)).not.toContain(WORK_TOKEN)
  await app.close()
})

test('without extra accounts there is no account in the status bar or the menus', async () => {
  const { app, page, tabId } = await launchClaudeTab(ACCOUNT_SETTINGS)
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude/)
  await expect(page.locator('#statusbar .status-account')).toHaveCount(0)
  await page.locator('.tab').first().click({ button: 'right' })
  await expect(page.locator('.menu-item', { hasText: 'Close tab' })).toBeVisible()
  await expect(page.locator('.menu-item', { hasText: 'Continue as' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('.tab-menu').click()
  await expect(page.locator('.menu-item', { hasText: 'Recent sessions' })).toBeVisible()
  await expect(page.locator('.menu-item', { hasText: 'Claude Code — ' })).toHaveCount(0)
  await app.close()
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/unit/account-items.test.ts tests/unit/status-bar.test.ts`
Expected: FAIL, `Failed to resolve import "../../src/renderer/account-items"` and `accountSegment is not a function`.

- [ ] **Step 4: Write the account items**

Create `src/renderer/account-items.ts`:

```ts
import { MAIN_ACCOUNT, type AccountView } from '../shared/accounts'

/** a tab on an account deleted while it ran */
export const REMOVED_ACCOUNT = 'Removed account'

export interface AccountChoice {
  label: string
  account: string | null
  /** its token cannot be read here: starting on it would fail */
  disabled: boolean
}

export function accountLabel(id: string | null, accounts: readonly AccountView[]): string {
  if (id === null) return MAIN_ACCOUNT
  return accounts.find((a) => a.id === id)?.name ?? REMOVED_ACCOUNT
}

/** every account, the main one first; none until an extra account is added */
export function accountChoices(accounts: readonly AccountView[]): AccountChoice[] {
  if (accounts.length === 0) return []
  return [{ label: MAIN_ACCOUNT, account: null, disabled: false }, ...accounts.map((a) => ({ label: a.name, account: a.id, disabled: !a.readable }))]
}

/** the accounts a tab on `current` can continue on */
export function switchChoices(current: string | null, accounts: readonly AccountView[]): AccountChoice[] {
  return accountChoices(accounts).filter((c) => c.account !== current)
}
```

- [ ] **Step 5: Add the status bar segment**

In `src/renderer/status-bar.ts`:

```ts
export interface Segment {
  key: 'account' | 'model' | 'context' | 'limit' | 'week' | 'agents' | 'changes'
  text: string
  title: string
  level: Level
}
```

Add after `changesSegment`:

```ts
/** the tab's account, once extra accounts exist: first, and there before Claude's first status too */
export function accountSegment(label: string): Segment {
  return { key: 'account', text: label, title: 'The account this tab runs on — click to switch', level: 'normal' }
}
```

Change the constructor and the first lines of `render`:

```ts
export class StatusBar {
  constructor(private readonly el: HTMLElement, onChangesClick: () => void = () => {}, onAccountClick: (anchor: HTMLElement) => void = () => {}) {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('.status-changes')) onChangesClick()
      const account = target.closest<HTMLElement>('.status-account')
      if (account) onAccountClick(account)
    })
  }

  render(u: StatusUpdate | null, changes: ReviewCounter | null = null, account: string | null = null, now = Date.now()): void {
    const segments = [
      ...(account !== null ? [accountSegment(account)] : []),
      ...(u ? statusSegments(u, now) : []),
      ...(changes ? [changesSegment(changes)] : [])
    ]
```

(the rest of `render` stays as it is).

In `src/renderer/styles.css`, after `#statusbar .status-changes:hover { color: var(--fg); }`:

```css
#statusbar .status-account { cursor: pointer; }
#statusbar .status-account:hover { color: var(--fg); }
```

- [ ] **Step 6: Use them in the main window**

In `src/renderer/main.ts`:

1. Imports: add `import type { AccountView } from '../shared/accounts'` and `import { accountChoices, accountLabel, switchChoices } from './account-items'`.

2. State, after `const statusUpdates = new Map<string, StatusUpdate>()`:

```ts
/** the extra accounts, without their tokens */
let accounts: AccountView[] = []
```

3. After `counterOf`:

```ts
/** the status bar's account: a Claude tab's, once extra accounts exist */
function accountOf(tabId: string | null): string | null {
  const t = tabId ? tabs.get(tabId) : undefined
  return t?.info.kind === 'claude' && accounts.length > 0 ? accountLabel(t.info.account, accounts) : null
}

function renderStatus(tabId: string): void {
  statusBar.render(statusUpdates.get(tabId) ?? null, counterOf(tabId), accountOf(tabId))
}

/** Continue as …: the tab's conversation restarts on another account */
function continueItems(tabId: string): MenuItem[] {
  const t = tabs.get(tabId)
  if (t?.info.kind !== 'claude') return []
  return switchChoices(t.info.account, accounts).map((c) => ({ label: `Continue as ${c.label}`, disabled: c.disabled, action: () => ct.switchAccount(tabId, c.account) }))
}
```

4. Replace each `statusBar.render(statusUpdates.get(X) ?? null, counterOf(X))` with `renderStatus(X)`: in `activate` (`renderStatus(tabId)`), in `applySettings` (`if (activeId) renderStatus(activeId)`), in `ct.onReview` (`renderStatus(u.tabId)`). In `ct.onStatus` change `if (u.tabId === activeId) statusBar.render(u, counterOf(u.tabId))` to `if (u.tabId === activeId) renderStatus(u.tabId)`. Leave `statusBar.render(null)` in `ct.onTabClosed` as it is.

5. In `newTabMenu`, after the `Claude Code` item:

```ts
      ...accountChoices(accounts).map((c) => ({
        label: `Claude Code — ${c.label}`,
        disabled: c.disabled,
        action: () => void ct.openTab({ kind: 'claude', cwd: active?.info.cwd ?? appInfo.homeDir, account: c.account })
      })),
```

6. In `tabMenu`, build the items as:

```ts
    const switches = continueItems(id)
    showMenu(at, [
      { label: t.info.kind === 'claude' ? 'Restart session' : 'Restart shell', action: () => ct.restartTab(id, true) },
      ...(sessionId ? [{ label: isStarred ? 'Unstar session' : 'Star session', action: () => void ct.setSessionStarred(sessionId, !isStarred) }] : []),
      ...(switches.length > 0 ? [{ label: '', separator: true }, ...switches] : []),
      { label: '', separator: true },
      { label: 'Close tab', action: () => ct.closeTab(id) }
    ])
```

7. In `boot`, after `settings = await ct.getSettings()`:

```ts
  accounts = (await ct.listAccounts()).accounts
```

Replace the `statusBar = new StatusBar(...)` line with:

```ts
  statusBar = new StatusBar(document.getElementById('statusbar')!, () => sidePanel.open('changes'), (anchor) => {
    const r = anchor.getBoundingClientRect()
    // the menu opens over the status bar, kept inside the window
    if (activeId) showMenu({ x: r.left, y: r.top }, continueItems(activeId))
  })
  ct.onAccounts((v) => {
    accounts = v.accounts
    if (activeId) renderStatus(activeId)
  })
```

In `ct.onTabUpdated`, after `renderTabs()`:

```ts
    // a switch of the account shows at once
    if (info.id === activeId) renderStatus(info.id)
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run tests/unit/account-items.test.ts tests/unit/status-bar.test.ts`
Expected: PASS.

Run: `npm run test:e2e -- accounts.spec.ts status.spec.ts`
Expected: PASS, 11 account tests and the existing status bar tests.

- [ ] **Step 8: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Checkpoint**

Leave the changes uncommitted.

---

### Task 7: Settings → Accounts, the README and the full check

**Files:**
- Create: `src/renderer/dom.ts` (`el` and `section`, moved out of `settings-page.ts`)
- Create: `src/renderer/accounts-section.ts`
- Modify: `src/renderer/settings-page.ts` (use `dom.ts`, add the section)
- Modify: `src/renderer/account-items.ts` (`validUntil`)
- Modify: `src/renderer/settings.css`
- Modify: `README.md`
- Modify: `docs/images/settings.png` (regenerated)
- Test: `tests/unit/account-items.test.ts`, `tests/e2e/accounts.spec.ts`

**Interfaces:**
- Consumes: `CtApi` account methods (Task 5); `MAIN_ACCOUNT`, `AccountsView`, `AccountView`, `AccountResult` (Task 1).
- Produces: `el(tag, props?, ...children)` and `section(title, note, ...content)` in `src/renderer/dom.ts`; `accountsSection(): HTMLElement`; `validUntil(addedAt: string): string`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/account-items.test.ts` (extend the import with `validUntil`):

```ts
describe('validUntil', () => {
  it('is a year after the token was saved', () => {
    expect(validUntil('2026-10-14T10:00:00.000Z')).toBe('14 Oct 2027')
    expect(validUntil('not a date')).toBe('unknown')
  })
})
```

Append to `tests/e2e/accounts.spec.ts` (add `type ElectronApplication` to the `@playwright/test` import):

```ts
/** Ctrl+, in the main window; returns the settings window once its page is up */
async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  await page.locator('.terminal-host:visible .xterm').click()
  const [win] = await Promise.all([app.waitForEvent('window'), page.keyboard.press('Control+Comma')])
  await win.waitForSelector('#settings .settings-heading')
  return win
}

test('Settings → Accounts adds, renames, replaces and deletes an account without ever showing its token', async () => {
  const { app, page } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const win = await openSettings(app, page)
  const token = 'e2e-token-personal-0000001'
  await expect(win.locator('.account-list')).toHaveText('No extra accounts yet.')
  await win.locator('[data-account-field="name"]').fill('Personal')
  await win.locator('button', { hasText: 'Add account' }).click()
  await expect(win.locator('.account-add + .field-error')).toHaveText('Paste the token from claude setup-token')
  await win.locator('[data-account-field="token"]').fill(token)
  await win.locator('button', { hasText: 'Add account' }).click()
  await expect(win.locator('.account-row .account-name')).toHaveText('Personal')
  await expect(win.locator('.account-row')).toContainText('token valid until about')
  await expect(win.locator('[data-account-field="name"]')).toHaveValue('')
  await expect(win.locator('[data-account-field="token"]')).toHaveValue('')
  expect(await win.content()).not.toContain(token)
  // the main window knows the account at once
  await expect.poll(() => page.evaluate(async () => (await window.ct.listAccounts()).accounts.map((a) => a.name))).toEqual(['Personal'])

  await win.locator('.account-row button', { hasText: 'Rename' }).click()
  await win.locator('.account-row input').fill('Home')
  await win.locator('.account-row input').press('Enter')
  await expect(win.locator('.account-row .account-name')).toHaveText('Home')

  await win.locator('.account-row button', { hasText: 'Replace token' }).click()
  await win.locator('.account-row input').fill('e2e-token-replaced-0000001')
  await win.locator('.account-row button', { hasText: 'Save' }).click()
  await expect(win.locator('.account-row')).toContainText('token valid until about')

  await win.locator('.account-row button', { hasText: 'Delete' }).click()
  await win.locator('.account-row button', { hasText: 'Confirm delete' }).click()
  await expect(win.locator('.account-list')).toHaveText('No extra accounts yet.')
  await app.close()
})

test('Get a token in the settings window opens a setup-token tab in the main window', async () => {
  const { app, page } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const win = await openSettings(app, page)
  await win.locator('button', { hasText: 'Get a token' }).click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toMatch(/fake-claude.*setup-token/)
  await app.close()
})

test('the Accounts section says when the tokens are not encrypted', async () => {
  const { app, page } = await launchApp({ settings: ACCOUNT_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const win = await openSettings(app, page)
  // the Linux tests run on the basic store; Windows has DPAPI
  if (WIN) await expect(win.locator('.account-keyring')).toBeHidden()
  else await expect(win.locator('.account-keyring')).toHaveText('No system keyring: tokens are stored unencrypted, readable only by your user.')
  await app.close()
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/account-items.test.ts`
Expected: FAIL, `validUntil is not a function`.

Run: `npm run test:e2e -- accounts.spec.ts -g "Settings|settings window|not encrypted"`
Expected: FAIL, `.account-list` not found.

- [ ] **Step 3: Add validUntil**

Add to `src/renderer/account-items.ts`:

```ts
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** a token from claude setup-token lasts a year: "14 Oct 2027", a month name so it reads the same everywhere */
export function validUntil(addedAt: string): string {
  const d = new Date(addedAt)
  if (Number.isNaN(d.getTime())) return 'unknown'
  d.setFullYear(d.getFullYear() + 1)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
```

- [ ] **Step 4: Move the DOM helpers**

Create `src/renderer/dom.ts` with the two helpers moved, unchanged, from `settings-page.ts`:

```ts
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

/** a settings section: its title, a note beside it, and its fields */
export function section(title: string, note: string | null, ...content: HTMLElement[]): HTMLElement {
  const h = el('h2', { className: 'section-title' }, title, ...(note ? [el('span', { className: 'section-note', textContent: note })] : []))
  return el('section', {}, h, ...content)
}
```

In `src/renderer/settings-page.ts`, delete the local `el` and `section` functions and add `import { el, section } from './dom'`.

- [ ] **Step 5: Write the Accounts section**

Create `src/renderer/accounts-section.ts`:

```ts
import { MAIN_ACCOUNT, type AccountResult, type AccountsView, type AccountView } from '../shared/accounts'
import { validUntil } from './account-items'
import { el, section } from './dom'

const ct = window.ct

/** an error line under a form */
function errorLine(): { line: HTMLElement; show(m: string | null): void } {
  const line = el('div', { className: 'field-error', hidden: true })
  return {
    line,
    show: (m) => {
      line.hidden = m === null
      line.textContent = m ?? ''
    }
  }
}

/** a token is pasted, never shown */
const tokenInput = (): HTMLInputElement => el('input', { type: 'password', spellcheck: false, autocomplete: 'off', className: 'text-input', placeholder: 'Token from claude setup-token' })

/** runs an account change; its error goes under the form; true when it was saved */
async function run(change: Promise<AccountResult>, show: (m: string | null) => void): Promise<boolean> {
  const r = await change
  show(r.ok ? null : r.error)
  return r.ok
}

function accountRow(a: AccountView): HTMLElement {
  const row = el('div', { className: 'account-row' })
  const err = errorLine()
  const edit = (input: HTMLInputElement, save: () => Promise<AccountResult>): void => {
    const ok = el('button', { type: 'button', textContent: 'Save' })
    const cancel = el('button', { type: 'button', textContent: 'Cancel' })
    const submit = async (): Promise<void> => {
      if (await run(save(), err.show)) info()
    }
    const back = (): void => {
      err.show(null)
      info()
    }
    ok.addEventListener('click', () => void submit())
    cancel.addEventListener('click', back)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
      if (e.key === 'Escape') {
        // Escape cancels the edit; it must not reach the window, which it would close
        e.stopPropagation()
        back()
      }
    })
    row.replaceChildren(el('span', { className: 'account-name' }, input), el('span', { className: 'account-actions' }, ok, cancel), err.line)
    input.focus()
  }
  const info = (): void => {
    const rename = el('button', { type: 'button', textContent: 'Rename' })
    const replace = el('button', { type: 'button', textContent: 'Replace token' })
    const del = el('button', { type: 'button', textContent: 'Delete' })
    rename.addEventListener('click', () => {
      const input = el('input', { type: 'text', spellcheck: false, className: 'text-input', value: a.name })
      edit(input, () => ct.renameAccount(a.id, input.value))
    })
    replace.addEventListener('click', () => {
      const input = tokenInput()
      edit(input, () => ct.setAccountToken(a.id, input.value))
    })
    // the first click asks, the second deletes; the button goes back after a few seconds
    let timer: ReturnType<typeof setTimeout> | undefined
    del.addEventListener('click', () => {
      if (del.textContent === 'Confirm delete') {
        clearTimeout(timer)
        void run(ct.removeAccount(a.id), err.show)
        return
      }
      del.textContent = 'Confirm delete'
      timer = setTimeout(() => { del.textContent = 'Delete' }, 4000)
    })
    const state = a.readable ? `token valid until about ${validUntil(a.addedAt)}` : 'token cannot be read — replace it'
    row.replaceChildren(
      el('span', { className: 'account-name', textContent: a.name, title: a.name }),
      el('span', { className: a.readable ? 'hint' : 'hint account-unreadable', textContent: state }),
      el('span', { className: 'account-actions' }, rename, replace, del),
      err.line
    )
  }
  info()
  return row
}

/** Settings → Accounts: the extra subscription accounts a Claude tab can run on */
export function accountsSection(): HTMLElement {
  const list = el('div', { className: 'account-list' })
  const keyring = el('div', { className: 'settings-notice account-keyring', hidden: true, textContent: 'No system keyring: tokens are stored unencrypted, readable only by your user.' })
  const name = el('input', { type: 'text', spellcheck: false, className: 'text-input', placeholder: 'Name, e.g. Personal' })
  const token = tokenInput()
  name.dataset.accountField = 'name'
  token.dataset.accountField = 'token'
  const add = el('button', { type: 'button', textContent: 'Add account' })
  const getToken = el('button', { type: 'button', textContent: 'Get a token', title: 'Opens a tab running claude setup-token: sign in with the account, then paste the token it prints' })
  const err = errorLine()
  const submit = async (): Promise<void> => {
    if (!(await run(ct.addAccount(name.value, token.value), err.show))) return
    name.value = ''
    token.value = ''
  }
  add.addEventListener('click', () => void submit())
  token.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit() })
  getToken.addEventListener('click', () => ct.getToken())
  const render = (v: AccountsView): void => {
    keyring.hidden = v.keyring
    list.replaceChildren(...(v.accounts.length === 0 ? [el('div', { className: 'hint', textContent: 'No extra accounts yet.' })] : v.accounts.map(accountRow)))
  }
  ct.onAccounts(render)
  void ct.listAccounts().then(render)
  return section('Accounts', 'switch the subscription a Claude tab runs on',
    el('div', { className: 'hint account-intro', textContent: `${MAIN_ACCOUNT} is your normal Claude Code login. An extra account runs on a token from claude setup-token, valid for a year; its tabs have no claude.ai connectors and no Remote Control.` }),
    list,
    el('div', { className: 'account-add' }, name, token, add, getToken),
    err.line,
    keyring)
}
```

In `src/renderer/settings-page.ts`, add `import { accountsSection } from './accounts-section'` and put `accountsSection(),` in `root.append(...)` right after the `section('Claude Code', …)` entry.

Add to the end of `src/renderer/settings.css`:

```css
.account-intro { display: block; margin: 0 0 6px; }
.account-list { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
.account-row { display: grid; grid-template-columns: 170px 1fr auto; align-items: center; gap: 4px 12px; }
.account-row .field-error { grid-column: 1 / -1; }
.account-row input.text-input { width: 100%; }
.account-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-actions { display: flex; gap: 6px; }
.account-unreadable { color: #e5c07b; }
.account-add { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 4px; }
.account-add input[type="text"].text-input { width: 160px; }
.account-add input[type="password"].text-input { width: 240px; }
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run tests/unit/account-items.test.ts`
Expected: PASS.

Run: `npm run test:e2e -- accounts.spec.ts settings.spec.ts`
Expected: PASS, 14 account tests and the existing settings tests.

- [ ] **Step 7: Document it in the README**

In `README.md`, add after the `### 🔁 Continue previous sessions` section (before `## Install`):

```md
### 👥 More than one Claude subscription

Hit the 5-hour limit on one subscription, or keep work and personal apart? Add your other accounts in **Settings → Accounts** and move a Claude tab between them in one click: **Continue as …** in the tab's right-click menu, or a click on the account in the status bar, restarts Claude Code on the other account and **continues the same conversation**. **▾ → Claude Code — <account>** opens a new tab on an account, and a new Claude tab takes the account of the tab you are in.

Your normal Claude Code login stays the **Main account**. An extra account is a token from `claude setup-token` (Pro, Max, Team or Enterprise, valid for a year): **Get a token** opens a tab that runs it — sign in with that account in the browser, then paste the token it prints. ClaudeTerm keeps the tokens encrypted by the system (DPAPI on Windows, the keyring on Linux) and gives each one only to the tabs on its account. Claude Code lets a token make model requests only, so a tab on an extra account has no claude.ai connectors and no Remote Control.
```

In `## Settings`, change "notifications, font, theme, shells, Claude Code, images and updates" to "notifications, font, theme, shells, Claude Code, accounts, images and updates". In `### Good to know`, add the item:

```md
- Extra accounts are kept in `%APPDATA%\ClaudeTerm\accounts.json` (`~/.config/ClaudeTerm/accounts.json` on Linux), readable only by your user, with the tokens encrypted where the system has a keyring. A Claude tab on an extra account gets `CLAUDE_CODE_OAUTH_TOKEN`, and the `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` of your environment are left out of it, because Claude Code would use them first.
```

- [ ] **Step 8: Regenerate the settings screenshot**

Run: `npm run screenshots` (Windows).
Then: `git status --short docs/images`. Keep `docs/images/settings.png` (the Accounts section is new in it) and put back every other image that changed only by chance: `git restore docs/images/<name>.png` for each one. Open `settings.png` and check that it shows the Accounts section with `No extra accounts yet.` and no real data.

- [ ] **Step 9: Full check**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: all unit and integration tests pass.
Run: `npm run test:e2e`
Expected: all e2e tests pass.

- [ ] **Step 10: Checkpoint**

Leave everything uncommitted and report to the user what is ready to commit (suggested message: `feat: switch the Claude subscription account of a tab`). By hand, on real accounts (no test can): whether Claude Code shows the 5h/7d limits in the status bar for a tab on a token, and what `/status` says there.
