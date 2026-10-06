import { describe, expect, it } from 'vitest'
import { settingsWindowBounds } from '../../src/main/settings-window'

const WORK = { x: 0, y: 0, width: 1920, height: 1040 }

describe('settingsWindowBounds', () => {
  it('centres the 640×720 window on the main window', () => {
    expect(settingsWindowBounds({ x: 100, y: 50, width: 1200, height: 900 }, WORK)).toEqual({ x: 380, y: 140, width: 640, height: 720 })
  })

  it('keeps it inside the work area when the main window is near an edge', () => {
    expect(settingsWindowBounds({ x: 1700, y: 900, width: 600, height: 400 }, WORK)).toEqual({ x: 1280, y: 320, width: 640, height: 720 })
    expect(settingsWindowBounds({ x: -500, y: -300, width: 600, height: 400 }, WORK)).toEqual({ x: 0, y: 0, width: 640, height: 720 })
  })

  it('shrinks to a small work area, on a second monitor too', () => {
    expect(settingsWindowBounds({ x: 2000, y: 0, width: 800, height: 600 }, { x: 1920, y: 0, width: 1024, height: 600 })).toEqual({ x: 2080, y: 0, width: 640, height: 600 })
  })
})
