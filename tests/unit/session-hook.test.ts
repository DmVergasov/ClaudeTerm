import { describe, expect, it, vi } from 'vitest'
import { runSessionHook } from '../../src/hook/session-hook'

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
