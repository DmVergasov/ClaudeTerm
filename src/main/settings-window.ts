import { BrowserWindow, screen, shell } from 'electron'
import { IPC, type SettingsSection } from '../shared/ipc'
import { showWindow } from './window-show'
import { chromeOptions, SETTINGS_TITLE_BAR_HEIGHT } from './window-chrome'

export interface Rect { x: number; y: number; width: number; height: number }

export const SETTINGS_SIZE = { width: 880, height: 760 }
export const SETTINGS_MIN = { width: 560, height: 480 }

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
  /** the window icon where the app's own .exe does not supply one (dev and test runs) */
  icon?: string
  /** shown off the screen, never brought forward (a test run) */
  offScreen?: boolean
  /** the section a new window opens at (its #hash) */
  load(win: BrowserWindow, section?: string): void
}

/** The one settings window: owned by the main window, brought forward when it is already open. */
export class SettingsWindow {
  private win: BrowserWindow | null = null

  constructor(private readonly d: SettingsWindowDeps) {}

  /** whether the window is open */
  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  /** section: the Settings section to show; an open window is brought forward and shown it */
  open(section?: SettingsSection): void {
    const open = this.win
    if (open && !open.isDestroyed()) {
      if (!this.d.offScreen) open.focus()
      if (section) this.sendSection(open, section)
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
      backgroundColor: '#0A0A0C',
      ...chromeOptions(process.platform, SETTINGS_TITLE_BAR_HEIGHT),
      ...(this.d.icon ? { icon: this.d.icon } : {}),
      webPreferences: { preload: this.d.preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    win.setMenu(null)
    win.once('ready-to-show', () => showWindow(win, this.d.offScreen ?? false))
    win.on('closed', () => {
      if (this.win !== win) return
      this.win = null
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    this.win = win
    this.d.load(win, section)
  }

  /** a section for an open window: a page still loading has not set its section listener yet, so the section goes once it has loaded */
  private sendSection(win: BrowserWindow, section: SettingsSection): void {
    const wc = win.webContents
    if (!wc.isLoading()) {
      wc.send(IPC.evSettingsSection, section)
      return
    }
    wc.once('did-finish-load', () => {
      if (!win.isDestroyed()) wc.send(IPC.evSettingsSection, section)
    })
  }
}
