import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleShowDocument, type ShowDocumentDeps } from '../../src/mcp/show-document-tool'
import { PipeUnavailableError } from '../../src/shared/pipe-client'
import type { ShowDocumentMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const dir = mkdtempSync(join(tmpdir(), 'ct-showdoc-'))
mkdirSync(join(dir, 'docs'))
const md = join(dir, 'docs', 'spec.md')
writeFileSync(md, '# Spec\n')
writeFileSync(join(dir, 'notes.txt'), 'plain')
const deps = (send: ShowDocumentDeps['send'], tabId: string | null = TAB): ShowDocumentDeps => ({ cwd: dir, tabId, pipeName: 'pipe', send })
const ok = async () => ({ ok: true as const, info: 'Opened docs/spec.md in the Docs panel.' })

describe('handleShowDocument', () => {
  it('needs a ClaudeTerm Claude tab', async () => {
    expect(await handleShowDocument({ path: md }, deps(ok, null))).toEqual({ text: 'show_document works only in a ClaudeTerm Claude tab', isError: true })
  })

  it('resolves a relative path against its folder and sends the message', async () => {
    const sent: ShowDocumentMessage[] = []
    const r = await handleShowDocument({ path: 'docs/spec.md', title: '  Spec  ' }, {
      ...deps(ok),
      send: async (_p, m) => {
        sent.push(m)
        return { ok: true, info: 'Opened docs/spec.md in the Docs panel.' }
      }
    })
    expect(sent).toEqual([{ v: 1, type: 'show_document', tabId: TAB, path: join(dir, 'docs', 'spec.md'), title: 'Spec' }])
    expect(r).toEqual({ text: 'Opened docs/spec.md in the Docs panel.', isError: false })
  })

  it('cuts the title at 100 characters and sends an empty one as null', async () => {
    const sent: ShowDocumentMessage[] = []
    const send = async (_p: string, m: ShowDocumentMessage) => {
      sent.push(m)
      return { ok: true as const }
    }
    await handleShowDocument({ path: md, title: 'x'.repeat(120) }, deps(send))
    await handleShowDocument({ path: md, title: '   ' }, deps(send))
    expect(sent[0]!.title).toBe('x'.repeat(100))
    expect(sent[1]!.title).toBeNull()
  })

  it('refuses a file of another type without asking ClaudeTerm', async () => {
    const send = async () => {
      throw new Error('must not be called')
    }
    expect(await handleShowDocument({ path: join(dir, 'notes.txt') }, deps(send))).toEqual({
      text: `not a supported document type (md, markdown, pdf, html, htm): ${join(dir, 'notes.txt')}`,
      isError: true
    })
  })

  it('says where the document is when ClaudeTerm is not running', async () => {
    const r = await handleShowDocument({ path: md }, deps(async () => { throw new PipeUnavailableError('x') }))
    expect(r).toEqual({ text: `ClaudeTerm is not running; the document is at ${md}`, isError: false })
  })

  it('passes on a refusal of ClaudeTerm as an error', async () => {
    const r = await handleShowDocument({ path: md }, deps(async () => ({ ok: false as const, error: 'nope' })))
    expect(r).toEqual({ text: 'nope', isError: true })
  })

  it('reports another failure of the request as an error', async () => {
    const r = await handleShowDocument({ path: md }, deps(async () => { throw new Error('boom') }))
    expect(r).toEqual({ text: 'ClaudeTerm request failed: boom', isError: true })
  })
})
