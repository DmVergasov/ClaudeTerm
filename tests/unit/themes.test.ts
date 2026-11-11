import { describe, expect, it } from 'vitest'
import { resolveTheme, THEMES } from '../../src/renderer/themes'

describe('themes', () => {
  it('lists the built-in themes, Graphite first', () => {
    expect(Object.keys(THEMES)).toEqual(['Graphite', 'Campbell', 'One Half Dark', 'One Half Light'])
  })

  it('Graphite matches the window chrome', () => {
    const t = resolveTheme('Graphite')
    expect(t.background).toBe('#0E0E10')
    expect(t.foreground).toBe('#D4D4DA')
    expect(t.cursor).toBe('#D97757')
    expect(t.brightBlack).toBe('#85858F')
  })

  it('an unknown name falls back to Graphite, the default theme', () => {
    expect(resolveTheme('Nope').background).toBe('#0E0E10')
  })
})
