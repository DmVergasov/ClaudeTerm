import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { appPalette, resolveTheme } from '../shared/themes'
import type { Settings } from '../shared/types'

/** the height of the main window's own title bar: the app draws it in the window's top */
export const TITLE_BAR_HEIGHT = 44
/** the settings window's bar is lower; it keeps its system frame until its own bar is drawn */
export const SETTINGS_TITLE_BAR_HEIGHT = 36

/** the colours a window's own chrome takes from the theme: its background while it loads, and its title bar buttons */
export interface WindowChrome { backgroundColor: string; overlay: { color: string; symbolColor: string } }

/** the window's chrome in a theme: the window's ground, and the buttons in the second text colour */
export function windowChrome(theme: Settings['theme']): WindowChrome {
  const palette = appPalette(resolveTheme(theme))
  return { backgroundColor: palette['--ground']!, overlay: { color: palette['--ground']!, symbolColor: palette['--text-2']! } }
}

/**
 * The window options for a window that draws its own title bar. Windows and Linux hide the system bar but keep the
 * window buttons, drawn in the window's colors; macOS keeps its traffic lights, inset into the bar.
 */
export function chromeOptions(platform: NodeJS.Platform, height = TITLE_BAR_HEIGHT, chrome: WindowChrome = windowChrome('Graphite')): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: Math.round((height - 16) / 2) } }
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: chrome.overlay.color, symbolColor: chrome.overlay.symbolColor, height } }
}

/**
 * Puts the theme's colours on a window that is already open: its background, and its title bar buttons. macOS's traffic
 * lights have no colours to set; Linux gets the overlay because chromeOptions gives it one.
 */
export function applyWindowChrome(win: Pick<BrowserWindow, 'setBackgroundColor' | 'setTitleBarOverlay'>, chrome: WindowChrome, platform: NodeJS.Platform): void {
  win.setBackgroundColor(chrome.backgroundColor)
  if (platform !== 'darwin') win.setTitleBarOverlay(chrome.overlay)
}
