import { describe, expect, it } from 'vitest'
import { chatMarkdownHtml, openableLink, splitStable } from '../../src/renderer/chat/chat-markdown'

describe('chatMarkdownHtml', () => {
  it('raw HTML is escaped', () => {
    const html = chatMarkdownHtml('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })

  it('javascript links are not links', () => {
    const html = chatMarkdownHtml('[x](javascript:alert(1))')
    expect(html).not.toContain('href="javascript')
  })

  it('a link is a chat-link', () => {
    const html = chatMarkdownHtml('[docs](https://x.dev)')
    expect(html).toContain('<a href="https://x.dev" class="chat-link">docs</a>')
  })

  it('a bare URL is linkified as a chat-link', () => {
    const html = chatMarkdownHtml('see https://x.dev/a')
    expect(html).toContain('class="chat-link"')
    expect(html).toContain('href="https://x.dev/a"')
  })

  it('a fence gets a Copy button and escapes its code', () => {
    const html = chatMarkdownHtml('```html\n<b>x</b>\n```')
    expect(html).toContain('class="chat-copy"')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('<span class="chat-code-lang">html</span>')
    expect(html).toContain('<div class="chat-code">')
  })

  it('a fence without a language has an empty language label', () => {
    const html = chatMarkdownHtml('```\nx\n```')
    expect(html).toContain('<span class="chat-code-lang"></span>')
  })

  it('a Markdown image is not an img', () => {
    const html = chatMarkdownHtml('![chart](https://x.dev/c.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('<a href="https://x.dev/c.png" class="chat-link">chart</a>')
  })

  it('a data: image is not a link and its URI is not in the output', () => {
    const html = chatMarkdownHtml('![q](data:image/png;base64,AAAA)')
    expect(html).not.toContain('data:')
    expect(html).toBe('<p>q</p>\n')
  })

  it('a data: link keeps its text but has no href', () => {
    expect(chatMarkdownHtml('[x](data:image/png;base64,AAAA)')).toBe('<p><a class="chat-link">x</a></p>\n')
  })

  it('a relative link keeps its text but has no href', () => {
    expect(chatMarkdownHtml('[a](src/a.ts)')).toBe('<p><a class="chat-link">a</a></p>\n')
  })

  it('a quote in an image alt text is escaped', () => {
    const html = chatMarkdownHtml('![<script>"x](https://x.dev/c.png)')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;&quot;x')
  })

  it('a quote in an image address cannot start an attribute', () => {
    const html = chatMarkdownHtml('![a](https://x.dev/c.png"onmouseover=alert(1))')
    expect(html).not.toMatch(/<[^>]*\son\w+=/i)
    expect(html).not.toContain('"onmouseover')
  })

  it('a quote and a tag in a fence info string are escaped', () => {
    const html = chatMarkdownHtml('```"><img src=x onerror=1>\nx\n```')
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<[^>]*onerror/i)
    expect(html).toContain('&quot;&gt;&lt;img')
  })

  it('a quote in a linkified URL cannot start an attribute', () => {
    const html = chatMarkdownHtml('see www.a.com/"onclick=1')
    expect(html).not.toMatch(/<[^>]*\sonclick=/i)
    expect(html).not.toContain('"onclick')
  })

  it('a table keeps its markup inside a scrolling wrapper', () => {
    const html = chatMarkdownHtml('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<div class="chat-table"><table>')
    expect(html).toMatch(/<\/table>\n<\/div>$/)
  })
})

describe('splitStable', () => {
  it('keeps an open fence in the tail', () => {
    expect(splitStable('a\n\n```\nb\n\nc')).toEqual({ stable: 'a\n\n', tail: '```\nb\n\nc' })
  })

  it('splits at the last block boundary when no fence is open', () => {
    expect(splitStable('a\n\nb\n\nc')).toEqual({ stable: 'a\n\nb\n\n', tail: 'c' })
  })

  it('has no boundary: everything is the tail', () => {
    expect(splitStable('one line')).toEqual({ stable: '', tail: 'one line' })
  })

  it('a closed fence counts as complete', () => {
    expect(splitStable('```\nx\n```\n\nnext')).toEqual({ stable: '```\nx\n```\n\n', tail: 'next' })
  })

  it('a boundary inside a fence is not a boundary', () => {
    expect(splitStable('```\na\n\nb')).toEqual({ stable: '', tail: '```\na\n\nb' })
  })

  it('a blank line inside a ~~~ block is not a boundary', () => {
    expect(splitStable('~~~\na\n\nb')).toEqual({ stable: '', tail: '~~~\na\n\nb' })
  })

  it('a ``` line inside a four-backtick block does not close it', () => {
    expect(splitStable('````\n```\n\nx\n````\n\nnext')).toEqual({ stable: '````\n```\n\nx\n````\n\n', tail: 'next' })
  })

  it('a ~~~ line does not close a backtick block', () => {
    expect(splitStable('```\na\n~~~\n\nb')).toEqual({ stable: '', tail: '```\na\n~~~\n\nb' })
  })

  it('a CRLF blank line is a boundary', () => {
    expect(splitStable('a\r\n\r\nb')).toEqual({ stable: 'a\r\n\r\n', tail: 'b' })
  })
})

describe('openableLink', () => {
  it('only http and https links open outside', () => {
    expect(openableLink('https://x.dev')).toBe(true)
    expect(openableLink('http://x.dev/a?b=c')).toBe(true)
    expect(openableLink('file:///c')).toBe(false)
    expect(openableLink('mailto:a@b')).toBe(false)
    expect(openableLink('vscode://x')).toBe(false)
    expect(openableLink('javascript:alert(1)')).toBe(false)
  })

  it('a string that is not a URL does not open', () => {
    expect(openableLink('not a url')).toBe(false)
    expect(openableLink('')).toBe(false)
  })
})

describe('chatMarkdownHtml with paths', () => {
  it("a path in Claude's text is a pending element that carries the path and its line", () => {
    expect(chatMarkdownHtml('see src/a.ts:12.', { paths: true }))
      .toBe('<p>see <span class="chat-path" data-path="src/a.ts:12">src/a.ts:12</span>.</p>\n')
  })
  it('a path in an inline code span is one too', () => {
    expect(chatMarkdownHtml('`src/main/index.ts:120`', { paths: true }))
      .toBe('<p><code><span class="chat-path" data-path="src/main/index.ts:120">src/main/index.ts:120</span></code></p>\n')
  })
  it('a Markdown link to a path carries the path; its text is not wrapped again', () => {
    expect(chatMarkdownHtml('[spec](docs/spec.md)', { paths: true }))
      .toBe('<p><a class="chat-link chat-path" data-path="docs/spec.md">spec</a></p>\n')
    expect(chatMarkdownHtml('[src/a.ts](src/a.ts#L12)', { paths: true }))
      .toBe('<p><a class="chat-link chat-path" data-path="src/a.ts:12">src/a.ts</a></p>\n')
    expect(chatMarkdownHtml('[x](<my file.md>)', { paths: true }))
      .toBe('<p><a class="chat-link chat-path" data-path="my file.md">x</a></p>\n')
  })
  it('a web link and its text, a code fence and a word with a dot are not paths', () => {
    for (const s of ['see https://x.dev/a/b.md', '[x](https://x.dev/a.md)', '[`src/a.ts`](https://x.dev)', '```\nsrc/a.ts\n```', 'node.js and README.md']) {
      expect(chatMarkdownHtml(s, { paths: true })).not.toContain('chat-path')
    }
  })
  it('a path is escaped in its text and in its attribute', () => {
    const html = chatMarkdownHtml('see src/a&b.ts', { paths: true })
    expect(html).toContain('data-path="src/a&amp;b.ts"')
    expect(html).toContain('>src/a&amp;b.ts</span>')
  })
  it('without the paths option nothing is wrapped', () => {
    expect(chatMarkdownHtml('see src/a.ts and `src/b.ts`')).toBe('<p>see src/a.ts and <code>src/b.ts</code></p>\n')
    expect(chatMarkdownHtml('[a](src/a.ts)')).toBe('<p><a class="chat-link">a</a></p>\n')
  })
})
