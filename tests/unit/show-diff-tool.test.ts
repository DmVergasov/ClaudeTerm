import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { handleShowDiff, type ShowDiffDeps } from '../../src/mcp/show-diff-tool'
import { PipeUnavailableError } from '../../src/shared/pipe-client'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const CWD = process.platform === 'win32' ? 'D:\\proj' : '/proj'
const deps = (send: ShowDiffDeps['send'], tabId: string | null = TAB): ShowDiffDeps => ({ cwd: CWD, tabId, pipeName: 'pipe', send })

describe('handleShowDiff', () => {
  it('sends the request with paths resolved against the working folder and returns ClaudeTerm\'s reply', async () => {
    const send = vi.fn(async () => ({ ok: true as const, info: 'Opened 2 files (+3 −1) in the Changes panel.' }))
    const r = await handleShowDiff({ from: ' HEAD~3 ', paths: ['src', join(CWD, 'tests')], title: ' Auth ' }, deps(send))
    expect(r).toEqual({ text: 'Opened 2 files (+3 −1) in the Changes panel.', isError: false })
    expect(send).toHaveBeenCalledWith('pipe', { v: 1, type: 'show_diff', tabId: TAB, cwd: CWD, scope: null, from: 'HEAD~3', to: null, paths: [join(CWD, 'src'), join(CWD, 'tests')], title: 'Auth' })
  })

  it('passes a scope when there is no from', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await handleShowDiff({ scope: 'last_turn' }, deps(send))
    expect(send).toHaveBeenCalledWith('pipe', expect.objectContaining({ scope: 'last_turn', from: null, paths: [], title: null }))
  })

  it('refuses options as revisions, to without from, too many paths, and running outside a ClaudeTerm tab', async () => {
    const send = vi.fn()
    expect((await handleShowDiff({ from: '--output=x' }, deps(send))).isError).toBe(true)
    expect((await handleShowDiff({ from: '' }, deps(send))).isError).toBe(true)
    expect(await handleShowDiff({ to: 'HEAD' }, deps(send))).toEqual({ text: 'to needs from: pass the revision to compare with', isError: true })
    expect((await handleShowDiff({ paths: Array.from({ length: 101 }, () => 'a') }, deps(send))).isError).toBe(true)
    expect(await handleShowDiff({}, deps(send, null))).toEqual({ text: 'show_diff works only in a ClaudeTerm Claude tab', isError: true })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports ClaudeTerm\'s refusals and a missing ClaudeTerm as errors', async () => {
    expect(await handleShowDiff({}, deps(async () => ({ ok: false as const, error: 'unknown revision: mastr' })))).toEqual({ text: 'unknown revision: mastr', isError: true })
    expect(await handleShowDiff({}, deps(async () => { throw new PipeUnavailableError('ENOENT') }))).toEqual({ text: 'ClaudeTerm is not running, so there is no panel to show the diff in', isError: true })
  })
})
