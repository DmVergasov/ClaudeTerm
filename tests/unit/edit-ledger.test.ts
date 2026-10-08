import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EditLedger, MAX_SNAPSHOT_BYTES, type FileRead } from '../../src/main/edit-ledger'

const data = (s: string): FileRead => ({ kind: 'data', data: Buffer.from(s) })
function ledger(dir = join(mkdtempSync(join(tmpdir(), 'ct-ledger-')), 'sid'), now = () => 1000) {
  const onError = vi.fn()
  return { l: new EditLedger({ dir, now, onError }), dir, onError }
}

describe('EditLedger', () => {
  it('the first snapshot per turn and per session wins', () => {
    const { l } = ledger()
    l.startTurn()
    l.recordBefore('t1', '/p/a.ts', () => data('v1'))
    l.recordBefore('t2', '/p/a.ts', () => data('v2'))
    expect(l.sessionSnapshots().map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v1'])
    expect(l.lastTurnSnapshots()!.map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v1'])
    l.startTurn()
    l.recordBefore('t3', '/p/a.ts', () => data('v3'))
    l.recordBefore('t4', '/p/a.ts', () => data('v4'))
    expect(l.sessionSnapshots().map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v1'])
    expect(l.lastTurnSnapshots()!.map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v3'])
  })

  it('keeps the last turn with edits through a turn without edits', () => {
    const { l } = ledger()
    l.startTurn()
    l.recordBefore('t1', '/p/a.ts', () => data('v1'))
    l.startTurn() // a question, no edits
    expect(l.lastTurnSnapshots()!.map((s) => s.toolUseId)).toEqual(['t1'])
  })

  it('has no last turn before any edit, and records each tool use once', () => {
    const { l } = ledger()
    expect(l.lastTurnSnapshots()).toBeNull()
    const read = vi.fn(() => data('x'))
    l.recordBefore('t1', '/p/a.ts', read)
    l.recordBefore('t1', '/p/b.ts', read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(l.has('t1')).toBe(true)
    expect(l.has('t2')).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('treats paths that differ only in case as one file on Windows', () => {
    const { l } = ledger()
    l.recordBefore('t1', 'D:\\p\\A.ts', () => data('v1'))
    l.recordBefore('t2', 'd:\\p\\a.ts', () => data('v2'))
    expect(l.sessionSnapshots()).toHaveLength(1)
  })

  it('records absent, too large and unreadable files without content, and a binary file by its hash only', () => {
    const { l } = ledger()
    const png = Buffer.from([1, 0, 2])
    const pngSha = createHash('sha1').update(png).digest('hex')
    l.recordBefore('t1', '/p/new.ts', () => ({ kind: 'absent' }))
    l.recordBefore('t2', '/p/img.png', () => ({ kind: 'data', data: png }))
    l.recordBefore('t3', '/p/big.bin', () => ({ kind: 'data', data: Buffer.alloc(MAX_SNAPSHOT_BYTES + 1) }))
    l.recordBefore('t4', '/p/locked.ts', () => ({ kind: 'unreadable' }))
    expect(l.sessionSnapshots().map((s) => [s.kind, s.sha])).toEqual([['absent', null], ['binary', pngSha], ['too-large', null], ['unreadable', null]])
    expect(l.readBlob(pngSha)).toBeNull()
  })

  it('saves to ledger.json and blobs, and loads them back for the same session', () => {
    const { l, dir } = ledger(undefined, () => 4242)
    l.startTurn()
    l.recordBefore('t1', '/p/a.ts', () => data('hello'))
    const snap = l.sessionSnapshots()[0]!
    expect(readFileSync(join(dir, 'blobs', snap.sha!), 'utf8')).toBe('hello')
    const again = new EditLedger({ dir, now: () => 0, onError: () => {} })
    expect(again.sessionSnapshots()).toEqual([{ path: '/p/a.ts', at: 4242, toolUseId: 't1', kind: 'blob', sha: snap.sha }])
    expect(again.lastTurnSnapshots()).toHaveLength(1)
    expect(again.has('t1')).toBe(true)
    expect(again.blobSize(snap.sha!)).toBe(5)
    again.startTurn()
    again.recordBefore('t2', '/p/a.ts', () => data('second'))
    expect(again.lastTurnSnapshots()!.map((s) => s.toolUseId)).toEqual(['t2'])
  })

  it('ignores a broken ledger.json', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ct-ledger-')), 'sid')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ledger.json'), '{"version":1,"turn":"x"}')
    const { l } = ledger(dir)
    expect(l.sessionSnapshots()).toEqual([])
  })

  it('keeps working in memory when the folder cannot be written, and says so once', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ct-ledger-'))
    const blocker = join(parent, 'file')
    writeFileSync(blocker, 'x') // a file where the folder should be
    const { l, onError } = ledger(join(blocker, 'sid'))
    l.recordBefore('t1', '/p/a.ts', () => data('v1'))
    l.recordBefore('t2', '/p/b.ts', () => data('v2'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(l.sessionSnapshots().map((s) => l.readBlob(s.sha!)!.toString())).toEqual(['v1', 'v2'])
    rmSync(parent, { recursive: true, force: true })
  })
})
