import { describe, expect, it } from 'vitest'
import { docImageUrl, docKindOf } from '../../src/shared/docs'

describe('docKindOf', () => {
  it('tells the kind by the extension, in any case', () => {
    expect(docKindOf('C:\\a\\Spec.MD')).toBe('markdown')
    expect(docKindOf('C:\\my.dir\\a.md')).toBe('markdown')
    expect(docKindOf('/a/b.markdown')).toBe('markdown')
    expect(docKindOf('/a/r.pdf')).toBe('pdf')
    expect(docKindOf('/a/index.HTM')).toBe('html')
    expect(docKindOf('/a/index.html')).toBe('html')
  })
  it('refuses other files, and a dot in a folder name', () => {
    expect(docKindOf('/a/notes.txt')).toBeNull()
    expect(docKindOf('/a.md/readme')).toBeNull()
    expect(docKindOf('C:\\a.md\\readme')).toBeNull()
    expect(docKindOf('C:\\my.dir\\.md')).toBeNull()
    expect(docKindOf('C:\\x.pdf\\file')).toBeNull()
  })
})

describe('docImageUrl', () => {
  const doc = { id: '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11', url: 'ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/docs/specs/x.md' }
  it('resolves a relative address against the document', () => {
    expect(docImageUrl(doc, 'img/a.png')).toBe('ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/docs/specs/img/a.png')
    expect(docImageUrl(doc, '../../images/shot%201.png')).toBe('ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/images/shot%201.png')
  })
  it('resolves markdown-it normalized addresses single-encoded', () => {
    const d = { id: '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11', url: 'ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/docs/x.md' }
    expect(docImageUrl(d, 'img/my%20shot.png')).toBe('ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/docs/img/my%20shot.png')
    expect(docImageUrl(d, '%D0%BE%D1%82%D1%87%D1%91%D1%82/x.png')).toBe('ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/docs/%D0%BE%D1%82%D1%87%D1%91%D1%82/x.png')
  })
  it('leaves out addresses with a scheme, absolute ones and fragments', () => {
    for (const src of ['https://x.org/a.png', 'data:image/png;base64,AA', 'file:///C:/a.png', '/abs.png', '\\\\server\\a.png', '#top', '']) {
      expect(docImageUrl(doc, src)).toBeNull()
    }
  })
})
