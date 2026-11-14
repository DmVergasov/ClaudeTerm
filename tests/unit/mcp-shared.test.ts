import { describe, expect, it } from 'vitest'
import { hasOauthApp, isClientSecret, marketplaceSource } from '../../src/shared/mcp'

describe('hasOauthApp', () => {
  it('is true for a config whose oauth.clientId is a non-empty string', () => {
    expect(hasOauthApp({ oauth: { clientId: 'x' } })).toBe(true)
  })

  it('is false for a config without an OAuth app of its own, and never throws', () => {
    for (const config of [{}, { oauth: {} }, { oauth: { clientId: '' } }, { oauth: { clientId: 3 } }, null, 'x', undefined]) expect(hasOauthApp(config)).toBe(false)
  })
})

describe('marketplaceSource', () => {
  it('turns a GitHub link into owner/repo and keeps any other source', () => {
    expect(marketplaceSource('https://github.com/acme/tools')).toBe('acme/tools')
    expect(marketplaceSource('https://github.com/acme/tools.git')).toBe('acme/tools')
    expect(marketplaceSource('github.com/acme/tools/tree/main')).toBe('acme/tools')
    expect(marketplaceSource('acme/tools')).toBe('acme/tools')
    expect(marketplaceSource('  ./plugins  ')).toBe('./plugins')
    expect(marketplaceSource('C:\\market')).toBe('C:\\market')
    expect(marketplaceSource('https://example.com/m.json')).toBe('https://example.com/m.json')
  })

  it('refuses an empty source, a multi-line one, one with a control character, and one that starts with a dash', () => {
    expect(marketplaceSource('')).toBeNull()
    expect(marketplaceSource('   ')).toBeNull()
    expect(marketplaceSource('a\nb')).toBeNull()
    expect(marketplaceSource('a\u0007b')).toBeNull()
    expect(marketplaceSource('-x')).toBeNull()
  })
})

describe('isClientSecret', () => {
  it('takes 1 to 4096 characters on one line and refuses the rest', () => {
    for (const v of ['s', 'cs-123 with a space', 'x'.repeat(4096)]) expect(isClientSecret(v)).toBe(true)
    for (const v of ['', 'x'.repeat(4097), 'a\nb', 'a\u0000b', 'a\u007f', 1, null, undefined]) expect(isClientSecret(v)).toBe(false)
  })
})
