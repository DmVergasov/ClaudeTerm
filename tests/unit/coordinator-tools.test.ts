import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coordTool, type CoordToolDeps } from '../../src/mcp/coordinator-tools'
import { PipeUnavailableError } from '../../src/shared/pipe-client'
import type { CoordMessage, PipeResponse } from '../../src/shared/protocol'
import { WIN } from '../fixtures/platform'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const CWD = WIN ? 'C:\\proj' : '/proj'
const deps = (send: CoordToolDeps['send'], tabId: string | null = TAB): CoordToolDeps => ({ tabId, pipeName: 'pipe', cwd: CWD, send })
const refuse = async (): Promise<PipeResponse> => {
  throw new Error('must not be called')
}

describe('coordTool', () => {
  it('each tool sends its op with the tab id and returns the info', async () => {
    const sent: CoordMessage[] = []
    const send: CoordToolDeps['send'] = async (_p, m) => {
      sent.push(m)
      return { ok: true, info: 'answer' }
    }
    const calls = [
      ['list_sessions', { op: 'list' }],
      ['attach_session', { op: 'attach', session: 'a10000' }],
      ['detach_session', { op: 'detach', session: 'a10000' }],
      ['read_session', { op: 'read', session: 'a10000' }],
      ['resolve_session', { op: 'resolve', session: 'a10000' }],
      ['message_session', { op: 'message', session: 'a10000', text: 'Fix the parser.' }]
    ] as const
    for (const [name, op] of calls) expect(await coordTool(name, op, deps(send))).toEqual({ text: 'answer', isError: false })
    expect(sent).toEqual(calls.map(([, op]) => ({ v: 1, type: 'coord', tabId: TAB, ...op })))
  })

  it('start_session resolves a relative folder against the folder Claude runs in, and waits 30 s for the answer', async () => {
    const sent: CoordMessage[] = []
    const timeouts: number[] = []
    const r = await coordTool('start_session', { op: 'start', task: 'T', name: null, folder: 'pkg', device: null, worktree: null }, deps(async (_p, m, ms) => {
      sent.push(m)
      timeouts.push(ms)
      return { ok: true, info: 'Started a10000.' }
    }))
    expect(sent[0]).toEqual({ v: 1, type: 'coord', tabId: TAB, op: 'start', task: 'T', name: null, folder: join(CWD, 'pkg'), device: null, worktree: null })
    expect(timeouts).toEqual([30000])
    expect(r).toEqual({ text: 'Started a10000.', isError: false })
  })

  it('the other tools wait 3 s for the answer', async () => {
    const timeouts: number[] = []
    await coordTool('list_sessions', { op: 'list' }, deps(async (_p, _m, ms) => {
      timeouts.push(ms)
      return { ok: true }
    }))
    expect(timeouts).toEqual([3000])
  })

  it('says Done. when ClaudeTerm sends no info', async () => {
    expect(await coordTool('resolve_session', { op: 'resolve', session: 'a10000' }, deps(async () => ({ ok: true }))))
      .toEqual({ text: 'Done.', isError: false })
  })

  it('returns a refusal of ClaudeTerm as an error', async () => {
    expect(await coordTool('attach_session', { op: 'attach', session: 'a10000' }, deps(async () => ({ ok: false, error: 'a10000 is attached to another coordinator.' }))))
      .toEqual({ text: 'a10000 is attached to another coordinator.', isError: true })
  })

  it('needs a ClaudeTerm Claude tab and sends nothing', async () => {
    expect(await coordTool('list_sessions', { op: 'list' }, deps(refuse, null)))
      .toEqual({ text: 'list_sessions works only in a ClaudeTerm Claude tab', isError: true })
  })

  it('says ClaudeTerm is not running when the pipe is unavailable', async () => {
    const r = await coordTool('list_sessions', { op: 'list' }, deps(async () => { throw new PipeUnavailableError('x') }))
    expect(r).toEqual({ text: 'ClaudeTerm is not running.', isError: true })
  })

  it('reports another failure of the request as an error', async () => {
    expect(await coordTool('list_sessions', { op: 'list' }, deps(async () => { throw new Error('boom') })))
      .toEqual({ text: 'ClaudeTerm request failed: boom', isError: true })
  })
})
