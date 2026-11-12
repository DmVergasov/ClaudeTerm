import { describe, expect, it } from 'vitest'
import { acceptPatches } from '../../src/shared/chat'

describe('acceptPatches', () => {
  it('a batch the viewer already has is ignored', () => {
    expect(acceptPatches(5, 3, 5, 2)).toEqual({ kind: 'ignore' })
    expect(acceptPatches(9, 3, 5, 2)).toEqual({ kind: 'ignore' })
  })

  it('a batch that starts at the viewer\'s revision is applied whole', () => {
    expect(acceptPatches(3, 3, 5, 2)).toEqual({ kind: 'apply', skip: 0 })
  })

  it('a batch that straddles the viewer\'s revision skips the patches the viewer has', () => {
    expect(acceptPatches(5, 3, 8, 5)).toEqual({ kind: 'apply', skip: 2 })
  })

  it('a batch from a later revision is a gap', () => {
    expect(acceptPatches(3, 5, 7, 2)).toEqual({ kind: 'gap' })
  })

  it('a count that does not match its revisions is a gap', () => {
    expect(acceptPatches(5, 5, 7, 3)).toEqual({ kind: 'gap' })
    expect(acceptPatches(5, 3, 8, 4)).toEqual({ kind: 'gap' })
  })
})
