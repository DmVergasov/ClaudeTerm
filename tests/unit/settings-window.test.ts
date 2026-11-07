import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import { SettingsWindow, settingsWindowBounds, type SettingsWindowDeps } from '../../src/main/settings-window'

// the fake Electron: every window the settings window makes is kept in `made`, with what was sent to it
const electron = vi.hoisted(() => {
  const made: FakeWindow[] = []
  class FakeWindow {
    focused = false
    destroyed = false
    /** whether the page is still loading: a test sets it, and finishLoad() ends it */
    loading = false
    sent: unknown[][] = []
    private listeners = new Map<string, () => void>()
    private loadListeners = new Map<string, () => void>()
    webContents = {
      send: (...args: unknown[]): void => {
        this.sent.push(args)
      },
      setWindowOpenHandler: (): void => {},
      on: (): void => {},
      once: (event: string, fn: () => void): void => {
        this.loadListeners.set(event, fn)
      },
      isLoading: (): boolean => this.loading
    }
    /** the page has loaded: its did-finish-load listener runs */
    finishLoad(): void {
      this.loading = false
      this.loadListeners.get('did-finish-load')?.()
    }
    constructor(readonly options: object) {
      made.push(this)
    }
    setMenu(): void {}
    once(event: string, fn: () => void): void {
      this.listeners.set(event, fn)
    }
    on(event: string, fn: () => void): void {
      this.listeners.set(event, fn)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    focus(): void {
      this.focused = true
    }
    /** the window is closed by the person: its 'closed' listener runs */
    close(): void {
      this.destroyed = true
      this.listeners.get('closed')?.()
    }
  }
  const work = { x: 0, y: 0, width: 1920, height: 1040 }
  return {
    made,
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: work }), getDisplayMatching: () => ({ workArea: work }) },
    shell: { openExternal: (): void => {} }
  }
})
vi.mock('electron', () => electron)

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

describe('SettingsWindow', () => {
  type Win = (typeof electron.made)[number]
  let loads: [Win, string | undefined][]
  let sw: SettingsWindow

  beforeEach(() => {
    electron.made.length = 0
    loads = []
    const deps: SettingsWindowDeps = {
      parent: () => null,
      preload: 'preload.js',
      load: (win, section) => loads.push([win as unknown as Win, section])
    }
    sw = new SettingsWindow(deps)
  })

  it('open with a section loads a new window at it, and tells an open one', () => {
    sw.open('devices')
    const [win] = electron.made
    expect(loads.at(-1)).toEqual([win, 'devices'])
    sw.open('devices')
    expect(electron.made).toHaveLength(1)
    expect(win.focused).toBe(true)
    expect(win.sent).toContainEqual([IPC.evSettingsSection, 'devices'])
  })

  it('a section sent to a window that is still loading is sent once its page has loaded', () => {
    sw.open()
    const [win] = electron.made
    win.loading = true
    sw.open('devices')
    // the page's section listener is not there yet: nothing is sent while it loads
    expect(win.sent).toEqual([])
    win.finishLoad()
    expect(win.sent).toContainEqual([IPC.evSettingsSection, 'devices'])
  })

  it('open without a section loads a new window without one, and an open window is only brought forward', () => {
    sw.open()
    const [win] = electron.made
    expect(loads.at(-1)).toEqual([win, undefined])
    sw.open()
    expect(win.focused).toBe(true)
    expect(win.sent).toEqual([])
  })

  it('reports whether a window is open, and is not open once it closes', () => {
    expect(sw.isOpen()).toBe(false)
    sw.open('devices')
    expect(sw.isOpen()).toBe(true)
    electron.made[0].close()
    expect(sw.isOpen()).toBe(false)
    sw.open('devices')
    expect(electron.made).toHaveLength(2)
  })
})
