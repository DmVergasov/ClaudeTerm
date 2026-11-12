import markdownit from 'markdown-it'

// raw HTML is shown as text; markdown-it leaves out javascript:, vbscript:, file: and data: links
const md = markdownit({ html: false, linkify: true, breaks: false })

// every link Claude writes gets the chat-link class; only an openable address stays as its href, so any other link is
// text that cannot navigate (a relative path, a data: URI)
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!
  if (!openableLink(String(t.attrGet('href') ?? ''))) t.attrs = (t.attrs ?? []).filter(([name]) => name !== 'href')
  t.attrSet('class', 'chat-link')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

// an image shows its text as a link to its address when that address is openable; otherwise its text alone. The chat
// never loads Claude's images.
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!
  const src = String(t.attrGet('src') ?? '')
  const text = md.utils.escapeHtml(self.renderInlineAsText(t.children ?? [], options, env) || 'image')
  if (!openableLink(src)) return text
  return `<a href="${md.utils.escapeHtml(src)}" class="chat-link">${text}</a>`
}

// a code fence gets a header with its language and a Copy button; the code is escaped
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx]!
  const lang = md.utils.escapeHtml((t.info ?? '').trim().split(/\s+/)[0] ?? '')
  return '<div class="chat-code"><div class="chat-code-head">' +
    `<span class="chat-code-lang">${lang}</span><button class="chat-copy" type="button">Copy</button></div>` +
    `<pre><code>${md.utils.escapeHtml(t.content)}</code></pre></div>\n`
}

// a table scrolls sideways inside its wrapper
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  '<div class="chat-table">' + self.renderToken(tokens, idx, options)
md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options) + '</div>'

/** markdown-it's HTML for Claude's text: raw HTML off, linkify on, code fences with a Copy button */
export function chatMarkdownHtml(text: string): string {
  return md.render(text)
}

/** the text Claude's Markdown shows, as Find searches it: rendered into a detached element, which is never drawn or loaded */
export function chatMarkdownText(text: string): string {
  const box = document.createElement('div')
  box.innerHTML = md.render(text)
  return box.textContent ?? ''
}

/**
 * the text up to the last block boundary (a blank line, "\n\n" or "\r\n\r\n") outside a code fence, and the rest: only the
 * rest is drawn again while the text streams. No boundary: the whole text is the tail. A fence opens and closes as
 * markdown-it reads it: ``` or ~~~, closed by the same character with at least as many.
 */
export function splitStable(text: string): { stable: string; tail: string } {
  let fence: { ch: string; len: number } | null = null
  let boundary = -1
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) break
    const line = text.slice(start, nl).replace(/\r$/, '')
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) fence = null
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) fence = { ch: open[1]![0]!, len: open[1]!.length }
      // a blank line that follows another line ends a block
      else if (start > 0 && line.trim() === '') boundary = nl + 1
    }
    start = nl + 1
  }
  if (boundary === -1) return { stable: '', tail: text }
  return { stable: text.slice(0, boundary), tail: text.slice(boundary) }
}

/** the revert timer of each Copy button */
const copyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/**
 * A click in Claude's Markdown, the same for a message's text and a plan card: a web link opens in the browser, every link is
 * kept from navigating, and a Copy button copies its block's code.
 */
export function markdownClick(e: MouseEvent, cb: { openExternal(url: string): void; copy(text: string): void }): void {
  const target = e.target as Element | null
  const link = target?.closest('a')
  if (link) {
    // a link never navigates the window: only an openable address goes to the browser
    e.preventDefault()
    const href = link.getAttribute('href')
    if (href !== null && openableLink(href)) cb.openExternal(new URL(href).href)
    return
  }
  const copy = target?.closest<HTMLButtonElement>('.chat-copy')
  if (!copy) return
  const code = copy.closest('.chat-code')?.querySelector('pre code')?.textContent ?? ''
  cb.copy(code.replace(/\n$/, ''))
  copy.textContent = 'Copied'
  // a second click restarts the 1.5 s: the first timer does not end the new one early
  clearTimeout(copyTimers.get(copy))
  copyTimers.set(copy, setTimeout(() => { copy.textContent = 'Copy' }, 1500))
}

/** a link Claude wrote may be opened outside: http(s) only */
export function openableLink(href: string): boolean {
  try {
    const protocol = new URL(href).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
