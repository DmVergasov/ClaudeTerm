/** Which pages Claude may use freely (local pages) and which need the person's permission (other sites). */

const WEB_PROTOCOLS: readonly string[] = ['http:', 'https:']
const LOCAL_HOST_RE = /^(localhost|.*\.localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/
const ADDRESS_SCHEME_RE = /^([a-z][a-z0-9+-]*):(?!\d)/i
const NO_SCHEME_LOCAL_RE = /^(localhost|127\.|\[::1\])/i

/** the URL parsed, or null when the text is no URL */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * a file on this computer: no host (the WHATWG parser turns file://localhost/ into no host too), and no path that starts as a
 * share. A file on another host is a network share (UNC) on Windows: the system would connect to that host, so it is never opened.
 */
function isLocalFile(parsed: URL): boolean {
  // an encoded backslash or slash in the path is the share's separator spelled another way: the file is not local
  return (parsed.hostname === '' || parsed.hostname === 'localhost') && !parsed.pathname.startsWith('//') && !/%(5c|2f)/i.test(parsed.pathname)
}

/** a web page: http, https or a local file, or the exact about:blank */
export function isWebUrl(url: string): boolean {
  if (url === 'about:blank') return true
  const parsed = parseUrl(url)
  if (parsed === null) return false
  if (parsed.protocol === 'file:') return isLocalFile(parsed)
  return WEB_PROTOCOLS.includes(parsed.protocol)
}

/** a page on this machine, which Claude may use freely: a local file, about:blank, or an http(s) page on localhost, *.localhost, 127.0.0.0/8 or [::1] */
export function isLocalUrl(url: string): boolean {
  if (url === 'about:blank') return true
  const parsed = parseUrl(url)
  if (parsed === null) return false
  if (parsed.protocol === 'file:') return isLocalFile(parsed)
  return WEB_PROTOCOLS.includes(parsed.protocol) && LOCAL_HOST_RE.test(parsed.hostname)
}

/** a file: URL, whatever its host */
export function isFileUrl(url: string): boolean {
  return parseUrl(url)?.protocol === 'file:'
}

/** the URL as the parser reads it (leading spaces and tabs or newlines anywhere are dropped), or null when it is no URL: the one string the gate checks and the page loads */
export function canonicalUrl(url: string): string | null {
  return parseUrl(url)?.href ?? null
}

/** the site of an http(s) URL: its lower-cased host with one leading www. removed (if a dot stays), without the port; null for any other URL */
export function siteOf(url: string): string | null {
  const parsed = parseUrl(url)
  if (parsed === null || !WEB_PROTOCOLS.includes(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase()
  if (host.startsWith('www.') && host.slice(4).includes('.')) return host.slice(4)
  return host
}

/** whether an allowed site covers a site: the same site, or one of its subdomains */
export function siteCovers(allowed: string, site: string): boolean {
  return site === allowed || site.endsWith('.' + allowed)
}

/** the URL the person meant by what they typed in the address field, or null when it is no address */
export function normalizeAddress(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const scheme = ADDRESS_SCHEME_RE.exec(trimmed)?.[1]?.toLowerCase()
  let candidate: string
  if (scheme !== undefined) {
    if (!['http', 'https', 'file'].includes(scheme)) return null
    candidate = trimmed
  } else if (NO_SCHEME_LOCAL_RE.test(trimmed)) {
    candidate = `http://${trimmed}`
  } else if (!/\s/.test(trimmed) && trimmed.includes('.')) {
    candidate = `https://${trimmed}`
  } else {
    return null
  }
  const parsed = parseUrl(candidate)
  if (parsed === null || (parsed.protocol === 'file:' && !isLocalFile(parsed))) return null
  return parsed.href
}
