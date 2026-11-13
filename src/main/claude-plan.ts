import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** a .claude.json larger than this is not read: the plan is a nicety, not worth a long read */
const MAX_BYTES = 4 * 1024 * 1024

/** the subscriptions Claude Code's login names, as the account block at the foot of the tabs shows them */
const PLANS: Record<string, string> = {
  claude_max: 'Max plan',
  claude_pro: 'Pro plan',
  claude_team: 'Team plan',
  claude_enterprise: 'Enterprise plan'
}

/** Claude Code keeps its login in .claude.json: in the home folder, or in <config> when CLAUDE_CONFIG_DIR moves it. */
export function claudeAccountFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR || home, '.claude.json')
}

/**
 * The plan of the login Claude Code keeps (`oauthAccount.organizationType`), or null when the file has none it knows. The
 * file is Claude Code's and its format is not documented: anything unexpected names no plan. Only that one field is read.
 */
export function planName(text: string | null): string | null {
  const account = oauthAccount(settingsOf(text))
  const type = account?.organizationType
  return typeof type === 'string' && Object.hasOwn(PLANS, type) ? PLANS[type]! : null
}

/**
 * The login Claude Code keeps, as a string that changes with its account or its organization (`accountUuid`,
 * `organizationUuid`): the usage limits are the login's, and another login has its own. Null when the file holds no
 * login; undefined when the text is not a settings object (a file caught while being written), which tells nothing.
 */
export function loginOf(text: string | null): string | null | undefined {
  const data = settingsOf(text)
  if (data === null) return undefined
  const account = oauthAccount(data)
  if (account === null) return null
  const id = (v: unknown): string => (typeof v === 'string' ? v : '')
  const login = `${id(account.accountUuid)} ${id(account.organizationUuid)}`
  return login === ' ' ? null : login
}

/** Claude Code's .claude.json text as its object; null for text that is none */
function settingsOf(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null
}

/** the login block of the settings; null when they hold none */
function oauthAccount(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const account = data?.oauthAccount
  return typeof account === 'object' && account !== null && !Array.isArray(account) ? (account as Record<string, unknown>) : null
}

/** reads the plan from the file; a missing, huge or unreadable file names none */
export async function readPlan(file: string): Promise<string | null> {
  try {
    if ((await stat(file)).size > MAX_BYTES) return null
    return planName(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** reads the login from the file, as loginOf says; a missing, huge or unreadable file tells nothing */
export async function readLogin(file: string): Promise<string | null | undefined> {
  try {
    if ((await stat(file)).size > MAX_BYTES) return undefined
    return loginOf(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}
