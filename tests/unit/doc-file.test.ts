import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkDocFile, docStamp, readDocText } from '../../src/shared/doc-file'

const dir = mkdtempSync(join(tmpdir(), 'ct-doc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('checkDocFile', () => {
  it('takes Markdown, PDF and HTML files', async () => {
    const md = join(dir, 'a.md')
    writeFileSync(md, '# Title\n')
    expect(await checkDocFile(md)).toEqual({ ok: true, kind: 'markdown', size: 8 })
    const pdf = join(dir, 'r.pdf')
    writeFileSync(pdf, '%PDF-1.4')
    expect(await checkDocFile(pdf)).toEqual({ ok: true, kind: 'pdf', size: 8 })
    const html = join(dir, 'index.HTM')
    writeFileSync(html, '<p>x</p>')
    expect(await checkDocFile(html)).toEqual({ ok: true, kind: 'html', size: 8 })
  })

  it('names what is wrong', async () => {
    const txt = join(dir, 'notes.txt')
    writeFileSync(txt, 'x')
    expect(await checkDocFile(txt)).toEqual({ ok: false, error: `not a supported document type (md, markdown, pdf, html, htm): ${txt}` })
    const gone = join(dir, 'gone.md')
    expect(await checkDocFile(gone)).toEqual({ ok: false, error: `file not found: ${gone}` })
    const folderNamedMd = join(dir, 'x.md')
    mkdirSync(folderNamedMd)
    expect(await checkDocFile(folderNamedMd)).toEqual({ ok: false, error: `not a file: ${folderNamedMd}` })
  })

  it('refuses a Markdown file over 5 MB', async () => {
    const big = join(dir, 'big.md')
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1))
    expect(await checkDocFile(big)).toEqual({ ok: false, error: `the document is larger than 5 MB: ${big}` })
  })
})

describe('readDocText', () => {
  it('reads Markdown without its BOM, with the stamp of the file it read', async () => {
    const bom = join(dir, 'bom.md')
    writeFileSync(bom, '\uFEFF# T\r\n', 'utf8')
    const r = await readDocText(bom)
    expect(r).toEqual({ ok: true, text: '# T\r\n', stamp: await docStamp(bom) })
  })

  it('refuses a PDF', async () => {
    const pdf = join(dir, 'only.pdf')
    writeFileSync(pdf, '%PDF-1.4')
    expect(await readDocText(pdf)).toEqual({ ok: false, error: `not a Markdown document: ${pdf}` })
  })
})

describe('docStamp', () => {
  it('changes with the file and is null when it is gone', async () => {
    const md = join(dir, 'stamp.md')
    writeFileSync(md, '# Title\n')
    const before = await docStamp(md)
    writeFileSync(md, '# Title, longer\n')
    expect(await docStamp(md)).not.toBe(before)
    rmSync(md)
    expect(await docStamp(md)).toBeNull()
  })
})
