import type { BrowserWindow } from 'electron'

/** far off every display */
const OFF_SCREEN = -30_000

/**
 * Shows a window. A test run shows it off the screen, inactive and out of the taskbar, so that nothing pops up in front of
 * the person running the tests, and deaf to the mouse, so that a test that maximizes it, full-screens it or moves it onto a
 * display takes no click (Playwright drives the page through CDP, not the mouse of the OS). On Windows and macOS it is also
 * fully transparent, so that it shows nothing there either. Not on Linux: Electron makes the window's layer transparent there,
 * and Chromium stops drawing a page that cannot be seen (no frames, no animations); the tests run under a virtual display
 * there. Shown, it still draws every frame (a window that is never shown draws about once a second).
 * macOS keeps a part of every window on a screen and moves it back there whenever it changes, so there a test window
 * opens where macOS puts it, only inactive.
 */
export function showWindow(win: BrowserWindow, offScreen: boolean, platform: NodeJS.Platform = process.platform): void {
  if (!offScreen) {
    win.show()
    return
  }
  win.setSkipTaskbar(true)
  if (platform !== 'linux') win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
  // Windows activates a window a test maximizes or full-screens even when it was shown inactive: it cannot take the focus
  if (platform === 'win32') win.setFocusable(false)
  if (platform !== 'darwin') win.setPosition(OFF_SCREEN, OFF_SCREEN)
  win.showInactive()
}
