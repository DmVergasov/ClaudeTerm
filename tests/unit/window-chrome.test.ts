import { describe, expect, it } from 'vitest'
import { chromeOptions, SETTINGS_TITLE_BAR_HEIGHT, TITLE_BAR_HEIGHT } from '../../src/main/window-chrome'

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
})
