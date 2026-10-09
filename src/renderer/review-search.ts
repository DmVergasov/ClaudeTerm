import type { ReviewFile } from '../shared/review'

/** where a match is: in the file's path, or in the text of a line of a hunk */
export type MatchWhere = 'path' | { hunk: number; line: number }

export interface SearchMatch {
  fileIndex: number
  where: MatchWhere
  /** the range in the path or in the line's text */
  start: number
  end: number
}

/** past this many matches the search stops: only the first ones are highlighted */
export const MATCH_CAP = 5000

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Every place the query (plain text, any case) occurs in the view, in display order: per file its path, then its lines.
 * Folded files count; a file whose diff is not shown (binary, too large...) matches by path only. `capped` is true when
 * there were more than MATCH_CAP matches.
 */
export function findMatches(files: readonly ReviewFile[], query: string): { matches: SearchMatch[]; capped: boolean } {
  const matches: SearchMatch[] = []
  if (query === '') return { matches, capped: false }
  // matched on the original text: the offsets must stay valid for characters whose lowercase is longer (U+0130)
  const re = new RegExp(escapeRegExp(query), 'giu')
  let capped = false
  const scan = (text: string, add: (start: number, end: number) => SearchMatch): void => {
    for (const m of text.matchAll(re)) {
      if (matches.length >= MATCH_CAP) {
        capped = true
        return
      }
      matches.push(add(m.index, m.index + m[0].length))
    }
  }
  for (const [fileIndex, f] of files.entries()) {
    scan(f.relPath, (start, end) => ({ fileIndex, where: 'path', start, end }))
    if (f.note) continue
    for (const [hunk, h] of f.hunks.entries()) {
      for (const [line, l] of h.lines.entries()) scan(l.text, (start, end) => ({ fileIndex, where: { hunk, line }, start, end }))
      if (capped) break
    }
    if (capped) break
  }
  return { matches, capped }
}
