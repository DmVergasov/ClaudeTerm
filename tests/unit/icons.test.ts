import { describe, expect, it } from 'vitest'
import { ICON_NAMES, icon } from '../../src/renderer/icons'

describe('icon', () => {
  it('draws every icon as a thin stroke SVG of the size asked, hidden from screen readers', () => {
    for (const name of ICON_NAMES) {
      const svg = icon(name, 14)
      expect(svg).toMatch(/^<svg [^>]*width="14" height="14" viewBox="0 0 24 24"/)
      expect(svg).toContain('stroke-width="1.75"')
      expect(svg).toContain('aria-hidden="true"')
      expect(svg).not.toContain('<script')
    }
  })

  it('defaults to 16 px', () => {
    expect(icon('plus')).toContain('width="16"')
  })
})
