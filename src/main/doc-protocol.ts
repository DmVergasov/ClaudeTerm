import { net, protocol, type CustomScheme } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DOC_IMAGE_EXTENSIONS, DOC_SCHEME } from '../shared/docs'
import type { DocEntry } from './doc-hub'
import { isWithin, pathKey } from './path-key'

export const DOC_SCHEME_PRIVILEGES: CustomScheme = { scheme: DOC_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }

/** The part of the disk a document request may touch. */
export interface DocFs {
  realpath(p: string): Promise<string>
  isFile(p: string): Promise<boolean>
}

export const nodeDocFs: DocFs = {
  realpath: (p) => realpath(p),
  async isFile(p) {
    try {
      return (await stat(p)).isFile()
    } catch {
      return false
    }
  }
}

/** Chromium's built-in PDF viewer, which a PDF document is shown in */
const PDF_VIEWER_PREFIX = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'

const CONTENT_TYPES = new Map<string, string>([
  ['pdf', 'application/pdf'],
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['css', 'text/css'],
  ['js', 'text/javascript'],
  ['mjs', 'text/javascript'],
  ['json', 'application/json'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp']
])

/** A decoded segment of a request that may not name a file: a dot segment, a slash or a NUL, and a backslash on Windows, where it separates folders. */
export function badSegment(segment: string, windows: boolean = process.platform === 'win32'): boolean {
  return segment === '.' || segment === '..' || /[/\0]/.test(segment) || (windows && segment.includes('\\'))
}

/** Maps a ctdoc:// request to a servable file path and its document, or null (404). */
export async function resolveDocRequest(
  url: string,
  find: (id: string) => DocEntry | undefined,
  fs: DocFs
): Promise<{ path: string; doc: DocEntry } | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${DOC_SCHEME}:`) return null
  const doc = find(parsed.hostname)
  if (!doc) return null

  const segments: string[] = []
  for (const raw of parsed.pathname.split('/')) {
    if (raw === '') continue
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (badSegment(segment)) return null
    segments.push(segment)
  }
  if (segments.length === 0) return null

  const target = join(doc.root, ...segments)
  if (pathKey(target) === pathKey(doc.path) && (doc.kind === 'pdf' || doc.kind === 'html')) {
    return (await fs.isFile(target)) ? { path: target, doc } : null
  }
  if (doc.kind === 'pdf') return null
  if (doc.kind === 'markdown' && !DOC_IMAGE_EXTENSIONS.includes(extname(target).slice(1).toLowerCase())) return null

  let real: string
  let realRoot: string
  try {
    real = await fs.realpath(target)
    realRoot = await fs.realpath(doc.root)
  } catch {
    return null
  }
  return isWithin(realRoot, real) && (await fs.isFile(real)) ? { path: real, doc } : null
}

/** The headers a document response carries: its Content-Type, and for an HTML report a policy that keeps it to its own document. */
export function docResponseHeaders(doc: DocEntry, path: string): Record<string, string> {
  const headers: Record<string, string> = {}
  const type = CONTENT_TYPES.get(extname(path).slice(1).toLowerCase())
  if (type) headers['Content-Type'] = type
  if (doc.kind === 'html') {
    headers['Content-Security-Policy'] = `default-src ${DOC_SCHEME}://${doc.id} data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'`
    headers['Access-Control-Allow-Origin'] = '*'
  }
  return headers
}

/** Whether a frame may navigate to url: about:blank and about:srcdoc, the PDF viewer, and a ctdoc:// document that is known. */
export function frameNavigationAllowed(url: string, known: (id: string) => boolean): boolean {
  if (url.startsWith(PDF_VIEWER_PREFIX)) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.href === 'about:blank' || parsed.href === 'about:srcdoc') return true
  return parsed.protocol === `${DOC_SCHEME}:` && known(parsed.hostname)
}

export function handleDocProtocol(find: (id: string) => DocEntry | undefined, fs: DocFs = nodeDocFs): void {
  protocol.handle(DOC_SCHEME, async (req) => {
    const hit = await resolveDocRequest(req.url, find, fs)
    if (!hit) return new Response('not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(hit.path).toString())
    const headers = new Headers(res.headers)
    for (const [name, value] of Object.entries(docResponseHeaders(hit.doc, hit.path))) headers.set(name, value)
    return new Response(res.body, { status: res.status, headers })
  })
}
