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
  if (text === null) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const account = (data as Record<string, unknown>).oauthAccount
  if (typeof account !== 'object' || account === null) return null
  const type = (account as Record<string, unknown>).organizationType
  return typeof type === 'string' && Object.hasOwn(PLANS, type) ? PLANS[type]! : null
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
