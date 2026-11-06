import { describe, expect, it } from 'vitest'
import { badgeDescription, dotBitmap } from '../../src/main/app-badge'

describe('the badge of the tabs that need you', () => {
  it('the taskbar overlay is a round dot in the color, as BGRA pixels, see-through around it', () => {
    const px = dotBitmap(16, [217, 119, 87])
    expect(px).toHaveLength(16 * 16 * 4)
    const at = (x: number, y: number): number[] => [...px.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]
    expect(at(8, 8)).toEqual([87, 119, 217, 255])
    expect(at(0, 0)[3]).toBe(0)
    expect(at(15, 15)[3]).toBe(0)
  })

  it('its description says how many tabs need you', () => {
    expect(badgeDescription(1)).toBe('1 tab needs you')
    expect(badgeDescription(3)).toBe('3 tabs need you')
  })
})
