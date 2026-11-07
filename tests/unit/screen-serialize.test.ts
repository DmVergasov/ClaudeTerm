import { describe, expect, it } from 'vitest'
import { scrollbackLines } from '../../src/shared/screen-serialize'

describe('scrollbackLines', () => {
  it('counts the normal buffer\'s lines above the screen', () => {
    expect(scrollbackLines({ buffer: { normal: { length: 300 } }, rows: 10 })).toBe(290)
  })

  it('is 0 when the normal buffer holds no more lines than the screen', () => {
    expect(scrollbackLines({ buffer: { normal: { length: 10 } }, rows: 10 })).toBe(0)
    expect(scrollbackLines({ buffer: { normal: { length: 4 } }, rows: 10 })).toBe(0)
  })
})
