import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyAt, decideMove, sameTime, type TranscriptCopy } from '../../src/main/transcript-move'

const MAIN = join('cfg', 'main', 'projects')
const WORK = join('cfg', 'work', 'projects')
const OTHER = join('cfg', 'other', 'projects')

function copy(projects: string, mtimeMs: number, account: string | null = null, project = 'D--app'): TranscriptCopy {
  return { account, projects, project, path: join(projects, project, 'abc.jsonl'), mtimeMs }
}

describe('decideMove', () => {
  it('rule A: no copy there is copied, an older one replaced, a newer one refused', () => {
    const src = copy(MAIN, 200, null)
    const none = decideMove({ explicit: true, target: WORK, source: src, copies: [src] })
    expect(none).toEqual({ kind: 'copy', from: src })

    const older = copy(WORK, 100, 'work')
    expect(decideMove({ explicit: true, target: WORK, source: src, copies: [src, older] })).toEqual({ kind: 'copy', from: src })

    const newer = copy(WORK, 300, 'work')
    expect(decideMove({ explicit: true, target: WORK, source: src, copies: [src, newer] })).toEqual({ kind: 'refuse', newer })
  })

  it('rule A: the same folder copies nothing', () => {
    const src = copy(MAIN, 200, null)
    const sameFolder = copy(process.platform === 'win32' ? MAIN.toUpperCase() : MAIN, 100, null)
    expect(decideMove({ explicit: true, target: MAIN, source: src, copies: [src] })).toEqual({ kind: 'none' })
    expect(decideMove({ explicit: true, target: MAIN, source: sameFolder, copies: [sameFolder] })).toEqual({ kind: 'none' })
  })

  it('equal times are the same conversation', () => {
    const src = copy(MAIN, 200, null)
    const same = copy(WORK, 200, 'work')
    expect(decideMove({ explicit: true, target: WORK, source: src, copies: [src, same] })).toEqual({ kind: 'none' })
    // a copy's time is kept to the millisecond: a fraction of a millisecond apart is still the same
    const almost = copy(WORK, 200.5, 'work')
    expect(decideMove({ explicit: true, target: WORK, source: src, copies: [src, almost] })).toEqual({ kind: 'none' })
  })

  it('times 0.5 ms apart are the same conversation, 5 ms apart are not', () => {
    const base = 1_700_000_000_000
    expect(sameTime(base, base + 0.5)).toBe(true)
    expect(sameTime(base + 0.5, base)).toBe(true)
    expect(sameTime(base, base + 5)).toBe(false)
  })

  it('rule A without a reported path takes the newest copy', () => {
    const older = copy(MAIN, 100, null)
    const newest = copy(OTHER, 500, 'other')
    expect(decideMove({ explicit: true, target: WORK, source: null, copies: [older, newest] })).toEqual({ kind: 'copy', from: newest })
    // the newest copy already sits in the target: nothing to copy
    const inWork = copy(WORK, 900, 'work')
    expect(decideMove({ explicit: true, target: WORK, source: null, copies: [older, inWork] })).toEqual({ kind: 'none' })
    expect(decideMove({ explicit: true, target: WORK, source: null, copies: [] })).toEqual({ kind: 'none' })
  })

  it("rule B: the account's own copy is used; with none the newest is copied; with none anywhere nothing", () => {
    const own = copy(WORK, 100, 'work')
    const elsewhere = copy(MAIN, 900, null)
    expect(decideMove({ explicit: false, target: WORK, source: null, copies: [elsewhere, own] })).toEqual({ kind: 'none' })

    const older = copy(OTHER, 100, 'other')
    expect(decideMove({ explicit: false, target: WORK, source: null, copies: [older, elsewhere] })).toEqual({ kind: 'copy', from: elsewhere })

    expect(decideMove({ explicit: false, target: WORK, source: null, copies: [] })).toEqual({ kind: 'none' })
  })
})

describe('copyAt', () => {
  it('copyAt finds the copy of a path in another spelling', () => {
    const c = copy(MAIN, 100, null, 'proj')
    const other = copy(WORK, 100, 'work', 'proj')
    const spelled = `${MAIN}/proj/./abc.jsonl`
    const found = copyAt(process.platform === 'win32' ? spelled.toUpperCase() : spelled, [other, c])
    expect(found).toBe(c)
    expect(copyAt(join(MAIN, 'proj', 'missing.jsonl'), [c])).toBeNull()
    expect(copyAt(null, [c])).toBeNull()
    expect(copyAt(undefined, [c])).toBeNull()
  })
})
