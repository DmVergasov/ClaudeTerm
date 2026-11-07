import { describe, expect, it } from 'vitest'
import { newPairCode, normalizePairCode, pairProof, proofMatches } from '../../src/main/sync/pair-code'

const CODE = 'K7QM-2XPD-9TRA-W4BN'
const CODE2 = '3HFT-9QZV-0K8M-DRWA'
const FA = 'a1'.repeat(32)
const FB = 'b2'.repeat(32)
const FX = 'c3'.repeat(32)

describe('pair code', () => {
  it('a new code is four groups of four Crockford characters', () => {
    expect(newPairCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
    expect(newPairCode(() => Buffer.alloc(10, 0))).toBe('0000-0000-0000-0000')
    expect(newPairCode(() => Buffer.alloc(10, 0xff))).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ')
  })

  it('packs all 80 bits of ten bytes, most significant bit first', () => {
    const bytes = Buffer.from('0123456789abcdef1032', 'hex')
    let asked = -1
    const code = newPairCode((n) => {
      asked = n
      return bytes
    })
    expect(asked).toBe(10)
    expect(code).toBe('04HM-ASW9-NF6Y-Y41J')
  })

  it('accepts the code as people type it', () => {
    for (const typed of ['k7qm-2xpd-9tra-w4bn', 'K7QM2XPD9TRAW4BN', ' K7QM 2XPD 9TRA W4BN ']) {
      expect(normalizePairCode(typed)).toBe('K7QM2XPD9TRAW4BN')
    }
    expect(normalizePairCode('O0IL-1111-1111-1111')).toBe('0011111111111111')
    expect(normalizePairCode('K7QM-2XPD-9TRA')).toBeNull()
    expect(normalizePairCode('K7QM-2XPD-9TRA-W4BU')).toBeNull() // U is not in the alphabet
  })

  it('the proof depends on the code, the role and both fingerprints', () => {
    const p = pairProof(CODE, 'join', FA, FB)
    expect(pairProof('k7qm2xpd9traw4bn', 'join', FA, FB)).toBe(p)
    expect(p).toMatch(/^[0-9a-f]{64}$/)
    for (const other of [
      pairProof(CODE2, 'join', FA, FB),
      pairProof(CODE, 'accept', FA, FB),
      pairProof(CODE, 'join', FB, FA),
      pairProof(CODE, 'join', FA, FX),
    ]) {
      expect(other).not.toBe(p)
    }
  })

  it('pairProof refuses a code that does not normalize', () => {
    expect(() => pairProof('K7QM-2XPD-9TRA', 'join', FA, FB)).toThrow()
  })

  it('proofMatches compares in constant time and refuses other lengths', () => {
    const p = pairProof(CODE, 'accept', FA, FB)
    expect(proofMatches(p, p)).toBe(true)
    expect(proofMatches(p, pairProof(CODE2, 'accept', FA, FB))).toBe(false)
    expect(proofMatches('ab', 'abc')).toBe(false)
  })
})
