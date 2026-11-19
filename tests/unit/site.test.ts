import { describe, expect, it } from 'vitest'
import { canonicalUrl, isFileUrl, isLocalUrl, isWebUrl, normalizeAddress, siteCovers, siteOf } from '../../src/shared/site'

describe('isLocalUrl', () => {
  it('is true for localhost, 127.0.0.0/8, IPv6 loopback, local files and about:blank', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true)
    expect(isLocalUrl('https://app.localhost/x')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isLocalUrl('http://127.9.9.9/')).toBe(true)
    expect(isLocalUrl('http://[::1]:3000/')).toBe(true)
    expect(isLocalUrl('file:///C:/x.html')).toBe(true)
    expect(isLocalUrl('about:blank')).toBe(true)
  })

  it('is false for look-alike hosts, other addresses and non-web schemes', () => {
    expect(isLocalUrl('http://localhost.evil.com/')).toBe(false)
    expect(isLocalUrl('http://128.0.0.1/')).toBe(false)
    expect(isLocalUrl('http://192.168.1.1/')).toBe(false)
    expect(isLocalUrl('https://example.com/')).toBe(false)
    expect(isLocalUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('siteOf', () => {
  it('is the lower-cased host with one leading www. removed', () => {
    expect(siteOf('https://www.GitHub.com/a')).toBe('github.com')
    expect(siteOf('https://gist.github.com')).toBe('gist.github.com')
  })

  it('keeps www. when nothing with a dot is left', () => {
    expect(siteOf('https://www.co')).toBe('www.co')
  })

  it('drops the port and keeps IPv6 brackets', () => {
    expect(siteOf('http://example.co.uk:81/')).toBe('example.co.uk')
    expect(siteOf('http://[::1]:3/')).toBe('[::1]')
  })

  it('is null for a file URL and for text that is no URL', () => {
    expect(siteOf('file:///x')).toBeNull()
    expect(siteOf('not a url')).toBeNull()
  })
})

describe('siteCovers', () => {
  it('covers the site itself and its subdomains, but not look-alikes or a public suffix', () => {
    expect(siteCovers('github.com', 'api.github.com')).toBe(true)
    expect(siteCovers('github.com', 'evilgithub.com')).toBe(false)
    expect(siteCovers('example.co.uk', 'co.uk')).toBe(false)
  })
})

describe('normalizeAddress', () => {
  it('is null for blank text', () => {
    expect(normalizeAddress('  ')).toBeNull()
  })

  it('prefixes http:// for a local address typed without a scheme', () => {
    expect(normalizeAddress('localhost:5173/x')).toBe('http://localhost:5173/x')
    expect(normalizeAddress('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
  })

  it('prefixes https:// for a dotted address typed without a scheme', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
  })

  it('keeps an explicit http(s) or file URL as its normalized href', () => {
    expect(normalizeAddress('https://a.b/c?d')).toBe('https://a.b/c?d')
    expect(normalizeAddress('file:///C:/a.html')).toBe('file:///C:/a.html')
  })

  it('is null for a search phrase, a script URL and an internal browser page', () => {
    expect(normalizeAddress('how to x')).toBeNull()
    expect(normalizeAddress('javascript:alert(1)')).toBeNull()
    expect(normalizeAddress('chrome://settings')).toBeNull()
  })
})

describe('isWebUrl', () => {
  it('is false for a data URL and true for about:blank', () => {
    expect(isWebUrl('data:text/html,x')).toBe(false)
    expect(isWebUrl('about:blank')).toBe(true)
  })
})

// a file on another host is a network share (UNC) on Windows: the system would connect to that host, so no such file is opened
describe('file URLs with a host', () => {
  it('a file on another host is not a web page and not local', () => {
    expect(isWebUrl('file://evil.example/share/x.html')).toBe(false)
    expect(isLocalUrl('file://evil.example/share/x.html')).toBe(false)
    expect(isWebUrl('file://evil.example./share/x.html')).toBe(false)
    expect(isLocalUrl('file://evil.example./share/x.html')).toBe(false)
    expect(isWebUrl('file://EVIL.example/share/x.html')).toBe(false)
  })

  it('a file with no host, or with localhost in any case, is local', () => {
    expect(isWebUrl('file:///C:/x.html')).toBe(true)
    expect(isLocalUrl('file:///C:/x.html')).toBe(true)
    expect(isWebUrl('file://localhost/C:/x.html')).toBe(true)
    expect(isLocalUrl('file://localhost/C:/x.html')).toBe(true)
    expect(isLocalUrl('file://LOCALHOST/C:/x.html')).toBe(true)
  })

  it('a file with a trailing dot after localhost is not local, and a file path that starts as a share is not local', () => {
    expect(isLocalUrl('file://localhost./C:/x.html')).toBe(false)
    expect(isLocalUrl('file:////evil.example/share/x.html')).toBe(false)
  })

  it('a file with an encoded backslash or slash in its path is not local', () => {
    expect(isLocalUrl('file:///%5C%5Chost/share/x.html')).toBe(false)
    expect(isWebUrl('file:///%5c%5Chost/share/x.html')).toBe(false)
    expect(isLocalUrl('file:///C:/a%2Fb.html')).toBe(false)
    expect(isLocalUrl('file:///C:/a%5Cb.html')).toBe(false)
  })

  it('a file URL padded with a space, a tab or a newline is a file URL, local or not by its host', () => {
    expect(isFileUrl(' file:///C:/x.html')).toBe(true)
    expect(isFileUrl('\tfile:///C:/x.html')).toBe(true)
    expect(isFileUrl('fi\nle:///C:/x.html')).toBe(true)
    expect(isFileUrl('https://example.com/file:x')).toBe(false)
    expect(isLocalUrl(' file://evil.example/share/x.html')).toBe(false)
    expect(isLocalUrl(' file:///C:/x.html')).toBe(true)
  })

  it('canonicalUrl gives the href the parser gives, or null for text that is no URL', () => {
    expect(canonicalUrl(' file:///C:/x.html')).toBe('file:///C:/x.html')
    expect(canonicalUrl('fi\nle:///C:/x.html')).toBe('file:///C:/x.html')
    expect(canonicalUrl('https://Example.com')).toBe('https://example.com/')
    expect(canonicalUrl('not a url')).toBeNull()
  })

  it('an address typed in the panel is no file on another host', () => {
    expect(normalizeAddress('file://evil.example/share/x.html')).toBeNull()
    expect(normalizeAddress('file://localhost/C:/a.html')).toBe('file:///C:/a.html')
  })
})
