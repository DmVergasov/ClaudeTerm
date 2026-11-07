import { beforeEach, describe, expect, it } from 'vitest'
import { TabSizes } from '../../src/main/sync/tab-sizes'

const T1 = 'a0000000-0000-4000-8000-000000000001'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('tab sizes', () => {
  let s: TabSizes

  beforeEach(() => {
    s = new TabSizes()
  })

  it('with no other device the window\'s sizes apply, as today', () => {
    expect(s.fit(T1, 120, 30)).toEqual({ cols: 120, rows: 30, by: null })
    expect(s.fit(T1, 120, 30)).toBeNull()
    expect(s.fit(T1, 100, 30)).toEqual({ cols: 100, rows: 30, by: null })
  })

  it('a device that claims the tab sizes it; the window\'s fits wait', () => {
    s.fit(T1, 120, 30)
    expect(s.claim(T1, B, 80, 24)).toEqual({ cols: 80, rows: 24, by: B })
    expect(s.fit(T1, 130, 40)).toBeNull()
    expect(s.get(T1)).toEqual({ cols: 80, rows: 24, by: B })
  })

  it('the window takes the tab back at its latest fit', () => {
    s.fit(T1, 120, 30)
    s.claim(T1, B, 80, 24)
    s.fit(T1, 130, 40)
    expect(s.claim(T1, null)).toEqual({ cols: 130, rows: 40, by: null })
  })

  it('two devices typing in turn resize once per change of hands, never per keystroke', () => {
    // no fit of the window in this test: its claim keeps the applied size and changes only the owner
    expect(s.claim(T1, B, 80, 24)).not.toBeNull()
    expect(s.claim(T1, B, 80, 24)).toBeNull()
    expect(s.claim(T1, null)).toEqual({ cols: 80, rows: 24, by: null })
    expect(s.claim(T1, null)).toBeNull()
    expect(s.claim(T1, B, 80, 24)).not.toBeNull()
  })

  it('the same size from another device changes only the owner', () => {
    s.claim(T1, B, 80, 24)
    expect(s.claim(T1, C, 80, 24)).toEqual({ cols: 80, rows: 24, by: C })
  })

  it('a device that goes gives its tabs back to the window', () => {
    s.fit(T1, 130, 40)
    s.claim(T1, B, 80, 24)
    expect(s.dropViewer(B)).toEqual([[T1, { cols: 130, rows: 40, by: null }]])
  })

  it('claiming a tab nothing is known about with no window: null', () => {
    expect(s.claim(T1, null)).toBeNull()
    expect(s.get(T1)).toBeNull()
  })

  it('drop forgets the tab', () => {
    s.fit(T1, 120, 30)
    s.drop(T1)
    expect(s.get(T1)).toBeNull()
    expect(s.fit(T1, 100, 30)).toEqual({ cols: 100, rows: 30, by: null })
  })
})
