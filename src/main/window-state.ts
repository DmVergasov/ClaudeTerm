import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'

export interface WindowState {
  bounds: { x?: number; y?: number; width: number; height: number }
  maximized: boolean
}

const DEFAULT_STATE: WindowState = { bounds: { width: 1200, height: 760 }, maximized: false }

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export function loadWindowState(file: string): WindowState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as WindowState
    const { x, y, width, height } = s.bounds ?? {}
    if (typeof width !== 'number' || typeof height !== 'number') return DEFAULT_STATE
    if (typeof x !== 'number' || typeof y !== 'number') return { bounds: { width, height }, maximized: Boolean(s.maximized) }
    const onScreen = screen.getAllDisplays().some((d) => intersects(d.workArea, { x, y, width, height }))
    return { bounds: onScreen ? { x, y, width, height } : { width, height }, maximized: Boolean(s.maximized) }
  } catch {
    return DEFAULT_STATE
  }
}

/** `added`: how much the window was widened for the side panel; the saved size leaves it out */
export function trackWindowState(win: BrowserWindow, file: string, added: () => number = () => 0): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    if (win.isDestroyed()) return
    const b = win.getNormalBounds()
    const state: WindowState = { bounds: { ...b, width: b.width - added() }, maximized: win.isMaximized() }
    try {
      writeFileSync(file, JSON.stringify(state))
    } catch {
      // ignore
    }
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save()
  })
}
