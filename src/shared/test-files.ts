// Which files count as tests: the globs of review.testPatterns, matched against a path inside the project.

export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  '**/test/**', '**/tests/**', '**/Test/**', '**/Tests/**', '**/__tests__/**', '**/spec/**', '**/e2e/**',
  '*.test.*', '*.spec.*', '*_test.*', 'test_*.py', '*Test.*', '*Tests.*'
]

/** at most this many patterns of at most this many characters */
export const MAX_TEST_PATTERNS = 200
export const MAX_TEST_PATTERN_LENGTH = 200

/** one name against a glob: `*` is any run of characters, `?` one character. Linear in practice: the last star is the only place to go back to */
function nameMatches(glob: string, name: string): boolean {
  let g = 0
  let n = 0
  let star = -1
  let mark = 0
  while (n < name.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g++
      mark = n
    } else if (g < glob.length && (glob[g] === '?' || glob[g] === name[n])) {
      g++
      n++
    } else if (star >= 0) {
      g = star + 1
      n = ++mark
    } else return false
  }
  while (glob[g] === '*') g++
  return g === glob.length
}

type Part = { any: true } | { name: string }

/** a pattern as a test of path segments; null for one that cannot match anything */
function compile(pattern: string): ((segments: string[]) => boolean) | null {
  let p = pattern.trim().replaceAll('\\', '/')
  while (p.startsWith('./')) p = p.slice(2)
  // a trailing / names a folder and what is under it; with no other / it is a folder anywhere, like `**/x/**`
  if (p.endsWith('/') && p.replace(/\/+$/, '') !== '') {
    const folder = p.replace(/\/+$/, '')
    p = folder.includes('/') ? `${folder}/**` : `**/${folder}/**`
  }
  if (p === '') return null
  if (!p.includes('/')) return (segments) => nameMatches(p, segments[segments.length - 1] ?? '')
  const parts: Part[] = []
  for (const s of p.split('/')) {
    if (s === '') continue
    // a run of ** is one **
    if (s === '**') {
      if (!parts.length || !('any' in parts[parts.length - 1]!)) parts.push({ any: true })
    } else parts.push({ name: s })
  }
  if (parts.length === 0) return null
  const lastAny = 'any' in parts[parts.length - 1]!
  return (segments) => {
    // every (part, segment) pair is looked at once
    const failed = new Set<number>()
    const walk = (pi: number, si: number): boolean => {
      if (pi === parts.length) return si === segments.length
      const key = pi * (segments.length + 1) + si
      if (failed.has(key)) return false
      const part = parts[pi]!
      let ok: boolean
      if ('name' in part) ok = si < segments.length && nameMatches(part.name, segments[si]!) && walk(pi + 1, si + 1)
      // `**` is any number of folders; at the end it needs at least one: `x/**` is what is under x
      else if (pi === parts.length - 1 && lastAny) ok = si < segments.length
      else {
        ok = false
        for (let k = si; k <= segments.length && !ok; k++) ok = walk(pi + 1, k)
      }
      if (!ok) failed.add(key)
      return ok
    }
    return walk(0, 0)
  }
}

/** The test for a list of patterns: the path is relative to the project, with `/` or `\`. Case-sensitive. */
export function testMatcher(patterns: readonly string[]): (relPath: string) => boolean {
  const tests = patterns.map(compile).filter((t) => t !== null)
  return (relPath) => {
    const segments = relPath.replaceAll('\\', '/').split('/').filter((s) => s !== '')
    return segments.length > 0 && tests.some((t) => t(segments))
  }
}
