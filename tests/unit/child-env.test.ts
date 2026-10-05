import { describe, expect, it } from 'vitest'
import { buildChildEnv } from '../../src/main/child-env'

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
