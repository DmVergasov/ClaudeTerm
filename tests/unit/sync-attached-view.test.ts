import { describe, expect, it } from 'vitest'
import { AttachedView, MAX_WAITING_CHARS, type StreamItem } from '../../src/main/sync/attached-view'

function out(seq: number, d: string): StreamItem {
  return { t: 'out', seq, d }
}

function reset(seq: number): StreamItem {
  return { t: 'reset', seq }
}

function exit(seq: number, code: number): StreamItem {
  return { t: 'exit', seq, code }
}

/** a view that has taken the snapshot `n`: it is ready and expects n + 1 next */
function readyAt(n: number): AttachedView {
  const v = new AttachedView()
  v.snapshot({ seq: n, data: '', cols: 80, rows: 24 })
  return v
}

describe('attached view', () => {
  it('stream items before the snapshot wait; those it covers are dropped', () => {
    const v = new AttachedView()
    expect(v.stream(out(5, 'e'))).toEqual([])
    expect(v.stream(out(6, 'f'))).toEqual([])
    expect(v.snapshot({ seq: 5, data: 'SNAP', cols: 80, rows: 24 })).toEqual([
      { kind: 'reset' },
      { kind: 'write', data: 'SNAP' },
      { kind: 'write', data: 'f' }
    ])
    expect(v.stream(out(7, 'g'))).toEqual([{ kind: 'write', data: 'g' }])
  })

  it('a gap asks for a fresh attach', () => {
    const v = readyAt(7)
    expect(v.stream(out(9, 'x'))).toEqual([{ kind: 'reattach' }])
  })

  it('a gap between the snapshot and what waited asks for a fresh attach', () => {
    const v = new AttachedView()
    v.stream(out(8, 'x'))
    expect(v.snapshot({ seq: 5, data: '', cols: 80, rows: 24 })).toEqual([{ kind: 'reattach' }])
  })

  it('reset and exit in the stream', () => {
    const v = readyAt(7)
    expect(v.stream(reset(8))).toEqual([{ kind: 'reset' }])
    expect(v.stream(exit(9, 0))).toEqual([{ kind: 'exit', code: 0 }])
  })

  it('too much waiting before the snapshot asks for a fresh attach', () => {
    const v = new AttachedView()
    v.stream(out(1, 'x'.repeat(MAX_WAITING_CHARS)))
    expect(v.stream(out(2, 'x'))).toEqual([{ kind: 'reattach' }])
  })

  // Minor 4: an exit covered by the snapshot still reaches the window, after the snapshot
  it('a covered exit is delivered after the snapshot write, with its code', () => {
    const v = new AttachedView()
    v.stream(out(5, 'last'))
    v.stream(exit(6, 3))
    expect(v.snapshot({ seq: 6, data: 'SNAP', cols: 80, rows: 24 })).toEqual([
      { kind: 'reset' },
      { kind: 'write', data: 'SNAP' },
      { kind: 'exit', code: 3 }
    ])
  })

  // Minor B: a covered exit is delivered only when it is the last item the snapshot covers and nothing follows it
  it('a covered exit followed by covered output is not delivered: the tab restarted', () => {
    const v = new AttachedView()
    v.stream(exit(6, 3))
    v.stream(out(7, 'restarted'))
    expect(v.snapshot({ seq: 7, data: 'SNAP', cols: 80, rows: 24 })).toEqual([
      { kind: 'reset' },
      { kind: 'write', data: 'SNAP' }
    ])
  })

  it('a covered exit followed by a covered reset is not delivered: the tab restarted', () => {
    const v = new AttachedView()
    v.stream(exit(6, 3))
    v.stream(reset(7))
    expect(v.snapshot({ seq: 7, data: 'SNAP', cols: 80, rows: 24 })).toEqual([
      { kind: 'reset' },
      { kind: 'write', data: 'SNAP' }
    ])
  })

  it('a covered exit followed by output after the snapshot is not delivered: the tab restarted', () => {
    const v = new AttachedView()
    v.stream(exit(6, 3))
    v.stream(out(7, 'restarted'))
    expect(v.snapshot({ seq: 6, data: 'SNAP', cols: 80, rows: 24 })).toEqual([
      { kind: 'reset' },
      { kind: 'write', data: 'SNAP' },
      { kind: 'write', data: 'restarted' }
    ])
  })

  it('a covered reset is covered by the snapshot and not delivered', () => {
    const v = new AttachedView()
    v.stream(reset(4))
    expect(v.snapshot({ seq: 5, data: 'SNAP', cols: 80, rows: 24 })).toEqual([
      { kind: 'reset' },
      { kind: 'write', data: 'SNAP' }
    ])
  })

  // Minor 5: every waiting item counts toward MAX_WAITING_CHARS
  it('reset and exit waiting before the snapshot count toward the limit', () => {
    const v = new AttachedView()
    const per = 64
    for (let i = 1; i <= MAX_WAITING_CHARS / per; i++) {
      expect(v.stream(i % 2 ? reset(i) : exit(i, 0))).toEqual([])
    }
    expect(v.stream(reset(MAX_WAITING_CHARS / per + 1))).toEqual([{ kind: 'reattach' }])
  })

  it('a repeated number after ready asks for a fresh attach', () => {
    const v = readyAt(7)
    expect(v.stream(out(8, 'a'))).toEqual([{ kind: 'write', data: 'a' }])
    expect(v.stream(out(8, 'b'))).toEqual([{ kind: 'reattach' }])
  })

  it('nothing is written after a loss', () => {
    const v = readyAt(7)
    expect(v.stream(out(9, 'x'))).toEqual([{ kind: 'reattach' }])
    expect(v.stream(out(8, 'late'))).toEqual([])
    expect(v.snapshot({ seq: 9, data: 'S', cols: 80, rows: 24 })).toEqual([])
  })
})
