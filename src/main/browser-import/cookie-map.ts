import type { CookiesSetDetails } from 'electron'

// A cookie read from a browser, in one shape for both Chromium and Firefox.
export interface ImportedCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expires: number | null
}

// A cookie as CDP Storage.getCookies returns it.
export interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  session?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  partitionKey?: unknown
}

// A row of Firefox's moz_cookies table.
export interface FirefoxRow {
  name: string
  value: string
  host: string
  path: string
  expiry: number
  isSecure: number
  isHttpOnly: number
  sameSite: number
  originAttributes: string
  isPartitionedAttributeSet?: number
}

// Lifetime given to a session cookie, which has no expiry of its own.
export const SESSION_COOKIE_DAYS = 30

// Firefox stores expiry in seconds, but some builds store milliseconds.
const MILLISECONDS_FROM = 100_000_000_000

export function fromChromium(c: CdpCookie, nowS: number): ImportedCookie | null {
  // A partitioned cookie belongs to one top-level site, so it does not carry over.
  if (c.partitionKey !== undefined && c.partitionKey !== null) return null
  // A row from a damaged or changed profile is skipped, never thrown.
  if (!isText(c.name) || !isText(c.value) || !isText(c.domain) || !isText(c.path)) return null
  if (c.domain.replace(/^\./, '') === '') return null
  const expires = c.session === true || !Number.isFinite(c.expires) || c.expires <= 0 ? null : c.expires
  if (expires !== null && expires <= nowS) return null
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: !c.domain.startsWith('.'),
    path: normalizePath(c.path),
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: chromiumSameSite(c.sameSite),
    expires,
  }
}

export function fromFirefox(r: FirefoxRow, nowS: number): ImportedCookie | null {
  // Container and partitioned cookies belong to one site or container, so they do not carry over.
  if (r.originAttributes !== '' || r.isPartitionedAttributeSet === 1) return null
  // A row from a damaged or changed profile is skipped, never thrown.
  if (!isText(r.name) || !isText(r.value) || !isText(r.host) || !isText(r.path)) return null
  if (r.host.replace(/^\./, '') === '') return null
  let expires: number | null = null
  if (Number.isFinite(r.expiry) && r.expiry > 0) {
    expires = r.expiry > MILLISECONDS_FROM ? r.expiry / 1000 : r.expiry
    if (expires <= nowS) return null
  }
  const secure = r.isSecure === 1
  return {
    name: r.name,
    value: r.value,
    domain: r.host,
    hostOnly: !r.host.startsWith('.'),
    path: normalizePath(r.path),
    secure,
    httpOnly: r.isHttpOnly === 1,
    sameSite: firefoxSameSite(r.sameSite, secure),
    expires,
  }
}

// The details for session.cookies.set. Electron takes the scheme, host and path from the URL.
export function toElectron(c: ImportedCookie, nowS: number): CookiesSetDetails {
  const hostPrefixed = c.name.startsWith('__Host-')
  // Chromium refuses SameSite=None without Secure, and __Secure- and __Host- cookies must be Secure.
  const secure = c.secure || c.name.startsWith('__Secure-') || hostPrefixed || c.sameSite === 'no_restriction'
  const host = c.domain.replace(/^\./, '')
  // CDP may already report an IPv6 host in brackets.
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const path = hostPrefixed ? '/' : normalizePath(c.path)
  const details: CookiesSetDetails = {
    url: `${secure ? 'https' : 'http'}://${urlHost}${path}`,
    name: c.name,
    value: c.value,
    path,
    secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expires ?? nowS + SESSION_COOKIE_DAYS * 86400,
  }
  // A __Host- cookie must not have a Domain attribute.
  if (!c.hostOnly && !hostPrefixed) details.domain = c.domain
  return details
}

// The number of sites the cookies belong to, counting example.com, .example.com and www.example.com once.
export function siteCount(cookies: ImportedCookie[]): number {
  const sites = new Set<string>()
  for (const c of cookies) sites.add(c.domain.replace(/^\./, '').replace(/^www\./, ''))
  return sites.size
}

function isText(v: unknown): v is string {
  return typeof v === 'string'
}

// A path that is empty or not absolute cannot go into a cookie URL, so it becomes /.
function normalizePath(path: string): string {
  return path.startsWith('/') ? path : '/'
}

function chromiumSameSite(s: CdpCookie['sameSite']): ImportedCookie['sameSite'] {
  if (s === 'Strict') return 'strict'
  if (s === 'Lax') return 'lax'
  if (s === 'None') return 'no_restriction'
  return 'unspecified'
}

// Firefox stores 0 both for an explicit SameSite=None and for no SameSite attribute at all.
// Only a Secure cookie can be SameSite=None, so 0 counts as no_restriction only when Secure.
function firefoxSameSite(s: number, secure: boolean): ImportedCookie['sameSite'] {
  if (s === 0) return secure ? 'no_restriction' : 'unspecified'
  if (s === 1) return 'lax'
  if (s === 2) return 'strict'
  return 'unspecified'
}
