import { describe, expect, it } from 'vitest'
import { cliMessage, jsonOutput } from '../../src/main/mcp/claude-cli'

describe('jsonOutput', () => {
  it('takes the last JSON line after a banner', () => {
    expect(jsonOutput('Welcome!\n[{"id":"a@b"}]\n')).toEqual([{ id: 'a@b' }])
  })

  it('takes the whole output when it parses', () => {
    expect(jsonOutput('{\n  "loggedIn": true,\n  "email": "a@b"\n}\n')).toEqual({ loggedIn: true, email: 'a@b' })
  })

  it('is undefined for text', () => {
    expect(jsonOutput('not logged in\n')).toBeUndefined()
  })
})

describe('cliMessage', () => {
  it('keeps the last lines of stderr without colours, at most 500 chars', () => {
    const stderr = ['one', '', '\x1b[31mtwo\x1b[0m', 'three', 'four', ''].join('\n')
    expect(cliMessage({ code: 1, stdout: 'ignored', stderr })).toBe('two\nthree\nfour')
    expect(cliMessage({ code: 1, stdout: '', stderr: 'y'.repeat(900) })).toHaveLength(500)
  })

  it('falls back to stdout when stderr is empty', () => {
    expect(cliMessage({ code: 1, stdout: 'Not logged in\n', stderr: '  \n' })).toBe('Not logged in')
  })
})
