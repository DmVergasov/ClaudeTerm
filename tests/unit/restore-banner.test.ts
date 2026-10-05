import { describe, expect, it } from 'vitest'
import { plural } from '../../src/renderer/restore-banner'

describe('plural', () => {
  it('one tab, otherwise tabs', () => {
    expect([0, 1, 2, 11, 21].map(plural)).toEqual(['tabs', 'tab', 'tabs', 'tabs', 'tabs'])
  })
})
