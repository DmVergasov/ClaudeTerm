import { describe, expect, it } from 'vitest'
import { findMatches as search, MATCH_CAP } from '../../src/renderer/review-search'
import type { ReviewFile, ReviewLine } from '../../src/shared/review'

const L = (kind: ReviewLine['kind'], text: string, no: number): ReviewLine => ({ kind, text, oldNo: kind === 'add' ? null : no, newNo: kind === 'del' ? null : no })
const file = (relPath: string, lines: ReviewLine[], extra: Partial<ReviewFile> = {}): ReviewFile => ({
  path: `/r/${relPath}`, relPath, status: 'modified', additions: 1, deletions: 0, hunks: [{ header: '@@', lines }], note: null, canForce: false, hash: 'h', viewed: false, ...extra
})

/** the matches only; the cap is tested on its own */
const findMatches = (files: ReviewFile[], query: string) => search(files, query).matches

describe('findMatches', () => {
  it('finds text case-insensitively in code lines, with the range in the line text', () => {
    const f = file('a.ts', [L('context', 'const Foo = 1', 1), L('add', 'foo(FOO)', 2)])
    expect(findMatches([f], 'foo')).toEqual([
      { fileIndex: 0, where: { hunk: 0, line: 0 }, start: 6, end: 9 },
      { fileIndex: 0, where: { hunk: 0, line: 1 }, start: 0, end: 3 },
      { fileIndex: 0, where: { hunk: 0, line: 1 }, start: 4, end: 7 }
    ])
  })

  it('finds several matches in one line without overlapping', () => {
    const f = file('a.ts', [L('add', 'aaaa', 1)])
    expect(findMatches([f], 'aa').map((m) => [m.start, m.end])).toEqual([[0, 2], [2, 4]])
  })

  it('finds the file path, before the lines of the file, and keeps the display order of files and hunks', () => {
    const a = file('src/Alpha.ts', [L('add', 'alpha', 1)])
    const b = file('b.ts', [L('add', 'x', 1)], { hunks: [{ header: '@@', lines: [L('add', 'x', 1)] }, { header: '@@', lines: [L('del', 'x', 9)] }] })
    expect(findMatches([a, b], 'alpha')).toEqual([
      { fileIndex: 0, where: 'path', start: 4, end: 9 },
      { fileIndex: 0, where: { hunk: 0, line: 0 }, start: 0, end: 5 }
    ])
    expect(findMatches([a, b], 'x').map((m) => m.where)).toEqual([{ hunk: 0, line: 0 }, { hunk: 1, line: 0 }])
    expect(findMatches([a, b], 'x').map((m) => m.fileIndex)).toEqual([1, 1])
  })

  it('does not look at hunk headers, line numbers or the +/- markers', () => {
    const f = file('a.ts', [L('add', 'text', 12)], { hunks: [{ header: '@@ -1 +12 @@ needle', lines: [L('add', 'text', 12)] }] })
    expect(findMatches([f], '12')).toEqual([])
    expect(findMatches([f], '+')).toEqual([])
    expect(findMatches([f], 'needle')).toEqual([])
  })

  it('includes files that are viewed or large (folded in the panel)', () => {
    const f = file('a.ts', [L('add', 'needle', 1)], { viewed: true, additions: 5000 })
    expect(findMatches([f], 'needle')).toHaveLength(1)
  })

  it('matches only the path of a file whose diff is not shown', () => {
    const f = file('needle.bin', [L('add', 'needle', 1)], { note: 'binary' })
    expect(findMatches([f], 'needle')).toEqual([{ fileIndex: 0, where: 'path', start: 0, end: 6 }])
  })

  it('treats the query as plain text and finds nothing for an empty one', () => {
    const f = file('a.ts', [L('add', 'a.c abc (x)', 1)])
    expect(findMatches([f], 'a.c').map((m) => m.start)).toEqual([0])
    expect(findMatches([f], '(x)')).toHaveLength(1)
    expect(findMatches([f], '')).toEqual([])
    expect(findMatches([], 'a')).toEqual([])
  })

  it('goes file by file: the path of a file, then its lines, then the next file', () => {
    const a = file('a.ts', [L('add', 'x = 1', 1), L('add', 'x = 2', 2)])
    const b = file('x.ts', [L('add', 'y', 1)])
    expect(findMatches([a, b], 'x').map((m) => [m.fileIndex, m.where])).toEqual([
      [0, { hunk: 0, line: 0 }],
      [0, { hunk: 0, line: 1 }],
      [1, 'path']
    ])
  })

  it('counts offsets in the original text after a character whose lowercase is longer (İ)', () => {
    const f = file('a.ts', [L('add', "const İsim = 'needle'", 1)])
    expect(findMatches([f], 'NEEDLE')).toEqual([{ fileIndex: 0, where: { hunk: 0, line: 0 }, start: 14, end: 20 }])
    expect(findMatches([f], 'İsim')).toEqual([{ fileIndex: 0, where: { hunk: 0, line: 0 }, start: 6, end: 10 }])
  })

  it('stops at the cap and says so', () => {
    const f = file('a.ts', [L('add', 'e'.repeat(MATCH_CAP + 50), 1), L('add', 'e', 2)])
    const r = search([f], 'e')
    expect(r.matches).toHaveLength(MATCH_CAP)
    expect(r.capped).toBe(true)
    const exact = search([file('a.ts', [L('add', 'e'.repeat(MATCH_CAP), 1)])], 'e')
    expect(exact.matches).toHaveLength(MATCH_CAP)
    expect(exact.capped).toBe(false)
  })
})
