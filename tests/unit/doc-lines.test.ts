import { describe, expect, it } from 'vitest'
import { docLines } from '../../src/renderer/doc-lines'
import { markdownSegments } from '../../src/renderer/markdown-diff'

describe('docLines', () => {
  it('makes numbered context lines without \\r', () => {
    expect(docLines('# T\r\n\r\nBody\r\n')).toEqual([
      { kind: 'context', text: '# T', oldNo: 1, newNo: 1 },
      { kind: 'context', text: '', oldNo: 2, newNo: 2 },
      { kind: 'context', text: 'Body', oldNo: 3, newNo: 3 }
    ])
    expect(docLines('a')).toEqual([{ kind: 'context', text: 'a', oldNo: 1, newNo: 1 }])
    expect(docLines('')).toEqual([])
  })

  it('a document is formatted as unchanged blocks', () => {
    expect(markdownSegments(docLines('# T\n\nBody\n')).map((s) => [s.kind, s.from, s.to])).toEqual([
      ['same', 0, 0],
      ['same', 2, 2]
    ])
  })
})
