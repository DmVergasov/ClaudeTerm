import { describe, expect, it } from 'vitest'
import { DIFF_TIMEOUT_MS, toHunks } from '../../src/main/review-diff'
import { EXPAND_STEP, expandHunks, expandWays, gapsOf, linesToShow, type Gap } from '../../src/renderer/review-expand'
import type { ReviewHunk } from '../../src/shared/review'

/** a file of `n` numbered lines */
const numbered = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`)
const text = (lines: string[]): string => lines.map((l) => `${l}\n`).join('')
const hunksOf = (before: string[], after: string[]): ReviewHunk[] => toHunks(text(before), text(after), DIFF_TIMEOUT_MS)!.hunks
/** the new side's lines `from`..`to`, as the main process gives them */
const shown = (after: string[], ...ranges: [number, number][]): Map<number, string> =>
  new Map(ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i): [number, string] => [from + i, after[from + i - 1]!])))
/** a hunk's lines as "kind old new" */
const rows = (h: ReviewHunk): string[] => h.lines.map((l) => `${l.kind} ${l.oldNo ?? '-'} ${l.newNo ?? '-'}`)

// 100 lines; line 30 changed, and a line added after line 70: two hunks
const BEFORE = numbered(100)
const AFTER = [...BEFORE.slice(0, 29), 'line 30 changed', ...BEFORE.slice(30, 70), 'line 70b', ...BEFORE.slice(70)]
const HUNKS = hunksOf(BEFORE, AFTER)

describe('gapsOf', () => {
  it('finds the lines hidden above the first hunk, between the hunks and below the last, with the old side\'s numbers', () => {
    expect(HUNKS.map((h) => h.header)).toEqual(['@@ -27,7 +27,7 @@', '@@ -68,6 +68,7 @@'])
    expect(gapsOf(HUNKS, AFTER.length)).toEqual<Gap[]>([
      { before: 0, from: 1, to: 26, offset: 0 },
      { before: 1, from: 34, to: 67, offset: 0 },
      // past the added line the old side is one line behind
      { before: 2, from: 75, to: 101, offset: -1 }
    ])
  })

  it('finds no gap above a hunk that starts at the first line, nor below one that ends at the last', () => {
    const before = numbered(10)
    const after = ['line 1 changed', ...before.slice(1, 9), 'line 10 changed']
    const hunks = hunksOf(before, after)
    expect(hunks).toHaveLength(2)
    expect(gapsOf(hunks, after.length)).toEqual<Gap[]>([{ before: 1, from: 5, to: 6, offset: 0 }])
  })

  it('finds no gap in a file without hunks, nor in a new file', () => {
    expect(gapsOf([], 0)).toEqual([])
    expect(gapsOf(hunksOf([], numbered(50)), 50)).toEqual([])
  })
})

describe('expandWays and linesToShow', () => {
  it('offers ↑ above the first hunk, ↓ below the last, and both between two, or ↕ for a short gap between two', () => {
    const [top, between, bottom] = gapsOf(HUNKS, AFTER.length)
    expect(expandWays(top!, HUNKS.length)).toEqual(['up'])
    expect(expandWays(between!, HUNKS.length)).toEqual(['down', 'up'])
    expect(expandWays(bottom!, HUNKS.length)).toEqual(['down'])
    expect(expandWays({ before: 1, from: 40, to: 40 + EXPAND_STEP - 1, offset: 0 }, 2)).toEqual(['all'])
  })

  it('shows 20 lines next to the hunk the button belongs to, or every line of the gap', () => {
    const between: Gap = { before: 1, from: 34, to: 67, offset: 0 }
    expect(linesToShow(between, 'down')).toEqual([34, 53])
    expect(linesToShow(between, 'up')).toEqual([48, 67])
    expect(linesToShow(between, 'all')).toEqual([34, 67])
    // a gap shorter than a step shows whole either way
    expect(linesToShow({ before: 0, from: 1, to: 6, offset: 0 }, 'up')).toEqual([1, 6])
    expect(linesToShow({ before: 2, from: 95, to: 101, offset: -1 }, 'down')).toEqual([95, 101])
  })
})

describe('expandHunks', () => {
  it('keeps the hunks as they are while no hidden line shows', () => {
    expect(expandHunks(HUNKS, AFTER.length, new Map())).toEqual(HUNKS)
  })

  it('puts the lines shown above the first hunk in it as context, and its header counts them', () => {
    const out = expandHunks(HUNKS, AFTER.length, shown(AFTER, [7, 26]))
    expect(out).toHaveLength(2)
    expect(out[0]!.header).toBe('@@ -7,27 +7,27 @@')
    expect(out[0]!.lines[0]).toEqual({ kind: 'context', text: 'line 7', oldNo: 7, newNo: 7 })
    expect(out[1]).toBe(HUNKS[1])
    expect(gapsOf(out, AFTER.length)[0]).toEqual({ before: 0, from: 1, to: 6, offset: 0 })
  })

  it('puts the lines shown under a hunk at its end, and those shown over the next at its start', () => {
    const out = expandHunks(HUNKS, AFTER.length, shown(AFTER, [34, 53], [60, 67]))
    expect(out.map((h) => h.header)).toEqual(['@@ -27,27 +27,27 @@', '@@ -60,14 +60,15 @@'])
    expect(rows(out[0]!).slice(-2)).toEqual(['context 52 52', 'context 53 53'])
    expect(rows(out[1]!).slice(0, 2)).toEqual(['context 60 60', 'context 61 61'])
    expect(gapsOf(out, AFTER.length).find((g) => g.before === 1)).toEqual({ before: 1, from: 54, to: 59, offset: 0 })
  })

  it('joins two hunks when every line between them shows', () => {
    const out = expandHunks(HUNKS, AFTER.length, shown(AFTER, [34, 67]))
    expect(out).toHaveLength(1)
    expect(out[0]!.header).toBe('@@ -27,47 +27,48 @@')
    expect(out[0]!.lines.filter((l) => l.kind !== 'context').map((l) => l.text)).toEqual(['line 30', 'line 30 changed', 'line 70b'])
    expect(gapsOf(out, AFTER.length).map((g) => g.before)).toEqual([0, 1])
  })

  it('numbers the lines shown below the last hunk on the old side too', () => {
    const out = expandHunks(HUNKS, AFTER.length, shown(AFTER, [75, 101]))
    expect(rows(out[1]!).slice(-1)).toEqual(['context 100 101'])
    expect(out[1]!.lines.at(-1)!.text).toBe('line 100')
    expect(out[1]!.header).toBe('@@ -68,33 +68,34 @@')
    expect(gapsOf(out, AFTER.length).map((g) => g.before)).toEqual([0, 1])
  })

  it('shows lines that touch no hunk as a hunk of their own', () => {
    const out = expandHunks(HUNKS, AFTER.length, shown(AFTER, [40, 45]))
    expect(out.map((h) => h.header)).toEqual(['@@ -27,7 +27,7 @@', '@@ -40,6 +40,6 @@', '@@ -68,6 +68,7 @@'])
    expect(out[1]!.lines.every((l) => l.kind === 'context')).toBe(true)
  })

  it('shows the whole file as one hunk when every hidden line shows', () => {
    const out = expandHunks(HUNKS, AFTER.length, shown(AFTER, [1, 26], [34, 67], [75, 101]))
    expect(out).toHaveLength(1)
    expect(out[0]!.header).toBe('@@ -1,100 +1,101 @@')
    expect(out[0]!.lines.filter((l) => l.newNo !== null).map((l) => l.text)).toEqual(AFTER)
    expect(gapsOf(out, AFTER.length)).toEqual([])
  })
})
