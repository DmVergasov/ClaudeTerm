import { describe, expect, it } from 'vitest'
import { applyWindowChrome, chromeOptions, SETTINGS_TITLE_BAR_HEIGHT, TITLE_BAR_HEIGHT, windowChrome } from '../../src/main/window-chrome'

describe('chromeOptions', () => {
  it('Windows and Linux hide the title bar and keep the system buttons, drawn in the window colors', () => {
    for (const p of ['win32', 'linux'] as const) expect(chromeOptions(p)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#0A0A0C', symbolColor: '#B5B5BE', height: 44 } })
  })

  it('macOS insets the traffic lights in the bar', () => {
    expect(chromeOptions('darwin')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } })
  })

  it('the settings window gets a lower bar', () => {
    expect(chromeOptions('win32', 36).titleBarOverlay).toEqual({ color: '#0A0A0C', symbolColor: '#B5B5BE', height: 36 })
  })

  it('macOS centers the traffic lights in a bar of any height', () => {
    expect(chromeOptions('darwin', SETTINGS_TITLE_BAR_HEIGHT).trafficLightPosition).toEqual({ x: 16, y: 10 })
  })

  it('the main bar is 44 px and the settings bar 36 px', () => {
    expect(TITLE_BAR_HEIGHT).toBe(44)
    expect(SETTINGS_TITLE_BAR_HEIGHT).toBe(36)
  })

  it("chromeOptions draws the buttons in the theme's colours", () => {
    expect(chromeOptions('win32', TITLE_BAR_HEIGHT, windowChrome('One Half Light')).titleBarOverlay).toEqual({ color: '#FAFAFA', symbolColor: '#55575E', height: 44 })
  })
})

describe('windowChrome', () => {
  it("Graphite: the window's ground, and the buttons in the second text colour, as always", () => {
    expect(windowChrome('Graphite')).toEqual({ backgroundColor: '#0A0A0C', overlay: { color: '#0A0A0C', symbolColor: '#B5B5BE' } })
  })

  it('a light theme: a light window with dark buttons', () => {
    expect(windowChrome('One Half Light')).toEqual({ backgroundColor: '#FAFAFA', overlay: { color: '#FAFAFA', symbolColor: '#55575E' } })
  })

  it('a theme object from settings.json: its own background', () => {
    expect(windowChrome({ background: '#101820', foreground: '#E0E0E0' }).backgroundColor).toBe('#101820')
  })

  it('a name that is not built in, or colours it cannot read: Graphite', () => {
    expect(windowChrome('Solarized')).toEqual(windowChrome('Graphite'))
    expect(windowChrome({ background: 'rgb(1,2,3)', foreground: 'red' })).toEqual(windowChrome('Graphite'))
  })
})

describe('applyWindowChrome', () => {
  const fake = (): { calls: unknown[][]; win: { setBackgroundColor(c: string): void; setTitleBarOverlay(o: object): void } } => {
    const calls: unknown[][] = []
    return { calls, win: { setBackgroundColor: (c) => { calls.push(['background', c]) }, setTitleBarOverlay: (o) => { calls.push(['overlay', o]) } } }
  }

  it('Windows and Linux: the background and the title bar buttons', () => {
    for (const p of ['win32', 'linux'] as const) {
      const f = fake()
      applyWindowChrome(f.win, windowChrome('One Half Light'), p)
      expect(f.calls).toEqual([['background', '#FAFAFA'], ['overlay', { color: '#FAFAFA', symbolColor: '#55575E' }]])
    }
  })

  it('macOS: the background only', () => {
    const f = fake()
    applyWindowChrome(f.win, windowChrome('One Half Light'), 'darwin')
    expect(f.calls).toEqual([['background', '#FAFAFA']])
  })
})
