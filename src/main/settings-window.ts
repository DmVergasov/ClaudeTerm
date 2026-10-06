import { BrowserWindow, screen, shell } from 'electron'

export interface Rect { x: number; y: number; width: number; height: number }

export const SETTINGS_SIZE = { width: 640, height: 720 }
export const SETTINGS_MIN = { width: 520, height: 400 }

/** Centred on the main window, shrunk to and kept inside the work area of its display. */
export function settingsWindowBounds(parent: Rect, work: Rect): Rect {
  const width = Math.min(SETTINGS_SIZE.width, work.width)
  const height = Math.min(SETTINGS_SIZE.height, work.height)
  const x = Math.round(parent.x + (parent.width - width) / 2)
  const y = Math.round(parent.y + (parent.height - height) / 2)
  return {
    x: Math.min(Math.max(x, work.x), work.x + work.width - width),
    y: Math.min(Math.max(y, work.y), work.y + work.height - height),
    width,
    height
  }
}

export interface SettingsWindowDeps {
  parent(): BrowserWindow | null
  preload: string
  load(win: BrowserWindow): void
}

/** The one settings window: owned by the main window, brought forward when it is already open. */
export class SettingsWindow {
  private win: BrowserWindow | null = null

  constructor(private readonly d: SettingsWindowDeps) {}

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus()
      return
    }
    const parent = this.d.parent()
    const owner = parent && !parent.isDestroyed() ? parent : null
    const around = owner ? owner.getBounds() : screen.getPrimaryDisplay().workArea
    const work = screen.getDisplayMatching(around).workArea
    const win = new BrowserWindow({
      ...settingsWindowBounds(around, work),
      minWidth: SETTINGS_MIN.width,
      minHeight: SETTINGS_MIN.height,
      ...(owner ? { parent: owner } : {}),
      show: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'ClaudeTerm Settings',
      backgroundColor: '#1b1b1f',
      webPreferences: { preload: this.d.preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    win.setMenu(null)
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => { if (this.win === win) this.win = null })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    this.win = win
    this.d.load(win)
  }
}
