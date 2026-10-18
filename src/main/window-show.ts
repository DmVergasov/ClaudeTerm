import type { BrowserWindow } from 'electron'

/** far off every display */
const OFF_SCREEN = -30_000

/**
 * Shows a window. A test run shows it off the screen, inactive and out of the taskbar, so that nothing pops up in front of
 * the person running the tests; shown, it still draws every frame (a window that is never shown draws about once a second).
 * macOS keeps a part of every window on a screen and moves it back there whenever it changes, so there a test window
 * opens where macOS puts it, only inactive.
 */
export function showWindow(win: BrowserWindow, offScreen: boolean, platform: NodeJS.Platform = process.platform): void {
  if (!offScreen) {
    win.show()
    return
  }
  win.setSkipTaskbar(true)
  if (platform !== 'darwin') win.setPosition(OFF_SCREEN, OFF_SCREEN)
  win.showInactive()
}
