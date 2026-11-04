export type DocKind = 'markdown' | 'pdf' | 'html'

export const DOC_TYPES = 'md, markdown, pdf, html, htm'
export const MAX_DOC_BYTES: Record<DocKind, number> = {
  markdown: 5 * 1024 * 1024,
  html: 20 * 1024 * 1024,
  pdf: 200 * 1024 * 1024
}
export const MAX_DOC_TITLE = 100
export const DOC_SCHEME = 'ctdoc'
export const DOC_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']

const KIND_BY_EXTENSION: Record<string, DocKind> = { md: 'markdown', markdown: 'markdown', pdf: 'pdf', html: 'html', htm: 'html' }
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

export interface DocInfo {
  id: string
  path: string
  relPath: string
  name: string
  title: string | null
  kind: DocKind
  /** the document's own ctdoc:// address */
  url: string
}

/** docs newest first; reveal is the id show_document just showed */
export interface DocsUpdate {
  tabId: string
  docs: DocInfo[]
  reveal: string | null
}

export type DocAction = 'open' | 'reveal' | 'copy-path' | 'remove'
export const DOC_ACTIONS: readonly DocAction[] = ['open', 'reveal', 'copy-path', 'remove']

export type DocRead = { ok: true; text: string; stamp: string } | { ok: false; error: string }

export function docKindOf(path: string): DocKind | null {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}

/** The ctdoc:// address of an image a Markdown document refers to by a relative path; null for anything else. */
export function docImageUrl(doc: { id: string; url: string }, src: string): string | null {
  if (src === '' || src.startsWith('/') || src.startsWith('\\') || src.startsWith('#') || SCHEME_RE.test(src)) return null
  try {
    const href = new URL(src, doc.url).href
    return href.startsWith(`${DOC_SCHEME}://${doc.id}/`) ? href : null
  } catch {
    return null
  }
}
