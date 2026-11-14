import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ShellFamily } from '../shared/types'
import { jsonOutput, type CliRun } from './mcp/claude-cli'
import { canonicalFolder } from './chat/chat-files'
import { planOf } from './claude-plan'
import { isWithin, pathKey } from './path-key'
import { quoteForShell } from './profiles'

/** the environment variable that moves the accounts folder */
export const ACCOUNTS_ROOT_ENV = 'CLAUDETERM_ACCOUNTS_ROOT'

const MAX_EMAIL = 254
const MAX_TEXT = 200
const CONTROL = /[\u0000-\u001f\u007f]/
const NON_ASCII = /[\u0080-￿]/g
const EMAIL = /^(?!-)[A-Za-z0-9._%+-]+@[A-Za-z0-9._%+-]+$/
const EMAIL_ERROR = 'Enter an email address, or leave it empty'
/** the names Windows reserves for devices: no folder can take one */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/
const SLUG_MAX = 32

/** the accounts folder: the override when set, the test folder under the data folder in a test run, else <home>/.claude-accounts */
export function accountsRoot(env: NodeJS.ProcessEnv, home: string, dataDir: string): string {
  const override = env[ACCOUNTS_ROOT_ENV]
  if (override) return override
  if (env.CLAUDETERM_TEST === '1') return join(dataDir, 'claude-accounts')
  return join(home, '.claude-accounts')
}

/** a folder name from an account name: a-z, 0-9 and dashes, at most 32 characters; never a Windows device name */
export function folderSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(NON_ASCII, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
  if (slug === '') return 'account'
  return DEVICE.test(slug) ? `${slug}-account` : slug
}

/** the folder of a new account under the root: its slug, else the slug with -2, -3… for the first one `taken` does not name */
export function accountFolder(root: string, name: string, taken: (path: string) => boolean): string {
  const slug = folderSlug(name)
  let folder = join(root, slug)
  for (let n = 2; taken(folder); n++) folder = join(root, `${slug}-${n}`)
  return folder
}

export type EmailCheck = { ok: true; value: string | null } | { ok: false; error: string }

/** an optional email for the sign-in: trimmed, empty means none; else at most 254 characters of one address */
export function checkEmail(raw: unknown): EmailCheck {
  if (typeof raw !== 'string') return { ok: false, error: EMAIL_ERROR }
  const email = raw.trim()
  if (email === '') return { ok: true, value: null }
  if (email.length > MAX_EMAIL || !EMAIL.test(email)) return { ok: false, error: EMAIL_ERROR }
  return { ok: true, value: email }
}

/** the command that signs an account in: `<command> auth login --claudeai`, with the email for the sign-in page when there is one */
export function signInCommand(command: string, family: ShellFamily, email: string | null): string {
  const line = `${command} auth login --claudeai`
  return email === null ? line : `${line} --email ${quoteForShell(family, email)}`
}

export interface Identity {
  email: string | null
  orgName: string | null
  orgUuid: string | null
  plan: string | null
}

export const NO_IDENTITY: Identity = { email: null, orgName: null, orgUuid: null, plan: null }

export type AuthStatus = { state: 'signed-in'; identity: Identity } | { state: 'signed-out' } | { state: 'unknown'; reason: string }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** a text field: a non-empty string without control characters, at most `max` long; anything else is null */
function textOf(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v === '' || v.length > max || CONTROL.test(v)) return null
  return v
}

/** an email field: a text field of at most 254 characters that holds an @ */
function emailOf(v: unknown): string | null {
  const email = textOf(v, MAX_EMAIL)
  return email !== null && email.includes('@') ? email : null
}

/**
 * `claude auth status --json` of a run: exit 0 with a claude.ai login is signed in; exit 1, or exit 0 with another
 * method, is signed out; anything else is unknown. Every field is checked: a bad one is left out, the rest is kept.
 */
export function parseAuthStatus(run: Pick<CliRun, 'code' | 'stdout'>): AuthStatus {
  if (run.code === 1) return { state: 'signed-out' }
  const data = jsonOutput(run.stdout)
  if (run.code !== 0 || !isObject(data) || typeof data.authMethod !== 'string') {
    return { state: 'unknown', reason: 'Claude Code did not say whether this account is signed in' }
  }
  if (data.authMethod !== 'claude.ai') return { state: 'signed-out' }
  return {
    state: 'signed-in',
    identity: {
      email: emailOf(data.email) ?? emailOf(data.emailAddress),
      orgName: textOf(data.orgName, MAX_TEXT) ?? textOf(data.organizationName, MAX_TEXT),
      orgUuid: textOf(data.orgId, MAX_TEXT) ?? textOf(data.organizationUuid, MAX_TEXT) ?? textOf(data.organizationId, MAX_TEXT),
      plan: planOf(data.subscriptionType ?? data.organizationType)
    }
  }
}

/** the login in the account file (.claude.json's oauthAccount); nothing else of the file is read */
export function identityOf(claudeJson: string | null): Identity {
  if (claudeJson === null) return NO_IDENTITY
  let data: unknown
  try {
    data = JSON.parse(claudeJson)
  } catch {
    return NO_IDENTITY
  }
  const account = isObject(data) ? data.oauthAccount : undefined
  if (!isObject(account)) return NO_IDENTITY
  return {
    email: emailOf(account.emailAddress),
    orgName: textOf(account.organizationName, MAX_TEXT),
    orgUuid: textOf(account.organizationUuid, MAX_TEXT),
    plan: planOf(account.organizationType)
  }
}

/** the fields of `first`, and the fields of `then` where `first` has none */
export function mergeIdentity(first: Identity, then: Identity): Identity {
  return {
    email: first.email ?? then.email,
    orgName: first.orgName ?? then.orgName,
    orgUuid: first.orgUuid ?? then.orgUuid,
    plan: first.plan ?? then.plan
  }
}

/** the same login: the same email (ignoring case) and the same organization; without a known organization, the emails decide */
export function sameLogin(a: Identity, b: Identity): boolean {
  if (a.email === null || b.email === null || a.email.toLowerCase() !== b.email.toLowerCase()) return false
  if (a.orgUuid !== null && b.orgUuid !== null) return a.orgUuid.toLowerCase() === b.orgUuid.toLowerCase()
  if (a.orgName !== null && b.orgName !== null) return a.orgName === b.orgName
  return true
}

/** the real path of a folder; for a path that does not exist yet, its parent's real path joined with its name */
export async function canonical(path: string): Promise<string> {
  try {
    await stat(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return join(await canonical(parent), basename(path))
  }
  return canonicalFolder(path)
}

/** whether a folder's real path is inside the accounts root, not the root itself: both are made real first, so case, 8.3 names and junctions count */
export async function inAccountsRoot(path: string, root: string): Promise<boolean> {
  const real = await canonical(path)
  const base = await canonical(root)
  return pathKey(real) !== pathKey(base) && isWithin(base, real)
}

/** whether the candidate is one of the others, inside one of them, or holds one of them (all paths canonical) */
export function clashes(candidate: string, others: string[]): boolean {
  return others.some((other) => isWithin(other, candidate) || isWithin(candidate, other))
}
