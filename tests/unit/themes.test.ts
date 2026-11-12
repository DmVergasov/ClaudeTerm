import { describe, expect, it } from 'vitest'
import { chatPalette, resolveTheme, THEMES } from '../../src/renderer/themes'

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

describe('chatPalette', () => {
  const noNaN = (palette: Record<string, string>): void => {
    for (const value of Object.values(palette)) expect(value).not.toContain('NaN')
  }

  it('reads a three-digit #rgb background: #fff gives a light palette', () => {
    const palette = chatPalette({ background: '#fff', foreground: '#000' })
    expect(palette['--bg']).toBe('#FFFFFF')
    expect(palette['--text']).toBe('#000000')
    expect(palette['color-scheme']).toBe('light')
    noNaN(palette)
  })

  it('reads #rgba and #rrggbbaa by their colour, the alpha left out', () => {
    expect(chatPalette({ background: '#ffff', foreground: '#000f' })['--bg']).toBe('#FFFFFF')
    expect(chatPalette({ background: '#ffffff80', foreground: '#000000ff' })['--bg']).toBe('#FFFFFF')
  })

  it('gives the Graphite tokens for a colour it cannot read, as rgb() or a name', () => {
    const graphite = chatPalette({ background: '#0E0E10', foreground: '#D4D4DA' })
    expect(chatPalette({ background: 'rgb(1,2,3)', foreground: 'rgb(4,5,6)' })).toEqual(graphite)
    expect(chatPalette({ background: 'red', foreground: 'blue' })).toEqual(graphite)
    noNaN(chatPalette({ background: 'rgb(1,2,3)', foreground: 'rgb(4,5,6)' }))
  })

  it('falls back to the Graphite status colour when a light theme gives one it cannot read', () => {
    const palette = chatPalette({ background: '#FFFFFF', foreground: '#000000', red: 'red', green: 'rgb(1,2,3)' })
    expect(palette['--red']).toBe('#F2867E')
    expect(palette['--green']).toBe('#63C08F')
    noNaN(palette)
  })
})
