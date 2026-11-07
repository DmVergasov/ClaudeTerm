import { basename, dirname, join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocHub, docUrl, htmlFolderRefused, MAX_DOCS } from '../../src/main/doc-hub'
import type { DocsUpdate } from '../../src/shared/docs'

const FOLDER = process.platform === 'win32' ? 'C:\\proj' : '/proj'
const p = (...s: string[]) => join(FOLDER, ...s)
const NOT_CLAUDE = 'show_document works only in a ClaudeTerm Claude tab'
let n = 0

const make = () => {
  const updates: DocsUpdate[] = []
  const hub = new DocHub({ publish: (u) => updates.push(u), newId: () => `id${++n}` })
  hub.addTab('t1', FOLDER, true)
  hub.addTab('sh', FOLDER, false)
  return { hub, updates }
}

describe('htmlFolderRefused', () => {
  it('refuses a document in the home folder or in a drive root, on Windows', () => {
    const home = 'C:\\Users\\rim28'
    expect(htmlFolderRefused('C:\\Users\\rim28\\index.html', home, win32)).toBe(true)
    expect(htmlFolderRefused('c:\\users\\RIM28\\index.html', home, win32)).toBe(true)
    expect(htmlFolderRefused('C:\\index.html', home, win32)).toBe(true)
    expect(htmlFolderRefused('C:\\Users\\rim28\\work\\index.html', home, win32)).toBe(false)
    expect(htmlFolderRefused('C:\\Users\\rim28\\work\\report\\index.html', home, win32)).toBe(false)
  })

  it('refuses a document in the home folder or at the root, on Linux and macOS', () => {
    const home = '/home/rim28'
    expect(htmlFolderRefused('/home/rim28/index.html', home, posix)).toBe(true)
    expect(htmlFolderRefused('/index.html', home, posix)).toBe(true)
    expect(htmlFolderRefused('/home/rim28/work/index.html', home, posix)).toBe(false)
    expect(htmlFolderRefused('/srv/reports/index.html', home, posix)).toBe(false)
  })
})

describe('DocHub', () => {
  it('shows a Markdown file of the tab folder, rooted at the folder', () => {
    const { hub, updates } = make()
    expect(hub.show('t1', p('docs', 'my spec.md'), null, 'markdown')).toEqual({
      ok: true,
      info: 'Opened docs/my spec.md in the Docs panel. The user can comment on it; their comments come back to you as a message.'
    })
    const d = updates[0]!.docs[0]!
    expect(d).toEqual({ id: d.id, path: p('docs', 'my spec.md'), relPath: 'docs/my spec.md', name: 'my spec.md', title: null, kind: 'markdown', url: `ctdoc://${d.id}/docs/my%20spec.md` })
    expect(updates[0]!.reveal).toBe(d.id)
    expect(hub.get(d.id)?.root).toBe(FOLDER)
  })

  it('roots an HTML or PDF file, and a file outside the folder, at its own folder', () => {
    const { hub, updates } = make()
    expect(hub.show('t1', p('cov', 'index.html'), 'Coverage', 'html')).toEqual({ ok: true, info: 'Opened cov/index.html in the Docs panel.' })
    const html = updates[0]!.docs[0]!
    expect(html.url).toBe(`ctdoc://${html.id}/index.html`)
    expect(hub.get(html.id)?.root).toBe(p('cov'))

    const outside = join(FOLDER, '..', 'other', 'notes.md')
    hub.show('t1', outside, null, 'markdown')
    const md = updates[1]!.docs[0]!
    expect(md.relPath).toBe(outside)
    expect(hub.get(md.id)?.root).toBe(dirname(outside))
    expect(md.url).toBe(`ctdoc://${md.id}/${basename(outside)}`)
  })

  it('the same file again keeps its id, takes the new title and comes first', () => {
    const { hub, updates } = make()
    hub.show('t1', p('a.md'), null, 'markdown')
    hub.show('t1', p('b.md'), null, 'markdown')
    const first = updates[0]!.docs[0]!.id
    const spelled = process.platform === 'win32' ? p('A.md').replace(/\\/g, '/').toLowerCase() : p('a.md')
    expect(hub.show('t1', spelled, 'Plan', 'markdown')).toMatchObject({ ok: true })
    const last = updates[2]!
    expect(last.docs.map((d) => d.id)).toEqual([first, updates[1]!.docs[0]!.id])
    expect(last.docs[0]!.title).toBe('Plan')
    expect(last.reveal).toBe(first)
  })

  it('keeps the 30 newest', () => {
    const { hub, updates } = make()
    for (let i = 0; i < MAX_DOCS + 1; i++) hub.show('t1', p(`f${i}.md`), null, 'markdown')
    const docs = updates[updates.length - 1]!.docs
    expect(docs).toHaveLength(MAX_DOCS)
    expect(docs[0]!.name).toBe(`f${MAX_DOCS}.md`)
    expect(hub.get(updates[0]!.docs[0]!.id)).toBeUndefined()
  })

  it('refuses a shell tab and an unknown tab', () => {
    const { hub, updates } = make()
    expect(hub.show('sh', p('a.md'), null, 'markdown')).toEqual({ ok: false, error: NOT_CLAUDE })
    expect(hub.show('nope', p('a.md'), null, 'markdown')).toEqual({ ok: false, error: NOT_CLAUDE })
    expect(hub.show(null, p('a.md'), null, 'markdown')).toEqual({ ok: false, error: NOT_CLAUDE })
    expect(updates).toEqual([])
  })

  it('remove drops a document and publishes without reveal; a closed tab forgets its documents', () => {
    const { hub, updates } = make()
    hub.show('t1', p('a.md'), null, 'markdown')
    hub.show('t1', p('b.md'), null, 'markdown')
    const [b, a] = updates[1]!.docs
    hub.remove(b!.id)
    expect(hub.get(b!.id)).toBeUndefined()
    expect(updates[2]).toEqual({ tabId: 't1', docs: [a], reveal: null })

    hub.removeTab('t1')
    expect(hub.get(a!.id)).toBeUndefined()
    expect(hub.show('t1', p('c.md'), null, 'markdown')).toEqual({ ok: false, error: NOT_CLAUDE })
    expect(updates).toHaveLength(3)
  })
})

describe('docUrl', () => {
  it('encodes each segment of the path relative to the root', () => {
    expect(docUrl('d1', FOLDER, p('отчёт', 'my report #1 %.html'))).toBe('ctdoc://d1/%D0%BE%D1%82%D1%87%D1%91%D1%82/my%20report%20%231%20%25.html')
  })
})

describe('DocHub.resetTab (fix 1, I4)', () => {
  it('a reset clears the documents, takes the new folder as the root, and publishes an empty list', () => {
    const { hub, updates } = make()
    hub.show('t1', p('a.md'), 'A', 'markdown')
    const id = updates.at(-1)!.docs[0].id
    updates.length = 0
    hub.resetTab('t1', join(FOLDER, 'other'))
    expect(updates).toEqual([{ tabId: 't1', docs: [], reveal: null }])
    expect(hub.get(id)).toBeUndefined()
  })

  it('a document shown after the reset is relative to the new folder', () => {
    const { hub, updates } = make()
    hub.resetTab('t1', join(FOLDER, 'other'))
    hub.show('t1', join(FOLDER, 'other', 'b.md'), null, 'markdown')
    expect(updates.at(-1)!.docs[0].relPath).toBe('b.md')
  })
})
