import { beforeEach, describe, expect, it } from 'vitest'
import type { RemoteTab } from '../../src/shared/remote'
import type { MainStatus } from '../../src/shared/types'
import { TabAttention, TabDirectory, TabInputs, statusSummary } from '../../src/main/sync/tab-directory'

const T1 = 'a0000000-0000-4000-8000-000000000001'
const T2 = 'a0000000-0000-4000-8000-000000000002'

function tab(id: string, over: Partial<RemoteTab> = {}): RemoteTab {
  return {
    id,
    kind: 'claude',
    profile: 'Claude',
    cwd: 'D:\\Projects\\Demo',
    folder: 'D:\\Projects\\Demo',
    customTitle: null,
    title: null,
    claudeSessionId: null,
    account: null,
    accountName: null,
    muted: false,
    exited: false,
    working: false,
    attention: null,
    attentionSeq: 0,
    images: 0,
    note: false,
    counter: null,
    status: null,
    size: { cols: 120, rows: 30, by: null },
    place: null,
    placeKnown: true,
    forkOf: null,
    fork: false,
    ...over
  }
}

function main(displayName: string, usedPct: number | null): MainStatus {
  return {
    model: { id: 'claude-opus-4-1', displayName },
    effort: null,
    context: usedPct === null ? null : { usedTokens: 1000, size: 200000, usedPct },
    fiveHour: null,
    sevenDay: null
  }
}

describe('tab directory', () => {
  let d: TabDirectory

  beforeEach(() => {
    d = new TabDirectory()
  })

  it('diff reports the new and the changed entries once, then nothing for the same list', () => {
    expect(d.diff([tab(T1)]).changed).toHaveLength(1)
    expect(d.diff([tab(T1, { muted: true })]).changed).toHaveLength(1)
    expect(d.diff([tab(T1, { muted: true })])).toEqual({ changed: [], closed: [] })
  })

  it('a tab gone from the list is reported closed once', () => {
    d.diff([tab(T1)])
    expect(d.diff([]).closed).toEqual([T1])
    expect(d.diff([]).closed).toEqual([])
  })

  it('a repeated id is one tab: the last entry of it is announced and kept', () => {
    const first = tab(T1, { cwd: 'D:\\first' })
    const last = tab(T1, { cwd: 'D:\\last' })
    const { changed, closed } = d.diff([first, last])
    expect(changed).toEqual([last])
    expect(closed).toEqual([])
    expect(d.all()).toEqual([last])
    expect(d.diff([last])).toEqual({ changed: [], closed: [] })
  })

  it('all() returns the tabs of the last diff', () => {
    d.diff([tab(T1)])
    expect(d.all()).toEqual([tab(T1)])
    d.diff([])
    expect(d.all()).toEqual([])
  })
})

describe('tab attention', () => {
  let a: TabAttention

  beforeEach(() => {
    a = new TabAttention()
  })

  it('each attention that starts raises the number; clear forgets the reason and says whether there was one', () => {
    a.start(T1, 'permission')
    a.start(T1, 'done')
    expect(a.get(T1)).toEqual({ reason: 'done', seq: 2 })
    expect(a.clear(T1)).toBe(true)
    expect(a.clear(T1)).toBe(false)
    expect(a.get(T1)).toEqual({ reason: null, seq: 2 })
  })

  it('a tab nothing happened to has no reason and number 0; drop starts it over', () => {
    expect(a.get(T1)).toEqual({ reason: null, seq: 0 })
    a.start(T1, 'bell')
    a.drop(T1)
    expect(a.get(T1)).toEqual({ reason: null, seq: 0 })
  })
})

describe('tab inputs', () => {
  let i: TabInputs

  beforeEach(() => {
    i = new TabInputs()
  })

  it('every bump raises the count of its tab only; a tab nothing happened to is at 0', () => {
    expect(i.of(T1)).toBe(0)
    i.bump(T1)
    i.bump(T1)
    i.bump(T2)
    expect(i.of(T1)).toBe(2)
    expect(i.of(T2)).toBe(1)
  })

  it('drop starts the tab over at 0', () => {
    i.bump(T1)
    i.drop(T1)
    expect(i.of(T1)).toBe(0)
  })
})

describe('statusSummary', () => {
  it('statusSummary', () => {
    expect(statusSummary(main('Opus 4.1', 41.6))).toBe('Opus 4.1 · 42% context')
    expect(statusSummary(main('Opus 4.1', null))).toBe('Opus 4.1')
    expect(statusSummary(null)).toBeNull()
  })

  it('a long model name is cut so the summary is at most 200 characters and keeps the context', () => {
    const summary = statusSummary(main('M'.repeat(500), 41.6))
    expect(summary).not.toBeNull()
    expect(summary!.length).toBeLessThanOrEqual(200)
    expect(summary!.endsWith(' · 42% context')).toBe(true)
  })

  it('a long model name without a context is cut to 200 characters', () => {
    const summary = statusSummary(main('M'.repeat(500), null))
    expect(summary).toBe('M'.repeat(200))
  })

  it('C0 control characters are stripped from the model name', () => {
    expect(statusSummary(main('Opus\u0000 4.\u001b1\u0007', 10))).toBe('Opus 4.1 · 10% context')
  })

  it('a context percentage that is not a finite number counts as no context', () => {
    expect(statusSummary(main('Opus 4.1', Number.NaN))).toBe('Opus 4.1')
    expect(statusSummary(main('Opus 4.1', Number.POSITIVE_INFINITY))).toBe('Opus 4.1')
  })

  it('a name that is empty after its controls are stripped falls back to the model id, then to the context alone', () => {
    const withId = (displayName: string, usedPct: number | null, id = 'claude-opus-4-1'): MainStatus => ({
      ...main(displayName, usedPct),
      model: { id, displayName }
    })
    expect(statusSummary(withId('\u0001\u0002', 42))).toBe('claude-opus-4-1 · 42% context')
    expect(statusSummary(withId('\u0001', null))).toBe('claude-opus-4-1')
    expect(statusSummary(withId('', 42, ''))).toBe('42% context')
    expect(statusSummary(withId('', null, ''))).toBeNull()
  })

  it('C1 controls and the line and paragraph separators are stripped from the name', () => {
    expect(statusSummary(main('Op\u0085us\u2028 4\u009f.1\u2029', 10))).toBe('Opus 4.1 · 10% context')
  })

  it('a cut never leaves half of a surrogate pair', () => {
    // one plain character first, so the 186-unit cut lands between the two halves of a pair
    const summary = statusSummary(main('A' + '😀'.repeat(200), 10))!
    expect(summary.length).toBeLessThanOrEqual(200)
    expect(summary.endsWith(' · 10% context')).toBe(true)
    expect(summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
