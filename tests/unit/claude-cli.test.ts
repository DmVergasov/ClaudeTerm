import { describe, expect, it } from 'vitest'
import { cliMessage, jsonOutput } from '../../src/main/mcp/claude-cli'

describe('jsonOutput', () => {
  it('jsonOutput takes the last JSON line after a banner', () => {
    expect(jsonOutput('Welcome!\n[{"id":"a@b"}]\n')).toEqual([{ id: 'a@b' }])
  })

  it('jsonOutput is undefined for text', () => {
    expect(jsonOutput('Added stdio MCP server docs to user config\n')).toBeUndefined()
  })
})

describe('cliMessage', () => {
  it('cliMessage keeps the last lines of stderr without colours, at most 500 chars', () => {
    const stderr = 'first\n\x1b[31mred\x1b[0m\nthird line\n\n\x1b]0;title\x07fourth\n'
    expect(cliMessage({ code: 1, stdout: 'ignored', stderr })).toBe('red\nthird line\nfourth')
    expect(cliMessage({ code: 1, stdout: 'from stdout\n', stderr: '' })).toBe('from stdout')
    expect(cliMessage({ code: 1, stdout: '', stderr: 'x'.repeat(900) }).length).toBeLessThanOrEqual(500)
  })
})
