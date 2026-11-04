import markdownit, { type Token } from 'markdown-it'
import type { ReviewLine } from '../shared/review'

export type MdSegmentKind = 'same' | 'added' | 'removed'

/** a block of the formatted document: its HTML, and the lines of the hunk it was made of (from..to) */
export interface MdSegment {
  kind: MdSegmentKind
  html: string
  from: number
  to: number
}

/**
 * what the caller knows about the document's images: the address to show one at, or null to show its text. Its argument is
 * markdown-it's normalized image address, percent-encoded as in a URL (a space is %20, "отчёт/x.png" is %D0%BE...%D1%91...).
 */
export interface MdEnv {
  imageUrl?(src: string): string | null
}

// raw HTML is shown as text; markdown-it leaves out javascript:, vbscript:, file: and data: links
const md = markdownit({ html: false, linkify: true })

// an image shows its text unless the env gives it an address: the Changes panel loads images only through ctimg://
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!
  const raw = String(t.attrGet('src') ?? '')
  const src = md.utils.escapeHtml(raw)
  const text = self.renderInlineAsText(t.children ?? [], options, env) || 'image'
  const url = (env as MdEnv).imageUrl?.(raw) ?? null
  if (url !== null) return `<img class="md-img" src="${md.utils.escapeHtml(url)}" alt="${md.utils.escapeHtml(text)}" title="${src}">`
  return `<span class="md-image" title="${src}">${md.utils.escapeHtml(text)}</span>`
}

// "- [ ] task" and "- [x] task" show a checkbox
md.core.ruler.push('task_lists', (state) => {
  const t = state.tokens
  for (let i = 2; i < t.length; i++) {
    if (t[i]!.type !== 'inline' || t[i - 1]!.type !== 'paragraph_open' || t[i - 2]!.type !== 'list_item_open') continue
    const first = t[i]!.children?.[0]
    const m = first?.type === 'text' ? /^\[([ xX])\] /.exec(first.content) : null
    if (!first || !m) continue
    first.content = first.content.slice(m[0].length)
    const box = new state.Token('html_inline', '', 0)
    box.content = `<input type="checkbox" class="md-task" disabled${m[1] === ' ' ? '' : ' checked'}> `
    t[i]!.children!.unshift(box)
    t[i - 2]!.attrJoin('class', 'md-task-item')
  }
})

const YAML_KEY = /^["']?[\w .-]+["']?\s*:/
/** a line front matter may hold: blank, indented, a list item, a comment or a key */
const YAML_LINE = /^(\s|- |#|$)/

/** the line that ends the YAML front matter the lines open with ("---", a key, ..., "---"); -1 when they have none */
function frontMatterEnd(lines: string[]): number {
  if (lines[0] !== '---' || !YAML_KEY.test(lines[1] ?? '')) return -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') return i
    if (!YAML_KEY.test(lines[i]!) && !YAML_LINE.test(lines[i]!)) return -1
  }
  return -1
}

/**
 * The text markdown-it reads for the lines, one line for each: a lone CR is a space (the diff keeps it inside its line), and
 * the front matter of the top of the file is a code block of the same lines, so that it is not read as a heading.
 */
function source(texts: string[], top: boolean): string {
  const lines = texts.map((l) => l.replace(/\r/g, ' '))
  const end = top ? frontMatterEnd(lines) : -1
  if (end < 0) return lines.join('\n')
  const fence = '~~~~~~~~~~'
  return [`${fence} yaml`, ...lines.slice(1, end), fence, ...lines.slice(end + 1)].join('\n')
}

/** the index of the token that closes the one at `i`; `i` itself for a token that opens nothing */
function closing(tokens: Token[], i: number): number {
  if (tokens[i]!.nesting !== 1) return i
  let depth = 0
  for (let j = i; j < tokens.length; j++) {
    depth += tokens[j]!.nesting
    if (depth === 0) return j
  }
  return tokens.length - 1
}

/** a block to show: its tokens, and its lines in the parsed text (start..end, end not included) */
interface Unit {
  start: number
  end: number
  tokens: Token[]
}

/** the top-level blocks of the document; a list gives each of its items, each in a list of its own that keeps its number */
function units(tokens: Token[]): Unit[] {
  const out: Unit[] = []
  for (let i = 0; i < tokens.length; i = closing(tokens, i) + 1) {
    const t = tokens[i]!
    const close = closing(tokens, i)
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      for (let j = i + 1; j < close; j = closing(tokens, j) + 1) {
        const item = tokens[j]!
        if (!item.map) continue
        const open = Object.assign(Object.create(Object.getPrototypeOf(t) as object) as Token, t, { attrs: t.attrs?.map(([k, v]) => [k, v]) ?? null })
        const n = Number(item.info)
        if (t.type === 'ordered_list_open' && item.info !== '' && Number.isInteger(n)) {
          if (n === 1) open.attrs = open.attrs?.filter(([k]) => k !== 'start') ?? null
          else open.attrSet('start', String(n))
        }
        out.push({ start: item.map[0], end: item.map[1], tokens: [open, ...tokens.slice(j, closing(tokens, j) + 1), tokens[close]!] })
      }
    } else if (t.map) {
      out.push({ start: t.map[0], end: t.map[1], tokens: tokens.slice(i, close + 1) })
    }
  }
  return out
}

/**
 * The formatted document of a hunk that holds a whole Markdown file: its blocks in order. A block with added or removed
 * lines is "added", after its old version ("removed") when it lost lines; blocks removed whole are "removed" where they
 * were. A new file (added lines only) is the plain document.
 */
export function markdownSegments(lines: ReviewLine[], env: MdEnv = {}): MdSegment[] {
  const newIdx = lines.flatMap((l, i) => (l.kind === 'del' ? [] : [i]))
  const plain = lines.every((l) => l.kind === 'add')
  const out: MdSegment[] = []
  /** the old version of lines from..to: the removed and unchanged ones */
  const old = (from: number, to: number): string => {
    const texts = lines.slice(from, to + 1).filter((l) => l.kind !== 'add')
    return md.render(source(texts.map((l) => l.text), texts[0]?.oldNo === 1), { ...env })
  }
  /** the blocks removed whole between `from` and `to` */
  const removed = (from: number, to: number): void => {
    const dels = lines.slice(from, to + 1).flatMap((l, k) => (l.kind === 'del' ? [from + k] : []))
    if (dels.length > 0) out.push({ kind: 'removed', html: old(dels[0]!, dels[dels.length - 1]!), from: dels[0]!, to: dels[dels.length - 1]! })
  }
  const tokens = md.parse(source(newIdx.map((i) => lines[i]!.text), true), { ...env })
  let pos = 0
  for (const u of units(tokens)) {
    const from = newIdx[u.start]!
    const to = newIdx[Math.min(u.end, newIdx.length) - 1]!
    removed(pos, from - 1)
    const inside = lines.slice(from, to + 1)
    if (inside.some((l) => l.kind === 'del')) out.push({ kind: 'removed', html: old(from, to), from, to })
    const changed = !plain && inside.some((l) => l.kind !== 'context')
    out.push({ kind: changed ? 'added' : 'same', html: md.renderer.render(u.tokens, md.options, { ...env }), from, to })
    pos = to + 1
  }
  removed(pos, lines.length - 1)
  return out
}

/**
 * The segment that shows line `i` of the hunk: in a changed block, its old version for a removed line and the new one
 * otherwise; a line between blocks goes to the block above it, one above every block to the first.
 */
export function segmentOf(segments: MdSegment[], lines: ReviewLine[], i: number): number {
  let best = 0
  segments.forEach((s, k) => {
    if (s.from > i) return
    const inside = i <= s.to
    const kind = lines[i]?.kind
    if (inside && kind === 'del' && s.kind !== 'removed') return
    if (inside && kind === 'add' && s.kind === 'removed') return
    best = k
  })
  return best
}
