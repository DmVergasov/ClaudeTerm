import { screen, type BrowserWindow, type Rectangle } from 'electron'

/** far off every display */
const OFF_SCREEN = -30_000
/** how many times macOS may bring a test window back onto a screen before it is left there */
const MAX_MOVES_OFF = 20

const onADisplay = (b: Rectangle): boolean =>
  screen.getAllDisplays().some(({ bounds: d }) => b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y)

/**
 * Shows a window. A test run shows it off the screen, inactive and out of the taskbar, so that nothing pops up in front of
 * the person running the tests; shown, it still draws every frame (a window that is never shown draws about once a second).
 */
export function showWindow(win: BrowserWindow, offScreen: boolean, platform: NodeJS.Platform = process.platform, onDisplay = onADisplay): void {
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
  // macOS brings a window off every screen onto one as it is shown, and may again later on its own; moved off after
  // that, it stays where it is put. Unseen until it is off the screen
  let moves = 0
  const offAgain = (): void => {
    if (moves >= MAX_MOVES_OFF || win.isDestroyed() || !onDisplay(win.getBounds())) return
    moves++
    win.setPosition(OFF_SCREEN, OFF_SCREEN)
  }
  win.setOpacity(0)
  win.showInactive()
  offAgain()
  win.setOpacity(1)
  win.on('move', offAgain)
  win.on('resize', offAgain)
}
