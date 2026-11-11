import type { BrowserWindowConstructorOptions } from 'electron'

/** the height of the main window's own title bar: the app draws it in the window's top */
export const TITLE_BAR_HEIGHT = 44
/** the settings window's bar is lower; it keeps its system frame until its own bar is drawn */
export const SETTINGS_TITLE_BAR_HEIGHT = 36

/**
 * The window options for a window that draws its own title bar. Windows and Linux hide the system bar but keep the
 * window buttons, drawn in the window's colors; macOS keeps its traffic lights, inset into the bar.
 */
export function chromeOptions(platform: NodeJS.Platform, height = TITLE_BAR_HEIGHT): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: Math.round((height - 16) / 2) } }
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0A0A0C', symbolColor: '#B5B5BE', height } }
}
