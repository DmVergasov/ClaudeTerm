import { describe, expect, it } from 'vitest'
import { markdownSegments, segmentOf } from '../../src/renderer/markdown-diff'
import { docLines } from '../../src/renderer/doc-lines'
import type { ReviewLine } from '../../src/shared/review'

/** a whole-file hunk from marked lines: ' ' unchanged, '+' added, '-' removed */
function hunk(...marked: string[]): ReviewLine[] {
  let oldNo = 1
  let newNo = 1
  return marked.map((m): ReviewLine => {
    const text = m.slice(1)
    if (m[0] === '+') return { kind: 'add', text, oldNo: null, newNo: newNo++ }
    if (m[0] === '-') return { kind: 'del', text, oldNo: oldNo++, newNo: null }
    return { kind: 'context', text, oldNo: oldNo++, newNo: newNo++ }
  })
}

/** "kind from-to: html" for every segment */
const brief = (lines: ReviewLine[]): string[] => markdownSegments(lines).map((s) => `${s.kind} ${s.from}-${s.to}: ${s.html.trim()}`)

describe('markdownSegments', () => {
  it('formats each block, and marks the blocks that are new', () => {
    expect(brief(hunk(' # Title', ' ', ' Some *text*.', '+', '+More.'))).toEqual([
      'same 0-0: <h1>Title</h1>',
      'same 2-2: <p>Some <em>text</em>.</p>',
      'added 4-4: <p>More.</p>'
    ])
  })

  it('shows a changed block as it was, removed, above the block as it is now', () => {
    expect(brief(hunk(' First line', '-second line', '+second LINE'))).toEqual([
      'removed 0-2: <p>First line\nsecond line</p>',
      'added 0-2: <p>First line\nsecond LINE</p>'
    ])
    expect(brief(hunk(' # T', ' ', '-Old text.', '+New text.'))).toEqual([
      'same 0-0: <h1>T</h1>',
      'removed 2-2: <p>Old text.</p>',
      'added 3-3: <p>New text.</p>'
    ])
  })

  it('shows a removed block where it was', () => {
    expect(brief(hunk(' A', ' ', '-B', '-', ' C'))).toEqual([
      'same 0-0: <p>A</p>',
      'removed 2-3: <p>B</p>',
      'same 4-4: <p>C</p>'
    ])
    expect(brief(hunk(' A', '-', '-B'))).toEqual(['same 0-0: <p>A</p>', 'removed 1-2: <p>B</p>'])
  })

  it('keeps the blank line between two removed paragraphs', () => {
    expect(brief(hunk(' A', ' ', '-B', '-', '-C', ' ', ' D'))[1]).toBe('removed 2-4: <p>B</p>\n<p>C</p>')
  })

  it('shows a new file as a plain document, without marks', () => {
    expect(brief(hunk('+# New', '+', '+Text.'))).toEqual(['same 0-0: <h1>New</h1>', 'same 2-2: <p>Text.</p>'])
  })

  it('makes each list item a block of its own, in a list that keeps its numbers', () => {
    expect(brief(hunk(' 1. one', ' 2. two', '+3. three'))).toEqual([
      'same 0-0: <ol>\n<li>one</li>\n</ol>',
      'same 1-1: <ol start="2">\n<li>two</li>\n</ol>',
      'added 2-2: <ol start="3">\n<li>three</li>\n</ol>'
    ])
    expect(brief(hunk(' - a', '+- b'))).toEqual(['same 0-0: <ul>\n<li>a</li>\n</ul>', 'added 1-1: <ul>\n<li>b</li>\n</ul>'])
  })

  it('keeps a code block whole when a line inside it changes', () => {
    expect(brief(hunk(' ```ts', ' const a = 1', '-const b = 2', '+const b = 3', ' ```'))).toEqual([
      'removed 0-4: <pre><code class="language-ts">const a = 1\nconst b = 2\n</code></pre>',
      'added 0-4: <pre><code class="language-ts">const a = 1\nconst b = 3\n</code></pre>'
    ])
  })

  it('shows tables and task lists', () => {
    const [table] = markdownSegments(hunk(' | a | b |', ' |---|---|', ' | 1 | 2 |'))
    expect(table!.html).toContain('<table>')
    expect(table!.html).toContain('<td>2</td>')
    const tasks = markdownSegments(hunk(' - [ ] todo', ' - [x] done')).map((s) => s.html)
    expect(tasks[0]).toContain('<input type="checkbox" class="md-task" disabled> todo')
    expect(tasks[1]).toContain('<input type="checkbox" class="md-task" disabled checked> done')
  })

  it('shows raw HTML as text, drops script links, and shows an image as its text', () => {
    const [html, para] = markdownSegments(hunk(' <script>alert(1)</script>', ' ', ' [x](javascript:alert(1)) ![logo](img/logo.png) <b>b</b>')).map((s) => s.html)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script')
    expect(para).not.toContain('href="javascript')
    expect(para).toContain('<span class="md-image" title="img/logo.png">logo</span>')
    expect(para).not.toContain('<img')
    expect(para).toContain('&lt;b&gt;')
  })

  it('shows an image the env gives an address for', () => {
    const [seg] = markdownSegments(docLines('![shot](img/a.png)\n'), { imageUrl: (src) => (src === 'img/a.png' ? 'ctdoc://id/img/a.png' : null) })
    expect(seg!.html).toContain('<img class="md-img" src="ctdoc://id/img/a.png" alt="shot" title="img/a.png">')
  })

  it('escapes a hostile image address and alt text in the img markup', () => {
    const [seg] = markdownSegments(docLines('![a"><script>](x.png)\n'), { imageUrl: () => 'x" onerror="y' })
    expect(seg!.html).toContain('src="x&quot; onerror=&quot;y"')
    expect(seg!.html).not.toContain('onerror="y')
    expect(seg!.html).not.toContain('<script>')
  })

  it('gives imageUrl the normalized, percent-encoded address', () => {
    const seen: string[] = []
    markdownSegments(docLines('![shot](<img/my shot.png>)\n![b](отчёт/x.png)\n'), {
      imageUrl: (src) => {
        seen.push(src)
        return null
      }
    })
    expect(seen).toEqual(['img/my%20shot.png', '%D0%BE%D1%82%D1%87%D1%91%D1%82/x.png'])
  })

  it('without an address an image stays text', () => {
    const [seg] = markdownSegments(docLines('![shot](img/a.png)\n'), { imageUrl: () => null })
    expect(seg!.html).toContain('class="md-image"')
    expect(seg!.html).not.toContain('<img')
  })

  it('keeps an http link a link', () => {
    expect(markdownSegments(hunk(' See [docs](https://example.com/docs).'))[0]!.html).toContain('<a href="https://example.com/docs">docs</a>')
  })

  it('shows YAML front matter as a code block, not as a heading', () => {
    const segs = markdownSegments(hunk(' ---', ' name: x', ' ---', ' ', ' Body'))
    expect(segs.map((s) => [s.kind, s.from, s.to])).toEqual([['same', 0, 2], ['same', 4, 4]])
    expect(segs[0]!.html).toContain('<pre>')
    expect(segs[0]!.html).toContain('name: x')
    expect(segs[0]!.html).not.toContain('<h2')
  })

  it('takes a "---" line at the top for a rule, not front matter, when what follows is not YAML', () => {
    const segs = markdownSegments(hunk(' ---', ' # Title', ' ', ' text', ' ---'))
    expect(segs[0]!.html.trim()).toBe('<hr>')
    expect(segs[1]!.html.trim()).toBe('<h1>Title</h1>')
  })

  it('shows changed front matter as it was above it as it is', () => {
    expect(brief(hunk(' ---', ' name: x', '-status: draft', '+status: review', ' ---', ' ', ' Body')).slice(0, 2).map((s) => s.slice(0, 16))).toEqual([
      'removed 0-4: <pr',
      'added 0-4: <pre>'
    ])
    const [old, now] = markdownSegments(hunk(' ---', ' name: x', '-status: draft', '+status: review', ' ---'))
    expect(old!.html).toContain('status: draft')
    expect(now!.html).toContain('status: review')
  })

  it('counts a lone carriage return as part of its line, as the diff does', () => {
    expect(brief(hunk(' a\rb', ' ', ' c')).map((s) => s.slice(0, 8))).toEqual(['same 0-0', 'same 2-2'])
  })

  it('marks a changed item of a loose list, and an item whose nested list changed', () => {
    expect(markdownSegments(hunk(' - one', ' ', '-- two', '+- TWO', ' ', ' - three')).map((s) => [s.kind, s.from, s.to])).toEqual([
      ['same', 0, 1], ['removed', 2, 2], ['added', 3, 4], ['same', 5, 5]
    ])
    const nested = markdownSegments(hunk(' - top', '   - a', '+  - b', ' - next'))
    expect(nested.map((s) => [s.kind, s.from, s.to])).toEqual([['added', 0, 2], ['same', 3, 3]])
    expect(nested[0]!.html).toContain('<li>b</li>')
  })

  it('gives no segments for an empty document', () => {
    expect(markdownSegments(hunk(' '))).toEqual([])
  })
})

describe('segmentOf', () => {
  const lines = hunk(' A', ' ', '-B', '+C', ' ', ' D')
  const segs = markdownSegments(lines)

  it('finds the segment that shows a line: a removed line in the old block, an added one in the new', () => {
    expect(segs.map((s) => s.kind)).toEqual(['same', 'removed', 'added', 'same'])
    expect(segmentOf(segs, lines, 0)).toBe(0)
    expect(segmentOf(segs, lines, 2)).toBe(1)
    expect(segmentOf(segs, lines, 3)).toBe(2)
    expect(segmentOf(segs, lines, 5)).toBe(3)
  })

  it('gives a line between blocks to the block above it, and one above all blocks to the first', () => {
    expect(segmentOf(segs, lines, 4)).toBe(2)
    const top = hunk(' ', ' A')
    expect(segmentOf(markdownSegments(top), top, 0)).toBe(0)
  })
})
