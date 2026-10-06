import { describe, expect, it } from 'vitest'
import { defaultPipeName, encodeMessage, isUuid, parsePipeMessage } from '../../src/shared/protocol'
import { WIN } from '../fixtures/platform'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
// parsePipeMessage checks paths with the platform's isAbsolute: the samples are absolute where the tests run
const PLOT = WIN ? 'D:\\proj\\out\\plot.png' : '/proj/out/plot.png'
const A_PNG = WIN ? 'C:\\a.png' : '/a.png'
const TP = WIN ? 'C:\\Users\\u\\.claude\\projects\\D--x\\s.jsonl' : '/home/u/.claude/projects/-x/s.jsonl'
const EVIL = WIN ? 'C:\\x\\evil.exe' : '/x/evil.exe'

describe('parsePipeMessage', () => {
  it('accepts a show_image message', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', tabId: TAB, path: PLOT, caption: 'Plot' }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'show_image', tabId: TAB, path: PLOT, caption: 'Plot' } })
  })

  it('defaults missing tabId and caption to null', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: A_PNG }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'show_image', tabId: null, path: A_PNG, caption: null } })
  })

  it('truncates captions to 500 characters', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: A_PNG, caption: 'x'.repeat(900) }))
    expect(r.ok && r.message.type === 'show_image' && r.message.caption?.length).toBe(500)
  })

  it('rejects relative paths, bad JSON, non-objects, unknown versions and types', () => {
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: 'out\\a.png' })).ok).toBe(false)
    expect(parsePipeMessage('{not json').ok).toBe(false)
    expect(parsePipeMessage('[1,2]').ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ v: 2, type: 'show_image', path: A_PNG })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'run', cmd: 'calc' })).ok).toBe(false)
  })

  it('accepts a session message with transcript path', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: TP }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: TP } })
  })

  it('nulls an invalid transcript path and defaults source', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: TAB, sessionId: SID, transcriptPath: EVIL }))
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

  it('defaultPipeName: a named pipe on Windows, with the user name sanitized', () => {
    expect(defaultPipeName('John Doe', { platform: 'win32', env: {}, uid: -1 })).toBe('\\\\.\\pipe\\claudeterm-John_Doe')
  })

  it('defaultPipeName: a socket in XDG_RUNTIME_DIR on Linux, else in a private folder in /tmp', () => {
    expect(defaultPipeName('John Doe', { platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' }, uid: 1000 })).toBe('/run/user/1000/claudeterm-John_Doe.sock')
    expect(defaultPipeName('jd', { platform: 'linux', env: {}, uid: 1000 })).toBe('/tmp/claudeterm-1000/claudeterm-jd.sock')
    expect(defaultPipeName('jd', { platform: 'linux', env: { XDG_RUNTIME_DIR: 'relative' }, uid: 1000 })).toBe('/tmp/claudeterm-1000/claudeterm-jd.sock')
  })

  it('encodeMessage produces one line', () => {
    expect(encodeMessage({ ok: true })).toBe('{"ok":true}\n')
  })
})

describe('status, subagent and session_end messages', () => {
  const ids = { v: 1, tabId: TAB, sessionId: SID }

  it('accepts a full status message', () => {
    const msg = {
      ...ids,
      type: 'status',
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      effort: 'xhigh',
      context: { usedTokens: 82314, size: 200000, usedPct: 41.2 },
      fiveHour: { usedPct: 23.5, resetsAt: 1790000000 },
      sevenDay: { usedPct: 41.2, resetsAt: 1790500000 }
    }
    expect(parsePipeMessage(JSON.stringify(msg))).toEqual({ ok: true, message: msg })
  })

  it('nulls malformed optional parts and defaults displayName to the model id', () => {
    const r = parsePipeMessage(JSON.stringify({ ...ids, type: 'status', model: { id: 'claude-x' }, effort: 7, context: { usedTokens: 'a', size: 1, usedPct: 1 }, fiveHour: { usedPct: 5 }, sevenDay: { resetsAt: 5 } }))
    expect(r).toEqual({ ok: true, message: { ...ids, type: 'status', model: { id: 'claude-x', displayName: 'claude-x' }, effort: null, context: null, fiveHour: null, sevenDay: null } })
  })

  it('rejects a zero context size', () => {
    const r = parsePipeMessage(JSON.stringify({ ...ids, type: 'status', model: { id: 'm' }, context: { usedTokens: 1, size: 0, usedPct: 1 } }))
    expect(r.ok && r.message.type === 'status' && r.message.context).toBe(null)
  })

  it('truncates labels to 100 characters', () => {
    const r = parsePipeMessage(JSON.stringify({ ...ids, type: 'status', model: { id: 'm'.repeat(300), displayName: 'd'.repeat(300) }, effort: 'e'.repeat(300) }))
    expect(r.ok && r.message.type === 'status' && [r.message.model.id.length, r.message.model.displayName.length, r.message.effort?.length]).toEqual([100, 100, 100])
  })

  it('rejects a status without model id or with bad ids', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'status', model: {} })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'status', tabId: 'x', model: { id: 'm' } })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'status', sessionId: 'x', model: { id: 'm' } })).ok).toBe(false)
  })

  it('accepts subagent start/stop and defaults agentType', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'start', agentId: 'a40a10c1d655cf759', agentType: 'Explore' }))).toEqual({
      ok: true,
      message: { ...ids, type: 'subagent', event: 'start', agentId: 'a40a10c1d655cf759', agentType: 'Explore' }
    })
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'stop', agentId: 'a1' }))).toEqual({
      ok: true,
      message: { ...ids, type: 'subagent', event: 'stop', agentId: 'a1', agentType: 'agent' }
    })
  })

  it('rejects a bad subagent event or agentId', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'pause', agentId: 'a1' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'start', agentId: '../x' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'start', agentId: 'a'.repeat(65) })).ok).toBe(false)
  })

  it('accepts session_end and rejects it with a bad session id', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'session_end' }))).toEqual({ ok: true, message: { ...ids, type: 'session_end' } })
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'session_end', sessionId: 'x' })).ok).toBe(false)
  })

  it('accepts attention with a known reason', () => {
    for (const reason of ['permission', 'question', 'done']) {
      expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'attention', reason }))).toEqual({ ok: true, message: { ...ids, type: 'attention', reason } })
    }
  })

  it('rejects attention with an unknown reason or bad ids', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'attention', reason: 'idle' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'attention' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'attention', reason: 'done', tabId: 'x' })).ok).toBe(false)
  })
})
