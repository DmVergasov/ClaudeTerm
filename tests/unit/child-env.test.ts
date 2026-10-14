import { describe, expect, it } from 'vitest'
import { applyEnvPatch, buildChildEnv } from '../../src/main/child-env'

describe('buildChildEnv', () => {
  it('strips ClaudeTerm, Electron and Windows Terminal markers and sets terminal identity', () => {
    const env = buildChildEnv({
      PATH: 'C:\\Windows',
      CLAUDETERM_TAB_ID: 'x',
      CLAUDETERM_PIPE: 'p',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RENDERER_URL: 'http://localhost',
      WT_SESSION: 'abc',
      WT_PROFILE_ID: '{guid}',
      TERM_PROGRAM: 'WindowsTerminal'
    })
    expect(env).toEqual({ PATH: 'C:\\Windows', TERM_PROGRAM: 'ClaudeTerm', COLORTERM: 'truecolor' })
  })
})

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
