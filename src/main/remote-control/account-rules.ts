import { REMOTE_REASONS } from '../../shared/remote-control'

/** main: the default account; login: a sign-in account with its own config folder; token: an account that signs in with a token */
export type RemoteAccountKind = 'main' | 'login' | 'token'

const SIGN_IN_VARIABLES = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
const DEFAULT_BASE_URL = 'https://api.anthropic.com'

/** Windows reads environment names without regard to case, so a lowercase name still counts */
function variable(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find(k => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function signsInFromEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  if (SIGN_IN_VARIABLES.some(name => variable(env, name))) return true
  return PROVIDER_SWITCHES.some(name => ['1', 'true', 'yes', 'on'].includes((variable(env, name) ?? '').trim().toLowerCase()))
}

/** why Remote Control cannot run for this account with this environment, or null when it can */
export function remoteUnavailable(kind: RemoteAccountKind, env: Readonly<Record<string, string | undefined>>): string | null {
  if (kind === 'token' || signsInFromEnvironment(env)) return REMOTE_REASONS.token
  const baseUrl = variable(env, 'ANTHROPIC_BASE_URL') ?? ''
  if (baseUrl !== '' && baseUrl.trim().toLowerCase().replace(/\/$/, '') !== DEFAULT_BASE_URL) return REMOTE_REASONS.baseUrl
  return null
}
