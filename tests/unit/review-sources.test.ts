import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HistoryEdit } from '../../src/main/baselines'
import { EditLedger, type Snapshot } from '../../src/main/edit-ledger'
import type { GitResult, GitRun } from '../../src/main/git-source'
import { MAX_FILES, MAX_SIDE_BYTES } from '../../src/main/review-diff'
import { EMPTY_LEDGER, gitTotals, ledgerInputs, ledgerPaths, lineCount, readForSnapshot, relPathFor, type LedgerView, type SourceIo, type TranscriptLog } from '../../src/main/review-sources'

const BASE = process.platform === 'win32' ? 'D:\\proj' : '/proj'
const P = (rel: string): string => join(BASE, rel)

/** an in-memory disk */
function io(files: Record<string, string | Buffer>): SourceIo {
  const get = (p: string): string | Buffer | undefined => files[p]
  return {
    git: async () => { throw new Error('no git here') },
    diskInfo: (p) => {
      const f = get(p)
      return f === undefined ? { kind: 'absent' } : { kind: 'file', size: Buffer.byteLength(f) }
    },
    readDisk: (p) => {
      const f = get(p)
      return f === undefined ? null : Buffer.from(f)
    }
  }
}
const newLedger = (): EditLedger => new EditLedger({ dir: join(mkdtempSync(join(tmpdir(), 'ct-src-')), 'sid'), now: () => 1000, onError: () => {} })
const edit = (o: Partial<HistoryEdit>): HistoryEdit => ({ at: 1, toolUseId: 't', path: P('a.ts'), created: false, originalFile: null, patch: [], ...o })
const noLog: TranscriptLog = { prompts: [], edits: [] }
const sides = (r: ReturnType<typeof ledgerInputs>) =>
  r.inputs.map((i) => [i.relPath, i.before.kind === 'data' ? i.before.data.toString() : i.before.kind, i.after.kind === 'data' ? i.after.data.toString() : i.after.kind])

describe('ledgerInputs', () => {
  it('compares the session snapshots with the files on disk', () => {
    const l = newLedger()
    l.startTurn()
    l.recordBefore('t1', P('src/a.ts'), () => ({ kind: 'data', data: Buffer.from('old\n') }))
    l.recordBefore('t2', P('new.ts'), () => ({ kind: 'absent' }))
    const r = ledgerInputs(io({ [P('src/a.ts')]: 'new\n', [P('new.ts')]: 'x\n' }), l, noLog, 'session', BASE, () => false)
    expect(sides(r)).toEqual([['new.ts', 'absent', 'x\n'], ['src/a.ts', 'old\n', 'new\n']])
    expect(r.tooMany).toBe(false)
  })

  it('uses the last turn with edits for last_turn', () => {
    const l = newLedger()
    l.startTurn()
    l.recordBefore('t1', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('v1\n') }))
    l.startTurn()
    l.recordBefore('t2', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('v2\n') }))
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'v3\n' }), l, noLog, 'last_turn', BASE, () => false))).toEqual([['a.ts', 'v2\n', 'v3\n']])
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'v3\n' }), l, noLog, 'session', BASE, () => false))).toEqual([['a.ts', 'v1\n', 'v3\n']])
  })

  it('leaves out the files exclude names, before reading them', () => {
    const l = newLedger()
    l.startTurn()
    l.recordBefore('t1', P('dist/x.js'), () => ({ kind: 'data', data: Buffer.from('old\n') }))
    l.recordBefore('t2', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('old\n') }))
    const files = { [P('dist/x.js')]: 'new\n', [P('a.ts')]: 'new\n' }
    const reads: string[] = []
    const watching: SourceIo = { ...io(files), readDisk: (p) => { reads.push(p); return Buffer.from(files[p] as string) } }
    const exclude = (p: string): boolean => p === P('dist/x.js')
    expect(sides(ledgerInputs(watching, l, noLog, 'session', BASE, () => false, exclude))).toEqual([['a.ts', 'old\n', 'new\n']])
    expect(reads.every((p) => p !== P('dist/x.js'))).toBe(true)
  })

  it('ledgerPaths lists the files a ledger view would take, as the view does', () => {
    const l = newLedger()
    l.startTurn()
    l.recordBefore('t1', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('v1\n') }))
    l.startTurn()
    l.recordBefore('t2', P('b.ts'), () => ({ kind: 'data', data: Buffer.from('v1\n') }))
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v1', '+v2'] }
    const log: TranscriptLog = { prompts: [0], edits: [edit({ at: 10, toolUseId: 'h1', path: P('c.ts'), patch: [hunk] })] }
    expect(ledgerPaths(l, log, 'session').sort()).toEqual([P('a.ts'), P('b.ts'), P('c.ts')])
    expect(ledgerPaths(l, log, 'last_turn')).toEqual([P('b.ts')])
    expect(ledgerPaths(EMPTY_LEDGER, noLog, 'session')).toEqual([])
  })

  it('falls back to the transcript for edits the ledger never saw', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v1', '+v2'] }
    const log: TranscriptLog = { prompts: [0], edits: [edit({ at: 10, toolUseId: 'h1', patch: [hunk] })] }
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'v2\n' }), EMPTY_LEDGER, log, 'session', BASE, () => false))).toEqual([['a.ts', 'v1\n', 'v2\n']])
  })

  it('undoes history edits from the first snapshot, and ignores unrecorded edits after it', () => {
    const l = newLedger()
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-v1', '+v2'] }
    // t1 ran before ClaudeTerm watched; t2 was recorded at 1000 with the file at v2; h3 at 2000 slipped past the hook
    l.recordBefore('t2', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('v2\n') }))
    const log: TranscriptLog = { prompts: [], edits: [edit({ at: 10, toolUseId: 't1', patch: [hunk] }), edit({ at: 2000, toolUseId: 'h3', patch: [] })] }
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'v3\n' }), l, log, 'session', BASE, () => false))).toEqual([['a.ts', 'v1\n', 'v3\n']])
  })

  it.skipIf(process.platform !== 'win32')('paths that differ only in case are one file', () => {
    const l = newLedger()
    l.recordBefore('t1', 'D:\\proj\\A.ts', () => ({ kind: 'data', data: Buffer.from('v1\n') }))
    const log: TranscriptLog = { prompts: [], edits: [edit({ at: 5000, toolUseId: 'h9', path: 'd:\\proj\\a.ts' })] }
    expect(ledgerInputs(io({ 'D:\\proj\\A.ts': 'v2\n' }), l, log, 'session', BASE, () => false).inputs).toHaveLength(1)
  })

  it('takes the last transcript turn with edits when the ledger has none', () => {
    const h = (from: string, to: string) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${from}`, `+${to}`] }]
    const log: TranscriptLog = {
      prompts: [100, 200, 300],
      edits: [edit({ at: 150, toolUseId: 'a', path: P('a.ts'), patch: h('a1', 'a2') }), edit({ at: 250, toolUseId: 'b', path: P('b.ts'), patch: h('b1', 'b2') })]
    }
    expect(sides(ledgerInputs(io({ [P('a.ts')]: 'a2\n', [P('b.ts')]: 'b2\n' }), EMPTY_LEDGER, log, 'last_turn', BASE, () => false))).toEqual([['b.ts', 'b1\n', 'b2\n']])
  })

  it('marks big files too large unless forced, and stops reading past the view budget', () => {
    const big = 'x'.repeat(2_000_000)
    const l = newLedger()
    l.recordBefore('t1', P('big.txt'), () => ({ kind: 'absent' }))
    expect(ledgerInputs(io({ [P('big.txt')]: big }), l, noLog, 'session', BASE, () => false).inputs[0]!.after).toEqual({ kind: 'too-large', size: 2_000_000 })
    expect(ledgerInputs(io({ [P('big.txt')]: big }), l, noLog, 'session', BASE, () => true).inputs[0]!.after.kind).toBe('data')
    const many = newLedger()
    const files: Record<string, string> = {}
    for (let i = 0; i < 7; i++) {
      many.recordBefore(`t${i}`, P(`f${i}.txt`), () => ({ kind: 'absent' }))
      files[P(`f${i}.txt`)] = 'y'.repeat(900_000)
    }
    const r = ledgerInputs(io(files), many, noLog, 'session', BASE, () => false)
    expect(r.tooMany).toBe(true)
    expect(r.inputs.filter((i) => i.after.kind === 'skipped').length).toBeGreaterThan(0)
  })

  it('drops a file that still holds what its snapshot recorded (a denied edit), binary and big files too', () => {
    const l = newLedger()
    const png = Buffer.from([137, 80, 78, 71, 0, 1])
    const big = 'z'.repeat(2_000_000)
    l.recordBefore('t1', P('img.png'), () => ({ kind: 'data', data: png }))
    l.recordBefore('t2', P('big.txt'), () => ({ kind: 'data', data: Buffer.from(big) }))
    l.recordBefore('t3', P('a.ts'), () => ({ kind: 'data', data: Buffer.from('same\n') }))
    expect(ledgerInputs(io({ [P('img.png')]: png, [P('big.txt')]: big, [P('a.ts')]: 'same\n' }), l, noLog, 'session', BASE, () => false).inputs).toEqual([])
    const changed = ledgerInputs(io({ [P('img.png')]: Buffer.from([137, 80, 78, 71, 0, 2]), [P('big.txt')]: big, [P('a.ts')]: 'same\n' }), l, noLog, 'session', BASE, () => false)
    expect(changed.inputs.map((i) => [i.relPath, i.before.kind])).toEqual([['img.png', 'binary']])
  })
})

describe('a view over 500 files', () => {
  it('lists the first 500 without reading them, and leaves the rest out', () => {
    const snaps: Snapshot[] = Array.from({ length: 503 }, (_, i) => ({ path: P(`f${String(i).padStart(3, '0')}.txt`), at: 1, toolUseId: `t${i}`, kind: 'absent', sha: null }))
    const ledger: LedgerView = { ...EMPTY_LEDGER, sessionSnapshots: () => snaps }
    const r = ledgerInputs(io({}), ledger, noLog, 'session', BASE, () => false)
    expect(r.tooMany).toBe(true)
    expect(r.inputs).toHaveLength(MAX_FILES)
    expect(r.inputs[MAX_FILES - 1]!.relPath).toBe('f499.txt')
    expect(r.inputs.every((i) => i.before.kind === 'skipped' && i.after.kind === 'skipped')).toBe(true)
  })
})

describe('gitTotals', () => {
  const ok = (stdout: string): GitResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '' })
  function fakeGit(numstat: string, untracked: string[]): { run: GitRun; calls: string[][] } {
    const calls: string[][] = []
    const run: GitRun = async (args) => {
      calls.push(args)
      if (args.includes('rev-parse')) return ok('1111111111111111111111111111111111111111\n')
      if (args.includes('--numstat')) return ok(numstat)
      if (args.includes('status')) return ok(untracked.map((u) => `?? ${u}\0`).join(''))
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    return { run, calls }
  }

  it('counts tracked changes with git\'s numstat and untracked files by their lines', async () => {
    const git = fakeGit('3\t1\tsrc/a.ts\0-\t-\timg.png\0', ['new.ts', 'big.txt', 'pic.png', 'empty.txt'])
    const disk = io({ [P('new.ts')]: 'a\nb\r\nc', [P('pic.png')]: Buffer.from([137, 80, 0, 1]), [P('empty.txt')]: '' })
    const big: SourceIo = { ...disk, git: git.run, diskInfo: (p) => (p === P('big.txt') ? { kind: 'file', size: MAX_SIDE_BYTES + 1 } : disk.diskInfo(p)) }
    expect(await gitTotals(big, BASE)).toEqual({ files: 6, additions: 6, deletions: 1 })
    const numstat = git.calls.find((a) => a.includes('--numstat'))!
    expect(numstat).toEqual(['--literal-pathspecs', 'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '1111111111111111111111111111111111111111', '--'])
  })

  it('reads at most 500 untracked files for their lines, and counts them all', async () => {
    const names = Array.from({ length: 502 }, (_, i) => `u${i}.txt`)
    const git = fakeGit('', names)
    const files = Object.fromEntries(names.map((n) => [P(n), 'x\n']))
    expect(await gitTotals({ ...io(files), git: git.run }, BASE)).toEqual({ files: 502, additions: 500, deletions: 0 })
  })
})

describe('helpers', () => {
  it('lineCount counts lines like the diff does, and 0 for a binary file', () => {
    expect(lineCount(Buffer.from(''))).toBe(0)
    expect(lineCount(Buffer.from('a'))).toBe(1)
    expect(lineCount(Buffer.from('a\n'))).toBe(1)
    expect(lineCount(Buffer.from('a\r\nb\r\n'))).toBe(2)
    expect(lineCount(Buffer.from('a\n\nb'))).toBe(3)
    expect(lineCount(Buffer.from([97, 0, 10]))).toBe(0)
  })

  it('relPathFor gives a /-path inside the base and the full path outside', () => {
    expect(relPathFor(BASE, P('src/a.ts'))).toBe('src/a.ts')
    const outside = process.platform === 'win32' ? 'E:\\x\\b.ts' : '/x/b.ts'
    expect(relPathFor(BASE, outside)).toBe(outside)
  })

  it('readForSnapshot reads small files and tells absent and too large ones', () => {
    const disk = io({ [P('a.ts')]: 'a' })
    expect(readForSnapshot(disk, P('a.ts'))).toEqual({ kind: 'data', data: Buffer.from('a') })
    expect(readForSnapshot(disk, P('none.ts'))).toEqual({ kind: 'absent' })
    const huge: SourceIo = { ...disk, diskInfo: () => ({ kind: 'file', size: 11 * 1024 * 1024 }) }
    expect(readForSnapshot(huge, P('a.ts'))).toEqual({ kind: 'too-large' })
  })
})
