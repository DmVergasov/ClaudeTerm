import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type DocEntry, docUrl } from '../../src/main/doc-hub'
import { badSegment, type DocFs, docResponseHeaders, frameNavigationAllowed, resolveDocRequest } from '../../src/main/doc-protocol'
import type { DocKind } from '../../src/shared/docs'

const ID = '3f2b8c1e-7a4d-4e5f-9a6b-0c1d2e3f4a5b'
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ROOT = join('/', 'work', 'docs')

/** A fake disk: `files` are the regular files, `dirs` the folders, `links` map a path prefix to the path it really is. */
function fakeFs(files: string[], dirs: string[] = [], links: Record<string, string> = {}): DocFs {
  const known = new Set([...files, ...dirs])
  for (const p of [...files, ...dirs]) {
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) known.add(d)
  }
  const real = (p: string): string => {
    for (const [from, to] of Object.entries(links)) {
      if (p === from) return to
      if (p.startsWith(from + '/') || p.startsWith(from + '\\')) return to + p.slice(from.length)
    }
    return p
  }
  return {
    async realpath(p: string): Promise<string> {
      const r = real(p)
      if (!known.has(r)) throw new Error(`ENOENT: ${p}`)
      return r
    },
    async isFile(p: string): Promise<boolean> {
      return files.includes(real(p))
    }
  }
}

function entry(kind: DocKind, relPath: string, opts: { id?: string; root?: string } = {}): DocEntry {
  const id = opts.id ?? ID
  const root = opts.root ?? ROOT
  const path = join(root, relPath)
  return { id, path, relPath, name: relPath.split(/[\\/]/).pop()!, title: null, kind, url: docUrl(id, root, path), tabId: 't1', root }
}

const find = (id: string, docs: DocEntry[]): DocEntry | undefined => docs.find((d) => d.id === id)

describe('resolveDocRequest', () => {
  it('serves a PDF document its own file only', async () => {
    const pdf = entry('pdf', 'r.pdf')
    const fs = fakeFs([pdf.path, join(ROOT, 'other.pdf')])
    const docs = [pdf]
    expect(await resolveDocRequest(`ctdoc://${ID}/r.pdf`, (id) => find(id, docs), fs)).toEqual({ path: pdf.path, doc: pdf })
    expect(await resolveDocRequest(`ctdoc://${ID}/other.pdf`, (id) => find(id, docs), fs)).toBeNull()
  })

  it('serves an HTML report the files under its folder', async () => {
    const html = entry('html', 'index.html', { root: join(ROOT, 'site') })
    const fs = fakeFs([html.path, join(ROOT, 'site', 'assets', 'app.js')])
    const docs = [html]
    const find1 = (id: string) => find(id, docs)
    expect(await resolveDocRequest(`ctdoc://${ID}/index.html`, find1, fs)).toEqual({ path: html.path, doc: html })
    expect(await resolveDocRequest(`ctdoc://${ID}/assets/app.js`, find1, fs)).toEqual({ path: join(ROOT, 'site', 'assets', 'app.js'), doc: html })
  })

  it('refuses what leads out of the folder', async () => {
    const html = entry('html', 'index.html', { root: join(ROOT, 'site') })
    const up = join(ROOT, 'site', 'up')
    const parent = join(ROOT, 'secret.txt')
    const fs = fakeFs([html.path, parent], [join(ROOT, 'site')], { [up]: ROOT })
    const docs = [html]
    const find1 = (id: string) => find(id, docs)
    expect(await resolveDocRequest(`ctdoc://${ID}/up/secret.txt`, find1, fs)).toBeNull()
    // the URL parser collapses %2e%2e before resolveDocRequest sees it, so this case is covered by the parser; the segment check is the second line of defense
    expect(await resolveDocRequest(`ctdoc://${ID}/%2e%2e/secret.txt`, find1, fs)).toBeNull()
  })

  it.each([
    ['a%00.png', 'a NUL'],
    ['a%2fb.png', 'a slash']
  ])('refuses a segment holding %s (%s) even when the file exists', async (segment) => {
    const html = entry('html', 'index.html', { root: join(ROOT, 'site') })
    const site = join(ROOT, 'site')
    const files = [html.path, join(site, 'a\0.png'), join(site, 'a', 'b.png')]
    const docs = [html]
    expect(await resolveDocRequest(`ctdoc://${ID}/${segment}`, (id) => find(id, docs), fakeFs(files, [site]))).toBeNull()
  })

  it('refuses a backslash in a segment only on Windows, where it separates folders', async () => {
    const html = entry('html', 'index.html', { root: join(ROOT, 'site') })
    const site = join(ROOT, 'site')
    const docs = [html]
    const hit = await resolveDocRequest(`ctdoc://${ID}/a%5cb.png`, (id) => find(id, docs), fakeFs([html.path, join(site, 'a\\b.png')], [site]))
    expect(hit === null).toBe(process.platform === 'win32')
  })

  it('serves the document itself even when it is a link to elsewhere', async () => {
    const elsewhere = join('/', 'elsewhere', 'r.html')
    const html = entry('html', 'r.html')
    const fs = fakeFs([elsewhere], [ROOT], { [html.path]: elsewhere })
    const docs = [html]
    expect(await resolveDocRequest(`ctdoc://${ID}/r.html`, (id) => find(id, docs), fs)).toEqual({ path: html.path, doc: html })
  })

  it('serves a Markdown document image files under its root only', async () => {
    const md = entry('markdown', 'notes.md')
    const img = join(ROOT, 'images', 'a.png')
    const fs = fakeFs([md.path, img, join(ROOT, 'notes.txt'), join(ROOT, 'images', 'a.PNG')], [join(ROOT, 'images')])
    const docs = [md]
    const find1 = (id: string) => find(id, docs)
    expect(await resolveDocRequest(`ctdoc://${ID}/images/a.png`, find1, fs)).toEqual({ path: img, doc: md })
    expect(await resolveDocRequest(`ctdoc://${ID}/images/a.PNG`, find1, fs)).toEqual({ path: join(ROOT, 'images', 'a.PNG'), doc: md })
    expect(await resolveDocRequest(`ctdoc://${ID}/notes.txt`, find1, fs)).toBeNull()
    expect(await resolveDocRequest(`ctdoc://${ID}/notes.md`, find1, fs)).toBeNull()
  })

  it('round-trips names with spaces, # and % and non-ASCII letters', async () => {
    const doc = entry('html', join('отчёт', 'my report #1 %.html'))
    const fs = fakeFs([doc.path], [join(ROOT, 'отчёт')])
    const docs = [doc]
    expect(doc.url).toBe(`ctdoc://${ID}/${encodeURIComponent('отчёт')}/${encodeURIComponent('my report #1 %.html')}`)
    expect(await resolveDocRequest(doc.url, (id) => find(id, docs), fs)).toEqual({ path: doc.path, doc })
  })

  it('refuses an unknown id, another scheme and garbage', async () => {
    const html = entry('html', 'index.html')
    const fs = fakeFs([html.path])
    const docs = [html]
    const find1 = (id: string) => find(id, docs)
    expect(await resolveDocRequest(`ctdoc://${OTHER}/index.html`, find1, fs)).toBeNull()
    expect(await resolveDocRequest(`ctimg://${ID}/index.html`, find1, fs)).toBeNull()
    expect(await resolveDocRequest(`https://${ID}/index.html`, find1, fs)).toBeNull()
    expect(await resolveDocRequest('not a url', find1, fs)).toBeNull()
    expect(await resolveDocRequest(`ctdoc://${ID}/`, find1, fs)).toBeNull()
  })
})

describe('badSegment', () => {
  it.each([[true], [false]])('refuses a slash, a NUL and the dot segments on every platform (Windows: %s)', (windows) => {
    expect(badSegment('a/b.png', windows)).toBe(true)
    expect(badSegment('a\0.png', windows)).toBe(true)
    expect(badSegment('.', windows)).toBe(true)
    expect(badSegment('..', windows)).toBe(true)
  })

  it('refuses a backslash only where it separates folders', () => {
    expect(badSegment('a\\b.png', true)).toBe(true)
    expect(badSegment('a\\b.png', false)).toBe(false)
  })

  it('lets an ordinary name through', () => {
    expect(badSegment('my report #1 %.html', true)).toBe(false)
    expect(badSegment('my report #1 %.html', false)).toBe(false)
  })
})

describe('frameNavigationAllowed', () => {
  const known = (id: string): boolean => id === ID

  it('lets frames go to documents and the PDF viewer only', () => {
    expect(frameNavigationAllowed('about:blank', known)).toBe(true)
    expect(frameNavigationAllowed('about:srcdoc', known)).toBe(true)
    expect(frameNavigationAllowed(`ctdoc://${ID}/x.html`, known)).toBe(true)
    expect(frameNavigationAllowed('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', known)).toBe(true)
    expect(frameNavigationAllowed(`ctdoc://${OTHER}/x`, known)).toBe(false)
    expect(frameNavigationAllowed('https://example.com/', known)).toBe(false)
    expect(frameNavigationAllowed('file:///C:/x', known)).toBe(false)
    expect(frameNavigationAllowed('javascript:alert(1)', known)).toBe(false)
    expect(frameNavigationAllowed('nonsense', known)).toBe(false)
  })
})

describe('docResponseHeaders', () => {
  it('keeps an HTML report to its own document', () => {
    const html = entry('html', 'index.html')
    expect(docResponseHeaders(html, html.path)).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src ctdoc://${ID} data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'`,
      'Access-Control-Allow-Origin': '*'
    })
    expect(docResponseHeaders(html, join(ROOT, 'assets', 'app.js'))['Content-Type']).toBe('text/javascript')
  })

  it('gives a PDF only its Content-Type', () => {
    const pdf = entry('pdf', 'r.pdf')
    expect(docResponseHeaders(pdf, pdf.path)).toEqual({ 'Content-Type': 'application/pdf' })
  })

  it('gives image types to Markdown images and no Content-Type to other files', () => {
    const md = entry('markdown', 'notes.md')
    expect(docResponseHeaders(md, join(ROOT, 'a.svg'))).toEqual({ 'Content-Type': 'image/svg+xml' })
    expect(docResponseHeaders(md, join(ROOT, 'a.jpeg'))).toEqual({ 'Content-Type': 'image/jpeg' })
    expect(docResponseHeaders(md, join(ROOT, 'a.bin'))).toEqual({})
  })
})
