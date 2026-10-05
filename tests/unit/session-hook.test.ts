import { describe, expect, it, vi } from 'vitest'
import { runSessionHook, runStatusLine } from '../../src/hook/session-hook'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const TP = 'C:\\Users\\me\\.claude\\projects\\D--x\\5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8.jsonl'
const input = JSON.stringify({ session_id: SID, transcript_path: TP, cwd: 'D:\\x', hook_event_name: 'SessionStart', source: 'clear' })

describe('runSessionHook', () => {
  it('sends the session id and transcript path for the tab', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runSessionHook(input, { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: '\\\\.\\pipe\\x' }, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: TP })
  })

  it('does nothing outside a ClaudeTerm tab', async () => {
    const send = vi.fn()
    expect(await runSessionHook(input, {}, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores bad stdin and non-UUID session ids', async () => {
    const send = vi.fn()
    expect(await runSessionHook('not json', { CLAUDETERM_TAB_ID: TAB }, send)).toBe(false)
    expect(await runSessionHook(JSON.stringify({ session_id: 'x' }), { CLAUDETERM_TAB_ID: TAB }, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows send failures', async () => {
    const send = vi.fn(async () => { throw new Error('no pipe') })
    await expect(runSessionHook(input, { CLAUDETERM_TAB_ID: TAB }, send)).resolves.toBe(false)
  })
})

const ENV = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: '\\\\.\\pipe\\x' }
const AGENT = 'a40a10c1d655cf759'

describe('runSessionHook: other hook events', () => {
  it('maps SubagentStart and SubagentStop to subagent messages', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'Explore' }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: AGENT, agent_type: 'Explore', effort: 'high' }), ENV, send)
    expect(send).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\x', { v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'start', agentId: AGENT, agentType: 'Explore' })
    expect(send).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\x', { v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'stop', agentId: AGENT, agentType: 'Explore' })
  })

  it('maps SessionEnd to session_end', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SessionEnd', reason: 'clear' }), ENV, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'session_end', tabId: TAB, sessionId: SID })
  })

  it('ignores other events and subagent events without agent_id', async () => {
    const send = vi.fn()
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse' }), ENV, send)).toBe(false)
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStart' }), ENV, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('runStatusLine', () => {
  const input = JSON.stringify({ session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } })

  it('sends the status for the tab', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runStatusLine(input, ENV, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', {
      v: 1, type: 'status', tabId: TAB, sessionId: SID,
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: null, context: null, fiveHour: null
    })
  })

  it('does nothing outside a tab or for bad stdin, and swallows send failures', async () => {
    const send = vi.fn()
    expect(await runStatusLine(input, {}, send)).toBe(false)
    expect(await runStatusLine('not json', ENV, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    await expect(runStatusLine(input, ENV, async () => { throw new Error('no pipe') })).resolves.toBe(false)
  })
})
