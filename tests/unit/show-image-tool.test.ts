import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { handleShowImage, type ShowImageDeps } from '../../src/mcp/show-image-tool'
import { PipeUnavailableError } from '../../src/shared/pipe-client'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const PIPE = String.raw`\\.\pipe\x`
const cwd = mkdtempSync(join(tmpdir(), 'ct-mcp-'))
writeFileSync(join(cwd, 'plot.png'), Buffer.from([1, 2, 3]))
writeFileSync(join(cwd, 'notes.txt'), 'x')

function deps(send: ShowImageDeps['send']): ShowImageDeps {
  return { cwd, tabId: TAB, pipeName: PIPE, send }
}

describe('handleShowImage', () => {
  it('resolves a relative path and sends it with the tab id', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const r = await handleShowImage({ path: 'plot.png', caption: 'Plot' }, deps(send))
    expect(r).toEqual({ text: `Shown in ClaudeTerm: ${join(cwd, 'plot.png')}`, isError: false })
    expect(send).toHaveBeenCalledWith(PIPE,{ v: 1, type: 'show_image', tabId: TAB, path: join(cwd, 'plot.png'), caption: 'Plot' })
  })

  it('reports missing files and non-images as tool errors', async () => {
    const send = vi.fn()
    expect((await handleShowImage({ path: 'missing.png' }, deps(send))).isError).toBe(true)
    const txt = await handleShowImage({ path: join(cwd, 'notes.txt') }, deps(send))
    expect(txt.isError).toBe(true)
    expect(txt.text).toContain('not a supported image type')
    expect(send).not.toHaveBeenCalled()
  })

  it('is not an error when ClaudeTerm is not running', async () => {
    const r = await handleShowImage({ path: 'plot.png' }, deps(async () => { throw new PipeUnavailableError('ENOENT') }))
    expect(r).toEqual({ text: `ClaudeTerm is not running; image is at ${join(cwd, 'plot.png')}`, isError: false })
  })

  it('surfaces a rejection from ClaudeTerm', async () => {
    const r = await handleShowImage({ path: 'plot.png' }, deps(async () => ({ ok: false as const, error: 'no open tabs in ClaudeTerm' })))
    expect(r).toEqual({ text: 'ClaudeTerm rejected the image: no open tabs in ClaudeTerm', isError: true })
  })

  it('reports an unexpected pipe failure (e.g. invalid reply) as a tool error', async () => {
    const r = await handleShowImage({ path: 'plot.png' }, deps(async () => { throw new Error('invalid JSON reply') }))
    expect(r).toEqual({ text: 'ClaudeTerm request failed: invalid JSON reply', isError: true })
  })
})
