export interface WindowRect { x: number; y: number; width: number; height: number }

/** the part of a BrowserWindow `resizeWindow` uses */
export interface ResizableWindow {
  getBounds(): WindowRect
  setBounds(r: WindowRect): void
  on(event: 'resize', listener: () => void): unknown
  off(event: 'resize', listener: () => void): unknown
}

/** how long a window that did change is waited for to say so: its resize event may come after the call, or never */
const RESIZE_WAIT_MS = 120

/**
 * Sets the window's bounds. Resolves true once the window has changed (its resize event came, or RESIZE_WAIT_MS passed),
 * and false at once when the bounds are as they were: a window that could not grow or that the OS refused sends no resize
 * event, and nobody should wait for one.
 */
export function resizeWindow(win: ResizableWindow, r: WindowRect): Promise<boolean> {
  return new Promise((resolve) => {
    const old = win.getBounds()
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (grew: boolean): void => {
      clearTimeout(timer)
      win.off('resize', onResize)
      resolve(grew)
    }
    const onResize = (): void => done(true)
    win.on('resize', onResize)
    win.setBounds(r)
    const now = win.getBounds()
    if (now.x === old.x && now.y === old.y && now.width === old.width && now.height === old.height) {
      done(false)
      return
    }
    timer = setTimeout(() => done(true), RESIZE_WAIT_MS)
  })
}
