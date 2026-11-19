import { describe, expect, it } from 'vitest'
import {
  SESSION_COOKIE_DAYS,
  fromChromium,
  fromFirefox,
  siteCount,
  toElectron,
  type CdpCookie,
  type FirefoxRow,
  type ImportedCookie,
} from '../../src/main/browser-import/cookie-map'

const nowS = 1_800_000_000

function cdp(over: Partial<CdpCookie>): CdpCookie {
  return {
    name: 'sid',
    value: 'test-value-1',
    domain: 'example.com',
    path: '/',
    expires: nowS + 3600,
    httpOnly: false,
    secure: false,
    ...over,
  }
}

function firefox(over: Partial<FirefoxRow>): FirefoxRow {
  return {
    name: 'sid',
    value: 'test-value-1',
    host: 'example.com',
    path: '/',
    expiry: nowS + 3600,
    isSecure: 0,
    isHttpOnly: 0,
    sameSite: 0,
    originAttributes: '',
    ...over,
  }
}

function imported(over: Partial<ImportedCookie>): ImportedCookie {
  return {
    name: 'sid',
    value: 'test-value-1',
    domain: 'example.com',
    hostOnly: true,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: 'unspecified',
    expires: null,
    ...over,
  }
}

describe('fromChromium', () => {
  it('marks a cookie without a leading dot on its domain as host-only', () => {
    expect(fromChromium(cdp({ domain: 'example.com' }), nowS)?.hostOnly).toBe(true)
    expect(fromChromium(cdp({ domain: '.example.com' }), nowS)?.hostOnly).toBe(false)
  })

  it('keeps the expiry in seconds', () => {
    expect(fromChromium(cdp({ expires: nowS + 60 }), nowS)?.expires).toBe(nowS + 60)
  })

  it('has no expiry for a session cookie, however its expires field is filled', () => {
    expect(fromChromium(cdp({ expires: -1 }), nowS)?.expires).toBeNull()
    expect(fromChromium(cdp({ expires: 0 }), nowS)?.expires).toBeNull()
    expect(fromChromium(cdp({ expires: nowS + 60, session: true }), nowS)?.expires).toBeNull()
  })

  it('skips an already expired cookie', () => {
    expect(fromChromium(cdp({ expires: nowS - 1 }), nowS)).toBeNull()
  })

  it('skips a cookie that expires exactly now', () => {
    expect(fromChromium(cdp({ expires: nowS }), nowS)).toBeNull()
  })

  it('has no expiry when expires is not a finite number', () => {
    expect(fromChromium(cdp({ expires: NaN }), nowS)?.expires).toBeNull()
    expect(fromChromium(cdp({ expires: Infinity }), nowS)?.expires).toBeNull()
  })

  it('returns null instead of throwing for a malformed cookie', () => {
    expect(fromChromium(cdp({ name: 1 as unknown as string }), nowS)).toBeNull()
    expect(fromChromium(cdp({ value: null as unknown as string }), nowS)).toBeNull()
    expect(fromChromium(cdp({ domain: undefined as unknown as string }), nowS)).toBeNull()
    expect(fromChromium(cdp({ domain: '.' }), nowS)).toBeNull()
    expect(fromChromium(cdp({ path: 7 as unknown as string }), nowS)).toBeNull()
  })

  it('maps an empty or relative path to /', () => {
    expect(fromChromium(cdp({ path: '' }), nowS)?.path).toBe('/')
    expect(fromChromium(cdp({ path: 'x' }), nowS)?.path).toBe('/')
  })

  it('skips a partitioned cookie', () => {
    const partitionKey = { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false }
    expect(fromChromium(cdp({ partitionKey }), nowS)).toBeNull()
  })

  it('maps the CDP SameSite values', () => {
    expect(fromChromium(cdp({ sameSite: 'Strict' }), nowS)?.sameSite).toBe('strict')
    expect(fromChromium(cdp({ sameSite: 'Lax' }), nowS)?.sameSite).toBe('lax')
    expect(fromChromium(cdp({ sameSite: 'None' }), nowS)?.sameSite).toBe('no_restriction')
    expect(fromChromium(cdp({ sameSite: undefined }), nowS)?.sameSite).toBe('unspecified')
  })
})

describe('fromFirefox', () => {
  it('marks a host without a leading dot as host-only', () => {
    expect(fromFirefox(firefox({ host: 'example.com' }), nowS)?.hostOnly).toBe(true)
    expect(fromFirefox(firefox({ host: '.example.com' }), nowS)?.hostOnly).toBe(false)
  })

  it('reads an expiry above 100000000000 as milliseconds', () => {
    expect(fromFirefox(firefox({ expiry: 1_900_000_000_000 }), nowS)?.expires).toBe(1_900_000_000)
  })

  it('reads a smaller expiry as seconds', () => {
    expect(fromFirefox(firefox({ expiry: 1_900_000_000 }), nowS)?.expires).toBe(1_900_000_000)
  })

  it('has no expiry for a session cookie with expiry 0', () => {
    expect(fromFirefox(firefox({ expiry: 0 }), nowS)?.expires).toBeNull()
  })

  it('skips an expired cookie', () => {
    expect(fromFirefox(firefox({ expiry: nowS - 1 }), nowS)).toBeNull()
  })

  it('skips an expired cookie whose expiry is in milliseconds', () => {
    expect(fromFirefox(firefox({ expiry: 1_000_000_000_000 }), nowS)).toBeNull()
  })

  it('reads an expiry of exactly 100000000000 as seconds', () => {
    expect(fromFirefox(firefox({ expiry: 100_000_000_000 }), nowS)?.expires).toBe(100_000_000_000)
  })

  it('skips a cookie that expires exactly now', () => {
    expect(fromFirefox(firefox({ expiry: nowS }), nowS)).toBeNull()
  })

  it('has no expiry for a negative expiry', () => {
    expect(fromFirefox(firefox({ expiry: -1 }), nowS)?.expires).toBeNull()
  })

  it('has no expiry when expiry is not a finite number', () => {
    expect(fromFirefox(firefox({ expiry: NaN }), nowS)?.expires).toBeNull()
    expect(fromFirefox(firefox({ expiry: 'soon' as unknown as number }), nowS)?.expires).toBeNull()
  })

  it('returns null instead of throwing for a malformed row', () => {
    expect(fromFirefox(firefox({ host: null as unknown as string }), nowS)).toBeNull()
    expect(fromFirefox(firefox({ host: '.' }), nowS)).toBeNull()
    expect(fromFirefox(firefox({ name: undefined as unknown as string }), nowS)).toBeNull()
    expect(fromFirefox(firefox({ path: null as unknown as string }), nowS)).toBeNull()
  })

  it('maps an empty or relative path to /', () => {
    expect(fromFirefox(firefox({ path: '' }), nowS)?.path).toBe('/')
    expect(fromFirefox(firefox({ path: 'x' }), nowS)?.path).toBe('/')
  })

  it('skips a cookie from a container', () => {
    expect(fromFirefox(firefox({ originAttributes: '^userContextId=1' }), nowS)).toBeNull()
  })

  it('skips a partitioned cookie', () => {
    expect(fromFirefox(firefox({ isPartitionedAttributeSet: 1 }), nowS)).toBeNull()
  })

  it('maps SameSite 0 to no_restriction only when the cookie is Secure', () => {
    expect(fromFirefox(firefox({ sameSite: 0, isSecure: 1 }), nowS)?.sameSite).toBe('no_restriction')
  })

  it('maps SameSite 0 on a cookie that is not Secure to unspecified', () => {
    expect(fromFirefox(firefox({ sameSite: 0, isSecure: 0 }), nowS)?.sameSite).toBe('unspecified')
  })

  it('maps the moz_cookies sameSite codes', () => {
    expect(fromFirefox(firefox({ sameSite: 1 }), nowS)?.sameSite).toBe('lax')
    expect(fromFirefox(firefox({ sameSite: 2 }), nowS)?.sameSite).toBe('strict')
    expect(fromFirefox(firefox({ sameSite: 3 }), nowS)?.sameSite).toBe('unspecified')
  })
})

describe('toElectron', () => {
  it('builds an https URL for a secure cookie and an http URL otherwise, with the domain set', () => {
    expect(toElectron(imported({ domain: '.example.com', path: '/a', secure: true, hostOnly: false }), nowS)).toEqual({
      url: 'https://example.com/a',
      name: 'sid',
      value: 'test-value-1',
      domain: '.example.com',
      path: '/a',
      secure: true,
      httpOnly: false,
      sameSite: 'unspecified',
      expirationDate: nowS + SESSION_COOKIE_DAYS * 86400,
    })
  })

  it('leaves the domain out of a host-only cookie', () => {
    const details = toElectron(imported({ hostOnly: true, domain: 'example.com' }), nowS)
    expect(details).not.toHaveProperty('domain')
  })

  it('defaults an empty path to /', () => {
    expect(toElectron(imported({ path: '' }), nowS).url).toBe('http://example.com/')
    expect(toElectron(imported({ path: '' }), nowS).path).toBe('/')
  })

  it('brackets an IPv6 host in the URL', () => {
    expect(toElectron(imported({ domain: '::1' }), nowS).url).toBe('http://[::1]/')
  })

  it('does not bracket an IPv6 host that is already bracketed', () => {
    expect(toElectron(imported({ domain: '[::1]' }), nowS).url).toBe('http://[::1]/')
  })

  it('maps a relative path to / in the URL and the path', () => {
    expect(toElectron(imported({ path: 'x' }), nowS)).toMatchObject({ url: 'http://example.com/', path: '/' })
  })

  it('keeps the domain and an https URL for a Firefox __Secure- cookie', () => {
    const c = fromFirefox(firefox({ name: '__Secure-sid', host: '.example.com' }), nowS)
    expect(c && toElectron(c, nowS)).toEqual({
      url: 'https://example.com/',
      name: '__Secure-sid',
      value: 'test-value-1',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'unspecified',
      expirationDate: nowS + 3600,
    })
  })

  it('keeps the expiry when there is one', () => {
    expect(toElectron(imported({ expires: nowS + 60 }), nowS).expirationDate).toBe(nowS + 60)
  })

  it('forces a __Host- cookie to have no domain, path / and secure', () => {
    const details = toElectron(
      imported({ name: '__Host-sid', domain: 'example.com', hostOnly: true, path: '/x', secure: false }),
      nowS,
    )
    expect(details).toEqual({
      url: 'https://example.com/',
      name: '__Host-sid',
      value: 'test-value-1',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'unspecified',
      expirationDate: nowS + SESSION_COOKIE_DAYS * 86400,
    })
    expect(details).not.toHaveProperty('domain')
  })

  it('forces a __Secure- cookie to secure and an https URL but keeps its domain', () => {
    const details = toElectron(
      imported({ name: '__Secure-sid', domain: '.example.com', hostOnly: false, secure: false }),
      nowS,
    )
    expect(details.url).toBe('https://example.com/')
    expect(details.secure).toBe(true)
    expect(details.domain).toBe('.example.com')
  })

  it('makes a SameSite=None cookie without Secure secure, on an https URL', () => {
    expect(
      toElectron(imported({ sameSite: 'no_restriction', secure: false, hostOnly: false, domain: '.example.com' }), nowS),
    ).toEqual({
      url: 'https://example.com/',
      name: 'sid',
      value: 'test-value-1',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      expirationDate: nowS + SESSION_COOKIE_DAYS * 86400,
    })
  })

  it('sets httpOnly and secure explicitly even when false', () => {
    const details = toElectron(imported({ secure: false, httpOnly: false }), nowS)
    expect(details.secure).toBe(false)
    expect(details.httpOnly).toBe(false)
  })
})

describe('maps awkward cookies without failing', () => {
  it('maps each awkward cookie to its exact Electron details, and drops the expired one', () => {
    const hostPrefixed = fromChromium(
      cdp({ name: '__Host-sid', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }),
      nowS,
    )
    const dotted = fromChromium(
      cdp({ name: 'pref', value: 'значение', domain: '.example.com', path: '/a', expires: nowS + 3600, sameSite: 'Lax' }),
      nowS,
    )
    const noSecure = fromChromium(
      cdp({ name: 't', value: 'test-value-2', domain: '.example.com', path: '', expires: -1, session: true, sameSite: 'None' }),
      nowS,
    )
    const expired = fromChromium(cdp({ name: 'old', expires: nowS - 10 }), nowS)
    const loopback = fromChromium(cdp({ name: 'sid', value: 'test-value-3', domain: '127.0.0.1', expires: nowS + 60 }), nowS)

    expect(expired).toBeNull()
    expect(hostPrefixed && toElectron(hostPrefixed, nowS)).toEqual({
      url: 'https://example.com/',
      name: '__Host-sid',
      value: 'test-value-1',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: nowS + 3600,
    })
    expect(dotted && toElectron(dotted, nowS)).toEqual({
      url: 'http://example.com/a',
      name: 'pref',
      value: 'значение',
      domain: '.example.com',
      path: '/a',
      secure: false,
      httpOnly: false,
      sameSite: 'lax',
      expirationDate: nowS + 3600,
    })
    expect(noSecure && toElectron(noSecure, nowS)).toEqual({
      url: 'https://example.com/',
      name: 't',
      value: 'test-value-2',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      expirationDate: nowS + SESSION_COOKIE_DAYS * 86400,
    })
    expect(loopback && toElectron(loopback, nowS)).toEqual({
      url: 'http://127.0.0.1/',
      name: 'sid',
      value: 'test-value-3',
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      expirationDate: nowS + 60,
    })
    expect(loopback && toElectron(loopback, nowS)).not.toHaveProperty('domain')
  })
})

describe('siteCount', () => {
  it('counts a domain once, without its leading dot or www.', () => {
    expect(siteCount([imported({ domain: 'a.com' }), imported({ domain: '.a.com', hostOnly: false }), imported({ domain: 'www.a.com' })])).toBe(1)
  })

  it('counts distinct sites', () => {
    expect(siteCount([imported({ domain: 'a.com' }), imported({ domain: '.b.com', hostOnly: false })])).toBe(2)
  })

  it('is zero for no cookies', () => {
    expect(siteCount([])).toBe(0)
  })
})
