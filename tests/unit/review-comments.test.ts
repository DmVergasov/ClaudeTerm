import { describe, expect, it } from 'vitest'
import { anchorOf, attemptSend, draftAfterSend, formatSendMessage, locate, location, moveAnchor, reanchorComment, sendErrorAfter, type ReviewComment } from '../../src/renderer/review-comments'
import type { ReviewFile, ReviewLine } from '../../src/shared/review'

const L = (kind: ReviewLine['kind'], text: string, oldNo: number | null, newNo: number | null): ReviewLine => ({ kind, text, oldNo, newNo })
const file = (relPath: string, lines: ReviewLine[], path = `/r/${relPath}`): ReviewFile => ({
  path, relPath, status: 'modified', additions: 0, deletions: 0, hunks: [{ header: '@@', lines }], note: null, canForce: false, hash: 'h', viewed: false
})
const same = (a: string, b: string): boolean => a === b
const comment = (anchor: ReviewComment['anchor'], text: string, outdated = false): ReviewComment => ({ id: 'c', anchor, text, outdated })

describe('formatSendMessage', () => {
  it('writes the spec example', () => {
    const hub = file('src/main/image-hub.ts', [L('context', '    const key = pathKey(p)', 39, 39), L('del', '    if (seen.has(p)) return', 40, null), L('add', '    if (seen.has(key)) return', null, 40), L('add', '    seen.add(key)', null, 41)])
    const test = file('tests/unit/image-hub.test.ts', [L('del', '    expect(hub.size).toBe(1)', 12, null)])
    const msg = formatSendMessage('uncommitted', [
      comment(anchorOf(hub, hub.hunks[0]!.lines.slice(2, 4), 'scope:uncommitted'), "What if p is empty? pathKey('') returns '.' here."),
      comment(anchorOf(test, test.hunks[0]!.lines, 'scope:uncommitted'), 'Why was this check dropped?')
    ])
    expect(msg).toBe([
      'Review comments on the changes (uncommitted):',
      '',
      '1. src/main/image-hub.ts:40-41',
      '   > if (seen.has(key)) return',
      '   > seen.add(key)',
      "   What if p is empty? pathKey('') returns '.' here.",
      '',
      '2. tests/unit/image-hub.test.ts:12 (removed line, was: expect(hub.size).toBe(1))',
      '   Why was this check dropped?'
    ].join('\n'))
  })

  it('cuts a quote at 6 lines, marks mixed lines and outdated comments', () => {
    const lines = Array.from({ length: 8 }, (_, i) => L('add', `line ${i + 1}`, null, i + 1))
    const f = file('a.ts', lines)
    const long = formatSendMessage('session', [comment(anchorOf(f, lines, 'k'), 'Too long')])
    expect(long.split('\n').filter((l) => l.startsWith('   >'))).toEqual(['   > line 1', '   > line 2', '   > line 3', '   > line 4', '   > line 5', '   > line 6', '   > …'])
    const mixed = file('b.ts', [L('del', 'old', 3, null), L('add', 'new', null, 3)])
    expect(formatSendMessage('last turn', [comment(anchorOf(mixed, mixed.hunks[0]!.lines, 'k'), 'Hm', true)])).toBe(
      ['Review comments on the changes (last turn):', '', '1. b.ts:3 (outdated: the lines changed since)', '   > -old', '   > +new', '   Hm'].join('\n')
    )
  })

  it('names a range of removed lines', () => {
    const f = file('c.ts', [L('del', 'a', 7, null), L('del', 'b', 8, null)])
    expect(location(anchorOf(f, f.hunks[0]!.lines, 'k'))).toBe('c.ts:7-8 (removed lines)')
  })
})

describe('locate', () => {
  const lines = [L('context', 'x', 1, 1), L('add', 'target', null, 2), L('context', 'y', 2, 3)]
  const f = file('a.ts', lines)
  const anchor = anchorOf(f, [lines[1]!], 'k')

  it('finds the same lines after they moved, and moves the anchor', () => {
    const moved = file('a.ts', [L('context', 'z', 1, 1), ...Array.from({ length: 10 }, (_, i) => L('add', `n${i}`, null, i + 2)), L('add', 'target', null, 12)])
    const at = locate(anchor, [moved], same)
    expect(at).toEqual({ file: 0, hunk: 0, from: 11, to: 11 })
    expect(moveAnchor(anchor, [moved], at!).lines[0]!.newNo).toBe(12)
  })

  it('takes the nearest copy and gives up beyond 50 lines or when the text changed', () => {
    const twice = file('a.ts', [L('add', 'target', null, 60), L('context', 'q', 1, 61), L('add', 'target', null, 3)])
    expect(locate(anchor, [twice], same)).toEqual({ file: 0, hunk: 0, from: 2, to: 2 })
    expect(locate(anchor, [file('a.ts', [L('add', 'target', null, 80)])], same)).toBeNull()
    expect(locate(anchor, [file('a.ts', [L('add', 'TARGET', null, 2)])], same)).toBeNull()
    expect(locate(anchor, [file('b.ts', lines)], same)).toBeNull()
  })

  it('compares paths with the given rule', () => {
    const upper = file('a.ts', lines, '/R/A.TS')
    expect(locate(anchor, [upper], (a, b) => a.toLowerCase() === b.toLowerCase())).not.toBeNull()
  })
})

describe('reanchorComment', () => {
  const lines = [L('context', 'x', 1, 1), L('add', 'target', null, 2), L('context', 'y', 2, 3)]
  const f = file('a.ts', lines)
  const c = comment(anchorOf(f, [lines[1]!], 'scope:last_turn'), 'Why?')

  it('follows its lines and is current again once they are found', () => {
    const moved = file('a.ts', [L('context', 'z', 1, 1), L('add', 'new', null, 2), L('add', 'target', null, 3)])
    const r = reanchorComment({ ...c, outdated: true }, [moved], same)
    expect(r.outdated).toBe(false)
    expect(r.anchor.lines[0]!.newNo).toBe(3)
  })

  it('is outdated when its file is still in the view without its lines', () => {
    expect(reanchorComment(c, [file('a.ts', [L('add', 'other', null, 2)])], same).outdated).toBe(true)
  })

  it('stays as it was when its file left the view, or shows no hunks', () => {
    expect(reanchorComment(c, [file('b.ts', lines)], same)).toEqual(c)
    expect(reanchorComment(c, [], same)).toEqual(c)
    expect(reanchorComment({ ...c, outdated: true }, [], same).outdated).toBe(true)
    const skipped: ReviewFile = { ...file('a.ts', []), hunks: [], note: 'too-many' }
    expect(reanchorComment(c, [skipped], same)).toEqual(c)
  })
})

describe('Send', () => {
  const update = (tabId: string, ok: boolean) => ({ tabId, send: ok ? { ok: true as const } : { ok: false as const, reason: 'Answer Claude\'s prompt in the terminal first' } })

  it('keeps its error while the tab still may not send, and drops it once it may, or on another tab', () => {
    expect(sendErrorAfter('refused', 't1', update('t1', false))).toBe('refused')
    expect(sendErrorAfter('refused', 't1', update('t1', true))).toBeNull()
    expect(sendErrorAfter('refused', 't1', update('t2', false))).toBeNull()
    expect(sendErrorAfter('refused', 't1', null)).toBeNull()
  })

  it('turns a failure into the reason shown', async () => {
    expect(await attemptSend(async () => null)).toBeNull()
    expect(await attemptSend(async () => 'Claude is not running in this tab')).toBe('Claude is not running in this tab')
    expect(await attemptSend(() => Promise.reject(new Error('the window is gone')))).toBe('the window is gone')
    expect(await attemptSend(() => { throw new Error('no message') })).toBe('no message')
  })

  it('keeps a comment being typed after a Send, as a new comment', () => {
    const anchor = anchorOf(file('a.ts', [L('add', 'x', null, 1)]), [L('add', 'x', null, 1)], 'k')
    expect(draftAfterSend(null)).toBeNull()
    expect(draftAfterSend({ anchor, text: '  ', editing: null })).toBeNull()
    expect(draftAfterSend({ anchor, text: 'and this', editing: null })).toEqual({ anchor, text: 'and this', editing: null })
    // the comment it edited was sent: the new text becomes a comment of its own
    expect(draftAfterSend({ anchor, text: 'edited', editing: 'c1' })).toEqual({ anchor, text: 'edited', editing: null })
  })
})
