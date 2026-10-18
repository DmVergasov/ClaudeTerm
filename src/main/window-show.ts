import type { BrowserWindow } from 'electron'

/** far off every display */
const OFF_SCREEN = -30_000

/**
 * Shows a window. A test run shows it off the screen, inactive and out of the taskbar, so that nothing pops up in front of
 * the person running the tests; shown, it still draws every frame (a window that is never shown draws about once a second).
 */
export function showWindow(win: BrowserWindow, offScreen: boolean, platform: NodeJS.Platform = process.platform): void {
  if (!offScreen) {
    win.show()
    return
  }
  win.setSkipTaskbar(true)
  win.setPosition(OFF_SCREEN, OFF_SCREEN)
  if (platform !== 'darwin') {
    win.showInactive()
    return
  }
  // macOS brings a window off every screen onto one as it is shown, but leaves one moved off afterwards where it is:
  // shown unseen, then moved
  win.setOpacity(0)
  win.showInactive()
  win.setPosition(OFF_SCREEN, OFF_SCREEN)
  win.setOpacity(1)
}
