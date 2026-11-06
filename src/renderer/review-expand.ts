import type { ReviewHunk, ReviewLine } from '../shared/review'

/** how many hidden lines a click on ↑ or ↓ shows; a gap between two hunks this short or shorter shows whole, with ↕ */
export const EXPAND_STEP = 20

/** lines of the new side a diff leaves out: above the first hunk, between two hunks, or below the last */
export interface Gap {
  /** the hunk the gap is above; the number of hunks for the gap below the last one */
  before: number
  /** its first and last line on the new side */
  from: number
  to: number
  /** a line's number on the old side minus its number on the new: the hidden lines are the same on both */
  offset: number
}

/** ↑ shows the lines right above a hunk, ↓ those right under the hunk before, ↕ the whole gap */
export type ExpandWay = 'up' | 'down' | 'all'

const both = (l: ReviewLine | undefined): l is ReviewLine & { oldNo: number; newNo: number } => l?.kind === 'context' && l.oldNo !== null && l.newNo !== null

/**
 * The gaps of a file's hunks; `lineCount` is the new side's. A diff's hunk starts and ends with context lines unless it
 * touches the file's first or last line, so a gap is told by them: a hunk that starts or ends with a change has none there.
 */
export function gapsOf(hunks: readonly ReviewHunk[], lineCount: number): Gap[] {
  const gaps: Gap[] = []
  for (let i = 0; i <= hunks.length; i++) {
    const above = i > 0 ? hunks[i - 1]!.lines.at(-1) : undefined
    const below = i < hunks.length ? hunks[i]!.lines[0] : undefined
    if (i > 0 && !both(above)) continue
    if (i < hunks.length && !both(below)) continue
    const from = above && both(above) ? above.newNo + 1 : 1
    const to = below && both(below) ? below.newNo - 1 : lineCount
    const offset = below && both(below) ? below.oldNo - below.newNo : above && both(above) ? above.oldNo - above.newNo : 0
    if (from <= to && (i > 0 || i < hunks.length)) gaps.push({ before: i, from, to, offset })
  }
  return gaps
}

/** the buttons a gap gets: ↑ above the first hunk, ↓ below the last, ↓ and ↑ between two, or ↕ for a short gap between two */
export function expandWays(g: Gap, hunkCount: number): ExpandWay[] {
  if (g.before === 0) return ['up']
  if (g.before === hunkCount) return ['down']
  return g.to - g.from + 1 <= EXPAND_STEP ? ['all'] : ['down', 'up']
}

/** the new side's lines a click shows, first and last */
export function linesToShow(g: Gap, way: ExpandWay): [number, number] {
  if (way === 'up') return [Math.max(g.from, g.to - EXPAND_STEP + 1), g.to]
  if (way === 'down') return [g.from, Math.min(g.to, g.from + EXPAND_STEP - 1)]
  return [g.from, g.to]
}

/** "@@ -7,27 +7,27 @@" for these lines */
function headerOf(lines: readonly ReviewLine[]): string {
  const olds = lines.flatMap((l) => (l.oldNo === null ? [] : [l.oldNo]))
  const news = lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))
  return `@@ -${olds[0] ?? 0},${olds.length} +${news[0] ?? 0},${news.length} @@`
}

/**
 * The hunks with the hidden lines that show (`shown`: the new side's lines by their number) put in as context lines.
 * Lines next to a hunk become part of it, a gap that shows whole joins its two hunks, and lines that touch no hunk
 * make a hunk of their own. A hunk nothing was added to is returned as it is.
 */
export function expandHunks(hunks: readonly ReviewHunk[], lineCount: number, shown: ReadonlyMap<number, string>): ReviewHunk[] {
  if (shown.size === 0) return [...hunks]
  const gaps = new Map(gapsOf(hunks, lineCount).map((g) => [g.before, g]))
  const numbers = [...shown.keys()].sort((a, b) => a - b)
  const out: ReviewHunk[] = []
  let run: ReviewLine[] = []
  /** the hunks the run holds, and whether it holds shown lines too */
  let parts: ReviewHunk[] = []
  let added = false
  const flush = (): void => {
    if (run.length > 0) out.push(parts.length === 1 && !added ? parts[0]! : { header: headerOf(run), lines: run })
    run = []
    parts = []
    added = false
  }
  for (let i = 0; i <= hunks.length; i++) {
    const g = gaps.get(i)
    if (g) {
      let next = g.from
      for (const n of numbers) {
        if (n < g.from || n > g.to) continue
        // a hidden line before this one breaks the run
        if (n > next) flush()
        run.push({ kind: 'context', text: shown.get(n)!, oldNo: n + g.offset, newNo: n })
        added = true
        next = n + 1
      }
      if (next <= g.to) flush()
    } else if (i > 0) {
      // two hunks without a gap known between them stay apart
      flush()
    }
    if (i < hunks.length) {
      run.push(...hunks[i]!.lines)
      parts.push(hunks[i]!)
    }
  }
  flush()
  return out
}
