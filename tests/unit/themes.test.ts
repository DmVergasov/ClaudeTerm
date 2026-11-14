import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appPalette, resolveTheme, THEMES } from '../../src/shared/themes'

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

/** Graphite: the colours the app has always had, the chat's steps, and the new tokens at the values the stylesheets wrote out */
const GRAPHITE: Record<string, string> = {
  '--ground': '#0A0A0C', '--sheet': '#111114', '--term': '#0E0E10', '--raised': '#16161A', '--raised-2': '#1E1E23',
  '--line': '#1C1C21', '--line-2': '#2A2A31', '--text': '#EDEDF0', '--text-2': '#B5B5BE', '--text-3': '#8C8C96',
  '--accent': '#D97757', '--green': '#63C08F', '--amber': '#E5B567', '--red': '#F2867E', '--blue': '#7FA7F5', '--purple': '#A78BFA',
  '--bg': '#0E0E10', '--chrome': '#111114', '--chrome-2': '#16161A', '--fg': '#EDEDF0', '--muted': '#8C8C96', '--border': '#2A2A31',
  '--tab-edge': '#27272E', '--item-hover': '#22222A', '--panel': '#0F0F12', '--card': '#141418', '--well': '#0C0C0F',
  '--field': '#0E0E11', '--line-3': '#3A3A43', '--card-hover': '#1A1A1F', '--art-panel': '#2E2E36', '--chip-line': '#26262D',
  '--text-soft': '#9D9DA7', '--text-4': '#55555E', '--knob': '#9A9AA3', '--match': '#E5C07B',
  '--tint-1': '#FFFFFF08', '--tint-2': '#FFFFFF0A', '--tint-3': '#FFFFFF0D', '--tint-4': '#FFFFFF10', '--tint-5': '#FFFFFF12',
  '--tint-6': '#FFFFFF18', '--tint-7': '#FFFFFF1A', '--scrim': '#00000077', '--scrim-2': '#05050690',
  '--chat-tone-0': '#0C0C0E', '--chat-tone-1': '#0F0F12', '--chat-tone-2': '#131317', '--chat-tone-3': '#17171B', '--chat-tone-4': '#1A1A1F',
  '--chat-tone-5': '#1C1C22', '--chat-tone-6': '#1E1E24', '--chat-tone-7': '#22222A', '--chat-tone-8': '#24242B', '--chat-tone-9': '#26262D',
  '--chat-edge-2': '#202026', '--chat-edge-3': '#222228', '--chat-edge-6': '#2E2E36', '--chat-edge-7': '#4A4A54',
  '--chat-ink-1': '#9D9DA7', '--chat-ink-2': '#A3A3AC', '--chat-ink-3': '#DADADF', '--chat-ink-4': '#6E6E78', '--chat-on-accent': '#141414',
  'color-scheme': 'dark'
}

/** colors.css's declarations, an alias (var(--x)) read as the colour it names */
function colorsCss(): Record<string, string> {
  const css = readFileSync(new URL('../../src/renderer/colors.css', import.meta.url), 'utf8')
  const raw = new Map([...css.matchAll(/^\s*(--[\w-]+|color-scheme):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()] as const))
  return Object.fromEntries([...raw].map(([name, value]) => {
    const alias = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
    return [name, alias === undefined ? value : raw.get(alias) ?? value]
  }))
}

describe('appPalette', () => {
  const noNaN = (palette: Record<string, string>): void => {
    for (const value of Object.values(palette)) expect(value).not.toContain('NaN')
  }

  it("Graphite keeps today's colours, token for token", () => {
    expect(appPalette(THEMES.Graphite)).toEqual(GRAPHITE)
  })

  it('colors.css is the Graphite palette: the window is Graphite until a palette is set', () => {
    expect(colorsCss()).toEqual(GRAPHITE)
  })

  it('a light theme gives a light scheme, light surfaces, dark text and its own status colours', () => {
    const palette = appPalette(THEMES['One Half Light'])
    expect(Object.keys(palette).sort()).toEqual(Object.keys(GRAPHITE).sort())
    expect(palette).toMatchObject({
      '--ground': '#FAFAFA', '--term': '#FAFAFA', '--bg': '#FAFAFA', '--sheet': '#F7F7F7', '--raised': '#F2F2F2', '--raised-2': '#E9EAEA',
      '--line': '#EBECEC', '--line-2': '#DDDDDF', '--text': '#383A42', '--fg': '#383A42', '--text-2': '#55575E', '--text-3': '#7D7E83',
      '--panel': '#F9F9F9', '--item-hover': '#E5E5E6', '--tab-edge': '#E0E0E1', '--field': '#FAFAFA', '--text-soft': '#6C6E74', '--knob': '#6F7177',
      '--accent': '#D97757', '--red': '#E45649', '--green': '#50A14F', '--amber': '#C18301', '--blue': '#0184BC', '--purple': '#A626A4', '--match': '#C18301',
      '--tint-1': '#383A4208', '--tint-7': '#383A421A', '--scrim': '#FAFAFA77', '--scrim-2': '#FAFAFA90', 'color-scheme': 'light'
    })
    noNaN(palette)
  })

  it("a dark theme other than Graphite mixes its own greys and keeps Graphite's status colours", () => {
    expect(appPalette(THEMES.Campbell)).toMatchObject({
      '--ground': '#0C0C0C', '--sheet': '#0F0F0F', '--panel': '#0D0D0D', '--text': '#CCCCCC', '--text-2': '#AFAFAF', '--accent': '#D97757',
      '--red': '#F2867E', '--amber': '#E5B567', '--match': '#E5C07B', '--tint-1': '#CCCCCC08', '--scrim': '#0C0C0C77', 'color-scheme': 'dark'
    })
  })

  it('a theme object from settings.json gives a full palette in its own colours', () => {
    const palette = appPalette(resolveTheme({ background: '#101820', foreground: '#E0E0E0' }))
    expect(Object.keys(palette).sort()).toEqual(Object.keys(GRAPHITE).sort())
    expect(palette).toMatchObject({ '--ground': '#101820', '--bg': '#101820', '--text': '#E0E0E0', 'color-scheme': 'dark' })
    noNaN(palette)
  })

  it('reads a three-digit #rgb background: #fff gives a light palette', () => {
    const palette = appPalette({ background: '#fff', foreground: '#000' })
    expect(palette).toMatchObject({ '--bg': '#FFFFFF', '--text': '#000000', 'color-scheme': 'light' })
    noNaN(palette)
  })

  it('reads #rgba and #rrggbbaa by their colour, the alpha left out', () => {
    expect(appPalette({ background: '#ffff', foreground: '#000f' })['--bg']).toBe('#FFFFFF')
    expect(appPalette({ background: '#ffffff80', foreground: '#000000ff' })['--bg']).toBe('#FFFFFF')
  })

  it('gives the Graphite palette for colours it cannot read, as rgb() or a name', () => {
    expect(appPalette({ background: 'rgb(1,2,3)', foreground: 'rgb(4,5,6)' })).toEqual(GRAPHITE)
    expect(appPalette({ background: 'red', foreground: 'blue' })).toEqual(GRAPHITE)
  })

  it('a theme with one colour it cannot read is Graphite, whole', () => {
    expect(appPalette({ background: 'white', foreground: '#000000' })).toEqual(appPalette(THEMES.Graphite))
    expect(appPalette({ background: '#FFFFFF', foreground: 'black' })).toEqual(appPalette(THEMES.Graphite))
  })

  it('falls back to the Graphite status colour when a light theme gives one it cannot read', () => {
    const palette = appPalette({ background: '#FFFFFF', foreground: '#000000', red: 'red', green: 'rgb(1,2,3)', yellow: 'gold' })
    expect(palette).toMatchObject({ '--red': '#F2867E', '--green': '#63C08F', '--amber': '#E5B567', '--match': '#E5C07B' })
    noNaN(palette)
  })
})
