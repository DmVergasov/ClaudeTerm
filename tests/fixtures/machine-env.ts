import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The variables of the machine's own Claude Code and ClaudeTerm. A shell the tests run from, or a Claude Code session that
 * runs them, points CLAUDE_CONFIG_DIR at the person's config folder (their login, conversations and settings), carries a
 * sign-in (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL) and the pipe and tab of the ClaudeTerm it runs
 * in (CLAUDETERM_PIPE, CLAUDETERM_TAB_ID). Names are matched in any case: Windows reads them so.
 */
const MACHINE_VARIABLE = /^(CLAUDE|ANTHROPIC_)/i

/**
 * Keeps the machine's Claude Code and ClaudeTerm out of the environment: every variable of theirs goes, and the home
 * folder is <root>/home, made here, so that Claude Code, the stand-in and the app find no ~/.claude or ~/.claude.json of
 * the person's when no CLAUDE_CONFIG_DIR is set. A test that needs a config folder or a home folder sets its own.
 */
export function isolateFromMachine(env: NodeJS.ProcessEnv, root: string): void {
  for (const key of Object.keys(env)) if (MACHINE_VARIABLE.test(key)) delete env[key]
  // an X display whose cookie is in the old home's .Xauthority, as XAUTHORITY is not set, stays reachable from the new one
  const xauthority = env.HOME === undefined ? null : join(env.HOME, '.Xauthority')
  if (env.XAUTHORITY === undefined && xauthority !== null && existsSync(xauthority)) env.XAUTHORITY = xauthority
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  env.HOME = home
  env.USERPROFILE = home
}
