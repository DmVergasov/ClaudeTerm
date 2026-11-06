import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFile, buildFiles, DIFF_TIMEOUT_MS, MAX_FORCED_BYTES, sliceLines, toHunks, VIEW_DIFF_MS, type DiffInput, type Side } from '../../src/main/review-diff'

const text = (s: string): Side => ({ kind: 'data', data: Buffer.from(s) })
const input = (before: Side, after: Side, o: Partial<DiffInput> = {}): DiffInput => ({ path: '/r/a.ts', relPath: 'a.ts', before, after, forced: false, ...o })
/** two texts that differ on every one of `n` lines: Myers needs seconds for 5,000 of them */
const allChanged = (n: number): [string, string] => [
  Array.from({ length: n }, (_, i) => `const before${i} = ${i}\n`).join(''),
  Array.from({ length: n }, (_, i) => `let after${i} = '${i}'\n`).join('')
]

afterEach(() => { vi.restoreAllMocks() })

describe('toHunks', () => {
  it('numbers the lines on both sides and counts the changes', () => {
    const r = toHunks('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n', DIFF_TIMEOUT_MS)!
    expect(r.additions).toBe(2)
    expect(r.deletions).toBe(1)
    expect(r.hunks).toHaveLength(1)
    expect(r.hunks[0]!.header).toBe('@@ -1,3 +1,4 @@')
    expect(r.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'one', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'two', oldNo: 2, newNo: null },
      { kind: 'add', text: 'TWO', oldNo: null, newNo: 2 },
      { kind: 'context', text: 'three', oldNo: 3, newNo: 3 },
      { kind: 'add', text: 'four', oldNo: null, newNo: 4 }
    ])
  })

  it('leaves out the "no newline at end of file" marker', () => {
    const r = toHunks('a', 'b', DIFF_TIMEOUT_MS)!
    expect(r.hunks[0]!.lines.map((l) => l.kind)).toEqual(['del', 'add'])
  })

  it('gives up after its time limit', () => {
    const [a, b] = allChanged(5000)
    const start = Date.now()
    expect(toHunks(a, b, 50)).toBeNull()
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

describe('buildFile', () => {
  it('shows a change and hashes the new side', () => {
    const f = buildFile(input(text('a\n'), text('b\n')))!
    expect(f).toMatchObject({ status: 'modified', additions: 1, deletions: 1, note: null, canForce: false, viewed: false })
    expect(f.hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it('hides a file whose sides are equal, and reports line endings as the only change', () => {
    expect(buildFile(input(text('a\nb\n'), text('a\nb\n')))).toBeNull()
    expect(buildFile(input(text('a\r\nb\r\n'), text('a\nb\n')))).toMatchObject({ note: 'eol-only', hunks: [] })
  })

  it('compares CRLF and LF sides by their content', () => {
    const f = buildFile(input(text('a\r\nb\r\n'), text('a\nB\n')))!
    expect(f.hunks[0]!.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['context:a', 'del:b', 'add:B'])
  })

  it('tells added and deleted files, and drops a file absent on both sides', () => {
    expect(buildFile(input({ kind: 'absent' }, text('x\n')))).toMatchObject({ status: 'added', additions: 1 })
    expect(buildFile(input(text('x\n'), { kind: 'absent' }))).toMatchObject({ status: 'deleted', deletions: 1, hash: 'absent' })
    expect(buildFile(input({ kind: 'absent' }, text('')))).toMatchObject({ status: 'added', hunks: [] })
    expect(buildFile(input({ kind: 'absent' }, { kind: 'absent' }))).toBeNull()
  })

  it('gives a row instead of hunks for binary, no baseline, submodule, unreadable and skipped files', () => {
    expect(buildFile(input(text('a'), { kind: 'data', data: Buffer.from([0, 1]) }))!.note).toBe('binary')
    expect(buildFile(input({ kind: 'binary' }, text('a')))!.note).toBe('binary')
    expect(buildFile(input({ kind: 'none' }, text('a')))!.note).toBe('no-baseline')
    expect(buildFile(input(text('a'), { kind: 'dir' }))!.note).toBe('submodule')
    expect(buildFile(input(text('a'), { kind: 'unreadable' }))!.note).toBe('unreadable')
    expect(buildFile(input({ kind: 'skipped' }, { kind: 'skipped' }, { status: 'deleted' }))).toMatchObject({ note: 'too-many', status: 'deleted' })
  })

  it('offers "show anyway" for a too large file up to 10 MB, unless it was already asked for', () => {
    expect(buildFile(input({ kind: 'too-large', size: 2_000_000 }, text('a')))).toMatchObject({ note: 'too-large', canForce: true })
    expect(buildFile(input({ kind: 'too-large', size: MAX_FORCED_BYTES + 1 }, text('a')))).toMatchObject({ note: 'too-large', canForce: false })
    expect(buildFile(input({ kind: 'too-large', size: 2_000_000 }, text('a'), { forced: true }))).toMatchObject({ note: 'too-large', canForce: false })
  })

  it('shows a change that takes too long to diff as too large, with "show anyway"', () => {
    const [a, b] = allChanged(5000)
    const start = Date.now()
    expect(buildFile(input(text(a), text(b)))).toMatchObject({ note: 'too-large', canForce: true, hunks: [], additions: 0 })
    expect(Date.now() - start).toBeLessThan(3000)
  })

  it('gives a file asked for with "show anyway" 3 s instead of 0.3 s, and no second "show anyway"', () => {
    // a clock that jumps a second at every look: a one-line change needs two looks of the diff
    let t = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000))
    expect(buildFile(input(text('a\n'), text('b\n')))).toMatchObject({ note: 'too-large', canForce: true })
    expect(buildFile(input(text('a\n'), text('b\n'), { forced: true }))).toMatchObject({ note: null, additions: 1, deletions: 1 })
    t = 0
    expect(buildFile(input(text('a\nb\nc\n'), text('A\nB\nC\n'), { forced: true }))).toMatchObject({ note: 'too-large', canForce: false })
  })
})

describe('buildFiles', () => {
  const files = (n: number): DiffInput[] => Array.from({ length: n }, (_, i) => input(text('a\n'), text(`b${i}\n`), { path: `/r/f${i}.ts`, relPath: `f${i}.ts` }))

  it('stops diffing after 1.5 s: the files left are listed without hunks', async () => {
    // every file takes a second
    let t = 0
    const r = await buildFiles(files(3), () => (t += 1000))
    expect(r.tooMany).toBe(true)
    expect(r.files.map((f) => f.note)).toEqual([null, null, 'too-many'])
    expect(r.files[2]).toMatchObject({ relPath: 'f2.ts', status: 'modified', hunks: [] })
    expect(VIEW_DIFF_MS).toBe(1500)
  })

  it('is not over its limit when the last file ends past it', async () => {
    let t = 0
    const r = await buildFiles(files(2), () => (t += 1000))
    expect(r.tooMany).toBe(false)
    expect(r.files.map((f) => f.note)).toEqual([null, null])
  })

  it('lets the event loop run between files', async () => {
    const order: string[] = []
    const built = buildFiles(files(3)).then(() => order.push('built'))
    setImmediate(() => order.push('immediate'))
    await built
    expect(order).toEqual(['immediate', 'built'])
  })

  it('passes review.renderMarkdown on to every file', async () => {
    const md = input(text('a\n'), text('b\n'), { path: '/r/a.md', relPath: 'a.md' })
    expect((await buildFiles([md], Date.now, true)).files[0]!.markdown).toBe(true)
    expect((await buildFiles([md])).files[0]!.markdown).toBe(false)
  })
})

describe('Markdown files shown formatted', () => {
  const side = (s: string | null): Side => (s === null ? { kind: 'absent' } : text(s))
  const md = (before: string | null, after: string | null, relPath = 'docs/a.md'): DiffInput => input(side(before), side(after), { path: `/r/${relPath}`, relPath })
  const doc = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
  const before = `${doc.join('\n')}\n`
  const after = `${doc.map((l, i) => (i === 10 ? 'changed' : l)).join('\n')}\n`

  it('holds the whole file in one hunk, so that the panel can format the document', () => {
    const f = buildFile(md(before, after), false, true)!
    expect(f.markdown).toBe(true)
    expect(f.hunks).toHaveLength(1)
    expect(f.hunks[0]!.header).toBe('@@ -1,20 +1,20 @@')
    expect(f.hunks[0]!.lines.filter((l) => l.kind !== 'del').map((l) => l.text)).toEqual(after.trimEnd().split('\n'))
    expect(f.hunks[0]!.lines.filter((l) => l.kind !== 'add').map((l) => l.text)).toEqual(before.trimEnd().split('\n'))
    expect(f).toMatchObject({ additions: 1, deletions: 1 })
  })

  it('keeps three lines of context with the setting off, and for other files', () => {
    for (const f of [buildFile(md(before, after))!, buildFile(md(before, after, 'src/a.ts'), false, true)!]) {
      expect(f.markdown).toBe(false)
      expect(f.hunks[0]!.lines).toHaveLength(8)
    }
  })

  it('tells Markdown by the .md and .markdown extensions, in any case', () => {
    const is = (relPath: string): boolean => buildFile(md(before, after, relPath), false, true)!.markdown
    expect(['README.MD', 'notes.markdown', 'docs/spec.Md'].map(is)).toEqual([true, true, true])
    expect(['a.mdx', 'md', 'a.md.txt', 'docs.md/a.ts'].map(is)).toEqual([false, false, false, false])
  })

  it('formats an added file, and leaves a deleted one and a row without hunks as they are', () => {
    expect(buildFile(md(null, 'a\n'), false, true)).toMatchObject({ status: 'added', markdown: true })
    expect(buildFile(md('a\n', null), false, true)).toMatchObject({ status: 'deleted', markdown: false })
    expect(buildFile(md('a\r\n', 'a\n'), false, true)).toMatchObject({ note: 'eol-only', markdown: false })
    expect(buildFile(md(null, ''), false, true)).toMatchObject({ hunks: [], markdown: false })
  })
})

describe('the lines a hunk hides', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  const before = `${lines.join('\r\n')}\r\n`
  const after = `${lines.map((l, i) => (i === 19 ? 'changed' : l)).join('\r\n')}\r\n`

  it('counts the new side\'s lines for the panel\'s expand buttons; a file without hunks has none', () => {
    expect(buildFile(input(text(before), text(after)))!.lineCount).toBe(40)
    // a last line without a newline counts
    expect(buildFile(input(text('a\nb'), text('a\nB')))!.lineCount).toBe(2)
    expect(buildFile(input({ kind: 'absent' }, text('x\ny\n')))!.lineCount).toBe(2)
    expect(buildFile(input({ kind: 'binary' }, text('a')))!.lineCount).toBe(0)
    expect(buildFile(input(text('a\r\n'), text('a\n')))!.lineCount).toBe(0)
  })

  it('keeps the new side of each changed file with hunks hidden around them, line endings as the diff read them', async () => {
    const r = await buildFiles([
      input(text(before), text(after), { path: '/r/a.ts', relPath: 'a.ts' }),
      input({ kind: 'absent' }, text('new\n'), { path: '/r/new.ts', relPath: 'new.ts' }),
      input(text('gone\n'), { kind: 'absent' }, { path: '/r/gone.ts', relPath: 'gone.ts' }),
      input({ kind: 'binary' }, text('a'), { path: '/r/b.bin', relPath: 'b.bin' })
    ])
    expect([...r.texts.keys()]).toEqual(['/r/a.ts'])
    expect(r.texts.get('/r/a.ts')).toBe(after.replace(/\r\n/g, '\n'))
  })

  it('keeps no text of a Markdown file shown whole', async () => {
    const r = await buildFiles([input(text(before), text(after), { path: '/r/a.md', relPath: 'a.md' })], Date.now, true)
    expect(r.files[0]!.markdown).toBe(true)
    expect(r.texts.size).toBe(0)
  })
})

describe('sliceLines', () => {
  it('gives lines from..to, counted from 1, without their newlines', () => {
    expect(sliceLines('a\nb\nc\n', 2, 3)).toEqual(['b', 'c'])
    expect(sliceLines('a\nb\nc', 1, 3)).toEqual(['a', 'b', 'c'])
    expect(sliceLines('a\n\nc\n', 2, 2)).toEqual([''])
  })

  it('gives null for lines the text does not have', () => {
    expect(sliceLines('a\nb\n', 2, 3)).toBeNull()
    expect(sliceLines('a\nb', 3, 3)).toBeNull()
    expect(sliceLines('', 1, 1)).toBeNull()
  })
})
