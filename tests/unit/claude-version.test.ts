import { describe, expect, it } from 'vitest'
import { parseClaudeVersion, versionAtLeast } from '../../src/main/claude-version'

describe('parseClaudeVersion', () => {
  it('reads the version out of "2.1.322 (Claude Code)"', () => {
    expect(parseClaudeVersion('2.1.322 (Claude Code)')).toBe('2.1.322')
  })

  it('returns null when the output names no version', () => {
    expect(parseClaudeVersion('fake-claude')).toBeNull()
  })
})

describe('versionAtLeast', () => {
  it('compares part by part, as numbers', () => {
    expect(versionAtLeast('2.1.287', '2.1.287')).toBe(true)
    expect(versionAtLeast('2.1.300', '2.1.287')).toBe(true)
    expect(versionAtLeast('2.1.99', '2.1.287')).toBe(false)
    expect(versionAtLeast('2.2.0', '2.1.287')).toBe(true)
    expect(versionAtLeast('2.1.1000', '2.1.287')).toBe(true)
  })

  it('is false for a version that is not x.y.z', () => {
    expect(versionAtLeast('abc', '2.1.287')).toBe(false)
    expect(versionAtLeast('2.1', '2.1.287')).toBe(false)
    expect(versionAtLeast('', '2.1.287')).toBe(false)
    expect(versionAtLeast('2.1.x', '2.1.287')).toBe(false)
  })

  it('compares 2.10.0 as later than 2.9.0, not as earlier', () => {
    expect(versionAtLeast('2.10.0', '2.9.0')).toBe(true)
  })
})
