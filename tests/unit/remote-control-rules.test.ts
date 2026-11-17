import { describe, expect, it } from 'vitest'
import { accountLaunchEnv } from '../../src/main/remote-control/account-env'
import { remoteUnavailable } from '../../src/main/remote-control/account-rules'
import { connectTimeoutToast, isBridgeId, REMOTE_REASONS, refusedReason, remoteLink, remoteName, RENEW_WAIT_NOTE } from '../../src/shared/remote-control'

const TOKEN = 'This account signs in with a token: Remote Control needs a claude.ai sign-in'
const BASE = "Remote Control needs Anthropic's own service: this account uses ANTHROPIC_BASE_URL"

describe('remoteName', () => {
  it('is the tab title without control characters, cut to 60 characters', () => {
    expect(remoteName('Fix the\tparser\n')).toBe('Fix theparser')
    expect(remoteName('x'.repeat(70))).toBe('x'.repeat(60))
    expect(Array.from(remoteName('😀'.repeat(70)))).toHaveLength(60)
  })
  it("drops the spinner Claude Code puts before its title, and leading dashes, so --rc never reads the name as an option", () => {
    expect(remoteName('✳ Fix the parser')).toBe('Fix the parser')
    expect(remoteName('--force push')).toBe('force push')
    // a name that starts with a dash after a space would read as an option after --rc
    expect(remoteName('- -x')).toBe('x')
  })
  it('is ClaudeTerm when nothing is left: /remote-control without a name would disconnect instead', () => {
    expect(remoteName('')).toBe('ClaudeTerm')
    expect(remoteName(' \u0007 ')).toBe('ClaudeTerm')
  })
})

describe('the id, the link and the copy', () => {
  it('an id is 1 to 128 letters, digits, _ and -', () => {
    for (const ok of ['session_011edtAbC', 'cse_01Hk-x', 'x'.repeat(128)]) expect(isBridgeId(ok)).toBe(true)
    for (const bad of ['', 'a b', 'x'.repeat(129), 'a/b', 42, null, undefined]) expect(isBridgeId(bad)).toBe(false)
  })
  it('the link, the reasons and the toast are the spec’s words', () => {
    expect(remoteLink('cse_1')).toBe('https://claude.ai/code/cse_1')
    expect(refusedReason(403)).toBe('claude.ai refused Remote Control (403)')
    expect(connectTimeoutToast('work')).toBe('Remote Control did not connect in work: see the terminal')
    expect(RENEW_WAIT_NOTE).toBe("Waiting for Claude Code to renew this account's sign-in")
    expect(REMOTE_REASONS).toEqual({
      token: TOKEN,
      baseUrl: BASE,
      noSignIn: 'No claude.ai sign-in found for this account',
      bridgeChanged: "This ClaudeTerm cannot host Remote Control: the Agent SDK's bridge changed",
      relogin: 'Sign in to this account again (claude auth login)',
      untrustedDevice: 'Turn Remote Control on once in a terminal tab of this account: Claude Code registers this computer then',
      unreachable: 'claude.ai could not be reached'
    })
  })
})

describe('remoteUnavailable', () => {
  it('a token account is unavailable with the token reason', () => {
    expect(remoteUnavailable('token', {})).toBe(TOKEN)
  })
  it('a sign-in from the environment makes the main account and a sign-in account unavailable with the same reason', () => {
    const signIns: [string, string][] = [['CLAUDE_CODE_OAUTH_TOKEN', 't'], ['ANTHROPIC_API_KEY', 'k'], ['ANTHROPIC_AUTH_TOKEN', 'a'], ['CLAUDE_CODE_USE_BEDROCK', '1'], ['CLAUDE_CODE_USE_VERTEX', 'true'], ['CLAUDE_CODE_USE_FOUNDRY', 'yes']]
    for (const [name, value] of signIns) {
      expect(remoteUnavailable('main', { [name]: value })).toBe(TOKEN)
      expect(remoteUnavailable('login', { [name]: value })).toBe(TOKEN)
    }
  })
  it('an empty variable, or a provider switch that is off, is no sign-in', () => {
    expect(remoteUnavailable('main', { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'false' })).toBeNull()
  })
  it('a non-default ANTHROPIC_BASE_URL is unavailable; the default, with or without its slash, and an empty one are not', () => {
    expect(remoteUnavailable('main', { ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe(BASE)
    expect(remoteUnavailable('login', { ANTHROPIC_BASE_URL: 'http://localhost:8080/' })).toBe(BASE)
    for (const fine of ['https://api.anthropic.com', 'https://api.anthropic.com/', 'HTTPS://API.ANTHROPIC.COM', '']) expect(remoteUnavailable('main', { ANTHROPIC_BASE_URL: fine })).toBeNull()
  })
  it('the sign-in rule comes before the base URL rule', () => {
    expect(remoteUnavailable('main', { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.example.com' })).toBe(TOKEN)
  })
  it('names are matched ignoring case, as Windows reads them', () => {
    expect(remoteUnavailable('main', { anthropic_api_key: 'k' })).toBe(TOKEN)
    expect(remoteUnavailable('main', { Anthropic_Base_Url: 'https://proxy.example.com' })).toBe(BASE)
  })
  it('the main account and a sign-in account with a plain environment can use RC', () => {
    expect(remoteUnavailable('main', { PATH: '/usr/bin' })).toBeNull()
    expect(remoteUnavailable('login', { CLAUDE_CONFIG_DIR: '/accounts/work' })).toBeNull()
  })
})

describe('accountLaunchEnv', () => {
  it('an account’s settings.json env sits under the launch environment, which wins, names matched ignoring case', () => {
    const merged = accountLaunchEnv({ ANTHROPIC_BASE_URL: 'https://settings.example.invalid', KEEP: 'yes' }, { anthropic_base_url: 'https://launch.example.invalid' })
    expect(merged).toEqual({ KEEP: 'yes', anthropic_base_url: 'https://launch.example.invalid' })
    expect(remoteUnavailable('main', merged)).toBe(BASE)
  })
  it('with no settings env, the launch environment is what it was', () => {
    expect(accountLaunchEnv({}, { PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})
