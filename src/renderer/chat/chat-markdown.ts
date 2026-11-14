import markdownit from 'markdown-it'
import { findPaths, linkPath, pathRefText } from '../../shared/chat-paths'

// the render environment: `paths` marks the paths in the text, `links` counts the links open at this point
type RenderEnv = { paths?: boolean; links?: number; [key: string]: unknown }

// raw HTML is shown as text; markdown-it leaves out javascript:, vbscript:, file: and data: links
const md = markdownit({ html: false, linkify: true, breaks: false })

// every link Claude writes gets the chat-link class; only an openable address stays as its href, so any other link is
// text that cannot navigate (a relative path, a data: URI). With the paths option, a link to a file is a chat-path too
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env: RenderEnv | undefined, self) => {
  const t = tokens[idx]!
  const href = String(t.attrGet('href') ?? '')
  if (!openableLink(href)) t.attrs = (t.attrs ?? []).filter(([name]) => name !== 'href')
  const file = env?.paths ? linkPath(md.normalizeLinkText(href)) : null
  t.attrSet('class', file ? 'chat-link chat-path' : 'chat-link')
  if (file) t.attrSet('data-path', pathRefText(file))
  if (env) env.links = (env.links ?? 0) + 1
  return defaultLinkOpen(tokens, idx, options, env, self)
}
const defaultLinkClose = md.renderer.rules.link_close ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_close = (tokens, idx, options, env: RenderEnv | undefined, self) => {
  if (env) env.links = (env.links ?? 0) - 1
  return defaultLinkClose(tokens, idx, options, env, self)
}

// the text escaped, with each path in it (outside a link, which is a path already) as a pending chat-path element for main
// to resolve
function wrapPaths(text: string, env: RenderEnv | undefined): string {
  if (!env?.paths || env.links) return md.utils.escapeHtml(text)
  let html = ''
  let last = 0
  for (const { start, end, ref } of findPaths(text)) {
    const attr = md.utils.escapeHtml(pathRefText(ref))
    html += md.utils.escapeHtml(text.slice(last, start)) +
      `<span class="chat-path" data-path="${attr}">${md.utils.escapeHtml(text.slice(start, end))}</span>`
    last = end
  }
  return html + md.utils.escapeHtml(text.slice(last))
}
md.renderer.rules.text = (tokens, idx, _options, env: RenderEnv | undefined) => wrapPaths(tokens[idx]!.content, env)
md.renderer.rules.code_inline = (tokens, idx, _options, env: RenderEnv | undefined, self) => {
  const t = tokens[idx]!
  return `<code${self.renderAttrs(t)}>${wrapPaths(t.content, env)}</code>`
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

/**
 * markdown-it's HTML for Claude's text: raw HTML off, linkify on, code fences with a Copy button. With `paths`, a path in the
 * text, in a code span or in a link to a file is a pending chat-path element that carries the path (and its line) for main to
 * resolve; a path inside another link's text is not wrapped again.
 */
export function chatMarkdownHtml(text: string, o: { paths?: boolean } = {}): string {
  const env: RenderEnv = { paths: o.paths === true, links: 0 }
  return md.render(text, env)
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
