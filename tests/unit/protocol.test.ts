import { describe, expect, it } from 'vitest'
import { defaultPipeName, encodeMessage, isUuid, parsePipeMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

describe('parsePipeMessage', () => {
  it('accepts a show_image message', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', tabId: TAB, path: 'D:\\proj\\out\\plot.png', caption: 'Plot' }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'show_image', tabId: TAB, path: 'D:\\proj\\out\\plot.png', caption: 'Plot' } })
  })

  it('defaults missing tabId and caption to null', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: 'C:\\a.png' }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'show_image', tabId: null, path: 'C:\\a.png', caption: null } })
  })

  it('truncates captions to 500 characters', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: 'C:\\a.png', caption: 'x'.repeat(900) }))
    expect(r.ok && r.message.type === 'show_image' && r.message.caption?.length).toBe(500)
  })

  it('rejects relative paths, bad JSON, non-objects, unknown versions and types', () => {
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: 'out\\a.png' })).ok).toBe(false)
    expect(parsePipeMessage('{not json').ok).toBe(false)
    expect(parsePipeMessage('[1,2]').ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ v: 2, type: 'show_image', path: 'C:\\a.png' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'run', cmd: 'calc' })).ok).toBe(false)
  })

  it('accepts a session message with transcript path', () => {
    const tp = 'C:\\Users\\u\\.claude\\projects\\D--x\\s.jsonl'
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: tp }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: tp } })
  })

  it('nulls an invalid transcript path and defaults source', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: TAB, sessionId: SID, transcriptPath: 'C:\\x\\evil.exe' }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'unknown', transcriptPath: null } })
  })

  it('rejects a session message with non-UUID ids', () => {
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: TAB, sessionId: 'abc; rm -rf /' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: 'nope', sessionId: SID })).ok).toBe(false)
  })
})

describe('helpers', () => {
  it('isUuid', () => {
    expect(isUuid(SID)).toBe(true)
    expect(isUuid('5d2c1b7a')).toBe(false)
    expect(isUuid(42)).toBe(false)
  })

  it('defaultPipeName sanitizes the user name', () => {
    expect(defaultPipeName('John Doe')).toBe('\\\\.\\pipe\\claudeterm-John_Doe')
  })

  it('encodeMessage produces one line', () => {
    expect(encodeMessage({ ok: true })).toBe('{"ok":true}\n')
  })
})
