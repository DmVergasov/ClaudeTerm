import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathKey } from '../path-key'

/** the claude.ai sign-in Claude Code stores for one account: read only, never written, refreshed or deleted here */
export interface ClaudeCredentials {
  /** the stored claude.ai access token while it is fresh */
  accessToken: string | null
  deviceToken: string | null
  /** fresh: accessToken is set; expired: a claude.ai sign-in whose token has expired; none: no claude.ai sign-in stored; unusable: a stored record with no usable token */
  state: 'fresh' | 'expired' | 'none' | 'unusable'
}

export interface CredentialSources {
  platform: NodeJS.Platform
  home: string
  username: string
  now(): number
  /** runs `security` with these arguments (no shell, 5 s limit): its stdout, or null when it failed; null on a test run, where the Keychain is never read */
  security: ((args: string[]) => Promise<string | null>) | null
}

const SERVICE = 'Claude Code-credentials'
const CREDENTIALS_FILE = '.credentials.json'
/** a token is 1 to 8192 printable ASCII characters, no space */
const TOKEN_TEXT = /^[\x21-\x7e]{1,8192}$/

type JsonObject = { [key: string]: unknown }

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tokenText(value: unknown): string | null {
  return typeof value === 'string' && TOKEN_TEXT.test(value) ? value : null
}

/** the Keychain service name Claude Code uses for a config folder: the default folder has the plain name, another folder a suffix */
export function keychainService(folder: string, home: string): string {
  if (pathKey(folder) === pathKey(join(home, '.claude'))) return SERVICE
  return `${SERVICE}-${createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0, 8)}`
}

/** runs a program with no shell and a 5 s limit; its stdout, or null when it failed */
export function securityRunner(file = 'security'): (args: string[]) => Promise<string | null> {
  return args => new Promise(resolve => {
    execFile(file, args, { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout))
  })
}

async function readJsonObject(file: string): Promise<JsonObject | 'bad' | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : 'bad'
  } catch {
    return 'bad'
  }
}

/** the record of the account: the Keychain's on macOS when it answers with a JSON object, else the file's */
async function loadRecord(folder: string, s: CredentialSources): Promise<JsonObject | 'bad' | null> {
  if (s.platform === 'darwin' && s.security) {
    let answer: string | null = null
    try {
      answer = await s.security(['find-generic-password', '-s', keychainService(folder, s.home), '-a', s.username, '-w'])
    } catch {
      answer = null
    }
    if (answer !== null) {
      try {
        const value: unknown = JSON.parse(answer.trim())
        if (isRecord(value)) return value
      } catch {
        // not JSON: the file is read instead
      }
    }
  }
  return readJsonObject(join(folder, CREDENTIALS_FILE))
}

/** the account's .claude.json: `<home>/.claude.json` for the default folder, else `<folder>/.claude.json` */
function accountFile(folder: string, home: string): string {
  return pathKey(folder) === pathKey(join(home, '.claude')) ? join(home, '.claude.json') : join(folder, '.claude.json')
}

/** the claude.ai sign-in of the account at `folder`, read without writing anything */
export async function readClaudeCredentials(folder: string, env: Readonly<Record<string, string | undefined>>, s: CredentialSources): Promise<ClaudeCredentials> {
  const record = await loadRecord(folder, s)
  const stored = isRecord(record) ? record : {}
  const accountJson = await readJsonObject(accountFile(folder, s.home))
  const deviceToken = tokenText(env.CLAUDE_TRUSTED_DEVICE_TOKEN)
    ?? tokenText(stored.trustedDeviceToken)
    ?? tokenText(isRecord(accountJson) ? accountJson.trustedDeviceToken : undefined)

  const none = { accessToken: null, deviceToken, state: 'none' as const }
  if (record === null) return none
  if (record === 'bad') return { accessToken: null, deviceToken, state: 'unusable' }
  if (stored.claudeAiOauth === undefined) return none
  if (!isRecord(stored.claudeAiOauth)) return { accessToken: null, deviceToken, state: 'unusable' }
  const oauth = stored.claudeAiOauth
  const accessToken = tokenText(oauth.accessToken)
  if (accessToken === null) return { accessToken: null, deviceToken, state: 'unusable' }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= s.now()) return { accessToken: null, deviceToken, state: 'expired' }
  return { accessToken, deviceToken, state: 'fresh' }
}
