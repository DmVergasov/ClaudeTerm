import { describe, expect, it } from 'vitest'
import { FrontFallback } from '../../src/renderer/front-fallback'

describe('FrontFallback', () => {
  it('asks for the first tab left when the tab in front closes, and asks again when the asked tab closes before it comes to the front', () => {
    const f = new FrontFallback()
    expect(f.closed('T1', ['T2', 'T3'], 'T1')).toBe('T2')
    expect(f.closed('T2', ['T3'], null)).toBe('T3')
  })

  it('stops asking once a tab comes to the front, so a later close of another tab asks for nothing', () => {
    const f = new FrontFallback()
    f.closed('T1', ['T2', 'T3'], 'T1')
    f.activated('T3')
    expect(f.closed('T4', ['T3'], 'T3')).toBeNull()
  })

  it('asks for nothing when a tab that is not in front and was not asked for closes', () => {
    const f = new FrontFallback()
    expect(f.closed('T5', ['T6'], 'T6')).toBeNull()
  })

  it('asks for nothing when the last tab closes', () => {
    const f = new FrontFallback()
    expect(f.closed('T1', [], 'T1')).toBeNull()
  })
})
