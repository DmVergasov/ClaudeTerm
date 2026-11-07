import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 16

/** A new pairing code: 80 random bits as 16 Crockford characters, shown in four groups of four. */
export function newPairCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(10)
  let buffer = 0
  let count = 0
  let out = ''
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff
    count += 8
    while (count >= 5) {
      out += ALPHABET[(buffer >> (count - 5)) & 31]
      count -= 5
    }
  }
  return out.replace(/(.{4})(?!$)/g, '$1-')
}

/**
 * The code as people type it, normalized: upper case, no dashes or spaces, O read as 0, I and L as 1.
 * Null when the result is not exactly 16 characters of the alphabet.
 */
export function normalizePairCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (code.length !== CODE_LENGTH) return null
  for (const ch of code) if (!ALPHABET.includes(ch)) return null
  return code
}

/**
 * The proof that a side knows the code, bound to the role and both TLS fingerprints.
 * Throws when the code does not normalize: callers pass only codes they normalized or generated.
 */
export function pairProof(code: string, role: 'join' | 'accept', hostFingerprint: string, joinerFingerprint: string): string {
  const key = normalizePairCode(code)
  if (key === null) throw new Error('pairing code does not normalize')
  return createHmac('sha256', key).update(`${role}\n${hostFingerprint}\n${joinerFingerprint}`).digest('hex')
}

/** Compares two proofs in constant time; different lengths never match. */
export function proofMatches(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
