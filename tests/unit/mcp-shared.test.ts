import { describe, expect, it } from 'vitest'
import { marketplaceSource } from '../../src/shared/mcp'

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
