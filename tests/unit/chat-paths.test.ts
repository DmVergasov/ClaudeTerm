import { describe, expect, it } from 'vitest'
import { findPaths, linkPath, pathRefText, splitLine } from '../../src/shared/chat-paths'

/** each path found: its text, its path and its line */
const found = (text: string) => findPaths(text).map((m) => [text.slice(m.start, m.end), m.ref.path, m.ref.line])

describe('findPaths', () => {
  it('finds a path in a dot folder', () => {
    const p = '.superpowers/sdd/2026-11-12-hub-fade-material-swap-design.md'
    expect(found(`see ${p} now`)).toEqual([[p, p, null]])
  })
  it('finds relative, ./, ../ and ~/ paths', () => {
    expect(found('src/main/index.ts ./run.md ../up/x.md ~/notes/a.md')).toEqual([
      ['src/main/index.ts', 'src/main/index.ts', null], ['./run.md', './run.md', null],
      ['../up/x.md', '../up/x.md', null], ['~/notes/a.md', '~/notes/a.md', null]
    ])
  })
  it('finds Windows and POSIX absolute paths', () => {
    expect(found('D:\\Work\\notes.md, C:/Users/x.md and /usr/lib/x.so')).toEqual([
      ['D:\\Work\\notes.md', 'D:\\Work\\notes.md', null], ['C:/Users/x.md', 'C:/Users/x.md', null], ['/usr/lib/x.so', '/usr/lib/x.so', null]
    ])
  })
  it('keeps a :line, :line:col or :line-line suffix, the first number as the line', () => {
    expect(found('at src/main/index.ts:120 and src/a.ts:12:5 or src/b.ts:7-9')).toEqual([
      ['src/main/index.ts:120', 'src/main/index.ts', 120], ['src/a.ts:12:5', 'src/a.ts', 12], ['src/b.ts:7-9', 'src/b.ts', 7]
    ])
  })
  it('leaves surrounding punctuation, quotes and backticks out', () => {
    expect(found('(src/a.ts), "src/b.ts". [src/c.ts]; src/d.ts:4: \'src/e.ts\' `src/f.ts:3`').map(([text]) => text))
      .toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts:4', 'src/e.ts', 'src/f.ts:3'])
  })
  it('says where each path is in the text', () => {
    expect(findPaths('(src/a.ts)')).toEqual([{ start: 1, end: 9, ref: { path: 'src/a.ts', line: null } }])
  })
  it('a URL is not a path', () => {
    expect(found('https://x.dev/a.md file:///c/a.md mailto:me@x.dev/a.md')).toEqual([])
  })
  it('a word with a dot, a version, a fraction, a folder, a glob and a dotfile are not paths', () => {
    expect(found('node.js e.g. v1.2.3 README.md and/or 1/2.5 docs/ src/**/*.ts src/.env')).toEqual([])
  })
})

describe('splitLine', () => {
  it('splits a :line, :line:col or :line-line suffix off; a drive letter stays', () => {
    expect(splitLine('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLine('src/a.ts:12:5')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLine('src/a.ts:12-20')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLine('C:\\Work\\notes.md')).toEqual({ path: 'C:\\Work\\notes.md', line: null })
    expect(splitLine('C:\\Work\\a.ts:7')).toEqual({ path: 'C:\\Work\\a.ts', line: 7 })
    expect(splitLine('src/a.ts:0')).toEqual({ path: 'src/a.ts', line: null })
  })
})

describe('linkPath', () => {
  it('a link target that names a file is a path, with or without a folder, spaces allowed', () => {
    expect(linkPath('docs/spec.md')).toEqual({ path: 'docs/spec.md', line: null })
    expect(linkPath('README.md')).toEqual({ path: 'README.md', line: null })
    expect(linkPath('my file.md')).toEqual({ path: 'my file.md', line: null })
    expect(linkPath('C:\\x.md')).toEqual({ path: 'C:\\x.md', line: null })
  })
  it('takes the line from :line or a #L fragment, and drops another fragment', () => {
    expect(linkPath('src/a.ts:7')).toEqual({ path: 'src/a.ts', line: 7 })
    expect(linkPath('src/a.ts#L12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(linkPath('src/a.ts#L12-L20')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(linkPath('docs/spec.md#goals')).toEqual({ path: 'docs/spec.md', line: null })
  })
  it('a web or file address, an anchor, a folder, a name with no extension and a query are not paths', () => {
    for (const t of ['https://x.dev/a.md', 'file:///a.md', 'mailto:a@b.md', '#top', 'docs/', 'Makefile', '', 'a.md?raw=1']) expect(linkPath(t)).toBeNull()
  })
})

describe('pathRefText', () => {
  it('is the path, with its line after a colon', () => {
    expect(pathRefText({ path: 'src/a.ts', line: 12 })).toBe('src/a.ts:12')
    expect(pathRefText({ path: 'docs/spec.md', line: null })).toBe('docs/spec.md')
  })
})
