import { describe, expect, it } from 'vitest'
import { historyBaseline, reverseApply, type HistoryEdit } from '../../src/main/baselines'

const edit = (o: Partial<HistoryEdit>): HistoryEdit => ({ at: 1, toolUseId: 't', path: '/p/a.ts', created: false, originalFile: null, patch: [], ...o })

describe('reverseApply', () => {
  it('undoes a hunk at its place', () => {
    const after = 'one\ntwo\nTHREE\nfour\n'
    const hunk = { oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [' two', '-three', '+THREE', ' four'] }
    expect(reverseApply(after, [hunk])).toBe('one\ntwo\nthree\nfour\n')
  })

  it('finds a hunk that moved, and undoes several hunks of one edit', () => {
    const after = 'x\none\nB\nthree\nfour\nfive\nsix\nG\n'
    const hunks = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-b', '+B', ' three'] },
      { oldStart: 6, oldLines: 2, newStart: 6, newLines: 2, lines: [' six', '-g', '+G'] }
    ]
    expect(reverseApply(after, hunks)).toBe('x\none\nb\nthree\nfour\nfive\nsix\ng\n')
  })

  it('keeps CRLF line endings and ignores a "no newline" marker', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b', '\\ No newline at end of file'] }
    expect(reverseApply('b\r\nc\r\n', [hunk])).toBe('a\r\nc\r\n')
  })

  it('returns null when the text no longer holds the hunk', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
    expect(reverseApply('zzz\n', [hunk])).toBeNull()
  })
})

describe('historyBaseline', () => {
  const p1 = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v1', '+v2'] }
  const p2 = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v2', '+v3'] }

  it('uses the first edit\'s original file when Claude Code stored it', () => {
    expect(historyBaseline([edit({ originalFile: 'v1\n', patch: [p1] }), edit({ patch: [p2] })], 'v3\n')).toEqual({ kind: 'text', text: 'v1\n' })
  })

  it('undoes every edit, newest first, when there is no original file', () => {
    expect(historyBaseline([edit({ patch: [p1] }), edit({ patch: [p2] })], 'v3\n')).toEqual({ kind: 'text', text: 'v1\n' })
  })

  it('jumps to a later edit\'s original file on the way back', () => {
    expect(historyBaseline([edit({ patch: [p1] }), edit({ originalFile: 'v2\n', patch: [p2] })], 'garbled\n')).toEqual({ kind: 'text', text: 'v1\n' })
  })

  it('says absent for a file the first edit created', () => {
    expect(historyBaseline([edit({ created: true }), edit({ patch: [p2] })], 'v3\n')).toEqual({ kind: 'absent' })
  })

  it('has no baseline when a patch does not apply, the later text is unknown or a later edit recreated the file', () => {
    expect(historyBaseline([edit({ patch: [p1] })], 'changed by bash\n')).toEqual({ kind: 'none' })
    expect(historyBaseline([edit({ patch: [p1] })], null)).toEqual({ kind: 'none' })
    expect(historyBaseline([edit({ patch: [p1] }), edit({ created: true })], 'v2\n')).toEqual({ kind: 'none' })
    expect(historyBaseline([], 'x')).toEqual({ kind: 'none' })
  })
})
